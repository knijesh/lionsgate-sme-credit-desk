# Lionsgate Bank · SME Credit Desk

**Live demo:** https://knijesh.github.io/lionsgate-sme-credit-desk/ · **[Guide: internals and demo script](GUIDE.md)**

An agentic SME loan-origination demo built around one idea: **agents gather evidence, a policy
engine decides, people approve within their authority, and everything is recorded.**

```
node server.js            # http://localhost:3100  (PORT to change)
node evals/run.js         # policy golden set; exits 1 on any failure (CI gate)
```

No npm install: plain Node 18+.

## What's in the console

| Screen | Shows |
|---|---|
| Overview | KPIs (straight-through rate, time to decision, SLA, override rate, exceptions, guardrails, cost), decisions per day, pipeline, time to decision by authority level, rules driving referrals, live agent feed |
| Applications | Live board: agent lanes (navy) and the human lane (gold); click a card for the evidence trail |
| Approvals | Queue filtered to what the signed-in user may sign, SLA bars, authority matrix; review drawer with engine decision, rule trace, figures, memo, agent trail, audit entries |
| Policy engine | Editable rules and authority matrix → simulate impact on the book and golden set → submit → Head of Credit Risk approves → new version goes live |
| Evaluations | Release gate per agent (ADK metrics), a blocked release candidate, custom LLM-as-judge criteria, policy golden set |
| Control tower | How a decision is made, agent inventory with health, hash-chained audit trail with verification |

Switch user in the header to play each role: Priya Nair (Credit Officer), Daniel Lim (Senior
Credit Manager), Margaret Ong (Credit Committee), Aisha Rahman (Head of Credit Risk Policy).

## Controls the server enforces

- **Authority matrix** (`policy/policy.json`): STP ≤ S$100k, grade ≤ 3, no exceptions → automated;
  L1 Credit Officer ≤ S$250k; L2 dual sign-off ≤ S$1M, ≤ 1 exception; L3 Credit Committee.
  Knockouts decline automatically; credit-rule declines need a human decline review.
- **Segregation of duties**: no one signs twice; L2 needs a Senior Credit Manager among the two;
  a policy author can't approve their own change.
- **Overrides** of the engine need a 25+ character justification and are counted on the dashboard.
- **Policy change gate**: a draft is replayed against the book and the golden set; if golden cases
  change outcome the approver must acknowledge them in the review note.
- **Guardrails**: prohibited attributes are stripped by the engine (CP-1.3); memo drafts that
  mention them are redacted.
- **Audit**: every submission, engine decision, approval, automation and policy change is appended
  to a SHA-256 hash chain (`Verify now` in Control tower).

## What is real and what is simulated

- **Real:** the policy engine (`policy/engine.js`), the golden set (`evals/golden.json`, 24 hand-checked
  cases), approvals, separation of duties, policy change control, audit chain, metrics.
- **Simulated:** the agents. `lib/desk.js` plays their steps with realistic timings and data
  (`lib/data.js`, seeded). 14 days of history are generated at start-up. State is in memory;
  restart to reset.
- **Sample:** agent evaluation scores in `evals/agent-results.json` are in the shape of ADK
  output, not from a real run. The Evaluations page says so.

## Public demo (GitHub Pages)

`node scripts/build-static.js` writes a server-free build to `docs/`: the same engine, desk and
routes are bundled into `desk.bundle.js` and run in the visitor's browser, so every visitor gets a
private desk and **Reset demo** starts a fresh shift. No keys or back-end URLs are in the build.
Set `CNAME=demo.example.com` when building to serve it from a custom domain.

## Tool back end for Orchestrate

Agents need a reachable HTTPS endpoint, which a static site can't provide, so the Node server
also runs as a container (`Dockerfile`, any host; we use IBM Cloud Code Engine). On a public host set:

- `TOOL_API_KEY`: Orchestrate sends it as `x-api-key`; it opens only the three tool routes.
- `DEMO_PASSWORD`: basic-auth password for the console and everything else.

Keep both in `.env` (git- and build-ignored) and in the host's secret store, never in the repo.

## Wiring the agents to watsonx Orchestrate (phase 2)

`orchestrate/` holds the ADK files for the two agents that only need the engine's API:

1. Deploy the server somewhere Orchestrate can reach (see above) and put its URL in
   `orchestrate/policy-engine-openapi.yaml` under `servers`.
2. `orchestrate tools import -k openapi -f orchestrate/policy-engine-openapi.yaml`
3. `orchestrate agents import -f orchestrate/agents/sme_credit_analyst.yaml`
4. `orchestrate agents import -f orchestrate/agents/sme_credit_supervisor.yaml`

The OpenAPI deliberately has no approve/decline operation, so no agent can decide. The intake,
KYB and comms agents need their own tools (document extraction, ACRA and sanctions lookups,
customer messaging) and are the next step, followed by ADK evaluation datasets
(`orchestrate evaluations evaluate`) whose summary replaces `evals/agent-results.json`.

## Five-minute demo

The full script with talking points is in [GUIDE.md § Demo flow](GUIDE.md#13-demo-flow).

1. **Overview**: over a third decided without a person; override rate and guardrails on one screen.
2. **Applications**: watch an application move through Intake → KYB → Analysis → Policy engine;
   one is auto-approved, one asks the customer for missing documents.
3. **Approvals** as Priya: open Tanjong Precision Engineering (S$650k, DSCR exception, L2).
   Approve with a mitigant → "first signature". Try again as Priya → blocked (segregation of duties).
   Switch to Daniel → second signature → offer issued.
4. Open an L3 item as Priya → no authority. A decline-review item → "Override and approve" needs
   a full justification.
5. **Policy engine** as Daniel: DSCR standard 1.25 → 1.20, Simulate → applications move from
   Refer to Approve, golden set 23/24. Submit. Switch to Aisha → approve without a note is refused;
   acknowledge G11 → v3.3 goes live and the header flips.
6. **Evaluations**: the Credit Analyst 3.1.0-rc1 is blocked — it skipped the policy engine on
   3 of 50 renewals.
7. **Control tower**: every agent with owner and health; Verify the audit chain.

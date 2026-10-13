# Lionsgate Bank SME Credit Desk — guide

How the demo works under the hood, the rules it enforces, and a click-by-click script for
presenting it. Lionsgate Bank is fictitious; every company, person and figure is generated.

- Public demo: https://knijesh.github.io/lionsgate-sme-credit-desk-site/ (runs in your browser)
- Local: `node server.js` → http://localhost:3100

**Contents:**

1. [The idea in one picture](#1-the-idea-in-one-picture)
2. [Code map](#2-code-map)
3. [An application's journey](#3-an-applications-journey)
4. [The policy engine](#4-the-policy-engine)
5. [Approvals and controls](#5-approvals-and-controls)
6. [Policy change control](#6-policy-change-control)
7. [Evaluations](#7-evaluations)
8. [Audit chain](#8-audit-chain)
9. [Simulation and seeded data](#9-simulation-and-seeded-data)
10. [Dashboard metrics: exact definitions](#10-dashboard-metrics-exact-definitions)
11. [Two ways to run it](#11-two-ways-to-run-it)
12. [watsonx Orchestrate integration](#12-watsonx-orchestrate-integration)
13. [Demo flow](#13-demo-flow)
14. [Troubleshooting and limits](#14-troubleshooting-and-limits)

---

## 1. The idea in one picture

```
 Agents gather evidence        Policy engine decides       Authority matrix routes      People approve           Everything recorded
 ──────────────────────        ─────────────────────       ───────────────────────      ──────────────           ───────────────────
 Document Intake  ─┐           deterministic rules         STP  ≤ S$100k → automation   Credit Officer           SHA-256 hash chain
 KYB & Screening  ─┼─ facts ─▶ versioned (v3.2)       ───▶ L1   ≤ S$250k → 1 officer  ─▶ Senior Credit Mgr   ──▶ of every step,
 Credit Analyst   ─┘           full rule trace             L2   ≤ S$1M   → 2 people     Credit Committee         verifiable on demand
                               same input → same answer    L3   above    → committee    (segregation of duties)
```

**Agents never decide.** They extract, screen, spread and write. The decision, grade, price and
approval level always come from the policy engine, and only people (or automation within delegated
authority) close an application. That separation is the point of the demo.

## 2. Code map

| Path | Role |
|---|---|
| `policy/policy.json` | The policy pack: knockouts, credit rules with exception bands, grading, pricing, authority matrix, prohibited inputs |
| `policy/engine.js` | The decision service: `evaluate(input, policy)` and the spreading maths |
| `lib/data.js` | Seeded generator for applicants, financials, memos |
| `lib/desk.js` | Desk state, simulated agent runtime, approvals, policy change control, audit chain, metrics |
| `lib/routes.js` | The API, shared by the Node server and the in-browser build |
| `server.js` | HTTP server, server-sent events, optional password and tool-key lock |
| `public/` | The console (plain HTML/CSS/JS, no framework) |
| `evals/golden.json`, `evals/run.js` | 24-case golden set and its runner / CI gate |
| `evals/agent-results.json` | Agent evaluation figures (sample data in ADK format) |
| `scripts/build-static.js`, `scripts/sha256-shim.js` | Builds the public site into `dist/` |
| `scripts/publish-site.sh` | Pushes `dist/` to the public site repo (this source repo is private) |
| `orchestrate/` | OpenAPI tool spec and agent YAML for watsonx Orchestrate |
| `Dockerfile` | Container for hosting the server (tool back end) |

No npm dependencies. Node 18+ for the server; any modern browser for the static build.

## 3. An application's journey

Live applications arrive every 7–13 seconds (while fewer than 6 are in flight) and move through:

| Stage | Who | What happens |
|---|---|---|
| Intake | Document Intake Agent | Classifies uploads, extracts two years of financials (confidence 0.93–0.99) |
| Awaiting documents | Customer Comms Agent (automation) | ~18% of applications miss bank statements or director IDs; the agent requests them; the customer uploads 14–26 s later |
| KYB & screening | KYB & Screening Agent | ACRA profile, sanctions/PEP screening of company and directors |
| Credit analysis | Credit Analyst Agent | Calls the engine's spreading, drafts the credit memo; ~6% of drafts trip the memo guardrail and are redacted |
| Policy engine | Policy Engine | Evaluates against the active policy version; the result is hashed and audited |
| Then one of… | | |
| → Offer issued | Automation | Straight-through (STP): approved within delegated authority; 10% flagged for QA sampling |
| → Declined | Automation | A knockout rule failed: automated decline with reasons |
| → Human approval | People | Routed to L1 / L2 / L3 or decline review with an SLA |

After a human decision the Comms agent issues the offer letter or decline notice. **Return to
analyst** sends the application back through analysis and the engine, and clears earlier signatures.

## 4. The policy engine

### Input contract

`amount, yearsTrading, industry, bureauScore, negativeDays90, sanctionsHit, bankruptcy` are required,
plus either `financials` (with `ebitda`) or precomputed `metrics`. Missing fields are a **400 error,
not a default**: a missing sanctions result must never be read as a pass (or a fail). Optional:
`tenorMonths` (default 60), `secured`, `collateralValue`, `documents`.

### Spreading (computed by the engine, not the LLM)

| Metric | Formula |
|---|---|
| New annual debt service | Amortising payment on `amount` at the **7.5% stress rate** over `tenorMonths`, × 12 |
| DSCR | `ebitda / (existingDebtService + newDebtService)` |
| Leverage | `(existingDebt + amount) / ebitda` |
| LTV | `amount / collateralValue` (secured only) |
| Revenue growth | `revenue / revenuePrior − 1` |

### Evaluation order

1. **Guardrails**: prohibited inputs (`gender, ethnicity, religion, maritalStatus, ownerAge, nationality`)
   are deleted before anything else and reported (CP-1.3). They cannot influence the outcome.
2. **Knockouts** K1–K5 (trading ≥ 2 yrs, no sanctions/PEP match, industry not excluded, no
   bankruptcy, amount ≤ S$5M). Any failure → `DECLINE` with `AUTO_DECLINE`.
3. **Documents**: four always required, plus a valuation report when secured. Missing → `PENDING_DOCUMENTS`.
4. **Credit rules** C1–C6, each with a standard and a looser exception limit:

| Rule | Standard | Exception limit | Clause |
|---|---|---|---|
| C1 DSCR | ≥ 1.25x | ≥ 1.10x | CP-4.2 |
| C2 Leverage | ≤ 3.5x | ≤ 4.5x | CP-4.3 |
| C3 Bureau score | ≥ 620 | ≥ 580 | CP-4.1 |
| C4 LTV (secured only) | ≤ 80% | ≤ 90% | CP-5.1 |
| C5 Negative days (90d) | ≤ 5 | ≤ 10 | CP-4.6 |
| C6 Revenue growth | ≥ −15% | ≥ −25% | CP-4.4 |

   Beyond the exception limit → `fail` → `DECLINE` routed to a human **decline review** (L1).
   Inside the band → `exception` → `REFER`. All pass → `APPROVE`.

The trace always contains every rule, so a reviewer sees the whole picture, not just the first failure.

### Grade and price

Risk points from five banded factors (first band reached wins):

| Factor | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| DSCR | ≥ 2.0 | ≥ 1.6 | ≥ 1.35 | ≥ 1.25 | below |
| Leverage | ≤ 1.5 | ≤ 2.5 | ≤ 3.5 | above | |
| Bureau | ≥ 750 | ≥ 690 | ≥ 640 | below | |
| Years trading | ≥ 10 | ≥ 5 | below | | |
| Negative days | 0 | ≤ 5 | above | | |

`grade = clamp(1 + round(points × 9 / 14), 1, 10)` (14 is the maximum points).
`rate = 3.00% base + spreadByGrade[grade] − 0.40% if secured`, with spreads from 1.6% (grade 1) to 6.5% (grade 10).

### Authority matrix (first level that fits)

| Level | Max amount | Max grade | Max exceptions | Signers | SLA |
|---|---|---|---|---|---|
| STP | S$100k | 3 | 0 | automation | — |
| L1 | S$250k | 5 | 0 | 1 credit officer | 4 h |
| L2 | S$1M | 7 | 1 | 2 different people, ≥ 1 senior | 8 h |
| L3 | no cap | 10 | any | Credit Committee | 48 h |

Credit-rule declines go to **decline review** (L1, 4 h): a person confirms or overrides.

Every result carries `policyVersion` and a `hash` of input + version + decision + grade, so a
decision can be tied to the exact rules that produced it.

## 5. Approvals and controls

| User | Role | Can sign |
|---|---|---|
| Priya Nair | Credit Officer | L1, decline review, L2 (as one of two) |
| Daniel Lim | Senior Credit Manager | L1, decline review, L2 |
| Margaret Ong | Chair, Credit Committee | L1, L2, L3 |
| Aisha Rahman | Head of Credit Risk Policy | No loans; approves policy changes only |

Enforced in `desk.decideApp` (server and browser build alike); the UI only mirrors it:

- **Authority**: a role outside the level's signer list is refused with the reason.
- **Segregation of duties**: no one can sign the same application twice.
- **Dual sign-off (L2)**: two different approvers, and at least one must be a Senior Credit Manager or Committee member. Two officers can't complete it.
- **Reasons**: every action needs a reason (8+ characters), written to the audit chain.
- **Overrides**: approving against a `DECLINE` or declining an `APPROVE` needs 25+ characters and is counted on the dashboard. (Approving a `REFER` is normal and not an override; the UI asks for a mitigant.)
- **One decline closes it**: any authorised signer can decline; approvals need the full count.
- **SLA**: "at risk" when 75% of the SLA has elapsed, "past SLA" after.
- **Desk 2**: to keep the queue realistic, when more than 14 items are waiting, every 20 s a colleague ("Wei Jie Tan, Desk 2") clears the oldest unsigned L1 item. It only touches L1 items with no signatures.

## 6. Policy change control

1. **Draft**: edit credit standards / exception limits, and STP/L1/L2 max amount, grade and exceptions (knockouts and L3 are read-only in the UI). Changed cells turn gold.
2. **Simulate**: the draft and the active policy both evaluate every application on the book (history, queue and live), plus the golden set. You see decision moves (e.g. `Refer → Approve: 6`), authority-mix change, the golden result and the applications that change.
3. **Submit**: needs a rationale (10+ characters); only one change can be pending.
4. **Review**: only the Head of Credit Risk Policy can approve, and never their own change. If any golden case changes outcome, the approver must acknowledge it in the note (10+ characters) — a re-baseline, made explicit.
5. **Publish**: the version bumps (3.2 → 3.3), the header chip flashes, new applications use it immediately. Applications already in the queue keep the version they were evaluated under (shown in their decision card).

## 7. Evaluations

- **Policy golden set** (`evals/golden.json`): 24 cases covering every rule, both sides of each boundary (e.g. DSCR exactly 1.25), every authority level, missing documents and a prohibited attribute. Expected outcomes were derived by hand from the policy, not copied from the engine. They specify `metrics` directly so they test decision logic independently of spreading. `node evals/run.js` exits 1 on any failure — use it as a CI gate.
- **Agent release gates** (`evals/agent-results.json`): per-agent metrics in the shape of `orchestrate evaluations evaluate` output — journey success (gate 90%), tool-call precision (95%) and recall (90%), faithfulness (85%), routing accuracy, response time — with history by version. The Credit Analyst 3.1.0-rc1 candidate is **blocked**: it skipped the policy engine on 3 of 50 renewals. **These figures are sample data** until a real ADK run replaces the file; the page says so.
- **Custom judges** J1–J6: plain-language LLM-as-judge criteria (memo cites clauses, figures match the engine, no prohibited attributes, decline notices give reasons, sanctions matches always referred, no decision stated before the engine returns). Gate 95%.

## 8. Audit chain

Every submission, engine decision, automation, approval, guardrail and policy change appends:

```
hash = SHA-256( previousHash + JSON([seq, at, actor, action, appId, detail]) )     first previousHash = "GENESIS"
```

**Verify now** (Control tower) recomputes the chain; editing any past entry breaks every later hash.
The browser build uses a pure-JS SHA-256 (`scripts/sha256-shim.js`) tested to match Node's crypto,
including non-ASCII text and padding boundaries.

## 9. Simulation and seeded data

- **Deterministic**: seeded RNGs (history 77, queue 5150, live 20261013), so every start tells the same story; only live arrival timing varies.
- **14 days of history**: 270 decided applications, fewer at weekends, run through the real engine. Human outcomes: engine `APPROVE` approved 95.5% of the time, `REFER` 72%, `DECLINE` confirmed 93% (the rest are overrides). Time to decision: STP 2–9 min, auto-decline 1–5 min, L1 0.8–6 h, L2 2.5–14 h, L3 18–58 h.
- **Applicant mix**: 30% clean small (STP-eligible), 32% clean, 20% one exception, 11% credit decline, 7% knockout.
- **Consistent financials**: the generator picks target ratios, then back-solves EBITDA, revenue and debt so the engine's own spreading lands on them — the memo, the key figures and the rule trace always agree.
- **Starting queue** (10 items, guaranteed): Tanjong Precision Engineering `LN-26-10671` (S$650k, DSCR 1.23x exception, L2, grade 6, 6.10%), a committee case, a decline review, and a dual sign-off already carrying Priya's first signature.
- **Agents are simulated** in this build: their steps, timings, token counts and success rates are generated. The policy engine, controls, audit and metrics are real code.

## 10. Dashboard metrics: exact definitions

| Tile | Definition |
|---|---|
| Submitted today | Applications created today (SGT) |
| Decided without a person | Decisions closed by automation (STP approvals + knockout declines) ÷ all decisions |
| Median time to decision | Median of decision time − submission time, all decided applications |
| Waiting for approval | Items in the human lane, with past-SLA and at-risk counts |
| Human override rate | Human decisions against the engine (approve a DECLINE, decline an APPROVE) ÷ human decisions |
| Policy exceptions | `REFER` ÷ evaluated applications; sub-line: share of human-decided REFERs approved |
| Guardrail interventions | Prohibited-attribute strips + memo redactions |
| Agent cost per application | Total tokens ÷ 1M × $2.00 ÷ applications with agent runs (an estimate) |

Charts: decisions per day (14 days, stacked), pipeline now, median time to decision by level, and
rules most often in exception or fail. Each chart has hover detail; the daily chart has a table view.

## 11. Two ways to run it

| | Server (`node server.js`) | Static build (GitHub Pages) |
|---|---|---|
| Where the desk runs | Node process; all browsers share one desk | Each visitor's browser; private desk |
| Live updates | Server-sent events (`/api/stream`) | `LocalDesk.subscribe` in-page |
| Reset | Restart the server | **Reset demo** (reloads the page) |
| Orchestrate can call it | Yes (when hosted) | No — static sites can't receive tool calls |
| Secrets | `TOOL_API_KEY`, `DEMO_PASSWORD` when hosted | None |

`scripts/build-static.js` bundles `lib/routes.js` and everything it requires (engine, desk, data,
golden set, JSON) into `dist/desk.bundle.js` with a tiny module loader; Node's `crypto` is replaced
by the SHA-256 shim and `path` by an empty stub (only the CLI part of `evals/run.js` uses it).
`public/app.js` detects `window.LocalDesk` and calls it instead of `fetch`. Rebuild after any change:

```
scripts/publish-site.sh          # builds dist/ and pushes it to the public site repo
                                 # CNAME=demo.example.com scripts/publish-site.sh for a custom domain
```

**Hosted server lock** (`server.js`): with `TOOL_API_KEY` set, a request carrying `x-api-key` may
only reach the three tool routes (evaluate, list, get); with `DEMO_PASSWORD` set, everything else
needs basic auth (any username). Comparisons are constant-time. Keep both in `.env` (git- and
build-ignored) and the host's secret store.

## 12. watsonx Orchestrate integration

- `orchestrate/policy-engine-openapi.yaml` exposes `lgb_evaluate_application`, `lgb_get_application`
  and `lgb_list_applications`, secured by the `x-api-key` header. **There is deliberately no approve
  or decline operation**, so no agent can decide. The committed `servers` URL is a placeholder;
  substitute your back end at import time.
- `orchestrate/agents/sme_credit_analyst.yaml`: explains decisions, runs what-ifs through the
  engine, drafts memos; may not state an outcome before the engine returns; refuses prohibited
  attributes; cannot approve.
- `orchestrate/agents/sme_credit_supervisor.yaml`: answers queue questions and hands decision
  questions to the analyst (collaborator).
- The `lgb_` prefix keeps the assets identifiable and removable in a shared instance.
- The intake, KYB and comms agents need their own tools (extraction, ACRA/sanctions, messaging) — next phase.

```
# one connection holds the tool key; set it for both draft and live
orchestrate connections add -a lgb_sme_desk
orchestrate connections configure -a lgb_sme_desk --env draft --type team --kind api_key
orchestrate connections set-credentials -a lgb_sme_desk --env draft --api-key "$TOOL_API_KEY"   # repeat both with --env live
orchestrate tools import -k openapi -f policy-engine-openapi.yaml --app-id lgb_sme_desk
orchestrate agents import -f agents/sme_credit_analyst.yaml
orchestrate agents import -f agents/sme_credit_supervisor.yaml
```

## 13. Demo flow

**Before you start:** open the site, press **Reset demo**, sign in as **Priya Nair** (header
selector). Keep the tab in front — browsers slow timers in background tabs. A direct link to the
showcase case: `…/?open=LN-26-10671#approvals`.

### Full walkthrough (~12 minutes)

| # | Screen | Do | Say |
|---|---|---|---|
| 1 | Overview | Point at the tiles and the daily chart | "Over a third of decisions never wait for a person; the human override rate and guardrail hits are on the same screen as speed." |
| 2 | Overview | Watch the live feed for a few seconds | "Every agent step and every engine decision lands here as it happens." |
| 3 | Applications | Follow a new card from Intake to Offer or Approval; find one in *Awaiting documents* | "Navy lanes are agents, the gold lane is people. Missing documents are chased automatically; small clean loans are approved straight through, and 10% are sampled for QA." |
| 4 | Approvals → Tanjong Precision Engineering | Open it; walk the decision card, rule trace (C1 exception), key figures, memo, agent trail | "The engine says Refer: DSCR 1.23x against a 1.25x standard, inside the 1.10x exception band, clause CP-4.2. The agent wrote the memo, but the decision and the 6.10% price came from the rules." |
| 5 | Same drawer, as Priya | Reason: "DSCR exception mitigated by equipment security and 11 years of trading"; condition: "DSCR covenant 1.15x"; **Approve (first signature)** | "Dual sign-off: I've signed, it now needs someone else." |
| 6 | Same drawer, as Priya | Try to sign again | "Blocked — segregation of duties. Not a UI trick: the desk refuses it." |
| 7 | Switch to **Daniel Lim** | Approve with a reason | "Second, senior signature — the offer letter goes out and the audit chain records both." |
| 8 | Approvals, as Priya | Open the **committee** case | "Above S$1M: Priya has no authority, the buttons are locked and the reason is shown." |
| 9 | Approvals, as Priya | Open the **decline review** case; try *Override and approve* with a short reason | "Overriding the engine needs a real justification, and every override shows up on the dashboard." |
| 10 | Policy engine, as **Daniel** | Change C1 standard 1.25 → 1.20; **Simulate impact** | "Before anyone can change policy we replay the whole book: a handful of applications (about six) move from Refer to Approve, and golden case G11 changes outcome." |
| 11 | Same | Rationale: "Align DSCR floor with peer banks for secured equipment loans"; **Submit** | "Daniel can't approve his own change." |
| 12 | Switch to **Aisha Rahman** | Approve with no note → refused; add "G11 re-baselined: DSCR 1.20 now passes" → approve | "The golden set forces an explicit re-baseline. Version 3.3 is live — watch the header." |
| 13 | Evaluations | Show the blocked Credit Analyst 3.1.0-rc1 and the judges | "A faster model that skipped the policy engine on 3 of 50 renewals never reaches production." |
| 14 | Control tower | Agent inventory; **Verify now** on the audit chain | "One place for every agent, its owner and health — and a tamper-evident record of everything you just saw." |

Alternative for step 10 with no re-baseline: set **STP max amount** to 150000 — about a dozen
applications become straight-through and the golden set stays 24/24.

### Short version (~3 minutes)

1. Overview tiles (step 1). 2. Tanjong drawer: rule trace and memo (step 4). 3. Priya signs, Priya
blocked, Daniel completes (steps 5–7). 4. Control tower: Verify now (step 14).

### Talking points

- **Why a policy engine?** Same input, same answer, a clause for every outcome, and a version
  you can audit — things an LLM can't promise on its own.
- **Where do agents add value?** Reading documents, screening, spreading, writing the memo,
  chasing the customer — the slow parts of SME lending.
- **What stops an agent going rogue?** It has no tool that decides; the release gate blocks a
  version that bypasses the engine; judges check every memo; the audit chain records every step.

## 14. Troubleshooting and limits

- **The showcase case isn't in the queue** — it was already decided in this session. Press Reset demo (static) or restart the server.
- **Numbers differ from the script** — live arrivals vary; the seeded queue, golden results and policy what-ifs are deterministic.
- **"Policy change already waiting"** — only one change can be pending; review or reset.
- **Feed stalls** — the tab was in the background; bring it forward.
- **Hosted server sleeps** when idle (scale-to-zero) and wakes with a fresh shift.
- **Limits**: agents are simulated; agent evaluation figures are samples; state is in memory; one
  shared password on a hosted server; all data is synthetic.

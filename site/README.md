# Lionsgate Bank · SME Credit Desk

**[▶ Open the live demo](https://knijesh.github.io/lionsgate-sme-credit-desk-site/)** · runs in your browser, nothing to install

An agentic SME loan-origination desk with one rule at its heart: **agents gather the evidence, a
policy engine makes the decision, people approve within their authority, and every step is
recorded.** Agents are designed for **IBM watsonx Orchestrate**.

![Overview dashboard](assets/overview.png)

> Lionsgate Bank is fictitious; every company, person and figure is generated. In this public demo
> the agent steps are simulated, while the policy engine, approval controls, policy change control
> and audit chain are the real code. Each visitor gets a private desk; **Reset demo** starts a fresh shift.

---

## How an application flows

```mermaid
flowchart LR
  A(["SME applies<br/>through its RM"]) --> I["Document Intake Agent<br/>classifies files, extracts financials"]
  I -->|"documents missing"| R["Customer Comms Agent<br/>requests them automatically"]
  R -->|"customer uploads"| I
  I --> K["KYB & Screening Agent<br/>ACRA profile, sanctions, PEP"]
  K --> C["Credit Analyst Agent<br/>spreads financials, drafts memo"]
  C --> P{{"Policy engine<br/>deterministic rules v3.2"}}
  P -->|"knockout rule fails"| AD["Automated decline<br/>with reasons"]
  P -->|"small, clean, low risk"| STP["Straight-through approval<br/>10% sampled for QA"]
  P -->|"everything else"| H["People approve<br/>within their authority"]
  STP --> O(["Offer letter or<br/>decline notice"])
  AD --> O
  H --> O
  P -.-> AU[("Hash-chained<br/>audit log")]
  H -.-> AU

  classDef agent fill:#ebeff7,stroke:#1b3a6b,color:#14213d
  classDef engine fill:#1b3a6b,stroke:#0b1f3a,color:#ffffff
  classDef human fill:#fbf6e6,stroke:#c9a227,color:#14213d
  classDef auto fill:#f4f2ed,stroke:#66707f,color:#14213d
  class I,R,K,C agent
  class P engine
  class H human
  class AD,STP,AU auto
```

**Agents never decide.** They have no tool that can approve or decline. The decision, risk grade,
price and approval level always come from the policy engine, with a clause for every rule it applied.

![Application board](assets/applications.png)

## What the policy engine checks

```mermaid
flowchart TD
  IN["Application facts<br/>from the agents"] --> G["Guardrail<br/>strip gender, age, ethnicity, religion,<br/>marital status, nationality"]
  G --> KO{"Knockouts<br/>trading ≥ 2 yrs · no sanctions match<br/>industry allowed · no bankruptcy · ≤ S$5M"}
  KO -->|"any fails"| D1["DECLINE<br/>automated"]
  KO -->|"all pass"| DOC{"All documents<br/>received?"}
  DOC -->|"no"| PD["PENDING DOCUMENTS"]
  DOC -->|"yes"| CR{"Credit rules C1–C6<br/>DSCR · leverage · bureau · LTV<br/>negative days · revenue growth"}
  CR -->|"beyond exception limit"| D2["DECLINE<br/>human decline review"]
  CR -->|"inside exception band"| RF["REFER<br/>approve with mitigant"]
  CR -->|"all within standard"| AP["APPROVE"]
  RF --> GR["Risk grade 1–10<br/>and price"]
  AP --> GR

  classDef bad fill:#fbe1e1,stroke:#d03b3b,color:#14213d
  classDef warn fill:#fdf0cf,stroke:#c9a227,color:#14213d
  classDef good fill:#dff3df,stroke:#0ca30c,color:#14213d
  class D1,D2 bad
  class RF,PD warn
  class AP good
```

Same input, same answer: every decision carries the policy version and a hash, and the full rule
trace is shown to the approver.

## Who has to sign

```mermaid
flowchart LR
  E{{"Engine result"}} --> S1["Up to S$100k · grade ≤ 3<br/>no exceptions"]
  E --> S2["Up to S$250k · grade ≤ 5<br/>no exceptions"]
  E --> S3["Up to S$1M · grade ≤ 7<br/>at most 1 exception"]
  E --> S4["Above S$1M or<br/>weaker grade / more exceptions"]
  S1 --> L0["STP<br/>automation"]
  S2 --> L1["L1<br/>one credit officer · 4h SLA"]
  S3 --> L2["L2 dual sign-off<br/>two different people,<br/>one senior · 8h SLA"]
  S4 --> L3["L3<br/>Credit Committee · 48h SLA"]

  classDef lvl fill:#fbf6e6,stroke:#c9a227,color:#14213d
  classDef eng fill:#1b3a6b,stroke:#0b1f3a,color:#ffffff
  class L0,L1,L2,L3 lvl
  class E eng
```

### Segregation of duties, enforced

```mermaid
sequenceDiagram
  autonumber
  actor Priya as Priya (Credit Officer)
  actor Daniel as Daniel (Senior Credit Mgr)
  participant Desk as Credit desk
  participant Audit as Audit chain
  Priya->>Desk: Approve Tanjong Precision (L2) with mitigant
  Desk->>Audit: approval.approve · 1 of 2
  Desk-->>Priya: First signature recorded
  Priya->>Desk: Approve again
  Desk-->>Priya: Refused: already signed (segregation of duties)
  Daniel->>Desk: Approve
  Desk->>Audit: approval.approve · 2 of 2
  Desk-->>Daniel: Approved · offer letter issued
```

Also enforced: no authority above your level, overriding the engine needs a written justification
(and is reported), and every action needs a reason.

![Approval with full rule trace](assets/approval.png)

## Changing the policy safely

```mermaid
flowchart LR
  D["Draft<br/>e.g. DSCR 1.25 → 1.20"] --> SIM["Simulate<br/>replay every application<br/>and the 24-case golden set"]
  SIM --> SUB["Submit<br/>with a rationale"]
  SUB --> REV{"Head of Credit Risk Policy<br/>reviews"}
  REV -->|"author tries to approve"| X1["Refused<br/>segregation of duties"]
  REV -->|"golden cases changed,<br/>no acknowledgement"| X2["Refused<br/>must re-baseline explicitly"]
  REV -->|"approved"| PUB["v3.3 published<br/>new applications use it"]
  PUB -.-> AU[("Audit chain")]

  classDef stop fill:#fbe1e1,stroke:#d03b3b,color:#14213d
  classDef ok fill:#dff3df,stroke:#0ca30c,color:#14213d
  class X1,X2 stop
  class PUB ok
```

![Policy engine and what-if](assets/policy.png)

## Agents ship through a release gate

Each agent is scored on journey success, tool-call precision and recall, faithfulness and custom
LLM-as-judge criteria before it reaches production. In the demo, a faster Credit Analyst release
candidate is **blocked** because it skipped the policy engine on 3 of 50 renewals. The policy
engine itself must pass a hand-checked golden set of 24 cases on every change.

![Evaluations](assets/evaluations.png)

## One place to govern it all

The control tower lists every agent with its owner, model, tools, health and evaluation status,
alongside a tamper-evident audit trail anyone can verify.

![Control tower](assets/control-tower.png)

## Try it in five minutes

1. **Overview**: over a third of decisions never wait for a person.
2. **Applications**: watch agents move cases along; one asks for missing documents.
3. **Approvals**: as Priya, open *Tanjong Precision Engineering*, approve with a mitigant, then try to sign again.
4. Switch the header user to **Daniel Lim** and give the second signature.
5. **Policy engine**: as Daniel, set the DSCR standard to 1.20, simulate, submit; switch to **Aisha Rahman** to review.
6. **Control tower**: press *Verify now* on the audit chain.

## About this repository

This repository holds only the built site. The source is maintained privately.

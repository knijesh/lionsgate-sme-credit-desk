// The credit desk: application state, the simulated agent runtime, approvals under the authority
// matrix with segregation of duties, policy change control, a hash-chained audit log and metrics.
const crypto = require('crypto');
const { evaluate } = require('../policy/engine');
const { runGolden } = require('../evals/run');
const D = require('./data');

const H = 3600e3, MIN = 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r = D.rng(20261013);

const USERS = {
  priya: { id: 'priya', name: 'Priya Nair', role: 'credit_officer', title: 'Credit Officer' },
  daniel: { id: 'daniel', name: 'Daniel Lim', role: 'senior_credit_manager', title: 'Senior Credit Manager' },
  margaret: { id: 'margaret', name: 'Margaret Ong', role: 'credit_committee', title: 'Chair, Credit Committee' },
  aisha: { id: 'aisha', name: 'Aisha Rahman', role: 'policy_approver', title: 'Head of Credit Risk Policy' },
};
const SIGN = { L1: ['credit_officer', 'senior_credit_manager', 'credit_committee'],
  L2: ['credit_officer', 'senior_credit_manager', 'credit_committee'], L3: ['credit_committee'] };
const SENIOR = ['senior_credit_manager', 'credit_committee'];

const AGENTS = [
  { id: 'supervisor', name: 'SME Credit Supervisor', kind: 'Orchestrate agent', model: 'groq/openai/gpt-oss-120b', version: '1.4.0',
    tools: ['route_to_agent', 'get_application'], owner: 'SME Lending', role: 'Routes each application through the desk' },
  { id: 'intake', name: 'Document Intake Agent', kind: 'Orchestrate agent', model: 'ibm/granite-3-3-8b-instruct', version: '2.1.0',
    tools: ['classify_documents', 'extract_financials'], owner: 'SME Lending', role: 'Classifies uploads and extracts financials' },
  { id: 'kyb', name: 'KYB & Screening Agent', kind: 'Orchestrate agent', model: 'groq/openai/gpt-oss-120b', version: '1.7.2',
    tools: ['acra_lookup', 'screen_sanctions_pep', 'resolve_ownership'], owner: 'Financial Crime Compliance', role: 'Verifies the business and screens parties' },
  { id: 'analyst', name: 'Credit Analyst Agent', kind: 'Orchestrate agent', model: 'meta-llama/llama-3-3-70b-instruct', version: '3.0.1',
    tools: ['policy_engine.evaluate', 'draft_credit_memo', 'credit_policy_kb'], owner: 'Credit Risk', role: 'Spreads financials and drafts the credit memo' },
  { id: 'comms', name: 'Customer Comms Agent', kind: 'Orchestrate agent', model: 'ibm/granite-3-3-8b-instruct', version: '1.2.0',
    tools: ['request_documents', 'issue_offer', 'issue_decline_notice'], owner: 'SME Lending', role: 'Requests documents, sends offers and notices' },
  { id: 'engine', name: 'Policy Engine', kind: 'Decision service', model: 'deterministic rules', version: null,
    tools: ['evaluate_application', 'simulate_policy'], owner: 'Credit Risk Policy', role: 'Makes every credit decision' },
  { id: 'fraud', name: 'Fraud Case Assistant', kind: 'Orchestrate agent (other team)', model: 'groq/openai/gpt-oss-120b', version: '26.5.0',
    tools: ['list_cases', 'get_case', 'approve_hold'], owner: 'Fraud Operations', role: 'Works the fraud case queue', external: true },
];

const S = {
  policy: JSON.parse(JSON.stringify(require('../policy/policy.json'))),
  policyLog: [], changeRequests: [], apps: new Map(), audit: [], activity: [], clients: new Set(), started: Date.now(),
};
S.policyLog.push({ version: S.policy.version, at: Date.parse(S.policy.effective + 'T00:00:00+08:00'), by: 'Aisha Rahman', note: 'Annual policy review' });

// ---------- events and audit ----------
function emit(type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of S.clients) res.write(line);
}
function audit(actor, action, appId, detail) {
  const prev = S.audit.length ? S.audit[S.audit.length - 1].hash : 'GENESIS';
  const e = { seq: S.audit.length + 1, at: Date.now(), actor, action, appId, detail, prev };
  e.hash = crypto.createHash('sha256').update(prev + JSON.stringify([e.seq, e.at, actor, action, appId, detail])).digest('hex');
  S.audit.push(e);
  emit('audit', e);
  return e;
}
function verifyAudit() {
  let prev = 'GENESIS';
  for (const e of S.audit) {
    const h = crypto.createHash('sha256').update(prev + JSON.stringify([e.seq, e.at, e.actor, e.action, e.appId, e.detail])).digest('hex');
    if (e.prev !== prev || e.hash !== h) return { ok: false, brokenAt: e.seq, entries: S.audit.length };
    prev = e.hash;
  }
  return { ok: true, entries: S.audit.length, head: prev.slice(0, 16) };
}

// ---------- application helpers ----------
const STAGES = ['intake', 'documents', 'kyb', 'analysis', 'policy', 'approval', 'offer', 'declined'];
function summary(a) {
  const ev = a.evaluation;
  return {
    id: a.id, company: a.company, industry: a.industry, product: a.product, amount: a.amount, rm: a.rm, stage: a.stage,
    createdAt: a.createdAt, updatedAt: a.updatedAt, enteredApprovalAt: a.enteredApprovalAt, decidedAt: a.decidedAt,
    decision: ev ? { decision: ev.decision, level: ev.approval && ev.approval.level, label: ev.approval && ev.approval.label,
      grade: ev.grade, exceptions: ev.exceptions.length, rate: ev.pricing.rate, slaHours: ev.approval && ev.approval.slaHours, version: ev.policyVersion } : null,
    approvals: a.approvals.map(x => ({ by: x.by, action: x.action })), final: a.final, qaSample: a.qaSample,
    working: a.working || null, missing: a.missing || null, history: !!a.history,
  };
}
function touch(a) { a.updatedAt = Date.now(); emit('app', summary(a)); }
function step(a, agent, text, kind = 'ok', meta = {}) {
  const s = { at: Date.now(), agent, text, kind, ...meta };
  a.steps.push(s);
  a.working = kind === 'work' ? { agent, text } : null;
  const ev = { appId: a.id, company: a.company, ...s };
  if (kind !== 'work') { S.activity.unshift(ev); S.activity.length = Math.min(S.activity.length, 60); }
  emit('activity', ev);
  touch(a);
}
function runStats(a, agent, ms, tokens, toolCalls, ok = true) {
  a.runs.push({ agent, ms, tokens, toolCalls, ok, at: Date.now() });
}

// ---------- the live pipeline ----------
async function work(a, agent, text, ms) { step(a, agent, text, 'work'); await sleep(ms); }

async function intake(a) {
  a.stage = 'intake'; touch(a);
  step(a, 'supervisor', `Application received from ${a.rm} (RM) · ${D.sgd(a.amount)} ${a.product.toLowerCase()}`, 'info');
  await work(a, 'intake', 'Classifying uploaded documents', 1800 + r() * 1200);
  step(a, 'intake', `Classified ${a.documents.length + 2} files: ${a.documents.map(d => D.DOC_NAMES[d]).join(', ')}`, 'ok', { tool: 'classify_documents' });
  await work(a, 'intake', 'Extracting financial statements', 1800 + r() * 1500);
  step(a, 'intake', `Extracted FY2024–FY2025 financials · revenue ${D.sgd(a.financials.revenue)}, EBITDA ${D.sgd(a.financials.ebitda)} · confidence ${(0.93 + r() * 0.06).toFixed(2)}`, 'ok', { tool: 'extract_financials' });
  runStats(a, 'intake', 3500 + r() * 2500, 6000 + r() * 4000, 2);
  const required = [...S.policy.documents.always, ...(a.secured ? S.policy.documents.secured : [])];
  a.missing = required.filter(d => !a.documents.includes(d));
  if (!a.missing.length) a.missing = null;
  else {
    a.stage = 'documents';
    step(a, 'comms', `Automation: requested ${a.missing.map(d => D.DOC_NAMES[d]).join(' and ')} from the customer via the SME portal`, 'auto', { tool: 'request_documents' });
    runStats(a, 'comms', 900 + r() * 600, 1800, 1);
    audit('automation', 'documents.requested', a.id, a.missing.join(','));
    await sleep(14000 + r() * 12000);
    a.documents.push(...a.missing);
    step(a, 'intake', `Customer uploaded ${a.missing.map(d => D.DOC_NAMES[d]).join(' and ')} · checklist complete`, 'ok');
    a.missing = null;
  }
}

async function kyb(a) {
  a.stage = 'kyb'; touch(a);
  await work(a, 'kyb', 'Verifying ACRA profile', 1500 + r() * 1000);
  step(a, 'kyb', `ACRA profile verified · UEN ${a.uen} · ${a.yearsTrading} year${a.yearsTrading === 1 ? '' : 's'} registered · ${a.directors} director${a.directors > 1 ? 's' : ''}`, 'ok', { tool: 'acra_lookup' });
  await work(a, 'kyb', 'Screening company and directors against sanctions and PEP lists', 1800 + r() * 1200);
  if (a.sanctionsHit) step(a, 'kyb', 'Sanctions screening: confirmed match on a director (OFAC SDN list) · referred to Financial Crime Compliance', 'warn', { tool: 'screen_sanctions_pep' });
  else step(a, 'kyb', `Screened company and ${a.directors} director${a.directors > 1 ? 's' : ''} · 0 sanctions or PEP matches`, 'ok', { tool: 'screen_sanctions_pep' });
  runStats(a, 'kyb', 3000 + r() * 2000, 4000 + r() * 2000, 3);
}

async function analysis(a) {
  a.stage = 'analysis'; touch(a);
  await work(a, 'analyst', 'Spreading financials and stress-testing repayments', 2000 + r() * 1500);
  const ev = evaluate(D.policyInput(a), S.policy);
  const m = ev.metrics;
  step(a, 'analyst', `Spread financials · DSCR ${m.dscr.toFixed(2)}x at 7.5% stress · leverage ${m.leverage.toFixed(2)}x${m.ltv ? ` · LTV ${(m.ltv * 100).toFixed(0)}%` : ''} · revenue ${m.revenueGrowth >= 0 ? '+' : ''}${(m.revenueGrowth * 100).toFixed(1)}%`, 'ok', { tool: 'policy_engine.compute_metrics' });
  await work(a, 'analyst', 'Drafting credit memo', 2200 + r() * 1500);
  a.memo = D.memo(a, ev);
  if (a.guardrailMemo) {
    step(a, 'analyst', "Guardrail: memo draft referred to a director's age, a prohibited attribute (CP-1.3) · redacted and regenerated", 'guard');
    a.guardrails.push({ at: Date.now(), type: 'memo_prohibited_attribute', text: 'Director age removed from memo draft' });
    audit('guardrail', 'memo.redacted', a.id, 'prohibited attribute: ownerAge');
  }
  step(a, 'analyst', `Credit memo drafted (${a.memo.split(/\s+/).length} words) · cites ${ev.trace.filter(t => t.result === 'exception' || t.result === 'fail').length || 'no'} policy exception${ev.trace.filter(t => t.result === 'exception' || t.result === 'fail').length === 1 ? '' : 's'}`, 'ok', { tool: 'draft_credit_memo' });
  runStats(a, 'analyst', 5000 + r() * 4000, 12000 + r() * 6000, 3);
}

async function decide(a) {
  a.stage = 'policy'; touch(a);
  await work(a, 'engine', `Evaluating against ${S.policy.id} v${S.policy.version}`, 900 + r() * 600);
  const ev = evaluate(D.policyInput(a), S.policy);
  a.evaluation = ev;
  if (ev.guardrails.length) a.guardrails.push(...ev.guardrails.map(g => ({ at: Date.now(), ...g })));
  const why = ev.decision === 'DECLINE' ? ` · ${ev.declineReasons.join(', ')}` : ev.exceptions.length ? ` · exception ${ev.exceptions.join(', ')}` : '';
  step(a, 'engine', `${ev.decision} · grade ${ev.grade} · ${ev.pricing.rate.toFixed(2)}% · ${ev.approval.label}${why}`, ev.decision === 'DECLINE' ? 'warn' : 'ok', { tool: 'evaluate_application', hash: ev.hash });
  audit('policy-engine', 'decision.evaluated', a.id, `${ev.decision} ${ev.approval.level} v${ev.policyVersion} #${ev.hash}`);
  runStats(a, 'engine', 40 + r() * 60, 0, 1);

  if (ev.approval.level === 'STP') {
    a.qaSample = r() < S.policy.stpQaSampleRate;
    step(a, 'supervisor', `Automation: approved within straight-through authority (≤ ${D.sgd(S.policy.authority[0].maxAmount)}, grade ≤ ${S.policy.authority[0].maxGrade}, no exceptions)${a.qaSample ? ' · selected for 10% QA sample' : ''}`, 'auto');
    audit('automation', 'application.approved', a.id, `STP v${ev.policyVersion}`);
    return close(a, 'approved', 'automation');
  }
  if (ev.approval.level === 'AUTO_DECLINE') {
    step(a, 'supervisor', `Automation: declined on knockout rule ${ev.declineReasons.join(', ')}`, 'auto');
    audit('automation', 'application.declined', a.id, `knockout ${ev.declineReasons.join(',')}`);
    return close(a, 'declined', 'automation');
  }
  a.stage = 'approval'; a.enteredApprovalAt = Date.now();
  step(a, 'supervisor', `Routed to ${ev.approval.label} (${ev.approval.level}) · ${ev.approval.approvers === 2 ? 'two signatures' : 'one signature'} · SLA ${ev.approval.slaHours}h`, 'route');
  audit('supervisor', 'approval.requested', a.id, `${ev.approval.level} ${ev.decision}`);
}

async function close(a, outcome, by) {
  const ev = a.evaluation;
  a.final = { outcome, by, at: Date.now(),
    override: by !== 'automation' && ((ev.decision === 'APPROVE' && outcome === 'declined') || (ev.decision === 'DECLINE' && outcome === 'approved')) };
  a.decidedAt = Date.now();
  await sleep(1200);
  if (outcome === 'approved') {
    step(a, 'comms', `Offer letter issued · ${D.sgd(a.amount)} at ${ev.pricing.rate.toFixed(2)}% over ${a.tenorMonths} months`, 'ok', { tool: 'issue_offer' });
    a.stage = 'offer';
  } else {
    step(a, 'comms', 'Decline notice with reasons issued to the customer and RM', 'ok', { tool: 'issue_decline_notice' });
    a.stage = 'declined';
  }
  runStats(a, 'comms', 800 + r() * 700, 1500 + r() * 800, 1);
  touch(a);
}

function newLiveApp(opts = {}) {
  const a = D.makeApplication(r, opts);
  Object.assign(a, { createdAt: Date.now(), updatedAt: Date.now(), steps: [], approvals: [], runs: [], guardrails: [], live: true });
  a.documents = [...D.ALL_DOCS, ...(a.secured ? ['valuation_report'] : [])];
  if (r() < 0.18) a.documents = a.documents.filter(d => d !== (r() < 0.6 ? 'bank_statements_6m' : 'director_ids'));
  a.guardrailMemo = r() < 0.06;
  S.apps.set(a.id, a);
  audit(a.rm, 'application.submitted', a.id, `${D.sgd(a.amount)} ${a.product}`);
  return a;
}
async function runLive(a) {
  try {
    await intake(a); await kyb(a); await analysis(a); await decide(a);
  } catch (e) { console.error('pipeline', a.id, e); }
}

// ---------- approvals ----------
function decideApp(id, userId, action, reason, conditions) {
  const a = S.apps.get(id), u = USERS[userId];
  if (!a) throw err(404, 'No such application');
  if (!u) throw err(400, 'Unknown user');
  if (a.stage !== 'approval') throw err(409, 'This application is not waiting for approval');
  const ev = a.evaluation, level = ev.approval.level;
  if (!SIGN[level] || !SIGN[level].includes(u.role)) throw err(403, `${u.name} (${u.title}) has no ${ev.approval.label} authority for ${level}`);
  if (a.approvals.some(x => x.userId === u.id)) throw err(403, `Segregation of duties: ${u.name} has already signed this application`);
  if (!reason || reason.trim().length < 8) throw err(400, 'Give a reason of at least a few words');
  const override = (ev.decision === 'DECLINE' && action === 'approve') || (ev.decision === 'APPROVE' && action === 'decline');
  if (override && reason.trim().length < 25) throw err(400, 'Overriding the policy engine needs a fuller justification (25+ characters)');
  if (action === 'approve' && ev.approval.approvers === 2 && a.approvals.length === 1) {
    const first = USERS[a.approvals[0].userId];
    if (!SENIOR.includes(first.role) && !SENIOR.includes(u.role)) throw err(403, 'Dual sign-off needs at least one Senior Credit Manager or Committee signature');
  }
  const rec = { userId: u.id, by: u.name, role: u.title, action, reason: reason.trim(), conditions: conditions || '', at: Date.now(), override };
  a.approvals.push(rec);
  audit(u.name, `approval.${action}`, a.id, `${level}${override ? ' OVERRIDE' : ''}: ${rec.reason}`);
  if (action === 'return') {
    step(a, 'supervisor', `${u.name} returned the application to the analyst: "${rec.reason}"`, 'human');
    a.approvals = [];
    (async () => { await analysis(a); await decide(a); })();
    return summary(a);
  }
  if (action === 'decline') {
    step(a, 'supervisor', `${u.name} declined${override ? ' (override of engine recommendation)' : ''}: "${rec.reason}"`, 'human');
    close(a, 'declined', 'human');
    return summary(a);
  }
  const need = ev.approval.approvers;
  if (a.approvals.filter(x => x.action === 'approve').length < need) {
    step(a, 'supervisor', `${u.name} signed (1 of ${need}) · waiting for a second, different approver`, 'human');
    return summary(a);
  }
  step(a, 'supervisor', `${u.name} approved${need === 2 ? ' (2 of 2)' : ''}${override ? ' (override of engine recommendation)' : ''}: "${rec.reason}"`, 'human');
  close(a, 'approved', 'human');
  return summary(a);
}
function err(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------- policy change control ----------
function draftPolicy(edits) {
  const p = JSON.parse(JSON.stringify(S.policy));
  for (const [id, v] of Object.entries(edits.rules || {})) {
    const rule = [...p.knockouts, ...p.credit].find(x => x.id === id);
    if (!rule) throw err(400, `Unknown rule ${id}`);
    if (v.value !== undefined) rule.value = Number(v.value);
    if (v.exception !== undefined) rule.exception = Number(v.exception);
  }
  for (const [lvl, v] of Object.entries(edits.authority || {})) {
    const l = p.authority.find(x => x.level === lvl);
    if (!l) throw err(400, `Unknown level ${lvl}`);
    for (const k of ['maxAmount', 'maxGrade', 'maxExceptions']) if (v[k] !== undefined) l[k] = Number(v[k]);
  }
  const [maj, min] = S.policy.version.split('.').map(Number);
  p.version = `${maj}.${min + 1}`;
  return p;
}
function simulate(edits) {
  const draft = draftPolicy(edits);
  const book = [...S.apps.values()].filter(a => a.evaluation);
  const moves = {}, flipped = [], levels = { before: {}, after: {} };
  for (const a of book) {
    const before = evaluate(D.policyInput(a), S.policy), after = evaluate(D.policyInput(a), draft);
    const k = `${before.decision}→${after.decision}`;
    moves[k] = (moves[k] || 0) + 1;
    const lb = before.approval && before.approval.level, la = after.approval && after.approval.level;
    levels.before[lb] = (levels.before[lb] || 0) + 1; levels.after[la] = (levels.after[la] || 0) + 1;
    if (before.decision !== after.decision || lb !== la) flipped.push({ id: a.id, company: a.company, amount: a.amount, from: `${before.decision} · ${lb}`, to: `${after.decision} · ${la}` });
  }
  return { draft: { version: draft.version }, portfolio: book.length, moves, levels, flipped: flipped.slice(0, 40), flippedCount: flipped.length,
    golden: runGolden(draft), goldenActive: runGolden(S.policy) };
}
function submitChange(userId, edits, rationale) {
  const u = USERS[userId];
  if (!u) throw err(400, 'Unknown user');
  if (!rationale || rationale.trim().length < 10) throw err(400, 'Explain why the policy should change');
  if (S.changeRequests.some(c => c.status === 'pending')) throw err(409, 'A policy change is already waiting for approval');
  const sim = simulate(edits);
  const cr = { id: `PCR-${String(S.changeRequests.length + 41).padStart(3, '0')}`, edits, rationale: rationale.trim(), author: u.name, authorId: u.id,
    at: Date.now(), status: 'pending', fromVersion: S.policy.version, toVersion: sim.draft.version,
    impact: { flippedCount: sim.flippedCount, moves: sim.moves, goldenPassed: sim.golden.passed, goldenTotal: sim.golden.total } };
  S.changeRequests.unshift(cr);
  audit(u.name, 'policy.change_submitted', null, `${cr.id} v${cr.fromVersion}→v${cr.toVersion}: ${cr.rationale}`);
  emit('policy', policyState());
  return cr;
}
function reviewChange(id, userId, action, note) {
  const cr = S.changeRequests.find(c => c.id === id), u = USERS[userId];
  if (!cr || cr.status !== 'pending') throw err(404, 'No pending change with that id');
  if (!u || u.role !== 'policy_approver') throw err(403, `${u ? u.name : 'This user'} cannot approve policy changes · Head of Credit Risk Policy only`);
  if (u.id === cr.authorId) throw err(403, 'Segregation of duties: the author cannot approve their own policy change');
  if (cr.impact.goldenPassed < cr.impact.goldenTotal && !(note && note.trim().length >= 10))
    throw err(400, `${cr.impact.goldenTotal - cr.impact.goldenPassed} golden cases change outcome · acknowledge them in the note to re-baseline`);
  cr.status = action === 'approve' ? 'approved' : 'rejected';
  cr.reviewer = u.name; cr.reviewedAt = Date.now(); cr.note = note || '';
  if (cr.status === 'approved') {
    S.policy = draftPolicy(cr.edits);
    S.policyLog.unshift({ version: S.policy.version, at: Date.now(), by: `${cr.author} → ${u.name}`, note: cr.rationale, cr: cr.id });
    AGENTS.find(a => a.id === 'engine').version = S.policy.version;
  }
  audit(u.name, `policy.change_${cr.status}`, null, `${cr.id}${cr.status === 'approved' ? ` · v${S.policy.version} active` : ''}`);
  emit('policy', policyState());
  return cr;
}
function policyState() {
  return { active: S.policy, log: S.policyLog, changeRequests: S.changeRequests };
}

// ---------- history: 14 days of decided applications ----------
function seedHistory() {
  const now = Date.now(), hr = D.rng(77);
  for (let i = 0; i < 270; i++) {
    let created = now - (14 * 24 * H) * hr() - 2 * H;
    const day = new Date(created + 8 * H).getUTCDay();
    if ((day === 0 || day === 6) && hr() < 0.7) created -= 2 * 24 * H;
    const a = D.makeApplication(hr);
    a.documents = [...D.ALL_DOCS, ...(a.secured ? ['valuation_report'] : [])];
    Object.assign(a, { createdAt: created, steps: [], approvals: [], runs: [], guardrails: [], history: true });
    const ev = evaluate(D.policyInput(a), S.policy);
    a.evaluation = ev; a.memo = D.memo(a, ev);
    const lvl = ev.approval.level;
    const ttd = { STP: (2 + hr() * 7) * MIN, AUTO_DECLINE: (1 + hr() * 4) * MIN, L1: (0.8 + hr() * 5) * H, L2: (2.5 + hr() * 11) * H, L3: (18 + hr() * 40) * H }[lvl];
    let outcome, by = 'automation', override = false;
    if (lvl === 'STP') outcome = 'approved';
    else if (lvl === 'AUTO_DECLINE') outcome = 'declined';
    else {
      by = 'human';
      const x = hr();
      if (ev.decision === 'APPROVE') { outcome = x < 0.955 ? 'approved' : 'declined'; override = outcome === 'declined'; }
      else if (ev.decision === 'REFER') outcome = x < 0.72 ? 'approved' : 'declined';
      else { outcome = x < 0.93 ? 'declined' : 'approved'; override = outcome === 'approved'; }
      const signers = lvl === 'L3' ? [USERS.margaret] : lvl === 'L2' ? [USERS.priya, USERS.daniel] : [hr() < 0.6 ? USERS.priya : USERS.daniel];
      a.approvals = signers.map(u => ({ userId: u.id, by: u.name, role: u.title, action: outcome === 'approved' ? 'approve' : 'decline', reason: '', at: created + ttd, override }));
    }
    a.final = { outcome, by, at: created + ttd, override };
    a.decidedAt = created + ttd; a.updatedAt = a.decidedAt; a.stage = outcome === 'approved' ? 'offer' : 'declined';
    if (lvl !== 'STP' && lvl !== 'AUTO_DECLINE') a.enteredApprovalAt = created + (8 + hr() * 10) * MIN;
    if (hr() < 0.05) a.guardrails.push({ at: created, type: 'memo_prohibited_attribute' });
    if (hr() < 0.012) a.guardrails.push({ at: created, type: 'prohibited_attribute' });
    for (const [ag, ms, tok, tc] of [['supervisor', 900, 2500, 2], ['intake', 4500, 8000, 2], ['kyb', 3800, 5000, 3], ['analyst', 7500, 15000, 3], ['engine', 70, 0, 1], ['comms', 1100, 1900, 1]]) {
      a.runs.push({ agent: ag, ms: ms * (0.6 + hr() * 0.9), tokens: tok * (0.7 + hr() * 0.6), toolCalls: tc, ok: hr() > (ag === 'intake' ? 0.035 : ag === 'engine' ? 0 : 0.012), at: created });
    }
    S.apps.set(a.id, a);
  }
}

// A realistic approval queue at the start of the shift, plus one showcase case.
function seedQueue() {
  const now = Date.now(), qr = D.rng(5150);
  const showcase = D.makeApplication(qr, { profile: 'exception' });
  Object.assign(showcase, { company: 'Tanjong Precision Engineering Pte Ltd', industry: 'Manufacturing', product: 'Equipment financing',
    purpose: 'two 5-axis CNC machining centres for an aerospace supply contract', amount: 650000, tenorMonths: 60, secured: true,
    collateralType: 'Financed equipment', collateralValue: 820000, yearsTrading: 11, bureauScore: 712, negativeDays90: 1, rm: 'Ravi Kumar', uen: '201512345K',
    financials: { revenue: 3480000, revenuePrior: 3150000, ebitda: 238000, existingDebt: 180000, existingDebtService: 36500 }, directors: 2 });
  // The demo script relies on a committee case, a decline review and a dual sign-off being in the queue.
  const want = [showcase];
  const take = (ok, profiles) => {
    for (;;) {
      const a = D.makeApplication(qr, { profile: D.pick(qr, profiles) });
      const ev = evaluate({ ...D.policyInput(a), documents: [...D.ALL_DOCS, 'valuation_report'] }, S.policy);
      if (ev.approval && ['L1', 'L2', 'L3'].includes(ev.approval.level) && ok(ev)) return want.push(a);
    }
  };
  take(ev => ev.approval.level === 'L3', ['clean']);
  take(ev => ev.decision === 'DECLINE', ['decline']);
  take(ev => ev.approval.level === 'L2' && ev.decision === 'APPROVE', ['clean']);
  while (want.length < 10) take(() => true, ['clean', 'clean', 'exception', 'exception', 'decline']);
  want.forEach((a, i) => {
    a.documents = [...D.ALL_DOCS, ...(a.secured ? ['valuation_report'] : [])];
    const created = now - (i === 0 ? 1.4 * H : (0.5 + qr() * 4.2) * H);
    Object.assign(a, { createdAt: created, steps: [], approvals: [], runs: [], guardrails: [] });
    const ev = evaluate(D.policyInput(a), S.policy);
    a.evaluation = ev; a.memo = D.memo(a, ev); a.stage = 'approval';
    a.enteredApprovalAt = created + (12 + qr() * 10) * MIN;
    const t = k => created + k * MIN, m = ev.metrics;
    a.steps = [
      { at: t(0), agent: 'supervisor', kind: 'info', text: `Application received from ${a.rm} (RM) · ${D.sgd(a.amount)} ${a.product.toLowerCase()}` },
      { at: t(1), agent: 'intake', kind: 'ok', tool: 'classify_documents', text: `Classified ${a.documents.length + 2} files: ${a.documents.map(d => D.DOC_NAMES[d]).join(', ')}` },
      { at: t(2), agent: 'intake', kind: 'ok', tool: 'extract_financials', text: `Extracted FY2024–FY2025 financials · revenue ${D.sgd(a.financials.revenue)}, EBITDA ${D.sgd(a.financials.ebitda)} · confidence 0.97` },
      { at: t(4), agent: 'kyb', kind: 'ok', tool: 'acra_lookup', text: `ACRA profile verified · UEN ${a.uen} · ${a.yearsTrading} years registered · ${a.directors} director${a.directors > 1 ? 's' : ''}` },
      { at: t(5), agent: 'kyb', kind: 'ok', tool: 'screen_sanctions_pep', text: `Screened company and ${a.directors} director${a.directors > 1 ? 's' : ''} · 0 sanctions or PEP matches` },
      { at: t(8), agent: 'analyst', kind: 'ok', tool: 'policy_engine.compute_metrics', text: `Spread financials · DSCR ${m.dscr.toFixed(2)}x at 7.5% stress · leverage ${m.leverage.toFixed(2)}x${m.ltv ? ` · LTV ${(m.ltv * 100).toFixed(0)}%` : ''} · revenue ${m.revenueGrowth >= 0 ? '+' : ''}${(m.revenueGrowth * 100).toFixed(1)}%` },
      { at: t(10), agent: 'analyst', kind: 'ok', tool: 'draft_credit_memo', text: `Credit memo drafted (${a.memo.split(/\s+/).length} words)` },
      { at: t(11), agent: 'engine', kind: ev.decision === 'DECLINE' ? 'warn' : 'ok', tool: 'evaluate_application', hash: ev.hash, text: `${ev.decision} · grade ${ev.grade} · ${ev.pricing.rate.toFixed(2)}% · ${ev.approval.label}${ev.exceptions.length ? ` · exception ${ev.exceptions.join(', ')}` : ev.declineReasons.length ? ` · ${ev.declineReasons.join(', ')}` : ''}` },
      { at: t(12), agent: 'supervisor', kind: 'route', text: `Routed to ${ev.approval.label} (${ev.approval.level}) · ${ev.approval.approvers === 2 ? 'two signatures' : 'one signature'} · SLA ${ev.approval.slaHours}h` },
    ];
    for (const [ag, ms, tok, tc] of [['supervisor', 900, 2500, 2], ['intake', 4500, 8000, 2], ['kyb', 3800, 5000, 3], ['analyst', 7500, 15000, 3], ['engine', 70, 0, 1]]) a.runs.push({ agent: ag, ms, tokens: tok, toolCalls: tc, ok: true, at: created });
    a.updatedAt = a.enteredApprovalAt;
    S.apps.set(a.id, a);
    audit(a.rm, 'application.submitted', a.id, `${D.sgd(a.amount)} ${a.product}`);
    audit('policy-engine', 'decision.evaluated', a.id, `${ev.decision} ${ev.approval.level} v${ev.policyVersion} #${ev.hash}`);
  });
  // One dual sign-off already carries Priya's first signature.
  const half = [...S.apps.values()].find(a => a.stage === 'approval' && a.evaluation.approval.level === 'L2' && a.evaluation.decision === 'APPROVE');
  if (half) {
    half.approvals.push({ userId: 'priya', by: 'Priya Nair', role: 'Credit Officer', action: 'approve', reason: 'Financials and security in order; within policy.', at: now - 25 * MIN });
    half.steps.push({ at: now - 25 * MIN, agent: 'supervisor', kind: 'human', text: 'Priya Nair signed (1 of 2) · waiting for a second, different approver' });
    audit('Priya Nair', 'approval.approve', half.id, 'L2: Financials and security in order; within policy.');
  }
}

// Keep the desk busy: new applications arrive every few seconds, and other officers clear
// the oldest one-signature items when the queue grows long.
function startSimulation() {
  const arrive = () => {
    const inflight = [...S.apps.values()].filter(a => a.live && ['intake', 'documents', 'kyb', 'analysis', 'policy'].includes(a.stage)).length;
    if (inflight < 6) runLive(newLiveApp());
    setTimeout(arrive, 7000 + r() * 6000);
  };
  setTimeout(arrive, 1500);
  setInterval(() => {
    const q = [...S.apps.values()].filter(a => a.stage === 'approval');
    if (q.length <= 14) return;
    const oldest = q.filter(a => a.evaluation.approval.level === 'L1' && a.approvals.length === 0).sort((x, y) => x.enteredApprovalAt - y.enteredApprovalAt)[0];
    if (!oldest) return;
    const action = oldest.evaluation.decision === 'DECLINE' ? 'decline' : 'approve';
    oldest.approvals.push({ userId: 'other', by: 'Wei Jie Tan', role: 'Credit Officer (Desk 2)', action, reason: 'Within policy.', at: Date.now() });
    audit('Wei Jie Tan', `approval.${action}`, oldest.id, 'L1: Within policy.');
    step(oldest, 'supervisor', `Wei Jie Tan (Desk 2) ${action === 'approve' ? 'approved' : 'confirmed the decline'}`, 'human');
    close(oldest, action === 'approve' ? 'approved' : 'declined', 'human');
  }, 20000);
}

// ---------- metrics ----------
const sgDay = t => new Date(t + 8 * H).toISOString().slice(0, 10);
function median(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function metrics() {
  const now = Date.now(), all = [...S.apps.values()], today = sgDay(now);
  const decided = all.filter(a => a.final);
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(sgDay(now - i * 24 * H));
  const daily = days.map(d => {
    const xs = decided.filter(a => sgDay(a.final.at) === d);
    return { day: d, auto: xs.filter(a => a.final.by === 'automation' && a.final.outcome === 'approved').length,
      human: xs.filter(a => a.final.by === 'human' && a.final.outcome === 'approved').length,
      declined: xs.filter(a => a.final.outcome === 'declined').length };
  });
  const human = decided.filter(a => a.final.by === 'human');
  const queue = all.filter(a => a.stage === 'approval');
  const slaState = a => { const due = a.enteredApprovalAt + a.evaluation.approval.slaHours * H; return now > due ? 'breached' : now > due - 0.25 * a.evaluation.approval.slaHours * H ? 'at_risk' : 'ok'; };
  const levels = ['STP', 'AUTO_DECLINE', 'L1', 'L2', 'L3'];
  const ttd = levels.map(l => {
    const xs = decided.filter(a => a.evaluation.approval.level === l).map(a => (a.final.at - a.createdAt) / H);
    return { level: l, label: { STP: 'Straight-through', AUTO_DECLINE: 'Auto-decline', L1: 'Credit Officer', L2: 'Dual sign-off', L3: 'Committee' }[l], medianHours: median(xs), n: xs.length };
  });
  const evaluated = all.filter(a => a.evaluation);
  const ruleHits = {};
  for (const a of evaluated) for (const t of a.evaluation.trace) {
    if (t.result !== 'exception' && t.result !== 'fail') continue;
    ruleHits[t.id] = ruleHits[t.id] || { id: t.id, name: t.name, clause: t.clause, exception: 0, fail: 0 };
    ruleHits[t.id][t.result]++;
  }
  const runs = all.flatMap(a => a.runs);
  const agents = AGENTS.map(ag => {
    const rs = runs.filter(x => x.agent === ag.id);
    return { ...ag, version: ag.id === 'engine' ? S.policy.version : ag.version, runs: rs.length, success: rs.length ? rs.filter(x => x.ok).length / rs.length : null,
      p50ms: median(rs.map(x => x.ms)), tokens: rs.reduce((s, x) => s + x.tokens, 0), toolCalls: rs.reduce((s, x) => s + x.toolCalls, 0),
      guardrails: ag.id === 'analyst' ? all.reduce((s, a) => s + a.guardrails.filter(g => g.type === 'memo_prohibited_attribute').length, 0)
        : ag.id === 'engine' ? all.reduce((s, a) => s + a.guardrails.filter(g => g.type === 'prohibited_attribute').length, 0) : 0 };
  });
  const tokens = runs.reduce((s, x) => s + x.tokens, 0);
  const pipeline = ['intake', 'documents', 'kyb', 'analysis', 'policy', 'approval'].map(s => ({ stage: s, n: all.filter(a => a.stage === s).length }));
  return {
    now, policyVersion: S.policy.version,
    kpi: {
      submittedToday: all.filter(a => sgDay(a.createdAt) === today).length,
      decided14: decided.length,
      stpRate: decided.filter(a => a.final.by === 'automation').length / decided.length,
      medianHoursToDecision: median(decided.map(a => (a.final.at - a.createdAt) / H)),
      queue: queue.length, slaAtRisk: queue.filter(a => slaState(a) === 'at_risk').length, slaBreached: queue.filter(a => slaState(a) === 'breached').length,
      overrideRate: human.length ? human.filter(a => a.final.override).length / human.length : 0, overrides: human.filter(a => a.final.override).length,
      exceptionRate: evaluated.filter(a => a.evaluation.decision === 'REFER').length / evaluated.length,
      exceptionApprovedRate: (() => { const xs = human.filter(a => a.evaluation.decision === 'REFER'); return xs.length ? xs.filter(a => a.final.outcome === 'approved').length / xs.length : 0; })(),
      guardrails: all.reduce((s, a) => s + a.guardrails.length, 0),
      costPerApp: (tokens / 1e6) * 2.0 / Math.max(1, all.filter(a => a.runs.length).length),
      approvedValue: decided.filter(a => a.final.outcome === 'approved').reduce((s, a) => s + a.amount, 0),
    },
    daily, ttd, pipeline, ruleHits: Object.values(ruleHits).sort((x, y) => (y.exception + y.fail) - (x.exception + x.fail)), agents,
    queueSla: queue.map(a => ({ id: a.id, state: slaState(a) })),
  };
}

function listApps() {
  const now = Date.now();
  return [...S.apps.values()].filter(a => !a.history || now - (a.final ? a.final.at : a.createdAt) < 10 * H)
    .map(summary).sort((x, y) => y.createdAt - x.createdAt);
}
function getApp(id) {
  const a = S.apps.get(id);
  if (!a) return null;
  const { runs, guardrailMemo, live, profile, ...rest } = a;
  return { ...rest, summary: summary(a), audit: S.audit.filter(e => e.appId === id) };
}

seedHistory();
seedQueue();
S.activity = [...S.apps.values()].filter(a => !a.history).flatMap(a => a.steps.map(st => ({ appId: a.id, company: a.company, ...st })))
  .sort((x, y) => y.at - x.at).slice(0, 40);
AGENTS.find(a => a.id === 'engine').version = S.policy.version;

module.exports = { S, USERS, AGENTS, startSimulation, listApps, getApp, decideApp, metrics, simulate, submitChange, reviewChange,
  policyState, verifyAudit, runGolden: () => runGolden(S.policy), evaluate: input => evaluate(input, S.policy) };

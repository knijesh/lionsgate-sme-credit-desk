// Lionsgate Bank policy engine: a deterministic decision service over a versioned policy pack.
// Agents gather and explain evidence; only this engine decides. Every call returns the full rule
// trace, the risk grade, the price and the approval level the authority matrix requires.
const crypto = require('crypto');

const OPS = {
  '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '==': (a, b) => a === b,
  in: (a, b) => b.includes(a), notIn: (a, b) => !b.includes(a),
};

// Annual repayment on an amortising loan at the policy stress rate.
function annualService(amount, rate, months) {
  const r = rate / 12;
  return (amount * r / (1 - Math.pow(1 + r, -months))) * 12;
}

// Deterministic spreading: ratios from the financials the Credit Analyst agent extracted.
function computeMetrics(input, policy) {
  const f = input.financials || {};
  const newService = annualService(input.amount, policy.stressRate, input.tenorMonths || 60);
  const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    dscr: round(f.ebitda / ((f.existingDebtService || 0) + newService)),
    leverage: round(((f.existingDebt || 0) + input.amount) / f.ebitda),
    ltv: input.secured && input.collateralValue ? round(input.amount / input.collateralValue, 3) : null,
    revenueGrowth: f.revenuePrior ? round(f.revenue / f.revenuePrior - 1, 3) : 0,
  };
}

// Bands run best first; the first band the value reaches gives its risk points.
function points({ better, bands }, v) {
  for (const [limit, p] of bands) {
    if (limit === null || (better === 'higher' ? v >= limit : v <= limit)) return p;
  }
  return 0;
}

function grade(facts, policy) {
  const p = policy.grading.reduce((s, g) => s + points(g, facts[g.field]), 0);
  const max = policy.grading.reduce((s, g) => s + g.bands[g.bands.length - 1][1], 0);
  return { points: p, grade: Math.min(10, Math.max(1, 1 + Math.round(p * 9 / max))) };
}

// Screening facts must be stated explicitly: a missing sanctions result is neither a pass nor a fail.
const REQUIRED = ['amount', 'yearsTrading', 'industry', 'bureauScore', 'negativeDays90', 'sanctionsHit', 'bankruptcy'];

function evaluate(raw, policy) {
  const missing = REQUIRED.filter(k => raw[k] === undefined || raw[k] === null);
  if (!raw.metrics && !(raw.financials && raw.financials.ebitda)) missing.push('financials.ebitda');
  if (missing.length) throw Object.assign(new Error(`Missing required inputs: ${missing.join(', ')}`), { status: 400 });
  const guardrails = [];
  const input = { ...raw };
  for (const k of policy.prohibitedInputs) {
    if (k in input) {
      delete input[k];
      guardrails.push({ id: 'G1', clause: 'CP-1.3', type: 'prohibited_attribute', field: k,
        text: `Prohibited attribute "${k}" was supplied and ignored` });
    }
  }
  const metrics = input.metrics || computeMetrics(input, policy);
  const facts = { ...input, ...metrics };
  const trace = [];

  for (const r of policy.knockouts) {
    const ok = OPS[r.op](facts[r.field], r.value);
    trace.push({ id: r.id, clause: r.clause, name: r.name, kind: 'knockout', field: r.field,
      actual: facts[r.field], threshold: r.value, op: r.op, unit: r.unit, result: ok ? 'pass' : 'fail' });
  }
  for (const r of policy.credit) {
    if (r.when === 'secured' && !facts.secured) {
      trace.push({ id: r.id, clause: r.clause, name: r.name, kind: 'credit', field: r.field, result: 'n/a' });
      continue;
    }
    const v = facts[r.field];
    const result = OPS[r.op](v, r.value) ? 'pass' : OPS[r.op](v, r.exception) ? 'exception' : 'fail';
    trace.push({ id: r.id, clause: r.clause, name: r.name, kind: 'credit', field: r.field, actual: v,
      threshold: r.value, exceptionLimit: r.exception, op: r.op, unit: r.unit, result });
  }

  const required = [...policy.documents.always, ...(facts.secured ? policy.documents.secured : [])];
  const received = new Set(input.documents || []);
  const missingDocs = required.filter(d => !received.has(d));
  const knockedOut = trace.filter(t => t.kind === 'knockout' && t.result === 'fail');
  const failed = trace.filter(t => t.kind === 'credit' && t.result === 'fail');
  const exceptions = trace.filter(t => t.result === 'exception');
  const { grade: g, points: pts } = grade(facts, policy);

  let decision, approval = null;
  if (knockedOut.length) {
    decision = 'DECLINE';
    approval = { level: 'AUTO_DECLINE', label: 'Automated decline', approvers: 0, slaHours: 0 };
  } else if (missingDocs.length) {
    decision = 'PENDING_DOCUMENTS';
  } else if (failed.length) {
    decision = 'DECLINE';
    approval = { ...policy.declineReview };
  } else {
    decision = exceptions.length ? 'REFER' : 'APPROVE';
    const a = policy.authority.find(l => (l.maxAmount === null || facts.amount <= l.maxAmount)
      && g <= l.maxGrade && exceptions.length <= l.maxExceptions);
    approval = { level: a.level, label: a.label, approvers: a.approvers, slaHours: a.slaHours };
  }

  const pr = policy.pricing;
  const rate = pr.baseRate + pr.spreadByGrade[g - 1] - (facts.secured ? pr.securedDiscount : 0);
  const result = {
    policyId: policy.id, policyVersion: policy.version, decision, approval, grade: g, gradePoints: pts,
    pricing: { baseRate: pr.baseRate, spread: pr.spreadByGrade[g - 1], rate: Math.round(rate * 100) / 100 },
    metrics, exceptions: exceptions.map(e => e.id), declineReasons: [...knockedOut, ...failed].map(e => e.id),
    missingDocs, guardrails, trace,
  };
  result.hash = crypto.createHash('sha256').update(JSON.stringify([raw, policy.version, decision, g])).digest('hex').slice(0, 16);
  return result;
}

module.exports = { evaluate, computeMetrics, annualService };

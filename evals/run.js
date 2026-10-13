// Runs the golden set against a policy pack. Used by the console (/api/evals/policy) and from the
// command line as a CI gate: `node evals/run.js [policy.json]` exits 1 when any case fails.
const path = require('path');
const { evaluate } = require('../policy/engine');
const golden = require('./golden.json');

function runGolden(policy) {
  const results = golden.cases.map(c => {
    const out = evaluate({ ...golden.defaults, ...c.input }, policy);
    const got = { decision: out.decision, level: out.approval ? out.approval.level : null };
    const checks = [got.decision === c.expect.decision, got.level === c.expect.level];
    if (c.expect.guardrail) checks.push(out.guardrails.some(g => g.type === c.expect.guardrail));
    return { id: c.id, name: c.name, expect: c.expect, got, grade: out.grade, pass: checks.every(Boolean) };
  });
  const passed = results.filter(r => r.pass).length;
  return { policyVersion: policy.version, total: results.length, passed, passRate: passed / results.length, results };
}

module.exports = { runGolden };

if (require.main === module) {
  const policy = require(path.resolve(process.argv[2] || path.join(__dirname, '../policy/policy.json')));
  const r = runGolden(policy);
  for (const x of r.results) {
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.id}  ${x.name.padEnd(42)} expected ${x.expect.decision}/${x.expect.level}  got ${x.got.decision}/${x.got.level}  (grade ${x.grade})`);
  }
  console.log(`\n${r.passed}/${r.total} passed on policy ${r.policyVersion}`);
  process.exit(r.passed === r.total ? 0 : 1);
}

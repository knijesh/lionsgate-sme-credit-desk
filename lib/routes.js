// The desk's API, shared by the Node server and the static (in-browser) build.
// Each route: [method, pattern, handler(match, body)].
const desk = require('./desk');
const agentResults = require('../evals/agent-results.json');

const notFound = () => { throw Object.assign(new Error('Not found'), { status: 404 }); };

module.exports = [
  ['GET', /^\/api\/applications$/, () => desk.listApps()],
  ['GET', /^\/api\/applications\/([\w-]+)$/, m => desk.getApp(m[1]) || notFound()],
  ['POST', /^\/api\/applications\/([\w-]+)\/decision$/, (m, b) => desk.decideApp(m[1], b.user, b.action, b.reason, b.conditions)],
  ['GET', /^\/api\/metrics$/, () => desk.metrics()],
  ['GET', /^\/api\/users$/, () => desk.USERS],
  ['GET', /^\/api\/activity$/, () => desk.S.activity],
  ['GET', /^\/api\/policy$/, () => desk.policyState()],
  ['POST', /^\/api\/policy\/evaluate$/, (m, b) => desk.evaluate(b)],
  ['POST', /^\/api\/policy\/simulate$/, (m, b) => desk.simulate(b.edits || {})],
  ['POST', /^\/api\/policy\/changes$/, (m, b) => desk.submitChange(b.user, b.edits || {}, b.rationale)],
  ['POST', /^\/api\/policy\/changes\/([\w-]+)\/review$/, (m, b) => desk.reviewChange(m[1], b.user, b.action, b.note)],
  ['GET', /^\/api\/evals$/, () => ({ golden: desk.runGolden(), agents: agentResults })],
  ['GET', /^\/api\/audit$/, () => ({ verify: desk.verifyAudit(), entries: desk.S.audit.slice(-300).reverse() })],
];

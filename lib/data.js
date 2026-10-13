// Demo data: SME applicants, financials consistent with the policy engine's spreading, agent
// run statistics and credit memos. Seeded so every restart tells the same story.
const { annualService } = require('../policy/engine');

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLACES = ['Tanjong', 'Bukit Timah', 'Kallang', 'Serangoon', 'Jurong', 'Changi', 'Tiong Bahru', 'Katong', 'Pasir Panjang',
  'Novena', 'Telok Ayer', 'Ang Mo Kio', 'Tampines', 'Woodlands', 'Bedok', 'Clementi', 'Kranji', 'Loyang', 'Sembawang', 'Bishan',
  'Ubi', 'Kaki Bukit', 'Tuas', 'Paya Lebar', 'Bugis', 'Keppel', 'Rochor', 'Toa Payoh', 'Holland', 'Seletar'];
const TRADES = [
  ['Precision Engineering', 'Manufacturing', 'Equipment financing', 'two 5-axis CNC machining centres'],
  ['Coffee Roasters', 'Food & beverage', 'Term loan', 'a second roastery and café fit-out'],
  ['Logistics', 'Transport & logistics', 'Equipment financing', 'four refrigerated delivery trucks'],
  ['Dental Group', 'Healthcare', 'Term loan', 'a new clinic in a suburban mall'],
  ['Fresh Foods', 'Wholesale trade', 'Trade financing', 'import letters of credit for produce'],
  ['Print Works', 'Manufacturing', 'Equipment financing', 'a large-format digital press'],
  ['Interior Studio', 'Construction', 'Working capital line', 'project working capital'],
  ['Marine Supplies', 'Wholesale trade', 'Trade financing', 'inventory for ship chandlery contracts'],
  ['Electrical Contractors', 'Construction', 'Working capital line', 'contract mobilisation costs'],
  ['Bakehouse', 'Food & beverage', 'Term loan', 'central kitchen expansion'],
  ['Medical Supplies', 'Wholesale trade', 'Working capital line', 'hospital tender inventory'],
  ['Software Studio', 'Information & communications', 'Working capital line', 'hiring ahead of a government contract'],
  ['Cold Chain', 'Transport & logistics', 'Term loan', 'a cold-room warehouse retrofit'],
  ['Packaging', 'Manufacturing', 'Equipment financing', 'an automated carton line'],
  ['Learning Centre', 'Education', 'Term loan', 'two new campuses'],
  ['Auto Workshop', 'Automotive services', 'Equipment financing', 'EV diagnostic and lift equipment'],
  ['Furniture', 'Retail trade', 'Working capital line', 'seasonal stock'],
  ['Aquaculture', 'Agriculture', 'Term loan', 'recirculating fish-farm tanks'],
];
const RMS = ['Ravi Kumar', 'Siti Aminah', 'Jonathan Teo', 'Grace Chua'];
const EXCLUDED = ['Gambling', 'Crypto exchange'];

const USED = new Set();
const pick = (r, a) => a[Math.floor(r() * a.length)];
const between = (r, lo, hi) => lo + r() * (hi - lo);
const roundTo = (v, n) => Math.round(v / n) * n;

let seq = 10400;
const nextId = () => `LN-26-${++seq}`;

// profile: stp | clean | exception | decline | knockout
function makeApplication(r, opts = {}) {
  const profile = opts.profile || (() => {
    const x = r();
    return x < 0.3 ? 'stp' : x < 0.62 ? 'clean' : x < 0.82 ? 'exception' : x < 0.93 ? 'decline' : 'knockout';
  })();
  const [trade, industry, product, purpose] = pick(r, TRADES);
  let company = `${pick(r, PLACES)} ${trade} Pte Ltd`;
  for (let i = 0; USED.has(company) && i < 20; i++) company = `${pick(r, PLACES)} ${trade} Pte Ltd`;
  USED.add(company);
  const amount = profile === 'stp' ? roundTo(between(r, 30000, 100000), 5000)
    : r() < 0.55 ? roundTo(between(r, 100000, 250000), 5000) : r() < 0.8 ? roundTo(between(r, 250000, 1000000), 25000) : roundTo(between(r, 1000000, 2500000), 50000);
  const tenorMonths = pick(r, product === 'Working capital line' || product === 'Trade financing' ? [12, 24, 36] : [36, 48, 60, 84]);
  const secured = product === 'Equipment financing' || (amount > 500000 && r() < 0.6);

  let dscr = between(r, 1.45, 2.6), bureauScore = Math.round(between(r, 690, 800)), negativeDays90 = Math.floor(between(r, 0, 4));
  let growth = between(r, -0.04, 0.16), yearsTrading = Math.round(between(r, 4, 24)), ltvT = between(r, 0.5, 0.78), debtShare = between(r, 0, 1.2);
  if (profile === 'stp') { dscr = between(r, 1.9, 3); bureauScore = Math.round(between(r, 745, 810)); negativeDays90 = 0; yearsTrading = Math.round(between(r, 8, 25)); debtShare = between(r, 0, 0.6); }
  const flags = { sanctionsHit: false, bankruptcy: false };
  let ind = industry;
  if (profile === 'exception') {
    const which = pick(r, ['dscr', 'dscr', 'bureau', 'ltv', 'growth', 'neg']);
    if (which === 'dscr') dscr = between(r, 1.12, 1.24);
    if (which === 'bureau') bureauScore = Math.round(between(r, 585, 618));
    if (which === 'ltv' && secured) ltvT = between(r, 0.82, 0.89); else if (which === 'ltv') dscr = between(r, 1.12, 1.24);
    if (which === 'growth') growth = between(r, -0.24, -0.16);
    if (which === 'neg') negativeDays90 = Math.round(between(r, 6, 10));
  }
  if (profile === 'decline') {
    const which = pick(r, ['dscr', 'dscr', 'bureau', 'neg']);
    if (which === 'dscr') dscr = between(r, 0.75, 1.08);
    if (which === 'bureau') bureauScore = Math.round(between(r, 520, 575));
    if (which === 'neg') negativeDays90 = Math.round(between(r, 12, 30));
  }
  if (profile === 'knockout') {
    const which = pick(r, ['young', 'sanctions', 'industry', 'young']);
    if (which === 'young') yearsTrading = 1;
    if (which === 'sanctions') flags.sanctionsHit = true;
    if (which === 'industry') ind = pick(r, EXCLUDED);
  }

  // Back-solve financials so the engine's own spreading lands on the profile's ratios.
  const existingDebt = roundTo(amount * debtShare, 1000);
  const existingDebtService = Math.round(existingDebt ? annualService(existingDebt, 0.065, 84) : 0);
  const newService = annualService(amount, 0.075, tenorMonths);
  const ebitda = Math.round(dscr * (existingDebtService + newService));
  const revenue = roundTo(ebitda / between(r, 0.09, 0.2), 1000);
  const revenuePrior = roundTo(revenue / (1 + growth), 1000);

  return {
    id: opts.id || nextId(), company, uen: `${2026 - yearsTrading}${String(Math.floor(r() * 90000) + 10000)}${pick(r, ['K', 'D', 'H', 'W', 'R'])}`,
    industry: ind, product, purpose, rm: pick(r, RMS), amount, tenorMonths, secured,
    collateralType: secured ? (product === 'Equipment financing' ? 'Financed equipment' : 'Commercial property') : null,
    collateralValue: secured ? roundTo(amount / ltvT, 5000) : null,
    yearsTrading, bureauScore, negativeDays90, ...flags,
    financials: { revenue, revenuePrior, ebitda, existingDebt, existingDebtService },
    directors: 1 + Math.floor(r() * 3), profile,
  };
}

const ALL_DOCS = ['financials_2y', 'bank_statements_6m', 'acra_profile', 'director_ids'];
const DOC_NAMES = { financials_2y: 'audited financials (2 yrs)', bank_statements_6m: '6-month bank statements', acra_profile: 'ACRA business profile',
  director_ids: 'director IDs', valuation_report: 'collateral valuation report' };

function policyInput(app) {
  const keys = ['amount', 'tenorMonths', 'secured', 'collateralValue', 'industry', 'yearsTrading', 'bureauScore', 'negativeDays90',
    'sanctionsHit', 'bankruptcy', 'financials', 'documents'];
  const o = Object.fromEntries(keys.map(k => [k, app[k]]));
  return { ...o, ...(app.extraInputs || {}) };
}

const sgd = n => 'S$' + Math.round(n).toLocaleString('en-SG');

function memo(app, ev) {
  const m = ev.metrics, short = app.company.replace(' Pte Ltd', '');
  const exc = ev.trace.filter(t => t.result === 'exception'), fail = ev.trace.filter(t => t.result === 'fail');
  const fmt = t => t.unit === '%' ? `${(t.actual * 100).toFixed(1)}%` : t.unit === 'x' ? `${t.actual.toFixed(2)}x` : t.actual;
  const lim = (t, v) => t.unit === '%' ? `${(v * 100).toFixed(0)}%` : t.unit === 'x' ? `${v.toFixed(2)}x` : v;
  const nm = t => t.name.replace(/ \(.*\)/, '').replace(/^\w/, c => c.toLowerCase()).replace('debt service coverage', 'debt service coverage (DSCR)');
  const p = [];
  p.push(`${short} (UEN ${app.uen}, ${app.industry.toLowerCase()}, trading ${app.yearsTrading} years) requests ${sgd(app.amount)} ${app.product.toLowerCase()} over ${app.tenorMonths} months to fund ${app.purpose}.`);
  p.push(`Revenue was ${sgd(app.financials.revenue)} (${m.revenueGrowth >= 0 ? 'up' : 'down'} ${Math.abs(m.revenueGrowth * 100).toFixed(1)}% year on year) with EBITDA of ${sgd(app.financials.ebitda)}. Stressed at 7.5%, debt service coverage is ${m.dscr.toFixed(2)}x and leverage after the new facility is ${m.leverage.toFixed(2)}x.${m.ltv ? ` Loan to value against ${app.collateralType.toLowerCase()} is ${(m.ltv * 100).toFixed(0)}%.` : ''} Bureau score ${app.bureauScore}; ${app.negativeDays90} negative-balance days in the last 90.`);
  if (fail.length) p.push(`Outside policy: ${fail.map(t => `${nm(t)} at ${fmt(t)} is beyond the exception limit of ${lim(t, t.exceptionLimit)} (${t.clause})`).join('; ')}.`);
  if (exc.length) p.push(`Policy exception: ${exc.map(t => `${nm(t)} at ${fmt(t)} is below the ${lim(t, t.threshold)} standard but within the ${lim(t, t.exceptionLimit)} exception limit (${t.clause})`).join('; ')}. Mitigants: ${app.secured ? 'the facility is secured' : 'a personal guarantee from the directors is proposed'}, and the company has ${app.yearsTrading} years of trading with no arrears on existing facilities.`);
  const rec = { APPROVE: `Recommend approval at ${ev.pricing.rate.toFixed(2)}% (grade ${ev.grade}).`, REFER: `Recommend approval with exception at ${ev.pricing.rate.toFixed(2)}% (grade ${ev.grade}), subject to quarterly management accounts and a DSCR covenant of 1.15x.`,
    DECLINE: 'Recommend decline; the customer may reapply with a smaller amount or additional security.' }[ev.decision];
  if (rec) p.push(rec);
  return p.join('\n\n');
}

module.exports = { rng, makeApplication, policyInput, memo, ALL_DOCS, DOC_NAMES, sgd, between, pick };

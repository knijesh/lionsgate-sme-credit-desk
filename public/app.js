// Lionsgate Bank SME Credit Desk console. Plain JS: views render to #view, live updates arrive
// over /api/stream (server-sent events).
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sgd = n => 'S$' + Math.round(n).toLocaleString('en-SG');
const sgdK = n => n >= 1e6 ? `S$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `S$${Math.round(n / 1e3)}k` : sgd(n);
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const hrs = h => h == null ? '–' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
const hm = t => new Date(t).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
const hms = t => new Date(t).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour12: false });
const ago = t => { const m = (Date.now() - t) / 60000; return m < 1 ? 'just now' : m < 60 ? `${Math.round(m)} min ago` : m < 48 * 60 ? `${(m / 60).toFixed(1)} h ago` : `${Math.round(m / 1440)} d ago`; };
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

const S = { view: 'overview', user: store.get('lgb.user', 'priya'), users: {}, apps: new Map(), metrics: null, policy: null, evals: null,
  audit: null, feed: [], fresh: new Set(), drawer: null, filter: 'mine', edits: { rules: {}, authority: {} }, sim: null, simErr: '', crErr: '' };

const AG = { supervisor: 'Supervisor', intake: 'Document Intake', kyb: 'KYB & Screening', analyst: 'Credit Analyst', comms: 'Customer Comms', engine: 'Policy Engine' };
const DEC = { APPROVE: 'Approve', REFER: 'Refer · exception', DECLINE: 'Decline', PENDING_DOCUMENTS: 'Waiting for documents' };
const SIGN = { L1: ['credit_officer', 'senior_credit_manager', 'credit_committee'], L2: ['credit_officer', 'senior_credit_manager', 'credit_committee'], L3: ['credit_committee'] };
const SENIOR = ['senior_credit_manager', 'credit_committee'];
const OP = { '>=': '≥', '<=': '≤', '==': '=', notIn: 'not in', in: 'in' };

// Static build (GitHub Pages): the desk runs in this browser via desk.bundle.js instead of the server.
const LOCAL = window.LocalDesk;
async function api(path, body) {
  if (LOCAL) return LOCAL.call(body ? 'POST' : 'GET', path, body);
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3200); }

// ---------- signing rules (mirrors the server; the server is the authority) ----------
function signState(a, user = S.users[S.user]) {
  const d = a.decision; if (!d || a.stage !== 'approval') return { can: false, why: 'Not waiting for approval' };
  if (!user) return { can: false, why: '' };
  if (!SIGN[d.level] || !SIGN[d.level].includes(user.role)) return { can: false, why: `${user.title} has no ${d.label} authority` };
  if (a.approvals.some(x => x.by === user.name)) return { can: false, why: 'You already signed · a different approver must sign' };
  const need = d.level === 'L2' ? 2 : 1;
  if (need === 2 && a.approvals.length === 1 && !SENIOR.includes(user.role)) {
    const first = Object.values(S.users).find(u => u.name === a.approvals[0].by);
    if (!first || !SENIOR.includes(first.role)) return { can: false, why: 'Second signature must be a Senior Credit Manager' };
  }
  return { can: true, why: '' };
}
const needSigs = a => (a.decision && a.decision.level === 'L2') ? 2 : 1;
function sla(a) {
  const total = a.decision.slaHours * 3600e3, used = Date.now() - a.enteredApprovalAt, f = used / total;
  return { f, state: f > 1 ? 'breached' : f > 0.75 ? 'at_risk' : 'ok', left: (total - used) / 3600e3 };
}

// ---------- tooltip ----------
document.addEventListener('mousemove', e => {
  const el = e.target.closest('[data-tip]'), tip = $('tip');
  if (!el) { tip.classList.remove('on'); return; }
  tip.innerHTML = el.getAttribute('data-tip'); tip.classList.add('on');
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(innerWidth - w - 8, e.clientX + 14) + 'px';
  tip.style.top = (e.clientY + h + 24 > innerHeight ? e.clientY - h - 12 : e.clientY + 16) + 'px';
});

// ---------- charts (inline SVG) ----------
const topRound = (x, y, w, h, r) => { r = Math.min(r, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
const rightRound = (x, y, w, h, r) => { r = Math.min(r, w, h / 2); return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; };
function niceMax(v) { const p = 10 ** Math.floor(Math.log10(Math.max(1, v))); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1) || 1; }

function stackedColumns(rows, series) {
  const W = 760, Hh = 230, L = 34, B = 26, T = 14, R = 8, n = rows.length;
  const tot = rows.map(r => series.reduce((s, x) => s + r[x.key], 0)), max = niceMax(Math.max(...tot) * 1.1);
  const bw = (W - L - R) / n, w = Math.max(6, bw * 0.62), y = v => T + (Hh - T - B) * (1 - v / max);
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = max * i / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`; }
  rows.forEach((r, i) => {
    const x = L + i * bw + (bw - w) / 2; let base = 0, marks = '';
    const live = series.filter(s => r[s.key] > 0);
    live.forEach((s, j) => {
      const v = r[s.key], y0 = y(base + v), hgt = y(base) - y(base + v) - (j > 0 ? 2 : 0);
      marks += j === live.length - 1 ? `<path class="mk" d="${topRound(x, y0, w, Math.max(0, hgt), 4)}" fill="${s.color}"/>` : `<rect class="mk" x="${x}" y="${y0}" width="${w}" height="${Math.max(0, hgt)}" fill="${s.color}"/>`;
      base += v;
    });
    const d = new Date(r.day + 'T00:00:00+08:00'), lab = d.toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', timeZone: 'Asia/Singapore' });
    const tip = `<b>${esc(lab)}</b><br>` + series.map(s => `<i style="background:${s.color}"></i>${s.label}: ${r[s.key]}`).join('<br>') + `<br>Total: ${tot[i]}`;
    g += `<g class="bar" data-tip="${esc(tip)}"><rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${Hh - T - B}"/>${marks}</g>`;
    if (i % 2 === (n - 1) % 2) g += `<text x="${x + w / 2}" y="${Hh - 8}" text-anchor="middle">${esc(lab)}</text>`;
    if (i === n - 1) g += `<text class="val" x="${x + w / 2}" y="${y(tot[i]) - 6}" text-anchor="middle">${tot[i]}</text>`;
  });
  g += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)"/>`;
  return `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div><div class="viz"><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Decisions per day">${g}</svg></div>`;
}

function hBars(items, { color = 'var(--navy)', fmt = v => v, labelW = 120, W = 420 } = {}) {
  const rowH = 30, Hh = items.length * rowH + 4, max = Math.max(1, ...items.map(i => i.value)), R = 56, x = v => labelW + (W - labelW - R) * v / max;
  let g = '';
  items.forEach((it, i) => {
    const y = i * rowH + 6, h = 16;
    g += `<g class="bar" data-tip="${esc(it.tip || `<b>${esc(it.label)}</b><br>${fmt(it.value)}`)}"><rect class="hit" x="0" y="${y - 6}" width="${W}" height="${rowH}"/>`
      + `<text class="lbl" x="${labelW - 10}" y="${y + 12}" text-anchor="end">${esc(it.label)}</text>`
      + (it.value > 0 ? `<path class="mk" d="${rightRound(labelW, y, Math.max(2, x(it.value) - labelW), h, 4)}" fill="${it.color || color}"/>` : '')
      + `<text class="val" x="${x(it.value) + 6}" y="${y + 12}">${fmt(it.value)}</text></g>`;
  });
  g += `<line x1="${labelW}" x2="${labelW}" y1="0" y2="${Hh}" stroke="var(--axis)"/>`;
  return `<div class="viz"><svg viewBox="0 0 ${W} ${Hh}" role="img">${g}</svg></div>`;
}

function hStack(items, series, { labelW = 170, W = 440 } = {}) {
  const rowH = 30, Hh = items.length * rowH + 4, R = 34;
  const max = Math.max(1, ...items.map(i => series.reduce((s, x) => s + i[x.key], 0))), sx = v => (W - labelW - R) * v / max;
  let g = '';
  items.forEach((it, i) => {
    const y = i * rowH + 6, h = 16; let x = labelW, marks = '';
    const live = series.filter(s => it[s.key] > 0), total = series.reduce((s, k) => s + it[k.key], 0);
    live.forEach((s, j) => {
      const w = sx(it[s.key]) - (j > 0 ? 2 : 0), x0 = x + (j > 0 ? 2 : 0);
      marks += j === live.length - 1 ? `<path class="mk" d="${rightRound(x0, y, Math.max(1, w), h, 4)}" fill="${s.color}"/>` : `<rect class="mk" x="${x0}" y="${y}" width="${Math.max(1, w)}" height="${h}" fill="${s.color}"/>`;
      x = x0 + w;
    });
    const tip = `<b>${esc(it.id)} · ${esc(it.name)}</b><br>${esc(it.clause)}<br>` + series.map(s => `<i style="background:${s.color}"></i>${s.label}: ${it[s.key]}`).join('<br>');
    g += `<g class="bar" data-tip="${esc(tip)}"><rect class="hit" x="0" y="${y - 6}" width="${W}" height="${rowH}"/><text class="lbl" x="${labelW - 10}" y="${y + 12}" text-anchor="end">${esc(it.id)} ${esc(it.name.replace(/ \(.*\)/, ''))}</text>${marks}<text class="val" x="${x + 6}" y="${y + 12}">${total}</text></g>`;
  });
  g += `<line x1="${labelW}" x2="${labelW}" y1="0" y2="${Hh}" stroke="var(--axis)"/>`;
  return `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div><div class="viz"><svg viewBox="0 0 ${W} ${Hh}" role="img">${g}</svg></div>`;
}

function spark(vals, labels) {
  const W = 120, Hh = 30, P = 4, lo = Math.min(...vals) - 0.02, hi = Math.max(...vals) + 0.01;
  const pts = vals.map((v, i) => [P + (W - 2 * P) * i / Math.max(1, vals.length - 1), Hh - P - (Hh - 2 * P) * (v - lo) / (hi - lo)]);
  const tip = labels.map((l, i) => `${esc(l)}: ${pct(vals[i])}`).join('<br>');
  const [lx, ly] = pts[pts.length - 1];
  return `<span class="viz" data-tip="<b>Journey success by version</b><br>${esc(tip)}" style="display:inline-block;width:${W}px"><svg viewBox="0 0 ${W} ${Hh}"><polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--navy)" stroke-width="2" stroke-linejoin="round"/><circle cx="${lx}" cy="${ly}" r="4" fill="var(--navy)" stroke="#fff" stroke-width="2"/></svg></span>`;
}

// ---------- views ----------
const V = {};

V.overview = () => {
  const m = S.metrics; if (!m) return '<div class="empty">Loading…</div>';
  const k = m.kpi;
  const tile = (l, v, s) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const slaTxt = k.slaBreached || k.slaAtRisk ? `${k.slaBreached ? `<span class="bad">${k.slaBreached} past SLA</span>` : ''}${k.slaBreached && k.slaAtRisk ? ' · ' : ''}${k.slaAtRisk ? `<span class="warn">${k.slaAtRisk} at risk</span>` : ''}` : 'all within SLA';
  const kpis = [
    tile('Submitted today', k.submittedToday, `${sgdK(k.approvedValue)} approved in 14 days`),
    tile('Decided without a person', pct(k.stpRate), 'straight-through and knockout declines'),
    tile('Median time to decision', hrs(k.medianHoursToDecision), `${k.decided14} decisions in 14 days`),
    tile('Waiting for approval', k.queue, slaTxt),
    tile('Human override rate', pct(k.overrideRate, 1), `${k.overrides} decisions against the engine`),
    tile('Policy exceptions', pct(k.exceptionRate), `${pct(k.exceptionApprovedRate)} approved with mitigants`),
    tile('Guardrail interventions', k.guardrails, 'prohibited attributes blocked'),
    tile('Agent cost per application', `$${k.costPerApp.toFixed(2)}`, 'estimated model tokens'),
  ].join('');
  const series = [{ key: 'auto', label: 'Approved automatically', color: 'var(--s1)' }, { key: 'human', label: 'Approved by credit', color: 'var(--s3)' }, { key: 'declined', label: 'Declined', color: 'var(--s2)' }];
  const tbl = `<details class="tv"><summary>View as table</summary><table class="t"><tr><th>Day</th>${series.map(s => `<th class="num">${s.label}</th>`).join('')}</tr>${m.daily.map(r => `<tr><td>${r.day}</td>${series.map(s => `<td class="num">${r[s.key]}</td>`).join('')}</tr>`).join('')}</table></details>`;
  const stageLabel = { intake: 'Intake', documents: 'Awaiting documents', kyb: 'KYB & screening', analysis: 'Credit analysis', policy: 'Policy engine', approval: 'Human approval' };
  const pipe = hBars(m.pipeline.map(p => ({ label: stageLabel[p.stage], value: p.n, color: p.stage === 'approval' ? 'var(--gold)' : 'var(--navy)' })), { labelW: 130, W: 400 });
  const ttd = hBars(m.ttd.map(t => ({ label: t.label, value: t.medianHours || 0, tip: `<b>${t.label}</b><br>Median ${hrs(t.medianHours)}<br>${t.n} decisions` })), { fmt: hrs, labelW: 120, W: 400 });
  const rules = hStack(m.ruleHits.slice(0, 7), [{ key: 'exception', label: 'Exception (needs approval)', color: 'var(--s1)' }, { key: 'fail', label: 'Outside policy (decline)', color: 'var(--s2)' }]);
  return `
  <div class="pagehead"><div><h2>Good ${new Date().getHours() < 12 ? 'morning' : 'afternoon'}, ${esc((S.users[S.user] || {}).name || '').split(' ')[0]}</h2><p>Agents prepare every application; policy ${esc(m.policyVersion)} decides; people approve within their authority.</p></div>
    <div class="r"><button class="btn p" data-go="approvals">Open approvals</button></div></div>
  <div class="row kpis">${kpis}</div>
  <div class="row" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr)">
    <div class="card"><h2>Decisions per day <small>last 14 days · SGT</small></h2><p class="lede">Most small, clean applications never wait for a person.</p>${stackedColumns(m.daily, series)}${tbl}</div>
    <div class="card"><h2><i class="live"></i> Live agent activity <small id="feedn"></small></h2><p class="lede">Every agent step and engine decision as it happens.</p><div class="feed" id="feed">${S.feed.map(feedRow).join('') || '<div class="empty" style="display:block">Waiting for the next application…</div>'}</div></div>
  </div>
  <div class="row" style="grid-template-columns:repeat(3,minmax(0,1fr))">
    <div class="card"><h2>Pipeline now</h2><p class="lede">Applications in flight by stage.</p>${pipe}</div>
    <div class="card"><h2>Time to decision</h2><p class="lede">Median from submission, by authority level.</p>${ttd}</div>
    <div class="card"><h2>Rules driving referrals and declines</h2><p class="lede">Which policy rules applications trip most.</p>${rules}</div>
  </div>`;
};
function feedRow(e) {
  return `<div class="${esc(e.kind)}"><time>${hm(e.at)}</time><span><span class="ag">${esc(AG[e.agent] || e.agent)}</span> · <b>${esc(e.company.replace(' Pte Ltd', ''))}</b><br>${esc(e.text)}</span></div>`;
}

const LANES = [['intake', 'Intake', 'ag'], ['documents', 'Awaiting documents', ''], ['kyb', 'KYB & screening', 'ag'], ['analysis', 'Credit analysis', 'ag'],
  ['policy', 'Policy engine', 'ag'], ['approval', 'Human approval', 'hu'], ['offer', 'Offer issued', ''], ['declined', 'Declined', '']];
V.applications = () => {
  const apps = [...S.apps.values()];
  const lanes = LANES.map(([st, label, cls]) => {
    let xs = apps.filter(a => a.stage === st);
    if (st === 'offer' || st === 'declined') xs = xs.sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0)).slice(0, 10);
    else if (st === 'approval') xs = xs.sort((a, b) => a.enteredApprovalAt - b.enteredApprovalAt);
    return `<div class="lane ${cls}"><h3>${label}<span>${apps.filter(a => a.stage === st).length}</span></h3>${xs.map(kcard).join('')}</div>`;
  }).join('');
  return `<div class="pagehead"><div><h2>Applications</h2><p>Navy lanes are agent work; the gold lane is people. Click any card for the full evidence trail.</p></div></div><div class="board">${lanes}</div>`;
};
function kcard(a) {
  const d = a.decision, s = a.stage === 'approval' ? sla(a) : null;
  const chips = [];
  if (d && d.decision) chips.push(`<span class="chip ${d.decision}">${esc(DEC[d.decision])}</span>`);
  if (d && d.level && a.stage === 'approval') chips.push(`<span class="chip lvl">${esc(d.level)}</span>`);
  if (s && s.state !== 'ok') chips.push(`<span class="chip ${s.state}">${s.state === 'breached' ? 'Past SLA' : 'SLA at risk'}</span>`);
  if (a.final) chips.push(`<span class="chip">${a.final.by === 'automation' ? 'Automated' : 'By credit'}${a.final.override ? ' · override' : ''}</span>`);
  if (a.qaSample) chips.push('<span class="chip gold">QA sample</span>');
  if (a.missing && a.missing.length) chips.push(`<span class="chip pending">${a.missing.length} doc${a.missing.length > 1 ? 's' : ''} requested</span>`);
  const sig = a.stage === 'approval' ? `<span class="sig" title="Signatures">${Array.from({ length: needSigs(a) }, (_, i) => `<i class="${i < a.approvals.length ? 'done' : ''}">${i < a.approvals.length ? '✓' : ''}</i>`).join('')}</span>` : '';
  return `<div class="kc ${S.fresh.has(a.id) ? 'new' : ''} ${a.stage === 'approval' && signState(a).can ? 'hot' : ''}" data-open="${a.id}">
    <div class="n">${esc(a.company.replace(' Pte Ltd', ''))}</div>
    <div class="m"><span>${esc(a.product)}</span><b>${sgdK(a.amount)}</b></div>
    ${a.working ? `<div class="w"><span class="spin"></span>${esc(a.working.text)}</div>` : ''}
    ${chips.length || sig ? `<div class="chips">${chips.join('')} ${sig}</div>` : ''}</div>`;
}

V.approvals = () => {
  const me = S.users[S.user];
  let q = [...S.apps.values()].filter(a => a.stage === 'approval').sort((a, b) => sla(b).f - sla(a).f);
  const mine = q.filter(a => signState(a).can);
  if (S.filter === 'mine') q = mine;
  const rows = q.map(a => {
    const d = a.decision, s = sla(a), ss = signState(a);
    return `<tr class="click" data-open="${a.id}"><td><b>${esc(a.company)}</b><br><span class="mono" style="font-size:11px;color:var(--mute)">${a.id} · ${esc(a.product)}</span></td>
      <td class="num"><b>${sgd(a.amount)}</b></td>
      <td><span class="chip ${d.decision}">${esc(DEC[d.decision])}</span><br><span style="font-size:12px;color:var(--mute)">grade ${d.grade}${d.exceptions ? ` · ${d.exceptions} exception${d.exceptions > 1 ? 's' : ''}` : ''}</span></td>
      <td><span class="chip lvl">${d.level}</span> ${esc(d.label)}</td>
      <td><span class="sig">${Array.from({ length: needSigs(a) }, (_, i) => `<i class="${i < a.approvals.length ? 'done' : ''}">${i < a.approvals.length ? '✓' : ''}</i>`).join('')}</span> <span style="font-size:12px;color:var(--mute)">${a.approvals.map(x => esc(x.by.split(' ')[0])).join(', ')}</span></td>
      <td><span class="sla ${s.state}"><i style="width:${Math.min(100, s.f * 100)}%"></i></span><span style="font-size:12px" class="${s.state === 'breached' ? 'chip breached' : ''}">${s.left < 0 ? `${hrs(-s.left)} over` : `${hrs(s.left)} left`}</span></td>
      <td>${ss.can ? '<button class="btn sm p">Review</button>' : `<span style="font-size:12px;color:var(--mute)">${esc(ss.why)}</span>`}</td></tr>`;
  }).join('');
  return `<div class="pagehead"><div><h2>Approvals</h2><p>You are <b>${esc(me.name)}</b>, ${esc(me.title)}. You see what your authority lets you sign; the desk enforces the same rules on every decision.</p></div>
    <div class="r filters"><button data-filter="mine" class="${S.filter === 'mine' ? 'on' : ''}">Mine to sign (${mine.length})</button><button data-filter="all" class="${S.filter === 'all' ? 'on' : ''}">Whole queue (${[...S.apps.values()].filter(a => a.stage === 'approval').length})</button></div></div>
  <div class="card" style="padding:6px 10px">${rows ? `<table class="t"><tr><th>Application</th><th class="num">Amount</th><th>Policy engine</th><th>Authority</th><th>Signatures</th><th>SLA</th><th></th></tr>${rows}</table>`
    : `<div class="empty">${S.filter === 'mine' ? `Nothing in the queue needs ${esc(me.title)} authority right now. Switch user in the header, or view the whole queue.` : 'The queue is empty.'}</div>`}</div>
  <div class="row" style="grid-template-columns:repeat(4,1fr);margin-top:16px">${authorityCards()}</div>`;
};
function authorityCards() {
  if (!S.policy) return '';
  const A = S.policy.active.authority;
  const who = { STP: 'Automation · 10% QA sample', L1: 'Any credit officer', L2: 'Two different people · one Senior Credit Manager', L3: 'Credit Committee chair' };
  return A.map(l => `<div class="card"><h2><span class="chip lvl">${l.level}</span> ${esc(l.label)}</h2><p class="lede" style="margin:6px 0 0">${l.maxAmount ? `Up to ${sgdK(l.maxAmount)}` : 'Any amount'} · grade ≤ ${l.maxGrade} · ${l.maxExceptions === 0 ? 'no exceptions' : l.maxExceptions >= 99 ? 'any exceptions' : `≤ ${l.maxExceptions} exception`}<br>${who[l.level]}${l.slaHours ? ` · SLA ${l.slaHours}h` : ''}</p></div>`).join('');
}

// ---------- drawer ----------
async function openApp(id) {
  S.drawer = id;
  $('drawer').classList.add('on'); $('scrim').classList.add('on'); $('drawer').setAttribute('aria-hidden', 'false');
  if (!$('dw').dataset.id || $('dw').dataset.id !== id) $('dw').innerHTML = '<div class="empty">Loading…</div>';
  await refreshDrawer();
}
function closeDrawer() { S.drawer = null; $('drawer').classList.remove('on'); $('scrim').classList.remove('on'); $('drawer').setAttribute('aria-hidden', 'true'); $('dw').dataset.id = ''; }
async function refreshDrawer(keepForm) {
  if (!S.drawer) return;
  const a = await api(`/api/applications/${S.drawer}`).catch(() => null);
  if (!a || a.id !== S.drawer) return;
  const ta = $('reason'), co = $('conds'), saved = keepForm && ta ? { r: ta.value, c: co && co.value } : null;
  $('dw').dataset.id = a.id; $('dw').innerHTML = drawerHtml(a);
  if (saved && $('reason')) { $('reason').value = saved.r; if ($('conds')) $('conds').value = saved.c || ''; }
}
function drawerHtml(a) {
  const ev = a.evaluation, sm = a.summary, f = a.financials;
  const head = `<div class="dh"><button class="x" data-close aria-label="Close">×</button><h2>${esc(a.company)}</h2>
    <div class="meta"><span class="mono">${a.id}</span><span>${esc(a.product)} · ${sgd(a.amount)} over ${a.tenorMonths} months</span><span>RM ${esc(a.rm)}</span><span>submitted ${ago(a.createdAt)}</span><span class="chip ${sm.final ? sm.final.outcome : ''}">${esc(LANES.find(l => l[0] === a.stage)[1])}</span></div></div>`;
  let verdict = '';
  if (ev) {
    verdict = `<div class="dsec"><h3>Policy engine decision</h3><div class="verdict ${ev.decision}">
      <div class="big">${esc(DEC[ev.decision])}</div>
      <div class="stats"><div>Risk grade<b>${ev.grade} / 10</b></div><div>Price<b>${ev.pricing.rate.toFixed(2)}%</b></div><div>Authority<b>${esc(ev.approval ? ev.approval.label : '–')}</b></div></div>
      <div>${ev.exceptions.map(x => `<span class="chip exception">${x}</span>`).join(' ')} ${ev.declineReasons.map(x => `<span class="chip fail">${x}</span>`).join(' ')}</div>
      <div class="src">${esc(ev.policyId)} v${esc(ev.policyVersion)} · decision #${ev.hash} · base ${ev.pricing.baseRate.toFixed(2)}% + spread ${ev.pricing.spread.toFixed(2)}%${a.secured ? ' − secured 0.40%' : ''}</div></div></div>`;
  }
  const decide = a.stage === 'approval' ? decidePanel(a) : '';
  const finalBox = a.final ? `<div class="dsec"><h3>Outcome</h3><div class="card" style="padding:12px 16px"><span class="chip ${a.final.outcome}">${a.final.outcome === 'approved' ? 'Approved' : 'Declined'}</span> ${a.final.by === 'automation' ? 'by automation within delegated authority' : 'by credit'}${a.final.override ? ' · <b>override of the engine recommendation</b>' : ''} · ${hms(a.final.at)}${a.approvals.map(x => `<div style="font-size:12.5px;margin-top:6px"><b>${esc(x.by)}</b> (${esc(x.role)}) ${esc(x.action)}d${x.reason ? `: “${esc(x.reason)}”` : ''}${x.conditions ? ` · conditions: ${esc(x.conditions)}` : ''}</div>`).join('')}</div></div>` : '';
  const fmtT = t => t.actual === undefined || t.actual === null ? '–' : typeof t.actual === 'boolean' ? (t.actual ? 'yes' : 'no') : t.unit === '%' ? `${(t.actual * 100).toFixed(1)}%` : t.unit === 'x' ? `${Number(t.actual).toFixed(2)}x` : t.unit === 'S$' ? sgd(t.actual) : esc(t.actual);
  const lim = (t, v) => v === undefined ? '' : Array.isArray(v) ? `not ${v.join(', ')}` : typeof v === 'boolean' ? (v ? 'yes' : 'no') : t.unit === '%' ? `${(v * 100).toFixed(0)}%` : t.unit === 'x' ? `${v.toFixed(2)}x` : t.unit === 'S$' ? sgdK(v) : v;
  const trace = ev ? `<div class="dsec"><h3>Rule trace <small>every rule the engine checked</small></h3><div class="card" style="padding:4px 10px"><table class="t"><tr><th>Rule</th><th>Clause</th><th class="num">Actual</th><th class="num">Standard</th><th class="num">Exception limit</th><th>Result</th></tr>
    ${ev.trace.map(t => `<tr><td><b>${t.id}</b> ${esc(t.name)}</td><td class="mono" style="font-size:12px">${t.clause}</td><td class="num">${fmtT(t)}</td><td class="num">${t.op ? `${t.op === 'notIn' ? '' : OP[t.op] + ' '}${lim(t, t.threshold)}` : ''}</td><td class="num">${t.exceptionLimit !== undefined ? lim(t, t.exceptionLimit) : ''}</td><td><span class="chip ${t.result === 'n/a' ? 'na' : t.result}">${t.result}</span></td></tr>`).join('')}</table></div></div>` : '';
  const m = ev ? ev.metrics : null;
  const kv = [['Revenue', sgd(f.revenue)], ['Revenue growth', m ? `${m.revenueGrowth >= 0 ? '+' : ''}${(m.revenueGrowth * 100).toFixed(1)}%` : '–'], ['EBITDA', sgd(f.ebitda)], ['Existing debt', sgd(f.existingDebt)],
    ['DSCR (7.5% stress)', m ? `${m.dscr.toFixed(2)}x` : '–'], ['Leverage', m ? `${m.leverage.toFixed(2)}x` : '–'], ['Loan to value', m && m.ltv ? `${(m.ltv * 100).toFixed(0)}%` : 'unsecured'], ['Bureau score', a.bureauScore],
    ['Negative days (90d)', a.negativeDays90], ['Years trading', a.yearsTrading], ['Collateral', a.collateralType ? `${esc(a.collateralType)} ${sgdK(a.collateralValue)}` : '–'], ['Industry', esc(a.industry)]];
  const facts = `<div class="dsec"><h3>Key figures <small>extracted by Document Intake · spread by the engine</small></h3><dl class="kv">${kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></div>`;
  const memo = a.memo ? `<div class="dsec"><h3>Credit memo <small>drafted by Credit Analyst Agent v3.0.1 · checked by judges J1–J3</small></h3><div class="memo">${esc(a.memo)}</div></div>` : '';
  const steps = `<div class="dsec"><h3>Agent and decision trail</h3><div class="steps">${a.steps.map(s => `<div class="${esc(s.kind)}"><time>${hms(s.at)}</time><span class="ag">${esc(AG[s.agent] || s.agent)}</span><span>${s.kind === 'work' ? '<span class="spin"></span> ' : ''}${esc(s.text)}${s.tool ? `<span class="tool">${esc(s.tool)}</span>` : ''}</span></div>`).join('') || '<div class="empty" style="display:block">Decided before this shift; the full trail is in the archive.</div>'}</div></div>`;
  const audit = a.audit && a.audit.length ? `<div class="dsec"><h3>Audit entries <small>hash-chained</small></h3><div class="card" style="padding:4px 10px"><table class="t">${a.audit.map(e => `<tr><td class="mono" style="font-size:11px;color:var(--mute)">#${e.seq}</td><td style="font-size:12px">${hms(e.at)}</td><td style="font-size:12px"><b>${esc(e.actor)}</b></td><td class="mono" style="font-size:12px">${esc(e.action)}</td><td style="font-size:12px">${esc(e.detail)}</td><td class="mono" style="font-size:11px;color:var(--mute)">${e.hash.slice(0, 10)}</td></tr>`).join('')}</table></div></div>` : '';
  return head + verdict + decide + finalBox + trace + facts + memo + steps + audit;
}
function decidePanel(a) {
  const ev = a.evaluation, sm = a.summary, ss = signState(sm), me = S.users[S.user], need = needSigs(sm);
  const req = { L1: 'one credit officer', L2: 'two different approvers, at least one Senior Credit Manager', L3: 'the Credit Committee' }[ev.approval.level];
  const signed = a.approvals.length ? ` Signed so far: ${a.approvals.map(x => `<b>${esc(x.by)}</b> ✓`).join(', ')}.` : '';
  const warn = ev.decision === 'DECLINE' ? `<div class="warnbox">The engine recommends <b>decline</b> (${ev.declineReasons.join(', ')}). Approving is an <b>override</b>: it needs a full justification and is reported on the dashboard.</div>`
    : ev.decision === 'REFER' ? `<div class="warnbox">Policy exception ${ev.exceptions.join(', ')}. If you approve, state the mitigant in your reason.</div>` : '';
  const approveLbl = ev.decision === 'DECLINE' ? 'Override and approve' : need === 2 && a.approvals.length === 0 ? 'Approve (first signature)' : 'Approve';
  const dis = ss.can ? '' : 'disabled';
  return `<div class="dsec"><h3>Your decision</h3><div class="decide">
    <p class="authline"><b>${esc(ev.approval.label)} (${ev.approval.level})</b> needs ${req}.${signed} SLA ${ev.approval.slaHours}h · ${(() => { const s = sla(sm); return s.left < 0 ? `<span class="chip breached">${hrs(-s.left)} over</span>` : `${hrs(s.left)} left`; })()}</p>
    ${ss.can ? `<p class="authline">You are ${esc(me.name)} (${esc(me.title)}) and can sign this.</p>` : `<p class="authline" style="color:var(--crit-ink)"><b>You can't sign this:</b> ${esc(ss.why)}. Switch user in the header to continue the demo.</p>`}
    ${warn}
    <label for="reason">Reason (recorded in the audit trail)</label><textarea id="reason" rows="2" ${dis} placeholder="${ev.decision === 'REFER' ? 'e.g. DSCR exception mitigated by equipment security and 11 years of trading' : 'e.g. Within policy; financials verified'}"></textarea>
    <label for="conds">Conditions (optional)</label><input id="conds" ${dis} placeholder="e.g. Quarterly management accounts; DSCR covenant 1.15x">
    <div class="acts"><button class="btn p ${ev.decision === 'DECLINE' ? 'd' : ''}" data-decide="approve" ${dis}>${approveLbl}</button><button class="btn d" data-decide="decline" ${dis}>${ev.decision === 'DECLINE' ? 'Confirm decline' : 'Decline'}</button><button class="btn" data-decide="return" ${dis}>Return to analyst</button></div>
    <div class="err" id="derr"></div></div></div>`;
}
async function submitDecision(action) {
  const btns = document.querySelectorAll('[data-decide]'); btns.forEach(b => (b.disabled = true));
  try {
    const r = await api(`/api/applications/${S.drawer}/decision`, { user: S.user, action, reason: $('reason').value, conditions: $('conds').value });
    toast(action === 'return' ? 'Returned to the Credit Analyst Agent' : r.stage === 'approval' ? 'First signature recorded · waiting for a second approver' : action === 'approve' ? 'Approved · offer letter being issued' : 'Declined · notice being issued');
    S.apps.set(r.id, r); render(); await refreshDrawer();
  } catch (e) { $('derr').textContent = e.message; btns.forEach(b => (b.disabled = false)); }
}

// ---------- policy ----------
const pctRule = r => r.unit === '%';
function ruleVal(r, k) { const e = S.edits.rules[r.id]; return e && e[k] !== undefined ? e[k] : r[k]; }
V.policy = () => {
  if (!S.policy) return '<div class="empty">Loading…</div>';
  const P = S.policy.active, me = S.users[S.user];
  const show = (r, v) => pctRule(r) ? +(v * 100).toFixed(1) : v;
  const knock = P.knockouts.map(r => `<tr><td><b>${r.id}</b></td><td>${esc(r.name)}</td><td class="mono" style="font-size:12px">${r.clause}</td><td class="mono" style="font-size:12px">${esc(r.field)} ${OP[r.op]} ${esc(Array.isArray(r.value) ? r.value.join(', ') : r.unit === 'S$' ? sgdK(r.value) : r.value)}${r.unit && r.unit !== 'S$' ? ' ' + r.unit : ''}</td><td>Automated decline</td></tr>`).join('');
  const credit = P.credit.map(r => {
    const inp = k => `<input data-rule="${r.id}" data-k="${k}" value="${show(r, ruleVal(r, k))}" class="${S.edits.rules[r.id] && S.edits.rules[r.id][k] !== undefined ? 'ch' : ''}">`;
    return `<tr><td><b>${r.id}</b></td><td>${esc(r.name)}</td><td class="mono" style="font-size:12px">${r.clause}</td><td class="mono" style="font-size:12px">${OP[r.op]} ${inp('value')} ${pctRule(r) ? '%' : r.unit || ''}</td><td class="mono" style="font-size:12px">${inp('exception')} ${pctRule(r) ? '%' : r.unit || ''}</td></tr>`;
  }).join('');
  const av = (l, k) => { const e = S.edits.authority[l.level]; return e && e[k] !== undefined ? e[k] : l[k]; };
  const ainp = (l, k) => `<input data-auth="${l.level}" data-k="${k}" value="${av(l, k)}" class="${S.edits.authority[l.level] && S.edits.authority[l.level][k] !== undefined ? 'ch' : ''}" ${l.level === 'L3' ? 'disabled' : ''}>`;
  const auth = P.authority.map(l => `<tr><td><span class="chip lvl">${l.level}</span></td><td>${esc(l.label)}</td><td class="mono" style="font-size:12px">${l.maxAmount === null ? 'no cap' : ainp(l, 'maxAmount')}</td><td class="mono" style="font-size:12px">${ainp(l, 'maxGrade')}</td><td class="mono" style="font-size:12px">${l.maxExceptions >= 99 ? 'any' : ainp(l, 'maxExceptions')}</td><td>${l.approvers === 0 ? 'automation' : l.approvers === 2 ? '2 people' : '1 person'}</td></tr>`).join('');
  const dirty = Object.keys(S.edits.rules).length + Object.keys(S.edits.authority).length > 0;
  const pending = S.policy.changeRequests.find(c => c.status === 'pending');
  return `<div class="pagehead"><div><h2>Policy engine</h2><p>Agents never decide. Every decision comes from <b>${esc(P.id)} v${esc(P.version)}</b>, a versioned rule pack. Change it here: simulate, submit, approve.</p></div><div class="r"><span class="chip lvl">Effective ${esc(P.effective)}</span><span class="chip">Owner: ${esc(P.owner)}</span></div></div>
  <div class="row" style="grid-template-columns:minmax(0,3fr) minmax(0,2fr)">
    <div class="card pol"><h2>Rules <small>edit a value to draft a change</small></h2>
      <h4 style="margin:12px 0 4px;font-size:12px;color:var(--sub)">KNOCKOUTS · checked first</h4><table class="t"><tr><th></th><th>Rule</th><th>Clause</th><th>Condition</th><th>If failed</th></tr>${knock}</table>
      <h4 style="margin:16px 0 4px;font-size:12px;color:var(--sub)">CREDIT RULES · pass, exception band or fail</h4><table class="t"><tr><th></th><th>Rule</th><th>Clause</th><th>Standard</th><th>Exception limit</th></tr>${credit}</table>
      <h4 style="margin:16px 0 4px;font-size:12px;color:var(--sub)">AUTHORITY MATRIX · first level that fits</h4><table class="t"><tr><th></th><th>Level</th><th>Max amount</th><th>Max grade</th><th>Max exceptions</th><th>Signers</th></tr>${auth}</table>
      <p class="lede" style="margin:12px 0 0">Also enforced: prohibited inputs (${P.prohibitedInputs.join(', ')}) are stripped and logged (CP-1.3); repayments are stress-tested at ${(P.stressRate * 100).toFixed(1)}%.</p>
      <div style="display:flex;gap:8px;margin-top:14px"><button class="btn p" data-act="simulate" ${dirty ? '' : 'disabled'}>Simulate impact</button><button class="btn" data-act="reset" ${dirty ? '' : 'disabled'}>Reset draft</button>${dirty ? '' : '<span class="lede" style="align-self:center;margin:0">Try DSCR standard 1.20, or STP max amount 150000.</span>'}</div>
      <div class="err">${esc(S.simErr)}</div>
    </div>
    <div>${impactCard()}${changeRequests(me, pending)}${historyCard()}</div>
  </div>`;
};
function impactCard() {
  const s = S.sim; if (!s) return `<div class="card" style="margin-bottom:16px"><h2>Impact of the draft</h2><p class="lede" style="margin:4px 0 0">Simulation replays the current book (${[...S.apps.values()].length}+ applications) and the golden set through the draft before anyone can submit it.</p></div>`;
  const moves = Object.entries(s.moves).sort((a, b) => b[1] - a[1]).map(([k, v]) => { const [x, y] = k.split('→'); return `<span class="${x !== y ? 'chg' : ''}">${esc(DEC[x] || x)} → ${esc(DEC[y] || y)}: <b>${v}</b></span>`; }).join('');
  const lv = ['STP', 'L1', 'L2', 'L3', 'AUTO_DECLINE'].map(l => `<tr><td><span class="chip lvl">${l}</span></td><td class="num">${s.levels.before[l] || 0}</td><td class="num">${s.levels.after[l] || 0}</td><td class="num" style="font-weight:600;color:${(s.levels.after[l] || 0) - (s.levels.before[l] || 0) ? 'var(--ink)' : 'var(--mute)'}">${((s.levels.after[l] || 0) - (s.levels.before[l] || 0)) > 0 ? '+' : ''}${(s.levels.after[l] || 0) - (s.levels.before[l] || 0)}</td></tr>`).join('');
  const gChanged = s.golden.results.filter(r => !r.pass);
  const me = S.users[S.user];
  return `<div class="card" style="margin-bottom:16px"><h2>Impact of draft v${esc(s.draft.version)} <small>${s.portfolio} applications replayed</small></h2>
    <div class="moves">${moves}</div>
    <table class="t" style="margin-bottom:10px"><tr><th>Authority</th><th class="num">Now</th><th class="num">Draft</th><th class="num">Change</th></tr>${lv}</table>
    <p style="margin:6px 0"><span class="chip ${gChanged.length ? 'exception' : 'pass'}">Golden set ${s.golden.passed}/${s.golden.total}</span> ${gChanged.length ? `${gChanged.map(r => `<b>${r.id}</b> ${esc(r.name)} → ${r.got.decision}/${r.got.level}`).join('; ')}. The approver must acknowledge these.` : 'No golden case changes outcome.'}</p>
    ${s.flippedCount ? `<details class="tv"><summary>${s.flippedCount} applications change outcome or authority</summary><table class="t">${s.flipped.slice(0, 12).map(f => `<tr><td>${esc(f.company)}</td><td class="num">${sgdK(f.amount)}</td><td style="font-size:12px">${esc(f.from)} → <b>${esc(f.to)}</b></td></tr>`).join('')}</table></details>` : ''}
    <div class="pform" style="margin-top:12px"><label for="rat">Why change the policy?</label><textarea id="rat" rows="2" placeholder="e.g. Align the DSCR floor with peer banks for secured equipment loans"></textarea>
    <button class="btn p" data-act="submit">Submit for approval as ${esc(me.name)}</button><div class="err">${esc(S.crErr)}</div></div></div>`;
}
function changeRequests(me, pending) {
  const crs = S.policy.changeRequests;
  if (!crs.length) return '';
  return `<div class="card" style="margin-bottom:16px"><h2>Change requests</h2>${crs.map(c => `<div class="cr ${c.status}"><div class="h"><b>${c.id}</b><span class="chip ${c.status}">${c.status}</span><span style="font-size:12px;color:var(--mute);margin-left:auto">v${c.fromVersion} → v${c.toVersion}</span></div>
    <p>${esc(c.rationale)}</p><div class="meta">${esc(c.author)} · ${ago(c.at)} · ${c.impact.flippedCount} applications affected · golden ${c.impact.goldenPassed}/${c.impact.goldenTotal}${c.reviewer ? ` · ${c.status} by ${esc(c.reviewer)}${c.note ? `: “${esc(c.note)}”` : ''}` : ''}</div>
    ${c.status === 'pending' ? (me.role === 'policy_approver' ? `<div class="pform" style="margin-top:8px"><label for="crnote">Review note${c.impact.goldenPassed < c.impact.goldenTotal ? ' (required: acknowledge the changed golden cases)' : ''}</label><textarea id="crnote" rows="2"></textarea><div style="display:flex;gap:8px"><button class="btn p" data-review="approve" data-cr="${c.id}">Approve and publish</button><button class="btn d" data-review="reject" data-cr="${c.id}">Reject</button></div><div class="err" id="crerr"></div></div>`
      : `<p class="meta" style="margin-top:6px">Waiting for the Head of Credit Risk Policy. Switch to Aisha Rahman in the header to review.</p>`) : ''}</div>`).join('')}</div>`;
}
function historyCard() {
  return `<div class="card"><h2>Version history</h2><table class="t">${S.policy.log.map(l => `<tr><td><span class="chip lvl">v${esc(l.version)}</span></td><td style="font-size:12px">${new Date(l.at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' })}</td><td style="font-size:12px">${esc(l.by)}<br><span style="color:var(--mute)">${esc(l.note)}</span></td></tr>`).join('')}</table></div>`;
}

// ---------- evals ----------
V.evals = () => {
  const E = S.evals; if (!E) return '<div class="empty">Loading…</div>';
  const A = E.agents, gate = A.gate;
  const M = [['journeySuccess', 'Journey success'], ['toolCallPrecision', 'Tool call precision'], ['toolCallRecall', 'Tool call recall'], ['faithfulness', 'Faithfulness'], ['answerRelevancy', 'Answer relevancy'], ['routingAccuracy', 'Routing accuracy']];
  const names = { supervisor: 'SME Credit Supervisor', intake: 'Document Intake Agent', kyb: 'KYB & Screening Agent', analyst: 'Credit Analyst Agent', comms: 'Customer Comms Agent' };
  const card = (id, cur, hist, candidate) => {
    const fails = M.filter(([k]) => cur[k] !== undefined && gate[k] !== undefined && cur[k] < gate[k]).map(([k]) => k);
    return `<div class="gate ${fails.length ? 'blocked' : ''}"><div style="display:flex;gap:6px;align-items:center"><h4>${names[id]}</h4><span class="chip ${fails.length ? 'blocked' : 'pass'}" style="margin-left:auto">${fails.length ? 'Blocked' : candidate ? 'Ready' : 'In production'}</span></div>
      <div class="ver">v${esc(cur.version)}${candidate ? ' · release candidate' : ''} · ${A.agents[id].dataset} test journeys</div>
      <div class="m">${M.filter(([k]) => cur[k] !== undefined).map(([k, l]) => `<span>${l}${gate[k] ? ` <small>(gate ${pct(gate[k])})</small>` : ''}</span><b class="${fails.includes(k) ? 'f' : ''}">${pct(cur[k])}</b>`).join('')}<span>Avg response</span><b>${cur.avgRespSecs.toFixed(1)} s</b></div>
      ${hist ? `<div style="margin-top:8px;display:flex;align-items:center;gap:8px;font-size:11px;color:var(--mute)">${spark(hist.map(h => h.journeySuccess), hist.map(h => 'v' + h.version))} journey success by version</div>` : ''}
      ${candidate && cur.finding ? `<div class="find"><b>Why blocked:</b> ${esc(cur.finding)}</div>` : ''}</div>`;
  };
  const cards = Object.entries(A.agents).map(([id, a]) => card(id, a.history[a.history.length - 1], a.history)).join('')
    + Object.entries(A.agents).filter(([, a]) => a.candidate).map(([id, a]) => card(id, a.candidate, null, true)).join('');
  const judges = A.judges.map(j => `<tr><td><b>${j.id}</b></td><td>${esc(j.criterion)}</td><td style="font-size:12px">${esc(names[j.agent].replace(' Agent', ''))}</td><td class="num">${pct(j.pass)}<span class="bar1"><i style="width:${j.pass * 100}%"></i></span></td><td><span class="chip ${j.pass >= gate.judgePass ? 'pass' : 'fail'}">${j.pass >= gate.judgePass ? 'pass' : 'fail'}</span></td></tr>`).join('');
  const G = E.golden;
  const golden = G.results.map(r => `<tr><td class="mono" style="font-size:12px">${r.id}</td><td>${esc(r.name)}</td><td style="font-size:12px">${r.expect.decision} · ${r.expect.level || '–'}</td><td style="font-size:12px">${r.got.decision} · ${r.got.level || '–'}</td><td><span class="chip ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'pass' : 'fail'}</span></td></tr>`).join('');
  return `<div class="pagehead"><div><h2>Evaluations</h2><p>Agents reach production only through the release gate. The policy engine is regression-tested against a golden set on every change.</p></div><div class="r"><button class="btn" data-act="rerun">Re-run golden set</button></div></div>
  <div class="row" style="grid-template-columns:repeat(3,minmax(0,1fr))">${cards}</div>
  <div class="row" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
    <div class="card"><h2>Custom judges <small>LLM-as-judge criteria · gate ${pct(gate.judgePass)}</small></h2><p class="lede">Plain-language checks written for this use case, scored on every test journey.</p><table class="t"><tr><th></th><th>Criterion</th><th>Agent</th><th class="num">Pass rate</th><th></th></tr>${judges}</table></div>
    <div class="card"><h2>Policy engine golden set <small>v${esc(G.policyVersion)}</small></h2><p class="lede"><span class="chip ${G.passed === G.total ? 'pass' : 'exception'}">${G.passed}/${G.total} pass</span> Hand-checked cases covering every rule, boundary and authority level. Also runs in CI: <span class="mono">node evals/run.js</span></p><div style="max-height:420px;overflow:auto"><table class="t"><tr><th></th><th>Case</th><th>Expected</th><th>Engine</th><th></th></tr>${golden}</table></div></div>
  </div>
  <p class="lede">Agent scores: ${A.source === 'sample' ? 'sample figures in the ADK evaluation format (<span class="mono">orchestrate evaluations evaluate</span>) until the agents are imported and evaluated' : 'latest ADK evaluation run'}. Golden set: live result from the running engine.</p>`;
};

// ---------- control tower ----------
V.tower = () => {
  const m = S.metrics, au = S.audit; if (!m || !au) return '<div class="empty">Loading…</div>';
  const A = S.evals && S.evals.agents;
  const gateOf = id => { if (!A || !A.agents[id]) return null; const c = A.agents[id].history.slice(-1)[0]; return ['journeySuccess', 'toolCallPrecision', 'toolCallRecall', 'faithfulness'].every(k => c[k] === undefined || c[k] >= A.gate[k]); };
  const rows = m.agents.map(a => {
    const g = a.id === 'engine' ? (S.evals ? S.evals.golden.passed === S.evals.golden.total : null) : gateOf(a.id);
    return `<tr><td><b>${esc(a.name)}</b><br><span style="font-size:12px;color:var(--mute)">${esc(a.role)}</span></td><td style="font-size:12px">${esc(a.kind)}<br><span class="mono" style="font-size:11px;color:var(--mute)">${esc(a.model)}</span></td><td class="mono" style="font-size:12px">${a.version ? 'v' + esc(a.version) : '–'}</td><td style="font-size:12px">${esc(a.owner)}</td>
      <td class="mono" style="font-size:11px;color:var(--sub)">${a.tools.map(esc).join('<br>')}</td>
      <td class="num">${a.external ? '<span style="font-size:12px;color:var(--mute)">fraud console</span>' : a.runs.toLocaleString()}</td><td class="num">${a.success == null ? '–' : pct(a.success, 1)}</td><td class="num">${a.p50ms == null ? '–' : a.p50ms < 1000 ? Math.round(a.p50ms) + ' ms' : (a.p50ms / 1000).toFixed(1) + ' s'}</td>
      <td class="num">${a.external ? '–' : a.guardrails}</td><td>${g == null ? '<span class="chip">not tracked</span>' : `<span class="chip ${g ? 'pass' : 'fail'}">${g ? 'pass' : 'fail'}</span>`}</td></tr>`;
  }).join('');
  const v = au.verify;
  return `<div class="pagehead"><div><h2>Control tower</h2><p>Every agent, its owner and health, and a tamper-evident record of what each one did.</p></div></div>
  <div class="card" style="margin-bottom:16px"><h2>How a credit decision is made</h2><div class="arch" style="margin-top:10px">
    <div class="bx"><b>Agents gather evidence</b>Intake, KYB and Credit Analyst agents extract, screen and spread. They never decide.</div><div class="ar">→</div>
    <div class="bx eng"><b>Policy engine decides</b>Deterministic rules v${esc(m.policyVersion)} · full trace · same input, same answer.</div><div class="ar">→</div>
    <div class="bx"><b>Authority matrix routes</b>Straight-through, Credit Officer, dual sign-off or Committee by amount, grade and exceptions.</div><div class="ar">→</div>
    <div class="bx hum"><b>People approve</b>Segregation of duties enforced on the server. Overrides need a reason and are reported.</div><div class="ar">→</div>
    <div class="bx"><b>Everything is recorded</b>Each step joins a SHA-256 hash chain that anyone can verify.</div></div></div>
  <div class="card" style="margin-bottom:16px;padding:12px 14px"><h2>Agent inventory <small>14 days</small></h2><table class="t"><tr><th>Agent</th><th>Runtime</th><th>Version</th><th>Owner</th><th>Tools</th><th class="num">Runs</th><th class="num">Success</th><th class="num">p50 latency</th><th class="num">Guardrail blocks</th><th>Eval gate</th></tr>${rows}</table></div>
  <div class="card" style="padding:12px 14px"><h2>Audit trail <small><span class="vfy">${v.ok ? `<span class="chip pass">Chain verified</span> ${v.entries} entries · head ${esc(v.head)}` : `<span class="chip fail">Chain broken at #${v.brokenAt}</span>`}</span> <button class="btn sm" data-act="verify" style="margin-left:8px">Verify now</button></small></h2>
    <div style="max-height:460px;overflow:auto"><table class="t"><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Application</th><th>Detail</th><th>Hash</th></tr>${au.entries.slice(0, 150).map(e => `<tr><td class="mono" style="font-size:11px;color:var(--mute)">${e.seq}</td><td style="font-size:12px">${hms(e.at)}</td><td style="font-size:12px"><b>${esc(e.actor)}</b></td><td class="mono" style="font-size:12px">${esc(e.action)}</td><td>${e.appId ? `<a href="#" data-open="${e.appId}" class="mono" style="font-size:12px">${e.appId}</a>` : ''}</td><td style="font-size:12px">${esc(e.detail)}</td><td class="mono" style="font-size:11px;color:var(--mute)">${e.hash.slice(0, 10)}</td></tr>`).join('')}</table></div></div>`;
};

// ---------- render loop ----------
function render() {
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === S.view));
  const y = scrollY, lane = [...document.querySelectorAll('.lane')].map(l => l.scrollTop);
  const active = document.activeElement && document.activeElement.id;
  const val = active && $(active) && 'value' in $(active) ? $(active).value : null;
  $('view').innerHTML = V[S.view]();
  scrollTo(0, y);
  document.querySelectorAll('.lane').forEach((l, i) => (l.scrollTop = lane[i] || 0));
  if (active && $(active)) { if (val !== null) $(active).value = val; $(active).focus(); }
  const q = [...S.apps.values()].filter(a => a.stage === 'approval' && signState(a).can).length;
  $('nb-appr').textContent = q || '';
  $('nb-pol').textContent = S.policy && S.policy.changeRequests.some(c => c.status === 'pending') ? '1' : '';
}
let rt = 0;
function soon() { if (rt) return; rt = setTimeout(() => { rt = 0; if (!document.querySelector('#view textarea:focus, #view input:focus')) render(); }, 450); }

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target;
  const open = t.closest('[data-open]'); if (open) { e.preventDefault(); return openApp(open.dataset.open); }
  if (t.closest('[data-close]') || t.id === 'scrim') return closeDrawer();
  const go = t.closest('[data-go]'); if (go) { location.hash = go.dataset.go; return; }
  const f = t.closest('[data-filter]'); if (f) { S.filter = f.dataset.filter; return render(); }
  const d = t.closest('[data-decide]'); if (d) return submitDecision(d.dataset.decide);
  const rv = t.closest('[data-review]');
  if (rv) {
    try { await api(`/api/policy/changes/${rv.dataset.cr}/review`, { user: S.user, action: rv.dataset.review, note: $('crnote').value }); S.edits = { rules: {}, authority: {} }; S.sim = null; toast(rv.dataset.review === 'approve' ? 'Policy published · new applications use it now' : 'Change rejected'); }
    catch (err) { $('crerr').textContent = err.message; }
    return;
  }
  const act = t.closest('[data-act]'); if (!act) return;
  const a = act.dataset.act;
  if (a === 'simulate') { try { S.sim = await api('/api/policy/simulate', { edits: S.edits }); S.simErr = ''; S.crErr = ''; } catch (err) { S.simErr = err.message; } render(); }
  if (a === 'reset') { S.edits = { rules: {}, authority: {} }; S.sim = null; S.simErr = ''; render(); }
  if (a === 'submit') { try { await api('/api/policy/changes', { user: S.user, edits: S.edits, rationale: $('rat').value }); S.crErr = ''; toast('Submitted · waiting for the Head of Credit Risk Policy'); } catch (err) { S.crErr = err.message; render(); } }
  if (a === 'rerun') { S.evals = await api('/api/evals'); render(); toast(`Golden set: ${S.evals.golden.passed}/${S.evals.golden.total} pass on v${S.evals.golden.policyVersion}`); }
  if (a === 'verify') { S.audit = await api('/api/audit'); render(); toast(S.audit.verify.ok ? `Audit chain verified · ${S.audit.verify.entries} entries` : 'Audit chain broken'); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.rule) {
    const P = S.policy.active, r = P.credit.find(x => x.id === t.dataset.rule), k = t.dataset.k;
    const v = pctRule(r) ? Number(t.value) / 100 : Number(t.value);
    S.edits.rules[r.id] = S.edits.rules[r.id] || {};
    if (Math.abs(v - r[k]) < 1e-9) delete S.edits.rules[r.id][k]; else S.edits.rules[r.id][k] = v;
    if (!Object.keys(S.edits.rules[r.id]).length) delete S.edits.rules[r.id];
    S.sim = null; render();
  }
  if (t.dataset.auth) {
    const l = S.policy.active.authority.find(x => x.level === t.dataset.auth), k = t.dataset.k, v = Number(t.value);
    S.edits.authority[l.level] = S.edits.authority[l.level] || {};
    if (v === l[k]) delete S.edits.authority[l.level][k]; else S.edits.authority[l.level][k] = v;
    if (!Object.keys(S.edits.authority[l.level]).length) delete S.edits.authority[l.level];
    S.sim = null; render();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.drawer) closeDrawer(); });
$('user').addEventListener('change', e => { S.user = e.target.value; store.set('lgb.user', S.user); render(); if (S.drawer) refreshDrawer(true); toast(`Signed in as ${S.users[S.user].name} · ${S.users[S.user].title}`); });
addEventListener('hashchange', () => { S.view = location.hash.slice(1) || 'overview'; if (!V[S.view]) S.view = 'overview'; load(S.view); render(); scrollTo(0, 0); });

async function load(view) {
  if (view === 'overview' || view === 'tower') S.metrics = await api('/api/metrics');
  if (view === 'tower') { S.audit = await api('/api/audit'); if (!S.evals) S.evals = await api('/api/evals'); }
  if (view === 'evals') S.evals = await api('/api/evals');
  if (view === S.view) render();
}

function onEvent(type, x) {
  if (type === 'app') {
    const had = S.apps.has(x.id);
    S.apps.set(x.id, x);
    if (!had) { S.fresh.add(x.id); setTimeout(() => S.fresh.delete(x.id), 2600); }
    if (S.view === 'applications' || S.view === 'approvals') soon();
    if (S.drawer === x.id) { clearTimeout(onEvent.dt); onEvent.dt = setTimeout(() => refreshDrawer(true), 250); }
  }
  if (type === 'activity') {
    if (x.kind === 'work') return;
    S.feed.unshift(x); S.feed.length = Math.min(S.feed.length, 60);
    const f = $('feed');
    if (f && S.view === 'overview') { if (f.querySelector('.empty')) f.innerHTML = ''; f.insertAdjacentHTML('afterbegin', feedRow(x).replace('<div class="', '<div class="nw ')); while (f.children.length > 60) f.lastChild.remove(); }
  }
  if (type === 'audit' && S.view === 'tower' && S.audit) { S.audit.entries.unshift(x); S.audit.verify.entries++; soon(); }
  if (type === 'policy') {
    const was = S.policy && S.policy.active.version; S.policy = x;
    $('pv').textContent = `Policy v${S.policy.active.version}`;
    if (was && was !== S.policy.active.version) { $('pv').classList.add('flash'); setTimeout(() => $('pv').classList.remove('flash'), 1500); }
    render();
  }
}
function connect() {
  if (LOCAL) return LOCAL.subscribe((type, data) => setTimeout(() => onEvent(type, data)));
  const es = new EventSource('/api/stream');
  for (const t of ['app', 'activity', 'audit', 'policy']) es.addEventListener(t, e => onEvent(t, JSON.parse(e.data)));
}

setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour12: false }) + ' SGT'; }, 1000);
setInterval(async () => { if (S.view === 'overview') { S.metrics = await api('/api/metrics'); if (!document.querySelector('#view :focus')) { const f = $('feed'), st = f && f.scrollTop; render(); if ($('feed')) $('feed').scrollTop = st || 0; } } }, 5000);
setInterval(() => { if (S.view === 'approvals') soon(); }, 30000);

(async function init() {
  S.users = await api('/api/users');
  if (!S.users[S.user]) S.user = 'priya';
  $('user').innerHTML = Object.values(S.users).map(u => `<option value="${u.id}" ${u.id === S.user ? 'selected' : ''}>${esc(u.name)} · ${esc(u.title)}</option>`).join('');
  const [apps, policy, feed] = await Promise.all([api('/api/applications'), api('/api/policy'), api('/api/activity')]);
  apps.forEach(a => S.apps.set(a.id, a));
  S.feed = feed;
  S.policy = policy; $('pv').textContent = `Policy v${policy.active.version}`;
  S.view = location.hash.slice(1) || 'overview'; if (!V[S.view]) S.view = 'overview';
  if (LOCAL) {
    $('pv').insertAdjacentHTML('beforebegin', '<button class="reset" id="reset" title="Start a fresh shift">Reset demo</button>');
    $('reset').onclick = () => location.reload();
  }
  await load(S.view); render(); connect();
  const deep = new URLSearchParams(location.search).get('open');
  if (deep) openApp(deep);
})();

// Lionsgate Bank SME credit desk: serves the console and its API. The policy engine endpoint
// (POST /api/policy/evaluate) is also the tool the Orchestrate agents call — see orchestrate/.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const desk = require('./lib/desk');

const PORT = process.env.PORT || 3100;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.yaml': 'text/yaml' };

// Access control for hosted deployments. Locally both are unset and everything is open.
// TOOL_API_KEY: Orchestrate sends it as x-api-key, and it opens only the three agent tools.
// DEMO_PASSWORD: basic-auth password for the console and every other route (any username).
const TOOL_API_KEY = process.env.TOOL_API_KEY || '', DEMO_PASSWORD = process.env.DEMO_PASSWORD || '';
const TOOL_ROUTES = [['POST', /^\/api\/policy\/evaluate$/], ['GET', /^\/api\/applications$/], ['GET', /^\/api\/applications\/[\w-]+$/]];
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function allowed(req, url) {
  if (!TOOL_API_KEY && !DEMO_PASSWORD) return true;
  if (TOOL_API_KEY && req.headers['x-api-key'] && same(req.headers['x-api-key'], TOOL_API_KEY))
    return TOOL_ROUTES.some(([m, re]) => m === req.method && re.test(url));
  if (!DEMO_PASSWORD) return false;
  const [scheme, enc] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !enc) return false;
  const pass = Buffer.from(enc, 'base64').toString().split(':').slice(1).join(':');
  return same(pass, DEMO_PASSWORD);
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const body = req => new Promise((ok, bad) => {
  let s = ''; req.on('data', c => (s += c)); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(Object.assign(e, { status: 400 })); } });
});

const routes = require('./lib/routes');

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (!allowed(req, url)) {
    res.writeHead(401, { 'content-type': 'application/json', ...(DEMO_PASSWORD && !req.headers['x-api-key'] ? { 'www-authenticate': 'Basic realm="Lionsgate SME Credit Desk"' } : {}) });
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }
  if (url === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    desk.S.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); desk.S.clients.delete(res); });
    return;
  }
  for (const [method, re, fn] of routes) {
    const m = url.match(re);
    if (m && req.method === method) {
      try { return json(res, 200, await fn(m, method === 'POST' ? await body(req) : {})); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
  }
  if (url === '/openapi.yaml') {
    res.writeHead(200, { 'content-type': 'text/yaml' }); return fs.createReadStream(path.join(__dirname, 'orchestrate/policy-engine-openapi.yaml')).pipe(res);
  }
  const file = path.join(PUB, url === '/' ? 'index.html' : url);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  desk.startSimulation();
  console.log(`Lionsgate Bank SME credit desk on http://localhost:${PORT}` +
    `${DEMO_PASSWORD ? ' · console password on' : ''}${TOOL_API_KEY ? ' · tool API key on' : ''}`);
});

// Tests client pages under docs/c/: the EGATE page talks to its configured API; a page with no config shows "Setup incomplete".
const { chromium } = require('playwright'); const path = require('path'), fs = require('fs'), http = require('http'), crypto = require('crypto');
const C = require('../src/core.js');
const root = path.join(__dirname, '..', 'docs');
const cfg = fs.readFileSync(path.join(root, 'c/egate/config.js'), 'utf8');
const API = /apiUrl:\s*'([^']+)'/.exec(cfg)[1];
const db = { employees: [], branches: [], records: [], audit: [], settings: {} }, ss = {}, cn = {};
const fmt = (d, tz, o) => new Intl.DateTimeFormat('en-CA', Object.assign({ timeZone: tz }, o)).format(d);
const app = C.createApp({ store: { list: t => db[t], insert: (t, o) => db[t].push(o), update: (t, id, p) => db[t].forEach(o => { if (o.id === id) Object.assign(o, p); }), remove: (t, id) => { db[t] = db[t].filter(o => o.id !== id); }, getSettings: () => db.settings, saveSettings: s => { db.settings = s; }, sessionPut: (k, v) => { ss[k] = v; }, sessionGet: k => ss[k] || null, sessionDel: k => { delete ss[k]; }, counterGet: k => cn[k] || 0, counterSet: (k, v) => { cn[k] = v; } },
  now: () => new Date(), newId: () => crypto.randomUUID(), newToken: () => crypto.randomBytes(24).toString('hex'), tzDate: (d, tz) => fmt(d, tz, { year: 'numeric', month: '2-digit', day: '2-digit' }), tzTime: (d, tz) => fmt(d, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), validTz: () => true, lock: f => f() });
app.bootstrap({ adminPin: '583920', settings: { companyName: 'EGATE Beloun Demo', timezone: 'Africa/Tripoli', workStart: '09:00', workEnd: '17:00', graceMinutes: 10, workDays: [1, 2, 3, 4, 5], geofenceMode: 'flag' } });
fs.mkdirSync(path.join(root, 'c/zz-test'), { recursive: true }); fs.copyFileSync(path.join(root, 'app/index.html'), path.join(root, 'c/zz-test/index.html'));
const server = http.createServer((q, s) => { let p = q.url.split('?')[0]; if (p.endsWith('/')) p += 'index.html'; const f = path.join(root, p); if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); fs.createReadStream(f).pipe(s); });
(async () => {
  await new Promise(r => server.listen(8126, r));
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await b.newPage(); let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL', n); } };
  await page.route(API, async r => { const x = JSON.parse(r.request().postData()); await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(app.handle(x.action, x.payload, x.token)) }); });
  await page.goto('http://localhost:8126/c/egate/'); await page.waitForSelector('#lf');
  ok('EGATE branding', /EGATE Beloun/.test(await page.textContent('.lg-side')));
  ok('live mode (no demo logins)', !(await page.$('[data-demo]')));
  await page.fill('#lc', 'ADMIN'); await page.fill('#lp', '583920'); await page.click('#lb');
  await page.waitForSelector('[name=newPin]'); ok('forced PIN change', true);
  await page.fill('[name=oldPin]', '583920'); await page.fill('[name=newPin]', '7391'); await page.fill('[name=newPin2]', '7391'); await page.click('#msave');
  await page.waitForSelector('.kpis'); ok('dashboard loads', /EGATE Beloun Demo/.test(await page.textContent('.side-foot')));
  await page.goto('http://localhost:8126/c/zz-test/'); await page.waitForSelector('h2');
  ok('missing config shows Setup incomplete', /Setup incomplete/.test(await page.textContent('#app')));
  await page.goto('http://localhost:8126/app/'); await page.waitForSelector('[data-demo]'); ok('demo still works', true);
  await page.goto('http://localhost:8126/'); ok('landing page restored', /your own/.test(await page.textContent('h1')));
  console.log(`\nClient-page tests: ${pass} passed, ${fail} failed`);
  await b.close(); server.close(); fs.rmSync(path.join(root, 'c/zz-test'), { recursive: true }); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); fs.rmSync(path.join(root, 'c/zz-test'), { recursive: true, force: true }); process.exit(1); });

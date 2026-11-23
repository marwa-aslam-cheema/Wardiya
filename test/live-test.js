// Tests the LIVE mode front end: config.js with apiUrl + branding, talking over fetch (text/plain JSON) to an API.
// The API here is the real core logic with an in-memory store, standing in for the Apps Script web app.
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const C = require('../src/core.js');
const crypto = require('crypto');

const db = { employees: [], branches: [], records: [], audit: [], settings: {} }, sess = {}, cnt = {};
const store = {
  list: t => db[t], insert: (t, o) => db[t].push(o), update: (t, id, p) => db[t].forEach(o => { if (o.id === id) Object.assign(o, p); }),
  remove: (t, id) => { db[t] = db[t].filter(o => o.id !== id); }, getSettings: () => db.settings, saveSettings: s => { db.settings = s; },
  sessionPut: (k, v) => { sess[k] = v; }, sessionGet: k => sess[k] || null, sessionDel: k => { delete sess[k]; }, counterGet: k => cnt[k] || 0, counterSet: (k, v) => { cnt[k] = v; }
};
const fmt = (d, tz, o) => new Intl.DateTimeFormat('en-CA', Object.assign({ timeZone: tz }, o)).format(d);
const app = C.createApp({
  store, now: () => new Date(), newId: () => crypto.randomUUID(), newToken: () => crypto.randomBytes(24).toString('hex'),
  tzDate: (d, tz) => fmt(d, tz, { year: 'numeric', month: '2-digit', day: '2-digit' }),
  tzTime: (d, tz) => fmt(d, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  validTz: () => true, lock: f => f()
});
app.bootstrap({ adminPin: '482613', settings: { companyName: 'Live Test Co', timezone: 'Asia/Dubai', workStart: '09:00', workEnd: '17:00', graceMinutes: 10, workDays: [0, 1, 2, 3, 4, 5, 6], geofenceMode: 'off' } });

const API = 'https://script.google.com/macros/s/TEST/exec';
const cfgPath = path.join(__dirname, '..', 'docs/app/config.js');
fs.writeFileSync(cfgPath, `window.WARDIYA_CONFIG = { apiUrl: '${API}', appName: 'Acme Time', brandColor: '#1D4ED8' };`);

(async () => {
  const http = require('http');
  const root = path.join(__dirname, '..', 'docs');
  const server = http.createServer((req, res) => { let p = req.url.split('?')[0]; if (p.endsWith('/')) p += 'index.html'; const f = path.join(root, p); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); fs.createReadStream(f).pipe(res); });
  await new Promise(r => server.listen(8124, r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  let calls = 0, badContentType = 0;
  await page.route(API, async route => {
    const req = route.request();
    if (!/^text\/plain/.test(req.headers()['content-type'] || '')) badContentType++;
    const b = JSON.parse(req.postData()); calls++;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(app.handle(b.action, b.payload, b.token)) });
  });
  let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL', n); } };
  await page.goto('http://localhost:8124/app/');
  await page.waitForSelector('#lf');
  ok('no demo cards in live mode', !(await page.$('[data-demo]')));
  ok('app name branding', /Acme Time/.test(await page.textContent('.lg-side .logo')));
  ok('brand colour', (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--p'))).trim() === '#1D4ED8');
  await page.fill('#lc', 'ADMIN'); await page.fill('#lp', '482613'); await page.click('#lb');
  await page.waitForSelector('[name=newPin]');
  ok('forced PIN change in live mode', true);
  await page.fill('[name=oldPin]', '482613'); await page.fill('[name=newPin]', '7391'); await page.fill('[name=newPin2]', '7391'); await page.click('#msave');
  await page.waitForSelector('.kpis');
  ok('dashboard over network', calls > 3);
  ok('no banner in live mode', !(await page.$('.banner')));
  await page.click('[data-go=clock] >> visible=true'); await page.waitForSelector('#cb'); await page.click('#cb');
  await page.waitForFunction(() => /Check out/.test(document.querySelector('#cb')?.textContent || ''), null, { timeout: 20000 });
  ok('check-in recorded on server', db.records.length === 1);
  ok('text/plain requests (no CORS preflight)', badContentType === 0);
  // network failure handling
  await page.unroute(API); await page.route(API, r => r.abort());
  await page.waitForTimeout(4500); await page.click('#cb');
  ok('network error shown', await page.waitForFunction(() => [...document.querySelectorAll('.toast.bad')].some(t => /internet|server/i.test(t.textContent)), null, { timeout: 20000 }).then(() => true, () => false));
  console.log(`\nLive-mode tests: ${pass} passed, ${fail} failed`);
  await browser.close(); server.close(); fs.unlinkSync(cfgPath);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.unlinkSync(cfgPath); } catch (x) { } process.exit(1); });

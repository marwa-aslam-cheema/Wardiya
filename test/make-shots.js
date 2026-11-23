// Captures real screenshots of the demo for the landing page.
const { chromium } = require('playwright'); const path = require('path'), http = require('http'), fs = require('fs');
const root = path.join(__dirname, '..', 'docs');
const server = http.createServer((q, s) => { let p = q.url.split('?')[0]; if (p.endsWith('/')) p += 'index.html'; const f = path.join(root, p); if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.png') ? 'image/png' : 'text/html' }); fs.createReadStream(f).pipe(s); });
(async () => {
  await new Promise(r => server.listen(8125, r));
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const c = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, timezoneId: 'Asia/Dubai', geolocation: { latitude: 25.2049, longitude: 55.2709 }, permissions: ['geolocation'] });
  const p = await c.newPage();
  await p.goto('http://localhost:8125/app/'); await p.click('[data-demo="ADMIN|1234"]'); await p.waitForSelector('.kpis');
  await p.evaluate(() => document.querySelector('.banner')?.remove()); await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(root, 'assets/dashboard.png') });
  const m = await b.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, timezoneId: 'Asia/Dubai', geolocation: { latitude: 25.2049, longitude: 55.2709 }, permissions: ['geolocation'] });
  const q = await m.newPage(); await q.goto('http://localhost:8125/app/'); await q.click('[data-demo="E001|1111"]'); await q.waitForSelector('#cb');
  await q.evaluate(() => document.querySelector('.banner')?.remove()); await q.waitForTimeout(400);
  await q.screenshot({ path: path.join(root, 'assets/mobile.png') });
  const l = await b.newContext({ viewport: { width: 1280, height: 800 } }); const lp = await l.newPage();
  await lp.goto('http://localhost:8125/'); await lp.waitForTimeout(600);
  await lp.screenshot({ path: path.join(__dirname, 'landing-check.png'), fullPage: true });
  await b.close(); server.close();
})();

// Personalised demo links: /app/?co=...&color=...&type=...&city=...
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'docs');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('FAIL', m); } }
const srv = http.createServer((q, r) => { let f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(d); } }); }).listen(0);
(async () => {
  const base = 'http://localhost:' + srv.address().port;
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(base + '/app/?co=Daju%20Bhai%20Group&color=1a5fb4&type=security&city=Doha');
  await p.waitForSelector('.demo-card');
  ok((await p.textContent('#login')).includes('Daju Bhai Group'), 'company name on login');
  ok((await p.textContent('.hint')).includes('Personal demo for Daju Bhai Group'), 'personal hint');
  ok((await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--p').trim())) === '#1a5fb4', 'brand colour');
  await p.click('[data-demo^="ADMIN"]');
  await p.waitForSelector('.side-foot');
  ok((await p.textContent('.side-foot')).includes('Daju Bhai Group'), 'company in sidebar');
  await p.click('[data-go=branches] >> visible=true');
  await p.waitForTimeout(400);
  const body = await p.textContent('#app');
  ok(body.includes('Tower A') && body.includes('Doha'), 'security sites in Doha');
  await p.click('[data-go=employees] >> visible=true');
  await p.waitForTimeout(400);
  ok((await p.textContent('#app')).includes('Guard'), 'security departments');
  // plain demo is untouched and separate
  await p.goto(base + '/app/');
  await p.waitForSelector('.demo-card');
  ok(!(await p.textContent('#login')).includes('Daju'), 'plain demo not branded');
  ok(!(await p.textContent('.hint')).includes('Personal demo'), 'plain demo hint');
  // hostile input is cleaned
  await p.goto(base + '/app/?co=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3EEvil&color=zzz');
  await p.waitForSelector('.demo-card');
  ok(!(await p.$('#login img[src="x"]')), 'no injected image');
  ok(errs.length === 0, 'no page errors: ' + errs.join('; '));
  await b.close(); srv.close();
  console.log(`\nPersonal demo tests: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();

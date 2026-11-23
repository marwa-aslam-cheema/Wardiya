// Browser test of the demo app (real Chrome via Playwright). Usage: node test/ui-test.js
const { chromium } = require('playwright');
const path = require('path');
const http = require('http'), fs = require('fs');
const root = path.join(__dirname, '..', 'docs');

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(8123, r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ geolocation: { latitude: 25.2049, longitude: 55.2709 }, permissions: ['geolocation'], timezoneId: 'Asia/Dubai', viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts|ERR_|404/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  let pass = 0, fail = 0;
  const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL', n); } };
  const shot = (n) => page.screenshot({ path: path.join(__dirname, 'shots', n + '.png'), fullPage: false });
  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });

  await page.goto('http://localhost:8123/app/');
  await page.waitForSelector('#lf');
  await shot('01-login');
  // wrong PIN
  await page.fill('#lc', 'E001'); await page.fill('#lp', '9999'); await page.click('#lb');
  await page.waitForSelector('.err'); ok('wrong pin error', /Wrong/.test(await page.textContent('.err')));
  // employee demo
  await page.click('[data-demo="E001|1111"]');
  await page.waitForSelector('#cb');
  await shot('02-employee-clock');
  ok('check in button', /Check in/.test(await page.textContent('#cb')));
  await page.fill('#cn', 'Arrived by metro');
  await page.click('#cb');
  await page.waitForFunction(() => /Check out/.test(document.querySelector('#cb')?.textContent || ''));
  ok('checked in', true);
  await shot('03-employee-checked-in');
  await page.click('#cb');
  await page.waitForFunction(() => /Check in/.test(document.querySelector('#cb')?.textContent || ''));
  ok('checked out', (await page.$$('.sessions .li')).length >= 2);
  await page.click('[data-go=history] >> visible=true');
  await page.waitForSelector('#hm'); ok('history table', (await page.$$('tbody tr')).length > 3);
  await page.click('#lo');
  // admin
  await page.waitForSelector('#lf');
  await page.click('[data-demo="ADMIN|1234"]');
  await page.waitForSelector('.kpis');
  await page.waitForTimeout(200);
  await shot('04-admin-dashboard');
  ok('dashboard bars', (await page.$$('.bar')).length === 14);
  ok('present includes E001', /Omar Khalil/.test(await page.textContent('#view')));
  // attendance log
  await page.click('[data-go=attendance] >> visible=true');
  await page.waitForSelector('#fx');
  const rows = (await page.$$('tbody tr')).length; ok('attendance rows', rows > 20);
  await shot('05-attendance');
  // edit first row without reason -> error, then with reason
  await page.click('[data-edit] >> nth=0');
  await page.waitForSelector('.modal');
  await page.fill('[name=inTime]', '08:55');
  await page.click('#msave');
  await page.waitForSelector('#merr:not(.hidden)'); ok('reason required', /reason/i.test(await page.textContent('#merr')));
  await page.fill('[name=reason]', 'Badge reader issue');
  await page.click('#msave');
  await page.waitForSelector('.modal', { state: 'detached' });
  ok('edited pill', await page.waitForFunction(() => /Edited|Manual/.test(document.querySelector('tbody').textContent), null, {timeout:3000}).then(()=>true,()=>false));
  // CSV export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#fx')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8'); ok('csv export', csv.split('\n').length > 10 && /Date,|"Date"/.test(csv));
  // status filter
  await page.selectOption('#fs', 'late'); await page.waitForTimeout(300);
  ok('late filter', (await page.$$('tbody .pill.a')).length > 0);
  // employees: add
  await page.click('[data-go=employees] >> visible=true');
  await page.waitForSelector('#ea');
  await page.click('#ea');
  await page.fill('[name=code]', 'E013'); await page.fill('[name=name]', 'Test Person'); await page.fill('[name=pin]', '12');
  await page.click('#msave'); await page.waitForSelector('#merr:not(.hidden)'); ok('pin validation', /PIN/.test(await page.textContent('#merr')));
  await page.fill('[name=pin]', '4826'); await page.click('#msave');
  await page.waitForSelector('.modal', { state: 'detached' });
  ok('employee added', await page.waitForFunction(() => /Test Person/.test(document.querySelector('#eb')?.textContent||''), null, {timeout:3000}).then(()=>true,()=>false));
  await shot('06-employees');
  // import
  await page.click('#ei'); await page.fill('[name=csv]', 'E014,Imported One,Sales,Downtown Clinic,5937\nE015,Bad,X,Nowhere,5937');
  await page.click('#msave'); await page.waitForSelector('#ir .err'); ok('import partial errors', /Nowhere/.test(await page.textContent('#ir')));
  await page.click('[data-x]');
  // branches: add with my location
  await page.click('[data-go=branches] >> visible=true');
  await page.waitForSelector('#ba'); await page.click('#ba');
  await page.fill('[name=name]', 'Test Branch'); await page.click('#myl');
  await page.waitForFunction(() => document.querySelector('[name=lat]').value !== '');
  await page.click('#msave'); await page.waitForSelector('.modal', { state: 'detached' });
  ok('branch added', await page.waitForFunction(() => /Test Branch/.test(document.querySelector('#view').textContent), null, {timeout:3000}).then(()=>true,()=>false));
  await shot('07-branches');
  // reports
  await page.click('[data-go=reports] >> visible=true');
  await page.waitForSelector('#rx'); ok('report rows', (await page.$$('tbody tr')).length >= 12);
  await shot('08-report');
  // settings: invalid then valid
  await page.click('[data-go=settings] >> visible=true');
  await page.waitForSelector('#sf');
  await page.$$eval('[name=wd]', els => els.forEach(e => e.checked = false));
  await page.click('#ss'); await page.waitForSelector('#serr:not(.hidden)'); ok('settings validation', /working day/.test(await page.textContent('#serr')));
  await page.check('[name=wd][value="1"]'); await page.fill('[name=companyName]', 'Gulf Dental Care'); await page.click('#ss');
  await page.waitForSelector('#serr.hidden', { state: 'attached' }); ok('settings saved', /Gulf Dental Care/.test(await page.textContent('.side-foot')));
  // audit
  await page.click('[data-go=audit] >> visible=true');
  await page.waitForSelector('tbody'); ok('audit entries', /Badge reader issue/.test(await page.textContent('tbody')));
  // Arabic
  await page.click('[data-lang]'); await page.waitForTimeout(200);
  ok('rtl', await page.evaluate(() => document.documentElement.dir === 'rtl'));
  await page.click('[data-go=dashboard] >> visible=true'); await page.waitForSelector('.kpis'); await page.waitForTimeout(200);
  await shot('09-dashboard-arabic');
  await page.click('[data-lang]');
  // new employee forced PIN change
  await page.click('#lo'); await page.waitForSelector('#lf');
  await page.fill('#lc', 'E013'); await page.fill('#lp', '4826'); await page.click('#lb');
  await page.waitForSelector('[name=newPin]'); ok('forced pin change', true);
  await page.fill('[name=oldPin]', '4826'); await page.fill('[name=newPin]', '7391'); await page.fill('[name=newPin2]', '7391'); await page.click('#msave');
  await page.waitForSelector('.overlay', { state: 'detached' }); await page.waitForSelector('#cb'); ok('after pin change clock shown', true);
  // mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200); await shot('10-mobile-clock');
  await page.click('#lo'); await page.waitForSelector('#lf'); await page.click('[data-demo="ADMIN|1234"]'); await page.waitForSelector('.kpis'); await page.waitForTimeout(200);
  await shot('11-mobile-dashboard');
  ok('mobile nav visible', await page.isVisible('.mob-nav'));
  // reset demo
  await page.click('#rst'); await page.waitForSelector('#lf'); ok('reset demo', true);

  ok('no JS errors', errors.length === 0); if (errors.length) console.log(errors);
  console.log(`\nUI tests: ${pass} passed, ${fail} failed`);
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

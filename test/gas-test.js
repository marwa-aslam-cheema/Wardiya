// Runs the real Core.gs + Code.gs inside a mocked Google Apps Script runtime, then exercises the API end to end.
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');

let fakeNow = new Date('2026-11-23T05:12:00Z'); // 09:12 in Dubai (UTC+4)
function fmt(d, tz, pattern) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  if (p.hour === '24') p.hour = '00';
  return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
}
function chain(obj) { return new Proxy(obj, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? function () { return this; } : undefined)) }); }
function makeSheet(name) {
  const data = []; // array of rows
  const sh = {
    name, data, frozen: 0, hidden: false, checkboxes: [], validations: [],
    getName: () => name,
    getLastRow: () => { for (let i = data.length - 1; i >= 0; i--) if ((data[i] || []).some(v => v !== '' && v !== undefined)) return i + 1; return 0; },
    getMaxRows: () => Math.max(1000, data.length),
    getRange: (r, c, nr = 1, nc = 1) => chain({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (data[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
      getDisplayValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (data[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : (v && v.__display) || (v instanceof Date ? '' : String(v)); })),
      getValue: () => { const v = (data[r - 1] || [])[c - 1]; return v === undefined ? '' : v; },
      setValues: function (vals) { vals.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((v, j) => data[r - 1 + i][c - 1 + j] = v); }); return this; },
      setValue: function (v) { data[r - 1] = data[r - 1] || []; data[r - 1][c - 1] = v; return this; },
      clearContent: function () { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r - 1 + i]) data[r - 1 + i][c - 1 + j] = ''; return this; },
      insertCheckboxes: function () { sh.checkboxes.push(r); return this; },
      setDataValidation: function () { sh.validations.push(r); return this; },
      getSheet: () => sh, getRow: () => r, getColumn: () => c
    }),
    deleteRow: (r) => data.splice(r - 1, 1),
    setFrozenRows: (n) => { sh.frozen = n; }, hideColumns: () => {}, hideSheet: () => { sh.hidden = true; }
  };
  return chain(sh);
}
const sheets = { Sheet1: makeSheet('Sheet1') };
const ss = {
  getName: () => 'Acme Clinic', getSpreadsheetTimeZone: () => 'Asia/Dubai',
  getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)),
  getSheets: () => Object.values(sheets), deleteSheet: (s) => { delete sheets[s.name]; }
};
const cache = {};
let lockHeld = false;
const ctx = {
  console, Intl, JSON, Math, Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(fakeNow.getTime()); } static now() { return fakeNow.getTime(); } },
  unescape, encodeURIComponent,
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush: () => {}, getUi: () => { throw new Error('no ui'); }, newDataValidation: () => chain({ build: () => ({}) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  Utilities: { formatDate: fmt, getUuid: () => crypto.randomUUID() },
  
  CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v, t) => { if (t > 21600) throw new Error('ttl too big'); cache[k] = v; }, remove: k => delete cache[k] }) },
  LockService: { getScriptLock: () => ({ waitLock: () => { if (lockHeld) throw new Error('lock re-entered'); lockHeld = true; }, releaseLock: () => { lockHeld = false; } }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ content: s, setMimeType() { return this; } }) },
  Logger: { log: (m) => { ctx.__log.push(m); } }, __log: []
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'backend/Core.gs'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'backend/Code.gs'), 'utf8'), ctx);

let pass = 0, failN = 0;
function check(name, cond, info) { if (cond) pass++; else { failN++; console.log('FAIL:', name, info !== undefined ? JSON.stringify(info).slice(0, 400) : ''); } }
function call(action, payload, token) {
  const out = ctx.doPost({ postData: { contents: JSON.stringify({ action, payload, token }) } });
  return JSON.parse(out.content);
}

// --- setup
const msg = ctx.setup();
const pin = /Temporary PIN: (\d+)/.exec(msg)[1];
check('setup creates sheets', ['employees', 'branches', 'records', 'audit', 'Company Settings'].every(n => sheets[n]));
check('Sheet1 removed', !sheets.Sheet1);
check('setup idempotent', /already exists/.test(ctx.setup()));
check('pin not stored in plain text', !JSON.stringify(sheets.employees.data).includes(pin));
const cs = sheets['Company Settings'];
const csRow = key => cs.data.findIndex(r => r && r[3] === key) + 1;
check('Company Settings tab created', !!cs && csRow('companyName') > 0 && csRow('workSun') > 0);
check('company name from sheet title', cs.data[csRow('companyName') - 1][1] === 'Acme Clinic');
check('day rows are checkboxes', cs.checkboxes.length === 7);
check('location rule is a dropdown', cs.validations.length === 1);
check('template defaults: Sun–Thu, block', cs.data[csRow('workSun') - 1][1] === true && cs.data[csRow('workFri') - 1][1] === false && cs.data[csRow('geofenceMode') - 1][1] === 'block');
check('main location skipped without coordinates', /skipped/.test(msg));


// --- login flow
check('bad login', call('login', { code: 'admin', pin: '000000' }).code === 'BAD_LOGIN');
let r = call('login', { code: 'admin', pin });
check('admin login', r.ok, r);
let admin = r.data.token;
check('must change pin enforced', call('dashboard', {}, admin).code === 'MUST_CHANGE_PIN');
check('weak pin rejected', call('changePin', { oldPin: pin, newPin: '1111' }, admin).code === 'VALIDATION');
check('change pin', call('changePin', { oldPin: pin, newPin: '4826' }, admin).ok);
check('dashboard after change', call('dashboard', {}, admin).ok);

// --- settings + branch + employee
r = call('saveSettings', { companyName: 'Acme Clinic', timezone: 'Asia/Dubai', workStart: '09:00', workEnd: '17:00', graceMinutes: 10, workDays: [1, 2, 3, 4, 5], geofenceMode: 'block' }, admin);
check('save settings', r.ok, r);
check('bad tz rejected', call('saveSettings', { timezone: 'Mars/Base', workStart: '09:00', workEnd: '17:00', graceMinutes: 5, workDays: [1] }, admin).code === 'VALIDATION');
// sheet edits are read by the app
cs.data[csRow('workStart') - 1][1] = Object.assign(new ctx.Date('1899-12-30T05:30:00Z'), { __display: '9:30 AM' }); // a time typed into a time-formatted cell
cs.data[csRow('welcomeMessage') - 1][1] = 'Welcome to Acme';
cs.data[csRow('logoUrl') - 1][1] = 'https://example.com/logo.png';
r = call('getSettings', {}, admin);
check('time typed in sheet read as HH:MM', r.data.workStart === '09:30', r.data.workStart);
check('workDays from checkboxes', JSON.stringify(r.data.workDays) === '[1,2,3,4,5]', r.data.workDays);
check('info shows branding before login', (() => { const i = call('info'); return i.ok && i.data.welcomeMessage === 'Welcome to Acme' && i.data.logoUrl === 'https://example.com/logo.png' && i.data.brandColor === '#0E7C66'; })());
r = call('saveSettings', { appName: 'Acme Time', brandColor: '#1D4ED8', lateMessage: 'Please be on time', earlyLeaveMinutes: 15 }, admin);
check('partial save from app', r.ok && r.data.appName === 'Acme Time', r);
check('saved into sheet cells', cs.data[csRow('appName') - 1][1] === 'Acme Time' && cs.data[csRow('brandColor') - 1][1] === '#1D4ED8' && cs.data[csRow('earlyLeaveMinutes') - 1][1] === 15);
check('labels kept', cs.data[csRow('appName') - 1][0] === 'App name (shown in the header)');
check('bad colour rejected', call('saveSettings', { brandColor: 'blue' }, admin).code === 'VALIDATION');
check('bad logo rejected', call('saveSettings', { logoUrl: 'javascript:alert(1)' }, admin).code === 'VALIDATION');
call('saveSettings', { workStart: '09:00' }, admin);
r = call('saveBranch', { name: 'Dubai Marina', address: 'Marina', lat: 25.0800, lng: 55.1400, radius: 150 }, admin);
check('add branch', r.ok, r);
const br = r.data.id;
check('bad branch radius', call('saveBranch', { name: 'X', lat: 25, lng: 55, radius: 5 }, admin).code === 'VALIDATION');
r = call('saveEmployee', { code: 'e001', name: 'Sara Ahmed', department: 'Reception', branchId: br, pin: '2580', email: 'sara@example.com' }, admin);
check('add employee', r.ok, r);
const empId = r.data.id;
check('dup code', call('saveEmployee', { code: 'E001', name: 'Dup', pin: '1234' }, admin).code === 'DUPLICATE');
check('formula injection neutralised', (call('saveEmployee', { code: 'E009', name: '=HYPERLINK("x")', pin: '2468' }, admin), sheets.employees.data.some(row => String(row[2]).startsWith("'="))));
r = call('importEmployees', { csv: 'code,name,department,branch,pin\nE002,Omar Ali,Nursing,Dubai Marina,1357\nE003,Bad Branch,X,Nowhere,1357\nE004,No Pin,X,,' }, admin);
check('import partial', r.ok && r.data.added === 1 && r.data.errors.length === 2, r);

// --- employee check-in with geofence
r = call('login', { code: 'E001', pin: '2580' });
let emp = r.data.token;
check('new employee must change pin', call('checkIn', {}, emp).code === 'MUST_CHANGE_PIN');
call('changePin', { oldPin: '2580', newPin: '7392' }, emp);
check('employee cannot see dashboard', call('dashboard', {}, emp).code === 'FORBIDDEN');
check('location required (block mode)', call('checkIn', {}, emp).code === 'LOCATION_REQUIRED');
r = call('checkIn', { lat: 25.2, lng: 55.3 }, emp);
check('outside geofence blocked', r.code === 'OUTSIDE_GEOFENCE', r);
r = call('checkIn', { lat: 25.0805, lng: 55.1402, acc: 20, note: 'Morning' }, emp);
check('check in inside fence', r.ok, r);
check('late flagged (09:12 > 09:10)', r.ok && r.data.late === true && r.data.record.lateMin === 12, r.data && r.data.record);
check('double check-in blocked', call('checkIn', { lat: 25.0805, lng: 55.1402 }, emp).code === 'ALREADY_IN');
fakeNow = new Date('2026-11-23T13:30:00Z'); // 17:30 Dubai
r = call('checkOut', { lat: 25.0801, lng: 55.1401 }, emp);
check('check out', r.ok && r.data.minutes === 498, r);
// next day: early leave and earliest check-in
call('saveSettings', { earliestCheckInMinutes: 60 }, admin);
fakeNow = new Date('2026-11-24T04:00:00Z'); // 08:00 Dubai, check-in opens 09:00-60 = 08:00
emp = call('login', { code: 'E001', pin: '7392' }).data.token;
r = call('checkIn', { lat: 25.0805, lng: 55.1402, acc: 10 }, emp);
check('check-in allowed at opening time', r.ok, r);
fakeNow = new Date('2026-11-24T12:00:00Z'); // 16:00 Dubai, work ends 17:00, allowance 15
r = call('checkOut', { lat: 25.0805, lng: 55.1402 }, emp);
check('early leave recorded', r.ok && r.data.early === true && r.data.record.earlyMin === 60, r.data && r.data.record);
fakeNow = new Date('2026-11-25T03:30:00Z'); // 07:30 Dubai
emp = call('login', { code: 'E001', pin: '7392' }).data.token;
r = call('checkIn', { lat: 25.0805, lng: 55.1402 }, emp);
check('too early blocked', r.code === 'TOO_EARLY', r);
fakeNow = new Date('2026-11-23T13:30:00Z');
check('reset earliest check-in', call('saveSettings', { earliestCheckInMinutes: 0 }, admin).ok);
emp = call('login', { code: 'E001', pin: '7392' }).data.token;
check('double check-out blocked', call('checkOut', { lat: 25.08, lng: 55.14 }, emp).code === 'NOT_IN');
r = call('me', {}, emp);
check('me status', r.ok && r.data.todayMinutes === 498 && !r.data.open, r);
check('early-leave column stored', sheets.records.data[2] && sheets.records.data[2][22] === 60, sheets.records.data[2]);
check('time stored as text', sheets.records.data[1][5] === '09:12' && sheets.records.data[1][3] === '2026-11-23', sheets.records.data[1]);

// --- admin views
r = call('dashboard', {}, admin);
check('dashboard kpis', r.ok && r.data.kpi.present === 1 && r.data.kpi.late === 1 && r.data.kpi.activeEmployees === 3, r.data && r.data.kpi);
r = call('listRecords', { from: '2026-11-01', to: '2026-11-30' }, admin);
check('list records', r.ok && r.data.records.length === 2 && r.data.records[0].empName === 'Sara Ahmed', r);
const recId = r.data.records.find(x => x.date === '2026-11-23').id;
check('edit needs reason', call('saveRecord', { id: recId, date: '2026-11-23', inTime: '09:00', outTime: '17:30' }, admin).code === 'VALIDATION');
r = call('saveRecord', { id: recId, type: 'work', date: '2026-11-23', inTime: '09:05', outTime: '17:30', reason: 'Forgot badge, confirmed by manager' }, admin);
check('edit record', r.ok, r);
r = call('listRecords', { from: '2026-11-23', to: '2026-11-23' }, admin);
check('edit recalculates lateness (within grace)', r.data.records[0].lateMin === 0 && r.data.records[0].editedBy === 'ADMIN', r.data.records[0]);
r = call('saveRecord', { empId: empId, type: 'leave', date: '2026-11-24', reason: 'Annual leave' }, admin);
check('add leave', r.ok, r);
check('manual entry invalid time', call('saveRecord', { empId: empId, type: 'work', date: '2026-11-20', inTime: '25:00', reason: 'x' }, admin).code === 'VALIDATION');
r = call('monthlyReport', { month: '2026-11' }, admin);
const row = r.ok && r.data.rows.find(x => x.code === 'E001');
check('monthly report', row && row.present === 2 && row.leave === 1 && row.earlyLeaveDays === 1 && row.workingDays === 16, row || r);
r = call('listAudit', {}, admin);
check('audit trail', r.ok && r.data.some(a => a.action === 'record_edited' && /Forgot badge/.test(a.detail)), r);
check('deactivate self blocked', call('setEmployeeActive', { id: call('listEmployees', {}, admin).data.find(e => e.code === 'ADMIN').id, active: false }, admin).code === 'VALIDATION');
check('delete branch in use blocked', call('deleteBranch', { id: br }, admin).code === 'IN_USE');
r = call('setEmployeeActive', { id: empId, active: false }, admin);
check('deactivate employee', r.ok);
check('deactivated session rejected', call('me', {}, emp).code === 'AUTH');
check('deactivated login rejected', call('login', { code: 'E001', pin: '7392' }).code === 'BAD_LOGIN');
check('no secrets in employee list', !JSON.stringify(call('listEmployees', {}, admin)).includes('pinHash'));
r = call('deleteRecord', { id: recId, reason: 'Duplicate test' }, admin);
check('delete record', r.ok && call('listRecords', { from: '2026-11-23', to: '2026-11-23' }, admin).data.records.length === 0);

// --- lockout
for (let i = 0; i < 5; i++) call('login', { code: 'E002', pin: '0000' });
check('lockout after 5 fails', call('login', { code: 'E002', pin: '1357' }).code === 'LOCKED');
check('logout', call('logout', {}, admin).ok && call('me', {}, admin).code === 'AUTH');
check('bad json', JSON.parse(ctx.doPost({ postData: { contents: 'nope' } }).content).code === 'BAD_REQUEST');
check('ping via GET', JSON.parse(ctx.doGet().content).ok);
check('lock released', lockHeld === false);
// archive
call('login',{code:'E002',pin:'1357'});
sheets.records.data.push(['old1','x','', '2025-03-02','work','09:00','17:00','','','','','','','','','','0','','','app','','']);
check('archive year', /Archived 1 records/.test(ctx.archiveYear(2025)) && sheets.records_archive_2025 && !sheets.records.data.some(r => r[0]==='old1'));
check('resetAdminPin', /Temporary PIN/.test(ctx.resetAdminPin()));

// main location from the sheet
cs.data[csRow('mainLocationName') - 1][1] = 'Head Office';
cs.data[csRow('mainLatitude') - 1][1] = 25.2048;
cs.data[csRow('mainLongitude') - 1][1] = 55.2708;
cs.data[csRow('mainRadius') - 1][1] = 180;
check('apply main location', /saved/.test(ctx.applyMainLocation()) && sheets.branches.data.some(b => b[1] === 'Head Office' && b[5] === 180));
cs.data[csRow('mainRadius') - 1][1] = 250;
ctx.applyMainLocation();
check('apply main location updates, no duplicate', sheets.branches.data.filter(b => b[1] === 'Head Office').length === 1 && sheets.branches.data.find(b => b[1] === 'Head Office')[5] === 250);
// colour preview trigger
ctx.onEdit({ range: cs.getRange(csRow('accentColor'), 2) });
check('onEdit runs without error', true);
// migration of an older sheet (like EGATE)
for (const k of Object.keys(sheets)) delete sheets[k];
const legacy = ss.insertSheet('settings');
legacy.getRange(1, 1, 5, 2).setValues([['key', 'value'], ['companyName', '"EGATE Beloun Demo"'], ['timezone', '"Africa/Tripoli"'], ['workDays', '[1,2,3,4,5]'], ['geofenceMode', '"block"']]);
const m = ctx.setup();
const cs2 = sheets['Company Settings'], row2 = k => cs2.data.find(r => r && r[3] === k);
check('migration keeps old values', row2('companyName')[1] === 'EGATE Beloun Demo' && row2('geofenceMode')[1] === 'block' && row2('workMon')[1] === true && row2('workSun')[1] === false);
check('migration sets app name', row2('appName')[1] === 'EGATE Beloun Attendance');
check('old settings tab hidden', sheets.settings.hidden === true && /Temporary PIN/.test(m));
console.log(`\nApps Script backend tests: ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);

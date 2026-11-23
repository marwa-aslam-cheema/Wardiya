// Runs the real Core.gs + Code.gs inside a mocked Google Apps Script runtime, then exercises the API end to end.
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');

let fakeNow = new Date('2026-11-23T05:12:00Z'); // 09:12 in Dubai (UTC+4)
function fmt(d, tz, pattern) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  if (p.hour === '24') p.hour = '00';
  return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
}
function makeSheet(name) {
  const data = []; // array of rows
  const sh = {
    name, data, frozen: 0,
    getLastRow: () => { for (let i = data.length - 1; i >= 0; i--) if ((data[i] || []).some(v => v !== '' && v !== undefined)) return i + 1; return 0; },
    getMaxRows: () => Math.max(1000, data.length),
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (data[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
      setValues: function (vals) { vals.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((v, j) => data[r - 1 + i][c - 1 + j] = v); }); return this; },
      setNumberFormat: function () { return this; }, setFontWeight: function () { return this; }, setBackground: function () { return this; },
      clearContent: function () { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r - 1 + i]) data[r - 1 + i][c - 1 + j] = ''; return this; }
    }),
    deleteRow: (r) => data.splice(r - 1, 1),
    setFrozenRows: (n) => { sh.frozen = n; }, hideColumns: () => {}
  };
  return sh;
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
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush: () => {}, getUi: () => { throw new Error('no ui'); } },
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
check('setup creates sheets', ['employees', 'branches', 'records', 'audit', 'settings'].every(n => sheets[n]));
check('Sheet1 removed', !sheets.Sheet1);
check('setup idempotent', /already exists/.test(ctx.setup()));
check('pin not stored in plain text', !JSON.stringify(sheets.employees.data).includes(pin));

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
check('double check-out blocked', call('checkOut', { lat: 25.08, lng: 55.14 }, emp).code === 'NOT_IN');
r = call('me', {}, emp);
check('me status', r.ok && r.data.todayMinutes === 498 && !r.data.open, r);
check('time stored as text', sheets.records.data[1][5] === '09:12' && sheets.records.data[1][3] === '2026-11-23', sheets.records.data[1]);

// --- admin views
r = call('dashboard', {}, admin);
check('dashboard kpis', r.ok && r.data.kpi.present === 1 && r.data.kpi.late === 1 && r.data.kpi.activeEmployees === 3, r.data && r.data.kpi);
r = call('listRecords', { from: '2026-11-01', to: '2026-11-30' }, admin);
check('list records', r.ok && r.data.records.length === 1 && r.data.records[0].empName === 'Sara Ahmed', r);
const recId = r.data.records[0].id;
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
check('monthly report', row && row.present === 1 && row.hours === 8.4 && row.leave === 1 && row.workingDays === 16, row || r);
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

console.log(`\nApps Script backend tests: ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);

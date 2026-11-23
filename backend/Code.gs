/**
 * Wardiya Attendance — Google Apps Script backend (live mode).
 *
 * Files in this Apps Script project:
 *   Core.gs  -> business logic (copy of src/core.js, do not edit here)
 *   Code.gs  -> this file: Google Sheets storage + web API
 *
 * First run: choose function "setup" and press Run (see docs/CLIENT_INSTALL.md).
 */

var CACHE_MAX_SEC = 21600; // CacheService maximum (6 hours)

function getSpreadsheet_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) {
    var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('No spreadsheet found. Create this script from the Google Sheet (Extensions > Apps Script).');
    ss = SpreadsheetApp.openById(id);
  }
  return ss;
}

// ------------------------------------------------------------------ storage
function SheetStore_(ss) {
  var TABLES = WardiyaCore.TABLES;
  var cache = {}, rowIndex = {};
  var tz = ss.getSpreadsheetTimeZone();

  function sheet(name) {
    var sh = ss.getSheetByName(name);
    if (!sh) throw new Error('Sheet "' + name + '" is missing. Run setup() from the Apps Script editor.');
    return sh;
  }
  function fromCell(col, v) {
    if (v instanceof Date) {
      if (col === 'date') return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      if (col === 'inTime' || col === 'outTime') return Utilities.formatDate(v, tz, 'HH:mm');
      return v.toISOString();
    }
    return v;
  }
  function toCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean' || typeof v === 'number') return v;
    return String(v);
  }
  function list(t) {
    if (cache[t]) return cache[t];
    var sh = sheet(t), cols = TABLES[t], last = sh.getLastRow();
    var values = last < 2 ? [] : sh.getRange(2, 1, last - 1, cols.length).getValues();
    var out = [], idx = {};
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      if (r[0] === '' || r[0] === null) continue;
      var o = {};
      for (var j = 0; j < cols.length; j++) o[cols[j]] = fromCell(cols[j], r[j]);
      o.id = String(o.id);
      out.push(o);
      idx[o.id] = i + 2;
    }
    cache[t] = out; rowIndex[t] = idx;
    return out;
  }
  function insert(t, obj) {
    var sh = sheet(t), cols = TABLES[t];
    var row = sh.getLastRow() + 1;
    var range = sh.getRange(row, 1, 1, cols.length);
    range.setNumberFormat('@');
    range.setValues([cols.map(function (c) { return toCell(obj[c]); })]);
    delete cache[t];
    return obj;
  }
  function update(t, id, patch) {
    list(t);
    var row = rowIndex[t][String(id)];
    if (!row) throw new Error('Row not found: ' + t + ' ' + id);
    var cols = TABLES[t], cur = null;
    cache[t].forEach(function (o) { if (o.id === String(id)) cur = o; });
    var merged = {};
    for (var k in cur) merged[k] = cur[k];
    for (k in patch) merged[k] = patch[k];
    sheet(t).getRange(row, 1, 1, cols.length).setValues([cols.map(function (c) { return toCell(merged[c]); })]);
    delete cache[t];
    return merged;
  }
  function remove(t, id) {
    list(t);
    var row = rowIndex[t][String(id)];
    if (row) sheet(t).deleteRow(row);
    delete cache[t];
  }
  function getSettings() {
    var company = ss.getSheetByName(COMPANY_SHEET);
    if (company) return readCompanySettings_(company, tz);
    var sh = ss.getSheetByName('settings');
    if (!sh || sh.getLastRow() < 2) return {};
    var out = {};
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (!r[0]) return;
      try { out[r[0]] = JSON.parse(r[1]); } catch (e) { out[r[0]] = r[1]; }
    });
    return out;
  }
  function saveSettings(obj) {
    var company = ss.getSheetByName(COMPANY_SHEET);
    if (company) return writeCompanySettings_(company, obj);
    var sh = sheet('settings');
    var rows = Object.keys(obj).map(function (k) { return [k, JSON.stringify(obj[k])]; });
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).clearContent();
    if (rows.length) {
      var range = sh.getRange(2, 1, rows.length, 2);
      range.setNumberFormat('@');
      range.setValues(rows);
    }
  }
  var cacheSvc = CacheService.getScriptCache();
  function ttl(sec) { return Math.max(1, Math.min(CACHE_MAX_SEC, Math.round(sec))); }
  return {
    list: list, insert: insert, update: update, remove: remove,
    getSettings: getSettings, saveSettings: saveSettings,
    refresh: function () { cache = {}; rowIndex = {}; },
    sessionPut: function (tok, data, sec) { cacheSvc.put('s:' + tok, JSON.stringify(data), ttl(sec)); },
    sessionGet: function (tok) { var v = cacheSvc.get('s:' + tok); return v ? JSON.parse(v) : null; },
    sessionDel: function (tok) { cacheSvc.remove('s:' + tok); },
    counterGet: function (k) { return Number(cacheSvc.get('c:' + k) || 0); },
    counterSet: function (k, v, sec) { cacheSvc.put('c:' + k, String(v), ttl(sec)); }
  };
}

// ------------------------------------------------------------------ app
function getApp_() {
  var ss = getSpreadsheet_();
  var store = SheetStore_(ss);
  var depth = 0;
  var env = {
    store: store,
    now: function () { return new Date(); },
    tzDate: function (d, tz) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); },
    tzTime: function (d, tz) { return Utilities.formatDate(d, tz, 'HH:mm'); },
    newId: function () { return Utilities.getUuid(); },
    newToken: function () { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); },
    validTz: function (tz) {
      if (!/^[A-Za-z]+(\/[A-Za-z0-9_+\-]+){0,2}$/.test(tz)) return false;
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return tz === 'UTC'; }
    },
    lock: function (fn) {
      if (depth > 0) return fn();
      var lock = LockService.getScriptLock();
      lock.waitLock(20000);
      depth++;
      try { store.refresh(); return fn(); }
      finally { depth--; SpreadsheetApp.flush(); lock.releaseLock(); }
    },
    log: function (e) { console.error(e && e.stack ? e.stack : e); }
  };
  return WardiyaCore.createApp(env);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Web API. The front end sends: {action, payload, token} as text/plain JSON (avoids CORS preflight). */
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, code: 'BAD_REQUEST', error: 'Invalid request.' }); }
  return json_(getApp_().handle(body.action, body.payload, body.token));
}

function doGet() {
  return json_(getApp_().handle('ping'));
}

// ------------------------------------------------------------------ setup & admin tools (run from the editor)
function setup() {
  var ss = getSpreadsheet_();
  var TABLES = WardiyaCore.TABLES;
  Object.keys(TABLES).forEach(function (name) { ensureSheet_(ss, name, TABLES[name]); });

  // Company Settings: create it once. An older sheet's settings (from the 'settings' tab) are carried over.
  if (!ss.getSheetByName(COMPANY_SHEET)) {
    var old = {}, legacy = ss.getSheetByName('settings');
    if (legacy && legacy.getLastRow() > 1) {
      legacy.getRange(2, 1, legacy.getLastRow() - 1, 2).getValues().forEach(function (r) {
        if (!r[0]) return;
        try { old[r[0]] = JSON.parse(r[1]); } catch (e) { old[r[0]] = r[1]; }
      });
    }
    if (!old.companyName) old.companyName = ss.getName();
    if (!old.timezone) old.timezone = ss.getSpreadsheetTimeZone();
    if (old.companyName && !old.appName) old.appName = String(old.companyName).replace(/\s*demo\s*$/i, '') + ' Attendance';
    ensureCompanySheet_(ss, old);
  }
  var legacySheet = ss.getSheetByName('settings');
  if (legacySheet) { try { legacySheet.hideSheet(); } catch (e) { } }
  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);

  var locationMsg = applyMainLocation_(ss);
  var app = getApp_();
  var pin = randomPin_();
  var admin = app.bootstrap({ adminPin: pin });
  if (admin && ss.getSheetByName('branches').getLastRow() === 2) applyMainLocation_(ss);
  var msg = (admin
    ? 'Setup complete.\n\nAdmin code: ' + admin.code + '\nTemporary PIN: ' + pin + '\n\nWrite this down now. You will be asked to change the PIN on first sign-in.'
    : 'Sheets checked. An admin already exists, so no new account was created. Use "Reset ADMIN PIN" if you lost the PIN.') + '\n\n' + locationMsg;
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* running from the editor: see Execution log */ }
  return msg;
}

function resetAdminPin() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName('employees');
  var cols = WardiyaCore.TABLES.employees;
  var data = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), cols.length).getValues();
  var codeCol = cols.indexOf('code'), roleCol = cols.indexOf('role');
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][roleCol]) === 'admin' && String(data[i][codeCol]).toUpperCase() === 'ADMIN') {
      var pin = randomPin_(), salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
      data[i][cols.indexOf('salt')] = salt;
      data[i][cols.indexOf('pinHash')] = WardiyaCore.hashPin(pin, salt);
      data[i][cols.indexOf('mustChangePin')] = true;
      data[i][cols.indexOf('active')] = true;
      sh.getRange(i + 2, 1, 1, cols.length).setValues([data[i]]);
      var msg = 'ADMIN PIN reset. Temporary PIN: ' + pin;
      Logger.log(msg);
      try { SpreadsheetApp.getUi().alert(msg); } catch (e) { }
      return msg;
    }
  }
  throw new Error('No ADMIN account found.');
}

/**
 * Moves attendance records older than the given year to a "records_archive_<year>" sheet to keep the app fast.
 * Run once a year from the editor, e.g. archiveYear(2025). Reports for archived years remain readable in that sheet.
 */
function archiveYear(year) {
  year = Number(year) || (new Date().getFullYear() - 1);
  var ss = getSpreadsheet_(), sh = ss.getSheetByName('records'), cols = WardiyaCore.TABLES.records;
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var last = sh.getLastRow(); if (last < 2) return 'Nothing to archive.';
    var data = sh.getRange(2, 1, last - 1, cols.length).getValues(), dateCol = cols.indexOf('date');
    var tz = ss.getSpreadsheetTimeZone();
    function y(v) { return v instanceof Date ? Number(Utilities.formatDate(v, tz, 'yyyy')) : Number(String(v).slice(0, 4)); }
    var move = data.filter(function (r) { return y(r[dateCol]) <= year; }), keep = data.filter(function (r) { return y(r[dateCol]) > year; });
    if (!move.length) return 'No records from ' + year + ' or earlier.';
    var arch = ensureSheet_(ss, 'records_archive_' + year, cols);
    var start = arch.getLastRow() + 1;
    arch.getRange(start, 1, move.length, cols.length).setNumberFormat('@').setValues(move);
    sh.getRange(2, 1, last - 1, cols.length).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, cols.length).setNumberFormat('@').setValues(keep);
    var msg = 'Archived ' + move.length + ' records to records_archive_' + year + '.';
    Logger.log(msg); return msg;
  } finally { lock.releaseLock(); }
}

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Wardiya')
      .addItem('Run first-time setup', 'setup')
      .addItem('Apply main location', 'applyMainLocation')
      .addItem('Reset ADMIN PIN', 'resetAdminPin')
      .addItem('Archive last year\'s records', 'archiveYear')
      .addToUi();
  } catch (e) { }
}

// ------------------------------------------------------------------ Company Settings tab (friendly, edited by the client)
var COMPANY_SHEET = 'Company Settings';
var DAY_KEYS_ = ['workSun', 'workMon', 'workTue', 'workWed', 'workThu', 'workFri', 'workSat'];
var COMPANY_ROWS_ = [
  { section: 'COMPANY & BRANDING' },
  { key: 'companyName', label: 'Company name', type: 'text', help: 'Shown in the app and on reports.' },
  { key: 'appName', label: 'App name (shown in the header)', type: 'text', help: 'For example "EGATE Attendance".' },
  { key: 'logoUrl', label: 'Logo link', type: 'text', help: 'Upload the logo to Google Drive → Share → "Anyone with the link" → Copy link, and paste it here. Any https:// image link also works. Leave empty for the default logo.' },
  { key: 'brandColor', label: 'Main colour', type: 'color', help: 'A 6-digit colour code such as #0E7C66. The cell shows the colour.' },
  { key: 'accentColor', label: 'Accent colour', type: 'color', help: 'Used for the check-out button and "late" labels. For example #F4A63A.' },
  { section: 'MAIN LOCATION' },
  { key: 'mainLocationName', label: 'Location name', type: 'text', help: 'For example "Head Office".' },
  { key: 'mainAddress', label: 'Address', type: 'text', help: 'Optional, for your reference.' },
  { key: 'mainLatitude', label: 'Latitude', type: 'number', help: 'In Google Maps, right-click the building and click the numbers to copy them. The first number is the latitude.' },
  { key: 'mainLongitude', label: 'Longitude', type: 'number', help: 'The second number from Google Maps.' },
  { key: 'mainRadius', label: 'Allowed radius (metres)', type: 'number', help: '100–200 is recommended. GPS indoors can be off by 30–80 m.' },
  { key: 'geofenceMode', label: 'Location rule', type: 'select', options: ['block', 'flag', 'off'], help: 'block = check-in only inside the radius · flag = allow anywhere but mark "Outside area" · off = no location check.' },
  { section: 'WORKING DAYS & DUTY HOURS' },
  { key: 'timezone', label: 'Time zone', type: 'text', help: 'For example Africa/Tripoli, Asia/Dubai, Asia/Riyadh, Asia/Qatar, Europe/London.' },
  { key: 'workSun', label: 'Works on Sunday', type: 'bool' },
  { key: 'workMon', label: 'Works on Monday', type: 'bool' },
  { key: 'workTue', label: 'Works on Tuesday', type: 'bool' },
  { key: 'workWed', label: 'Works on Wednesday', type: 'bool' },
  { key: 'workThu', label: 'Works on Thursday', type: 'bool' },
  { key: 'workFri', label: 'Works on Friday', type: 'bool' },
  { key: 'workSat', label: 'Works on Saturday', type: 'bool' },
  { key: 'workStart', label: 'Duty starts (HH:MM)', type: 'time', help: '24-hour time, for example 08:00.' },
  { key: 'workEnd', label: 'Duty ends (HH:MM)', type: 'time', help: '24-hour time, for example 16:00.' },
  { section: 'LATE & EARLY RULES' },
  { key: 'graceMinutes', label: 'Late after (minutes)', type: 'number', help: 'Arriving more than this many minutes after duty starts counts as late.' },
  { key: 'earlyLeaveMinutes', label: 'Early-leave allowance (minutes)', type: 'number', help: 'Leaving more than this many minutes before duty ends counts as "left early".' },
  { key: 'earliestCheckInMinutes', label: 'Earliest check-in (minutes before start)', type: 'number', help: '0 = check-in allowed at any time. 60 = check-in opens one hour before duty starts.' },
  { section: 'CUSTOM MESSAGES (optional)' },
  { key: 'welcomeMessage', label: 'Welcome message (sign-in screen)', type: 'text', help: 'For example "Welcome to EGATE. Check in when you arrive at the office."' },
  { key: 'checkInMessage', label: 'After on-time check-in', type: 'text', help: 'For example "Good morning, have a great day!"' },
  { key: 'lateMessage', label: 'After late check-in', type: 'text', help: 'For example "You are late today. Please inform your manager."' },
  { key: 'checkOutMessage', label: 'After check-out', type: 'text', help: 'For example "Thank you, see you tomorrow."' },
  { key: 'earlyLeaveMessage', label: 'After early check-out', type: 'text', help: 'For example "You left before the end of duty."' }
];
var COMPANY_DEFAULTS_ = {
  companyName: 'My Company', appName: 'Wardiya', logoUrl: '', brandColor: '#0E7C66', accentColor: '#F4A63A',
  mainLocationName: 'Head Office', mainAddress: '', mainLatitude: '', mainLongitude: '', mainRadius: 150, geofenceMode: 'block',
  timezone: 'Africa/Tripoli', workStart: '08:00', workEnd: '16:00', workDays: [0, 1, 2, 3, 4],
  graceMinutes: 10, earlyLeaveMinutes: 10, earliestCheckInMinutes: 0,
  welcomeMessage: '', checkInMessage: '', lateMessage: '', checkOutMessage: '', earlyLeaveMessage: ''
};

function toHHMM_(v) {
  var m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|ص|م)?\s*$/i.exec(String(v === null || v === undefined ? '' : v));
  if (!m) return '';
  var h = Number(m[1]), ap = (m[3] || '').toLowerCase();
  if ((ap === 'pm' || ap === 'م') && h < 12) h += 12;
  if ((ap === 'am' || ap === 'ص') && h === 12) h = 0;
  if (h > 23 || Number(m[2]) > 59) return '';
  return (h < 10 ? '0' : '') + h + ':' + m[2];
}
function companyRowSpec_(key) { for (var i = 0; i < COMPANY_ROWS_.length; i++) if (COMPANY_ROWS_[i].key === key) return COMPANY_ROWS_[i]; return null; }

/** Reads the Company Settings tab into a settings object (workDays as an array). */
function readCompanySettings_(sh, tz) {
  var last = sh.getLastRow(); if (last < 1) return {};
  var range = sh.getRange(1, 1, last, 4), rows = range.getValues(), shown = range.getDisplayValues(), out = {}, days = [], sawDay = false;
  rows.forEach(function (r, i) {
    var key = String(r[3] || '').trim(), v = r[1];
    if (!key || key === 'key') return;
    var spec = companyRowSpec_(key) || { type: 'text' };
    // Times: use what the cell shows ("8:30", "08:30:00", "8:30 AM"), which avoids time-zone shifts on time-only values.
    if (spec.type === 'time') v = toHHMM_(shown[i][1]) || toHHMM_(v instanceof Date ? Utilities.formatDate(v, tz, 'HH:mm') : v);
    else if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (DAY_KEYS_.indexOf(key) >= 0) { sawDay = true; if (v === true || String(v).toUpperCase() === 'TRUE') days.push(DAY_KEYS_.indexOf(key)); return; }
    if (spec.type === 'number') v = (v === '' || v === null) ? '' : Number(v);
    else if (typeof v === 'string') v = v.trim();
    out[key] = v;
  });
  if (sawDay) out.workDays = days;
  return out;
}

/** Writes settings back into the Company Settings tab, row by key. Labels and help text are kept. */
function writeCompanySettings_(sh, obj) {
  var last = sh.getLastRow(), keys = last ? sh.getRange(1, 4, last, 1).getValues().map(function (r) { return String(r[0] || ''); }) : [];
  var flat = {};
  Object.keys(obj).forEach(function (k) {
    if (k === 'workDays') { DAY_KEYS_.forEach(function (dk, i) { flat[dk] = (obj.workDays || []).indexOf(i) >= 0; }); return; }
    flat[k] = obj[k];
  });
  Object.keys(flat).forEach(function (k) {
    var idx = keys.indexOf(k), v = flat[k];
    if (Array.isArray(v) || (v !== null && typeof v === 'object')) v = JSON.stringify(v);
    if (idx < 0) {
      var row = sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, 4).setValues([[k, v === undefined ? '' : v, '', k]]);
      keys.push(k);
      return;
    }
    var cell = sh.getRange(idx + 1, 2);
    cell.setValue(v === undefined || v === null ? '' : v);
    if (/Color$/.test(k)) paintColorCell_(cell, v);
  });
}

function paintColorCell_(cell, hex) {
  if (/^#[0-9a-fA-F]{6}$/.test(String(hex))) {
    var n = parseInt(String(hex).slice(1), 16), lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    cell.setBackground(hex).setFontColor(lum > 150 ? '#0B1F1A' : '#FFFFFF');
  } else cell.setBackground('#FFF8E1').setFontColor('#0B1F1A');
}

/** Creates the Company Settings tab (if missing) with the given starting values. */
function ensureCompanySheet_(ss, values) {
  var sh = ss.getSheetByName(COMPANY_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(COMPANY_SHEET, 0);
  var v = {}; Object.keys(COMPANY_DEFAULTS_).forEach(function (k) { v[k] = COMPANY_DEFAULTS_[k]; });
  Object.keys(values || {}).forEach(function (k) { if (values[k] !== undefined && values[k] !== null && values[k] !== '') v[k] = values[k]; });
  var data = [
    ['Wardiya · Company Settings', '', '', ''],
    ['Fill in the yellow column. Changes apply in the app straight away. After changing the main location, use the menu Wardiya → Apply main location.', '', '', ''],
    ['Setting', 'Your value', 'Help', 'key']
  ];
  var kinds = ['title', 'note', 'head'];
  COMPANY_ROWS_.forEach(function (r) {
    if (r.section) { data.push([r.section, '', '', '']); kinds.push('section'); return; }
    var val = DAY_KEYS_.indexOf(r.key) >= 0 ? (v.workDays || []).indexOf(DAY_KEYS_.indexOf(r.key)) >= 0 : v[r.key];
    data.push([r.label, val === undefined ? '' : val, r.help || '', r.key]); kinds.push(r.type);
  });
  // Text formats first (so "08:00" or "#0E7C66" stay as typed); number and checkbox cells keep automatic format.
  sh.getRange(1, 1, data.length, 1).setNumberFormat('@');
  sh.getRange(1, 3, data.length, 2).setNumberFormat('@');
  kinds.forEach(function (k, i) { if (['text', 'time', 'color', 'select', 'title', 'note', 'head', 'section'].indexOf(k) >= 0) sh.getRange(i + 1, 2).setNumberFormat('@'); });
  sh.getRange(1, 1, data.length, 4).setValues(data);
  sh.setColumnWidth(1, 300); sh.setColumnWidth(2, 300); sh.setColumnWidth(3, 520);
  sh.getRange(1, 1).setFontSize(16).setFontWeight('bold').setFontColor('#0E7C66');
  sh.getRange(2, 1).setFontColor('#5B6B66').setFontStyle('italic');
  sh.getRange(3, 1, 1, 3).setFontWeight('bold').setBackground('#E6F2EF');
  sh.getRange(1, 3, data.length, 1).setWrap(true).setFontColor('#5B6B66');
  kinds.forEach(function (k, i) {
    var row = i + 1;
    if (k === 'section') sh.getRange(row, 1, 1, 3).setFontWeight('bold').setBackground('#0B1F1A').setFontColor('#FFFFFF');
    else if (['text', 'number', 'time', 'color', 'select', 'bool'].indexOf(k) >= 0) {
      var cell = sh.getRange(row, 2);
      cell.setBackground('#FFF8E1');
      if (k === 'bool') cell.insertCheckboxes();
      if (k === 'select') {
        var spec = companyRowSpec_(data[i][3]);
        cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(spec.options, true).setAllowInvalid(false).build());
      }
      if (k === 'color') paintColorCell_(cell, data[i][1]);
    }
  });
  // checkboxes need real booleans, numbers need numbers
  data.forEach(function (r, i) {
    var spec = companyRowSpec_(r[3]);
    if (!spec) return;
    if (spec.type === 'bool') sh.getRange(i + 1, 2).setValue(r[1] === true);
    if (spec.type === 'number' && r[1] !== '') sh.getRange(i + 1, 2).setValue(Number(r[1]));
  });
  sh.setFrozenRows(3);
  sh.hideColumns(4);
  sh.setTabColor('#0E7C66');
  return sh;
}

/** Menu: creates or updates the branch from the MAIN LOCATION rows, and assigns staff with no branch to it. */
function applyMainLocation() {
  var msg = applyMainLocation_(getSpreadsheet_());
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { }
  return msg;
}
function applyMainLocation_(ss) {
  var sh = ss.getSheetByName(COMPANY_SHEET);
  if (!sh) return 'No "' + COMPANY_SHEET + '" tab. Run setup first.';
  var s = readCompanySettings_(sh, ss.getSpreadsheetTimeZone());
  var lat = Number(s.mainLatitude), lng = Number(s.mainLongitude), rad = Number(s.mainRadius) || 150;
  if (s.mainLatitude === '' || s.mainLongitude === '' || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return 'Main location skipped: fill in a valid latitude and longitude first.';
  if (rad < 20 || rad > 50000) return 'Allowed radius must be between 20 and 50,000 metres.';
  var name = String(s.mainLocationName || 'Head Office').slice(0, 60);
  var store = SheetStore_(ss), branches = store.list('branches'), found = null;
  branches.forEach(function (b) { if (String(b.name).toLowerCase() === name.toLowerCase()) found = b; });
  var data = { name: name, address: String(s.mainAddress || '').slice(0, 150), lat: lat, lng: lng, radius: Math.round(rad) };
  var id;
  if (found) { store.update('branches', found.id, data); id = found.id; }
  else { data.id = Utilities.getUuid(); store.insert('branches', data); id = data.id; }
  var assigned = 0;
  if (store.list('branches').length === 1) {
    store.list('employees').forEach(function (e) { if (!e.branchId) { store.update('employees', e.id, { branchId: id }); assigned++; } });
  }
  return 'Main location "' + name + '" saved (' + lat + ', ' + lng + ', radius ' + Math.round(rad) + ' m).' + (assigned ? ' ' + assigned + ' employee(s) assigned to it.' : '');
}

/** Simple trigger: keeps the colour cells painted with the colour typed into them. */
function onEdit(e) {
  try {
    var sh = e.range.getSheet();
    if (sh.getName() !== COMPANY_SHEET || e.range.getColumn() !== 2) return;
    var key = String(sh.getRange(e.range.getRow(), 4).getValue());
    if (/Color$/.test(key)) paintColorCell_(e.range, String(e.range.getValue()).trim());
  } catch (err) { }
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var range = sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), headers.length);
  range.setNumberFormat('@');
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#E6F2EF');
  sh.setFrozenRows(1);
  if (name === 'employees') {
    // Hide security columns from casual viewing (they are hashes, never plain PINs).
    sh.hideColumns(headers.indexOf('salt') + 1, 2);
  }
  return sh;
}

function randomPin_() {
  var pin;
  do { pin = String(Math.floor(100000 + Math.random() * 900000)); } while (/^(\d)\1+$/.test(pin));
  return pin;
}

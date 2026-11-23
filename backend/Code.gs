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
  ensureSheet_(ss, 'settings', ['key', 'value']);
  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);

  var app = getApp_();
  var pin = randomPin_();
  var admin = app.bootstrap({
    adminPin: pin,
    settings: { companyName: ss.getName(), timezone: ss.getSpreadsheetTimeZone(), workStart: '09:00', workEnd: '17:00', graceMinutes: 10, workDays: [1, 2, 3, 4, 5], geofenceMode: 'flag' }
  });
  var msg = admin
    ? 'Setup complete.\n\nAdmin code: ' + admin.code + '\nTemporary PIN: ' + pin + '\n\nWrite this down now. You will be asked to change the PIN on first sign-in.'
    : 'Sheets checked. An admin already exists, so no new account was created. Use resetAdminPin() if you lost the PIN.';
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
      .addItem('Reset ADMIN PIN', 'resetAdminPin')
      .addItem('Archive last year\'s records', 'archiveYear')
      .addToUi();
  } catch (e) { }
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

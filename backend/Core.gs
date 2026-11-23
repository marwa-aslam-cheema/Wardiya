/*
 * Wardiya Attendance — shared business logic.
 * The SAME file runs in the browser (demo mode) and in Google Apps Script (live mode, as Core.gs).
 * It never touches storage directly: an "env" object provides storage, clock and random IDs.
 */
var WardiyaCore = (function () {
  'use strict';

  var VERSION = '1.0.0';
  var SESSION_TTL_SEC = 12 * 3600;
  var MAX_FAILS = 5;
  var LOCK_SEC = 15 * 60;
  var OPEN_RECORD_MAX_HOURS = 20;

  // ---------- SHA-256 (pure JS, synchronous, public-domain algorithm) ----------
  function sha256(str) {
    var ascii = unescape(encodeURIComponent(String(str)));
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var maxWord = Math.pow(2, 32), i, j, result = '';
    var words = [], bitLen = ascii.length * 8;
    var hash = [], k = [], primeCounter = 0, isComposite = {};
    for (var c = 2; primeCounter < 64; c++) {
      if (!isComposite[c]) {
        for (i = 0; i < 313; i += c) isComposite[i] = c;
        hash[primeCounter] = (Math.pow(c, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(c, 1 / 3) * maxWord) | 0;
      }
    }
    hash = hash.slice(0, 8);
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = ((bitLen / maxWord) | 0);
    words[words.length] = bitLen;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16), old = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
        var t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ ((~e) & hash[6])) + k[i] +
          (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] +
            (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        var t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(t1 + t2) | 0].concat(hash);
        hash[4] = (hash[4] + t1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0;
    }
    for (i = 0; i < 8; i++) for (j = 3; j + 1; j--) {
      var b = (hash[i] >> (j * 8)) & 255;
      result += ((b < 16) ? '0' : '') + b.toString(16);
    }
    return result;
  }

  function hashPin(pin, salt) {
    var h = sha256(salt + ':' + pin);
    for (var i = 0; i < 300; i++) h = sha256(h + salt);
    return h;
  }

  // ---------- helpers ----------
  function AppError(code, message, extra) { this.code = code; this.message = message || code; this.extra = extra || null; }
  function fail(code, message, extra) { throw new AppError(code, message, extra); }
  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : NaN; }
  function bool(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'TRUE'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isTime(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
  function isDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }
  function toMin(t) { if (!t) return null; var p = String(t).split(':'); return Number(p[0]) * 60 + Number(p[1]); }
  function fromMin(m) { m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function addDays(date, n) {
    var p = date.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function weekday(date) { var p = date.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); }
  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }
  function clean(text, max) { return str(text).replace(/[\u0000-\u001f<>]/g, '').slice(0, max || 200); }
  // Prevent spreadsheet formula injection when values are written to Google Sheets.
  function safeCell(v) { v = clean(v, 200); return /^[=+\-@]/.test(v) ? "'" + v : v; }

  var DEFAULT_SETTINGS = {
    companyName: 'My Company',
    timezone: 'Asia/Dubai',
    workStart: '09:00',
    workEnd: '17:00',
    graceMinutes: 10,
    workDays: [1, 2, 3, 4, 5],
    geofenceMode: 'flag', // off | flag | block
    currencyNote: ''
  };

  function recordMinutes(r) {
    if (r.type === 'leave' || !r.inTime || !r.outTime) return 0;
    var d = toMin(r.outTime) - toMin(r.inTime);
    if (d < 0) d += 1440; // overnight shift
    return d;
  }

  function publicEmployee(e) {
    return {
      id: e.id, code: e.code, name: e.name, email: e.email || '', phone: e.phone || '',
      department: e.department || '', branchId: e.branchId || '', role: e.role, active: bool(e.active),
      mustChangePin: bool(e.mustChangePin), createdAt: e.createdAt || ''
    };
  }

  // =====================================================================
  function createApp(env) {
    var S = env.store;

    function settings() {
      var s = S.getSettings() || {};
      var out = {};
      for (var k in DEFAULT_SETTINGS) out[k] = (s[k] === undefined || s[k] === null || s[k] === '') ? DEFAULT_SETTINGS[k] : s[k];
      if (typeof out.workDays === 'string') out.workDays = out.workDays.split(',').filter(function (x) { return x !== ''; }).map(Number);
      out.graceMinutes = Number(out.graceMinutes) || 0;
      return out;
    }
    function nowParts() {
      var tz = settings().timezone, d = env.now();
      return { iso: d.toISOString(), ms: d.getTime(), date: env.tzDate(d, tz), time: env.tzTime(d, tz) };
    }
    function employees() { return S.list('employees'); }
    function branches() { return S.list('branches'); }
    function records() { return S.list('records'); }
    function findEmp(id) { var l = employees(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
    function findBranch(id) { var l = branches(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
    function audit(actor, action, detail) {
      S.insert('audit', { id: env.newId(), ts: env.now().toISOString(), actor: actor ? actor.code : 'system', action: action, detail: clean(detail, 300) });
    }

    // ----- auth -----
    function login(p) {
      var code = str(p.code).toUpperCase(), pin = str(p.pin);
      if (!code || !pin) fail('VALIDATION', 'Enter your employee code and PIN.');
      var key = 'fail:' + code;
      var fails = Number(S.counterGet(key) || 0);
      if (fails >= MAX_FAILS) fail('LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
      var emp = null, list = employees();
      for (var i = 0; i < list.length; i++) if (String(list[i].code).toUpperCase() === code) emp = list[i];
      if (!emp || !bool(emp.active) || hashPin(pin, emp.salt) !== emp.pinHash) {
        S.counterSet(key, fails + 1, LOCK_SEC);
        if (fails + 1 >= MAX_FAILS) audit(null, 'login_locked', 'Account code ' + code + ' locked after failed attempts');
        fail('BAD_LOGIN', 'Wrong employee code or PIN.');
      }
      S.counterSet(key, 0, 1);
      var token = env.newToken();
      S.sessionPut(token, { empId: emp.id, exp: env.now().getTime() + SESSION_TTL_SEC * 1000 }, SESSION_TTL_SEC);
      return { token: token, user: publicEmployee(emp), settings: publicSettings() };
    }
    function auth(token) {
      if (!token) fail('AUTH', 'Please sign in.');
      var s = S.sessionGet(token);
      if (!s || s.exp < env.now().getTime()) fail('AUTH', 'Your session has expired. Please sign in again.');
      var emp = findEmp(s.empId);
      if (!emp || !bool(emp.active)) { S.sessionDel(token); fail('AUTH', 'Account is not active.'); }
      return emp;
    }
    function publicSettings() {
      var s = settings();
      return { companyName: s.companyName, timezone: s.timezone, workStart: s.workStart, workEnd: s.workEnd, graceMinutes: s.graceMinutes, workDays: s.workDays, geofenceMode: s.geofenceMode };
    }

    function validPin(pin) { return /^\d{4,8}$/.test(pin); }
    function changePin(user, p) {
      var oldPin = str(p.oldPin), newPin = str(p.newPin);
      if (hashPin(oldPin, user.salt) !== user.pinHash) fail('BAD_PIN', 'Current PIN is wrong.');
      if (!validPin(newPin)) fail('VALIDATION', 'New PIN must be 4–8 digits.');
      if (/^(\d)\1+$/.test(newPin) || '0123456789'.indexOf(newPin) >= 0) fail('VALIDATION', 'Choose a less obvious PIN.');
      if (newPin === oldPin) fail('VALIDATION', 'New PIN must be different.');
      var salt = env.newToken().slice(0, 16);
      S.update('employees', user.id, { salt: salt, pinHash: hashPin(newPin, salt), mustChangePin: false });
      audit(user, 'pin_changed', 'Own PIN changed');
      return { done: true };
    }

    // ----- clock -----
    function openRecord(empId) {
      var now = env.now().getTime(), best = null, list = records();
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r.empId === empId && r.type !== 'leave' && r.inTime && !r.outTime && r.inAt) {
          var age = (now - new Date(r.inAt).getTime()) / 3600000;
          if (age <= OPEN_RECORD_MAX_HOURS && (!best || r.inAt > best.inAt)) best = r;
        }
      }
      return best;
    }
    function checkLocation(user, p, s) {
      var res = { lat: '', lng: '', acc: '', dist: '', flag: '' };
      var lat = num(p.lat), lng = num(p.lng);
      var hasLoc = p.lat !== undefined && p.lat !== null && p.lat !== '' && isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      if (hasLoc) { res.lat = Math.round(lat * 1e6) / 1e6; res.lng = Math.round(lng * 1e6) / 1e6; res.acc = isFinite(num(p.acc)) ? Math.round(num(p.acc)) : ''; }
      var br = findBranch(user.branchId);
      var fenced = s.geofenceMode !== 'off' && br && br.lat !== '' && br.lng !== '' && Number(br.radius) > 0 && isFinite(num(br.lat));
      if (!fenced) return res;
      if (!hasLoc) {
        if (s.geofenceMode === 'block') fail('LOCATION_REQUIRED', 'Location is required to check in at ' + br.name + '. Allow location access and try again.');
        res.flag = 'no_location';
        return res;
      }
      res.dist = haversine(lat, lng, Number(br.lat), Number(br.lng));
      var tolerance = Math.min(Number(res.acc) || 0, 100); // allow for GPS inaccuracy, capped
      if (res.dist > Number(br.radius) + tolerance) {
        if (s.geofenceMode === 'block') fail('OUTSIDE_GEOFENCE', 'You are ' + res.dist + ' m from ' + br.name + ' (allowed: ' + br.radius + ' m).', { distance: res.dist });
        res.flag = 'outside';
      }
      return res;
    }
    function checkIn(user, p) {
      return env.lock(function () {
        if (openRecord(user.id)) fail('ALREADY_IN', 'You are already checked in. Check out first.');
        var s = settings(), n = nowParts(), loc = checkLocation(user, p, s);
        var firstToday = !records().some(function (r) { return r.empId === user.id && r.date === n.date && r.type !== 'leave'; });
        var lateBy = 0;
        if (firstToday && s.workDays.indexOf(weekday(n.date)) >= 0) {
          lateBy = Math.max(0, toMin(n.time) - toMin(s.workStart) - s.graceMinutes);
          if (lateBy > 0) lateBy = toMin(n.time) - toMin(s.workStart);
        }
        var rec = {
          id: env.newId(), empId: user.id, branchId: user.branchId || '', date: n.date, type: 'work',
          inTime: n.time, outTime: '', inAt: n.iso, outAt: '',
          inLat: loc.lat, inLng: loc.lng, inAcc: loc.acc, inDist: loc.dist,
          outLat: '', outLng: '', outDist: '',
          lateMin: lateBy, flags: loc.flag ? 'in_' + loc.flag : '', note: safeCell(p.note), source: 'app', editedBy: '', editedAt: ''
        };
        S.insert('records', rec);
        return { record: rec, late: lateBy > 0 };
      });
    }
    function checkOut(user, p) {
      return env.lock(function () {
        var r = openRecord(user.id);
        if (!r) fail('NOT_IN', 'You are not checked in.');
        var s = settings(), n = nowParts(), loc = checkLocation(user, p, s);
        var flags = r.flags ? String(r.flags).split(',') : [];
        if (loc.flag) flags.push('out_' + loc.flag);
        var patch = { outTime: n.time, outAt: n.iso, outLat: loc.lat, outLng: loc.lng, outDist: loc.dist, flags: flags.join(',') };
        if (p.note) patch.note = safeCell((r.note ? r.note + ' | ' : '') + p.note);
        S.update('records', r.id, patch);
        var merged = {}; for (var k in r) merged[k] = r[k]; for (k in patch) merged[k] = patch[k];
        return { record: merged, minutes: recordMinutes(merged) };
      });
    }
    function myStatus(user) {
      var n = nowParts(), open = openRecord(user.id);
      var today = records().filter(function (r) { return r.empId === user.id && r.date === n.date; });
      var mins = 0; today.forEach(function (r) { mins += recordMinutes(r); });
      if (open) mins += Math.max(0, toMin(n.time) - toMin(open.inTime) + (toMin(n.time) < toMin(open.inTime) ? 1440 : 0));
      var br = findBranch(user.branchId);
      return {
        user: publicEmployee(user), settings: publicSettings(), today: n.date, time: n.time, open: open, todayRecords: today,
        todayMinutes: mins, branch: br ? { id: br.id, name: br.name, fenced: !!(br.lat !== '' && Number(br.radius) > 0) } : null
      };
    }
    function myRecords(user, p) {
      var r = range(p);
      return decorate(records().filter(function (x) { return x.empId === user.id && x.date >= r.from && x.date <= r.to; }));
    }

    // ----- admin -----
    function requireAdmin(user) { if (user.role !== 'admin') fail('FORBIDDEN', 'Admins only.'); }
    function range(p) {
      var n = nowParts();
      var to = isDate(str(p.to)) ? str(p.to) : n.date;
      var from = isDate(str(p.from)) ? str(p.from) : addDays(to, -30);
      if (from > to) { var t = from; from = to; to = t; }
      return { from: from, to: to };
    }
    function decorate(list) {
      var emps = {}, brs = {}, today = nowParts().date;
      employees().forEach(function (e) { emps[e.id] = e; });
      branches().forEach(function (b) { brs[b.id] = b; });
      return list.map(function (r) {
        var o = {}; for (var k in r) o[k] = r[k];
        var e = emps[r.empId], b = brs[r.branchId];
        o.empName = e ? e.name : '(deleted)'; o.empCode = e ? e.code : '';
        o.branchName = b ? b.name : '';
        o.minutes = recordMinutes(r);
        o.missingOut = r.type !== 'leave' && r.inTime && !r.outTime && r.date < today && !(r.inAt && (env.now().getTime() - new Date(r.inAt).getTime()) / 3600000 <= OPEN_RECORD_MAX_HOURS);
        return o;
      }).sort(function (a, b) { return (b.date + (b.inTime || '')).localeCompare(a.date + (a.inTime || '')); });
    }
    function listRecords(p) {
      var r = range(p), emp = str(p.empId), br = str(p.branchId), st = str(p.status);
      var out = decorate(records().filter(function (x) {
        return x.date >= r.from && x.date <= r.to && (!emp || x.empId === emp) && (!br || x.branchId === br);
      }));
      if (st === 'late') out = out.filter(function (x) { return Number(x.lateMin) > 0; });
      if (st === 'missing') out = out.filter(function (x) { return x.missingOut; });
      if (st === 'flagged') out = out.filter(function (x) { return !!x.flags; });
      if (st === 'leave') out = out.filter(function (x) { return x.type === 'leave'; });
      if (st === 'manual') out = out.filter(function (x) { return x.source !== 'app'; });
      return { from: r.from, to: r.to, records: out.slice(0, 3000), total: out.length };
    }
    function computeLate(empId, date, inTime, excludeId) {
      var s = settings();
      if (s.workDays.indexOf(weekday(date)) < 0) return 0;
      var earlier = records().some(function (r) { return r.id !== excludeId && r.empId === empId && r.date === date && r.type !== 'leave' && r.inTime && r.inTime < inTime; });
      if (earlier) return 0;
      var late = toMin(inTime) - toMin(s.workStart);
      return late > s.graceMinutes ? late : 0;
    }
    function saveRecord(admin, p) {
      return env.lock(function () {
        var id = str(p.id), type = p.type === 'leave' ? 'leave' : 'work';
        var date = str(p.date), inTime = str(p.inTime), outTime = str(p.outTime), note = safeCell(p.note);
        var reason = clean(p.reason, 200);
        if (!reason) fail('VALIDATION', 'Please give a reason for this change (kept in the audit log).');
        if (!isDate(date)) fail('VALIDATION', 'Enter a valid date.');
        if (type === 'work') {
          if (!isTime(inTime)) fail('VALIDATION', 'Enter a valid check-in time (HH:MM).');
          if (outTime && !isTime(outTime)) fail('VALIDATION', 'Enter a valid check-out time (HH:MM).');
          if (outTime && outTime === inTime) fail('VALIDATION', 'Check-out must be different from check-in.');
        } else { inTime = ''; outTime = ''; }
        var stamp = env.now().toISOString();
        if (id) {
          var cur = null; records().forEach(function (r) { if (r.id === id) cur = r; });
          if (!cur) fail('NOT_FOUND', 'Record not found.');
          var patch = { date: date, type: type, inTime: inTime, outTime: outTime, note: note, editedBy: admin.code, editedAt: stamp,
            lateMin: type === 'work' ? computeLate(cur.empId, date, inTime, id) : 0 };
          if (outTime && !cur.outAt) patch.outAt = stamp;
          S.update('records', id, patch);
          audit(admin, 'record_edited', (findEmp(cur.empId) || {}).code + ' ' + cur.date + ' ' + (cur.inTime || '-') + '→' + (cur.outTime || '-') + ' changed to ' + date + ' ' + (inTime || '-') + '→' + (outTime || '-') + ' (' + type + '). Reason: ' + reason);
          return { id: id };
        }
        var emp = findEmp(str(p.empId));
        if (!emp) fail('VALIDATION', 'Choose an employee.');
        var rec = {
          id: env.newId(), empId: emp.id, branchId: emp.branchId || '', date: date, type: type, inTime: inTime, outTime: outTime,
          inAt: '', outAt: '', inLat: '', inLng: '', inAcc: '', inDist: '', outLat: '', outLng: '', outDist: '',
          lateMin: type === 'work' ? computeLate(emp.id, date, inTime, '') : 0, flags: '', note: note, source: 'manual', editedBy: admin.code, editedAt: stamp
        };
        S.insert('records', rec);
        audit(admin, 'record_added', emp.code + ' ' + date + ' ' + type + ' ' + (inTime || '') + (outTime ? '→' + outTime : '') + '. Reason: ' + reason);
        return { id: rec.id };
      });
    }
    function deleteRecord(admin, p) {
      return env.lock(function () {
        var id = str(p.id), reason = clean(p.reason, 200), cur = null;
        if (!reason) fail('VALIDATION', 'Please give a reason for deleting.');
        records().forEach(function (r) { if (r.id === id) cur = r; });
        if (!cur) fail('NOT_FOUND', 'Record not found.');
        S.remove('records', id);
        audit(admin, 'record_deleted', (findEmp(cur.empId) || {}).code + ' ' + cur.date + ' ' + (cur.inTime || cur.type) + '. Reason: ' + reason);
        return { id: id };
      });
    }

    function validateEmployee(p, existing, list) {
      var e = {
        code: str(p.code).toUpperCase(), name: clean(p.name, 80), email: str(p.email).toLowerCase(), phone: clean(p.phone, 30),
        department: clean(p.department, 60), branchId: str(p.branchId), role: p.role === 'admin' ? 'admin' : 'employee'
      };
      if (!/^[A-Z0-9_-]{2,20}$/.test(e.code)) fail('VALIDATION', 'Code must be 2–20 letters, numbers, - or _.');
      if (e.name.length < 2) fail('VALIDATION', 'Enter the employee name.');
      if (e.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.email)) fail('VALIDATION', 'Email address is not valid.');
      if (e.phone && !/^[+0-9 ()-]{5,30}$/.test(e.phone)) fail('VALIDATION', 'Phone number is not valid.');
      if (e.branchId && !findBranch(e.branchId)) fail('VALIDATION', 'Branch not found.');
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].code).toUpperCase() === e.code && (!existing || list[i].id !== existing.id)) fail('DUPLICATE', 'Employee code ' + e.code + ' is already used.');
      }
      e.name = safeCell(e.name); e.department = safeCell(e.department);
      return e;
    }
    function saveEmployee(admin, p) {
      return env.lock(function () {
        var list = employees(), id = str(p.id), existing = id ? findEmp(id) : null;
        if (id && !existing) fail('NOT_FOUND', 'Employee not found.');
        var e = validateEmployee(p, existing, list), pin = str(p.pin);
        if (pin && !validPin(pin)) fail('VALIDATION', 'PIN must be 4–8 digits.');
        if (existing) {
          if (existing.id === admin.id && e.role !== 'admin') fail('VALIDATION', 'You cannot remove your own admin role.');
          if (pin) { var salt = env.newToken().slice(0, 16); e.salt = salt; e.pinHash = hashPin(pin, salt); e.mustChangePin = true; }
          S.update('employees', existing.id, e);
          audit(admin, 'employee_updated', e.code + (pin ? ' (PIN reset)' : ''));
          return { id: existing.id };
        }
        if (!pin) fail('VALIDATION', 'Set a starting PIN (4–8 digits).');
        var s2 = env.newToken().slice(0, 16);
        e.id = env.newId(); e.salt = s2; e.pinHash = hashPin(pin, s2); e.active = true; e.mustChangePin = true; e.createdAt = env.now().toISOString();
        S.insert('employees', e);
        audit(admin, 'employee_added', e.code + ' ' + e.name);
        return { id: e.id };
      });
    }
    function setEmployeeActive(admin, p) {
      return env.lock(function () {
        var e = findEmp(str(p.id)); if (!e) fail('NOT_FOUND', 'Employee not found.');
        if (e.id === admin.id) fail('VALIDATION', 'You cannot deactivate yourself.');
        var active = bool(p.active);
        S.update('employees', e.id, { active: active });
        audit(admin, active ? 'employee_activated' : 'employee_deactivated', e.code);
        return { id: e.id, active: active };
      });
    }
    function importEmployees(admin, p) {
      var text = str(p.csv), lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
      if (!lines.length) fail('VALIDATION', 'Paste at least one line.');
      if (lines.length > 500) fail('VALIDATION', 'Import up to 500 employees at a time.');
      if (/^\s*code\s*,/i.test(lines[0])) lines.shift();
      var brByName = {}; branches().forEach(function (b) { brByName[String(b.name).toLowerCase()] = b.id; });
      var added = 0, errors = [];
      lines.forEach(function (line, idx) {
        var c = line.split(',').map(function (x) { return x.trim(); });
        try {
          var bId = c[3] ? brByName[c[3].toLowerCase()] : '';
          if (c[3] && !bId) fail('VALIDATION', 'Branch "' + c[3] + '" not found');
          saveEmployee(admin, { code: c[0], name: c[1], department: c[2], branchId: bId || '', pin: c[4], email: c[5], phone: c[6], role: 'employee' });
          added++;
        } catch (err) { errors.push('Line ' + (idx + 1) + ': ' + (err.message || err)); }
      });
      return { added: added, errors: errors };
    }
    function saveBranch(admin, p) {
      return env.lock(function () {
        var id = str(p.id), b = { name: safeCell(clean(p.name, 60)), address: safeCell(clean(p.address, 150)), lat: '', lng: '', radius: '' };
        if (b.name.length < 2) fail('VALIDATION', 'Enter the branch name.');
        var hasLat = str(p.lat) !== '', hasLng = str(p.lng) !== '';
        if (hasLat || hasLng) {
          var lat = num(p.lat), lng = num(p.lng), rad = num(p.radius);
          if (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) fail('VALIDATION', 'Latitude/longitude are not valid.');
          if (!(rad >= 20 && rad <= 50000)) fail('VALIDATION', 'Radius must be between 20 and 50,000 metres.');
          b.lat = lat; b.lng = lng; b.radius = Math.round(rad);
        }
        var dup = branches().some(function (x) { return String(x.name).toLowerCase() === b.name.toLowerCase() && x.id !== id; });
        if (dup) fail('DUPLICATE', 'A branch with this name already exists.');
        if (id) {
          if (!findBranch(id)) fail('NOT_FOUND', 'Branch not found.');
          S.update('branches', id, b); audit(admin, 'branch_updated', b.name); return { id: id };
        }
        b.id = env.newId(); S.insert('branches', b); audit(admin, 'branch_added', b.name); return { id: b.id };
      });
    }
    function deleteBranch(admin, p) {
      return env.lock(function () {
        var b = findBranch(str(p.id)); if (!b) fail('NOT_FOUND', 'Branch not found.');
        var used = employees().some(function (e) { return e.branchId === b.id && bool(e.active); });
        if (used) fail('IN_USE', 'Move active employees to another branch first.');
        S.remove('branches', b.id); audit(admin, 'branch_deleted', b.name); return { id: b.id };
      });
    }
    function saveSettings(admin, p) {
      var s = settings();
      var next = {
        companyName: safeCell(clean(p.companyName, 80)) || s.companyName,
        timezone: str(p.timezone) || s.timezone,
        workStart: str(p.workStart), workEnd: str(p.workEnd),
        graceMinutes: Math.round(num(p.graceMinutes)),
        workDays: (Array.isArray(p.workDays) ? p.workDays : []).map(Number).filter(function (d) { return d >= 0 && d <= 6; }),
        geofenceMode: ['off', 'flag', 'block'].indexOf(p.geofenceMode) >= 0 ? p.geofenceMode : s.geofenceMode
      };
      if (!env.validTz(next.timezone)) fail('VALIDATION', 'Unknown time zone.');
      if (!isTime(next.workStart) || !isTime(next.workEnd)) fail('VALIDATION', 'Work hours must be HH:MM.');
      if (!(next.graceMinutes >= 0 && next.graceMinutes <= 180)) fail('VALIDATION', 'Grace period must be 0–180 minutes.');
      if (!next.workDays.length) fail('VALIDATION', 'Choose at least one working day.');
      next.workDays.sort();
      S.saveSettings(next);
      audit(admin, 'settings_saved', JSON.stringify(next).slice(0, 280));
      return publicSettings();
    }

    function dashboard() {
      var s = settings(), n = nowParts();
      var all = records(), byDay = {};
      // Expected attendance: active staff with the employee role, plus admins who actually clock in.
      var clocking = {}; all.forEach(function (r) { if (r.date >= addDays(n.date, -29)) clocking[r.empId] = 1; });
      var emps = employees().filter(function (e) { return bool(e.active) && (e.role !== 'admin' || clocking[e.id]); });
      var from = addDays(n.date, -29);
      all.forEach(function (r) {
        if (r.date < from || r.date > n.date) return;
        (byDay[r.date] = byDay[r.date] || []).push(r);
      });
      var today = byDay[n.date] || [];
      var presentSet = {}, lateSet = {}, inNow = {}, leaveSet = {}, flagged = 0;
      today.forEach(function (r) {
        if (r.type === 'leave') { leaveSet[r.empId] = 1; return; }
        presentSet[r.empId] = 1;
        if (Number(r.lateMin) > 0) lateSet[r.empId] = 1;
        if (!r.outTime) inNow[r.empId] = 1;
        if (r.flags) flagged++;
      });
      var isWork = s.workDays.indexOf(weekday(n.date)) >= 0;
      var present = Object.keys(presentSet).length, onLeave = Object.keys(leaveSet).length;
      var notIn = emps.filter(function (e) { return !presentSet[e.id] && !leaveSet[e.id]; });
      var trend = [], onTimeNum = 0, onTimeDen = 0;
      for (var i = 13; i >= 0; i--) {
        var d = addDays(n.date, -i), list = byDay[d] || [], p = {}, l = {};
        list.forEach(function (r) { if (r.type !== 'leave') { p[r.empId] = 1; if (Number(r.lateMin) > 0) l[r.empId] = 1; } });
        trend.push({ date: d, present: Object.keys(p).length, late: Object.keys(l).length, workday: s.workDays.indexOf(weekday(d)) >= 0 });
      }
      Object.keys(byDay).forEach(function (d) {
        var firsts = {};
        byDay[d].forEach(function (r) { if (r.type !== 'leave' && (!firsts[r.empId] || r.inTime < firsts[r.empId].inTime)) firsts[r.empId] = r; });
        Object.keys(firsts).forEach(function (k) { onTimeDen++; if (!(Number(firsts[k].lateMin) > 0)) onTimeNum++; });
      });
      var missing = decorate(all.filter(function (r) { return r.date >= from && r.type !== 'leave' && r.inTime && !r.outTime; })).filter(function (r) { return r.missingOut; }).length;
      var recent = decorate(today.filter(function (r) { return r.type !== 'leave'; })).slice(0, 10);
      var mins = 0; today.forEach(function (r) { mins += recordMinutes(r); });
      return {
        date: n.date, time: n.time, isWorkday: isWork, settings: publicSettings(),
        kpi: {
          activeEmployees: emps.length, present: present, late: Object.keys(lateSet).length, inNow: Object.keys(inNow).length,
          onLeave: onLeave, absent: isWork ? notIn.length : 0, flaggedToday: flagged, missingCheckouts: missing,
          onTimeRate30: onTimeDen ? Math.round(onTimeNum / onTimeDen * 100) : null, hoursToday: Math.round(mins / 6) / 10
        },
        notCheckedIn: isWork ? notIn.map(function (e) { return { id: e.id, code: e.code, name: e.name }; }) : [],
        trend: trend, recent: recent
      };
    }

    function monthlyReport(p) {
      var s = settings(), n = nowParts(), month = str(p.month);
      if (!/^\d{4}-\d{2}$/.test(month)) month = n.date.slice(0, 7);
      var first = month + '-01', last = addDays(addDays(first, 32).slice(0, 7) + '-01', -1);
      var until = last < n.date ? last : n.date;
      var workDays = [];
      for (var d = first; d <= until; d = addDays(d, 1)) if (s.workDays.indexOf(weekday(d)) >= 0) workDays.push(d);
      var recs = records().filter(function (r) { return r.date >= first && r.date <= last; });
      var stdDay = toMin(s.workEnd) - toMin(s.workStart); if (stdDay <= 0) stdDay += 1440;
      var brs = {}; branches().forEach(function (b) { brs[b.id] = b.name; });
      var rows = employees().filter(function (e) { var has = recs.some(function (r) { return r.empId === e.id; }); return has || (bool(e.active) && e.role !== 'admin'); }).map(function (e) {
        var mine = recs.filter(function (r) { return r.empId === e.id; });
        var present = {}, leave = {}, late = {}, minsByDay = {}, firstIn = {}, missing = 0, lateMinutes = 0;
        mine.forEach(function (r) {
          if (r.type === 'leave') { leave[r.date] = 1; return; }
          present[r.date] = 1;
          if (Number(r.lateMin) > 0) { late[r.date] = 1; lateMinutes += Number(r.lateMin); }
          minsByDay[r.date] = (minsByDay[r.date] || 0) + recordMinutes(r);
          if (!firstIn[r.date] || r.inTime < firstIn[r.date]) firstIn[r.date] = r.inTime;
          if (!r.outTime && r.date < n.date) missing++;
        });
        var total = 0, overtime = 0;
        Object.keys(minsByDay).forEach(function (k) { total += minsByDay[k]; if (minsByDay[k] > stdDay) overtime += minsByDay[k] - stdDay; });
        var ins = Object.keys(firstIn).map(function (k) { return toMin(firstIn[k]); });
        var avgIn = ins.length ? fromMin(ins.reduce(function (a, b) { return a + b; }, 0) / ins.length) : '';
        var absent = workDays.filter(function (wd) { return !present[wd] && !leave[wd]; }).length;
        return {
          empId: e.id, code: e.code, name: e.name, department: e.department || '', branch: brs[e.branchId] || '',
          workingDays: workDays.length, present: Object.keys(present).length, absent: absent, leave: Object.keys(leave).length,
          lateDays: Object.keys(late).length, lateMinutes: lateMinutes, hours: Math.round(total / 6) / 10,
          overtimeHours: Math.round(overtime / 6) / 10, avgCheckIn: avgIn, missingCheckouts: missing,
          attendanceRate: workDays.length ? Math.round(Object.keys(present).filter(function (k) { return workDays.indexOf(k) >= 0; }).length / workDays.length * 100) : null
        };
      });
      rows.sort(function (a, b) { return a.code.localeCompare(b.code); });
      return { month: month, from: first, to: last, countedUntil: until, workingDays: workDays.length, rows: rows };
    }

    // ----- router -----
    var PUBLIC = { ping: 1, login: 1, info: 1 };
    function handle(action, payload, token) {
      payload = payload || {};
      try {
        if (typeof action !== 'string') fail('VALIDATION', 'Missing action.');
        if (action === 'ping') return ok({ version: VERSION, time: env.now().toISOString() });
        if (action === 'info') return ok({ companyName: settings().companyName, version: VERSION });
        if (action === 'login') return ok(login(payload));
        var user = auth(token);
        if (bool(user.mustChangePin) && ['changePin', 'logout', 'me'].indexOf(action) < 0) fail('MUST_CHANGE_PIN', 'Please set a new PIN before continuing.');
        switch (action) {
          case 'me': return ok(myStatus(user));
          case 'logout': S.sessionDel(token); return ok({ done: true });
          case 'changePin': return ok(changePin(user, payload));
          case 'checkIn': return ok(checkIn(user, payload));
          case 'checkOut': return ok(checkOut(user, payload));
          case 'myRecords': return ok(myRecords(user, payload));
        }
        requireAdmin(user);
        switch (action) {
          case 'dashboard': return ok(dashboard());
          case 'listRecords': return ok(listRecords(payload));
          case 'saveRecord': return ok(saveRecord(user, payload));
          case 'deleteRecord': return ok(deleteRecord(user, payload));
          case 'listEmployees': return ok(employees().map(publicEmployee).sort(function (a, b) { return a.code.localeCompare(b.code); }));
          case 'saveEmployee': return ok(saveEmployee(user, payload));
          case 'setEmployeeActive': return ok(setEmployeeActive(user, payload));
          case 'importEmployees': return ok(importEmployees(user, payload));
          case 'listBranches': return ok(branches());
          case 'saveBranch': return ok(saveBranch(user, payload));
          case 'deleteBranch': return ok(deleteBranch(user, payload));
          case 'getSettings': return ok(settings());
          case 'saveSettings': return ok(saveSettings(user, payload));
          case 'monthlyReport': return ok(monthlyReport(payload));
          case 'listAudit': return ok(S.list('audit').slice().sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); }).slice(0, 500));
        }
        fail('UNKNOWN_ACTION', 'Unknown action: ' + action);
      } catch (e) {
        if (e instanceof AppError) return { ok: false, code: e.code, error: e.message, extra: e.extra };
        if (env.log) env.log(e);
        return { ok: false, code: 'SERVER', error: 'Something went wrong. Please try again.' };
      }
    }
    function ok(data) { return { ok: true, data: data }; }

    // First-time setup: creates the first admin account if there are no employees.
    function bootstrap(opts) {
      opts = opts || {};
      if (employees().length) return null;
      if (opts.settings) S.saveSettings(opts.settings);
      var salt = env.newToken().slice(0, 16), pin = opts.adminPin;
      var admin = { id: env.newId(), code: (opts.adminCode || 'ADMIN').toUpperCase(), name: opts.adminName || 'Administrator', email: '', phone: '', department: 'Management', branchId: '', role: 'admin', active: true, mustChangePin: opts.mustChangePin !== false, salt: salt, pinHash: hashPin(pin, salt), createdAt: env.now().toISOString() };
      S.insert('employees', admin);
      audit(null, 'setup', 'Initial admin account created');
      return admin;
    }

    return { handle: handle, bootstrap: bootstrap, settings: settings };
  }

  return {
    VERSION: VERSION, createApp: createApp, sha256: sha256, hashPin: hashPin, haversine: haversine,
    addDays: addDays, weekday: weekday, recordMinutes: recordMinutes, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    TABLES: {
      employees: ['id', 'code', 'name', 'email', 'phone', 'department', 'branchId', 'role', 'active', 'mustChangePin', 'salt', 'pinHash', 'createdAt'],
      branches: ['id', 'name', 'address', 'lat', 'lng', 'radius'],
      records: ['id', 'empId', 'branchId', 'date', 'type', 'inTime', 'outTime', 'inAt', 'outAt', 'inLat', 'inLng', 'inAcc', 'inDist', 'outLat', 'outLng', 'outDist', 'lateMin', 'flags', 'note', 'source', 'editedBy', 'editedAt'],
      audit: ['id', 'ts', 'actor', 'action', 'detail']
    }
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WardiyaCore;

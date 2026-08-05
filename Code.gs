/** ============================================================
 *  PM HUB v4 — Google Apps Script backend
 *  Data zůstávají v Google Sheets v tenantu Valeo. Žádná 3. strana.
 *
 *  Kontrakt (odvozeno z index.html v4):
 *    bootstrap()                      -> {user, role, settings, json, rev}
 *    saveState(json, clientRev)       -> {ok,rev} | {conflict,json,rev} | {error}
 *    fetchTranscript(meetingId)       -> json string
 *    saveTranscript(meetingId, json)  -> {ok}
 *    deleteTranscript(meetingId)      -> {ok}
 *    listBackups()                    -> [{ts,size,row}]
 *    restoreBackup(row)               -> {ok,json,rev} | {error}
 *    logAudit(action,objType,objName,detail) -> {ok}
 *    readAudit(limit)                 -> [{ts,user,action,obj}]
 *    listMembers()                    -> [{email,role}]
 *    setMember(email, role)           -> {ok} | {error}
 *    setSetting(key, value)           -> {ok} | {error}
 *    sendWeeklyReport(to, subject)    -> {ok} | {error}
 *    scanSourcesSilently()            -> {found}
 *    fetchAndClearInbox()             -> [{kind,meeting,date,text,project,driveId}]
 *    listMeetTranscripts()            -> [{id,name,date}]
 *    fetchTranscriptDoc(fileId)       -> plain text
 *    sendDailyDigest() / installTriggers() / removeTriggers()
 *    sheetPeek(url, sheet) / sheetRows(url, sheet)   — import akčních plánů
 *    pushIssuesToTasks() / testTasks()               — Google Tasks přes REST
 *    upcomingMeetings()                              — kalendář, dnes + 48 h
 *  ============================================================ */

/* ---------- konstanty ---------- */
var SH_STATE   = "_state";
var SH_BACKUP  = "_backups";
var SH_TRANS   = "_transcripts";
var SH_AUDIT   = "_audit";
var SH_MEMBERS = "_members";
var SH_SETTINGS= "_settings";
var SH_QUEUE   = "_inbox_queue";
var SH_SEEN    = "_seen_ids";
var SH_DIGEST  = "_digest_config";

var CHUNK       = 45000;   // limit buňky je 50k znaků
var MAX_BACKUPS = 15;
var MAX_SEEN    = 4000;
var MAX_AUDIT   = 5000;
var MEET_FOLDER = "Meet Recordings";
var LOCK_MS     = 20000;

/* ---------- doGet / doPost ---------- */
function doGet(e) {
  if (e && e.parameter && e.parameter.action === "projects") {
    var names = [];
    try {
      var st = JSON.parse(readStateRaw_() || "{}");
      names = (st.projects || []).map(function (p) { return p.name; });
    } catch (err) {}
    return ContentService.createTextOutput(JSON.stringify(names))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("PM Hub — Valeo P0 Suite")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Meet Catcher bookmarklet posílá sem (text/plain, JSON body). */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_MS);
  try {
    var d = JSON.parse(e.postData.contents);
    sheet_(SH_QUEUE, true).appendRow([JSON.stringify({
      kind: d.minutes ? "minutes" : "meet",
      meeting: d.meeting || "",
      date: d.date || isoDate_(new Date()),
      text: d.text || "",
      project: d.project || "",
      driveId: "post:" + Utilities.getUuid()
    })]);
  } catch (err) {
    return ContentService.createTextOutput("ERR " + err.message);
  } finally {
    lock.releaseLock();
  }
  return ContentService.createTextOutput("OK");
}

/* ---------- Spreadsheet infrastruktura ---------- */
function ss_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("SHEET_ID");
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (err) { /* fallthrough */ }
  }
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) {}
  var ss = active || SpreadsheetApp.create("PM Hub Data");
  props.setProperty("SHEET_ID", ss.getId());
  return ss;
}

function sheet_(name, hidden) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (hidden) { try { sh.hideSheet(); } catch (err) {} }
  }
  return sh;
}

function isoDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function chunk_(s) {
  return String(s).match(new RegExp("[\\s\\S]{1," + CHUNK + "}", "g")) || [""];
}

/* ---------- STATE (chunked + revize) ----------
   Layout _state:  A1 = rev (číslo), A2..An = chunky JSON */
function readStateRaw_() {
  var sh = sheet_(SH_STATE, true);
  var last = sh.getLastRow();
  if (last < 2) return "";
  return sh.getRange(2, 1, last - 1, 1).getValues()
    .map(function (r) { return r[0]; }).join("");
}

function readRev_() {
  var v = sheet_(SH_STATE, true).getRange("A1").getValue();
  var n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

function writeState_(json, rev) {
  var sh = sheet_(SH_STATE, true);
  sh.clearContents();
  var parts = chunk_(json);
  var rows = [[rev]].concat(parts.map(function (c) { return [c]; }));
  sh.getRange(1, 1, rows.length, 1).setValues(rows);
}

/** Optimistic locking: klient posílá revizi, kterou naposledy viděl. */
function saveState(json, clientRev) {
  if (!canWrite_()) return { error: "Nemáš právo zapisovat (role viewer)." };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return { error: "Server je zaneprázdněný, zkus to znovu." };
  try {
    var serverRev = readRev_();
    var cr = parseInt(clientRev, 10);
    if (isNaN(cr)) cr = 0;
    if (serverRev > 0 && cr !== serverRev) {
      return { conflict: true, json: readStateRaw_(), rev: serverRev };
    }
    backupCurrent_();
    var next = serverRev + 1;
    writeState_(json, next);
    try { mirrorToSheets_(JSON.parse(json)); } catch (err) {}
    return { ok: true, rev: next };
  } catch (err) {
    return { error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- BACKUPY (rolling 15) ----------
   Layout _backups: A=ts, B=rev, C=size, D..=chunky */
function backupCurrent_() {
  var raw = readStateRaw_();
  if (!raw) return;
  var sh = sheet_(SH_BACKUP, true);
  var parts = chunk_(raw);
  var row = [new Date().toISOString(), readRev_(), raw.length].concat(parts);
  sh.appendRow(row);
  var last = sh.getLastRow();
  if (last > MAX_BACKUPS) sh.deleteRows(1, last - MAX_BACKUPS);
}

function listBackups() {
  if (!canWrite_()) return { error: "Zálohy vidí jen editor/owner." };
  var sh = sheet_(SH_BACKUP, true);
  var last = sh.getLastRow();
  if (last < 1) return [];
  var vals = sh.getRange(1, 1, last, 3).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (!vals[i][0]) continue;
    out.push({ ts: String(vals[i][0]), rev: vals[i][1], size: Number(vals[i][2]) || 0, row: i + 1 });
  }
  return out.reverse();
}

function restoreBackup(row) {
  if (!canWrite_()) return { error: "Nemáš právo zapisovat." };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return { error: "Server je zaneprázdněný." };
  try {
    var sh = sheet_(SH_BACKUP, true);
    var r = parseInt(row, 10);
    if (!r || r > sh.getLastRow()) return { error: "Záloha neexistuje." };
    var vals = sh.getRange(r, 1, 1, sh.getLastColumn()).getValues()[0];
    var json = vals.slice(3).join("");
    if (!json) return { error: "Záloha je prázdná." };
    backupCurrent_();                 // aktuální stav se nejdřív zazálohuje
    var next = readRev_() + 1;
    writeState_(json, next);
    try { mirrorToSheets_(JSON.parse(json)); } catch (err) {}
    audit_("restore", "backup", String(vals[0]), "rev " + vals[1]);
    return { ok: true, json: json, rev: next };
  } catch (err) {
    return { error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- BOOTSTRAP ---------- */
function bootstrap() {
  var user = getUser();
  ensureOwner_(user);
  return {
    user: user,
    role: roleOf_(user),
    settings: readSettings_(),
    json: readStateRaw_(),
    rev: readRev_()
  };
}

function getUser() {
  try { return Session.getActiveUser().getEmail() || "anonym"; }
  catch (err) { return "anonym"; }
}

/* ---------- ROLE ----------
   Layout _members: A=email, B=role (owner|editor|viewer) */
function membersSheet_() {
  var sh = sheet_(SH_MEMBERS, true);
  if (sh.getLastRow() < 1) sh.getRange(1, 1, 1, 2).setValues([["email", "role"]]);
  return sh;
}

function readMembers_() {
  var sh = membersSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 2).getValues()
    .filter(function (r) { return r[0]; })
    .map(function (r) { return { email: String(r[0]).toLowerCase().trim(), role: String(r[1] || "viewer").trim() }; });
}

/** První uživatel, který appku otevře, se stane ownerem. */
function ensureOwner_(email) {
  if (!email || email === "anonym") return;
  var rows = readMembers_();
  if (rows.length) return;
  membersSheet_().appendRow([email.toLowerCase(), "owner"]);
}

function roleOf_(email) {
  var e = String(email || "").toLowerCase();
  var rows = readMembers_();
  if (!rows.length) return "owner";
  var hit = rows.filter(function (r) { return r.email === e; })[0];
  if (hit) return hit.role;
  var def = readSettings_().defaultRole;
  return def === "editor" || def === "owner" ? def : "viewer";
}

function canWrite_() {
  var r = roleOf_(getUser());
  return r === "owner" || r === "editor";
}

function isOwner_() {
  return roleOf_(getUser()) === "owner";
}

function listMembers() {
  return readMembers_();
}

function setMember(email, role) {
  if (!isOwner_()) return { error: "Role může měnit jen owner." };
  var e = String(email || "").toLowerCase().trim();
  if (!e || e.indexOf("@") < 0) return { error: "Neplatný e-mail." };
  if (["owner", "editor", "viewer"].indexOf(role) < 0) return { error: "Neplatná role." };
  var sh = membersSheet_();
  var last = sh.getLastRow();
  var found = 0;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).toLowerCase().trim() === e) { found = i + 2; break; }
    }
  }
  if (found) sh.getRange(found, 2).setValue(role);
  else sh.appendRow([e, role]);
  audit_("setRole", "member", e, role);
  return { ok: true };
}

/* ---------- SETTINGS ----------
   Layout _settings: A=key, B=value. hasGemini/geminiModel jsou derived, read-only. */
var SETTING_KEYS = ["meetScan", "gmailScan", "gmailQuery", "gmailSnippet", "defaultRole",
  "weeklyTo", "calScan", "calLookback", "calMax", "meetMax", "tasksPush",
  "geminiScan", "geminiFolder"];

var SETTING_DEFAULTS = [
  ["meetScan", "on"],
  ["gmailScan", "off"],
  ["gmailQuery", "newer_than:3d -in:chats -in:drafts -in:spam"],
  ["gmailSnippet", "600"],
  ["calScan", "off"],
  ["calLookback", "14"],
  ["calMax", "10"],
  ["meetMax", "20"],
  ["tasksPush", "off"],
  ["geminiScan", "on"],
  ["geminiFolder", "1RpUlXw1Keo_-Lw78PYSXn7Snxp-VwGju"]
];

/** Doplní klíče, které v listu chybí (migrace po přidání nových nastavení). */
function settingsSheet_() {
  var sh = sheet_(SH_SETTINGS, true);
  var last = sh.getLastRow();
  var have = {};
  if (last >= 1) {
    sh.getRange(1, 1, last, 1).getValues().forEach(function (r) {
      if (r[0]) have[String(r[0])] = 1;
    });
  }
  var add = SETTING_DEFAULTS.filter(function (d) { return !have[d[0]]; });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 2).setValues(add);
  return sh;
}

function readSettings_() {
  var sh = settingsSheet_();
  var last = sh.getLastRow();
  var out = {};
  if (last >= 1) {
    sh.getRange(1, 1, last, 2).getValues().forEach(function (r) {
      if (r[0]) out[String(r[0])] = String(r[1]);
    });
  }
  var key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  out.hasGemini = !!key;
  out.geminiModel = PropertiesService.getScriptProperties().getProperty("GEMINI_MODEL") || "gemini-2.0-flash";
  return out;
}

function setSetting(key, value) {
  if (!canWrite_()) return { error: "Nemáš právo zapisovat." };
  if (SETTING_KEYS.indexOf(key) < 0) return { error: "Neznámé nastavení: " + key };
  var sh = settingsSheet_();
  var last = sh.getLastRow();
  var found = 0;
  if (last >= 1) {
    var vals = sh.getRange(1, 1, last, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) === key) { found = i + 1; break; }
    }
  }
  if (found) sh.getRange(found, 2).setValue(value);
  else sh.appendRow([key, value]);
  audit_("setSetting", "settings", key, String(value));
  return { ok: true };
}

/* ---------- AUDIT (append-only) ----------
   Layout _audit: A=ts, B=user, C=action, D=obj, E=detail */
function audit_(action, objType, objName, detail) {
  try {
    var sh = sheet_(SH_AUDIT, true);
    sh.appendRow([new Date().toISOString(), getUser(), action,
      (objType || "") + (objName ? ": " + objName : ""), detail || ""]);
    var last = sh.getLastRow();
    if (last > MAX_AUDIT * 1.2) sh.deleteRows(1, last - MAX_AUDIT);
  } catch (err) {}
}

function logAudit(action, objType, objName, detail) {
  audit_(action, objType, objName, detail);
  return { ok: true };
}

function readAudit(limit) {
  if (!canWrite_()) return { error: "Historii změn vidí jen editor/owner." };
  var sh = sheet_(SH_AUDIT, true);
  var last = sh.getLastRow();
  if (last < 1) return [];
  var n = Math.min(parseInt(limit, 10) || 150, last);
  var vals = sh.getRange(last - n + 1, 1, n, 5).getValues();
  return vals.filter(function (r) { return r[0]; })
    .map(function (r) {
      return { ts: String(r[0]), user: String(r[1]), action: String(r[2]), obj: String(r[3]), detail: String(r[4]) };
    }).reverse();
}

/* ---------- TRANSKRIPTY (mimo state — lazy load) ----------
   Layout _transcripts: A=meetingId, B=chunkIndex, C=text
   Blocky mohou být velké, proto se do state nikdy neukládají. */
function transSheet_() {
  return sheet_(SH_TRANS, true);
}

function transRows_(meetingId) {
  var sh = transSheet_();
  var last = sh.getLastRow();
  if (last < 1) return { sh: sh, rows: [] };
  var vals = sh.getRange(1, 1, last, 3).getValues();
  var rows = [];
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(meetingId)) rows.push({ row: i + 1, idx: Number(vals[i][1]) || 0, text: vals[i][2] });
  }
  return { sh: sh, rows: rows };
}

function fetchTranscript(meetingId) {
  var r = transRows_(meetingId);
  if (!r.rows.length) return "[]";
  r.rows.sort(function (a, b) { return a.idx - b.idx; });
  return r.rows.map(function (x) { return x.text; }).join("");
}

function saveTranscript(meetingId, json) {
  if (!canWrite_()) return { error: "Nemáš právo zapisovat." };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return { error: "Server je zaneprázdněný." };
  try {
    deleteTranscriptRows_(meetingId);
    var parts = chunk_(json || "[]");
    var sh = transSheet_();
    var rows = parts.map(function (c, i) { return [String(meetingId), i, c]; });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function deleteTranscriptRows_(meetingId) {
  var r = transRows_(meetingId);
  // mazat odzadu, ať se indexy neposunou
  r.rows.sort(function (a, b) { return b.row - a.row; })
    .forEach(function (x) { r.sh.deleteRow(x.row); });
}

function deleteTranscript(meetingId) {
  if (!canWrite_()) return { error: "Nemáš právo zapisovat." };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return { error: "Server je zaneprázdněný." };
  try {
    deleteTranscriptRows_(meetingId);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- MIRROR do čitelných listů (Hub zůstává zdroj pravdy) ---------- */
function mirrorToSheets_(state) {
  var ss = ss_();
  var write = function (name, headers, rows) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clear();
    var data = [headers].concat(rows.length ? rows : []);
    sh.getRange(1, 1, data.length, headers.length).setValues(data);
    sh.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sh.setFrozenRows(1);
  };
  var projs = state.projects || [];
  write("Projects", ["Projekt", "Založeno", "Porad", "Issues"],
    projs.map(function (p) {
      return [p.name, String(p.createdAt || "").slice(0, 10), (p.meetings || []).length, (p.issues || []).length];
    }));
  var issues = [];
  projs.forEach(function (p) {
    (p.issues || []).forEach(function (i) {
      issues.push([p.name, i.type || "", i.title || "", i.problem || "", i.responsible || "",
        i.from || "", i.due || "", i.status || "", i.priority || "", i.gate || "", i.source || ""]);
    });
  });
  write("Issues", ["Projekt", "Typ", "Název", "Problém", "Odpovědný", "Od", "Termín", "Status", "Priorita", "Gate", "Zdroj"], issues);
}

/* ---------- DRIVE: transkripty z Meet ---------- */
function meetFolder_() {
  var it = DriveApp.getFoldersByName(MEET_FOLDER);
  return it.hasNext() ? it.next() : null;
}

function listMeetTranscripts() {
  var folder = meetFolder_();
  if (!folder) return [];
  var out = [];
  var files = folder.getFilesByType(MimeType.GOOGLE_DOCS);
  while (files.hasNext()) {
    var f = files.next();
    out.push({ id: f.getId(), name: f.getName(), date: isoDate_(f.getLastUpdated()) });
  }
  out.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  return out.slice(0, 60);
}

function fetchTranscriptDoc(fileId) {
  return DocumentApp.openById(fileId).getBody().getText();
}

/* ---------- INBOX FRONTA ---------- */
function fetchAndClearInbox() {
  if (!canWrite_()) return [];   // fronta se čistí = zápis; viewer nesmí
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return [];
  try {
    var sh = sheet_(SH_QUEUE, true);
    var last = sh.getLastRow();
    if (last < 1) return [];
    var vals = sh.getRange(1, 1, last, 1).getValues();
    sh.clearContents();
    return vals.map(function (r) {
      try { return JSON.parse(r[0]); } catch (err) { return null; }
    }).filter(Boolean);
  } finally {
    lock.releaseLock();
  }
}

function pushToQueue_(items) {
  if (!items.length) return;
  var sh = sheet_(SH_QUEUE, true);
  sh.getRange(sh.getLastRow() + 1, 1, items.length, 1)
    .setValues(items.map(function (it) { return [JSON.stringify(it)]; }));
}

/* ---------- SEEN-TRACKING (na listu, ne v Properties — 9KB limit) ---------- */
function seenLoad_(source) {
  var sh = sheet_(SH_SEEN, true);
  var last = sh.getLastRow();
  var set = {};
  if (last < 1) return set;
  sh.getRange(1, 1, last, 2).getValues().forEach(function (r) {
    if (r[0] === source) set[r[1]] = 1;
  });
  return set;
}

function seenAppend_(source, ids) {
  if (!ids.length) return;
  var sh = sheet_(SH_SEEN, true);
  sh.getRange(sh.getLastRow() + 1, 1, ids.length, 2)
    .setValues(ids.map(function (id) { return [source, id]; }));
  var last = sh.getLastRow();
  if (last > MAX_SEEN * 2) {
    var all = sh.getRange(1, 1, last, 2).getValues();
    var by = {};
    all.forEach(function (r) { (by[r[0]] = by[r[0]] || []).push(r); });
    var trimmed = [];
    Object.keys(by).forEach(function (k) { trimmed = trimmed.concat(by[k].slice(-MAX_SEEN)); });
    sh.clearContents();
    if (trimmed.length) sh.getRange(1, 1, trimmed.length, 2).setValues(trimmed);
  }
}

/* ---------- SCAN ZDROJŮ (trigger každých 30 min) ---------- */
function scanSourcesSilently() {
  // Přes UI smí skenovat jen editor/owner (skeny berou kvótu a čtou Gmail/Drive).
  // Časový trigger běží pod identitou ownera, který ho založil, takže projde.
  if (!canWrite_()) return { found: 0, error: "Nemáš právo skenovat (role viewer)." };
  var s = readSettings_();
  var found = [];
  if (s.meetScan !== "off") {
    try { found = found.concat(scanMeet_(s)); } catch (err) { audit_("scanError", "meet", "", err.message); }
  }
  if (s.gmailScan === "on") {
    try { found = found.concat(scanGmail_(s)); } catch (err) { audit_("scanError", "gmail", "", err.message); }
  }
  if (s.geminiScan !== "off") {
    try { found = found.concat(scanGemini_(s)); } catch (err) { audit_("scanError", "gemini", "", err.message); }
  }
  if (s.calScan === "on") {
    try { found = found.concat(scanCalendar_(s)); } catch (err) { audit_("scanError", "calendar", "", err.message); }
  }
  pushToQueue_(found);
  if (s.tasksPush === "on") {
    try { pushIssuesToTasks(); } catch (err) { audit_("scanError", "tasks", "", err.message); }
  }
  return { found: found.length };
}

/** Strop na dávku — 60 transkriptů naráz by frontu zavalilo a vyčerpalo kvótu. */
function scanMeet_(s) {
  var folder = meetFolder_();
  if (!folder) return [];
  var max = parseInt((s || {}).meetMax, 10);
  if (isNaN(max) || max < 1) max = 20;
  var seen = seenLoad_("meet");
  var out = [], newIds = [];
  var files = folder.getFilesByType(MimeType.GOOGLE_DOCS);
  while (files.hasNext()) {
    if (out.length >= max) break;
    var f = files.next();
    var id = f.getId();
    if (seen[id]) continue;
    newIds.push(id);
    var name = f.getName();
    out.push({
      kind: "meet",
      meeting: name,
      date: isoDate_(f.getLastUpdated()),
      text: DocumentApp.openById(id).getBody().getText(),
      project: guessProjectFromName_(name),
      driveId: id
    });
  }
  seenAppend_("meet", newIds);
  return out;
}

function guessProjectFromName_(name) {
  var m = String(name).match(/[-–:]\s*([^-–:]+)$/);
  return m ? m[1].trim() : String(name);
}

/** GDPR: bere jen vlákna, kde se předmět trefí s názvem projektu nebo klíčovým
 *  slovem, a ukládá jen snippet (default 600 znaků). Vypnuto do schválení. */
function scanGmail_(s) {
  var st;
  try { st = JSON.parse(readStateRaw_() || "{}"); } catch (err) { return []; }
  var projects = st.projects || [];
  if (!projects.length) return [];

  var terms = [];
  projects.forEach(function (p) {
    terms.push({ name: p.name, t: String(p.name).toLowerCase() });
    (p.keywords || []).forEach(function (k) {
      if (k) terms.push({ name: p.name, t: String(k).toLowerCase() });
    });
  });

  var limit = parseInt(s.gmailSnippet, 10) || 600;
  var query = s.gmailQuery || "newer_than:3d -in:chats -in:drafts -in:spam";
  var seen = seenLoad_("gmail");
  var out = [], newIds = [];
  var threads = GmailApp.search(query, 0, 100);

  threads.forEach(function (th) {
    var subject = th.getFirstMessageSubject() || "";
    var sl = subject.toLowerCase();
    var hit = null;
    for (var i = 0; i < terms.length; i++) {
      if (sl.indexOf(terms[i].t) >= 0) { hit = terms[i].name; break; }
    }
    if (!hit) return;                      // žádná trefa v předmětu -> vůbec se nečte tělo
    th.getMessages().forEach(function (msg) {
      var mid = msg.getId();
      if (seen[mid]) return;
      newIds.push(mid);
      out.push({
        kind: "email",
        meeting: subject,
        date: isoDate_(msg.getDate()),
        text: subject + ". " + msg.getPlainBody().slice(0, limit),
        project: hit,
        driveId: "gmail:" + mid
      });
    });
  });
  seenAppend_("gmail", newIds);
  return out;
}

/* ---------- GOOGLE CHAT (vyžaduje standardní GCP projekt + Chat advanced service) ---------- */
function listChatSpaces() {
  if (typeof Chat === "undefined") return { error: "Chat API není zapnutá (Services → Google Chat API)." };
  var spaces = [], pageToken = null;
  do {
    var r = Chat.Spaces.list({ pageSize: 100, pageToken: pageToken });
    (r.spaces || []).forEach(function (sp) {
      spaces.push({ name: sp.name, displayName: sp.displayName || sp.name, type: sp.spaceType || "" });
    });
    pageToken = r.nextPageToken;
  } while (pageToken);
  return spaces;
}

function fetchChatMessages(spaceName, sinceIso) {
  if (typeof Chat === "undefined") return [];
  var out = [], pageToken = null;
  var filter = sinceIso ? 'createTime > "' + sinceIso + '"' : undefined;
  do {
    var r = Chat.Spaces.Messages.list(spaceName, { pageSize: 100, pageToken: pageToken, filter: filter });
    (r.messages || []).forEach(function (m) {
      if (!m.text) return;
      out.push({
        speaker: (m.sender && m.sender.displayName) || "—",
        time: String(m.createTime).slice(11, 16),
        text: m.text
      });
    });
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

/* ---------- TÝDENNÍ REPORT ---------- */
function sendWeeklyReport(to, subject) {
  if (!canWrite_()) return { error: "Report smí odeslat jen editor/owner (role viewer)." };
  if (!to || String(to).indexOf("@") < 0) return { error: "Zadej platný e-mail." };
  var st;
  try { st = JSON.parse(readStateRaw_() || "{}"); } catch (err) { return { error: "Stav se nepodařilo přečíst." }; }
  var today = isoDate_(new Date());
  var lines = [], total = 0;

  (st.projects || []).forEach(function (p) {
    var open = (p.issues || []).filter(function (i) { return i.status !== "Done"; });
    var late = open.filter(function (i) { return i.due && i.due < today; });
    var high = open.filter(function (i) { return i.priority === "High" && (!i.due || i.due >= today); });
    if (!open.length) return;
    lines.push("");
    lines.push("--- " + p.name + " --- (" + open.length + " otevřených, " + late.length + " po termínu)");
    late.concat(high).slice(0, 15).forEach(function (i) {
      var flag = i.due && i.due < today ? " [PO TERMÍNU]" : "";
      lines.push("• [" + (i.type || "?") + "] " + (i.title || "") +
        " — " + (i.responsible || "nepřiřazeno") + " — " + (i.due || "bez termínu") + flag);
      total++;
    });
  });

  if (!total) return { error: "Není co reportovat — žádné otevřené issues." };

  var url = "";
  try { url = ScriptApp.getService().getUrl(); } catch (err) {}
  var body = "PM Hub — týdenní status (" + today + ")\n" + lines.join("\n") +
    "\n\nGenerováno automaticky z PM Hub." + (url ? "\nOtevřít: " + url : "");
  try {
    MailApp.sendEmail(String(to), subject || ("PM Hub týdenní status " + today), body);
    audit_("sendReport", "weekly", String(to), total + " issues");
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/* ---------- DENNÍ DIGEST ----------
   Odběratelé v listu _digest_config: A=email, B=oddělení, C=projekty (all | názvy oddělené čárkou) */
function digestSheet_() {
  var sh = sheet_(SH_DIGEST, false);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 2, 3).setValues([
      ["Email", "Oddělení", "Projekty (all nebo název,název)"],
      [getUser(), "PM", "all"]
    ]);
    sh.getRange(1, 1, 1, 3).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function sendDailyDigest() {
  // Trigger běží jako owner, který ho založil; přes UI jen editor/owner.
  if (!canWrite_()) return "Digest smí odeslat jen editor/owner (role viewer).";
  var st;
  try { st = JSON.parse(readStateRaw_() || "{}"); } catch (err) { return "Stav se nepodařilo přečíst."; }
  var sh = digestSheet_();
  var last = sh.getLastRow();
  if (last < 2) return "Žádní odběratelé v _digest_config.";
  var rows = sh.getRange(2, 1, last - 1, 3).getValues().filter(function (r) { return r[0]; });
  if (!rows.length) return "Žádní odběratelé v _digest_config.";

  var today = isoDate_(new Date());
  var sent = 0, skipped = 0;

  rows.forEach(function (r) {
    var email = String(r[0]).trim();
    var dept = String(r[1] || "");
    var filter = String(r[2] || "all").trim().toLowerCase();
    var wantAll = !filter || filter === "all";
    var wanted = wantAll ? null : filter.split(",").map(function (x) { return x.trim(); });

    var lines = [], count = 0;
    (st.projects || []).forEach(function (p) {
      if (wanted && wanted.indexOf(String(p.name).toLowerCase()) < 0) return;
      var critical = (p.issues || []).filter(function (i) {
        var late = i.due && i.due < today && i.status !== "Done";
        return i.status !== "Done" && (i.priority === "High" || late);
      });
      if (!critical.length) return;
      lines.push("");
      lines.push("--- " + p.name + " ---");
      critical.forEach(function (i) {
        var flag = i.due && i.due < today ? " [PO TERMÍNU]" : "";
        lines.push("• [" + (i.type || "?") + "] " + (i.title || "") +
          " — " + (i.responsible || "nepřiřazeno") + " — termín " + (i.due || "—") + flag);
        count++;
      });
    });

    if (!count) { skipped++; return; }   // nic kritického -> neposílat prázdný digest
    var url = "";
    try { url = ScriptApp.getService().getUrl(); } catch (err) {}
    var body = "PM Hub — denní přehled (" + today + ")\n" + lines.join("\n") +
      (url ? "\n\nOtevřít PM Hub: " + url : "");
    try {
      MailApp.sendEmail(email, "PM Hub digest " + today + (dept ? " — " + dept : ""), body);
      sent++;
    } catch (err) { skipped++; }
  });

  audit_("sendDigest", "daily", "", sent + " odesláno, " + skipped + " přeskočeno");
  return "Odesláno: " + sent + " · přeskočeno (nic kritického): " + skipped;
}

/* ---------- IMPORT AKČNÍCH PLÁNŮ Z GOOGLE SHEETS ----------
   Dvoufázově: sheetPeek() vrátí náhled + odhad mapování sloupců, uživatel ho
   ve frontendu potvrdí, sheetRows() pak dotáhne všechny řádky. */

var COLMAP = {
  title:       ["akce", "action", "úkol", "ukol", "task", "opatření", "opatreni", "řešení", "reseni", "solution", "co", "popis", "description", "activity", "aktivita"],
  problem:     ["problém", "problem", "issue", "příčina", "pricina", "root cause", "nález", "nalez", "finding", "neshoda", "riziko", "risk"],
  responsible: ["odpovědný", "odpovedny", "responsible", "owner", "pilot", "kdo", "assignee", "garant", "zodpovídá", "zodpovida"],
  due:         ["termín", "termin", "due", "deadline", "do", "target date", "due date", "plánované ukončení", "planovane ukonceni"],
  from:        ["od", "start", "začátek", "zacatek", "start date", "zadáno", "zadano", "created"],
  status:      ["status", "stav", "state", "progress"],
  priority:    ["priorita", "priority", "kritičnost", "kritičnost", "severity"],
  gate:        ["gate", "milník", "milnik", "milestone", "fáze", "faze"],
  type:        ["typ", "type", "kategorie", "category"]
};

function norm_(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

function guessColumns_(headers) {
  var map = {};
  var used = {};
  Object.keys(COLMAP).forEach(function (field) {
    for (var i = 0; i < headers.length; i++) {
      if (used[i]) continue;
      var h = norm_(headers[i]);
      if (!h) continue;
      var syn = COLMAP[field];
      for (var j = 0; j < syn.length; j++) {
        var s = norm_(syn[j]);
        if (h === s || h.indexOf(s) === 0 || (s.length > 3 && h.indexOf(s) >= 0)) {
          map[field] = i; used[i] = 1; return;
        }
      }
    }
  });
  return map;
}

function openByUrlOrId_(urlOrId) {
  var s = String(urlOrId || "").trim();
  var m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  var id = m ? m[1] : s;
  if (!id) throw new Error("Prázdný odkaz.");
  return SpreadsheetApp.openById(id);
}

/** gid z odkazu (…#gid=123 nebo ?gid=123) */
function gidFromUrl_(urlOrId) {
  var m = String(urlOrId || "").match(/[#&?]gid=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Vybere list: podle jména → podle gid v odkazu → první NEPRÁZDNÝ → první. */
function pickSheet_(ss, urlOrId, sheetName) {
  var sheets = ss.getSheets();
  if (sheetName) {
    var byName = ss.getSheetByName(sheetName);
    if (byName) return byName;
  }
  var gid = gidFromUrl_(urlOrId);
  if (gid !== null) {
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getSheetId() === gid) return sheets[i];
    }
  }
  for (var j = 0; j < sheets.length; j++) {
    if (sheets[j].getLastRow() >= 2) return sheets[j];
  }
  return sheets[0] || null;
}

/** Seznam listů s počtem datových řádků — frontend podle toho nabídne přepínač. */
function sheetList_(ss) {
  return ss.getSheets().map(function (sh) {
    return { name: sh.getName(), rows: Math.max(0, sh.getLastRow() - 1) };
  });
}

/** Náhled: seznam listů, hlavička, prvních 5 řádků, odhad mapování. */
function sheetPeek(urlOrId, sheetName) {
  var ss;
  try {
    ss = openByUrlOrId_(urlOrId);
  } catch (err) {
    return { error: "Tabulku nelze otevřít — zkontroluj odkaz a že k ní máš přístup. (" + err.message + ")" };
  }
  var sheets = sheetList_(ss);
  try {
    var sh = pickSheet_(ss, urlOrId, sheetName);
    if (!sh) return { error: "Tabulka neobsahuje žádné listy.", title: ss.getName(), sheets: sheets };
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) {
      var nonEmpty = sheets.filter(function (x) { return x.rows > 0; });
      return {
        error: "List „" + sh.getName() + "“ je prázdný nebo má jen hlavičku." +
          (nonEmpty.length ? " Vyber jiný list výše." : " V celé tabulce nejsou žádná data."),
        title: ss.getName(), sheets: sheets, sheet: sh.getName()
      };
    }
    var n = Math.min(6, lastRow);
    var vals = sh.getRange(1, 1, n, lastCol).getDisplayValues();
    var headers = vals[0];
    return {
      ok: true,
      title: ss.getName(),
      sheets: sheets,
      sheet: sh.getName(),
      headers: headers,
      preview: vals.slice(1),
      rowCount: lastRow - 1,
      map: guessColumns_(headers)
    };
  } catch (err) {
    return { error: err.message, title: ss.getName(), sheets: sheets };
  }
}

/** Všechny řádky jako pole polí (display values, tj. datumy už jako text). */
function sheetRows(urlOrId, sheetName) {
  try {
    var ss = openByUrlOrId_(urlOrId);
    var sh = pickSheet_(ss, urlOrId, sheetName);
    if (!sh) return { error: "List nenalezen." };
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2) return { error: "Žádná data." };
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    audit_("import", "sheet", ss.getName() + " / " + sh.getName(), (lastRow - 1) + " řádků");
    return { ok: true, rows: vals, source: ss.getName() + " / " + sh.getName() };
  } catch (err) {
    return { error: err.message };
  }
}

/* ---------- CALENDAR: porady bez zápisu + příprava ----------
   Nedělá NLP. Posílá hotová issues kanálem kind:"issue". */

function normTitle_(s) {
  return String(s || "").toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

var CAL_SKIP_RX = /dovolen|holiday|urlaub|out of office|\booo\b|ob[eě]d|lunch|blocker|focus|soukrom|private|dentist|l[eé]ka[rř]/i;

/** Porady z minulosti, ke kterým v Hubu není zápis → issue typu task. */
function scanCalendar_(s) {
  var lookback = parseInt(s.calLookback, 10);
  if (isNaN(lookback) || lookback < 1) lookback = 14;

  var cal = CalendarApp.getDefaultCalendar();
  if (!cal) return [];

  var now = new Date();
  var from = new Date(now.getTime() - lookback * 864e5);
  var events = cal.getEvents(from, now);
  if (!events.length) return [];

  // co už v Hubu je (podle eventId i podle datum+název)
  var haveIds = {}, haveTitles = {};
  try {
    var st = JSON.parse(readStateRaw_() || "{}");
    (st.projects || []).forEach(function (p) {
      (p.meetings || []).forEach(function (m) {
        if (m.eventId) haveIds[m.eventId] = 1;
        haveTitles[(m.date || "") + "|" + normTitle_(m.title)] = 1;
      });
    });
  } catch (err) {}

  var seen = seenLoad_("calendar");
  var out = [], newIds = [];
  var me = getUser().toLowerCase();
  var max = parseInt(s.calMax, 10);
  if (isNaN(max) || max < 1) max = 10;

  events.reverse();                     // od nejnovějších — ty jsou relevantnější

  events.forEach(function (ev) {
    if (out.length >= max) return;
    var id = ev.getId();
    if (seen[id] || haveIds[id]) return;

    var title = ev.getTitle() || "";
    if (!title || CAL_SKIP_RX.test(title)) return;
    if (ev.isAllDayEvent()) return;

    var guests = ev.getGuestList(true);
    if (guests.length < 2) return;                       // sólo blok, ne porada

    var mine = guests.filter(function (g) { return String(g.getEmail()).toLowerCase() === me; })[0];
    if (mine && mine.getGuestStatus() === CalendarApp.GuestStatus.NO) return;  // odmítl jsem

    var date = isoDate_(ev.getStartTime());
    if (haveTitles[date + "|" + normTitle_(title)]) return;

    newIds.push(id);
    var names = guests.map(function (g) { return g.getName() || g.getEmail(); }).slice(0, 12);

    out.push({
      kind: "issue",
      meeting: title,
      date: date,
      project: title,                                     // hint pro matchProject
      driveId: "cal:" + id,
      issue: {
        type: "task",
        title: "Chybí zápis z porady: " + title,
        problem: "Porada " + date + " (" + names.length + " účastníků) proběhla, v Hubu k ní není zápis.",
        responsible: "",
        due: isoDate_(new Date(ev.getEndTime().getTime() + 2 * 864e5)),
        priority: "Medium",
        status: "Open",
        source: "Kalendář",
        quote: title + " · " + names.join(", ")
      },
      eventId: id
    });
  });

  seenAppend_("calendar", newIds);
  return out;
}

/** Dnešní a zítřejší porady — pro cockpit, nejde do fronty. */
function upcomingMeetings() {
  try {
    var cal = CalendarApp.getDefaultCalendar();
    if (!cal) return [];
    var now = new Date();
    var to = new Date(now.getTime() + 2 * 864e5);
    return cal.getEvents(now, to).filter(function (ev) {
      return !ev.isAllDayEvent() && !CAL_SKIP_RX.test(ev.getTitle() || "");
    }).map(function (ev) {
      var g = ev.getGuestList(true);
      return {
        id: ev.getId(),
        title: ev.getTitle() || "",
        start: Utilities.formatDate(ev.getStartTime(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm"),
        end: Utilities.formatDate(ev.getEndTime(), Session.getScriptTimeZone(), "HH:mm"),
        guests: g.length,
        names: g.map(function (x) { return x.getName() || x.getEmail(); }).slice(0, 10)
      };
    });
  } catch (err) {
    return { error: err.message };
  }
}

/* ---------- GOOGLE TASKS: push issues, aby je viděl i Gemini ----------
   Přes REST + ScriptApp.getOAuthToken() — advanced service NENÍ potřeba.
   Mapování issueId → taskId na listu _task_map, aby se netvořily duplikáty. */

var TASKLIST_NAME = "PM Hub";
var TASKS_API = "https://tasks.googleapis.com/tasks/v1";

/** REST místo advanced service — nevyžaduje zapnutí služby v editoru. */
function tasksApi_(method, path, payload) {
  var opt = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }
  };
  if (payload) {
    opt.contentType = "application/json";
    opt.payload = JSON.stringify(payload);
  }
  var res = UrlFetchApp.fetch(TASKS_API + path, opt);
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code === 204 || !body) return {};
  var json;
  try { json = JSON.parse(body); } catch (err) { throw new Error("Tasks API: neplatná odpověď (" + code + ")"); }
  if (code >= 400) {
    var msg = (json.error && json.error.message) || body;
    if (code === 403 && /disabled|not.*enabled|accessNotConfigured/i.test(msg)) {
      throw new Error("Tasks API není povolená v GCP projektu skriptu. " +
        "Project Settings → Google Cloud Platform (GCP) Project → otevřít konzoli → " +
        "APIs & Services → povolit „Google Tasks API“.");
    }
    if (code === 401) throw new Error("Chybí oprávnění pro Tasks — nasaď novou verzi a odklikni consent.");
    throw new Error("Tasks API " + code + ": " + msg);
  }
  return json;
}

function taskMapSheet_() {
  var sh = sheet_("_task_map", true);
  if (sh.getLastRow() < 1) sh.getRange(1, 1, 1, 3).setValues([["issueId", "taskId", "hash"]]);
  return sh;
}

function taskListId_() {
  // Advanced service, když je k dispozici (u default GCP projektu je to jediná
  // cesta, jak API povolit). REST jinak — funguje na standardním GCP projektu.
  if (typeof Tasks !== "undefined") {
    var lists = (Tasks.Tasklists.list({ maxResults: 100 }).items) || [];
    for (var k = 0; k < lists.length; k++) {
      if (lists[k].title === TASKLIST_NAME) return lists[k].id;
    }
    return Tasks.Tasklists.insert({ title: TASKLIST_NAME }).id;
  }
  var r = tasksApi_("get", "/users/@me/lists?maxResults=100");
  var items = r.items || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].title === TASKLIST_NAME) return items[i].id;
  }
  return tasksApi_("post", "/users/@me/lists", { title: TASKLIST_NAME }).id;
}

function taskInsert_(listId, body) {
  if (typeof Tasks !== "undefined") return Tasks.Tasks.insert(body, listId);
  return tasksApi_("post", "/lists/" + listId + "/tasks", body);
}

function taskPatch_(listId, taskId, body) {
  if (typeof Tasks !== "undefined") return Tasks.Tasks.patch(body, listId, taskId);
  return tasksApi_("patch", "/lists/" + listId + "/tasks/" + taskId, body);
}

/** Vypíše syrový začátek prvního transkriptu z Drive — abychom viděli formát.
 *  Spusť z editoru, výstup přečti v Protokolu spuštění. */
function peekTranscript(n) {
  var files = listMeetTranscripts();
  if (!files.length) { Logger.log("Ve složce „" + MEET_FOLDER + "“ nejsou žádné Google Docs."); return; }
  var idx = parseInt(n, 10) || 0;
  if (idx >= files.length) idx = 0;
  var f = files[idx];
  var text = fetchTranscriptDoc(f.id);

  var lines = text.split(/\r?\n/);
  var out = [];
  out.push("SOUBOR: " + f.name + "   (" + f.date + ")");
  out.push("Celkem znaků: " + text.length + ", řádků: " + lines.length);
  out.push("Transkript " + (idx + 1) + " z " + files.length + " — jiný ukážeš: peekTranscript(1)");
  out.push("");
  out.push("---------- PRVNÍCH 40 NEPRÁZDNÝCH ŘÁDKŮ ----------");
  var shown = 0;
  for (var i = 0; i < lines.length && shown < 40; i++) {
    var l = lines[i];
    if (!l.trim()) continue;
    shown++;
    out.push(String(shown).padStart(2, "0") + " |" + l.slice(0, 160));
  }
  Logger.log(out.join("\n"));
  return out.join("\n");
}

/** Seznam souborů ve složce Meet Recordings — ať víme, co se vlastně skenuje. */
function peekMeetFiles() {
  var files = listMeetTranscripts();
  var out = ["Ve složce „" + MEET_FOLDER + "“: " + files.length + " Google Docs", ""];
  files.slice(0, 25).forEach(function (f, i) {
    out.push(i + ": " + f.date + "  " + f.name);
  });
  Logger.log(out.join("\n"));
  return out.join("\n");
}

/** Otestuj z editoru — vrátí buď ID seznamu, nebo konkrétní návod, co chybí. */
function testTasks() {
  var msg;
  try { msg = "OK — seznam „" + TASKLIST_NAME + "“ má ID " + taskListId_(); }
  catch (err) { msg = "CHYBA: " + err.message; }
  Logger.log(msg);          // Apps Script návratovou hodnotu nezobrazuje, proto log
  return msg;
}

/** Diagnostika všech konektorů naráz — spusť z editoru a přečti Protokol. */
function testAll() {
  var out = [];

  out.push("Uživatel: " + getUser());
  out.push("Role: " + roleOf_(getUser()));

  try { out.push("Sheet: " + ss_().getId()); }
  catch (err) { out.push("Sheet CHYBA: " + err.message); }

  try { out.push("Revize stavu: #" + readRev_() + ", délka JSON: " + readStateRaw_().length); }
  catch (err) { out.push("Stav CHYBA: " + err.message); }

  try {
    var s = readSettings_();
    out.push("Nastavení: meetScan=" + s.meetScan + ", gmailScan=" + s.gmailScan +
      ", calScan=" + s.calScan + " (lookback " + s.calLookback + "d, max " + s.calMax +
      "), meetMax=" + s.meetMax + ", tasksPush=" + s.tasksPush + ", Gemini=" + s.hasGemini);
  } catch (err) { out.push("Nastavení CHYBA: " + err.message); }

  try {
    var f = meetFolder_();
    out.push("Drive „" + MEET_FOLDER + "“: " + (f ? listMeetTranscripts().length + " transkriptů" : "složka neexistuje"));
  } catch (err) { out.push("Drive CHYBA: " + err.message); }

  try {
    var cal = CalendarApp.getDefaultCalendar();
    var ev = cal.getEvents(new Date(Date.now() - 7 * 864e5), new Date());
    out.push("Kalendář: " + ev.length + " porad za posledních 7 dní");
  } catch (err) { out.push("Kalendář CHYBA: " + err.message); }

  try { out.push("Tasks: seznam „" + TASKLIST_NAME + "“ ID " + taskListId_()); }
  catch (err) { out.push("Tasks CHYBA: " + err.message); }

  try { out.push("Gmail: " + GmailApp.search("newer_than:1d", 0, 5).length + " vláken za den (jen test přístupu)"); }
  catch (err) { out.push("Gmail CHYBA: " + err.message); }

  try {
    var gf = gemFolder_(readSettings_().geminiFolder);
    out.push("Gemini složka: " + (gf ? "OK" : "neexistuje — vytvoř „" + GEM_FOLDER + "“ na Drive"));
  } catch (err) { out.push("Gemini CHYBA: " + err.message); }
  out.push("Tasks služba: " + (typeof Tasks === "undefined" ? "REST (advanced service není)" : "advanced service"));
  out.push("Chat API: " + (typeof Chat === "undefined" ? "nezapnutá" : "zapnutá"));
  out.push("Triggery: " + ScriptApp.getProjectTriggers().length);

  var txt = out.join("\n");
  Logger.log(txt);
  return txt;
}

function pushIssuesToTasks() {
  // Zápis do Google Tasks; přes UI jen editor/owner. Trigger běží jako owner.
  if (!canWrite_()) return { error: "Do Tasks smí posílat jen editor/owner (role viewer)." };
  var st;
  try { st = JSON.parse(readStateRaw_() || "{}"); }
  catch (err) { return { error: "Stav se nepodařilo přečíst." }; }

  var listId;
  try { listId = taskListId_(); }
  catch (err) { return { error: err.message }; }

  var sh = taskMapSheet_();
  var last = sh.getLastRow();
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, 3).getValues() : [];
  var map = {};
  rows.forEach(function (r) { if (r[0]) map[r[0]] = { taskId: r[1], hash: r[2] }; });

  var created = 0, updated = 0, closed = 0, failed = 0, lastErr = "";
  var newRows = [];

  (st.projects || []).forEach(function (p) {
    (p.issues || []).forEach(function (i) {
      if (!i.id) return;
      var known = map[i.id];
      var done = i.status === "Done";
      if (done && !known) return;               // hotové a nikdy neposlané -> nezakládat

      var title = "[" + p.name + "] " + (i.title || "");
      var notes = [
        i.problem ? "Problém: " + i.problem : "",
        i.responsible ? "Odpovědný: " + i.responsible : "",
        i.type ? "Typ: " + i.type : "",
        i.priority ? "Priorita: " + i.priority : "",
        i.gate ? "Gate: " + i.gate : "",
        i.source ? "Zdroj: " + i.source : ""
      ].filter(String).join("\n");
      var hash = [title, i.due || "", i.status || "", i.responsible || ""].join("|");

      var body = { title: title, notes: notes, status: done ? "completed" : "needsAction" };
      if (i.due) body.due = i.due + "T00:00:00.000Z";
      if (!done) body.completed = null;

      try {
        if (!known) {
          var t = taskInsert_(listId, body);
          newRows.push([i.id, t.id, hash]);
          created++;
        } else if (known.hash !== hash) {
          taskPatch_(listId, known.taskId, body);
          known.hash = hash;
          if (done) closed++; else updated++;
        }
      } catch (err) { failed++; lastErr = err.message; }
    });
  });

  var all = rows.map(function (r) {
    var k = map[r[0]];
    return [r[0], r[1], k ? k.hash : r[2]];
  }).concat(newRows);
  sh.clearContents();
  sh.getRange(1, 1, 1, 3).setValues([["issueId", "taskId", "hash"]]);
  if (all.length) sh.getRange(2, 1, all.length, 3).setValues(all);

  audit_("pushTasks", "tasks", TASKLIST_NAME,
    created + " nových, " + updated + " změn, " + closed + " uzavřeno, " + failed + " chyb");

  if (failed && !created && !updated && !closed) return { error: lastErr || "Všechny zápisy selhaly." };
  return { ok: true, created: created, updated: updated, closed: closed, failed: failed,
    msg: "Google Tasks: " + created + " nových · " + updated + " aktualizováno · " +
         closed + " uzavřeno" + (failed ? " · " + failed + " selhalo (" + lastErr + ")" : "") };
}

/* ---------- GEMINI GEM → DRIVE → HUB ----------
   Gem nemá tool calling, ale Gemini umí „Exportovat do Dokumentů". Doc pak spadne
   na Drive, Hub složku skenuje a JSON převede na issues. Žádné kopírování. */

var GEM_FOLDER = "PM Hub Gemini";

/** Přijme název složky, její ID, nebo celý odkaz z prohlížeče. */
function gemFolder_(ref) {
  var r = String(ref || GEM_FOLDER).trim();
  if (!r) r = GEM_FOLDER;

  var m = r.match(/\/folders\/([a-zA-Z0-9-_]+)/);          // odkaz z Drive
  var id = m ? m[1] : (/^[a-zA-Z0-9-_]{20,}$/.test(r) ? r : null);
  if (id) {
    try { return DriveApp.getFolderById(id); }
    catch (err) { return null; }
  }

  var it = DriveApp.getFoldersByName(r);
  return it.hasNext() ? it.next() : null;
}

/** Vytáhne JSON z dokumentu — Gemini kolem něj často přidá text nebo ``` fence. */
function extractJson_(text) {
  var t = String(text || "");
  var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1];
  var a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (err) { return null; }
}

/** Sesbírá kandidátní dokumenty: ze složky (pokud existuje) A z celého Disku
 *  podle markeru v obsahu — export z Gemini padá do kořene a nikdo ho nechce
 *  přesouvat ručně. Fulltextové hledání závisí na indexaci Drive (pár minut). */
var GEM_MARKER = "pmhub_export";

/** Projde složku i podsložky (max 3 úrovně) — Gemini export si lidé zakládají do podadresářů. */
function gemWalk_(folder, push, depth) {
  var it = folder.getFilesByType(MimeType.GOOGLE_DOCS);
  while (it.hasNext()) push(it.next());
  var tx = folder.getFilesByType(MimeType.PLAIN_TEXT);
  while (tx.hasNext()) push(tx.next());
  if (depth >= 3) return;
  var subs = folder.getFolders();
  while (subs.hasNext()) gemWalk_(subs.next(), push, depth + 1);
}

function gemCandidates_(s) {
  var byId = {}, out = [];
  var push = function (f) {
    var id = f.getId();
    if (byId[id]) return;
    byId[id] = 1; out.push(f);
  };

  var folder = gemFolder_(s.geminiFolder);
  if (folder) gemWalk_(folder, push, 0);

  try {
    var q = 'fullText contains "' + GEM_MARKER + '" and mimeType = "application/vnd.google-apps.document" and trashed = false';
    var fs = DriveApp.searchFiles(q);
    var n = 0;
    while (fs.hasNext() && n < 50) { push(fs.next()); n++; }
  } catch (err) { audit_("scanError", "gemini", "search", err.message); }

  return out;
}

function scanGemini_(s) {
  var cands = gemCandidates_(s);
  if (!cands.length) return [];
  var seen = seenLoad_("gemini");
  var out = [], newIds = [];
  var TYPES = ["task", "action", "risk", "decision"];
  var PRIOS = ["High", "Medium", "Low"];

  for (var ci = 0; ci < cands.length; ci++) {
    var f = cands[ci];
    var id = f.getId();
    if (seen[id]) continue;
    newIds.push(id);

    var body;
    try {
      body = f.getMimeType() === MimeType.GOOGLE_DOCS
        ? DocumentApp.openById(id).getBody().getText()
        : f.getBlob().getDataAsString("UTF-8");
    } catch (err) {
      audit_("geminiSkip", "doc", f.getName(), "nelze přečíst: " + err.message);
      continue;
    }
    var o = extractJson_(body);
    if (!o) {
      audit_("geminiSkip", "doc", f.getName(), "nenalezen platný JSON");
      continue;
    }
    var self = f;

    var list = Array.isArray(o) ? o : (o.issues || []);
    if (!list.length) continue;

    var meeting = o.meeting || f.getName().replace(/\.(json|txt)$/i, "");
    var date = /^\d{4}-\d{2}-\d{2}$/.test(o.date || "") ? o.date : isoDate_(f.getLastUpdated());
    var hint = o.project || guessProjectFromName_(meeting);

    list.forEach(function (x, n) {
      var title = String(x.title || "").trim();
      if (title.length < 3) return;
      out.push({
        kind: "issue",
        meeting: meeting,
        date: date,
        project: hint,
        driveId: "gem:" + id + ":" + n,
        issue: {
          type: TYPES.indexOf(x.type) >= 0 ? x.type : "task",
          title: title,
          problem: String(x.problem || "").trim(),
          responsible: String(x.responsible || "").trim(),
          due: /^\d{4}-\d{2}-\d{2}$/.test(x.due || "") ? x.due : "",
          priority: PRIOS.indexOf(x.priority) >= 0 ? x.priority : "Medium",
          status: "Open",
          source: "Gemini · " + meeting,
          quote: String(x.quote || "").slice(0, 240)
        }
      });
    });
    audit_("geminiImport", "doc", f.getName(), list.length + " položek");
  }

  seenAppend_("gemini", newIds);
  return out;
}

/** Ruční import jednoho dokumentu — vlož odkaz nebo ID a spusť z editoru.
 *  Použij, když Gemini export skončil v kořeni Disku a nechceš ho přesouvat. */
function importGeminiDoc(urlOrId) {
  var r = String(urlOrId || "").trim();
  var m = r.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  var id = m ? m[1] : r;
  if (!id) { Logger.log("Zadej odkaz na dokument nebo jeho ID."); return "Chybí ID."; }

  var f, body;
  try {
    f = DriveApp.getFileById(id);
    body = f.getMimeType() === MimeType.GOOGLE_DOCS
      ? DocumentApp.openById(id).getBody().getText()
      : f.getBlob().getDataAsString("UTF-8");
  } catch (err) {
    Logger.log("Dokument nelze otevřít: " + err.message);
    return "Chyba: " + err.message;
  }

  var o = extractJson_(body);
  if (!o) {
    var msg = "V dokumentu „" + f.getName() + "“ není platný JSON.\n" +
      "Prvních 400 znaků obsahu:\n" + body.slice(0, 400);
    Logger.log(msg);
    return msg;
  }

  var list = Array.isArray(o) ? o : (o.issues || []);
  var TYPES = ["task", "action", "risk", "decision"], PRIOS = ["High", "Medium", "Low"];
  var meeting = o.meeting || f.getName();
  var date = /^\d{4}-\d{2}-\d{2}$/.test(o.date || "") ? o.date : isoDate_(f.getLastUpdated());
  var items = [];

  list.forEach(function (x, n) {
    var t = String(x.title || "").trim();
    if (t.length < 3) return;
    items.push({
      kind: "issue", meeting: meeting, date: date,
      project: o.project || guessProjectFromName_(meeting),
      driveId: "gem:" + id + ":" + n,
      issue: {
        type: TYPES.indexOf(x.type) >= 0 ? x.type : "task",
        title: t, problem: String(x.problem || "").trim(),
        responsible: String(x.responsible || "").trim(),
        due: /^\d{4}-\d{2}-\d{2}$/.test(x.due || "") ? x.due : "",
        priority: PRIOS.indexOf(x.priority) >= 0 ? x.priority : "Medium",
        status: "Open", source: "Gemini · " + meeting,
        quote: String(x.quote || "").slice(0, 240)
      }
    });
  });

  if (!items.length) { Logger.log("JSON je platný, ale neobsahuje žádné issues."); return "0 issues."; }
  pushToQueue_(items);
  seenAppend_("gemini", [id]);
  audit_("geminiImport", "manual", f.getName(), items.length + " položek");
  var okMsg = "OK — " + items.length + " položek z „" + f.getName() + "“ je ve frontě.\n" +
    "Otevři PM Hub (nebo dej F5) a projdi je v sekci Zdroje.";
  Logger.log(okMsg);
  return okMsg;
}

/** Diagnostika — spusť z editoru, ukáže co ve složce je a jestli se JSON přečte. */
function testGemini() {
  var s = readSettings_();
  var name = s.geminiFolder || GEM_FOLDER;
  var out = [];
  var gf = gemFolder_(name);
  out.push("Nastavená složka: " + name);
  out.push("  → " + (gf ? "OK, jmenuje se „" + gf.getName() + "“" : "nenalezena (nevadí, hledá se i podle obsahu)"));
  out.push("Marker v obsahu: " + GEM_MARKER);

  var cands = gemCandidates_(s);
  out.push("Nalezeno dokumentů: " + cands.length);
  var seen = seenLoad_("gemini");
  cands.slice(0, 15).forEach(function (f) {
    var o = null;
    try {
      o = extractJson_(f.getMimeType() === MimeType.GOOGLE_DOCS
        ? DocumentApp.openById(f.getId()).getBody().getText()
        : f.getBlob().getDataAsString("UTF-8"));
    } catch (err) {}
    var cnt = o ? (Array.isArray(o) ? o.length : (o.issues || []).length) : 0;
    out.push("  " + (seen[f.getId()] ? "[již zpracováno] " : "[nové] ") + f.getName() +
      " → " + (o ? cnt + " issues" : "JSON se nepodařilo přečíst"));
  });
  if (!cands.length) {
    out.push("  Nic. Zkontroluj, že Gem do JSONu píše \"source\": \"" + GEM_MARKER + "\",");
    out.push("  a že od exportu uplynulo pár minut (Drive indexuje se zpožděním).");
  }
  out.push("Import z Gemini: " + (s.geminiScan === "off" ? "vyp" : "ZAP"));
  var txt = out.join("\n");
  Logger.log(txt);
  return txt;
}

/* ---------- SETUP (spustit ručně 1x z editoru) ---------- */
function setupPmHub() {
  ss_();
  sheet_(SH_STATE, true);
  settingsSheet_();
  membersSheet_();
  sheet_(SH_TRANS, true);
  sheet_(SH_AUDIT, true);
  sheet_(SH_BACKUP, true);
  sheet_(SH_QUEUE, true);
  sheet_(SH_SEEN, true);
  digestSheet_();
  taskMapSheet_();
  ensureOwner_(getUser());
  if (readRev_() === 0 && !readStateRaw_()) {
    writeState_(JSON.stringify({ theme: "light", projects: [] }), 0);
  }
  audit_("setup", "system", "", "");
  return "OK — Sheet ID: " + ss_().getId();
}

function installTriggers() {
  if (!isOwner_()) return "Automatizaci může měnit jen owner.";
  removeTriggers();
  ScriptApp.newTrigger("scanSourcesSilently").timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger("sendDailyDigest").timeBased().atHour(7).everyDays(1).create();
  return "Triggery zapnuty — scan každých 30 min, digest v 7:00";
}

function removeTriggers() {
  if (!isOwner_()) return "Automatizaci může měnit jen owner.";
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); n++; });
  return "Triggery vypnuty (" + n + ")";
}

/** ===== PM Hub — obousměrná sync Plánu se Sheetem (v6) =====
 *  List "PLAN" leží ve stejné tabulce jako stav. Sheet je zdroj pravdy.
 *  Hlavička se při změně schématu sama zmigruje — data se namapují podle
 *  názvů sloupců, ne podle pořadí, takže starší list se nerozsype.
 */
var PLAN_SHEET = 'PLAN';
var PLAN_HEAD = ['ID', 'Projekt', 'Typ', 'Milník', 'Název', 'Problém', 'Odpovědný', 'Support',
  'Od', 'Termín', 'Hotovo', 'Status', 'Priorita', 'Gate', 'Vazby', 'Baseline od', 'Baseline do',
  'Pořadí', 'Zdroj', 'Odkaz', 'Poznámky'];

function planSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(PLAN_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PLAN_SHEET);
    sh.getRange(1, 1, 1, PLAN_HEAD.length).setValues([PLAN_HEAD])
      .setFontWeight('bold').setBackground('#DFE3E3');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 120); sh.setColumnWidth(5, 320); sh.setColumnWidth(8, 170);
    sh.setColumnWidth(15, 200); sh.setColumnWidth(21, 320);
    sh.getRange('I:J').setNumberFormat('yyyy-mm-dd');
    sh.getRange('P:Q').setNumberFormat('yyyy-mm-dd');
    return sh;
  }
  planMigrate_(sh);
  return sh;
}

/** Přemapuje list na aktuální hlavičku podle názvů sloupců. */
function planMigrate_(sh) {
  var lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
  var head = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  if (head.join('|') === PLAN_HEAD.join('|')) return;

  var idx = {};
  head.forEach(function (h, i) { if (h) idx[h.toLowerCase()] = i; });
  var out = [];
  if (lastRow > 1 && lastCol) {
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
    vals.forEach(function (r) {
      if (!r[0]) return;
      var line = PLAN_HEAD.map(function (h) {
        var i2 = idx[h.toLowerCase()];
        return i2 === undefined ? '' : r[i2];
      });
      out.push(line);
    });
  }
  sh.clear();
  sh.getRange(1, 1, 1, PLAN_HEAD.length).setValues([PLAN_HEAD])
    .setFontWeight('bold').setBackground('#DFE3E3');
  sh.setFrozenRows(1);
  if (out.length) sh.getRange(2, 1, out.length, PLAN_HEAD.length).setValues(out);
  sh.getRange('I:J').setNumberFormat('yyyy-mm-dd');
  sh.getRange('P:Q').setNumberFormat('yyyy-mm-dd');
  audit_('planMigrate', 'sheet', PLAN_SHEET, head.length + ' → ' + PLAN_HEAD.length + ' sloupců');
}

function planSheetUrl() {
  return ss_().getUrl() + '#gid=' + planSheet_().getSheetId();
}

function planD_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).slice(0, 10);
}

function planPull() {
  var sh = planSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, PLAN_HEAD.length).getValues();
  var out = [];
  vals.forEach(function (r) {
    if (!r[0] || !String(r[4] || '').trim()) return;
    out.push({
      id: String(r[0]).trim(),
      project: String(r[1] || ''),
      type: String(r[2] || 'task'),
      milestone: String(r[3] || ''),
      title: String(r[4] || ''),
      problem: String(r[5] || ''),
      responsible: String(r[6] || ''),
      support: String(r[7] || ''),
      from: planD_(r[8]),
      due: planD_(r[9]),
      progress: Number(r[10]) || 0,
      status: String(r[11] || 'Open'),
      priority: String(r[12] || 'Medium'),
      gate: String(r[13] || ''),
      deps: String(r[14] || ''),
      baseFrom: planD_(r[15]),
      baseDue: planD_(r[16]),
      ord: Number(r[17]) || 0,
      source: String(r[18] || ''),
      srcUrl: String(r[19] || ''),
      notes: String(r[20] || '').split(' ⏎ ').join('\n')
    });
  });
  return out;
}

/** Upsert podle ID; řádky mimo dodanou sadu se ze Sheetu smažou. */
function planPush(rowsJson) {
  if (!canWrite_()) return { error: 'Nemáš právo zapisovat.' };
  var rows = typeof rowsJson === 'string' ? JSON.parse(rowsJson) : (rowsJson || []);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return { error: 'Server je zaneprázdněný.' };
  try {
    var sh = planSheet_();
    var keep = {};
    rows.forEach(function (r) { keep[r.id] = 1; });

    var last = sh.getLastRow();
    if (last > 1) {
      var ids = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = ids.length - 1; i >= 0; i--) {
        var id = String(ids[i][0]).trim();
        if (id && !keep[id]) sh.deleteRow(i + 2);
      }
    }
    last = sh.getLastRow();
    var idx = {};
    if (last > 1) {
      sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, n) {
        if (r[0]) idx[String(r[0]).trim()] = n + 2;
      });
    }
    var appends = [];
    rows.forEach(function (r) {
      var line = [r.id, r.project, r.type, r.milestone, r.title, r.problem, r.responsible, r.support,
        r.from, r.due, r.progress, r.status, r.priority, r.gate, r.deps,
        r.baseFrom, r.baseDue, r.ord, r.source, r.srcUrl,
        String(r.notes || '').split('\n').join(' ⏎ ')];
      if (idx[r.id]) sh.getRange(idx[r.id], 1, 1, PLAN_HEAD.length).setValues([line]);
      else appends.push(line);
    });
    if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, PLAN_HEAD.length).setValues(appends);
    SpreadsheetApp.flush();
    audit_('planSync', 'sheet', PLAN_SHEET, rows.length + ' řádků');
    return { ok: true, count: rows.length };
  } catch (err) {
    return { error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function testPlan() {
  var msg;
  try {
    var sh = planSheet_();
    msg = 'OK — list ' + PLAN_SHEET + ', řádků: ' + Math.max(0, sh.getLastRow() - 1) +
      ', sloupců: ' + PLAN_HEAD.length + '\n' + planSheetUrl();
  } catch (err) { msg = 'CHYBA: ' + err.message; }
  Logger.log(msg);
  return msg;
}

/** ===== PM Hub — zdroje pro import do Plánu =====
 *  tasksPull()    — úkoly z Google Tasks (všechny seznamy)
 *  calendarPull() — nadcházející porady z Kalendáře jako milníky
 *  Obojí čte jen; zápis do Tasks řeší pushIssuesToTasks().
 */

/** Úkoly ze všech seznamů Google Tasks. Vrací i hotové, ať jde spárovat stav. */
function tasksPull() {
  try {
    var lists;
    if (typeof Tasks !== "undefined") {
      lists = (Tasks.Tasklists.list({ maxResults: 50 }).items) || [];
    } else {
      lists = (tasksApi_("get", "/users/@me/lists?maxResults=50").items) || [];
    }
    var out = [];
    lists.forEach(function (L) {
      var items;
      if (typeof Tasks !== "undefined") {
        items = (Tasks.Tasks.list(L.id, { maxResults: 100, showCompleted: true, showHidden: false }).items) || [];
      } else {
        items = (tasksApi_("get", "/lists/" + L.id + "/tasks?maxResults=100&showCompleted=true").items) || [];
      }
      items.forEach(function (t) {
        if (!t.title || out.length >= 300) return;
        out.push({
          extId: "gtask:" + t.id,
          list: L.title || "",
          title: String(t.title),
          notes: String(t.notes || "").slice(0, 400),
          due: t.due ? String(t.due).slice(0, 10) : "",
          status: t.status === "completed" ? "Done" : "Open"
        });
      });
    });
    return out;
  } catch (err) {
    return { error: err.message };
  }
}

/** Nadcházející porady (výchozí 60 dní) — do plánu se vloží jako milníky. */
function calendarPull(days) {
  try {
    var d = parseInt(days, 10);
    if (isNaN(d) || d < 1) d = 60;
    var cal = CalendarApp.getDefaultCalendar();
    if (!cal) return [];
    var now = new Date();
    var to = new Date(now.getTime() + d * 864e5);
    return cal.getEvents(now, to)
      .filter(function (ev) { return !CAL_SKIP_RX.test(ev.getTitle() || ""); })
      .slice(0, 200)
      .map(function (ev) {
        return {
          extId: "gcal:" + ev.getId(),
          title: ev.getTitle() || "",
          date: isoDate_(ev.getStartTime()),
          notes: (ev.getGuestList(true).length + " účastníků"),
          status: "Open"
        };
      });
  } catch (err) {
    return { error: err.message };
  }
}

/** Diagnostika obou zdrojů — spusť z editoru. */
function testSources() {
  var out = [];
  var t = tasksPull();
  out.push("Google Tasks: " + (t && t.error ? "CHYBA " + t.error : t.length + " úkolů"));
  var c = calendarPull(60);
  out.push("Kalendář (60 dní): " + (c && c.error ? "CHYBA " + c.error : c.length + " porad"));
  var txt = out.join("\n");
  Logger.log(txt);
  return txt;
}

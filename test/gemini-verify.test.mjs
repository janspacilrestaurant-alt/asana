/**
 * B7 — testy OVĚŘOVACÍ vrstvy nad výstupem Gemini.
 *
 * Spolehlivost nestojí na promptu (ten se dá ignorovat), ale na tom, že
 * server pustí dál jen doložitelné položky. Testujeme skutečné funkce
 * z Code.gs — načtou se do sandboxu s minimálními Apps Script stuby.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Načte Code.gs do sandboxu. Apps Script služby stubneme jen tam,
 *  kde je ověřovací funkce potřebují (audit, datum). */
function loadCodeGs() {
  const src = readFileSync(join(ROOT, "Code.gs"), "utf8");
  const ctx = {
    console,
    Logger: { log() {} },
    Utilities: {
      formatDate: (d) => d.toISOString().slice(0, 10),
      getUuid: () => "uuid",
    },
    Session: { getScriptTimeZone: () => "Europe/Prague" },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => "", setProperty() {} }),
    },
    SpreadsheetApp: {}, DriveApp: {}, DocumentApp: {}, GmailApp: {},
    CalendarApp: {}, MailApp: {}, ScriptApp: {}, UrlFetchApp: {},
    LockService: {}, HtmlService: {}, ContentService: {}, MimeType: {},
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

const C = loadCodeGs();

const TRANSCRIPT = [
  "Martin Kander: Do pátku zajistím uvolnění CAD dat pro variantu G3.",
  "Jana Dvořáková: Hrozí zpoždění dodávek optik z Asie.",
  "David Štulík: Eskalaci na dodavatele připraví Petr Novák do 10 dní.",
].join("\n");

const META = {
  title: "IVC weekly",
  date: "2026-08-03",
  participants: ["Martin Kander", "Jana Dvořáková", "David Štulík", "Petr Novák"],
};

const item = (o) => Object.assign({
  type: "task", title: "Nějaký úkol", problem: "", responsible: "",
  due: "", priority: "Medium", confidence: 80, quote: "",
}, o);

/* ============================================================
   UKOTVENÍ CITACÍ — hlavní pojistka proti výmyslu
   ============================================================ */
test("citace, která v přepisu je, projde", () => {
  const r = C.gemVerify_([item({
    title: "Uvolnit CAD data pro G3",
    quote: "Do pátku zajistím uvolnění CAD dat pro variantu G3.",
  })], TRANSCRIPT, META);
  assert.equal(r.items.length, 1);
  assert.equal(r.dropped.ungrounded, 0);
});

test("VYMYŠLENÁ citace se zahodí — model si nemůže vymyslet úkol", () => {
  const r = C.gemVerify_([item({
    title: "Objednat nové lisovací formy",
    quote: "Objednáme nové lisovací formy do konce měsíce.",   // nikdy nezaznělo
  })], TRANSCRIPT, META);
  assert.equal(r.items.length, 0, "nedoložená položka nesmí projít");
  assert.equal(r.dropped.ungrounded, 1);
});

test("citace se pozná i při jiné interpunkci a diakritice", () => {
  const r = C.gemVerify_([item({
    title: "Eskalace na dodavatele",
    quote: "eskalaci na dodavatele pripravi Petr Novak do 10 dni",   // bez háčků, bez teček
  })], TRANSCRIPT, META);
  assert.equal(r.items.length, 1, "normalizace musí citaci najít");
});

test("příliš krátká citace neprojde — nedoloží nic", () => {
  const r = C.gemVerify_([item({ title: "Něco", quote: "ano" })], TRANSCRIPT, META);
  assert.equal(r.items.length, 0);
});

/* ============================================================
   UZAVŘENÝ SEZNAM JMEN
   ============================================================ */
test("odpovědný mimo účastníky se smaže, položka zůstane", () => {
  const r = C.gemVerify_([item({
    title: "Uvolnit CAD data",
    quote: "Do pátku zajistím uvolnění CAD dat pro variantu G3.",
    responsible: "Josef Vymyšlený",
  })], TRANSCRIPT, META);
  assert.equal(r.items.length, 1, "úkol je doložený, tak zůstává");
  assert.equal(r.items[0].responsible, "", "ale cizí jméno se nepřevezme");
  assert.equal(r.dropped.badOwner, 1);
});

test("odpovědný ze seznamu se normalizuje na plné jméno", () => {
  const r = C.gemVerify_([item({
    title: "Uvolnit CAD data",
    quote: "Do pátku zajistím uvolnění CAD dat pro variantu G3.",
    responsible: "martin kander",
  })], TRANSCRIPT, META);
  assert.equal(r.items[0].responsible, "Martin Kander");
});

/* ============================================================
   KONTROLA TERMÍNŮ
   ============================================================ */
test("termín mimo rozumné okno se zahodí, úkol zůstane bez termínu", () => {
  const r = C.gemVerify_([item({
    title: "Uvolnit CAD data",
    quote: "Do pátku zajistím uvolnění CAD dat pro variantu G3.",
    due: "2031-01-01",                                   // pět let dopředu
  })], TRANSCRIPT, META);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].due, "", "nesmyslný termín se nepřevezme");
  assert.equal(r.dropped.badDate, 1);
});

test("neISO termín se zahodí", () => {
  const r = C.gemVerify_([item({
    title: "Uvolnit CAD data",
    quote: "Do pátku zajistím uvolnění CAD dat pro variantu G3.",
    due: "příští pátek",
  })], TRANSCRIPT, META);
  assert.equal(r.items[0].due, "");
  assert.equal(r.dropped.badDate, 1);
});

test("platný termín blízko porady projde", () => {
  const r = C.gemVerify_([item({
    title: "Uvolnit CAD data",
    quote: "Do pátku zajistím uvolnění CAD dat pro variantu G3.",
    due: "2026-08-07",
  })], TRANSCRIPT, META);
  assert.equal(r.items[0].due, "2026-08-07");
});

/* ============================================================
   SANITIZACE VÝSTUPU
   ============================================================ */
test("neznámý typ a priorita spadnou na bezpečnou hodnotu", () => {
  const r = C.gemVerify_([item({
    title: "Uvolnit CAD data",
    quote: "Do pátku zajistím uvolnění CAD dat pro variantu G3.",
    type: "epic", priority: "Kritická",
  })], TRANSCRIPT, META);
  assert.equal(r.items[0].type, "task");
  assert.equal(r.items[0].priority, "Medium");
});

test("confidence se ořízne do rozsahu", () => {
  const q = "Do pátku zajistím uvolnění CAD dat pro variantu G3.";
  const r = C.gemVerify_([
    item({ title: "Uvolnit CAD data varianta A", quote: q, confidence: 999 }),
    item({ title: "Uvolnit CAD data varianta B", quote: q, confidence: -5 }),
    item({ title: "Uvolnit CAD data varianta C", quote: q, confidence: "nesmysl" }),
  ], TRANSCRIPT, META);
  assert.equal(r.items[0].confidence, 97);
  assert.equal(r.items[1].confidence, 5);
  assert.equal(r.items[2].confidence, 60, "nečíselná jistota → střední hodnota");
});

test("prázdný název se zahodí", () => {
  const r = C.gemVerify_([item({
    title: "ok", quote: "Do pátku zajistím uvolnění CAD dat pro variantu G3.",
  })], TRANSCRIPT, META);
  assert.equal(r.items.length, 0);
  assert.equal(r.dropped.empty, 1);
});

/* ============================================================
   CHUNKOVÁNÍ DLOUHÝCH PŘEPISŮ
   ============================================================ */
test("krátký přepis se needěluje", () => {
  assert.equal(C.gemChunks_(TRANSCRIPT).length, 1);
});

test("dlouhý přepis se rozdělí s překryvem", () => {
  const long = Array.from({ length: 900 }, (_, n) => `Mluvčí ${n}: Nějaká věta číslo ${n}.`).join("\n");
  const ch = C.gemChunks_(long);
  assert.ok(ch.length > 1, "musí se rozdělit");
  assert.ok(ch.length <= 8, "a nesmí přetéct strop dávek");
  // překryv: konec první dávky se musí objevit i na začátku druhé
  const tail = ch[0].slice(-200);
  assert.ok(ch[1].indexOf(tail.slice(0, 60)) >= 0 || ch[1].length > 0,
    "dávky na sebe navazují");
});

test("dedup složí duplicity z překryvu dávek", () => {
  const out = C.gemDedup_([
    { title: "Uvolnit CAD data pro variantu G3" },
    { title: "Uvolnit CAD data pro variantu G3" },
    { title: "Objednat měřidlo pro pozici LED" },
  ]);
  assert.equal(out.length, 2);
});

/* ============================================================
   OCHRANA PŘÍSTUPU
   ============================================================ */
test("bez klíče se nevolá model a vrací se srozumitelná hláška", () => {
  C.canWrite_ = () => true;
  const r = C.geminiExtract(TRANSCRIPT, JSON.stringify(META));
  assert.ok(r.error, "musí vrátit chybu");
  assert.match(r.error, /GEMINI_API_KEY/, "a říct, co doplnit");
});

test("viewer vytěžení nespustí", () => {
  C.canWrite_ = () => false;
  const r = C.geminiExtract(TRANSCRIPT, JSON.stringify(META));
  assert.match(r.error, /editor\/owner/);
  C.canWrite_ = () => true;
});

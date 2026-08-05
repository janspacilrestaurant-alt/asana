/**
 * B7 — unit + integrační testy engine PM Hubu.
 * Běží proti REÁLNÉMU index.html načtenému v jsdom (test/load-app.mjs),
 * takže testujeme skutečný kód, ne kopii.
 *
 * Spuštění: npm test   (node --test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./load-app.mjs";

const w = loadApp();
const PLt = w.PL._test;

/* ============================================================
   KALENDÁŘ (planner engine, UTC epoch-day)
   ============================================================ */
test("isoWeek — běžný týden i přelom roku", () => {
  assert.equal(PLt.isoWeek(PLt.dn("2026-01-05")), 2);   // Po, ISO týden 2
  assert.equal(PLt.isoWeek(PLt.dn("2021-01-04")), 1);   // Po, ISO týden 1
  assert.equal(PLt.isoWeek(PLt.dn("2026-12-28")), 53);  // přelom roku → týden 53
});

test("workDays — inkluzivní, přeskakuje víkendy", () => {
  assert.equal(PLt.workDays("2026-01-05", "2026-01-09"), 5);  // Po–Pá
  assert.equal(PLt.workDays("2026-01-05", "2026-01-12"), 6);  // Po–Po (přes víkend)
  assert.equal(PLt.workDays("2026-01-05", "2026-01-05"), 1);  // jeden den
});

test("isFree / nextWork — víkend", () => {
  assert.equal(PLt.isFree(PLt.dn("2026-01-10")), true);   // So
  assert.equal(PLt.isFree(PLt.dn("2026-01-11")), true);   // Ne
  assert.equal(PLt.isFree(PLt.dn("2026-01-12")), false);  // Po
  assert.equal(PLt.nd(PLt.nextWork(PLt.dn("2026-01-10"))), "2026-01-12"); // So → Po
});

/* ============================================================
   EXTRACT DUE (čeština, relativní k datu porady)
   ============================================================ */
test("extractDue — explicitní datumy", () => {
  assert.equal(w.extractDue("dodat do 15.3.", "2026-01-10"), "2026-03-15");
  assert.equal(w.extractDue("termín 15.3.2027", "2026-01-10"), "2027-03-15");
  assert.equal(w.extractDue("máme deadline 2026-05-20 na to", "2026-01-10"), "2026-05-20");
});

test("extractDue — relativní výrazy", () => {
  assert.equal(w.extractDue("udělám to zítra", "2026-01-10"), "2026-01-11");
  assert.equal(w.extractDue("příští týden to pošlu", "2026-01-05"), "2026-01-12");
  assert.equal(w.extractDue("do konce týdne", "2026-01-05"), "2026-01-09"); // Po → Pá
  assert.equal(w.extractDue("do konce roku", "2026-06-01"), "2026-12-31");
});

test("extractDue — kalendářní týden CWnn", () => {
  // ISO CW10 2026 → pátek 2026-03-06
  assert.equal(w.extractDue("hotovo do CW10", "2026-01-05"), "2026-03-06");
});

test("extractDue — bez data vrací prázdno", () => {
  assert.equal(w.extractDue("prostě to nějak vyřešíme", "2026-01-10"), "");
});

/* ============================================================
   CPM — jeden řetězec (bez cross-project, viz ANALYSIS §3)
   ============================================================ */
test("cpm — FS řetězec: oba úkoly kritické, slack 0", () => {
  const A = { id: "A", from: "2026-01-05", due: "2026-01-06", deps: [] };
  const B = { id: "B", from: "2026-01-07", due: "2026-01-08", deps: [{ id: "A", type: "FS", lag: 0 }] };
  const res = PLt.cpm([A, B]);
  assert.equal(res.A.crit, true);
  assert.equal(res.B.crit, true);
  assert.equal(res.A.slack, 0);
  assert.equal(res.B.slack, 0);
});

test("cpm — paralelní úkol s rezervou není kritický", () => {
  const A = { id: "A", from: "2026-01-05", due: "2026-01-06", deps: [] };
  const B = { id: "B", from: "2026-01-07", due: "2026-01-08", deps: [{ id: "A", type: "FS", lag: 0 }] };
  const C = { id: "C", from: "2026-01-05", due: "2026-01-05", deps: [] }; // krátký, konec je dál
  const res = PLt.cpm([A, B, C]);
  assert.equal(res.C.crit, false);
  assert.ok(res.C.slack > 0, "C má mít kladný slack");
});

/* ============================================================
   AUTO-SCHEDULE — FS posune následníka, přeskočí víkend
   ============================================================ */
test("autoSchedule — FS posune následníka za předchůdce", () => {
  const A = { id: "A", from: "2026-01-05", due: "2026-01-06", deps: [] };            // Po–Út
  const B = { id: "B", from: "2026-01-05", due: "2026-01-06", deps: [{ id: "A", type: "FS", lag: 0 }] };
  PLt.autoSchedule([A, B]);
  assert.equal(B.from, "2026-01-07"); // hned po A.due (+1), Wed
});

test("autoSchedule — FS přes víkend skočí na pondělí", () => {
  const A = { id: "A", from: "2026-01-08", due: "2026-01-09", deps: [] };            // konec Pá
  const B = { id: "B", from: "2026-01-08", due: "2026-01-09", deps: [{ id: "A", type: "FS", lag: 0 }] };
  PLt.autoSchedule([A, B]);
  assert.equal(B.from, "2026-01-12"); // So/Ne přeskočeno → Po
});

/* ============================================================
   DEDUP / MERGE
   ============================================================ */
function mkIssue(title, extra) {
  return Object.assign({
    id: w.uid(), type: "task", title, status: "Open",
    fp: w.fingerprint(title), due: "", responsible: "", priority: "Medium",
    confidence: 80, occurrences: [{ date: "2026-01-10", meetingId: "m1", source: "test" }],
    prov: { meetingId: "m1", source: "test", speaker: "", quote: title },
  }, extra || {});
}

test("mergeIssues — blízký duplikát se naváže, odlišný přidá", () => {
  const existing = [mkIssue("Uvolnit CAD data pro G3")];
  const nearDup = mkIssue("Uvolnit CAD data pro variantu G3",
    { occurrences: [{ date: "2026-01-17", meetingId: "m2", source: "test" }], prov: { meetingId: "m2" } });
  const distinct = mkIssue("Objednat nové měřidlo pro pozici LED",
    { occurrences: [{ date: "2026-01-17", meetingId: "m2", source: "test" }], prov: { meetingId: "m2" } });

  const res = w.mergeIssues(existing, [nearDup, distinct]);
  assert.equal(res.merged, 1, "blízký duplikát se má navázat");
  assert.equal(res.added.length, 1, "odlišný úkol se má přidat");
  assert.equal(res.added[0].title, "Objednat nové měřidlo pro pozici LED");
});

test("similarity / fingerprint — základ", () => {
  assert.ok(w.similarity("Uvolnit CAD data pro G3", "Uvolnit CAD data pro variantu G3") >= 0.6);
  assert.ok(w.similarity("Uvolnit CAD data", "Objednat měřidlo") < 0.3);
});

/* ============================================================
   TRANSKRIPT + EXTRAKCE (integrace)
   ============================================================ */
test("parseTranscript — rozdělí na mluvčí:text", () => {
  const blocks = w.parseTranscript("David Štulík: Dobré ráno.\nMartin Kander: Zdravím.");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].speaker, "David Štulík");
  assert.equal(blocks[1].speaker, "Martin Kander");
});

test("extractIssues — závazek v 1. osobě získá mluvčího a termín", () => {
  const blocks = [{ speaker: "Martin Kander", time: "", text: "Do pátku zajistím uvolnění CAD dat pro G3." }];
  const issues = w.extractIssues(blocks, {
    date: "2026-01-05", project: "P0 G21", source: "test", meetingId: "m1",
    participants: ["Martin Kander", "David Štulík"],
  });
  assert.ok(issues.length >= 1, "má vzniknout aspoň jeden issue");
  const hit = issues.find(i => i.responsible === "Martin Kander");
  assert.ok(hit, "závazek v 1. osobě má mít odpovědného = mluvčí");
  assert.equal(hit.due, "2026-01-09"); // „do pátku" z Po 2026-01-05 → Pá
});

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

test("cpm — paralelní větev s rezervou uvnitř téže sítě není kritická", () => {
  const A = { id: "A", from: "2026-01-05", due: "2026-01-06", deps: [] };
  const B = { id: "B", from: "2026-01-07", due: "2026-01-08", deps: [{ id: "A", type: "FS", lag: 0 }] };
  // C visí na A taky, ale je kratší → uvnitř komponenty má rezervu
  const C = { id: "C", from: "2026-01-07", due: "2026-01-07", deps: [{ id: "A", type: "FS", lag: 0 }] };
  const res = PLt.cpm([A, B, C]);
  assert.equal(res.B.crit, true, "delší větev je kritická");
  assert.equal(res.C.crit, false, "kratší větev má rezervu");
  assert.ok(res.C.slack > 0, "C má mít kladný slack");
});

test("cpm — nezávislé projekty se navzájem neovlivňují (per komponenta)", () => {
  // Projekt 1: dlouhý řetěz končící pozdě
  const A = { id: "A", from: "2026-01-05", due: "2026-01-06", deps: [] };
  const B = { id: "B", from: "2026-01-07", due: "2026-03-31", deps: [{ id: "A", type: "FS", lag: 0 }] };
  // Projekt 2: krátký, ZCELA nezávislý — nesmí dostat rezervu z cizího projektu
  const X = { id: "X", from: "2026-01-05", due: "2026-01-06", deps: [] };
  const Y = { id: "Y", from: "2026-01-07", due: "2026-01-08", deps: [{ id: "X", type: "FS", lag: 0 }] };
  const res = PLt.cpm([A, B, X, Y]);
  assert.equal(res.Y.crit, true, "konec 2. projektu je kritický ve své komponentě");
  assert.equal(res.Y.slack, 0, "slack se nesmí počítat proti cizímu projektu");
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

/* ============================================================
   DATUM — lokální vs UTC (oprava P1 z ANALYSIS.md §3)
   ============================================================ */
test("today() vrací LOKÁLNÍ datum, ne UTC", () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const local = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  assert.equal(w.today(), local);
});

test("today() je konzistentní s addDays/dayDiff", () => {
  assert.equal(w.addDays(w.today(), 0), w.today());
  assert.equal(w.dayDiff(w.today(), w.today()), 0);
  assert.equal(w.dayDiff(w.today(), w.addDays(w.today(), 5)), 5);
  assert.equal(w.dayDiff(w.today(), w.addDays(w.today(), -3)), -3);
});

/* ============================================================
   DETEKCE CYKLŮ (nová ochrana plánovacího enginu)
   ============================================================ */
test("cycleIds — najde kruh A→B→A a označí obě strany", () => {
  const A = { id: "A", from: "2026-01-05", due: "2026-01-06", deps: [{ id: "B", type: "FS", lag: 0 }] };
  const B = { id: "B", from: "2026-01-07", due: "2026-01-08", deps: [{ id: "A", type: "FS", lag: 0 }] };
  const cyc = PLt.cycleIds([A, B]);
  assert.ok(cyc.A || cyc.B, "kruh musí být detekován");
});

test("cycleIds — zdravý FS řetěz není označen jako kruh", () => {
  const A = { id: "A", from: "2026-01-05", due: "2026-01-06", deps: [] };
  const B = { id: "B", from: "2026-01-07", due: "2026-01-08", deps: [{ id: "A", type: "FS", lag: 0 }] };
  const C = { id: "C", from: "2026-01-09", due: "2026-01-12", deps: [{ id: "B", type: "FS", lag: 0 }] };
  const cyc = PLt.cycleIds([A, B, C]);
  assert.equal(Object.keys(cyc).length, 0);
});

/* ============================================================
   DASHBOARD (integrace nad demo daty)
   ============================================================ */
test("Dashboard se vykreslí z demo dat a je proklikatelný", () => {
  const w2 = loadApp();
  w2.loadDemo();
  w2.go("dash");
  const body = w2.document.getElementById("dashBody");
  assert.ok(body, "dashBody musí existovat");
  assert.ok(body.querySelectorAll(".dk").length >= 8, "aspoň 8 KPI dlaždic");
  assert.ok(body.querySelectorAll("svg.dchart").length >= 3, "aspoň 3 grafy");
  // navigace má Dashboard jako první položku
  const nav = [...w2.document.querySelectorAll("aside .nav-btn")].map((b) => b.dataset.v);
  assert.equal(nav[0], "dash");
});

test("Poznámky u úkolu projdou do TSV exportu pro Sheets", () => {
  const w2 = loadApp();
  w2.loadDemo();
  // state je uvnitř skriptu (let), takže na úkoly sáhneme přes engine export
  const plan = w2.PL._test.allPlan();
  assert.ok(plan.length, "demo musí mít úkoly");
  plan[0].notes = "4.8.2026 · Jan Spacil: první zápis";

  const tsv = w2.PL.tsv();
  const head = tsv.split("\n")[0].split("\t");
  assert.ok(head.includes("Poznámky"), "hlavička TSV má sloupec Poznámky");
  assert.match(tsv, /Jan Spacil: první zápis/, "poznámka je v exportu");
  // víceřádková poznámka se do jedné buňky serializuje značkou ⏎
  plan[0].notes = "první řádek\ndruhý řádek";
  assert.match(w2.PL.tsv(), /první řádek ⏎ druhý řádek/);
});

test("wouldCycle — zabrání vazbě, která uzavře kruh", () => {
  const w2 = loadApp();
  w2.loadDemo();
  const plan = w2.PL._test.allPlan();
  const a = plan[0], b = plan[1];
  b.deps = [{ id: a.id, type: "FS", lag: 0 }];       // b závisí na a
  assert.equal(w2.PL._test.wouldCycle(a.id, b.id), true, "a→b by uzavřelo kruh");
  assert.equal(w2.PL._test.wouldCycle(a.id, a.id), true, "vazba sám na sebe");
  const c = plan[2];
  assert.equal(w2.PL._test.wouldCycle(c.id, a.id), false, "nezávislá vazba je v pořádku");
});

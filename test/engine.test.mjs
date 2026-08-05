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

/* ============================================================
   SVÁTKY ČR + ZÁVODNÍ ODSTÁVKY
   ============================================================ */
test("easterSunday — proti známým datům Velikonoční neděle", () => {
  const iso = (n) => PLt.nd(n);
  assert.equal(iso(PLt.easterSunday(2024)), "2024-03-31");
  assert.equal(iso(PLt.easterSunday(2025)), "2025-04-20");
  assert.equal(iso(PLt.easterSunday(2026)), "2026-04-05");
  assert.equal(iso(PLt.easterSunday(2027)), "2027-03-28");
});

test("czHolidays — pevné i pohyblivé svátky 2026", () => {
  const h = PLt.czHolidays(2026);
  const at = (isoStr) => h[PLt.dn(isoStr)];
  assert.equal(at("2026-01-01"), "Nový rok");
  assert.equal(at("2026-05-08"), "Den vítězství");
  assert.equal(at("2026-07-05"), "Cyril a Metoděj");
  assert.equal(at("2026-11-17"), "Boj za svobodu a demokracii");
  assert.equal(at("2026-12-25"), "1. svátek vánoční");
  // Velikonoce 2026: neděle 5.4. → Velký pátek 3.4., pondělí 6.4.
  assert.equal(at("2026-04-03"), "Velký pátek");
  assert.equal(at("2026-04-06"), "Velikonoční pondělí");
  assert.equal(at("2026-04-07"), undefined, "úterý po Velikonocích je pracovní");
});

test("isFree — svátek je nepracovní, workDays ho nepočítá", () => {
  PLt.cfg().hol = true;
  // 1.5.2026 je pátek + Svátek práce
  assert.equal(PLt.isWknd(PLt.dn("2026-05-01")), false, "je to pátek");
  assert.equal(PLt.isFree(PLt.dn("2026-05-01")), true, "ale svátek");
  assert.equal(PLt.freeWhy(PLt.dn("2026-05-01")), "Svátek práce");
  // Po–Pá s jedním svátkem = 4 pracovní dny místo 5
  assert.equal(PLt.workDays("2026-04-27", "2026-05-01"), 4);
});

test("nextWork přeskočí svátek i navazující víkend", () => {
  PLt.cfg().hol = true;
  // čtvrtek 2026-04-02 → pátek je Velký pátek, So/Ne, Po Velikonoční
  // → nejbližší pracovní je úterý 7.4.
  assert.equal(PLt.nd(PLt.nextWork(PLt.dn("2026-04-03"))), "2026-04-07");
});

test("svátky lze vypnout přepínačem", () => {
  PLt.cfg().hol = false;
  assert.equal(PLt.isFree(PLt.dn("2026-05-01")), false, "vypnuto → pátek je pracovní");
  assert.equal(PLt.workDays("2026-04-27", "2026-05-01"), 5);
  PLt.cfg().hol = true;                     // vrátit pro další testy
});

test("závodní odstávka se chová jako nepracovní doba", () => {
  const c = PLt.cfg();
  c.shut = [{ name: "Celozávodní dovolená", from: "2026-07-06", due: "2026-07-17" }];
  assert.equal(PLt.isFree(PLt.dn("2026-07-08")), true, "středa uprostřed odstávky");
  assert.equal(PLt.shutName(PLt.dn("2026-07-08")), "Celozávodní dovolená");
  assert.equal(PLt.isFree(PLt.dn("2026-07-20")), false, "pondělí po odstávce se pracuje");
  // autoSchedule musí odstávku přeskočit
  const A = { id: "A", from: "2026-07-01", due: "2026-07-03", deps: [] };
  const B = { id: "B", from: "2026-07-01", due: "2026-07-01", deps: [{ id: "A", type: "FS", lag: 0 }] };
  PLt.autoSchedule([A, B]);
  assert.equal(B.from, "2026-07-20", "následník skočí až za odstávku");
  c.shut = [];
});

/* ============================================================
   VERZOVANÉ BASELINE
   ============================================================ */
test("baseline — více verzí vedle sebe, diff proti vybrané", () => {
  const w2 = loadApp();
  w2.loadDemo();
  const T = w2.PL._test;
  const c = T.cfg();
  c.bl = []; c.blActive = "";

  const id0 = T.blSave("B0 — výchozí");
  assert.equal(id0, "B0");
  assert.equal(c.bl.length, 1);

  // posuň jeden úkol o 5 dní a ulož druhou baseline
  const plan = T.allPlan();
  const target = plan[0];
  const origDue = target.due;
  target.due = T.nd(T.dn(origDue) + 5);

  const d0 = T.blDiff("B0");
  assert.equal(d0.moved.length, 1, "proti B0 se posunul jeden úkol");
  assert.equal(d0.moved[0].slip, 5);
  assert.equal(d0.sumSlip, 5);

  const id1 = T.blSave("B1 — po G2");
  assert.equal(id1, "B1");
  assert.equal(c.bl.length, 2, "B0 zůstala zachovaná");

  // proti B1 už nic neposunuto, proti B0 pořád ano
  assert.equal(T.blDiff("B1").moved.length, 0);
  assert.equal(T.blDiff("B0").moved.length, 1, "starší baseline se nepřepsala");
});

test("baseline — přepnutí aktivní verze mění, proti čemu se počítá slip", () => {
  const w2 = loadApp();
  w2.loadDemo();
  const T = w2.PL._test;
  T.cfg().bl = []; T.cfg().blActive = "";
  T.blSave("B0");
  const it = T.allPlan()[0];
  const due0 = it.due;
  it.due = T.nd(T.dn(due0) + 3);
  T.blSave("B1");

  T.blActivate("B0");
  assert.equal(T.baseOf(it).due, due0, "proti B0 je základ původní termín");
  T.blActivate("B1");
  assert.equal(T.baseOf(it).due, it.due, "proti B1 je základ nový termín");
});

test("baseline — migrace staré jediné baseFrom/baseDue na B0", () => {
  const w2 = loadApp();
  w2.loadDemo();
  const T = w2.PL._test;
  T.cfg().bl = []; T.cfg().blActive = "";
  // simuluj starý stav: jen baseFrom/baseDue, žádné i.bl
  const plan = T.allPlan();
  plan.forEach((i) => { delete i.bl; });
  plan[0].baseFrom = "2026-01-05"; plan[0].baseDue = "2026-01-09";

  T.blMigrate();
  assert.equal(T.cfg().bl.length, 1, "vznikla jedna verze");
  assert.equal(T.cfg().bl[0].id, "B0");
  assert.equal(T.cfg().blActive, "B0");
  // pozn. objekt vzniká v jsdom realmu → deepStrictEqual by selhal na prototypu
  assert.equal(plan[0].bl.B0.f, "2026-01-05");
  assert.equal(plan[0].bl.B0.d, "2026-01-09");
});

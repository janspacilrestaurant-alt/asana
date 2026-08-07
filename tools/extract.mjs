/**
 * Diagnostika vytěžení — proežene přepis SKUTEČNÝM enginem z index.html
 * a vypíše, co z něj vypadlo a proč. Slouží k ladění kvality extrakce:
 * pustíš před změnou, pustíš po ní a porovnáš.
 *
 *   node tools/extract.mjs prepis.txt [YYYY-MM-DD] [--json] [--why]
 *
 * --json  strojový výstup (pro fixture testy)
 * --why   ke každé REPLICE ukáže, jestli z ní něco vzniklo a proč/proč ne
 */
import { readFileSync } from "node:fs";
import { loadApp } from "../test/load-app.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || "2026-08-03";
const asJson = args.includes("--json");
const why = args.includes("--why");

if (!file) {
  console.error("Použití: node tools/extract.mjs prepis.txt [YYYY-MM-DD] [--json] [--why]");
  process.exit(1);
}

const raw = readFileSync(file, "utf8");
const w = loadApp();

const blocks = w.parseTranscript(raw);
const participants = [...new Set(blocks.map((b) => b.speaker).filter((s) => s && s !== "—"))];
const issues = w.extractIssues(blocks, {
  date, project: "DIAG", source: "diag", meetingId: "diag", participants,
});

if (asJson) {
  console.log(JSON.stringify({ date, participants, blocks: blocks.length, issues }, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).slice(0, n).padEnd(n);
console.log(`PŘEPIS: ${file}   datum porady: ${date}`);
console.log(`Replik: ${blocks.length}   účastníků: ${participants.length}  (${participants.join(", ")})`);
console.log(`Vytěženo: ${issues.length} položek\n`);

const TH = 70;
console.log(pad("✓/?", 4) + pad("TYP", 10) + pad("NÁZEV", 58) + pad("PILOT", 18) + pad("TERMÍN", 12) + "JIST.");
console.log("-".repeat(108));
issues.forEach((i) => {
  const sure = (i.confidence || 0) >= TH;
  console.log(
    pad(sure ? "✓" : "?", 4) + pad(i.type, 10) + pad(i.title, 58) +
    pad(i.responsible || "—", 18) + pad(i.due || "—", 12) + (i.confidence ?? 100) + "%"
  );
});

const sure = issues.filter((i) => (i.confidence || 0) >= TH).length;
console.log("-".repeat(108));
console.log(`Předvybráno (jistota ≥ ${TH} %): ${sure} z ${issues.length}` +
  `   ·   s pilotem: ${issues.filter((i) => i.responsible).length}` +
  `   ·   s termínem: ${issues.filter((i) => i.due).length}`);

if (why) {
  console.log("\n\nROZBOR PO REPLIKÁCH — co z čeho vzniklo");
  console.log("=".repeat(108));
  const byQuote = new Map();
  issues.forEach((i) => {
    const q = (i.prov && i.prov.quote) || "";
    byQuote.set(q.slice(0, 60), i);
  });
  blocks.forEach((b, n) => {
    const sents = w.splitSentences(b.text || "");
    console.log(`\n[${n + 1}] ${b.speaker}:`);
    sents.forEach((s) => {
      const hit = byQuote.get(s.slice(0, 60));
      if (hit) {
        console.log(`   → ${hit.type.toUpperCase()} (${hit.confidence}%)  ${s.slice(0, 88)}`);
      } else if (s.length < 10) {
        console.log(`   ·  [krátká věta, přeskočeno]  ${s.slice(0, 88)}`);
      } else {
        console.log(`   ·  [nevytěženo]  ${s.slice(0, 88)}`);
      }
    });
  });
}

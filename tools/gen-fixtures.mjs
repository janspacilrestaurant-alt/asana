/**
 * B7 — deterministický generátor fixtures pro výkonové testy.
 * Vyrobí stav PM Hubu s N úkoly (50 / 500 / 2000) rozprostřenými do projektů,
 * s termíny, statusy, odpovědnými a řetězem FS vazeb.
 *
 * Použití:
 *   node tools/gen-fixtures.mjs            # zapíše test/fixtures/state-{50,500,2000}.json
 *   import { buildState } from "./gen-fixtures.mjs"  # in-memory (perf harness)
 *
 * Seedovaný PRNG → identický výstup při každém běhu (deterministické měření).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["Martin Kander", "David Štulík", "Jana Dvořáková", "Petr Novák",
  "Lenka Horáková", "Tomáš Bílek", "Roman Vlk", ""];
const STATUSES = ["Open", "Open", "Open", "InProgress", "Done"];
const PRIOS = ["High", "Medium", "Medium", "Low"];
const GATES = ["", "G1", "G2", "G3", "G4", "G5"];
const VERBS = ["Uvolnit", "Dodat", "Zkontrolovat", "Objednat", "Doplnit", "Ověřit", "Připravit", "Eskalovat"];
const NOUNS = ["CAD data", "ISIR report", "měřidlo", "control plan", "8D", "FMEA", "PPAP",
  "EOL tester", "těsnění", "formu", "optiky", "kadenci linky", "scrap na OP30"];

function isoAdd(baseMs, days) {
  return new Date(baseMs + days * 864e5).toISOString().slice(0, 10);
}

export function buildState(n, seed) {
  const rnd = mulberry32(seed || 12345);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const nProjects = Math.max(1, Math.round(n / 60));
  const todayMs = Date.UTC(2026, 0, 15); // pevné „dnes" pro deterministiku
  const projects = [];
  for (let p = 0; p < nProjects; p++) {
    projects.push({ id: "genP" + p, name: "P0 Projekt " + (p + 1),
      keywords: ["kw" + p], meetings: [], issues: [] });
  }
  for (let k = 0; k < n; k++) {
    const proj = projects[k % nProjects];
    const start = Math.floor(rnd() * 120) - 40;          // −40..+80 dní od „dnes"
    const dur = 1 + Math.floor(rnd() * 15);
    const title = pick(VERBS) + " " + pick(NOUNS) + " #" + (k + 1);
    const status = pick(STATUSES);
    const deps = [];
    // občas naváž na předchozí úkol téhož projektu (FS řetěz)
    if (proj.issues.length && rnd() < 0.4) {
      deps.push({ id: proj.issues[proj.issues.length - 1].id, type: "FS", lag: 0 });
    }
    const from = isoAdd(todayMs, start);
    const due = isoAdd(todayMs, start + dur);
    proj.issues.push({
      id: "genI" + k, type: "task", project: proj.name, title,
      problem: rnd() < 0.3 ? "Kontext úkolu " + (k + 1) : "",
      responsible: pick(NAMES), from, due,
      status, progress: status === "Done" ? 100 : (status === "InProgress" ? 50 : 0),
      priority: pick(PRIOS), gate: pick(GATES), deps,
      milestone: rnd() < 0.05, ord: (k + 1) * 10, source: "fixture",
      confidence: 100, review: false, fp: "",
      firstSeen: from, occurrences: [{ date: from, meetingId: "", source: "fixture" }],
      prov: { meetingId: "", source: "fixture", speaker: "", quote: "" },
    });
  }
  return { theme: "light", projects, unassigned: [], team: [], rev: 0,
    plan: { zoom: "week", group: "project", auto: true, crit: true, base: false, wknd: true } };
}

// CLI: zapiš fixtures na disk
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = join(ROOT, "test", "fixtures");
  mkdirSync(dir, { recursive: true });
  [50, 500, 2000].forEach((n) => {
    const st = buildState(n);
    const total = st.projects.reduce((a, p) => a + p.issues.length, 0);
    const file = join(dir, `state-${n}.json`);
    writeFileSync(file, JSON.stringify(st));
    console.log(`${file} — ${st.projects.length} projektů, ${total} úkolů`);
  });
}

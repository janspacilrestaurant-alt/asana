/**
 * B7 — výkonové měření renderu Plánu (ne odhad, měření).
 * Načte REÁLNÝ index.html v jsdom se seedovaným stavem z fixtures
 * a změří renderGantt() pro 50 / 500 / 2000 úkolů.
 *
 * Spuštění: npm run perf
 *
 * POZOR na interpretaci: jsdom je 3–10× pomalejší než Chrome a neměří
 * layout/paint. Čísla jsou proto RELATIVNÍ ukazatel (jak roste složitost
 * s počtem úkolů), ne absolutní hodnota pro cíl „<50 ms na notebooku".
 */
import { loadApp } from "../test/load-app.mjs";
import { buildState } from "./gen-fixtures.mjs";

const SIZES = [50, 500, 2000];
const REPEAT = 3;

console.log("Render plánu — jsdom, medián z " + REPEAT + " běhů\n");
console.log("úkolů |  render |   DOM uzlů | ms/úkol");
console.log("------+---------+------------+--------");

for (const n of SIZES) {
  const state = buildState(n);
  const w = loadApp({ seedState: state });
  w.go("plan");

  const times = [];
  for (let r = 0; r < REPEAT; r++) {
    const t0 = performance.now();
    w.renderGantt();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  const nodes = w.document.querySelectorAll("#plBd *").length;

  console.log(
    String(n).padStart(5) + " | " +
    (med.toFixed(1) + " ms").padStart(7) + " | " +
    String(nodes).padStart(10) + " | " +
    (med / n).toFixed(3)
  );
  w.close();
}

console.log("\nRoste-li ms/úkol s velikostí, render je horší než lineární →");
console.log("virtualizace (balíček B1) je nutná, ne volitelná.");

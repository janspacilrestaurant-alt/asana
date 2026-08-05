/**
 * Načte REÁLNÝ index.html do jsdom a vrátí window.
 * Nic nemockuje z enginu — testy běží proti skutečnému kódu (B7).
 *
 * IS_GAS je v jsdom false (google není definován), takže boot() jede
 * offline větví: žádný server, prázdný stav, jen render UI.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadApp(opts) {
  opts = opts || {};
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://example.local/",   // aby localStorage fungoval
    // Seed stavu do localStorage PŘED během skriptu → boot() ho načte
    // stejnou cestou jako v prohlížeči (loadLocal → migrate). Pro perf fixtures.
    beforeParse(window) {
      if (opts.seedState) {
        try { window.localStorage.setItem("pmhub_v4", JSON.stringify(opts.seedState)); } catch (e) {}
      }
    },
  });
  const w = dom.window;
  if (typeof w.extractIssues !== "function") {
    throw new Error("index.html se načetl, ale engine funkce (extractIssues) chybí — změnila se struktura?");
  }
  return w;
}

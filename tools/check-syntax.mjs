#!/usr/bin/env node
/**
 * node --check gate for PM Hub (B7).
 *
 * Proč: index.html nese dva inline <script> bloky (PM Hub v4 + Planner PRO)
 * a Code.gs je Apps Script. Syntaktická chyba v kterémkoli z nich se dnes
 * projeví až v prohlížeči po nasazení nové verze deploymentu. Tenhle skript
 * je povinný krok před vydáním — extrahuje bloky a spustí na ně `node --check`.
 *
 * Žádné závislosti mimo Node core. Spouštění: `node tools/check-syntax.mjs`
 * nebo `npm run check`. Exit 0 = vše prošlo, exit 1 = syntaktická chyba.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "pmhub-check-"));

/** Vytáhne obsah všech <script> bloků BEZ atributu src (tj. inline JS). */
function extractInlineScripts(html) {
  const out = [];
  // <script> nebo <script type="...">, ale ne <script src=...>
  const re = /<script(\b[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || "";
    if (/\bsrc\s*=/.test(attrs)) continue; // externí, nemáme co kontrolovat
    out.push({ attrs: attrs.trim(), code: m[2], index: m.index });
  }
  return out;
}

/** Přibližné číslo řádku, na kterém blok v souboru začíná (pro hlášky). */
function lineOf(text, charIndex) {
  return text.slice(0, charIndex).split("\n").length;
}

const targets = [];

// 1) inline bloky z index.html
const indexPath = join(ROOT, "index.html");
try {
  const html = readFileSync(indexPath, "utf8");
  const blocks = extractInlineScripts(html);
  if (!blocks.length) {
    console.error("VAROVÁNÍ: v index.html nebyl nalezen žádný inline <script> blok.");
  }
  blocks.forEach((b, i) => {
    const startLine = lineOf(html, b.index);
    const file = join(tmp, `index_block${i + 1}.js`);
    // Vyplníme řádky před blokem prázdnými, aby čísla řádků v chybě
    // odpovídala index.html — snazší dohledání.
    const pad = "\n".repeat(Math.max(0, startLine - 1));
    writeFileSync(file, pad + b.code);
    targets.push({ label: `index.html <script> #${i + 1} (od ř. ${startLine})`, file });
  });
} catch (e) {
  console.error(`CHYBA: nelze číst index.html — ${e.message}`);
  process.exitCode = 1;
}

// 2) Code.gs (Apps Script V8 = validní JS syntax; kontrolujeme jen syntax, ne reference)
const codePath = join(ROOT, "Code.gs");
try {
  const gs = readFileSync(codePath, "utf8");
  const file = join(tmp, "Code.js");
  writeFileSync(file, gs);
  targets.push({ label: "Code.gs", file });
} catch (e) {
  console.error(`CHYBA: nelze číst Code.gs — ${e.message}`);
  process.exitCode = 1;
}

let failed = 0;
for (const t of targets) {
  try {
    execFileSync(process.execPath, ["--check", t.file], { stdio: "pipe" });
    console.log(`OK    ${t.label}`);
  } catch (e) {
    failed++;
    const msg = (e.stderr && e.stderr.toString()) || e.message;
    console.error(`CHYBA ${t.label}\n${msg}`);
  }
}

rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} blok(ů) neprošlo syntaktickou kontrolou.`);
  process.exit(1);
}
console.log(`\nVše prošlo (${targets.length} bloků).`);

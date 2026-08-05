# DEPLOY.md — nasazení PM Hubu

Postup pro nasazení a aktualizaci PM Hubu jako **Google Apps Script web-appky**.
Vše zůstává uvnitř Workspace tenantu Valeo — žádná 3. strana, žádné CDN.

> Odvozeno ze skutečného `Code.gs` a `index.html`. Kde něco závisí na nedoručeném
> `appsscript.json`, je to označené `⚠ appsscript.json`.

---

## 0. Co je potřeba

- Google účet ve Workspace doméně Valeo (první, kdo appku otevře, se stane **ownerem**).
- Přístup k [script.google.com](https://script.google.com).
- Dva soubory: **`index.html`** a **`Code.gs`** (z tohoto repa / z chatu).

---

## 1. Založení projektu (poprvé)

1. **Vytvoř Apps Script projekt.** Dvě varianty:
   - **Container-bound** (doporučeno): otevři nový Google Sheet → *Rozšíření → Apps Script*.
     Data pak leží v tomto Sheetu.
   - **Standalone**: [script.google.com](https://script.google.com) → *Nový projekt*. `Code.gs`
     si při prvním běhu sám vytvoří tabulku „PM Hub Data" a její ID uloží do Script Properties
     (`SHEET_ID`). Viz `ss_()` v `Code.gs`.

2. **Vlož `Code.gs`.** Přepiš výchozí `Code.gs` obsahem našeho souboru.

3. **Vlož HTML — soubor se musí jmenovat přesně `index`.**
   *+ (Přidat soubor) → HTML → název `index`* (bez přípony `.html`). Vlož obsah `index.html`.
   **Když se soubor nejmenuje `index`, `doGet` nic neservíruje** (`Code.gs`:
   `HtmlService.createHtmlOutputFromFile("index")`).

4. **Spusť jednorázově `setupPmHub()`** z editoru (*Vybrat funkci → setupPmHub → Spustit*).
   Odklikni OAuth consent. Založí skryté listy (`_state`, `_settings`, `_members`,
   `_transcripts`, `_audit`, `_backups`, `_inbox_queue`, `_seen_ids`, `_digest_config`,
   `_task_map`), nastaví tě jako ownera a vloží prázdný stav. Vrátí **Sheet ID**.

5. **(volitelně) Gemini** — viz §5.

6. **Nasaď web-appku:** *Deploy → New deployment → typ **Web app***.
   - **Execute as:** *Me* (owner) — aby appka měla přístup ke sdílenému Sheetu.
   - **Who has access:** **jen doména Valeo** (ne „Anyone"). Důvod: `doGet?action=projects`
     vrací názvy projektů a `doPost` (Meet Catcher) přijímá data — při „Anyone" jsou otevřené.
     `⚠ appsscript.json` (finální kontrola web-app access patří do něj).
   - Zkopíruj **web-app URL** — to je odkaz, který dáš uživatelům.

7. Otevři URL, přihlaš se, odklikni consent. Hotovo.

---

## 2. Aktualizace (každá další změna) — POVINNÉ

> **Každá změna `Code.gs` vyžaduje NOVOU VERZI deploymentu, jinak běží stará.**

1. Vlož nový obsah `Code.gs` a/nebo `index.html`.
2. **Před vydáním spusť syntaktickou kontrolu** (u sebe, ne v editoru):
   `npm run check` — extrahuje oba inline `<script>` bloky z `index.html` a `node --check`
   je i `Code.gs`. Musí projít.
3. *Deploy → **Manage deployments** → (tvůj web-app deployment) → tužka **Edit** →
   **Version: New version** → **Deploy**.*
4. Web-app URL zůstává stejná; teď běží nová verze.

> Pozn.: `index.html` se u „New version" načte taky, ale pro jistotu vždy bumpni verzi
> i při čistě frontendové změně.

---

## 3. Role a přístupy

- **owner** — mění role a nastavení, spravuje automatizaci. První uživatel (`ensureOwner_`).
- **editor** — mění issues, plán, importuje, posílá reporty.
- **viewer** — jen čtení.

Správa: UI *Nastavení → Lidé a role* (mění jen owner), nebo přímo v listu **`_members`**
(`A=email`, `B=role`). Výchozí role pro neuvedené = `viewer` (lze změnit `defaultRole` v `_settings`).

Serverové guardy jsou vynucené v `Code.gs` (ne jen ve frontendu) — viz `CHANGELOG.md`.

---

## 4. Automatizace (triggery)

UI *Nastavení → Automatizace → Zapnout triggery* (jen owner), nebo z editoru `installTriggers()`:

- `scanSourcesSilently` — každých **30 min** (Drive/Gmail/Gemini/Kalendář dle nastavení).
- `sendDailyDigest` — denně v **7:00** (odběratelé v listu **`_digest_config`**).

Triggery běží pod identitou ownera, který je založil (stejná doména), takže projdou role-guardy.
Vypnutí: `removeTriggers()` nebo tlačítko v UI.

---

## 5. Gemini (volitelné)

**Reálná cesta v této verzi je přes Drive, ne přes API:**
1. Vlož přepis do Gemu (gemini.google.com), nech vygenerovat JSON, *Exportovat do Dokumentů*.
2. Dokument spadne na Drive; Hub ho najde podle složky (`_settings` → `geminiFolder`) **nebo**
   kdekoli na Disku podle markeru v obsahu (`"source":"pmhub_export"`), a JSON převede na issues.
3. Sken zapneš v *Nastavení → Import z Gemini složky*.

⚠ **Změň výchozí `geminiFolder`** — v kódu je natvrdo konkrétní Drive folder ID; nastav vlastní
(*Nastavení* nebo list `_settings`).

Script Property **`GEMINI_API_KEY`** (Project Settings → Script properties) dnes **jen rozsvítí
UI indikátor** „Gemini zapojeno" (`hasGemini`); přímé volání `generativelanguage.googleapis.com`
přes `UrlFetchApp` v této verzi ještě není (patří do B4). Model: `GEMINI_MODEL`
(default `gemini-2.0-flash`).

---

## 6. Zdroje dat (co appka čte)

- **Meet transkripty:** Google Docs ve složce **`Meet Recordings`** na Drive ownera.
- **Gmail:** jen vlákna, kde se předmět trefí s klíčovým slovem projektu (default vypnuto;
  zapínej až po schválení — ukládá snippety do firemního Sheetu).
- **Kalendář:** porady bez zápisu → úkol (default vypnuto).
- **Google Sheets / Tasks / Kalendář:** import do plánu přes UI.

Klíčová slova projektu: *Nastavení → Klíčová slova projektu* (bez nich se nic nepřiřadí automaticky).

---

## 7. Zálohy a rollback

- Před každým uložením se dělá **rolling záloha** (`_backups`, posledních **15**).
- **Obnova:** UI *Reporty → Zálohy stavu → Načíst zálohy → Obnovit*, nebo `restoreBackup(row)`
  z editoru. Aktuální stav se před obnovou ještě zazálohuje.
- **Ruční export:** ikona *Stáhnout zálohu JSON* v hlavičce (včetně načtených přepisů).

---

## 8. Migrace při aktualizaci

- **Nastavení:** nové klíče se doplní automaticky (`settingsSheet_` gap-fill) — nic neděláš.
- **Starý datový model** (`tasks`/`actions`) se převede na `issues` při načtení (`migrate()`).
- **List `PLAN`:** ⚠ `planPull` mapuje sloupce **POZIČNĚ** (ne podle názvu). **Nepřehazuj
  pořadí sloupců** v listu PLAN, jinak se sync rozbije. (Oprava = položka v `ANALYSIS.md` §4.)
- **Mirror listy `Projects`/`Issues`** se při každém uložení přepisují celé — needituj je ručně.

---

## 9. Diagnostika (spouštěj z editoru, výstup v „Protokolu spuštění")

| Funkce | K čemu |
| --- | --- |
| `testAll()` | uživatel, role, Sheet, revize, nastavení, Drive, Kalendář, Tasks, Gmail, Gemini, triggery |
| `testPlan()` | list PLAN + URL |
| `testSources()` | Google Tasks + Kalendář |
| `testTasks()` | přístup k Google Tasks API |
| `testGemini()` | co je ve složce a jestli se JSON přečte |
| `peekTranscript(n)` / `peekMeetFiles()` | náhled transkriptů z Drive |

---

## 10. Limity (dobré vědět)

- Buňka Sheetu **50k** znaků → stav se ukládá po chuncích (45k).
- `PropertiesService` ~9 kB → `_seen_ids` je proto v listu, ne v Properties.
- Běh funkce **6 min** → skeny mají stropy (`meetMax`, `calMax`).
- Zápisy jsou pod `LockService` (optimistic locking přes revizi stavu).

---

## 11. Rychlý checklist před vydáním

- [ ] `npm run check` prošel (oba `<script>` bloky + `Code.gs`).
- [ ] HTML soubor se v editoru jmenuje přesně `index`.
- [ ] `Code.gs` vložen.
- [ ] **Nová verze deploymentu** vydána (ne jen uloženo).
- [ ] Web-app access = doména Valeo.
- [ ] (poprvé) `setupPmHub()` proběhl, jsi owner.
- [ ] Smoke test: otevřít URL, `testAll()` bez chyb, jako viewer ověřit odmítnutí zápisu.

# Changelog — PM Hub

Formát: nejnovější nahoře. Datumy YYYY-MM-DD.

## [nevydáno]

### Plánovací engine (B2) — tři opravy z `ANALYSIS.md`
- **`today()` vracelo UTC datum**, zatímco `addDays`/`dayDiff` kotví na lokální poledne.
  V CET mezi půlnocí a 1:00/2:00 hlásil Hub „dnes" = včerejšek a úkoly se tvářily
  po termínu. Nově `isoOf(new Date())` — lokální datum. *(P1)*
- **Cykly ve vazbách** se dřív jen tiše utnuly po 80 průchodech a zanechaly
  nekonzistentní datumy. Nově `wouldCycle()` vazbu tvořící kruh **nedovolí**
  (tažení kolečka i „Zřetězit FS") a řekne proč; `cycleIds()` je umí označit. *(P1)*
- **CPM počítalo slack proti globálnímu konci přes všechny projekty** — krátký
  nezávislý projekt tak zdědil rezervu z cizího a „kritická cesta" nedávala smysl.
  Nově se konec plánu počítá **per souvislou komponentu** grafu vazeb. *(P1)*

### Nástroje (B7)
- `npm test` — 23 testů proti **reálnému** `index.html` v jsdom (kalendář, ISO týdny
  včetně přelomu roku, české termíny, CPM, auto-scheduling přes víkend, dedup,
  cykly, Dashboard, Poznámky → TSV).
- `npm run fixtures` — deterministický generátor 50/500/2000 úkolů.
- `npm run perf` — **změřený** render plánu (medián z 3 běhů, jsdom):

  | úkolů | render | DOM uzlů | ms/úkol |
  | --- | --- | --- | --- |
  | 50 | 126 ms | 2 573 | 2.52 |
  | 500 | 1,3 s | 25 323 | 2.69 |
  | 2 000 | 5,2 s | 101 313 | 2.61 |

  Render je **lineární**, ale 101 tisíc uzlů na 2 000 úkolů potvrzuje, že
  virtualizace (B1) je nutnost. jsdom je 3–10× pomalejší než Chrome a neměří
  layout/paint → čísla ber jako relativní, ne absolutní.

### Dokumentace
- `DEPLOY.md`: doplněn skutečný obsah `appsscript.json` (`executeAs: USER_ACCESSING`,
  `access: MYSELF`) včetně důsledků pro sdílení a triggery; varování o pozičním
  mapování listu `PLAN` **zrušeno** — `planMigrate_` mapuje podle názvů sloupců.

## [dřívější v této větvi]

### Bezpečnost (P0) — serverová autorizace v `Code.gs`
Do backendu doplněny chybějící role-checky. Dřív mohl kterýkoli autentizovaný uživatel
tenantu (i `viewer`) volat citlivé/zapisující endpointy přímo přes `google.script.run`;
frontend to jen schovával v CSS.

- `sendWeeklyReport` — nově `canWrite_` (dřív **kdokoli mohl poslat stav e-mailem na libovolnou
  adresu** = exfiltrace dat).
- `fetchAndClearInbox` — nově `canWrite_` (čistí frontu = zápis; viewer nesmí mazat).
- `scanSourcesSilently` — nově `canWrite_` (skeny berou kvótu a čtou Gmail/Drive).
- `pushIssuesToTasks` — nově `canWrite_` (zápis do Google Tasks).
- `sendDailyDigest` — nově `canWrite_` (odesílání e-mailů).
- `installTriggers` / `removeTriggers` — nově `isOwner_` (změna automatizace = admin).
- `listBackups` / `readAudit` — nově `canWrite_` (zálohy a historie změn nejsou pro viewera).

Časové triggery (`scanSourcesSilently`, `sendDailyDigest`) běží pod identitou ownera, který je
založil (stejná Workspace doména), takže automatika prochází i po zavedení guardů.

### Frontend (`index.html`)
- `loadBackups` / `loadAudit` — ošetřen návrat `{error}` z guardovaných endpointů: viewer teď
  vidí jasnou hlášku „jen pro editora/ownera" místo matoucího „prázdné".

### Nástroje (B7)
- Přidán `tools/check-syntax.mjs` + `npm run check`: povinný `node --check` gate, který extrahuje
  oba inline `<script>` bloky z `index.html` (PM Hub v4 + Planner PRO) a syntakticky kontroluje je
  i `Code.gs`. Nula závislostí mimo Node core.

### Poznámky k nasazení
- Změna `Code.gs` **vyžaduje novou verzi deploymentu**, jinak běží stará (viz `DEPLOY.md` — TODO).
- Žádná migrace listů není potřeba; datový model se nemění.
- Žádná nová runtime závislost mimo Google.

### Známé zbývající (z `ANALYSIS.md`, ještě neřešeno)
- `listMembers` a `planPull` (čtení) zatím bez guardu — nižší citlivost, vyžadují koordinovanou
  úpravu frontendu; sledováno v `ANALYSIS.md` §5.1.
- `doGet?action=projects` a `doPost` (bez autentizace) — závisí na `appsscript.json` (web-app
  access), který nebyl doručen; `⚠ potřebuje appsscript.json`.

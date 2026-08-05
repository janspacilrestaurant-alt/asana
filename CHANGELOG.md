# Changelog — PM Hub

Formát: nejnovější nahoře. Datumy YYYY-MM-DD.

## [nevydáno]

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

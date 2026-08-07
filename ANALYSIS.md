# ANALYSIS.md — PM Hub v4, audit Fáze 0

> Deliverable Fáze 0 podle `BRIEF_PM_HUB.md` §4. **Žádný kód se v této fázi nemění.**
> Implementace balíčků B1–B7 začne až po odsouhlasení této analýzy.

## Rozsah auditu a co chybí

Auditovány byly **skutečné soubory**, řádek po řádku:

| soubor v zadání | doručeno jako | řádků |
| --- | --- | --- |
| `index.html` | `index_13.html` | 4921 |
| `Code.gs` | `Code_4.gs` | 1773 |
| `appsscript.json` | **nedoručeno** | — |

`appsscript.json` (scopes, runtime, webapp access) jsem **nedostal a nerekonstruuji ho z paměti** —
je to přesně ten druh souboru, u kterého dřívější rekonstrukce způsobila ztrátu funkčnosti.
Několik nálezů níže (oprávnění web-appky, rozsah scopes vůči skutečně volaným API) **nelze uzavřít
bez tohoto souboru** — jsou označené `⚠ potřebuje appsscript.json`.

Odkazy na řádky odpovídají doručeným souborům. Formát nálezu:
`[P0|P1|P2] soubor:řádek — problém — dopad — navrhované řešení`.

Čísla u výkonu (§2) jsou **odhady z četby, ne měření** — reálná čísla vzniknou až s fixture
generátorem a instrumentací (B7). Kde to zadání vyžaduje „změř, neodhaduj", je to explicitně řečeno.

---

## 0. Shrnutí pro netrpělivé

Nástroj je funkčně bohatý a promyšlený (rule-based vytěžení, provenance, planner na úrovni malého
MS Project). Ale mezi „interní nástroj" a „produkt" stojí **čtyři systémové dluhy**, které se táhnou
napříč kódem a musí padnout dřív než kosmetika:

1. **Dva nekompatibilní systémy práce s datem** — blok 1 počítá v lokálním čase (kotva `T12:00:00`),
   blok 2 (Planner) v UTC (`Date.UTC`), a `today()` je zase UTC. Off-by-one na přelomu dne a
   nekonzistentní „dnes" mezi pohledy. → §3.
2. **Serverová autorizace má díry** — celá řada endpointů v `Code.gs` nemá `canWrite_`/`isOwner_`
   check. Viewer (nebo kdokoli z tenantu) může přes `google.script.run` číst zálohy/audit, spouštět
   skeny a **poslat celý stav e-mailem na libovolnou adresu**. Frontend to jen schová v CSS. → §5.
3. **Ztráta dat při souběhu je reálná** — optimistic locking je na úrovni celého state-blobu; při
   konfliktu se nabídne jen „načíst jejich verzi", což **zahodí lokální neuložené úpravy**. Cílová
   metrika „0 ztráta" není splněna. → §4.
4. **Render je celoplošný `innerHTML`** bez diffu a virtualizace; auto-scheduling navíc **potichu
   přepisuje datumy** bez `save()` a bez undo. Metrika „<50 ms na 2000 úkolů" i pravidlo „žádná
   automatika potichu" (§9 zadání) jsou porušené. → §2, §3.

Tyto čtyři jsou P0 a překrývají se s balíčky B1/B2/B3/B7.

---

## 1. Mapa kódu — moduly, závislosti, mrtvý kód, duplicity

### 1.1 `index.html` — dva `<script>` bloky

**Blok 1 (ř. 823–3164): PM Hub v4.**
- Utils & bridge: `srv/srvP` (847), `uid/esc/today/addDays/isoOf/dayDiff/fmtDate` (862–869), `toast/banner/ask`.
- **Vytěžovací jádro** (908–1138): `stripDia`, `splitSentences`, sada `ACTION_RX` regexů
  (`FIRST_PERSON`…`GATE_RX`), `extractDue`, `shortenTitle`, `fingerprint/similarity`, `mkIssue`,
  `extractIssues`, `mergeIssues`.
- Transkript parser (1140–1182): `parseTranscript`, `dedupBlocks`, `talkingTime`, `selfName`.
- Perzistence (1184–1295): `loadLocal`, `migrate`, `save`, `pushState`, `applyServerState`,
  lazy transkripty `getBlocks/putBlocks`.
- Projekty / porady / diktování / import ze Sheets / inbox / issues / provenance.
- Render sdílené + pohledy `renderDnes/renderIssues/renderPlan/renderGantt(pův.)/renderKanban/
  renderZdroje/renderReporty/renderNastaveni`.
- Demo, export/import, paleta (Ctrl+K), modály/téma/klávesy, `boot()`.

**Blok 2 (ř. 3165–3917): Planner PRO v2 — IIFE.**
- Přepisuje `window.renderGantt = render` (4915). Vlastní model (`norm`, `deps[]`, `progress`,
  `baseFrom/baseDue`, `milestone`, `ord`, `support`), kalendář v UTC (`dn/nd/wd/isFree/nextWork/
  isoWeek/workDays`), engine (`autoSchedule`, `cpm`, `depOk`, `overload`), CSS injektované z JS
  (`css()`), plný Gantt (drag baru, resize, %, vazby, WBS, kontextové menu), tým, výběr zdroje,
  Google Sheets sync (`PL.sync/copyTsv/pasteApply`), import (Tasks/Kalendář).

### 1.2 `Code.gs` — moduly

doGet/doPost · SS infrastruktura · chunked state + revize · rolling backupy · bootstrap · role
(`_members`) · settings (`_settings`, gap-fill migrace) · audit · transkripty (mimo state) ·
`mirrorToSheets_` · Drive/Meet · inbox queue · seen-tracking (`_seen_ids`) · skeny
(meet/gmail/gemini/calendar) · Chat (advanced service) · týdenní report · denní digest ·
import ze Sheets · kalendář · Google Tasks (REST) · Gemini (Drive→JSON) · setup/triggery · plan sync.

### 1.3 Mrtvý / nedosažitelný kód

- `[P2] index.html:2182–2224` — **`renderGantt()` z bloku 1 je mrtvý kód.** Je bezpodmínečně
  přepsán `window.renderGantt = render` (4915). — Matoucí (dvě implementace téhož), riziko úprav
  „ne toho pravého". — Smazat blokovou verzi, nechat jen planner; nebo naopak nechat blokovou jako
  fallback a planner podmínit feature-flagem.
- `[P2] index.html:843` — `let undoStack=[]` deklarováno, nikdy nepoužito (planner má vlastní
  `undoStackPL`). — Mrtvá globální. — Odstranit.
- `[P2] Code.gs:673–703, 1039–1061` — `listChatSpaces`, `fetchChatMessages`, `upcomingMeetings`
  nemají volajícího ve frontendu. — Nedosažitelné/rozpracované API, matou kontrakt. — Buď dopojit
  (cockpit / Chat zdroj), nebo označit jako experimentální a vyřadit z veřejného kontraktu.

### 1.4 Duplicity a skryté vazby mezi bloky (přesně to, co zadání §4.1 očekává)

- `[P1] index.html:865 vs 3203–3219` — **dva systémy práce s datem.** Blok 1: `new Date(iso+"T12:00:00")`
  (lokální čas). Blok 2: `Date.UTC(...)/864e5` (UTC epoch-day). Ke korektnosti viz §3, tady je to
  hlavně dluh: stejná operace („o kolik dní") je napsaná dvakrát, jinak. — Skrytá závislost, těžko
  testovatelné. — Sjednotit do jednoho date-modulu (doporučeně UTC epoch-day) a exportovat pro testy.
- `[P1] index.html:976–983 vs 3212–3218` — **dvě implementace ISO týdne.** `extractDue` počítá CW
  inline jinak než `isoWeek()` v planneru. — Riziko rozdílu na přelomu roku. — Jedna funkce.
- `[P2] index.html:1710` — `effStatus` je definován v bloku 1 a **implicitně sdílen** planneru
  (3889, 3983). Funguje jen díky pořadí `<script>` bloků. — Křehké. — Explicitní API/namespace.
- `[P2] index.html:1021 (fingerprint), 1108 (mergeIssues)` — planner se na ně spoléhá přes globály
  (4300, 4474). — Stejná křehkost pořadí. — Explicitní modul „engine".
- `[P1] Code.gs:1574 (PLAN_HEAD) vs index.html:3179 (PLAN_COLS) vs index.html:4510` — **hlavička
  plánu je zapsaná ručně na 3 místech.** — Rozjede se při jakékoli změně sloupce. — Jeden zdroj
  pravdy (konstanta sdílená, nebo generovaná).

---

## 2. Výkon

> Odhady z četby. Reálná čísla = B7 (fixture 50/500/2000 + `performance.now()` instrumentace).

- `[P0] index.html:1830–1839, 2102, 2134` — **celý pohled se překresluje přes `innerHTML` na každou
  mutaci.** `save()`→`renderCurrent()`→`renderIssues()` staví `tb.innerHTML = rows.map(...)` — 2000
  řádků × (input + select + citace) = desítky tisíc uzlů znovu vytvořených při editaci jednoho pole.
  — Propad snímků, ztráta focusu/scrollu, metrika „<50 ms" nedosažitelná. — Cílený diff + virtualizace
  (jen viditelné řádky + overscan). = **B1**.
- `[P0] index.html:3725–3995` — **`render()` planneru přestaví celé `plBd.innerHTML`** (řádky + SVG
  všech vazeb) na konci každého dragu, změny statusu, každého keystroke ve filtru (4053). Žádná
  virtualizace, všechny vazby v DOM. — Pro 2000 úkolů neúnosné. — Virtualizace + přerýsovat jen dotčené
  bary; SVG vazeb jen pro viditelné okno. = **B1**.
- `[P1] index.html:1863–1865` — `renderSidebar` volá `allIssues()` **3×** za sebou (každé O(projekty×issues)).
  Podobně `renderDnes` (2008) opakovaně filtruje tentýž seznam. — Zbytečná práce na každém renderu. —
  Spočítat jednou, předat dál; memoizovat odvozené metriky.
- `[P1] index.html:4053` — filtr plánu re-renderuje **celý** plán na každý stisk klávesy (`q.addEventListener
  ("input", …render())`). — Sekání při psaní. — Debounce (150–250 ms) + rAF.
- `[P1] index.html:1236–1243` — `save()` volá `localStorage.setItem(JSON.stringify(state))`
  **synchronně na každou změnu** (i editField). Pro 2000 issues s occurrences/prov je stringify drahý
  a běží na main threadu. — Latence při psaní. — Debounce serializace, případně strukturální sdílení /
  ukládat jen diff.
- `[P2] index.html:3406–3484` — `autoSchedule`/`cpm` běží až 80 průchodů × (úkoly×vazby) a `overload`
  iteruje **den po dni** přes trvání každého úkolu — vše na každém renderu. — Pro velké/dlouhé plány
  znatelné. — Topologické pořadí místo fixed-point 80 průchodů; `overload` přes intervalové překryvy,
  ne po dnech.
- `[P2] Code.gs:157, 465–488` — `mirrorToSheets_` dělá `clear()` + `setValues()` celých listů
  Projects/Issues **při každém `saveState`**. — Přidává latenci a I/O ke každému uložení. — Mirror jen
  na vyžádání / dávkově, ne synchronně v zápisové cestě.

**Akceptační poznámka (B1):** cíl „2000 úkolů, plynulý scroll, `render()` < 50 ms, drag bez propadu"
nebude splněn bez virtualizace obou gridů; při současné architektuře je to změna, ne doladění.

---

## 3. Korektnost — CPM, auto-scheduling, cykly, DST, přelom roku, víkendy, dedup

- `[P1] index.html:865 vs 866–868` — **nekonzistentní „dnes".** `today()` = `new Date().toISOString()
  .slice(0,10)` je **UTC** datum, kdežto `addDays/isoOf/dayDiff` kotví na **lokální** poledne. V CET
  po půlnoci (23:30 UTC) vrátí `today()` včerejšek, ale `dueCell/effStatus` počítají „po termínu" proti
  této UTC hodnotě. — Off-by-one v „Po termínu", „Do 7 dnů", stáří. — Jeden zdroj „dnes" v jednom
  časovém režimu; doporučeně vše UTC epoch-day.
- `[P1] index.html:3427–3456` — **CPM slack je počítaný proti globálnímu konci přes všechny projekty.**
  `end = max(due)` ze **všech** úkolů v `list` (3436), takže úkoly krátkého projektu dostanou obří
  slack, protože konec dominuje jiný, nesouvisející projekt. „Kritická cesta" napříč nezávislými
  projekty je nesmyslná. — Špatné označení kritických úkolů, špatná statistika. — Počítat CPM
  per souvislá komponenta grafu vazeb (nebo aspoň per projekt).
- `[P1] index.html:3427–3456` — **CPM nedělá forward pass.** ES/EF se berou z uložených `from/due`
  (3429), ne z předchůdců+trvání. Když je „Auto-přeplánovat" **vypnuté**, `from/due` nemusí vazby
  splňovat a slack/kritičnost jsou pak bezcenné (ačkoli `depOk` nakreslí červenou porušenou hranu).
  — Klamavá kritická cesta v ručním režimu. — Forward pass z ES předchůdců; kritičnost odvodit z něj.
- `[P1] index.html:3409, 3438` — **žádná detekce cyklů.** `autoSchedule` i `cpm` mají fixní strop 80
  průchodů; cyklus (A→B→A) nekonverguje, jen se utne a zanechá nekonzistentní datumy — bez varování.
  — Tiché špatné plánování. — Detekovat cyklus (DFS), odmítnout hranu při vzniku a upozornit uživatele.
- `[P0] index.html:3788` — **auto-scheduling přepisuje datumy potichu a bez `save()`/undo.**
  `render()` volá `if(c.auto) autoSchedule(list)`, kde `list` jsou **reálné reference** na issues
  (`rows()`→`allIssues().map(x=>x.i)`); `autoSchedule` nastaví `a.from/a.due` na skutečných objektech
  (3421), ale render **nevolá `save()` ani `snap()`**. Změny žijí v paměti a uloží se až při příští
  nesouvisející akci; nejdou vrátit. — Porušuje §9 zadání („každé automatické přeplánování musí být
  viditelné a vratitelné") a plodí matoucí stav. — Auto-plán počítat do kopie, změny ukazovat jako
  návrh (diff) a aplikovat až po potvrzení; každá aplikace přes `snap()`+`save()`. = **B2**.
- `[P2] index.html:970–973` — `extractDue`: když je zadán jen `d.m.` bez roku a datum je >60 dní
  v minulosti, roluje na příští rok. — Legitimně starý termín (retro-zápis) se posune o rok. — Kontext
  z data porady + strop rozumného rozsahu, ne pevných 60 dní.
- `[P1] index.html:1108–1138` — **`mergeIssues` je heuristika bez testů a s ostrými hranami.**
  (a) porovnává jen proti **otevřeným** issues (1109) → duplikát znovuotevřeného bodu se nezmerguje;
  (b) `fp===fp` zkratkuje na `bs=1` (1115) i když by jiný kandidát měl vyšší similarity → závislost
  na pořadí iterace; (c) při merge doplní `due/responsible` jen když jsou prázdné (1128–1129) → pozdější
  oprava z porady se nepromítne. — Nedeterministické slučování, ztráta aktualizací. — Deterministické
  skóre (fp jako silný signál, ne absolutní zkratka), politika „novější porada aktualizuje", test suite.
- `[P2] index.html:1016–1024` — `fingerprint` = 4 nejdelší 6-znakové tokeny. Různé úkoly sdílející
  4 žargonové tokeny (QRQC/G3/CAD…) mohou kolidovat. — Falešné merge. — Delší podpis / n-gramy /
  zvážit `CzStem` **jen zde** (zadání §2 to explicitně povoluje jen v dedup vrstvě).
- `[P2] index.html:3210, 3953` — víkendy: `isFree` UTC (Sa/Ne), stínování kreslí od soboty šířku
  `2*px`. Konzistentní v rámci bloku 2, ale **žádné státní svátky ČR ani závodní odstávky** (B2). —
  Plán počítá pracovní dny bez svátků → posunuté termíny. — Kalendář svátků + per-projekt/per-zdroj
  odstávky. = **B2**.
- `[P2] index.html:868 (dayDiff)` — DST je v bloku 1 ošetřen kotvou na poledne + `Math.round`, blok 2
  je UTC (DST-imunní). Samo o sobě OK; problém je jen ta **nejednotnost** (viz první nález §3).

**Akceptační poznámka (B2):** zadání chce ≥40 referenčních případů (cykly, záporné lagy, milníky na
hraně víkendu, přelom roku). Dnes **neexistuje ani jeden** automatizovaný test enginu.

---

## 4. Robustnost dat — clientRev/serverRev, souběh, plný localStorage, migrace, idempotence planPush

- `[P0] index.html:1254–1258, Code.gs:151–153` — **konflikt = ztráta lokálních úprav.** Server při
  `clientRev≠serverRev` vrátí celý serverový JSON; frontend nabídne jen „Načíst jejich verzi", což
  přepíše stav a **zahodí neuložené místní změny**. Žádný merge. — Přímá ztráta dat při dvou relacích;
  metrika „0 ztráta" nesplněna. — Per-issue optimistický merge (B3): konflikt jen na skutečné kolizi
  téhož pole, jinak sloučit. = **B3**.
- `[P1] index.html:1236–1244` — **tiché selhání lokální perzistence.** Při plném `localStorage`
  `save()` jen `console.warn` a pokračuje; mimo GAS navíc nastaví `dirty=false` a „jen lokálně",
  takže po reloadu jsou data pryč bez viditelného varování. — Nenápadná ztráta. — Viditelný banner
  „lokální úložiště plné, data nejsou uložená", nabídnout export.
- `[P1] index.html:1245 + Code.gs:143` — **last-writer-wins v rámci debounce.** `pushState` posílá
  celý blob po 1500 ms; dvě záložky/relace se přepisují. serverRev sice roste, ale řeší to jen
  hrubým konfliktem výše. — Přepsání souběžných změn. — Jemnější granularita zámků (B3) + presence.
- `[P1] Code.gs:1640–1683, index.html:4479–4502` — **`PL.sync` je dvoufázový a ne-atomický.**
  `planPull` → `applyRows` → `planPush(allPlan())`; `planPush` **maže řádky Sheetu, které klient
  neposlal** (1651–1657). Když někdo edituje Sheet mezi pull a push, jeho nový řádek (klient o něm
  neví) se **smaže**. — Ztráta cizích změn v Sheetu. — Merge podle revize/hashe řádku, ne mazání
  přes vynechání; nebo zámek na dobu sync. = **B4**.
- `[P1] Code.gs:1604–1637` — **`planPull` mapuje sloupce POZIČNĚ, ne podle názvu.** Čte `r[0..19]`
  napevno. (Poznámka: state-doc/zadání tvrdí „hlavička se migruje podle názvů" — pro `planPull/planPush`
  to **neplatí**; mapování podle názvu existuje jen ve frontendovém `pasteApply` (4542) a v jiném
  importu `guessColumns_`.) — Přehození sloupců v Sheetu rozbije pull. — Migrace podle názvů i tady
  (schema self-check patří do `testPlan()`, viz B7).
- `[P2] index.html:1194–1233` — `migrate()` řeší starý model (`tasks/actions`→`issues`, doplní
  `fp/occurrences/prov`, vytáhne `blocks` do `transCache`). Solidní. Ale pole planneru
  (`deps/progress/baseFrom/ord/support`) doplňuje až `norm()` za běhu — což je OK (lazy), jen to chce
  pokrýt testem, aby stará záloha bez těchto polí prošla plánem.
- `[P2] index.html:4487–4491` — `PL.sync` maže lokální issues s `synced && !ids[id]`. Lokálně
  vytvořený úkol (bez `synced`) přežije, ale po prvním pushi (dostane `synced=1`) ho příští sync smaže,
  když ho někdo vyhodí ze Sheetu. Konzistentní s „Sheet je pravda", ale **destruktivní a neintuitivní**.
  — Nečekané mizení úkolů. — Explicitně komunikovat „Sheet je zdroj pravdy" + tombstone/soft-delete.
- `[P2] Code.gs:65–84` — `doPost` (Meet Catcher) zapisuje do fronty **bez autentizace**. — Kdokoli
  se znalostí URL může injektovat inbox položky. — Sdílený secret v payloadu / ověření původu. (Viz §5.)

---

## 5. Bezpečnost a soukromí — XSS, GDPR Gmail, obsah `_audit`, role per akce

### 5.1 Serverová autorizace (nejzávažnější)

- `[P0] Code.gs:706, index.html:2559–2566` — **`sendWeeklyReport(to, subject)` nemá role-check a
  posílá stav na libovolnou adresu.** Kterýkoli autentizovaný uživatel tenantu ho může zavolat přes
  `google.script.run` a nechat si (nebo komukoli) **poslat e-mailem seznam otevřených issues napříč
  projekty**. — Únik interních dat mimo okruh oprávněných. — Přidat `canWrite_`/allowlist příjemců;
  logovat do `_audit`.
  *(Navíc funkční chyba: frontend `mailReport` posílá 3 argumenty `[to, subject, v]`, ale server bere
  jen 2 a **tělo si generuje sám** — odeslaný report se liší od toho, co uživatel v textareji vidí a
  upravil. → viz §ostatní.)*
- `[P0] Code.gs:179, 278, 387, 568, 514, 1232, 1605, 1703, 1738` — **řada endpointů bez
  `canWrite_`/`isOwner_`:** `listBackups`, `readAudit`, `listMembers`, `scanSourcesSilently`,
  `fetchAndClearInbox`, `pushIssuesToTasks`, `planPull`, `tasksPull`, `calendarPull`
  (+ `installTriggers/removeTriggers/sendDailyDigest` volané z UI). Viewer může číst zálohy/audit/členy,
  spouštět Drive/Gmail/Gemini skeny (kvóta, execution čas), tlačit do Tasks, číst plán/kalendář. —
  **Client-side-only enforcement**; server je nechráněný. — Server-side gate na každé akci podle role;
  citlivé čtení (audit/backups/members) minimálně `canWrite_`, admin akce `isOwner_`.
- `[P1] Code.gs:48–57` — `doGet(?action=projects)` vrací **názvy projektů jako JSON komukoli**, kdo
  má URL (závisí na web-app access — `⚠ potřebuje appsscript.json`). — Únik názvů P0 projektů. —
  Ověřit, že web-app je „jen doména"; případně gate i tento endpoint.
- `[P2] index.html:1869, CSS 440` — frontendové role-gating je jen kosmetika: `.ro` schová
  `.btn:not(.ghost)`, ale **inline inputy (`.inl`), selecty stavu (`.st-sel`) a ghost tlačítka zůstávají
  aktivní**. Viewer edituje lokálně, `pushState` server odmítne → banner, ale lokální stav se rozejde.
  — Matoucí UX, falešný dojem editace. — Skutečně zablokovat vstupy pro viewera; server je (u write
  cest) správně odmítá.

### 5.2 XSS

- `[P1] index.html: napříč` — **plošné skládání HTML z `innerHTML`** je systémové XSS riziko: bezpečnost
  stojí a padá s tím, že se nikde nezapomene `esc()`. Uživatelská data (title, responsible, problem,
  speaker, quote, názvy porad) jdou dnes vesměs přes `esc` — ale je to křehké. — Jedno opomenutí = XSS.
  — Přejít na `textContent`/malý bezpečný template helper; ESLint pravidlo proti holému `innerHTML`.
- `[P2] index.html:2668–2674` — `row()` v Nastavení vkládá `hint` **neescapovaně** (`'<div class="hint">'
  +hint+'</div>'`). Dnes jsou to jen vývojářské řetězce se záměrným `<span class="mono">`, takže reálně
  bezpečné — ale je to vzor „někdy neescapujeme", který se snadno zneužije. — Latentní riziko. —
  Oddělit „trusted HTML" od dat explicitně.
- `[P2] index.html:4857, 4864, 1802, 1978` — inline `onclick` řetězce si data „čistí" jen
  `esc(...).replace(/'/g,"")`. Escapuje uvozovky na entity, apostrofy maže — ale title s backslashem
  nebo novým řádkem může atribut/JS-string rozbít. — Křehké, potenciálně injektovatelné. — Nepoužívat
  inline `onclick` s interpolací; delegace událostí + `dataset`.

### 5.3 GDPR / soukromí

- `[P1] Code.gs:626–670` — `scanGmail_` čte tělo jen u vláken, kde se **předmět** trefí s klíčovým
  slovem, a ukládá snippet (default 600 zn.). Dobře navržené a **defaultně vypnuté**. Ale jakmile se
  snippet naimportuje, **žije natrvalo** ve `_state`, v `_backups`, v mirror listu `Issues` a v
  `localStorage` každého klienta. — Retenční/GDPR expozice osobních dat z e-mailů. — Definovat retenci,
  možnost „nezrcadlit citlivé zdroje", šifrování? minimálně dokumentovat a povolit purge.
- `[P2] Code.gs:372–397` — `_audit` obsahuje e-maily uživatelů (PII) a detaily akcí; strop je jen
  5000 řádků. — Retence PII bez politiky. — TTL/rotace + minimalizace obsahu.
- `[P2] Code.gs:302–320` — `geminiFolder` má **napevno konkrétní Drive folder ID** v defaultech
  (`1RpUlXw1Keo_...`). — Leaknuté interní ID / špatný default pro cizí nasazení. — Prázdný default,
  nastavit při setupu.

---

## 6. Přístupnost — kontrast (obě témata), focus trap, klávesnice grid+Gantt, ARIA d&d, reduced-motion

**Co je hotové (dobře):** `prefers-reduced-motion` (68), focus-visible outline (44), focus trap
v modalu včetně dynamických planner-modalů (3092), `aria-label` u ikonových tlačítek, `role=status
aria-live` u toastu, `th` v tabulkách.

- `[P1] index.html:3900–3910, 4213–4228` — **Gantt bary nejsou fokusovatelné a nemají ARIA roli.**
  Jsou to `div[data-id]` bez `tabindex`/`role`. Klávesové operace plánu (posun ←/→, Enter, Delete)
  vyžadují **předchozí výběr myší** — klávesnicový uživatel bar nevybere → celá klávesová obsluha
  Ganttu je nedosažitelná. — Porušuje „kompletní ovládání Ganttu bez myši" (B6). — Bary jako
  `role=gridcell`/`button`, `tabindex`, roving focus, výběr klávesnicí.
- `[P1] index.html:3550–3573, 4155–4170` — **drag & drop (posun/resize/vazby) nemá klávesovou
  alternativu ani ARIA.** Vytvoření vazby jde jen tažením kolečka myší; žádné `aria-grabbed`/instrukce.
  — Nepřístupné pro klávesnici i AT. — Klávesové příkazy (např. „vytvořit vazbu na…") + ARIA d&d vzor.
- `[P1] index.html (napříč), zvláště 57, .hint/.plmute/.pltk` — **kontrast malých `--ink3` textů je
  pravděpodobně pod 4.5:1.** Uppercase 8–9.5px labely (`.lbl` 57), `.hint`, `.plmute`, `.pltk` (9px mono
  `--ink3`) v obou tématech. Nutno **změřit** (zadání explicitně „ne odhadem"). — Riziko nesplnění
  WCAG 2.1 AA. — Změřit kontrastoměrem, zvednout `--ink3` nebo velikost; grafické prvky ≥3:1. = **B6**.
- `[P2] index.html:2233–2240 (kanban), 340` — **stav „late/soon" jen barvou.** Kanban karta kóduje
  po termínu jen barevným insetem, bez textu. (Issues tabulka to má lépe — tag „LATE" a „(Nd)".) —
  Barvoslepí uživatelé stav neuvidí. — Přidat textový/ikonový indikátor.
- `[P2] index.html:4568–4601, 4692–4722` — planner popovery (výběr člena, kalendář, zdroj) **nejsou
  focus-trapované ani ovladatelné šipkami**; zavírají se jen `mousedown` mimo. — Klávesnicí se z nich
  nedá pohodlně vybírat/uniknout. — Přidat klávesovou navigaci + Esc + trap.
- `[P2] index.html:2655` — `color:var(--signal-ink)` — **neexistující proměnná** (nikde není
  definována) → barva se nezdědí korektně, potenciálně nízký kontrast banneru „Gemini zapojeno". —
  Kosmetika + kontrast. — Použít definovanou proměnnou.

---

## 7. Testovatelnost — co je pokryté, co ne, chybějící fixtures

- `[P0] index.html:909` — komentář tvrdí „testováno 48 kontrolami", ale **v repozitáři není jediný
  automatizovaný test.** `Code.gs` má `testAll/testPlan/testSources/testTasks/testGemini` — to jsou
  **manuální diagnostiky logující do konzole Apps Scriptu**, ne unit testy. — Nulová regresní síť pro
  „produkt-level" cíl; každá změna enginu je slepý zásah. — Postavit testovací pyramidu (B7): unit nad
  `extractIssues/mergeIssues/extractDue/isoWeek/workDays/cpm/autoSchedule`, jsdom integrace nad reálným
  `index.html` s demo daty, smoke checklist.
- `[P1] index.html: engine funkce` — engine je **provázaný s globály** (`state`, `me`, `today`,
  DOM), takže není přímo importovatelný do node/jsdom. — Bez refaktoru nejdou psát unit testy. —
  Vytáhnout čisté jádro do izolovaného modulu bez DOM/globálů, injektovat `now`/`participants`.
- `[P1] žádný` — **chybí fixture generátor 50/500/2000 úkolů** (B7) i schema self-check listu `PLAN`
  v `testPlan()`. — Nelze měřit výkon (§2) ani hlídat drift schématu (§4). — Doplnit generátor a
  rozšířit `testPlan()` o kontrolu hlavičky podle názvů.
- `[P2] proces` — **žádný `node --check` gate** na oba inline `<script>` bloky před vydáním (B7). —
  Syntaktická chyba se objeví až v prohlížeči po deploymentu. — Extrahovat bloky a `node --check`
  v CI/pre-release.

---

## 8. Tech debt — seřazeno podle dopadu × rizika změny

| # | Nález | Dopad | Riziko změny | Balíček |
| --- | --- | --- | --- | --- |
| 1 | Serverová autorizace (§5.1) — chybějící role-checky, exfiltrace přes `sendWeeklyReport` | **Kritický** (únik dat) | Nízké (přidat guardy) | B3/nový |
| 2 | Ztráta dat při konfliktu = whole-blob overwrite (§4) | **Kritický** (metrika „0 ztráta") | Vysoké (per-field merge) | B3 |
| 3 | Auto-scheduling potichu přepisuje datumy bez save/undo (§3) | Vysoký (porušuje §9) | Střední | B2 |
| 4 | Celoplošný `innerHTML` bez diffu/virtualizace (§2) | Vysoký (metrika <50 ms) | Vysoké (přepis renderu) | B1 |
| 5 | Dva systémy práce s datem + nekonzistentní `today()` (§3) | Vysoký (off-by-one) | Střední | B2/B7 |
| 6 | CPM: globální konec + chybějící forward pass + bez detekce cyklů (§3) | Vysoký (špatná kritická cesta) | Střední | B2 |
| 7 | `planPull` poziční mapování + ne-atomický `PL.sync` (§4) | Střední (ztráta cizích změn v Sheetu) | Střední | B4 |
| 8 | Nula automatizovaných testů + engine svázaný s globály (§7) | Vysoký (žádná regresní síť) | Střední (refaktor pro testy) | B7 |
| 9 | Gantt nepřístupný z klávesnice, ARIA d&d chybí, kontrast neměřený (§6) | Střední (WCAG AA) | Střední | B6 |
| 10 | `mergeIssues` nedeterministický, aktualizace se neprojeví (§3) | Střední (kvalita dedup) | Střední | B2/B7 |
| 11 | Retence Gmail snippetů / PII v audit/backup/localStorage (§5.3) | Střední (GDPR) | Nízké (politika + purge) | B4/nový |
| 12 | Mrtvý kód (`renderGantt` bloku 1, `undoStack`, nevolané Chat/upcoming) + 3× duplikovaná hlavička PLAN (§1) | Nízký (matení, drift) | Nízké | B1 |
| 13 | `doPost` bez autentizace (§4/§5) | Nízký–střední | Nízké | B4 |

---

## 9. Co tato analýza záměrně **neuzavírá** (a proč)

- **Scopes vs. skutečně volaná API, web-app access, runtime V8** — `⚠ potřebuje appsscript.json`,
  který nebyl doručen a **nerekonstruuji ho z paměti**. Bez něj nelze potvrdit, zda např. `doGet
  ?action=projects` je vystaven anonymně, ani zda scopes odpovídají REST voláním Tasks (`Code.gs:1071`).
- **Reálná výkonová čísla** — jen odhady z četby; měření přijde s fixture generátorem (B7).
- **Přesné kontrastní poměry** — vyžadují měření v obou tématech (B6), ne odhad.

---

## 10. Doporučené pořadí prací (návrh k odsouhlasení)

1. **B7 (základ) + testovatelnost §7** — vytáhnout čisté engine-jádro, fixture generátor, `node --check`
   gate. Bez regresní sítě je jakákoli oprava enginu riziková.
2. **P0 bezpečnost §5.1** — serverové role-checky (malá změna, kritický dopad). Nezávislé na ostatním.
3. **B2 engine §3** — sjednotit datum, forward-pass CPM per komponenta, detekce cyklů, viditelné
   a vratitelné auto-přeplánování; proti ≥40 referenčním případům.
4. **B1 render §2** — diff + virtualizace obou gridů.
5. **B3 souběh §4** — per-issue merge, presence, per-field historie.
6. **B4 integrace §4/§5.3**, **B6 a11y §6**, **B5 reporting** — dle priorit zákazníka.

> **Čekám na odsouhlasení této analýzy, než začnu implementovat kterýkoli balíček.**
> Každý balíček půjde samostatně, s testy a migrací, cílenými editacemi proti skutečnému obsahu souborů.

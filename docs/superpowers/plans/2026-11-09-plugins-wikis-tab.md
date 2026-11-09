# Plugins → Wikis tab: order, collapsing, inherited plugins, clashes; folder descriptions – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapsible, reorderable cards in Plugins → Wikis that show each folder's full (transitive) plugin set with
duplicates and version clashes, a removal prompt naming affected wikis, a clash chip on the home view, and
descriptions for included folders.

**Architecture:** A new pure module `src/plugin-chain.js` (plain script in the window + CommonJS for tests, like
`search.js`) walks includes, analyses a chain and formats clash/removal text. `main.js` uses it for transitive
`knownFolders()`/`setupFolders()`, per-card chain data in `pluginsState()`, a cached clash list per wiki in the pushed
state, the card order and folder descriptions in `config.json`. `plugins-ui.js` and `renderer.js` render it.

**Tech Stack:** Electron 45, plain JS (tabs, double quotes, no build), Node test runner, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-09-plugins-wikis-tab-design.md`

## Global Constraints

- Code style: tabs, double quotes, plain JS, small "why" comments only; `el()` helper and `pluginAction` in `plugins-ui.js`.
- Paths are compared with `folderKey()` (main.js) / `pathKey()` (renderer.js) – case-insensitive only on Windows/macOS.
- `config.json` keys: `pluginsFolderOrder` (array of folder paths), `folderDescriptions` (object: folder path → text,
  max 2000 chars, trimmed, empty deletes).
- Collapsed cards: `localStorage` key `tw-desk.plugins.collapsed` (JSON array of `pathKey`s), every access in try/catch,
  default expanded.
- Git checks (`gitFolders()`), `deleteCheck`/`includedBy` and the binary scan stay one level of includes.
- No change to how `setFolderList` writes `tiddlywiki.info`.
- Unit tests must pass on Windows too: build paths with `path.join`/`path.resolve`, never `"a/b"` literals.
- E2E only headless: `env -u WAYLAND_DISPLAY -u DISPLAY xvfb-run -a npx playwright test <spec>`; never `git stash`.
- Unit tests: `NODE_PATH=/mnt/c/data/22-tiddlydesktop/tw-desk/node_modules npm test` (if no local `node_modules`).
- Commit per task, stage files explicitly, end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Version `0.2.23` (package.json), README + CLAUDE.md updated in the last task.

## Review Focus

1. An include loop (A → B → A) or a missing include must not hang or throw: error line on the card, rest still shown.
2. The same folder reached by two paths (A → C, B → C) is listed once on the card, but "who wins" uses its last load.
3. Same plugin, same version, listed + stored → only "duplicate" info, never a red clash.
4. A folder that's in `pluginsFolderOrder` but gone, or a new folder not in it: no crash, new folder appended.
5. Removing from a folder only the wiki itself loads: no extra prompt (only the existing ESSENTIAL confirm).

---

### Task 1: Pure chain module `src/plugin-chain.js`

**Files:**
- Create: `src/plugin-chain.js`
- Test: `test/unit/plugin-chain.test.js`

**Interfaces:**
- Produces (all exported via `if (typeof module === "object") module.exports = {…}`, plain functions in the window):
  - `walkIncludes(root: string, readIncludes: (p) => { includes: [{ resolved, exists }] }, key: (p) => string)`
    → `{ order: [{ path, chain }], errors: [{ path, chain, reason: "missing" | "loop" }] }`.
    `order` is TiddlyWiki load order: depth-first, each folder's includes (in `includeWikis` order) before the folder,
    root last with `chain: []`. `chain` = folder paths from the root's direct include down to this folder (inclusive).
    A folder already on the current path → `loop` error, not recursed. `exists: false` → `missing` error.
    A folder reached twice appears twice in `order`.
  - `analyzeChain(order, folderInfo: (p) => { lists: { plugins, themes, languages } | null, stored: [{ title, kind, name, version }] }, resolve: (kind, name) => { title, origin: "bundled" | "store" | "missing", version }, key)`
    → `{ entries, problems }`.
    `entries`: one per (distinct folder × plugin), `{ title, kind, name, folder, chain, source: "list" | "stored", origin: "bundled" | "store" | "missing" | "wiki", version, position }`;
    a distinct folder contributes once – `chain` from its **first** occurrence in `order`, `position` from its **last**;
    within a folder: listed plugins, then themes, then languages (array order), then stored (`origin: "wiki"`); position
    strictly increasing in that load order.
    `problems`: per title with ≥ 2 entries, `{ title, type: "duplicate" | "clash", entries: [indexes into entries], winner: index }`;
    `clash` = ≥ 2 distinct non-empty versions among entries whose `origin !== "missing"`, otherwise `duplicate`;
    `winner` = entry with the highest `position` (origin ≠ missing).
  - `chainLabel(chain: string[], nameOf: (p) => string) -> string`: `""` for `[]`, `"from A"` for one, `"via A → B"` for more.
  - `clashText(problem, entries, nameOf) -> string`, e.g. `"store 1.2.0 · in rr-streams 1.0.3 – rr-streams' copy wins"`.
    Labels in entry order: `store <v>`, `bundled <v>`, `in <folder name> <v>` (origin wiki). Winner phrase:
    `the store copy` / `the bundled copy` / `<name>'s copy` (`<name>'` when the name ends in `s`).
  - `removalImpact(wikis: [{ name, path, entries }], folderPath, title, key)` → `{ lose: [name], keep: [{ name, by }] }`:
    only wikis having an entry `(title, source "list", folder == folderPath)`; `by` = highest-position other entry of
    that title with `origin !== "missing"`; `keep` if there is one, else `lose`.
  - `keepReason(wiki, by, nameOf) -> string`: `"listed itself"` (by.folder is the wiki's path, source list),
    `"stored in <name>"` (source stored), else `chainLabel(by.chain, nameOf)`.
  - `orderFolders(folders: [{ path }], order: string[], key)` → new array: folders named in `order` first, in that
    order; the rest after them in their original order; unknown order entries ignored.

- [ ] **Step 1: Write the failing tests** in `test/unit/plugin-chain.test.js` (no Electron stub needed). Use an
  in-memory graph: `const P = name => path.resolve("/w", name)`, `readIncludes` from a map, `key = p => p`.
  - `walkIncludes: load order, chains, loop and missing` – R includes [A, B]; A includes [C]; B includes [C, M (exists:false)]; C includes [R]:
    `order.map(o => [base(o.path), o.chain.map(base)])` deep-equals
    `[["C", ["A","C"]], ["A", ["A"]], ["C", ["B","C"]], ["B", ["B"]], ["R", []]]`;
    `errors.map(e => [base(e.path), e.reason])` deep-equals `[["R","loop"], ["R","loop"], ["M","missing"]]` (in walk order).
  - `analyzeChain: duplicate vs clash, winner by last load` – order from the walk above; C lists `test/hello`
    (resolve → store 1.2.0) and B stores `$:/plugins/test/hello` 1.0.3, R lists `test/hello`, A lists `test/other`
    and stores `$:/plugins/test/other` with the same version as the store (2.0.0):
    - entries for C appear once, with chain `["A","C"]` and a position greater than A's entries (last occurrence after A);
    - problem for `$:/plugins/test/hello` has `type: "clash"`, winner = R's listed entry (R loads last);
    - problem for `$:/plugins/test/other` has `type: "duplicate"`;
    - a plugin resolving to `origin: "missing"` listed twice → `duplicate`, no winner crash.
  - `clashText and chainLabel` – exact strings: `chainLabel([], …) === ""`, `"from rr-core"`, `"via rr-core → x"`;
    `clashText` for store 1.2.0 + `in rr-streams 1.0.3` with rr-streams winning →
    `"store 1.2.0 · in rr-streams 1.0.3 – rr-streams' copy wins"`; with `orga` winning → `"… – orga's copy wins"`;
    store winning → `"… – the store copy wins"`.
  - `removalImpact and keepReason` – wikis orga (chain via rr-core only), priv-orga (via rr-core), tw-knowledge
    (via rr-core and lists it itself): removing from rr-core → `lose` `["orga","priv-orga"]`,
    `keep[0].name === "tw-knowledge"`, `keepReason(...) === "listed itself"`; a wiki not loading rr-core is in neither.
  - `orderFolders` – folders [a, b, c, d], order [c, gone, a] → [c, a, b, d].
- [ ] **Step 2: Run** `node --test test/unit/plugin-chain.test.js` – expected FAIL (module missing).
- [ ] **Step 3: Implement `src/plugin-chain.js`** with the signatures above (no fs, no DOM, header comment like `search.js`).
- [ ] **Step 4: Run** `node --test test/unit/plugin-chain.test.js` – expected PASS; then the full `npm test`.
- [ ] **Step 5: Commit** `src/plugin-chain.js test/unit/plugin-chain.test.js` – "Plugin chain: transitive includes, duplicates, clashes".

### Task 2: Main process – transitive folders, chain data, order, clash cache

**Files:**
- Modify: `src/main.js` (`knownFolders`, `setupFolders`, `pluginsState`, state builder near line 220, plugin IPC near 1694–1760, `save-includes`, `startWiki`/`stopWiki`)
- Modify: `src/preload.js` (`plugins.setOrder`)
- Modify: `src/index.html` (load `plugin-chain.js` before `plugins-ui.js`)
- Test: `test/e2e/plugins.spec.js` (new test, see Task 3 – this task's behaviour is checked there; run the existing plugin/includes/setup e2e to prove nothing broke)

**Interfaces:**
- Consumes: Task 1 (`require("./plugin-chain")`).
- Produces:
  - `knownFolders()` – transitive via `walkIncludes` for every managed wiki; each folder `{ path, name, managed, usedBy, running }` as today, `usedBy` = every managed wiki whose walk `order` contains it; order: managed wikis in list order, then other folders in discovery order.
  - `setupFolders(wikis)` – same transitive walk (only folders in `order`, i.e. existing ones).
  - `pluginsState().folders` = `orderFolders(knownFolders(), config.pluginsFolderOrder || [], folderKey)`, each also with
    `description` (Task 4 fills it; `""` until then is fine), `chain: { entries, problems, errors }` (from walking that
    folder as root). `folderInfo` is memoised per call (one `folderLists` + `listStoredInWiki` per folder).
    `resolve(kind, name)`: bundled match → origin bundled, else store match → store, else `{ title: plugins.titleOf(kind, name), origin: "missing", version: "" }`.
  - IPC `plugins-set-order(paths: string[])` → `config.pluginsFolderOrder = paths` (strings only), `saveConfig()`; preload `plugins.setOrder(paths)`.
  - `refreshPluginClashes()` → fills `pluginClashes: Map<wikiId, [{ title, text }]>` (`text` = `clashText`, names via
    the folders' names) for every managed wiki; called at startup after `loadConfig`, after `plugins-set-list`,
    `plugins-move-to-store`, `plugins-install`, `plugins-remove`, `save-includes`, after a wiki starts or stops, and
    inside `pluginsState()`; then `pushState()` when the list changed.
  - State builder: each wiki gets `pluginClashes: pluginClashes.get(w.id) || []`.

- [ ] **Step 1: Implement** the items above. `plugins-move-to-store` keeps its refusal, now with transitive `running`/`usedBy`.
- [ ] **Step 2: Run** `npm test` (PASS) and headless e2e `test/e2e/plugins.spec.js test/e2e/includes.spec.js test/e2e/setup.spec.js` – all PASS.
- [ ] **Step 3: Commit** `src/main.js src/preload.js src/index.html` – "Plugins: transitive folders, chain data, card order, clash cache".

### Task 3: Plugins window – collapsible, reorderable cards, inherited plugins, badges, removal prompt

**Files:**
- Modify: `src/plugins-ui.js` (`renderWikisTab`, `openPluginsTab`), `src/styles.css`
- Test: `test/e2e/plugins.spec.js` (new test)

**Interfaces:**
- Consumes: Task 2 (`pstate.folders[].chain`, `.description`, `papi.setOrder`), Task 1 (`chainLabel`, `clashText`, `removalImpact`, `keepReason`).
- Produces: `openPluginsTab(tab, focusPath?)` – with `focusPath` that card is expanded (removed from the collapsed set) and scrolled into view after rendering.

Behaviour (spec goals 1–6):
- Top of the tab: buttons *Expand all* / *Collapse all*.
- Card header: toggle `▸`/`▾`, name, description (muted, if any), count `"<n> own · <m> from includes"`, `⚠ clash` badge
  when the card's chain has a clash; header `draggable`, drop before/after a card → `papi.setOrder(<all card paths in new order>)`, then reload.
  Collapsed card shows only the header.
- Own rows unchanged (Remove, Demo, Add, *Stored inside this wiki*), plus info `also from <chainLabel>` / `listed twice`
  on duplicate rows and red `clash: <clashText>` on clash rows.
- Section *From included wikis* (only if there are inherited entries or errors): muted read-only rows, badge
  `chainLabel(entry.chain)`, origin badge as today (`store 1.2.0`, `bundled`, `missing`, `in wiki 1.0.3`), same
  duplicate/clash marks; errors as error lines: `"Included folder not found: <path>"`, `"Include loop: <path> is already loaded (skipped)"`.
- Remove on a folder with `usedBy` other than the folder's own wiki: `confirm()` with
  `"Remove <name> from <folder>? <A and B> include <folder> and lose it on their next restart (<W> keeps it: <reason>; …)."`
  built from `removalImpact` over the managed cards' chains (names joined `", "` and `" and "` for the last; `includes` for one wiki, `include` for several); the
  parenthesis only when `keep` is non-empty; when `lose` is empty: `"Remove <name> from <folder>? <W> keeps it: <reason>."`.
  Cancel → nothing changes. The ESSENTIAL confirm stays.
- Collapsed set in `localStorage` per Global Constraints; no re-render while a drag is in progress.

- [ ] **Step 1: Write the failing e2e test** `test("wikis tab: inherited plugins, clash, order, collapse, removal prompt", …)`:
  folders alpha (managed) → includes `shared` → includes `deep`; `deep` lists `tiddlywiki/internals` (bundled),
  `shared` stores a plugin tiddler `$:/plugins/test/hello` 1.0.0 (write the `.json` into `shared/tiddlers/`), the store has
  `test/hello` 1.1.0 (install via the test library) and alpha lists `test/hello`. Assert:
  - three cards; alpha's card has a row in *From included wikis* with `via shared → deep` for `internals`;
  - alpha's card shows `⚠ clash` and a row text containing `clash: in shared 1.0.0 · store 1.1.0 – the store copy wins`;
  - the home row of Alpha has a chip `⚠ plugin clash` (Task 4 adds it – mark this assertion `test.fixme` until Task 4, or keep it for Task 4's step);
  - *Collapse all* hides the rows (`.plugin-table` not visible); reopening the dialog keeps them collapsed;
  - dragging the `deep` card header before alpha's → `config.json` `pluginsFolderOrder[0]` is the deep path; card order follows after reopening;
  - removing `tiddlywiki/internals` on `deep`'s card shows a confirm whose text contains `Alpha includes deep` and `next restart` (singular: "loses it on its next restart") (stub `confirm` via `page.evaluate` to capture the text and return false) and the list is unchanged.
- [ ] **Step 2: Run** it headless – expected FAIL.
- [ ] **Step 3: Implement** the behaviour above.
- [ ] **Step 4: Run** the new test and the whole `test/e2e/plugins.spec.js` headless – PASS.
- [ ] **Step 5: Commit** `src/plugins-ui.js src/styles.css test/e2e/plugins.spec.js` – "Plugins window: collapsible, reorderable cards with inherited plugins and clashes".

### Task 4: Home view – clash chip; descriptions for included folders (incl. setup export/import)

**Files:**
- Modify: `src/main.js` (config helpers, IPC, state builder, `pluginsState` description, setup export/import), `src/preload.js`, `src/renderer.js` (row, `includeChip`, `showIncludesOverview`), `src/index.html` (if the overview needs markup), `src/setup.js` (`buildSetup`, `planImport`), `src/styles.css`
- Test: `test/unit/setup.test.js`, `test/e2e/includes.spec.js`, `test/e2e/plugins.spec.js` (the clash chip assertion from Task 3)

**Interfaces:**
- Consumes: Task 2 (`wiki.pluginClashes`), Task 3 (`openPluginsTab(tab, focusPath)`).
- Produces:
  - main.js `folderDescription(folderPath) -> string` (managed wiki → `wiki.description || ""`, else `config.folderDescriptions` entry whose key matches by `folderKey`, else `""`); `setFolderDescription(folderPath, text)` – throws for a managed wiki (`"Edit the wiki to change its description."`) or a folder not in `knownFolders()`; trims, cuts at 2000, empty deletes; `saveConfig()`, `pushState()`.
  - IPC `set-folder-description(path, text)`; preload `setFolderDescription(path, text)`.
  - State: every `wikis[].includes[]` item gets `description: folderDescription(include.resolved)`; `pluginsState` folders get `description`.
  - `setup.buildSetup`: `input.folders[]` may carry `description`; written on the setup's `folders` entries only when non-empty.
    `planImport` items get `description: entry.description || null` for non-wiki folders.
  - `runImport`: for every plan folder item with `!item.wiki`, a `description`, a path that is a wiki folder after the import, and no existing description → `config.folderDescriptions[item.path] = description`.

Behaviour:
- Home row: if `wiki.pluginClashes.length`, a warning chip `⚠ plugin clash`, tooltip one line per clash `"<title>: <text>"`, click → `openPluginsTab("wikis", wiki.path)`.
- `includeChip` tooltip: path, then the description on the next line when present (missing note stays).
- Includes overview: each group shows the description; non-managed folders get a textarea (maxlength 2000) + *Save* → `api.setFolderDescription`; managed ones show theirs read-only with `"(edit the wiki to change it)"`.

- [ ] **Step 1: Write failing tests**
  - unit `setup.test.js`: `test("folder descriptions travel with the setup", …)` – `buildSetup` with a non-wiki folder `{ path, git: null, description: "Shared core" }` → its `folders` entry has `description: "Shared core"`, a folder without one has no `description` key; `planImport` on that setup → the non-wiki item has `description: "Shared core"`, wiki items `null`.
  - e2e `includes.spec.js`: `test("descriptions for included folders", …)` – Alpha includes shared; in the overview type `Shared core` and *Save*; `config.json` `folderDescriptions` has it (key = shared path); the row's include chip `title` contains the path and `Shared core`; the Plugins card for shared shows `Shared core`.
  - e2e `plugins.spec.js`: the Task 3 chip assertion enabled – chip `⚠ plugin clash` on Alpha's row; clicking it opens the Plugins dialog with Alpha's card expanded.
- [ ] **Step 2: Run** them – expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and headless e2e `includes.spec.js plugins.spec.js setup.spec.js` – PASS.
- [ ] **Step 5: Commit** the files above – "Folder descriptions for included wikis; plugin clash chip on the home view".

### Task 5: Docs and version

**Files:**
- Modify: `package.json` (`"version": "0.2.23"`), `README.md` (Plugins window section: collapsing, ordering, inherited plugins, duplicates/clashes, removal prompt; includes overview: descriptions), `CLAUDE.md` (Layout: `src/plugin-chain.js`; Decisions: transitive `knownFolders`/`setupFolders` while git/binaries stay one level, `pluginsFolderOrder`, `folderDescriptions`, clash cache refresh points; State: 0.2.23), spec status → "shipped in 0.2.23".

- [ ] **Step 1: Edit** the docs; **Step 2:** run `npm test` and the full headless e2e suite – PASS; **Step 3: Commit** – "0.2.23: Plugins window cards, inherited plugins, clashes, folder descriptions".

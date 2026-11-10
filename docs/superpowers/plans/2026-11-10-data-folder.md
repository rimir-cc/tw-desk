# Data Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move everything that makes up the user's TW Desk (config, plugin store, web wikis) into a user-chosen,
movable, git-versioned data folder with automatic commits and a push reminder; keep machine-local data in `userData`.

**Architecture:** A new pure-plus-fs module `src/data-folder.js` holds path conversion, the local/shared config split,
pointer file, copy/verify, re-point planning and commit messages. `src/main.js` resolves the data folder at startup
(env `TW_DESK_DATA` → pointer `userData/data-folder.json` → setup needed), reads/writes `config.json` there and
`local.json` in `userData`, and treats the data folder as one more git folder (status, Git tab, auto-commit). The
renderer gets a blocking first-start dialog, a Settings section, a header git chip, "not found" wiki rows and a
re-point banner.

**Tech Stack:** Electron, Node (CommonJS), plain DOM renderer, `node:test` unit tests, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-10-data-folder-design.md`

## Global Constraints

- Data folder content: `config.json` (minus local fields), `store/`, `web/`, `.gitignore`. Everything else stays in `userData`.
- Local fields (to `userData/local.json`): `wikis[].lastPort`, `webWikis[].check`, `groups[].collapsed`, `webCollapsed`, `ungroupedCollapsed`.
- Paths (`wikis[].path`, `folderDescriptions` keys, `pluginsFolderOrder` entries) stored relative to the data folder when the relative path has **at most two leading `..`**, else absolute; stored with `/` separators; in memory always absolute.
- `config.json` is written only when its shared (non-local) text changes – local-only changes never touch the data folder.
- Auto-commit: debounce **90 s** after the last change (`TW_DESK_DATA_COMMIT_DELAY` ms overrides, for tests), and on quit; never while the data folder's branch is behind, merging, conflicted or detached. **Never push automatically.**
- The data folder always has its **own** repository (nested `git init` allowed); auto-commit only touches the data folder. A data folder without its own `.git` shows as "no repository", even inside another repo.
- Pull: fast-forward only (existing `git.pull`); running wikis are stopped first; config, store and web are reloaded after.
- "Use existing data folder…" with a current setup: warning naming what is dropped, confirm, then **replace** (no merge, no backup).
- Moving / migrating copies first, verifies, and only then removes the source. Move asks before removing the old folder.
- Tests never touch the user's real data: `TW_DESK_USER_DATA` and `TW_DESK_DATA` both point into the test's temp folder. Headless e2e: `env -u WAYLAND_DISPLAY -u DISPLAY xvfb-run -a npx playwright test …`. Ports 8080/8090/8091 are off limits.
- Unit tests: `NODE_PATH=/mnt/c/data/22-tiddlydesktop/tw-desk/node_modules npm test` (124 passing before this plan).
- Version 0.2.24; README, CLAUDE.md updated; commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; stage files explicitly; no `git stash`.

## Review Focus

1. **Pointer to a folder that no longer exists** (drive unplugged, folder deleted): TW Desk must not create an empty setup silently; it shows the setup dialog with "Your data folder X wasn't found" – test in Task 4.
2. **Quitting within the 90 s debounce** must still commit (and must not hang quit when git fails or is slow – 10 s cap) – test in Task 6.
3. **Wiki paths on another drive / deeper than two levels up** stay absolute and survive a data-folder move unchanged; relative ones are recomputed – unit test in Task 1, e2e in Task 5.
4. **Data folder inside another git repository** (e.g. the wikis' parent is a repo): status must be that of the nested repo or "no repository", never the outer one; auto-commit must never commit in the outer repo – test in Task 6.
5. **A `config.json` edited by hand / broken JSON in the data folder**: load shows the existing error box and does not overwrite the file with defaults on the next save – test in Task 3.

---

### Task 1: Pure helpers in `src/data-folder.js`

**Files:**
- Create: `src/data-folder.js`
- Test: `test/unit/data-folder.test.js`

**Interfaces:**
- Produces (all exported; `key(p)` compares paths case-insensitively on Windows like main's `folderKey`):
  - `toStored(absPath: string, dataDir: string): string` – relative with `/` when ≤2 leading `..` (and same root), else `path.resolve(absPath)`.
  - `fromStored(stored: string, dataDir: string): string` – absolute.
  - `storeConfigPaths(config, dataDir) -> config` / `resolveConfigPaths(config, dataDir) -> config` – new objects; convert `wikis[].path`, `folderDescriptions` keys, `pluginsFolderOrder`.
  - `LOCAL_FIELDS` description and `splitLocal(config) -> { shared, local }`, `mergeLocal(shared, local) -> config`. `local` shape: `{ wikis: { [id]: { lastPort } }, webWikis: { [id]: { check } }, groups: { [id]: { collapsed } }, webCollapsed, ungroupedCollapsed }` (only set values).
  - `commitMessage(actions: string[], changedFiles: string[]) -> string` – unique actions in order joined with `" · "`; more than 6 → first 6 + `" · +N more"`; no actions → `"TW Desk: setup changed (YYYY-MM-DD HH:MM)"`.
  - `suggestLocation(wikiPaths: string[], documentsDir: string, key) -> string` – `<common parent of the wikis' parents>/tw-desk-data`, else `<documentsDir>/TW Desk data`. Reuse `commonBase` from `src/setup.js` (export it there).
  - `missingGroups(missing: [{ id, path }], key) -> [{ parent, ids }]` – groups of ≥2 by `path.dirname`, largest first.
  - `repointPlan(items: [{ id, path }], oldParent, newParent, exists: (p) => bool, key) -> [{ id, from, to, found }]`.
  - `replacePrefix(p, oldParent, newParent, key) -> string | null` – for `folderDescriptions`/`pluginsFolderOrder`.

- [ ] **Step 1: Write the failing tests**

```js
test("toStored: relative up to two levels up, absolute beyond and across drives", () => {
	const data = P("data", "tw-desk-data");                  // P = path.resolve(path.sep, ...)
	assert.equal(dataFolder.toStored(P("data", "wikis", "orga"), data), "../wikis/orga");
	assert.equal(dataFolder.toStored(P("x", "y"), data), "../../x/y");
	assert.equal(dataFolder.toStored(P("data", "tw-desk-data", "sub", "z"), data), "sub/z");
	assert.equal(dataFolder.toStored(P("data", "tw-desk-data", "a", "b", "c"), P("data", "tw-desk-data", "a", "b", "c", "d", "e")), "../..");
	assert.equal(dataFolder.toStored(P("w"), P("a", "b", "c")), P("w"));               // three levels up
	assert.equal(dataFolder.fromStored("../wikis/orga", data), P("data", "wikis", "orga"));
	assert.equal(dataFolder.fromStored(P("w"), data), P("w"));
});
test("store/resolveConfigPaths round-trip wikis, folderDescriptions, pluginsFolderOrder", () => { /* stored form has "../wikis/orga" keys; resolve gives back the input deepEqual */ });
test("splitLocal / mergeLocal", () => {
	const config = { wikis: [{ id: "a", name: "A", path: "/w/a", lastPort: 8100 }], webWikis: [{ id: "l", url: "u", check: { date: "d", result: "same" } }],
		groups: [{ id: "g", name: "G", collapsed: true }], webCollapsed: true, ungroupedCollapsed: false, basePort: 8090 };
	const { shared, local } = dataFolder.splitLocal(config);
	assert.deepEqual(shared.wikis[0], { id: "a", name: "A", path: "/w/a" });
	assert.equal("check" in shared.webWikis[0], false);
	assert.equal("collapsed" in shared.groups[0], false);
	assert.equal("webCollapsed" in shared, false);
	assert.deepEqual(local, { wikis: { a: { lastPort: 8100 } }, webWikis: { l: { check: { date: "d", result: "same" } } }, groups: { g: { collapsed: true } }, webCollapsed: true, ungroupedCollapsed: false });
	assert.deepEqual(dataFolder.mergeLocal(shared, local), config);
	assert.deepEqual(dataFolder.mergeLocal(shared, {}).wikis[0], shared.wikis[0]);   // missing local.json
});
test("commitMessage", () => {
	assert.equal(dataFolder.commitMessage(["Added wiki orga", "Installed $:/plugins/kixam/moment 1.2.0", "Added wiki orga"], []), "Added wiki orga · Installed $:/plugins/kixam/moment 1.2.0");
	assert.match(dataFolder.commitMessage(["1","2","3","4","5","6","7","8"], []), / · \+2 more$/);
	assert.match(dataFolder.commitMessage([], ["config.json"]), /^TW Desk: setup changed \(\d{4}-\d\d-\d\d \d\d:\d\d\)$/);
});
test("suggestLocation", () => { /* wikis /d/wikis/a, /d/wikis/b → /d/tw-desk-data ; no wikis → <documents>/TW Desk data */ });
test("missingGroups and repointPlan", () => {
	const groups = dataFolder.missingGroups([{ id: "1", path: P("old", "w", "a") }, { id: "2", path: P("old", "w", "b") }, { id: "3", path: P("else", "c") }], key);
	assert.deepEqual(groups, [{ parent: P("old", "w"), ids: ["1", "2"] }]);
	const plan = dataFolder.repointPlan([{ id: "1", path: P("old", "w", "a") }, { id: "2", path: P("old", "w", "b") }], P("old", "w"), P("new"), p => p === P("new", "a"), key);
	assert.deepEqual(plan.map(p => [p.id, p.to, p.found]), [["1", P("new", "a"), true], ["2", P("new", "b"), false]]);
	assert.equal(dataFolder.replacePrefix(P("old", "w", "a", "x"), P("old", "w"), P("new"), key), P("new", "a", "x"));
	assert.equal(dataFolder.replacePrefix(P("other"), P("old", "w"), P("new"), key), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_PATH=/mnt/c/data/22-tiddlydesktop/tw-desk/node_modules node --test test/unit/data-folder.test.js`
Expected: FAIL – `Cannot find module '../../src/data-folder'`.

- [ ] **Step 3: Implement the helpers** in `src/data-folder.js` (CommonJS; no Electron). Count leading `..` segments of `path.relative(dataDir, abs)`; `path.isAbsolute(relative)` (other drive) → absolute. Export `commonBase` from `src/setup.js` and use it in `suggestLocation`.

- [ ] **Step 4: Run to verify they pass**, then the whole unit suite.

Run: `NODE_PATH=/mnt/c/data/22-tiddlydesktop/tw-desk/node_modules npm test`
Expected: all pass (124 + new).

- [ ] **Step 5: Commit** – `git add src/data-folder.js src/setup.js test/unit/data-folder.test.js` · `feat: data-folder path, local-split and re-point helpers`

---

### Task 2: File operations in `src/data-folder.js`, data-folder `init` in `src/git.js`

**Files:**
- Modify: `src/data-folder.js`, `src/git.js`
- Test: `test/unit/data-folder.test.js`, `test/unit/git.test.js`

**Interfaces:**
- Produces:
  - `readPointer(userData) -> string | null`, `writePointer(userData, dataDir)` – `userData/data-folder.json` `{ "path": … }`, written via temp file + rename.
  - `DATA_GITIGNORE = "*.tmp\n"`.
  - `folderState(dir) -> "missing" | "empty" | "data" | "other"` – `data` = contains `config.json`; `empty` = exists with no entries.
  - `copyData(fromDir, toDir, entries = ["config.json", "store", "web"])` – copies the listed entries that exist (`fs.cpSync` recursive), then verifies (same relative file list and sizes); throws (and removes what it copied into `toDir`) on mismatch.
  - `copyTree(fromDir, toDir)` – whole folder including `.git`, same verify.
  - `ownRepo(dir) -> bool` – `fs.existsSync(path.join(dir, ".git"))`.
  - `git.init(folder, options = {})` in `src/git.js` – existing behaviour unchanged by default; `options.ignore` replaces the `.gitignore` text, `options.message` the first commit message.
  - `git.status` additionally returns `unpushedSince: ms | null` – commit time of the oldest commit in `@{u}..HEAD` when `upstream && ahead`, else null.

- [ ] **Step 1: Write the failing tests** (temp folders under `os.tmpdir()`; git tests guarded like the existing ones in `test/unit/git.test.js`, using `test/helpers/git-env.js`)
  - `pointer round-trip; missing or broken file → null`
  - `folderState: missing, empty, data, other`
  - `copyData copies only listed entries and verifies` – a source with `config.json`, `store/plugins/a/b/plugin.info`, `web/x/snapshot.html`, `backup/y` → target has the first three, not `backup`.
  - `copyData: verification failure leaves no partial target` – stub `fs.cpSync` result by making one source file unreadable is fragile; instead export a `verifyCopy(from, to, entries)` and test that it throws on a size mismatch you create by hand.
  - `git.init with ignore and message` – `.gitignore` content is `"*.tmp\n"`, `git log -1 --format=%s` is `Initial TW Desk data`.
  - `git.init nested inside another repository makes its own repo` – `git rev-parse --show-toplevel` in the inner folder returns the inner folder.
  - `status.unpushedSince` – bare remote, push, then two local commits: `unpushedSince` equals the first local commit's time (±1 s); after push it is null.

- [ ] **Step 2: Run to verify they fail** – Run: `… node --test test/unit/data-folder.test.js test/unit/git.test.js` · Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement** the functions above.

- [ ] **Step 4: Run** `NODE_PATH=… npm test` · Expected: all pass.

- [ ] **Step 5: Commit** – `feat: data-folder pointer, copy/verify, nested git init, unpushedSince`

---

### Task 3: Main process runs on the data folder (config split, paths, store, web)

**Files:**
- Modify: `src/main.js` (config section ~L35–95, `plugins.init` call ~L2998, `webDir` ~L2044, startup ~L2980), `src/plugins.js` (`init`), `test/e2e/fixtures.js`
- Test: `test/e2e/data-folder.spec.js` (new), existing e2e must stay green

**Interfaces:**
- Consumes: Task 1 `splitLocal`, `mergeLocal`, `storeConfigPaths`, `resolveConfigPaths`; Task 2 `readPointer`.
- Produces (main.js):
  - `let dataDir: string | null` – the data folder; null while setup is needed (legacy mode: files in `userData` as today).
  - `dataSetupNeeded: null | "migrate" | "new" | "lost"` (Task 4 acts on it) and `resolveDataDir()` – `TW_DESK_DATA` env (absolute, created if missing) → pointer (must exist, else `"lost"`) → `"migrate"` if `userData/config.json` exists, else `"new"`.
  - `configPath()` = `path.join(dataDir || userData, "config.json")`; `localPath()` = `userData/local.json`.
  - `loadConfig()` reads both, `mergeLocal(resolveConfigPaths(shared, base), local)`. On a JSON error in `config.json`: existing error box **and** `configBroken = true`; `saveConfig()` then refuses to write `config.json` (local.json still written) until the next successful load.
  - `saveConfig(action?: string)` – splits, writes `local.json` when its text changed, writes `config.json` (paths via `storeConfigPaths`) only when its text differs from the last written/read text; when it wrote, calls `dataChanged(action)` (Task 6; a no-op stub here).
  - `plugins.init(storeParent, backupParent)` – store at `<storeParent>/store`, backups at `<backupParent>/backup`. Called with `(dataDir || userData, userData)`.
  - `webDir(id)` = `path.join(dataDir || userData, "web", id)`.
  - `snapshot().dataFolder = { path: dataDir, setup: dataSetupNeeded, suggestion }` (suggestion filled in Task 4).
- Fixture (`test/e2e/fixtures.js`): `launch(config, options = {})` sets `TW_DESK_DATA = this.userData` unless `options.dataEnv === false`; `options.writeConfig === false` skips writing `config.json`; `options.env` adds env vars. `desk.config()` returns the **merged, resolved** view (read `config.json` + `local.json`, `resolveConfigPaths` + `mergeLocal` from `src/data-folder.js`), so existing tests keep working; new `desk.rawConfig()` returns the parsed file; new `desk.addGroup(name)` (+ New → Group…, fill, submit – as in `groups.spec.js`); `stubMainProcess` also records `dialog.showErrorBox` calls into `calls.errors` (title + message).

- [ ] **Step 1: Write the failing e2e tests** in `test/e2e/data-folder.spec.js`:

```js
test("using the app leaves config.json alone; local values go to local.json", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const before = desk.rawConfig();
	const port = await desk.startWiki("Alpha");
	await desk.stopWiki("Alpha");
	const local = JSON.parse(fs.readFileSync(path.join(desk.userData, "local.json"), "utf8"));
	expect(Object.values(local.wikis)[0].lastPort).toBe(port);
	expect(desk.rawConfig().wikis[0].lastPort).toBeUndefined();
	expect(desk.config().wikis[0].lastPort).toBe(port);
	expect(desk.rawConfig()).toEqual(before);
});
test("wiki paths are stored relative to the data folder", async ({ desk }) => {
	const alpha = desk.wiki("alpha");                 // <root>/wikis/alpha, data folder <root>/userdata
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	await desk.addGroup("Work");                      // any shared change saves config.json
	await expect.poll(() => desk.rawConfig().wikis[0].path).toBe("../wikis/alpha");
	expect(desk.config().wikis[0].path).toBe(alpha);
});
test("a broken config.json is reported and not overwritten", async ({ desk }) => {
	fs.mkdirSync(desk.userData, { recursive: true });
	fs.writeFileSync(path.join(desk.userData, "config.json"), "{ broken");
	await desk.launch({}, { writeConfig: false });
	// the error box is dialog.showErrorBox: stub it in stubMainProcess (record into calls.errors) as part of this task
	expect((await desk.mainCalls()).errors.join("\n")).toContain("Could not read");
	await desk.addGroup("Work");
	expect(fs.readFileSync(path.join(desk.userData, "config.json"), "utf8")).toBe("{ broken");
});
test("store and web wikis live in the data folder, backups in userData", async ({ desk }) => {
	/* launch with dataEnv pointing to <root>/data (options.env.TW_DESK_DATA), install the test plugin from the
	   test library; expect <root>/data/store/plugins/test/hello/plugin.info; remove a plugin → backup under
	   desk.userData/backup */
});
```

Note for the first test: the fixture-written `config.json` contains `lastPort`-free wikis with ids, so no load-time rewrite happens; compare `rawConfig()` before/after start+stop with `toEqual`.

- [ ] **Step 2: Run to verify they fail** – Run: `env -u WAYLAND_DISPLAY -u DISPLAY xvfb-run -a npx playwright test test/e2e/data-folder.spec.js` · Expected: FAIL (no `local.json`, `lastPort` in config.json, absolute paths).

- [ ] **Step 3: Implement** the Produces list. `resolveDataDir()` runs before `plugins.init` in `app.whenReady`. Collapse handlers (`set-web-collapsed`, `set-group-collapsed`) and port/check writes keep calling `saveConfig()` – the split makes them local-only.

- [ ] **Step 4: Run** the new spec, then the whole e2e suite and `npm test`. Expected: new tests pass; e2e as before (the 3 known minimize failures under xvfb only); unit all pass.

- [ ] **Step 5: Commit** – `feat: config, store and web in the data folder; local values in local.json`

---

### Task 4: First start – setup dialog, migration, new, use existing (replace), lost folder

**Files:**
- Modify: `src/main.js`, `src/preload.js`, `src/index.html`, `src/renderer.js`, `src/styles.css`
- Test: `test/e2e/data-folder.spec.js`

**Interfaces:**
- Consumes: Task 2 `folderState`, `copyData`, `writePointer`, `DATA_GITIGNORE`, `git.init(folder, { ignore, message })`; Task 1 `suggestLocation`, `splitLocal`.
- Produces:
  - IPC `data-folder-setup(mode: "create" | "existing", target: string) -> { replaced?: true }` and preload `api.dataFolder.setup(mode, target)`; `data-folder-replace-summary(target) -> { wikis, webWikis, plugins }` (counts of the **current** setup) and preload `api.dataFolder.replaceSummary(target)`. Picking a folder uses the existing `pick-folder` style IPC (use the one the wizard uses).
  - `useDataDir(dir)` in main: sets `dataDir`, `plugins.init(dir, userData)`, `loadConfig()`, `refreshPluginClashes()`, `checkGit()`, `pushState()`.
  - **create** (`target` missing or `empty`; `other` → error "This folder isn't empty. Choose an empty folder, or Use existing data folder… for a TW Desk data folder."; `data` → same as existing): in `"migrate"` mode `copyData(userData, target)` then rewrite `target/config.json` through `splitLocal`/`storeConfigPaths` (local part to `userData/local.json`); in `"new"`/`"lost"` mode write an empty config. Then `.gitignore`, `git.init(target, { ignore: DATA_GITIGNORE, message: "Initial TW Desk data" })` when git is available, `writePointer`, `useDataDir(target)`, and in `"migrate"` mode only now `fs.rmSync` of `userData/config.json`, `userData/store`, `userData/web`. Any error before `writePointer` removes what was created in `target` (only if `target` was missing/empty before) and leaves `userData` as it was.
  - **existing** (`target` must be `data` or `empty`): stops running wikis, deletes `userData/local.json`, `writePointer`, `useDataDir(target)`; in `"migrate"` mode then removes the old `userData` files (replace – no backup).
  - Autostart (and the start-time binary policy pass) waits until `dataSetupNeeded` is null; after setup it runs once.
- Renderer: `<dialog id="data-setup-dialog">` opened (modal, Esc does nothing) whenever `state.dataFolder.setup` is set. Texts:
  - migrate: "TW Desk now keeps your setup – wikis list, settings, plugin store, web wikis – in a data folder you choose, so you can put it under git and move it. Temporary files stay where they are."
  - new: "Where should TW Desk keep your setup?"
  - lost: "Your data folder <path> wasn't found. Choose it again, use another one, or create a new one."
  - Path field prefilled with `state.dataFolder.suggestion`, *Choose…*, buttons **Create here** and **Use existing data folder…**. Before *existing* when the current setup isn't empty (`migrate`), `confirm()` with: "Your current <n> wikis, <m> web wikis and <k> store plugins are replaced by the setup in <path>. Wiki folders themselves are not touched." (counts with 0-parts left out).

- [ ] **Step 1: Write the failing e2e tests** (all with `launch(…, { dataEnv: false })`; pickers via `desk.pick`, `confirm()` is auto-OK and recorded):
  - `first start after the update moves the setup into the data folder` – legacy config with Alpha + a store plugin dir in `userData/store`; dialog visible with suggestion `<root>/tw-desk-data`; *Create here* → `<root>/tw-desk-data/config.json` has `"../wikis/alpha"`, `store/…/plugin.info` exists there, `userData/config.json` and `userData/store` are gone, `userData/data-folder.json` points there, `git log --format=%s` in the data folder is `Initial TW Desk data`, `.gitignore` is `*.tmp`. Relaunch (same userData, `dataEnv: false`, `writeConfig: false`) → no dialog, Alpha listed.
  - `fresh install: create an empty data folder` – `writeConfig: false`; *Create here* → empty list, pointer written.
  - `use existing replaces the current setup after a warning` – prepare a data folder with wiki "Beta"; legacy setup with Alpha; *Use existing…* → confirm text contains "Your current 1 wiki" and "are replaced"; list shows only Beta; `userData/config.json` gone; no `migrated-*` folder.
  - `new machine: use an existing (cloned) data folder` – `writeConfig: false`; a prepared data folder with Beta at `../wikis/beta` (copied there); *Use existing…* → no confirm (nothing to replace), Beta listed with the resolved path, `userData/local.json` created fresh.
  - `create refuses a non-empty foreign folder` – error text shown, nothing written into that folder.
  - `a lost data folder asks again` – pointer to `<root>/gone`; dialog shows "wasn't found"; nothing created at `<root>/gone`.
  - `autostart waits for the data folder` – legacy Alpha with `autostart: true`: not running while the dialog is open; running after *Create here*.

- [ ] **Step 2: Run to verify they fail** – `… xvfb-run -a npx playwright test test/e2e/data-folder.spec.js` · Expected: FAIL (no dialog).

- [ ] **Step 3: Implement** the Produces list.

- [ ] **Step 4: Run** the spec, full e2e, `npm test`. Expected: pass (known 3 minimize failures only).

- [ ] **Step 5: Commit** – `feat: choose the data folder on first start; migrate, create or use an existing one`

---

### Task 5: Settings → Data folder (Move…, Use existing…), header chip, Git tab for the data folder

**Files:**
- Modify: `src/main.js` (`gitFolders`, `runGitCheck`, `gitAction`), `src/preload.js`, `src/index.html`, `src/renderer.js`, `src/git-ui.js`, `src/styles.css`
- Test: `test/e2e/data-folder.spec.js`

**Interfaces:**
- Consumes: Task 2 `copyTree`, `ownRepo`, `writePointer`, `folderState`, `git.init` options; Task 3 `useDataDir`, `storeConfigPaths`.
- Produces:
  - `gitFolders()` includes `dataDir` (when set). In `runGitCheck`, for `dataDir` without `ownRepo` the entry is `{ repo: false }` (never the outer repo's status).
  - `gitAction` for the data folder: `init` → `git.init(dataDir, { ignore: DATA_GITIGNORE, message: "Initial TW Desk data" })` (allowed even inside another repo); `pull` → stops running wikis (no refusal), pulls, then `useDataDir(dataDir)` (reload config, store, web), restarts nothing; `commit` with the typed message.
  - IPC `data-folder-move(target) -> { old }`: `folderState(target)` must be `missing`/`empty`; flush a pending auto-commit (Task 6 `commitData()`, stub until then); stop running wikis (remember them); `copyTree(dataDir, target)`; rewrite `target/config.json` paths for the new location (`storeConfigPaths` of the in-memory config); `writePointer`; `useDataDir(target)`; restart the remembered wikis; `saveConfig("Moved data folder")` path is already written, so record the action directly. Returns the old path; IPC `data-folder-remove-old(old)` removes it only if `old` equals the path the last move returned.
  - IPC `data-folder-use-existing(target)` (Settings): as Task 4 *existing*; the old data folder stays on disk.
  - Renderer:
    - Settings dialog: new section "Data folder" (before "Move or share this setup"): the path (clickable → Show folder), the git chip, buttons **Move…**, **Use existing…**. Move: `pick` → IPC → `confirm("Remove the old data folder <old>?")` → remove-old. Use existing: `pick` → `confirm(replace warning)` → IPC.
    - Header: `<button id="data-chip" class="git-chip">` between Includes and Plugins, text from `gitSummary(gitStatusOf(state.dataFolder.path))` prefixed `TW Desk data`; hidden when git isn't available or `dataFolder.path` is null; click → `showPanel("data", "git")`.
    - `showPanel("data", "git")`: the Git tab shows `gitRepoSection({ path: dataFolder.path, label: "TW Desk data" }, status)`; the Log tab is hidden for `"data"`; `render()` treats `logWikiId === "data"` without looking up a wiki.
    - `gitSummary` for the data folder: ahead commits make the chip amber only when `Date.now() - status.unpushedSince > staleHours` (wiki chips unchanged); title "<n> commit(s) to push – TW Desk never pushes on its own".

- [ ] **Step 1: Write the failing e2e tests**:
  - `settings: move the data folder` – data folder `<root>/p/q/data` (env) with its own repo; wiki at `<root>/wikis/alpha` (three levels up → stored absolute). Move to `<root>/data2` → `<root>/data2/config.json` has `"../wikis/alpha"` (recomputed, now relative); `<root>/data2/.git` exists; `userData/data-folder.json` points to `<root>/data2`; after the confirm `<root>/p/q/data` is gone; Alpha still listed and startable.
  - `settings: move refuses a non-empty target` – error shown, nothing changed.
  - `header chip opens the data folder's Git tab` – data folder initialised with git (via `git init` helper), chip visible with `TW Desk data ⎇`; click → panel shows "TW Desk data" section with Commit.
  - `data folder inside another repository shows no repository` – `<root>` is a git repo, data folder `<root>/data` without `.git` → chip text contains `no repository`; *Initialize repository* → `<root>/data/.git` exists and the outer repo's `git status` doesn't list files inside `data` as staged/committed by TW Desk (outer `git log` has only its own commit).

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (no section/chip).

- [ ] **Step 3: Implement** the Produces list.

- [ ] **Step 4: Run** the spec, full e2e, `npm test`. Expected: pass (known 3 only).

- [ ] **Step 5: Commit** – `feat: data folder in Settings (move, use existing), header git chip and Git tab`

---

### Task 6: Auto-commit with generated messages; pause when behind; commit on quit

**Files:**
- Modify: `src/main.js`
- Test: `test/e2e/data-folder.spec.js`

**Interfaces:**
- Consumes: Task 1 `commitMessage`; Task 2 `ownRepo`; `git.status`, `git.commit(root, message)`.
- Produces:
  - `dataChanged(action?: string)` – pushes `action` to `pendingActions`, (re)starts the debounce timer (`Number(process.env.TW_DESK_DATA_COMMIT_DELAY) || 90000`).
  - `commitData(): Promise<boolean>` – no-op (false) unless git available, `dataDir` set and `ownRepo(dataDir)`. Reads `git.status(dataDir)`; skips (keeps `pendingActions`) when `behind > 0`, `merging`, `conflicts.length` or `detached`; otherwise `git.commit(dataDir, commitMessage(pendingActions, status.changed))`, clears `pendingActions` on success, `checkGit({ folders: [dataDir] })`. Errors are logged to the console and keep the actions.
  - The periodic/focus git check: when the data folder's status has `changedCount > 0` and no timer is pending, call `dataChanged()` (catches hand edits and anything not hooked).
  - On quit: in `before-quit`, if a timer is pending or `pendingActions.length`, `event.preventDefault()` once, `await Promise.race([commitData(), 10 s timeout])`, then `app.quit()` again (guarded so it happens once).
  - Action texts passed to `saveConfig(action)` / `dataChanged(action)` at these call sites: add wiki (`Added wiki <name>`), create wiki, remove wiki (`Removed wiki <name>`), save wiki (`Changed wiki <name>`), groups add/rename/remove (`Added group <n>` …), reorder wikis (`Reordered wikis`), save settings (`Changed settings`), plugin install/update (`Installed <title> <version>`), remove (`Removed <title> from the store`), move-to-store (`Moved <title> to the store`), `plugins-set-order` (`Reordered plugin cards`), folder description (`Described <folder name>`), web wiki add/remove/snapshot (`Added web wiki <name>`, `Removed web wiki <name>`, `Saved snapshot of <name>`), libraries add/remove (`Added library <url>`), setup import (`Imported setup`). Store/web changes that don't save config call `dataChanged(action)` directly.

- [ ] **Step 1: Write the failing e2e tests** (data folder `<root>/data` with its own repo made by `git init` + initial commit in the test; `options.env.TW_DESK_DATA_COMMIT_DELAY = "500"`):
  - `auto-commit after a change, with a readable message` – add a group "Work" and reorder plugin cards → `git log -1 --format=%s` polls to `Added group Work · Reordered plugin cards`; exactly one new commit.
  - `using the app makes no commit` – start and stop a wiki, collapse a group → after 2 s, `git log --oneline` count unchanged and `git status --porcelain` empty.
  - `quitting before the delay still commits` – `TW_DESK_DATA_COMMIT_DELAY = "600000"`; add a group; `desk.app.close()` → `git log -1 --format=%s` is `Added group Work`.
  - `no auto-commit while behind the remote` – bare remote with one extra commit fetched (`git fetch` in test, then trigger a git check via window focus or `checkGit` IPC used by the Fetch button); add a group → after 2 s no new commit, `git status` shows `config.json` modified; chip shows `↓1`.
  - `a hand edit is committed too` – edit `<data>/store/tw-desk-store.json` (or add a file) from the test, trigger a git check → commit with `TW Desk: setup changed (…)`.

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (no commits).

- [ ] **Step 3: Implement** the Produces list.

- [ ] **Step 4: Run** the spec, full e2e, `npm test`. Expected: pass (known 3 only).

- [ ] **Step 5: Commit** – `feat: auto-commit the data folder with generated messages`

---

### Task 7: Wikis not found – Locate…, bulk re-point banner

**Files:**
- Modify: `src/main.js`, `src/preload.js`, `src/renderer.js`, `src/index.html`, `src/styles.css`
- Test: `test/e2e/data-folder.spec.js`

**Interfaces:**
- Consumes: Task 1 `missingGroups`, `repointPlan`, `replacePrefix`.
- Produces:
  - Snapshot: `wikis[].missing = !fs.existsSync(wiki.path)`; `missingGroups` result as `state.missingGroups`.
  - `startWiki` throws "The folder of <name> wasn't found: <path>. Use ⋯ → Locate… to point TW Desk at it." for a missing wiki; the row shows `not found` in red instead of the status, Start disabled.
  - IPC `locate-wiki(id)` – folder picker; the folder must contain `tiddlywiki.info`; sets `wiki.path`, `saveConfig("Re-pointed wiki <name>")`.
  - IPC `repoint-preview(oldParent, newParent) -> [{ id, name, from, to, found }]` and `repoint-apply(oldParent, newParent)` – re-points the found ones, also `folderDescriptions` keys and `pluginsFolderOrder` entries via `replacePrefix`; `saveConfig("Re-pointed N wikis from <old> to <new>")`.
  - Banner above the wiki list per group: "<n> wikis were in <parent> – they're not there. [Where are they now?…]" → picker → `confirm()` listing found / not found names ("Found: a, b. Still not found: c.") → apply.
  - ⋯ menu of a missing wiki: **Locate…** (other entries that need the folder disabled).

- [ ] **Step 1: Write the failing e2e tests**:
  - `wikis that aren't found stay listed and can be re-pointed together` – config with three wikis at `<root>/old/{a,b,c}` (not existing) plus folder description for `<root>/old/a`; copy `alpha` to `<root>/new/a` and `<root>/new/b`; banner shows "3 wikis were in"; pick `<root>/new` → confirm text "Found: a, b. Still not found: c."; afterwards a and b have paths under `<root>/new`, c still `not found`, `folderDescriptions` key moved to `<root>/new/a`.
  - `locate a single wiki` – one missing wiki, ⋯ → Locate… → pick a copy → row no longer `not found`; picking a folder without `tiddlywiki.info` shows an error.
  - `a missing wiki can't be started` – Start disabled; row text `not found`.

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement** the Produces list.

- [ ] **Step 4: Run** the spec, full e2e, `npm test`. Expected: pass (known 3 only).

- [ ] **Step 5: Commit** – `feat: wikis not found: locate or re-point them together`

---

### Task 8: Docs and version

**Files:**
- Modify: `README.md` (new "Data folder" bullet near Git; Settings; note that `store/`/`web/` are now in the data folder – fix the `<userData>/…` mentions that moved), `CLAUDE.md` (layout entry `src/data-folder.js`; Decisions entry "Data folder (0.2.24)" with the split, path rule, auto-commit/no push, replace semantics; State 2026-11-10), `package.json` (`0.2.24`), `docs/superpowers/specs/2026-11-10-data-folder-design.md` (status: shipped in 0.2.24).

- [ ] **Step 1:** Update the files. `grep -n "userData\|%APPDATA%" README.md` and adjust every mention of config/store/web locations.
- [ ] **Step 2:** Run `NODE_PATH=… npm test` and the full headless e2e suite. Expected: unit all pass; e2e only the 3 known minimize failures.
- [ ] **Step 3: Commit** – `docs: data folder (0.2.24)`

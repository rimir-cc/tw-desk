# Binary tiddlers: deleting and updating – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At a policy run under *externalize*, delete files in `files/` whose tiddler was deleted, write new versions into the existing file (marker `tw-desk-update-of` or plain re-import), back up only what git doesn't hold, and guard against mass deletion.

**Architecture:** All file logic stays in the pure, synchronous `src/binaries.js` (`scanFolder` learns references, `applyPolicy` gets an `options` object and returns deletions, guard state and the new record). `src/git.js` gets one async query (`committedFiles`). `src/main.js` owns the record file in `<userData>/binaries/<id>.json`, runs the git query *before* the synchronous run (inside the binary queue, re-checking running/quitting after the await), logs, and exposes two IPC calls for the guard. The renderer shows the guard chip, tooltip counts and two ⋯ entries.

**Tech Stack:** Electron (main/preload/renderer, plain JS), Node `fs`, `node:test`, Playwright e2e, system git.

**Spec:** `docs/superpowers/specs/2026-11-05-binary-delete-update-design.md` (part 1: `2026-11-04-binary-tiddlers-design.md`; plugin interface: `2026-11-04-binary-tiddlers-interface.md`).

## Global Constraints

- Deletion and updates only for policy **externalize**; *leave*/*internalize* never delete or overwrite in `files/` and leave a marker field alone.
- Marker field: `tw-desk-update-of`, value `files/<name>` (the old `_canonical_uri`).
- Record: `<userData>/binaries/<wiki id>.json`, written only at policy runs (never by background scans); no record → the run only records.
- Backup path: `<userData>/backup/<timestamp>/<wiki folder name>/files/<name>`, `<timestamp>` = `new Date().toISOString().replace(/[:.]/g, "-")` (as `src/plugins.js`), one per run, created only when needed. Cross-drive: copy → verify → delete.
- "Git has it" = tracked in the repo that holds the wiki and unchanged against `HEAD`; any git error → backup.
- Mass-deletion guard: more than **10** candidates, or every file in the record (see Ruling R1) → delete nothing.
- Only regular files inside `files/` passing `confinedToFiles` are deleted or overwritten; never directories, never anything in `tiddlers/`.
- TW Desk never changes `modified`.
- Skip reasons (exact): `update marker and _canonical_uri together`, `update marker without new content`, `update marker outside files/`.
- Names in `files/` are compared case-insensitively on Windows/macOS (`process.platform` `win32`/`darwin`), case-sensitively elsewhere; stored with `/` separators, relative to `files/`.
- Tests never touch the user's real wikis or `%APPDATA%\TW Desk`. E2e only headless: `env -u WAYLAND_DISPLAY -u DISPLAY xvfb-run -a npx playwright test …`. Never `git stash` around test runs. Don't use ports 8080, 8090, 8091.
- Unit tests must pass on Windows: build paths with `path.join`, normalize CRLF when reading sources.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage files explicitly.

## Rulings made while planning

- **R1 (guard "all in use"):** the "every file that was in use" rule applies only when the record holds **3 or more** files; otherwise deleting the only binary of a small wiki would always need a manual OK. Cost if wrong: a two-file wiki whose `tiddlers/` vanished loses up to 2 files – recoverable from git or the backup.
- **R2 (git query timing):** `applyPolicy` stays synchronous; main computes `committedFiles` first, then re-checks `isRunningWiki`/`quitting` and runs synchronously.
- **R3 (incomplete scan):** the new record is then the old record ∪ the names found, so nothing is forgotten.

## Review Focus

1. A crash between writing the updated `.tid` and deleting the embedded binary + `.meta` (same title twice, embedded copy carries the marker) must be recovered at the next run, not reported as "two tiddler files". → Task 2 test `update: recovers a half-done update`.
2. Two embedded tiddlers in one run that both want the same implicit-overwrite name: only the first overwrites, the second gets a numbered name. → Task 2 test `update: implicit overwrite only once per name`.
3. A record entry whose file is gone (git clone without `files/`) or is a directory/symlink is neither deleted nor an error, and doesn't count toward the guard. → Task 3 test `delete: missing, directory and symlink entries are left alone`.
4. Upper/lower-case difference between record and `_canonical_uri` on Windows must not delete a file in use. → Task 3 test `delete: name matching follows the platform's case rule`.
5. Changing the wiki's folder or policy in Edit, then switching back, must not mass-delete. → Task 5 e2e step in `binaries: delete and update`.

---

### Task 1: References and file listing in `binaries.js`

**Files:**
- Modify: `src/binaries.js` (`scanFolder`, exports)
- Test: `test/unit/binaries.test.js`

**Interfaces:**
- Produces:
  - `scanFolder(folder, options?: { sub?: string = "tiddlers", optional?: boolean = false })` additionally returns `references: Map<key, { name: string, titles: string[] }>`, `complete: boolean`, `problems: string[]`. `key = nameKey(name)`.
  - `nameKey(name: string, caseInsensitive = process.platform === "win32" || process.platform === "darwin") -> string`.
  - `fileNameOfUri(uri: string) -> string | null` – decoded (`decodeUri`), `path.posix.normalize`d; returns the part after `files/` when the result starts with `files/`, has no `..` segment, no `\0`, isn't external (`isExternalUri`); else null. Backslashes count as separators.
  - `listFiles(folder) -> string[]` – regular files under `<folder>/files` (recursive, `/`-joined, relative to `files/`), skipping symlinks, directories and names ending in `.tw-desk-tmp`; `[]` when `files/` is missing.
  - `MARKER = "tw-desk-update-of"` exported.

Rules for references: every `.tid` (any type, also `$:/` titles), every `.meta`, and every tiddler in a `.json` file under `<folder>/<sub>` contributes its `_canonical_uri` and `tw-desk-update-of` values that pass `fileNameOfUri`. `complete` is false (with a `problems` entry naming the file/folder) when: a folder with `tiddlywiki.files` was skipped; a `.tid`/`.meta`/`.json` couldn't be read or parsed; or `<folder>/<sub>` is missing and `optional` is false. Existing `items`/`skipped`/sums don't change.

- [ ] **Step 1: Write the failing tests**

```js
test("references: .tid, .meta and .json, any type", () => {
	put("tiddlers/a.tid", "title: A\ntype: image/png\n_canonical_uri: files/a.png\n\n");
	put("tiddlers/b.png", Buffer.alloc(3));
	put("tiddlers/b.png.meta", "title: B\ntype: image/png\ntw-desk-update-of: files/old%20b.png\n");
	put("tiddlers/c.json", JSON.stringify([{ title: "C", type: "text/vnd.tiddlywiki", _canonical_uri: "files/sub/c.txt" }]));
	put("tiddlers/d.tid", "title: D\n_canonical_uri: https://example.com/files/x.png\n\n");
	put("tiddlers/e.tid", "title: E\n_canonical_uri: files/../tiddlers/x.png\n\n");
	const scan = binaries.scanFolder(dir);
	assert.equal(scan.complete, true);
	assert.deepEqual([...scan.references.values()].map(r => [r.name, r.titles]).sort(),
		[["a.png", ["A"]], ["old b.png", ["B"]], ["sub/c.txt", ["C"]]]);
});

test("references: incomplete scans", () => {
	assert.equal(binaries.scanFolder(dir).complete, false); // no tiddlers/
	assert.equal(binaries.scanFolder(dir, { sub: "plugins", optional: true }).complete, true);
	put("tiddlers/ok.tid", "title: ok\n\n");
	put("tiddlers/bundle/tiddlywiki.files", "{}");
	const scan = binaries.scanFolder(dir);
	assert.equal(scan.complete, false);
	assert.match(scan.problems[0], /tiddlywiki\.files/);
	fs.rmSync(path.join(dir, "tiddlers", "bundle"), { recursive: true });
	put("tiddlers/broken.json", "{");
	assert.equal(binaries.scanFolder(dir).complete, false);
});

test("fileNameOfUri and nameKey", () => {
	assert.equal(binaries.fileNameOfUri("files/a%23b.png"), "a#b.png");
	assert.equal(binaries.fileNameOfUri("files\\sub\\x.pdf"), "sub/x.pdf");
	assert.equal(binaries.fileNameOfUri("./files/x.pdf"), "x.pdf");
	for (const bad of ["files/", "files/../x", "other/x", "/files/x", "file:///x", "files/a\0b"]) {
		assert.equal(binaries.fileNameOfUri(bad), null, bad);
	}
	assert.equal(binaries.nameKey("A.PNG", true), "a.png");
	assert.equal(binaries.nameKey("A.PNG", false), "A.PNG");
});

test("listFiles: regular files only", () => {
	put("files/a.png", "x");
	put("files/sub/b.pdf", "x");
	put("files/c.png.tw-desk-tmp", "x");
	assert.deepEqual(binaries.listFiles(dir).sort(), ["a.png", "sub/b.pdf"]);
	assert.deepEqual(binaries.listFiles(path.join(dir, "none")), []);
});
```

- [ ] **Step 2: Run to verify they fail** – `npm test` → FAIL (`references` undefined / `fileNameOfUri is not a function`).
- [ ] **Step 3: Implement** in `src/binaries.js`. In `walk`, read `.meta` files for references before the `EXCLUDE` skip; `jsonHasBinary`'s parse is reused (one read per `.json`). Keep `scanTid`'s binary handling as it is; collect references before its type filter.
- [ ] **Step 4: Run** `npm test` → all PASS (the 76 existing tests unchanged).
- [ ] **Step 5: Commit** `git add src/binaries.js test/unit/binaries.test.js && git commit -m "Binaries: scan references to files/"`

---

### Task 2: Updates (explicit marker, implicit re-import) with backup

**Files:**
- Modify: `src/binaries.js` (`applyPolicy`, `externalize`, `recover`, new helpers)
- Test: `test/unit/binaries.test.js`

**Interfaces:**
- Consumes: Task 1 (`scanFolder().references/complete`, `fileNameOfUri`, `nameKey`, `MARKER`).
- Produces:
  - `applyPolicy(folder, policy, options?)` with `options = { record?: string[] | null = null, gitHas?: Set<string> = new Set() /* nameKeys */, backupDir?: string | null = null, outside?: { references: Map, complete: boolean, problems: string[] } | null = null, confirmDelete?: string[] | null = null, caseInsensitive?: boolean }`. Called without options it behaves exactly as part 1 except that marker handling applies.
  - result adds `updated` entries in `done`: `{ title, action: "updated", bytes, name, replaced: string | null, backup: string | null, reason: "marker" | "reimport" | "shared" }` (`replaced` = the overwritten file name, `backup` = absolute backup path or null; `"shared"` = the marker's file is used by another tiddler, written to a new numbered `name`, `replaced` null).
  - `backupFile(file, backupDir, name) -> string` (absolute target) – `rename`, on `EXDEV` copy → `verify` → unlink; creates folders; numbered ` (2)` on a clash inside the backup.

Behaviour (externalize only; with *internalize* a marker is ignored):
- Pre-scan references = `scanFolder(folder).references` ∪ `options.outside.references`; `complete` = both complete.
- Explicit update (embedded item whose fields have `MARKER`): checks in this order → skip reasons from Global Constraints (an externalized `.tid` with marker → `update marker and _canonical_uri together`; 0 bytes → `update marker without new content`; `fileNameOfUri` null or the path fails `filesPath` → `update marker outside files/`). Not complete → skip, reason `scan incomplete – update waits`. Target = marker name; if the type's extension differs from the target's, target = same stem + new extension (numbered on a clash with an existing file). If any title other than this tiddler references the target → numbered name via `fileNameFor` (`reason: "shared"`). Writing: temp → verify → if old exists: back up unless `gitHas` has its key → rename temp into place → write `.tid` with `_canonical_uri: uriFor(name)` and without `MARKER` → delete embedded.
- Implicit update (embedded, no marker): name from `safeName`; same content → reuse (part 1). Existing different file whose key is in `options.record`, not referenced (pre-scan) and not claimed earlier in this run, with `complete` true and `record` not null → overwrite as above (`reason: "reimport"`). Otherwise part 1 numbering.
- `recover` ignores `MARKER` in the embedded fields when comparing (crash after `.tid` write).

- [ ] **Step 1: Write the failing tests** (names and assertions):
  - `update: marker overwrites the same file and keeps the fields` – files/report.pdf (old bytes), tiddlers/report.pdf + .meta (`title: Report`, `type: application/pdf`, `tags: x`, `MARKER: files/report.pdf`, new bytes); `applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir })` → files/report.pdf has new bytes; `report.pdf.tid` fields `{ title: "Report", type: "application/pdf", tags: "x", _canonical_uri: "files/report.pdf" }` (no marker); `done[0]` partial `{ action: "updated", name: "report.pdf", replaced: "report.pdf", reason: "marker" }`; backup file at `path.join(backupDir, "report.pdf")` holds the old bytes.
  - `update: git has the old version → no backup` – same with `gitHas: new Set(["report.pdf"])` → `backup === null`, backupDir not created.
  - `update: new type gets the new extension` – marker `files/pic.png`, type `image/jpeg` → `name === "pic.jpg"`, files/pic.png still there (deleted in Task 3, not here).
  - `update: shared file is not overwritten` – a second `.tid` "Other" with `_canonical_uri: files/report.pdf` → `name === "report (2).pdf"`, `reason: "shared"`, files/report.pdf unchanged.
  - `update: odd markers are skipped` – the three Global-Constraint reasons, each leaving its files byte-identical.
  - `update: incomplete scan waits` – plus `tiddlers/bundle/tiddlywiki.files` → skipped `scan incomplete – update waits`.
  - `update: implicit overwrite on re-import` – files/report.pdf (old), embedded `report.pdf` + meta without marker, `record: ["report.pdf"]` → overwritten, `reason: "reimport"`; with `record: null` → `report (2).pdf`; with the name not in the record → `report (2).pdf`.
  - `update: implicit overwrite only once per name` – two embedded tiddlers "report.pdf" in different subfolders... use titles `Report` (file `a/report.pdf`) and `report.pdf` (file `b/report.pdf`), different bytes → one `reimport`, the other numbered.
  - `update: recovers a half-done update` – externalized `report.pdf.tid` (new uri, no marker) + embedded copy with marker and same bytes → `done[0].action === "recovered"`, embedded files gone.
  - `update: internalize ignores the marker` – policy internalize with a marker item → no change, no error.
- [ ] **Step 2: Run** `npm test` → the new tests FAIL.
- [ ] **Step 3: Implement** as described. Keep `externalize` readable: extract `writeIntoFiles(folder, name, bytes, { overwrite, gitHas, backupDir }) -> { backup }` used by both update kinds and the part 1 path.
- [ ] **Step 4: Run** `npm test` → all PASS.
- [ ] **Step 5: Commit** `git add src/binaries.js test/unit/binaries.test.js && git commit -m "Binaries: update files/ in place (marker and re-import)"`

---

### Task 3: Deletions, guard and the new record

**Files:**
- Modify: `src/binaries.js` (`applyPolicy` tail)
- Test: `test/unit/binaries.test.js`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces – `applyPolicy` result additionally (externalize only; for internalize all empty/null):
  - `deleted: [{ name, backup: string | null }]`
  - `pending: string[]` – candidates the guard held back (or that the user didn't confirm)
  - `guard: null | { reason: "many" | "all", count: number }`
  - `incomplete: string | null` – the first problem when the scan wasn't complete (then no deletions)
  - `record: string[] | null` – the new record to write (names); null for internalize.

Algorithm after updates/moves: rescan → `after` refs (tiddlers ∪ outside). If `record` is null → `record = names of tiddlers refs` (outside refs never recorded), nothing deleted. Else candidates = record names whose key isn't in `after`, whose file exists, is a regular file (`lstat`) and `confinedToFiles`. Entries whose file is missing/not regular are dropped from the record silently. If not complete → no deletions, `incomplete` set, new record = old record ∪ tiddlers refs (R3). If `confirmDelete` is an array → delete exactly candidates ∩ confirmDelete, rest pending. Else guard: `count > 10` → `many`; `count === record.length && record.length >= 3` → `all`; then nothing deleted, all pending. Else delete all. Each delete: `gitHas` has the key → unlink, else `backupFile`. A failed delete → `errors` entry `{ title: "files/" + name, message }`, name stays pending. New record = tiddlers refs (after) ∪ pending.

- [ ] **Step 1: Write the failing tests**:
  - `delete: a file whose tiddler was removed` – files/a.png, files/b.png, a.tid references a.png; `record: ["a.png", "b.png"]`, backupDir → `deleted` `[{ name: "b.png", backup: path.join(backupDir, "b.png") }]`, files/b.png gone, backup exists, `record` `["a.png"]`.
  - `delete: git has it → unlinked without backup` (`gitHas: new Set(["b.png"])`).
  - `delete: never-used files stay` – files/hand.png not in the record → untouched, not in `record`.
  - `delete: first run only records` – `record: null` → nothing deleted, `record` = referenced names.
  - `delete: outside references protect but aren't recorded` – `outside` refs contain b.png → kept, `record` excludes b.png.
  - `delete: incomplete scan deletes nothing` – plus `tiddlywiki.files` folder → `incomplete` matches /tiddlywiki\.files/, files kept, `record` ⊇ old record.
  - `delete: guard – more than 10` – 11 orphaned names → `guard: { reason: "many", count: 11 }`, `pending` has 11, nothing deleted, `record` includes them; with `confirmDelete` of 2 names → exactly those 2 deleted, 9 pending.
  - `delete: guard – every file in use` – record of 3, all orphaned → `reason: "all"`; record of 2, both orphaned → both deleted (R1).
  - `delete: missing, directory and symlink entries are left alone` (symlink part skipped on Windows via `t.skip` when `fs.symlinkSync` throws, as the existing symlink test does).
  - `delete: name matching follows the platform's case rule` – `.tid` with `_canonical_uri: files/Photo.PNG`, file `files/photo.png`, record `["photo.png"]`, `caseInsensitive: true` → kept; `caseInsensitive: false` → deleted.
  - `delete: an updated file's old extension goes` – Task 2's png→jpg case with `record: ["pic.png"]` → files/pic.png deleted in the same run.
  - `delete: internalize never deletes` – policy internalize with a record → `deleted` empty, `record` null.
- [ ] **Step 2: Run** `npm test` → new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → all PASS.
- [ ] **Step 5: Commit** `git add src/binaries.js test/unit/binaries.test.js && git commit -m "Binaries: delete files whose tiddler was removed, with a mass-deletion guard"`

---

### Task 4: `git.committedFiles`

**Files:**
- Modify: `src/git.js`
- Test: `test/unit/git.test.js`

**Interfaces:**
- Produces: `committedFiles(folder: string) -> Promise<Set<string>>` – names (relative to `<folder>/files`, `/`-separated, exactly as git prints them; main maps them through `binaries.nameKey`) of files tracked and unchanged against `HEAD`: `git ls-files -z -- files/` minus `git diff --name-only -z --relative HEAD -- files/`, both with `cwd = folder`. Any error (no repo, no commits, no git) → empty set.

- [ ] **Step 1: Write the failing test** `committedFiles: tracked and unchanged only` (`{ skip }`): init a `folder("cf")` with `files/a.png`, `files/sub/b.png`, commit; then modify `files/sub/b.png`, add untracked `files/c.png`, stage new `files/d.png` → `[...set].sort()` equals `["a.png"]`; a plain folder without repo → empty set.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** with the existing `git()` helper; strip the leading `files/`.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `git add src/git.js test/unit/git.test.js && git commit -m "Git: files under files/ that HEAD holds unchanged"`

---

### Task 5: Main process, UI and e2e

**Files:**
- Modify: `src/main.js` (binary section, `save-wiki`, `remove-wiki`, `delete-wiki`, `scanWikiBinaries`), `src/preload.js`, `src/renderer.js` (`binaryChip`, `wikiMenu`)
- Test: `test/e2e/binaries.spec.js`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - main: `recordFile(id)`, `readRecord(wiki) -> { inUse: string[], pending: string[] } | null` (null when missing, unreadable, or its `folder` ≠ `folderKey(wiki.path)`), `writeRecord(wiki, inUse, pending)` (JSON `{ folder, inUse, pending }`, written via temp + rename), `dropRecord(id)`.
  - IPC `binaries-delete-unused(id, names: string[])` → same refusals as `binaries-apply`, then `applyBinaryPolicy(wiki, { confirmDelete: names })`; IPC `binaries-keep(id)` → removes `pending` from the record (keeps `inUse` minus pending), rescans.
  - preload: `window.twDesk.binaries.deleteUnused(id, names)`, `.keep(id)`.
  - scan summary gains `pending: string[]` (from the record) and `unused: number` (= `listFiles` minus tiddlers references minus record names; only when the policy is externalize, else 0).

Main wiring in `applyBinaryPolicy(wiki, extra = {})`:
- externalize: `gitHas` from `await git.committedFiles(path.resolve(current.path))` mapped through `binaries.nameKey`; then re-check `config`/`quitting`/`isRunningWiki` (R2). `outside` = merged `scanFolder(include.resolved)` for each existing include ∪ `scanFolder(folder, { sub: "plugins", optional: true })`. `record = readRecord(current)?.inUse ∪ pending` (or null), `backupDir = path.join(userData, "backup", stamp, path.basename(path.resolve(current.path)), "files")`. Afterwards `writeRecord(current, result.record minus result.pending, result.pending)`.
- internalize run → `dropRecord`. `save-wiki`: when the policy or `folderKey(path)` changes → `dropRecord`. `remove-wiki` / `delete-wiki` → `dropRecord`.
- Log lines (in `logBinaryResult`, exact):
  - `Updated files/<name>` (marker), `Updated files/<name> (re-imported “<title>”)`, `Updated “<title>” into files/<name> – files/<old> is still used by another tiddler`
  - `Deleted files/<name> – its tiddler was removed`
  - `Backed up files/<name> to <backup path>`
  - guard: `Not deleting <n> unused files: more than 10 at once – use ⋯ › Delete <n> unused files…` / `Not deleting <n> unused files: that would be every file in use – use ⋯ › Delete <n> unused files…`
  - incomplete: `No files deleted: <problem>`
- Renderer:
  - chip precedence: embedded → `▣ N embedded · size`; else pending > 0 → `▣ N files to delete` (warn); else missing → part 1 text.
  - tooltip lines added: `Files to delete (needs your OK): N` when pending; `Unused files in files/: N (never deleted automatically)` when unused > 0; last run line also counts `updated` and `deleted`.
  - ⋯ entries after "Apply binary policy now", only when pending > 0: `Delete N unused files…` (`confirm()` listing up to 20 names, `files/<name>` per line, then `…and N more`) and `Keep these files` (no confirm). Both disabled while running (`title: "Stop the wiki first"`).

- [ ] **Step 1: Write the failing e2e tests** in `test/e2e/binaries.spec.js`, using `putBinary` and the ⋯ menu:
  - `binaries: delete and update` – launch Alpha (externalize) with photo.png + report.pdf binaries → start-up run externalizes both. Delete `tiddlers/photo.png.tid` on disk; ⋯ Apply → `files/photo.png` gone; Log contains `Deleted files/photo.png – its tiddler was removed`. Write `tiddlers/report.pdf` (new bytes) + `.meta` with `title: Report`, `type: application/pdf`, `tw-desk-update-of: files/report.pdf`, delete `report.pdf.tid`; Apply → `files/report.pdf` has the new bytes, `report.pdf.tid` contains `_canonical_uri: files/report.pdf` and not `tw-desk-update-of`; Log contains `Updated files/report.pdf`; a backup exists under `<userData>/backup/*/alpha/files/` (wiki is not a git repo) – use the fixture's user-data dir. Review Focus 5: Edit → policy *leave as is* → save; Edit → *externalize* → save; remove all `.tid`s; Apply → nothing deleted (record was dropped, first run only records).
  - `binaries: guard asks before deleting many files` – 12 binaries externalized at start, delete all 12 `.tid`s, Apply → chip `▣ 12 files to delete`; ⋯ `Delete 12 unused files…` (accept the dialog via `page.once("dialog", d => d.accept())`) → files/ empty, chip gone. Second half: repeat with 12 again, ⋯ `Keep these files` → chip gone, files stay, tooltip contains `Unused files in files/: 12`.
- [ ] **Step 2: Run** `env -u WAYLAND_DISPLAY -u DISPLAY xvfb-run -a npx playwright test test/e2e/binaries.spec.js` → the two new tests FAIL.
- [ ] **Step 3: Implement** main, preload, renderer as above.
- [ ] **Step 4: Run** the same command → all 6 binaries tests PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `git add src/main.js src/preload.js src/renderer.js test/e2e/binaries.spec.js && git commit -m "Binaries: delete and update in the app, guard chip and menu"`

---

### Task 6: Docs and version 0.2.22

**Files:**
- Modify: `README.md` (Binary tiddlers bullet), `CLAUDE.md` (binary decisions bullet, State), `package.json` + `package-lock.json` (version `0.2.22`), spec status line (`Status: shipped in 0.2.22`).

- [ ] **Step 1:** README: one or two sentences – deleting a binary tiddler deletes its file at the next stop, dropping a new version (drop-attach) or re-importing replaces the file under the same name, files git doesn't hold are first backed up to `<userData>/backup/…`, more than 10 deletions at once need a click. Externalize only.
- [ ] **Step 2:** CLAUDE.md: extend the binary-tiddlers decision bullet with record file, marker, backup rule, guard (incl. R1); State → 0.2.22.
- [ ] **Step 3:** `npm version 0.2.22 --no-git-tag-version`; `npm test` → PASS.
- [ ] **Step 4: Commit** `git add README.md CLAUDE.md package.json package-lock.json docs/superpowers/specs/2026-11-05-binary-delete-update-design.md && git commit -m "Binary tiddlers: deleting and updating (0.2.22)"`

# Binary tiddlers, part 1 (scan, policy, externalize/internalize) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TW Desk finds binary tiddlers stored inside each wiki, shows them per row, and – per wiki policy – moves them
into `files/` (`_canonical_uri`) or back, automatically when the wiki stops and at TW Desk start.

**Architecture:** A new pure module `src/binaries.js` (fs only, no Electron) scans a wiki folder's `tiddlers/` and
applies a policy with crash-safe file moves. `src/main.js` keeps per-wiki settings in `config.json`, runs scans on a
timer and after stops, applies the policy in `afterStop` (before auto-commit) and before autostart, and pushes a scan
summary in the state. The renderer shows a chip, Edit-dialog fields and a ⋯ menu entry.

**Tech Stack:** Electron 45 main process, plain JS (tabs, double quotes), Node test runner, Playwright e2e, bundled
TiddlyWiki 5.4.1 for test checks.

**Spec:** `docs/superpowers/specs/2026-11-04-binary-tiddlers-design.md` (part 1 = "Suggested order" step 1; goals 1–3,
anti-goals, constraints, Claude's calls). Interface for plugins: `docs/superpowers/specs/2026-11-04-binary-tiddlers-interface.md`
("The original tiddler").

## Global Constraints

- Never touch a running wiki's files: apply only when the wiki's status is `stopped` or `error` (no child process).
- Never delete or overwrite content before the new copy is written and verified (size + sha256).
- All fields except `text` stay byte-identical (title, type, tags, created, **modified not bumped**, caption, custom).
- Externalized form = `.tid` file with all fields, `_canonical_uri: files/<name>`, empty text (what TiddlyWiki's own
  filesystem adaptor writes for a tiddler with `_canonical_uri`). Embedded form written by internalize = binary file +
  `.meta` (what the adaptor writes for base64 types).
- "Binary" = TiddlyWiki 5.4.1 types with encoding `base64` (boot.js `registerFileType`); `image/svg+xml` is utf8 → not binary.
- System tiddlers (`$:/…`) are never touched. Only the wiki's own `tiddlers/` is changed; included folders are scanned
  for the report only.
- A managed wiki that another managed wiki includes is not changed (report only, reason shown).
- `files/` git setting per wiki: `filesInGit: true` (default, nothing special) or `false` (append `files/` to the wiki
  folder's `.gitignore`; never `git rm --cached`).
- Policy never runs while quitting; it runs after a stop (before auto-commit) and at TW Desk start before autostart.
- Default policy for every wiki: `leave`. Code style per CLAUDE.md; tests never use the user's wikis.
- Unit tests need TiddlyWiki: `NODE_PATH=<folder with node_modules/tiddlywiki 5.4.1> npm test` (e.g.
  `npm install --prefix /tmp/twmods tiddlywiki@5.4.1`, then `NODE_PATH=/tmp/twmods/node_modules`).

## Review Focus

1. Titles with characters illegal in Windows file names, trailing dots/spaces, or very long titles → a safe file name
   in `files/` (Task 2 test `fileNameFor: unsafe and long titles`).
2. Two different binaries whose titles map to the same file name → second gets a suffix, nothing overwritten; an
   identical file is reused (Task 2 test `fileNameFor: clash and reuse`).
3. A move interrupted half-way (both forms on disk for one title) → completed on the next run, never lost (Task 3
   test `recovers a half-done externalize and internalize`).
4. A clone where `files/<name>` is missing → scan reports "missing", internalize skips it, nothing is deleted (Task 1
   test `externalized with missing file`, Task 3 test `internalize skips missing files`).
5. Fields survive exactly: tags with spaces, custom fields, `modified`, `created` – checked by loading the result with
   the bundled TiddlyWiki (Task 3 test `TiddlyWiki loads the same fields after externalize and internalize`).

---

### Task 1: Scan a wiki folder

**Files:**
- Create: `src/binaries.js`
- Test: `test/unit/binaries.test.js`

**Interfaces:**
- Produces:
  - `BASE64_TYPES: Set<string>` and `extensionFor(type) -> string` (e.g. `"image/png" -> ".png"`, first extension of the
    TW registration), `typeForExtension(ext) -> string|null`.
  - `parseFields(text) -> { fields: object, body: string }` – `.tid` / `.meta` header parser (header ends at first empty
    line; `.meta` has no body). Keeps field order.
  - `serializeFields(fields, body?) -> string` – `title` first, then the other fields in their order, `key: value`
    lines; with `body` an empty line and the body.
  - `fieldsSafe(fields) -> boolean` – false if a non-text value has control chars or leading/trailing whitespace, or a
    field name contains `:` or `#` (same rule as TW's `generateTiddlerFileInfo`).
  - `scanFolder(folder) -> Scan`:
    ```
    Scan = { folder, embedded: { count, bytes }, externalized: { count, bytes, missing },
             items: Item[], skipped: { file, reason }[] }
    Item = { title, type, state: "embedded"|"externalized", form: "file"|"tid",
             file, meta /* abs path or null */, uri /* externalized only */, bytes, missing /* externalized only */ }
    ```

- [ ] **Step 1: Write the failing tests** in `test/unit/binaries.test.js` (temp folders via `tw.tempDir`, files written by hand):
  - `scan: binary file with .meta` – `tiddlers/photo.png` (100 bytes) + `photo.png.meta` (`title: Photo`, `type: image/png`, `tags: [[a b]]`)
    → one item `{ title: "Photo", state: "embedded", form: "file", bytes: 100 }`, `embedded = { count: 1, bytes: 100 }`.
  - `scan: binary file without .meta` – `tiddlers/doc.pdf` → title `doc.pdf`, type `application/pdf`.
  - `scan: base64 in a .tid` – `.tid` with `type: image/png` and base64 body of 30 bytes → `form: "tid"`, `bytes: 30` (decoded size).
  - `scan: externalized` – `.tid` with `type: image/png`, `_canonical_uri: files/x.png`, `files/x.png` of 50 bytes → `externalized = { count: 1, bytes: 50, missing: 0 }`.
  - `scan: externalized with missing file` – same without `files/x.png` → `missing: 1`, item `missing: true`.
  - `scan: ignored` – `$__favicon.ico` + meta `title: $:/favicon.ico`, an svg, a text `.tid`, a `.tid` with `_canonical_uri: https://…`
    → no items; a subfolder with `tiddlywiki.files` → `skipped` entry with reason `"tiddlywiki.files"`; a `.json` file
    holding a base64 tiddler → `skipped` reason `"json"`.
  - `parseFields/serializeFields round trip` and `fieldsSafe` (value `" x"` → false, `a:b` name → false).
- [ ] **Step 2: Run** `NODE_PATH=… node --test test/unit/binaries.test.js` – Expected: FAIL (`Cannot find module '../../src/binaries'`).
- [ ] **Step 3: Implement** the Produces list in `src/binaries.js`. Walk `tiddlers/` recursively (skip `.git`, names
  matching TW's `$tw.boot.excludeRegExp` incl. `*.meta`). Copy the base64 registrations from TW 5.4.1 `boot/boot.js`
  lines 2476–2515 into a table `[type, extensions]`. `bytes` from `fs.statSync` for files, decoded length for base64 bodies.
- [ ] **Step 4: Run** the test file – Expected: PASS.
- [ ] **Step 5: Commit** `git add src/binaries.js test/unit/binaries.test.js && git commit -m "Binaries: scan wiki folders for binary tiddlers"` (+ Co-Authored-By line).

### Task 2: File names in files/

**Files:**
- Modify: `src/binaries.js`
- Test: `test/unit/binaries.test.js`

**Interfaces:**
- Produces: `fileNameFor(title, type, filesDir, sha256) -> { name, reuse: boolean }` – `name` relative to `filesDir`.

- [ ] **Step 1: Write the failing tests:**
  - `fileNameFor: unsafe and long titles` – `"a<b>:c?.png"` → `"a_b__c_.png"`; `"Report. "` (type pdf) → `"Report.pdf"`
    (trailing dots/spaces trimmed before the extension); a 300-char title → name ≤ 120 chars, still ends `.pdf`;
    `"photo"` (png) → `"photo.png"`; `"photo.PNG"` (png) keeps `"photo.PNG"` (extension already matches, case-insensitive).
  - `fileNameFor: clash and reuse` – existing `files/photo.png` with other content → `"photo (2).png"`, `reuse: false`;
    existing with the same sha256 → `"photo.png"`, `reuse: true`.
- [ ] **Step 2: Run** – Expected: FAIL (`fileNameFor is not a function`).
- [ ] **Step 3: Implement** – replace `<>:"/\|?*` and control chars with `_`, trim, cut the stem so stem + extension ≤ 120,
  empty stem → `"file"`. Compare an existing file by sha256 of its content.
- [ ] **Step 4: Run** – Expected: PASS.
- [ ] **Step 5: Commit** `"Binaries: safe file names in files/"`.

### Task 3: Apply a policy (externalize / internalize) with recovery

**Files:**
- Modify: `src/binaries.js`
- Modify: `test/helpers/tw.js` (add `loadTiddler`)
- Test: `test/unit/binaries.test.js`

**Interfaces:**
- Consumes: `scanFolder`, `fileNameFor`, `parseFields`, `serializeFields`, `fieldsSafe`, `extensionFor`.
- Produces:
  - `applyPolicy(folder, policy /* "externalize"|"internalize" */) -> Result`
    `Result = { done: { title, action: "externalized"|"internalized"|"recovered", bytes }[], skipped: { title, reason }[], errors: { title, message }[] }`
    Errors on one item never stop the others; nothing is thrown for item errors.
  - `test/helpers/tw.js`: `loadTiddler(folder, title) -> object` – renders `[[title]]` with
    `$:/core/templates/json-tiddler` via `tiddlywiki([folder, "--render", …, "text/plain", "$:/core/templates/json-tiddler"])`
    and returns the parsed fields.

Steps per item (the order is the safety guarantee; write temp files as `<target>.tw-desk-tmp` then `fs.renameSync`):
- **externalize, form file:** read bytes → `fileNameFor` → write `files/<name>` unless `reuse` → verify size + sha256 →
  write `<file>.tid` (fields from `.meta`, or `title`/`type` from the file name; plus `_canonical_uri: files/<name>`;
  empty body) → delete the binary and its `.meta`. If `<file>.tid` already exists → error, nothing changed.
- **externalize, form tid:** decode body → same file steps → rewrite the same `.tid` with `_canonical_uri` and empty body.
- **internalize** (externalized items only, `uri` under `files/`): missing file → skipped `"file not on this machine"`;
  target binary = `.tid` path without `.tid` if it already ends with `extensionFor(type)` (case-insensitive), else
  `<safe title><ext>` next to it; target exists → error. Write binary → verify → write `<binary>.meta` (all fields except
  `_canonical_uri` and `text`) → delete the `.tid`. The file in `files/` is kept.
- Unsafe fields (`fieldsSafe` false) → skipped `"fields can't be written to a .tid/.meta file"`.
- **Recovery first:** the same title found as both an embedded item and an externalized item whose `files/` file has the
  same sha256 as the embedded content → keep the form the policy wants, delete the other (action `"recovered"`);
  different content → error `"two tiddler files with this title"`, both left.

- [ ] **Step 1: Write the failing tests:**
  - `externalize a binary file with .meta` – after `applyPolicy(folder, "externalize")`: `files/photo.png` bytes equal the
    original; `tiddlers/photo.png` and `.meta` gone; `tiddlers/photo.png.tid` has `_canonical_uri: files/photo.png`;
    `result.done = [{ title: "Photo", action: "externalized", bytes: 100 }]`.
  - `externalize base64 in a .tid` – same `.tid` path now has `_canonical_uri` and empty body; `files/` holds the decoded bytes.
  - `internalize back` – result has binary + `.meta` again, `.tid` gone, `files/photo.png` still there.
  - `internalize skips missing files` – `skipped = [{ title, reason: "file not on this machine" }]`, `.tid` unchanged.
  - `recovers a half-done externalize and internalize` – folder with both `photo.png`+meta and `photo.png.tid` (same
    content in `files/`): externalize → binary gone, action `"recovered"`; same setup, internalize → `.tid` gone.
    With different content → `errors[0].message` contains `"two tiddler files"`, all files still there.
  - `TiddlyWiki loads the same fields after externalize and internalize` – wiki from `tw.initWiki`, binary with meta
    `tags: [[a b]] c`, `created: 20260101000000000`, `modified: 20260102000000000`, `caption: Cap`, `custom: x`.
    `tw.loadTiddler` before, after externalize (expect same fields + `_canonical_uri`, `text` empty) and after
    internalize (expect identical to before, `text` equal).
  - `system tiddlers and unsafe fields are skipped` – `$:/favicon.ico` untouched; a `.meta` with a field `x: " y"`
    → skipped with the reason above.
- [ ] **Step 2: Run** – Expected: FAIL.
- [ ] **Step 3: Implement** `applyPolicy` and `loadTiddler` as specified above.
- [ ] **Step 4: Run** `NODE_PATH=… npm test` (all unit tests) – Expected: PASS.
- [ ] **Step 5: Commit** `"Binaries: externalize and internalize with crash-safe moves"`.

### Task 4: Keep files/ out of git

**Files:**
- Modify: `src/git.js` (export `ensureIgnored`)
- Test: `test/unit/git.test.js`

**Interfaces:**
- Produces: `git.ensureIgnored(folder, line) -> boolean` – appends `line` to `<folder>/.gitignore` (creates it; adds a
  newline first if the file doesn't end with one); returns false when the exact line is already there. Plain fs, no git call.

- [ ] **Step 1: Write the failing test** `ensureIgnored: appends once` – missing file → created with `"files/\n"`, returns true;
  second call → false, unchanged; existing `"output/"` without newline → `"output/\nfiles/\n"`. Also with a real repo
  (skip without git): after `ensureIgnored` a new `files/x.png` is not in `git status --porcelain`.
- [ ] **Step 2: Run** `NODE_PATH=… node --test test/unit/git.test.js` – Expected: FAIL.
- [ ] **Step 3: Implement** in `src/git.js`.
- [ ] **Step 4: Run** – Expected: PASS.
- [ ] **Step 5: Commit** `"Git: add a line to a folder's .gitignore"`.

### Task 5: Main process – settings, scans, policy on stop and at start

**Files:**
- Modify: `src/main.js` (wikiFromInput ~154, snapshot ~201, afterStop ~737, app.whenReady ~2393, runImport ~2235,
  new section `// ---------- binary tiddlers ----------` after the git section)
- Modify: `src/setup.js:64` (export key list) and its import counterpart
- Modify: `src/preload.js` (add `binaries`)
- Test: `test/unit/setup.test.js`

**Interfaces:**
- Consumes: `binaries.scanFolder`, `binaries.applyPolicy`, `git.ensureIgnored`.
- Produces (for Task 6):
  - wiki config field `binaries: { policy: "leave"|"externalize"|"internalize", filesInGit: boolean }`; missing = `{ policy: "leave", filesInGit: true }`.
    `wikiFromInput` validates `input.binaries` (unknown policy → error `"Unknown binary policy"`).
  - In `snapshot().wikis[i]`: `binaries` (settings, defaults filled) and `binaryScan`:
    `{ embedded: { count, bytes }, externalized: { count, bytes, missing }, skipped: number, includes: { embedded: { count, bytes } }, blockedBy: string[] /* names of managed wikis including this one */, lastResult: { done, skipped, errors } | null, scannedAt, error }`.
  - IPC `binaries-apply` (id) → runs the policy now (rejects with `"Stop the wiki first."` while running, `"Policy is
    \"leave as is\"."` for leave), `binaries-scan` (id or none) → rescans. Preload: `window.twDesk.binaries.apply(id)`, `.scan(id)`.

- [ ] **Step 1: Write the failing test** in `test/unit/setup.test.js`: `export keeps the binary settings` – a wiki with
  `binaries: { policy: "externalize", filesInGit: false }` is exported with that object and `planImport` carries it to the
  planned wiki.
- [ ] **Step 2: Run** – Expected: FAIL.
- [ ] **Step 3: Implement** in `setup.js` (add `"binaries"` to the copied keys) and in `runImport` (copy `entry.binaries` through the same validation as `wikiFromInput`).
- [ ] **Step 4: Run** – Expected: PASS.
- [ ] **Step 5: Implement the main-process wiring** in `src/main.js`:
  - `binaryScans` Map (wiki id → summary), `binaryQueue` promise chain (like `gitQueue`); `scanBinaries(ids?)` scans each
    wiki folder and its existing includes (summed into `includes`), sets `blockedBy` from the other managed wikis'
    `readIncludes` (compare with `folderKey`), then `pushState()`.
  - Timer: `BINARY_SCAN_INTERVAL = 10 * 60 * 1000`; scan all at start, after every stop, after `save-wiki`, after apply.
  - `applyBinaryPolicy(wiki) -> Result|null` (queued): returns null for `leave`, for a running/starting wiki, and when
    `blockedBy` is non-empty (logs `"Binary policy not applied: included by <names>"` once per run). For `externalize`
    with `filesInGit === false` call `git.ensureIgnored(wiki.path, "files/")` and log it when it returns true. Log a
    summary line to the wiki's Log, e.g. `"Externalized 12 binary tiddlers (48 MB) into files/"`, plus one line per error/skip.
  - `afterStop(wiki)`: `await applyBinaryPolicy(wiki)` **before** the auto-commit block.
  - `app.whenReady`: after `createManagerWindow()`, apply the policy for every wiki (sequentially, errors logged), then
    run the existing autostart loop.
- [ ] **Step 6: Verify** `NODE_PATH=… npm test` – Expected: PASS. (Electron wiring is verified in Task 6's e2e.)
- [ ] **Step 7: Commit** `"Binaries: per-wiki policy, scans and applying it on stop and at start"`.

### Task 6: UI – chip, Edit dialog, menu, e2e, docs, version

**Files:**
- Modify: `src/index.html` (Edit dialog, after the link-name label), `src/renderer.js` (openDialog ~928, submit ~1005,
  wikiItem ~141, wikiMenu ~234), `src/styles.css` (only if the chip needs it – reuse `.git-chip`)
- Modify: `README.md` (new bullet *Binary tiddlers* under Use), `CLAUDE.md` (layout line for `src/binaries.js`, a
  "Decisions" bullet summarizing the Global Constraints), `package.json` version `0.2.21`
- Create: `test/e2e/binaries.spec.js`

**Interfaces:**
- Consumes: Task 5's `binaries` / `binaryScan` state, `window.twDesk.binaries.apply/scan`.
- Produces (UI copy, exact):
  - Edit dialog: select `binaryPolicy` labelled *Binary tiddlers* with options *Leave as is* / *Externalize into files/* /
    *Internalize from files/*; checkbox `filesInGit` *Commit files/ with the wiki* (checked by default); hint
    *Applied when the wiki stops and when TW Desk starts. Files already in git stay there.*
  - Row chip (class `git-chip binary-chip`, `warn` when embedded count > 0 and policy is externalize, or missing > 0):
    `▣ <n> embedded · <size>` (embedded > 0), else `▣ <n> files missing` (missing > 0), else no chip. Size format:
    `formatBytes(n)` → `"950 KB"`, `"4.2 MB"`, `"48 MB"`, `"1.3 GB"` (one decimal below 10). Tooltip: externalized count
    and size, included folders' embedded count, policy, `blockedBy` reason, last result counts.
  - ⋯ menu entry *Apply binary policy now* (disabled while running/starting or policy *leave*) → `binaries.apply`.

- [ ] **Step 1: Write the failing e2e tests** in `test/e2e/binaries.spec.js` (see `git.spec.js` for the fixture style):
  - `binaries: externalize on stop` – copy of `alpha` with `tiddlers/photo.png` (+ `.meta` title `Photo`), launched with
    `binaries: { policy: "externalize", filesInGit: true }`. The start-up run externalizes it: after launch
    `files/photo.png` exists, `tiddlers/photo.png.tid` has `_canonical_uri`, no chip. Start the wiki, put a second binary
    (`scan.png` + `.meta`) into `tiddlers/`, stop → it is externalized too; `.gitignore` doesn't contain `files/`.
  - `binaries: chip with policy "leave"` – same copy with the default policy and a 2,000-byte
    `photo.png` → chip `▣ 1 embedded · 2 KB`; nothing moved after a start/stop.
  - `binaries: keep out of git, internalize, refused while running` – Edit: uncheck *Commit files/…*, policy externalize,
    save; *Apply binary policy now* → `.gitignore` gets `files/`. Start the wiki → menu entry disabled. Stop; Edit →
    internalize; after the stop/apply the binary + `.meta` are back and `files/photo.png` still exists.
  - `binaries: an included wiki is only reported` – `shared` included by `alpha`, `shared` managed too with policy
    externalize and a binary → nothing moved, Log contains `"included by Alpha"`.
- [ ] **Step 2: Implement** the UI per the Produces block.
- [ ] **Step 3: Verify** – the user runs `npm run test:e2e` on Windows (not possible in WSL); Expected: all specs pass.
  Locally run `NODE_PATH=… npm test` – Expected: PASS, and `node --check src/renderer.js src/main.js`.
- [ ] **Step 4: Docs and version** – README bullet, CLAUDE.md layout + decisions, `package.json` `0.2.21`.
- [ ] **Step 5: Commit** `"Binary tiddlers: externalize/internalize per wiki (0.2.21)"`.

# TW Desk – notes for Claude

Electron app (Windows) that manages local TiddlyWiki **folder wikis**: start/stop one TiddlyWiki server per wiki,
open wikis in app windows, edit `includeWikis`, and manage plugins via a shared store and plugin libraries.
TiddlyWiki is bundled (pinned in `package.json`, currently 5.4.1). User-facing docs: `README.md`.

The user's wikis live in `C:\data\22-tiddlydesktop\wikis\` (`orga`, `priv-orga`, `_shared`; `orga`, `priv-orga`
and `_shared` are separate git repos). `orga` and `priv-orga` include `../_shared`. **Never test against these
folders** – use copies (see Testing).

## Layout

- `src/main.js` – main process: config (`%APPDATA%\TW Desk\config.json`), server lifecycle, wiki windows,
  `includeWikis` read/write, plugin IPC, `knownFolders()` (managed wikis + folders they include).
- `src/tw-process.js` – entry of each TiddlyWiki utility process; args come as JSON in `TW_DESK_ARGS`.
- `src/plugins.js` – plugin store, bundled-plugin listing, library access (standard + CPL), update checks,
  per-folder `tiddlywiki.info` plugin lists, moving wiki-stored plugins into the store.
- `src/git.js` – git via the system `git` (no prompts: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`), status from
  `status --porcelain=v2 -z`; `src/git-ui.js` – git chips, Git tab of the bottom panel, footer line.
- `src/web.js` – tiddlers and per-tiddler hashes of a single-file wiki's HTML (web wiki snapshots and change checks).
- `src/preload.js` – `window.twDesk` API (contextBridge); `window.twDesk.plugins.*` for the plugins window.
- `src/renderer.js` + `index.html` + `styles.css` – manager UI; `src/plugins-ui.js` – Plugins window
  (shares globals `$`, `api`, `run`, `cleanError`, `folderName` from renderer.js).
- `build/installer.nsh` – forces per-user install in the assisted NSIS installer.
- `scripts/cdp.mjs` – DevTools helper for testing (see below).

## Decisions and why (don't undo without reason)

- **Servers run via `utilityProcess.fork`**, not `spawn(process.execPath)` with `ELECTRON_RUN_AS_NODE`:
  the latter crashed for the user with an ICU data error (exit code 2147483651). Utility processes don't
  exit on their own, so `tw-process.js` calls `process.exit` after one-off commands like `--init`.
- **No `asarUnpack` of TiddlyWiki.** Unpacking produced ~8,800 installed files, ~90 with paths > 260 chars;
  the NSIS uninstaller can't move those, so every update failed ("TW Desk kann nicht geschlossen werden").
  TiddlyWiki reads fine from `app.asar` in utility processes. Install is now ~73 files. Updates from
  0.1.5 or older still need the install folder deleted manually (documented in README).
- **Installer**: assisted (wizard) per-user NSIS, `allowToChangeInstallationDirectory`; existing installs
  sit in `%LOCALAPPDATA%\Programs\tw-desk\TW Desk`. Not code-signed. Portable target was dropped
  (unpacked 124 MB on every start, ~2 minutes).
- **Plugin store lives in `%APPDATA%\TW Desk\store`**, never in the install folder (the uninstaller deletes
  that on every update). Layout `store/plugins/<author>/<name>/` (`plugin.info` + `tiddlers.json`),
  `store/themes/...`, `store/languages/<name>/`. Passed to TiddlyWiki via `TIDDLYWIKI_PLUGIN_PATH`,
  `_THEME_PATH`, `_LANGUAGE_PATH`; bundled plugins are searched first and always win.
- **Store bookkeeping is one file, `store/tw-desk-store.json`** – TiddlyWiki loads *every* extra file inside
  a plugin folder as a shadow tiddler, so nothing else may be put there. `tiddlers.json` must be an array of
  tiddlers whose field values are all strings (otherwise TiddlyWiki loads it as one JSON tiddler).
- **Moving a wiki-stored plugin into the store** adds it to that folder's `tiddlywiki.info` and moves the
  original file(s) to `%APPDATA%\TW Desk\backup\<timestamp>\`. Refused while a wiki using the folder runs.
  Included folders (e.g. `_shared`) can list plugins themselves; every including wiki gets them.
- **Libraries** (in `config.json`, default: official library for the bundled TW version + CPL):
  - standard: `<base>/recipes/library/tiddlers.json`, plugin at
    `<base>/recipes/library/tiddlers/<encodeURIComponent(encodeURIComponent(title))>.json`
  - CPL (`https://tw-cpl.netlify.app/repo`): `<repo>/index.json`, plugin at `<repo>/<name>/latest.json`
    where `<name>` = title without `$:/plugins/` and `/` (and `:<>"|?*`) replaced by `_`.
  - Fetched with Electron `net.fetch` (uses system proxy settings).
  - The Libraries tab searches all indexes at once (`allIndexes`; entries keep every non-text field in `fields`);
    query parsing/ranking/grouping by title lives in `plugins-ui.js` (`parseQuery`, `scoreGroup`, `searchGroups`).
- Writing `tiddlywiki.info` (includes, plugin lists) re-serializes it with 4-space JSON; skipped if unchanged.
- **Copying a wiki** (`copyWikiFolder`): file copy, skipping `.git`, `output`, `$__StoryList.tid`, `$__HistoryList.json`;
  "config" mode keeps only tiddler files whose title (from `.meta` / `.tid` header / all titles of a `.json`) starts
  with `$:/` and drops `files/`. `includeWikis` paths are re-relativized to the new location. Copying into the source
  folder is refused. A new repo is initialized only if the target isn't already inside one.
- **Deleting a wiki** only ever uses `shell.trashItem` (no `fs.rm` of wiki folders). `deleteCheck()` blocks it while the
  wiki runs, while another wiki includes the folder, or when the folder contains another managed wiki.
- **Wiki description** (`description`) and, for copies, `copiedFrom: { id, name, path, date }` live in `config.json`,
  not in `tiddlywiki.info` (its `description` holds edition texts like "Basic client-server edition"). The list shows
  the original's current name if it still exists.
- **Web wikis** (`config.webWikis`: `{ id, name, url, description, snapshot?, check? }`) are links; `open-web-wiki` opens only
  listed addresses. Per link `<userData>/web/<id>/` holds `snapshot.html` (only the latest) and `baseline.json` (ETag,
  Last-Modified, file hash and a hash per tiddler of the version last seen). `src/web.js` reads tiddlers straight from the
  HTML (new JSON store and old storeArea divs, like TiddlyWiki's `text/html` deserializer) – no TiddlyWiki process.
  Baseline is recorded when a link is added / its URL changes, on *Save snapshot* and on *Mark changes as seen*; checks
  (daily via `config.webCheck`, default on; or manual) use conditional requests, then file hash, then tiddler hashes, and
  only set `link.check`. Volatile tiddlers ($:/HistoryList, $:/temp|state|status/) are ignored; `$:/StoryList` counts.
  Downloads/checks run one at a time (`webQueue`, `webBusy` → row chip). The snapshot opens via `loadFile` in a sandboxed
  window; every navigation away goes to the browser. *Make wiki from snapshot* converts the local file and sets
  `importedFrom: { source: url, date, snapshot }`. The HTML conversion keeps `$:/StoryList` (river of
  `[list[$:/StoryList]]` wikis).
- **Ports are automatic** (since 0.2.3): `config.basePort` + per wiki optional `fixedPort` and remembered
  `lastPort`. On start: fixed port, else `lastPort` if free, else the next free port from `basePort` – skipping other
  wikis' fixed and active ports and, if possible, their `lastPort`s (keeps URLs stable). Port choice is serialized
  (`portQueue`) so autostart can't hand out one port twice. Old configs' `port` is migrated to `lastPort` on load.
- **Git checks** (`config.git`): timer every `interval` s with fetch, local-only on focus (throttled 30 s), after
  actions/stop. Checks are queued (`gitQueue`); repos shared by several folders are checked once. Pull is fast-forward
  only and refused while a wiki using the repo runs; nothing is done in conflict/merge/detached state. Auto-commit
  on stop covers the wiki and its writable includes and is skipped while quitting. The Git tab re-renders on every
  state push, so the commit field keeps its draft (`gitDrafts`) and focus.
- `TW_DESK_USER_DATA` env var overrides the user data folder (config, store, backup) – used for testing.

## Testing

Never run tests against the user's wikis or their `%APPDATA%\TW Desk`. Instead:

1. Copy `orga`, `priv-orga`, `_shared` into a temp folder (drop `.git`), keep them side by side.
2. Write a test `config.json` into a temp user-data folder with a test `basePort` (e.g. 18090),
   pointing at the copies.
3. Run from source: `TW_DESK_USER_DATA=<temp userdata> npx electron . --remote-debugging-port=9350`
   (in the background), or the built app: `dist/win-unpacked/TW Desk.exe` with the same env var.
4. Drive it with `node scripts/cdp.mjs 9350 index.html "<js>"` – e.g. call `window.twDesk.*` /
   `window.twDesk.plugins.*`, click buttons, or `screenshot:<file>.png` and look at the image.
   Check wikis with curl: `http://127.0.0.1:18090/status`, `/recipes/default/tiddlers/<encoded title>`.
5. Quit via `node scripts/cdp.mjs 9350 index.html "window.close(); 1"` (servers stop on quit).

The user's own TW Desk usually runs on ports 8090/8091 – don't use those. Something unrelated (a TiddlyWiki
5.4.0 inside WSL) answers on port 8080.

Installer behaviour (updates, uninstall) can be tested with a throwaway variant that has its own app ID:
`npx electron-builder --win nsis -c.appId=local.tw-desk-test -c.productName="TW Desk Test" -c.extraMetadata.name=tw-desk-test -c.extraMetadata.version=0.0.1 -c.directories.output=<temp>`,
install silently with `/S /D=<temp dir>`, and uninstall + remove its HKCU registry keys afterwards.

## Build and release

- `npm install` (once), `npm start` (dev), `npm run dist` → `dist\TW-Desk-Setup-<version>.exe`.
- Raise `"version"` in `package.json` for every build given to the user; the header shows it.
- Update TiddlyWiki: `npm install --save-exact tiddlywiki@<version>`, then compare the user's core overrides
  in their wikis (new-tiddler action, sidebar tabs Open/Recent, title cascade) with the new core.

## Linux and macOS

Built with `npm run dist:linux` (AppImage) / `dist:mac` (unsigned dmg, needs a Mac); neither has run yet. Paths are
compared case-insensitively only on Windows and macOS (`folderKey()` in main.js, `pathKey()` in renderer.js – keep
them in sync). On macOS git is looked up in `/opt/homebrew/bin`, `/usr/local/bin`, then `/usr/bin` only if the command
line tools exist (the `/usr/bin/git` stub would open an install dialog). Folder names for new wikis keep the Windows
rules everywhere, so wikis stay usable on Windows. The manager window quits the app when closed on every platform
(the servers belong to it); Electron's default menu provides the macOS app menu and Cmd shortcuts.

## Conventions and pitfalls

- Code style: tabs, double quotes, plain JS (no build step), small comments only where the "why" isn't obvious.
- Commit only when asked; end messages with the Co-Authored-By line given in the session. Stage files
  explicitly – `.esaca/` (local sandbox config) is ignored but don't use broad `git add` habits.
- In this environment Bash heredocs can mangle backslashes (`\\` → `\`); use the Edit/Write tools for
  files containing backslashes (JSON with Windows paths, regexes).

## State (as of 2026-10-26)

- Version 0.2.12 committed (search across all plugin libraries, groups, descriptions, web wiki links with snapshots and change checks, update check per library, create/copy/delete wizards, automatic ports, git,
  Linux/macOS build targets, row menus and drag & drop). Builds are made by the user on Windows; this sandbox
  can't install Electron (no npm registry access). 0.2.0 was the first update from the short-path layout.
- The user's plugins are still stored as tiddlers inside `_shared` (relink*, CPL-Repo, rimir/*,
  sq/editor-autolist); moving them to the store is the user's step in the Plugins window.
- Wiki rows show Start/Stop, Open and a ⋯ menu (`src/menu.js`, also on right-click); reordering via the menu and
  drag & drop (`place-wiki`). The list doesn't re-render during a drag (`renderPending`).
- Open question: the repository has no remote yet.

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
- Writing `tiddlywiki.info` (includes, plugin lists) re-serializes it with 4-space JSON; skipped if unchanged.
- `TW_DESK_USER_DATA` env var overrides the user data folder (config, store, backup) – used for testing.

## Testing

Never run tests against the user's wikis or their `%APPDATA%\TW Desk`. Instead:

1. Copy `orga`, `priv-orga`, `_shared` into a temp folder (drop `.git`), keep them side by side.
2. Write a test `config.json` into a temp user-data folder with test ports (e.g. 18090/18091),
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

## Conventions and pitfalls

- Code style: tabs, double quotes, plain JS (no build step), small comments only where the "why" isn't obvious.
- Commit only when asked; end messages with the Co-Authored-By line given in the session. Stage files
  explicitly – `.esaca/` (local sandbox config) is ignored but don't use broad `git add` habits.
- In this environment Bash heredocs can mangle backslashes (`\\` → `\`); use the Edit/Write tools for
  files containing backslashes (JSON with Windows paths, regexes).

## State (as of 2026-10-26)

- Version 0.2.0 built; it is the first update from the short-path layout (first real test that updates
  work without deleting the install folder).
- The user's plugins are still stored as tiddlers inside `_shared` (relink*, CPL-Repo, rimir/*,
  sq/editor-autolist); moving them to the store is the user's step in the Plugins window.
- Open questions: keep or remove the ▲/▼ reorder buttons (added unasked); repository has no remote yet.

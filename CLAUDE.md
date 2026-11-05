# TW Desk – notes for Claude

Electron app (Windows) that manages local TiddlyWiki **folder wikis**: start/stop one TiddlyWiki server per wiki,
open wikis in app windows, edit `includeWikis`, and manage plugins via a shared store and plugin libraries.
TiddlyWiki is bundled (pinned in `package.json`, currently 5.4.1). User-facing docs: `README.md`.

The user's wikis live in `C:\data\22-tiddlydesktop\wikis\` (from WSL: `/mnt/c/data/22-tiddlydesktop/wikis`):
`orga`, `priv-orga`, `orga-old`, `tw-knowledge` (each its own git repo) and `_empty`. `_shared` is a plain folder of
shared wikis: `rr-core`, `rr-streams` and `contextualized` (only `contextualized` is its own repo). `orga` includes
`../_shared/rr-core` and `../_shared/rr-streams`. Look at the folders before building test copies – the layout changes.
**Never test against these folders** – use copies (see Testing).

## Environment

Claude works in WSL2 on the user's Windows machine. The checkout is `/home/mrichter/projects/tw-desk/tw-desk` (no
`node_modules`); the user's Windows checkout `/mnt/c/data/22-tiddlydesktop/tw-desk` has Windows `node_modules` and
`dist/`. Node (nvm), git, the npm registry and github.com are reachable. Electron, the e2e tests and builds run on
Windows, done by the user.

## Layout

- `src/main.js` – main process: config (`%APPDATA%\TW Desk\config.json`), server lifecycle, wiki windows,
  `includeWikis` read/write, plugin IPC, `knownFolders()` (managed wikis + folders they include).
- `src/tw-process.js` – entry of each TiddlyWiki utility process; args come as JSON in `TW_DESK_ARGS`.
- `src/plugins.js` – plugin store, bundled-plugin listing, library access (standard + CPL), update checks,
  per-folder `tiddlywiki.info` plugin lists, moving wiki-stored plugins into the store.
- `src/git.js` – git via the system `git` (no prompts: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`), status from
  `status --porcelain=v2 -z`; `src/git-ui.js` – git chips, Git tab of the bottom panel, footer line.
- `src/links.js` – links between wikis (link names, both link forms, wikitext to copy); `src/tw-plugins/tw-desk-links/` –
  the built-in TiddlyWiki plugin with the *TW Desk link* button.
- `src/setup.js` – export/import of the setup (build the file, check it, plan an import); `src/setup-ui.js` – its dialog.
- `src/binaries.js` – scan, externalize and internalize of binary tiddlers in a wiki folder (pure fs, unit-tested).
- `src/web.js` – tiddlers and per-tiddler hashes of a single-file wiki's HTML (web wiki snapshots and change checks).
- `src/preload.js` – `window.twDesk` API (contextBridge); `window.twDesk.plugins.*` for the plugins window.
- `src/renderer.js` + `index.html` + `styles.css` – manager UI; `src/plugins-ui.js` – Plugins window
  (shares globals `$`, `api`, `run`, `cleanError`, `folderName` from renderer.js); `src/search.js` – library search
  (query parsing, grouping, ranking), a plain script in the window and a module for the unit tests.
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
    query parsing/ranking/grouping by title lives in `search.js` (`parseQuery`, `scoreGroup`, `groupOffers`).
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
- **Plugin showcases** (`link.showcase`): plugin tiddlers are read from the snapshot (`snapshotPluginTiddlers`, cached by
  mtime) and offered as extra sources with the URL `showcase:<link id>` – in `plugins-all-indexes`, the update check
  (`checkUpdates(…, extraIndexes)`) and `plugins-install` (→ `installFromShowcase`, store meta `library: "showcase:<id>"`).
  `libraryLabel()` in plugins-ui.js turns these into "showcase <name>". `link.linkedPlugins` (titles, set via
  `plugins-link-showcase`, only for plugins in the snapshot) decides where `demoButtons()` offers a Demo button; it notes
  when the snapshot's version differs from the compared one (installed, used by the wiki, or newest library version).
- **Export/import of the setup** (`src/setup.js`, UI `src/setup-ui.js`): one JSON file (`format: "tw-desk-setup"`,
  `version`). Folders are stored relative to the common folder of the folders' and repo roots' parents (`origin.base`), or
  absolute when there is none (different drives); `readSetup()` refuses `..`/absolute relative entries, so imports stay
  inside the chosen folder. Store plugins travel as plugin tiddlers (`plugins.readStorePlugin` ↔ `writeToStore`); a
  plugin's `library: "showcase:<old id>"` is mapped to the imported link's new id. Import = `planImport()` (pure, shown
  to the user) then `runImport()` in main.js: clones (`git.clone`: no option-like or `ext::` URLs,
  `protocol.ext.allow=never`), groups by name, wikis, web wikis, store, libraries, settings. Nothing is overwritten:
  existing wikis/links are skipped, store plugins only replaced by newer versions. `folderGitInfo()` re-spells git's
  repo root in the folder's spelling (8.3 names / case on Windows) so the common base works.
- **Closing wiki and snapshot windows:** TiddlyWiki's beforeunload warning (unsaved changes) makes Electron cancel the
  close without any dialog – the window looked stuck. `confirmUnload()` handles `will-prevent-unload` with its own
  question (*Close anyway* / *Stay*); while quitting it lets the window go without asking.
- **Links between wikis** (`src/links.js`): `twdesk://<link name>/<title>` and `http://127.0.0.1:<links.port>/open/<link name>/<title>`
  are parsed alike (`parseLink`) and handled in the wiki and snapshot windows' `setWindowOpenHandler`/`will-navigate`
  (`handleDeskLink` → `followLink`: start, `openWiki` (returns the window), `showTiddler` = `$tw.Story.navigateTiddler`
  once `.tc-story-river` exists). Link name = `wiki.linkName` or the folder name; hand-set names must be unique,
  duplicates from folder names are only reported (chip, question on follow). `config.links` = { style, port, router,
  scheme, plugin }. Router: `answerRouter` (302 to `<wiki url>#<title>`; runs while `router` or `style === "http"`;
  cross-site requests that aren't top-level navigations get a confirm page – navigations must pass, a wiki opened as
  `localhost:<port>` is cross-site to `127.0.0.1`). `bringToFront` uses a short always-on-top on Windows, which otherwise
  refuses the foreground to a background app (links from the browser); links from outside are logged in the wiki's Log.
  The copy request carries the caption (`twdesk-copy:<title>/<caption>`, both encoded), shown as the link text. `twdesk://` is registered only when `app.isPackaged` (HKCU, no admin); links from other programs arrive via
  `second-instance` argv / macOS `open-url` (`followArgv`). The built-in plugin `src/tw-plugins/tw-desk-links` is loaded
  with TiddlyWiki's `++<folder>` argument (never written into wikis); its button only shows when the user agent contains
  `TWDeskWindow/` (set on wiki windows; not `TWDesk/`, which Electron puts into every window's user agent) and asks TW Desk to copy via `window.open("twdesk-copy:<title>")`, so TW Desk knows the
  wiki from the window. TiddlyWiki treats `twdesk:` as internal, hence `[ext[…]]` for that form.
  In a browser the plugin hands `twdesk:` clicks over via `location.href` (no empty tab). Electron (45) passes such an
  address to the system without `will-navigate`, `did-start-navigation` or an `openExternal` permission request, so the
  e2e test checks the page's own navigation (Navigation API `navigate` event) instead.
- **Ports are automatic** (since 0.2.3): `config.basePort` + per wiki optional `fixedPort` and remembered
  `lastPort`. On start: fixed port, else `lastPort` if free, else the next free port from `basePort` – skipping other
  wikis' fixed and active ports and, if possible, their `lastPort`s (keeps URLs stable). Port choice is serialized
  (`portQueue`) so autostart can't hand out one port twice. Old configs' `port` is migrated to `lastPort` on load.
- **Git checks** (`config.git`): timer every `interval` s with fetch, local-only on focus (throttled 30 s), after
  actions/stop. Checks are queued (`gitQueue`); repos shared by several folders are checked once. Pull is fast-forward
  only and refused while a wiki using the repo runs; nothing is done in conflict/merge/detached state. Auto-commit
  on stop covers the wiki and its writable includes and is skipped while quitting. The Git tab re-renders on every
  state push, so the commit field keeps its draft (`gitDrafts`) and focus.
- **Binary tiddlers** (`wiki.binaries` = { policy: leave|externalize|internalize, filesInGit }, scan in `binaryScan`): binary =
  TiddlyWiki type with base64 encoding. Only the wiki's own `tiddlers/` changes, only while stopped/error, never while quitting;
  runs after a stop (before auto-commit) and at start before autostart; a wiki included by another managed wiki is only
  reported. Moves are crash-safe (write, verify size + sha256, then rewrite); all fields except `text` stay identical
  (`modified` not bumped); `$:/` tiddlers untouched. Externalized = `.tid` with `_canonical_uri: files/<name>`, empty text;
  `<name>` is the binary's own file name (lower-case extension, numbered on clashes). Binaries without `.meta` are never moved.
  Internalize keeps the file in `files/`. `filesInGit: false` appends `files/` to `.gitignore` (never `git rm --cached`). `filesInGit: true` removes that line again (`ensureNotIgnored`) when the policy runs. A title's own registered extension (`.jpeg`, `.m4a`) is kept. Internalize refuses files a symlink leads out of `files/`. Leftover `*.tw-desk-tmp` files are removed before every server start.
- `TW_DESK_USER_DATA` env var overrides the user data folder (config, store, backup) – used for testing.

## Testing

Automated tests (`test/`):

- `npm test` – module tests with Node's test runner (`test/unit/`: web.js, search.js, git.js, plugins.js incl. a render
  with the bundled TiddlyWiki that loads a store plugin). No Electron needed (`test/helpers/electron-stub.js`), so they
  run in WSL too: without a local `node_modules`, set `NODE_PATH` to a folder holding `tiddlywiki`, e.g.
  `NODE_PATH=/mnt/c/data/22-tiddlydesktop/tw-desk/node_modules npm test` (~70 s).
- `npm run test:e2e` – Playwright drives the real app (`_electron.launch`), run by the user on Windows. Each test gets
  a temp user-data folder, copies of template wikis made with the bundled TiddlyWiki, base port 18390 and a local
  server (`test/helpers/server.js`) standing in for the plugin libraries (standard + CPL) and web wikis.
  Native dialogs and `shell.*` are replaced in the main process (`stubMainProcess` in `test/e2e/fixtures.js`);
  an `alert()` in the UI fails the test. Git (tests and the app under test) runs with `test/helpers/git-env.js`: an
  empty global config (branch `main`, no signing) and a test identity, never the user's git settings. Failed tests leave a trace, window screenshots and the main-process
  log under `test-results/` (in the repo, so they can be read here).
- **Never show windows on the user's desktop.** WSL has WSLg (`DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`), so Electron
  windows from e2e or manual runs pop up on the user's screen and disturb them. In WSL run Electron/Playwright only
  invisibly: `env -u WAYLAND_DISPLAY -u DISPLAY xvfb-run -a npx playwright test …` (both variables unset – with
  `WAYLAND_DISPLAY` left set Electron may still use Wayland). The same applies to `npx electron .` for manual testing.
  Don't wrap test runs in `git stash` (an interrupted run leaves the work stashed).

Manual testing – never against the user's wikis or their `%APPDATA%\TW Desk`. Instead:

1. Copy the wikis you need (e.g. `orga` and `_shared`) into a temp folder (drop `.git`), keeping the same relative
   layout so `includeWikis` paths like `../_shared/rr-core` still resolve.
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
- Unit tests also run on the user's Windows checkout (CRLF line endings, `\` paths): build expected paths with
  `path.join`/`path.relative`, never compare against `"a/b"` strings, and don't assume `\n` when reading source files.
- In this environment Bash heredocs can mangle backslashes (`\\` → `\`); use the Edit/Write tools for
  files containing backslashes (JSON with Windows paths, regexes).

## State (as of 2026-11-04)

- Version 0.2.21 committed (binary tiddlers: per-wiki externalize/internalize policy with row chip; before that links handed over from wikis in a browser, links between wikis with twdesk:// and http forms and the built-in TW Desk links plugin, asking before closing wiki/snapshot windows with unsaved changes, safe config writes, export/import of the setup, separate Demo/Website pills, showcase links to plugins, plugin showcases, search across all plugin libraries, groups, descriptions, web wiki links with snapshots and change checks, update check per library, create/copy/delete wizards, automatic ports, git,
  Linux/macOS build targets, row menus and drag & drop). Builds are made by the user on Windows. 0.2.0 was the first
  update from the short-path layout.
- The user's wikis list their plugins in `tiddlywiki.info` (e.g. `orga`: rimir/kind, rimir/ports, rimir/frontmatter,
  rimir/kind-streams, rimir/streams-ports, rimir/drop-attach, kixam/datepicker, kixam/moment, kookma/commander), so
  they come from the store rather than living as tiddlers in `_shared`.
- Wiki rows show Start/Stop, Open and a ⋯ menu (`src/menu.js`, also on right-click); reordering via the menu and
  drag & drop (`place-wiki`). The list doesn't re-render during a drag (`renderPending`).
- Remote: `origin` = https://github.com/rimir-cc/tw-desk (branch `master`). github.com is reachable from WSL, but push
  only when the user asks.

# TW Desk

Small Electron app that starts, stops and opens local TiddlyWiki folder wikis.
TiddlyWiki (currently 5.4.1) is bundled; each wiki runs as its own server on `127.0.0.1:<port>`.

## Use

- **Wiki rows:** Start/Stop, Open and **⋯** (also on right-click): Open in browser, Show folder, Log, Git, Edit…, Copy…, Move up/down, Remove…. Double-click opens the wiki. **Drag a row** to reorder it or to move it into another group (also while it runs; drop on a group header to append it there, on "Ungrouped" to take it out of its group).
- **Web wikis:** `+ New` → *Web wiki link…* keeps links to wikis on the web (e.g. https://groktiddlywiki.com/read/) with a name and a description (what it is about, why you collected it). They're listed in their own collapsible section: *Open ↗* opens the browser; the ⋯ menu has *Import as new wiki…* (downloads it and creates a local wiki folder, which then shows "imported from …"), Copy address, Edit…, Move up/down and Remove….
- **Description:** an optional text per wiki (Edit dialog, or right away in the create/copy wizard), shown in italics under its name – e.g. what a test copy is for. Copies also show where they came from: "copy of Orga · 2026-10-26".
- **Add a wiki:** `+ New` → *Add existing wiki folder…* (contains `tiddlywiki.info`).
- **New wiki:** `+ New` → *Empty wiki…* → wizard: where (parent folder + folder name), then name, optional fixed port, group, optional shared wiki to include (e.g. `../_shared`). Creates a server wiki (`tiddlywiki --init server`).
- **Remove or delete:** *Remove…* in a wiki's ⋯ menu → *remove from TW Desk only* (folder stays) or *delete the wiki*: its folder is moved to the Recycle Bin / Trash (never deleted permanently; if that isn't possible, nothing is deleted). Deleting is only possible while the wiki is stopped, no other wiki includes its folder and it contains no other wiki; the dialog warns about uncommitted or unpushed changes and missing repositories/remotes. Included folders are never deleted with a wiki.
- **Copy a wiki:** *Copy…* in a wiki's ⋯ menu → wizard: *everything* (tiddlers, plugins, includes) or *only the configuration* (system tiddlers `$:/…`, plugins, includes – a template without content), then location and settings. The original's `.git`, `output/` and `$:/StoryList` are not copied; by default the copy gets its own new git repository (no remote), so it can't push into the original's repository. Include paths are adjusted so the copy includes the same folders (e.g. `_shared`), which are not copied.
- **From a single-file wiki:** `+ New` → *Wiki from HTML file or web address…* → same wizard, starting with the `.html` file or a web address (downloaded with the system's proxy settings); converts it with `--savewikifolder` (the HTML file is not changed). Official plugins are referenced by name and so load in the bundled TiddlyWiki version; other plugins land in the wiki's `tiddlers` folder (move them to the store in Plugins). Password-protected files must be saved without password first.
- **Ports:** automatic by default – on each start a wiki gets the port it used last time if that's free, otherwise the next free port from the start port (`Settings`, default 8090). The list shows the port while the wiki runs. Set a **fixed port** in Edit for wikis you bookmark or link to; fixed ports are always shown and reserved for that wiki.
- **Git:** each wiki row shows a small git chip (`⎇ main ✓`, `⎇ main · 14 changed · ↑2`, `⎇ no repository`, …); included folders get a dot on their chip. Grey = fine, amber = needs a commit/push/pull or a repository, red = merge conflict / merge in progress / detached HEAD. Click the chip for the **Git** tab (next to Log): changed files, Commit (suggested message), Push, Pull (only while the wikis using the repository are stopped; fast-forward only), Fetch, Add remote, Initialize repository (with a `.gitignore`). Checks run silently every 10 minutes (with fetch) and on window focus (local only); interval, fetching, when changes count as old, and auto-commit on stop (off by default) are in `Settings`. Uses the installed git (Git for Windows; on macOS Homebrew's git or the Xcode command line tools) and never asks for passwords – if a remote needs a login, push once from a terminal.
- **Start / Stop / Open / Browser / Log** per wiki; "Start when TW Desk starts" = autostart.
- **Groups:** `+ New` → *Group…* creates a group; the list shows one section per group (wikis without a group under "Ungrouped"). A wiki belongs to at most one group, chosen by dragging it or in **Edit**. Rename/Delete in the group's header; deleting a group keeps its wikis (ungrouped). Move up/down (⋯ menu) or dragging reorders wikis. Click a group's name to collapse or expand it (remembered in `config.json`).
- **Includes** (`includeWikis` in `tiddlywiki.info`): shown under each wiki; the `Includes` button lists which wikis include which folder. Change them in **Edit** (wiki must be stopped; only folders with a `tiddlywiki.info`).
- **Plugins** button:
  - *Wikis*: the plugins/themes/languages in each folder's `tiddlywiki.info` (also included folders such as `_shared`, whose plugins every including wiki gets). Add bundled or store plugins, remove them, and move plugins stored inside a wiki (as tiddlers) into the store; the original files go to `%APPDATA%\TW Desk\backup`.
  - *Store*: shared plugins in `%APPDATA%\TW Desk\store` (kept on reinstall/update); check for updates: lists every store and wiki-stored plugin with the version each library offers (a plugin can be in several libraries; pick which one to update from), and which plugins can't be checked (not in any library / no version).
  - *Libraries*: plugin library URLs (standard TiddlyWiki libraries and CPL), browse and install.
  - TW Desk passes the store to TiddlyWiki via `TIDDLYWIKI_PLUGIN_PATH` (and the theme/language equivalents); bundled plugins take precedence. Changes apply when a wiki is (re)started.
- Wiki list, groups and libraries: `%APPDATA%\TW Desk\config.json`.
- Data folder (config, store, backup) per system: Windows `%APPDATA%\TW Desk`, macOS `~/Library/Application Support/TW Desk`, Linux `~/.config/TW Desk` (paths above use the Windows one).
- Only one server per wiki folder: don't open the same folder in TiddlyDesktop or Docker at the same time.

## Develop and build

```bash
npm install          # once, restores node_modules
npm start            # run from source
npm run dist         # build dist\TW-Desk-Setup-<version>.exe (on Windows)
npm run dist:linux   # build dist/TW-Desk-<version>.AppImage (on Linux or WSL)
npm run dist:mac     # build dist/TW-Desk-<version>.dmg (on a Mac only)
```

Linux and macOS builds are not tested yet. The AppImage needs no installation (`chmod +x`, then run it). The macOS app is
not signed or notarized: on first start macOS blocks it – allow it under System Settings → Privacy & Security.

The installer is per-user (no admin rights), installs to `%LOCALAPPDATA%\Programs\tw-desk` by default (shown and changeable in the installer, and shown with a Copy button in the app's footer) and updates an existing installation in place; the wiki list is kept.
Only the `Setup-*.exe` is needed for installing; the `.blockmap` file can be ignored.

## Update TiddlyWiki

1. Back up / commit the wikis.
2. Compare the wikis' core overrides with the new core (new-tiddler action, sidebar tabs Open/Recent, title cascade).
3. `npm install --save-exact tiddlywiki@<new version>`, raise `"version"` in `package.json`, `npm run dist`.
4. Close TW Desk, run the new installer, check the version shown in the header.

Plugins stored inside a wiki (not listed in `tiddlywiki.info`) are not updated by this; update them in the wiki.

## Move to another computer

Copy the installer, the `wikis` folder (keep `orga`, `priv-orga`, `_shared` side by side) and, if the paths stay the same, `config.json`.
Otherwise re-add the wikis in the app. Copy this source folder (without `node_modules`, `dist`) only if you want to rebuild.

## Troubleshooting

- **Wiki won't start:** open its **Log**. "Port … already in use" → another program uses the wiki's fixed port; pick another one via Edit or clear it for an automatic port.
- **App doesn't appear:** check Task Manager for a leftover `TW Desk.exe`; only one instance can run.
- **Update says "TW Desk kann nicht geschlossen werden" although it isn't running:** only happens when updating 0.1.5 or older (they contained files with paths over 260 characters that the old uninstaller can't move). Delete the install folder (shown in the app's footer) and run the installer again.

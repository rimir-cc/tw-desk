# TW Desk

Small Electron app that starts, stops and opens local TiddlyWiki folder wikis.
TiddlyWiki (currently 5.4.1) is bundled; each wiki runs as its own server on `127.0.0.1:<port>`.

## Use

- **Add a wiki:** `+ Add wiki` → an existing wiki folder (contains `tiddlywiki.info`).
- **New wiki:** `+ Empty wiki` → wizard: where (parent folder + folder name), then name, optional fixed port, group, optional shared wiki to include (e.g. `../_shared`). Creates a server wiki (`tiddlywiki --init server`).
- **From a single-file wiki:** `+ Load from HTML` → same wizard, starting with the `.html` file; converts it with `--savewikifolder` (the HTML file is not changed). Official plugins are referenced by name and so load in the bundled TiddlyWiki version; other plugins land in the wiki's `tiddlers` folder (move them to the store in Plugins). Password-protected files must be saved without password first.
- **Ports:** automatic by default – on each start a wiki gets the port it used last time if that's free, otherwise the next free port from the start port (`Settings`, default 8090). The list shows the port while the wiki runs. Set a **fixed port** in Edit for wikis you bookmark or link to; fixed ports are always shown and reserved for that wiki.
- **Start / Stop / Open / Browser / Log** per wiki; "Start when TW Desk starts" = autostart.
- **Groups:** `+ Add group` creates a group; the list shows one section per group (wikis without a group under "Ungrouped"). A wiki belongs to at most one group, chosen in **Edit**. Rename/Delete in the group's header; deleting a group keeps its wikis (ungrouped). ▲/▼ move a wiki within its group. Click a group's name to collapse or expand it (remembered in `config.json`).
- **Includes** (`includeWikis` in `tiddlywiki.info`): shown under each wiki; the `Includes` button lists which wikis include which folder. Change them in **Edit** (wiki must be stopped; only folders with a `tiddlywiki.info`).
- **Plugins** button:
  - *Wikis*: the plugins/themes/languages in each folder's `tiddlywiki.info` (also included folders such as `_shared`, whose plugins every including wiki gets). Add bundled or store plugins, remove them, and move plugins stored inside a wiki (as tiddlers) into the store; the original files go to `%APPDATA%\TW Desk\backup`.
  - *Store*: shared plugins in `%APPDATA%\TW Desk\store` (kept on reinstall/update); check for updates: lists every store and wiki-stored plugin with the version each library offers (a plugin can be in several libraries; pick which one to update from), and which plugins can't be checked (not in any library / no version).
  - *Libraries*: plugin library URLs (standard TiddlyWiki libraries and CPL), browse and install.
  - TW Desk passes the store to TiddlyWiki via `TIDDLYWIKI_PLUGIN_PATH` (and the theme/language equivalents); bundled plugins take precedence. Changes apply when a wiki is (re)started.
- Wiki list, groups and libraries: `%APPDATA%\TW Desk\config.json`.
- Only one server per wiki folder: don't open the same folder in TiddlyDesktop or Docker at the same time.

## Develop and build

```bash
npm install          # once, restores node_modules
npm start            # run from source
npm run dist         # build dist\TW-Desk-Setup-<version>.exe
```

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

# TW Desk

Small Electron app that starts, stops and opens local TiddlyWiki folder wikis.
TiddlyWiki (currently 5.4.1) is bundled; each wiki runs as its own server on `127.0.0.1:<port>`.

## Use

- **Add a wiki:** `+ Add wiki` → existing folder (contains `tiddlywiki.info`) or create a new one (optionally including a shared wiki such as `../_shared`).
- **Start / Stop / Open / Browser / Log** per wiki; "Start when TW Desk starts" = autostart.
- **Includes** (`includeWikis` in `tiddlywiki.info`): shown under each wiki; the `Includes` button lists which wikis include which folder. Change them in **Edit** (wiki must be stopped; only folders with a `tiddlywiki.info`).
- Wiki list: `%APPDATA%\TW Desk\config.json`.
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

- **Wiki won't start:** open its **Log**. "Port … already in use" → another program uses the port; pick another one via Edit.
- **App doesn't appear:** check Task Manager for a leftover `TW Desk.exe`; only one instance can run.

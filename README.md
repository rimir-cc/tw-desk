# TW Desk

Small Electron app that starts, stops and opens local TiddlyWiki folder wikis.
TiddlyWiki (currently 5.4.1) is bundled; each wiki runs as its own server on `127.0.0.1:<port>`.

## Use

- **Wiki rows:** Start/Stop, **↻ Restart** (while running), Open and **⋯** (also on right-click): Restart, Open in browser, Show folder, Log, Git, Edit…, Copy…, Move up/down, Remove…. *Restart* stops and starts the server again – TiddlyWiki reads the wiki folder only when it starts, so this picks up files changed on disk (e.g. after a git pull or by another program) – and reloads the wiki's open window instead of closing it; if that window still has unsaved changes it asks first. Wiki and snapshot windows open at the size set in **Settings → Wiki windows** (default 2700 × 1400, at most the screen; *Use the size of an open wiki window* takes the size of a window you sized by hand, borders included). Double-click opens the wiki. **Drag a row** to reorder it or to move it into another group (also while it runs; drop on a group header to append it there, on "Ungrouped" to take it out of its group).
- **Web wikis:** `+ New` → *Web wiki link…* (or *+* in the section's header) keeps links to wikis on the web (e.g. https://groktiddlywiki.com/read/) with a name and a description (what it is about, why you collected it), in their own collapsible section. Without a snapshot, *Open ↗* opens the browser. *Save snapshot* (⋯ menu) downloads the wiki into TW Desk's data folder (`web\<id>\snapshot.html`, only the latest one is kept); then *Open* shows the snapshot in an app window – it runs on its own, without a server, and changes there aren't saved (closing it after a change asks first) – and *↗* opens the website. *Make wiki from snapshot…* creates a real local wiki folder from it (shown as "from the snapshot of …"). **Changes on the website:** when a link is added (and whenever a snapshot is saved) TW Desk remembers a hash of every tiddler. Once a day (Settings → *Check web wikis for changes once a day*) and with *Check for changes* it asks the website whether the file changed (ETag / Last-Modified, so nothing is downloaded if not), otherwise downloads it and compares the tiddlers. A changed site shows a chip like "changed · 16 tiddlers" (tooltip: changed / new / removed, new TiddlyWiki version); *Update snapshot* or, without a snapshot, *Mark changes as seen* clears it. Tiddlers that change by just using a wiki (`$:/HistoryList`, `$:/temp/…`, `$:/state/…`, `$:/status/…`) are ignored; `$:/StoryList` counts, as some wikis open with the river they were saved with.
- **Description:** an optional text per wiki (Edit dialog, or right away in the create/copy wizard), shown in italics under its name – e.g. what a test copy is for. Copies also show where they came from: "copy of Orga · 2026-10-26".
- **Add a wiki:** `+ New` → *Add existing wiki folder…* (contains `tiddlywiki.info`).
- **New wiki:** `+ New` → *Empty wiki…* → wizard: where (parent folder + folder name), then name, optional fixed port, group, optional shared wiki to include (e.g. `../_shared`). Creates a server wiki (`tiddlywiki --init server`).
- **Remove or delete:** *Remove…* in a wiki's ⋯ menu → *remove from TW Desk only* (folder stays) or *delete the wiki*: its folder is moved to the Recycle Bin / Trash (never deleted permanently; if that isn't possible, nothing is deleted). Deleting is only possible while the wiki is stopped, no other wiki includes its folder and it contains no other wiki; the dialog warns about uncommitted or unpushed changes and missing repositories/remotes. Included folders are never deleted with a wiki.
- **Copy a wiki:** *Copy…* in a wiki's ⋯ menu → wizard: *everything* (tiddlers, plugins, includes) or *only the configuration* (system tiddlers `$:/…`, plugins, includes – a template without content), then location and settings. The original's `.git`, `output/` and `$:/StoryList` are not copied; by default the copy gets its own new git repository (no remote), so it can't push into the original's repository. Include paths are adjusted so the copy includes the same folders (e.g. `_shared`), which are not copied.
- **From a single-file wiki:** `+ New` → *Wiki from HTML file or web address…* → same wizard, starting with the `.html` file or a web address (downloaded with the system's proxy settings); converts it with `--savewikifolder` (the HTML file is not changed). `$:/StoryList` is kept, so a wiki whose default tiddlers are `[list[$:/StoryList]]` opens with its intended river (note: the default `.gitignore` excludes `$__StoryList.tid`). Official plugins are referenced by name and so load in the bundled TiddlyWiki version; other plugins land in the wiki's `tiddlers` folder (move them to the store in Plugins). Password-protected files must be saved without password first.
- **Ports:** automatic by default – on each start a wiki gets the port it used last time if that's free, otherwise the next free port from the start port (`Settings`, default 8090). The list shows the port while the wiki runs. Set a **fixed port** in Edit for wikis you bookmark or link to; fixed ports are always shown and reserved for that wiki.
- **Git:** each wiki row shows a small git chip (`⎇ main ✓`, `⎇ main · 14 changed · ↑2`, `⎇ no repository`, …); included folders get a dot on their chip. Grey = fine, amber = needs a commit/push/pull or a repository, red = merge conflict / merge in progress / detached HEAD. Click the chip for the **Git** tab (next to Log): changed files, Commit (suggested message), Push, Pull (only while the wikis using the repository are stopped; fast-forward only), Fetch, Add remote, Initialize repository (with a `.gitignore`). Checks run silently every 10 minutes (with fetch) and on window focus (local only); interval, fetching, when changes count as old, and auto-commit on stop (off by default) are in `Settings`. Uses the installed git (Git for Windows; on macOS Homebrew's git or the Xcode command line tools) and never asks for passwords – if a remote needs a login, push once from a terminal.
- **Start / Stop / Open / Browser / Log** per wiki; "Start when TW Desk starts" = autostart.
- **Data folder:** your setup – wiki list, groups, settings, folder descriptions, plugin store (`store\`) and web wikis (`web\`) – lives in a folder you choose, e.g. `tw-desk-data` next to your wikis. The first start after the update asks for it (and moves the existing setup there); a fresh install asks where to create it; *Use existing data folder…* takes one from another computer (e.g. a clone of your data repository) and **replaces** the current setup after a warning. Wiki paths in its `config.json` are stored relative to it when that goes up at most two levels (`../wikis/orga`), otherwise absolute. Machine-specific values (last ports, web-check results, collapsed groups, the wiki window size) are kept in `%APPDATA%\TW Desk\local.json`, so just using TW Desk never changes the data folder; backups, logs and caches stay in `%APPDATA%\TW Desk` too. **Git:** the data folder gets its own repository (also inside another repository). TW Desk **commits on its own** about 90 seconds after a change has settled, and when you quit, with a message saying what happened (`Added wiki orga · Installed $:/plugins/kixam/moment 1.2.0`); changes made by hand are committed too; wikis kept inside the data folder are left out (they have their own history). If a commit fails, the chip turns red with the reason in its tooltip. It never pushes: the `TW Desk data ⎇` chip in the header turns amber when commits have been waiting longer than "Mark uncommitted changes after (hours)"; click it for the Git tab (Push, Pull, Fetch, Add remote). While the branch is behind its remote, auto-commit pauses; Pull (fast-forward only) stops running wikis and reloads the setup; anything else (diverged history, conflicts) is left to you. **Settings → Data folder:** *Move…* copies it (with its repository) to an empty folder, switches over and asks before moving the old one to the recycle bin; *Use existing…* switches to another one (the current one stays on disk). On a new computer, wikis whose folders aren't found stay in the list as *not found*: **⋯ → Locate…** points one at its folder; when several were in the same folder, a banner offers *Where are they now?…* and re-points all that are found there.
- **Groups:** `+ New` → *Group…* creates a group; the list shows one section per group (wikis without a group under "Ungrouped"). A wiki belongs to at most one group, chosen by dragging it or in **Edit**. Rename/Delete in the group's header; deleting a group keeps its wikis (ungrouped). Move up/down (⋯ menu) or dragging reorders wikis. Click a group's name to collapse or expand it (remembered on this computer, in `local.json`).
- **Binary tiddlers:** images, PDFs etc. imported into a wiki are stored inside `tiddlers/` (and git). A row chip `▣ 3 embedded · 48 MB` shows how many (amber when the policy wants them moved); the tooltip has details. In **Edit** choose per wiki *Leave as is* (default), *Externalize into files/* (the binary moves to `files/` under its own file name, its tiddler becomes a `.tid` with `_canonical_uri`) or *Internalize from files/* (the reverse; files in `files/` stay). *Commit files/ with the wiki* off adds `files/` to the wiki's `.gitignore` (people who clone the wiki won't get the files); switching it on again removes that line when the policy next runs. A file keeps its own registered extension (`photo.jpeg`, `song.m4a`). The policy runs when the wiki stops and when TW Desk starts, or with **⋯ → Apply binary policy now**; never while the wiki runs, and not for a wiki another managed wiki includes (the Log says so). Binaries without a `.meta` file are not moved. With *Externalize*, deleting a binary tiddler deletes its file at the next stop; dropping a new version onto a binary (drop-attach) or re-importing the same file replaces the file under its name. Files git doesn't hold unchanged are first backed up to `<userData>/backup/…`; backups stay there until you remove them by hand. More than 10 deletions at once (or all of a wiki's recorded files, of 3 or more) are not done on their own: the chip shows `▣ N files to delete` and **⋯ → Delete N unused files…** / *Keep these files* decides; until then those files stay.
- **Includes** (`includeWikis` in `tiddlywiki.info`): shown under each wiki; the `Includes` button lists which wikis include which folder and lets you give an included folder (one that isn't a wiki in the list itself) a description, kept in the data folder's `config.json` and shown in the include chip's tooltip and on its Plugins card; setup export/import carries it. Change them in **Edit** (only folders with a `tiddlywiki.info`; changing them needs the wiki stopped – the other settings in Edit can be changed while it runs).
- **Plugins** button:
  - *Wikis*: the plugins/themes/languages in each folder's `tiddlywiki.info` (also included folders such as `_shared`, whose plugins every including wiki gets). Add bundled or store plugins, remove them, and move plugins stored inside a wiki (as tiddlers) into the store; the original files go to `%APPDATA%\TW Desk\backup`.
    - Cards can be collapsed (▸/▾, *Expand all* / *Collapse all*) and reordered by dragging a card's title; the order is kept in the data folder's `config.json`, separate from the wiki list.
    - *From included wikis* lists what a folder gets through its includes – transitively, like TiddlyWiki (`from rr-core`, `via rr-core → x`); change those on the included folder's own card. A plugin loaded twice in the same version is marked *listed twice* / *also from …*; different versions (a store or bundled copy vs. one stored inside a wiki, or two stored copies) are a **clash**: red badge naming the copy that wins (the one loaded last – included folders first, the wiki itself last), `⚠ clash` on the card and a `⚠ plugin clash` chip on the wiki's row that opens its card.
    - Removing a plugin from a folder other wikis include asks first and names the wikis that lose it and those that keep it from another source.
  - *Store*: shared plugins in the data folder's `store\` (kept on reinstall/update); check for updates: lists every store and wiki-stored plugin with the version each library offers (a plugin can be in several libraries; pick which one to update from), and which plugins can't be checked (not in any library / no version).
  - *Libraries*: one search across all registered libraries (standard TiddlyWiki libraries and CPL) and plugin showcases. Words must all match (name, description, author, tags or any other field of the library's list); `"a phrase"`; `-word` excludes; `field:value` searches one field (`author:`, `tag:`, `title:`, `description:`, `version:` or any index field such as `core-version:`). Matches are ranked (name > title > description > rest) and highlighted; a plugin found in several libraries is one row with each library's version and an Install/Update button per library. Filter by library and kind, hide installed ones; click a row for all fields (links open in the browser). The library list (add/remove) is below the results.
  - *Showcases*: web wikis marked as *Plugin showcase* (checkbox in the web wiki's Edit dialog, or *+ Add showcase* here, which also saves the snapshot right away) with the plugins, themes and languages in their snapshot: *Open demo*, *Add to store* / *Update → x.y* straight from the snapshot (for plugins that aren't in any library), Save/Update snapshot. The plugin list of each showcase is folded until you open it. *Link* marks a showcase as the demo of a plugin in it (several are possible; *Unlink* or ✕ in the "Demo of" line removes it): linked plugins get a *Demo* pill (opens the snapshot in a window; only once there is a snapshot) and a *Website ↗* pill (default browser) in the Wikis, Store and Libraries tabs, with a note like "demo shows 1.0.0" when the showcase has another version than the one installed (or used by that wiki); with several showcases the pills carry the showcase's name and the Demo pill its version, e.g. *Demo: First (1.0.0)*. Showcases also count as sources in the library search and the update check. In the main window a showcase shows a chip "showcase · N plugins" – or "showcase of relink" once linked – that opens this tab.
  - The built-in plugin *TW Desk links* (`$:/plugins/tw-desk/links`, see [Links between wikis](#links-between-wikis)) isn't listed here: it comes with TW Desk, is loaded into every wiki it serves and can be switched off in Settings.
  - TW Desk passes the store to TiddlyWiki via `TIDDLYWIKI_PLUGIN_PATH` (and the theme/language equivalents); bundled plugins take precedence. Changes apply when a wiki is (re)started.
- Wiki list, groups, settings and libraries: `config.json` in your data folder (see *Data folder* above).
- TW Desk's own folder (pointer to the data folder, `local.json`, backups, logs) per system: Windows `%APPDATA%\TW Desk`, macOS `~/Library/Application Support/TW Desk`, Linux `~/.config/TW Desk` (paths above use the Windows one).
- Only one server per wiki folder: don't open the same folder in TiddlyDesktop or Docker at the same time.

## Links between wikis

A tiddler in one wiki can link to a tiddler in another wiki. Clicking such a link in a TW Desk window starts the target
wiki if needed, opens its window or brings it to the front (also when minimized) and shows the tiddler at the top of
its story – like a normal link, nothing in the window is reloaded.

**Creating links:** every wiki TW Desk serves gets the built-in plugin *TW Desk links* (`$:/plugins/tw-desk/links`; it
comes with TW Desk and is loaded when the wiki starts – nothing is written into the wiki folder or its git repository).
In a TW Desk window each tiddler has a toolbar button **TW Desk link** (link icon; also under "more"): it copies a link
to that tiddler, ready to paste into another wiki, and the wiki shows "TW Desk link copied". The link shows the
tiddler's *caption* if it has one, otherwise its title (useful for timestamp titles like `20261028092438802`). The
button doesn't appear when the wiki is opened in a browser.

**Link names:** a link names its wiki by the wiki's *link name* – set in **Edit** (*Link name*), otherwise the name of
the wiki's folder (`orga`, `priv-orga`, `_shared`). Folder names travel with git and with export/import, so links keep
working on other computers. A name set by hand must be unique. If two wikis end up with the same name (e.g. two folders
called `alpha`), both rows show a chip *link name “alpha” used twice* (click it to give one its own name) and a link to
that name asks which wiki is meant. Changing a link name breaks the links that use the old one.

**Two link forms**, interchangeable – a TW Desk window follows both, whatever is set for copying
(Settings → *Links between wikis*):

| | `twdesk://` (default) | `http://` |
|---|---|---|
| Copied as | `[ext[Plan (orga)\|twdesk://orga/Plan]]` | `[[Plan (orga)\|http://127.0.0.1:8089/open/orga/Plan]]` |
| In TW Desk windows | yes | yes (also when the router is off) |
| In a browser or another program (mail, Teams, a file) | after registration: the browser asks whether to open TW Desk (it can remember the answer); the wiki opens in a TW Desk window, which comes to the front. In a wiki served by TW Desk the built-in plugin hands the link over from the page itself; elsewhere the browser may keep an empty tab with the `twdesk://` address | TW Desk starts the wiki and sends the browser there (`…:<wiki port>/#Plan`, a new tab) |
| Needs | the installed TW Desk (registered per user, no admin rights; *Open twdesk:// links from other programs*) | TW Desk running and a free port (*Port for http links*, default start port − 1, e.g. 8089); its small web server (*Answer http links in browsers*) is always on while http links are copied |

`twdesk://` needs the `[ext[…]]` form because TiddlyWiki only treats `http`, `https`, `mailto` and a few other schemes as
external links – a plain `[[…|twdesk://…]]` would link to a missing tiddler. Both forms are written by hand the same way:
`twdesk://<link name>/<tiddler title, URL-encoded>` or `http://127.0.0.1:<port>/open/<link name>/<title>`; without a
title (`twdesk://orga`) the wiki just opens. The http router only listens on 127.0.0.1. A clicked link works from
anywhere (also from a wiki opened as `localhost:<port>`, which the browser counts as another site than `127.0.0.1`);
what a page on another website loads by itself (images, scripts, frames) only gets a page with an *Open it with TW Desk*
link, so it can't start wikis unnoticed.

**Did a link arrive?** Links from other programs are noted in the target wiki's **Log** ("Link from another program:
orga / Plan"). If Settings shows "Port … is in use by another program" next to *Answer http links in browsers*, choose
another *Port for http links* (links copied with the old port then no longer work in browsers).

**Settings → Links between wikis:** which form *TW Desk link* copies, the port for http links, whether to answer http
links in browsers (also when twdesk:// links are copied, so older http links keep working), whether to register `twdesk://` for other programs (status shown next to it; only the installed app
registers, not a development or test run), and whether to load the built-in plugin (applies when a wiki is restarted).
Link names and these settings are part of Export/Import setup.

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

## Move to another computer or share a setup

**Settings → Export setup…** writes one file (`tw-desk-setup.json`) with the chosen wikis and the folders they include
(paths relative to their common folder, plus each repository's remote URL and branch), their groups, descriptions, fixed
ports and autostart, the chosen web wikis (showcase flags and plugin links; snapshots only if *Snapshots of web wikis* is
ticked – otherwise they are downloaded again on import), the store plugins (as plugin tiddlers, so also those no library
offers), the plugin libraries and the settings. The wikis' contents are not in the file.

**+ New → Import setup…** (also in Settings) on the other computer, after installing TW Desk: choose the folder the wikis
go into (the folders keep their places relative to each other, so `../_shared` includes keep working) and check the plan
before anything happens:

- a wiki folder that is already there is added to TW Desk; a missing one is **cloned** from its remote (one clone per
  repository, using the system's git and its credential store – a colleague needs read access); folders without a
  remote have to be copied there by hand (shown as *missing*); wikis already in TW Desk are skipped;
- web wikis are added (with the embedded snapshot, or downloaded again); links whose address is already there are skipped;
- store plugins are added unless the store has the same or a newer version (plugins are code that runs in the wikis
  using them – only import them from people you trust);
- missing libraries and groups are added; the settings are applied only if ticked (by default when TW Desk has no wikis yet).

Importing the same file again does no harm. Ports, logs, backups and git credentials are never exported.
Copy this source folder (without `node_modules`, `dist`) only if you want to rebuild.

## Troubleshooting

- **Wiki won't start:** open its **Log**. "Port … already in use" → another program uses the wiki's fixed port; pick another one via Edit or clear it for an automatic port.
- **App doesn't appear:** check Task Manager for a leftover `TW Desk.exe`; only one instance can run.
- **Update says "TW Desk kann nicht geschlossen werden" although it isn't running:** only happens when updating 0.1.5 or older (they contained files with paths over 260 characters that the old uninstaller can't move). Delete the install folder (shown in the app's footer) and run the installer again.

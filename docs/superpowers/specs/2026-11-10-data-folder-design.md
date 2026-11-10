# Data folder: your TW Desk in one movable, version-controlled place – design

Date: 2026-11-10 · Status: shipped in 0.2.24

## Why

Everything that makes up "my TW Desk" – the wiki list, groups, settings, folder descriptions, the plugin store, web
wikis and showcases – lives in `%APPDATA%\TW Desk` (Electron's `userData`), mixed with caches, logs and backups. It
can't be put under git sensibly, can't be moved next to the wikis, and a new machine or a reinstall means starting
over (or going through setup export/import).

The user's picture of success: **"clone my data repo, point TW Desk at it, everything's back."**

## Goals

1. **A data folder** the user chooses, holding only their setup (see *What goes where*). Everything temporary or
   machine-specific stays in `userData`.
2. **Movable.** Settings can move the data folder elsewhere, or point TW Desk at an existing one (a clone).
3. **Restore on a new machine.** Pointing TW Desk at a cloned data folder brings the setup back. Wikis come from their
   own repos and may sit at different paths: TW Desk shows them as not found and **helps re-point** them, in bulk
   when they share a common old parent folder.
4. **Git, mostly automatic.** The data folder is a git repository. TW Desk **commits on its own** with generated,
   readable messages. It **never pushes on its own**; it reminds the user when commits sit unpushed. Manual commit,
   push, pull and fetch are available through the same Git tab the wikis use.
5. **Upgrade path.** Existing installs are moved into a data folder once, on the first start after the update.

## Non-goals

- Automatic pushing (user: "no automatic pushing – just a reminder").
- Putting wiki content into the data folder. Wikis keep their own repos; the data folder only knows their paths.
  Includes between wikis are part of the wikis and travel with their repos.
- Running two machines in parallel against one data repo. The repo is mostly for **restoring** (new machine,
  reinstall). Pull is offered as for wikis (fast-forward only); anything beyond that – a diverged history, a
  conflict, a merge in progress – is entirely up to the user, exactly as for wikis.
- Replacing setup export/import. That stays as it is, for sharing a setup with colleagues.
- Passwords or credentials in the app (as for wikis: installed git, its credential store).

## Anti-goals (what would make this a failure even if it works)

- The repo changes just because the app was *used* (a wiki started on a new port, a check ran, a group was
  collapsed). Only real setup changes produce commits.
- A commit per click: dragging five cards around must not make five commits.
- Losing data during the first move or a later move (half-copied folder, config pointing nowhere).
- Wikis silently disappearing from the list on a machine where their paths don't exist.

## What goes where

**Data folder (in git):**
- `config.json` – wikis (paths, names, settings, groups membership), groups, settings (`basePort`, `git`,
  `webCheck`, `links`, `libraries`), `webWikis` (including `snapshot` metadata), `folderDescriptions`,
  `pluginsFolderOrder` – minus the local values below.
- `store/` – the plugin store (today `<userData>/store`, see `src/plugins.js` `init`).
- `web/` – per web wiki `snapshot.html` and `baseline.json` (today `<userData>/web/<id>`).
- `.gitignore` written by TW Desk when it creates the folder (ignores at least `*.tmp`, which `saveConfig` writes
  transiently).

**Stays in `userData` (local, never in git):**
- `backup/` – plugin and binary-policy backups.
- `binaries/` – the binary policy's per-wiki bookkeeping (`binaries/<id>.json`).
- **`local.json`** (new) – machine-specific and volatile values taken out of `config.json`:
  - per wiki: `lastPort`;
  - per web wiki: `check` (date and result of the last change check);
  - collapsed states: `group.collapsed`, `webCollapsed`, `ungroupedCollapsed` (cosmetic and toggled often).
  - Keyed by wiki/link/group id.
- **`data-folder.json`** (new) – the pointer: `{ "path": "<absolute path of the data folder>" }`.
- Logs, Electron caches, everything else that is there today.

The split is the user's agreed picture; which exact fields count as local beyond the ones listed is the builder's
call by the anti-goal "the repo doesn't change just because the app was used".

## Behaviour

### First start after the update (migration)

If `data-folder.json` doesn't exist:
- **Existing install** (a `config.json` in `userData`): a dialog explains the change once and asks where the data
  folder should live. Suggested default: a `tw-desk-data` folder next to the common parent of the managed wikis
  (e.g. `C:\data\22-tiddlydesktop\tw-desk-data`), falling back to `Documents\TW Desk data`. Options: *Create here*,
  *Choose…*, *Use existing data folder…* (a clone). TW Desk then:
  1. copies `config.json` (with local values split off into `local.json`), `store/` and `web/` into the new folder;
  2. writes `.gitignore`, runs `git init` and makes the first commit "Initial TW Desk data" (if git is installed;
     without git the data folder works, the git part shows `⎇ git not installed` like for wikis);
  3. writes `data-folder.json`;
  4. only then removes the old `config.json`, `store/` and `web/` from `userData` (they were copied and verified).
  A failure in steps 1–3 leaves `userData` untouched and TW Desk running on the old location, with the error shown;
  the question comes again next start.
- **Fresh install** (no `config.json`): same dialog, *Create here* creates an empty data folder; *Use existing…*
  is the new-machine case.

*Cancel* is not offered: TW Desk needs a data folder to run (*my call*; the default answer is one click).

### Using an existing data folder (new machine, or switching)

*Use existing…* accepts a folder containing a TW Desk `config.json` (or an empty folder, which becomes a new data
folder). TW Desk reads it, creates `local.json` fresh for this machine, and checks every wiki path.

**Replace, after a warning (user's decision).** When TW Desk already has a setup (the migration dialog on an
existing install, or Settings → Data folder → *Use existing…*), choosing an existing data folder **replaces** the
current setup: a warning names what will be dropped (e.g. "Your current 12 wikis, 3 web wikis and 40 store plugins
are replaced by the setup in X. Wiki folders themselves are not touched.") and asks for confirmation. Nothing is
merged, and no backup of the replaced setup is kept (in Settings the old data folder simply stays on disk; in the
migration case the old `userData` files are removed). Running wikis are stopped first.

### Re-pointing wikis that aren't found

- A wiki whose folder doesn't exist stays in the list, shown as **not found** (start disabled), with **⋯ → Locate…**.
- If two or more not-found wikis share a parent folder, a banner on the home view offers the bulk fix:
  *"5 wikis were in `C:\old\wikis` – they're not there. Where are they now?"* → pick a folder → TW Desk shows which of
  them it finds under the new parent (same relative path) and re-points those with one confirm. Wikis not found
  under the new parent stay not found.
- Re-pointing also re-points `folderDescriptions` and `pluginsFolderOrder` entries with the same old prefix.

### Paths in config.json (user's decision)

Paths of wikis and folders (`wikis[].path`, `folderDescriptions` keys, `pluginsFolderOrder`) are stored **relative
to the data folder when the relative path goes up at most two levels** (`..\wikis\orga`, `..\..\x\y`, `sub\z`),
otherwise absolute (other drive, or deeper up). In memory TW Desk works with absolute paths as today; conversion
happens only on load/save of `config.json`. Consequences:
- Moving the data folder re-writes the stored paths (absolute paths stay; relative ones are recomputed against the
  new location, and may switch between relative and absolute by the same rule).
- Setup export keeps writing absolute paths (as today); import is unaffected.
- Existing absolute paths are converted on the first save after migration.
- The re-point banner compares the resolved absolute paths, so it works for both kinds.
- Included folders are not re-pointed by TW Desk: include paths live in each wiki's `tiddlywiki.info` (relative
  paths travel with the wikis' repos).

### Moving the data folder

**Settings → Data folder** shows the current path and the git chip, with **Move…** and **Use existing…**.
- *Move…*: choose an empty (or non-existing) target folder; TW Desk copies the whole data folder including `.git`,
  verifies the copy, updates `data-folder.json`, then removes the old folder (*my call:* it asks before removing).
  Running servers got the store's path as `TIDDLYWIKI_PLUGIN_PATH` when they started (`src/plugins.js`), so *Move…*
  asks to stop running wikis first (and restarts them afterwards, *my call*).
- *Use existing…*: as above; the old data folder is left where it is.

### Git

- **Normal usage leaves the repo alone** except for real setup changes (see *What goes where*).
- **Repository boundary (user agreed).** The data folder always has its **own** repository, even when the chosen
  folder lies inside another repository (then a nested `git init`). Auto-commit only ever touches the data folder.
- **Auto-commit.** After any change to the data folder (config save, store change, web snapshot saved), TW Desk
  waits for the changes to settle and commits: debounce *about 90 seconds* after the last change (*my call*), and
  once on quit if anything is uncommitted. Only when the repo is in a normal state (no merge/rebase in progress,
  not detached); otherwise it just shows the state, like the wiki chips.
- **Generated message.** The message lists what happened since the last commit, from actions TW Desk recorded as
  they happened, e.g. `Added wiki orga · installed $:/plugins/kixam/moment 1.2.0 · reordered plugin cards`.
  Changes TW Desk didn't record (the user edited the folder by hand) get the existing `defaultMessage` from
  `src/git.js` based on the changed files.
- **Manual changes** made outside TW Desk (editing `config.json` in an editor) are only committed by TW Desk if
  they are part of the next auto-commit – *my call:* auto-commit commits everything changed in the data folder.
- **No auto-push.** The chip turns amber when commits are unpushed for longer than the existing "when changes count
  as old" setting (`git.staleHours`), same as wikis. No push without a click.
- **Where it shows.** A git chip for the data folder in **Settings → Data folder** and, compact, in the home view's
  header (*my call:* header, so the reminder is visible without opening Settings). It uses the same states and
  colours as the wiki chips; clicking it opens the existing Git tab for the data folder (changed files, Commit,
  Push, Pull fast-forward, Fetch, Add remote, Initialize).
- **Pull.** The periodic git check (`git.interval`, with fetch) includes the data folder. If the remote is ahead,
  the chip says so. *My call:* while the branch is known to be behind its remote, auto-commit pauses (changes stay
  uncommitted and visible), so TW Desk doesn't create a divergence itself. *Pull* (fast-forward only, as for wikis)
  stops running wikis first, then reloads `config.json` and refreshes the store and web wikis. If the pull fails
  (diverged, or local changes in the way), the chip shows the state and resolving it is up to the user; auto-commit
  stays paused until the repo is back to normal.
- **Git tab access.** Today the Git tab belongs to a wiki row and `src/main.js` refuses git actions on folders
  outside `gitFolders()`. The data folder gets its own entry point to the same tab and is allowed explicitly
  (how is the builder's call).
- The settings `git.autoCommitOnStop` (wikis) are unaffected; data-folder auto-commit is always on (*my call*; a
  setting can be added later if wanted).

## Constraints

- Windows first (paths, `%APPDATA%`), macOS must keep working (the app already supports it).
- Reuse `src/git.js` / `src/git-ui.js`; the data folder is "one more repository" for them, not a parallel
  implementation.
- `config.json` stays readable JSON in the same shape (minus the local fields), so setup export/import and the
  user's tools keep working.
- Tests: `TW_DESK_USER_DATA` already redirects `userData`; the data folder needs the same (e.g. `TW_DESK_DATA`), so
  tests never touch the user's real data. Headless e2e as usual.
- Never lose data: every move/migration copies first, verifies, and only then removes the source.

## Left to the builder

- Module layout (e.g. a `src/data-folder.js` for pointer, migration, move, local split).
- How `local.json` is merged into the in-memory `config` (*suggestion:* load both into one object in memory, and
  `saveConfig` writes the local fields to `local.json` and the rest to the data folder; write `config.json` only
  when its non-local content changed, so local-only changes never touch the repo).
- Exact dialog wording and the header chip's placement.
- How actions are recorded for commit messages.

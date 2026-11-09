# Plugins → Wikis tab: order, collapsing, inherited plugins, clashes; descriptions for included folders – design

Date: 2026-11-09 · Status: shipped in 0.2.23

## Why

The Plugins window's Wikis tab shows one card per folder (managed wikis, then the folders they include), each listing
the plugins/themes/languages of that folder's own `tiddlywiki.info` plus plugins stored as tiddlers inside it. With
several wikis and shared folders the user can't:

- arrange the cards in an order that suits them, or fold away the ones they don't care about;
- see the **full** set of plugins a wiki gets – TiddlyWiki also loads every plugin of every included folder,
  **transitively** (`$tw.loadWikiTiddlers` recurses into `includeWikis`; loops are skipped with an error);
- notice duplicates or **version clashes** across that include chain;
- know, when removing a plugin from a shared folder, which other wikis lose it.

Separately, on the home view the include pills only show a path; folders that are only included (not managed wikis,
e.g. `_shared/rr-core`) can't carry a description at all.

## Goals

1. **Collapsible cards.** Every card in Plugins → Wikis has a ▸/▾ toggle in its header. Collapsed, the header still
   shows the name, the description (if any) and a count, e.g. `orga · 9 own · 4 from includes`, plus the clash badge
   (goal 5). *Expand all* / *Collapse all* at the top of the tab. Collapsed state is per-viewer convenience
   (localStorage, keyed by folder path; default expanded).
2. **Reorderable cards.** Drag a card by its header (collapsed or expanded) to a new place. The order is saved in
   `config.json` (`pluginsFolderOrder`: list of folder paths), separate from the home view's wiki order. Folders not
   in the list are appended in today's order (managed wikis in list order, then included folders); entries for folders
   no longer known are ignored (and dropped on the next save).
3. **Inherited plugins on each card.** Below the folder's own list, a section *From included wikis* lists every
   plugin/theme/language the folder gets through its includes, **transitively**, in TiddlyWiki's load order. Rows are
   muted and read-only (no Remove; they are changed on the source folder's card) and carry a source badge:
   `from rr-core`, or `via rr-core → x` for deeper levels. Plugins stored as tiddlers inside an included folder are
   listed there too (badge `in wiki <version>`). Folders reachable only through a deeper include also get their own
   card. A missing included folder or an include loop shows as an error line in that section.
4. **Duplicates (info).** A plugin listed by name more than once in a wiki's chain (own list and/or includes) is marked
   `listed twice` / `also from rr-core` on each of its rows. Listed-by-name plugins always resolve to the same copy
   (bundled first, then store), so this is redundancy, not a conflict.
5. **Version clashes (warning).** A clash is when, in one wiki's chain, the same plugin title exists in **different
   versions** from different sources – a store/bundled copy (listed by name) vs. a copy stored as tiddlers inside a
   folder, or two folder-stored copies. The card shows a red badge on the affected rows, e.g.
   `clash: store 1.2.0 · in rr-streams 1.0.3 – rr-streams' copy wins`, naming the winner by TiddlyWiki's load order
   (later wins: included folders depth-first in `includeWikis` order, each folder's listed plugins before its stored
   ones, the wiki itself last). The card header shows `⚠ clash`. The **home view** row of each affected managed wiki
   gets a warning chip `⚠ plugin clash` (tooltip lists the clashing plugins); clicking it opens Plugins → Wikis with
   that card expanded and scrolled into view. Same title, same version from two sources = duplicate (goal 4), not a clash.
6. **Removing from a shared folder.** Removing a plugin on a card whose folder is included by other wikis (directly or
   transitively) asks first, naming every wiki that loses it on its next restart, and those that keep it because their
   own chain still provides it, e.g.
   `Remove kixam/moment from rr-core? orga and priv-orga include rr-core and lose it on their next restart (tw-knowledge keeps it: listed itself).`
   Folders used by no other wiki keep today's behaviour (only the ESSENTIAL check).
7. **Descriptions for included folders.** Every folder TW Desk knows can have a description:
   - a managed wiki → its existing `wiki.description` (unchanged);
   - any other folder → `config.json` `folderDescriptions` (key: folder path as stored/compared via `folderKey`,
     value: text, max 2000 chars like wiki descriptions).
   Edited in the Includes overview dialog (home view, "included by"): a description field per included folder that
   isn't a managed wiki (managed ones show theirs read-only with a hint to edit the wiki). Shown in: the include pill
   tooltip on the home view (path, then description), the Includes overview, and the Plugins card header.
   Setup export/import carries it (on the setup file's `folders` entries, `description`); import does not overwrite an
   existing description.

## Non-goals

- Changing plugin load order inside a `tiddlywiki.info` (order of the `plugins` array).
- Making git checks, auto-commit or the binary-tiddler scan follow transitive includes (they stay one level; separate
  change if wanted).
- Editing an included folder's plugins from the including wiki's card.
- Resolving clashes automatically (the user fixes them, e.g. with *Move to store* or Remove).
- Writing anything into included folders for descriptions (decided: `config.json`).

## Anti-goals

- A warning for a clash that isn't one (same version from two sources is only info).
- Losing the custom order or descriptions when a folder is temporarily missing (keep entries; only drop order entries
  on save when unknown – descriptions are kept).
- Slowing down the home view: clash detection reads the same data the Plugins tab already reads; compute it in main.js
  together with the wiki state, cached by `tiddlywiki.info`/stored-plugin mtimes, not on every render.

## Constraints

- Transitive include resolution mirrors TiddlyWiki: resolve relative to the including folder, recurse depth-first in
  `includeWikis` order, skip a folder already on the current path (loop → error line). The same folder reached twice
  by different paths is loaded twice by TiddlyWiki; listing it once per card is enough (first occurrence), but its
  load position for "who wins" is its last occurrence.
- Only TW Desk's own sources are known: bundled TiddlyWiki plugins, the store, `tiddlers/**/*.json` plugin tiddlers
  (`listStoredInWiki`). Plugins in a folder's `plugins/` subfolder are out of scope (as today).
- No change to how `setList` writes `tiddlywiki.info`.
- Renderer code style as the rest of `plugins-ui.js` (`el()` helper, `pluginAction`).

## Decided

- Order = order of the cards in Plugins → Wikis; reordering by dragging (collapsed) cards, no separate list. *(user)*
- Show all plugins incl. those from included wikis, visually distinct. *(user)*
- Removing from an included folder tells which other wikis include it. *(user)*
- Includes are transitive (TiddlyWiki recurses) – show the whole chain. *(user asked; Claude checked boot.js)*
- Point out duplicates and notify on version clashes. *(user)*
- Include pill tooltip shows the include's description; included folders get descriptions, stored in `config.json`. *(user)*
- Card order stored separately from the home view order; collapsed state in localStorage; clash chip on the home
  view; duplicates as info only; descriptions edited in the Includes overview. *(Claude's calls)*

## Settled after the builder check (Claude's calls)

- **Version of a name-listed plugin** = the copy it resolves to: bundled (wins) else store. Resolving to neither →
  shown as `missing` as today, unknown version, never part of a clash.
- **`knownFolders()` becomes transitive** (managed wikis + all folders reachable through includes, loops skipped).
  `usedBy`/`running` count transitive users, so *Move to store* is refused while any wiki that (transitively) loads the
  folder runs, and the setup export's `folders` (built from `knownFolders()`) includes deeper folders and so carries
  their descriptions. `gitFolders()`, `deleteCheck`/`includedBy` and the binary scan stay one level (non-goal).
- **Folder reached twice in one chain:** its load position for "who wins" and for the removal prompt is its last
  occurrence (as TiddlyWiki loads it again).
- **Removal prompt scope:** only removing a name from a folder's list (`setList` via the card's Remove). Store
  removal (`plugins-remove`, already refused while in use) and folder-stored plugins (only *Move to store*) unchanged.
- **"Keeps it"** = the removed plugin is still provided by any other source in that wiki's chain (own list, another
  folder's list, a stored copy); the prompt names that source (`listed itself`, `via rr-streams`, `stored in x`).
- **Clash data for the home view:** computed in main.js, cached per folder; recomputed on plugin actions
  (`setList`, move to store, install/remove in the store), on includes edits, on wiki start/stop and when the Plugins
  window loads its state – no mtime walk of `tiddlers/` on every state push. A stored plugin added by hand while TW
  Desk runs shows up at the next of these events.

## Left to the builder

Module split (a pure function for chain + duplicates + clashes, unit-tested, e.g. in `plugins.js`), exact badge/chip
wording and styling, drag & drop mechanics (reuse the home view's pattern where it fits), where the clash data rides
in the state pushed to the home view.

# Binary tiddlers: deleting and updating externalized files – design

Date: 2026-11-05 · Status: shipped in 0.2.22 · Builds on `2026-11-04-binary-tiddlers-design.md` (part 1, shipped in 0.2.21)

## Why

Part 1 moves binaries into `files/` (`_canonical_uri: files/<name>`) when a wiki stops. Two everyday actions are not
handled yet:

- **Deleting** a binary tiddler in the wiki removes its `.tid`, but the file in `files/` stays as an orphan forever.
- **Updating** a binary (a new version of a PDF, image, xlsx, docx, …) creates `files/<name> (2).<ext>` and leaves the
  old version as an orphan; with a plain re-import the tiddler also loses its fields.

The user wants both to "just work": deleting the tiddler removes its file; dropping a new version onto an existing
binary tiddler replaces the file under the same name, keeping the tiddler's fields.

**Change of scope:** derivatives (thumbnails, page/slide/sheet images, extracted text, OCR, LibreOffice) from the part 1
design are **parked** – not planned for now. Images and PDFs already display well when externalized.

## Goals

1. **Deletion.** At a policy run (wiki stopped; same triggers as part 1: after stop, at TW Desk start, *Apply binary
   policy now*), a file in `files/` is deleted when
   - it was **in use** at the previous policy run of this wiki (some tiddler's `_canonical_uri` pointed to it), and
   - **no tiddler points to it now** (neither `_canonical_uri` nor `tw-desk-update-of`).
   Files that were never in use – copied in by hand, or only referenced from wikitext such as `[img[files/x.png]]` –
   are never deleted. Known limit (accepted by the user): a file used by a tiddler's `_canonical_uri` *and* by
   wikitext elsewhere is deleted with the tiddler, and the wikitext link breaks.
2. **Update via drop-attach (explicit).** A tiddler with new embedded content (base64) and the field
   `tw-desk-update-of: files/<name>` is externalized **into exactly that file**: the file is replaced, the tiddler gets
   `_canonical_uri: files/<name>` again and the marker field is removed. All other fields stay as the plugin left them.
   If the new content's type needs another extension (png → jpg), the file gets the same stem with the new extension
   (numbered on a clash with another file); the old file then falls under the deletion rule (in use before, unused now).
   A second update before the next stop keeps the marker; only the newest content is written.
3. **Update via plain TiddlyWiki import (implicit).** When an embedded binary would be externalized under a name that
   is taken by a file that was in use at the previous run and is unused now (typically: the user re-imported
   `report.pdf` over the tiddler `report.pdf`, TiddlyWiki replaced it with an embedded one), TW Desk overwrites that file
   instead of creating `report (2).pdf`. A taken name whose file was never in use keeps today's behaviour (numbered).
4. **Backup only where git doesn't have it.** Before a file is deleted or overwritten, TW Desk checks whether git
   holds exactly this version (file tracked in the wiki's repository and unchanged against `HEAD`).
   - Yes → delete / overwrite directly (the old version stays in git history).
   - No (wiki with *Commit files/ with the wiki* unchecked, no repository, or a file never committed / changed since)
     → first move the old file to `<userData>/backup/<timestamp>/<wiki folder name>/files/<name>`.
   This is documented in README and CLAUDE.md.
5. **Report.** Every deletion, update and backup gets a Log line (e.g. `Deleted files/x.png – its tiddler was removed`,
   `Updated files/report.pdf`, `Backed up files/x.png to …`). The row tooltip adds the count of unused files in `files/`
   (never in use, so never deleted automatically) so orphans from before this version stay visible.

## Non-goals

- Thumbnails, page images, extracted text, OCR, LibreOffice (parked).
- Automatic cleanup of files that were never in use (only shown as "unused").
- Detecting references in wikitext.
- Changing how the wiki stores drops: TW Desk still only acts while the wiki is stopped. Updating by drop is the
  drop-attach plugin's part (it sets the marker); the requirements for it are handed to the plugin author separately.
- Shrinking git history.

## Anti-goals

- Deleting a file TW Desk can't prove is orphaned (see Constraints: scan must be complete).
- Losing a version that git doesn't have.
- Touching a running wiki, or anything while quitting (as in part 1).
- Mass deletion by accident (e.g. `tiddlers/` temporarily empty after a branch switch or a broken sync).

## Constraints

- **Policy scope:** deletion and updates run only for wikis whose policy is **externalize**. With *leave as is* and
  *internalize*, TW Desk doesn't delete or overwrite anything in `files/` (a marker field there is left alone).
- **"In use at the previous run"** is remembered per wiki on this machine, in `<userData>/binaries/<wiki id>.json`
  (list of `files/` names in use after the last successful policy run). It is written only at policy runs, never by the
  background scans (a scan while the wiki runs must not "forget" a file whose tiddler was just deleted). The first run
  after updating TW Desk (no record yet) only records and deletes nothing. A wiki removed from TW Desk drops its record.
  Matching uses `folderKey`-style case rules (case-insensitive on Windows/macOS).
- **Complete scan required:** a run deletes nothing if the scan could miss references – a subfolder with
  `tiddlywiki.files` was skipped, a tiddler file couldn't be read or parsed, or `tiddlers/` is missing. `.json` tiddler
  files count: their tiddlers' `_canonical_uri` / `tw-desk-update-of` values are references (part 1 skips `.json`
  files for moving; reading their references is new).
- **Mass-deletion guard:** if a run would delete more than 10 files, or every file that was in use, it deletes nothing,
  logs why and shows a warning chip (`▣ N files to delete`); the ⋯ menu offers *Delete N unused files…* (confirm dialog
  listing them) to do it once.
- Only regular files inside `files/` (path-confined, no symlinks, part 1's `confinedToFiles`) are deleted or
  overwritten; never anything in `tiddlers/`, never directories.
- Overwriting is crash-safe like part 1: write to a temp file, verify, back up the old file if needed, rename into place,
  then rewrite the tiddler. A crash in between leaves the tiddler embedded with its marker, so the next run repeats the
  update.
- `modified` is not changed by TW Desk (the plugin sets it when the user drops a new version).
- Git check: `git ls-files` + `git diff --quiet HEAD -- <file>` (or the porcelain status part 1's git module already
  reads) in the repo that holds the wiki; any git error counts as "git doesn't have it" (→ backup).

## Decided

- Deleting a binary tiddler deletes its file in `files/` at the next policy run. *(user)*
- Updating = dropping a new version onto the existing tiddler; same file name, tiddler fields kept. *(user)*
- Backup only for versions git doesn't have; document it. *(user)*
- "In use" = pointed to by a tiddler's `_canonical_uri` at the previous run; wikitext-only and hand-added files are never
  deleted; the wikitext edge case is accepted. *(user)*
- Derivatives parked. *(user)*
- Marker field name `tw-desk-update-of`, value the old `_canonical_uri` (`files/…`). *(Claude, given to the plugin author)*
- Only for policy *externalize*; record per machine in `<userData>`; complete-scan rule; mass-deletion guard (> 10
  files or all); git "has exactly this version" as the backup test. *(Claude's calls)*

## Settled after the builder check (Claude's calls)

- **What drop-attach leaves on disk** (requirements handed to the plugin author): the tiddler keeps title and fields,
  gets base64 `text` and the new `type`, **`_canonical_uri` removed**, `tw-desk-update-of: <old _canonical_uri>` added.
  TiddlyWiki saves it like any embedded binary: binary file + `.meta` (marker in the `.meta`). Other combinations:
  - marker + `_canonical_uri` (with or without text) → skipped, reason "update marker and _canonical_uri together";
  - marker but no embedded content → skipped, reason "update marker without new content";
  - marker not inside `files/` (fails `filesPath`/confinement) → skipped, reason "update marker outside files/";
  - marker pointing to a file that doesn't exist (yet) → written there as a new file (nothing to overwrite).
  Skipped items keep their marker; nothing is changed.
- **A file other tiddlers still point to is never overwritten.** If another tiddler's `_canonical_uri` (or marker)
  points to the marker's file, the update goes to a new numbered name (as part 1) and the Log says so; the shared file
  stays. Same for the implicit update (goal 3): only an unused file is overwritten.
- **Record after another policy:** any policy run under *leave* / *internalize*, or a change of the wiki's policy or
  folder in Edit, **deletes the record**. The next externalize run only records (deletes and overwrites nothing). Files
  orphaned meanwhile then count as "unused" (shown, never deleted automatically).
- **References from outside `tiddlers/` block but aren't recorded:** tiddlers in included wikis' `tiddlers/` and in the
  wiki's own `plugins/` folder that point to `files/…` count as "in use" for the delete/overwrite decision, but are not
  written into the record (so they never make a file deletable). Store plugins are not read. A scan problem in an
  included folder makes the scan incomplete → no deletions or overwrites in that run.
- **Order of a run:** recovery (part 1) → updates (goal 2) and moves (part 1) incl. implicit overwrites (goal 3) →
  rescan references → deletions → write the record. Implicit overwrites (goal 3) obey the same gates as deletions
  (complete scan, record present); explicit marker updates only need a complete scan.
- **Mass-deletion guard state:** blocked candidates stay in the record (so the warning survives later runs). The ⋯
  menu offers *Delete N unused files…* (confirm dialog listing them) and *Keep these files* (drops them from the record;
  they then count as "unused").
- Moving a file to the backup across drives falls back to copy → verify → delete.

## Left to the builder

Module split (pure logic in `src/binaries.js`, record file and git check in main.js / git.js), the exact Log wording,
tooltip layout, the confirm dialog's look.

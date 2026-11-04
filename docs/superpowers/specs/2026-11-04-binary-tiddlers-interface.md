# TW Desk binary tiddlers – interface for wiki plugins

Status: **draft v1** (2026-11-04) – designed, not implemented yet. Names below are what TW Desk will write; they may
still change before the first release that ships the feature.

Audience: authors of TiddlyWiki plugins (e.g. an attachment viewer) that want to show thumbnails, page previews or
extracted text that TW Desk generates for binary tiddlers.

## What TW Desk does

TW Desk is a desktop manager for TiddlyWiki **folder wikis** (Node.js server per wiki). For binary tiddlers – images,
PDFs, Office files (docx, xlsx, pptx, legacy doc/xls/ppt), audio, video – it can, per wiki:

1. **Externalize / internalize** the binary content (see "The original tiddler").
2. **Generate derivatives**: a thumbnail, one image per page / slide / sheet, and the extracted text (incl. OCR in
   German and English for images and scanned PDFs). Each derivative is an ordinary tiddler.

All of this happens **while the wiki is stopped** (on stop and at TW Desk start). A plugin never sees half-written
state, but it will only see new derivatives after the wiki was restarted. TW Desk changes nothing about how the wiki
looks – displaying derivatives is the plugin's job.

## The original tiddler

Two possible states; all other fields (title, type, tags, created, modified, caption, custom fields) are identical in
both, and TW Desk never bumps `modified`.

| State | `text` | `_canonical_uri` |
|---|---|---|
| embedded (standard import) | base64 content | – |
| externalized | empty | `files/<name>` (relative to the wiki's URL; served by the TiddlyWiki server from `<wiki folder>/files/`) |

A plugin should support both. TiddlyWiki's core already renders either state for image types and PDFs
(`{{Title}}`, `<$image source="Title"/>`). To link/download the binary: `_canonical_uri` if set, else build a data URI
from `type` + `text`.

The externalized file may be **missing** on a given machine (e.g. a git clone where `files/` is not committed). Treat a
failed load as "not available here", not as an error in the tiddler.

Summary fields TW Desk may add to the original (only when derivatives are enabled):

| Field | Meaning |
|---|---|
| `page-count` | number of pages (PDF, docx) or slides (pptx) |
| `sheet-names` | xlsx/xls: sheet names in workbook order, as a TiddlyWiki title list (`[[Sheet 1]] Budget`) |
| `text-truncated` | `yes` when the extracted text hit the size cap |

## Derivative tiddlers

Every derivative is a normal (non-system) tiddler, titled `<original title>/<kind>…`:

| Title | Kind | Type | Content |
|---|---|---|---|
| `<title>/thumb` | `thumb` | image (see below) | thumbnail of the image / first page / first slide |
| `<title>/page/<n>` | `page` | image | page *n* (1-based) of a PDF or docx, slide *n* of a pptx |
| `<title>/sheet/<sheet name>` | `sheet` | image | one xlsx/xls sheet, rendered as a single page |
| `<title>/text` | `text` | `text/plain` | extracted text (text layer, Office XML, or OCR) – stored in `text`, searchable |

Fields on every derivative tiddler:

| Field | Value |
|---|---|
| `tw-desk-derived` | `thumb`, `page`, `sheet` or `text` – **the reliable marker**; match on this, not on the title suffix |
| `derived-from` | title of the original tiddler |
| `derived-hash` | sha256 of the original's content when the derivative was made (TW Desk uses it to detect stale derivatives) |
| `page` | page/slide number (only `page` kind) |
| `sheet` | sheet name (only `sheet` kind) |

Image derivatives have an empty `text` and `_canonical_uri: files/.derived/<…>`; the image format is TW Desk's choice
(JPEG, or PNG where transparency matters) – **use the `type` field, not the file extension**. Sizes: thumbnails small
(about 300 px on the longest side), pages readable (about 1600 px).

What a derivative set may look like for `report.pdf` (12 pages):

```
report.pdf                 type: application/pdf, page-count: 12
report.pdf/thumb           tw-desk-derived: thumb, derived-from: report.pdf
report.pdf/page/1 … /12    tw-desk-derived: page,  derived-from: report.pdf, page: 1 … 12
report.pdf/text            tw-desk-derived: text,  derived-from: report.pdf
```

## Filters

```
<!-- thumbnail of the current tiddler, if any -->
[tw-desk-derived[thumb]derived-from<currentTiddler>]

<!-- pages in order -->
[tw-desk-derived[page]derived-from<currentTiddler>nsort[page]]

<!-- sheets in workbook order (sheet-names keeps the order) -->
[<currentTiddler>get[sheet-names]enlist-input[]addprefix[/sheet/]addprefix<currentTiddler>is[tiddler]]

<!-- all sheets, any order -->
[tw-desk-derived[sheet]derived-from<currentTiddler>]

<!-- extracted text -->
[tw-desk-derived[text]derived-from<currentTiddler>]

<!-- does it have any derivatives? -->
[derived-from<currentTiddler>has[tw-desk-derived]count[]]

<!-- hide all derivatives from lists, search results, recent etc. -->
-[has[tw-desk-derived]]
```

Example thumbnail with fallback to the original image:

```
<$let thumb={{{ [tw-desk-derived[thumb]derived-from<currentTiddler>] }}}>
<%if [<thumb>!is[blank]] %>
<$link to=<<currentTiddler>>><$image source=<<thumb>> width="160"/></$link>
<%elseif [<currentTiddler>get[type]prefix[image/]] %>
<$link to=<<currentTiddler>>><$image source=<<currentTiddler>> width="160"/></$link>
<%endif%>
</$let>
```

## Rules for plugins

- **Read-only**: TW Desk owns every tiddler with `tw-desk-derived`; it overwrites or deletes them on regeneration.
  Don't edit them or add fields to them – put your own data on the original or in your own tiddlers.
- **Derivatives may be absent or incomplete**, always render a fallback:
  - derivatives not enabled for the wiki, or not generated yet (wiki not restarted since import),
  - no LibreOffice on the machine (Office files then have `/text` but maybe no pages, and a `/thumb` only if the file
    has an embedded preview),
  - page cap: only the first 50 pages get page images (configurable), `page-count` still holds the full count,
  - the image file under `files/.derived/` missing on this machine,
  - audio, video and other types get no derivatives.
- **Stale derivatives**: if the original changed since, `derived-hash` no longer matches until TW Desk regenerates
  them at the next stop. Plugins don't need to check this.
- **System tiddlers** (`$:/…`) never get derivatives.
- **Included wikis**: binaries that live in an included wiki (e.g. a shared wiki in `includeWikis`) are not
  externalized and get no derivatives in v1.
- Derivative titles contain `/`; when building titles yourself, append to the original title as shown above
  (TiddlyWiki titles may themselves contain `/`, so prefer the field filters over parsing titles).

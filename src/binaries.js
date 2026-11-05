"use strict";

// Binary tiddlers of TiddlyWiki folder wikis: finding them and moving them between the wiki's tiddlers
// folder and its files folder (externalize / internalize). Plain fs, no Electron.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// The base64 file types TiddlyWiki 5.4.1 registers (boot/boot.js, registerFileType), as [type, extensions]
const BASE64_TABLE = [
	["application/pdf", [".pdf"]],
	["application/zip", [".zip"]],
	["application/x-zip-compressed", [".zip"]],
	["image/jpeg", [".jpg", ".jpeg"]],
	["image/jpg", [".jpg", ".jpeg"]],
	["image/png", [".png"]],
	["image/gif", [".gif"]],
	["image/webp", [".webp"]],
	["image/heic", [".heic"]],
	["image/heif", [".heif"]],
	["image/avif", [".avif"]],
	["image/vnd.microsoft.icon", [".ico"]],
	["image/x-icon", [".ico"]],
	["application/wasm", [".wasm"]],
	["font/woff", [".woff"]],
	["font/woff2", [".woff2"]],
	["font/ttf", [".ttf"]],
	["font/otf", [".otf"]],
	["audio/ogg", [".ogg"]],
	["audio/mp4", [".mp4", ".m4a"]],
	["video/ogg", [".ogm", ".ogv", ".ogg"]],
	["video/webm", [".webm"]],
	["video/mp4", [".mp4"]],
	["audio/mp3", [".mp3"]],
	["audio/mpeg", [".mp3", ".m2a", ".mp2", ".mpa", ".mpg", ".mpga"]],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [".docx"]],
	["application/msword", [".doc"]],
	["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", [".xlsx"]],
	["application/excel", [".xls"]],
	["application/vnd.ms-excel", [".xls"]],
	["application/vnd.openxmlformats-officedocument.presentationml.presentation", [".pptx"]],
	["application/mspowerpoint", [".ppt"]],
	["application/epub+zip", [".epub"]],
	["application/octet-stream", [".octet-stream"]]
];

const BASE64_TYPES = new Set(BASE64_TABLE.map(([type]) => type));
const TYPE_EXTENSIONS = new Map(BASE64_TABLE);
const EXTENSION_OF = new Map(BASE64_TABLE.map(([type, exts]) => [type, exts[0]]));
// As in TW, a later registration of the same extension wins
const TYPE_OF = new Map();
for (const [type, exts] of BASE64_TABLE) {
	for (const ext of exts) {
		TYPE_OF.set(ext, type);
	}
}

// TW's $tw.boot.excludeRegExp
const EXCLUDE = /^\.DS_Store$|^.*\.meta$|^\..*\.swp$|^\._.*$|^\.git$|^\.github$|^\.vscode$|^\.hg$|^\.lock-wscript$|^\.svn$|^\.wafpickle-.*$|^CVS$|^npm-debug\.log$/;

function extensionFor(type) {
	return EXTENSION_OF.get(type) || ".bin";
}

function typeForExtension(ext) {
	return TYPE_OF.get(String(ext).toLowerCase()) || null;
}

// "key: value" lines as TW's $tw.utils.parseFields reads them (lines starting with # are comments)
function fieldLines(lines) {
	const fields = {};
	for (const line of lines) {
		const colon = line.indexOf(":");
		if (line.charAt(0) !== "#" && colon !== -1) {
			const name = line.slice(0, colon).trim();
			if (name) {
				fields[name] = line.slice(colon + 1).trim();
			}
		}
	}
	return fields;
}

// A .tid file: "key: value" lines up to the first empty line, then the body
function parseFields(text) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length && lines[i] !== "") {
		i++;
	}
	return { fields: fieldLines(lines.slice(0, i)), body: lines.slice(i + 1).join("\n") };
}

// A .meta file: TW reads every line, empty lines included
function parseMeta(text) {
	return fieldLines(text.split(/\r?\n/));
}

function serializeFields(fields, body) {
	const keys = Object.keys(fields).filter(k => k !== "title");
	if ("title" in fields) {
		keys.unshift("title");
	}
	const header = keys.map(k => k + ": " + fields[k]).join("\n") + "\n";
	return body === undefined ? header : header + "\n" + body;
}

// Whether the fields survive the header format unchanged (TW falls back to JSON files otherwise)
function fieldsSafe(fields) {
	return Object.entries(fields).every(([name, value]) => {
		if (/[:#]/.test(name)) {
			return false;
		}
		if (name === "text") {
			return true;
		}
		const s = String(value);
		return !/[\x00-\x1f]/.test(s) && s === s.trim();
	});
}

function isExternalUri(uri) {
	return /^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith("/") || uri.startsWith("//");
}

// As TW's server decodes /files/ requests ($tw.utils.decodeURIComponentSafe)
function decodeUri(uri) {
	try {
		return decodeURIComponent(uri);
	} catch (e) {
		return uri;
	}
}

function readFields(file) {
	try {
		return parseFields(fs.readFileSync(file, "utf8"));
	} catch (e) {
		return null;
	}
}

function readMeta(file) {
	try {
		return parseMeta(fs.readFileSync(file, "utf8"));
	} catch (e) {
		return null;
	}
}

// Tiddlers of a .json file, or null when it can't be read or parsed
function readJsonTiddlers(file) {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		return (Array.isArray(data) ? data : [data]).filter(t => t && typeof t === "object");
	} catch (e) {
		return null;
	}
}

function jsonHasBinary(tiddlers) {
	return !!tiddlers && tiddlers.some(t => BASE64_TYPES.has(t.type) && !String(t.title).startsWith("$:/"));
}

// Field written by TW Desk next to a new copy of a file in files/: the old _canonical_uri it replaces
const MARKER = "tw-desk-update-of";

const defaultCaseInsensitive = () => process.platform === "win32" || process.platform === "darwin";

// The key under which names in files/ are compared
function nameKey(name, caseInsensitive = defaultCaseInsensitive()) {
	return caseInsensitive ? name.toLowerCase() : name;
}

// The name inside files/ that a _canonical_uri points to, "/"-separated; null for anything else
function fileNameOfUri(uri) {
	if (typeof uri !== "string" || isExternalUri(uri)) {
		return null;
	}
	const decoded = decodeUri(uri).replace(/\\/g, "/");
	if (decoded.includes("\0") || isExternalUri(decoded)) {
		return null;
	}
	const normal = path.posix.normalize(decoded);
	if (!normal.startsWith("files/") || normal.split("/").includes("..")) {
		return null;
	}
	return normal.slice("files/".length) || null;
}

// Regular files under <folder>/files, relative to it, "/"-separated; no symlinks, directories or temp files
function listFiles(folder) {
	const root = path.join(folder, "files");
	const result = [];
	function walk(dir, prefix) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				walk(path.join(dir, entry.name), prefix + entry.name + "/");
			} else if (entry.isFile() && !entry.name.endsWith(TMP)) {
				result.push(prefix + entry.name);
			}
		}
	}
	walk(root, "");
	return result;
}

function scanFolder(folder, options = {}) {
	const sub = options.sub || "tiddlers";
	const caseInsensitive = options.caseInsensitive === undefined ? defaultCaseInsensitive() : options.caseInsensitive;
	const scan = {
		folder,
		embedded: { count: 0, bytes: 0 },
		externalized: { count: 0, bytes: 0, missing: 0 },
		items: [],
		skipped: [],
		references: new Map(),
		complete: true,
		problems: []
	};

	function problem(text) {
		scan.complete = false;
		scan.problems.push(text);
	}

	// The files/ names a tiddler's _canonical_uri and update marker point to
	function addReferences(fields, title) {
		for (const field of ["_canonical_uri", MARKER]) {
			const name = fileNameOfUri(fields[field]);
			if (name === null) {
				continue;
			}
			const key = nameKey(name, caseInsensitive);
			let ref = scan.references.get(key);
			if (!ref) {
				ref = { name, titles: [] };
				scan.references.set(key, ref);
			}
			if (!ref.titles.includes(title)) {
				ref.titles.push(title);
			}
		}
	}

	function add(item) {
		scan.items.push(item);
		const sum = scan[item.state];
		sum.count++;
		sum.bytes += item.bytes;
		if (item.missing) {
			sum.missing++;
		}
	}

	function scanTid(file) {
		const parsed = readFields(file);
		if (!parsed) {
			problem("Can't read " + file);
			return;
		}
		addReferences(parsed.fields, parsed.fields.title || "");
		if (!BASE64_TYPES.has(parsed.fields.type) || !parsed.fields.title
			|| parsed.fields.title.startsWith("$:/")) {
			return;
		}
		const { fields, body } = parsed;
		const uri = fields._canonical_uri;
		if (uri) {
			if (isExternalUri(uri)) {
				return;
			}
			let bytes = 0;
			let missing = false;
			try {
				bytes = fs.statSync(path.join(folder, decodeUri(uri))).size;
			} catch (e) {
				missing = true;
			}
			add({ title: fields.title, type: fields.type, state: "externalized", form: "tid", file, meta: null, uri, bytes, missing });
		} else {
			const bytes = Buffer.from(body.trim(), "base64").length;
			add({ title: fields.title, type: fields.type, state: "embedded", form: "tid", file, meta: null, bytes });
		}
	}

	function scanMeta(file, name) {
		const fields = readMeta(file);
		if (!fields) {
			problem("Can't read " + file);
			return;
		}
		addReferences(fields, fields.title || name.slice(0, -".meta".length));
	}

	function scanFile(file, name) {
		const ext = path.extname(name).toLowerCase();
		if (ext === ".tid") {
			scanTid(file);
		} else if (ext === ".json") {
			const tiddlers = readJsonTiddlers(file);
			if (!tiddlers) {
				problem("Can't parse " + file);
				return;
			}
			for (const t of tiddlers) {
				addReferences(t, t.title === undefined || t.title === null ? "" : String(t.title));
			}
			if (jsonHasBinary(tiddlers)) {
				scan.skipped.push({ file, reason: "json" });
			}
		} else if (TYPE_OF.has(ext)) {
			const metaFile = file + ".meta";
			const meta = fs.existsSync(metaFile) ? metaFile : null;
			const fields = meta ? readMeta(meta) || {} : {};
			const title = fields.title || name;
			const type = fields.type || TYPE_OF.get(ext);
			if (title.startsWith("$:/") || !BASE64_TYPES.has(type)) {
				return;
			}
			add({ title, type, state: "embedded", form: "file", file, meta, bytes: fs.statSync(file).size });
		}
	}

	const root = path.join(folder, sub);
	const optional = !!options.optional;

	function walk(dir) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			if (!(optional && dir === root && e.code === "ENOENT")) {
				problem("Can't read " + dir);
			}
			return;
		}
		if (entries.some(e => e.name === "tiddlywiki.files")) {
			scan.skipped.push({ file: dir, reason: "tiddlywiki.files" });
			problem("Skipped " + dir + " (tiddlywiki.files)");
			return;
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const full = path.join(dir, entry.name);
			// TiddlyWiki follows symlinks, this walk doesn't: what lies behind them is unknown
			if (entry.isSymbolicLink() && (entry.name.endsWith(".meta") || !EXCLUDE.test(entry.name))) {
				problem("Skipped " + full + " (symlink)");
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".meta")) {
				scanMeta(full, entry.name);
			}
			if (EXCLUDE.test(entry.name)) {
				continue;
			}
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile()) {
				scanFile(full, entry.name);
			}
		}
	}

	walk(root);
	return scan;
}

// A file name for a binary tiddler in filesDir: reuses an existing file with the same content,
// otherwise avoids clashes with "name (2).ext"
function fileNameFor(title, type, filesDir, sha256) {
	const { stem, ext } = safeName(title, type);
	for (let n = 1; ; n++) {
		const name = stem + (n === 1 ? "" : " (" + n + ")") + ext;
		const file = path.join(filesDir, name);
		if (!fs.existsSync(file)) {
			return { name, reuse: false };
		}
		if (hashOf(fs.readFileSync(file)) === sha256) {
			return { name, reuse: true };
		}
	}
}

// A Windows-safe file name for a title, with the extension of the type
function safeName(title, type) {
	// Always the lower-case extension: TW's /files/ route looks up the content type case-sensitively
	let ext = extensionFor(type);
	// Keep a registered secondary extension of the type (photo.jpeg, song.m4a) instead of adding the first one
	const own = path.extname(String(title)).toLowerCase();
	if (own && own !== ext && (TYPE_EXTENSIONS.get(type) || []).includes(own)) {
		ext = own;
	}
	let stem = String(title).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
	if (stem.toLowerCase().endsWith(ext)) {
		stem = stem.slice(0, stem.length - ext.length);
	}
	stem = stem.replace(/[. ]+$/, "");
	// Room for the extension and a " (n)" suffix
	stem = stem.slice(0, 120 - ext.length - 8).replace(/[. ]+$/, "") || "file";
	// Windows can't create CON.png, nul.tar.pdf etc.
	stem = stem.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i, "$&_");
	return { stem, ext };
}

function hashOf(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

// ---- Applying a policy ----
//
// Safety: content is only deleted after its new copy is written (temp file + rename) and verified
// (size + sha256). Every state a crash can leave behind is either harmless (stray temp or .meta files) or
// the same tiddler in both forms, which the next run cleans up ("recovered").

const TMP = ".tw-desk-tmp";
const UNSAFE = "fields can't be written to a .tid/.meta file";
const TWO_FILES = "two tiddler files with this title";
const NO_META = "no .meta file – TiddlyWiki titles it with its full path";
const MARKER_AND_URI = "update marker and _canonical_uri together";
const MARKER_EMPTY = "update marker without new content";
const MARKER_OUTSIDE = "update marker outside files/";
const SCAN_WAITS = "scan incomplete – update waits";

class Skip extends Error {}

function toBuffer(data) {
	return Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
}

function verify(file, data) {
	const got = fs.readFileSync(file);
	if (got.length !== data.length || hashOf(got) !== hashOf(data)) {
		throw new Error("Verifying " + file + " failed");
	}
}

function writeSynced(file, data, flags = "w") {
	const fd = fs.openSync(file, flags);
	try {
		fs.writeFileSync(fd, data);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

// Writes target via a temp file and checks what landed on disk
function writeVerified(target, data) {
	data = toBuffer(data);
	writeSynced(target + TMP, data);
	fs.renameSync(target + TMP, target);
	verify(target, data);
}

// The absolute path of a _canonical_uri inside <folder>/files, or null if it points elsewhere
function filesPath(folder, uri) {
	if (!uri || isExternalUri(uri)) {
		return null;
	}
	const filesDir = path.resolve(folder, "files");
	const file = path.resolve(folder, decodeUri(uri));
	const rel = path.relative(filesDir, file);
	if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel) || file.includes("\0")) {
		return null;
	}
	return file;
}

// Whether a file really lies inside <folder>/files: a symlink (the file or a folder above it) must not lead out
function confinedToFiles(folder, file) {
	try {
		const real = fs.realpathSync(file);
		const rel = path.relative(fs.realpathSync(path.join(folder, "files")), real);
		return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
	} catch (e) {
		return false;
	}
}

// The _canonical_uri for a file name in files/ (# and % would break the URL)
function uriFor(name) {
	return "files/" + name.replace(/%/g, "%25").replace(/#/g, "%23");
}

function decodeBase64(text) {
	const b64 = text.replace(/\s+/g, "");
	const bytes = Buffer.from(b64, "base64");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || bytes.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) {
		throw new Error("The text is not valid base64");
	}
	return bytes;
}

// Fields (without text) and bytes of an embedded item, as TiddlyWiki loads it
function loadEmbedded(item) {
	if (item.form === "tid") {
		const { fields, body } = parseFields(fs.readFileSync(item.file, "utf8"));
		delete fields.text;
		return { fields, bytes: decodeBase64(body) };
	}
	const fields = item.meta ? parseMeta(fs.readFileSync(item.meta, "utf8")) : {};
	if (MARKER in fields && "_canonical_uri" in fields) {
		throw new Skip(MARKER_AND_URI);
	}
	if ("text" in fields || "_canonical_uri" in fields) {
		throw new Skip("the .meta file has a text or _canonical_uri field");
	}
	if (!fields.title) {
		throw new Skip(NO_META);
	}
	if (!fields.type) {
		fields.type = item.type;
	}
	return { fields, bytes: fs.readFileSync(item.file) };
}

// Fields, body and the file in files/ of an externalized item
function loadExternalized(folder, item) {
	const { fields, body } = parseFields(fs.readFileSync(item.file, "utf8"));
	return { fields, body, source: filesPath(folder, fields._canonical_uri) };
}

function sameFields(a, b) {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(k => k in b && a[k] === b[k]);
}

function deleteEmbedded(item) {
	// The binary first: a .meta left alone is ignored by TiddlyWiki, a binary without its .meta isn't
	fs.unlinkSync(item.file);
	if (item.meta) {
		fs.unlinkSync(item.meta);
	}
}

// The path of a "/"-separated name below base
function pathIn(base, name) {
	return path.join(base, ...name.split("/"));
}

// Like fs.existsSync, but true for a dangling symlink too
function lexists(file) {
	try {
		fs.lstatSync(file);
		return true;
	} catch (e) {
		return false;
	}
}

// A regular file (not a symlink) that really lies inside <folder>/files
function regularInFiles(folder, file) {
	try {
		return fs.lstatSync(file).isFile() && confinedToFiles(folder, file);
	} catch (e) {
		return false;
	}
}

// "name (n).ext" for a "/"-separated name, n = 1 meaning the name itself
function numberedVariant(name, n) {
	const slash = name.lastIndexOf("/");
	const base = name.slice(slash + 1);
	const ext = path.extname(base);
	return name.slice(0, slash + 1) + base.slice(0, base.length - ext.length) + (n === 1 ? "" : " (" + n + ")") + ext;
}

// The first variant of name that is free or already holds this content; blocked(name) rules out free names
// other tiddlers point to
function numberedName(folder, name, sha256, blocked) {
	const filesDir = path.join(folder, "files");
	for (let n = 1; ; n++) {
		const candidate = numberedVariant(name, n);
		const file = pathIn(filesDir, candidate);
		if (lexists(file)) {
			if (regularInFiles(folder, file) && hashOf(fs.readFileSync(file)) === sha256) {
				return { name: candidate, reuse: true };
			}
		} else if (!blocked(candidate)) {
			return { name: candidate, reuse: false };
		}
	}
}

// Moves a file into backupDir as <name> (folders created, " (2)" on a clash); returns the absolute target
function backupFile(file, backupDir, name) {
	let target;
	for (let n = 1; lexists(target = pathIn(backupDir, numberedVariant(name, n))); n++) {
		// next number
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	try {
		fs.renameSync(file, target);
	} catch (e) {
		if (e.code !== "EXDEV") {
			throw e;
		}
		// On disk before the original goes: it may be the only copy git doesn't hold
		const bytes = fs.readFileSync(file);
		writeSynced(target, bytes, "wx");
		verify(target, bytes);
		fs.unlinkSync(file);
	}
	return path.resolve(target);
}

// Writes bytes to files/<name> via a verified temp file. With overwrite the existing file is replaced, after
// moving it to the backup unless git has it (gitHas holds nameKeys).
function writeIntoFiles(folder, name, bytes, { overwrite = false, gitHas = new Set(), backupDir = null, caseInsensitive } = {}) {
	const filesDir = path.join(folder, "files");
	const target = pathIn(filesDir, name);
	// No folder of the name may lead out of files/ (a symlinked subfolder)
	let existing = path.dirname(target);
	while (existing !== filesDir && !lexists(existing)) {
		existing = path.dirname(existing);
	}
	if (existing !== filesDir && !confinedToFiles(folder, existing)) {
		throw new Error("files/" + name + " is not in the files folder");
	}
	let needsBackup = false;
	if (overwrite) {
		if (!regularInFiles(folder, target)) {
			throw new Error("files/" + name + " is not a regular file in the files folder");
		}
		needsBackup = !gitHas.has(nameKey(name, caseInsensitive));
		if (needsBackup && !backupDir) {
			throw new Error("No backup folder to keep the old files/" + name);
		}
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	writeSynced(target + TMP, bytes);
	verify(target + TMP, bytes);
	let backup = null;
	if (!overwrite && lexists(target)) {
		throw new Error("files/" + name + " appeared while writing");
	}
	if (needsBackup) {
		backup = backupFile(target, backupDir, name);
	}
	fs.renameSync(target + TMP, target);
	verify(target, bytes);
	return { backup };
}

// Where an update marker's new content goes: { name, reuse, overwrite, replaced, reason }
function markerTarget(folder, fields, sha256, title, run) {
	const uri = fields[MARKER];
	const name = fileNameOfUri(uri);
	if (name === null || !filesPath(folder, uri)) {
		throw new Skip(MARKER_OUTSIDE);
	}
	if (!run.complete) {
		throw new Skip(SCAN_WAITS);
	}
	const blocked = n => run.taken(n, title);
	const ext = path.extname(name).toLowerCase();
	if (!(TYPE_EXTENSIONS.get(fields.type) || []).includes(ext)) {
		const renamed = name.slice(0, name.length - ext.length) + extensionFor(fields.type);
		return Object.assign(numberedName(folder, renamed, sha256, blocked), { replaced: null, reason: "marker" });
	}
	if (run.taken(name, title)) {
		return Object.assign(numberedName(folder, name, sha256, blocked), { replaced: null, reason: "shared" });
	}
	const file = pathIn(path.join(folder, "files"), name);
	if (!lexists(file)) {
		return { name, reuse: false, replaced: null, reason: "marker" };
	}
	if (!regularInFiles(folder, file)) {
		return Object.assign(numberedName(folder, name, sha256, blocked), { replaced: null, reason: "marker" });
	}
	if (hashOf(fs.readFileSync(file)) === sha256) {
		return { name, reuse: true, replaced: null, reason: "marker" };
	}
	return { name, reuse: false, overwrite: true, replaced: name, reason: "marker" };
}

// Re-import over a file that was in use at the last run and is unused now: overwrite it instead of numbering
function reimportTarget(folder, base, type, sha256, title, run) {
	const { stem, ext } = safeName(base, type);
	const name = stem + ext;
	const file = pathIn(path.join(folder, "files"), name);
	if (!run.record || !run.complete || !run.record.has(nameKey(name, run.caseInsensitive)) || run.taken(name, title)
		|| !regularInFiles(folder, file) || hashOf(fs.readFileSync(file)) === sha256) {
		return null;
	}
	return { name, reuse: false, overwrite: true, replaced: name, reason: "reimport" };
}

// The done entry (without title) for an embedded item moved to files/
function externalize(folder, item, run) {
	const { fields, bytes } = loadEmbedded(item);
	const marked = MARKER in fields;
	if (marked && bytes.length === 0) {
		throw new Skip(MARKER_EMPTY);
	}
	const sha256 = hashOf(bytes);
	const target = marked ? markerTarget(folder, fields, sha256, fields.title, run) : null;
	const newFields = Object.assign({}, fields);
	delete newFields[MARKER];
	if (!fieldsSafe(newFields)) {
		throw new Skip(UNSAFE);
	}
	if (bytes.length === 0) {
		throw new Skip("no content");
	}
	const tidFile = item.form === "file" ? item.file + ".tid" : item.file;
	if (item.form === "file" && fs.existsSync(tidFile)) {
		throw new Error(path.basename(tidFile) + " already exists");
	}
	const filesDir = path.join(folder, "files");
	fs.mkdirSync(filesDir, { recursive: true });
	// A binary file keeps its name (TiddlyWiki made it from the title), a .tid's content is named after the title
	const base = item.form === "file" ? path.basename(item.file) : fields.title;
	const chosen = target || reimportTarget(folder, base, fields.type, sha256, fields.title, run)
		|| fileNameFor(base, fields.type, filesDir, sha256);
	const { name } = chosen;
	let backup = null;
	if (chosen.reuse) {
		verify(pathIn(filesDir, name), bytes);
	} else {
		backup = writeIntoFiles(folder, name, bytes, {
			overwrite: !!chosen.overwrite, gitHas: run.gitHas, backupDir: run.backupDir, caseInsensitive: run.caseInsensitive
		}).backup;
	}
	run.claimed.add(nameKey(name, run.caseInsensitive));
	newFields._canonical_uri = uriFor(name);
	writeVerified(tidFile, serializeFields(newFields));
	if (item.form === "file") {
		deleteEmbedded(item);
	}
	if (!chosen.reason) {
		return { action: "externalized", bytes: bytes.length };
	}
	return { action: "updated", bytes: bytes.length, name, replaced: chosen.replaced, backup, reason: chosen.reason };
}

function internalize(folder, item) {
	const { fields, body, source } = loadExternalized(folder, item);
	if (!source) {
		throw new Skip("file is not in the files folder");
	}
	if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
		throw new Skip("file not on this machine");
	}
	if (!confinedToFiles(folder, source)) {
		throw new Skip("file is not in the files folder");
	}
	if (body.trim() !== "") {
		throw new Skip("the .tid has text as well as _canonical_uri");
	}
	if (!fieldsSafe(fields)) {
		throw new Skip(UNSAFE);
	}
	const metaFields = Object.assign({}, fields);
	delete metaFields._canonical_uri;
	delete metaFields.text;
	const ext = extensionFor(metaFields.type);
	const base = item.file.slice(0, -".tid".length);
	let target = base;
	if (!item.file.toLowerCase().endsWith(".tid") || !base.toLowerCase().endsWith(ext.toLowerCase())) {
		const { stem, ext: safeExt } = safeName(metaFields.title, metaFields.type);
		target = path.join(path.dirname(item.file), stem + safeExt);
	}
	if (fs.existsSync(target)) {
		throw new Error(path.basename(target) + " already exists");
	}
	const metaText = Buffer.from(serializeFields(metaFields), "utf8");
	const metaFile = target + ".meta";
	// A .meta without its binary is ignored by TiddlyWiki; one with these fields is left from an interrupted run
	if (fs.existsSync(metaFile) && !sameFields(parseMeta(fs.readFileSync(metaFile, "utf8")), metaFields)) {
		throw new Error(path.basename(metaFile) + " already exists");
	}
	const bytes = fs.readFileSync(source);
	// The binary appears last, so TiddlyWiki never sees it without its .meta
	writeSynced(target + TMP, bytes);
	verify(target + TMP, bytes);
	writeVerified(metaFile, metaText);
	fs.renameSync(target + TMP, target);
	verify(target, bytes);
	fs.unlinkSync(item.file);
	return bytes.length;
}

// The same title as an embedded and an externalized item: left over from an interrupted run if content
// and fields match
function recover(folder, policy, items) {
	const embedded = items.filter(i => i.state === "embedded");
	const external = items.filter(i => i.state === "externalized");
	if (embedded.length !== 1 || external.length !== 1) {
		throw new Error(TWO_FILES);
	}
	const emb = loadEmbedded(embedded[0]);
	const ext = loadExternalized(folder, external[0]);
	const extFields = Object.assign({}, ext.fields);
	delete extFields._canonical_uri;
	// An update stopped after writing the .tid: the embedded copy still carries the marker
	const embFields = Object.assign({}, emb.fields);
	delete embFields[MARKER];
	if (!ext.source || !fs.existsSync(ext.source) || ext.body.trim() !== "" || !sameFields(embFields, extFields)
		|| hashOf(fs.readFileSync(ext.source)) !== hashOf(emb.bytes)) {
		throw new Error(TWO_FILES);
	}
	if (policy === "externalize") {
		deleteEmbedded(embedded[0]);
	} else {
		fs.unlinkSync(external[0].file);
	}
	return emb.bytes.length;
}

// Removes temp files an interrupted run left behind (nothing refers to them)
function removeTempIn(dir, recursive) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith(TMP)) {
			try {
				fs.rmSync(full, { force: true });
			} catch (e) {
				console.error("Could not remove " + full + ": " + e.message);
			}
		} else if (recursive && entry.isDirectory()) {
			removeTempIn(full, true);
		}
	}
}

// For a wiki folder, before its server starts: TiddlyWiki would load leftover temp files as tiddlers. Never throws.
function removeTempFiles(folder) {
	removeTempIn(path.join(folder, "tiddlers"), true);
	removeTempIn(path.join(folder, "files"), true);
}

// What a policy run knows besides the items: references to files/ (own tiddlers/ and outside), names written in
// this run, and the caller's record, git and backup information
function runContext(scan, options) {
	const caseInsensitive = options.caseInsensitive === undefined ? defaultCaseInsensitive() : options.caseInsensitive;
	const outside = options.outside || null;
	const references = new Map();
	for (const refs of [scan.references, outside ? outside.references : new Map()]) {
		for (const [key, ref] of refs) {
			const known = references.get(key);
			references.set(key, known
				? { name: known.name, titles: known.titles.concat(ref.titles.filter(t => !known.titles.includes(t))) }
				: { name: ref.name, titles: ref.titles.slice() });
		}
	}
	const run = {
		caseInsensitive,
		references,
		complete: scan.complete && (!outside || outside.complete),
		record: options.record ? new Set(options.record.filter(n => typeof n === "string").map(n => nameKey(n, caseInsensitive))) : null,
		gitHas: options.gitHas || new Set(),
		backupDir: options.backupDir || null,
		// nameKeys written or reused in this run: never overwritten implicitly afterwards
		claimed: new Set()
	};
	// Whether a name in files/ is used by a tiddler other than title, or was written in this run
	run.taken = (name, title) => {
		const key = nameKey(name, caseInsensitive);
		const ref = references.get(key);
		return run.claimed.has(key) || (!!ref && ref.titles.some(t => t !== title));
	};
	return run;
}

// Externalizes or internalizes the binary tiddlers in <folder>/tiddlers; problems with one tiddler
// are reported, not thrown. The wiki must not be running. With externalize, embedded tiddlers carrying the
// update marker replace their file in files/, and re-imports may overwrite a file that was in use at the
// previous run (options.record) and is unused now.
function applyPolicy(folder, policy, options = {}) {
	if (policy !== "externalize" && policy !== "internalize") {
		throw new Error("Unknown policy: " + policy);
	}
	const result = { done: [], skipped: [], errors: [] };
	removeTempFiles(folder);
	const scan = scanFolder(folder, { caseInsensitive: options.caseInsensitive });
	const run = runContext(scan, options);
	const byTitle = new Map();
	for (const item of scan.items) {
		if (item.form === "file" && !item.meta) {
			// Its title in TW is the absolute path; moving it would rename the tiddler
			if (policy === "externalize") {
				result.skipped.push({ title: item.title, reason: NO_META });
			}
			continue;
		}
		byTitle.set(item.title, (byTitle.get(item.title) || []).concat(item));
	}
	// Recovery, updates and moves
	for (const [title, items] of byTitle) {
		try {
			if (items.length > 1) {
				result.done.push({ title, action: "recovered", bytes: recover(folder, policy, items) });
			} else if (policy === "externalize" && items[0].state === "embedded") {
				result.done.push(Object.assign({ title }, externalize(folder, items[0], run)));
			} else if (policy === "externalize" && items[0].state === "externalized") {
				if (MARKER in loadExternalized(folder, items[0]).fields) {
					throw new Skip(MARKER_AND_URI);
				}
			} else if (policy === "internalize" && items[0].state === "externalized") {
				result.done.push({ title, action: "internalized", bytes: internalize(folder, items[0]) });
			}
		} catch (e) {
			if (e instanceof Skip) {
				result.skipped.push({ title, reason: e.message });
			} else {
				result.errors.push({ title, message: e.message });
			}
		}
	}
	// files/ is now as updates and moves left it (run.claimed holds the names they wrote)
	if (policy === "externalize") {
		Object.assign(result, deleteUnused(folder, options, run, result.errors));
	} else {
		Object.assign(result, { deleted: [], pending: [], guard: null, incomplete: null, record: null });
	}
	return result;
}

// Names deduplicated by nameKey (the first spelling wins), sorted
function uniqueNames(names, caseInsensitive) {
	const byKey = new Map();
	for (const name of names) {
		const key = nameKey(name, caseInsensitive);
		if (!byKey.has(key)) {
			byKey.set(key, name);
		}
	}
	return [...byKey.values()].sort();
}

// After updates and moves: deletes the files in files/ that were in use at the previous run (options.record) and
// aren't referenced any more, unless the scan is incomplete or the mass-deletion guard holds them back. Returns
// { deleted, pending, guard, incomplete, record } with the new record to write; failed deletes go to errors.
function deleteUnused(folder, options, run, errors) {
	const caseInsensitive = run.caseInsensitive;
	const after = scanFolder(folder, { caseInsensitive });
	const outside = options.outside || null;
	// Names written in this run count as in use even if writing their tiddler failed
	const inUse = new Set([...after.references.keys(), ...(outside ? outside.references.keys() : []), ...run.claimed]);
	// Outside references protect files but are never recorded
	const referenced = [...after.references.values()].map(r => r.name);
	const problems = after.problems.concat(outside ? outside.problems : []);
	const complete = after.complete && (!outside || outside.complete);
	const out = { deleted: [], pending: [], guard: null, incomplete: complete ? null : problems[0] || "scan incomplete", record: null };
	if (!options.record) {
		out.record = uniqueNames(referenced, caseInsensitive);
		return out;
	}
	// Only names that stay inside files/ ("a/../b", absolute paths and non-strings are dropped)
	const old = uniqueNames(options.record.filter(n => typeof n === "string" && fileNameOfUri(uriFor(n)) === n), caseInsensitive);
	if (!complete) {
		out.record = uniqueNames(referenced.concat(old), caseInsensitive);
		return out;
	}
	const filesDir = path.join(folder, "files");
	// Entries whose file is missing or isn't a regular file in files/ are dropped from the record
	const present = old.filter(name => regularInFiles(folder, pathIn(filesDir, name)));
	const candidates = present.filter(name => !inUse.has(nameKey(name, caseInsensitive)));
	let toDelete = candidates;
	if (Array.isArray(options.confirmDelete)) {
		const confirmed = new Set(options.confirmDelete.filter(n => typeof n === "string").map(n => nameKey(n, caseInsensitive)));
		toDelete = candidates.filter(name => confirmed.has(nameKey(name, caseInsensitive)));
	} else if (candidates.length > 10) {
		out.guard = { reason: "many", count: candidates.length };
	} else if (candidates.length > 0 && candidates.length === present.length && present.length >= 3) {
		out.guard = { reason: "all", count: candidates.length };
	}
	if (out.guard) {
		toDelete = [];
	}
	const deleting = new Set(toDelete);
	out.pending = candidates.filter(name => !deleting.has(name));
	for (const name of toDelete) {
		const file = pathIn(filesDir, name);
		try {
			if (!regularInFiles(folder, file)) {
				throw new Error("files/" + name + " is not a regular file in the files folder");
			}
			let backup = null;
			if (run.gitHas.has(nameKey(name, caseInsensitive))) {
				fs.unlinkSync(file);
			} else if (run.backupDir) {
				backup = backupFile(file, run.backupDir, name);
			} else {
				throw new Error("No backup folder to keep files/" + name);
			}
			out.deleted.push({ name, backup });
		} catch (e) {
			errors.push({ title: "files/" + name, message: e.message });
			out.pending.push(name);
		}
	}
	out.pending.sort();
	out.record = uniqueNames(referenced.concat(out.pending), caseInsensitive);
	return out;
}

module.exports = { BASE64_TYPES, extensionFor, fileNameFor, typeForExtension, parseFields, serializeFields, fieldsSafe, scanFolder, nameKey, fileNameOfUri, listFiles, MARKER, applyPolicy, backupFile, removeTempFiles };

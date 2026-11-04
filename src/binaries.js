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

function jsonHasBinary(file) {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		return (Array.isArray(data) ? data : [data]).some(t => t && typeof t === "object"
			&& BASE64_TYPES.has(t.type) && !String(t.title).startsWith("$:/"));
	} catch (e) {
		return false;
	}
}

function scanFolder(folder) {
	const scan = {
		folder,
		embedded: { count: 0, bytes: 0 },
		externalized: { count: 0, bytes: 0, missing: 0 },
		items: [],
		skipped: []
	};

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
		if (!parsed || !BASE64_TYPES.has(parsed.fields.type) || !parsed.fields.title
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

	function scanFile(file, name) {
		const ext = path.extname(name).toLowerCase();
		if (ext === ".tid") {
			scanTid(file);
		} else if (ext === ".json") {
			if (jsonHasBinary(file)) {
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

	function walk(dir) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			return;
		}
		if (entries.some(e => e.name === "tiddlywiki.files")) {
			scan.skipped.push({ file: dir, reason: "tiddlywiki.files" });
			return;
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (EXCLUDE.test(entry.name)) {
				continue;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile()) {
				scanFile(full, entry.name);
			}
		}
	}

	walk(path.join(folder, "tiddlers"));
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
	const ext = extensionFor(type);
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

function writeSynced(file, data) {
	const fd = fs.openSync(file, "w");
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

function externalize(folder, item) {
	const { fields, bytes } = loadEmbedded(item);
	if (!fieldsSafe(fields)) {
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
	const { name, reuse } = fileNameFor(base, fields.type, filesDir, hashOf(bytes));
	const target = path.join(filesDir, name);
	if (reuse) {
		verify(target, bytes);
	} else {
		writeSynced(target + TMP, bytes);
		if (fs.existsSync(target)) {
			throw new Error("files/" + name + " appeared while writing");
		}
		fs.renameSync(target + TMP, target);
		verify(target, bytes);
	}
	writeVerified(tidFile, serializeFields(Object.assign({}, fields, { _canonical_uri: uriFor(name) })));
	if (item.form === "file") {
		deleteEmbedded(item);
	}
	return bytes.length;
}

function internalize(folder, item) {
	const { fields, body, source } = loadExternalized(folder, item);
	if (!source) {
		throw new Skip("file is not in the files folder");
	}
	if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
		throw new Skip("file not on this machine");
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
	if (!ext.source || !fs.existsSync(ext.source) || ext.body.trim() !== "" || !sameFields(emb.fields, extFields)
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
function removeTempFiles(dir, recursive) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith(TMP)) {
			fs.rmSync(full, { force: true });
		} else if (recursive && entry.isDirectory()) {
			removeTempFiles(full, true);
		}
	}
}

// Externalizes or internalizes the binary tiddlers in <folder>/tiddlers; problems with one tiddler
// are reported, not thrown. The wiki must not be running.
function applyPolicy(folder, policy) {
	if (policy !== "externalize" && policy !== "internalize") {
		throw new Error("Unknown policy: " + policy);
	}
	const result = { done: [], skipped: [], errors: [] };
	removeTempFiles(path.join(folder, "tiddlers"), true);
	removeTempFiles(path.join(folder, "files"), false);
	const byTitle = new Map();
	for (const item of scanFolder(folder).items) {
		if (item.form === "file" && !item.meta) {
			// Its title in TW is the absolute path; moving it would rename the tiddler
			if (policy === "externalize") {
				result.skipped.push({ title: item.title, reason: NO_META });
			}
			continue;
		}
		byTitle.set(item.title, (byTitle.get(item.title) || []).concat(item));
	}
	for (const [title, items] of byTitle) {
		try {
			if (items.length > 1) {
				result.done.push({ title, action: "recovered", bytes: recover(folder, policy, items) });
			} else if (policy === "externalize" && items[0].state === "embedded") {
				result.done.push({ title, action: "externalized", bytes: externalize(folder, items[0]) });
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
	return result;
}

module.exports = { BASE64_TYPES, extensionFor, fileNameFor, typeForExtension, parseFields, serializeFields, fieldsSafe, scanFolder, applyPolicy };

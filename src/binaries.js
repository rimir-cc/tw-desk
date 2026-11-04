"use strict";

// Binary tiddlers of TiddlyWiki folder wikis: finding them (and, later, moving them between the
// wiki's tiddlers folder and a files folder). Plain fs, no Electron.

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

// A .tid / .meta file: "key: value" lines up to the first empty line, then the body
function parseFields(text) {
	const fields = {};
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let i = 0;
	for (; i < lines.length && lines[i] !== ""; i++) {
		const colon = lines[i].indexOf(":");
		if (colon > 0) {
			fields[lines[i].slice(0, colon).trim()] = lines[i].slice(colon + 1).trim();
		}
	}
	return { fields, body: lines.slice(i + 1).join("\n") };
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

function decodeUri(uri) {
	try {
		return decodeURI(uri);
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
			const fields = meta ? (readFields(meta) || { fields: {} }).fields : {};
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
	let ext = extensionFor(type);
	let stem = String(title).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
	if (stem.toLowerCase().endsWith(ext.toLowerCase())) {
		ext = stem.slice(stem.length - ext.length); // keep the title's spelling
		stem = stem.slice(0, stem.length - ext.length);
	}
	stem = stem.replace(/[. ]+$/, "");
	// Room for the extension and a " (n)" suffix
	stem = stem.slice(0, 120 - ext.length - 8).replace(/[. ]+$/, "") || "file";
	const hashOf = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	for (let n = 1; ; n++) {
		const name = stem + (n === 1 ? "" : " (" + n + ")") + ext;
		const file = path.join(filesDir, name);
		if (!fs.existsSync(file)) {
			return { name, reuse: false };
		}
		if (hashOf(file) === sha256) {
			return { name, reuse: true };
		}
	}
}

module.exports = { BASE64_TYPES, extensionFor, fileNameFor, typeForExtension, parseFields, serializeFields, fieldsSafe, scanFolder };

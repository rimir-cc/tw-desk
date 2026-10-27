"use strict";

// Shared plugin store, plugin libraries and per-wiki plugin lists (tiddlywiki.info).
//
// Store layout (outside the install folder, so updates don't touch it):
//   <store>/plugins/<author>/<name>/   plugin.info, tiddlers.json
//   <store>/themes/<author>/<name>/
//   <store>/languages/<name>/
//   <store>/tw-desk-store.json         where each entry came from (TiddlyWiki would load any extra
//                                      file inside a plugin folder as part of the plugin)
// TiddlyWiki finds these via TIDDLYWIKI_PLUGIN_PATH / _THEME_PATH / _LANGUAGE_PATH
// (after its own bundled plugins, which therefore always win).

const fs = require("fs");
const path = require("path");
const { net } = require("electron");

const KINDS = {
	plugin: { prefix: "$:/plugins/", dir: "plugins", infoKey: "plugins", envVar: "TIDDLYWIKI_PLUGIN_PATH" },
	theme: { prefix: "$:/themes/", dir: "themes", infoKey: "themes", envVar: "TIDDLYWIKI_THEME_PATH" },
	language: { prefix: "$:/languages/", dir: "languages", infoKey: "languages", envVar: "TIDDLYWIKI_LANGUAGE_PATH" }
};

const TW_DIR = path.dirname(require.resolve("tiddlywiki/package.json"));
const TW_VERSION = require("tiddlywiki/package.json").version;

let storeRoot = null;
let backupRoot = null;
const indexCache = new Map(); // library url -> { entries, fetched }

function init(userDataDir) {
	storeRoot = path.join(userDataDir, "store");
	backupRoot = path.join(userDataDir, "backup");
	for (const kind of Object.values(KINDS)) {
		fs.mkdirSync(path.join(storeRoot, kind.dir), { recursive: true });
	}
}

function storePath() {
	return storeRoot;
}

function storeMetaFile() {
	return path.join(storeRoot, "tw-desk-store.json");
}

function readStoreMeta() {
	try {
		return JSON.parse(fs.readFileSync(storeMetaFile(), "utf8"));
	} catch (e) {
		return {};
	}
}

function updateStoreMeta(key, value) {
	const meta = readStoreMeta();
	if (value) {
		meta[key] = value;
	} else {
		delete meta[key];
	}
	fs.writeFileSync(storeMetaFile(), JSON.stringify(meta, null, 2));
}

// Environment for TiddlyWiki processes so that they find the store
function tiddlyWikiEnv(baseEnv) {
	const env = {};
	for (const kind of Object.values(KINDS)) {
		const existing = baseEnv[kind.envVar];
		env[kind.envVar] = [path.join(storeRoot, kind.dir), existing].filter(Boolean).join(path.delimiter);
	}
	return env;
}

// ---------- names ----------

// "$:/plugins/flibbles/relink" -> { kind: "plugin", name: "flibbles/relink" }
function parseTitle(title) {
	for (const [kind, def] of Object.entries(KINDS)) {
		if (typeof title === "string" && title.startsWith(def.prefix) && title.length > def.prefix.length) {
			return { kind, name: title.slice(def.prefix.length) };
		}
	}
	return null;
}

function titleOf(kind, name) {
	return KINDS[kind].prefix + name;
}

function compareVersions(a, b) {
	const parse = v => String(v || "0").replace(/^[^\d]*/, "").split(/[-+]/)[0].split(".").map(n => parseInt(n, 10) || 0);
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d) {
			return d < 0 ? -1 : 1;
		}
	}
	return 0;
}

// ---------- reading plugin folders ----------

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listFolderPlugins(root, kind, source) {
	const result = [];
	const kindRoot = path.join(root, KINDS[kind].dir);
	if (!fs.existsSync(kindRoot)) {
		return result;
	}
	// Plugins and themes are <author>/<name>, languages are <name>
	const candidates = [];
	for (const first of fs.readdirSync(kindRoot)) {
		const firstPath = path.join(kindRoot, first);
		if (!fs.statSync(firstPath).isDirectory()) {
			continue;
		}
		if (fs.existsSync(path.join(firstPath, "plugin.info"))) {
			candidates.push({ name: first, dir: firstPath });
		} else {
			for (const second of fs.readdirSync(firstPath)) {
				const dir = path.join(firstPath, second);
				if (fs.existsSync(path.join(dir, "plugin.info"))) {
					candidates.push({ name: first + "/" + second, dir });
				}
			}
		}
	}
	const storeMeta = source === "store" ? readStoreMeta() : {};
	for (const { name, dir } of candidates) {
		try {
			const info = readJson(path.join(dir, "plugin.info"));
			const meta = storeMeta[kind + "|" + name] || {};
			result.push({
				kind,
				name,
				title: info.title || titleOf(kind, name),
				// Bundled plugins without a version get TiddlyWiki's own version when loaded
				version: info.version || (source === "bundled" ? TW_VERSION : ""),
				description: info.description || "",
				source,
				library: meta.library || null,
				installed: meta.installed || null,
				dir
			});
		} catch (e) {
			result.push({ kind, name, title: titleOf(kind, name), version: "", description: "Unreadable plugin.info: " + e.message, source, dir });
		}
	}
	return result;
}

function listStore() {
	return Object.keys(KINDS).flatMap(kind => listFolderPlugins(storeRoot, kind, "store"));
}

let bundledCache = null;
function listBundled() {
	if (!bundledCache) {
		bundledCache = Object.keys(KINDS).flatMap(kind => listFolderPlugins(TW_DIR, kind, "bundled"));
	}
	return bundledCache;
}

// ---------- writing plugins to the store ----------

function stringifyField(value) {
	if (Array.isArray(value)) {
		return value.map(v => (/\s/.test(v) ? "[[" + v + "]]" : v)).join(" ");
	}
	return typeof value === "string" ? value : String(value);
}

// fields: a plugin tiddler (fields plus "text" holding {"tiddlers": {...}})
function writeToStore(fields, meta) {
	const parsed = parseTitle(fields.title);
	if (!parsed) {
		throw new Error("Not a plugin, theme or language: " + fields.title);
	}
	let payload;
	try {
		payload = JSON.parse(fields.text);
	} catch (e) {
		throw new Error("Plugin " + fields.title + " has no valid JSON content.");
	}
	if (!payload || typeof payload.tiddlers !== "object") {
		throw new Error("Plugin " + fields.title + " contains no tiddlers.");
	}
	const info = {};
	for (const [key, value] of Object.entries(fields)) {
		if (key !== "text" && key !== "revision" && key !== "bag") {
			info[key] = stringifyField(value);
		}
	}
	const tiddlers = Object.entries(payload.tiddlers).map(([title, tiddlerFields]) => {
		const tiddler = { title };
		for (const [key, value] of Object.entries(tiddlerFields || {})) {
			if (key !== "title") {
				tiddler[key] = stringifyField(value);
			}
		}
		return tiddler;
	});
	const target = path.join(storeRoot, KINDS[parsed.kind].dir, ...parsed.name.split("/"));
	const temp = target + ".tw-desk-new";
	const old = target + ".tw-desk-old";
	fs.rmSync(temp, { recursive: true, force: true });
	fs.rmSync(old, { recursive: true, force: true });
	fs.mkdirSync(temp, { recursive: true });
	fs.writeFileSync(path.join(temp, "plugin.info"), JSON.stringify(info, null, 4));
	fs.writeFileSync(path.join(temp, "tiddlers.json"), JSON.stringify(tiddlers));
	if (fs.existsSync(target)) {
		fs.renameSync(target, old);
	}
	fs.renameSync(temp, target);
	fs.rmSync(old, { recursive: true, force: true });
	updateStoreMeta(parsed.kind + "|" + parsed.name, Object.assign({ installed: new Date().toISOString() }, meta));
	return { kind: parsed.kind, name: parsed.name, title: fields.title, version: info.version || "" };
}

function removeFromStore(kind, name) {
	if (!KINDS[kind] || !name || name.includes("..")) {
		throw new Error("Invalid plugin.");
	}
	const dir = path.join(storeRoot, KINDS[kind].dir, ...name.split("/"));
	if (!fs.existsSync(path.join(dir, "plugin.info"))) {
		throw new Error("Not in the store: " + titleOf(kind, name));
	}
	fs.rmSync(dir, { recursive: true, force: true });
	updateStoreMeta(kind + "|" + name, null);
	// Remove an empty author folder
	const parent = path.dirname(dir);
	if (parent !== path.join(storeRoot, KINDS[kind].dir) && fs.readdirSync(parent).length === 0) {
		fs.rmdirSync(parent);
	}
}

// ---------- libraries ----------

async function fetchJson(url) {
	const response = await net.fetch(url, { cache: "no-store" });
	if (!response.ok) {
		throw new Error("HTTP " + response.status + " for " + url);
	}
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch (e) {
		throw new Error("Not JSON: " + url);
	}
}

// Standard TiddlyWiki library: ".../library/v5.4.1/index.html" -> base ".../library/v5.4.1/"
function standardBase(url) {
	let base = url.trim();
	if (/\.html?$/i.test(base)) {
		base = base.slice(0, base.lastIndexOf("/") + 1);
	}
	return base.endsWith("/") ? base : base + "/";
}

// Index fields worth searching and showing (everything but the plugin text, shortened)
function extraFields(entry) {
	const fields = {};
	for (const [key, value] of Object.entries(entry)) {
		const text = Array.isArray(value) ? value.join(" ") : value !== null && typeof value === "object" ? "" : String(value === undefined || value === null ? "" : value);
		if (key !== "text" && key !== "title" && text) {
			fields[key] = text.slice(0, 2000);
		}
	}
	return fields;
}

function normalizeEntries(list, type) {
	return (Array.isArray(list) ? list : [])
		.map(entry => {
			const parsed = entry && typeof entry.title === "string" ? parseTitle(entry.title) : null;
			if (!parsed) {
				return null;
			}
			return {
				title: entry.title,
				kind: parsed.kind,
				name: parsed.name,
				version: String(entry.version || ""),
				description: String(entry.description || ""),
				author: String(entry.author || ""),
				tags: String(entry.tags || ""),
				fields: extraFields(entry),
				type
			};
		})
		.filter(Boolean)
		.sort((a, b) => a.title.localeCompare(b.title));
}

// Finds out which kind of library a URL is; returns { url, type }
async function detectLibrary(url) {
	const trimmed = url.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(trimmed)) {
		throw new Error("Please enter an http(s) URL.");
	}
	const errors = [];
	try {
		const list = await fetchJson(standardBase(url) + "recipes/library/tiddlers.json");
		if (Array.isArray(list)) {
			return { url: url.trim(), type: "tiddlywiki" };
		}
	} catch (e) {
		errors.push(e.message);
	}
	try {
		const list = await fetchJson(trimmed + "/index.json");
		if (Array.isArray(list) && list.length && list[0].title) {
			return { url: trimmed, type: "cpl" };
		}
	} catch (e) {
		errors.push(e.message);
	}
	throw new Error("No plugin library found at this URL.\n" + errors.join("\n"));
}

async function libraryIndex(library, refresh) {
	const cached = indexCache.get(library.url);
	if (cached && !refresh) {
		return cached.entries;
	}
	const entries = library.type === "cpl"
		? normalizeEntries(await fetchJson(library.url.replace(/\/+$/, "") + "/index.json"), "cpl")
		: normalizeEntries(await fetchJson(standardBase(library.url) + "recipes/library/tiddlers.json"), "tiddlywiki");
	indexCache.set(library.url, { entries, fetched: Date.now() });
	return entries;
}

// Every library's index for the search: [{ url, type, entries } | { url, type, error }]
function allIndexes(libraries, refresh) {
	return Promise.all(libraries.map(async library => {
		try {
			return { url: library.url, type: library.type, entries: await libraryIndex(library, refresh) };
		} catch (e) {
			return { url: library.url, type: library.type, error: e.message };
		}
	}));
}

function pluginUrl(library, title) {
	if (library.type === "cpl") {
		const file = title
			.replace("$:/plugins/", "")
			.replace("$:/languages/", "languages_")
			.replace("$:/themes/", "themes_")
			.replace(/[:/<>"|?*]/g, "_");
		return library.url.replace(/\/+$/, "") + "/" + encodeURIComponent(file) + "/latest.json";
	}
	return standardBase(library.url) + "recipes/library/tiddlers/" + encodeURIComponent(encodeURIComponent(title)) + ".json";
}

async function installFromLibrary(library, title) {
	let data = await fetchJson(pluginUrl(library, title));
	if (Array.isArray(data)) {
		data = data.find(t => t && t.title === title) || data[0];
	}
	if (!data || data.title !== title || typeof data.text !== "string") {
		throw new Error("The library returned no usable plugin for " + title);
	}
	return writeToStore(data, { library: library.url });
}

// For every plugin found in the store or stored inside wiki folders: newest version in any library
// Adds to each installed plugin the versions the libraries offer (newest first).
// A plugin can be in several libraries; the UI decides what counts as an update.
async function checkUpdates(libraries, installed) {
	const errors = [];
	const offers = new Map(); // title -> Map(library url -> version)
	for (const library of libraries) {
		try {
			for (const entry of await libraryIndex(library, true)) {
				if (!offers.has(entry.title)) {
					offers.set(entry.title, new Map());
				}
				const byLibrary = offers.get(entry.title);
				const version = entry.version || "";
				if (!byLibrary.has(library.url) || compareVersions(version, byLibrary.get(library.url)) > 0) {
					byLibrary.set(library.url, version);
				}
			}
		} catch (e) {
			errors.push(library.url + ": " + e.message);
		}
	}
	const results = installed.map(plugin => Object.assign({}, plugin, {
		offers: [...(offers.get(plugin.title) || new Map())]
			.map(([library, version]) => ({ library, version }))
			.sort((a, b) => compareVersions(b.version, a.version))
	}));
	return { results, errors, librariesChecked: libraries.length - errors.length };
}

// ---------- tiddlywiki.info plugin lists ----------

function readInfo(folder) {
	return readJson(path.join(folder, "tiddlywiki.info"));
}

function writeInfo(folder, info) {
	fs.writeFileSync(path.join(folder, "tiddlywiki.info"), JSON.stringify(info, null, 4));
}

function folderLists(folder) {
	const info = readInfo(folder);
	return {
		plugins: info.plugins || [],
		themes: info.themes || [],
		languages: info.languages || []
	};
}

function setFolderList(folder, kind, names) {
	const info = readInfo(folder);
	const key = KINDS[kind].infoKey;
	const unique = [...new Set(names.filter(Boolean))];
	if (JSON.stringify(unique) === JSON.stringify(info[key] || [])) {
		return;
	}
	if (unique.length) {
		info[key] = unique;
	} else {
		delete info[key];
	}
	writeInfo(folder, info);
}

// ---------- plugins stored as tiddlers inside a wiki folder ----------

function parseMeta(text) {
	const fields = {};
	for (const line of text.split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index > 0) {
			fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
		}
	}
	return fields;
}

// Reads a plugin tiddler from "<x>.json" (+ "<x>.json.meta") as saved by TiddlyWiki's filesystem plugin
function readStoredPlugin(file) {
	const metaFile = file + ".meta";
	if (fs.existsSync(metaFile)) {
		const fields = parseMeta(fs.readFileSync(metaFile, "utf8"));
		if (!fields["plugin-type"] && !parseTitle(fields.title)) {
			return null;
		}
		fields.text = fs.readFileSync(file, "utf8");
		return fields;
	}
	let data;
	try {
		data = readJson(file);
	} catch (e) {
		return null;
	}
	const tiddler = Array.isArray(data) ? data[0] : data;
	if (tiddler && typeof tiddler.text === "string" && (tiddler["plugin-type"] || (tiddler.type === "application/json" && parseTitle(tiddler.title)))) {
		return tiddler;
	}
	return null;
}

function listStoredInWiki(folder) {
	const tiddlersDir = path.join(folder, "tiddlers");
	const result = [];
	const walk = dir => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.toLowerCase().endsWith(".json")) {
				const tiddler = readStoredPlugin(full);
				const parsed = tiddler && parseTitle(tiddler.title);
				if (parsed) {
					result.push({
						title: tiddler.title,
						kind: parsed.kind,
						name: parsed.name,
						version: tiddler.version || "",
						description: tiddler.description || "",
						file: full,
						source: "wiki"
					});
				}
			}
		}
	};
	walk(tiddlersDir);
	return result.sort((a, b) => a.title.localeCompare(b.title));
}

// Moves a plugin stored in a wiki folder into the store and lists it in that folder's tiddlywiki.info.
// The original files are moved to <userData>/backup/<timestamp>/ rather than deleted.
function moveToStore(folder, file) {
	const resolvedFolder = path.resolve(folder);
	const resolvedFile = path.resolve(file);
	const relative = path.relative(path.join(resolvedFolder, "tiddlers"), resolvedFile);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("File is not inside this wiki's tiddlers folder.");
	}
	const tiddler = readStoredPlugin(resolvedFile);
	if (!tiddler) {
		throw new Error("Not a plugin file: " + resolvedFile);
	}
	const result = writeToStore(tiddler, { library: null, movedFrom: resolvedFile });
	const lists = folderLists(resolvedFolder);
	const key = KINDS[result.kind].infoKey;
	setFolderList(resolvedFolder, result.kind, lists[key].concat(result.name));
	const backupDir = path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, "-"), path.basename(resolvedFolder));
	fs.mkdirSync(backupDir, { recursive: true });
	for (const source of [resolvedFile, resolvedFile + ".meta"]) {
		if (fs.existsSync(source)) {
			const destination = path.join(backupDir, path.basename(source));
			fs.copyFileSync(source, destination);
			fs.rmSync(source);
		}
	}
	return Object.assign(result, { backupDir });
}

module.exports = {
	allIndexes,
	KINDS,
	init,
	storePath,
	tiddlyWikiEnv,
	parseTitle,
	titleOf,
	compareVersions,
	listStore,
	listBundled,
	removeFromStore,
	detectLibrary,
	libraryIndex,
	installFromLibrary,
	checkUpdates,
	folderLists,
	setFolderList,
	listStoredInWiki,
	moveToStore
};

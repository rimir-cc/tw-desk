"use strict";

// The data folder: everything that makes up the user's TW Desk (config.json, store/, web/), chosen by the user,
// movable and under git. Machine-local values live in <userData>/local.json, the pointer to the data folder in
// <userData>/data-folder.json. This module holds the path rules, the local/shared split, file operations and texts;
// main.js wires them up (no Electron here).

const fs = require("fs");
const path = require("path");
const { commonBase } = require("./setup");

// ---------- paths in config.json ----------

const MAX_UP = 2;

// Relative to the data folder (with "/") when that goes up at most two levels, otherwise absolute
function toStored(absPath, dataDir) {
	const resolved = path.resolve(absPath);
	const relative = path.relative(path.resolve(dataDir), resolved);
	if (path.isAbsolute(relative)) {
		return resolved;
	}
	if (!relative) {
		return ".";
	}
	const parts = relative.split(path.sep);
	let up = 0;
	while (up < parts.length && parts[up] === "..") {
		up++;
	}
	return up > MAX_UP ? resolved : parts.join("/");
}

function fromStored(stored, dataDir) {
	return path.isAbsolute(stored) ? path.resolve(stored) : path.resolve(dataDir, ...String(stored).split("/"));
}

function mapConfigPaths(config, convert) {
	const out = Object.assign({}, config);
	if (Array.isArray(config.wikis)) {
		out.wikis = config.wikis.map(w => (typeof w.path === "string" ? Object.assign({}, w, { path: convert(w.path) }) : w));
	}
	if (config.folderDescriptions && typeof config.folderDescriptions === "object") {
		out.folderDescriptions = Object.fromEntries(Object.entries(config.folderDescriptions).map(([p, text]) => [convert(p), text]));
	}
	if (Array.isArray(config.pluginsFolderOrder)) {
		out.pluginsFolderOrder = config.pluginsFolderOrder.map(convert);
	}
	return out;
}

function storeConfigPaths(config, dataDir) {
	return mapConfigPaths(config, p => toStored(p, dataDir));
}

function resolveConfigPaths(config, dataDir) {
	return mapConfigPaths(config, p => fromStored(p, dataDir));
}

// ---------- local values (<userData>/local.json) ----------

// Per item: the fields that are machine-specific or change by just using the app
const LOCAL_ITEM_FIELDS = { wikis: ["lastPort"], webWikis: ["check"], groups: ["collapsed"] };
const LOCAL_TOP_FIELDS = ["webCollapsed", "ungroupedCollapsed"];

function splitLocal(config) {
	const shared = Object.assign({}, config);
	const local = {};
	for (const [list, fields] of Object.entries(LOCAL_ITEM_FIELDS)) {
		if (!Array.isArray(config[list])) {
			continue;
		}
		shared[list] = config[list].map(item => {
			const rest = Object.assign({}, item);
			const own = {};
			for (const field of fields) {
				if (field in rest) {
					if (rest[field] !== undefined) {
						own[field] = rest[field];
					}
					delete rest[field];
				}
			}
			if (Object.keys(own).length && item.id) {
				(local[list] = local[list] || {})[item.id] = own;
			}
			return rest;
		});
	}
	for (const field of LOCAL_TOP_FIELDS) {
		if (field in shared) {
			if (shared[field] !== undefined) {
				local[field] = shared[field];
			}
			delete shared[field];
		}
	}
	return { shared, local };
}

function mergeLocal(shared, local) {
	const config = Object.assign({}, shared);
	const own = local || {};
	for (const list of Object.keys(LOCAL_ITEM_FIELDS)) {
		if (Array.isArray(shared[list])) {
			config[list] = shared[list].map(item => Object.assign({}, item, (own[list] || {})[item.id] || {}));
		}
	}
	for (const field of LOCAL_TOP_FIELDS) {
		if (field in own) {
			config[field] = own[field];
		}
	}
	return config;
}

// ---------- texts ----------

const MAX_ACTIONS = 6;

function stamp(date = new Date()) {
	const pad = n => String(n).padStart(2, "0");
	return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

// "Added wiki orga · Installed … 1.2.0"; without recorded actions (e.g. hand edits) a generic message
function commitMessage(actions, changedFiles) {
	const unique = [...new Set((actions || []).filter(Boolean))];
	if (!unique.length) {
		return "TW Desk: setup changed (" + stamp() + ")";
	}
	const shown = unique.slice(0, MAX_ACTIONS);
	return shown.join(" · ") + (unique.length > MAX_ACTIONS ? " · +" + (unique.length - MAX_ACTIONS) + " more" : "");
}

// Next to the folder that holds the wikis (C:\data\wikis\orga → C:\data\tw-desk-data), else in Documents
function suggestLocation(wikiPaths, documentsDir, key) {
	const base = commonBase(wikiPaths.map(p => path.dirname(path.resolve(p))), key);
	if (base && path.dirname(base) !== base) {
		return path.join(path.dirname(base), "tw-desk-data");
	}
	return path.join(documentsDir, "TW Desk data");
}

// ---------- wikis that aren't found ----------

// Two or more missing wikis in the same parent folder, largest group first
function missingGroups(missing, key) {
	const groups = new Map();
	for (const item of missing) {
		const parent = path.dirname(path.resolve(item.path));
		if (!groups.has(key(parent))) {
			groups.set(key(parent), { parent, ids: [] });
		}
		groups.get(key(parent)).ids.push(item.id);
	}
	return [...groups.values()].filter(g => g.ids.length >= 2).sort((a, b) => b.ids.length - a.ids.length);
}

function replacePrefix(p, oldParent, newParent, key) {
	const relative = path.relative(key(oldParent), key(p));
	if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
		return null;
	}
	// The relative part from the real (not lower-cased) path
	const tail = path.resolve(p).slice(path.resolve(oldParent).length).replace(/^[\\/]+/, "");
	return tail ? path.join(path.resolve(newParent), tail) : path.resolve(newParent);
}

function repointPlan(items, oldParent, newParent, exists, key) {
	return items.map(item => {
		const to = replacePrefix(item.path, oldParent, newParent, key);
		return { id: item.id, from: path.resolve(item.path), to, found: !!to && exists(to) };
	}).filter(entry => entry.to);
}

// ---------- wikis inside the data folder ----------

// They have their own history: kept out of the data folder's commits via .git/info/exclude
function wikiExcludes(wikiPaths, dataDir) {
	const lines = [];
	for (const p of wikiPaths) {
		const relative = path.relative(path.resolve(dataDir), path.resolve(p));
		if (relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep)) {
			lines.push("/" + relative.split(path.sep).join("/") + "/");
		}
	}
	return [...new Set(lines)];
}

const EXCLUDE_START = "# TW Desk: wikis inside the data folder";
const EXCLUDE_END = "# TW Desk end";

// The exclude file's text with TW Desk's block replaced by lines (or removed when there are none)
function withExcludes(text, lines) {
	let rest = text;
	const start = rest.indexOf(EXCLUDE_START + "\n");
	const end = rest.indexOf(EXCLUDE_END + "\n", start);
	if (start >= 0 && end >= 0) {
		rest = rest.slice(0, start) + rest.slice(end + EXCLUDE_END.length + 1);
	}
	if (!lines.length) {
		return rest;
	}
	return rest + (rest && !rest.endsWith("\n") ? "\n" : "") + [EXCLUDE_START, ...lines, EXCLUDE_END].join("\n") + "\n";
}

// ---------- files ----------

const POINTER = "data-folder.json";
const DATA_GITIGNORE = "*.tmp\n";
const DATA_ENTRIES = ["config.json", "store", "web"];

function readPointer(userData) {
	try {
		const pointer = JSON.parse(fs.readFileSync(path.join(userData, POINTER), "utf8"));
		return typeof pointer.path === "string" && pointer.path ? path.resolve(pointer.path) : null;
	} catch (e) {
		return null;
	}
}

function writePointer(userData, dataDir) {
	fs.mkdirSync(userData, { recursive: true });
	const file = path.join(userData, POINTER);
	fs.writeFileSync(file + ".tmp", JSON.stringify({ path: path.resolve(dataDir) }, null, 2));
	fs.renameSync(file + ".tmp", file);
}

// "missing" | "empty" | "data" (has a config.json) | "other"
function folderState(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch (e) {
		return "missing";
	}
	if (!entries.length) {
		return "empty";
	}
	return entries.includes("config.json") ? "data" : "other";
}

function ownRepo(dir) {
	return fs.existsSync(path.join(dir, ".git"));
}

// Relative path -> size of every file below dir/entry (entries that don't exist are skipped)
function fileSizes(dir, entries) {
	const sizes = new Map();
	const walk = relative => {
		const full = path.join(dir, relative);
		const stat = fs.statSync(full);
		if (stat.isDirectory()) {
			for (const name of fs.readdirSync(full)) {
				walk(path.join(relative, name));
			}
		} else {
			sizes.set(relative, stat.size);
		}
	};
	for (const entry of entries) {
		if (fs.existsSync(path.join(dir, entry))) {
			walk(entry);
		}
	}
	return sizes;
}

function verifyCopy(fromDir, toDir, entries) {
	const from = fileSizes(fromDir, entries);
	const to = fileSizes(toDir, entries);
	for (const [file, size] of from) {
		if (to.get(file) !== size) {
			throw new Error("The copy of " + path.join(fromDir, file) + " in " + toDir + " is incomplete.");
		}
	}
}

// Copies the entries, verifies them and, if anything went wrong, removes what it copied
function copyEntries(fromDir, toDir, entries) {
	fs.mkdirSync(toDir, { recursive: true });
	const copied = [];
	try {
		for (const entry of entries) {
			const source = path.join(fromDir, entry);
			if (fs.existsSync(source)) {
				copied.push(entry);
				fs.cpSync(source, path.join(toDir, entry), { recursive: true, errorOnExist: true, force: false });
			}
		}
		verifyCopy(fromDir, toDir, entries);
	} catch (e) {
		for (const entry of copied) {
			fs.rmSync(path.join(toDir, entry), { recursive: true, force: true });
		}
		throw e;
	}
}

function copyData(fromDir, toDir, entries = DATA_ENTRIES) {
	copyEntries(fromDir, toDir, entries);
}

// The whole folder, including .git
function copyTree(fromDir, toDir) {
	copyEntries(fromDir, toDir, fs.readdirSync(fromDir));
}

module.exports = {
	POINTER, DATA_GITIGNORE, DATA_ENTRIES,
	readPointer, writePointer, folderState, ownRepo, verifyCopy, copyData, copyTree,
	toStored, fromStored, storeConfigPaths, resolveConfigPaths,
	splitLocal, mergeLocal,
	commitMessage, suggestLocation,
	missingGroups, repointPlan, replacePrefix,
	wikiExcludes, withExcludes
};

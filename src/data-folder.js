"use strict";

// The data folder: everything that makes up the user's TW Desk (config.json, store/, web/), chosen by the user,
// movable and under git. Machine-local values live in <userData>/local.json, the pointer to the data folder in
// <userData>/data-folder.json. This module holds the path rules, the local/shared split, file operations and texts;
// main.js wires them up (no Electron here).

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

module.exports = {
	toStored, fromStored, storeConfigPaths, resolveConfigPaths,
	splitLocal, mergeLocal,
	commitMessage, suggestLocation,
	missingGroups, repointPlan, replacePrefix
};

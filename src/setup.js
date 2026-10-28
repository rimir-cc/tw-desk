"use strict";

// Export and import of a TW Desk setup as one JSON file (tw-desk-setup.json): wikis with their folders relative to a
// common base folder and their git remotes, groups, web wikis (snapshots optionally embedded), store plugins (as plugin
// tiddlers), libraries and settings. The wiki contents aren't in it – they come from the remotes or are copied by hand.

const fs = require("fs");
const path = require("path");
const links = require("./links");

const FORMAT = "tw-desk-setup";
const VERSION = 1;

function toSlash(relative) {
	return relative.split(path.sep).join("/");
}

// The deepest folder containing all the given folders, or null (e.g. different drives)
function commonBase(folders, key) {
	if (!folders.length) {
		return null;
	}
	const split = folder => {
		const resolved = path.resolve(folder);
		const root = path.parse(resolved).root;
		return { root, parts: resolved.slice(root.length).split(path.sep).filter(Boolean) };
	};
	const [first, ...rest] = folders.map(split);
	if (rest.some(f => key(f.root) !== key(first.root))) {
		return null;
	}
	let length = first.parts.length;
	for (const other of rest) {
		let i = 0;
		while (i < length && i < other.parts.length && key(other.parts[i]) === key(first.parts[i])) {
			i++;
		}
		length = i;
	}
	return path.join(first.root, ...first.parts.slice(0, length));
}

// input: { app, tiddlywiki, platform, key, groups, wikis, folders: [{ path, git: { root, url, branch } | null }],
//   webWikis: [{ link, html }], store: [{ fields, library }] | null, libraries | null, settings | null }
function buildSetup(input) {
	// The parents, so a single wiki (or a repository holding several) keeps its own folder name
	const parents = input.folders.flatMap(f => [path.dirname(f.path)].concat(f.git ? [path.dirname(f.git.root)] : []));
	const base = commonBase(parents, input.key);
	const place = folder => (base ? { folder: toSlash(path.relative(base, folder)) } : { path: path.resolve(folder) });
	const groupName = id => (input.groups.find(g => g.id === id) || {}).name || null;
	const setup = {
		format: FORMAT,
		version: VERSION,
		exported: new Date().toISOString(),
		app: input.app,
		tiddlywiki: input.tiddlywiki,
		origin: { base, platform: input.platform },
		folders: input.folders.map(f => Object.assign(place(f.path), {
			repo: f.git ? Object.assign(place(f.git.root), { url: f.git.url || null, branch: f.git.branch || null }) : null
		})),
		groups: input.groups.filter(g => input.wikis.some(w => w.group === g.id)).map(g => ({ name: g.name, collapsed: !!g.collapsed })),
		wikis: input.wikis.map(w => {
			const wiki = Object.assign({ name: w.name }, place(w.path));
			for (const key of ["description", "fixedPort", "linkName", "importedFrom"]) {
				if (w[key]) {
					wiki[key] = w[key];
				}
			}
			wiki.autostart = !!w.autostart;
			if (groupName(w.group)) {
				wiki.group = groupName(w.group);
			}
			// The original's id and path only mean something on this computer
			if (w.copiedFrom) {
				wiki.copiedFrom = { name: w.copiedFrom.name, date: w.copiedFrom.date };
			}
			return wiki;
		}),
		webWikis: input.webWikis.map(({ link, html }) => {
			const out = { id: link.id, name: link.name, url: link.url };
			for (const key of ["description", "showcase", "linkedPlugins", "snapshot"]) {
				if (link[key]) {
					out[key] = link[key];
				}
			}
			if (html) {
				out.snapshotHtml = html;
			}
			return out;
		})
	};
	if (input.store) {
		setup.store = input.store.map(p => Object.assign({ fields: p.fields }, p.library ? { library: p.library } : {}));
	}
	if (input.libraries) {
		setup.libraries = input.libraries;
	}
	if (input.settings) {
		setup.settings = input.settings;
	}
	return setup;
}

function badFile(reason) {
	return new Error("This isn't a usable TW Desk setup file: " + reason);
}

function checkPlace(entry, what) {
	if (typeof entry.folder === "string") {
		const parts = entry.folder.split("/");
		// Everything stays inside the chosen folder
		if (path.isAbsolute(entry.folder) || /^[a-z]:/i.test(entry.folder) || parts.some(p => p === "..")) {
			throw badFile(what + " has an invalid folder: " + entry.folder);
		}
	} else if (typeof entry.path !== "string") {
		throw badFile(what + " has no folder.");
	}
}

// Parses and checks a setup file's text
function readSetup(text) {
	let setup;
	try {
		setup = JSON.parse(text);
	} catch (e) {
		throw badFile("no valid JSON (" + e.message + ").");
	}
	if (!setup || setup.format !== FORMAT) {
		throw badFile("it wasn't written by TW Desk's Export setup.");
	}
	if (!(setup.version <= VERSION)) {
		throw badFile("it was written by a newer TW Desk (format " + setup.version + "). Update TW Desk first.");
	}
	for (const key of ["folders", "groups", "wikis", "webWikis"]) {
		if (!Array.isArray(setup[key] || [])) {
			throw badFile(key + " is not a list.");
		}
		setup[key] = setup[key] || [];
	}
	setup.origin = setup.origin || {};
	for (const folder of setup.folders) {
		checkPlace(folder, "A folder");
		if (folder.repo) {
			checkPlace(folder.repo, "A repository");
		}
	}
	for (const wiki of setup.wikis) {
		if (!wiki || typeof wiki.name !== "string") {
			throw badFile("a wiki has no name.");
		}
		checkPlace(wiki, "Wiki “" + wiki.name + "”");
	}
	for (const link of setup.webWikis) {
		if (!link || !/^https?:\/\//i.test(String(link.url))) {
			throw badFile("a web wiki has no http(s) address.");
		}
	}
	if (setup.store !== undefined && !Array.isArray(setup.store)) {
		throw badFile("store is not a list.");
	}
	if (setup.libraries !== undefined && !Array.isArray(setup.libraries)) {
		throw badFile("libraries is not a list.");
	}
	return setup;
}

// Where an entry goes on this computer (null: a relative entry without a base folder, or a foreign absolute path)
function resolvePlace(entry, base) {
	if (typeof entry.folder === "string") {
		return base ? path.resolve(base, ...entry.folder.split("/").filter(Boolean)) : null;
	}
	return path.isAbsolute(entry.path) ? path.resolve(entry.path) : null;
}

function isWikiFolder(folder) {
	return fs.existsSync(path.join(folder, "tiddlywiki.info"));
}

function isEmptyOrMissing(folder) {
	try {
		return fs.readdirSync(folder).length === 0;
	} catch (e) {
		return e.code === "ENOENT";
	}
}

// What an import into base would do. env: { key, wikis, webWikis, groups, libraries, store, bundled, compareVersions,
// parseTitle }. Folder actions: register (wiki folder exists), clone, present (included folder exists), already (in
// TW Desk), missing, blocked. Only "register" and "clone" can be chosen.
function planImport(setup, base, env) {
	const key = env.key;
	const repos = new Map();
	const folders = setup.folders.map((entry, index) => {
		const target = resolvePlace(entry, base);
		const repo = entry.repo ? Object.assign({ path: resolvePlace(entry.repo, base) }, entry.repo) : null;
		if (repo && repo.path && !repos.has(key(repo.path))) {
			repos.set(key(repo.path), { path: repo.path, url: repo.url, branch: repo.branch, exists: !isEmptyOrMissing(repo.path) });
		}
		return { id: index, entry, target, repo: repo && repo.path ? repos.get(key(repo.path)) : null };
	});
	const wikiFor = target => setup.wikis.find(w => target && key(resolvePlace(w, base) || "") === key(target));
	const items = folders.map(({ id, entry, target, repo }) => {
		const wiki = wikiFor(target);
		const item = {
			id,
			name: wiki ? wiki.name : path.basename(entry.folder || entry.path || ""),
			wiki: !!wiki,
			relative: entry.folder || entry.path,
			path: target,
			url: repo ? repo.url : null,
			branch: repo ? repo.branch : null
		};
		const inDesk = target && env.wikis.find(w => key(w.path) === key(target));
		if (!target) {
			return Object.assign(item, { action: "missing", note: base ? "a path on another computer: " + entry.path : "choose the folder for the wikis" });
		}
		if (wiki && inDesk) {
			return Object.assign(item, { action: "already", note: "already in TW Desk as “" + inDesk.name + "”" });
		}
		// Links to it would be ambiguous here
		if (wiki) {
			const linkKey = String(wiki.linkName || "").trim() || path.basename(target);
			const clash = env.wikis.find(w => links.sameKey(links.linkKeyOf(w), linkKey));
			item.linkNote = clash ? " · its link name \u201c" + linkKey + "\u201d is already used here by \u201c" + clash.name + "\u201d" : "";
		}
		if (isWikiFolder(target)) {
			return Object.assign(item, wiki ? { action: "register", note: "the folder exists" } : { action: "present", note: "the folder exists" });
		}
		if (!isEmptyOrMissing(target)) {
			return Object.assign(item, { action: "blocked", note: "the folder exists but has no tiddlywiki.info" });
		}
		if (repo && repo.exists) {
			return Object.assign(item, { action: "missing", note: "not in the existing repository " + repo.path });
		}
		if (repo && repo.url) {
			return Object.assign(item, { action: "clone", note: "clone from " + repo.url + (repo.branch ? " (" + repo.branch + ")" : ""), repoPath: repo.path });
		}
		return Object.assign(item, { action: "missing", note: repo ? "its repository has no remote – copy the folder there" : "not in git – copy the folder there" });
	});
	const webWikis = setup.webWikis.map((link, index) => {
		const existing = env.webWikis.find(l => l.url === link.url);
		return {
			id: index,
			name: link.name,
			url: link.url,
			showcase: !!link.showcase,
			action: existing ? "already" : "add",
			note: existing ? "already in TW Desk as “" + existing.name + "”" : null,
			snapshot: link.snapshotHtml ? "embedded" : link.snapshot ? "download" : null
		};
	});
	const store = (setup.store || []).map((plugin, index) => {
		const title = plugin.fields && plugin.fields.title;
		const version = (plugin.fields && plugin.fields.version) || "";
		const item = { id: index, title, version };
		if (!title || !env.parseTitle(title)) {
			return Object.assign(item, { action: "invalid" });
		}
		if (env.bundled.some(p => p.title === title)) {
			return Object.assign(item, { action: "bundled" });
		}
		const installed = env.store.find(p => p.title === title);
		if (!installed) {
			return Object.assign(item, { action: "add" });
		}
		item.installed = installed.version;
		return Object.assign(item, { action: env.compareVersions(version, installed.version) > 0 ? "update" : "keep" });
	});
	const libraries = (setup.libraries || []).filter(l => l && l.url).map(l => ({ url: l.url, type: l.type, action: env.libraries.some(m => m.url === l.url) ? "already" : "add" }));
	return {
		base,
		folders: items,
		webWikis,
		store,
		libraries,
		settings: setup.settings || null,
		newGroups: setup.groups.map(g => g.name).filter(name => !env.groups.some(g => g.name === name))
	};
}

module.exports = { FORMAT, VERSION, commonBase, buildSetup, readSetup, resolvePlace, planImport, isWikiFolder };

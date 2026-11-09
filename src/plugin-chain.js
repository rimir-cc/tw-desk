"use strict";

// The plugins a wiki folder gets through its (transitive) includes, duplicates and version clashes, and the texts the
// Plugins window shows for them. Loaded as a plain script by the window, required by main.js and the unit tests
// (no fs, no DOM: folders are read through the functions passed in).

const LIST_KINDS = [["plugins", "plugin"], ["themes", "theme"], ["languages", "language"]];

// TiddlyWiki's load order (boot.js loadWikiTiddlers): each folder's includes first, depth-first, then the folder.
// readIncludes(path) -> { includes: [{ resolved, exists }] }; key(path) compares paths.
function walkIncludes(root, readIncludes, key) {
	const order = [];
	const errors = [];
	const visit = (folder, stack, chain) => {
		let includes = [];
		try {
			includes = readIncludes(folder).includes || [];
		} catch (e) {
			includes = [];
		}
		for (const include of includes) {
			const next = chain.concat(include.resolved);
			if (!include.exists) {
				errors.push({ path: include.resolved, chain: next, reason: "missing" });
			} else if (stack.includes(key(include.resolved))) {
				errors.push({ path: include.resolved, chain: next, reason: "loop" });
			} else {
				visit(include.resolved, stack.concat(key(include.resolved)), next);
			}
		}
		order.push({ path: folder, chain });
	};
	visit(root, [key(root)], []);
	return { order, errors };
}

// A folder loaded twice counts once: listed with the chain of its first load, ranked by its last (later loads win)
function analyzeChain(order, folderInfo, resolve, key) {
	const folders = new Map(); // key -> { path, chain, last }
	order.forEach((item, index) => {
		const k = key(item.path);
		if (!folders.has(k)) {
			folders.set(k, { path: item.path, chain: item.chain, last: index });
		}
		folders.get(k).last = index;
	});
	const entries = [];
	for (const folder of [...folders.values()].sort((a, b) => a.last - b.last)) {
		const data = folderInfo(folder.path) || {};
		const add = entry => entries.push(Object.assign(entry, { folder: folder.path, chain: folder.chain, position: entries.length }));
		if (data.lists) {
			for (const [listKey, kind] of LIST_KINDS) {
				for (const name of data.lists[listKey] || []) {
					const found = resolve(kind, name);
					add({ title: found.title, kind, name, source: "list", origin: found.origin, version: found.version || "" });
				}
			}
		}
		for (const plugin of data.stored || []) {
			add({ title: plugin.title, kind: plugin.kind, name: plugin.name, source: "stored", origin: "wiki", version: plugin.version || "" });
		}
	}
	const byTitle = new Map();
	entries.forEach((entry, index) => {
		if (!byTitle.has(entry.title)) {
			byTitle.set(entry.title, []);
		}
		byTitle.get(entry.title).push(index);
	});
	const problems = [];
	for (const [title, indexes] of byTitle) {
		if (indexes.length < 2) {
			continue;
		}
		const known = indexes.filter(i => entries[i].origin !== "missing");
		const versions = new Set(known.map(i => entries[i].version).filter(Boolean));
		const candidates = known.length ? known : indexes;
		problems.push({
			title,
			type: versions.size >= 2 ? "clash" : "duplicate",
			entries: indexes,
			winner: candidates.reduce((best, i) => (entries[i].position > entries[best].position ? i : best))
		});
	}
	return { entries, problems };
}

function chainLabel(chain, nameOf) {
	if (!chain.length) {
		return "";
	}
	return chain.length === 1 ? "from " + nameOf(chain[0]) : "via " + chain.map(nameOf).join(" → ");
}

function possessive(name) {
	return /s$/i.test(name) ? name + "'" : name + "'s";
}

function originLabel(entry, nameOf) {
	if (entry.origin === "wiki") {
		return "in " + nameOf(entry.folder) + " " + entry.version;
	}
	return entry.origin + " " + entry.version;
}

// e.g. "store 1.2.0 · in rr-streams 1.0.3 – rr-streams' copy wins"
function clashText(problem, entries, nameOf) {
	const labels = problem.entries.map(i => entries[i]).filter(e => e.origin !== "missing").map(e => originLabel(e, nameOf));
	const winner = entries[problem.winner];
	const phrase = winner.origin === "wiki" ? possessive(nameOf(winner.folder)) + " copy" : "the " + winner.origin + " copy";
	return [...new Set(labels)].join(" · ") + " – " + phrase + " wins";
}

// Which wikis (each { name, path, entries } with its own chain's entries) lose title when it is removed from
// folderPath's list, and which keep it through another source
function removalImpact(wikis, folderPath, title, key) {
	const lose = [];
	const keep = [];
	for (const wiki of wikis) {
		const removed = wiki.entries.filter(e => e.title === title && e.source === "list" && key(e.folder) === key(folderPath));
		if (!removed.length) {
			continue;
		}
		const others = wiki.entries.filter(e => e.title === title && e.origin !== "missing" && !removed.includes(e));
		if (others.length) {
			keep.push({ name: wiki.name, by: others.reduce((best, e) => (e.position > best.position ? e : best)) });
		} else {
			lose.push(wiki.name);
		}
	}
	return { lose, keep };
}

function keepReason(wiki, by, nameOf) {
	if (by.source === "stored") {
		return "stored in " + nameOf(by.folder);
	}
	return by.chain.length ? chainLabel(by.chain, nameOf) : "listed itself";
}

function orderFolders(folders, order, key) {
	const rank = new Map((order || []).map((p, i) => [key(p), i]));
	const listed = folders.filter(f => rank.has(key(f.path))).sort((a, b) => rank.get(key(a.path)) - rank.get(key(b.path)));
	return listed.concat(folders.filter(f => !rank.has(key(f.path))));
}

if (typeof module === "object") {
	module.exports = { walkIncludes, analyzeChain, chainLabel, clashText, removalImpact, keepReason, orderFolders };
}

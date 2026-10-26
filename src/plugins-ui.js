"use strict";

// Plugins window: per-wiki plugin lists, the shared store and plugin libraries.
// Uses $, api, run, cleanError and folderName from renderer.js.

const papi = api.plugins;
const KIND_KEYS = { plugin: "plugins", theme: "themes", language: "languages" };
// Without these two a wiki folder can't be served by TW Desk
const ESSENTIAL = ["plugin|tiddlywiki/tiddlyweb", "plugin|tiddlywiki/filesystem"];

let pstate = null;
let activeTab = "wikis";
let updatesResult = null;
const browse = { url: null, entries: null, filter: "" };

function el(tag, props, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props || {})) {
		if (key === "class") {
			node.className = value;
		} else if (key.startsWith("on")) {
			node.addEventListener(key.slice(2), value);
		} else if (value !== undefined && value !== null && value !== false) {
			node[key] = value;
		}
	}
	node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
	return node;
}

function actionButton(label, action, props = {}) {
	return el("button", Object.assign({ type: "button", onclick: () => pluginAction(action) }, props), label);
}

function showMessage(text, isError) {
	const box = $("#plugins-message");
	box.textContent = text || "";
	box.className = "plugins-message" + (isError ? " error" : "");
	box.hidden = !text;
}

async function pluginAction(action) {
	showMessage("Working…");
	try {
		const message = await action();
		showMessage(typeof message === "string" ? message : "");
	} catch (e) {
		showMessage(cleanError(e), true);
	}
	await reloadPlugins();
}

async function reloadPlugins() {
	pstate = await papi.getState();
	renderPlugins();
}

function lookup(kind, name) {
	const key = kind + "|" + name;
	const bundled = pstate.bundled.find(p => p.kind + "|" + p.name === key);
	if (bundled) {
		return { source: "bundled", label: "bundled " + bundled.version, plugin: bundled };
	}
	const stored = pstate.store.find(p => p.kind + "|" + p.name === key);
	if (stored) {
		return { source: "store", label: "store " + stored.version, plugin: stored };
	}
	return { source: "missing", label: "missing", plugin: null };
}

function usersOf(kind, name) {
	return pstate.folders.filter(f => f.lists && f.lists[KIND_KEYS[kind]].includes(name)).map(f => f.name);
}

function kindLabel(kind) {
	return kind === "plugin" ? "" : kind + ": ";
}

// ---------- Wikis tab ----------

function renderWikisTab() {
	const panel = $("#tab-wikis");
	panel.replaceChildren(el("p", { class: "muted small" },
		"Plugins listed in each folder's tiddlywiki.info. Included folders (like _shared) pass their plugins on to every wiki that includes them. Changes apply when a wiki is (re)started."));
	for (const folder of pstate.folders) {
		const card = el("div", { class: "card" });
		card.append(el("div", { class: "card-title" },
			el("strong", {}, folder.name),
			el("span", { class: "muted small" }, folder.path),
			folder.running ? el("span", { class: "badge wiki" }, "in use by a running wiki – restart to apply") : null));
		if (!folder.managed || folder.usedBy.length > 1) {
			card.append(el("div", { class: "muted small" }, "loaded by: " + folder.usedBy.join(", ")));
		}
		if (folder.error) {
			card.append(el("div", { class: "error small" }, folder.error));
			panel.append(card);
			continue;
		}
		const table = el("table", { class: "plugin-table" });
		for (const kind of Object.keys(KIND_KEYS)) {
			const names = folder.lists[KIND_KEYS[kind]];
			for (const name of names) {
				const found = lookup(kind, name);
				table.append(el("tr", {},
					el("td", {}, kindLabel(kind) + name, found.plugin && found.plugin.description ? el("div", { class: "desc" }, found.plugin.description) : null),
					el("td", {}, el("span", { class: "badge " + found.source, title: found.source === "missing" ? "Not bundled with TiddlyWiki and not in the store; TiddlyWiki will skip it." : "" }, found.label)),
					el("td", { class: "actions-cell" }, actionButton("Remove", async () => {
						if (ESSENTIAL.includes(kind + "|" + name) && !confirm(name + " is needed to serve this wiki from TW Desk. Remove anyway?")) {
							return "";
						}
						await papi.setList(folder.path, kind, names.filter(n => n !== name));
						return "Removed " + name + " from " + folder.name + ".";
					}, { class: "ghost danger" }))));
			}
		}
		if (!table.children.length) {
			table.append(el("tr", {}, el("td", { class: "muted" }, "No plugins listed.")));
		}
		card.append(table);

		// Add a bundled or store plugin
		const available = pstate.bundled.concat(pstate.store)
			.filter(p => !folder.lists[KIND_KEYS[p.kind]].includes(p.name))
			.sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name));
		const select = el("select", {},
			el("option", { value: "" }, "Add a plugin, theme or language…"),
			el("optgroup", { label: "Store" }, available.filter(p => p.source === "store").map(p => el("option", { value: p.kind + "|" + p.name }, kindLabel(p.kind) + p.name + " " + p.version))),
			el("optgroup", { label: "Bundled with TiddlyWiki " + pstate.twVersion }, available.filter(p => p.source === "bundled").map(p => el("option", { value: p.kind + "|" + p.name }, kindLabel(p.kind) + p.name))));
		card.append(el("div", { class: "add-row" }, select, actionButton("Add", async () => {
			if (!select.value) {
				return "";
			}
			const [kind, name] = select.value.split("|");
			await papi.setList(folder.path, kind, folder.lists[KIND_KEYS[kind]].concat(name));
			return "Added " + name + " to " + folder.name + ".";
		})));

		// Plugins stored as tiddlers inside this folder
		if (folder.stored.length) {
			card.append(el("h3", {}, "Stored inside this wiki"));
			const storedTable = el("table", { class: "plugin-table" });
			for (const plugin of folder.stored) {
				const inStore = pstate.store.find(p => p.title === plugin.title);
				storedTable.append(el("tr", {},
					el("td", {}, plugin.title, el("div", { class: "desc" }, plugin.description)),
					el("td", {}, el("span", { class: "badge wiki" }, "in wiki " + plugin.version), inStore ? el("span", { class: "badge store" }, " store " + inStore.version) : null),
					el("td", { class: "actions-cell" }, actionButton("Move to store", async () => {
						if (!confirm("Move " + plugin.title + " into the shared store?\n\nIt is then listed in " + folder.name + "'s tiddlywiki.info, and its file is moved from the wiki into TW Desk's backup folder." + (inStore ? "\n\nThe store already has version " + inStore.version + "; it will be replaced by " + plugin.version + "." : ""))) {
							return "";
						}
						const result = await papi.moveToStore(folder.path, plugin.file);
						return "Moved " + result.title + " " + result.version + " to the store. Original file backed up in " + result.backupDir + ".";
					}, { disabled: folder.running, title: folder.running ? "Stop the wikis using this folder first" : "" }))));
			}
			card.append(storedTable);
		}
		panel.append(card);
	}
}

// ---------- Store tab ----------

function renderStoreTab() {
	const panel = $("#tab-store");
	panel.replaceChildren(
		el("p", { class: "muted small" }, "Shared plugins, kept outside the install folder so updates of TW Desk don't touch them. Add them to wikis in the Wikis tab."),
		el("div", { class: "add-row" },
			el("span", { class: "small" }, "Store folder: " + pstate.storePath),
			actionButton("Copy", async () => {
				await api.copyText(pstate.storePath);
				return "Copied the store folder path.";
			}, { class: "ghost copy" }),
			el("span", { class: "spacer" }),
			actionButton("Check for updates", async () => {
				updatesResult = await papi.checkUpdates();
				return updateSummary();
			}, { class: "primary" })));

	if (updatesResult) {
		renderUpdateCheck(panel);
	}

	panel.append(el("h3", {}, "In the store (" + pstate.store.length + ")"));
	if (!pstate.store.length) {
		panel.append(el("p", { class: "muted" }, "The store is empty. Install plugins from the Libraries tab, or move plugins stored in a wiki here from the Wikis tab."));
		return;
	}
	const table = el("table", { class: "plugin-table" });
	for (const plugin of pstate.store) {
		const users = usersOf(plugin.kind, plugin.name);
		table.append(el("tr", {},
			el("td", {}, plugin.title, el("div", { class: "desc" }, plugin.description)),
			el("td", {}, el("span", { class: "badge store" }, plugin.version || "no version")),
			el("td", { class: "small muted" }, plugin.library ? "from " + new URL(plugin.library).host : "local", el("div", {}, users.length ? "used by " + users.join(", ") : "not used")),
			el("td", { class: "actions-cell" }, actionButton("Remove", async () => {
				if (!confirm("Remove " + plugin.title + " from the store?")) {
					return "";
				}
				await papi.remove(plugin.kind, plugin.name);
				return "Removed " + plugin.title + " from the store.";
			}, { class: "ghost danger", disabled: users.length > 0, title: users.length ? "Remove it from " + users.join(", ") + " first" : "" }))));
	}
	panel.append(table);
}

// ---------- update check ----------

const UPDATE_STATUS = {
	update: { order: 0, label: "update available", badge: "update" },
	current: { order: 1, label: "up to date", badge: "store" },
	unlisted: { order: 2, label: "not in any library", badge: "", hint: "None of your libraries has this plugin, so it can't be checked." },
	unversioned: { order: 3, label: "no version", badge: "", hint: "The installed plugin has no version field, so it can't be compared." }
};

// Newer offers first; the library a store plugin was installed from wins a tie
function newerOffers(result) {
	if (!result.version) {
		return [];
	}
	return result.offers
		.filter(o => window.compareVersionsLoose(o.version, result.version) > 0)
		.sort((a, b) => window.compareVersionsLoose(b.version, a.version) || (b.library === result.library) - (a.library === result.library));
}

function updateStatus(result) {
	if (!result.version) {
		return "unversioned";
	}
	if (!result.offers.length) {
		return "unlisted";
	}
	return newerOffers(result).length ? "update" : "current";
}

// Short name for a library; the path is added when two libraries share a host
function libraryLabel(url) {
	const host = u => {
		try {
			return new URL(u).host;
		} catch (e) {
			return u;
		}
	};
	if (pstate.libraries.filter(l => host(l.url) === host(url)).length < 2) {
		return host(url);
	}
	const parsed = new URL(url);
	return parsed.host + parsed.pathname.replace(/\/(index\.html)?$/, "");
}

function updateSummary() {
	const counts = { update: 0, current: 0, unlisted: 0, unversioned: 0 };
	for (const result of updatesResult.results) {
		counts[updateStatus(result)]++;
	}
	const parts = [counts.update + " with updates", counts.current + " up to date"];
	if (counts.unlisted) {
		parts.push(counts.unlisted + " not in any library (not checked)");
	}
	if (counts.unversioned) {
		parts.push(counts.unversioned + " without version (not checked)");
	}
	const libraries = updatesResult.librariesChecked;
	return "Compared " + updatesResult.results.length + " installed plugins with " + libraries + (libraries === 1 ? " library: " : " libraries: ") + parts.join(", ") + "."
		+ (updatesResult.errors.length ? "\nCould not read:\n" + updatesResult.errors.join("\n") : "");
}

function renderUpdateCheck(panel) {
	panel.append(el("h3", {}, "Update check"),
		el("p", { class: "muted small" }, "Plugins in the store and plugins stored inside wikis, with the version each library offers. A plugin can be in more than one library; you choose which one to update from."));
	const rows = updatesResult.results
		.map(result => ({ result, status: updateStatus(result) }))
		.sort((a, b) => UPDATE_STATUS[a.status].order - UPDATE_STATUS[b.status].order || a.result.title.localeCompare(b.result.title));
	const table = el("table", { class: "plugin-table" });
	for (const { result, status } of rows) {
		const inStore = result.source === "store";
		const newer = newerOffers(result);
		const where = inStore
			? "in store" + (result.library ? " · installed from " + libraryLabel(result.library) : " · moved from a wiki")
			: "stored inside " + result.folder;
		const offers = result.offers.length
			? result.offers.map(o => {
				const cmp = result.version ? window.compareVersionsLoose(o.version, result.version) : 0;
				return el("span", {
					class: "badge" + (cmp > 0 ? " update" : cmp === 0 && result.version ? " store" : ""),
					title: libraryLabel(o.library) + " offers " + (o.version || "no version") + (cmp > 0 ? " (newer)" : cmp < 0 ? " (older)" : " (same)")
				}, libraryLabel(o.library) + " " + (o.version || "?"));
			})
			: [el("span", { class: "muted small" }, "—")];
		let actions;
		if (!newer.length) {
			actions = null;
		} else if (inStore) {
			actions = newer.map((offer, index) => actionButton((newer.length > 1 ? "Update from " + libraryLabel(offer.library) : "Update") + " → " + offer.version, async () => {
				const installed = await papi.install(offer.library, result.title);
				result.version = installed.version;
				result.library = offer.library;
				return "Updated " + installed.title + " to " + installed.version + " from " + libraryLabel(offer.library) + ". Restart the wikis using it to load the new version.";
			}, { class: index === 0 ? "primary" : "", title: "Install " + offer.version + " from " + offer.library + " into the store" }));
		} else {
			actions = el("span", { class: "muted small" }, "Move it to the store (Wikis tab), then update");
		}
		const info = UPDATE_STATUS[status];
		table.append(el("tr", {},
			el("td", {}, result.title, el("div", { class: "desc" }, where)),
			el("td", {}, el("span", { class: "badge wiki", title: "installed version" }, result.version || "no version")),
			el("td", {}, el("div", { class: "offers" }, offers)),
			el("td", {}, el("span", { class: "badge " + info.badge, title: info.hint || "" }, status === "update" ? "→ " + newer[0].version : info.label)),
			el("td", { class: "actions-cell" }, actions)));
	}
	panel.append(table);
}

// ---------- Libraries tab ----------

function renderLibrariesTab() {
	const panel = $("#tab-libraries");
	panel.replaceChildren(el("h3", {}, "Libraries"));
	const table = el("table", { class: "plugin-table" });
	for (const library of pstate.libraries) {
		table.append(el("tr", {},
			el("td", {}, library.url),
			el("td", {}, el("span", { class: "badge" }, library.type === "cpl" ? "CPL" : "TiddlyWiki library")),
			el("td", { class: "actions-cell" },
				actionButton("Browse", async () => {
					browse.url = library.url;
					browse.entries = await papi.libraryIndex(library.url, false);
					return browse.entries.length + " entries in " + library.url;
				}),
				actionButton("Remove", async () => {
					if (!confirm("Remove this library?\n" + library.url)) {
						return "";
					}
					await papi.removeLibrary(library.url);
					if (browse.url === library.url) {
						browse.url = null;
						browse.entries = null;
					}
					return "Removed library.";
				}, { class: "ghost danger" }))));
	}
	panel.append(table);
	const urlInput = el("input", { placeholder: "Library URL, e.g. https://tiddlywiki.com/library/v" + pstate.twVersion + "/index.html" });
	panel.append(el("div", { class: "add-row" }, urlInput, actionButton("Add library", async () => {
		const library = await papi.addLibrary(urlInput.value);
		return "Added " + library.url + ".";
	})));

	if (!browse.url || !browse.entries) {
		return;
	}
	panel.append(el("h3", {}, "Browse: " + browse.url));
	const search = el("input", { type: "search", placeholder: "Filter by name or description", value: browse.filter });
	const results = el("div");
	const renderResults = () => {
		const filter = browse.filter.toLowerCase();
		const matches = browse.entries.filter(e => !filter || (e.title + " " + e.description + " " + e.author).toLowerCase().includes(filter));
		const list = el("table", { class: "plugin-table" });
		for (const entry of matches.slice(0, 200)) {
			const bundled = pstate.bundled.find(p => p.title === entry.title);
			const stored = pstate.store.find(p => p.title === entry.title);
			let status = null;
			let action = null;
			if (bundled) {
				status = el("span", { class: "badge bundled" }, "bundled " + bundled.version);
			} else if (stored) {
				const newer = window.compareVersionsLoose(entry.version, stored.version) > 0;
				status = el("span", { class: "badge " + (newer ? "update" : "store") }, "store " + stored.version);
				action = newer ? actionButton("Update to " + entry.version, () => installEntry(entry)) : null;
			} else {
				action = actionButton("Install", () => installEntry(entry), { class: "primary" });
			}
			list.append(el("tr", {},
				el("td", {}, kindLabel(entry.kind) + entry.title.replace(/^\$:\/(plugins|themes|languages)\//, ""), el("div", { class: "desc" }, entry.description)),
				el("td", {}, el("span", { class: "badge" }, entry.version || "?")),
				el("td", {}, status),
				el("td", { class: "actions-cell" }, action)));
		}
		results.replaceChildren(el("div", { class: "muted small" }, matches.length + " matching" + (matches.length > 200 ? ", showing the first 200" : "")), list);
	};
	search.addEventListener("input", () => {
		browse.filter = search.value;
		renderResults();
	});
	panel.append(el("div", { class: "add-row" }, search, actionButton("Reload", async () => {
		browse.entries = await papi.libraryIndex(browse.url, true);
		return "Reloaded " + browse.entries.length + " entries.";
	})), results);
	renderResults();
}

async function installEntry(entry) {
	const result = await papi.install(browse.url, entry.title);
	return "Installed " + result.title + " " + result.version + " into the store. Add it to wikis in the Wikis tab.";
}

// Version comparison for the UI (main process has the same logic)
window.compareVersionsLoose = (a, b) => {
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
};

// ---------- window ----------

function renderPlugins() {
	for (const tab of document.querySelectorAll("#plugins-dialog .tab")) {
		tab.classList.toggle("active", tab.dataset.tab === activeTab);
	}
	for (const name of ["wikis", "store", "libraries"]) {
		$("#tab-" + name).hidden = name !== activeTab;
	}
	if (activeTab === "wikis") {
		renderWikisTab();
	} else if (activeTab === "store") {
		renderStoreTab();
	} else {
		renderLibrariesTab();
	}
}

for (const tab of document.querySelectorAll("#plugins-dialog .tab")) {
	tab.addEventListener("click", () => {
		activeTab = tab.dataset.tab;
		renderPlugins();
	});
}

$("#show-plugins").addEventListener("click", () => run(async () => {
	showMessage("");
	await reloadPlugins();
	$("#plugins-dialog").showModal();
}));
$("#close-plugins").addEventListener("click", () => $("#plugins-dialog").close());

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
				const count = updatesResult.updates.length;
				return (count ? count + " update(s) available." : "Everything is up to date (" + updatesResult.checked + " checked).") + (updatesResult.errors.length ? "\n" + updatesResult.errors.join("\n") : "");
			}, { class: "primary" })));

	if (updatesResult && updatesResult.updates.length) {
		panel.append(el("h3", {}, "Updates"));
		const table = el("table", { class: "plugin-table" });
		for (const update of updatesResult.updates) {
			const inStore = update.source === "store";
			table.append(el("tr", {},
				el("td", {}, update.title, el("div", { class: "desc" }, inStore ? "in store" : "stored inside " + update.folder)),
				el("td", {}, el("span", { class: "badge update" }, update.version + " → " + update.latest)),
				el("td", { class: "actions-cell" }, inStore
					? actionButton("Update", async () => {
						const result = await papi.install(update.latestLibrary, update.title);
						updatesResult.updates = updatesResult.updates.filter(u => u !== update);
						return "Updated " + result.title + " to " + result.version + ". Restart the wikis using it to load the new version.";
					})
					: el("span", { class: "muted small" }, "Move it to the store (Wikis tab), then update"))));
		}
		panel.append(table);
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

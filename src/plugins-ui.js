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
			el("td", { class: "small muted" }, plugin.library ? "from " + libraryLabel(plugin.library) : "local", el("div", {}, users.length ? "used by " + users.join(", ") : "not used"), demoButtons(plugin.title)),
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
	if (url.startsWith("showcase:")) {
		const showcase = pstate.showcases.find(sc => sc.url === url);
		return "showcase " + (showcase ? showcase.name : "(removed)");
	}
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
	const showcases = updatesResult.showcasesChecked || 0;
	return "Compared " + updatesResult.results.length + " installed plugins with " + libraries + (libraries === 1 ? " library" : " libraries")
		+ (showcases ? " and " + showcases + (showcases === 1 ? " showcase" : " showcases") : "") + ": " + parts.join(", ") + "."
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

// ---------- Libraries tab: one search across all libraries ----------

const search = { query: "", library: "", kind: "", hideInstalled: false, indexes: null, loading: null, open: new Set(), limit: 100 };
const SEARCH_PAGE = 100;
const ENTRY_FIELDS = ["title", "name", "author", "tags", "description", "version"];
const FIELD_ALIASES = { tag: "tags" };

// Words must all match somewhere; "a phrase" is one word; -word excludes; field:value looks in one field only
// (title, name, author, tag, description, version or any other index field, e.g. core-version:5.3)
function parseQuery(text) {
	const terms = [];
	const pattern = /(-)?(?:([\w-]+):)?(?:"([^"]*)"?|(\S+))/g;
	let match;
	while ((match = pattern.exec(text))) {
		const value = (match[3] !== undefined ? match[3] : match[4] || "").toLowerCase();
		// A lone "-" is an exclusion still being typed
		if (value && value !== "-") {
			const field = match[2] ? match[2].toLowerCase() : null;
			terms.push({ exclude: !!match[1], field: field ? FIELD_ALIASES[field] || field : null, value });
		}
	}
	return terms;
}

function entryText(entry, field) {
	if (!field) {
		if (entry.searchText === undefined) {
			entry.searchText = [entry.title, entry.description, entry.author, entry.tags].concat(Object.values(entry.fields || {})).join("\n").toLowerCase();
		}
		return entry.searchText;
	}
	return String((ENTRY_FIELDS.includes(field) ? entry[field] : (entry.fields || {})[field]) || "").toLowerCase();
}

// One group per plugin title, with what each library offers (newest first)
function searchGroups() {
	const groups = new Map();
	for (const index of search.indexes || []) {
		if (!index.entries || (search.library && index.url !== search.library)) {
			continue;
		}
		for (const entry of index.entries) {
			if (search.kind && entry.kind !== search.kind) {
				continue;
			}
			if (!groups.has(entry.title)) {
				groups.set(entry.title, { title: entry.title, kind: entry.kind, name: entry.name, offers: [] });
			}
			groups.get(entry.title).offers.push({ library: index.url, entry });
		}
	}
	for (const group of groups.values()) {
		group.offers.sort((a, b) => window.compareVersionsLoose(b.entry.version, a.entry.version));
		group.entry = group.offers[0].entry;
	}
	return [...groups.values()];
}

// -1 if the group doesn't match; higher is better (name > title > description > author/tags > other fields)
function scoreGroup(group, terms) {
	let score = 0;
	for (const term of terms) {
		const hit = group.offers.some(o => entryText(o.entry, term.field).includes(term.value));
		if (term.exclude ? hit : !hit) {
			return -1;
		}
		if (!term.exclude) {
			const e = group.entry;
			score += e.name.toLowerCase() === term.value ? 20
				: e.title.toLowerCase().includes(term.value) ? 10
				: e.description.toLowerCase().includes(term.value) ? 3
				: (e.author + " " + e.tags).toLowerCase().includes(term.value) ? 2 : 1;
		}
	}
	return score;
}

// Bundled / in the store (and whether a library has a newer version)
function installedState(group) {
	const bundled = pstate.bundled.find(p => p.title === group.title);
	if (bundled) {
		return { badge: el("span", { class: "badge bundled", title: "Comes with TiddlyWiki; the bundled version is always used" }, "bundled " + bundled.version), installed: true, newer: false };
	}
	const stored = pstate.store.find(p => p.title === group.title);
	if (stored) {
		const newer = window.compareVersionsLoose(group.entry.version, stored.version) > 0;
		return { badge: el("span", { class: "badge " + (newer ? "update" : "store") }, "store " + (stored.version || "?")), installed: true, newer, stored };
	}
	return { badge: null, installed: false, newer: false };
}

// The text with the searched words marked
function highlighted(text, terms) {
	const words = terms.filter(t => !t.exclude).map(t => t.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (!words.length || !text) {
		return [text];
	}
	return String(text).split(new RegExp("(" + words.join("|") + ")", "gi")).map((part, i) => (i % 2 ? el("mark", {}, part) : part));
}

function loadIndexes(refresh) {
	search.loading = papi.allIndexes(refresh).then(indexes => {
		search.indexes = indexes;
	}).catch(e => {
		search.indexes = [];
		showMessage(cleanError(e), true);
	}).finally(() => {
		search.loading = null;
		if (activeTab === "libraries") {
			renderPlugins();
		}
	});
	return search.loading;
}

function renderLibrariesTab() {
	const panel = $("#tab-libraries");
	if (!search.indexes && !search.loading) {
		loadIndexes(false);
	}
	const input = el("input", { type: "search", class: "library-search", placeholder: "Search all libraries – e.g. relink, author:flibbles, tag:editor, \"table of contents\", -theme", value: search.query });
	const librarySelect = el("select", { title: "Search in" },
		el("option", { value: "" }, "All libraries and showcases"),
		el("optgroup", { label: "Libraries" }, pstate.libraries.map(l => el("option", { value: l.url }, libraryLabel(l.url)))),
		pstate.showcases.length ? el("optgroup", { label: "Showcases" }, pstate.showcases.map(sc => el("option", { value: sc.url }, sc.name))) : null);
	librarySelect.value = search.library;
	const kindSelect = el("select", { title: "Kind" },
		el("option", { value: "" }, "Plugins, themes, languages"),
		el("option", { value: "plugin" }, "Plugins"),
		el("option", { value: "theme" }, "Themes"),
		el("option", { value: "language" }, "Languages"));
	kindSelect.value = search.kind;
	const hide = el("input", { type: "checkbox", checked: search.hideInstalled });
	const results = el("div", { class: "search-results" });
	const update = () => {
		search.limit = SEARCH_PAGE;
		renderSearchResults(results);
	};
	input.addEventListener("input", () => {
		search.query = input.value;
		update();
	});
	librarySelect.addEventListener("change", () => {
		search.library = librarySelect.value;
		update();
	});
	kindSelect.addEventListener("change", () => {
		search.kind = kindSelect.value;
		update();
	});
	hide.addEventListener("change", () => {
		search.hideInstalled = hide.checked;
		update();
	});
	panel.replaceChildren(
		el("div", { class: "add-row" }, input, actionButton("Reload", async () => {
			await loadIndexes(true);
			return "Reloaded all libraries.";
		}, { class: "ghost", title: "Fetch the libraries' lists again" })),
		el("div", { class: "add-row search-filters" }, librarySelect, kindSelect, el("label", { class: "inline small" }, hide, " hide installed")),
		results,
		renderLibraryManagement());
	renderSearchResults(results);
	input.focus();
}

function renderSearchResults(container) {
	if (!search.indexes) {
		container.replaceChildren(el("p", { class: "muted" }, "Loading the libraries…"));
		return;
	}
	const terms = parseQuery(search.query);
	const matches = searchGroups()
		.map(group => ({ group, score: terms.length ? scoreGroup(group, terms) : 0, state: null }))
		.filter(m => m.score >= 0)
		.map(m => Object.assign(m, { state: installedState(m.group) }))
		.filter(m => !search.hideInstalled || !m.state.installed || m.state.newer)
		.sort((a, b) => b.score - a.score || a.group.name.localeCompare(b.group.name));
	const errors = search.indexes.filter(i => i.error);
	const read = search.indexes.filter(i => i.entries && i.type !== "showcase" && (!search.library || i.url === search.library)).length;
	const showcases = search.indexes.filter(i => i.type === "showcase" && i.entries.length && (!search.library || i.url === search.library)).length;
	const summary = el("div", { class: "muted small" },
		matches.length + (matches.length === 1 ? " match" : " matches") + " in " + read + (read === 1 ? " library" : " libraries")
		+ (showcases ? " and " + showcases + (showcases === 1 ? " showcase" : " showcases") : "")
		+ (terms.length ? "" : " (everything; type to search)"));
	const parts = [summary];
	for (const failed of errors) {
		parts.push(el("div", { class: "error small" }, "Could not read " + failed.url + ": " + failed.error));
	}
	const table = el("table", { class: "plugin-table search-table" });
	for (const { group, state } of matches.slice(0, search.limit)) {
		appendSearchRow(table, group, state, terms);
	}
	parts.push(table);
	if (matches.length > search.limit) {
		parts.push(el("button", { type: "button", class: "ghost", onclick: () => {
			search.limit += SEARCH_PAGE;
			renderSearchResults(container);
		} }, "Show more (" + (matches.length - search.limit) + " left)"));
	}
	container.replaceChildren(...parts);
}

function appendSearchRow(table, group, state, terms) {
	const e = group.entry;
	const open = search.open.has(group.title);
	const byline = [e.author ? "by " + e.author : "", e.tags ? "tags: " + e.tags : ""].filter(Boolean).join(" · ");
	const nameCell = el("td", { class: "search-name", title: open ? "Hide details" : "Show all fields" },
		el("span", { class: "toggle" }, open ? "▾ " : "▸ "),
		kindLabel(group.kind), highlighted(group.name, terms),
		e.description ? el("div", { class: "desc" }, highlighted(e.description, terms)) : null,
		byline ? el("div", { class: "desc small" }, highlighted(byline, terms)) : null);
	nameCell.addEventListener("click", () => {
		if (open) {
			search.open.delete(group.title);
		} else {
			search.open.add(group.title);
		}
		renderSearchResults(table.parentNode);
	});
	const installedVersion = state.stored ? state.stored.version : null;
	const offers = group.offers.map(o => el("span", {
		class: "badge" + (installedVersion && window.compareVersionsLoose(o.entry.version, installedVersion) > 0 ? " update" : ""),
		title: libraryLabel(o.library) + " offers " + (o.entry.version || "no version")
	}, libraryLabel(o.library) + " " + (o.entry.version || "?")));
	// One button per library with a version worth installing (newest first)
	let actions = null;
	if (!pstate.bundled.find(p => p.title === group.title)) {
		const candidates = group.offers.filter(o => !installedVersion || window.compareVersionsLoose(o.entry.version, installedVersion) > 0);
		const several = new Set(candidates.map(o => o.entry.version)).size > 1 || candidates.length > 1;
		actions = candidates.map((o, i) => actionButton((installedVersion ? "Update → " + o.entry.version : "Install") + (several ? " from " + libraryLabel(o.library) : ""), async () => {
			const result = await papi.install(o.library, group.title);
			return (installedVersion ? "Updated " : "Installed ") + result.title + " " + result.version + " from " + libraryLabel(o.library) + " into the store."
				+ (installedVersion ? " Restart the wikis using it to load the new version." : " Add it to wikis in the Wikis tab.");
		}, { class: i === 0 ? "primary" : "", title: "Into the shared store, from " + o.library }));
	}
	table.append(el("tr", {},
		nameCell,
		el("td", {}, el("div", { class: "offers" }, offers)),
		el("td", {}, state.badge),
		el("td", { class: "actions-cell" }, actions, demoButtons(group.title))));
	if (open) {
		table.append(el("tr", { class: "search-details" }, el("td", { colSpan: 4 }, group.offers.map(o => entryDetails(o, terms)))));
	}
}

// All index fields of one library's entry; web addresses open in the browser
function entryDetails(offer, terms) {
	const fields = Object.assign({ title: offer.entry.title }, offer.entry.fields);
	const list = el("dl", { class: "entry-fields" });
	for (const key of Object.keys(fields).sort()) {
		const value = fields[key];
		const links = value.match(/https?:\/\/[^\s<>"'\]]+/g);
		list.append(el("dt", {}, key), el("dd", {},
			links && links.length === 1 && links[0] === value.trim()
				? el("a", { href: "#", onclick: event => {
					event.preventDefault();
					run(() => papi.openLink(links[0]));
				} }, value)
				: highlighted(value, terms)));
	}
	return el("div", { class: "entry-library" }, el("div", { class: "small muted" }, libraryLabel(offer.library) + " · " + offer.library), list);
}

function renderLibraryManagement() {
	const details = el("details", { class: "library-management", open: !pstate.libraries.length },
		el("summary", {}, "Libraries (" + pstate.libraries.length + ")"));
	const table = el("table", { class: "plugin-table" });
	for (const library of pstate.libraries) {
		const index = (search.indexes || []).find(i => i.url === library.url);
		const count = !index ? "" : index.error ? "not readable" : index.entries.length + " entries";
		table.append(el("tr", {},
			el("td", {}, library.url, el("div", { class: "desc" }, count)),
			el("td", {}, el("span", { class: "badge" }, library.type === "cpl" ? "CPL" : "TiddlyWiki library")),
			el("td", { class: "actions-cell" },
				actionButton("Search only this", async () => {
					search.library = library.url;
					search.limit = SEARCH_PAGE;
					return "";
				}, { class: "ghost" }),
				actionButton("Remove", async () => {
					if (!confirm("Remove this library?\n" + library.url)) {
						return "";
					}
					await papi.removeLibrary(library.url);
					if (search.library === library.url) {
						search.library = "";
					}
					search.indexes = search.indexes && search.indexes.filter(i => i.url !== library.url);
					return "Removed library.";
				}, { class: "ghost danger" }))));
	}
	const urlInput = el("input", { placeholder: "Library URL, e.g. https://tiddlywiki.com/library/v" + pstate.twVersion + "/index.html" });
	details.append(table, el("div", { class: "add-row" }, urlInput, actionButton("Add library", async () => {
		const library = await papi.addLibrary(urlInput.value);
		search.indexes = null;
		return "Added " + library.url + ".";
	})));
	return details;
}

// ---------- Showcases tab ----------

// "Demo" buttons for the showcases whose snapshot contains the plugin (open the snapshot)
function demoButtons(title) {
	return pstate.showcases
		.filter(sc => sc.snapshot && sc.entries.some(e => e.title === title))
		.map(sc => el("button", { type: "button", class: "ghost demo", title: "Open the showcase \u201c" + sc.name + "\u201d (snapshot " + sc.snapshot.slice(0, 10) + ")",
			onclick: event => {
				event.stopPropagation();
				run(() => api.webWikis.openSnapshot(sc.id));
			} }, "Demo" + (pstate.showcases.length > 1 ? ": " + sc.name : "")));
}

function renderShowcasesTab() {
	const panel = $("#tab-showcases");
	panel.replaceChildren(el("p", { class: "muted small" },
		"Web wikis marked as plugin showcase (Edit… on a web wiki in the main window). Their plugins come from the saved snapshot and can be added to the store from there – useful for plugins that aren't in any library. Showcases also count in the library search and the update check."));
	if (!pstate.showcases.length) {
		panel.append(el("p", { class: "muted" }, "No showcases yet. In the main window, add a web wiki link (+ New → Web wiki link…) and tick \u201cPlugin showcase\u201d."));
		return;
	}
	for (const showcase of pstate.showcases) {
		const card = el("div", { class: "card" });
		card.append(el("div", { class: "card-title" },
			el("strong", {}, showcase.name),
			el("span", { class: "muted small" }, showcase.site),
			el("span", { class: "spacer" }),
			showcase.snapshot ? el("button", { type: "button", class: "primary", onclick: () => run(() => api.webWikis.openSnapshot(showcase.id)) }, "Open demo") : null,
			el("button", { type: "button", class: "ghost", onclick: () => run(() => api.webWikis.open(showcase.id)) }, "Website ↗"),
			actionButton(showcase.snapshot ? "Update snapshot" : "Save snapshot", async () => {
				await api.webWikis.saveSnapshot(showcase.id);
				search.indexes = null;
				return "Saved the snapshot of " + showcase.name + ".";
			}, { class: "ghost" })));
		if (showcase.description) {
			card.append(el("div", { class: "desc small" }, showcase.description));
		}
		if (!showcase.snapshot) {
			card.append(el("p", { class: "muted small" }, "No snapshot yet – save one to see its plugins."));
			panel.append(card);
			continue;
		}
		const entries = showcase.entries.slice().sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name));
		card.append(el("div", { class: "muted small" }, "Snapshot of " + showcase.snapshot.slice(0, 10) + ": " + entries.length + (entries.length === 1 ? " plugin, theme or language" : " plugins, themes and languages")));
		const table = el("table", { class: "plugin-table" });
		for (const entry of entries) {
			const bundled = pstate.bundled.find(p => p.title === entry.title);
			const stored = pstate.store.find(p => p.title === entry.title);
			let status = null;
			let action = null;
			if (bundled) {
				status = el("span", { class: "badge bundled", title: "Comes with TiddlyWiki; the bundled version is always used" }, "bundled " + bundled.version);
			} else if (stored) {
				const newer = window.compareVersionsLoose(entry.version, stored.version) > 0;
				status = el("span", { class: "badge " + (newer ? "update" : "store") }, "store " + (stored.version || "?"));
				action = newer ? actionButton("Update → " + entry.version, () => installFromShowcase(showcase, entry, true), { class: "primary" }) : null;
			} else {
				action = actionButton("Add to store", () => installFromShowcase(showcase, entry, false), { class: "primary" });
			}
			table.append(el("tr", {},
				el("td", {}, kindLabel(entry.kind) + entry.name, entry.description ? el("div", { class: "desc" }, entry.description) : null,
					entry.author ? el("div", { class: "desc small" }, "by " + entry.author) : null),
				el("td", {}, el("span", { class: "badge" }, entry.version || "no version")),
				el("td", {}, status),
				el("td", { class: "actions-cell" }, action)));
		}
		if (!entries.length) {
			table.append(el("tr", {}, el("td", { class: "muted" }, "The snapshot contains no plugins (besides the TiddlyWiki core).")));
		}
		card.append(table);
		panel.append(card);
	}
}

async function installFromShowcase(showcase, entry, update) {
	const result = await papi.install(showcase.url, entry.title);
	return (update ? "Updated " : "Added ") + result.title + " " + result.version + " from the showcase " + showcase.name + " to the store."
		+ (update ? " Restart the wikis using it to load the new version." : " Add it to wikis in the Wikis tab.");
}

// Opens the Plugins window on a tab (e.g. from a showcase in the main window)
function openPluginsTab(tab) {
	activeTab = tab;
	return run(async () => {
		showMessage("");
		search.indexes = null;
		await reloadPlugins();
		if (!$("#plugins-dialog").open) {
			$("#plugins-dialog").showModal();
		}
	});
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
	for (const name of ["wikis", "store", "libraries", "showcases"]) {
		$("#tab-" + name).hidden = name !== activeTab;
	}
	if (activeTab === "wikis") {
		renderWikisTab();
	} else if (activeTab === "store") {
		renderStoreTab();
	} else if (activeTab === "showcases") {
		renderShowcasesTab();
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

$("#show-plugins").addEventListener("click", () => openPluginsTab(activeTab));
$("#close-plugins").addEventListener("click", () => $("#plugins-dialog").close());

"use strict";

const api = window.twDesk;
const $ = selector => document.querySelector(selector);

let state = { groups: [], wikis: [] };
let logWikiId = null; // wiki shown in the bottom panel
let panelTab = "log";
let editingId = null;
let dialogIncludes = []; // [{ path (absolute), readOnly, exists }] while the Edit dialog is open

// Must match folderKey() in main.js
function pathKey(folder) {
	return state.caseInsensitivePaths ? folder.toLowerCase() : folder;
}

const FILE_MANAGER = { win32: "Explorer", darwin: "Finder" };

const STATUS_TEXT = { running: "running", starting: "starting…", stopped: "stopped", error: "error" };

// ---------- wiki list ----------

function button(label, onClick, options = {}) {
	const b = document.createElement("button");
	b.textContent = label;
	b.title = options.title || label;
	b.disabled = !!options.disabled;
	if (options.className) {
		b.className = options.className;
	}
	b.addEventListener("click", event => {
		event.stopPropagation();
		run(onClick);
	});
	return b;
}

async function run(action) {
	try {
		await action();
	} catch (e) {
		alert(cleanError(e));
	}
}

function cleanError(e) {
	return String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function render() {
	// Rebuilding the list would end a drag; render once it's over
	if (draggedId) {
		renderPending = true;
		return;
	}
	const list = $("#wiki-list");
	list.replaceChildren();
	$("#empty-hint").hidden = state.wikis.length > 0 || state.groups.length > 0;
	for (const group of state.groups) {
		const wikis = state.wikis.filter(w => w.group === group.id);
		list.append(groupHeader(group, wikis));
		if (group.collapsed) {
			continue;
		}
		if (!wikis.length) {
			const empty = document.createElement("li");
			empty.className = "group-empty muted";
			empty.dataset.group = group.id;
			empty.textContent = "No wikis in this group. Drag a wiki here, or choose the group in its Edit dialog.";
			list.append(empty);
		}
		wikis.forEach((wiki, index) => list.append(wikiItem(wiki, index, wikis.length)));
	}
	const ungrouped = state.wikis.filter(w => !w.group);
	const showUngroupedHeader = ungrouped.length && state.groups.length;
	if (state.groups.length) {
		// Without ungrouped wikis the header is only shown while dragging, as a drop target
		const header = groupHeader(null, ungrouped);
		header.classList.toggle("drop-only", !ungrouped.length);
		list.append(header);
	}
	if (!(showUngroupedHeader && state.ungroupedCollapsed)) {
		ungrouped.forEach((wiki, index) => list.append(wikiItem(wiki, index, ungrouped.length)));
	}
	const links = state.webWikis || [];
	if (links.length) {
		list.append(webHeader(links));
		if (!state.webCollapsed) {
			links.forEach((link, index) => list.append(webItem(link, index, links.length)));
		}
	}
	if (logWikiId) {
		const wiki = state.wikis.find(w => w.id === logWikiId);
		if (wiki) {
			$("#log-title").textContent = wiki.name;
			for (const tab of document.querySelectorAll("[data-panel-tab]")) {
				tab.classList.toggle("active", tab.dataset.panelTab === panelTab);
			}
			$("#log-output").hidden = panelTab !== "log";
			$("#git-view").hidden = panelTab !== "git";
			if (panelTab === "git") {
				renderGitView(wiki);
			}
		} else {
			hideLog();
		}
	}
	renderGitFooter();
}

// group null is the "Ungrouped" section
function groupHeader(group, wikis) {
	const count = wikis.length;
	const collapsed = group ? !!group.collapsed : !!state.ungroupedCollapsed;
	const li = document.createElement("li");
	li.className = "group-header";
	li.dataset.group = group ? group.id : "";
	const toggle = button((collapsed ? "▸ " : "▾ ") + (group ? group.name : "Ungrouped"), () => api.setGroupCollapsed(group ? group.id : null, !collapsed), {
		className: "ghost group-toggle",
		title: collapsed ? "Show the wikis of this group" : "Hide the wikis of this group"
	});
	const meta = document.createElement("span");
	meta.className = "muted";
	const running = wikis.filter(w => w.status === "running").length;
	const attention = wikis.filter(gitNeedsAttention).length;
	meta.textContent = count + (count === 1 ? " wiki" : " wikis") + (collapsed && running ? " · " + running + " running" : "")
		+ (collapsed && attention ? " · " + attention + " need git attention" : "");
	const spacer = document.createElement("span");
	spacer.className = "spacer";
	li.append(toggle, meta, spacer);
	if (group) {
		li.append(
			button("Rename", () => openGroupDialog(group), { className: "ghost" }),
			button("Delete", () => removeGroup(group, count), { className: "ghost danger", title: "Delete the group (its wikis stay, ungrouped)" })
		);
	}
	return li;
}

// index and count are the wiki's position within its group
function wikiItem(wiki, index, count) {
	const running = wiki.status === "running";
	const busy = wiki.status === "starting";
	const li = document.createElement("li");
	li.className = "wiki" + (wiki.id === logWikiId ? " selected" : "");
	li.draggable = true;
	li.dataset.wikiId = wiki.id;
	li.dataset.group = wiki.group || "";

	const dot = document.createElement("span");
	dot.className = "dot " + wiki.status;
	dot.title = STATUS_TEXT[wiki.status];

	const info = document.createElement("div");
	info.className = "wiki-info";
	const name = document.createElement("div");
	name.className = "wiki-name";
	name.append(wiki.name);
	const chip = gitChip(wiki);
	if (chip) {
		name.append(" ", chip);
	}
	const meta = document.createElement("div");
	meta.className = "wiki-meta";
	meta.textContent = STATUS_TEXT[wiki.status] + " · " + portText(wiki) + (wiki.autostart ? " · autostart" : "") + " · " + wiki.path;
	meta.title = wiki.path + (!wiki.fixedPort && wiki.lastPort ? "\nAutomatic port; last used: " + wiki.lastPort : "");
	info.append(name);
	const about = aboutText(wiki);
	if (about) {
		const line = document.createElement("div");
		line.className = "wiki-description";
		line.textContent = about;
		line.title = about.replace(" — ", "\n\n");
		info.append(line);
	}
	info.append(meta);
	if (wiki.status === "error" && wiki.error) {
		const err = document.createElement("div");
		err.className = "wiki-error";
		err.textContent = wiki.error;
		info.append(err);
	}
	if (wiki.infoError) {
		const err = document.createElement("div");
		err.className = "wiki-error";
		err.textContent = wiki.infoError;
		info.append(err);
	}
	if (wiki.includes.length) {
		const line = document.createElement("div");
		line.className = "wiki-includes";
		line.append("includes:");
		for (const include of wiki.includes) {
			const chip = includeChip(folderName(include.resolved) + (include.readOnly ? " (read-only)" : ""), include);
			const dot = include.exists ? gitDot(include.resolved) : null;
			if (dot) {
				chip.append(" ", dot);
			}
			line.append(chip);
		}
		info.append(line);
	}

	const actions = document.createElement("div");
	actions.className = "wiki-actions";
	const more = button("⋯", () => showMenu(wikiMenu(wiki, index, count), more), { className: "ghost more", title: "More: browser, folder, log, git, edit, copy, move, remove" });
	actions.append(
		running || busy
			? button("Stop", () => api.stopWiki(wiki.id), { disabled: busy })
			: button("Start", () => api.startWiki(wiki.id)),
		button("Open", () => api.openWiki(wiki.id, false), { className: "primary", title: "Open in a TW Desk window (starts the server if needed)" }),
		more
	);

	li.append(dot, info, actions);
	li.addEventListener("dblclick", () => run(() => api.openWiki(wiki.id, false)));
	li.addEventListener("contextmenu", event => {
		event.preventDefault();
		showMenu(wikiMenu(wiki, index, count), { x: event.clientX, y: event.clientY });
	});
	return li;
}

// The "⋯" menu and right-click menu of a wiki row; index and count: its position within its group
function wikiMenu(wiki, index, count) {
	const busy = wiki.status === "running" || wiki.status === "starting";
	const act = action => () => run(action);
	const gitAvailable = !!(state.git && state.git.available);
	return [
		{ label: "Open in browser", action: act(() => api.openWiki(wiki.id, true)), title: wiki.url ? "Open " + wiki.url + " in the default browser" : "Starts the server if needed" },
		{ label: "Show in " + (FILE_MANAGER[state.platform] || "file manager"), action: act(() => api.showFolder(wiki.id)), title: wiki.path },
		"-",
		{ label: "Log", action: act(() => showPanel(wiki.id, "log")) },
		{ label: "Git", action: act(() => showPanel(wiki.id, "git")), disabled: !gitAvailable, title: gitAvailable ? "" : "Git isn't installed" },
		"-",
		{ label: "Edit…", action: act(() => openDialog(wiki)), disabled: busy, title: busy ? "Stop the wiki to edit it" : "" },
		{ label: "Copy…", action: act(() => openCreateWizard("copy", wiki)), title: "Create a new wiki as a copy of this one" },
		"-",
		{ label: "Move up", action: act(() => api.moveWiki(wiki.id, -1)), disabled: index === 0 },
		{ label: "Move down", action: act(() => api.moveWiki(wiki.id, 1)), disabled: index === count - 1 },
		"-",
		{ label: "Remove…", action: act(() => openRemoveDialog(wiki)), title: "Remove from the list, or delete the wiki (folder to the trash)" }
	];
}

// ---------- web wikis ----------

function webHeader(links) {
	const li = document.createElement("li");
	li.className = "group-header web-header";
	const collapsed = !!state.webCollapsed;
	const checking = links.some(l => l.busy === "checking");
	li.append(
		button((collapsed ? "▸ " : "▾ ") + "Web wikis", () => api.webWikis.setCollapsed(!collapsed), {
			className: "ghost group-toggle",
			title: (collapsed ? "Show" : "Hide") + " your links to wikis on the web"
		}),
		Object.assign(document.createElement("span"), { className: "muted", textContent: links.length + (links.length === 1 ? " link" : " links") })
	);
	const changed = links.filter(l => l.check && l.check.result === "changed").length;
	if (changed) {
		li.append(Object.assign(document.createElement("span"), { className: "git-chip warn", textContent: changed + " changed", title: changed + (changed === 1 ? " website has" : " websites have") + " changed since you last looked" }));
	}
	li.append(button("+", () => openLinkDialog(null), { className: "ghost", title: "Add a web wiki link" }));
	li.append(button(checking ? "Checking…" : "Check for changes", () => api.webWikis.checkAll(), {
		className: "ghost",
		disabled: checking,
		title: "Ask every website whether its wiki changed" + (state.webCheck ? " (also done once a day)" : "")
	}));
	return li;
}

function day(iso) {
	return iso ? iso.slice(0, 10) : "";
}

// "12 changed, 3 new, 1 removed"
function changeCounts(check) {
	const parts = [];
	if (check.changed) {
		parts.push(check.changed + " changed");
	}
	if (check.added) {
		parts.push(check.added + " new");
	}
	if (check.removed) {
		parts.push(check.removed + " removed");
	}
	return parts.join(", ");
}

// Chip after the name: what's going on, or what the last check found ({ text, level, title } or null)
function webStatus(link) {
	if (link.busy) {
		return { text: link.busy === "saving" ? "saving snapshot…" : "checking…", level: "", title: "" };
	}
	const check = link.check;
	if (!check || check.result === "same") {
		return null;
	}
	const checked = " (checked " + day(check.date) + ")";
	if (check.result === "error") {
		return { text: "unreachable", level: "bad", title: check.error + checked };
	}
	const counts = changeCounts(check);
	const total = (check.changed || 0) + (check.added || 0) + (check.removed || 0);
	const since = link.snapshot ? "your snapshot of " + day(link.snapshot.date) : "you added it or marked it as seen";
	return {
		text: total ? "changed · " + total + (total === 1 ? " tiddler" : " tiddlers") : "changed",
		level: "warn",
		title: "The wiki on the website changed since " + since + (counts ? ":\n" + counts + " tiddlers" : "") + (check.twVersion ? "\nnow TiddlyWiki " + check.twVersion : "") + checked
	};
}

function snapshotText(snapshot) {
	const parts = ["snapshot " + day(snapshot.date)];
	if (snapshot.tiddlers !== null && snapshot.tiddlers !== undefined) {
		parts.push(snapshot.tiddlers.toLocaleString() + " tiddlers");
	}
	if (snapshot.twVersion) {
		parts.push("TW " + snapshot.twVersion);
	}
	return parts.join(" · ");
}

function webItem(link, index, count) {
	const li = document.createElement("li");
	li.className = "wiki web-link";
	const icon = document.createElement("span");
	icon.className = "web-icon";
	icon.textContent = "↗";
	const info = document.createElement("div");
	info.className = "wiki-info";
	const name = document.createElement("div");
	name.className = "wiki-name";
	name.textContent = link.name;
	const status = webStatus(link);
	if (status) {
		const chip = status.level
			? button(status.text, () => showMenu(webMenu(link, index, count), chip), { className: "git-chip " + status.level, title: status.title + "\n(click for actions)" })
			: Object.assign(document.createElement("span"), { className: "git-chip", textContent: status.text });
		name.append(chip);
	}
	if (link.showcase) {
		const plugins = link.snapshot ? link.pluginCount + (link.pluginCount === 1 ? " plugin" : " plugins") : "no snapshot yet";
		// Linked: name what it demonstrates ("showcase of relink +1")
		const linked = (link.linkedPlugins || []).map(title => title.split("/").pop());
		const text = linked.length ? "showcase of " + linked[0] + (linked.length > 1 ? " +" + (linked.length - 1) : "") : "showcase · " + plugins;
		name.append(button(text, () => openPluginsTab("showcases"), {
			className: "git-chip showcase-chip",
			title: "Plugin showcase: its plugins are listed in Plugins → Showcases" + (link.snapshot ? "" : " once you save a snapshot")
				+ (linked.length ? "\nDemo of: " + link.linkedPlugins.join(", ") : "")
		}));
	}
	info.append(name);
	if (link.description) {
		const line = document.createElement("div");
		line.className = "wiki-description";
		line.textContent = link.description.replace(/\s*\n\s*/g, " ");
		line.title = link.description;
		info.append(line);
	}
	const meta = document.createElement("div");
	meta.className = "wiki-meta";
	meta.textContent = link.url + (link.snapshot ? "  ·  " + snapshotText(link.snapshot) : "");
	meta.title = link.url;
	info.append(meta);
	const actions = document.createElement("div");
	actions.className = "wiki-actions";
	const more = button("⋯", () => showMenu(webMenu(link, index, count), more), { className: "ghost more", title: "More: snapshot, check for changes, edit, move, remove" });
	if (link.snapshot) {
		actions.append(
			button("Open", () => api.webWikis.openSnapshot(link.id), { className: "primary", title: "Open the snapshot of " + day(link.snapshot.date) + " in a window (changes there aren't saved)" }),
			button("↗", () => api.webWikis.open(link.id), { className: "ghost", title: "Open " + link.url + " in the default browser" })
		);
	} else {
		actions.append(button("Open ↗", () => api.webWikis.open(link.id), { className: "primary", title: "Open " + link.url + " in the default browser" }));
	}
	actions.append(more);
	li.append(icon, info, actions);
	li.addEventListener("dblclick", () => run(() => (link.snapshot ? api.webWikis.openSnapshot(link.id) : api.webWikis.open(link.id))));
	li.addEventListener("contextmenu", event => {
		event.preventDefault();
		showMenu(webMenu(link, index, count), { x: event.clientX, y: event.clientY });
	});
	return li;
}

function webMenu(link, index, count) {
	const act = action => () => run(action);
	const snapshot = link.snapshot;
	const changed = link.check && link.check.result === "changed";
	const items = [];
	if (snapshot) {
		items.push(
			{ label: "Open snapshot", action: act(() => api.webWikis.openSnapshot(link.id)) },
			{ label: "Open website ↗", action: act(() => api.webWikis.open(link.id)) },
			"-",
			{ label: changed ? "Update snapshot (changed)" : "Update snapshot", action: act(() => api.webWikis.saveSnapshot(link.id)), disabled: !!link.busy, title: "Download the wiki again; replaces the snapshot of " + day(snapshot.date) },
			{ label: "Check for changes", action: act(() => api.webWikis.check(link.id)), disabled: !!link.busy },
			{ label: "Make wiki from snapshot…", action: act(() => openCreateWizard("snapshot", null, link)), title: "Create a local wiki folder from the snapshot" },
			{ label: "Show snapshot in " + (FILE_MANAGER[state.platform] || "file manager"), action: act(() => api.webWikis.showSnapshot(link.id)) }
		);
	} else {
		items.push(
			{ label: "Open website ↗", action: act(() => api.webWikis.open(link.id)) },
			"-",
			{ label: "Save snapshot", action: act(() => api.webWikis.saveSnapshot(link.id)), disabled: !!link.busy, title: "Download the wiki and keep a local copy you can open without the website" },
			{ label: "Check for changes", action: act(() => api.webWikis.check(link.id)), disabled: !!link.busy },
			{ label: "Mark changes as seen", action: act(() => api.webWikis.markSeen(link.id)), disabled: !changed || !!link.busy, title: "Compare future checks with the website as it is now" }
		);
	}
	if (link.showcase) {
		items.push({ label: "Plugins in this showcase…", action: act(() => openPluginsTab("showcases")) });
	}
	items.push(
		"-",
		{ label: "Copy address", action: act(() => api.copyText(link.url)) },
		{ label: "Edit…", action: act(() => openLinkDialog(link)) },
		"-",
		{ label: "Move up", action: act(() => api.webWikis.move(link.id, -1)), disabled: index === 0 },
		{ label: "Move down", action: act(() => api.webWikis.move(link.id, 1)), disabled: index === count - 1 },
		"-",
		{ label: "Remove…", action: act(async () => {
			const note = snapshot ? "\n\nIts snapshot of " + day(snapshot.date) + " is deleted too." : "";
			if (confirm("Remove the link “" + link.name + "” from TW Desk?\n\n" + link.url + note)) {
				await api.webWikis.remove(link.id);
			}
		}) }
	);
	return items;
}

const linkForm = $("#link-form");
let editingLinkId = null;
let linkSaved = null; // called with the link's id after saving (set by openLinkDialog)

// options for a new link: { showcase } preselects "Plugin showcase", onSaved(id) runs after saving
function openLinkDialog(link, options = {}) {
	editingLinkId = link ? link.id : null;
	linkSaved = options.onSaved || null;
	linkForm.reset();
	$("#link-error").hidden = true;
	$("#link-dialog-title").textContent = link ? "Edit web wiki" : "Add web wiki";
	linkForm.elements.url.value = link ? link.url : "";
	linkForm.elements.name.value = link ? link.name : "";
	linkForm.elements.description.value = link && link.description ? link.description : "";
	linkForm.elements.showcase.checked = link ? !!link.showcase : !!options.showcase;
	$("#link-dialog").showModal();
	linkForm.elements.url.focus();
}

linkForm.addEventListener("submit", async event => {
	event.preventDefault();
	try {
		const id = await api.webWikis.save({
			id: editingLinkId,
			url: linkForm.elements.url.value,
			name: linkForm.elements.name.value,
			description: linkForm.elements.description.value,
			showcase: linkForm.elements.showcase.checked
		});
		$("#link-dialog").close();
		if (linkSaved) {
			linkSaved(id);
		}
	} catch (e) {
		$("#link-error").textContent = cleanError(e);
		$("#link-error").hidden = false;
	}
});

$("#cancel-link").addEventListener("click", () => $("#link-dialog").close());

// ---------- drag and drop ----------

let draggedId = null;
let renderPending = false;

function clearDropMarks() {
	for (const element of document.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
		element.classList.remove("drop-before", "drop-after", "drop-into");
	}
}

// Where a drop at the pointer would put the dragged wiki: { li, group, beforeId, mark } or null
function dropTarget(event) {
	const li = draggedId && event.target.closest ? event.target.closest("#wiki-list > li") : null;
	if (!li) {
		return null;
	}
	const group = li.dataset.group || null;
	if (li.dataset.wikiId) {
		if (li.dataset.wikiId === draggedId) {
			return null;
		}
		const rect = li.getBoundingClientRect();
		if (event.clientY < rect.top + rect.height / 2) {
			return { li, group, beforeId: li.dataset.wikiId, mark: "drop-before" };
		}
		const next = li.nextElementSibling;
		const beforeId = next && next.classList.contains("wiki") && (next.dataset.group || null) === group ? next.dataset.wikiId : null;
		return { li, group, beforeId, mark: "drop-after" };
	}
	if ((li.classList.contains("group-header") || li.classList.contains("group-empty")) && li.dataset.group !== undefined) {
		return { li, group, beforeId: null, mark: "drop-into" };
	}
	return null;
}

function endDrag() {
	draggedId = null;
	clearDropMarks();
	document.body.classList.remove("dragging-wiki");
	if (renderPending) {
		renderPending = false;
		render();
	}
}

const wikiList = $("#wiki-list");
wikiList.addEventListener("dragstart", event => {
	const li = event.target.closest && event.target.closest("li.wiki");
	if (!li) {
		return;
	}
	closeMenu();
	draggedId = li.dataset.wikiId;
	event.dataTransfer.effectAllowed = "move";
	event.dataTransfer.setData("text/plain", li.querySelector(".wiki-name").firstChild.textContent);
	document.body.classList.add("dragging-wiki");
});
wikiList.addEventListener("dragover", event => {
	const target = dropTarget(event);
	clearDropMarks();
	if (target) {
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		target.li.classList.add(target.mark);
	}
});
wikiList.addEventListener("dragleave", event => {
	if (!wikiList.contains(event.relatedTarget)) {
		clearDropMarks();
	}
});
wikiList.addEventListener("drop", event => {
	const target = dropTarget(event);
	const id = draggedId;
	endDrag();
	if (target) {
		event.preventDefault();
		run(() => api.placeWiki(id, target.group, target.beforeId));
	}
});
// Also fires when the drop happened elsewhere or was cancelled
document.addEventListener("dragend", () => {
	if (draggedId) {
		endDrag();
	}
});

// "groktiddlywiki.com/read" for a web address, the file name for a file
function sourceLabel(source) {
	if (/^https?:\/\//i.test(source)) {
		try {
			const url = new URL(source);
			return (url.host + url.pathname).replace(/\/(index\.html?)?$/i, "");
		} catch (e) {
			return source;
		}
	}
	return folderName(source);
}

// "copy of Orga · 2026-10-26 — description" (either part may be missing)
function aboutText(wiki) {
	const parts = [];
	if (wiki.copiedFrom) {
		const original = state.wikis.find(w => w.id === wiki.copiedFrom.id);
		// The original may have been renamed since
		parts.push("copy of " + (original ? original.name : wiki.copiedFrom.name) + " · " + wiki.copiedFrom.date);
	}
	if (wiki.importedFrom) {
		const from = wiki.importedFrom;
		parts.push(from.snapshot
			? "from the snapshot of " + sourceLabel(from.source) + " · " + from.snapshot
			: "imported from " + sourceLabel(from.source) + " · " + from.date);
	}
	if (wiki.description) {
		parts.push(wiki.description.replace(/\s*\n\s*/g, " "));
	}
	return parts.join(" — ");
}

// Fixed ports are always shown; automatic ones only while the server runs
function portText(wiki) {
	if (wiki.port) {
		return "port " + wiki.port + (wiki.port === wiki.fixedPort ? " (fixed)" : "");
	}
	return wiki.fixedPort ? "port " + wiki.fixedPort + " (fixed)" : "auto port";
}

function portHint() {
	return "Leave empty to pick a port on each start: the last used one if free, otherwise the next free one from " + state.basePort + " (Settings).";
}

function folderName(folder) {
	return folder.split(/[\\/]/).filter(Boolean).pop() || folder;
}

function includeChip(text, include) {
	const chip = document.createElement("span");
	chip.className = "chip" + (include.exists ? "" : " missing");
	chip.textContent = text + (include.exists ? "" : " (missing)");
	chip.title = include.resolved + (include.exists ? "" : "\nNo tiddlywiki.info found there.");
	return chip;
}

// ---------- includes overview ----------

function showIncludesOverview() {
	const groups = new Map(); // lower-cased resolved folder -> { resolved, exists, users: [] }
	for (const wiki of state.wikis) {
		for (const include of wiki.includes) {
			const key = pathKey(include.resolved);
			if (!groups.has(key)) {
				groups.set(key, { resolved: include.resolved, exists: include.exists, users: [] });
			}
			groups.get(key).users.push({ wiki, include });
		}
	}
	const list = $("#includes-overview");
	list.replaceChildren();
	if (!groups.size) {
		const empty = document.createElement("li");
		empty.textContent = "None of your wikis includes another folder.";
		list.append(empty);
	}
	for (const group of [...groups.values()].sort((a, b) => folderName(a.resolved).localeCompare(folderName(b.resolved)))) {
		const li = document.createElement("li");
		const name = document.createElement("strong");
		name.textContent = folderName(group.resolved);
		const managed = state.wikis.find(w => pathKey(w.path) === pathKey(group.resolved));
		const folder = document.createElement("div");
		folder.className = "overview-path";
		folder.textContent = group.resolved + (managed ? " · also in TW Desk as \"" + managed.name + "\"" : "") + (group.exists ? "" : " · missing (no tiddlywiki.info)");
		const users = document.createElement("div");
		users.className = "overview-wikis";
		users.append("included by:");
		for (const { wiki, include } of group.users) {
			users.append(includeChip(wiki.name + (include.readOnly ? " (read-only)" : ""), { resolved: wiki.path, exists: true }));
		}
		li.append(name, folder, users);
		list.append(li);
	}
	$("#includes-dialog").showModal();
}

$("#show-includes").addEventListener("click", showIncludesOverview);
$("#close-includes").addEventListener("click", () => $("#includes-dialog").close());

// ---------- remove / delete dialog ----------

const removeForm = $("#remove-form");
const TRASH_NAME = { win32: "Recycle Bin", darwin: "Trash" };
let removing = null; // { wiki, check }

function trashName() {
	return TRASH_NAME[state.platform] || "trash";
}

// What could get lost: from the last git check of the wiki's folder
function deleteWarnings(wiki) {
	const status = gitStatusOf(wiki.path);
	const onlyCopy = "after deleting, the " + trashName() + " is the only copy.";
	if (!state.git || !state.git.available || !status || status.error) {
		return ["The git status is unknown – make sure you have a copy elsewhere."];
	}
	if (!status.repo) {
		return ["Not under version control – " + onlyCopy];
	}
	const warnings = [];
	if (status.changedCount) {
		warnings.push(status.changedCount + " changed " + (status.changedCount === 1 ? "tiddler is" : "tiddlers are") + " not committed.");
	}
	if (!status.remotes.length) {
		warnings.push("The repository has no remote – " + onlyCopy);
	} else if (!status.upstream) {
		warnings.push("The branch was never pushed – " + onlyCopy);
	} else if (status.ahead) {
		warnings.push(status.ahead + (status.ahead === 1 ? " commit is" : " commits are") + " not pushed.");
	}
	if (pathKey(status.root) !== pathKey(wiki.path)) {
		warnings.push("The folder is part of the repository " + status.root + ", which stays.");
	}
	return warnings;
}

function renderRemoveDialog() {
	const { wiki, check } = removing;
	const deleting = removeForm.elements.removeMode.value === "delete";
	const deleteOption = removeForm.querySelector("input[value=delete]");
	deleteOption.disabled = !check || check.blockers.length > 0;
	$("#remove-folder").textContent = wiki.path + (check && check.exists ? " · " + check.files + (check.files === 1 ? " file" : " files") : "");
	const notes = [];
	if (!check) {
		notes.push({ text: "Checking the folder…", className: "" });
	} else if (check.blockers.length) {
		notes.push(...check.blockers.map(text => ({ text: "Can't delete: " + text, className: "block" })));
	} else if (deleting) {
		notes.push(...deleteWarnings(wiki).map(text => ({ text: "⚠ " + text, className: "warn" })));
		notes.push({ text: "Included folders (e.g. _shared) are not touched.", className: "" });
	}
	$("#remove-notes").replaceChildren(...notes.map(note => {
		const li = document.createElement("li");
		li.textContent = note.text;
		li.className = note.className;
		return li;
	}));
	$("#confirm-remove").textContent = deleting ? "Move to " + trashName() : "Remove from list";
}

async function openRemoveDialog(wiki) {
	removing = { wiki, check: null };
	removeForm.reset();
	$("#remove-error").hidden = true;
	$("#remove-title").textContent = "Remove \u201c" + wiki.name + "\u201d";
	for (const element of removeForm.querySelectorAll(".trash-name")) {
		element.textContent = trashName();
	}
	renderRemoveDialog();
	$("#remove-dialog").showModal();
	const check = await api.deleteCheck(wiki.id);
	if (removing && removing.wiki === wiki) {
		removing.check = check;
		renderRemoveDialog();
	}
}

removeForm.addEventListener("change", () => removing && renderRemoveDialog());

removeForm.addEventListener("submit", async event => {
	event.preventDefault();
	const confirmButton = $("#confirm-remove");
	confirmButton.disabled = true;
	try {
		if (removeForm.elements.removeMode.value === "delete") {
			await api.deleteWiki(removing.wiki.id);
		} else {
			await api.removeWiki(removing.wiki.id);
		}
		$("#remove-dialog").close();
		removing = null;
	} catch (e) {
		$("#remove-error").textContent = cleanError(e);
		$("#remove-error").hidden = false;
	} finally {
		confirmButton.disabled = false;
	}
});

$("#cancel-remove").addEventListener("click", () => {
	removing = null;
	$("#remove-dialog").close();
});

// ---------- groups ----------

const groupForm = $("#group-form");
const groupDialog = $("#group-dialog");
let editingGroupId = null;

function openGroupDialog(group) {
	editingGroupId = group ? group.id : null;
	groupForm.reset();
	$("#group-error").hidden = true;
	$("#group-dialog-title").textContent = group ? "Rename group" : "Add group";
	groupForm.elements.name.value = group ? group.name : "";
	groupDialog.showModal();
	groupForm.elements.name.focus();
}

async function removeGroup(group, count) {
	const note = count ? "\n\nIts " + (count === 1 ? "wiki stays" : count + " wikis stay") + " in TW Desk, ungrouped." : "";
	if (confirm("Delete the group \"" + group.name + "\"?" + note)) {
		await api.removeGroup(group.id);
	}
}

groupForm.addEventListener("submit", async event => {
	event.preventDefault();
	try {
		await api.saveGroup({ id: editingGroupId, name: groupForm.elements.name.value });
		groupDialog.close();
	} catch (e) {
		$("#group-error").textContent = cleanError(e);
		$("#group-error").hidden = false;
	}
});

$("#cancel-group").addEventListener("click", () => groupDialog.close());


// ---------- settings ----------

const settingsForm = $("#settings-form");

$("#show-settings").addEventListener("click", () => {
	settingsForm.elements.basePort.value = state.basePort;
	const git = state.git.settings;
	settingsForm.elements.gitInterval.value = git.interval;
	settingsForm.elements.gitFetch.checked = git.fetch;
	settingsForm.elements.gitStaleHours.value = git.staleHours;
	settingsForm.elements.gitAutoCommit.checked = git.autoCommitOnStop;
	settingsForm.elements.webCheck.checked = state.webCheck;
	$("#settings-error").hidden = true;
	$("#settings-dialog").showModal();
});

settingsForm.addEventListener("submit", async event => {
	event.preventDefault();
	try {
		const fields = settingsForm.elements;
		await api.saveSettings({
			basePort: Number(fields.basePort.value),
			gitInterval: Number(fields.gitInterval.value),
			gitFetch: fields.gitFetch.checked,
			gitStaleHours: Number(fields.gitStaleHours.value),
			gitAutoCommit: fields.gitAutoCommit.checked,
			webCheck: fields.webCheck.checked
		});
		$("#settings-dialog").close();
	} catch (e) {
		$("#settings-error").textContent = cleanError(e);
		$("#settings-error").hidden = false;
	}
});

$("#cancel-settings").addEventListener("click", () => $("#settings-dialog").close());

// ---------- log panel ----------

async function showPanel(id, tab) {
	logWikiId = id;
	panelTab = tab;
	$("#log-panel").hidden = false;
	const output = $("#log-output");
	output.textContent = (await api.getLogs(id)).join("\n");
	render();
	output.scrollTop = output.scrollHeight;
}

for (const tab of document.querySelectorAll("[data-panel-tab]")) {
	tab.addEventListener("click", () => run(() => showPanel(logWikiId, tab.dataset.panelTab)));
}

function hideLog() {
	logWikiId = null;
	$("#log-panel").hidden = true;
	render();
}

api.onLog(({ id, lines }) => {
	if (id !== logWikiId) {
		return;
	}
	const output = $("#log-output");
	const atBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 4;
	output.textContent += (output.textContent ? "\n" : "") + lines.join("\n");
	if (atBottom) {
		output.scrollTop = output.scrollHeight;
	}
});

$("#log-close").addEventListener("click", hideLog);

// ---------- add / edit dialog ----------

const form = $("#wiki-form");
const dialog = $("#wiki-dialog");

async function openDialog(wiki) {
	editingId = wiki ? wiki.id : null;
	form.reset();
	$("#form-error").hidden = true;
	$("#dialog-title").textContent = wiki ? "Edit wiki" : "Add existing wiki";
	form.elements.name.value = wiki ? wiki.name : "";
	form.elements.description.value = wiki && wiki.description ? wiki.description : "";
	form.elements.path.value = wiki ? wiki.path : "";
	form.elements.fixedPort.value = wiki && wiki.fixedPort ? wiki.fixedPort : "";
	form.querySelector(".port-hint").textContent = portHint();
	form.elements.autostart.checked = wiki ? !!wiki.autostart : false;
	groupOptions(form.elements.group, wiki && wiki.group);
	$("#group-field").hidden = !state.groups.length;
	// Includes are edited for existing wikis only; a new wiki gets its shared include via "Create new wiki"
	dialogIncludes = wiki ? wiki.includes.map(i => ({ path: i.resolved, readOnly: i.readOnly, exists: i.exists })) : [];
	$("#includes-field").hidden = !wiki;
	renderIncludesEditor();
	dialog.showModal();
	form.elements.name.focus();
}

function renderIncludesEditor() {
	const list = $("#includes-editor");
	list.replaceChildren();
	if (!dialogIncludes.length) {
		const empty = document.createElement("li");
		empty.className = "muted";
		empty.textContent = "No included wikis.";
		list.append(empty);
	}
	dialogIncludes.forEach((include, index) => {
		const li = document.createElement("li");
		const text = document.createElement("span");
		text.className = "include-path" + (include.exists === false ? " error" : "");
		text.textContent = include.path + (include.exists === false ? " (missing)" : "");
		text.title = include.path;
		const readOnly = document.createElement("label");
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = include.readOnly;
		checkbox.addEventListener("change", () => (include.readOnly = checkbox.checked));
		readOnly.append(checkbox, " read-only");
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "ghost";
		remove.textContent = "✕";
		remove.title = "Remove this include";
		remove.addEventListener("click", () => {
			dialogIncludes.splice(index, 1);
			renderIncludesEditor();
		});
		li.append(text, readOnly, remove);
		list.append(li);
	});
}

$("#add-include").addEventListener("click", () => run(async () => {
	const folder = await api.pickFolder("Wiki folder to include");
	if (folder && !dialogIncludes.some(i => pathKey(i.path) === pathKey(folder))) {
		dialogIncludes.push({ path: folder, readOnly: false });
		renderIncludesEditor();
	}
}));

$("#pick-path").addEventListener("click", () => run(async () => {
	const folder = await api.pickFolder("Wiki folder");
	if (folder) {
		form.elements.path.value = folder;
		if (!form.elements.name.value) {
			form.elements.name.value = folder.split(/[\\/]/).pop();
		}
	}
}));

$("#cancel-dialog").addEventListener("click", () => dialog.close());

form.addEventListener("submit", async event => {
	event.preventDefault();
	const save = $("#save-dialog");
	save.disabled = true;
	try {
		await api.saveWiki({
			id: editingId,
			name: form.elements.name.value,
			description: form.elements.description.value,
			path: form.elements.path.value.trim(),
			fixedPort: form.elements.fixedPort.value.trim() || null,
			autostart: form.elements.autostart.checked,
			group: form.elements.group.value || null
		});
		if (editingId) {
			await api.saveIncludes(editingId, dialogIncludes.map(i => ({ path: i.path, readOnly: i.readOnly })));
		}
		dialog.close();
	} catch (e) {
		$("#form-error").textContent = cleanError(e);
		$("#form-error").hidden = false;
	} finally {
		save.disabled = false;
	}
});



// ---------- create wizard (empty wiki / load from HTML / copy of a wiki) ----------

const createForm = $("#create-form");
const createDialog = $("#create-dialog");
const CREATE_STEPS = { source: "Source", copy: "What to copy", location: "Location", settings: "Settings" };
const WIZARD_MODES = {
	empty: { title: "New empty wiki", steps: ["location", "settings"], working: "Creating…" },
	html: { title: "Wiki from HTML file or web address", steps: ["source", "location", "settings"], working: "Converting…" },
	copy: { title: "Copy wiki", steps: ["copy", "location", "settings"], working: "Copying…" },
	snapshot: { title: "Wiki from snapshot", steps: ["location", "settings"], working: "Converting…" }
};
const wizard = { mode: "empty", source: null, link: null, steps: [], index: 0, nameTouched: false };

function groupOptions(select, selected) {
	select.replaceChildren(new Option("— none —", ""), ...state.groups.map(g => new Option(g.name, g.id)));
	select.value = selected || "";
}

function joinPath(parent, name) {
	const sep = parent.includes("\\") || !parent.includes("/") ? "\\" : "/";
	return parent.replace(/[\\/]+$/, "") + sep + name;
}

function parentOf(file) {
	return file.replace(/[\\/][^\\/]*$/, "");
}

// mode: "empty", "html", "copy" (source: the wiki to copy) or "snapshot" (link: the web wiki whose snapshot to convert)
async function openCreateWizard(mode, source, link) {
	createForm.reset();
	wizard.mode = mode;
	wizard.source = source || null;
	wizard.link = link || null;
	wizard.steps = WIZARD_MODES[mode].steps;
	wizard.index = 0;
	wizard.nameTouched = false;
	$("#create-title").textContent = WIZARD_MODES[mode].title;
	for (const element of document.querySelectorAll(".tw-version-name")) {
		element.textContent = "TiddlyWiki " + state.twVersion;
	}
	// Most wikis sit side by side, so suggest the folder the first wiki is in
	createForm.elements.parent.value = state.wikis.length ? parentOf(state.wikis[0].path) : "";
	createForm.querySelector(".port-hint").textContent = portHint();
	groupOptions(createForm.elements.group, "");
	$("#create-group-field").hidden = !state.groups.length;
	// A copy keeps the original's includes
	$("#create-shared-field").hidden = mode === "copy";
	if (source) {
		$("#copy-source-name").textContent = source.name;
		$("#copy-source-path").textContent = source.path;
		$("#copy-git-field").hidden = !(state.git && state.git.available);
		createForm.elements.parent.value = parentOf(source.path);
		createForm.elements.group.value = source.group || "";
		setFolderSuggestion(uniqueFolderName(folderName(source.path) + "-copy"));
		createForm.elements.name.value = source.name + " (copy)";
		wizard.nameTouched = true;
	}
	if (link) {
		$("#create-title").textContent = "Wiki from the snapshot of \u201c" + link.name + "\u201d (" + link.snapshot.date.slice(0, 10) + ")";
		setFolderSuggestion(folderSuggestion(link.name));
		createForm.elements.name.value = link.name;
		createForm.elements.description.value = link.description || "";
		wizard.nameTouched = true;
	}
	showCreateStep();
	createDialog.showModal();
}

function showCreateStep() {
	const current = wizard.steps[wizard.index];
	for (const section of createForm.querySelectorAll("section[data-step]")) {
		section.hidden = section.dataset.step !== current;
	}
	$("#create-steps").replaceChildren(...wizard.steps.map((step, index) => {
		const li = document.createElement("li");
		li.textContent = CREATE_STEPS[step];
		li.className = index === wizard.index ? "current" : index < wizard.index ? "done" : "";
		return li;
	}));
	$("#create-back").hidden = wizard.index === 0;
	$("#create-next").textContent = wizard.index === wizard.steps.length - 1 ? "Create wiki" : "Next";
	$("#create-error").hidden = true;
	updateCreateTarget();
	const first = createForm.querySelector("section[data-step=" + current + "] input");
	if (first) {
		first.focus();
	}
}

function updateCreateTarget() {
	const parent = createForm.elements.parent.value.trim();
	const name = createForm.elements.folderName.value.trim();
	$("#create-target").textContent = parent && name ? "The wiki is created in " + joinPath(parent, name) : "";
}

// Checks the fields of the current step; the main process checks everything again
function checkCreateStep() {
	const step = wizard.steps[wizard.index];
	const value = name => createForm.elements[name].value.trim();
	if (step === "source" && !/\.html?$/i.test(value("htmlFile")) && !/^https?:\/\/./i.test(value("htmlFile"))) {
		return "Choose a TiddlyWiki .html file or enter a web address (https://…).";
	}
	if (step === "location") {
		if (!value("parent")) {
			return "Choose the folder to create the wiki in.";
		}
		if (!value("folderName")) {
			return "Enter a name for the new wiki folder.";
		}
		if (/[\\/:*?"<>|]/.test(value("folderName"))) {
			return "The folder name can't contain \\ / : * ? \" < > |";
		}
	}
	if (step === "settings" && !value("name")) {
		return "Enter a name.";
	}
	return null;
}

// "orga-copy", or "orga-copy-2" … if a wiki in TW Desk already uses that folder name next to it
function uniqueFolderName(base) {
	const parent = pathKey(createForm.elements.parent.value.trim());
	const taken = new Set(state.wikis.filter(w => pathKey(parentOf(w.path)) === parent).map(w => pathKey(folderName(w.path))));
	let name = base;
	for (let n = 2; taken.has(pathKey(name)); n++) {
		name = base + "-" + n;
	}
	return name;
}

// Folder name for a file ("mywiki") or web address ("groktiddlywiki"), without characters Windows doesn't allow
function folderSuggestion(source) {
	let name = source;
	if (/^https?:\/\//i.test(source)) {
		try {
			name = new URL(source).host.replace(/^www\./, "").replace(/\.[a-z]+$/i, "");
		} catch (e) {
			name = "web-wiki";
		}
	} else {
		name = source.split(/[\\/]/).pop().replace(/\.html?$/i, "");
	}
	return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "wiki";
}

function setFolderSuggestion(name) {
	createForm.elements.folderName.value = name;
	if (!wizard.nameTouched) {
		createForm.elements.name.value = name;
	}
	updateCreateTarget();
}

$("#pick-html").addEventListener("click", () => run(async () => {
	const file = await api.pickFile("Single-file TiddlyWiki", [{ name: "TiddlyWiki HTML", extensions: ["html", "htm"] }]);
	if (file) {
		createForm.elements.htmlFile.value = file;
		createForm.elements.parent.value = parentOf(file);
		setFolderSuggestion(folderSuggestion(file));
	}
}));

$("#pick-parent").addEventListener("click", () => run(async () => {
	const folder = await api.pickFolder("Folder to create the wiki in");
	if (folder) {
		createForm.elements.parent.value = folder;
		updateCreateTarget();
	}
}));

$("#pick-create-shared").addEventListener("click", () => run(async () => {
	const folder = await api.pickFolder("Shared wiki to include");
	if (folder) {
		createForm.elements.sharedPath.value = folder;
	}
}));

createForm.elements.parent.addEventListener("input", updateCreateTarget);
createForm.elements.folderName.addEventListener("input", () => {
	if (!wizard.nameTouched) {
		createForm.elements.name.value = createForm.elements.folderName.value;
	}
	updateCreateTarget();
});
createForm.elements.name.addEventListener("input", () => (wizard.nameTouched = true));

$("#create-back").addEventListener("click", () => {
	wizard.index--;
	showCreateStep();
});

$("#create-cancel").addEventListener("click", () => createDialog.close());

createForm.addEventListener("submit", async event => {
	event.preventDefault();
	const problem = checkCreateStep();
	if (problem) {
		$("#create-error").textContent = problem;
		$("#create-error").hidden = false;
		return;
	}
	if (wizard.index < wizard.steps.length - 1) {
		// A typed file path or web address hasn't suggested a folder name yet
		if (wizard.steps[wizard.index] === "source" && !createForm.elements.folderName.value.trim()) {
			setFolderSuggestion(folderSuggestion(createForm.elements.htmlFile.value.trim()));
		}
		wizard.index++;
		showCreateStep();
		return;
	}
	const next = $("#create-next");
	const back = $("#create-back");
	next.disabled = back.disabled = true;
	next.textContent = wizard.mode === "html" && /^https?:/i.test(createForm.elements.htmlFile.value.trim()) ? "Downloading…" : WIZARD_MODES[wizard.mode].working;
	try {
		const value = name => createForm.elements[name].value.trim();
		const id = await api.createWiki({
			htmlFile: wizard.mode === "html" ? value("htmlFile") : null,
			copyFrom: wizard.mode === "copy" ? wizard.source.id : null,
			webWiki: wizard.mode === "snapshot" ? wizard.link.id : null,
			copyMode: createForm.elements.copyMode.value,
			gitInit: wizard.mode === "copy" && createForm.elements.gitInit.checked,
			parent: value("parent"),
			folderName: value("folderName"),
			name: value("name"),
			description: value("description"),
			fixedPort: value("fixedPort") || null,
			group: value("group") || null,
			sharedPath: wizard.mode === "copy" ? "" : value("sharedPath"),
			autostart: createForm.elements.autostart.checked
		});
		createDialog.close();
		if (createForm.elements.openAfter.checked) {
			await run(() => api.openWiki(id, false));
		}
	} catch (e) {
		$("#create-error").textContent = cleanError(e);
		$("#create-error").hidden = false;
		next.textContent = "Create wiki";
	} finally {
		next.disabled = back.disabled = false;
	}
});

$("#new-menu").addEventListener("click", () => showMenu([
	{ label: "Empty wiki…", action: () => run(() => openCreateWizard("empty")), title: "Create a new, empty wiki folder" },
	{ label: "Wiki from HTML file or web address…", action: () => run(() => openCreateWizard("html")), title: "Convert a single-file TiddlyWiki (.html file or web page) into a wiki folder" },
	{ label: "Add existing wiki folder…", action: () => run(() => openDialog(null)), title: "A folder that contains tiddlywiki.info" },
	{ label: "Web wiki link…", action: () => openLinkDialog(null), title: "Remember a wiki on the web: open it in the browser, keep a snapshot, see when it changes" },
	"-",
	{ label: "Group…", action: () => openGroupDialog(null), title: "A group to sort wikis into" },
	"-",
	{ label: "Import setup…", action: () => run(openImport), title: "Set up from a file exported with Settings → Export setup…" }
], $("#new-menu")));

for (const copyButton of document.querySelectorAll("button.copy")) {
	copyButton.addEventListener("click", () => run(async () => {
		await api.copyText($("#" + copyButton.dataset.copy).textContent);
		copyButton.textContent = "Copied";
		setTimeout(() => (copyButton.textContent = "Copy"), 1500);
	}));
}

// ---------- start ----------

// The placeholders in index.html show Windows paths
function adaptPlaceholders(platform) {
	if (platform === "win32") {
		return;
	}
	for (const input of document.querySelectorAll("input[placeholder]")) {
		input.placeholder = input.placeholder.replace(/C:\\…\\/g, "~/").replace(/\\/g, "/");
	}
}

function applyState(newState) {
	if (!state.platform) {
		adaptPlaceholders(newState.platform);
	}
	state = newState;
	$("#tw-version").textContent = "v" + state.appVersion + " · TiddlyWiki " + state.twVersion;
	$("#config-path").textContent = state.configPath;
	$("#install-dir").textContent = state.installDir;
	render();
}

// Only once every script is loaded: render() uses functions from git-ui.js and the others
window.addEventListener("DOMContentLoaded", () => {
	api.onState(applyState);
	api.getState().then(applyState);
});
// Pick up changes made outside TW Desk (tiddlywiki.info files, git)
window.addEventListener("focus", () => {
	api.getState().then(applyState);
	api.git.checkOnFocus();
});
// Keeps relative times ("checked 2 min ago") current
setInterval(render, 60000);

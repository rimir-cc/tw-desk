"use strict";

const api = window.twDesk;
const $ = selector => document.querySelector(selector);

let state = { groups: [], wikis: [] };
let logWikiId = null;
let editingId = null;
let dialogIncludes = []; // [{ path (absolute), readOnly, exists }] while the Edit dialog is open

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
	const list = $("#wiki-list");
	list.replaceChildren();
	$("#empty-hint").hidden = state.wikis.length > 0 || state.groups.length > 0;
	for (const group of state.groups) {
		const wikis = state.wikis.filter(w => w.group === group.id);
		list.append(groupHeader(group, wikis.length));
		if (!wikis.length) {
			const empty = document.createElement("li");
			empty.className = "group-empty muted";
			empty.textContent = "No wikis in this group. Choose the group in a wiki's Edit dialog.";
			list.append(empty);
		}
		wikis.forEach((wiki, index) => list.append(wikiItem(wiki, index, wikis.length)));
	}
	const ungrouped = state.wikis.filter(w => !w.group);
	if (ungrouped.length && state.groups.length) {
		list.append(groupHeader(null, ungrouped.length));
	}
	ungrouped.forEach((wiki, index) => list.append(wikiItem(wiki, index, ungrouped.length)));
	if (logWikiId) {
		const wiki = state.wikis.find(w => w.id === logWikiId);
		if (wiki) {
			$("#log-title").textContent = "Log — " + wiki.name;
		} else {
			hideLog();
		}
	}
}

// group null is the "Ungrouped" section
function groupHeader(group, count) {
	const li = document.createElement("li");
	li.className = "group-header";
	const name = document.createElement("strong");
	name.textContent = group ? group.name : "Ungrouped";
	const meta = document.createElement("span");
	meta.className = "muted";
	meta.textContent = count + (count === 1 ? " wiki" : " wikis");
	const spacer = document.createElement("span");
	spacer.className = "spacer";
	li.append(name, meta, spacer);
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

	const dot = document.createElement("span");
	dot.className = "dot " + wiki.status;
	dot.title = STATUS_TEXT[wiki.status];

	const info = document.createElement("div");
	info.className = "wiki-info";
	const name = document.createElement("div");
	name.className = "wiki-name";
	name.textContent = wiki.name;
	const meta = document.createElement("div");
	meta.className = "wiki-meta";
	meta.textContent = STATUS_TEXT[wiki.status] + " · port " + wiki.port + (wiki.autostart ? " · autostart" : "") + " · " + wiki.path;
	meta.title = wiki.path;
	info.append(name, meta);
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
			line.append(includeChip(folderName(include.resolved) + (include.readOnly ? " (read-only)" : ""), include));
		}
		info.append(line);
	}

	const actions = document.createElement("div");
	actions.className = "wiki-actions";
	actions.append(
		running || busy
			? button("Stop", () => api.stopWiki(wiki.id), { disabled: busy })
			: button("Start", () => api.startWiki(wiki.id)),
		button("Open", () => api.openWiki(wiki.id, false), { className: "primary", title: "Open in a TW Desk window (starts the server if needed)" }),
		button("Browser", () => api.openWiki(wiki.id, true), { title: "Open " + wiki.url + " in the default browser" }),
		button("Folder", () => api.showFolder(wiki.id), { title: "Show the wiki folder in Explorer" }),
		button("Log", () => showLog(wiki.id)),
		button("Edit", () => openDialog(wiki), { disabled: running || busy, title: running || busy ? "Stop the wiki to edit it" : "Edit" }),
		button("▲", () => api.moveWiki(wiki.id, -1), { disabled: index === 0, className: "ghost", title: "Move up" }),
		button("▼", () => api.moveWiki(wiki.id, 1), { disabled: index === count - 1, className: "ghost", title: "Move down" }),
		button("Remove", () => removeWiki(wiki), { className: "danger", title: "Remove from list (files are kept)" })
	);

	li.append(dot, info, actions);
	li.addEventListener("dblclick", () => run(() => api.openWiki(wiki.id, false)));
	return li;
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
			const key = include.resolved.toLowerCase();
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
		const managed = state.wikis.find(w => w.path.toLowerCase() === group.resolved.toLowerCase());
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

async function removeWiki(wiki) {
	if (confirm("Remove \"" + wiki.name + "\" from TW Desk?\n\nThe wiki folder and its files are not deleted.")) {
		await api.removeWiki(wiki.id);
	}
}

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
$("#add-group").addEventListener("click", () => openGroupDialog(null));

// ---------- log panel ----------

async function showLog(id) {
	logWikiId = id;
	$("#log-panel").hidden = false;
	const output = $("#log-output");
	output.textContent = (await api.getLogs(id)).join("\n");
	output.scrollTop = output.scrollHeight;
	render();
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

function mode() {
	return form.elements.mode.value;
}

function updateModeFields() {
	const creating = !editingId && mode() === "new";
	$("#shared-field").hidden = !creating;
	$("#path-hint").textContent = creating
		? "An empty (or not yet existing) folder; a new server wiki is created there."
		: "A folder containing tiddlywiki.info.";
}

async function openDialog(wiki) {
	editingId = wiki ? wiki.id : null;
	form.reset();
	$("#form-error").hidden = true;
	$("#dialog-title").textContent = wiki ? "Edit wiki" : "Add wiki";
	$("#mode-fields").hidden = !!wiki;
	form.elements.name.value = wiki ? wiki.name : "";
	form.elements.path.value = wiki ? wiki.path : "";
	form.elements.port.value = wiki ? wiki.port : await api.suggestPort();
	form.elements.autostart.checked = wiki ? !!wiki.autostart : false;
	const groupSelect = form.elements.group;
	groupSelect.replaceChildren(new Option("— none —", ""), ...state.groups.map(g => new Option(g.name, g.id)));
	groupSelect.value = wiki && wiki.group ? wiki.group : "";
	$("#group-field").hidden = !state.groups.length;
	// Includes are edited for existing wikis only; a new wiki gets its shared include via "Create new wiki"
	dialogIncludes = wiki ? wiki.includes.map(i => ({ path: i.resolved, readOnly: i.readOnly, exists: i.exists })) : [];
	$("#includes-field").hidden = !wiki;
	renderIncludesEditor();
	updateModeFields();
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
	if (folder && !dialogIncludes.some(i => i.path.toLowerCase() === folder.toLowerCase())) {
		dialogIncludes.push({ path: folder, readOnly: false });
		renderIncludesEditor();
	}
}));

form.addEventListener("change", event => {
	if (event.target.name === "mode") {
		updateModeFields();
	}
});

$("#pick-path").addEventListener("click", () => run(async () => {
	const folder = await api.pickFolder(mode() === "new" && !editingId ? "Folder for the new wiki" : "Wiki folder");
	if (folder) {
		form.elements.path.value = folder;
		if (!form.elements.name.value) {
			form.elements.name.value = folder.split(/[\\/]/).pop();
		}
	}
}));

$("#pick-shared").addEventListener("click", () => run(async () => {
	const folder = await api.pickFolder("Shared wiki to include");
	if (folder) {
		form.elements.sharedPath.value = folder;
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
			path: form.elements.path.value.trim(),
			port: Number(form.elements.port.value),
			autostart: form.elements.autostart.checked,
			group: form.elements.group.value || null,
			createNew: !editingId && mode() === "new",
			sharedPath: form.elements.sharedPath.value.trim()
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

$("#add-wiki").addEventListener("click", () => run(() => openDialog(null)));

for (const copyButton of document.querySelectorAll("button.copy")) {
	copyButton.addEventListener("click", () => run(async () => {
		await api.copyText($("#" + copyButton.dataset.copy).textContent);
		copyButton.textContent = "Copied";
		setTimeout(() => (copyButton.textContent = "Copy"), 1500);
	}));
}

// ---------- start ----------

function applyState(newState) {
	state = newState;
	$("#tw-version").textContent = "v" + state.appVersion + " · TiddlyWiki " + state.twVersion;
	$("#config-path").textContent = state.configPath;
	$("#install-dir").textContent = state.installDir;
	render();
}

api.onState(applyState);
api.getState().then(applyState);
// Pick up changes made to tiddlywiki.info files outside TW Desk
window.addEventListener("focus", () => api.getState().then(applyState));

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
			empty.textContent = "No wikis in this group. Choose the group in a wiki's Edit dialog.";
			list.append(empty);
		}
		wikis.forEach((wiki, index) => list.append(wikiItem(wiki, index, wikis.length)));
	}
	const ungrouped = state.wikis.filter(w => !w.group);
	const showUngroupedHeader = ungrouped.length && state.groups.length;
	if (showUngroupedHeader) {
		list.append(groupHeader(null, ungrouped));
	}
	if (!(showUngroupedHeader && state.ungroupedCollapsed)) {
		ungrouped.forEach((wiki, index) => list.append(wikiItem(wiki, index, ungrouped.length)));
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
	actions.append(
		running || busy
			? button("Stop", () => api.stopWiki(wiki.id), { disabled: busy })
			: button("Start", () => api.startWiki(wiki.id)),
		button("Open", () => api.openWiki(wiki.id, false), { className: "primary", title: "Open in a TW Desk window (starts the server if needed)" }),
		button("Browser", () => api.openWiki(wiki.id, true), { title: wiki.url ? "Open " + wiki.url + " in the default browser" : "Open in the default browser (starts the server if needed)" }),
		button("Folder", () => api.showFolder(wiki.id), { title: "Show the wiki folder in " + (FILE_MANAGER[state.platform] || "the file manager") }),
		button("Log", () => showPanel(wiki.id, "log")),
		button("Copy…", () => openCreateWizard("copy", wiki), { title: "Create a new wiki as a copy of this one" }),
		button("Edit", () => openDialog(wiki), { disabled: running || busy, title: running || busy ? "Stop the wiki to edit it" : "Edit" }),
		button("▲", () => api.moveWiki(wiki.id, -1), { disabled: index === 0, className: "ghost", title: "Move up" }),
		button("▼", () => api.moveWiki(wiki.id, 1), { disabled: index === count - 1, className: "ghost", title: "Move down" }),
		button("Remove", () => removeWiki(wiki), { className: "danger", title: "Remove from list (files are kept)" })
	);

	li.append(dot, info, actions);
	li.addEventListener("dblclick", () => run(() => api.openWiki(wiki.id, false)));
	return li;
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

// ---------- settings ----------

const settingsForm = $("#settings-form");

$("#show-settings").addEventListener("click", () => {
	settingsForm.elements.basePort.value = state.basePort;
	const git = state.git.settings;
	settingsForm.elements.gitInterval.value = git.interval;
	settingsForm.elements.gitFetch.checked = git.fetch;
	settingsForm.elements.gitStaleHours.value = git.staleHours;
	settingsForm.elements.gitAutoCommit.checked = git.autoCommitOnStop;
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
			gitAutoCommit: fields.gitAutoCommit.checked
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

$("#add-wiki").addEventListener("click", () => run(() => openDialog(null)));

// ---------- create wizard (empty wiki / load from HTML / copy of a wiki) ----------

const createForm = $("#create-form");
const createDialog = $("#create-dialog");
const CREATE_STEPS = { source: "HTML file", copy: "What to copy", location: "Location", settings: "Settings" };
const WIZARD_MODES = {
	empty: { title: "New empty wiki", steps: ["location", "settings"], working: "Creating…" },
	html: { title: "Load wiki from HTML", steps: ["source", "location", "settings"], working: "Converting…" },
	copy: { title: "Copy wiki", steps: ["copy", "location", "settings"], working: "Copying…" }
};
const wizard = { mode: "empty", source: null, steps: [], index: 0, nameTouched: false };

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

// mode: "empty", "html" or "copy" (source: the wiki to copy)
async function openCreateWizard(mode, source) {
	createForm.reset();
	wizard.mode = mode;
	wizard.source = source || null;
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
	if (step === "source" && !/\.html?$/i.test(value("htmlFile"))) {
		return "Choose a TiddlyWiki .html file.";
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
		setFolderSuggestion(file.split(/[\\/]/).pop().replace(/\.html?$/i, "").replace(/[:*?"<>|]/g, "_"));
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
		wizard.index++;
		showCreateStep();
		return;
	}
	const next = $("#create-next");
	const back = $("#create-back");
	next.disabled = back.disabled = true;
	next.textContent = WIZARD_MODES[wizard.mode].working;
	try {
		const value = name => createForm.elements[name].value.trim();
		const id = await api.createWiki({
			htmlFile: wizard.mode === "html" ? value("htmlFile") : null,
			copyFrom: wizard.mode === "copy" ? wizard.source.id : null,
			copyMode: createForm.elements.copyMode.value,
			gitInit: wizard.mode === "copy" && createForm.elements.gitInit.checked,
			parent: value("parent"),
			folderName: value("folderName"),
			name: value("name"),
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

$("#new-empty-wiki").addEventListener("click", () => run(() => openCreateWizard("empty")));
$("#new-html-wiki").addEventListener("click", () => run(() => openCreateWizard("html")));

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

api.onState(applyState);
api.getState().then(applyState);
// Pick up changes made outside TW Desk (tiddlywiki.info files, git)
window.addEventListener("focus", () => {
	api.getState().then(applyState);
	api.git.checkOnFocus();
});
// Keeps relative times ("checked 2 min ago") current
setInterval(render, 60000);

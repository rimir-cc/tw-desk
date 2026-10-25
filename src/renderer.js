"use strict";

const api = window.twDesk;
const $ = selector => document.querySelector(selector);

let state = { wikis: [] };
let logWikiId = null;
let editingId = null;

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
	$("#empty-hint").hidden = state.wikis.length > 0;
	state.wikis.forEach((wiki, index) => {
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
			button("▼", () => api.moveWiki(wiki.id, 1), { disabled: index === state.wikis.length - 1, className: "ghost", title: "Move down" }),
			button("Remove", () => removeWiki(wiki), { className: "danger", title: "Remove from list (files are kept)" })
		);

		li.append(dot, info, actions);
		li.addEventListener("dblclick", () => run(() => api.openWiki(wiki.id, false)));
		list.append(li);
	});
	if (logWikiId) {
		const wiki = state.wikis.find(w => w.id === logWikiId);
		if (wiki) {
			$("#log-title").textContent = "Log — " + wiki.name;
		} else {
			hideLog();
		}
	}
}

async function removeWiki(wiki) {
	if (confirm("Remove \"" + wiki.name + "\" from TW Desk?\n\nThe wiki folder and its files are not deleted.")) {
		await api.removeWiki(wiki.id);
	}
}

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
	updateModeFields();
	dialog.showModal();
	form.elements.name.focus();
}

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
			createNew: !editingId && mode() === "new",
			sharedPath: form.elements.sharedPath.value.trim()
		});
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

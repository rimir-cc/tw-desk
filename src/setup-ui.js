"use strict";

// Export and import of the whole setup (Settings → Export setup… / Import setup…, + New → Import setup…).
// Uses $, api, run, cleanError, state from renderer.js and el from plugins-ui.js.

const setupDialog = $("#setup-dialog");
let setupMode = null; // "export", "import" or "done"
let importInfo = null; // what api.setup.open() returned
let importPlanData = null;

const FOLDER_ACTIONS = {
	register: "add to TW Desk",
	clone: "clone",
	already: "already there",
	present: "folder exists",
	missing: "missing",
	blocked: "can't be used"
};

function setupMessage(text, isError) {
	const box = $("#setup-message");
	box.textContent = text || "";
	box.className = "setup-message" + (isError ? " error" : "");
	box.hidden = !text;
}

function setupButtons(runLabel, cancelLabel) {
	$("#setup-run").textContent = runLabel;
	$("#setup-run").disabled = false;
	$("#setup-cancel").textContent = cancelLabel;
	$("#setup-cancel").hidden = !cancelLabel;
}

function showSetupDialog(title) {
	if ($("#settings-dialog").open) {
		$("#settings-dialog").close();
	}
	$("#setup-title").textContent = title;
	setupMessage("");
	if (!setupDialog.open) {
		setupDialog.showModal();
	}
}

// A checkbox line: name, and a small note below it
function choice(kind, value, checked, name, note, disabled) {
	const input = el("input", { type: "checkbox", value: String(value), checked, disabled });
	input.dataset.kind = kind;
	return el("li", {}, el("label", { class: "inline" }, input, el("div", {}, name, note ? el("div", { class: "small muted" }, note) : null)));
}

function checkedValues(kind) {
	return [...$("#setup-body").querySelectorAll("input[data-kind='" + kind + "']")].filter(i => i.checked && !i.disabled).map(i => i.value);
}

function checkedOption(kind) {
	return checkedValues(kind).length > 0;
}

// ---------- export ----------

function gitNote(git) {
	if (!git) {
		return "not in git – the folder has to be copied by hand";
	}
	return git.url ? "⎇ " + git.url + (git.branch ? " · " + git.branch : "") : "⎇ repository without remote – the folder has to be copied by hand";
}

async function openExport() {
	setupMode = "export";
	showSetupDialog("Export setup");
	setupButtons("Export…", "Cancel");
	$("#setup-run").disabled = true;
	const body = $("#setup-body");
	body.replaceChildren(el("p", { class: "muted small" }, "Looking up the git remotes…"));
	const info = await api.setup.exportInfo();
	if (setupMode !== "export") {
		return;
	}
	const snapshots = info.webWikis.filter(l => l.snapshot);
	const megabytes = (snapshots.reduce((sum, l) => sum + l.size, 0) / 1048576).toFixed(1);
	body.replaceChildren(
		el("p", { class: "muted small" }, "One file to set up TW Desk on another computer or to share with a colleague. The wikis' contents aren't in it: "
			+ "they are cloned from their git remotes on import, or the folders have to be copied there."),
		el("div", { class: "field-title" }, "Wikis"),
		el("ul", { class: "setup-list" }, info.wikis.length
			? info.wikis.map(w => choice("wiki", w.id, true, w.name, w.path + " · " + gitNote(w.git)))
			: el("li", { class: "muted" }, "No wikis.")),
		info.included.length ? el("p", { class: "muted small" }, "Included folders come along with the wikis that include them: "
			+ info.included.map(f => f.path + " (" + gitNote(f.git) + ")").join(", ")) : null,
		info.webWikis.length ? el("div", { class: "field-title" }, "Web wikis") : null,
		info.webWikis.length ? el("ul", { class: "setup-list" }, info.webWikis.map(l => choice("web", l.id, true, l.name, l.url + (l.snapshot ? " · snapshot " + l.snapshot.slice(0, 10) : "")))) : null,
		el("div", { class: "field-title" }, "Also"),
		el("ul", { class: "setup-list" },
			choice("store", "store", info.store > 0, "Plugins in the store (" + info.store + ")", "Included as files – also those from showcases or moved out of wikis, which no library offers", info.store === 0),
			choice("snapshots", "snapshots", false, "Snapshots of web wikis (" + snapshots.length + ", " + megabytes + " MB)",
				"Otherwise they are downloaded again on import – then they show the site as it is by then", snapshots.length === 0),
			choice("libraries", "libraries", true, "Plugin libraries (" + info.libraries + ")"),
			choice("settings", "settings", true, "Settings", "Start port, git checks, daily web check")));
	$("#setup-run").disabled = false;
}

async function doExport() {
	const result = await api.setup.export({
		wikis: checkedValues("wiki"),
		webWikis: checkedValues("web"),
		store: checkedOption("store"),
		snapshots: checkedOption("snapshots"),
		libraries: checkedOption("libraries"),
		settings: checkedOption("settings")
	});
	if (!result) {
		return;
	}
	setupMode = "done";
	setupButtons("Close", null);
	setupMessage("Exported " + result.wikis + (result.wikis === 1 ? " wiki" : " wikis") + " (" + result.folders + (result.folders === 1 ? " folder" : " folders") + "), "
		+ result.webWikis + (result.webWikis === 1 ? " web wiki" : " web wikis") + " and " + result.store + (result.store === 1 ? " plugin" : " plugins") + " to " + result.file + "."
		+ (result.skipped.length ? "\nLeft out (not stored the way TW Desk stores plugins): " + result.skipped.join(", ") : ""));
}

// ---------- import ----------

async function openImport() {
	const info = await api.setup.open();
	if (!info) {
		return;
	}
	importInfo = info;
	setupMode = "import";
	showSetupDialog("Import setup");
	setupButtons("Import", "Cancel");
	const baseInput = el("input", { name: "base", value: info.base || "", placeholder: "e.g. C:\\data\\wikis" });
	baseInput.addEventListener("change", () => run(loadImportPlan));
	const browse = el("button", { type: "button", onclick: () => run(async () => {
		const folder = await api.pickFolder("Folder for the wikis");
		if (folder) {
			baseInput.value = folder;
			await loadImportPlan();
		}
	}) }, "Browse…");
	$("#setup-body").replaceChildren(
		el("p", { class: "small" }, "From ", el("strong", {}, info.file), el("span", { class: "muted" },
			" – exported " + String(info.exported || "").slice(0, 10) + " with TW Desk " + (info.app || "?") + (info.originBase ? " from " + info.originBase : ""))),
		info.relative ? el("label", {}, "Folder for the wikis",
			el("span", { class: "row" }, baseInput, browse),
			el("small", { class: "muted" }, "The folders keep their places relative to each other, so includes like ../_shared keep working.")) : null,
		el("div", { id: "setup-plan" }));
	await loadImportPlan();
}

function importBase() {
	const input = $("#setup-body input[name=base]");
	return input ? input.value.trim() : "";
}

async function loadImportPlan() {
	importPlanData = await api.setup.plan(importBase() || null);
	renderImportPlan(importPlanData);
}

function renderImportPlan(plan) {
	const container = $("#setup-plan");
	const parts = [];
	if (plan.folders.length) {
		parts.push(el("div", { class: "field-title" }, "Wikis and folders"), el("ul", { class: "setup-list" }, plan.folders.map(item => {
			const selectable = item.action === "register" || item.action === "clone";
			const name = el("span", {}, item.name + (item.wiki ? "" : " (included folder)") + " ",
				el("span", { class: "badge " + (selectable ? "store" : item.action === "missing" || item.action === "blocked" ? "missing" : "") }, FOLDER_ACTIONS[item.action]));
			return choice("folder", item.id, selectable, name, (item.path || item.relative) + " · " + item.note, !selectable);
		})));
	}
	if (plan.webWikis.length) {
		parts.push(el("div", { class: "field-title" }, "Web wikis"), el("ul", { class: "setup-list" }, plan.webWikis.map(link => {
			const add = link.action === "add";
			const snapshot = link.snapshot === "embedded" ? "with its snapshot" : link.snapshot === "download" ? "its snapshot is downloaded again" : "";
			return choice("web", link.id, add, link.name + (link.showcase ? " (showcase)" : ""), link.url + " · " + (add ? snapshot || "link only" : link.note), !add);
		})));
	}
	const count = action => plan.store.filter(p => p.action === action).length;
	if (plan.store.length) {
		const useful = count("add") + count("update");
		const details = [count("add") + " new", count("update") + " newer than yours"];
		if (count("keep")) {
			details.push(count("keep") + " kept (the store has the same or a newer version)");
		}
		if (count("bundled")) {
			details.push(count("bundled") + " bundled with TiddlyWiki here");
		}
		parts.push(el("div", { class: "field-title" }, "Plugins"), el("ul", { class: "setup-list" },
			choice("store", "store", useful > 0, "Put " + useful + (useful === 1 ? " plugin" : " plugins") + " into the store", details.join(", ") + ". Plugins contain code that runs in the wikis that use them – import them only from people you trust.", useful === 0)),
		el("details", { class: "small" }, el("summary", {}, "Plugins in the file"), el("ul", {}, plan.store.map(p => el("li", {},
			p.title + " " + p.version + " – " + ({ add: "new", update: "newer than " + p.installed, keep: "store has " + p.installed, bundled: "bundled", invalid: "not a plugin" })[p.action])))));
	}
	const libraries = plan.libraries.filter(l => l.action === "add");
	if (libraries.length) {
		parts.push(el("div", { class: "field-title" }, "Libraries"), el("ul", { class: "setup-list" },
			choice("libraries", "libraries", true, "Add " + libraries.length + (libraries.length === 1 ? " plugin library" : " plugin libraries"), libraries.map(l => l.url).join(", "))));
	}
	if (plan.settings) {
		const s = plan.settings;
		const git = s.git || {};
		parts.push(el("div", { class: "field-title" }, "Settings"), el("ul", { class: "setup-list" },
			choice("settings", "settings", !state.wikis.length, "Use the settings from the file",
				"Start port " + s.basePort + ", git checks " + (git.interval ? "every " + git.interval + " s" : "off") + ", daily web check " + (s.webCheck === false ? "off" : "on"))));
	}
	if (!parts.length) {
		parts.push(el("p", { class: "muted" }, "The file contains nothing to import."));
	}
	container.replaceChildren(...parts);
	$("#setup-run").disabled = importInfo.relative && !plan.base;
	setupMessage(importInfo.relative && !plan.base ? "Choose the folder for the wikis." : "");
}

async function doImport() {
	const base = importBase() || null;
	const choices = {
		folders: checkedValues("folder").map(Number),
		webWikis: checkedValues("web").map(Number),
		store: checkedOption("store"),
		libraries: checkedOption("libraries"),
		settings: checkedOption("settings")
	};
	$("#setup-run").disabled = true;
	$("#setup-cancel").disabled = true;
	setupMessage(choices.folders.some(id => importPlanData.folders[id].action === "clone") ? "Importing… cloning can take a while." : "Importing…");
	try {
		const report = await api.setup.import(base, choices);
		setupMode = "done";
		setupMessage("");
		$("#setup-body").replaceChildren(el("ul", { class: "setup-report" }, report.map(line => el("li", { class: line.ok ? "ok" : "failed" }, (line.ok ? "✓ " : "✗ ") + line.text))));
		setupButtons("Close", null);
	} finally {
		$("#setup-cancel").disabled = false;
		$("#setup-run").disabled = false;
	}
}

// ---------- dialog ----------

$("#setup-form").addEventListener("submit", async event => {
	event.preventDefault();
	try {
		if (setupMode === "export") {
			await doExport();
		} else if (setupMode === "import") {
			await doImport();
		} else {
			setupDialog.close();
		}
	} catch (e) {
		setupMessage(cleanError(e), true);
	}
});

$("#setup-cancel").addEventListener("click", () => setupDialog.close());
setupDialog.addEventListener("close", () => {
	setupMode = null;
});
$("#export-setup").addEventListener("click", () => run(openExport));
$("#import-setup").addEventListener("click", () => run(openImport));

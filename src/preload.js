"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("twDesk", {
	getState: () => ipcRenderer.invoke("get-state"),
	getLogs: id => ipcRenderer.invoke("get-logs", id),
	saveSettings: settings => ipcRenderer.invoke("save-settings", settings),
	openWindowSize: () => ipcRenderer.invoke("open-window-size"),
	git: {
		action: (action, folder, arg) => ipcRenderer.invoke("git-action", action, folder, arg),
		checkOnFocus: () => ipcRenderer.invoke("git-check-focus"),
		checkNow: () => ipcRenderer.invoke("git-check-now")
	},
	pickFolder: title => ipcRenderer.invoke("pick-folder", title),
	locateWiki: id => ipcRenderer.invoke("locate-wiki", id),
	repointPreview: (oldParent, newParent) => ipcRenderer.invoke("repoint-preview", oldParent, newParent),
	repointApply: (oldParent, newParent) => ipcRenderer.invoke("repoint-apply", oldParent, newParent),
	dataFolder: {
		setup: (mode, target) => ipcRenderer.invoke("data-folder-setup", mode, target),
		replaceSummary: () => ipcRenderer.invoke("data-folder-replace-summary"),
		move: target => ipcRenderer.invoke("data-folder-move", target),
		removeOld: old => ipcRenderer.invoke("data-folder-remove-old", old),
		useExisting: target => ipcRenderer.invoke("data-folder-use-existing", target)
	},
	pickFile: (title, filters) => ipcRenderer.invoke("pick-file", title, filters),
	saveWiki: wiki => ipcRenderer.invoke("save-wiki", wiki),
	createWiki: input => ipcRenderer.invoke("create-wiki", input),
	removeWiki: id => ipcRenderer.invoke("remove-wiki", id),
	deleteCheck: id => ipcRenderer.invoke("delete-check", id),
	deleteWiki: id => ipcRenderer.invoke("delete-wiki", id),
	saveIncludes: (id, entries) => ipcRenderer.invoke("save-includes", id, entries),
	setFolderDescription: (folder, text) => ipcRenderer.invoke("set-folder-description", folder, text),
	binaries: {
		apply: id => ipcRenderer.invoke("binaries-apply", id),
		scan: id => ipcRenderer.invoke("binaries-scan", id),
		deleteUnused: (id, names) => ipcRenderer.invoke("binaries-delete-unused", id, names),
		keep: id => ipcRenderer.invoke("binaries-keep", id)
	},
	plugins: {
		getState: () => ipcRenderer.invoke("plugins-state"),
		addLibrary: url => ipcRenderer.invoke("plugins-add-library", url),
		removeLibrary: url => ipcRenderer.invoke("plugins-remove-library", url),
		libraryIndex: (url, refresh) => ipcRenderer.invoke("plugins-library-index", url, refresh),
		allIndexes: refresh => ipcRenderer.invoke("plugins-all-indexes", refresh),
		openLink: url => ipcRenderer.invoke("plugins-open-link", url),
		install: (url, title) => ipcRenderer.invoke("plugins-install", url, title),
		remove: (kind, name) => ipcRenderer.invoke("plugins-remove", kind, name),
		checkUpdates: () => ipcRenderer.invoke("plugins-check-updates"),
		linkShowcase: (id, title, linked) => ipcRenderer.invoke("plugins-link-showcase", id, title, linked),
		setList: (folder, kind, names) => ipcRenderer.invoke("plugins-set-list", folder, kind, names),
		setOrder: paths => ipcRenderer.invoke("plugins-set-order", paths),
		moveToStore: (folder, file) => ipcRenderer.invoke("plugins-move-to-store", folder, file)
	},
	setup: {
		exportInfo: () => ipcRenderer.invoke("setup-export-info"),
		export: choices => ipcRenderer.invoke("setup-export", choices),
		open: () => ipcRenderer.invoke("setup-open"),
		plan: base => ipcRenderer.invoke("setup-plan", base),
		import: (base, choices) => ipcRenderer.invoke("setup-import", base, choices)
	},
	moveWiki: (id, delta) => ipcRenderer.invoke("move-wiki", id, delta),
	webWikis: {
		save: link => ipcRenderer.invoke("save-web-wiki", link),
		remove: id => ipcRenderer.invoke("remove-web-wiki", id),
		open: id => ipcRenderer.invoke("open-web-wiki", id),
		openSnapshot: id => ipcRenderer.invoke("open-snapshot", id),
		showSnapshot: id => ipcRenderer.invoke("show-snapshot", id),
		saveSnapshot: id => ipcRenderer.invoke("save-snapshot", id),
		check: id => ipcRenderer.invoke("check-web-wiki", id),
		checkAll: () => ipcRenderer.invoke("check-web-wikis"),
		markSeen: id => ipcRenderer.invoke("mark-web-wiki-seen", id),
		move: (id, delta) => ipcRenderer.invoke("move-web-wiki", id, delta),
		setCollapsed: collapsed => ipcRenderer.invoke("set-web-collapsed", collapsed)
	},
	placeWiki: (id, group, beforeId) => ipcRenderer.invoke("place-wiki", id, group, beforeId),
	saveGroup: group => ipcRenderer.invoke("save-group", group),
	removeGroup: id => ipcRenderer.invoke("remove-group", id),
	setGroupCollapsed: (id, collapsed) => ipcRenderer.invoke("set-group-collapsed", id, collapsed),
	startWiki: id => ipcRenderer.invoke("start-wiki", id),
	stopWiki: id => ipcRenderer.invoke("stop-wiki", id),
	restartWiki: id => ipcRenderer.invoke("restart-wiki", id),
	openWiki: (id, external) => ipcRenderer.invoke("open-wiki", id, external),
	showFolder: id => ipcRenderer.invoke("show-folder", id),
	copyText: text => ipcRenderer.invoke("copy-text", text),
	onState: callback => ipcRenderer.on("state", (event, state) => callback(state)),
	onLog: callback => ipcRenderer.on("log", (event, entry) => callback(entry))
});

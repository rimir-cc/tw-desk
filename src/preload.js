"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("twDesk", {
	getState: () => ipcRenderer.invoke("get-state"),
	getLogs: id => ipcRenderer.invoke("get-logs", id),
	saveSettings: settings => ipcRenderer.invoke("save-settings", settings),
	git: {
		action: (action, folder, arg) => ipcRenderer.invoke("git-action", action, folder, arg),
		checkOnFocus: () => ipcRenderer.invoke("git-check-focus"),
		checkNow: () => ipcRenderer.invoke("git-check-now")
	},
	pickFolder: title => ipcRenderer.invoke("pick-folder", title),
	pickFile: (title, filters) => ipcRenderer.invoke("pick-file", title, filters),
	saveWiki: wiki => ipcRenderer.invoke("save-wiki", wiki),
	createWiki: input => ipcRenderer.invoke("create-wiki", input),
	removeWiki: id => ipcRenderer.invoke("remove-wiki", id),
	deleteCheck: id => ipcRenderer.invoke("delete-check", id),
	deleteWiki: id => ipcRenderer.invoke("delete-wiki", id),
	saveIncludes: (id, entries) => ipcRenderer.invoke("save-includes", id, entries),
	plugins: {
		getState: () => ipcRenderer.invoke("plugins-state"),
		addLibrary: url => ipcRenderer.invoke("plugins-add-library", url),
		removeLibrary: url => ipcRenderer.invoke("plugins-remove-library", url),
		libraryIndex: (url, refresh) => ipcRenderer.invoke("plugins-library-index", url, refresh),
		install: (url, title) => ipcRenderer.invoke("plugins-install", url, title),
		remove: (kind, name) => ipcRenderer.invoke("plugins-remove", kind, name),
		checkUpdates: () => ipcRenderer.invoke("plugins-check-updates"),
		setList: (folder, kind, names) => ipcRenderer.invoke("plugins-set-list", folder, kind, names),
		moveToStore: (folder, file) => ipcRenderer.invoke("plugins-move-to-store", folder, file)
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
	openWiki: (id, external) => ipcRenderer.invoke("open-wiki", id, external),
	showFolder: id => ipcRenderer.invoke("show-folder", id),
	copyText: text => ipcRenderer.invoke("copy-text", text),
	onState: callback => ipcRenderer.on("state", (event, state) => callback(state)),
	onLog: callback => ipcRenderer.on("log", (event, entry) => callback(entry))
});

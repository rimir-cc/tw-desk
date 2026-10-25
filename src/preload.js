"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("twDesk", {
	getState: () => ipcRenderer.invoke("get-state"),
	getLogs: id => ipcRenderer.invoke("get-logs", id),
	suggestPort: () => ipcRenderer.invoke("suggest-port"),
	pickFolder: title => ipcRenderer.invoke("pick-folder", title),
	saveWiki: wiki => ipcRenderer.invoke("save-wiki", wiki),
	removeWiki: id => ipcRenderer.invoke("remove-wiki", id),
	moveWiki: (id, delta) => ipcRenderer.invoke("move-wiki", id, delta),
	startWiki: id => ipcRenderer.invoke("start-wiki", id),
	stopWiki: id => ipcRenderer.invoke("stop-wiki", id),
	openWiki: (id, external) => ipcRenderer.invoke("open-wiki", id, external),
	showFolder: id => ipcRenderer.invoke("show-folder", id),
	copyText: text => ipcRenderer.invoke("copy-text", text),
	onState: callback => ipcRenderer.on("state", (event, state) => callback(state)),
	onLog: callback => ipcRenderer.on("log", (event, entry) => callback(entry))
});

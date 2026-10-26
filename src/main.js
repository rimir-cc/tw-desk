"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess, clipboard } = require("electron");
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const plugins = require("./plugins");

const DEFAULT_BASE_PORT = 8090;
const MAX_LOG_LINES = 500;

// Each TiddlyWiki command runs in an Electron utility process (a Node.js child process managed by Electron),
// so no separate Node install is needed.
const TW_PROCESS = path.join(__dirname, "tw-process.js");
const TW_VERSION = require("tiddlywiki/package.json").version;

let managerWindow = null;
let config = { basePort: DEFAULT_BASE_PORT, wikis: [] };
const servers = new Map(); // wiki id -> { child, status, logs, error }
const wikiWindows = new Map(); // wiki id -> BrowserWindow

// ---------- config ----------

function configPath() {
	return path.join(app.getPath("userData"), "config.json");
}

function loadConfig() {
	try {
		config = Object.assign({ basePort: DEFAULT_BASE_PORT, wikis: [] }, JSON.parse(fs.readFileSync(configPath(), "utf8")));
	} catch (e) {
		if (e.code !== "ENOENT") {
			dialog.showErrorBox("TW Desk", "Could not read " + configPath() + ":\n" + e.message);
		}
	}
	if (!Array.isArray(config.libraries)) {
		config.libraries = [
			{ url: "https://tiddlywiki.com/library/v" + TW_VERSION + "/index.html", type: "tiddlywiki" },
			{ url: "https://tw-cpl.netlify.app/repo", type: "cpl" }
		];
	}
}

function saveConfig() {
	fs.mkdirSync(path.dirname(configPath()), { recursive: true });
	fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function findWiki(id) {
	const wiki = config.wikis.find(w => w.id === id);
	if (!wiki) {
		throw new Error("Unknown wiki " + id);
	}
	return wiki;
}

function nextFreeConfigPort() {
	const used = new Set(config.wikis.map(w => w.port));
	let port = config.basePort || DEFAULT_BASE_PORT;
	while (used.has(port)) {
		port++;
	}
	return port;
}

function validateWiki(wiki, ignoreId) {
	if (!wiki.name || !wiki.name.trim()) {
		throw new Error("Name is required.");
	}
	if (!Number.isInteger(wiki.port) || wiki.port < 1024 || wiki.port > 65535) {
		throw new Error("Port must be a number between 1024 and 65535.");
	}
	const clash = config.wikis.find(w => w.id !== ignoreId && w.port === wiki.port);
	if (clash) {
		throw new Error("Port " + wiki.port + " is already used by \"" + clash.name + "\".");
	}
	if (!fs.existsSync(path.join(wiki.path, "tiddlywiki.info"))) {
		throw new Error("No tiddlywiki.info in " + wiki.path);
	}
}

// ---------- state sent to the UI ----------

function serverState(id) {
	const s = servers.get(id);
	return s ? { status: s.status, error: s.error } : { status: "stopped", error: null };
}

function snapshot() {
	return {
		appVersion: app.getVersion(),
		twVersion: TW_VERSION,
		configPath: configPath(),
		installDir: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
		wikis: config.wikis.map(w => Object.assign({}, w, serverState(w.id), { url: wikiUrl(w) }, readIncludes(w.path)))
	};
}

// ---------- tiddlywiki.info: includeWikis ----------

function infoPath(wikiPath) {
	return path.join(wikiPath, "tiddlywiki.info");
}

// Returns { includes: [{ path, resolved, readOnly, exists }] } or { includes: [], infoError }
function readIncludes(wikiPath) {
	let info;
	try {
		info = JSON.parse(fs.readFileSync(infoPath(wikiPath), "utf8"));
	} catch (e) {
		return { includes: [], infoError: "Cannot read tiddlywiki.info: " + e.message };
	}
	const includes = (info.includeWikis || []).map(entry => {
		const item = typeof entry === "string" ? { path: entry } : entry || {};
		const resolved = path.resolve(wikiPath, item.path || "");
		return {
			path: item.path || "",
			resolved,
			// TiddlyWiki treats a missing "read-only" as writable
			readOnly: !!item["read-only"],
			exists: fs.existsSync(path.join(resolved, "tiddlywiki.info"))
		};
	});
	return { includes };
}

function saveIncludes(id, entries) {
	const wiki = findWiki(id);
	const s = serverState(id).status;
	if (s === "running" || s === "starting") {
		throw new Error("Stop the wiki before changing its includes.");
	}
	const file = infoPath(wiki.path);
	const info = JSON.parse(fs.readFileSync(file, "utf8"));
	const includeWikis = entries.map(entry => {
		const resolved = path.resolve(wiki.path, entry.path);
		if (resolved === path.resolve(wiki.path)) {
			throw new Error("A wiki cannot include itself.");
		}
		// TiddlyWiki fails to start if an included folder isn't a wiki
		if (!fs.existsSync(infoPath(resolved))) {
			throw new Error("Not a wiki folder (no tiddlywiki.info): " + resolved);
		}
		// Store paths relative to the wiki folder when possible, like TiddlyWiki's own examples
		let stored = path.relative(wiki.path, resolved);
		if (!stored || path.isAbsolute(stored)) {
			stored = resolved;
		}
		return { path: stored.split(path.sep).join("/"), "read-only": !!entry.readOnly };
	});
	if (JSON.stringify(includeWikis) === JSON.stringify(info.includeWikis || [])) {
		return;
	}
	info.includeWikis = includeWikis;
	fs.writeFileSync(file, JSON.stringify(info, null, 4));
	pushState();
}

function pushState() {
	if (managerWindow && !managerWindow.isDestroyed()) {
		managerWindow.webContents.send("state", snapshot());
	}
}

function appendLog(id, text) {
	const s = servers.get(id);
	if (!s) {
		return;
	}
	const lines = text.split(/\r?\n/).filter(l => l.length);
	s.logs.push(...lines);
	if (s.logs.length > MAX_LOG_LINES) {
		s.logs.splice(0, s.logs.length - MAX_LOG_LINES);
	}
	if (managerWindow && !managerWindow.isDestroyed()) {
		managerWindow.webContents.send("log", { id, lines });
	}
}

function wikiUrl(wiki) {
	return "http://127.0.0.1:" + wiki.port + "/";
}

// ---------- servers ----------

function runTiddlyWiki(args, serviceName) {
	return utilityProcess.fork(TW_PROCESS, [], {
		env: Object.assign({}, process.env, plugins.tiddlyWikiEnv(process.env), { TW_DESK_ARGS: JSON.stringify(args) }),
		stdio: "pipe",
		execArgv: ["--no-deprecation"],
		serviceName
	});
}

function portIsFree(port) {
	return new Promise(resolve => {
		const probe = net.createServer();
		probe.once("error", () => resolve(false));
		probe.once("listening", () => probe.close(() => resolve(true)));
		probe.listen(port, "127.0.0.1");
	});
}

async function startWiki(id) {
	const wiki = findWiki(id);
	const existing = servers.get(id);
	if (existing && (existing.status === "running" || existing.status === "starting")) {
		return;
	}
	const state = { child: null, status: "starting", error: null, logs: existing ? existing.logs : [] };
	servers.set(id, state);
	pushState();
	if (!(await portIsFree(wiki.port))) {
		state.status = "error";
		state.error = "Port " + wiki.port + " is already in use by another program.";
		appendLog(id, state.error);
		pushState();
		return;
	}
	appendLog(id, "Starting TiddlyWiki " + TW_VERSION + ": " + wiki.path + " on port " + wiki.port);
	const child = runTiddlyWiki([wiki.path, "--listen", "host=127.0.0.1", "port=" + wiki.port], "TiddlyWiki " + wiki.name);
	state.child = child;
	const onOutput = data => {
		const text = data.toString();
		if (state.status === "starting" && text.includes("Serving on")) {
			state.status = "running";
			pushState();
		}
		appendLog(id, text);
	};
	child.stdout.on("data", onOutput);
	child.stderr.on("data", onOutput);
	child.on("error", (type, location) => {
		appendLog(id, "Error: " + type + (location ? " at " + location : ""));
	});
	child.on("exit", code => {
		state.child = null;
		if (state.stopping || code === 0) {
			state.status = "stopped";
		} else {
			state.status = "error";
			state.error = "Server exited with code " + code + ". See log.";
		}
		state.stopping = false;
		appendLog(id, "Server stopped" + (code !== null ? " (exit code " + code + ")" : ""));
		const win = wikiWindows.get(id);
		if (win && !win.isDestroyed()) {
			win.close();
		}
		pushState();
	});
}

function stopWiki(id) {
	const state = servers.get(id);
	if (state && state.child) {
		state.stopping = true;
		state.child.kill();
	}
}

function waitForRunning(id, timeoutMs) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const check = () => {
			const s = serverState(id);
			if (s.status === "running") {
				resolve();
			} else if (s.status === "error" || s.status === "stopped") {
				reject(new Error(s.error || "Server is not running."));
			} else if (Date.now() - started > timeoutMs) {
				reject(new Error("Server did not start within " + timeoutMs / 1000 + " seconds."));
			} else {
				setTimeout(check, 200);
			}
		};
		check();
	});
}

async function openWiki(id, external) {
	const wiki = findWiki(id);
	if (serverState(id).status !== "running") {
		await startWiki(id);
		await waitForRunning(id, 60000);
	}
	if (external) {
		await shell.openExternal(wikiUrl(wiki));
		return;
	}
	const existing = wikiWindows.get(id);
	if (existing && !existing.isDestroyed()) {
		existing.focus();
		return;
	}
	const win = new BrowserWindow({
		width: 1280,
		height: 900,
		title: wiki.name,
		autoHideMenuBar: true,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
	});
	// Links to other sites open in the default browser; links within the wiki stay in the window.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (!url.startsWith(wikiUrl(wiki))) {
			shell.openExternal(url);
			return { action: "deny" };
		}
		return { action: "allow" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (!url.startsWith(wikiUrl(wiki))) {
			event.preventDefault();
			shell.openExternal(url);
		}
	});
	win.on("page-title-updated", (event, title) => {
		event.preventDefault();
		win.setTitle(wiki.name + " — " + title);
	});
	win.on("closed", () => wikiWindows.delete(id));
	wikiWindows.set(id, win);
	win.loadURL(wikiUrl(wiki));
}

// ---------- creating wikis ----------

async function initWiki(folder, sharedFolder) {
	fs.mkdirSync(folder, { recursive: true });
	if (fs.readdirSync(folder).length) {
		throw new Error("The folder for a new wiki must be empty: " + folder);
	}
	const child = runTiddlyWiki([folder, "--init", "server"], "TiddlyWiki init");
	let output = "";
	child.stdout.on("data", data => (output += data));
	child.stderr.on("data", data => (output += data));
	const code = await new Promise(resolve => child.once("exit", resolve));
	if (code !== 0 || !fs.existsSync(path.join(folder, "tiddlywiki.info"))) {
		throw new Error("tiddlywiki --init failed (exit code " + code + "):\n" + output);
	}
	fs.mkdirSync(path.join(folder, "tiddlers"), { recursive: true });
	if (sharedFolder) {
		const infoPath = path.join(folder, "tiddlywiki.info");
		const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
		const relative = path.relative(folder, sharedFolder).split(path.sep).join("/");
		info.includeWikis = [{ path: relative, "read-only": false }];
		fs.writeFileSync(infoPath, JSON.stringify(info, null, 4));
	}
}

// ---------- IPC ----------

ipcMain.handle("get-state", () => snapshot());

ipcMain.handle("get-logs", (event, id) => (servers.get(id) ? servers.get(id).logs : []));

ipcMain.handle("suggest-port", () => nextFreeConfigPort());

ipcMain.handle("pick-folder", async (event, title) => {
	const result = await dialog.showOpenDialog(managerWindow, { title, properties: ["openDirectory", "createDirectory"] });
	return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("save-wiki", async (event, input) => {
	const wiki = {
		id: input.id || crypto.randomUUID(),
		name: (input.name || "").trim(),
		path: path.resolve(input.path || ""),
		port: Number(input.port),
		autostart: !!input.autostart
	};
	if (!input.id && input.createNew) {
		await initWiki(wiki.path, input.sharedPath ? path.resolve(input.sharedPath) : null);
	}
	validateWiki(wiki, input.id);
	const index = config.wikis.findIndex(w => w.id === wiki.id);
	if (index === -1) {
		config.wikis.push(wiki);
	} else {
		config.wikis[index] = wiki;
	}
	saveConfig();
	pushState();
	return wiki.id;
});

ipcMain.handle("save-includes", (event, id, entries) => saveIncludes(id, entries));

// ---------- plugins ----------

// All wiki folders TW Desk knows: the wikis in the list plus the folders they include
function knownFolders() {
	const folders = new Map(); // lower-cased path -> folder
	const add = (folderPath, wiki) => {
		const key = path.resolve(folderPath).toLowerCase();
		if (!folders.has(key)) {
			folders.set(key, { path: path.resolve(folderPath), name: null, users: [] });
		}
		const folder = folders.get(key);
		if (wiki) {
			folder.users.push(wiki);
		}
		return folder;
	};
	for (const wiki of config.wikis) {
		add(wiki.path, wiki).name = wiki.name;
	}
	for (const wiki of config.wikis) {
		for (const include of readIncludes(wiki.path).includes) {
			if (include.exists) {
				add(include.resolved, wiki);
			}
		}
	}
	return [...folders.values()].map(folder => ({
		path: folder.path,
		name: folder.name || path.basename(folder.path),
		managed: !!folder.name,
		// Wikis that load this folder: the wiki itself and the wikis including it
		usedBy: folder.users.map(w => w.name),
		running: folder.users.some(w => ["running", "starting"].includes(serverState(w.id).status))
	}));
}

function findFolder(folderPath) {
	const folder = knownFolders().find(f => f.path.toLowerCase() === path.resolve(folderPath).toLowerCase());
	if (!folder) {
		throw new Error("Unknown wiki folder: " + folderPath);
	}
	return folder;
}

function findLibrary(url) {
	const library = config.libraries.find(l => l.url === url);
	if (!library) {
		throw new Error("Unknown library: " + url);
	}
	return library;
}

function pluginsState() {
	return {
		storePath: plugins.storePath(),
		backupPath: path.join(app.getPath("userData"), "backup"),
		twVersion: TW_VERSION,
		libraries: config.libraries,
		store: plugins.listStore(),
		bundled: plugins.listBundled(),
		folders: knownFolders().map(folder => {
			let lists = null;
			let error = null;
			try {
				lists = plugins.folderLists(folder.path);
			} catch (e) {
				error = "Cannot read tiddlywiki.info: " + e.message;
			}
			return Object.assign(folder, { lists, error, stored: plugins.listStoredInWiki(folder.path) });
		})
	};
}

ipcMain.handle("plugins-state", () => pluginsState());

ipcMain.handle("plugins-add-library", async (event, url) => {
	const library = await plugins.detectLibrary(url);
	if (config.libraries.some(l => l.url === library.url)) {
		throw new Error("This library is already in the list.");
	}
	config.libraries.push(library);
	saveConfig();
	return library;
});

ipcMain.handle("plugins-remove-library", (event, url) => {
	config.libraries = config.libraries.filter(l => l.url !== url);
	saveConfig();
});

ipcMain.handle("plugins-library-index", (event, url, refresh) => plugins.libraryIndex(findLibrary(url), refresh));

ipcMain.handle("plugins-install", (event, url, title) => plugins.installFromLibrary(findLibrary(url), title));

ipcMain.handle("plugins-remove", (event, kind, name) => {
	const key = plugins.KINDS[kind].infoKey;
	const users = knownFolders().filter(folder => {
		try {
			return plugins.folderLists(folder.path)[key].includes(name);
		} catch (e) {
			return false;
		}
	});
	if (users.length) {
		throw new Error("Still used by: " + users.map(f => f.name).join(", ") + ". Remove it from those wikis first.");
	}
	plugins.removeFromStore(kind, name);
});

ipcMain.handle("plugins-check-updates", () => {
	const state = pluginsState();
	const installed = state.store.concat(...state.folders.map(f => f.stored.map(p => Object.assign({ folder: f.name }, p))));
	return plugins.checkUpdates(config.libraries, installed);
});

ipcMain.handle("plugins-set-list", (event, folderPath, kind, names) => {
	const folder = findFolder(folderPath);
	plugins.setFolderList(folder.path, kind, names);
});

ipcMain.handle("plugins-move-to-store", (event, folderPath, file) => {
	const folder = findFolder(folderPath);
	if (folder.running) {
		throw new Error("Stop the wikis using this folder first: " + folder.usedBy.join(", "));
	}
	return plugins.moveToStore(folder.path, file);
});

ipcMain.handle("remove-wiki", (event, id) => {
	stopWiki(id);
	config.wikis = config.wikis.filter(w => w.id !== id);
	saveConfig();
	pushState();
});

ipcMain.handle("move-wiki", (event, id, delta) => {
	const index = config.wikis.findIndex(w => w.id === id);
	const target = index + delta;
	if (index !== -1 && target >= 0 && target < config.wikis.length) {
		const [wiki] = config.wikis.splice(index, 1);
		config.wikis.splice(target, 0, wiki);
		saveConfig();
		pushState();
	}
});

ipcMain.handle("start-wiki", (event, id) => startWiki(id));
ipcMain.handle("stop-wiki", (event, id) => stopWiki(id));
ipcMain.handle("open-wiki", (event, id, external) => openWiki(id, external));
ipcMain.handle("show-folder", (event, id) => shell.openPath(findWiki(id).path));
ipcMain.handle("copy-text", (event, text) => clipboard.writeText(String(text)));

// ---------- app lifecycle ----------

function createManagerWindow() {
	managerWindow = new BrowserWindow({
		width: 980,
		height: 680,
		minWidth: 640,
		minHeight: 400,
		title: "TW Desk",
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	managerWindow.loadFile(path.join(__dirname, "index.html"));
	managerWindow.on("closed", () => {
		managerWindow = null;
		app.quit();
	});
}

// Lets a second, separate setup (e.g. for testing) keep its own config.json.
if (process.env.TW_DESK_USER_DATA) {
	app.setPath("userData", path.resolve(process.env.TW_DESK_USER_DATA));
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (managerWindow) {
			if (managerWindow.isMinimized()) {
				managerWindow.restore();
			}
			managerWindow.focus();
		}
	});

	app.whenReady().then(() => {
		plugins.init(app.getPath("userData"));
		loadConfig();
		createManagerWindow();
		for (const wiki of config.wikis) {
			if (wiki.autostart) {
				startWiki(wiki.id);
			}
		}
	});

	app.on("before-quit", () => {
		for (const id of servers.keys()) {
			stopWiki(id);
		}
	});
}

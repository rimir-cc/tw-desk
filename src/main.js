"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess, clipboard, net: electronNet } = require("electron");
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const plugins = require("./plugins");
const git = require("./git");
const web = require("./web");
const setup = require("./setup");
const links = require("./links");
const http = require("http");

const DEFAULT_BASE_PORT = 8090;
// Windows and (by default) macOS don't distinguish upper and lower case in paths
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";
const MAX_LOG_LINES = 500;

// Each TiddlyWiki command runs in an Electron utility process (a Node.js child process managed by Electron),
// so no separate Node install is needed.
const TW_PROCESS = path.join(__dirname, "tw-process.js");
const TW_VERSION = require("tiddlywiki/package.json").version;
// Loaded by every wiki TW Desk serves (TiddlyWiki's "++<folder>" argument), never written into the wiki folders
const LINK_PLUGIN = path.join(__dirname, "tw-plugins", "tw-desk-links");

let managerWindow = null;
let config = { basePort: DEFAULT_BASE_PORT, groups: [], wikis: [], webWikis: [], libraries: [] };
const servers = new Map(); // wiki id -> { child, status, logs, error }
const wikiWindows = new Map(); // wiki id -> BrowserWindow
let quitting = false;

// ---------- config ----------

function configPath() {
	return path.join(app.getPath("userData"), "config.json");
}

function loadConfig() {
	try {
		config = Object.assign({ basePort: DEFAULT_BASE_PORT, groups: [], wikis: [], webWikis: [] }, JSON.parse(fs.readFileSync(configPath(), "utf8")));
	} catch (e) {
		if (e.code !== "ENOENT") {
			dialog.showErrorBox("TW Desk", "Could not read " + configPath() + ":\n" + e.message);
		}
	}
	if (!Array.isArray(config.groups)) {
		config.groups = [];
	}
	if (!Array.isArray(config.webWikis)) {
		config.webWikis = [];
	}
	if (!validPort(config.basePort)) {
		config.basePort = DEFAULT_BASE_PORT;
	}
	// Up to 0.2.2 every wiki had a fixed "port"; now ports are automatic and that port is only preferred
	let migrated = false;
	for (const wiki of config.wikis) {
		if ("port" in wiki) {
			if (!wiki.lastPort && validPort(wiki.port)) {
				wiki.lastPort = wiki.port;
			}
			delete wiki.port;
			migrated = true;
		}
	}
	if (migrated) {
		saveConfig();
	}
	if (!Array.isArray(config.libraries)) {
		config.libraries = [
			{ url: "https://tiddlywiki.com/library/v" + TW_VERSION + "/index.html", type: "tiddlywiki" },
			{ url: "https://tw-cpl.netlify.app/repo", type: "cpl" }
		];
	}
}

// Written to a temporary file first, so a reader (or a crash) never sees a half-written config
function saveConfig() {
	fs.mkdirSync(path.dirname(configPath()), { recursive: true });
	const text = JSON.stringify(config, null, 2);
	const temp = configPath() + ".tmp";
	try {
		fs.writeFileSync(temp, text);
		fs.renameSync(temp, configPath());
	} catch (e) {
		// e.g. Windows refuses the rename while another program has the file open
		fs.rmSync(temp, { force: true });
		fs.writeFileSync(configPath(), text);
	}
}

function findWiki(id) {
	const wiki = config.wikis.find(w => w.id === id);
	if (!wiki) {
		throw new Error("Unknown wiki " + id);
	}
	return wiki;
}

function groupOf(wiki) {
	return config.groups.some(g => g.id === wiki.group) ? wiki.group : null;
}

function validateGroupName(name, ignoreId) {
	if (!name) {
		throw new Error("Group name is required.");
	}
	if (config.groups.some(g => g.id !== ignoreId && g.name.toLowerCase() === name.toLowerCase())) {
		throw new Error("A group named \"" + name + "\" already exists.");
	}
}

function validPort(port) {
	return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function validateWiki(wiki, ignoreId) {
	validateSettings(wiki, ignoreId);
	if (!fs.existsSync(path.join(wiki.path, "tiddlywiki.info"))) {
		throw new Error("No tiddlywiki.info in " + wiki.path);
	}
}

// Everything except the folder, which may not exist yet when a wiki is created
function validateSettings(wiki, ignoreId) {
	if (!wiki.name || !wiki.name.trim()) {
		throw new Error("Name is required.");
	}
	if (wiki.fixedPort !== undefined) {
		if (!validPort(wiki.fixedPort)) {
			throw new Error("A fixed port must be a number between 1024 and 65535 (or leave it empty for automatic).");
		}
		const clash = config.wikis.find(w => w.id !== ignoreId && w.fixedPort === wiki.fixedPort);
		if (clash) {
			throw new Error("Port " + wiki.fixedPort + " is already the fixed port of \"" + clash.name + "\".");
		}
	}
	const nameProblem = links.checkLinkName(wiki.linkName);
	if (nameProblem) {
		throw new Error(nameProblem);
	}
	// A name set by hand must be unique; same folder names are only reported (chip in the list)
	const sameName = wiki.linkName && config.wikis.find(w => w.id !== ignoreId && links.sameKey(links.linkKeyOf(w), wiki.linkName));
	if (sameName) {
		throw new Error("The link name \u201c" + wiki.linkName + "\u201d is already used by \u201c" + sameName.name + "\u201d.");
	}
	const samePath = config.wikis.find(w => w.id !== ignoreId && folderKey(w.path) === folderKey(wiki.path));
	if (samePath) {
		throw new Error("This folder is already in TW Desk as \"" + samePath.name + "\".");
	}
}

function wikiFromInput(input) {
	const wiki = {
		id: input.id || crypto.randomUUID(),
		name: (input.name || "").trim(),
		path: path.resolve(input.path || ""),
		autostart: !!input.autostart
	};
	if (input.fixedPort !== null && input.fixedPort !== undefined && input.fixedPort !== "") {
		wiki.fixedPort = Number(input.fixedPort);
	}
	const description = String(input.description || "").trim().slice(0, 2000);
	if (description) {
		wiki.description = description;
	}
	const linkName = String(input.linkName || "").trim();
	if (linkName) {
		wiki.linkName = linkName;
	}
	const existing = config.wikis.find(w => w.id === input.id);
	if (existing && existing.lastPort) {
		wiki.lastPort = existing.lastPort;
	}
	if (existing && existing.copiedFrom) {
		wiki.copiedFrom = existing.copiedFrom;
	}
	if (input.group) {
		if (!config.groups.some(g => g.id === input.group)) {
			throw new Error("Unknown group " + input.group);
		}
		wiki.group = input.group;
	}
	return wiki;
}

// ---------- state sent to the UI ----------

function serverState(id) {
	const s = servers.get(id);
	return s ? { status: s.status, error: s.error } : { status: "stopped", error: null };
}

// The port the wiki's server is using now, or null while it's stopped
function activePort(id) {
	const s = servers.get(id);
	return s && s.port && (s.status === "running" || s.status === "starting") ? s.port : null;
}

function snapshot() {
	return {
		appVersion: app.getVersion(),
		twVersion: TW_VERSION,
		configPath: configPath(),
		installDir: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
		platform: process.platform,
		caseInsensitivePaths: CASE_INSENSITIVE_PATHS,
		basePort: config.basePort,
		git: gitSnapshot(),
		groups: config.groups,
		ungroupedCollapsed: !!config.ungroupedCollapsed,
		webWikis: config.webWikis.map(l => Object.assign({}, l, { busy: webBusy.get(l.id) || null }, l.showcase ? { pluginCount: snapshotPluginTiddlers(l).length } : {})),
		webCheck: webCheckEnabled(),
		links: linkState(),
		webCollapsed: !!config.webCollapsed,
		wikis: config.wikis.map(w => Object.assign({}, w, { group: groupOf(w), linkKey: links.linkKeyOf(w) }, serverState(w.id), { port: activePort(w.id), url: wikiUrl(w.id) }, readIncludes(w.path)))
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
	// The Edit dialog always sends the includes: unchanged ones (same folders, same read-only) are fine while it runs
	const meaning = list => JSON.stringify(list.map(i => [folderKey(path.resolve(wiki.path, i.path)), !!i.readOnly]));
	const current = readIncludes(wiki.path);
	if (!current.infoError && meaning(entries) === meaning(current.includes.map(i => ({ path: i.resolved, readOnly: i.readOnly })))) {
		return;
	}
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

function wikiUrl(id) {
	const port = activePort(id);
	return port ? "http://127.0.0.1:" + port + "/" : null;
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

// Port choices run one at a time, so wikis started together (autostart) can't pick the same port
let portQueue = Promise.resolve();

function choosePort(wiki, state) {
	const result = portQueue.then(async () => {
		state.port = await findPort(wiki);
		return state.port;
	});
	portQueue = result.catch(() => {});
	return result;
}

// The fixed port; otherwise the port used last time if it's free, else the next free one from basePort on
async function findPort(wiki) {
	if (wiki.fixedPort) {
		if (!(await portIsFree(wiki.fixedPort))) {
			throw new Error("Port " + wiki.fixedPort + " is already in use by another program.");
		}
		return wiki.fixedPort;
	}
	const others = config.wikis.filter(w => w.id !== wiki.id);
	const taken = new Set(others.map(w => activePort(w.id)).concat(others.map(w => w.fixedPort)).filter(Boolean));
	// Avoided while other ports are free, so other wikis get their usual port (and URL) back too
	const remembered = new Set(others.map(w => w.lastPort).filter(Boolean));
	if (wiki.lastPort && !taken.has(wiki.lastPort) && (await portIsFree(wiki.lastPort))) {
		return wiki.lastPort;
	}
	const last = Math.min(65535, config.basePort + 1000);
	for (const avoidRemembered of [true, false]) {
		for (let port = config.basePort; port <= last; port++) {
			if (!taken.has(port) && !(avoidRemembered && remembered.has(port)) && (await portIsFree(port))) {
				return port;
			}
		}
	}
	throw new Error("No free port between " + config.basePort + " and " + last + ".");
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
	let port;
	try {
		port = await choosePort(wiki, state);
	} catch (e) {
		state.status = "error";
		state.error = e.message;
		appendLog(id, state.error);
		pushState();
		return;
	}
	if (!wiki.fixedPort && wiki.lastPort !== port) {
		wiki.lastPort = port;
		saveConfig();
	}
	appendLog(id, "Starting TiddlyWiki " + TW_VERSION + ": " + wiki.path + " on port " + port);
	const extra = linkSettings().plugin ? ["++" + LINK_PLUGIN] : [];
	const child = runTiddlyWiki(extra.concat([wiki.path, "--listen", "host=127.0.0.1", "port=" + port]), "TiddlyWiki " + wiki.name);
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
		// Not while quitting: the app could exit in the middle of a commit
		if (!quitting) {
			afterStop(wiki);
		}
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

// focus() alone doesn't restore a minimized window (Windows), so the click seemed to do nothing
function bringToFront(win) {
	if (win.isMinimized()) {
		win.restore();
	}
	win.show();
	win.moveTop();
	// Windows doesn't let a program in the background take the foreground (e.g. for a link clicked in the browser):
	// on top for a moment brings it there anyway
	if (process.platform === "win32") {
		win.setAlwaysOnTop(true);
		win.focus();
		win.setAlwaysOnTop(false);
	}
	win.focus();
}

// TiddlyWiki asks before a page with unsaved changes is left (beforeunload). Electron shows no dialog for that and
// just cancels the close, so the window seemed stuck: ask here instead. While quitting the servers are already
// stopping, so the window is let go without asking.
function confirmUnload(win, message, detail) {
	win.webContents.on("will-prevent-unload", event => {
		const leave = quitting || dialog.showMessageBoxSync(win, {
			type: "question",
			buttons: ["Close anyway", "Stay"],
			defaultId: 1,
			cancelId: 1,
			title: "TW Desk",
			message,
			detail
		}) === 0;
		if (leave) {
			event.preventDefault();
		}
	});
}

async function ensureRunning(id) {
	if (serverState(id).status !== "running") {
		await startWiki(id);
		await waitForRunning(id, 60000);
	}
}

async function openWiki(id, external) {
	const wiki = findWiki(id);
	await ensureRunning(id);
	const url = wikiUrl(id);
	if (external) {
		await shell.openExternal(url);
		return null;
	}
	const existing = wikiWindows.get(id);
	if (existing && !existing.isDestroyed()) {
		bringToFront(existing);
		return existing;
	}
	const win = new BrowserWindow({
		width: 1280,
		height: 900,
		title: wiki.name,
		autoHideMenuBar: true,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
	});
	// The built-in plugin shows its copy button only where the user agent says TW Desk
	win.webContents.setUserAgent(win.webContents.getUserAgent() + " TWDesk/" + app.getVersion());
	// TW Desk links are handled here; links to other sites open in the default browser; links within the wiki stay
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		if (handleDeskLink(target, id)) {
			return { action: "deny" };
		}
		if (!target.startsWith(url)) {
			shell.openExternal(target);
			return { action: "deny" };
		}
		return { action: "allow" };
	});
	win.webContents.on("will-navigate", (event, target) => {
		if (handleDeskLink(target, id)) {
			event.preventDefault();
		} else if (!target.startsWith(url)) {
			event.preventDefault();
			shell.openExternal(target);
		}
	});
	win.on("page-title-updated", (event, title) => {
		event.preventDefault();
		win.setTitle(wiki.name + " — " + title);
	});
	confirmUnload(win, "\u201c" + wiki.name + "\u201d has changes that haven't been saved yet.", "TiddlyWiki is still saving them to the wiki folder. Wait a moment and close the window again, or close it anyway and lose those changes.");
	win.on("closed", () => wikiWindows.delete(id));
	wikiWindows.set(id, win);
	win.loadURL(url);
	return win;
}

// ---------- git ----------

const GIT_DEFAULTS = { interval: 600, fetch: true, staleHours: 24, autoCommitOnStop: false };
const FOCUS_CHECK_GAP = 30000;

const gitState = { version: undefined, checking: false, checkedAt: null };
const gitFolderStatus = new Map(); // lower-cased folder -> status (see rootStatus) or { repo: false } or { error }
const gitRemoteInfo = new Map(); // lower-cased repo root -> { fetchedAt, fetchError }
let gitQueue = Promise.resolve();
let gitTimer = null;
let lastLocalCheck = 0;

function folderKey(folder) {
	const resolved = path.resolve(folder);
	return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
}

function gitSettings() {
	return Object.assign({}, GIT_DEFAULTS, config.git);
}

function gitSnapshot() {
	return {
		available: gitState.version === undefined ? null : !!gitState.version,
		version: gitState.version || null,
		checking: gitState.checking,
		checkedAt: gitState.checkedAt,
		settings: gitSettings(),
		folders: Object.fromEntries(gitFolderStatus)
	};
}

// The managed wikis and the folders they include (when those exist)
function gitFolders() {
	const folders = new Map();
	for (const wiki of config.wikis) {
		folders.set(folderKey(wiki.path), path.resolve(wiki.path));
		for (const include of readIncludes(wiki.path).includes) {
			if (include.exists) {
				folders.set(folderKey(include.resolved), include.resolved);
			}
		}
	}
	return [...folders.values()];
}

async function fetchRoot(root) {
	const info = gitRemoteInfo.get(folderKey(root)) || {};
	try {
		await git.fetch(root);
		info.fetchedAt = Date.now();
		info.fetchError = null;
	} catch (e) {
		info.fetchError = e.message;
	}
	gitRemoteInfo.set(folderKey(root), info);
}

async function rootStatus(root, fetchRemote) {
	let status = await git.status(root);
	if (fetchRemote && status.remotes.length) {
		await fetchRoot(root);
		status = await git.status(root);
	}
	return Object.assign({ repo: true, root }, status, gitRemoteInfo.get(folderKey(root)) || {});
}

// Checks run one after another; options: { fetch, folders } (folders: only these, default all)
function checkGit(options = {}) {
	gitQueue = gitQueue.then(() => runGitCheck(options)).catch(e => console.error("git check failed:", e));
	return gitQueue;
}

async function runGitCheck(options) {
	if (gitState.version === undefined) {
		gitState.version = await git.version();
	}
	if (!gitState.version) {
		pushState();
		return;
	}
	const all = !options.folders;
	const folders = options.folders || gitFolders();
	gitState.checking = true;
	pushState();
	const roots = new Map(); // a repository shared by several folders is checked once
	for (const folder of folders) {
		let entry;
		try {
			const root = await git.repoRoot(folder);
			if (!root) {
				entry = { repo: false };
			} else {
				if (!roots.has(folderKey(root))) {
					roots.set(folderKey(root), await rootStatus(root, options.fetch));
				}
				entry = roots.get(folderKey(root));
			}
		} catch (e) {
			entry = { repo: true, error: e.message };
		}
		gitFolderStatus.set(folderKey(folder), entry);
	}
	if (all) {
		const known = new Set(folders.map(folderKey));
		for (const key of gitFolderStatus.keys()) {
			if (!known.has(key)) {
				gitFolderStatus.delete(key);
			}
		}
		gitState.checkedAt = Date.now();
	}
	lastLocalCheck = Date.now();
	gitState.checking = false;
	pushState();
}

function scheduleGitChecks() {
	clearInterval(gitTimer);
	const settings = gitSettings();
	if (settings.interval > 0) {
		gitTimer = setInterval(() => checkGit({ fetch: settings.fetch }), settings.interval * 1000);
	}
}

// Wikis whose own folder or included folders lie inside the repository
function wikisUsingRepo(root) {
	const inside = folder => {
		const relative = path.relative(root, path.resolve(folder));
		return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
	};
	return config.wikis.filter(w => inside(w.path) || readIncludes(w.path).includes.some(i => inside(i.resolved)));
}

async function gitAction(action, folder, arg) {
	const resolved = path.resolve(folder);
	if (!gitFolders().some(f => folderKey(f) === folderKey(resolved))) {
		throw new Error("Unknown wiki folder: " + folder);
	}
	if (action === "open") {
		await shell.openPath(resolved);
		return;
	}
	if (action === "init") {
		if (await git.repoRoot(resolved)) {
			throw new Error("This folder is already in a git repository.");
		}
		await git.init(resolved);
	} else {
		const root = await git.repoRoot(resolved);
		if (!root) {
			throw new Error("Not a git repository: " + resolved);
		}
		if (action === "commit") {
			await git.commit(root, arg);
		} else if (action === "push") {
			await git.push(root);
		} else if (action === "pull") {
			// A running server would write its in-memory tiddlers over the pulled files
			const running = wikisUsingRepo(root).filter(w => ["running", "starting"].includes(serverState(w.id).status));
			if (running.length) {
				throw new Error("Stop " + running.map(w => w.name).join(", ") + " before pulling.");
			}
			await git.pull(root);
		} else if (action === "fetch") {
			await fetchRoot(root);
			const info = gitRemoteInfo.get(folderKey(root));
			if (info.fetchError) {
				throw new Error(info.fetchError);
			}
		} else if (action === "add-remote") {
			await git.addRemote(root, arg);
		} else {
			throw new Error("Unknown git action " + action);
		}
	}
	await checkGit({ fetch: false });
}

// Auto-commit (if enabled) the wiki's folder and its writable includes, then refresh their status
async function afterStop(wiki) {
	const folders = [path.resolve(wiki.path)].concat(readIncludes(wiki.path).includes.filter(i => i.exists).map(i => i.resolved));
	if (gitState.version && gitSettings().autoCommitOnStop) {
		const writable = [path.resolve(wiki.path)].concat(readIncludes(wiki.path).includes.filter(i => i.exists && !i.readOnly).map(i => i.resolved));
		const done = new Set();
		for (const folder of writable) {
			try {
				const root = await git.repoRoot(folder);
				if (root && !done.has(folderKey(root))) {
					done.add(folderKey(root));
					if (await git.commit(root)) {
						appendLog(wiki.id, "Auto-committed changes in " + root);
					}
				}
			} catch (e) {
				appendLog(wiki.id, "Auto-commit in " + folder + " failed: " + e.message);
			}
		}
	}
	await checkGit({ folders });
}

// ---------- creating wikis ----------

// Runs a one-off TiddlyWiki command line; fails with TiddlyWiki's output if it exits with an error
async function runTiddlyWikiCommand(args, serviceName) {
	const child = runTiddlyWiki(args, serviceName);
	let output = "";
	child.stdout.on("data", data => (output += data));
	child.stderr.on("data", data => (output += data));
	const code = await new Promise(resolve => child.once("exit", resolve));
	if (code !== 0) {
		throw new Error("TiddlyWiki failed (exit code " + code + "):\n" + output.replace(/\x1b\[[0-9;]*m/g, "").trim());
	}
}

// State tiddlers of the HTML wiki that make no sense in a folder wiki. $:/StoryList stays: with $:/DefaultTiddlers set to
// e.g. [list[$:/StoryList]], a wiki opens with the river it was saved with.
const HTML_SKIP_FILTER = "[all[tiddlers]] -[[$:/HistoryList]] -[[$:/isEncrypted]] -[[$:/status/RequireReloadDueToPluginChange]] -[prefix[$:/temp/]]";

// --savewikifolder references plugins from the official library by name (so the bundled versions are used) and,
// with explodePlugins=no, saves other plugins as single files in tiddlers/, where the Plugins window can move them to the store.
// label: what to call the source in messages (the web address for a download)
async function convertHtmlWiki(htmlFile, folder, label = htmlFile) {
	const html = fs.readFileSync(htmlFile, "utf8");
	if (html.includes("id=\"encryptedStoreArea\"")) {
		throw new Error("This wiki is password-protected and can't be converted. Open it in a browser, clear the password (Tools → Set password / Saving), save it, and try again.");
	}
	// TiddlyWiki 5.2+ keeps tiddlers in JSON script blocks, older versions in a storeArea div
	if (!html.includes("tiddlywiki-tiddler-store") && !html.includes("id=\"storeArea\"")) {
		throw new Error("This doesn't look like a TiddlyWiki: " + label);
	}
	await runTiddlyWikiCommand(["--load", htmlFile, "--savewikifolder", folder, HTML_SKIP_FILTER, "explodePlugins=no"], "TiddlyWiki convert");
}

// State, build output and version control of a wiki folder are not copied
const COPY_SKIP = new Set([".git", "output", "$__StoryList.tid", "$__HistoryList.json", "$__HistoryList.json.meta"]);

function headerTitle(text) {
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) {
			break;
		}
		const match = /^title:\s*(.*)$/.exec(line);
		if (match) {
			return match[1].trim();
		}
	}
	return null;
}

// Whether a file in tiddlers/ holds system tiddlers ($:/…); used for "only configuration" copies
function isSystemTiddlerFile(file) {
	const fallback = path.basename(file).startsWith("$__");
	try {
		if (fs.existsSync(file + ".meta")) {
			const title = headerTitle(fs.readFileSync(file + ".meta", "utf8"));
			return title ? title.startsWith("$:/") : fallback;
		}
		if (file.endsWith(".tid")) {
			const title = headerTitle(fs.readFileSync(file, "utf8"));
			return title ? title.startsWith("$:/") : fallback;
		}
		if (file.endsWith(".json")) {
			const data = JSON.parse(fs.readFileSync(file, "utf8"));
			const list = Array.isArray(data) ? data : [data];
			return list.length > 0 && list.every(t => t && typeof t.title === "string" && t.title.startsWith("$:/"));
		}
	} catch (e) {
		return false;
	}
	return fallback;
}

// Copies a wiki folder; "config" copies everything except content: only system tiddlers, no files/ folder
function copyWikiFolder(source, target, mode) {
	const configOnly = mode === "config";
	const tiddlersDir = path.join(source, "tiddlers");
	fs.cpSync(source, target, {
		recursive: true,
		filter: file => {
			const name = path.basename(file);
			if (COPY_SKIP.has(name)) {
				return false;
			}
			if (!configOnly || file === source) {
				return true;
			}
			const relative = path.relative(source, file);
			if (relative === "files" || relative.startsWith("files" + path.sep)) {
				return false;
			}
			if (file === tiddlersDir || !relative.startsWith("tiddlers" + path.sep) || fs.statSync(file).isDirectory()) {
				return true;
			}
			// A .meta file goes with the file it describes
			return isSystemTiddlerFile(name.endsWith(".meta") ? file.slice(0, -5) : file);
		}
	});
	// Keep included folders pointing to the same place when the copy lives elsewhere
	const info = JSON.parse(fs.readFileSync(infoPath(target), "utf8"));
	if (Array.isArray(info.includeWikis)) {
		info.includeWikis = info.includeWikis.map(entry => {
			const item = typeof entry === "string" ? { path: entry } : Object.assign({}, entry);
			const resolved = path.resolve(source, item.path || "");
			let relative = path.relative(target, resolved);
			if (!relative || path.isAbsolute(relative)) {
				relative = resolved;
			}
			item.path = relative.split(path.sep).join("/");
			return typeof entry === "string" ? item.path : item;
		});
		fs.writeFileSync(infoPath(target), JSON.stringify(info, null, 4));
	}
}

function isWebUrl(text) {
	return /^https?:\/\//i.test(String(text || "").trim());
}

// Downloads a page (Electron's net uses the system proxy settings). With since (a web wiki's baseline) the server may
// answer "not modified" instead: { notModified: true }
async function fetchPage(url, since) {
	const headers = {};
	if (since && since.etag) {
		headers["If-None-Match"] = since.etag;
	}
	if (since && since.lastModified) {
		headers["If-Modified-Since"] = since.lastModified;
	}
	let response;
	try {
		response = await electronNet.fetch(url, { cache: "no-store", headers });
	} catch (e) {
		throw new Error("Could not download " + url + ":\n" + e.message);
	}
	if (response.status === 304 && since) {
		return { notModified: true };
	}
	if (!response.ok) {
		throw new Error("Could not download " + url + ": HTTP " + response.status);
	}
	return { buffer: Buffer.from(await response.arrayBuffer()), etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") };
}

// Downloads a single-file wiki into a temporary file
async function downloadWiki(url) {
	const file = path.join(app.getPath("temp"), "tw-desk-download-" + crypto.randomUUID() + ".html");
	fs.writeFileSync(file, (await fetchPage(url)).buffer);
	return file;
}

// Creates a new wiki folder (empty, converted from a single-file HTML wiki file or web address, or copied from another wiki) and adds it to the list
async function createWiki(input) {
	const folderName = (input.folderName || "").trim();
	if (!folderName || /[\\/:*?"<>|]/.test(folderName) || /^\.+$/.test(folderName)) {
		throw new Error("Please enter a valid folder name (without \\ / : * ? \" < > |).");
	}
	if (!input.parent || !fs.existsSync(path.resolve(input.parent))) {
		throw new Error("The folder to create the wiki in doesn't exist: " + (input.parent || "(none)"));
	}
	// A web wiki's snapshot is converted like a local file but remembered as coming from the web address
	const link = input.webWiki ? findWebWiki(input.webWiki) : null;
	if (link && !link.snapshot) {
		throw new Error("\u201c" + link.name + "\u201d has no snapshot yet.");
	}
	const htmlUrl = !link && isWebUrl(input.htmlFile) ? input.htmlFile.trim() : null;
	const htmlFile = link ? snapshotFile(link.id) : input.htmlFile && !htmlUrl ? path.resolve(input.htmlFile) : null;
	if (htmlFile && !fs.existsSync(htmlFile)) {
		throw new Error("HTML file not found: " + htmlFile);
	}
	const folder = path.join(path.resolve(input.parent), folderName);
	const source = input.copyFrom ? findWiki(input.copyFrom) : null;
	if (source) {
		const relative = path.relative(path.resolve(source.path), folder);
		if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
			throw new Error("The copy can't be created inside the wiki it copies.");
		}
	}
	const wiki = wikiFromInput(Object.assign({}, input, { id: null, path: folder }));
	validateSettings(wiki, null);
	const existed = fs.existsSync(folder);
	if (existed && fs.readdirSync(folder).length) {
		throw new Error("The folder already exists and isn't empty: " + folder);
	}
	try {
		if (htmlUrl) {
			const downloaded = await downloadWiki(htmlUrl);
			try {
				await convertHtmlWiki(downloaded, folder, htmlUrl);
			} finally {
				fs.rmSync(downloaded, { force: true });
			}
		} else if (htmlFile) {
			await convertHtmlWiki(htmlFile, folder, link ? link.url : htmlFile);
		} else if (source) {
			copyWikiFolder(path.resolve(source.path), folder, input.copyMode);
		} else {
			fs.mkdirSync(folder, { recursive: true });
			await runTiddlyWikiCommand([folder, "--init", "server"], "TiddlyWiki init");
		}
		fs.mkdirSync(path.join(folder, "tiddlers"), { recursive: true });
		const info = JSON.parse(fs.readFileSync(infoPath(folder), "utf8"));
		// Needed to serve and save the wiki; a converted HTML wiki doesn't list them
		info.plugins = info.plugins || [];
		for (const plugin of ["tiddlywiki/tiddlyweb", "tiddlywiki/filesystem"]) {
			if (!info.plugins.includes(plugin)) {
				info.plugins.push(plugin);
			}
		}
		if (input.sharedPath) {
			const shared = path.resolve(input.sharedPath);
			if (!fs.existsSync(infoPath(shared))) {
				throw new Error("Not a wiki folder (no tiddlywiki.info): " + shared);
			}
			let relative = path.relative(folder, shared);
			if (path.isAbsolute(relative)) {
				relative = shared;
			}
			info.includeWikis = [{ path: relative.split(path.sep).join("/"), "read-only": false }];
		}
		fs.writeFileSync(infoPath(folder), JSON.stringify(info, null, 4));
	} catch (e) {
		// Only remove what this call created
		if (existed) {
			for (const entry of fs.readdirSync(folder)) {
				fs.rmSync(path.join(folder, entry), { recursive: true, force: true });
			}
		} else {
			fs.rmSync(folder, { recursive: true, force: true });
		}
		throw e;
	}
	const today = new Date().toISOString().slice(0, 10);
	if (source) {
		// Shown in the list ("copy of …"); kept as text so it survives renaming or removing the original
		wiki.copiedFrom = { id: source.id, name: source.name, path: path.resolve(source.path), date: today };
	} else if (link) {
		wiki.importedFrom = { source: link.url, date: today, snapshot: link.snapshot.date.slice(0, 10) };
	} else if (htmlUrl || htmlFile) {
		wiki.importedFrom = { source: htmlUrl || htmlFile, date: today };
	}
	config.wikis.push(wiki);
	saveConfig();
	pushState();
	// The wiki exists either way; without a repository its git chip offers to create one
	if (input.gitInit && gitState.version) {
		try {
			if (!(await git.repoRoot(folder))) {
				await git.init(folder);
			}
		} catch (e) {
			console.error("git init of " + folder + " failed:", e.message);
		}
	}
	checkGit({ fetch: false });
	return wiki.id;
}

// ---------- IPC ----------

ipcMain.handle("get-state", () => snapshot());

ipcMain.handle("get-logs", (event, id) => (servers.get(id) ? servers.get(id).logs : []));

ipcMain.handle("save-settings", (event, input) => {
	const basePort = Number(input.basePort);
	if (!validPort(basePort)) {
		throw new Error("The start port must be a number between 1024 and 65535.");
	}
	const interval = Number(input.gitInterval);
	if (!Number.isInteger(interval) || interval < 0 || (interval > 0 && interval < 30)) {
		throw new Error("The git check interval must be 0 (off) or at least 30 seconds.");
	}
	const staleHours = Number(input.gitStaleHours);
	if (!(staleHours > 0)) {
		throw new Error("The hours for old uncommitted changes must be a positive number.");
	}
	const linkPort = Number(input.linkPort);
	if (!validPort(linkPort)) {
		throw new Error("The port for http links must be a number between 1024 and 65535.");
	}
	const fixed = config.wikis.find(w => w.fixedPort === linkPort);
	if (fixed) {
		throw new Error("Port " + linkPort + " is the fixed port of \"" + fixed.name + "\"; choose another one for http links.");
	}
	config.basePort = basePort;
	config.git = { interval, fetch: !!input.gitFetch, staleHours, autoCommitOnStop: !!input.gitAutoCommit };
	config.webCheck = !!input.webCheck;
	config.links = { style: input.linkStyle === "http" ? "http" : "scheme", port: linkPort, router: !!input.linkRouter, scheme: !!input.linkScheme, plugin: !!input.linkPlugin };
	saveConfig();
	scheduleGitChecks();
	scheduleWebChecks();
	startRouter();
	registerScheme();
	pushState();
});

ipcMain.handle("git-action", (event, action, folder, arg) => gitAction(action, folder, arg));

// Local status only (no fetch), at most every 30 seconds
ipcMain.handle("git-check-focus", () => {
	if (Date.now() - lastLocalCheck > FOCUS_CHECK_GAP) {
		lastLocalCheck = Date.now();
		checkGit({ fetch: false });
	}
});

ipcMain.handle("git-check-now", () => checkGit({ fetch: gitSettings().fetch }));

ipcMain.handle("pick-folder", async (event, title) => {
	const result = await dialog.showOpenDialog(managerWindow, { title, properties: ["openDirectory", "createDirectory"] });
	return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("pick-file", async (event, title, filters) => {
	const result = await dialog.showOpenDialog(managerWindow, { title, properties: ["openFile"], filters });
	return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("create-wiki", (event, input) => createWiki(input));

ipcMain.handle("save-wiki", (event, input) => {
	const wiki = wikiFromInput(input);
	validateWiki(wiki, input.id);
	const index = config.wikis.findIndex(w => w.id === wiki.id);
	if (index === -1) {
		config.wikis.push(wiki);
	} else {
		config.wikis[index] = wiki;
	}
	saveConfig();
	pushState();
	checkGit({ fetch: false });
	return wiki.id;
});

ipcMain.handle("save-includes", (event, id, entries) => {
	saveIncludes(id, entries);
	checkGit({ fetch: false });
});

// ---------- plugins ----------

// All wiki folders TW Desk knows: the wikis in the list plus the folders they include
function knownFolders() {
	const folders = new Map(); // lower-cased path -> folder
	const add = (folderPath, wiki) => {
		const key = folderKey(folderPath);
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
	const folder = knownFolders().find(f => folderKey(f.path) === folderKey(folderPath));
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

// ---------- plugin showcases (web wikis marked as such; their plugins come from the snapshot) ----------

// Showcases act as extra plugin sources named "showcase:<link id>" (installs, update offers, store bookkeeping)
const SHOWCASE_PREFIX = "showcase:";
const showcaseCache = new Map(); // link id -> { mtime, tiddlers } (plugin tiddlers of the snapshot, with their text)

function snapshotPluginTiddlers(link) {
	let mtime;
	try {
		mtime = fs.statSync(snapshotFile(link.id)).mtimeMs;
	} catch (e) {
		return [];
	}
	const cached = showcaseCache.get(link.id);
	if (cached && cached.mtime === mtime) {
		return cached.tiddlers;
	}
	const parsed = web.readTiddlers(fs.readFileSync(snapshotFile(link.id), "utf8"));
	const tiddlers = ((parsed && parsed.tiddlers) || []).filter(t => typeof t["plugin-type"] === "string" && plugins.parseTitle(t.title));
	showcaseCache.set(link.id, { mtime, tiddlers });
	return tiddlers;
}

function showcaseIndexes() {
	return config.webWikis.filter(l => l.showcase).map(link => ({
		url: SHOWCASE_PREFIX + link.id,
		type: "showcase",
		id: link.id,
		name: link.name,
		site: link.url,
		description: link.description || "",
		snapshot: link.snapshot ? link.snapshot.date : null,
		entries: plugins.normalizeEntries(snapshotPluginTiddlers(link), "showcase"),
		// Plugins this showcase demonstrates (chosen by the user); they get "Demo" buttons elsewhere
		linked: (link.linkedPlugins || []).slice()
	}));
}

// Marks a showcase as demo of a plugin in its snapshot, or removes that mark
function linkShowcase(id, title, linked) {
	const link = findWebWiki(id);
	const titles = new Set(link.linkedPlugins || []);
	if (linked) {
		if (!snapshotPluginTiddlers(link).some(t => t.title === title)) {
			throw new Error(title + " is not in the snapshot of \u201c" + link.name + "\u201d.");
		}
		titles.add(title);
	} else {
		titles.delete(title);
	}
	if (titles.size) {
		link.linkedPlugins = [...titles].sort();
	} else {
		delete link.linkedPlugins;
	}
	saveConfig();
	pushState();
}

function installFromShowcase(id, title) {
	const link = findWebWiki(id);
	const fields = snapshotPluginTiddlers(link).find(t => t.title === title);
	if (!fields) {
		throw new Error(title + " is not in the snapshot of \u201c" + link.name + "\u201d.");
	}
	return plugins.writeToStore(fields, { library: SHOWCASE_PREFIX + id });
}

function pluginsState() {
	return {
		storePath: plugins.storePath(),
		backupPath: path.join(app.getPath("userData"), "backup"),
		twVersion: TW_VERSION,
		libraries: config.libraries,
		showcases: showcaseIndexes(),
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
ipcMain.handle("plugins-all-indexes", async (event, refresh) => (await plugins.allIndexes(config.libraries, refresh)).concat(showcaseIndexes()));

// Documentation and source links from library entries (web addresses only)
ipcMain.handle("plugins-open-link", (event, url) => {
	if (!/^https?:\/\//i.test(String(url))) {
		throw new Error("Not a web address: " + url);
	}
	return shell.openExternal(String(url));
});

ipcMain.handle("plugins-install", (event, url, title) => url.startsWith(SHOWCASE_PREFIX)
	? installFromShowcase(url.slice(SHOWCASE_PREFIX.length), title)
	: plugins.installFromLibrary(findLibrary(url), title));

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

ipcMain.handle("plugins-link-showcase", (event, id, title, linked) => linkShowcase(id, title, linked));

ipcMain.handle("plugins-check-updates", () => {
	const state = pluginsState();
	const installed = state.store.concat(...state.folders.map(f => f.stored.map(p => Object.assign({ folder: f.name }, p))));
	return plugins.checkUpdates(config.libraries, installed, showcaseIndexes());
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

function isInside(folder, parent) {
	const relative = path.relative(path.resolve(parent), path.resolve(folder));
	return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Why the wiki's folder can't be deleted right now (empty list: it can), plus its size for the dialog
function deleteCheck(wiki) {
	const blockers = [];
	if (["running", "starting"].includes(serverState(wiki.id).status)) {
		blockers.push("The wiki is running – stop it first.");
	}
	const includedBy = config.wikis.filter(w => w.id !== wiki.id && readIncludes(w.path).includes.some(i => folderKey(i.resolved) === folderKey(wiki.path)));
	if (includedBy.length) {
		blockers.push("Included by " + includedBy.map(w => "\"" + w.name + "\"").join(", ") + " – remove the include there first.");
	}
	const nested = config.wikis.filter(w => w.id !== wiki.id && isInside(w.path, wiki.path));
	if (nested.length) {
		blockers.push("The folder contains other wikis: " + nested.map(w => "\"" + w.name + "\"").join(", ") + ".");
	}
	let files = 0;
	const count = dir => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (entry.name !== ".git") {
					count(path.join(dir, entry.name));
				}
			} else {
				files++;
			}
		}
	};
	const exists = fs.existsSync(wiki.path);
	if (exists) {
		count(wiki.path);
	} else {
		blockers.push("The folder doesn't exist any more.");
	}
	return { path: path.resolve(wiki.path), exists, files, blockers };
}

ipcMain.handle("delete-check", (event, id) => deleteCheck(findWiki(id)));

// Moves the wiki's folder to the trash (never deletes permanently) and removes it from the list
ipcMain.handle("delete-wiki", async (event, id) => {
	const wiki = findWiki(id);
	const check = deleteCheck(wiki);
	if (check.blockers.length) {
		throw new Error(check.blockers.join("\n"));
	}
	try {
		await shell.trashItem(check.path);
	} catch (e) {
		throw new Error("Could not move the folder to the trash, so nothing was deleted:\n" + e.message);
	}
	const win = wikiWindows.get(id);
	if (win && !win.isDestroyed()) {
		win.close();
	}
	servers.delete(id);
	config.wikis = config.wikis.filter(w => w.id !== id);
	saveConfig();
	pushState();
	checkGit({ fetch: false });
});

// Moves a wiki past its neighbour in the same group (the list is shown grouped)
ipcMain.handle("move-wiki", (event, id, delta) => {
	const index = config.wikis.findIndex(w => w.id === id);
	if (index === -1) {
		return;
	}
	const group = groupOf(config.wikis[index]);
	let target = index + delta;
	while (target >= 0 && target < config.wikis.length && groupOf(config.wikis[target]) !== group) {
		target += delta;
	}
	if (target >= 0 && target < config.wikis.length) {
		[config.wikis[index], config.wikis[target]] = [config.wikis[target], config.wikis[index]];
		saveConfig();
		pushState();
	}
});

// Drag and drop: puts the wiki into group (null: ungrouped) before beforeId, or at the end of the group
ipcMain.handle("place-wiki", (event, id, group, beforeId) => {
	const index = config.wikis.findIndex(w => w.id === id);
	if (index === -1) {
		throw new Error("Unknown wiki " + id);
	}
	if (group && !config.groups.some(g => g.id === group)) {
		throw new Error("Unknown group " + group);
	}
	if (beforeId === id) {
		return;
	}
	const [wiki] = config.wikis.splice(index, 1);
	if (group) {
		wiki.group = group;
	} else {
		delete wiki.group;
	}
	let target = beforeId ? config.wikis.findIndex(w => w.id === beforeId) : -1;
	if (target === -1) {
		let last = -1;
		config.wikis.forEach((w, i) => {
			if (groupOf(w) === (group || null)) {
				last = i;
			}
		});
		target = last === -1 ? config.wikis.length : last + 1;
	}
	config.wikis.splice(target, 0, wiki);
	saveConfig();
	pushState();
});

ipcMain.handle("save-group", (event, input) => {
	const name = (input.name || "").trim();
	validateGroupName(name, input.id);
	if (input.id) {
		const group = config.groups.find(g => g.id === input.id);
		if (!group) {
			throw new Error("Unknown group " + input.id);
		}
		group.name = name;
	} else {
		config.groups.push({ id: crypto.randomUUID(), name });
	}
	saveConfig();
	pushState();
});

// id null is the "Ungrouped" section
// ---------- web wikis (links to wikis on the web, with optional local snapshot) ----------

// Per link, in <userData>/web/<id>/: snapshot.html (the saved copy, if any) and baseline.json (validators and tiddler
// hashes of the version last seen: when the link was added, the snapshot saved or the changes marked as seen).
// config: link.snapshot { date, size, tiddlers, twVersion }, link.check { date, result: same|changed|error, … }
const WEB_CHECK_AGE = 24 * 3600 * 1000;
const webBusy = new Map(); // link id -> "checking" | "saving" (the latest queued task)
const webPending = new Map(); // link id -> number of queued tasks
const snapshotWindows = new Map(); // link id -> BrowserWindow
let webQueue = Promise.resolve();
let webTimer = null;

function webDir(id) {
	return path.join(app.getPath("userData"), "web", id);
}

function snapshotFile(id) {
	return path.join(webDir(id), "snapshot.html");
}

function readBaseline(link) {
	try {
		const baseline = JSON.parse(fs.readFileSync(path.join(webDir(link.id), "baseline.json"), "utf8"));
		// After the address was edited the old baseline says nothing about the new one
		return baseline.url === link.url ? baseline : null;
	} catch (e) {
		return null;
	}
}

function writeBaseline(link, page, index) {
	fs.mkdirSync(webDir(link.id), { recursive: true });
	const baseline = Object.assign({ date: new Date().toISOString(), url: link.url, etag: page.etag || null, lastModified: page.lastModified || null }, index);
	fs.writeFileSync(path.join(webDir(link.id), "baseline.json"), JSON.stringify(baseline));
}

function webWikiFromInput(input) {
	let url;
	try {
		url = new URL(String(input.url || "").trim());
	} catch (e) {
		throw new Error("Please enter a web address, e.g. https://groktiddlywiki.com/read/");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only http and https addresses are supported.");
	}
	const link = { id: input.id || crypto.randomUUID(), name: String(input.name || "").trim() || url.host, url: url.href };
	if (input.showcase) {
		link.showcase = true;
	}
	const description = String(input.description || "").trim().slice(0, 2000);
	if (description) {
		link.description = description;
	}
	return link;
}

function findWebWiki(id) {
	const link = config.webWikis.find(l => l.id === id);
	if (!link) {
		throw new Error("Unknown web wiki " + id);
	}
	return link;
}

// Downloads and comparisons run one at a time; the row shows what's going on
function queueWeb(id, kind, task) {
	webBusy.set(id, kind);
	webPending.set(id, (webPending.get(id) || 0) + 1);
	pushState();
	const result = webQueue.then(task);
	webQueue = result.catch(() => {}).then(() => {
		const left = webPending.get(id) - 1;
		if (left) {
			webPending.set(id, left);
		} else {
			webPending.delete(id);
			webBusy.delete(id);
		}
		pushState();
	});
	return result;
}

function webCheckEnabled() {
	return config.webCheck !== false;
}

// Compares the site with the baseline; the first check (e.g. right after adding the link) only records the baseline
async function checkWebWiki(id) {
	let link = findWebWiki(id);
	const baseline = readBaseline(link);
	const check = { date: new Date().toISOString(), result: "same" };
	try {
		const page = await fetchPage(link.url, baseline);
		if (!baseline) {
			writeBaseline(link, page, web.indexOf(page.buffer));
		} else if (!page.notModified) {
			const index = web.indexOf(page.buffer);
			if (index.fileHash !== baseline.fileHash) {
				const diff = web.compare(baseline, index);
				if (diff && !diff.added && !diff.changed && !diff.removed) {
					// Only volatile tiddlers or the page around the tiddlers changed; remember the new file
					writeBaseline(link, page, index);
				} else {
					Object.assign(check, { result: "changed" }, diff || {});
					if (index.twVersion !== baseline.twVersion) {
						check.twVersion = index.twVersion;
					}
				}
			}
		}
	} catch (e) {
		Object.assign(check, { result: "error", error: e.message });
	}
	// The link may have been removed meanwhile
	link = config.webWikis.find(l => l.id === id);
	if (link) {
		link.check = check;
		saveConfig();
	}
}

async function saveSnapshot(id) {
	const page = await fetchPage(findWebWiki(id).url);
	const index = web.indexOf(page.buffer);
	if (index.notWiki) {
		throw new Error("This doesn't look like a TiddlyWiki: " + findWebWiki(id).url);
	}
	const link = config.webWikis.find(l => l.id === id);
	if (!link) {
		return;
	}
	const file = snapshotFile(id);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file + ".tmp", page.buffer);
	fs.renameSync(file + ".tmp", file);
	writeBaseline(link, page, index);
	const date = new Date().toISOString();
	link.snapshot = { date, size: index.size, tiddlers: index.tiddlers ? Object.keys(index.tiddlers).length : null, twVersion: index.twVersion };
	link.check = { date, result: "same" };
	saveConfig();
	const win = snapshotWindows.get(id);
	if (win && !win.isDestroyed()) {
		win.loadFile(file);
	}
}

// The saved copy runs on its own in an app window, without a server; changes in it aren't saved anywhere
function openSnapshot(id) {
	const link = findWebWiki(id);
	if (!link.snapshot || !fs.existsSync(snapshotFile(id))) {
		throw new Error("\u201c" + link.name + "\u201d has no snapshot yet.");
	}
	const existing = snapshotWindows.get(id);
	if (existing && !existing.isDestroyed()) {
		bringToFront(existing);
		return;
	}
	const title = link.name + " (snapshot " + link.snapshot.date.slice(0, 10) + ")";
	const win = new BrowserWindow({
		width: 1280,
		height: 900,
		title,
		autoHideMenuBar: true,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
	});
	const external = target => {
		if (/^https?:/i.test(target)) {
			shell.openExternal(target);
		}
	};
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		if (!handleDeskLink(target, null)) {
			external(target);
		}
		return { action: "deny" };
	});
	// Links within the wiki only change the #hash; anything else goes to the browser
	win.webContents.on("will-navigate", (event, target) => {
		event.preventDefault();
		if (!handleDeskLink(target, null)) {
			external(target);
		}
	});
	win.on("page-title-updated", (event, pageTitle) => {
		event.preventDefault();
		win.setTitle(title + " — " + pageTitle);
	});
	confirmUnload(win, "Close the snapshot of \u201c" + link.name + "\u201d?", "Changes made in a snapshot are never saved – they are lost when the window closes. To keep working with this wiki, use \u201cMake wiki from snapshot\u2026\u201d in its \u22ef menu.");
	win.on("closed", () => snapshotWindows.delete(id));
	snapshotWindows.set(id, win);
	win.loadFile(snapshotFile(id));
}

async function checkDueWebWikis(all) {
	for (const link of config.webWikis.slice()) {
		if (all || !link.check || Date.now() - Date.parse(link.check.date) > WEB_CHECK_AGE) {
			await queueWeb(link.id, "checking", () => checkWebWiki(link.id)).catch(() => {});
		}
	}
}

// Once a day per link; the timer only looks for links that are due
function scheduleWebChecks() {
	clearInterval(webTimer);
	webTimer = null;
	if (webCheckEnabled()) {
		webTimer = setInterval(() => checkDueWebWikis(false), 3600 * 1000);
		setTimeout(() => webTimer && checkDueWebWikis(false), 60 * 1000);
	}
}

ipcMain.handle("save-web-wiki", (event, input) => {
	const link = webWikiFromInput(input);
	const clash = config.webWikis.find(l => l.id !== link.id && l.url === link.url);
	if (clash) {
		throw new Error("This address is already in the list as \"" + clash.name + "\".");
	}
	const index = config.webWikis.findIndex(l => l.id === link.id);
	const previous = config.webWikis[index];
	if (previous) {
		for (const key of ["snapshot", "check", "linkedPlugins"]) {
			if (previous[key]) {
				link[key] = previous[key];
			}
		}
		config.webWikis[index] = link;
	} else {
		config.webWikis.push(link);
	}
	saveConfig();
	pushState();
	// Remember the version as of now, to tell later whether the site changed
	if (!previous || previous.url !== link.url) {
		delete link.check;
		queueWeb(link.id, "checking", () => checkWebWiki(link.id)).catch(() => {});
	}
	return link.id;
});

ipcMain.handle("remove-web-wiki", (event, id) => {
	config.webWikis = config.webWikis.filter(l => l.id !== id);
	saveConfig();
	const win = snapshotWindows.get(id);
	if (win && !win.isDestroyed()) {
		win.close();
	}
	fs.rmSync(webDir(id), { recursive: true, force: true });
	showcaseCache.delete(id);
	pushState();
});

// Only addresses from the list are opened
ipcMain.handle("open-web-wiki", (event, id) => shell.openExternal(findWebWiki(id).url));
ipcMain.handle("open-snapshot", (event, id) => openSnapshot(id));
ipcMain.handle("show-snapshot", (event, id) => shell.showItemInFolder(snapshotFile(findWebWiki(id).id)));
ipcMain.handle("save-snapshot", (event, id) => queueWeb(findWebWiki(id).id, "saving", () => saveSnapshot(id)));
ipcMain.handle("check-web-wiki", (event, id) => queueWeb(findWebWiki(id).id, "checking", () => checkWebWiki(id)));
ipcMain.handle("check-web-wikis", () => checkDueWebWikis(true));

// Without a snapshot: the current version becomes the one to compare with
ipcMain.handle("mark-web-wiki-seen", (event, id) => queueWeb(findWebWiki(id).id, "checking", async () => {
	fs.rmSync(path.join(webDir(id), "baseline.json"), { force: true });
	await checkWebWiki(id);
}));

ipcMain.handle("move-web-wiki", (event, id, delta) => {
	const index = config.webWikis.findIndex(l => l.id === id);
	const target = index + delta;
	if (index !== -1 && target >= 0 && target < config.webWikis.length) {
		[config.webWikis[index], config.webWikis[target]] = [config.webWikis[target], config.webWikis[index]];
		saveConfig();
		pushState();
	}
});

ipcMain.handle("set-web-collapsed", (event, collapsed) => {
	config.webCollapsed = !!collapsed;
	saveConfig();
	pushState();
});

ipcMain.handle("set-group-collapsed", (event, id, collapsed) => {
	if (id) {
		const group = config.groups.find(g => g.id === id);
		if (!group) {
			throw new Error("Unknown group " + id);
		}
		group.collapsed = !!collapsed;
	} else {
		config.ungroupedCollapsed = !!collapsed;
	}
	saveConfig();
	pushState();
});

// The group's wikis stay in the list, ungrouped
ipcMain.handle("remove-group", (event, id) => {
	config.groups = config.groups.filter(g => g.id !== id);
	for (const wiki of config.wikis) {
		if (wiki.group === id) {
			delete wiki.group;
		}
	}
	saveConfig();
	pushState();
});

ipcMain.handle("start-wiki", (event, id) => startWiki(id));
ipcMain.handle("stop-wiki", (event, id) => stopWiki(id));
ipcMain.handle("open-wiki", async (event, id, external) => {
	await openWiki(id, external);
});
ipcMain.handle("show-folder", (event, id) => shell.openPath(findWiki(id).path));
ipcMain.handle("copy-text", (event, text) => clipboard.writeText(String(text)));

// ---------- links between wikis (src/links.js, built-in plugin in src/tw-plugins/tw-desk-links) ----------

const LINK_DEFAULTS = { style: "scheme", router: false, scheme: true, plugin: true };
let router = null; // { server, port } while TW Desk answers http links in browsers
let routerError = null;

// style: what "TW Desk link" copies (scheme | http); port: the router's; router: answer http links in browsers;
// scheme: register twdesk:// for other programs; plugin: load the built-in plugin into the wikis
function linkSettings() {
	return Object.assign({}, LINK_DEFAULTS, { port: config.basePort - 1 }, config.links);
}

function wikisWithKey(key) {
	return config.wikis.filter(w => links.sameKey(links.linkKeyOf(w), key));
}

function linkMessage(message, detail) {
	dialog.showMessageBoxSync(BrowserWindow.getFocusedWindow() || managerWindow, { type: "info", title: "TW Desk", message, detail, buttons: ["OK"] });
}

// For URLs clicked in a wiki or snapshot window: true if it was a TW Desk link (then it's taken care of here)
function handleDeskLink(url, fromWikiId) {
	const link = links.parseLink(url, linkSettings().port);
	if (!link) {
		return false;
	}
	if (link.copy !== undefined) {
		if (fromWikiId) {
			copyDeskLink(fromWikiId, link.copy, link.caption);
		}
	} else {
		followLink(link.key, link.title).catch(e => linkMessage("Could not open the link.", e.message));
	}
	return true;
}

function copyDeskLink(id, title, caption) {
	const wiki = findWiki(id);
	const settings = linkSettings();
	const key = links.linkKeyOf(wiki);
	clipboard.writeText(links.linkWikitext(settings.style, key, title, settings.port, caption));
	const twice = wikisWithKey(key).length > 1 ? " Note: another wiki has the same link name “" + key + "” – give one of them its own in Edit…" : "";
	const win = wikiWindows.get(id);
	if (win && !win.isDestroyed()) {
		const notice = "TW Desk link copied – paste it into another wiki." + twice;
		win.webContents.executeJavaScript("$tw.wiki.addTiddler({ title: \"$:/temp/tw-desk/notice\", text: " + JSON.stringify(notice) + " }); $tw.notifier.display(\"$:/temp/tw-desk/notice\"); true").catch(() => {});
	}
}

// Starts the wiki if needed, opens its window or brings it to the front, then shows the tiddler
// source: where the link came from, for the wiki's log ("another program" for links from outside TW Desk)
async function followLink(key, title, source) {
	const matches = wikisWithKey(key);
	if (!matches.length) {
		if (managerWindow && source) {
			bringToFront(managerWindow);
		}
		linkMessage("No wiki with the link name “" + key + "” in TW Desk.", "A wiki's link name is the one set in its Edit dialog, otherwise the name of its folder.");
		return;
	}
	let wiki = matches[0];
	if (matches.length > 1) {
		const choice = dialog.showMessageBoxSync(BrowserWindow.getFocusedWindow() || managerWindow, {
			type: "question",
			title: "TW Desk",
			message: "Several wikis have the link name “" + key + "”.",
			detail: "Open which one? Give one of them its own link name in Edit… to make such links unique.",
			buttons: matches.map(w => w.name).concat("Cancel"),
			defaultId: 0,
			cancelId: matches.length
		});
		if (!(choice >= 0 && choice < matches.length)) {
			return;
		}
		wiki = matches[choice];
	}
	if (source) {
		appendLog(wiki.id, "Link from " + source + ": " + key + (title ? " / " + title : ""));
	}
	const win = await openWiki(wiki.id);
	if (win) {
		if (title) {
			await showTiddler(win, title);
		}
		// A new window or one that had to wait for the server may have lost the foreground meanwhile
		bringToFront(win);
	}
}

// Waits until TiddlyWiki has rendered in the window, then opens the tiddler as a link click would (top of the story)
async function showTiddler(win, title) {
	const started = Date.now();
	while (!win.isDestroyed()) {
		const ready = await win.webContents.executeJavaScript("!!(window.$tw && $tw.Story && $tw.wiki && document.querySelector(\".tc-story-river\"))").catch(() => false);
		if (ready) {
			await win.webContents.executeJavaScript("new $tw.Story({ wiki: $tw.wiki }).navigateTiddler(" + JSON.stringify(title) + "); true");
			return;
		}
		if (Date.now() - started > 60000) {
			throw new Error("The wiki didn't finish loading.");
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
}

function routerPage(res, status, heading, body) {
	res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	res.end("<!doctype html><meta charset=\"utf-8\"><title>TW Desk</title><body style=\"font-family: system-ui, sans-serif; margin: 2em\"><h2>"
		+ escapeHtml(heading) + "</h2>" + body + "</body>");
}

// The router: /open/<link name>/<title> starts the wiki and sends the browser there
async function answerRouter(req, res) {
	const url = new URL(req.url, "http://127.0.0.1");
	const link = req.method === "GET" ? links.parseRouterPath(url.pathname) : null;
	if (!link) {
		routerPage(res, 404, "Not a TW Desk link", "<p>TW Desk links look like <code>/open/&lt;link name&gt;/&lt;tiddler&gt;</code>.</p>");
		return;
	}
	const what = (link.title ? "“" + link.title + "” in " : "") + "“" + link.key + "”";
	// A clicked link (a navigation of the page itself) is fine from anywhere – a wiki opened as localhost:<port> is another
	// "site" than 127.0.0.1 for the browser. Requests a page makes on its own (images, scripts, frames) from another
	// website get a button instead (clicking it is a same-origin request), so they can't start wikis unnoticed
	const clicked = req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
	if (req.headers["sec-fetch-site"] === "cross-site" && !clicked) {
		routerPage(res, 200, "Open " + what + "?", "<p><a href=\"" + escapeHtml(url.pathname + url.search) + "\">Open it with TW Desk</a></p>");
		return;
	}
	let matches = wikisWithKey(link.key);
	const chosen = url.searchParams.get("wiki");
	if (chosen) {
		matches = matches.filter(w => w.id === chosen);
	}
	if (!matches.length) {
		routerPage(res, 404, "No wiki with the link name “" + link.key + "” in TW Desk", "<p>A wiki's link name is the one set in its Edit dialog, otherwise the name of its folder.</p>");
		return;
	}
	if (matches.length > 1) {
		routerPage(res, 409, "Several wikis have the link name “" + link.key + "”", "<p>Open which one?</p><ul>"
			+ matches.map(w => "<li><a href=\"" + escapeHtml(url.pathname + "?wiki=" + encodeURIComponent(w.id)) + "\">" + escapeHtml(w.name) + "</a></li>").join("") + "</ul>");
		return;
	}
	const wiki = matches[0];
	try {
		await ensureRunning(wiki.id);
	} catch (e) {
		routerPage(res, 500, "Could not start “" + wiki.name + "”", "<p>" + escapeHtml(e.message) + "</p>");
		return;
	}
	res.writeHead(302, { Location: wikiUrl(wiki.id) + (link.title ? "#" + encodeURIComponent(link.title) : "") });
	res.end();
}

// (Re)starts the router as the settings say: always while http links are copied, otherwise if asked for
function startRouter() {
	const settings = linkSettings();
	const port = settings.router || settings.style === "http" ? settings.port : null;
	if (router && router.port === port) {
		return;
	}
	if (router) {
		router.server.close();
		router = null;
	}
	routerError = null;
	if (!port) {
		return;
	}
	const server = http.createServer((req, res) => {
		answerRouter(req, res).catch(e => routerPage(res, 500, "Error", "<p>" + escapeHtml(e.message) + "</p>"));
	});
	server.on("error", e => {
		routerError = e.code === "EADDRINUSE" ? "Port " + port + " is in use by another program." : e.message;
		router = null;
		pushState();
	});
	server.listen(port, "127.0.0.1");
	router = { server, port };
}

// Only the installed app registers twdesk:// (for the current user, no admin rights): a registration from a
// development or test run would point at that copy
function registerScheme() {
	if (!app.isPackaged) {
		return;
	}
	try {
		if (linkSettings().scheme) {
			app.setAsDefaultProtocolClient(links.SCHEME);
		} else if (app.isDefaultProtocolClient(links.SCHEME)) {
			app.removeAsDefaultProtocolClient(links.SCHEME);
		}
	} catch (e) {
		console.error("Could not register " + links.SCHEME + "://:", e);
	}
}

function linkState() {
	return Object.assign(linkSettings(), {
		schemeStatus: !app.isPackaged ? "dev" : app.isDefaultProtocolClient(links.SCHEME) ? "registered" : "not registered",
		routerRunning: !!router,
		routerError
	});
}

// twdesk:// links from other programs arrive as a command-line argument (Windows, Linux) or via open-url (macOS)
function followArgv(argv) {
	const url = (argv || []).find(arg => /^twdesk:\/\//i.test(arg));
	const link = url ? links.parseLink(url, linkSettings().port) : null;
	if (link && link.key) {
		followLink(link.key, link.title, "another program").catch(e => linkMessage("Could not open the link.", e.message));
		return true;
	}
	return false;
}

// ---------- export / import of the setup (src/setup.js) ----------

let pendingSetup = null; // { file, setup } between opening a setup file and importing it

// Repository root, remote URL and branch of a folder, or null (no git, not a repository)
async function folderGitInfo(folder) {
	if (gitState.version === undefined) {
		gitState.version = await git.version();
	}
	const root = gitState.version ? await git.repoRoot(folder) : null;
	if (!root) {
		return null;
	}
	const status = await git.status(root);
	// The branch on the remote ("origin/main" -> "main"), else the local one
	const branch = status.upstream ? status.upstream.split("/").slice(1).join("/") : status.branch;
	// Git spells the root its own way (long names, case, resolved links); keep the folder's spelling for the paths
	let sameSpelling = root;
	try {
		const up = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(folder));
		if (!up.startsWith("..") && !path.isAbsolute(up)) {
			sameSpelling = up ? path.resolve(folder, ...up.split(path.sep).map(() => "..")) : path.resolve(folder);
		}
	} catch (e) {
		// keep git's spelling
	}
	return { root: sameSpelling, url: status.remoteUrl, branch };
}

// The managed wiki folders and those they include, for the chosen wikis
function setupFolders(wikis) {
	const folders = new Map();
	for (const wiki of wikis) {
		folders.set(folderKey(wiki.path), path.resolve(wiki.path));
		for (const include of readIncludes(wiki.path).includes) {
			if (include.exists) {
				folders.set(folderKey(include.resolved), include.resolved);
			}
		}
	}
	return [...folders.values()];
}

ipcMain.handle("setup-export-info", async () => {
	const included = setupFolders(config.wikis).filter(f => !config.wikis.some(w => folderKey(w.path) === folderKey(f)));
	const gitOf = new Map();
	for (const folder of setupFolders(config.wikis)) {
		gitOf.set(folderKey(folder), await folderGitInfo(folder).catch(() => null));
	}
	const store = plugins.listStore();
	return {
		wikis: config.wikis.map(w => ({ id: w.id, name: w.name, path: w.path, git: gitOf.get(folderKey(w.path)) || null })),
		included: included.map(f => ({ path: f, git: gitOf.get(folderKey(f)) || null })),
		webWikis: config.webWikis.map(l => {
			let size = 0;
			try {
				size = l.snapshot ? fs.statSync(snapshotFile(l.id)).size : 0;
			} catch (e) {
				// no snapshot file
			}
			return { id: l.id, name: l.name, url: l.url, snapshot: l.snapshot ? l.snapshot.date : null, size };
		}),
		store: store.length,
		libraries: config.libraries.length
	};
});

// Store plugins as plugin tiddlers; ones TW Desk can't read back are left out (their titles go to skipped)
function storeForExport(skipped) {
	const result = [];
	for (const plugin of plugins.listStore()) {
		try {
			const stored = plugins.readStorePlugin(plugin.kind, plugin.name);
			result.push({ fields: stored.fields, library: stored.meta.library });
		} catch (e) {
			skipped.push(plugin.title);
		}
	}
	return result;
}

// choices: { wikis: [ids], webWikis: [ids], store, snapshots, libraries, settings }
ipcMain.handle("setup-export", async (event, choices) => {
	const wikis = config.wikis.filter(w => choices.wikis.includes(w.id));
	const links = config.webWikis.filter(l => choices.webWikis.includes(l.id));
	const skipped = [];
	const folders = [];
	for (const folder of setupFolders(wikis)) {
		folders.push({ path: folder, git: await folderGitInfo(folder).catch(() => null) });
	}
	const setupData = setup.buildSetup({
		app: app.getVersion(),
		tiddlywiki: TW_VERSION,
		platform: process.platform,
		key: part => (CASE_INSENSITIVE_PATHS ? part.toLowerCase() : part),
		groups: config.groups,
		wikis,
		folders,
		webWikis: links.map(link => {
			let html = null;
			if (choices.snapshots && link.snapshot) {
				try {
					html = fs.readFileSync(snapshotFile(link.id), "utf8");
				} catch (e) {
					// exported without; the importer downloads it again
				}
			}
			return { link, html };
		}),
		store: choices.store ? storeForExport(skipped) : null,
		libraries: choices.libraries ? config.libraries : null,
		settings: choices.settings ? { basePort: config.basePort, git: gitSettings(), webCheck: webCheckEnabled(), links: linkSettings() } : null
	});
	const result = await dialog.showSaveDialog(managerWindow, {
		title: "Export setup",
		defaultPath: path.join(app.getPath("documents"), "tw-desk-setup.json"),
		filters: [{ name: "TW Desk setup", extensions: ["json"] }]
	});
	if (result.canceled || !result.filePath) {
		return null;
	}
	fs.writeFileSync(result.filePath, JSON.stringify(setupData, null, 1));
	return { file: result.filePath, wikis: setupData.wikis.length, folders: setupData.folders.length, webWikis: setupData.webWikis.length, store: (setupData.store || []).length, skipped };
});

ipcMain.handle("setup-open", async () => {
	const picked = await dialog.showOpenDialog(managerWindow, { title: "Import setup", properties: ["openFile"], filters: [{ name: "TW Desk setup", extensions: ["json"] }] });
	if (picked.canceled || !picked.filePaths[0]) {
		return null;
	}
	const file = picked.filePaths[0];
	const data = setup.readSetup(fs.readFileSync(file, "utf8"));
	pendingSetup = { file, setup: data };
	const originBase = data.origin.base;
	return {
		file,
		exported: data.exported,
		app: data.app,
		originBase,
		// Same place as on the exporting computer, if that exists here
		base: originBase && path.isAbsolute(originBase) && fs.existsSync(originBase) ? path.resolve(originBase) : null,
		relative: data.folders.some(f => typeof f.folder === "string")
	};
});

function importPlan(base) {
	if (!pendingSetup) {
		throw new Error("Open a setup file first.");
	}
	return setup.planImport(pendingSetup.setup, base ? path.resolve(base) : null, {
		key: folderKey,
		wikis: config.wikis,
		webWikis: config.webWikis,
		groups: config.groups,
		libraries: config.libraries,
		store: plugins.listStore(),
		bundled: plugins.listBundled(),
		compareVersions: plugins.compareVersions,
		parseTitle: plugins.parseTitle
	});
}

ipcMain.handle("setup-plan", (event, base) => importPlan(base));

function importSettings(settings) {
	if (validPort(Number(settings.basePort))) {
		config.basePort = Number(settings.basePort);
	}
	const gitInput = settings.git || {};
	const interval = Number(gitInput.interval);
	const staleHours = Number(gitInput.staleHours);
	config.git = Object.assign({}, gitSettings(), {
		interval: Number.isInteger(interval) && (interval === 0 || interval >= 30) ? interval : gitSettings().interval,
		fetch: gitInput.fetch === undefined ? gitSettings().fetch : !!gitInput.fetch,
		staleHours: staleHours > 0 ? staleHours : gitSettings().staleHours,
		autoCommitOnStop: !!gitInput.autoCommitOnStop
	});
	if (settings.webCheck !== undefined) {
		config.webCheck = !!settings.webCheck;
	}
	const linkInput = settings.links;
	if (linkInput && typeof linkInput === "object") {
		const current = linkSettings();
		const port = Number(linkInput.port);
		config.links = {
			style: linkInput.style === "http" ? "http" : "scheme",
			port: validPort(port) && !config.wikis.some(w => w.fixedPort === port) ? port : current.port,
			router: !!linkInput.router,
			scheme: linkInput.scheme === undefined ? current.scheme : !!linkInput.scheme,
			plugin: linkInput.plugin === undefined ? current.plugin : !!linkInput.plugin
		};
	}
}

// choices: { folders: [plan ids], webWikis: [plan ids], store, libraries, settings }. Returns [{ ok, text }]
async function runImport(base, choices) {
	const plan = importPlan(base);
	const data = pendingSetup.setup;
	const report = [];
	const done = text => report.push({ ok: true, text });
	const failed = text => report.push({ ok: false, text });
	const chosen = plan.folders.filter(f => choices.folders.includes(f.id) && (f.action === "register" || f.action === "clone"));

	// Repositories first (one clone per repository, even if it holds several wikis)
	const clones = new Map();
	for (const item of chosen.filter(f => f.action === "clone")) {
		clones.set(folderKey(item.repoPath), item);
	}
	if (clones.size && gitState.version === undefined) {
		gitState.version = await git.version();
	}
	for (const item of clones.values()) {
		if (!gitState.version) {
			failed("Git isn't installed, so " + item.url + " wasn't cloned.");
			continue;
		}
		try {
			await git.clone(item.url, item.repoPath, item.branch);
			done("Cloned " + item.url + " into " + item.repoPath + ".");
		} catch (e) {
			failed("Could not clone " + item.url + ":\n" + e.message);
		}
	}

	// Groups by name, then the wikis
	const groupId = name => {
		if (!name) {
			return null;
		}
		let group = config.groups.find(g => g.name === name);
		if (!group) {
			const exported = data.groups.find(g => g.name === name) || {};
			group = { id: crypto.randomUUID(), name };
			if (exported.collapsed) {
				group.collapsed = true;
			}
			config.groups.push(group);
		}
		return group.id;
	};
	for (const item of chosen.filter(f => f.wiki)) {
		if (!setup.isWikiFolder(item.path)) {
			failed("“" + item.name + "” wasn't added: no wiki in " + item.path + ".");
			continue;
		}
		if (config.wikis.some(w => folderKey(w.path) === folderKey(item.path))) {
			continue;
		}
		const entry = data.wikis.find(w => folderKey(setup.resolvePlace(w, plan.base) || "") === folderKey(item.path));
		const wiki = { id: crypto.randomUUID(), name: entry.name, path: item.path, autostart: !!entry.autostart };
		for (const key of ["description", "linkName", "importedFrom", "copiedFrom"]) {
			if (entry[key]) {
				wiki[key] = entry[key];
			}
		}
		let note = "";
		if (entry.fixedPort) {
			const clash = config.wikis.find(w => w.fixedPort === entry.fixedPort);
			if (validPort(entry.fixedPort) && !clash) {
				wiki.fixedPort = entry.fixedPort;
			} else if (clash) {
				note = " Its fixed port " + entry.fixedPort + " belongs to “" + clash.name + "” here, so it gets an automatic port.";
			}
		}
		const group = groupId(entry.group);
		if (group) {
			wiki.group = group;
		}
		config.wikis.push(wiki);
		done("Added the wiki “" + wiki.name + "” (" + item.path + ")." + note);
	}
	for (const item of plan.folders.filter(f => !f.wiki && choices.folders.includes(f.id) && f.action === "clone")) {
		if (!setup.isWikiFolder(item.path)) {
			failed("The included folder " + item.path + " is still missing.");
		}
	}

	// Web wikis before the store: store plugins from a showcase refer to its link
	const linkIds = new Map(); // id in the file -> new id
	for (const item of plan.webWikis.filter(l => choices.webWikis.includes(l.id) && l.action === "add")) {
		const entry = data.webWikis[item.id];
		const link = { id: crypto.randomUUID(), name: String(entry.name || new URL(entry.url).host), url: entry.url };
		if (entry.description) {
			link.description = String(entry.description);
		}
		if (entry.showcase) {
			link.showcase = true;
		}
		if (Array.isArray(entry.linkedPlugins) && entry.linkedPlugins.length) {
			link.linkedPlugins = entry.linkedPlugins.map(String).sort();
		}
		if (entry.id) {
			linkIds.set(entry.id, link.id);
		}
		config.webWikis.push(link);
		let how = "";
		if (entry.snapshotHtml) {
			const buffer = Buffer.from(String(entry.snapshotHtml), "utf8");
			const index = web.indexOf(buffer);
			fs.mkdirSync(webDir(link.id), { recursive: true });
			fs.writeFileSync(snapshotFile(link.id), buffer);
			// Later checks tell whether the site changed since this snapshot
			writeBaseline(link, {}, index);
			const date = entry.snapshot && entry.snapshot.date ? entry.snapshot.date : new Date().toISOString();
			link.snapshot = { date, size: index.size, tiddlers: index.tiddlers ? Object.keys(index.tiddlers).length : null, twVersion: index.twVersion };
			how = " with its snapshot of " + date.slice(0, 10);
			queueWeb(link.id, "checking", () => checkWebWiki(link.id)).catch(() => {});
		} else if (entry.snapshot) {
			how = "; its snapshot is being downloaded again";
			queueWeb(link.id, "saving", () => saveSnapshot(link.id)).catch(() => {});
		} else {
			queueWeb(link.id, "checking", () => checkWebWiki(link.id)).catch(() => {});
		}
		done("Added the web wiki “" + link.name + "”" + how + ".");
	}

	if (choices.store) {
		let count = 0;
		for (const item of plan.store.filter(p => p.action === "add" || p.action === "update")) {
			const entry = data.store[item.id];
			let library = entry.library ? String(entry.library) : null;
			if (library && library.startsWith(SHOWCASE_PREFIX)) {
				const id = linkIds.get(library.slice(SHOWCASE_PREFIX.length));
				library = id ? SHOWCASE_PREFIX + id : null;
			}
			try {
				plugins.writeToStore(entry.fields, library ? { library } : {});
				count++;
			} catch (e) {
				failed("Plugin " + item.title + " wasn't put into the store: " + e.message);
			}
		}
		if (count) {
			done("Put " + count + (count === 1 ? " plugin" : " plugins") + " into the store.");
		}
	}

	if (choices.libraries) {
		const added = plan.libraries.filter(l => l.action === "add");
		for (const library of added) {
			config.libraries.push({ url: library.url, type: library.type === "cpl" ? "cpl" : "tiddlywiki" });
		}
		if (added.length) {
			done("Added " + added.length + (added.length === 1 ? " plugin library." : " plugin libraries."));
		}
	}

	if (choices.settings && plan.settings) {
		importSettings(plan.settings);
		done("Applied the settings (start port " + config.basePort + ").");
		scheduleGitChecks();
		scheduleWebChecks();
		startRouter();
		registerScheme();
	}

	saveConfig();
	pushState();
	checkGit({ fetch: false });
	if (!report.length) {
		done("Nothing to import.");
	}
	return report;
}

ipcMain.handle("setup-import", (event, base, choices) => runImport(base, choices));

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
	app.on("second-instance", (event, argv) => {
		// A link opens its wiki's window; otherwise starting TW Desk again shows the manager
		if (!followArgv(argv) && managerWindow) {
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
		scheduleGitChecks();
		checkGit({ fetch: gitSettings().fetch });
		scheduleWebChecks();
		startRouter();
		registerScheme();
		followArgv(process.argv);
	});

	app.on("open-url", (event, url) => {
		event.preventDefault();
		app.whenReady().then(() => followArgv([url]));
	});

	app.on("before-quit", () => {
		quitting = true;
		for (const id of servers.keys()) {
			stopWiki(id);
		}
	});
}

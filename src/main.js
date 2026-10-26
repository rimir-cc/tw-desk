"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess, clipboard } = require("electron");
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const plugins = require("./plugins");
const git = require("./git");

const DEFAULT_BASE_PORT = 8090;
// Windows and (by default) macOS don't distinguish upper and lower case in paths
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";
const MAX_LOG_LINES = 500;

// Each TiddlyWiki command runs in an Electron utility process (a Node.js child process managed by Electron),
// so no separate Node install is needed.
const TW_PROCESS = path.join(__dirname, "tw-process.js");
const TW_VERSION = require("tiddlywiki/package.json").version;

let managerWindow = null;
let config = { basePort: DEFAULT_BASE_PORT, groups: [], wikis: [] };
const servers = new Map(); // wiki id -> { child, status, logs, error }
const wikiWindows = new Map(); // wiki id -> BrowserWindow
let quitting = false;

// ---------- config ----------

function configPath() {
	return path.join(app.getPath("userData"), "config.json");
}

function loadConfig() {
	try {
		config = Object.assign({ basePort: DEFAULT_BASE_PORT, groups: [], wikis: [] }, JSON.parse(fs.readFileSync(configPath(), "utf8")));
	} catch (e) {
		if (e.code !== "ENOENT") {
			dialog.showErrorBox("TW Desk", "Could not read " + configPath() + ":\n" + e.message);
		}
	}
	if (!Array.isArray(config.groups)) {
		config.groups = [];
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
	const existing = config.wikis.find(w => w.id === input.id);
	if (existing && existing.lastPort) {
		wiki.lastPort = existing.lastPort;
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
		wikis: config.wikis.map(w => Object.assign({}, w, { group: groupOf(w) }, serverState(w.id), { port: activePort(w.id), url: wikiUrl(w.id) }, readIncludes(w.path)))
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
	const child = runTiddlyWiki([wiki.path, "--listen", "host=127.0.0.1", "port=" + port], "TiddlyWiki " + wiki.name);
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

async function openWiki(id, external) {
	const wiki = findWiki(id);
	if (serverState(id).status !== "running") {
		await startWiki(id);
		await waitForRunning(id, 60000);
	}
	const url = wikiUrl(id);
	if (external) {
		await shell.openExternal(url);
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
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		if (!target.startsWith(url)) {
			shell.openExternal(target);
			return { action: "deny" };
		}
		return { action: "allow" };
	});
	win.webContents.on("will-navigate", (event, target) => {
		if (!target.startsWith(url)) {
			event.preventDefault();
			shell.openExternal(target);
		}
	});
	win.on("page-title-updated", (event, title) => {
		event.preventDefault();
		win.setTitle(wiki.name + " — " + title);
	});
	win.on("closed", () => wikiWindows.delete(id));
	wikiWindows.set(id, win);
	win.loadURL(url);
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

// State tiddlers of the HTML wiki that make no sense in a folder wiki
const HTML_SKIP_FILTER = "[all[tiddlers]] -[[$:/StoryList]] -[[$:/HistoryList]] -[[$:/isEncrypted]] -[[$:/status/RequireReloadDueToPluginChange]] -[prefix[$:/temp/]]";

// --savewikifolder references plugins from the official library by name (so the bundled versions are used) and,
// with explodePlugins=no, saves other plugins as single files in tiddlers/, where the Plugins window can move them to the store.
async function convertHtmlWiki(htmlFile, folder) {
	const html = fs.readFileSync(htmlFile, "utf8");
	if (html.includes("id=\"encryptedStoreArea\"")) {
		throw new Error("This wiki is password-protected and can't be converted. Open it in a browser, clear the password (Tools → Set password / Saving), save it, and try again.");
	}
	// TiddlyWiki 5.2+ keeps tiddlers in JSON script blocks, older versions in a storeArea div
	if (!html.includes("tiddlywiki-tiddler-store") && !html.includes("id=\"storeArea\"")) {
		throw new Error("This doesn't look like a TiddlyWiki file: " + htmlFile);
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

// Creates a new wiki folder (empty, converted from a single-file HTML wiki, or copied from another wiki) and adds it to the list
async function createWiki(input) {
	const folderName = (input.folderName || "").trim();
	if (!folderName || /[\\/:*?"<>|]/.test(folderName) || /^\.+$/.test(folderName)) {
		throw new Error("Please enter a valid folder name (without \\ / : * ? \" < > |).");
	}
	if (!input.parent || !fs.existsSync(path.resolve(input.parent))) {
		throw new Error("The folder to create the wiki in doesn't exist: " + (input.parent || "(none)"));
	}
	const htmlFile = input.htmlFile ? path.resolve(input.htmlFile) : null;
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
		if (htmlFile) {
			await convertHtmlWiki(htmlFile, folder);
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
	config.basePort = basePort;
	config.git = { interval, fetch: !!input.gitFetch, staleHours, autoCommitOnStop: !!input.gitAutoCommit };
	saveConfig();
	scheduleGitChecks();
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
		scheduleGitChecks();
		checkGit({ fetch: gitSettings().fetch });
	});

	app.on("before-quit", () => {
		quitting = true;
		for (const id of servers.keys()) {
			stopWiki(id);
		}
	});
}

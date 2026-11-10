"use strict";

// Fixtures for the end-to-end tests. Each test gets its own TW Desk, started from source with a throwaway
// user-data folder (TW_DESK_USER_DATA) and its own copies of small test wikis – never the user's wikis or config.
// Native dialogs and the shell (browser, file manager, trash) are replaced in the main process (stubMainProcess()),
// confirm() and alert() in the page (launch()).

const { test: base, expect, _electron } = require("@playwright/test");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { GIT_ENV, sh } = require("../helpers/git-env");
const tw = require("../helpers/tw");
const { startServer } = require("../helpers/server");
const dataFolder = require("../../src/data-folder");

const ROOT = path.resolve(__dirname, "..", "..");
// Away from the user's TW Desk (8090/8091) and the 8080 of other tools
const BASE_PORT = 18390;

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Runs inside TW Desk's main process (serialized by Playwright, so no closures)
function stubMainProcess({ dialog, shell, clipboard }) {
	const calls = globalThis.twDeskTest = { picks: [], saves: [], answers: [], questions: [], opened: [], shown: [], trashed: [], copied: [], errors: [] };
	dialog.showErrorBox = (title, message) => {
		calls.errors.push(title + ": " + message);
	};
	// Not the user's clipboard
	clipboard.writeText = text => {
		calls.copied.push(text);
	};
	// Message boxes are answered from answers (button index); without one: the cancel button
	dialog.showMessageBoxSync = (win, options) => {
		const box = options || win;
		calls.questions.push(box.message);
		return calls.answers.length ? calls.answers.shift() : box.cancelId;
	};
	dialog.showOpenDialog = async () => {
		const next = calls.picks.shift();
		return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
	};
	dialog.showSaveDialog = async () => {
		const next = calls.saves.shift();
		return next ? { canceled: false, filePath: next } : { canceled: true };
	};
	shell.openExternal = async url => {
		calls.opened.push(url);
	};
	shell.openPath = async target => {
		calls.shown.push(target);
		return "";
	};
	shell.showItemInFolder = target => {
		calls.shown.push(target);
	};
	shell.trashItem = async target => {
		calls.trashed.push(target);
	};
}

class Desk {
	constructor(root, server, templates, testInfo) {
		this.root = root;
		this.server = server;
		this.templates = templates;
		this.testInfo = testInfo;
		this.userData = path.join(root, "userdata");
		this.wikisDir = path.join(root, "wikis");
		this.app = null;
		this.page = null;
		this.output = [];
		this.dialogs = [];
		fs.mkdirSync(this.wikisDir, { recursive: true });
	}

	// A fresh copy of a template wiki ("alpha" or "shared") in this test's folder
	wiki(folderName, template = folderName) {
		const target = path.join(this.wikisDir, folderName);
		fs.cpSync(path.join(this.templates, template), target, { recursive: true });
		return target;
	}

	// Starts TW Desk. config: parts of config.json; wikis may leave out their id.
	// options: dataEnv (default true: the data folder is TW_DESK_DATA = this.dataDir, by default the user-data folder),
	// writeConfig (default true), env (more environment variables)
	async launch(config = {}, options = {}) {
		this.launchOptions = options;
		const full = Object.assign({
			basePort: BASE_PORT,
			groups: [],
			wikis: [],
			webWikis: [],
			libraries: [
				{ url: this.server.libraryUrl, type: "tiddlywiki" },
				{ url: this.server.cplUrl, type: "cpl" }
			],
			git: { interval: 0, fetch: false, staleHours: 24, autoCommitOnStop: false },
			webCheck: false
		}, config);
		full.wikis = full.wikis.map(w => Object.assign({ id: crypto.randomUUID(), autostart: false }, w));
		fs.mkdirSync(this.userData, { recursive: true });
		const dataEnv = options.dataEnv !== false;
		if (options.writeConfig !== false) {
			const target = dataEnv ? this.dataDir : this.userData;
			fs.mkdirSync(target, { recursive: true });
			fs.writeFileSync(path.join(target, "config.json"), JSON.stringify(full, null, 2));
		}

		// GIT_ENV: the app's git uses an empty global config and a test identity, not the user's settings
		const env = Object.assign({}, process.env, GIT_ENV, { TW_DESK_USER_DATA: this.userData, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, dataEnv ? { TW_DESK_DATA: this.dataDir } : {}, options.env || {});
		if (!dataEnv) {
			delete env.TW_DESK_DATA;
		}
		delete env.ELECTRON_RUN_AS_NODE;
		this.app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
		const child = this.app.process();
		child.stdout.on("data", data => this.output.push(data.toString()));
		child.stderr.on("data", data => this.output.push(data.toString()));
		await this.app.context().tracing.start({ screenshots: true, snapshots: true });
		await this.app.evaluate(stubMainProcess);
		this.page = await this.app.firstWindow();
		// Electron shows confirm() and alert() as native windows Playwright doesn't see: replace them in the page.
		// confirm() questions are answered with OK; an alert() means an error was shown (see finish())
		await this.page.waitForLoadState("domcontentloaded");
		await this.page.evaluate(() => {
			window.testDialogs = [];
			window.confirm = message => {
				window.testDialogs.push({ type: "confirm", message });
				return true;
			};
			window.alert = message => {
				window.testDialogs.push({ type: "alert", message });
			};
		});
		await expect(this.page.locator("#tw-version")).not.toBeEmpty();
		return this.page;
	}

	// ---------- reading state ----------

	state() {
		return this.page.evaluate(() => window.twDesk.getState());
	}

	// The data folder TW Desk uses (the user-data folder unless set with useDataDir())
	get dataDir() {
		return this.customDataDir || this.userData;
	}

	useDataDir(dir) {
		this.customDataDir = dir;
	}

	// config.json and local.json as TW Desk sees them (absolute paths, local values merged in)
	config() {
		const pointer = dataFolder.readPointer(this.userData);
		const dir = this.launchOptions && this.launchOptions.dataEnv === false ? pointer || this.userData : this.dataDir;
		let local = {};
		try {
			local = JSON.parse(fs.readFileSync(path.join(this.userData, "local.json"), "utf8"));
		} catch (e) {
			// none yet
		}
		return dataFolder.mergeLocal(dataFolder.resolveConfigPaths(this.rawConfig(dir), dir), local);
	}

	// The config.json file as written
	rawConfig(dir = this.dataDir) {
		// TW Desk may be replacing the file right now (on Windows the rename can fall back to rewriting it)
		for (let attempt = 1; ; attempt++) {
			try {
				return JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
			} catch (e) {
				if (attempt === 5) {
					throw e;
				}
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
			}
		}
	}

	async wikiState(name) {
		return (await this.state()).wikis.find(w => w.name === name);
	}

	// What the stubbed shell and dialogs were asked to do
	mainCalls() {
		return this.app.evaluate(() => globalThis.twDeskTest);
	}

	// confirm()/alert() calls so far, and forgets them (so an expected error message doesn't fail the test)
	takeDialogs() {
		return this.page.evaluate(() => window.testDialogs.splice(0));
	}

	// Next answer of a message box (index of the button)
	answer(index) {
		return this.app.evaluate((electron, button) => globalThis.twDeskTest.answers.push(button), index);
	}

	// Next answer of the save dialog
	saveAs(file) {
		return this.app.evaluate((electron, target) => globalThis.twDeskTest.saves.push(target), file);
	}

	// Ends this TW Desk and starts a new one with an empty user-data folder ("another computer"); config as in launch()
	async relaunchFresh(config = {}) {
		this.dialogs = this.dialogs.concat((await this.page.evaluate(() => window.testDialogs).catch(() => null)) || []);
		await this.app.context().tracing.stop();
		await this.app.close();
		this.userData = path.join(this.root, "userdata-" + crypto.randomUUID().slice(0, 8));
		this.customDataDir = null;
		return this.launch(config);
	}

	// Ends this TW Desk and starts it again with the same user-data folder
	async relaunch(config = {}, options = {}) {
		this.dialogs = this.dialogs.concat((await this.page.evaluate(() => window.testDialogs).catch(() => null)) || []);
		await this.app.context().tracing.stop();
		await this.app.close();
		return this.launch(config, options);
	}

	// Quits TW Desk the way the user does (closing the main window), and waits until it has exited
	async quit() {
		this.dialogs = this.dialogs.concat((await this.page.evaluate(() => window.testDialogs).catch(() => null)) || []);
		await this.app.context().tracing.stop();
		const exited = new Promise(resolve => this.app.process().once("exit", resolve));
		await this.page.evaluate(() => window.close()).catch(() => {});
		await exited;
		this.app = null;
	}

	// Next answer of the folder/file picker
	pick(file) {
		return this.app.evaluate((electron, picked) => globalThis.twDeskTest.picks.push(picked), file);
	}

	// ---------- the main window ----------

	// The row of the wiki with exactly this name (the name may be followed by its git chip "⎇ …" and binary chip "▣ …")
	row(name) {
		return this.page.locator("li.wiki:not(.web-link)").filter({ has: this.page.locator(".wiki-name", { hasText: new RegExp("^" + escapeRegExp(name) + "(\\s*[⎇▣].*)?$") }) });
	}

	groupHeader(name) {
		return this.page.locator("li.group-header:not(.web-header)").filter({ has: this.page.locator(".group-toggle", { hasText: new RegExp("^[▾▸] " + escapeRegExp(name) + "$") }) });
	}

	async addGroup(name) {
		await this.newMenu("Group…");
		await this.page.locator("#group-form [name=name]").fill(name);
		await this.page.locator("#group-form button[type=submit]").click();
		await expect(this.groupHeader(name)).toBeVisible();
	}

	async startWiki(name) {
		const row = this.row(name);
		await row.getByRole("button", { name: "Start", exact: true }).click();
		await expect(row.locator(".wiki-meta")).toContainText("running", { timeout: 60000 });
		return (await this.wikiState(name)).port;
	}

	async stopWiki(name) {
		const row = this.row(name);
		await row.getByRole("button", { name: "Stop", exact: true }).click();
		await expect(row.locator(".wiki-meta")).toContainText("stopped");
	}

	// Saves a tiddler through the wiki's server, as the wiki in its window would
	async saveTiddler(port, title, text) {
		const response = await this.http(port, "/recipes/default/tiddlers/" + encodeURIComponent(title), {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title, text })
		});
		expect(response.status).toBeLessThan(300);
	}

	webRow(name) {
		return this.page.locator("li.web-link").filter({ has: this.page.locator(".wiki-name", { hasText: new RegExp("^" + escapeRegExp(name)) }) });
	}

	// Until no web wiki is being checked or downloaded (their menu items are disabled meanwhile)
	async webIdle() {
		await expect.poll(async () => (await this.state()).webWikis.filter(l => l.busy).length).toBe(0);
	}

	// An open menu doesn't update, so wait for running web tasks before opening one
	async rowMenu(row, item) {
		await this.webIdle();
		await row.locator("button.more").click();
		await this.page.getByRole("menuitem", { name: item, exact: true }).click();
	}

	async newMenu(item) {
		await this.page.locator("#new-menu").click();
		await this.page.getByRole("menuitem", { name: item, exact: true }).click();
	}

	// Runs action and returns the app window it opens
	async windowOpenedBy(action) {
		const [win] = await Promise.all([this.app.waitForEvent("window"), action()]);
		await win.waitForLoadState("domcontentloaded");
		return win;
	}

	// ---------- talking to a wiki's server ----------

	async http(port, urlPath, options = {}) {
		const headers = Object.assign({ "X-Requested-With": "TiddlyWiki" }, options.headers);
		return fetch("http://127.0.0.1:" + port + urlPath, Object.assign({}, options, { headers }));
	}

	async tiddler(port, title) {
		const response = await this.http(port, "/recipes/default/tiddlers/" + encodeURIComponent(title));
		if (!response.ok) {
			return null;
		}
		// TiddlyWeb format: fields other than the standard ones (e.g. version, list) are nested in "fields"
		const tiddler = await response.json();
		const flat = Object.assign({}, tiddler.fields, tiddler);
		delete flat.fields;
		return flat;
	}

	// ---------- end of the test ----------

	async finish(failed) {
		if (!this.app) {
			return;
		}
		const info = this.testInfo;
		this.dialogs = this.dialogs.concat((await this.page.evaluate(() => window.testDialogs).catch(() => null)) || []);
		try {
			if (failed) {
				for (const [index, win] of this.app.windows().entries()) {
					await win.screenshot({ path: info.outputPath("window-" + index + ".png") }).catch(() => {});
				}
				const trace = info.outputPath("trace.zip");
				await this.app.context().tracing.stop({ path: trace });
				await info.attach("trace", { path: trace, contentType: "application/zip" });
			} else {
				await this.app.context().tracing.stop();
			}
		} finally {
			const log = info.outputPath("main-process.log");
			fs.writeFileSync(log, this.output.join(""));
			if (failed) {
				await info.attach("main-process.log", { path: log, contentType: "text/plain" });
			}
			const closing = this.app.close();
			const timeout = new Promise(resolve => setTimeout(resolve, 15000, "timeout"));
			if ((await Promise.race([closing, timeout])) === "timeout") {
				this.app.process().kill();
			}
		}
		const alerts = this.dialogs.filter(d => d.type === "alert");
		if (!failed && alerts.length) {
			throw new Error("TW Desk showed an error: " + alerts.map(d => d.message).join("\n"));
		}
	}
}

const test = base.extend({
	// The test web server: plugin libraries and web wikis (one per worker)
	server: [async ({}, use) => {
		const server = await startServer();
		await use(server);
		await server.close();
	}, { scope: "worker" }],

	// Template wiki folders, made once with the bundled TiddlyWiki and copied by desk.wiki()
	templates: [async ({}, use) => {
		const dir = tw.tempDir("tw-desk-templates-");
		const alpha = tw.initWiki(path.join(dir, "alpha"));
		tw.writeTiddler(alpha, "Hello", "Hello from alpha");
		const shared = tw.initWiki(path.join(dir, "shared"));
		tw.writeTiddler(shared, "SharedNote", "Shared by every wiki that includes this folder");
		await use(dir);
		fs.rmSync(dir, { recursive: true, force: true });
	}, { scope: "worker" }],

	desk: async ({ server, templates }, use, testInfo) => {
		const desk = new Desk(tw.tempDir("tw-desk-e2e-"), server, templates, testInfo);
		await use(desk);
		try {
			await desk.finish(testInfo.status !== testInfo.expectedStatus);
		} finally {
			// Windows may hold files of just-ended processes for a moment
			fs.rmSync(desk.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
		}
	}
});

module.exports = { test, expect, BASE_PORT, tw, sh };

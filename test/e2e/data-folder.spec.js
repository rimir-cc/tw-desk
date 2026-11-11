"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./fixtures");

// ---------- the data folder in use ----------

test("data folder: using the app leaves config.json alone; local values go to local.json", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const before = desk.rawConfig();
	const port = await desk.startWiki("Alpha");
	await desk.stopWiki("Alpha");
	await expect.poll(() => {
		try {
			return Object.values(JSON.parse(fs.readFileSync(path.join(desk.userData, "local.json"), "utf8")).wikis)[0].lastPort;
		} catch (e) {
			return null;
		}
	}).toBe(port);
	expect(desk.rawConfig().wikis[0].lastPort).toBeUndefined();
	expect(desk.config().wikis[0].lastPort).toBe(port);
	expect(desk.rawConfig()).toEqual(before);
});

test("data folder: wiki paths are stored relative to it", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	await desk.addGroup("Work");
	await expect.poll(() => desk.rawConfig().wikis[0].path).toBe("../wikis/alpha");
	expect(desk.config().wikis[0].path).toBe(alpha);
});

test("data folder: a broken config.json is reported and not overwritten", async ({ desk }) => {
	fs.mkdirSync(desk.userData, { recursive: true });
	fs.writeFileSync(path.join(desk.userData, "config.json"), "{ broken");
	await desk.launch({}, { writeConfig: false });
	await expect(desk.page.locator("#config-error")).toContainText("Could not read");
	await desk.addGroup("Work");
	expect(fs.readFileSync(path.join(desk.userData, "config.json"), "utf8")).toBe("{ broken");
});

test("data folder: the plugin store lives in it, not in the user-data folder", async ({ desk }) => {
	desk.useDataDir(path.join(desk.root, "data"));
	await desk.launch({});
	expect(fs.existsSync(path.join(desk.root, "data", "store", "plugins"))).toBe(true);
	expect(fs.existsSync(path.join(desk.userData, "store"))).toBe(false);
	expect(fs.existsSync(path.join(desk.root, "data", "config.json"))).toBe(true);
});

// ---------- choosing the data folder (first start) ----------

const { sh } = require("../helpers/git-env");

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// A data folder as another computer would have it: one wiki "Beta" next to it
function preparedDataFolder(desk) {
	desk.wiki("beta", "alpha");
	const folder = path.join(desk.root, "existing");
	writeJson(path.join(folder, "config.json"), { basePort: 18390, groups: [], webWikis: [], git: { interval: 0, fetch: false, staleHours: 24, autoCommitOnStop: false }, webCheck: false, wikis: [{ id: "beta-id", name: "Beta", path: "../wikis/beta", autostart: false }] });
	return folder;
}

const setupDialog = desk => desk.page.locator("#data-setup-dialog");
const wikiNames = async desk => (await desk.state()).wikis.map(w => w.name);

test("data folder: first start after the update moves the setup into it", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	writeJson(path.join(desk.userData, "store", "plugins", "test", "hello", "plugin.info"), { title: "$:/plugins/test/hello", version: "1.0.0" });
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] }, { dataEnv: false });
	await expect(setupDialog(desk)).toBeVisible();
	await expect(desk.page.locator("#data-setup-text")).toContainText("data folder you choose");
	const target = path.join(desk.root, "tw-desk-data");
	await expect(desk.page.locator("#data-setup-path")).toHaveValue(target);
	await desk.page.locator("#data-setup-create").click();
	await expect(setupDialog(desk)).toBeHidden();
	expect(desk.rawConfig(target).wikis[0].path).toBe("../wikis/alpha");
	expect(fs.existsSync(path.join(target, "store", "plugins", "test", "hello", "plugin.info"))).toBe(true);
	expect(fs.existsSync(path.join(desk.userData, "config.json"))).toBe(false);
	expect(fs.existsSync(path.join(desk.userData, "store"))).toBe(false);
	expect(JSON.parse(fs.readFileSync(path.join(desk.userData, "data-folder.json"), "utf8")).path).toBe(target);
	expect(sh(target, "log", "--format=%s")).toBe("Initial TW Desk data");
	expect(fs.readFileSync(path.join(target, ".gitignore"), "utf8")).toBe("*.tmp\n");
	expect(sh(target, "status", "--porcelain")).toBe("");

	await desk.relaunch({}, { dataEnv: false, writeConfig: false });
	await expect(desk.row("Alpha")).toBeVisible();
	await expect(setupDialog(desk)).toBeHidden();
});

test("data folder: fresh install creates an empty one", async ({ desk }) => {
	await desk.launch({}, { dataEnv: false, writeConfig: false });
	await expect(desk.page.locator("#data-setup-text")).toContainText("Where should TW Desk keep your setup?");
	const target = path.join(desk.root, "data");
	await desk.page.locator("#data-setup-path").fill(target);
	await desk.page.locator("#data-setup-create").click();
	await expect(setupDialog(desk)).toBeHidden();
	expect(desk.rawConfig(target).wikis).toEqual([]);
	expect(JSON.parse(fs.readFileSync(path.join(desk.userData, "data-folder.json"), "utf8")).path).toBe(target);
});

test("data folder: using an existing one replaces the current setup after a warning", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const existing = preparedDataFolder(desk);
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] }, { dataEnv: false });
	await desk.pick(existing);
	await desk.page.locator("#data-setup-existing").click();
	await expect(setupDialog(desk)).toBeHidden();
	const asked = (await desk.takeDialogs()).map(d => d.message).join("\n");
	expect(asked).toContain("Your current 1 wiki");
	expect(asked).toContain("replaced by the setup in " + existing);
	expect(await wikiNames(desk)).toEqual(["Beta"]);
	expect((await desk.wikiState("Beta")).path).toBe(path.join(desk.root, "wikis", "beta"));
	expect(fs.existsSync(path.join(desk.userData, "config.json"))).toBe(false);
	expect(fs.readdirSync(desk.userData).filter(n => n.startsWith("migrated"))).toEqual([]);
});

test("data folder: a new computer uses an existing (cloned) one", async ({ desk }) => {
	const existing = preparedDataFolder(desk);
	await desk.launch({}, { dataEnv: false, writeConfig: false });
	await desk.pick(existing);
	await desk.page.locator("#data-setup-existing").click();
	await expect(setupDialog(desk)).toBeHidden();
	expect(await desk.takeDialogs()).toEqual([]);
	expect(await wikiNames(desk)).toEqual(["Beta"]);
	await desk.addGroup("Work");
	expect(fs.existsSync(path.join(desk.userData, "local.json"))).toBe(true);
});

test("data folder: creating one refuses a folder with other files", async ({ desk }) => {
	const foreign = path.join(desk.root, "foreign");
	fs.mkdirSync(foreign);
	fs.writeFileSync(path.join(foreign, "x.txt"), "x");
	await desk.launch({}, { dataEnv: false, writeConfig: false });
	await desk.page.locator("#data-setup-path").fill(foreign);
	await desk.page.locator("#data-setup-create").click();
	await expect(desk.page.locator("#data-setup-error")).toContainText("isn't empty");
	expect(fs.readdirSync(foreign)).toEqual(["x.txt"]);
	await expect(setupDialog(desk)).toBeVisible();
});

test("data folder: a lost one is asked for again, nothing is created", async ({ desk }) => {
	const gone = path.join(desk.root, "gone");
	writeJson(path.join(desk.userData, "data-folder.json"), { path: gone });
	await desk.launch({}, { dataEnv: false, writeConfig: false });
	await expect(desk.page.locator("#data-setup-text")).toContainText("wasn't found");
	await expect(desk.page.locator("#data-setup-text")).toContainText(gone);
	expect(fs.existsSync(gone)).toBe(false);
});

test("data folder: autostart waits until it is chosen", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha, autostart: true }] }, { dataEnv: false });
	await expect(setupDialog(desk)).toBeVisible();
	await desk.page.waitForTimeout(2000);
	expect((await desk.wikiState("Alpha")).status).not.toBe("running");
	await desk.page.locator("#data-setup-path").fill(path.join(desk.root, "data"));
	await desk.page.locator("#data-setup-create").click();
	await expect(desk.row("Alpha").locator(".wiki-meta")).toContainText("running", { timeout: 60000 });
});

// ---------- Settings → Data folder, header chip, Git tab ----------

function gitRepo(dir) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "README.txt"), "data");
	sh(dir, "init", "--quiet");
	sh(dir, "add", "-A");
	sh(dir, "commit", "--quiet", "-m", "init");
}

async function openSettings(desk) {
	await desk.page.locator("#show-settings").click();
	await expect(desk.page.locator("#settings-dialog")).toBeVisible();
}

test("data folder: move it in Settings", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const old = path.join(desk.root, "p", "q", "data");
	gitRepo(old);
	desk.useDataDir(old);
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	await openSettings(desk);
	await expect(desk.page.locator("#data-folder-path")).toHaveText(old);
	const target = path.join(desk.root, "data2");
	await desk.pick(target);
	await desk.page.locator("#data-move").click();
	await expect(desk.page.locator("#data-folder-path")).toHaveText(target);
	expect(desk.rawConfig(target).wikis[0].path).toBe("../wikis/alpha");
	expect(fs.existsSync(path.join(target, ".git"))).toBe(true);
	expect(JSON.parse(fs.readFileSync(path.join(desk.userData, "data-folder.json"), "utf8")).path).toBe(target);
	const asked = (await desk.takeDialogs()).map(d => d.message).join("\n");
	expect(asked).toContain("Remove the old data folder " + old);
	await expect.poll(() => fs.existsSync(old)).toBe(false);
	expect((await desk.state()).wikis.map(w => w.name)).toEqual(["Alpha"]);
});

test("data folder: moving refuses a folder with files in it", async ({ desk }) => {
	const foreign = path.join(desk.root, "foreign");
	fs.mkdirSync(foreign);
	fs.writeFileSync(path.join(foreign, "x.txt"), "x");
	await desk.launch({});
	await openSettings(desk);
	await desk.pick(foreign);
	await desk.page.locator("#data-move").click();
	await expect(desk.page.locator("#settings-error")).toContainText("isn't empty");
	await expect(desk.page.locator("#data-folder-path")).toHaveText(desk.userData);
	expect(fs.readdirSync(foreign)).toEqual(["x.txt"]);
	desk.takeDialogs();
});

test("data folder: the header chip opens its Git tab", async ({ desk }) => {
	const data = path.join(desk.root, "data");
	gitRepo(data);
	desk.useDataDir(data);
	await desk.launch({});
	const chip = desk.page.locator("#data-chip");
	await expect(chip).toContainText("TW Desk data ⎇ main");
	await chip.click();
	await expect(desk.page.locator("#log-panel")).toBeVisible();
	await expect(desk.page.locator("#log-title")).toHaveText("TW Desk data");
	await expect(desk.page.locator("#git-view .git-repo-title")).toContainText("TW Desk data");
	await expect(desk.page.locator("#git-view").getByRole("button", { name: "Commit" })).toBeVisible();
	await expect(desk.page.locator("[data-panel-tab=log]")).toBeHidden();
});

test("data folder: inside another repository it shows no repository and gets its own", async ({ desk }) => {
	const outer = path.join(desk.root, "outer");
	gitRepo(outer);
	const data = path.join(outer, "data");
	desk.useDataDir(data);
	await desk.launch({});
	const chip = desk.page.locator("#data-chip");
	await expect(chip).toContainText("no repository");
	await chip.click();
	await desk.page.locator("#git-view").getByRole("button", { name: "Initialize repository" }).click();
	await expect(chip).toContainText("⎇ main");
	expect(fs.existsSync(path.join(data, ".git"))).toBe(true);
	expect(sh(outer, "log", "--format=%s")).toBe("init");
	expect(sh(data, "log", "--format=%s")).toBe("Initial TW Desk data");
	expect(fs.readFileSync(path.join(data, ".gitignore"), "utf8")).toBe("*.tmp\n");
	desk.takeDialogs();
});

// ---------- auto-commit ----------

const commitCount = dir => Number(sh(dir, "rev-list", "--count", "HEAD"));
const lastSubject = dir => sh(dir, "log", "-1", "--format=%s");
// The startup changes (config.json written by the test) are committed on their own first
const settled = async dir => expect.poll(() => sh(dir, "status", "--porcelain"), { timeout: 20000 }).toBe("");

async function launchWithRepo(desk, config = {}, delay = "500") {
	const data = path.join(desk.root, "data");
	gitRepo(data);
	desk.useDataDir(data);
	await desk.launch(config, { env: { TW_DESK_DATA_COMMIT_DELAY: delay } });
	return data;
}

test("data folder: auto-commit after a change, with a readable message", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const data = await launchWithRepo(desk, { wikis: [{ name: "Alpha", path: alpha }] });
	await settled(data);
	const before = commitCount(data);
	await desk.page.evaluate(async folder => {
		await window.twDesk.saveGroup({ name: "Work" });
		await window.twDesk.plugins.setOrder([folder]);
	}, alpha);
	await expect.poll(() => lastSubject(data), { timeout: 20000 }).toBe("Added group Work · Reordered plugin cards");
	expect(commitCount(data)).toBe(before + 1);
});

test("data folder: using the app makes no commit", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const data = await launchWithRepo(desk, { wikis: [{ name: "Alpha", path: alpha }], groups: [{ id: "g1", name: "Work" }] });
	await settled(data);
	const before = commitCount(data);
	await desk.startWiki("Alpha");
	await desk.stopWiki("Alpha");
	await desk.page.evaluate(() => window.twDesk.setGroupCollapsed("g1", true));
	await desk.page.waitForTimeout(2000);
	expect(commitCount(data)).toBe(before);
	expect(sh(data, "status", "--porcelain")).toBe("");
});

test("data folder: quitting before the delay still commits", async ({ desk }) => {
	const data = await launchWithRepo(desk, {}, "600000");
	await desk.page.evaluate(() => window.twDesk.saveGroup({ name: "Work" }));
	await desk.quit();
	expect(lastSubject(data)).toBe("Added group Work");
	expect(sh(data, "status", "--porcelain")).toBe("");
});

test("data folder: no auto-commit while it is behind its remote", async ({ desk }) => {
	const data = path.join(desk.root, "data");
	gitRepo(data);
	fs.writeFileSync(path.join(data, "config.json"), "{}");
	sh(data, "add", "-A");
	sh(data, "commit", "--quiet", "-m", "config");
	const remote = path.join(desk.root, "remote.git");
	sh(desk.root, "init", "--bare", "--quiet", remote);
	sh(data, "remote", "add", "origin", remote);
	sh(data, "push", "--quiet", "-u", "origin", "main");
	const other = path.join(desk.root, "other");
	sh(desk.root, "clone", "--quiet", remote, other);
	fs.writeFileSync(path.join(other, "notes.txt"), "from the laptop");
	sh(other, "add", "-A");
	sh(other, "commit", "--quiet", "-m", "laptop");
	sh(other, "push", "--quiet");
	sh(data, "fetch", "--quiet");
	desk.useDataDir(data);
	await desk.launch({}, { env: { TW_DESK_DATA_COMMIT_DELAY: "500" } });
	const before = commitCount(data);
	await expect(desk.page.locator("#data-chip")).toContainText("↓1");
	await desk.page.evaluate(() => window.twDesk.saveGroup({ name: "Work" }));
	await desk.page.waitForTimeout(2500);
	expect(commitCount(data)).toBe(before);
	expect(sh(data, "status", "--porcelain")).toContain("config.json");
});

test("data folder: a change made by hand is committed too", async ({ desk }) => {
	const data = await launchWithRepo(desk);
	await settled(data);
	fs.writeFileSync(path.join(data, "notes.txt"), "by hand");
	await desk.page.evaluate(() => window.twDesk.git.checkNow());
	await expect.poll(() => lastSubject(data), { timeout: 20000 }).toMatch(/^TW Desk: setup changed \(/);
	await settled(data);
});

// ---------- wikis that aren't found ----------

test("data folder: wikis that aren't found stay listed and can be re-pointed together", async ({ desk }) => {
	const old = name => path.join(desk.root, "old", name);
	const moved = path.join(desk.root, "new");
	fs.mkdirSync(moved);
	for (const name of ["a", "b"]) {
		fs.cpSync(desk.wiki("tmp-" + name, "alpha"), path.join(moved, name), { recursive: true });
	}
	await desk.launch({
		wikis: ["a", "b", "c"].map(name => ({ name, path: old(name) })),
		folderDescriptions: { [old("a")]: "described" }
	});
	await expect(desk.row("a").locator(".wiki-meta")).toContainText("not found");
	const banner = desk.page.locator(".missing-banner");
	await expect(banner).toContainText("3 wikis were in " + path.join(desk.root, "old"));
	await desk.pick(moved);
	await banner.getByRole("button", { name: "Where are they now?…" }).click();
	await expect(desk.row("a").locator(".wiki-meta")).not.toContainText("not found");
	const asked = (await desk.takeDialogs()).map(d => d.message).join("\n");
	expect(asked).toContain("Found: a, b.");
	expect(asked).toContain("Still not found: c.");
	expect((await desk.wikiState("a")).path).toBe(path.join(moved, "a"));
	expect((await desk.wikiState("b")).path).toBe(path.join(moved, "b"));
	await expect(desk.row("c").locator(".wiki-meta")).toContainText("not found");
	expect(desk.config().folderDescriptions).toEqual({ [path.join(moved, "a")]: "described" });
	await expect(banner).toHaveCount(0);
});

test("data folder: locate a single wiki that isn't found", async ({ desk }) => {
	const copy = desk.wiki("alpha");
	const empty = path.join(desk.root, "empty");
	fs.mkdirSync(empty);
	await desk.launch({ wikis: [{ name: "Alpha", path: path.join(desk.root, "gone", "alpha") }] });
	const row = desk.row("Alpha");
	await expect(row.locator(".wiki-meta")).toContainText("not found");
	await expect(row.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
	await desk.pick(empty);
	await desk.rowMenu(row, "Locate…");
	await expect.poll(async () => (await desk.takeDialogs()).map(d => d.message).join("\n")).toContain("no tiddlywiki.info");
	await desk.pick(copy);
	await desk.rowMenu(row, "Locate…");
	await expect(row.locator(".wiki-meta")).not.toContainText("not found");
	expect((await desk.wikiState("Alpha")).path).toBe(copy);
	await expect(row.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
});

// ---------- final review ----------

test("data folder: a broken config.json is never lost when choosing the data folder", async ({ desk }) => {
	fs.mkdirSync(desk.userData, { recursive: true });
	fs.writeFileSync(path.join(desk.userData, "config.json"), "{ broken");
	const existing = preparedDataFolder(desk);
	await desk.launch({}, { dataEnv: false, writeConfig: false });
	await expect(setupDialog(desk)).toBeVisible();
	await desk.page.locator("#data-setup-path").fill(path.join(desk.root, "data"));
	await desk.page.locator("#data-setup-create").click();
	await expect(desk.page.locator("#data-setup-error")).toContainText("Could not read");
	await desk.pick(existing);
	await desk.page.locator("#data-setup-existing").click();
	await expect(desk.page.locator("#data-setup-error")).toContainText("Could not read");
	expect(fs.readFileSync(path.join(desk.userData, "config.json"), "utf8")).toBe("{ broken");
	expect(fs.existsSync(path.join(desk.root, "data"))).toBe(false);
	await expect(setupDialog(desk)).toBeVisible();
});

test("data folder: git without a user identity doesn't block the first start", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] }, {
		dataEnv: false,
		env: { GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" }
	});
	const target = path.join(desk.root, "tw-desk-data");
	await desk.page.locator("#data-setup-create").click();
	await expect(setupDialog(desk)).toBeHidden();
	expect(desk.rawConfig(target).wikis[0].path).toBe("../wikis/alpha");
	expect(JSON.parse(fs.readFileSync(path.join(desk.userData, "data-folder.json"), "utf8")).path).toBe(target);
	await expect(desk.row("Alpha")).toBeVisible();
});

test("data folder: moving refuses while config.json can't be read", async ({ desk }) => {
	const data = path.join(desk.root, "data");
	fs.mkdirSync(data);
	fs.writeFileSync(path.join(data, "config.json"), "{ broken");
	desk.useDataDir(data);
	await desk.launch({}, { writeConfig: false });
	await openSettings(desk);
	const target = path.join(desk.root, "data2");
	await desk.pick(target);
	await desk.page.locator("#data-move").click();
	await expect(desk.page.locator("#settings-error")).toContainText("Could not read");
	expect(fs.existsSync(target)).toBe(false);
	expect(fs.readFileSync(path.join(data, "config.json"), "utf8")).toBe("{ broken");
});

test("data folder: one without config.json counts as not found", async ({ desk }) => {
	const empty = path.join(desk.root, "data");
	fs.mkdirSync(path.join(empty, ".git"), { recursive: true });
	writeJson(path.join(desk.userData, "data-folder.json"), { path: empty });
	await desk.launch({}, { dataEnv: false, writeConfig: false });
	await expect(desk.page.locator("#data-setup-text")).toContainText("wasn't found");
	await expect(desk.page.locator("#data-setup-text")).toContainText(empty);
});

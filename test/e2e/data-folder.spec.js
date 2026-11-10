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

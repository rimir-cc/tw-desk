"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./fixtures");
const { pluginTiddler } = require("../helpers/server");

test("install from a library, use it in a wiki, update from another library", async ({ desk, server }) => {
	server.setLibrary([pluginTiddler("$:/plugins/test/hello", "1.0.0")]);
	server.setCpl([pluginTiddler("$:/plugins/test/hello", "1.1.0"), pluginTiddler("$:/plugins/test/other", "2.0.0", { description: "Something else" })]);
	const alpha = desk.wiki("alpha");
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const dialog = page.locator("#plugins-dialog");
	const message = page.locator("#plugins-message");
	// Both test libraries are on the same host, so their labels include the path
	const host = new URL(server.url).host;
	const lib = host + "/lib";
	const cpl = host + "/cpl";

	// Search across both libraries
	await page.locator("#show-plugins").click();
	await dialog.locator("[data-tab=libraries]").click();
	await dialog.locator("input.library-search").fill("hello");
	const result = dialog.locator(".search-table tr", { hasText: "test/hello" });
	await expect(result).toHaveCount(1);
	await expect(result.locator(".badge")).toHaveText([cpl + " 1.1.0", lib + " 1.0.0"]);
	await expect(dialog.locator(".search-table tr", { hasText: "test/other" })).toHaveCount(0);

	// Install the older version on purpose, to update it later
	await result.getByRole("button", { name: "Install from " + lib }).click();
	await expect(message).toContainText("Installed $:/plugins/test/hello 1.0.0");
	const info = path.join(desk.userData, "store", "plugins", "test", "hello", "plugin.info");
	expect(JSON.parse(fs.readFileSync(info, "utf8")).version).toBe("1.0.0");

	// Add it to the wiki
	await dialog.locator("[data-tab=wikis]").click();
	const card = dialog.locator(".card", { hasText: "Alpha" });
	await card.locator("select").selectOption("plugin|test/hello");
	await card.getByRole("button", { name: "Add", exact: true }).click();
	await expect(message).toContainText("Added test/hello to Alpha.");
	expect(JSON.parse(fs.readFileSync(path.join(alpha, "tiddlywiki.info"), "utf8")).plugins).toContain("test/hello");
	await expect(card.locator("tr", { hasText: "test/hello" }).locator(".badge")).toHaveText("store 1.0.0");
	await dialog.locator("#close-plugins").click();

	// The wiki's server loads it from the store
	const row = desk.row("Alpha");
	await row.getByRole("button", { name: "Start", exact: true }).click();
	await expect(row.locator(".wiki-meta")).toContainText("running", { timeout: 60000 });
	const port = (await desk.wikiState("Alpha")).port;
	expect((await desk.tiddler(port, "$:/plugins/test/hello")).version).toBe("1.0.0");

	// The update check finds the newer version in the other library
	await page.locator("#show-plugins").click();
	await dialog.locator("[data-tab=store]").click();
	await dialog.getByRole("button", { name: "Check for updates" }).click();
	await expect(message).toContainText("1 with updates");
	const update = dialog.locator("tr", { hasText: "$:/plugins/test/hello" }).filter({ hasText: "in store" });
	await expect(update).toContainText("→ 1.1.0");
	await update.getByRole("button", { name: "Update → 1.1.0" }).click();
	await expect(message).toContainText("Updated $:/plugins/test/hello to 1.1.0");
	expect(JSON.parse(fs.readFileSync(info, "utf8")).version).toBe("1.1.0");
	await dialog.locator("#close-plugins").click();

	// After a restart the wiki has the new version
	await row.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(row.locator(".wiki-meta")).toContainText("stopped");
	await row.getByRole("button", { name: "Start", exact: true }).click();
	await expect(row.locator(".wiki-meta")).toContainText("running", { timeout: 60000 });
	const newPort = (await desk.wikiState("Alpha")).port;
	expect((await desk.tiddler(newPort, "$:/plugins/test/hello")).version).toBe("1.1.0");
});

test("move a plugin stored inside a wiki into the store", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	// As TiddlyWiki saves a plugin dropped into a wiki: content in .json, fields in .json.meta
	const plugin = pluginTiddler("$:/plugins/test/inwiki", "0.5.0");
	const file = path.join(alpha, "tiddlers", "$__plugins_test_inwiki.json");
	fs.writeFileSync(file, plugin.text);
	fs.writeFileSync(file + ".meta", Object.entries(plugin).filter(([key]) => key !== "text").map(([key, value]) => key + ": " + value).join("\n"));
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const dialog = page.locator("#plugins-dialog");
	const card = dialog.locator("#tab-wikis .card", { hasText: "Alpha" });
	const stored = card.locator("tr", { hasText: "$:/plugins/test/inwiki" }).filter({ hasText: "in wiki 0.5.0" });
	const move = stored.getByRole("button", { name: "Move to store" });

	// Not while the wiki runs
	await desk.startWiki("Alpha");
	await page.locator("#show-plugins").click();
	await dialog.locator("[data-tab=wikis]").click();
	await expect(move).toBeDisabled();
	await dialog.locator("#close-plugins").click();
	await desk.stopWiki("Alpha");

	await page.locator("#show-plugins").click();
	await move.click();
	await expect(page.locator("#plugins-message")).toContainText("Moved $:/plugins/test/inwiki 0.5.0 to the store.");
	await expect(stored).toHaveCount(0);
	await expect(card.locator("tr", { hasText: "test/inwiki" }).locator(".badge")).toHaveText("store 0.5.0");
	expect(fs.existsSync(file)).toBe(false);
	expect(fs.existsSync(file + ".meta")).toBe(false);
	expect(JSON.parse(fs.readFileSync(path.join(alpha, "tiddlywiki.info"), "utf8")).plugins).toContain("test/inwiki");
	const backups = fs.readdirSync(path.join(desk.userData, "backup"));
	expect(backups).toHaveLength(1);
	expect(fs.readdirSync(path.join(desk.userData, "backup", backups[0], "alpha")).sort()).toEqual(["$__plugins_test_inwiki.json", "$__plugins_test_inwiki.json.meta"]);
	await dialog.locator("#close-plugins").click();

	// The wiki now gets it from the store
	const port = await desk.startWiki("Alpha");
	expect((await desk.tiddler(port, "$:/plugins/test/inwiki")).version).toBe("0.5.0");
});

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

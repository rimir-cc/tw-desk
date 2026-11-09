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

// alpha → shared → deep: inherited plugins, a version clash, card order, collapsing and the removal prompt
function setUpChain(desk) {
	const alpha = desk.wiki("alpha");
	const shared = desk.wiki("shared");
	const deep = desk.wiki("deep", "shared");
	const info = folder => path.join(folder, "tiddlywiki.info");
	const edit = (folder, change) => fs.writeFileSync(info(folder), JSON.stringify(change(JSON.parse(fs.readFileSync(info(folder), "utf8"))), null, 4));
	edit(alpha, i => Object.assign(i, { includeWikis: ["../shared"], plugins: (i.plugins || []).concat("test/hello") }));
	edit(shared, i => Object.assign(i, { includeWikis: ["../deep"] }));
	edit(deep, i => Object.assign(i, { plugins: (i.plugins || []).concat("tiddlywiki/internals") }));
	// shared stores an older test/hello as tiddlers; the store has 1.1.0
	const plugin = pluginTiddler("$:/plugins/test/hello", "1.0.0");
	const file = path.join(shared, "tiddlers", "$__plugins_test_hello.json");
	fs.writeFileSync(file, plugin.text);
	fs.writeFileSync(file + ".meta", Object.entries(plugin).filter(([key]) => key !== "text").map(([key, value]) => key + ": " + value).join("\n"));
	const storeDir = path.join(desk.userData, "store", "plugins", "test", "hello");
	fs.mkdirSync(storeDir, { recursive: true });
	const stored = pluginTiddler("$:/plugins/test/hello", "1.1.0");
	fs.writeFileSync(path.join(storeDir, "plugin.info"), JSON.stringify(Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "text" && key !== "type"))));
	fs.writeFileSync(path.join(storeDir, "tiddlers.json"), JSON.stringify([{ title: "$:/plugins/test/hello/readme", text: "Readme" }]));
	return { alpha, shared, deep };
}

test("wikis tab: inherited plugins, clash, order, collapse, removal prompt", async ({ desk }) => {
	const { deep } = setUpChain(desk);
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: path.join(desk.wikisDir, "alpha") }] });
	const dialog = page.locator("#plugins-dialog");
	const cards = dialog.locator("#tab-wikis .card");
	const card = name => cards.filter({ has: page.locator(".card-title strong", { hasText: new RegExp("^" + name + "$") }) });
	await page.locator("#show-plugins").click();
	await dialog.locator("[data-tab=wikis]").click();

	await expect(cards).toHaveCount(3);
	const alpha = card("Alpha");
	await expect(alpha.locator(".inherited tr", { hasText: "internals" })).toContainText("via shared → deep");
	await expect(alpha.locator(".card-title")).toContainText("⚠ clash");
	await expect(alpha).toContainText("clash: in shared 1.0.0 · store 1.1.0 – the store copy wins");

	// Collapse all, and it stays collapsed after reopening
	await dialog.getByRole("button", { name: "Collapse all" }).click();
	await expect(alpha.locator(".plugin-table").first()).toBeHidden();
	await expect(alpha.locator(".card-title")).toContainText("own");
	await dialog.locator("#close-plugins").click();
	await page.locator("#show-plugins").click();
	await expect(alpha.locator(".plugin-table").first()).toBeHidden();

	// Drag deep's (collapsed) card before Alpha's
	await card("deep").locator(".card-title").dragTo(alpha.locator(".card-title"), { targetPosition: { x: 5, y: 2 } });
	await expect(cards.first().locator(".card-title strong")).toHaveText("deep");
	expect(desk.config().pluginsFolderOrder[0]).toBe(deep);
	await dialog.locator("#close-plugins").click();
	await page.locator("#show-plugins").click();
	await expect(cards.first().locator(".card-title strong")).toHaveText("deep");
	await dialog.getByRole("button", { name: "Expand all" }).click();
	await expect(alpha.locator(".plugin-table").first()).toBeVisible();

	// Removing from deep names the wikis that lose it; cancelling changes nothing
	await page.evaluate(() => {
		window.confirmTexts = [];
		window.confirm = text => {
			window.confirmTexts.push(text);
			return false;
		};
	});
	await card("deep").locator("tr", { hasText: "internals" }).getByRole("button", { name: "Remove" }).click();
	const texts = await page.evaluate(() => window.confirmTexts);
	expect(texts).toHaveLength(1);
	expect(texts[0]).toContain("Alpha includes deep");
	expect(texts[0]).toContain("loses it on its next restart");
	expect(JSON.parse(fs.readFileSync(path.join(deep, "tiddlywiki.info"), "utf8")).plugins).toContain("tiddlywiki/internals");
});

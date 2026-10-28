"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./fixtures");
const { pluginTiddler } = require("../helpers/server");

test("libraries: add a standard library and a CPL (detected), refuse bad ones, remove one", async ({ desk, server }) => {
	server.setLibrary([pluginTiddler("$:/plugins/test/hello", "1.0.0")]);
	server.setCpl([pluginTiddler("$:/plugins/test/other", "2.0.0")]);
	const page = await desk.launch({ libraries: [] });
	const dialog = page.locator("#plugins-dialog");
	const message = page.locator("#plugins-message");
	const management = dialog.locator("details.library-management");
	const add = async url => {
		// The tab is rebuilt when the indexes have loaded, which would empty the field
		await expect(dialog.locator(".search-results")).not.toContainText("Loading the libraries");
		// The list is unfolded only while it's empty
		if (!(await management.evaluate(d => d.open))) {
			await management.locator("summary").click();
		}
		await management.locator(".add-row input").fill(url);
		await management.getByRole("button", { name: "Add library" }).click();
	};

	await page.locator("#show-plugins").click();
	await dialog.locator("[data-tab=libraries]").click();
	await expect(management.locator("summary")).toHaveText("Libraries (0)");

	await add("ftp://example.org/library");
	await expect(message).toHaveText("Please enter an http(s) URL.");
	await add(server.url + "/nothing-here");
	await expect(message).toContainText("No plugin library found at this URL.");
	await expect(message).toHaveClass(/error/);

	await add(server.libraryUrl);
	await expect(message).toHaveText("Added " + server.libraryUrl + ".");
	await add(server.cplUrl + "/");
	await expect(message).toHaveText("Added " + server.cplUrl + ".");
	await add(server.libraryUrl);
	await expect(message).toHaveText("This library is already in the list.");
	expect(desk.config().libraries).toEqual([{ url: server.libraryUrl, type: "tiddlywiki" }, { url: server.cplUrl, type: "cpl" }]);

	const libraryRow = url => management.locator("tr", { hasText: url });
	await expect(management.locator("summary")).toHaveText("Libraries (2)");
	await expect(libraryRow(server.libraryUrl).locator(".badge")).toHaveText("TiddlyWiki library");
	await expect(libraryRow(server.cplUrl).locator(".badge")).toHaveText("CPL");
	await expect(libraryRow(server.cplUrl)).toContainText("1 entries");

	// Both are searched
	await dialog.locator("input.library-search").fill("test");
	await expect(dialog.locator(".search-table tr", { hasText: "test/hello" })).toHaveCount(1);
	await expect(dialog.locator(".search-table tr", { hasText: "test/other" })).toHaveCount(1);

	// Remove the CPL: its plugins are no longer found
	await expect(dialog.locator(".search-results")).not.toContainText("Loading the libraries");
	if (!(await management.evaluate(d => d.open))) {
		await management.locator("summary").click();
	}
	await libraryRow(server.cplUrl).getByRole("button", { name: "Remove", exact: true }).click();
	await expect(message).toHaveText("Removed library.");
	expect(desk.config().libraries).toEqual([{ url: server.libraryUrl, type: "tiddlywiki" }]);
	await expect(dialog.locator(".search-table tr", { hasText: "test/hello" })).toHaveCount(1);
	await expect(dialog.locator(".search-table tr", { hasText: "test/other" })).toHaveCount(0);
});

test("store: a plugin a wiki uses can't be removed until the wiki stops using it", async ({ desk, server }) => {
	server.setLibrary([pluginTiddler("$:/plugins/test/hello", "1.0.0")]);
	const alpha = desk.wiki("alpha");
	const infoFile = path.join(alpha, "tiddlywiki.info");
	const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
	info.plugins = (info.plugins || []).concat("test/hello");
	fs.writeFileSync(infoFile, JSON.stringify(info, null, 4));
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	await page.evaluate(url => window.twDesk.plugins.install(url, "$:/plugins/test/hello"), server.libraryUrl);
	const dialog = page.locator("#plugins-dialog");
	const message = page.locator("#plugins-message");
	const stored = dialog.locator("#tab-store tr", { hasText: "$:/plugins/test/hello" });
	const remove = stored.getByRole("button", { name: "Remove", exact: true });

	await page.locator("#show-plugins").click();
	await dialog.locator("[data-tab=store]").click();
	await expect(stored).toContainText("used by Alpha");
	await expect(remove).toBeDisabled();
	// The main process refuses it too
	await expect(page.evaluate(() => window.twDesk.plugins.remove("plugin", "test/hello"))).rejects.toThrow(/Still used by: Alpha/);

	// Take it out of Alpha, then remove it
	await dialog.locator("[data-tab=wikis]").click();
	await dialog.locator("#tab-wikis .card", { hasText: "Alpha" }).locator("tr", { hasText: "test/hello" }).getByRole("button", { name: "Remove", exact: true }).click();
	await expect(message).toHaveText("Removed test/hello from Alpha.");
	expect(JSON.parse(fs.readFileSync(infoFile, "utf8")).plugins).not.toContain("test/hello");
	await dialog.locator("[data-tab=store]").click();
	await expect(stored).toContainText("not used");
	await remove.click();
	await expect(message).toHaveText("Removed $:/plugins/test/hello from the store.");
	await expect(stored).toHaveCount(0);
	expect(fs.existsSync(path.join(desk.userData, "store", "plugins", "test", "hello"))).toBe(false);
});

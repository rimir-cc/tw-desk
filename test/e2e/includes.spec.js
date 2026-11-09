"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./fixtures");

const includeWikis = folder => JSON.parse(fs.readFileSync(path.join(folder, "tiddlywiki.info"), "utf8")).includeWikis;

test("includes: add, serve, read-only, overview, remove", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const shared = desk.wiki("shared");
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const row = desk.row("Alpha");

	// Edit → "+ Add include…" (the folder picker answers with the shared folder)
	await desk.rowMenu(row, "Edit…");
	await expect(page.locator("#includes-editor")).toContainText("No included wikis.");
	await desk.pick(shared);
	await page.locator("#add-include").click();
	await expect(page.locator("#includes-editor li")).toContainText(shared);
	await page.locator("#save-dialog").click();
	await expect(page.locator("#wiki-dialog")).not.toBeVisible();
	expect(includeWikis(alpha)).toEqual([{ path: "../shared", "read-only": false }]);
	await expect(row.locator(".wiki-includes")).toContainText("shared");

	// The wiki's server loads the included folder
	const port = await desk.startWiki("Alpha");
	expect((await desk.tiddler(port, "SharedNote")).text).toBe("Shared by every wiki that includes this folder");
	// Includes can't be edited while the wiki runs
	await row.locator("button.more").click();
	await expect(page.getByRole("menuitem", { name: "Edit…" })).toBeDisabled();
	await page.keyboard.press("Escape");
	await desk.stopWiki("Alpha");

	// Read-only
	await desk.rowMenu(row, "Edit…");
	await page.locator("#includes-editor input[type=checkbox]").check();
	await page.locator("#save-dialog").click();
	await expect(page.locator("#wiki-dialog")).not.toBeVisible();
	expect(includeWikis(alpha)).toEqual([{ path: "../shared", "read-only": true }]);
	await expect(row.locator(".wiki-includes")).toContainText("shared (read-only)");

	// Overview: which wikis include which folder
	await page.locator("#show-includes").click();
	const entry = page.locator("#includes-overview li", { hasText: "shared" });
	await expect(entry).toContainText(shared);
	await expect(entry).toContainText("included by:Alpha (read-only)");
	await page.locator("#close-includes").click();

	// A folder that isn't a wiki is refused
	const notAWiki = path.join(desk.root, "not-a-wiki");
	fs.mkdirSync(notAWiki);
	await desk.rowMenu(row, "Edit…");
	await desk.pick(notAWiki);
	await page.locator("#add-include").click();
	await page.locator("#save-dialog").click();
	await expect(page.locator("#form-error")).toContainText("Not a wiki folder");
	expect(includeWikis(alpha)).toEqual([{ path: "../shared", "read-only": true }]);

	// Remove both: no includes left
	await page.locator("#includes-editor button", { hasText: "✕" }).first().click();
	await page.locator("#includes-editor button", { hasText: "✕" }).first().click();
	await page.locator("#save-dialog").click();
	await expect(page.locator("#wiki-dialog")).not.toBeVisible();
	expect(includeWikis(alpha)).toEqual([]);
	await expect(row.locator(".wiki-includes")).toHaveCount(0);
});

test("descriptions for included folders", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const shared = desk.wiki("shared");
	const infoFile = path.join(alpha, "tiddlywiki.info");
	fs.writeFileSync(infoFile, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(infoFile, "utf8")), { includeWikis: ["../shared"] }), null, 4));
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const row = desk.row("Alpha");

	await page.locator("#show-includes").click();
	const item = page.locator("#includes-overview li", { hasText: "shared" });
	await item.locator("textarea").fill("Shared core");
	await item.getByRole("button", { name: "Save" }).click();
	await expect.poll(() => Object.values(desk.config().folderDescriptions || {})).toEqual(["Shared core"]);
	expect(Object.keys(desk.config().folderDescriptions)).toEqual([shared]);
	await page.locator("#close-includes").click();

	const chip = row.locator(".wiki-includes .chip", { hasText: "shared" });
	await expect(chip).toHaveAttribute("title", shared + "\nShared core");
	await page.locator("#show-plugins").click();
	await page.locator("#plugins-dialog [data-tab=wikis]").click();
	await expect(page.locator("#tab-wikis .card", { has: page.locator(".card-title strong", { hasText: /^shared$/ }) }).locator(".folder-description")).toHaveText("Shared core");
});

test("includes overview: deeper folders get a description field, missing ones none", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const shared = desk.wiki("shared");
	const deep = desk.wiki("deep", "shared");
	const edit = (folder, includeWikis) => {
		const file = path.join(folder, "tiddlywiki.info");
		fs.writeFileSync(file, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(file, "utf8")), { includeWikis }), null, 4));
	};
	edit(alpha, ["../shared", "../nowhere"]);
	edit(shared, ["../deep"]);
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });

	await page.locator("#show-includes").click();
	const deepItem = page.locator("#includes-overview li", { has: page.locator("strong", { hasText: /^deep$/ }) });
	await expect(deepItem).toContainText("Alpha");
	await deepItem.locator("textarea").fill("Base layer");
	await deepItem.getByRole("button", { name: "Save" }).click();
	await expect.poll(() => (desk.config().folderDescriptions || {})[deep]).toBe("Base layer");
	const missing = page.locator("#includes-overview li", { has: page.locator("strong", { hasText: /^nowhere$/ }) });
	await expect(missing).toBeVisible();
	await expect(missing.locator("textarea")).toHaveCount(0);
});

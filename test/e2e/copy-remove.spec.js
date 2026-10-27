"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect, tw, sh } = require("./fixtures");

const today = () => new Date().toISOString().slice(0, 10);

// Alpha with content, a system tiddler, an attachment, a story list and an include of shared
function richAlpha(desk) {
	const alpha = desk.wiki("alpha");
	desk.wiki("shared");
	tw.writeTiddler(alpha, "$:/config/Test", "a setting");
	tw.writeTiddler(alpha, "$:/StoryList", "", { list: "Hello" });
	fs.mkdirSync(path.join(alpha, "files"));
	fs.writeFileSync(path.join(alpha, "files", "picture.png"), "png");
	const infoFile = path.join(alpha, "tiddlywiki.info");
	const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
	info.includeWikis = [{ path: "../shared", "read-only": false }];
	fs.writeFileSync(infoFile, JSON.stringify(info, null, 4));
	return alpha;
}

async function copyWizard(desk, mode, parent, gitInit) {
	const page = desk.page;
	await desk.rowMenu(desk.row("Alpha"), "Copy…");
	await expect(page.locator("#copy-source-name")).toHaveText("Alpha");
	await page.locator("#create-form input[name=copyMode][value=" + mode + "]").check();
	await page.locator("#create-form [name=gitInit]").setChecked(gitInit);
	await page.locator("#create-next").click();
	await expect(page.locator("#create-form [name=folderName]")).toHaveValue(/^alpha-copy/);
	await page.locator("#create-form [name=parent]").fill(parent);
	await page.locator("#create-next").click();
	await expect(page.locator("#create-form [name=name]")).toHaveValue("Alpha (copy)");
	await page.locator("#create-form [name=openAfter]").uncheck();
	await page.locator("#create-next").click();
	await expect(page.locator("#create-dialog")).not.toBeVisible({ timeout: 60000 });
}

test("copy everything into another folder: includes still point to shared, new repository", async ({ desk }) => {
	richAlpha(desk);
	await desk.launch({ wikis: [{ name: "Alpha", path: path.join(desk.wikisDir, "alpha") }] });
	const parent = path.join(desk.wikisDir, "copies");
	fs.mkdirSync(parent);
	await copyWizard(desk, "all", parent, true);

	const copy = path.join(parent, "alpha-copy");
	const tiddlers = fs.readdirSync(path.join(copy, "tiddlers"));
	expect(tiddlers).toEqual(expect.arrayContaining(["Hello.tid", "$__config_Test.tid"]));
	expect(tiddlers).not.toContain("$__StoryList.tid");
	expect(fs.existsSync(path.join(copy, "files", "picture.png"))).toBe(true);
	const info = JSON.parse(fs.readFileSync(path.join(copy, "tiddlywiki.info"), "utf8"));
	expect(info.includeWikis).toEqual([{ path: "../../shared", "read-only": false }]);
	expect(sh(copy, "log", "--format=%s")).toBe("TW Desk: initial commit");

	const wiki = desk.config().wikis.find(w => w.name === "Alpha (copy)");
	expect(wiki.copiedFrom).toMatchObject({ name: "Alpha", date: today() });
	await expect(desk.row("Alpha (copy)").locator(".wiki-description")).toHaveText("copy of Alpha · " + today());
	// The copy serves the shared folder too
	const port = await desk.startWiki("Alpha (copy)");
	expect(await desk.tiddler(port, "SharedNote")).not.toBeNull();
});

test("copy only the configuration: system tiddlers, no content, no files", async ({ desk }) => {
	richAlpha(desk);
	await desk.launch({ wikis: [{ name: "Alpha", path: path.join(desk.wikisDir, "alpha") }] });
	await copyWizard(desk, "config", desk.wikisDir, false);

	const copy = path.join(desk.wikisDir, "alpha-copy");
	expect(fs.readdirSync(path.join(copy, "tiddlers"))).toEqual(["$__config_Test.tid"]);
	expect(fs.existsSync(path.join(copy, "files"))).toBe(false);
	expect(fs.existsSync(path.join(copy, ".git"))).toBe(false);
	const info = JSON.parse(fs.readFileSync(path.join(copy, "tiddlywiki.info"), "utf8"));
	expect(info.includeWikis).toEqual([{ path: "../shared", "read-only": false }]);
});

test("remove from the list, delete to the trash, and what blocks deleting", async ({ desk }) => {
	const alpha = richAlpha(desk);
	const shared = path.join(desk.wikisDir, "shared");
	const other = desk.wiki("other", "alpha");
	const page = await desk.launch({ wikis: [
		{ name: "Alpha", path: alpha },
		{ name: "Shared", path: shared },
		{ name: "Other", path: other }
	] });
	const deleteOption = page.locator("#remove-form input[value=delete]");
	const notes = page.locator("#remove-notes");

	// Shared is included by Alpha
	await desk.rowMenu(desk.row("Shared"), "Remove…");
	await expect(notes).toContainText("Can't delete: Included by \"Alpha\"");
	await expect(deleteOption).toBeDisabled();
	await page.locator("#cancel-remove").click();

	// A running wiki can't be deleted
	await desk.startWiki("Other");
	await desk.rowMenu(desk.row("Other"), "Remove…");
	await expect(notes).toContainText("The wiki is running");
	await expect(deleteOption).toBeDisabled();
	await page.locator("#cancel-remove").click();
	await desk.stopWiki("Other");

	// Delete: the folder goes to the trash (stubbed), the wiki leaves the list
	await desk.rowMenu(desk.row("Other"), "Remove…");
	await expect(page.locator("#remove-folder")).toContainText(other);
	await deleteOption.check();
	// (or "unknown" if the first git check hasn't finished yet)
	await expect(notes).toContainText(/Not under version control|git status is unknown/);
	await expect(page.locator("#confirm-remove")).toHaveText(/^Move to /);
	await page.locator("#confirm-remove").click();
	await expect(page.locator("#remove-dialog")).not.toBeVisible();
	await expect(desk.row("Other")).toHaveCount(0);
	expect((await desk.mainCalls()).trashed).toEqual([other]);
	expect(desk.config().wikis.map(w => w.name)).toEqual(["Alpha", "Shared"]);

	// Remove from the list only: the folder stays
	await desk.rowMenu(desk.row("Alpha"), "Remove…");
	await expect(page.locator("#confirm-remove")).toHaveText("Remove from list");
	await page.locator("#confirm-remove").click();
	await expect(desk.row("Alpha")).toHaveCount(0);
	expect(fs.existsSync(path.join(alpha, "tiddlywiki.info"))).toBe(true);
	expect((await desk.mainCalls()).trashed).toEqual([other]);

	// Now nothing includes Shared any more
	await desk.rowMenu(desk.row("Shared"), "Remove…");
	await expect(deleteOption).toBeEnabled();
	await page.locator("#cancel-remove").click();
});

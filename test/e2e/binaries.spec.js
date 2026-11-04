"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./fixtures");

const EXTERNALIZE = { policy: "externalize", filesInGit: true };

function putBinary(folder, name, title, size = 100) {
	fs.writeFileSync(path.join(folder, "tiddlers", name), Buffer.alloc(size, 7));
	fs.writeFileSync(path.join(folder, "tiddlers", name + ".meta"), "title: " + title + "\ntype: image/png\n");
}

function exists(folder, ...parts) {
	return fs.existsSync(path.join(folder, ...parts));
}

function gitignore(folder) {
	const file = path.join(folder, ".gitignore");
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

test("binaries: externalize on stop", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	putBinary(alpha, "photo.png", "Photo");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha, binaries: EXTERNALIZE }] });

	// The run at start-up
	await expect.poll(() => exists(alpha, "files", "photo.png")).toBe(true);
	expect(exists(alpha, "tiddlers", "photo.png")).toBe(false);
	expect(fs.readFileSync(path.join(alpha, "tiddlers", "photo.png.tid"), "utf8")).toContain("_canonical_uri: files/photo.png");
	await expect(desk.row("Alpha").locator(".binary-chip")).toHaveCount(0);

	// A binary added while the wiki runs is moved after the stop
	await desk.startWiki("Alpha");
	putBinary(alpha, "scan.png", "Scan");
	await desk.stopWiki("Alpha");
	await expect.poll(() => exists(alpha, "files", "scan.png")).toBe(true);
	expect(exists(alpha, "tiddlers", "scan.png.tid")).toBe(true);
	expect(gitignore(alpha)).not.toContain("files/");
});

test("binaries: chip with policy \"leave\"", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	putBinary(alpha, "photo.png", "Photo", 2000);
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const chip = desk.row("Alpha").locator(".binary-chip");
	await expect(chip).toHaveText("▣ 1 embedded · 2 KB");

	await desk.startWiki("Alpha");
	await desk.stopWiki("Alpha");
	await expect(chip).toHaveText("▣ 1 embedded · 2 KB");
	expect(exists(alpha, "tiddlers", "photo.png")).toBe(true);
	expect(exists(alpha, "files")).toBe(false);
});

test("binaries: keep out of git, internalize, refused while running", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	putBinary(alpha, "photo.png", "Photo");
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const form = page.locator("#wiki-form");
	const row = desk.row("Alpha");

	await desk.rowMenu(row, "Edit…");
	await expect(form.locator("[name=binaryPolicy]")).toHaveValue("leave");
	await expect(form.locator("[name=filesInGit]")).toBeChecked();
	await form.locator("[name=filesInGit]").uncheck();
	await form.locator("[name=binaryPolicy]").selectOption("externalize");
	await page.locator("#save-dialog").click();
	await expect(page.locator("#wiki-dialog")).not.toBeVisible();
	expect(desk.config().wikis[0].binaries).toEqual({ policy: "externalize", filesInGit: false });

	await desk.rowMenu(row, "Apply binary policy now");
	await expect.poll(() => exists(alpha, "files", "photo.png")).toBe(true);
	expect(gitignore(alpha).split(/\r?\n/)).toContain("files/");

	// Not while the wiki runs
	await desk.startWiki("Alpha");
	await row.locator("button.more").click();
	await expect(page.getByRole("menuitem", { name: "Apply binary policy now", exact: true })).toBeDisabled();
	await page.keyboard.press("Escape");
	await desk.stopWiki("Alpha");

	await desk.rowMenu(row, "Edit…");
	await form.locator("[name=binaryPolicy]").selectOption("internalize");
	await form.locator("[name=filesInGit]").check();
	await page.locator("#save-dialog").click();
	await expect(page.locator("#wiki-dialog")).not.toBeVisible();
	await desk.rowMenu(row, "Apply binary policy now");
	await expect.poll(() => exists(alpha, "tiddlers", "photo.png")).toBe(true);
	expect(exists(alpha, "tiddlers", "photo.png.meta")).toBe(true);
	expect(exists(alpha, "tiddlers", "photo.png.tid")).toBe(false);
	// The file in files/ stays, and files/ is committed again
	expect(exists(alpha, "files", "photo.png")).toBe(true);
	expect(gitignore(alpha).split(/\r?\n/)).not.toContain("files/");
});

test("binaries: an included wiki is only reported", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const shared = desk.wiki("shared");
	const infoFile = path.join(alpha, "tiddlywiki.info");
	const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
	info.includeWikis = ["../shared"];
	fs.writeFileSync(infoFile, JSON.stringify(info, null, 4));
	putBinary(shared, "photo.png", "Photo");
	const page = await desk.launch({ wikis: [
		{ name: "Alpha", path: alpha },
		{ name: "Shared", path: shared, binaries: EXTERNALIZE }
	] });

	// The start-up run reports and leaves the files alone
	await desk.rowMenu(desk.row("Shared"), "Log");
	await expect(page.locator("#log-output")).toContainText("included by Alpha");
	expect(exists(shared, "tiddlers", "photo.png")).toBe(true);
	expect(exists(shared, "files")).toBe(false);
	await expect(desk.row("Shared").locator(".binary-chip")).toHaveText("▣ 1 embedded · 100 B");
});

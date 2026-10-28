"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect, BASE_PORT } = require("./fixtures");

test("add an existing wiki folder: checks, then saved with description, fixed port and autostart", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const other = desk.wiki("other", "alpha");
	const notWiki = path.join(desk.wikisDir, "not-a-wiki");
	fs.mkdirSync(notWiki);
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha, fixedPort: BASE_PORT + 5 }] });
	const form = page.locator("#wiki-form");
	const error = page.locator("#form-error");
	const save = () => page.locator("#save-dialog").click();

	await desk.newMenu("Add existing wiki folder…");
	await expect(page.locator("#dialog-title")).toHaveText("Add existing wiki");

	// Browse… fills the folder and, if empty, the name
	await desk.pick(notWiki);
	await page.locator("#pick-path").click();
	await expect(form.locator("[name=path]")).toHaveValue(notWiki);
	await expect(form.locator("[name=name]")).toHaveValue("not-a-wiki");
	await save();
	await expect(error).toHaveText("No tiddlywiki.info in " + notWiki);

	await form.locator("[name=path]").fill(alpha);
	await save();
	await expect(error).toHaveText("This folder is already in TW Desk as \"Alpha\".");

	await form.locator("[name=path]").fill(other);
	await form.locator("[name=name]").fill("Other");
	await form.locator("[name=fixedPort]").fill(String(BASE_PORT + 5));
	await save();
	await expect(error).toHaveText("Port " + (BASE_PORT + 5) + " is already the fixed port of \"Alpha\".");

	await form.locator("[name=fixedPort]").fill(String(BASE_PORT + 6));
	await form.locator("[name=description]").fill("Added by the test");
	await form.locator("[name=autostart]").check();
	await save();
	await expect(page.locator("#wiki-dialog")).not.toBeVisible();
	const row = desk.row("Other");
	await expect(row.locator(".wiki-description")).toHaveText("Added by the test");
	expect(desk.config().wikis.find(w => w.name === "Other")).toMatchObject({ path: other, fixedPort: BASE_PORT + 6, autostart: true, description: "Added by the test" });

	// Edit… shows the saved values; renaming keeps the rest
	await desk.rowMenu(row, "Edit…");
	await expect(page.locator("#dialog-title")).toHaveText("Edit wiki");
	await expect(form.locator("[name=fixedPort]")).toHaveValue(String(BASE_PORT + 6));
	await expect(form.locator("[name=autostart]")).toBeChecked();
	await form.locator("[name=name]").fill("Other wiki");
	await save();
	await expect(desk.row("Other wiki")).toBeVisible();
	expect(desk.config().wikis.find(w => w.name === "Other wiki")).toMatchObject({ fixedPort: BASE_PORT + 6, autostart: true });
});

test("wikis with autostart run right after TW Desk starts", async ({ desk }) => {
	await desk.launch({ wikis: [
		{ name: "Alpha", path: desk.wiki("alpha"), autostart: true },
		{ name: "Other", path: desk.wiki("other", "alpha") }
	] });
	await expect(desk.row("Alpha").locator(".wiki-meta")).toContainText("running", { timeout: 60000 });
	const port = (await desk.wikiState("Alpha")).port;
	expect((await desk.tiddler(port, "Hello")).text).toBe("Hello from alpha");
	await expect(desk.row("Other").locator(".wiki-meta")).toContainText("stopped");
});

test("settings: checks, start port for new ports, git and web check options", async ({ desk }) => {
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: desk.wiki("alpha") }] });
	const form = page.locator("#settings-form");
	const error = page.locator("#settings-error");
	const save = () => form.locator("button[type=submit]").click();

	await page.locator("#show-settings").click();
	await expect(form.locator("[name=basePort]")).toHaveValue(String(BASE_PORT));
	await expect(form.locator("[name=gitInterval]")).toHaveValue("0");
	await expect(form.locator("[name=webCheck]")).not.toBeChecked();

	// Checks every few seconds would be too often
	await form.locator("[name=gitInterval]").fill("10");
	await save();
	await expect(error).toHaveText("The git check interval must be 0 (off) or at least 30 seconds.");

	await form.locator("[name=gitInterval]").fill("600");
	await form.locator("[name=basePort]").fill(String(BASE_PORT + 20));
	await form.locator("[name=gitAutoCommit]").check();
	await form.locator("[name=webCheck]").check();
	await save();
	await expect(page.locator("#settings-dialog")).not.toBeVisible();
	const config = desk.config();
	expect(config.basePort).toBe(BASE_PORT + 20);
	expect(config.git).toMatchObject({ interval: 600, autoCommitOnStop: true });
	expect(config.webCheck).toBe(true);

	// Reopened, the dialog shows what was saved
	await page.locator("#show-settings").click();
	await expect(form.locator("[name=gitInterval]")).toHaveValue("600");
	await expect(form.locator("[name=webCheck]")).toBeChecked();
	await page.locator("#cancel-settings").click();

	// A wiki without a remembered port gets one from the new start port
	expect(await desk.startWiki("Alpha")).toBeGreaterThanOrEqual(BASE_PORT + 20);
});

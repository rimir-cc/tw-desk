"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect, tw } = require("./fixtures");

// Fills the wizard's location step and goes on to the settings step
async function location(page, parent, folderName) {
	await page.locator("#create-form [name=parent]").fill(parent);
	await page.locator("#create-form [name=folderName]").fill(folderName);
	await page.locator("#create-next").click();
}

async function create(page) {
	await page.locator("#create-form [name=openAfter]").uncheck();
	await page.locator("#create-next").click();
	await expect(page.locator("#create-dialog")).not.toBeVisible({ timeout: 60000 });
}

test("empty wiki: folder with tiddlyweb and filesystem, listed with its description", async ({ desk }) => {
	const page = await desk.launch();
	await expect(page.locator("#empty-hint")).toBeVisible();
	await desk.newMenu("Empty wiki…");
	await expect(page.locator("#create-title")).toHaveText("New empty wiki");
	// The wizard checks each step before going on
	await page.locator("#create-next").click();
	await expect(page.locator("#create-error")).toContainText("Choose the folder");
	await location(page, desk.wikisDir, "fresh");
	await expect(page.locator("#create-form [name=name]")).toHaveValue("fresh");
	await page.locator("#create-form [name=name]").fill("Fresh");
	await page.locator("#create-form [name=description]").fill("Made by the wizard test");
	await create(page);

	const row = desk.row("Fresh");
	await expect(row).toBeVisible();
	await expect(row.locator(".wiki-description")).toHaveText("Made by the wizard test");
	const folder = path.join(desk.wikisDir, "fresh");
	const info = JSON.parse(fs.readFileSync(path.join(folder, "tiddlywiki.info"), "utf8"));
	expect(info.plugins).toEqual(expect.arrayContaining(["tiddlywiki/tiddlyweb", "tiddlywiki/filesystem"]));
	const wiki = desk.config().wikis[0];
	expect(wiki).toMatchObject({ name: "Fresh", path: folder, description: "Made by the wizard test" });

	// The same folder again is refused
	await desk.newMenu("Empty wiki…");
	await location(page, desk.wikisDir, "fresh");
	await page.locator("#create-form [name=openAfter]").uncheck();
	await page.locator("#create-next").click();
	await expect(page.locator("#create-error")).toContainText("already in TW Desk");
	await page.locator("#create-cancel").click();
});

test("wiki from an HTML file keeps its start river ($:/StoryList)", async ({ desk }) => {
	const html = tw.wikiHtml([
		{ title: "$:/DefaultTiddlers", text: "[list[$:/StoryList]]" },
		{ title: "$:/StoryList", list: "[[Start here]] Second" },
		{ title: "Start here", text: "The first tiddler in the river" },
		{ title: "Second", text: "Another one" }
	]);
	const file = path.join(desk.root, "site.html");
	fs.writeFileSync(file, html);
	const page = await desk.launch();

	await desk.newMenu("Wiki from HTML file or web address…");
	await page.locator("#create-form [name=htmlFile]").fill(file);
	await page.locator("#create-next").click();
	// The folder name is suggested from the file name
	await expect(page.locator("#create-form [name=folderName]")).toHaveValue("site");
	await page.locator("#create-form [name=parent]").fill(desk.wikisDir);
	await page.locator("#create-next").click();
	await create(page);

	const row = desk.row("site");
	await expect(row.locator(".wiki-description")).toContainText("imported from");
	expect(desk.config().wikis[0].importedFrom.source).toBe(file);

	await row.getByRole("button", { name: "Start", exact: true }).click();
	await expect(row.locator(".wiki-meta")).toContainText("running", { timeout: 60000 });
	const port = (await desk.wikiState("site")).port;
	expect((await desk.tiddler(port, "Start here")).text).toBe("The first tiddler in the river");
	expect((await desk.tiddler(port, "$:/StoryList")).list).toBe("[[Start here]] Second");
});

test("wiki from a web address", async ({ desk, server }) => {
	const url = server.setPage("/import/index.html", tw.wikiHtml([{ title: "From the web", text: "downloaded" }]));
	const page = await desk.launch();

	await desk.newMenu("Wiki from HTML file or web address…");
	await page.locator("#create-form [name=htmlFile]").fill(url);
	await page.locator("#create-next").click();
	await location(page, desk.wikisDir, "webimport");
	await create(page);

	await expect(desk.row("webimport")).toBeVisible();
	expect(desk.config().wikis[0].importedFrom.source).toBe(url);
	const files = fs.readdirSync(path.join(desk.wikisDir, "webimport", "tiddlers"));
	expect(files.some(f => f.startsWith("From the web"))).toBe(true);
});

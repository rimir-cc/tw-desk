"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect, tw } = require("./fixtures");
const { pluginTiddler } = require("../helpers/server");

const today = () => new Date().toISOString().slice(0, 10);

test("web wiki: baseline, change check, snapshot and a wiki made from it", async ({ desk, server }) => {
	const tiddlers = [{ title: "Note", text: "version 1" }, { title: "Stays", text: "the same" }];
	const url = server.setPage("/site/index.html", tw.wikiHtml(tiddlers));
	const page = await desk.launch();

	// Add the link; its current state becomes the baseline
	await desk.newMenu("Web wiki link…");
	await page.locator("#link-form [name=url]").fill(url);
	await page.locator("#link-form [name=name]").fill("Site");
	await page.locator("#link-form [name=description]").fill("A test site");
	await page.locator("#link-form button[type=submit]").click();
	const row = desk.webRow("Site");
	await expect(row).toBeVisible();
	await expect(row.locator(".wiki-description")).toHaveText("A test site");
	const link = desk.config().webWikis[0];
	const baseline = path.join(desk.userData, "web", link.id, "baseline.json");
	await expect.poll(() => fs.existsSync(baseline)).toBe(true);

	await expect.poll(() => (desk.config().webWikis[0].check || {}).result).toBe("same");

	const header = page.locator("li.web-header");
	const checkAll = header.getByRole("button", { name: "Check for changes" });
	// Clicks "Check for changes" and waits for the new result
	const check = async () => {
		const prior = desk.config().webWikis[0].check.date;
		await checkAll.click();
		await expect.poll(() => desk.config().webWikis[0].check.date).not.toBe(prior);
		await expect(checkAll).toBeEnabled();
		return desk.config().webWikis[0].check;
	};

	// Nothing changed: the server answers 304 to the conditional request
	const before = server.requests.length;
	expect((await check()).result).toBe("same");
	const asked = server.requests.slice(before).find(r => r.url === "/site/index.html");
	expect(asked.headers["if-none-match"]).toBeTruthy();
	await expect(row.locator(".git-chip")).toHaveCount(0);

	// One tiddler changed, one added
	server.setPage("/site/index.html", tw.wikiHtml([{ title: "Note", text: "version 2" }, { title: "Stays", text: "the same" }, { title: "New", text: "new" }]));
	expect(await check()).toMatchObject({ result: "changed", changed: 1, added: 1, removed: 0 });
	await expect(row.locator(".git-chip.warn")).toHaveText("changed · 2 tiddlers");
	await expect(header.locator(".git-chip.warn")).toHaveText("1 changed");

	// Marked as seen: the current state is the new baseline
	await desk.rowMenu(row, "Mark changes as seen");
	await expect(row.locator(".git-chip.warn")).toHaveCount(0);
	await expect(header.locator(".git-chip.warn")).toHaveCount(0);

	// Only volatile tiddlers changed (history, state): not a change
	server.setPage("/site/index.html", tw.wikiHtml([
		{ title: "Note", text: "version 2" }, { title: "Stays", text: "the same" }, { title: "New", text: "new" },
		{ title: "$:/HistoryList", text: "[{\"title\":\"Note\"}]" }, { title: "$:/state/tab", text: "x" }
	]));
	expect((await check()).result).toBe("same");
	await expect(row.locator(".git-chip.warn")).toHaveCount(0);

	// Snapshot: a local copy that opens in an app window
	await desk.rowMenu(row, "Save snapshot");
	await expect(row.locator(".wiki-meta")).toContainText("snapshot " + today());
	const snapshot = path.join(desk.userData, "web", link.id, "snapshot.html");
	expect(fs.existsSync(snapshot)).toBe(true);
	const win = await desk.windowOpenedBy(() => row.getByRole("button", { name: "Open", exact: true }).click());
	expect(win.url()).toMatch(/^file:.*snapshot\.html$/);
	await expect.poll(() => win.evaluate(() => window.$tw && $tw.wiki && $tw.wiki.getTiddlerText("Note")), { timeout: 30000 }).toBe("version 2");
	await win.close();

	// The website button goes to the default browser (stubbed)
	await row.getByRole("button", { name: "↗", exact: true }).click();
	await expect.poll(async () => (await desk.mainCalls()).opened).toContain(url);

	// A real wiki from the snapshot
	await desk.rowMenu(row, "Make wiki from snapshot…");
	await expect(page.locator("#create-form [name=folderName]")).toHaveValue("Site");
	await page.locator("#create-form [name=parent]").fill(desk.wikisDir);
	await page.locator("#create-next").click();
	await expect(page.locator("#create-form [name=description]")).toHaveValue("A test site");
	await page.locator("#create-form [name=openAfter]").uncheck();
	await page.locator("#create-next").click();
	await expect(page.locator("#create-dialog")).not.toBeVisible({ timeout: 60000 });
	const wikiRow = desk.row("Site");
	await expect(wikiRow.locator(".wiki-description")).toContainText("from the snapshot of");
	expect(desk.config().wikis[0].importedFrom).toMatchObject({ source: url, snapshot: today() });
	const files = fs.readdirSync(path.join(desk.wikisDir, "Site", "tiddlers"));
	expect(files).toEqual(expect.arrayContaining(["Note.tid", "New.tid"]));
	// The link stays a link
	await expect(row).toBeVisible();
});

test("a web wiki marked as plugin showcase offers its plugins", async ({ desk, server }) => {
	const url = server.setPage("/showcase/index.html", tw.wikiHtml([pluginTiddler("$:/plugins/demo/widget", "0.9.0", { description: "Only in the showcase" })]));
	const page = await desk.launch();

	await desk.newMenu("Web wiki link…");
	await page.locator("#link-form [name=url]").fill(url);
	await page.locator("#link-form [name=name]").fill("Demo");
	await page.locator("#link-form [name=showcase]").check();
	await page.locator("#link-form button[type=submit]").click();
	const row = desk.webRow("Demo");
	await expect(row.locator(".showcase-chip")).toHaveText("showcase · no snapshot yet");
	await desk.rowMenu(row, "Save snapshot");
	await expect(row.locator(".showcase-chip")).toHaveText(/^showcase · \d+ plugins?$/);

	await row.locator(".showcase-chip").click();
	const dialog = page.locator("#plugins-dialog");
	const card = dialog.locator("#tab-showcases .card", { hasText: "Demo" });
	const plugin = card.locator("tr", { hasText: "demo/widget" });
	await expect(plugin).toContainText("Only in the showcase");
	await plugin.getByRole("button", { name: "Add to store" }).click();
	await expect(page.locator("#plugins-message")).toContainText("0.9.0");
	const info = JSON.parse(fs.readFileSync(path.join(desk.userData, "store", "plugins", "demo", "widget", "plugin.info"), "utf8"));
	expect(info.version).toBe("0.9.0");

	// The store says where it came from
	await dialog.locator("[data-tab=store]").click();
	await expect(dialog.locator("#tab-store tr", { hasText: "$:/plugins/demo/widget" })).toContainText("from showcase Demo");
});

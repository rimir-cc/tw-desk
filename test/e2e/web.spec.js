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
	// The "+" in the section header opens the same dialog, for a plain link
	await page.locator("li.web-header").getByRole("button", { name: "+", exact: true }).click();
	await expect(page.locator("#link-dialog-title")).toHaveText("Add web wiki");
	await expect(page.locator("#link-form [name=showcase]")).not.toBeChecked();
	await page.locator("#cancel-link").click();
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

test("plugin showcase: folded plugin list, add to store, link, Demo buttons with version notes", async ({ desk, server }) => {
	const showcasePage = version => tw.wikiHtml([
		pluginTiddler("$:/plugins/demo/widget", version, { description: "Only in the showcase" }),
		pluginTiddler("$:/plugins/demo/helper", "1.0.0")
	]);
	const url = server.setPage("/showcase/index.html", showcasePage("0.9.0"));
	const page = await desk.launch();
	const dialog = page.locator("#plugins-dialog");
	const message = page.locator("#plugins-message");

	// "+ Add showcase" in the Showcases tab: the dialog has "Plugin showcase" ticked, the snapshot is saved right away
	await page.locator("#show-plugins").click();
	await dialog.locator("[data-tab=showcases]").click();
	await expect(dialog.locator("#tab-showcases")).toContainText("No showcases yet");
	await dialog.getByRole("button", { name: "+ Add showcase" }).click();
	await expect(page.locator("#link-form [name=showcase]")).toBeChecked();
	await page.locator("#link-form [name=url]").fill(url);
	await page.locator("#link-form [name=name]").fill("Demo");
	await page.locator("#link-form button[type=submit]").click();
	await expect(message).toContainText("Added the showcase and saved its snapshot.");
	const row = desk.webRow("Demo");
	await expect(row.locator(".showcase-chip")).toHaveText(/^showcase · \d+ plugins?$/);
	expect(desk.config().webWikis[0]).toMatchObject({ name: "Demo", showcase: true });

	// The plugin list starts folded
	const card = dialog.locator("#tab-showcases .card", { hasText: "Demo" });
	const plugin = card.locator("tr", { hasText: "demo/widget" });
	await expect(card.locator("details summary")).toContainText("plugins, themes and languages");
	await expect(plugin).toBeHidden();
	await card.locator("details summary").click();
	await expect(plugin).toContainText("Only in the showcase");

	await plugin.getByRole("button", { name: "Add to store" }).click();
	await expect(message).toContainText("Added $:/plugins/demo/widget 0.9.0");
	const info = path.join(desk.userData, "store", "plugins", "demo", "widget", "plugin.info");
	expect(JSON.parse(fs.readFileSync(info, "utf8")).version).toBe("0.9.0");

	// Link: the showcase becomes the plugin's demo; the list stays unfolded after the update
	await plugin.getByRole("button", { name: "Link", exact: true }).click();
	await expect(message).toContainText("Linked $:/plugins/demo/widget");
	await expect(plugin).toBeVisible();
	await expect(plugin.locator(".badge", { hasText: "linked" })).toBeVisible();
	await expect(card.locator(".showcase-linked")).toContainText("demo/widget 0.9.0");
	expect(desk.config().webWikis[0].linkedPlugins).toEqual(["$:/plugins/demo/widget"]);

	// Store: a Demo button, no version note while the versions match; it opens the snapshot
	await dialog.locator("[data-tab=store]").click();
	const stored = dialog.locator("#tab-store tr", { hasText: "$:/plugins/demo/widget" });
	await expect(stored).toContainText("from showcase Demo");
	await expect(stored.getByRole("button", { name: "Demo" })).toBeVisible();
	await expect(stored.locator(".demo-link .badge")).toHaveCount(0);
	const win = await desk.windowOpenedBy(() => stored.getByRole("button", { name: "Demo" }).click());
	expect(win.url()).toMatch(/^file:.*snapshot\.html$/);
	// Already open but minimized: Demo brings that window back instead of doing nothing
	const snapshotWindow = () => desk.app.evaluate(({ BrowserWindow }) => {
		const found = BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith("snapshot.html"));
		return { count: found.length, minimized: found.length ? found[0].isMinimized() : null };
	});
	await desk.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith("snapshot.html")).minimize());
	await expect.poll(snapshotWindow).toEqual({ count: 1, minimized: true });
	await stored.getByRole("button", { name: "Demo" }).click();
	await expect.poll(snapshotWindow).toEqual({ count: 1, minimized: false });
	await win.close();
	// "Website ↗" next to it opens the site in the default browser (stubbed)
	await stored.getByRole("button", { name: "Website ↗" }).click();
	await expect.poll(async () => (await desk.mainCalls()).opened).toContain(url);

	// The site moves on to 1.0.0: after a new snapshot the Demo buttons say which version the demo shows
	server.setPage("/showcase/index.html", showcasePage("1.0.0"));
	await dialog.locator("[data-tab=showcases]").click();
	await card.getByRole("button", { name: "Update snapshot" }).click();
	await expect(message).toContainText("Saved the snapshot of Demo");
	await expect(card.locator(".showcase-linked")).toContainText("demo/widget 1.0.0 (the store has 0.9.0)");
	await dialog.locator("[data-tab=store]").click();
	await expect(stored.locator(".demo-link .badge")).toHaveText("demo shows 1.0.0");

	// Libraries search: the showcase's offer and the Demo button with the same note
	await dialog.locator("[data-tab=libraries]").click();
	await dialog.locator("input.library-search").fill("widget");
	const result = dialog.locator(".search-table tr", { hasText: "demo/widget" });
	await expect(result.getByRole("button", { name: "Demo" })).toBeVisible();
	await expect(result.locator(".demo-link .badge")).toHaveText("demo shows 1.0.0");
	await expect(result.getByRole("button", { name: "Update → 1.0.0" })).toBeVisible();

	// The main window names what the showcase demonstrates
	await dialog.locator("#close-plugins").click();
	await expect(row.locator(".showcase-chip")).toHaveText("showcase of widget");

	// Unlink (✕ in the "Demo of" line): the Demo buttons are gone
	await row.locator(".showcase-chip").click();
	await card.locator(".showcase-linked").getByRole("button", { name: "✕" }).click();
	await expect(message).toContainText("Removed the link");
	await expect(card.locator(".showcase-linked")).toHaveCount(0);
	expect(desk.config().webWikis[0].linkedPlugins).toBeUndefined();
	await dialog.locator("[data-tab=store]").click();
	await expect(stored.getByRole("button", { name: "Demo" })).toHaveCount(0);
});

test("web wiki: address checks, unreachable site, new address with a new baseline, a page that isn't a wiki", async ({ desk, server }) => {
	const url = server.setPage("/down/index.html", tw.wikiHtml([{ title: "Note", text: "here" }]));
	const plainUrl = server.setPage("/plain/index.html", "<!doctype html><html><head><title>Plain</title></head><body><p>Just a page</p></body></html>");
	const page = await desk.launch();
	const error = page.locator("#link-error");
	const fill = async address => {
		await page.locator("#link-form [name=url]").fill(address);
		await page.locator("#link-form button[type=submit]").click();
	};

	await desk.newMenu("Web wiki link…");
	await fill("not an address");
	await expect(error).toHaveText("Please enter a web address, e.g. https://groktiddlywiki.com/read/");
	await fill("ftp://example.org/wiki.html");
	await expect(error).toHaveText("Only http and https addresses are supported.");
	// Without a name, the host is used
	await fill(url);
	await expect(page.locator("#link-dialog")).not.toBeVisible();
	const host = new URL(url).host;
	const row = desk.webRow(host);
	await expect(row).toBeVisible();
	await expect.poll(() => (desk.config().webWikis[0].check || {}).result).toBe("same");
	const link = desk.config().webWikis[0];
	const baselineFile = path.join(desk.userData, "web", link.id, "baseline.json");
	const baseline = () => JSON.parse(fs.readFileSync(baselineFile, "utf8"));
	expect(baseline().url).toBe(url);

	// The same address twice
	await desk.newMenu("Web wiki link…");
	await fill(url);
	await expect(error).toHaveText("This address is already in the list as \"" + host + "\".");
	await page.locator("#cancel-link").click();

	// The site is down: "unreachable", with the reason in the tooltip; back up: the chip goes away
	server.removePage("/down/index.html");
	await desk.rowMenu(row, "Check for changes");
	await expect(row.locator(".git-chip.bad")).toHaveText("unreachable");
	await expect(row.locator(".git-chip.bad")).toHaveAttribute("title", /HTTP 404/);
	server.setPage("/down/index.html", tw.wikiHtml([{ title: "Note", text: "here" }]));
	await desk.rowMenu(row, "Check for changes");
	await expect(row.locator(".git-chip.bad")).toHaveCount(0);
	expect(desk.config().webWikis[0].check.result).toBe("same");

	// A new address: the old baseline says nothing about it, so a new one is recorded
	await desk.rowMenu(row, "Edit…");
	await expect(page.locator("#link-form [name=name]")).toHaveValue(host);
	await page.locator("#link-form [name=name]").fill("Plain");
	await fill(plainUrl);
	await expect(page.locator("#link-dialog")).not.toBeVisible();
	await expect.poll(() => baseline().url).toBe(plainUrl);
	await desk.webIdle();
	expect(desk.config().webWikis[0]).toMatchObject({ id: link.id, name: "Plain", url: plainUrl });
	expect(desk.config().webWikis[0].check.result).toBe("same");

	// It isn't a TiddlyWiki: no snapshot, an error message instead
	const plainRow = desk.webRow("Plain");
	await desk.rowMenu(plainRow, "Save snapshot");
	await expect.poll(async () => (await page.evaluate(() => window.testDialogs)).length).toBe(1);
	expect(await desk.takeDialogs()).toEqual([{ type: "alert", message: "This doesn't look like a TiddlyWiki: " + plainUrl }]);
	await desk.webIdle();
	expect(desk.config().webWikis[0].snapshot).toBeUndefined();
	expect(fs.existsSync(path.join(desk.userData, "web", link.id, "snapshot.html"))).toBe(false);
	await expect(plainRow.getByRole("button", { name: "Open ↗", exact: true })).toBeVisible();
});

test("closing a snapshot with changes asks instead of silently refusing", async ({ desk, server }) => {
	const url = server.setPage("/changed/index.html", tw.wikiHtml([{ title: "Note", text: "on the site" }]));
	const page = await desk.launch();
	await page.evaluate(async address => {
		const id = await window.twDesk.webWikis.save({ url: address, name: "Site" });
		await window.twDesk.webWikis.saveSnapshot(id);
	}, url);
	await desk.webIdle();
	const row = desk.webRow("Site");
	const win = await desk.windowOpenedBy(() => row.getByRole("button", { name: "Open", exact: true }).click());
	await expect.poll(() => win.evaluate(() => window.$tw && $tw.wiki && $tw.wiki.getTiddlerText("Note")), { timeout: 30000 }).toBe("on the site");

	// A change, made as a user gesture (Chromium only lets a page hold up closing after the user did something there)
	await desk.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith("snapshot.html"))
		.webContents.executeJavaScript("$tw.wiki.addTiddler({ title: 'Changed here', text: 'lost on close' }); true", true));
	// TiddlyWiki counts it as unsaved
	await expect(win.locator("body.tc-dirty")).toHaveCount(1);
	const snapshotWindows = () => desk.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith("snapshot.html")).length);
	const close = () => desk.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith("snapshot.html")).close());
	const questions = async () => (await desk.mainCalls()).questions;

	// "Stay": the window stays open
	await desk.answer(1);
	await close();
	await expect.poll(questions).toEqual(["Close the snapshot of “Site”?"]);
	expect(await snapshotWindows()).toBe(1);

	// "Close anyway": it closes
	await desk.answer(0);
	await close();
	await expect.poll(snapshotWindows).toBe(0);
	expect(await questions()).toHaveLength(2);
});

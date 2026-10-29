"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect, tw } = require("./fixtures");
const { pluginTiddler } = require("../helpers/server");

const WIDGET = "$:/plugins/demo/widget";
const HELPER = "$:/plugins/demo/helper";

// A showcase link with a saved snapshot, set up through the API (the UI for this is tested in web.spec.js)
async function addShowcase(page, name, url) {
	return page.evaluate(async ([name, url]) => {
		const id = await window.twDesk.webWikis.save({ url, name, showcase: true });
		await window.twDesk.webWikis.saveSnapshot(id);
		return id;
	}, [name, url]);
}

test("two showcases for one plugin, links kept on edit, Unlink, a snapshot that lost the plugin", async ({ desk, server }) => {
	const firstUrl = server.setPage("/first/index.html", tw.wikiHtml([pluginTiddler(WIDGET, "1.0.0"), pluginTiddler(HELPER, "1.0.0")]));
	const secondUrl = server.setPage("/second/index.html", tw.wikiHtml([pluginTiddler(WIDGET, "1.1.0")]));
	// Alpha uses the widget (from the store, installed below)
	const alpha = desk.wiki("alpha");
	const infoFile = path.join(alpha, "tiddlywiki.info");
	const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
	info.plugins = (info.plugins || []).concat("demo/widget");
	fs.writeFileSync(infoFile, JSON.stringify(info, null, 4));
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const firstId = await addShowcase(page, "First", firstUrl);
	const secondId = await addShowcase(page, "Second", secondUrl);
	await page.evaluate(id => window.twDesk.plugins.install("showcase:" + id, "$:/plugins/demo/widget"), firstId);
	await desk.webIdle();

	const dialog = page.locator("#plugins-dialog");
	const message = page.locator("#plugins-message");
	const card = name => dialog.locator("#tab-showcases .card").filter({ has: page.locator(".card-title strong", { hasText: new RegExp("^" + name + "$") }) });
	const plugin = (name, title) => card(name).locator("tr", { hasText: title });

	// Link the widget to both showcases, and the helper to the first
	await page.locator("#show-plugins").click();
	await dialog.locator("[data-tab=showcases]").click();
	for (const [name, title] of [["First", "demo/widget"], ["First", "demo/helper"], ["Second", "demo/widget"]]) {
		if (!(await card(name).locator("details").evaluate(d => d.open))) {
			await card(name).locator("details summary").click();
		}
		await plugin(name, title).getByRole("button", { name: "Link", exact: true }).click();
		await expect(message).toContainText("Linked $:/plugins/" + title + " to the showcase " + name);
	}
	await expect(card("First").locator("details summary")).toContainText("· 2 linked");
	await expect(card("First").locator(".showcase-linked .chip")).toHaveText([/^demo\/helper 1\.0\.0/, /^demo\/widget 1\.0\.0/]);

	// Wikis tab: one Demo and one Website pill per showcase, named after it; the Demo pills show their snapshot's version,
	// and the one that differs from the wiki's is marked
	await dialog.locator("[data-tab=wikis]").click();
	const used = dialog.locator("#tab-wikis .card", { hasText: "Alpha" }).locator("tr", { hasText: "demo/widget" });
	await expect(used.locator(".badge").first()).toHaveText("store 1.0.0");
	await expect(used.locator("button.demo")).toHaveText(["Demo: First (1.0.0)", "Website: First ↗", "Demo: Second (1.1.0)", "Website: Second ↗"]);
	await expect(used.locator(".demo-link .badge")).toHaveText(["demo shows 1.1.0"]);
	const win = await desk.windowOpenedBy(() => used.getByRole("button", { name: "Demo: Second (1.1.0)", exact: true }).click());
	expect(win.url()).toContain(secondId);
	await win.close();
	await used.getByRole("button", { name: "Website: First ↗", exact: true }).click();
	await expect.poll(async () => (await desk.mainCalls()).opened).toContain(firstUrl);
	await dialog.locator("#close-plugins").click();

	// The main window names what each showcase demonstrates
	await expect(desk.webRow("First").locator(".showcase-chip")).toHaveText("showcase of helper +1");
	await expect(desk.webRow("Second").locator(".showcase-chip")).toHaveText("showcase of widget");

	// Editing the link keeps its plugin links (and its snapshot)
	await desk.rowMenu(desk.webRow("First"), "Edit…");
	await expect(page.locator("#link-dialog-title")).toHaveText("Edit web wiki");
	await page.locator("#link-form [name=description]").fill("Widget and helper demos");
	await page.locator("#link-form button[type=submit]").click();
	await expect(desk.webRow("First").locator(".wiki-description")).toHaveText("Widget and helper demos");
	const first = desk.config().webWikis.find(l => l.id === firstId);
	expect(first.linkedPlugins).toEqual([HELPER, WIDGET]);
	expect(first.snapshot).toBeTruthy();
	await expect(desk.webRow("First").locator(".showcase-chip")).toHaveText("showcase of helper +1");

	// The second site drops the widget: after a new snapshot the link says so, and so does its Demo pill
	server.setPage("/second/index.html", tw.wikiHtml([{ title: "Note", text: "no plugins any more" }]));
	await page.locator("#show-plugins").click();
	await dialog.locator("[data-tab=showcases]").click();
	await card("Second").getByRole("button", { name: "Update snapshot" }).click();
	await expect(message).toContainText("Saved the snapshot of Second.");
	await expect(card("Second").locator(".showcase-linked .chip.missing")).toContainText("demo/widget – not in the snapshot");
	// (only TiddlyWiki's own themes are left in the list; every single-file wiki has those)
	await expect(plugin("Second", "demo/widget")).toHaveCount(0);
	await dialog.locator("[data-tab=wikis]").click();
	await expect(used.locator(".demo-link .badge")).toHaveText(["not in the demo"]);
	await expect(used.locator("button.demo")).toHaveText(["Demo: First (1.0.0)", "Website: First ↗", "Demo: Second", "Website: Second ↗"]);

	// "Unlink" in the plugin table (the other way besides ✕)
	await dialog.locator("[data-tab=showcases]").click();
	await plugin("First", "demo/widget").getByRole("button", { name: "Unlink", exact: true }).click();
	await expect(message).toContainText("Removed the link between $:/plugins/demo/widget and the showcase First.");
	await expect(plugin("First", "demo/widget").getByRole("button", { name: "Link", exact: true })).toBeVisible();
	expect(desk.config().webWikis.find(l => l.id === firstId).linkedPlugins).toEqual([HELPER]);
	await dialog.locator("[data-tab=wikis]").click();
	await expect(used.locator("button.demo")).toHaveText(["Demo", "Website ↗"]);
	await dialog.locator("#close-plugins").click();
	await expect(desk.webRow("First").locator(".showcase-chip")).toHaveText("showcase of helper");
});

test("+ Add showcase with a page that isn't a wiki: the error is shown, the link stays without a snapshot", async ({ desk, server }) => {
	const url = server.setPage("/plain/index.html", "<!doctype html><html><head><title>Plain</title></head><body><p>Just a page</p></body></html>");
	const page = await desk.launch();
	const dialog = page.locator("#plugins-dialog");
	const message = page.locator("#plugins-message");

	await page.locator("#show-plugins").click();
	await dialog.locator("[data-tab=showcases]").click();
	await dialog.getByRole("button", { name: "+ Add showcase" }).click();
	await page.locator("#link-form [name=url]").fill(url);
	await page.locator("#link-form [name=name]").fill("Plain");
	await page.locator("#link-form button[type=submit]").click();
	await expect(message).toContainText("This doesn't look like a TiddlyWiki: " + url);
	await expect(message).toHaveClass(/error/);
	await expect(dialog.locator("#tab-showcases .card", { hasText: "Plain" })).toContainText("No snapshot yet");
	await dialog.locator("#close-plugins").click();

	await expect(desk.webRow("Plain").locator(".showcase-chip")).toHaveText("showcase · no snapshot yet");
	const link = desk.config().webWikis[0];
	expect(link).toMatchObject({ name: "Plain", showcase: true });
	expect(link.snapshot).toBeUndefined();
	expect(fs.existsSync(path.join(desk.userData, "web", link.id, "snapshot.html"))).toBe(false);
});

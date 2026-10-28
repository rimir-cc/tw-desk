"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect, tw, sh } = require("./fixtures");
const { pluginTiddler } = require("../helpers/server");

const today = () => new Date().toISOString().slice(0, 10);

// A wiki folder as its own repository, pushed to a bare remote next to it
function pushedRepo(desk, folder) {
	const remote = path.join(desk.root, "remotes", path.basename(folder) + ".git");
	fs.mkdirSync(path.dirname(remote), { recursive: true });
	sh(desk.root, "init", "--bare", "--quiet", remote);
	sh(folder, "init", "--quiet");
	sh(folder, "add", "-A");
	sh(folder, "commit", "--quiet", "-m", "start");
	sh(folder, "remote", "add", "origin", remote);
	sh(folder, "push", "--quiet", "-u", "origin", "main");
	return remote;
}

test("export a setup and import it on another computer: clones, store, web wiki with snapshot, settings", async ({ desk, server }) => {
	// Alpha includes shared; both are repositories with remotes. Priv has no git and isn't exported
	const alpha = desk.wiki("alpha");
	const shared = desk.wiki("shared");
	const infoFile = path.join(alpha, "tiddlywiki.info");
	const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
	info.includeWikis = ["../shared"];
	info.plugins = (info.plugins || []).concat("test/hello");
	fs.writeFileSync(infoFile, JSON.stringify(info, null, 4));
	const alphaRemote = pushedRepo(desk, alpha);
	pushedRepo(desk, shared);
	const priv = desk.wiki("priv", "alpha");
	server.setLibrary([pluginTiddler("$:/plugins/test/hello", "1.0.0")]);
	const siteUrl = server.setPage("/setup-site/index.html", tw.wikiHtml([{ title: "Note", text: "on the site" }]));

	let page = await desk.launch({
		groups: [{ id: "g1", name: "Work" }],
		wikis: [{ name: "Alpha", path: alpha, group: "g1", description: "Exported wiki" }, { name: "Priv", path: priv }]
	});
	await page.evaluate(url => window.twDesk.plugins.install(url, "$:/plugins/test/hello"), server.libraryUrl);
	await page.evaluate(async url => {
		const id = await window.twDesk.webWikis.save({ url, name: "Site", description: "A site" });
		await window.twDesk.webWikis.saveSnapshot(id);
	}, siteUrl);
	await desk.webIdle();

	// ---------- export ----------
	// Through desk.page: after relaunchFresh() it's the new window
	const setupDialog = () => desk.page.locator("#setup-dialog");
	const body = () => desk.page.locator("#setup-body");
	const item = text => body().locator(".setup-list li", { hasText: text });
	await page.locator("#show-settings").click();
	await page.locator("#export-setup").click();
	await expect(page.locator("#setup-title")).toHaveText("Export setup");
	await expect(item("Alpha")).toContainText("⎇ " + alphaRemote + " · main");
	await expect(item("Priv")).toContainText("not in git");
	await expect(body()).toContainText("Included folders come along");
	await item("Priv").locator("input").uncheck();
	await item("Snapshots of web wikis (1,").locator("input").check();
	const file = path.join(desk.root, "tw-desk-setup.json");
	await desk.saveAs(file);
	await page.locator("#setup-run").click();
	await expect(page.locator("#setup-message")).toHaveText("Exported 1 wiki (2 folders), 1 web wiki and 1 plugin to " + file + ".");
	await page.locator("#setup-run").click();
	await expect(setupDialog()).not.toBeVisible();

	const exported = JSON.parse(fs.readFileSync(file, "utf8"));
	expect(exported.origin.base).toBe(desk.wikisDir);
	expect(exported.folders.map(f => f.folder).sort()).toEqual(["alpha", "shared"]);
	expect(exported.wikis).toEqual([{ name: "Alpha", folder: "alpha", description: "Exported wiki", autostart: false, group: "Work" }]);
	expect(exported.webWikis[0].snapshotHtml).toContain("on the site");
	expect(exported.store.map(p => p.fields.title)).toEqual(["$:/plugins/test/hello"]);

	// ---------- import on "another computer": empty TW Desk, the wikis go to another folder ----------
	page = await desk.relaunchFresh();
	const elsewhere = path.join(desk.root, "elsewhere");
	await desk.pick(file);
	await desk.newMenu("Import setup…");
	await expect(page.locator("#setup-title")).toHaveText("Import setup");
	// The original folder exists on this test machine, so it's suggested; choose another one
	await expect(body().locator("input[name=base]")).toHaveValue(desk.wikisDir);
	await expect(item("Alpha")).toContainText("add to TW Desk");
	await desk.pick(elsewhere);
	await body().getByRole("button", { name: "Browse…" }).click();
	await expect(body().locator("input[name=base]")).toHaveValue(elsewhere);
	await expect(item("Alpha")).toContainText("clone from " + alphaRemote + " (main)");
	await expect(item("shared (included folder)")).toContainText("clone");
	await expect(item("Site")).toContainText("with its snapshot");
	await expect(item("Put 1 plugin into the store").locator("input")).toBeChecked();
	await expect(item("Use the settings from the file").locator("input")).toBeChecked();

	await page.locator("#setup-run").click();
	const report = body().locator(".setup-report li");
	await expect(report.first()).toBeVisible({ timeout: 60000 });
	await expect(body().locator(".setup-report li.failed")).toHaveCount(0);
	await expect(report).toHaveText([
		/^✓ Cloned .*alpha\.git into .*alpha\.$/,
		/^✓ Cloned .*shared\.git into .*shared\.$/,
		"✓ Added the wiki “Alpha” (" + path.join(elsewhere, "alpha") + ").",
		/^✓ Added the web wiki “Site” with its snapshot of \d{4}-\d\d-\d\d\.$/,
		"✓ Put 1 plugin into the store.",
		"✓ Applied the settings (start port 18390)."
	]);
	await page.locator("#setup-run").click();
	await expect(setupDialog()).not.toBeVisible();

	// The wiki is in its group, serves the included folder and loads the plugin from the store
	await expect(desk.groupHeader("Work")).toBeVisible();
	await expect(desk.row("Alpha").locator(".wiki-description")).toHaveText("Exported wiki");
	expect(desk.config().wikis[0]).toMatchObject({ name: "Alpha", path: path.join(elsewhere, "alpha") });
	const port = await desk.startWiki("Alpha");
	expect(await desk.tiddler(port, "SharedNote")).not.toBeNull();
	expect((await desk.tiddler(port, "$:/plugins/test/hello")).version).toBe("1.0.0");
	// The web wiki has the snapshot from the file
	await expect(desk.webRow("Site").locator(".wiki-meta")).toContainText("snapshot " + today());
	await desk.webIdle();

	// Importing again: everything is already there
	await desk.pick(file);
	await desk.newMenu("Import setup…");
	await desk.pick(elsewhere);
	await body().getByRole("button", { name: "Browse…" }).click();
	await expect(item("Alpha")).toContainText("already there");
	await expect(item("Site")).toContainText("already in TW Desk");
	await expect(body()).toContainText("1 kept (the store has the same or a newer version)");
	await expect(item("Alpha").locator("input")).toBeDisabled();
	await page.locator("#setup-cancel").click();
});

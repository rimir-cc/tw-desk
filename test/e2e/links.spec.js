"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { test, expect, BASE_PORT, tw } = require("./fixtures");

const ROUTER_PORT = BASE_PORT - 10;

// The tiddler titles in the window's story river, top first
function story(win) {
	return win.evaluate(() => $tw.wiki.getTiddlerList("$:/StoryList"));
}

async function wikiReady(win) {
	await expect.poll(() => win.evaluate(() => !!(window.$tw && $tw.Story && document.querySelector(".tc-story-river"))), { timeout: 30000 }).toBe(true);
}

async function navigate(win, title) {
	await win.evaluate(target => new $tw.Story({ wiki: $tw.wiki }).navigateTiddler(target), title);
	const frame = win.locator(".tc-tiddler-frame[data-tiddler-title=\"" + title + "\"]");
	await expect(frame).toBeVisible();
	return frame;
}

// The app windows showing this wiki's server, and whether the first one is minimized
function wikiWindows(desk, port) {
	return desk.app.evaluate(({ BrowserWindow }, address) => {
		const found = BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().startsWith(address));
		return { count: found.length, minimized: found.length ? found[0].isMinimized() : null };
	}, "http://127.0.0.1:" + port + "/");
}

// A link clicked in another program reaches the running TW Desk like this (second start with the URL)
function fromOtherProgram(desk, url) {
	return desk.app.evaluate(({ app }, link) => app.emit("second-instance", {}, ["TW Desk.exe", link], ""), url);
}

function get(url, headers = {}) {
	return new Promise((resolve, reject) => {
		http.get(url, { headers }, res => {
			let body = "";
			res.on("data", chunk => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body }));
		}).on("error", reject);
	});
}

test("TW Desk links: copy button, follow to a stopped and to a minimized wiki, unknown name, links from other programs", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	tw.writeTiddler(alpha, "Links", "[ext[Note (other)|twdesk://other/Note]]\n\n[ext[Second (other)|twdesk://other/Second]]\n\n[ext[nowhere|twdesk://nowhere/X]]");
	const other = desk.wiki("other", "alpha");
	tw.writeTiddler(other, "Note", "the note");
	tw.writeTiddler(other, "Second", "the second note");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }, { name: "Other", path: other }] });

	const alphaWin = await desk.windowOpenedBy(() => desk.row("Alpha").getByRole("button", { name: "Open", exact: true }).click());
	await wikiReady(alphaWin);
	const links = await navigate(alphaWin, "Links");

	// The built-in plugin's button: TW Desk copies the link (in the configured form) and the wiki says so
	await links.getByRole("button", { name: "copy TW Desk link" }).click();
	await expect.poll(async () => (await desk.mainCalls()).copied).toEqual(["[ext[Links (alpha)|twdesk://alpha/Links]]"]);
	await expect(alphaWin.locator(".tc-notification")).toContainText("TW Desk link copied");

	// To a stopped wiki: started, its window opened, the tiddler shown
	const otherWin = await desk.windowOpenedBy(() => links.locator("a", { hasText: "Note (other)" }).click());
	await expect(desk.row("Other").locator(".wiki-meta")).toContainText("running");
	await wikiReady(otherWin);
	await expect.poll(() => story(otherWin).then(list => list[0])).toBe("Note");

	// To a wiki whose window is minimized: the same window comes back, with the tiddler on top
	const otherPort = (await desk.wikiState("Other")).port;
	await desk.app.evaluate(({ BrowserWindow }, address) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(address)).minimize(), "http://127.0.0.1:" + otherPort + "/");
	await expect.poll(() => wikiWindows(desk, otherPort)).toEqual({ count: 1, minimized: true });
	await links.locator("a", { hasText: "Second (other)" }).click();
	await expect.poll(() => wikiWindows(desk, otherPort)).toEqual({ count: 1, minimized: false });
	await expect.poll(() => story(otherWin).then(list => list.slice(0, 2))).toEqual(["Second", "Note"]);

	// An unknown link name is reported
	await links.locator("a", { hasText: "nowhere" }).click();
	await expect.poll(async () => (await desk.mainCalls()).questions).toEqual(["No wiki with the link name “nowhere” in TW Desk."]);

	// A twdesk:// link clicked in another program
	await fromOtherProgram(desk, "twdesk://alpha/Hello");
	await expect.poll(() => story(alphaWin).then(list => list[0])).toBe("Hello");
});

test("link names: same folder names reported and resolved; http links via the router; copied form as set", async ({ desk }) => {
	const first = desk.wiki("alpha");
	fs.mkdirSync(path.join(desk.wikisDir, "sub"));
	const second = desk.wiki(path.join("sub", "alpha"), "alpha");
	tw.writeTiddler(first, "HttpLink", "[[to the second|http://127.0.0.1:" + ROUTER_PORT + "/open/alpha-two/Hello]]");
	const page = await desk.launch({ wikis: [{ name: "First", path: first }, { name: "Second", path: second }] });

	// Both have the link name "alpha" (their folders' name)
	for (const name of ["First", "Second"]) {
		await expect(desk.row(name).locator(".link-chip")).toHaveText("link name “alpha” used twice");
	}
	// A link to it asks which one
	await desk.answer(1);
	const secondWin = await desk.windowOpenedBy(() => fromOtherProgram(desk, "twdesk://alpha/Hello"));
	expect((await desk.mainCalls()).questions).toEqual(["Several wikis have the link name “alpha”."]);
	expect(secondWin.url()).toBe("http://127.0.0.1:" + (await desk.wikiState("Second")).port + "/");
	await secondWin.close();

	// Its own link name, from the chip (Edit dialog); a taken name is refused
	await desk.row("Second").locator(".link-chip").click();
	await expect(page.locator("#dialog-title")).toHaveText("Edit wiki");
	await expect(page.locator("#wiki-form [name=linkName]")).toHaveAttribute("placeholder", "alpha");
	await page.locator("#wiki-form [name=linkName]").fill("alpha");
	await page.locator("#save-dialog").click();
	await expect(page.locator("#form-error")).toHaveText("The link name “alpha” is already used by “First”.");
	await page.locator("#wiki-form [name=linkName]").fill("alpha-two");
	await page.locator("#save-dialog").click();
	await expect(page.locator("#wiki-dialog")).not.toBeVisible();
	await expect(page.locator(".link-chip")).toHaveCount(0);
	expect(desk.config().wikis.find(w => w.name === "Second").linkName).toBe("alpha-two");

	// Settings: copy http links, and answer them in browsers
	await page.locator("#show-settings").click();
	await expect(page.locator("#settings-form input[name=linkStyle][value=scheme]")).toBeChecked();
	await expect(page.locator("#link-scheme-status")).toHaveText("(only the installed TW Desk registers it)");
	await page.locator("#settings-form input[name=linkStyle][value=http]").check();
	await page.locator("#settings-form [name=linkPort]").fill(String(ROUTER_PORT));
	await page.locator("#settings-form [name=linkRouter]").check();
	await page.locator("#settings-form button[type=submit]").click();
	await expect(page.locator("#settings-dialog")).not.toBeVisible();
	expect(desk.config().links).toEqual({ style: "http", port: ROUTER_PORT, router: true, scheme: true, plugin: true });

	// The router: starts the wiki and sends the browser there; asks first when another website sent it
	const router = "http://127.0.0.1:" + ROUTER_PORT;
	const answer = await get(router + "/open/alpha-two/Hello%20there");
	expect(answer.status).toBe(302);
	expect(answer.location).toBe("http://127.0.0.1:" + (await desk.wikiState("Second")).port + "/#Hello%20there");
	const asked = await get(router + "/open/alpha/Hello", { "Sec-Fetch-Site": "cross-site" });
	expect(asked.status).toBe(200);
	expect(asked.body).toContain("Open it with TW Desk");
	expect((await desk.wikiState("First")).status).toBe("stopped");
	expect((await get(router + "/open/nowhere/X")).status).toBe(404);

	// Copied links now use the http form; an http link in a TW Desk window is followed there, router or not
	const firstWin = await desk.windowOpenedBy(() => desk.row("First").getByRole("button", { name: "Open", exact: true }).click());
	await wikiReady(firstWin);
	const hello = await navigate(firstWin, "Hello");
	await hello.getByRole("button", { name: "copy TW Desk link" }).click();
	await expect.poll(async () => (await desk.mainCalls()).copied).toEqual(["[[Hello (alpha)|" + router + "/open/alpha/Hello]]"]);
	const httpLink = await navigate(firstWin, "HttpLink");
	const opened = await desk.windowOpenedBy(() => httpLink.locator("a", { hasText: "to the second" }).click());
	await wikiReady(opened);
	await expect.poll(() => story(opened).then(list => list[0])).toBe("Hello");
});

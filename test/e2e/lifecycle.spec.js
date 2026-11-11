"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { test, expect, BASE_PORT, tw } = require("./fixtures");

test("start, serve, save, stop and restart on the same port", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const row = desk.row("Alpha");
	const meta = row.locator(".wiki-meta");
	await expect(meta).toContainText("stopped");

	await row.getByRole("button", { name: "Start", exact: true }).click();
	await expect(meta).toContainText("running", { timeout: 60000 });
	const port = (await desk.wikiState("Alpha")).port;
	expect(port).toBeGreaterThanOrEqual(BASE_PORT);
	await expect(meta).toContainText("port " + port);

	// The server serves the folder with the bundled TiddlyWiki
	const status = await (await desk.http(port, "/status")).json();
	expect(status.tiddlywiki_version).toBe(tw.TW_VERSION);
	expect((await desk.tiddler(port, "Hello")).text).toBe("Hello from alpha");

	// Saving through the server (as the wiki in the window does) writes into the folder
	const saved = await desk.http(port, "/recipes/default/tiddlers/Saved", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title: "Saved", text: "written through the server" })
	});
	expect(saved.status).toBeLessThan(300);
	await expect.poll(() => fs.existsSync(path.join(alpha, "tiddlers", "Saved.tid"))).toBe(true);

	await row.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(meta).toContainText("stopped");
	await expect(desk.http(port, "/status")).rejects.toThrow();

	// The remembered port is used again
	expect(desk.config().wikis[0].lastPort).toBe(port);
	await row.getByRole("button", { name: "Start", exact: true }).click();
	await expect(meta).toContainText("running", { timeout: 60000 });
	expect((await desk.wikiState("Alpha")).port).toBe(port);
});

test("Open shows the wiki in an app window", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const row = desk.row("Alpha");

	// Open also starts the server
	const win = await desk.windowOpenedBy(() => row.getByRole("button", { name: "Open", exact: true }).click());
	await expect(row.locator(".wiki-meta")).toContainText("running");
	const port = (await desk.wikiState("Alpha")).port;
	expect(win.url()).toBe("http://127.0.0.1:" + port + "/");
	await expect.poll(() => win.evaluate(() => window.$tw && $tw.wiki && $tw.wiki.getTiddlerText("Hello")), { timeout: 30000 }).toBe("Hello from alpha");

	// Open again while that window is minimized: it comes back (no second window)
	const wikiWindows = () => desk.app.evaluate(({ BrowserWindow }, address) => {
		const found = BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().startsWith(address));
		return { count: found.length, minimized: found.length ? found[0].isMinimized() : null };
	}, win.url());
	await desk.app.evaluate(({ BrowserWindow }, address) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(address)).minimize(), win.url());
	await expect.poll(wikiWindows).toEqual({ count: 1, minimized: true });
	await row.getByRole("button", { name: "Open", exact: true }).click();
	await expect.poll(wikiWindows).toEqual({ count: 1, minimized: false });

	// "Open in browser" goes to the default browser (stubbed)
	await desk.rowMenu(row, "Open in browser");
	await expect.poll(async () => (await desk.mainCalls()).opened).toContain("http://127.0.0.1:" + port + "/");
});

test("automatic ports skip a busy port; a fixed port is used as given", async ({ desk }) => {
	const blocker = net.createServer();
	await new Promise(resolve => blocker.listen(BASE_PORT, "127.0.0.1", resolve));
	try {
		const fixed = BASE_PORT + 7;
		await desk.launch({ wikis: [
			{ name: "Alpha", path: desk.wiki("alpha") },
			{ name: "Fixed", path: desk.wiki("fixed", "alpha"), fixedPort: fixed }
		] });
		for (const name of ["Alpha", "Fixed"]) {
			await desk.row(name).getByRole("button", { name: "Start", exact: true }).click();
			await expect(desk.row(name).locator(".wiki-meta")).toContainText("running", { timeout: 60000 });
		}
		const alphaPort = (await desk.wikiState("Alpha")).port;
		expect(alphaPort).toBeGreaterThan(BASE_PORT);
		expect(alphaPort).not.toBe(fixed);
		expect((await desk.wikiState("Fixed")).port).toBe(fixed);
		await expect(desk.row("Fixed").locator(".wiki-meta")).toContainText("port " + fixed + " (fixed)");
	} finally {
		blocker.close();
	}
});

// ---------- Restart ----------

const startCount = async (desk, name) => {
	const id = (await desk.wikiState(name)).id;
	return ((await desk.page.evaluate(wiki => window.twDesk.getLogs(wiki), id)).join("\n").match(/Starting TiddlyWiki/g) || []).length;
};

test("Restart restarts the server and reloads its open window", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const row = desk.row("Alpha");
	await expect(row.getByRole("button", { name: "Restart", exact: true })).toHaveCount(0);
	const win = await desk.windowOpenedBy(() => row.getByRole("button", { name: "Open", exact: true }).click());
	await expect.poll(() => win.evaluate(() => window.$tw && $tw.wiki && $tw.wiki.getTiddlerText("Hello")), { timeout: 30000 }).toBe("Hello from alpha");
	const port = (await desk.wikiState("Alpha")).port;
	// TiddlyWiki reads tiddler files only when it starts
	fs.writeFileSync(path.join(alpha, "tiddlers", "Fresh.tid"), "title: Fresh\n\nadded on disk");
	await row.getByRole("button", { name: "Restart", exact: true }).click();
	await expect.poll(() => win.evaluate(() => window.$tw && $tw.wiki && $tw.wiki.getTiddlerText("Fresh")).catch(() => null), { timeout: 60000 }).toBe("added on disk");
	await expect(row.locator(".wiki-meta")).toContainText("running");
	expect(await startCount(desk, "Alpha")).toBe(2);
	expect((await desk.wikiState("Alpha")).port).toBe(port);
	const windows = await desk.app.evaluate(({ BrowserWindow }, address) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().startsWith(address)).length, win.url());
	expect(windows).toBe(1);
	expect((await desk.mainCalls()).questions).toEqual([]);
});

test("Restart asks first when the open window has unsaved changes", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const row = desk.row("Alpha");
	const win = await desk.windowOpenedBy(() => row.getByRole("button", { name: "Open", exact: true }).click());
	await expect.poll(() => win.evaluate(() => !!(window.$tw && $tw.syncer)), { timeout: 30000 }).toBe(true);
	await win.evaluate(() => {
		$tw.syncer.isDirty = () => true;
	});
	// No answer: the default is not to restart
	await desk.rowMenu(row, "Restart");
	await expect.poll(async () => (await desk.mainCalls()).questions.join("\n")).toContain("unsaved changes");
	await desk.page.waitForTimeout(1000);
	expect(await startCount(desk, "Alpha")).toBe(1);
	// Restart anyway
	await desk.answer(0);
	await desk.rowMenu(row, "Restart");
	await expect.poll(() => startCount(desk, "Alpha"), { timeout: 60000 }).toBe(2);
	await expect(row.locator(".wiki-meta")).toContainText("running", { timeout: 60000 });
});

test("wiki windows open at 2700 × 1400, at most the screen's size", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const win = await desk.windowOpenedBy(() => desk.row("Alpha").getByRole("button", { name: "Open", exact: true }).click());
	const sizes = await desk.app.evaluate(({ BrowserWindow, screen }, address) => {
		const found = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(address));
		const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize;
		return { size: found.getSize(), area: [area.width, area.height] };
	}, win.url());
	// A window as large as the screen may come out a pixel smaller (X11)
	const expected = [Math.min(2700, sizes.area[0]), Math.min(1400, sizes.area[1])];
	expect(Math.abs(sizes.size[0] - expected[0])).toBeLessThanOrEqual(2);
	expect(Math.abs(sizes.size[1] - expected[1])).toBeLessThanOrEqual(2);
});

test("the size of new wiki windows is set in Settings (kept per computer), also from an open window", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const row = desk.row("Alpha");
	const win = await desk.windowOpenedBy(() => row.getByRole("button", { name: "Open", exact: true }).click());
	const sizeOf = address => desk.app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(url)).getSize(), address);
	await desk.app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(url)).setSize(1000, 750), win.url());
	await expect.poll(() => sizeOf(win.url())).toEqual([1000, 750]);

	await desk.page.locator("#show-settings").click();
	const form = desk.page.locator("#settings-form");
	await expect(form.locator("[name=windowWidth]")).toHaveValue("2700");
	await expect(form.locator("[name=windowHeight]")).toHaveValue("1400");
	await form.getByRole("button", { name: "Use the size of an open wiki window" }).click();
	await expect(form.locator("[name=windowWidth]")).toHaveValue("1000");
	await expect(form.locator("[name=windowHeight]")).toHaveValue("750");
	await form.locator("[name=windowWidth]").fill("900");
	await form.locator("[name=windowHeight]").fill("700");
	await form.getByRole("button", { name: "Save" }).click();
	await expect(desk.page.locator("#settings-dialog")).toBeHidden();

	expect(desk.config().windowSize).toEqual({ width: 900, height: 700 });
	expect(desk.rawConfig().windowSize).toBeUndefined();
	await win.close();
	const next = await desk.windowOpenedBy(() => row.getByRole("button", { name: "Open", exact: true }).click());
	expect(await sizeOf(next.url())).toEqual([900, 700]);
});

test("Settings refuses an impossible window size", async ({ desk }) => {
	await desk.launch({});
	await desk.page.locator("#show-settings").click();
	const form = desk.page.locator("#settings-form");
	await form.locator("[name=windowWidth]").fill("50");
	await form.getByRole("button", { name: "Save" }).click();
	await expect(desk.page.locator("#settings-dialog")).toBeVisible();
	expect(await form.locator("[name=windowWidth]").evaluate(input => input.validity.valid)).toBe(false);
	// The main process checks too
	const error = await desk.page.evaluate(() => window.twDesk.saveSettings({ basePort: 18390, gitInterval: 0, gitStaleHours: 24, windowWidth: 50, windowHeight: 700, linkPort: 18999 }).then(() => null, e => e.message));
	expect(error).toContain("window size");
	expect(desk.config().windowSize).toBeUndefined();
});

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

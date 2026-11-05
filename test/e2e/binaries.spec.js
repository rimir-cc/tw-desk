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

test("binaries: includes without tiddlers/ and missing includes", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	// Like TiddlyWiki's empty edition: only tiddlywiki.info
	const empty = path.join(desk.wikisDir, "empty");
	fs.mkdirSync(empty, { recursive: true });
	fs.writeFileSync(path.join(empty, "tiddlywiki.info"), "{}");
	const infoFile = path.join(alpha, "tiddlywiki.info");
	const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
	info.includeWikis = ["../empty"];
	fs.writeFileSync(infoFile, JSON.stringify(info, null, 4));
	putBinary(alpha, "photo.png", "Photo");
	putBinary(alpha, "other.png", "Other", 120);
	await desk.launch({ wikis: [{ name: "Alpha", path: alpha, binaries: EXTERNALIZE }] });
	const row = desk.row("Alpha");
	await expect.poll(() => filesIn(alpha)).toEqual(["other.png", "photo.png"]);

	// The empty include doesn't make the scan incomplete
	fs.unlinkSync(path.join(alpha, "tiddlers", "photo.png.tid"));
	await desk.rowMenu(row, "Apply binary policy now");
	await expect.poll(() => exists(alpha, "files", "photo.png")).toBe(false);

	// A missing include (offline drive): nothing is deleted
	fs.rmSync(empty, { recursive: true });
	fs.unlinkSync(path.join(alpha, "tiddlers", "other.png.tid"));
	await desk.rowMenu(row, "Apply binary policy now");
	await expect(await logText(desk, row)).toContainText("No files deleted: Included folder not found: " + empty);
	expect(exists(alpha, "files", "other.png")).toBe(true);
});

function putFile(folder, name, title, type, bytes) {
	fs.writeFileSync(path.join(folder, "tiddlers", name), bytes);
	fs.writeFileSync(path.join(folder, "tiddlers", name + ".meta"), "title: " + title + "\ntype: " + type + "\n");
}

function filesIn(folder) {
	const dir = path.join(folder, "files");
	return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

async function logText(desk, row) {
	await desk.rowMenu(row, "Log");
	return desk.page.locator("#log-output");
}

test("binaries: delete and update", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	putBinary(alpha, "photo.png", "Photo");
	putFile(alpha, "report.pdf", "Report", "application/pdf", Buffer.alloc(300, 1));
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha, binaries: EXTERNALIZE }] });
	const row = desk.row("Alpha");
	const form = page.locator("#wiki-form");

	// The start-up run externalizes both (and only records what's in use)
	await expect.poll(() => filesIn(alpha)).toEqual(["photo.png", "report.pdf"]);

	// A removed tiddler: its file goes (to the backup, the wiki isn't in git)
	fs.unlinkSync(path.join(alpha, "tiddlers", "photo.png.tid"));
	await desk.rowMenu(row, "Apply binary policy now");
	await expect.poll(() => exists(alpha, "files", "photo.png")).toBe(false);
	await expect(await logText(desk, row)).toContainText("Deleted files/photo.png – its tiddler was removed");
	await expect(page.locator("#log-output")).toContainText("Backed up files/photo.png to ");

	// An update via the marker replaces the file in place
	const fresh = Buffer.alloc(500, 9);
	fs.writeFileSync(path.join(alpha, "tiddlers", "report.pdf"), fresh);
	fs.writeFileSync(path.join(alpha, "tiddlers", "report.pdf.meta"), "title: Report\ntype: application/pdf\ntw-desk-update-of: files/report.pdf\n");
	fs.unlinkSync(path.join(alpha, "tiddlers", "report.pdf.tid"));
	await desk.rowMenu(row, "Apply binary policy now");
	await expect.poll(() => exists(alpha, "tiddlers", "report.pdf.tid")).toBe(true);
	await expect.poll(() => fs.readFileSync(path.join(alpha, "files", "report.pdf")).equals(fresh)).toBe(true);
	const tid = fs.readFileSync(path.join(alpha, "tiddlers", "report.pdf.tid"), "utf8");
	expect(tid).toContain("_canonical_uri: files/report.pdf");
	expect(tid).not.toContain("tw-desk-update-of");
	expect(exists(alpha, "tiddlers", "report.pdf")).toBe(false);
	await expect(await logText(desk, row)).toContainText("Updated files/report.pdf");
	const backups = path.join(desk.userData, "backup");
	const stamps = fs.readdirSync(backups);
	expect(stamps.some(s => exists(backups, s, path.basename(alpha), "files", "report.pdf"))).toBe(true);
	expect(stamps.some(s => exists(backups, s, path.basename(alpha), "files", "photo.png"))).toBe(true);

	// Switching the policy away and back forgets the record: the next run only records
	await desk.rowMenu(row, "Edit…");
	await form.locator("[name=binaryPolicy]").selectOption("leave");
	await page.locator("#save-dialog").click();
	await expect(page.locator("#wiki-dialog")).not.toBeVisible();
	await desk.rowMenu(row, "Edit…");
	await form.locator("[name=binaryPolicy]").selectOption("externalize");
	await page.locator("#save-dialog").click();
	await expect(page.locator("#wiki-dialog")).not.toBeVisible();
	for (const name of fs.readdirSync(path.join(alpha, "tiddlers")).filter(n => n.endsWith(".tid") && n !== "Hello.tid")) {
		fs.unlinkSync(path.join(alpha, "tiddlers", name));
	}
	await desk.rowMenu(row, "Apply binary policy now");
	// The run before updated one file; this one does nothing
	await expect.poll(async () => (await desk.wikiState("Alpha")).binaryScan.lastResult.done.length).toBe(0);
	expect((await desk.wikiState("Alpha")).binaryScan.lastResult.deleted).toEqual([]);
	expect(filesIn(alpha)).toEqual(["report.pdf"]);
	await expect(await logText(desk, row)).not.toContainText("Deleted files/report.pdf");
});

test("binaries: guard asks before deleting many files", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const names = Array.from({ length: 12 }, (_, i) => "img" + String(i + 1).padStart(2, "0") + ".png");
	const putAll = () => names.forEach((name, i) => putBinary(alpha, name, "Image " + (i + 1), 100 + i));
	const dropTids = () => names.forEach(name => fs.unlinkSync(path.join(alpha, "tiddlers", name + ".tid")));
	putAll();
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha, binaries: EXTERNALIZE }] });
	const row = desk.row("Alpha");
	const chip = row.locator(".binary-chip");
	await expect.poll(() => filesIn(alpha).length).toBe(12);

	// More than 10 at once: nothing is deleted, the chip asks
	dropTids();
	await desk.rowMenu(row, "Apply binary policy now");
	await expect(chip).toHaveText("▣ 12 files to delete");
	expect(filesIn(alpha).length).toBe(12);
	await expect(await logText(desk, row)).toContainText("Not deleting 12 unused files: more than 10 at once – use ⋯ › Delete 12 unused files…");
	await expect(chip).toHaveAttribute("title", /Files to delete \(needs your OK\): 12/);

	// Two tiddlers come back: they're in use again, the other 10 still wait (no guard holds them now)
	const restored = ["img01.png", "img02.png"];
	restored.forEach((name, i) => fs.writeFileSync(path.join(alpha, "tiddlers", name + ".tid"), "title: Image " + (i + 1) + "\ntype: image/png\n_canonical_uri: files/" + name + "\n"));
	await desk.rowMenu(row, "Apply binary policy now");
	await expect(chip).toHaveText("▣ 10 files to delete");
	await desk.rowMenu(row, "Apply binary policy now");
	await expect.poll(async () => (await desk.wikiState("Alpha")).binaryScan.lastResult.pending.length).toBe(10);
	expect(filesIn(alpha).length).toBe(12);
	await expect(chip).toHaveText("▣ 10 files to delete");

	// confirm() is answered with OK by the fixture
	await desk.takeDialogs();
	await desk.rowMenu(row, "Delete 10 unused files…");
	await expect.poll(() => filesIn(alpha)).toEqual(restored);
	await expect(chip).toHaveCount(0);
	const [question] = await desk.takeDialogs();
	expect(question.type).toBe("confirm");
	expect(question.message).toContain("files/img03.png");
	expect(question.message).toContain("files/img12.png");
	expect(question.message).not.toContain("files/img01.png");
	expect(question.message).not.toContain("…and");
	for (const name of restored) {
		fs.unlinkSync(path.join(alpha, "tiddlers", name + ".tid"));
		fs.unlinkSync(path.join(alpha, "files", name));
	}

	// Again, but keep them: the chip goes, the files stay and count as unused
	putAll();
	await desk.rowMenu(row, "Apply binary policy now");
	await expect.poll(() => filesIn(alpha).length).toBe(12);
	await expect(chip).toHaveCount(0);
	dropTids();
	await desk.rowMenu(row, "Apply binary policy now");
	await expect(chip).toHaveText("▣ 12 files to delete");
	await desk.rowMenu(row, "Keep these files");
	await expect(chip).toHaveCount(0);
	expect(filesIn(alpha).length).toBe(12);
	expect(await desk.takeDialogs()).toEqual([]);
	// Shown in the tooltip of the next chip (an embedded binary found by a scan)
	putBinary(alpha, "extra.png", "Extra");
	await page.evaluate(id => window.twDesk.binaries.scan(id), (await desk.wikiState("Alpha")).id);
	await expect(chip).toHaveText("▣ 1 embedded · 100 B");
	await expect(chip).toHaveAttribute("title", /Unused files in files\/: 12 \(never deleted automatically\)/);
});

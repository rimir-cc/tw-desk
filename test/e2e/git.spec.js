"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect, tw, sh } = require("./fixtures");

test("git: init, commit, add remote, push, fetch and pull", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	const bare = path.join(desk.root, "remote.git");
	sh(desk.root, "init", "--bare", "--quiet", bare);
	const page = await desk.launch({ wikis: [{ name: "Alpha", path: alpha }] });
	const chip = desk.row("Alpha").locator(".git-chip");
	const view = page.locator("#git-view");

	// No repository yet: the chip opens the Git tab, which offers to create one
	await expect(chip).toHaveText("⎇ no repository");
	await chip.click();
	await view.getByRole("button", { name: "Initialize repository" }).click();
	await expect(chip).toHaveText("⎇ main · no remote");
	expect(sh(alpha, "log", "--format=%s")).toBe("TW Desk: initial commit");
	expect(fs.existsSync(path.join(alpha, ".gitignore"))).toBe(true);

	// A changed tiddler shows up after a check; commit it with an own message
	tw.writeTiddler(alpha, "Changed", "new tiddler");
	await page.locator("#git-line").getByRole("button", { name: "Check now" }).click();
	await expect(chip).toHaveText("⎇ main · 1 changed · no remote");
	await expect(view).toContainText("1 changed: Changed.tid");
	const message = view.locator("input[data-git-root]");
	await expect(message).toHaveValue(/^TW Desk: 1 tiddler changed/);
	await message.fill("Add the Changed tiddler");
	await view.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(chip).toHaveText("⎇ main · no remote");
	expect(sh(alpha, "log", "-1", "--format=%s")).toBe("Add the Changed tiddler");

	// Remote: add it, push (sets the upstream)
	await view.getByPlaceholder(/^Remote URL/).fill(bare);
	await view.getByRole("button", { name: "Add remote" }).click();
	await expect(chip).toHaveText("⎇ main · ↑ not pushed");
	await view.getByRole("button", { name: "Push", exact: true }).click();
	await expect(chip).toHaveText("⎇ main ✓");
	expect(sh(bare, "log", "-1", "--format=%s", "main")).toBe("Add the Changed tiddler");

	// Someone else pushes; after a fetch the wiki is behind
	const other = path.join(desk.root, "other");
	sh(desk.root, "clone", "--quiet", bare, other);
	tw.writeTiddler(other, "FromElsewhere", "pushed by someone else");
	sh(other, "add", "-A");
	sh(other, "commit", "--quiet", "-m", "elsewhere");
	sh(other, "push", "--quiet");
	await view.getByRole("button", { name: "Fetch now" }).click();
	await expect(chip).toHaveText("⎇ main · ↓1");

	// Pull is refused while the wiki runs (its server would overwrite the pulled files)
	await desk.startWiki("Alpha");
	await expect(view.getByRole("button", { name: "Pull", exact: true })).toBeDisabled();
	await desk.stopWiki("Alpha");
	await view.getByRole("button", { name: "Pull", exact: true }).click();
	await expect(chip).toHaveText("⎇ main ✓");
	expect(fs.existsSync(path.join(alpha, "tiddlers", "FromElsewhere.tid"))).toBe(true);
});

test("git: auto-commit when a wiki is stopped", async ({ desk }) => {
	const alpha = desk.wiki("alpha");
	sh(alpha, "init", "--quiet");
	sh(alpha, "add", "-A");
	sh(alpha, "commit", "--quiet", "-m", "start");
	await desk.launch({
		wikis: [{ name: "Alpha", path: alpha }],
		git: { interval: 0, fetch: false, staleHours: 24, autoCommitOnStop: true }
	});

	const port = await desk.startWiki("Alpha");
	await desk.saveTiddler(port, "Written", "saved while running");
	await expect.poll(() => fs.existsSync(path.join(alpha, "tiddlers", "Written.tid"))).toBe(true);
	await desk.stopWiki("Alpha");

	await expect.poll(() => sh(alpha, "log", "-1", "--format=%s"), { timeout: 30000 }).toMatch(/^TW Desk: \d+ tiddlers? changed/);
	expect(sh(alpha, "ls-files")).toContain("tiddlers/Written.tid");
	await expect(desk.row("Alpha").locator(".git-chip")).toHaveText("⎇ main · no remote");
});

"use strict";

const { test, expect } = require("./fixtures");

// Wiki names in list order, per group id ("" = ungrouped), from config.json
function order(desk) {
	const result = {};
	for (const wiki of desk.config().wikis) {
		(result[wiki.group || ""] = result[wiki.group || ""] || []).push(wiki.name);
	}
	return result;
}

test("groups: create, assign, collapse, rename, delete", async ({ desk }) => {
	const page = await desk.launch({ wikis: [
		{ name: "Alpha", path: desk.wiki("alpha") },
		{ name: "Beta", path: desk.wiki("beta", "alpha") }
	] });
	// Without groups there is no "Ungrouped" header
	await expect(desk.groupHeader("Ungrouped")).toHaveCount(0);

	await desk.newMenu("Group…");
	await page.locator("#group-form [name=name]").fill("Work");
	await page.locator("#group-form button[type=submit]").click();
	const header = desk.groupHeader("Work");
	await expect(header).toContainText("0 wikis");
	await expect(page.locator("li.group-empty")).toBeVisible();
	// Names must be unique
	await desk.newMenu("Group…");
	await page.locator("#group-form [name=name]").fill("work");
	await page.locator("#group-form button[type=submit]").click();
	await expect(page.locator("#group-error")).toBeVisible();
	await page.locator("#cancel-group").click();

	// Into the group via the Edit dialog
	await desk.rowMenu(desk.row("Alpha"), "Edit…");
	await page.locator("#wiki-form [name=group]").selectOption({ label: "Work" });
	await page.locator("#save-dialog").click();
	await expect(header).toContainText("1 wiki");
	const groupId = desk.config().groups[0].id;
	expect(order(desk)).toEqual({ [groupId]: ["Alpha"], "": ["Beta"] });
	await expect(desk.groupHeader("Ungrouped")).toContainText("1 wiki");

	// Collapsed: its wikis are hidden; the header still counts running ones
	await desk.startWiki("Alpha");
	await header.locator(".group-toggle").click();
	await expect(desk.row("Alpha")).toHaveCount(0);
	await expect(header).toContainText("1 wiki · 1 running");
	expect(desk.config().groups[0].collapsed).toBe(true);
	await desk.groupHeader("Work").locator(".group-toggle").click();
	await expect(desk.row("Alpha")).toBeVisible();

	await header.getByRole("button", { name: "Rename" }).click();
	await page.locator("#group-form [name=name]").fill("Projects");
	await page.locator("#group-form button[type=submit]").click();
	const renamed = desk.groupHeader("Projects");
	await expect(renamed).toBeVisible();

	// Deleting the group keeps its wikis, ungrouped (confirm() is answered with OK)
	await renamed.getByRole("button", { name: "Delete" }).click();
	await expect(renamed).toHaveCount(0);
	expect(desk.config().groups).toEqual([]);
	expect(order(desk)).toEqual({ "": ["Alpha", "Beta"] });
	await expect(desk.row("Alpha")).toBeVisible();
});

test("order: move up/down and drag & drop between groups", async ({ desk }) => {
	const page = await desk.launch({
		groups: [{ id: "g1", name: "Work" }],
		wikis: [
			{ name: "One", path: desk.wiki("one", "alpha") },
			{ name: "Two", path: desk.wiki("two", "alpha") },
			{ name: "Three", path: desk.wiki("three", "alpha") }
		]
	});
	await expect(desk.row("One").getByRole("button", { name: "⋯" })).toBeVisible();

	// Menu: the first can't move up
	await desk.row("One").locator("button.more").click();
	await expect(page.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
	await page.getByRole("menuitem", { name: "Move down" }).click();
	await expect.poll(() => order(desk)).toEqual({ "": ["Two", "One", "Three"] });

	// Drop onto the group header: into the group
	await desk.row("Three").dragTo(desk.groupHeader("Work"));
	await expect.poll(() => order(desk)).toEqual({ g1: ["Three"], "": ["Two", "One"] });

	// Drop onto the upper half of a row: before it, in its group
	await desk.row("One").dragTo(desk.row("Three"), { targetPosition: { x: 40, y: 3 } });
	await expect.poll(() => order(desk)).toEqual({ g1: ["One", "Three"], "": ["Two"] });

	// Drop onto the "Ungrouped" header: out of the group, at the end
	await desk.row("Three").dragTo(desk.groupHeader("Ungrouped"));
	await expect.poll(() => order(desk)).toEqual({ g1: ["One"], "": ["Two", "Three"] });
	// The list shows the new order
	await expect(page.locator("#wiki-list li.wiki .wiki-name")).toHaveText([/^One/, /^Two/, /^Three/]);
});

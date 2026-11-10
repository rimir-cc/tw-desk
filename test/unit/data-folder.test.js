"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const dataFolder = require("../../src/data-folder");

const P = (...parts) => path.resolve(path.sep, ...parts);
const key = p => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));

test("toStored: relative up to two levels up, absolute beyond and across drives", () => {
	const data = P("data", "tw-desk-data");
	assert.equal(dataFolder.toStored(P("data", "wikis", "orga"), data), "../wikis/orga");
	assert.equal(dataFolder.toStored(P("x", "y"), data), "../../x/y");
	assert.equal(dataFolder.toStored(P("data", "tw-desk-data", "sub", "z"), data), "sub/z");
	assert.equal(dataFolder.toStored(P("a", "b", "c"), P("a", "b", "c", "d", "e")), "../..");
	assert.equal(dataFolder.toStored(P("w"), P("a", "b", "c")), P("w"));
	assert.equal(dataFolder.toStored(data, data), ".");
	assert.equal(dataFolder.fromStored("../wikis/orga", data), P("data", "wikis", "orga"));
	assert.equal(dataFolder.fromStored(P("w"), data), P("w"));
	assert.equal(dataFolder.fromStored(".", data), data);
});

test("storeConfigPaths / resolveConfigPaths round-trip wikis, folderDescriptions, pluginsFolderOrder", () => {
	const data = P("d", "x", "tw-desk-data");
	const config = {
		basePort: 8090,
		wikis: [{ id: "a", path: P("d", "x", "wikis", "orga") }, { id: "b", path: P("far", "away", "deep", "x") }],
		folderDescriptions: { [P("d", "x", "wikis", "_shared")]: "Shared" },
		pluginsFolderOrder: [P("d", "x", "wikis", "orga"), P("d", "x", "wikis", "_shared")]
	};
	const stored = dataFolder.storeConfigPaths(config, data);
	assert.equal(stored.wikis[0].path, "../wikis/orga");
	assert.equal(stored.wikis[1].path, P("far", "away", "deep", "x"));
	assert.deepEqual(Object.keys(stored.folderDescriptions), ["../wikis/_shared"]);
	assert.deepEqual(stored.pluginsFolderOrder, ["../wikis/orga", "../wikis/_shared"]);
	assert.equal(config.wikis[0].path, P("d", "x", "wikis", "orga"), "input unchanged");
	assert.deepEqual(dataFolder.resolveConfigPaths(stored, data), config);
	assert.deepEqual(dataFolder.resolveConfigPaths({ wikis: [] }, data), { wikis: [] });
});

test("splitLocal / mergeLocal", () => {
	const config = {
		wikis: [{ id: "a", name: "A", path: "/w/a", lastPort: 8100 }],
		webWikis: [{ id: "l", url: "u", check: { date: "d", result: "same" } }],
		groups: [{ id: "g", name: "G", collapsed: true }],
		webCollapsed: true,
		ungroupedCollapsed: false,
		basePort: 8090
	};
	const { shared, local } = dataFolder.splitLocal(config);
	assert.deepEqual(shared.wikis[0], { id: "a", name: "A", path: "/w/a" });
	assert.equal("check" in shared.webWikis[0], false);
	assert.equal("collapsed" in shared.groups[0], false);
	assert.equal("webCollapsed" in shared, false);
	assert.equal("ungroupedCollapsed" in shared, false);
	assert.deepEqual(local, { wikis: { a: { lastPort: 8100 } }, webWikis: { l: { check: { date: "d", result: "same" } } }, groups: { g: { collapsed: true } }, webCollapsed: true, ungroupedCollapsed: false });
	assert.deepEqual(dataFolder.mergeLocal(shared, local), config);
	assert.deepEqual(dataFolder.mergeLocal(shared, {}).wikis[0], shared.wikis[0]);
	assert.equal(config.wikis[0].lastPort, 8100, "input unchanged");
});

test("commitMessage", () => {
	assert.equal(dataFolder.commitMessage(["Added wiki orga", "Installed $:/plugins/kixam/moment 1.2.0", "Added wiki orga"], []), "Added wiki orga · Installed $:/plugins/kixam/moment 1.2.0");
	assert.match(dataFolder.commitMessage(["1", "2", "3", "4", "5", "6", "7", "8"], []), /^1 · 2 · 3 · 4 · 5 · 6 · \+2 more$/);
	assert.match(dataFolder.commitMessage([], ["config.json"]), /^TW Desk: setup changed \(\d{4}-\d\d-\d\d \d\d:\d\d\)$/);
});

test("suggestLocation", () => {
	assert.equal(dataFolder.suggestLocation([P("d", "wikis", "a"), P("d", "wikis", "b")], P("docs"), key), P("d", "tw-desk-data"));
	assert.equal(dataFolder.suggestLocation([P("d", "wikis", "a")], P("docs"), key), P("d", "tw-desk-data"));
	assert.equal(dataFolder.suggestLocation([], P("docs"), key), P("docs", "TW Desk data"));
	assert.equal(dataFolder.suggestLocation([P("a")], P("docs"), key), P("docs", "TW Desk data"), "no parent above the root");
});

test("missingGroups, repointPlan and replacePrefix", () => {
	const groups = dataFolder.missingGroups([{ id: "1", path: P("old", "w", "a") }, { id: "2", path: P("old", "w", "b") }, { id: "3", path: P("else", "c") }], key);
	assert.deepEqual(groups, [{ parent: P("old", "w"), ids: ["1", "2"] }]);
	const plan = dataFolder.repointPlan([{ id: "1", path: P("old", "w", "a") }, { id: "2", path: P("old", "w", "b") }], P("old", "w"), P("new"), p => p === P("new", "a"), key);
	assert.deepEqual(plan.map(p => [p.id, p.from, p.to, p.found]), [["1", P("old", "w", "a"), P("new", "a"), true], ["2", P("old", "w", "b"), P("new", "b"), false]]);
	assert.equal(dataFolder.replacePrefix(P("old", "w", "a", "x"), P("old", "w"), P("new"), key), P("new", "a", "x"));
	assert.equal(dataFolder.replacePrefix(P("old", "w"), P("old", "w"), P("new"), key), P("new"));
	assert.equal(dataFolder.replacePrefix(P("other"), P("old", "w"), P("new"), key), null);
	assert.equal(dataFolder.replacePrefix(P("old", "wx"), P("old", "w"), P("new"), key), null);
});

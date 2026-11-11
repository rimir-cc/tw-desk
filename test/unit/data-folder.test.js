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
		windowSize: { width: 1800, height: 1000 },
		basePort: 8090
	};
	const { shared, local } = dataFolder.splitLocal(config);
	assert.deepEqual(shared.wikis[0], { id: "a", name: "A", path: "/w/a" });
	assert.equal("check" in shared.webWikis[0], false);
	assert.equal("collapsed" in shared.groups[0], false);
	assert.equal("webCollapsed" in shared, false);
	assert.equal("ungroupedCollapsed" in shared, false);
	assert.deepEqual(local, { wikis: { a: { lastPort: 8100 } }, webWikis: { l: { check: { date: "d", result: "same" } } }, groups: { g: { collapsed: true } }, webCollapsed: true, ungroupedCollapsed: false, windowSize: { width: 1800, height: 1000 } });
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

// ---------- file operations ----------

const fs = require("fs");
const os = require("os");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tw-desk-data-"));
const write = (file, text) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};

test("pointer round-trip; missing or broken file gives null", () => {
	const userData = tmp();
	assert.equal(dataFolder.readPointer(userData), null);
	dataFolder.writePointer(userData, P("d", "tw-desk-data"));
	assert.equal(dataFolder.readPointer(userData), P("d", "tw-desk-data"));
	fs.writeFileSync(path.join(userData, "data-folder.json"), "{ broken");
	assert.equal(dataFolder.readPointer(userData), null);
	fs.rmSync(userData, { recursive: true, force: true });
});

test("folderState: missing, empty, data, other", () => {
	const root = tmp();
	assert.equal(dataFolder.folderState(path.join(root, "nope")), "missing");
	fs.mkdirSync(path.join(root, "empty"));
	assert.equal(dataFolder.folderState(path.join(root, "empty")), "empty");
	write(path.join(root, "data", "config.json"), "{}");
	assert.equal(dataFolder.folderState(path.join(root, "data")), "data");
	write(path.join(root, "other", "x.txt"), "x");
	assert.equal(dataFolder.folderState(path.join(root, "other")), "other");
	fs.rmSync(root, { recursive: true, force: true });
});

test("copyData copies only the listed entries and verifies them", () => {
	const root = tmp();
	const from = path.join(root, "userdata");
	write(path.join(from, "config.json"), "{}");
	write(path.join(from, "store", "plugins", "a", "b", "plugin.info"), "{}");
	write(path.join(from, "web", "x", "snapshot.html"), "<html>");
	write(path.join(from, "backup", "y"), "old");
	const to = path.join(root, "data");
	dataFolder.copyData(from, to);
	assert.ok(fs.existsSync(path.join(to, "config.json")));
	assert.ok(fs.existsSync(path.join(to, "store", "plugins", "a", "b", "plugin.info")));
	assert.ok(fs.existsSync(path.join(to, "web", "x", "snapshot.html")));
	assert.equal(fs.existsSync(path.join(to, "backup")), false);
	assert.ok(fs.existsSync(path.join(from, "store")), "source kept");
	fs.rmSync(root, { recursive: true, force: true });
});

test("verifyCopy throws on a size mismatch; copyTree includes .git", () => {
	const root = tmp();
	const from = path.join(root, "a");
	write(path.join(from, "config.json"), "{}");
	write(path.join(from, ".git", "HEAD"), "ref: refs/heads/main\n");
	const to = path.join(root, "b");
	dataFolder.copyTree(from, to);
	assert.ok(fs.existsSync(path.join(to, ".git", "HEAD")));
	assert.ok(dataFolder.ownRepo(to));
	assert.equal(dataFolder.ownRepo(path.join(root, "nope")), false);
	fs.writeFileSync(path.join(to, "config.json"), "{ changed }");
	assert.throws(() => dataFolder.verifyCopy(from, to, ["config.json"]), /copy/i);
	fs.rmSync(root, { recursive: true, force: true });
});

test("DATA_GITIGNORE", () => {
	assert.equal(dataFolder.DATA_GITIGNORE, "*.tmp\n");
});

test("wikiExcludes: wikis inside the data folder, as root-anchored git patterns", () => {
	const data = P("d", "tw-desk-data");
	const lines = dataFolder.wikiExcludes([P("d", "tw-desk-data", "wikis", "inner"), P("d", "wikis", "outer"), data], data);
	assert.deepEqual(lines, ["/wikis/inner/"]);
});

test("withExcludes: replaces only TW Desk's own block", () => {
	const own = "# mine\n*.bak\n";
	const once = dataFolder.withExcludes(own, ["/a/"]);
	assert.equal(once, "# mine\n*.bak\n# TW Desk: wikis inside the data folder\n/a/\n# TW Desk end\n");
	assert.equal(dataFolder.withExcludes(once, ["/b/", "/c/"]), "# mine\n*.bak\n# TW Desk: wikis inside the data folder\n/b/\n/c/\n# TW Desk end\n");
	assert.equal(dataFolder.withExcludes(once, []), own);
	assert.equal(dataFolder.withExcludes("", []), "");
	assert.equal(dataFolder.withExcludes("x", ["/a/"]), "x\n# TW Desk: wikis inside the data folder\n/a/\n# TW Desk end\n");
});

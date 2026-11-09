"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const setup = require("../../src/setup");
const tw = require("../helpers/tw");

const key = part => (process.platform === "win32" ? part.toLowerCase() : part);
let dir;

before(() => {
	dir = tw.tempDir("tw-desk-setup-");
});

after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function wikiFolder(folder) {
	fs.mkdirSync(path.join(folder, "tiddlers"), { recursive: true });
	fs.writeFileSync(path.join(folder, "tiddlywiki.info"), "{}");
	return folder;
}

test("commonBase: deepest shared folder", () => {
	const root = path.resolve("/data");
	assert.equal(setup.commonBase([path.join(root, "wikis", "a"), path.join(root, "wikis", "b")], key), path.join(root, "wikis"));
	assert.equal(setup.commonBase([path.join(root, "wikis"), path.join(root, "wikis", "b")], key), path.join(root, "wikis"));
	assert.equal(setup.commonBase([path.join(root, "x")], key), path.join(root, "x"));
	assert.equal(setup.commonBase([], key), null);
	if (process.platform === "win32") {
		assert.equal(setup.commonBase(["C:\\a\\b", "D:\\a\\b"], key), null);
		assert.equal(setup.commonBase(["C:\\Data\\a", "c:\\data\\b"], key), "C:\\Data");
	}
});

// Two wikis side by side, one including the shared folder; orga in its own repo with a remote
function exampleSetup(base) {
	const orga = path.join(base, "orga");
	const priv = path.join(base, "priv");
	const shared = path.join(base, "_shared");
	return setup.buildSetup({
		app: "0.2.16",
		tiddlywiki: "5.4.1",
		platform: process.platform,
		key,
		groups: [{ id: "g1", name: "Work", collapsed: true }, { id: "g2", name: "Unused" }],
		wikis: [
			{ id: "w1", name: "Orga", path: orga, group: "g1", fixedPort: 8095, autostart: true, description: "Work notes", lastPort: 8091, copiedFrom: { id: "x", name: "Old", path: "/old", date: "2026-01-01" } },
			{ id: "w2", name: "Priv", path: priv }
		],
		folders: [
			{ path: orga, git: { root: orga, url: "https://git.example/orga.git", branch: "main" } },
			{ path: shared, git: { root: shared, url: null, branch: "main" } },
			{ path: priv, git: null }
		],
		webWikis: [{ link: { id: "l1", name: "Grok", url: "https://grok.example/", showcase: true, linkedPlugins: ["$:/plugins/a/b"], snapshot: { date: "2026-10-01T00:00:00Z" }, check: { result: "same" } }, html: "<html>snap</html>" }],
		store: [{ fields: { title: "$:/plugins/a/b", version: "1.0.0", text: "{\"tiddlers\":{}}" }, library: "showcase:l1" }],
		libraries: [{ url: "https://lib.example/index.html", type: "tiddlywiki" }],
		settings: { basePort: 8090, git: { interval: 600 }, webCheck: true }
	});
}

test("buildSetup: folders relative to the common base, only what belongs to this computer left out", () => {
	const base = path.join(dir, "export", "wikis");
	const data = exampleSetup(base);
	assert.equal(data.format, "tw-desk-setup");
	assert.equal(data.origin.base, base);
	assert.deepEqual(data.folders, [
		{ folder: "orga", repo: { folder: "orga", url: "https://git.example/orga.git", branch: "main" } },
		{ folder: "_shared", repo: { folder: "_shared", url: null, branch: "main" } },
		{ folder: "priv", repo: null }
	]);
	assert.deepEqual(data.wikis[0], { name: "Orga", folder: "orga", description: "Work notes", fixedPort: 8095, autostart: true, group: "Work", copiedFrom: { name: "Old", date: "2026-01-01" } });
	assert.deepEqual(data.wikis[1], { name: "Priv", folder: "priv", autostart: false });
	assert.deepEqual(data.groups, [{ name: "Work", collapsed: true }]);
	assert.equal(data.webWikis[0].snapshotHtml, "<html>snap</html>");
	assert.equal(data.webWikis[0].check, undefined);
	assert.deepEqual(data.webWikis[0].linkedPlugins, ["$:/plugins/a/b"]);
	assert.equal(data.store[0].library, "showcase:l1");
	// Survives the file
	assert.deepEqual(setup.readSetup(JSON.stringify(data)), data);
});

test("buildSetup: a repository holding several wikis is one place above them", () => {
	const repo = path.join(dir, "repo");
	const data = setup.buildSetup({
		app: "x", tiddlywiki: "x", platform: process.platform, key, groups: [], webWikis: [],
		wikis: [{ id: "a", name: "A", path: path.join(repo, "a") }],
		folders: [{ path: path.join(repo, "a"), git: { root: repo, url: "https://git.example/repo.git", branch: "main" } }]
	});
	assert.equal(data.origin.base, dir);
	assert.deepEqual(data.folders, [{ folder: "repo/a", repo: { folder: "repo", url: "https://git.example/repo.git", branch: "main" } }]);
	assert.equal(data.store, undefined);
	assert.equal(data.settings, undefined);
});

test("readSetup refuses other files and paths leaving the chosen folder", () => {
	assert.throws(() => setup.readSetup("not json"), /no valid JSON/);
	assert.throws(() => setup.readSetup("{\"wikis\":[]}"), /Export setup/);
	assert.throws(() => setup.readSetup(JSON.stringify({ format: "tw-desk-setup", version: 99 })), /newer TW Desk/);
	const bad = folder => JSON.stringify({ format: "tw-desk-setup", version: 1, folders: [{ folder }], wikis: [] });
	assert.throws(() => setup.readSetup(bad("../outside")), /invalid folder/);
	assert.throws(() => setup.readSetup(bad("a/../../b")), /invalid folder/);
	assert.throws(() => setup.readSetup(bad("/etc")), /invalid folder/);
	assert.throws(() => setup.readSetup(bad("C:/x")), /invalid folder/);
	assert.throws(() => setup.readSetup(JSON.stringify({ format: "tw-desk-setup", version: 1, webWikis: [{ url: "file:///c:/x.html" }] })), /http\(s\)/);
	assert.deepEqual(setup.readSetup(JSON.stringify({ format: "tw-desk-setup", version: 1 })).wikis, []);
});

test("planImport: register, clone, already there, missing, blocked; store, links, libraries, groups", () => {
	const data = setup.readSetup(JSON.stringify(exampleSetup(path.join(dir, "export", "wikis"))));
	const target = path.join(dir, "import");
	const env = {
		key,
		wikis: [],
		webWikis: [],
		groups: [],
		libraries: [{ url: "https://lib.example/index.html" }],
		store: [{ title: "$:/plugins/a/b", version: "0.9.0" }],
		bundled: [],
		compareVersions: (a, b) => a.localeCompare(b),
		parseTitle: title => (title.startsWith("$:/plugins/") ? { kind: "plugin" } : null)
	};
	const actions = plan => plan.folders.map(f => [f.name, f.action]);

	// Nothing there yet: orga is cloned, _shared and priv have no remote
	let plan = setup.planImport(data, target, env);
	assert.deepEqual(actions(plan), [["Orga", "clone"], ["_shared", "missing"], ["Priv", "missing"]]);
	assert.equal(plan.folders[0].path, path.join(target, "orga"));
	assert.equal(plan.folders[0].repoPath, path.join(target, "orga"));
	assert.match(plan.folders[1].note, /no remote/);
	assert.match(plan.folders[2].note, /not in git/);
	assert.deepEqual(plan.newGroups, ["Work"]);
	assert.deepEqual(plan.webWikis.map(l => [l.action, l.snapshot]), [["add", "embedded"]]);
	assert.deepEqual(plan.store.map(p => p.action), ["update"]);
	assert.deepEqual(plan.libraries.map(l => l.action), ["already"]);

	// Folders copied by hand: registered; a non-wiki folder in the way blocks
	wikiFolder(path.join(target, "priv"));
	wikiFolder(path.join(target, "_shared"));
	fs.mkdirSync(path.join(target, "orga"));
	fs.writeFileSync(path.join(target, "orga", "something.txt"), "x");
	plan = setup.planImport(data, target, env);
	assert.deepEqual(actions(plan), [["Orga", "blocked"], ["_shared", "present"], ["Priv", "register"]]);

	// Already in TW Desk; the same plugin version is kept; an existing link isn't added twice
	plan = setup.planImport(data, target, Object.assign({}, env, {
		wikis: [{ name: "Mine", path: path.join(target, "priv") }],
		webWikis: [{ name: "G", url: "https://grok.example/" }],
		store: [{ title: "$:/plugins/a/b", version: "1.0.0" }]
	}));
	assert.deepEqual(plan.folders[2].action, "already");
	assert.match(plan.folders[2].note, /Mine/);
	assert.deepEqual(plan.webWikis.map(l => l.action), ["already"]);
	assert.deepEqual(plan.store.map(p => p.action), ["keep"]);

	// A wiki elsewhere with the same folder name: links to "orga" would be ambiguous, the plan says so
	plan = setup.planImport(data, target, Object.assign({}, env, { wikis: [{ name: "Other orga", path: path.join(dir, "elsewhere", "orga") }] }));
	assert.match(plan.folders[0].linkNote, /link name “orga” is already used here by “Other orga”/);
	assert.equal(plan.folders[2].linkNote, "");

	// Without a base folder nothing can be placed
	plan = setup.planImport(data, null, env);
	assert.ok(plan.folders.every(f => f.action === "missing" && /choose the folder/.test(f.note)));
});

test("export keeps the binary settings", () => {
	const base = path.join(dir, "binaries", "wikis");
	const data = setup.buildSetup({
		app: "x", tiddlywiki: "x", platform: process.platform, key, groups: [], webWikis: [],
		wikis: [
			{ id: "a", name: "A", path: path.join(base, "a"), binaries: { policy: "externalize", filesInGit: false } },
			{ id: "b", name: "B", path: path.join(base, "b") }
		],
		folders: [{ path: path.join(base, "a"), git: null }, { path: path.join(base, "b"), git: null }]
	});
	assert.deepEqual(data.wikis[0].binaries, { policy: "externalize", filesInGit: false });
	assert.equal(data.wikis[1].binaries, undefined);
	const plan = setup.planImport(setup.readSetup(JSON.stringify(data)), path.join(dir, "binaries", "import"), {
		key, wikis: [], webWikis: [], groups: [], libraries: [], store: [], bundled: [],
		compareVersions: (a, b) => a.localeCompare(b), parseTitle: () => null
	});
	assert.deepEqual(plan.folders[0].binaries, { policy: "externalize", filesInGit: false });
	assert.equal(plan.folders[1].binaries, null);
});

test("folder descriptions travel with the setup", () => {
	const base = path.join(dir, "export-descriptions", "wikis");
	const orga = path.join(base, "orga");
	const shared = path.join(base, "_shared");
	const data = setup.buildSetup({
		app: "0.2.23",
		tiddlywiki: "5.4.1",
		platform: process.platform,
		key,
		groups: [],
		wikis: [{ id: "w1", name: "Orga", path: orga }],
		folders: [
			{ path: orga, git: null },
			{ path: shared, git: null, description: "Shared core" }
		],
		webWikis: []
	});
	assert.deepEqual(data.folders, [{ folder: "orga", repo: null }, { folder: "_shared", repo: null, description: "Shared core" }]);
	const env = { key, wikis: [], webWikis: [], groups: [], libraries: [], store: [], bundled: [], compareVersions: () => 0, parseTitle: () => null };
	const plan = setup.planImport(setup.readSetup(JSON.stringify(data)), path.join(dir, "import-descriptions"), env);
	assert.equal(plan.folders.find(f => f.relative === "_shared").description, "Shared core");
	assert.equal(plan.folders.find(f => f.relative === "orga").description, null);
});

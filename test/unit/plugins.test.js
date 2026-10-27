"use strict";

require("../helpers/electron-stub");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const plugins = require("../../src/plugins");
const tw = require("../helpers/tw");
const { startServer, pluginTiddler } = require("../helpers/server");

let dir;
let server;
const store = (...parts) => path.join(dir, "userdata", "store", ...parts);

before(async () => {
	dir = tw.tempDir();
	plugins.init(path.join(dir, "userdata"));
	server = await startServer();
});

after(async () => {
	await server.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("titles and kinds", () => {
	assert.deepEqual(plugins.parseTitle("$:/plugins/flibbles/relink"), { kind: "plugin", name: "flibbles/relink" });
	assert.deepEqual(plugins.parseTitle("$:/themes/tiddlywiki/vanilla"), { kind: "theme", name: "tiddlywiki/vanilla" });
	assert.deepEqual(plugins.parseTitle("$:/languages/de-DE"), { kind: "language", name: "de-DE" });
	assert.equal(plugins.parseTitle("$:/plugins/"), null);
	assert.equal(plugins.parseTitle("Some tiddler"), null);
	assert.equal(plugins.titleOf("language", "de-DE"), "$:/languages/de-DE");
});

test("writeToStore: plugin.info + tiddlers.json with string fields only, bookkeeping outside the plugin folder", () => {
	const tiddler = pluginTiddler("$:/plugins/test/strings", "1.0.0", {
		revision: "12",
		bag: "default",
		list: ["readme", "settings page"],
		text: JSON.stringify({ tiddlers: { "$:/plugins/test/strings/readme": { text: "r", tags: ["a b", "c"], count: 3 } } })
	});
	const result = plugins.writeToStore(tiddler, { library: "https://example.org/lib" });
	assert.deepEqual(result, { kind: "plugin", name: "test/strings", title: "$:/plugins/test/strings", version: "1.0.0" });
	const folder = store("plugins", "test", "strings");
	assert.deepEqual(fs.readdirSync(folder).sort(), ["plugin.info", "tiddlers.json"]);
	const info = JSON.parse(fs.readFileSync(path.join(folder, "plugin.info"), "utf8"));
	assert.equal(info.list, "readme [[settings page]]");
	assert.ok(!("text" in info) && !("revision" in info) && !("bag" in info));
	const tiddlers = JSON.parse(fs.readFileSync(path.join(folder, "tiddlers.json"), "utf8"));
	assert.deepEqual(tiddlers, [{ title: "$:/plugins/test/strings/readme", text: "r", tags: "[[a b]] c", count: "3" }]);
	const listed = plugins.listStore().find(p => p.title === "$:/plugins/test/strings");
	assert.equal(listed.library, "https://example.org/lib");
	assert.equal(listed.version, "1.0.0");
	assert.ok(listed.installed);
});

test("writeToStore replaces an older version and refuses non-plugins", () => {
	plugins.writeToStore(pluginTiddler("$:/plugins/test/replace", "1.0.0"), {});
	plugins.writeToStore(pluginTiddler("$:/plugins/test/replace", "2.0.0"), {});
	assert.equal(plugins.listStore().filter(p => p.name === "test/replace").map(p => p.version).join(), "2.0.0");
	assert.deepEqual(fs.readdirSync(store("plugins", "test")).filter(n => n.includes("tw-desk")), []);
	assert.throws(() => plugins.writeToStore({ title: "Not a plugin", text: "{}" }, {}), /Not a plugin/);
	assert.throws(() => plugins.writeToStore({ title: "$:/plugins/test/bad", text: "nope" }, {}), /no valid JSON/);
});

test("removeFromStore removes the plugin and an empty author folder", () => {
	plugins.writeToStore(pluginTiddler("$:/plugins/lonely/one", "1.0.0"), {});
	plugins.removeFromStore("plugin", "lonely/one");
	assert.equal(fs.existsSync(store("plugins", "lonely")), false);
	assert.throws(() => plugins.removeFromStore("plugin", "lonely/one"), /Not in the store/);
	assert.throws(() => plugins.removeFromStore("plugin", "../x"), /Invalid/);
});

test("libraries: index and install from a standard library and a CPL", async () => {
	server.setLibrary([pluginTiddler("$:/plugins/test/hello", "1.0.0"), pluginTiddler("$:/themes/test/dark", "0.1.0")]);
	server.setCpl([pluginTiddler("$:/plugins/test/hello", "1.1.0"), pluginTiddler("$:/languages/xx-YY", "1.0.0")]);
	assert.deepEqual(await plugins.detectLibrary(server.libraryUrl), { url: server.libraryUrl, type: "tiddlywiki" });
	assert.deepEqual(await plugins.detectLibrary(server.cplUrl + "/"), { url: server.cplUrl, type: "cpl" });
	const standard = { url: server.libraryUrl, type: "tiddlywiki" };
	const cpl = { url: server.cplUrl, type: "cpl" };
	const entries = await plugins.libraryIndex(standard, true);
	assert.deepEqual(entries.map(e => e.kind + " " + e.name + " " + e.version), ["plugin test/hello 1.0.0", "theme test/dark 0.1.0"]);
	assert.equal(entries[0].fields["plugin-type"], "plugin");

	const fromStandard = await plugins.installFromLibrary(standard, "$:/plugins/test/hello");
	assert.equal(fromStandard.version, "1.0.0");
	// The title is encoded twice in the library's URL
	assert.ok(server.requests.some(r => r.url.includes("%2524%253A%252Fplugins%252Ftest%252Fhello.json")));
	const fromCpl = await plugins.installFromLibrary(cpl, "$:/plugins/test/hello");
	assert.equal(fromCpl.version, "1.1.0");
	assert.equal(plugins.listStore().find(p => p.name === "test/hello").library, server.cplUrl);
	const language = await plugins.installFromLibrary(cpl, "$:/languages/xx-YY");
	assert.equal(language.kind, "language");
	assert.ok(fs.existsSync(store("languages", "xx-YY", "plugin.info")));
	await assert.rejects(plugins.installFromLibrary(standard, "$:/plugins/test/missing"), /HTTP 404/);
});

test("allIndexes and checkUpdates: offers per library, broken libraries reported", async () => {
	server.setLibrary([pluginTiddler("$:/plugins/test/hello", "1.0.0")]);
	server.setCpl([pluginTiddler("$:/plugins/test/hello", "1.2.0")]);
	const libraries = [
		{ url: server.libraryUrl, type: "tiddlywiki" },
		{ url: server.cplUrl, type: "cpl" },
		{ url: server.url + "/nothing/here", type: "cpl" }
	];
	const indexes = await plugins.allIndexes(libraries, true);
	assert.equal(indexes.length, 3);
	assert.ok(indexes[2].error);

	const showcase = { url: "showcase:abc", entries: plugins.normalizeEntries([pluginTiddler("$:/plugins/test/hello", "1.3.0")], "showcase") };
	const installed = [{ title: "$:/plugins/test/hello", version: "1.0.0" }, { title: "$:/plugins/test/unknown", version: "1.0.0" }];
	const result = await plugins.checkUpdates(libraries, installed, [showcase]);
	assert.deepEqual(result.results[0].offers, [
		{ library: "showcase:abc", version: "1.3.0" },
		{ library: server.cplUrl, version: "1.2.0" },
		{ library: server.libraryUrl, version: "1.0.0" }
	]);
	assert.deepEqual(result.results[1].offers, []);
	assert.equal(result.errors.length, 1);
	assert.equal(result.librariesChecked, 2);
	assert.equal(result.showcasesChecked, 1);
});

test("tiddlywiki.info plugin lists", () => {
	const folder = tw.initWiki(path.join(dir, "lists"));
	const infoFile = path.join(folder, "tiddlywiki.info");
	plugins.setFolderList(folder, "plugin", ["tiddlywiki/tiddlyweb", "tiddlywiki/filesystem", "test/hello", "test/hello", ""]);
	assert.deepEqual(plugins.folderLists(folder).plugins, ["tiddlywiki/tiddlyweb", "tiddlywiki/filesystem", "test/hello"]);
	assert.match(fs.readFileSync(infoFile, "utf8"), /\n {4}"plugins"/);
	// Unchanged lists aren't written again
	fs.writeFileSync(infoFile, JSON.stringify(JSON.parse(fs.readFileSync(infoFile, "utf8"))));
	plugins.setFolderList(folder, "plugin", ["tiddlywiki/tiddlyweb", "tiddlywiki/filesystem", "test/hello"]);
	assert.doesNotMatch(fs.readFileSync(infoFile, "utf8"), /\n/);
	plugins.setFolderList(folder, "theme", []);
	assert.ok(!("themes" in JSON.parse(fs.readFileSync(infoFile, "utf8"))));
});

test("moving a plugin stored in a wiki into the store", () => {
	const folder = tw.initWiki(path.join(dir, "stored"));
	const tiddlers = path.join(folder, "tiddlers");
	// As TiddlyWiki's filesystem plugin saves it: content in .json, fields in .json.meta
	const plugin = pluginTiddler("$:/plugins/test/inwiki", "0.5.0");
	fs.writeFileSync(path.join(tiddlers, "$__plugins_test_inwiki.json"), plugin.text);
	fs.writeFileSync(path.join(tiddlers, "$__plugins_test_inwiki.json.meta"), Object.entries(plugin).filter(([k]) => k !== "text").map(([k, v]) => k + ": " + v).join("\n"));
	// And one saved as a single JSON tiddler
	fs.writeFileSync(path.join(tiddlers, "other.json"), JSON.stringify([pluginTiddler("$:/themes/test/inwiki", "0.1.0")]));
	fs.writeFileSync(path.join(tiddlers, "data.json"), JSON.stringify([{ title: "Data", type: "application/json", text: "{}" }]));

	const stored = plugins.listStoredInWiki(folder);
	assert.deepEqual(stored.map(p => p.title + " " + p.version), ["$:/plugins/test/inwiki 0.5.0", "$:/themes/test/inwiki 0.1.0"]);
	assert.throws(() => plugins.moveToStore(folder, path.join(dir, "elsewhere.json")), /not inside/);

	const result = plugins.moveToStore(folder, stored[0].file);
	assert.equal(result.version, "0.5.0");
	assert.ok(fs.existsSync(store("plugins", "test", "inwiki", "plugin.info")));
	assert.ok(plugins.folderLists(folder).plugins.includes("test/inwiki"));
	assert.equal(fs.existsSync(stored[0].file), false);
	assert.equal(fs.existsSync(stored[0].file + ".meta"), false);
	assert.deepEqual(fs.readdirSync(result.backupDir).sort(), ["$__plugins_test_inwiki.json", "$__plugins_test_inwiki.json.meta"]);
	assert.equal(plugins.listStore().find(p => p.name === "test/inwiki").library, null);
});

test("TiddlyWiki loads a plugin from the store (TIDDLYWIKI_PLUGIN_PATH)", () => {
	plugins.writeToStore(pluginTiddler("$:/plugins/test/loaded", "3.1.4"), {});
	const folder = tw.initWiki(path.join(dir, "loads"));
	plugins.setFolderList(folder, "plugin", plugins.folderLists(folder).plugins.concat("test/loaded"));
	tw.tiddlywiki([folder, "--render", "$:/plugins/test/loaded/readme", "readme.txt", "text/plain"], plugins.tiddlyWikiEnv({}));
	assert.equal(fs.readFileSync(path.join(folder, "output", "readme.txt"), "utf8"), "Readme of $:/plugins/test/loaded 3.1.4");
});

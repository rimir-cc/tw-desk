"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compareVersionsLoose, parseQuery, groupOffers, scoreGroup } = require("../../src/search");

const entry = (title, version, more = {}) => Object.assign({
	title,
	kind: title.startsWith("$:/themes/") ? "theme" : "plugin",
	name: title.replace(/^\$:\/(plugins|themes)\//, ""),
	version,
	description: "",
	author: "",
	tags: "",
	fields: {}
}, more);

const INDEXES = [
	{ url: "lib-a", entries: [
		entry("$:/plugins/flibbles/relink", "2.3.0", { description: "Renames references", author: "flibbles", tags: "editor" }),
		entry("$:/plugins/tiddlywiki/markdown", "5.4.1", { description: "Markdown parser", fields: { "core-version": ">=5.3.0" } }),
		entry("$:/themes/tiddlywiki/vanilla", "5.4.1", { description: "Basic theme" })
	] },
	{ url: "lib-b", entries: [
		entry("$:/plugins/flibbles/relink", "2.10.1", { description: "Renames references", author: "flibbles" }),
		entry("$:/plugins/someone/relink-titles", "1.0.0", { description: "Relink for titles", author: "someone" })
	] },
	{ url: "broken", error: "HTTP 500" }
];

test("versions compare by number, not as text", () => {
	assert.equal(compareVersionsLoose("2.10.1", "2.3.0"), 1);
	assert.equal(compareVersionsLoose("v1.0", "1.0.0"), 0);
	assert.equal(compareVersionsLoose("1.0.0-beta", "1.0.1"), -1);
	assert.equal(compareVersionsLoose("", "0.0.1"), -1);
});

test("parseQuery: words, phrases, exclusions and fields", () => {
	assert.deepEqual(parseQuery("Relink  \"table of contents\" -theme tag:Editor core-version:5.3 -"), [
		{ exclude: false, field: null, value: "relink" },
		{ exclude: false, field: null, value: "table of contents" },
		{ exclude: true, field: null, value: "theme" },
		{ exclude: false, field: "tags", value: "editor" },
		{ exclude: false, field: "core-version", value: "5.3" }
	]);
	assert.deepEqual(parseQuery("  "), []);
});

test("groupOffers: one group per title, newest offer first, filters", () => {
	const groups = groupOffers(INDEXES);
	assert.equal(groups.length, 4);
	const relink = groups.find(g => g.title === "$:/plugins/flibbles/relink");
	assert.deepEqual(relink.offers.map(o => o.library + " " + o.entry.version), ["lib-b 2.10.1", "lib-a 2.3.0"]);
	assert.equal(relink.entry.version, "2.10.1");
	assert.deepEqual(groupOffers(INDEXES, { library: "lib-b" }).map(g => g.name).sort(), ["flibbles/relink", "someone/relink-titles"]);
	assert.deepEqual(groupOffers(INDEXES, { kind: "theme" }).map(g => g.name), ["tiddlywiki/vanilla"]);
});

test("scoreGroup: all words must match; better places score higher", () => {
	const groups = groupOffers(INDEXES);
	const byName = name => groups.find(g => g.name === name);
	const score = (name, query) => scoreGroup(byName(name), parseQuery(query));
	// exact name > in title > in description > author/tags > other fields
	assert.equal(score("flibbles/relink", "flibbles/relink"), 20);
	assert.equal(score("someone/relink-titles", "titles"), 10);
	assert.equal(score("tiddlywiki/markdown", "parser"), 3);
	// a word found only in an older library's entry still matches
	assert.ok(score("flibbles/relink", "editor") > 0);
	assert.equal(score("tiddlywiki/markdown", ">=5.3"), 1);
	assert.equal(score("tiddlywiki/markdown", "relink"), -1);
	assert.equal(score("flibbles/relink", "relink -flibbles"), -1);
	assert.ok(score("someone/relink-titles", "relink -flibbles") > 0);
	// field terms look only in that field
	assert.ok(score("tiddlywiki/markdown", "core-version:5.3") > 0);
	assert.equal(score("tiddlywiki/markdown", "author:markdown"), -1);
	assert.ok(score("flibbles/relink", "tag:edit") > 0);
});

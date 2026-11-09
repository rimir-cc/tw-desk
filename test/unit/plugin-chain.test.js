"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const chain = require("../../src/plugin-chain");

const P = name => path.resolve(path.sep, "w", name);
const base = p => path.basename(p);
const key = p => p;
const nameOf = p => base(p);

// R includes A and B; A includes C; B includes C and a missing M; C includes R (loop)
const graph = {
	R: ["A", "B"],
	A: ["C"],
	B: ["C", "M"],
	C: ["R"]
};
const readIncludes = p => ({
	includes: (graph[base(p)] || []).map(name => ({ resolved: P(name), exists: name !== "M" }))
});

test("walkIncludes: load order, chains, loop and missing", () => {
	const walk = chain.walkIncludes(P("R"), readIncludes, key);
	assert.deepEqual(walk.order.map(o => [base(o.path), o.chain.map(base)]),
		[["C", ["A", "C"]], ["A", ["A"]], ["C", ["B", "C"]], ["B", ["B"]], ["R", []]]);
	assert.deepEqual(walk.errors.map(e => [base(e.path), e.reason]), [["R", "loop"], ["R", "loop"], ["M", "missing"]]);
});

const store = { "test/hello": "1.2.0", "test/other": "2.0.0" };
const resolve = (kind, name) => store[name]
	? { title: "$:/plugins/" + name, origin: "store", version: store[name] }
	: { title: "$:/plugins/" + name, origin: "missing", version: "" };
const emptyLists = () => ({ plugins: [], themes: [], languages: [] });
const info = {
	R: { lists: Object.assign(emptyLists(), { plugins: ["test/hello", "gone/one"] }), stored: [] },
	A: { lists: Object.assign(emptyLists(), { plugins: ["test/other", "gone/one"] }), stored: [{ title: "$:/plugins/test/other", kind: "plugin", name: "test/other", version: "2.0.0" }] },
	B: { lists: emptyLists(), stored: [{ title: "$:/plugins/test/hello", kind: "plugin", name: "test/hello", version: "1.0.3" }] },
	C: { lists: Object.assign(emptyLists(), { plugins: ["test/hello"] }), stored: [] }
};
const folderInfo = p => info[base(p)];

test("analyzeChain: duplicate vs clash, winner by last load", () => {
	const walk = chain.walkIncludes(P("R"), readIncludes, key);
	const { entries, problems } = chain.analyzeChain(walk.order, folderInfo, resolve, key);
	const ofC = entries.filter(e => base(e.folder) === "C");
	assert.equal(ofC.length, 1);
	assert.deepEqual(ofC[0].chain.map(base), ["A", "C"]);
	const ofA = entries.filter(e => base(e.folder) === "A");
	assert.ok(ofA.every(e => e.position < ofC[0].position), "C's last load comes after A");
	const stored = entries.find(e => base(e.folder) === "A" && e.source === "stored");
	assert.equal(stored.origin, "wiki");

	const hello = problems.find(p => p.title === "$:/plugins/test/hello");
	assert.equal(hello.type, "clash");
	const winner = entries[hello.winner];
	assert.equal(base(winner.folder), "R");
	assert.equal(winner.source, "list");
	assert.equal(hello.entries.length, 3);

	assert.equal(problems.find(p => p.title === "$:/plugins/test/other").type, "duplicate");
	assert.equal(problems.find(p => p.title === "$:/plugins/gone/one").type, "duplicate");
});

test("clashText and chainLabel", () => {
	assert.equal(chain.chainLabel([], nameOf), "");
	assert.equal(chain.chainLabel([P("rr-core")], nameOf), "from rr-core");
	assert.equal(chain.chainLabel([P("rr-core"), P("x")], nameOf), "via rr-core → x");
	const entries = [
		{ title: "t", origin: "store", version: "1.2.0", folder: P("orga"), source: "list" },
		{ title: "t", origin: "wiki", version: "1.0.3", folder: P("rr-streams"), source: "stored" },
		{ title: "t", origin: "wiki", version: "1.0.4", folder: P("orga"), source: "stored" }
	];
	assert.equal(chain.clashText({ entries: [0, 1], winner: 1 }, entries, nameOf), "store 1.2.0 · in rr-streams 1.0.3 – rr-streams' copy wins");
	assert.equal(chain.clashText({ entries: [0, 2], winner: 2 }, entries, nameOf), "store 1.2.0 · in orga 1.0.4 – orga's copy wins");
	assert.equal(chain.clashText({ entries: [0, 1], winner: 0 }, entries, nameOf), "store 1.2.0 · in rr-streams 1.0.3 – the store copy wins");
	entries[0].origin = "bundled";
	assert.equal(chain.clashText({ entries: [1, 0], winner: 0 }, entries, nameOf), "in rr-streams 1.0.3 · bundled 1.2.0 – the bundled copy wins");
});

test("removalImpact and keepReason", () => {
	const title = "$:/plugins/kixam/moment";
	const fromCore = { title, source: "list", origin: "store", version: "1", folder: P("rr-core"), chain: [P("rr-core")], position: 1 };
	const wikis = [
		{ name: "orga", path: P("orga"), entries: [fromCore] },
		{ name: "priv-orga", path: P("priv-orga"), entries: [fromCore] },
		{ name: "tw-knowledge", path: P("tw-knowledge"), entries: [fromCore, { title, source: "list", origin: "store", version: "1", folder: P("tw-knowledge"), chain: [], position: 5 }] },
		{ name: "other", path: P("other"), entries: [{ title, source: "list", origin: "store", version: "1", folder: P("other"), chain: [], position: 1 }] }
	];
	const impact = chain.removalImpact(wikis, P("rr-core"), title, key);
	assert.deepEqual(impact.lose, ["orga", "priv-orga"]);
	assert.equal(impact.keep.length, 1);
	assert.equal(impact.keep[0].name, "tw-knowledge");
	assert.equal(chain.keepReason(wikis[2], impact.keep[0].by, nameOf), "listed itself");
	assert.equal(chain.keepReason(wikis[0], { source: "stored", folder: P("rr-streams"), chain: [P("rr-streams")] }, nameOf), "stored in rr-streams");
	assert.equal(chain.keepReason(wikis[0], { source: "list", folder: P("x"), chain: [P("rr-streams"), P("x")] }, nameOf), "via rr-streams → x");
});

test("orderFolders: listed first, others appended in their order, unknown ignored", () => {
	const folders = ["a", "b", "c", "d"].map(n => ({ path: P(n) }));
	assert.deepEqual(chain.orderFolders(folders, [P("c"), P("gone"), P("a")], key).map(f => base(f.path)), ["c", "a", "b", "d"]);
	assert.deepEqual(chain.orderFolders(folders, [], key).map(f => base(f.path)), ["a", "b", "c", "d"]);
});

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const web = require("../../src/web");
const tw = require("../helpers/tw");

const storeBlock = tiddlers => "<script class=\"tiddlywiki-tiddler-store\" type=\"application/json\">" + JSON.stringify(tiddlers) + "</script>";
const page = (...blocks) => "<!doctype html><html><head><meta name=\"tiddlywiki-version\" content=\"5.4.1\"></head><body><div id=\"storeArea\" style=\"display:none;\">" + blocks.join("\n") + "</div></body></html>";

test("reads tiddlers from the JSON store blocks", () => {
	const html = page(storeBlock([{ title: "A", text: "a" }]), storeBlock([{ title: "B", text: "b" }, { notATiddler: true }]));
	assert.deepEqual(web.readTiddlers(html).tiddlers.map(t => t.title), ["A", "B"]);
});

test("reads tiddlers from the old storeArea divs (TiddlyWiki 5.0/5.1)", () => {
	const html = "<div id=\"storeArea\"><div title=\"Old\" tags=\"[[a b]] c\" modified=\"20140101000000000\">\n<pre>x &lt;b&gt; &amp; &#x263A;</pre>\n</div>\n<div title=\"$:/Second\"><pre>2</pre></div>\n</div>";
	const tiddlers = web.readTiddlers(html).tiddlers;
	assert.equal(tiddlers.length, 2);
	assert.equal(tiddlers[0].title, "Old");
	assert.equal(tiddlers[0].tags, "[[a b]] c");
	assert.equal(tiddlers[0].text, "x <b> & ☺");
	assert.equal(tiddlers[1].title, "$:/Second");
});

test("tells encrypted wikis and other pages apart", () => {
	assert.deepEqual(web.readTiddlers("<pre id=\"encryptedStoreArea\" type=\"text/plain\">…</pre>"), { encrypted: true });
	assert.equal(web.readTiddlers("<html><body>Just a page</body></html>"), null);
	assert.equal(web.indexOf(Buffer.from("<html>nothing</html>")).notWiki, true);
	assert.equal(web.indexOf(Buffer.from("<div id=\"encryptedStoreArea\"></div>")).encrypted, true);
});

test("index: version, plugins, and volatile tiddlers left out ($:/StoryList stays)", () => {
	const html = page(storeBlock([
		{ title: "Note", text: "n" },
		{ title: "$:/StoryList", list: "Note" },
		{ title: "$:/HistoryList", text: "[]" },
		{ title: "$:/temp/x", text: "t" },
		{ title: "$:/state/y", text: "s" },
		{ title: "$:/status/z", text: "s" },
		{ title: "$:/plugins/me/p", "plugin-type": "plugin", version: "1.2.0", description: "P", text: "{\"tiddlers\":{}}" }
	]));
	const index = web.indexOf(Buffer.from(html));
	assert.equal(index.twVersion, "5.4.1");
	assert.deepEqual(Object.keys(index.tiddlers).sort(), ["$:/StoryList", "$:/plugins/me/p", "Note"]);
	assert.deepEqual(index.plugins, [{ title: "$:/plugins/me/p", type: "plugin", version: "1.2.0", description: "P" }]);
	assert.equal(index.size, Buffer.byteLength(html));
	assert.match(index.fileHash, /^[0-9a-f]{64}$/);
});

test("tiddler hashes ignore field order, revision and bag", () => {
	const one = web.indexOf(Buffer.from(page(storeBlock([{ title: "T", text: "x", tags: "a" }]))));
	const two = web.indexOf(Buffer.from(page(storeBlock([{ tags: "a", revision: "7", bag: "default", text: "x", title: "T" }]))));
	const three = web.indexOf(Buffer.from(page(storeBlock([{ title: "T", text: "y", tags: "a" }]))));
	assert.equal(one.tiddlers.T, two.tiddlers.T);
	assert.notEqual(one.tiddlers.T, three.tiddlers.T);
});

test("compare counts added, changed and removed tiddlers", () => {
	const before = web.indexOf(Buffer.from(page(storeBlock([{ title: "A", text: "1" }, { title: "B", text: "1" }, { title: "C", text: "1" }]))));
	const after = web.indexOf(Buffer.from(page(storeBlock([{ title: "A", text: "1" }, { title: "B", text: "2" }, { title: "D", text: "1" }, { title: "$:/temp/new", text: "1" }]))));
	assert.deepEqual(web.compare(before, after), { added: 1, changed: 1, removed: 1 });
	assert.equal(web.compare(before, { tiddlers: null }), null);
});

test("reads a real single-file wiki made by the bundled TiddlyWiki", () => {
	const html = tw.wikiHtml([{ title: "$:/StoryList", list: "Hello" }, { title: "Hello", text: "<b>hi</b>" }]);
	const index = web.indexOf(Buffer.from(html));
	assert.equal(index.twVersion, tw.TW_VERSION);
	assert.ok(index.tiddlers.Hello);
	assert.ok(index.tiddlers["$:/StoryList"]);
	assert.ok(index.plugins.some(p => p.title === "$:/core"));
	const text = web.readTiddlers(html).tiddlers.find(t => t.title === "Hello").text;
	assert.equal(text, "<b>hi</b>");
});

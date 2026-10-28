"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const links = require("../../src/links");
const tw = require("../helpers/tw");

const PLUGIN = path.join(__dirname, "..", "..", "src", "tw-plugins", "tw-desk-links");

test("link names: set in Edit, otherwise the folder's name; compared without case", () => {
	assert.equal(links.linkKeyOf({ path: path.resolve("/wikis/priv-orga") }), "priv-orga");
	assert.equal(links.linkKeyOf({ path: path.resolve("/wikis/priv-orga"), linkName: " private " }), "private");
	assert.ok(links.sameKey("Orga", "orga"));
	assert.equal(links.checkLinkName("my wiki"), null);
	assert.equal(links.checkLinkName(""), null);
	for (const bad of ["a/b", "a\\b", "a?b", "a#b", "50%", " lead"]) {
		assert.match(links.checkLinkName(bad), /can't contain/, bad);
	}
});

test("both link forms, and the copy request of the plugin button", () => {
	const title = "Some tiddler: a/b #1 [x]";
	for (const style of ["scheme", "http"]) {
		const url = links.linkUrl(style, "priv orga", title, 8089);
		assert.deepEqual(links.parseLink(url, 8089), { key: "priv orga", title }, url);
	}
	assert.equal(links.linkUrl("scheme", "orga", "A B", 8089), "twdesk://orga/A%20B");
	assert.equal(links.linkUrl("http", "orga", "A B", 8089), "http://127.0.0.1:8089/open/orga/A%20B");
	assert.deepEqual(links.parseLink("twdesk://orga", 8089), { key: "orga", title: "" });
	assert.deepEqual(links.parseLink("TWDESK://orga/", 8089), { key: "orga", title: "" });
	assert.deepEqual(links.parseLink("http://localhost:8089/open/orga/X", 8089), { key: "orga", title: "X" });
	// Another port is an ordinary web address
	assert.equal(links.parseLink("http://127.0.0.1:8090/open/orga/X", 8089), null);
	assert.equal(links.parseLink("https://tiddlywiki.com/#X", 8089), null);
	assert.equal(links.parseLink("twdesk://", 8089), null);
	assert.deepEqual(links.parseLink("twdesk-copy:A%20%7CB", 8089), { copy: "A |B", caption: "" });
	assert.deepEqual(links.parseLink("twdesk-copy:2026%2F1/My%20caption%2Fx", 8089), { copy: "2026/1", caption: "My caption/x" });
	assert.deepEqual(links.parseRouterPath("/open/orga/A%20B"), { key: "orga", title: "A B" });
	assert.equal(links.parseRouterPath("/favicon.ico"), null);
});

test("wikitext to paste: [ext[…]] for twdesk:// (TiddlyWiki wouldn't treat it as external), [[…]] for http", () => {
	assert.equal(links.linkWikitext("scheme", "orga", "Plan", 8089), "[ext[Plan (orga)|twdesk://orga/Plan]]");
	assert.equal(links.linkWikitext("http", "orga", "Plan", 8089), "[[Plan (orga)|http://127.0.0.1:8089/open/orga/Plan]]");
	// Characters that would end the link early are kept out of the text (the URL is encoded anyway)
	assert.equal(links.linkWikitext("scheme", "orga", "a|b]]c", 8089), "[ext[a/b] ]c (orga)|twdesk://orga/a%7Cb%5D%5Dc]]");
	assert.equal(links.linkWikitext("scheme", "orga", "", 8089), "[ext[orga|twdesk://orga]]");
	// The caption is shown instead of the title (e.g. for timestamp titles)
	assert.equal(links.linkWikitext("scheme", "orga", "20261028092438802", 8089, "Meeting notes"), "[ext[Meeting notes (orga)|twdesk://orga/20261028092438802]]");
});

test("the built-in plugin: loaded from its folder, copy button only in TW Desk windows", () => {
	const $tw = require("tiddlywiki").TiddlyWiki();
	const dir = tw.tempDir();
	try {
		tw.initWiki(path.join(dir, "wiki"));
		$tw.boot.argv = ["++" + PLUGIN, path.join(dir, "wiki"), "--version"];
		$tw.boot.boot(() => {});
		const plugin = JSON.parse($tw.wiki.getTiddlerText("$:/plugins/tw-desk/links"));
		assert.deepEqual(Object.keys(plugin.tiddlers).sort(), ["$:/plugins/tw-desk/links/copy-button", "$:/plugins/tw-desk/links/readme", "$:/plugins/tw-desk/links/startup.js"]);
		assert.ok($tw.wiki.filterTiddlers("[all[shadows]tag[$:/tags/ViewToolbar]]").includes("$:/plugins/tw-desk/links/copy-button"));
		const button = () => $tw.wiki.renderText("text/html", "text/vnd.tiddlywiki", "<$tiddler tiddler=\"A B\">{{$:/plugins/tw-desk/links/copy-button}}</$tiddler>");
		assert.doesNotMatch(button(), /<button/);
		// What the plugin's startup module sets in a TW Desk window
		$tw.wiki.addTiddler({ title: "$:/temp/tw-desk/window", text: "yes" });
		assert.match(button(), /<button[^>]*aria-label="copy TW Desk link"/);
		// What the button sends: the title, and the caption if there is one
		const param = () => /twdesk-copy:[^"]*/.exec($tw.wiki.renderText("text/plain", "text/vnd.tiddlywiki",
			"<$tiddler tiddler=\"A/B\"><$text text={{{ [<currentTiddler>encodeuricomponent[]] [<currentTiddler>get[caption]encodeuricomponent[]] +[join[/]addprefix[twdesk-copy:]] }}}/></$tiddler>"))[0];
		assert.match(fs.readFileSync(path.join(PLUGIN, "copy-button.tid"), "utf8"), /\[<currentTiddler>get\[caption\]encodeuricomponent\[\]\] \+\[join\[\/\]addprefix\[twdesk-copy:\]\]/);
		assert.equal(param(), "twdesk-copy:A%2FB");
		$tw.wiki.addTiddler({ title: "A/B", caption: "Nice / caption" });
		assert.equal(param(), "twdesk-copy:A%2FB/Nice%20%2F%20caption");
		assert.deepEqual(links.parseLink(param(), 8089), { copy: "A/B", caption: "Nice / caption" });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

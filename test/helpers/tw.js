"use strict";

// The bundled TiddlyWiki, run with plain Node: wiki folders and single-file wikis for the tests.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TW_DIR = path.dirname(require.resolve("tiddlywiki/package.json"));
const TW_VERSION = require("tiddlywiki/package.json").version;

function tiddlywiki(args, env = {}) {
	return execFileSync(process.execPath, [path.join(TW_DIR, "tiddlywiki.js"), ...args], {
		env: Object.assign({}, process.env, env),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"]
	});
}

function tempDir(prefix = "tw-desk-test-") {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A wiki folder like TW Desk's "Empty wiki" creates (edition "server", with tiddlyweb and filesystem)
function initWiki(folder, edition = "server") {
	fs.mkdirSync(folder, { recursive: true });
	tiddlywiki([folder, "--init", edition]);
	fs.mkdirSync(path.join(folder, "tiddlers"), { recursive: true });
	return folder;
}

function writeTiddler(folder, title, text, fields = {}) {
	const header = Object.entries(Object.assign({ title }, fields)).map(([k, v]) => k + ": " + v).join("\n");
	// File name as TiddlyWiki's filesystem plugin makes it, e.g. "$:/config/x" -> "$__config_x.tid"
	const file = path.join(folder, "tiddlers", title.replace(/[<>:"/\\|?*]/g, "_") + ".tid");
	fs.writeFileSync(file, header + "\n\n" + text);
	return file;
}

// The fields of a tiddler as TiddlyWiki loads the wiki folder (rendered with the json-tiddler template)
function loadTiddler(folder, title) {
	const name = "tw-desk-load-tiddler.json";
	const out = path.join(folder, "output", name);
	tiddlywiki([folder, "--render", "[[" + title + "]]", "[[" + name + "]]", "text/plain", "$:/core/templates/json-tiddler"]);
	try {
		return JSON.parse(fs.readFileSync(out, "utf8"));
	} finally {
		fs.rmSync(out, { force: true });
	}
}

let emptyHtml = null;

// The HTML of an empty single-file wiki (rendered once per process)
function emptyWikiHtml() {
	if (!emptyHtml) {
		const dir = tempDir("tw-desk-html-");
		try {
			initWiki(path.join(dir, "wiki"), "empty");
			tiddlywiki([path.join(dir, "wiki"), "--render", "$:/core/save/all", "wiki.html", "text/plain"]);
			emptyHtml = fs.readFileSync(path.join(dir, "wiki", "output", "wiki.html"), "utf8");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	return emptyHtml;
}

// A single-file wiki with these tiddlers in an extra store block before the original one (which boots later,
// so the block must come first; titles in it shouldn't also be in the original store)
function wikiHtml(tiddlers, base = emptyWikiHtml()) {
	const block = "<script class=\"tiddlywiki-tiddler-store\" type=\"application/json\">"
		+ JSON.stringify(tiddlers).replace(/</g, "\\u003C") + "</script>\n";
	const marker = /<div id="storeArea"[^>]*>/.exec(base);
	if (!marker) {
		throw new Error("No storeArea in the base HTML");
	}
	const at = marker.index + marker[0].length;
	return base.slice(0, at) + block + base.slice(at);
}

module.exports = { TW_DIR, TW_VERSION, tiddlywiki, tempDir, initWiki, writeTiddler, loadTiddler, emptyWikiHtml, wikiHtml };

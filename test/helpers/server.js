"use strict";

// A local stand-in for everything TW Desk reads from the web: a standard plugin library, a CPL-style library and
// single-file wikis whose content the test changes between requests (with ETag / Last-Modified and 304 answers).

const crypto = require("crypto");
const http = require("http");

// A plugin tiddler as libraries serve it; the plugin's own tiddlers say which version they belong to
function pluginTiddler(title, version, extra = {}) {
	const type = title.startsWith("$:/themes/") ? "theme" : title.startsWith("$:/languages/") ? "language" : "plugin";
	return Object.assign({
		title,
		"plugin-type": type,
		type: "application/json",
		version,
		description: "Test " + type + " " + title.split("/").pop(),
		author: "TestAuthor",
		text: JSON.stringify({ tiddlers: { [title + "/readme"]: { text: "Readme of " + title + " " + version } } })
	}, extra);
}

// What a library's index lists: the plugin without its content
function indexEntry(tiddler) {
	const entry = Object.assign({}, tiddler);
	delete entry.text;
	return entry;
}

// CPL file name, as in plugins.js pluginUrl()
function cplName(title) {
	return title.replace("$:/plugins/", "").replace("$:/languages/", "languages_").replace("$:/themes/", "themes_").replace(/[:/<>"|?*]/g, "_");
}

async function startServer() {
	const content = { library: [], cpl: [], pages: new Map() };
	const requests = [];
	const send = (res, status, body, headers = {}) => {
		res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers));
		res.end(body);
	};
	const server = http.createServer((req, res) => {
		requests.push({ method: req.method, url: req.url, headers: req.headers });
		const url = req.url.split("?")[0];
		let match;
		if (url === "/lib/recipes/library/tiddlers.json") {
			return send(res, 200, JSON.stringify(content.library.map(indexEntry)));
		}
		if ((match = /^\/lib\/recipes\/library\/tiddlers\/(.+)\.json$/.exec(url))) {
			// The library's file name is the encoded title, and the URL encodes that file name once more
			const title = decodeURIComponent(decodeURIComponent(match[1]));
			const tiddler = content.library.find(t => t.title === title);
			return tiddler ? send(res, 200, JSON.stringify([tiddler])) : send(res, 404, "{}");
		}
		if (url === "/cpl/index.json") {
			return send(res, 200, JSON.stringify(content.cpl.map(indexEntry)));
		}
		if ((match = /^\/cpl\/([^/]+)\/latest\.json$/.exec(url))) {
			const tiddler = content.cpl.find(t => cplName(t.title) === decodeURIComponent(match[1]));
			return tiddler ? send(res, 200, JSON.stringify(tiddler)) : send(res, 404, "{}");
		}
		const page = content.pages.get(url);
		if (page) {
			if (req.headers["if-none-match"] === page.etag) {
				res.writeHead(304, { ETag: page.etag });
				return res.end();
			}
			return send(res, 200, page.body, { "Content-Type": "text/html; charset=utf-8", ETag: page.etag, "Last-Modified": page.lastModified });
		}
		send(res, 404, "not found", { "Content-Type": "text/plain" });
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const base = "http://127.0.0.1:" + server.address().port;
	return {
		url: base,
		libraryUrl: base + "/lib/index.html",
		cplUrl: base + "/cpl",
		requests,
		setLibrary(tiddlers) {
			content.library = tiddlers;
		},
		setCpl(tiddlers) {
			content.cpl = tiddlers;
		},
		// Serves html at path (e.g. "/site/index.html"); returns the page's full URL
		setPage(path, html) {
			content.pages.set(path, {
				body: html,
				etag: "\"" + crypto.createHash("sha1").update(html).digest("hex") + "\"",
				lastModified: new Date().toUTCString()
			});
			return base + path;
		},
		close() {
			server.closeAllConnections();
			return new Promise(resolve => server.close(resolve));
		}
	};
}

module.exports = { startServer, pluginTiddler, cplName };

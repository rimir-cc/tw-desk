"use strict";

// Reading single-file wikis from the web: the tiddlers in the HTML, one hash per tiddler, and the comparison of two
// such indexes (to tell what changed on the site). Parsing follows TiddlyWiki's own "text/html" deserializer.

const crypto = require("crypto");

// Tiddlers that change by just using or saving the wiki. $:/StoryList stays: a wiki can open with the river it was saved with.
const VOLATILE = /^(\$:\/HistoryList|\$:\/isEncrypted|\$:\/temp\/|\$:\/state\/|\$:\/status\/)/;

function sha(data) {
	return crypto.createHash("sha256").update(data).digest("hex");
}

function htmlDecode(text) {
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (match, code) => {
		const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }[code.toLowerCase()];
		if (named) {
			return named;
		}
		const number = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
		return String.fromCodePoint(number);
	});
}

// TiddlyWiki 5.0/5.1: <div title="…" …><pre>text</pre></div> inside <div id="storeArea">
function oldStoreTiddlers(html, start) {
	const tiddlers = [];
	const endOfDiv = /(<\/div>\s*)/gi;
	endOfDiv.lastIndex = start;
	let from = start;
	let match;
	while ((match = endOfDiv.exec(html))) {
		const chunk = html.slice(from, endOfDiv.lastIndex);
		const head = /^\s*<div\s+([^>]*)>(\s*<pre>)?/i.exec(chunk);
		const end = head && (head[2] ? /<\/pre>\s*<\/div>\s*$/i : /<\/div>\s*$/i).exec(chunk);
		if (!end) {
			break;
		}
		const fields = { text: htmlDecode(chunk.slice(head[0].length, end.index)) };
		const attribute = /\s*([^=\s]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
		let a;
		while ((a = attribute.exec(head[1]))) {
			fields[a[1]] = htmlDecode(a[2] !== undefined ? a[2] : a[3]);
		}
		tiddlers.push(fields);
		from = endOfDiv.lastIndex;
	}
	return tiddlers;
}

// Returns { tiddlers: [fields] } for a TiddlyWiki, { encrypted: true }, or null if the HTML isn't a TiddlyWiki
function readTiddlers(html) {
	if (html.includes("id=\"encryptedStoreArea\"")) {
		return { encrypted: true };
	}
	let found = false;
	const tiddlers = [];
	const oldStore = /<div id=["']?storeArea['"]?( style=["']?display:none;["']?)?>/i.exec(html);
	if (oldStore) {
		found = true;
		tiddlers.push(...oldStoreTiddlers(html, oldStore.index + oldStore[0].length));
	}
	const newStore = /<script class="tiddlywiki-tiddler-store" type="([^"]*)">/gi;
	let match;
	while ((match = newStore.exec(html))) {
		found = true;
		const end = html.indexOf("</script>", newStore.lastIndex);
		if (end === -1 || match[1] !== "application/json") {
			continue;
		}
		let data;
		try {
			data = JSON.parse(html.slice(newStore.lastIndex, end));
		} catch (e) {
			continue;
		}
		for (const item of Array.isArray(data) ? data : [data]) {
			if (item && typeof item.title === "string") {
				tiddlers.push(item);
			}
		}
	}
	return found ? { tiddlers } : null;
}

// What the snapshot / baseline remembers: hashes of the file and of each tiddler
function indexOf(buffer) {
	const html = buffer.toString("utf8");
	const version = /<meta name="tiddlywiki-version" content="([^"]*)"/i.exec(html);
	const result = { fileHash: sha(buffer), size: buffer.length, twVersion: version ? version[1] : null, tiddlers: null };
	const parsed = readTiddlers(html);
	if (!parsed) {
		result.notWiki = true;
	} else if (parsed.encrypted) {
		result.encrypted = true;
	} else {
		result.tiddlers = {};
		for (const fields of parsed.tiddlers) {
			if (VOLATILE.test(fields.title)) {
				continue;
			}
			// Same fields in any order give the same hash; "revision" and "bag" come from a node server
			const names = Object.keys(fields).filter(n => n !== "revision" && n !== "bag").sort();
			result.tiddlers[fields.title] = sha(JSON.stringify(names.map(n => [n, String(fields[n])]))).slice(0, 24);
		}
		result.plugins = parsed.tiddlers
			.filter(t => typeof t["plugin-type"] === "string" && t.title.startsWith("$:/") && !VOLATILE.test(t.title))
			.map(t => ({ title: t.title, type: t["plugin-type"], version: t.version || null, description: t.description || null }));
	}
	return result;
}

// { added, changed, removed } between two indexes, or null when they can't be compared tiddler by tiddler
function compare(before, after) {
	if (!before.tiddlers || !after.tiddlers) {
		return null;
	}
	let added = 0;
	let changed = 0;
	for (const [title, hash] of Object.entries(after.tiddlers)) {
		if (!(title in before.tiddlers)) {
			added++;
		} else if (before.tiddlers[title] !== hash) {
			changed++;
		}
	}
	const removed = Object.keys(before.tiddlers).filter(title => !(title in after.tiddlers)).length;
	return { added, changed, removed };
}

module.exports = { readTiddlers, indexOf, compare };

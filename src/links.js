"use strict";

// Links between wikis. Two interchangeable forms point to the same thing, a tiddler in the wiki with a link name:
//   twdesk://<link name>/<title>                                   (scheme; TW Desk windows, and other programs once registered)
//   http://127.0.0.1:<router port>/open/<link name>/<title>       (TW Desk's small web server; any browser)
// Both are understood in TW Desk windows whatever form is chosen for copying. "twdesk-copy:<title>[/<caption>]" is only
// used inside TW Desk windows: the built-in plugin's button asks TW Desk to copy a link to that tiddler.

const path = require("path");

const SCHEME = "twdesk";
const COPY_SCHEME = "twdesk-copy";

// The wiki's link name: the one set in Edit, otherwise its folder's name
function linkKeyOf(wiki) {
	return String(wiki.linkName || "").trim() || path.basename(path.resolve(wiki.path));
}

function sameKey(a, b) {
	return a.toLowerCase() === b.toLowerCase();
}

// Returns an error message, or null if the name can be used in links
function checkLinkName(name) {
	if (!name) {
		return null;
	}
	if (/[/\\?#%]/.test(name) || name !== name.trim()) {
		return "A link name can't contain / \\ ? # % or start or end with a space.";
	}
	return null;
}

function safeDecode(text) {
	try {
		return decodeURIComponent(text);
	} catch (e) {
		return text;
	}
}

// "<key>/<title>" (both encoded) -> { key, title }
function splitTarget(rest) {
	const slash = rest.indexOf("/");
	const key = safeDecode(slash === -1 ? rest : rest.slice(0, slash));
	const title = slash === -1 ? "" : safeDecode(rest.slice(slash + 1));
	return key ? { key, title } : null;
}

// What a URL clicked in a wiki asks for: { key, title }, { copy: title, caption }, or null (not a TW Desk link)
function parseLink(url, routerPort) {
	const text = String(url || "");
	let match;
	if ((match = /^twdesk:\/\/([^?#]*)/i.exec(text))) {
		return splitTarget(match[1].replace(/\/+$/, ""));
	}
	if ((match = /^twdesk-copy:([^/]*)(?:\/(.*))?$/i.exec(text))) {
		return { copy: safeDecode(match[1]), caption: match[2] ? safeDecode(match[2]) : "" };
	}
	if ((match = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/open\/([^?#]*)/i.exec(text)) && Number(match[1]) === routerPort) {
		return splitTarget(match[2].replace(/\/+$/, ""));
	}
	return null;
}

// The path part of a router request ("/open/orga/Some%20tiddler") -> { key, title } or null
function parseRouterPath(pathname) {
	const match = /^\/open\/([^?#]*)$/.exec(pathname);
	return match ? splitTarget(match[1].replace(/\/+$/, "")) : null;
}

function linkUrl(style, key, title, port) {
	const target = encodeURIComponent(key) + (title ? "/" + encodeURIComponent(title) : "");
	return style === "http" ? "http://127.0.0.1:" + port + "/open/" + target : SCHEME + "://" + target;
}

// The wikitext to paste: TiddlyWiki only treats http(s) and a few other schemes as external, so twdesk:// needs [ext[…]].
// label: what the link shows instead of the title (the tiddler's caption)
function linkWikitext(style, key, title, port, label) {
	const shown = label || title;
	const text = (shown ? shown + " (" + key + ")" : key).replace(/\|/g, "/").replace(/\]\]/g, "] ]");
	const url = linkUrl(style, key, title, port);
	return style === "http" ? "[[" + text + "|" + url + "]]" : "[ext[" + text + "|" + url + "]]";
}

module.exports = { SCHEME, COPY_SCHEME, linkKeyOf, sameKey, checkLinkName, parseLink, parseRouterPath, linkUrl, linkWikitext };

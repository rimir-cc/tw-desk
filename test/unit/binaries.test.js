"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const binaries = require("../../src/binaries");
const tw = require("../helpers/tw");

let dir;
const put = (rel, content) => {
	const file = path.join(dir, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
};

beforeEach(() => {
	dir = tw.tempDir();
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

test("scan: binary file with .meta", () => {
	put("tiddlers/photo.png", Buffer.alloc(100, 1));
	put("tiddlers/photo.png.meta", "title: Photo\ntype: image/png\ntags: [[a b]]\n");
	const scan = binaries.scanFolder(dir);
	assert.equal(scan.items.length, 1);
	assert.partialDeepStrictEqual(scan.items[0], { title: "Photo", type: "image/png", state: "embedded", form: "file", bytes: 100 });
	assert.equal(scan.items[0].meta, path.join(dir, "tiddlers", "photo.png.meta"));
	assert.deepEqual(scan.embedded, { count: 1, bytes: 100 });
	assert.deepEqual(scan.externalized, { count: 0, bytes: 0, missing: 0 });
});

test("scan: binary file without .meta", () => {
	put("tiddlers/sub/doc.pdf", Buffer.alloc(10));
	const [item] = binaries.scanFolder(dir).items;
	assert.partialDeepStrictEqual(item, { title: "doc.pdf", type: "application/pdf", meta: null, form: "file" });
});

test("scan: base64 in a .tid", () => {
	put("tiddlers/img.tid", "title: Img\ntype: image/png\n\n" + Buffer.alloc(30, 7).toString("base64"));
	const scan = binaries.scanFolder(dir);
	assert.partialDeepStrictEqual(scan.items[0], { title: "Img", form: "tid", state: "embedded", bytes: 30 });
	assert.equal(scan.items[0].meta, null);
	assert.deepEqual(scan.embedded, { count: 1, bytes: 30 });
});

test("scan: externalized", () => {
	put("tiddlers/x.tid", "title: X\ntype: image/png\n_canonical_uri: files/x.png\n");
	put("files/x.png", Buffer.alloc(50));
	const scan = binaries.scanFolder(dir);
	assert.partialDeepStrictEqual(scan.items[0], { title: "X", state: "externalized", uri: "files/x.png", bytes: 50, missing: false });
	assert.deepEqual(scan.externalized, { count: 1, bytes: 50, missing: 0 });
	assert.deepEqual(scan.embedded, { count: 0, bytes: 0 });
});

test("scan: externalized with missing file", () => {
	put("tiddlers/x.tid", "title: X\ntype: image/png\n_canonical_uri: files/x.png\n");
	const scan = binaries.scanFolder(dir);
	assert.equal(scan.items[0].missing, true);
	assert.deepEqual(scan.externalized, { count: 1, bytes: 0, missing: 1 });
});

test("scan: ignored", () => {
	put("tiddlers/$__favicon.ico", Buffer.alloc(5));
	put("tiddlers/$__favicon.ico.meta", "title: $:/favicon.ico\ntype: image/x-icon\n");
	put("tiddlers/logo.svg", "<svg/>");
	put("tiddlers/note.tid", "title: Note\n\nhello");
	put("tiddlers/remote.tid", "title: Remote\ntype: image/png\n_canonical_uri: https://example.com/a.png\n");
	put("tiddlers/.git/config", "x");
	put("tiddlers/bundle/tiddlywiki.files", "{}");
	put("tiddlers/bundle/a.png", Buffer.alloc(3));
	put("tiddlers/data.json", JSON.stringify([{ title: "J", type: "image/png", text: "AAAA" }]));
	put("tiddlers/plain.json", JSON.stringify([{ title: "P", text: "hi" }]));
	const scan = binaries.scanFolder(dir);
	assert.deepEqual(scan.items, []);
	assert.deepEqual(scan.skipped.map(s => [path.relative(dir, s.file), s.reason]).sort(), [
		["tiddlers/bundle", "tiddlywiki.files"],
		["tiddlers/data.json", "json"]
	]);
});

test("scan: no tiddlers folder", () => {
	assert.deepEqual(binaries.scanFolder(dir).items, []);
});

test("types and extensions", () => {
	assert.equal(binaries.extensionFor("image/png"), ".png");
	assert.equal(binaries.extensionFor("image/jpeg"), ".jpg");
	assert.equal(binaries.typeForExtension(".png"), "image/png");
	assert.equal(binaries.typeForExtension(".svg"), null);
	assert.ok(binaries.BASE64_TYPES.has("application/pdf"));
	assert.ok(!binaries.BASE64_TYPES.has("image/svg+xml"));
});

test("parseFields/serializeFields round trip", () => {
	const text = "created: 2024\ntitle: T\ntags: [[a b]] c\n\nbody\n\nmore";
	const { fields, body } = binaries.parseFields(text);
	assert.deepEqual(Object.keys(fields), ["created", "title", "tags"]);
	assert.equal(body, "body\n\nmore");
	assert.equal(binaries.serializeFields(fields, body), "title: T\ncreated: 2024\ntags: [[a b]] c\n\nbody\n\nmore");
	assert.equal(binaries.serializeFields(fields), "title: T\ncreated: 2024\ntags: [[a b]] c\n");
	assert.deepEqual(binaries.parseFields("title: M\ntype: image/png\n"), { fields: { title: "M", type: "image/png" }, body: "" });
});

test("fieldsSafe", () => {
	assert.equal(binaries.fieldsSafe({ title: "T", tags: "a b" }), true);
	assert.equal(binaries.fieldsSafe({ title: " x" }), false);
	assert.equal(binaries.fieldsSafe({ title: "x\u0001" }), false);
	assert.equal(binaries.fieldsSafe({ title: "T", "a:b": "1" }), false);
	assert.equal(binaries.fieldsSafe({ title: "T", "a#b": "1" }), false);
	assert.equal(binaries.fieldsSafe({ title: "T", text: " body\n" }), true);
});

const sha = content => require("crypto").createHash("sha256").update(content).digest("hex");

test("fileNameFor: unsafe and long titles", () => {
	const filesDir = path.join(dir, "files");
	const name = (title, type) => binaries.fileNameFor(title, type, filesDir, sha("x")).name;
	assert.equal(name("a<b>:c?.png", "image/png"), "a_b__c_.png");
	assert.equal(name("Report. ", "application/pdf"), "Report.pdf");
	const long = name("x".repeat(300), "application/pdf");
	assert.ok(long.length <= 120);
	assert.ok(long.endsWith(".pdf"));
	assert.equal(name("photo", "image/png"), "photo.png");
	assert.equal(name("photo.PNG", "image/png"), "photo.PNG");
});

test("fileNameFor: clash and reuse", () => {
	const filesDir = path.join(dir, "files");
	put("files/photo.png", "old");
	assert.deepEqual(binaries.fileNameFor("photo", "image/png", filesDir, sha("new")), { name: "photo (2).png", reuse: false });
	assert.deepEqual(binaries.fileNameFor("photo", "image/png", filesDir, sha("old")), { name: "photo.png", reuse: true });
});

test("fileNameFor: Windows reserved names", () => {
	const filesDir = path.join(dir, "files");
	const name = (title, type) => binaries.fileNameFor(title, type, filesDir, sha("x")).name;
	assert.equal(name("CON", "image/png"), "CON_.png");
	assert.equal(name("nul.tar", "application/pdf"), "nul_.tar.pdf");
	assert.equal(name("com1", "image/png"), "com1_.png");
	assert.equal(name("console", "image/png"), "console.png");
});

test("fileNameFor: numbering, empty stems, numbered reuse", () => {
	const filesDir = path.join(dir, "files");
	assert.equal(binaries.fileNameFor("...", "image/png", filesDir, sha("x")).name, "file.png");
	assert.equal(binaries.fileNameFor(" ", "application/pdf", filesDir, sha("x")).name, "file.pdf");
	put("files/photo.png", "a");
	put("files/photo (2).png", "b");
	assert.deepEqual(binaries.fileNameFor("photo", "image/png", filesDir, sha("c")), { name: "photo (3).png", reuse: false });
	assert.deepEqual(binaries.fileNameFor("photo", "image/png", filesDir, sha("b")), { name: "photo (2).png", reuse: true });
});

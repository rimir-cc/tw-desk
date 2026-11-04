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
	assert.equal(name("photo.PNG", "image/png"), "photo.png");
});

test("fileNameFor: keeps a registered secondary extension", () => {
	const filesDir = path.join(dir, "files");
	const name = (title, type) => binaries.fileNameFor(title, type, filesDir, sha("x")).name;
	assert.equal(name("photo.jpeg", "image/jpeg"), "photo.jpeg");
	assert.equal(name("Photo.JPEG", "image/jpeg"), "Photo.jpeg");
	assert.equal(name("song.m4a", "audio/mp4"), "song.m4a");
	assert.equal(name("photo.m4a", "image/jpeg"), "photo.m4a.jpg");
});

test("removeTempFiles: removes leftovers in tiddlers/ and files/", () => {
	put("tiddlers/a.png.tw-desk-tmp", "x");
	put("tiddlers/sub/b.tid.tw-desk-tmp", "x");
	put("tiddlers/keep.tid", "title: keep\n\nx");
	put("files/c.png.tw-desk-tmp", "x");
	put("files/c.png", "x");
	binaries.removeTempFiles(dir);
	assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")).sort(), ["keep.tid", "sub"]);
	assert.deepEqual(fs.readdirSync(path.join(dir, "files")), ["c.png"]);
	binaries.removeTempFiles(path.join(dir, "nonexistent"));
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

// applyPolicy

const PNG = Buffer.from(Array.from({ length: 100 }, (_, i) => (i * 7) % 256));
const read = rel => fs.readFileSync(path.join(dir, rel));
const exists = rel => fs.existsSync(path.join(dir, rel));
const tidFields = rel => binaries.parseFields(read(rel).toString("utf8"));

function putPhoto() {
	put("tiddlers/photo.png", PNG);
	put("tiddlers/photo.png.meta", "title: Photo\ntype: image/png\ntags: [[a b]]\n");
}

test("applyPolicy: externalize a binary file with .meta", () => {
	putPhoto();
	const result = binaries.applyPolicy(dir, "externalize");
	assert.deepEqual(result, { done: [{ title: "Photo", action: "externalized", bytes: 100 }], skipped: [], errors: [] });
	assert.deepEqual(read("files/photo.png"), PNG);
	assert.equal(exists("tiddlers/photo.png"), false);
	assert.equal(exists("tiddlers/photo.png.meta"), false);
	assert.equal(read("tiddlers/photo.png.tid").toString("utf8"),
		"title: Photo\ntype: image/png\ntags: [[a b]]\n_canonical_uri: files/photo.png\n");
	assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")), ["photo.png.tid"]);
	assert.deepEqual(fs.readdirSync(path.join(dir, "files")), ["photo.png"]);
});

test("applyPolicy: a binary file without .meta is skipped", () => {
	put("tiddlers/doc.pdf", PNG);
	const result = binaries.applyPolicy(dir, "externalize");
	assert.deepEqual(result, { done: [], skipped: [{ title: "doc.pdf", reason: "no .meta file – TiddlyWiki titles it with its full path" }], errors: [] });
	assert.deepEqual(read("tiddlers/doc.pdf"), PNG);
	assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")), ["doc.pdf"]);
	assert.equal(exists("files"), false);
	assert.deepEqual(binaries.applyPolicy(dir, "internalize"), { done: [], skipped: [], errors: [] });
});

test("applyPolicy: externalize lower-cases the extension in files/", () => {
	put("tiddlers/SCAN.PDF", PNG);
	put("tiddlers/SCAN.PDF.meta", "title: Scan\ntype: application/pdf\n");
	const result = binaries.applyPolicy(dir, "externalize");
	assert.deepEqual(result.done, [{ title: "Scan", action: "externalized", bytes: 100 }]);
	assert.deepEqual(fs.readdirSync(path.join(dir, "files")), ["SCAN.pdf"]);
	assert.deepEqual(read("files/SCAN.pdf"), PNG);
	assert.equal(tidFields("tiddlers/SCAN.PDF.tid").fields._canonical_uri, "files/SCAN.pdf");
});

test("applyPolicy: externalize base64 in a .tid", () => {
	const b64 = PNG.toString("base64");
	put("tiddlers/Img.tid", "title: Img\ntype: image/png\ncreated: 20260101000000000\n\n" + b64.slice(0, 40) + "\n" + b64.slice(40) + "\n");
	const result = binaries.applyPolicy(dir, "externalize");
	assert.deepEqual(result.done, [{ title: "Img", action: "externalized", bytes: 100 }]);
	assert.deepEqual(read("files/Img.png"), PNG);
	assert.equal(read("tiddlers/Img.tid").toString("utf8"),
		"title: Img\ntype: image/png\ncreated: 20260101000000000\n_canonical_uri: files/Img.png\n");
});

test("applyPolicy: externalize refuses invalid base64 and an existing .tid", () => {
	put("tiddlers/Bad.tid", "title: Bad\ntype: image/png\n\nnot*base64!");
	put("tiddlers/x.png", PNG);
	put("tiddlers/x.png.meta", "title: x.png\ntype: image/png\n");
	put("tiddlers/x.png.tid", "title: Other\n\nhello");
	const result = binaries.applyPolicy(dir, "externalize");
	assert.deepEqual(result.done, []);
	assert.deepEqual(result.errors.map(e => e.title).sort(), ["Bad", "x.png"]);
	assert.equal(read("tiddlers/Bad.tid").toString("utf8"), "title: Bad\ntype: image/png\n\nnot*base64!");
	assert.deepEqual(read("tiddlers/x.png"), PNG);
	assert.equal(read("tiddlers/x.png.tid").toString("utf8"), "title: Other\n\nhello");
	assert.deepEqual(fs.existsSync(path.join(dir, "files")) ? fs.readdirSync(path.join(dir, "files")) : [], []);
});

test("applyPolicy: externalize reuses a file with the same content and avoids clashes", () => {
	put("files/photo.png", PNG);
	put("files/other.png", "other");
	putPhoto();
	put("tiddlers/other.png", PNG);
	put("tiddlers/other.png.meta", "title: other\ntype: image/png\n");
	const result = binaries.applyPolicy(dir, "externalize");
	assert.equal(result.errors.length, 0);
	assert.equal(tidFields("tiddlers/photo.png.tid").fields._canonical_uri, "files/photo.png");
	assert.equal(tidFields("tiddlers/other.png.tid").fields._canonical_uri, "files/other (2).png");
	assert.equal(read("files/other.png").toString("utf8"), "other");
	assert.deepEqual(read("files/other (2).png"), PNG);
});

test("applyPolicy: internalize back", () => {
	putPhoto();
	binaries.applyPolicy(dir, "externalize");
	const result = binaries.applyPolicy(dir, "internalize");
	assert.deepEqual(result, { done: [{ title: "Photo", action: "internalized", bytes: 100 }], skipped: [], errors: [] });
	assert.deepEqual(read("tiddlers/photo.png"), PNG);
	assert.equal(read("tiddlers/photo.png.meta").toString("utf8"), "title: Photo\ntype: image/png\ntags: [[a b]]\n");
	assert.equal(exists("tiddlers/photo.png.tid"), false);
	assert.deepEqual(read("files/photo.png"), PNG);
	assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")).sort(), ["photo.png", "photo.png.meta"]);
});

test("applyPolicy: internalize refuses files that a symlink leads out of files/", t => {
	putPhoto();
	binaries.applyPolicy(dir, "externalize");
	const outside = tw.tempDir();
	try {
		fs.writeFileSync(path.join(outside, "photo.png"), "secret");
		fs.unlinkSync(path.join(dir, "files/photo.png"));
		try {
			fs.symlinkSync(path.join(outside, "photo.png"), path.join(dir, "files/photo.png"));
		} catch (e) {
			t.skip("no symlinks here");
			return;
		}
		const result = binaries.applyPolicy(dir, "internalize");
		assert.deepEqual(result.skipped, [{ title: "Photo", reason: "file is not in the files folder" }]);
		assert.equal(exists("tiddlers/photo.png.tid"), true);
	} finally {
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("applyPolicy: internalize names the binary after the title when the .tid name doesn't fit", () => {
	put("tiddlers/Some Image.tid", "title: My: Image\ntype: image/jpeg\n_canonical_uri: files/x.jpg\n");
	put("files/x.jpg", PNG);
	const result = binaries.applyPolicy(dir, "internalize");
	assert.deepEqual(result.done, [{ title: "My: Image", action: "internalized", bytes: 100 }]);
	assert.deepEqual(read("tiddlers/My_ Image.jpg"), PNG);
	assert.deepEqual(binaries.parseFields(read("tiddlers/My_ Image.jpg.meta").toString("utf8")).fields,
		{ title: "My: Image", type: "image/jpeg" });
	assert.equal(exists("tiddlers/Some Image.tid"), false);
});

test("applyPolicy: internalize refuses an existing target", () => {
	put("tiddlers/photo.png.tid", "title: Photo\ntype: image/png\n_canonical_uri: files/photo.png\n");
	put("files/photo.png", PNG);
	put("tiddlers/photo.png", "different");
	const result = binaries.applyPolicy(dir, "internalize");
	assert.deepEqual(result.done, []);
	assert.equal(result.errors.length, 1);
	assert.equal(read("tiddlers/photo.png").toString("utf8"), "different");
	assert.ok(exists("tiddlers/photo.png.tid"));
});

test("applyPolicy: internalize and a .meta left without its binary", () => {
	put("tiddlers/photo.png.tid", "title: Photo\ntype: image/png\n_canonical_uri: files/photo.png\n");
	put("tiddlers/photo.png.meta", "type: image/png\n\ntitle: Photo");
	put("files/photo.png", PNG);
	assert.deepEqual(binaries.applyPolicy(dir, "internalize").done, [{ title: "Photo", action: "internalized", bytes: 100 }]);
	assert.equal(read("tiddlers/photo.png.meta").toString("utf8"), "title: Photo\ntype: image/png\n");
	put("tiddlers/q.png.tid", "title: Q\ntype: image/png\n_canonical_uri: files/photo.png\n");
	put("tiddlers/q.png.meta", "title: Other\n");
	const result = binaries.applyPolicy(dir, "internalize");
	assert.deepEqual(result.errors, [{ title: "Q", message: "q.png.meta already exists" }]);
	assert.equal(read("tiddlers/q.png.meta").toString("utf8"), "title: Other\n");
	assert.equal(exists("tiddlers/q.png"), false);
});

test("applyPolicy: internalize skips missing files", () => {
	const tid = "title: X\ntype: image/png\n_canonical_uri: files/x.png\n";
	put("tiddlers/x.tid", tid);
	const result = binaries.applyPolicy(dir, "internalize");
	assert.deepEqual(result, { done: [], skipped: [{ title: "X", reason: "file not on this machine" }], errors: [] });
	assert.equal(read("tiddlers/x.tid").toString("utf8"), tid);
});

test("applyPolicy: internalize leaves files outside files/ alone", () => {
	put("tiddlers/a.tid", "title: A\ntype: image/png\n_canonical_uri: ../outside.png\n");
	put("tiddlers/b.tid", "title: B\ntype: image/png\n_canonical_uri: images/b.png\n");
	put("tiddlers/c.tid", "title: C\ntype: image/png\n_canonical_uri: files/../images/b.png\n");
	put("images/b.png", PNG);
	fs.writeFileSync(path.join(path.dirname(dir), path.basename(dir) + "-outside.png"), PNG);
	try {
		const result = binaries.applyPolicy(dir, "internalize");
		assert.deepEqual(result.done, []);
		assert.deepEqual(result.errors, []);
		assert.deepEqual(result.skipped.map(s => s.title).sort(), ["A", "B", "C"]);
		assert.ok(result.skipped.every(s => s.reason === "file is not in the files folder"));
		assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")).sort(), ["a.tid", "b.tid", "c.tid"]);
	} finally {
		fs.rmSync(path.join(path.dirname(dir), path.basename(dir) + "-outside.png"), { force: true });
	}
});

test("applyPolicy: file names with # and % round trip", () => {
	put("tiddlers/x.png.tid", "title: C# 100%\ntype: image/png\n\n" + PNG.toString("base64"));
	binaries.applyPolicy(dir, "externalize");
	const uri = tidFields("tiddlers/x.png.tid").fields._canonical_uri;
	assert.equal(uri, "files/C%23 100%25.png");
	assert.deepEqual(read("files/C# 100%.png"), PNG);
	const scan = binaries.scanFolder(dir);
	assert.partialDeepStrictEqual(scan.items[0], { state: "externalized", bytes: 100, missing: false });
	const result = binaries.applyPolicy(dir, "internalize");
	assert.deepEqual(result.done, [{ title: "C# 100%", action: "internalized", bytes: 100 }]);
	assert.deepEqual(read("tiddlers/x.png"), PNG);
	assert.equal(binaries.parseFields(read("tiddlers/x.png.meta").toString("utf8")).fields.title, "C# 100%");
});

test("applyPolicy: recovers a half-done externalize and internalize", () => {
	for (const policy of ["externalize", "internalize"]) {
		fs.rmSync(path.join(dir, "tiddlers"), { recursive: true, force: true });
		putPhoto();
		put("tiddlers/photo.png.tid", "title: Photo\ntype: image/png\ntags: [[a b]]\n_canonical_uri: files/photo.png\n");
		put("files/photo.png", PNG);
		put("tiddlers/photo.png.tid.tw-desk-tmp", "leftover");
		const result = binaries.applyPolicy(dir, policy);
		assert.deepEqual(result, { done: [{ title: "Photo", action: "recovered", bytes: 100 }], skipped: [], errors: [] });
		const left = fs.readdirSync(path.join(dir, "tiddlers")).sort();
		assert.deepEqual(left, policy === "externalize" ? ["photo.png.tid"] : ["photo.png", "photo.png.meta"]);
		assert.deepEqual(read("files/photo.png"), PNG);
	}
});

test("applyPolicy: two tiddler files with different content are left alone", () => {
	for (const policy of ["externalize", "internalize"]) {
		putPhoto();
		put("tiddlers/photo.png.tid", "title: Photo\ntype: image/png\ntags: [[a b]]\n_canonical_uri: files/photo.png\n");
		put("files/photo.png", "different");
		const result = binaries.applyPolicy(dir, policy);
		assert.deepEqual(result.done, []);
		assert.equal(result.errors.length, 1);
		assert.equal(result.errors[0].title, "Photo");
		assert.ok(result.errors[0].message.includes("two tiddler files"));
		assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")).sort(), ["photo.png", "photo.png.meta", "photo.png.tid"]);
		assert.equal(read("files/photo.png").toString("utf8"), "different");
	}
});

test("applyPolicy: same content but different fields is not recovered", () => {
	putPhoto();
	put("tiddlers/photo.png.tid", "title: Photo\ntype: image/png\ntags: other\n_canonical_uri: files/photo.png\n");
	put("files/photo.png", PNG);
	const result = binaries.applyPolicy(dir, "externalize");
	assert.ok(result.errors[0].message.includes("two tiddler files"));
	assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")).sort(), ["photo.png", "photo.png.meta", "photo.png.tid"]);
});

test("applyPolicy: system tiddlers and unsafe fields are skipped", () => {
	put("tiddlers/$__favicon.ico", PNG);
	put("tiddlers/$__favicon.ico.meta", "title: $:/favicon.ico\ntype: image/x-icon\n");
	put("tiddlers/u.png", PNG);
	// A value TiddlyWiki would save as JSON (a tab inside; " y" can't be expressed in a .meta at all)
	put("tiddlers/u.png.meta", "title: U\ntype: image/png\nx: a\tb\n");
	put("tiddlers/v.tid", "title: V\ntype: image/png\n_canonical_uri: files/v.png\nbad#name: 1\n");
	put("files/v.png", PNG);
	for (const policy of ["externalize", "internalize"]) {
		const result = binaries.applyPolicy(dir, policy);
		assert.deepEqual(result.done, []);
		assert.deepEqual(result.errors, []);
		assert.deepEqual(result.skipped, [{ title: policy === "externalize" ? "U" : "V", reason: "fields can't be written to a .tid/.meta file" }]);
	}
	assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")).sort(),
		["$__favicon.ico", "$__favicon.ico.meta", "u.png", "u.png.meta", "v.tid"]);
});

test("applyPolicy: TiddlyWiki loads the same fields after externalize and internalize", () => {
	const wiki = tw.initWiki(path.join(dir, "wiki"));
	fs.writeFileSync(path.join(wiki, "tiddlers", "photo.png"), PNG);
	fs.writeFileSync(path.join(wiki, "tiddlers", "photo.png.meta"),
		"title: Photo\ntype: image/png\ntags: [[a b]] c\ncreated: 20260101000000000\nmodified: 20260102000000000\ncaption: Cap\ncustom: x\n");
	const before = tw.loadTiddler(wiki, "Photo");
	assert.equal(before.text, PNG.toString("base64"));
	assert.deepEqual(binaries.applyPolicy(wiki, "externalize").errors, []);
	const external = tw.loadTiddler(wiki, "Photo");
	const { text, ...rest } = before;
	assert.deepEqual(external, Object.assign({}, rest, { _canonical_uri: "files/photo.png" }));
	assert.equal(external.text, undefined);
	assert.deepEqual(binaries.applyPolicy(wiki, "internalize").errors, []);
	assert.deepEqual(tw.loadTiddler(wiki, "Photo"), before);
});

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
		[path.join("tiddlers", "bundle"), "tiddlywiki.files"],
		[path.join("tiddlers", "data.json"), "json"]
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
	put("files/sub/x.pdf.tw-desk-tmp", "x");
	put("files/sub/x.pdf", "x");
	binaries.removeTempFiles(dir);
	assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")).sort(), ["keep.tid", "sub"]);
	assert.deepEqual(fs.readdirSync(path.join(dir, "files")).sort(), ["c.png", "sub"]);
	assert.deepEqual(fs.readdirSync(path.join(dir, "files", "sub")), ["x.pdf"]);
	binaries.removeTempFiles(path.join(dir, "nonexistent"));
});

test("removeTempFiles: doesn't follow a symlinked folder in files/", t => {
	const outside = tw.tempDir();
	try {
		fs.writeFileSync(path.join(outside, "y.pdf.tw-desk-tmp"), "x");
		fs.mkdirSync(path.join(dir, "files"));
		try {
			fs.symlinkSync(outside, path.join(dir, "files", "link"), "dir");
		} catch (e) {
			t.skip("no symlinks here");
			return;
		}
		binaries.removeTempFiles(dir);
		assert.ok(fs.existsSync(path.join(outside, "y.pdf.tw-desk-tmp")));
	} finally {
		fs.rmSync(outside, { recursive: true, force: true });
	}
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
// The part 1 fields of an applyPolicy result
const core = ({ done, skipped, errors }) => ({ done, skipped, errors });

function putPhoto() {
	put("tiddlers/photo.png", PNG);
	put("tiddlers/photo.png.meta", "title: Photo\ntype: image/png\ntags: [[a b]]\n");
}

test("applyPolicy: externalize a binary file with .meta", () => {
	putPhoto();
	const result = binaries.applyPolicy(dir, "externalize");
	assert.deepEqual(core(result), { done: [{ title: "Photo", action: "externalized", bytes: 100 }], skipped: [], errors: [] });
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
	assert.deepEqual(core(result), { done: [], skipped: [{ title: "doc.pdf", reason: "no .meta file – TiddlyWiki titles it with its full path" }], errors: [] });
	assert.deepEqual(read("tiddlers/doc.pdf"), PNG);
	assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")), ["doc.pdf"]);
	assert.equal(exists("files"), false);
	assert.deepEqual(core(binaries.applyPolicy(dir, "internalize")), { done: [], skipped: [], errors: [] });
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
	assert.deepEqual(core(result), { done: [{ title: "Photo", action: "internalized", bytes: 100 }], skipped: [], errors: [] });
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
	assert.deepEqual(core(result), { done: [], skipped: [{ title: "X", reason: "file not on this machine" }], errors: [] });
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
		assert.deepEqual(core(result), { done: [{ title: "Photo", action: "recovered", bytes: 100 }], skipped: [], errors: [] });
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

test("references: .tid, .meta and .json, any type", () => {
	put("tiddlers/a.tid", "title: A\ntype: image/png\n_canonical_uri: files/a.png\n\n");
	put("tiddlers/b.png", Buffer.alloc(3));
	put("tiddlers/b.png.meta", "title: B\ntype: image/png\ntw-desk-update-of: files/old%20b.png\n");
	put("tiddlers/c.json", JSON.stringify([{ title: "C", type: "text/vnd.tiddlywiki", _canonical_uri: "files/sub/c.txt" }]));
	put("tiddlers/d.tid", "title: D\n_canonical_uri: https://example.com/files/x.png\n\n");
	put("tiddlers/e.tid", "title: E\n_canonical_uri: files/../tiddlers/x.png\n\n");
	const scan = binaries.scanFolder(dir);
	assert.equal(scan.complete, true);
	assert.deepEqual([...scan.references.values()].map(r => [r.name, r.titles]).sort(),
		[["a.png", ["A"]], ["old b.png", ["B"]], ["sub/c.txt", ["C"]]]);
});

test("references: incomplete scans", () => {
	assert.equal(binaries.scanFolder(dir).complete, false); // no tiddlers/
	assert.equal(binaries.scanFolder(dir, { sub: "plugins", optional: true }).complete, true);
	put("tiddlers/ok.tid", "title: ok\n\n");
	put("tiddlers/bundle/tiddlywiki.files", "{}");
	const scan = binaries.scanFolder(dir);
	assert.equal(scan.complete, false);
	assert.match(scan.problems[0], /tiddlywiki\.files/);
	fs.rmSync(path.join(dir, "tiddlers", "bundle"), { recursive: true });
	put("tiddlers/broken.json", "{");
	assert.equal(binaries.scanFolder(dir).complete, false);
});

test("fileNameOfUri and nameKey", () => {
	assert.equal(binaries.fileNameOfUri("files/a%23b.png"), "a#b.png");
	assert.equal(binaries.fileNameOfUri("files\\sub\\x.pdf"), "sub/x.pdf");
	assert.equal(binaries.fileNameOfUri("./files/x.pdf"), "x.pdf");
	for (const bad of ["files/", "files/../x", "other/x", "/files/x", "file:///x", "files/a\0b"]) {
		assert.equal(binaries.fileNameOfUri(bad), null, bad);
	}
	assert.equal(binaries.nameKey("A.PNG", true), "a.png");
	assert.equal(binaries.nameKey("A.PNG", false), "A.PNG");
});

test("listFiles: regular files only", () => {
	put("files/a.png", "x");
	put("files/sub/b.pdf", "x");
	put("files/c.png.tw-desk-tmp", "x");
	assert.deepEqual(binaries.listFiles(dir).sort(), ["a.png", "sub/b.pdf"]);
	assert.deepEqual(binaries.listFiles(path.join(dir, "none")), []);
});

// Updates

const OLD = Buffer.from("old content of the file");
const NEW = Buffer.from("new content, longer than the old one");
const M = binaries.MARKER;
const backupOf = () => path.join(dir, "backup");

function putReportUpdate(extraMeta = "") {
	put("files/report.pdf", OLD);
	put("tiddlers/report.pdf", NEW);
	put("tiddlers/report.pdf.meta", "title: Report\ntype: application/pdf\ntags: x\n" + M + ": files/report.pdf\n" + extraMeta);
}

test("update: marker overwrites the same file and keeps the fields", () => {
	putReportUpdate();
	const result = binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf() });
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.skipped, []);
	assert.deepEqual(read("files/report.pdf"), NEW);
	assert.deepEqual(tidFields("tiddlers/report.pdf.tid").fields,
		{ title: "Report", type: "application/pdf", tags: "x", _canonical_uri: "files/report.pdf" });
	assert.equal(exists("tiddlers/report.pdf"), false);
	assert.equal(exists("tiddlers/report.pdf.meta"), false);
	assert.partialDeepStrictEqual(result.done[0], { title: "Report", action: "updated", bytes: NEW.length, name: "report.pdf", replaced: "report.pdf", reason: "marker" });
	assert.equal(result.done[0].backup, path.join(backupOf(), "report.pdf"));
	assert.deepEqual(fs.readFileSync(path.join(backupOf(), "report.pdf")), OLD);
});

test("update: git has the old version → no backup", () => {
	putReportUpdate();
	const result = binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf(), gitHas: new Set(["report.pdf"]) });
	assert.partialDeepStrictEqual(result.done[0], { action: "updated", name: "report.pdf", replaced: "report.pdf", reason: "marker" });
	assert.equal(result.done[0].backup, null);
	assert.equal(fs.existsSync(backupOf()), false);
	assert.deepEqual(read("files/report.pdf"), NEW);
});

test("update: without a backup folder nothing is overwritten", () => {
	putReportUpdate();
	const result = binaries.applyPolicy(dir, "externalize");
	assert.deepEqual(result.done, []);
	assert.equal(result.errors.length, 1);
	assert.deepEqual(read("files/report.pdf"), OLD);
	assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")).sort(), ["report.pdf", "report.pdf.meta"]);
	assert.deepEqual(fs.readdirSync(path.join(dir, "files")), ["report.pdf"]);
});

test("update: new type gets the new extension", () => {
	put("files/pic.png", OLD);
	put("tiddlers/pic.jpg", NEW);
	put("tiddlers/pic.jpg.meta", "title: Pic\ntype: image/jpeg\n" + M + ": files/pic.png\n");
	const result = binaries.applyPolicy(dir, "externalize", { backupDir: backupOf() });
	assert.deepEqual(result.errors, []);
	assert.partialDeepStrictEqual(result.done[0], { action: "updated", name: "pic.jpg", replaced: null, backup: null, reason: "marker" });
	assert.deepEqual(read("files/pic.jpg"), NEW);
	assert.deepEqual(read("files/pic.png"), OLD);
	assert.equal(tidFields("tiddlers/pic.jpg.tid").fields._canonical_uri, "files/pic.jpg");
});

test("update: shared file is not overwritten", () => {
	putReportUpdate();
	put("tiddlers/Other.tid", "title: Other\ntype: application/pdf\n_canonical_uri: files/report.pdf\n");
	const result = binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf() });
	assert.deepEqual(result.errors, []);
	assert.partialDeepStrictEqual(result.done[0], { title: "Report", action: "updated", name: "report (2).pdf", replaced: null, backup: null, reason: "shared" });
	assert.deepEqual(read("files/report.pdf"), OLD);
	assert.deepEqual(read("files/report (2).pdf"), NEW);
	assert.equal(tidFields("tiddlers/report.pdf.tid").fields._canonical_uri, "files/report (2).pdf");
	assert.equal(fs.existsSync(backupOf()), false);
});

test("update: a symlink or directory at the marker's name is not overwritten", t => {
	put("files/outside.pdf", OLD);
	try {
		fs.symlinkSync(path.join(dir, "files", "outside.pdf"), path.join(dir, "files", "report.pdf"));
	} catch (e) {
		t.skip("no symlinks here");
		return;
	}
	put("tiddlers/report.pdf", NEW);
	put("tiddlers/report.pdf.meta", "title: Report\ntype: application/pdf\n" + M + ": files/report.pdf\n");
	put("tiddlers/dir.pdf", NEW);
	put("tiddlers/dir.pdf.meta", "title: Dir\ntype: application/pdf\n" + M + ": files/dir.pdf\n");
	fs.mkdirSync(path.join(dir, "files", "dir.pdf"));
	const result = binaries.applyPolicy(dir, "externalize", { backupDir: backupOf() });
	assert.deepEqual(result.errors, []);
	const byTitle = Object.fromEntries(result.done.map(d => [d.title, d]));
	assert.partialDeepStrictEqual(byTitle.Report, { name: "report (2).pdf", replaced: null });
	assert.partialDeepStrictEqual(byTitle.Dir, { name: "dir (2).pdf", replaced: null });
	assert.deepEqual(read("files/outside.pdf"), OLD);
	assert.ok(fs.lstatSync(path.join(dir, "files", "report.pdf")).isSymbolicLink());
});

test("update: odd markers are skipped", () => {
	const cases = [
		["meta", "title: A\ntype: application/pdf\n" + M + ": files/report.pdf\n_canonical_uri: files/report.pdf\n", NEW, "update marker and _canonical_uri together"],
		["meta", "title: A\ntype: application/pdf\n" + M + ": files/report.pdf\n", Buffer.alloc(0), "update marker without new content"],
		["meta", "title: A\ntype: application/pdf\n" + M + ": files/../tiddlers/x.pdf\n", NEW, "update marker outside files/"],
		["meta", "title: A\ntype: application/pdf\n" + M + ": https://example.com/files/x.pdf\n", NEW, "update marker outside files/"],
		["tid", "title: A\ntype: application/pdf\n" + M + ": files/report.pdf\n_canonical_uri: files/report.pdf\n", null, "update marker and _canonical_uri together"]
	];
	for (const [form, fields, bytes, reason] of cases) {
		fs.rmSync(path.join(dir, "tiddlers"), { recursive: true, force: true });
		put("files/report.pdf", OLD);
		if (form === "meta") {
			put("tiddlers/a.pdf", bytes);
			put("tiddlers/a.pdf.meta", fields);
		} else {
			put("tiddlers/a.pdf.tid", fields);
		}
		const before = fs.readdirSync(path.join(dir, "tiddlers")).sort().map(n => [n, read(path.join("tiddlers", n))]);
		// confirmDelete: [] – report.pdf loses its only reference in some cases; deleting it isn't the point here
		const result = binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf(), confirmDelete: [] });
		assert.deepEqual(core(result), { done: [], skipped: [{ title: "A", reason }], errors: [] }, reason);
		assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")).sort().map(n => [n, read(path.join("tiddlers", n))]), before);
		assert.deepEqual(fs.readdirSync(path.join(dir, "files")), ["report.pdf"]);
		assert.deepEqual(read("files/report.pdf"), OLD);
		assert.equal(fs.existsSync(backupOf()), false);
	}
});

test("update: incomplete scan waits", () => {
	putReportUpdate();
	put("tiddlers/bundle/tiddlywiki.files", "{}");
	const result = binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf() });
	assert.deepEqual(core(result), { done: [], skipped: [{ title: "Report", reason: "scan incomplete – update waits" }], errors: [] });
	assert.deepEqual(read("files/report.pdf"), OLD);
	assert.ok(exists("tiddlers/report.pdf.meta"));
	fs.rmSync(path.join(dir, "tiddlers", "bundle"), { recursive: true });
	const outside = { references: new Map(), complete: false, problems: ["x"] };
	assert.deepEqual(binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf(), outside }).skipped,
		[{ title: "Report", reason: "scan incomplete – update waits" }]);
});

test("update: references from outside count as shared", () => {
	putReportUpdate();
	const outside = { references: new Map([["report.pdf", { name: "report.pdf", titles: ["Elsewhere"] }]]), complete: true, problems: [] };
	const result = binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf(), outside, caseInsensitive: false });
	assert.partialDeepStrictEqual(result.done[0], { name: "report (2).pdf", reason: "shared" });
	assert.deepEqual(read("files/report.pdf"), OLD);
});

test("update: implicit overwrite on re-import", () => {
	const setup = () => {
		fs.rmSync(path.join(dir, "tiddlers"), { recursive: true, force: true });
		fs.rmSync(path.join(dir, "files"), { recursive: true, force: true });
		put("files/report.pdf", OLD);
		put("tiddlers/report.pdf", NEW);
		put("tiddlers/report.pdf.meta", "title: report.pdf\ntype: application/pdf\n");
	};
	setup();
	let result = binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf() });
	assert.deepEqual(result.errors, []);
	assert.partialDeepStrictEqual(result.done[0], { action: "updated", name: "report.pdf", replaced: "report.pdf", reason: "reimport" });
	assert.deepEqual(read("files/report.pdf"), NEW);
	assert.deepEqual(fs.readFileSync(result.done[0].backup), OLD);
	assert.equal(tidFields("tiddlers/report.pdf.tid").fields._canonical_uri, "files/report.pdf");
	for (const record of [null, ["other.pdf"]]) {
		setup();
		result = binaries.applyPolicy(dir, "externalize", { record, backupDir: backupOf() });
		assert.deepEqual(result.done, [{ title: "report.pdf", action: "externalized", bytes: NEW.length }]);
		assert.deepEqual(read("files/report.pdf"), OLD);
		assert.deepEqual(read("files/report (2).pdf"), NEW);
	}
	// Still referenced by another tiddler
	setup();
	put("tiddlers/Other.tid", "title: Other\ntype: application/pdf\n_canonical_uri: files/report.pdf\n");
	result = binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf() });
	assert.deepEqual(result.done, [{ title: "report.pdf", action: "externalized", bytes: NEW.length }]);
	assert.deepEqual(read("files/report.pdf"), OLD);
});

test("update: implicit overwrite only once per name", () => {
	put("files/report.pdf", OLD);
	put("tiddlers/a/report.pdf", NEW);
	put("tiddlers/a/report.pdf.meta", "title: Report\ntype: application/pdf\n");
	put("tiddlers/b/report.pdf", PNG);
	put("tiddlers/b/report.pdf.meta", "title: report.pdf\ntype: application/pdf\n");
	const result = binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf() });
	assert.deepEqual(result.errors, []);
	assert.equal(result.done.length, 2);
	assert.equal(result.done.filter(d => d.reason === "reimport").length, 1);
	const other = result.done.find(d => d.reason !== "reimport");
	assert.equal(other.action, "externalized");
	const uris = ["a", "b"].map(sub => tidFields(path.join("tiddlers", sub, "report.pdf.tid")).fields._canonical_uri).sort();
	assert.deepEqual(uris, ["files/report (2).pdf", "files/report.pdf"]);
	assert.deepEqual(fs.readdirSync(path.join(dir, "files")).sort(), ["report (2).pdf", "report.pdf"]);
});

test("update: recovers a half-done update", () => {
	put("files/report.pdf", NEW);
	put("tiddlers/report.pdf.tid", "title: Report\ntype: application/pdf\ntags: x\n_canonical_uri: files/report.pdf\n");
	put("tiddlers/report.pdf", NEW);
	put("tiddlers/report.pdf.meta", "title: Report\ntype: application/pdf\ntags: x\n" + M + ": files/report.pdf\n");
	const result = binaries.applyPolicy(dir, "externalize", { record: ["report.pdf"], backupDir: backupOf() });
	assert.deepEqual(core(result), { done: [{ title: "Report", action: "recovered", bytes: NEW.length }], skipped: [], errors: [] });
	assert.deepEqual(fs.readdirSync(path.join(dir, "tiddlers")), ["report.pdf.tid"]);
	assert.deepEqual(read("files/report.pdf"), NEW);
});

test("update: internalize ignores the marker", () => {
	putReportUpdate();
	const result = binaries.applyPolicy(dir, "internalize", { record: ["report.pdf"], backupDir: backupOf() });
	assert.deepEqual(core(result), { done: [], skipped: [], errors: [] });
	assert.deepEqual(read("files/report.pdf"), OLD);
	assert.deepEqual(read("tiddlers/report.pdf"), NEW);
	assert.match(read("tiddlers/report.pdf.meta").toString("utf8"), new RegExp(M));
});

test("backupFile: subfolders and numbering", () => {
	put("files/sub/x.pdf", OLD);
	put("backup/sub/x.pdf", "earlier");
	const target = binaries.backupFile(path.join(dir, "files", "sub", "x.pdf"), backupOf(), "sub/x.pdf");
	assert.equal(target, path.join(backupOf(), "sub", "x (2).pdf"));
	assert.deepEqual(fs.readFileSync(target), OLD);
	assert.equal(exists("files/sub/x.pdf"), false);
	assert.equal(read("backup/sub/x.pdf").toString("utf8"), "earlier");
});

test("backupFile: across drives copies, verifies, then deletes", t => {
	put("files/x.pdf", OLD);
	const rename = fs.renameSync;
	let calls = 0;
	fs.renameSync = (...args) => {
		calls++;
		const e = new Error("cross-device link not permitted");
		e.code = "EXDEV";
		throw e;
	};
	t.after(() => {
		fs.renameSync = rename;
	});
	let target;
	try {
		target = binaries.backupFile(path.join(dir, "files", "x.pdf"), backupOf(), "x.pdf");
	} finally {
		fs.renameSync = rename;
	}
	assert.equal(calls, 1);
	assert.equal(target, path.join(backupOf(), "x.pdf"));
	assert.deepEqual(fs.readFileSync(target), OLD);
	assert.equal(exists("files/x.pdf"), false);
});

test("references: a JSON tiddler without a title", () => {
	put("tiddlers/c.json", JSON.stringify([{ type: "image/png", _canonical_uri: "files/c.png" }]));
	const scan = binaries.scanFolder(dir);
	assert.deepEqual([...scan.references.values()], [{ name: "c.png", titles: [""] }]);
});

test("references: a symlink in tiddlers/ makes the scan incomplete", t => {
	const outside = tw.tempDir();
	try {
		fs.writeFileSync(path.join(outside, "a.tid"), "title: A\n_canonical_uri: files/a.png\n\n");
		put("tiddlers/ok.tid", "title: ok\n\n");
		try {
			fs.symlinkSync(path.join(outside, "a.tid"), path.join(dir, "tiddlers", "a.tid"));
		} catch (e) {
			t.skip("no symlinks here");
			return;
		}
		const scan = binaries.scanFolder(dir);
		assert.equal(scan.complete, false);
		assert.match(scan.problems[0], /a\.tid/);
		fs.unlinkSync(path.join(dir, "tiddlers", "a.tid"));
		fs.symlinkSync(outside, path.join(dir, "tiddlers", "linked"), "dir");
		const again = binaries.scanFolder(dir);
		assert.equal(again.complete, false);
		assert.match(again.problems[0], /linked/);
	} finally {
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

// Deletions

// An externalized tiddler pointing to files/<name>
const putExt = (title, name) => put("tiddlers/" + title + ".tid", "title: " + title + "\ntype: image/png\n_canonical_uri: files/" + name + "\n");

function putAB() {
	put("files/a.png", "a");
	put("files/b.png", "b");
	putExt("a", "a.png");
}

test("delete: a file whose tiddler was removed", () => {
	putAB();
	const result = binaries.applyPolicy(dir, "externalize", { record: ["a.png", "b.png"], backupDir: backupOf() });
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.deleted, [{ name: "b.png", backup: path.join(backupOf(), "b.png") }]);
	assert.deepEqual(result.pending, []);
	assert.equal(result.guard, null);
	assert.equal(result.incomplete, null);
	assert.equal(exists("files/b.png"), false);
	assert.equal(fs.readFileSync(path.join(backupOf(), "b.png"), "utf8"), "b");
	assert.equal(exists("files/a.png"), true);
	assert.deepEqual(result.record, ["a.png"]);
});

test("delete: git has it → unlinked without backup", () => {
	putAB();
	const result = binaries.applyPolicy(dir, "externalize", { record: ["a.png", "b.png"], backupDir: backupOf(), gitHas: new Set(["b.png"]) });
	assert.deepEqual(result.deleted, [{ name: "b.png", backup: null }]);
	assert.equal(exists("files/b.png"), false);
	assert.equal(fs.existsSync(backupOf()), false);
});

test("delete: without a backup folder the file stays pending", () => {
	putAB();
	const result = binaries.applyPolicy(dir, "externalize", { record: ["a.png", "b.png"] });
	assert.deepEqual(result.deleted, []);
	assert.deepEqual(result.pending, ["b.png"]);
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0].title, "files/b.png");
	assert.equal(exists("files/b.png"), true);
	assert.deepEqual(result.record, ["a.png", "b.png"]);
});

test("delete: never-used files stay", () => {
	putAB();
	put("files/hand.png", "h");
	const result = binaries.applyPolicy(dir, "externalize", { record: ["a.png", "b.png"], backupDir: backupOf() });
	assert.deepEqual(result.deleted.map(d => d.name), ["b.png"]);
	assert.equal(exists("files/hand.png"), true);
	assert.deepEqual(result.record, ["a.png"]);
});

test("delete: first run only records", () => {
	putAB();
	putExt("c", "sub/c.png");
	for (const options of [{ backupDir: backupOf() }, undefined]) {
		const result = binaries.applyPolicy(dir, "externalize", options);
		assert.deepEqual(result.deleted, []);
		assert.deepEqual(result.pending, []);
		assert.equal(result.guard, null);
		assert.deepEqual(result.record, ["a.png", "sub/c.png"]);
		assert.equal(exists("files/b.png"), true);
	}
});

test("delete: outside references protect but aren't recorded", () => {
	putAB();
	const outside = { references: new Map([["b.png", { name: "b.png", titles: ["Elsewhere"] }]]), complete: true, problems: [] };
	const result = binaries.applyPolicy(dir, "externalize", { record: ["a.png", "b.png"], backupDir: backupOf(), outside, caseInsensitive: false });
	assert.deepEqual(result.deleted, []);
	assert.equal(exists("files/b.png"), true);
	assert.deepEqual(result.record, ["a.png"]);
});

test("delete: incomplete scan deletes nothing", () => {
	putAB();
	put("tiddlers/bundle/tiddlywiki.files", "{}");
	putExt("c", "c.png");
	const result = binaries.applyPolicy(dir, "externalize", { record: ["a.png", "b.png", "gone.png"], backupDir: backupOf() });
	assert.deepEqual(result.deleted, []);
	assert.deepEqual(result.pending, []);
	assert.match(result.incomplete, /tiddlywiki\.files/);
	assert.equal(exists("files/b.png"), true);
	assert.deepEqual(result.record, ["a.png", "b.png", "c.png", "gone.png"]);
	fs.rmSync(path.join(dir, "tiddlers", "bundle"), { recursive: true });
	const outside = { references: new Map(), complete: false, problems: ["outside problem"] };
	const again = binaries.applyPolicy(dir, "externalize", { record: ["a.png", "b.png"], backupDir: backupOf(), outside });
	assert.equal(again.incomplete, "outside problem");
	assert.deepEqual(again.deleted, []);
	assert.equal(exists("files/b.png"), true);
});

test("delete: guard – more than 10", () => {
	const names = Array.from({ length: 11 }, (_, i) => "f" + String(i).padStart(2, "0") + ".png");
	const setup = () => {
		for (const name of names) {
			put("files/" + name, name);
		}
		put("files/kept.png", "k");
		putExt("kept", "kept.png");
	};
	setup();
	const record = names.concat("kept.png");
	let result = binaries.applyPolicy(dir, "externalize", { record, backupDir: backupOf() });
	assert.deepEqual(result.guard, { reason: "many", count: 11 });
	assert.deepEqual(result.pending, names);
	assert.deepEqual(result.deleted, []);
	assert.equal(fs.readdirSync(path.join(dir, "files")).length, 12);
	assert.deepEqual(result.record, record.slice().sort());
	result = binaries.applyPolicy(dir, "externalize", { record, backupDir: backupOf(), confirmDelete: ["f03.png", "f07.png", "unknown.png"] });
	assert.equal(result.guard, null);
	assert.deepEqual(result.deleted.map(d => d.name), ["f03.png", "f07.png"]);
	assert.equal(result.pending.length, 9);
	assert.equal(exists("files/f03.png"), false);
	assert.equal(exists("files/f04.png"), true);
	assert.deepEqual(result.record, record.filter(n => n !== "f03.png" && n !== "f07.png").sort());
});

test("delete: guard – every file in use", () => {
	for (const name of ["a.png", "b.png", "c.png"]) {
		put("files/" + name, name);
	}
	put("tiddlers/other.tid", "title: other\n\n");
	let result = binaries.applyPolicy(dir, "externalize", { record: ["a.png", "b.png", "c.png"], backupDir: backupOf() });
	assert.deepEqual(result.guard, { reason: "all", count: 3 });
	assert.deepEqual(result.pending, ["a.png", "b.png", "c.png"]);
	assert.deepEqual(result.deleted, []);
	assert.deepEqual(result.record, ["a.png", "b.png", "c.png"]);
	// A missing entry doesn't hide that every existing file lost its tiddler
	result = binaries.applyPolicy(dir, "externalize", { record: ["a.png", "b.png", "c.png", "gone.png"], backupDir: backupOf() });
	assert.deepEqual(result.guard, { reason: "all", count: 3 });
	// R1: two files are deleted without asking
	fs.rmSync(path.join(dir, "files", "c.png"));
	result = binaries.applyPolicy(dir, "externalize", { record: ["a.png", "b.png"], backupDir: backupOf() });
	assert.equal(result.guard, null);
	assert.deepEqual(result.deleted.map(d => d.name), ["a.png", "b.png"]);
	assert.deepEqual(result.record, []);
});

test("delete: missing, directory and symlink entries are left alone", t => {
	putAB();
	fs.mkdirSync(path.join(dir, "files", "folder.png"));
	put("files/folder.png/inner.png", "i");
	let symlink = true;
	try {
		fs.symlinkSync(path.join(dir, "files", "a.png"), path.join(dir, "files", "link.png"));
	} catch (e) {
		symlink = false;
	}
	const record = ["a.png", "b.png", "missing.png", "folder.png"].concat(symlink ? ["link.png"] : []);
	const result = binaries.applyPolicy(dir, "externalize", { record, backupDir: backupOf() });
	assert.deepEqual(result.errors, []);
	assert.equal(result.guard, null);
	assert.deepEqual(result.deleted.map(d => d.name), ["b.png"]);
	assert.deepEqual(result.pending, []);
	assert.ok(fs.statSync(path.join(dir, "files", "folder.png")).isDirectory());
	assert.equal(exists("files/folder.png/inner.png"), true);
	assert.deepEqual(result.record, ["a.png"]);
	if (!symlink) {
		t.skip("no symlinks here");
		return;
	}
	assert.ok(fs.lstatSync(path.join(dir, "files", "link.png")).isSymbolicLink());
});

test("delete: name matching follows the platform's case rule", () => {
	const setup = () => {
		put("files/photo.png", "p");
		put("tiddlers/p.tid", "title: P\ntype: image/png\n_canonical_uri: files/Photo.PNG\n");
	};
	setup();
	let result = binaries.applyPolicy(dir, "externalize", { record: ["photo.png"], backupDir: backupOf(), caseInsensitive: true });
	assert.deepEqual(result.deleted, []);
	assert.equal(exists("files/photo.png"), true);
	assert.deepEqual(result.record, ["Photo.PNG"]);
	result = binaries.applyPolicy(dir, "externalize", { record: ["photo.png"], backupDir: backupOf(), caseInsensitive: false });
	assert.deepEqual(result.deleted.map(d => d.name), ["photo.png"]);
	assert.deepEqual(result.record, ["Photo.PNG"]);
});

test("delete: record entries are deduplicated by key", () => {
	putAB();
	const result = binaries.applyPolicy(dir, "externalize", { record: ["A.png", "b.png", "B.PNG", "../x.png", 7], backupDir: backupOf(), caseInsensitive: true });
	assert.deepEqual(result.deleted.map(d => d.name), ["b.png"]);
	assert.deepEqual(result.record, ["a.png"]);
});

test("delete: an updated file's old extension goes", () => {
	put("files/pic.png", OLD);
	put("tiddlers/pic.jpg", NEW);
	put("tiddlers/pic.jpg.meta", "title: Pic\ntype: image/jpeg\n" + M + ": files/pic.png\n");
	const result = binaries.applyPolicy(dir, "externalize", { record: ["pic.png"], backupDir: backupOf() });
	assert.deepEqual(result.errors, []);
	assert.partialDeepStrictEqual(result.done[0], { action: "updated", name: "pic.jpg" });
	assert.deepEqual(result.deleted, [{ name: "pic.png", backup: path.join(backupOf(), "pic.png") }]);
	assert.equal(exists("files/pic.png"), false);
	assert.deepEqual(read("files/pic.jpg"), NEW);
	assert.deepEqual(result.record, ["pic.jpg"]);
});

test("delete: internalize never deletes", () => {
	putAB();
	const result = binaries.applyPolicy(dir, "internalize", { record: ["a.png", "b.png"], backupDir: backupOf() });
	assert.deepEqual(result.deleted, []);
	assert.deepEqual(result.pending, []);
	assert.equal(result.guard, null);
	assert.equal(result.incomplete, null);
	assert.equal(result.record, null);
	assert.equal(exists("files/b.png"), true);
	assert.equal(exists("files/a.png"), true);
});

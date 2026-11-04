"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// formatBytes exists in main.js and renderer.js (no shared module); both must give the same text
function load(file) {
	const source = fs.readFileSync(path.join(__dirname, "../../src", file), "utf8");
	const start = source.indexOf("function formatBytes");
	const end = source.indexOf("\n}\n", start) + 3;
	const context = {};
	vm.runInNewContext(source.slice(start, end), context);
	return context.formatBytes;
}

test("formatBytes: main.js and renderer.js agree, units roll over", () => {
	const main = load("main.js");
	const renderer = load("renderer.js");
	const cases = [[0, "0 B"], [1023, "1023 B"], [2048, "2 KB"], [1536, "1.5 KB"], [20480, "20 KB"], [1023.6 * 1024, "1 MB"], [1024 * 1024, "1 MB"], [5 * 1024 ** 3, "5 GB"]];
	for (const [bytes, text] of cases) {
		assert.equal(main(bytes), text, "main " + bytes);
		assert.equal(renderer(bytes), text, "renderer " + bytes);
	}
});

"use strict";

// End-to-end tests: start TW Desk from source with a throwaway user-data folder (see test/e2e/fixtures.js).
// Run with `npm run test:e2e`; results, traces and screenshots of failed tests land in test-results/.

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
	testDir: "test/e2e",
	testMatch: "*.spec.js",
	// One TW Desk at a time: every instance starts TiddlyWiki servers and windows
	workers: 1,
	fullyParallel: false,
	timeout: 120000,
	expect: { timeout: 15000 },
	retries: 0,
	outputDir: "test-results/output",
	reporter: [["list"], ["html", { outputFolder: "test-results/report", open: "never" }]]
});

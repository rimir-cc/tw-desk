"use strict";

// Entry point of an Electron utility process that runs one TiddlyWiki command line,
// e.g. ["<wiki folder>", "--listen", "port=8090"]. The arguments come as JSON in TW_DESK_ARGS.

const args = JSON.parse(process.env.TW_DESK_ARGS || "[]");
const $tw = require("tiddlywiki").TiddlyWiki();
$tw.boot.argv = args;
$tw.boot.boot(() => {
	// Utility processes don't exit on their own, so end one-off commands like --init explicitly
	if (!args.includes("--listen")) {
		process.exit(0);
	}
});

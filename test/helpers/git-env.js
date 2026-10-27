"use strict";

// Git for the tests, independent of the user's git setup: an empty global config, a fixed identity and branch name.
// Require this before src/git.js – it takes its environment from process.env when loaded.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-desk-gitconfig-"));
const globalConfig = path.join(configDir, "gitconfig");
fs.writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n");

const GIT_ENV = {
	GIT_CONFIG_GLOBAL: globalConfig,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "TW Desk Test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "TW Desk Test",
	GIT_COMMITTER_EMAIL: "test@example.invalid"
};
Object.assign(process.env, GIT_ENV);

// Runs git directly (for setting up repositories and checking results)
function sh(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitAvailable() {
	try {
		sh(os.tmpdir(), "--version");
		return true;
	} catch (e) {
		return false;
	}
}

module.exports = { GIT_ENV, sh, gitAvailable };

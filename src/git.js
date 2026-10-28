"use strict";

// Git status and actions for wiki folders, using the git installed on the system.
// Git never prompts: credentials come from the system's credential store or the command fails.

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// Apps started from the Finder don't get the shell's PATH, so Homebrew's git (and its helpers) aren't found by name
const MAC_PATHS = ["/opt/homebrew/bin", "/usr/local/bin"];

const ENV = Object.assign({}, process.env, process.platform === "darwin" ? { PATH: [process.env.PATH].concat(MAC_PATHS).filter(Boolean).join(":") } : {}, {
	GIT_TERMINAL_PROMPT: "0",
	// Git Credential Manager would otherwise open a login window
	GCM_INTERACTIVE: "never",
	// "git status" then doesn't take the index lock, so it can't get in the way of other git tools
	GIT_OPTIONAL_LOCKS: "0"
});

let gitCommand = "git";

const GITIGNORE = ["output/", "$__StoryList.tid", "$__temp*", ""].join("\n");

function git(cwd, args, timeout = 20000) {
	return new Promise((resolve, reject) => {
		execFile(gitCommand, args, { cwd, env: ENV, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				const message = (stderr || "").trim() || (error.killed ? "git timed out" : error.message);
				reject(Object.assign(new Error(message), { code: error.code }));
			} else {
				resolve(stdout);
			}
		});
	});
}

// /usr/bin/git on macOS is a stub that opens an install dialog when the command line tools are missing
function macCommandLineTools() {
	return new Promise(resolve => {
		execFile("/usr/bin/xcode-select", ["-p"], { timeout: 10000 }, (error, stdout) => resolve(!error && fs.existsSync(stdout.trim())));
	});
}

// Returns the git version, or null if git isn't installed
async function version() {
	if (process.platform === "darwin") {
		const homebrew = MAC_PATHS.map(dir => path.join(dir, "git")).find(file => fs.existsSync(file));
		if (homebrew) {
			gitCommand = homebrew;
		} else if (await macCommandLineTools()) {
			gitCommand = "/usr/bin/git";
		} else {
			return null;
		}
	}
	try {
		return (await git(process.cwd(), ["--version"])).trim().replace(/^git version /, "");
	} catch (e) {
		return null;
	}
}

// The repository a folder belongs to, or null
async function repoRoot(folder) {
	try {
		return path.resolve((await git(folder, ["rev-parse", "--show-toplevel"])).trim());
	} catch (e) {
		return null;
	}
}

function parseStatus(output) {
	const result = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, changed: [], conflicts: [] };
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.startsWith("# branch.head ")) {
			const head = record.slice(14);
			result.detached = head === "(detached)";
			result.branch = result.detached ? null : head;
		} else if (record.startsWith("# branch.upstream ")) {
			result.upstream = record.slice(18);
		} else if (record.startsWith("# branch.ab ")) {
			const [ahead, behind] = record.slice(12).split(" ");
			result.ahead = Math.abs(parseInt(ahead, 10)) || 0;
			result.behind = Math.abs(parseInt(behind, 10)) || 0;
		} else if (record.startsWith("1 ")) {
			result.changed.push(record.split(" ").slice(8).join(" "));
		} else if (record.startsWith("2 ")) {
			result.changed.push(record.split(" ").slice(9).join(" "));
			// A rename is followed by its original path
			i++;
		} else if (record.startsWith("u ")) {
			const file = record.split(" ").slice(10).join(" ");
			result.changed.push(file);
			result.conflicts.push(file);
		} else if (record.startsWith("? ")) {
			result.changed.push(record.slice(2));
		}
	}
	return result;
}

// A tiddler is often two files (.tid / file + .meta); count it once
function tiddlerCount(files) {
	return new Set(files.map(f => f.replace(/\.meta$/, ""))).size;
}

function defaultMessage(files) {
	const now = new Date();
	const pad = n => String(n).padStart(2, "0");
	const stamp = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
	const count = tiddlerCount(files);
	return "TW Desk: " + count + (count === 1 ? " tiddler" : " tiddlers") + " changed (" + stamp + ")";
}

// Full status of the repository at root (local only; fetch() updates the remote side)
async function status(root) {
	const result = parseStatus(await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]));
	const gitDir = path.resolve(root, (await git(root, ["rev-parse", "--git-dir"])).trim());
	result.merging = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"].some(f => fs.existsSync(path.join(gitDir, f)));
	result.remotes = (await git(root, ["remote"])).split(/\r?\n/).filter(Boolean);
	result.remoteUrl = null;
	if (result.remotes.length) {
		const remote = result.upstream ? result.upstream.split("/")[0] : result.remotes.includes("origin") ? "origin" : result.remotes[0];
		try {
			result.remoteUrl = (await git(root, ["remote", "get-url", remote])).trim();
		} catch (e) {
			// keep null
		}
	}
	result.lastCommit = null;
	try {
		const [time, subject] = (await git(root, ["log", "-1", "--format=%ct%x00%s"])).trim().split("\0");
		result.lastCommit = { time: Number(time) * 1000, subject };
	} catch (e) {
		// no commits yet
	}
	result.changedCount = tiddlerCount(result.changed);
	result.suggestedMessage = defaultMessage(result.changed);
	return result;
}

async function fetch(root) {
	await git(root, ["fetch", "--quiet", "--prune"], 60000);
}

async function commit(root, message) {
	await git(root, ["add", "-A"]);
	const { changed } = parseStatus(await git(root, ["status", "--porcelain=v2", "-z"]));
	if (!changed.length) {
		return false;
	}
	await git(root, ["commit", "--quiet", "-m", (message || "").trim() || defaultMessage(changed)]);
	return true;
}

async function push(root) {
	const s = parseStatus(await git(root, ["status", "--porcelain=v2", "--branch", "-z"]));
	if (s.upstream) {
		try {
			await git(root, ["push", "--quiet"], 120000);
		} catch (e) {
			if (/rejected|fetch first|non-fast-forward/i.test(e.message)) {
				throw new Error("The remote has commits that aren't here yet. Pull first (if the branches have diverged, merge them with a git tool).\n\n" + e.message);
			}
			throw e;
		}
		return;
	}
	const remotes = (await git(root, ["remote"])).split(/\r?\n/).filter(Boolean);
	if (!remotes.length) {
		throw new Error("No remote configured.");
	}
	// First push of this branch: also set its upstream
	await git(root, ["push", "--quiet", "-u", remotes.includes("origin") ? "origin" : remotes[0], "HEAD"], 120000);
}

// Fast-forward only: TW Desk never creates merges; diverged branches need a real git tool
async function pull(root) {
	try {
		await git(root, ["pull", "--ff-only", "--quiet"], 120000);
	} catch (e) {
		if (/not possible to fast-forward|diverg/i.test(e.message)) {
			throw new Error("Local and remote changes have diverged. Merge them with a git tool, then check again.\n\n" + e.message);
		}
		throw e;
	}
}

async function init(folder) {
	await git(folder, ["init", "--quiet"]);
	const ignoreFile = path.join(folder, ".gitignore");
	if (!fs.existsSync(ignoreFile)) {
		fs.writeFileSync(ignoreFile, GITIGNORE);
	}
	await git(folder, ["add", "-A"]);
	await git(folder, ["commit", "--quiet", "-m", "TW Desk: initial commit"]);
}

async function addRemote(root, url) {
	const trimmed = (url || "").trim();
	if (!trimmed) {
		throw new Error("Please enter the remote URL.");
	}
	await git(root, ["remote", "add", "origin", trimmed]);
}

// For setups imported from a file: the URL comes from that file, so no options and no command-running transports
async function clone(url, target, branch) {
	if (!url || /^-/.test(url) || /^ext::/i.test(url)) {
		throw new Error("Not a usable remote URL: " + url);
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const args = ["-c", "protocol.ext.allow=never", "clone", "--quiet"];
	if (branch) {
		args.push("--branch", branch);
	}
	await git(path.dirname(target), args.concat("--", url, target), 600000);
}

module.exports = { version, repoRoot, status, fetch, commit, push, pull, init, addRemote, clone };

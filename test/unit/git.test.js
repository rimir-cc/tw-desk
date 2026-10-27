"use strict";

const { sh, gitAvailable } = require("../helpers/git-env");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const git = require("../../src/git");
const tw = require("../helpers/tw");

const skip = gitAvailable() ? false : "git is not installed";
let dir;

before(() => {
	dir = tw.tempDir("tw-desk-git-");
});

after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

// A wiki folder with a few tiddler files
function folder(name) {
	const target = path.join(dir, name);
	fs.mkdirSync(path.join(target, "tiddlers"), { recursive: true });
	fs.mkdirSync(path.join(target, "output"), { recursive: true });
	fs.writeFileSync(path.join(target, "tiddlywiki.info"), "{}");
	fs.writeFileSync(path.join(target, "tiddlers", "Note.tid"), "title: Note\n\nfirst");
	fs.writeFileSync(path.join(target, "tiddlers", "$__StoryList.tid"), "title: $:/StoryList\n\n");
	fs.writeFileSync(path.join(target, "output", "index.html"), "built");
	return target;
}

test("version and repoRoot", { skip }, async () => {
	assert.match(await git.version(), /^\d+\.\d+/);
	const plain = folder("plain");
	assert.equal(await git.repoRoot(plain), null);
	await git.init(plain);
	assert.equal(fs.realpathSync(await git.repoRoot(path.join(plain, "tiddlers"))), fs.realpathSync(plain));
});

test("init: .gitignore and a first commit without output/ and the story list", { skip }, async () => {
	const wiki = folder("init");
	await git.init(wiki);
	assert.equal(fs.readFileSync(path.join(wiki, ".gitignore"), "utf8"), "output/\n$__StoryList.tid\n$__temp*\n");
	assert.equal(sh(wiki, "log", "--format=%s"), "TW Desk: initial commit");
	assert.deepEqual(sh(wiki, "ls-files").split("\n").sort(), [".gitignore", "tiddlers/Note.tid", "tiddlywiki.info"]);
	const status = await git.status(wiki);
	assert.equal(status.branch, "main");
	assert.deepEqual(status.changed, []);
	assert.deepEqual(status.remotes, []);
	assert.equal(status.lastCommit.subject, "TW Desk: initial commit");
	assert.equal(status.merging, false);
});

test("status counts a tiddler with .meta once; commit uses the default message", { skip }, async () => {
	const wiki = folder("status");
	await git.init(wiki);
	fs.writeFileSync(path.join(wiki, "tiddlers", "Note.tid"), "title: Note\n\nchanged");
	fs.writeFileSync(path.join(wiki, "tiddlers", "image.png"), "png");
	fs.writeFileSync(path.join(wiki, "tiddlers", "image.png.meta"), "title: image.png\ntype: image/png");
	fs.writeFileSync(path.join(wiki, "tiddlers", "with space.tid"), "title: with space\n\nx");
	const status = await git.status(wiki);
	assert.deepEqual(status.changed.sort(), ["tiddlers/Note.tid", "tiddlers/image.png", "tiddlers/image.png.meta", "tiddlers/with space.tid"]);
	assert.equal(status.changedCount, 3);
	assert.match(status.suggestedMessage, /^TW Desk: 3 tiddlers changed \(\d{4}-\d\d-\d\d \d\d:\d\d\)$/);
	assert.equal(await git.commit(wiki), true);
	assert.match(sh(wiki, "log", "-1", "--format=%s"), /^TW Desk: 3 tiddlers changed/);
	assert.equal(await git.commit(wiki, "nothing to do"), false);
	fs.writeFileSync(path.join(wiki, "tiddlers", "Note.tid"), "title: Note\n\nagain");
	await git.commit(wiki, "  My message  ");
	assert.equal(sh(wiki, "log", "-1", "--format=%s"), "My message");
});

test("remote: first push sets the upstream, ahead/behind, fast-forward pull", { skip }, async () => {
	const bare = path.join(dir, "remote.git");
	sh(dir, "init", "--bare", "--quiet", bare);
	const wiki = folder("local");
	await git.init(wiki);
	await assert.rejects(git.push(wiki), /No remote/);
	await assert.rejects(git.addRemote(wiki, "  "), /enter the remote URL/);
	await git.addRemote(wiki, bare);
	let status = await git.status(wiki);
	assert.deepEqual(status.remotes, ["origin"]);
	assert.equal(status.upstream, null);
	assert.equal(status.remoteUrl, bare);

	await git.push(wiki);
	status = await git.status(wiki);
	assert.equal(status.upstream, "origin/main");
	assert.equal(status.ahead, 0);

	fs.writeFileSync(path.join(wiki, "tiddlers", "Local.tid"), "title: Local\n\n1");
	await git.commit(wiki);
	assert.equal((await git.status(wiki)).ahead, 1);
	await git.push(wiki);
	assert.equal((await git.status(wiki)).ahead, 0);

	// Someone else pushes: after a fetch the wiki is behind, and a pull brings the file
	const other = path.join(dir, "other");
	sh(dir, "clone", "--quiet", bare, other);
	fs.writeFileSync(path.join(other, "tiddlers", "Remote.tid"), "title: Remote\n\nfrom elsewhere");
	sh(other, "add", "-A");
	sh(other, "commit", "--quiet", "-m", "remote change");
	sh(other, "push", "--quiet");
	assert.equal((await git.status(wiki)).behind, 0);
	await git.fetch(wiki);
	assert.equal((await git.status(wiki)).behind, 1);
	await git.pull(wiki);
	assert.equal(fs.readFileSync(path.join(wiki, "tiddlers", "Remote.tid"), "utf8"), "title: Remote\n\nfrom elsewhere");
	assert.equal((await git.status(wiki)).behind, 0);

	// Diverged: push is rejected and pull refuses to merge
	fs.writeFileSync(path.join(other, "tiddlers", "Remote.tid"), "title: Remote\n\nchanged there");
	sh(other, "commit", "--quiet", "-am", "there");
	sh(other, "push", "--quiet");
	fs.writeFileSync(path.join(wiki, "tiddlers", "Local.tid"), "title: Local\n\nchanged here");
	await git.commit(wiki, "here");
	await assert.rejects(git.push(wiki), /Pull first/);
	await git.fetch(wiki);
	const diverged = await git.status(wiki);
	assert.deepEqual([diverged.ahead, diverged.behind], [1, 1]);
	await assert.rejects(git.pull(wiki), /diverged/);
});

test("conflicts and an unfinished merge are reported", { skip }, async () => {
	const wiki = folder("conflict");
	await git.init(wiki);
	sh(wiki, "checkout", "--quiet", "-b", "side");
	fs.writeFileSync(path.join(wiki, "tiddlers", "Note.tid"), "title: Note\n\nside");
	sh(wiki, "commit", "--quiet", "-am", "side");
	sh(wiki, "checkout", "--quiet", "main");
	fs.writeFileSync(path.join(wiki, "tiddlers", "Note.tid"), "title: Note\n\nmain");
	sh(wiki, "commit", "--quiet", "-am", "main");
	assert.throws(() => sh(wiki, "merge", "--quiet", "side"));
	const status = await git.status(wiki);
	assert.deepEqual(status.conflicts, ["tiddlers/Note.tid"]);
	assert.equal(status.merging, true);
	sh(wiki, "merge", "--abort");
	sh(wiki, "checkout", "--quiet", "--detach", "HEAD");
	const detached = await git.status(wiki);
	assert.equal(detached.detached, true);
	assert.equal(detached.branch, null);
});

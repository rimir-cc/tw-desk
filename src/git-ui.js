"use strict";

// Git status in the wiki list (chips), the Git tab of the bottom panel and the footer line.
// Uses $, api, state, run, button, folderName, render and logWikiId from renderer.js.

const gitDrafts = new Map(); // repository root -> commit message being typed
let gitBusy = false;

const GIT_INSTALL_HINT = new Proxy({ win32: "Git for Windows", darwin: "the Xcode command line tools (xcode-select --install) or git from Homebrew" }, { get: (hints, platform) => hints[platform] || "git" });

function gitStatusOf(folder) {
	return state.git && state.git.folders ? state.git.folders[pathKey(folder)] : undefined;
}

function gitAge(ms) {
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) {
		return Math.max(minutes, 1) + " min";
	}
	const hours = Math.round(minutes / 60);
	return hours < 48 ? hours + " h" : Math.round(hours / 24) + " d";
}

function gitBadState(status) {
	if (status.conflicts.length) {
		return { text: "merge conflict", hint: "Files with conflicts: " + status.conflicts.join(", ") };
	}
	if (status.merging) {
		return { text: "merge in progress", hint: "A merge or rebase was started and not finished." };
	}
	if (status.detached) {
		return { text: "detached HEAD", hint: "No branch is checked out." };
	}
	return null;
}

// { text, level ("" | "warn" | "bad"), title } for a folder's status, or null when git isn't available
// options.dataFolder: the data folder, where TW Desk commits on its own – unpushed commits only count once they are old
function gitSummary(status, options = {}) {
	if (!state.git || !state.git.available) {
		return null;
	}
	if (!status) {
		return { text: "⎇ …", level: "", title: "Not checked yet" };
	}
	if (status.error) {
		return { text: "⎇ ?", level: "", title: "Git check failed:\n" + status.error };
	}
	if (!status.repo) {
		return { text: "⎇ no repository", level: "warn", title: "This folder isn't under version control. Open the Git tab to create a repository." };
	}
	const bad = gitBadState(status);
	if (bad) {
		return { text: "⎇ " + bad.text, level: "bad", title: bad.hint + "\nResolve it with a git tool; TW Desk doesn't change the repository in this state." };
	}
	const parts = [];
	const titles = [];
	let level = "";
	if (status.changedCount) {
		const since = status.lastCommit ? Date.now() - status.lastCommit.time : Infinity;
		const stale = since > state.git.settings.staleHours * 3600000;
		parts.push(status.changedCount + " changed" + (stale && status.lastCommit ? " · " + gitAge(since) : ""));
		titles.push(status.changedCount + " changed (tiddler files); last commit " + (status.lastCommit ? gitAge(since) + " ago" : "never"));
		if (stale) {
			level = "warn";
		}
	}
	if (!status.remotes.length) {
		parts.push("no remote");
	} else if (!status.upstream) {
		parts.push("↑ not pushed");
		titles.push("This branch hasn't been pushed yet.");
		level = "warn";
	} else {
		if (status.ahead) {
			parts.push("↑" + status.ahead);
			if (options.dataFolder) {
				titles.push(status.ahead + " commit(s) to push – TW Desk never pushes on its own");
				if (status.unpushedSince && Date.now() - status.unpushedSince > state.git.settings.staleHours * 3600000) {
					level = "warn";
				}
			} else {
				titles.push(status.ahead + " commit(s) to push");
				level = "warn";
			}
		}
		if (status.behind) {
			parts.push("↓" + status.behind);
			titles.push(status.behind + " commit(s) to pull");
			level = "warn";
		}
	}
	let text = "⎇ " + status.branch + (parts.length ? " · " + parts.join(" · ") : " ✓");
	if (status.fetchError) {
		text += " ?";
		titles.push("Could not reach the remote:\n" + status.fetchError
			+ (/auth|credential|username|password|403|401/i.test(status.fetchError) ? "\nPush once from a terminal so Windows remembers your login." : ""));
	}
	return { text, level, title: titles.join("\n") || "Committed and in sync" };
}

function gitNeedsAttention(wiki) {
	const summary = gitSummary(gitStatusOf(wiki.path));
	return !!summary && summary.level !== "";
}

// Chip in the wiki row; opens the Git tab
function gitChip(wiki) {
	const summary = gitSummary(gitStatusOf(wiki.path));
	if (!summary) {
		return null;
	}
	return button(summary.text, () => showPanel(wiki.id, "git"), { className: "git-chip " + summary.level, title: summary.title + "\n(click for details)" });
}

// Dot on an include chip
function gitDot(folder) {
	const summary = gitSummary(gitStatusOf(folder));
	if (!summary) {
		return null;
	}
	const dot = document.createElement("span");
	dot.className = "git-dot " + summary.level;
	dot.title = "Git: " + summary.text.replace(/^⎇ /, "") + (summary.title ? "\n" + summary.title : "");
	return dot;
}

// ---------- footer ----------

function renderGitFooter() {
	const line = $("#git-line");
	const git = state.git;
	line.replaceChildren();
	if (!git || git.available === null) {
		line.append("Git: checking…");
		return;
	}
	if (!git.available) {
		line.append("Git not found – install " + GIT_INSTALL_HINT[state.platform] + " to see the version control status of your wikis.");
		return;
	}
	const interval = git.settings.interval;
	line.append("Git " + git.version + ": "
		+ (git.checking ? "checking…" : git.checkedAt ? "checked " + gitAge(Date.now() - git.checkedAt) + " ago" : "not checked yet")
		+ " · " + (interval > 0 ? "every " + (interval % 60 ? interval + " s" : interval / 60 + " min") : "automatic checks off"));
	line.append(button("Check now", () => api.git.checkNow(), { className: "ghost copy", title: "Check all repositories now (including fetching remotes)" }));
}

// ---------- Git tab ----------

function gitElement(tag, className, text) {
	const element = document.createElement(tag);
	if (className) {
		element.className = className;
	}
	if (text !== undefined) {
		element.textContent = text;
	}
	return element;
}

async function gitAct(action, folder, arg) {
	gitBusy = true;
	render();
	try {
		await api.git.action(action, folder, arg);
	} finally {
		gitBusy = false;
		render();
	}
}

// Running wikis that use a folder inside this repository
function gitRunningUsers(root) {
	const inRepo = folder => {
		const status = gitStatusOf(folder);
		return status && status.root === root;
	};
	return state.wikis.filter(w => ["running", "starting"].includes(w.status) && (inRepo(w.path) || w.includes.some(i => inRepo(i.resolved))));
}

function renderGitView(wiki) {
	const view = $("#git-view");
	// Keep typing in the commit field when the view is rebuilt by a background update
	const active = document.activeElement;
	const focused = active && active.dataset && active.dataset.gitRoot ? { root: active.dataset.gitRoot, start: active.selectionStart, end: active.selectionEnd } : null;
	view.replaceChildren();
	if (!state.git || state.git.available === null) {
		view.append(gitElement("p", "muted", "Checking for git…"));
		return;
	}
	if (!state.git.available) {
		view.append(gitElement("p", "muted", "Git isn't installed or not on the PATH. Install " + GIT_INSTALL_HINT[state.platform] + " and restart TW Desk."));
		return;
	}
	// Without a wiki: the data folder
	const folders = !wiki ? [{ path: state.dataFolder.path, label: "TW Desk data", dataFolder: true }] : [{ path: wiki.path, label: wiki.name }].concat(wiki.includes.filter(i => i.exists).map(i => ({
		path: i.resolved,
		label: folderName(i.resolved) + " (included" + (i.readOnly ? ", read-only" : "") + ")"
	})));
	const roots = new Set();
	for (const folder of folders) {
		const status = gitStatusOf(folder.path);
		if (status && status.root) {
			if (roots.has(status.root)) {
				continue;
			}
			roots.add(status.root);
		}
		view.append(gitRepoSection(folder, status));
	}
	if (focused) {
		const input = [...view.querySelectorAll("input")].find(i => i.dataset.gitRoot === focused.root);
		if (input) {
			input.focus();
			input.setSelectionRange(focused.start, focused.end);
		}
	}
}

function gitRepoSection(folder, status) {
	const section = gitElement("div", "git-repo");
	const title = gitElement("div", "git-repo-title");
	title.append(gitElement("strong", "", folder.label));
	section.append(title);
	const actions = gitElement("div", "git-actions");
	const action = (label, name, arg, options = {}) => button(label, () => gitAct(name, folder.path, typeof arg === "function" ? arg() : arg),
		Object.assign({}, options, { disabled: gitBusy || options.disabled }));
	const open = action("Open folder", "open", null, { className: "ghost" });

	if (!status || status.error) {
		section.append(gitElement("div", status ? "error small" : "muted small", status ? status.error : "Not checked yet."));
		actions.append(button("Check now", () => api.git.checkNow(), { disabled: gitBusy }), open);
		section.append(actions);
		return section;
	}
	if (!status.repo) {
		title.append(gitElement("span", "muted small", folder.path));
		section.append(gitElement("div", "small", "This folder isn't under version control."));
		actions.append(button("Initialize repository", async () => {
			if (confirm("Create a git repository in\n" + folder.path + "?\n\n" + (folder.dataFolder ? "Adds a .gitignore (*.tmp) and commits the current files; the repository is the data folder's own, even inside another one." : "Adds a .gitignore (output/, $__StoryList.tid, $__temp*) and commits the current files."))) {
				await gitAct("init", folder.path);
			}
		}, { className: "primary", disabled: gitBusy }), open);
		section.append(actions);
		return section;
	}

	title.append(gitElement("span", "muted small", status.root + " · " + (status.branch ? "branch " + status.branch : "detached HEAD")
		+ " · " + (status.remoteUrl || "no remote")));
	section.append(gitElement("div", "small", status.lastCommit
		? "Last commit " + gitAge(Date.now() - status.lastCommit.time) + " ago: " + status.lastCommit.subject
		: "No commits yet."));

	const bad = gitBadState(status);
	if (bad) {
		section.append(gitElement("div", "error small", bad.text + ": " + bad.hint
			+ " Resolve it with a git tool (e.g. Git GUI, VS Code); TW Desk doesn't commit, push or pull in this state."));
		actions.append(button("Check again", () => api.git.checkNow(), { disabled: gitBusy }), open);
		section.append(actions);
		return section;
	}

	if (status.changed.length) {
		const shown = status.changed.slice(0, 8).map(f => f.replace(/^tiddlers\//, ""));
		const line = gitElement("div", "small git-files", status.changedCount + " changed: " + shown.join(", ") + (status.changed.length > 8 ? ", … (+" + (status.changed.length - 8) + " files)" : ""));
		line.title = status.changed.join("\n");
		section.append(line);
		const message = document.createElement("input");
		message.dataset.gitRoot = status.root;
		message.value = gitDrafts.has(status.root) ? gitDrafts.get(status.root) : status.suggestedMessage;
		message.addEventListener("input", () => gitDrafts.set(status.root, message.value));
		const commit = button("Commit", async () => {
			await gitAct("commit", folder.path, message.value);
			gitDrafts.delete(status.root);
		}, { className: "primary", disabled: gitBusy, title: "Commit all changes in this repository" });
		message.addEventListener("keydown", event => {
			if (event.key === "Enter") {
				commit.click();
			}
		});
		const row = gitElement("div", "add-row");
		row.append(message, commit);
		section.append(row);
	} else {
		section.append(gitElement("div", "small muted", "No uncommitted changes."));
	}

	if (status.remotes.length) {
		let remote;
		if (!status.upstream) {
			remote = "This branch hasn't been pushed yet.";
		} else {
			remote = (status.ahead ? status.ahead + " commit(s) to push" : "nothing to push") + ", " + (status.behind ? status.behind + " commit(s) to pull" : "nothing to pull");
		}
		remote += status.fetchedAt ? " · fetched " + gitAge(Date.now() - status.fetchedAt) + " ago" : "";
		section.append(gitElement("div", "small", remote));
		if (status.fetchError) {
			section.append(gitElement("div", "error small", "Could not reach the remote: " + status.fetchError));
		}
		// Pulling the data folder stops the running wikis itself
		const running = folder.dataFolder ? [] : gitRunningUsers(status.root);
		actions.append(
			action("Push", "push", null, { disabled: !!status.upstream && !status.ahead, title: "Push commits to " + (status.upstream || "the remote") }),
			action("Pull", "pull", null, {
				disabled: !status.upstream || running.length > 0,
				title: running.length ? "Stop " + running.map(w => w.name).join(", ") + " first – a running wiki would overwrite the pulled files" : "Fast-forward to the remote branch"
			}),
			action("Fetch now", "fetch", null, { className: "ghost" }));
	} else {
		section.append(gitElement("div", "small muted", "No remote: commits stay on this computer."));
		const url = document.createElement("input");
		url.placeholder = "Remote URL, e.g. https://github.com/you/" + folderName(folder.path) + ".git";
		const row = gitElement("div", "add-row");
		row.append(url, action("Add remote", "add-remote", () => url.value));
		section.append(row);
	}
	actions.append(open);
	section.append(actions);
	return section;
}

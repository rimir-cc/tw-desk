"use strict";

// Library search: query parsing, grouping by title and ranking. Loaded as a plain script by the Plugins window
// and required by the unit tests (no DOM, no state).

const ENTRY_FIELDS = ["title", "name", "author", "tags", "description", "version"];
const FIELD_ALIASES = { tag: "tags" };

// Version comparison for the UI (main process has the same logic)
function compareVersionsLoose(a, b) {
	const parse = v => String(v || "0").replace(/^[^\d]*/, "").split(/[-+]/)[0].split(".").map(n => parseInt(n, 10) || 0);
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d) {
			return d < 0 ? -1 : 1;
		}
	}
	return 0;
}

// Words must all match somewhere; "a phrase" is one word; -word excludes; field:value looks in one field only
// (title, name, author, tag, description, version or any other index field, e.g. core-version:5.3)
function parseQuery(text) {
	const terms = [];
	const pattern = /(-)?(?:([\w-]+):)?(?:"([^"]*)"?|(\S+))/g;
	let match;
	while ((match = pattern.exec(text))) {
		const value = (match[3] !== undefined ? match[3] : match[4] || "").toLowerCase();
		// A lone "-" is an exclusion still being typed
		if (value && value !== "-") {
			const field = match[2] ? match[2].toLowerCase() : null;
			terms.push({ exclude: !!match[1], field: field ? FIELD_ALIASES[field] || field : null, value });
		}
	}
	return terms;
}

function entryText(entry, field) {
	if (!field) {
		if (entry.searchText === undefined) {
			entry.searchText = [entry.title, entry.description, entry.author, entry.tags].concat(Object.values(entry.fields || {})).join("\n").toLowerCase();
		}
		return entry.searchText;
	}
	return String((ENTRY_FIELDS.includes(field) ? entry[field] : (entry.fields || {})[field]) || "").toLowerCase();
}

// One group per plugin title, with what each library offers (newest first); filter: { library, kind }
function groupOffers(indexes, filter = {}) {
	const groups = new Map();
	for (const index of indexes || []) {
		if (!index.entries || (filter.library && index.url !== filter.library)) {
			continue;
		}
		for (const entry of index.entries) {
			if (filter.kind && entry.kind !== filter.kind) {
				continue;
			}
			if (!groups.has(entry.title)) {
				groups.set(entry.title, { title: entry.title, kind: entry.kind, name: entry.name, offers: [] });
			}
			groups.get(entry.title).offers.push({ library: index.url, entry });
		}
	}
	for (const group of groups.values()) {
		group.offers.sort((a, b) => compareVersionsLoose(b.entry.version, a.entry.version));
		group.entry = group.offers[0].entry;
	}
	return [...groups.values()];
}

// -1 if the group doesn't match; higher is better (name > title > description > author/tags > other fields)
function scoreGroup(group, terms) {
	let score = 0;
	for (const term of terms) {
		const hit = group.offers.some(o => entryText(o.entry, term.field).includes(term.value));
		if (term.exclude ? hit : !hit) {
			return -1;
		}
		if (!term.exclude) {
			const e = group.entry;
			score += e.name.toLowerCase() === term.value ? 20
				: e.title.toLowerCase().includes(term.value) ? 10
				: e.description.toLowerCase().includes(term.value) ? 3
				: (e.author + " " + e.tags).toLowerCase().includes(term.value) ? 2 : 1;
		}
	}
	return score;
}

if (typeof module === "object") {
	module.exports = { compareVersionsLoose, parseQuery, entryText, groupOffers, scoreGroup };
}

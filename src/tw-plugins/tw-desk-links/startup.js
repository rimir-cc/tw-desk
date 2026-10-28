/*\
title: $:/plugins/tw-desk/links/startup.js
type: application/javascript
module-type: startup

Marks the wiki as running in a TW Desk window (its user agent ends with "TWDesk/<version>"), so the copy button shows

\*/
"use strict";

exports.name = "tw-desk-links";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
	if(/\bTWDesk\//.test(navigator.userAgent)) {
		$tw.wiki.addTiddler({ title: "$:/temp/tw-desk/window", text: "yes" });
	}
};

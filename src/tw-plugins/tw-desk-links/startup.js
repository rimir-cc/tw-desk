/*\
title: $:/plugins/tw-desk/links/startup.js
type: application/javascript
module-type: startup

In a TW Desk wiki window (user agent ends with "TWDeskWindow/<version>"): shows the copy button; TW Desk itself handles the links.
In a browser: twdesk:// links are handed over from the page itself instead of a new tab (TiddlyWiki opens external
links in a new tab, which would stay behind empty once the browser passed the address on to TW Desk)

\*/
"use strict";

exports.name = "tw-desk-links";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
	if(/\bTWDeskWindow\//.test(navigator.userAgent)) {
		$tw.wiki.addTiddler({ title: "$:/temp/tw-desk/window", text: "yes" });
		return;
	}
	document.addEventListener("click", function(event) {
		var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
		if(link && /^twdesk:/i.test(link.getAttribute("href")) && event.button === 0) {
			event.preventDefault();
			event.stopPropagation();
			window.location.href = link.href;
		}
	}, true);
};

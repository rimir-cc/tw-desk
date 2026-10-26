"use strict";

// Popup menu for the "⋯" buttons, right-clicks and "+ New".
// items: [{ label, action, disabled, title } | "-"]; at: an element (the menu opens below it) or { x, y }

let openMenu = null;
let lastClosed = { anchor: null, time: 0 };

function closeMenu() {
	if (openMenu) {
		lastClosed = { anchor: openMenu.anchor, time: Date.now() };
		openMenu.remove();
		openMenu = null;
	}
}

function showMenu(items, at) {
	const anchor = at instanceof Element ? at : null;
	// A click on the button whose menu was just closed by that same click only closes it
	if (anchor && lastClosed.anchor === anchor && Date.now() - lastClosed.time < 300) {
		return;
	}
	closeMenu();
	const menu = document.createElement("div");
	menu.className = "menu";
	menu.setAttribute("role", "menu");
	menu.anchor = anchor;
	for (const item of items) {
		if (item === "-") {
			const separator = document.createElement("div");
			separator.className = "menu-separator";
			menu.append(separator);
			continue;
		}
		const entry = document.createElement("button");
		entry.type = "button";
		entry.setAttribute("role", "menuitem");
		entry.textContent = item.label;
		entry.disabled = !!item.disabled;
		if (item.title) {
			entry.title = item.title;
		}
		entry.addEventListener("click", event => {
			event.stopPropagation();
			closeMenu();
			item.action();
		});
		menu.append(entry);
	}
	menu.addEventListener("keydown", event => {
		const entries = [...menu.querySelectorAll("button:not(:disabled)")];
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const index = entries.indexOf(document.activeElement);
			entries[(index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length].focus();
		} else if (event.key === "Escape" || event.key === "Tab") {
			event.preventDefault();
			closeMenu();
			if (anchor) {
				anchor.focus();
			}
		}
	});
	document.body.append(menu);
	// Below the anchor (right-aligned) or at the pointer, kept inside the window
	const rect = anchor ? anchor.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
	const width = menu.offsetWidth;
	const height = menu.offsetHeight;
	let left = anchor ? rect.right - width : rect.left;
	let top = rect.bottom + 2;
	if (top + height > window.innerHeight - 4) {
		top = Math.max(4, rect.top - height - 2);
	}
	left = Math.min(Math.max(4, left), window.innerWidth - width - 4);
	menu.style.left = left + "px";
	menu.style.top = top + "px";
	openMenu = menu;
	const first = menu.querySelector("button:not(:disabled)");
	if (first) {
		first.focus();
	}
}

document.addEventListener("mousedown", event => {
	if (openMenu && !openMenu.contains(event.target)) {
		closeMenu();
	}
}, true);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
document.addEventListener("scroll", closeMenu, true);

// Drives a running TW Desk (started with --remote-debugging-port) through the DevTools protocol.
//
// Usage:
//   node scripts/cdp.mjs <port> <url-substring> "<js expression>"
//   node scripts/cdp.mjs <port> <url-substring> "screenshot:<file.png>"
//
// <url-substring> picks the page: "index.html" is the manager window, "127.0.0.1:<port>" a wiki window.
// The expression may return a promise; the result is printed as JSON.
// Example:
//   node scripts/cdp.mjs 9350 index.html "window.twDesk.getState().then(s => s.wikis.map(w => w.name + ': ' + w.status))"

import { writeFileSync } from "fs";

const [port, match, command] = process.argv.slice(2);
if (!port || !match || !command) {
	console.error("Usage: node scripts/cdp.mjs <port> <url-substring> <js expression | screenshot:file.png>");
	process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find(t => t.type === "page" && t.url.includes(match));
if (!target) {
	console.error("No page matching", match, "- pages:", targets.map(t => t.url));
	process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener("open", resolve));
let nextId = 0;
const send = (method, params = {}) => new Promise(resolve => {
	const id = ++nextId;
	ws.addEventListener("message", function onMessage(event) {
		const message = JSON.parse(event.data);
		if (message.id === id) {
			ws.removeEventListener("message", onMessage);
			resolve(message);
		}
	});
	ws.send(JSON.stringify({ id, method, params }));
});

if (command.startsWith("screenshot:")) {
	const response = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(command.slice("screenshot:".length), Buffer.from(response.result.data, "base64"));
	console.log("saved");
} else {
	const response = await send("Runtime.evaluate", { expression: command, awaitPromise: true, returnByValue: true });
	const result = response.result;
	if (result.exceptionDetails) {
		console.error(JSON.stringify(result.exceptionDetails, null, 1));
		process.exitCode = 1;
	} else {
		console.log(JSON.stringify(result.result.value, null, 1));
	}
}
ws.close();

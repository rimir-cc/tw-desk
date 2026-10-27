"use strict";

// For unit tests under plain Node: require("electron") gives this stub instead of the Electron binary's path.
// net.fetch is Node's fetch, so plugins.js can read the test server's libraries.

const Module = require("module");

const STUB = __filename;
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	return request === "electron" ? STUB : resolve.call(this, request, ...rest);
};

module.exports = {
	net: { fetch: (url, options) => fetch(url, options) }
};

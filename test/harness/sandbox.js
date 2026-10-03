const fs = require("node:fs");
const path = require("node:path");

const INDEX_PATH = path.join(__dirname, "..", "..", "index.js");

// This plugin runs on the WORKER runtime ("runtime": "worker"), whose scope has
// the modern built-ins (Map, URL, TextEncoder…) but deletes the network and
// worker globals before the plugin runs (src/pluginWorker/runtime.ts in the
// app). Shadowing those as throwing bindings makes an accidental use fail here
// instead of working in Node and breaking in the app.
const FORBIDDEN = [
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts",
  "Worker", "SharedWorker", "BroadcastChannel", "indexedDB", "caches",
  "require", "process", "module", "exports", "__dirname", "__filename", "global",
];

function loadPlugin() {
  const code = fs.readFileSync(INDEX_PATH, "utf8");
  const preamble = FORBIDDEN.map(
    (n) =>
      `var ${n} = new Proxy(function(){}, { get: function(){ throw new Error("forbidden global accessed: ${n}"); }, apply: function(){ throw new Error("forbidden global called: ${n}"); }, construct: function(){ throw new Error("forbidden global constructed: ${n}"); } });`
  ).join("\n");
  const factory = new Function("api", "window", "globalThis", "self", "document", preamble + "\n" + code);
  const scope = Object.freeze({});
  return factory(undefined, scope, scope, scope, undefined);
}

module.exports = { loadPlugin };

// Runs the site's WebAssembly engine under Node, through the same worker code the page uses.
// Reads a JSON list of {op, args} on stdin and prints a JSON list of results.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const docs = path.join(__dirname, "..", "docs", "js");
const page = { window: {} };
vm.createContext(page);
vm.runInContext(fs.readFileSync(path.join(docs, "engine.wasm.js"), "utf8"), page);
const engineSource = fs.readFileSync(path.join(docs, "engine.js"), "utf8");
const workerSource = engineSource.slice(engineSource.indexOf("function workerMain"), engineSource.indexOf("\nconst Engine"));

// The worker's globals: it answers on postMessage and listens on onmessage.
const replies = [];
const worker = { performance, WebAssembly, Map, Math, JSON, Number, Float64Array, DataView, Error, String, postMessage: (m) => replies.push(m) };
vm.createContext(worker);
vm.runInContext(`${workerSource}; workerMain();`, worker);

const bytes = Buffer.from(page.window.VROPT_WASM, "base64");
const compiled = new WebAssembly.Module(bytes);
const ask = (op, args, extra = {}) => {
  replies.length = 0;
  worker.onmessage({ data: { id: 1, op, args, ...extra } });
  const last = replies[replies.length - 1];
  if (last.error) throw new Error(last.error);
  return last.result;
};
ask("init", null, { module: compiled });

const jobs = JSON.parse(fs.readFileSync(0, "utf8"));
const out = jobs.map(({ op, args }) => {
  const r = ask(op, args);
  return ArrayBuffer.isView(r) ? Array.from(r) : r && typeof r === "object" ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, ArrayBuffer.isView(v) ? Array.from(v) : v])) : r;
});
process.stdout.write(JSON.stringify(out));

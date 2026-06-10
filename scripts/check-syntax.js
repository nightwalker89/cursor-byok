"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const checked = [];

for (const dir of ["src", "scripts", "tests"]) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    if (/\.(js|mjs|cjs)$/.test(file)) checked.push(file);
  }
}

for (const file of checked) {
  childProcess.execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`syntax ok (${checked.length} files)`);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(file);
    } else {
      yield file;
    }
  }
}

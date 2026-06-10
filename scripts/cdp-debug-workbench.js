#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

async function main() {
  const port = Number(process.env.CDP_PORT || 9333);
  const errorLine = Number(process.env.CDP_ERROR_LINE || 40345);
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const targets = await (await fetch(listUrl)).json();
  const target = targets.find((entry) => (entry.url || "").includes("workbench.html"));
  if (!target?.webSocketDebuggerUrl) throw new Error("no workbench CDP target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });

  const scripts = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Debugger.scriptParsed") scripts.push(msg.params || {});
  });

  const exceptions = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") {
      const details = msg.params?.exceptionDetails || {};
      exceptions.push({
        line: details.lineNumber,
        column: details.columnNumber,
        text: details.text,
        description: (details.exception?.description || "").slice(0, 200),
      });
    }
  });

  await send("Runtime.enable");
  await send("Debugger.enable", { maxScriptsCacheSize: 100000000 });
  await send("Page.enable").catch(() => {});
  await send("Page.reload", { ignoreCache: true }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 12000));

  const workbench = scripts.find((script) => (script.url || "").includes("workbench.desktop.main.js"));
  if (!workbench?.scriptId) {
    console.log(JSON.stringify({
      ok: false,
      error: "workbench script not found",
      scriptCount: scripts.length,
      exceptions,
      scripts: scripts.map((script) => ({ url: script.url, scriptId: script.scriptId })).filter((script) => script.url),
    }, null, 2));
    ws.close();
    return;
  }

  const source = await send("Debugger.getScriptSource", { scriptId: workbench.scriptId });
  const lines = String(source.scriptSource || "").split("\n");
  const start = Math.max(1, errorLine - 3);
  const end = Math.min(lines.length, errorLine + 3);
  const context = {};
  for (let line = start; line <= end; line += 1) {
    context[line] = lines[line - 1]?.slice(0, 240) || "";
  }

  const disk = fs.readFileSync("/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js", "utf8");
  const diskLines = disk.split("\n");
  const diskContext = {};
  for (let line = start; line <= end; line += 1) {
    diskContext[line] = diskLines[line - 1]?.slice(0, 240) || "";
  }

  console.log(JSON.stringify({
    ok: true,
    script: {
      scriptId: workbench.scriptId,
      url: workbench.url,
      lineCount: lines.length,
      hash: workbench.hash || null,
    },
    disk: {
      lineCount: diskLines.length,
      size: disk.length,
      hasHook: disk.includes("CURSOR-BYOK-HOOK-V2-START"),
    },
    sameLineCount: lines.length === diskLines.length,
    sameAtErrorLine: lines[errorLine - 1] === diskLines[errorLine - 1],
    runtimeContext: context,
    diskContext,
  }, null, 2));

  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
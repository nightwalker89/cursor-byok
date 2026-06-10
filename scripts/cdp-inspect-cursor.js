#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

async function main() {
  const port = Number(process.env.CDP_PORT || 9333);
  const timeoutMs = Number(process.env.CDP_TIMEOUT_MS || 12000);
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const res = await fetch(listUrl);
  if (!res.ok) throw new Error(`CDP list failed: ${res.status}`);
  const targets = await res.json();
  const target = targets.find((entry) => (entry.url || "").includes("workbench.html"));
  if (!target?.webSocketDebuggerUrl) {
    console.log(JSON.stringify({ ok: false, error: "no workbench target", targets: targets.length }, null, 2));
    process.exit(1);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];

  const done = (payload) => {
    console.log(JSON.stringify(payload, null, 2));
    ws.close();
    process.exit(payload.ok ? 0 : 2);
  };

  const timer = setTimeout(() => {
    done({
      ok: exceptions.length === 0,
      target: { title: target.title, url: target.url },
      exceptions,
      consoleErrors: consoleErrors.slice(-10),
      timedOut: true,
    });
  }, timeoutMs);

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const details = msg.params?.exceptionDetails || {};
      exceptions.push({
        text: details.text || "",
        line: details.lineNumber,
        column: details.columnNumber,
        url: details.url || "",
        description: (details.exception?.description || "").slice(0, 300),
      });
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      const text = (msg.params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
      consoleErrors.push(text.slice(0, 400));
    }
  });

  ws.addEventListener("open", async () => {
    try {
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
      await send("Runtime.enable");
      await send("Console.enable");
      const snapshot = await send("Runtime.evaluate", {
        expression: `({
          ready: document.readyState,
          byokReady: !!globalThis.__cursorByokReady,
          wrapTransport: typeof globalThis.__cursorByokWrapTransport,
          wrapAgentClient: typeof globalThis.__cursorByokWrapAgentClient,
          submitGuard: typeof globalThis.__cursorByokHasSubmitModelCandidate,
          runGuard: typeof globalThis.__cursorByokHasRunOptionsModelCandidate,
          debugTail: Array.isArray(globalThis.__cursorByokDebug) ? globalThis.__cursorByokDebug.slice(-12) : [],
          bodyLen: document.body ? document.body.innerText.length : -1
        })`,
        returnByValue: true,
      });
      clearTimeout(timer);
      done({
        ok: exceptions.length === 0,
        target: { title: target.title, url: target.url },
        snapshot: snapshot?.result?.value || null,
        exceptions,
        consoleErrors: consoleErrors.filter((line) => /SyntaxError|Unexpected token|uncaught exception/i.test(line)).slice(-10),
      });
    } catch (error) {
      clearTimeout(timer);
      done({ ok: false, error: String(error), exceptions, consoleErrors: consoleErrors.slice(-10) });
    }
  });

  ws.addEventListener("error", (error) => {
    clearTimeout(timer);
    done({ ok: false, error: String(error) });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

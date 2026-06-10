"use strict";

const TRANSPORT_WRAP_CALL =
  'typeof globalThis.__cursorByokWrapTransport==="function"?globalThis.__cursorByokWrapTransport(';
const AGENT_CLIENT_WRAP_CALL =
  'typeof globalThis.__cursorByokWrapAgentClient==="function"?globalThis.__cursorByokWrapAgentClient(';
const HOOK_POINT_MARK_CALL =
  'typeof globalThis.__cursorByokMarkHookPoint==="function"&&globalThis.__cursorByokMarkHookPoint(';

function isIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z_$][\w$]*$/.test(value);
}

function lastMatch(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  let match = null;
  for (;;) {
    const next = regex.exec(text);
    if (!next) return match;
    match = next;
  }
}

module.exports = {
  AGENT_CLIENT_WRAP_CALL,
  HOOK_POINT_MARK_CALL,
  TRANSPORT_WRAP_CALL,
  isIdentifier,
  lastMatch,
};

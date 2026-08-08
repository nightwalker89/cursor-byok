"use strict";

const { AGENT_CLIENT_WRAP_CALL, HOOK_POINT_MARK_CALL, isIdentifier, lastMatch } = require("./shared");
const { latestKnownCursorMatch } = require("../cursor-version");

const CONTEXT_RPC_AGENT_CLIENT_PATTERN =
  /this\.client=new ([A-Za-z_$][\w$]*)\(\{async\*run\(([^)]*)\)\{const ([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\.get\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\3,\{injectTraceHeaders:!0\}\),([A-Za-z_$][\w$]*)=/g;

const CONTEXT_RPC_AGENT_CLIENT_MATCHES = [
  {
    cursorVersion: "0.0.0",
    serviceVarPattern: /createInstance\([A-Za-z_$][\w$]*,\{service:([A-Za-z_$][\w$]*),headerInjector:async\(\)=>\{/g,
  },
  {
    // Cursor 3.15.6 changed `headerInjector` from `async()=>` to a named
    // single-argument arrow. Keep this as the current match for all later
    // versions until a newer Cursor build requires another definition.
    cursorVersion: "3.15.6",
    serviceVarPattern: /createInstance\([A-Za-z_$][\w$]*,\{service:([A-Za-z_$][\w$]*),headerInjector:async\s*[A-Za-z_$][\w$]*\s*=>\{/g,
  },
];

function contextRpcMatchForCursorVersion(cursorVersion) {
  return latestKnownCursorMatch(CONTEXT_RPC_AGENT_CLIENT_MATCHES, cursorVersion);
}

function findContextRpcAgentServiceVar(content, offset, cursorVersion) {
  const versionMatch = contextRpcMatchForCursorVersion(cursorVersion);
  if (!versionMatch) return "";
  const start = Math.max(0, offset - 32768);
  const prefix = content.slice(start, offset);
  const match = lastMatch(prefix, versionMatch.serviceVarPattern);
  return match && isIdentifier(match[1]) ? match[1] : "";
}

function patchContextRpcAgentClient(content, { cursorVersion } = {}) {
  return content.replace(CONTEXT_RPC_AGENT_CLIENT_PATTERN, (
    match,
    clientCtor,
    runParams,
    backendVar,
    backendClientVar,
    contextVar,
    clientVar,
    connectWrapFn,
    nextVar,
    offset,
    source,
  ) => {
    if (match.includes(AGENT_CLIENT_WRAP_CALL)) return match;
    const serviceVar = findContextRpcAgentServiceVar(source, offset, cursorVersion);
    if (!isIdentifier(serviceVar)) return match;
    return `this.client=new ${clientCtor}({async*run(${runParams}){const ${backendVar}=await ${backendClientVar}.get(${contextVar}),${clientVar}=(${HOOK_POINT_MARK_CALL}"context-rpc-agent-client",{serviceType:${serviceVar}&&${serviceVar}.typeName}),${AGENT_CLIENT_WRAP_CALL}${connectWrapFn}(${backendVar},{injectTraceHeaders:!0}),${serviceVar}):${connectWrapFn}(${backendVar},{injectTraceHeaders:!0})),${nextVar}=`;
  });
}

module.exports = {
  CONTEXT_RPC_AGENT_CLIENT_MATCHES,
  contextRpcMatchForCursorVersion,
  patchContextRpcAgentClient,
  findContextRpcAgentServiceVar,
  patch: {
    name: "context-rpc-agent-client",
    targets: ["workbench", "extHost"],
    severity: "transport",
    isActive: (content) => content.includes(`${HOOK_POINT_MARK_CALL}"context-rpc-agent-client"`),
    matchVersion: ({ cursorVersion } = {}) => contextRpcMatchForCursorVersion(cursorVersion)?.cursorVersion || null,
    apply: patchContextRpcAgentClient,
  },
};

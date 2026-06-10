"use strict";

const { AGENT_CLIENT_WRAP_CALL, HOOK_POINT_MARK_CALL, isIdentifier, lastMatch } = require("./shared");

const CONTEXT_RPC_AGENT_CLIENT_PATTERN =
  /this\.client=new ([A-Za-z_$][\w$]*)\(\{async\*run\(([^)]*)\)\{const ([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\.get\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\3,\{injectTraceHeaders:!0\}\),([A-Za-z_$][\w$]*)=/g;

function findContextRpcAgentServiceVar(content, offset) {
  const start = Math.max(0, offset - 32768);
  const prefix = content.slice(start, offset);
  const match = lastMatch(prefix, /createInstance\([A-Za-z_$][\w$]*,\{service:([A-Za-z_$][\w$]*),headerInjector:async\(\)=>\{/g);
  return match && isIdentifier(match[1]) ? match[1] : "";
}

function patchContextRpcAgentClient(content) {
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
    const serviceVar = findContextRpcAgentServiceVar(source, offset);
    if (!isIdentifier(serviceVar)) return match;
    return `this.client=new ${clientCtor}({async*run(${runParams}){const ${backendVar}=await ${backendClientVar}.get(${contextVar}),${clientVar}=(${HOOK_POINT_MARK_CALL}"context-rpc-agent-client",{serviceType:${serviceVar}&&${serviceVar}.typeName}),${AGENT_CLIENT_WRAP_CALL}${connectWrapFn}(${backendVar},{injectTraceHeaders:!0}),${serviceVar}):${connectWrapFn}(${backendVar},{injectTraceHeaders:!0})),${nextVar}=`;
  });
}

module.exports = {
  patchContextRpcAgentClient,
  findContextRpcAgentServiceVar,
  patch: {
    name: "context-rpc-agent-client",
    targets: ["workbench", "extHost"],
    severity: "transport",
    isActive: (content) => content.includes(`${HOOK_POINT_MARK_CALL}"context-rpc-agent-client"`),
    apply: patchContextRpcAgentClient,
  },
};

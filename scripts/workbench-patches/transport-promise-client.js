"use strict";

const { HOOK_POINT_MARK_CALL, TRANSPORT_WRAP_CALL } = require("./shared");

const PROMISE_CLIENT_FACTORY_PATTERN =
  /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{return ([A-Za-z_$][\w$]*)\(\2,([A-Za-z_$][\w$]*)=>\{switch\(\5\.kind\)\{case ([A-Za-z_$][\w$]*)\.Unary:return ([A-Za-z_$][\w$]*)\(\3,\2,\5\);case \6\.ServerStreaming:return ([A-Za-z_$][\w$]*)\(\3,\2,\5\);case \6\.ClientStreaming:return ([A-Za-z_$][\w$]*)\(\3,\2,\5\);case \6\.BiDiStreaming:return ([A-Za-z_$][\w$]*)\(\3,\2,\5\);default:return null\}\}\)\}/;

function patchPromiseClientFactory(content) {
  return content.replace(PROMISE_CLIENT_FACTORY_PATTERN, (
    match,
    fn,
    service,
    transport,
    createClient,
    method,
    methodKind,
    unary,
    serverStreaming,
    clientStreaming,
    bidiStreaming,
  ) => {
    if (match.includes(TRANSPORT_WRAP_CALL)) return match;
    return `function ${fn}(${service},${transport}){${HOOK_POINT_MARK_CALL}"connect-promise-client",{serviceType:${service}&&${service}.typeName});${transport}=${TRANSPORT_WRAP_CALL}${transport},${service}.typeName):${transport};return ${createClient}(${service},${method}=>{switch(${method}.kind){case ${methodKind}.Unary:return ${unary}(${transport},${service},${method});case ${methodKind}.ServerStreaming:return ${serverStreaming}(${transport},${service},${method});case ${methodKind}.ClientStreaming:return ${clientStreaming}(${transport},${service},${method});case ${methodKind}.BiDiStreaming:return ${bidiStreaming}(${transport},${service},${method});default:return null}})}`;
  });
}

module.exports = {
  patchPromiseClientFactory,
  patch: {
    name: "connect-promise-client",
    targets: ["workbench", "extHost"],
    severity: "transport",
    isActive: (content) => content.includes(`${HOOK_POINT_MARK_CALL}"connect-promise-client"`),
    apply: patchPromiseClientFactory,
  },
};

"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildWorkbenchHook,
  createHookRuntimeHelpersForTest,
  hookRuntime,
} = require("../src/workbench-hook");
const { CATALOG_FILE, DEFAULT_REDIRECTS, LEGACY_DEFAULT_REDIRECTS } = require("../src/constants");
const {
  analyzeWorkbenchHookInstall,
  LEGACY_END,
  LEGACY_START,
  installWorkbenchHook,
  patchAgentProviderRouterGuard,
  patchContextRpcAgentClient,
  patchFirstTokenWarningThresholds,
  patchLocalAgentRunForByok,
  patchStallDetectorCleanup,
  patchWorkbenchContent,
  patchWorkbenchContentWithStatus,
  PREVIOUS_END,
  PREVIOUS_START,
  detectActiveTransportHookPoints,
  patchPromiseClientFactory,
  patchIntegrityWarning,
  patchTransportFactoryWithStatus,
  restoreWorkbenchHook,
  stripMarkedBlock,
} = require("../scripts/install-workbench-hook");
const { applyPatchPlan, missingCriticalPatches } = require("../scripts/workbench-patch-engine");
const { isLocalAgentRunPatchUnnecessary } = require("../scripts/workbench-patches/local-agent-run");
const {
  configDir,
  ensureConfigFiles,
  hookStatePath,
  loadRoutes,
  providersPath,
  routesPath,
  writeRoutes,
  writeJsonFile,
  logPath,
  workbenchBackupDir,
} = require("../src/config");
const {
  byokModelIds,
  findProviderModel,
  mergeAvailableModels,
  pickModelId,
} = require("../src/runtime/models");
const { allTextFiles, useHome } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");

// Minified seam fixtures captured from modern Cursor build shapes live in
// tests/fixtures/workbench-seams/ — add a file per new Cursor build instead of
// editing test code. The V2 transport variant uses different minified
// identifiers to stand in for a different Cursor build, and the full-workbench
// fixture also carries the critical router-guard and local-agent seams
// (class-wrapped so it stays parseable JS — real installs syntax-check the
// patched output), so strict (non-allowPartial) installs succeed against it.
const SEAM_FIXTURES_DIR = path.join(__dirname, "fixtures", "workbench-seams");
const seamFixture = (name) => fs.readFileSync(path.join(SEAM_FIXTURES_DIR, name), "utf8").trim();
const MODERN_TRANSPORT_SOURCE = seamFixture("modern-promise-client.txt");
const MODERN_TRANSPORT_SOURCE_V2 = seamFixture("modern-promise-client-v2.txt");
const MODERN_FULL_WORKBENCH_SOURCE = seamFixture("modern-full-workbench.txt");

test("plugin tree has no legacy package identifiers", () => {
  const files = allTextFiles(root).filter((file) => {
    const relative = path.relative(root, file);
    return !relative.startsWith(`docs${path.sep}`) &&
      !relative.startsWith(`tests${path.sep}`) &&
      relative !== "README.md" &&
      relative !== "README_CN.md";
  });
  const forbidden = [
    /\bcometix\b/i,
    /\bcursor2plus\b/i,
    /@cometix/i,
    /\.ccursor\b/i,
    /Cursor\+\+/,
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, file);
    }
  }
});

test("project text has no local package identifiers or old rewrite labels", () => {
  const forbidden = [
    new RegExp("lo" + "cal-byok", "i"),
    new RegExp("cursor-byok-cle" + "anroom", "i"),
    new RegExp("cle" + "anroom", "i"),
  ];
  for (const file of allTextFiles(root)) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, file);
    }
  }
});

test("runtime source has no collector or telemetry implementation", () => {
  const files = allTextFiles(path.join(root, "src"))
    .concat(allTextFiles(path.join(root, "scripts")))
    .concat([path.join(root, "package.json"), path.join(root, "README.md"), path.join(root, "README_CN.md")]);
  const forbidden = [
    /\btelemetry\b/i,
    /\bcollector\b/i,
    /__byokQueue/,
    /collectorUrl/,
    /\/hook\b/,
    /metrics\.cursor\.sh/,
    /sentry\.io/,
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, file);
    }
  }
});

test("manifest uses rewritten package id", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.publisher, "starduster");
  assert.equal(manifest.name, "cursor-byok");
  assert.equal(manifest.icon, "resources/icon.png");
  assert.equal(manifest.main, "./src/extension.js");
  const commands = manifest.contributes.commands.map((command) => command.command);
  assert.deepEqual(commands.sort(), [
    "cursorByok.installWorkbenchHook",
    "cursorByok.openLog",
    "cursorByok.openPanel",
    "cursorByok.openProviders",
    "cursorByok.openRoutes",
    "cursorByok.openSettings",
    "cursorByok.restoreWorkbenchHook",
    "cursorByok.startServer",
    "cursorByok.stopServer",
    "cursorByok.toggleFileLog",
    "cursorByok.toggleMode",
  ].sort());
  assert.equal(commands.some((command) => command.startsWith("cursor2plus.")), false);
  const configKeys = Object.keys(manifest.contributes.configuration.properties);
  assert.equal(configKeys.every((key) => key.startsWith("cursorByok.")), true);
  assert.equal(configKeys.some((key) => key.toLowerCase().includes("collector")), false);
  assert.equal(manifest.contributes.configuration.properties["cursorByok.server.autoStart"].default, true);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, "resources/icon.png");
});

test("plugin icon uses the original Cursor logo asset", () => {
  const icon = fs.readFileSync(path.join(root, "resources", "icon.png"));
  assert.equal(crypto.createHash("sha256").update(icon).digest("hex"), "c1d163ecf6550959d6914e22228a7935a60946c9f71261936f194dd1571eea06");
});

test("workbench hook strips legacy marker and installs current marker", () => {
  const legacy = `${LEGACY_START}old${LEGACY_END}\nactual`;
  assert.equal(stripMarkedBlock(legacy, LEGACY_START, LEGACY_END), "actual");
  const previous = `${PREVIOUS_START}old${PREVIOUS_END}\nactual`;
  assert.equal(stripMarkedBlock(previous, PREVIOUS_START, PREVIOUS_END), "actual");
  const hook = buildWorkbenchHook({
    host: "127.0.0.1",
    port: 9960,
    routes: ["REST:/auth/poll", "aiserver.v1.AiService/AvailableModels", "agent.v1.AgentService/RunSSE"],
    byokModelIds: ["byok-model"],
  });
  assert.match(hook, /CURSOR-BYOK-HOOK-V2-START/);
  assert.doesNotMatch(hook, /CURSOR-BYOK-HOOK-START/);
  assert.doesNotMatch(hook, /cle(?:anroom)/i);
  assert.doesNotMatch(hook, /collector/i);
  assert.match(hook, /__cursorByokWrapTransport/);
  assert.match(hook, /"byokModelIds":\["byok-model"\]/);
  assert.doesNotMatch(hook, /"workspaceRoots"/);
  assert.match(hook, /BidiService/);
  assert.match(hook, /\/byok\/bidi/);
  assert.doesNotMatch(hook, /\/byok\/rpc/);
});

test("serialized workbench hook is self-contained after function stringification", () => {
  const hook = buildWorkbenchHook({
    host: "127.0.0.1",
    port: 9960,
    routes: ["agent.v1.AgentService/RunSSE"],
    byokModelIds: ["byok-model"],
  });
  assert.doesNotMatch(hook, /isClientInteractionToolShared/);
  assert.doesNotMatch(hook, /normalizeAskQuestionArgsShared/);
  assert.doesNotMatch(hook, /normalizeCreatePlanQueryArgsShared/);
  assert.doesNotMatch(hook, /buildClientInteractionQuery,\n/);
  assert.match(hook, /function buildClientInteractionQuery/);
  assert.match(hook, /function toolResultFromClientCompletion/);
});

test("workbench hook initializes BYOK model cache before AvailableModels is fetched", () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalIsModel = globalThis.__cursorByokIsModel;
  const originalModelIds = globalThis.__cursorByokModelIds;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    delete globalThis.__cursorByokIsModel;
    delete globalThis.__cursorByokModelIds;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async () => {
      throw new Error("initial BYOK model cache must not require network");
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModelIds: ["gpt55-sub2api"],
    });

    assert.equal(globalThis.__cursorByokIsModel("gpt55-sub2api"), true);
    assert.equal(globalThis.__cursorByokIsModel("official-model"), false);
    assert.equal(globalThis.__cursorByokHasModelCandidate(["official-model", "gpt55-sub2api"]), true);
    assert.equal(globalThis.__cursorByokPickModelId(["official-model", "gpt55-sub2api"]), "gpt55-sub2api");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalIsModel === undefined) delete globalThis.__cursorByokIsModel;
    else globalThis.__cursorByokIsModel = originalIsModel;
    if (originalModelIds === undefined) delete globalThis.__cursorByokModelIds;
    else globalThis.__cursorByokModelIds = originalModelIds;
  }
});

test("workbench integrity prompt is suppressed for current Cursor workbench shape", () => {
  const source =
    "async _compute(){const{isPure:n}=await this.isPure();if(n||await this._isExplainedByPendingUpdate())return;this.logService.warn(`modified`);const e=this.storage.get();e?.dontShowPrompt&&e.commit===this.productService.commit||this._showNotification()}";
  const patched = patchIntegrityWarning(source);
  assert.notEqual(patched, source);
  assert.match(patched, /this\.logService\.warn/);
  assert.match(patched, /void 0/);
  assert.doesNotMatch(patched, /_showNotification/);
});

test("workbench stall detector is silenced after stream end or dispose", () => {
  const source = [
    "before",
    'onStreamEnded(){this.trackActivity("stream","ended"),this.streamEndedAt=Date.now()}',
    'onAdvisoryDetected(){if(this.hasLogged||this.hasLoggedAdvisory||this.advisoryThresholdMs===void 0||this.advisoryThresholdMs<=0)return;const e=Date.now()-this.lastActivityTime;e<this.advisoryThresholdMs||(this.hasLoggedAdvisory=!0,this.reportAdvisory(e,this.advisoryThresholdMs))}',
    'onStallDetected(n){if(n==="heartbeat_only"){const i=Date.now(),r=i-this.lastActivityTime,s=i-this.lastMeaningfulActivityTime;if(r<this.thresholdMs&&s>=this.heartbeatOnlyThresholdMs){if(this.hasLoggedHeartbeatOnly)return;this.hasLoggedHeartbeatOnly=!0,this.reportStall(n,s)}return}if(this.hasLogged)return;this.hasLogged=!0,this.hasLoggedAdvisory=!0;const t=Date.now()-this.lastActivityTime;this.reportStall(n,t)}',
    "after",
  ].join("");
  const patched = patchStallDetectorCleanup(source);
  assert.match(patched, /onStreamEnded\(\)\{this\.trackActivity\("stream","ended"\),this\.streamEndedAt=Date\.now\(\),this\.timer!==void 0&&\(clearTimeout\(this\.timer\),this\.timer=void 0\),this\.advisoryTimer!==void 0&&\(clearTimeout\(this\.advisoryTimer\),this\.advisoryTimer=void 0\),this\.heartbeatOnlyTimer!==void 0&&\(clearTimeout\(this\.heartbeatOnlyTimer\),this\.heartbeatOnlyTimer=void 0\)\}/);
  assert.match(patched, /onAdvisoryDetected\(\)\{if\(this\.disposedAt\|\|this\.streamEndedAt\|\|this\.hasLogged\|\|this\.hasLoggedAdvisory/);
  assert.match(patched, /onStallDetected\(n\)\{if\(this\.disposedAt\|\|this\.streamEndedAt\)return;if\(n==="heartbeat_only"\)\{/);
});

test("workbench first-token warning thresholds are relaxed for BYOK models", () => {
  const source = [
    'const bt=this.getModelNameForMetrics(kt,this._aiSettingsService);',
    'We.setAttribute("composer.selectedModel",bt),ct.setAttribute("composer.selectedModel",bt),kt.maxMode!==void 0&&We.setAttribute("composer.maxMode",kt.maxMode),re?.setModel(bt);',
    'const Tt=[2e3,4e3,6e3,8e3,1e4,12e3,14e3,16e3,32e3],He=this._experimentService.getDynamicConfigParam("composer_hang_detection_config","thresholds_ms",{disableExposureLog:!1})??Tt,ht="agent";',
  ].join("");
  const patched = patchFirstTokenWarningThresholds(source);
  assert.notEqual(patched, source);
  assert.match(patched, /globalThis\.__cursorByokIsModel==="function"/);
  assert.match(patched, /globalThis\.__cursorByokIsModel\(bt\)\?\[6e3,8e3,1e4,12e3,14e3,16e3,32e3\]/);
  assert.match(patched, /this\._experimentService\.getDynamicConfigParam\("composer_hang_detection_config","thresholds_ms",\{disableExposureLog:!1\}\)\?\?Tt/);
});

test("workbench transport hook discovery patches Cursor 3.7 promise client factory", () => {
  const source =
    "before function gO_(n,e){return rc1(n,t=>{switch(t.kind){case rn.Unary:return lc1(e,n,t);case rn.ServerStreaming:return cc1(e,n,t);case rn.ClientStreaming:return uc1(e,n,t);case rn.BiDiStreaming:return dc1(e,n,t);default:return null}})}function vO_(n,e){return gO_(n,e)} after";

  const patched = patchPromiseClientFactory(source);
  assert.notEqual(patched, source);
  assert.match(patched, /__cursorByokMarkHookPoint\("connect-promise-client",\{serviceType:n&&n\.typeName\}\)/);
  assert.match(patched, /__cursorByokWrapTransport\(e,n\.typeName\)/);
  assert.match(patched, /case rn\.Unary:return lc1\(e,n,t\)/);
  assert.match(patched, /case rn\.BiDiStreaming:return dc1\(e,n,t\)/);

  const status = patchTransportFactoryWithStatus(source);
  assert.deepEqual(status.hookPoints, ["connect-promise-client"]);
  assert.deepEqual(status.patchedHookPoints, ["connect-promise-client"]);
  assert.equal(status.hasActiveHook, true);
});

test("workbench transport hook discovery is idempotent for Cursor 3.7 promise client factory", () => {
  const source =
    "before function gO_(n,e){return rc1(n,t=>{switch(t.kind){case rn.Unary:return lc1(e,n,t);case rn.ServerStreaming:return cc1(e,n,t);case rn.ClientStreaming:return uc1(e,n,t);case rn.BiDiStreaming:return dc1(e,n,t);default:return null}})}function vO_(n,e){return gO_(n,e)} after";

  const once = patchPromiseClientFactory(source);
  const twice = patchPromiseClientFactory(once);
  assert.equal(twice, once);
  assert.equal((twice.match(/__cursorByokWrapTransport\(e,n\.typeName\)/g) || []).length, 1);
  const status = patchTransportFactoryWithStatus(once);
  assert.equal(status.content, once);
  assert.deepEqual(status.hookPoints, ["connect-promise-client"]);
  assert.deepEqual(status.patchedHookPoints, []);
  assert.deepEqual(detectActiveTransportHookPoints(once), ["connect-promise-client"]);
});

test("workbench context-rpc agent client run is patched before official AgentService Run", () => {
  const source =
    'before this.backendClient=this.instantiationService.createInstance(XT,{service:Olh,headerInjector:async()=>{const M=1;return M}});const v=this.backendClient,b=this.mockAgentStreamService,k=this.fileAppendService,E=this.workspaceContextService,A=this.environmentService,R=this.experimentService,D=this.logService;b.isAvailable?this.client=new $sg(new tgw(M=>b.getMockStream(M.conversationId,M.requestId,M.signal))):this.client=new $sg({async*run(M,B,O){const J=await v.get(M),W=vMt(J,{injectTraceHeaders:!0}),z=(!A.isBuilt||A.isExtensionDevelopment)&&R.checkFeatureGate("nal_trace",{disableExposureLog:!1});let V;if(z){const Y=O.headers?.["x-request-id"]??"undefined-bug";V=new dKw(Y,k,E),B=CN_(B,Q=>{V.logMessage(Q,"sent")})}let j=W.run(M,B,O);try{O.onNetworkStarted?.()}catch(Y){D.warn("[AgentClientService] onNetworkStarted callback failed",Y)}try{for await(const Y of j)yield Y}finally{V&&await V.finalize()}}})}async getLocalAgentProviderConfig(n){after';

  const patched = patchContextRpcAgentClient(source);

  assert.notEqual(patched, source);
  assert.match(patched, /__cursorByokMarkHookPoint\("context-rpc-agent-client",\{serviceType:Olh&&Olh\.typeName\}\)/);
  assert.match(patched, /__cursorByokWrapAgentClient\(vMt\(J,\{injectTraceHeaders:!0\}\),Olh\):vMt\(J,\{injectTraceHeaders:!0\}\)/);
  assert.match(patched, /let j=W\.run\(M,B,O\)/);
  assert.deepEqual(detectActiveTransportHookPoints(patched), ["context-rpc-agent-client"]);
  assert.equal(patchContextRpcAgentClient(patched), patched);
});

test("workbench context-rpc agent client patch matches pristine backup minified names", () => {
  const source =
    'before this.backendClient=this.instantiationService.createInstance(XT,{service:Tlh,headerInjector:async()=>{const M=1;return M}});const v=this.backendClient,b=this.mockAgentStreamService,k=this.fileAppendService,E=this.workspaceContextService,A=this.environmentService,R=this.experimentService,D=this.logService;b.isAvailable?this.client=new wsg(new tgw(M=>b.getMockStream(M.conversationId,M.requestId,M.signal))):this.client=new wsg({async*run(M,B,F){const J=await v.get(M),W=hMt(J,{injectTraceHeaders:!0}),z=(!A.isBuilt||A.isExtensionDevelopment)&&R.checkFeatureGate("nal_trace",{disableExposureLog:!1});let V;if(z){const Y=F.headers?.["x-request-id"]??"undefined-bug";V=new Pjw(Y,k,E),B=YL_(B,Q=>{V.logMessage(Q,"sent")})}let j=W.run(M,B,F);try{F.onNetworkStarted?.()}catch(Y){D.warn("[AgentClientService] onNetworkStarted callback failed",Y)}try{for await(const Y of j)yield Y}finally{V&&await V.finalize()}}})}after';

  const patched = patchContextRpcAgentClient(source);

  assert.notEqual(patched, source);
  assert.match(patched, /__cursorByokMarkHookPoint\("context-rpc-agent-client",\{serviceType:Tlh&&Tlh\.typeName\}\)/);
  assert.match(patched, /__cursorByokWrapAgentClient\(hMt\(J,\{injectTraceHeaders:!0\}\),Tlh\):hMt\(J,\{injectTraceHeaders:!0\}\)/);
  assert.deepEqual(detectActiveTransportHookPoints(patched), ["context-rpc-agent-client"]);
});

test("full workbench patch fails fast when no supported transport hook point is found", () => {
  const hook = buildWorkbenchHook({
    host: "127.0.0.1",
    port: 9960,
    routes: ["aiserver.v1.AiService/AvailableModels"],
  });
  assert.throws(
    () => patchWorkbenchContentWithStatus("function unrelated(){}", hook),
    /no supported Cursor transport hook point found/,
  );
});

test("workbench submitChat keeps BYOK models on cursor-agent backend before Claude Code validation", () => {
  const source =
    'before async submitChatMaybeAbortCurrent(n,e,t){void t?._internalTurnTracker;const si=(Xe.data.agentBackend??"cursor-agent")!=="cursor-agent";this._structuredLogService.info("composer","Starting stream request",{requestId:Z,composerId:n,useAgentProviderRouter:si,modelName:Ut.modelName,conversationLength:Xe.data.fullConversationHeadersOnly.length});const fr=this._buildAgentRequestHeaders();let Ui;const Pi=()=>{};if(si){if(!this.isModelCompatibleWithClaudeCodeBackend(yt))throw new xNp(Ut.modelName??"unknown");Rt.end(),this._structuredLogService.info("composer","Using agent provider router backend",{requestId:Z,composerId:n,conversationId:n});Qi.run()}} after';
  const patched = patchAgentProviderRouterGuard(source);
  assert.notEqual(patched, source);
  assert.match(patched, /__cursorByokHasSubmitModelCandidate/);
  assert.match(patched, /__cursorByokRememberComposerMode\(Z,Xe\.data&&Xe\.data\.unifiedMode\)/);
  assert.match(patched, /useAgentProviderRouter:si/);
  assert.match(patched, /if\(si\)\{if\(!this\.isModelCompatibleWithClaudeCodeBackend\(yt\)\)throw new xNp\(Ut\.modelName\?\?"unknown"\)/);

  const run = new Function("globalThis", "Xe", "Ut", "yt", "Z", "n", "t", "Le", `
    ${patched.slice(patched.indexOf("const si="), patched.indexOf("const fr="))}
    return si;
  `);
  const conversation = { data: { agentBackend: "claude-code" } };
  conversation.data.unifiedMode = "plan";
  conversation.data.fullConversationHeadersOnly = [];
  const remembered = [];
  const globals = {
    __cursorByokRememberComposerMode: (requestId, mode) => remembered.push({ requestId, mode }),
  };
  const logger = { _structuredLogService: { info: () => {} } };
  const evalGuard = (globalThisValue, modelDetails, selectedModel, requestId, composerId, submitOptions = {}, composerHandle = conversation) =>
    run.call(logger, globalThisValue, composerHandle, modelDetails, selectedModel, requestId, composerId, submitOptions, composerHandle);
  assert.equal(evalGuard(globals, { modelName: "official-model" }, "official-model", "request-1", "composer-1"), true);
  assert.deepEqual(remembered.pop(), { requestId: "request-1", mode: "plan" });
  assert.equal(evalGuard({ __cursorByokHasSubmitModelCandidate: () => true }, { modelName: "byok-model" }, "byok-model", "request-2", "composer-2"), false);
  assert.equal(evalGuard({ __cursorByokHasSubmitModelCandidate: () => true }, { modelName: "provider-model" }, "byok-public", "request-3", "composer-3"), false);
  assert.equal(evalGuard({ __cursorByokHasSubmitModelCandidate: () => true }, { modelName: "byok-from-details" }, "official-selected", "request-4", "composer-4"), false);
  assert.equal(evalGuard({
    __cursorByokHasSubmitModelCandidate: (_selected, _details, submitOptions, composerData) =>
      submitOptions?.isPlanExecution === true
      && composerData?.modelConfig?.selectedModels?.[0]?.modelId === "GLM-5.1-Coding",
  }, { modelName: "default" }, "default", "request-5", "composer-5", { isPlanExecution: true }, {
    data: {
      agentBackend: "claude-code",
      fullConversationHeadersOnly: [],
      modelConfig: { modelName: "default", selectedModels: [{ modelId: "GLM-5.1-Coding", parameters: [] }] },
    }
  }), false);
});

test("workbench submitChat patches Cursor 3.7 router guard when submit options are far above the guard", () => {
  const padding = "/* padding */".repeat(7000);
  const filler = "void 0;".repeat(2000);
  const source =
    `${padding}async submitChatMaybeAbortCurrent(n,e,t){void t?._internalTurnTracker;${filler}const ur=(Pe.data.agentBackend??"cursor-agent")!=="cursor-agent";this._structuredLogService.info("composer","Starting stream request",{requestId:ne,composerId:n,useAgentProviderRouter:ur,modelName:kt.modelName,conversationLength:Pe.data.fullConversationHeadersOnly.length});const zr=this._buildAgentRequestHeaders();let ks;const Br=()=>{};if(ur){if(!this.isModelCompatibleWithClaudeCodeBackend($t))throw new fsg(kt.modelName??"unknown");}}`;
  const patched = patchAgentProviderRouterGuard(source);
  assert.notEqual(patched, source);
  assert.match(patched, /__cursorByokHasSubmitModelCandidate\(\$t,kt,t,Pe\.data\)/);
});

test("workbench submitChat patch survives same-named decoy methods and a restructured throw", () => {
  // Two classes carry submitChatMaybeAbortCurrent; only one contains the
  // router-guard seam. The incompatible-model throw no longer carries
  // modelName??"unknown", so the model-details identifier must come from the
  // structured-log call instead.
  const decoy = 'async submitChatMaybeAbortCurrent(n){return this.queue.submitChatMaybeAbortCurrent(n)}';
  const source =
    `class a{${decoy}}class b{async submitChatMaybeAbortCurrent(n,e,t){void t?._internalTurnTracker;const si=(Xe.data.agentBackend??"cursor-agent")!=="cursor-agent";this._structuredLogService.info("composer","Starting stream request",{requestId:Z,composerId:n,useAgentProviderRouter:si,modelName:Ut.modelName,conversationLength:Xe.data.fullConversationHeadersOnly.length});if(si){if(!this.isModelCompatibleWithClaudeCodeBackend(yt))throw new xNp("model incompatible with router backend");Qi.run()}}}`;
  const patched = patchAgentProviderRouterGuard(source);
  assert.notEqual(patched, source);
  assert.match(patched, /__cursorByokHasSubmitModelCandidate\(yt,Ut,t,Xe\.data\)/);
  assert.equal(patched.includes(decoy), true);
});

test("workbench local agent path falls back to Connect transport for BYOK model ids", async () => {
  const source =
    'before async run(n,e,t,i,r,s,o,a,c,d,m){const h={...m,isRunningInTest:m.isRunningInTest??this.environmentService.enableSmokeTestDriver===!0,clientSupportsInlineImages:!0};if(uv.localMode){try{h.onNetworkPhaseStart?.()}catch(f){this.logService.warn("[AgentClientService] onNetworkPhaseStart callback failed in local mode",f)}return this.runLocalAgentInExtensionHost(n,e,t,i,r,o,c,d,h)}return this.client.run(n,e,t,i,r,s,o,a,c,d,h)}async openPrewarmStream(n,e){after';
  const patched = patchLocalAgentRunForByok(source);
  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /__cursorByokHydrateLocalAgentOptions/);
  assert.doesNotMatch(patched, /__cursorByokHasTransportAdapterCandidate/);
  assert.match(patched, /__cursorByokHasRunOptionsModelCandidate/);
  assert.match(patched, /return this\.client\.run\(n,e,t,i,r,s,o,a,c,d,h\)/);
  assert.match(patched, /runLocalAgentInExtensionHost\(n,e,t,i,r,o,c,d,h\)/);

  const body = patched.slice(patched.indexOf("async run"), patched.indexOf("async openPrewarmStream"));
  assert.equal(body.includes("uv.localMode&&!("), true);
  assert.equal(body.includes("__cursorByokHasRunOptionsModelCandidate(h,i)"), true);

  const phaseEvents = [];
  const run = new Function("globalThis", "uv", `
    const calls = [];
    let localOptions;
    const cls = class {
      constructor(){ this.logService = { warn() {} }; this.environmentService = { enableSmokeTestDriver: false }; this.client = { run(n,e,t,i,r,s,o,a,c,d,h){ calls.push("client"); try { h?.onNetworkPhaseStart?.(); } catch {} } }; }
      runLocalAgentInExtensionHost(n,e,t,i,r,s,o,a,c){ calls.push("local"); localOptions = c; }
      ${body}
    };
    const self = new cls();
    return { calls, get localOptions(){ return localOptions; }, run: self.run.bind(self) };
  `);
  const options = { requestedModel: { modelId: "byok-model" }, modelDetails: { modelId: "byok-model" } };
  const official = run({
    __cursorByokHasRunOptionsModelCandidate() { return false; },
  }, { localMode: true });
  await official.run(null, null, null, null, null, null, null, null, null, null, {
    requestedModel: { modelId: "official-model" },
    onNetworkPhaseStart() { phaseEvents.push("official"); },
  });
  assert.deepEqual(official.calls, ["local"]);
  assert.deepEqual(official.localOptions.requestedModel, { modelId: "official-model" });
  assert.deepEqual(phaseEvents, ["official"]);

  const byok = run({
    __cursorByokHasRunOptionsModelCandidate() { return true; },
  }, { localMode: true });
  await byok.run(null, null, null, null, null, null, null, null, null, null, {
    ...options,
    onNetworkPhaseStart() { phaseEvents.push("byok"); },
  });
  assert.deepEqual(byok.calls, ["client"]);
  assert.deepEqual(phaseEvents, ["official", "byok"]);

  const byokSelectedArgumentOnly = run({
    __cursorByokHasRunOptionsModelCandidate(_options, selectedModel) { return selectedModel?.modelId === "byok-model"; },
  }, { localMode: true });
  await byokSelectedArgumentOnly.run(null, null, null, { modelId: "byok-model" }, null, null, null, null, null, null, {
    onNetworkPhaseStart() { phaseEvents.push("selected-arg"); },
  });
  assert.deepEqual(byokSelectedArgumentOnly.calls, ["client"]);
  assert.deepEqual(phaseEvents, ["official", "byok", "selected-arg"]);

  const byokPlanExecutionSelectedModels = run({
    __cursorByokHasRunOptionsModelCandidate(options) {
      return options?.isPlanExecution === true
        && options?.modelConfig?.selectedModels?.[0]?.modelId === "GLM-5.1-Coding";
    },
  }, { localMode: true });
  await byokPlanExecutionSelectedModels.run(null, null, null, null, null, null, null, null, null, null, {
    isPlanExecution: true,
    modelConfig: { modelName: "default", selectedModels: [{ modelId: "GLM-5.1-Coding", parameters: [] }] },
    onNetworkPhaseStart() { phaseEvents.push("plan-exec"); },
  });
  assert.deepEqual(byokPlanExecutionSelectedModels.calls, ["client"]);
  assert.deepEqual(phaseEvents, ["official", "byok", "selected-arg", "plan-exec"]);
});

test("workbench local agent patch handles trailing run options and prewarm anchor decoys", () => {
  // Mirrors newer Cursor builds: the run options literal gains properties after
  // clientSupportsInlineImages, and openPrewarmStream carries a second
  // clientSupportsInlineImages:!0 site outside any async run( method.
  const source =
    'before async run(n,e,t,i,r,s,o,a,c,d,m){const h={...m,isRunningInTest:m.isRunningInTest??this.environmentService.enableSmokeTestDriver===!0,clientSupportsInlineImages:!0,clientSupportsSendToUser:!0};if(bv.localMode){try{h.onNetworkPhaseStart?.()}catch(f){this.logService.warn("[AgentClientService] onNetworkPhaseStart callback failed in local mode",f)}return this.runLocalAgentInExtensionHost(n,e,t,i,r,o,c,d,h)}return this.client.run(n,e,t,i,r,s,o,a,c,d,h)}async openPrewarmStream(n,e){const c=new tUf({modelDetails:e.modelDetails,preFetchedBlobs:e.preFetchedBlobs??[],clientSupportsInlineImages:!0,clientSupportsSendToUser:!0,canCreateCloudSubagents:e.canCreateCloudSubagents});return c}after';
  const patched = patchLocalAgentRunForByok(source);
  assert.notEqual(patched, source);
  const body = patched.slice(patched.indexOf("async run"), patched.indexOf("async openPrewarmStream"));
  assert.equal(body.includes("bv.localMode&&!("), true);
  assert.equal(body.includes("__cursorByokHasRunOptionsModelCandidate(h,i)"), true);
  const prewarm = patched.slice(patched.indexOf("async openPrewarmStream"));
  assert.doesNotMatch(prewarm, /__cursorByokHasRunOptionsModelCandidate/);
  assert.match(prewarm, /clientSupportsInlineImages:!0,clientSupportsSendToUser:!0,canCreateCloudSubagents/);
});

test("workbench local agent patch tolerates statements inserted around the run options declaration", () => {
  const source =
    'before async run(n,e,t,i,r,s,o,a,c,d,m){this.logService.trace("[AgentClientService] run");const h={...m,isRunningInTest:m.isRunningInTest??this.environmentService.enableSmokeTestDriver===!0,clientSupportsInlineImages:!0,clientSupportsSendToUser:!0};this.telemetryService?.publicLog2("agentRun");if(bv.localMode){return this.runLocalAgentInExtensionHost(n,e,t,i,r,o,c,d,h)}return this.client.run(n,e,t,i,r,s,o,a,c,d,h)}after';
  const patched = patchLocalAgentRunForByok(source);
  assert.notEqual(patched, source);
  assert.equal(patched.includes("if(bv.localMode&&!("), true);
  assert.equal(patched.includes("__cursorByokHasRunOptionsModelCandidate(h,i)"), true);
});

test("workbench local agent patch reports not-needed on pre-local-mode builds", () => {
  // Mirrors Cursor 3.3.30: no localMode build flag, no
  // runLocalAgentInExtensionHost — the run method forwards options straight to
  // this.client.run, so every run already takes the hook-intercepted transport
  // path and there is nothing to patch. The prewarm anchor decoy outside any
  // async run( method matches the real build too.
  const source =
    'before async run(e,t,i,r,s,o,a,l,u,d,m){const f={...m,isRunningInTest:m.isRunningInTest??this.environmentService.enableSmokeTestDriver===!0,clientSupportsInlineImages:!0};return this.client.run(e,t,i,r,s,o,a,l,u,d,f)}async openPrewarmStream(e,t){const u=new Z0d({modelDetails:t.modelDetails,preFetchedBlobs:t.preFetchedBlobs??[],clientSupportsInlineImages:!0,canCreateCloudSubagents:t.canCreateCloudSubagents});return u}after';
  assert.equal(patchLocalAgentRunForByok(source), source);
  assert.equal(isLocalAgentRunPatchUnnecessary(source), true);
  const { report } = applyPatchPlan(source, { names: ["local-agent-run"] });
  assert.deepEqual(report, [{ name: "local-agent-run", severity: "critical", status: "not-needed" }]);
  assert.deepEqual(missingCriticalPatches(report), []);
});

test("workbench local agent not-needed probe stays loud on unrecognized branches", () => {
  // A renamed local-mode flag must NOT pass as not-needed: the branch routes
  // runs away from the transport path and needs human analysis.
  const renamedFlag =
    'before async run(e,t,i,r,s,o,a,l,u,d,m){const f={...m,isRunningInTest:m.isRunningInTest??!1,clientSupportsInlineImages:!0};if(uv.offlineEval){return this.runSomewhereElse(e,f)}return this.client.run(e,t,i,r,s,o,a,l,u,d,f)}after';
  assert.equal(patchLocalAgentRunForByok(renamedFlag), renamedFlag);
  assert.equal(isLocalAgentRunPatchUnnecessary(renamedFlag), false);
  const { report } = applyPatchPlan(renamedFlag, { names: ["local-agent-run"] });
  assert.deepEqual(report, [{ name: "local-agent-run", severity: "critical", status: "absent" }]);
  assert.deepEqual(missingCriticalPatches(report), ["local-agent-run"]);

  // A conditional pick between two run targets is just as ambiguous.
  const conditionalRoute =
    'before async run(e,t,i,r,s,o,a,l,u,d,m){const f={...m,isRunningInTest:m.isRunningInTest??!1,clientSupportsInlineImages:!0};return(uv.fancyMode?this.localClient:this.client).run(e,t,i,r,s,o,a,l,u,d,f)}after';
  assert.equal(isLocalAgentRunPatchUnnecessary(conditionalRoute), false);

  // Patchable (localMode present) sources must not read as not-needed either.
  const patchable =
    'before async run(n,e,t,i,r,s,o,a,c,d,m){const h={...m,isRunningInTest:m.isRunningInTest??this.environmentService.enableSmokeTestDriver===!0,clientSupportsInlineImages:!0};if(uv.localMode){try{h.onNetworkPhaseStart?.()}catch(f){this.logService.warn("[AgentClientService] onNetworkPhaseStart callback failed in local mode",f)}return this.runLocalAgentInExtensionHost(n,e,t,i,r,o,c,d,h)}return this.client.run(n,e,t,i,r,s,o,a,c,d,h)}after';
  assert.equal(isLocalAgentRunPatchUnnecessary(patchable), false);
  assert.notEqual(patchLocalAgentRunForByok(patchable), patchable);
});

test("workbench local agent path recognizes plan execution modelOverride for BYOK routing", async () => {
  const source =
    'before async run(n,e,t,i,r,s,o,a,c,d,m){const h={...m,isRunningInTest:m.isRunningInTest??this.environmentService.enableSmokeTestDriver===!0,clientSupportsInlineImages:!0};if(uv.localMode){try{h.onNetworkPhaseStart?.()}catch(f){this.logService.warn("[AgentClientService] onNetworkPhaseStart callback failed in local mode",f)}return this.runLocalAgentInExtensionHost(n,e,t,i,r,o,c,d,h)}return this.client.run(n,e,t,i,r,s,o,a,c,d,h)}async openPrewarmStream(n,e){after';
  const patched = patchLocalAgentRunForByok(source);
  const body = patched.slice(patched.indexOf("async run"), patched.indexOf("async openPrewarmStream"));
  const run = new Function("globalThis", "uv", `
    const calls = [];
    const cls = class {
      constructor(){ this.logService = { warn() {} }; this.environmentService = { enableSmokeTestDriver: false }; this.client = { run(){ calls.push("client"); } }; }
      runLocalAgentInExtensionHost(){ calls.push("local"); }
      ${body}
    };
    const self = new cls();
    return { calls, run: self.run.bind(self) };
  `);
  const globals = { __cursorByokModelIds: ["GLM-5.1-Coding"] };
  hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [], byokModelIds: ["GLM-5.1-Coding"] });
  await new Promise((resolve) => setImmediate(resolve));
  Object.assign(globals, {
    __cursorByokHasRunOptionsModelCandidate: globalThis.__cursorByokHasRunOptionsModelCandidate,
  });
  const planBuild = run(globals, { localMode: true });
  await planBuild.run(null, null, null, null, null, null, null, null, null, null, {
    isPlanExecution: true,
    modelOverride: "GLM-5.1-Coding",
    modelConfig: { modelName: "default" },
  });
  assert.deepEqual(planBuild.calls, ["client"]);
});

test("full workbench patch removes legacy blocks before installing current hook", () => {
  const hook = buildWorkbenchHook({
    host: "127.0.0.1",
    port: 9960,
    routes: ["aiserver.v1.AiService/AvailableModels"],
  });
  const source =
    `${PREVIOUS_START}globalThis.__cursorByokWrapTransport=function(){}${PREVIOUS_END}\n` +
    `${LEGACY_START}globalThis.__byokWrapTransport=function(){}${LEGACY_END}\n` +
    'const si=(Xe.data.agentBackend??"cursor-agent")!=="cursor-agent";this._structuredLogService.info("composer","Starting stream request",{requestId:Z,composerId:n,useAgentProviderRouter:si,modelName:Ut.modelName,conversationLength:Xe.data.fullConversationHeadersOnly.length});const fr=this._buildAgentRequestHeaders();let Ui;const Pi=()=>{};if(si){if(!this.isModelCompatibleWithClaudeCodeBackend(yt))throw new xNp(Ut.modelName??"unknown");Rt.end(),Qi.run()}async run(n,e,t,i,r,s,o,a,c,d,m){const h={...m,isRunningInTest:m.isRunningInTest??this.environmentService.enableSmokeTestDriver===!0,clientSupportsInlineImages:!0};if(uv.localMode){try{h.onNetworkPhaseStart?.()}catch(f){this.logService.warn("[AgentClientService] onNetworkPhaseStart callback failed in local mode",f)}return this.runLocalAgentInExtensionHost(n,e,t,i,r,o,c,d,h)}return this.client.run(n,e,t,i,r,s,o,a,c,d,h)}' +
    MODERN_TRANSPORT_SOURCE;
  const patched = patchWorkbenchContent(source, hook);
  assert.match(patched, /CURSOR-BYOK-HOOK-V2-START/);
  assert.match(patched, /__cursorByokWrapTransport/);
  assert.match(patched, /__cursorByokIsModel/);
  assert.match(patched, /uv\.localMode&&!\(typeof globalThis\.__cursorByokHasRunOptionsModelCandidate/);
  assert.doesNotMatch(patched, /__byokWrapTransport/);
  assert.doesNotMatch(patched, /CURSOR-BYOK-HOOK-START/);
  assert.doesNotMatch(patched, /cle(?:anroom)/i);
});

test("installer embeds configured BYOK model ids into the workbench hook", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-hook-models-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  try {
    ensureConfigFiles();
    writeJsonFile(providersPath(), {
      schemaVersion: 1,
      providers: [{
        id: "p",
        name: "Provider",
        type: "openai-chat",
        models: [
          { id: "gpt55-sub2api", apiModel: "gpt-5.5", displayName: "GPT BYOK" },
          { id: "minimal-byok" },
        ],
      }],
    });
    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE);
    fs.writeFileSync(extHost, "");

    const result = require("../scripts/install-workbench-hook").installWorkbenchHook({ workbench, extHost, allowPartial: true });
    const patched = fs.readFileSync(result.workbench, "utf8");

    assert.match(patched, /"byokModelIds":/);
    assert.match(patched, /gpt55-sub2api/);
    assert.match(patched, /GPT BYOK/);
    assert.match(patched, /minimal-byok/);
    assert.match(patched, /gpt-5\.5/);
    assert.deepEqual(result.transportHookPoints, ["connect-promise-client"]);
    assert.deepEqual(result.patchedHookPoints, ["connect-promise-client"]);
  } finally {
    restoreHome();
  }
});

test("workbench installer dry run reports hook support without writing backups or files", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-dry-run-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  const extHostSource = "console.log('no integrity patch needed');";
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE);
    fs.writeFileSync(extHost, extHostSource);

    const result = analyzeWorkbenchHookInstall({ workbench, extHost });

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.transportHookPoints, ["connect-promise-client"]);
    assert.equal(result.backupsCreated, 0);
    assert.deepEqual(result.backupWarnings, []);
    assert.equal(result.needsPristine, false);
    assert.equal(result.pristineSource, "as-is");
    assert.deepEqual(result.missingCriticalPatches, ["router-guard", "local-agent-run"]);
    assert.equal(result.patchReport.some((entry) => entry.name === "connect-promise-client" && entry.status === "applied"), true);
    assert.equal(fs.readFileSync(workbench, "utf8"), MODERN_TRANSPORT_SOURCE);
    assert.equal(fs.readFileSync(extHost, "utf8"), extHostSource);
    assert.equal(fs.existsSync(hookStatePath()), false);
    assert.equal(fs.existsSync(workbenchBackupDir()), false);
  } finally {
    restoreHome();
  }
});

test("workbench installer captures pristine backups and restore reverts both targets", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-restore-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  const workbenchSource = MODERN_TRANSPORT_SOURCE;
  const extHostSource =
    "async _compute(){const{isPure:n}=await this.isPure();if(n||await this._isExplainedByPendingUpdate())return;this.logService.warn(`modified`);const e=this.storage.get();e?.dontShowPrompt&&e.commit===this.productService.commit||this._showNotification()}";
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, workbenchSource);
    fs.writeFileSync(extHost, extHostSource);

    const installResult = installWorkbenchHook({ workbench, extHost, allowPartial: true });
    const state = JSON.parse(fs.readFileSync(hookStatePath(), "utf8"));

    assert.equal(installResult.backupsCreated, 2);
    assert.equal(installResult.workbenchBackupCaptured, true);
    assert.equal(installResult.extHostBackupCaptured, true);
    assert.equal(state.workbench.targetPath, workbench);
    assert.equal(state.extHost.targetPath, extHost);
    assert.equal(fs.readFileSync(state.workbench.backupPath, "utf8"), workbenchSource);
    assert.equal(fs.readFileSync(state.extHost.backupPath, "utf8"), extHostSource);
    assert.match(fs.readFileSync(workbench, "utf8"), /CURSOR-BYOK-HOOK-V2-START/);
    assert.doesNotMatch(fs.readFileSync(extHost, "utf8"), /_showNotification/);

    const restoreResult = restoreWorkbenchHook({ workbench, extHost });

    assert.deepEqual(restoreResult.restoredFiles.sort(), [extHost, workbench].sort());
    assert.equal(fs.readFileSync(workbench, "utf8"), workbenchSource);
    assert.equal(fs.readFileSync(extHost, "utf8"), extHostSource);
  } finally {
    restoreHome();
  }
});

test("workbench installer refreshes stale pristine backup after Cursor bundle changes", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-stale-backup-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const oldSource = MODERN_TRANSPORT_SOURCE_V2;
  const newSource = MODERN_TRANSPORT_SOURCE;
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, oldSource);
    installWorkbenchHook({ workbench, extHost: path.join(tmpRoot, "missing-ext-host.js"), allowPartial: true });
    const firstState = JSON.parse(fs.readFileSync(hookStatePath(), "utf8"));
    restoreWorkbenchHook({ workbench });

    fs.writeFileSync(workbench, newSource);
    const reinstall = installWorkbenchHook({ workbench, extHost: path.join(tmpRoot, "missing-ext-host.js"), allowPartial: true });
    const secondState = JSON.parse(fs.readFileSync(hookStatePath(), "utf8"));

    assert.notEqual(firstState.workbench.sha256, secondState.workbench.sha256);
    assert.equal(fs.readFileSync(secondState.workbench.backupPath, "utf8"), newSource);
    assert.equal(reinstall.backupWarnings.some((warning) => warning.includes("backup refreshed")), true);
    assert.match(fs.readFileSync(workbench, "utf8"), /CURSOR-BYOK-HOOK-V2-START/);
  } finally {
    restoreHome();
  }
});

test("installer end-to-end patches the modern promise-client hook point", () => {
  // The legacy `tly` factory only exists in old Cursor builds; current builds
  // are hooked via the connect promise-client factory (`gO_`). Install,
  // model-id embedding, idempotent reinstall, and restore must all work
  // end-to-end against that source, not just at the patch-function level.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-modern-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  const modernSource =
    "function gO_(n,e){return rc1(n,t=>{switch(t.kind){case rn.Unary:return lc1(e,n,t);case rn.ServerStreaming:return cc1(e,n,t);case rn.ClientStreaming:return uc1(e,n,t);case rn.BiDiStreaming:return dc1(e,n,t);default:return null}})}function vO_(n,e){return gO_(n,e)}function IMk(){}";
  try {
    ensureConfigFiles();
    writeJsonFile(providersPath(), {
      schemaVersion: 1,
      providers: [{
        id: "p",
        name: "Provider",
        type: "openai-chat",
        models: [{ id: "gpt55-sub2api", apiModel: "gpt-5.5", displayName: "GPT BYOK" }],
      }],
    });
    fs.writeFileSync(workbench, modernSource);
    fs.writeFileSync(extHost, "");

    const result = installWorkbenchHook({ workbench, extHost, allowPartial: true });
    assert.deepEqual(result.transportHookPoints, ["connect-promise-client"]);
    assert.deepEqual(result.patchedHookPoints, ["connect-promise-client"]);
    const patched = fs.readFileSync(workbench, "utf8");
    assert.match(patched, /CURSOR-BYOK-HOOK-V2-START/);
    assert.match(patched, /"byokModelIds":/);
    assert.match(patched, /gpt55-sub2api/);

    // Reinstall must be idempotent: no duplicate hook blocks or double patches.
    const reinstall = installWorkbenchHook({ workbench, extHost, allowPartial: true });
    assert.deepEqual(reinstall.transportHookPoints, ["connect-promise-client"]);
    const repatched = fs.readFileSync(workbench, "utf8");
    assert.equal(repatched.split("CURSOR-BYOK-HOOK-V2-START").length - 1, 1);

    const state = JSON.parse(fs.readFileSync(hookStatePath(), "utf8"));
    assert.equal(fs.readFileSync(state.workbench.backupPath, "utf8"), modernSource);
    restoreWorkbenchHook({ workbench, extHost });
    assert.equal(fs.readFileSync(workbench, "utf8"), modernSource);
  } finally {
    restoreHome();
  }
});

test("workbench install fails when the target is patched without a pristine backup", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-needs-pristine-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  const hook = buildWorkbenchHook({ host: "127.0.0.1", port: 9960, routes: [] });
  const patchedSource = hook + MODERN_TRANSPORT_SOURCE;
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, patchedSource);
    fs.writeFileSync(extHost, "");

    assert.throws(
      () => installWorkbenchHook({ workbench, extHost, allowPartial: true }),
      /already patched and no pristine backup is recorded[\s\S]*CURSOR_WORKBENCH_PRISTINE/,
    );
    assert.equal(fs.readFileSync(workbench, "utf8"), patchedSource);
    assert.equal(fs.existsSync(hookStatePath()), false);

    const analysis = analyzeWorkbenchHookInstall({ workbench, extHost });
    assert.equal(analysis.needsPristine, true);
    assert.equal(analysis.pristineSource, "patched-no-pristine");
    assert.deepEqual(analysis.transportHookPoints, []);
    assert.equal(analysis.backupWarnings.some((warning) => warning.includes("no pristine backup")), true);
  } finally {
    restoreHome();
  }
});

test("explicit pristine workbench input is rejected when it is already patched", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-bad-pristine-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  const pristineInput = path.join(tmpRoot, "claimed-pristine.js");
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE);
    fs.writeFileSync(extHost, "");
    fs.writeFileSync(pristineInput, "globalThis.__cursorByokWrapTransport=function(){};" + MODERN_TRANSPORT_SOURCE);

    assert.throws(
      () => installWorkbenchHook({ workbench, extHost, pristineWorkbench: pristineInput, allowPartial: true }),
      /already contains BYOK patches/,
    );
    assert.equal(fs.readFileSync(workbench, "utf8"), MODERN_TRANSPORT_SOURCE);
  } finally {
    restoreHome();
  }
});

test("explicit pristine workbench heals a patched install with a lost backup", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-heal-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  const pristineInput = path.join(tmpRoot, "pristine-from-dmg.js");
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE);
    fs.writeFileSync(extHost, "");
    installWorkbenchHook({ workbench, extHost, allowPartial: true });
    // Simulate a lost ~/.cursor-byok: the target stays patched but the
    // recorded backup state vanishes.
    fs.rmSync(hookStatePath(), { force: true });
    fs.rmSync(workbenchBackupDir(), { recursive: true, force: true });
    assert.throws(() => installWorkbenchHook({ workbench, extHost, allowPartial: true }), /no pristine backup is recorded/);

    fs.writeFileSync(pristineInput, MODERN_TRANSPORT_SOURCE);
    const healed = installWorkbenchHook({ workbench, extHost, pristineWorkbench: pristineInput, allowPartial: true });

    assert.equal(healed.pristineSource, "explicit");
    assert.equal(healed.workbenchBackupCaptured, true);
    const state = JSON.parse(fs.readFileSync(hookStatePath(), "utf8"));
    assert.equal(fs.readFileSync(state.workbench.backupPath, "utf8"), MODERN_TRANSPORT_SOURCE);
    const patched = fs.readFileSync(workbench, "utf8");
    assert.equal(patched.split("CURSOR-BYOK-HOOK-V2-START").length - 1, 1);
  } finally {
    restoreHome();
  }
});

test("reinstall preserves the extHost pristine backup entry when extHost is unchanged", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-exthost-entry-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  const extHostSource =
    "async _compute(){const e=this.storage.get();e?.dontShowPrompt&&e.commit===this.productService.commit||this._showNotification()}";
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE);
    fs.writeFileSync(extHost, extHostSource);

    installWorkbenchHook({ workbench, extHost, allowPartial: true });
    const firstState = JSON.parse(fs.readFileSync(hookStatePath(), "utf8"));
    assert.equal(typeof firstState.extHost?.backupPath, "string");

    // Second install: the freshly patched extHost matches the on-disk content,
    // so no extHost write is needed — the recorded backup entry must survive
    // instead of being nulled out.
    const reinstall = installWorkbenchHook({ workbench, extHost, allowPartial: true });
    const secondState = JSON.parse(fs.readFileSync(hookStatePath(), "utf8"));

    assert.equal(reinstall.extHostBackupCaptured, true);
    assert.deepEqual(secondState.extHost, firstState.extHost);
  } finally {
    restoreHome();
  }
});

test("already patched extHost without a backup is re-patched in place and never captured as pristine", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-exthost-patched-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  const staleHookBlock = `${PREVIOUS_START}globalThis.__cursorByokWrapTransport=function(){}${PREVIOUS_END}\n`;
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE);
    fs.writeFileSync(extHost, staleHookBlock + "console.log('ext host runtime');");

    const result = installWorkbenchHook({ workbench, extHost, allowPartial: true });

    const patchedExtHost = fs.readFileSync(extHost, "utf8");
    assert.equal(patchedExtHost.split("CURSOR-BYOK-HOOK-V2-START").length - 1, 1);
    assert.equal(patchedExtHost.includes(PREVIOUS_START), false);
    const state = JSON.parse(fs.readFileSync(hookStatePath(), "utf8"));
    assert.equal(state.extHost, null);
    assert.equal(result.backupWarnings.some((warning) => warning.includes("already modified before backup capture")), true);
    assert.equal(fs.readdirSync(workbenchBackupDir()).some((name) => name.startsWith("extensionHostProcess")), false);
  } finally {
    restoreHome();
  }
});

test("workbench install rejects a recorded backup that is not pristine", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-poisoned-backup-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE);
    fs.writeFileSync(extHost, "");
    installWorkbenchHook({ workbench, extHost, allowPartial: true });
    // Simulate a backup poisoned by an older installer: in-place patches
    // without a hook block, recorded as if it were pristine.
    const state = JSON.parse(fs.readFileSync(hookStatePath(), "utf8"));
    fs.writeFileSync(state.workbench.backupPath, "globalThis.__cursorByokWrapTransport=function(){};" + MODERN_TRANSPORT_SOURCE);

    assert.throws(
      () => installWorkbenchHook({ workbench, extHost, allowPartial: true }),
      /recorded backup is itself not pristine[\s\S]*CURSOR_WORKBENCH_PRISTINE/,
    );
    const analysis = analyzeWorkbenchHookInstall({ workbench, extHost });
    assert.equal(analysis.needsPristine, true);
    assert.equal(analysis.pristineSourceReason, "backup-not-pristine");
    assert.equal(analysis.backupWarnings.some((warning) => warning.includes("not pristine")), true);
  } finally {
    restoreHome();
  }
});

test("marker-less in-place patches are treated as patched and never captured as pristine", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-markerless-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  try {
    ensureConfigFiles();
    // No hook block, but the transport seam carries an in-place BYOK wrap —
    // the exact shape that used to be mis-captured as a pristine backup.
    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE.replace(
      "function vO_(n,e){return gO_(n,e)}",
      'function vO_(n,e){e=typeof globalThis.__cursorByokWrapTransport==="function"?globalThis.__cursorByokWrapTransport(e,n.typeName):e;return gO_(n,e)}',
    ));
    fs.writeFileSync(extHost, "");

    assert.throws(() => installWorkbenchHook({ workbench, extHost, allowPartial: true }), /no pristine backup is recorded/);
    assert.equal(fs.existsSync(hookStatePath()), false);
    assert.equal(fs.existsSync(workbenchBackupDir()), false);

    const analysis = analyzeWorkbenchHookInstall({ workbench, extHost });
    assert.equal(analysis.needsPristine, true);
    assert.equal(analysis.pristineSourceReason, "backup-missing");
  } finally {
    restoreHome();
  }
});

test("patch engine reports per-patch status and target filtering", () => {
  const { applyPatchPlan } = require("../scripts/workbench-patch-engine");
  const integritySnippet =
    "const e=this.storage.get();e?.dontShowPrompt&&e.commit===this.productService.commit||this._showNotification()";
  const source = integritySnippet + MODERN_FULL_WORKBENCH_SOURCE;

  const plan = applyPatchPlan(source, { target: "workbench" });
  assert.deepEqual(plan.report.map((entry) => `${entry.name}:${entry.status}`), [
    "integrity-warning:applied",
    "stall-detector:absent",
    "first-token-thresholds:absent",
    "router-guard:applied",
    "local-agent-run:applied",
    "model-picker-unlock:applied",
    "connect-promise-client:applied",
    "context-rpc-agent-client:absent",
  ]);

  const rerun = applyPatchPlan(plan.content, { target: "workbench" });
  const rerunStatus = Object.fromEntries(rerun.report.map((entry) => [entry.name, entry.status]));
  assert.equal(rerun.content, plan.content);
  assert.equal(rerunStatus["router-guard"], "active");
  assert.equal(rerunStatus["local-agent-run"], "active");
  assert.equal(rerunStatus["model-picker-unlock"], "active");
  assert.equal(rerunStatus["connect-promise-client"], "active");

  const extHostPlan = applyPatchPlan(source, { target: "extHost" });
  const extHostStatus = Object.fromEntries(extHostPlan.report.map((entry) => [entry.name, entry.status]));
  assert.equal(extHostStatus["router-guard"], "skipped-target");
  assert.equal(extHostStatus["local-agent-run"], "skipped-target");
  assert.equal(extHostStatus["integrity-warning"], "applied");
  assert.equal(extHostStatus["connect-promise-client"], "applied");
});

test("install fails by default when critical patches are missing and allowPartial overrides", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-critical-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE);
    fs.writeFileSync(extHost, "");

    assert.throws(
      () => installWorkbenchHook({ workbench, extHost }),
      /critical workbench patches did not apply: router-guard, local-agent-run/,
    );
    assert.equal(fs.existsSync(hookStatePath()), false);

    const result = installWorkbenchHook({ workbench, extHost, allowPartial: true });
    assert.deepEqual(result.missingCriticalPatches, ["router-guard", "local-agent-run"]);
    assert.equal(result.patchReport.some((entry) => entry.name === "router-guard" && entry.status === "absent"), true);
    const state = JSON.parse(fs.readFileSync(hookStatePath(), "utf8"));
    assert.equal(state.schemaVersion, 1);
    assert.equal(Array.isArray(state.lastInstall.patchReport), true);
  } finally {
    restoreHome();
  }
});

test("full workbench source installs strictly with critical patches applied", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-install-strict-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, MODERN_FULL_WORKBENCH_SOURCE);
    fs.writeFileSync(extHost, "");

    const result = installWorkbenchHook({ workbench, extHost });

    assert.deepEqual(result.missingCriticalPatches, []);
    const reportStatus = Object.fromEntries(result.patchReport.map((entry) => [entry.name, entry.status]));
    assert.equal(reportStatus["router-guard"], "applied");
    assert.equal(reportStatus["local-agent-run"], "applied");
    const patched = fs.readFileSync(workbench, "utf8");
    assert.match(patched, /__cursorByokHasSubmitModelCandidate/);
    assert.match(patched, /__cursorByokHasRunOptionsModelCandidate/);
  } finally {
    restoreHome();
  }
});

test("preflight CLI exit code distinguishes installable from blocked builds", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-preflight-cli-"));
  const restoreHome = useHome(tmpRoot);
  const script = path.join(root, "scripts", "install-workbench-hook.js");
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  const runPreflight = () => childProcess.spawnSync(process.execPath, [script, "--dry-run"], {
    env: { ...process.env, HOME: tmpRoot, CURSOR_WORKBENCH: workbench, CURSOR_EXT_HOST: extHost },
    encoding: "utf8",
  });
  try {
    ensureConfigFiles();
    fs.writeFileSync(extHost, "");

    fs.writeFileSync(workbench, MODERN_FULL_WORKBENCH_SOURCE);
    const ok = runPreflight();
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout).missingCriticalPatches, []);

    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE);
    const degraded = runPreflight();
    assert.equal(degraded.status, 2, degraded.stderr);
    assert.deepEqual(JSON.parse(degraded.stdout).missingCriticalPatches, ["router-guard", "local-agent-run"]);

    fs.writeFileSync(workbench, "function unrelated(){}");
    const unsupported = runPreflight();
    assert.equal(unsupported.status, 2, unsupported.stderr);
    assert.deepEqual(JSON.parse(unsupported.stdout).transportHookPoints, []);
  } finally {
    restoreHome();
  }
});

test("restore reports patched targets that have no recorded backup", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-restore-unrestored-"));
  const restoreHome = useHome(tmpRoot);
  const workbench = path.join(tmpRoot, "workbench.js");
  const extHost = path.join(tmpRoot, "extensionHostProcess.js");
  const staleHookBlock = `${PREVIOUS_START}globalThis.__cursorByokWrapTransport=function(){}${PREVIOUS_END}\n`;
  try {
    ensureConfigFiles();
    fs.writeFileSync(workbench, MODERN_TRANSPORT_SOURCE);
    fs.writeFileSync(extHost, staleHookBlock + "console.log('ext host runtime');");
    installWorkbenchHook({ workbench, extHost, allowPartial: true });

    const result = restoreWorkbenchHook({ workbench, extHost });

    assert.deepEqual(result.restoredFiles, [workbench]);
    assert.deepEqual(result.unrestoredPatchedTargets, [extHost]);
    assert.equal(fs.readFileSync(workbench, "utf8"), MODERN_TRANSPORT_SOURCE);
    assert.match(fs.readFileSync(extHost, "utf8"), /CURSOR-BYOK-HOOK-V2-START/);
  } finally {
    restoreHome();
  }
});

test("default redirect config keeps only BYOK auth and transport routing surface", () => {
  assert.equal(DEFAULT_REDIRECTS.includes("REST:/auth/full_stripe_profile"), true);
  assert.equal(DEFAULT_REDIRECTS.includes("REST:/auth/stripe_profile"), true);
  assert.equal(DEFAULT_REDIRECTS.includes("REST:/auth/has_valid_payment_method"), true);
  assert.equal(DEFAULT_REDIRECTS.includes("REST:/auth/poll"), true);
  assert.equal(DEFAULT_REDIRECTS.includes("REST:/auth/logout"), true);
  assert.equal(DEFAULT_REDIRECTS.includes("REST:/byok/checkpoint"), true);
  assert.equal(DEFAULT_REDIRECTS.includes("agent.v1.AgentService/RunSSE"), true);
  assert.equal(DEFAULT_REDIRECTS.includes("agent.v1.AgentService/Run"), true);
  assert.equal(DEFAULT_REDIRECTS.includes("aiserver.v1.BidiService/BidiAppend"), true);
  assert.equal(DEFAULT_REDIRECTS.includes("aiserver.v1.AiService/AvailableModels"), true);
  assert.equal(DEFAULT_REDIRECTS.includes("agent.v1.AgentService/UploadConversationBlobs"), false);
  assert.equal(DEFAULT_REDIRECTS.includes("aiserver.v1.DashboardService/GetCurrentPeriodUsage"), false);
});

test("workbench hook redirects default Cursor auth probes to the BYOK server", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const fetches = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      fetches.push({ url: String(url), init });
      return { ok: true, json: async () => ({ ok: true }), text: async () => "ok" };
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: DEFAULT_REDIRECTS.map((route) => route.replace(/^REST:/, "")),
    });

    await globalThis.fetch("https://api2.cursor.sh/auth/full_stripe_profile", { headers: { "x-test": "auth" } });
    assert.equal(fetches.at(-1).url, "http://127.0.0.1:9960/auth/full_stripe_profile");
    assert.equal(fetches.at(-1).init.headers["x-test"], "auth");

    await globalThis.fetch("https://api2.cursor.sh/byok/checkpoint", { method: "POST", headers: { "x-test": "checkpoint" } });
    assert.equal(fetches.at(-1).url, "http://127.0.0.1:9960/byok/checkpoint");
    assert.equal(fetches.at(-1).init.headers["x-test"], "checkpoint");

    await globalThis.fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
    assert.equal(fetches.at(-1).url, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
  }
});

test("fresh install config is created without overwriting existing providers or routes", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-config-"));
  const restoreHome = useHome(tmpRoot);
  try {
    ensureConfigFiles();
    assert.deepEqual(loadRoutes(), {
      schemaVersion: 1,
      byokMode: 1,
      server: { host: "127.0.0.1", port: 9960 },
      redirect: DEFAULT_REDIRECTS,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(providersPath(), "utf8")), {
      schemaVersion: 1,
      webFetch: { provider: "builtin" },
      webSearch: { provider: "exa" },
      providers: [],
    });
    assert.equal(fs.existsSync(path.join(configDir(), CATALOG_FILE)), true);

    const providers = { schemaVersion: 1, providers: [{ id: "keep", models: [{ id: "m" }] }] };
    const routes = { schemaVersion: 1, byokMode: 0, server: { host: "127.0.0.1", port: 1234 }, redirect: ["/auth/poll"] };
    writeJsonFile(providersPath(), providers);
    writeJsonFile(routesPath(), routes);
    ensureConfigFiles();
    assert.deepEqual(JSON.parse(fs.readFileSync(providersPath(), "utf8")), providers);
    assert.deepEqual(JSON.parse(fs.readFileSync(routesPath(), "utf8")), routes);
  } finally {
    restoreHome();
  }
});

test("ensureConfigFiles rewrites a legacy broad redirect config to auth plus transport defaults", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-routes-migrate-"));
  const restoreHome = useHome(tmpRoot);
  try {
    writeJsonFile(routesPath(), {
      schemaVersion: 1,
      byokMode: 1,
      server: { host: "127.0.0.1", port: 9960 },
      redirect: [...LEGACY_DEFAULT_REDIRECTS],
    });
    ensureConfigFiles();
    assert.deepEqual(loadRoutes(), {
      schemaVersion: 1,
      byokMode: 1,
      server: { host: "127.0.0.1", port: 9960 },
      redirect: DEFAULT_REDIRECTS,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(routesPath(), "utf8")), {
      schemaVersion: 1,
      byokMode: 1,
      server: { host: "127.0.0.1", port: 9960 },
      redirect: DEFAULT_REDIRECTS,
    });
  } finally {
    restoreHome();
  }
});

test("ensureConfigFiles rewrites the old transport-only redirect config to auth, checkpoint, and transport defaults", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-routes-transport-only-"));
  const restoreHome = useHome(tmpRoot);
  try {
    writeJsonFile(routesPath(), {
      schemaVersion: 1,
      byokMode: 1,
      server: { host: "127.0.0.1", port: 9960 },
      redirect: [
        "aiserver.v1.AiService/AvailableModels",
        "agent.v1.AgentService/RunSSE",
        "agent.v1.AgentService/Run",
        "aiserver.v1.BidiService/BidiAppend",
      ],
    });
    ensureConfigFiles();
    assert.deepEqual(loadRoutes(), {
      schemaVersion: 1,
      byokMode: 1,
      server: { host: "127.0.0.1", port: 9960 },
      redirect: DEFAULT_REDIRECTS,
    });
  } finally {
    restoreHome();
  }
});

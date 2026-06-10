"use strict";

const fs = require("node:fs");
const nodePath = require("node:path");

const { appendByokPromptRules, sanitizeProviderVisiblePromptText } = require("../runtime/prompt");
const { isInteractionBridgeTool, providerTextFromInteractionResponse } = require("../runtime/interaction-bridge");
const { coalesceStringAliases, providerTextFromClientCompletion } = require("../runtime/client-tool-bridge");
const { closeProviderObjectSchema, coerceProviderToolSchema, cursorBuiltinTool, defaultCursorBuiltinTools, patchProviderToolSchema, PROVIDER_TOOL_SCHEMA_ANNOTATION_KEYS } = require("../runtime/tools");
const { withOpenAiPromptCacheKey } = require("../runtime/cache");
const { isByokModel } = require("../runtime/models");
const { safeJson } = require("../log");

class ProviderAdapter {
  constructor({ providersConfigProvider, log }) {
    this.providersConfigProvider = providersConfigProvider;
    this.log = log;
  }

  async *run({ provider, model, request, requestId, waitForToolResult, signal }) {
    const providerType = provider.type || "openai-chat";
    const prompt = buildPrompt(request);
    const system = appendByokPromptRules(
      prompt.system,
      model.id,
      this.providersConfigProvider(),
      isByokModel,
      { composerMode: prompt.composerMode, workspaceRoots: prompt.workspaceRoots },
    );
    const tools = normalizeTools(prompt.tools, providerType);
    const toolDispatch = buildProviderToolDispatch(tools);
    const stopAfterCreatePlan = prompt.composerMode === "plan";
    this.log.info("BYOK run", {
      provider: provider.name,
      providerType,
      model: model.id || model.apiModel,
      toolCount: tools.length,
      requestId,
      composerMode: prompt.composerMode || undefined,
      readToolSchema: summarizeReadToolSchema(tools),
    });
    if (providerType === "anthropic") {
      yield* this.runAnthropic({
        provider,
        model,
        system,
        messages: prompt.messages,
        workspaceRoots: prompt.workspaceRoots,
        tools,
        stopAfterCreatePlan,
        toolDispatch,
        requestId,
        conversationId: prompt.conversationId,
        waitForToolResult,
        signal,
      });
      return;
    }
    if (providerType === "openai-responses") {
      yield* this.runOpenAiResponses({
        provider,
        model,
        system,
        messages: prompt.messages,
        workspaceRoots: prompt.workspaceRoots,
        tools,
        stopAfterCreatePlan,
        toolDispatch,
        requestId,
        conversationId: prompt.conversationId,
        waitForToolResult,
        signal,
      });
      return;
    }
    yield* this.runOpenAi({
      provider,
      model,
      system,
      messages: prompt.messages,
      workspaceRoots: prompt.workspaceRoots,
      tools,
      stopAfterCreatePlan,
      toolDispatch,
      requestId,
      conversationId: prompt.conversationId,
      waitForToolResult,
      signal,
    });
  }

  async *runOpenAi({ provider, model, system, messages, workspaceRoots, tools, stopAfterCreatePlan, toolDispatch, requestId, conversationId, waitForToolResult, signal }) {
    const client = buildOpenAiClient(provider);
    const ctx = { provider, model, requestId, conversationId, workspaceRoots };
    const providerMessages = [{ role: "system", content: system }, ...messages.flatMap(toOpenAiChatMessages)];
    const reusableArtifacts = [];
    appendInitialSyntheticOpenAiChatRepositoryHistory(providerMessages, reusableArtifacts, messages, workspaceRoots);
    for (;;) {
      const requestMessages = compactOpenAiChatProviderMessages(providerMessages);
      const request = withOpenAiPromptCacheKey({
        model: model.apiModel || model.id,
        messages: requestMessages,
        tools: tools.length
          ? tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            }))
          : undefined,
        stream: true,
        stream_options: { include_usage: true },
        parallel_tool_calls: true,
      }, conversationId);
      const imageStats = providerRequestImageStats(requestMessages);
      this.log.info("BYOK provider request", {
        provider: provider.name,
        providerType: provider.type,
        model: model.id || model.apiModel,
        requestId,
        conversationId,
        messageCount: requestMessages.length,
        historyChars: providerHistoryCharCount(requestMessages),
        ...imageStats,
        tailMessages: providerMessageDebugTail(requestMessages),
      });
      const toolUses = [];
      let assistantText = "";
      let pendingDoneEvent = null;
      for await (const event of streamOpenAiEvents(await client.chat.completions.create(request, signal ? { signal } : undefined))) {
        if (event.type === "tool_use_done") {
          const { input, prepared } = this.prepareAndLogToolUse(event, providerMessages, toolDispatch, ctx);
          toolUses.push({ ...event, input, ...prepared });
        } else if (event.type === "done" && event.stopReason === "tool_use") {
          pendingDoneEvent = event;
        } else if (event.type === "text_delta") {
          assistantText += event.text || "";
          yield event;
        } else {
          yield event;
        }
      }
      if (!toolUses.length) {
        if (pendingDoneEvent) yield pendingDoneEvent;
        return;
      }
      const resolutionPlan = planToolUseResolution(toolUses, "executionArguments", reusableArtifacts);
      const hasVisibleToolEvents = plannedToolRoundHasVisibleEvents(toolUses, resolutionPlan, "executionArguments");
      const deferPendingDoneUntilResolved = !!pendingDoneEvent && resolutionPlan.primaryToolUses.length === 0;
      yield* emitPlannedToolUseEvents(toolUses, resolutionPlan, "executionArguments");
      if (pendingDoneEvent && hasVisibleToolEvents && !deferPendingDoneUntilResolved) yield pendingDoneEvent;
      if (!toolUses.length) return;
      const assistantHistoryText = compactAssistantToolCallPreface(assistantText);
      providerMessages.push({
        role: "assistant",
        content: assistantHistoryText || null,
        tool_calls: toolUses.map(providerHistoryOpenAiChatToolCall),
      });
      const validToolResultById = await this.resolveToolResults(toolUses, waitForToolResult, "executionArguments", ctx, signal, resolutionPlan);
      if (!validToolResultById) return;
      yield* emitResolvedLocalToolUseEvents(toolUses, validToolResultById, resolutionPlan, "executionArguments");
      if (pendingDoneEvent && (!hasVisibleToolEvents || deferPendingDoneUntilResolved)) yield pendingDoneEvent;
      rememberReusableToolArtifacts(reusableArtifacts, toolUses, validToolResultById);
      if (stopAfterCreatePlan && shouldStopAfterSuccessfulCreatePlan(toolUses, validToolResultById)) {
        yield planModeDoneEvent(pendingDoneEvent?.usage);
        return;
      }
      for (let i = 0; i < toolUses.length; i++) {
        const toolUse = toolUses[i];
        providerMessages.push({
          role: "tool",
          tool_call_id: toolUse.id,
          content: toolUse.validationError?.message || stringifyToolResultForProvider(validToolResultById.get(toolUse.id), toolUse.executionName || toolUse.name),
        });
      }
      appendSyntheticOpenAiChatReadHistory(providerMessages, reusableArtifacts, toolUses, validToolResultById);
    }
  }

  async *runOpenAiResponses({ provider, model, system, messages, workspaceRoots, tools, stopAfterCreatePlan, toolDispatch, requestId, conversationId, waitForToolResult, signal }) {
    const client = buildOpenAiClient(provider);
    const ctx = { provider, model, requestId, conversationId, workspaceRoots };
    const input = [{ role: "system", content: system }, ...messages.flatMap(toResponsesInputItems)];
    const reusableArtifacts = [];
    for (;;) {
      const request = withOpenAiPromptCacheKey({
        model: model.apiModel || model.id,
        input,
        tools: tools.length
          ? tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            }))
          : undefined,
        stream: true,
        parallel_tool_calls: true,
      }, conversationId);
      const imageStats = providerRequestImageStats(input);
      this.log.info("BYOK provider request", {
        provider: provider.name,
        providerType: provider.type,
        model: model.id || model.apiModel,
        requestId,
        conversationId,
        inputCount: input.length,
        historyChars: providerHistoryCharCount(input),
        ...imageStats,
        tailMessages: providerMessageDebugTail(input),
      });
      const toolUses = [];
      const historyEntries = [];
      let pendingDoneEvent = null;
      for await (const event of streamOpenAiResponsesEvents(await client.responses.create(request, signal ? { signal } : undefined))) {
        if (event.type === "tool_use_done") {
          const { input: toolInput, prepared } = this.prepareAndLogToolUse(event, input, toolDispatch, ctx);
          const toolUse = { ...event, input: toolInput, ...prepared };
          toolUses.push(toolUse);
          historyEntries.push({ type: "tool_use", toolUse });
        } else if (event.type === "done" && event.stopReason === "tool_use") {
          pendingDoneEvent = event;
        } else if (event.type === "provider_history_item") {
          historyEntries.push({ type: "item", item: event.item });
        } else {
          yield event;
        }
      }
      if (!toolUses.length) {
        if (pendingDoneEvent) yield pendingDoneEvent;
        return;
      }
      const resolutionPlan = planToolUseResolution(toolUses, "executionArguments", reusableArtifacts);
      const hasVisibleToolEvents = plannedToolRoundHasVisibleEvents(toolUses, resolutionPlan, "executionArguments");
      const deferPendingDoneUntilResolved = !!pendingDoneEvent && resolutionPlan.primaryToolUses.length === 0;
      yield* emitPlannedToolUseEvents(toolUses, resolutionPlan, "executionArguments");
      if (pendingDoneEvent && hasVisibleToolEvents && !deferPendingDoneUntilResolved) yield pendingDoneEvent;
      const validToolResultById = await this.resolveToolResults(toolUses, waitForToolResult, "executionArguments", ctx, signal, resolutionPlan);
      if (!validToolResultById) return;
      yield* emitResolvedLocalToolUseEvents(toolUses, validToolResultById, resolutionPlan, "executionArguments");
      if (pendingDoneEvent && (!hasVisibleToolEvents || deferPendingDoneUntilResolved)) yield pendingDoneEvent;
      rememberReusableToolArtifacts(reusableArtifacts, toolUses, validToolResultById);
      if (stopAfterCreatePlan && shouldStopAfterSuccessfulCreatePlan(toolUses, validToolResultById)) {
        yield planModeDoneEvent(pendingDoneEvent?.usage);
        return;
      }
      for (const entry of historyEntries) {
        if (entry.type === "item") {
          input.push(entry.item);
          continue;
        }
        const toolUse = entry.toolUse;
        input.push(providerHistoryResponsesToolCall(toolUse));
        input.push(providerHistoryResponsesToolOutput(
          toolUse,
          toolUse.validationError?.message || stringifyToolResultForProvider(validToolResultById.get(toolUse.id), toolUse.executionName || toolUse.name),
        ));
      }
    }
  }

  async *runAnthropic({ provider, model, system, messages, workspaceRoots, tools, stopAfterCreatePlan, toolDispatch, requestId, conversationId, waitForToolResult, signal }) {
    const client = buildAnthropicClient(provider);
    const ctx = { provider, model, requestId, conversationId, workspaceRoots };
    const providerMessages = toAnthropicMessages(messages);
    const reusableArtifacts = [];
    for (;;) {
      const imageStats = providerRequestImageStats(providerMessages);
      this.log.info("BYOK provider request", {
        provider: provider.name,
        providerType: provider.type,
        model: model.id || model.apiModel,
        requestId,
        conversationId,
        messageCount: providerMessages.length,
        historyChars: system.length + providerHistoryCharCount(providerMessages),
        ...imageStats,
        tailMessages: providerMessageDebugTail(providerMessages),
      });
      const stream = await client.messages.stream({
        model: model.apiModel || model.id,
        system,
        messages: providerMessages,
        tools: tools.length
          ? tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            }))
          : undefined,
        max_tokens: model.maxOutputTokens || 8192,
      }, signal ? { signal } : undefined);
      const toolUses = [];
      const assistantHistoryContent = [];
      let text = "";
      let pendingDoneEvent = null;
      for await (const event of streamAnthropicEvents(stream)) {
        if (event.type === "text_delta") text += event.text || "";
        if (event.type === "tool_use_done") {
          const { input, prepared } = this.prepareAndLogToolUse(event, providerMessages, toolDispatch, ctx);
          const toolUse = { ...event, input, ...prepared };
          toolUses.push(toolUse);
          assistantHistoryContent.push({
            type: "tool_use",
            id: event.id,
            name: providerHistoryToolName(toolUse),
            input: providerHistoryAnthropicToolInput(toolUse),
          });
        } else if (event.type === "provider_history_item") {
          assistantHistoryContent.push(event.item);
        } else if (event.type === "done" && event.stopReason === "tool_use") {
          pendingDoneEvent = event;
        } else {
          yield event;
        }
      }
      if (!toolUses.length) {
        if (pendingDoneEvent) yield pendingDoneEvent;
        return;
      }
      const resolutionPlan = planToolUseResolution(toolUses, "executionInput", reusableArtifacts);
      const hasVisibleToolEvents = plannedToolRoundHasVisibleEvents(toolUses, resolutionPlan, "executionInput");
      const deferPendingDoneUntilResolved = !!pendingDoneEvent && resolutionPlan.primaryToolUses.length === 0;
      yield* emitPlannedToolUseEvents(toolUses, resolutionPlan, "executionInput");
      if (pendingDoneEvent && hasVisibleToolEvents && !deferPendingDoneUntilResolved) yield pendingDoneEvent;
      const historyText = compactAssistantToolCallPreface(text);
      if (historyText) assistantHistoryContent.unshift({ type: "text", text: historyText });
      providerMessages.push({ role: "assistant", content: assistantHistoryContent });
      const validToolResultById = await this.resolveToolResults(toolUses, waitForToolResult, "executionInput", ctx, signal, resolutionPlan);
      if (!validToolResultById) return;
      yield* emitResolvedLocalToolUseEvents(toolUses, validToolResultById, resolutionPlan, "executionInput");
      if (pendingDoneEvent && (!hasVisibleToolEvents || deferPendingDoneUntilResolved)) yield pendingDoneEvent;
      rememberReusableToolArtifacts(reusableArtifacts, toolUses, validToolResultById);
      if (stopAfterCreatePlan && shouldStopAfterSuccessfulCreatePlan(toolUses, validToolResultById)) {
        yield planModeDoneEvent(pendingDoneEvent?.usage);
        return;
      }
      providerMessages.push({
        role: "user",
        content: toolUses.map((toolUse) => ({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: toolUse.validationError?.message || stringifyToolResultForProvider(validToolResultById.get(toolUse.id), toolUse.executionName || toolUse.name),
        })),
      });
    }
  }

  // Normalize one tool_use_done event, prepare it for native Cursor execution,
  // and emit the BYOK diagnostic logs the UI-regression checks rely on. Shared by
  // all three provider loops; the caller decides what to yield and how to append
  // the result to its API-specific history.
  prepareAndLogToolUse(event, history, toolDispatch, ctx) {
    const input = normalizeToolInput(event.arguments);
    const prepared = isUnsupportedCustomProviderToolUse(event)
      ? unsupportedCustomProviderToolUse(event.name, input, event.arguments, event.providerToolType)
      : prepareProviderToolUse(event.name, input, event.arguments, history, toolDispatch, ctx.workspaceRoots);
    const base = {
      provider: ctx.provider.name,
      providerType: ctx.provider.type,
      model: ctx.model.id || ctx.model.apiModel,
      requestId: ctx.requestId,
      conversationId: ctx.conversationId,
    };
    this.log.info("BYOK tool call", {
      ...base,
      tool: event.name,
      executionTool: prepared.executionName !== event.name ? prepared.executionName : undefined,
      argumentKeys: toolArgumentKeys(input),
      readHasPath: isReadToolName(event.name) ? readArgumentHasPath(input) : undefined,
      readHasOffset: isReadToolName(event.name) ? readArgumentHasKey(input, "offset") : undefined,
      readHasLimit: isReadToolName(event.name) ? readArgumentHasKey(input, "limit") : undefined,
      rejected: !!prepared.validationError,
      repaired: prepared.repaired,
      executionArgumentKeys: prepared.repaired ? toolArgumentKeys(prepared.executionInput) : undefined,
      executionReadHasOffset: prepared.repaired ? readArgumentHasKey(prepared.executionInput, "offset") : undefined,
      executionReadHasLimit: prepared.repaired ? readArgumentHasKey(prepared.executionInput, "limit") : undefined,
    });
    if (prepared.validationError) {
      this.log.warn("BYOK rejected provider tool call", {
        ...base,
        tool: event.name,
        toolCallId: event.id,
        reason: prepared.validationError.reason,
      });
    } else if (prepared.repaired) {
      this.log.warn("BYOK rewrote provider tool call before Cursor execution", {
        ...base,
        tool: event.name,
        executionTool: prepared.executionName,
        toolCallId: event.id,
        argumentKeys: toolArgumentKeys(input),
        executionArgumentKeys: toolArgumentKeys(prepared.executionInput),
        readHasOffset: prepared.executionName === "Read" ? readArgumentHasKey(prepared.executionInput, "offset") : undefined,
        readHasLimit: prepared.executionName === "Read" ? readArgumentHasKey(prepared.executionInput, "limit") : undefined,
      });
    }
    return { input, prepared };
  }

  // Wait for each valid tool call's Cursor exec result and key the results by
  // tool-call id. Returns null to signal the loop to abort (valid tool calls but
  // no waiter). `toolArgsKey` selects which prepared field carries the execution
  // arguments: OpenAI/Responses use `executionArguments`, Anthropic `executionInput`.
  async resolveToolResults(toolUses, waitForToolResult, toolArgsKey, ctx = {}, signal = null, precomputedPlan = null) {
    const resolutionPlan = precomputedPlan || planToolUseResolution(toolUses, toolArgsKey);
    const validToolUses = resolutionPlan.validToolUses;
    if (validToolUses.length && typeof waitForToolResult !== "function") return null;
    const startedAt = Date.now();
    const canonicalToolById = resolutionPlan.canonicalToolById;
    const canonicalIdByToolId = resolutionPlan.canonicalIdByToolId;
    const derivedParentIdByCanonicalId = resolutionPlan.derivedParentIdByCanonicalId;
    const primaryToolUses = resolutionPlan.primaryToolUses;
    const primaryResults = await Promise.all(primaryToolUses.map((toolUse) =>
      waitForToolResultWithAbort(
        waitForToolResult,
        toolUse.id,
        { toolName: toolUse.executionName, toolArguments: toolUse[toolArgsKey] },
        signal,
      )
    ));
    const resultByCanonicalId = new Map([
      ...resolutionPlan.prefetchedResultByCanonicalId.entries(),
      ...primaryToolUses.map((toolUse, index) => [toolUse.id, primaryResults[index]]),
    ]);
    for (const toolUse of resolutionPlan.canonicalToolUses) {
      if (resultByCanonicalId.has(toolUse.id)) continue;
      const parentId = derivedParentIdByCanonicalId.get(toolUse.id);
      const parentToolUse = canonicalToolById.get(parentId);
      const parentResult = resultByCanonicalId.get(parentId);
      if (!parentToolUse || !parentResult) continue;
      let derivedResult = deriveToolResultFromParent(parentResult, parentToolUse, toolUse, toolArgsKey);
      if (!derivedResult) {
        derivedResult = await waitForToolResultWithAbort(
          waitForToolResult,
          toolUse.id,
          { toolName: toolUse.executionName, toolArguments: toolUse[toolArgsKey] },
          signal,
        );
      }
      resultByCanonicalId.set(toolUse.id, derivedResult);
    }
    const waitMs = Date.now() - startedAt;
    const dedupedToolCount = resolutionPlan.dedupedToolCount;
    const derivedToolCount = resolutionPlan.derivedToolCount;
    let providerTextChars = 0;
    const toolSummaries = validToolUses.map((toolUse) =>
      providerToolBatchLogSummary(
        toolUse,
        resolutionPlan,
        toolArgsKey,
        resultByCanonicalId.get(canonicalIdByToolId.get(toolUse.id)),
      ));
    for (const toolUse of validToolUses) {
      const toolResult = resultByCanonicalId.get(canonicalIdByToolId.get(toolUse.id));
      providerTextChars += stringifyToolResultForProvider(toolResult, toolUse.executionName || toolUse.name).length;
      if (toolUse.executionName !== "Shell" && toolUse.executionName !== "AwaitShell") continue;
      const providerText = stringifyToolResultForProvider(toolResult, toolUse.executionName || toolUse.name);
      this.log.info("BYOK provider-visible tool result", {
        provider: ctx.provider?.name,
        providerType: ctx.provider?.type,
        model: ctx.model?.id || ctx.model?.apiModel,
        requestId: ctx.requestId,
        conversationId: ctx.conversationId,
        tool: toolUse.executionName,
        toolCallId: toolUse.id,
        shellId: stringOrEmpty(toolResult?.message?.value?.result?.value?.shellId || toolResult?.message?.value?.result?.value?.shell_id) || undefined,
        taskId: stringOrEmpty(toolResult?.message?.value?.result?.value?.taskId || toolResult?.message?.value?.result?.value?.task_id) || undefined,
        msToWait: Number.isFinite(toolResult?.message?.value?.result?.value?.msToWait)
          ? toolResult.message.value.result.value.msToWait
          : undefined,
        providerTextHasShellId: providerText.includes("shell_id"),
        providerTextPreview: providerText.slice(0, 240),
      });
    }
    this.log.info("BYOK provider tool batch resolved", {
      provider: ctx.provider?.name,
      providerType: ctx.provider?.type,
      model: ctx.model?.id || ctx.model?.apiModel,
      requestId: ctx.requestId,
      conversationId: ctx.conversationId,
      toolCount: validToolUses.length,
      tools: validToolUses.map((toolUse) => toolUse.executionName),
      toolSummaries,
      dedupedToolCount: dedupedToolCount || undefined,
      derivedToolCount: derivedToolCount || undefined,
      waitMs,
      providerTextChars,
    });
    return new Map(validToolUses.map((toolUse) => [toolUse.id, resultByCanonicalId.get(canonicalIdByToolId.get(toolUse.id))]));
  }
}

function waitForToolResultWithAbort(waitForToolResult, toolCallId, options, signal) {
  const wait = Promise.resolve(waitForToolResult(toolCallId, options));
  if (!signal) return wait;
  if (signal.aborted) return Promise.reject(abortErrorFromSignal(signal));
  return Promise.race([
    wait,
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(abortErrorFromSignal(signal)), { once: true });
    }),
  ]);
}

function abortErrorFromSignal(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" && reason ? reason : "aborted");
  error.name = "AbortError";
  return error;
}

function compactAssistantToolCallPreface(text) {
  const trimmed = stringOrEmpty(text).trim();
  if (!trimmed) return "";
  if (assistantPrefaceLooksTrivial(trimmed)) return "";
  if (assistantPrefaceShouldKeep(trimmed)) return trimmed;
  return trimmed;
}

function assistantPrefaceShouldKeep(text) {
  if (text.length > 280) return true;
  if (/```/.test(text)) return true;
  if (/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/.test(text)) return true;
  if (/\bline\s+\d+\b/i.test(text)) return true;
  if (/`[^`]+`/.test(text)) return true;
  return false;
}

function assistantPrefaceLooksTrivial(text) {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;
  if (/^(let me|now let me|i(?:'|’)ll|i will|i’m|im|i am)\b/.test(normalized)) return true;
  if (/^(i found|now i have|i have)\b.*\b(let me|i(?:'|’)ll|i will)\b/.test(normalized)) return true;
  if (/^(here(?:'|’)s|here is)\b.*\b(explanation|answer)\b/.test(normalized)) return true;
  return false;
}

function providerHistoryCharCount(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + providerHistoryCharCount(item), 0);
  if (!value || typeof value !== "object") return 0;
  let total = 0;
  for (const child of Object.values(value)) total += providerHistoryCharCount(child);
  return total;
}

function providerMessagePreviewText(value, limit = 80) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}...` : value;
  if (Array.isArray(value)) return value.map((item) => providerMessagePreviewText(item, limit)).filter(Boolean).join(" | ");
  if (!value || typeof value !== "object") return String(value);
  if (typeof value.text === "string" && value.text) return providerMessagePreviewText(value.text, limit);
  if (value.content !== undefined) {
    const contentText = providerMessagePreviewText(value.content, limit);
    if (contentText) return contentText;
  }
  if (value.value !== undefined) {
    const valueText = providerMessagePreviewText(value.value, limit);
    if (valueText) return valueText;
  }
  if (value.message !== undefined) {
    const messageText = providerMessagePreviewText(value.message, limit);
    if (messageText) return messageText;
  }
  return "";
}

function providerMessageDebugTail(messages, count = 6) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  return messages.slice(-count).map((message) => ({
    role: typeof message?.role === "string" ? message.role : typeof message?.type === "string" ? message.type : "",
    preview: providerMessagePreviewText(message?.content ?? message?.text ?? message),
  }));
}

function providerRequestImageStats(messages) {
  const stats = {
    imageBlockCount: 0,
    userImageBlockCount: 0,
    assistantImageBlockCount: 0,
    latestUserImageBlockCount: 0,
  };
  if (!Array.isArray(messages)) return stats;
  for (const message of messages) {
    const role = providerMessageRoleForStats(message);
    const imageCount = providerMessageImageBlockCount(message);
    stats.imageBlockCount += imageCount;
    if (role === "assistant") {
      stats.assistantImageBlockCount += imageCount;
      continue;
    }
    if (role === "user") {
      stats.userImageBlockCount += imageCount;
      stats.latestUserImageBlockCount = imageCount;
    }
  }
  return stats;
}

function providerMessageRoleForStats(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.role === "string" && message.role) return message.role;
  if (message.type === "message" && typeof message.role === "string" && message.role) return message.role;
  return typeof message.type === "string" ? message.type : "";
}

function providerMessageImageBlockCount(message) {
  if (!message || typeof message !== "object") return 0;
  const content = message.content;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (isProviderImageBlockForStats(block)) total += 1;
  }
  return total;
}

function isProviderImageBlockForStats(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  return block.type === "image" || block.type === "image_url" || block.type === "input_image";
}

function compactOpenAiChatProviderMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const compacted = new Array(messages.length);
  const laterReadWindowsByPath = new Map();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "tool" || typeof message.content !== "string") {
      compacted[index] = message;
      continue;
    }
    const readWindow = parseReadHistoryWindow(message.content);
    if (readWindow) {
      const laterWindows = laterReadWindowsByPath.get(readWindow.path) || [];
      const covered = laterWindows.some((window) => readHistoryWindowContains(window, readWindow));
      const summary = parseReadHistorySummaryLines(message.content);
      const canCompactAsOlderSameFileRead = laterWindows.length >= 3 && summary.length > 0;
      compacted[index] = covered
        ? { ...message, content: compactReadHistoryText(readWindow, summary, "[covered by later Read]") }
        : canCompactAsOlderSameFileRead
          ? { ...message, content: compactReadHistoryText(readWindow, summary, "[older same-file Read compacted after newer Reads]") }
          : message;
      laterWindows.push(readWindow);
      laterReadWindowsByPath.set(readWindow.path, laterWindows);
      continue;
    }
    const grepPaths = parseGrepHistoryPaths(message.content);
    if (grepPaths.some((path) => laterReadWindowsByPath.has(path))) {
      compacted[index] = { ...message, content: compactGrepHistoryText(message.content) };
      continue;
    }
    compacted[index] = message;
  }
  return compacted;
}

function parseReadHistoryWindow(text) {
  const match = String(text || "").match(/^File: ([^\n]+)\nLines: (\d+)-(\d+)/);
  if (!match) return null;
  const startLine = normalizeInteger(match[2]);
  const endLine = normalizeInteger(match[3]);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || endLine < startLine) return null;
  return { path: match[1], startLine, endLine };
}

function readHistoryWindowContains(parent, child) {
  if (!parent || !child || parent.path !== child.path) return false;
  const contains = parent.startLine <= child.startLine && parent.endLine >= child.endLine;
  const strictlyLarger = parent.startLine < child.startLine || parent.endLine > child.endLine;
  return contains && strictlyLarger;
}

function parseGrepHistoryPaths(text) {
  const paths = new Set();
  for (const match of String(text || "").matchAll(/resolved path ([^;\n]+)/g)) {
    if (match[1]) paths.add(match[1]);
  }
  for (const match of String(text || "").matchAll(/path=([^\s;]+)/g)) {
    if (match[1]) paths.add(match[1]);
  }
  return [...paths];
}

function compactGrepHistoryText(text) {
  const source = String(text || "");
  const firstLine = source.split("\n").find((line) => line.trim());
  return firstLine || source;
}

function parseReadHistorySummaryLines(text) {
  const lines = String(text || "").split("\n");
  const summary = [];
  for (let index = 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\d+\|/.test(line)) break;
    if (!line) continue;
    summary.push(line);
  }
  return summary;
}

function compactReadHistoryText(readWindow, summaryLines, notice) {
  return [
    `File: ${readWindow.path}`,
    `Lines: ${readWindow.startLine}-${readWindow.endLine}`,
    ...summaryLines,
    notice,
  ].join("\n");
}

function dedupeableToolUseKey(toolUse, toolArgsKey) {
  if (!DEDUPABLE_EXECUTION_TOOL_NAMES.has(toolUse?.executionName)) return "";
  return `${toolUse.executionName}\n${JSON.stringify(canonicalProviderToolArgs(dedupeableToolUseArgs(toolUse, toolArgsKey)))}`;
}

function dedupeableToolUseArgs(toolUse, toolArgsKey) {
  const executionInput = normalizeToolInput(toolUse?.executionInput);
  if (executionInput !== undefined && executionInput !== null) return executionInput;
  return normalizeToolInput(toolUse?.[toolArgsKey]);
}

function canonicalProviderToolArgs(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalProviderToolArgs(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalProviderToolArgs(value[key]);
    return out;
  }
  return value;
}

function providerToolBatchLogSummary(toolUse, resolutionPlan, toolArgsKey, toolResult) {
  const canonicalId = resolutionPlan?.canonicalIdByToolId?.get(toolUse?.id) || toolUse?.id;
  const args = canonicalProviderToolArgs(dedupeableToolUseArgs(toolUse, toolArgsKey));
  const outputMode = normalizedGrepOutputMode(args);
  const resolution = toolUse?.validationError
    ? "validation_error"
    : canonicalId !== toolUse?.id
      ? "deduped"
      : resolutionPlan?.prefetchedResultByCanonicalId?.has(canonicalId)
        ? "prefetched"
        : resolutionPlan?.derivedParentIdByCanonicalId?.has(canonicalId)
          ? "derived"
          : "primary";
  const summary = {
    tool: toolUse?.executionName || toolUse?.name || "",
    toolCallId: toolUse?.id,
    canonicalToolCallId: canonicalId,
    resolution,
    reuseReason: resolutionPlan?.reuseDiagnosticByCanonicalId?.get(canonicalId),
    dedupedToToolCallId: canonicalId !== toolUse?.id ? canonicalId : undefined,
    derivedFromToolCallId: resolutionPlan?.derivedParentIdByCanonicalId?.get(canonicalId),
    prefetched: resolutionPlan?.prefetchedResultByCanonicalId?.has(canonicalId) || undefined,
    visible: plannedToolUseSummaryVisible(toolUse, resolutionPlan, toolArgsKey),
  };
  if (typeof args?.path === "string" && args.path) summary.path = args.path;
  if (typeof args?.pattern === "string" && args.pattern) summary.pattern = args.pattern;
  if (typeof args?.glob === "string" && args.glob) summary.glob = args.glob;
  if (outputMode) summary.outputMode = outputMode;
  const offset = normalizeInteger(args?.offset);
  const limit = normalizeInteger(args?.limit);
  if (offset !== undefined) summary.offset = offset;
  if (limit !== undefined) summary.limit = limit;
  const argKeys = toolArgumentKeys(args);
  if (!summary.path && !summary.pattern && !summary.glob && argKeys.length) summary.argKeys = argKeys;
  if (toolResult) summary.providerTextPreview = stringifyToolResultForProvider(toolResult, toolUse?.executionName || toolUse?.name).slice(0, 320);
  return summary;
}

function plannedToolUseSummaryVisible(toolUse, resolutionPlan, toolArgsKey) {
  return plannedToolUseVisibleBeforeResolve(toolUse, resolutionPlan, toolArgsKey);
}

function planToolUseResolution(toolUses, toolArgsKey, reusableArtifacts = []) {
  const validToolUses = toolUses.filter((toolUse) => !toolUse.validationError);
  const primaryByKey = new Map();
  const canonicalIdByToolId = new Map();
  const canonicalToolUses = [];
  for (const toolUse of validToolUses) {
    const dedupeKey = dedupeableToolUseKey(toolUse, toolArgsKey);
    if (dedupeKey && primaryByKey.has(dedupeKey)) {
      canonicalIdByToolId.set(toolUse.id, primaryByKey.get(dedupeKey).id);
      continue;
    }
    canonicalToolUses.push(toolUse);
    canonicalIdByToolId.set(toolUse.id, toolUse.id);
    if (dedupeKey) primaryByKey.set(dedupeKey, toolUse);
  }
  const canonicalToolById = new Map(canonicalToolUses.map((toolUse) => [toolUse.id, toolUse]));
  const prefetchedResultByCanonicalId = new Map();
  const prefetchedArtifactByCanonicalId = new Map();
  for (const toolUse of canonicalToolUses) {
    const reusable = findReusableToolArtifact(reusableArtifacts, toolUse, toolArgsKey);
    if (reusable) {
      prefetchedResultByCanonicalId.set(toolUse.id, reusable.result);
      prefetchedArtifactByCanonicalId.set(toolUse.id, reusable.artifact);
    }
  }
  const derivedParentIdByCanonicalId = new Map();
  for (const toolUse of canonicalToolUses) {
    if (prefetchedResultByCanonicalId.has(toolUse.id)) continue;
    const derivedParent = findDerivedToolUseParent(canonicalToolUses, toolUse, toolArgsKey);
    if (derivedParent) derivedParentIdByCanonicalId.set(toolUse.id, derivedParent.id);
  }
  const reuseDiagnosticByCanonicalId = new Map();
  for (const toolUse of canonicalToolUses) {
    if (prefetchedArtifactByCanonicalId.has(toolUse.id)) {
      const parentTool = prefetchedArtifactByCanonicalId.get(toolUse.id)?.toolUse;
      reuseDiagnosticByCanonicalId.set(toolUse.id, `prefetched-from-${stringOrEmpty(parentTool?.executionName || parentTool?.name).toLowerCase() || "artifact"}`);
      continue;
    }
    const derivedParentId = derivedParentIdByCanonicalId.get(toolUse.id);
    if (derivedParentId) {
      const parentTool = canonicalToolById.get(derivedParentId);
      reuseDiagnosticByCanonicalId.set(toolUse.id, `derived-from-${stringOrEmpty(parentTool?.executionName || parentTool?.name).toLowerCase() || "tool"}`);
      continue;
    }
    const missReason = reusableArtifactMissReason(reusableArtifacts, toolUse, toolArgsKey);
    if (missReason) reuseDiagnosticByCanonicalId.set(toolUse.id, missReason);
  }
  const primaryToolUses = canonicalToolUses.filter((toolUse) =>
    !derivedParentIdByCanonicalId.has(toolUse.id) && !prefetchedResultByCanonicalId.has(toolUse.id));
  return {
    validToolUses,
    canonicalIdByToolId,
    canonicalToolUses,
    canonicalToolById,
    prefetchedResultByCanonicalId,
    prefetchedArtifactByCanonicalId,
    derivedParentIdByCanonicalId,
    reuseDiagnosticByCanonicalId,
    primaryToolUses,
    dedupedToolCount: validToolUses.length - canonicalToolUses.length,
    derivedToolCount: prefetchedResultByCanonicalId.size + (canonicalToolUses.length - primaryToolUses.length - prefetchedResultByCanonicalId.size),
  };
}

function plannedToolUseLocalResult(toolUse, resolutionPlan, toolArgsKey) {
  if (!toolUse || toolUse.validationError) return null;
  const canonicalId = resolutionPlan?.canonicalIdByToolId?.get(toolUse.id) || toolUse.id;
  const canonicalToolUse = resolutionPlan?.canonicalToolById?.get(canonicalId) || toolUse;
  const exactPrefetchedResult = resolutionPlan?.prefetchedResultByCanonicalId?.get(toolUse.id);
  if (exactPrefetchedResult) return exactPrefetchedResult;
  const canonicalPrefetchedResult = resolutionPlan?.prefetchedResultByCanonicalId?.get(canonicalId);
  if (canonicalPrefetchedResult && canonicalId !== toolUse.id) return canonicalPrefetchedResult;
  const derivedParentId = resolutionPlan?.derivedParentIdByCanonicalId?.get(toolUse.id);
  if (!derivedParentId) return null;
  const parentToolUse = resolutionPlan?.canonicalToolById?.get(derivedParentId);
  const parentResult = resolutionPlan?.prefetchedResultByCanonicalId?.get(derivedParentId);
  if (!parentToolUse || !parentResult) return null;
  return deriveToolResultFromParent(parentResult, parentToolUse, toolUse, toolArgsKey);
}

function plannedToolUseVisibleBeforeResolve(toolUse, resolutionPlan, toolArgsKey) {
  if (!toolUse || toolUse.validationError) return true;
  if (plannedToolUseLocalResult(toolUse, resolutionPlan, toolArgsKey)) return true;
  const canonicalId = resolutionPlan?.canonicalIdByToolId?.get(toolUse.id);
  if (canonicalId !== toolUse.id) return false;
  if (resolutionPlan?.prefetchedResultByCanonicalId?.has(toolUse.id)) return false;
  if (resolutionPlan?.derivedParentIdByCanonicalId?.has(toolUse.id)) return false;
  return true;
}

function *emitPlannedToolUseEvents(toolUses, resolutionPlan, toolArgsKey) {
  for (const toolUse of toolUses) {
    if (toolUse.validationError) {
      yield localToolErrorEvent(toolUse, toolUse);
      continue;
    }
    const localToolResult = plannedToolUseLocalResult(toolUse, resolutionPlan, toolArgsKey);
    if (localToolResult) {
      yield providerLocalToolResultEvent(toolUse, toolUse, localToolResult);
      continue;
    }
    const canonicalId = resolutionPlan.canonicalIdByToolId.get(toolUse.id);
    if (canonicalId !== toolUse.id) continue;
    if (resolutionPlan.prefetchedResultByCanonicalId.has(toolUse.id)) continue;
    if (resolutionPlan.derivedParentIdByCanonicalId.has(toolUse.id)) continue;
    yield executableToolEvent(toolUse, toolUse);
  }
}

function *emitResolvedLocalToolUseEvents(toolUses, resultById, resolutionPlan, toolArgsKey) {
  if (!(resultById instanceof Map)) return;
  for (const toolUse of toolUses) {
    if (!toolUse || toolUse.validationError) continue;
    if (plannedToolUseVisibleBeforeResolve(toolUse, resolutionPlan, toolArgsKey)) continue;
    const toolResult = resultById.get(toolUse.id);
    if (!toolResult) continue;
    yield providerLocalToolResultEvent(toolUse, toolUse, toolResult);
  }
}

function plannedToolRoundHasVisibleEvents(toolUses, resolutionPlan, toolArgsKey) {
  for (const toolUse of toolUses) {
    if (plannedToolUseVisibleBeforeResolve(toolUse, resolutionPlan, toolArgsKey)) return true;
  }
  return false;
}

function rememberReusableToolArtifacts(store, toolUses, resultById) {
  if (!Array.isArray(store)) return;
  for (const toolUse of toolUses) {
    if (toolUse?.validationError) continue;
    const toolResult = resultById.get(toolUse.id);
    if (!toolResult) continue;
    if (toolUse.executionName !== "Read" && toolUse.executionName !== "Grep") continue;
    store.push({ toolUse, toolResult });
  }
  if (store.length > 64) store.splice(0, store.length - 64);
}

function appendSyntheticOpenAiChatReadHistory(providerMessages, reusableArtifacts, toolUses, resultById) {
  if (!Array.isArray(providerMessages) || !Array.isArray(reusableArtifacts) || !(resultById instanceof Map)) return;
  if (!Array.isArray(toolUses) || !toolUses.length) return;
  if (toolUses.some((toolUse) => toolUse?.executionName === "Read")) return;
  const syntheticToolUses = [];
  const syntheticResults = new Map();
  const seen = new Set();
  for (const toolUse of toolUses) {
    if (toolUse?.validationError || toolUse?.executionName !== "Grep") continue;
    const toolResult = resultById.get(toolUse.id);
    if (!toolResult) continue;
    for (const readArgs of syntheticReadArgsFromGrepToolResult(toolUse, toolResult)) {
      const key = JSON.stringify(canonicalProviderToolArgs(readArgs));
      if (seen.has(key)) continue;
      seen.add(key);
      const syntheticToolUse = syntheticOpenAiChatReadToolUse(toolUse, readArgs, syntheticToolUses.length);
      const syntheticResult = deriveReadToolResultFromReusableGrep(toolUse, toolResult, syntheticToolUse, "executionArguments");
      if (!syntheticResult) continue;
      syntheticToolUses.push(syntheticToolUse);
      syntheticResults.set(syntheticToolUse.id, syntheticResult);
      if (syntheticToolUses.length >= 4) break;
    }
    if (syntheticToolUses.length >= 4) break;
  }
  const primarySyntheticCount = syntheticToolUses.length;
  for (let index = 0; index < primarySyntheticCount; index += 1) {
    const syntheticToolUse = syntheticToolUses[index];
    const syntheticResult = syntheticResults.get(syntheticToolUse.id);
    for (const readArgs of syntheticTopLevelSymbolReadArgsFromReadResult(syntheticResult)) {
      const key = JSON.stringify(canonicalProviderToolArgs(readArgs));
      if (seen.has(key)) continue;
      seen.add(key);
      const followupToolUse = syntheticOpenAiChatReadToolUse(syntheticToolUse, readArgs, syntheticToolUses.length);
      const followupResult = deriveReadToolResultFromReusableRead(syntheticToolUse, syntheticResult, followupToolUse, "executionArguments");
      if (!followupResult) continue;
      syntheticToolUses.push(followupToolUse);
      syntheticResults.set(followupToolUse.id, followupResult);
      if (syntheticToolUses.length >= 6) break;
    }
    if (syntheticToolUses.length >= 6) break;
  }
  const compactedSynthetic = compactSyntheticReadArtifacts(syntheticToolUses, syntheticResults);
  syntheticToolUses.length = 0;
  syntheticToolUses.push(...compactedSynthetic.toolUses);
  syntheticResults.clear();
  for (const [toolCallId, toolResult] of compactedSynthetic.results) syntheticResults.set(toolCallId, toolResult);
  if (!syntheticToolUses.length) return;
  providerMessages.push({
    role: "assistant",
    content: null,
    tool_calls: syntheticToolUses.map(providerHistoryOpenAiChatToolCall),
  });
  for (const syntheticToolUse of syntheticToolUses) {
    providerMessages.push({
      role: "tool",
      tool_call_id: syntheticToolUse.id,
      content: stringifyToolResultForProvider(syntheticResults.get(syntheticToolUse.id), syntheticToolUse.executionName || syntheticToolUse.name),
    });
  }
  rememberReusableToolArtifacts(reusableArtifacts, syntheticToolUses, syntheticResults);
}

function appendInitialSyntheticOpenAiChatRepositoryHistory(providerMessages, reusableArtifacts, messages, workspaceRoots) {
  if (!Array.isArray(providerMessages) || providerMessages.length !== 2) return;
  if (!Array.isArray(messages) || messages.length !== 1) return;
  const initialSynthetic = initialSyntheticGrepArtifactsForMessages(messages, workspaceRoots);
  if (!initialSynthetic.toolUses.length) return;
  providerMessages.push({
    role: "assistant",
    content: null,
    tool_calls: initialSynthetic.toolUses.map(providerHistoryOpenAiChatToolCall),
  });
  for (const toolUse of initialSynthetic.toolUses) {
    providerMessages.push({
      role: "tool",
      tool_call_id: toolUse.id,
      content: stringifyToolResultForProvider(initialSynthetic.results.get(toolUse.id), toolUse.executionName || toolUse.name),
    });
  }
  rememberReusableToolArtifacts(reusableArtifacts, initialSynthetic.toolUses, initialSynthetic.results);
  appendSyntheticOpenAiChatReadHistory(providerMessages, reusableArtifacts, initialSynthetic.toolUses, initialSynthetic.results);
}

function initialSyntheticGrepArtifactsForMessages(messages, workspaceRoots) {
  const text = latestUserTextFromMessages(messages);
  if (!text) return { toolUses: [], results: new Map() };
  const filePaths = explicitPromptFilePaths(text, workspaceRoots);
  const symbols = promptPrefetchSymbolCandidates(text);
  if (!symbols.length) return { toolUses: [], results: new Map() };
  if (!filePaths.length) return workspaceRootSyntheticGrepArtifacts(workspaceRoots, symbols);
  if (filePaths.length > 3) return { toolUses: [], results: new Map() };
  const toolUses = [];
  const results = new Map();
  for (const filePath of filePaths) {
    const fileLines = readGrepSummaryFileLines(filePath);
    if (!fileLines.length) continue;
    const workspaceRoot = owningWorkspaceRoot(filePath, workspaceRoots);
    if (!workspaceRoot) continue;
    const selectedSymbols = [];
    const matchesByLine = new Map();
    for (const symbol of symbols) {
      const matches = literalSymbolMatchesInFile(fileLines, symbol);
      if (!matches.length) continue;
      selectedSymbols.push(symbol);
      for (const match of matches) {
        if (!matchesByLine.has(match.lineNumber)) matchesByLine.set(match.lineNumber, match);
      }
      if (selectedSymbols.length >= 2) break;
    }
    if (!selectedSymbols.length || !matchesByLine.size) continue;
    const toolUse = syntheticOpenAiChatGrepToolUse(filePath, selectedSymbols, toolUses.length);
    const relativeFile = nodePath.relative(workspaceRoot, filePath) || nodePath.basename(filePath);
    const toolResult = {
      execId: toolUse.id,
      _byokDerivedTool: true,
      message: {
        case: "grepResult",
        value: {
          result: {
            case: "success",
            value: {
              pattern: selectedSymbols.join("|"),
              outputMode: "content",
              workspaceResults: {
                [workspaceRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: relativeFile.replace(/\\/g, "/"),
                        matches: [...matchesByLine.values()].sort((left, right) => left.lineNumber - right.lineNumber),
                      }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    toolUses.push(toolUse);
    results.set(toolUse.id, toolResult);
  }
  return { toolUses, results };
}

function workspaceRootSyntheticGrepArtifacts(workspaceRoots, symbols) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots.filter((root) => typeof root === "string" && root) : [];
  if (roots.length !== 1) return { toolUses: [], results: new Map() };
  const workspaceRoot = nodePath.resolve(roots[0]);
  const selectedSymbols = symbols.slice(0, 2);
  if (!selectedSymbols.length) return { toolUses: [], results: new Map() };
  let stdout = "";
  try {
    stdout = require("node:child_process").execFileSync("rg", [
      "--json",
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      selectedSymbols.map((symbol) => escapeRegExp(symbol)).join("|"),
      workspaceRoot,
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error?.status !== 1) return { toolUses: [], results: new Map() };
  }
  const entries = stdout ? stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
  const fileMap = new Map();
  for (const entry of entries) {
    if (entry?.type !== "match" && entry?.type !== "context") continue;
    const file = stringOrEmpty(entry?.data?.path?.text);
    const lineNumber = normalizeInteger(entry?.data?.line_number);
    const content = stringOrEmpty(entry?.data?.lines?.text).replace(/\n$/, "");
    if (!file || !Number.isInteger(lineNumber)) continue;
    const relative = nodePath.isAbsolute(file) ? nodePath.relative(workspaceRoot, file) || nodePath.basename(file) : file;
    if (!fileMap.has(relative)) fileMap.set(relative, []);
    fileMap.get(relative).push({ lineNumber, content });
  }
  if (!fileMap.size || fileMap.size > 6) return { toolUses: [], results: new Map() };
  const fileMatches = orderGrepFileMatchesForProvider(
    [...fileMap.entries()].map(([file, matches]) => ({ file: file.replace(/\\/g, "/"), matches })),
    selectedSymbols.join("|"),
  ).slice(0, 2);
  const toolUses = [];
  const results = new Map();
  for (let index = 0; index < fileMatches.length; index += 1) {
    const fileMatch = fileMatches[index];
    const resolvedPath = resolveGrepSummaryFilePath(workspaceRoot, fileMatch.file);
    if (!resolvedPath) continue;
    const fileSymbols = matchingSymbolsForFileMatch(fileMatch, selectedSymbols);
    if (!fileSymbols.length) continue;
    const toolUse = syntheticOpenAiChatGrepToolUse(resolvedPath, fileSymbols, index);
    const result = {
      execId: toolUse.id,
      _byokDerivedTool: true,
      message: {
        case: "grepResult",
        value: {
          result: {
            case: "success",
            value: {
              pattern: fileSymbols.join("|"),
              outputMode: "content",
              workspaceResults: {
                [workspaceRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [fileMatch],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    toolUses.push(toolUse);
    results.set(toolUse.id, result);
  }
  return {
    toolUses,
    results,
  };
}

function matchingSymbolsForFileMatch(fileMatch, symbols) {
  const candidates = Array.isArray(symbols) ? symbols.filter((symbol) => typeof symbol === "string" && symbol) : [];
  if (!candidates.length) return [];
  const lines = arrayField(fileMatch, "matches").map((match) => stringField(match, "content"));
  const matched = candidates.filter((symbol) => lines.some((line) => line.includes(symbol)));
  return matched.length ? matched : candidates;
}

function latestUserTextFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role !== "user") continue;
    const text = providerTextFromMessageContent(message.content ?? "");
    if (text) return text;
  }
  return "";
}

function explicitPromptFilePaths(text, workspaceRoots) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots.filter((root) => typeof root === "string" && root) : [];
  if (!roots.length) return [];
  const candidates = new Set();
  const source = String(text || "");
  for (const rawToken of source.split(/\s+/)) {
    const token = rawToken.replace(/^[`("'[{<]+|[`"',.;:!?)}\]>]+$/g, "");
    if (!token || !/[\\/]/.test(token) || !/\.[A-Za-z0-9_+-]+$/.test(token)) continue;
    for (const root of roots) {
      const resolved = resolvePromptFilePathToken(token, root);
      if (resolved) candidates.add(resolved);
    }
  }
  return [...candidates].slice(0, 3);
}

function resolvePromptFilePathToken(token, workspaceRoot) {
  const root = nodePath.resolve(workspaceRoot);
  const candidate = nodePath.isAbsolute(token) ? nodePath.resolve(token) : nodePath.resolve(root, token);
  if (!fs.existsSync(candidate)) return "";
  if (!pathIsWithinRoot(candidate, root)) return "";
  try {
    return fs.statSync(candidate).isFile() ? candidate : "";
  } catch {
    return "";
  }
}

function pathIsWithinRoot(candidatePath, rootPath) {
  const relative = nodePath.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

function promptPrefetchSymbolCandidates(text) {
  const candidates = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(/\b[A-Za-z_][A-Za-z0-9_.]*\b/g)) {
    const raw = String(match[0] || "");
    if (!raw || raw.includes("/") || /\.[A-Za-z0-9_+-]+$/.test(raw)) continue;
    const token = raw.includes(".") ? raw.split(".").pop() : raw;
    if (!token || token.length < 10 || !/[A-Z0-9_]/.test(token) || GREP_PATTERN_STOP_WORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    candidates.push(token);
    if (candidates.length >= 6) break;
  }
  return candidates;
}

function literalSymbolMatchesInFile(fileLines, symbol) {
  const matches = [];
  for (let index = 0; index < fileLines.length; index += 1) {
    const content = String(fileLines[index] || "");
    if (!content.includes(symbol)) continue;
    matches.push({ lineNumber: index + 1, content });
    if (matches.length >= 12) break;
  }
  return matches;
}

function owningWorkspaceRoot(filePath, workspaceRoots) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots.filter((root) => typeof root === "string" && root) : [];
  let best = "";
  for (const root of roots) {
    const resolvedRoot = nodePath.resolve(root);
    if (!pathIsWithinRoot(filePath, resolvedRoot)) continue;
    if (resolvedRoot.length > best.length) best = resolvedRoot;
  }
  return best;
}

function syntheticOpenAiChatGrepToolUse(filePath, symbols, index) {
  const executionArguments = JSON.stringify({
    path: filePath,
    pattern: symbols.join("|"),
    output_mode: "content",
  });
  return {
    id: `prefetch-grep-${index}`,
    name: "Grep",
    executionName: "Grep",
    arguments: executionArguments,
    executionArguments,
    input: normalizeToolInput(executionArguments),
    executionInput: normalizeToolInput(executionArguments),
  };
}

function compactSyntheticReadArtifacts(toolUses, results) {
  if (!Array.isArray(toolUses) || !toolUses.length) return { toolUses: [], results: new Map() };
  const kept = [];
  for (let index = 0; index < toolUses.length; index += 1) {
    const current = syntheticReadToolUseWindow(toolUses[index]);
    let covered = false;
    if (current) {
      for (let otherIndex = 0; otherIndex < toolUses.length; otherIndex += 1) {
        if (otherIndex === index) continue;
        const other = syntheticReadToolUseWindow(toolUses[otherIndex]);
        if (syntheticReadWindowContains(other, current)) {
          covered = true;
          break;
        }
      }
    }
    if (!covered) kept.push(toolUses[index]);
  }
  return {
    toolUses: kept,
    results: new Map(kept.map((toolUse) => [toolUse.id, results.get(toolUse.id)])),
  };
}

function syntheticReadToolUseWindow(toolUse) {
  const args = normalizeToolInput(toolUse?.executionInput ?? toolUse?.input ?? toolUse?.executionArguments ?? toolUse?.arguments);
  const path = stringOrEmpty(args?.path);
  const offset = normalizeInteger(args?.offset);
  const limit = normalizeInteger(args?.limit);
  if (!path || !Number.isInteger(offset) || !Number.isInteger(limit) || limit <= 0) return null;
  return {
    path,
    startLine: offset,
    endLine: offset + limit - 1,
  };
}

function syntheticReadWindowContains(parent, child) {
  if (!parent || !child || parent.path !== child.path) return false;
  const contains = parent.startLine <= child.startLine && parent.endLine >= child.endLine;
  const strictlyLarger = parent.startLine < child.startLine || parent.endLine > child.endLine;
  return contains && strictlyLarger;
}

function syntheticOpenAiChatReadToolUse(parentToolUse, args, index) {
  const executionArguments = JSON.stringify(args);
  return {
    id: `prefetch-read-${stringOrEmpty(parentToolUse.id || "synthetic")}-${index}`,
    name: "Read",
    executionName: "Read",
    arguments: executionArguments,
    executionArguments,
    input: args,
    executionInput: args,
  };
}

function syntheticReadArgsFromGrepToolResult(toolUse, toolResult) {
  const parentArgs = normalizeToolInput(dedupeableToolUseArgs(toolUse, "executionArguments"));
  if (normalizedGrepOutputMode(parentArgs) !== "content") return [];
  const symbol = likelyGrepSymbol(parentArgs?.pattern);
  if (!symbol) return [];
  const success = toolResult?.message?.value?.result?.value || {};
  const candidates = [];
  for (const [workspace, workspaceResult] of Object.entries(objectField(success, "workspaceResults"))) {
    const union = unwrapResultUnion(workspaceResult);
    if (union.case !== "content") continue;
    const orderedMatches = orderGrepFileMatchesForProvider(arrayField(union.value, "matches"), parentArgs?.pattern);
    for (const fileMatch of orderedMatches) {
      const file = stringField(fileMatch, "file");
      const resolvedPath = resolveGrepSummaryFilePath(workspace, file);
      if (!resolvedPath) continue;
      const fileLines = readGrepSummaryFileLines(resolvedPath);
      if (!fileLines.length) continue;
      const definitions = [];
      const calls = [];
      const comments = [];
      for (const match of arrayField(fileMatch, "matches")) {
        const lineNumber = normalizeInteger(match?.lineNumber);
        if (!Number.isInteger(lineNumber)) continue;
        classifyGrepSymbolLine(lineNumber, stringField(match, "content"), symbol, new RegExp(`(?:\\.|\\b)${escapeRegExp(symbol)}\\s*\\(`), calls, definitions, comments);
      }
      if (fileLines.length && (definitions.length === 0 || calls.length === 0)) {
        for (let line = 0; line < fileLines.length; line += 1) {
          classifyGrepSymbolLine(line + 1, String(fileLines[line] || ""), symbol, new RegExp(`(?:\\.|\\b)${escapeRegExp(symbol)}\\s*\\(`), calls, definitions, comments);
        }
      }
      const windows = suggestedReadWindowsForSymbol(definitions, calls, fileLines);
      for (const window of windows) {
        candidates.push({
          path: resolvedPath,
          offset: window.startLine,
          limit: window.endLine - window.startLine + 1,
        });
        if (candidates.length >= 4) return candidates;
      }
      if (definitions.length && calls.length && windows.length) break;
    }
  }
  return candidates;
}

function syntheticTopLevelSymbolReadArgsFromReadResult(toolResult) {
  const success = toolResult?.message?.value?.result?.value || {};
  const output = success.output;
  const path = stringOrEmpty(success.path);
  if (!path || output?.case !== "content" || typeof output.value !== "string") return [];
  const range = normalizedReadRange(success.readRange);
  if (!range) return [];
  const fileLines = readGrepSummaryFileLines(path);
  if (!fileLines.length) return [];
  const text = String(output.value || "");
  const refs = readTopLevelSymbolReferenceEntries(text, range.startLine);
  const reads = [];
  for (const ref of refs) {
    const definitionLine = readTopLevelSymbolDefinitionLine(fileLines, ref.name);
    if (!Number.isInteger(definitionLine)) continue;
    if (definitionLine >= range.startLine && definitionLine <= range.endLine) continue;
    const window = suggestedTopLevelSymbolReadWindow(fileLines, definitionLine);
    if (!window) continue;
    reads.push({
      path,
      offset: window.startLine,
      limit: window.endLine - window.startLine + 1,
    });
    if (reads.length >= 2) break;
  }
  return reads;
}

function suggestedTopLevelSymbolReadWindow(fileLines, definitionLine) {
  if (!Array.isArray(fileLines) || !Number.isInteger(definitionLine) || definitionLine < 1 || definitionLine > fileLines.length) return null;
  const commentBlock = readLeadingLineCommentBlock(fileLines, definitionLine);
  const startLine = Number.isInteger(commentBlock?.startLine) ? commentBlock.startLine : definitionLine;
  let depth = 0;
  let started = false;
  for (let index = definitionLine - 1; index < fileLines.length; index += 1) {
    const line = String(fileLines[index] || "");
    const openCount = countChar(line, "(") + countChar(line, "{") + countChar(line, "[");
    const closeCount = countChar(line, ")") + countChar(line, "}") + countChar(line, "]");
    if (!started && (openCount > 0 || line.includes("="))) started = true;
    if (started) {
      depth += openCount - closeCount;
      const nextLine = String(fileLines[index + 1] || "");
      if (depth <= 0 && (!nextLine.trim() || /^\s*(?:var|const|func)\b/.test(nextLine.trim()))) {
        return { startLine, endLine: index + 1 };
      }
    }
  }
  return { startLine, endLine: Math.min(fileLines.length, definitionLine + 12) };
}

function findReusableToolArtifact(reusableArtifacts, childToolUse, toolArgsKey) {
  if (!Array.isArray(reusableArtifacts) || reusableArtifacts.length === 0) return null;
  let best = null;
  for (const artifact of reusableArtifacts) {
    const score = reusableArtifactScore(artifact, childToolUse, toolArgsKey);
    if (score < 0) continue;
    if (!best || score > best.score) best = {
      result: deriveToolResultFromReusableArtifact(artifact, childToolUse, toolArgsKey),
      artifact,
      score,
    };
  }
  return best;
}

function reusableArtifactMissReason(reusableArtifacts, childToolUse, toolArgsKey) {
  if (!Array.isArray(reusableArtifacts) || reusableArtifacts.length === 0) return "no-prior-read-or-grep-artifact";
  const reasons = [];
  for (const artifact of reusableArtifacts) {
    const reason = reusableArtifactDiagnostic(artifact, childToolUse, toolArgsKey);
    if (!reason || reason === "reusable") continue;
    reasons.push(reason);
  }
  return reasons[0] || "no-reusable-artifact-match";
}

function reusableArtifactDiagnostic(artifact, childToolUse, toolArgsKey) {
  const parentToolUse = artifact?.toolUse;
  const parentResult = artifact?.toolResult;
  if (!parentToolUse || !parentResult) return "artifact-missing";
  if (parentToolUse.executionName === "Read" && childToolUse.executionName === "Read") {
    return readReusableDiagnostic(parentToolUse, parentResult, childToolUse, toolArgsKey);
  }
  if (parentToolUse.executionName === "Read" && childToolUse.executionName === "Grep") {
    return readToGrepReusableDiagnostic(parentToolUse, parentResult, childToolUse, toolArgsKey);
  }
  if (parentToolUse.executionName === "Grep" && childToolUse.executionName === "Read") {
    return grepToReadReusableDiagnostic(parentToolUse, parentResult, childToolUse, toolArgsKey);
  }
  if (parentToolUse.executionName === "Grep" && childToolUse.executionName === "Grep") {
    return grepReusableDiagnostic(parentToolUse, childToolUse, toolArgsKey);
  }
  return `unsupported-parent-${stringOrEmpty(parentToolUse.executionName || parentToolUse.name).toLowerCase() || "tool"}`;
}

function readReusableDiagnostic(parentToolUse, parentResult, childToolUse, toolArgsKey) {
  const parentArgs = normalizeToolInput(dedupeableToolUseArgs(parentToolUse, toolArgsKey));
  const childArgs = normalizeToolInput(dedupeableToolUseArgs(childToolUse, toolArgsKey));
  if (!sameReadPath(parentArgs?.path, childArgs?.path)) return "read:path-mismatch";
  const result = parentResult?.message?.value?.result;
  if (result?.case && result.case !== "success") return `read:parent-${result.case}`;
  const success = result?.value || {};
  const output = success.output;
  if (output?.case !== "content" && output?.case !== "data") return "read:parent-no-inline-output";
  const localLines = readReusableLocalFileLines(success, childArgs, parentArgs?.path);
  const totalLines = normalizeInteger(success.totalLines) || localLines?.length;
  if (!Number.isInteger(totalLines) || totalLines < 1) return "read:parent-missing-total-lines";
  const parentRange = normalizedReadRange(success.readRange);
  if (!parentRange) return "read:parent-missing-range";
  const childRange = requestedReadRangeFromArgs(totalLines, childArgs);
  if (!childRange) return "read:child-no-range";
  if (childRange.startLine < parentRange.startLine || childRange.endLine > parentRange.endLine) {
    if (!localLines) return "read:child-outside-parent-range";
  }
  return "reusable";
}

function readToGrepReusableDiagnostic(parentToolUse, parentResult, childToolUse, toolArgsKey) {
  const parentArgs = normalizeToolInput(dedupeableToolUseArgs(parentToolUse, toolArgsKey));
  const childArgs = normalizeToolInput(dedupeableToolUseArgs(childToolUse, toolArgsKey));
  const parentPath = stringOrEmpty(parentArgs?.path);
  if (!parentPath) return "read->grep:parent-path-missing";
  if (!readReusableGrepTargetContains(parentPath, childArgs)) return "read->grep:target-not-contained";
  const result = parentResult?.message?.value?.result;
  if (result?.case && result.case !== "success") return `read->grep:parent-${result.case}`;
  const success = result?.value || {};
  const output = success.output;
  if (output?.case !== "content" && output?.case !== "data") return "read->grep:parent-no-inline-output";
  if (readReusableFunctionDefinitionGrep(childArgs)) {
    const parentRange = normalizedReadRange(success.readRange);
    if (!parentRange) return "read->grep:parent-missing-range";
    const regex = compileDerivedGrepRegex(childArgs);
    if (!regex) return "read->grep:invalid-regex";
    const lines = splitReadContentLines(typeof output.value === "string" ? output.value : "");
    for (const line of lines) {
      if (regex.test(line)) {
        regex.lastIndex = 0;
        return "reusable";
      }
      regex.lastIndex = 0;
    }
    return "read->grep:no-match-in-read-window";
  }
  if (!readReusableLiteralContentGrep(parentPath, childArgs)) return "read->grep:not-supported-content-grep";
  const matches = readLiteralGrepMatchesFromFile(parentPath, childArgs);
  return matches.length ? "reusable" : "read->grep:no-literal-match-in-file";
}

function grepReusableDiagnostic(parentToolUse, childToolUse, toolArgsKey) {
  const parentArgs = normalizeToolInput(dedupeableToolUseArgs(parentToolUse, toolArgsKey));
  const childArgs = normalizeToolInput(dedupeableToolUseArgs(childToolUse, toolArgsKey));
  const mode = grepDerivedParentMode(parentArgs, childArgs);
  if (mode) return "reusable";
  const parentPattern = stringOrEmpty(parentArgs?.pattern);
  const childPattern = stringOrEmpty(childArgs?.pattern);
  if (normalizedGrepOutputMode(parentArgs) !== "content") return "grep:parent-not-content";
  if (!grepPathContains(parentArgs?.path, childArgs?.path, "content-from-content")) return "grep:path-context-mismatch";
  if (stringOrEmpty(parentArgs?.glob) !== stringOrEmpty(childArgs?.glob)) return "grep:glob-mismatch";
  if (likelyGrepSymbol(parentPattern) && likelyGrepSymbol(parentPattern) === likelyGrepSymbol(childPattern)) return "grep:pattern-variant-not-derivable";
  return "grep:pattern-not-derivable";
}

function reusableArtifactScore(artifact, childToolUse, toolArgsKey) {
  if (!artifact?.toolUse || !artifact?.toolResult) return -1;
  const derived = deriveToolResultFromReusableArtifact(artifact, childToolUse, toolArgsKey);
  if (!derived) return -1;
  if (artifact.toolUse.executionName === "Read" && childToolUse.executionName === "Read") {
    const range = artifact.toolResult?.message?.value?.result?.value?.readRange || {};
    const startLine = normalizeInteger(range.startLine);
    const endLine = normalizeInteger(range.endLine);
    const width = startLine !== undefined && endLine !== undefined ? endLine - startLine + 1 : 1000000;
    return 1000000 - width;
  }
  if (artifact.toolUse.executionName === "Grep" && childToolUse.executionName === "Read") {
    const childArgs = normalizeToolInput(dedupeableToolUseArgs(childToolUse, toolArgsKey));
    const width = normalizeInteger(childArgs?.limit) || 1000000;
    return 500000 - width + stringOrEmpty(childArgs?.path).length;
  }
  if (artifact.toolUse.executionName === "Grep" && childToolUse.executionName === "Grep") {
    return grepDerivedParentScore(artifact.toolUse, childToolUse, toolArgsKey);
  }
  return 0;
}

function deriveToolResultFromReusableArtifact(artifact, childToolUse, toolArgsKey) {
  const parentToolUse = artifact?.toolUse;
  const parentResult = artifact?.toolResult;
  if (!parentToolUse || !parentResult) return null;
  if (parentToolUse.executionName === "Read" && childToolUse.executionName === "Read") {
    return deriveReadToolResultFromReusableRead(parentToolUse, parentResult, childToolUse, toolArgsKey);
  }
  if (parentToolUse.executionName === "Read" && childToolUse.executionName === "Grep") {
    return deriveGrepToolResultFromReusableRead(parentToolUse, parentResult, childToolUse, toolArgsKey);
  }
  if (parentToolUse.executionName === "Grep" && childToolUse.executionName === "Read") {
    return deriveReadToolResultFromReusableGrep(parentToolUse, parentResult, childToolUse, toolArgsKey);
  }
  if (parentToolUse.executionName === "Grep" && childToolUse.executionName === "Grep") {
    return deriveGrepToolResultFromParent(parentResult, parentToolUse, childToolUse, toolArgsKey);
  }
  return null;
}

function deriveReadToolResultFromReusableRead(parentToolUse, parentResult, childToolUse, toolArgsKey) {
  const parentArgs = normalizeToolInput(dedupeableToolUseArgs(parentToolUse, toolArgsKey));
  const childArgs = normalizeToolInput(dedupeableToolUseArgs(childToolUse, toolArgsKey));
  if (!sameReadPath(parentArgs?.path, childArgs?.path)) return null;
  const result = parentResult?.message?.value?.result;
  if (result?.case && result.case !== "success") return null;
  const success = result?.value || {};
  const output = success.output;
  if (output?.case !== "content" && output?.case !== "data") return null;
  const rawText = typeof output.value === "string" ? output.value : null;
  if (rawText === null) return null;
  const localLines = readReusableLocalFileLines(success, childArgs, parentArgs?.path);
  const totalLines = normalizeInteger(success.totalLines) || localLines?.length;
  if (!Number.isInteger(totalLines) || totalLines < 1) return null;
  const parentRange = normalizedReadRange(success.readRange);
  if (!parentRange) return null;
  const childRange = requestedReadRangeFromArgs(totalLines, childArgs);
  if (!childRange) return null;
  let selectedLines;
  const containedInParent = childRange.startLine >= parentRange.startLine && childRange.endLine <= parentRange.endLine;
  if (containedInParent) {
    const lines = splitReadContentLines(rawText);
    const startIndex = childRange.startLine - parentRange.startLine;
    const endIndexExclusive = startIndex + (childRange.endLine - childRange.startLine + 1);
    selectedLines = lines.slice(startIndex, endIndexExclusive);
  } else {
    if (!localLines) return null;
    selectedLines = localLines.slice(childRange.startLine - 1, childRange.endLine);
  }
  return {
    execId: childToolUse.id,
    _byokDerivedTool: true,
    _byokDerivedFromToolCallId: parentResult?.execId || undefined,
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: stringOrEmpty(childArgs.path),
            _byokContainedInReadRange: containedInParent ? {
              startLine: parentRange.startLine,
              endLine: parentRange.endLine,
            } : undefined,
            output: {
              case: output.case,
              value: selectedLines.join("\n"),
            },
            totalLines,
            readRange: {
              startLine: childRange.startLine,
              endLine: childRange.endLine,
            },
          },
        },
      },
    },
  };
}

function sameReadPath(left, right) {
  return stringOrEmpty(left) === stringOrEmpty(right);
}

function readReusableLocalFileLines(success, childArgs, parentPath) {
  const outputCase = success?.output?.case;
  if (outputCase !== "content" && outputCase !== "data") return null;
  const targetPath = stringOrEmpty(childArgs?.path) || stringOrEmpty(parentPath);
  if (!targetPath) return null;
  const fileText = readReusableLocalFileText(targetPath);
  if (fileText === null) return null;
  const lines = splitReadContentLines(fileText);
  if (!lines.length || lines.length > 10000) return null;
  return lines;
}

function readReusableLocalFileText(path) {
  try {
    return fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  } catch {
    return null;
  }
}

function normalizedReadRange(range) {
  const startLine = normalizeInteger(range?.startLine);
  const endLine = normalizeInteger(range?.endLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || endLine < startLine) return null;
  return { startLine, endLine };
}

function requestedReadRangeFromArgs(totalLines, args) {
  const requestedOffset = normalizeInteger(args?.offset);
  const requestedLimit = normalizeInteger(args?.limit);
  const startLineArg = requestedOffset ?? 1;
  const lineCount = requestedLimit ?? (startLineArg < 0 ? Math.abs(startLineArg) : totalLines);
  if (!Number.isInteger(lineCount) || lineCount <= 0) return null;
  const startIndex = startLineArg < 0
    ? Math.max(0, totalLines + startLineArg)
    : Math.max(0, startLineArg - 1);
  if (startIndex >= totalLines) return null;
  const endExclusive = Math.min(totalLines, startIndex + lineCount);
  if (endExclusive <= startIndex) return null;
  return {
    startLine: startIndex + 1,
    endLine: endExclusive,
  };
}

function splitReadContentLines(text) {
  if (text.length === 0) return [];
  const lines = String(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function grepToReadReusableDiagnostic(parentToolUse, parentResult, childToolUse, toolArgsKey) {
  const parentArgs = normalizeToolInput(dedupeableToolUseArgs(parentToolUse, toolArgsKey));
  const childArgs = normalizeToolInput(dedupeableToolUseArgs(childToolUse, toolArgsKey));
  if (normalizedGrepOutputMode(parentArgs) !== "content") return "grep->read:parent-not-content";
  const childPath = stringOrEmpty(childArgs?.path);
  if (!childPath) return "grep->read:child-path-missing";
  if (!grepReadTargetContains(parentArgs?.path, childPath)) return "grep->read:path-context-mismatch";
  const result = parentResult?.message?.value?.result;
  if (result?.case && result.case !== "success") return `grep->read:parent-${result.case}`;
  const lines = readReusableLocalFileLines({ output: { case: "content" } }, childArgs, childPath);
  if (!lines) return "grep->read:file-unreadable";
  const childRange = requestedReadRangeFromArgs(lines.length, childArgs);
  if (!childRange) return "grep->read:child-no-range";
  return "reusable";
}

function grepReusableReadMatchInfo(success, childArgs, exactSymbol = "", fileLines = null) {
  const childPath = stringOrEmpty(childArgs?.path);
  if (!childPath) return null;
  for (const [workspace, workspaceResult] of Object.entries(objectField(success, "workspaceResults"))) {
    const union = unwrapResultUnion(workspaceResult);
    if (union.case !== "content") continue;
    for (const fileMatch of filterGrepContentMatchesForPath(workspace, arrayField(union.value, "matches"), childPath)) {
      const file = stringField(fileMatch, "file");
      const resolvedPath = resolveGrepSummaryFilePath(workspace, file);
      if (resolvedPath !== childPath) continue;
      const lineNumbers = arrayField(fileMatch, "matches")
        .map((match) => normalizeInteger(match?.lineNumber))
        .filter((lineNumber) => Number.isInteger(lineNumber));
      if (exactSymbol && Array.isArray(fileLines) && fileLines.length) {
        for (const lineNumber of readExactSymbolLineNumbers(fileLines, exactSymbol)) {
          if (!lineNumbers.includes(lineNumber)) lineNumbers.push(lineNumber);
        }
      }
      if (!lineNumbers.length) continue;
      return { workspace, file, lineNumbers };
    }
  }
  return null;
}

function deriveReadToolResultFromReusableGrep(parentToolUse, parentResult, childToolUse, toolArgsKey) {
  const parentArgs = normalizeToolInput(dedupeableToolUseArgs(parentToolUse, toolArgsKey));
  const childArgs = normalizeToolInput(dedupeableToolUseArgs(childToolUse, toolArgsKey));
  const childPath = stringOrEmpty(childArgs?.path);
  if (!childPath) return null;
  if (!grepReadTargetContains(parentArgs?.path, childPath)) return null;
  const result = parentResult?.message?.value?.result;
  if (result?.case && result.case !== "success") return null;
  const lines = readReusableLocalFileLines({ output: { case: "content" } }, childArgs, childPath);
  if (!lines) return null;
  const childRange = requestedReadRangeFromArgs(lines.length, childArgs);
  if (!childRange) return null;
  const selectedLines = lines.slice(childRange.startLine - 1, childRange.endLine);
  return {
    execId: childToolUse.id,
    _byokDerivedTool: true,
    _byokDerivedFromToolCallId: parentResult?.execId || undefined,
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: childPath,
            output: {
              case: "content",
              value: selectedLines.join("\n"),
            },
            totalLines: lines.length,
            readRange: {
              startLine: childRange.startLine,
              endLine: childRange.endLine,
            },
          },
        },
      },
    },
  };
}

function readExactSymbolLineNumbers(lines, symbol) {
  if (!Array.isArray(lines) || !symbol) return [];
  const lineNumbers = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!String(lines[index] || "").includes(symbol)) continue;
    lineNumbers.push(index + 1);
  }
  return lineNumbers;
}

function deriveGrepToolResultFromReusableRead(parentToolUse, parentResult, childToolUse, toolArgsKey) {
  const parentArgs = normalizeToolInput(dedupeableToolUseArgs(parentToolUse, toolArgsKey));
  const childArgs = normalizeToolInput(dedupeableToolUseArgs(childToolUse, toolArgsKey));
  const parentPath = stringOrEmpty(parentArgs?.path);
  if (!parentPath || !readReusableGrepTargetContains(parentPath, childArgs)) return null;
  const result = parentResult?.message?.value?.result;
  if (result?.case && result.case !== "success") return null;
  const success = result?.value || {};
  const output = success.output;
  if (output?.case !== "content" && output?.case !== "data") return null;
  let matches = [];
  if (readReusableFunctionDefinitionGrep(childArgs)) {
    const rawText = typeof output.value === "string" ? output.value : null;
    if (rawText === null) return null;
    const parentRange = normalizedReadRange(success.readRange);
    if (!parentRange) return null;
    const regex = compileDerivedGrepRegex(childArgs);
    if (!regex) return null;
    const lines = splitReadContentLines(rawText);
    for (let index = 0; index < lines.length; index += 1) {
      const content = lines[index];
      if (!regex.test(content)) {
        regex.lastIndex = 0;
        continue;
      }
      regex.lastIndex = 0;
      matches.push({
        lineNumber: parentRange.startLine + index,
        content,
      });
    }
  } else if (readReusableLiteralContentGrep(parentPath, childArgs)) {
    matches = readLiteralGrepMatchesFromFile(parentPath, childArgs);
  } else {
    return null;
  }
  if (!matches.length) return null;
  const workspace = derivedGrepWorkspaceFromRead(parentPath, childArgs);
  const file = derivedGrepFileFromRead(parentPath, workspace);
  return {
    execId: childToolUse.id,
    _byokDerivedTool: true,
    _byokDerivedFromToolCallId: parentResult?.execId || undefined,
    message: {
      case: "grepResult",
      value: {
        result: {
          case: "success",
          value: {
            pattern: stringOrEmpty(childArgs.pattern),
            outputMode: normalizedGrepOutputMode(childArgs),
            workspaceResults: {
              [workspace]: {
                result: {
                  case: "content",
                  value: {
                    matches: [{ file, matches }],
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function readReusableGrepTargetContains(parentPath, childArgs) {
  const childPath = normalizedDerivedPath(childArgs?.path);
  const normalizedParentPath = normalizedDerivedPath(parentPath);
  if (childPath) {
    if (childPath === normalizedParentPath) return readReusableGrepGlobAllows(parentPath, childArgs?.glob);
    if (!normalizedParentPath.startsWith(`${childPath}/`)) return false;
  }
  return readReusableGrepGlobAllows(parentPath, childArgs?.glob);
}

function readReusableGrepGlobAllows(parentPath, glob) {
  const pattern = stringOrEmpty(glob);
  if (!pattern) return true;
  if (/[*?[{]/.test(pattern)) return false;
  const basename = nodePath.basename(parentPath);
  return pattern === basename || pattern === nodePath.relative(nodePath.dirname(parentPath), parentPath).replace(/\\/g, "/");
}

function readReusableFunctionDefinitionGrep(childArgs) {
  if (normalizedGrepOutputMode(childArgs) !== "content") return false;
  const pattern = stringOrEmpty(childArgs?.pattern).trim();
  if (!pattern.startsWith("func")) return false;
  if (pattern.includes("|")) return false;
  return !!likelyGrepSymbol(pattern);
}

function readReusableLiteralContentGrep(parentPath, childArgs) {
  if (normalizedGrepOutputMode(childArgs) !== "content") return false;
  if (!readReusableGrepTargetContains(parentPath, childArgs)) return false;
  if (stringOrEmpty(childArgs?.type)) return false;
  if (childArgs?.multiline) return false;
  for (const key of ["-A", "-B", "-C", "head_limit", "offset"]) {
    const value = normalizeInteger(childArgs?.[key]);
    if (value !== undefined && value !== 0) return false;
  }
  return !!literalDerivedGrepNeedle(childArgs);
}

function literalDerivedGrepNeedle(childArgs) {
  const pattern = stringOrEmpty(childArgs?.pattern).trim();
  if (!pattern) return "";
  if (/[\\^$*+?()[\]{}|]/.test(pattern)) return "";
  return childArgs?.["-i"] ? pattern.toLowerCase() : pattern;
}

function readLiteralGrepMatchesFromFile(parentPath, childArgs) {
  const lines = readGrepSummaryFileLines(parentPath);
  if (!lines.length) return [];
  const needle = literalDerivedGrepNeedle(childArgs);
  if (!needle) return [];
  const ignoreCase = !!childArgs?.["-i"];
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const content = String(lines[index] || "");
    const haystack = ignoreCase ? content.toLowerCase() : content;
    if (!haystack.includes(needle)) continue;
    matches.push({
      lineNumber: index + 1,
      content,
    });
  }
  return matches;
}

function derivedGrepWorkspaceFromRead(parentPath, childArgs) {
  const childPath = stringOrEmpty(childArgs?.path);
  if (childPath && childPath !== parentPath && normalizedDerivedPath(parentPath).startsWith(`${normalizedDerivedPath(childPath)}/`)) {
    return childPath;
  }
  return nodePath.dirname(parentPath);
}

function derivedGrepFileFromRead(parentPath, workspace) {
  const relative = nodePath.relative(workspace, parentPath).replace(/\\/g, "/");
  return relative && !relative.startsWith("..") ? relative : nodePath.basename(parentPath);
}

function findDerivedToolUseParent(toolUses, childToolUse, toolArgsKey) {
  if (childToolUse?.executionName !== "Grep") return null;
  let best = null;
  for (const parentToolUse of toolUses) {
    if (!parentToolUse || parentToolUse.id === childToolUse.id) continue;
    const score = grepDerivedParentScore(parentToolUse, childToolUse, toolArgsKey);
    if (score < 0) continue;
    if (!best || score > best.score) best = { toolUse: parentToolUse, score };
  }
  return best?.toolUse || null;
}

function grepDerivedParentScore(parentToolUse, childToolUse, toolArgsKey) {
  if (parentToolUse?.executionName !== "Grep" || childToolUse?.executionName !== "Grep") return -1;
  const parentArgs = normalizeToolInput(dedupeableToolUseArgs(parentToolUse, toolArgsKey));
  const childArgs = normalizeToolInput(dedupeableToolUseArgs(childToolUse, toolArgsKey));
  const mode = grepDerivedParentMode(parentArgs, childArgs);
  if (!mode) return -1;
  return stringOrEmpty(parentArgs?.path).length
    + (mode === "filtered-symbol" ? 1000 : 0)
    + (mode === "content-from-content" ? 900 : 0);
}

function grepDerivedParentMode(parentArgs, childArgs) {
  if (!parentArgs || typeof parentArgs !== "object" || !childArgs || typeof childArgs !== "object") return false;
  if (contentGrepCanDeriveFilesOrCount(parentArgs, childArgs)) {
    return normalizedGrepOutputMode(childArgs) === "count" ? "count-from-content" : "files-from-content";
  }
  if (contentGrepCanDeriveContent(parentArgs, childArgs)) return "content-from-content";
  const parentSymbol = exactSymbolPattern(parentArgs.pattern);
  if (!parentSymbol) return "";
  let mode = "";
  if (narrowedSymbolPattern(childArgs.pattern, parentSymbol)) mode = "filtered-symbol";
  else if (enclosingFunctionGrepPattern(childArgs.pattern)) mode = "enclosing-function";
  if (!mode) return "";
  return sameDerivedGrepContext(parentArgs, childArgs, mode) ? mode : "";
}

function sameDerivedGrepContext(parentArgs, childArgs, mode = "") {
  const parentOutputMode = normalizedGrepOutputMode(parentArgs);
  const childOutputMode = normalizedGrepOutputMode(childArgs);
  if (parentOutputMode !== "content") return false;
  if (mode === "content-from-content" && childOutputMode !== "content") return false;
  if ((mode === "filtered-symbol" || mode === "enclosing-function") && childOutputMode !== "content") return false;
  if (mode === "files-from-content" && childOutputMode !== "files_with_matches") return false;
  if (mode === "count-from-content" && childOutputMode !== "count") return false;
  for (const key of ["glob", "type"]) {
    if (stringOrEmpty(parentArgs?.[key]) !== stringOrEmpty(childArgs?.[key])) return false;
  }
  if (!grepPathContains(parentArgs?.path, childArgs?.path, mode)) return false;
  if (!!parentArgs?.multiline !== !!childArgs?.multiline) return false;
  if (!!parentArgs?.["-i"] !== !!childArgs?.["-i"]) return false;
  for (const key of ["-A", "-B", "-C", "head_limit", "offset"]) {
    if (normalizeInteger(parentArgs?.[key]) !== normalizeInteger(childArgs?.[key])) return false;
  }
  return true;
}

function grepPathContains(parentPath, childPath, mode = "") {
  const parent = normalizedDerivedPath(parentPath);
  const child = normalizedDerivedPath(childPath);
  if (!child) return parent === "";
  if (!parent) return true;
  if (parent === child) return true;
  if (mode === "enclosing-function" || mode === "filtered-symbol" || mode === "files-from-content" || mode === "count-from-content" || mode === "content-from-content") {
    return child.startsWith(`${parent}/`);
  }
  return false;
}

function normalizedDerivedPath(value) {
  const text = stringOrEmpty(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return text === "." ? "" : text;
}

function normalizedGrepOutputMode(args) {
  return stringOrEmpty(args?.output_mode || args?.outputMode || "content") || "content";
}

function exactSymbolPattern(pattern) {
  const text = stringOrEmpty(pattern).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : "";
}

function enclosingFunctionGrepPattern(pattern) {
  const text = stringOrEmpty(pattern).trim();
  if (!text || !/func/.test(text)) return "";
  const match = text.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\\?b)?\s*$/);
  return match ? match[1] : "";
}

function narrowedSymbolPattern(pattern, symbol) {
  const text = stringOrEmpty(pattern);
  if (!text || text === symbol) return false;
  if (!text.includes(symbol)) return false;
  return /(?:func|type|struct|interface)/.test(text) || text.startsWith("^");
}

function deriveToolResultFromParent(parentResult, parentToolUse, childToolUse, toolArgsKey) {
  if (parentToolUse?.executionName === "Grep" && childToolUse?.executionName === "Grep") {
    return deriveGrepToolResultFromParent(parentResult, parentToolUse, childToolUse, toolArgsKey);
  }
  return null;
}

function deriveGrepToolResultFromParent(parentResult, parentToolUse, childToolUse, toolArgsKey) {
  const parentArgs = normalizeToolInput(dedupeableToolUseArgs(parentToolUse, toolArgsKey));
  const childArgs = normalizeToolInput(dedupeableToolUseArgs(childToolUse, toolArgsKey));
  const mode = grepDerivedParentMode(parentArgs, childArgs);
  if (!mode) return null;
  const result = parentResult?.message?.value?.result;
  if (result?.case && result.case !== "success") {
    return {
      ...parentResult,
      execId: childToolUse.id,
      message: {
        case: "grepResult",
        value: {
          result: {
            case: result.case,
            value: result.value,
          },
        },
      },
    };
  }
  if (mode === "files-from-content" || mode === "count-from-content") {
    return deriveGrepFilesOrCountFromContent(parentResult, childToolUse, childArgs, mode);
  }
  if (mode === "content-from-content") {
    return deriveGrepContentFromContent(parentResult, childToolUse, childArgs);
  }
  if (mode === "enclosing-function") {
    return deriveEnclosingFunctionGrepToolResult(parentResult, childToolUse, childArgs);
  }
  const regex = compileDerivedGrepRegex(childArgs);
  if (!regex) return null;
  const success = result?.value || {};
  const filteredWorkspaceResults = {};
  for (const [workspace, workspaceResult] of Object.entries(objectField(success, "workspaceResults"))) {
    const union = unwrapResultUnion(workspaceResult);
    if (union.case !== "content") continue;
    const filteredMatches = [];
    for (const fileMatch of arrayField(union.value, "matches")) {
      const file = stringField(fileMatch, "file");
      const matches = arrayField(fileMatch, "matches").filter((match) => regex.test(stringField(match, "content")));
      regex.lastIndex = 0;
      if (matches.length) filteredMatches.push({ file, matches });
    }
    filteredWorkspaceResults[workspace] = {
      result: {
        case: "content",
        value: {
          matches: filteredMatches,
        },
      },
    };
  }
  return {
    execId: childToolUse.id,
    _byokDerivedTool: true,
    _byokDerivedFromToolCallId: parentResult?.execId || undefined,
    message: {
      case: "grepResult",
      value: {
        result: {
          case: "success",
          value: {
            pattern: stringOrEmpty(childArgs.pattern),
            outputMode: normalizedGrepOutputMode(childArgs),
            workspaceResults: filteredWorkspaceResults,
          },
        },
      },
    },
  };
}

function deriveGrepContentFromContent(parentResult, childToolUse, childArgs) {
  const success = parentResult?.message?.value?.result?.value || {};
  const filteredWorkspaceResults = {};
  const childPattern = stringOrEmpty(childArgs?.pattern);
  const parentPattern = stringOrEmpty(success.pattern);
  const regex = childPattern && childPattern !== parentPattern ? compileDerivedGrepRegex(childArgs) : null;
  for (const [workspace, workspaceResult] of Object.entries(objectField(success, "workspaceResults"))) {
    const union = unwrapResultUnion(workspaceResult);
    if (union.case !== "content") continue;
    const pathFiltered = filterGrepContentMatchesForPath(workspace, arrayField(union.value, "matches"), childArgs?.path);
    const regexFiltered = regex ? filterGrepContentMatchesByRegex(pathFiltered, regex) : pathFiltered;
    filteredWorkspaceResults[workspace] = {
      result: {
        case: "content",
        value: {
          matches: regexFiltered,
        },
      },
    };
  }
  return {
    execId: childToolUse.id,
    _byokDerivedTool: true,
    _byokDerivedFromToolCallId: parentResult?.execId || undefined,
    message: {
      case: "grepResult",
      value: {
        result: {
          case: "success",
          value: {
            pattern: stringOrEmpty(childArgs.pattern),
            outputMode: normalizedGrepOutputMode(childArgs),
            workspaceResults: filteredWorkspaceResults,
          },
        },
      },
    },
  };
}

function deriveGrepFilesOrCountFromContent(parentResult, childToolUse, childArgs, mode) {
  const success = parentResult?.message?.value?.result?.value || {};
  const outputMode = normalizedGrepOutputMode(childArgs);
  const filteredWorkspaceResults = {};
  const childPattern = stringOrEmpty(childArgs?.pattern);
  const parentPattern = stringOrEmpty(success.pattern);
  const regex = childPattern && childPattern !== parentPattern ? compileDerivedGrepRegex(childArgs) : null;
  if (childPattern && childPattern !== parentPattern && !regex) return null;
  for (const [workspace, workspaceResult] of Object.entries(objectField(success, "workspaceResults"))) {
    const union = unwrapResultUnion(workspaceResult);
    if (union.case !== "content") continue;
    const pathFiltered = filterGrepContentMatchesForPath(workspace, arrayField(union.value, "matches"), childArgs?.path);
    const filteredMatches = regex ? filterGrepContentMatchesByRegex(pathFiltered, regex) : pathFiltered;
    if (mode === "files-from-content") {
      filteredWorkspaceResults[workspace] = {
        result: {
          case: "files",
          value: {
            files: filteredMatches.map((fileMatch) => fileMatch.file),
            totalFiles: filteredMatches.length,
          },
        },
      };
      continue;
    }
    const totalMatches = filteredMatches.reduce((sum, fileMatch) => sum + arrayField(fileMatch, "matches").length, 0);
    filteredWorkspaceResults[workspace] = {
      result: {
        case: "count",
        value: {
          totalMatches,
          totalFiles: filteredMatches.length,
        },
      },
    };
  }
  return {
    execId: childToolUse.id,
    _byokDerivedTool: true,
    _byokDerivedFromToolCallId: parentResult?.execId || undefined,
    message: {
      case: "grepResult",
      value: {
        result: {
          case: "success",
          value: {
            pattern: stringOrEmpty(childArgs.pattern),
            outputMode,
            workspaceResults: filteredWorkspaceResults,
          },
        },
      },
    },
  };
}

function filterGrepContentMatchesForPath(workspace, matches, childPath) {
  const resolvedChildPath = childPath ? resolveGrepSummaryFilePath(workspace, childPath) : "";
  const filtered = [];
  for (const fileMatch of matches) {
    const file = stringField(fileMatch, "file");
    const resolvedFilePath = resolveGrepSummaryFilePath(workspace, file);
    if (resolvedChildPath && resolvedFilePath && resolvedFilePath !== resolvedChildPath && !resolvedFilePath.startsWith(`${resolvedChildPath}${nodePath.sep}`)) {
      continue;
    }
    filtered.push(fileMatch);
  }
  return filtered;
}

function filterGrepContentMatchesByRegex(matches, regex) {
  const filtered = [];
  for (const fileMatch of matches) {
    const nextMatches = arrayField(fileMatch, "matches").filter((match) => regex.test(stringField(match, "content")));
    regex.lastIndex = 0;
    if (!nextMatches.length) continue;
    filtered.push({
      file: stringField(fileMatch, "file"),
      matches: nextMatches,
    });
  }
  return filtered;
}

function contentGrepCanDeriveFilesOrCount(parentArgs, childArgs) {
  const childMode = normalizedGrepOutputMode(childArgs);
  if (childMode !== "files_with_matches" && childMode !== "count") return false;
  if (normalizedGrepOutputMode(parentArgs) !== "content") return false;
  if (!grepContentPatternCanDerive(stringOrEmpty(parentArgs?.pattern), stringOrEmpty(childArgs?.pattern), childArgs)) return false;
  return sameDerivedGrepContext(parentArgs, childArgs, childMode === "count" ? "count-from-content" : "files-from-content");
}

function contentGrepCanDeriveContent(parentArgs, childArgs) {
  if (normalizedGrepOutputMode(childArgs) !== "content") return false;
  if (normalizedGrepOutputMode(parentArgs) !== "content") return false;
  if (!sameDerivedGrepContext(parentArgs, childArgs, "content-from-content")) return false;
  return grepContentPatternCanDerive(stringOrEmpty(parentArgs?.pattern), stringOrEmpty(childArgs?.pattern), childArgs);
}

function patternRequiresSymbol(pattern, symbol) {
  const text = stringOrEmpty(pattern);
  if (!text || !symbol) return false;
  const branches = text.split("|").map((branch) => branch.trim()).filter(Boolean);
  if (!branches.length) return false;
  return branches.every((branch) => branch.includes(symbol));
}

function grepContentPatternCanDerive(parentPattern, childPattern, childArgs = null) {
  const parentText = stringOrEmpty(parentPattern);
  const childText = stringOrEmpty(childPattern);
  if (!parentText || !childText) return false;
  if (parentText === childText) return true;
  if (childArgs && !compileDerivedGrepRegex(childArgs)) return false;
  if (simpleAlternationSubset(parentText, childText)) return true;
  const parentSymbol = likelyGrepSymbol(parentText);
  const childSymbol = likelyGrepSymbol(childText);
  if (!parentSymbol || parentSymbol !== childSymbol) return false;
  const exactParentSymbol = exactSymbolPattern(parentText);
  if (exactParentSymbol && exactParentSymbol === childSymbol) {
    return patternRequiresSymbol(childText, exactParentSymbol);
  }
  return /func/.test(parentText) && /func/.test(childText);
}

function simpleAlternationSubset(parentPattern, childPattern) {
  const parentBranches = simpleAlternationBranches(parentPattern);
  if (parentBranches.length < 2) return false;
  const childBranches = simpleAlternationBranches(childPattern);
  const normalizedChildBranches = childBranches.length ? childBranches : [stringOrEmpty(childPattern).trim()].filter(Boolean);
  if (!normalizedChildBranches.length) return false;
  const parentSet = new Set(parentBranches);
  return normalizedChildBranches.every((branch) => parentSet.has(branch));
}

function simpleAlternationBranches(pattern) {
  const branches = String(pattern || "").split("|").map((branch) => branch.trim()).filter(Boolean);
  if (branches.length < 2) return [];
  return branches.every(isSimpleAlternationBranch) ? branches : [];
}

function isSimpleAlternationBranch(branch) {
  return typeof branch === "string"
    && branch.length > 0
    && !/[\\^$.*+?()[\]{}]/.test(branch);
}

function deriveEnclosingFunctionGrepToolResult(parentResult, childToolUse, childArgs) {
  const functionName = enclosingFunctionGrepPattern(childArgs?.pattern);
  if (!functionName) return null;
  const result = parentResult?.message?.value?.result;
  const success = result?.value || {};
  const filteredWorkspaceResults = {};
  const linesByPath = new Map();
  let found = false;
  for (const [workspace, workspaceResult] of Object.entries(objectField(success, "workspaceResults"))) {
    const union = unwrapResultUnion(workspaceResult);
    if (union.case !== "content") continue;
    const filteredMatches = [];
    for (const fileMatch of arrayField(union.value, "matches")) {
      const file = stringField(fileMatch, "file");
      const resolvedPath = resolveGrepSummaryFilePath(workspace, file);
      if (!resolvedPath) continue;
      let lines = linesByPath.get(resolvedPath);
      if (!lines) {
        try {
          lines = fs.readFileSync(resolvedPath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        } catch {
          lines = null;
        }
        linesByPath.set(resolvedPath, lines);
      }
      if (!lines) continue;
      const seen = new Set();
      const matches = [];
      for (const match of arrayField(fileMatch, "matches")) {
        const context = enclosingFunctionForLine(lines, normalizeInteger(match?.lineNumber));
        if (!context || context.name !== functionName || seen.has(context.line)) continue;
        seen.add(context.line);
        matches.push({
          lineNumber: context.line,
          content: String(lines[context.line - 1] || ""),
        });
      }
      if (!matches.length) continue;
      filteredMatches.push({ file, matches });
      found = true;
    }
    filteredWorkspaceResults[workspace] = {
      result: {
        case: "content",
        value: {
          matches: filteredMatches,
        },
      },
    };
  }
  if (!found) return null;
  return {
    execId: childToolUse.id,
    _byokDerivedTool: true,
    _byokDerivedFromToolCallId: parentResult?.execId || undefined,
    message: {
      case: "grepResult",
      value: {
        result: {
          case: "success",
          value: {
            pattern: stringOrEmpty(childArgs.pattern),
            outputMode: normalizedGrepOutputMode(childArgs),
            workspaceResults: filteredWorkspaceResults,
          },
        },
      },
    },
  };
}

function compileDerivedGrepRegex(args) {
  const pattern = stringOrEmpty(args?.pattern);
  if (!pattern) return null;
  try {
    return new RegExp(pattern, args?.["-i"] ? "i" : "");
  } catch {
    return null;
  }
}

function buildOpenAiClient(provider) {
  const OpenAI = require("openai");
  const authValue = provider.auth?.value || "";
  const defaultHeaders = buildOpenAiDefaultHeaders(provider);
  const usesApiKeyHeader = hasHeader(defaultHeaders, "api-key");
  return new OpenAI({
    apiKey: usesApiKeyHeader ? "unused" : authValue || process.env.OPENAI_API_KEY || "unused",
    baseURL: provider.baseUrl,
    defaultHeaders,
  });
}

function buildOpenAiDefaultHeaders(provider) {
  const headers = provider.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers)
    ? { ...provider.headers }
    : {};
  const authValue = provider.auth?.value || "";
  if (provider.auth?.kind === "api-key" && authValue) {
    deleteHeader(headers, "authorization");
    deleteHeader(headers, "api-key");
    headers.Authorization = null;
    headers["api-key"] = authValue;
    return headers;
  }
  if (authValue) {
    deleteHeader(headers, "authorization");
    deleteHeader(headers, "api-key");
    return Object.keys(headers).length ? headers : undefined;
  }
  if (hasHeader(headers, "api-key")) {
    const authHeader = getHeader(headers, "api-key");
    deleteHeader(headers, "authorization");
    deleteHeader(headers, "api-key");
    headers.Authorization = null;
    headers["api-key"] = authHeader;
  }
  return Object.keys(headers).length ? headers : undefined;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName && headers[key] !== undefined && headers[key] !== null) return headers[key];
  }
  return undefined;
}

function hasHeader(headers, name) {
  if (!headers || typeof headers !== "object") return false;
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName && headers[key] !== undefined && headers[key] !== null) return true;
  }
  return false;
}

function deleteHeader(headers, name) {
  if (!headers || typeof headers !== "object") return;
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) delete headers[key];
  }
}

function buildAnthropicClient(provider) {
  const Anthropic = require("@anthropic-ai/sdk");
  const authValue = provider.auth?.value || "";
  const defaultHeaders = buildAnthropicDefaultHeaders(provider);
  return new Anthropic({
    apiKey: hasHeader(defaultHeaders, "x-api-key") ? null : authValue || process.env.ANTHROPIC_API_KEY || "unused",
    // Never let the SDK pick up ANTHROPIC_AUTH_TOKEN from the environment: BYOK
    // requests go to user-configured third-party baseUrls, and an implicit
    // `Authorization: Bearer <local token>` header would leak the developer's
    // Anthropic credential to that host.
    authToken: null,
    baseURL: provider.baseUrl,
    defaultHeaders,
  });
}

function buildAnthropicDefaultHeaders(provider) {
  const headers = provider.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers)
    ? { ...provider.headers }
    : {};
  const authValue = provider.auth?.value || "";
  if (authValue) {
    deleteHeader(headers, "authorization");
    deleteHeader(headers, "x-api-key");
    headers["x-api-key"] = authValue;
  }
  return Object.keys(headers).length ? headers : undefined;
}

function buildPrompt(request) {
  const conversationId = request?.conversationId || request?.conversationState?.conversationId || "";
  const system = request?.systemPrompt || request?.system || "";
  const rawMessages = Array.isArray(request?.messages) ? request.messages : [];
  const messages = rawMessages.map(normalizeProviderMessage).filter(Boolean);
  return {
    conversationId,
    system,
    messages,
    composerMode: stringOrEmpty(request?.composerMode ?? request?.composer_mode ?? request?.mode),
    workspaceRoots: Array.isArray(request?.workspaceRoots) ? request.workspaceRoots.filter((value) => typeof value === "string" && value) : [],
    tools: Array.isArray(request?.tools) && request.tools.length
      ? request.tools
      : defaultCursorBuiltinTools(),
  };
}

function shouldStopAfterSuccessfulCreatePlan(toolUses, validToolResultById) {
  for (const toolUse of toolUses) {
    if (toolUse.validationError || toolUse.executionName !== "CreatePlan") continue;
    if (interactionToolResultCase(validToolResultById.get(toolUse.id)) === "success") return true;
  }
  return false;
}

function interactionToolResultCase(toolResult) {
  const value = toolResult?.message?.value;
  if (toolResult?.message?.case !== "byokInteractionToolResult" || !value) return "";
  const response = value.interactionResponse;
  const top = response?.result;
  if (top?.case !== "createPlanRequestResponse") return "";
  // The binary protocol decoder wraps the result oneof twice
  // (value.result.result.case); local timeout/error envelopes wrap it once
  // (value.result.case). Accept both so plan mode stops on real decoded
  // successes and keeps running on rejections regardless of producer.
  const nested = top.value?.result;
  if (typeof nested?.case === "string") return nested.case;
  const decoded = nested?.result;
  return typeof decoded?.case === "string" ? decoded.case : "";
}

function planModeDoneEvent(usage) {
  const resolved = usage && typeof usage === "object" ? usage : {};
  return {
    type: "done",
    stopReason: "end_turn",
    usage: {
      inputTokens: resolved.inputTokens || 0,
      outputTokens: resolved.outputTokens || 0,
      cacheReadTokens: resolved.cacheReadTokens || 0,
      cacheWriteTokens: resolved.cacheWriteTokens || 0,
    },
  };
}

function normalizeProviderMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (isNativeResponsesInputItem(message)) return message;
  if (message.type === "function_call" || message.type === "function_call_output" || message.type === "custom_tool_call_output") return message;
  if (message.type === "message" && openAiMessageRole(message.role)) return normalizeResponsesMessageItem(message);
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: normalizeAssistantContent(message),
      ...(message.name !== undefined ? { name: message.name } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
  }
  if (message.role === "tool" || message.type === "tool_result" || message.toolResult) {
    return normalizeToolResultMessage(message);
  }
  const role = openAiMessageRole(message.role);
  if (role) {
    return {
      role,
      content: normalizeMessageContent(message.content ?? message.text ?? ""),
      ...(message.name !== undefined ? { name: message.name } : {}),
    };
  }
  return {
    role: "user",
    content: normalizeMessageContent(message.content ?? message.text ?? message),
  };
}

function sanitizeAnthropicMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  return messages.map(sanitizeAnthropicMessage);
}

function sanitizeAnthropicMessage(message) {
  if (!message || typeof message !== "object") return message;
  const next = { role: message.role === "assistant" ? "assistant" : "user" };
  if (Array.isArray(message.content)) {
    next.content = message.content.map(sanitizeAnthropicContentBlock);
  } else {
    next.content = message.content;
  }
  return next;
}

function sanitizeAnthropicContentBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  switch (block.type) {
    case "text": {
      const next = { type: "text", text: block.text ?? "" };
      if (block.cache_control !== undefined) next.cache_control = block.cache_control;
      return next;
    }
    case "image": {
      const next = { type: "image", source: block.source };
      if (block.cache_control !== undefined) next.cache_control = block.cache_control;
      return next;
    }
    case "document": {
      const next = { type: "document", source: block.source };
      if (block.cache_control !== undefined) next.cache_control = block.cache_control;
      if (block.title !== undefined) next.title = block.title;
      if (block.context !== undefined) next.context = block.context;
      if (block.citations !== undefined) next.citations = block.citations;
      return next;
    }
    case "tool_use": {
      const next = {
        type: "tool_use",
        id: toolCallIdFrom(block),
        name: toolCallNameFrom(block),
        input: normalizeToolInput(block.input ?? block.arguments ?? block.args),
      };
      if (block.cache_control !== undefined) next.cache_control = block.cache_control;
      return next;
    }
    case "tool_result": {
      const next = {
        type: "tool_result",
        tool_use_id: toolCallIdFrom(block),
        content: normalizeAnthropicToolResultContent(block.content),
      };
      if (block.is_error !== undefined) next.is_error = block.is_error;
      if (block.cache_control !== undefined) next.cache_control = block.cache_control;
      return next;
    }
    default:
      return block;
  }
}

function normalizeAssistantContent(message) {
  if (Array.isArray(message.content)) return message.content;
  if (message.toolUse || message.tool_use) {
    const toolUse = message.toolUse || message.tool_use;
    return [{
      type: "tool_use",
      id: toolCallIdFrom(toolUse, message),
      name: toolCallNameFrom(toolUse, message),
      input: normalizeToolInput(toolUse.input ?? toolUse.arguments ?? toolUse.args),
    }];
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length && message.content == null && message.text == null) return null;
  return normalizeMessageContent(message.content ?? message.text ?? "");
}

function normalizeToolResultMessage(message) {
  const toolResult = message.toolResult || message.tool_result || message;
  const toolUseId = toolCallIdFrom(toolResult, message);
  const content = normalizeMessageContent(toolResult.content ?? toolResult.output ?? toolResult.result ?? toolResult.text ?? message.content ?? "");
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: toolUseId,
      ...(message.name !== undefined ? { name: message.name } : {}),
      content,
    };
  }
  return {
    role: "user",
    content: [anthropicToolResultBlock(toolResult, toolUseId, content)],
  };
}

function anthropicToolResultBlock(toolResult, toolUseId, content) {
  const block = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
  };
  if (toolResult.is_error !== undefined) block.is_error = toolResult.is_error;
  if (toolResult.cache_control !== undefined) block.cache_control = toolResult.cache_control;
  return block;
}

function anthropicToolResultMessage(toolResult, output) {
  return {
    role: "user",
    content: [anthropicToolResultBlock(toolResult, output.id, output.content)],
  };
}

function toOpenAiChatMessages(message) {
  if (!message || typeof message !== "object") return [{ role: "user", content: String(message ?? "") }];
  if (message.type === "function_call") {
    const call = normalizeProviderFunctionCall(message);
    return [{
      role: "assistant",
      content: null,
      tool_calls: [openAiChatToolCallFromNormalizedCall(call)],
    }];
  }
  if (message.type === "custom_tool_call") {
    return [{
      role: "assistant",
      content: null,
      tool_calls: [openAiChatToolCallFromResponsesCustomToolCall(message)],
    }];
  }
  if (message.type === "function_call_output" || message.type === "custom_tool_call_output") {
    const output = normalizeProviderFunctionCallOutput(message);
    return [{
      role: "tool",
      tool_call_id: output.id,
      content: output.content,
    }];
  }
  if (isNativeResponsesInputItem(message)) return [{ role: "user", content: nativeResponsesInputItemText(message) }];
  if (message.role === "tool") {
    return [{
      role: "tool",
      tool_call_id: toolCallIdFrom(message),
      ...(message.name !== undefined ? { name: message.name } : {}),
      content: normalizeToolResultTextContent(message.content ?? ""),
    }];
  }
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    const content = providerTextFromMessageContent(message.content ?? "");
    return [{
      role: "assistant",
      content: content || null,
      ...(message.name !== undefined ? { name: message.name } : {}),
      tool_calls: message.tool_calls.map(normalizeOpenAiChatToolCall),
    }];
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const out = [];
    const textBlocks = [];
    const toolCalls = [];
    for (const block of message.content) {
      if (block?.type === "custom_tool_call") {
        toolCalls.push(openAiChatToolCallFromResponsesCustomToolCall(block));
      } else if (block?.type === "tool_use" || block?.type === "function_call") {
        const call = block.type === "function_call"
          ? normalizeProviderFunctionCall(block)
          : {
              id: toolCallIdFrom(block),
              name: toolCallNameFrom(block),
              arguments: normalizeToolCallArguments(block.input ?? block.arguments ?? block.args),
            };
        toolCalls.push(openAiChatToolCallFromNormalizedCall(call));
      } else {
        const text = providerTextFromContentBlock(block);
        if (text) textBlocks.push(text);
      }
    }
    const content = textBlocks.length ? textBlocks.join("\n") : null;
    if (toolCalls.length) {
      out.push({
        role: "assistant",
        content,
        ...(message.name !== undefined ? { name: message.name } : {}),
        tool_calls: toolCalls,
      });
    } else if (content) {
      out.push({
        role: "assistant",
        content,
        ...(message.name !== undefined ? { name: message.name } : {}),
      });
    }
    if (out.length) return out;
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    const out = [];
    const userBlocks = [];
    for (const block of message.content) {
      if (block?.type === "tool_result" || block?.type === "function_call_output" || block?.type === "custom_tool_call_output") {
        const output = block.type === "function_call_output" || block.type === "custom_tool_call_output"
          ? normalizeProviderFunctionCallOutput(block)
          : { id: toolCallIdFrom(block), content: normalizeToolResultTextContent(block.content ?? "") };
        out.push({
          role: "tool",
          tool_call_id: output.id,
          content: output.content,
        });
      } else {
        userBlocks.push(block);
      }
    }
    if (userBlocks.length) out.unshift({ role: "user", content: openAiChatUserContentFromBlocks(userBlocks) });
    if (out.length) return out;
  }
  return [{
    role: openAiMessageRole(message.role) || "user",
    content: openAiChatMessageContent(message),
    ...(message.name !== undefined && openAiMessageRole(message.role) ? { name: message.name } : {}),
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls.map(normalizeOpenAiChatToolCall) } : {}),
  }];
}

function openAiChatMessageContent(message) {
  if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    if (message.content === null || message.content === undefined) return null;
  }
  return normalizeMessageContent(message.content ?? message.text ?? message);
}

function toAnthropicMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  return messages.flatMap(toAnthropicMessageItems).map(sanitizeAnthropicMessage);
}

function toAnthropicMessageItems(message) {
  if (!message || typeof message !== "object") return [{ role: "user", content: String(message ?? "") }];
  if (message.type === "function_call") {
    const call = normalizeProviderFunctionCall(message);
    return [{
      role: "assistant",
      content: [{
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: normalizeToolInput(call.arguments),
      }],
    }];
  }
  if (message.type === "custom_tool_call") {
    return [{
      role: "assistant",
      content: [anthropicToolUseFromResponsesCustomToolCall(message)],
    }];
  }
  if (message.type === "function_call_output" || message.type === "custom_tool_call_output") {
    const output = normalizeProviderFunctionCallOutput(message, "anthropic");
    return [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: output.id,
        content: output.content,
      }],
    }];
  }
  if (isNativeResponsesInputItem(message)) {
    return [{ role: "user", content: [{ type: "text", text: nativeResponsesInputItemText(message) }] }];
  }
  if (message.role === "tool") {
    return [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolCallIdFrom(message),
        content: normalizeAnthropicToolResultContent(message.content ?? ""),
      }],
    }];
  }
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    const content = [];
    const text = providerTextFromMessageContent(message.content ?? "");
    if (text) content.push({ type: "text", text });
    for (const call of message.tool_calls) {
      const normalizedCall = normalizeOpenAiChatToolCall(call);
      content.push(anthropicToolUseFromOpenAiChatToolCall(normalizedCall));
    }
    return [{ role: "assistant", content }];
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const content = [];
    for (const block of message.content) {
      if (block?.type === "custom_tool_call") {
        content.push(anthropicToolUseFromResponsesCustomToolCall(block));
      } else if (block?.type === "function_call") {
        const call = normalizeProviderFunctionCall(block);
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: normalizeToolInput(call.arguments),
        });
      } else if (isOpenAiResponsesMessageContentBlock(block)) {
        const text = providerTextFromContentBlock(block);
        if (text) content.push({ type: "text", text });
      } else {
        content.push(block);
      }
    }
    return [{ role: "assistant", content }];
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    const out = [];
    const userBlocks = [];
    for (const block of message.content) {
      if (block?.type === "tool_result" || block?.type === "function_call_output" || block?.type === "custom_tool_call_output") {
        const output = normalizeProviderFunctionCallOutput(block, "anthropic");
        out.push(anthropicToolResultMessage(block, output));
      } else {
        userBlocks.push(block);
      }
    }
    if (userBlocks.length) out.unshift({ role: "user", content: anthropicUserContentFromBlocks(userBlocks) });
    if (out.length) return out;
  }
  return [message];
}

function toResponsesInputItems(message) {
  if (!message || typeof message !== "object") return [{ role: "user", content: String(message ?? "") }];
  if (message.type === "message" && openAiMessageRole(message.role)) return [normalizeResponsesMessageItem(message)];
  if (message.type === "function_call") {
    const call = normalizeProviderFunctionCall(message);
    const item = {
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    };
    addResponsesItemMetadata(item, message);
    return [item];
  }
  if (message.type === "function_call_output" || message.type === "custom_tool_call_output") {
    const output = normalizeProviderFunctionCallOutput(message, "openai-responses");
    const item = {
      type: message.type === "custom_tool_call_output" ? "custom_tool_call_output" : "function_call_output",
      call_id: output.id,
      output: output.content,
    };
    addResponsesItemMetadata(item, message);
    return [item];
  }
  if (isNativeResponsesInputItem(message)) return [message];
  if (message.role === "tool") {
    return [{
      type: "function_call_output",
      call_id: toolCallIdFrom(message),
      output: normalizeToolResultTextContent(message.content ?? ""),
    }];
  }
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    const out = [];
    const content = providerTextFromMessageContent(message.content ?? "");
    if (content) out.push({ role: "assistant", content });
    for (const call of message.tool_calls) {
      const normalizedCall = normalizeOpenAiChatToolCall(call);
      out.push(responsesToolCallFromOpenAiChatToolCall(normalizedCall));
    }
    return out;
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const out = [];
    const textBlocks = [];
    for (const block of message.content) {
      if (block?.type === "custom_tool_call") {
        out.push(responsesCustomToolCallFromResponsesCustomToolCall(block));
      } else if (block?.type === "tool_use" || block?.type === "function_call") {
        const call = block.type === "function_call"
          ? normalizeProviderFunctionCall(block)
          : {
              id: toolCallIdFrom(block),
              name: toolCallNameFrom(block),
              arguments: normalizeToolCallArguments(block.input ?? block.arguments ?? block.args),
            };
        const item = {
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        };
        if (block.type === "function_call") addResponsesItemMetadata(item, block);
        out.push(item);
      } else {
        const text = providerTextFromContentBlock(block);
        if (text) textBlocks.push(text);
      }
    }
    if (textBlocks.length) out.unshift({ role: "assistant", content: textBlocks.join("\n") });
    if (out.length) return out;
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    const out = [];
    const userBlocks = [];
    for (const block of message.content) {
      if (block?.type === "tool_result" || block?.type === "function_call_output" || block?.type === "custom_tool_call_output") {
        const output = block.type === "function_call_output" || block.type === "custom_tool_call_output"
          ? normalizeProviderFunctionCallOutput(block, "openai-responses")
          : { id: toolCallIdFrom(block), content: normalizeToolResultTextContent(block.content ?? "") };
        const item = {
          type: block.type === "custom_tool_call_output" ? "custom_tool_call_output" : "function_call_output",
          call_id: output.id,
          output: output.content,
        };
        if (block.type === "function_call_output" || block.type === "custom_tool_call_output") addResponsesItemMetadata(item, block);
        out.push(item);
      } else {
        userBlocks.push(block);
      }
    }
    if (userBlocks.length) out.unshift({ role: "user", content: responsesUserContentFromBlocks(userBlocks) });
    if (out.length) return out;
  }
  return [{
    role: openAiMessageRole(message.role) || "user",
    content: normalizeMessageContent(message.content ?? message.text ?? message),
  }];
}

const NATIVE_RESPONSES_INPUT_ITEM_TYPES = new Set([
  "additional_tools",
  "apply_patch_call",
  "apply_patch_call_output",
  "code_interpreter_call",
  "compaction",
  "compaction_trigger",
  "computer_call",
  "computer_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "file_search_call",
  "image_generation_call",
  "item_reference",
  "local_shell_call",
  "local_shell_call_output",
  "mcp_approval_request",
  "mcp_approval_response",
  "mcp_call",
  "mcp_list_tools",
  "reasoning",
  "shell_call",
  "shell_call_output",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
]);

function isNativeResponsesInputItem(message) {
  return !!(message
    && typeof message === "object"
    && !Array.isArray(message)
    && NATIVE_RESPONSES_INPUT_ITEM_TYPES.has(message.type));
}

function isNativeResponsesHistoryItem(message) {
  return message?.type === "function_call_output" || isNativeResponsesInputItem(message);
}

function nativeResponsesInputItemText(message) {
  if (message?.type === "reasoning") {
    const summary = Array.isArray(message.summary)
      ? message.summary.map((item) => item?.type === "summary_text" ? stringOrEmpty(item.text) : "").filter(Boolean).join("\n")
      : "";
    const id = stringOrEmpty(message.id);
    const status = stringOrEmpty(message.status);
    const fields = [
      id ? `id: ${id}` : "",
      status ? `status: ${status}` : "",
      summary ? `summary:\n${summary}` : "",
    ].filter(Boolean).join("\n");
    return fields ? `OpenAI Responses reasoning item:\n${fields}` : "OpenAI Responses reasoning item.";
  }
  return `OpenAI Responses ${message.type} item:\n${safeJson(message, 12000)}`;
}

function openAiMessageRole(role) {
  switch (role) {
    case "assistant":
    case "developer":
    case "system":
    case "user":
      return role;
    default:
      return "";
  }
}

function addResponsesItemMetadata(item, message) {
  if (!message || typeof message !== "object") return item;
  if (!hasExplicitToolCallId(message)) return item;
  if (message.id !== undefined) item.id = message.id;
  if (message.status !== undefined) item.status = message.status;
  if (message.created_by !== undefined) item.created_by = message.created_by;
  if (message.namespace !== undefined && item.type === "function_call") item.namespace = message.namespace;
  return item;
}

function normalizeResponsesMessageItem(message) {
  const role = openAiMessageRole(message.role);
  const item = {
    type: "message",
    role,
    content: normalizeResponsesMessageContent(message.content ?? message.text ?? "", role),
  };
  if (message.id !== undefined) item.id = message.id;
  if (message.status !== undefined) item.status = message.status;
  if (message.phase !== undefined && role === "assistant") item.phase = message.phase;
  return item;
}

function normalizeResponsesMessageContent(content, role) {
  if (Array.isArray(content)) {
    if (role === "assistant") return responsesAssistantContentFromBlocks(content);
    return responsesUserContentFromBlocks(content);
  }
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  if (role === "assistant") return [{ type: "output_text", text, annotations: [] }];
  return [{ type: "input_text", text }];
}

function responsesAssistantContentFromBlocks(blocks) {
  const out = [];
  for (const block of blocks) {
    const part = responsesAssistantContentPartFromBlock(block);
    if (part) out.push(part);
  }
  return out.length ? out : [{ type: "output_text", text: providerTextFromMessageContent(blocks), annotations: [] }];
}

function responsesAssistantContentPartFromBlock(block) {
  if (typeof block === "string") return { type: "output_text", text: block, annotations: [] };
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  switch (block.type) {
    case "output_text":
      return {
        type: "output_text",
        text: stringOrEmpty(block.text) || providerTextFromContentBlock(block),
        annotations: Array.isArray(block.annotations) ? block.annotations : [],
      };
    case "refusal": {
      const refusal = stringOrEmpty(block.refusal) || stringOrEmpty(block.text) || providerTextFromContentBlock(block);
      return refusal ? { type: "refusal", refusal } : null;
    }
    case "input_text":
    case "text": {
      const text = providerTextFromContentBlock(block);
      return text ? { type: "output_text", text, annotations: [] } : null;
    }
    default: {
      const text = providerTextFromContentBlock(block);
      return text ? { type: "output_text", text, annotations: [] } : null;
    }
  }
}

function responsesUserContentFromBlocks(blocks) {
  const out = [];
  for (const block of blocks) {
    const part = responsesUserContentPartFromBlock(block);
    if (part) out.push(part);
  }
  return out.length ? out : normalizeMessageContent(blocks);
}

function responsesUserContentPartFromBlock(block) {
  if (typeof block === "string") return { type: "input_text", text: block };
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  switch (block.type) {
    case "input_text":
    case "input_image":
    case "input_file":
      return block;
    case "text":
    case "output_text":
    case "refusal": {
      const text = providerTextFromContentBlock(block);
      return text ? { type: "input_text", text } : null;
    }
    case "image_url": {
      const imageUrl = block.image_url && typeof block.image_url === "object" ? block.image_url : {};
      const url = stringOrEmpty(imageUrl.url) || stringOrEmpty(block.url);
      if (!url) return { type: "input_text", text: providerTextFromContentBlock(block) };
      const out = { type: "input_image", image_url: url };
      if (imageUrl.detail !== undefined) out.detail = imageUrl.detail;
      if (block.detail !== undefined) out.detail = block.detail;
      return out;
    }
    case "image": {
      const url = providerInputImageUrlFromBlock(block);
      if (!url) return { type: "input_text", text: providerTextFromContentBlock(block) };
      const out = { type: "input_image", image_url: url };
      if (block.detail !== undefined) out.detail = block.detail;
      return out;
    }
    case "file": {
      const sourceFile = block.file && typeof block.file === "object" ? block.file : {};
      const file = pickFileFields(sourceFile, block);
      const out = { type: "input_file", ...file };
      return Object.keys(out).length > 1 ? out : { type: "input_text", text: providerTextFromContentBlock(block) };
    }
    default: {
      const text = providerTextFromContentBlock(block);
      return text ? { type: "input_text", text } : null;
    }
  }
}

function hasExplicitToolCallId(message) {
  return firstNonEmptyString(
    message?.call_id,
    message?.callId,
    message?.tool_call_id,
    message?.toolCallId,
    message?.tool_use_id,
    message?.toolUseId,
  ) !== "";
}

function normalizeToolInputOnce(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeToolInput(value) {
  const normalized = normalizeToolInputOnce(value);
  if (typeof normalized !== "string" || normalized === value) return normalized;
  return normalizeToolInputOnce(normalized);
}

function repairedStructuredToolArguments(rawArguments, input) {
  if (typeof rawArguments !== "string" || !input || typeof input !== "object" || Array.isArray(input)) return rawArguments;
  const once = normalizeToolInputOnce(rawArguments);
  return once && typeof once === "object" && !Array.isArray(once) ? rawArguments : JSON.stringify(input);
}

function normalizeOpenAiChatToolCall(call) {
  if (!call || typeof call !== "object") {
    return { id: undefined, type: "function", function: { name: "", arguments: "{}" } };
  }
  if (call.type === "custom" || call.custom) {
    const custom = call.custom && typeof call.custom === "object" ? call.custom : {};
    return {
      id: toolCallIdFrom(call),
      type: "custom",
      custom: {
        name: firstNonEmptyString(custom.name, call.name, call.toolName, call.tool_name),
        input: normalizeCustomToolCallInput(custom.input ?? call.input ?? call.arguments ?? call.args),
      },
    };
  }
  const fn = call.function && typeof call.function === "object" ? call.function : {};
  const name = firstNonEmptyString(fn.name, call.name, call.toolName, call.tool_name);
  const rawArguments = fn.arguments ?? call.arguments ?? call.input ?? call.args;
  return {
    id: toolCallIdFrom(call),
    type: "function",
    function: {
      name,
      arguments: normalizeToolCallArguments(rawArguments),
    },
  };
}

function normalizeProviderFunctionCall(message) {
  const normalized = normalizeOpenAiChatToolCall(message);
  if (normalized.type === "custom") {
    return {
      id: normalized.id,
      name: normalized.custom.name,
      arguments: normalized.custom.input,
      isCustom: true,
    };
  }
  return {
    id: normalized.id,
    name: normalized.function.name,
    arguments: normalized.function.arguments,
    isCustom: false,
  };
}

function openAiChatToolCallFromNormalizedCall(call) {
  if (call?.isCustom) {
    return {
      id: call.id,
      type: "custom",
      custom: {
        name: call.name,
        input: normalizeCustomToolCallInput(call.arguments),
      },
    };
  }
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: normalizeToolCallArguments(call.arguments),
    },
  };
}

function responsesToolCallFromOpenAiChatToolCall(call) {
  if (call?.type === "custom") {
    return {
      type: "custom_tool_call",
      call_id: call.id,
      name: call.custom?.name || "",
      input: normalizeCustomToolCallInput(call.custom?.input),
    };
  }
  const fn = call?.function || {};
  return {
    type: "function_call",
    call_id: call?.id,
    name: fn.name || "",
    arguments: normalizeToolCallArguments(fn.arguments),
  };
}

function openAiChatToolCallFromResponsesCustomToolCall(call) {
  return {
    id: toolCallIdFrom(call),
    type: "custom",
    custom: {
      name: toolCallNameFrom(call),
      input: normalizeCustomToolCallInput(call?.input ?? call?.arguments ?? call?.args),
    },
  };
}

function anthropicToolUseFromResponsesCustomToolCall(call) {
  return {
    type: "tool_use",
    id: toolCallIdFrom(call),
    name: toolCallNameFrom(call),
    input: normalizeAnthropicToolUseInput(call?.input ?? call?.arguments ?? call?.args),
  };
}

function responsesCustomToolCallFromResponsesCustomToolCall(call) {
  const item = {
    type: "custom_tool_call",
    call_id: toolCallIdFrom(call),
    name: toolCallNameFrom(call),
    input: normalizeCustomToolCallInput(call?.input ?? call?.arguments ?? call?.args),
  };
  addResponsesItemMetadata(item, call);
  return item;
}

function anthropicToolUseFromOpenAiChatToolCall(call) {
  if (call?.type === "custom") {
    return {
      type: "tool_use",
      id: call.id,
      name: call.custom?.name || "",
      input: normalizeAnthropicToolUseInput(call.custom?.input),
    };
  }
  const fn = call?.function || {};
  return {
    type: "tool_use",
    id: call?.id,
    name: fn.name || "",
    input: normalizeToolInput(fn.arguments),
  };
}

function normalizeAnthropicToolUseInput(value) {
  const input = normalizeToolInput(value);
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  return { input: normalizeCustomToolCallInput(value) };
}

function normalizeProviderFunctionCallOutput(message, providerType = "") {
  const value = message.output ?? message.content ?? message.result ?? message.text ?? "";
  return {
    id: toolCallIdFrom(message),
    content: providerType === "anthropic"
      ? normalizeAnthropicToolResultContent(value)
      : providerType === "openai-responses" && isOpenAiResponsesFunctionOutputContent(value)
        ? value
        : normalizeToolResultTextContent(value),
  };
}

function isOpenAiResponsesFunctionOutputContent(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((block) => block
      && typeof block === "object"
      && !Array.isArray(block)
      && (block.type === "input_text" || block.type === "input_image" || block.type === "input_file"));
}

function toolCallIdFrom(value, fallback) {
  return firstNonEmptyString(
    value?.call_id,
    value?.callId,
    value?.tool_call_id,
    value?.toolCallId,
    value?.tool_use_id,
    value?.toolUseId,
    value?.id,
    fallback?.call_id,
    fallback?.callId,
    fallback?.tool_call_id,
    fallback?.toolCallId,
    fallback?.tool_use_id,
    fallback?.toolUseId,
    fallback?.id,
  );
}

function toolCallNameFrom(value, fallback) {
  return firstNonEmptyString(
    value?.name,
    value?.toolName,
    value?.tool_name,
    fallback?.name,
    fallback?.toolName,
    fallback?.tool_name,
  );
}

function normalizeToolCallArguments(value) {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value === "string") return value;
  return JSON.stringify(normalizeToolInput(value));
}

function normalizeCustomToolCallInput(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(normalizeToolInput(value));
}

function toolArgumentKeys(value) {
  const input = normalizeToolInput(value);
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.keys(input).sort();
}

function readArgumentHasPath(value) {
  const input = normalizeToolInput(value);
  return !!(input && typeof input === "object" && input.path);
}

function readArgumentHasKey(value, key) {
  const input = normalizeToolInput(value);
  return !!(input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, key));
}

const READ_INPUT_KEYS = new Set(["path", "offset", "limit", "encodingHint"]);
const READ_INPUT_ALIAS_KEYS = new Set(["filePath", "file_path"]);
// Cursor's agent-exec output caps for the model-visible result text. Shell uses a
// 20k middle-out cap; WebFetch markdown a 30k tail cap (cursor-agent-exec 3.7.19).
const SHELL_OUTPUT_MAX_CHARS = 20000;
const FETCH_MARKDOWN_MAX_CHARS = 30000;
const LS_TREE_MAX_CHARS = 10000;
const GLOB_FILES_MAX_CHARS = 5000;
const PROVIDER_TOOL_NAME_ALIASES = new Map([
  ["Bash", "Shell"],
]);
const GREP_REDUNDANT_INPUT_KEYS = new Set(["-n"]);
const TOOL_PATH_INPUT_KEYS = new Map([
  ["Delete", ["path"]],
  ["Edit", ["path"]],
  ["EditNotebook", ["target_notebook"]],
  ["Glob", ["target_directory"]],
  ["Grep", ["path"]],
  ["LS", ["path", "target_directory"]],
  ["Read", ["path"]],
  ["ReadFile", ["path"]],
  ["ReadLints", ["paths"]],
  ["Shell", ["working_directory"]],
  ["WebFetch", []],
  ["Write", ["path"]],
]);
const DEDUPABLE_EXECUTION_TOOL_NAMES = new Set([
  "Glob",
  "Grep",
  "LS",
  "Read",
  "ReadLints",
]);

function providerToolAliasTarget(name) {
  return PROVIDER_TOOL_NAME_ALIASES.get(name) || "";
}

function normalizeProviderToolAliasName(name) {
  return providerToolAliasTarget(name) || name;
}

function usesProviderVisibleAlias(name, executionName) {
  return providerToolAliasTarget(name) === executionName;
}

function repairIfUnchanged(input, repaired) {
  const inputKeys = Object.keys(input);
  const repairedKeys = Object.keys(repaired);
  if (
    inputKeys.length === repairedKeys.length
    && inputKeys.every((key) => repaired[key] === input[key])
  ) {
    return input;
  }
  return repaired;
}

function repairProviderToolInput(name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  if (name === "WebSearch") {
    const repaired = {};
    const searchTerm = coalesceStringAliases(input, ["search_term", "searchTerm"]);
    if (searchTerm || input.search_term !== undefined || input.searchTerm !== undefined) {
      repaired.search_term = searchTerm;
    }
    if (input.explanation !== undefined) repaired.explanation = stringOrEmpty(input.explanation);
    return repairIfUnchanged(input, repaired);
  }
  if (name === "GenerateImage") {
    const repaired = {};
    if (input.description !== undefined) repaired.description = stringOrEmpty(input.description);
    const filename = coalesceStringAliases(input, ["filename", "filePath", "file_path"]);
    if (filename || input.filename !== undefined || input.filePath !== undefined || input.file_path !== undefined) {
      repaired.filename = filename;
    }
    const hasReferenceImages = input.reference_image_paths !== undefined || input.referenceImagePaths !== undefined;
    if (hasReferenceImages) {
      repaired.reference_image_paths = Array.isArray(input.reference_image_paths)
        ? input.reference_image_paths
        : Array.isArray(input.referenceImagePaths)
          ? input.referenceImagePaths
          : [];
    }
    return repairIfUnchanged(input, repaired);
  }
  if (name === "Grep") {
    let repaired = {};
    if (input.pattern !== undefined) repaired.pattern = stringOrEmpty(input.pattern);
    if (input.path !== undefined) repaired.path = stringOrEmpty(input.path);
    if (input.glob !== undefined) repaired.glob = stringOrEmpty(input.glob);
    if (input.type !== undefined) repaired.type = stringOrEmpty(input.type);
    if (input.output_mode !== undefined || input.outputMode !== undefined) {
      repaired.output_mode = coalesceStringAliases(input, ["output_mode", "outputMode"]);
    }
    if (input.sort !== undefined) repaired.sort = stringOrEmpty(input.sort);
    const contextBefore = normalizeInteger(input["-B"] ?? input.context_before ?? input.contextBefore);
    if (contextBefore !== undefined) repaired["-B"] = contextBefore;
    const contextAfter = normalizeInteger(input["-A"] ?? input.context_after ?? input.contextAfter);
    if (contextAfter !== undefined) repaired["-A"] = contextAfter;
    const context = normalizeInteger(input["-C"] ?? input.context);
    if (context !== undefined) repaired["-C"] = context;
    const headLimit = normalizeInteger(input.head_limit ?? input.headLimit);
    if (headLimit !== undefined) repaired.head_limit = headLimit;
    const offset = normalizeInteger(input.offset);
    if (offset !== undefined) repaired.offset = offset;
    if (input["-i"] !== undefined || input.case_insensitive !== undefined || input.caseInsensitive !== undefined) {
      repaired["-i"] = !!(input["-i"] ?? input.case_insensitive ?? input.caseInsensitive);
    }
    if (input.multiline !== undefined) repaired.multiline = !!input.multiline;
    if (input.sort_ascending !== undefined || input.sortAscending !== undefined) {
      repaired.sort_ascending = !!(input.sort_ascending ?? input.sortAscending);
    }
    if (!Object.keys(repaired).length) repaired = input;
    for (const key of GREP_REDUNDANT_INPUT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(repaired, key)) continue;
      if (repaired === input) repaired = { ...input };
      delete repaired[key];
    }
    return repairIfUnchanged(input, repaired);
  }
  if (name === "AwaitShell") {
    const repaired = {};
    if (input.shell_id !== undefined || input.shellId !== undefined) {
      repaired.shell_id = shellIdentifierString(input.shell_id ?? input.shellId);
    }
    if (input.task_id !== undefined || input.taskId !== undefined) {
      repaired.task_id = shellIdentifierString(input.task_id ?? input.taskId);
    }
    const blockUntilMs = normalizeInteger(input.block_until_ms ?? input.blockUntilMs);
    if (blockUntilMs !== undefined) repaired.block_until_ms = blockUntilMs;
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "LS") {
    const repaired = {};
    if (input.path !== undefined || input.target_directory !== undefined || input.targetDirectory !== undefined) {
      repaired.path = coalesceStringAliases(input, ["path", "target_directory", "targetDirectory"]);
    }
    if (input.ignore !== undefined) repaired.ignore = Array.isArray(input.ignore) ? input.ignore : [];
    if (input.ignore_globs !== undefined || input.ignoreGlobs !== undefined) {
      const ignoreGlobs = input.ignore_globs ?? input.ignoreGlobs;
      repaired.ignore_globs = Array.isArray(ignoreGlobs) ? ignoreGlobs : [];
    }
    const timeoutMs = normalizeInteger(input.timeout_ms ?? input.timeoutMs);
    if (timeoutMs !== undefined) repaired.timeout_ms = timeoutMs;
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "EditNotebook") {
    const repaired = {};
    if (input.target_notebook !== undefined || input.targetNotebook !== undefined) {
      repaired.target_notebook = coalesceStringAliases(input, ["target_notebook", "targetNotebook"]);
    }
    if (input.cell_idx !== undefined) repaired.cell_idx = normalizeInteger(input.cell_idx) ?? input.cell_idx;
    if (input.new_string !== undefined || input.newString !== undefined) {
      repaired.new_string = coalesceStringAliases(input, ["new_string", "newString"]);
    }
    if (input.old_string !== undefined || input.oldString !== undefined) {
      repaired.old_string = coalesceStringAliases(input, ["old_string", "oldString"]);
    }
    if (input.is_new_cell !== undefined) repaired.is_new_cell = input.is_new_cell;
    if (input.cell_language !== undefined) repaired.cell_language = stringOrEmpty(input.cell_language);
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "ReadLints") {
    const repaired = {};
    if (Array.isArray(input.paths)) repaired.paths = input.paths;
    else if (input.path !== undefined) repaired.paths = [stringOrEmpty(input.path)];
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "WebFetch") {
    const repaired = {};
    if (input.url !== undefined) repaired.url = stringOrEmpty(input.url);
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "ListMcpResources") {
    const repaired = {};
    if (input.server !== undefined) repaired.server = stringOrEmpty(input.server);
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "FetchMcpResource") {
    const repaired = {};
    if (input.server !== undefined) repaired.server = stringOrEmpty(input.server);
    if (input.uri !== undefined) repaired.uri = stringOrEmpty(input.uri);
    if (input.downloadPath !== undefined) repaired.downloadPath = stringOrEmpty(input.downloadPath);
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "Delete" || name === "Write" || name === "Edit") {
    const repaired = {};
    const pathKeys = ["path", "filePath", "file_path", "filename", "target_notebook", "targetNotebook"];
    if (pathKeys.some((key) => input[key] !== undefined)) {
      repaired.path = coalesceStringAliases(input, pathKeys);
    }
    if (name === "Write" && (input.contents !== undefined || input.content !== undefined || input.fileText !== undefined)) {
      repaired.contents = coalesceStringAliases(input, ["contents", "content", "fileText"]);
    }
    if (name === "Edit") {
      if (input.old_string !== undefined || input.oldString !== undefined || input.old !== undefined) {
        repaired.old_string = coalesceStringAliases(input, ["old_string", "oldString", "old"]);
      }
      if (input.new_string !== undefined || input.newString !== undefined || input.new !== undefined) {
        repaired.new_string = coalesceStringAliases(input, ["new_string", "newString", "new"]);
      }
      if (input.replace_all !== undefined) repaired.replace_all = !!input.replace_all;
    }
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "Shell") {
    const repaired = {};
    if (input.command !== undefined) repaired.command = stringOrEmpty(input.command);
    if (input.description !== undefined) repaired.description = stringOrEmpty(input.description);
    if (input.working_directory !== undefined || input.workingDirectory !== undefined || input.cwd !== undefined) {
      repaired.working_directory = coalesceStringAliases(input, ["working_directory", "workingDirectory", "cwd"]);
    }
    const timeout = normalizeInteger(input.block_until_ms ?? input.blockUntilMs ?? input.timeout);
    if (timeout !== undefined) repaired.block_until_ms = timeout;
    const hardTimeout = normalizeInteger(input.hardTimeout);
    if (hardTimeout !== undefined) repaired.hardTimeout = hardTimeout;
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "CallMcpTool") {
    const repaired = {};
    if (input.name !== undefined) repaired.name = stringOrEmpty(input.name);
    if (input.args !== undefined) repaired.args = input.args;
    if (input.providerIdentifier !== undefined || input.provider !== undefined) {
      repaired.providerIdentifier = coalesceStringAliases(input, ["providerIdentifier", "provider"]);
    }
    if (input.toolName !== undefined || input.tool_name !== undefined) {
      repaired.toolName = coalesceStringAliases(input, ["toolName", "tool_name"]);
    }
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "WriteShellStdin") {
    const repaired = {};
    if (input.shell_id !== undefined || input.shellId !== undefined) {
      repaired.shell_id = shellIdentifierString(input.shell_id ?? input.shellId);
    }
    if (input.chars !== undefined) repaired.chars = stringOrEmpty(input.chars);
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "ApplyPatch") {
    const repaired = {};
    if (input.patch !== undefined) repaired.patch = stringOrEmpty(input.patch);
    return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
  }
  if (name === "AskQuestion") return repairAskQuestionInput(input);
  if (name === "SwitchMode") return repairSwitchModeInput(input);
  if (name === "CreatePlan") return repairCreatePlanInput(input);
  if (name === "Glob") {
    const repaired = {};
    const pattern = coalesceStringAliases(input, ["glob_pattern", "globPattern", "pattern"]);
    if (pattern) repaired.glob_pattern = pattern;
    const targetDirectory = coalesceStringAliases(input, ["target_directory", "targetDirectory", "path"]);
    if (targetDirectory) repaired.target_directory = targetDirectory;
    if (!Object.keys(repaired).length) return input;
    return repairIfUnchanged(input, repaired);
  }
  return input;
}

function repairAskQuestionInput(input) {
  const repaired = {};
  if (input.title !== undefined) repaired.title = stringOrEmpty(input.title);
  if (input.questions !== undefined) {
    repaired.questions = Array.isArray(input.questions)
      ? input.questions.map(repairAskQuestionQuestionInput)
      : [];
  }
  return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
}

function repairAskQuestionQuestionInput(question) {
  const item = question && typeof question === "object" && !Array.isArray(question) ? question : {};
  const repaired = {
    id: stringOrEmpty(item.id),
    prompt: stringOrEmpty(item.prompt),
    options: Array.isArray(item.options) ? item.options.map(repairAskQuestionOptionInput) : [],
  };
  if (item.allow_multiple !== undefined || item.allowMultiple !== undefined) {
    repaired.allow_multiple = !!(item.allow_multiple ?? item.allowMultiple);
  }
  return repaired;
}

function repairAskQuestionOptionInput(option) {
  const item = option && typeof option === "object" && !Array.isArray(option) ? option : {};
  return {
    id: stringOrEmpty(item.id),
    label: stringOrEmpty(item.label),
  };
}

function repairSwitchModeInput(input) {
  const repaired = {};
  if (input.target_mode_id !== undefined || input.targetModeId !== undefined) {
    repaired.target_mode_id = coalesceStringAliases(input, ["target_mode_id", "targetModeId"]);
  }
  if (input.explanation !== undefined) repaired.explanation = stringOrEmpty(input.explanation);
  return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
}

function repairCreatePlanInput(input) {
  const repaired = {};
  if (input.name !== undefined) repaired.name = stringOrEmpty(input.name);
  if (input.overview !== undefined) repaired.overview = stringOrEmpty(input.overview);
  if (input.plan !== undefined) repaired.plan = stringOrEmpty(input.plan);
  if (input.todos !== undefined) repaired.todos = Array.isArray(input.todos) ? input.todos.map(repairCreatePlanTodoInput) : [];
  if (input.isProject !== undefined || input.is_project !== undefined) {
    repaired.isProject = !!(input.isProject ?? input.is_project);
  }
  if (input.phases !== undefined) repaired.phases = Array.isArray(input.phases) ? input.phases.map(repairCreatePlanPhaseInput) : [];
  return Object.keys(repaired).length ? repairIfUnchanged(input, repaired) : input;
}

function repairCreatePlanPhaseInput(phase) {
  const item = phase && typeof phase === "object" && !Array.isArray(phase) ? phase : {};
  return {
    name: stringOrEmpty(item.name),
    todos: Array.isArray(item.todos) ? item.todos.map(repairCreatePlanTodoInput) : [],
  };
}

function repairCreatePlanTodoInput(todo) {
  const item = todo && typeof todo === "object" && !Array.isArray(todo) ? todo : {};
  const repaired = {
    id: stringOrEmpty(item.id),
    content: stringOrEmpty(item.content),
    dependencies: Array.isArray(item.dependencies) ? item.dependencies.map(String) : [],
  };
  if (typeof item.status === "string") repaired.status = item.status;
  else {
    const status = normalizeInteger(item.status);
    if (status !== undefined) repaired.status = status;
  }
  return repaired;
}

function repairWorkspaceScopedToolInput(name, input, workspaceRoots) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const keys = TOOL_PATH_INPUT_KEYS.get(name);
  if (!Array.isArray(keys) || !keys.length) return input;
  let repaired = input;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(repaired, key)) continue;
    const value = repaired[key];
    const next = Array.isArray(value)
      ? value.map((item) => repairWorkspaceScopedPath(item, workspaceRoots))
      : repairWorkspaceScopedPath(value, workspaceRoots);
    if (next === value) continue;
    if (repaired === input) repaired = { ...input };
    repaired[key] = next;
  }
  return repaired;
}

function repairWorkspaceScopedPath(value, workspaceRoots) {
  if (typeof value !== "string" || !value || !nodePath.isAbsolute(value)) return value;
  const resolved = nodePath.resolve(value);
  if (fs.existsSync(resolved)) return resolved;
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
  for (const root of roots) {
    const repaired = repairWorkspaceRootPrefix(resolved, root);
    if (repaired && repaired !== resolved && fs.existsSync(repaired)) return repaired;
  }
  return resolved;
}

function repairWorkspaceRootPrefix(candidatePath, workspaceRoot) {
  if (typeof candidatePath !== "string" || typeof workspaceRoot !== "string" || !workspaceRoot) return "";
  const root = nodePath.resolve(workspaceRoot);
  const parent = nodePath.dirname(root);
  const rel = nodePath.relative(parent, candidatePath);
  if (!rel || rel.startsWith("..") || nodePath.isAbsolute(rel)) return "";
  const parts = rel.split(nodePath.sep).filter(Boolean);
  if (!parts.length) return "";
  const candidateRootName = parts[0];
  const expectedRootName = nodePath.basename(root);
  if (candidateRootName === expectedRootName) return "";
  if (!isSmallPathTypo(candidateRootName, expectedRootName)) return "";
  return nodePath.join(root, ...parts.slice(1));
}

function isSmallPathTypo(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  if (Math.abs(left.length - right.length) > 2) return false;
  if (left[0] !== right[0]) return false;
  return boundedLevenshtein(left, right, 2) <= 2;
}

function boundedLevenshtein(left, right, limit) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

function prepareProviderToolUse(name, input, rawArguments, providerMessages, toolDispatch, workspaceRoots = []) {
  const executionName = normalizeProviderToolAliasName(name);
  const repairedInput = repairProviderToolInput(executionName, input);
  const executionInput = repairWorkspaceScopedToolInput(executionName, repairedInput, workspaceRoots);
  const executionArguments = executionInput === input
    ? repairedStructuredToolArguments(rawArguments, executionInput)
    : stringifyRepairedToolArguments(rawArguments, executionInput);
  const providerHistoryName = usesProviderVisibleAlias(name, executionName) ? executionName : undefined;
  const providerHistoryArguments = providerHistoryName || executionInput !== input || executionArguments !== rawArguments
    ? executionArguments
    : undefined;
  if (BLOCKED_PROVIDER_TOOL_NAMES.has(executionName)) {
    return {
      executionName,
      executionInput,
      executionArguments,
      repaired: false,
      validationError: blockedProviderToolError(executionName),
      providerHistoryName,
      providerHistoryArguments,
    };
  }
  if (!toolDispatch?.providerToolNames?.has(executionName)) {
    return {
      executionName,
      executionInput,
      executionArguments,
      repaired: false,
      validationError: unknownProviderToolError(name),
      providerHistoryName,
      providerHistoryArguments,
    };
  }
  const schema = toolDispatch?.schemaByProviderName?.get(executionName);
  const mcp = providerMcpToolUse(executionName, executionInput, toolDispatch);
  if (mcp) {
    if (mcp.toolName === "mcp_auth") {
      const executionInput = mcpAuthExecutionInput(mcp, input);
      return {
        executionName: "mcp_auth",
        executionInput,
        executionArguments: stringifyRepairedToolArguments(rawArguments, executionInput),
        repaired: true,
        validationError: null,
      };
    }
    const validationError = validateProviderToolInput(executionName, executionInput, schema);
    if (validationError) {
      return {
        executionName,
        executionInput,
        executionArguments,
        repaired: false,
        validationError,
        providerHistoryName,
        providerHistoryArguments,
      };
    }
    return {
      executionName: "CallMcpTool",
      executionInput: mcp,
      executionArguments: stringifyRepairedToolArguments(rawArguments, mcp),
      repaired: true,
      validationError: null,
    };
  }
  if (!isReadToolName(executionName)) {
    const validationError = validateProviderToolInput(executionName, executionInput, schema);
    return {
      executionName,
      executionInput,
      executionArguments,
      repaired: executionName !== name || executionInput !== input || executionArguments !== rawArguments,
      validationError,
      providerHistoryName,
      providerHistoryArguments,
    };
  }
  const explicitExpected = explicitReadExpectedForInput(executionInput, providerMessages);
  const completedReadInput = completeReadToolUse(executionInput, explicitExpected);
  const validationError = validateReadToolUse(completedReadInput, providerMessages, executionInput);
  const completedReadArguments = completedReadInput === input
    ? repairedStructuredToolArguments(rawArguments, completedReadInput)
    : stringifyRepairedToolArguments(rawArguments, completedReadInput);
  if (!validationError) {
    return {
      executionName,
      executionInput: completedReadInput,
      executionArguments: completedReadArguments,
      repaired: executionName !== name || completedReadInput !== input || completedReadArguments !== rawArguments,
      validationError: null,
      providerHistoryName,
      providerHistoryArguments: completedReadArguments === rawArguments ? undefined : completedReadArguments,
    };
  }
  return {
    executionName,
    executionInput,
    executionArguments,
    repaired: false,
    validationError,
    providerHistoryName,
    providerHistoryArguments,
  };
}

function isUnsupportedCustomProviderToolUse(event) {
  return event?.providerToolType === "custom_tool_call" || event?.providerToolType === "custom";
}

function unsupportedCustomProviderToolUse(name, input, rawArguments, providerToolType) {
  const apiName = providerToolType === "custom" ? "OpenAI Chat" : "OpenAI Responses";
  const shape = providerToolType === "custom" ? "custom" : "custom_tool_call";
  return {
    executionName: name,
    executionInput: input,
    executionArguments: rawArguments,
    repaired: false,
    validationError: {
      reason: providerToolType === "custom" ? "unsupported_openai_chat_custom_tool" : "unsupported_responses_custom_tool",
      message: `Invalid ${name || shape} input: BYOK exposes Cursor tools to ${apiName} as function tools, not ${shape} tools.`,
    },
  };
}

function blockedProviderToolError(name) {
  return {
    reason: "blocked_provider_tool",
    message: `Invalid ${name} input: ${name} is filtered in BYOK mode and is not available as a BYOK provider tool.`,
  };
}

function unknownProviderToolError(name) {
  return {
    reason: "unknown_provider_tool",
    message: `Invalid ${name} input: ${name} is not available as a BYOK provider tool.`,
  };
}

function buildProviderToolDispatch(tools) {
  const mcpByProviderName = new Map();
  const schemaByProviderName = new Map();
  const providerToolNames = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.name) providerToolNames.add(tool.name);
    if (tool?.name && (tool.validationSchema || tool.inputSchema)) schemaByProviderName.set(tool.name, tool.validationSchema || tool.inputSchema);
    if (!isDirectMcpTool(tool)) continue;
    mcpByProviderName.set(tool.name, {
      providerIdentifier: tool.providerIdentifier,
      toolName: tool.toolName || tool.name,
      executionName: tool.executionName || officialMcpExecutionName(tool.providerIdentifier, tool.toolName),
      name: tool.name,
    });
  }
  return { mcpByProviderName, schemaByProviderName, providerToolNames };
}

function isDirectMcpTool(tool) {
  if (!tool || typeof tool !== "object") return false;
  if (BUILTIN_PROVIDER_TOOL_NAMES.has(tool.name)) return false;
  return typeof tool.providerIdentifier === "string" && tool.providerIdentifier.length > 0;
}

function providerMcpToolUse(name, input, toolDispatch) {
  const descriptor = toolDispatch?.mcpByProviderName?.get(name);
  if (!descriptor) return null;
  const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const toolName = descriptor.toolName || descriptor.name;
  return {
    name: descriptor.executionName || toolName,
    args,
    providerIdentifier: descriptor.providerIdentifier,
    toolName,
    displayName: descriptor.name,
  };
}

function mcpAuthExecutionInput(descriptor, input) {
  const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const serverIdentifier = stringOrEmpty(args.server_identifier) ||
    stringOrEmpty(args.serverIdentifier) ||
    stringOrEmpty(descriptor.providerIdentifier);
  return serverIdentifier ? { serverIdentifier } : {};
}

function officialMcpExecutionName(providerIdentifier, toolName) {
  if (typeof providerIdentifier !== "string" || !providerIdentifier) return "";
  if (typeof toolName !== "string" || !toolName) return "";
  return `${providerIdentifier}-${toolName}`;
}

function explicitReadExpectedForInput(input, providerMessages) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const pathCandidate = readPathCandidate(input);
  if (!pathCandidate) return null;
  const matchingExplicitArgs = explicitReadArgsListFromMessages(providerMessages, pathCandidate);
  return uniqueExplicitReadArgs(matchingExplicitArgs);
}

function completeReadToolUse(input, explicitExpected) {
  const normalizedInput = normalizeReadToolUseInput(input);
  if (!explicitExpected || !normalizedInput || typeof normalizedInput !== "object" || Array.isArray(normalizedInput)) {
    return normalizedInput;
  }
  if (!readInputUsesProviderSchema(normalizedInput)) return normalizedInput;
  if (normalizedInput.path !== explicitExpected.path) return normalizedInput;
  const out = { path: explicitExpected.path };
  for (const key of ["offset", "limit"]) {
    if (Number.isInteger(normalizedInput[key])) out[key] = normalizedInput[key];
    else if (Number.isInteger(explicitExpected[key])) out[key] = explicitExpected[key];
  }
  if (typeof normalizedInput.encodingHint === "string" && normalizedInput.encodingHint) {
    out.encodingHint = normalizedInput.encodingHint;
  }
  return out;
}

function normalizeReadToolUseInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out = {};
  const path = readPathAliasConflict(input) ? stringOrEmpty(input.path) : readPathCandidate(input);
  if (path) out.path = path;
  const offset = normalizeInteger(input.offset);
  if (offset !== undefined) out.offset = offset;
  const limit = normalizeInteger(input.limit);
  if (limit !== undefined) out.limit = limit;
  const encodingHint = stringOrEmpty(input.encodingHint);
  if (encodingHint) out.encodingHint = encodingHint;
  const inputKeys = Object.keys(input);
  const outKeys = Object.keys(out);
  if (
    inputKeys.length === outKeys.length
    && inputKeys.every((key) => READ_INPUT_KEYS.has(key))
    && outKeys.every((key) => input[key] === out[key])
  ) {
    return input;
  }
  return out;
}

function readInputUsesProviderSchema(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (typeof input.path !== "string" || input.path.length === 0) return false;
  for (const key of Object.keys(input)) {
    if (!READ_INPUT_KEYS.has(key)) return false;
  }
  return true;
}

function executableToolEvent(event, prepared) {
  if (!prepared?.repaired) return event;
  return { ...event, name: prepared.executionName || event.name, arguments: prepared.executionArguments };
}

function providerLocalToolResultEvent(event, prepared, toolResult) {
  return {
    ...executableToolEvent(event, prepared),
    localResult: {
      case: "byokExecResult",
      value: toolResult,
    },
  };
}

function localToolErrorEvent(event, prepared) {
  return {
    ...event,
    localResult: {
      case: "unsupportedToolResult",
      value: {
        result: {
          case: "error",
          value: {
            error: prepared.validationError.message,
          },
        },
      },
    },
  };
}

function providerHistoryToolArguments(toolUse) {
  if (toolUse?.providerHistoryArguments !== undefined) return toolUse.providerHistoryArguments;
  if (toolUse?.repaired && toolUse.executionName === toolUse.name && isReadToolName(toolUse.name)) {
    return toolUse.executionArguments || "{}";
  }
  if (toolUse?.providerToolType === "custom_tool_call" || toolUse?.providerToolType === "custom") return toolUse.arguments || "";
  return toolUse?.arguments || "{}";
}

function providerHistoryToolName(toolUse) {
  return toolUse?.providerHistoryName || toolUse?.name || "";
}

function providerHistoryAnthropicToolInput(toolUse) {
  if (toolUse?.providerHistoryArguments !== undefined) {
    const input = normalizeToolInput(toolUse.providerHistoryArguments);
    if (input && typeof input === "object" && !Array.isArray(input)) return input;
  }
  return toolUse.executionName !== toolUse.name ? toolUse.input : toolUse.executionInput;
}

function providerHistoryOpenAiChatToolCall(toolUse) {
  if (toolUse?.providerToolType === "custom") {
    return {
      id: toolUse.id,
      type: "custom",
      custom: {
        name: toolUse.name,
        input: providerHistoryToolArguments(toolUse),
      },
    };
  }
  return {
    id: toolUse.id,
    type: "function",
    function: {
      name: providerHistoryToolName(toolUse),
      arguments: providerHistoryToolArguments(toolUse),
    },
  };
}

function providerHistoryResponsesToolCall(toolUse) {
  if (toolUse?.providerToolType === "custom_tool_call") {
    const item = {
      type: "custom_tool_call",
      call_id: toolUse.id,
      name: toolUse.name,
      input: providerHistoryToolArguments(toolUse),
    };
    if (toolUse.itemId && toolUse.itemId !== toolUse.id) item.id = toolUse.itemId;
    return item;
  }
  return {
    type: "function_call",
    ...(toolUse.itemId && toolUse.itemId !== toolUse.id ? { id: toolUse.itemId } : {}),
    call_id: toolUse.id,
    name: providerHistoryToolName(toolUse),
    arguments: providerHistoryToolArguments(toolUse),
  };
}

function providerHistoryResponsesToolOutput(toolUse, output) {
  return {
    type: toolUse?.providerToolType === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
    call_id: toolUse.id,
    output,
  };
}

function isReadToolName(name) {
  return name === "Read" || name === "ReadFile";
}

function isTodoTrackingToolName(name) {
  return name === "TodoWrite" ||
    name === "TaskCreate" ||
    name === "TaskUpdate" ||
    name === "TaskList" ||
    name === "TaskGet";
}

function validateReadToolUse(input, providerMessages, rawInput = input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return providerToolValidationError("read-input-not-object", "Invalid Read input. Retry Read with a JSON object that uses path, offset, limit, and optional encodingHint.");
  }
  const raw = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : input;
  const unsupportedKeys = Object.keys(raw).filter((key) => !READ_INPUT_KEYS.has(key) && !READ_INPUT_ALIAS_KEYS.has(key)).sort();
  const pathCandidate = readPathCandidate(input);
  const matchingExplicitArgs = explicitReadArgsListFromMessages(providerMessages, pathCandidate);
  const explicitExpected = uniqueExplicitReadArgs(matchingExplicitArgs) || (matchingExplicitArgs.length ? null : uniqueExplicitReadArgs(explicitReadArgsListFromMessages(providerMessages)));
  const problems = [];
  if (unsupportedKeys.length) problems.push(`unsupported keys: ${unsupportedKeys.join(", ")}`);
  if (readPathAliasConflict(raw)) problems.push("conflicting path aliases");
  if (typeof input.path !== "string" || input.path.length === 0) problems.push("missing required string key: path");
  if (matchingExplicitArgs.length > 1 && !matchesAnyExplicitReadArgs(input, matchingExplicitArgs)) {
    problems.push(`multiple explicit Read ranges for ${pathCandidate || "this request"}; include the intended offset and limit in the Read input`);
  }
  if (explicitExpected && input.path !== explicitExpected.path) problems.push(`wrong path: expected ${explicitExpected.path}`);
  for (const key of ["offset", "limit"]) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && !Number.isInteger(input[key])) {
      problems.push(`${key} must be an integer`);
    }
    if (explicitExpected && Object.prototype.hasOwnProperty.call(explicitExpected, key) && input[key] !== explicitExpected[key]) {
      problems.push(`missing or wrong ${key}: expected ${explicitExpected[key]}`);
    }
  }
  if (!problems.length) return null;
  const retry = explicitExpected || sanitizedReadRetryArgs(input);
  const retryInstruction = matchingExplicitArgs.length > 1
    ? `Retry the Read tool with one of these explicit JSON objects exactly as requested: ${matchingExplicitArgs.map((candidate) => JSON.stringify(candidate)).join(" or ")}.`
    : `Retry the Read tool with exactly this JSON: ${JSON.stringify(retry)}.`;
  return providerToolValidationError(
    "invalid-read-input",
    `Invalid Read input (${problems.join("; ")}). BYOK exposes Cursor Read with path, offset, limit, and optional encodingHint. ${retryInstruction}`,
  );
}

function validateProviderToolInput(name, input, schema) {
  if (isReadToolName(name) || isInteractionBridgeTool(name) || isTodoTrackingToolName(name)) return null;
  if (!schema || typeof schema !== "object" || schema.type !== "object") return null;
  const problems = providerToolInputProblems(input, schema, "");
  if (!problems.length) return null;
  const allowed = providerToolAllowedKeys(schema);
  const allowedText = allowed.length ? ` Allowed keys: ${allowed.join(", ")}.` : "";
  return providerToolValidationError(
    "invalid-tool-input",
    `Invalid ${name} input (${problems.join("; ")}). BYOK exposes ${name} with the exact provider tool schema.${allowedText} Retry ${name} with only supported keys and valid value types.`,
  );
}

function providerToolInputProblems(value, schema, path, rootSchema = schema, seenRefs = new Set()) {
  if (!schema || typeof schema !== "object") return [];
  const refProblems = providerToolRefProblems(value, schema, path, rootSchema, seenRefs);
  if (refProblems) return refProblems;
  const types = providerToolSchemaTypes(schema);
  if (types.length && !types.some((type) => providerToolValueMatchesType(value, type))) {
    return [`${path || "input"} must be ${types.join(" or ")}`];
  }
  const problems = [];
  const enumProblem = providerToolEnumProblem(value, schema, path);
  if (enumProblem) problems.push(enumProblem);
  problems.push(...providerToolCombinatorProblems(value, schema, path, rootSchema, seenRefs));
  problems.push(...providerToolConditionalProblems(value, schema, path, rootSchema, seenRefs));
  problems.push(...providerToolScalarConstraintProblems(value, schema, path));
  if (providerToolSchemaCanBeObject(schema, types) && value && typeof value === "object" && !Array.isArray(value)) {
    problems.push(...providerToolObjectProblems(value, schema, path, rootSchema, seenRefs));
  }
  if (providerToolSchemaCanBeArray(schema, types) && Array.isArray(value)) {
    problems.push(...providerToolArrayProblems(value, schema, path, rootSchema, seenRefs));
  }
  return problems;
}

function providerToolRefProblems(value, schema, path, rootSchema, seenRefs) {
  const ref = typeof schema.$ref === "string" ? schema.$ref : "";
  if (!ref) return null;
  const resolved = providerToolResolveRef(rootSchema, ref);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return null;
  if (seenRefs.has(ref)) return [];
  const nextSeen = new Set(seenRefs);
  nextSeen.add(ref);
  const problems = providerToolInputProblems(value, resolved, path, rootSchema, nextSeen);
  const siblingSchema = providerToolRefSiblingSchema(schema);
  if (siblingSchema) problems.push(...providerToolInputProblems(value, siblingSchema, path, rootSchema, nextSeen));
  return problems;
}

function providerToolRefSiblingSchema(schema) {
  const siblingSchema = { ...schema };
  delete siblingSchema.$ref;
  delete siblingSchema.$defs;
  delete siblingSchema.definitions;
  for (const key of Object.keys(siblingSchema)) {
    if (PROVIDER_TOOL_SCHEMA_ANNOTATION_KEYS.has(key)) delete siblingSchema[key];
  }
  return Object.keys(siblingSchema).length ? siblingSchema : null;
}

function providerToolResolveRef(rootSchema, ref) {
  if (!ref.startsWith("#/")) return null;
  let node = rootSchema;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || typeof node !== "object") return null;
    node = node[part];
  }
  return node;
}

function providerToolConditionalProblems(value, schema, path, rootSchema, seenRefs) {
  const problems = [];
  const label = path || "input";
  if (schema.not && typeof schema.not === "object" && !Array.isArray(schema.not) && providerToolInputProblems(value, schema.not, path, rootSchema, seenRefs).length === 0) {
    problems.push(`${label} must not match the not schema`);
  }
  if (schema.if && typeof schema.if === "object" && !Array.isArray(schema.if)) {
    const branch = providerToolInputProblems(value, schema.if, path, rootSchema, seenRefs).length === 0 ? schema.then : schema.else;
    if (branch && typeof branch === "object" && !Array.isArray(branch)) {
      problems.push(...providerToolInputProblems(value, branch, path, rootSchema, seenRefs));
    }
  }
  return problems;
}

function providerToolObjectProblems(value, schema, path, rootSchema, seenRefs) {
  const properties = providerToolSchemaProperties(schema);
  const allowedKeys = Object.keys(properties);
  const allowedSet = new Set(allowedKeys);
  const problems = [];
  problems.push(...providerToolObjectConstraintProblems(value, schema, path));
  problems.push(...providerToolObjectDependencyProblems(value, schema, path, rootSchema, seenRefs));
  if (schema.additionalProperties === false) {
    const unsupportedKeys = Object.keys(value).filter((key) => !allowedSet.has(key) && !providerToolPatternPropertySchemas(schema, key).length).sort();
    for (const key of unsupportedKeys) problems.push(`unsupported key: ${providerToolPath(path, key)}`);
  }
  const additionalPropertiesSchema = schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties)
    ? schema.additionalProperties
    : null;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) problems.push(`missing required key: ${providerToolPath(path, key)}`);
  }
  for (const key of Object.keys(value)) {
    const propertySchema = allowedSet.has(key) ? properties[key] : additionalPropertiesSchema;
    const childPath = providerToolPath(path, key);
    if (propertySchema) problems.push(...providerToolInputProblems(value[key], propertySchema, childPath, rootSchema, seenRefs));
    for (const patternSchema of providerToolPatternPropertySchemas(schema, key)) {
      problems.push(...providerToolInputProblems(value[key], patternSchema, childPath, rootSchema, seenRefs));
    }
  }
  return problems;
}

function providerToolObjectDependencyProblems(value, schema, path, rootSchema, seenRefs) {
  const problems = [];
  const dependentRequired = schema.dependentRequired;
  if (dependentRequired && typeof dependentRequired === "object" && !Array.isArray(dependentRequired)) {
    for (const [key, requiredKeys] of Object.entries(dependentRequired)) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || !Array.isArray(requiredKeys)) continue;
      for (const requiredKey of requiredKeys) {
        if (typeof requiredKey !== "string") continue;
        if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) problems.push(`missing dependent key: ${providerToolPath(path, requiredKey)} required by ${providerToolPath(path, key)}`);
      }
    }
  }
  const dependentSchemas = schema.dependentSchemas;
  if (dependentSchemas && typeof dependentSchemas === "object" && !Array.isArray(dependentSchemas)) {
    for (const [key, dependencySchema] of Object.entries(dependentSchemas)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (!dependencySchema || typeof dependencySchema !== "object" || Array.isArray(dependencySchema)) continue;
      problems.push(...providerToolInputProblems(value, dependencySchema, path, rootSchema, seenRefs));
    }
  }
  return problems;
}

function providerToolObjectConstraintProblems(value, schema, path) {
  const problems = [];
  const label = path || "input";
  const keys = Object.keys(value);
  if (Number.isInteger(schema.minProperties) && keys.length < schema.minProperties) problems.push(`${label} must contain at least ${schema.minProperties} propertie(s)`);
  if (Number.isInteger(schema.maxProperties) && keys.length > schema.maxProperties) problems.push(`${label} must contain at most ${schema.maxProperties} propertie(s)`);
  const propertyNamesPattern = typeof schema.propertyNames?.pattern === "string" ? schema.propertyNames.pattern : "";
  if (propertyNamesPattern) {
    try {
      const regex = new RegExp(propertyNamesPattern);
      for (const key of keys) {
        if (!regex.test(key)) problems.push(`${providerToolPath(path, key)} property name must match pattern ${propertyNamesPattern}`);
      }
    } catch {
      // Ignore invalid provider regex schemas; providers receive the original schema.
    }
  }
  return problems;
}

function providerToolPatternPropertySchemas(schema, key) {
  const patternProperties = schema?.patternProperties;
  if (!patternProperties || typeof patternProperties !== "object" || Array.isArray(patternProperties)) return [];
  const matches = [];
  for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
    if (!patternSchema || typeof patternSchema !== "object" || Array.isArray(patternSchema)) continue;
    try {
      if (new RegExp(pattern).test(key)) matches.push(patternSchema);
    } catch {
      // Ignore invalid provider regex schemas; providers receive the original schema.
    }
  }
  return matches;
}

function providerToolArrayProblems(value, schema, path, rootSchema, seenRefs) {
  const problems = [];
  problems.push(...providerToolArrayTupleProblems(value, schema, path, rootSchema, seenRefs));
  problems.push(...providerToolArrayContainsProblems(value, schema, path, rootSchema, seenRefs));
  if (schema.uniqueItems === true && !providerToolArrayItemsAreUnique(value)) {
    problems.push(`${path || "input"} must contain unique item(s)`);
  }
  if (!schema.items || typeof schema.items !== "object" || Array.isArray(schema.items)) return problems;
  for (let index = 0; index < value.length; index++) {
    problems.push(...providerToolInputProblems(value[index], schema.items, `${path || "input"}[${index}]`, rootSchema, seenRefs));
  }
  return problems;
}

function providerToolArrayTupleProblems(value, schema, path, rootSchema, seenRefs) {
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : (Array.isArray(schema.items) ? schema.items : []);
  if (!prefixItems.length) return [];
  const problems = [];
  const label = path || "input";
  const length = Math.min(value.length, prefixItems.length);
  for (let index = 0; index < length; index++) {
    const itemSchema = prefixItems[index];
    if (!itemSchema || typeof itemSchema !== "object" || Array.isArray(itemSchema)) continue;
    problems.push(...providerToolInputProblems(value[index], itemSchema, `${label}[${index}]`, rootSchema, seenRefs));
  }
  if (value.length <= prefixItems.length) return problems;
  const additionalItems = schema.additionalItems;
  if (additionalItems === false) {
    problems.push(`${label} must contain at most ${prefixItems.length} tuple item(s)`);
  } else if (additionalItems && typeof additionalItems === "object" && !Array.isArray(additionalItems)) {
    for (let index = prefixItems.length; index < value.length; index++) {
      problems.push(...providerToolInputProblems(value[index], additionalItems, `${label}[${index}]`, rootSchema, seenRefs));
    }
  }
  return problems;
}

function providerToolArrayContainsProblems(value, schema, path, rootSchema, seenRefs) {
  const contains = schema.contains;
  if (!contains || typeof contains !== "object" || Array.isArray(contains)) return [];
  let matches = 0;
  for (let index = 0; index < value.length; index++) {
    if (providerToolInputProblems(value[index], contains, `${path || "input"}[${index}]`, rootSchema, seenRefs).length === 0) matches++;
  }
  const problems = [];
  const label = path || "input";
  const minContains = Number.isInteger(schema.minContains) ? schema.minContains : 1;
  if (matches < minContains) problems.push(`${label} must contain at least ${minContains} matching item(s)`);
  if (Number.isInteger(schema.maxContains) && matches > schema.maxContains) problems.push(`${label} must contain at most ${schema.maxContains} matching item(s)`);
  return problems;
}

function providerToolArrayItemsAreUnique(value) {
  const seen = new Set();
  for (const item of value) {
    const key = item && typeof item === "object" ? JSON.stringify(item) : `${typeof item}:${String(item)}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function providerToolCombinatorProblems(value, schema, path, rootSchema, seenRefs) {
  const problems = [];
  const label = path || "input";
  for (const item of Array.isArray(schema.allOf) ? schema.allOf : []) {
    problems.push(...providerToolInputProblems(value, item, path, rootSchema, seenRefs));
  }
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  if (anyOf.length && !anyOf.some((item) => providerToolInputProblems(value, item, path, rootSchema, seenRefs).length === 0)) {
    problems.push(`${label} must match at least one anyOf schema`);
  }
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  if (oneOf.length) {
    let matches = 0;
    for (const item of oneOf) {
      if (providerToolInputProblems(value, item, path, rootSchema, seenRefs).length === 0) matches++;
    }
    if (matches !== 1) problems.push(`${label} must match exactly one oneOf schema`);
  }
  return problems;
}

function providerToolScalarConstraintProblems(value, schema, path) {
  if (typeof value === "string") return providerToolStringConstraintProblems(value, schema, path);
  if (typeof value === "number" && Number.isFinite(value)) return providerToolNumberConstraintProblems(value, schema, path);
  if (Array.isArray(value)) return providerToolArrayConstraintProblems(value, schema, path);
  return [];
}

function providerToolStringConstraintProblems(value, schema, path) {
  const problems = [];
  const label = path || "input";
  if (Number.isInteger(schema.minLength) && value.length < schema.minLength) problems.push(`${label} length must be at least ${schema.minLength}`);
  if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) problems.push(`${label} length must be at most ${schema.maxLength}`);
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern).test(value)) problems.push(`${label} must match pattern ${schema.pattern}`);
    } catch {
      // Ignore invalid provider regex schemas; providers receive the original schema.
    }
  }
  return problems;
}

function providerToolNumberConstraintProblems(value, schema, path) {
  const problems = [];
  const label = path || "input";
  if (typeof schema.minimum === "number" && value < schema.minimum) problems.push(`${label} must be >= ${schema.minimum}`);
  if (typeof schema.maximum === "number" && value > schema.maximum) problems.push(`${label} must be <= ${schema.maximum}`);
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) problems.push(`${label} must be > ${schema.exclusiveMinimum}`);
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) problems.push(`${label} must be < ${schema.exclusiveMaximum}`);
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && !providerToolIsMultipleOf(value, schema.multipleOf)) {
    problems.push(`${label} must be a multiple of ${schema.multipleOf}`);
  }
  return problems;
}

function providerToolArrayConstraintProblems(value, schema, path) {
  const problems = [];
  const label = path || "input";
  if (Number.isInteger(schema.minItems) && value.length < schema.minItems) problems.push(`${label} must contain at least ${schema.minItems} item(s)`);
  if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) problems.push(`${label} must contain at most ${schema.maxItems} item(s)`);
  return problems;
}

function providerToolSchemaProperties(schema, rootSchema = schema, seenRefs = new Set()) {
  const ref = typeof schema?.$ref === "string" ? schema.$ref : "";
  if (ref && !seenRefs.has(ref)) {
    const resolved = providerToolResolveRef(rootSchema, ref);
    if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
      const nextSeen = new Set(seenRefs);
      nextSeen.add(ref);
      return providerToolSchemaProperties(resolved, rootSchema, nextSeen);
    }
  }
  const properties = schema?.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? { ...schema.properties }
    : {};
  for (const groupKey of ["anyOf", "oneOf", "allOf"]) {
    const group = schema?.[groupKey];
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      Object.assign(properties, providerToolSchemaProperties(item, rootSchema, seenRefs));
    }
  }
  return properties;
}

function providerToolAllowedKeys(schema) {
  return Object.keys(providerToolSchemaProperties(schema));
}

function providerToolSchemaTypes(schema) {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((type) => typeof type === "string");
  return [];
}

function providerToolSchemaCanBeObject(schema, types) {
  return types.length ? types.includes("object") : !!schema.properties;
}

function providerToolSchemaCanBeArray(schema, types) {
  return types.length ? types.includes("array") : !!schema.items;
}

function providerToolPath(parent, key) {
  return parent ? `${parent}.${key}` : key;
}

function providerToolValueMatchesType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function providerToolEnumProblem(value, schema, path) {
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => providerToolJsonEqual(value, candidate))) {
    return `${path || "input"} must be one of ${schema.enum.map(providerToolLiteralText).join(", ")}`;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !providerToolJsonEqual(value, schema.const)) {
    return `${path || "input"} must equal ${providerToolLiteralText(schema.const)}`;
  }
  return "";
}

function providerToolJsonEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function providerToolLiteralText(value) {
  return JSON.stringify(value);
}

function providerToolIsMultipleOf(value, divisor) {
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) < Number.EPSILON * Math.max(1, Math.abs(quotient));
}

function stringifyRepairedToolArguments(rawArguments, repaired) {
  return typeof rawArguments === "string" ? JSON.stringify(repaired) : repaired;
}

function providerToolValidationError(reason, message) {
  return { reason, message };
}

function sanitizedReadRetryArgs(input) {
  const path = readPathCandidate(input);
  const retry = {};
  if (path) retry.path = path;
  for (const key of ["offset", "limit"]) {
    if (Number.isInteger(input?.[key])) retry[key] = input[key];
  }
  if (typeof input?.encodingHint === "string" && input.encodingHint) retry.encodingHint = input.encodingHint;
  return retry;
}

function readPathCandidate(input) {
  return stringOrEmpty(input?.path) || stringOrEmpty(input?.filePath) || stringOrEmpty(input?.file_path);
}

function readPathAliasConflict(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const values = [];
  if (stringOrEmpty(input.path)) values.push(stringOrEmpty(input.path));
  for (const key of READ_INPUT_ALIAS_KEYS) {
    const value = stringOrEmpty(input[key]);
    if (value) values.push(value);
  }
  if (values.length <= 1) return false;
  const first = values[0];
  return values.some((value) => value !== first);
}

function explicitReadArgsListFromMessages(messages, pathCandidate) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (message?.role !== "user" || typeof message.content !== "string") continue;
    const expected = explicitReadArgsListFromText(message.content, pathCandidate);
    if (expected.length) return uniqueReadArgsList(expected);
  }
  return [];
}

function explicitReadArgsListFromText(text, pathCandidate) {
  const objects = text.match(/\{[^{}]*"path"[^{}]*\}/g) || [];
  const out = [];
  for (let i = objects.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(objects[i]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.path !== "string") continue;
    if (pathCandidate && parsed.path !== pathCandidate) continue;
    const expected = { path: parsed.path };
    for (const key of ["offset", "limit"]) {
      const value = parsed[key];
      if (Number.isInteger(value)) expected[key] = value;
    }
    if (Object.prototype.hasOwnProperty.call(expected, "offset") || Object.prototype.hasOwnProperty.call(expected, "limit")) {
      out.push(expected);
    }
  }
  if (pathCandidate) out.push(...explicitReadProseArgsListFromText(text, pathCandidate));
  return out;
}

function explicitReadProseArgsListFromText(text, pathCandidate) {
  const out = [];
  const pathPattern = new RegExp(escapeRegExp(pathCandidate), "g");
  for (;;) {
    const match = pathPattern.exec(text);
    if (!match) break;
    const start = match.index + pathCandidate.length;
    const nextSamePath = text.indexOf(pathCandidate, start);
    const nextLine = text.indexOf("\n", start);
    let end = Math.min(text.length, start + 240);
    if (nextSamePath !== -1) end = Math.min(end, nextSamePath);
    if (nextLine !== -1) end = Math.min(end, nextLine);
    const segment = text.slice(start, end);
    const offset = explicitIntegerAfterLabel(segment, "offset");
    const limit = explicitIntegerAfterLabel(segment, "limit");
    if (Number.isInteger(offset) && Number.isInteger(limit)) {
      out.push({ path: pathCandidate, offset, limit });
    }
  }
  return out;
}

function explicitIntegerAfterLabel(text, label) {
  const match = new RegExp(`(?:^|[^A-Za-z0-9_])${label}\\s*(?:=|:)?\\s*(-?\\d+)\\b`, "i").exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueReadArgsList(candidates) {
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function uniqueExplicitReadArgs(candidates) {
  return candidates.length === 1 ? candidates[0] : null;
}

function matchesAnyExplicitReadArgs(input, candidates) {
  return candidates.some((candidate) => matchesExplicitReadArgs(input, candidate));
}

function matchesExplicitReadArgs(input, candidate) {
  if (!input || typeof input !== "object" || input.path !== candidate.path) return false;
  for (const key of ["offset", "limit"]) {
    if (Object.prototype.hasOwnProperty.call(candidate, key) && input[key] !== candidate[key]) return false;
  }
  return true;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function shellIdentifierString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function normalizeMessageContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value;
  return JSON.stringify(value ?? "");
}

function normalizeToolResultTextContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return JSON.stringify(value ?? "");
  const parts = [];
  for (const block of value) {
    const text = providerTextFromToolResultContentBlock(block);
    if (text) parts.push(text);
  }
  return parts.length ? parts.join("\n\n") : safeJson(value, 12000);
}

function providerTextFromMessageContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return providerTextFromContentBlocks(value);
  return JSON.stringify(value ?? "");
}

function providerTextFromContentBlocks(blocks) {
  const parts = [];
  for (const block of blocks) {
    const text = providerTextFromContentBlock(block);
    if (text) parts.push(text);
  }
  return parts.length ? parts.join("\n") : safeJson(blocks, 12000);
}

function providerTextFromContentBlock(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object" || Array.isArray(block)) return "";
  if (block.type === "thinking" || block.type === "redacted_thinking") return anthropicThinkingBlockText(block);
  if (typeof block.text === "string") return block.text;
  if (typeof block.refusal === "string") return block.refusal;
  if (typeof block.content === "string") return block.content;
  if (block.type === "image_url" || block.type === "image" || block.type === "input_image") {
    return `[image ${anthropicImageUrlFromBlock(block) || toolResultImageMimeType(block) || "image"}]`;
  }
  if (block.type === "file" || block.type === "input_file" || block.type === "document") {
    return `[file ${toolResultFileLabel(block)}]`;
  }
  return safeJson(block, 12000);
}

function anthropicThinkingBlockText(block) {
  const id = stringOrEmpty(block.id);
  const signature = stringOrEmpty(block.signature);
  const thinking = block.type === "thinking" ? stringOrEmpty(block.thinking) : "";
  const fields = [
    id ? `id: ${id}` : "",
    signature ? "signature: [preserved for Anthropic only]" : "",
    thinking ? `thinking:\n${thinking}` : "",
  ].filter(Boolean).join("\n");
  return fields ? `Anthropic ${block.type} block:\n${fields}` : `Anthropic ${block.type} block.`;
}

function openAiChatUserContentFromBlocks(blocks) {
  if (blocks.every(isOpenAiChatUserContentPart)) return blocks;
  const out = [];
  for (const block of blocks) {
    const part = openAiChatContentPartFromBlock(block);
    if (part) out.push(part);
  }
  return out.length ? out : providerTextFromContentBlocks(blocks);
}

function isOpenAiChatUserContentPart(block) {
  if (typeof block === "string") return true;
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  return block.type === "text" || block.type === "image_url" || block.type === "file";
}

function openAiChatContentPartFromBlock(block) {
  if (typeof block === "string") return { type: "text", text: block };
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  switch (block.type) {
    case "text": {
      const text = stringOrEmpty(block.text) || providerTextFromContentBlock(block);
      return text ? { type: "text", text } : null;
    }
    case "image_url": {
      const imageUrl = block.image_url && typeof block.image_url === "object" ? block.image_url : {};
      const url = stringOrEmpty(imageUrl.url) || stringOrEmpty(block.image_url) || stringOrEmpty(block.imageUrl) || stringOrEmpty(block.url);
      if (!url) return { type: "text", text: providerTextFromContentBlock(block) };
      const out = { type: "image_url", image_url: { url } };
      const detail = stringOrEmpty(imageUrl.detail) || stringOrEmpty(block.detail);
      if (detail) out.image_url.detail = detail;
      return out;
    }
    case "file": {
      const sourceFile = block.file && typeof block.file === "object" ? block.file : {};
      const file = pickFileFields(sourceFile, block);
      return Object.keys(file).length ? { type: "file", file } : { type: "text", text: providerTextFromContentBlock(block) };
    }
    case "input_text":
    case "output_text":
    case "refusal": {
      const text = providerTextFromContentBlock(block);
      return text ? { type: "text", text } : null;
    }
    case "input_image": {
      const url = stringOrEmpty(block.image_url) || stringOrEmpty(block.imageUrl) || stringOrEmpty(block.url);
      return url ? { type: "image_url", image_url: { url } } : { type: "text", text: providerTextFromContentBlock(block) };
    }
    case "image": {
      const url = providerInputImageUrlFromBlock(block);
      return url ? { type: "image_url", image_url: { url } } : { type: "text", text: providerTextFromContentBlock(block) };
    }
    case "input_file": {
      const file = pickFileFields({}, block);
      return Object.keys(file).length ? { type: "file", file } : { type: "text", text: providerTextFromContentBlock(block) };
    }
    default: {
      const text = providerTextFromContentBlock(block);
      return text ? { type: "text", text } : null;
    }
  }
}

function anthropicContentFromMessageBlocks(blocks) {
  if (blocks.some(isOpenAiResponsesMessageContentBlock)) {
    const text = providerTextFromContentBlocks(blocks);
    return text ? [{ type: "text", text }] : [];
  }
  return blocks;
}

function anthropicUserContentFromBlocks(blocks) {
  const out = [];
  for (const block of blocks) {
    const part = anthropicUserContentPartFromBlock(block);
    if (part) out.push(part);
  }
  return out.length ? out : anthropicContentFromMessageBlocks(blocks);
}

function anthropicUserContentPartFromBlock(block) {
  if (typeof block === "string") return { type: "text", text: block };
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  switch (block.type) {
    case "text": {
      const out = { type: "text", text: block.text ?? "" };
      if (block.cache_control !== undefined) out.cache_control = block.cache_control;
      return out;
    }
    case "input_text":
    case "output_text":
    case "refusal": {
      const text = providerTextFromContentBlock(block);
      if (!text) return null;
      const out = { type: "text", text };
      if (block.cache_control !== undefined) out.cache_control = block.cache_control;
      return out;
    }
    case "image": {
      if (block.source !== undefined) return sanitizeAnthropicUserImageBlock(block);
      const text = providerTextFromContentBlock(block);
      return text ? { type: "text", text } : null;
    }
    case "document": {
      if (block.source !== undefined) return sanitizeAnthropicUserDocumentBlock(block);
      const text = providerTextFromContentBlock(block);
      return text ? { type: "text", text } : null;
    }
    case "image_url":
    case "input_image": {
      const url = anthropicImageUrlFromBlock(block);
      if (url) {
        const out = { type: "image", source: { type: "url", url } };
        if (block.cache_control !== undefined) out.cache_control = block.cache_control;
        return out;
      }
      const text = providerTextFromContentBlock(block);
      return text ? { type: "text", text } : null;
    }
    case "file":
    case "input_file": {
      const text = providerTextFromContentBlock(block);
      return text ? { type: "text", text } : null;
    }
    default: {
      const text = providerTextFromContentBlock(block);
      return text ? { type: "text", text } : null;
    }
  }
}

function sanitizeAnthropicUserImageBlock(block) {
  const out = { type: "image", source: block.source };
  if (block.cache_control !== undefined) out.cache_control = block.cache_control;
  return out;
}

function sanitizeAnthropicUserDocumentBlock(block) {
  const out = { type: "document", source: block.source };
  if (block.cache_control !== undefined) out.cache_control = block.cache_control;
  if (block.citations !== undefined) out.citations = block.citations;
  if (block.context !== undefined) out.context = block.context;
  if (block.title !== undefined) out.title = block.title;
  return out;
}

function anthropicImageUrlFromBlock(block) {
  if (block.type === "input_image") return stringOrEmpty(block.image_url) || stringOrEmpty(block.imageUrl) || stringOrEmpty(block.url);
  const imageUrl = block.image_url && typeof block.image_url === "object" ? block.image_url : {};
  return stringOrEmpty(imageUrl.url) || stringOrEmpty(block.url);
}

function imageBlockMimeType(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const source = value.source && typeof value.source === "object" ? value.source : {};
  return firstNonEmptyString(
    value.mimeType,
    value.mime_type,
    source.media_type,
    source.mediaType,
    source.mime_type,
    source.mimeType,
  );
}

function pickFileFields(sourceFile, block) {
  const file = {};
  if (sourceFile.file_id !== undefined) file.file_id = sourceFile.file_id;
  else if (block.file_id !== undefined) file.file_id = block.file_id;
  if (sourceFile.file_data !== undefined) file.file_data = sourceFile.file_data;
  else if (block.file_data !== undefined) file.file_data = block.file_data;
  if (sourceFile.filename !== undefined) file.filename = sourceFile.filename;
  else if (block.filename !== undefined) file.filename = block.filename;
  return file;
}

function providerInputImageUrlFromBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return "";
  const direct = anthropicImageUrlFromBlock(block);
  if (direct) return direct;
  if (block.type !== "image") return "";
  const source = block.source && typeof block.source === "object" ? block.source : {};
  if (stringOrEmpty(source.url)) return source.url;
  const uri = stringOrEmpty(source.uri);
  if (uri && (/^data:/i.test(uri) || /^https?:\/\//i.test(uri))) return uri;
  const mimeType = imageBlockMimeType(block);
  const data = stringOrEmpty(source.data) || stringOrEmpty(block.data);
  if (data && mimeType) return `data:${mimeType};base64,${data}`;
  return "";
}

function isOpenAiResponsesMessageContentBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  switch (block.type) {
    case "input_text":
    case "input_image":
    case "input_file":
    case "output_text":
    case "refusal":
      return true;
    default:
      return false;
  }
}

function normalizeAnthropicToolResultContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length) {
    const hasAnthropicBlock = value.some(isAnthropicToolResultContentBlock);
    if (!hasAnthropicBlock) return normalizeToolResultTextContent(value);
    const blocks = value.map(normalizeAnthropicToolResultContentBlock).filter(Boolean);
    if (blocks.length) return blocks;
  }
  return normalizeToolResultTextContent(value);
}

function normalizeAnthropicToolResultContentBlock(block) {
  if (isAnthropicToolResultContentBlock(block)) return sanitizeAnthropicToolResultContentBlock(block);
  const text = providerTextFromToolResultContentBlock(block);
  return text ? { type: "text", text } : null;
}

function isAnthropicToolResultContentBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  return block.type === "text" || block.type === "image" || block.type === "document";
}

function sanitizeAnthropicToolResultContentBlock(block) {
  if (block.type === "text") {
    const next = { type: "text", text: block.text ?? "" };
    if (block.cache_control !== undefined) next.cache_control = block.cache_control;
    return next;
  }
  if (block.type === "image") {
    const next = { type: "image", source: block.source };
    if (block.cache_control !== undefined) next.cache_control = block.cache_control;
    return next;
  }
  const next = { type: "document", source: block.source };
  if (block.cache_control !== undefined) next.cache_control = block.cache_control;
  if (block.title !== undefined) next.title = block.title;
  if (block.context !== undefined) next.context = block.context;
  if (block.citations !== undefined) next.citations = block.citations;
  return next;
}

function providerTextFromToolResultContentBlock(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object" || Array.isArray(block)) return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (block.content?.case === "text") {
    const value = block.content.value;
    if (typeof value === "string") return value;
    if (typeof value?.text === "string") return value.text;
  }
  if (block.type === "image" || block.type === "input_image") {
    return `[image ${toolResultImageMimeType(block) || "image"}]`;
  }
  if (block.content?.case === "image") {
    return `[image ${toolResultImageMimeType(block.content.value) || "image"}]`;
  }
  if (block.type === "file" || block.type === "input_file" || block.type === "document") {
    return `[file ${toolResultFileLabel(block)}]`;
  }
  return safeJson(block, 12000);
}

function toolResultImageMimeType(value) {
  return imageBlockMimeType(value);
}

function toolResultFileLabel(value) {
  const file = value?.file && typeof value.file === "object" ? value.file : {};
  return stringOrEmpty(value?.filename) ||
    stringOrEmpty(value?.file_id) ||
    stringOrEmpty(file.filename) ||
    stringOrEmpty(file.file_id) ||
    stringOrEmpty(value?.source?.media_type) ||
    "file";
}

function stringifyToolResultForProvider(result, toolName) {
  if (result?.message?.case === "shellResult") {
    return stringifyShellResultForProvider(result.message.value);
  }
  if (result?.message?.case === "readResult") {
    return stringifyReadResultForProvider(result.message.value);
  }
  if (result?.message?.case === "grepResult") {
    // Glob executes natively as grep files_with_matches, so its results come back
    // as grepResult; the provider-visible text must still use the Glob template.
    if (toolName === "Glob") return stringifyGlobResultForProvider(result.message.value);
    return stringifyGrepResultForProvider(result.message.value);
  }
  if (result?.message?.case === "mcpResult") {
    return stringifyMcpResultForProvider(result.message.value);
  }
  if (result?.message?.case === "listMcpResourcesExecResult") {
    return stringifyListMcpResourcesResultForProvider(result.message.value);
  }
  if (result?.message?.case === "readMcpResourceExecResult") {
    return stringifyReadMcpResourceResultForProvider(result.message.value);
  }
  if (result?.message?.case === "byokInteractionToolResult") {
    const payload = result.message.value || {};
    if (typeof payload.text === "string" && payload.text) return payload.text;
    if (payload.clientCompletion) {
      return providerTextFromClientCompletion(payload.toolName, payload.clientCompletion);
    }
    if (payload.interactionResponse) {
      return providerTextFromInteractionResponse(
        payload.toolName,
        payload.interactionResponse,
        payload.toolArguments,
      );
    }
  }
  if (result?.message?.case === "mcpAuthResult") {
    return stringifyMcpAuthResultForProvider(result.message.value);
  }
  if (result?.message?.case === "todoWriteResult") {
    return stringifyTodoWriteResultForProvider(result.message.value);
  }
  if (result?.message?.case === "writeResult") {
    return stringifyWriteResultForProvider(result.message.value);
  }
  if (result?.message?.case === "editResult") {
    return stringifyGenericExecResultForProvider("Edit", result.message.value);
  }
  if (result?.message?.case === "deleteResult") {
    return stringifyDeleteResultForProvider(result.message.value);
  }
  if (result?.message?.case === "writeShellStdinResult") {
    return stringifyWriteShellStdinResultForProvider(result.message.value);
  }
  if (result?.message?.case === "subagentAwaitResult") {
    return stringifyAwaitShellResultForProvider(result.message.value);
  }
  if (result?.message?.case === "diagnosticsResult") {
    return stringifyDiagnosticsResultForProvider(result.message.value);
  }
  if (result?.message?.case === "lsResult") {
    return stringifyLsResultForProvider(result.message.value);
  }
  if (result?.message?.case === "fetchResult") {
    return stringifyFetchResultForProvider(result.message.value);
  }
  if (result?.message?.case === "recordScreenResult") {
    return stringifyGenericExecResultForProvider("RecordScreen", result.message.value);
  }
  if (result?.message?.case === "computerUseResult") {
    return stringifyGenericExecResultForProvider("ComputerUse", result.message.value);
  }
  if (result?.message?.case === "requestContextResult") {
    return stringifyGenericExecResultForProvider("Tool", result.message.value);
  }
  if (result?.message?.case === "unsupportedToolResult") {
    return stringifyGenericExecResultForProvider("Tool", result.message.value);
  }
  return safeJson(result?.message?.value ?? result ?? {}, 12000);
}

function stringifyShellResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "Shell failed";
  const payload = result.value && typeof result.value === "object" ? result.value : {};
  const shellId = payload.shellId ?? payload.shell_id;
  if (result.case === "success" && shellId !== undefined && shellId !== null && shellId !== "") {
    return stringifyBackgroundShellResultForProvider(String(shellId), payload);
  }
  if (result.case === "success" || result.case === "failure") {
    return stringifyForegroundShellResultForProvider(result.case, payload);
  }
  return formatToolFailureForProvider("Shell", result);
}

// Background shell render aligned to Cursor's agent-exec text: announce the
// backgrounding, the Shell ID / PID, and the "Don't mention Shell ID" guidance.
// BYOK keeps the explicit AwaitShell follow-up because that is the tool name it
// exposes to providers (Cursor's harness uses `Await` with a task id internally).
function stringifyBackgroundShellResultForProvider(shellId, payload) {
  const msToWait = normalizeInteger(payload.msToWait ?? payload.ms_to_wait);
  const pid = normalizeInteger(payload.pid);
  const lines = [];
  lines.push(msToWait !== undefined
    ? `The command did not complete in ${msToWait}ms and was sent to the background.`
    : "The command was sent to the background.");
  lines.push(`Shell ID: ${shellId}`);
  if (pid !== undefined && pid !== 0) lines.push(`PID: ${pid}`);
  const backgroundReason = firstNonEmptyString(payload.backgroundReason, payload.background_reason);
  if (backgroundReason) lines.push(backgroundReason);
  lines.push(`Call AwaitShell with {"shell_id":"${shellId}"} to wait for completion. Don't mention Shell ID to the user.`);
  return lines.join("\n");
}

// Foreground shell render aligned to Cursor's agent-exec text: exit code, fenced
// combined output (20k middle-out cap), completion timing, and the shell-state
// persistence epilogue so the model knows cwd/env carry over between calls.
function stringifyForegroundShellResultForProvider(resultCase, payload) {
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  const interleaved = firstNonEmptyString(payload.interleavedOutput, payload.interleaved_output);
  const combined = interleaved || [stdout, stderr].filter(Boolean).join("") || stringField(payload, "output");
  const cwd = firstNonEmptyString(payload.workingDirectory, payload.working_directory, payload.cwd);
  const exitCode = normalizeInteger(payload.exitCode ?? payload.exit_code ?? payload.code);
  // The hook reports real timing as localExecutionTimeMs and hardcodes a
  // placeholder executionTime of 0; only a non-zero executionTime is meaningful.
  let executionTime = normalizeInteger(payload.localExecutionTimeMs ?? payload.local_execution_time_ms);
  if (executionTime === undefined) {
    const reported = normalizeInteger(payload.executionTime ?? payload.execution_time ?? payload.executionTimeMs ?? payload.execution_time_ms);
    if (reported !== undefined && reported !== 0) executionTime = reported;
  }
  const signal = firstNonEmptyString(payload.signal);
  const aborted = signal === "SIGTERM";

  const { output, truncated } = truncateShellOutputMiddleOut(combined);
  const lines = [];
  lines.push(`Exit code: ${exitCode !== undefined ? exitCode : "unknown"}`);
  lines.push("");
  lines.push(`Command output${truncated ? " (truncated to 20000 characters)" : ""}:`);
  lines.push("");
  lines.push("```");
  lines.push(output);
  lines.push("```");
  lines.push("");
  lines.push(shellCompletionLine(aborted, executionTime));
  lines.push("");
  lines.push(shellStatePersistenceLine(aborted, cwd));
  return lines.join("\n");
}

function shellCompletionLine(aborted, executionTime) {
  if (aborted) {
    return executionTime !== undefined ? `Command aborted after ${executionTime} ms.` : "Command aborted.";
  }
  return executionTime !== undefined ? `Command completed in ${executionTime} ms.` : "Command completed.";
}

function shellStatePersistenceLine(aborted, cwd) {
  if (aborted) {
    return "The previous shell command aborted, so on the next invocation of this tool, a new shell will be started at the project root.";
  }
  const base = "Shell state (cwd, env vars) persists for subsequent calls.";
  return cwd ? `${base} Current directory: ${cwd}` : base;
}

function stringifyMcpAuthResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "MCP authentication did not return a response.";
  if (result.case === "success") {
    const serverIdentifier = stringField(result.value, "serverIdentifier") || stringField(result.value, "server_identifier");
    return serverIdentifier
      ? `MCP authentication approved for server ${serverIdentifier}.`
      : "MCP authentication approved.";
  }
  if (result.case === "rejected") {
    const reason = stringField(result.value, "reason");
    return reason ? `MCP authentication rejected: ${reason}` : "MCP authentication rejected.";
  }
  if (result.case === "error") {
    const error = stringField(result.value, "error");
    return error ? `MCP authentication failed: ${error}` : "MCP authentication failed.";
  }
  return `MCP authentication ${result.case}: ${safeJson(result.value ?? {}, 4000)}`;
}

function stringifyTodoWriteResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "TodoWrite failed";
  if (result.case !== "success") return formatToolFailureForProvider("TodoWrite", result);
  const todos = arrayField(result.value, "todos");
  if (!todos.length) return "Todo list is empty.";
  const lines = [`Todo list updated (${todos.length} item${todos.length === 1 ? "" : "s"}):`];
  for (const todo of todos.slice(0, 50)) {
    const status = stringField(todo, "status") || "unknown";
    const content = stringField(todo, "content") || stringField(todo, "subject") || stringField(todo, "description") || stringField(todo, "id") || "(untitled)";
    lines.push(`- [${status}] ${content}`);
  }
  if (todos.length > 50) lines.push(`...[${todos.length - 50} more todo items]`);
  return truncateTextWithNotice(lines.join("\n"), 12000);
}

function stringifyGenericExecResultForProvider(toolName, value) {
  const result = value?.result;
  if (!result?.case) return `${toolName} failed`;
  if (result.case !== "success") return formatToolFailureForProvider(toolName, result);
  const payload = result.value && typeof result.value === "object" ? result.value : {};
  const directText = firstNonEmptyString(
    payload.message,
    payload.output,
    payload.stdout,
    payload.text,
    payload.content,
    payload.body,
  );
  if (directText) return truncateTextWithNotice(directText, 12000);
  return formatToolSuccessForProvider(toolName, payload);
}

function formatToolFailureForProvider(toolName, result) {
  const payload = result.value && typeof result.value === "object" ? result.value : {};
  const message = firstNonEmptyString(payload.error, payload.message, payload.reason, payload.stderr, payload.output);
  return message ? `${toolName} ${result.case}: ${message}` : `${toolName} ${result.case}: ${safeJson(result.value ?? {}, 4000)}`;
}

function formatToolSuccessForProvider(toolName, payload) {
  const path = firstNonEmptyString(payload.path, payload.filePath, payload.file_path, payload.target_notebook, payload.targetNotebook);
  if (path) return `${toolName} completed successfully: ${path}`;
  const url = firstNonEmptyString(payload.url, payload.uri);
  if (url) return `${toolName} completed successfully: ${url}`;
  const shellId = firstNonEmptyString(payload.shellId, payload.shell_id, payload.taskId, payload.task_id);
  if (shellId) return `${toolName} completed successfully for ${shellId}.`;
  const complete = payload.complete && typeof payload.complete === "object" ? payload.complete : null;
  if (complete) {
    const completeTaskId = firstNonEmptyString(complete.taskId, complete.task_id);
    const outputPath = firstNonEmptyString(complete.outputFilePath, complete.output_file_path);
    const suffix = [
      completeTaskId ? `task_id: ${completeTaskId}` : "",
      outputPath ? `output: ${outputPath}` : "",
      Number.isFinite(complete.outputLength) ? `output_length: ${complete.outputLength}` : "",
    ].filter(Boolean).join(", ");
    return suffix ? `${toolName} completed successfully (${suffix}).` : `${toolName} completed successfully.`;
  }
  const diagnostics = arrayField(payload, "diagnostics");
  if (diagnostics.length) return `${toolName} returned ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`;
  const entries = arrayField(payload, "entries").length || arrayField(payload, "files").length || arrayField(payload, "items").length;
  if (entries) return `${toolName} completed successfully (${entries} item${entries === 1 ? "" : "s"}).`;
  return `${toolName} completed successfully.`;
}

// Write render aligned to Cursor's agent-exec EditSuccess.message: the bridge sets
// `message` to "Wrote contents to <path>"; fall back to that wording when a native
// writeResult omits it so the model sees the same confirmation either way.
function stringifyWriteResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "Write failed";
  if (result.case !== "success") return formatToolFailureForProvider("Write", result);
  const payload = result.value && typeof result.value === "object" ? result.value : {};
  const message = firstNonEmptyString(payload.message);
  if (message) return truncateTextWithNotice(message, 12000);
  const path = firstNonEmptyString(payload.path, payload.filePath, payload.file_path);
  return path ? `Wrote contents to ${path}` : "Write completed successfully.";
}

// Delete render aligned to Cursor's agent-exec DeleteResult cases.
function stringifyDeleteResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "Delete failed";
  const payload = result.value && typeof result.value === "object" ? result.value : {};
  const path = firstNonEmptyString(payload.path, payload.filePath, payload.file_path);
  switch (result.case) {
    case "success": {
      const fileSize = normalizeInteger(payload.fileSize ?? payload.file_size);
      if (path && fileSize !== undefined) return `Successfully deleted file: ${path} (${fileSize} bytes)`;
      return path ? `Successfully deleted file: ${path}` : "Successfully deleted file.";
    }
    case "fileNotFound":
      return path ? `File not found: ${path}` : "File not found";
    case "notFile": {
      const actualType = firstNonEmptyString(payload.actualType, payload.actual_type, payload.type);
      return `Path is not a file${actualType ? ` (${actualType})` : ""}${path ? `: ${path}` : ""}`;
    }
    case "permissionDenied":
      return path ? `Permission denied: ${path}` : "Permission denied";
    case "fileBusy":
      return path ? `File is busy: ${path}` : "File is busy";
    default:
      return formatToolFailureForProvider("Delete", result);
  }
}

// WriteShellStdin render aligned to Cursor's agent-exec text.
function stringifyWriteShellStdinResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "WriteShellStdin failed";
  if (result.case !== "success") return formatToolFailureForProvider("WriteShellStdin", result);
  const payload = result.value && typeof result.value === "object" ? result.value : {};
  const shellId = firstNonEmptyString(payload.shellId, payload.shell_id);
  return shellId ? `Successfully wrote to shell ${shellId} stdin.` : "Successfully wrote to shell stdin.";
}

// AwaitShell render aligned to Cursor's agent-exec Await result (complete /
// stillRunning), surfacing exit code, output file path, and output length.
function stringifyAwaitShellResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "AwaitShell failed";
  if (result.case !== "success") return formatToolFailureForProvider("AwaitShell", result);
  const payload = result.value && typeof result.value === "object" ? result.value : {};
  const complete = payload.complete && typeof payload.complete === "object" ? payload.complete : null;
  const stillRunning = payload.stillRunning && typeof payload.stillRunning === "object" ? payload.stillRunning : null;
  const detail = complete || stillRunning;
  if (!detail) return formatToolSuccessForProvider("AwaitShell", payload);
  const runtimeMs = normalizeInteger(detail.runtimeMs ?? detail.runtime_ms);
  const exitCode = normalizeInteger(detail.exitCode ?? detail.exit_code);
  const outputPath = firstNonEmptyString(detail.outputFilePath, detail.output_file_path);
  const outputLength = normalizeInteger(detail.outputLength ?? detail.output_length);
  const head = complete
    ? (exitCode !== undefined
        ? `Task completed${runtimeMs !== undefined ? ` in ${runtimeMs}ms` : ""} with exit code: ${exitCode}.`
        : "Task complete.")
    : `Task still running${runtimeMs !== undefined ? ` after ${runtimeMs}ms...` : "."}`;
  const trailer = [
    outputPath ? `output_file_path: ${outputPath}` : "",
    outputLength !== undefined ? `output_length: ${outputLength}` : "",
  ].filter(Boolean);
  return trailer.length ? `${head}\n${trailer.join("\n")}` : head;
}

function stringifyLsResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return stringifyGenericExecResultForProvider("LS", value);
  // Cursor's executor returns the partial tree on timeout; render it like success.
  if (result.case !== "success" && result.case !== "timeout") {
    return formatToolFailureForProvider("LS", result);
  }
  const payload = result.value && typeof result.value === "object" ? result.value : {};
  const treeRoot = payload.directoryTreeRoot ?? payload.directory_tree_root;
  if (treeRoot && typeof treeRoot === "object") {
    return renderDirectoryTreeForProvider(treeRoot);
  }
  if (result.case !== "success") return formatToolFailureForProvider("LS", result);
  const directText = firstNonEmptyString(payload.output, payload.stdout, payload.text, payload.content, payload.message);
  if (directText) return truncateTextWithNotice(directText, 12000);
  const entries = collectDirectoryEntryLines(payload);
  if (entries.length) {
    const path = firstNonEmptyString(payload.path, payload.directory, payload.targetDirectory, payload.target_directory);
    const header = path ? `Directory: ${path}` : "Directory listing:";
    return truncateTextWithNotice([header, ...entries].join("\n"), 12000);
  }
  return formatToolSuccessForProvider("LS", payload);
}

// Cursor's agent-exec LS render over ListDirV2Result.directoryTreeRoot: try full
// depth with collapsed-subtree extension counts; if over budget, retry at depth 0
// with counts; if still over budget, depth 0 without counts.
function renderDirectoryTreeForProvider(root, budget = LS_TREE_MAX_CHARS) {
  let text = renderDirectoryTreeNode(root, true, undefined);
  if (text.length > budget) {
    text = renderDirectoryTreeNode(root, true, 0);
    if (text.length > budget) text = renderDirectoryTreeNode(root, false, 0);
  }
  return text.replace(/\n$/, "");
}

function renderDirectoryTreeNode(root, showExtensionCounts, maxDepth) {
  const rootPath = stringField(root, "absPath") || stringField(root, "abs_path");
  const sep = rootPath.includes("\\") ? "\\" : "/";
  const render = (node, depth) => {
    const absPath = stringField(node, "absPath") || stringField(node, "abs_path");
    let text;
    if (depth === 0) {
      text = `${absPath}${absPath.endsWith(sep) ? "" : sep}\n`;
    } else {
      text = `${"  ".repeat(depth)}- ${directoryTreeBasename(absPath)}${sep}\n`;
    }
    const children = [
      ...arrayField(node, "childrenFiles").map((file) => ({
        type: "file",
        name: stringField(file, "name"),
        terminalMetadata: file?.terminalMetadata,
      })),
      ...arrayField(node, "childrenDirs").map((dir) => ({
        type: "dir",
        name: directoryTreeBasename(stringField(dir, "absPath") || stringField(dir, "abs_path")),
        dir,
      })),
    ];
    children.sort((a, b) => a.name.localeCompare(b.name));
    const indent = "  ".repeat(depth + 1);
    for (const child of children) {
      if (child.type === "file") {
        text += `${indent}- ${child.name}\n`;
        text += renderDirectoryTreeTerminalMetadata(child.terminalMetadata, `${indent}  `);
        continue;
      }
      const dir = child.dir;
      if (dir?.childrenWereProcessed === true && (maxDepth === undefined || depth < maxDepth)) {
        text += render(dir, depth + 1);
        continue;
      }
      const counts = Object.entries(
        dir?.fullSubtreeExtensionCounts && typeof dir.fullSubtreeExtensionCounts === "object"
          ? dir.fullSubtreeExtensionCounts
          : {},
      );
      if (counts.length > 0 && showExtensionCounts) {
        let summary = counts
          .sort(([extA, countA], [extB, countB]) => (countB !== countA ? countB - countA : extA.localeCompare(extB)))
          .slice(0, 3)
          .map(([ext, count]) => `${count} *${ext || "no-ext"}`)
          .join(", ");
        if (counts.length > 3) summary += ", ...";
        const numFiles = normalizeInteger(dir?.numFiles) ?? 0;
        text += `${indent}- ${child.name}${sep}\n`;
        text += `${indent}  [${numFiles} file${numFiles === 1 ? "" : "s"} in subtree: ${summary}]\n`;
      } else {
        text += `${indent}- ${child.name}${sep}...\n`;
      }
    }
    return text;
  };
  return render(root, 0);
}

function directoryTreeBasename(path) {
  const normalized = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function renderDirectoryTreeTerminalMetadata(metadata, indent) {
  if (!metadata || typeof metadata !== "object") return "";
  const iso = (ms) => new Date(Number(ms)).toISOString();
  const commandLine = (entry) => [
    stringField(entry, "command"),
    entry?.exitCode !== undefined && entry?.exitCode !== null ? `exit: ${entry.exitCode}` : undefined,
    entry?.timestampMs !== undefined && entry?.timestampMs !== null ? `time: ${iso(entry.timestampMs)}` : undefined,
    entry?.durationMs !== undefined && entry?.durationMs !== null ? `duration: ${entry.durationMs}ms` : undefined,
  ].filter(Boolean).join(", ");
  let text = "";
  const cwd = stringField(metadata, "cwd");
  if (cwd) text += `${indent}cwd: ${cwd}\n`;
  if (metadata.lastModifiedMs) text += `${indent}last modified: ${iso(metadata.lastModifiedMs)}\n`;
  const lastCommands = arrayField(metadata, "lastCommands");
  if (lastCommands.length > 0) {
    text += `${indent}last commands:\n`;
    for (const entry of lastCommands) text += `${indent}  - ${commandLine(entry)}\n`;
  }
  if (metadata.currentCommand) {
    text += `${indent}current command:\n`;
    text += `${indent}  - ${commandLine(metadata.currentCommand)}\n`;
  }
  return text;
}

function collectDirectoryEntryLines(payload) {
  const out = [];
  for (const key of ["entries", "files", "items", "children"]) {
    appendDirectoryEntries(out, payload?.[key]);
  }
  return out;
}

function appendDirectoryEntries(out, entries, prefix = "") {
  if (!Array.isArray(entries)) return;
  for (const entry of entries.slice(0, 200)) {
    if (typeof entry === "string") {
      out.push(`${prefix}${entry}`);
      continue;
    }
    if (!entry || typeof entry !== "object") {
      out.push(`${prefix}${String(entry)}`);
      continue;
    }
    const name = firstNonEmptyString(entry.name, entry.path, entry.relativePath, entry.relative_path, entry.uri);
    const type = firstNonEmptyString(entry.type, entry.kind, entry.fileType);
    const suffix = type ? ` (${type})` : "";
    if (name) out.push(`${prefix}${name}${suffix}`);
    appendDirectoryEntries(out, entry.children, `${prefix}  `);
  }
  if (entries.length > 200) out.push(`${prefix}...[${entries.length - 200} more entries]`);
}

function stringifyDiagnosticsResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "Unknown error";
  if (result.case !== "success") {
    const payload = result.value && typeof result.value === "object" ? result.value : {};
    const message = firstNonEmptyString(payload.errorMessage, payload.error, payload.message, payload.reason, payload.stderr, payload.output);
    return `Error: ${message || safeJson(result.value ?? {}, 4000)}`;
  }
  const payload = result.value && typeof result.value === "object" ? result.value : {};
  const directText = firstNonEmptyString(payload.output, payload.stdout, payload.text, payload.content, payload.message);
  if (directText) return truncateTextWithNotice(directText, 12000);
  const hasFlatDiagnostics = arrayField(payload, "diagnostics").length > 0;
  if (arrayField(payload, "fileDiagnostics").length || (payload.totalDiagnostics !== undefined && !hasFlatDiagnostics)) {
    return formatNativeReadLintsForProvider(payload);
  }
  // Legacy flat diagnostics shapes were never filtered by Cursor's executor, so
  // apply the harness's ERROR/WARNING-only behavior before the official render.
  const kept = collectDiagnostics(payload).filter((diagnostic) => {
    const label = diagnosticSeverityLabel(
      diagnostic?.severity ?? diagnostic?.level ?? diagnostic?.type ?? diagnostic?.kind,
    );
    return label === "ERROR" || label === "WARNING";
  });
  const byFile = new Map();
  for (const diagnostic of kept) {
    const file = firstNonEmptyString(diagnostic.file, diagnostic.path, diagnostic.uri) ||
      stringField(payload, "path") || "(unknown)";
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({
      severity: diagnostic?.severity ?? diagnostic?.level ?? diagnostic?.type ?? diagnostic?.kind,
      message: firstNonEmptyString(diagnostic.message, diagnostic.text, diagnostic.reason, diagnostic.code),
      source: stringField(diagnostic, "source"),
      isStale: diagnostic?.isStale === true,
      range: {
        start: {
          line: diagnostic?.range?.start?.line ?? diagnostic.line ?? diagnostic.lineNumber ?? diagnostic.startLine ?? diagnostic.start_line,
          column: diagnostic?.range?.start?.column ?? diagnostic.column ?? diagnostic.col ?? diagnostic.startColumn ?? diagnostic.start_column,
        },
      },
    });
  }
  const fileEntries = [...byFile.entries()].map(([path, diagnostics]) => ({
    path,
    diagnostics,
    count: diagnostics.length,
  }));
  return renderReadLintsFileEntries(fileEntries, kept.length, fileEntries.length);
}

// Cursor's agent-exec ReadLints render: native totals drive the headline, each
// file block starts with a leading blank separator line, every entry renders as
// `[SEVERITY] L<line>:<col>`, and a stale-lint system reminder is appended when
// any diagnostic was computed against an older file revision.
function formatNativeReadLintsForProvider(payload) {
  const fileEntries = arrayField(payload, "fileDiagnostics").map((file) => {
    const diagnostics = arrayField(file, "diagnostics");
    return {
      path: stringField(file, "path") || stringField(file, "uri"),
      diagnostics,
      count: normalizeInteger(file?.diagnosticsCount) ?? diagnostics.length,
    };
  });
  const totalDiagnostics = normalizeInteger(payload?.totalDiagnostics) ??
    fileEntries.reduce((sum, file) => sum + file.count, 0);
  const totalFiles = normalizeInteger(payload?.totalFiles) ??
    fileEntries.filter((file) => file.count > 0).length;
  return renderReadLintsFileEntries(fileEntries, totalDiagnostics, totalFiles);
}

function renderReadLintsFileEntries(fileEntries, totalDiagnostics, totalFiles) {
  if (totalDiagnostics === 0) return "No linter errors found.";
  const lines = [];
  let hasStale = false;
  for (const file of fileEntries) {
    if (file.count <= 0) continue;
    lines.push(`\n${file.path} (${file.count} error${file.count > 1 ? "s" : ""}):`);
    for (const diagnostic of file.diagnostics) {
      const label = diagnosticSeverityLabel(diagnostic?.severity);
      const start = diagnostic?.range?.start && typeof diagnostic.range.start === "object" ? diagnostic.range.start : {};
      const line = normalizeInteger(start.line) ?? 0;
      const column = normalizeInteger(start.column ?? start.character) ?? 0;
      const message = stringField(diagnostic, "message");
      const source = stringField(diagnostic, "source");
      if (diagnostic?.isStale === true) hasStale = true;
      const stale = diagnostic?.isStale === true ? ", stale" : "";
      lines.push(`  [${label}] L${line}:${column} - ${message}${source ? ` (${source})` : ""}${stale}`);
    }
  }
  let text = `Found ${totalDiagnostics} linter error${totalDiagnostics > 1 ? "s" : ""} in ${totalFiles} file${totalFiles > 1 ? "s" : ""}:${lines.join("\n")}`;
  if (hasStale) {
    text += '\n\n<system_reminder>Lints marked "stale" were computed on an older version of the file, and may be outdated.</system_reminder>';
  }
  return truncateTextWithNotice(text, 12000);
}

// Severity labels follow Cursor's agent-exec mapping: ERROR, WARNING,
// INFORMATION -> INFO, everything else -> HINT.
function diagnosticSeverityLabel(severity) {
  if (typeof severity === "string") {
    const upper = severity.toUpperCase();
    if (upper.includes("ERR")) return "ERROR";
    if (upper.includes("WARN")) return "WARNING";
    if (upper.includes("INFO")) return "INFO";
    return "HINT";
  }
  if (Number.isInteger(severity)) {
    return ["HINT", "ERROR", "WARNING", "INFO"][severity] || "HINT";
  }
  return "HINT";
}

function collectDiagnostics(payload) {
  const out = [];
  appendDiagnostics(out, payload?.diagnostics);
  appendDiagnostics(out, payload?.lints);
  appendDiagnostics(out, payload?.items);
  appendDiagnostics(out, payload?.errors);
  const byFile = payload?.byFile || payload?.files || payload?.workspaceDiagnostics;
  if (byFile && typeof byFile === "object" && !Array.isArray(byFile)) {
    for (const [file, value] of Object.entries(byFile)) {
      if (Array.isArray(value)) appendDiagnostics(out, value, file);
      else if (Array.isArray(value?.diagnostics)) appendDiagnostics(out, value.diagnostics, file);
    }
  }
  return out;
}

function appendDiagnostics(out, diagnostics, fallbackFile = "") {
  if (!Array.isArray(diagnostics)) return;
  for (const diagnostic of diagnostics) {
    if (diagnostic && typeof diagnostic === "object") {
      out.push(fallbackFile && !diagnostic.file && !diagnostic.path ? { ...diagnostic, file: fallbackFile } : diagnostic);
    } else {
      out.push({ message: String(diagnostic), file: fallbackFile });
    }
  }
}

function formatDiagnosticLine(diagnostic) {
  const file = firstNonEmptyString(diagnostic.file, diagnostic.path, diagnostic.uri);
  const line = normalizeInteger(diagnostic.line ?? diagnostic.lineNumber ?? diagnostic.startLine ?? diagnostic.start_line);
  const column = normalizeInteger(diagnostic.column ?? diagnostic.col ?? diagnostic.startColumn ?? diagnostic.start_column);
  const severity = firstNonEmptyString(diagnostic.severity, diagnostic.level, diagnostic.type, diagnostic.kind);
  const message = firstNonEmptyString(diagnostic.message, diagnostic.text, diagnostic.reason, diagnostic.code) || safeJson(diagnostic, 1000);
  const location = [
    file || "(unknown)",
    line !== undefined ? String(line) : "",
    column !== undefined ? String(column) : "",
  ].filter(Boolean).join(":");
  return `${location}${severity ? ` [${severity}]` : ""} ${message}`;
}

function stringifyFetchResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return stringifyGenericExecResultForProvider("WebFetch", value);
  if (result.case !== "success") return formatToolFailureForProvider("WebFetch", result);
  const payload = result.value && typeof result.value === "object" ? result.value : {};
  const directText = firstNonEmptyString(payload.markdown, payload.content, payload.body, payload.text, payload.output, payload.stdout, payload.message);
  if (directText) {
    const url = firstNonEmptyString(payload.url, payload.uri);
    const markdown = truncateFetchMarkdown(directText);
    return url ? `# Content from ${url}\n\n${markdown}` : markdown;
  }
  return formatToolSuccessForProvider("WebFetch", payload);
}

// Cursor's agent-exec Glob render: flatten grep files_with_matches workspace
// results into one file list (relativized against the search path when given),
// then render `Result of search in '<path>'` with a 5000-char file budget.
function stringifyGlobResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "Glob failed";
  if (result.case !== "success") return formatToolFailureForProvider("Glob", result);
  const success = result.value && typeof result.value === "object" ? result.value : {};
  const flattened = flattenGlobWorkspaceResults(success);
  if (!flattened) return "glob_file_search didn't return the result";
  const basePath = stringField(success, "path") || ".";
  const stripped = basePath.replace(/\/$/, "");
  const files = flattened.files.map((file) => {
    if (stripped === ".") return file.replace(/^\.\/?/, "");
    const prefix = `${stripped.replace(/\/$/, "")}/`;
    return file.startsWith(prefix) ? file.slice(prefix.length) : file;
  });
  if (files.length === 0) return `Result of search in '${basePath}': 0 files found`;
  let text = `Result of search in '${basePath}'`;
  if (flattened.ripgrepTruncated !== true) {
    text += ` (total ${flattened.totalFiles} file${flattened.totalFiles === 1 ? "" : "s"})`;
  }
  text += ":\n";
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (text.length + file.length > GLOB_FILES_MAX_CHARS) {
      const remaining = Math.max(0, flattened.totalFiles - index);
      text += flattened.ripgrepTruncated
        ? `... at least ${remaining} more files ... (Do a more specific search if needed)\n`
        : `... ${remaining} more files ... (Do a more specific search if needed)\n`;
      break;
    }
    text += `- ${file}\n`;
  }
  return text.replace(/\n$/, "");
}

function flattenGlobWorkspaceResults(success) {
  const workspaceResults = objectField(success, "workspaceResults");
  if (!Object.keys(workspaceResults).length) return undefined;
  const searchPath = stringField(success, "path");
  const files = [];
  let totalFiles = 0;
  let clientTruncated = false;
  let ripgrepTruncated = false;
  let sawFiles = false;
  for (const [workspaceRoot, workspaceResult] of Object.entries(workspaceResults)) {
    const union = unwrapResultUnion(workspaceResult);
    if (union.case !== "files") continue;
    sawFiles = true;
    let workspaceFiles = arrayField(union.value, "files").map(String);
    if (searchPath) {
      const base = nodePath.isAbsolute(searchPath) ? searchPath : nodePath.resolve(String(workspaceRoot), searchPath);
      workspaceFiles = workspaceFiles.map((file) => nodePath.relative(base, nodePath.resolve(String(workspaceRoot), file)));
    }
    files.push(...workspaceFiles);
    totalFiles += normalizeInteger(union.value?.totalFiles) ?? 0;
    clientTruncated = clientTruncated || union.value?.clientTruncated === true;
    ripgrepTruncated = ripgrepTruncated || union.value?.ripgrepTruncated === true;
  }
  if (!sawFiles) return undefined;
  return { files, totalFiles, clientTruncated, ripgrepTruncated };
}

function stringifyGrepResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "Grep failed";
  if (result.case !== "success") return formatToolFailureForProvider("Grep", result);
  const success = result.value || {};
  const lines = [];
  const workspaceResults = objectField(success, "workspaceResults");
  for (const [workspace, workspaceResult] of Object.entries(workspaceResults)) {
    appendGrepWorkspaceLines(lines, String(workspace), workspaceResult, stringField(success, "pattern"));
  }
  if (lines.length) return truncateTextWithNotice(lines.join("\n"), 12000);
  const files = arrayField(success, "files").map(String);
  if (files.length) return truncateTextWithNotice(`Matched ${files.length} file(s):\n${files.join("\n")}`, 12000);
  const pattern = stringField(success, "pattern") || stringField(success, "query");
  return `grep returned success but no formatted matches for pattern ${pattern}`;
}

function appendGrepWorkspaceLines(lines, workspace, workspaceResult, pattern = "") {
  const union = unwrapResultUnion(workspaceResult);
  switch (union.case) {
    case "content": {
      const matches = orderGrepFileMatchesForProvider(arrayField(union.value, "matches"), pattern);
      const summaryLines = grepWorkspaceSummaryLines(workspace, matches, pattern);
      for (const summary of summaryLines) lines.push(summary);
      for (const fileMatch of matches.slice(0, 20)) {
        const file = stringField(fileMatch, "file");
        for (const match of arrayField(fileMatch, "matches").slice(0, 5)) {
          lines.push(`[${workspace}] ${file}:${numberOrUnknown(match?.lineNumber)} ${stringField(match, "content")}`);
        }
      }
      break;
    }
    case "files":
      for (const file of arrayField(union.value, "files").slice(0, 20)) {
        lines.push(`[${workspace}] ${String(file)}`);
      }
      break;
    case "count":
      lines.push(
        `[${workspace}] total_matches=${numberOrUnknown(union.value?.totalMatches)} total_files=${numberOrUnknown(union.value?.totalFiles)}`,
      );
      break;
    default:
      break;
  }
}

function orderGrepFileMatchesForProvider(matches, pattern) {
  if (!Array.isArray(matches) || matches.length < 2) return Array.isArray(matches) ? matches : [];
  const symbol = likelyGrepSymbol(pattern);
  if (!symbol) return matches;
  return matches
    .map((fileMatch, index) => ({ fileMatch, index }))
    .sort((left, right) => {
      const scoreDelta = grepFileMatchRelevanceScore(right.fileMatch, symbol) - grepFileMatchRelevanceScore(left.fileMatch, symbol);
      if (scoreDelta !== 0) return scoreDelta;
      return left.index - right.index;
    })
    .map((entry) => entry.fileMatch);
}

function grepFileMatchRelevanceScore(fileMatch, symbol) {
  const file = stringField(fileMatch, "file");
  const calls = [];
  const definitions = [];
  const comments = [];
  const callPattern = new RegExp(`(?:\\.|\\b)${escapeRegExp(symbol)}\\s*\\(`);
  for (const match of arrayField(fileMatch, "matches")) {
    classifyGrepSymbolLine(
      normalizeInteger(match?.lineNumber),
      stringField(match, "content"),
      symbol,
      callPattern,
      calls,
      definitions,
      comments,
    );
  }
  let score = 0;
  if (definitions.length) score += 1000;
  if (calls.length) score += 500;
  if (comments.length) score += 100;
  score += Math.min(arrayField(fileMatch, "matches").length, 20) * 10;
  if (/_test\.[^./]+$/i.test(file)) score -= 800;
  if (/[/\\]testdata[/\\]/i.test(file)) score -= 400;
  else score += 50;
  return score;
}

function grepWorkspaceSummaryLines(workspace, matches, pattern) {
  const symbol = likelyGrepSymbol(pattern);
  if (!symbol) return [];
  const lines = [];
  for (const fileMatch of matches.slice(0, 5)) {
    const file = stringField(fileMatch, "file");
    if (!file) continue;
    const summary = summarizeGrepFileMatches(workspace, file, arrayField(fileMatch, "matches"), symbol);
    if (!summary.length) continue;
    lines.push(`[${workspace}] ${file} summary: ${summary.join("; ")}`);
  }
  return lines;
}

function summarizeGrepFileMatches(workspace, file, matches, symbol) {
  const calls = [];
  const definitions = [];
  const comments = [];
  const resolvedPath = resolveGrepSummaryFilePath(workspace, file);
  const fileLines = readGrepSummaryFileLines(resolvedPath);
  const callPattern = new RegExp(`(?:\\.|\\b)${escapeRegExp(symbol)}\\s*\\(`);
  for (const match of matches) {
    const lineNumber = normalizeInteger(match?.lineNumber);
    if (!Number.isInteger(lineNumber)) continue;
    classifyGrepSymbolLine(lineNumber, stringField(match, "content"), symbol, callPattern, calls, definitions, comments);
  }
  if (fileLines.length && (definitions.length === 0 || calls.length === 0 || comments.length === 0)) {
    for (let index = 0; index < fileLines.length; index += 1) {
      classifyGrepSymbolLine(index + 1, String(fileLines[index] || ""), symbol, callPattern, calls, definitions, comments);
    }
  }
  const summary = [];
  if (definitions.length) summary.push(formatGrepLineSummary("definition", definitions));
  if (calls.length) summary.push(formatGrepCallsiteSummary(fileLines, calls));
  const suggestedWindows = suggestedReadWindowsForSymbol(definitions, calls, fileLines);
  const labeledSuggestedWindows = formatSymbolSuggestedReadWindowsSummary(resolvedPath || file, definitions, calls, fileLines);
  if (labeledSuggestedWindows) summary.push(labeledSuggestedWindows);
  else if (suggestedWindows.length) summary.push(formatSuggestedReadWindowsSummary(resolvedPath || file, suggestedWindows));
  const callsiteBlockSummary = grepCallsiteBlockSummary(fileLines, calls);
  if (callsiteBlockSummary) summary.push(callsiteBlockSummary);
  const callsiteOutcomeSummary = grepCallsiteOutcomeSummary(fileLines, calls);
  if (callsiteOutcomeSummary) summary.push(callsiteOutcomeSummary);
  const commentPreview = grepDefinitionCommentPreview(fileLines, definitions, calls, comments, matches);
  if (commentPreview) summary.push(commentPreview);
  else if (comments.length && (definitions.length || calls.length)) summary.push(formatGrepLineSummary("comment", comments));
  const answerPathSummary = grepSuggestedAnswerPathSummary(definitions, calls, fileLines);
  if (answerPathSummary) summary.push(answerPathSummary);
  if (commentPreview && definitions.length && calls.length) {
    summary.push("Do not request a same-file helper Read only to restate the helper's purpose from this comment preview.");
  }
  if (definitions.length && calls.length) {
    summary.push("Do not request only the caller-reaction window; request the helper-behavior window too.");
    const helperWindow = suggestedDefinitionReadWindow(definitions[0], fileLines);
    if (helperWindow) summary.push(`Do not shorten the helper Read; it should run through line ${helperWindow.endLine}.`);
    summary.push("suggested Read windows usually suffice for invocation, helper behavior, and caller reaction; request both in one response when needed; avoid same-file outcome/helper Grep before those Reads");
  }
  if (resolvedPath && summary.length) summary.unshift(`resolved path ${resolvedPath}`);
  return summary;
}

function grepDefinitionCommentPreview(fileLines, definitions, calls, comments, matches) {
  if ((!Array.isArray(definitions) || !definitions.length) && (!Array.isArray(calls) || !calls.length)) return "";
  if (!Array.isArray(fileLines) || !fileLines.length) return grepMatchedCommentPreview(matches, comments);
  const definitionLine = Number.isInteger(definitions?.[0]) ? definitions[0] : undefined;
  const commentBlock = Number.isInteger(definitionLine) ? readLeadingLineCommentBlock(fileLines, definitionLine) : null;
  if (commentBlock?.text) {
    const range = commentBlock.startLine === commentBlock.endLine
      ? `line ${commentBlock.startLine}`
      : `lines ${commentBlock.startLine}-${commentBlock.endLine}`;
    return `comment preview ${range}: ${commentBlock.text}`;
  }
  if (!Array.isArray(comments) || !comments.length) return grepMatchedCommentPreview(matches, comments);
  const firstComment = comments[0];
  const text = String(fileLines[firstComment - 1] || "").trim().replace(/^\/\/\s?/, "");
  if (!text) return grepMatchedCommentPreview(matches, comments);
  return `comment preview line ${firstComment}: ${text.length > 220 ? `${text.slice(0, 217)}...` : text}`;
}

function grepMatchedCommentPreview(matches, comments) {
  if (!Array.isArray(matches) || !Array.isArray(comments) || !comments.length) return "";
  const firstComment = comments[0];
  const matched = matches.find((match) => normalizeInteger(match?.lineNumber) === firstComment);
  const text = stringField(matched, "content").trim().replace(/^\/\/\s?/, "");
  if (!text) return "";
  return `comment preview line ${firstComment}: ${text.length > 220 ? `${text.slice(0, 217)}...` : text}`;
}

function classifyGrepSymbolLine(lineNumber, content, symbol, callPattern, calls, definitions, comments) {
  if (!Number.isInteger(lineNumber)) return;
  const text = stringOrEmpty(content);
  if (!text.includes(symbol)) return;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
    comments.push(lineNumber);
    return;
  }
  if (/^(?:func|type)\b/.test(trimmed)) {
    definitions.push(lineNumber);
    return;
  }
  if (callPattern.test(trimmed)) calls.push(lineNumber);
}

function formatGrepLineSummary(label, lineNumbers) {
  const unique = [...new Set(lineNumbers)].sort((left, right) => left - right);
  const noun = unique.length === 1 ? label : `${label}s`;
  const lineWord = unique.length === 1 ? "line" : "lines";
  return `${noun} at ${lineWord} ${unique.join(", ")}`;
}

function formatGrepCallsiteSummary(fileLines, lineNumbers) {
  const base = formatGrepLineSummary("callsite", lineNumbers);
  const enclosing = grepEnclosingFunctionSummary(fileLines, lineNumbers);
  return enclosing ? `${base} inside ${enclosing}` : base;
}

function grepEnclosingFunctionSummary(lines, lineNumbers) {
  if (!Array.isArray(lines) || !lines.length) return "";
  const contexts = [];
  for (const lineNumber of [...new Set(lineNumbers)].sort((left, right) => left - right)) {
    const context = enclosingFunctionForLine(lines, lineNumber);
    if (context) contexts.push(context);
  }
  const uniqueContexts = uniqueFunctionContexts(contexts);
  if (!uniqueContexts.length) return "";
  if (uniqueContexts.length === 1) {
    return `${uniqueContexts[0].name} (line ${uniqueContexts[0].line})`;
  }
  return uniqueContexts.map((context) => `${context.name} (line ${context.line})`).join(", ");
}

function grepCallsiteBlockSummary(lines, lineNumbers) {
  if (!Array.isArray(lines) || !lines.length) return "";
  const windows = [...new Set(lineNumbers)].sort((left, right) => left - right)
    .map((lineNumber) => suggestedCallsiteReadWindow(lines, lineNumber, lines.length))
    .filter((window) => Number.isInteger(window?.startLine) && Number.isInteger(window?.endLine));
  if (!windows.length) return "";
  const merged = mergeReadWindows(windows);
  const formatted = merged.slice(0, 2).map((window) => `${window.startLine}-${window.endLine}`).join(", ");
  return merged.length === 1
    ? `callsite block at lines ${formatted}`
    : `callsite blocks at lines ${formatted}`;
}

function grepCallsiteOutcomeSummary(lines, lineNumbers) {
  if (!Array.isArray(lines) || !lines.length) return "";
  const refs = [];
  for (const lineNumber of [...new Set(lineNumbers)].sort((left, right) => left - right)) {
    const next = readCallsiteOutcomeRefsForLine(lines, lineNumber - 1, 1);
    for (const ref of next) {
      if (refs.includes(ref)) continue;
      refs.push(ref);
      if (refs.length >= 4) break;
    }
    if (refs.length >= 4) break;
  }
  return refs.length ? `callsite outcomes: ${refs.join(", ")}` : "";
}

function resolveGrepSummaryFilePath(workspace, file) {
  if (!file) return "";
  if (nodePath.isAbsolute(file)) return file;
  if (typeof workspace === "string" && workspace && nodePath.isAbsolute(workspace)) {
    return nodePath.resolve(workspace, file);
  }
  return "";
}

function readGrepSummaryFileLines(resolvedPath) {
  if (!resolvedPath) return [];
  try {
    return fs.readFileSync(resolvedPath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  } catch {
    return [];
  }
}

function enclosingFunctionForLine(lines, lineNumber) {
  if (!Array.isArray(lines) || !Number.isInteger(lineNumber) || lineNumber < 1) return null;
  for (let index = Math.min(lines.length - 1, lineNumber - 1); index >= 0; index--) {
    const match = String(lines[index] || "").match(/^\s*func(?:\s*\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (match) return { name: match[1], line: index + 1 };
  }
  return null;
}

function uniqueFunctionContexts(contexts) {
  const seen = new Set();
  const unique = [];
  for (const context of contexts) {
    if (!context || typeof context.name !== "string" || !Number.isInteger(context.line)) continue;
    const key = `${context.name}:${context.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(context);
  }
  return unique;
}

function suggestedReadWindowsForSymbol(definitions, calls, fileLines) {
  const totalLines = Array.isArray(fileLines) ? fileLines.length : normalizeInteger(fileLines);
  const windows = [];
  for (const line of [...new Set(definitions)].sort((left, right) => left - right)) {
    const helperWindow = suggestedDefinitionReadWindow(line, fileLines, totalLines);
    if (helperWindow) windows.push(helperWindow);
  }
  for (const line of [...new Set(calls)].sort((left, right) => left - right)) {
    windows.push(suggestedCallsiteReadWindow(fileLines, line, totalLines));
  }
  return mergeReadWindows(windows).slice(0, 3);
}

function suggestedDefinitionReadWindow(definitionLine, fileLines, totalLinesArg) {
  const totalLines = Array.isArray(fileLines) ? fileLines.length : normalizeInteger(fileLines) || totalLinesArg;
  const endLine = suggestedDefinitionReadWindowEnd(fileLines, definitionLine, totalLines);
  if (!Number.isInteger(endLine) || endLine < definitionLine) return null;
  return {
    startLine: suggestedDefinitionReadWindowStart(fileLines, definitionLine),
    endLine,
  };
}

function suggestedDefinitionReadWindowStart(fileLines, definitionLine) {
  const commentBlock = readLeadingLineCommentBlock(fileLines, definitionLine);
  if (Number.isInteger(commentBlock?.startLine)) return commentBlock.startLine;
  return Math.max(1, definitionLine - 6);
}

function formatSymbolSuggestedReadWindowsSummary(path, definitions, calls, fileLines) {
  const definitionLine = [...new Set(definitions)].sort((left, right) => left - right)[0];
  const callLine = [...new Set(calls)].sort((left, right) => left - right)[0];
  if (!Number.isInteger(definitionLine) || !Number.isInteger(callLine)) return "";
  const helperWindow = suggestedDefinitionReadWindow(definitionLine, fileLines);
  const callerWindow = suggestedCallsiteReadWindow(fileLines, callLine, Array.isArray(fileLines) ? fileLines.length : normalizeInteger(fileLines));
  if (!helperWindow || !callerWindow) return "";
  const targetPath = stringOrEmpty(path);
  const formatWindow = (window) => {
    const windowArgs = `offset=${window.startLine} limit=${window.endLine - window.startLine + 1}`;
    return targetPath ? `Read path=${targetPath} ${windowArgs}` : `Read ${windowArgs}`;
  };
  if (helperWindow.startLine === callerWindow.startLine && helperWindow.endLine === callerWindow.endLine) {
    return `next Read (prefer this exact window before any other same-file Read or Grep): ${formatWindow(helperWindow)}`;
  }
  return `next Reads together (issue these exact windows in one response before any other same-file Read or Grep): caller window: ${formatWindow(callerWindow)}; helper window: ${formatWindow(helperWindow)}`;
}

function suggestedCallsiteReadWindow(fileLines, lineNumber, totalLines) {
  if (!Array.isArray(fileLines) || !fileLines.length) {
    return {
      startLine: Math.max(1, lineNumber - 12),
      endLine: boundedReadWindowEnd(Math.max(lineNumber, lineNumber + 20), totalLines),
    };
  }
  return {
    startLine: suggestedCallsiteReadWindowStart(fileLines, lineNumber),
    endLine: suggestedCallsiteReadWindowEnd(fileLines, lineNumber, totalLines),
  };
}

function suggestedCallsiteReadWindowStart(lines, lineNumber) {
  if (!Array.isArray(lines) || !lines.length || !Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > lines.length) {
    return Math.max(1, normalizeInteger(lineNumber) || 1);
  }
  const minLine = Math.max(1, lineNumber - 12);
  let startLine = lineNumber;
  while (startLine > minLine) {
    const previous = String(lines[startLine - 2] || "");
    if (!previous.trim()) break;
    startLine -= 1;
  }
  return startLine;
}

function suggestedCallsiteReadWindowEnd(lines, lineNumber, totalLines) {
  if (!Array.isArray(lines) || !lines.length || !Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > lines.length) {
    return boundedReadWindowEnd(Math.max(lineNumber, lineNumber + 20), totalLines);
  }
  const maxLine = Math.min(lines.length, lineNumber + 20);
  let endLine = lineNumber;
  while (endLine < maxLine) {
    const next = String(lines[endLine] || "");
    if (!next.trim()) break;
    endLine += 1;
  }
  return boundedReadWindowEnd(endLine, totalLines);
}

function grepSuggestedAnswerPathSummary(definitions, calls, fileLines) {
  const normalizedDefinitions = [...new Set(definitions)].sort((left, right) => left - right);
  const normalizedCalls = [...new Set(calls)].sort((left, right) => left - right);
  if (!normalizedDefinitions.length || !normalizedCalls.length) return "";
  const totalLines = Array.isArray(fileLines) ? fileLines.length : normalizeInteger(fileLines);
  const definitionLine = normalizedDefinitions[0];
  const callLine = normalizedCalls[0];
  const helperWindow = {
    startLine: suggestedDefinitionReadWindowStart(fileLines, definitionLine),
    endLine: suggestedDefinitionReadWindowEnd(fileLines, definitionLine, totalLines),
  };
  const callsiteWindow = suggestedCallsiteReadWindow(fileLines, callLine, totalLines);
  if (!Number.isInteger(helperWindow.endLine) || !Number.isInteger(callsiteWindow.endLine)) return "";
  return `answer path: caller reaction in lines ${callsiteWindow.startLine}-${callsiteWindow.endLine}; helper behavior in lines ${helperWindow.startLine}-${helperWindow.endLine}`;
}

function suggestedDefinitionReadWindowEnd(fileLines, definitionLine, totalLines) {
  let endLine = Math.max(definitionLine, definitionLine + 170);
  if (!Array.isArray(fileLines) || !fileLines.length) return boundedReadWindowEnd(endLine, totalLines);
  const bodyEndLine = readFunctionBodyEndLine(fileLines, definitionLine);
  if (Number.isInteger(bodyEndLine)) endLine = bodyEndLine;
  return boundedReadWindowEnd(endLine, totalLines);
}

function readFunctionBodyEndLine(lines, definitionLine) {
  if (!Array.isArray(lines) || !Number.isInteger(definitionLine) || definitionLine < 1 || definitionLine > lines.length) return undefined;
  let depth = 0;
  let started = false;
  for (let index = definitionLine - 1; index < lines.length; index += 1) {
    const line = String(lines[index] || "");
    const openCount = countChar(line, "{");
    const closeCount = countChar(line, "}");
    if (!started && openCount > 0) started = true;
    if (started) {
      depth += openCount - closeCount;
      if (depth <= 0) return index + 1;
    }
  }
  return undefined;
}

function countChar(text, char) {
  let count = 0;
  for (const ch of String(text || "")) {
    if (ch === char) count += 1;
  }
  return count;
}

function boundedReadWindowEnd(candidateEndLine, totalLines) {
  const normalizedEnd = Math.max(1, normalizeInteger(candidateEndLine) || 1);
  const normalizedTotalLines = normalizeInteger(totalLines);
  if (!Number.isInteger(normalizedTotalLines) || normalizedTotalLines < 1) return normalizedEnd;
  return Math.min(normalizedEnd, normalizedTotalLines);
}

function mergeReadWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return [];
  const normalized = windows
    .filter((window) => Number.isInteger(window?.startLine) && Number.isInteger(window?.endLine))
    .map((window) => ({
      startLine: Math.max(1, window.startLine),
      endLine: Math.max(window.startLine, window.endLine),
    }))
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  if (!normalized.length) return [];
  const merged = [normalized[0]];
  for (let index = 1; index < normalized.length; index++) {
    const current = normalized[index];
    const previous = merged[merged.length - 1];
    if (current.startLine <= previous.endLine + 5) {
      previous.endLine = Math.max(previous.endLine, current.endLine);
      continue;
    }
    merged.push(current);
  }
  return merged;
}

function formatSuggestedReadWindowsSummary(path, windows) {
  const targetPath = stringOrEmpty(path);
  const fragments = windows.map((window) => {
    const windowArgs = `offset=${window.startLine} limit=${window.endLine - window.startLine + 1}`;
    return targetPath ? `path=${targetPath} ${windowArgs}` : windowArgs;
  });
  if (fragments.length > 1) {
    return `next Reads together (issue these exact windows in one response before any other same-file Read or Grep): Read ${fragments.join("; Read ")}`;
  }
  return `next Read (prefer these exact windows before any other same-file Read or Grep): ${fragments[0]}`;
}

function likelyGrepSymbol(pattern) {
  const tokens = String(pattern || "").match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  const candidates = tokens.filter((token) => !GREP_PATTERN_STOP_WORDS.has(token));
  if (!candidates.length) return "";
  return candidates.sort((left, right) => right.length - left.length)[0];
}

function unwrapResultUnion(value) {
  if (value?.result?.case) return { case: value.result.case, value: value.result.value || {} };
  for (const caseName of ["content", "files", "count"]) {
    if (value?.[caseName] !== undefined) return { case: caseName, value: value[caseName] || {} };
  }
  return { case: undefined, value: {} };
}

function stringifyMcpResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "MCP tool failed";
  if (result.case !== "success") return formatToolFailureForProvider("MCP", result);
  const success = result.value || {};
  const blocks = [];
  for (const item of arrayField(success, "content")) {
    const text = stringifyMcpContentBlock(item);
    if (text) blocks.push(text);
  }
  if (blocks.length) return truncateTextWithNotice(blocks.filter(Boolean).join("\n\n"), 12000);
  if (success.structuredContent) return safeJson(success.structuredContent, 12000);
  return "MCP tool completed successfully.";
}

function stringifyMcpContentBlock(item) {
  const content = item?.content || item;
  if (!content || typeof content !== "object") return "";
  if (content.case === "text") return mcpTextValue(content.value);
  if (content.case === "image") return `[image ${stringField(content.value, "mimeType") || "unknown"}]`;
  if (content.type === "text") return stringField(content, "text");
  if (content.type === "image") return `[image ${stringField(content, "mimeType") || "unknown"}]`;
  if (content.type === "resource") return stringifyMcpResourceBlock(content);
  return safeJson(item, 4000);
}

function stringifyMcpResourceBlock(content) {
  const resource = content.resource;
  if (!resource || typeof resource !== "object") return safeJson(content, 4000);
  const text = stringField(resource, "text");
  if (text) return text;
  const uri = stringField(resource, "uri");
  const mimeType = stringField(resource, "mimeType");
  return `[resource${uri ? ` ${uri}` : ""}${mimeType ? ` ${mimeType}` : ""}]`;
}

function stringifyListMcpResourcesResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "List MCP resources failed";
  if (result.case !== "success") return formatToolFailureForProvider("List MCP resources", result);
  const resources = arrayField(result.value, "resources");
  if (!resources.length) return "No MCP resources available.";
  return truncateTextWithNotice(resources.map((resource) => {
    const name = stringField(resource, "name");
    return `${stringField(resource, "server")} ${stringField(resource, "uri")}${name ? ` - ${name}` : ""}`;
  }).join("\n"), 12000);
}

function stringifyReadMcpResourceResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "Read MCP resource failed";
  if (result.case !== "success") return formatToolFailureForProvider("Read MCP resource", result);
  const success = result.value || {};
  const content = success.content;
  if (content?.case === "text") return truncateTextWithNotice(mcpTextValue(content.value), 12000);
  if (content?.case === "blob") return `Read MCP resource ${stringField(success, "uri")} (binary blob).`;
  return safeJson(success, 12000);
}

function mcpTextValue(value) {
  if (typeof value === "string") return value;
  return stringField(value, "text") || safeJson(value ?? "", 4000);
}

function objectField(value, key) {
  const child = value?.[key];
  return child && typeof child === "object" && !Array.isArray(child) ? child : {};
}

function arrayField(value, key) {
  const child = value?.[key];
  return Array.isArray(child) ? child : [];
}

function stringifyReadResultForProvider(value) {
  const result = value?.result;
  if (!result?.case) return "Unknown error";
  switch (result.case) {
    case "success":
      return stringifyReadSuccessForProvider(result.value || {});
    case "error":
      return stringField(result.value, "error") || "Read failed";
    case "rejected":
      return stringField(result.value, "reason") || "Read operation rejected";
    case "fileNotFound":
      return "File not found";
    case "permissionDenied":
      return "Permission denied";
    case "invalidFile":
      return stringField(result.value, "reason") || "Path is not a valid file to read";
    default:
      return safeJson(value ?? {}, 4000);
  }
}

function stringifyReadSuccessForProvider(value) {
  if (value.isEmpty) return "File is empty.";
  if (value.exceededLimit) return formatReadExceededLimitForProvider(value);
  const containedInRange = normalizedReadRange(value?._byokContainedInReadRange);
  if (containedInRange) return formatContainedReadReuseForProvider(value, containedInRange);
  const output = value.output;
  if (!output?.case && value.outputBlobId !== undefined) {
    return readUnavailableText(value, "content is stored in a Cursor blob");
  }
  if (!output?.case) return readUnavailableText(value, "no output");
  if (output.case === "content") return formatReadOutputForModel(String(output.value ?? ""), value);
  if (output.case === "data") {
    const text = typeof output.value === "string" ? output.value : safeJson(output.value ?? "", 12000);
    return formatReadOutputForModel(text, value);
  }
  if (output.case === "contentBlobId" || output.case === "dataBlobId") {
    return readUnavailableText(value, "content is stored in a Cursor blob");
  }
  return readUnavailableText(value, `unsupported output ${output.case}`);
}

function formatReadExceededLimitForProvider(value) {
  if (value.exceededLimitReason === "provider_visible_chars") {
    return `Read result expands to ${numberOrUnknown(value.providerVisibleChars)} characters after Cursor line formatting, which exceeds maximum allowed characters (100000 characters).\nPlease retry Read with a smaller offset and limit window, or use the 'grep' tool to search for specific content.`;
  }
  return `File content (${numberOrUnknown(value.fileSize)} characters) exceeds maximum allowed characters (100000 characters).\nPlease use offset and limit parameters to read specific portions of the file, or use the 'grep' tool to search for specific content.`;
}

function formatContainedReadReuseForProvider(value, parentRange) {
  const lineRange = readLineRangeForModel("", value);
  const path = stringField(value, "path");
  return `File: ${path}\nLines: ${lineRange}\nRequested lines are already contained in earlier Read lines ${parentRange.startLine}-${parentRange.endLine} of the same file. Reuse the earlier Read directly for citation; no new file content is repeated here.`;
}

function formatReadOutputForModel(text, readResult) {
  const content = formatReadContentForModel(text, readResult);
  if (!readResult || typeof readResult.path !== "string" || !readResult.path) return content;
  const lineRange = readLineRangeForModel(text, readResult);
  const summary = readWindowSummaryForModel(text, readResult);
  return `File: ${readResult.path}\nLines: ${lineRange}\n${summary ? `${summary}\n` : ""}${content}`;
}

function formatReadContentForModel(text, readResult) {
  if (text.length === 0) return "File is empty.";
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line) continue;
    if (/^\s*\d+\|/.test(line)) return text;
    break;
  }
  const hadTrailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (hadTrailingNewline) lines.pop();
  const startLine = readStartLine(readResult);
  const formatted = lines.map((line, index) => `${String(startLine + index).padStart(6, " ")}|${line}`).join("\n");
  return hadTrailingNewline ? `${formatted}\n` : formatted;
}

function readLineRangeForModel(text, readResult) {
  const range = readResult?.readRange && typeof readResult.readRange === "object" ? readResult.readRange : {};
  const startLine = readStartLine(readResult);
  const explicitEndLine = normalizeInteger(range.endLine ?? range.end ?? range.to ?? readResult?.endLine ?? readResult?.end);
  if (explicitEndLine !== undefined && explicitEndLine >= startLine) return `${startLine}-${explicitEndLine}`;
  const lineCount = readVisibleLineCount(text);
  return lineCount > 0 ? `${startLine}-${startLine + lineCount - 1}` : String(startLine);
}

function readVisibleLineCount(text) {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  return lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function readStartLine(readResult) {
  const range = readResult?.readRange && typeof readResult.readRange === "object" ? readResult.readRange : {};
  const raw = range.startLine ?? range.start ?? range.from ?? readResult?.startLine ?? readResult?.start ?? 1;
  const line = normalizeInteger(raw);
  return line !== undefined && line >= 1 ? line : 1;
}

function readWindowSummaryForModel(text, readResult) {
  const rawText = stripReadLinePrefixes(text);
  const summary = [];
  const startLine = readStartLine(readResult);
  const leadingFunction = readLeadingFunctionDefinition(rawText, startLine);
  const currentFunction = leadingFunction?.name || "";
  const summaryScope = currentFunction
    ? readPrimaryFunctionSummaryScope(rawText, startLine, leadingFunction)
    : { text: rawText, startLine };
  const summaryText = summaryScope.text;
  const summaryStartLine = summaryScope.startLine;
  const summaryEndLine = Number.isInteger(summaryScope.endLine)
    ? summaryScope.endLine
    : summaryStartLine + Math.max(0, readVisibleLineCount(summaryText) - 1);
  const fullFunctionRange = currentFunction
    ? readPrimaryFunctionFileRange(readResult?.path, leadingFunction)
    : null;
  if (currentFunction) {
    if (Number.isInteger(summaryEndLine) && summaryEndLine >= summaryStartLine) {
      if (Number.isInteger(fullFunctionRange?.endLine) && fullFunctionRange.endLine > summaryEndLine) {
        summary.push(`Primary function body in this window: ${summaryStartLine}-${summaryEndLine} (function continues through line ${fullFunctionRange.endLine} in file)`);
        if (typeof readResult?.path === "string" && readResult.path) {
          summary.push(`If you need the remainder, next Read: path=${readResult.path} offset=${startLine} limit=${fullFunctionRange.endLine - startLine + 1}; do not request a later-offset tail Read.`);
        } else {
          summary.push(`If you need the remainder, extend this same-file Read from line ${startLine} rather than requesting a tail-only Read.`);
        }
        const tailSummary = readPartialFunctionTailSummary(readResult?.path, leadingFunction, currentFunction, summaryEndLine, fullFunctionRange.endLine);
        if (tailSummary.helperRefs.length) summary.push(`Later same-file helper refs: ${tailSummary.helperRefs.join(", ")}`);
        if (tailSummary.returnRefs.length) summary.push(`Later same-file returns: ${tailSummary.returnRefs.join(", ")}`);
        if (tailSummary.effectRefs.length) summary.push(`Later same-file effects: ${tailSummary.effectRefs.join(", ")}`);
      } else {
        summary.push(`Primary function body in this window: ${summaryStartLine}-${summaryEndLine}`);
      }
    }
    const helperEntries = readHelperReferenceEntries(summaryText, currentFunction, summaryStartLine);
    const helperRefs = helperEntries.slice(0, 6).map((entry) => `${entry.name}(line ${[...new Set(entry.lines)].join(", ")})`);
    if (helperRefs.length) summary.push(`Helper refs in this window: ${helperRefs.join(", ")}`);
    const helperDefs = readHelperDefinitionReferences(readResult?.path, helperEntries);
    if (helperDefs.length) summary.push(`Helper defs in this file: ${helperDefs.join(", ")}`);
    const topLevelSymbolPreviews = readSameFileTopLevelSymbolPreviews(readResult?.path, summaryText, summaryStartLine, summaryEndLine);
    if (topLevelSymbolPreviews.length) {
      summary.push(`Same-file symbol previews: ${topLevelSymbolPreviews.join("; ")}`);
      summary.push("High-level same-file symbol meaning is already visible from these previews. Do not Grep the same file for those symbol names unless you still need exact declaration details.");
    }
    const helperCommentEntries = readLocalAssignmentHelperEntries(summaryText, summaryStartLine).concat(helperEntries);
    const helperCommentPreviews = readSameFileHelperCommentPreviews(readResult?.path, helperCommentEntries, summaryStartLine, summaryEndLine);
    if (helperCommentPreviews.length) {
      summary.push(`Same-file helper comments: ${helperCommentPreviews.join("; ")}`);
      summary.push("High-level helper purpose is already visible from these same-file helper comments. Do not request same-file helper Reads only because those helper names appear in Helper defs in this file; only request helper bodies if you still need internal branch details.");
    }
  }
  const returnRefs = readReturnReferences(summaryText, summaryStartLine);
  if (returnRefs.length) summary.push(`Return refs in this window: ${returnRefs.join(", ")}`);
  const callsiteBlocks = readCallsiteBlocks(summaryText, summaryStartLine);
  if (callsiteBlocks.length) summary.push(`Callsite blocks in this window: ${callsiteBlocks.join(", ")}`);
  const outcomeRefs = readCallsiteOutcomeReferences(summaryText, summaryStartLine);
  if (outcomeRefs.length) summary.push(`Outcome refs in this window: ${outcomeRefs.join(", ")}`);
  const branchRefs = readBranchReferences(summaryText, summaryStartLine);
  if (branchRefs.length >= 2) summary.push(`Branch refs in this window: ${branchRefs.join(", ")}`);
  const localRefs = readLocalAssignmentReferences(summaryText, summaryStartLine, readResult?.path);
  if (localRefs.length) summary.push(`Local refs in this window: ${localRefs.join(", ")}`);
  const helperCommentPreview = !currentFunction
    ? readSameFileHelperCommentPreview(summaryText, summaryStartLine, readResult?.path)
    : "";
  if (helperCommentPreview) {
    summary.push(helperCommentPreview);
    summary.push("High-level helper purpose is already visible from the same-file helper comment. Only request the helper body if you still need internal branch details.");
  }
  const followupHelperRead = !currentFunction
    ? readSuggestedFollowupHelperRead(summaryText, summaryStartLine, readResult?.path)
    : "";
  if (followupHelperRead) summary.push(followupHelperRead);
  if (currentFunction && (returnRefs.length || callsiteBlocks.length)) {
    summary.push("Primary helper behavior is already visible in this window.");
    summary.push("Reuse this same Read directly for helper behavior; do not request another same-file helper Read for citation.");
  } else if (outcomeRefs.length || (callsiteBlocks.length && branchRefs.length >= 2)) {
    summary.push("Caller reaction is already visible in this window.");
    summary.push("Reuse this same Read directly for caller reaction; do not request another same-file caller Read for citation.");
  }
  return summary.join("\n");
}

function stripReadLinePrefixes(text) {
  return String(text || "").split("\n").map((line) => line.replace(/^\s*\d+\|/, "")).join("\n");
}

function readFunctionName(text) {
  const match = String(text || "").match(/^\s*func(?:\s*\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\b/m);
  return match ? match[1] : "";
}

function readStartsWithFunctionDefinition(text) {
  const firstNonEmpty = String(text || "").split("\n").find((line) => line.trim());
  return !!firstNonEmpty && /^\s*func(?:\s*\([^)]*\))?\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(firstNonEmpty);
}

function readLeadingFunctionDefinition(text, startLine = 1) {
  const lines = String(text || "").split("\n");
  let inBlockComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = String(lines[index] || "").trim();
    if (!trimmed) continue;
    if (inBlockComment) {
      const end = trimmed.indexOf("*/");
      if (end < 0) continue;
      inBlockComment = false;
      const remainder = trimmed.slice(end + 2).trim();
      if (!remainder) continue;
      const match = remainder.match(/^func(?:\s*\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      return match ? { name: match[1], line: startLine + index } : null;
    }
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end < 0) {
        inBlockComment = true;
        continue;
      }
      const remainder = trimmed.slice(end + 2).trim();
      if (!remainder) continue;
      const match = remainder.match(/^func(?:\s*\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      return match ? { name: match[1], line: startLine + index } : null;
    }
    if (trimmed.startsWith("*")) continue;
    const match = trimmed.match(/^func(?:\s*\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    return match ? { name: match[1], line: startLine + index } : null;
  }
  return null;
}

function readPrimaryFunctionSummaryScope(text, windowStartLine, leadingFunction) {
  if (!leadingFunction?.name || !Number.isInteger(leadingFunction.line)) {
    const rawText = String(text || "");
    return {
      text: rawText,
      startLine: windowStartLine,
      endLine: windowStartLine + Math.max(0, readVisibleLineCount(rawText) - 1),
    };
  }
  const lines = String(text || "").split("\n");
  const definitionLine = leadingFunction.line - windowStartLine + 1;
  const bodyEndLine = readFunctionBodyEndLine(lines, definitionLine);
  const scopedLines = lines.slice(
    Math.max(0, definitionLine - 1),
    Number.isInteger(bodyEndLine) ? bodyEndLine : lines.length,
  );
  return {
    text: scopedLines.join("\n"),
    startLine: leadingFunction.line,
    endLine: Number.isInteger(bodyEndLine) ? leadingFunction.line + (bodyEndLine - definitionLine) : undefined,
  };
}

function readPrimaryFunctionFileRange(filePath, leadingFunction) {
  if (typeof filePath !== "string" || !filePath || !leadingFunction?.name || !Number.isInteger(leadingFunction.line)) return null;
  const lines = readGrepSummaryFileLines(filePath);
  if (!lines.length) return null;
  const endLine = readFunctionBodyEndLine(lines, leadingFunction.line);
  if (!Number.isInteger(endLine) || endLine < leadingFunction.line) return null;
  return { startLine: leadingFunction.line, endLine };
}

function readPartialFunctionTailSummary(filePath, leadingFunction, currentFunction, visibleEndLine, fullEndLine) {
  if (typeof filePath !== "string" || !filePath) return { helperRefs: [], returnRefs: [], effectRefs: [] };
  if (!leadingFunction?.name || !Number.isInteger(leadingFunction.line)) return { helperRefs: [], returnRefs: [], effectRefs: [] };
  if (!Number.isInteger(visibleEndLine) || !Number.isInteger(fullEndLine) || fullEndLine <= visibleEndLine) {
    return { helperRefs: [], returnRefs: [], effectRefs: [] };
  }
  const fileLines = readGrepSummaryFileLines(filePath);
  if (!fileLines.length) return { helperRefs: [], returnRefs: [], effectRefs: [] };
  const tailStartLine = visibleEndLine + 1;
  const tailText = fileLines.slice(tailStartLine - 1, fullEndLine).join("\n");
  const helperRefs = readHelperReferenceEntries(tailText, currentFunction, tailStartLine)
    .slice(0, 4)
    .map((entry) => `${entry.name}(line ${[...new Set(entry.lines)].join(", ")})`);
  const returnRefs = readReturnReferences(tailText, tailStartLine).slice(0, 3);
  const effectRefs = readTailEffectReferences(tailText, tailStartLine).slice(0, 4);
  return { helperRefs, returnRefs, effectRefs };
}

function readTailEffectReferences(text, startLine = 1) {
  const refs = [];
  const seen = new Set();
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const effect = normalizedTailEffectReference(lines[index], startLine + index);
    if (!effect || seen.has(effect)) continue;
    seen.add(effect);
    refs.push(effect);
  }
  return refs;
}

function normalizedTailEffectReference(line, lineNumber) {
  const text = String(line || "").trim();
  if (!text || text === "}" || text === "{" || text.startsWith("//")) return "";
  if (/^if\s+.+:=\s*(?:r\.)?[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(text)) {
    const compact = text.length > 110 ? `${text.slice(0, 107)}...` : text;
    return `${compact}(line ${lineNumber})`;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*\+=\s*/.test(text)) return `${text}(line ${lineNumber})`;
  if (/^(?:RecordOperation|Update[A-Za-z_][A-Za-z0-9_]*|r\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)\s*\(/.test(text)) {
    const compact = text.length > 110 ? `${text.slice(0, 107)}...` : text;
    return `${compact}(line ${lineNumber})`;
  }
  return "";
}

function readHelperReferences(text, currentFunction, startLine = 1) {
  return readHelperReferenceEntries(text, currentFunction, startLine).map((entry) =>
    `${entry.name}(line ${[...new Set(entry.lines)].join(", ")})`);
}

function readHelperReferenceEntries(text, currentFunction, startLine = 1) {
  const seen = new Map();
  const entries = [];
  const source = String(text || "");
  for (const match of source.matchAll(/\br\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    addReadHelperReferenceEntry(seen, entries, match[1], currentFunction, startLine, source, match.index);
  }
  for (const match of source.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = match[1];
    if (!name || READ_HELPER_PLAIN_CALL_EXCLUDE.has(name)) continue;
    const previousChar = match.index > 0 ? source[match.index - 1] : "";
    if (previousChar === ".") continue;
    const lineText = readLineTextAtOffset(source, match.index);
    if (/^\s*func\b/.test(lineText)) continue;
    addReadHelperReferenceEntry(seen, entries, name, currentFunction, startLine, source, match.index);
  }
  entries.sort((left, right) => {
    const leftLine = Math.min(...left.lines);
    const rightLine = Math.min(...right.lines);
    return leftLine - rightLine || left.name.localeCompare(right.name);
  });
  return entries;
}

function addReadHelperReferenceEntry(seen, entries, name, currentFunction, startLine, source, index) {
  if (!name || name === currentFunction) return;
  const line = startLine + lineBreakCount(source.slice(0, index));
  const existing = seen.get(name);
  if (existing) {
    existing.lines.push(line);
    return;
  }
  const entry = { name, lines: [line] };
  seen.set(name, entry);
  entries.push(entry);
}

function readLineTextAtOffset(text, offset) {
  const source = String(text || "");
  const start = source.lastIndexOf("\n", Math.max(0, offset - 1));
  const end = source.indexOf("\n", offset);
  return source.slice(start < 0 ? 0 : start + 1, end < 0 ? source.length : end);
}

function readHelperDefinitionReferences(filePath, helperEntries) {
  if (typeof filePath !== "string" || !filePath) return [];
  if (!Array.isArray(helperEntries) || !helperEntries.length) return [];
  let lines;
  try {
    lines = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  } catch {
    return [];
  }
  const refs = [];
  for (const entry of helperEntries) {
    const name = stringField(entry, "name");
    if (!name) continue;
    const definitionLine = readFunctionDefinitionLine(lines, name);
    if (!Number.isInteger(definitionLine)) continue;
    refs.push(`${name}(line ${definitionLine})`);
    if (refs.length >= 6) break;
  }
  return refs;
}

function readSuggestedFollowupHelperRead(text, startLine = 1, filePath = "") {
  if (typeof filePath !== "string" || !filePath) return "";
  const fileLines = readGrepSummaryFileLines(filePath);
  if (!fileLines.length) return "";
  const visibleEndLine = startLine + Math.max(0, readVisibleLineCount(String(text || "")) - 1);
  const candidates = prioritizedFollowupHelperCandidates(readFollowupHelperCandidates(text, startLine));
  for (const candidate of candidates) {
    const helperName = stringField(candidate, "name");
    if (!helperName) continue;
    const definitionLine = readFunctionDefinitionLine(fileLines, helperName);
    if (!Number.isInteger(definitionLine)) continue;
    if (definitionLine >= startLine && definitionLine <= visibleEndLine) continue;
    const endLine = suggestedDefinitionReadWindowEnd(fileLines, definitionLine, fileLines.length);
    if (!Number.isInteger(endLine) || endLine < definitionLine) continue;
    const readStart = suggestedDefinitionReadWindowStart(fileLines, definitionLine);
    return `If you need ${helperName} behavior, the only next same-file Read should be: path=${filePath} offset=${readStart} limit=${endLine - readStart + 1}; do not request smaller later-offset Reads first.`;
  }
  return "";
}

function prioritizedFollowupHelperCandidates(candidates) {
  const primary = [];
  const secondary = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate?.source === "callsite") primary.push(candidate);
    else secondary.push(candidate);
  }
  return primary.concat(secondary);
}

function readFollowupHelperCandidates(text, startLine = 1) {
  const candidates = [];
  const seen = new Set();
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const helperName = readCallsiteBlockHelperName(lines[index]);
    if (!helperName || seen.has(helperName)) continue;
    seen.add(helperName);
    candidates.push({ name: helperName, line: startLine + index, source: "callsite" });
  }
  for (const entry of readHelperReferenceEntries(text, "", startLine)) {
    const helperName = stringField(entry, "name");
    if (!helperName || seen.has(helperName)) continue;
    seen.add(helperName);
    candidates.push({ name: helperName, line: normalizeInteger(entry.lines?.[0]) || startLine, source: "helper_ref" });
  }
  return candidates;
}

function grepReadTargetContains(parentPath, childPath) {
  const parent = normalizedDerivedPath(parentPath);
  const child = normalizedDerivedPath(childPath);
  if (!child) return false;
  if (!parent) return true;
  if (parent === child) return true;
  return child.startsWith(`${parent}/`);
}

function readSameFileHelperCommentPreview(text, startLine = 1, filePath = "") {
  if (typeof filePath !== "string" || !filePath) return "";
  const fileLines = readGrepSummaryFileLines(filePath);
  if (!fileLines.length) return "";
  const visibleEndLine = startLine + Math.max(0, readVisibleLineCount(String(text || "")) - 1);
  const candidates = readFollowupHelperCandidates(text, startLine);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const helperName = stringField(candidates[index], "name");
    if (!helperName) continue;
    const definitionLine = readFunctionDefinitionLine(fileLines, helperName);
    if (!Number.isInteger(definitionLine)) continue;
    if (definitionLine >= startLine && definitionLine <= visibleEndLine) continue;
    const commentBlock = readLeadingLineCommentBlock(fileLines, definitionLine);
    if (!commentBlock) continue;
    return `Same-file helper comment: ${helperName}(lines ${commentBlock.startLine}-${commentBlock.endLine}) ${commentBlock.text}`;
  }
  return "";
}

function readSameFileHelperCommentPreviews(filePath, helperEntries, visibleStartLine = 1, visibleEndLine = 0) {
  if (typeof filePath !== "string" || !filePath) return [];
  if (!Array.isArray(helperEntries) || !helperEntries.length) return [];
  const fileLines = readGrepSummaryFileLines(filePath);
  if (!fileLines.length) return [];
  const candidates = [];
  const seen = new Set();
  for (const entry of helperEntries) {
    const helperName = stringField(entry, "name");
    if (!helperName || seen.has(helperName)) continue;
    const definitionLine = readFunctionDefinitionLine(fileLines, helperName);
    if (!Number.isInteger(definitionLine)) continue;
    if (Number.isInteger(visibleStartLine) && Number.isInteger(visibleEndLine)
      && definitionLine >= visibleStartLine && definitionLine <= visibleEndLine) {
      continue;
    }
    const commentBlock = readLeadingLineCommentBlock(fileLines, definitionLine);
    if (!commentBlock) continue;
    seen.add(helperName);
    const priority = normalizeInteger(entry?.priority);
    candidates.push({
      helperName,
      definitionLine,
      commentBlock,
      span: Math.max(1, commentBlock.endLine - commentBlock.startLine + 1),
      priority: Number.isInteger(priority) ? priority : 1,
    });
  }
  return candidates
    .sort((left, right) =>
      left.priority - right.priority
      || right.span - left.span
      || right.commentBlock.text.length - left.commentBlock.text.length
      || left.definitionLine - right.definitionLine)
    .slice(0, 2)
    .map((entry) => `${entry.helperName}(lines ${entry.commentBlock.startLine}-${entry.commentBlock.endLine}) ${entry.commentBlock.text}`);
}

function readSameFileTopLevelSymbolPreviews(filePath, text, visibleStartLine = 1, visibleEndLine = 0) {
  if (typeof filePath !== "string" || !filePath) return [];
  const fileLines = readGrepSummaryFileLines(filePath);
  if (!fileLines.length) return [];
  const refs = readTopLevelSymbolReferenceEntries(text, visibleStartLine);
  if (!refs.length) return [];
  const previews = [];
  const seen = new Set();
  for (const ref of refs) {
    const name = stringField(ref, "name");
    if (!name || seen.has(name)) continue;
    const definitionLine = readTopLevelSymbolDefinitionLine(fileLines, name);
    if (!Number.isInteger(definitionLine)) continue;
    if (Number.isInteger(visibleStartLine) && Number.isInteger(visibleEndLine)
      && definitionLine >= visibleStartLine && definitionLine <= visibleEndLine) {
      continue;
    }
    const preview = readTopLevelSymbolDefinitionPreview(fileLines, name, definitionLine);
    if (!preview) continue;
    seen.add(name);
    previews.push(preview);
    if (previews.length >= 2) break;
  }
  return previews;
}

function readTopLevelSymbolReferenceEntries(text, startLine = 1) {
  const entries = [];
  const seen = new Set();
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of String(lines[index] || "").matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\./g)) {
      const name = match[1];
      if (!name || TOP_LEVEL_SYMBOL_REFERENCE_EXCLUDE.has(name) || seen.has(name)) continue;
      seen.add(name);
      entries.push({ name, line: startLine + index });
    }
  }
  return entries;
}

function readTopLevelSymbolDefinitionLine(lines, name) {
  if (!Array.isArray(lines) || !name) return undefined;
  let depth = 0;
  let inDeclBlock = false;
  let declKind = "";
  let declParenDepth = 0;
  const directPattern = new RegExp(`^\\s*(?:var|const)\\s+${escapeRegExp(name)}\\b`);
  const blockPattern = new RegExp(`^\\s*${escapeRegExp(name)}\\b`);
  for (let index = 0; index < lines.length; index += 1) {
    const text = String(lines[index] || "");
    const trimmed = text.trim();
    if (depth === 0) {
      if (!inDeclBlock && /^(var|const)\s*\($/.test(trimmed)) {
        inDeclBlock = true;
        declKind = trimmed.slice(0, trimmed.indexOf("(")).trim();
      } else if (directPattern.test(trimmed)) {
        return index + 1;
      } else if (inDeclBlock && (declKind === "var" || declKind === "const") && blockPattern.test(trimmed)) {
        return index + 1;
      }
    }
    if (inDeclBlock && depth === 0) {
      declParenDepth += countChar(text, "(") - countChar(text, ")");
      if (declParenDepth <= 0) {
        inDeclBlock = false;
        declKind = "";
        declParenDepth = 0;
      }
    }
    if (!inDeclBlock && depth === 0 && /^(var|const)\s*\($/.test(trimmed)) {
      declParenDepth = 1;
    }
    depth += countChar(text, "{") - countChar(text, "}");
    if (depth < 0) depth = 0;
  }
  return undefined;
}

function readTopLevelSymbolDefinitionPreview(lines, name, definitionLine) {
  if (!Array.isArray(lines) || !name || !Number.isInteger(definitionLine) || definitionLine < 1 || definitionLine > lines.length) return "";
  const commentBlock = readLeadingLineCommentBlock(lines, definitionLine);
  const startLine = Number.isInteger(commentBlock?.startLine) ? commentBlock.startLine : definitionLine;
  const slice = lines.slice(startLine - 1, Math.min(lines.length, definitionLine + 8));
  const joined = slice.join("\n");
  const constructor = joined.match(/prometheus\.(New[A-Za-z0-9_]+)/)?.[1];
  const metricName = joined.match(/Name:\s*"([^"]+)"/)?.[1];
  const help = joined.match(/Help:\s*"([^"]+)"/)?.[1];
  const parts = [`${name}(line ${definitionLine})`];
  if (constructor) parts.push(constructor);
  if (metricName) parts.push(`name=${metricName}`);
  if (help) parts.push(`help=${help.length > 120 ? `${help.slice(0, 117)}...` : help}`);
  else if (commentBlock?.text) parts.push(commentBlock.text);
  if (parts.length === 1) {
    const lineText = String(lines[definitionLine - 1] || "").trim();
    if (!lineText) return "";
    parts.push(lineText.length > 140 ? `${lineText.slice(0, 137)}...` : lineText);
  }
  return parts.join(" ");
}

function readLocalAssignmentHelperEntries(text, startLine = 1) {
  const entries = [];
  const seen = new Set();
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || "").trim();
    if (!line || line.startsWith("if ")) continue;
    const match = line.match(/^(?:[A-Za-z_][A-Za-z0-9_]*\s*,\s*)?[A-Za-z_][A-Za-z0-9_]*\s*:=\s*r\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (!match?.[1] || seen.has(match[1])) continue;
    seen.add(match[1]);
    entries.push({ name: match[1], lines: [startLine + index], priority: 0 });
  }
  return entries;
}

const TOP_LEVEL_SYMBOL_REFERENCE_EXCLUDE = new Set([
  "r",
  "bt",
  "pod",
  "pods",
  "ctx",
  "log",
  "o",
  "s",
  "pressure",
  "client",
  "corev1",
  "ctrl",
  "prometheus",
  "metrics",
  "time",
  "strings",
  "sort",
]);

function readLeadingLineCommentBlock(lines, definitionLine) {
  if (!Array.isArray(lines) || !Number.isInteger(definitionLine) || definitionLine < 2 || definitionLine > lines.length) return null;
  const commentLines = [];
  let startLine = definitionLine;
  for (let index = definitionLine - 2; index >= 0; index -= 1) {
    const raw = String(lines[index] || "");
    const trimmed = raw.trim();
    if (!trimmed) {
      if (commentLines.length) break;
      continue;
    }
    if (!trimmed.startsWith("//")) break;
    commentLines.unshift(trimmed.replace(/^\/\/\s?/, ""));
    startLine = index + 1;
  }
  if (!commentLines.length) return null;
  const text = commentLines.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return {
    startLine,
    endLine: definitionLine - 1,
    text: text.length > 220 ? `${text.slice(0, 217)}...` : text,
  };
}

function readFunctionDefinitionLine(lines, name) {
  if (!Array.isArray(lines) || !name) return undefined;
  const pattern = new RegExp(`^\\s*func(?:\\s*\\([^)]*\\))?\\s+${escapeRegExp(name)}\\b`);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(String(lines[index] || ""))) return index + 1;
  }
  return undefined;
}

function readLocalAssignmentReferences(text, startLine = 1, filePath = "") {
  const refs = [];
  const seen = new Set();
  const fileLines = typeof filePath === "string" && filePath ? readGrepSummaryFileLines(filePath) : [];
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const ref = normalizedReadLocalAssignment(lines[index], startLine + index, fileLines);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
    if (refs.length >= 3) break;
  }
  return refs;
}

function normalizedReadLocalAssignment(line, lineNumber, fileLines) {
  const text = String(line || "").trim();
  const initializer = normalizedReadAssignmentInitializer(text);
  const match = initializer.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*,\s*[A-Za-z_][A-Za-z0-9_]*\s*:=\s*r\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    || initializer.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*r\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (!match) return "";
  const localName = match[1];
  const helperName = match[2];
  if (!localName || !helperName || localName === "_") return "";
  const definitionLine = readFunctionDefinitionLine(fileLines, helperName);
  return Number.isInteger(definitionLine)
    ? `${localName} <- ${helperName}(line ${lineNumber}; def line ${definitionLine})`
    : `${localName} <- ${helperName}(line ${lineNumber})`;
}

function readCallsiteBlocks(text, startLine = 1) {
  const refs = [];
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const helperName = readCallsiteBlockHelperName(lines[index]);
    if (!helperName) continue;
    const blockEndLine = readFunctionBodyEndLine(lines, index + 1) || (index + 1);
    refs.push(`${helperName}(line ${startLine + index}-${startLine + blockEndLine - 1})`);
    if (refs.length >= 3) break;
  }
  return refs;
}

function readCallsiteOutcomeReferences(text, startLine = 1) {
  const refs = [];
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const nextRefs = readCallsiteOutcomeRefsForLine(lines, index, startLine);
    if (!nextRefs.length) continue;
    refs.push(...nextRefs);
    if (refs.length >= 4) break;
  }
  return refs.slice(0, 4);
}

function readCallsiteOutcomeRefsForLine(lines, lineIndex, startLine) {
  const helperName = readCallsiteBlockHelperName(lines[lineIndex]);
  if (!helperName) return [];
  const absoluteStartLine = startLine + lineIndex;
  const blockEndIndex = (readFunctionBodyEndLine(lines, lineIndex + 1) || (lineIndex + 1)) - 1;
  const line = String(lines[lineIndex] || "").trim();
  const firstCondition = normalizedReadBranchCondition(line);
  let firstEndLine = absoluteStartLine;
  let secondCondition = "";
  let secondStartLine = undefined;
  for (let index = lineIndex + 1; index <= blockEndIndex; index += 1) {
    const branchCondition = normalizedReadBranchCondition(lines[index]);
    if (!branchCondition) continue;
    secondCondition = branchCondition;
    secondStartLine = startLine + index;
    firstEndLine = Math.max(absoluteStartLine, secondStartLine - 1);
    break;
  }
  if (!secondStartLine) firstEndLine = startLine + blockEndIndex;
  const refs = [];
  if (firstCondition) refs.push(`${helperName} ${firstCondition}(line ${absoluteStartLine}-${firstEndLine})`);
  if (secondCondition && secondStartLine !== undefined) refs.push(`${secondCondition}(line ${secondStartLine}-${startLine + blockEndIndex})`);
  return refs;
}

function readCallsiteBlockHelperName(line) {
  const initializer = normalizedReadAssignmentInitializer(String(line || "").trim());
  const match = initializer.match(/^[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)?\s*:=\s*r\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  return match ? match[1] : "";
}

function normalizedReadAssignmentInitializer(text) {
  if (!text.startsWith("if ")) return text;
  const semicolon = text.indexOf(";");
  if (semicolon < 0) return text.slice(3).trim();
  return text.slice(3, semicolon).trim();
}

function readBranchReferences(text, startLine = 1) {
  const refs = [];
  const seen = new Set();
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const condition = normalizedReadBranchCondition(lines[index]);
    if (!condition) continue;
    const key = `${condition}:${startLine + index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(`${condition}(line ${startLine + index})`);
    if (refs.length >= 5) break;
  }
  return refs;
}

function readReturnReferences(text, startLine = 1) {
  const grouped = new Map();
  const order = [];
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const expression = normalizedReadReturnExpression(lines[index]);
    if (!expression) continue;
    let entry = grouped.get(expression);
    if (!entry) {
      if (order.length >= 4) continue;
      entry = { expression, lines: [] };
      grouped.set(expression, entry);
      order.push(entry);
    }
    entry.lines.push(startLine + index);
  }
  return order.map((entry) => `${entry.expression}(line ${entry.lines.join(", ")})`);
}

function normalizedReadReturnExpression(line) {
  const match = String(line || "").match(/^\s*return\b(.*)$/);
  if (!match) return "";
  let expression = match[1].trim();
  expression = expression ? expression.replace(/\s+/g, " ") : "return";
  return expression.length > 100 ? `${expression.slice(0, 97)}...` : expression;
}

function normalizedReadBranchCondition(line) {
  const text = String(line || "");
  const match = text.match(/^\s*(?:}\s*)?else\s+if\s+(.+?)\s*\{\s*$/) || text.match(/^\s*if\s+(.+?)\s*\{\s*$/);
  if (!match) return "";
  let condition = match[1].trim();
  if (!condition) return "";
  const semicolon = condition.lastIndexOf(";");
  if (semicolon >= 0) condition = condition.slice(semicolon + 1).trim();
  condition = condition.replace(/\s+/g, " ");
  if (!condition) return "";
  return condition.length > 100 ? `${condition.slice(0, 97)}...` : condition;
}

function lineBreakCount(text) {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) count++;
  }
  return count;
}

function truncateTextWithNotice(text, limit = 4000) {
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]` : text;
}

// Mirrors Cursor's middle-out shell-output truncation (cursor-agent-exec `Nx` with
// the keep-both-ends flag): keep the head and tail, drop the middle.
function truncateShellOutputMiddleOut(text, limit = SHELL_OUTPUT_MAX_CHARS) {
  if (typeof text !== "string" || text.length <= limit) {
    return { output: typeof text === "string" ? text : "", truncated: false };
  }
  const half = Math.floor(limit / 2);
  return {
    output: `${text.slice(0, half)}\n\n... (output truncated) ...\n\n${text.slice(text.length - half)}`,
    truncated: true,
  };
}

// Mirrors Cursor's WebFetch markdown truncation (`O1`): hard char cap with a
// trailing `...[N lines truncated]` notice counting the dropped newlines.
function truncateFetchMarkdown(text, limit = FETCH_MARKDOWN_MAX_CHARS) {
  if (typeof text !== "string" || text.length <= limit) return typeof text === "string" ? text : "";
  const droppedLines = (text.slice(limit).match(/\n/g) || []).length + 1;
  return `${text.slice(0, limit)}\n\n...[${droppedLines} line${droppedLines === 1 ? "" : "s"} truncated]`;
}

function readUnavailableText(value, reason) {
  const path = typeof value.path === "string" && value.path ? ` for ${value.path}` : "";
  const size = value.fileSize !== undefined ? ` (${value.fileSize} characters)` : "";
  const lines = value.totalLines !== undefined ? `, ${value.totalLines} total lines` : "";
  return `Read result ${reason} and is not available to BYOK inline${path}${size}${lines}. Please retry Read with offset and limit parameters to read a specific portion of the file.`;
}

function numberOrUnknown(value) {
  return value === undefined || value === null || value === "" ? "unknown" : value;
}

function normalizeInteger(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

function stringField(value, key) {
  return typeof value?.[key] === "string" ? value[key] : "";
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function normalizeTools(tools, providerType) {
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return null;
    const patched = patchProviderToolSchema(tool);
    const declaredName = patched.name || patched.canonicalName;
    const canonicalName = patched.canonicalName || patched.name;
    const name = BUILTIN_PROVIDER_TOOL_NAMES.has(canonicalName) ? canonicalName : declaredName;
    if (BLOCKED_PROVIDER_TOOL_NAMES.has(name) || BLOCKED_PROVIDER_TOOL_NAMES.has(canonicalName)) return null;
    const schemaTool = interactionBridgeBuiltinProviderTool(name, canonicalName) || patched;
    const rawSchema = schemaTool.inputSchema || schemaTool.parameters;
    return {
      name,
      description: sanitizeProviderVisiblePromptText(schemaTool.description || "", providerType),
      inputSchema: compactProviderToolSchema(coerceProviderToolSchema(rawSchema)),
      validationSchema: augmentBuiltinValidationSchema(name, closeProviderObjectSchema(rawSchema)),
      providerIdentifier: patched.providerIdentifier,
      toolName: patched.toolName,
      executionName: patched.executionName,
    };
  }).filter((tool) => tool?.name);
}

function augmentBuiltinValidationSchema(name, schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object") return schema;
  let extraProperties = null;
  switch (name) {
    case "Grep":
      extraProperties = {
        sort: { type: "string" },
        sort_ascending: { type: "boolean" },
      };
      break;
    case "LS":
      extraProperties = {
        timeout_ms: { type: "integer" },
      };
      break;
    case "Shell":
      extraProperties = {
        hardTimeout: { type: "integer" },
      };
      break;
    default:
      return schema;
  }
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  return {
    ...schema,
    properties: {
      ...properties,
      ...extraProperties,
    },
  };
}

function compactProviderToolSchema(schema, inSchemaMap = false) {
  if (Array.isArray(schema)) return schema.map((item) => compactProviderToolSchema(item, false));
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && !inSchemaMap && typeof value === "string") continue;
    const childIsSchemaMap =
      key === "properties" ||
      key === "$defs" ||
      key === "definitions" ||
      key === "patternProperties" ||
      key === "dependentSchemas";
    out[key] = compactProviderToolSchema(value, childIsSchemaMap);
  }
  return out;
}

function interactionBridgeBuiltinProviderTool(name, canonicalName) {
  if (name !== "CreatePlan" && canonicalName !== "CreatePlan") return undefined;
  return cursorBuiltinTool("CreatePlan");
}

const BLOCKED_PROVIDER_TOOL_NAMES = new Set([
  "Task",
  "Subagent",
  "RecordScreen",
  "ComputerUse",
]);

const READ_HELPER_PLAIN_CALL_EXCLUDE = new Set([
  "if",
  "for",
  "switch",
  "return",
  "append",
  "make",
  "len",
  "cap",
  "panic",
  "recover",
  "copy",
  "delete",
  "new",
  "close",
]);

const GREP_PATTERN_STOP_WORDS = new Set([
  "func",
  "type",
  "const",
  "var",
  "struct",
  "interface",
  "return",
  "if",
  "for",
  "switch",
  "case",
]);

const BUILTIN_PROVIDER_TOOL_NAMES = new Set([
  "Shell",
  "Glob",
  "Grep",
  "LS",
  "AwaitShell",
  "Read",
  "ReadFile",
  "Delete",
  "Edit",
  "ApplyPatch",
  "Write",
  "EditNotebook",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "ReadLints",
  "WebFetch",
  "WriteShellStdin",
  "WebSearch",
  "GenerateImage",
  "AskQuestion",
  "Task",
  "Subagent",
  "ListMcpResources",
  "FetchMcpResource",
  "CallMcpTool",
  "SwitchMode",
  "CreatePlan",
]);

function summarizeReadToolSchema(tools) {
  const read = tools.find((tool) => tool.name === "Read");
  if (!read) return undefined;
  const properties = read.inputSchema?.properties;
  return {
    required: Array.isArray(read.inputSchema?.required) ? read.inputSchema.required : [],
    additionalProperties: read.inputSchema?.additionalProperties,
    propertyKeys: properties && typeof properties === "object" ? Object.keys(properties).sort() : [],
  };
}

async function collectOpenAiEvents(stream) {
  const events = [];
  for await (const event of streamOpenAiEvents(stream)) events.push(event);
  return events;
}

async function collectOpenAiResponsesEvents(stream) {
  const events = [];
  for await (const event of streamOpenAiResponsesEvents(stream)) {
    if (event.type !== "provider_history_item") events.push(event);
  }
  return events;
}

function responseStreamPartOwner(event, item) {
  const itemId = stringOrEmpty(event?.item_id) || stringOrEmpty(item?.id);
  if (itemId) return itemId;
  return Number.isInteger(event?.output_index) ? event.output_index : undefined;
}

function markResponseStreamTextDelta(event, partsByOwner, wholeOwners) {
  const owner = responseStreamPartOwner(event);
  if (owner === undefined) return false;
  if (!Number.isInteger(event.content_index)) {
    wholeOwners.add(owner);
    return true;
  }
  let parts = partsByOwner.get(owner);
  if (!parts) {
    parts = new Set();
    partsByOwner.set(owner, parts);
  }
  parts.add(event.content_index);
  return true;
}

function shouldForwardResponseStreamDoneText(event, partsByOwner, wholeOwners, sawUnscopedTextDelta) {
  const owner = responseStreamPartOwner(event);
  if (owner === undefined) return !sawUnscopedTextDelta;
  if (wholeOwners.has(owner)) return false;
  return !(Number.isInteger(event.content_index) && partsByOwner.get(owner)?.has(event.content_index));
}

function markResponseReasoningSummaryDelta(event, partsByOwner, wholeOwners) {
  const owner = responseStreamPartOwner(event);
  if (owner === undefined) return false;
  if (!Number.isInteger(event.summary_index)) {
    wholeOwners.add(owner);
    return true;
  }
  let parts = partsByOwner.get(owner);
  if (!parts) {
    parts = new Set();
    partsByOwner.set(owner, parts);
  }
  parts.add(event.summary_index);
  return true;
}

function shouldForwardResponseReasoningSummaryDone(event, partsByOwner, wholeOwners, sawUnscopedDelta) {
  const owner = responseStreamPartOwner(event);
  if (owner === undefined) return !sawUnscopedDelta;
  if (wholeOwners.has(owner)) return false;
  return !(Number.isInteger(event.summary_index) && partsByOwner.get(owner)?.has(event.summary_index));
}

function openAiResponsesTerminalErrorText(event) {
  if (!event || typeof event !== "object") return "OpenAI Responses stream failed.";
  if (event.type === "error") {
    const message = stringOrEmpty(event.message) || "OpenAI Responses stream error.";
    const code = stringOrEmpty(event.code);
    const param = stringOrEmpty(event.param);
    if (code && param) return `OpenAI Responses error (${code}, ${param}): ${message}`;
    if (code) return `OpenAI Responses error (${code}): ${message}`;
    return `OpenAI Responses error: ${message}`;
  }
  if (event.type === "response.failed") {
    const error = event.response?.error;
    const message = stringOrEmpty(error?.message) || "response failed";
    const code = stringOrEmpty(error?.code);
    return code ? `OpenAI Responses failed (${code}): ${message}` : `OpenAI Responses failed: ${message}`;
  }
  if (event.type === "response.incomplete") {
    const reason = stringOrEmpty(event.response?.incomplete_details?.reason) || "unknown";
    return `OpenAI Responses incomplete: ${reason}`;
  }
  return "OpenAI Responses stream failed.";
}

async function* streamOpenAiResponsesEvents(stream) {
  const calls = new Map();
  const textDeltaPartsByOwner = new Map();
  const textDeltaWholeOwners = new Set();
  const reasoningSummaryDeltaPartsByOwner = new Map();
  const reasoningSummaryWholeOwners = new Set();
  let usage = { inputTokens: 0, outputTokens: 0 };
  let sawUnscopedMessageTextDelta = false;
  let sawUnscopedReasoningSummaryDelta = false;
  let sawReasoningSummary = false;
  let terminalErrorText = "";
  for await (const event of stream) {
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) {
          if (!markResponseStreamTextDelta(event, textDeltaPartsByOwner, textDeltaWholeOwners)) sawUnscopedMessageTextDelta = true;
          yield { type: "text_delta", text: event.delta };
        }
        break;
      case "response.refusal.delta":
        if (event.delta) {
          if (!markResponseStreamTextDelta(event, textDeltaPartsByOwner, textDeltaWholeOwners)) sawUnscopedMessageTextDelta = true;
          yield { type: "text_delta", text: event.delta };
        }
        break;
      case "response.output_text.done":
        if (event.text && shouldForwardResponseStreamDoneText(event, textDeltaPartsByOwner, textDeltaWholeOwners, sawUnscopedMessageTextDelta)) {
          markResponseStreamTextDelta(event, textDeltaPartsByOwner, textDeltaWholeOwners);
          yield { type: "text_delta", text: event.text };
        }
        break;
      case "response.refusal.done":
        if (event.refusal && shouldForwardResponseStreamDoneText(event, textDeltaPartsByOwner, textDeltaWholeOwners, sawUnscopedMessageTextDelta)) {
          markResponseStreamTextDelta(event, textDeltaPartsByOwner, textDeltaWholeOwners);
          yield { type: "text_delta", text: event.refusal };
        }
        break;
      case "response.content_part.done": {
        const text = providerTextFromContentBlock(event.part);
        if (text && event.part?.type !== "reasoning_text" && shouldForwardResponseStreamDoneText(event, textDeltaPartsByOwner, textDeltaWholeOwners, sawUnscopedMessageTextDelta)) {
          markResponseStreamTextDelta(event, textDeltaPartsByOwner, textDeltaWholeOwners);
          yield { type: "text_delta", text };
        }
        break;
      }
      case "response.output_item.added": {
        const item = event.item || {};
        if (item.type === "function_call" || item.type === "custom_tool_call") {
          const id = item.call_id || item.id || event.item_id || `call-${calls.size}`;
          const state = {
            id,
            itemId: item.id || event.item_id || id,
            name: item.type === "custom_tool_call" ? item.name || "" : normalizeProviderToolAliasName(item.name || ""),
            args: item.type === "custom_tool_call" ? item.input || "" : item.arguments || "",
            providerToolType: item.type,
          };
          calls.set(state.itemId, state);
          calls.set(id, state);
          yield { type: "tool_use_start", id, name: state.name, providerToolType: state.providerToolType, itemId: state.itemId };
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const state = calls.get(event.item_id) || calls.get(event.call_id);
        if (state) {
          state.args += event.delta || "";
          yield { type: "tool_use_delta", id: state.id, input: event.delta || "" };
        }
        break;
      }
      case "response.function_call_arguments.done": {
        let state = calls.get(event.item_id) || calls.get(event.call_id);
        if (!state && (event.item_id || event.call_id)) {
          const id = event.call_id || event.item_id;
          state = { id, itemId: event.item_id || id, name: normalizeProviderToolAliasName(event.name || ""), args: "" };
          calls.set(state.itemId, state);
          calls.set(id, state);
          yield { type: "tool_use_start", id, name: state.name };
        }
        if (state) {
          if (event.name) state.name = normalizeProviderToolAliasName(event.name);
          if (event.arguments !== undefined) state.args = event.arguments;
          if (!state.done) {
            state.done = true;
            yield {
              type: "tool_use_done",
              id: state.id,
              name: state.name,
              arguments: state.args || undefined,
              providerToolType: state.providerToolType,
              itemId: state.itemId,
            };
          }
        }
        break;
      }
      case "response.custom_tool_call_input.delta": {
        const state = calls.get(event.item_id);
        if (state) {
          state.args += event.delta || "";
          yield { type: "tool_use_delta", id: state.id, input: event.delta || "" };
        }
        break;
      }
      case "response.custom_tool_call_input.done": {
        const state = calls.get(event.item_id);
        if (state) {
          if (event.input !== undefined) state.args = event.input;
          if (!state.done) {
            state.done = true;
            yield {
              type: "tool_use_done",
              id: state.id,
              name: state.name,
              arguments: state.args || undefined,
              providerToolType: state.providerToolType,
              itemId: state.itemId,
            };
          }
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
        if (event.delta) {
          if (!markResponseReasoningSummaryDelta(event, reasoningSummaryDeltaPartsByOwner, reasoningSummaryWholeOwners)) sawUnscopedReasoningSummaryDelta = true;
          sawReasoningSummary = true;
          yield { type: "thinking_delta", text: event.delta };
        }
        break;
      case "response.reasoning_summary_text.done":
        if (event.text && shouldForwardResponseReasoningSummaryDone(event, reasoningSummaryDeltaPartsByOwner, reasoningSummaryWholeOwners, sawUnscopedReasoningSummaryDelta)) {
          markResponseReasoningSummaryDelta(event, reasoningSummaryDeltaPartsByOwner, reasoningSummaryWholeOwners);
          sawReasoningSummary = true;
          yield { type: "thinking_delta", text: event.text };
        }
        break;
      case "response.reasoning_summary_part.done":
        if (event.part?.text && shouldForwardResponseReasoningSummaryDone(event, reasoningSummaryDeltaPartsByOwner, reasoningSummaryWholeOwners, sawUnscopedReasoningSummaryDelta)) {
          markResponseReasoningSummaryDelta(event, reasoningSummaryDeltaPartsByOwner, reasoningSummaryWholeOwners);
          sawReasoningSummary = true;
          yield { type: "thinking_delta", text: event.part.text };
        }
        break;
      case "response.output_item.done": {
        const item = event.item || {};
        if (item.type === "function_call" || item.type === "custom_tool_call") {
          let state = calls.get(item.id || event.item_id) || calls.get(item.call_id);
          if (!state) {
            const id = item.call_id || item.id || event.item_id || `call-${calls.size}`;
            state = {
              id,
              itemId: item.id || event.item_id || id,
              name: item.type === "custom_tool_call" ? item.name || "" : normalizeProviderToolAliasName(item.name || ""),
              args: item.type === "custom_tool_call" ? item.input || "" : item.arguments || "",
              providerToolType: item.type,
            };
            calls.set(state.itemId, state);
            calls.set(id, state);
            yield { type: "tool_use_start", id, name: state.name, providerToolType: state.providerToolType, itemId: state.itemId };
          }
          if (state) {
            if (item.name) state.name = item.type === "custom_tool_call" ? item.name : normalizeProviderToolAliasName(item.name);
            if (item.type === "custom_tool_call") {
              if (item.input !== undefined) state.args = item.input;
              state.providerToolType = "custom_tool_call";
            } else if (item.arguments !== undefined) {
              state.args = item.arguments;
            }
            if (!state.done) {
              state.done = true;
              yield {
                type: "tool_use_done",
                id: state.id,
                name: state.name,
                arguments: state.args || undefined,
                providerToolType: state.providerToolType,
                itemId: state.itemId,
              };
            }
          }
        } else if (item.type === "message" && Array.isArray(item.content)) {
          yield { type: "provider_history_item", item };
          const owner = responseStreamPartOwner(event, item);
          const emittedParts = owner !== undefined ? textDeltaPartsByOwner.get(owner) : undefined;
          if (owner === undefined && sawUnscopedMessageTextDelta) break;
          if (owner !== undefined && textDeltaWholeOwners.has(owner)) break;
          for (let i = 0; i < item.content.length; i += 1) {
            if (emittedParts?.has(i)) continue;
            const block = item.content[i];
            const text = providerTextFromContentBlock(block);
            if (text) yield { type: "text_delta", text };
          }
        } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
          yield { type: "provider_history_item", item };
          const owner = responseStreamPartOwner(event, item);
          const emittedParts = owner !== undefined ? reasoningSummaryDeltaPartsByOwner.get(owner) : undefined;
          if (owner === undefined && sawUnscopedReasoningSummaryDelta) break;
          if (owner !== undefined && reasoningSummaryWholeOwners.has(owner)) break;
          for (let i = 0; i < item.summary.length; i += 1) {
            if (emittedParts?.has(i)) continue;
            const summary = item.summary[i];
            if (summary?.type === "summary_text" && summary.text) {
              sawReasoningSummary = true;
              yield { type: "thinking_delta", text: summary.text };
            }
          }
        } else if (isNativeResponsesHistoryItem(item)) {
          yield { type: "provider_history_item", item };
        }
        break;
      }
      case "response.completed":
        usage = openAiResponsesUsage(event.response?.usage);
        break;
      case "response.failed":
      case "response.incomplete":
        usage = openAiResponsesUsage(event.response?.usage);
        terminalErrorText = openAiResponsesTerminalErrorText(event);
        break;
      case "error":
        terminalErrorText = openAiResponsesTerminalErrorText(event);
        break;
      default:
        break;
    }
  }
  if (sawReasoningSummary) yield { type: "thinking_done" };
  if (terminalErrorText) {
    yield { type: "text_delta", text: terminalErrorText };
    yield { type: "done", stopReason: "error", usage };
  } else {
    yield { type: "done", stopReason: calls.size ? "tool_use" : "end_turn", usage };
  }
}

async function* streamOpenAiEvents(stream) {
  const toolCalls = new Map();
  let usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason = "end_turn";
  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = openAiChatUsage(chunk.usage);
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) yield { type: "text_delta", text: delta.content };
    if (delta.refusal) yield { type: "text_delta", text: delta.refusal };
    if (delta.function_call) {
      const { state, started } = openAiToolCallState(toolCalls, { index: 0, function: delta.function_call });
      if (started) yield { type: "tool_use_start", id: state.id, name: state.name };
      if (delta.function_call.arguments) yield { type: "tool_use_delta", id: state.id, input: delta.function_call.arguments };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const { state, started } = openAiToolCallState(toolCalls, call);
        if (started) yield { type: "tool_use_start", id: state.id, name: state.name };
        if (call.function?.arguments) yield { type: "tool_use_delta", id: state.id, input: call.function.arguments };
        if (call.custom?.input) yield { type: "tool_use_delta", id: state.id, input: call.custom.input };
      }
    }
    if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") {
      stopReason = "tool_use";
      const emitted = new Set();
      for (const state of toolCalls.values()) {
        if (emitted.has(state)) continue;
        emitted.add(state);
        if (state.done) continue;
        state.done = true;
        yield {
          type: "tool_use_done",
          id: state.id,
          name: state.name,
          arguments: state.args || undefined,
          ...(state.providerToolType ? { providerToolType: state.providerToolType } : {}),
        };
      }
    } else if (choice.finish_reason && choice.finish_reason !== "stop") {
      stopReason = choice.finish_reason;
    }
  }
  yield { type: "done", stopReason: toolCalls.size ? "tool_use" : stopReason, usage };
}

function openAiChatUsage(usage) {
  const out = {
    inputTokens: usage?.prompt_tokens || 0,
    outputTokens: usage?.completion_tokens || 0,
  };
  const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens;
  if (typeof cacheReadTokens === "number") out.cacheReadTokens = cacheReadTokens;
  return out;
}

function openAiResponsesUsage(usage) {
  const out = {
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
  };
  const cacheReadTokens = usage?.input_tokens_details?.cached_tokens;
  if (typeof cacheReadTokens === "number") out.cacheReadTokens = cacheReadTokens;
  return out;
}

function anthropicUsage(usage) {
  const out = {
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
  };
  const cacheReadTokens = usage?.cache_read_input_tokens;
  if (typeof cacheReadTokens === "number") out.cacheReadTokens = cacheReadTokens;
  const cacheWriteTokens = usage?.cache_creation_input_tokens;
  if (typeof cacheWriteTokens === "number") out.cacheWriteTokens = cacheWriteTokens;
  return out;
}

function openAiToolCallState(toolCalls, call) {
  const hasIndex = Number.isInteger(call.index);
  const indexKey = hasIndex ? `index:${call.index}` : "";
  const idKey = call.id ? `id:${call.id}` : "";
  let state = (idKey && toolCalls.get(idKey)) || (indexKey && toolCalls.get(indexKey));
  let started = false;
  const custom = call.custom && typeof call.custom === "object" ? call.custom : null;
  if (!state) {
    const id = call.id || `tool-${hasIndex ? call.index : toolCalls.size}`;
    state = {
      id,
      name: custom ? custom?.name || "" : normalizeProviderToolAliasName(call.function?.name || ""),
      args: "",
      providerToolType: custom ? "custom" : undefined,
    };
    started = true;
    if (idKey) toolCalls.set(idKey, state);
    if (indexKey) toolCalls.set(indexKey, state);
    else toolCalls.set(`auto:${toolCalls.size}`, state);
  } else if (call.id && state.id !== call.id) {
    state.id = call.id;
    toolCalls.set(idKey, state);
  } else if (idKey && !toolCalls.has(idKey)) {
    toolCalls.set(idKey, state);
  }
  if (indexKey && !toolCalls.has(indexKey)) toolCalls.set(indexKey, state);
  if (custom) {
    state.providerToolType = "custom";
    if (custom.name) state.name = custom.name;
    if (custom.input) state.args += custom.input;
  } else {
    if (call.function?.name) state.name = normalizeProviderToolAliasName(call.function.name);
    if (call.function?.arguments) state.args += call.function.arguments;
  }
  return { state, started };
}

async function collectAnthropicEvents(stream) {
  const events = [];
  for await (const event of streamAnthropicEvents(stream)) {
    if (event.type !== "provider_history_item") events.push(event);
  }
  return events;
}

async function* streamAnthropicEvents(stream) {
  const blocks = new Map();
  for await (const event of stream) {
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        if (block?.type === "tool_use") {
          blocks.set(event.index, {
            type: block.type,
            id: block.id,
            name: normalizeProviderToolAliasName(block.name),
            input: block.input !== undefined ? block.input : "",
            inputDeltaSeen: false,
          });
          yield { type: "tool_use_start", id: block.id, name: normalizeProviderToolAliasName(block.name) };
        } else if (block?.type === "thinking") {
          blocks.set(event.index, {
            type: block.type,
            signature: block.signature || "",
            startThinking: typeof block.thinking === "string" ? block.thinking : "",
            thinking: typeof block.thinking === "string" ? block.thinking : "",
            thinkingDeltaSeen: false,
          });
        } else if (block?.type === "redacted_thinking") {
          blocks.set(event.index, {
            type: block.type,
            item: sanitizeAnthropicContentBlock(block),
          });
        } else if (block?.type === "text") {
          blocks.set(event.index, {
            type: block.type,
            startText: typeof block.text === "string" ? block.text : "",
            textDeltaSeen: false,
          });
        } else {
          blocks.set(event.index, { type: block?.type });
        }
        break;
      }
      case "content_block_delta": {
        const block = blocks.get(event.index);
        const delta = event.delta;
        if (delta?.type === "text_delta") {
          if (block) block.textDeltaSeen = true;
          yield { type: "text_delta", text: delta.text };
        } else if (delta?.type === "thinking_delta") {
          if (block?.type === "thinking") block.thinking = (block.thinkingDeltaSeen ? block.thinking || "" : "") + (delta.thinking || "");
          if (block) block.thinkingDeltaSeen = true;
          yield { type: "thinking_delta", text: delta.thinking };
        }
        else if (delta?.type === "signature_delta" && block?.type === "thinking") {
          block.signature = (block.signature || "") + delta.signature;
        } else if (delta?.type === "input_json_delta" && block?.type === "tool_use") {
          const partialJson = delta.partial_json || "";
          if (partialJson || block.inputDeltaSeen) {
            block.input = (block.inputDeltaSeen ? block.input || "" : "") + partialJson;
            block.inputDeltaSeen = true;
          }
          yield { type: "tool_use_delta", id: block.id, input: partialJson };
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks.get(event.index);
        if (block?.type === "text" && !block.textDeltaSeen && block.startText) {
          yield { type: "text_delta", text: block.startText };
        }
        if (block?.type === "thinking") {
          if (!block.thinkingDeltaSeen && block.startThinking) yield { type: "thinking_delta", text: block.startThinking };
          const item = { type: "thinking", thinking: block.thinkingDeltaSeen ? block.thinking || "" : block.startThinking || "", signature: block.signature };
          yield { type: "provider_history_item", item };
          yield { type: "thinking_done", signature: block.signature };
        }
        if (block?.type === "redacted_thinking") {
          yield { type: "provider_history_item", item: block.item };
        }
        if (block?.type === "tool_use" && block.id) {
          yield { type: "tool_use_done", id: block.id, name: block.name, arguments: block.input || undefined };
        }
        blocks.delete(event.index);
        break;
      }
      default:
        break;
    }
  }
  const finalMessage = await stream.finalMessage();
  yield {
    type: "done",
    stopReason: finalMessage.stop_reason || "end_turn",
    usage: anthropicUsage(finalMessage.usage),
  };
}

module.exports = {
  ProviderAdapter,
  buildPrompt,
  collectAnthropicEvents,
  collectOpenAiEvents,
  collectOpenAiResponsesEvents,
  normalizeProviderMessage,
  normalizeTools,
  stringifyToolResultForProvider,
  streamAnthropicEvents,
  streamOpenAiEvents,
  streamOpenAiResponsesEvents,
};

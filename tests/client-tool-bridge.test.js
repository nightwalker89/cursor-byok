"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CLIENT_INTERACTION_TOOL_NAMES,
  isClientInteractionTool,
  normalizeWebSearchQueryArgs,
  normalizeGenerateImageQueryArgs,
  buildClientInteractionQuery,
  interactionApprovalCase,
  interactionApprovalGranted,
  interactionApprovalRejected,
  findClientToolCompletion,
  toolResultFromClientCompletion,
  providerTextFromClientCompletion,
  clientInteractionTimeoutResponse,
} = require("../src/runtime/client-tool-bridge");

test("client interaction tool registry recognizes only bridge tools", () => {
  assert.ok(CLIENT_INTERACTION_TOOL_NAMES instanceof Set);
  assert.deepEqual([...CLIENT_INTERACTION_TOOL_NAMES].sort(), ["GenerateImage", "WebFetch", "WebSearch"]);
  for (const name of ["WebSearch", "WebFetch", "GenerateImage"]) {
    assert.equal(isClientInteractionTool(name), true);
  }
  for (const name of ["ReadFile", "websearch", "", undefined]) {
    assert.equal(isClientInteractionTool(name), false);
  }
});

test("normalizeWebSearchQueryArgs normalizes aliases and invalid input", () => {
  const cases = [
    [{ search_term: "hello" }, "tc1", { searchTerm: "hello", toolCallId: "tc1" }],
    [{ searchTerm: "world" }, "tc2", { searchTerm: "world", toolCallId: "tc2" }],
    [{ search_term: "snake", searchTerm: "camel" }, "tc3", { searchTerm: "snake", toolCallId: "tc3" }],
    [{ search_term: "", searchTerm: "world" }, "tc4", { searchTerm: "world", toolCallId: "tc4" }],
    [undefined, undefined, { searchTerm: "", toolCallId: "" }],
    [{ search_term: 42 }, "tc", { searchTerm: "", toolCallId: "tc" }],
  ];
  for (const [args, toolCallId, expected] of cases) {
    assert.deepEqual(normalizeWebSearchQueryArgs(args, toolCallId), expected);
  }
});

test("normalizeGenerateImageQueryArgs normalizes aliases and invalid input", () => {
  const refs = ["/a.png", "/b.png"];
  const cases = [
    [
      { description: "a cat", filename: "cat.png" },
      "tc1",
      { description: "a cat", filePath: "cat.png", referenceImagePaths: [], toolCallId: "tc1" },
    ],
    [
      { description: "d", filePath: "/a/b.png" },
      "tc",
      { description: "d", filePath: "/a/b.png", referenceImagePaths: [], toolCallId: "tc" },
    ],
    [
      { description: "d", file_path: "/x/y.png" },
      "tc",
      { description: "d", filePath: "/x/y.png", referenceImagePaths: [], toolCallId: "tc" },
    ],
    [
      { description: "d" },
      "tc",
      { description: "d", referenceImagePaths: [], toolCallId: "tc" },
    ],
    [
      { description: "d", reference_image_paths: refs },
      "tc",
      { description: "d", referenceImagePaths: refs, toolCallId: "tc" },
    ],
    [
      { description: "d", referenceImagePaths: ["/c.png"] },
      "tc",
      { description: "d", referenceImagePaths: ["/c.png"], toolCallId: "tc" },
    ],
    [
      { description: "d", reference_image_paths: "not-an-array" },
      "tc",
      { description: "d", referenceImagePaths: [], toolCallId: "tc" },
    ],
    [
      { description: "tool bridge diagram", filename: "", filePath: "/tmp/byok-client-tool.png" },
      "tc5",
      { description: "tool bridge diagram", filePath: "/tmp/byok-client-tool.png", referenceImagePaths: [], toolCallId: "tc5" },
    ],
    [
      undefined,
      undefined,
      { description: "", referenceImagePaths: [], toolCallId: "" },
    ],
  ];
  for (const [args, toolCallId, expected] of cases) {
    assert.deepEqual(normalizeGenerateImageQueryArgs(args, toolCallId), expected);
  }
});

test("buildClientInteractionQuery maps known tools and query ids", () => {
  const webSearch = buildClientInteractionQuery(
    "WebSearch",
    "tc-42",
    { search_term: "node.js test" },
    7,
  );
  assert.deepEqual(webSearch, {
    id: 7,
    query: {
      case: "webSearchRequestQuery",
      value: { args: { searchTerm: "node.js test", toolCallId: "tc-42" } },
    },
  });

  const webFetch = buildClientInteractionQuery(
    "WebFetch",
    "tc-fetch",
    { url: "https://example.com/docs" },
    11,
  );
  assert.deepEqual(webFetch, {
    id: 11,
    query: {
      case: "webFetchRequestQuery",
      value: { args: { url: "https://example.com/docs", toolCallId: "tc-fetch" } },
    },
  });

  const generateImage = buildClientInteractionQuery(
    "GenerateImage",
    "tc-99",
    { description: "sunset", filename: "sunset.png" },
    3,
  );
  assert.equal(generateImage.id, 3);
  assert.equal(generateImage.query.case, "generateImageRequestQuery");
  assert.equal(generateImage.query.value.toolCallId, "tc-99");
  assert.deepEqual(generateImage.query.value.args, {
    description: "sunset",
    filePath: "sunset.png",
    referenceImagePaths: [],
    toolCallId: "tc-99",
  });

  assert.equal(buildClientInteractionQuery("WebSearch", "tc", {}, "15").id, 15);
  assert.equal(buildClientInteractionQuery("WebSearch", "tc", {}, "abc").id, 0);
  assert.deepEqual(buildClientInteractionQuery("UnknownTool", "tc", {}, 1), {
    id: 1,
    query: { case: undefined, value: undefined },
  });
});

test("interaction approval helpers map terminal approval states", () => {
  const cases = [
    [{ result: { case: "approved", value: {} } }, "approved", true, false],
    [{ result: { case: "success", value: {} } }, "success", true, false],
    [
      { result: { case: "webSearchRequestResponse", value: { result: { case: "approved", value: {} } } } },
      "approved",
      true,
      false,
    ],
    [{ result: { case: "rejected", value: {} } }, "rejected", false, true],
    [
      { result: { case: "generateImageRequestResponse", value: { result: { case: "rejected", value: { reason: "no" } } } } },
      "rejected",
      false,
      true,
    ],
    [{}, "", false, false],
    [null, "", false, false],
    [undefined, "", false, false],
    [{ result: {} }, "", false, false],
    [{ result: { value: {} } }, "", false, false],
  ];
  for (const [response, approvalCase, granted, rejected] of cases) {
    assert.equal(interactionApprovalCase(response), approvalCase);
    assert.equal(interactionApprovalGranted(response), granted);
    assert.equal(interactionApprovalRejected(response), rejected);
  }
});

test("findClientToolCompletion walks supported Cursor completion shapes", () => {
  const webResult = { case: "success", value: { references: [] } };
  const imageResult = { case: "success", value: { filePath: "/out.png" } };
  const flatCompletion = (toolCallId, toolCase, result) => ({
    case: "toolCallCompleted",
    value: {
      toolCallId,
      tool: { case: toolCase, value: { result } },
    },
  });
  const cases = [
    [
      [{ clientMessage: flatCompletion("tc-1", "webSearchToolCall", webResult) }],
      "tc-1",
      "WebSearch",
      webResult,
    ],
    [
      [{ rawRecord: flatCompletion("tc-2", "webSearchToolCall", webResult) }],
      "tc-2",
      "WebSearch",
      webResult,
    ],
    [
      [{ clientMessage: flatCompletion(42, "webSearchToolCall", webResult) }],
      "42",
      "WebSearch",
      webResult,
    ],
    [
      [{ clientMessage: flatCompletion("100", "generateImageToolCall", imageResult) }],
      100,
      "GenerateImage",
      imageResult,
    ],
    [
      [{
        clientMessage: {
          message: {
            case: "toolCallCompleted",
            value: { message: { value: flatCompletion("tc-nested", "webSearchToolCall", webResult).value } },
          },
        },
      }],
      "tc-nested",
      "WebSearch",
      webResult,
    ],
    [
      [{
        clientMessage: {
          case: "interactionUpdate",
          value: { message: flatCompletion("tc-inner", "webSearchToolCall", webResult) },
        },
      }],
      "tc-inner",
      "WebSearch",
      webResult,
    ],
    [
      [{
        clientMessage: {
          case: "interactionUpdate",
          message: { value: { message: flatCompletion("tc-deep", "generateImageToolCall", imageResult) } },
        },
      }],
      "tc-deep",
      "GenerateImage",
      imageResult,
    ],
    [
      [{
        clientMessage: {
          case: "toolCallCompleted",
          value: {
            toolCall: {
              toolCallId: "tc-tc",
              tool: { case: "webSearchToolCall", value: { result: webResult } },
            },
          },
        },
      }],
      "tc-tc",
      "WebSearch",
      webResult,
    ],
    [
      [{
        clientMessage: {
          case: "toolCallCompleted",
          value: {
            tool_call_id: "tc-snake",
            tool: { case: "webSearchToolCall", value: { result: webResult } },
          },
        },
      }],
      "tc-snake",
      "WebSearch",
      webResult,
    ],
    [
      [{
        clientMessage: {
          case: "toolCallCompleted",
          value: {
            toolCallId: "tc-flat",
            tool: { case: "webSearchToolCall", result: webResult },
          },
        },
      }],
      "tc-flat",
      "WebSearch",
      webResult,
    ],
    [
      [
        { clientMessage: flatCompletion("tc-dup", "webSearchToolCall", { case: "success", value: { references: [{ title: "First" }] } }) },
        { clientMessage: flatCompletion("tc-dup", "webSearchToolCall", webResult) },
      ],
      "tc-dup",
      "WebSearch",
      webResult,
    ],
  ];
  for (const [records, toolCallId, toolName, expected] of cases) {
    assert.deepEqual(findClientToolCompletion(records, toolCallId, toolName), expected);
  }
});

test("findClientToolCompletion rejects empty or mismatched completions", () => {
  const result = { case: "success", value: {} };
  const flat = (toolCallId, toolCase) => [{
    clientMessage: {
      case: "toolCallCompleted",
      value: {
        toolCallId,
        tool: { case: toolCase, value: { result } },
      },
    },
  }];
  const cases = [
    [[], "tc1", "WebSearch"],
    [[{}], "", "WebSearch"],
    [[{}], undefined, "WebSearch"],
    [[{}], null, "WebSearch"],
    [flat("tc-x", "generateImageToolCall"), "tc-x", "WebSearch"],
    [flat("tc-y", "webSearchToolCall"), "tc-y", "GenerateImage"],
    [flat("tc-WRONG", "webSearchToolCall"), "tc-RIGHT", "WebSearch"],
  ];
  for (const [records, toolCallId, toolName] of cases) {
    assert.equal(findClientToolCompletion(records, toolCallId, toolName), null);
  }
});

test("toolResultFromClientCompletion wraps valid completions and reports invalid ones", () => {
  const completion = { case: "success", value: { references: [] } };
  assert.deepEqual(toolResultFromClientCompletion("WebSearch", completion), { result: completion });
  for (const [toolName, invalid] of [
    ["WebSearch", null],
    ["GenerateImage", { value: {} }],
    ["WebSearch", undefined],
  ]) {
    const result = toolResultFromClientCompletion(toolName, invalid);
    assert.equal(result.result.case, "error");
    assert.ok(result.result.value.error.includes(toolName));
  }
});

test("providerTextFromClientCompletion formats provider-visible text", () => {
  const cases = [
    [
      "WebSearch",
      {
        case: "success",
        value: {
          references: [
            { title: "MDN Docs", url: "https://mdn.io", chunk: "JavaScript reference" },
            { title: "Node.js", url: "https://nodejs.org" },
          ],
        },
      },
      [/MDN Docs/, /https:\/\/mdn\.io/, /JavaScript reference/, /Node\.js/, /https:\/\/nodejs\.org/],
    ],
    ["WebSearch", { case: "success", value: { references: [] } }, [/Web search completed with no references/]],
    ["WebSearch", { case: "success", value: {} }, [/Web search completed with no references/]],
    ["WebSearch", { case: "success", value: { references: [{ url: "https://example.com" }] } }, [/Result 1/, /https:\/\/example\.com/]],
    ["GenerateImage", { case: "success", value: { filePath: "/images/out.png" } }, [/Generated image at \/images\/out\.png/]],
    ["GenerateImage", { case: "success", value: { file_path: "/img/x.png" } }, [/Generated image at \/img\/x\.png/]],
    ["GenerateImage", { case: "success", value: { path: "/p.png" } }, [/Generated image at \/p\.png/]],
    ["GenerateImage", { case: "success", value: {} }, [/Image generated successfully/]],
    ["WebSearch", { case: "rejected", value: { reason: "User said no" } }, [/WebSearch rejected/, /User said no/]],
    ["WebSearch", { case: "rejected", value: {} }, [/User rejected the request/]],
    ["WebSearch", { case: "error", value: { error: "timeout" } }, [/WebSearch error/, /timeout/]],
    ["GenerateImage", { case: "error", value: { errorMessage: "network fail" } }, [/GenerateImage error/, /network fail/]],
    ["WebSearch", null, [/^WebSearch error: WebSearch completed without a Cursor tool result$/]],
    ["UnknownTool", { case: "unknownCase", value: { data: "stuff" } }, [/stuff/]],
  ];
  for (const [toolName, completion, patterns] of cases) {
    const text = providerTextFromClientCompletion(toolName, completion);
    for (const pattern of patterns) assert.match(text, pattern);
  }
});

test("clientInteractionTimeoutResponse maps tools and coerces query ids", () => {
  const rejectedCases = [
    ["WebSearch", 5, "", "webSearchRequestResponse", "WebSearch"],
    ["GenerateImage", 3, "", "generateImageRequestResponse", "GenerateImage"],
  ];
  for (const [tool, queryId, reason, topCase, label] of rejectedCases) {
    const resp = clientInteractionTimeoutResponse(tool, queryId, reason);
    assert.equal(resp.id, queryId);
    assert.equal(resp.result.case, topCase);
    assert.equal(resp.result.value.result.case, "rejected");
    assert.ok(resp.result.value.result.value.reason.includes(label));
  }

  const custom = clientInteractionTimeoutResponse("WebSearch", 1, "custom timeout");
  assert.equal(custom.result.value.result.value.reason, "custom timeout");

  const unknown = clientInteractionTimeoutResponse("Unknown", 0, "oops");
  assert.equal(unknown.result.case, "error");
  assert.equal(unknown.result.value.errorMessage, "oops");

  assert.equal(clientInteractionTimeoutResponse("WebSearch", "10", "").id, 10);
  assert.equal(clientInteractionTimeoutResponse("WebSearch", "xyz", "").id, 0);

  const defaultReason = clientInteractionTimeoutResponse("WebSearch", 1, "");
  assert.ok(defaultReason.result.value.result.value.reason.includes("Cursor"));
  assert.ok(defaultReason.result.value.result.value.reason.includes("WebSearch"));
});

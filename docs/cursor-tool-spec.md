# Cursor Tool Spec

[中文版](cursor-tool-spec_CN.md)

This document records the Cursor tool contract that BYOK exposes to providers and
how each tool is dispatched back into Cursor. The source of truth is
`src/runtime/tools.js` for provider-visible schemas, `src/workbench-hook.js` for
UI/native exec mapping, `src/server/http.js` for result-case normalization, and
`src/server/provider-adapter.js` for provider-visible result text.

## Global Rules

- Default BYOK tools are `DEFAULT_PROVIDER_TOOL_NAMES` only. `Task` and
  `Subagent` launch tools are deliberately filtered and are never native-launched
  by BYOK.
- Explicit Cursor tools from a run request are preserved, but canonical built-ins
  dispatch by canonical name, not by provider alias.
- Provider schemas are normalized before API calls: object schemas are closed,
  enum-style JSON type tokens are converted, and recursive schema nodes are
  normalized.
- `Read` / `ReadFile` accept only `path`, `offset`, and `limit` in the provider
  schema. Provider aliases such as `filePath` and `file_path` are rejected before
  execution. Hook-side native normalization still tolerates legacy Cursor-shaped
  aliases where Cursor itself produced them.
- Provider-visible result history remains Cursor-shaped internally, then
  `stringifyToolResultForProvider` converts native results into provider text for
  the next model round.
- BYOK does not save, restore, trim, or synthesize `conversationState` or
  checkpoint messages. The workbench hook may persist a reduced BYOK message
  transcript (user / assistant turns plus prompt fields) so adapter-handled
  turns can recover `messages` after reconnects when Cursor omits visible
  transcript history.

## Provider-Visible Tool Catalog

The default provider catalog is exactly `DEFAULT_PROVIDER_TOOL_NAMES`. `ReadFile`
is documented here because explicit Cursor schemas and provider history may still
use it as a legacy alias, but it is not in the default catalog.

| Tool | Provider input schema | UI tool call | Execution path | Result case |
|------|-----------------------|--------------|----------------|-------------|
| `Shell` | `{command, description?, working_directory?, block_until_ms?}` | `shellToolCall` | Native `shellStreamArgs`. | `shellResult` / `shellStream` |
| `Glob` | `{glob_pattern, target_directory?}` | `globToolCall` | Native `grepArgs` with `outputMode:"files_with_matches"` and empty pattern. | `grepResult` |
| `Grep` | `{pattern, path?, glob?, type?, output_mode?, -i?, -A?, -B?, -C?, multiline?, head_limit?, offset?}` | `grepToolCall` | Native `grepArgs`; context, type, glob, head limit, sort, multiline, and offset are preserved. | `grepResult` |
| `LS` | `{path?, target_directory?, ignore?, ignore_globs?}` | `lsToolCall` | Native `lsArgs`. `target_directory` is an alias for `path`; ignore lists map to `ignore`. | `lsResult` |
| `AwaitShell` | `{shell_id?, task_id?, block_until_ms?}` | `awaitToolCall` | Native `subagentAwaitArgs` only when an id is present. Missing id returns a local error. | `subagentAwaitResult` |
| `Read` | `{path, offset?, limit?}` | `readToolCall` | Direct BYOK read fast path may satisfy provider/UI; otherwise native `readArgs`. | `readResult` |
| `ReadFile` | `{path, offset?, limit?}` | `readToolCall` | Legacy alias of `Read`; same schema and direct/native `readArgs` dispatch. | `readResult` |
| `Delete` | `{path}` | `deleteToolCall` | Native `deleteArgs`. | `deleteResult` |
| `Edit` | `{path, old_string, new_string, replace_all?}` | `editToolCall` | BYOK read-then-write bridge: native read, local transform, native write. | `editResult` provider-local envelope |
| `ApplyPatch` | `{patch}` | `editToolCall` | BYOK read-then-write bridge after parsing the patch. | `editResult` provider-local envelope |
| `Write` | `{path, contents}` | `editToolCall` | Native `writeArgs` with `fileText`. | `writeResult` |
| `EditNotebook` | `{target_notebook, cell_idx, new_string, old_string?, is_new_cell?, cell_language?}` | `editToolCall` | BYOK edit-style bridge; never sends UI-only fields as raw `writeArgs`. | `editResult` provider-local envelope |
| `TodoWrite` | `{todos, merge?}` | `updateTodosToolCall` | Local todo store in the hook. | `todoWriteResult` |
| `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` | Explicit alias only | `updateTodosToolCall` | Local hook/provider-recognized todo alias semantics. These are not `CURSOR_BUILTIN_TOOLS` entries and are not subagent launch tools. | `todoWriteResult` |
| `ReadLints` | `{paths?}` | `readLintsToolCall` | Native `diagnosticsArgs`, using `path` or the first `paths` item. | `diagnosticsResult` |
| `WebSearch` | `{search_term}` | `webSearchToolCall` | Server-side Exa search via `webSearchRequestQuery` / `/byok/client-tool-completion` when `providers.json` `webSearch.provider` is `exa` and a key is configured; otherwise waits for Cursor client completion. | `webSearchToolCall.result` references |
| `WebFetch` | `{url}` | `webFetchToolCall` | Server-side fetch via `webFetchRequestQuery` / `/byok/client-tool-completion` (`providers.json` `webFetch`: `builtin`, `jina`, or `firecrawl`). | `fetchResult` via `/byok/client-tool-completion` |
| `WriteShellStdin` | `{shell_id, chars}` | `custom` | Native `writeShellStdinArgs`. | `writeShellStdinResult` |
| `ListMcpResources` | `{server?}` | `listMcpResourcesToolCall` | Native `listMcpResourcesExecArgs`. | `listMcpResourcesExecResult` |
| `FetchMcpResource` | `{server, uri, downloadPath?}` | `readMcpResourceToolCall` | Native `readMcpResourceExecArgs`. | `readMcpResourceExecResult` |
| `CallMcpTool` | `{name, args, providerIdentifier, toolName}` | `mcpToolCall` | Native `mcpArgs`; explicit MCP provider tools are rewritten to this shape with original metadata. | `mcpResult` |
| `AskQuestion` | `{questions, title?}` | `askQuestionToolCall` | Cursor interaction-query bridge. | `byokInteractionToolResult` |
| `SwitchMode` | `{target_mode_id, explanation?}` | `switchModeToolCall` | Cursor interaction-query bridge. | `byokInteractionToolResult` |
| `CreatePlan` | `{name?, overview?, plan?, todos?, isProject?, phases?}` | `createPlanToolCall` | Cursor interaction-query bridge. | `byokInteractionToolResult` |

## Explicit-Only Tools

`WebSearch`, `GenerateImage`, and `Task` are present in `CURSOR_BUILTIN_TOOLS` for
explicit Cursor requests, but are not in the default provider catalog.

- `WebSearch` uses the client interaction bridge when Cursor explicitly provides
  it and BYOK is not configured for server-side Exa (`webSearch.provider`:
  `client`, or `exa` without a resolvable API key). When Exa is configured,
  BYOK executes search on the server through the same client-tool completion
  endpoint.
- `GenerateImage` uses the client interaction bridge when Cursor explicitly
  provides it.
- `Task` is filtered or completed with an unsupported local error. `Subagent` is
  also filtered/unsupported when encountered as a provider-visible alias, but it
  is not a `CURSOR_BUILTIN_TOOLS` entry. BYOK does not emit native
  `taskToolCall`, `subagentArgs`, or `subagentStartedArgs`.
- `RecordScreen` and `ComputerUse` are also filtered from provider-visible
  schemas and are not `CURSOR_BUILTIN_TOOLS` entries. BYOK may format historical
  or defensive `recordScreenResult` / `computerUseResult` envelopes, but it does
  not expose these as tools or launch them natively.

## Read Semantics

Provider input must use:

```json
{"path":"/absolute/file","offset":1,"limit":20}
```

`offset` is line-based. Positive offsets are 1-indexed from the beginning; negative
offsets count from the end using Cursor-compatible window semantics. Results are
provider-visible as:

```text
File: /absolute/file
Lines: 1-20
     1|first line
```

Direct read results keep BYOK metadata that affects provider formatting:
`rangeApplied`, `truncated`, `totalLines`, `fileSize`, and `readRange`. Direct
success results do not invent native-only `offset` or `limit` fields.

Oversized whole-file reads are not loaded into memory for provider display. BYOK
returns Cursor-style guidance asking the model to retry with `offset` and `limit`.
Internal edit reads may opt into full content because they need exact file text to
compute the replacement.

## Result Text Rules

Envelope/format renders follow Cursor's official agent-exec templates (mined
from `cursor-agent-exec/dist/main.js`); `Read`/`Grep` keep BYOK's custom
reuse-guidance enhancements on top of structured formatting.

- `Shell` background: `The command did not complete in <ms>ms and was sent to
  the background.`, `Shell ID: <id>`, optional `PID:`, the background reason,
  and `Call AwaitShell with {"shell_id":"<id>"} to wait for completion. Don't
  mention Shell ID to the user.`
- `Shell` foreground: `Exit code: <n>`, fenced combined output (interleaved or
  stdout+stderr) middle-out truncated at 20000 chars with
  `... (output truncated) ...`, `Command completed[ in <ms> ms].` (or the
  aborted variants), and the `Shell state (cwd, env vars) persists for
  subsequent calls. Current directory: <cwd>` epilogue.
- `AwaitShell`: `Task completed in <ms>ms with exit code: <n>.` /
  `Task complete.` / `Task still running after <ms>ms...` plus
  `output_file_path:` / `output_length:` trailers.
- `WriteShellStdin`: `Successfully wrote to shell <id> stdin.`
- `Write`: `Wrote contents to <path>`. `Delete`: `Successfully deleted file:
  <path> (<size> bytes)` plus `File not found:` / `Path is not a file` /
  `Permission denied:` / `File is busy:` arms.
- `Glob` (native grep files mode rendered with the Glob template): `Result of
  search in '<path>' (total N files):` then `- file` lines under a 5000-char
  budget, ending with `... N more files ... (Do a more specific search if
  needed)` when truncated; `Result of search in '<path>': 0 files found` when
  empty.
- `LS`: official directory tree from `directoryTreeRoot` — `<absPath>/` root,
  indented `- name` / `- name/` entries sorted by name, collapsed subtrees as
  `[N files in subtree: 3 *ts, 2 *js, ...]`, 10000-char budget with depth-0
  (and no-counts) fallbacks; timeout results render the partial tree.
- `ReadLints`: `Found N linter error(s) in M file(s):` with per-file blocks of
  `  [SEVERITY] L<line>:<col> - message (source)`, the stale-lint
  `<system_reminder>`, `No linter errors found.` when clean, and
  `Error: <message>` on failure. Unfiltered flat native shapes are reduced to
  ERROR/WARNING first, matching Cursor's agent-exec wrapper.
- `WebFetch`: `# Content from <url>` then markdown truncated at 30000 chars
  with `...[N line(s) truncated]`.
- `Read` success is line-numbered unless Cursor already returned line-numbered
  content.
- `Grep` formats content matches, files-only output, and count output instead of
  returning raw JSON, plus BYOK's custom summary/reuse-guidance lines.
- MCP results format text blocks and resource text; binary/image blocks are
  summarized.
- `recordScreenResult` and `computerUseResult` are formatted if Cursor returns
  those result envelopes, but BYOK does not expose or native-launch
  `RecordScreen` / `ComputerUse` as provider tools.
- Other generic edit/stdin/diagnostic failures include the native result case
  and the best error string from `error`, `message`, `reason`, `stderr`, or
  `output`.

## Non-Goals

BYOK does not attempt to emulate private Cursor behavior when no native exec or
interaction bridge is available. Unsupported tools fail explicitly so the provider
loop continues and the UI receives a terminal tool completion.

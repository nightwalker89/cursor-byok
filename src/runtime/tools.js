"use strict";

const { INTERACTION_BRIDGE_TOOL_NAMES } = require("./interaction-bridge");

const READ_TOOL_DESCRIPTION =
  "Reads a file from the local filesystem. You can access any file directly by using this tool.\n" +
  "If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\n" +
  "Usage:\n" +
  "- Prefer Grep to locate symbols, definitions, and callsites before using Read in a large file.\n" +
  "- Do not start with a whole-file Read when you only need to find where a symbol is defined or called.\n" +
  "- The only valid Read input keys are path, offset, and limit. Use path exactly; do not use filePath or file_path.\n" +
  "- If the user asks for offset=N, the Read call must include offset: N as an integer.\n" +
  "- If the user asks for limit=N, the Read call must include limit: N as an integer.\n" +
  "- Correct Read input example: {\"path\":\"/absolute/file.py\",\"offset\":1300,\"limit\":20}. Never send an empty path when the user gives an absolute path.\n" +
  "- Use offset and limit when the user asks for a line range, partial read, offset/limit behavior, or when a file is long.\n" +
  "- If Grep already suggested exact Read offset/limit windows for this file, use those exact values before inventing your own smaller same-file Read around the matched line.\n" +
  "- After an exact-symbol Grep identifies callsite or definition windows in a file, do not jump to unrelated earlier offsets in that same file before reading those suggested windows.\n" +
  "- If a current Read window already shows the comment or purpose text you need, do not Grep the same file for that exact prose.\n" +
  "- When citing existing code from Read output, use a Cursor code reference fence.\n" +
  "- The opening fence line must be exactly three backticks immediately followed by startLine:endLine:filepath, with no leading spaces; put the code body on following lines and end with a plain triple-backtick line.\n" +
  "- Replace startLine, endLine, and filepath with the actual values from the Read result. Never emit those placeholder words literally in the final answer.\n" +
  "- Emit the code reference fence as a top-level block, not inside a list item, block quote, or indented block.\n" +
  "- Build that code reference from the Read result's File: and Lines: values, and strip any leading NN| prefixes from the code body.\n" +
  "- Do not claim offset/limit was tested unless those fields were present in the actual Read call.\n" +
  "- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT.\n" +
  "- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.\n" +
  "- If you read a file that exists but has empty contents you will receive 'File is empty.'\n\n" +
  "Image Support:\n" +
  "- This tool can also read image files when called with the appropriate path.\n" +
  "- Supported image formats: jpeg/jpg, png, gif, webp.\n\n" +
  "PDF Support:\n" +
  "- PDF files are converted into text content automatically (subject to the same character limits as other files).";

// Single source of truth for the Read input schema, shared by the default tool
// catalog and patchReadToolSchema so the two can never drift.
function readToolInputSchema() {
  return objectSchema(
    {
      path: stringSchema("The absolute path of the file to read. Use the key path exactly; do not use filePath or file_path."),
      offset: integerSchema("Line number to start reading from. Positive values are 1-indexed from the start of the file. Negative values count backwards from the end. If the user gives offset=N, include offset: N exactly."),
      limit: integerSchema("Number of lines to read. If the user gives limit=N, include limit: N exactly."),
    },
    ["path"],
  );
}

const CURSOR_BUILTIN_TOOLS = [
  {
    name: "Shell",
    description:
      "Executes a command in a shell session with optional foreground timeout. Use this for terminal operations, not for reading, editing, writing, searching, or finding files when a specialized tool exists.",
    inputSchema: objectSchema(
      {
        command: stringSchema("The command to execute."),
        description: stringSchema("Clear, concise description of what this command does."),
        working_directory: stringSchema("The absolute working directory to execute the command in."),
        block_until_ms: integerSchema("Foreground wait timeout in milliseconds. Use 0 to immediately run in the background."),
      },
      ["command"],
    ),
  },
  {
    name: "Glob",
    description:
      "Tool to search for files matching a glob pattern. Returns matching file paths sorted by modification time.",
    inputSchema: objectSchema(
      {
        glob_pattern: stringSchema("The glob pattern to match files against."),
        target_directory: stringSchema("Absolute path to directory to search. Defaults to the Cursor workspace root."),
      },
      ["glob_pattern"],
    ),
  },
  {
    name: "LS",
    description:
      "Lists files and directories in a target directory as a structured directory tree. Prefer this over Glob when browsing folder contents.",
    inputSchema: objectSchema(
      {
        path: stringSchema("Path to directory to list contents of."),
        target_directory: stringSchema("Alias for path when listing a directory."),
        ignore: {
          type: "array",
          items: stringSchema("Glob pattern to ignore anywhere under the target directory."),
        },
        ignore_globs: {
          type: "array",
          items: stringSchema("Optional glob patterns to ignore."),
        },
      },
    ),
  },
  {
    name: "Grep",
    description:
      "A powerful search tool built on ripgrep. Prefer this before Read for exact symbol lookup, definition lookup, and callsite discovery. Output modes include content, files_with_matches, and count.",
    inputSchema: objectSchema(
      {
        pattern: stringSchema("The regular expression pattern to search for in file contents."),
        path: stringSchema("File or directory to search in. Defaults to the Cursor workspace root."),
        glob: stringSchema("Glob filter for files to include."),
        type: stringSchema("File type to search, for example js, py, rust, go, or java."),
        output_mode: stringSchema("One of content, files_with_matches, or count."),
        "-i": booleanSchema("Case-insensitive search."),
        "-A": integerSchema("Number of lines of trailing context after each match."),
        "-B": integerSchema("Number of lines of leading context before each match."),
        "-C": integerSchema("Number of lines of context before and after each match."),
        multiline: booleanSchema("Enable multiline matching."),
        head_limit: integerSchema("Maximum number of output entries to return."),
        offset: integerSchema("Offset into large result sets."),
      },
      ["pattern"],
    ),
  },
  {
    name: "AwaitShell",
    description:
      "Poll a background shell or subagent job. Provide shell_id or task_id from a previous background Shell or task result; calls without an id return an error.",
    inputSchema: objectSchema({
      shell_id: stringSchema("Background shell id to poll."),
      task_id: stringSchema("Background task or subagent id to poll."),
      block_until_ms: integerSchema("Max milliseconds to block before returning when shell_id or task_id is provided. Set to 0 for a non-blocking status check."),
    }),
  },
  {
    name: "Read",
    description: READ_TOOL_DESCRIPTION,
    inputSchema: readToolInputSchema(),
  },
  {
    name: "Delete",
    description: "Deletes a file at the specified path.",
    inputSchema: objectSchema({ path: stringSchema("The absolute path of the file to delete.") }, ["path"]),
  },
  {
    name: "Edit",
    description:
      "Performs exact string replacements in files. The edit fails if old_string is not unique unless replace_all is true.",
    inputSchema: objectSchema(
      {
        path: stringSchema("The absolute path to the file to modify."),
        old_string: stringSchema("The text to replace."),
        new_string: stringSchema("The text to replace it with."),
        replace_all: booleanSchema("Replace all occurrences of old_string."),
      },
      ["path", "old_string", "new_string"],
    ),
  },
  {
    name: "ApplyPatch",
    description:
      "Apply a single-file patch. The patch must start with *** Begin Patch and end with *** End Patch. All file paths must be absolute paths.",
    inputSchema: objectSchema({ patch: stringSchema("The patch content.") }, ["patch"]),
  },
  {
    name: "Write",
    description:
      "Writes a file to the local filesystem. This overwrites the existing file if there is one at the provided path.",
    inputSchema: objectSchema(
      {
        path: stringSchema("The absolute path to the file to write."),
        contents: stringSchema("The contents to write to the file."),
      },
      ["path", "contents"],
    ),
  },
  {
    name: "EditNotebook",
    description: "Edits a Jupyter notebook cell.",
    inputSchema: objectSchema(
      {
        target_notebook: stringSchema("The notebook file path."),
        cell_idx: integerSchema("Zero-based cell index."),
        new_string: stringSchema("New cell content."),
        old_string: stringSchema("Existing cell content to replace."),
        is_new_cell: booleanSchema("Whether to create a new cell."),
        cell_language: stringSchema("Language for a new cell."),
      },
      ["target_notebook", "cell_idx", "new_string"],
    ),
  },
  {
    name: "TodoWrite",
    description: "Updates the internal progress todo list. Todo items only accept id, content, and status. Do not include dependencies or CreatePlan-only fields.",
    inputSchema: objectSchema(
      {
        todos: {
          type: "array",
          items: objectSchema(
            {
              id: stringSchema("Todo id."),
              content: stringSchema("Todo content."),
              status: stringSchema("Todo status."),
            },
          ),
        },
        merge: booleanSchema("Merge with existing todos."),
      },
      ["todos"],
    ),
  },
  {
    name: "ReadLints",
    description: "Reads diagnostics and lint errors for files or directories.",
    inputSchema: objectSchema({
      paths: { type: "array", items: stringSchema("Path to inspect.") },
    }),
  },
  {
    name: "WebSearch",
    description: "Search the web for real-time information.",
    inputSchema: objectSchema(
      {
        search_term: stringSchema("The search term to look up on the web."),
        explanation: stringSchema("One sentence explanation for why this search is needed."),
      },
      ["search_term"],
    ),
  },
  {
    name: "WebFetch",
    description: "Fetch content from a specified URL and return its contents in readable markdown.",
    inputSchema: objectSchema({ url: stringSchema("The URL to fetch.") }, ["url"]),
  },
  {
    name: "WriteShellStdin",
    description: "Write characters to the stdin of an already-running background shell.",
    inputSchema: objectSchema(
      {
        shell_id: stringSchema("Background shell id."),
        chars: stringSchema("Characters to write to shell stdin."),
      },
      ["shell_id", "chars"],
    ),
  },
  {
    name: "GenerateImage",
    description: "Generate an image file from a text description. Only use when the user explicitly asks for an image.",
    inputSchema: objectSchema(
      {
        description: stringSchema("A detailed description of the image."),
        filename: stringSchema("Optional filename for the generated image."),
        reference_image_paths: { type: "array", items: stringSchema("Reference image path.") },
      },
      ["description"],
    ),
  },
  {
    name: "AskQuestion",
    description: "Present questions to the user and wait for responses.",
    inputSchema: objectSchema(
      {
        title: stringSchema("Optional title for the questions form."),
        questions: {
          type: "array",
          items: objectSchema(
            {
              id: stringSchema("Question id."),
              prompt: stringSchema("Question text."),
              options: {
                type: "array",
                items: objectSchema(
                  {
                    id: stringSchema("Option id."),
                    label: stringSchema("Option label."),
                  },
                  ["id", "label"],
                ),
              },
              allow_multiple: booleanSchema("Whether multiple options can be selected."),
            },
            ["id", "prompt", "options"],
          ),
        },
      },
      ["questions"],
    ),
  },
  {
    name: "Task",
    description: "Launch a subagent to handle complex, multi-step tasks autonomously.",
    inputSchema: objectSchema(
      {
        description: stringSchema("Short task description."),
        prompt: stringSchema("The task for the agent to perform."),
        subagent_type: stringSchema("Subagent type."),
        model: stringSchema("Optional model to use."),
        readonly: booleanSchema("Run in readonly mode."),
        run_in_background: booleanSchema("Run the agent in the background."),
        resume: stringSchema("Agent id to resume."),
        attachments: { type: "array", items: stringSchema("Attachment path or id.") },
      },
      ["description", "prompt"],
    ),
  },
  {
    name: "ListMcpResources",
    description: "List available resources from configured MCP servers.",
    inputSchema: objectSchema({ server: stringSchema("Optional server identifier.") }),
  },
  {
    name: "FetchMcpResource",
    description: "Fetch a resource from a configured MCP server.",
    inputSchema: objectSchema(
      {
        server: stringSchema("Server identifier."),
        uri: stringSchema("Resource URI."),
        downloadPath: stringSchema("Optional path to download the resource to."),
      },
      ["server", "uri"],
    ),
  },
  {
    name: "SwitchMode",
    description: "Request switching Cursor mode.",
    inputSchema: objectSchema(
      {
        target_mode_id: stringSchema("The mode to switch to."),
        explanation: stringSchema("Optional explanation."),
      },
      ["target_mode_id"],
    ),
  },
  {
    name: "CallMcpTool",
    description: "Call a configured MCP tool.",
    inputSchema: objectSchema(
      {
        name: stringSchema("MCP execution name."),
        args: { type: "object", properties: {}, additionalProperties: true },
        providerIdentifier: stringSchema("MCP provider identifier."),
        toolName: stringSchema("MCP tool name."),
      },
      ["name", "args", "providerIdentifier", "toolName"],
    ),
  },
  {
    name: "CreatePlan",
    description: "Create the complete Cursor plan artifact. Cursor stores name/overview/todos/phases/isProject in YAML frontmatter (structured UI) and writes the plan field as the markdown body in the .plan.md file. This is separate from TodoWrite; CreatePlan todo items may include dependencies.",
    inputSchema: objectSchema(
      {
        name: stringSchema("Short plan name."),
        overview: stringSchema("One-paragraph high-level summary shown in the plan overview section."),
        plan: stringSchema("Markdown plan body written below the frontmatter. Use a # title and ## sections; do not repeat the todo checklist here."),
        todos: {
          type: "array",
          items: objectSchema(
            {
              id: stringSchema("Todo id."),
              content: stringSchema("Todo content."),
              status: stringSchema("Todo status."),
              dependencies: {
                type: "array",
                items: stringSchema("Todo id this item depends on."),
              },
            },
            ["id", "content"],
          ),
        },
        isProject: booleanSchema("Whether this is a project plan."),
        phases: {
          type: "array",
          items: objectSchema(
            {
              name: stringSchema("Phase name."),
              todos: {
                type: "array",
                items: objectSchema(
                  {
                    id: stringSchema("Todo id."),
                    content: stringSchema("Todo content."),
                    status: stringSchema("Todo status."),
                    dependencies: {
                      type: "array",
                      items: stringSchema("Todo id this item depends on."),
                    },
                  },
                  ["id", "content"],
                ),
              },
            },
            ["name", "todos"],
          ),
        },
      },
    ),
  },
];

const DEFAULT_PROVIDER_TOOL_NAMES = new Set([
  "Shell",
  "Glob",
  "Grep",
  "LS",
  "AwaitShell",
  "Read",
  "Delete",
  "Edit",
  "ApplyPatch",
  "Write",
  "EditNotebook",
  "TodoWrite",
  "ReadLints",
  "WebFetch",
  "WriteShellStdin",
  "ListMcpResources",
  "FetchMcpResource",
  "AskQuestion",
  "SwitchMode",
  "CallMcpTool",
  "CreatePlan",
]);

const PROVIDER_TOOL_SCHEMA_ANNOTATION_KEYS = Object.freeze(new Set([
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
]));

function stringSchema(description) {
  return { type: "string", description };
}

function integerSchema(description) {
  return { type: "integer", description };
}

function booleanSchema(description) {
  return { type: "boolean", description };
}

function objectSchema(properties, required) {
  const schema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required?.length) schema.required = required;
  return schema;
}

function defaultCursorBuiltinTools() {
  return cloneJson(CURSOR_BUILTIN_TOOLS.filter((tool) => DEFAULT_PROVIDER_TOOL_NAMES.has(tool.name)));
}

function appendInteractionBridgeProviderTools(tools) {
  if (!Array.isArray(tools)) return;
  const seen = new Set();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    for (const name of [tool.name, tool.canonicalName, tool.executionName]) {
      if (typeof name === "string" && name) seen.add(name);
    }
  }
  for (const tool of CURSOR_BUILTIN_TOOLS) {
    if (!INTERACTION_BRIDGE_TOOL_NAMES.has(tool.name)) continue;
    if (seen.has(tool.name)) continue;
    tools.push(cloneJson(tool));
    seen.add(tool.name);
  }
}

function cursorBuiltinTool(name) {
  const tool = CURSOR_BUILTIN_TOOLS.find((candidate) => candidate.name === name);
  return tool ? cloneJson(tool) : undefined;
}

function normalizeInteger(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

function buildReadArgs(input, workspacePathResolver) {
  const raw = input && typeof input === "object" ? input : {};
  const pathValue = raw.path || raw.filePath || raw.file_path;
  const path = workspacePathResolver
    ? workspacePathResolver(pathValue)
    : pathValue;
  const offset = normalizeInteger(raw.offset);
  const limit = normalizeInteger(raw.limit);
  return {
    path,
    ...(Number.isInteger(offset) ? { offset } : {}),
    ...(Number.isInteger(limit) ? { limit } : {}),
  };
}

function patchReadToolSchema(tool) {
  const name = tool?.canonicalName || tool?.name;
  if (name !== "Read" && name !== "ReadFile") return tool;
  const next = { ...tool, description: READ_TOOL_DESCRIPTION };
  next.inputSchema = readToolInputSchema();
  return next;
}

function patchCallMcpToolSchema(tool) {
  const name = tool?.canonicalName || tool?.name;
  if (name !== "CallMcpTool") return tool;
  const rawSchema = tool?.inputSchema || tool?.parameters;
  if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) return tool;
  const properties = rawSchema.properties && typeof rawSchema.properties === "object" && !Array.isArray(rawSchema.properties)
    ? rawSchema.properties
    : {};
  const args = properties.args;
  if (!args || typeof args !== "object" || Array.isArray(args) || args.type !== "object" || args.additionalProperties !== undefined) return tool;
  const inputSchema = {
    ...rawSchema,
    properties: {
      ...properties,
      args: { ...args, additionalProperties: true },
    },
  };
  return { ...tool, inputSchema };
}

function patchProviderToolSchema(tool) {
  return patchCallMcpToolSchema(patchReadToolSchema(tool));
}

function normalizeProviderJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeProviderJsonSchema);
  const out = { ...schema };
  const typeMap = {
    OBJECT: "object",
    STRING: "string",
    INTEGER: "integer",
    NUMBER: "number",
    BOOLEAN: "boolean",
    ARRAY: "array",
  };
  if (typeof out.type === "string") out.type = typeMap[out.type] ?? out.type.toLowerCase();
  for (const key of ["properties", "patternProperties", "$defs", "definitions"]) {
    if (out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = Object.fromEntries(
        Object.entries(out[key]).map(([childKey, childValue]) => [
          childKey,
          normalizeProviderJsonSchema(childValue),
        ]),
      );
    }
  }
  if (out.dependentSchemas && typeof out.dependentSchemas === "object" && !Array.isArray(out.dependentSchemas)) {
    out.dependentSchemas = Object.fromEntries(
      Object.entries(out.dependentSchemas).map(([childKey, childValue]) => [
        childKey,
        normalizeProviderJsonSchema(childValue),
      ]),
    );
  }
  for (const key of ["items", "additionalProperties", "additionalItems", "contains", "not", "if", "then", "else"]) {
    if (out[key] && typeof out[key] === "object") out[key] = normalizeProviderJsonSchema(out[key]);
  }
  for (const key of ["prefixItems", "anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map(normalizeProviderJsonSchema);
  }
  return out;
}

function closeProviderObjectSchema(schema) {
  const normalized = normalizeProviderJsonSchema(schema);
  return closeProviderObjectSchemaRecursive(normalized, true, normalized, new Set());
}

function closeProviderObjectSchemaRecursive(schema, closeCurrent, rootSchema, seenRefs) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((item) => closeProviderObjectSchemaRecursive(item, closeCurrent, rootSchema, seenRefs));
  if (closeCurrent) {
    const resolved = providerToolResolvedSchema(schema, rootSchema, seenRefs);
    if (resolved && resolved !== schema) {
      const closedResolved = closeProviderObjectSchemaRecursive(resolved, true, rootSchema, nextProviderRefSeen(schema, seenRefs));
      const siblingSchema = providerToolRefSiblingSchema(schema);
      if (!siblingSchema) return closedResolved;
      const closedSibling = closeProviderObjectSchemaRecursive(siblingSchema, true, rootSchema, seenRefs);
      return mergeProviderRefSchema(closedResolved, closedSibling);
    }
  }
  const out = { ...schema };
  for (const key of ["properties", "patternProperties"]) {
    if (out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = Object.fromEntries(
        Object.entries(out[key]).map(([childKey, childValue]) => [
          childKey,
          closeProviderObjectSchemaRecursive(childValue, true, rootSchema, seenRefs),
        ]),
      );
    }
  }
  for (const key of ["$defs", "definitions", "dependentSchemas"]) {
    if (out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = Object.fromEntries(
        Object.entries(out[key]).map(([childKey, childValue]) => [
          childKey,
          closeProviderObjectSchemaRecursive(childValue, false, rootSchema, seenRefs),
        ]),
      );
    }
  }
  for (const key of ["items", "additionalProperties", "additionalItems", "contains"]) {
    if (out[key] && typeof out[key] === "object") out[key] = closeProviderObjectSchemaRecursive(out[key], true, rootSchema, seenRefs);
  }
  for (const key of ["not", "if", "then", "else"]) {
    if (out[key] && typeof out[key] === "object") out[key] = closeProviderObjectSchemaRecursive(out[key], false, rootSchema, seenRefs);
  }
  for (const key of ["prefixItems", "anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map((item) => closeProviderObjectSchemaRecursive(item, false, rootSchema, seenRefs));
  }
  if (closeCurrent && out.type === "object" && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
}

function nextProviderRefSeen(schema, seenRefs) {
  const ref = typeof schema?.$ref === "string" ? schema.$ref : "";
  if (!ref) return seenRefs;
  const next = new Set(seenRefs);
  next.add(ref);
  return next;
}

function providerToolRefSiblingSchema(schema) {
  const siblingSchema = { ...schema };
  delete siblingSchema.$ref;
  delete siblingSchema.$defs;
  delete siblingSchema.definitions;
  return Object.keys(siblingSchema).length ? siblingSchema : null;
}

function mergeProviderRefSchema(resolvedSchema, siblingSchema) {
  if (!siblingSchema || typeof siblingSchema !== "object" || Array.isArray(siblingSchema)) return resolvedSchema;
  if (Object.keys(siblingSchema).every((key) => PROVIDER_TOOL_SCHEMA_ANNOTATION_KEYS.has(key))) {
    return { ...resolvedSchema, ...siblingSchema };
  }
  return { allOf: [resolvedSchema, siblingSchema] };
}

function coerceProviderToolSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  const normalized = normalizeProviderJsonSchema(schema);
  const required = providerToolSchemaRequired(normalized, normalized);
  const coerced = {
    ...withoutTopLevelToolSchemaCombinators(normalized),
    type: "object",
    properties: providerToolSchemaProperties(normalized, normalized),
  };
  if (required.length) coerced.required = required;
  return closeProviderObjectSchema(coerced);
}

function withoutTopLevelToolSchemaCombinators(schema) {
  const rest = { ...(schema || {}) };
  delete rest.anyOf;
  delete rest.oneOf;
  delete rest.allOf;
  delete rest.enum;
  delete rest.not;
  return rest;
}

function providerToolSchemaProperties(schema, rootSchema = schema, seenRefs = new Set()) {
  const resolved = providerToolResolvedSchema(schema, rootSchema, seenRefs);
  if (resolved && resolved !== schema) return providerToolSchemaProperties(resolved, rootSchema, nextProviderRefSeen(schema, seenRefs));
  const properties = schema && typeof schema.properties === "object" && !Array.isArray(schema.properties)
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

function providerToolSchemaRequired(schema, rootSchema = schema, seenRefs = new Set()) {
  const resolved = providerToolResolvedSchema(schema, rootSchema, seenRefs);
  if (resolved && resolved !== schema) return providerToolSchemaRequired(resolved, rootSchema, nextProviderRefSeen(schema, seenRefs));
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((item) => typeof item === "string") : []);
  const allOf = schema?.allOf;
  if (!Array.isArray(allOf)) return [...required];
  for (const item of allOf) {
    const itemRequired = providerToolSchemaRequired(item, rootSchema, seenRefs);
    for (const key of itemRequired) {
      if (typeof key === "string") required.add(key);
    }
  }
  return [...required];
}

function providerToolResolvedSchema(schema, rootSchema, seenRefs) {
  const ref = typeof schema?.$ref === "string" ? schema.$ref : "";
  if (!ref || seenRefs.has(ref)) return null;
  const resolved = providerToolResolveRef(rootSchema, ref);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return null;
  return resolved;
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

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = {
  CURSOR_BUILTIN_TOOLS,
  READ_TOOL_DESCRIPTION,
  appendInteractionBridgeProviderTools,
  buildReadArgs,
  closeProviderObjectSchema,
  coerceProviderToolSchema,
  cursorBuiltinTool,
  defaultCursorBuiltinTools,
  normalizeInteger,
  normalizeProviderJsonSchema,
  patchProviderToolSchema,
  patchReadToolSchema,
  PROVIDER_TOOL_SCHEMA_ANNOTATION_KEYS,
};

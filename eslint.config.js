"use strict";

const js = require("@eslint/js");

/**
 * Flat ESLint config for the cursor-byok extension.
 *
 * The codebase is plain Node/CommonJS under `src/`, `scripts/`, and `tests/`
 * (no bundler). The intent here is a low-noise correctness gate — catch real
 * mistakes (undeclared names, unreachable code, broken regex) and let style be.
 */
module.exports = [
  {
    ignores: [
      "node_modules/**",
      "models-catalog.json",
      ".playwright-mcp/**",
      "src/webview.html",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        exports: "writable",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        queueMicrotask: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        fetch: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        EventSource: "readonly",
        WebSocket: "readonly",
        // Present only in the webview/renderer-injected paths that some
        // modules reference defensively.
        window: "readonly",
      },
    },
    rules: {
      // Surfaced as warnings so the gate flags them without failing CI; the
      // hardening work removes them incrementally.
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // `var` hoisting in the injected hook re-declares a few names per scope,
      // and one duplicate fn is dead code removed during hardening — warn, not fail.
      "no-redeclare": "warn",
    },
  },
];

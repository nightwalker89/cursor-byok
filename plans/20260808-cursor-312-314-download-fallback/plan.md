# Cursor 3.12–3.14 Build Inspection

## Goal

Give developers a safe, internal way to download official Cursor 3.12–3.14
DMGs, inspect their patch compatibility, and add evidence-backed matchers.

## Delivered design

- Internal command: `node scripts/cursor-pristine-download.js --version <version>`.
- Official macOS ARM64, x64, and Universal family endpoints only.
- Read-only DMG mount, code-signature validation, SHA-256 temporary cache, and
  patch-plan report.
- Captured and verified 3.12.30, 3.13.25, and 3.14.27.
- No importer in `install:cursor`, `preflight:cursor`, or the extension runtime.

## Non-goals

- Runtime pristine-source fallback.
- App installation, replacement, or downgrade.
- Auto-downloading any Cursor build for end users.

## Follow-up workflow

When a future Cursor update changes a seam, run the internal tool, capture the
minimal redacted seam, add a versioned matcher plus regression fixture, and run
the strict patch plan before release.

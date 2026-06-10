# Cursor BYOK Documentation

[中文版](README_CN.md)

This directory documents the current `starduster.cursor-byok` implementation. It is
for the rewritten extension on `main`; old reverse-engineering notes live on the
`old` branch. Every doc has a Chinese sibling (`*_CN.md`).

## Index

- [Architecture](./architecture.md) · [中文](./architecture_CN.md): extension, local server, injected workbench hook, and provider adapter boundaries.
- [Install and Config](./install-config.md) · [中文](./install-config_CN.md): install flow, files under `~/.cursor-byok`, and runtime controls.
- [Routing and Hook](./routing-hook.md) · [中文](./routing-hook_CN.md): how Cursor requests are selected, redirected, or left untouched.
- [Provider and Tools](./provider-tools.md) · [中文](./provider-tools_CN.md): provider APIs, tool schemas, native Cursor execution, and result flow.
- [Cursor Tool Spec](./cursor-tool-spec.md) · [中文](./cursor-tool-spec_CN.md): provider-visible Cursor tools, input schemas, native exec mapping, and result cases.
- [Verification](./verification.md) · [中文](./verification_CN.md): unit, install, and UI regression checks that matter for this project.

## Branch Split

- `main`: readable rewritten extension source and current docs.
- `old`: previous implementation plus analysis artifacts under `analysis/`,
  `deobfuscated/`, `docs/`, and `vsix-unpacked/`.

Do not copy old analysis files back to `main` as documentation. If a behavior is
needed on `main`, document the current source path and test that proves it.

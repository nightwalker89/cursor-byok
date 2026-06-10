# Cursor BYOK 文档

[English](README.md)

本目录记录了 `starduster.cursor-byok` 在 `main` 分支上的实现——对应重写后的扩展。旧的逆向分析笔记在 `old` 分支。每篇文档都有对应的英文版（文件名去掉 `_CN`）。

## 索引

- [架构](./architecture_CN.md) · [EN](./architecture.md)：扩展、本地服务器、注入的 workbench hook、provider 适配器边界。
- [安装与配置](./install-config_CN.md) · [EN](./install-config.md)：安装流程、`~/.cursor-byok` 下的文件、运行时控制。
- [路由与 Hook](./routing-hook_CN.md) · [EN](./routing-hook.md)：Cursor 请求如何被选中、重定向或原样放行。
- [Provider 与工具](./provider-tools_CN.md) · [EN](./provider-tools.md)：provider API、工具 schema、Cursor 原生执行、结果流。
- [Cursor 工具规格](./cursor-tool-spec_CN.md) · [EN](./cursor-tool-spec.md)：provider 可见 Cursor 工具、输入 schema、native exec 映射、结果 case。
- [验证](./verification_CN.md) · [EN](./verification.md)：单元测试、安装检查、UI 回归。

## 分支划分

- `main`：可读的重写扩展源码和最新文档。
- `old`：旧实现以及 `analysis/`、`deobfuscated/`、`docs/`、`vsix-unpacked/` 下的分析产物。

不要把旧分析文件当成文档搬回 `main`。如果 `main` 需要某个行为，应当记录当前源码路径和对应的测试。

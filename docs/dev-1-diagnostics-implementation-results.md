# DEV-1 F06/R02 CLI 诊断实施结果

日期：2026-09-17
文档角色：结果
状态：当前执行
当前入口：[Stage 6 当前实施入口](./stage-6-convergence-and-start-state-2026-09-15.md)
基线：`0e4146327de995dc92da6367fc654b493a224665`；Node.js `24.19.0`；pnpm `11.19.0`
范围：本阶段第一检查点的 RFT-1 纯提取与 focused 回归；F06/R02 诊断行为修复另行审查

## 1. 当前结论

RFT-1 纯提取可以独立审阅：CLI 仍从同一位置调用摘要函数，新模块没有 CLI 入口、环境读取、文件写入或 HTTP 依赖。当前提交保持原有摘要行为，便于 Sol 先确认提取没有悄悄改变 Provider wire 或执行路径。

F06/R02 尚未关闭。native `function.arguments` 的原文脱敏、Qwen strict `calls[]` 归一、多调用与错误 envelope 的安全投影、error/usage 的敏感字段过滤，以及诊断字符串中的 ESC/CSI/OSC/换行净化，留在第二个行为修复检查点。不要以本次纯函数回归作为 L01 完成证据。

## 2. 本检查点变更

- 源：`apps/cli/src/index.ts` 内 `providerToolNames`、`summarizeProviderResponse`、`summarizeStructuredContent`、`summarizeProviderArguments` 与 `isPlainRecord`。
- 目标：`apps/cli/src/diagnostics/provider-summary.ts`；`index.ts` 只保留原有 `RecordingGlmHttpClient` / `RecordingQwenHttpClient` 调用并导入摘要函数。
- 测试：`apps/cli/src/diagnostics/provider-summary.test.ts` 从新模块导入并覆盖 native 摘要、flat calls 现有投影和多工具名；测试不会 import CLI main，不读 env，不发请求。
- 没有新增 `recording-clients.ts`：记录客户端仍在 CLI，等第二检查点以真实 Mock HTTP 写盘路径决定是否需要小范围提取，避免为拆文件而拆文件。

## 3. 验证与边界

本检查点只运行 focused Vitest，实际通过 1 个测试文件、3 项测试，退出码 0：

```powershell
pnpm exec vitest run apps/cli/src/diagnostics/provider-summary.test.ts
```

未运行全仓 typecheck/full test，避免与集成人重复构建。没有调用真实模型 API、访问真实桌面、启动 VM 或 push；本检查点将以独立本地 commit 留痕。

第二检查点必须新增实际 `RecordingGlmHttpClient` / `RecordingQwenHttpClient` Mock HTTP 写盘测试，使用合成 typed text、Memory value、文件路径、URL、token/card-like 字段和 ESC/CSI/OSC/换行，断言 JSONL 不含正文且 native/flat 单调用与多调用投影一致；错误响应和 usage 也必须只保留安全结构。CLI help/import 无副作用继续作为边界回归。

## 4. 审查与下一步

Sol 已放行本次 RFT-1 的源→目标映射、公开导出范围和 focused 回归；本地纯提取 commit 将独立建立，随后才实现 F06/R02 行为修复，保持两个检查点可分别回退。DEV-1 的其他诊断/配置/终端净化工作、DEV-1A/1C、真实 API 和真实桌面仍不在本检查点范围内。

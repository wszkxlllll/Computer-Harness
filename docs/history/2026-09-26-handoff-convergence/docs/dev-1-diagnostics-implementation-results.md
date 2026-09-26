# DEV-1 F06/R02 CLI 诊断实施结果

日期：2026-09-17
文档角色：结果
状态：Sol 已放行；CLI 行为修复已本地提交，离线集成验证通过
当前入口：[Stage 6 当前实施入口](./stage-6-convergence-and-start-state-2026-09-15.md)
基线：`0e4146327de995dc92da6367fc654b493a224665`；Node.js `24.19.0`；pnpm `11.19.0`
范围：本阶段第一检查点的 RFT-1 纯提取与 focused 回归，以及已另行审查并放行的 F06/R02 诊断行为修复

## 1. 当前结论

RFT-1 纯提取已独立审阅：CLI 仍从同一位置调用摘要函数，新模块没有 CLI 入口、环境读取、文件写入或 HTTP 依赖。第一检查点保持原有摘要行为，便于 Sol 确认提取没有悄悄改变 Provider wire 或执行路径。

第一检查点当时尚未关闭 F06/R02；native `function.arguments` 的原文脱敏、Qwen strict `calls[]` 归一、多调用与错误 envelope 的安全投影、error/usage 的敏感字段过滤，以及诊断字符串中的 ESC/CSI/OSC/换行净化已在第二检查点完成并由 Sol 放行。不要以第一检查点纯函数回归单独作为 L01 完成证据。

## 2. 本检查点变更（历史提取）

- 源：`apps/cli/src/index.ts` 内 `providerToolNames`、`summarizeProviderResponse`、`summarizeStructuredContent`、`summarizeProviderArguments` 与 `isPlainRecord`。
- 目标：`apps/cli/src/diagnostics/provider-summary.ts`；`index.ts` 只保留原有 `RecordingGlmHttpClient` / `RecordingQwenHttpClient` 调用并导入摘要函数。
- 测试：`apps/cli/src/diagnostics/provider-summary.test.ts` 从新模块导入并覆盖 native 摘要、flat calls 现有投影和多工具名；测试不会 import CLI main，不读 env，不发请求。
- 没有新增 `recording-clients.ts`：记录客户端仍在 CLI，等第二检查点以真实 Mock HTTP 写盘路径决定是否需要小范围提取，避免为拆文件而拆文件。

## 3. 验证与边界（历史提取）

本检查点只运行 focused Vitest，实际通过 1 个测试文件、3 项测试，退出码 0：

```powershell
pnpm exec vitest run apps/cli/src/diagnostics/provider-summary.test.ts
```

未运行全仓 typecheck/full test，避免与集成人重复构建。没有调用真实模型 API、访问真实桌面、启动 VM 或 push；本检查点已由独立本地 commit `1e7fb55f23b1ec0696d67f6693576155f5847ced` 留痕。

第二检查点随后新增实际 `RecordingGlmHttpClient` / `RecordingQwenHttpClient` Mock HTTP 写盘测试，使用合成 typed text、Memory value、文件路径、URL、token/card-like 字段和 ESC/CSI/OSC/换行，断言 JSONL 不含正文且 native/flat 单调用与多调用投影一致；错误响应和 usage 也只保留安全结构。CLI help/import 无副作用继续作为边界回归。

## 4. 审查与下一步

Sol 已先放行 RFT-1 的源→目标映射、公开导出范围和 focused 回归，随后最终放行 F06/R02 行为修复；两个检查点已由独立 commit 保持可分别回退。DEV-1 的其他诊断/配置/终端净化工作、DEV-1A/1C、真实 API 和真实桌面仍不在本检查点范围内。

## 5. F06/R02 行为修复检查点（历史记录，已由 Sol 放行）

第二检查点已在纯提取 commit 之后完成，并在 Sol 最终复审放行后建立本地 commit `6f0ca33b36cfbfd68584a0e17f6e01eb9d6511db`。`provider-summary.ts` 将 native `message.tool_calls` 与 Qwen strict JSON `message.content.calls[]` 投影到同一安全诊断形状：工具数量、请求 schema allowlist 内的 name、稳定 SHA-256 opaque id、长度、参数 shape/keyCount/serializedLength、parse 状态和稳定诊断码；不写 typed text、Memory value、路径、URL 或嵌套参数原文。未知 envelope、缺少/错误 calls、畸形 native JSON 参数和非对象 strict 参数只保留 shape/count/长度/诊断码。

`summarizeProviderUsage` 只允许 prompt/completion/total token 的非负整数，其他 usage 字段仅计数；`summarizeTransportError` 只保留显式 allowlist 内的 name/code、长度和错误类别，不记录 URL、headers、token 或 error message。response model 只能回显可信请求模型，finish reason/type/name/code 均按字段 allowlist 投影；未知值置空并记录稳定 code，不能注入 ESC/CSI/OSC、换行或伪审批文本。GLM 与 Qwen 的 wire 格式仍分别由各自 Provider Adapter 负责，没有创建统一 wire JSON。

两个实际 recorder 路径已移入 `apps/cli/src/diagnostics/recording-clients.ts`，仍由 `apps/cli/src/index.ts` 的 `makeProvider` 使用；测试通过注入 Fake HTTP client 触发真实 `post`→摘要→JSONL 写盘链路，不 import CLI main、不读 env、不发网络请求。新增 `recording-clients.test.ts` 覆盖 GLM native 多调用、Qwen strict flat 多调用及两种错误路径，合成敏感 typed text、Memory/path/URL/header 内容均断言不出现在 JSONL。

本次（收敛前）focused 验证实际通过（Node `24.19.0` / pnpm `11.19.0`）：

```powershell
pnpm exec vitest run apps/cli/src/diagnostics
```

当时结果为 Vitest `2` 个测试文件、`12` 项测试、退出码 `0`；这是四点最小收敛前的中间证据，不作为当前最终计数。此处原先记录的“等待 Sol/尚未 commit”仅属于当时状态，现已由最终复审和 `6f0ca33` 取代。未在本检查点调用真实 API、桌面或 VM；此次只覆盖 CLI 诊断，不关闭 F12 全部终端/TUI 需求，也不宣称所有 DEV-1 已完成。

provider-exchanges JSONL 是默认的安全摘要，不是完整重放记录：本批仍将 canonical trajectory、assets、memory/plan 数据和原始执行记录视为私有运行产物，未建立可分享的导出路径，也未实现 raw-wire opt-in。真实 recorder 测试还断言 URL、body、headers、AbortSignal 原样转发，且 response/error 对象 identity 不被改写；这些断言不改变上述私有数据边界。

## 6. 收敛后离线集成验证（最终本地证据）

Sol 要求的四点最小收敛已落在当前工作树：保留 GLM HTTP payload code `1305`；request schema 是 recorder 的唯一工具名信任来源并只解析一次供输出与 response 精确匹配；移除无生产消费者的 `providerToolNames`/`safeDiagnosticIdentifier`；`structuredContent` 只保留 JSON 结构元数据，调用摘要只在顶层保留一次。此前 12 项 focused 结果对应收敛前代码；收敛后的 focused 回归为 2 个文件、11 项测试、退出码 0。

在上述最新 CLI 修改及并行 Risk/Context/Memory 工作树修改均存在时，提交前的全量离线验证实际通过（Node.js `24.19.0`、pnpm `11.19.0`；该计数为中间证据）：

```powershell
pnpm run typecheck
pnpm test
node apps/cli/dist/index.js --help
git diff --exit-code -- package.json pnpm-lock.yaml pnpm-workspace.yaml
git diff --check
```

- `pnpm run typecheck`：退出码 `0`。
- `pnpm test`：退出码 `0`，Vitest `19` 个测试文件、`232` 项测试；包含当前 Risk、Context、Memory 回归测试。
- CLI help：退出码 `0`，打印 Usage 后无模型/桌面副作用。
- 依赖/lock drift：退出码 `0`。
- tracked diff whitespace：退出码 `0`；两个新增 diagnostics 文件的独立尾随空白扫描无匹配。

Sol 最终复审已放行 CLI focused `11/11`；本地提交 `6f0ca33b36cfbfd68584a0e17f6e01eb9d6511db` 的 author 与 committer 均为 `wszkxlllll <142909575+wszkxlllll@users.noreply.github.com>`。提交后最终集成仍为：`pnpm run typecheck` 退出码 `0`；`pnpm test` 退出码 `0`，Vitest `19` 个测试文件、`233` 项测试，其中 Memory 回归合计 `19` 项；`node apps/cli/dist/index.js --help` 退出码 `0`；依赖/lock drift 退出码 `0`；tracked `git diff --check` 退出码 `0`。本轮没有 Hosted CI、真实模型 API、真实桌面、VM 或 push 证据，因此不宣称 Hosted 或实机验收通过；并行修改未纳入本 CLI 提交范围。

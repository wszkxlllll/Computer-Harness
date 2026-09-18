# DEV-3 Context / Trace / Prepared Provider 实施记录

状态：本批完成一个可编译、可离线回归的 Context → Runtime → Provider prepared 闭环，等待 Sol 集中审查。本批不声称 DEV-3 全部完成；未调用真实模型 API、桌面、VM 或 `.env`。

## 范围与基线

- 分支：`codex/dev3-context-memory-guard`。
- 基线：当前 DEV-2 收口提交 `a55585a`；先前 RFT4 纯拆分已独立提交 `24ce072`（`refactor(context): split RFT4 compiler responsibilities`）。
- 本批只覆盖 Context 分区/历史预算/Memory 软配额、可审计 Trace、GLM/Qwen 的 prepared wire 请求，以及 Runtime 的准备屏障、重试关联和轨迹 schema。Memory scope、Monitor、完整指令语义归纳、跨 Run 缓存和真实 Provider 接入不在本批。

## 已实现合同

### Context 与 Trace

`DefaultContextCompiler` 将 system、goal、tools、plan、memory 作为可解释 fixed blocks；历史仍按完整 response/call/result/action 组裁剪，权威 `user.input.received` 不因普通历史预算被丢弃。Memory 使用软配额，超限时保留受限索引/查询提示而不使最终估算超过配额；配额过小也不会无界放行。

`ContextBudgetReport.trace` 只含编译器版本、run/event 标识、稳定 system+tools 前缀 hash、fixed block 估算、历史选择结果 `selectedEventIds`、实际进入 ModelInput 的 `projectedEventIds`、保留/舍弃事件及原因、权威输入 ID、历史/Memory 估算和 observation 是否存在；Runtime 在实际 attempt 上补入 prepared hash/estimate。非投影的 run/request/action/observation 历史事件可以出现在选择结果中，但不会被冒称为 projected payload；最新 observation 作为实际 image 投影单独列入。Trace 不带 prompt 正文、图片字节、文件路径或 secret。`stablePrefixHash` 是私有诊断用结构 hash，不保证匿名化，也不是安全公开凭证。

### Prepared Provider 请求

`ProviderAdapter` 增加可选的 `prepare` / `generatePrepared`。公共 `PreparedProviderRequest` 只有只读 `providerId`、结构 hash 和独立的 `PreparedRequestEstimate`；实际 HTTP body、图像空间和原始 `ModelInput` 仅存在对应 adapter 的私有 `WeakMap` 中。metadata/body 均冻结，跨 adapter 或伪造 token 会被拒绝，prepared token 不可序列化为 wire body。

GLM 与 Qwen 的 `generate` 仍是兼容入口，内部复用同一 prepare→send 路径；prepare 阶段可读 asset，但不发网络请求。`estimatedTextTokens` 来自去除 image base64 后的实际 serialized wire body（文本、tool/schema/catalog、continuation 等），`imageCount` 单列，未知图像 token 不猜；估算不冒充 `ModelUsage`。

Qwen 仅在真实响应 `usage.prompt_tokens_details.cached_tokens` 为非负整数时产生 `ModelUsage.cacheReadTokens`；缺失、非法或 GLM 未验证的同名扩展均不产生该字段。Trajectory schema 与安全 provider summary 同步支持它。Run snapshot 不把部分响应的 cache read 相加为假总量，逐 response 的 `ModelTurn.usage` 才是观察证据；缺失保持 unknown。

### Runtime 与轨迹

每个实际 Provider attempt 生成唯一 `requestId`，同一决策共享 `decisionId`，attempt 从 1 开始；`model.request.started`、`model.request.failed`、`model.response.received` 通过相同关联字段落盘，started 事件同时携带不含正文/路径的 prepared hash 与估算元数据，供 trajectory/diagnostic 消费。Context compile 后、prepare 完成后和 feedback retry re-prepare 后均经过 Inbox barrier：若发生 pause/correction，prepared token 被丢弃且不产生请求；same-input retry 复用同一 prepared token，feedback retry 重新准备。Trajectory schema 对新字段和 Trace 做同步可选解析，旧事件仍可读。

## 变更文件

- `packages/context/src/compiler.ts`
- `packages/context/src/budget.ts`
- `packages/context/src/projections.ts`
- `packages/context/src/index.test.ts`
- `packages/protocol/src/index.ts`
- `packages/trajectory/src/index.ts`
- `packages/trajectory/src/index.test.ts`
- `packages/runtime/src/contracts.ts`
- `packages/runtime/src/run-controller.ts`
- `packages/runtime/src/index.test.ts`
- `packages/provider-glm/src/index.ts`
- `packages/provider-glm/src/index.test.ts`
- `packages/provider-qwen/src/index.ts`
- `packages/provider-qwen/src/index.test.ts`
- `packages/app-runtime/src/diagnostics/provider-summary.ts`
- `packages/app-runtime/src/diagnostics/provider-summary.test.ts`
- `packages/app-runtime/src/diagnostics/recording-clients.test.ts`

## 真实失败与修复证据

实施中首次编译发现 prepared estimate 的联合字面量被 TypeScript 推宽为 `string`，GLM build 报 `TS2322`；改为冻结并保留字面量类型后通过。随后按 fail-closed 要求补回 `generatePrepared` 的取消前置检查：准备成功后 signal 已取消时不调用 HTTP client，GLM/Qwen 回归均断言 post 次数不增加；原先观察底层 aborted signal 的测试同步改为验证零网络调用，避免为了保留旧观察行为而发起已取消请求。另补了“调用者在 prepare 后修改 tools/messages”反例，确保 parse 使用私有 input snapshot。

## 离线验证

本批使用隔离 Node 24 PATH，未运行真实 API/桌面/VM：

```text
pnpm --filter @computer-harness/protocol build
pnpm --filter @computer-harness/trajectory build
pnpm --filter @computer-harness/runtime build
pnpm --filter @computer-harness/context build
pnpm --filter @computer-harness/provider-glm build
pnpm --filter @computer-harness/provider-qwen build

pnpm exec vitest run packages/provider-glm/src/index.test.ts packages/provider-qwen/src/index.test.ts packages/runtime/src/index.test.ts
  GLM 18/18, Qwen 22/22, Runtime 58/58 passed

pnpm exec vitest run packages/context/src/index.test.ts packages/context/src/runtime-regression.test.ts packages/trajectory/src/index.test.ts packages/app-runtime/src/diagnostics/provider-summary.test.ts
  Context 18+1、Trajectory 33、provider summary 8 passed

pnpm run typecheck
  passed

此前 cache amendment 前的 `pnpm test`：33 files / 335 tests passed；本次 cache/estimate 修订按协调要求未重复全量，以上 focused 合计 159 tests。
```

定向复核后追加：

```text
pnpm exec vitest run packages/context/src/index.test.ts packages/context/src/runtime-regression.test.ts packages/trajectory/src/index.test.ts packages/app-runtime/src/diagnostics/provider-summary.test.ts packages/app-runtime/src/diagnostics/recording-clients.test.ts
  5 files / 66 tests passed
pnpm run typecheck
  passed
```

回归覆盖 prepared token 私有性/伪造拒绝、GLM/Qwen wire 仍由 adapter 发送、实际 wire estimate 不计 image base64、prepare 后取消零网络、prepare failure 无 `model.request.started`、调用者变更输入后的私有 snapshot、同输入重试复用、feedback 重试重准备、request/decision/attempt 关联、prepare 后 correction 屏障无发送、Trace 安全字段、Trace `selectedEventIds`（历史选择）与 `projectedEventIds`（实际 ModelInput/最新 image）区分、raw/recent 工具组/viewport/权威输入保持、Memory 软配额、Trace metadata 不计模型历史预算、Qwen cache 字段正常/缺失/非法、GLM recording 不误报 cache、Qwen recording 保留合法 cache、部分 cache 不伪造 Run 总量、历史完整组裁剪和旧 trajectory schema 兼容。

## 待后续批次与限制

- 本批没有实现缓存写入、命中策略或 TTL 统计；只保留 Qwen 真实 response 的逐次 `cacheReadTokens`，没有真实 usage 就保持 unknown。
- 本批没有实现完整 `InstructionState`/revision、跨 Run cache 生命周期、Memory scope/replay、Monitor、模型侧目标/Focus 合同或新的调度器。
- `PreparedRequestEstimate` 是基于实际 serialized body 的有界近似，不等于 Provider tokenizer；本批没有用它强制最终 Provider budget，也没有证明 stable prefix hash 与实际 Provider cache prefix 完全相同。GLM/Qwen 之外的 adapter 继续走原 `generate` 兼容路径，除非后续批次明确接入 prepared 合同。
- `payloadHash` 仅用于 adapter/runtime 内部关联与诊断，不应被解释为匿名化或安全凭证；实际请求 body 始终留在 adapter 私有状态。

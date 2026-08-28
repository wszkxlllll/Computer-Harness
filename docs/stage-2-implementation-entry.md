# Stage 2 实施 Agent 唯一入口

日期：2026-08-28

## 目的

实施 Agent 从本文件开始，不自行拼接 `docs/` 中所有历史材料。本文件只负责指定当前阶段的
必读资料、优先级和施工范围；详细协议仍以被引用文档为准，避免复制后再次产生多份不一致
设计。

## 必读文档与顺序

### 1. 当前门禁与最新修订

阅读：[`stage-2-s0-audit-and-gates.md`](./stage-2-s0-audit-and-gates.md)

它是当前最高优先级的施工依据，包含：

- 修复后代码审计结论；
- 进入 S2-2 前必须完成的 S2-1.1 两项协议收口；
- 当前 GUI 副作用和 `outcome_unknown` 语义；
- Abort 在 S2-2、S2-3、S2-4 的实施边界；
- 当前阶段的退出门槛。

### 2. Stage 2 施工顺序和测试矩阵

阅读：[`stage-1-exit-and-stage-2-implementation-plan.md`](./stage-1-exit-and-stage-2-implementation-plan.md)

重点阅读第 5—14 节。它定义：

- RunController 最小公开接口；
- `commitEvent` 唯一提交路径；
- 每 Run Inbox 和安全边界；
- 完整 Run Loop；
- FakeProvider/FakeComputer；
- S2-2、S2-3、S2-4 的测试矩阵和退出门槛。

若其中内容与最新审计冲突，以 `stage-2-s0-audit-and-gates.md` 为准。

### 3. 核心架构合同

按需阅读：[`gui-agent-harness-v1-technical-plan.md`](./gui-agent-harness-v1-technical-plan.md)

本阶段只需阅读这些部分：

- 第五节：核心协议对象；
- 第七节：Tool Registry 与两层 Tool/Action 语义；
- 第八节：Computer 接口；
- 第十节：RunController 与 Agent Loop；
- 第十二、十三节：RuntimeEvent、Trajectory 和 RunSnapshot；
- 第十六节：取消、暂停和资源清理。

它解释长期架构边界，但不能覆盖最新门禁中已经收紧的实现决定。

## 当前不要求实施 Agent 阅读的文档

- `multimodal-gui-agent-harness-product-plan.md`：产品定位与长期方向，不作为当前代码施工合同；
- `run-turn-tool-and-user-correction-semantics.md`：到 S2-3 实现用户纠正和命令 Inbox 时再读；
- `stage-0-*`：历史调研和底层 CUA 探针依据，当前 S2-1.1/S2-2 不需要；
- LightSpeaker/OpenClaw 旧实验文档：不属于当前 Harness Runtime 施工输入。

## 当前立即执行的工作

### A. S2-1.1 小型协议收口

只做两项：

1. `action.proposed` 增加 `callId: ToolCallId`，但不把 `callId` 塞入
   `ActionIntent`；
2. 执行前拒绝只走 `tool.call.rejected`，`tool.call.failed` 的磁盘 Event 只允许
   `status: "failed"`。

同步更新 Protocol、Zod、fixture 和针对性测试。不要在本提交创建 Runtime 包。

文档同时把未知副作用路径统一为：可 best-effort Observe，但 V1 最终以
`run.finished(outcome_unknown)` 收口；不提前实现用户 reconciliation 状态机。

验收：

```text
pnpm run typecheck
pnpm test
```

### B. S2-2 Runtime 骨架

S2-1.1 通过后：

- 创建单一 `packages/runtime`；
- 实现最小 RunController、`commitEvent`、ToolRegistry、Policy 和 ContextCompiler；
- 用 FakeProvider/FakeComputer 跑通无外部命令 happy path；
- 每个 Run 从第一版创建根 `AbortController`，并把 signal 传给 Provider/Computer；
- 只检查安全边界，不在本阶段实现完整 cancel 竞态和命令 Inbox。

S2-2 退出门槛：一条 Fake Run 完整落盘，磁盘 read/reduce 得到的 Snapshot 与在线 Snapshot
一致。

## Abort 的一句话规则

不设计同步和异步两套 Abort：`cancel()` 同步发出根 signal，异步调用协作停止，Run 再在安全
边界落盘并结束。Event append 和 Asset 原子发布一旦开始就让其完成；GUI Action 已 started 后
只能依据 Driver 证据判断 `cancelled`，证据不足时必须结束为 `outcome_unknown`。

完整取消竞态在 S2-3，实现故障注入和未知副作用门禁在 S2-4；当前不实现后台 Job Abort。

## 文档冲突优先级

发生冲突时按以下顺序处理：

1. 用户当前明确要求；
2. `stage-2-s0-audit-and-gates.md` 的最新复审；
3. `stage-1-exit-and-stage-2-implementation-plan.md`；
4. `gui-agent-harness-v1-technical-plan.md`；
5. 产品计划和历史审计。

不要通过同时兼容多份旧语义解决冲突；先按上述优先级选择唯一当前语义，再更新过时文档。

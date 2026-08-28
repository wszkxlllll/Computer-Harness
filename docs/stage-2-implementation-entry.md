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

## 当前阶段新增必读

- [`run-turn-tool-and-user-correction-semantics.md`](./run-turn-tool-and-user-correction-semantics.md)：
  S2-3 实施时使用，用作用户纠正、等待态和命令 Inbox 的控制语义补充。

## 当前不要求实施 Agent 阅读的文档

- `multimodal-gui-agent-harness-product-plan.md`：产品定位与长期方向，不作为当前代码施工合同；
- `stage-0-*`：历史调研和底层 CUA 探针依据，当前 S2-2a/S2-3 不需要；
- LightSpeaker/OpenClaw 旧实验文档：不属于当前 Harness Runtime 施工输入。

## 当前代码状态

S2-1.1、S2-2 happy path、S2-2a 和 S2-3 已经实现：Protocol 关联已收口，`packages/runtime`
已拆为少量职责文件，Fake Run 可以完成落盘和重放，命令 Inbox 与控制语义已经接入。不要重复
实现或回退这些提交。

最新独立审计结果与本轮实施记录以 `stage-2-s0-audit-and-gates.md` 最后一节为准。

## 本轮已完成的工作

### A. S2-2a Runtime 安全加固（已完成）

1. 同一 ModelTurn 的所有 ToolCall 完成 Registry、参数、Policy 和 GUI 数量预检后，才能
   执行任何副作用；
2. Provider 返回后和 `action.execution.started` 前补齐 Abort 安全检查；
3. `commitEvent` 以 Writer 实际返回的 persisted Event 更新在线 Snapshot；
4. 增加非法混合 Turn、started 前 cancel、在线/磁盘 Snapshot 相等的针对性测试。

本轮 Tool 预检的责任边界：

- Runtime 负责 Tool 是否注册、`ToolCallId` 非空且本 Turn 内不重复、整组 Policy 决策、审批
  分流，以及 Computer 类 Tool 数量不超过一个；这些不是具体 Tool 重复实现的规则。
- 每个 `ToolDefinition` 负责自身参数的领域校验。当前 `inputSchema` 主要用于向模型描述输入，
  不能替代运行时 `validate`；后续加入真实 Tool 时再为该 Tool 提供对应校验，不提前建立通用
  Schema 框架。
- Computer Tool 的 `toAction` 只做无副作用转换；只有 Runtime 写入
  `action.execution.started` 后，Computer Adapter 才能执行真实 GUI 副作用。
- 具体 Tool、真实 Policy 和完整审批等待流程分别在其对应阶段实现；S2-2a 只把通用预检顺序和
  阻断边界做正确。

验收：

```text
pnpm run typecheck
pnpm test
```

### B. Runtime 包内机械拆分（已完成）

S2-2a 通过后，在仍然只有一个 `packages/runtime` 的前提下，把当前单个大文件拆成少量职责文件：

```text
contracts.ts
tool-registry.ts
defaults.ts
run-controller.ts
index.ts（public exports）
```

这是纯移动提交，不改变公共行为，不创建独立 context/tools/providers package。真实 Provider 和
CUA Adapter 仍分别属于后续 Stage 4 和 Stage 3。

### C. S2-3 Inbox 与控制语义（已完成）

完成 A/B 后，阅读
[`run-turn-tool-and-user-correction-semantics.md`](./run-turn-tool-and-user-correction-semantics.md)，
再实现：

- 每 Run 单消费者 Inbox；
- `submitUserInput`、`resolveApproval`、`pause`、`resume`；
- started 前/后用户纠正的不同语义；
- 完整 cancel 等待态和竞态；
- finished 后命令拒绝。

仍不接入真实 Provider、真实 CUA、后台 Job 或 Dashboard。

## 当前已完成的工作

### D. S2-4 故障注入与退出审计（已完成）

只围绕已有协议和 Runtime 验证：

- Event append、Asset 写入、Provider、Computer open/observe/execute/close 的失败注入；
- started 后 terminal Event 写失败时停止且不重试 GUI Action；
- Driver 能证明未发生副作用的 cancelled 与结果未知的 `outcome_unknown` 分流；
- 从 JSONL 重放恢复 `unresolvedActionId`，并再次核对在线/磁盘 Snapshot；
- 更新本入口和审计文档的实际测试命令、覆盖范围与剩余限制。

本阶段仍不接入真实 Provider/CUA、后台 Job、Verifier、Dashboard 或新的公共事件/API；这些
属于后续 Stage 3/4 的独立施工范围。

## 下一步

进入 Stage 3 CUA Adapter 前，先以本文件和
[`stage-2-s0-audit-and-gates.md`](./stage-2-s0-audit-and-gates.md) 的实际结果为基线，另立
Stage 3 施工入口。Stage 3 只负责把一个真实 Computer Backend 接到现有 `Computer` 接口，
并验证 Observation、Action、Frame 绑定、坐标空间和 Driver 生命周期；不回头把真实 CUA、
Provider、Dashboard 或验证器混进 Stage 2 Runtime。

## Event 当前实现决定

RuntimeEvent 当前以 JSONL Writer 为权威事实，以纯 Reducer 投影 Snapshot；它不是
AsyncGenerator。S2-3 的命令 Inbox 也不与 Event 输出混为一个队列。

当前没有 CLI/UI 实时订阅消费者，因此不新增公共 EventBus 或 AsyncIterable。等首次出现实时
消费者时，再选择 listener 或每订阅者独立队列的 AsyncIterable；实时通知只能在 Event 落盘并
更新 Snapshot 后发布，不能替代 JSONL、阻塞 Agent 主循环或破坏历史重放。

## Abort 的一句话规则

不设计同步和异步两套 Abort：`cancel()` 同步发出根 signal，异步调用协作停止，Run 再在安全
边界落盘并结束。Event append 和 Asset 原子发布一旦开始就让其完成；GUI Action 已 started 后
只能依据 Driver 证据判断 `cancelled`，证据不足时必须结束为 `outcome_unknown`。

完整取消竞态和故障注入门禁已在 S2-3/S2-4 完成；当前不实现后台 Job Abort。

## 文档冲突优先级

发生冲突时按以下顺序处理：

1. 用户当前明确要求；
2. `stage-2-s0-audit-and-gates.md` 的最新复审；
3. `stage-1-exit-and-stage-2-implementation-plan.md`；
4. `gui-agent-harness-v1-technical-plan.md`；
5. 产品计划和历史审计。

不要通过同时兼容多份旧语义解决冲突；先按上述优先级选择唯一当前语义，再更新过时文档。

# Run、ModelTurn、Tool、Action 与用户纠正语义

日期：2026-09-15
文档角色：全局语义合同
状态：当前有效
当前入口：[Stage 6 收敛与下一阶段起始状态](../../stage-6-convergence-and-start-state-2026-09-15.md)

## 1. 核心关系

- 一个 `Run` 对应一个用户目标从创建到结束的完整执行；
- 一个 Run 通常包含多个 `ModelTurn`；
- ModelTurn 是一次模型调用产生的结构化决定，不是完整 Run；
- 模型通过 `ToolCall` 请求 Computer、Planning、Memory 等能力；
- 只有 Computer ToolCall 转换成 `ActionIntent`；
- `finish` 和 `user_input_required` 是 ModelTurn 分支，由 Control Tool 在 Provider 边界映射，不作为普通 ToolCall 执行；
- 当前工具在 Agent 语义上都是阻塞执行，没有后台 Job；
- 多个 ToolCall 在同一 ModelTurn 中仍由 Runtime 按顺序处理，不代表并发执行。

```text
Run
 ├─ ModelTurn 1
 │    ├─ Planning/Memory 写入
 │    └─ Computer Action 或受限 Batch
 ├─ Observation / Receipt
 ├─ ModelTurn 2
 ├─ 用户回答、纠正或审批
 └─ run.finished
```

当前不建立公共 `Step` 对象。步骤数、模型轮次和动作数都从 RuntimeEvent 投影，避免第二套事实源。

## 2. ModelTurn

```ts
type ModelTurn =
  | {
      type: "tool_calls";
      calls: ToolCall[];
      assistantText?: string;
      continuation?: ModelContinuation;
      usage?: ModelUsage;
    }
  | {
      type: "user_input_required";
      question: string;
      usage?: ModelUsage;
    }
  | {
      type: "finish";
      summary: string;
      reportedStatus?: "success" | "failure";
      usage?: ModelUsage;
    };
```

Provider Adapter 负责把原生 Function Calling、strict JSON、reasoning continuation 和 usage 转换为该结构。Runtime 不读取 Provider 私有响应。

## 3. ToolCall 的四类语义

```text
ToolCall
  ├─ Computer → ActionIntent → Computer.execute()
  ├─ Planning → Plan mutation → planning.task.updated
  ├─ Side
  │    └─ Run Memory → Memory mutation → memory.updated
  └─ Control → finish / user_input_required
```

ToolRegistry 是唯一注册和模型投影入口。Provider 不维护工具副本；Computer 不理解 Planning/Memory 业务语义。

当前 Control 工具有 `terminate` 和 `interact`。它们分别映射为 finish 和 user_input_required，必须独占一个模型响应，不能与任何状态写入或 GUI Action 混用。

## 4. 同一 ModelTurn 的多个调用

Runtime 允许三种有效形态。

### 4.1 纯状态调用

一个 ModelTurn 可以返回多个 Planning/Memory 调用。它们按数组顺序执行，每个调用独立校验、落 Tool Event、提交 mutation 并返回 ToolResult。后一个调用不能在同一 ModelTurn 中读取前一个调用刚产生的 ToolResult，因此需要结果的 read/update 必须等待下一轮。

### 4.2 单 GUI Action

Batch 关闭时，一个 ModelTurn 最多包含一个 Computer ToolCall。Runtime 将其转换为 ActionIntent，执行并自动重新观察。

### 4.3 Composite Turn 与受限 Batch

Batch 开启时，一个 ModelTurn 可以表达：

```text
[最多两个 Planning/Memory 写调用]
                 ↓
[一个 Computer Action 或一个受限 GUI Batch]
```

GUI Batch 仅允许以下调用形状：

```text
click → type
Ctrl+A → type
click → Ctrl+A → type
```

约束：

- Planning/Memory 读取不能作为 GUI 前缀；
- 状态写入不能出现在 GUI 动作之后或之间；
- Control 不能混用；
- Enter、Tab、提交、导航、scroll、drag、wait 不进入 Batch；
- 每个 primitive 都独立校验、预算、落 Event、执行、产生 Receipt 和重新观察；
- 决策 Observation 保留，同时每一步使用最新执行 Observation；
- 失败、拒绝、Abort、session/viewport 失效或动作后采图失败立即停止剩余后缀；
- 未知副作用不重试。

Batch 只减少模型 round trip，不减少执行观察和审计粒度。Runtime 当前没有 element identity，只能验证序列、参数、capability、viewport 和 Observation 新鲜度；它不能确定性证明 click 与 type 落在同一语义控件，该条件仍由模型协议和受控实验承担。

## 5. Approval

模型不能自行批准高风险操作。RuntimePolicy 对 ToolCall 的判断为：

```ts
type ToolPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "require_approval"; reason: string };
```

需要审批时：

```text
approval.requested
  → RunStatus = waiting_approval
  → 外部调用 resolveApproval(requestId, approved)
  → approval.resolved
  → 执行或拒绝原 ToolCall
```

Approval 不能与普通用户回答合并。若一个 ModelTurn 含多个调用，要求审批的调用不能与其他调用一起执行。

## 6. 模型询问用户

模型缺少必要信息时返回 `user_input_required`：

```text
user.input.requested
  → RunStatus = waiting_user
  → submitUserInput(text)
  → user.input.received
  → RunStatus = running
  → 下一轮 Context 消费回答
```

当前一个 Run 同时只等待一个问题。

## 7. 用户过程纠正

用户可以在同一个 Run 中通过 `submitUserInput(text)` 提交新指令。纠正不会修改旧 Event、旧 Prompt 或已经发生的动作。

### 模型请求期间到达

Runtime 记录纠正并避免执行基于旧上下文返回的 ModelTurn；下一轮重新编译 Context。

### ModelTurn 已返回但未执行

待消费 ModelTurn 被标记失效，对其中 ToolCall 记录拒绝，不产生 GUI 副作用。

### GUI 动作已经 started

不能假设动作被取消或没有发生。Runtime 等待 terminal Receipt；如果结果未知，以 `outcome_unknown` 收口而不自动重试。完成后重新观察，再把纠正交给模型。

Planning 不会被 Runtime 擅自改写。模型看到纠正后可调用 task_update；Planning 关闭时 Run 仍可继续。

## 8. Abort、暂停与恢复

- Pause 只在安全边界阻止下一步继续执行；
- Resume 恢复同一个 Run，不伪造新 Session；
- Abort 通过 AbortSignal 传播到 Provider、Computer 和当前等待；
- GUI 副作用开始后的 Abort 必须等待 Adapter 给出 terminal Receipt；无法确认时不得写成安全取消；
- Run 结束后不能再提交用户输入、审批或恢复命令。

暂停、用户询问和审批是不同状态，不能互相绕过。

## 9. Event-first 副作用语义

```text
tool.call.received
  → action.proposed
  → Runtime validation / policy / budget
  → action.execution.started（先持久化）
  → Computer.execute()
  → action.execution.completed 或 action.execution.failed
  → tool.call.completed 或 tool.call.failed
  → observation.created
```

如果 `started` 已存在但没有 terminal Action Event，恢复逻辑只能重新观察或请求人工判断，不能重放原动作。

## 10. 同步、异步与未来后台 Job

Provider、Computer 和 Tool Executor 使用 Promise，但当前 Run 会等待结果，因此在 Agent 语义上仍是阻塞调用。

真正后台 Job 需要：

- JobId、JobState、JobStore；
- progress/completed/failed/cancelled Event；
- wait/status/cancel 工具；
- Run 结束时的 ownership 与清理；
- Context 对相关 Job 更新的选择；
- 明确的并发和副作用策略。

目前没有真实后台工具消费者，因此不在 ToolDefinition 中提前加入 background 字段。未来应由 ToolRegistry/Runtime 管理 Job；Provider 只看到 ContextCompiler 投影的状态。

## 11. 完整 Run 示例

```text
run.created
run.started
computer.open.started
computer.open.completed
observation.created

model.request.started
model.response.received(tool_calls)
tool.call.received
action.proposed
action.execution.started
action.execution.completed
tool.call.completed
observation.created

model.request.started
model.response.received(user_input_required)
user.input.requested
user.input.received

model.request.started
model.response.received(finish)
run.finished
```

这仍是一个 Run，只是包含多个 ModelTurn、一次 GUI 副作用和一次用户交互。

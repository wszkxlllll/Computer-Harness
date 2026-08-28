# Run、ModelTurn、Tool、Action 与用户纠正语义

日期：2026-08-28  
状态：V1 设计说明，供 Stage 1/2 执行 Agent 使用

## 1. 核心结论

- 一个 `Run` 对应一次用户目标从开始到结束的完整执行；
- 一个 `Run` 通常包含多个 `ModelTurn`；
- `ModelTurn` 是一次模型调用返回的结构化决定，不是完整 Run；
- 模型要执行 Computer、Planning 或其他能力时，通过 `ToolCall` 表达；
- 只有 Computer Tool 会继续转换成 `ActionIntent`；
- 用户询问和 `finish` 是 `ModelTurn` 的独立分支，不是 GUI Action；
- V1 的工具在 Agent 语义上全部阻塞，不实现后台 Job；
- 用户过程纠正通过 `RunController` 的外部输入通道进入同一个 Run，不伪装成 ToolCall。

## 2. Run 与 ModelTurn 的关系

例如用户要求：

```text
打开记事本，输入会议安排，然后保存文件。
```

这是一整个 Run。它可能包含：

```text
Run 开始
  ↓
ModelTurn 1：点击记事本
  ↓
ModelTurn 2：在编辑区输入文字
  ↓
用户纠正：先不要保存，补充会议地点
  ↓
ModelTurn 3：继续输入地点
  ↓
ModelTurn 4：点击保存
  ↓
ModelTurn 5：finish
  ↓
Run 结束
```

因此：

```text
Run ≠ ModelTurn
Run = 多个 ModelTurn + Tool 执行 + Observation + 用户输入 + RuntimeEvent
```

当前不需要在公共协议中新增一个 `Step` 对象。CLI 或 UI 若需要展示“第几步”，可以
根据 Event 和 ModelTurn 投影得到，避免产生第二套事实来源。

## 3. “模型决定做动作”是否等于调用工具

在当前设计中，是通过 ToolCall 表达，但 ToolCall 不一定是 GUI 动作。

```text
ModelTurn.tool_calls
        │
        ├─ Computer Tool
        │      ↓
        │  ActionIntent
        │      ↓
        │  Computer.execute()
        │
        ├─ Planning Tool
        │      ↓
        │  PlanningService
        │
        ├─ Control Tool
        │      ↓
        │  RunController / RuntimePolicy
        │
        └─ Side Tool
               ↓
           对应 ToolExecutor
```

例子：

```text
click(...)       → GUI Action
type(...)        → GUI Action
task_update(...) → Planning 状态更新，不是 GUI Action
```

所以准确表述是：

> 模型通过 ToolCall 请求系统执行能力；只有 Computer 类 ToolCall 会变成
> ActionIntent。

当前 V1 的主要工具是 Computer Tool 和可选 Planning Tool。Control/Side 类别保留在
既定路由中，但只在出现真实调用者时实现具体工具。

模型返回：

```ts
{ type: "user_input_required", question: "..." }
```

或：

```ts
{ type: "finish", summary: "..." }
```

不属于工具调用，也不转换成 ActionIntent。

## 4. 当前是否设计了异步后台工具

没有，且 V1 暂时不应加入。

这里要区分两种“异步”：

### 4.1 JavaScript 异步 API

Provider 和 Computer 方法返回 `Promise`，实现上是异步 I/O，但 Run 会等待结果后才
进入下一轮。这在 Agent 语义上仍是阻塞调用。

### 4.2 Agent 后台 Job

真正的后台工具意味着：

```text
ToolCall
  ↓
立即返回 JobId
  ↓
Run 可以继续其他 Turn
  ↓
Job 后续产生 progress/completed/failed
```

它至少需要 JobId、状态查询、等待、取消、持久化、完成事件和 Run 结束时的处理策略。
当前没有真实后台工具消费者，因此不在 `ToolDefinition` 中加入 background 字段。

未来第一个后台工具出现时，合适的接入位置是：

- `ToolRegistry/ToolExecutor` 创建和管理 Job；
- `RuntimeEvent` 记录 Job 生命周期；
- `RunSnapshot` 投影当前 Job 状态；
- `ContextCompiler` 选择与当前任务相关的 Job 更新进入后续模型上下文；
- `ProviderAdapter` 只接收编译后的上下文，不负责轮询 Job。

这套位置已经由现有边界自然留出，但 V1 不提前实现协议。

## 5. 模型主动询问用户

当模型缺少必要信息时返回：

```ts
{
  type: "user_input_required",
  question: "文件应该保存到哪里？"
}
```

Runtime 应执行：

```text
append user.input.requested
        ↓
RunStatus = waiting_user
        ↓
CLI / SDK 展示问题并等待用户
        ↓
收到回答，append user.input.received
        ↓
RunStatus = running
        ↓
ContextCompiler 将回答放入下一轮 ModelInput
```

当前 Stage 1 已补齐 `user.input.requested`、`user.input.received` 事件和
`RunSnapshot.pendingUserQuestion` 投影；真正从 CLI/SDK 接收输入并驱动下一轮模型的
`RunController.submitUserInput(text)` 仍属于 Stage 2。

V1 只允许一个 Run 同时等待一个用户问题，因此暂不需要问题队列或复杂关联 ID。

## 6. 用户主动进行过程纠正

用户过程纠正不是模型工具，也不应修改旧 Event 或旧 Prompt。合适入口是：

```text
CLI / SDK / future Web UI
          ↓
RunController.submitUserInput(text)
          ↓
append user.input.received
          ↓
ContextCompiler 在下一轮加入这条新指令
```

例如：

```text
用户初始目标：把报告保存到桌面。
执行中纠正：不要保存到桌面，改到 Documents。
```

旧目标和已经发生的动作继续保留在 Trajectory 中；新纠正作为后来的事实进入同一个
Run。模型下一轮能同时看到原始目标、当前 Observation 和最新纠正，从而调整计划。

PlanningTask 不由 Runtime 擅自重写。模型收到纠正后，可以调用 `task_update` 修改计划；
即使 Planning 没有启用，Run 也能依靠用户输入和当前 Observation 继续。

## 7. 纠正到达时的安全边界

用户纠正的处理取决于当前执行位置：

### 7.1 模型尚未产生 GUI 副作用

- 记录用户输入；
- 可以取消当前 Provider 请求或丢弃其尚未执行的旧 ToolCall；
- 用新纠正重新编译下一轮 Context。

### 7.2 GUI 动作已经 started

- 不能假设动作被取消或没有发生；
- 等待 Driver 返回 terminal receipt；
- 若结果未知，保留 `outcome_unknown`；
- 重新 Observe；
- 再把用户纠正交给下一轮模型。

因此用户纠正可以改变未来计划，但不能改写已经发生或结果未知的 GUI 副作用。

V1 可以先把纠正应用在安全的 Turn 边界，不要求实现任意机器指令级抢占。

## 8. 用户回答、过程纠正和审批的区别

| 输入 | 入口 | 作用 |
|---|---|---|
| 回答模型问题 | `submitUserInput` | 从 `waiting_user` 恢复 Run |
| 主动过程纠正 | `submitUserInput` | 更新下一轮模型上下文 |
| 批准/拒绝风险动作 | `resolveApproval` | 解决 RuntimePolicy 产生的审批 |
| 暂停/继续/取消 | Run 控制命令 | 改变 Run 生命周期 |

审批不能混入普通文字回答，否则 Runtime 无法确定一个高风险动作是否真正获得授权。

## 9. 一个完整 Run 的最小例子

```text
run.created
run.started
computer.open.started
computer.open.completed
observation.created

model.request.started
model.response.received(tool_calls: click)
tool.call.received
action.proposed
action.execution.started
action.execution.completed
observation.created

model.request.started
model.response.received(user_input_required)
user.input.requested

user.input.received

model.request.started
model.response.received(tool_calls: type)
action.execution.started
action.execution.completed
observation.created

model.request.started
model.response.received(finish)
run.finished
```

这是一个 Run，但包含四次 ModelTurn。等待用户时 Run 没有结束，只是进入
`waiting_user`。

## 10. 对执行阶段的要求

Stage 1/2 应补齐：

1. `user.input.requested` 与 `user.input.received` RuntimeEvent；
2. `RunSnapshot.pendingUserQuestion`；
3. requested → `waiting_user`、received → `running` 的 reducer 测试；
4. `RunController.submitUserInput(text)` 的单一入口；
5. 下一轮 `ContextCompiler` 必须消费最新用户输入；
6. started GUI 副作用期间收到纠正时，不得自动重试、撤销或覆盖旧事实。

本轮不增加：

- 后台 Job；
- JobStore/JobManager；
- 多问题队列；
- 任意时刻的强制 GUI 动作中断；
- 用户纠正自动重写 PlanningTask；
- 新的公共 `Step` 协议对象。

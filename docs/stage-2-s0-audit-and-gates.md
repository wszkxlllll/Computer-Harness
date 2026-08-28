# Stage 2 开工前审计与 S2-0/S2-1/S2-2 结果

日期：2026-08-28

## 结论

`stage-1-exit-and-stage-2-implementation-plan.md` 的总体顺序正确：先把持久化和状态机的
并发边界收口，再实现 `RunController`。前一轮只完成 S2-0，没有创建 Runtime 包，也没有
接入真实 Provider 或 CUA；随后完成了 S2-1 协议收口和 S2-2 Fake Runtime 骨架，仍未接入
真实 Provider 或 CUA。

2026-08-28 复审结论：**S2-0、S2-1.1 和 S2-2 骨架均已通过当前阶段的代码门槛。**
S2-2 已完成最小 Fake Run 落盘与重放；完整命令 Inbox、用户纠正和取消竞态仍属于 S2-3，
真实 Provider/CUA 仍不在本阶段范围内。

## S2-0/S2-1 已完成的部分

- `JsonlRunEventWriter` 使用 `open → closing → closed` 状态。`close()` 进入 `closing` 的
  同步时刻就是禁止新 append 的线性化边界；已经排队的写入会完成，多个 close 调用共享同一
  个关闭过程。
- `RunSnapshot` 记录 `createdAt`，Reducer 要求 `run.created` 是第一个生命周期事实，
  `run.started`、暂停/继续、等待用户和审批均有明确前置状态；`finished` 后不能再接受改变
  状态的事件。
- 用户回答在 `waiting_user` 时恢复运行，在 `running` 时表示主动纠正，在 `paused` 时保持
  暂停；审批等待中不能用普通用户输入绕过审批。
- `observation.created` 的嵌套 `observation.runId` 必须与外层事件一致。
- `action.execution.completed` 只能携带 `completed` Receipt；`action.execution.failed` 只
  能携带 `refused`、`failed` 或可证明未产生副作用的 `cancelled` Receipt。未决动作只有在
  `run.finished(outcome_unknown)` 时才能结束，并保留 `unresolvedActionId`。
- `approval.requested` 已携带 `callId`，Snapshot 也保存该关联；Zod 入口和 Reducer 都有
  相应校验。
- Protocol 的 `RuntimeEventType` 由 `RuntimeEventData["type"]` 派生，并提供完整事件清单；
  测试会检查清单与 Zod discriminator 的一致性。
- `ToolResult`、JSON-safe Tool 参数以及 `tool.call.completed/failed` 已进入 Protocol 和磁盘
  Schema；成功、失败和拒绝结果保持不同结构。
- `action.proposed` 事件现在显式携带原始 `ToolCallId`；执行前拒绝只写
  `tool.call.rejected`，`tool.call.failed` 的磁盘结果只允许 `status: "failed"`。公共
  `ToolResult.status = "rejected"` 由 Context 层从 rejected Event 转换，不再重复落盘。
- `ObservationCapture` 已作为 Driver 原始输出与落盘 `ObservationFrame` 之间的边界类型加入
  Protocol，不写入 Trajectory。
- `computer.open.started/completed` 已投影为当前 ComputerSession；Observation 必须属于
  当前 Session。
- 非 `wait` GUI Action 的 `basedOn` 必须等于当前 `latestObservationId`；未决副作用只能以
  `run.finished(outcome_unknown)` 收口，并保留 `unresolvedActionId`。
- 删除了没有 Event 生产者的 `finishing` 状态；结束清理由 Controller 的安全边界完成，不再
  让 Snapshot 出现无法重放的隐含状态。

## 并发边界（进入 S2-2 必须保持）

```text
外部命令（user / approval / pause / resume）
                    │
                    ▼
             每个 Run 一个 Inbox
                    │  单一消费者：RunController 主循环
                    ▼
          唯一 commitEvent 提交路径
                    │
                    ▼
          EventWriter 自己的串行写队列
```

Inbox 不是动作队列，也不替代 EventWriter；GUI 动作不能从外部直接注入。Controller 只能在
安全边界消费命令，并且必须先 append Event、再 reduce Snapshot，不能先改内存状态再写磁盘。

## S2-2 实现约束与已验证内容

1. **审批与 ToolCall 的存在性**：`callId` 解决了数据关联，但 Reducer 单独看一个事件无法
   证明该调用曾经收到。Runtime Controller 已维护本 Run 的已接收 ToolCall 视图和
   `ActionId → ToolCallId` 关联；后续 S2-3 的审批仍必须拒绝引用不存在或已结束的调用，且
   不在 Snapshot 中提前加入通用调用表。
2. **未知副作用的收口**：只有 `run.finished(outcome_unknown)` 可以在 unresolved Action 存在
   时结束 Run，并且必须保留 `unresolvedActionId`；其他 outcome 继续拒绝。Controller 不得
   自动重试，也不得把未知结果伪装为 cancelled。
3. **唯一提交路径**：Controller 只能先用 Reducer 做纯转换校验，再 append Event，append
   成功后再更新在线 Snapshot；Inbox 与 EventWriter 队列必须保持两层分离。
4. **字段级 Schema 漂移**：当前测试已覆盖每种 RuntimeEvent 的最小合法 round-trip；新增
   字段时必须同时更新 Protocol、Zod 和 fixture，不能只扩字符串 discriminator。

5. **S2-2 最小 Runtime**：`packages/runtime` 已提供 Provider、Computer、ContextCompiler、
   ToolRegistry、默认 Policy 和 RunController。Fake happy path 已覆盖初始 Observe、模型
   Turn、单个 GUI Action、动作后 Observe、ToolResult、finish、落盘和 read/reduce 重放；非
   GUI Tool 只产生 ToolResult，不生成 ActionIntent；一轮多个 GUI ToolCall 会整组拒绝。
6. **根 AbortSignal**：S2-2 已从每个 Controller 创建根 signal，并传给 Provider、Computer
   `open/observe/execute`；`cancel()` 只发出取消信号，完整等待态和竞态语义留到 S2-3。

## 复审中实际复现、现已关闭的缺口

在提交 `186eb60` 的初始实现上，以下轨迹曾被 Reducer 接受；本轮均已增加失败断言并修复：

```text
run.created
→ run.started
→ computer.open.completed       # 缺少 computer.open.started
→ observation.created
```

```text
run.created
→ model.request.started         # Run 尚未 started/running
```

```text
latestObservationId = o1
→ action.execution.started(basedOn = old)
```

三种都已被拒绝。责任边界保持为：

- Reducer 检查能由当前 Snapshot 表达的生命周期、Session、Observation、Action 和等待态
  不变量；
- RunController 的本 Run 内部视图检查 Model request、ToolCall 和审批对象的细粒度配对；
- 不能笼统声称 Reducer 已经是所有 RuntimeEvent 的完整自动机。

## 本轮验证

```text
pnpm run typecheck   通过
pnpm test            通过（2 个测试文件，32 项）
```

覆盖了 Writer close/append 竞态、并发 close、终态不可重开、用户/审批互斥、ComputerSession
与 Observation 归属、Action 与最新 Observation 绑定、Receipt/Event 状态一致性、ToolResult
和 JSON-safe 参数、Protocol/Zod 事件清单及每类事件的字段级 round-trip。

复审重新运行命令后为 32 项通过（trajectory 27 项、runtime 5 项），新增协议反例和 Fake
Run 断言均有覆盖。本文件状态为“S2-2 骨架通过，允许进入 S2-3”，但不代表真实 Provider
或 CUA 已验证。

## 下一步

下一步进入 S2-3：在现有单一 Runtime 包上加入每 Run Inbox、用户回答/纠正、审批、pause/resume
和完整 cancel 竞态；继续保持唯一 `commitEvent`，不把真实模型或桌面故障混入 Runtime 契约
测试。S2-2 已完成的 Fake 骨架和协议提交不要回退或重写。

---

## 2026-08-28 修复后独立复审

### 1. 实际检查结果

本次以提交 `3b39463 feat: close stage 2 runtime admission gaps` 为基线，工作区检查时干净。
实际重新运行：

```text
pnpm run typecheck   通过
pnpm test            通过（1 个测试文件，27 项）
```

代码与本文件所述修复基本一致：

- Writer 的 `open → closing → closed` 关闭边界真实存在；
- `computer.open.completed` 不能跳过 started，Observation 不能跨 ComputerSession；
- Run 未进入 running 前不能提交模型、Tool 或 Action 事实；
- 非 wait GUI Action 必须绑定最新 Observation；
- 未决 Action 只能用 `run.finished(outcome_unknown)` 收口，且投影保留
  `unresolvedActionId`；
- `ActionReceipt` 已不再把 `outcome_unknown` 伪装成动作终态；
- `JsonValue`、`ToolResult`、`ObservationCapture` 和事件字段级 round-trip 已落到代码和测试。

因此，上一轮发现的三个直接反例已经关闭，当前没有理由回退或重写 Stage 1。

### 2. S2-1.1：进入主循环前补齐的两个小型协议缺口

#### 2.1 显式记录 `ToolCall → ActionIntent` 关联

`action.proposed` 现在与 `tool.call.received` 通过事件上的 `ToolCallId` 显式关联。Trajectory
可以直接回答“这个 Action 是哪一个 Computer ToolCall 转换出来的”，同时不把编排字段污染到
Computer 层的 `ActionIntent`。

实际采用只修改事件、不污染 Computer 层 `ActionIntent` 的方案：

```ts
| {
    type: "action.proposed";
    callId: ToolCallId;
    action: ActionIntent;
  }
```

`ActionIntent` 仍只表达 GUI 意图及其 Observation 依据；`callId` 属于 Runtime 编排来源，放在
Event 上最合适。Protocol、Zod、fixture 和测试已同步更新；Controller 还维护以下运行时断言：

- `callId` 必须引用本 Run 已收到且尚未终结的 Computer ToolCall；
- 同一个 ToolCall 最多产生一个 `action.proposed`；
- `action.execution.started` 必须匹配已 proposed 的 `actionId`；
- 最终 ToolResult 必须返回原 `callId`。

这些关联校验由 S2-2 Controller 的本 Run 视图完成，不必把通用 ToolCall 表塞进
`RunSnapshot`。

#### 2.2 拒绝类 Tool Event 只保留一条权威路径

此前同时存在：

```text
tool.call.rejected
tool.call.failed(result.status = rejected)
```

这允许同一件“执行前被拒绝”以两种终态落盘，S2-2 很容易重复写或在 Context 中重复回传。
现在固定为：

- Schema/Policy/Turn 级执行前拒绝：只写 `tool.call.rejected`；
- Tool 真正开始执行后的错误：只写 `tool.call.failed`，其磁盘 Event 中的
  `result.status` 收窄为 `failed`；
- `ToolResult` 公共类型仍保留 `rejected`，由 ContextCompiler 将
  `tool.call.rejected` 转成给模型的结构化 rejected result。

这是一处已完成的窄协议修正：没有删除 `tool.call.rejected`，也没有新增 Event。

### 3. 一个文档与当前 Reducer 的语义差异

技术计划曾写到：未知 GUI 副作用可以重新 Observe，无法确认时“暂停并请求用户处理”。当前
Reducer 明确禁止在 `unresolvedActionId` 存在时进入 `run.paused` 或
`user.input.requested`，只允许以 `run.finished(outcome_unknown)` 收口。

V1 建议以当前代码的更小语义为准：

```text
action.execution.started
→ Driver 返回前结果变得不可知
→ 可做一次 best-effort 诊断性 Observe（若仍可用）
→ 不伪造 ActionReceipt，不自动 retry
→ run.finished(outcome_unknown)，保留 unresolvedActionId
```

技术计划已同步为上述 V1 语义：不新增 reconciliation Event 和恢复状态；若未来确实要从未知
副作用恢复并继续同一 Run，再基于真实场景设计显式 reconciliation 事实。

### 4. Abort 是否需要，以及何时实现

**需要。** GUI Harness 会等待模型、截图、Driver 动作和用户输入；没有 Abort，Ctrl+C、预算
终止和 SDK 主动取消都无法可靠唤醒正在等待的 Run。但不需要设计“同步 Abort”和“异步
Abort”两套系统。

JavaScript 中应采用一套协作式语义：

- `cancel()` 同步调用本 Run 的根 `AbortController.abort(reason)`，因此取消信号立即可见；
- Provider/Computer/等待逻辑异步观察该 signal，并在安全边界完成事实落盘和清理；
- 纯同步 Reducer、Schema 校验和普通对象转换不能被抢占，只在进入下一项异步工作或副作用前
  检查 `signal.aborted`；
- 所以是“同步发出取消请求，异步完成 Run 收口”，不是两种 Abort。

分阶段加入：

#### S2-2：已接入骨架但不展开并发控制

- 每个 `RunController` 创建一个根 `AbortController`；
- FakeProvider/FakeComputer 的 `open/observe/execute` 从第一版就接收根 signal；
- `start()` 的 happy path 在每个模型调用和副作用前检查 signal；
- S2-2 没有实现完整 Inbox、Ctrl+C 二次强退或后台 Job 取消。

这样可避免 S2-3 再反向改造所有接口，同时不扩大 S2-2 的验收范围。

#### S2-3：实现用户可见的 cancel 行为和竞态测试

- 公共 `cancel(reason?): void` 立即 abort 根 signal，不排到普通 FIFO 尾部；
- cancel 必须能唤醒 `waiting_user`、`waiting_approval` 和 `paused` 等待；
- Provider、Computer open/observe 在确认没有 GUI 副作用时，Run 可结束为 `cancelled`；
- `action.execution.started` 之后收到 cancel 时，必须按 Driver 能否证明“动作未发生”分类；
- 覆盖 cancel 到达 Provider、Observe、Action started 前、Action started 后和等待用户期间的
  确定性测试，不使用真实 sleep。

#### S2-4：故障注入和未知副作用门禁

- Driver 能证明动作未发生：写 `action.execution.failed` + cancelled Receipt，再结束
  `run.finished(cancelled)`；
- Driver 无法证明副作用是否发生：不写虚假 terminal Receipt，结束
  `run.finished(outcome_unknown)`；
- 已 append `action.execution.started` 但 terminal Event 写失败：停止，不 retry；
- 验证磁盘重放与在线 Snapshot 一致。

### 5. 哪些操作不能被根 Abort 粗暴中断

| 操作 | cancel 后的 V1 处理 |
|---|---|
| Provider 请求 | 请求中止；丢弃晚到结果；无 GUI 副作用时 Run 可 cancelled |
| Computer open / observe | 请求中止；关闭已创建资源；无 GUI 副作用时 Run 可 cancelled |
| GUI execute 尚未写 started | 不执行动作，Run 可 cancelled |
| GUI execute 已写 started | 依 Driver 证据分成 cancelled Receipt 或 outcome_unknown |
| EventWriter append 已开始 | 让本次 append 完成，不中途破坏 JSONL；之后再收口 Run |
| AssetStore 发布已开始 | 让原子发布完成；未被 Event 引用的孤儿资产以后离线清理 |
| Computer.close / 最终清理 | best-effort 且有上限；不要复用已经 abort 的根 signal |

尤其要注意：根 signal 一旦 abort，不能再拿它做“取消后的诊断 Observe”，否则该 Observe 会
立即被拒绝。V1 可以直接以 `outcome_unknown` 收口；若以后确实需要取消后的诊断观察，应使用
独立、短时、只用于清理/诊断的 signal，而不是重置根 AbortController。

### 6. 当前不加入的 Abort 设计

- 不新增第二套“同步 Abort”类型；
- 不为 V1 新增 `run.cancel.requested` Event；`cancel()` 发信号，主循环在安全边界写
  `run.finished` 即可；
- 不实现后台 Job 的取消。未来后台任务有自己的 `JobId` 和生命周期，取消一个 Job 与取消整个
  Run 不是同一操作；
- pause 不等于 Abort。pause 在安全边界生效，不强行中断已 started 的 GUI 副作用。

### 7. 修订后的推进门槛

可以继续推进，顺序固定为：

1. 用一个小提交完成 S2-1.1 两项协议收口和对应测试；
2. 修正文档中未知副作用“暂停并询问”的超前承诺；
3. 创建单一 `packages/runtime`，实现 `commitEvent`、最小接口和 Fake happy path；
4. S2-2 从第一天传递根 `AbortSignal`，但把用户可见的 cancel 竞态留到 S2-3；
5. S2-3 再实现 Inbox、纠正、审批、pause/resume/cancel；
6. S2-4 做失败注入和 outcome_unknown 门禁。

S2-2 退出条件仍然保持简单：FakeProvider/FakeComputer 完成一条完整 Run，Event 可从磁盘读回
并得到与在线状态相同的 Snapshot。此时不要求真实 Provider、CUA、后台任务或 Dashboard。

另有一个低优先级边界：当前 Viewport 的磁盘 Schema 允许宽高为 0。它不阻塞 S2-2，但在
Stage 3 坐标换算前应收紧为正整数，并添加 0×N/N×0 拒绝测试，避免除零和无效 Frame。

# Stage 2 开工前审计与 S2-0/S2-1/S2-2 结果

日期：2026-08-28

## 结论

`stage-1-exit-and-stage-2-implementation-plan.md` 的总体顺序正确：先把持久化和状态机的
并发边界收口，再实现 `RunController`。前一轮只完成 S2-0，没有创建 Runtime 包，也没有
接入真实 Provider 或 CUA；随后完成了 S2-1 协议收口和 S2-2 Fake Runtime 骨架，仍未接入
真实 Provider 或 CUA。

2026-08-29 最新复审结论：**S2-0、S2-1.1、S2-2a 和 S2-3a/b 已完成并通过当前代码门槛。**
Runtime 现在先完成同一 ModelTurn 的整组 ToolCall 预检，再允许 GUI 副作用；Provider 返回后和
动作 started 前均有 Abort 安全边界；在线 Snapshot 由 Writer 实际返回的 Event 投影；每 Run
已有单消费者命令 Inbox、用户回答/纠正、审批、pause/resume 和 finished 后命令拒绝。仍未接入
真实 Provider/CUA、后台 Job 或 Dashboard；S2-4 故障注入和退出审计尚未完成。

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

S2-2a 与 S2-3 已按入口文件完成：Runtime 先整组预检、再执行副作用；每 Run 通过单消费者
Inbox 接受用户输入、审批、pause/resume，并在安全边界处理 cancel。下一步进入 S2-4 故障注入
与退出审计，重点验证 Event/Asset/Provider/Computer 失败、未知副作用和终态恢复；继续不接入
真实 Provider/CUA、后台 Job 或 Dashboard。

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

---

## 2026-08-28 S2-2 新实现独立审计

### 1. 本次实际检查

基线提交：

```text
ea4206c feat: link tool calls to proposed actions
1e1bd56 feat: add stage 2 runtime skeleton
```

检查时工作区干净。实际重新运行：

```text
pnpm run typecheck   通过
pnpm test            通过（2 个测试文件，32 项）
```

已经确认有效的实现包括：

- `packages/runtime` 是单一 Runtime 包，没有提前拆出空的 jobs/context/tools 包；
- Fake happy path 真实执行了 open、初始 Observe、ModelTurn、Action、动作后 Observe、下一轮
  ToolResult 和 finish；
- `action.proposed.callId` 已进入 Protocol、Zod、Trajectory 和 Controller；
- 执行前拒绝与 Tool 执行失败已经使用不同的权威 Event；
- `commitEvent` 在 Writer append 成功前不会更新在线 Snapshot；
- GUI Action 的 started Event 在 `computer.execute()` 之前 await；
- Driver 抛出未知结果时没有伪造 terminal Receipt，也没有重试动作；
- Provider in-flight cancel 的现有测试能够结束为 `cancelled`。

因此当前代码不是“只有接口空壳”，S2-2 主链已经可以工作。下面的问题是局部机制缺口，不需要
重写架构。

### 2. P1：整轮 ToolCall 没有在副作用前完成预检

技术计划要求同一 `ModelTurn` 在任何 GUI 副作用前完成整组校验，包括 Tool 是否存在、参数
是否合法、Policy 是否允许以及 GUI 副作用数量。当前 `processToolCalls()` 只提前统计了
Computer Tool 数量，随后在同一个循环中边校验边执行。

因此以下序列会产生部分副作用：

```text
ModelTurn.calls = [合法 click, 不存在的 tool]
→ click 被 proposed / started / execute
→ 才发现第二个 tool 不存在并 rejected
```

类似问题也会发生在“合法 click + 后一个参数非法/Policy deny/require_approval”的组合中。这不
是模型效果问题，而是 Runtime 违反自己的副作用边界。

S2-2a 修复要求：

1. 在写任何 `tool.call.received` 前，先检查本 Turn 内 ToolCall ID 是否非空且互不重复；
2. 对整组完成 Registry lookup、参数校验和 Policy 评估，形成仅存在于内存的 preflight
   结果；
3. 确认最多一个 Computer Tool；
4. 只要整组存在未知 Tool、非法参数、deny、多个 GUI Action，或当前无法表达的多审批/调用
   依赖，就在任何执行前拒绝整组；
5. 全组允许后才按顺序执行。V1 不并发执行同一 ComputerSession 的调用。

不要为此新增通用 Workflow/DAG 或 dependency 字段。当前无法证明同一 Turn 内的调用互相独立
时，整组拒绝并让模型下一轮单步重提即可。

必须增加反例测试：

```text
[合法 click, unknown tool]       → execute 次数 0
[合法 click, invalid arguments]  → execute 次数 0
[合法 click, policy deny]        → execute 次数 0
重复 ToolCallId                  → 不产生部分 received/terminal 轨迹
```

### 3. P1：Abort 已公开，但 GUI 副作用前缺少最后安全检查

当前只在 Run 循环开头检查 Abort。若 cancel 在 Provider 返回后、处理 ToolCall 前到达，Controller
仍可能继续写 `model.response.received`、`action.proposed` 和
`action.execution.started`，然后把已经 aborted 的 signal 交给 Driver。遵守 signal 的 Fake
可能拒绝，但真实 Adapter 是否已开始副作用不能依赖这一点。

S2-2a/S2-3 修复边界：

- Context compile 后、Provider 请求前检查一次；
- Provider 返回后、消费 ModelTurn 前检查一次；
- 整组 preflight 完成后、开始执行任何 Tool 前检查一次；
- 每个 GUI Action 在 append `action.execution.started` 之前做最后一次检查；
- started 已成功 append 后不再假装动作可以无条件取消，只把 signal 交给 Driver，并根据
  Receipt 或未知副作用规则收口。

第一条必要反例：用 deferred/barrier 让 Provider 已返回但 Turn 尚未执行，在此时 cancel，断言
`computer.execute()` 为 0，最终为 cancelled。不要使用真实 sleep。

`cancel()` 在 finished 后的行为也要在 S2-3 固定：建议明确抛错，而不是继续改变一个已结束
Controller 的 signal；这与“finished 后外部命令明确失败”的既有合同一致。

### 4. P1：在线 Snapshot 使用了 candidate，而不是 Writer 返回的 persisted Event

当前 `commitEvent()` 的顺序是：

```text
reduce(candidate) 得到 nextSnapshot
→ writer.append(draft)
→ 只比较 eventId/runId/sequence
→ 在线状态采用先前的 nextSnapshot
→ events 保存 writer 返回的 persisted Event
```

对于当前 `JsonlRunEventWriter`，payload 不会被改写，所以 happy path 没有出错。但
`RunEventWriter` 是注入接口；若实现规范化时间或错误地改变 payload，在线 Snapshot 与磁盘
重放可能分叉，而现有测试只检查了磁盘 Snapshot，没有把它与
`controller.getSnapshot()` 做完整相等比较。

保持“先验证、后持久化、再更新内存”的最小修法：

```text
reduce(snapshot, candidate)        # 只做写前合法性检查，不提交内存
→ persisted = writer.append(draft)
→ 校验 writer 返回的边界
→ reduce(snapshot, persisted)      # 以实际持久化 Event 产生在线 Snapshot
→ 更新 events / nextSequence
```

增加一条集成断言：完整 Run 后，`controller.getSnapshot()` 与
`reduceRuntimeEvents(readRuntimeEvents(...))` 深度相等。无需为了这一点增加 Hash、第二份日志或
事务数据库。

### 5. 已知但不阻塞 S2-3 的失败路径

以下问题已经属于计划中的 S2-4，不应混进本轮三个修复：

- Action 已得到确定 Receipt，但动作后 Observe 失败时，原 ToolCall 尚未写 terminal
  ToolResult；
- terminal Event append 失败后的 fatal stop 和磁盘恢复；
- Asset 写入失败、Computer close 失败的诊断；
- Driver 如何区分“可证明无副作用的 cancelled”和“副作用未知”；
- Viewport 0 宽高在 Stage 3 前收紧。

`getSnapshot()` 当前直接返回内部对象也暂不作为 S2-3 门禁；在公开 SDK 前应改为只读快照或
副本，避免调用者篡改 Controller 内部状态。

### 6. 文档一致性问题

`stage-2-s0-audit-and-gates.md` 已更新到“S2-2 骨架完成”，但
`stage-2-implementation-entry.md` 仍把 S2-1.1 和 S2-2 写成“当前立即执行”。因此实施 Agent
如果只读入口文档，会重复已经完成的工作。

入口文档应在本次审计后切换为：

```text
当前：S2-2a 三项加固
随后：S2-3 Inbox 与控制语义
暂不：S2-4 故障注入、真实 Provider、真实 CUA
```

进入 S2-3 后，`run-turn-tool-and-user-correction-semantics.md` 从“暂不阅读”改为必读；其余
Stage 0 和产品计划仍不作为当前施工合同。

### 7. Runtime 是否应该拆分，以及 Event 当前如何实现

#### 7.1 现在没有拆成 context/tools/providers 包是正确的

当前 `packages/runtime/src/index.ts` 同时定义 Provider/Computer/Context/Policy 的接口和最小默认
实现，但仓库没有创建独立的 `packages/context`、`packages/tools`、`packages/providers`。
这符合此前的阶段约束：

- 当前只有一个默认 ContextCompiler，没有第二个独立消费者；
- 当前只有 ToolRegistry 和测试 Tool，没有可单独发布的 Tool 产品包；
- 当前只有 ProviderAdapter 合同，没有任何真实 Provider 实现；
- Stage 3 才有 CUA Adapter，Stage 4 才有第一个真实 Provider。

因此现在按未来目录图提前创建多个空包，只会增加依赖、构建配置和跨包修改，不增加当前能力。
具体 Provider 将来放到独立 adapter 包；ProviderAdapter 的稳定合同仍由 Runtime 使用，不要现在
为了目录整齐迁移到一个没有消费者的新包。

#### 7.2 但 Runtime 包内部应在 S2-3 前做一次机械拆文件

“保持单一 Runtime 包”不等于“所有实现永久放在一个文件”。当前 `index.ts` 已经同时包含：

```text
Computer / Provider / Context / Policy 合同
ToolDefinition / ToolRegistry
DefaultContextCompiler / DefaultRuntimePolicy
RunController
Clock / IdFactory / 辅助函数
```

S2-3 还会加入 Inbox、等待态和多组竞态逻辑。继续堆在一个文件会让行为修复、接口修改和并发审查
互相干扰。建议在 S2-2a 行为修复通过后做一个**纯机械、无行为变化**的包内拆分：

```text
packages/runtime/src/
├─ contracts.ts          # Computer、Provider、Context、Policy、Tool 合同
├─ tool-registry.ts      # ToolRegistry
├─ defaults.ts           # 当前两个最小默认实现
├─ run-controller.ts     # RunController、Clock/IdFactory 及其私有辅助逻辑
└─ index.ts              # 只做稳定 public exports
```

不必继续拆 `abort.ts`、`events.ts`、`errors.ts`、`jobs.ts` 等没有独立消费者的小文件，也不新建
更多 package。拆分提交只允许移动代码和调整 import/export，现有 32 项测试必须原样通过。

#### 7.3 Event 当前不是 AsyncGenerator

当前 Event 链路由四部分组成：

```text
RuntimeEvent union               # Protocol 中定义事实类型
        ↓
RunController.commitEvent()      # 唯一生产/提交路径
        ↓
RunEventWriter / JSONL           # 权威持久化顺序和 sequence
        ↓
reduceRunEvent()                 # 纯函数投影 RunSnapshot
```

Controller 另外保留一个 `RuntimeEvent[]`，用于当前 Run 的 Context 和测试。Writer 内部使用
Promise 串行队列保证 append 顺序；这里没有 EventBus，也没有 AsyncGenerator。

这不是 S2-2 缺陷。`AsyncGenerator` 更适合表达“一个消费者按顺序拉取异步结果”，但不能单独
承担当前 EventStream 的权威语义：

- 一个 generator 实例通常是单消费，不天然支持 CLI、UI、Metrics 多订阅者；
- 慢消费者可能反向阻塞 Agent 主循环；
- 晚加入的消费者还需要“历史 JSONL + 实时 tail”，generator 本身不解决重放；
- 进程崩溃后仍必须以已落盘 Event 为准，不能以某个内存流为准。

因此 S2-3 不要为了 Inbox 或 Abort 把 Event 重写成 AsyncGenerator。命令 Inbox 是“外部命令
进入 Controller”的单消费者队列；RuntimeEvent 是“Controller 已提交事实”的输出，两者方向和
职责不同。

当 CLI 或 SDK 首次出现真实的实时进度消费者时，再增加非权威 live notification 接口。可以是
`subscribe(listener) → unsubscribe`，也可以是为每个订阅者创建独立队列的
`events(): AsyncIterable<RuntimeEvent>`，但必须满足：

1. 只在 Event append 成功且在线 Snapshot 更新后发布；
2. 不替代 JSONL 和 Reducer；
3. 一个慢订阅者不能阻塞 `commitEvent` 和 GUI 执行；
4. 需要历史时先读 JSONL，再从确定 sequence 接实时事件；
5. 有第一个 CLI/UI 消费者时再固定背压、缓冲和断线语义。

当前没有该消费者，所以本轮不新增 subscribe/AsyncIterable 公共 API。

### 8. 下一步施工指示

#### 提交 1：S2-2a Runtime 安全加固

只完成：

1. 整轮 preflight 后再执行；
2. GUI 副作用前 Abort 检查；
3. persisted Event 驱动在线 Snapshot；
4. 上述反例和在线/重放相等测试。

退出门槛：typecheck/test 通过，四类非法混合 Turn 均为 execute 0，cancel 在 started 前不会
产生 GUI 副作用，在线和磁盘 Snapshot 完全一致。

#### 提交 2：Runtime 包内机械拆分

- 按 7.2 拆成少量职责文件；
- 不创建新 package；
- 不修改公共行为、事件类型或测试预期；
- 原有测试全部通过，diff 中没有顺手重构。

#### 提交 3：S2-3a 命令 Inbox 与等待态

- 单 Run、单消费者内存 FIFO；
- `submitUserInput`、`resolveApproval`、`pause`、`resume`；
- 命令 Promise 只在对应 Event append 成功后 resolve；
- waiting_user、waiting_approval、paused 能被 cancel 唤醒；
- 不允许外部注入 GUI Action。

#### 提交 4：S2-3b 纠正与完整 cancel 竞态

- started 前纠正使旧 ToolCall 不执行并重新请求模型；
- started 后纠正不撤销、不重复动作，确定 Receipt 后再 Observe 和进入下一 Turn；
- cancel Provider/Observe/started 前/started 后分别按既定语义收口；
- finished 后所有外部命令拒绝；
- 完成 Stage 2 测试矩阵 12.2 的第 7—13 项。

完成这三个提交并复审后，再进入 S2-4。不要同时接入真实 Provider/CUA，也不要新增后台 Job、
Subagent、Dashboard、Verifier 或复杂重试器。

---

## 2026-08-29 S2-2a/S2-3 实施结果

本轮按 `stage-2-implementation-entry.md` 完成了入口文件指定的 A/B/C 范围，未引入新的
package 或外部运行时依赖。

### 已完成

- `processToolCalls()` 在写入 `tool.call.received` 前完成 ToolCall ID、Registry、参数、Policy
  和 Computer Tool 数量的整轮预检；未知 Tool、非法参数、Policy deny、重复 ID 和多个 GUI
  ToolCall 都不会产生 GUI 副作用。
- Provider 返回后、ModelTurn 消费前、整组预检后和 `action.execution.started` 前均检查根
  AbortSignal；started 事件成功落盘前不会调用 Computer.execute。
- `commitEvent()` 仍先用 Reducer 做写前校验，随后以 Writer 返回的 persisted Event 更新在线
  Snapshot、事件列表和下一序号；观察结果也采用实际持久化的 Observation。
- Runtime 单文件已机械拆为 `contracts.ts`、`tool-registry.ts`、`defaults.ts`、
  `run-controller.ts` 和只负责导出的 `index.ts`，公共导出和行为保持不变。
- 每个 Run 有单消费者内存 Inbox，提供 `submitUserInput`、`resolveApproval`、`pause` 和
  `resume`。命令只在相应 Event 成功落盘后完成；GUI Action 不能由外部命令直接注入。
- `user_input_required` 会进入 `waiting_user`，回答后回到同一 Run；主动纠正作为
  `user.input.received` 进入下一次上下文。纠正在 GUI Action started 前会跳过旧动作，started
  后不撤销已发生的副作用。
- pause 在安全边界生效，必要时暂存尚未执行的 ModelTurn/ToolCall；resume 后继续。cancel 仍
  立即 abort 根 signal，并能唤醒等待态；finished 后所有命令明确拒绝。
- `DefaultContextCompiler` 会把最近一次用户回答/纠正作为下一轮用户消息传给 Provider。

### 本轮验证

```text
pnpm run typecheck   通过
pnpm test            通过（2 个测试文件，42 项）
```

Runtime 测试现在覆盖：正常 GUI Run、非 GUI Tool、多个 GUI ToolCall 整组拒绝、未知 Tool、
非法参数、Policy deny、重复 ToolCall ID、Provider 取消、未知副作用、用户等待与回答、started
前纠正、pause/resume、审批 allow、Provider 返回后 cancel，以及 finished 后命令拒绝；正常 Run
还断言在线 Snapshot 与 JSONL read/reduce 结果完全相等。

### 尚未完成与下一阶段

S2-4 尚未实施：Event/Asset/Provider/Computer 故障注入、terminal Event 写失败后的恢复、
Driver 对 cancelled 与未知副作用的证据分类、以及更完整的 crash recovery。当前也不接入真实
Provider、CUA、后台 Job、Verifier 或 Dashboard。完成 S2-4 并记录实际门禁后，才进入 Stage 3
CUA Adapter。

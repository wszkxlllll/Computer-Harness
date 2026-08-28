# Stage 2 开工前审计与 S2-0/S2-1 结果

日期：2026-08-28

## 结论

`stage-1-exit-and-stage-2-implementation-plan.md` 的总体顺序正确：先把持久化和状态机的
并发边界收口，再实现 `RunController`。前一轮只完成 S2-0，没有创建 Runtime 包，也没有
接入真实 Provider 或 CUA；本轮完成 S2-1 协议收口，仍未创建 Runtime 主循环。

2026-08-28 复审结论：**S2-0 的主要修复有效，本轮已完成 S2-1 协议收口和 GUI 原生不变量
补齐。** 当前可以进入 S2-2 `RunController`；Runtime 实现仍必须严格遵守本文件的并发、
提交顺序和失败语义。

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

## S2-2 实现时必须遵守的约束

1. **审批与 ToolCall 的存在性**：`callId` 解决了数据关联，但 Reducer 单独看一个事件无法
   证明该调用曾经收到。S2-2 的 Controller 需要维护本 Run 的已接收 ToolCall 视图，拒绝引用
   不存在或已结束的调用；不在 Snapshot 中提前加入通用调用表。
2. **未知副作用的收口**：只有 `run.finished(outcome_unknown)` 可以在 unresolved Action 存在
   时结束 Run，并且必须保留 `unresolvedActionId`；其他 outcome 继续拒绝。Controller 不得
   自动重试，也不得把未知结果伪装为 cancelled。
3. **唯一提交路径**：Controller 只能先用 Reducer 做纯转换校验，再 append Event，append
   成功后再更新在线 Snapshot；Inbox 与 EventWriter 队列必须保持两层分离。
4. **字段级 Schema 漂移**：当前测试已覆盖每种 RuntimeEvent 的最小合法 round-trip；新增
   字段时必须同时更新 Protocol、Zod 和 fixture，不能只扩字符串 discriminator。

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
pnpm test            通过（1 个测试文件，27 项）
```

覆盖了 Writer close/append 竞态、并发 close、终态不可重开、用户/审批互斥、ComputerSession
与 Observation 归属、Action 与最新 Observation 绑定、Receipt/Event 状态一致性、ToolResult
和 JSON-safe 参数、Protocol/Zod 事件清单及每类事件的字段级 round-trip。

复审重新运行命令后为 27 项通过，新增反例均有断言覆盖。本文件状态为“S2-1 收口通过，
允许进入 S2-2”，但不代表真实 Provider 或 CUA 已验证。

## 下一步

下一步进入 S2-2 `RunController`：先实现无外部命令的 FakeProvider/FakeComputer happy path，
再实现每 Run Inbox、命令安全边界和唯一 `commitEvent`。继续保持单一 Runtime 包，不创建空的
tools/context/jobs 包，也不把真实模型或桌面故障混入 Runtime 契约测试。

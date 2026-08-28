# Stage 2 开工前审计与 S2-0 结果

日期：2026-08-28

## 结论

`stage-1-exit-and-stage-2-implementation-plan.md` 的总体顺序正确：先把持久化和状态机的
并发边界收口，再实现 `RunController`。本轮只完成 S2-0，没有创建 Runtime 包，也没有接入
真实 Provider 或 CUA。

## S2-0 已完成

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
  能携带 `refused`、`failed` 或可证明未产生副作用的 `cancelled` Receipt。未决动作不能直接
  结束 Run。
- `approval.requested` 已携带 `callId`，Snapshot 也保存该关联；Zod 入口和 Reducer 都有
  相应校验。
- Protocol 的 `RuntimeEventType` 由 `RuntimeEventData["type"]` 派生，并提供完整事件清单；
  测试会检查清单与 Zod discriminator 的一致性。

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

## 进入 Runtime 前仍需明确的两个协议点

1. **审批与 ToolCall 的存在性**：`callId` 解决了数据关联，但 Reducer 单独看一个事件无法
   证明该调用曾经收到。S2-2 的 Controller 需要维护本 Run 的已接收 ToolCall 视图，拒绝引用
   不存在或已结束的调用；不在 Snapshot 中提前加入通用调用表。
2. **未知副作用的收口**：`ActionReceipt` 在当前 S2-0 仍保留旧的
   `outcome_unknown` 类型以兼容 Protocol，事件级 Schema 已禁止它作为 completed/failed 的
   Receipt。S2-2/S2-4 不得在未决动作上直接写 `run.finished`；在移除该旧类型前，必须确定
   “恢复观察后如何显式收口”的事件或人工确认语义。这是进入失败路径前的设计门槛，不用临时
   自动重试代替。

## 本轮验证

```text
pnpm run typecheck   通过
pnpm test            通过（1 个测试文件，23 项）
```

覆盖了 Writer close/append 竞态、并发 close、终态不可重开、用户/审批互斥、Observation
归属、Receipt/Event 状态一致性、Protocol/Zod 事件清单和磁盘 round-trip。

## 下一步

S2-0 退出后，按原计划进入 S2-1（ToolResult、ObservationCapture、审批协议的正式增量），
再进入 S2-2；在此之前不创建空的 tools/context/jobs 包，也不把真实模型或桌面故障混入
Runtime 契约测试。

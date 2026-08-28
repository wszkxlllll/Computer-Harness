# Stage 1 退出复审与 Stage 2 实施计划

日期：2026-08-28  
状态：施工前审计稿；供下一位执行 Agent 直接实施  
范围：只评审 Protocol、Trajectory 与 Stage 2 Runtime，不实现真实 Provider 或 CUA

## 1. 结论

**可以继续推进，但不是立即跳过 Stage 1 直接写 RunController。**

当前 Stage 1 的主体设计已经成立：Protocol 与 Trajectory 的包边界合理，EventWriter、
AssetStore、Zod 磁盘校验、纯函数投影和端到端落盘测试都已具备。现有代码无需推倒重来。

进入 Stage 2 前先完成一个范围很小的 `S2-0` 收口补丁，修复四类会在长时间运行和外部命令
并发中放大的问题：

1. EventWriter 的 `close()` 与 `append()` 竞态；
2. Run 终态可被后续事件重新打开、用户输入会错误改变其他等待状态；
3. Event 内部跨字段不变量缺失；
4. TypeScript Protocol 与 Zod Schema 的漂移保护不足。

这四项通过后，不扩数据、不接真实模型、不接 CUA，直接进入 Stage 2。Stage 2 的重点是证明
一套确定、可中断、可审计的 Run Loop 能运行，而不是追求 GUI 任务成功率。

## 2. 本轮复审事实

### 2.1 已通过

在提交 `44bfbfd` 上重新执行：

```text
pnpm run typecheck  通过
pnpm test           通过（1 个测试文件，17 项）
```

已经实现并验证：

- `JsonlRunEventWriter` 绑定单一 RunId，拒绝混写其他 Run；
- sequence 在单 Writer 内单调递增；
- Asset 使用临时文件完整写入，再以不可覆盖方式发布；
- 重复资产路径不会覆盖旧内容；
- Zod 校验主要 RuntimeEvent 嵌套结构；
- `user.input.requested/received` 与 `pendingUserQuestion` 已进入协议和投影；
- 审批拒绝不会自动把整个 Run 结束为 cancelled；
- Asset → Event → read → reduce 的集成路径已经覆盖。

### 2.2 测试通过但仍存在的缺口

#### P0：Writer 关闭竞态

当前 `close()` 先等待 `flush()`，之后才设置 `closed = true`。在等待期间另一个调用仍可进入
`append()`。复现实验中，并发 `close()` 与 `append()` 可以同时 fulfilled，意味着“开始关闭”
并没有形成禁止新写入的线性化边界。

Stage 2 会同时处理 Provider、Computer、用户命令和 cancel，这个竞态会从理论问题变成真实
问题。修复应使用明确的 `open → closing → closed` 状态，`close()` 一进入就同步切换到
closing，拒绝新的 append，再等待已经入队的写入并关闭句柄。

必须新增测试：

- close 开始前已经排队的 append 能完成；
- close 开始后的 append 必须失败；
- 并发调用 close 幂等；
- close 返回后文件句柄不再被重新打开。

#### P0：Run 终态和等待态可被错误改写

当前 Reducer 接受：

```text
run.finished(succeeded)
→ user.input.received
→ status = running，但 outcome 仍为 succeeded
```

这会形成自相矛盾的 Snapshot。当前测试还把“仅有一条 user.input.received 就把初始 Run 改成
running”当成正确行为，因此现有绿灯不能证明状态机正确。

S2-0 至少建立以下不变量：

- `finished` 是终态，后续任何改变运行状态的 Event 都报错；
- `run.created` 只能作为该 Run 的第一个生命周期事实；
- `run.started` 只能从 created 进入 starting；
- requested user input 与 pending approval 不能同时存在；
- `user.input.received` 在 waiting_user 中清除问题并回到 running；
- 主动纠正在 running 中保持 running，在 paused 中保持 paused；
- waiting_approval 中不接受普通用户纠正来隐式绕过审批；先明确 resolve/deny approval；
- pause 只在安全边界生效，resume 只允许从 paused 发生；
- unresolved GUI Action 存在时不能直接 finish。

为区分“刚创建的空投影”和“已经处理过 run.created”，`RunSnapshot` 可以加入
`createdAt?: string`。它有当前生产者、当前消费者和明确的状态机用途，不属于预留字段。

#### P0：跨字段不变量缺失

本轮确认以下输入当前会被接受：

- 外层 Event 属于 Run A，但 `observation.runId` 属于 Run B；
- `action.execution.completed` 携带 `receipt.status = failed`；
- `action.execution.failed` 可以携带 `receipt.status = completed`。

修复规则：

- `observation.created.observation.runId === event.runId`；
- completed Event 只能携带 completed Receipt；
- failed Event 只允许 refused、failed 或可证明未发生副作用的 cancelled Receipt；
- `outcome_unknown` 不作为 ActionReceipt 的伪终态。S2-0 已在事件 Schema 和 Reducer 中拒绝
  将它作为 completed/failed Receipt；started 后无法确认结果时保留未决 Action，Run 进入
  outcome_unknown 恢复路径。Protocol 类型本身的旧字段在 S2-1 再移除，以便先完成兼容迁移；
- Computer Adapter 只有在能确定动作未发生时才能返回 cancelled；否则归类为副作用未知。

这些规则同时进入 Zod 边界校验、Reducer 防御和单元测试。Zod 保护磁盘输入，Reducer 保护
内存中直接构造的 Event；二者不是无意义重复。

#### P1：Protocol 与 Zod Schema 仍有漂移风险

当前 TypeScript `RuntimeEventData` 和 Trajectory 中的 Zod discriminated union 需要手动同步，
解析成功后仍使用双重类型断言。Stage 2 会马上增加 ToolResult 事件，继续手工同步很容易遗漏。

本阶段不做大规模 Schema 包迁移。采用最小方案：

1. `RuntimeEventType` 从 `RuntimeEventData["type"]` 派生，不再维护第二份字符串 union；
2. 维护一个 `as const satisfies readonly RuntimeEvent["type"][]` 的事件类型清单；
3. 用类型测试保证清单没有缺项，用运行测试保证 Zod union 的 discriminator 与清单一致；
4. 新增每个事件类型的最小合法 round-trip fixture。

如果这套保护仍频繁漂移，再把 Zod Schema 移入 protocol；现在不先做包级重构。

## 3. Stage 2 要回答的问题

Stage 2 只回答五个工程问题：

1. 一次 Run 能否从创建、观察、模型 Turn、工具执行一直运行到结束？
2. 任何 GUI 副作用是否都严格发生在 started Event 成功落盘之后？
3. 用户提问、主动纠正、审批、暂停、继续和取消能否在异步调用中安全介入？
4. Provider 或 Computer 失败时，Trajectory 是否仍能准确区分“未执行、确定失败、结果未知”？
5. 同一个 Runtime 是否能在不依赖真实模型和桌面的情况下被确定性测试？

Stage 2 不回答：

- 哪个 VLM GUI 能力最好；
- CUA 在真实 Windows 上是否稳定；
- PlanningTask 是否提升长任务成功率；
- 视觉上下文压缩是否有效；
- Verifier、Subagent、后台 Job、Dashboard 或在线 Benchmark 如何实现。

## 4. 实现边界

只新增一个产品包：

```text
packages/runtime/
├─ src/index.ts
├─ src/run-controller.ts
├─ src/command-inbox.ts
├─ src/tool-registry.ts
├─ src/default-runtime-policy.ts
├─ src/default-context-compiler.ts
├─ src/errors.ts
└─ src/testing/              # 仅由测试使用的 FakeProvider/FakeComputer
```

不在 Stage 2 创建独立的 tools、context、policy、jobs、planning、replay 等空包。等第二个真实
实现或独立消费者出现后再拆包。RunController 通过接口依赖 Provider 与 Computer，测试替身
放在 runtime 测试支持目录，不包装成产品功能。

## 5. Stage 2 开工时要补齐的协议

### 5.1 ToolResult

现在只有 ToolCall，没有所有工具共用的回传结果。Stage 2 增加 JSON-safe 的 ToolResult：

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type ToolResult =
  | {
      callId: ToolCallId;
      status: "completed";
      output: JsonValue;
    }
  | {
      callId: ToolCallId;
      status: "failed" | "rejected";
      error: { code: string; message: string };
    };
```

同时增加：

```text
tool.call.completed
tool.call.failed
```

`tool.call.rejected` 保留，表示 Schema、Policy 或 Turn 级校验在执行前拒绝。三类 Event 都能被
ContextCompiler 转换为下一轮的 tool message。

Computer Tool 的事实链为：

```text
tool.call.received
→ action.proposed
→ action.execution.started
→ driver.execute
→ action.execution.completed / failed
→ observation.created（若还能观察）
→ tool.call.completed / failed
```

Planning/Control Tool 不产生 ActionIntent，直接产生对应 ToolResult。这保持“所有 GUI Action
可以是 Tool，但不是所有 Tool 都是 GUI Action”的两层语义。

### 5.2 ObservationCapture 与 ObservationFrame 分离

Computer Adapter 不应返回一个引用尚未落盘图片的 `ObservationFrame`。采用：

```ts
observe(
  session: ComputerSession,
  observationId: ObservationId,
  signal: AbortSignal,
): Promise<ObservationCapture>;
```

Runtime 的顺序固定为：

```text
分配 ObservationId / AssetId
→ Computer.observe(observationId)
→ AssetStore.put
→ 构造 ObservationFrame
→ append observation.created
→ 更新 Snapshot
```

CUA Adapter 将来可以在内部把 Runtime 分配的 ObservationId 绑定到私有 Frame Ref，但
Protocol、Provider 和 Trajectory 不接触 Driver 私有引用。

### 5.3 审批必须绑定 ToolCall

`approval.requested` 增加 `callId`。Snapshot 中保存：

```ts
pendingApproval?: {
  requestId: string;
  callId: ToolCallId;
  reason: string;
};
```

审批拒绝为该 ToolCall 产生 rejected ToolResult，然后重新规划。审批批准也不能绕过旧 Frame
校验；执行前仍检查当前 Observation 与 Adapter Frame 是否有效。

## 6. RunController 的最小公开接口

```ts
interface RunController {
  start(goal: string): Promise<RunOutcome>;
  submitUserInput(text: string): Promise<void>;
  resolveApproval(requestId: string, approved: boolean): Promise<void>;
  pause(reason?: string): Promise<void>;
  resume(): Promise<void>;
  cancel(reason?: string): void;
  getSnapshot(): RunSnapshot;
}
```

约束：

- `start()` 表示完整 Run，内部包含多个 ModelTurn；
- 同一个 Controller 的 `start()` 只能调用一次；
- 外部命令返回的 Promise 只有在对应 Event 成功 append 后才 resolve；仅进入内存队列不算
  已接受；
- Controller 不暴露“执行任意 Action”的外部入口；GUI Action 只能来自本 Run 的 ToolCall；
- `cancel()` 立即触发根 AbortController，因此不在 FIFO 尾部等待；最终 Run Event 仍由主循环
  在安全边界写入；
- Run finished 后所有外部命令明确失败，不允许重新打开 Run。

## 7. 唯一事实提交路径

RunController 内部只保留一个提交入口，名字可以是 `commitEvent`：

```text
验证当前 Snapshot 是否允许该 Draft
→ EventWriter.append
→ append 成功后 reduceRunEvent
→ 把已提交 Event 加入本 Run 的内存 Event 视图
→ 唤醒等待的 UI/测试订阅者（Stage 2 可不做公共订阅 API）
```

不得先修改 Snapshot 再尝试写 Event。不得让 ToolExecutor、Policy、Provider 或 Computer 绕过
RunController 直接写 Trajectory。

若 append 已成功但 Reducer 因程序错误失败，Controller 立即进入 fatal stop；不能继续产生 GUI
副作用。正常情况下相同的 transition validator 和 Reducer 测试应保证不会走到这里。

## 8. 每 Run 命令 Inbox

Inbox 是内存 FIFO，只有 RunController 主循环是消费者。它处理：

```text
user_input
approval_resolution
pause
resume
```

它不是：

- GUI Action 队列；
- EventWriter 写入队列；
- 后台 Job 队列；
- 多 Agent Mailbox。

### 8.1 安全边界

主循环在以下位置 drain Inbox：

1. Provider 返回 ModelTurn 后、处理 ToolCall 前；
2. 每个非 GUI Tool 完成后；
3. GUI Action started 之前；
4. GUI Action 获得确定终态并重新 Observe 之后；
5. 准备接受 finish 之前；
6. waiting_user、waiting_approval、paused 状态下等待下一条相关命令时。

### 8.2 纠正到达的语义

```text
纠正在 action.execution.started 前到达
→ append user.input.received
→ 原 ToolCall 标记 superseded_by_user_input
→ 不执行旧动作
→ 重新编译 Context 和请求下一 ModelTurn
```

```text
纠正在 action.execution.started 后到达
→ 不假装撤销动作
→ 等待确定 Receipt；若结果未知则进入未知副作用路径
→ 尽可能重新 Observe
→ append 并消费纠正
→ 下一 ModelTurn 同时看到动作事实、新 Observation 和纠正
```

### 8.3 pause 与 cancel 不混淆

- pause 是协作式的，只在下一个安全边界生效；不把正在执行的 GUI 动作强行解释为取消；
- resume 只从 paused 生效；
- cancel 立即向 Provider/Computer 发送 AbortSignal；
- 若 Computer 能证明动作未发生，可以记录 cancelled Receipt；
- 若 Abort 到达时副作用是否发生不可知，保留 unresolved Action，Run 以
  `outcome_unknown` 收口，不能标记为普通 cancelled。

## 9. 一次完整 Run Loop

```text
1. commit run.created
2. commit run.started
3. commit computer.open.started
4. Computer.open
5. commit computer.open.completed
6. 获取并持久化初始 Observation

7. while Run 可运行：
   a. drain 外部命令，检查取消和预算
   b. ContextCompiler.compile
   c. commit model.request.started
   d. Provider.generate(signal)
   e. commit model.response.received 或 model.request.failed
   f. drain 外部命令
   g. 分派 ModelTurn：
      - user_input_required：commit requested，等待输入
      - finish：再 drain 一次命令，Policy.canFinish，结束或继续
      - tool_calls：先整组验证，再逐个路由
   h. GUI Tool 严格执行 started → side effect → terminal → observe
   i. 将 ToolResult 加入下一轮 Context

8. commit run.finished
9. flush/close writer
10. best-effort Computer.close；关闭失败记录到可用日志，但不得改写已完成事实
```

同一 ModelTurn 在任何副作用开始前先做整组校验：Tool 存在、参数合法、Policy 可判、最多一个
GUI 副作用。如果包含多个 GUI 副作用，整组拒绝，不能先执行第一个再发现第二个非法。

## 10. 失败语义

| 失败点 | 是否可能已有 GUI 副作用 | 处理 |
|---|---:|---|
| Asset 写入失败 | 否 | 不写 observation Event，停止 Run |
| Event started 写入失败 | 否 | 不调用 Computer.execute，停止 Run |
| Provider 失败 | 否 | 写 model.request.failed；Stage 2 默认不自动重试 |
| Tool Schema/Policy 拒绝 | 否 | 写 rejected ToolResult，下一轮重规划 |
| Driver 返回确定 failed/refused | 已知 | 写 action.execution.failed，再尽可能 Observe |
| Driver 返回可证明 cancelled | 否 | 写 failed Event + cancelled Receipt |
| Driver 抛出且副作用未知 | 未知 | 不伪造终态 Receipt，不自动 retry，重新观察或暂停并以 outcome_unknown 收口 |
| GUI 已完成但 terminal Event 写失败 | 已发生 | 停止；磁盘恢复只能看到 started，因此按 outcome_unknown 处理 |
| 用户在 finish 前纠正 | 否 | 旧 finish 失效，进入下一 Turn |
| Run finished 后收到命令 | 否 | 拒绝命令，不写改变状态的 Event |

Stage 2 不内置通用重试器。等真实 Provider/CUA 错误数据出现后，再只为明确幂等、明确未产生
副作用的操作增加有限重试。

## 11. FakeProvider 与 FakeComputer

Fake 不是 Mock 网站，也不用于声称 GUI 能力。它们是确定性 Runtime 契约测试替身。

`FakeProvider` 应由预先给定的 ModelTurn 脚本驱动，并能：

- 返回 tool_calls、user_input_required、finish；
- 延迟返回，以便测试中途注入纠正、pause 和 cancel；
- 抛出 Provider 错误；
- 记录每次收到的 ModelInput，供断言 ToolResult 和用户纠正确实进入下一轮。

`FakeComputer` 应能：

- open、observe、execute、close；
- 为每次 observe 返回不同的确定字节和 Viewport；
- 返回 completed、failed、refused、cancelled Receipt；
- 在 started 后抛出“副作用未知”错误；
- 用屏障控制 execute 何时结束，以测试动作期间到达的命令；
- 记录调用顺序，证明 Event started 先于真实 execute。

测试里不使用真实计时 sleep；用 deferred promise、FakeClock 或显式屏障推进。

## 12. Stage 2 必须覆盖的测试矩阵

### 12.1 正常路径

1. 初始 observe → click → post observe → finish；
2. type/keypress 也绑定当前 ObservationId；
3. ModelTurn 请求用户输入，回答后仍在同一 Run 继续；
4. 非 GUI Tool 产生 ToolResult，不生成 ActionIntent；
5. approval allow 后执行，deny 后产生 rejected ToolResult 并重新规划；
6. finish 前最后一次 drain 能拦住刚到达的用户纠正。

### 12.2 并发与控制

7. 纠正在 started 前到达，旧 GUI Tool 未执行；
8. 纠正在 started 后到达，动作只执行一次，之后重新 Observe；
9. pause 在安全边界生效，resume 后继续；
10. cancel Provider 请求，Run 正确结束 cancelled；
11. cancel 未知状态的 Computer 调用，Run 不谎报 cancelled；
12. 多条外部命令按提交顺序消费；
13. finished 后 submit/resume/approval 都被拒绝。

### 12.3 持久化与副作用

14. started Event append 失败时 execute 调用次数为 0；
15. Asset 写入失败时 observation Event 不存在；
16. action started 后进程式中断，重放得到 unresolvedActionId；
17. terminal Event append 失败后不重试 Action；
18. Writer close 与 append 竞态满足 S2-0 规则；
19. Event 全量 read → reduce 与在线 Snapshot 完全一致；
20. 每个 ToolCall 都恰好得到 completed、failed 或 rejected 中的一种结果，未知 GUI
    副作用除外，此时 Run 必须暂停/终止而不是继续下一个 ToolCall。

## 13. 分步施工顺序

### S2-0：Stage 1 收口

- 修 Writer close 竞态；
- 修 Reducer 生命周期与用户输入语义；
- 修 Observation/Receipt 跨字段不变量；
- 加 Schema 漂移保护；
- 更新错误测试，不新增 Runtime 包。

退出门槛：typecheck/test 通过，四个复现全部转为失败输入或正确状态。

### S2-1：Protocol 增量

- 加 JsonValue、ToolResult、tool completed/failed Event；
- 为 S2-0 已加入的 approval `callId` 补齐 ToolCall 存在性校验，并接入 rejected ToolResult；
- ActionReceipt 从 Protocol 类型移除伪终态 `outcome_unknown`（S2-0 的事件边界已经先拒绝该值）；
- 定义 ObservationCapture（属于 Computer/Runtime 接口，不写入 Trajectory）。

退出门槛：所有新增 Event round-trip，旧 fixture 有明确迁移结果。

### S2-2：Runtime 骨架

- 新建单一 `packages/runtime`；
- 实现 RunController、commitEvent 和状态守卫；
- 实现最小 ToolRegistry、默认 Policy、默认 ContextCompiler；
- 先跑无外部命令的 happy path。

退出门槛：FakeProvider/FakeComputer 完成一条 Run，落盘可重放。

### S2-3：命令 Inbox 与安全边界

- submitUserInput、approval、pause/resume；
- 根 AbortController cancel；
- started 前/后纠正的两种语义；
- finished 后命令拒绝。

退出门槛：12.2 全部通过，无 GUI Action 重复执行。

### S2-4：失败路径与退出审计

- Event/Asset/Provider/Computer 故障注入；
- outcome_unknown 与不自动 retry；
- 在线 Snapshot 与磁盘重放一致；
- 更新 README 只描述已经实现的使用方式。

退出门槛：12.3 全部通过，Stage 2 审计文档记录实际测试命令和已知限制。

每个子阶段单独提交。不要把 S2-0、协议变化、Runtime 主循环和所有并发测试压进一个大提交；
也不要为每个测试样例临时增加专用状态或配置。

## 14. Stage 2 最终验收门槛

以下条件全部满足才进入 Stage 3 CUA Adapter：

- `pnpm run typecheck` 与全部测试通过；
- 至少一条正常 Run、一条用户提问 Run、一条主动纠正 Run、一条审批 Run 可完整重放；
- started Event 落盘失败时没有任何 GUI execute；
- 不确定副作用不会被自动重试；
- Run finished 后不能被任何后续 Event/命令重新打开；
- 同一 ComputerSession 同时最多一个 GUI 副作用；
- FakeProvider 收到上一轮真实 ToolResult，而不是从日志字符串猜测结果；
- 在线 Snapshot 与 `trajectory.jsonl` 重放结果一致；
- 不存在真实 Provider、CUA、后台 Job、Verifier 或 Dashboard 的半成品代码。

若以上门槛通过，Stage 2 就完成了。不要因为“以后可能需要 Subagent/异步任务”继续扩建；这些
能力的接口位置已经明确，但没有当前 producer/consumer，不进入本轮协议。

## 15. 给执行 Agent 的起点

执行 Agent 应先阅读：

1. `docs/gui-agent-harness-v1-technical-plan.md`；
2. `docs/run-turn-tool-and-user-correction-semantics.md`；
3. 本文；
4. `packages/protocol/src/index.ts`；
5. `packages/trajectory/src/index.ts` 和测试。

第一步只实施 `S2-0`，提交测试结果和 diff 供复核。未经 S2-0 退出审计，不提前创建
RunController。

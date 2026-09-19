# DEV-4 Memory / DEV-5 Monitor online 集中审查

日期：2026-09-18
文档角色：独立集成审查
审查基线：`dee64fb..adea8d7`（同时核对 `638d131` Provider prefix 测试）
状态：暂不放行在线批；3 项 P1、2 项 P2 需一次性定点修复

## 1. 结论

离线全量基线通过，但当前在线接入仍有会改变 Run 控制流或把 last-known Memory 以普通事实结构返回的实质问题。以下问题不是“尚未实现语义检索/需求相关性”的范围扩张，而是本批已经提供的 shadow/guidance、current Memory、scope lifecycle 和 Trace 合同自身不满足其声明。

可保留的基础包括：Memory 没有动作数、事件数、时间或 frame TTL；run/session scope、superseded、entity stale/missing 和 session mismatch 的底层 gate 已存在；旧 Store/trajectory 记录缺字段时归一化为 run/stable；Context 的 hot/revalidation 分组已避免普通 index 先占满；Monitor 默认 off、不创建 state/事件/Context，retry attempt 不推进 decision clock，proposal 自身不会递归送入 Monitor，输出正文只含有界枚举。

## 2. Blocking findings

### P1 — shadow 模式会升级为真实 `waiting_user`，正常进展反而触发旧候选过期求助

位置：

- `packages/runtime/src/monitor-policy.ts:99-123`
- `packages/runtime/src/run-controller.ts:1711-1721`

`reduceMonitorPolicy()` 在 `!input.monitor.candidate` 分支先执行 `candidateExpired()`，而 `mode === "shadow"` 的判断在后面。因此 shadow 首次看到候选后，只要后续正常事件把 work clock 推过 4，便会返回 `help_requested`。Controller 不按 mode 拦截该 proposal，会提交 `user.input.requested` 并把 Run 切到 `waiting_user`。

独立只读复现使用构建产物：shadow 第一次 candidate 返回 `none/shadow`；随后一个 non-candidate、work clock 从 0 进到 5，返回 `help_requested/candidate_expired`。这同时暴露第二个语义错误：候选在后续无候选/正常活动中“过期”应撤销或降级，而不是被当作持续异常升级求助。否则普通 Planning/Memory 更新或动作恢复后仍可能触发人工中断。

最小修复：

1. `off` 与 `shadow` 在任何分支都不得产生 guidance/help；shadow 只允许持久化脱敏 candidate。
2. non-candidate 输入应清除/衰减旧候选，不能因 age 自动 help。升级只能来自同 partition 下新的、持续 candidate evidence。
3. 增加纯 policy 与 Controller 回归：shadow 任意 clock/候选序列均无 `user.input.requested`；candidate 后正常活动不会 help；只有持续候选才可消耗 guidance/help budget。

### P1 — `help_requested` 在 action 原子链中间直接改状态，会使同一动作的 ToolResult/Observation 失败

位置：

- `packages/runtime/src/run-controller.ts:1429-1455`
- `packages/runtime/src/run-controller.ts:1682-1721`
- `packages/trajectory/src/index.ts:132-140`

Monitor 在每次 committed event 后同步执行。若 action receipt 产生 `help_requested`，Controller 会在 `commitEvent(action.execution.completed|failed)` 尚未返回给动作执行函数时直接提交 `user.input.requested`。Snapshot 因此变成 `waiting_user`，随后同一函数仍要提交 `tool.call.completed|failed` 并执行 post-action observation；Trajectory 明确要求 ToolCall terminal event 只能在 `running`，所以会抛错并把已经完成的动作变成 Run failure。

`monitorExecutionBarrier()` 此时看不到这个边界：action receipt 已清除了 `unresolvedActionId`，但 ToolCall terminal 与 follow-up observation 尚未落盘。现有 online 测试只覆盖 guidance，不覆盖 help 在 action receipt、approval 或 unknown 路径上的事件顺序。

最小修复：help 只能排入 Controller 自有的 deferred/Inbox 控制，在完整 action → tool result → post-observation 链结束且无 approval、unknown side effect、abort 或 pending call 时消费。不得在 `commitEvent()` 的递归旁路中直接改变 Run status。增加事件顺序回归，证明 help 前 tool terminal 与 observation 已提交，execute 只发生一次，Run 不因 Monitor 状态切换失败。

同时，执行 barrier/terminal/partition reset 时应显式清除 `monitorPendingGuidance`；当前 policy 清候选但 Controller 的 pending guidance 可跨 approval barrier 留到后续请求，虽不解除 approval，仍会把旧分区/旧决策提示带入新 Context。

### P1 — `memory_get` / `memory_list` 的 current 输出仍把 last-known/needs-check 放在普通 `facts` 中

位置：

- `packages/memory/src/tools.ts:68-87`
- `packages/memory/src/tools.ts:210-225`
- 对照 Context 的结构化分离：`packages/context/src/memory-recall.ts:83-103`

Context 已把稳定 current facts 与 `needs_check` / `short_lived_last_known` 分成 `admittedFacts` 和 `revalidationCandidates`。但模型实际可调用的 `memory_get` 与 `memory_list` 仍把 active short-lived 和 needs-check 记录完整放进普通 `facts` 数组，只额外附一个 `factAdmission` 标签数组。Provider 随后会把整个 ToolResult 投影进 ModelInput；模型看到的主结构仍是普通事实和值，sidecar 标签不能保证它按 last-known 候选理解。这正是计划中“不能仅增加标签后仍按确定事实拼接”的风险。

最小修复：current 视图结构化返回 `admittedFacts` 与 `revalidationCandidates[{fact,reason}]`（或等价强类型分区），不再把两者混在同一 `facts`。history 可继续返回历史记录，但要带 applicability/reason。`memory_get`、`memory_list` 与 Context 必须复用同一个 admission helper，而不是三处各自拼条件。补真实 ToolResult → Context ModelInput 回归，断言 last-known 值只出现在 revalidation 区，session mismatch、superseded、stale/missing entity 不出现于 current admitted 区。

## 3. Other required fixes

### P2 — session scope 结束事件使用伪 ToolCall ID，物化失败会留下“已结束”标志与部分生命周期状态

位置：

- `packages/runtime/src/run-controller.ts:1623-1645`
- `packages/app-runtime/src/run-factory.ts` 的 `memoryMutationApplier`

Runtime 用 `memory.updated(callId="runtime:scope-ended")` 表示宿主生命周期变化，但该 ID 没有对应 `tool.call.received`，会让关联消费者把 Runtime lifecycle 误认为模型 ToolCall。更重要的是，`sessionMemoryScopeEnded` 在处理 facts 前就设为 true；任一 Store apply 失败后，事件已提交而 materialization 失败，catch 路径再次 finish 时会跳过全部剩余事实。结果虽然 Run 会失败且事件日志仍是权威，但部分 session facts 没有 scope-ended 事件，Store 与 Snapshot 也可能分叉，布尔值却表示 lifecycle 已完整处理。

最小修复：为 Runtime lifecycle 增加诚实 source/discriminant（或独立事件），不要伪造 ToolCall ID；完成标志只能在全部生命周期 mutation 处理成功后设置。失败路径需明确记录 `memory_materialization_failed`/scope cleanup incomplete，并保证可从已提交事件确定性 rebuild；多 fact/Nth apply failure 回归必须验证没有静默漏标或假完成。

### P2 — Memory Trace 记录的是候选选择，不是实际落入文本的 packets

位置：

- `packages/context/src/projections.ts:68-106`
- `packages/context/src/compiler.ts:247-255`

`formatMemory()` 会因 group allowance/总软预算省略部分 hot 或 revalidation records，极小预算甚至返回空文本；但 Trace 的 `admittedFactIds`、`revalidationFactIds` 直接来自完整 selection，而不是实际 rendered groups。于是 Trace 可声称某 revalidation fact 已进入 Context，实际 ModelInput 中没有该 ID/值。现有“预算 4 → 空文本”测试没有核对 Trace，实施记录所称 trace 诚实性尚未成立。

最小修复：MemoryProjection 返回 candidate IDs、rendered IDs 与 omitted reason 的独立集合；Trace 至少记录实际 projected admitted/revalidation IDs，并对 budget omission 明示。补 crowded/oversized/tiny budget 的真实 `DefaultContextCompiler.compile()` 测试，直接检查 ModelInput 文本与 Trace 一致，而不只检查 selection。

## 4. 非阻塞核对结果

- Memory scope 的真实 session ID 由 Runtime/Tool context 盖章；target scope 未伪造。
- `retentionClass` 只影响 recall 分类；没有动作数、事件数、时间或 screenshot ID 自动 TTL。
- superseded、scope mismatch、inactive/missing entity 不进入 Context admitted/hot；旧 JSON、旧 event replay 和 Store parser 保留兼容默认值。
- 同 key/scope 的变值写入走 supersede；同值若显式改 retention/status 也会退出旧记录。后续需求相关性与跨 Run 语义仍按计划开发，本审查不要求本批实现。
- Monitor off 不产生 proposal 或 guidance；retry attempt 2+ 不推进 model decision clock；proposal event 由 recursion guard 排除；unknown/approval/abort barrier 不会授权 GUI retry/approve/execute。
- `monitor.proposal` 只含 fingerprint、枚举 reason/evidence、有限 event IDs/work clock 和最多 240 字符的枚举 guidance，不含 typed text、URL、截图正文或 Memory value。

Monitor proposal append/policy 自身仍位于主 `commitEvent()` await 链上；整改时应补一个 monitor proposal append failure 回归，确保尤其 shadow 模式的诊断失败不会改变已提交业务事件的 Run outcome。若设计选择让 guidance 模式 fail-closed，必须在合同和事件中明确，不能把 shadow 零干预与 guidance 行为混为一谈。

## 5. 独立验证

实际执行：

```text
pnpm run typecheck
pnpm test
```

结果：typecheck 退出码 0；Vitest 35 files / 363 tests 全部通过。

另用已构建的 `monitor-policy.js` 做只读纯函数复现，确认 shadow candidate 后的 non-candidate/work-clock 推进会返回 `help_requested/candidate_expired`。因此全量 green 不能覆盖上述缺失反例。

## 6. 放行范围与后续

当前可保留 committed foundation 与既有离线测试，但 `adea8d7` 所代表的 online Monitor 行为和 DEV-4 current recall/lifecycle 不能作为完成态继续推广。建议一次性修复第 2、3 节，补有限反例后只做定点复审。

本审查没有要求本批实现语义检索、需求相关性、跨 Run Memory、target generation、视觉真值、自动 TTL、完整 stop policy 或真实效果评测；这些仍是后续明确范围。

本轮只新增本审查文档，没有修改业务代码、调用模型 API、操作桌面或 VM，也没有提交或推送。

## 7. `ba97878` 定点复核（2026-09-18）

复核范围严格限定为上轮 5 项 finding 与 shadow proposal append 异常。独立执行以下 focused tests：

```text
pnpm exec vitest run \
  packages/runtime/src/monitor-policy.test.ts \
  packages/runtime/src/index.test.ts \
  packages/memory/src/index.test.ts \
  packages/memory/src/runtime-regression.test.ts \
  packages/context/src/memory-projection.test.ts \
  packages/context/src/index.test.ts \
  packages/trajectory/src/index.test.ts
```

结果：7 files / 150 tests 全部通过。未重复全量 typecheck/test；worker 报告的 typecheck 与 focused 结果只作作者证据。

### 已关闭

- Shadow policy 不再因旧 candidate age 产生 help；non-candidate 超龄只清除候选。纯 policy 回归覆盖 shadow 任意 clock 不产生 guidance/help。
- 单动作链的 Monitor help 已延后到 action receipt、ToolResult 与 post-action Observation 之后；proposal append failure 被隔离并记录为 best-effort `monitor_diagnostic`，不再改变已提交业务事件的 outcome。
- approval/correction/pause/resume、unknown/terminal 与 partition 变化会清除 pending guidance/help。
- `memory_get` / `memory_list` current 通过共享 `classifyMemoryFactAdmission()` 返回结构化 `admittedFacts` 与 `revalidationCandidates`；Context 复用同一 gate，ToolResult → ModelInput 回归确认不再存在普通 `facts` 混装。
- Lifecycle Memory event 改用 `source="lifecycle"` 且无 ToolCall ID；多 fact 的 Store apply 部分失败会提交全部 lifecycle events、记录 `memory_materialization_failed` 并把成功 outcome 降为 failed，事件可作为 rebuild 权威。
- Memory Trace 已新增 selected/rendered/omitted 三层字段，tiny budget 回归确认空文本时 rendered IDs 为空。

### 剩余阻塞

#### P1 — deferred help 在多调用 Tool turn 的第一项后仍会切到 `waiting_user`，随后继续执行剩余项

位置：`packages/runtime/src/run-controller.ts:1220-1285`，尤其 `1253-1257`。

`flushDeferredMonitorHelp()` 现在位于每个 entry 执行之后。它提交 `user.input.requested` 后，代码只检查 failed/rejected、paused、finished，没有处理 `waiting_user`，于是 for-loop 会继续下一 entry。下一项若是 Planning/Memory/Computer call，其事件要求 `running`，会再次出现状态异常；即使某入口未立即抛错，也违反 help 应在安全边界暂停而不是继续执行同一模型 turn 的剩余调用。

最小修复：在 flush 后若进入 `waiting_user`，必须停止当前 turn，并明确处理 `nextIndex`：要么保存/失效 `pendingToolTurn`，等待用户输入后按 correction 规则拒绝剩余项；要么只在整个 Tool turn 完成后 flush help。补一个合法多调用 turn（例如 Memory/Plan + Computer 或 batch 两项）反例，断言 help 后没有继续执行剩余调用、没有重复 execute，用户响应后的剩余 call 有确定的执行或 superseded 事件。

#### P2 — Trace omission helper 会把被预算省略的 entity ID 伪装成 admitted fact ID

位置：`packages/context/src/projections.ts:71-83`。

`RenderRecord` 的 entity 记录有 `id` 但没有 `class`。`rememberOmitted()` 当前在 `record.class === undefined` 时仍写入 Map，并用 `class ?? "admitted"`，因此一个因预算放不下的 entity index/hot record 会出现在 `memorySelection.omitted`，被错误标成 admitted fact。Trace schema 的该数组语义是 admitted/revalidation fact，不应混入 entity。

最小修复：只有同时存在 `id` 和 `class` 时才写 fact omission；若需要跟踪 entity omission，应使用独立 kind/class 字段。补 entity-only crowded/tiny budget 的 `DefaultContextCompiler.compile()` 回归，断言 entity ID 不进入 fact omission，实际 rendered/omitted 与 ModelInput 一致。

### 定点放行结论

`ba97878` 已关闭上轮五项中的主体风险及 shadow append 异常，但上述多调用 help 是真实控制流阻塞，当前 online Monitor 仍不能最终放行。Memory current/lifecycle 主链可条件放行；Trace 还需修正 entity omission 的 P2 后再宣称完全诚实。修复这两项后只需定点复核，不需要重开全仓审查。

后续 `eec591c` 与 Memory retrieval 生产链的最终专项复核见 [DEV-4 Memory retrieval 集成审查](./dev-4-retrieval-integration-review.md)。该报告确认本节两个剩余问题已经关闭，并记录 retrieval/factory 的新阻塞与放行边界；以专项报告的较新结论为准。

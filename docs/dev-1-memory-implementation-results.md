# DEV-1A Memory 实施记录

## 范围与基线

本记录对应分支 `codex/dev1-context-memory-diagnostics`，只覆盖 Memory 的 F03/F10：mutation、replacement、Planning task 引用、文件 schema 和长度校验。未调用真实 API、桌面或 VM，未 push。

修改前的真实 Memory 反例 focused 基线为 6 项失败：Memory 文件 schema/长度/工具输出 3 项，以及 Runtime Planning off/on task 引用和 foreign entity replacement 3 项。

## 已实现合同

- `packages/protocol/src/index.ts` 提供共享 `MEMORY_LIMITS`、`validateMemoryMutation` 和 fact 语义内容比较。Runtime 和 MemoryStore 复用同一 mutation shape/length/unknown-field 合同，避免 Runtime 反向依赖 Memory。
- `packages/memory/src/index.ts` 在 reducer 和持久化写入前校验 mutation、state、ID 碰撞、replacement、entity subject、状态、序列、字段长度及 relatedTaskIds 的 shape；Store 没有 Plan 上下文，因此只做 task-link 的 shape 校验，task ID 是否存在由 Runtime 按当前 Run 的 Planning snapshot 校验。
- `packages/runtime/src/run-controller.ts` 在 `memory.updated` 前（含 provenance 重戳后）校验完整 mutation，再校验当前 Run 的 entity/task/reference 语境。非法 mutation 不产生 `memory.updated`，也不调用 `afterMemoryCommit`。
- active fact ID 的 `upsert_fact` 只有除 Runtime 重戳 `sourceEventId`/`updatedSequence` 外完全同值时才允许幂等 refresh；内容变化必须使用 `supersede_fact`，不会覆盖旧 fact。
- 文件 schema 保留明确 legacy 兼容：缺失 fact `subject` 默认 run，缺失 entity `sourceEventId` 默认 `legacy:entity-source`；存在的畸形字段仍拒绝。

## 回归与验证

`packages/memory/src/index.test.ts` 为 6/6，`packages/memory/src/runtime-regression.test.ts` 最新为 13/13，即 Memory 2 files、19/19。Runtime 回归通过真实 RunController 和自定义 ToolDefinition 覆盖：

- nested unknown field、超长 key、非法 status：无对应 `memory.updated`，tool failed，旧 snapshot/store 不变；
- Planning off/on 下新 fact、同值 fact、replacement 的未知 task link：提交前拒绝；
- replacement 的 foreign entity subject：提交前拒绝；
- active-ID 异值 upsert：提交前拒绝；同值但 provenance 不同的 upsert：成功；
- 官方 `memory_write_fact` 按完整 subject/key/value/relatedTaskIds 语义决定分支；Planning on + 两个已知 task 的同值换 links 回归确认生成 `supersede_fact`，旧 fact 为 superseded、新 replacement active，且 change call 不失败。

Memory focused 最新为 `index.test.ts` 6/6 加 `runtime-regression.test.ts` 13/13，即 2 files、19/19。此前受影响联合 focused 的 89/89 是 producer 修复前结果；本次按父任务只复跑 Memory focused，未重新运行全量联合命令。protocol/runtime/memory 三包 build 曾在 producer 修复前通过。

## 限制

未运行全仓 tsc/build；未实现 DEV-3 ContextTrace/tokenizer、DEV-4 scope 生命周期/引用重放/真值语义，也未扩展 Memory 语义推断能力。

# DEV-5 Monitor foundation + bounded online 实施结果

日期：2026-09-18
文档角色：结果
状态：foundation 与 bounded online consumer 已实现；`ba97878`/`eec591c` 完成边界修复，仍未完成 DEV-5 整体验收
范围：`packages/runtime/src/progress-monitor.ts`、`monitor-policy.ts`、`run-controller.ts` 及对应 focused 测试；不实现视觉语义、stop 执行权或真实 API/桌面验证。

## 1. 当前结论

本检查点建立了有界、只读的 Progress/Stall candidate foundation。`reduceProgressMonitor` 逐个消费已提交 `RuntimeEvent`，返回新状态与脱敏输出；它不执行动作、不创建模型请求、不改变 approval/Host deny/unknown barrier，也没有 stop、retry 或 guidance 字段可被误当成在线控制命令。

在 `294cdf5`/`adea8d7` 后，`ba97878` 将 policy 接入同一 Runtime 提交路径，并补齐 shadow/过时候选、deferred help、Memory/lifecycle/Trace 边界；`eec591c` 进一步保证 help 在同一合法 multi-call turn 中建立 Inbox 后立即停止，保存 remaining `nextIndex`。模式为 `off|shadow|guidance`，默认 `off`；shadow 只记录候选，不改 Context、调度或状态。

当前输出只有 `candidate`、稳定 reason code、evidence kind、相关 `eventId`。状态只保留有界 observation binding、action receipt 状态、私有 action signature 和 Plan/Memory 更新 event id；不保留 typed text、URL、截图正文、模型文本或 receipt message。

## 2. 内部合同

- 可比较分区由 session opaque hash 与 viewport `coordinateSpace/width/height` 组成；变化的 `observationId` 不进入 action equality signature。
- action signature 使用本地 SHA-256 opaque hash；`click/double_click/right_click/scroll/drag/wait` 使用规范化结构，`type`/`keypress` 的完整动作值只作为瞬时 hash 输入，不进入状态、输出或可分享摘要。
- 重复判断只看有界 history 中同分区的连续签名尾部；未执行/被拒 proposal 只报告 `repeated_proposal`，只有连续已完成 receipt 才报告 `repeated_action`。
- 当前公开 Observation 没有稳定 target/generation producer，因此不伪造 target 绑定；视觉特征固定报告 `visual_feature_unavailable`。缺图/无图像算法只产生 unknown evidence，不直接产生停滞结论。
- 候选条件包括同分区重复 action、A-B-A、重复 refusal/failure、没有成功 action 期间的 Plan/Memory update churn，以及 `outcome_unknown`。重复 action 仅是 candidate，不是 stop；Plan/Memory 缺失不推断 stalled；unknown outcome 不触发 retry。
- 当前启发式阈值是连续 3 次相同 action、2 次 refusal/failure、A-B-A，或 3 次 Plan/Memory update churn；它们都只是候选，不是页面真值。没有稳定视觉特征 producer 时不猜测视觉进展；shadow 不干预，候选过时只 clear。`guidance`/`help_requested` 不会绕过 approval、Host deny、unknown side-effect barrier。
- runId 改变时完整 reset；observation/action/update history 有上限并按最旧项淘汰；viewport/session 分区改变时不跨分区比较，并清理 churn window。

## 3. 实际验证

使用 Node.js `24.19.0`、pnpm `11.19.0`；修复后实际 focused 命令为：

```powershell
pnpm run typecheck
pnpm exec vitest run packages/runtime/src/monitor-policy.test.ts packages/runtime/src/index.test.ts packages/memory/src/index.test.ts packages/memory/src/runtime-regression.test.ts packages/context/src/index.test.ts packages/trajectory/src/index.test.ts
```

结果：`typecheck` 通过；`ba97878` 后 6 个 focused files/147 tests 通过，`eec591c` 加入同 turn stop 与 entity-only Trace 回归后再次为 6 files/149 tests 通过。覆盖 shadow 无 help、候选过时 clear、guidance/help barrier、proposal append failure 不改业务 outcome、完整 action→ToolResult→post-observation help 顺序、合法 Plan/Memory→GUI multi-call 不继续执行、Memory ToolResult 分区、lifecycle source/Store 部分失败、tiny-budget 实际渲染 IDs 与 schema 兼容。

## 4. 交付边界与后续

本批是 DEV-5 foundation 加 bounded online consumer，不是 online Monitor 完整验收。`help_requested` 只能由 Controller 在完整动作链后送入既有 `waiting_user`/Inbox；Monitor 不拥有 GUI 执行权，不自动 retry/approve/stop，不把模型自报、Plan 缺失、receipt 或 screenshot ID 当作视觉真值。当前未运行最终 full、真实模型 API、桌面、VM、视觉 feature 或 development/validation 效果集。

## 5. Sol 定点复核与后续

独立集成审查记录见[DEV-4/5 集成审查](./dev-4-5-integration-review.md)，`ba97878`/`eec591c` 针对其中的 shadow 误升级、action 原子链、Memory current 分区、lifecycle source/materialization、Trace 实际渲染、deferred multi-call stop 和 entity omission 完成定点修复；该审查文档本身未改写，后续仍需 Sol 定点确认。DEV-5 的误报/漏报、视觉特征、跨 Run/target/generation、stop policy 和真实效果评估仍待后续批次。

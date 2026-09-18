# DEV-5 Monitor foundation 实施结果

日期：2026-09-18
文档角色：结果
状态：离线 foundation focused 回归通过；尚未接入 Runtime online consumer
范围：仅 `packages/runtime/src/progress-monitor.ts` 与 focused 测试；不修改 Runtime 入口、contracts、controller 或 protocol。

## 1. 当前结论

本检查点建立了有界、只读的 Progress/Stall candidate foundation。`reduceProgressMonitor` 逐个消费已提交 `RuntimeEvent`，返回新状态与脱敏输出；它不执行动作、不创建模型请求、不改变 approval/Host deny/unknown barrier，也没有 stop、retry 或 guidance 字段可被误当成在线控制命令。

当前输出只有 `candidate`、稳定 reason code、evidence kind、相关 `eventId`。状态只保留有界 observation binding、action receipt 状态、私有 action signature 和 Plan/Memory 更新 event id；不保留 typed text、URL、截图正文、模型文本或 receipt message。

## 2. 内部合同

- 可比较分区由 session opaque hash 与 viewport `coordinateSpace/width/height` 组成；变化的 `observationId` 不进入 action equality signature。
- action signature 使用本地 SHA-256 opaque hash；`click/double_click/right_click/scroll/drag/wait` 使用规范化结构，`type`/`keypress` 的完整动作值只作为瞬时 hash 输入，不进入状态、输出或可分享摘要。
- 重复判断只看有界 history 中同分区的连续签名尾部；未执行/被拒 proposal 只报告 `repeated_proposal`，只有连续已完成 receipt 才报告 `repeated_action`。
- 当前公开 Observation 没有稳定 target/generation producer，因此不伪造 target 绑定；视觉特征固定报告 `visual_feature_unavailable`。缺图/无图像算法只产生 unknown evidence，不直接产生停滞结论。
- 候选条件包括同分区重复 action、A-B-A、重复 refusal/failure、没有成功 action 期间的 Plan/Memory update churn，以及 `outcome_unknown`。重复 action 仅是 candidate，不是 stop；Plan/Memory 缺失不推断 stalled；unknown outcome 不触发 retry。
- runId 改变时完整 reset；observation/action/update history 有上限并按最旧项淘汰；viewport/session 分区改变时不跨分区比较，并清理 churn window。

## 3. 实际验证

使用 Node.js `24.19.0`、pnpm `11.19.0`：

```powershell
pnpm exec vitest run packages/runtime/src/progress-monitor.test.ts
pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --exactOptionalPropertyTypes --skipLibCheck packages/runtime/src/progress-monitor.ts
```

结果：focused Vitest 1 个文件、9 项测试通过；模块隔离 TypeScript 检查退出码 `0`。测试覆盖正常重复不直接 stop、A-B-A 分区、重复 refusal、同长度不同 text/key、proposal 与 executed 区分、连续签名窗口、Plan/Memory churn、无 Plan 短任务、缺图 unknown、geometry 分区、首次事件绑定 runId、bounded eviction/run reset、unknown outcome 与 typed text 不落状态/输出。

尝试运行 `pnpm --filter @computer-harness/runtime build` 时，工作树中其他 worker 正在编辑的 shared `protocol`/`runtime contracts`/`run-controller` 尚未同步，现有错误为缺失 `PreparedRequestEstimate`、`PreparedRequestMetadata` 及 `PreparedProviderRequest.payloadHash/estimate`；错误不指向本模块。未把该失败记作 foundation focused 失败，也未修改这些共享文件。

## 4. 交付边界与后续

本批是 DEV-5 commit A 的 offline action signature/comparator/feature-absence foundation，不是 online Monitor 完整验收。尚未有 Runtime consumer、shadow event sink、guidance cooldown/budget、help/stop consumer、视觉 bytes feature producer 或 development/validation 数据集。后续接入必须由共享合同明确 producer/consumer/persistence/cleanup，并保持 Monitor 不拥有执行权；真实在线效果、误报/漏报和干预收益不能由本批 7 项 focused 测试宣称。

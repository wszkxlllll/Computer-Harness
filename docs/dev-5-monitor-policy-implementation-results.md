# DEV-5 Monitor policy foundation 实施记录

状态：本批只交付离线、纯状态的 Monitor policy foundation；未接入 Runtime Controller、Context、Protocol、app-runtime 或在线 guidance consumer，不声称 DEV-5 online/干预验收完成。未调用真实 API、桌面、VM 或 `.env`。

## 合同与边界

- `monitor-policy.ts` 只消费既有 `ProgressMonitorOutput`，不读取模型正文、typed text、URL、截图字节，也不拥有 GUI/Provider 执行权。
- `mode=off` 默认不提议；`shadow` 只保留候选状态并返回 `none(shadow)`；`guidance` 才可提议短 guidance。
- 输出只有 `none`、`guidance`、`help_requested`。没有 `stop_required`，因为本批没有明确 Runtime consumer。`help_requested` 也只是提议，Controller 独占后续消费。
- `outcome_unknown` 或 Runtime 传入未决副作用 barrier 时，hard barrier 优先，输出 `none(suppressed_by_execution_barrier)`；不 retry、不 approve、不 execute，也不把已终态 Run 伪装成 `waiting_user`。
- cooldown、candidate age 和 guidance 次数使用显式 `modelDecisionCount` / `guiActionCount` 的 work clock；提交 event `sequence` 只用于重放/乱序幂等，不推进 cooldown。`partitionKey` 变化或跨 Run 会清理候选与 guidance 计数。
- 候选 fingerprint 只由 reason code/evidence kind 构成，同一候选不会因新的 event ID 每次重复 guidance；输出文字有字符上限且只含安全分类名。超龄或 guidance budget 耗尽时最多提出一次 help，等待未来 consumer 决定。

## Producer / consumer

当前 producer 是现有 `ProgressMonitorOutput` 离线 reducer；本批 consumer 只有新模块的测试/序列化 helper。后续 Runtime 集成必须显式传入 committed sequence、run/session partition、work clock 和 execution barrier，再决定是否把 guidance 附加到下一次正常请求；不得通过模型文本冒充强制控制或绕过既有审批/unknown 屏障。

## 变更文件

- `packages/runtime/src/monitor-policy.ts`
- `packages/runtime/src/monitor-policy.test.ts`
- `docs/dev-5-monitor-policy-implementation-results.md`

## 离线证据

```text
pnpm exec vitest run packages/runtime/src/monitor-policy.test.ts
  6 tests passed
pnpm run typecheck
  passed
```

覆盖 off/shadow、work-clock cooldown、event-sequence 噪声不推进节流、候选超龄、guidance budget/help、unknown execution barrier、重放/乱序、跨 Run/partition reset、bounded serialization，以及不产生 stop/retry/execute 语义。

## 未完成

本批没有在线状态回访、Runtime event 持久化、Controller/app-runtime consumer、guidance 注入 Context、help UI、停止策略、效果对照或误报/漏报评测；这些属于后续 DEV-5 集成与验证批次。

## Online integration foundation（本批）

本批已把上述纯 policy 接入同一 Runtime 提交路径，但仍不声称 Monitor 效果验收：

- `RunController.commitEvent` 在原事件 append/reduce/feed 通知后旁路推进 foundation/policy；`monitor.proposal` 自身被过滤，避免递归。默认 `monitor=off` 不创建 state、不写 event、不改变 Context。
- 新 `monitor.proposal` 只持久脱敏 mode/proposal/fingerprint/source IDs/reason/evidence/work clock 与有界 guidance 文本；Trajectory reducer no-op，旧事件 schema 继续可读。shadow 只记录有界候选提议。
- 首次 model attempt 与 terminal action receipt 推进 work clock；retry、trace、monitor event 不推进。guidance 进入下一次正常 Context 的 dynamic user block，不进入 system/tools/stable prefix；预算不足时省略并在 Trace/ContextBudget 标记 `monitorGuidanceOmittedReason=budget`。
- `help_requested` 由 Controller 通过既有 `user.input.requested`/`waiting_user`/Inbox 消费；unknown/abort/approval/unresolved action barrier 优先，Monitor 不 retry、approve、execute 或重开终态。

离线验证：runtime/context/trajectory/CLI focused 共 5 files / 123 tests passed，`pnpm run typecheck` passed；CLI `--help` 展示 `--monitor off|shadow|guidance`。未调用真实 API/桌面/VM，未运行 full suite。

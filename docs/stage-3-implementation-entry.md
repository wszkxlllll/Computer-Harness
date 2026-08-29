# Stage 3 实施 Agent 唯一入口：CuaDriverComputer

日期：2026-08-29

## 目的

在已经通过 Fake Runtime 门禁的 `Computer` 接口上接入一个真实、可观测的 CUA daemon
Backend。Stage 3 只验证“Runtime 能否可靠地观察并执行一个真实 GUI 世界”，不同时优化模型或
扩展产品能力。

## 必读顺序

1. [`stage-2-implementation-entry.md`](./stage-2-implementation-entry.md)：确认当前 Runtime
   合同和已通过的 59 项门禁；
2. [`stage-2-s0-audit-and-gates.md`](./stage-2-s0-audit-and-gates.md)：阅读 S3-0 收口结果和
   Stage 3 的 Frame 新鲜度约束；
3. [`stage-0-exit-and-code-quality-review.md`](./stage-0-exit-and-code-quality-review.md)：只
   读取已验证的 CUA daemon、截图和坐标空间事实；
4. [`gui-agent-harness-v1-technical-plan.md`](./gui-agent-harness-v1-technical-plan.md)：按
   Computer、Observation、Action 和生命周期章节实现，不恢复历史的 `status` 或私有
   `driverRef` 字段。

## 本阶段只做什么

实现一个 `CuaDriverComputer`，满足当前 `Computer` 接口：

- `open()` 建立一个明确的 daemon session，返回不可变的 `ComputerSession` 描述；
- `observe()` 获取完整截图和准确的 `Viewport`，把底层 Frame Reference 保存在 Adapter 私有
  的 `ObservationId → FrameRef` 映射中；
- `execute()` 只接受经过 Runtime Action 校验的动作，并在 Adapter 内检查 Session、Frame
  新鲜度和 CUA 坐标语义；
- `close()` 释放 session、Frame 映射和 daemon 资源；失败通过 Runtime 的 cleanup diagnostic
  可观察，不改写既定 RunOutcome。

## 明确不做

- 不接入真实 Provider、Prompt、Verifier、Task Planner 或 Dashboard；
- 不把 CUA 私有句柄放进 Protocol、ObservationFrame 或 RuntimeEvent；
- 不把新的坐标换算、DPI 例外写成工具特例；坐标空间必须由 Observation/Session 的
  `Viewport` 描述；
- 不在 Runtime 中自动重试未知 GUI 副作用；Frame 过期时拒绝旧动作并要求重新 Observe；
- 不实现 ReplayComputer、远程 VM、后台 Job、Subagent 或多 Computer 并发。

## 阶段门禁

先用一个固定的本地 GUI 应用完成以下 contract test，再考虑真实模型：

1. `open → observe → execute → observe → close` 的 Event 顺序和资产落盘完整；
2. Observation 的截图尺寸、Viewport 坐标空间和实际桌面一致；
3. 合法 click/type/keypress/scroll/drag 可以执行，越界坐标和不支持的能力在副作用前拒绝；
4. 新 Observation 产生后，旧 Frame Reference 被拒绝，不把旧坐标静默绑定到新画面；
5. Driver 断连、observe/execute/close 失败和取消均有可诊断结果；未知副作用不自动重试；
6. 通过 `pnpm run typecheck`、`pnpm test`，并保留一份不含隐私截图的运行摘要。

Stage 3 通过后，下一阶段才定义真实 Provider 的 Asset 读取、ModelTurn 适配和 Context 预算。

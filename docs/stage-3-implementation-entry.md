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
5. [`stage-3-cua-capability-audit-and-provider-boundary.md`](./stage-3-cua-capability-audit-and-provider-boundary.md)：
   先完成 CUA 能力探测、`scroll` 语义和两级 Frame 新鲜度决策，再创建正式 Adapter package。
6. [`stage-3-s1-capability-probe-results.md`](./stage-3-s1-capability-probe-results.md)：查看已完成的
   嵌入式/独立 daemon 只读探针事实，区分“API 可调用”和“GUI 行为已验证”。

## 实施顺序

Stage 3 不再直接从 Adapter 编码开始，按以下四步执行：

1. **S3-1 能力探针**：基于锁定的 CUA 0.22.2 记录工具 Schema、目标/坐标、ActionResult、
   `verify_state`、取消和生命周期事实。当前已完成无副作用的清单/版本/健康/权限/生命周期
   子探针；动作与观察子探针仍待授权；
2. **S3-2 协议决策**：只修实测阻塞项，当前已知至少包括 scroll 落点/粒度和两级 Frame
   新鲜度；
3. **S3-3 正式 package**：在 `packages/computer-cua` 实现
   `@computer-harness/computer-cua`；
4. **S3-4 live contract test**：真实 daemon 完成动作矩阵、20 轮稳定性和故障门禁。

## 本阶段只做什么

实现一个 `CuaDriverComputer`，满足当前 `Computer` 接口：

- `open()` 建立一个明确的 daemon session，返回不可变的 `ComputerSession` 描述；
- `observe()` 获取完整截图和准确的 `Viewport`；仅当所用 CUA 路径真实返回 snapshot/token 时，
  才在 Adapter 私有映射中关联 `ObservationId`，桌面截图不伪造 Frame Reference；
- `execute()` 只接受经过 Runtime Action 校验的动作，并在 Adapter 内检查 Session/generation
  与 CUA 坐标语义；窗口 element token 使用 Driver 的强 stale 校验，桌面像素动作只承诺
  Harness latest-Observation 绑定，不虚构 Driver Frame token；
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
4. 新 Observation 产生后，Harness 中旧 `ObservationId` 被拒绝；窗口 element token 还必须由
   Driver 拒绝过期引用。桌面像素路径没有 Driver Frame token，pause/approval/correction 后应
   重新 Observe 和重规划；
5. Driver 断连、observe/execute/close 失败和取消均有可诊断结果；未知副作用不自动重试；
6. 通过 `pnpm run typecheck`、`pnpm test`，并保留一份不含隐私截图的运行摘要。

Stage 3 通过后，下一阶段才定义真实 Provider 的 Asset 读取、ModelTurn 适配和 Context 预算。

## 当前进度（2026-08-29）

S3-1 的无副作用能力子探针已在嵌入式 SDK 与独立 daemon 各完成一次：两条路径的
`metadata`、工具清单、命名 session 读写、host session 摘要、健康和权限检查均成功。
嵌入式路径返回 56 个工具、daemon 返回 57 个工具；命名 session 默认剩余约 299 秒。
独立 daemon 的无输入截图复核也已通过：当前主显示器报告和 PNG 均为 `2560×1600 @ 1.5`；
嵌入式路径仍不得使用。坐标、输入动作、`ActionResult`、`verify_state` 或取消/过期尚未完成，
因此正式 `CuaDriverComputer` 仍不得开始。下一步是 S3-2 的小范围协议决策实验，优先使用
独立 daemon，所有 GUI 副作用必须得到明确授权并使用可恢复的本地测试窗口。

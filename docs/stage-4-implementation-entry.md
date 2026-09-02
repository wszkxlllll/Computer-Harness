# Stage 4：双路线协调入口

状态：当前总入口（2026-09-02）

Stage 4 分成两条互不覆盖的路线：

| 路线 | 唯一入口 | 目标 |
|---|---|---|
| A：Windows 本地任务 | [stage-4-local-task-implementation.md](./stage-4-local-task-implementation.md) | 在专用 Windows fixture 上验证 Harness + CUA + Provider 的真实闭环 |
| B：OSWorld 环境迁移 | [osworld-environment-implementation.md](./osworld-environment-implementation.md) | 维护官方 OSWorld 环境、评分/reset，并研究 Harness 分离和迁移 |

两条路线可以并行准备，但 A 的宿主桌面输入必须独占；B 不操作 `dase_lab`、不安装客体 CUA，
不修改 A 的 Runtime/Provider/Context/Tool 或 `.env`。两条路线各自产出结果，协调信息只更新本文。

## 当前模型范围

现行代码只保留：

- `glm-5.3-flash` → `packages/provider-glm`；
- `gui-plus-2026-02-26` → `packages/provider-qwen`。

`glm-4.6v-flash` 已从现行 profile、CLI、conformance runner、Stage 4 manifest 和活动命令移除。旧实验
结果和协议探针保存在本地 `docs/history/`，作为不可变证据，不提交、不覆盖、不恢复为新命令。

## 已确认的共同基线

- 核心循环：`Observe → Context → Provider → ModelTurn → Tool/Action 校验 → Computer → Observe`。
- `packages/protocol` 只放跨模块合同；`packages/runtime` 管 Run、预算、ToolCall 路由和取消；
  `packages/context` 管时序投影；Provider 只负责 API 协议和模型输出映射。
- `ActionIntent` 表示模型决定，`ActionReceipt` 表示 Computer 实际执行结果；两者不等同于任务完成。
- Event 先写 execution started，再执行副作用，最后写 completed/failed；未知副作用默认重新观察，不能自动重试。
- 当前本地回归为 `pnpm test` 95/95、`pnpm run typecheck` 通过；这不等于真实模型或 OSWorld 任务成功率。

## 当前门槛与顺序

1. 先处理总体审计中的 P0：动作后观察失败时补齐 ToolCall 终态；冻结 Qwen native/text wire 对照；补齐
   GLM-5.3 多轮 `reasoning_content` 呈现。
2. Qwen 对照实验只放在临时 `scripts/experiments/qwen-wire-paired.ts`，同一冻结输入分别跑
   `native` / `official-text`，结果分目录保存；只把通用结论提升到 Provider PR。
3. A 再运行当前 manifest 的 3 个短任务 × 2 个模型，共 6 个正式 Run；B 同步完成 OSWorld 的 B4 迁移探索。
4. 两条路线分别通过自己的验收后，协调方再发布 Stage 5 的 Harness 接入任务；不能用环境安装通过代替
   Harness 端到端通过。

## 文档和证据规则

- 实施 Agent 先读本文，再只读自己路线的入口；不要按历史文件名自行选择命令。
- 当前总体审计为
  [runtime-trajectory-cua-adapter-issues-2026-09-02.md](./trajectory-review-2026-09-02/runtime-trajectory-cua-adapter-issues-2026-09-02.md)。
- 结果、截图、凭据和本机路径不写进公共 Protocol，不提交隐私截图或 `.env`。
- 新实验必须使用独立输出目录，保留完整 Event、请求/动作/延迟/成本、外部评分和清理状态；不覆盖历史证据。
- 不针对单个 bad case 反复添加 Prompt 补丁；先判断是基础设施、协议、Context、Tool、模型、任务定义还是评分器问题。
- 文档状态、入口、生产者/消费者和下一步必须唯一；历史文档只用于追溯，不作为实施指令。

## 本阶段不做

Memory、长期 Compact、Verifier、RL、后台 Job、Subagent、Dashboard、第三 Provider、CUA 自动安装和跨平台
生产 Adapter 都不属于当前 Stage 4 施工范围。


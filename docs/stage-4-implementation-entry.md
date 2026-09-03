# Stage 4：双路线协调入口

状态：当前总入口（2026-09-03）

Stage 4 分成两条互不覆盖的路线：

| 路线 | 唯一入口 | 目标 |
|---|---|---|
| A：Windows 本地任务 | [stage-4-local-task-implementation.md](./stage-4-local-task-implementation.md) | 在专用 Windows fixture 上验证 Harness + CUA + Provider 的真实闭环 |
| B：OSWorld 环境迁移 | [osworld-environment-implementation.md](./osworld-environment-implementation.md) | 维护官方 OSWorld 环境、评分/reset，并研究 Harness 分离和迁移 |

两条路线可以并行准备，但 A 的宿主桌面输入必须独占；B 不操作 `dase_lab`、不安装客体 CUA，
不修改 A 的 Runtime/Provider/Context/Tool 或 `.env`。两条路线各自产出结果，协调信息只更新本文。

## 当前模型范围

现行活动代码包含：

- `glm-5.3-flash` → `packages/provider-glm`；
- `qwen3.8-flash` → `packages/provider-qwen`。Qwen3.8 已通过终止语义修复、静态回归和删除后的 alpha；GUI-Plus 已退出活动代码。

GUI-Plus 只保留在 Git 历史和历史实验说明中，不再作为 CLI、runner、manifest 或 conformance 的可选模型。

`glm-4.6v-flash` 已从现行 profile、CLI、conformance runner、Stage 4 manifest 和活动命令移除。旧实验
结果和协议探针保存在本地 `docs/history/`，作为不可变证据，不提交、不覆盖、不恢复为新命令。

## 已确认的共同基线

- 核心循环：`Observe → Context → Provider → ModelTurn → Tool/Action 校验 → Computer → Observe`。
- `packages/protocol` 只放跨模块合同；`packages/runtime` 管 Run、预算、ToolCall 路由和取消；
  `packages/context` 管时序投影；Provider 只负责 API 协议和模型输出映射。
- `ActionIntent` 表示模型决定，`ActionReceipt` 表示 Computer 实际执行结果；两者不等同于任务完成。
- Event 先写 execution started，再执行副作用，最后写 completed/failed；未知副作用默认重新观察，不能自动重试。
- 当前删除后本地回归为 `pnpm test` 101/101、`pnpm run typecheck`、runner contract 和 lifecycle check 通过；真实 API
  conformance 与 Qwen3.8 三题 attended 工程门的历史证据仍保留在 `runs/`，不等于通用模型或 OSWorld 任务成功率。

## 当前门槛与顺序

P0 的当前代码基线、PR 拆分和验收细节以
[P0 开工就绪复审](./trajectory-review-2026-09-02/p0-readiness-reaudit-2026-09-02.md) 为准。

1. P0-1（动作后观察失败的事实顺序）和 P0-3（GLM 多轮 `reasoning_content`）的代码、Trajectory round-trip、
   lifecycle suite、更新后的 GLM 两轮 API conformance 与一组历史 attended GUI-Plus smoke 均已通过。Qwen/GLM per-tool
   Function Schema 不再作为阻塞项。
2. 已完成的 GUI-Plus paired 实验入口已归档到本地 `docs/history/legacy-experiments/`，不再作为活动命令；Qwen3.8
   坐标校准脚本仍保留用于后续 Provider 变更时的受控复核。
3. 在坐标实验前保留对 Qwen/GLM 工具 description、条件 required、Viewport 坐标边界、未知工具拒绝和 Runtime
   二次校验的回归；这些 Schema 检查已通过，后续只比较坐标变量，避免混淆结果。
4. A 的 GLM 三个任务外部验收均通过；Qwen3.8 已完成 conformance、坐标修复、三题 attended 工程门和显式
   `terminate` 终止语义修复。修复后的 alpha 首次因模型返回非法 `x` 数组而失败，受控重试通过；删除后的 alpha
   也通过，Runtime 与外部 evaluator 一致成功。GUI-Plus 活动实现随后已独立删除，历史结果不变。
   B 可同步完成 OSWorld 的 B4 迁移探索。
5. GUI-Plus 删除已按专项审计顺序完成：baseline `2d6eff1`、终止语义修复 `c8167ed`、活动代码删除
   `1dce442`；删除后的静态回归和 Qwen3.8 alpha 均通过。
6. 两条路线分别通过自己的验收后，协调方再发布 Stage 5 的 Harness 接入任务；不能用环境安装通过代替
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

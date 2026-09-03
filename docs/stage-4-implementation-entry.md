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
- `gui-plus-2026-02-26` → `packages/provider-qwen`；
- `qwen3.8-flash` → `packages/provider-qwen`。Qwen3.8 已通过三题工程门，等待终止语义修复和独立删除提交。

`glm-4.6v-flash` 已从现行 profile、CLI、conformance runner、Stage 4 manifest 和活动命令移除。旧实验
结果和协议探针保存在本地 `docs/history/`，作为不可变证据，不提交、不覆盖、不恢复为新命令。

## 已确认的共同基线

- 核心循环：`Observe → Context → Provider → ModelTurn → Tool/Action 校验 → Computer → Observe`。
- `packages/protocol` 只放跨模块合同；`packages/runtime` 管 Run、预算、ToolCall 路由和取消；
  `packages/context` 管时序投影；Provider 只负责 API 协议和模型输出映射。
- `ActionIntent` 表示模型决定，`ActionReceipt` 表示 Computer 实际执行结果；两者不等同于任务完成。
- Event 先写 execution started，再执行副作用，最后写 completed/failed；未知副作用默认重新观察，不能自动重试。
- 当前本地回归为 `pnpm test` 112/112、`pnpm run typecheck`、runner contract 和 lifecycle check 通过；真实 API
  conformance 也已完成（GLM-5.3-Flash、Qwen GUI-Plus 各两轮原生 Function Calling，HTTP 200，无 CUA/桌面副作用）。
  证据在 `runs/api-conformance/function-schema-live-20260903/summary.json`；这不等于真实模型或 OSWorld 任务成功率。

## 当前门槛与顺序

P0 的当前代码基线、PR 拆分和验收细节以
[P0 开工就绪复审](./trajectory-review-2026-09-02/p0-readiness-reaudit-2026-09-02.md) 为准。

1. P0-1（动作后观察失败的事实顺序）和 P0-3（GLM 多轮 `reasoning_content`）的代码、Trajectory round-trip、
   lifecycle suite、更新后的 GLM 两轮 API conformance 与一组 attended GUI-Plus smoke 均已通过。Qwen/GLM per-tool
   Function Schema 不再作为阻塞项。
2. Qwen 对照实验只放在临时 `scripts/experiments/qwen-wire-paired.ts`，同一冻结输入分别跑
   `actual_pixels` / `normalized_1000`；脚本顺序调用现有 Stage 4 runner，结果分目录保存；只把通用结论提升到
   Provider PR。
3. 在坐标实验前保留对 Qwen/GLM 工具 description、条件 required、Viewport 坐标边界、未知工具拒绝和 Runtime
   二次校验的回归；这些 Schema 检查已通过，后续只比较坐标变量，避免混淆结果。
4. A 的 GLM 三个任务外部验收均通过，进入下一阶段作为主模型；GUI-Plus 停止继续做 Prompt/Schema 补丁并保留为
   临时负向基线。Qwen3.8 已完成 conformance、raw ToolCall/指标整改、normalized 边界修复与修正后的 3/3 无 CUA
   确认。按[专项复审](./qwen38-adapter-localization-audit-2026-09-03.md)，当前只放行固定
   `normalized_1000 + low thinking` 的 attended alpha。首次 alpha 在第一个 ToolCall 参数解析阶段失败且未执行动作；
   resize viewport 同步、完整 thinking 档位入口和本地脱敏 Provider exchange 记录现已补齐，只允许同配置诊断复跑一次。
   alpha 的 Runtime 与外部 evaluator 一致通过后，再跑同配置 beta/gamma。全部达到路线 A 文档的删除门后，直接从活动
   代码移除 GUI-Plus，但保留历史结果；不重跑已有 GLM。
   B 可同步完成 OSWorld 的 B4 迁移探索。
5. GUI-Plus 删除顺序按[专项审计第 7 节](./qwen38-adapter-localization-audit-2026-09-03.md#7-gui-plus-基线保留与删除计划复审)：
   脏工作树先形成 baseline commit，终止语义单独提交并验证一条 alpha，GUI-Plus 再单独删除；删除后除完整静态回归外，
   还需一条 Qwen3.8 alpha 验证真实装配。
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

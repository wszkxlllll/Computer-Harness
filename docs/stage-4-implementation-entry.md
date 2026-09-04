# Stage 4/5 Computer Harness 当前实施入口

日期：2026-09-04
文档角色：入口 / 交接
状态：当前执行
当前入口：本文件
基线：当前 `main` 工作树；Runtime、Provider、CUA/OSWorld 代码与测试以仓库实际状态为准
范围：Provider 输出协议、两条 Computer 路线、实验入口和结果记录

## 当前结论

核心 Runtime、Context、canonical ToolRegistry、CUA Adapter 和 OSWorld Bridge 已具备可测试闭环。Qwen3.8-Flash
已切换为默认 `strict_json` 输出；GLM-5.3-Flash 保持 native Function Calling。两条路线不能合并成一个桌面结论：

- A：本地 CUA/Windows 任务，见[本地路线](./stage-4-local-task-implementation.md)；
- B：OSWorld/VM 任务，见[OSWorld 路线](./osworld-environment-implementation.md)；
- Provider/快照/协议证据，见[最新总体审计](./stage-5-gate2-provider-entry-and-snapshot-audit-2026-09-04.md)。

## 已有基础

- `packages/runtime` 负责 Run 循环、命令 Inbox、预算、Action 生命周期和通用重试；
- `packages/context` 从 RuntimeEvent 投影模型上下文；
- `packages/provider-glm` 与 `packages/provider-qwen` 将 Provider 协议映射为统一 `ModelTurn`；
- Qwen `strict_json` 使用官方 `response_format.type=json_schema`、`strict=true`，不发送 native `tools`；它已按决策设为默认，
  但当前无副作用 probe 仅有 1/3 稳定，不能把默认选择写成稳定性结论；
- `packages/computer-cua` 和 `packages/computer-osworld` 分别连接本地 CUA daemon 与 OSWorld Bridge；
- 全量静态回归当前为 120/120，真实 Provider 结果必须以各自 runner、trajectory、evaluation 和清理记录为准。

## 本阶段目标

1. 保持 Qwen strict-json 与 GLM native-tools 的协议边界清晰；
2. 在无副作用探针和冻结环境上继续积累可比较的真实任务证据；
3. 记录每次请求的脱敏 Provider exchange、Runtime outcome、官方评分和清理结果；
4. 不让单个 Provider 的格式修补进入公共 Protocol、Runtime 或 Computer backend。

## 非目标与禁止操作

- 不在 Runtime Prompt 中加入 Provider 或单个 bad-case 专用格式指令；
- 不把非法数组、缺字段或普通文本猜测性转换成 GUI 动作；
- 不修改 OSWorld task/evaluator、快照或公共 `ActionIntent` 来迁就模型；
- 不把单任务 score 当作整体成功率；
- 不提交 `.env`、截图、VM 文件或 `runs/` 原始资产。

## 执行顺序与门槛

1. 已完成 3 次同条件 strict-json no-execute probe，但只有 1/3 成功；先收紧协议或评估 Provider 输出；
2. strict-json 稳定后，再在 B 路线扩展冻结任务，并与 GLM native-tools 做同条件比较；
3. A 路线独立验证本地 CUA 的屏幕、点击、输入和清理，不与 B 的评分混算；
4. 出现协议错误时保留原始错误和 `provider-exchanges.jsonl`，只在对应 Adapter 修复；
5. 只有重复任务表现稳定后，才考虑 Context、Memory、Verifier 或更复杂 Tool 能力。

## 产物与完成条件

每次运行至少保留：`summary.json`、`trajectory.jsonl`、`provider-exchanges.jsonl`、runner/evaluator 结果和清理诊断。
本入口完成的标准是：两条路线各有可复现命令、当前默认 Provider 明确、失败阶段可区分、文档索引无重复入口。

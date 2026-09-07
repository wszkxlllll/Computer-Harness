# Stage 4/5 Computer Harness 当前实施入口

日期：2026-09-07
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
- Provider/快照/协议证据，见[Stage 5 模型任务结果总表](./stage-5-model-task-results-2026-09-07.md)。

下一阶段完整施工顺序以 [Next gate 第 7 节](./stage-5-first-batch-analysis-and-next-gates-2026-09-07.md) 为准：P0/统计与 Planning + Context 并行开发、Planning 接通后开始第一轮效果实验、再开展 Context/Monitor、Memory/Advisor 与最终评测。本文保留两条 Computer 路线边界，不再以早期 Provider 探针作为增强模块开发的前置总门槛。

## 已有基础

- `packages/runtime` 负责 Run 循环、命令 Inbox、预算、Action 生命周期和通用重试；
- `packages/context` 从 RuntimeEvent 投影模型上下文；
- `packages/provider-glm` 与 `packages/provider-qwen` 将 Provider 协议映射为统一 `ModelTurn`；
- Qwen `strict_json` 使用 `response_format.type=json_schema`、`strict=true`，不发送 native `tools`；当前 GLM 30 条、Qwen 5 条任务结果见总体结果表。新增 Planning/Advisor 工具仍要验证 schema 与往返解析；
- `packages/computer-cua` 和 `packages/computer-osworld` 分别连接本地 CUA daemon 与 OSWorld Bridge；
- 旧阶段静态测试数字只代表当时版本；当前验证按实际代码与执行记录报告，真实 Provider 结果以 runner、trajectory、evaluation 和清理记录为准。

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

1. 按 Next gate 分工并行开发基础设施修复与 Planning/Context，公共合同和 CLI 由集成负责人协调；
2. 同版基础设施上的配对任务验证增强效果；不要求全量重跑或 Qwen 全面追平 GLM；
3. 本地 CUA 与 OSWorld 路线独立验证，不混算评分；同一 VM 的 reset 和真实操作串行；
4. 新工具在各 Provider 的格式错误由相应 Adapter 修复；保留原始失败；
5. Monitor 只提供脚本事实，没有独立 Replan/Verifier 阶段；效果实验和任务扩充时间遵循 Next gate。

## 产物与完成条件

每次运行至少保留：`summary.json`、`trajectory.jsonl`、`provider-exchanges.jsonl`、runner/evaluator 结果和清理诊断。
本入口完成的标准是：两条路线各有可复现命令、当前默认 Provider 明确、失败阶段可区分、文档索引无重复入口。

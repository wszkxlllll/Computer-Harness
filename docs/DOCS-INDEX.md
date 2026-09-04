# Computer Harness 文档索引

日期：2026-09-04
文档角色：入口
状态：当前执行
当前入口：本文件
基线：当前 `main` 工作树
范围：当前实施入口、长期设计、历史资料和实验产物边界

`docs/` 的唯一导航入口。实施 Agent 先读本文件，再只读取自己负责的当前路线文档；不要按文件名遍历整个目录。

## 当前实施入口

| 文件 | 用途 |
|---|---|
| [stage-4-implementation-entry.md](./stage-4-implementation-entry.md) | 两条 Computer 路线的共同边界、默认 Provider 和交接顺序 |
| [stage-4-local-task-implementation.md](./stage-4-local-task-implementation.md) | A：本地 CUA/Windows 任务 |
| [osworld-environment-implementation.md](./osworld-environment-implementation.md) | B：OSWorld/VM、Bridge、官方评分和真实任务 |
| [stage-5-gate2-provider-entry-and-snapshot-audit-2026-09-04.md](./stage-5-gate2-provider-entry-and-snapshot-audit-2026-09-04.md) | 最新 Provider、快照、协议和真实任务总体审计 |
| [stage-5-qwen-strict-response-contract-review-2026-09-04.md](./stage-5-qwen-strict-response-contract-review-2026-09-04.md) | Qwen strict-json 大 Schema 问题、精确分支合同、程序 ID 与 fail-closed 验收门 |
| [stage-4-local-tasks-2026-08-31.json](./stage-4-local-tasks-2026-08-31.json) | 冻结任务的机器可读 manifest |

## 全局设计与规范

| 文件 | 用途 |
|---|---|
| [development-documentation-standard.md](./development-documentation-standard.md) | 文档角色、证据、归档和提交规范 |
| [gui-agent-harness-v1-technical-plan.md](./gui-agent-harness-v1-technical-plan.md) | Protocol、Runtime、Provider、Computer、Context 和 Trajectory 技术基线 |
| [multimodal-gui-agent-harness-product-plan.md](./multimodal-gui-agent-harness-product-plan.md) | 产品定位和扩展边界 |
| [run-turn-tool-and-user-correction-semantics.md](./run-turn-tool-and-user-correction-semantics.md) | Run、Turn、Tool 和用户纠正语义 |
| [GUI Agent 多模态 Memory 与 Advisory Subagent 演进设计.md](./GUI%20Agent%20多模态%20Memory%20与%20Advisory%20Subagent%20演进设计.md) | 长期 Memory/Advisory 设计，当前不作为实施指令 |
| [面向视障场景的 GUI Agent 意图守护技术路线调整与系统设计.md](./面向视障场景的%20GUI%20Agent%20意图守护技术路线调整与系统设计.md) | 长期产品与研究方向 |

## 代码与实验入口

- `scripts/stage5-osworld/`：当前 OSWorld Bridge/真实任务 runner；
- `scripts/api-conformance.ts`：Provider 无副作用协议探针，默认 Qwen `strict_json`；
- `scripts/stage4-local/`：本地路线回归检查；
- `integrations/osworld/README.md`：OSWorld Bridge 的环境准备和命令细节；
- `runs/`：本地原始运行产物，包含可能敏感的截图，默认不跟踪、不提交。

## 历史资料

`docs/history/` 保存已完成阶段、被替代方案和旧审计；`scripts/history/` 保存已停止使用的实验脚本。它们只用于追溯，不是当前实施指令；如果历史结论
仍然有效，应先压缩到当前路线摘要，再让 Agent 执行。当前已归档：Stage 0–4 详细过程、Stage 5 S0/Gate2 中间文档、
旧 Qwen 坐标审计和 2026-09-02 Trajectory 审计。

提交时只包含本索引、全局设计/规范、两条路线摘要、最新总体审计和必要 manifest；`docs/history/`、`.env`、截图、VM
文件和 `runs/` 原始资产不提交。

## 更新规则

- 一个阶段只保留一个共同入口；每条路线只保留一个当前摘要；
- 新结果追加到对应路线或总体审计，不创建平行版本；
- 已完成或被替代文档先移入 `history/`，不删除证据；
- 命令只在一个权威入口维护，其他文档链接过去；
- README 只说明项目形态、安装和入口，不复制详细实验历史。

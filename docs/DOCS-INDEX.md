# Computer Harness 文档索引

日期：2026-09-15
文档角色：入口
状态：当前执行
当前入口：本文件
基线：当前 `main` 工作树
范围：当前实施入口、长期设计、历史资料和实验产物边界

`docs/` 的唯一导航入口。实施 Agent 先读本文件，再只读取自己负责的当前路线文档；不要按文件名遍历整个目录。

## 当前实施入口

当前唯一阶段入口：[Stage 6 收敛与下一阶段起始状态](./stage-6-convergence-and-start-state-2026-09-15.md)。工程集成已通过；验证集 G0 仍在并行预检，验证完成前不冻结正式任务、预算或快照。

| 文件 | 用途 |
|---|---|
| [stage-6-convergence-and-start-state-2026-09-15.md](./stage-6-convergence-and-start-state-2026-09-15.md) | 当前收敛状态、冻结条件、P/C/B/M1/M2/N 消融顺序和停止条件 |
| [qwen-flat-regression-and-integration-acceptance-2026-09-15.md](./qwen-flat-regression-and-integration-acceptance-2026-09-15.md) | Qwen flat 真实 API 回归、GLM/Qwen Composite/Memory/Planning 及双后端集成验收 |
| [qwen-flat-source-audit-and-migration-2026-09-15.md](./qwen-flat-source-audit-and-migration-2026-09-15.md) | Qwen strict 固定 `calls[]` 源码复审、提示词边界与协议迁移证据 |
| [real-api-conformance-2026-09-15.md](./real-api-conformance-2026-09-15.md) | 真实 API 的详细请求、响应与历史失败证据 |
| [harness-development-validation-candidates-2026-09-10.json](./harness-development-validation-candidates-2026-09-10.json) | G0 修订3候选 manifest：20开发/20验证/11备用；V19由R10替代，主集动态预检已回填、预算未定，不可直接当正式 runner 输入 |
| [g0-preflight-progress-2026-09-10.md](./g0-preflight-progress-2026-09-10.md) | G0 主集动态预检：Development 20/20、Validation 20/20（V19由R10替代）；evaluator正例校准和预算冻结未完成 |
| [osworld-environment-implementation.md](./osworld-environment-implementation.md) | OSWorld/VM、Bridge、官方评分和真实任务环境 |
| [stage-5-osworld-reproducibility.md](./stage-5-osworld-reproducibility.md) | OSWorld artifact、快照、显示校准和复现实验入口 |

## 全局设计与规范

| 文件 | 用途 |
|---|---|
| [development-documentation-standard.md](./development-documentation-standard.md) | 文档角色、证据、归档和提交规范 |
| [multimodal-gui-agent-harness-product-plan.md](./multimodal-gui-agent-harness-product-plan.md) | 产品定位和扩展边界 |
| [run-turn-tool-and-user-correction-semantics.md](./run-turn-tool-and-user-correction-semantics.md) | Run、Turn、Tool 和用户纠正语义 |
| [GUI Agent 多模态 Memory 与 Advisory Subagent 演进设计.md](./GUI%20Agent%20多模态%20Memory%20与%20Advisory%20Subagent%20演进设计.md) | 长期 Memory/Advisory 设计，当前不作为实施指令 |
| [面向视障场景的 GUI Agent 意图守护技术路线调整与系统设计.md](./面向视障场景的%20GUI%20Agent%20意图守护技术路线调整与系统设计.md) | 长期产品与研究方向 |

## 代码与实验入口

- `scripts/stage5-osworld/`：当前 OSWorld Bridge/真实任务 runner；
- `scripts/stage5-osworld/analyze-trajectory.mjs`：离线读取已有 `trajectory.jsonl` 的步骤、重复候选、错误、token 和延迟统计；
- `scripts/stage5-planning-api-smoke.mjs`：Planning registry + DefaultContextCompiler + FakeComputer 的小规模真实 Provider smoke；不操作真实桌面或 VM；
- `scripts/api-conformance.ts`：Provider 无副作用协议探针，默认 Qwen `strict_json`；
- `scripts/real-memory-api-conformance.mjs`：正式 Memory tools + Runtime 的无桌面真实 GLM/Qwen 闭环与多调用探针；
- `scripts/real-batch-api-conformance.mjs`：真实 GLM/Qwen 的 `click→type` Provider + Fake Computer Batch 探针；不操作真实桌面；
- `scripts/batch-backend-fixture.mjs`：同一 Runtime 在 CUA/OSWorld fake backend seam 上的双后端 Batch 合同验证；
- `scripts/qwen-flat-return-matrix.mjs`：Qwen 固定 `calls[]` 的单调用、Batch、Plan/Memory、Composite 和多轮读取矩阵；
- `scripts/stage4-local/`：本地路线回归检查；
- `packages/memory/`：Run 内 Fact Notes/轻实体 Store 与工具；由 Runtime 事件提交和 Context 召回组装；
- `integrations/osworld/README.md`：OSWorld Bridge 的环境准备和命令细节；
- `runs/`：本地原始运行产物，包含可能敏感的截图，默认不跟踪、不提交。

## 历史资料

`docs/history/` 保存已完成阶段、被替代方案和旧审计；`scripts/history/` 保存已停止使用的实验脚本。它们只用于追溯，不是当前实施指令。本轮已归档 Stage 4/5 施工记录、旧 G1–G3 审计、旧 Planning 交接、旧扩展技术计划和 Qwen 失败样本；统一当前路线以 Stage 6 入口为准。

提交时只包含本索引、全局设计/规范、两条路线摘要、最新总体审计和必要 manifest；`docs/history/`、`.env`、截图、VM
文件和 `runs/` 原始资产不提交。

## 更新规则

- 一个阶段只保留一个共同入口；每条路线只保留一个当前摘要；
- 新结果追加到对应路线或总体审计，不创建平行版本；
- 已完成或被替代文档先移入 `history/`，不删除证据；
- 命令只在一个权威入口维护，其他文档链接过去；
- README 只说明项目形态、安装和入口，不复制详细实验历史。

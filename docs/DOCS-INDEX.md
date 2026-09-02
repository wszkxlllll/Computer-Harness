# Computer Harness 文档索引

日期：2026-09-02

这是 `docs/` 的唯一导航入口。实施 Agent 不按文件名猜测路线；先读本索引，再读
[Stage 4 总入口](./stage-4-implementation-entry.md) 和自己负责的路线文档。

## 当前执行文档

| 文件 | 用途 |
|---|---|
| [stage-4-implementation-entry.md](./stage-4-implementation-entry.md) | 两条路线的共同基线、门槛和交接 |
| [stage-4-local-task-implementation.md](./stage-4-local-task-implementation.md) | A：Windows 本地任务真实闭环 |
| [osworld-environment-implementation.md](./osworld-environment-implementation.md) | B：OSWorld 环境、评分/reset 和 Harness 迁移探索 |
| [trajectory-review-2026-09-02/runtime-trajectory-cua-adapter-issues-2026-09-02.md](./trajectory-review-2026-09-02/runtime-trajectory-cua-adapter-issues-2026-09-02.md) | 总体 Runtime / Trajectory / CUA / Provider 审计 |
| [trajectory-review-2026-09-02/p0-readiness-reaudit-2026-09-02.md](./trajectory-review-2026-09-02/p0-readiness-reaudit-2026-09-02.md) | 当前代码基线的 P0 开工门、拆分和验收顺序 |
| [stage-4-local-tasks-2026-08-31.json](./stage-4-local-tasks-2026-08-31.json) | A 的机器可读冻结任务清单，不是叙述性计划 |

## 全局设计文档

| 文件 | 用途 |
|---|---|
| [development-documentation-standard.md](./development-documentation-standard.md) | 文档状态、入口、证据和更新规范 |
| [gui-agent-harness-v1-technical-plan.md](./gui-agent-harness-v1-technical-plan.md) | Protocol、Runtime、Provider、Computer 和 Trajectory 的长期技术基线 |
| [multimodal-gui-agent-harness-product-plan.md](./multimodal-gui-agent-harness-product-plan.md) | 产品定位、目标和扩展边界 |
| [run-turn-tool-and-user-correction-semantics.md](./run-turn-tool-and-user-correction-semantics.md) | Run、Turn、Tool、Action 与用户纠正语义 |
| [GUI Agent 多模态 Memory 与 Advisory Subagent 演进设计.md](./GUI%20Agent%20多模态%20Memory%20与%20Advisory%20Subagent%20演进设计.md) | 后续 Memory / Advisory 方向；当前不作为 Stage 4 实施指令 |

## 历史文件

`docs/history/` 保存旧阶段的计划、预检、结果和审计，用于追溯，不作为当前实施指令。历史目录在本地
保留但不纳入本次提交；如果某条历史结论仍然有效，应压缩后写入当前路线文档，而不是让 Agent 直接读取旧文件。

## 更新规则

- 当前阶段只允许一个总入口、每条路线一个入口和一个总体审计入口。
- 新结果优先写入对应路线文档的“已确认事实 / 下一步”；详细原始输出放在 ignored 的运行目录。
- 被替代的文档移动到 `docs/history/`，不删除本地证据，不继续被当前入口引用。
- 提交时只包含全局文档、两条路线入口、总体审计和必要的机器可读 manifest；历史目录保持未跟踪。

# Computer Harness 文档索引

日期：2026-09-17

角色：唯一导航入口。状态：当前执行。基线：`39ff27f9`，路线更新不代表代码已修复。

## 下一阶段开发必读

按顺序阅读以下三份文件即可开始准备 DEV-0/1，不需要拼接历史审计：

1. [Stage 6 当前实施入口](./stage-6-convergence-and-start-state-2026-09-15.md)：当前范围、顺序、已有证据及停止条件。
2. [完整开发路线 V2](./full-development-roadmap-v2.md)：已并入复核修订的 DEV-0..8 设计、合同与依赖。
3. [配套验收清单](./development-acceptance-v2.md)：反例、正常路径和阶段交付要求。

涉及文件拆分时再读[分块重构施工表](./module-refactoring-work-plan.md)：RFT-1..7 的源文件映射、目标职责、公共接口、先后顺序与测试，不是另一套阶段路线。

编写结果遵守[开发文档规范](./development-documentation-standard.md)。产品里程碑使用 REL-1/2/3；开发阶段 DEV；实机门槛 LIVE；评测准备仍称 G0。实验组 M1/M2 只表示 Fact/Entity Memory。

## 尚在使用的评测资料

这些是并行评测工作的当前输入，不是旧施工方案，因此保留原路径：

| 文件 | 用途 |
|---|---|
| [G0 预检状态](./g0-preflight-progress-2026-09-10.md) | 分集、预检与尚未闭合的校准/冻结条件 |
| [候选任务清单](./harness-development-validation-candidates-2026-09-10.json) | 既有开发/验证候选，不由本轮整理修改内容 |
| [OSWorld 环境说明](./osworld-environment-implementation.md) | Bridge、VM、官方评分环境 |
| [OSWorld 复现说明](./stage-5-osworld-reproducibility.md) | artifact、快照、显示及环境复现 |
| [Linux 平台适配与验证证据](./linux-platform-adaptation-2026-09-17.md) | Linux 宿主机适配：OSWorld docker 链路两个坑、pnpm optional 原生包排查修法、单测与 D19 端到端验证 |

正式实验继续采用路线第 11 节的 P/C/B/M1/M2/N 矩阵；组合与 Monitor 对照后置。G0 未闭合前不冻结正式实验，不把环境预检当模型成绩。

## 按需查证

- [历史归档目录](./history/2026-09-17-roadmap-consolidation/README.md)：旧设计、审计、实验结论、原始外部审计包和 CI 模板。
- [已确认问题与生产路径证据](./history/2026-09-17-roadmap-consolidation/external-audit-confirmation-2026-09-17.md)：F/R 问题详情，不作为第二套施工顺序。
- [本地缺陷复现探针](./verification/audit-39ff27f9-local-probes.mjs)：DEV-1 可复用；当前 pass 表示缺陷被复现，修复验收应断言正确行为。

旧附件的 V2 两个源文件已修订并迁入本目录，当前仅维护上述两份 V2 文档。原附件目录可能为空，不再是阅读入口。历史正文中的“当前/下一步”只代表写作当时状态。

## 文档维护

- 路线变化直接修改 V2 对应章节，同时同步验收清单；当前进度写回 Stage 6。
- 完成结果追加到所属阶段，不为每轮反馈复制完整路线。
- 被替代资料移到 history，保留证据与迁移索引；不要删除历史。
- `runs/`、真实截图、密钥、VM 不随文档归档或上传。本次新历史目录允许 Git 跟踪审核后的文本和模板，其他历史目录仍保持原忽略规则。

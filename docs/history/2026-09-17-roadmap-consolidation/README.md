# 2026-09-17 路线收敛归档

角色：历史索引。状态：只用于追溯；正文中的“当前/下一步”保留当时语境，不作为新施工指令。

当前从 [DOCS-INDEX](../../DOCS-INDEX.md) → [Stage 6](../../stage-6-convergence-and-start-state-2026-09-15.md) → [完整路线 V2](../../full-development-roadmap-v2.md) 和[验收清单](../../development-acceptance-v2.md)进入。

## 归档范围

- 17 份原 docs 根目录的旧设计、Risk/TUI 计划、审计复核和 API/迁移结果，保留原文件名。
- `before-cleanup-DOCS-INDEX.md` 与 `before-cleanup-stage-6-convergence-and-start-state-2026-09-15.md`：清理前入口快照，保留当时正文，相对链接随归档位置修正。
- `external-audit-package/`：原外部审计包，完整保留隐藏的 CI 模板、验证脚本、清单及校验和；移动时逐文件比对 SHA256，附件内容不改。模板不自动安装或执行。

两份 V2 源文档直接修订后迁入当前 docs 根目录，分别为 `full-development-roadmap-v2.md`、`development-acceptance-v2.md`，仅保留这一份可执行版本。

评测 G0 清单/状态与 OSWorld 操作说明仍在当前目录，避免中断未完成工作。`docs/verification/audit-39ff27f9-local-probes.mjs` 仍供 DEV-1 转化为正式反例回归，未归档停用。

## 查证入口

- [39ff27f9 外部审计复核](./external-audit-confirmation-2026-09-17.md)：确认 F/R 问题和真实实现复现范围。
- [V2 路线复核](./full-roadmap-v2-review-2026-09-17.md)：意见现已并入当前 V2 正文，不再有待用户另行拼接的补充合同。
- [原始外部审计总览](./external-audit-package/00-audit-overview.md)：原报告及模板目录导航。
- [工程可用性审计](./audit-2026-09-16-overview.md)：交互/CI/CUA 分项原始材料。
- [旧产品计划](./multimodal-gui-agent-harness-product-plan.md)：保留产品定位和长期方向的历史依据。

## 保存与 Git

本轮只移动文本/模板，未删除证据。新建带日期的历史目录采用窄范围 Git 忽略例外，避免将来提交时只显示旧文件删除而漏掉归档副本。既有其他 history 目录保持原忽略策略。无截图、密钥、模型原始响应或 VM 被移入本目录。

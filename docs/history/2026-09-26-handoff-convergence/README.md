# 2026-09-26 交接收敛归档

本目录保留本次交接收敛时从 `docs/` 与 `scripts/` 移入的材料。移动时逐文件 SHA-256 相同；随后仅修正文档链接和 Markdown 空白格式，脚本保留原始字节。

当前开发入口是仓库根 README 链接的五份主交接文档，导航见 [`docs/DOCS-INDEX.md`](../../DOCS-INDEX.md)。本目录文档是阶段记录、旧路线或已结束专题；本目录脚本是一轮实验源码。它们不是当前 CLI、package script、CI、测试或评测入口。历史文档中的命令只表示当时的路径和执行方式，不代表当前状态。

已存在的 `2026-09-17-roadmap-consolidation` 历史目录保持原样。其中的冻结文档可能仍指向本次迁移前的旧路径；请用下方清单按旧路径查找归档副本。本次没有改写那批历史文件。

脚本按原始字节归档，相对源码导入仍以旧 `scripts/` 目录为基准，**不承诺在新位置直接运行**。如需复现，应在独立工作树中将脚本复制到表中原路径，不覆盖当前开发文件，再核对对应源码版本、依赖、授权和配置。本次未调用模型 API、启动 GUI 或运行这些实验。

## 阶段报告与旧路线

这些 DEV/Stage 报告和 V2 路线属于已收敛阶段快照；它们保留当时的验证与决策，当前状态以五份主文档为准。

| 原路径 | 归档路径 |
| --- | --- |
| `docs/dev-0-ci-implementation-results.md` | [`docs/dev-0-ci-implementation-results.md`](./docs/dev-0-ci-implementation-results.md) |
| `docs/dev-1-context-implementation-results.md` | [`docs/dev-1-context-implementation-results.md`](./docs/dev-1-context-implementation-results.md) |
| `docs/dev-1-controls-cleanup-implementation-results.md` | [`docs/dev-1-controls-cleanup-implementation-results.md`](./docs/dev-1-controls-cleanup-implementation-results.md) |
| `docs/dev-1-diagnostics-implementation-results.md` | [`docs/dev-1-diagnostics-implementation-results.md`](./docs/dev-1-diagnostics-implementation-results.md) |
| `docs/dev-1-memory-implementation-results.md` | [`docs/dev-1-memory-implementation-results.md`](./docs/dev-1-memory-implementation-results.md) |
| `docs/dev-1-risk-implementation-results.md` | [`docs/dev-1-risk-implementation-results.md`](./docs/dev-1-risk-implementation-results.md) |
| `docs/dev-2-adapter-window-validation-results.md` | [`docs/dev-2-adapter-window-validation-results.md`](./docs/dev-2-adapter-window-validation-results.md) |
| `docs/dev-2-app-runtime-implementation-results.md` | [`docs/dev-2-app-runtime-implementation-results.md`](./docs/dev-2-app-runtime-implementation-results.md) |
| `docs/dev-2-cua-capability-and-extension-research.md` | [`docs/dev-2-cua-capability-and-extension-research.md`](./docs/dev-2-cua-capability-and-extension-research.md) |
| `docs/dev-2-cua-target-integration-assessment.md` | [`docs/dev-2-cua-target-integration-assessment.md`](./docs/dev-2-cua-target-integration-assessment.md) |
| `docs/dev-2-dom-grounding-foundation-2026-09-21.md` | [`docs/dev-2-dom-grounding-foundation-2026-09-21.md`](./docs/dev-2-dom-grounding-foundation-2026-09-21.md) |
| `docs/dev-2-remote-push-readiness.md` | [`docs/dev-2-remote-push-readiness.md`](./docs/dev-2-remote-push-readiness.md) |
| `docs/dev-2-tui-interaction-diagnosis.md` | [`docs/dev-2-tui-interaction-diagnosis.md`](./docs/dev-2-tui-interaction-diagnosis.md) |
| `docs/dev-2-tui-preview-implementation-results.md` | [`docs/dev-2-tui-preview-implementation-results.md`](./docs/dev-2-tui-preview-implementation-results.md) |
| `docs/dev-2-tui-preview-validation-results.md` | [`docs/dev-2-tui-preview-validation-results.md`](./docs/dev-2-tui-preview-validation-results.md) |
| `docs/dev-2-tui-ux-pty-validation-results.md` | [`docs/dev-2-tui-ux-pty-validation-results.md`](./docs/dev-2-tui-ux-pty-validation-results.md) |
| `docs/dev-2-uia-grounding-implementation-results-2026-09-21.md` | [`docs/dev-2-uia-grounding-implementation-results-2026-09-21.md`](./docs/dev-2-uia-grounding-implementation-results-2026-09-21.md) |
| `docs/dev-2-uia-readonly-probe-results-2026-09-20.md` | [`docs/dev-2-uia-readonly-probe-results-2026-09-20.md`](./docs/dev-2-uia-readonly-probe-results-2026-09-20.md) |
| `docs/dev-2-window-target-implementation-results.md` | [`docs/dev-2-window-target-implementation-results.md`](./docs/dev-2-window-target-implementation-results.md) |
| `docs/dev-2-window-target-validation-results.md` | [`docs/dev-2-window-target-validation-results.md`](./docs/dev-2-window-target-validation-results.md) |
| `docs/dev-3-5-implementation-plan.md` | [`docs/dev-3-5-implementation-plan.md`](./docs/dev-3-5-implementation-plan.md) |
| `docs/dev-3-5-integration-closeout.md` | [`docs/dev-3-5-integration-closeout.md`](./docs/dev-3-5-integration-closeout.md) |
| `docs/dev-3-5-paused-checkpoint.md` | [`docs/dev-3-5-paused-checkpoint.md`](./docs/dev-3-5-paused-checkpoint.md) |
| `docs/dev-3-context-implementation-results.md` | [`docs/dev-3-context-implementation-results.md`](./docs/dev-3-context-implementation-results.md) |
| `docs/dev-3-foundation-review.md` | [`docs/dev-3-foundation-review.md`](./docs/dev-3-foundation-review.md) |
| `docs/dev-3-integration-validation.md` | [`docs/dev-3-integration-validation.md`](./docs/dev-3-integration-validation.md) |
| `docs/dev-4-5-integration-review.md` | [`docs/dev-4-5-integration-review.md`](./docs/dev-4-5-integration-review.md) |
| `docs/dev-4-memory-implementation-results.md` | [`docs/dev-4-memory-implementation-results.md`](./docs/dev-4-memory-implementation-results.md) |
| `docs/dev-4-memory-model-api-validation.md` | [`docs/dev-4-memory-model-api-validation.md`](./docs/dev-4-memory-model-api-validation.md) |
| `docs/dev-4-memory-retrieval-plan.md` | [`docs/dev-4-memory-retrieval-plan.md`](./docs/dev-4-memory-retrieval-plan.md) |
| `docs/dev-4-memory-retrieval-qwen-pilot-results.md` | [`docs/dev-4-memory-retrieval-qwen-pilot-results.md`](./docs/dev-4-memory-retrieval-qwen-pilot-results.md) |
| `docs/dev-4-retrieval-integration-review.md` | [`docs/dev-4-retrieval-integration-review.md`](./docs/dev-4-retrieval-integration-review.md) |
| `docs/dev-5-monitor-implementation-results.md` | [`docs/dev-5-monitor-implementation-results.md`](./docs/dev-5-monitor-implementation-results.md) |
| `docs/dev-5-monitor-policy-implementation-results.md` | [`docs/dev-5-monitor-policy-implementation-results.md`](./docs/dev-5-monitor-policy-implementation-results.md) |
| `docs/development-acceptance-v2.md` | [`docs/development-acceptance-v2.md`](./docs/development-acceptance-v2.md) |
| `docs/full-development-roadmap-v2.md` | [`docs/full-development-roadmap-v2.md`](./docs/full-development-roadmap-v2.md) |
| `docs/module-refactoring-work-plan.md` | [`docs/module-refactoring-work-plan.md`](./docs/module-refactoring-work-plan.md) |
| `docs/stage-6-convergence-and-start-state-2026-09-15.md` | [`docs/stage-6-convergence-and-start-state-2026-09-15.md`](./docs/stage-6-convergence-and-start-state-2026-09-15.md) |
| `docs/local-experience-audit-2026-09-19.md` | [`docs/local-experience-audit-2026-09-19.md`](./docs/local-experience-audit-2026-09-19.md) |
| `docs/scenario-evaluation-and-three-person-plan-2026-09-19.md` | [`docs/scenario-evaluation-and-three-person-plan-2026-09-19.md`](./docs/scenario-evaluation-and-three-person-plan-2026-09-19.md) |
| `docs/uia-edge-depth-probe-2026-09-21.md` | [`docs/uia-edge-depth-probe-2026-09-21.md`](./docs/uia-edge-depth-probe-2026-09-21.md) |
| `docs/jev-system-one-fit-assessment-2026-09-21.md` | [`docs/jev-system-one-fit-assessment-2026-09-21.md`](./docs/jev-system-one-fit-assessment-2026-09-21.md) |
| `docs/glm-assistant-text-next-action-ab-2026-09-23.md` | [`docs/glm-assistant-text-next-action-ab-2026-09-23.md`](./docs/glm-assistant-text-next-action-ab-2026-09-23.md) |

## Pi、手机与出行专题阶段记录

Pi 阶段实施记录、手机实现/技术栈调研及旧 travel 审查已由当前主文档和操作入口收敛；原始结果留存于此。

| 原路径 | 归档路径 |
| --- | --- |
| `docs/pi-style-modularization-plan-2026-09-23.md` | [`docs/pi-style-modularization-plan-2026-09-23.md`](./docs/pi-style-modularization-plan-2026-09-23.md) |
| `docs/pi-tui-ux-results-2026-09-23.md` | [`docs/pi-tui-ux-results-2026-09-23.md`](./docs/pi-tui-ux-results-2026-09-23.md) |
| `docs/pi-computer-assembly-results-2026-09-23.md` | [`docs/pi-computer-assembly-results-2026-09-23.md`](./docs/pi-computer-assembly-results-2026-09-23.md) |
| `docs/pi-goal-window-selection-results-2026-09-23.md` | [`docs/pi-goal-window-selection-results-2026-09-23.md`](./docs/pi-goal-window-selection-results-2026-09-23.md) |
| `docs/pi-window-selection-jev-experiment-2026-09-23.md` | [`docs/pi-window-selection-jev-experiment-2026-09-23.md`](./docs/pi-window-selection-jev-experiment-2026-09-23.md) |
| `docs/pi-window-handoff-experiment-2026-09-23.md` | [`docs/pi-window-handoff-experiment-2026-09-23.md`](./docs/pi-window-handoff-experiment-2026-09-23.md) |
| `docs/pi-window-activation-reselection-2026-09-24.md` | [`docs/pi-window-activation-reselection-2026-09-24.md`](./docs/pi-window-activation-reselection-2026-09-24.md) |
| `docs/mobile-control-implementation-2026-09-26.md` | [`docs/mobile-control-implementation-2026-09-26.md`](./docs/mobile-control-implementation-2026-09-26.md) |
| `docs/mobile-control-stack-research-2026-09-26.md` | [`docs/mobile-control-stack-research-2026-09-26.md`](./docs/mobile-control-stack-research-2026-09-26.md) |
| `docs/travel-trajectory-review-2026-09-20.md` | [`docs/travel-trajectory-review-2026-09-20.md`](./docs/travel-trajectory-review-2026-09-20.md) |
| `docs/travel-guard-policy-review-2026-09-20.md` | [`docs/travel-guard-policy-review-2026-09-20.md`](./docs/travel-guard-policy-review-2026-09-20.md) |

## 已结束的一次性实验脚本

这些脚本未被当前 package scripts、根测试 runner、CI 或当前启动/评测入口消费；它们配套的一次性实验已结束。

| 原路径 | 归档路径 |
| --- | --- |
| `scripts/dev4-memory-retrieval-qwen-pilot.mjs` | [`scripts/dev4-memory-retrieval-qwen-pilot.mjs`](./scripts/dev4-memory-retrieval-qwen-pilot.mjs) |
| `scripts/glm-assistant-text-ab-probe.mjs` | [`scripts/glm-assistant-text-ab-probe.mjs`](./scripts/glm-assistant-text-ab-probe.mjs) |
| `scripts/glm-assistant-text-ab-probe.test.mjs` | [`scripts/glm-assistant-text-ab-probe.test.mjs`](./scripts/glm-assistant-text-ab-probe.test.mjs) |
| `scripts/jev-window-shadow.mjs` | [`scripts/jev-window-shadow.mjs`](./scripts/jev-window-shadow.mjs) |
| `scripts/managed-browser-dom-pilot.ts` | [`scripts/managed-browser-dom-pilot.ts`](./scripts/managed-browser-dom-pilot.ts) |
| `scripts/qwen-flat-return-matrix.mjs` | [`scripts/qwen-flat-return-matrix.mjs`](./scripts/qwen-flat-return-matrix.mjs) |
| `scripts/real-batch-api-conformance.mjs` | [`scripts/real-batch-api-conformance.mjs`](./scripts/real-batch-api-conformance.mjs) |
| `scripts/real-execution-segment-api-conformance.mjs` | [`scripts/real-execution-segment-api-conformance.mjs`](./scripts/real-execution-segment-api-conformance.mjs) |
| `scripts/real-memory-api-conformance.mjs` | [`scripts/real-memory-api-conformance.mjs`](./scripts/real-memory-api-conformance.mjs) |
| `scripts/real-memory-model-api-validation.mjs` | [`scripts/real-memory-model-api-validation.mjs`](./scripts/real-memory-model-api-validation.mjs) |
| `scripts/real-risk-guard-api-conformance.mjs` | [`scripts/real-risk-guard-api-conformance.mjs`](./scripts/real-risk-guard-api-conformance.mjs) |
| `scripts/stage5-planning-api-smoke.mjs` | [`scripts/stage5-planning-api-smoke.mjs`](./scripts/stage5-planning-api-smoke.mjs) |
| `scripts/tmp-glm-latency-matrix.mjs` | [`scripts/tmp-glm-latency-matrix.mjs`](./scripts/tmp-glm-latency-matrix.mjs) |

## 恢复与复现

恢复单个项目时，先检查原路径目标不存在，再把对应的 `docs/<文件>` 或 `scripts/<文件>` 移回表中原路径。不要从归档目录直接运行脚本：它们仍按旧 `scripts/` 相对导入。历史文档中的 fenced code block 命令保留原样，仅作当时记录；迁移后的链接用于阅读和追溯，不把历史命令变成当前操作指南。

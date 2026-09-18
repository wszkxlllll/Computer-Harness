# Computer Harness 文档索引

日期：2026-09-18

角色：唯一导航入口。状态：当前执行。原审计基线：`39ff27f9`；上一阶段开发基线：`a8580ea`（分支 `codex/dev2-tui-preview`）。当前 DEV-3/4/5 交接基线为 `adea8d7`（分支 `codex/dev3-context-memory-guard`）；`01a6d47` 的 Memory 首批交接与 `adea8d7` 的 Monitor online consumer 已落在本地提交中，仍以 Stage 6、实施计划和集中审查结论为准。DEV-2 最小 TUI、D2-EVENT/D2-SESSION 离线行为、CUA doctor 与显式 host-only window opt-in 已由 Sol 有限放行；本轮 TUI bounded UX 收口已获 Sol 定点有限放行（独立 18 项通过）。本批最终离线全量为 32 files/320 tests，root typecheck 通过；worker 本轮未调用 model API、桌面或 VM。收口内容包括 uppercase-I、可见 goal/correction、pause pending、waiting/failure/final-reply 呈现、长正文 PageUp/PageDown 分页、Unicode terminal-cell 宽度、快速粘贴有界绘制、输入 tail viewport/上限提示与 terminal-only 输入提示，详见[TUI 预览实施记录](./dev-2-tui-preview-implementation-results.md)。worker_ci 固定 build 已实测 no-goal Windows winpty PTY rapid/slow × ESC→Q/Ctrl-C 四场景通过，含中文、tail/500、resize/footer、cursor restore、exit 0、无 force-close；这不等于完整 model Run、跨 Run 实际 I 或 CUA 业务动作。真实 direct CLI doctor 仅确认 metadata/inventory（57 tools）可读，session 的 desktop capture scope 未确认，health/permissions 与 cleanup 保持 unknown、退出码 1；正式 pnpm wrapper 仍有 transport unknown 限制，不能把 doctor 写成整体通过。worker_ci 独立实机只证明 production adapter 的窄 `open/observe/background single-click/resize stale refusal/close` 链路；窗口模式仅开放 `click` 与 `wait`，keyboard、其他 pointer primitive、通用 focus/AX 和模型自由选窗仍禁用，默认 desktop/OSWorld 路径不变。目标丢失会锁定到 close 后新 session 才能恢复；preflight 与 driver click 非原子，不能宣称通用目标成功或 REL-1。此前用户真实请求中的 Provider transport failure 与 CUA action refusal 仅作诊断记录，本批未修复根因。证据见[窗口目标实施记录](./dev-2-window-target-implementation-results.md)、[CUA 窗口能力盘点](./dev-2-cua-target-integration-assessment.md)、[受控预览验证记录第11节](./dev-2-tui-preview-validation-results.md#11-2026-09-18-t10-真实-tui--glm--cua-synthetic-fixture-闭环)、[第12节](./dev-2-tui-preview-validation-results.md#12-2026-09-18-0222-窗口发现framefocus局部-capture-与关闭拒绝)、[第13节](./dev-2-tui-preview-validation-results.md#13-2026-09-18-cli-cua-doctor-最终实机验收)；修复状态以 Stage 6 和对应实施报告为准。

### DEV-3/DEV-4/DEV-5 当前交接（2026-09-18）

- `01a6d47` 是 DEV-4 Memory 的首批 scope、召回/再核实和 lifecycle handoff；`ba97878` 补齐 current read 分区、lifecycle source、Store 失败诊断和 Trace 实际渲染 IDs。语义适用性排序、跨 Run/target/generation 验证及独立审查仍待完成。没有 Plan 时不能伪造 Plan 相关性，也不能因此屏蔽普通事实召回；不使用 action/event/frame ID TTL 判定事实过期。
- `adea8d7` 加上 `ba97878`/`eec591c` 已把 Monitor 的有限 online consumer 接入提交后事件：`off`（默认）、`shadow`、`guidance` 三种模式；连续 3 次相同 action、2 次拒绝/失败、A-B-A 与 3 次 Plan/Memory churn 只产生候选，当前没有视觉特征。shadow 不干预；候选过时只 clear；guidance/help 只在完整 action→ToolResult→post-observation 边界后由 Controller/Inbox 消费，unknown/审批/在途副作用屏障优先，不产生自动执行或审批。`ba97878` 后 147 项、`eec591c` 后 149 项 focused/typecheck 证据均通过，但 Sol 集中复核、最终 full 和真实 API/桌面/VM 验证仍未完成，不能写成 DEV-3/4/5 或 REL-2 完成。详见[DEV-4/5 集成审查（待定点复核）](./dev-4-5-integration-review.md)。
- `9820851` 仅是独立的 DEV-4 semantic retrieval pilot（Qwen mock/隔离模块），未接入 Memory/Context/Runtime exports、`memory_search` 或 app configuration；不能把它计入共享 DEV-4 完成。
- 通用离线入口示例：`pnpm --filter @computer-harness/cli start -- --goal "<goal>" --model glm-5.3-flash --computer cua --cua-socket "<socket>" --monitor off`；仅在明确选择时改为 `--monitor shadow` 或 `--monitor guidance`。示例不包含凭证或本机路径；默认行为保持 `off`。

## 下一阶段开发必读

按顺序阅读以下三份文件即可继续 DEV-1/DEV-2，不需要拼接历史审计：

1. [Stage 6 当前实施入口](./stage-6-convergence-and-start-state-2026-09-15.md)：当前范围、顺序、已有证据及停止条件。
2. [完整开发路线 V2](./full-development-roadmap-v2.md)：已并入复核修订的 DEV-0..8 设计、合同与依赖。
3. [配套验收清单](./development-acceptance-v2.md)：反例、正常路径和阶段交付要求。

涉及文件拆分时再读[分块重构施工表](./module-refactoring-work-plan.md)：RFT-1..7 的源文件映射、目标职责、公共接口、先后顺序与测试，不是另一套阶段路线。

DEV-3 Context、DEV-4 Memory、DEV-5 Monitor 的实施合同、DEV-6 Risk 承接、Provider 适配与公开安全评测边界统一见[DEV-3/4/5 实施计划](./dev-3-5-implementation-plan.md)。本文保持“规划合同/来源缓存”角色，不表示这些阶段已经实现。

编写结果遵守[开发文档规范](./development-documentation-standard.md)。产品里程碑使用 REL-1/2/3；开发阶段 DEV；实机门槛 LIVE；评测准备仍称 G0。实验组 M1/M2 只表示 Fact/Entity Memory。

## 尚在使用的评测资料

这些是并行评测工作的当前输入，不是旧施工方案，因此保留原路径：

| 文件 | 用途 |
|---|---|
| [G0 预检状态](./g0-preflight-progress-2026-09-10.md) | 分集、预检与尚未闭合的校准/冻结条件 |
| [候选任务清单](./harness-development-validation-candidates-2026-09-10.json) | 既有开发/验证候选，不由本轮整理修改内容 |
| [OSWorld 环境说明](./osworld-environment-implementation.md) | Bridge、VM、官方评分环境 |
| [OSWorld 复现说明](./stage-5-osworld-reproducibility.md) | artifact、快照、显示及环境复现 |
| [Linux 平台适配与验证记录](./linux-platform-adaptation-2026-09-17.md) | Linux 宿主机适配：OSWorld docker 链路、pnpm optional 原生包排查、Hosted CI，以及仍待仓库内独立复核的 D19 作者报告 |

正式实验继续采用路线第 11 节的 P/C/B/M1/M2/N 矩阵；组合与 Monitor 对照后置。G0 未闭合前不冻结正式实验，不把环境预检当模型成绩。

## 按需查证

- 第二批确定性修复：[Context 实施记录](./dev-1-context-implementation-results.md)、[Memory 实施记录](./dev-1-memory-implementation-results.md)、[CLI 诊断实施记录](./dev-1-diagnostics-implementation-results.md)。提交、审查与最终集成状态统一见 Stage 6。
- 当前 DEV-3/DEV-4/5 checkpoint：[DEV-3/4/5 foundation 审查](./dev-3-foundation-review.md)、[DEV-4 Memory 行为结果](./dev-4-memory-implementation-results.md)、[DEV-5 Monitor 实施结果](./dev-5-monitor-implementation-results.md)、[离线集成历史验证](./dev-3-integration-validation.md)。`01a6d47`/`ba97878` 只覆盖首批 Memory 与 Monitor online 合同和边界；Sol 针对 `ba97878` 的定点复核、最终 full、跨 Run、target/generation、独立 verification、语义召回接入与真实效果仍未完成，不能写成 DEV-3/4/5 全完成。
- 第三批 DEV-1 控制收口：[F04/F12/F07 实施记录](./dev-1-controls-cleanup-implementation-results.md)。包含 resolved Risk profile、终端净化和有界 cleanup 的离线证据；实机/跨进程 owner 仍按记录边界处理。
- DEV-2 RFT2 与窗口 opt-in：[app-runtime 实施记录](./dev-2-app-runtime-implementation-results.md)、[显式窗口目标实施记录](./dev-2-window-target-implementation-results.md)；CUA 能力与扩展调研见[独立研究记录](./dev-2-cua-capability-and-extension-research.md)，窗口能力边界与 doctor 接入见[CUA 窗口能力盘点](./dev-2-cua-target-integration-assessment.md)。通用模板为 `pnpm --filter @computer-harness/cli start -- --goal "<goal>" --model glm-5.3-flash --computer cua --cua-socket "<socket>" --cua-window-pid <pid> --cua-window-id <windowId>`；窗口 opt-in 仅开放 single-click/wait，keyboard 与未验证 pointer primitive 拒绝，默认 desktop/OSWorld 不变。最小 TUI 预览与 D2-EVENT/D2-SESSION 行为批次见[TUI 预览实施记录](./dev-2-tui-preview-implementation-results.md)，不声称完整 model Run、通用 focus/AX、跨进程 owner 或 REL-1。
- [历史归档目录](./history/2026-09-17-roadmap-consolidation/README.md)：旧设计、审计、实验结论、原始外部审计包和 CI 模板。
- [已确认问题与生产路径证据](./history/2026-09-17-roadmap-consolidation/external-audit-confirmation-2026-09-17.md)：F/R 问题详情，不作为第二套施工顺序。
- [本地缺陷复现探针](./verification/audit-39ff27f9-local-probes.mjs)：DEV-1 可复用；当前 pass 表示缺陷被复现，修复验收应断言正确行为。

旧附件的 V2 两个源文件已修订并迁入本目录，当前仅维护上述两份 V2 文档。原附件目录可能为空，不再是阅读入口。历史正文中的“当前/下一步”只代表写作当时状态。

## 文档维护

- 路线变化直接修改 V2 对应章节，同时同步验收清单；当前进度写回 Stage 6。
- 完成结果追加到所属阶段，不为每轮反馈复制完整路线。
- 被替代资料移到 history，保留证据与迁移索引；不要删除历史。
- `runs/`、真实截图、密钥、VM 不随文档归档或上传。本次新历史目录允许 Git 跟踪审核后的文本和模板，其他历史目录仍保持原忽略规则。

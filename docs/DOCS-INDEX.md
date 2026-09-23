# Computer Harness 文档索引

**Pi 式模块化改造工作树入口**：本分支从 `73412c8` 保存基线后独立施工；第一条纵向切片、架构不变量及验收/停止条件见[Pi 式模块化改造计划](./pi-style-modularization-plan-2026-09-23.md)，workspace TypeScript 装配示例见[Run SDK 装配指南](./sdk-run-composition.md)。原工作树与其研究记录不受本分支改动影响。

第二切片的当前合同见[Planning / Run Memory 模块装配](./pi-module-composition-2026-09-23.md)与[TUI 体验结果](./pi-tui-ux-results-2026-09-23.md)：模块仍使用现有状态/Event 协议；TUI 窄屏全文入口已作离线验证，真实读屏和桌面快捷方式点击尚未验收。

第三切片的 Computer 装配边界、离线审查和真实 GLM＋CUA 烟测见[第三切片结果](./pi-computer-assembly-results-2026-09-23.md)：整桌面找被遮挡窗口的任务失败，但精确窗口 background 单击→复观察的受控任务通过。TUI 的 Run 前本地匹配见[自动选窗切片结果](./pi-goal-window-selection-results-2026-09-23.md)，尚未做真实桌面验收；[Jev 选窗 shadow API 结果与自动 Grounding 边界](./pi-window-selection-jev-experiment-2026-09-23.md)已更新。Jev 未进入 TUI 默认/active 路径，`--grounding auto` 是 CUA TUI 的 opt-in 功能。

日期：2026-09-23

**2026-09-23 GLM `assistantText` 下一步提示实验**：24 次 A/B 原生工具调用表明，一句系统提示可把合成场景的非空 `content` 从 9/12 提高到 12/12，但严格格式仅 5/12；六个可预测场景只有一例给出针对实际动作的具体下一步，且该例先做了多余点击，尚未证明节省主模型轮次。生产提示词未改。方法、逐例复核和现有 Monitor 消费边界见[对照实验报告](./glm-assistant-text-next-action-ab-2026-09-23.md)。

**2026-09-23 Jev 实验收口**：Jev/System One 的 all-observation、continuation、side-tool 和 recovery-only 方案均未在真实任务中稳定降低 GLM 请求或端到端延迟；recovery 触发机会稀少，实际调用均 abstain。因此 Jev 已从产品 Runtime、CLI、TUI、PowerShell、报告和协议事件中移除，不是当前 Provider 或 GUI 执行路径的一部分。完整实验数据、no-go 判断和回退依据保留在[Jev / System One 适配性审计](./jev-system-one-fit-assessment-2026-09-21.md)，该文档仅作为历史研究证据，不是当前实施入口。

当前实施入口只描述仍有消费者的能力：GLM/Qwen Provider、CUA/OSWorld Computer、Context、Planning、Run Memory、Action Batch、Monitor、Risk Guard、Grounding、TUI 与可复现 Trajectory。没有生产消费者的局部策略、候选池和旁路网络配置不应重新加入 Runtime。

**2026-09-21本地体验更新**：窗口选择已接入TUI：退出编辑态后按W，按应用名/标题选择；窗口布局由用户自行安排，Harness不移动或缩放窗口。foreground预览开放click/type/keypress/hotkey/scroll/drag/wait，background仍只click/wait。Risk Guard可按Run选择`off/layered`，research预设默认off。最新两条高德实验证明 UIA 介入既有正例也有明确边界：站点建议文本可被 depth16 UIA 暴露，`click_element` 4/4 完成；“换乘少”自定义偏好控件在完整 UIA 树中不存在，坐标点击后反复无变化。因此下一步是收紧 Monitor 恢复策略并沿用 GroundingCatalog 增加受限 DOM/CDP 生产者，不是无限扩大 UIA 深度。详见[最新出行轨迹审计](./travel-trajectory-review-2026-09-20.md)。当前操作以[操作手册](./travel-task-cards-and-feedback.md#0-你现在照这个顺序做)和[出行试点准备](./travel-pilot-preparation-2026-09-20.md)为准；下面DEV-2/3/4/5段落中的部分旧计数和能力边界仅作历史证据。

> 阅读优先级：顶部更新、README与最新专题审计高于下方历史基线长段；后者保留提交沿革，不再作为当前窗口能力或测试计数来源。

角色：唯一导航入口。状态：当前执行。原审计基线：`39ff27f9`；上一阶段开发基线：`a8580ea`（分支 `codex/dev2-tui-preview`）。当前 DEV-3/4/5 交接基线为 `adea8d7`（分支 `codex/dev3-context-memory-guard`）；`01a6d47` 的 Memory 首批交接、`adea8d7`/`eec591c` 的 Monitor online consumer 与 `6cd7ddb` 的 Context 检索接入已落在本地提交中，仍以 Stage 6、实施计划和集中审查结论为准。DEV-2 最小 TUI、D2-EVENT/D2-SESSION 离线行为、CUA doctor 与显式 host-only window opt-in 已由 Sol 有限放行；本轮 TUI bounded UX 收口已获 Sol 定点有限放行（独立 18 项通过）。当前源码树离线验证为 49 个 Vitest 文件、563 项 Vitest 测试通过；root `pnpm test` 另外运行 20 个 Node TAP 子测试（19 通过、1 个 Windows 符号链接限制跳过），root typecheck、CLI help、offline frozen install、diff-check 均通过；这不是 Hosted CI、真实 API/桌面或阶段整体完成证明。收口内容包括 uppercase-I、可见 goal/correction、pause pending、waiting/failure/final-reply 呈现、长正文 PageUp/PageDown 分页、Unicode terminal-cell 宽度、快速粘贴有界绘制、输入 tail viewport/上限提示与 terminal-only 输入提示，详见[TUI 预览实施记录](./dev-2-tui-preview-implementation-results.md)。worker_ci 固定 build 已实测 no-goal Windows winpty PTY rapid/slow × ESC→Q/Ctrl-C 四场景通过，含中文、tail/500、resize/footer、cursor restore、exit 0、无 force-close；这不等于完整 model Run、跨 Run 实际 I 或 CUA 业务动作。真实 direct CLI doctor 仅确认 metadata/inventory（57 tools）可读，session 的 desktop capture scope 未确认，health/permissions 与 cleanup 保持 unknown、退出码 1；正式 pnpm wrapper 仍有 transport unknown 限制，不能把 doctor 写成整体通过。worker_ci 独立实机只证明 production adapter 的窄 `open/observe/background single-click/resize stale refusal/close` 链路；窗口模式仅开放 `click` 与 `wait`，keyboard、其他 pointer primitive、通用 focus/AX 和模型自由选窗仍禁用，默认 desktop/OSWorld 路径不变。目标丢失会锁定到 close 后新 session 才能恢复；preflight 与 driver click 非原子，不能宣称通用目标成功或 REL-1。此前用户真实请求中的 Provider transport failure 与 CUA action refusal 仅作诊断记录，本批未修复根因。证据见[窗口目标实施记录](./dev-2-window-target-implementation-results.md)、[CUA 窗口能力盘点](./dev-2-cua-target-integration-assessment.md)、[受控预览验证记录第11节](./dev-2-tui-preview-implementation-results.md#11-2026-09-18-t10-真实-tui--glm--cua-synthetic-fixture-闭环)、[第12节](./dev-2-tui-preview-validation-results.md#12-2026-09-18-0222-窗口发现framefocus局部-capture-与关闭拒绝)、[第13节](./dev-2-tui-preview-validation-results.md#13-2026-09-18-cli-cua-doctor-最终实机验收)；修复状态以 Stage 6 和对应实施报告为准。

### DEV-3/DEV-4/DEV-5 当前交接（2026-09-18）

- `01a6d47` 是 DEV-4 Memory 的首批 scope、召回/再核实和 lifecycle handoff；`ba97878` 补齐 current read 分区、lifecycle source、Store 失败诊断和 Trace 实际渲染 IDs；`f22f96b`/`67542c7`/`6cd7ddb` 随后把 bounded `memory_search`、retrieval mode 和同一 recall service 接入 Context/Runtime。默认 lexical 不联网，hybrid 需显式独立 endpoint/凭据；synthetic ORCHID provider protocol 已由 GLM/Qwen 各 2/2 完成，但语义质量、跨 Run/target/generation 独立验证、完整生产任务与最终效果仍待完成。没有 Plan 时不能伪造 Plan 相关性，也不能因此屏蔽普通事实召回；不使用 action/event/frame ID TTL 判定事实过期。
- `adea8d7` 加上 `ba97878`/`eec591c` 已把 Monitor 的有限 online consumer 接入提交后事件；当前又补齐 action→ToolResult→post-observation→`monitor.transition` 链路。`off` 不创建 Monitor 状态，`shadow` 只记录候选，`guidance` 会把 `no_observed_change` 的有界提示注入下一次正常 Context，并在同一 post-observation 上拒绝完全相同的重复动作；`changed` 只表示截图字节变化，不代表业务成功。UIA grounding 已完成默认关闭的 CUA window-only 侧链与 GLM/Qwen schema 回归，Adapter 使用 depth16/最多256安全候选，Runtime 最多投影16个 hot elements。真实高德已出现 `click_element` 4/4 的站点建议正例，但后续只读完整 UIA 树证明“换乘少”自定义偏好控件没有被 Windows UIA 暴露；UIA 不能替代 DOM，DOM/CDP Grounding、无效点击后的有界恢复和语义验证仍是未完成项。详见[DEV-5 Monitor 实施结果](./dev-5-monitor-implementation-results.md)、[DEV-2 UIA Grounding 实施结果](./dev-2-uia-grounding-implementation-results-2026-09-21.md)、[最新出行轨迹审计](./travel-trajectory-review-2026-09-20.md)、[DEV-4 retrieval 集成审查（已定点修复）](./dev-4-retrieval-integration-review.md)与[DEV-3/4/5 收尾报告](./dev-3-5-integration-closeout.md)。
- `9820851` 保留为 DEV-4 semantic retrieval pilot 的起点；后续 `2e72f99`/`f22f96b`/`67542c7`/`6cd7ddb` 已将 retrieval service、`memory_search`、app config、Runtime mutation sync 和 Context 实际 ModelInput 排序接入。pilot 本身仅合成数据真实 Qwen embedding 4 次 HTTP、usage 合计 64 tokens，不等同于集成后真实生产运行；详见[检索计划](./dev-4-memory-retrieval-plan.md)与[pilot 结果](./dev-4-memory-retrieval-qwen-pilot-results.md)。
- 通用离线入口示例：`pnpm --filter @computer-harness/cli start -- --goal "<goal>" --model glm-5.3-flash --computer cua --cua-socket "<socket>" --monitor off`；仅在明确选择时改为 `--monitor shadow` 或 `--monitor guidance`。示例不包含凭证或本机路径；默认行为保持 `off`。

## 下一阶段开发必读

当前先执行[上海出行票务试点准备](./travel-pilot-preparation-2026-09-20.md)：12306、携程与地图路线。[20题及反馈表](./travel-task-cards-and-feedback.md)、逐题启动和模块指标采集已完成初次离线验收；TUI自由goal入口用F调整下一Run功能，运行中可纠正，每Run独立保存原文报告、实际配置、指标和人工表。最新T01样例的Runtime成功不等于业务成功，人工走查仍待填写；它已证明人工纠正和Run内Memory闭环可工作，同时显示Planning/Batch未触发、Monitor只能阻断完全相同动作，详见[轨迹审计](./travel-trajectory-review-2026-09-20.md)。research默认开启Plan/Memory/Context/Batch/Monitor但关闭Risk Guard；Guard可用启动参数或TUI的F页面按Run打开。上级[三人评测实施方案](./scenario-evaluation-and-three-person-plan-2026-09-19.md)的六域120实例是后续扩展建议，不要求同时启动；当前任务集仍是候选草案，不修改既有OSWorld清单。

CUA 0.22.2 的 UIA 探针与产品化实验分别记录在[UIA 只读能力探针结果](./dev-2-uia-readonly-probe-results-2026-09-20.md)和[UIA Grounding 实施结果](./dev-2-uia-grounding-implementation-results-2026-09-21.md)：私有 daemon 与自有 WinForms fixture 已验证 `list_windows/get_window_state/verify_state`；当前默认关闭的 `uia-catalog-v1` 仅允许显式 CUA window target，Adapter 使用 depth16、最多256个安全候选，Runtime 用确定性 selector 落盘最多16个 hot elements，Context/GLM/Qwen共用 `click_element`，旧ref/resize/查询失败会拒绝或显式降级。高德实验已证明站点建议文本能通过 UIA 定位并完成 `click_element` 4/4，也证明“换乘少”自定义控件在 depth16/24/32 的完整只读对照中均未暴露；UIA 是有界补充，不是 DOM 的替代。

可选 DOM/Hybrid Grounding 的协议、有界融合、Monitor recovery hint、managed-browser host、严格 CUA window resolver 和 loopback CDP 只读 fixture pilot 见[DOM Grounding 基础实施与门禁](./dev-2-dom-grounding-foundation-2026-09-21.md)。TUI 与持久 Profile 已接线；真实独立 Edge fixture 已验证 custom div/button/input/open shadow 可发现，Canvas/iframe 边界按设计降级，并确认本机150% DPI下CDP与CUA窗口bounds不能整数直比。修复后第二次真实只读pilot已完成窗口绑定与8个DOM候选采集，但高德真实页面DOM候选和动作仍未验证；CUA 0.22.2仍无DOM/CDP typed surface，且不能对个人Edge静默启用。

TUI 功能选择页与 Memory embedding 配置说明见 [TUI 功能选择与 embedding 记录](./tui-feature-selection-and-memory-embedding-2026-09-19.md)。它补充当前 CLI 参数说明，不改变 Runtime/Provider 合同。

按顺序阅读以下三份文件即可继续 DEV-1/DEV-2，不需要拼接历史审计：

1. [Stage 6 当前实施入口](./stage-6-convergence-and-start-state-2026-09-15.md)：当前范围、顺序、已有证据及停止条件。
2. [完整开发路线 V2](./full-development-roadmap-v2.md)：已并入复核修订的 DEV-0..8 设计、合同与依赖。
3. [配套验收清单](./development-acceptance-v2.md)：反例、正常路径和阶段交付要求。

最新本机真实体验暴露的成本、验证语义、Monitor、Guard 与 CUA 恢复问题见[首次本机真实体验审计](./local-experience-audit-2026-09-19.md)。该报告是当前体验优化入口，不替代长期路线。

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
- 当前 DEV-3/DEV-4/5 checkpoint：[DEV-3/4/5 foundation 审查](./dev-3-foundation-review.md)、[DEV-4 Memory 行为结果](./dev-4-memory-implementation-results.md)、[DEV-5 Monitor 实施结果](./dev-5-monitor-implementation-results.md)、[离线集成历史验证](./dev-3-integration-validation.md)、[DEV-3/4/5 收敛草案](./dev-3-5-integration-closeout.md)。`01a6d47`/`ba97878` 的首批 scope/Monitor 合同已由后续提交扩展为 retrieval/Context 离线接入；最终 Sol 审核、最终 full、跨 Run/target/generation、独立 verification、集成后真实效果和阶段整体完成判定仍未完成，不能写成 DEV-3/4/5 全完成。
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

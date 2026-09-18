# Stage 6：当前实施入口

更新：2026-09-18

角色：当前执行 / 交接。原审计基线：`39ff27f9`；当前开发基线：`a8580ea`（分支 `codex/dev2-tui-preview`）。DEV-1 已合并结果与 DEV-2 最小 TUI、D2-EVENT/D2-SESSION 离线行为、CUA capability doctor 和显式 host-only window opt-in 已完成并获 Sol 有限放行；本轮 TUI bounded UX 收口已获 Sol 定点有限放行（独立 18 项通过）。本批最终离线全量为 32 files/320 tests，root typecheck 通过，内容包括 uppercase-I、可见 goal/correction、pause pending、waiting/failure/final-reply 呈现、长正文分页、terminal-cell 宽度、快速粘贴有界绘制、输入 tail viewport/上限提示与 terminal-only 输入提示。worker_ci 固定 build 已实测 no-goal Windows winpty PTY rapid/slow × ESC→Q/Ctrl-C 四场景通过，含中文、tail/500、resize/footer、cursor restore、exit 0、无 force-close；这不等于完整 model Run、跨 Run 实际 I 或 CUA 业务动作。真实 direct doctor 仅读到 metadata/inventory（57 tools），session 的 desktop capture scope 未确认，health/permissions/cleanup 保持 unknown，正式 pnpm wrapper 仍有 transport unknown 限制，doctor 不整体通过；worker_ci 独立实机仅证明 production adapter 的窄 `open/observe/background single-click/resize stale refusal/close` 链路。窗口模式只开放 click/wait，不开放 keyboard、其他未验证 pointer primitive、通用 focus/AX 或模型自由选窗；默认 desktop/OSWorld 不变，正式评测 G0/REL-1 另行收口。此前用户真实请求中的 Provider transport failure 与 CUA action refusal 仅作诊断记录，本批未修复根因。

## 1. 当前结论与已有基础

PR #1 已由用户合并，DEV-0 Hosted CI 与 DEV-1 的确定性修复已进入 main。当前批次在 `a8580ea` 基线上完成最小受控 TUI、提交后事件 feed、单活跃 Run/session、同进程环境 owner，以及显式 host-only CUA window observe/click 适配；Sol 已对本批有限放行。Runtime、两 Provider、两 Computer Adapter、Planning、Run Memory、Context、Batch 和实验性 Risk Guard 已有实现；不能把它们视为所有边界均验收通过。

2026-09-17 已在 Windows/Node 24.19.0/pnpm 11.19.0 执行类型检查及 179 项测试，另 9 项实际实现探针复现了未覆盖问题。详细证据见[归档复核](./history/2026-09-17-roadmap-consolidation/external-audit-confirmation-2026-09-17.md)。这些是历史基线，本轮文档整理没有新测试或业务修复。

唯一开发路线：[完整路线 V2](./full-development-roadmap-v2.md)。配套：[验收清单](./development-acceptance-v2.md)。它们已直接吸收复核意见，不必先读所有旧审计。

2026-09-17 合同状态复查已补入路线 3.1：Memory scope、目标/focus/generation、InstructionState、ContextTrace/prepared request、在线图片/停滞特征及持久恢复均不能视为当前已完成。scope 保留为 DEV-4 新增能力，含绑定、召回、失效、迁移和 FM12..15 测试；当前 DEV-0/1 顺序不变。本次仅核对源码与修订文档，没有运行这些新增验收测试。

## 2. 路线背景与后续顺序

1. **已完成的 DEV-0/DEV-1 基础**：Hosted CI、Context/Memory、Risk/诊断和清理的已合并结果以历史批次及各实施记录为准。
2. **当前 DEV-2 小批**：最小 TUI、提交后事件 feed、单活跃 Run/session、同进程 owner 与显式 host-only window single-click/wait 已有限放行；完整 model Run、通用 focus/AX、跨进程 owner/quiesce、keyboard/其他 pointer primitive 仍是后续闸门。
3. **后续路线**：按 V2 继续收口 D2-SESSION/target/接管与 DEV-3..8；不把 no-goal winpty home 或专用 fixture 结果写成 REL-1/T01..T14 全部通过。

DEV-0 与 DEV-1 可以并行；同一 Runtime 合同变更由一个集成负责人协调。先新增真实路径反例，再修复，行为修改与纯文件迁移分开提交。

## 3. 后续推进条件

DEV-2 后续先补完整 model Run 与真实受控路径的独立闸门，再推进通用 target/focus/人工接管和更广环境 owner；本批的 no-goal winpty home 与专用 CUA fixture/adapter 窄链路结果不能替代这些验收。窗口 preflight 与 driver click 非原子，目标丢失后须 close 并新建 session 才能恢复，不能作为通用桌面安全保证。

REL-1 通过即可持续低风险体验，不必等 Context V2、Memory 生命周期、Monitor 和恢复全部完成；可以先暂停扩张优化体验。后续按 DEV-3..8 顺序和依赖推进，详见 V2。

## 4. 当前边界与停止条件

- 本轮不改正式任务清单、快照或 G0 结论；不将 Guard/CUA 新能力混入未声明变量的模型对照。
- 模型 API、桌面操作、VM 重置和远端权限变更按各自明确授权范围执行，不因文档列出命令自动启动。
- 用户纠正丢失、非法状态物化、强制审批被降级、未知 GUI 副作用重试、未确认停止就释放桌面，均不得验收通过。
- 现有事件先提交再物化、串行 GUI 调度、未知结果停止等机制保留；新字段必须有生产者、消费者、持久化/失效/清理规则。
- 修改通过后报告实际运行的测试、未验证实机范围、行为变化及回退方式；不要把反例探针的 pass 当修复通过。

## 5. 评测与结果记录

G0 当前资料从[文档索引](./DOCS-INDEX.md)进入，校准、预算和分集未冻结前不开始正式 Validation。保留 P/C/B/M1/M2/N，产品里程碑改称 REL，避免重名。

DEV-3/4/5 可在 Development 做阶段性小规模对照，DEV-7 汇总冻结实验；不等全部功能完成才首次验证效果，也不反复用 Validation 调参。

实施结果写在所属阶段交付文档并从本入口链接。当前状态：**DEV-1 已合并结果按历史批次记录；DEV-2 RFT2、最小 TUI/D2-EVENT/D2-SESSION、CUA doctor 与显式 host-only window opt-in 已分别完成并获 Sol 有限放行。本轮 TUI bounded UX 收口已获 Sol 定点有限放行（独立 18 项通过）；本批最终离线全量 32 files/320 tests，root typecheck 通过；worker 本轮未调用 model API、桌面或 VM。TUI bounded UX 详见[TUI 预览实施记录](./dev-2-tui-preview-implementation-results.md)：输入可见且经 terminal sanitizer，uppercase-I 先请求 pause/quiescence，waiting/question/approval/failure/final reply 有本地呈现，长正文可分页，terminal-cell 宽度和快速粘贴有界绘制已回归，terminal-only scope 不冒称 global hotkey。worker_ci 固定 build 已实测 no-goal Windows winpty PTY rapid/slow × ESC→Q/Ctrl-C 四场景通过，含中文、tail/500、resize/footer、cursor restore、exit 0、无 force-close；这不等于完整 model Run、跨 Run 实际 I 或 CUA 业务动作。真实 direct doctor 仅确认 metadata/inventory（57 tools），session 的 desktop capture scope 未确认，health/permissions/cleanup 为 unknown、退出码 1；正式 pnpm wrapper 的 transport unknown 仍未解决，不能把 doctor 整体写成通过。worker_ci 独立实机只证明 production adapter 的窄 `open/observe/background single-click/resize stale refusal/close` 链路；窗口仅开放 click/wait，keyboard、其他未验证 pointer primitive、通用 focus/AX、模型自由选窗仍未开放，默认 desktop/OSWorld 不变。目标丢失会锁定到 close 后新 session 才能恢复；preflight 与 driver click 非原子，不等通用目标成功或 REL-1。此前用户真实请求中的 Provider transport failure 与 CUA action refusal 仅作诊断记录，本批未修复根因。详见[窗口目标实施记录](./dev-2-window-target-implementation-results.md)、[CUA 窗口能力盘点](./dev-2-cua-target-integration-assessment.md)、验证记录[第11节](./dev-2-tui-preview-validation-results.md#11-2026-09-18-t10-真实-tui--glm--cua-synthetic-fixture-闭环)、[第12节](./dev-2-tui-preview-validation-results.md#12-2026-09-18-0222-窗口发现framefocus局部-capture-与关闭拒绝)、[第13节](./dev-2-tui-preview-validation-results.md#13-2026-09-18-cli-cua-doctor-最终实机验收)。**

### 历史批次记录（保留当时状态，不代表当前入口）

#### 第二批：Context / Memory 与诊断

用户已授权合并后继续开发。本批从 `0e41463` 创建 `codex/dev1-context-memory-diagnostics`，不修改第一批旧分支；Luna 实施，Sol 独立只读审阅，主 Agent 组织与维护入口。

| 工作线 | 独占范围 | 交付门槛 |
|---|---|---|
| DEV-1A，F02/F05 | Context，worker_probe 负责 | Sol 放行；17 项通过，含多-call 整组裁剪、纠正保护及 fixed 溢出时 Provider=0；提交 `0d31d01` |
| DEV-1A，F03/F10 | Protocol / Runtime / Memory，worker_probe 负责 | Sol 放行；Memory 19 项 + Runtime 54 项独立通过；非法自定义 mutation 提交前拒绝，同值但 task links 改变正常 replacement；提交 `1af6a56` |
| DEV-1B，F06/R02 | CLI 诊断及测试，worker_ci 负责 | Sol 放行；11 项独立通过，含 native/flat 及真实 recorder 写盘；纯提取 `1e7fb55`，行为修复 `6f0ca33` |
| 集成审阅 | Sol 只读；共享入口由主 Agent 维护 | Sol 独立 focused 放行；Luna 末次统一 typecheck、19 文件 233 项测试、CLI help、依赖漂移和空白检查均通过 |

实施证据：[Context](./dev-1-context-implementation-results.md)、[Memory](./dev-1-memory-implementation-results.md)、[CLI 诊断](./dev-1-diagnostics-implementation-results.md)。纯提取与行为修复已分别审阅、提交，不等整个 DEV-1。此批不改正式任务，不启动真实 API、桌面或 VM，不提前开发 scope、Context V2 或产品 TUI。

放行边界：Context 仍使用近似文本预算，不是最终 Provider payload 的精确 token 上限；MemoryStore 校验结构，当前 task 是否存在由 Runtime 校验，未新增 scope；诊断摘要不等于可公开整个运行目录，trajectory / assets 仍为私有执行记录。未执行本批 Hosted CI；未 push，不改变远端 main。

最终集成由 Luna worker_ci 在 Node 24.19.0 / pnpm 11.19.0 执行，包含 Memory 最后 producer 修复；233 项是末次全量计数，232 项及 89 项联合 focused 是中间版本，不能互相替代。Sol 独立执行了 Context 17、Memory + Runtime 73、诊断 11 项相关验证；主 Agent 负责调度和证据汇总，没有亲自实施业务代码或重跑全部测试。

下一批处理 F04 实机/实验 profile 的 resolved 配置、F12 终端净化，以及 F07 有界清理。清理超时不能冒充底层动作已停止。其后才按 DEV-2 的合同冻结与文件映射进入 app-runtime、接管及目标适配；此次通过不能称为 DEV-1 全部完成。

#### 第三批：Controls cleanup（历史记录；代码完成，Sol 有限范围放行）

本批从第二批工作树创建 `codex/dev1-controls-cleanup`，并以 merge commit `4913fc6` 合并最新 `origin/main`（`1f9f362`）。CLI `index.ts` 冲突已保留 PR #3 的 Computer lazy loading 与第二批 diagnostics recorder；PR #3/#4 的 Linux 适配文件和测试均保留。

范围为 DEV-1 的 F04/F12/F07：统一 experiment 与 `live-interactive` 的 resolved Risk 配置、让 TUI 显示实际 profile/Guard、净化模型/错误/外部文本的 ESC/CSI/OSC 等终端控制序列，以及 Runtime/Computer cleanup 的总 deadline、剩余预算和同实例未决清理阻断。F07 只承诺同一 Computer 实例/会话的进程内防复用；同环境新实例的 owner/quiesce 属于 DEV-2，跨进程持久屏障属于 DEV-6，未将 X02 后两者提前宣称完成。

本批结果写入[Controls cleanup 实施记录](./dev-1-controls-cleanup-implementation-results.md)。Sol 集中复核的中间版本为 5 files/72 tests，全项通过；补齐三项高风险反例后的最终复核为 3 files/16 tests，全项通过并有限放行。worker 最终离线统一验证为 `pnpm run typecheck` 通过、`pnpm test` 22 files/251 tests 全通过、CLI help 通过。行为变更已按 CLI、Runtime/CUA、文档三笔本地提交（CLI `98bb75c`、Runtime/CUA `e0d080c`，文档提交见 Git 日志）；不启动真实 API、桌面或 VM，不 push。

#### 第四批：DEV-2 RFT2 app-runtime（历史记录；代码与审查已完成，Sol 已有限放行）

本批从 PR #5 合并后的 `origin/main` `bc72ee5` 创建 `codex/dev2-app-runtime`。按 RFT2 将 CLI 的 Provider/Computer 工厂、诊断 recorder、run 目录/Store、Runtime Controller 组装及 summary/reporting 迁移至 `packages/app-runtime`；CLI 保留 args/env/terminal 控制。`ResolvedRunConfig` 不含凭证，凭证由 CLI 注入；`RunHandle` 保证单次 start、Controller-owned cleanup 不重复，构造失败只清理已创建的 writer。CUA 保持动态 lazy import，help/OSWorld 不解析 native binding。

合同、实际文件映射、Fake 组装及限制见[DEV-2 app-runtime 实施记录](./dev-2-app-runtime-implementation-results.md)；CUA 共享底座/doctor 方向见[独立能力调研](./dev-2-cua-capability-and-extension-research.md)。本批不实现 D2-SESSION、D2-EVENT、target/focus/generation、Monitor、Memory scope、跨进程 owner 或真实 TUI 输入。当前 app-runtime focused 已通过 8 files/34 tests；新增 AST test-only 收口前 worker 最终 typecheck、full（25 files/264 tests）及 help 均通过，收口后相关 focused/typecheck 复跑通过，未重复全量；未 push，Sol 已有限放行。

### 第五批：DEV-2 最小 TUI 预览与事件/会话行为（代码完成，Sol 已有限放行）

本批从第四批 `fa89f24` 创建 `codex/dev2-tui-preview`。Luna 实施，worker_ci 独立负责 CUA preflight/fixture 记录；本批不操作真实 API、桌面或 VM。范围为：Runtime `committed-events.ts` 的 append+reduce 后只读通知与增量读取；app-runtime 有界 `event-feed.ts` 的 sequence 去重、补读水位和 `resync_required`；`ApplicationSession` 单活跃 Run、新目录/新 Controller/审批/Memory Store 以及同进程保守 `EnvironmentOwner`；CLI `--tui` 无 goal 首页、中文粘贴、状态/审批/暂停/恢复/Abort/纠正/退出、resize/EOF raw/cursor 恢复。

实际纠正交由 Controller Inbox 线性化：审批等待中的纠正先撤销旧审批并拒绝旧 ToolCall，Provider 迟到或待消费决策按既有失效屏障处理；TUI 只呈现 snapshot 与 committed feed，不新建调度器，不以文案冒充 target/focus/generation 或桌面接管。CUA 本地 physical desktop 或相同 OSWorld bridge 的 active/unknown/未确认 cleanup 会保留进程内 owner；不同 bridge 不互相阻塞。跨进程 owner、quiesce、target/focus/generation、Memory scope、Monitor、完整 model Run 及 REL-1 仍未完成。

合同、文件映射、生产者/消费者/清理责任和限制见[TUI 预览实施记录](./dev-2-tui-preview-implementation-results.md)。集中复核指出的事件队列/resync、同桌面 owner、纠正/审批竞态、退出清理和 Escape `undefined` 输入边界已补回归并修复；本批离线 focused 为 6 files/29 tests 全通过，最后 `pnpm run typecheck`、`pnpm test`（28 files/282 tests）和 CLI help 均通过，Sol 已有限放行。worker_ci 文件不纳入本 worker 暂存范围。独立 winpty 仅验证 no-goal home 的中文/resize/ESC→Q/Ctrl-C 恢复；完整 model Run、通用 focus/AX、跨进程 owner 和 REL-1/T01..T14 全验收仍未通过本批证明。

### 第六批增量：CUA capability doctor 与显式窗口目标（代码完成，Sol 有限放行；真实结果有限且保守）

本批在 `f7f7357` 上增加脱敏、只读的 `--doctor` 入口，并在当前 `a8580ea` 基线上加入显式 host-only CUA window opt-in：`computer-cua` 读取 metadata、tool inventory、session、health 和 permission 的结构化状态，app-runtime 保持 native CUA 动态加载，CLI 在无 goal、无 model、无 `.env`/provider credentials 时可运行。错误、缺失、超时和未确认 cleanup 统一标为 `unknown`；SDK/daemon 声明与 fixture 实证分离。CI 的 direct CLI 复核确认 metadata/inventory（57 tools）可读，但 session 的 desktop capture scope 未确认，health/permissions 与 cleanup 保持 unknown，整体退出码为 1；正式 pnpm wrapper 另有 transport unknown 限制。窗口模式只在 `--cua-window-pid <pid> --cua-window-id <windowId>` 成对显式提供时启用，生产 adapter 只开放 window-local PNG observe、background single-click 与 wait，keyboard、其他 pointer primitive、模型自由选窗及默认 desktop/OSWorld 路径不变。目标丢失后 identity latch 只允许 close 后新 session 恢复；preflight 与 driver click 非原子，不能写成通用 focus/安全或业务成功证明。通用 CLI 模板见 [DOCS-INDEX](./DOCS-INDEX.md)；合同、fake 测试和限制见[窗口目标实施记录](./dev-2-window-target-implementation-results.md)、[TUI bounded UX 实施记录](./dev-2-tui-preview-implementation-results.md)与[CUA 窗口能力盘点](./dev-2-cua-target-integration-assessment.md)；真实窄证据与边界见 worker_ci 验证记录[第11节](./dev-2-tui-preview-validation-results.md#11-2026-09-18-t10-真实-tui--glm--cua-synthetic-fixture-闭环)、[第12节](./dev-2-tui-preview-validation-results.md#12-2026-09-18-0222-窗口发现framefocus局部-capture-与关闭拒绝)、[第13节](./dev-2-tui-preview-validation-results.md#13-2026-09-18-cli-cua-doctor-最终实机验收)。本批最终离线全量为 32 files/320 tests，root typecheck 通过；worker 本轮未调用 model API、桌面或 VM；这些结果不等 doctor 整体通过、完整 model Run 或 REL-1。

### 第一批证据（已合并，2026-09-17）

下列为第一批执行与发布记录，其中“尚未提交 / 未合并”仅描述当时状态；用户现已合并 PR #1，合并提交为 `0e41463`。第二批状态以上节为准。

用户已授权由 Luna 实施、Sol 审计，主 Agent 仅规划/调度与维护入口。共享当前工作树，保留已有文档归档改动；实施阶段先不提交或推送，随后按独立授权建立本地检查点并提交工作分支。

| 任务 | 实施者与文件范围 | 验收与状态 |
|---|---|---|
| DEV-0 CI | Luna worker_ci：`.github/workflows/**` 与专属实施记录 | Sol工作流设计审查通过；末次本地typecheck、15文件200项测试、CLI help与依赖漂移检查通过，见[实施记录](./dev-0-ci-implementation-results.md)第9节；PR [#1](https://github.com/wszkxlllll/Computer-Harness/pull/1) 的 Hosted run [35206262326](https://github.com/wszkxlllll/Computer-Harness/actions/runs/35206262326) 以 head `d57d9a8` 运行，四矩阵与 `ci-required` 均通过；B02故意失败注入未做，B06仅代码兼容，DEV-1其他项未完成 |
| DEV-1B R01/F08 | Luna worker_probe：`packages/risk-guard/src/**`；新增装配测试归入Risk包，不让Runtime反向依赖Risk | 多轮整改后Sol有限范围放行；删除否定/引用短路，收窄只读history豁免，强制审批不被reviewer降级；见[实施记录](./dev-1-risk-implementation-results.md) |
| 独立复核 | Sol reviewer_sol_probe，只读 | 最终无阻塞项；独立focused复跑22项Risk+4项装配+54项Runtime=80/80；只关闭具体缺陷，不证明开放域语义或视觉目标安全 |

实施阶段先运行离线测试/构建；CI worker先独占全类型构建，Risk worker运行focused测试，避免重复重构建。提交后 PR #1 的 Hosted run 已补充验证四个矩阵与聚合门禁；真实API测试在后续开始前另行说明模型/预算/数据范围，本批不操作桌面或VM。DEV-1A、其余诊断/配置/终端净化、DEV-1C仍待后续批次，不能将这一批通过称为DEV-1全部完成。

第一批收口后下一批优先DEV-1A Context/Memory与独立的诊断整改，继续先反例、后修复、Sol审计；共享Runtime合同不并发修改。190/194/198项均为整改中间版本，最终本地全量结果为200项。主Agent未实施或审查业务代码，仅记录Luna执行和Sol独立审查结论。第一批实现收口时尚未提交；当前Git检查点见下，不能据此宣称远端CI或分支保护已生效。

本地Git留痕已建立：用户要求的本地检查点分为三笔提交。前两批已在 `codex/dev0-dev1-checkpoint` 完成：Risk修复 `8d9f430`、CI配置 `4f131a5`；第三笔记录剩余文档/归档整理（本段随第三笔提交，故无需在此填写自身hash）。提交由Luna执行，Sol已检查敏感内容；随后仅按用户授权push工作分支并创建 PR #1，未合并main。Hosted run [35206262326](https://github.com/wszkxlllll/Computer-Harness/actions/runs/35206262326) 对应 head `d57d9a8c`，四矩阵和 `ci-required` 均通过；本次补充证据随新的独立文档提交落盘，具体 hash见Git日志，无需在此填写自身hash。后续按[开发文档规范第8节](./development-documentation-standard.md#8-本地检查点与远端交付)实行每工单commit、小批次分支PR交付，具体提交结果见Git日志与交接。

## 6. 分块重构复核（2026-09-17）

本轮只读源码检查与独立审阅确认：Runtime 已拆出 contracts、tool-registry、computer-tools、action-validation、run-controller 等文件；Context、Memory 的实现仍主要集中在各自 index.ts。不能把“每个模块都只有 index.ts”当作全仓库现状，也不以文件数量判断质量。

路线已在 DEV-2 安排 CLI 共享组装层 app-runtime，在 F13/DEV-7 安排分阶段行为保持拆分，并要求纯移动与功能修改分别审阅。复核发现的文件级映射缺口现已补入[分块重构施工表](./module-refactoring-work-plan.md)，含 RFT-1..7、公共接口、顺序及回归要求；可按所属阶段拆工单，不授权全仓同时搬迁。

执行原则：DEV-1 先补反例并修缺陷，仅按可测试性需要做小范围提取；DEV-2 进入前由集成人提交拆分映射和协议清单，冻结后再分派。后续 Context/Memory/Provider 随各阶段按职责提取预算、召回、Store、工具、序列化或传输，不机械各建新 package。每次保持公开接口、事件顺序和 Provider 输出合同，测试通过再进行下一块迁移；DEV-7 是收尾，不是首次拆分。

前一轮两个子 Agent 已完成只读调用验证：worker 使用 gpt-5.6-luna/max，reviewer_sol 使用 gpt-5.6-sol/medium。当前调度接口通过显式模型/思考强度与任务指令映射角色，不宣称自动加载自定义 TOML 或已应用其 read-only 沙箱；审阅只读要求由任务约束表达。该验证轮未进行代码实施、API/桌面测试或提交推送；后续实施状态见第5节当前调度批次。

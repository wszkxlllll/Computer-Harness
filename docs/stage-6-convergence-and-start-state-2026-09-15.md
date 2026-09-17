# Stage 6：当前实施入口

更新：2026-09-17

角色：当前执行 / 交接。基线：`39ff27f9a4ef5431450df6991793403ec890f993`。范围：DEV-0/1 修复与工程门禁，随后推进受控交互；正式评测 G0 另行收口。

## 1. 当前结论与已有基础

当前可以开始 DEV-0 和 DEV-1。Runtime、两 Provider、两 Computer Adapter、Planning、Run Memory、Context、Batch 和实验性 Risk Guard 已有实现；不能把它们视为所有边界均验收通过。

2026-09-17 已在 Windows/Node 24.19.0/pnpm 11.19.0 执行类型检查及 179 项测试，另 9 项实际实现探针复现了未覆盖问题。详细证据见[归档复核](./history/2026-09-17-roadmap-consolidation/external-audit-confirmation-2026-09-17.md)。这些是历史基线，本轮文档整理没有新测试或业务修复。

唯一开发路线：[完整路线 V2](./full-development-roadmap-v2.md)。配套：[验收清单](./development-acceptance-v2.md)。它们已直接吸收复核意见，不必先读所有旧审计。

2026-09-17 合同状态复查已补入路线 3.1：Memory scope、目标/focus/generation、InstructionState、ContextTrace/prepared request、在线图片/停滞特征及持久恢复均不能视为当前已完成。scope 保留为 DEV-4 新增能力，含绑定、召回、失效、迁移和 FM12..15 测试；当前 DEV-0/1 顺序不变。本次仅核对源码与修订文档，没有运行这些新增验收测试。

## 2. 本轮目标与顺序

1. **DEV-0 CI**：Linux/Windows/macOS Hosted Runner 必跑锁文件安装、构建/类型检查、离线测试、CLI help，统一聚合检查；Linux 补充一档 Node 兼容检查。首次 runner 成绩如实记录，真实 Mac 桌面权限、截图与输入另行验收，不能由 CI 代替。
2. **DEV-1A Context/Memory**：保护用户纠正；处理超大单记录及固定区预算溢出；统一 mutation 引用与文件 schema 校验，非法 replacement 不改旧状态。
3. **DEV-1B Risk/诊断**：修描述词豁免及 R01 强制规则优先级；统一 native/flat 诊断；明确实机配置；净化终端输出。
4. **DEV-1C 清理**：所有 awaited 清理步骤有期限；超时不伪装底层停止，不清除未知副作用或错误释放控制权。

DEV-0 与 DEV-1 可以并行；同一 Runtime 合同变更由一个集成负责人协调。先新增真实路径反例，再修复，行为修改与纯文件迁移分开提交。

## 3. 后续推进条件

DEV-2 可先做共享 app-runtime、事件订阅、Fake TUI 与只读 doctor。接真实输入前落实 V2 第 6 节的应用会话/Run、人工接管、环境所有权、目标/审批合同，通过专用 fixture 的正常与故障路径。

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

实施结果写在所属阶段交付文档并从本入口链接。当前状态：**第一批本地实施与审查完成：R01/F08 有限范围放行，PR #1 的 CI Hosted 验收已通过；DEV-1 其他项未完成**。

### 当前调度批次（2026-09-17）

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

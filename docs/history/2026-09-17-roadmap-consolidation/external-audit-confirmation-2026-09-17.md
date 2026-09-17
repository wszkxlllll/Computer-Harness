# 外部审计复核：39ff27f9 的实际问题与推进顺序

日期：2026-09-17

角色：审计复核 / 当前整改依据。基线：`39ff27f9a4ef5431450df6991793403ec890f993`。

## 1. 结论与范围

外部审计的主要源码判断成立，值得采纳。17 条发现混合了确定性缺陷、实机条件风险、工程债和候选增强，不应全部作为同一级别阻塞项。现有 Runtime/Computer/ToolRegistry/Event/Context 边界可以保留；优先补正确性、诊断隐私和人工接管，再做持续交互 TUI。无需推倒重写，也无需等 Monitor 或复杂 Memory 生命周期全部开发后才开始受控体验。

当前允许继续离线开发、Fake 集成和无副作用协议探针。个人桌面上的并发 TUI 输入、审批后自动执行敏感操作尚未验收。低风险真实输入先使用专用可丢弃 fixture，并验证焦点和停止机制。

收到的目录实际为 `Computer-Harness_audit_39ff27f9_2026-09-17/Computer-Harness-audit-39ff27f9/`。附件作为审计材料阅读；其中工单、复制模板、发布等指令没有自动执行。现有 2026-09-16 分项审计及其未提交修改已保留。本文件是外部报告的复核，Stage 6 仍是共同入口。

## 2. 本次独立验证

- 当前 HEAD 与报告完全一致；生产源码无未提交差异，已有变动属于文档和附件。
- 在 Windows、Node **24.19.0**、pnpm **11.19.0** 下执行 `pnpm typecheck` 与 `pnpm test`：14 个文件、179 项测试通过。
- 默认 PATH 原先解析到 Node 18.19.0，低于仓库 `>=22.13.0` 要求；最终验证只在本次命令进程前置隔离 Node 路径，未修改系统 PATH。首次旧 Node 下的通过不作为支持版本验收。
- 新增 [本地复核探针](../../verification/audit-39ff27f9-local-probes.mjs)，9/9 成功复现问题。它们独立于产品测试集；通过代表缺陷存在，不代表修复。
- F02/F05 调用真实 DefaultContextCompiler；F03 调用真实 Memory 工具、RunController、Reducer 与内存 Store；F08/R01 调用真实 LayeredRiskGuard；F07 使用真实 Controller 和延迟结束的 Fake Computer；F12 调用真实 TUI renderer。
- F06/补充日志问题从刚构建的 CLI 提取未修改的纯诊断函数执行。由于 CLI import 会直接运行 main，该项未进行完整 HTTP/CLI 集成；证据范围明确限于诊断投影。
- GitHub 只读核对：远端 main 仍为相同 SHA、`protected=false`、workflow 数为 0。未修改仓库规则。
- 静态检查附件 CI/CD 模板与候选归档脚本；未安装模板、未执行 GitHub workflow、未验证干净 Linux/Windows runner 安装。
- 未调用真实模型 API，未连接 CUA daemon、截图、输入或操作 VM；未 commit/push。

复现命令（使用满足 engines 的 Node，仓库根目录）：

```text
pnpm typecheck
pnpm test
node --test docs/verification/audit-39ff27f9-local-probes.mjs
```

## 3. 逐条判定

| ID | 复核结论与证据 | 处理等级 / 下一步 |
|---|---|---|
| F01 审批后旧坐标 | 成立。`run-controller.ts:788` 只比较内部 Observation；CUA foreground 输入没有外部窗口/焦点确认。真实抢焦点故障未执行 | P0：批准后敏感实机执行前。绑定目标和候选，接管后重观察，目标变化重新决策 |
| F02 用户纠正被裁剪 | **真实 Compiler 已复现**。recent 选择保留纠正，随后 token 裁剪再次删除，原 Goal 仍在 | P1：马上修，先于 Context/Memory 效果比较和产品交互 |
| F03 replacement 引用旁路 | **真实 Runtime+Memory 已复现**。Planning on/off 均可通过异值更新写入不存在的 taskId，旧 fact 也被 supersede | P1：马上修；新建、同值更新、异值更新统一校验，失败不得物化 |
| F04 TUI 默认 Guard off | 成立；CLI `--tui` 只改变交互入口，Guard 仍默认 off。示例命令显式 layered，故不能概括为所有 TUI 运行无保护 | P1 配置一致性；对外提供实机默认入口前必须修。实验 profile 保持显式可控 |
| F05 预算不严格 | **真实 Compiler 已复现**：单个超大事件、无历史但固定块过大两种路径均超预算。跨 Provider serialization 还有额外成本 | P1：先修自身估算约束，再补费用口径；字符估算本来不等于硬 token 上限 |
| F06 native 日志留全文 | **实际日志投影已复现**。`function.arguments` 原样进入 provider-exchanges；没有证据称已外传 | P0：私人内容实机/分享诊断前。统一安全诊断与本地原始事件的不同保留策略 |
| F07 cleanup 无总期限 | 成立。真实 Controller 已复现 snapshot finished、start 仍等待 close；CUA endSession/shutdown 的 await 无期限 | P1：产品退出前。清理总期限、所有 awaited operation、超时诊断和资源所有权一起处理 |
| F08 描述词抑制风险 | **完整本地 Guard 已复现**。加入 view 可使同一付款 target 从审批转为 allow | P1 立即修；可靠风险保护前属于阻塞。另见 R01 强制规则被 reviewer 降级 |
| F09 batch 无焦点证明 | 成立但需准确表述：逐动作已经采图，缺少控件焦点前置条件验证；单动作也受同类焦点风险影响 | P1：个人桌面 batch 前；受控 fixture 校验后可分级放行 |
| F10 Memory 生命周期/读校验 | 部分为缺陷，部分是设计增强。文件只检查数组外形、文本无上限确实存在；复杂 scope/自动过期不是已承诺必备功能 | 基础数据校验 P1/P2，复杂生命周期 P2；无需重新引入 ObservationId 硬失效 |
| F11 Context 成本归因不足 | 成立；已有预算/Token/轨迹统计，缺每轮选择与丢弃依据及 wire 口径 | P1：解释优化效果前按需补。无需现在记录所有 reset/环境耗时 |
| F12 TUI 问题 | 全历史 120 ms 复制、审批仅 reason、输入不暂停成立；**真实 renderer 保留 ESC 已复现**。粘贴/中文终端实测未做 | 净化、审批候选与接管 P1；刷新与布局 P2 |
| F13 大文件/组装 | 成立，属于工程债。文件长不是缺陷本身，按职责和测试边界拆分 | P2；先修缺陷再移动，避免行为变化混在大重构中 |
| F14 CI 与保护 | 本次远端重新确认没有 workflow、main 未保护。模板尚未在 runner 跑过 | P1：多人合并/重构前。私有仓库套餐能否启用规则单独核实，不直接假设可设置 |
| F15 CUA 能力/目标 | 成立，capabilities 硬编码，产品路径没有 doctor/窗口目标绑定；已有能力探针可复用 | P1：实机产品化。先能力/目标验证，再扩充动作 |
| F16 runtime 成功语义 | 是语义说明和 UI 呈现问题。现有 CLI 已分 runtimeOutcome、modelReportedStatus、fixture；评测也有官方 evaluator | P2：保留区分，不据此增加逐步 VLM verifier |
| F17 online Monitor | 尚未实现这一事实成立，离线重复统计已存在；缺少它不构成当前功能失效 | P2 候选增强；不作为产品 TUI 或低风险体验的前置条件 |

## 4. 两个新增补充

### R01：强制敏感输入检查会被提前复核绕过

位置：`packages/risk-guard/src/index.ts:149`、`:154`、`:199`。

当前顺序为 unknown/矛盾/文本歧义优先返回 semantic_review，然后才检查 `hasProtectedInput`。同一个合成 `type("password=SYNTHETIC_ONLY")`：

1. 声明 local_edit → 本地识别 protected_input → require_approval；
2. 声明 unknown → 跳过 protected_input → reviewer 返回 local_edit/aligned → allow。

本次使用 ScriptedRiskAssessor 控制复核结果，证明策略可发生降级；不声称真实模型必然这样回答。ProviderRiskAssessor 还只接收 type 长度，不能指望它补回本地已经拥有的敏感输入信息。

修复应先汇总所有确定性规则；deny/mandatory approval 的结论不能被低风险模型分类覆盖。新增回归覆盖 unknown、矛盾、文本歧义配合 protected input 的所有路径。这是第一批修复项。

### R02：Qwen flat 已迁移，但诊断摘要还读取旧 envelope

位置：`apps/cli/src/index.ts:397`。`summarizeStructuredContent` 读取 `parsed.kind/id/name/arguments`，没有遍历正式 `calls[]`。真实纯函数探针确认 flat 多调用在诊断摘要中不产生对应工具记录。

这影响两 Provider 诊断公平性和排错；Runtime 的 canonical trajectory 仍有 ModelTurn/ToolCall，因此不能称为执行调用本身丢失。与 F06 同一补丁统一 native/flat 诊断投影即可。

## 5. 报告与既有结论需要校准的地方

### 证据等级

外部附件的六个测试是复制逻辑的复现，报告对此说明诚实。本次用生产实现补证，仍不能把 fake 条件与单轮 API 探针当真实桌面通过。我们此前的“API Gate 通过、179 项通过”只证明那些样例和测试；没有覆盖本次发现的纠正裁剪、replacement、路由优先级和交互焦点。

既有 Risk API 脚本直接调用 Provider 和 Guard，没有完整 RunController/Approval/FakeComputer 执行闭环。它足以证明声明格式可用，不足以证明审批后执行安全。GLM 首次错误 `target must be 1-120 characters` 本身不能区分字段缺失、类型错误、空值或超长；未保存原始值时，“一定超过 120 字符”证据不足。独立复测成功且未消费重试，也不能称为实际验证了该失败的重试恢复。

### 设计边界

- 不需要为了 F02 立即引入 instructionRevision。先保留用户指令及顺序、处理固定预算溢出；版本化指令在目标绑定/恢复需要消费者时再引入。
- “sourceEventId 存在”证明写入来源，不证明自然语言记忆正确。任务完成不要求自动删除所有关联事实。
- 目标窗口相同、geometry 相同也不保证金额/收件人相同。审批修复必须区分目标身份、几何有效性和业务条件；单独增加 digest/时间戳不是完整实现。
- TUI 单次输入隐藏正文不意味着全部输出/日志已脱敏。原始事件保留策略与安全分享导出分别设计。
- 本轮不把在线 Monitor、长期 Memory、Subagent 加进必修范围，符合先完成 Risk、随后聚焦体验的方向。
- 附件使用 G0–G6 命名会和当前评测集 G0 混淆，落地时改为 `LIVE-0..LIVE-6`；正式评测准备继续称 G0。

## 6. CUA 与 CI/CD 建议是否可用

CUA 部分方向可采纳：从现有 daemon Adapter 和能力探针补 health、目标身份、坐标/焦点合同。核对固定上游 [0.22.2 动作支持矩阵](https://raw.githubusercontent.com/trycua/cua/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/docs/action-support.md) 后，后台投递依应用/动作支持或拒绝的说明有依据；不能把 foreground 全改 background 就视为修好。本次未做实机验证，也未重新选择升级版本。

CI 模板采用只读权限、Hosted Runner、build 后测试、聚合 required check、有限 artifact，方向合理。所固定 [pnpm/action-setup 的 action.yml](https://raw.githubusercontent.com/pnpm/action-setup/b906affcce14559ad1aafd4ab0e942779e9f58b1/action.yml) 确实有 cache 输入，本次未发现需要据此修改模板的问题。模板的 YAML 检查与归档脚本烟测属于附件作者证据；我没有把它们改称实际 CI 通过。候选归档只交付源码，不能当 TUI 安装包。应先运行真实 CI，再决定分支保护/发布配置。

## 7. 建议实施顺序和验收

第一批可在两个小改动范围推进：

1. **正确性补丁**：F02/F03/F05 基础部分。反例先进入真实模块测试；用户纠正始终可见或预算显式拒绝；非法 replacement 不改旧值、不写 mutation；预算不可满足时不调用 Provider。
2. **风险/诊断补丁**：F08/R01/F06/R02/F04，加 TUI 最小终端净化。强制审批不被 reviewer 覆盖；native/flat 用合成标记验证诊断不含正文；生效配置在入口明确显示。

CI 可与第一批修复同时落地，不必等待 CI 完成才写失败测试。修复提交和文件迁移分开。

第二批：F07 总清理期限、共用 app-runtime 和事件订阅；先保留现有执行行为，再拆文件。订阅发生在事件提交/投影后，UI 异常不能破坏 Run。

第三批：CUA 目标合同与人工接管，配合产品 TUI。Fake 可以提前开发；真实输入必须经过专用 fixture 的切焦点、暂停、批准/拒绝、失联测试。已经发出的 OS 输入不能被 Abort 保证撤回。

通过这些条件后即可在低风险任务中体验优化，无需先完成所有十份附件工单。ContextTrace、Memory/Context 效果对照按实验需要补充；Monitor 保留独立候选，不延误当前可用性路线。正式 Development/Validation 沿用冻结规则，不把错误修复前后当同一实验版本。

## 8. 交付状态

本次交付复核报告、9 项可重跑审计探针和两个入口链接。未修业务代码、未搬动外部附件、未覆盖既有分项审计、未安装 workflow、未修改远端设置。所有问题仍为待修/待验证，不能因审计探针 pass 自动关闭。

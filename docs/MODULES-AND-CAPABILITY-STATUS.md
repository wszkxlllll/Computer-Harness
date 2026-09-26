# 模块、策略与能力状态

当前实现说明，配合[交接入口](./PROJECT-HANDOFF.md)阅读。下列“实现”不等于所有真实任务通过；默认值必须按应用入口区分。

## 1. Provider 与工具

现有 GLM/Qwen Adapter 消费统一 ModelInput 和 ToolRegistry 投影，处理图片、工具 Schema、历史回执、continuation、坐标与 ModelTurn 解析。不要在新 Provider 内另维护一份业务工具清单。

- GLM 主配置为 `glm-5.3-flash`，thinking 可启停。
- Qwen 主配置为 `qwen3.8-flash`，支持仓库约定的坐标模式、thinking 与输出模式；当前 strict 路径采用统一 flat calls 信封，不应恢复旧的单调用/多调用顶层 anyOf 分叉。
- 厂商 wire 格式属于 Adapter；Runtime 保持统一 ToolCall/ActionIntent。坐标转换必须依据本轮真实图片 viewport，不能猜测一个固定尺寸。
- Reasoning continuation 属于对应 Provider 的历史合同，不能当作普通摘要任意删除或混入另一 Provider。
- 这些是仓库选项，不保证服务商账号、模型权限或余额当前可用。真实 API 连通性要独立验收。

工具按功能包括 Computer、Planning、Memory、Control 等；但协议 category 的实际枚举是 `computer | planning | control | side`，Memory 工具归 `side`，没有 `category:"memory"`。Registry 负责描述、参数、类别/audience；ModelTurn 可包含符合 Turn Policy 的多个调用。状态工具不是 GUI Action，不能为了统一多调用把所有工具塞进 Computer.execute。

## 2. Computer 与 Grounding

| 后端/能力 | 当前内容 | 边界 |
| --- | --- | --- |
| CUA | pinned 0.22.2 Adapter、session、窗口/整桌面观察、动作、诊断 | foreground/background 能力不同；回执不保证业务效果；原生输入/弹层有已知问题 |
| OSWorld | DesktopEnv Bridge、观察/动作映射及评测生命周期接线 | VM reset/evaluate 是环境侧职责，不装成 CUA；须独立预检快照与 evaluator |
| Fake / external | 离线合同与 SDK 环境替换 | Mock 通过不代表真实输入；external 不自动获得 CUA 专属 Grounding |
| UIA | 精确窗口的结构化候选，过滤后投影 hot catalog | 默认关闭；不是所有控件都会暴露，也不是每个候选都可信/可执行 |
| DOM / Hybrid | 受管浏览器中的 DOM 候选，和 UIA/视觉补充 | 不静默接管个人浏览器；非网页应用不能依赖 DOM |

Grounding 的生产者在 Computer/浏览器适配层，Runtime 负责当前观察的有界候选选择，Context 将有限目录给模型，工具返回的 ref 再由 Adapter 校验。ref 受 Observation/session/目标有效性约束；resize、切窗、重新观察后不能把旧元素当永久 ID。

`click_element` 与视觉坐标 click 可共存；`select_option` 已有源码和测试，但不表示所有自定义下拉框都受支持。截图仍用于全局布局、状态和无结构控件。UIA/DOM 并非消除视觉操作的替代品，也不能凭额外候选数量证明成功率提升。

## 3. Context

默认实现位于 `packages/context`；Runtime 只依赖 ContextCompiler 合同。raw/recent 策略、历史窗口/输入预算、Plan/Memory、当前观察、纠正、Monitor/Grounding 与工具投影在这一层组合。

- 稳定说明和工具 Schema 与动态观察/状态分开组织，有利于分析前缀稳定性；**不保证服务商一定缓存命中**。
- history 裁剪必须维护工具调用与结果的协议一致性，保留当前任务、用户纠正和必要 continuation。
- Context trace 记录实际纳入/遗漏的内容和原因，不能只记录召回候选却声称全部进入模型。
- 目前不是一个已完成长期 summary/compression/retrieval 系统；需要通过可替换策略实验决定下一步。
- 替换 Context 时仍须消费当前启用模块的工具/投影，不把新的工具藏在主循环里的私有提示词。

## 4. Planning 与受限 Batch

Planning 是模型主动调用工具维护的 Run 内 TaskState，不是强制 DAG 调度器，也不要求每次点击建任务。多阶段任务应记录阶段目标、进度、阻塞与交接；这些记录仍是模型维护的状态，不是环境事实真值。

`createPlanningModule` 可以替换工具、提交后物化和 Context 投影，仍遵守 Run ID/状态/Event 合同。关闭后无 Planning 工具和投影。

Batch 当前为 `same-control-input-v1`：只接受受限的同控件连续输入组合，逐动作走 Runtime 的预算、准入、事件、Receipt 和观察；不能解释为任意多点击/跨导航脚本。State tools 与合法动作可以同轮返回，但不免除依赖和 Control 单独结束等边界。

Execution Segment 是另一条明确标记 unfinished 的 opt-in 实验：有工具和 reconciliation，不是普通 Planning 的必需结构，不应默认强制模型创建；当前没有依据证明它稳定带来净收益。

## 5. Run Memory

Memory 用于历史裁剪后保留继续任务所需的信息，区别于“任务做到哪里”的 Plan 和“完整发生什么”的轨迹。

字段定义见 [Memory 协议](../packages/protocol/src/index.ts)，模块接线见 [Memory Run module](../packages/memory/src/run-module.ts)，文件隔离见 [Store](../packages/memory/src/store.ts)。

| 字段/概念 | 实际语义 |
| --- | --- |
| scope | 只有 run 或指定 computer_session，不是用户级长期空间 |
| retentionClass | stable / task / short_lived，是保留/使用分类，不是跨 Run 持久化承诺 |
| status | active / needs_check / superseded，用于可用、待核实和已替代事实 |
| evidence / generation | 来源事件、更新序号、实体 generation 和 session 适用性参与校验；不是只按动作数定期失效 |
| facts / entities 模式 | 模型工具与投影策略选择；实体状态仍需有明确事实来源/更新，不靠空 ID 维护真值 |

模型通过 Memory 工具写入/更新/查询；Runtime 提交 mutation，模块物化，召回服务和 Context 消费。候选可因已替代、scope 不匹配、实体缺失/过时而排除。待核实信息与可直接使用信息分区，不能把 last-known 状态当成当前事实。

默认 lexical；hybrid 需要显式 embedding endpoint/独立凭据和预算。查询可使用当前 Goal、纠正、Task/状态与 session 信息，不能假定不开 Planning 就无法召回。语义相似度只用于候选相关性，不证明事实仍然成立。实际纳入模型的 ID、预算遗漏和召回状态由 Context trace 记录。

FileMemoryStore 以 Run ID 保存 memory.json，新 Run 创建新模块；已有落盘不等于自动跨 Run 召回。长期个性化记忆仍是后续设计。替换模块应保持写入→裁剪→召回→消费→纠正/失效闭环，并验证两 Run 隔离。

## 6. Monitor 与 Guard

Monitor 为 off/shadow/guidance。动作终态、工具回执和新观察提交后，Monitor 消费 transition；shadow 记录提案，guidance 可注入提示、有限重复拒绝或延迟请求人工帮助。它不是另一个默认运行的大模型，也不会替主模型重新定位。

changed/unchanged/unknown 是低置信度视觉变化信号，不是语义成功。重复检测不能保证所有相邻错误点击都会被识别，不能把用户没有看到反馈视为已经恢复。

Guard 为 off/layered，是动作准入，不是执行效果 verifier。详细信任边界见[安全合同](./RUNTIME-AND-SAFETY-CONTRACTS.md)。Host 固定开启 layered；本轮离线 `layered→off→layered` 检查确认当前 Schema、必填要求和 GLM 历史回填按开关变化且不污染原 Registry；自定义提示词/历史诊断文字仍原样保留，字符串出现本身不代表 active schema 残留。

## 7. Jev 的当前位置

Jev 当前是 CLI/TUI 的显式窗口选择器，默认仍为本地匹配；启用必须明确允许向 TypeSafe 发送可见窗口应用名/标题。TUI 的严格条件自动窗口交接不代表任意窗口会自动切换。

旧 GUI fast path 不应被描述为当前主执行链；Jev 不是 GLM/Qwen 的同级通用多模态 Provider，也没有已证实的全任务降延迟收益。未来若重新尝试动作候选选择，应有清晰候选语义、充分召回、置信度/回退和独立实测，不为了使用 Jev 强行要求 Execution Segment。

## 8. 入口默认值不能混用

| 入口 | 关键默认/选择 |
| --- | --- |
| CLI | 按参数与 profile；非交互 experiment 和交互 live-interactive 不同；monitor/grounding 默认 off |
| TUI | 可选择下一 Run 的模块与窗口；CUA TUI 有 grounding auto 和人工交接入口 |
| PowerShell research 预设 | entities、lexical、Batch、recent、Monitor guidance；Guard off 来自 wrapper，不是所有入口通用默认 |
| 手机 Host | Planning on、facts、lexical、Batch、recent/80、Guard layered/same、风险模型预算 1、Monitor shadow、handoff confirm-v1、Grounding off |

配置应在 Run 开始时冻结并明确呈现。模块开关、策略版本和结果归因是后续实验的组成部分；不要仅凭包名、README 默认值或上次 TUI 选择推断当前 Run 的实际配置。

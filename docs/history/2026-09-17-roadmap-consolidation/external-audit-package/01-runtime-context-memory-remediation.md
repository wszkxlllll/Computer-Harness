# Runtime / Context / Memory：源码审计与可靠性整改

基线：`39ff27f9a4ef5431450df6991793403ec890f993`。以下代码位置以文件和函数标识，源链接固定提交；避免主分支移动后对错行。**已复现**仅指附件中的提取函数行为；**源码确认**表示读取实现后成立；**条件风险**表示还需对应环境/故障注入验证。

## 1. 总体判断与保留项

项目不需要推倒重写。已有稳定的 ModelInput / ModelTurn / ToolCall、Computer 接口、统一 ToolRegistry、先写事件再投影的状态机制、串行 GUI 执行、分组调用预检、用户纠正失效处理，以及 GUI 执行异常的 unknown outcome 终止保护。这些是值得保留的执行基础设施，而不是简单 while-loop 上挂了一组函数。[S01、S02、S06]

特别要保留 `commitEvent` 的顺序：先验证候选迁移，写入 EventWriter，再依据真实返回事件更新 Snapshot；Plan/Memory 文件是后续物化视图。不能为了“各 Store 一致”再加一个与事件流竞争写权限的同步器。[S01、S06]

当前风险主要来自三个边界：**模型说了什么不等于环境发生了什么；内部 observationId 不等于外部世界没变；同一 Context 上限不等于真实 Provider 请求成本相同。**

## 2. 审计问题总表

| ID | 优先级 | 判定 | 问题 |
|---|---|---|---|
| F01 | P0：敏感实机前 | 源码确认，桌面场景待验证 | 审批后只验证内部 Observation，没有检测外部画面/焦点变化 |
| F02 | P1 | 提取逻辑复现 | token 裁剪可删除用户中途纠正 |
| F03 | P1 | 提取逻辑复现 | supersede_fact.replacement 绕过 relatedTaskIds 校验 |
| F04 | P0：实机默认配置 | 源码确认 | --tui 不会自动开启 Risk Guard，与验证计划不符 |
| F05 | P1：预算/实验 | 提取逻辑与源码确认 | 预算是近似值，单事件可越界，Provider 后处理未计入 |
| F06 | P0：隐私实机前 | 提取逻辑复现 | 原生 ToolCall 的诊断日志保留完整 arguments |
| F07 | P1 | 条件风险 | close/shutdown 的等待不是全程有界 |
| F08 | P1：安全承诺边界 | 文本分支复现 | 风险语义依赖自报，描述词可抑制高风险关键词信号 |
| F09 | P1：可恢复实机输入 | 源码确认，焦点故障待验证 | micro-batch 白名单不保证目标焦点正确 |
| F10 | P2 | 源码确认 | Memory 生命周期和读取校验需要补强，但不是旧口述的 observationId 硬失效问题 |
| F11 | P1：对外实验结论前 | 源码确认 | Context 组成与真实成本归因不足 |
| F12 | P1/P2 | 源码确认，终端场景待验证 | TUI 全量轮询、终端文本净化和审批展示不足 |
| F13 | P2 | 源码确认 | 组装与部分实现文件过大，协作冲突高 |
| F14 | P1：协作前 | 源码和仓库设置确认 | 无工作流，main 未启用保护/必需检查 |
| F15 | P1：实机产品化 | 源码确认 | CUA 能力硬编码，缺少产品侧 health/目标绑定 |
| F16 | P2 | 源码确认，属语义澄清 | 正常结束、模型宣称成功和外部验收成功需明确区分 |
| F17 | P2：增益优化 | 源码/现有分析器确认 | 有离线重复统计，但未见在线 Progress/Stall Monitor |

## 3. 必须先修的确定性问题

### F02：用户纠正会被后续预算裁剪删除

**位置：**`packages/context/src/index.ts`，`selectHistoryEvents`、`fitEventsToTokenBudget`、`compile`。[S03]

`selectHistoryEvents` 在 recent 模式下特意保留 `user.input.received`，但下一步 `fitEventsToTokenBudget` 并不识别用户指令。它查找 ModelTurn 边界后执行 `retained.splice(0, end)`；在该段之前或之间的用户纠正会一起被删除。没有 ModelTurn 时还会直接 `shift()`。因此“原始 goal 固定保留”成立，“所有用户纠正也不会被裁剪”不成立。

**触发示例：**用户中途说“不要发送”，随后产生一段较长 response，下一轮因 Memory/工具定义占用预算而需要裁剪，纠正可能消失，原始“发送邮件”的 goal 却仍然存在。附件第 1 项用例复现裁剪算法删除该用户事件。

**最小修复：**先把 authoritative user inputs 从可驱逐的 trajectory chunks 分离，单独计预算；仅驱逐完整的 assistant-call/result 组。放不下关键用户输入时显式返回 budget overflow，不静默丢弃。不要把用户纠正的保存责任转交给模型写 Memory。

**下一阶段：**增加 `instructionRevision` 和当前任务指令视图；保留原始消息可追溯。新自然语言指令是否撤销旧约束仍需语义理解；不能仅验证 `sourceMessageId` 存在，就让模型解除硬权限或敏感操作授权。对于放宽安全约束，使用受信的人类确认/结构化授权路径。

**验收：**原始 goal、早期限制、后期纠正共存且预算紧张时，当前有效限制仍可见；工具调用与结果不拆散；不足预算时无 Provider 请求和 GUI 动作；相反指令的处理有回归样本，且 Host 规则不能被模型覆盖。

### F03：Memory 替换分支漏校验

**位置：**`packages/runtime/src/run-controller.ts::validateMemoryTaskLinks`；`packages/memory/src/index.ts::memory_write_fact`。[S01、S04]

同 key/subject 改变 value 时，Memory 工具产生 `supersede_fact` 和 `replacement`。Runtime 的关联任务校验仅覆盖 `upsert_fact` 和 `upsert_entity`，没有检查 replacement。于是第一次写不存在 taskId 会失败，但更新已有 Memory 时同样的非法 taskId 可能通过；Planning 关闭时也可走这条遗漏路径。附件第 3、4 项复现这一差别。

**修复：**为所有会引入实体/事实内容的 mutation 提供统一遍历函数，统一校验 `relatedTaskIds`、subject/entity 引用、长度、run 归属；`supersede_fact.replacement` 不能是旁路。使用穷尽 switch，让未来新增 mutation 在编译或测试时要求补校验。

**原子性要求：**校验失败前不得写 `memory.updated` 事件，不得 supersede 旧事实，不得物化新文件。不要先改 store 再尝试补事件。

**验收：**覆盖新建、同值更新、异值 replacement、Planning on/off、合法/未知 taskId；非法更新后旧值与旧状态保持，事件重放结果和文件一致。Runtime 集成回归必须调用真实工具路径，而不是只运行附件函数。

### F04：TUI 默认风险配置与文档不一致

**位置：**`apps/cli/src/index.ts::parseArgs/main`；现有 Gate B 文档。[S08、S18]

`--tui` 只让 interactive 为 true，`riskGuardValue` 仍默认 `off`。创建 `actionPolicy` 也依赖该值。因此单加 `--tui` 不会得到文档宣称的默认 Risk Guard。

**修复：**区分 `fixture/evaluation` 与 `live-interactive` 配置 profile。前者可以显式关闭 Guard 做对照实验；后者默认 layered，若关闭必须显式确认并显示醒目状态，不可静默沿用实验默认值。Guard 无语义 reviewer 时不确定操作应保持审批 fallback，不能为了开箱即用自动放行。

**验收：**解析 `--tui` 后生效配置与 Guard 实例都为预期；headless 实验参数不被偷偷改变；CLI help/README/TUI 显示取自同一 resolved config。新增 profile 的名称是整改设计，不是当前已支持参数。

### F05：Context Budget 尚不能当严格的公平预算

**位置：**`packages/context/src/index.ts::compile/fitEventsToTokenBudget`；Qwen/GLM `generate/presentMessages`。[S03、S12、S13]

当前大体按字符数除以 4 估算，历史按事件 JSON 而非实际消息计数。循环条件 `retained.length > 1` 会保留一个超预算事件（附件第 2 项）。fixed 区预算不足的检查还依赖历史是否非空。更关键的是，Qwen Adapter 会再附加工具 catalog、envelope、control boundary 并产生 response schema；GLM 有自己的 profile prompt 和工具格式。ContextCompiler 无法仅靠统一工具 JSON 精确计入这些最终开销。图像成本是报告 imageCount，而不是精确计入当前文本预算；这在接口注释里也有说明，不应被解读成完整输入 token 上限。[S02]

**最小修复：**把参数命名/报告明确为 `estimatedTextBudget` 或等价语义；所有输出路径最终检查估算上限，处理不可裁剪区和单个超大结果。对 Memory value、entity description、plan description、tool result 设置可配置字节/字符限制和摘要/截断标记，避免单条内容撑爆 fixed 区。

**更完整修复：**Adapter 提供无网络的 request-preparation/estimation 结果，报告 serialization profile、工具/schema/prompt 开销、图像估计和输出预留。Runtime 再按预算编译/调整，禁止通过再次调用模型来“计算 token”。若无法精确 tokenizer 计数，给出估算方法和误差，不假装精确。

**验收：**中文、英文、嵌套 schema、长 Memory、长结果、无可裁剪历史都覆盖；最终 Provider usage 与估算一起入报告；内存组和 baseline 的预算口径相同。跨 Provider 的 token 单位并非天然等价，还应报告实际费用/延迟或分别做同 Provider 对照。

### F06：原生工具日志保留输入文本

**位置：**`apps/cli/src/index.ts::summarizeProviderResponse` 及 Recording HTTP clients。[S08]

原生 `message.tool_calls` 的 `function.arguments` 被原样写入 provider-exchanges，而 structured content 分支尝试只保留部分统计。这导致相同 `type(text)` 在不同协议下有不同的隐私暴露范围。附件第 6 项用合成文本复现，未使用真实秘密。

**修复：**两种 wire 先归一成同一诊断视图，再应用字段 allowlist。默认仅保留工具名、callId、参数长度/类型、坐标等经审核字段；嵌套 memory value、typed text、用户描述、路径、URL 查询参数都不因名字不同而漏过。错误消息和 reviewer evidence 也要走输出净化。

**重要区分：**执行用本地 canonical event/WAL 与可分享的 telemetry 不是同一种数据。不能直接把必要状态从 WAL 脱敏删除后还承诺完整重放。前者应明确告知、限制访问、设置保留/删除策略；后者默认安全导出。截图单独列为敏感资产。CI 只上传无隐私合成报告，禁止上传整个 runs/。

**验收：**native、strict flat `calls[]`、错误响应、风险评估、Memory/Plan 调用均注入合成敏感标记，公开诊断输出不能包含标记；本地原始保留模式必须显式启用并说明边界。

## 4. 实机正确性边界

### F01：审批后的内部新鲜度不等于真实桌面新鲜度

**位置：**`RunController::executeApprovedCall` 与 CUA `execute/mapAction`。[S01、S07]

Runtime 会拒绝基于内部旧 Observation 的 prepared call，这是已有保护。但审批等待期间如果用户换窗口、窗口移动、外部网页自动变化，内部 latestObservationId 可能根本没更新。当前 CUA 输入固定为 primary desktop / foreground；用户为了在 TUI 按 Y 而切到终端后，旧坐标或后续 typing 的接收目标也可能改变。

现有本机验证计划已把“外部桌面变化未检测”列为 P0；这不是本次新发明的风险，而是需要从计划变成执行约束的已知阻塞。[S18]

**修复路径：**审批绑定 canonical candidate digest、任务指令 revision、目标身份/窗口 generation、Observation 和到期时间。确认后先回到受控目标，获取新状态并验证允许的前置条件。目标/几何/焦点或相关内容改变就废弃旧候选，重新决策/审批；不允许简单把 basedOn 改成新 ID 后执行旧坐标。

截图重新获取本身也不是语义证明，尤其是后台订单是否已经提交、焦点是否位于正确输入控件。无法建立目标绑定时，只放行隔离 fixture，不把普通桌面点击包装成强安全事务。

**验收：**等待审批时移动窗口、切到 TUI、改变表单金额/收件人、切换账号；旧候选不得执行。审批不能沿用到另一 Run 或新 candidate。用户拒绝后无动作，用户纠正不能通过已发出的旧审批绕过。

### F07：清理路径需要总时限

**位置：**CUA `close`，Runtime `finally/cleanup`。[S01、S07]

目前有 cleanup wait 配置，但等待函数周围的 `endSession`、`shutdown` 并不因此自动有界。上游明确 `shutdown` 会等待已受理操作结束；若该操作挂起，只限制两次查询之间的睡眠并不够。[U02]

**修复：**定义统一 cleanup deadline；区分“停止接收新动作”“等待已派发动作结果”“结束 session”“关闭本 Run 拥有的 driver/daemon”。超时输出诊断并把仍未知状态保留，不改写成 cancelled/failed。杀进程只能针对应用确实拥有的 private daemon PID，不能 kill 用户已有 daemon 或应用。

**验收：**让 fake `endSession` 和 `shutdown` 永不 resolve、延迟 resolve、拒绝；应用应在配置时限内返回可解释状态，不能重复执行动作或伪造成功清理。生产执行还需独立 Windows daemon 故障注入。

### F08：风险自报不是独立证据

**位置：**`LayeredRiskGuard::routeCandidate/scanDeclarationText`。[S10]

已有 reviewer、模型预算、超时、fallback，并不是只有关键词。但低风险直通主要仍依赖模型给出的 effects、target、summary。一旦模型把实际危险点击描述成普通导航，Runtime 无法从坐标独立恢复语义。文本规则还有一个具体分支：出现“查看/草稿/type”等描述词且 effect 为 navigate/local_edit，就跳过该描述的高风险关键词扫描；“查看账单后点击确认付款”也可能被这个规则排除（附件第 5 项仅复现文本判断函数）。

**修复：**先补针对混合语义和含糊 target 的对抗 fixture；不确定性不能被“出现描述词”整体消除。把可信的 app/window/允许操作范围与模型声明分离。已声明高影响、可信信号冲突、不可逆敏感操作不降级；语义复核采用现有 assessor 按需触发。增加字段只能改善表达，不能解决同一个模型可以把所有字段都填错的问题。

**范围边界：**不能承诺纯截图 + 单模型声明 + 关键词就能保证任意 GUI 安全。首版用隔离环境、明确目标、限制敏感输入与人工接管来限制损害；没有独立证据的 low 只是当前策略判断，不是证明。

### F09：micro-batch 有截图，但没有焦点 postcondition 证明

**位置：**`isSameControlInputBatch`、`executePendingEntries`、`executeComputerCall`。[S01]

白名单包含 click→type、Ctrl+A→type、click→Ctrl+A→type，确实不是任意跨页 batch。源码在每个子动作后仍会 `observeAndCommit`，所以前面“batch 中间完全没有截图”的说法也需修正。问题是后续动作不经过新的模型决策，也没有独立验证输入控件焦点；新截图被采到不等于前置条件被验证。

**修复：**保留 micro-batch 白名单；仅为已绑定低风险可恢复文本控件启用。能从 UIA/受控 fixture 获取 active/editable/focus 信号时先验证；不能验证时允许按配置拆步或禁止敏感输入。批处理的收益当前主要是减少模型轮次，不应把它当成减少到“一批一截图”的实现事实。

**验收：**点击落空、控件 disabled、焦点被弹窗抢走、Ctrl+A 落到网页而非输入框、typing 途中 correction，分别验证剩余动作取消和下一次重观察。普通 receipt completed 不能充当 focus_verified。

## 5. 状态与上下文增强：不要再造一个智能 Runtime

### F10：Memory 的正确演进

当前 Memory 已有运行时来源盖章、needs_check/superseded、实体状态、按任务相关性和更新时间排序。它不是“所有 Memory 随 observationId 改变就拒绝”。在所读 reducer 和工具路径中也没有“task 一完成就自动 expire 全部关联 Memory”；完成任务仍参与召回打分，只是优先级较低。[S03—S06]

第一批应修 mutation 校验、长度限制和文件读取的完整 schema 校验。再增加少量显式 dependency/freshness 元数据，优先处理能够确定的事实，例如某 session 已关闭、某 artifact 已替换。对截图推导的自然语言事实，Runtime 通常只能标记可能过时，不能自动证明其语义。

`sourceEventId` 回答的是谁在哪次写入产生记录，而不是哪个页面证明它。`taskId` 是关联索引，不必等价于生命周期。scope 不是简单 task > session > page 的一条总排序；事实可能同时依赖 task 与特定窗口。模型建议的 kind/scope 不能用来放宽权限，也不能通过“引用的 ID 存在”升格为可信事实。

建议先用现有 `needs_check`，避免同时新增 confirmed/dirty/invalid 与旧状态平行。明确：模型负责工作记忆内容；Runtime 管引用、预算、可确定的生命周期；下一轮正常决策可处理语义冲突，但不额外每帧调用模型。恢复确认需要新依据，不靠重复出现次数自动升级为长期事实。

### 历史事实、当前状态和任务声明要分开

“进入设置页完成过”不因为后来回到 Home 就撤销；“当前位于设置页”会失效；“保持 VPN 开启”是持续约束。TaskStore 已在工具描述里强调 completed 是声明，不是 GUI 验证。[S11]

不要做一个全局 `Observation > TaskStore > Memory` 排序。Observation 是截图证据，Runtime 是执行事实，Task 是目标/进度声明，Memory 是模型派生信息。要把两个领域中的事实判成冲突，通常需要明确比较对象；Runtime 在纯像素条件下不能凭空知道页面写着 Upload failed。无法独立识别时让主模型在下一轮识别，不伪造一个无需视觉理解的 conflict detector。

### F17：Progress/Stall Monitor 先 shadow，不先干预

`analyze-trajectory.mjs` 已有相邻重复动作统计，并明确声明它只产生候选，不证明没进展。应复用其签名思想，抽出纯函数和测试；在线监控新增窗口统计，不另写一套含义不同的重复判断。[S16]

第一阶段记录 action similarity、receipt failed/refused、截图差异（如缩略图像素变化，注意动态区域）、Memory/Plan mutation；**没有调用 Plan/Memory 是“没有该观测信号”，不是“任务没进展”**。页面变化也不是目标进展。监控先只记录，人工标注误报/漏报；阈值在开发集选择，验证集锁定。

第二阶段才对多项异常叠加发送一次 guidance，设置 cooldown 和次数上限；仍有异常时停止或请求帮助。不能因为连续三次 Action 就强制 Plan，也不能只因发生新 Memory 写入就清除 stall suspicion。

## 6. F11：实验与归因整改

已有 ContextBudget 计数、trajectory、Provider exchange 和离线统计，不能说“完全没有观测性”。缺的是每轮具体采用/淘汰了什么，以及最终 wire 层的预算解释。[S01、S03、S08、S16]

建议 `ContextTrace` 至少包含：runId、requestId、compilerVersion、features、instructionRevision、selectedEventIds、selectedMemoryIds、各区估算 token、discarded IDs/reasons、最新 Observation、Provider presentation profile、最终请求 hash。对包含用户内容的完整 prompt，仅在受控 fixture 或明确选择的本地私有诊断模式保存，不能默认发到 CI。

实验最少比较 recent-only、recent+结构化 Memory，固定同一 Provider 配置、任务起始快照、primitive action 上限、模型请求上限、超时和图像策略，记录实际用量。加 Memory 也改变了工具与系统提示，应称为“Memory-enabled context policy”的系统干预，而不是宣称只隔离了 MemoryStore 的因果作用。再有预算时加入同额度普通摘要对照。

失败标签可以分为内容错误、过期/冲突、召回遗漏、预算分配、模型利用错误，以及环境/模型服务异常。但这些是审阅结论，应保留支持的事件/页面，而非自动从失败结果猜标签。

**修正前面讨论的 replay 说法：**固定旧轨迹并替换 prompt，只能比较该决策点的模型输出；模型一旦选择不同动作，后续环境也不同，不能沿用原来的截图/结果宣称反事实任务成功。端到端归因需要从同一可恢复环境快照分叉、各自重新执行，并重复采样。只有离线轨迹时，把结论限制为“决策差异/可能原因”。

20+20 可以作为开发/验证起点，不是统计可靠性的保证。小样本报告分子分母、配对胜负与任务类别；不要一两次波动就定最优参数，更不要在验证集上循环调 threshold。风险、取消和超时的确定性 fixture 测试与 OSWorld 成功率分开。

### F16：结束状态语义

GLM 无工具的非空自然语言会被映射为 finish；DefaultRuntimePolicy.canFinish 允许结束，Runtime 会据报告状态结束。已有离线评测脚本明确不把 runtime outcome 当 evaluator ground truth，这是正确的。[S13、S24、S16]

产品 TUI 和汇总报告也要保留这一区别：executionOutcome、modelReportedStatus、externalEvaluation 三列分开。没有外部验收时显示“Agent 已结束 / 未验证”，而非直接说任务验收成功。这里不要求每步额外 verifier；可在任务结束时使用受控 fixture 的结果断言。

## 7. 产品与工程问题指向

F12：当前 TUI 每 120ms 读取并复制全部 events 后再取尾部，随轨迹增长会产生额外成本；clip 的文本处理不能作为终端控制序列净化，审批界面也应展示实际候选及目标，而不只展示一个 reason。详见方案 02。[S09]

F13：Runtime 已部分拆分，但 Controller、Provider、Trajectory 和 CLI 仍承担多职责。按行为保持原则拆分，禁止把重构和协议变更混进同一个大 PR。详见方案 03。[S01、S06、S08、S12、S13、S17]

F14：工作流与主分支保护需要建立。F15：CUA 的真正优先项是从硬编码 capability 走向已验证能力/目标信息，而非把 SDK 工具全量暴露。详见方案 02/03。[S07、S14]

## 8. 关闭问题的标准

一个问题只有在“新增反例测试先失败 → 修改真实执行路径 → 新老测试通过 → 文档和实际默认值一致 → 对应实机条件通过”后才关闭。只有类型定义、增加字段、写出设计文档或提取函数用例通过，都不能作为实机问题已解决的证据。


## 依据与定位

- [S01：Runtime 主执行路径](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/runtime/src/run-controller.ts)
- [S02：Runtime 合同接口](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/runtime/src/contracts.ts)
- [S03：Context 编译、裁剪与 Memory 召回](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/context/src/index.ts)
- [S04：Memory 工具与文件存储](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/memory/src/index.ts)
- [S05：Protocol 与 Memory 状态迁移](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/protocol/src/index.ts)
- [S06：Trajectory Reducer / Writer / AssetStore](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/trajectory/src/index.ts)
- [S07：CUA 产品适配器](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/computer-cua/src/cua-driver-computer.ts)
- [S08：CLI 参数、组装与 Provider 日志](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/apps/cli/src/index.ts)
- [S09：当前调试 TUI](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/apps/cli/src/tui.ts)
- [S10：Risk Guard 分流与可选语义评估器](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/risk-guard/src/index.ts)
- [S11：Planning 工具与存储](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/planning/src/index.ts)
- [S12：Qwen Adapter](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/provider-qwen/src/index.ts)
- [S13：GLM Adapter](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/provider-glm/src/index.ts)
- [S16：离线轨迹统计脚本](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/scripts/stage5-osworld/analyze-trajectory.mjs)
- [S17：现有产品 TUI / 拆分计划](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/docs/product-tui-and-module-refactor-plan-2026-09-16.md)
- [S18：现有 Risk / 本机 TUI 验证计划](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/docs/risk-guard-real-api-and-local-tui-plan-2026-09-16.md)
- [S22：Context 测试](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/context/src/index.test.ts)
- [S23：CUA Adapter 测试](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/computer-cua/src/cua-driver-computer.test.ts)
- [S24：Runtime 默认策略](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/runtime/src/defaults.ts)
- [U02：CUA 0.22.2 TypeScript SDK 合同](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/typescript/README.md)

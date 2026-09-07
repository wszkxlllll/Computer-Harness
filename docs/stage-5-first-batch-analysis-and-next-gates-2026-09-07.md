# Stage 5 首批模型任务分析与下一阶段门槛

日期：2026-09-07
文档角色：审计
状态：当前执行
当前入口：[DOCS-INDEX.md](./DOCS-INDEX.md)
基线：OSWorld `fc31a9049664292fcb35d6e501ee1dc839f2cf6d`；快照 `osworld_initial_1920x1080_clean_r4_20260906`；结果见 [Stage 5 模型任务结果总表](./stage-5-model-task-results-2026-09-07.md)
范围：分析 GLM 30 条和 Qwen 5 条任务结果，补齐效率/延迟统计设施要求，决定修复、重跑、扩集和后续开发顺序；不修改 Runtime、Provider、Computer 或实验数据

## 1. 结论

**可以推进：Stage 5.1 修复可靠性问题，并开始 Monitor、Planning/Context、Memory 和 Advisor tool 的分项设计实验。** 实验依赖以 [技术计划书顶部的当前扩展主线](./gui-agent-harness-v1-technical-plan.md) 为准；不要求前一个增强模块提高成功率才允许实施下一个。

当前 30 条 GLM 结果已经足以发现基础设施和运行策略问题。继续增加更难任务会重复暴露已知故障，并把基础设施失败误计为模型失败。正确顺序是：

1. 保留当前结果作为不可覆盖的 baseline，并先从现有 EventStream 回填当前能计算的效率与延迟指标；
2. 补齐轨迹统计脚本，再修复少量通用基础设施问题；
3. 只重跑能够验证对应机制的失败任务和邻近成功任务；
4. 接通 Planning 与 Context 并开始对照实验；随后分别研究 Context 策略、Monitor、Memory 和 Advisor；
5. 通过门槛后冻结 V1；后续功能开发集偏向困难任务，最终 holdout 仍保持分层和平衡。

GLM 已经可以作为当前 Harness 的默认开发 Provider。Qwen 的 5 条结果足以说明它当前存在明显的长流程恢复问题，但不足以估计总体成功率，也不能与 GLM 的 30 条总分作公平横向比较。

## 2. 已核实结果

### 2.1 总体结果

| Provider | 任务数 | evaluator 满分 | 其他正分 | evaluator=0 | evaluator 满分且 Runtime 正常结束 |
|---|---:|---:|---:|---:|---:|
| GLM-5.3-Flash | 30 | 20 | 1（S06：0.997741） | 9 | 17 |
| Qwen3.8-Flash | 5 | 2 | 0 | 3 | 2 |

GLM 官方平均分约为 **0.700**，但这不是纯模型能力：S10、H04、H09、H10 至少四个 0 分受到基础设施或 Provider 传输问题直接影响；M10 虽 evaluator=1，也被 viewport 问题记为 `outcome_unknown`。

Qwen 与 GLM 共同完成的 5 条任务为 S01、S04、S07、M03、H01。在这个小型配对样本上，GLM 为 5/5，Qwen 为 2/5。它能支持“当前实现下优先使用 GLM”的工程选择，但样本太小，不能支持论文级的 Provider 总体优劣结论。

### 2.2 结果不是单一原因造成

| 失败簇 | 代表任务 | 已见证据 | 当前判断 |
|---|---|---|---|
| 动态 viewport 被当成致命异常 | GLM S10、M10 | 动作已经发生后，截图分别变为 1920×1079、1280×800；适配器要求始终等于 Session 初始 viewport | 基础设施合同过严，不能用这两条评价模型 |
| 后端不支持的按键未在动作前拒绝 | GLM H04 | `MENU` 通过公共字符串校验，进入 OSWorld 后端才失败，Runtime 因副作用是否发生不明而进入 `outcome_unknown` | OSWorld Adapter/Bridge 的 capability validation 缺口 |
| Provider 网络错误不可诊断 | GLM H09、H10 | 多次只记录 `fetch failed`，H09 已推进到 GIMP 文件打开阶段，H10 仅执行一步后中断 | 传输层失败，不应归因于 GUI 推理；当前错误信息不足以决定代理、超时或服务端原因 |
| 已达 evaluator 目标但未 finish | GLM M04、H08；M10 也有相邻现象 | evaluator=1，但 Run 为 `budget_exhausted` 或 `outcome_unknown` | evaluator、模型 finish、Runtime outcome 是三套事实；当前预算检查把“还能请求 finish”与“还能执行 GUI 动作”混在一起 |
| 无效果动作反复执行 | GLM M02；Qwen M03、H01；Qwen S04 也出现循环 | 相同或近似坐标点击/滚动连续重复，截图状态没有有效推进，最终耗尽预算 | 缺少通用停滞反馈；增加预算不会根治 |
| 长任务规划或精细操作不足 | GLM S08、M09、H05 | S08 接近完成；M09 仍在跨网页研究；H05 在图表编辑和错误恢复中消耗大量步骤 | 模型/Context/Planning 问题，但应在基础设施修复后再测最小机制 |
| 模型自报完成与 evaluator 不一致 | GLM H03、Qwen S04 | Runtime 正常收尾但 evaluator=0 | 先做轨迹—任务—evaluator 三方语义审计，不能直接加任务特例 Prompt |

### 2.3 现有 EventStream 能回填的效率与延迟

本次直接使用 `occurredAt` 对现有事件配对，进行了不改代码的初步回填。统计口径为：

- Runtime wall time：`run.started → run.finished`，不包含 OSWorld reset、evaluator 和 cleanup；
- Provider time：每个 `model.request.started → model.response.received/model.request.failed`；
- Computer action time：每个 `action.execution.started → action.execution.completed/failed`；
- 相邻同签名动作：忽略 `actionId` 和 `basedOn` 后，连续两个 GUI Action 的类型与参数完全相同。

| Provider | Runs | Runtime wall time | Provider time | Computer action time | Action attempts | 相邻同签名动作 |
|---|---:|---:|---:|---:|---:|---:|
| GLM | 30 | 约 2.83 小时 | 约 2.44 小时（86%） | 约 23.1 分钟（14%） | 559 | 48（8.6%） |
| Qwen | 5 | 约 10.8 分钟 | 约 4.6 分钟（43%） | 约 6.2 分钟（57%） | 159 | 132（83.0%） |

这些数字已经说明两件事：

1. GLM 当前端到端延迟主要由模型请求占用，未来 Context/图片数量、模型选择和请求策略会直接影响时延；
2. Qwen 的失败不只是“分数低”。S04、M03、H01 分别出现 36、48、48 次相邻同签名动作，绝大多数 Action 预算被循环消耗，停滞恢复是比继续增大预算更优先的问题。

但“相邻同签名”只能作为无意义步骤候选，不能直接等同于无意义。重复点击有时是合法交互，视觉无变化也可能已经产生文件或系统副作用。当前记录最缺的是能够支持设计实验的步骤归因：

- 哪一步真正推进了任务；
- 哪一步属于必要导航或信息探索；
- 哪一步在纠正前一步错误；
- 哪一步没有获得新信息、可以避免；
- 哪些步骤能够被 Planning、Context、Memory 或 Replan 机制减少。

因此，Planning、Context、Memory 的后续实验不能只比较成功率和总步数；必须先补充下面的 P0 统计设施。

## 3. 必须先修的基础设施问题

### P0-0：补一个面向设计实验的轨迹统计脚本

现有 EventStream 已经能够推导 Runtime 总时长、Provider 请求耗时、Computer Action 耗时、token、ToolCall 拒绝、Provider retry、动作类型和连续重复动作，因此不新增 Context compile、Observation、reset/evaluate/cleanup 等监控事件，也不修改公共协议。

第一版只增加一个离线脚本，读取 `trajectory.jsonl`、已有截图资产和 evaluator 结果，输出每 Run 与批次汇总。它重点回答：成功率之外，当前设计浪费了多少动作，以及后续机制有没有减少这些动作。

自动统计：

- Action attempts、completed/refused/failed/unknown；
- invalid/rejected ToolCall 和 Provider retry；
- 完全相同或近似相同 Action 的次数、连续段和最长停滞段；
- 能够从前后截图计算时，记录视觉变化量；视觉变化小只作为候选，不直接判定无效；
- Runtime/Provider/Computer 总耗时与占比、每 Run token 和每成功任务 token。

为了比较 Planning、Context、Memory、Replan，选定的困难/失败轨迹再做轻量步骤审计：`productive`（推进目标）、`exploration`（获得新信息）、`recovery`（纠错）、`redundant`（没有新信息的重复）、`off_track`（偏离目标）。人工标签绑定 `runId + actionId`，放在独立分析产物中，不进入 Runtime，也不反馈给同一轮模型。

实验主要比较：成功率、总 Action、`redundant + off_track` 比例、最长停滞段、token 和 Runtime 总时长。这样就能回答某个新设计是否以更少步骤完成任务，而不需要先建设完整性能观测系统。

验收：脚本能够回填当前 GLM 30 条和 Qwen 5 条；随机抽查重复动作与事件计数；对准备进入下一轮的困难任务完成步骤标签。该设施只分析已有事实，不改变 Agent 行为。

### P0-A：让 viewport 变化成为可表示状态，而不是动作后异常

当前 OSWorld Bridge 在 `integrations/osworld/bridge.py::_capture()` 中将初始尺寸作为永久 `expected_viewport`；`OsworldComputer.materializeCapture()` 又要求每次截图等于 `ComputerSessionDescriptor.viewport`。真实任务已经证明 viewport 会变化。

修改原则：

- 动作前仍按 `ActionIntent.basedOn` 对应的 Observation viewport 校验坐标；
- 动作后若截图尺寸改变，保留“动作已执行”的 `ActionReceipt`，不要把它改写为未知副作用；
- 新截图生成带新 viewport 的 `ObservationFrame`，旧 Observation 自然失效；
- 明确 `ComputerSessionDescriptor.viewport` 是“打开时视口”还是可更新的“当前视口”。当前消费者若仍把它当永久坐标空间，就必须一并调整，不能只删除尺寸检查。

验收任务：S10、M10；再选 S09 或 M08 作为未发生 viewport 变化的邻近回归。

### P0-B：在副作用前完成 OSWorld 按键能力校验

公共协议可以继续允许字符串键名，因为不同 Computer 后端能力不同。OSWorld Adapter/Bridge 应根据 OSWorld 实际接受的 key 集合，在调用 `DesktopEnv.step()` 前拒绝 `MENU` 等不支持键，返回明确的 `ActionReceipt.status="refused"` 和稳定错误码。

生产者：OSWorld 后端能力/允许键集合。消费者：OSWorld action mapper 或 Bridge preflight。不要把 OSWorld 私有键表写进通用 `protocol`。

验收任务：H04；同时增加一个支持按键和一个不支持按键的无模型合同测试。目标不是强行让 `MENU` 成功，而是确保它可安全拒绝、模型能够换用 `right_click` 等已提供动作。

### P0-C：补齐 Provider 网络错误的安全诊断

`FetchGlmHttpClient` 当前只保留顶层 `Error.message`，因此 Node `fetch` 的 `cause.code`、错误类型和请求阶段丢失。应记录脱敏后的错误 `name`、稳定 cause code、是否超时/取消以及重试次数；保留现有有界重试，不做无限重试。

验收任务：先用 mock 覆盖超时、连接重置和 HTTP 5xx；只有能区分原因且网络健康后，才重跑 H09、H10。若仍是外部服务不可用，将其报告为 Provider availability，而不是 GUI success=0。

### P0-D：拆开动作预算与模型请求/收尾预算

当前 `DefaultRuntimePolicy.checkBudget()` 在循环顶部只要 `stepCount >= maxSteps` 就不再请求模型，因此最后一个允许动作恰好完成目标时，模型没有机会返回 `finish`。建议把语义拆为：

- `maxActions`：限制新的 GUI 副作用；
- `maxModelRequests`：限制总模型调用；
- 动作预算耗尽后，可以在剩余模型请求预算内进行一次无 GUI 副作用的收尾 Turn；若它仍请求动作则拒绝并结束。

不要把 OSWorld evaluator 注入模型 Context，也不要让 Runtime 用 evaluator 替代在线完成判断。M04/H08 已经取得官方成功，优先用已有轨迹和单元测试验证新预算语义，不需要先付费重跑。

## 4. Monitor 的职责（开发顺序以第 7 节为准）

Monitor 是待开发的确定性提示组件；当前没有 Plan 系统，也没有独立 Replan 模块。先把 Planning 工具与 Context 消费接通，再按第 7 节安排 Monitor 的独立实验。

这一落点遵循 [意图守护技术路线](./面向视障场景的%20GUI%20Agent%20意图守护技术路线调整与系统设计.md) 与 [Memory / Advisory Subagent 演进设计](./GUI%20Agent%20多模态%20Memory%20与%20Advisory%20Subagent%20演进设计.md) 中“正常机制先保持意图、异常时按需增强、GUI 副作用保持串行”的边界。

确定性 Monitor 直接接入主循环的观察后控制点，不做成通用 Hook。它只提供事实提示，是否 Replan、更新 Plan 或调用 Advisor 由主 Agent 决定：

```text
Action executed
  → new Observation
  → ProgressMonitor 判断是否停滞
  → 若停滞，记录 progress.stalled
  → ContextCompiler 在下一轮加入一次事实反馈
  → 主 Agent 选择继续、换动作、更新 Plan 或调用 consult_advisor
```

主循环负责在固定位置调用 `ProgressMonitor`、记录信号并保证下一轮消费；具体检测算法放在独立组件中，便于比较“重复动作”“低视觉变化”或两者组合，而不把算法细节写死进 `RunController`。现在不建立泛化的 `afterObservation` Hook 系统，因为目前没有第二个需要共享相同调用合同和顺序的实现。

结合长期设计，模块在主循环中的位置应保持明确：

| 控制点 | 当前/后续模块 | 作用 |
|---|---|---|
| 构造 ModelInput 前 | Context、Planning、Working Memory、Retrieved Memory、已有 Advice | 维持目标和当前任务状态 |
| 模型提出动作后、执行前 | Tool/Runtime Policy、Approval | 校验权限；有明确语义依据时要求用户批准 |
| 动作后获得新 Observation | 确定性 `ProgressMonitor` | 报告重复动作、低画面变化等事实 |
| 主 Agent 收到信号后 | 主 Agent 调用 Planning tools 或 consult_advisor | 修改计划或请求独立建议 |
| Task/Run 边界 | 后续 Memory Writer | 从 Trajectory 提炼经验，不修改历史事实 |

因此 Monitor 现在可以直接进入主循环，不需要等待完整 Planning、Memory 或 Subagent。它不增加 RunStatus，也不自动调 AI；主 Agent 读取信号后可以调用 Advisor 工具。Advisor 使用独立上下文与受限权限，结果回到主 Agent 的 ToolResult；不会获得 GUI 执行权。

当前路线移除独立 Verifier。Memory Writer/召回、Planning tools、Advisor tool 与 Monitor 各有明确入口，不统一成一个 Hook。只有未来多个确定性检测器确实共享观察后生命周期，才组合 Monitor Pipeline。完整组织和工具数据结构只在技术计划书维护。

`ProgressMonitor` 使用最近 Observation 的可见变化和连续 Action signature。满足“同一动作或近似动作连续出现，且若干新 Observation 没有可见推进”时，给出一次结构化反馈：当前策略没有产生可见进展，请重新观察并选择不同路径。

边界：

- 它不是 Verifier，不判断任务成功或失败；
- 不自动修改 `runtimeOutcome`；
- 不自动点击、不自动完成任务；
- 不为 Thunderbird、Chrome 或某个坐标写特殊规则；
- 同一次停滞只记录和注入一次；出现不同动作或明显状态变化后重新计数。

首轮 Monitor 验证：GLM M02、Qwen M03、Qwen H01。邻近回归：GLM M03、Qwen S07。Planning、Context、Memory 和 Advisor 可依据各自失败假设继续开发，以独立开关开展对照；Monitor 无收益时关闭该实验分支，不阻塞其他假设。

## 5. 重跑矩阵

| 时间 | 任务 | 目的 |
|---|---|---|
| P0-A 后 | S10、M10、S09/M08 之一 | 验证动态 viewport 与正常尺寸回归 |
| P0-B 后 | H04 | 验证不支持按键在副作用前被拒绝并可恢复 |
| P0-C 后且网络健康 | H09、H10 | 区分 Provider availability 与模型任务能力 |
| P0-D 后 | 不先调用付费 API；离线回放 M04/H08 + Runtime 测试 | 验证最后一个动作后的 finish 机会 |
| Monitor 接入后 | GLM M02、Qwen M03、Qwen H01 + 两条邻近成功任务 | 验证事实提示是否减少重复；不单设 Replan 模块 |
| 单独语义审计后 | H03；必要时 Qwen S04 | 仅在确认是共享机制问题后重跑 |

S08 可以在预算语义明确后增加一次针对性重跑；M09 和 H05 暂不通过“只加预算”重跑，因为它们首先需要长任务规划假设。M04、H08 已经 evaluator=1，不应为了让 Runtime 标签好看而重复消耗 API。

## 6. 什么时候扩大测试集

现在即可选择困难任务、定义实验并开发增强模块，无须等待全部 P0 重跑。现有集合先用于机制实验，新增题用于补足缺少的能力维度。开始真实对照实验的条件是：

1. 本次使用的执行路径已经通过相关 P0 检查；受已知基础设施故障影响的运行单独报告，不能据此判断模块效果；
2. 本次配对实验的运行配置、Prompt、Provider Adapter、任务预算冻结；
3. 当前失败集成为开发/回归集，不再用于宣称无偏总体准确率；
4. 新增任务在运行前冻结，且 GLM/Qwen 使用同一配对任务。

后续区分两类集合：

- **功能开发/诊断集**：以 8–12 条困难题为主，优先包含长轨迹、跨应用、文件副作用、容易停滞和需要恢复的任务；同时保留 2–4 条简单成功任务作为回归哨兵。这一集合用于放大 Planning、Context、Memory 是否减少可避免步骤、降低 token 和延迟的差异。
- **最终 holdout**：新增 15–30 条未参与调试的任务，仍按应用、动作类型、轨迹长度、跨应用与文件副作用分层，不能只选困难题。它用于报告总体成功率，避免把“只在困难题上调出来”的结果当作整体能力。

因此，用户提出的“后续多选择困难题”适合功能实验路线，尤其适合 Planning/Context/Memory；但正式模型对比仍需同一配对任务和分层 holdout。若只做工程选型，可让 Qwen 再跑预先冻结的困难为主配对集；若要形成论文结论，则需要更大的配对样本、重复运行或置信区间，当前 30/5 不够。

## 7. Next gate：从当前代码到增强模块效果评测的完整路线

本节替代此前“先单独实现 Replan，再决定能否开发 Plan”的顺序。系统不建设独立 Replan 模块、工具或状态；Plan 实现后，主 Agent 可以通过 TaskUpdate 修改计划。没有 Plan 时，更换动作只是正常模型决策。

### 7.1 当前实际基础（本次代码核对）

| 模块 | 已实现 | 尚未实现/接入缺口 |
|---|---|---|
| Runtime | ModelTurn 循环、Inbox、非 Computer 工具执行、预算、审批等待、Action 事件 | 无 Plan/Advisor/Monitor 服务 |
| Tools / CLI | ToolRegistry 支持 planning/control/side；CLI 只调用 createDefaultComputerTools | 类别不等于功能；没有 TaskCreate/Update/List/Get 注册 |
| Context | 独立 packages/context；投影历史模型和工具消息、用户纠正，最后附最新截图 | 没有 Plan 注入、Memory 召回、Advisor、历史窗口/compact 策略 |
| Planning / Memory / Advisory | 技术计划书中有设计 | packages 中没有对应实现或 Store |
| Provider | GLM native tools、Qwen strict-json | 新工具 schema 与调用回传仍需补适配测试 |
| 统计 | 事件、summary 中有 steps/requests/token/错误 | 没有统一的步骤效率分析脚本 |
| 实验入口 | OSWorld run-task.mjs 传模型、预算、Qwen 模式到 CLI | 没有增强组合的开关、透传和配置留档 |
| Policy | allow/deny/require_approval 合同与执行路径 | 默认策略 allow，不具备通用坐标动作风险识别 |

代码依据：packages/runtime/src/contracts.ts、run-controller.ts、defaults.ts；packages/context/src/index.ts；apps/cli/src/index.ts；packages/provider-qwen/src/index.ts::qwen38ResponseFormat；scripts/stage5-osworld/run-task.mjs。这里只读审查，未把文档中的接口草案当成已实现代码，也未重跑历史测试。

Qwen 的具体风险：qwen38ResponseFormat 将工具参数按字段名合并，先出现的定义获胜；Planning 的 status 与 terminate 的 success/failure 可能碰撞。这是 Provider adapter 的接入任务，不应通过修改公共 Planning 状态名称绕开。默认实验先以 GLM 进行，新工具完成 Qwen 表达与解析验证后再加入其对照；不等待 Qwen 完整追平才开发其他模块。

### 7.2 立即并行的两条开发线

先记录当前代码/实验产物的基线，保留用户未提交修改。并行实施使用独立 worktree；开工前根据相关已提交内容建立共同起点，不能假设不同 worktree 自动包含当前未提交变更。

| 工作线 | 现在做什么 | 负责文件 | 交付 |
|---|---|---|---|
| A：基础设施与实验准备 | P0-A/B/C/D；离线统计脚本；整理旧任务的步骤问题；预选新增困难题 | computer-osworld、integrations/osworld、provider-glm 网络路径、runtime/defaults 的预算逻辑；scripts/stage5-osworld | 可用执行基线、定向回归、可复用统计和任务清单 |
| B：Planning 与 Context | 新建 planning 包、PlanStore 与工具；在 Context 中消费 Plan；新增非 GUI 工具合同/Provider schema 测试 | packages/planning、packages/context、provider-qwen 新工具表达路径 | 可注入、可关闭的 Planning 完整链路，先用 mock 验证 |

共享文件指定集成负责人统一修改：apps/cli、Runtime 合同/控制器、protocol/trajectory、workspace 构建引用和 lockfile。A/B 提交依赖与配置需要，由集成负责人按顺序合入；不要双方各自改一版公共合同再碰运气合并。

在 A 修复期间，B 可以完成工具、存储、Context 和 mock 测试。真实 OSWorld 运行由一个负责人排队执行；一台 VM 不能同时被两个 Agent reset/操作。并行开发不意味着并行控制同一桌面。

### 7.3 第一交汇点：接通 Planning，开始第一轮增强实验

接通顺序：

1. TaskCreate/Update/List/Get → PlanStore：程序生成 ID，保存模型声明的状态，返回已保存的 ToolResult。
2. ContextCompiler 注入 PlanStore 的只读视图：每轮能看到最新计划，用户纠正仍优先。
3. CLI 组合层注册工具、实例化 Store 和 Compiler；runner 传递增强配置，结果记录实际启用项。
4. 校验非 GUI 工具不增加 GUI step，消耗的模型请求仍计入总预算；保持原有 ToolCall/ToolResult 配对。
5. 用 GLM 完成一条小规模真实闭环，证明工具被调用、Plan 更新确实进入下一轮，而非仅仅注册成功。

B 完成上述接入、A 对本轮执行路径的相关修复回归通过后，就开始真实效果实验。无需重跑全部 30 条、无需先造 Monitor。H09/H10 的外部网络问题也不阻塞可运行任务的 Planning 实验。

第一组建议固定 H02、H05、H07、H08 四条长任务和 S07、M05 两条简单回归任务；任务清单在运行前再次确认环境可用性。长任务既有失败也有成功，能同时观察完成率与返工/遗漏。M09 依赖外部网站，H03 仍有语义评分疑点，先作为候补而非首轮必选。

在同版基础设施上比较 baseline 与 baseline + Planning/Plan Context。原始 30 条只作历史诊断；相关修复可能改变预算/执行语义，当前选中任务需要新的 baseline，但不是全量重跑。GUI action 上限一致，模型请求预算应允许计划工具调用且两组一致，记录全部请求/token，避免用额外预算冒充设计收益。

这轮研究的是“外部 Plan + 注入 Context”作为整体的效果，不宣称已拆开两者因果。若效果值得继续细分，再比较不同计划呈现方式。

### 7.4 第二轮：Context 策略与确定性 Monitor 分别实验

Planning 链路接通后，可以并行开发：

- Context 策略：近期历史选择、关键截图/错误保留、Plan 摘要；先做一个策略，不同时开启全部 compact/memory。
- Monitor：脚本判断重复动作和可见变化，在固定观察后位置产生事实提示，由 Context 消费。它不调用模型、不更新 Plan、不自动启动 Advisor。

主 Agent 看到 Monitor 信号后自行决定换动作或调用 TaskUpdate。这是正常工具循环，不是单独 Replan 产品能力。

按开关做独立对照：固定一套 base（可为 baseline 或含 Planning 的版本，必须明确），分别测 base + Context、base + Monitor，再决定是否组合。Context 用第一轮长任务；Monitor 用 GLM M02 与 Qwen M03/H01 的重复簇，并保留成功回归。Qwen 只在所选配置的工具合同已通过时运行。

### 7.5 何时增加题目：第一轮之后，Memory 实验之前

现在就可以预选和无模型预检新增困难题，与 A/B 开发并行，不必等待第一轮效果。但无需立即调用模型扩大规模。

第一轮 Planning 实验后，把开发集扩为约 8–12 条困难/长任务，加 2–4 条简单回归题；增加缺失场景。题目要体现多目标、跨应用、信息复用、错误恢复；纯粹难点点击或不可用网站不一定能检验 Plan/Memory。

跨 Run Memory 实验开始前，必须另外冻结“经验来源任务”和“相似但不同的目标任务”，至少覆盖数个应用或任务流程。旧轨迹可用作开发期经验；不得把同一目标任务的答案/成功轨迹放入召回库后宣称泛化提升。

最终 holdout 可现在登记并留出，但不查看其运行失败来调 Prompt。待组合方案固定后再执行正式评测。

### 7.6 第三轮：Memory 召回与工具型 Advisor 可并行实现

这两者依赖已经稳定的 Context/工具组合接口，互相不依赖：

- Memory 线：先做有限文本经验与来源引用、独立 Store、召回到 Context；在冻结的新目标任务上比较 memory-off/on。Working Memory 已属于此前 Context 工作，不重复建库。
- Advisor 线：consult_advisor 工具、独立 ModelInput、受限只读权限、父取消传播与子预算；先同步等待工具结果，返回主 Agent 的历史工具消息。子模型调用成本纳入报告。

Memory 侧不改工具执行；Advisor 侧不改 GUI adapter。共享 Context/CLI 的集成仍由一个负责人处理。可以同时开发，效果实验按单个变量顺序运行；Planner/Memory 无收益不阻止 Advisor 实验。

Advisor 是否被调用、建议是否被主 Agent 采用要在轨迹中可查；主 Agent 从未调用时只能说调用策略未激活，不能据此否定辅助推理能力。未来需要后台子任务时再设计队列和结果失效机制。

### 7.7 组合与最终评测

各项都有至少一次可解释的独立实验后，选择有用组合；无收益模块可关闭。比较成功率以及成功任务的动作数、重复/可避免步骤、token、总时长；提前失败导致动作更少不算进步。首轮是开发证据，有波动再补重复或配对任务，不把某次提升直接写成论文结论。

最后冻结 Provider、Prompt、预算、模块组合、Memory 库，再运行新的分层 holdout。意图守护/Accessible Approval 的诱导与授权场景另补专项评测，当前 OSWorld 完成率不足以证明这部分产品效果。

推进顺序明确为：A/B 并行 → Planning 接通并评测 → Context/Monitor 分别评测 → Memory/Advisor 并行开发、分别评测 → 组合与 holdout。不存在独立 Replan 阶段，也不存在“全部 P0 任务成功才允许开始进阶开发”的总闸门。

## 8. 审计边界

本次独立读取了当前结果文档、任务候选文档、Runtime 预算逻辑、OSWorld Computer/Bridge 的 viewport 与动作校验路径、GLM 网络错误路径，并核对主要运行目录存在。另从当前 35 条选定轨迹回填了现有事件能够支持的 Runtime/Provider/Action 时间及相邻同签名动作统计；这些是事件级事实，不是语义级无效步骤真值。未启动 VM，未调用模型 API，未修改代码或原始运行产物；H03 的根因仍标为待专门审计。

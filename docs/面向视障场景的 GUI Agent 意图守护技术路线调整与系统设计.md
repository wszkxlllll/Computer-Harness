# 面向视障场景的 GUI Agent 意图守护技术路线调整与系统设计

> 2026-09-15 统一说明：本文解释产品与研究目标；当前实施入口为 [Stage 6 起始状态](./stage-6-convergence-and-start-state-2026-09-15.md)。当前路线为主 Agent 调用 Planning 工具、Memory 召回到 Context、Runtime Policy 执行许可与审批；不加入独立 Verifier。Guard、Advisory 和更复杂语义识别属于后续设计，不代表基础设施已经能判断任意坐标点击的风险。

## 一、技术路线调整背景

本项目最初围绕视障用户使用 GUI Agent 时缺乏持续视觉监督这一问题展开，计划通过候选动作级风险样本构建、页面上下文抽取、动作级风险评估模型、执行前后检查以及语音确认等机制，对 GUI Agent 的潜在危险操作进行识别和干预。

随着 Computer Use Agent 和 Agent Harness 技术的发展，项目对这一问题的认识也进一步发生变化。GUI Agent 在实际运行中的风险并不完全表现为某一个孤立动作是否“危险”，而往往来源于长程任务中的目标偏移、上下文遗失、页面诱导、无关推荐、异常跳转、工具副作用、历史错误累积以及模型对当前任务阶段的错误理解。例如，用户最初仅要求查询账单，但 Agent 在多轮操作后可能逐渐偏离目标并尝试订阅额外服务；又或者页面中出现推荐、默认勾选项和权限请求，Agent 因缺乏对原始目标和当前任务阶段的持续关注而执行无关操作。

因此，如果仍采用“主 Agent 生成动作—独立风险模型逐步审核—执行后再次检查”的固定流水线，虽然能够提供一定保护，但会引入额外模型调用、显著增加端到端延迟和推理成本，同时容易将安全问题过度简化为单步分类问题。

基于此，本项目拟将研究重点从“为每个动作额外挂载专用风险检测模型”调整为“通过 GUI Agent Harness 的上下文管理、任务状态、记忆、工具权限、运行时策略和按需协同推理，提高 Agent 对用户意图的持续保持能力，并在真正具有副作用或异常性的操作前进行分级干预”。

项目的研究主题保持不变，即仍然面向视障用户难以持续观察 GUI Agent 执行过程的问题，研究如何减少 Agent 偏离用户真实意图以及执行高风险操作的可能性。变化主要发生在实现路径和系统架构上。

## 二、总体技术思路

调整后的系统不再默认将安全能力实现为独立于 Agent Harness 的外部风险检测流水线，而是尽可能将“意图保持”和“风险控制”融入 GUI Agent 的正常运行机制。

系统首先通过 Context、Planning 和 Memory 等机制，使主 Agent 在长时间任务执行过程中持续获得与用户目标相关的信息，从源头减少无关动作和目标偏移。对于具有明确外部副作用的操作，则由 Runtime Policy、Tool 权限和 Approval 等确定性机制建立执行边界。对于复杂、异常或存在较大不确定性的状态，可以进一步按需启动 Advisory Subagent，从规划、视觉理解、风险或失败恢复等角度为主 Agent 提供额外建议，而不是在每一个动作前都调用第二个模型。

整体技术逻辑可以概括为：

```text
Context / Planning / Memory
        ↓
帮助 Main Agent 持续保持用户意图
        ↓
Advisory Subagent
        ↓
仅在复杂、异常或高风险场景增强推理
        ↓
Tool / Runtime Policy
        ↓
限制真正具有副作用的操作
        ↓
Accessible Approval
        ↓
仅在必要情况下请求视障用户确认
```

这一设计的重点从“Agent 犯错以后再检测错误”逐渐转向“通过 Harness 设计降低 Agent 犯错概率，并仅对无法通过普通运行机制解决的高风险情况升级干预”。

## 三、Context 作为意图保持的核心机制

GUI Agent 的长程执行高度依赖 Context。如果模型每轮主要看到当前截图，而原始用户目标、当前子任务和近期执行状态在上下文中逐渐弱化，Agent 很容易受到页面局部内容的影响，产生与用户真实意图无关的行为。

因此，本项目将 Context Management 作为新的重点研究方向之一。

ContextCompiler 不再只是简单拼接当前 Screenshot 和历史消息，而需要根据当前 Run 状态动态决定模型真正需要看到的信息，例如原始用户目标、当前 Observation、当前 PlanningTask、近期关键动作、结构化错误以及重要的历史状态。

对于视障辅助场景，这一机制具有额外意义。普通用户可以通过持续观察屏幕发现 Agent 正在偏离目标，而视障用户无法承担这一持续监督职责。因此，Harness 本身需要承担更强的“意图锚定”责任。

后续可以系统比较不同 Context 策略，例如仅提供当前 Observation、加入原始用户目标、加入当前 PlanningTask、加入近期关键历史或者加入压缩后的长期状态摘要，从而研究哪些信息最有助于减少无关推荐、误导页面和长程任务中的目标偏移。

因此，原方案中的“候选动作中心化上下文抽取”可以进一步升级为“面向 Agent 意图保持和风险控制的动态 Context 构建”。

## 四、Planning 作为长程任务中的 Intent Anchor

Planning Tool 在本项目中不仅用于提高复杂 GUI 任务的完成率，还可以承担长程意图保持的功能。

用户给出的目标通常是高层级的，例如“购买明天去杭州的火车票”。主 Agent 在执行过程中可能将其拆分为查询车次、选择车次、填写乘客信息和支付等多个子任务。如果当前系统能够明确保存“当前正在进行的子任务”，那么模型在面对页面中的会员推荐、保险推荐或广告跳转时，就更容易判断这些操作是否属于当前任务。

因此，Planning State 可以成为原始用户目标与当前 GUI Action 之间的一层结构化语义约束。

例如，当当前 PlanningTask 为“选择车次”时，Agent 提出“开通会员”这一 ActionIntent，系统可以更容易发现该行为与当前任务阶段缺乏直接关系。

不过，Planning 并不被强制绑定到所有任务。短任务可能并不需要显式 Task 管理，后续需要通过评测验证 Planning 在何种任务长度和复杂度下真正具有收益。

## 五、Memory 用于长期经验和风险模式复用

对于较长任务以及跨 Session 的 Agent，单纯依赖当前 Context 难以长期保存所有有价值的信息。因此，项目后续可以进一步引入多模态 Memory。

Memory 的作用不是简单保存完整聊天记录，而是从过去 GUI Trajectory 中提取可复用经验。例如，系统可以记住某类订票页面经常出现额外保险推荐、某些设置页面容易通过广告区域发生错误跳转，或者某类任务过去曾出现多次相似失败。

这些经验可以以文字摘要、关键视觉 Frame、局部 ROI 或结构化 Episode 的形式保存。当未来出现相似 Task 和 Observation 时，Retriever 从历史 Memory 中选择最相关经验，并由 ContextCompiler 注入当前模型输入。

因此，Memory 可以承担一种“风险经验复用”的作用，使 Agent 不需要在每一次任务中重新遭遇相同错误后才学习如何处理。

后续研究可以比较无 Memory、纯文本 Memory、视觉 Memory 以及多模态 Episodic Memory 等不同策略对任务成功率、目标偏移率、重复错误率和推理成本的影响。

## 六、Tool 与 Runtime Policy 作为确定性执行边界

虽然 Context、Planning 和 Memory 可以显著降低模型产生错误 Action 的概率，但这些能力本质上仍然属于模型推理层，不能完全替代确定性的运行时约束。

对于支付、购买、订阅、发送消息、删除数据、上传敏感信息、权限授权等真正具有外部副作用的操作，系统仍需要通过 Tool Policy 和 Runtime Policy 建立明确的执行边界。

对于发送、支付、删除等具备明确语义的 Tool，Runtime 可以根据工具定义执行确定性审批规则。但通用 click/type Action 仅提供坐标或文本，程序不能仅凭它知道界面背后的支付、订阅或权限含义。这部分需要应用语义证据或后续按需推理；不能因为审批接口已经存在就宣称通用 GUI 风险识别已经实现。

在具备上述可信语义依据时，允许操作直接执行，需要授权的操作进入 Runtime 的 waiting_approval，禁止操作明确拒绝。审批由用户或受信授权端解决；主 Agent 或 Advisor 的建议不构成用户批准。当前默认 Policy 放行工具，专门许可规则需要另行实现。

因此，调整后的技术路线并不是取消安全控制，而是将其中可以确定性解决的部分从模型判断中剥离出来，由 Runtime 承担。

这种机制可以减少额外模型调用，同时避免将支付、删除、发送等重要操作完全依赖于语言模型的概率性判断。

## 七、Advisory Subagent 作为按需增强机制

对于无法通过简单规则确定、但又具有较大不确定性的情况，可以使用 Advisory Subagent 进行按需分析。

与让多个 Agent 同时操作同一桌面的 Execution Subagent 不同，Advisory Subagent 不直接获得 ComputerSession 的 GUI 执行权，而只读取经过授权的 Task、Observation、Planning State、Trajectory 或 Memory，并返回结构化建议。

例如，当主 Agent 连续操作失败时，可以启动 Recovery Advisor 分析最近的执行轨迹；当页面结构复杂时，可以启动 Visual Analyst 对当前界面进行独立分析；当某个候选动作可能与用户原始目标冲突时，也可以启动 Intent/Risk Advisor 判断该动作是否合理。

其核心原则是：

**推理可以并行，真实 GUI 副作用保持串行。**

主 Agent 仍然是唯一的 Action 决策和 Computer 执行主体，Subagent 只负责提供额外分析。

相比“每个 Action 固定调用 Risk Model”，这种机制能够将额外模型成本集中在真正复杂或高风险的场景中，更符合低延迟和低打扰的设计目标。

## 八、从固定前后检查调整为事件驱动检查

原方案中的“执行前检查”和“执行后检查”不再作为每一步必须执行的固定模块。

对于普通 click、scroll、文本输入和页面导航，如果 Harness 已经具有可靠的 Context 和 Runtime validation，没有必要再次调用额外模型。

系统可以采用事件驱动方式，仅在特定条件下增加额外检查。例如：

- 即将执行具有明显外部副作用的操作；
- Action 的执行结果为 `outcome_unknown`；
- 连续多次操作失败；
- 页面发生异常跳转或显著状态变化；
- 当前行为明显偏离 Planning State；
- Runtime 或 Main Agent 自身报告较高不确定性。

这些条件是未来研究候选，不都能通过脚本可靠识别。当前只实现重复动作、低画面变化、明确工具错误等确定性 Monitor 信号，交由主 Agent 判断是否更新 Plan 或调用 Advisor。异常跳转和意图偏移不伪装成已具备的确定性能力；未来若要自动触发模型，必须作为独立策略实验。

因此，“Pre/Post Verification”可以从默认执行流程降级为按需触发的增强能力。

## 九、专用 Risk Model 的角色调整

原项目计划训练动作级风险评估模型。调整后，专用 Risk Model 不再作为系统核心链路的必要组成部分，而可以保留为可选实验方案。

项目可以在统一评测集上比较：

```text
Baseline Harness

Baseline
+ Improved Context

Baseline
+ Planning

Baseline
+ Memory

Baseline
+ Advisory Subagent

Baseline
+ Dedicated Risk Model
```

如果专用 Risk Model 能在可接受延迟下显著提高风险识别能力，则可以作为一种增强方案；如果 Context、Planning、Tool Policy 或 Advisory Subagent 已经获得更好的总体效果，则没有必要为了保持原计划而强行保留额外风险模型。

这种调整使“是否需要专用风险模型”本身成为一个可以通过实验回答的问题，而不是预先确定的技术结论。

## 十、语音确认作为 Accessible Approval，而非核心风险模型输出

语音确认仍然是视障应用场景中的重要组成部分，但其系统定位需要调整。

语音模块本身并不负责决定风险，而是作为 Runtime Approval 的无障碍交互前端。当 RuntimePolicy 或 Advisory Agent 判断某个操作确实需要用户参与时，系统再生成简洁、可理解的语音说明。

例如，系统不应在每一个普通点击前询问用户，而只在关键情况下提示：

“Agent 正准备开启每月 29 元的自动续费服务。你的原始任务只是查询套餐使用情况，该操作不是完成当前任务所必需的。是否继续？”

用户可以通过语音继续、拒绝或打断当前 Run。

因此，项目原来提出的“可理解、可打断、低打扰”目标仍然保留，但实现机制从固定动作确认升级为风险和副作用触发的 Accessible Approval。

## 十一、Trajectory 在数据构建和系统评测中的作用

现有 Harness 中的 RuntimeEvent 和 Trajectory 可以成为后续研究的重要数据基础。

系统已经能够结构化记录用户目标、ObservationFrame、ModelTurn、ActionIntent、ActionReceipt、Planning 更新以及用户干预等信息，因此不需要额外构建一套独立的 GUI 行为记录系统。

未来可以直接从真实 Run 中抽取：

```text
User Goal
+
Observation
+
Planning State
+
Proposed Action
+
Action Result
+
Next Observation
+
Human Annotation
```

形成动作级或 Episode 级研究数据。

这些数据既可以用于分析 Agent 为什么发生目标偏移，也可以用于 Memory 构建、Context 实验、Subagent 调用策略研究，甚至在确有必要时用于训练专用分类模型。

因此，原项目中的“动作级风险样本构建”仍然具有价值，但数据定义可以从简单的“截图—动作—风险标签”升级为基于完整 Agent Runtime Trajectory 的多模态行为样本。

## 十二、调整后的研究重点

综合上述调整，本项目后续不再将重点放在“训练一个独立 Risk Model 对所有 GUI Action 做固定前后检查”，而是研究 GUI Agent Harness 如何通过更好的运行时设计降低视障用户缺乏持续监督所带来的风险。

主要研究方向可以归纳为以下几个方面。

首先，研究 Context Management 如何影响 Agent 在复杂 GUI 环境中的目标一致性，包括视觉历史选择、当前任务状态和上下文压缩等问题。

其次，研究 Planning State 是否能够作为长任务中的 Intent Anchor，减少 Agent 受到页面局部推荐和无关信息影响。

第三，研究多模态 Episodic Memory 是否可以帮助 Agent 利用过去 GUI 任务中的成功经验和失败模式。

第四，研究 Advisory Subagent 是否能够在复杂或异常情况下提供有效辅助，以及其带来的成功率收益是否能够抵消额外推理延迟和成本。

第五，研究 Tool Policy、Runtime Policy 和 Approval 如何在不频繁打扰用户的情况下建立可靠的副作用执行边界。

最后，研究适合视障用户的 Accessible Approval 机制，使系统在真正需要用户介入时能够提供简洁、可理解且可打断的语音说明。

## 十三、总体研究问题

经过技术路线调整后，本项目的核心研究问题可以进一步概括为：

**在用户无法持续视觉监督的场景下，GUI Agent Harness 如何通过上下文管理、外部任务状态、历史经验、工具权限和按需协同推理，使 Agent 在长程 GUI 任务中持续保持与用户意图一致，并仅在必要情况下请求用户介入？**

这一研究问题仍然延续项目最初的视障辅助和 GUI Agent 意图守护主题，但技术路线从单一动作风险分类扩展到了完整 Agent Runtime 与 Harness 设计。

最终系统希望形成一种低延迟、低打扰的运行模式：Context、Planning 和 Memory 首先帮助 Agent 尽量避免错误；Advisory Subagent 仅在复杂状态下提供额外推理；Tool 和 Runtime Policy 对真正具有外部副作用的行为建立确定性边界；语音交互则只在必要情况下承担用户确认和控制功能。

因此，项目的重点将从“为 GUI Agent 增加一个安全检查器”进一步发展为“研究面向低监督用户的风险感知 GUI Agent Harness”。

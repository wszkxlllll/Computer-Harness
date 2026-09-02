# GUI Agent 多模态 Memory 与 Advisory Subagent 演进设计

## 一、设计背景

现有 GUI Agent 的上下文管理大多仍沿用文本 Agent 的基本思路，即将用户目标、历史模型回复、工具调用结果和当前截图组合为消息序列，并在上下文长度增长后通过截断或文本摘要控制输入规模。这种方式能够支持短流程任务，但对于长时间运行的 Computer Use Agent 存在明显局限。

GUI Agent 的历史并不只是自然语言消息，而是由连续 Observation、视觉界面变化、GUI Action、窗口状态、任务进度以及模型推理共同构成。连续 Screenshot 往往包含大量重复视觉信息，而仅将历史压缩为文字，又可能丢失按钮位置、页面结构、弹窗形态和局部视觉特征等对未来操作仍然有价值的信息。因此，GUI Agent 的 Memory 与 Context Management 不宜完全复用传统文本 Agent 的“完整消息历史 + Session Summary”模式，而应进一步利用自身天然存在的多模态 Trajectory。

本项目后续计划在现有 `ObservationFrame`、`RuntimeEvent`、`PlanningTask` 与 `ContextCompiler` 基础上，逐步构建面向 GUI Agent 的多层 Memory System。其核心原则是将 **完整运行事实、长期可复用经验、当前工作状态以及模型当前实际可见的 Context** 分别管理，而不是将所有信息不断累积进一个不断增长的 `messages[]`。

## 二、整体 Memory 架构

GUI Agent 的 Memory 计划划分为 Working Memory、Episodic Memory 和 Semantic Memory 三个层次。

Working Memory 服务于当前 Run，表示 Agent 现阶段完成任务直接需要的信息。其内容主要包括当前 Observation、少量近期关键 Observation、最近执行的 Action、当前 PlanningTask、近期错误以及必要的页面状态摘要。Working Memory 生命周期主要与当前 Run 一致，并直接参与 `ContextCompiler` 的每一轮输入构造。

Episodic Memory 用于保存过去真实 GUI 任务中具有复用价值的操作经验。它并不等同于完整 Trajectory 的永久副本，而是从成功或具有代表性的历史 Run 中提取任务描述、关键操作阶段、关键视觉证据、失败与恢复经验以及最终结果，从而形成可以被未来任务检索的 GUI Episode。Episodic Memory 的目标是回答“过去是否执行过类似任务，以及当时是如何完成的”。

Semantic Memory 则进一步从多个 Episode 中抽取较稳定的应用知识和操作规律。例如，在多次操作 GitHub 后，可以形成“仓库规则通常位于 Settings 下的相关区域”这样的稳定经验；在多次操作某个办公软件后，也可以积累相对稳定的快捷键、菜单结构和工作流程。相比 Episodic Memory，Semantic Memory 更接近传统 Agent 中的长期文本记忆，因此主要采用结构化文本形式即可。

三类 Memory 之间并不是简单替代关系。Working Memory 保证 Agent 当前能够继续执行；Episodic Memory 保存过去发生过的具体经验；Semantic Memory保存从多个经验中抽象得到的稳定知识。它们最终都只是 `ContextCompiler` 可以选择使用的信息源，而不会直接成为 Runtime 的权威执行状态。

## 三、Trajectory、Memory 与 Context 的边界

现有 Harness 中的 RuntimeEvent 和 Trajectory 继续作为系统的权威历史事实。一次 Run 中产生的 Observation、ModelTurn、ActionIntent、ActionReceipt、Task 更新以及错误都会完整保存在 Trajectory 中。Trajectory 的目标是忠实回答“系统当时实际发生了什么”，因此原则上不因为 Context 压缩、Memory 总结或模型重新解释而修改历史事实。

Memory 是建立在 Trajectory 之上的二次加工结果。Memory Writer 可以在 Run 结束、Task 阶段结束或者达到特定条件时，从历史 RuntimeEvent 中提取具有未来复用价值的信息，并将其转化为 Episode 或 Semantic Knowledge。Memory 允许总结和压缩，因此本质上属于可派生状态，而不是事实源。

Context 则是每一轮 ModelTurn 真正发送给模型的信息集合。ContextCompiler 根据当前任务、最新 Observation、Working Memory、检索到的历史 Memory、Planning State 和 Runtime Policy，动态决定模型本轮应该看到哪些内容。Context 可以很小，也可以随任务动态变化，但其裁剪不影响 Trajectory 的完整性。

因此三者的关系可以概括为：**Trajectory 保存事实，Memory 保存经验，Context 保存当前模型真正需要看到的信息。**

这种分层可以避免文本 Agent 中常见的一个问题，即运行历史、长期记忆和当前 Prompt 混合在同一消息序列中，最终导致状态来源不清晰，同时也便于后续独立研究不同 Memory 和 Context 策略对 GUI Agent 成功率、成本与延迟的影响。

## 四、GUI Episodic Memory 的数据形态

Episodic Memory 的基本单位可以定义为一次具有独立任务语义的 GUI Episode。一个 Episode 不需要保存整个 Run 的全部 Screenshot，而是记录用户目标或子目标、涉及的应用环境、主要操作过程、最终 Outcome、关键视觉 Frame、重要局部区域以及文字摘要。

例如，一个“在 GitHub 中配置仓库规则”的成功 Episode，可以保存任务摘要、进入 Settings 的路径、操作中出现的关键页面、重要按钮的视觉区域以及最终保存成功的历史 Observation。下一次 Agent 再次处理类似任务时，Retriever 可以首先根据当前任务文本和 GUI 状态查找相似 Episode，然后只将最有价值的经验和视觉证据注入新的 Context。

需要强调的是，Episodic Memory 不应把历史绝对坐标当作可复用知识。例如过去某个按钮位于 `(1210, 822)`，这一坐标可能由于窗口大小、DPI、页面版本甚至内容变化而完全失效。因此，长期 Memory 更适合保存“Save changes 按钮及其周边视觉特征”“Rules 位于 Settings 页面某一区域”等相对稳定信息，而当前具体坐标仍应由最新 Observation 中重新 Grounding。

## 五、多模态检索与视觉 RAG

传统 RAG 主要围绕文本 Embedding 建立，而 GUI Agent 的历史天然包含大量视觉信息，因此后续可以构建多模态 Retrieval 机制。

对于每个 Episodic Memory，可以分别生成文字语义表示和视觉表示。文字部分主要编码任务目标、阶段摘要、历史失败原因和操作过程；视觉部分则可以编码完整关键 Frame 或经过选择的 Region of Interest。当前任务产生检索请求时，可以同时使用用户目标、当前 PlanningTask、最近失败信息以及当前 Observation 构成 Query。

检索过程可以首先分别得到文本相似 Episode 和视觉相似 Episode，再经过统一排序选出少量最相关经验，也可以在未来尝试直接采用统一的多模态 Embedding 空间。相比单纯寻找“看起来相似的截图”，更重要的目标是寻找“任务阶段和视觉状态都相似的历史经验”。

例如，当 Agent 正在 GitHub Settings 页面中寻找某项规则，并且连续数次定位失败时，检索条件不应只包含当前 Screenshot，还可以加入“正在寻找仓库规则”“连续定位失败”等语义状态。这样检索出的结果更有可能是过去真正解决类似问题的 Episode，而不是视觉上相似但任务无关的页面。

## 六、ROI 级视觉记忆

由于完整 Screenshot 信息量较大、成本较高，并包含大量与当前任务无关的视觉内容，长期视觉 Memory 更适合逐步引入 Region of Interest 级别的表达。

Memory Writer 可以从关键 Observation 中提取对任务有意义的局部视觉区域，例如菜单项、重要按钮、设置面板、弹窗或错误提示，并保存该 ROI 与原始 Observation 的关联。ROI 可以同时附带文字描述、语义角色、来源任务和视觉 Embedding。

这样，当类似任务再次出现时，Agent 不需要重新查看整个历史屏幕，而可以得到“过去任务中这个按钮大致长什么样”“某个设置区域通常出现在哪里”等更聚焦的信息。

这一机制同样可以支持未来的 Context Reduction。当连续多个 Observation 几乎相同时，ContextCompiler 可以减少完整 Screenshot 的保留数量，而仅保留视觉变化显著的 Frame 或关键 ROI，从而降低多模态输入成本。

## 七、视觉信息的隐私与生命周期

GUI Screenshot 与普通文本 Memory 相比具有更高的隐私风险，因为其中可能包含邮箱、聊天内容、用户账号、Token、个人文件和其他敏感信息。因此，Visual Memory 不应默认将所有 Observation 无限期写入长期 Memory。

完整 Screenshot 可以继续作为当前 Run 的 Trajectory Asset 保存，而进入长期 Episodic Memory 的视觉内容应经过选择。长期 Memory 可以优先保存任务必要的关键 Frame 和 ROI，并在条件允许时进行敏感区域遮盖、过期清理和显式用户授权。

因此，Visual Memory 的写入本身应成为一个可配置策略，而不是 Trajectory Storage 的默认副作用。Trajectory 与 Memory Store 需要保持独立生命周期，以支持“完整轨迹用于当前调试，但长期只保留少量经过处理的经验”。

## 八、Advisory Subagent 设计

在单 Agent Runtime 稳定以后，本项目计划优先引入一种不直接操作 ComputerSession 的 Subagent 形态，即 Advisory Subagent。

GUI Agent 的 Multi-Agent 设计与 Coding Agent 存在明显差异。Coding Agent 可以通过 Worktree 或不同文件空间实现较强的执行隔离，而多个 GUI Agent 若同时控制同一 Desktop，可能因为窗口焦点、鼠标、键盘和应用状态共享而产生严重竞争。因此，早期 Subagent 不直接拥有 GUI 执行权限，而主要负责从不同角度分析当前任务，并将建议返回主 Agent。

主 Agent 仍然是唯一拥有当前 ComputerSession GUI 副作用执行权的 Agent。Subagent 只读取经过授权的 Task、Observation、Trajectory、Planning State 或 Memory，进行独立推理并返回结构化 Advice。最终是否采用建议、执行哪一个 Action，仍由主 Agent 决定。

这种设计将 Multi-Agent 的主要收益从“并行操作电脑”转化为“并行推理同一个 GUI 问题”，可以在避免 Computer Ownership 冲突的同时提升复杂任务的分析能力。

## 九、多视角 Advisory Agent

不同 Advisory Subagent 可以针对同一当前状态承担不同推理职责。

Planner Subagent 可以从任务整体角度分析当前阶段，给出下一阶段任务拆解或建议更新 PlanningTask。Visual Analyst 可以重点分析最新 Observation，识别页面结构、可交互区域和潜在下一步入口。Recovery Advisor 可以在连续 Action 失败、页面变化异常或 Runtime 出现结构化错误时，阅读近期 Trajectory 并分析失败原因。未来也可以加入 Risk Advisor、Memory Analyst 或 Application Specialist 等角色。

这些 Subagent 的输入均来自 Harness 中已有的标准对象，而不是直接访问 GUI Driver。例如 Visual Analyst 可以得到当前 ObservationFrame，Recovery Advisor 可以得到最近若干 ActionReceipt 和 Observation，而 Planner 可以看到当前任务与 PlanningTask。

Subagent 返回的结果也不直接修改 Runtime State，而统一表示为 Advice Artifact。一个 Advice 可以包含建议文字、来源角色、置信信息以及引用的 Observation 或 RuntimeEvent。ContextCompiler 在下一轮 ModelInput 中将相关 Advice 加入主 Agent Context，并明确告知主 Agent这些内容只是辅助分析而不是系统事实。

## 十、Advisory Subagent 的触发机制

Advisory Subagent 不宜在每一个 GUI Step 都自动运行，否则会显著增加 API 请求数量、运行延迟和成本。因此，更合理的方式是根据 Runtime 状态按条件触发。

例如在 Run 开始时，可以调用 Planner 对复杂任务进行一次初始分析；进入视觉结构复杂的新页面时，可以调用 Visual Analyst；连续相同 Action 或连续失败达到阈值时，可以调用 Recovery Advisor；在 Context 即将进行较大规模 Reduction 时，可以调用状态总结 Agent；高风险操作前也可以根据 Policy 决定是否请求额外分析。

这种按需调用方式使 Subagent 成为主 Agent 的“外部思考资源”，而不是每轮固定增加的推理链路。

## 十一、并行推理与串行 GUI 执行

Advisory Subagent 只读取状态、不执行 GUI Action，因此多个 Subagent 可以同时工作。例如在复杂页面出现后，可以并行启动 Planner、Visual Analyst 和 Recovery Advisor，然后将三者结果统一返回给主 Agent。

这一模式可以形成 GUI Agent Multi-Agent 的一个重要原则：**Reasoning 可以并行，GUI side effect 保持串行。**

主 Agent 保持 ComputerSession 的唯一 Active Controller 身份，因此不会发生两个 Agent 同时切换窗口、移动鼠标或输入文字造成的竞争。未来只有在 Harness 支持多个彼此隔离的 ComputerSession、虚拟机或远程环境以后，才考虑真正具有 GUI 执行权的 Execution Subagent。

## 十二、Memory 与 Advisory Subagent 的结合

Memory 与 Advisory Subagent 可以进一步组合。

当主 Agent 遇到陌生页面、复杂失败或长任务恢复场景时，可以启动一个 Experience Advisor。该 Agent 不直接操作 Computer，而是查询 Episodic Memory，阅读与当前 Task 和 Observation 相似的历史 Episode，并将过去成功或失败经验整理成简短建议。

整体过程可以表示为：当前 Task 和 Observation 首先产生 Memory Retrieval Query，从 Episodic Memory 中获取相似 GUI Trajectory，再由 Advisory Subagent 对这些经验进行二次总结，最后将 Advice 注入主 Agent Context。

相比直接将多个历史 Episode 原样发送给主模型，这种方式可以进一步控制上下文长度，也允许由专门 Subagent 从历史中提取当前真正有价值的部分。

## 十三、与 ContextCompiler 的集成

Memory 和 Advisory Subagent 最终都不直接改变 Agent Loop，而通过 `ContextCompiler` 与主模型连接。

ContextCompiler 的输入来源可以逐渐扩展为当前用户目标、最新 Observation、Working Memory、Planning State、近期 RuntimeEvent、Retrieved Episodic Memory、Semantic Memory 和 Subagent Advice。ContextCompiler 根据当前 Token/Image Budget 和任务阶段选择真正发送给模型的信息。

因此，未来对 Memory Retrieval、Visual Keyframe、Context Reduction 或 Advisory Subagent 的研究都可以在不修改核心 Observe—Think—Act Loop 的情况下进行。Harness 仍然保持一个相对稳定的 Runtime，而不同 Memory 和 Context 策略可以独立替换和消融实验。

## 十四、演进路线

上述能力不作为当前 V1 Provider 与 Computer 主链路的阻塞项。

V1 首先完成稳定的单 Agent Runtime、Provider Adapter、ComputerSession、ObservationFrame、Action、RuntimeEvent、Planning 和基础 ContextCompiler。只有在积累真实 GUI Trajectory 后，Memory 系统才有足够数据进行实验，因此后续首先适合研究 Working Memory 和 Visual Context Reduction，例如比较固定历史窗口、关键 Frame、Action Summary 和 Task-aware Context 对任务成功率和成本的影响。

在此基础上，可以进一步建设 Episodic Multimodal Memory，将真实 Trajectory 转化为可检索 GUI Episode，并开展 Text Retrieval、Visual Retrieval 和 Multimodal Retrieval 的对照实验。

随后引入 Advisory Subagent，由 Planner、Visual Analyst 和 Recovery Advisor 等只读 Agent 在特定状态下提供辅助建议。最后，在多 ComputerSession 和环境隔离机制成熟以后，再考虑具有真实 GUI 操作权限的 Execution Subagent 和 Agent Team。

## 十五、总体设计原则

本项目后续的 Memory 与 Multi-Agent 设计遵循四个核心边界。

**Trajectory 保存事实。** RuntimeEvent 与原始 Observation 用于记录实际发生过的历史，不因模型总结而被修改。

**Memory 保存经验。** Memory 是从历史事实中提炼出的可复用信息，可以被重新总结、压缩和淘汰。

**Context 保存当前需要看到的信息。** ContextCompiler 根据当前任务动态组合事实、经验和建议，不承担长期数据存储职责。

**Subagent 产生建议。** Advisory Subagent 可以读取状态并进行独立分析，但不直接成为 GUI 执行事实的来源，也不在早期抢占主 Agent 的 ComputerSession。

最终希望形成的系统关系如下：

```text
                         GUI Agent Runtime
                                │
                                ▼
                         Current Run State
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
       Working Memory     Memory Retriever   Advisory Agents
              │                 │                 │
              │          Episodic Memory         │
              │           ├─ Text                │
              │           ├─ Visual              │
              │           └─ ROI                 │
              │                 │                 │
              │          Semantic Memory         │
              │                                   │
              └─────────────────┬─────────────────┘
                                ▼
                         ContextCompiler
                                │
                                ▼
                            ModelInput
                                │
                                ▼
                            Main Agent
                                │
                                ▼
                          ActionIntent
                                │
                                ▼
                         ComputerSession


      RuntimeEvent / Observation / Action / Receipt
                         │
                         ▼
                      Trajectory
                         │
                  ┌──────┴──────┐
                  ▼             ▼
              Debug/Replay   Memory Writer
                                  │
                                  ▼
                             Memory Store
```

这一设计使 GUI Agent 的长期能力不再局限于保存 Session 文字摘要，而能够真正利用历史视觉状态和操作经验，同时又避免在早期 Multi-Agent 阶段引入多个 Agent 对同一桌面的并发控制风险。最终，Memory、Context 与 Subagent 都作为增强主 Agent 决策质量的上层机制，而 ComputerSession 和 RuntimeEvent 仍然保持确定、清晰且可追踪的核心执行语义。
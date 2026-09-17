# 全局设计文档一致性审计（2026-09-15）

日期：2026-09-15
文档角色：审计 / 整改入口
状态：整改完成记录
当前入口：[Stage 6 收敛与下一阶段起始状态](../../stage-6-convergence-and-start-state-2026-09-15.md)
基线：提交 `9465649`；以当前 protocol、Runtime、ToolRegistry、Context、Planning、Memory、Provider 和 Computer Adapter 源码为事实源
范围：全局设计文档与当前实现、实验阶段及最新产品路线的一致性；不修改业务代码

## 1. 结论

审计发现的问题已在本轮全局文档统一中完成收口。产品计划、Run/Turn 语义、Run Memory/长期演进和意图守护路线现在使用同一套当前协议与优先级；本文件保留发现与修复依据。

最小 Risk Guard 仍需独立实施计划，尤其要定义 action-level policy context。现有 `evaluateToolCall` 不含完整 Goal、Observation 或 canonical ActionIntent，不能仅靠改默认 Policy 完成语义风险判断。

## 2. 当前设计方向

### 2.1 稳定核心

项目是独立、Provider-neutral、GUI-native 的 Agent Harness，位于模型与 Computer Backend 之间。稳定主干是：

```text
Goal
  → ContextCompiler
  → ProviderAdapter
  → ModelTurn / ToolCall
  → ToolRegistry + RuntimePolicy
  → ActionIntent（仅 Computer Tool）
  → Computer Adapter
  → ActionReceipt + 新 Observation
  → RuntimeEvent / Reducer / RunSnapshot
```

关键约束继续有效：ToolRegistry 是唯一工具来源；Provider 与 Computer 正交；GUI 副作用先落 `started` Event；未知副作用不自动重试；Trajectory 是事实源；每个协议字段必须有生产者、消费者、更新和清理语义。

### 2.2 已实现、待效果验证的可插拔层

- `raw | recent` Context 与近似预算；
- 可选 Planning TaskState；
- Run 内 Fact/Entity Memory、确定性召回和 Context 投影；
- 仅限同一文本控件输入序列的 Action Batch；
- GLM/Qwen Provider；
- CUA 与 OSWorld Computer Backend；
- Approval、Abort、用户纠正、预算和检查式 Replay。

这些能力已通过工程集成，不代表已经证明净收益。当前要在冻结的 Development/Validation 任务上分别消融。

### 2.3 接下来的产品顺序

G0 继续冻结 evaluator、预算、manifest 和环境；同时可以在独立开关下开发最小 Risk Guard。Risk Guard 复用现有 `RuntimePolicy → allow | require_approval | deny` 与 Approval/Inbox，不建立第二套执行链，也不默认逐动作调用独立 Verifier。

Risk Guard 通过合同测试和受控任务后停止增加新功能，转向真实 CUA 体验：截图与 viewport、焦点/窗口、动作可靠性、session 生命周期、Abort/接管、延迟、错误诊断和部署体验。长期跨 Run Memory、Advisory Subagent、Sandbox、Execution Subagent 和专用 Risk Model 均后置。

## 3. P0：实施前必须修正文档

### 3.1 产品计划书已不再等于当前协议

`multimodal-gui-agent-harness-product-plan.md` 的定位和核心原则仍有效，但以下内容与代码冲突：

- 将 `ModelTurn` 描述为最多一个 GUI Action；当前已有受限 GUI Batch，以及最多两个 Planning/Memory 写调用前缀；
- 声明 point/window/element 三种 ActionTarget；当前公共 `ActionIntent` 只有 point 型定位，window/element 没有生产者或消费者；
- `RunOutcome`、`ObservationFrame`、`ModelTurn`、`PlanningTask` 示例与当前 protocol 字段不一致；
- Event 示例使用 `run.completed`、`run.failed`、`task.created` 等非当前事件名；当前以 `run.finished`、`planning.task.updated`、`memory.updated` 等为准；
- 只把 CUA 写成 V1 Computer，遗漏已实现的 OSWorld Adapter；同时把尚未消费的 window/Accessibility 写成既有合同；
- 推荐目录包含不存在的 `packages/providers`、`packages/tools`、`packages/computer`、`packages/policy`，却遗漏当前 `provider-glm`、`provider-qwen`、`computer-osworld` 和 `memory`；
- 把 Memory 放在未来扩展，但 Run 内 Fact/Entity Memory 已实现；
- 将关键 Frame、Action Summary 等写成 V1 默认策略，而当前只有 raw/recent event selection、当前截图和确定性 Memory 召回。

整改：将它改为“当前架构基线 + 下一产品阶段”，所有 TypeScript 结构从源码同步；未实现能力进入明确的 Future/Non-goal，不留伪协议。

### 3.2 Stage 6 的阶段边界需要吸收最新决策

原文把 Guard 完全列入“不进入本阶段”，与最新决策冲突。应改为：P/C/B/M1/M2/N 效果实验仍不混入 Guard；最小 Risk Guard 可以并行开发但单独验收；Guard 后进入功能冻结和 CUA 体验阶段。

### 3.3 风险路线含有未实现事实

`面向视障场景的 GUI Agent 意图守护技术路线调整与系统设计.md` 的“非逐步 Verifier、按风险升级、Accessible Approval”方向正确，但需要修正：

- 本条是审计时点事实：DefaultRuntimePolicy 只实现接口、预算与 Approval。其后已新增默认关闭的 action-level 分层 Risk Guard；首轮无桌面真实 Provider 协议探针已通过，真实 CUA 风险效果仍未验证；
- 当前没有在线 Monitor 向 Context 注入“重复动作、低画面变化”信号；只有离线轨迹脚本计算重复候选；
- Context、Planning、Memory 已实现但尚未证明降低意图偏移，不能写成已建立的风险能力；
- 当前 Memory 是 Run 内事实，不是跨 Session 风险经验；
- Advisory Subagent 不是 Risk Guard 的开发前置，且在功能冻结后暂不实施。

整改：把第一阶段 Risk Guard 的输入证据、`allow/confirm/deny` 语义、Batch 边界、误拦截指标和回退开关写成独立可验收方案。

## 4. P1：应在本轮一起收口

### 4.1 Run/Turn 文档仍混有 Stage 1/2 待办

`run-turn-tool-and-user-correction-semantics.md` 的生命周期和未知副作用原则正确，但正文仍说 `submitUserInput` 属于待实现，并在结尾列出已经完成的 Stage 1/2 任务。它也没有完整写出当前 Composite Turn 与受限 Batch 顺序。

整改：删除历史施工口吻，改为当前语义合同；明确“多个 ToolCall 不等于并发”，Planning/Memory 写前缀按序提交，GUI Batch 逐 primitive 校验、落 Event、执行、观察，Control 必须独占一轮。

### 4.2 Memory 文档混淆当前与未来

`GUI Agent 多模态 Memory 与 Advisory Subagent 演进设计.md` 目前把 Working/Episodic/Semantic Memory 都写成未来路线，没有准确描述已实现的 Run Memory：顶层 Fact、Entity、`sourceEventId`、状态、`relatedTaskIds`、确定性 hot/index 召回、工具写入和 `memory.updated` Event。

整改：首先写清 `Trajectory（事实）/RunSnapshot（当前投影）/Run Memory（本 Run 可继续使用的事实）/Context（本轮视图）`；再把跨 Run Episodic/Semantic/Visual Memory 和 Advisory 放入独立未来章节。不要把当前 Run Memory 叫作由 Run 结束后 Memory Writer 自动抽取的经验库。

## 5. P2：表达与导航改进

- `DOCS-INDEX.md` 应暂时把上述三份文档标为“架构原则有效、精确合同待收口”，避免实施 Agent误用；
- README 当前状态基本一致，但后续产品计划重写后应减少重复的阶段历史，只保留安装、能力边界和唯一文档入口；
- OSWorld 环境和 Qwen flat 验收文档是当前证据，不应由全局设计文档重复维护实验数字。

## 6. 推荐整改顺序与完成标准

1. 重写产品计划的当前对象、模块图、已实现/下一步/长期边界；
2. 更新 Run/Turn 当前执行语义；
3. 重构 Memory/Advisory 文档，先描述当前 Run Memory，再描述未来研究；
4. 把风险路线收敛为最小 Risk Guard 的设计入口；
5. 更新 Stage 6 和 DOCS-INDEX，随后才把设计文档交给 Risk Guard 实施 Agent。

完成标准：所有当前协议示例可在源码定位；每个“已实现”声明都有代码和测试消费者；未来能力不出现在当前模块图和必要依赖中；Stage 6、README、DOCS-INDEX 与四份全局文档只有一套阶段顺序。

## 7. 本次操作边界

本次只审查代码与文档并更新审计/导航，没有修改业务代码、调用模型 API、运行 VM 或操作真实桌面。

## 8. 整改结果

- 产品计划已改为当前架构基线，协议、模块图、双 Provider/双 Computer、Batch 和 Run Memory 均与源码一致；
- Run/Turn 文档已删除 Stage 1/2 待办口吻，并补齐 Composite Turn、受限 Batch、Approval、Abort 和多调用顺序；
- Memory 文档已拆清当前 Run Memory 与未来跨 Run Memory、Advisory、Sandbox、Execution Subagent；
- 意图守护文档已把最小 Risk Guard 设为下一功能，并将长期方向保留为后续优先级；
- DOCS-INDEX 与 Stage 6 已统一到“Risk Guard 后功能冻结，再聚焦 CUA 体验”的顺序。

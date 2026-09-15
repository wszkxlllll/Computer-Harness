# 面向视障场景的 GUI Agent 意图守护与 Risk Guard 路线

日期：2026-09-15
文档角色：产品研究方向 / 下一功能设计边界
状态：方向当前有效；最小 Risk Guard 待独立实施计划
当前入口：[Stage 6 收敛与下一阶段起始状态](./stage-6-convergence-and-start-state-2026-09-15.md)

## 一、研究问题

视障用户难以持续观察 GUI Agent 的每一步执行。风险不仅来自某个孤立点击，也来自：

- 长程任务中逐渐遗失原始目标；
- 页面推荐、默认勾选或异常跳转诱导无关操作；
- 窗口、焦点和界面状态与模型理解不一致；
- 发送、支付、删除、授权等外部副作用；
- 历史错误、重复动作和不确定执行结果累积；
- 用户无法及时发现并打断偏离。

因此，项目不再把核心方案定义为“第二个模型逐动作判断安全”，而是研究 GUI-native Harness 如何持续保持意图、在高风险边界分级干预，并提供低打扰、可理解、可打断的用户控制。

## 二、总体路线

```text
Goal + Current Observation
        + Context / Plan / Run Memory
                    ↓
               Main Agent
                    ↓
           ToolCall / ActionIntent
                    ↓
               Risk Guard
          allow / confirm / deny
                    ↓
        Runtime execution / Approval
                    ↓
       Receipt + Observation + Event
```

Context、Planning 和 Run Memory 用于减少意图遗失；Risk Guard 在真正执行前建立准入边界；Approval 是用户授权通道；Trajectory 提供事实、评测和后续数据。它们职责不同，不能互相冒充。

## 三、当前基础能力与未实现边界

### 已实现

- Goal、Observation、ModelTurn、ToolCall、ActionIntent、ActionReceipt；
- ToolRegistry、Tool category、参数和 capability 校验；
- RuntimePolicy 的 `allow | require_approval | deny` 接口；
- waiting_approval、resolveApproval、Abort、用户纠正；
- Event-first 副作用、未知结果处理和完整 Trajectory；
- 可选 Context、Planning、Run Memory 与受限 Batch。

### 尚未实现

- DefaultRuntimePolicy 当前对 ToolCall 默认全部 allow，没有语义 Risk Guard；
- 通用 click/type 没有自动识别支付、删除、发送等页面语义；
- 没有在线 Monitor 向 Context 注入重复动作或低画面变化信号；
- 没有风险标签体系、风险证据对象或 Guard 专用事件；
- 没有证明 Context/Planning/Memory 已降低意图偏移；
- 没有专用 Risk Model 或 Advisory Subagent。

离线轨迹分析脚本可以统计相邻重复动作候选，但它不是在线风险判断。

## 四、意图保持层

### Context

每轮必须保留原始 Goal 和最新 Observation，并按选定策略加入近期闭合 ToolCall/ToolResult、用户纠正、可选 Plan 和 Run Memory。当前 raw/recent 只解决历史规模和协议闭合，不自动判断意图偏移。

### Planning

PlanningTask 可以作为复杂任务的阶段 Intent Anchor，但它是模型声明的状态，不是事实真值。短任务不应强制建计划；是否降低偏移需要通过 Planning 消融实验回答。

### Run Memory

Run Memory 保存当前 Run 后续仍需要的事实、约束和对象状态。它可以避免重要信息被近期历史裁剪，但不等于跨 Session 风险经验库，也不自动证明记忆内容正确。

三者首先帮助主 Agent做出更好的决定，不能替代执行前的风险准入。

## 五、最小 Risk Guard

### 5.1 宿主位置

Risk Guard 应属于 RuntimePolicy 的可插拔策略族，而不是新的 Agent Loop。现有 `evaluateToolCall` 继续负责 ToolCall 级确定性准入；它当前只接收 ToolCall、ToolDefinition 和 RunSnapshot，并没有完整 Goal、Observation 或 canonical ActionIntent，因此不能被描述为已经足够支持语义风险判断。

最小实现需要在 canonical ActionIntent/候选 Batch 构造完成后、`action.execution.started` 之前增加 action-level policy hook。输入引用 Runtime 已维护的 Goal、最新 Observation、PlanState、MemoryState 和 Action，不创建第二套可漂移状态。

```text
RunController preflight
   → Tool exists / arguments / audience / capabilities
   → ToolCall-level policy
   → canonical ActionIntent / candidate Batch
   → action-level Risk Guard
   → allow | require_approval | deny
   → existing Approval or execution path
```

关闭 Guard 后必须恢复当前基线：不增加工具、不注入 Prompt、不增加模型请求，也不改变 Action 执行顺序。

### 5.2 输入

候选输入来自已有标准对象：

- 用户 Goal 与最新用户纠正；
- ToolCall，以及转换后的 ActionIntent 或候选 Batch；
- 当前 Observation 与 viewport；
- 当前 PlanState；
- 相关 Run Memory；
- Computer capabilities 与 Run constraints；
- 必要的近期结构化错误/Receipt。

不能加入没有生产者或更新机制的 `riskScore`、`foregroundApp` 或“动作效果”等孤立字段。

### 5.3 输出

```ts
type ToolPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "require_approval"; reason: string };
```

- allow：证据足够且无需用户介入；
- require_approval：动作可能合理，但需要用户授权；
- deny：违反明确策略、权限或用户约束。

第一版不新增第四种模糊状态。证据不足但风险较高时进入 Approval，而不是伪装成确定性拒绝。

### 5.4 首批风险类别

- destructive：删除、覆盖、不可逆修改；
- financial：支付、购买、订阅、自动续费；
- external commitment：发送、发布、提交、确认；
- privacy/account：上传敏感信息、修改账号/权限/隐私；
- intent violation：与 Goal、纠正或当前阶段明显冲突。

GUI primitive 本身通常没有业务语义。仅凭 click 坐标不能可靠判断支付或删除；第一版必须明确语义证据来源和保守回退，不能把 Approval 接口存在写成风险识别已经完成。

## 六、Risk Guard 与 Action Batch

风险边界必须终止 Batch。以下动作不得藏在开放式序列中：

- Enter/提交/确认；
- 导航到新页面或切换对象；
- 删除、发送、支付、授权；
- 操作目标或焦点可能改变；
- Guard 要求 Approval；
- 当前 Observation、viewport 或 session 失效。

当前 Batch 只允许面向同一文本控件输入的 click/type/Ctrl+A 调用形状。现有 Runtime 没有 element identity，不能证明它们语义上确属同一控件。Risk Guard 对整个 ModelTurn 预检，并在每个 primitive 执行前基于最新执行 Observation 重新应用必要的确定性检查。若任何一步被拒绝、要求审批、失败或 Abort，后缀停止。

## 七、Verification 与 Monitor 的位置

### 不采用固定逐步 Verifier

普通 click、type、scroll 不默认追加第二次 VLM 调用。ActionReceipt 只表示 Driver 执行结果，动作后 Observation 提供下一轮事实；是否完成用户目标由 Agent 与外部 evaluator分别判断。

### 可选按需检查

未来可以在以下事件后触发额外检查：

- outcome_unknown；
- 连续结构化失败；
- 受控脚本确认的停滞信号；
- 高风险动作缺少足够语义证据；
- 主 Agent主动请求 Advisor。

这些必须作为独立开关和实验变量，不能先写成当前既有能力。

## 八、Accessible Approval

语音不是风险判断器，而是 Approval 的无障碍前端。理想提示应说明：

- Agent 准备做什么；
- 为什么与当前目标相关或存在风险；
- 可能产生什么外部后果；
- 用户可以继续、拒绝或中止。

语音确认应复用同一个 requestId 和 resolveApproval，不建立第二套授权状态。低风险动作不应频繁打扰用户。

## 九、Trajectory 与评测

统一 Trajectory 可形成：

```text
Goal / correction
+ Observation
+ Plan / relevant Memory
+ proposed ToolCall / Action
+ Guard decision
+ approval result
+ ActionReceipt
+ next Observation
+ external evaluator / human label
```

Risk Guard 实验至少记录：

- 高风险召回率和漏检；
- 误拦截率；
- Approval 次数与用户打扰；
- Task Success 和 Partial Reward；
- 额外 Model Calls、Tokens 与 Latency；
- Batch 被拆分次数；
- Guard 关闭时的基线一致性；
- 未知副作用和恢复率。

不能只统计 Guard 自己输出的分类准确率，也不能用模型声明的 finish 代替官方 evaluator。

## 十、开发与验证顺序

```text
G0 evaluator / budget / manifest 冻结
        ├─ P/C/B/M1/M2/N 效果消融
        └─ 最小 Risk Guard 独立开发
                         ↓
             合同测试与受控风险任务
                         ↓
                  Risk Guard 冻结
                         ↓
                   暂停功能开发
                         ↓
             真实 CUA 体验与稳定性
```

Risk Guard 不混入既有模块的首轮消融。它先证明接口正确和基线可关闭，再单独进行风险任务对照。

## 十一、后续保留方向

以下能力仍属于项目演进空间，但不是 Risk Guard 的前置：

- 跨 Run Episodic/Semantic/Visual Memory，用于复用风险经验；
- Advisory Subagent，用于复杂视觉、恢复、规划或风险建议；
- Sandbox / ExecutionEnvironment，用于隔离 Computer、Workspace、Network 和 Credentials；
- Execution Subagent，在独立 ComputerSession 上执行委派任务；
- 专用 Risk Model，用实验决定是否值得额外延迟与成本。

最终研究问题是：

> 在用户无法持续视觉监督的场景下，GUI Agent Harness 如何通过可追踪的意图状态、运行时风险准入和低打扰 Approval，减少长程任务中的目标偏移与高风险副作用，同时保持真实任务成功率和可接受延迟？

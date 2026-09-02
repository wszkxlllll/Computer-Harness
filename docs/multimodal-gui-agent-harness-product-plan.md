# 多模态 GUI Agent Harness 产品计划书

版本：V1 架构草案  
日期：2026-08-28

## 一、项目背景与产品定位

随着多模态大模型逐渐具备视觉理解、界面定位、工具调用和复杂任务规划能力，GUI Agent 正在从简单的“截图—点击”实验形态向通用 Computer Use Agent 演进。然而，目前 GUI Agent 的开发通常与具体模型 Provider、Computer Use 接口以及应用逻辑高度耦合。开发者每接入一个新的多模态模型，往往都需要重新实现截图输入、GUI Action 解析、Computer Session 管理、上下文组织、异常处理以及运行轨迹记录等基础能力，导致不同 Agent 实现之间难以复用，也难以进行统一的模型比较、调试和运行时优化。

本项目计划设计并实现一个 **Provider-neutral、GUI-native 的多模态 Agent Harness**。项目不负责训练 GUI 基础模型，也不重新实现底层操作系统输入能力，而是位于多模态模型和 Computer Driver 之间，负责组织模型推理、GUI Observation、Action 执行、Context Management、可选 Planning 与完整运行轨迹。

V1 的底层 Computer Use 能力基于 `trycua/cua-driver` 实现，并固定经过验证的确切版本，避免上游快速更新导致运行合同漂移。首个开发基线为 `@trycua/cua-driver@0.22.2`。模型侧优先接入豆包、GLM、Qwen 等国内主流多模态模型 API，并至少使用两个 Provider 验证 Provider-neutral 的核心命题。

项目的核心目标不是开发另一个只能调用鼠标和键盘的 GUI Agent，也不依赖 OpenClaw 等完整 Agent 产品，而是建立一套可以独立运行的 GUI Agent Runtime。开发者应当能够在不修改 Agent 主执行逻辑的情况下切换多模态模型、调整 Context 组织策略，并获得统一的 Run、ComputerSession、Observation、Action、Tool 和 Trajectory 语义。

长期产品形态接近 GUI Agent 领域的 Claude Code 或 Codex：用户通过 CLI、SDK 或后续图形界面提交任务，Harness 自主管理模型调用、电脑观察、动作执行、上下文、任务进度、权限、轨迹和人工接管；底层 CUA 只是可替换的 Computer Use 基础设施，而不是产品本身。

## 二、产品边界

### 2.1 项目负责的能力

- GUI-native Agent Loop；
- 多模态 Provider 适配；
- Computer Session 生命周期；
- Observation 与 Action 的统一协议；
- GUI Action 校验、执行与结果记录；
- 多模态 Context 编译与视觉历史控制；
- Tool Registry 与工具执行；
- 可选 Planning State；
- 取消、暂停、预算和基础 Approval；
- Runtime Event、Trajectory、调试与检查式回放；
- 后续 Runtime Extension，例如 LightSpeaker、Verifier、Metrics 和 Cache。

### 2.2 项目不负责的能力

- 自研多模态基础模型；
- 重新实现 Windows、macOS、Linux 的鼠标、键盘和截图 Driver；
- 在 V1 中实现多 Agent、Agent Team 或复杂分布式调度；
- 默认对每一步额外调用 VLM 进行语义核验；
- 在不可重置的真实桌面上承诺确定性动作重放；
- 在 V1 中构建通用 Workflow DSL、复杂长期记忆或完整企业自动化平台。

## 三、核心设计思想

传统文本 Agent 往往可以把工具调用理解为相对独立的函数调用。GUI Agent 则具有持续存在的桌面环境、不断变化的视觉状态、窗口和焦点等隐式状态，以及强烈的动作—观察时序依赖。因此，`click`、`type`、`scroll` 不能只被当作无状态函数。

Harness 将 Computer Use 提升为 Runtime 的核心能力，并围绕以下七个核心协议对象构建：

1. `Run`
2. `ComputerSession`
3. `ObservationFrame`
4. `ModelTurn`
5. `ActionIntent`
6. `ActionReceipt`
7. `RuntimeEvent`

`PlanningTask` 作为 V1 自带的 Planning 扩展存在，但不是 Runtime 正确执行的必要条件。即使模型不使用 Planning Tool，GUI Runtime 仍必须能够独立运行。

### 3.1 Run

`Run` 是一次用户目标的实际执行单元，也是轨迹、预算、取消和最终结果的归属范围。

一个 Run 包含：

- 一个用户目标；
- 一个 Provider 配置；
- 一个 ComputerSession；
- 多个 ModelTurn；
- 多个 Tool Call；
- 多个 ObservationFrame；
- 多个 ActionIntent 和 ActionReceipt；
- 一条完整 RuntimeEvent 序列；
- 一个最终 RunOutcome。

V1 采用“一次 Runtime Session 对应一个 Run”的简单语义。后续需要连续对话和多个任务时，再增加能够包含多个 Run 的 `AgentSession`，避免在第一版中同时引入两套生命周期。

```ts
type RunOutcome =
  | { status: "completed"; summary: string }
  | { status: "failed"; error: RuntimeError }
  | { status: "cancelled"; reason?: string }
  | { status: "paused"; reason: string }
  | { status: "budget_exceeded"; budget: "steps" | "time" };
```

### 3.2 ComputerSession

`ComputerSession` 表示 Agent 当前实际控制的计算机操作面及其生命周期，使 Runtime 能够明确回答“当前 Run 正在控制哪一个 GUI 世界”。

它至少负责：

- Computer Backend 实例；
- Driver 能力描述；
-当前屏幕和 Viewport；
-当前有效 Observation；
-底层 Driver session 状态；
-开始、可用、关闭和异常状态。

ComputerSession 不承担 benchmark 初始化、环境重置和 evaluator。后续接入 OSWorld、CUA Sandbox 或其他可重置环境时，应在 Computer 之上增加独立的 `Environment` 层：

```text
Environment
├─ setup / reset
├─ computer
├─ evaluate
└─ close

Computer
├─ observe
├─ execute
├─ capabilities
└─ close
```

本机真实运行可以视为 `HostEnvironment + CuaDriverComputer`，但 V1 不必立即公开完整 Environment API。

### 3.3 ObservationFrame

`ObservationFrame` 表示 Harness 在某个确定时间点获得的 GUI 状态，而不是一张缺乏来源和坐标语义的 Screenshot。

每个 Observation 具有 Harness 自己生成的唯一 ID，并可以包含：

- Screenshot Asset；
- Viewport 和坐标空间；
- 目标屏幕或窗口。

```ts
type ObservationFrame = {
  id: string;
  runId: string;
  computerSessionId: string;
  createdAt: string;
  screenshot: AssetRef;
  viewport: {
    width: number;
    height: number;
    coordinateSpace: "physical" | "logical" | "reference";
  };
  window?: WindowRef;
};
```

Harness 的 `ObservationFrame.id` 与 CUA 内部 frame 引用必须分开。模型只绑定 Harness Observation，`CuaDriverComputer` 在 Adapter 私有状态中维护 `ObservationId → CuaFrameRef` 映射。Provider、ContextCompiler、Trajectory 和公共 protocol 都看不到 Driver 私有引用。Accessibility 真正进入 Context 或工具链后，再增加含义明确、可验证的协议类型。

### 3.4 ModelTurn

`ModelTurn` 是 Provider 世界与 Runtime 世界之间的关键边界对象。Provider Adapter 负责把各模型的原始响应转换为 ModelTurn；Agent Loop 只消费 ModelTurn，不读取具体 Provider 的原始响应格式。

V1 定义：

```ts
type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

type ModelTurn =
  | {
      type: "tool_calls";
      calls: ToolCall[];
      assistantText?: string;
    }
  | {
      type: "user_input_required";
      question: string;
    }
  | {
      type: "finish";
      summary: string;
    };
```

`calls` 保留数组形式，以忠实表达 Provider 的标准 Tool Call 输出，但 V1 的 Runtime Policy 限制一次 ModelTurn 最多包含一个具有 GUI 副作用的 Computer Tool Call。Planning Tool 可以与 GUI Action 使用同一 ToolCall 协议，但由 Tool Registry 路由到不同执行器。

Approval 的最终决定属于 Runtime Policy，而不是模型。模型若主动请求用户确认，应调用控制类 Tool；同时，Runtime Policy 可以在收到任意高风险 ToolCall 后独立产生 `approval.requested`，即使模型没有主动要求批准。模型不能通过不输出 `approval_required` 来绕过 Runtime 的权限判断。

### 3.5 ActionIntent

`ActionIntent` 是 Harness 对模型 GUI 操作意图的统一表示。不同 Provider 可以使用 Function Calling、Structured Output 或原生 Computer Use Protocol，但 Provider Adapter 只负责把模型输出规范化为 `ModelTurn/ToolCall`；随后由 Runtime 的 Computer Tool Executor 把 Computer ToolCall 转换成统一 ActionIntent。

V1 的 GUI Action 包括：

- Click；
- DoubleClick；
- RightClick；
- Type；
- Scroll；
- Drag；
- Keypress；
- Wait。

ActionIntent 不应假设所有操作都只依赖截图坐标。目标协议允许 point、window 和 element 三种形态，实际向模型暴露哪些目标类型由 ProviderCapabilities、ComputerCapabilities 和 Runtime Policy 的交集决定。除 `wait` 外，所有 GUI 输入动作都必须通过 `basedOn` 绑定产生该决策的 Observation；这同样适用于依赖窗口焦点的 `type` 和 `keypress`。

```ts
type ActionBase = {
  actionId: string;
  basedOn: string;
};

type ActionTarget =
  | { kind: "point"; x: number; y: number }
  | { kind: "window"; windowRef: string }
  | { kind: "element"; elementRef: string };
```

`basedOn` 不要求模型自行生成。Runtime 将 Computer ToolCall 转为 ActionIntent 时，注入当前仍有效的 ObservationId。

V1 默认一次 ModelTurn 最多执行一个 GUI Action。批量文本输入仍然是一个 Type Action；不默认支持绕过中间 Observation 的通用 Multi Action。

### 3.6 ActionReceipt

`ActionReceipt` 表示底层 Computer Backend 实际执行 Action 后产生的结果，用于明确区分“模型希望执行什么”和“系统实际执行了什么”。

`ActionIntent` 与 `ActionReceipt` 是 Harness Runtime 和 Computer Adapter 共享的 Computer 边界
协议，不是具体 Driver 的原生请求或返回。Runtime 生产 ActionIntent、Adapter 消费它；Adapter
把 Driver 私有结果规范化成 ActionReceipt，Runtime 再消费 Receipt。具体 Driver 类型只存在于
对应 Adapter 内部。

它至少记录：

- 对应 ActionIntent；
- 执行状态；
- Driver 的稳定错误码和必要消息；
- 是否被拒绝、失败或取消。

Action 执行成功只表示 Driver 接受或完成了操作，不代表用户目标已经完成。动作开始和结束时间由 Runtime Event 提供，动作后 Observation 由独立的 `observation.created` Event 保存，不重复塞进 Receipt。V1 不实现 `effect` 状态或语义级 Verification；只保留动作前后 Observation，未来有真实核验消费者时再由独立扩展产生新的验证事件。

### 3.7 RuntimeEvent

RuntimeEvent 是 Harness 的统一运行事实。CLI、调试界面、Trajectory、Metrics 和未来 Runtime Extension 都应消费同一条事件流，而不是各自维护独立 hook 和日志。

每个 Event 至少包含：

```ts
type RuntimeEventBase = {
  eventId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  type: string;
};
```

`sequence` 是 Run 内的权威顺序；JSONL 的物理行号不承担唯一排序语义。

## 四、Agent Runtime 工作流程

一次 GUI Agent Run 的基本流程如下：

```text
创建 Run
   ↓
创建 ComputerSession
   ↓
获取初始 ObservationFrame
   ↓
ContextCompiler 构建 ModelInput
   ↓
ProviderAdapter 调用模型并生成 ModelTurn
   ↓
解析模型结果
   ├─ GUI Action
   ├─ Planning Tool
   ├─ 其他允许的 Tool
   ├─ 请求用户输入或批准
   └─ Finish / Fail
   ↓
确定性 Runtime Validation
   ↓
Computer Adapter 执行动作
   ↓
生成 ActionReceipt
   ↓
自动获取新 ObservationFrame
   ↓
进入下一轮，直到产生 RunOutcome
```

Runtime 自动在 Run 开始和每个 GUI Action 完成后获取 Observation。模型不默认获得一个与自动观察重复的普通 `Observe` Tool；确有需要时可以提供语义明确的 `RefreshObservation`，避免多条截图路径竞争和额外视觉成本。

模型可能返回的结果不只有 GUI Action。ModelTurn 还应能够表示 Planning Tool、用户询问、Finish，以及附随 ToolCall 的文字内容。Agent Loop 负责路由这些标准结果，而不是把所有输出都强制解析成 ActionIntent。

其中 Approval 请求有两种来源：模型可以通过控制类 ToolCall 主动请求确认；Runtime Policy 也可以在 ToolCall 进入执行器前强制要求批准。后者是实际权限边界。

## 五、工具体系

### 5.1 Computer Tools

Computer Tools 包括 Click、DoubleClick、RightClick、Type、Scroll、Drag、Keypress、Wait，以及底层 Driver 和当前运行策略共同支持的必要操作。

这些工具虽然对模型表现为 Tool Call，但在 Runtime 内部统一转换为 ObservationFrame、ActionIntent 和 ActionReceipt。除 Wait 外，每个 GUI 输入动作必须绑定产生该决策的 Observation；过期 Observation、越界坐标、无效 Session 和不支持的目标类型在进入 Driver 前被拒绝。

### 5.2 Planning Tools

Planning 是 V1 自带但可选的内置扩展，提供：

- TaskCreate；
-TaskUpdate；
-TaskList；
-TaskGet。

V1 的 PlanningTask 保持简洁：

```ts
type PlanningTask = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: string[];
};
```

程序负责 ID、创建时间和更新时间；模型负责 title、status 和 blockedBy。模型不使用 Task System 时，GUI Runtime 仍应正常工作。

Planning State 可以在程序重启后重新加载，但这不等于恢复真实 GUI 执行状态。恢复执行前必须创建新的 ComputerSession、重新观察桌面，并由模型根据当前环境重新确认进度。

### 5.3 Side-channel Tools

项目预留 Shell、Filesystem、Clipboard、Browser Information 等 Side-channel Tool 的扩展能力，但它们不默认成为所有 Run 的核心路径。不同环境通过 Runtime Policy 决定哪些工具可见，避免 GUI Benchmark 被 Shell 或 Filesystem 绕过。

### 5.4 Tool Registry

所有 Tool 通过统一 Tool Registry 注册和执行。Provider Adapter 负责把 Harness Tool Schema 序列化成目标 API 所需格式，但 Tool 的语义和执行不进入 Provider Adapter。

ToolCall 与 GUI Action 始终保持两层语义：

```text
Model
  ↓
ToolCall
  ├─ Computer Tool → ActionIntent → Computer.execute()
  ├─ Planning Tool → Planning Executor → Planning State
  ├─ Side Tool     → 对应 Tool Executor
  └─ Control Tool  → Pause / User Input / Approval
```

所有 GUI Action 都可以由 Computer Tool 表达，但不是所有 ToolCall 都是 GUI Action。`ActionIntent` 只存在于 Computer Tool 分支，Tool Registry 不依赖 Computer Runtime 的内部类型，Computer Runtime 也不负责执行 Planning、Side-channel 或 Control Tool。

本轮实际暴露的 Tool Set 由以下交集产生：

```text
ProviderCapabilities
        ∩
ComputerCapabilities
        ∩
Runtime Policy
        ↓
Available Tools
```

## 六、Provider、Context 与 Computer 的边界

### 6.1 Provider Adapter

Provider Adapter 负责协议差异：

- API 请求和认证；
-消息与图片编码；
-Tool Schema 序列化；
-Function Calling 或 Structured Output；
-Streaming；
-Reasoning 配置；
-错误转换；
-将响应解析为统一 ModelTurn。

ProviderCapabilities 可以描述 Function Calling、Structured Output、Streaming、Reasoning Mode 和未来原生 Computer Use Protocol。V1 不把通用 Multi Action 作为必要能力。

### 6.2 ContextCompiler

ContextCompiler 负责决定每一轮模型在语义上看到什么：

- 用户目标；
-当前 Observation；
-少量必要历史 Observation；
-近期 Action/Receipt；
-Planning State；
-允许的工具语义；
-运行预算和必要状态。

V1 只稳定一个公共接口：

```ts
interface ContextCompiler {
  compile(input: ContextCompileInput): Promise<ModelInput>;
}
```

Observation Selection、History Selection、Context Reduction 和 Prompt Composition 可以作为默认 ContextCompiler 内部的清晰阶段，但在只有一个实现时不急于全部固化成公共接口。出现真实的第二种策略和独立消费者后，再将相应阶段提取为稳定扩展点。

ContextCompiler 决定“给模型什么语义内容”；Provider Adapter 决定“如何按目标 API 协议发送这些内容”。Provider-specific Prompt 优化不得把 HTTP 和模型协议细节反向渗透进 Agent Loop。

### 6.3 Computer Adapter

Computer Adapter 负责连接底层 GUI 操作面。V1 实现 `CuaDriverComputer`，通过固定版本的 `@trycua/cua-driver` 提供截图、鼠标、键盘、窗口和 Accessibility 等能力。

Runtime 只能通过 Computer 接口访问 CUA，不能在 Agent Loop、ContextCompiler 或 Provider Adapter 中直接调用 CUA 类型。CUA 的 session、frame、window 和 element 引用由 CuaDriverComputer 封装为 Harness 协议。

V1 需要对 CUA 的进程内和 Private Worker 模式做一次真实对照，检查截图完整性、坐标一致性、延迟、清理和崩溃隔离，再确定默认运行方式。不能仅凭接口名称假设 Private Worker 自动解决 Windows DPI 或权限问题。

## 七、Visual Context Management

GUI Agent 的 Context 与普通文本 Agent 最大的差异之一，是截图成本高且连续 Frame 高度重复。完整运行事实与模型实际上下文必须分开。

V1 默认策略可以是：

- 当前 Observation 必须保留；
-保留少量最近关键 Observation；
-早期截图不重复发送；
-更早历史转为近期 Action/Receipt 摘要；
-Planning State 作为可选 Working State 注入；
-所有原始 Observation 仍保存在 Trajectory 中。

一个执行 40 个 GUI Step 的任务，不应默认重新发送全部 40 张截图。模型可以看到当前截图、少量关键 Frame、当前任务进度和必要动作摘要；审计和离线分析则仍能访问完整轨迹。

未来可以在不修改 Agent Loop 的情况下研究：

- Visual Keyframe Selection；
-页面变化检测；
-视觉相似度去重；
-Task-aware Context；
-层次化 Action Summary；
-多模态 Context Compaction；
-Token/Image Budget 路由。

这些是后续可替换策略，不要求 V1 同时实现。

## 八、Planning State

Planning State 作为模型可主动使用的外部工作状态，而不是强制 Workflow Scheduler。

简单任务可以直接执行；长流程任务可以动态创建和更新 PlanningTask。Harness 不要求模型在任务开始前生成完整 DAG，也不依据 PlanningTask 直接决定真实 GUI 状态。

Task 的权威修改过程写入 RuntimeEvent，`tasks.json` 只作为从 task events 计算出的当前快照：

```text
trajectory.jsonl = 权威事实源
tasks.json       = 当前 Planning State 的物化快照
```

如果快照损坏，应能够由 task events 重建，而不是让两份文件同时成为相互冲突的事实源。

## 九、Runtime Event 与 Trajectory

一次 Run 的关键事实都会转化为 Event，例如：

```text
run.started
computer.started
observation.created

model.request.started
model.response.completed

action.proposed
action.validation.rejected
action.execution.started
action.execution.completed

task.created
task.updated

approval.requested
approval.resolved

run.paused
run.completed
run.failed
run.cancelled
```

V1 使用 JSONL 保存 RuntimeEvent，Screenshot 和其他二进制内容作为独立 Asset 保存：

```text
.gui-harness/
└── runs/
    └── run-123/
        ├── trajectory.jsonl
        ├── tasks.json
        └── assets/
            └── screenshots/
```

模型上下文可以被裁剪，但 Trajectory 始终保留完整事实。CLI、后续 Web UI、Debug Timeline、Benchmark 和离线数据分析都建立在同一事件协议上。

V1 所称 Replay 是检查式回放：按顺序查看模型输入、输出、Observation、Action、Receipt、Task 更新和错误。只有具有可重置初始状态和确定性 evaluator 的环境，才进一步支持动作重新执行；项目不承诺在变化中的本机桌面上重放动作会得到相同结果。

### 9.1 副作用与 Event 落盘原则

RuntimeEvent 是权威运行事实，因此具有外部副作用的执行必须采用“先记录执行意图，再产生副作用，再记录结果”的顺序：

```text
action.proposed
   ↓
Runtime Validation
   ↓
持久化 action.execution.started
   ↓
Computer.execute() 产生真实副作用
   ↓
持久化 action.execution.completed
```

`action.execution.started` 成功写入后才能调用 Driver；如果 started Event 无法持久化，本次 Action 不得执行。Driver 正常返回或抛出可捕获错误后，都要写入 `action.execution.completed`，并在其中保存成功、失败、拒绝或取消状态以及对应 ActionReceipt。

如果进程在副作用发生后、completed Event 写入前崩溃，Trajectory 中会留下 started 但没有 completed 的执行。这种状态表示 `outcome_unknown`：Runtime 可以重新观察环境或请求用户确认，但不能盲目自动重试，因为原动作可能已经实际生效。

该原则优先解决进程级崩溃后的事实缺口。V1 不额外承诺操作系统突然断电或存储介质损坏下的事务级持久性；如果后续有该需求，再评估 fsync 或事务存储。

## 十、Runtime Policy 与执行安全

GUI Agent 必须具备最低限度的运行控制。V1 至少包括：

- `maxSteps`；
- `maxDurationMs`；
- Ctrl+C 或 AbortSignal 取消；
-暂停与继续入口；
-基础 Approval；
-Tool allowlist；
-ComputerSession 和 Observation 有效性检查。

基础 Approval 不需要演化成复杂安全平台。默认可以自动执行普通点击、输入和滚动；高风险 Side Tool 或用户明确配置的动作要求确认。

Runtime Error 至少区分：

- Provider 调用失败；
-模型输出解析失败；
-Action 校验失败；
-Driver 拒绝；
-Driver 不可用；
-Observation 获取失败；
-预算耗尽；
-用户取消。

错误进入 RuntimeEvent 和 RunOutcome，不能只保留一段不可分类字符串。

## 十一、扩展能力边界

V1 的核心 Runtime 保持较薄。扩展能力分为两类。

### 11.1 V1 内置扩展

- Planning；
-Trajectory；
-Approval；
-基础 ContextCompiler。

### 11.2 后续可插拔扩展

- LightSpeaker 屏幕和变化描述；
-语义 Verifier；
-运行时 Guardrail；
-Cache；
-Metrics；
-长期 Memory；
-Context 优化策略；
-Benchmark Adapter；
-Subagent。

Verification 默认不进入每个 GUI Step 的执行路径。Subagent 暂不进入 V1，因为多个 Agent 同时控制一个 Desktop 会产生 Computer Ownership、焦点、输入和状态隔离问题。只有单 Agent Runtime 稳定，并具有多 ComputerSession 或独立环境后，才考虑并行 Agent。

预留扩展位置不等于在 V1 中为每个未来概念创建空接口。只有出现真实生产者、消费者和第二种实现后，才将对应边界固化为公共 API。

## 十二、V1 产品形态

V1 形成一个可以独立使用的 TypeScript 多模态 GUI Agent Harness。

开发者可以通过 CLI 或 SDK：

1. 提交自然语言任务；
2. 选择已配置的多模态模型 Provider；
3. 创建 Run 与 CuaDriverComputer；
4. 让统一 Agent Loop 持续执行 Observe → Think → Act → Observe；
5. 查看实时事件、当前 Observation、Action 和 Task 状态；
6. 暂停、取消或批准操作；
7. 在结束后检查完整 Trajectory。

V1 首先完成 CLI 和 SDK。Web UI 可以消费相同 RuntimeEvent，但不作为 Agent Loop 成立的前置条件。

## 十三、推荐工程结构

```text
gui-agent-harness/
├── apps/
│   └── cli/
│
├── packages/
│   ├── protocol/          # Run、Event、Observation、Action 合同
│   ├── runtime/           # Agent Loop、生命周期、预算、取消
│   ├── providers/         # Provider Adapter
│   ├── tools/             # Tool Registry 与执行
│   ├── computer/          # Computer 接口
│   ├── computer-cua/      # CUA 0.22.2 Adapter
│   ├── context/           # ContextCompiler
│   ├── planning/          # Planning Tool 与状态
│   ├── trajectory/        # Event 和 Asset 存储
│   └── policy/            # Tool Policy 与 Approval
│
└── extensions/
    └── lightspeaker/      # 后续观察、播报与核验扩展
```

目录表示当前已经有明确生产者和消费者的模块边界，不为尚未进入 V1 的 Subagent、分布式 Worker 或长期 Memory 预建空包。

## 十四、项目形态图

```text
User / Application
        │
    CLI / SDK
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│                  Multimodal GUI Harness                   │
│                                                           │
│  Run                                                      │
│  ├─ Agent Loop                                            │
│  ├─ Runtime Policy                                        │
│  ├─ EventStream                                           │
│  └─ RunOutcome                                            │
│          │                                                │
│          ├───────────────┬────────────────┐               │
│          ▼               ▼                ▼               │
│  ContextCompiler   ProviderAdapter   ToolRegistry          │
│                          │                │               │
│               Doubao / GLM / Qwen        ├─ Computer      │
│                                           ├─ Planning      │
│                                           └─ Side Tools    │
│                                                │          │
│  ComputerSession                               │          │
│  ├─ ObservationFrame                           │          │
│  ├─ ActionIntent ◄─────────────────────────────┘          │
│  └─ ActionReceipt                                         │
│          │                                                │
│          ▼                                                │
│  Computer Interface                                      │
│          │                                                │
│  CuaDriverComputer                                       │
│                                                           │
│  Built-in Extensions          Optional Extensions         │
│  ├─ Planning                   ├─ LightSpeaker            │
│  ├─ Trajectory                 ├─ Verifier                │
│  └─ Approval                   ├─ Metrics                 │
│                                └─ Cache                   │
└───────────────────────────────────────────────────────────┘
        │
        ▼
@trycua/cua-driver@0.22.2
        │
Windows / macOS / Linux
        │
     GUI Apps
```

完整事实独立于模型上下文保存：

```text
Observation → ModelTurn → ActionIntent → ActionReceipt → Observation
     │             │             │              │              │
     └─────────────┴─────────────┴──────────────┴──────────────┘
                                  │
                                  ▼
                           RuntimeEvent Stream
                                  │
                                  ▼
                           trajectory.jsonl
                           assets/screenshots/
                           tasks.json
```

## 十五、V1 实施重点

V1 不是一个只能截图和点击的 Demo，而是一条完整的 Agent vertical slice：

1. TypeScript CLI 接收自然语言任务；
2. 至少两个多模态 Provider Adapter；
3. CUA 0.22.2 创建真实 ComputerSession；
4. 初始 Observation 和 Action 后自动 Observation；
5. 统一 ModelTurn 和单步 ActionIntent；
6. Action 校验、执行和 ActionReceipt；
7. 可选 Planning Tool；
8. Step/Time Budget；
9. Pause、Cancel 和基础 Approval；
10. Runtime Event、Asset 和检查式回放；
11. 一个默认 ContextCompiler；
12. 通过少量真实跨应用任务完成端到端验证。

首轮不同时实现多个 Context 策略、多个 TaskStore、复杂 Verifier、Subagent 或完整 Web 产品。核心链路稳定后，再以真实实验暴露的问题决定下一轮扩展。

## 十六、V1 成功标准

V1 需要用可执行事实验证以下命题：

1. 同一个 Agent Loop 中不存在针对豆包、GLM、Qwen 的业务条件分支；
2. 至少两个 Provider Adapter 能在同一 Runtime 下完成同一组真实 GUI 任务；
3. Runtime 不直接依赖 CUA 私有类型，所有操作经过 Computer 接口；
4. 每个坐标 Action 都绑定明确的 ObservationFrame；
5. 每个 GUI Action 都产生 ActionReceipt 和后续 Observation；
6. Run 可以完成、失败、暂停、取消和因预算耗尽终止；
7. Trajectory 能重建每轮模型输入、模型输出、Observation、Action、Receipt、Task 更新和错误；
8. Context 裁剪不会删除完整 Trajectory；
9. 具有副作用的 Tool 在执行前已经持久化 started Event；Provider 或 Driver 失败不会破坏已经写入的运行事实；
10. 至少在 5—10 个跨应用真实任务上跑通完整闭环，并记录任务成功、步骤数、延迟、模型成本和失败原因。

V1 的核心产品命题为：

> 在同一套 GUI-native Runtime、Observation/Action 协议与 Trajectory 语义下，至少两个多模态 Provider 能通过同一个 CUA Computer Backend 完成真实桌面任务；Provider 切换不需要修改 Agent Loop，Context 策略和 Runtime Extension 可以在不破坏核心执行语义的情况下继续演化。

## 十七、项目目标

本项目希望将 GUI Agent 的开发方式从“针对一个模型手写 Screenshot—Action Loop”，提升为“在统一 GUI-native Harness Runtime 上开发 Computer Use Agent”。

在该架构下，多模态模型负责理解 GUI 状态、规划并提出下一步操作；`trycua/cua-driver` 负责真实操作系统交互；Harness 负责连接模型与环境，并管理 Run、ComputerSession、Observation、Action、Context、Planning、Policy 和 Trajectory 等长期运行时问题。

V1 的核心产品特征概括为：

**GUI-native、Provider-neutral、Context-extensible、Observable、Controllable、Inspectable。**

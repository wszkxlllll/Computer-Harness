# 多模态 GUI Agent Harness V1 技术计划书

> 文档状态：施工前技术基线  
> 对应产品文档：`multimodal-gui-agent-harness-product-plan.md`  
> 适用范围：V1 单 Agent、单 Run、单 ComputerSession 的 TypeScript 实现  
> 核心基础设施：`@trycua/cua-driver@0.22.2`

> Stage 3 实施提示（2026-08-29）：真实 CUA 0.22.2 Schema 审计发现，桌面像素动作没有
> Driver Frame token；S3-1C 之前的 `scroll(deltaX, deltaY)` 已在 S3-2 收窄为带落点、方向和正
> 整数 ticks 的动作，以匹配已实测的 CUA wheel 输入边界。
> Stage 3 的具体施工顺序、两级 Frame 新鲜度和协议决策以当前
> [总体审计](./trajectory-review-2026-09-02/runtime-trajectory-cua-adapter-issues-2026-09-02.md)及本地历史证据为准；
> 不要把本文中的所有 `CuaFrameRef` 描述视为桌面像素路径已经具备的能力。

## 一、文档目的

本技术计划书把已经确认的产品方案下沉为可直接施工、测试和验收的工程设计。它重点解决以下问题：

1. Runtime、Provider、Computer、Tool、Context 和 Trajectory 之间如何解耦；
2. 每个核心对象由谁产生、由谁消费、何时持久化；
3. GUI 动作如何绑定观察帧，并在崩溃、超时和底层拒绝时保留可信事实；
4. 如何同时接入至少两个多模态模型 Provider，而不在 Agent Loop 内堆积厂商分支；
5. 如何基于 `trycua/cua-driver` 驱动真实桌面，同时避免重演 OpenClaw 中遇到的帧污染、会话失效和生命周期耦合问题；
6. 如何为未来 Subagent、后台任务、Verifier 和 LightSpeaker 扩展保留合理空间，但不提前实现没有当前消费者的抽象。

本文件不是产品宣传材料，也不是完整代码设计稿。接口定义用于固定模块边界；实现细节仍以测试结果为准。

## 二、V1 建设目标与非目标

### 2.1 V1 必须完成

- 一个可独立运行的 TypeScript GUI Agent Runtime；
- 一个统一的 `Computer` 接口和 `CuaDriverComputer` 实现；
- 两个真实多模态 Provider Adapter 和两个当前可运行模型配置；
- Provider 无关的 `ModelTurn`、`ToolCall`、`ActionIntent` 和 `ActionReceipt` 协议；
- 单 Run 的 `Observe → Model → Act → Observe` 循环；
- Frame 绑定、坐标边界、Session 状态等确定性校验；
- Runtime Policy：步数、时长、工具白名单、暂停、取消和基础审批；
- JSONL Runtime Event、截图资产和运行结果的完整落盘；
- 可选的轻量 Planning Task 工具；
- CLI 与 SDK 两种入口；
- 在一组冻结且具有外部验收标准的真实任务上完成端到端验证；
- 相同 Runtime 下切换 GLM model profile 或 Qwen Adapter，不修改 Agent Loop。

### 2.2 V1 明确不做

- 不训练或微调基础模型；
- 不默认在每一步调用额外 Verifier；
- 不实现 Subagent、Agent Team、Mailbox 或多 Agent 调度；
- 不实现后台 Job Manager；
- 不实现长期用户记忆和知识库；
- 不实现通用 Workflow DSL；
- 不实现分布式 Worker；
- 不实现产品级 Web Dashboard；
- 不承诺崩溃后自动重放未确认的 GUI 副作用；
- 不把测试用 FakeComputer 包装成产品功能；
- 不在 V1 引入 ReplayComputer 产品实现。

## 三、技术基线

### 3.1 工程栈

| 项目 | 选择 | 说明 |
|---|---|---|
| 运行时 | Node.js LTS | 仓库中固定最低支持版本，CI 使用同一主版本 |
| 语言 | TypeScript strict | 禁止关闭严格模式绕过协议问题 |
| 模块系统 | ESM | 与现代 Node 和 SDK 生态保持一致 |
| Monorepo | pnpm workspace | 包边界清晰，便于独立测试 Provider 与 Adapter |
| 测试 | Vitest | 单元、契约和集成测试统一 |
| 外部输入校验 | Zod | 只用于模型输出、配置、Driver 返回值和磁盘数据等边界 |
| GUI Driver | `@trycua/cua-driver@0.22.2` | V1 固定版本，升级单独验证 |
| 日志事实存储 | JSONL + 独立资产文件 | 先保证透明、可检查和可恢复分析 |

### 3.2 TypeScript 约束

- 核心协议使用 discriminated union，所有分支必须穷尽处理；
- 对容易混淆的核心 ID 使用 branded type，但不为所有字符串制造品牌类型；
- 禁止 Runtime 通过 `any` 直接消费 Provider 或 Driver 原始对象；
- 外部边界进入系统时校验一次，内部可信对象不重复做全量 Schema 校验；
- 所有长耗时接口接收 `AbortSignal`；
- 资源对象必须显式 `open/close` 或由 `finally` 确保释放；
- 运行状态不得依赖进程级 `currentObservation`、`currentTask` 等全局单例。

## 四、仓库结构与依赖方向

```text
gui-agent-harness/
├─ apps/
│  └─ cli/                  # 命令行入口、配置装配和运行展示
├─ packages/
│  ├─ protocol/             # 核心协议、ID、错误和事件类型
│  ├─ runtime/              # RunController、状态机和 Agent Loop
│  ├─ providers/            # Provider 公共接口
│  ├─ provider-doubao/      # 豆包 Adapter
│  ├─ provider-glm/         # GLM Adapter
│  ├─ provider-qwen/        # Qwen3.8-Flash Adapter
│  ├─ tools/                # Tool Registry、Schema 和路由
│  ├─ computer/             # Computer 公共接口
│  ├─ computer-cua/         # trycua/cua-driver 适配
│  ├─ context/              # ContextCompiler 默认实现
│  ├─ trajectory/           # EventWriter、AssetStore 和投影
│  ├─ policy/               # 风险、预算、审批和工具许可
│  └─ planning/             # 可选 PlanningTask 扩展
├─ extensions/
│  └─ lightspeaker/         # 后续接入，不属于 V1 核心阻塞项
├─ tests/
│  ├─ contract/             # Provider/Computer 契约测试
│  ├─ integration/          # Runtime + Fake 依赖集成测试
│  └─ live/                 # 真实 API 与真实桌面测试，默认不在普通 CI 执行
└─ docs/
```

依赖规则：

```text
protocol
   ↑
   ├── runtime
   ├── providers / provider-*
   ├── computer / computer-cua
   ├── tools
   ├── context
   ├── trajectory
   ├── policy
   └── planning

apps/cli 负责组合具体实现
```

约束：

- `protocol` 不依赖任何具体 Provider、CUA 或 CLI；
- `runtime` 只依赖接口和核心协议，不导入具体 Provider；
- `computer-cua` 不反向依赖 Runtime；
- Provider 包不得直接执行 GUI 动作；
- CLI 是 composition root，负责读取配置并注入依赖；
- 禁止包循环依赖。

## 五、核心协议

### 5.1 ID 与资产引用

V1 只为最容易串错的实体建立独立 ID：

```ts
type RunId = Brand<string, "RunId">;
type ComputerSessionId = Brand<string, "ComputerSessionId">;
type ObservationId = Brand<string, "ObservationId">;
type ActionId = Brand<string, "ActionId">;
type ToolCallId = Brand<string, "ToolCallId">;
type EventId = Brand<string, "EventId">;
type AssetId = Brand<string, "AssetId">;
```

截图不直接以内存 Base64 形式长期保存在 Event 中，而使用资产引用：

```ts
interface AssetRef {
  assetId: AssetId;
  relativePath: string;
  mediaType: string;
  byteLength: number;
}
```

V1 通过临时文件写入后原子发布保证本地资产不会以半写状态被 Event 引用；当前
`FileAssetStore` 在同一目录使用不可覆盖的硬链接发布，因此目标路径已存在时会
明确失败，保留 write-once 事实语义。当前没有跨机器传输校验或内容寻址需求，因此
不在协议中加入哈希字段；以后出现真实完整性消费者时再设计。

### 5.2 ComputerSession

```ts
interface ComputerSessionDescriptor {
  readonly id: ComputerSessionId;
  readonly backend: string;
  readonly viewport: Readonly<Viewport>;
  readonly capabilities: Readonly<ComputerCapabilities>;
  readonly openedAt: string;
}

type ComputerSession = ComputerSessionDescriptor;
```

它表示当前 Run 控制的 GUI 世界，不等同于聊天会话、模型请求或 CUA 内部授权句柄。公开协议只
持久化稳定描述；Driver handle、连接状态和 Frame Reference 由 Adapter 私有维护。

### 5.3 ObservationFrame

```ts
interface ObservationFrame {
  id: ObservationId;
  runId: RunId;
  computerSessionId: ComputerSessionId;
  capturedAt: string;
  viewport: Viewport;
  screenshot: AssetRef;
}
```

关键规则：

- `id` 由 Harness 生成，用于 Runtime、Context 和 Event 绑定；
- `viewport` 描述截图使用的坐标空间，所有坐标动作必须绑定该 Frame；
- Runtime 不把图片宽高相同视为 Frame 等价；
- 新观察产生后，旧 Frame 不一定立即失效，但任何执行前都要由 Computer Adapter 和 Policy 联合判断是否仍可使用；
- CUA 私有 Frame Reference 不进入公共 protocol，由 `CuaDriverComputer` 在内部维护 `ObservationId → CuaFrameRef` 映射；
- Adapter 关闭、重连或 Display 配置变化时清除内部映射，使旧 Observation 无法继续执行；
- V1 不在公共 `ObservationFrame` 中保留含义不明确的 `unknown` 扩展字段；Accessibility 真正接入 Context 或工具后，再定义明确、可验证的协议类型。

### 5.4 ToolCall 与 ModelTurn

Provider 世界与 Runtime 世界的正式边界为：

```ts
interface ToolCall {
  id: ToolCallId;
  name: string;
  arguments: JsonValue;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type ToolResult =
  | {
      callId: ToolCallId;
      status: "completed";
      output: JsonValue;
    }
  | {
      callId: ToolCallId;
      status: "failed";
      error: { code: string; message: string };
    }
  | {
      callId: ToolCallId;
      status: "rejected";
      error: { code: string; message: string };
    };

type ModelTurn = (
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
      reportedStatus?: "success" | "failure";
    }
) & { usage?: ModelUsage };

// Provider usage is optional diagnostics, not a control signal.
interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
```

审批不由模型直接下最终结论。模型若认为需要授权，调用一个控制类工具提出请求，是否进入审批状态由 `RuntimePolicy` 决定。

`Run`、`ModelTurn`、Tool、GUI Action、用户询问和过程纠正的完整关系见
[`run-turn-tool-and-user-correction-semantics.md`](./run-turn-tool-and-user-correction-semantics.md)。

### 5.5 ToolCall 与 ActionIntent 两层语义

```text
ModelTurn.tool_calls
        │
        ├─ computer tool ─→ ActionIntent ─→ Computer.execute()
        ├─ planning tool ─→ PlanningService
        ├─ control tool  ─→ RunController / RuntimePolicy
        └─ side tool     ─→ 对应 ToolExecutor
```

所有 GUI Action 可以由 Tool 表达，但不是所有 Tool 都是 GUI Action。`TaskUpdate`、请求用户输入和未来的查询工具不得被强行转换为 `ActionIntent`。

`ActionIntent` 和 `ActionReceipt` 都属于 Harness 定义的 **Computer 边界协议**，但不属于
`cua-driver` 的私有协议：

```text
Provider 输出 ToolCall
        ↓
Runtime 的 Computer Tool Executor 生成 ActionIntent
        ↓
Computer Adapter 转换为具体 Driver 请求
        ↓
Driver 私有结果
        ↓
Computer Adapter 规范化为 ActionReceipt
        ↓
Runtime 写 Event、生成 ToolResult 并决定下一步
```

因此，Runtime 不直接依赖 CUA action/result 类型，Adapter 也不负责理解模型 ToolCall、任务目标
或语义是否完成。

### 5.6 ActionIntent

```ts
interface GuiActionBase {
  actionId: ActionId;
  basedOn: ObservationId;
}

type ActionIntent =
  | (GuiActionBase & { kind: "click"; point: Point })
  | (GuiActionBase & { kind: "double_click"; point: Point })
  | (GuiActionBase & { kind: "right_click"; point: Point })
  | (GuiActionBase & { kind: "type"; text: string })
  | (GuiActionBase & { kind: "keypress"; keys: string[] })
  | (GuiActionBase & {
      kind: "scroll";
      point: Point;
      direction: "up" | "down" | "left" | "right";
      ticks: number;
    })
  | (GuiActionBase & { kind: "drag"; from: Point; to: Point })
  | { actionId: ActionId; kind: "wait"; durationMs: number };
```

V1 原则：

- 除 `wait` 外，所有会作用于 GUI 的输入动作都必须有 `basedOn`；
- `type` 和 `keypress` 虽然不含坐标，仍然依赖产生决策时的焦点和界面状态，因此同样绑定 Observation；
- 模型不负责生成或复制 `ObservationId`。Computer Tool Executor 将 ToolCall 转成 ActionIntent 时，从当前 RunSnapshot 注入最新、仍有效的 ObservationId；
- 若当前没有可执行 Observation，Runtime 先重新观察，不能凭历史焦点盲目执行；
- 一个 `ModelTurn` 最多包含一个产生 GUI 副作用的 Computer Tool；
- Provider 若返回多个 GUI 副作用动作，Runtime 拒绝该 Turn，并将结构化错误反馈给下一轮模型；
- V1 不默认开放“批量点击”或宏动作。

### 5.7 ActionReceipt

```ts
interface ActionReceipt {
  actionId: ActionId;
  status: "completed" | "refused" | "failed" | "cancelled";
  driverCode?: string;
  message?: string;
}
```

`completed` 只表示 Driver 已接受并完成动作调用，不表示用户目标或页面语义已经成功。

字段所有权如下：

| 字段 | 生产者 | 当前消费者 |
|---|---|---|
| `ActionIntent.actionId` | Runtime ID Factory | Runtime Event、Adapter 和 Receipt 关联检查 |
| `ActionIntent.basedOn` | Runtime 从当前有效 Observation 注入 | Runtime Validation、Computer Adapter |
| `ActionIntent.kind` 与参数 | Computer Tool Definition 的 `toAction` | Runtime Validation、Computer Adapter |
| `ActionReceipt.actionId` | Adapter 回显收到的 Action ID | Runtime 将回执关联到进行中的 Action |
| `ActionReceipt.status` | Adapter 根据 Driver 返回或明确拒绝进行规范化 | Runtime 分支、Event、ToolResult |
| `driverCode` / `message` | Adapter 从结构化 Driver 错误中提取 | ToolResult 错误、Trajectory 诊断和审计界面 |

任何新的公共协议字段在合入前都必须回答：谁生产、谁消费、何时创建或更新、缺失时如何处理。
如果只有生产者没有当前消费者、只能从私有 Driver 猜测、或没有可靠更新机制，该字段只能留在
Adapter 私有状态或能力实验记录中，不能进入 Protocol。

动作开始和结束时间已经由 `action.execution.started/completed/failed` Event 的 `occurredAt`
提供；持续时间可以从两个 Event 推导，因此不在 Receipt 中重复维护。CUA 的 `effect`、`route`、
`delivery` 和原始 JSON 目前没有公共消费者，不进入 Protocol。

`ActionReceipt` 不使用 `outcome_unknown` 伪装成一个已完成的动作终态。若
`action.execution.started` 已经持久化，但 Runtime 无法确认 GUI 副作用是否发生，则不写
虚假的 completed/failed Receipt，保留未决动作并让 Run 进入 `outcome_unknown` 恢复路径。

### 5.8 Run 状态与结果

```ts
type RunStatus =
  | "created"
  | "starting"
  | "running"
  | "waiting_user"
  | "waiting_approval"
  | "paused"
  | "finished";

type RunOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "budget_exhausted"
  | "outcome_unknown";
```

一个 Run 对应一次用户目标的执行。V1 中一个 Runtime Session 只运行一个 Run；未来若加入跨任务 AgentSession，应在 Run 之上组合，而不是改变 Run 的事实语义。

## 六、Provider-neutral 模型输入

### 6.1 ModelInput

```ts
interface ModelInput {
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
}

interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: ModelContentBlock[];
}

type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; asset: AssetRef; viewport: Viewport }
  | { type: "tool_call"; call: ToolCall; viewport?: Viewport }
  | { type: "tool_result"; result: ToolResult };
```

`ContextCompiler` 产生 `ModelInput`，`ProviderAdapter` 消费它。Runtime 不拼接任何厂商专用消息。

### 6.2 ProviderAdapter

```ts
interface ProviderAdapter {
  readonly id: string;
  generate(
    input: ModelInput,
    options: { signal: AbortSignal },
  ): Promise<ModelTurn>;
}
```

职责边界：

- Provider Adapter 负责认证、图片编码、请求格式、Tool Schema 映射、Streaming、响应解析和错误归一化；
- ContextCompiler 负责决定给模型哪些任务、历史、截图和工具结果；
- Runtime 只消费 `ModelTurn`；
- Provider Adapter 不读取全局 Run 状态，也不直接写 PlanningTask；
- Provider 原始响应可作为脱敏调试资产保存，但不进入核心协议。

Stage 4 的真实能力边界不是“所有 Provider 都支持同一种 Computer Use”。当前两个 Provider 都使用
OpenAI-compatible Function Calling；GLM 生产 profile 固定为 `actual_pixels`，Qwen 的 Experiment C 暂时
比较 `actual_pixels` 与 `normalized_1000` 两种坐标表示。两者都按 Runtime 工具逐个生成 Function Schema，
并把工具自身的 `required`、字段 description、`additionalProperties` 和当前 viewport 的坐标范围带到
模型请求中；Qwen3.8 另提供 `terminate(status)` 与 `interact(text)` 控制函数。Provider 负责函数名白名单、
参数解析与坐标映射，不能用未经验证的 Provider 协议冒充 canonical 工具。Provider 进入 Runtime 前必须同时
满足：真实请求形状、模型响应解析、第二轮 ToolCall/ToolResult 历史呈现三者一致。Function Calling Schema
是生成约束，不取代 Parser、ToolRegistry 和 Runtime Policy 的二次校验；模型没有返回结构化 status 时，
Runtime 不从普通文本猜测成功或失败。

### 6.3 Provider 能力

Stage 4 暂不定义公共 `ProviderCapabilities`。GLM profile 和 Qwen Adapter 各自只保存真实消费者需要的
模型名、思考模式、坐标模式和请求差异；等两个 Adapter 出现相同的 Context/Tool presentation 需求后再
提升为公共合同。

## 七、Tool Registry 与执行路由

### 7.1 ToolDefinition

```ts
interface ToolDefinition {
  name: string;
  description: string;
  category: "computer" | "planning" | "control" | "side";
  inputSchema: JsonValue;
  validate(args: JsonValue): void;
}

interface ComputerToolDefinition extends ToolDefinition {
  category: "computer";
  toAction(args: JsonValue, context: ToolExecutionContext): GuiActionDraft;
}
```

V1 所有工具都必须在当前 Run 内返回明确结果后才能进入下一轮；GUI 动作还必须独占当前 ComputerSession。V1 不在 ToolDefinition 中提前固化 background 字段。只有未来真正具备 JobId、状态查询、等待、取消和持久化语义时，才引入 Blocking/Background Execution 协议。

### 7.2 Tool 调用处理

每个 ToolCall 依次经过：

1. 查找 ToolDefinition；
2. 校验输入 Schema；
3. RuntimePolicy 检查工具许可、风险和预算；
4. 按 category 路由；
5. 写入对应 Runtime Event；
6. 将结构化 Tool Result 加入下一轮 Context。

`ToolResult` 是所有 Tool 返回 Provider 世界的统一结果。Computer Tool 仍以
`ActionIntent/ActionReceipt` 表达 GUI 副作用事实，但在动作结束并获得后续 Observation 后，
Runtime 还要为原始 `ToolCallId` 产生对应 ToolResult。Planning、Control 和 Side Tool 则直接
产生 ToolResult。这样 Tool Registry 不需要把所有工具伪装成 GUI Action。

V1 对一轮多个调用采用保守规则：

- 可以接受多个不产生 GUI 副作用的 Planning/Control 调用，并按顺序执行；
- 最多一个 GUI 副作用调用；
- 若调用间存在无法确认的依赖，拒绝整组并要求模型单步输出；
- 不并发执行同一 ComputerSession 上的工具。

## 八、Computer 接口与 CUA 适配

### 8.1 Computer 接口

```ts
interface Computer {
  open(options: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSession>;
  observe(
    session: ComputerSession,
    observationId: ObservationId,
    signal: AbortSignal,
  ): Promise<ObservationCapture>;
  execute(
    session: ComputerSession,
    action: ActionIntent,
    signal: AbortSignal,
  ): Promise<ActionReceipt>;
  close(session: ComputerSession): Promise<void>;
}

interface ObservationCapture {
  capturedAt: string;
  viewport: Viewport;
  screenshot: {
    mediaType: "image/png" | "image/jpeg";
    data: Uint8Array;
  };
}
```

`Computer` 只表达 Harness 所需语义，不原样暴露 `cua-driver` 的全部 API。

`ObservationFrame` 是 Runtime 在截图资产成功落盘后创建的公共事实，不应由 Computer
Adapter 提前构造一个尚未持久化的 AssetRef。Runtime 先分配 `ObservationId` 并传给
`observe`；Adapter 可以在内部建立该 ID 到私有 Driver Frame 的映射，返回原始
`ObservationCapture`；随后 Runtime 写入 Asset，再构造并 append
`observation.created`。

### 8.2 CuaDriverComputer 职责

- 管理底层 Driver 的启动、连接、健康检查和关闭；
- 将 CUA 截图与元数据转换为 `ObservationFrame`；
- 将 `ActionIntent` 转换为 CUA 调用；
- 将 CUA 返回和结构化错误规范化为最小 `ActionReceipt`，不透传私有结果对象；
- 在 Adapter 内部保存并解释 `ObservationId → CuaFrameRef` 映射；
- 将 CUA 错误归一化为 Runtime Error；
- 确认截图尺寸、Viewport 和坐标空间一致；
- 在执行任何 GUI 输入动作前检查其 Observation 映射是否仍有效；
- CUA Session 失效时返回明确错误，不在 Adapter 内无限重试；
- Driver 重连后清空旧映射；
- Run 结束时释放映射；在无进行中动作引用旧 Frame 时可以淘汰旧映射，防止长任务无限增长。

### 8.3 帧与坐标约束

本项目此前已遇到观察截图覆盖执行帧、不同宽度截图导致 stale frame 等问题。因此 V1 必须满足：

- Harness 的 `ObservationFrame` 和 CUA 内部 Frame 只通过明确映射关联；
- 该映射属于 `CuaDriverComputer` 私有状态，不写入 protocol、Context 或 Trajectory；
- 描述屏幕、保存审计截图等只读消费者不得修改 Computer Adapter 的当前执行帧；
- 任何图片缩放必须同时保存源尺寸、交付尺寸和坐标变换；
- 坐标动作只能使用与其 `basedOn` 对应的坐标空间；
- 新截图不得静默覆盖仍待执行动作引用的 Frame；
- 重连或 Display 配置变化后，所有旧 Frame 立即视为失效；
- 不以“分辨率相同”替代 Frame ID 校验。

### 8.4 CUA 技术探针

正式实现前先完成一个独立、可删除的技术探针，验证 `0.22.2`：

1. Windows 100%、125%、150% DPI 下完整桌面截图与坐标点击；
2. 多次 `observe → click → observe` 的 Frame 一致性；
3. Driver 重启和连接中断后的错误行为；
4. 截图原图、传给模型的压缩图和坐标映射；
5. direct 与 private-worker 两种运行方式的稳定性和退出清理；
6. macOS/Linux 的最小接口可用性由队友分别验证。

探针结果决定首个 Adapter 的默认启动模式。计划书不预设两套产品实现都进入 V1。

## 九、ContextCompiler

### 9.1 公共接口

```ts
interface ContextCompiler {
  compile(input: ContextCompileInput, signal: AbortSignal): Promise<ModelInput>;
}
```

V1 只公开这一层。Observation Selection、History Selection、Reduction 和 Prompt Composition 可以作为默认实现内部步骤，但在出现第二个真实策略前不拆成四个公共包和四套空接口。

### 9.2 默认上下文策略

每轮输入包含：

- 用户原始目标；
- 最新 ObservationFrame；
- 当前允许的 Tool Schema；
- 最近少量 Action/Tool 结果；
- 由事件投影得到的简短运行进度；
- 若启用 Planning，则加入未完成 Task 和当前 Task；
- 上一轮结构化错误或审批结果。

默认不包含：

- 全部历史截图；
- 完整 JSONL Event；
- Driver 原始内部状态；
- 与当前任务无关的长期聊天记录；
- 未验证的应用语义状态。

V1 先采用“最新 Frame + 最近有限事件”的固定策略，通过配置控制窗口大小。只有真实轨迹证明需要时，再引入关键帧选择或多模态压缩。

## 十、RunController 与 Agent Loop

### 10.1 依赖注入

```ts
interface RunControllerDependencies {
  provider: ProviderAdapter;
  computer: Computer;
  contextCompiler: ContextCompiler;
  toolRegistry: ToolRegistry;
  policy: RuntimePolicy;
  eventWriter: RunEventWriter;
  assetStore: AssetStore;
  planning?: PlanningService;
  clock: Clock;
  idFactory: IdFactory;
}
```

每个 Run 创建独立 `RunController`。所有运行态字段属于实例，不写入模块级变量。

### 10.2 状态机

```text
created
  ↓ start
starting
  ↓ computer ready + initial observation
running
  ├─ model asks user ─────────→ waiting_user ── resume ─→ running
  ├─ policy needs approval ──→ waiting_approval ───────→ running / finished
  ├─ pause ──────────────────→ paused ───────── resume → running
  ├─ finish requested ───────→ finished
  ├─ cancel / budget / fatal error ───────────────────→ finished
  └─ uncertain side effect ──→ finished(outcome_unknown; unresolved action retained)
```

非法状态转换必须抛出内部错误并写入 `runtime.error`，不能静默修改状态。

### 10.3 单轮流程

```text
1. 检查取消、预算与 Run 状态
2. 若需要，获取最新 ObservationFrame
3. ContextCompiler.compile()
4. ProviderAdapter.generate()
5. 处理 ModelTurn
   ├─ finish
   ├─ user_input_required
   └─ tool_calls
6. 校验并路由 ToolCall
7. 若为 GUI Action：写 started → 执行动作 → 写 completed
8. 获取动作后 ObservationFrame
9. 进入下一轮
```

初始观察和每次 GUI 动作后的观察由 Runtime 自动完成。V1 不默认向模型暴露冗余的 `Observe` 工具。

### 10.4 Finish 处理

模型返回 `finish` 只代表申请结束：

1. Policy 检查是否满足基本结束条件；
2. Runtime 记录最终 Observation 和运行摘要；
3. V1 不额外调用语义 Verifier；
4. 结果标记为模型声称成功，不能冒充外部 Benchmark 官方成功；
5. 将未来官方 Evaluator 结果作为独立评测字段，而非修改历史 Event。

### 10.5 外部输入与每 Run 命令队列

用户回答、过程纠正、审批结果和暂停/继续等外部输入，可能在 Provider 或 Computer
异步调用期间到达。Stage 2 为每个 Run 实现一个内存中的单消费者命令队列，由
`RunController` 串行接收和应用这些命令：

```text
CLI / SDK
    ↓
RunController command inbox
    ↓
append 对应 RuntimeEvent
    ↓
在安全 Turn 边界更新 Snapshot / Context
```

V1 规则：

- 用户输入只有在对应 Event append 成功后才算被 Run 接受；
- `user_input_required` 使 Run 进入 `waiting_user`，收到用户输入后恢复 `running`；
- 用户主动纠正也进入同一个队列，并在下一轮由 `ContextCompiler` 消费；
- 若纠正在 GUI Action started 前到达，尚未执行的旧 ToolCall 必须重新校验或拒绝，
  不能继续执行基于旧指令产生的动作；
- 若 GUI Action 已 started，不能用队列假装撤销副作用；等待 terminal receipt、重新
  Observe，再在下一轮应用纠正；
- cancel 通过根 `AbortController` 发出即时取消信号，不在普通 FIFO 尾部等待。

该命令队列不是 GUI Action 队列。V1 不缓存一批点击等待以后执行；同一
ComputerSession 始终最多执行一个 GUI 副作用，且动作执行前重新验证其 Observation。

命令队列也不是后台 Job 队列。后台工具仍按第十七节的未来协议处理。

## 十一、Runtime Policy、审批与预算

### 11.1 RuntimePolicy

```ts
interface RuntimePolicy {
  evaluateToolCall(context: PolicyContext): Promise<
    | { decision: "allow" }
    | { decision: "require_approval"; reason: string }
    | { decision: "deny"; reason: string }
  >;

  checkBudget(snapshot: RunSnapshot): BudgetDecision;
  canFinish(snapshot: RunSnapshot): FinishDecision;
}
```

### 11.2 V1 策略范围

- `maxSteps`；
- `maxDurationMs`；
- Provider 请求次数或成本预算；
- Tool allowlist；
- 对输入敏感信息、破坏性按键、外部发送和不可逆动作的基础审批；
- 暂停、继续和取消；
- 连续相同动作或连续失败的简单循环保护。

Policy 使用确定性规则为主。不要在 V1 中把 Policy 变成第二个大模型 Agent。

`approval.requested` 必须同时记录 Runtime 生成的 `requestId` 和被审批的
`ToolCallId`。审批不是一个脱离动作的全局布尔值；`approval.resolved` 只能解析当前待定
request。拒绝后为原 ToolCall 产生 rejected ToolResult 并重新规划，不自动取消整个 Run。

## 十二、RuntimeEvent、落盘与崩溃语义

### 12.1 Event 基础字段

```ts
interface RuntimeEventBase {
  eventId: EventId;
  runId: RunId;
  sequence: number;
  occurredAt: string;
  type: string;
}
```

`sequence` 是 Run 内权威顺序；`occurredAt` 用于展示和耗时分析，不用于解决并发顺序。

### 12.2 V1 事件类型

至少包括：

```text
run.created
run.started
computer.open.started
computer.open.completed
observation.created
model.request.started
model.response.received
model.request.failed
tool.call.received
tool.call.rejected
tool.call.completed
tool.call.failed
action.proposed
action.execution.started
action.execution.completed
action.execution.failed
planning.task.updated
approval.requested
approval.resolved
user.input.requested
user.input.received
run.paused
run.resumed
runtime.error
run.finished
```

`computer.open.completed` 持久化 `ComputerSessionDescriptor`（而不只是 Session ID），因此
轨迹可以重建 backend、Viewport 和能力集合；Driver 私有句柄不会进入 RuntimeEvent。

事件类型只有出现明确生产者和消费者时才增加。

`action.proposed` 事件额外携带产生它的 `ToolCallId`；`callId` 属于 Runtime 编排关联，不放入
`ActionIntent`，以保持 Computer 层只表达 GUI 意图。

### 12.3 单写入队列

每个 Run 使用一个 `RunEventWriter`：

- 统一分配连续 sequence；
- 串行 append JSONL；
- append 成功后才允许继续关键副作用；
- 关闭 Run 前 flush；
- Event append 失败被视为致命基础设施错误。

### 12.4 GUI 副作用写前日志

```text
action.proposed
      ↓
确定性校验
      ↓
append action.execution.started 成功
      ↓
真实 driver.execute()
      ↓
append action.execution.completed / failed
```

如果存在 `started` 而没有终态事件：

- 投影状态保留该动作的 `unresolvedActionId`；只有显式的
  `run.finished(outcome_unknown)` 才把 Run 收口为 `outcome_unknown`；
- Runtime 不自动重复执行；
- 恢复时先重新 Observe；
- V1 无法通过观察确认时直接以 `outcome_unknown` 收口，不新增 reconciliation 状态；
- 后续 Verifier 可以辅助判断，但不能改写旧事件。

这一恢复原则属于 V1 架构不变量：

> 对结果未知的 GUI 副作用，默认恢复动作是重新观察，不是重试原动作。

原因是 Driver 调用返回前进程可能崩溃，而真实点击、输入或删除已经发生。盲目重试会把一次不确定副作用扩大成重复副作用。实现时不得为了简化异常处理而删除 `started` 事件、合并 started/completed，或把 `outcome_unknown` 自动转换为 failed。

### 12.5 资产写入顺序

Observation 写入顺序：

1. Driver 返回截图；
2. AssetStore 原子写入临时文件并不可覆盖地发布；
3. 计算并记录资产元数据；
4. append `observation.created`。

崩溃后可能存在未被 Event 引用的孤儿资产，可以离线清理；但不得出现 Event 已引用而文件尚未完整落盘。

## 十三、RunSnapshot 与状态分层

不维护一个混合所有概念的全局 `AppState`。V1 分为三层：

### 13.1 RuntimeEvent：历史事实

- append-only；
- 不原地修改；
- 用于审计、调试和轨迹分析。

### 13.2 RunSnapshot：当前运行状态

由 RuntimeEvent 投影得到，供 Runtime、CLI 和未来 UI 使用：

```ts
interface RunSnapshot {
  runId: RunId;
  status: RunStatus;
  outcome?: RunOutcome;
  stepCount: number;
  modelRequestCount: number;
  latestObservationId?: ObservationId;
  createdAt?: string;
  computerOpenStartedAt?: string;
  computerSession?: ComputerSessionDescriptor;
  pendingApproval?: {
    requestId: string;
    callId: ToolCallId;
    reason: string;
  };
  pendingUserQuestion?: string;
  unresolvedActionId?: ActionId;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
  reportedStatus?: "success" | "failure";
  modelUsage?: ModelUsage;
}
```

投影必须由纯函数 Reducer 完成：

```ts
function reduceRunEvent(
  snapshot: RunSnapshot,
  event: RuntimeEvent,
): RunSnapshot;
```

Reducer 必须满足：

- deterministic：相同初始状态和相同 Event 序列得到完全相同的 Snapshot；
- 无 IO：不读取文件、网络或环境变量；
- 不读取当前时间，所有时间来自 Event；
- 不调用 Provider、Computer、Policy 或随机 ID 生成器；
- 不修改输入对象，返回新的 Snapshot；
- 遇到非法事件顺序时产生明确的投影错误，不私自修正历史事实。

因此任何时候都可以执行：

```ts
const snapshot = events.reduce(reduceRunEvent, initialRunSnapshot);
```

`snapshot.json` 只是这个纯函数结果的缓存。若缓存与 `trajectory.jsonl` 不一致，以重新归约 Event 得到的结果为准。

Snapshot 可以缓存和持久化，但 Event 才是重建依据。

### 13.3 目标应用状态

目标应用的真实状态不能由 Harness 主观维护为权威 `AppState`。V1 只保存：

- 最新和历史 ObservationFrame；
- 可选 Accessibility 数据；
- 模型产生的摘要或 Planning 状态，明确标记为非权威推断。

未来 Dashboard 的展开面板、选中事件、滚动位置等 UIState 完全属于前端，不进入 Runtime 协议。

## 十四、PlanningTask 扩展

Planning 是 V1 可选内置扩展，不是 Run 正常工作的前提。

```ts
interface PlanningTask {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  blockedBy?: string[];
}
```

V1 工具：

- `task_create`；
- `task_update`；
- `task_list`；
- `task_get`。

原则：

- 任务更新先写 `planning.task.updated` Event；
- `tasks.json` 是 Event 投影出的便于查看的物化文件，不是第二权威源；
- 不要求模型在任务开始时生成完整 DAG；
- 简单任务不强制创建 PlanningTask；
- PlanningTask 完成不等于 GUI 用户目标完成。

## 十五、错误模型与恢复策略

### 15.1 归一化错误类别

```text
provider.auth
provider.rate_limit
provider.timeout
provider.invalid_response
tool.unknown
tool.invalid_arguments
action.invalid_frame
action.out_of_bounds
computer.unavailable
computer.session_ended
computer.refused
computer.capture_failed
storage.write_failed
budget.exhausted
run.cancelled
runtime.invariant_violation
```

### 15.2 重试原则

- Provider 限流、短暂网络异常：按 Provider 配置有限重试；
- 模型结构化输出错误：最多一次带 Schema 错误反馈的修复轮；
- 纯观察失败：可有限重试；
- GUI 副作用调用结果未知：禁止自动重试；
- CUA Session ended：Adapter 可以重建连接，但旧 Frame 必须作废，并要求重新 Observe；
- 持久化失败：终止 Run，不继续产生副作用；
- 所有重试次数和原因写入 Event。

禁止按某条具体轨迹文本添加错误补丁。

## 十六、取消、暂停和资源清理

- 每个 Run 创建一个根 `AbortController`；
- Provider 请求、Computer observe/execute 和等待用户输入都接收该 signal；
- CLI 的 Ctrl+C 第一次请求优雅取消，第二次才强制退出；
- 暂停不关闭 Run，但不得继续调用模型或产生 GUI 副作用；
- 结束时按顺序 flush Event、关闭 Computer、释放 Provider/HTTP 资源；
- 清理失败写入诊断日志，但不能覆盖原 RunOutcome；
- 进程收到退出信号后为清理保留有上限的时间。

## 十七、未来兼容原则：Subagent 与后台任务

### 17.1 Subagent

V1 不实现 Subagent，但核心结构必须满足：

- `RunController` 可实例化多次，不是单例；
- 所有状态都带 RunId；
- Provider、Computer、EventStore 和 Policy 通过依赖注入；
- 一个 ComputerSession 同一时刻只能有一个 GUI 动作所有者；
- 未来 GUI Subagent 若并行执行，应分配独立 ComputerSession；
- 只做推理或 Side Tool 的子 Run 才可能与父 Run 并行；
- 未来 Subagent 建模为 child Run，而不是往当前 Prompt 塞一个特殊角色。

V1 不因为未来可能有 child Run 就提前增加没有消费者的 `parentRunId`、Mailbox 或调度器字段。

### 17.2 后台任务

后台任务和 Subagent 不是同一概念。未来后台任务应返回 JobId，并支持查询、等待和取消；V1 不实现 JobStore 或 JobManager。

V1 不为后台任务在 ToolDefinition 或 RuntimeEvent 中预留字段。Provider 调用和 Driver 调用虽然使用 JavaScript async API，但在 Agent 语义上仍然阻塞当前 Run。等第一个真实后台任务出现后，再围绕其 JobId、生命周期和消费者设计协议。

Stage 2 的每 Run 命令队列只负责串行接收用户输入和运行控制，不等同于后台任务
调度器，也不提供 JobId、进度、等待或持久化语义。

## 十八、持久化目录

```text
.gui-harness/
└─ runs/
   └─ <run-id>/
      ├─ manifest.json          # 版本、配置摘要、Provider 和 Computer 信息
      ├─ trajectory.jsonl       # 权威 RuntimeEvent
      ├─ snapshot.json          # 可重建的运行态缓存
      ├─ tasks.json             # 可选 Planning 物化视图
      ├─ assets/
      │  ├─ observations/
      │  └─ provider-debug/     # 默认关闭或脱敏
      └─ result.json            # 最终 Outcome 与统计摘要
```

安全要求：

- API Key 不写入 manifest 或 Event；
- Provider 原始请求/响应默认不完整落盘；
- 截图属于潜在敏感资产，文档和上传流程默认不自动包含；
- 轨迹导出提供显式脱敏步骤；
- 相对路径始终限制在 Run 目录中。

## 十九、配置设计

V1 配置只保留已有消费者的字段：

```ts
interface HarnessConfig {
  provider: ProviderConfig;
  computer: CuaComputerConfig;
  runtime: {
    maxSteps: number;
    maxDurationMs: number;
    contextHistoryLimit: number;
  };
  policy: {
    allowedTools: string[];
    requireApprovalFor: string[];
  };
  trajectory: {
    rootDir: string;
    saveProviderDebug: boolean;
  };
  planning: {
    enabled: boolean;
  };
}
```

不同 Provider 使用 discriminated config，避免把所有厂商参数揉进一个可空字段集合。环境变量只承载 Secret 引用，不把全部产品配置藏进 `.env`。

## 二十、测试策略

### 20.1 单元测试

- 核心 union 的解析和穷尽处理；
- Tool Schema 校验和路由；
- Policy allow/approval/deny；
- Run 状态转换；
- Event sequence 和单写入队列；
- Event → RunSnapshot 的纯函数投影；
- ActionIntent 坐标和 Frame 校验；
- Provider 错误归一化；
- CUA 返回值到核心协议的映射。

### 20.2 契约测试

所有 Provider Adapter 使用同一组契约：

- 图像与文本输入；
- Tool Schema 转换；
- ToolCall ID 保留；
- finish 和 user_input_required；
- 非法 JSON、缺字段、超时、限流和取消；
- 不泄露 Provider 原始对象进入 Runtime。

所有 Computer 实现使用同一组契约：

- open/observe/execute/close；
- Frame ID 与 Viewport；
- 取消；
- 坐标越界；
- Session ended；
- 重连后旧 Frame 失效。

### 20.3 Runtime 集成测试

测试目录可使用 `FakeProvider`、`FakeComputer` 和 `InMemoryEventStore`：

- 初始 Observe 后调用模型；
- 一个动作后的 post-observation；
- 多 GUI Action 被拒绝；
- 用户询问与恢复；
- 审批与拒绝；
- 取消和预算耗尽；
- started 后 Driver 抛错；
- started 后模拟进程中断，投影为 outcome_unknown；
- EventStore 写失败时不执行动作。

Fake 实现只属于测试基础设施，不进入产品 CLI。

### 20.4 真实集成测试

分为三类，不混在普通 CI：

1. Provider Live：固定图片和 Tool Schema，验证真实 API；
2. CUA Live：固定桌面场景，验证截图、点击、输入、DPI 和重连；
3. End-to-End：真实模型在真实应用完成短任务。

真实测试必须保存：Provider、模型名、配置摘要、CUA 版本、OS、DPI、屏幕信息、RunId 和轨迹目录。

## 二十一、施工阶段与门槛

### 阶段 0：CUA 0.22.2 技术探针

产物：

- DPI/截图/坐标实验记录；
- Driver 生命周期和 Session 失效记录；
- 首选运行模式结论；
- 最小调用代码仅保留在 spike 目录。

进入下一阶段门槛：至少完成一次经过授权的
`observe → click/type → observe`，确认完整截图、坐标一致、动作后变化和 daemon
清理。20 轮稳定性测试由 Stage 3 的正式 `CuaDriverComputer` live contract test
承担，不继续扩充一次性 spike。

### 阶段 1：仓库、Protocol 与 Trajectory

产物：

- pnpm workspace；
- protocol 包；
- AssetStore、RunEventWriter、RunSnapshot 投影；
- `user.input.requested/received` 事件及 `pendingUserQuestion` 投影；
- 状态机与错误类型；
- 单元测试。

门槛：Event 序列、写前日志和崩溃投影测试全部通过。

### 阶段 2：最小 Runtime 与测试替身

产物：

- RunController；
- ToolRegistry；
- RuntimePolicy；
- ContextCompiler 默认实现；
- `ToolResult` 以及 `tool.call.completed/failed` 事件；
- 每 Run 单消费者命令队列；
- `submitUserInput`、审批结果和暂停/继续/取消的安全边界处理；
- FakeProvider/FakeComputer 集成测试。

门槛：无需真实模型和桌面即可覆盖完整 Run 生命周期、模型询问用户、用户主动纠正、
审批和主要失败路径；GUI Action started 后到达的纠正不得改写或盲目重试该副作用。

### 阶段 3：CuaDriverComputer

产物：

- CUA Adapter；
- Observation/Action 映射；
- Frame 与坐标校验；
- Live 契约测试。

门槛：真实桌面短任务的底层动作链稳定，Driver 重启后不会复用旧 Frame；在当前
Windows 环境完成 20 轮 `observe → click/type → observe`，无静默裁剪、坐标漂移和
残留 daemon。

### 阶段 4：双模型 Provider 基线

实现两个 Provider Adapter 包和两个当前模型配置：`provider-glm` 支持
`glm-5.3-flash`，`provider-qwen` 支持 `qwen3.8-flash`。两个模型共享完全相同的
Runtime、Context 合同、ToolRegistry、Computer 和 Trajectory。

产物：

- 两个 Provider Adapter；
- 两个模型配置的契约测试；
- 同一组真实 API 固定样例；
- CLI 可选择两个模型运行完整任务。

门槛：两个模型均能生成合法 ModelTurn/ActionIntent 并留存完整轨迹；协议失败、模型能力失败和 fixture
任务失败分开记录。

### 阶段 5：真实任务验证与 Provider-neutral 对照

产物：

- 一组预先冻结、具有外部验收标准的真实任务；本计划暂不指定具体任务内容；
- 两个模型在相同任务、初始环境、Context、Tool、Computer 和预算下的对照记录；
- 外部验收成功、模型提前结束/未完成、步骤数、模型调用数、延迟、Token/图片成本、非法 ToolCall、
  基础设施故障和人工介入报告；
- 以默认 Context 为冻结基线，后续 Context 调整使用独立实验比较。

门槛：任务、环境、Context、Tool、预算和验收器在比较前冻结；GLM 使用当前 profile，Qwen 只改
Adapter，Runtime、Computer、Context 语义和 Tool 代码零修改；完整 Trajectory 足以把失败归入基础设施、
Context、Tool、Provider 协议、模型能力、任务定义或验收器。不得根据单条任务反复给 Prompt 打补丁。

### 阶段 6：Planning、审批和 CLI 完整化

产物：

- 可选 PlanningTask；
- 基础审批交互；
- CLI 中的模型提问、用户回答和主动过程纠正；
- pause/resume/cancel；
- Run 查看与轨迹摘要命令；
- 配置错误提示和使用文档。

门槛：用户可从 CLI 了解当前 Run 状态、待审批动作、最近 Observation 和失败原因，
并能在同一个 Run 中回答模型问题或提交过程纠正。

### 阶段 7：扩大真实任务评测

在阶段 5 的冻结实验合同通过后，再根据已观察到的结果决定是否扩大任务数量和应用覆盖面。扩大前不得
修改原基线任务与验收器；新增任务单独版本化并保留独立结果。具体任务内容在进入本阶段前另行确定，
不在技术计划中提前写死。

每个纳入比较的模型在相同环境重复运行，统计外部验收成功率、步骤数、耗时、模型调用次数、图像输入
量、人工接管次数和失败类型。若样本扩充没有改变主要失败机制或模型排序，则停止扩样，转入针对已证实
瓶颈的独立实验。

## 二十二、V1 完成标准

同时满足以下条件才视为 V1 完成：

1. `provider-glm` 的 profile 抽象（当前生产模型为 `glm-5.3-flash`）和 `provider-qwen` 的 Qwen3.8-Flash 在不修改 Runtime 的情况下运行；
2. `CuaDriverComputer` 是唯一底层依赖入口，Runtime 不引用 CUA 专用类型；
3. 除 wait 外，每个 GUI 输入动作都能追溯到 ObservationFrame；
4. 每个 GUI 副作用都有 started 和 completed/failed，缺失终态时可识别 outcome_unknown；
5. 取消、暂停、审批、步数和时长预算可实际触发；
6. 任意一次 Run 可仅凭轨迹文件重建其运行流程和最终状态；
7. 一组冻结且具有外部验收标准的真实任务完成端到端运行并形成可比较报告；
8. Provider、Driver 和 EventStore 失败不会抹掉已写入事实；
9. 敏感配置不进入轨迹，截图导出需显式操作；
10. README 能让另一名成员在干净环境中完成安装、配置和首个任务。

## 二十三、需要用实验决定而非提前争论的事项

以下事项暂不写死为长期架构结论：

- 两个当前模型中哪个适合作为默认模型；
- CUA 首选 direct 还是 private-worker；
- 默认保留几轮历史事件和几张历史截图；
- 是否需要把 Accessibility 数据默认加入 Context；
- 哪些 GUI 动作默认需要审批；
- PlanningTask 对实际长任务是否有净收益；
- 是否需要在 V1 后加入独立 Verifier；
- LightSpeaker 是作为 Runtime Extension、Observer 还是上层产品适配。

这些问题分别由 Provider 契约实验、CUA 技术探针、上下文消融实验、风险测试和真实任务结果决定。没有证据前不增加新的核心对象。

## 二十四、第一轮施工任务清单

在开始大规模编码前，第一轮只完成以下可验证任务：

1. 建立新仓库和 pnpm workspace；
2. 固定 Node、TypeScript、Vitest、Zod 和 CUA 版本；
3. 完成 CUA 0.22.2 Windows 技术探针；
4. 定稿 protocol 中的七个核心对象与 RuntimeEvent；
5. 实现 JSONL EventWriter、AssetStore 和 RunSnapshot 投影；
6. 用 FakeComputer 跑通写前日志和 outcome_unknown；
7. 用 FakeProvider 跑通 ModelTurn、ToolCall 和单动作约束；
8. 评审后再进入真实 Provider 与正式 CUA Adapter 实现。

第一轮不创建 Subagent、后台 Job、Verifier、Dashboard、ReplayComputer 或复杂 Context 压缩模块，也不为这些未实现能力提前固化协议字段。

# 多模态 GUI Agent Harness 产品与架构基线

版本：V1 工程基线 / 后续演进路线
日期：2026-09-15
文档角色：全局设计
状态：当前有效
当前入口：[Stage 6 收敛与下一阶段起始状态](./stage-6-convergence-and-start-state-2026-09-15.md)

## 一、产品定位

Computer Harness 是一个独立、Provider-neutral、GUI-native 的多模态 Agent Runtime。它位于多模态模型与 Computer Backend 之间，统一管理：

- Run 与 ComputerSession 生命周期；
- Observation、ModelTurn、ToolCall、Action 和 Receipt；
- Context 编译与工具投影；
- GUI 副作用执行、预算、Approval、Abort 和用户纠正；
- RuntimeEvent、RunSnapshot、Trajectory 与检查式 Replay；
- 可插拔 Planning、Run Memory 和受限 Action Batch。

Harness 不依赖 OpenClaw 等完整 Agent 产品，不训练基础模型，也不重新实现操作系统鼠标、键盘和截图 Driver。底层目前支持 CUA Driver 与 OSWorld DesktopEnv Bridge；上层目前支持 GLM-5.3-Flash 与 Qwen3.8-Flash。

长期产品形态接近 GUI Agent 领域的 Claude Code/Codex：开发者可以替换 Provider、Computer Backend 和 Context 策略，同时继续复用同一 Agent Loop、工具合同、执行安全和轨迹语义。

## 二、当前优先级

### 当前正在完成

1. 冻结 OSWorld Development/Validation 任务、evaluator、预算、快照和运行配置；
2. 对 Context、Planning、Run Memory 和 Action Batch 做独立消融；
3. 在独立开关下实现并验证最小 Risk Guard。

### Risk Guard 之后

停止继续增加新功能，聚焦真实 CUA 使用体验：

- 截图完整性、viewport 与坐标一致性；
- 窗口、焦点、弹窗和多显示器状态；
- click/type/hotkey/scroll/drag 可靠性；
- session、daemon、断连、超时和恢复；
- Abort、人工接管、未知副作用和错误诊断；
- Context、截图、模型请求和动作链延迟；
- CLI、SDK、部署和轨迹检查体验。

### 长期保留但非当前最高优先级

- 跨 Run Episodic/Semantic/Visual Memory；
- Advisory Subagent；
- Sandbox / ExecutionEnvironment；
- 具备独立 ComputerSession 的 Execution Subagent；
- 专用 Risk Model、按需 Verifier、Cache 和更复杂 Context Compression。

这些方向仍是产品演进空间，但不能提前成为当前 Runtime 的必要依赖。

## 三、产品边界

### Harness 负责

- GUI-native Observe → Decide → Act → Observe 循环；
- Provider 与 Computer Backend 适配；
- ToolRegistry 和统一 ToolCall 路由；
- ActionIntent 的确定性校验与执行；
- Event-first 副作用记录；
- Run 内 Context、Planning、Memory 和控制；
- 可观察、可检查、可评测的 Trajectory；
- 风险策略和无障碍 Approval 的宿主接口。

### 当前不负责

- 自研多模态基础模型或操作系统 Driver；
- 默认逐动作调用第二个模型进行 Verify；
- 在不可重置真实桌面上承诺确定性动作重放；
- 多 Agent 同时操作同一 Desktop；
- 通用 Workflow DSL、分布式 Worker 或企业自动化平台；
- 把模型声明的完成状态当作 benchmark 成功真值。

## 四、稳定架构原则

1. **ToolRegistry 是唯一工具来源。** Context 和 Provider 都从本轮 Registry 投影工具，不维护第二份清单。
2. **Provider 与 Computer 正交。** Provider 只负责模型协议；Computer Adapter 只负责观察和执行。
3. **ToolCall 与 ActionIntent 分层。** 只有 Computer ToolCall 转换为 ActionIntent；Planning、Memory 和 Control 走各自执行路径。
4. **Trajectory 是权威事实。** RunSnapshot、PlanState 和 MemoryState 都由 RuntimeEvent 确定性投影。
5. **先记录再产生副作用。** `action.execution.started` 持久化成功后才能调用 Computer。
6. **未知副作用不自动重试。** started 后没有终态表示 `outcome_unknown`，默认重新观察或请求人工处理。
7. **每个字段必须被维护。** 公共字段必须有生产者、消费者、更新、失效和清理规则。
8. **功能可关闭。** Planning、Memory、Batch 和后续 Guard 关闭时不得残留工具、Prompt、Context 或额外模型调用。
9. **工程通过不等于效果成立。** 可插拔模块必须通过固定任务和指标消融决定是否默认启用。

## 五、当前核心协议

### 5.1 Run 与 RunOutcome

一个 Run 对应一个用户目标从创建到结束的完整执行，包含多个 ModelTurn、ToolCall、Observation 和 Action。

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

### 5.2 ComputerSession

`ComputerSessionDescriptor` 是 Runtime 可持久化的当前 GUI 世界描述：

```ts
interface ComputerSessionDescriptor {
  id: ComputerSessionId;
  backend: string;
  viewport: Viewport;
  capabilities: ComputerCapabilities;
  openedAt: string;
}
```

Driver handle、CUA frame ref、Bridge client 等私有对象只保存在 Adapter 内。

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

当前公共协议不包含 window、element 或 Accessibility payload；这些能力出现真实生产者和消费者后再扩展。

### 5.4 ModelTurn 与 ToolCall

```ts
type ModelTurn =
  | {
      type: "tool_calls";
      calls: ToolCall[];
      assistantText?: string;
      continuation?: ModelContinuation;
      usage?: ModelUsage;
    }
  | {
      type: "user_input_required";
      question: string;
      usage?: ModelUsage;
    }
  | {
      type: "finish";
      summary: string;
      reportedStatus?: "success" | "failure";
      usage?: ModelUsage;
    };
```

Provider 原始 Function Calling、strict JSON 或 reasoning continuation 都在 Adapter 边界转换为该协议。Qwen `strict_json` 当前统一使用固定 `calls[]` wire envelope。

### 5.5 ActionIntent 与 ActionReceipt

当前 ActionIntent 支持：

- click、double_click、right_click；
- type、keypress；
- scroll、drag；
- wait。

除 wait 外，每个 GUI Action 都由 Runtime 注入 `basedOn: ObservationId`。当前动作目标是点坐标或动作自身参数，不公开尚未实现的 window/element target。

```ts
interface ActionReceipt {
  actionId: ActionId;
  status: "completed" | "refused" | "failed" | "cancelled";
  driverCode?: string;
  message?: string;
}
```

Receipt 只说明 Driver 执行结果，不证明用户目标完成。

### 5.6 RuntimeEvent 与 RunSnapshot

当前事件包括：

```text
run.created / run.started / run.finished
computer.open.started / computer.open.completed
observation.created
model.request.started / model.response.received / model.request.failed
tool.call.received / tool.call.rejected / tool.call.completed / tool.call.failed
action.proposed / action.execution.started
action.execution.completed / action.execution.failed
planning.task.updated
memory.updated
approval.requested / approval.resolved
user.input.requested / user.input.received
run.paused / run.resumed
runtime.error
```

Reducer 必须保持纯函数、确定性、无 I/O。`events.reduce(reducer, initialSnapshot)` 应能重建当前 RunSnapshot。

## 六、当前模块关系

```text
CLI / SDK
   │
   ▼
RunController
   ├─ CommandInbox：用户输入、暂停、恢复、Abort、审批
   ├─ RuntimePolicy：预算与 ToolCall 准入
   ├─ ToolRegistry
   │    ├─ Computer Tools → ActionIntent
   │    ├─ Planning Tools → planning.task.updated
   │    ├─ Memory Tools   → memory.updated
   │    └─ Control Tools  → finish / user_input_required
   ├─ ContextCompiler
   ├─ ProviderAdapter：GLM / Qwen
   ├─ Computer：CUA / OSWorld
   └─ EventWriter → Reducer → RunSnapshot
```

ContextCompiler 消费 Goal、最新 Observation、选定历史事件、PlanState、MemoryState、功能开关和当前工具投影；Provider 只消费最终 ModelInput。

## 七、可插拔模块的当前语义

### 7.1 Context

当前提供：

- `raw`：保留完整可投影事件；
- `recent`：保留最近若干闭合的 ModelTurn/ToolResult 与用户纠正；
- 文本/工具的近似 token 预算；
- 当前截图；
- 可选 Plan 和 Memory 投影。

当前没有 Visual Keyframe、Action Summary、语义 Compression、向量 Retrieval 或 Prompt Cache 调度。它们是后续实验候选。

### 7.2 Planning

```ts
interface PlanningTask {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  blockedBy?: string[];
}
```

Planning 是模型主动调用的阶段状态，不是固定 DAG，也不是 GUI 成功真值。工具包括 `task_create`、`task_update`、`task_list` 和 `task_get`。

### 7.3 Run Memory

当前 Memory 只在本 Run 内保存未来步骤仍需使用的事实和对象：

- 顶层 MemoryFact；
- 可选 MemoryEntity；
- active、needs_check、superseded、stale 状态；
- 与 Planning task 的可选关联；
- bounded、deterministic 的 index/hot recall；
- `memory.updated` Event 与 RunSnapshot 投影。

它不是跨 Run 用户画像，也不是从历史 Run 自动抽取的 Episodic Memory。

### 7.4 Action Batch

当前 Batch 只允许面向同一文本控件输入的三种调用形状：

```text
click → type
Ctrl+A → type
click → Ctrl+A → type
```

一个 ModelTurn 还可在 GUI 序列前包含最多两个 Planning/Memory 写调用。读取工具、Control、Enter、Tab、提交、导航、scroll、drag、wait 不能混入 Batch。Runtime 对每个 primitive 分别校验、记 Event、执行、生成 Receipt 和重新观察；失败、Abort 或采图失败立即停止后缀。

Runtime 当前能确定性验证调用顺序、参数、capability、viewport 和 Observation 新鲜度，但没有 element identity，不能证明 click 与后续 type 语义上确属同一个控件。“同一控件”是模型协议和受控实验假设，不得写成已由程序强制验证。

## 八、Provider 与 Computer

### Provider

- GLM 使用原生 Tool Calling；
- Qwen 默认使用固定 `calls[]` strict JSON，并保留 native-tools 作为兼容性回归；
- 两者都从同一个 ToolRegistry 接收工具；
- 坐标格式差异只在 Provider Adapter 边界转换；
- Provider 格式错误、网络错误与 Runtime 拒绝分别记录。

### Computer

- `CuaDriverComputer`：本机/宿主桌面路线；
- `OsworldComputer`：OSWorld DesktopEnv Bridge 路线。

Computer Adapter 消费统一 ActionIntent、返回 ActionReceipt 和 ObservationCapture。Benchmark reset/evaluate 属于外层 Environment/Runner，不反向进入核心 Agent Loop。

## 九、Risk Guard 的下一阶段位置

当前实现：主模型在同轮为每个 Computer 调用附带预期效果声明；GLM 原生工具和 Qwen flat calls[] 经共享参数投影携带声明，解码为 ToolCall 元数据，不能传入 Computer 执行参数。Router 按本轮声明分流：高危直接审批、低风险按策略放行、明确宿主禁令拒绝，仅高危歧义按需复核。Goal 是授权背景，不是全程复核开关；本轮不以 OCR/Accessibility 为前提。工程回归与首轮无桌面真实 GLM/Qwen 协议探针已通过；真实 CUA 安全效果和统计稳定性未验证。模型声明可能漏报，不能视为安全证明。具体协议、验证证据和限制以 [Risk Guard 实施计划](./risk-guard-implementation-plan-2026-09-15.md) 为准。

最小 Risk Guard 复用现有 RuntimePolicy/Approval 主链，但当前 `evaluateToolCall` 只有 ToolCall、ToolDefinition 和 RunSnapshot，不能直接完成 GUI 语义判断。实施时需要在 canonical ActionIntent 形成后、`action.execution.started` 之前增加明确的 action-level policy context；该 context 只引用已有 Goal、最新 Observation、Plan/Memory 和 Action，不复制状态。

```text
ToolCall / Action or Batch
      + current Observation
      + Goal / Plan / Run constraints
      + relevant Run Memory
              ↓
      allow | require_approval | deny
```

第一版必须：

- 使用独立开关，关闭后保持基线；
- 复用现有 Approval、Inbox、Event、Abort 和预算；
- 为新增 action-level policy 输入逐项指定现有生产者和消费点；
- 对提交、删除、发送、支付、权限/隐私修改等风险边界拆分 Batch；
- 区分确定性规则与需要语义证据的判断；
- 不默认对每个普通点击调用第二个模型；
- 记录误拦截、漏检、确认次数、额外延迟与任务成功率。

Risk Guard 的详细合同应由独立实施计划定义，不能仅凭 Action 坐标推断业务风险。

## 十、长期演进方向

### 跨 Run Memory

从经过筛选的 Trajectory 构造 Episodic/Semantic/Visual Memory，用于复用历史经验。它需要独立的生命周期、隐私、检索、失效和评测设计，不与当前 Run Memory 混为一体。

### Advisory Subagent

作为主 Agent 的显式工具，拥有独立上下文和受限只读权限，返回 Advice 而不直接控制当前 ComputerSession。未来可承担 Visual、Recovery、Planning 或 Risk 建议。

### Sandbox / ExecutionEnvironment

将 Host、Restricted Host、VM、OSWorld、Remote Environment 表达为 ComputerSession 的运行边界，并在未来覆盖 Computer、Code Runtime、Workspace、Network 和 Credentials。

### Execution Subagent

只有具备多个隔离 ComputerSession 和明确 ownership 后才考虑。多个 Agent 不得并发控制同一桌面。

这些设计继续保留，但在 Risk Guard 和 CUA 体验阶段完成前不进入当前施工主线。

## 十一、当前工程结构

```text
apps/cli
packages/protocol
packages/trajectory
packages/runtime
packages/context
packages/planning
packages/memory
packages/provider-glm
packages/provider-qwen
packages/computer-cua
packages/computer-osworld
integrations/osworld
scripts/stage4-local
scripts/stage5-osworld
```

不为尚无消费者的长期模块创建空包。

## 十二、验证与成功标准

### 工程基线已满足

- 两个 Provider 消费同一 Runtime 和 ToolRegistry；
- 两个 Computer Backend 消费同一 ActionIntent；
- Event/Reducer、Abort、Approval、用户纠正和未知副作用链路已建立；
- Context、Planning、Memory、Batch 可独立启停；
- API conformance 和双 fake backend fixture 已通过。

### 尚需实验回答

- Context、Planning、Fact/Entity Memory、Batch 是否在固定任务集上产生净收益；
- Qwen 格式偏离和网络延迟对真实成功率的影响；
- Risk Guard 是否降低高风险/意图偏离行为且不过度确认；
- CUA 在真实任务中的稳定性、延迟和跨平台体验；
- 哪些模块应默认启用，哪些只保留接口。

项目最终追求的不是功能数量，而是一套 **GUI-native、Provider-neutral、Computer-neutral、Context-extensible、Observable、Controllable、Inspectable** 的 Agent Runtime。

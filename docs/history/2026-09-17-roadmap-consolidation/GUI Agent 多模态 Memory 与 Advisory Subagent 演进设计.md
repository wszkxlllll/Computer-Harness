# GUI Agent Run Memory 与长期 Memory / Advisory Subagent 演进设计

日期：2026-09-15
文档角色：当前模块说明 / 长期设计
状态：Run Memory 当前有效；长期 Memory 与 Advisory 保留但非当前最高优先级
当前入口：[Stage 6 收敛与下一阶段起始状态](../../stage-6-convergence-and-start-state-2026-09-15.md)

## 一、先区分四种状态

### Trajectory

Trajectory 保存完整运行事实：Observation、ModelTurn、ToolCall、ActionIntent、ActionReceipt、Planning/Memory mutation、错误和用户输入。它不因 Context 裁剪或模型重新解释而修改。

### RunSnapshot

RunSnapshot 是 RuntimeEvent 经纯 Reducer 得到的当前状态投影，包括 RunStatus、预算计数、PlanState、MemoryState、待审批和待回答问题。它可由 Trajectory 重建。

### Run Memory

Run Memory 保存当前 Run 后续步骤仍需要、但可能离开近期 Context 的少量事实和对象。它已经实现，可通过工具写入、更新、读取和失效。

### Context

Context 是某个 ModelTurn 真正发送给模型的信息视图。ContextCompiler 从 Goal、历史事件、当前 Observation、PlanState、Run Memory 和 ToolRegistry 选择内容；Context 不是持久化事实源。

关系如下：

```text
RuntimeEvent → Reducer → RunSnapshot
     │                       ├─ PlanState
     │                       └─ Run Memory
     └─完整 Trajectory

RunSnapshot + selected history + latest Observation + ToolRegistry
                              ↓
                       ContextCompiler
                              ↓
                         ModelInput
```

## 二、当前 Run Memory 数据结构

### 2.1 Fact

```ts
interface MemoryFact {
  id: string;
  subject: { type: "run" } | { type: "entity"; entityId: string };
  key: string;
  value: string;
  sourceEventId: EventId;
  status: "active" | "needs_check" | "superseded";
  relatedTaskIds?: string[];
  updatedSequence: number;
}
```

Fact 用于记录本 Run 后续仍需使用的稳定事实，例如目标文件、用户约束、已选择对象或需要复核的状态。它不记录每个点击，也不复制 Task 进度。

### 2.2 Entity

```ts
interface MemoryEntity {
  id: string;
  type: string;
  description: string;
  sourceEventId: EventId;
  status: "active" | "stale" | "superseded";
  relatedTaskIds?: string[];
  updatedSequence: number;
}
```

Entity 表示在多个阶段之间需要保持 identity 的 GUI 对象，例如文件、文档、窗口、表单或订单。对象的可变属性仍保存为顶层 Fact，并通过 `subject.entityId` 关联，避免 Entity 内再维护第二份 facts。

`sourceEventId` 追踪该状态由哪次 Runtime 事实提交产生，不要求对应当前 Observation，也不用于阻止下一轮读写。GUI 变化导致事实不再可信时，应标记 `needs_check`、`stale` 或 `superseded`。

### 2.3 State 与 Mutation

```ts
interface MemoryState {
  runId: RunId;
  facts: MemoryFact[];
  entities: MemoryEntity[];
}

type MemoryMutation =
  | { operation: "upsert_fact"; fact: MemoryFact }
  | { operation: "supersede_fact"; factId: string; replacement?: MemoryFact }
  | { operation: "mark_fact_needs_check"; factId: string }
  | { operation: "upsert_entity"; entity: MemoryEntity }
  | { operation: "invalidate_entity"; entityId: string };
```

Memory mutation 先写入 `memory.updated` Event，再由同一个 Reducer 更新 RunSnapshot；FileMemoryStore 是物化结果，不是第二个权威源。

## 三、当前 Memory 工具

Fact 模式暴露：

- `memory_get`；
- `memory_write_fact`；
- `memory_mark_fact_needs_check`。

Entity 模式在此基础上增加：

- `memory_upsert_entity`；
- `memory_list`；
- `memory_invalidate_entity`。

模型可以在同一个 ModelTurn 中返回多个独立 Memory/Planning 写调用，也可以把最多两个状态写调用放在一个 GUI Action/受限 Batch 之前。需要读取刚写入结果时必须等待下一轮，因为同一 ModelTurn 的后一个调用看不到前一个 ToolResult。

Memory 关闭时：

- Registry 不暴露 Memory 工具；
- system prompt 不注入 Memory 指导；
- Context 不注入 Memory；
- Runtime 不接受 Memory mutation；
- 不产生额外模型请求或跨 Run 状态。

## 四、当前召回算法

Run Memory 不需要额外模型调用。ContextCompiler 每轮执行 bounded、deterministic 选择：

1. 过滤 active/needs_check Facts 和 active Entities；
2. 若 Planning 开启，按 in_progress、pending、blocked、completed 的相关性排序；
3. 无 Planning 时回退到状态与 updatedSequence；
4. 优先保留被选中 Fact 引用的 Entity；
5. 生成紧凑 index；
6. 展开少量 hot Facts/Entities；
7. 被 superseded 或 stale 的内容不进入正常召回。

默认上限当前是：

- index Facts：20；
- index Entities：10；
- hot Facts：8；
- hot Entities：4。

召回结果只是模型输入，不证明 GUI 当前状态。`needs_check` 明确提示模型需要重新观察或验证。

## 五、当前 Memory 的限制

- 只服务当前 Run；
- 不自动从 Trajectory 抽取事实；
- 没有向量检索、Embedding 或视觉 RAG；
- 没有跨 Run 用户画像；
- 没有自动 consolidation；
- 没有 ROI 或长期 Screenshot 记忆；
- 尚未通过固定任务消融证明净收益。

因此当前开发重点是比较 Fact、Entity 与关闭 Memory 时的 Task Success、Context Size、Tokens、Latency、Memory Ops、错误事实和恢复率，而不是继续增加复杂层次。

## 六、长期多模态 Memory

长期 Memory 仍在产品考虑范围内，但排在 Risk Guard 与 CUA 体验优化之后。它与当前 Run Memory 使用不同生命周期和风险模型。

### Episodic Memory

从经过筛选的历史 Run 中保存任务、关键阶段、失败/恢复经验、Outcome 和少量关键视觉证据，回答“过去是否处理过类似任务”。

### Semantic Memory

从多个 Episode 中提炼相对稳定的应用知识、菜单结构、快捷键和工作流程。它必须允许版本化、冲突、过期和来源追踪。

### Visual / ROI Memory

保存经过选择和脱敏的关键 Frame 或局部区域。历史绝对坐标不能直接复用；新任务仍需在最新 Observation 上重新 grounding。

### 必要前置

- 当前 Run Memory 和 Context 消融表明确；
- 有足够、可复现的真实 Trajectory；
- 定义跨 Run identity、来源、置信、失效和删除；
- 建立 Screenshot/ROI 隐私、授权和生命周期；
- 单独统计检索命中、错误召回、额外 token/延迟和成功率。

长期 Memory 不应成为 Risk Guard 或 CUA 稳定性修复的前置依赖。

## 七、Advisory Subagent

Advisory Subagent 也继续保留，但不是当前最高优先级。第一形态应是主 Agent 显式调用的工具：

```text
Main Agent
   → consult_advisor(question, evidence scope)
   → 独立、受限 Context
   → Advice ToolResult
   → 下一轮 Main Agent 决定是否采用
```

约束：

- Advisor 不直接拥有当前 ComputerSession 的 GUI 执行权；
- 只读取显式授权的 Goal、Task、Observation、近期 Event 或 Memory；
- Advice 是建议，不是 Runtime 事实或用户批准；
- 子模型调用必须纳入预算、Abort、延迟和 Event；
- 第一版父 Run 阻塞等待结果，不先实现后台 Job；
- Monitor 不自动调度第二个模型；主 Agent决定是否调用。

未来可研究 Visual、Recovery、Planning、Experience 和 Risk Advisor，但应先用一个通用 Advisor 验证净收益。

## 八、并发与 Execution Subagent

多个 Advisor 可以在未来并行推理，但 GUI 副作用必须保持串行。真正 Execution Subagent 需要：

- 独立 ComputerSession 或可重置隔离环境；
- 明确的 ownership、lease、Abort 和 cleanup；
- 不共享焦点、鼠标、键盘和窗口状态；
- Task delegation、结果回传和冲突处理；
- 对后台任务的 Job/Event/Context 语义。

在这些条件满足前，不能让多个 Agent 并发操作同一桌面。

## 九、Sandbox / ExecutionEnvironment

Sandbox 仍是长期产品方向。它不是危险动作发生后临时切换的工具，而是 ComputerSession 的运行边界：

```text
ExecutionEnvironment
  ├─ Host
  ├─ Restricted Host
  ├─ VM / OSWorld
  └─ Remote Environment
```

未来若支持 code execution，隔离范围应同时考虑 Computer、Code Runtime、Workspace、Network 和 Credentials。当前 OSWorld 是外层 Environment/Runner 集成，不等于已经完成统一 Sandbox 抽象。

## 十、演进顺序

```text
当前 Run Memory / Context / Planning / Batch 消融
                  +
             最小 Risk Guard
                    ↓
               功能冻结
                    ↓
          真实 CUA 体验与稳定性
                    ↓
      跨 Run Memory / Advisory 研究
                    ↓
  Sandbox / Execution Subagent / Agent Team
```

长期能力保留明确接口方向，但只有出现真实生产者、消费者和第二种实现时才进入公共协议。

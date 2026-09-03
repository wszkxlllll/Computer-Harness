# Runtime / Trajectory / CUA Adapter / Provider 复审与优先级

日期：2026-09-02  
文档角色：审计  
状态：当前执行  
当前入口：[Stage 4 实施入口](../stage-4-implementation-entry.md)  
审计基线：当前工作树；`HEAD=a344c50`，Runtime/Trajectory 核心提交为 `f82a701`  
范围：`packages/trajectory`、`packages/runtime`、`packages/computer-cua`、`packages/provider-qwen`、`packages/provider-glm`；只审计共享机制，不针对单条轨迹改 Prompt。

## 1. 总结论

原审计的主要方向成立，但优先级混入了三类不同事项：

1. **已确认且会破坏运行事实或正式评测有效性的缺陷**；
2. **进入 V1 验收或扩大实验前应补齐的合同**；
3. **当前明确接受的 V1 边界或未来扩展能力**。

复核后确认 **4 项 P0 已闭环**：P0-1、P0-3、P0-4 的代码与测试已通过，P0-3 的真实两轮 conformance 成功；
P0-2 的坐标诊断已完成并得到 GUI-Plus 负向结论。GLM 可以进入下一阶段，GUI-Plus 保留为基线，新的 Qwen
候选单独实验。另有 7 项 P1、7 组 P2；P1 不必挡住小规模诊断，但应在 V1 验收或扩大数据收集前关闭。

本轮同时更正四点：

- Trajectory 当前是 **30 项测试**；全仓库实际为 **8 个测试文件、104/104 通过**。
- 没有 `fsync` 与“不能续写已有 Run”是产品计划已经接受的 V1 边界，不应列成当前缺陷。
- `glm-4.6v-flash` 已从现行代码、CLI、API conformance runner 和 Stage 4 任务 manifest 清理；历史实验文档仍保留作为不可变证据。
- CUA 提供的字段不等于都应进入 Harness 公共协议。只有存在明确生产者、消费者和决策用途的最小语义才应进入协议。

优先级定义：

| 级别 | 含义 |
|---|---|
| P0 | 破坏权威事实链，或使当前正式 Provider 评测无法公平归因；先修后评测 |
| P1 | 小规模诊断可继续，但 V1 验收、扩大实验或协议冻结前必须完成 |
| P2 | 已知质量债、可观测性增强或未来能力；有真实消费者/触发条件后实施 |

### 1.1 当前模型范围清理记录（2026-09-02）

本轮仅清理现行执行面：`glm-4.6v-flash` 已从 `packages/provider-glm` 的 profile、CLI 模型校验、
API conformance runner、Stage 4 runner 参数和活动任务 manifest 移除；当前可执行模型为
`glm-5.3-flash` 与 `gui-plus-2026-02-26`。旧实验结果、协议探针和审计中的 4.6V 记录属于历史证据，
不改写、不覆盖，也不再被新的 runner 读取。这样既避免孤立生产代码，也保留了结果可追溯性。

## 2. P0：正式评测前必须修复

### P0-1 动作后观察失败会留下没有终态的 ToolCall

**整改状态（2026-09-03）：已关闭。** `RunController.executeComputerCall()` 已改为先提交 Action/ToolCall
终态，再执行 post-action Observe；定向测试证明 Observe 失败后 Run 为 failed、动作只执行一次且事实链完整。
以下保留原问题机制作为审计依据。原顺序为：

```text
action.execution.completed / failed
  → observeAndCommit()
  → tool.call.completed / failed
```

如果 Driver 已返回确定的 `ActionReceipt`，但动作后的 `observe()` 失败，轨迹会出现：

```text
tool.call.received
action.proposed
action.execution.started
action.execution.completed / failed
run.finished(failed)
```

对应 `tool.call.completed/failed/rejected` 缺失。Action 已经有终态，不能把它改写成
`outcome_unknown`；但 ToolCall 也不能永久悬空。

**影响：** 仅凭 EventStream 无法完整重建 ToolCall 生命周期，违反“轨迹是权威事实”的 V1 完成标准。现有测试只覆盖初始观察失败，没有覆盖“动作成功、第二次观察失败”。

**最小修复原则：**

1. 收到确定 `ActionReceipt` 后，先提交 Action 终态和对应 ToolCall 终态；
2. 再做动作后观察；
3. 观察失败单独写已有的 `runtime.error` 并使 Run 失败，不反向篡改 Action/ToolCall 事实；
4. 只有 Driver 调用本身未能证明副作用结果时，才保留 `outcome_unknown`。

**验收：** FakeComputer 首次观察成功、动作返回 completed、第二次观察抛错；最终必须同时存在 Action 终态、ToolCall 终态、观察错误和 `run.finished(failed)`，且不能重放动作。

### P0-2 Qwen 的正式 Function Calling 坐标模式尚未冻结

**整改状态（2026-09-03）：诊断已完成，作为负向结果关闭。** `actual_pixels` evaluator 0/3 且全部
budget exhausted；`normalized_1000` paired evaluator 0/3，连同 attended smoke 累计 1/4。normalized 能进入编辑区，
但重复输入、全选失败和 false-positive finish 表明问题不只来自坐标。GUI-Plus 不冻结为生产默认，保留为负向基线。

阿里云模型页将
`gui-plus-2026-02-26` 标为支持 Function Calling。当前 Adapter 使用 `tools` 字段并读取
`message.tool_calls`，需要在同一 Function Calling wire 下比较两种坐标表示：实际像素和 0--1000
归一化。单一 `computer_use(action=...)` 的生产呈现已在工作树改为 per-tool Function Schema：

- 每个本轮可用 Runtime 工具独立出现在 `tools[].function`；
- `terminate`/`interact` 作为明确的控制函数，不再塞进动作参数的 `action` 枚举；
- `scroll`/`drag` 等 Runtime 动作可以按工具集合被完整呈现；
- Parser 仍只接受原生 `message.tool_calls`，并在进入 Runtime 前拒绝未提供的函数名。

真实 API conformance 已证明当前 Workspace 接受这套 per-tool Function Calling：在脱敏合成图片上，Qwen
`gui-plus-2026-02-26` 连续两轮均返回 HTTP 200、`finish_reason=tool_calls` 和一个原生 `click` ToolCall；
Adapter 将 GUI-Plus 返回的 `coordinate: [x, y]` 严格转换为 Harness 像素坐标。证据位于
`runs/api-conformance/function-schema-live-20260903/summary.json`，不包含真实桌面操作。该结果只关闭“请求/响应
协议能否跑通”，没有选择 actual-pixels 或 normalized-1000 的任务效果默认；正式本地任务中 Qwen 只有 1/3 外部
验收通过，仍不能归因成模型能力上限。

官方依据：

- [gui-plus 模型信息](https://help.aliyun.com/zh/model-studio/gui-plus)
- [GUI 自动化指南](https://help.aliyun.com/zh/model-studio/gui-automation)
- [GUI-Plus API 参考](https://help.aliyun.com/zh/model-studio/gui-plus-interface-interaction-model)

该 API 参考明确给出 GUI-Plus 参数名：`coordinate` 是二元坐标数组，`pixels` 是滚动量（正值向上、负值向下），
`time` 是等待秒数，`status` 只用于 `terminate`。因此 Qwen Adapter 采用这些 provider-native 字段，再在边界
映射为 Harness 的 `x/y`、`fromX/fromY/toX/toY`、`direction/ticks` 与 `durationMs`；这不是把 Qwen 字段泄漏到
Runtime，而是协议适配的单一职责。

**最小实验原则：** 不用正则“修补”损坏 JSON，也不同时改变任务、历史窗口或 Prompt。保留当前
Function Calling 结构，固定 endpoint、模型快照、System Prompt、工具集合、输出解析和历史回放方式，
仅切换坐标模式后做 paired run，再选择正式坐标模式。

**验收：** 同一冻结环境、同一任务和同一预算下，两种坐标模式都能保存脱敏后的实际请求/响应、严格解析
结果、坐标转换诊断和外部 evaluator 结果；最终只保留有证据支持的默认坐标模式。

### P0-4 Function Calling Schema 的条件约束（由原 P1-7 升级）

**整改已完成，提交为 `c2b4a19`。静态质量门通过；真实 API conformance 已证明两轮 `click` Function Calling
握手可用，但没有逐项实测全部工具。** Qwen 现按 Runtime 工具逐个生成 Function Schema；
GLM 保持同一逐工具映射。两者都携带字段级 `required`/description；归一化坐标用 Schema 数值边界约束，
Qwen 的实际像素二元数组则由描述提示 x/y 上限、由 Parser 和 Runtime 确定性校验。Qwen Adapter 使用模型
熟悉的 `coordinate`、`coordinate2`、`pixels`、`time`，并增加 Harness 水平滚动所需的 `direction`，再在
Adapter 边界转换为 Runtime canonical 参数；`direction` 不是官方 GUI-Plus 原生字段。

**原则：** Function Calling Schema 只提供生成约束，不能替代 Runtime 校验。任何 Provider 返回仍必须经过
严格解析、工具存在性检查、参数校验和 Policy。

### P0-3 `glm-5.3-flash` 的交错思考历史缺少 `reasoning_content`

**整改状态（2026-09-03）：已关闭。** 当前由 GLM Parser 生产窄类型
`ModelContinuation`，Runtime Event 与 JSONL 保存，Context Compiler 投影，下一轮 GLM presenter 按 providerId
消费；Runtime、Context、GLM 两轮 fixture、Trajectory round-trip 和真实两轮 API conformance 均通过。以下保留
原问题机制作为审计依据。

智谱官方说明 GLM-5.3-Flash 默认/强制思考；使用“交错思考 + 工具”时，必须保留并在工具结果后一并回传上一轮 `reasoning_content`。当前两轮探针被服务接受，只能证明服务端没有立即拒绝，不能证明多轮工具协议完整。

官方依据：[GLM 思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)。

**最小修复原则：** 先明确该数据的生产者、消费者、生命周期和是否进入脱敏轨迹。不要给公共协议添加无人解释的 `unknown`。可选实现必须满足：响应解析产生该状态、下一次 GLM 请求确实消费、Run 结束后可释放；若承诺精确模型请求 Replay，还必须持久化或建立明确的不可 Replay 边界。

**验收：** 固定两轮 fixture：第一轮 `reasoning_content + tool_calls`，第二轮请求完整、未改写地回传 reasoning 与同一 ToolCall ID；缺失时测试必须失败。

## 3. P1：V1 验收或扩大实验前完成

### P1-1 JSONL 截断尾行缺少显式恢复/诊断路径

**确认存在。** `readRuntimeEvents()` 当前逐行严格解析，最后一行写到一半时会拒绝整个文件。严格失败比静默丢数据安全，但会让进程级崩溃后的有效前缀也无法用于诊断。

**要求：** 保留严格读取 API；另提供显式 recovery/inspection 路径，只允许在“最后一个非空行损坏”时返回连续有效前缀，并附带 `truncatedTail` 诊断、字节位置和原文件保留信息。中间行损坏仍必须失败。

### P1-2 CUA 原生 ActionResult 被过度压扁，最小状态映射尚未验证

**确认存在，但不应把所有 CUA 字段直接搬入公共协议。** 当前 Adapter 主要根据
`isError`、`degraded` 和文本生成 `completed/refused/failed`，没有消费 CUA `action.effect`。若真实返回出现 `suspected_noop`、`partial`、`refused` 等状态，而顶层并未同时设置 `isError/degraded`，Harness 可能把它误记为 completed。

CUA 的 `route`、`delivery`、`evidence`、`escalation`、`verification` 目前没有 Runtime 决策消费者，因此不能为了“信息齐全”全部加入 `ActionReceipt`。

**要求：** 先用锁定的 `@trycua/cua-driver@0.22.2` 收集脱敏真实 Result fixture，确定哪些原生状态会改变 Harness 的 completed/refused/failed 决策；只映射这一最小集合。测试至少覆盖 completed、明确拒绝、suspected-noop/partial（若真实版本可产生）和 transport unknown。`effect` 仍不等于任务完成。

### P1-3 Computer 关闭与不可取消调用缺少真正的时间上界

**确认存在。** Runtime 会把 AbortSignal 传给 Provider、observe 和 execute，但
`Computer.close(session)` 没有 signal。CUA `close()` 的 `cleanupWaitMs` 只控制两次清理尝试之间的等待，不会给 `endSession()` 或 `shutdown()` 本身加 timeout；下游 Promise 永不返回时，Run 的 `finally` 仍可能挂住。

**要求：** 定义“请求取消”和“资源清理时间上界”为两件事。清理可使用独立 timeout/diagnostic，超时后不能伪造正常关闭；需要保证 EventWriter 已完成的事实不被丢弃。

### P1-4 图片变换缺少可消费的坐标变换合同

**确认存在于扩展接口，而不是当前所有默认请求都已坐标错误。** 当前默认请求使用完整截图；
Qwen 采用 0..1000 归一化坐标，完整图 resize 不改变归一化映射。风险来自
`imagePreprocessor` 可以返回任意新字节，却没有返回实际 wire 尺寸或 crop/transform provenance；GLM 的 `actual_pixels` 一旦启用 resize/crop 也会失去可逆映射。

**要求：** 图片处理组件只允许两种明确结果：保持完整视野且声明 wire viewport，或返回可逆 transform；crop/reframe 在没有逆变换消费者时直接拒绝。坐标逆变换和图片变换必须由同一份结果驱动，不能只靠 Prompt 约定。

### P1-5 Provider 工具能力矩阵未成为任务筛选的显式输入

**确认存在。** Runtime 注册 click/type/keypress/hotkey/scroll/drag/wait 等动作；当前 Qwen/GLM Adapter 会按
本轮 `input.tools` 逐个呈现这些工具（另加 terminate/interact 控制函数），但底层 Provider 原生动作仍可能是
其子集或不同参数形状。不同 Provider 支持不同子集本身不是错误，但如果任务需要未暴露动作，比较结果就不公平。

**要求：** 先以实验清单或 Runner 校验消费这份能力信息，不必立刻设计宏大的通用 Capability 协议。每个进入比较的任务必须证明其所需动作属于所有候选 Provider 与 Computer 的交集；否则标为 unsupported，不计作模型能力失败。

### P1-6 `retryable` 已有生产者但没有执行消费者

**确认存在。** Provider 将网络错误、429 和部分 5xx 标记为 retryable，Runtime 只把它写入 `model.request.failed` 后结束 Run。字段目前只有报告/诊断消费者，没有恢复消费者；历史 4.6V 的平台过载记录不再进入现行模型实验。

**要求：** 当前阶段先在实验 Runner 外层实现“重新初始化 fixture 后的有界 Run 重调度”，记录每个 attempt，不覆盖原失败轨迹；不要在 Action 层自动重试，也不要同时造 Provider fallback、Job Queue 或通用分布式调度。若以后进入 Runtime，再新增明确 attempt 事件和 RetryPolicy。

### P1-7 GLM 缺少与 Qwen 对称的结构化控制函数

**确认存在，但不阻断当前诊断实验。** Qwen Adapter 会自动暴露 `terminate(status, text?)` 和
`interact(text)`，并把它们分别转换为 `ModelTurn.finish` 与 `ModelTurn.user_input_required`；GLM 当前只呈现
`input.tools`，没有自动加入这两个控制函数，通常只能通过普通文本产生 `ModelTurn.finish`。这使两个 Provider
在“结束任务”和“请求用户输入”上的协议不对称，也会让 GLM 的控制语义依赖 Runtime 是否额外注册控制工具。

**要求：** 在后续独立 Provider PR 中，为 GLM 明确加入与当前 Qwen 相同的控制工具 Schema，并在 Adapter 边界
把 `terminate`/`interact` 映射为结构化 `ModelTurn`；补充原始响应、历史回传和 Runtime 消费测试。不得把这项
未验证的控制函数改动混入当前 Qwen 坐标对照，也不能仅通过 Prompt 声称 GLM 已支持结构化结束。

## 4. P2：不阻断当前诊断开发

### P2-1 Event Schema 演进策略尚未冻结

Zod `z.object()` 默认剥离未知字段。格式正式对外或开始跨版本读取前，需要选择版本迁移、
passthrough 或严格拒绝策略。当前单版本本地读取没有发生字段丢失故障。

### P2-2 Writer 边界没有强制不可变快照

Writer 只浅复制 draft；调用方若在异步序列化前修改嵌套对象，落盘可能漂移。当前 Runtime 创建新事件并等待 append，没有发现实际变异。先以 readonly/所有权契约和测试约束；出现第二类调用方后再决定深冻结或结构化拷贝。

### P2-3 Screenshot、Asset 与 Event 的孤儿清理只有原则，没有工具

`AssetStore.put()` 成功而 `observation.created` 提交失败时可能留下孤立 Asset；CUA 临时截图目录也不会由 Session close 自动删除。技术计划已允许这种顺序，并要求离线清理。扩大长期运行前补只读扫描器和显式清理命令；Abort 不得删除已被事件引用的证据。

### P2-4 已结束 Controller 仍可能保留 pending 引用

`pendingModelTurn`、`pendingToolTurn`、`pendingApproval` 没有在 `finally` 统一清空。普通 Controller 被释放时可由 GC 回收；只有外部长时间持有已结束实例时才形成保留。生命周期清理时可统一置空，但事件仍是唯一审计来源。

### P2-5 桌面坐标无法证明 Observation 后没有外部变化

Observation ID 只能证明动作引用了已知观察，不能证明桌面此后未被用户、动画或其他进程改变。CUA 的 Accessibility token 可以对 AX 路径提供更强 stale 检查，但普通 desktop x/y 没有通用 compare-and-swap。原审计的两条重复问题已合并。

当前正确声明是“可追溯到 Observation”，不是“原子绑定到屏幕内容”。没有底层条件执行 primitive 前，不用截图哈希伪装原子保证；需要时重新观察。

### P2-6 Typed API 与 Accessibility/Window 路由属于后续扩展

当前 `desktop + primary + foreground`、`accessibility:false` 是已验证的 V1 子集。CUA typed API 能增强编译期约束，但 `callTool` 本身也是协议适配器的合法入口，不构成功能错误。等第二种 target/route 成为真实需求时，再决定迁移 typed method、Accessibility stale token 和 window target；不要先把 CUA 私有类型扩散进 Runtime。

### P2-7 Streaming 与自动 Provider fallback 尚未实现

`stream:false` 影响首 token 延迟，不影响当前动作正确性。自动切换 Provider 会改变模型、成本和行为分布，也不是普通 retry。二者分别等到延迟基线和明确 fallback 产品策略出现后再实现。

## 5. 已接受边界或正确设计，不列为缺陷

### 5.1 V1 不承诺断电级持久性

产品计划已经明确：V1 保证副作用前 Event append 和正常关闭前 flush，但不承诺操作系统突然断电或存储介质故障下的事务持久性。没有 `fsync` 因此不是当前 P0/P1。只有产品目标升级到断电恢复时再评估 fsync/事务存储。

### 5.2 不允许直接续写已有 Run 是安全默认

Writer 使用 `wx` 防止覆盖已有轨迹。V1 没有 live Run resume，因此“不支持续写”不是缺陷。未来若实现恢复，应新增独立 API，先验证 runId、sequence、终态和 unresolved action，不能把 `wx` 改成无条件 append。

### 5.3 CUA effect、predicate verification 与任务完成必须分层

- ActionReceipt：Driver 是否以及如何执行输入动作；
- CUA effect/verification：底层动作效果或显式 predicate 的证据；
- task success：外部 evaluator 或未来任务级 Verifier 的结论。

V1 明确不把语义 Verify 强制放入每一步，也不因收到第二张截图就宣称任务完成。这个分层是正确原则，不是缺失字段清单。

### 5.4 Provider 可有不同 wire protocol 和工具子集

Provider Adapter 应统一输出 canonical `ModelTurn/ToolCall`，不要求所有供应商使用同一种原生协议，也不要求暴露 Runtime 的全部工具。GLM 在 Adapter 不提前拒绝未知工具、最终由 Runtime 拒绝，仍保持 Runtime 是权威执行边界；无需为了表面对称重复一套检查。

## 6. 原审计条目重新归类

| 原条目 | 复核结果 |
|---|---|
| Trajectory 1：无 fsync | 已接受 V1 边界 |
| Trajectory 2：截断尾行 | P1-1 |
| Trajectory 3：未知字段被剥离 | P2-1 |
| Trajectory 4：浅复制 | P2-2 |
| Trajectory 5：不能续写 | 已接受 V1 边界 |
| Runtime 1：动作后观察失败导致 ToolCall 无终态 | P0-1 |
| Runtime 2：孤立截图/Asset | P2-3 |
| Runtime 3：Abort/close 依赖下游 | P1-3 |
| Runtime 4：pending 引用未清 | P2-4 |
| Runtime 5 + CUA 9/10：Observation 新鲜度 | 合并为 P2-5 |
| CUA 6：只暴露桌面像素子集 | 已知 V1 子集；扩展归 P2-6 |
| CUA 7：结果被压扁 | 收窄为 P1-2，只映射有消费者的最小状态 |
| CUA 8：effect/verification/任务完成分层 | 正确原则，不是缺陷 |
| CUA 11：fixture 不完整 | 合并进 P1-2 的验收 |
| CUA 12：未用 typed API | P2-6，不是当前单点故障 |
| Provider 13：Qwen wire mode | P0-2 |
| Provider 14：坐标空间 | 当前默认链未证实错误；预处理合同缺口为 P1-4 |
| Provider 15：工具子集不一致 | 子集允许不同；显式任务能力筛选为 P1-5 |
| Provider 16：GLM reasoning / stream / 4.6V | reasoning=P0-3；stream=P2-7；4.6V 已从现行代码与新实验候选清理 |
| Provider 17：retryable 无恢复消费者 | P1-6 |

## 7. 实施顺序与质量门

### 第一批：先关闭 P0

1. Runtime ToolCall 终态顺序和动作后观察失败测试已完成；
2. GLM reasoning continuation 生产/消费链、两轮 fixture 与 Trajectory round-trip 已完成；再做一次真实两轮
   conformance；
3. 保持已关闭的 P0-4 Function Schema 静态门，不再重复改造；
4. 在同一 Function Calling wire 下做 Qwen actual-pixels 与 normalized-1000 paired run，冻结正式坐标模式。

Qwen 坐标诊断完成并冻结当前链路默认后，才生成用于工程比较的 6-run 结果。Runtime、GLM 与 Qwen 实验保持
独立，避免变量互相污染；P0-4 的 Schema 静态门已经先行通过。

### 第二批：关闭会污染扩大实验的 P1

1. 增加尾行恢复/诊断读取；
2. 采集真实 CUA Result fixture，并只补最小状态映射；
3. 给 close 建立时间上界；
4. 冻结图片变换与坐标合同；
5. 用显式能力矩阵筛选任务；
6. 在实验 Runner 消费 retryable，保留 attempt 证据。

### 第三批：按触发条件处理 P2

P2 不应一次性全部施工。对应消费者出现时再做：跨版本轨迹触发 Schema 迁移；长期运行触发孤儿扫描；新 target/route 触发 typed API/Accessibility；测得延迟瓶颈后再做 streaming。

## 8. 本轮验证

- `pnpm test`：8 个测试文件，104/104 通过；
- `pnpm run typecheck`：通过；
- Stage 4 runner contract：通过；
- Stage 4 runner lifecycle：10/10 场景通过；
- Qwen paired `--plan-only`：6 个 Qwen 坐标诊断 Run；
- 官方协议复核：Qwen 模型能力页、GUI 自动化指南、GUI-Plus API 参考、GLM 思考模式与 Function Calling 文档；
- 代码复核：Trajectory writer/reader、RunController 动作与观察顺序、CUA result 映射、Qwen/GLM 历史呈现和坐标映射。

测试与真实诊断证明四项 P0 已闭环。GLM 可进入下一阶段；GUI-Plus 的负向结果不能外推为全部 Qwen 模型上限，
后续 `qwen3.8-flash` 必须作为新的受控候选运行。

## 9. 操作边界

当前工作树包含实施 Agent 的 P0-1/P0-3 与实验 runner 改动；本轮额外修正 lifecycle 测试、补 Trajectory
continuation round-trip，并将 paired runner 收敛为 Qwen-only 与基础设施 fail-fast。没有修改 Prompt、调用付费
模型 API 或操作桌面环境。

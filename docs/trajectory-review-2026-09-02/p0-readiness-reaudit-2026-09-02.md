# P0 开工就绪复审

日期：2026-09-03  
文档角色：审计 / 实施门  
状态：当前执行  
审计基线：`HEAD=fd67faf`；P0-4 Schema 已由提交 `c2b4a19` 纳入当前基线
上游入口：[Stage 4 实施入口](../stage-4-implementation-entry.md)  
详细问题定义：[Runtime / Trajectory / CUA Adapter / Provider 复审](./runtime-trajectory-cua-adapter-issues-2026-09-02.md)

## 1. 结论

**四项 P0 已完成闭环。GLM 三个任务的外部 evaluator 均成功，可以作为下一阶段主模型；GUI-Plus 的
actual-pixels 为 0/3，normalized paired 为 0/3、连同 smoke 累计为 1/4，因此作为负向基线冻结，不再继续做
Prompt/Schema 补丁。下一轮以 `qwen3.8-flash` 作为独立替代候选，而不是覆盖旧结果。**

本轮删除的是 `glm-4.6v-flash`，不是 Qwen。删除后的现行执行面已经统一为：

- `glm-5.3-flash`；
- `gui-plus-2026-02-26`。

CLI、API conformance runner、Stage 4 runner 和冻结任务 manifest 均未再消费
`glm-4.6v-flash`。活动文档中的少量 4.6V 文本仅用于说明它已被移除，不是执行指令。

当前不需要先补 P1/P2，也不需要扩展任务、Memory、Verifier 或 Dashboard。应保持四项 P0 的变量隔离。

## 2. 当前验证

- `pnpm test`：8 个测试文件，104/104 通过；
- `pnpm run typecheck`：通过；
- `pnpm --dir spikes/cua-driver run test:stage4-runner`：通过；
- `pnpm --dir spikes/cua-driver run test:stage4-runner-lifecycle`：10/10 场景通过；其中 CUA 清理结束超时但精确
  PID fallback 成功时记录 warning 并保持 `completed`，fallback 同样失败时记录 error 并判 `failed`。
- 既有真实 API conformance：GLM-5.3-Flash 与 Qwen GUI-Plus 均 HTTP 200，两个 Provider 各完成 2 轮，
  每轮返回一个原生 `click` `message.tool_calls`，解析为 Harness `ToolCall`；没有执行 CUA 或桌面副作用。
- 证据目录：`runs/api-conformance/function-schema-live-20260903/summary.json`（请求 URL、图片和凭据均已脱敏）。
- 更新后的 GLM continuation conformance：`runs/api-conformance/glm-live-20260903-r2/summary.json`；第二轮
  assistant 历史带有 `reasoning_content`，服务端返回 HTTP 200 / `stop`。
- attended Qwen smoke：`runs/stage4-local/qwen-smoke-20260903-r1/runner.json`；任务和 evaluator 成功，daemon 正常
  退出；fixture 关闭 warning 已记录但无 cleanup error、无残留进程。
- Qwen paired：`runs/stage4-local/qwen-paired-20260903-r2/summary.json`；6/6 Run 完整结束、无 cleanup error。
  `actual_pixels` evaluator 0/3 且全部耗尽 budget；`normalized_1000` evaluator 0/3、runtime succeeded 2/3。
- GLM 工程验收：`runs/stage4-local/glm-20260903-r2/` 的 alpha/beta 与
  `runs/stage4-local/glm-20260903-r3/text-replace-gamma/`；3/3 evaluator 成功、3/3 runtime succeeded。gamma
  首次 Run 的可重试 HTTP 500 保留在 `glm-20260903-r2`，不纳入有效成功率。
- 当前工作树包含本阶段尚未提交的 P0、runner、结果文档和后续审计改动；提交前需要按职责拆分并复核 diff。

这些结果说明核心代码、GLM continuation wire 和最小真实 CUA 控制路径已经通过质量门。Qwen 坐标对照已经完成并
给出负向结果；它不再阻塞 GLM 向下一阶段推进。

## 3. P0 的正确拆分

### PR A：Runtime 动作后观察失败的事实顺序

当前顺序仍是：

```text
Action 终态 → post-action observe → ToolCall 终态
```

应改为：

```text
Action 终态 → ToolCall 终态 → post-action observe
```

若 post-action observe 失败，记录 `runtime.error` 并以 `failed` 结束 Run；不得删除或反向改写已经确定的
Action/ToolCall 事实，也不得再次执行动作。只有 Driver 本身未能返回确定结果时才使用
`outcome_unknown`。

必须增加定向测试：首次观察成功、动作 completed、第二次观察抛错；断言 Action 与 ToolCall 都有终态、
Run 为 failed、动作只执行一次。

### PR B：GLM-5.3 reasoning continuation

当前 Adapter 开启 thinking，却不读取或回传 `reasoning_content`。修复不能使用无生命周期的 Adapter
内存 Map，也不能在公共协议中放无人消费的 `unknown`。

最小合同必须明确：

1. GLM 响应解析是生产者；
2. `model.response.received` / Context 投影负责保存并传递；
3. 下一轮 GLM 请求呈现是消费者；
4. 只在同一 Run、同一 Provider 的被选中历史中存在，Run 结束后释放；
5. 默认 UI/摘要不展示该内容；若轨迹持久化它，要沿用模型响应的隐私边界。

建议用一个窄类型的 provider continuation 合同承载它，内容类型为 `string` 或 `JsonValue`，不要使用
`unknown`，也不要顺手建立通用 Memory/Cache 系统。验收采用固定两轮 fixture：第一轮返回
`reasoning_content + tool_calls`，第二轮必须原样带回 reasoning、同一 ToolCall ID 和 tool result。

`packages/provider-glm` 中剩余的 `normalized_1000`、任意自定义 profile 和条件 Prompt 已无生产执行消费者，
仅测试仍在使用。因为 PR B 本来就会修改 GLM Adapter，可在同一 PR 中把生产合同收敛到
`glm-5.3-flash + actual_pixels + thinking enabled`；保留 `httpClient`、`endpoint`、`assetReader` 这些已有的
测试/部署接缝。不要为这项清理另造一套抽象或独立大 PR。

### Experiment C：Qwen wire paired comparison

这一步先是实验，不是预设结论的 Provider 修复。临时脚本只比较：

- 同一 Function Calling wire 下的实际像素坐标；
- 同一 Function Calling wire 下的 0--1000 归一化坐标。

两组都必须使用 `tools` 请求字段和 `message.tool_calls` 响应，不再把官方 text `<tool_call>` 协议作为本实验
变量。模型快照、Endpoint、任务输入、截图字节、Viewport、工具集合、历史窗口、Prompt、思考开关、预算和
外部 evaluator 必须固定；唯一变量是坐标表示及其对应的 Schema/解析映射。两组分别保存脱敏请求、原始响应、
解析结果、外部 evaluator、成本、延迟和坐标转换诊断。禁止正则修复损坏 JSON，禁止同时改 Prompt、任务或
Context。

实验结束后只选择一个有证据支持的正式坐标默认：另一种只作为明确配置或后续实验，不在生产 Adapter 中
同时保留隐式猜测。实验开关和临时解析器只能放在实验 runner 中，不能永久留在生产 Adapter 中。

### P0-4：Provider Function Calling Schema 细化（已关闭）

本项已在提交 `c2b4a19` 实现，并通过静态质量门及一次真实 API conformance：

- Qwen 已从单一 `computer_use(action=...)` 改为“每个可用 Runtime 工具一个独立 Function Schema”；
  `click/type/keypress/hotkey/scroll/drag/wait` 各自携带自己的 `required`、字段描述和
  `additionalProperties: false`，并额外提供 `terminate(status)` 与 `interact(text)`。
- Qwen/GLM 都根据当前 Observation 的 Viewport 补充坐标语义。归一化模式用 JSON Schema 表达 0--1000
  数值边界；Qwen 的实际像素坐标为二元数组，x/y 上限无法由同一个 `items` 精确区分，因此在字段描述中给出
  viewport 边界，并由响应 Parser 和 Runtime 做确定性范围校验；没有 viewport 时不伪造上限。
- Qwen/GLM Parser 都检查返回的函数名是否属于本轮 `input.tools`；未知工具在进入 Runtime 前拒绝。
- Qwen 的 Adapter wire 参数使用 GUI-Plus 熟悉的 `coordinate`、`coordinate2`、`pixels` 和 `time`，同时为
  Harness 的水平滚动语义增加显式 `direction`；Parser 将其映射为 Harness 的 `x/y`、`fromX/...`、
  `direction/ticks` 和 `durationMs`。`direction` 是 Adapter 定义，不应误写成官方原生字段。
- Runtime 的 ToolRegistry/Policy 校验仍然必须保留。Schema 只是模型生成约束，不能替代 Parser、工具
  存在性、参数合法性、坐标新鲜度和副作用 Policy。

字段链路已经明确：Runtime 工具定义生产 `description/inputSchema`，`ToolRegistry.modelTools()` 投影到
`ModelInput`，Provider Adapter 写入请求，Provider Parser 与 Runtime 的逐工具 validator 消费返回参数。
`additionalProperties: false` 是生成约束；Runtime 当前不通用执行 JSON Schema，而由每个工具的 validator
再次检查当前真正使用的参数语义。这一分层符合当前 V1，但不能宣称 Schema 本身替代了执行校验。

静态测试覆盖函数集合、关键字段的 `required`/description、Viewport 提示、未知工具拒绝和坐标映射。真实
conformance 目前只实际观察到 `click` 被连续调用两轮，证明 Function Calling 握手和历史回传可用；
`type/keypress/hotkey/scroll/drag/wait/terminate/interact` 尚未逐项进行真实 API 行为测试，应在后续冻结短任务
与诊断样例中验证，而不是把这项不足升级成新的开工阻塞项。

## 本轮 P0 实施结果（2026-09-03）

- P0-1 已将代码顺序固定为 `action.execution.*` 终态 → `tool.call.*` 终态 → 动作后观察；动作后观察失败时
  只写 `runtime.error` 并以 `failed` 结束，不会重放已经执行的动作。新增 FakeComputer 失败路径断言终态完整、
  观察错误存在且动作执行一次。
- P0-3 已增加窄的 `ModelContinuation` 合同。GLM Parser 生产 `reasoning_content`，Runtime Event 保留，
  Context Compiler 投影为 assistant continuation，GLM 下一轮请求消费同一 provider 的原文；没有 Adapter 内存
  Map，也不把 continuation 展示为默认用户文本。两轮 fixture 已验证原文、ToolCall ID 和 tool result 一起回传。
- 实验脚本 `scripts/experiments/qwen-wire-paired.ts` 已准备：对冻结 manifest 顺序执行 Qwen
  `normalized_1000` 3 个 Run、Qwen `actual_pixels` 3 个 Run，共 6 个诊断 Run；每个 Run 独立
  daemon/socket/输出目录，`--plan-only` 可只检查矩阵。尚未调用真实 API 或桌面环境。
- 静态门：`pnpm test` 104/104、`pnpm run typecheck`、Stage 4 runner contract 和 runner lifecycle suite
  均通过。

## 本轮独立验收发现

### 1. P0-1：通过

`RunController` 已把顺序改为 Action 终态 → ToolCall 终态 → post-action Observe。失败测试证明第二次观察抛错
时 Run 为 `failed`，Action/ToolCall 各有且仅有一个终态，Driver 只执行一次。实现位于正确的 Runtime 公共层，
不是针对某条任务加分支。

### 2. P0-3：通过

`ModelContinuation` 具有当前生产者和消费者：GLM Parser 生产，`model.response.received` 持有，Context Compiler
投影，下一轮 GLM presenter 按同一 providerId 消费。它没有依赖 Adapter 内存 Map，也不会进入普通用户文本。

现有单元测试分别覆盖 Runtime、Context、GLM 两轮呈现和 Trajectory JSONL 写入—读取 round-trip；真实 conformance
进一步证明第二轮 assistant 历史确实带有 reasoning，且服务端返回 HTTP 200 / `stop`。不需要为此增加 Memory、Cache
或新的持久化服务。

### 3. Qwen runner：已收敛为纯坐标诊断

本轮实际执行完整 6-run 配对，3 个任务分别运行 Qwen normalized 与 actual-pixels；另完成 1 个 attended smoke（不属于
paired 结果），验证当前链路的 daemon、fixture、CLI 和 evaluator 可清理。GLM 已从
坐标诊断脚本移除；选定模式后，仍按原 manifest 单独运行 GLM 3 个 + Qwen 3 个工程验收 Run，不复用诊断矩阵
宣称 Provider 正式排名。

当前三个任务只有目标文本不同、GUI 几何基本相同，因此结果只能说明当前 ProbeWindow 链路下的行为，不能外推成
GUI-Plus 在所有界面上的普适结论。actual_pixels 3/3 未改变文本；normalized_1000 3/3 进入了部分编辑流程但均未
通过 evaluator，暴露出模型坐标理解和“先全选再替换”的任务策略两个因素。此结果不足以冻结默认，也不应通过添加
针对这三个字符串的 Prompt 补丁来掩盖问题。

### 4. Runner 失败策略：全量前应 fail-fast

paired runner 已实现 fail-fast：`taskSuccess=false` 仍继续，以收集模型失败；child timeout、非零退出、runner
结果缺失或 cleanup error 会停止批次。本批次 6/6 正常收尾；每个 Run 都有 fixture 关闭 warning，但没有 cleanup error，
正式统计应继续把 warning 与 error 分开。

## 4. 并行和合并顺序

- PR A 与 PR B 可以在独立工作树并行，二者业务文件基本独立；P0-4 已经进入当前基线；
- Experiment C 的静态 fixture/runner 可并行准备，但正式真实 API 对照应基于 PR A 合入后的 Runtime；
- 推荐推进顺序：PR A → PR B → Qwen 坐标对照结论对应的 PR（若需要）；
- 每个 PR 都先跑定向测试，再跑全仓 `pnpm test` 与 `pnpm run typecheck`；PR A 合入后再跑 Stage 4
  runner contract test。

## 5. 恢复正式评测的门槛

同时满足以下条件后，才能启动完整坐标矩阵或正式工程验收：

1. P0-1 失败路径测试保持通过，EventStream 不再产生悬空 ToolCall；
2. P0-3 的 Trajectory round-trip 已通过，并完成更新后的 GLM 两轮 API conformance；
3. P0-4 的 per-tool Schema 静态门保持通过；本项已满足，不再重复施工；
4. `test:stage4-runner-lifecycle` 保持通过，且 warning 与 error 的终态语义有明确断言；
5. paired runner 保持坐标诊断与 Provider 工程验收分离，并对基础设施错误 fail-fast；
6. attended smoke 已完成；正式批量继续确认 runner、daemon、Fixture、CLI 清理正常，并单独记录 warning；
7. Qwen 失败已归因为 actual-pixels 坐标不适配，以及 normalized 下的编辑策略、状态跟踪和 false-positive finish；
   GUI-Plus 冻结为负向基线，不再继续针对当前任务补 Prompt；
8. 所有 Run 使用新输出目录，不覆盖旧轨迹。

评测后再根据证据决定 P1 顺序。当前不要用单个 bad case 给 Prompt 加补丁，也不要把 Provider 成功率和
`runtimeOutcome` 混成同一个指标。

## 6. 文档精简后的一个明确取舍

`docs/history/` 目前被忽略，历史内容仍可从 Git 历史和本地目录追溯，但新的干净 clone 无法直接浏览这些
文件。这不阻断 P0；如果团队确实需要在当前 checkout 中浏览历史，后续只补一个受控的历史索引或发布
归档，不应把全部旧计划重新放回活动文档。

## 7. 操作边界

本轮修正了 runner lifecycle 测试语义、增加 Trajectory continuation round-trip，并把 paired runner 收敛为
Qwen-only 6-run 与基础设施 fail-fast。已完成真实 GLM 两轮 conformance、1 个 attended Qwen smoke、6 个 Qwen
配对 Run 和 GLM 三题工程验收；没有上传凭据或隐私截图。静态验证为：`pnpm test` 104/104、`pnpm run typecheck`、
Stage 4 runner contract、10 个 lifecycle 场景及 paired runner `--plan-only` 均通过。
GLM 在同一冻结任务上 3/3 成功，说明 fixture、CUA desktop/foreground 链路、Runtime 和 evaluator 本身可以完成任务；
Qwen 的失败主要集中在 Provider 输出坐标/编辑策略或模型行为，不应归因于基础 fixture 无法完成。

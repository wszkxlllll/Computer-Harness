# Stage 4-A：Windows 本地任务验证

状态：当前执行入口（2026-09-03）

本路线验证完整 Harness 在 Windows 专用 fixture 上能否驱动真实 CUA 完成短任务，并把
Provider、Runtime、工具、评分和轨迹故障分开归因。它不代表 OSWorld 已接通，也不负责 Memory、
Verifier、RL 或 Dashboard。

## 当前范围

当前活动代码包含两个模型：

- `glm-5.3-flash`，`packages/provider-glm`；
- `qwen3.8-flash`，`packages/provider-qwen`。

Qwen3.8 已通过本轮真实 API、坐标校准、三题桌面工程门、显式终止语义修复和删除后的 alpha；GUI-Plus
已退出活动代码，仅保留 Git 历史和历史实验说明。

`glm-4.6v-flash` 已退出现行代码和实验入口；旧结果留在 `docs/history/`，不再作为命令或新样本。

冻结输入位于 [stage-4-local-tasks-2026-08-31.json](./stage-4-local-tasks-2026-08-31.json)：3 个同构短任务。
坐标诊断先比较 Qwen 两种模式；选定模式后，工程验收按 manifest 执行 GLM 3 题 + Qwen 3 题，共 6 个 Run。
每 Run 最多 12 steps、16 次模型请求。两模型共享初态、目标、
预算和外部 evaluator，不给模型预设坐标或标准轨迹。scroll/drag 不放入共同任务。

## 已确认事实

- 真实闭环为：`Observe → Context → Provider → ModelTurn → Tool/Action 校验 → CUA → 新 Observe`。
- `apps/cli/src/index.ts` 只负责组装，不复制 Runtime；密钥只从环境读取。
- `packages/runtime` 的 `RunController` 负责 Run 控制、ToolCall 路由、预算、暂停/取消和终态。
- `packages/context` 负责按对话时序投影 goal、assistant ToolCall、tool result 和最新图片。
- `packages/computer-cua` 负责把 Harness Computer 合同接到 CUA daemon；`spikes/cua-driver/stage4-local-runner.ts`
  负责独立 daemon、fixture、CLI、evaluator 和清理。
- `scripts/stage4-local/evaluate-fixture.ps1` 是模型上下文之外的确定性评分器；不把模型自报 finish 当作任务成功。
- 当前删除后本地回归：`pnpm test` 为 101/101，`pnpm run typecheck`、runner contract check 和 10 个 runner
  lifecycle 场景通过。
- 真实 API conformance 已通过：GLM-5.3-Flash 与 Qwen3.8-Flash 均完成原生 Function Calling 请求（HTTP 200）；
  仅使用脱敏合成图片，未执行 CUA 或桌面动作。证据位于 `runs/api-conformance/` 下对应目录。
- 本轮更新后的 GLM 两轮真实 conformance 已通过：第二轮 assistant 历史明确带有 `reasoning_content`（仅记录存在性和
  长度，不落原文），服务端返回 HTTP 200 / `stop`。证据位于
  `runs/api-conformance/glm-live-20260903-r2/summary.json`。
- Qwen3.8 attended alpha/beta/gamma 均通过 evaluator 和 Runtime；删除前与删除后的 alpha 证据分别保留在
  `runs/stage4-local/qwen38-20260903-r2/`、`qwen38-20260903-r3-retry/` 和 `qwen38-20260903-post-delete/`。
- Qwen 坐标配对矩阵已完成：6/6 个 Run 均由 runner 完整收尾、无 cleanup error。`actual_pixels` 为 0/3 任务成功，
  均耗尽 12-step budget；`normalized_1000` 为 0/3 任务成功，2/3 runtime 正常结束、1/3 耗尽 budget。证据位于
  `runs/stage4-local/qwen-paired-20260903-r2/summary.json`。
- GLM 三题工程验收已完成：有效批次为 `alpha/beta`（`glm-20260903-r2`）和重新运行的 `gamma`
  （`glm-20260903-r3`），3/3 evaluator 成功、3/3 `runtimeOutcome=succeeded`，无 cleanup error。证据分别位于
  各 Run 的 `runner.json`。
- 旧的三模型首轮成功率和 Provider 失败记录属于历史证据，不能和本轮双模型结果混算。
- Qwen3.8-Flash 的独立 profile 已完成实现：使用 canonical per-tool Function Calling schema，支持坐标模式、
  `reasoning_effort`/`preserve_thinking`、`reasoning_content` continuation、原生多 ToolCall 解析和控制调用隔离；已通过
  无 CUA 真实 API conformance。
- 无 CUA 坐标校准入口 `run:qwen38-coordinate-calibration` 已完成 3 个确定性合成目标 × 2 种坐标模式的真实校准；修正
  canonical schema 后的 normalized 确认实验为 3/3，并已通过真实桌面 alpha/beta/gamma 门。

## 当前阻塞与下一步

当前路线的代码与窄任务验收门已关闭；正式排名和扩大任务集仍不能把这组同构任务外推为通用 GUI 成功率：

1. 动作已确定完成但动作后 Observe 失败时，仍必须写入 ToolCall 终态（代码与失败路径测试已补齐）；
2. GUI-Plus 坐标配对是历史负向证据，不再作为活动 Provider 或生产默认；
3. GLM-5.3 的 `reasoning_content` 历史呈现已通过代码、fixture 和真实两轮 API conformance；
4. Qwen/GLM 的 per-tool Function Calling Schema（description、required、Viewport 坐标边界和未知工具拒绝）
   已通过静态门和真实 API conformance；Qwen provider-native 坐标/时间参数的解析映射也已覆盖测试。

GLM 的 `terminate`/`interact` 结构化控制函数列为 P1，不阻断本轮坐标协议和短任务诊断；后续独立 Provider PR
再补齐 Schema、解析映射和 Runtime 消费测试，避免与当前 P0 坐标变量混杂。

Qwen3.8 的 plain-text finish 语义已收紧为 `QWEN_UNCONFIRMED_FINISH` Provider 错误，并有回归测试；删除前受控
alpha 首次遇到模型非法坐标参数、重试通过，删除后 alpha 也通过。GUI-Plus 活动代码已删除，Git 基线和历史证据仍保留。
实验输出写入 ignored 的 `runs/`，每个 Run 单独目录，
保存 Event、截图、请求计数、延迟、成本、评分和清理结果。

GUI-Plus paired runner 已归档到本地 `docs/history/legacy-experiments/`，不再提供活动命令。Qwen3.8 坐标校准脚本仍可
用于后续 Provider 变更的受控复核；普通任务失败仍应与 Provider、Runtime、工具和 evaluator 错误分开记录。

## 最近一次实测

- GLM P0-3 conformance：`runs/api-conformance/glm-live-20260903-r2/summary.json`；2 请求、2 轮、均 HTTP 200。
  第一轮解析出 1 个 `click` ToolCall 和 continuation；第二轮 assistant 历史中
  `hasReasoningContent=true`、`reasoningContentLength=158`，随后返回完整 `stop` 响应。
- Qwen attended smoke：`runs/stage4-local/qwen-smoke-20260903-r1/runner.json`；1 个真实 CUA Run，3 次 GUI action、
  4 次模型请求，`taskSuccess=true`、`runtimeOutcome=succeeded`。该结果只证明当前 ProbeWindow 和
  `normalized_1000` 链路跑通，不冻结最终坐标默认，也不替代 6-run paired 诊断。
- 清理：daemon 正常退出；fixture 的常规 CUA `kill_app` 返回 warning（拒绝终止外部进程），runner 已完成精确清理且
  没有 cleanup error。后续全量实验需继续把 warning 与 error 分开统计。

## GLM 工程验收结果（2026-09-03）

| 任务 | evaluator | runtimeOutcome | steps | model requests | total tokens |
|---|---:|---|---:|---:|---:|
| `text-replace-alpha` | success | `succeeded` | 4 | 5 | 35,563 |
| `text-replace-beta` | success | `succeeded` | 4 | 5 | 35,768 |
| `text-replace-gamma`（重跑） | success | `succeeded` | 4 | 5 | 36,055 |

合计 3/3 任务成功，15 次模型请求，107,386 tokens，平均单 Run 约 68.0 秒。每个 Run 都出现同一类
`foreign_process_termination_denied` fixture cleanup warning，但 daemon stop code 为 0、cleanup error 为 0，
且没有残留进程。

`text-replace-gamma` 的首次 Run（`glm-20260903-r2`）在已经通过 evaluator 后，第 4 次模型请求收到可重试的
`GLM HTTP 500 (1234)`，因此 runtime 为 `failed`；该结果保留为异常证据，不纳入成功率。使用新目录
`glm-20260903-r3` 重跑后完整成功，说明这次是 Provider 瞬时错误，不是动作或 evaluator 失败。

## Qwen GUI-Plus 历史坐标配对结果（2026-09-03）

| 坐标模式 | Run 数 | evaluator 成功 | runtime succeeded | budget_exhausted | 总 tokens | 平均耗时 |
|---|---:|---:|---:|---:|---:|---:|
| `actual_pixels` | 3 | 0/3 | 0/3 | 3/3 | 225,062 | 49.5s |
| `normalized_1000` | 3 | 0/3 | 2/3 | 1/3 | 190,551 | 42.6s |

动作轨迹显示，`actual_pixels` 的坐标大多落在 fixture 窗口外，最终文本保持初态；这说明 GUI-Plus 在当前
`actual_pixels` 提示/schema 下仍倾向产生不适配当前窗口的坐标。`normalized_1000` 能进入编辑区，但多次重复输入或
没有先完成全选，最终文本长度分别为 26、24、32，而目标长度为 13、17、16。这里同时暴露了坐标可用性和任务级
编辑策略问题，不能把 normalized 的较高 runtime 完成比例误报为 evaluator 成功。

本结果支持“当前 Qwen 生产路径优先保留 normalized 作为候选诊断基线”，但不支持直接冻结它为通用坐标结论。下一步
应先对一个最小、可单动作完成的文本任务做确认，或者单独修订任务操作协议；不要在同一组中同时改 Prompt、任务和
坐标映射。

## Provider 路线判断（2026-09-03）

### 结论

- `glm-5.3-flash` 进入下一阶段，作为当前主模型；
- `gui-plus-2026-02-26` 的负向结果和代码已冻结为历史基线，活动 Adapter、入口和 paired runner 已删除；历史证据不删除；
- `qwen3.8-flash` 已完成官方协议对齐、坐标校准、conformance、3 题工程门、显式 terminate 修复及删除后 alpha，作为
  当前第二 Provider。

GLM 的证据应分两层报告：三个任务的外部 evaluator 首次均成功；其中 gamma 在任务实际完成后的下一次模型请求
遇到可重试 `HTTP 500 (1234)`，所以首批 Runtime clean finish 为 2/3，重新运行后为 3/3。它足以进入下一阶段工程
探索，但 3 个同构任务不能代表生产可靠性或 OSWorld 成功率。

GUI-Plus 的负向结论不是单纯坐标错误：

- `actual_pixels` 0/3，全部 budget exhausted，动作多数落不到编辑区；
- `normalized_1000` 的 paired 结果 0/3，加上此前 attended smoke 后累计 1/4 evaluator 成功；
- normalized 能进入编辑区，但出现重复输入、未正确全选、破坏已有文本，以及 2 次“Runtime/model 自报成功但
  evaluator 失败”；
- paired 六个 Run 共消耗约 415.6k tokens，平均单 Run 约 69.3k；GLM 三个有效工程 Run 平均约 35.8k。

因此继续针对 GUI-Plus 单条轨迹修改 Prompt 的收益较低，也会增加过拟合风险。换模型值得做，但应作为受控替代实验。

### 为什么选择 Qwen3.8-Flash

阿里云当前将 `qwen3.8-flash` 列为最新多模态 Flash：支持图片输入、Function Calling、结构化输出和 1M 上下文，
官方产品说明还明确提到 Agent 与桌面应用操作。华北 2（北京）公开价为输入 0.8 元/百万 tokens、输出 2.7 元/百万
tokens，低于 GUI-Plus 的输入 1.5 元、输出 4.5 元。按本轮 GUI-Plus 的 token 结构粗略估算，同等 token 量约可从
0.64 元降至 0.35 元；真实成本仍以新模型实际 tokenization 为准。

官方依据：

- [Qwen3.8-Flash 模型能力与价格](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)
- [GUI-Plus 模型能力与价格](https://help.aliyun.com/zh/model-studio/gui-plus)
- [模型发布记录](https://help.aliyun.com/zh/model-studio/newly-released-models)

### 官方协议结论：Qwen3.8-Flash 没有规定固定坐标制

截至 2026-09-03，阿里云官方把 `qwen3.8-flash` 定义为支持图片输入、通用 Function Calling 和结构化输出的多模态
模型，但没有为它发布原生 Computer Use Action 协议，也没有规定 GUI 坐标必须使用实际像素或 `0..1000` 归一化。
官方 Chat Completions 文档中的 `tools[].function.parameters` 是调用方定义的 JSON Schema；因此坐标单位属于 Harness
工具合同，不是模型固有属性。

实施时必须据此区分：

- **官方事实**：模型可接收图片并返回 `message.tool_calls`；后续 `tool` 消息必须使用对应 `tool_call_id`；
- **Harness 决策**：`click`、`drag` 等工具的字段、单位和边界由 `packages/provider-qwen` 的 model profile 映射；
- **待实验事实**：Qwen3.8-Flash 对实际像素和归一化坐标哪一种更稳定，官方文档没有答案，必须校准；
- **禁止推断**：不能因为 GUI-Plus 使用过归一化坐标，就把 `normalized_1000` 当成 Qwen3.8-Flash 的官方协议。

官方文档还给出以下实现约束：

- Qwen3.8 系列支持通用 Function Calling，模型可能返回一个或多个 Tool Call；Provider 应全部解析成规范
  `ModelTurn.tool_calls`，由 Runtime 继续执行“每 Turn 至多一个 GUI 副作用”等策略，不能沿用 GUI-Plus 特有的
  “Provider 只接受一个动作”假设；
- `qwen3.8-flash` 默认推理强度为 `xhigh`，且 `preserve_thinking` 默认开启。坐标校准只测工具坐标合同，必须显式设置
  `enable_thinking: false` 和 `preserve_thinking: false`；真实 GUI 任务则默认使用
  `reasoning_effort: "low"` 与 `preserve_thinking: true`，避免用非 thinking 配置人为压低任务能力，也避免直接使用
  默认高预算；
- thinking 模式下，必须把每轮原始 `reasoning_content` 经现有 `ModelContinuation` 原样持久化并在后续请求回传，
  不能拼入普通 `content`，也不能只保存摘要。使用 `reasoning_effort` 时不要同时发送 `thinking_budget`；
- 图像输入存在像素上下限。坐标校准和桌面实验应显式开启 `vl_high_resolution_images: true`，并保证 Harness 发送给
  模型的图像与 `ObservationFrame.viewport` 是同一完整画面；在实际像素实验臂中禁止预先缩放，否则坐标语义失真；
- 第一轮保持 `stream: false` 和 `tool_stream: false`，先验证协议正确性和复杂参数完整性，再把流式作为独立性能变量。

官方依据：

- [Qwen3.8-Flash 模型说明](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)
- [Qwen OpenAI 兼容 Chat Completions：多模态、推理参数和上下文回传](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- [Qwen Function Calling](https://help.aliyun.com/zh/model-studio/qwen-function-calling)

### Qwen3.8-Flash 实施顺序

保持 Runtime、Context、任务、预算、evaluator 和 CUA 截图链不变，只替换 Qwen Provider profile 和由其生成的模型
请求：

1. **独立 profile（已完成）**：在现有 `packages/provider-qwen` 内实现 `qwen3.8-flash` profile，共用 HTTP、鉴权、图片、
   usage、错误映射和 ToolCall 解析基础设施；不新建 Provider 包，也不通过替换旧 model 字符串复用协议。
2. **清除 GUI-Plus 私有假设（已完成）**：Qwen3.8 使用当前规范 per-tool schema，如 `click({x,y})`、`type({text})`、
   `keypress({keys})`。GUI-Plus 的 `coordinate`、`coordinate2`、`pixels`、`time` 已从活动 Adapter 移除，仅留在历史
   实验说明中。
3. **静态测试**：覆盖请求 model、完整图片输入、每个工具的 required/description、返回一个和多个 Tool Call、未知工具、
   畸形参数、ToolCall ID 对应的 tool result 历史、usage 与错误映射。
4. **无 CUA API conformance**：先用 non-thinking 完成至少两轮原生 Function Calling；第一轮返回 Tool Call，第二轮
   携带相同 `tool_call_id` 的结果继续。再用 `reasoning_effort: "low"`、`preserve_thinking: true` 重复两轮，验证
   `reasoning_content → ModelContinuation → 下一轮 assistant history` 完整往返。保存脱敏后的请求/响应元数据，只记录
   reasoning 是否存在及长度，不记录原文或 API Key。
5. **先校准坐标，再碰桌面**：用 3 张确定性合成图，各放置一个具有已知 bounding box 的目标，位置覆盖左上、中心和
   右下。对完全相同的图片、任务、工具集合和非 thinking 配置各跑两个实验臂：
   - `actual_pixels`：`x ∈ [0,width-1]`、`y ∈ [0,height-1]`，图片不缩放；
   - `normalized_1000`：`x,y ∈ [0,1000]`，Adapter 用当前 viewport 确定性换算为物理像素。
6. **校准评分**：把模型坐标转换成物理坐标后，判断点是否落入该图预先记录的目标 bounding box；不使用主观距离阈值，
   不调用 CUA，不让模型看到答案。若一臂 3/3 而另一臂不足 3/3，选择 3/3 的一臂；若两臂都是 3/3，选择
   `actual_pixels`，因为它与 Harness/Driver 的物理 viewport 同域，可少一次换算和舍入；若两臂都失败，停止桌面实验，
   先审查工具描述、图像链和响应解析。
7. **attended smoke**：使用选定坐标模式以及 `reasoning_effort: "low"`、`preserve_thinking: true`，只跑冻结的 alpha，
   确认观察、点击、全选、输入、finish、continuation、外部 evaluator、事件顺序和清理。如果失败明确属于规划或状态追踪，
   允许同一 alpha 只追加一次 `medium` 对照；不得同时改 Prompt、坐标或工具 Schema。
8. **固定正式配置**：alpha 在 `low` 通过就固定 `low`；只有 `low` 失败而 `medium` 通过，才固定 `medium`。一旦选定，
   beta/gamma 必须使用完全相同的坐标模式和 thinking 配置，不能逐题调档。
9. **三题工程门**：不重跑 GLM 或 GUI-Plus。要求 3/3 evaluator 成功、0 次 false-positive finish、无
   Provider/Parser/continuation/cleanup error。若 2/3，只做一次通用失败归因；若不超过 1/3，停止扩跑，保持 GLM
   单主模型推进，禁止针对单条轨迹补 Prompt。

以上 conformance、坐标校准和真实桌面 Run 都属于真实 API 实验；实施 Agent 必须在启动第一项真实 API 请求前取得用户确认。

官方当前只提供滚动调用 ID `qwen3.8-flash`，未列固定快照 ID。每个证据目录必须保存运行日期、请求 model、响应 model、
endpoint、坐标模式、thinking 配置、图片实际尺寸、viewport、工具 schema 版本、用量和延迟；后续官方出现快照 ID 后再
决定是否冻结。

### Qwen3.8-Flash conformance 与坐标校准结果（2026-09-03）

- **Conformance（无 CUA）**：non-thinking 与 `low` 各完成 2 轮请求，均 HTTP 200、原生 `message.tool_calls`，第二轮均能
  携带同一 `tool_call_id` 的结果继续；`low` 轮的 assistant history 带回了 `reasoning_content`（长度 166），没有发生
  continuation 丢失。证据分别位于 `runs/api-conformance/qwen38-disabled-20260903-r1/summary.json` 和
  `runs/api-conformance/qwen38-low-20260903-r1/summary.json`。
- **坐标校准（无 CUA）**：6 个请求均得到 HTTP 200，使用相同的 640×360 合成图、`enable_thinking=false`、
  `parallel_tool_calls=false` 和 per-tool schema。`actual_pixels` 命中 1/3；`normalized_1000` 命中 2/3。
  失败不是 CUA 或桌面故障：前者有一次超出 viewport 的像素坐标，后者有一次非法 JSON；这些均按协议/模型输出失败记录。
  证据位于 `runs/stage4-local/qwen38-coordinate-calibration-20260903-r1/summary.json`。
- **修正后的 normalized 确认**：`runs/stage4-local/qwen38-normalized-confirm-20260903-r2/summary.json` 中 3/3
  `apiSucceeded`、`toolCallParsed`、`coordinateInRange`、`localizationHit` 和 `overallPassed` 均通过；每条响应保留了
  脱敏 raw arguments、响应 model、finish reason、延迟和 usage。此前 `qwen38-normalized-confirm-20260903-r1` 因校准
  fixture 传入不完整 schema，作为实现缺陷证据保留，不纳入模型定位结论。
- **决策**：normalized 已通过无 CUA 定位门，允许进入 attended smoke；该门不等价于桌面任务成功率。

### Qwen3.8 attended 工程验收结果（2026-09-03）

- `text-replace-alpha`：`runs/stage4-local/qwen38-20260903-r2/text-replace-alpha/runner.json`，evaluator success，
  `runtimeOutcome=succeeded`，4 steps、5 requests、31,597 tokens。
- `text-replace-beta`：`runs/stage4-local/qwen38-20260903-r2/text-replace-beta/runner.json`，evaluator success，
  `runtimeOutcome=succeeded`，4 steps、5 requests、32,032 tokens。
- `text-replace-gamma`：`runs/stage4-local/qwen38-20260903-r2/text-replace-gamma/runner.json`，evaluator success，
  `runtimeOutcome=succeeded`，4 steps、5 requests、31,810 tokens。
- 合计 3/3 evaluator success、3/3 Runtime success、15 次模型请求、95,439 tokens、无 Provider/Parser/Trajectory/
  cleanup error；每个 Run 都生成了 `provider-exchanges.jsonl`，可审查原始 ToolCall。已知
  `foreign_process_termination_denied` 仍只是 cleanup warning，不影响精确清理。
- **决策**：三题工程门通过；随后 Qwen3.8 plain-text finish 已改为 `QWEN_UNCONFIRMED_FINISH` 并补回归测试。
  修复后的首次 alpha 因模型返回非法坐标数组而失败，受控重试通过；这些结果不外推为通用 GUI 成功率。

### GUI-Plus 退出活动代码结果（2026-09-03）

- 基线提交：`2d6eff1`；终止语义修复：`c8167ed`；活动代码删除：`1dce442`。
- 删除前静态回归：全量测试 113/113、typecheck、runner contract/lifecycle 均通过；修复后 alpha 受控重试通过。
- 删除后静态回归：全量测试 101/101、typecheck、runner contract/lifecycle 均通过。
- 删除后 Qwen3.8 alpha：evaluator success、`runtimeOutcome=succeeded`、4 steps、5 requests、无 Provider/Parser/
  Trajectory/cleanup error；输出位于 `runs/stage4-local/qwen38-20260903-post-delete/text-replace-alpha/`。
- GUI-Plus 活动 model union、Adapter、私有映射、CLI/runner/conformance 入口和 paired runner 已移除；旧脚本仅在本地
  `docs/history/legacy-experiments/` 归档，历史运行证据仍在 ignored 的 `runs/` 和 Git 历史中。

## 实施要求

- 开始真实桌面 Run 前取得宿主独占时间窗；不要同时操作 VMware、剪贴板或其他窗口。
- 每次使用独立 CUA daemon/socket/fixture；只清理本次记录的 PID、socket 和输出目录。
- 不修改 OSWorld、`dase_lab`、用户文件、`.env` 或其他 Agent 的运行环境。
- 记录工程故障、Provider 协议错误、工具拒绝、模型决策错误和 evaluator 失败，不能针对单条 bad case 添加 Prompt 补丁。
- 截图和轨迹可能包含隐私，不提交 Git；报告只写脱敏事实和路径。
- Provider/Driver 未证明副作用时禁止自动重试；优先重新观察并保留未知状态。

## 关键命令

先做无桌面副作用检查：

```powershell
pnpm run typecheck
pnpm test
pnpm --dir spikes/cua-driver run test:stage4-runner
```

真实 Run 只在用户确认独占桌面后执行：

```powershell
pnpm --dir spikes/cua-driver run run:stage4-task -- `
  --binary "<path-to-cua-driver.exe>" `
  --fixture "<path-to-ProbeWindow.exe>" `
  --task text-replace-alpha `
  --model glm-5.3-flash `
  --socket "<private-pipe>" `
  --output "<absolute-run-output>" `
  --env-file "<absolute-path-to-.env>"
```

Qwen3.8 已通过当前 conformance 与 normalized 校准门。下一条获准的真实桌面命令仅为 attended alpha：

```powershell
pnpm --dir spikes/cua-driver run run:stage4-task -- `
  --binary "<path-to-cua-driver.exe>" `
  --fixture "<path-to-ProbeWindow.exe>" `
  --task text-replace-alpha `
  --model qwen3.8-flash `
  --qwen-coordinate-mode normalized_1000 `
  --qwen-thinking low `
  --socket "<unique-private-pipe>" `
  --output "<new-empty-alpha-output>" `
  --env-file "<absolute-path-to-.env>"
```

当前 CLI/runner 支持 `--qwen-thinking disabled|low|medium|xhigh`，省略时默认 `low`，并在 summary/runner 中记录实际值。
真实桌面命令会启动 CUA 并操作专用 fixture，必须使用独立 socket 和输出目录；GUI-Plus paired 命令已归档，不再重跑。

Qwen3.8 真实 API conformance 必须分两次执行并使用独立输出目录：先关闭思考验证原生 Function Calling，再用
`low` 验证 `reasoning_content` continuation。以下命令只做 API 请求，不启动 CUA；执行前必须取得用户确认：

```powershell
pnpm --dir spikes/cua-driver run probe:api -- `
  --model qwen3.8-flash `
  --qwen-thinking disabled `
  --output "<absolute-conformance-output-disabled>" `
  --env-file "<absolute-path-to-.env>"

pnpm --dir spikes/cua-driver run probe:api -- `
  --model qwen3.8-flash `
  --qwen-thinking low `
  --output "<absolute-conformance-output-low>" `
  --env-file "<absolute-path-to-.env>"
```

已新增一个**不启动 CUA daemon、不操作桌面**的 Qwen3.8 校准入口，命令合同固定为：

```powershell
pnpm --dir spikes/cua-driver run run:qwen38-coordinate-calibration -- `
  --output "<absolute-calibration-output>" `
  --env-file "<absolute-path-to-.env>"
```

该入口一次顺序执行 3 个合成目标 × 2 个坐标模式，并输出逐题 bounding-box 命中结果和汇总。另提供
`--plan-only`，只检查 6 项矩阵、输出目录和必要配置，不读取 API Key、不调用模型。校准通过并选定模式后，现有
`run:stage4-task` 才允许新增 `--model qwen3.8-flash --qwen-coordinate-mode <selected-mode>` 进入真实桌面 smoke。

## 交付格式

每个 Run 报告：模型和实际配置、`runtimeOutcome`、模型 summary、evaluator success/reason、动作/模型请求数、
耗时与用量、轨迹路径、人工介入、实验干扰和清理状态。完成后更新本入口的“当前阻塞与下一步”，不覆盖历史结果。

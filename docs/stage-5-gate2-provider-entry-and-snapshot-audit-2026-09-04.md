# Stage 5 Gate 2 复审：Provider 放行与 OSWorld 快照语义

日期：2026-09-04

文档角色：审计 / 结果
状态：当前执行
当前入口：[DOCS-INDEX](./DOCS-INDEX.md)
基线：OSWorld `fc31a9049664292fcb35d6e501ee1dc839f2cf6d`；snapshot `osworld_initial_20260831`
范围：Provider 协议、真实任务、OSWorld 快照、评分和清理；不覆盖多任务成功率

状态：**Gate 2 通过；Gate 3 已完成 GLM 与 Qwen strict-json 的单官方任务诊断运行。尚未放行批量任务或模型横向比较。**

## 结论

真实 Bridge、Computer Adapter、OSWorld `DesktopEnv`、动作执行、观察、评分、reset 和清理链路已经足以让
Provider 进入完整 Harness Run。Gate 3 应先固定：

- 一个 Provider；
- 一个已经校准 evaluator 的官方任务；
- 一个经过校准的干净 VMware 快照；
- 一次完整 `reset → Harness Run → evaluate → close`。

当前首轮必须使用 `osworld_initial_20260831`，不能使用已污染且当前也不存在的 `init_state`。首轮结果只回答
“Provider 能否通过 Harness 在 OSWorld 完成一次真实运行”，不用于宣称模型成功率或比较 GLM/Qwen。

## 本次独立核验

### 代码与合同

- `pnpm test`：9 个测试文件、115/115 通过；其中 `computer-osworld` 14/14 通过；
- `pnpm run typecheck`：通过；
- `run-task.mjs` 强制从 `--snapshot-name` 或 `OSWORLD_SNAPSHOT_NAME` 取得快照名，并把 task ID、OSWorld
  commit、snapshot、Provider、Harness exit、官方 evaluation 和清理错误分别写入 `runner.json`；
- CLI `summary.json` 已把 `runtimeOutcome`、`modelReportedStatus` 和模型摘要分开；官方 evaluator 分数位于
  外层 runner 结果，不会被模型的自报成功覆盖；
- Python Bridge 在构造唯一 `DesktopEnv` 时传入环境级 `snapshot_name`，`reset(task_id)` 加载任务 JSON 后
  调用 `env.reset(task_config=task)`。

### 真实 Gate 2 证据

- transport、pointer、keyboard 三组成功结果都记录了 OSWorld commit、task ID、snapshot、1920×1080
  physical viewport、新旧 Session ID、ActionReceipt、evaluation 和 `cleanupErrors=[]`；
- 三组均完成 `reset → open/observe → execute → observe → logical close → evaluate → reset/new session → close`；
- 实际查看 pointer 组截图，画面为完整 1920×1080 桌面；任务配置启动 Chrome 是异步的，初帧仍可见桌面，
  后帧才出现 Chrome。这不破坏 Computer 合同，但会影响模型首轮观察的稳定性；
- `task-score-calibration-20260904.json` 证明 `osworld_initial_20260831` 在同一官方 evaluator 上得到
  `负例 0.0 → 正例 1.0 → reset 后 0.0`；
- `task-score-calibration-init_state-20260904.json` 为 `0.0 → 1.0 → reset 后 1.0`，证明该快照不能继续使用；
- `vmrun listSnapshots` 当前只返回 `osworld_initial_20260831` 一个快照。

## 快照到底是什么

这里的 VMware 快照是**整台 OSWorld 虚拟机的环境基线**，包括操作系统、已安装应用、用户目录、应用配置和
当时的磁盘/机器状态。它不是 Harness 的 Observation，也不是某一步截图。

当前固定 OSWorld 提交中的真实顺序是：

```text
环境级 VMware snapshot_name
        ↓
DesktopEnv.reset() 回滚虚拟机
        ↓
读取该 task 的 config
        ↓
启动应用、下载/放置 fixture、配置该题初态
        ↓
Provider 看到 ObservationFrame 并开始运行
        ↓
environment.evaluate() 使用该 task 的 evaluator 评分
```

任务 JSON 中的 `"snapshot": "chrome"`、`"vlc"` 等字段，在当前固定提交的 `DesktopEnv.reset()` 路径中
**不用于选择 VMware 快照**。真正被 VMware Provider 消费的是创建 `DesktopEnv` 时传入的
`snapshot_name`。因此不能把任务 JSON 的 `snapshot` 值直接传给 `vmrun revertToSnapshot`。

## 一个快照还是每个任务一个快照

正常情况下，**同一套 OSWorld 镜像使用一个已验证的干净基线快照，多个任务复用它**。每次任务开始都回滚
该基线，再执行该任务自己的 `config`。不应现在为 369 个任务各建一个快照：这会造成版本漂移、维护困难，
也会把任务答案或上一次运行状态固化进基线。

只有出现以下真实需求时才增加新的环境基线，而不是按 task ID 机械增加：

- 某一组任务需要当前镜像没有安装的应用或系统依赖；
- 需要不同 OS、分辨率、账户/网络隔离或明确不同的镜像版本；
- 并行 worker 需要独立 VM clone；它们可以各自持有同名、同来源的干净快照，但不能共享一个可变 VM；
- 当前基线已被污染且无法可靠恢复，应重建并赋予新的版本名，旧快照退出实验。

## 只测试过一个任务意味着什么

目前只证明了：

- 这一个 Chrome 任务的 evaluator 可区分负例、正例并在 reset 后恢复；
- 当前快照能支撑该任务的应用和配置；
- Computer backend 的 pointer/keyboard/截图/生命周期真实可用。

尚未证明 `osworld_initial_20260831` 对所有应用域都足够。后续扩大任务前，不需要逐题人工造快照，而应做
一个小型“环境覆盖性矩阵”：从计划使用的每个应用域选择一个代表任务，检查 reset、task config、初始截图、
evaluator 可调用及 reset 后基线。发现缺失应用或持久污染时，修复/重建环境基线；不要在 Harness Runtime、
Provider prompt 或单条任务上加补丁。

## Gate 3 首轮放行条件

### 可以直接沿用

- Protocol、Runtime、Context、ToolRegistry 和 Provider Adapter；
- `OsworldComputer` 与 Python Bridge；
- 当前 `computer_13` typed-action 映射；
- `run-task.mjs` 的外层环境生命周期和结果分层；
- 官方 task instruction、task config 和 evaluator。

### 首轮必须固定

1. `--snapshot-name osworld_initial_20260831`；
2. OSWorld commit `fc31a9049664292fcb35d6e501ee1dc839f2cf6d`；
3. task `030eeff7-b492-4218-b312-701ec99ee0cc`；
4. 单个 Provider，建议先使用已经完成本地真实闭环的 `glm-5.3-flash`；
5. 新的、空的输出目录；
6. 运行前确认该快照的任务负例仍为 0，运行后读取官方 evaluation；
7. 分开审查 `runtimeOutcome`、`modelReportedStatus`、官方 score、Provider errors、Harness errors 和
   cleanup errors。

### 首轮验收

- Provider 收到真实 OSWorld Observation，并产生可解析 ToolCall；
- ActionIntent 绑定当前 Observation，动作进入 OSWorld 且没有重复派发；
- Harness 能继续 observe，最终正常 finish 或以可解释的预算/错误状态结束；
- 官方 evaluator 可调用，且其分数不被模型自报结论替代；
- Bridge、Node 进程和专用 VM 被清理；
- 失败时能区分 Provider、Harness/Computer、environment/evaluator 和 cleanup 四类来源。

官方 score 为 0 本身不等于接入失败；若全链路正常而模型没有完成任务，应进入轨迹分析，而不是回退 Gate 2。

## Gate 3 首轮真实 Provider 结果（2026-09-04）

按本文件的首轮条件运行了 `glm-5.3-flash`，没有调用 Qwen，也没有运行横向比较：

- task：`030eeff7-b492-4218-b312-701ec99ee0cc`（Chrome Do Not Track）；
- OSWorld commit：`fc31a9049664292fcb35d6e501ee1dc839f2cf6d`；
- VMware snapshot：`osworld_initial_20260831`；
- 预算：`maxSteps=50`、`maxModelRequests=50`；
- 输出目录：`runs/stage5-gate3-glm-chrome-dnt-20260904-r2/`；
- Bridge health、reset、Harness exit、official `evaluate()` 和清理均成功：
  `bridgeError=null`、`harnessError=null`、`evaluationError=null`、`cleanupErrors=[]`；
- 官方 evaluator：`score=1`；
- Harness：`runtimeOutcome=succeeded`，`steps=6`、`modelRequests=7`、`eventCount=56`、
  `invalidToolCalls=0`、`runtimeErrors=0`、`providerErrors=[]`；
- 模型使用量：`inputTokens=31798`、`outputTokens=919`、`totalTokens=32717`；
- 轨迹中每个 GUI Action 都绑定当时的 Observation，并写入 execution started/completed；最终由
  `finish` ModelTurn 正常结束。

这组结果证明 GLM 可以通过当前 Harness/OSWorld Computer backend 完成这一条真实任务，且官方评分与
Runtime 事实一致；它不是稳定成功率，也不能外推到其他任务。完整摘要见
[`runner.json`](../runs/stage5-gate3-glm-chrome-dnt-20260904-r2/runner.json) 和
[`summary.json`](../runs/stage5-gate3-glm-chrome-dnt-20260904-r2/harness/summary.json)。

本次运行发生在 GLM recorder 接入之前，因此旧输出目录没有
`provider-exchanges.jsonl`。现在 CLI 已让 GLM 与 Qwen 共用同一脱敏交换记录格式；下一次 GLM Run
会在自己的输出目录生成该文件，记录请求序号、延迟、模型名、工具名、finish reason、ToolCall
参数摘要、usage 或 transport error，不记录 API key、截图和 reasoning 原文。

## Qwen 同任务对照与一次重试（2026-09-04）

使用完全相同的 task、快照、Bridge、预算和 `normalized_1000 + low` 配置运行两次 Qwen3.8-Flash：

| Run | Provider 请求 | GUI steps | Runtime | 官方 score | 结果 |
|---|---:|---:|---|---:|---|
| [首次](../runs/stage5-paired-qwen-chrome-dnt-20260904/harness/summary.json) | 1 | 0 | `failed` | 0 | `QWEN_INVALID_TOOL_CALL` |
| [重试](../runs/stage5-paired-qwen-chrome-dnt-20260904-r2/harness/summary.json) | 1 | 0 | `failed` | 0 | `QWEN_INVALID_TOOL_CALL` |

两次原始交换证据都显示 Qwen 返回：

```json
{"name":"click","arguments":"{\"x\": [19, 59], \"y\": [59]}"}
```

当前 canonical `click` Schema 要求 `x`、`y` 为单个有限数值。Adapter 在动作派发前拒绝了数组，
因此没有触发 OSWorld Computer、没有产生副作用；两次 Bridge health/reset 和清理均正常。
这不是 CUA、VM 或坐标换算失败，而是 Qwen 在该真实截图/提示下没有遵守当前 Function Schema。不能
在 Adapter 中把数组猜测性压缩成一个点，否则会把 Provider 协议错误伪装成有效动作。

另一个需在批量实验前修正的工程问题是：这两次 `run-task` 的外层进程退出码仍为 0，虽然
`harness/summary.json` 已明确 `runtimeOutcome=failed`。批量 runner 不能把进程退出码当作成功判据，
应以后者及官方 score 为准，或补充非成功 Runtime 的非零退出语义。

## Provider 错误重试验证（2026-09-04）

随后启用统一 Runtime 容错，对同一 Qwen 任务再次运行：最多 3 次重试（初始请求之外），每次都在
任何 GUI 副作用前发生，并把错误原因反馈给下一次模型请求。结果见
[Qwen retry3 summary](../runs/stage5-qwen-retry3-chrome-dnt-20260904/harness/summary.json) 和
[provider-exchanges.jsonl](../runs/stage5-qwen-retry3-chrome-dnt-20260904/harness/provider-exchanges.jsonl)：

- 共 4 次 Provider 请求、0 个 GUI step，Bridge/VM/清理均正常；
- 前两次返回 `click.x` 数组，第三次返回非法 JSON，第四次仍返回数组；
- 每个 `model.request.failed` 都包含代码、原始原因、`retrying model request n/3` 和
  `no tool was executed`；
- 最终 `runtimeOutcome=failed`、官方 score 为 0，且没有任何动作被派发。

这证明重试机制和错误说明生效，但没有把 Qwen 的格式不兼容“修好”。重试只能处理偶发的模型输出错误，
不能替代 Schema/Provider 诊断；对连续四次同类错误，应保留失败并进入协议或模型选择评估。

## Qwen strict-json 协议与真实任务复跑（2026-09-04）

在移除 Qwen 专用 Prompt 补丁、加入显式 `outputMode=strict_json` 后，先用合成截图和完整 7 个工具做了两轮无副作用
协议探针，结果见
[`strict-json conformance`](../runs/qwen-strict-json-conformance-20260904-r2/summary.json)：两轮 HTTP 200，
`response_format.type=json_schema`/`strict=true` 被接受，content 均为可解析 JSON object，第一轮为 click，第二轮为
finish；没有 CUA、VM 或 Computer.execute。

随后使用同一任务、同一 `osworld_initial_20260831` 快照和同一 OSWorld commit，运行 Qwen3.8-Flash strict-json 真实任务：

- 输出：[`stage5-qwen-strict-chrome-dnt-20260904-r2`](../runs/stage5-qwen-strict-chrome-dnt-20260904-r2/)；
- 请求：`--qwen-thinking disabled`、`--qwen-coordinate-mode normalized_1000`、
  `--qwen-output-mode strict_json`、`maxSteps=50`、`maxModelRequests=50`；
- Bridge health/reset、Harness exit、官方 evaluator 和清理均成功，`cleanupErrors=[]`；
- `runtimeOutcome=succeeded`，官方 `score=1`，7 个 GUI steps、8 次模型请求、64 个事件；
- `invalidToolCalls=0`、`runtimeErrors=0`、`providerErrors=[]`；每个 click 都在 Provider 解析后映射为物理 viewport 坐标，
  再由 OSWorld Computer 完成；最终 strict envelope 映射为 `finish(reportedStatus=success)`。

这证明 strict-json 路径在一条已校准 OSWorld 任务上能够完成闭环，但仍只是单任务/单快照证据，不能据此宣称整体成功率。
当前默认已切换为 `strict_json`；同条件 no-execute probe 已完成 3 次但仅 1/3 成功，下一步应先收紧协议或评估 Provider
输出，再进行多任务比较。第一次错误 VMX 路径导致的 Bridge 超时没有进入模型请求，已另用正确路径重跑，不计入 Provider 结果。

## 非阻塞项与批量实验前事项

- `bridge.py` 自身仍给 `--snapshot-name` 保留 `init_state` 默认值；Stage 5 runner 已强制显式传值，所以不阻塞
  首轮。批量使用或允许直接启动 Bridge 前，应移除这个危险默认值并要求显式配置；
- 当前初始截图存在系统更新通知，reset 后截图出现 Chrome 更新提示。单次诊断可以记录并继续，但模型对比前
  应确认这些瞬态 UI 是否每次一致，必要时在环境基线层处理；
- 不额外创建独立 `osworld-evaluation.json`。当前 `runner.json` 已有明确生产者和消费者并能区分评分与模型
  结论；只有后续统计工具确实需要独立文件时再增加；
- 当前输入 schema 已拒绝空按键，Bridge 也会小写规范化。完整 OSWorld 键名白名单可在出现真实跨 backend
  不兼容或进入批量任务前补充，不为首个 Chrome 任务提前扩张公共协议。

## 下一步顺序

1. 审查本次 GLM 的 trajectory、截图、CLI summary、runner evaluation 和清理结果；
2. Qwen 的格式根因、修复边界和无副作用实验门以
   [Qwen3.8 ToolCall 格式失败审计（历史原始记录）](./history/stage5/stage-5-qwen-tool-format-failure-audit-2026-09-04.md)为准；
3. 当前 3 次默认 strict-json no-execute probe 为 1/3 成功；在扩展到多任务前继续收紧协议或评估 Provider 输出，不能把
   单次成功当作稳定性证据；具体合同与验收门见
   [Qwen strict response 请求合同复审](./stage-5-qwen-strict-response-contract-review-2026-09-04.md)；
4. strict-json 稳定后，再与 native_tools 在同一批冻结任务上比较；若仍不稳定，回到 point-tuple 方案，不继续用相同
   scalar schema 盲目重试；
5. 在扩展到多任务前完成按应用域抽样的快照覆盖性矩阵，只有单任务闭环稳定后才冻结一小批 OSWorld 任务用于模型比较。

本记录包含 Provider Adapter 的协议修复、无副作用真实 API 探针和一条 OSWorld 真实任务复跑；默认 strict_json 路径、
公共 Protocol、OSWorld Bridge 和 evaluator 均未被改写。

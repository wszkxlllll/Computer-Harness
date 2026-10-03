# GLM ObservationAssessment 两轮真实 API 探针

日期：2026-10-04。使用 GLM-5.3-Flash，真实 API 请求恰好 2 次；没有重试、超时、桌面动作或额外模型调用。输入复用本机已有的 Ctrip/Notepad 任务截图。截图、原始请求、响应正文、assessment summary 原文和密钥均未复制到本报告或探针输出。

> 后续校正：首轮 Ctrip 探针的 seq116 实际是城市选择弹层，不是车次查询结果；首轮 Notepad 探针也不能证明存在真实界面阻塞。因此首轮两张图都不作为“应当产出 milestone/blocker”的证据。后续轮次使用了新的 wire contract 和重新核验的 scoped observation，见文末。

## 结果

| 探针 | 输入 / 输出 tokens | 截图与 reference | assessment | progress | RunNotice 投影与调度 |
|---|---:|---|---|---|---|
| Ctrip 可见车次结果 | 7,585 / 188 | 已包含；Observation ID 与 GUI action ID 均与当轮绑定一致 | 返回 | 未返回 | 没有 notice 投影或调度 |
| Notepad 保存但用户未给文件名 | 5,698 / 182 | 已包含；Observation ID 与 GUI action ID 均与当轮绑定一致 | 返回 | 未返回 | 没有 notice 投影或调度 |

两次 Provider 响应都带有结构化 `observationAssessment`，且其中 ID 与 Context Compiler 产生的有效绑定匹配。两次都没有 `progress.kind`，因此 `RunNoticeProjector` 没有阶段/阻塞 notice 可投影，Scheduler 也没有通知可消费。这说明这次探针的上下文绑定和图片投影正常；增强后的 producer 指令仍未让该模型在这两张图上输出 milestone 或 blocker。它不能证明这些截图在当前探针目标下必然构成里程碑或阻塞，也不能证明手机实际出声。

第二探针明确要求保存当前 Notepad 内容，但没有提供文件名，并要求不自行编造。该请求没有伪造 UI 状态或障碍；模型仍未返回 `progress.kind=blocked`。

## 实际执行链

忽略目录中的 [probe.mjs](../runs/observation-assessment-live-probe-20261004/probe.mjs) 读取现有 trajectory 与截图 asset reference，经生产 `DefaultContextCompiler` 编译带图、带当前 Observation/action reference 的 ModelInput，再交给生产 `GlmAdapter`、schema 和 GLM-5.3-Flash。每个结果再进入生产 `RunNoticeProjector` 与 `RunNoticeScheduler`。探针没有执行 Provider 返回的 GUI tool call。摘要：[summary.json](../runs/observation-assessment-live-probe-20261004/summary.json)。

## 代码改动与边界

- `OBSERVATION_ASSESSMENT_GUIDANCE` 与 `progress` schema 描述明确要求：当有效绑定下的新截图确认用户可理解的子目标结果时，在正常 action/control 调用中附带 `kind=milestone` 和简短 summary。该判断以截图语义为准，不要求 action/Monitor transition 为 `changed`，也不把回执、计划或未验证输入当证据。
- Context per-turn reference 重申同一生产条件和精确 ID。既有 actionOutcome/evidence 与 Observation binding 验证规则未改。
- `progress` 仍是可选属性，因此 routine action 不必生成每步播报。两轮真实 API 的实际响应仍未产生 progress；不据此宣称问题已由模型侧解决。
- `summary.json` 只记录模型名、用量、绑定匹配、字段是否返回和消费状态；不包含图片、原始 payload 或 progress 原文。

定向测试：Context 与 GLM Provider 共 58 tests 通过。runtime、context、provider-glm 构建通过，均使用 Node 24.19.0。

## Wire contract 与后续真实请求

保持外层 `observationAssessment` 在工具参数中的 optional 状态不变；当 annotation 存在时，wire schema 现在要求它必须显式包含 `progress`，类型为 `object | null`。`null` 表示当前截图没有阶段/阻塞播报；对象仍只允许 `milestone` 或 `blocked` 加简短 summary。解析器将显式 `null` 规范化为内部省略 `progress`，不新增内部 protocol 字段；旧模型响应中省略 `progress` 仍可解析。

最新 per-turn reference 明确要求按整个 Goal 中已被截图确认的用户可理解子目标判断，而不是等到全 Goal 完成；它给出完整对象形状，要求使用 reference 中的精确 IDs、从当前截图写 summary，不抄私有屏幕文字、不机械复用例句，也不把阶段结果说成全任务完成。

schema 与提示更新后又执行两对真实请求（本报告总计 6 次：三对，每对均无重试或超时；未执行 GUI 动作）：

| 最终提示轮探针 | 输入 / 输出 tokens | wire assessment | progress / 通知 | 样本说明 |
|---|---:|---|---|---|
| Ctrip 查询结果 | 8,728 / 100 | 未返回 | 无 notice 可投影/消费 | 来自 `run-1791041371516-e44b4898-8cf` 的 run-created Goal；当前 observation 是 trajectory seq29，seq31 实际是消费该帧的 model.request.started。截图确认查询结果已显示；有效 binding、截图与 grounding 均进入生产 Context。模型返回 tool call，但省略了 optional 外层 annotation。 |
| Notepad 已输入、保存前 | 6,337 / 159 | 返回；observation/action binding 匹配 | `milestone`；RunNoticeProjector 投影 `observation_milestone`，Scheduler 入队并成功消费 | 使用来源 Run Goal 与 seq26 的真实截图；屏幕确认指定内容已输入，但报告不复述内容。 |

前一对 nullable-schema 请求使用的 Ctrip 图仍是城市选择弹层，返回显式 `progress: null`；同对 Notepad 截图也返回显式 `null`。再之前一对旧 schema 请求的响应未包含 progress。更新提示后，Notepad 从显式 `null` 变为可消费的 milestone，说明这项 producer 修复在该真实样本上有效；但 Ctrip 正确结果页样本仍因模型省略 optional 外层 annotation 而没有 notice。因此不能宣称 GLM producer 已普遍可靠，也不能宣称手机物理出声已验证。

本轮仅保存 token 用量、binding 匹配布尔值、schema/null/object/kind、summary 长度及 notice 投影/消费状态；未保存任何 assessment `evidence` 或 `summary` 原文、屏幕文字、grounding elements、raw request/response、截图或密钥。历史 Notepad assessment 的 actionOutcome/evidence 原文未保留，无法事后恢复语义；原始真实 Run 的 ModelTurn 也没有 ObservationAssessment 可供概述。

最新定向测试：Context 33 + GLM Provider 26，共 59/59 通过。runtime、context、provider-glm 构建通过；Node 24.19.0。最新两次请求的安全摘要：[followup summary](../runs/observation-assessment-live-probe-20261004/followup/summary.json)；执行脚本：[probe.mjs](../runs/observation-assessment-live-probe-20261004/probe.mjs)。

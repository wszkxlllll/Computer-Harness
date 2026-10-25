# ObservationAssessment 与助手偏好真实 API 验证

日期：2026-09-29。范围：对当前未提交实现执行一次受控真实 API 验证；最多四次请求，实际发起四次，无自动重试。

## 方法与边界

使用 GLM `glm-5.3-flash` 与 Qwen `qwen3.8-flash` 的仓库 Provider adapter、`DefaultContextCompiler`、adapter `prepare()` 和 `generatePrepared()`。密钥从指定 `.env` 读入进程，未输出或写入日志。没有用 curl 绕过适配器，也没有操作桌面。

任务与图像均为虚构合成内容：内存中生成 640×360 Demo Settings PNG，画面显示 `STATUS`、绿色 `SAVED` 徽章和 `REFRESH` 按钮。前后两帧是同一图像字节，SHA-256 比较得到确定性 `unchanged` transition。可用的 Qwen 语义响应与当时注入的当前 Observation/action binding 精确匹配；报告不列出完整合成 ID。仅合成图像和虚构任务/偏好发送给模型。

个性化两组保持同一显式 Goal：“仅使用虚构 Demo Settings 界面；徽章为 SAVED 才可成功结束并引用原文；否则不得宣称成功，先报告画面并询问；不得改任何设置或数值。”GLM 使用简洁、标准步骤、简体中文；Qwen 使用详细、更多步骤、英语，并投影“使用 Status、Visible evidence、Next step 三个标题”的补充偏好。

## 实际结果

| Provider / 用途 | 实际解析结果 | Assessment 与绑定 | 用量 / 缓存 / 延迟 |
| --- | --- | --- | --- |
| GLM / 语义 assessment | 已发起；最终终端 JSON 中该项被截断，无法可靠恢复 Turn 类型、错误码或输出状态 | 未能从保留输出确认 | 未能恢复 |
| Qwen / 语义 assessment | 产生可用解析结果，并被 Runtime Monitor 消费 | 存在、结构有效、Observation ID 与前一 action ID 均精确匹配 | 未能从保留输出恢复 |
| GLM / 个性化 | `finish`；简体中文简短报告引用 `SAVED`，称未改值并判定目标完成 | 未附带 assessment | 输入 4,124、输出 411、总计 4,535 tokens；cache 未报告；延迟因输出截断未保留 |
| Qwen / 个性化 | `tool_calls`，选择 `wait`。没有执行该调用；本次请求只检查模型决策 | 存在且结构有效；observation/action ID 与上文一致。模型报告 `expected_change`，但合成前后图像确定为 `unchanged` | 输入 1,825、输出 289、总计 2,114 tokens；prompt cache read 1,280；延迟 6,429 ms |

四次请求的总数和零次自动重试由探针汇总确认。一次输出长度限制截断了逐项汇总的中间内容，因此 GLM 语义请求的响应状态/错误，以及两项语义请求的用量、缓存和延迟没有完整保存；GLM 个性化延迟也未保留。不将缺失信息推断成成功或无错误，也没有为补齐记录再次请求 API。

## Runtime、Monitor 与偏好投影

Qwen 语义响应的有效 assessment 与当前动态绑定相符。Monitor 将它与确定性 `unchanged` transition、completed receipt 一起处理，并生成 guidance；同一 guidance 随后进入 GLM、Qwen 两个个性化请求的 Context，trace 均显示已纳入。此运行没有 `changed` transition，因此没有声称语音 milestone。

两份个性化 Context trace 显示偏好投影已纳入，稳定前缀哈希相同；Qwen 的 63 字符补充说明有长度和摘要元数据，原文未进入 trace。GLM 的补充说明为空。第一次汇总器把空字符串当作待搜索文本，误报 GLM 原文检查失败；修正判定后重新执行的离线预检确认两项均无原文泄漏。该更正只涉及探针统计，没有触发额外模型调用。

模型行为只提供单次样本：GLM 个性化回答表现为简体中文简短最终答复；Qwen 个性化响应使用英语 assessment 用语，但选择了 `wait` 而不是完成任务，故其最终回答详略/语言是否遵循设置无法据此判断（Goal 与指令本身也是英语）。Qwen 的 `expected_change` 与未变化的合成画面不一致，说明 assessment 必须继续与确定性 transition 联合解释，不能单独当作完成证据。结果不代表稳定效果或真实桌面成功率。

## 验证记录

- 离线预检：两 Provider 均通过当前 Context 与 adapter 请求准备；每个请求含一张合成图像，assessment binding 可用。
- 构建：配置 Node 24.19.0 执行 `pnpm exec tsc -b`，通过。
- 真实 API：总计四次单发请求，零自动重试；没有个人截图、真实观察或真实用户偏好。
- 原始 HTTP 请求、响应正文、图像字节和密钥均未落盘。由于上述终端输出截断，逐项错误/时延/用量记录不完整。

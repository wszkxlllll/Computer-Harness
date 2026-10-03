# A 线运行失败审查（2026-10-01）

## 结论

本次失败不是 Relay、配对、CUA 启动或 GLM API 密钥缺失导致的。Host 已成功启动托管浏览器，模型也成功返回并执行了多次工具调用；运行最终在一次 GLM 响应达到输出上限后失败。

当前还不能把这次运行当作有效的 A 线功能验收：运行目标本身被记录为“电脑服务遇到问题，请查看电脑端状态后再试”，而不是一个明确的网页任务，因此模型进入了歧义恢复路径并反复操作 `about:blank`。

## 独立验证证据

证据来源：

- `runs/local/a-line-20260928/run-1790828424018-c7af27b0-e83/trajectory.jsonl`
- `runs/local/a-line-20260928/run-1790828424018-c7af27b0-e83/provider-exchanges.jsonl`

关键时间线（UTC）：

1. `04:20:24` 创建运行，`goal` 恰好是“电脑服务遇到问题，请查看电脑端状态后再试”。这说明该字符串被当作了任务目标，而不是仅作为页面错误提示。
2. `04:20:26` `computer.open.completed`：CUA 驱动成功打开托管浏览器。
3. 首次观察到 Chrome 的 `about:blank`；之后模型执行了地址栏点击、新标签页和再次点击等动作，动作回执均为 `completed`。
4. GLM 请求延迟分别约为 `11.6s、16.7s、31.7s、27.2s、7.6s、19.5s`；风险分类请求本身约 `7.6s`。
5. 第 7 次请求耗时约 `83.8s`，返回 `finish_reason=length`，`completion_tokens=4096`，`reasoningContentLength=17345`，没有产生可执行工具调用。
6. 轨迹记录 `GLM_INCOMPLETE_RESPONSE`，随后 `run.finished` 为 `failed`。这不是 HTTP 超时；是模型响应耗尽输出上限且没有形成合法动作/完成信号。

## 问题判断

### 1. 本次测试目标不合法或被误填

`run.created.goal` 与页面展示的错误提示完全相同。Host 不会把运行中的错误自动写回 `goal`；目标由手机端 `/api/runs` 请求原样传入。因此这次截图不能证明一个正常 A 线任务在导航过程中失败，必须先确认手机端实际发送的任务文本。

### 2. `about:blank` 是临时托管浏览器的初始页

本次目标没有提供 URL，目标模式为临时 managed browser，初始页为 `about:blank` 是预期状态。由于目标只是错误提示文本，模型没有可靠的导航意图，最终在空白页上继续尝试 GUI 操作；这会放大模型推理和响应时间。

### 3. GLM 响应过慢且推理耗尽

模型配置当前为 reasoning enabled、单次 `max_tokens=4096`。在页面状态不明确、上下文接近 8k 输入预算时，模型出现了 17k 字符的隐藏推理，并在 83.8 秒后以 `length` 结束。Runtime 只允许一次有限重试；该响应发生在重试窗口末端，因此没有可用重试，运行直接失败。

### 4. 本次没有看到配对或 CUA 根故障

`computer.open.completed`、多次 `action.execution.completed` 和多次 GLM `tool_calls` 均存在。若是 Relay/配对失效，运行不会走到这些事件；若是 CUA 未启动，也不会产生成功的 `computer.open.completed`。

## 建议修正顺序

1. 手机端重新创建一个明确、可执行的测试目标，例如“打开 https://www.apple.com.cn/，确认页面标题并停止”，不要把错误提示文本作为目标提交。
2. 先使用浏览器模式并填写明确的 `https://` 地址，避免让模型在 `about:blank` 上猜测下一步。
3. 代码层面应将 `GLM_INCOMPLETE_RESPONSE` 单独呈现为“模型响应达到上限”，而不是泛化成“电脑服务遇到问题”；同时为 reasoning 输出设置更紧的单步预算或为 `finish_reason=length` 提供受控的短反馈重试。
4. 在再次调整模型参数前，保留本次日志作为基线；不要把 API 请求超时和模型输出上限混为一类指标。

## 本次操作边界

本次只进行了本机 Host/CUA 状态检查、日志读取和审查文档记录，没有修改业务代码、没有重新提交任务，也没有再次调用 GLM API。

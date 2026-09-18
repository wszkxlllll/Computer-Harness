# DEV-2 TUI desktop interaction failure diagnosis

日期：2026-09-18
运行：`runs/tui-desktop/run-1789723110342-6e678c70-981`
范围：只读抽取事件/脱敏 provider diagnostic/summary；未读取或打印 goal、截图、原始日志正文、`.env`，未启动模型/桌面。

## 1. 脱敏运行结论

- `model=glm-5.3-flash`、`computer=cua`、`riskProfile=live-interactive`、`riskGuard=layered`、`riskModel=off`。
- runtime outcome=`cancelled`；`modelReportedStatus` 为空，`modelSummary` 未生成；没有 finish turn。
- summary usage：input=`35,209`、output=`2,687`、total=`37,896` tokens；模型请求=`5`，steps=`4`，risk-model requests=`0`，approvals=`0`，guard allow=`4`。
- metrics：`toolExecutionFailed=2`、`providerFailed=1`、`runtimeErrors=0`、invalid/rejected/budget errors 均为 `0`。
- CUA session 是 `2560×1600/physical`，capabilities 为 screenshot/pointer/keyboard=true、accessibility=false；该摘要不能证明目标窗口或应用焦点。

## 2. 事件时间线

事件序列（时间为运行资产记录的本地时间；不含 goal/正文）：

| 序列 | 时间 | 事实 |
| ---: | --- | --- |
| 0–4 | 17:18:30 | run created/started，computer open，首次 observation |
| 5–12 | 17:18:30–17:18:39 | 第 1 次 provider request；模型给出 `hotkey`，guard allow，action receipt completed，tool completed |
| 13–21 | 17:18:39–17:18:52 | 第 2 次 request；模型给出 `wait`，guard allow，action receipt completed，tool completed |
| 22–30 | 17:18:52–17:19:02 | 第 3 次 request；模型给出 `click`，guard allow，但 action/tool 均 failed；receipt status=`refused`、driverCode=`CUA_TOOL_REFUSED` |
| 31–39 | 17:19:02–17:19:51 | 第 4 次 request；模型给出 `hotkey`，guard allow，但 action/tool 均 failed；receipt status=`refused`、driverCode=`CUA_TOOL_REFUSED` |
| 40–43 | 17:19:51–17:20:51 | 第 5 次 request 无 response，`model.request.failed` category=`cancelled`，run finished outcome=`cancelled` |

trajectory 中没有 pause、user correction、approval、`waiting_user` 或 correction 事件。首个 hotkey 只有 driver/runtime 的 completed receipt；没有应用层 readback，因此不能判定用户按键是否被目标应用接收，也不能判定“任务管理器”是否打开。

## 3. Provider timing / diagnostic

| 请求 | 耗时 | response | tool | token usage | diagnostic |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 8,768 ms | `finishReason=tool_calls` | `hotkey` | 8,326 / 185 / 8,511 | `structured_invalid_json` |
| 2 | 11,940 ms | `finishReason=tool_calls` | `wait` | 8,592 / 284 / 8,876 | `structured_invalid_json` |
| 3 | 9,340 ms | `finishReason=tool_calls` | `click` | 8,942 / 238 / 9,180 | `structured_invalid_json` |
| 4 | 48,981 ms | `finishReason=tool_calls` | `hotkey` | 9,349 / 1,980 / 11,329 | `structured_invalid_json` |
| 5 | 60,023 ms | no response | none | none | `transport_error` |

总 provider attempt elapsed time为约 `139,052 ms`。第 5 次只有脱敏 `name=Error`、空 code、`diagnosticCode=transport_error`、无 HTTP status；因此本记录不能判断是网络、HTTP、服务端或 API 配额问题，也不能把它写成确定的 network failure。前四次 provider response 都可被运行时提取为 tool call，但同时留下 `structured_invalid_json` diagnostic，属于需要后续查看原始 provider diagnostic 的信号，不单独定性为本次根因。

补充核查显示，四次 response 的 structuredContent 均为 `json=false`、`callCount=0` 并带 `structured_invalid_json`，但对应 native tool-call 的 arguments 均为 `shape=object`、`parse=valid_json`，没有 argument-level diagnostic 或 redaction code。当前证据更接近“结构化 content 投影无效、native tool_calls 仍被安全解析”，不能把四次 tool-call 参数直接判为 JSON parse failure；也不能据此证明 provider 完全没有格式问题。

## 4. 失败边界与交接

目前能被证据支持的因果链是：第 3 次 click 与第 4 次 hotkey 在 CUA tool 层明确拒绝（共同安全码 `CUA_TOOL_REFUSED`），其具体嵌套拒绝原因被本脱敏抽取刻意省略；随后第 5 次 provider 请求在 60 秒左右以 `transport_error` 结束，run 被取消。没有 pause/correction 或 finish summary 来证明模型恢复、用户修正或正常结束。

两次拒绝的 receipt/result 只含 `status`、`driverCode/error.code` 和原始 message；没有稳定的 `WINDOW_TARGET_NOT_FOUND`、`WINDOW_GEOMETRY_CHANGED`、stale、permission、focus 或 background-specific 子码可供安全归因。对 message 仅做不输出正文的分类扫描，出现 target/window/scope 词形，但未出现上述具体类别；因此不能进一步断言是 scope、焦点、窗口身份或权限问题。

因此不要把用户的“I 无反应”“打开后无 reply”解释成已确认的按键丢失、窗口焦点错误或 API/network 根因。下一步若需定位，应由拥有权限的 probe/worker 在不公开原始 goal、截图和日志的前提下，仅针对两次 `CUA_TOOL_REFUSED` 的原始安全 reason code 与第 5 次 transport boundary 做最小复现；本 worker 未改代码、未运行模型/桌面，也没有消费原始截图。

## 5. 关于“问题/错误是否已显示”的证据

本 run 没有 `user_input_required`、`waiting_user`、pause、correction 或独立 `error` 事件；也没有 finish summary/reported status。可见失败事件只有两次 `action.execution.failed` + `tool.call.failed`，以及末尾 `model.request.failed(category=cancelled)`。summary 的 `fixture.status=not_configured`、`cleanupDiagnostics` 数量为 0。

因此资产能证明“没有收到/记录一个 pause 或 question 等待态”，不能证明 TUI 画面是否渲染了错误文本、是否被终端遮挡、或用户实际看到了什么；本诊断没有查看截图，也没有把 UI 未呈现作为已证事实。

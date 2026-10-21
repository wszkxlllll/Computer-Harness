# 多行输入修复与 Provider 验证记录（2026-10-03）

## 结论

Windows CUA 的多行 UIA 输入路径已完成原始驱动与 Harness Adapter 验证：在新的空白 Notepad 文档中，中文、数字和换行被完整输入；单行前台输入也通过。运行时只在同一次 token-bound CUA 结果明确返回 `effect=confirmed` 且含 `value_readback` 时记为 `completed`。未确认但可能已产生副作用时保留 `partial/unknown`，不自动重试。

但这不等于 Provider→Runtime→Adapter 全链路已经验证。唯一一次受控 GLM API Run 没有执行 `type`：该 Run 的实际 outbound tool catalog 未提供 `type`，模型因此请求用户手动输入。具体原因是测试通过命令行固定 Notepad HWND，却使用默认 background delivery；keyboard capability 关闭后，Runtime 正确从模型工具目录中移除了 `type`、`keypress` 和 `hotkey`。这个结果不能归因于模型不会操作 UIA，也不能证明 `elementRef` 未进入上下文。

## 已实现的输入边界

- 复用统一 `type` Tool；`elementRef` 是可选的 Harness 引用，CUA token/snapshot 仍为 Adapter 私有字段。Provider 永远不接触 driver token。
- 单行输入保持原有路径。多行输入只适用于当前 Observation 中精确绑定、UIA 来源、有效目标窗口/几何、空或缺少 value 的文本表面；不支持任意光标插入或非空字段替换。
- 多行一次性使用 CUA background UIA `type_text`，只将 LF/CRLF/CR 规范化为 driver 实验证实可用的单 CR，不在 Adapter 内隐藏拆分 Enter。
- 只有同一次 token-bound CUA 结果同时给出 `confirmed` 和 `value_readback` 才完成；否则保守报告部分/未知，不重试。执行后 Observation-bound grounding 失效。
- 自动绑定要求完整 catalog 且只有一个安全候选；显式 `elementRef` 可绑定当前 Observation 的精确候选。显式禁用目标、非空目标或无法证明匹配时在输入前拒绝。

## 实证结果

### CUA 0.22.2 原始驱动与 Harness Adapter

原始 Notepad 输入矩阵显示：前台 `type_text` 的 CRLF、多行中英文和数字路径会损坏内容；当前 token-bound background UIA 路径保留了逻辑文本。Notepad UIA 会将换行读回为 CR，因此比较按逻辑换行规范化，不要求字节形式完全一致。`verify_state` 在 Notepad 上返回 `unknown/UntrustedSource`，不能用它替代 readback。

最终编译 Adapter 在新空白 Notepad tab 上，用显式 `elementRef` 输入三行合成中英文/数字文本并返回 `completed`；其后只读 raw UIA 观察与目标逻辑行相符。独立单行、无 `elementRef` 的前台输入也返回 `completed`。这些是 Adapter/CUA 证据，不代表 GLM 模型已能选到 `type`。

### 真实 GLM-5.3-Flash Run

单次 Run 固定目标为 Notepad、UIA grounding 开启，使用 baseline（Guard、Monitor、Plan、Memory、Batch 均关闭），最多四个模型请求。三轮模型请求的延迟为 9.691 s、51.345 s、24.017 s，总计 85.053 s；provider 记录的 token 总量为 15,082 prompt + 3,593 completion。前两轮各返回一个带 `elementRef` 的 `click_element`，均映射为已完成 click；第三轮返回 `interact` / `user_input_required`，要求用户在空白文档中手动输入。没有 `type` call、文本输入副作用或最终 `run.finished`。CLI 正等待用户输入时结束了这次 Run；没有重跑 API。

三轮 context trace 均显示 grounding 已纳入上下文；最新观察仍有一个带名称、启用状态、bbox 和新 `elementRef` 的 `Document`。旧引用在 Observation 更新后失效、新引用重新发布是预期行为。真正缺失的是 Provider 工具目录中的 `type`：本次目录只有 `click`、`wait`、`terminate`、`interact`、`click_element`。

通用根因链：CLI `run` 没有 `windowDeliveryMode` 参数；固定窗口目标未指定前台投递时按 background 运行。Host Computer assembly 因此只放行 `click/wait`，UIA 再加入 `click_element`；CUA 报告 `keyboard=false`，Runtime capability filter 再次过滤键盘工具。修复/后续测试应通过同一配置链显式选择前台窗口模式，而不是给 Notepad 加特例提示词。

## Provider 诊断误报修复

原 `provider-summary` 会无条件把任何字符串 `message.content` 当作 flat JSON Turn 解析。GLM 的 native `tool_calls` 可以同时携带普通 assistant 文本，因此自然语言也会错误产生 `structured_invalid_json`。本次改为依据实际 outbound request 的 `response_format.type === "json_schema"` 决定是否按 strict JSON 解析；若已有 native `tool_calls`，不再把伴随 assistant 文本解析成第二种 Turn envelope。Native ToolCall arguments 仍单独校验 JSON。

验证覆盖 GLM native call + 普通 assistant 文本不误报、Qwen strict JSON malformed content 仍报错、native malformed arguments 仍报错。该修改只涉及 provider 诊断，不改变 Provider 协议或 Runtime 行为。

## 构建、测试与未验证项

- Node 24.19.0：`@computer-harness/app-runtime` build 通过。全仓 typecheck 曾通过；最新复跑被并行改动阻断：`packages/computer-cua/src/managed-browser-host.live.test.ts` 导入 `scripts/verify-managed-browser-ephemeral-regression.ts`，触发 TS6059/TS6307（文件位于该 package 的 `rootDir` 外且未列入项目）。该问题未在本任务修改。
- 定向测试：`provider-summary.test.ts` 与 `recording-clients.test.ts` 共 **17 项通过**。
- 在 Surface 并行改动后的更早一次相关测试中，报告 445 通过、77 失败：主要是 CUA fixtures 仍只模拟 `verifyState`，而当时 Adapter capture 路径已改用 `get_desktop_state`；另有一条 window-label 断言失败。此后未重跑该大套件，因此这里不宣称它已全绿。
- 临时 Managed Edge 回归未完成。启动失败后可确认没有对应 Edge 进程或 DevTools listener，但一个本轮生成的临时 profile 目录仍在；执行策略阻止了已验证目标上的 PowerShell 清理，未改走其他删除路径，也未触碰持久 travel profile。
- 没有完成真实 Provider 多行输入、浏览器输入或其他 UIA Provider 场景验收。没有部署、重启服务或提交代码。

## 下一次受控 Provider 验证

先等待 Surface 线测试全绿，再通过现有 TUI 的显式窗口选择路径运行。该路径会将选定 HWND 设为 `foreground`，而 `-Grounding auto` 在 host-window 目标下解析为 UIA；不要仅使用 `run -CuaWindowPid/-CuaWindowId`，也不要为了获得键盘能力开启跨窗口 `switch_window`。

```powershell
.\scripts\harness.ps1 tui -Preset baseline -Model glm-5.3-flash -RiskGuard off -WindowSelector local -Grounding auto -MaxSteps 6 -MaxModelRequests 4
```

TUI 中只选择 Notepad 的精确窗口并确认显示 foreground delivery，然后输入同一个不保存、不发送的合成 Goal。只运行一次；记录实际 toolNames、是否选择了 `type.elementRef`、每轮 API latency、ActionReceipt、新 Observation 与终态。若 `type` 仍未出现在 outbound schema，停止，不通过提示词绕过 tool/capability 投影。

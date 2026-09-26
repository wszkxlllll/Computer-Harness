# 精确窗口激活与重新选择（2026-09-24）

状态：实现和离线验证通过；真实 WPS 跨窗口任务未验收，现场通道不可用。

## 行为合同

- 对显式绑定且配置为 `foreground` 投递的 native CUA 窗口，`CuaDriverComputer.open()` 先以准确的 PID/HWND 调用一次 CUA 0.22.2 `bring_to_front`，然后重新列举该 PID/HWND、核验窗口几何并截图。`background` 保持原路径，不调用 `bring_to_front`。激活结果不作为持续焦点证明；每个动作仍依赖原有 foreground refusal guard。激活明确拒绝或 degraded 时，Run 不进入截图/输入路径。
- TUI 候选行显示应用、标题、PID 和 HWND。启用 Jev 时，先按当前候选和当前 goal 选择；只有选择器严格阈值通过且候选的完整 PID/HWND、应用名、标题仍在最新枚举中，才自动开始 Run。否则呈现当前候选的人工列表。未启用 Jev 时继续使用本地唯一身份匹配。
- 运行中只有 CUA 对精确 foreground 输入明确返回 `foreground_unavailable` 且明确声明没有发送输入时才进入 mismatch handoff。适配器从 refusal 文本中解析 `actual foreground HWND`，并将该值保存在私有 session 状态；TUI 用上一 target observation 与拒绝后的新枚举比较，供 Jev 选择新出现的候选。只有唯一高置信度、确认为新出现、PID 与原绑定进程相同且 HWND 与驱动报告的前台 HWND 完全一致的候选，才进入自动 handoff；随后仍核对 exact PID/HWND、标题和新截图。缺少/无法解析前台 HWND、既有窗口与不同进程候选只进入人工列表。拒绝的动作不会重放，旧观察和 element refs 在 handoff 后失效。
- 对显式启用 handoff 的 native foreground Run，适配器在每个非-wait GUI 动作派发前重新只读枚举可见窗口建立 baseline；baseline 缺失、degraded 或不含当前 PID/HWND 时，在派发前安全拒绝动作。动作和成功 ToolResult 落盘后，再对窗口列表做立即检查和一次 80ms abort-aware 延迟检查。发现 baseline 之后出现的窗口时，Run 暂停到 `waiting_window`，发出 `reasonCode: new_window_detected`，并跳过旧目标的 post-action observe。Jev 输出只高亮候选，始终要求人按 Enter 才能 handoff；另外，用户可按 C 忽略弹窗并继续原 target，此操作会记录 `computer.window.handoff.ignored`、清掉旧 observation 并先重新截图，绝不重放已完成动作。此选项仅对主动发现有效，`foreground_mismatch` 不可忽略，必须选窗或 abort。跨进程候选仍保留供人工判断；同 PID 或标题相似不能证明 dialog 所属关系，绝不自动 handoff。清单失败发生在已完成动作后时，Run 失败停止而不重放动作。
- 新绑定目标仅在 foreground mode 调用一次精确 `bring_to_front`，之后捕获并重新核验几何。后续动作不反复激活旧目标；foreground mismatch 仍会拒绝输入。

## 边界

发现仅使用 CUA 的 `list_windows(on_screen_only=true)`。mismatch 路线自动选择的新增性来自最近一次 target observation 的可见 HWND 集合与拒绝后重新枚举之间的差分；同 PID 表明候选来自同一进程，但不构成 OS-owned/modal relationship 证明。前台 HWND 必须能从驱动的 explicit no-input refusal 中解析，并和候选的确切 window ID 相等；缺失/不可解析时自动选择子集为空。新窗口主动检测路线使用动作派发前 baseline，但因 CUA 没有该新窗口的精确 foreground/ownership 证明，即使 Jev 高置信匹配也只作提示并要求人工 Enter 确认。不同 PID、基线不可用或 Jev 不确定都需要人工选择。最小化窗口还原能力没有验证，因此最小化窗口不属于支持范围。

Jev 标题共享仍需 `--window-selection jev --allow-window-title-sharing` 显式启用；请求只传 goal 与有限候选的应用名/标题，不传截图或 PID/HWND。模型建议不能证明窗口持续处于前台。

## 验证状态

- `pnpm test` 通过：54 个 Vitest 文件、661 项通过；Node TAP 20 项中 19 项通过，1 项因 Windows 符号链接限制跳过。
- `pnpm run build` / TypeScript typecheck 通过。
- 本轮定点回归：CUA、Runtime、Trajectory、TUI 四个测试文件共 228 项通过。覆盖新窗口 proactive baseline、同进程新 dialog、忽略既有窗口、80ms 延迟出现、无 dialog、abort、跨进程候选只人工确认/可明确忽略、background 路径不启用 proactive baseline、baseline 失败时派发前拒绝、完成动作后暂停且不重放，以及 Jev 主动路线只给提示并要求 Enter。另验证 `computer.window.handoff.ignored` 只接受匹配的 `new_window_detected`，清除旧 observation 并要求 fresh capture；既有 mismatch 路线仍保留 exact foreground HWND 证据门槛且不能忽略。
- CUA 定点回归另覆盖 foreground-only exact HWND 激活、拒绝/未落到目标时 fail-closed、显式 no-input 分类、actual foreground HWND 解析/不匹配/缺失、动作不重复激活、baseline 新窗口差分和 handoff 后 exact-target 输入；TUI 还覆盖 Jev initial selection、低置信手动回退、唯一同进程新窗口自动 handoff、既有类似标题窗口回退和不同进程手动确认。
- 最终 selector eligibility 修正后再次运行 `apps/cli/src/tui.test.ts`：55 项通过；`pnpm run build` 通过。上方 649 项 full-suite 结果来自新增此定点回归之前，本次未重跑全量。
- 中文文档已按 UTF-8 回读，未发现替换字符或连续问号。
- 按 computer-use workflow 做的只读现场检查两次都返回 Codex 截图，而窗口身份仍报告 WPS；遵照恢复指引刷新应用列表并重试一次后，结果仍不匹配，因此没有对任何窗口发送输入，也没有发起 Jev/GLM API 请求。
- 随后的本地 `harness doctor` 返回退出码 1：CUA 0.22.2 metadata 为 `transport`，inventory/session/health/permissions 为 `metadata_invalid`，总状态 `unknown`。因此当前配置指向的 named-pipe daemon transport 也未通过预检。

真实 WPS 保存对话框的整条 CUA + Jev + 主 Provider 任务仍未运行；需要修复窗口捕获绑定和 daemon transport 后再单独验收，不能由离线测试替代。

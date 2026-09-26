# 运行中窗口交接实验（2026-09-23）

状态：已实现显式绑定 native-window 的启动激活、精确拒绝后的重新枚举和 handoff；离线回归与 WPS 真实跨窗任务仍分别验收。默认非 TUI/桌面/托管浏览器路径保持 `off`。

## 当前触发与交接

只有 CUA 的显式原生窗口绑定、前台投递、且驱动明确返回 `foreground_unavailable`（输入未发送）时，才将拒绝归类为 `WINDOW_FOREGROUND_MISMATCH`。Runtime 先持久化失败 Receipt/ToolResult，再记录 `computer.window.handoff.requested`，状态变为 `waiting_window`；原动作和同轮后缀不重试。普通拒绝、未知副作用和托管浏览器 DOM 路径不进入此流程。

Run 前的 TUI 会列出当前 on-screen 候选及其 PID/HWND。显式启用 Jev 与标题共享时，选择器使用当前 goal 和有界候选，只有唯一高置信度匹配才自动开始 Run；低信心、并列、超时、不可用或候选身份变化时回到人工列表。未启用 Jev 时保留唯一本地身份匹配策略。标题仅在已授权的 Jev 请求和本地 TUI 显示使用，不写入交接轨迹。

运行中只在 CUA 明确拒绝某个精确 HWND 的前台输入、并明确声明没有发送输入时进入等待状态。适配器从 refusal 文本解析并私有保存 `actual foreground HWND`。TUI 从当前 CUA session 重新列出可见窗口，并根据最近一次 target observation 的 on-screen HWND 集合区分新 surfaced 候选。Jev 只评估这些新候选和当前 goal；只有唯一高置信度候选的 PID 与原绑定进程相同，且 HWND 与驱动报告的 foreground HWND 完全一致，再通过 exact PID/HWND、应用名/标题再核对和新截图捕获后，才自动 handoff。缺少/无法解析 foreground HWND、既有窗口、不同进程的新窗口、基线不可用或 Jev 不确定时保留手动列表。Escape 返回等待画面，H 重开候选，R 刷新，A 放弃并中止 Run。对 foreground handoff 窗口的一次性 `bring_to_front` 是激活尝试，不证明持续焦点，后续动作仍受前台拒绝保护；background 模式不调用它。窗口标题仅在已授权的 Jev 请求和本地 TUI 显示使用，不写入交接轨迹。

确认后 CUA 对 `(pid, windowId)` 重新枚举，并核对候选应用名/标题；再做一次只读目标截图校验。成功才更改私有绑定、生成新的逻辑 ComputerSessionId、丢弃旧观察/元素引用。Runtime 持久化 `computer.window.handoff.completed`，重新观察新窗口，然后让主 Provider 根据新图像与失败 ToolResult 重新决策；绝不自动重放原点击。若候选已变或捕获失败，仍留在等待状态。事件持久化失败则中止，不继续执行 GUI 输入。

## 本次可验证事实

- 离线单测覆盖：显式 no-input 前台拒绝分类、actual foreground HWND 匹配/不匹配/缺失、foreground-only 激活、预观察窗口 baseline、新同进程 dialog 自动 handoff、既有类似标题窗口和不同进程候选的人工回退、过时候选拒绝、旧帧失效；Runtime 等待 handoff、重新观察且不重试。具体执行结果见[2026-09-24 实施与验证记录](./pi-window-activation-reselection-2026-09-24.md)。
- 2026-09-23 的 WPS 轨迹：`uia-catalog-v1` 每次观察有 16 个 UIA hot 候选，模型第三次调用 `click_element`，但驱动以 `foreground_unavailable` 拒绝且未发送鼠标输入；因此 UIA 参与选择但没有完成保存。DOM 没有参与这条普通 WPS 窗口任务。
- 一次真实 TypeSafe API 烟测使用**构造的** WPS Save As / Settings 两候选、英文保存目标和 handoff 问题：请求成功返回，但在当前严格准入阈值下选择器以 `uncertain` 拒判，耗时约 3.7 秒。它说明 API 连通，不证明 Jev 在真实 WPS 窗口能稳定给建议；TUI 的人工候选兜底是必要路径。
- 真实 CUA＋Jev＋GLM 连贯完成“另存为”的验收仍待用户桌面试用。当前由明确的 foreground mismatch 触发候选重新枚举；自动路径要求 observation 基线差分与驱动实际前台 HWND 匹配。相同 PID 不证明 OS-owned/modal relationship，其他候选回到人工列表。CUA `list_windows(on_screen_only=true)` 不提供已验证的最小化窗口还原合同，最小化窗口不属于当前支持范围。没有足够证据时应人工选择或中止。

## 本机试用与回退

在 Pi 工作树重新构建并启动 TUI，选择一个原生应用窗口，运行可能打开新对话框的任务。若 Jev 对当前可见候选给出唯一高置信度匹配，适配器会先验证 exact PID/HWND 并捕获新窗口；若 Jev 拒判或精确核对失败，需在候选列表中人工选择，或按 A 中止。不要把单次模型置信度当作焦点证明。运行记录的 `windowHandoffsRequested` / `windowHandoffsCompleted` 和最终 target 在 `summary.json`，完整事件在 `trajectory.jsonl`。试用时记录是否触发、候选是否是预期对话框、新截图是否正确、最终任务是否完成以及额外 Jev 耗时。

回退：选择 Primary desktop 或使用非交接 Run；非 TUI 默认关闭交接。当前实现不自动在不同应用间自由跳转，也不处理托管浏览器所有权迁移；任意跨窗自动授权仍不开放。

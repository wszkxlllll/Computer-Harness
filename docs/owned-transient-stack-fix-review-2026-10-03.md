# Owned transient stack 局部修复与复审

## 结论

GO：可以继续受监督的 Notepad menu 实机验收；不是实机成功声明。此次仅修完整 inventory 的 owned-child 栈判定，不扩大 peer picker、desktop 或 DOM 授权。

## 修复

- `transient-window-admission.ts`：完整 inventory 必须包含唯一 exact parent PID/HWND，parent 和 candidate 都有 zIndex，candidate 高于 parent；仅比较 exact ownerPid/ownerWindowId 等于 parent 的可见、非最小化窗口。candidate 必须唯一最高。相关 visibility/z 未知、最高并列、另一 sibling 更高、parent 缺失或重复均保持 manual。
- 完整 inventory 不再因 exact foreground 或 `#32768` class 绕过上述栈规则。无关 Explorer helper、任务栏或其他 app 不再阻断合法 child；partial inventory 的既有 exact foreground + owner 规则不变，truncated 仍拒绝。
- `cua-driver-computer.ts` 的 Stage2 menu 栈校验复用同一 Stage1 条件，消除旧全局比较和仅 trusted class sibling 的过滤。unknown class 仍不能直接授权，必须经过 exact PID/HWND、无 screenshot 的 UIA root proof；Window 根与根证据失败仍拒绝并从 peer picker 隐藏。Dialog exact foreground、same-HWND overlay、one-shot baseline、modal/action scope、generation/cleanup 未改变。

## 独立验证

Node 24.19.0，物理仓库路径执行，未调用真实 GUI/API：

- 定向：admission 19、adapter 110、root projection 21，共 150/150。
- `tsc -b` 与 spike `tsc --noEmit`：通过。
- 全量 Vitest：105 文件，1229/1229，通过。
- 反例：无关 shell z744/743/736 不阻断 parent690/menu691；同 owner sibling 更高、并列、未知 z，以及 parent 缺失/重复/未知 z、candidate 不高于 parent 均拒绝。完整 inventory 下即使 exact foreground 也不能绕过 sibling 反例。
- 端到端 fixture：Notepad modern bridge z691、无关 Explorer helper z744 且 foreground 为 helper；唯一 counted Menu 根仍 child_push，Window 根仍 `TRANSIENT_SURFACE_UNKNOWN`，不进 picker。既有 child scope/modal/cleanup、WPS partial dialog 与 overlay 用例全量通过。

## 实机边界

后续实机需重新获取完整 baseline、fresh exact owner/parent/child z-order 与 exact root proof，再验收一次 menu push、child 输入范围、关闭后的 parent generation 和 Abort/cleanup。此处只做离线实现及回归，不激活窗口、不发送输入、不清理任何既存 lease，也不消费付费模型额度。

## 后续局部修复：Windows probe 的线程级 DPI

实机反馈：150% 缩放下，相同 HWND 的 CUA 物理 parent bounds 为 687×685、menu 为 447×697，旧 PowerShell Win32 probe 却返回逻辑 467×461 和 298×465。严格 merge 正确拒绝冲突，但使合法菜单的 owner/z 证据不可用。

已仅修改 embedded C# 探针读取线程：`ReadWindows` 初始化空结果后调用 `SetThreadDpiAwarenessContext(new IntPtr(-4))`，成功才执行 EnumWindows/GetWindowRect/z-order；`finally` 恢复旧 context。API 缺失、进入返回 null、读取异常、恢复返回 null 或异常都使 `complete=false`。Windows 旧版本没有该 API 时只返回空 incomplete 结果，不退回逻辑坐标假称物理。class 或虚拟桌面尺寸读取失败也标记 incomplete。没有调用进程级 DPI API、改变系统缩放、放宽 bounds merge 或增加坐标容差。

本轮独立验证（Node 24.19.0）：

- 定向 Windows executor/parser、inventory merge、admission、adapter：148/148。
- `tsc -b`、spike `tsc --noEmit`：通过。
- PowerShell `Add-Type` 编译 embedded C#：通过，未调用任何 native probe 方法。
- 全量 Vitest：105 文件、1235/1235。
- executor source assertions 核验 PMv2 在读取前进入、finally 恢复、null/throw 失效以及不存在进程级 DPI/系统设置 API；mock incomplete 输出始终保持 incomplete。此为静态/离线 failure-contract 验证，不伪称实际覆盖旧 Windows 或调用失败。
- 新 merge 反例使用上述 150% 尺寸：exact physical rectangles 可合并并保留 owner/z；logical mismatch 仍 incomplete，丢弃新增 owner/z/foreground 证据。

结论仍为 GO：允许重新进行受监督的实机前置证据核验；尚未声明 PMv2 实机坐标或菜单 Run 已成功。本轮未操作 GUI/API、未释放既存 lease。

## 最终局部修复：DWM visible-frame bounds

进一步实机反馈明确了几何来源：DWM attribute 9 的 parent `(1190,211,687,685)`、menu `(1183,318,447,697)` 与 CUA 精确相符；GetWindowRect 的 parent 外框 `(1183,211,701,692)` 包含不可见 resize border，仍应被 strict merge 拒绝。

正式 probe 已在既有 PMv2 线程范围内 P/Invoke `dwmapi.dll` 的 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS=9)`。GetWindowRect 仅用于读取是否成功及成功测量的零面积 HWND 忽略；非零 HWND 的输出 bounds 仅来自 DWM frame。API 缺失/异常、HRESULT 非零、frame 宽高非正或溢出均令 row 读取失败并设置 `complete=false`；不存在 GetWindowRect 输出 fallback。DPI finally restore 与严格 merge 保持不变，不新增自动输入授权。

本轮独立检查：

- Node 24.19.0 定向 executor/parser、merge、Stage1、adapter：152/152。
- `tsc -b`、spike `tsc --noEmit`：通过。
- embedded C# PowerShell Add-Type 编译：通过，未调用 native 方法。
- 全量 Vitest：105 文件、1239/1239。
- source contract 断言 DWM P/Invoke、attribute 9、HRESULT/invalid-frame fail-closed、输出仅使用 frame；mock success 保留实机反馈中的 exact visible-frame 数值，mock failure 输出保持 incomplete、不重试。strict merge 同时拒绝逻辑缩放 mismatch 与不可见外边框 mismatch。

GO 范围：可继续受监督的实机证据与菜单流程验收。上述 native 成功和失败条件本轮仅离线验证，未新调用实际 Win32/DWM probe，不声称菜单 Run 已通过；未操作 GUI/API、修改系统设置或清理 lease。文档 UTF-8 显式回读检查通过。

# DEV-2 window-target coordinate / binding validation

日期：2026-09-18
状态：Windows 0.22.2 synthetic-window target binding probe通过；无模型/API、无用户窗口、无生产 adapter 接入
范围：`ActionTarget.Window` 坐标合同、window-local screenshot/UIA frame、background/foreground action receipt、遮挡、关闭与重建 stale-target

## 1. 固定合同与证据边界

本轮没有猜测坐标偏移。运行前从实际 0.22.2 daemon 的 `listToolsJson` 读取并记录脱敏 schema，确认：

- `list_windows` 返回 `window_id`、`pid`、`bounds {x,y,width,height}`；
- `get_window_state` 接受精确 `pid/window_id`，返回 UIA `elements[].frame` 与 PNG；窗口不存在或 pid/window_id 不匹配不能静默换窗；
- `click` 的 schema 描述明确 `x/y` 是 `get_window_state` PNG 的 window-local screenshot pixels、左上角原点；`type_text` 的 x/y 采用同一空间；
- `ActionTarget.Window` 的 wire 形状为 `{kind:"window",pid,window_id}`；`delivery_mode` 的真实枚举为 `background|foreground`，background 是默认不抢前景，foreground 是显式升级；
- `set_window_frame` 要求 `pid/window_id/x/y/width/height`，并独立读回 geometry；`bring_to_front` 只对指定 pid/window id 操作。

UIA frame 在本 Windows host 的返回坐标是 desktop-originated；probe 用同一 `list_windows.bounds.x/y` 做一次明确坐标变换：

`window-local frame = UIA frame - exact list_windows frame origin`

这不是 2px border 猜测。2px 只出现在 PNG 尺寸与 frame 的关系中：请求 `960×680` 得到 `958×678` client PNG，请求 `1040×720` 得到 `1038×718` client PNG。click/type 点取转换后 UIA frame 中心，并检查点位落在返回 PNG 尺寸内。

## 2. 实际运行与结果

复现脚本为 `spikes/cua-driver/dev2-window-target-contract.ts`，fixture 为 `spikes/cua-driver/dev2-window-target-fixture.cs`；safe JSON 为 ignored `runs/dev2-window-target-contract/window-target-contract-summary.json`，五张 PNG 仅保存在 ignored 目录，未上传、未提交，也未发送模型。

- 两个本 probe fixture 均由 daemon 启动并按 PID/window id 发现，初始 origin 非零；target frame `240,180,960×680` 与 `360,260,1040×720` 均成功移动/resize，fixture oracle 均报告 DPI=`144`。
- 第二尺寸 PNG 为 `1038×718`；UIA 原始 frame 经 list_windows origin 变换后，button=`{x:82,y:145,w:330,h:72}`、input=`{x:82,y:290,w:620,h:50}`，最终 window-local action 点为 button `(247,181)`、input `(392,315)`，均在 PNG 内。
- 使用 Window target + `delivery_mode:"background"` 的 click 和 type 均无 error，fixture oracle 分别证明 `clickCount=1`、`typedExpected=true`；没有 silent fallback。background `F2` key 由 oracle 证明，随后显式 bring-to-front + `delivery_mode:"foreground"` 的 `F3` 也由 oracle 证明。结果记录了 driver route，但焦点结论只适用于本 probe fixture，不外推任意应用。
- witness 移到 target 上方并置前后，target 的 window-local capture 尺寸仍为 `1038×718`；target inactive、witness active。遮挡前后 hash 因 caret/focus/动态画面变化而不同，故只宣称尺寸/窗口作用域稳定，不宣称像素 hash 不变。
- 关闭 witness 后，旧 Window target action 返回 `window_target_not_found`；关闭 target 后，旧 target action 同样拒绝。重建 target 获得新 PID，重新 set frame/capture 成功，旧 geometry/旧 target 未复用。
- 结束后 daemon、target、witness、rebuilt fixture 均为 `0` 个自有进程；没有操作其他窗口、读取 `.env`、修改系统 DPI 或调用模型。

## 3. 不能外推的范围

本轮证明的是当前 Windows host、0.22.2 daemon、由本 probe 创建的 WinForms fixture 及固定 Window-target wire 坐标链路。它不证明生产 `@computer-harness/computer-cua` adapter 已接入 Window target、不证明任意应用 UIA frame 的坐标语义、不证明通用 foreground ownership、跨平台、AX 权限或真实用户桌面安全。生产 adapter opt-in 仍需另一个同 fixture 验收批次。

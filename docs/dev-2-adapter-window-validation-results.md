# DEV-2 production adapter window-target opt-in validation

日期：2026-09-18
状态：真实 `CuaDriverComputer` window opt-in fixture 验证通过；该实机记录对应后续 latch patch 之前的 adapter 路径。无模型/API、无键盘派发、无用户窗口
范围：production adapter `open → observe → window-target background pointer click → move/resize → stale action refused → fresh observe → click → close/stale refused`

## 1. 实际 adapter 合同

本轮使用当前 production `@computer-harness/computer-cua` 的 `CuaDriverComputer`，只设置显式 `windowTarget={pid,windowId}`，没有改 packages/apps，也没有 desktop fallback。adapter 当前实现的窗口 opt-in 路径：

- `open` 通过 `discoverWindow` 精确校验 PID/window id，再用 `verify_state` window capture 建立 viewport；
- `observe` 重新发现同一窗口并更新 geometry/PNG viewport；
- window-target pointer action 使用 production adapter 当前实现的 `delivery_mode:"background"`；desktop path 的 foreground 行为不在本轮结论内。本轮没有 type/keypress，window opt-in descriptor 的 `keyboard=false`；
- action 在 dispatch 前重新发现窗口并比较 observation geometry，变化时返回 `WINDOW_GEOMETRY_CHANGED`；关闭/消失返回 `WINDOW_TARGET_NOT_FOUND`，不静默改成 desktop target。

fixture 是本 probe 自己启动的 `Dev2WindowTargetFixture.exe`，按钮点位由同一 daemon 的 UIA frame 与 `list_windows` origin 转换得到，不使用固定 2px 猜测。

## 2. 实际结果

脱敏 safe JSON 保留在 ignored `runs/dev2-adapter-window-contract/adapter-window-contract-summary.json`；adapter observation PNG 只保存在 ignored 目录，未上传/提交。运行期间没有模型请求、没有读取 `.env`、没有键盘动作、没有用户窗口。

- `open` descriptor：viewport=`958×678/physical`（requested frame=`960×680` 的 window client capture），capabilities=`screenshot:true, pointer:true, keyboard:false, accessibility:false`。
- 第一个真实 adapter `observe` 后，以 production window-target background pointer click 派发到 target-local button point，receipt=`completed`；fixture oracle `clickCount=1`、DPI=`144`。
- 外部将同一窗口移动/resize 到 frame=`360,260,1040×720` 后，基于旧 observation 的 click 被 adapter 拒绝为 `WINDOW_GEOMETRY_CHANGED`，没有派发旧 geometry 动作。
- fresh `observe` 返回 viewport=`1038×718/physical`；重新从 fresh geometry 取得 button point，第二次 window-target background pointer click receipt=`completed`，fixture oracle `clickCount=2`。
- 关闭 fixture 后，基于 fresh observation 的旧 adapter action 被拒绝为 `WINDOW_TARGET_NOT_FOUND`；随后 adapter close 完成，daemon/fixture 自有进程均为 `0`。

## 3. 限制

本轮只证明 production adapter 的 host-owned Window target 单击 pointer opt-in 和 geometry/stale lifecycle；没有证明 double-click、right-click、scroll、drag、生产键盘输入（当前明确 disabled）、通用 foreground ownership、跨平台窗口、真实用户桌面或模型运行。raw Window-target background/type/key 证据属于独立 probe，不替代本 adapter 的 pointer 证据。

## 4. latch patch 边界

本记录的真实 daemon/fixture adapter run 在后续 production latch patch 写入前完成；后续 latch 增加了 window identity invalidation 与 primitive gate。latch patch 之后只做了 Node24 focused noEmit/root typecheck，没有重新宣称桌面实机通过。因而本记录中的真实 click/stale/close 结果不能与 latch 后的离线实现检查混写；若要验收 latch 后行为，应另开一次新的 host-owned fixture run。

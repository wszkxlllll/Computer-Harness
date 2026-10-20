# 携程到记事本任务：窗口与播报诊断

Run：`run-1791041371516-e44b4898-8cf`。时间：上海 2026-10-03 23:29:31–23:31:19；终态 cancelled（配对设备取消）。本次只读取轨迹、Host 日志及源码，没有执行桌面动作或修改业务代码。

## 窗口故障已确认

模型已进入携程火车票页面并读到前三个车次；这些是模型观察结论，本次未独立核对价格与截图。随后三次 `list_windows` 均失败，返回 `Computer window inventory must contain at most 128 options`。模型没有获得合法窗口清单，也没有产生 `switch_window`。因此不是记事本匹配或激活失败，而是完整窗口枚举到工具候选投影的数量边界导致列窗失败。

模型随后两次用 ALT+TAB 兜底，两次键盘 receipt completed，但没有明确 Surface peer switch；均进入 `new_window_detected` 手动交接。第一次交接被 ignored，第二次等待期间用户取消。未执行记事本输入或保存。

后续修复应分开完整拓扑清单与有限模型候选投影：完整清单用于 child/owner/absence 判断；模型目录只提供可选择、经授权的应用窗口，并有确定排序及明确的截断/分页语义。不能截断完整拓扑来证明 child 消失，也不能只增大 128 上限掩盖隐藏服务窗口污染。Alt+Tab 不建立目标 Surface，不能作为 switch_window 等价兜底。

## 语音：部分原因已确认，完全静音尚未归因

七次模型响应均未产生 `observationAssessment`，没有规划阶段更新；普通 assistantText 不进入进度播报，因此本轮没有具体阶段播报的来源。窗口手动交接事件 `computer.window.handoff.requested` 也未被当前 RunNoticeProjector 映射为通知，用户等待选窗时没有对应语音提醒。

Host 已启用 Run notices；通知在 remote API 中投影为公开事件，并非直接写入原始 trajectory，因此原始轨迹没有 notice 不证明服务器未生成通知。任务开始与取消仍有固定通知投影；如果两者也完全听不到，需要核对手机本地 `preferences.voice.runNoticesEnabled`、SSE notice 到达和 speechSynthesis 播放结果。开关默认 false，保存在手机浏览器本地，换浏览器/入口可能读取不同状态；本次不能从电脑原始轨迹确认手机开关及系统播放是否成功。

后续应保留手机端播放成功/失败/未启用诊断，并将选窗等待接入当前请求绑定的通知。阶段播报需要验证真实 Provider 的 assessment 生产率及消费者链路；不能通过朗读每次动作 receipt 来代替事实进度。

## 第二次任务：点击后拓扑校验失败

Run `run-1791041862812-b2069864-9ff`，上海时间 23:37:42–23:38:00，目标是在记事本输入一句话并保存。Computer open 与首张 Notepad 观察成功；模型坐标命中文本编辑区，首个 click receipt completed。约 52ms 后 runtime.error 为 `window inventory was incomplete or truncated; popup state requires manual handling`，终态 failed。没有 type 或保存动作，未出现 list_windows。

该故障与第一 Run 的模型目录超限不同，发生在动作后的拓扑/弹窗检测。轨迹未保存造成 incomplete 的具体 producer 诊断，尚不能确认是实际截断、原生枚举读失败或 CUA/probe 非原子快照冲突。应补只读诊断与有界新快照复核；不重放已经 completed 的 click，不从 partial 清单推断 child absence。

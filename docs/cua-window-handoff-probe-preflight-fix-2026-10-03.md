# Handoff探针前置与清理判定修正

日期：2026-10-03。仅修脚本与离线回归，没有真实GUI/API、额外activation或lease恢复。

## 已完成

- handoff preflight使用listAllWindowTargets按exact PID/HWND和Notepad appName匹配；不要求目标当前前台或可见。Runtime foreground open继续执行一次精确activation与fresh identity/capture，不添加重复activation。
- parent-observe前后也使用完整窗口目录，避免被遮挡的parent误判不存在，或隐藏dialog误判已经关闭。
- 只有尚未尝试startRun、readonly discovery已成功收尾、无Run history/active Run的session，才能将本探针cleanupConfirmed记为true。close成功不代表其他Run的environment lease已释放。
- manifest增加cleanupScope=no_run_started和preexistingEnvironmentPending/Blocked/RunId/Reason；既有lease仍原样保留。startRun尝试、active Run、不确定副作用或discovery cleanup未知仍走原有fail-closed路径。
- 新测试加入scripts/test.mjs的Node测试列表；模块入口guard允许离线import helpers而不执行探针。

Node24.19.0独立执行：7个Node离线tests通过，脚本--check和--help通过。未修改Runtime/ApplicationSession/owner策略。

## 旧lease只读追溯

lease文件：`C:/Users/lenovo/AppData/Local/ComputerHarness/environment-leases/875ffd830de3853a0631562b263675fd5d240b4304d77b3f071eb4fd4c33adc2.json`。

磁盘记录仍为active，runId=`run-1790966950573-d4d50dc6-8f9`、ownerProcessId=32500；本轮进程查询未找到该PID。EnvironmentOwner的inspect因此投影为pending_cleanup，原因是旧进程退出但未确认桌面清理。没有改写、清理或恢复此文件。

轨迹：`runs/raw-cua-multiline-20261002/provider-glm-20261003/run-1790966950573-d4d50dc6-8f9/trajectory.jsonl`。

| 顺序 | 事实 |
| --- | --- |
| seq10→11 | click，completed；回执为UIA Invoke，目标PID27384 |
| seq19→20 | 最后一个GUI action为click，completed；最后receipt时间2026-10-02T18:50:15.087Z |
| seq23→25 | Provider请求/响应后进入user.input.requested，末事件时间2026-10-02T18:50:39.978Z |

轨迹没有type/keypress/save action，没有未配对action.execution.started；目录没有summary.json，日志也没有run.finished或cleanup完成证据。因此证据支持“旧进程死后遗留的等待用户输入Run”，不支持“CUA daemon/session一定已完成清理”。

结论：可作为**外部状态核对后显式恢复**的候选，不能自动恢复。本轮未检查真实窗口或daemon，不满足恢复API要求的externalStateInspected；协调者应核对当前隔离窗口、无在途输入/保存及旧session清理，再按exact runId与当前lease hash使用现有显式恢复机制。不要用删除lease文件或无条件确认cleanup代替该步骤。

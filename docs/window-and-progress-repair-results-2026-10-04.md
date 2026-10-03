# 窗口与中途播报修复验收

## 结论

本轮 Windows 窗口修复可进入用户实机复测；不是 macOS/Linux 跨窗口验收。中途播报已获得真实 API 正向证据，但仍可能被模型漏报，不作为窗口版本交付的阻塞条件。

## 已修复与原理

- 全量窗口清单保留给拓扑判断；模型与人工选择器使用过滤、排序后的候选投影，最多 128 项，并明确 truncated/omittedCount。隐藏辅助窗口与原生菜单不混入普通应用候选。背景、最小化应用仍可作为候选，激活后重新确认身份和截图。
- 窗口名称优先来自驱动，缺失时按精确 PID/HWND 使用原生 Unicode 标题与进程名补齐。名称仅用于显示，不用于证明身份或父子关系。
- 普通动作不再因全局窗口清单不完整而直接失败；不能用不完整清单证明 child 消失。菜单、弹窗依靠新鲜的精确 owner 与前台证据，不强制要求 UIA 提供额外根节点。
- WPS 实际辅助窗口属于另一 PID，但 Win32 owner 精确指向原窗口。完整、未截断的 Win32 快照可证明这种跨进程关系；同 PID 不再成为必要条件。普通辅助窗且父窗口仍在前台时继续父 Surface，不强制弹出选择器。真正 modal/前台 child 仍进入 child Surface。
- 动作已执行后遇到无法确认的临时窗口，转为用户确认与重新观察，不将其冒充动作失败、更不重放未知副作用。
- 手机窗口接管请求加入独立 handoff 通知，绑定当前请求 ID，解决后取消旧播报。
- 模型进度指导区分 milestone、blocked 与 null；以当前截图确认的用户子目标为依据，不要求截图变化或 Monitor 状态变化。普通 assistantText 不作为可信结果朗读。

## 本轮证据

- Node 24 根构建通过。全量回归 107 文件、1312 项通过；脚本测试 31 通过、1 项因 Windows 符号链接能力跳过。最终唯一旧措辞断言已修正，Qwen 28/28 通过后重跑全量。
- Notepad File 菜单 → Esc：同一 Session 内 child_push → child_pop，两动作 completed，Run 成功，owner/lease 清理成功。证据：`runs/diagnostics/notepad-menu-surface-1791046755524`。
- WPS：由模型工具 list_windows 获取 22 个有名称的候选，选择 WPS，switch_window → Ctrl+A → Esc，三动作 completed；没有人工接管或运行错误，清理成功。证据：`runs/diagnostics/wps-ctrl-a-escape-1791049643262`。没有写入、改格式或保存用户文件。
- 真实 GLM 进度探针共 6 次调用。最后一轮 Notepad 返回 milestone，经通知投影和调度器实际消费；携程结果页仍漏掉 assessment，未产生中途通知。详见 [API 探针记录](observation-assessment-live-probe-2026-10-04.md)。不能宣称每轮都会播报。

## 下一轮用户测试

以新部署的 Preview 与重新启动的 Host 为准，重新配对后测试：携程查询 → 记事本写入保存，以及 WPS 菜单/弹窗返回。保持“朗读任务关键通知”开启，记录是否听到中途具体结果、窗口选择是否有名称、弹窗后能否继续。

尚未本轮解决：跨应用开启时受管浏览器仍可能提前准备；手机实际扬声器表现需要用户验证；macOS/Linux 真实跨窗口尚未通过。初始自动绑定与明确 switch_window 授权不等于任意窗口自动控制。

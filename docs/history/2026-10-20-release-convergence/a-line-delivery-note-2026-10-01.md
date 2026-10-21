# A 线阶段改动推送说明（2026-10-01）

## 提交范围

本次提交整理当前工作树中已经完成的 A 线运行时、受管浏览器、窗口安全合同、风险控制、
Provider/API 适配、手机端反馈和测试补充。目标是让真实任务能够稳定完成，并在出现
失焦、窗口重建、连接中断、模型响应异常或清理不确定时安全停止，而不是盲目重放动作。

主要内容：

- 受管浏览器按平台选择：Windows 默认 Edge，macOS/Linux 默认 Chromium；独立 profile、
  CDP loopback、页面 ready 检查、启动网址和生命周期清理。
- 精确 PID/HWND 绑定、前台证据校验、窗口交接、截图有界重试和 DOM/UIA observation-bound
  click，拒绝错窗输入与过期候选重放。
- Windows PowerShell/CIM 进程树、Edge broker 退出判断、`taskkill` 清理、profile lock/
  stale recovery 和路径/junction 安全检查。
- Remote Run 设备隔离、命令去重、资产路径保护、Host/Relay 重连与撤销边界。
- GLM/Qwen 请求合同、风险审批、Monitor/进度反馈、手机连接异常提示和 Web 事件时间线。
- 补充 Runtime、Provider、CUA、managed browser、profile recovery、窗口选择和 Web UI 测试。

## 验证结果

- `pnpm run typecheck`：通过。
- Windows 兼容相关定向回归：7 个测试文件、135 项测试通过。
- 当前工作树已有完整回归记录：85 个 Vitest 文件、853 项测试，以及 20 项 TAP 测试通过。
- CI 矩阵包含 Windows 2025 + Node 22.13.0；CI 只执行构建和离线合同测试，不操作真实桌面。
- 当前 macOS 已完成 CUA、受管浏览器、手机链路和 A 线简单任务的受控验证；这些结果不
  替代 Windows 实机验收。

## Windows 验收状态

**状态：代码和离线合同可推进，Windows 真机尚未完整放行。**

已覆盖的 Windows 代码面：

- Edge 默认选择和 Program Files 可执行文件候选；
- Windows 路径大小写/分隔符、引号/空格/Unicode 的 profile 参数解析；
- PowerShell `Get-CimInstance Win32_Process` 进程树和隐藏式 `taskkill` 清理；
- 精确 PID/HWND、前台激活证据、UIA/DOM 边界和 DPI 有界容差；
- Windows PowerShell launcher、daemon readiness 和 Node `pnpm.cmd` 兼容处理。

仍需在 Windows 10/11 实机完成：

1. Edge 默认安装、每用户安装和自定义安装路径；
2. 100%/125%/150% DPI、单屏/双屏、最小化恢复和被遮挡窗口；
3. 记事本输入、Edge 新窗口/弹窗/保存对话框和人工交接；
4. profile 正常关闭、Host 崩溃、Edge broker 存活、lock/DevTools stale recovery；
5. PowerShell/CIM 超时、CUA 不可用、断网和清理失败时的 fail-closed 行为。

在这些项目完成前，不能对外宣称“Windows 三平台全部验收通过”。完整风险和逐项清单见
[Windows 兼容工作完整复核](./windows-compatibility-audit-2026-10-01.md)。

## 推送说明

- 提交目标：当前分支 `codex/a-line-macos-compat-20260928`。
- `.DS_Store` 等本机杂项不纳入提交。
- 推送前确认 `git diff --check`、类型检查和定向回归均通过。
- 本说明与源码、测试、审计文档一起提交；远端分支仍需在推送完成后再次核对提交哈希。

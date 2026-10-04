# Windows 兼容工作完整复核（2026-10-01）

## 1. 审查范围与结论

本次复核的实际环境是 **macOS**。当前分支为
`codex/a-line-macos-compat-20260928`；之前的主线工作是在 **Windows** 环境完成的，
Windows 适配的主要实现来自以 `origin/main` 为基线的主线开发。本次没有 Windows 主机、Windows CUA daemon、Edge
或 PowerShell 实机，因此不能把本机 macOS 的成功运行写成 Windows 实机验收。

**结论：Windows 兼容代码可以有条件推进，不能标记为“Windows 已完整验收”。**

- 代码层已经覆盖 Windows 的默认浏览器、进程树、profile 锁与恢复、精确 PID/HWND
  窗口合同、前台激活拒绝、窗口截图有界重试、PowerShell/CIM 查询和 `taskkill` 清理。
- 离线测试和 CI 矩阵覆盖了 Windows Node 22 的构建/测试路径；本次本机针对性回归也通过。
- 尚缺 Windows 真机的 Edge/CUA/PowerShell/多显示器/DPI/弹窗交接/清理验收，故发布或
  对外宣称“三平台已验证”仍不成立。

## 2. 本次实际验证

### 2.1 当前工作树和分支

- `HEAD`：`5addbdc`（Mac 兼容和 Web 重连修复分支），远端同名分支与提交一致：
  `HEAD...origin/codex/a-line-macos-compat-20260928 = 0 0`。
- 工作树仍有未提交修改；本次只审查和补充文档，没有提交、推送或修改业务代码。
- `git diff --check` 通过。
- 当前分支把受管浏览器选择改为按平台决定：Windows 使用 Edge，macOS/Linux 使用
  Chromium；该差异已经由 `managed-browser-host` 和 `app-runtime` 的平台 fixture 覆盖。

### 2.2 离线回归

本次运行 Windows 相关的适配回归：

```text
pnpm run typecheck
pnpm exec vitest run \
  packages/computer-cua/src/managed-browser-host.test.ts \
  packages/computer-cua/src/managed-browser-profile-recovery.test.ts \
  packages/computer-cua/src/managed-browser-resolver.test.ts \
  packages/computer-cua/src/window-discovery.test.ts \
  packages/computer-cua/src/cua-driver-computer.test.ts \
  packages/app-runtime/src/computers.test.ts \
  packages/app-runtime/src/window-target-matcher.test.ts
```

结果：类型检查通过；7 个测试文件、135 项测试全部通过。测试中的 `win32` 分支是
平台注入/fixture 覆盖，不等于 Windows 原生 API 实机覆盖。此前本工作树的完整回归为
85 个 Vitest 文件、853 项测试及 20 项 TAP 测试通过；它同样是离线证据。

### 2.3 CI 证据

`.github/workflows/ci.yml` 明确包含 `windows-2025 + Node 22.13.0 + x64`，执行
typecheck、Web build、离线 `pnpm test` 和 CLI help。该 job 不启动 CUA、不操作 Edge、
不执行真实 PowerShell 窗口动作，所以只能证明 Windows 构建/契约回归，不证明桌面控制。

### 2.4 当前 Mac 实机证据的边界

当前 macOS 0.22.2 CUA、受管浏览器、手机链路和 A 线简单搜索任务已有成功记录；这些
结果能证明 Runtime/Relay/Provider 链路的一部分，但不能替代 Windows 的 HWND、UIA、
PowerShell、Edge broker 及窗口焦点证据。

## 3. 已确认覆盖的 Windows 适配面

### 浏览器与 profile 生命周期

- `defaultManagedBrowserKind("win32")` 选择 Edge；候选路径覆盖
  `Program Files (x86)` 和 `Program Files` 下的 `msedge.exe`。
- 启动使用独立 `--user-data-dir`、loopback CDP、`--new-window`、禁用首次运行/同步/扩展；
  页面必须通过 CDP 与 CUA owned-window 的精确绑定。
- profile 路径在 Windows 下使用 `win32` 规范化并大小写不敏感；`--user-data-dir` 参数
  解析支持引号、空格、Unicode、`=` 形式，并拒绝目录外相似路径。
- profile 恢复先查活动进程，再检查 lock/DevTools 标记；不确定时 fail-closed，不能
  擅自删除仍可能被 Edge 使用的目录。

### 进程树与清理

- Windows 通过隐藏的 PowerShell `Get-CimInstance Win32_Process` 获取 PID、父 PID 和
  命令行，按 profile 根目录和父子关系收敛 owned process tree。
- Edge broker 导致 Node 子进程 `exitCode` 不可靠时，以进程树查询作为更强的退出证明。
- 优雅关闭后仍存活时，按 PID 调用隐藏的 `taskkill.exe /PID /F`；未能确认树已退出时
  保留 profile 并报告清理失败，不删除可能仍在使用的数据。

### 窗口合同、前台和截图

- 所有受控窗口都绑定精确 `{pid, window_id}`；窗口枚举是只读，不能把相似标题的兄弟
  窗口自动接管。
- `foreground` 模式只在 `bring_to_front` 返回目标 HWND、当前前台 HWND 和 exact effect
  一致时继续；证据缺失或错窗时在截图/输入前拒绝，并明确“未发送输入”。
- 截图只对 `WINDOW_CAPTURE_SCHEMA` 做最多三次只读重试，随后同一目标最多一次
  `get_window_state` fallback；不重放动作、不退回整桌面截图。
- CDP CSS viewport 与 CUA physical pixels 通过实测 content rect 投影；DPI/边界只允许
  有界容差，不能猜固定浏览器工具栏高度或坐标偏移。

### Windows 启动器与命令行

- `scripts/harness.ps1`、`scripts/mobile.ps1` 使用 Windows 参数转义、隐藏启动 CUA/Host/Vite、
  轮询端口/daemon readiness，并只清理自己启动的进程。
- `scripts/test.mjs` 在 Windows 使用 `pnpm.cmd`，Node 24 下通过 `cmd.exe` 处理 `.cmd`
  shim，避免 `EINVAL`。

## 4. 仍需关注的风险与缺口

| 优先级 | 项目 | 判断 | 影响 |
|---|---|---|---|
| P1 | Windows 真机未验收 | 当前 macOS 无法执行 Windows HWND/UIA/PowerShell/Edge 实机测试；CI 也不含真实桌面 | 不能放行“Windows 完整可用”或跨窗口业务任务 |
| P1/P2 | Edge 安装位置 | 当前候选主要是两个 Program Files 路径，没有注册表、`LOCALAPPDATA` 或显式安装发现 | 企业版/每用户安装可能出现“已装 Edge 但找不到可执行文件”；需在 Windows 决定是否补 discovery 或要求显式路径 |
| P2 | PowerShell/CIM 延迟 | 进程树查询有 2.5 秒上限，超时会退回更保守的精确 PID 证据 | 慢机器上可能启动/关闭变慢或保留 profile；这是安全降级，不应改成盲删 |
| P2 | `windowsHide: false` 浏览器启动 | 受管 Edge 本体按当前实现保持可见，辅助进程查询和 launcher 才隐藏 | 需人工确认是否会出现额外控制台窗口；若出现，应只调整显示策略，不放宽 owned-window 校验 |
| P2 | DPI、多屏、最小化恢复 | 代码和 fixture 有几何容差/精确 HWND 检查，但当前没有 Windows 100/125/150% DPI 和多屏实测 | 可能出现合法窗口被拒绝；不能通过扩大容差规避错窗 |
| P2 | 弹窗/新 HWND 交接 | 代码要求重新枚举、精确前台证据和人工确认；历史真实 Windows 交接证据不在本次环境 | 保存对话框、下载器、认证弹层仍需 Windows 实机逐用例验收 |
| P2 | 原生输入与 UIA | Windows fixture 覆盖了拒绝和合同，未覆盖实际 IME、管理员权限窗口、UAC/系统级弹窗 | 不能将“receipt completed”当成文字已逐字生效 |

没有发现应立即修改的高危 Windows 逻辑错误；上述 P1 是验收缺口，P1/P2 是需要实机
确认或产品决策的兼容边界。

## 5. Windows 实机放行清单

在真实 Windows 10/11 主机补跑，且每项使用新 Run 和本地证据：

1. 普通用户权限启动 `scripts/mobile.ps1 check/start`；验证 CUA daemon、Host、Web、
   Relay 配置、Ctrl+C 清理和重复启动。
2. Edge 默认安装、每用户安装和自定义安装路径；验证可执行文件发现、独立 profile、
   CDP loopback、首次启动和再次启动。
3. 100%、125%、150% 缩放；单屏与双屏；窗口最大化、最小化恢复、被遮挡和前台切换；
   核对 PID/HWND、bounds、截图尺寸及输入目标一致。
4. 原生记事本或其他无隐私文本窗口：输入、快捷键、滚动、取消；人工逐字核验。
5. Edge 同标签导航、新窗口、弹窗/保存对话框；确认 `new_window_detected`、人工确认、
   错窗拒绝和不得重放。
6. profile 正常关闭、Host 崩溃、Edge broker 存活、残留 lock/DevTools 标记、目录含
   空格/中文/Unicode、junction/reparse 越界；确认只恢复真正 stale profile。
7. PowerShell 不可用、CIM 超时、CUA daemon 不可用和网络中断；确认 fail-closed、
   明确反馈、无隐式 desktop fallback。
8. 记录完整 Run 路径、代码提交、Node/pnpm/CUA/Edge 版本、DPI/显示器、PID/HWND、
   通过/部分通过/阻塞/未知及清理结果。

## 6. 操作边界

本次只做源代码、测试、CI 配置和文档审查；没有在 Windows 上操作真实桌面，没有调用
付费 Provider，没有提交或推送当前工作树的未提交改动。Mac A 线可以继续；Windows
部分应按 §5 完成实机验收后再单独放行。

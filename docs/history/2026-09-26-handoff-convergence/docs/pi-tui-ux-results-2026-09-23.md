# TUI 体验线结果（2026-09-23）

## 本次切片

首页改为先呈现目标编辑，再按字段显示模型、Computer/窗口目标、当前功能集、Risk Guard 和 Session 状态；底部文字直接说明下一步与当前键盘路径。功能集标签根据当前开关显示为 Baseline、Assisted、Research 或 Custom；`F` 页仍保留全部现有功能开关。

首页采用固定高度的一行摘要，确保目标、模型、Computer/窗口目标、功能集、Risk Guard、当前状态、下一步和键位不会被长内容挤出屏幕。长目标、窗口标题和状态在摘要中显示省略号；按 `D` 或 `PageDown` 总能打开完整详情分页，即使 20 列、12 行也可翻到完整中文目标、窗口标题和错误通知。每页固定显示 Risk Guard、Session、Status 和分页/返回按键；`BLOCKED` 不会被长 notice 覆盖，Esc/Q 返回首页。状态、安全与快捷键均有文字说明，不依赖颜色。

目标编辑中的大写 `F` 可打开高级设置，现有目标草稿会保留。按 `Esc` 离开目标编辑后，草稿继续留在当前 TUI；用户可按 `W` 选择 CUA 窗口，或按 `F` 改设置，再按 `I` 恢复草稿。Guard 配置与原行为未变。启动失败或配置门禁拒绝时，草稿保留并显示状态说明。

启动脚本缺少本地配置时会说明一次性配置字段及密钥位置；TUI 启动提示显示模型、功能 preset 与 Guard 状态，不显示凭据。README 说明 `start` 是 PowerShell 终端入口，需要一次机器配置，不是免命令行桌面 App。新增可选 `scripts/install-harness-shortcut.ps1`，用户显式运行后可创建 Start Menu、桌面或两处快捷方式；安装器用 Unicode Shell Link 接口保留含中文的仓库路径，不覆盖同名链接，不写入本地配置或密钥。点击打开的是 PowerShell 终端 TUI，不是原生 GUI。

## 验证

- `pnpm exec vitest run apps/cli/src/tui.test.ts`：30 项通过。新增覆盖 20/40 列、12 行终端中的完整详情翻页、长中文目标/窗口标题/清理错误、Guard/Blocked 持续可见，以及详情页误按字符或 Enter 不修改草稿、不触发纠正；Esc 返回保留目标草稿。原有审批、暂停、纠正和窗口选择回归也通过。
- `pnpm run typecheck`：通过。
- `pnpm test`：50 个 Vitest 文件、584 项通过；Node TAP 19 项通过，1 项因当前 Windows 测试环境不支持符号链接而跳过。
- `pwsh -NoLogo -NoProfile -File scripts/install-harness-shortcut.test.ps1`：安装器及 harness 的 PowerShell AST、注入临时目录创建两处链接、仓库路径/启动参数/无密钥和同名不覆盖检查通过；未访问真实 Start Menu 或桌面。
- 缺配置提示包括从仓库根目录可直接运行的复制命令和必填 `Model`；启动器选窗提示说明先按 `Esc` 再按 `W`，另提示 `D/PageDown` 详情路径。
- `scripts/travel/run.parse.test.ps1` 已尝试，但在读取仓库根目录 `.harness.local.psd1` 时退出；本工作区没有该本地配置。未创建或改写本地机器配置来绕过该条件。

本轮没有操作桌面或调用模型 API。

## 边界

首页的 Baseline/Assisted/Research 标签是根据当前功能开关匹配出的功能集名称；自定义组合显示 Custom，不是另行保存的 preset 身份。`start` 仍要求先准备被 Git 忽略的 `.harness.local.psd1`，API 密钥仍由本地 env 文件提供。快捷方式本轮只在注入的临时目录做 fixture 验证，没有实际安装或点击验收。尚未做真实用户、屏幕阅读器或物理终端验收；窄列行为由 PTY fixture 验证。

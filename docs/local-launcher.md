# 本地启动器

日期：2026-09-19。本文说明开发预览仓库的本地 Windows 启动入口；它不改变 Runtime、Provider 或 Computer 协议。

## 为什么不配置系统全局变量

API Key 继续保存在仓库根目录、被 Git 忽略的 `.env` 中。Node、CUA 路径和默认功能组合保存在同样被忽略的 `.harness.local.psd1` 中。这样不会覆盖本机其他 Node/OpenClaw 项目，也不会把密钥写进 Windows 用户或系统环境变量。

首次配置时复制 `.harness.local.example.psd1` 为 `.harness.local.psd1`，填写当前机器的路径。可采用以下隔离目录布局（工具须自行准备）：

- `.tools/node/24.19.0/node.exe`；
- `.tools/cua-driver/0.22.2/bin/cua-driver.exe`；
- 根目录 `.env`；
- 私有 named pipe `\\.\pipe\computer-harness-local`。

`.tools/`、`.env`、`.harness.local.psd1` 和 `runs/` 均被 Git 忽略，不随仓库分发。其他成员需要在自己的电脑上准备同版本工具并创建自己的本地配置。

## 日常启动

在仓库根目录运行：

```powershell
.\scripts\harness.ps1 start
```

`start` 会检查隔离 Node，后台启动 CUA daemon，打开 TUI；退出 TUI 后，只关闭由本次启动器创建的 daemon。若相同 socket 上已有 daemon，则复用且不负责关闭。

进入 TUI 首页后：

- 按 `F` 配置下一次 Run 的 Planning、Memory、检索、Batch、Context、Risk Guard 和 Monitor；
- 直接输入目标并按 `Enter`：CUA TUI 仅在本地找到唯一可信窗口时自动绑定并开始；否则保留目标，显示窗口列表供手选。按 `W` 可提前手选窗口或 primary desktop；显式选择始终优先；
- 按 `I` 或 `Enter` 输入目标；
- `Y/N` 处理审批，`P/R` 暂停/恢复，`A` 或 `Ctrl-C` 中止当前 Run；
- `Esc/Q` 退出。

默认 `assisted` 预设启用 Planning、Fact Memory、本地 lexical retrieval、受限输入 Batch、recent Context、Monitor shadow 和 layered Risk Guard。`research` 预设默认关闭 Risk Guard，以免研究/联调被逐次审批阻断；TUI 的 `F` 页面仍可为下一次 Run 切换 `off`/`layered`。可显式切换：

```powershell
.\scripts\harness.ps1 start -Preset baseline
.\scripts\harness.ps1 start -Preset assisted
.\scripts\harness.ps1 start -Preset research
```

`baseline` 关闭这些实验模块；`research` 使用 Entity Memory 和 Monitor guidance，适合功能联调，不代表效果更好。

启动器的 `-RiskGuard off` / `-RiskGuard layered` 可覆盖预设，并同时写入 Run 配置与报告；`off` 只关闭风险评估、审批和风险模型请求，仍保留工具参数校验、Policy/audience、预算、Abort、stale observation、窗口 geometry/coordinate 和未知副作用保护。直接调用 CLI 时对应使用 `--risk-guard off --confirm-risk-guard-off`。

调试或受控 fixture 已经取得目标窗口的 PID 和 window ID 时，可以显式绑定窗口目标：

```powershell
.\scripts\harness.ps1 start -CuaWindowPid <pid> -CuaWindowId <window-id>
```

两个参数必须成对提供；它们是脚本/调试接口，不要求日常用户手填编号，显式编号入口默认 background。日常 TUI 可直接输入 goal；唯一可信窗口由本地匹配自动绑定，多个/没有匹配时保留草稿并进入可滚动的选择列表。也可先按 `Esc` 退出编辑、按 `W` 手选；手选窗口或 desktop 后不会被自动覆盖。菜单选窗使用 foreground 预览，可能激活目标且不保证自动恢复原前台。列表不可用或窗口关闭会明确报错，不自动改成 desktop；直接 `run` 命令未启用 TUI 自动选窗。窗口动作能力以[最新实测边界](./travel-pilot-preparation-2026-09-20.md#115-无人工输入的窗口重测与放行边界)为准。

## 同一 Run 内切换已打开窗口（显式 opt-in）

默认仍是单目标 Run。跨应用开关与起点解耦：auto、手动 window、managed browser、desktop 四种起点均可单独 opt in。TUI 用 `F` 在下一次 Run 的 Feature 页面打开 `Window switching`；`W` 仍是可选的起点/手动窗口选择，不是开启跨应用切换的前置权限。CUA desktop 起点支持列出并切换到受支持窗口；不支持该工具的 OSWorld/external 后端会明确拒绝，不静默忽略。

交互使用时可以这样启动：

```powershell
.\scripts\harness.ps1 start -WindowSwitch
```

在 TUI 首页直接输入 Goal，按 `F` 开启/关闭 `Window switching` 即可；初始 binding 仍由现有 auto/manual/browser/desktop 流程确定，模型随后使用真实 `list_windows` 结果自主选择。PowerShell `-WindowSwitch` 与 CLI `--window-switch` 是同一 per-Run opt-in，不要求额外 PID/HWND 或手工预选目的窗口。这个开关授权本 Run 查看并切换 Host 范围内的窗口，不代表 Host 能证明选择符合 Goal，也不意味着任务业务成功。

仅供非交互脚本或受控 fixture 使用：如果调用方已经通过 Host 获得确切 PID/window ID，可显式绑定：

```powershell
.\scripts\harness.ps1 start -WindowSwitch -CuaWindowPid <pid> -CuaWindowId <window-id>
```

启用后，驱动可报告的所有受支持已打开顶层窗口会列入目录，其中可能有后台或最小化窗口；应用名和标题会发给当前模型，因此可能含文件名/个人信息。切换操作仍需 fresh identity、activation、geometry 和 capture 验证，列出不等于可用。Host-only `windowSwitchAllowedTargets` 省略代表 opt-in 下使用全量支持目录；空数组是 deny-all；非空列表表示精确 scope。对 browser initial/companion，如果该模式要求把自有 browser target 加入显式范围，空数组会在创建资源前作为矛盾配置拒绝；普通 native Run 不会因空目录而扩大范围。仅在 browser initial target 或明确 `managedBrowserCompanion` 时，Host 才将本 Run 自有的确切 browser target 加入非空列表，不会自动加其他窗口。个人浏览器永不因名称而获得 DOM。

启用后，`list_windows` / `switch_window` 由本 Run opt-in 授权，不逐窗口请求审批；每次切换仍独占一轮并经过 Runtime 的参数、ref、scope、身份、预算、Abort、foreground 与 fresh capture 校验。旧观察和坐标立刻失效，只有成功取得新 Observation 后模型才继续。真正高风险副作用仍服从既有 Guard。Managed-browser Host/profile 在切到其他原生窗口时保持到 Run 结束；回切后只在准确匹配 Run-owned browser binding 时重新启用 DOM。失败或结果未知不会沿用旧坐标，也不会自动重试。Browser 仍是当前 binding 时的 legacy popup/foreground-mismatch handoff 不是此能力的通用承诺。

## 托管浏览器与登录状态

希望先进入界面再选浏览器，可运行：

```powershell
.\scripts\harness.ps1 start -Grounding auto
```

在首页按 `W` 可选择 Harness-managed browser 起点；填写 HTTP(S) URL 可启动到对应页面，留空则从空白页开始。native/desktop 起点开启跨应用后，可以使用 Host 默认 browser companion。普通窗口使用 UIA/视觉合同，托管浏览器使用 DOM + UIA，desktop 根据其捕获合同工作。个人浏览器不会因此开放 DOM 权限。

需要保留登录状态时，先确保 CUA daemon 已运行；若未运行，在另一个终端执行 `.\scripts\harness.ps1 daemon` 并保持打开。然后手动登录 Harness 自己的持久 profile：

```powershell
.\scripts\harness.ps1 browser-login -ManagedBrowserUrl "https://example.com" -ManagedBrowserProfileMode persistent -ManagedBrowserProfileLabel daily
```

登录完成后回到终端按 Enter 关闭并保留 profile。可使用同一 label 为其他站点重复此步骤；只登记最多 8 个去重后的 HTTP(S) origin/path，剥离 query/fragment，不读取个人浏览器历史。同一 profile 的后续 Run 恢复已登记站点，登录能否继续有效仍取决于站点会话。

本机 TUI/CLI 从 `.harness.local.psd1` 的 `ManagedBrowserProfileMode`、`ManagedBrowserProfileLabel` 和 profile root 读取本地默认配置；跨应用 companion 沿用该默认偏好，不另加每任务 profile 选择参数。saved/persistent profile 不存在、占用或清理状态不确定时应明确失败，不可静默换成临时 profile。默认 temporary profile 不保留登录。手机 Web 的 Host profile settings 是另一条受管流程：手机发起 prepare/relogin，电脑可见 Edge 中由用户手动登录，再从手机 complete；细节见[手机控制指南](./mobile-control-guide-2026-09-26.md#真手机使用)。Harness 不自动登录，不读取或输出密码、cookie 或 localStorage；不要把个人浏览器 profile 作为托管目录。

## Jev 辅助选窗（可选）

当前默认 `local` 是本地选窗；Jev 是独立的文本候选选择服务，不替代 GLM/Qwen，不直接执行点击，也不授予 DOM 权限。该入口仅用于 CUA TUI，手机 Host 不会因为设置这些字段就启用 Jev。

1. 检查 `.harness.local.psd1` 的 `EnvFile`。`EnvFile = '.env'` 表示读取仓库根目录 `.env`；如果指向其他私有文件，就编辑那个文件。不需要在每个 PowerShell 中重复设置环境变量。
2. 在该文件添加 `TYPESAFE_API_KEY=your_typesafe_key`，保留已有主模型配置。GLM 使用 `ZHIPUAI_API_KEY`；Qwen 使用 `DASHSCOPE_API_KEY` 及所需 endpoint 配置。两种服务密钥不能互相替代。不要覆盖已有 `.env` 或将密钥写进命令行。
3. 在仓库根目录显式启动：

```powershell
.\scripts\harness.ps1 start -Grounding auto -WindowSelector jev -ShareWindowTitles
```

`-ShareWindowTitles` 表示允许向 TypeSafe 发送 goal、候选窗口的应用名与标题，标题可能包含文档名等隐私信息。当前 Jev 请求不含截图、cookie 或输入框值。主 Provider 的截图传输是另一条独立链路。

希望下次不再输入开关，可在 `.harness.local.psd1` 原有配置块内修改以下字段（不要另建第二个 `@{}`）：

```powershell
WindowSelector = 'jev'
ShareWindowTitles = $true
```

随后仍使用 `.\scripts\harness.ps1 start -Grounding auto`。这些字段是启动时配置，不是运行中热切换；修改后重启 TUI。

启动后应看到 `Jev enabled` 提示。输入目标后按 Enter，选中候选还会重新核验窗口身份；不确定、请求失败、候选过多或目标变化时进入手选，不静默改为整桌面。显式手选目标优先，因此不是每次任务都必然请求 Jev。窗口交接仍受 Host 安全条件与人工确认约束。

| 情况 | 检查方式 |
| --- | --- |
| `TYPESAFE_API_KEY is required` | 检查 `EnvFile` 路径及键名；已有进程环境变量优先于 env 文件，不打印密钥排查。 |
| 要求允许分享标题 | 同时提供 `-ShareWindowTitles`，或配置 `ShareWindowTitles = $true`。 |
| `Jev abstained (unavailable)` | 当前客户端将请求/响应错误归为不可用；可能是网络、凭据或服务响应，不代表 GUI 执行失败。先手选，不连续重试。 |
| `uncertain` / `none` / `too_many` | 没有可信的唯一选择或候选超过上限；手选是预期回退，不降低阈值强行执行。 |

当前代码固定使用 `jev-1.13.0` 和 `https://api.typesafe.ai/v1/systemone`；没有可配置的 Jev model/base URL 环境变量。没有证据表明它已稳定降低整任务延迟。

关闭可单次使用 `.\scripts\harness.ps1 start -Grounding auto -WindowSelector local`，或把本机配置改回 `WindowSelector = 'local'`、`ShareWindowTitles = $false`。保留 TypeSafe key 不会触发请求。

## 排查命令

```powershell
# 只检查路径、版本和构建，不读取密钥
.\scripts\harness.ps1 check

# 单独以前台方式启动 daemon，便于看错误
.\scripts\harness.ps1 daemon

# 另一个终端执行无模型、无截图/输入诊断
.\scripts\harness.ps1 doctor

# 停止本地配置对应的 daemon
.\scripts\harness.ps1 stop

# 查看真实 CLI 参数
.\scripts\harness.ps1 help
```

当前 `doctor` 可能以退出码 `1` 返回 `desktop_capture_scope_unconfirmed` / `session_start_invalid`。这代表捕获范围、session 或 cleanup 尚无法证明，不代表 binary、metadata 和 tool inventory 没有连接；不能把它写成完整桌面能力通过。

## 模型与 Hybrid Memory

切换模型：

```powershell
.\scripts\harness.ps1 start -Model qwen3.8-flash
```

聊天 Provider Key 仍从 `.env` 读取。默认 Memory retrieval 是本地 `lexical`，不需要 embedding 服务。选择 `hybrid` 前，需要在 `.harness.local.psd1` 配置 `MemoryEmbeddingEndpoint`，并在 `.env` 放置独立的 `MEMORY_EMBEDDING_API_KEY`；然后在 TUI 的 `F` 页面选择 hybrid。远程 embedding 只参与相关性排序，不验证事实、不扩大权限。

## 构建

启动器默认复用现有 `dist`。源码变化后执行：

```powershell
.\scripts\harness.ps1 check -Build
```

构建时临时把隔离 Node 放到当前子进程 PATH，再调用项目要求的 pnpm；不会修改系统 PATH。

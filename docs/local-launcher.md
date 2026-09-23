# 本地启动器

日期：2026-09-19。本文说明开发预览仓库的本地 Windows 启动入口；它不改变 Runtime、Provider 或 Computer 协议。

## 为什么不配置系统全局变量

API Key 继续保存在仓库根目录、被 Git 忽略的 `.env` 中。Node、CUA 路径和默认功能组合保存在同样被忽略的 `.harness.local.psd1` 中。这样不会覆盖本机其他 Node/OpenClaw 项目，也不会把密钥写进 Windows 用户或系统环境变量。

首次配置时复制 `.harness.local.example.psd1` 为 `.harness.local.psd1`，填写当前机器的路径。当前机器已经使用仓库内隔离目录：

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

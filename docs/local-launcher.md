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

- 按 `F` 配置下一次 Run 的 Planning、Memory、检索、Batch、Context 和 Monitor；
- 按 `I` 或 `Enter` 输入目标；
- `Y/N` 处理审批，`P/R` 暂停/恢复，`A` 或 `Ctrl-C` 中止当前 Run；
- `Esc/Q` 退出。

默认 `assisted` 预设启用 Planning、Fact Memory、本地 lexical retrieval、受限输入 Batch、recent Context 和 Monitor shadow。Risk Guard 由 TUI 的 `live-interactive` profile 默认启用。可显式切换：

```powershell
.\scripts\harness.ps1 start -Preset baseline
.\scripts\harness.ps1 start -Preset assisted
.\scripts\harness.ps1 start -Preset research
```

`baseline` 关闭这些实验模块；`research` 使用 Entity Memory 和 Monitor guidance，适合功能联调，不代表效果更好。

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

# Windows 手机使用入门

本文只写 Windows 从干净 checkout 到手机首次任务的操作顺序。macOS 步骤由 Mac 成员补充并实机核对；不能用这份 Windows 结果代表 Mac 已验收。

## 先了解驱动交付状态

当前 workspace 锁定 CUA SDK 0.22.2；Host 还需要单独的 `cua-driver.exe`，`pnpm install` 不会安装它。官方 stock driver 0.22.2 可提供该版本的基础桌面能力，但不包含本项目自有的 Windows 输入修复。

输入修复曾有自有 fork 的候选构建和本机隔离验证；候选二进制不在 Git checkout 中，也没有可供新成员长期获取、校验和重装的正式分发包。因此不能把“克隆后即包含修复”写成事实，也不要把本机忽略目录里的旧文件当成发行版。需要依赖该输入修复的任务，须等候选有合规的固定版本、来源和校验信息后再使用。stock 与 patched candidate 是两个不同 driver，不能只凭相同的 0.22.2 版本号视为同一构建。

## 1. 准备源码与依赖

在 Windows 原生 PowerShell 5.1 或 PowerShell 7 中，从仓库根目录执行。本文使用 `pnpm.cmd`，不依赖 PowerShell 7 才有的 `$IsWindows`。建议 checkout 和 CUA driver 放在只含 ASCII 字符的路径，避免把中文路径交给 Node 或 daemon 时出现编码差异。

```powershell
git clone https://github.com/wszkxlllll/Computer-Harness.git
Set-Location .\Computer-Harness
# 如需特定功能，检出团队指定的分支或 commit
node --version
npm.cmd install --global pnpm@11.19.0
pnpm.cmd --version
pnpm.cmd install --frozen-lockfile
```

Node.js 至少为 22.13.0，pnpm 固定为 11.19.0；确认版本输出符合要求。若 pnpm 已安装，直接检查版本后安装依赖即可。遇到 PowerShell 的 pnpm 脚本策略问题时继续调用 `pnpm.cmd`，不必改执行策略。若当前目录已有非空的 `Computer-Harness` 文件夹，Git 会拒绝克隆，不会覆盖它；换到其他父目录再执行。若 Windows 用户名或当前路径含中文，先切到已有的 ASCII-only 目录，再用默认克隆命令；也可指定一个新的 ASCII-only 目标目录。

## 2. 准备 CUA daemon

从[官方 CUA Driver 0.22.2 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.22.2)下载与电脑架构匹配的 Windows binary zip（x86_64 或 ARM64）。release 页面列有 SHA-256；先运行下面的命令，并将结果与该页面对应资产的 checksum 比较，再解压得到 `cua-driver.exe`：

```powershell
Get-FileHash -LiteralPath '<下载的 binary zip 路径>' -Algorithm SHA256
Expand-Archive -LiteralPath '<已校验的 binary zip 路径>' -DestinationPath '<本机解压目录>'
```

锁文件中的 SDK 版本与 daemon 必须配套，使用 0.22.2。

此步骤安装的是 **官方 stock**。候选输入修复不是此 zip 的内容；官方版本号相同也不表示带有候选修复。

## 3. 填本机配置和私有环境变量

复制示例配置；若本机文件已存在，不要覆盖：

```powershell
if (-not (Test-Path -LiteralPath .harness.local.psd1)) {
  Copy-Item -LiteralPath .harness.local.example.psd1 -Destination .harness.local.psd1
}
```

编辑 `.harness.local.psd1`，把以下项目替换成自己机器上的值，其余可先保留示例默认值：

```powershell
NodePath = '<本机 node.exe 的绝对路径>'
EnvFile = '.env'
CuaBinary = '<已校验并解压出的 cua-driver.exe 路径>'
Model = 'glm-5.3-flash'
```

`Model` 目前由 `scripts/mobile.ps1` 限定为 `glm-5.3-flash` 或 `qwen3.8-flash`。选 GLM 时在下一步配置 GLM 凭据；选 Qwen 时将此值改为 `qwen3.8-flash` 并配置 DashScope 凭据。保持示例中的 `CuaSocket`，或确保自行修改后 Host 和 daemon 使用完全相同的值。配置文件仅存本机路径和选项，不放 API key。

在仓库根目录创建私有 `.env`。它已被 Git 忽略。按需填写以下占位项，不要把尖括号占位文字原样保存：

```dotenv
# GLM 模型凭据；仅在 Model=glm-5.3-flash 时需要
ZHIPUAI_API_KEY=<GLM 提供方签发的密钥>
# Qwen 模型或语音输入所需；选 GLM 且不用语音输入时可不填
DASHSCOPE_API_KEY=<DashScope 提供方签发的密钥>

# 手机远程配对必填：按 Relay 管理员提供的本机身份和公开地址填写
HARNESS_RELAY_URL=https://<Relay 域名>
HARNESS_HOST_ID=<Relay 分配给这台电脑的唯一 ID>
HARNESS_RELAY_CREDENTIAL=<Relay 中为该 ID 登记的随机凭据>
HARNESS_RELAY_PUBLIC_ORIGIN=https://<Relay 域名>

# 可选：语音输入。填 workspace ID，或改用下方显式 WSS endpoint
DASHSCOPE_WORKSPACE_ID=<语音服务 workspace ID>
# DASHSCOPE_REALTIME_ASR_ENDPOINT=wss://<语音服务提供方的实时识别地址>
```

Host 要求四个 `HARNESS_RELAY_*` 项全填或全不填；只填一部分会在启动时报错。ID 和至少 32 字节的随机凭据必须与 Relay 服务端登记相同，每台电脑使用独立身份。此电脑端启动器不会安装或启动 Relay；手机使用要求 Relay 已部署、手机网络可达且使用手机信任的 HTTPS。仅用本机 localhost Relay 可预览电脑页面，不能让手机连接。若你负责部署 Relay，服务端配置、TLS 和监听方式见 [Relay 运维说明](../apps/relay/README.md)；不要把服务端配置文件复制到此电脑的 `.env`。

语音输入需要 `DASHSCOPE_API_KEY`，并设置 `DASHSCOPE_WORKSPACE_ID` 或 `DASHSCOPE_REALTIME_ASR_ENDPOINT`。Host 启动时读取配置，修改 `.env` 后要重启。语音通知播报走手机浏览器的语音合成，不需要 ASR 密钥。

## 4. 检查并启动电脑 Host

```powershell
.\scripts\mobile.ps1 -Command check
.\scripts\mobile.ps1 -Command start -Build
```

`check` 检查 Node、环境文件和模型设置，并报告 Host/Web 构建文件是否存在；它不验证 driver 二进制或 Relay 在线状态。首次启动加 `-Build` 会构建 Host 与 Web。启动器会复用配置 socket 上已就绪的 daemon；若没有，就在后台启动配置的 daemon。启动窗口保持打开，直到停止服务。

如果 PowerShell 的执行策略阻止启动脚本，可在仓库根目录运行下面这条命令。`Bypass` 只对新启动的这个 PowerShell 进程生效，不会改用户或系统的全局执行策略：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\mobile.ps1 -Command start -Build
```

在运行这台 Host 的电脑浏览器打开 `http://localhost:4317/connect`，点“生成配对二维码”。用手机相机扫描；二维码必须指向手机可访问的 HTTPS Relay，而不能是 localhost。扫码只会发起请求，不会授权：确认电脑页面的“待处理请求”中显示的是自己的手机，再点“允许这台手机”。手机显示已连接后点“打开任务列表”。

如果二维码警告它指向本机地址，或 Host 日志提示 Relay 未连接，先核对上面四项 Relay 设置及服务端状态，再重启 Host、生成新码。Relay 重启后需要重新配对。

## 5. 手机发任务、设置语音和登录状态

在手机“新任务”页输入目标，选择起点并点“开始任务”。页面默认推荐“打开网站”；可以留空网址从空白受管浏览器开始，也可以填完整的 `https://` 地址。首次先做只读、无外发的简单任务。手动窗口和“整个桌面（高级）”会扩大电脑画面或窗口信息的暴露范围，开始前关闭不相关的敏感窗口。

语音输入配置完成并重启 Host 后，打开“设置 → 语音功能”，确认出现“语音输入测试”，按需测试麦克风和识别。音频会发送给所配置的 ASR 提供方。要播报任务通知，在同一设置中开启“朗读任务关键通知”；播报能力由手机浏览器和设备语音支持决定。即使没有语音输入，任务文字仍可使用。

要让网页任务复用这台电脑的专用登录状态：手机打开“设置 → 浏览器与登录状态”，选择“本机已准备的登录状态”，点“准备登录状态”；在电脑出现的 Harness 受管 Edge 窗口里自行登录，再回手机点“我已在电脑完成登录”。登录信息保存在这台电脑的 Harness 受管浏览器中，不会从个人浏览器或手机复制。网站之后仍可能要求重新登录。

## 6. 停止与排错

回到启动 Host 的 PowerShell 窗口按 `Ctrl+C`。启动器会停止 Host，以及本次启动器创建的 daemon；若它复用了原本已运行的 daemon，不会替你停止该进程。日志写入 `.harness.local.psd1` 所设输出目录下的 `mobile` 子目录；分享前检查并脱敏。

| 现象 | 检查 |
| --- | --- |
| pnpm 安装或脚本 wrapper 异常 | 用 `pnpm.cmd --version` 和 `pnpm.cmd install --frozen-lockfile`；确认没有从 WSL/Git Bash 生成依赖后在 PowerShell 混用。 |
| 启动脚本被执行策略阻止 | 在仓库根目录运行上面的 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\mobile.ps1 -Command start -Build`；只影响该进程，不修改全局策略。 |
| 启动报告缺少 Host/Web 构建 | 重新运行第 4 节的 `start -Build` 命令，查看终端中的构建错误。 |
| CUA daemon 未就绪 | 核对 `CuaBinary` 指向真实文件、版本是 0.22.2，且没有其他服务占用配置的 `CuaSocket`；检查输出目录中的 `cua-daemon` 日志。 |
| 手机打不开二维码或 Host 提示 Relay 未连接 | 四项 Relay 值必须完整并与服务端一致；Relay URL 应从手机可达，二维码使用受信任的 HTTPS 地址。电脑本机的 `localhost` 只能由电脑访问。 |
| 语音输入不可用 | 核对 DashScope key 和 workspace ID/实时识别 WSS endpoint，重启 Host 后在设置里刷新并测试。播报可用不代表 ASR 已配置。 |
| stock 输入与预期不一致 | 确认当前使用的是官方 stock 还是独立 patched candidate。stock 不含本项目输入修复；结果未知的输入动作不要盲目重发。 |
| Host 端口已占用 | 以 `-HostPort <未占用端口>` 启动，并在电脑打开对应端口的 `/connect` 页面。 |

Relay 配对、自动化和手机真机验收是不同证据。成功扫码或看到任务页面，不等于输入修复、真实任务结果、手机语音和 macOS 均已验收。

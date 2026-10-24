# 用手机控制电脑

手机用浏览器打开控制页面，电脑负责执行任务。电脑需要保持开机、联网，并停留在已登录的桌面；手机不用安装 App。

两端通过一个 **Relay（中继服务）** 连接：电脑上的 Host 主动连到 Relay，手机也访问同一个 Relay。Host 运行在你要控制的电脑上；Relay 由团队管理员运行在有 HTTPS 地址的服务器上，可以供多台电脑使用。你的电脑不需要开放公网端口。

先向提供服务的人领取三项连接资料：**Relay 的 HTTPS 地址、这台电脑的 Host ID、连接凭据**。这些资料由管理员准备，不需要使用者研究服务器配置。本项目目前没有向所有人开放的公共 Relay；团队自己的服务器也不是公共入口。如果你是第一次搭建服务的人，先完成本文末尾的[自行部署 Relay](#自行部署-relay)，然后回到下面的步骤。

## 1. 在 Windows 电脑上准备并启动

### 第一次使用：准备一次即可

电脑需已安装 [Git for Windows](https://git-scm.com/downloads/win)、[Node.js 24 LTS](https://nodejs.org/en/download) 和 Microsoft Edge。已有 Node.js 22.13.0 或更高版本可以继续使用。安装后重新打开 PowerShell。

打开一个用于存放项目的文件夹，在地址栏输入 `powershell` 并回车。推荐使用便于查找的短路径，例如 `C:\Harness`；已有中文路径不必为此搬动项目。复制运行：

```powershell
git clone https://github.com/wszkxlllll/Computer-Harness.git
Set-Location .\Computer-Harness
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-mobile.ps1
```

已有源码时，在项目文件夹打开 PowerShell，只运行最后一行。准备程序会自动找到 Node、创建电脑配置、下载并校验与项目匹配的官方 CUA 驱动、安装锁定的依赖。它不会启动电脑控制任务。

首次准备时，按顺序填写四项：

| 提示 | 填什么 |
| --- | --- |
| Relay 地址（HTTPS） | 管理员提供的地址，例如 `https://relay.example.com` |
| 电脑编号（Host ID） | 管理员为这台电脑分配的编号 |
| 连接凭据 | 与这个编号配套的连接凭据 |
| 模型密钥（GLM） | 你的 GLM API 密钥；用于调用任务模型，会按提供方规则计费 |

两项密钥输入时不会显示。它们只保存在这台电脑的私有 `.env` 文件中；不要把这个文件发给别人。连接资料不等于模型密钥，Relay 管理员也不需要你的模型密钥。

准备程序不覆盖已有配置、密钥或驱动。若它提示已保留旧配置，请[展开“需要时再设置”](#需要时再设置)，查看“已有配置怎么填写”。下载或安装因网络失败时，解决网络问题后重跑同一条准备命令即可。

### 启动电脑端

在同一个项目文件夹执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\mobile.ps1 -Command start -Build
```

首次启动会构建页面和电脑端程序，等终端显示启动信息后，在**这台电脑**的浏览器打开 [连接手机](http://localhost:4317/connect)。保留 PowerShell 窗口；它关闭后手机就不能继续控制电脑。

以后使用，在项目文件夹运行下面这一行即可。更新过源码时用上面的 `-Build` 命令重新构建。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\mobile.ps1 -Command start
```

## 2. 手机扫码，电脑确认

1. 在电脑的“连接手机”页面点“生成配对二维码”。
2. 用手机相机扫码，在浏览器打开链接。
3. 回到电脑，确认待处理请求来自自己的手机，点“允许这台手机”。
4. 手机显示连接成功后，点“打开任务列表”。

二维码有效期为 90 秒，过期后重新生成。手机打开的是 Relay 的 HTTPS 地址；`localhost:4317` 只供电脑本机使用，不要在手机里输入它。

## 3. 发起第一个任务

在手机“新任务”页选择“打开网站（推荐）”，填写网站地址和目标，再点“开始任务”。例如，网址填 `https://example.com`，目标填“阅读这个页面，用中文告诉我它的标题和用途”。这个例子不需要登录或发送信息。

电脑会打开 Harness 专用的 Edge 窗口。手机可以查看进度和结果，遇到确认请求时按页面提示处理。首次使用先从简单的网页任务开始；长篇中文输入、复杂文稿编辑和整个桌面任务仍有已知限制。

用完后，回到电脑的 PowerShell 窗口按 `Ctrl+C`。它会停止电脑端，以及本次启动的 CUA 驱动；原本已运行的驱动会保留。

<a id="需要时再设置"></a>
<details>
<summary>需要时再设置：登录状态、语音、旧配置与排错</summary>

**使用网站登录状态。** 手机打开“设置 → 浏览器与登录状态”，选择“本机已准备的登录状态”，点“准备登录状态”；在电脑出现的 Harness Edge 窗口中自行登录，再回手机点“我已在电脑完成登录”。后续任务可复用这份专用登录状态；它不会复制个人浏览器或手机里的登录信息。

**语音输入。** 在电脑的 `.env` 追加以下两项，填入自己的 DashScope 资料，然后重启电脑端：

```dotenv
DASHSCOPE_API_KEY=填入你的DashScope密钥
DASHSCOPE_WORKSPACE_ID=填入你的语音服务workspace_ID
```

如果服务方提供的是实时识别 WSS 地址，可用 `DASHSCOPE_REALTIME_ASR_ENDPOINT` 替代 workspace ID。手机进入“设置 → 语音功能”测试麦克风。语音会发送给所配置的识别服务；不配置也可以正常输入文字。

**朗读通知。** 在手机同一设置页开启“朗读任务关键通知”，使用手机浏览器的语音合成，无需语音识别密钥。

**更换模型。** 默认使用 GLM。需要 Qwen 时，把 `.harness.local.psd1` 中的 `Model` 改为 `qwen3.8-flash`，并在 `.env` 填写 `DASHSCOPE_API_KEY`，然后重启。

### 已有配置怎么填写

准备程序自动生成 `.harness.local.psd1` 中的 Node 路径；驱动位于 `.tools\cua-driver\0.22.2\bin\cua-driver.exe`。通常不用编辑这个文件。已有配置指向别处时，程序会保留原值；如果那个文件已不存在，按报错修正路径后再运行。

已有 `.env` 不会被覆盖。需要补 Relay 连接资料时，在文件中填写下面四项；两个地址通常相同，ID 和凭据必须与管理员登记的完全一致：

```dotenv
HARNESS_RELAY_URL=https://relay.example.com
HARNESS_HOST_ID=管理员分配的ID
HARNESS_RELAY_CREDENTIAL=管理员提供的连接凭据
HARNESS_RELAY_PUBLIC_ORIGIN=https://relay.example.com
```

同时保留所选模型的密钥：默认 GLM 使用 `ZHIPUAI_API_KEY`。把示例文字替换成实际值，以 UTF-8 保存，不要将占位文字原样使用。改完后重启电脑端。

### 遇到问题

| 现象 | 怎么处理 |
| --- | --- |
| 找不到 `git`、`node` 或 `npx` | 安装或修复上面对应的软件，关闭并重新打开 PowerShell。 |
| 准备时下载或依赖安装失败 | 检查网络能否访问 GitHub 和 npm，再运行准备命令；它会保留已填写的资料。 |
| 配置检查通过，但启动仍失败 | 检查仅确认本机基本配置，不代表 Relay 在线或驱动已就绪。查看启动窗口中最后一条错误。 |
| CUA 驱动未就绪 | 查看项目 `runs\local\mobile` 下的 `cua-daemon` 日志；旧配置还需确认 `CuaBinary` 文件真实存在且与 SDK 同为 0.22.2。 |
| 电脑不能生成二维码，或手机打不开链接 | 确认 Relay 服务在线、两端都能访问它；核对 `.env` 的四项连接资料。手机地址应以 `https://` 开头且没有证书警告。 |
| 配对失效 | Relay 重启后需要重新扫码、由电脑再次允许。 |
| 4317 端口已被占用 | 先确认是否已经启动过 Harness；如果是，使用原来的窗口和连接页面。 |
| 输入后的文字与目标不符 | 停止并检查实际内容，避免重复发送或覆盖；当前版本不能保证复杂中文编辑任务可靠。 |

### 驱动和平台范围

准备程序使用[官方 CUA Driver 0.22.2](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.22.2)，固定校验该发布页给出的 SHA-256，与仓库锁定的 SDK 0.22.2 配套。驱动用于操作电脑，依赖安装不会自动提供这个独立程序。

这个旧版不含后续的 Windows 输入修复。[官方 0.38.0](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0) 已经合入相关修复，但当前项目尚未完成配套 SDK 升级验证，不能只把驱动替换为最新版。普通用户无需自行选择驱动或寻找团队私有构建。本文先引导简单网页任务，不把首次配对成功当成所有电脑操作都可靠的证明。

macOS 的启动与权限准备由 Mac 成员补充、实机核对；上面的 `.ps1` 准备和启动命令只适用于 Windows。

</details>

<a id="自行部署-relay"></a>
<details>
<summary>自行部署 Relay（仅服务维护者需要）</summary>

这一节由**服务维护者**完成一次。服务上线后，每位使用者只需领取连接资料，按前面的 Windows 步骤操作。Relay 负责连接和转发，不运行模型；Host 和 CUA 仍在使用者的电脑上。Relay 运营方能接触经它转发的任务和截图，应由使用者信任的人维护。

以下是独立 Linux 服务器上的最小部署流程：Git、[Node.js 24 LTS](https://nodejs.org/en/download)（最低 22.13.0）、Caddy 和 systemd 已就绪；有自己的域名，DNS 的 A/AAAA 记录指向服务器，外部可访问 80/443。Caddy 按[官方安装说明](https://caddyserver.com/docs/install)安装。不要在已由 Nginx 或其他站点占用 80/443 的服务器直接启动第二套代理；已有站点应由维护者把下方转发规则接入现有代理。

Node 应安装在服务账号能执行的系统共享位置，如 `/usr/local/bin` 或 `/opt`；下方服务隔离配置不能访问个人 home 目录里的 Node。

### A. 下载并构建

在服务器终端执行，`APPROVED_COMMIT` 换成实际准备交付的版本或完整 commit，与使用者电脑上的源码版本保持一致：

```sh
test ! -e /opt/computer-harness || exit 1
sudo install -d -o "$(id -un)" -g "$(id -gn)" /opt/computer-harness
git clone https://github.com/wszkxlllll/Computer-Harness.git /opt/computer-harness
cd /opt/computer-harness
git checkout --detach APPROVED_COMMIT
node --version
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm exec tsc --build packages/relay-connector/tsconfig.json apps/relay/tsconfig.json --pretty false
pnpm --filter @computer-harness/web build
```

第一行在目录已存在时停止，避免改动已有服务；已有部署由维护者按原来的更新方式处理。若 npm 全局安装需要系统权限，由维护者按本机 Node 安装方式处理。

### B. 为第一台电脑生成连接资料

先创建专用服务账号和配置目录：

```sh
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin computer-harness-relay
sudo install -d -o computer-harness-relay -g computer-harness-relay -m 0700 /etc/computer-harness
```

将下面的域名替换为自己的地址。命令会在服务器私有配置中生成一个随机 Host ID 和 32 字节随机凭据，不把凭据打印到终端；已有配置时会拒绝覆盖：

```sh
relay_node="$(command -v node)"
sudo -u computer-harness-relay env RELAY_PUBLIC_ORIGIN=https://relay.example.com "$relay_node" --input-type=module -e '
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
const config = {
  publicOrigin: process.env.RELAY_PUBLIC_ORIGIN,
  listen: { host: "127.0.0.1", port: 8787 },
  webRoot: "/opt/computer-harness/apps/web/dist",
  hostCredentials: [{ hostId: randomBytes(12).toString("hex"), credential: randomBytes(32).toString("base64url") }]
};
writeFileSync("/etc/computer-harness/relay-config.json", JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
'
```

维护者通过私密配置查看工具读取该文件，把 `publicOrigin`、对应条目的 `hostId` 和 `credential` 安全交给该电脑的使用者，分别填入准备程序的三个连接提示。每增加一台电脑，在 `hostCredentials` 中增加一组独立随机 ID/凭据；不能把同一组分给多台电脑。不要把这个配置放进 Git，或把凭据粘贴到公开聊天中。

### C. 让 Relay 常驻运行

先运行 `command -v node` 找到 Node 的绝对路径。将以下内容保存为 `/etc/systemd/system/computer-harness-relay.service`，把 `ExecStart` 中的 `/usr/bin/node` 换成刚查到的路径；该路径及源码目录需允许专用服务账号读取和执行。

```ini
[Unit]
Description=Computer Harness Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=computer-harness-relay
Group=computer-harness-relay
WorkingDirectory=/opt/computer-harness
Environment=RELAY_CONFIG_FILE=/etc/computer-harness/relay-config.json
ExecStart=/usr/bin/node /opt/computer-harness/apps/relay/dist/index.js
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

启动服务：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now computer-harness-relay
sudo systemctl status --no-pager computer-harness-relay
```

### D. 开通手机使用的 HTTPS 地址

独立新服务器使用 Caddy 时，将站点加入 `/etc/caddy/Caddyfile`，域名与 B 步一致；不要覆盖已有站点：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

Caddy 会为满足 DNS/端口条件的公开域名申请并续期 HTTPS 证书，并代理 WebSocket 与实时响应；不需要手动给电脑开放端口。这里不启用访问日志，避免保存配对链接的查询参数。规则依据：[自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[反向代理与流式传输](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
curl --fail --show-error https://relay.example.com/healthz
```

服务器只需向外提供 HTTPS 入口和证书申请所需的 HTTP 端口，8787 保持仅本机监听。手机打开 `https://relay.example.com` 应能看到页面且没有证书警告。`/healthz` 成功只说明 Relay 可访问；还要让一台 Windows 电脑按前文启动，手机在不同网络扫码，经电脑确认后发起简单任务，才算连接流程走通。

维护时使用 `sudo systemctl restart computer-harness-relay` 重启，使用 `sudo journalctl -u computer-harness-relay -n 50 --no-pager` 查看近期错误。Relay 重启会清空配对会话，手机需要重新扫码。

</details>

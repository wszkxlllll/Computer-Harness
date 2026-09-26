# Harness Relay

当前交付包含本机可运行、可测试的 Relay 服务、Host 出站 WSS 连接器和 Web 前端静态托管入口。没有部署到公网，也没有进行手机扫码、跨网络可达性或性能验收；服务器的实际区域、操作系统、域名和 TLS 证书仍待配置。

## 数据路径与边界

```text
手机浏览器 -- HTTPS / SSE --> TLS 反向代理 --> Relay -- 已鉴权 WSS --> 电脑 Host
                                      |                           |
                                      +-- allowlisted API only ---+--> RemoteRunApi
```

- 电脑只建立出站 WSS；Host 和 Relay 都默认只绑定回环地址，普通用户无需给电脑开放公网入站端口。
- Relay 只转发明确列出的 `/api/session`、配对、Run、命令回执、SSE 和 Run asset 路由。`/api/local/*` 在任何情况下都拒绝；不接受客户端填写本机地址、任意路径或文件路径。
- 配对二维码用 90 秒一次性凭据。Host 先向 Relay 注册凭据的 SHA-256 摘要；Relay 收到手机请求后再由电脑本机用户确认。Relay 为公开配对请求分配新的随机 ID，避免不同 Host 的本地 ID 冲突。
- 配对后，手机通过 `GET /api/windows` 获取仅含 opaque token、应用名和标题的候选窗口。token 绑定设备、十分钟过期且单次使用；刷新候选列表会撤销该设备的旧 token 集。Host 启动 Run 前重新发现并核验目标身份，不能依赖旧列表。Relay 的 `/api/runs` 启动体只接受 `{commandId,goal,targetToken}`，拒绝 PID、HWND、窗口句柄和路径字段。
- 通过确认后，Host 的不透明 session token 只在 Host 与 Relay 的认证 WSS 信道内传输；Relay 会在后续请求和 SSE 订阅信封中交还给对应 Host，绝不返回浏览器。Relay 另发随机 HttpOnly、SameSite=Strict、HTTPS 下带 Secure 的 Relay cookie。每次请求由该 cookie 选择固定的 Host 和 device；POST/DELETE 另检查同源 Origin 与 CSRF token。
- SSE 按同一 device 和 Run 订阅。Host 或 Relay 断线时关闭流，浏览器通过事件游标重新订阅并刷新 Run 快照。Relay 不排队或重放 GUI 命令；已发出但未收到回执的 POST 返回 outcome-unknown，手机必须先刷新状态。
- Relay 仅在进程内保留配对摘要、Relay cookie 到 Host session 的映射、待处理响应和活动 SSE；不写任务、截图或轨迹到磁盘。Relay 重启会清除这些映射，需重新配对。Host 重连不会清除 Relay 现存 session；未完成的命令不会被重发。
- Wire 与 HTTP 边界有大小限制：JSON 请求 32 KiB、JSON 响应 4 MiB、单个 SSE 事件 64 KiB、asset 8 MiB、WSS frame 12 MiB。Relay 对慢 SSE 连接和 Host 侧积压也设有上限。
- TLS 在所选服务器/反向代理终止，Relay 运营者可以接触经授权的任务请求、投影事件和截图字节。当前没有端到端加密，不应把普通 TLS 中继描述为 Relay 不可读取。
- Relay 和 Host 均关闭应用层请求日志。公网反向代理也必须避免记录配对 URL 的 query、请求 body、cookie 和截图内容。

## 本机验证

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @computer-harness/web build
pnpm exec tsc --build packages/relay-connector/tsconfig.json apps/relay/tsconfig.json apps/host/tsconfig.json --pretty false
pnpm exec vitest run packages/relay-connector/src/index.test.ts apps/relay/src/routing.test.ts apps/relay/src/server.test.ts apps/host/src/relay-roundtrip.test.ts
```

本机 Relay 测试使用 loopback HTTP/WSS 与假 Host，覆盖一次性配对、Host ID 隔离路由、HttpOnly cookie、CSRF、SSE、Host 重连、设备撤销、未授权 Origin、`/api/local/*` 拒绝，以及断线后的未知回执不重放；Host roundtrip 测试再以真实 ApplicationSession 和 Host connector 覆盖本机确认、Run 请求及事件。它们不等于真手机、蜂窝网络、公开域名、TLS 反向代理或公网扫码验收。

本地启动时，将 `apps/relay/relay-config.example.json` 复制为 `apps/relay/relay-config.json`，把 `publicOrigin` 改为 `http://127.0.0.1:8787`，并在本机填入 Relay 与 Host 共用的随机 host ID 和至少 32 字节凭据。Host 的私有 env 文件设置 `HARNESS_RELAY_URL`、`HARNESS_HOST_ID`、`HARNESS_RELAY_CREDENTIAL`、`HARNESS_RELAY_PUBLIC_ORIGIN`；本机 Relay URL 可用 `http://127.0.0.1:8787`。这个 Relay 配置文件已加入 `.gitignore`；不要把凭据写进聊天、访问日志或版本库。Host 客户端只允许明文连接到明确启用的 localhost 开发地址。Provider API key 仍只留在电脑上的 Host env 文件。

PowerShell 启动示例：

```powershell
$env:RELAY_CONFIG_FILE = (Resolve-Path 'apps\relay\relay-config.json').Path
pnpm --filter @computer-harness/relay start
```

启动后，Relay 只监听 `127.0.0.1:8787`；Web 静态文件来自 `apps/web/dist`。本机二维码里的 localhost 只指向生成二维码的那台电脑，不能证明手机能访问。

## Windows 电脑本机启动

在已配置的 Computer-Harness-Pi 仓库根目录打开 PowerShell。若本机配置文件尚不存在，先从示例创建它并按隔离仓库实际位置填写 Node、CUA 和输出路径；Provider API key 和 Relay 连接凭据放在 EnvFile 指向的私有 env 文件，不要写入配置示例或命令行：

若此隔离仓库尚未安装 workspace 依赖，先在仓库根目录执行 `pnpm install --frozen-lockfile`。启动器可在 Host/Web 构建目录缺失时自动构建，但不会替用户安装依赖。

```powershell
if (-not (Test-Path .harness.local.psd1)) { Copy-Item .harness.local.example.psd1 .harness.local.psd1 }
.\scripts\mobile.ps1 -Command check
.\scripts\mobile.ps1 -Command start
```

check 验证 Node/env/model 配置并报告 Host/Web 构建文件状态，不启动进程；默认 start 使用同一个 Host 提供已构建的 Web 控制台，不需要额外端口参数。启动后在这台电脑的浏览器打开 http://localhost:4317。Host 会复用已运行的 CUA daemon；若 daemon 未运行，启动器会在后台启动它。按 Ctrl+C 停止 Host 和本次启动器创建的 Vite/CUA 进程；不会停止启动器之前已在运行的 CUA daemon。CUA 与开发版 Vite 的输出日志位于配置的 OutputRoot\mobile 目录。

在尚未配置 Relay 时，本机页面生成的 localhost 配对地址只适合在这台电脑上预览，手机无法通过该地址连接。Host env 文件配置好 Relay URL、Host ID、共享凭据及 HTTPS public origin，且 Relay/HTTPS 入口已部署后，二维码才会指向 Relay 域名供手机扫码；这不表示本指南已完成公网或真机验收。

## 公网服务器准备建议

用户已确认有一台 2 vCPU、2 GB 内存服务器。根据当前单 Host、小团队试用设计，建议从现有机器开始；约 20 GB 磁盘、5–10 Mbps 网络为工程估算，不是本项目压测结论。Relay 不运行模型、不需要 GPU、数据库、对象存储或 Kubernetes；截图只短暂经过内存，持续带宽主要取决于截图数量和大小。

尚未实测并需上线前确认的项目：Linux 发行版与版本、服务器区域、域名 DNS、TLS 证书、服务账号、运营方访问日志策略和真实蜂窝网络质量。公网访问只需要反向代理的 HTTPS/WSS 入口（443）；Relay 的 8787 和电脑 Host 的本机控制端口不应向公网开放。不要通过 HTTP 生成或打开含一次性 token 的二维码链接。

### Linux 构建与凭据

本轮 Relay/Connector 集成测试使用 Node.js `24.19.0`；可将其作为可复现的 staging 基线。面向公网前，应从 [Node.js 官方发布页](https://nodejs.org/en/about/previous-releases)选择当前仍受维护且获运维批准的 Node 24 补丁版本、校验发行文件，并在升级后重跑构建与测试。项目声明最低版本为 `22.13.0`；仓库的 `package.json` 将 pnpm 锁为 `11.19.0`。

GitHub 协作者使用独立交接分支，不使用尚未合并这些改动的默认分支。先克隆到新的目录并记录部署 SHA：

```sh
git clone --branch codex/mobile-control-handoff-20260926 --single-branch https://github.com/wszkxlllll/Computer-Harness.git computer-harness-mobile
cd computer-harness-mobile
git rev-parse HEAD
```

然后执行下方从 `node --version` 开始的安装、构建和测试命令。部署到 systemd 时，将已验证源码放入新的 versioned release 目录，并记录上述 SHA。

可选的离线来源是已交付的 `computer-harness-mobile-source-20260926-r2.zip`，它是归档前的冻结检查点，不包含本次文档迁移与 CI 修正，不随分支更新。该 ZIP 不保存在 Git 仓库；仅持有 ZIP 及配套校验文件时才使用以下解压步骤：

```sh
sha256sum -c SHA256SUMS.txt
release=/opt/computer-harness/releases/2026-09-26-02
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 "$release"
unzip computer-harness-mobile-source-20260926-r2.zip -d "$release"
cd "$release"
sha256sum -c SOURCE-MANIFEST.sha256
node --version
sudo npm install --global pnpm@11.19.0
pnpm --version
pnpm install --frozen-lockfile
pnpm --filter @computer-harness/web build
pnpm exec tsc --build packages/relay-connector/tsconfig.json apps/relay/tsconfig.json apps/host/tsconfig.json --pretty false
pnpm exec vitest run packages/relay-connector/src/index.test.ts apps/relay/src/routing.test.ts apps/relay/src/server.test.ts apps/host/src/relay-roundtrip.test.ts
```

源码 ZIP 包含构建 Relay/Web/Host 和其 workspace 依赖所需的源文件、workspace 配置与锁文件，但不含 `.git`、`node_modules`、`dist`、运行数据、浏览器配置、截图或私密 env/Relay 配置。构建会在源码根目录生成 `apps/web/dist` 和 workspace `dist`。Relay 配置中的 `webRoot` 按配置文件所在目录解析；若配置放在 `/etc`，请设为构建目录的绝对路径或下面 systemd 示例中的稳定 `current` 路径，不能照搬相对于 `apps/relay/` 的示例值。

Relay 配置和 Host env 文件必须分别由受控的密钥管理或配置管理直接写入，不要将凭据放在 shell 命令参数、shell 历史、终端输出、CI 输出或代理访问日志中。两份文件分别只授予对应服务账号读取，并设为 `0600`；Relay 会拒绝权限过宽的配置。每台 Host 使用独立随机 ID 和至少 32 字节随机凭据，不能把下面的示例占位值用于公网服务。启动时只在进程环境中指定私有文件路径，例如 `RELAY_CONFIG_FILE=/etc/computer-harness/relay-config.json`；Host 使用权限受限的 EnvironmentFile 或等价秘密注入机制。

准备部署时：

1. 在私有配置文件中将 `publicOrigin` 填成 `https://relay.example.com` 这样的实际 HTTPS origin，`listen.host` 仍设为 `127.0.0.1`。`webRoot` 相对配置文件目录，示例配置指向 `apps/web/dist`。
2. 在本机安全生成唯一 host ID 与随机凭据，通过受控方式分别放入 Relay 配置和 Host 私有 env 文件。Host 设置 `HARNESS_RELAY_URL=https://relay.example.com`、同一个 `HARNESS_HOST_ID`、同一个 `HARNESS_RELAY_CREDENTIAL`，以及 `HARNESS_RELAY_PUBLIC_ORIGIN=https://relay.example.com`；不要通过聊天发送凭据。Relay 配置需限制为服务账号可读，在 Linux 上权限不能宽于 `0600`。每台 Host 使用不同身份和凭据。
3. 构建 `apps/web`、`packages/relay-connector`、`apps/relay` 与 `apps/host`；以专用非 root 服务账号运行。监听器已限制绑定 loopback。
4. 配置 Nginx/Caddy 等 TLS 反向代理，将 HTTPS、WSS `/v1/host`、API 和未缓冲 SSE 转到 `127.0.0.1:8787`。确认服务商和代理没有保存完整 `/pair?token=...` 请求行、cookie 或 body。
5. 先检查 `/healthz`、HTTPS 页面和 Host WSS 在线状态，再用 Android Chrome 与 iPhone Safari 分别经不同网络扫码；验证本机确认、撤销、锁屏返回、网络切换、重连、重复请求和 Relay 重启后的重新配对。没有这些实机结果前，不宣称“跨网扫码即用”。

### Linux systemd：非 root 运行、检查、重启与回滚

Relay 是 VPS 上唯一需要常驻的服务；Host/CUA 仍运行在用户自己的 Windows 电脑上。先创建专用无登录服务账号 computer-harness-relay，将私有配置安全写入 /etc/computer-harness/relay-config.json，文件归该账号所有且权限为 0600。Relay 会拒绝权限过宽的配置。配置的 webRoot 应为 /opt/computer-harness/current/apps/web/dist，监听地址保持 127.0.0.1:8787；密钥不得写进 unit、命令行或日志。

以下账号和目录命令只在首次配置时执行；由受控密钥管理写入 Relay 配置后，再确保它由服务账号读取且仅 owner 可读：

```sh
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin computer-harness-relay
sudo install -d -o root -g computer-harness-relay -m 0750 /etc/computer-harness
sudo chown computer-harness-relay:computer-harness-relay /etc/computer-harness/relay-config.json
sudo chmod 0600 /etc/computer-harness/relay-config.json
```

把下列内容保存为 /etc/systemd/system/computer-harness-relay.service。将 ExecStart 中的 Node 路径替换为实际安装并验证过的 Node.js >=22.13.0 可执行文件；示例使用 Node 24.19.0 的常见安装位置。源码 release 目录保持只读给服务账号即可，Relay 不需要持久化目录：

```ini
[Unit]
Description=Computer Harness Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=computer-harness-relay
Group=computer-harness-relay
WorkingDirectory=/opt/computer-harness/current/apps/relay
Environment=RELAY_CONFIG_FILE=/etc/computer-harness/relay-config.json
ExecStart=/opt/node-v24.19.0/bin/node /opt/computer-harness/current/apps/relay/dist/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

首次切换时，current 必须是指向已构建 release 的 symlink；之后每次升级先在新的 versioned release 目录中解压、校验、安装依赖、构建并测试，再切换 symlink 并重启：

```sh
sudo ln -s /opt/computer-harness/releases/2026-09-26-02 /opt/computer-harness/current
sudo systemctl daemon-reload
sudo systemctl enable --now computer-harness-relay
sudo systemctl status --no-pager computer-harness-relay
sudo journalctl -u computer-harness-relay -n 50 --no-pager
sudo journalctl -u computer-harness-relay -f
```

Relay 的 /healthz 仅表示 Relay HTTP 进程有响应，不表示 Windows Host 的 WSS 在线。由于 Relay 校验 Host header，本机直连健康检查需显式给出配置的域名；公网路径则同时检查 TLS 反向代理：

```sh
curl --fail --show-error --silent -H 'Host: relay.example.com' http://127.0.0.1:8787/healthz
curl --fail --show-error --silent https://relay.example.com/healthz
sudo systemctl restart computer-harness-relay
sudo journalctl -u computer-harness-relay -n 50 --no-pager
```

Host 在线情况需在完成手机配对后通过控制台读取 Run 列表确认；不要把 /healthz 当作 WSS 健康检查。Relay 重启会清空它内存中的手机 session 与待处理配对，手机需要重新配对；Host 会自行重连，但不会重放未确认命令。

回滚到保留的旧 release 时，将下面示例路径替换成实际保留的版本目录，再重启并重新检查健康状态。current 和 current.next 都应是 symlink：

```sh
previous=/opt/computer-harness/releases/2026-09-25-01
test -d "$previous"
sudo ln -sfn "$previous" /opt/computer-harness/current.next
sudo mv -Tf /opt/computer-harness/current.next /opt/computer-harness/current
sudo systemctl restart computer-harness-relay
sudo systemctl status --no-pager computer-harness-relay
curl --fail --show-error --silent -H 'Host: relay.example.com' http://127.0.0.1:8787/healthz
```

### Nginx 参考片段

先把 `map`、限流区和日志格式放在 Nginx 的 `http {}` 上下文，再将 `server` 配置放入站点文件。替换域名和证书路径；该示例不会创建证书或部署服务。示例只监听 TLS 端口；证书可通过 DNS 验证或其他受控方式配置，避免把二维码 query 送到明文 HTTP。

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

limit_req_zone $binary_remote_addr zone=harness_pairing:10m rate=10r/m;
log_format harness_relay_safe '$remote_addr $request_method $uri $status $body_bytes_sent';

server {
    listen 443 ssl http2;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;

    access_log /var/log/nginx/harness-relay-access.log harness_relay_safe;
    error_log /var/log/nginx/harness-relay-error.log crit;

    location = /pair {
        access_log off;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }

    location = /api/pair/requests {
        limit_req zone=harness_pairing burst=5 nodelay;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /v1/host {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }

    # No trailing slash: cover both the collection /api/runs and child routes.
    # A slash-only prefix can redirect /api/runs and break POST/list requests.
    location /api/runs {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`$uri` omits query parameters; `/pair` additionally disables access logging. The `crit` error-log threshold avoids routine request-line diagnostics that may contain a pairing query. Keep the proxy's request-body logging disabled. HTTPS and WSS terminate at the proxy; the backend remains loopback-only.

After `nginx -t` and a controlled reload, verify the collection route without following redirects: unauthenticated `GET /api/runs` should return `401`, not `301` or `302`. Verify the authenticated POST and SSE paths with a synthetic Host before release. If an old keep-alive connection still sees the previous configuration, test with a new connection first; do not restart unrelated sites as the default diagnostic step.

Before SSH deployment, verify the server host-key fingerprint through the cloud console or a trusted administrator. A changed key is a deployment blocker: do not use `StrictHostKeyChecking=no` or delete a prior trust record without verification. Keep passwords, host credentials, client IP addresses and private credential-file locations out of public handoff reports. For rollback, preserve shared Nginx and certificate directories; switch back to the previous release and disable only this service's configuration when necessary.

Nginx behavior references: [WebSocket proxying](https://nginx.org/en/docs/http/websocket.html), [request log variables](https://nginx.org/en/docs/http/ngx_http_core_module.html), and [request rate limiting](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html).

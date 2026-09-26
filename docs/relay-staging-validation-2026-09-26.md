# Relay staging 部署与验证（2026-09-26）

> 成员C 对 `codex/mobile-control-handoff-20260926` 分支的公网 staging 部署与验证记录。
> 任务本质 = PHONE-PUBLIC 发布门槛：Relay 部署公网 + 实体手机验收，通过前不得宣称"扫码即用已验证"。
> **当前结论：L0–L3 全部完成；L4 以安卓 Chrome 实体机跑完矩阵主体（扫码无告警、配对、Run 全流程、撤销、断网切换、锁屏、过期/重用拒绝均通过），iPhone Safari 与真机审批流未覆盖。**

## 0. 状态总览

| 层 | 内容 | 状态 |
|---|---|---|
| L0 | 服务器基线 + 构建 + 四测试 | ✅ 完成（4 files / 9 tests 全绿） |
| L1 | Relay 服务化（账号/0600 配置/systemd/healthz） | ✅ 完成（含 0644 负向实证） |
| L2 | Nginx/TLS | ✅ 完成（自签 → **LE 短期 IP 证书**；日志红线与 8787 外网扫描均已留证） |
| L3 | Host↔Relay 公网链路 | ✅ 完成（WSS 长连、四轮完整配对、三轮 Run、三承诺、控制命令、负向测试） |
| L4 | 实体手机矩阵（发布门槛本体） | 🔶 安卓 Chrome 完成矩阵主体（Wi-Fi + 蜂窝）；iPhone Safari 未做；真机审批流未覆盖（fake 后端不产生审批） |

TLS 已从自签切换为 **Let's Encrypt 短期 IP 证书（160 小时，自动续期）**：手机访问不再有证书告警（L3 中本机 Chrome 实测直接加载无告警）。自签证书保留在 `/etc/nginx/ssl/` 作回退。

## 1. 服务器环境快照

- 阿里云 ECS，公网 IP **47.108.197.221**，Ubuntu 26.04.1 LTS，2 vCPU / 1.7 GiB RAM（无 swap）/ 40 GB 盘（用量 ~4 GB）
- SSH：通过受控运维账号登录；认证资料仅通过私有渠道交接，不在本文记录凭据或本机存放位置。
- 已有服务：nginx 80 端口托管 zhaiyx 静态站 myweb（`/var/www/myweb`，`server_name _` 通配，**IP 直访**），部署全程未影响
- 网络出口：registry.npmjs.org / codeload.github.com / nodejs.org / pypi.org 可达；**github.com 主站超时不可达**（部署改走 git bundle）
- 阿里云安全组 443 已放行、8787 未放行（本轮用第三方节点与服务器抓包双重留证，见 §4.4）

## 2. L0 构建与测试（已完成）

| 项 | 值 |
|---|---|
| 部署方式 | GitHub 不可达 → 本机 `git bundle`（main + 目标分支完整历史）经 scp 上传，服务器 clone |
| 部署 SHA | `4bf72883ae35b381717f71eb362a90b11e97629a`（= origin/codex/mobile-control-handoff-20260926 tip） |
| 源码位置 | `/opt/computer-harness/releases/2026-09-26-01`（owner zhaiyx） |
| Node | v24.19.0，`/opt/node-v24.19.0`（tarball 自 npmmirror 下载，**sha256 对照 nodejs.org 官方 SHASUMS256.txt 通过**） |
| pnpm | 11.19.0（全局，node24 的 npm 安装） |
| 构建 | `pnpm install --frozen-lockfile`（4m14s）→ web build（72 modules）→ `tsc --build` relay-connector/relay/host 全过 |
| 测试 | `vitest run` 四指定文件：首次 1 文件 collect 阶段失败（`@trycua/cua-driver-linux-x64-gnu@0.22.2` 空壳，pnpm optional 依赖 tarball 未解包）；用本机留存 tarball（sha512 对照 lockfile 通过）解包修复后 **4 files / 9 tests 全绿** |

## 3. L1 Relay 服务化（已完成）

- 服务账号：`computer-harness-relay`（uid 999，system 级，nologin）
- 配置目录：`/etc/computer-harness/` 0750；配置文件 `relay-config.json` **0600**
  - `publicOrigin: https://47.108.197.221`；`listen: 127.0.0.1:8787`；`webRoot` 指向 release 的 `apps/web/dist`
  - hostCredentials：hostId（openssl rand -hex 16）+ credential（openssl rand -base64 48 → base64url）
- **负向测试实证**：chmod 0644 → `systemctl start` → Relay 拒绝启动（`permissions are too broad`），journalctl 留证；恢复 0600 后正常
- systemd：`computer-harness-relay.service`（ProtectSystem=strict / PrivateTmp / UMask 0077 / NoNewPrivileges）**enable + active**，常驻内存约 18 MiB
- healthz：`curl -H 'Host: 47.108.197.221' http://127.0.0.1:8787/healthz` → `{"status":"ok"}`；仅监听 loopback
- 发布结构：`/opt/computer-harness/current` → symlink → `releases/2026-09-26-01`（原子切换，回滚见 §8）

## 4. L2 Nginx / TLS（已完成）

### 4.1 nginx 站点

- 自签证书（EC P-256、IP SAN、825 天）→ 已切换 LE 证书（见 4.3）
- 站点 `sites-available/harness-relay`（sites-enabled 已链）：`$uri` 日志格式（不含 query）、`/pair` access_log off、配对 `limit_req 10r/m burst=5`、WSS `/v1/host` Upgrade 头、SSE `proxy_buffering off`、HSTS；`http2 on;`（Ubuntu 26.04 nginx 1.27+ 新语法）
- **服务器修改**：模板原文 `location /api/runs/`（尾斜杠）导致 `/api/runs` 被 nginx 以 301 重定向到 `/api/runs/`，手机端"任务列表"与"开始任务"全部失败（见 §6.1）。已改为 `location /api/runs`（无尾斜杠）。注意 `systemctl reload nginx` 后旧 worker 仍可能服务存量连接，需 `restart` 才能可靠验证。
- myweb 追加 `location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }`（LE HTTP-01 用）；原配置备份 `/root/myweb.nginx.bak-20260926`；80 端口 myweb 行为不变

### 4.2 日志红线留证

- 配置层：全量 grep `request_body|http_cookie` 无匹配；`log_format harness_relay_safe` 只含 `$remote_addr $request_method $uri $status $body_bytes_sent`
- 行为层：经外网 443 发送 6 个测试请求（`GET /pair?token=…`、`POST /pair` 带 Cookie+body、`GET /healthz?secret=…`、`GET /api/runs/abc123?token=…`、`GET /api/pair/requests?x=…`、`GET /` 带 Cookie），对照 access log 新增行：
  - **`/pair` 两条请求零落盘**（access_log off 生效）
  - 其余路径只记录 `$uri`，query（secret/token/x）、cookie、body 全部未出现
  - 全量 grep `redline|token|secret|cookie|session` 在 access log 无匹配

### 4.3 LE 短期 IP 证书（已完成）

1. apt 的 certbot 4.0.0 **没有 `--ip-address`**，对 IP 请求直接报 "will not issue certificates for a bare IP address"（客户端侧过时拦截）
2. 服务器 pypi.org 可达 → `apt install python3.14-venv` + `python3 -m venv /opt/certbot-venv` 装 **certbot 5.8.0**（pip 版），确认支持 `--ip-address`
3. 签发（生产 API，HTTP-01 webroot）：`/opt/certbot-venv/bin/certbot certonly --webroot -w /var/www/letsencrypt --ip-address 47.108.197.221 --preferred-profile shortlived --non-interactive --agree-tos --register-unsafely-without-email`
4. 结果：证书有效期 **09-26 08:56 → 10-03 00:56 GMT（160 小时，即 shortlived profile）**，issuer = `Let's Encrypt CN=YE1`，SAN = `IP Address:47.108.197.221`（critical）
5. nginx 切换 `ssl_certificate` 两行 → `nginx -t` → reload；**外网 `curl` 不带 `-k` 返回 200（ssl_verify=0）**，系统信任链直接认可
6. **续期链路（160 小时证书的硬要求）**：
   - 发现隐患：apt certbot 的 `certbot.timer` 与 `/etc/cron.d/certbot` 都指向 `/usr/bin/certbot`（4.0），实测 `certbot renew --dry-run` 对该 IP 证书 **失败**（不认识 IP），不清除则 10-03 到期即断
   - 处理：卸载 apt certbot；新建 `certbot-renew.service` + `certbot-renew.timer`（每天 06:00/17:00 + 30 分钟随机延迟，`Persistent=true`），ExecStart 指向 `/opt/certbot-venv/bin/certbot -q renew`
   - deploy hook：`/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`（`systemctl reload nginx`），续期成功后自动生效
   - 验证：`renew --dry-run` 模拟续期成功；手动触发 `certbot-renew.service` exit 0（未到期不动作）；timer 已 enable（首跑次日 06:00）

### 4.4 外网 8787 扫描留证

- 第三方视角（check-host.net 三节点，纯外部网络）：**8787 全部 `Connection timed out`**（de1/it2/pl2）；对照 443 三节点全部连通（ca1/cy1/id1）。安全组未放行 8787，符合预期
- 服务器侧 tcpdump（`port 8787 and not host 127.0.0.1`）在本机发起连接尝试的同时段 **捕获 0 包**，两方证据一致
- **本机探测陷阱**：本机 `nc -zv 47.108.197.221 8787` 显示 "succeeded"、curl 返回空回复（exit 52），实际是本机 Clash TUN 模式对任意 TCP 先本地应答造成的假阳性，包并未出网。本机所在环境验证端口可达性必须用第三方节点或服务器侧抓包，不能用本机 nc/curl 结论。

## 5. L3 Host↔Relay 公网链路（已完成）

### 5.1 方案与前置

- Host 主入口强制 CUA 后端（Linux 真实桌面 CUA 不可用，既有结论），因此用驱动脚本 **`relay-host-l3-worktree/apps/host/l3-fake-host.mjs`**（未跟踪）：以 `dependencies.createProvider/createComputer` 注入 fake 后端（与 `relay-roundtrip.test.ts` 同构），Host server 与 HostRelayConnector 全部用真实实现，Relay 指向公网 `https://47.108.197.221`。**未改动任何仓库代码。**
- 工作树：`../relay-host-l3-worktree`（detached at `4bf7288`）；`pnpm install --frozen-lockfile` 14.4s（本机 store 复用，trycua optional 依赖为 09-17 修复后的实体，未再空壳）
- 凭据通过受控渠道交接到 Host 专用私有文件（0600），不在本文记录交接命令或私有路径。解析时区分注释中的模板占位与实际键值，绝不输出实际值。

### 5.2 链路证据

- Host 侧：`[relay] connecting` → `[relay] connected`；Relay 侧 `ss` 可见 nginx↔8787 的 ESTABLISHED 长连接
- 配对注册需 Relay ack 往返：`POST /api/local/pairing` 成功返回即证明 WSS 双向消息通路工作
- pairingUrl = `https://47.108.197.221/pair?token=…`（公网 origin，非 localhost）

### 5.3 手机侧全流程（本机 Chrome 模拟，共 4 轮完整配对）

- 配对：扫码页 → 自动 `POST /api/pair/requests`（202）→ 电脑本机"连接手机"页出现待处理请求 → 本机确认 → 手机 `POST …/session`（200，Relay 下发 HttpOnly SameSite=Strict Secure cookie；Relay 有意把响应重组为 `{csrfToken, expiresAt}`，deviceId/sessionToken 留在 Relay 侧，手机侧回主页经 `GET /api/session` 恢复）
- 配对 token 90 秒一次性：过期/消费后重扫新码，行为符合预期
- 窗口候选：`GET /api/windows` 返回 fixture 窗口（仅 opaque token + 应用名 + 标题），列表 10 分钟有效
- Run 三轮实测（fixture provider）：
  - 第一轮复现 `runtime.error`：fake `execute()` 未按契约回传 `{actionId}` → "terminal action undefined does not match unresolved action" → outcome_unknown。修正 fixture 后通过（**契约点：Computer.execute 必须返回含 actionId 的 ActionReceipt**）
  - 第二、三轮：run.created → … → 两步/三步动作各 `action.execution.completed` → finish，**outcome=succeeded**，最终 summary 经公网回传至手机页面；截图 asset 经 `https://47.108.197.221/api/runs/:id/assets/:assetId` 正常显示；SSE 事件列在"任务进展"区呈现
- 控制命令（10 秒/步 fixture，Run 进行中操作）：
  - **pause**：提交后 UI 显示"已收到请求，正在确认是否已生效"（accepted），约数秒后 applied（"电脑已确认这项操作"，按钮切换为"继续任务"），轨迹 `run.paused`
  - **correct**（补充要求）：轨迹 `user.input.received`；暂停前已提交的动作被 `tool.call.rejected`，reason = **"superseded by user correction"**（纠正使暂停前提出的动作作废）
  - **resume**：轨迹 `run.resumed`，Run 继续至 succeeded
- 负向测试：
  - `POST /api/runs` 带 `pid` / `hwnd` 字段 → **400 invalid_request_body**（Relay 只接受 `{commandId, goal, targetToken}`）
  - 无 CSRF token 的 POST → **403 csrf_check_failed**；无 session 的请求 → 401 session_required
  - `targetToken` 非法格式 → 拒绝（不出 Run）

### 5.4 三承诺实测

| 承诺 | 操作 | 结果 |
|---|---|---|
| ① Relay 重启 → 内存配对/session 清空、手机须重新配对 | `systemctl restart computer-harness-relay` | 手机 `GET /api/runs` → **401 session_required**，回到未连接页须重新配对 ✅ |
| ② Host 断线重连 → session 保留 | `systemctl restart nginx`（模拟 WSS 闪断；Host/Relay 进程未动） | Host 侧 `[relay] disconnected → connected` 自动重连；手机**无需重新配对**直接可用（`GET /api/runs` 200）✅ |
| ③ 未确认命令不重放 | （代码契约 + 部分行为） | connector 注释与实现："never buffers requests while offline and never retries a GUI command"；dispatch 对浏览器断连"不取消、不重放已发往 Host 的请求"。完整行为验证（断线游标 resync / outcome-unknown 先刷新）留 L4 |

补充语义：**Host 进程重启**会使 Host 侧 session/配对/去重状态失效（CONTRACT 明示），实测手机旧 cookie 回主页回到未连接页，须重新配对，与 CONTRACT 声明一致。

## 6. 本轮发现（给组长的修复建议，均未改仓库代码）

### 6.1 nginx 模板尾斜杠 301（已热修服务器）

README 的 nginx 模板写 `location /api/runs/`（尾斜杠）。在 Ubuntu nginx 1.28.3 实测：请求 `GET/POST /api/runs`（无斜杠）被 nginx 以 301 重定向到 `/api/runs/`，转发到 Relay 时变成 `route_not_found`，前端提示"当前 Host 没有提供这个功能"。
手机端症状：任务列表恒为空、点"开始任务"必失败；L4 真机首扫确实撞上。
修复：服务器配置已改为 `location /api/runs`（无尾斜杠，前缀匹配同时覆盖 `/api/runs` 与 `/api/runs/xxx`）。README 模板建议同步修正；另建议模板把精确/前缀 location 的尾斜杠问题写成注释，避免其他部署者复现。
**对照实验**：临时加 `location /api/windows/`（尾斜杠）后 fresh `systemctl restart nginx`，`/api/windows` 立即复现 301 → `/api/windows/`；同一时刻无尾斜杠的 `location /api/runs` 正常返回 401。实验配置已移除、站点已恢复并复测通过。结论：只要存在尾斜杠前缀 location `X/`，请求 `X` 就会被 301 加斜杠，这是稳定行为（改配置后仍需 `systemctl restart nginx` 再验证，reload 后旧 worker 可能仍在处理存量连接）。
单测未发现的原因：`relay-roundtrip.test.ts` 直连 `createRelayServer`，不经过 nginx 反向代理层；该缺陷只出现在反代部署路径上。

### 6.2 PairingScreen 会话建立成功后 poll 未停（前端缺陷）

`apps/web/src/PairingScreen.tsx`：真机观察到会话已建立但页面显示过期。最初推断是成功后轮询未停；源码复核发现 effect 已有 connected 终态检查和 interval 清理，因此这个根因尚不能作为定论。重点复现 approved 状态更新触发 effect cleanup、正在建立会话的异步响应被丢弃，以及 interval 请求重叠的竞态，详见后续修复记录。
实际会话已建立（回主页经 `GET /api/session` 即恢复连接），但首扫用户会看到误导性失败提示并可能重复扫码。
修复要求：单一串行轮询、建立会话请求去重、终态后停止、旧异步响应不能覆盖新状态；补慢响应与重挂载测试，不只重复添加已有的 connected 判断。

### 6.3 小项

- `/connect` 页顶部仍显示"公网中继尚未部署，当前二维码不代表已支持跨网络扫码"的静态文案，与实际部署状态不符（L3 验证期间多次误读），建议随部署状态更新。
- fixture 契约提醒：`Computer.execute` 必须返回 `{actionId, status, ...}`，测试夹具若省略 actionId 会触发 `unknown_side_effect`（L3 首轮 Run 即此原因）。

## 7. L4 实体手机矩阵（2026-09-26 晚执行，安卓 Chrome）

环境：用户实体安卓机 Chrome；电脑侧 Host 仍为 fake fixture 后端（10 秒/步慢速模式，便于交互）；网络先后用 Wi-Fi 与蜂窝。服务器日志确认了网络切换；客户端 IP 仅保留于私有证据，不在交接文档公开。

| 项 | 结果 |
|---|---|
| 扫码打开 | ✅ **无证书/安全告警**（LE 短期证书真机确认）；B2 前端缺陷真机复现：配对成功后页面显示"配对请求已过期"，回主页即恢复正常 |
| 配对 | ✅ 90 秒一次性凭据 + 电脑本机确认（UI"允许这台手机"）；**拒绝路径** ✅（电脑点"拒绝"→ 手机显示"电脑没有授权这台手机"）；**撤销后重新配对** ✅ |
| 过期拒绝 | ✅ 二维码生成 100 秒后扫码 → 手机提示"二维码已过期或已使用"；服务器侧 `POST /api/pair/requests → 401` |
| 重用拒绝 | ✅ 同一二维码第二次扫码 → "无法连接这台电脑 / 二维码已过期或已使用"（一次性凭据已消费） |
| Run 全流程 | ✅ 5 轮真机运行：goal 提交 → SSE 实时进展（含截图更新）→ 完整结果回传；窗口选择、10 分钟 token 时效均正常 |
| 暂停/恢复 | ✅ 真机点"暂停"→"电脑已确认这项操作"（applied 回执），恢复后继续至完成；电脑侧轨迹 `run.paused`/`run.resumed` 对应 |
| 补充要求（纠正） | ✅ 真机发送 → "电脑已确认这项操作"，电脑侧轨迹 `user.input.received`，任务继续至完成（本轮纠正落在动作间隙，未触发 supersede；supersede 语义已在 L3 验证） |
| **撤销后 SSE 立即停止**（分支修复项回归） | ✅ 运行中撤销设备：手机页面立即进入"正在重新连接"，刷新后"手机授权已失效"；服务器侧 `events 200 → 401`、下一次快照 `401`。被撤销期间电脑侧任务继续至 `succeeded`（撤销不取消已执行任务，符合设计） |
| Wi-Fi ↔ 蜂窝切换 | ✅ 运行中 Wi-Fi 关断切蜂窝：页面短暂"重新连接"后自动恢复并继续显示进展，任务未中断；服务器侧双 IP 请求轨迹完整（会话跨 IP 保持） |
| 锁屏返回 | ✅ 运行中锁屏 15 秒后解锁：页面状态一致，任务正常完结并显示结果 |
| 重复命令去重（API 级） | ✅ 同 `commandId` 两次 `POST /api/runs` → 202 返回**同一** runId 未新建；同 `commandId` 两次 pause → 返回**同一张回执**（acceptedAt 完全一致），电脑侧 `run.paused` 仅 1 次 |
| 大小上限（API 级） | ✅ JSON 请求 32 KiB：41048 字节请求体 → **413 request_too_large**；✅ asset 8 MiB：9 MiB 截图经 Relay 拉取 → **502 invalid_host_asset_response**（任务不受影响）。JSON 响应 4 MiB / SSE 事件 64 KiB / WSS frame 12 MiB 三档难以自然触发，本轮未测 |
| 其他观察 | Run 活跃期间 `GET /api/windows` → **409 RUN_BUSY**（窗口候选仅在无活动 Run 时提供）；服务器日志证实 `/pair` 页面请求零落盘（红线持续有效） |

未覆盖项（如实声明）：

- **iPhone Safari**：用户无 iOS 设备，未测
- **真机审批流**（请求绑定 + 动作预览）：fake 后端 `riskGuard` 关闭，不产生审批请求；需真实模型后端
- **断线 outcome-unknown 不重放**的行为级验证：代码契约已核（connector 不缓冲/不重放），本轮未自然触发；L3 首轮 Run 曾因 fixture 契约缺陷产生过一次 `outcome_unknown`（Host 侧未重放已确认）
- 上述三档大小上限未测

## 8. 回退方法

```sh
# Relay 服务
systemctl disable --now computer-harness-relay
# nginx 443 站点（myweb 不受影响；acme location 可选保留）
rm /etc/nginx/sites-enabled/harness-relay && nginx -t && systemctl restart nginx
# 或恢复 myweb 原配置
cp /root/myweb.nginx.bak-20260926 /etc/nginx/sites-enabled/myweb && nginx -t && systemctl restart nginx
# 证书回退自签（自签文件保留在 /etc/nginx/ssl/）
# 编辑 harness-relay 站点 ssl_certificate 两行指回 harness-relay-selfsigned.{crt,key} → nginx -t → restart
# 不删除共享证书目录、配置目录、历史 release 或服务账号。
# 保留这些资源便于恢复；彻底卸载必须先确认资源归属并另行审批。
```

升级/回滚 release：新版本在新 versioned 目录构建测试后 `ln -sfn <new> /opt/computer-harness/current.next && mv -Tf current.next current && systemctl restart computer-harness-relay`（README 原子切换法）。

证书续期链路（本轮新建）：`certbot-renew.timer`（每天 06:00/17:00）→ `/opt/certbot-venv/bin/certbot -q renew` → deploy hook reload nginx。状态查询：`systemctl list-timers | grep certbot-renew`、`journalctl -u certbot-renew.service`。

## 9. 红线与如实声明

- **Relay 非 E2EE**：TLS 在反代终止，运营者可读明文载荷（任务请求/事件/截图字节），报告不美化
- 凭据不进聊天/日志/shell 历史/命令行参数；Relay 配置及 Host 私有凭据文件均受限为 0600。私有交接文件位置不在公共文档记录。已公开提交的历史元数据不会因修改本文自动消失，维护者应单独评估历史清理和凭据轮换。
- 服务器不跑模型（Relay 无 GPU/数据库需求）；不验 CUA 真实桌面（Linux 不通，组长 Windows 侧的事）
- L3 的"手机"为本机 Chrome 模拟；L4 已用**实体安卓机 + 真实网络（Wi-Fi/蜂窝）**跑完矩阵主体，结论表述为"安卓 Chrome 跨网络扫码即用已实测通过"
- **PHONE-PUBLIC 门槛**：安卓 Chrome 已过矩阵主体；iPhone Safari 未测、真机审批流未覆盖，是否放行由组长/团队按发布标准判定，本文档不代作结论
- `publicOrigin` 现为 IP；域名到位后改 `relay-config.json` + nginx `server_name` + 证书，重启即可，其余不动

## 附录 A：关键配置文件（2026-09-26 部署后实况，只读抓取）

凭据字段已在服务器端脱敏后导出，真值只存在于服务器交接文件与 Host 侧副本（见 §9）。

### A.1 Relay 配置

`/etc/computer-harness/relay-config.json`（0600，属主 computer-harness-relay）：

```json
{
  "publicOrigin": "https://47.108.197.221",
  "listen": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "webRoot": "/opt/computer-harness/current/apps/web/dist",
  "requestTimeoutMs": 45000,
  "hostCredentials": [
    {
      "hostId": "<REDACTED>",
      "credential": "<REDACTED>"
    }
  ]
}
```

### A.2 Relay systemd 单元

`/etc/systemd/system/computer-harness-relay.service`：

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

### A.3 证书续期单元（本轮新建）

`/etc/systemd/system/certbot-renew.service`：

```ini
[Unit]
Description=Certbot renewal (venv 5.8, IP shortlived cert)

[Service]
Type=oneshot
ExecStart=/opt/certbot-venv/bin/certbot -q renew
```

`/etc/systemd/system/certbot-renew.timer`：

```ini
[Unit]
Description=Run certbot renew twice daily

[Timer]
OnCalendar=*-*-* 06,17:00:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
```

`/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`（0755）：

```sh
#!/bin/sh
systemctl reload nginx
```

### A.4 nginx 站点实况

`/etc/nginx/sites-available/harness-relay`（sites-enabled 已链；相对 README 模板有两处部署修改：`location /api/runs` 去尾斜杠、证书指向 LE）：

```nginx
# Computer-Harness Relay - TLS termination for 47.108.197.221
# Let's Encrypt short-lived IP cert (160h), renewed by certbot-renew.timer + deploy hook. Self-signed backup kept in /etc/nginx/ssl/.
# Log red lines: $uri only (no query), /pair logging off, no cookie/body logging.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

limit_req_zone $binary_remote_addr zone=harness_pairing:10m rate=10r/m;
log_format harness_relay_safe '$remote_addr $request_method $uri $status $body_bytes_sent';

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name 47.108.197.221;

    ssl_certificate     /etc/letsencrypt/live/47.108.197.221/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/47.108.197.221/privkey.pem;
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

### A.5 备份与交接文件（服务器留存）

| 路径 | 用途 |
|---|---|
| `/root/myweb.nginx.bak-20260926` | myweb 站点原配置（追加 acme location 前） |
| `/root/harness-relay.bak-pre301test` | 301 对照实验前的站点配置 |
| `/etc/nginx/ssl/harness-relay-selfsigned.{crt,key}` | 自签证书（回退用） |
| 私有交接清单 | Host 凭据位置由受控渠道提供，不在公共文档记录 |

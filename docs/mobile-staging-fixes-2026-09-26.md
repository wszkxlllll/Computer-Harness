# 手机 staging 修复与独立验证记录

## 范围与基线

用户授权连接现有服务器、修复已审计问题并完善文档。基线为 `codex/mobile-control-handoff-20260926` 的 `de0b2ae`，本地已 fast-forward，同步队友配置附录并保留前次未提交的审计文档。

实施分工：Luna 负责 CI 资产/浏览器测试与 Web 配对修复，Sol 集中审查；主 Agent 核对公网、部署边界及文档。未获独立服务器身份验证前不进行 SSH 认证或远端写入。

## 服务器访问与独立公网检查

本机 SSH 保存的旧 ECDSA 主机记录与当前服务器不一致。当前远端给出的 ED25519 指纹为 `SHA256:BS8naDKlw2KNiHmoOrvFK9clIIszACZRvqaMqvvkiWQ`。用户经独立核对确认一致后，建立本次专用 known_hosts，使用严格校验成功登录；未删除原有信任记录或关闭校验。凭据仅用于交互式认证，没有写入命令参数、仓库或文档。

管理员应通过独立的云控制台执行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 并比对。指纹一致后才可为该主机更新信任记录。若不一致，应先排查 IP/重装/网络代理，不继续登录。

独立执行的公网探测未携带认证信息，也未创建任务：

| 请求 | 结果 | 含义 |
| --- | --- | --- |
| HTTPS GET `/healthz` | 200，TLS 校验成功 | 公网健康端点可达 |
| HTTPS GET `/` | 200，TLS 校验成功 | 前端入口可达 |
| HTTPS GET `/api/runs` | 401，无 redirect | 集合路径未被追加斜杠，拒绝未认证访问 |
| HTTPS POST `/api/runs`，空 JSON，无认证/Origin | 403，无 redirect | 请求被安全层拒绝，没有发起 Run；不等于已验证合法 POST |

这些结果不能证明 WSS、SSE、配对和真实桌面全链路，也不能证明服务器已部署本次修复。

SSH 独立核验：实际 release 为 `2026-09-26-01`，Git `4bf7288` 且工作区干净；Relay 与 Nginx active，Relay 以专用非 root 账号运行，凭据文件 0600。8787 仅 loopback 监听。证书有效期至 2026-10-03 00:56:29 UTC，续期 timer 已启用并指向独立 certbot venv。`nginx -t` 通过。检查时未发现 Relay 8787 的已建立连接；这是当时快照，不保证后续一直空闲。没有因系统显示 reboot 提示而重启服务器。

## 已完成的文档修正

- Nginx 模板覆盖 `/api/runs` 集合和子路径，补充不跟随重定向的检查步骤。
- 改正配对故障归因：已有 connected 停止逻辑，需处理 effect/异步会话竞态，不能只再加一个终态判断。
- 队友报告保留实验事实，但删除手机 IP、认证共用信息与私有交接路径；历史 Git 记录不会因此自动消失。
- 去掉回退中删除整个共享证书目录等命令。身份校验、备份、最小变更、可回滚发布是部署前置条件。

## 代码、测试与部署状态

代码修复、集中审查、本地与 Linux 回归以及 staging 更新已完成，本次纳入 PR #14 更新。GitHub 矩阵以本次提交对应的实际检查结果为准；不能把本地/服务器回归等同于 GitHub 矩阵全绿。

### 实际修改

1. `packages/app-runtime/src/remote-run-api.ts`：BigInt 文件身份检查；分别比较可用的非零 dev/ino，保留类型、大小、路径包含、符号链接和读取长度检查。
2. `packages/computer-cua/src/managed-browser-host.ts`：清理旧端口文件后，在同一 profile 文件系统创建随机启动标记，读取其 mtime 并立即清理；端口文件与该标记比较，不再与 Date.now 比较。标记不是浏览器所有权证明，原 PID/CDP/CUA 校验保持不变。
3. `apps/web/src/PairingScreen.tsx` 与 `pairing-session.ts`：串行轮询、同请求的会话建立去重与重挂载恢复、成功终态清理。旧 cookie 不能代替新配对成功；慢响应和已消费请求竞态已有回归测试。
4. 连接管理和二维码文案：不再硬编码“公网尚未部署”，根据 URL 条件说明可达性和 HTTPS 要求，不把配置存在当作验收通过。
5. `apps/relay/README.md`：修正集合路径 Nginx 规则与安全回滚说明。

### 验证结果

| 执行方 / 环境 | 实际验证 | 结果 |
| --- | --- | --- |
| 主 Agent / Windows Node 24.19、pnpm 11.25 | `pnpm run typecheck`、`pnpm --filter @computer-harness/web build`、`pnpm test` | 76 个 Vitest 文件、736 项通过；TAP 19 通过、1 项 symlink 权限跳过 |
| 实施 Agent / Windows Node 22.13 和 24.19 | 资产读取与 DevTools 两文件定向测试 | 各 31 项通过；两包类型检查通过 |
| 主 Agent / staging Ubuntu、Node 24.19、pnpm 11.19 | 根 typecheck、Web build、`CI=true pnpm test` | 76 个 Vitest 文件、736 项通过；TAP 20 项全部通过 |
| Sol / 静态集中审查 | 文件身份保护、启动标记、配对竞态及 smoke 脚本 | 无阻塞发现；建议增加非零身份冲突、标记清理等定向回归，不作为本轮已完成项 |
| Sol / Windows Node 24.19 | `node scripts/relay-synthetic-smoke.mjs --self-test` | 退出 0；未访问公网、模型或桌面 |
| 主 Agent / 真实 HTTPS Relay | 同一公网 smoke 在切换前后分别运行 | 两次退出 0，配对、任务、控制、结果、资产与撤销通过 |

Linux 首次测试有 18 个 suite 在 collection 阶段因缺少 `@trycua/cua-driver-linux-x64-gnu@0.22.2` 而失败，不能算业务断言失败。官方 tar 下载 90 秒超时，仅获得不完整文件，未用于安装。最终复用了旧 release 中队友报告已校验的同版本依赖，四个文件逐字节 SHA256 比较一致，再重跑全量通过；本次没有独立完成该 tar 的 lockfile integrity 校验，不宣称全新冷安装成功。此可选依赖安装问题仍需在干净 Linux 环境另行调查。

### 可复用公网验证命令

从仓库根执行，先完成安装、根构建和 Web 构建：

```sh
node scripts/relay-synthetic-smoke.mjs --self-test
node scripts/relay-synthetic-smoke.mjs --relay-url https://<relay-host> --config <private-relay-config.json>
```

第二条会占用配置中第一个 Host 身份：运行前必须确认该身份没有正常 Host 连接，不能与用户任务并行。配置通过受限文件提供，不使用命令行 secret。脚本创建独立的模拟 Computer/Provider、真实 ApplicationSession 与 Host，经过公网 Relay 配对并确认，然后执行模拟窗口任务、pause/correct/resume、读取最终结果与图片、撤销测试设备并清理。错误只打印阶段/安全状态，不输出 token/cookie。异常清理是尽力执行，失败时仍需检查服务器和 Host 状态。

该脚本验证 API/传输链路，**不覆盖浏览器实际轮询交互、SSE 展示、真机触控、真实审批或真实桌面**；这些分别由组件测试、既有 SSE 测试和后续真机验收承担。

### 本次发布与回滚

- 新 release：`/opt/computer-harness/releases/2026-09-26-02`，current 已于 2026-09-26 20:13 CST 切换；旧 `01` 保留。
- 版本身份：旧 Git 基线 `4bf7288` + 本次未提交源文件 overlay；不是一个已推送 commit。源覆盖包 SHA256 为 `a9b533579271a6d3a26423d77e2d94f1bae4f21eaf49620850de4cda27cff963`，18 个文件逐一校验，服务器 `STAGING-OVERLAY.json` 记录精确文件哈希。此后补充的验收说明和 smoke 脚本单独交接，不改动已验证的运行时代码。
- 新 Web 文件：`assets/index-bqKRjU-U.js`，服务器构建与本机一致，公网首页引用已核验。
- Relay 重启后 health 200、原静态站点 200、Nginx/Relay active；未修改既有站点或重启系统。测试结束无已建立 Host 连接。
- 本服务配置备份位于管理员私有备份目录，目录 0700，凭据备份保持 0600；未打印或公开凭据。临时本机测试凭据副本已删除，原服务器凭据未删除。

回滚仅切换明确存在的旧 release，不删除配置或共享证书：

```sh
set -eu
test -d /opt/computer-harness/releases/2026-09-26-01
test ! -e /opt/computer-harness/rollback.next
ln -s /opt/computer-harness/releases/2026-09-26-01 /opt/computer-harness/rollback.next
mv -Tf /opt/computer-harness/rollback.next /opt/computer-harness/current
systemctl restart computer-harness-relay
```

逐条检查成功再继续；切换/重启前确认无活动任务。重启 Relay 后手机需重新扫码配对。发布后的手机浏览器应刷新以获取新前端。由用户在私有运维渠道轮换曾通过聊天提供的 root 凭据；本轮没有擅自改密码或扩大 root 登录权限。

### 未关闭的门槛

- GitHub 四平台/版本矩阵需要在本次提交后重新运行；合并前检查最新 head 的结果。
- 安卓实体手机需要复测“配对成功后停留页面不误报过期”；组件回归不等于真机复测。
- iPhone、真实审批、手机→Windows CUA 的完整真实任务仍待验证，原输入/弹层/跨窗口问题不因此关闭。

### 已确认的归因

- Windows Node 22.13：同一合成文件的 lstat.dev 为 0，句柄 stat.dev 为非零；两侧 BigInt inode 相同、containment 为真。原代码仅检查 inode 非零便比较 dev，导致合法资产被拒绝。修复不能去掉路径、symlink、长度等保护，应按平台实际可用的身份字段比较，并保留大整数精度。
- Linux 文件时间：主 Agent 在服务器 Node 24.19 上执行 100 次“记录 Date.now→创建独立临时文件→stat”的无模型实验，100 次 mtimeMs 都小于记录值，最大观察差约 1.149ms。临时目录已清理。该结果证明跨时钟/文件时间粒度比较可以误判新文件，不证明某个固定毫秒容差适用于所有系统；不能只把测试超时加大。
- 配对：approved 引起原 effect cleanup，旧 establish 响应可能被丢弃；重挂载与已消费请求的 404 也需处理。恢复必须关联同一次建立会话操作，不能用任何旧 cookie 推断新的配对成功。

## 后续升级的操作规范

1. 独立核对主机指纹后登录；只读核对服务版本、磁盘/内存、监听、证书与续期 timer，不输出凭据配置正文。
2. 确认是否有活动测试；备份本服务受影响配置及原 release 指向，不改既有静态站点。
3. 本地回归和审查通过后，创建新版本目录，记录源码差异与校验值、构建 Web/Relay，再切换；不能把未提交源包称为某个 Git commit 的精确构建。
4. 重启 Relay 会清空配对/session；提前说明需重新配对。只在确需后端重启时执行，前端修复优先评估静态资源更新。
5. 验证 health、静态资源、无重定向 API、synthetic Host 配对/Run/截图和慢响应配对；真机部分由用户或队友确认，不冒充已完成。
6. 失败时恢复上一 release/config；保留诊断，不能盲目重放真实 GUI 命令。

# 语音手机 Preview 部署与测试记录

日期：2026-09-29
状态：隔离 Preview 已部署并完成公网基础检查；手机端完整实测待用户执行
范围：仅记录语音 Preview 部署、连接检查、手机测试入口和回滚方式；未更改旧服务。

## 部署状态

- Preview 当前使用独立 release：`/opt/computer-harness-preview/releases/2026-09-29-082dbf8`；Preview 的 `current` 符号链接指向该 release。首轮 `2026-09-29-9f7fcb6027b4` 保留为 Preview 回滚点。
- `computer-harness-relay-preview` 服务处于 active，只监听 loopback `8788`。Nginx 在 `8443` 提供 TLS：`https://47.108.197.221:8443`，使用现有有效 IP 证书。用户已开放 `8443`。
- 旧入口 `https://47.108.197.221` 及旧服务、旧 `current` 均未修改，仍健康。
- 公网检查结果：health endpoint `200`；匿名 API `401`（认证门正常拒绝匿名请求）；JavaScript 与 CSS 资源 `200`。
- 本机 Host 在后台运行于 `4318`；WSS 已建立，配对挑战的 origin 已验证。以上结果不代表手机麦克风或完整语音任务已经验收。

## 来源与摘要

首轮部署内容来自工作树快照；发现 Relay 未接受新增 `assistantPreferences` 后，修复已提交为 `082dbf8a5e1b7e1c37d91860d7fff77ffcce73b4`，服务器从该提交的 `git archive` 构建并原子切换到当前 Preview release。它仍不是 Git tag 或正式 GitHub Release。

| 项目 | 标识 |
| --- | --- |
| 基线 commit | `743e94da00ac29bad05884e869a178159b47d626` |
| 已跟踪 diff SHA-256 | `ae693be41c45b8c3cb5c8e9f346d206a4cb1081af3106300649dd05fd5ecd6ce` |
| 部署 overlay SHA-256 | `9f7fcb6027b424bf518fb33e4f8dea5308ea05b9632928c77fa28590cbb0a3a3` |
| 构建 artifact SHA-256 | `29a93e8af3da2defadf69d55bec1f93e26ae191b12777cb96e4a9099d4930ae9` |

当前修复 release 的源码 ZIP SHA-256 为 `91122c31e79572ca3296e656fa51e9b593ffa1cfa11a8e692162191791e8715b`。首轮手机已成功配对，语音 session/audio/finish 均返回成功；开始任务时 `POST /api/runs` 连续返回 `400`，且 Host 未创建 Run。根因是 Relay 的精确请求白名单尚未接受 Web 新增的 `assistantPreferences`，请求在到达 Host 前被拒绝。修复后 Relay 复用 Host 同一份 protocol normalizer，并补充 Relay 合同及真实 Web→Relay→Host WSS roundtrip 测试。Preview Relay 重启会清空内存 session，用户必须重新扫码配对后复测。

本机私有配置 `.env.voice-preview` 存在；本文不记录其中的 hostId、凭据、密钥或配对 token，也不附私有截图。

## 手机测试入口

1. 在运行本机 Host 的电脑上打开 `http://localhost:4318/connect`。
2. 用手机扫描该页面提供的配对码，并在本机页面确认配对请求。Preview Relay 更新或重启后必须重新配对，不能继续使用重启前的手机 session。
3. 手机使用 Preview 地址 `https://47.108.197.221:8443` 继续测试。不要把旧地址 `https://47.108.197.221` 与 Preview 混用。
4. 记录手机浏览器、配对是否成功、麦克风权限、录音/转写、取消和弱网表现；这些手机端结果目前尚未提供，本记录不宣称它们已通过。

入口区分：

| 用途 | 地址 | 状态 |
| --- | --- | --- |
| 本机 Host 配对与本地确认 | `http://localhost:4318/connect` | 当前后台 Host |
| 本次 Preview 手机端 | `https://47.108.197.221:8443` | 新隔离部署 |
| 旧公网服务 | `https://47.108.197.221` | 保持原状、健康 |

本机 Host 日志：`runs/voice-preview-launch/host.stdout.log`、`runs/voice-preview-launch/host.stderr.log`。

## TLS 尝试记录

- `sslip.io` 的 Let's Encrypt HTTP-01 尝试失败：CA 报告 unauthorized / invalid response `403`；服务器访问日志同时显示有一个 Let's Encrypt validator 收到 `200`，结果在不同验证 vantage 之间不一致。未签发证书。
- `nip.io` 的 Let's Encrypt HTTP-01 尝试失败：CA 报告 `Connection reset by peer`。未签发证书。
- 本机和服务器侧的预检 challenge 文件可访问。临时 ACME Nginx 站点及预检文件均已移除；没有为 `sslip.io` 或 `nip.io` 创建证书。当前 Preview 使用现有有效 IP 证书。

## 停止本机 Preview

先查询 `4318` 的监听 PID，检查其命令行，并沿 `ParentProcessId` 确认专用本机 Preview launcher。只对已核实的 launcher PID 执行以下命令；不要把未经核对的端口 PID 直接代入：

```powershell
Get-NetTCPConnection -LocalPort 4318 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId = <已核实的 launcher PID>" |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
taskkill /PID <已核实的 launcher PID> /T /F
```

这只停止本机 Preview launcher 及其进程树；若该 launcher 启动了 Preview CUA，CUA 也会随树停止。它不会停止服务器上的 Relay Preview。

## 服务器回滚（记录命令，未执行）

需要撤下 Preview 时，仅停止 Preview unit、移除 Preview Nginx 站点链接并校验/重载 Nginx：

```bash
sudo systemctl disable --now computer-harness-relay-preview.service
sudo rm /etc/nginx/sites-enabled/harness-relay-preview
sudo nginx -t
sudo systemctl reload nginx
```

只有 `nginx -t` 成功后才执行 reload。回滚保留 Preview release、配置和现有证书；不得触碰旧服务或旧 `current`。上述服务器命令仅作操作记录，本次没有执行回滚。

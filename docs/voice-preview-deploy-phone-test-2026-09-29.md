# 语音手机 Preview 部署与测试记录

日期：2026-09-29
状态：隔离 Preview 与本机 Host 已于 2026-10-04 更新到窗口/中途播报修复版本，基础检查通过，可开始下一轮手机实机测试。
范围：仅记录语音 Preview 部署、连接检查、手机测试入口和回滚方式；未更改旧服务。

## 部署状态

- Preview 当前使用独立 release：`/opt/computer-harness-preview/releases/2026-10-04-window-progress-v1`；Preview 的 `current` 符号链接已切换到该 release。此前 `2026-10-03-runtime-surface-v2` 和 `2026-10-02-cross-window-v1` 均保留，可作为回滚点。
- `computer-harness-relay-preview` 服务处于 active，只监听 loopback `8788`。Nginx 在 `8443` 提供 TLS：`https://47.108.197.221:8443`，使用现有有效 IP 证书。用户已开放 `8443`。
- 旧入口 `https://47.108.197.221` 及旧服务、旧 `current` 均未修改，仍健康。
- stable release 仍为 `/opt/computer-harness/releases/a-line-20260928-130957-252edf4`；本次未切换或重启 stable。
- 公网检查结果及边界见下方 2026-10-03 更新记录。它们不代表手机麦克风或完整语音任务已经验收。

## 2026-10-04 窗口与播报修复部署

部署 commit：`5f0efe00b6d1ca3e66320283a745f15755858f07`，分支 `codex/runtime-surface-preview-20261003`；源码 tar.gz SHA-256：`0C7BD877FF33135B4239D6486AC6C33BF91492EA5B478B956EDFC81A26D73533`。服务器保存 `.release-source`，不含本机密钥、轨迹或截图。

- Windows 根构建通过；全量 107 文件、1312 项通过，脚本 31 通过、1 项跳过。记事本菜单返回与 WPS 列窗/切换/Ctrl+A/Esc 实机成功，见[修复验收](./window-and-progress-repair-results-2026-10-04.md)。
- 服务器 frozen lockfile 安装、Web/Relay 依赖构建和入口语法检查通过，Preview current 已原子切换。重启后第一次 health 发生启动竞态而连接失败；稍后公网复查 health `200`、新 asset `/assets/index-Br-MqOQ2.js` `200`、匿名 `/api/runs` `401`；stable health `200`。旧服务未切换。
- 本机旧 Host 已停止，新 Host 使用本轮构建与原 `.env.voice-preview`、原 CUA socket，监听 4318；`/connect` 返回 `200`，至服务器 8443 的连接 established。没有重启 CUA 或清除浏览器登录 profile。
- 新日志与任务目录：`runs/voice-preview-window-progress-20261004/`，任务在其 `sessions/` 下。手机必须重新配对，新页面应来自上述新 asset。任务中途语音仍可能被模型漏报，不能用基础 health 证明语音端到端通过。

现在打开 `http://localhost:4318/connect`，手机重新扫码配对，使用 `https://47.108.197.221:8443`。首先复测 WPS 菜单/弹窗与携程→记事本任务，开启朗读关键通知；无需重新登录已保存的网站。

## 2026-10-03 Runtime / Surface Preview 更新记录（历史）

部署源码来自分支 `codex/runtime-surface-preview-20261003` 的 commit `600ccecc713737049267b350cfc983cb3942d80c`；源码归档 SHA-256 为 `09931D26140D9FB4CB80BBD361E07567CBF3225E94ECD7DE2E3A2B97D4884562`。服务器 release 内保存 `.release-source`，记录分支、commit 与归档哈希。

- 本机 Node 24 冻结回归为 106 个测试文件、1274/1274 通过；根类型构建和历史 CUA spike 类型检查通过。Notepad 实机验证在同一 ComputerSession 中完成父窗口 → 菜单 child Surface → 父窗口，记录 `child_push` 与 `child_pop`，两次动作均 completed，Run、owner 与 lease 正常释放。
- Preview release 在切换前完成 frozen lockfile 安装、Web 构建、Relay 及其 workspace 依赖构建、Relay 入口 `node --check`。`current` 从 `2026-10-02-cross-window-v1` 原子切换到 `2026-10-03-runtime-surface-v2` 后重启 Preview unit。
- Preview unit 为 active；loopback health 与 `https://47.108.197.221:8443/healthz` 均返回 `200`。根页面引用 `/assets/index-BcxT7NPa.js`，该 asset 返回 `200`；匿名 `GET /api/runs` 返回 `401`。旧 stable health 仍返回 `200`，本次未切换 stable。
- 本轮只更新服务器 Relay/Web release；电脑端 Host 仍需从同一分支启动，才能实际使用本轮 Surface Registry、平台 SDK 路由和 Runtime 修复。Relay 重启会清除内存会话，手机需要重新配对。

如需回退本轮 Preview，仅将 Preview `current` 原子恢复到保留的 `2026-10-02-cross-window-v1`、重启 `computer-harness-relay-preview.service`，再复查 health、静态 asset 与匿名 API 拒绝。不得改动 stable 的 `current`。

## 2026-10-02 Preview 更新记录

本次部署包 SHA-256：`1411ED3B62BACD8123C913F1D95820396281AFAD9FB0BD5786F05CF273F46126`。隔离 Preview 的 `current` 已指向 `/opt/computer-harness-preview/releases/2026-10-02-cross-window-v1`，旧 Preview release 留存；stable 仍指向 `/opt/computer-harness/releases/a-line-20260928-130957-252edf4`。

- Preview Relay active，服务只监听 loopback `8788`。使用正确 Host `47.108.197.221:8443` 检查 health 返回 `200`。一次错误 Host 的 health 请求返回 `403`，属于 Host 校验 fail-closed；使用正确 Host 后检查通过。
- 公网根页面引用 `/assets/index-C5cxMpjt.js`，该 asset 返回 `200`。匿名 `GET /api/runs` 与 managed-browser profile 查询返回 `401`。恶意 Origin 的 profile `prepare` 请求返回 `403`；正确 Origin 但没有配对 session/CSRF 的请求返回 `401`。这些结果表明边界拒绝符合预期，不是已完成登录或 profile 准备。
- 本机 Host 固定监听 `4318`，`/connect` 返回 `200`。Node PID 会动态变化，故不记入文档。服务器侧观察到 Nginx 与 Preview Relay `8788` 之间已有 established WSS；本次复用既有 CUA daemon。
- 首次远端尝试发现系统缺少 `unzip`，在切换 symlink 前即停止，未改变当前 release。随后通过 Python 对 ZIP entries 做安全校验和解压，再原子切换 `current`。本次没有记录密钥、口令或私有日志正文。
- 本次只进行部署及连接边界检查；没有启动 Run、profile prepare、浏览器、模型请求或桌面操作。Relay 更新后手机必须重新配对，不能沿用重启前的 session。

如需仅回退 Preview 应用版本，可将 Preview `current` 原子恢复到保留的 `/opt/computer-harness-preview/releases/2026-09-29-voice-natural-v6`，然后重启 `computer-harness-relay-preview.service` 并重做正确 Host 的 health 与静态 asset 检查。此版本回退尚未执行，且不得改动 stable 的 `current`。本文件后面的“服务器回滚”命令表示完全停用 Preview 服务和入口，不是应用版本回退。

2026-09-29 第二次更新加入：语音开关在用户手势内立即试播、首次进入 Run 时只补发固定“任务已开始”通知、手机显式整个桌面目标，以及 GLM-5.3-Flash `reasoning_effort=low`。整个桌面不会由自动选窗静默启用；它可能把其他可见窗口送入 Provider，仅作为独立弹窗未被窗口捕获时的显式兼容路径。部署前本地全量为 93 个测试文件、930 项通过；脚本 19 项通过、1 项因 Windows 无符号链接能力跳过，强制 Web 构建和服务器构建均通过。

2026-09-29 第三次更新修复手机播报的可观察性和语言选择：开始提交任务的直接手势会先播报“正在发送任务”，用于解锁限制后台自动播音的移动 WebView；所有浏览器 TTS utterance 固定为 `zh-CN`，优先选择普通话 voice 并排除粤语 voice；播放中的 utterance 保持强引用，避免移动 WebView 提前回收。动作后判断的 milestone 标准放宽为“新截图已确认完成一个独立用户子目标或稳定阶段结果”，但聚焦、选中、打开菜单和动作 receipt 不算进展。更新后全量为 93 个测试文件、932 项通过；脚本 19 项通过、1 项跳过。真实 GLM low 两轮协议探针成功，但手机是否真实出声仍必须由真机验收。

2026-09-29 第四次更新修复审批通知的客户端竞态：Web 现在直接按 SSE 序列维护当前 pending request，旧 GET snapshot 不得覆盖更新的审批状态；审批 resolved 后会立即取消或抑制旧通知。创建 Run 后使用同文档 History API 导航，不再整页刷新并丢失移动浏览器的语音激活上下文。新增测试覆盖审批通知早于 GET、快速 resolved、SSE replay 去重和同文档导航；全量为 93 个测试文件、937 项通过，脚本 19 项通过、1 项跳过。该修复不改变 Guard、RuntimeEvent 或 TTS Provider。

2026-09-29 第五次更新增加逐 Run 的动态通知正文 opt-in：只有手机开启“朗读任务关键通知”后新建的 Run 才会朗读当前审批原因和已验证的 milestone summary；旧客户端和关闭设置的 Run 继续使用固定安全文案。动态正文在截断前执行控制字符规整和敏感内容扫描，审批继续绑定当前 requestId，普通 assistantText 与 Monitor 原始结论不朗读。`run-start` 不再占用 12 秒进度冷却，首个真实 milestone 可立即发布；后续进度仍限流。Monitor transition 的 receipt/observation 来源事件 ID 也加入绑定校验。Luna 实施、Sol 复审均通过；全量为 93 个测试文件、945 项通过，脚本 19 项通过、1 项跳过，完整 typecheck 通过。

2026-09-29 第六次更新不再朗读 Guard 的英文内部 reason。审批通过 `callId` 精确关联已提交的 `action.guard.evaluated`，只用有限结构化风险类别与动作类型生成简短中文“可能涉及”提示；不播坐标、输入值或模型未验证的 target/summary。已验证 milestone 直接朗读安全的 `progress.summary`，不再添加机械前缀；内部 `progressSemantic` 使已验证 milestone 不被普通阶段提示的冷却永久丢弃，字段不进入公共 wire。只有 succeeded 可朗读动态终态摘要，失败、取消、预算耗尽和结果未知始终播报各自状态。Luna 实施、Sol 多轮复审后无 P0/P1/P2；全量为 93 个测试文件、947 项通过，脚本 19 项通过、1 项跳过，完整 typecheck 与构建通过。

真实 GLM 探针先验证 `thinking.type=disabled` 被服务端以 HTTP 400/1210 拒绝，随后使用 `thinking.type=enabled` 与 `reasoning_effort=low` 成功：单请求约 24.1 秒，输入 219、输出 644、合计 863 tokens。该探针使用无截图、无桌面动作的合成文本，不证明真实 GUI 任务质量；它证明 GLM-5.3-Flash 不能关闭思考，Preview 只能降到 low。

## 2026-09-29 历史来源与摘要

首轮部署内容来自工作树快照；发现 Relay 未接受新增 `assistantPreferences` 后，修复已提交为 `082dbf8a5e1b7e1c37d91860d7fff77ffcce73b4`，服务器从该提交的 `git archive` 构建并原子切换到当时 Preview release。它仍不是 Git tag 或正式 GitHub Release。

| 项目 | 标识 |
| --- | --- |
| 基线 commit | `743e94da00ac29bad05884e869a178159b47d626` |
| 已跟踪 diff SHA-256 | `ae693be41c45b8c3cb5c8e9f346d206a4cb1081af3106300649dd05fd5ecd6ce` |
| 部署 overlay SHA-256 | `9f7fcb6027b424bf518fb33e4f8dea5308ea05b9632928c77fa28590cbb0a3a3` |
| 构建 artifact SHA-256 | `29a93e8af3da2defadf69d55bec1f93e26ae191b12777cb96e4a9099d4930ae9` |

此前 `082dbf8` 修复 release 的源码 ZIP SHA-256 为 `91122c31e79572ca3296e656fa51e9b593ffa1cfa11a8e692162191791e8715b`。首轮手机已成功配对，语音 session/audio/finish 均返回成功；开始任务时 `POST /api/runs` 连续返回 `400`，且 Host 未创建 Run。根因是 Relay 的精确请求白名单尚未接受 Web 新增的 `assistantPreferences`，请求在到达 Host 前被拒绝。修复后 Relay 复用 Host 同一份 protocol normalizer，并补充 Relay 合同及真实 Web→Relay→Host WSS roundtrip 测试。Preview Relay 重启会清空内存 session，用户必须重新扫码配对后复测。

第二次更新的未提交 tracked diff 摘要哈希为 `3ff57e58d70cad30e24b7d777909e3880b38354c`；服务器仅从 Git tracked 基线与这组 tracked overlay 构建，不包含 `.env.voice-preview`、本机运行轨迹、截图或 API 密钥。它仍需后续形成正式 commit 后才能作为可复现源码基线。

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

本机当前 Host 日志：`runs/voice-preview-window-progress-20261004/host.stdout.log`、`runs/voice-preview-window-progress-20261004/host.stderr.log`。

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

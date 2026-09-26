# 手机部署进度与 CI 复核（2026-09-26）

## 结论与证据范围

有条件继续 staging 联调；暂不作为完整发布验收通过。目标分支 `codex/mobile-control-handoff-20260926` 最新提交 `430698b`，PR #14 为 OPEN / UNSTABLE。本地 HEAD 为 `4bf7288`，远端新增一份部署记录，业务代码相同；本次 fetch 后只读比较，没有 merge、改业务代码、重跑 CI 或推送。

- [PR #14](https://github.com/wszkxlllll/Computer-Harness/pull/14)
- [队友部署记录](https://github.com/wszkxlllll/Computer-Harness/blob/430698b9a5de8f145e0322fefc3e5c5d85b66589/docs/relay-staging-validation-2026-09-26.md)
- [CI 原始运行](https://github.com/wszkxlllll/Computer-Harness/actions/runs/36238140141)

本次独立核对提交、失败 job 日志、相关源码和部署报告；未登录服务器、操作桌面、调用模型 API，未独立重演队友真机实验。

## 进度同步

`f605d09` 窗口交接与所有权、`6a63d6a` Host/Relay/Web、`5a6abf5` 受控探针、`84fa3ac` CI 前置 Web 构建，以及后续文档提交已进入分支。`430698b` 增加公网部署证据。

队友报告：部署基线 `4bf7288`，Relay/systemd、可信短期 IP TLS 证书及续期、WSS/SSE、安卓 Chrome 扫码配对、确认/撤销、结果/截图、暂停/纠正/恢复、换网、锁屏返回及部分去重/大小限制测试完成。服务器四文件九测试通过，不等于完整仓库 CI 全绿。

重要边界：公网和安卓是真实的，但 Computer/Provider 是 fake fixture。它证明控制和传输链路，不证明手机→Windows CUA→真实应用全链路。iPhone、真机审批、断线未知副作用不重放的完整行为验证仍缺；既有 Windows 输入、弹层和跨窗口问题不因此关闭。

## CI：两类故障，不是构建/身份问题

| Job | 结果 |
| --- | --- |
| Ubuntu 24.04 / Node 22.13 | 724/725，浏览器端口文件测试失败 |
| Windows 2025 / Node 22.13 | 723/725，资产读取及 Relay 资产返回失败 |
| Ubuntu 24.04 / Node 24.19 | job 通过 |
| macOS 15 / Node 22.13 | job 通过 |

四路依赖安装、类型检查及 Web 构建均通过。`ci-required` 失败是上游矩阵失败的汇总，不是第三个根因。本次没有 contributor-attribution 失败证据。

### P1：Windows 合法截图资产被拒绝

`packages/app-runtime/src/remote-run-api.test.ts:311` 抛出 `remote asset changed while it was being opened`，来自 `remote-run-api.ts:112`。同平台 `apps/host/src/relay-roundtrip.test.ts:220` 取截图期望 200，实际 502。

读取器比较 lstat 与 file.stat 的文件类型、长度、dev/ino，以及 realpath containment。确认故障发生在资产安全校验层；Windows 两项失败高度疑似同源，但日志没打印哪项比较失败，不能直接宣布是 inode 精度或 Node 缺陷。若生产环境同样触发，Run 可以完成而手机截图无法显示。

修复前：在 Node 22 Windows 的合成文件测试记录两侧 stat 原始数值、BigInt 版本和 containment 判断，分别排除 dev/ino 表达差异、大小与路径问题。修复必须保留越界、符号链接/junction、替换文件、错误长度等负向测试，不得通过删除安全检查让 CI 变绿。随后联跑 Reader 与 Relay roundtrip。

### P1：DevTools 新文件被视为未就绪

`managed-browser-host.test.ts:304` 在已写入端口文件后，以 300ms 等待得到 `managed browser DevTools startup timed out`。实现 `managed-browser-host.ts:1142–1161` 除轮询外，还拒绝 `mtimeMs < notBeforeMs` 的文件。

可能原因包括 300ms 在 CI 下过紧，以及文件时间与 Date.now 的精度/更新语义使真正新文件持续被视为旧文件。当前日志不能二选一；不能只归咎网络（此测试没有启动真实浏览器，也不访问公网），也不能只加超时掩盖时间判定问题。

建议分离“清旧文件且保留 Cookies”“新文件准入”“旧文件拒绝”“缺失/退出/Abort/超时”测试，显式控制文件时间，验证新鲜度定义；保留一项宽裕但有界的真实文件 I/O 集成测试。不要降低生产目标身份约束。

## 部署报告需落实的产品问题

1. **P1 / Nginx 模板**：README 的 `location /api/runs/` 仍在，队友服务器已热修。需同时正确覆盖集合路径 `/api/runs` 与子路径，验证 GET/POST 不跳转、SSE 不缓冲；只修服务器会让下一位部署者复现。
2. **P1 / 配对竞态**：成功后显示过期的真机现象应保留，但“connected 后完全没停止轮询”不符合源码：effect 已排除 connected 且清 interval。更具体的风险是 `setPairState(approved)` 触发 effect cleanup，令正在 establish 的旧闭包 stopped，成功结果被丢弃；共享 sessionPending 又可能阻止新闭包建立会话。还有异步 interval 重叠风险。需要 deferred promise 回归复现 pending→approved→session success、旧响应晚到、卸载/重入，采用单一串行轮询/终态控制，而非只再加 connected 判断。
3. **P2 / 文案**：ConnectPhoneScreen 仍硬编码“公网中继尚未部署”。应由实际能力/配置决定提示，不能改成所有部署都成功。
4. **P2 / 报告安全与可复现性**：公共交接材料不宜包含手机公网 IP、账号共用密码的描述或凭据存放线索；敏感运维细节保留私有。回退段批量删除整套 `/etc/letsencrypt` 等共享目录风险过大，应仅撤销本服务资源，不影响原站点。L3 fake 驱动未跟踪，后续应交付脱敏可复现 fixture，而非依赖私人脚本。

## 推荐顺序与放行条件

1. 先定位并修复两类 CI 故障；不以 rerun 偶然变绿替代归因。
2. 同批修复配对竞态与部署模板、清理报告运维敏感信息/广泛删除指令。
3. 四矩阵全部通过，再复验安卓首次配对停留页面、截图读取和真审批流程。
4. 使用真实 Windows Host 做手机端小任务及跨窗口任务；原有 CUA 问题保持独立问题单。完成后再决定 PHONE-PUBLIC 放行范围；安卓与 iOS 分别声明。

本次只新增审计文档并同步主入口状态，未执行上述代码修复。

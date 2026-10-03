# Linux CUA 0.32.0 配对验证摘要（2026-10-02）

来源：[PR #19](https://github.com/wszkxlllll/Computer-Harness/pull/19)，commit `e4ce63478774b191c6b91df03f68e7329f937d7c`；作者 Yao GX 的实机报告。以下内容保留为作者报告，尚未由当前 Runtime 集成负责人独立复现。

## 范围

测试环境为 CachyOS、Plasma X11。该报告验证仓库外单独安装的 CUA 0.32.0 SDK 与同 release daemon 配对，不包含 Computer Harness 源码或锁文件修改；报告记录当时 `packages/computer-cua` 仍使用 0.22.2。它不能证明当前仓库 adapter 已支持 Linux 0.32.0，也不能替代仓库运行时集成验证。

报告说明，0.22.2 GitHub release daemon 与 npm SDK 来自不同构建，连接时报 Transport 错误；使用同 release 的 0.32.0 daemon 和 npm SDK 后，SDK 与 daemon 成功连接。Wayland 未测试，报告结果仅覆盖 X11。

## 报告结果

- SDK 通过 release tarball 本地安装和 npm registry 安装两种方式，均完成 `CuaDriver.connect()` 与 `metadata()`；metadata 报告 `driverVersion: 0.32.0`、`contractVersion: 0.8.0`。
- 0.32.0 doctor 在 X11 上报告连接正常；`get_desktop_state` 返回有效的 2520×1680 PNG 和窗口清单。桌面截图没有保存到仓库。
- 隔离 Chromium 子链路中，导航、视口截图、前台点击和静态页文本输入通过。后台点击因 Linux Chromium 缺少受信任 CDP 输入能力而被拒绝；动态页面三次遇到 DOM 重渲染导致的 `browser_ref_stale`。
- 报告发现快照 label 的 `value=` 反映 HTML 属性，不代表输入框实时 property；人工核对输入内容需使用截图或其他实时状态证据。

## 使用边界

该证据不表示 Wayland 支持，不表示动态网页引用不会过期；报告本身不能证明当前仓库集成后的 Runtime 链路。当前代码已按平台选择 SDK：Windows/macOS 0.22.2、Linux 0.32.0；Linux 仍需运行 doctor 确认 SDK/daemon 配对，并完成当前 adapter 与 Runtime 的实机集成验证。报告中的实机结果、未保存截图及机器本地日志没有在本轮独立复验；仓库内 Hosted CI 的离线合同测试也不能替代这些桌面结果。引用该报告时须保留这些范围和来源说明。

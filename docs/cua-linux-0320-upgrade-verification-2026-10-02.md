# CUA 0.32.0 升级验证报告：09-25 Transport 阻塞已解除（Linux 平台）

日期：2026-10-02
执行：成员 C（本机 CachyOS，Plasma X11 会话）
角色：T02 Linux 侧解封证据；Linux 平台 CUA driver 升级决策与依据
关联：[CUA 坐标与输入诊断](./cua-coordinate-diagnosis-2026-09-26.md)（坐标问题另案）、[Linux 平台适配记录](./linux-platform-adaptation-2026-09-17.md) §4/§7（版本边界与门控）

## 结论

**0.32.0 同管道配对（GitHub release daemon + 同 release npm tarball）完全打通 SDK↔daemon 协议**：`CuaDriver.connect()` 无 Transport 错误、`metadata()` 正常返回、`doctor` 全绿、`get_desktop_state` 真实工具调用成功截取 2520×1680 有效 PNG。npm registry 安装路径（仓库升级的实际路径）同样连通。**T02 Linux 侧的 0.22.2 Transport 阻塞不再成立，前提是 SDK 与 daemon 升到同 release 的配对版本。**

## 根因再分析（修正 09-25 结论）

09-25 的"协议不兼容"根因是**同版本号、不同构建管道**，而非协议本身缺陷：

| 09-25 尝试 | daemon 来源 | SDK 来源 | 结果 |
|---|---|---|---|
| 0.22.2 | GitHub release 二进制 | npm（2026-08-27 发布，与 GH release 非同次构建） | ❌ Transport |
| 0.28.2 | **AUR 包**（源码本地构建） | npm | ❌ Transport（预期：不同构建） |

**0.30.x 起上游把 daemon 二进制与 npm tarball 放进同一个 GitHub release、同 CI 分钟级发布**：

| 版本 | GH release daemon | npm SDK | 间隔 |
|---|---|---|---|
| 0.30.4 | 09-28 21:38:59Z | 09-28 21:43:28Z | ~5 分钟 |
| 0.31.0 | 09-30 16:46:18Z | 09-30 16:52:51Z | ~6 分钟 |
| 0.32.0 | 10-01 21:34:36Z | 10-01 21:40:21Z | ~6 分钟 |

且 `cua-driver-rs-v0.32.0` release 资产中直接包含 npm tarball（`trycua-cua-driver-0.32.0.tgz` + `trycua-cua-driver-linux-x64-gnu-0.32.0.tgz`）及官方 `typescript-sdk-checksums.txt`——管道同源可校验。

## 实验设置

- 会话：Plasma X11（`XDG_SESSION_TYPE=x11`，`DISPLAY=:0`；Wayland 未测，0.32.0 release 含 `wayland-helper` 组件）
- daemon：`cua-driver-rs-0.32.0-linux-x86_64-binary.tar.gz`，SHA256 `bb006010…f39a6` 与官方 SHA256SUMS 一致；解压后二进制自报 `cua-driver 0.32.0`
- SDK：两路各测一遍——①同 release tarball 本地安装；②`npm install @trycua/cua-driver@0.32.0`（registry 路径）
- 隔离：自定义 socket（测试目录 `test.sock`），不触碰默认 `~/.cache/cua-driver/`（09-25 残留 sock/pid 已清）
- 不动仓库：`packages/computer-cua` 仍钉 0.22.2，本实验零仓库代码改动

## 验证结果

**① connect + metadata（09-25 失败项，两条安装路径均通过）**

```json
{
  "driverVersion": "0.32.0",
  "contractVersion": "0.8.0",
  "toolsListSchemaVersion": "1",
  "capabilityVersion": "1",
  "mcpProtocolVersion": "2025-06-18",
  "pid": 11988,
  "embedded": false
}
```

字段集与仓库 `capability-doctor.ts` 校验的 metadata schema（driverVersion/contractVersion/toolsListSchemaVersion/capabilityVersion/mcpProtocolVersion/pid/embedded）**完全对应**。

**② doctor 全绿**：binary 0.32.0、X11 connected（6 可见顶层窗口）、AT-SPI org.a11y.Bus 可达。

**③ 真实工具调用 `get_desktop_state`**：返回有效 PNG（魔数校验通过，736 KB，2520×1680）+ 真实窗口列表（桌面/Dolphin/Konsole/plasmashell）；截图含用户桌面属隐私，未留存。第二轮复测（15:21）同样通过（759 KB，含 Chrome 窗口）。

## 第三轮：Chrome 浏览器子链路验证（2026-10-02 15:27–15:40）

在第一、二轮（connect/metadata/doctor/get_desktop_state）通过后，针对任务卡所需的真实网页交互能力，用 `browser_*` 工具链做了专项验证。**隔离方案：`browser_prepare`（allow_launch=true + isolated_new）启动 driver-owned 一次性 profile 的独立 Chromium，全程不触碰用户日常 Chrome（side_effects 报告全 false，用户浏览器未开 CDP 端口也未被附加）**。

| 验证项 | 结果 |
|---|---|
| 隔离启动 + bind 绑定 | ✅ `get_browser_state` exact 绑定（native_cdp_window，pid+window_id），tab/target id 会话级发放 |
| 导航 | ✅ `browser_navigate` 多次成功（example.com→iana.org→baidu→duckduckgo），refs_invalidated 正确标记 |
| 元素快照 | ✅ dom_refs_v1 契约（`p<快照>:<序号>`），动态页 99 refs、静态页正常 |
| 点击（background） | ✅ **正确拒绝** `browser_input_trust_unavailable`：Linux Chromium 的 trusted CDP 输入会激活窗口，fail-closed 是设计行为 |
| 点击（foreground） | ✅ 点击 (510,426) 生效，导航到 iana.org（effect=unverifiable 为保守标注，实际后效已由下一快照验证） |
| 输入（静态页） | ✅ `browser_type` insert_text 29 字符入框，视口截图目视确认 |
| 输入（动态页，百度） | ✗ **3 次 `browser_ref_stale`**：页面 DOM 持续重渲染使快照 ref 到手即失效，重新快照仍追不上；属已知限制类（refs 因导航/新快照/页面变化失效），与 09-26 UIA grounding stale ref 同类 |
| 视口截图 | ✅ `include_screenshot` 经 CDP 捕获 1783×1348 PNG，不前台化、不选中标签页 |

**验证口径发现**：快照 label 里的 `value=` 读的是 HTML **属性**而非实时 **property**——`browser_type` 成功后 label 仍显示 `value=`（空），验证输入内容不能依赖 label，须用截图或 JS 读取。对人工核对点设计有直接影响（"输入框内容正确"应以截图/JS 为准）。

**结论**：浏览器子链路（导航/点击/截图/静态页输入）在 0.32.0 配对下可用；动态重渲染页面的 ref 失效是真实缺口，涉及动态页面（微信小程序等）的任务需预留重快照/视觉坐标兜底策略。

## 升级范围与约束（Linux-only）

1. **范围（2026-10-02 决定）**：**仅 Linux 平台**升级 0.32.0 配对（daemon + SDK 同 release）；**Windows/macOS 维持 0.22.2 配对不变**。因单一依赖版本无法按 OS 区分，Linux 落地需要仓库侧"按平台选择 SDK 版本"的路由（依赖别名或带 os 字段的包装包），为后续变更、需组长批准；落地前 Linux 用独立安装复测。`capability-doctor` 的版本预期需随 contractVersion 0.8.0 核对（字段 schema 已兼容，语义版本断言需查）。
2. **SDK API 面**：主包新增 `./fleet`（0.27.0 起）、`./electron`、`./embedded` 导出；`CuaDriver.connect(socketPath)` / `metadata()` 签名未变。平台包名不变（`@trycua/cua-driver-linux-x64-gnu`）。
3. **daemon 获取与配对原则**：daemon 与 npm client 必须同 release——禁 latest、禁 AUR 源码构建混搭（09-25 教训）。各平台 release 资产 + tag 固定安装脚本齐备。
4. **Windows/macOS 不受本变更影响**：两平台继续使用 0.22.2 配对；win32 资产在本 release 同样存在，未来如升级需在 Windows VM 重跑验收（另案）。
5. **隐私**：0.32.0 daemon 默认开启 content-free telemetry（serve 启动日志明示），采用时建议评估 `cua-driver telemetry disable`。
6. **Linux 支持等级**：release notes 仍标 "Linux preview builds"；Wayland 有 `wayland-helper` 但未验证，本证据仅覆盖 X11。

## 复现步骤

```bash
# 1) 下载并校验（大文件网络不稳时用 curl -C - 断点续传）
BASE=https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.32.0
curl -fsSL -C - -o cua-driver.tar.gz \
  "$BASE/cua-driver-rs-0.32.0-linux-x86_64-binary.tar.gz"
sha256sum cua-driver.tar.gz   # 对照 SHA256SUMS

# 2) 解压、起 daemon（自定义 socket 隔离）
tar xzf cua-driver.tar.gz && ./cua-driver serve --socket <test.sock>

# 3) registry 安装 SDK 并测 connect（或用同 release tgz 本地安装）
npm install @trycua/cua-driver@0.32.0
node connect-test.mjs <test.sock>          # CuaDriver.connect().metadata()

# 4) 健康与全链路
./cua-driver doctor
echo '{}' | ./cua-driver call get_desktop_state --socket <test.sock>
```

## 现场遗留

- 成员 C 本机保留测试目录（约 200 MB）：daemon 二进制 + npm tarball + 两个 SDK 安装 + `connect-test.mjs` 复测脚本；日志与视口截图（不含用户桌面全屏截图）留本地待查看后清理
- daemon 已停；09-25 旧 0.22.2 二进制 `~/.local/bin/cua-driver` 未动
- **本 PR 为零代码改动**：`packages/computer-cua`、lockfile 与其他平台配置均未触碰

---

**状态**：验证完成；范围已定（2026-10-02：仅 Linux 平台升级 0.32.0 配对，Windows/macOS 维持 0.22.2 不变）。相关文档随本 PR 更新：`docs/getting-started.md` §3、`docs/linux-platform-adaptation-2026-09-17.md` §4/§7、`Linux设备使用完整指南.md` §5.3/§7
**维护者**：成员 C

# A 线开始前 macOS 本机预检

日期：2026-09-27。基线：`bff7cf7`（`origin/main` / PR #16）。
状态：代码、离线回归、只读 macOS 核心链路、普通窗口输入、窗口清单收敛、隔离持久 profile 生命周期和启动网址重载通过；公开演示站点的隔离持久登录态已验证；临时 profile 在无法确认浏览器退出时会保留目录；保存弹窗已改为严格焦点校验并保留显式交接限制，手机控制待实体设备验收。

## 1. 结论

当前可以继续 A 线的代码准备和受控普通窗口任务，但仍不能把 Mac 端标记为“全部功能正常”。精确窗口发现/截图、Mac 辅助窗口过滤、临时及隔离持久受管浏览器（含启动网址重载）、本机 Host/Web 配对和普通 TextEdit 输入已通过；保存弹窗会在焦点证据不足时安全拒绝，显式跨窗口交接和真实手机控制仍需验收。

本机原先运行 `/Applications/CuaDriver.app` 0.20.0，而仓库与 npm client 固定为 0.22.2。用户明确授权后已确认 Accessibility、Screen Recording 和 macOS direct capture，旧 daemon 已停止，仓库 0.22.2 已在项目 socket 启动。项目 doctor 仍因其保守的桌面范围判定返回 `desktop_capture_scope_unconfirmed`，但后续精确窗口真实截图成功，证明当前权限和窗口级捕获链路可用；不能据此放行整桌面捕获。

## 2. 本次实际验证

### 代码与构建

- `pnpm run typecheck`：通过。
- Web 生产构建：通过，生成与远端记录一致的 `index-BQke8zyL.js` / `index-BsDYwWuu.css`。
- `pnpm test`：84 个测试文件、820 项 Vitest 全部通过；随后 20 项 Node TAP 脚本测试全部通过。
- 首次全量测试因本机缺少 `apps/web/dist`，Relay roundtrip 首页返回 404；补建 Web 后该用例及全量测试均通过。这是测试前置产物缺失，不是业务源码回归。

### 本机环境

- macOS 26.4（25E246），Apple Silicon `arm64`。
- Node.js 22.17.0，pnpm 11.19.0。
- Google Chrome 153.0.8010.54。
- CLI、Host、Web 构建产物均存在。
- 仓库内 CUA 0.22.2 为 universal Mach-O（arm64/x86_64），签名 Team ID 为 `YCK386LBJ7`，带 notarization ticket。

### CUA 真实诊断

1. 本地配置指向 `/tmp/computer-harness-project-501.sock`。初检时该 socket 只有残留文件、没有进程占用，项目 doctor 返回 transport unknown。
2. 初检时系统 daemon 来自 `/Applications/CuaDriver.app` 0.20.0。用户授权后已停止该进程，并用仓库 0.22.2 启动项目专用 socket；没有升级到项目未固定的 0.30.1。
3. 使用仓库内 0.22.2 和独立临时 socket 启动隔离 daemon 后，项目 doctor 实际确认：
   - driver 0.22.2 / contract 0.7.0：supported；
   - 工具库存：supported，共 56 项；
   - window discovery、foreground、window capture 声明：supported；
   - session：unknown，原因为 `desktop_capture_scope_unconfirmed`；
   - health / permissions / cleanup 因 session 未建立而保持 unknown。
4. 用户明确授权后运行 0.22.2 `permissions grant`，工具确认 Accessibility、Screen Recording 和 direct capture 均已允许。
5. 使用可见 ChatGPT 窗口做无输入精确捕获：窗口清单返回准确 PID/windowId和几何；`verify_state` 成功、几何稳定，获得一张 PNG（1568×1076）；session 完成清理，没有点击、键入或模型调用。
6. 使用 `on_screen_only=false` 的完整顶层清单做自动匹配时，Mac 原始清单包含约 187 个条目，其中有菜单栏、1×1占位和辅助代理。修复后窗口契约过滤退化/菜单/小型代理，按完整 `PID+windowId` 保留真实身份；本次复测归一化为 59 个候选，可见清单为 3 个窗口。`打开不背单词` 已得到唯一安全匹配；微信和 ChatGPT 仍因存在多个有标题真实窗口而保持 `ambiguous`，属于正确的安全回退，不猜测兄弟窗口。
7. 临时受管浏览器使用独立 ephemeral profile 打开 `about:blank`：Chrome 启动、CDP 单标签选择、CUA owned-window 唯一绑定和清理均通过；未读取个人浏览器 profile，未调用模型或发送输入。持久已登录模式尚未验收。
8. 临时 Host 在 4318 使用空环境文件启动：首页、CSRF本地会话和配对状态通过；未配对窗口接口正确返回401。合成手机完成挑战、提交、电脑批准、session建立，已配对窗口接口返回200及3个可见候选。自动微信目标正确返回409 `WINDOW_SELECTION_REQUIRED`，没有创建Run或调用模型；临时Host随后正常关闭。
9. 受控 TextEdit 输入通过：foreground 精确窗口 session 对固定 43 字符多行文本返回 `completed`，TextEdit 只读读回与预期逐字一致（中英文、数字、标点和换行均正确）。
10. 保存弹窗的产品键盘路径未通过：`CMD+SHIFT+S` receipt 返回 `completed` 并打开同应用新 sheet；sheet 的独立 windowId 无法被 `bring_to_front`。在父窗口的 UIA catalog 中可以读到真实 `AXTextField` 文件名字段，但 CUA 0.22.2 对同进程 sheet 报告 `same_pid_keyboard_ambiguity`，`type_text` 的 receipt 虽为 `completed`，复观察仍是原文件名，未将其误判为成功，也没有继续点击保存。
11. 已修复两处 Mac 兼容合同：`CuaDriverComputer` 统一使用严格前台校验；CUA 0.22.2 的 Cocoa 激活结果现在要求 `status=activated`、目标 `window_id`、`observed.focused_window_id`/前台进程和 `exact_window_effect.verified` 一致，若实际前台 HWND 不同则在截图/输入前拒绝。真实 TextEdit 普通窗口复测可正常建立 foreground session，保存快捷键返回 `completed`；未再次发送文件名输入，避免重放此前副作用。保存 sheet 仍必须经 Runtime 的显式新窗口交接确认后继续。
12. 真实 TextEdit 复测了 Runtime 交接前置链路：保存快捷键完成后，`detectNewWindowHandoffCandidates` 发现同进程新建的无标题 sheet 与副本窗口，候选包含准确 PID/windowId；没有自动输入或重放。sheet 本身仍无法通过 CUA 0.22.2 的普通 `bring_to_front` 获得独立前台证据，现明确返回 `WINDOW_ACTIVATION_UNCONFIRMED` 并注明未发送截图/输入，因此继续安全阻断。
13. 使用全新 Host-owned 临时目录在 macOS 启动两次 Chromium `persistent` profile：两次均完成 CDP 页面选择、唯一 CUA owned-window 绑定、关闭和再次启动；未读取个人 profile，也未测试真实登录资料。
14. 在全新 Host-owned `persistent` profile 中注册本机临时 HTTP 启动网址，首次启动后读回 startup metadata；关闭并以 `about:blank` 再启动同一 profile，新的 CDP 标签和 CUA owned-window 绑定均成功。未写入个人目录、未使用账号或凭据。
15. 离线回归覆盖临时 profile 清理失败边界：优雅关闭和强制终止均无法确认进程退出时，保留 profile 目录及文件并报告 `profile_cleanup_failed`，不删除可能仍被 Chromium 使用的目录。
16. 使用全新 TextEdit 测试文稿完成一次原生 macOS 保存 sheet 验收：通过 Accessibility 选中真实文件名字段，输入唯一的 `A-Line-Sheet-Actual-*.rtf`，点击保存后读回文件名和正文；文件名与正文 `A-LINE-SHEET-PRODUCT-TEST\n正文必须保持不变` 均正确。该项证明 macOS 原生 sheet 本身可用，但不等同于 CUA 键盘路由已放行；测试文件已关闭并清理到临时范围。
17. 在全新 Harness-owned 持久 profile 中使用公开 SauceDemo 演示账号完成登录；首次进入 `/inventory.html` 后关闭浏览器，用同一 profile 重启并直接打开受保护页面，登录态仍在且商品数仍为 6。profile 与测试进程已清理；登录动作由受控 CDP 页面脚本完成，因此 CUA 网页键盘输入仍单独标记为未通过（`type_text_incomplete`，实际字符数为 0）。

## 3. 当前功能放行范围

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| TypeScript、Web 构建、单元/集成脚本 | 通过 | 本机独立执行通过 |
| CUA 二进制、协议与工具库存 | 通过 | 0.22.2 metadata / inventory通过，56项工具 |
| macOS 权限与精确窗口捕获 | 通过（窗口级） | 三项权限已允许；精确窗口截图和清理通过，整桌面范围不据此放行 |
| 窗口发现与人工选择 | 通过 | 可见窗口清单与手机候选返回正常 |
| 自动选窗、最小化恢复 | 部分通过 | Mac 清单已收敛；唯一标题目标可自动匹配，多真实标题窗口仍安全回落歧义 |
| 点击、普通窗口中文输入 | 通过（TextEdit） | 固定文本逐字读回正确；尚未覆盖复杂输入法/长文本 |
| 保存弹窗、跨窗口交接 | 原生 sheet 输入通过；CUA 键盘未放行 | 原生 Accessibility 能输入并保存且正文不变；CUA 同进程键盘仍因 `same_pid_keyboard_ambiguity` 复观察不变，前台证据不一致会在截图/输入前拒绝，不能自动重试 |
| 临时受管浏览器 | 通过（只读启动） | ephemeral profile、CDP标签、owned window与清理通过 |
| 隔离持久受管浏览器生命周期与启动网址 | 通过 | 全新 Host-owned profile 两次启动/关闭、窗口重绑定、startup metadata 读回和重载通过 |
| 临时 profile 不确定退出清理 | 通过（离线） | 无法确认进程退出时保留目录并报告诊断，不做破坏性删除 |
| 已登录受管浏览器 | 通过（隔离公开演示账号） | 同一 Harness-owned persistent profile 重启后 `/inventory.html` 仍保持登录，商品数 6；CDP 登录脚本通过，CUA 网页键盘输入仍未放行 |
| Host/Web/本机合成配对 | 通过 | 首页、CSRF、挑战、批准、session、窗口接口和安全回退通过 |
| 真实手机审批、暂停、纠正、取消 | 未完成（设备缺失） | 本机未发现 USB 手机、adb/ios-deploy、Android Chrome/iOS Safari 或 Relay/Host 配对入口；合成配对不能替代实体手机和真实Computer动作 |
| macOS managed-profile 恢复 | 不放行 | 当前源码在 Darwin 无可靠 argv 边界时明确返回 unknown 并拒绝恢复 |

## 4. 下一步顺序

1. 用更多真实 Mac 应用复验窗口清单：普通窗口可唯一匹配时自动绑定；同一应用多个有标题窗口必须继续人工选择，不因过滤而丢失真实 HWND。
2. 完成保存 sheet 的显式交接验收：在新建测试文档上由 Runtime 暂停，人工确认新候选后再输入文件名；只核对目标文件名和正文未变化，不重放此前误写正文的动作。
3. 在已通过生命周期和启动网址重载的 Host-owned profile 中人工登录测试站点，再验证登录态持久化、标签绑定、profile隔离与关闭；macOS profile异常只报告，不运行未放行恢复。
4. 最后连接Host/Web和真实手机，依次验证配对、截图、批准一次执行一次、拒绝零执行、暂停/恢复、纠正、取消和短暂断线。模型调用与外部账号任务另行确认预算和测试资料。

## 5. 人工验证职责

用户需要亲自完成或观察：macOS 权限弹窗、桌面独占、手机扫码、审批/拒绝/暂停/纠正/取消、验证码与账号登录，以及对最终文本、文件和窗口是否正确的核对。

实施侧负责：版本和 socket 统一、doctor 与只读探针、测试数据准备、日志/Run ID 记录、最小修复、自动回归及每次真实结果归档。

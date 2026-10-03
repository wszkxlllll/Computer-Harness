# 手机控制 Harness：功能与架构使用指南

## 1. 先看结论

这是手机网页控制本机 Harness 的首版设施，不是另一套 Agent，也不是远程桌面视频软件。本机实现、自动化回归及受控 SDK 窗口往返已有证据；新的跨窗口 Web/Host/Relay 版本尚未部署到公开页面，真实模型驱动的完整生活任务、真手机无障碍和全部原生应用输入仍未验收。

- 实际测试、指标与失败复测：[技术报告](./mobile-control-technical-report-2026-09-26.md)。
- 服务器安装、TLS、服务运维：[部署指南](../apps/relay/README.md)。
- 已知问题和放行边界：[问题清单](./mobile-control-issues-2026-09-26.md)。
- 独立代码审查：[审查记录](./mobile-control-review-2026-09-26.md)。

不要把“有手机页面”理解为“所有桌面任务均已可靠”。手机入口和底层 GUI 执行能力分开验收。

## 2. 功能清单

| 功能 | 首版范围 | 证据边界 |
| --- | --- | --- |
| 连接手机 | 电脑生成短时配对二维码，电脑确认手机，后续可以撤销 | 本地 HTTP/WebSocket 联合测试；真实手机待部署后验收 |
| 发任务 | 默认按 Goal 自动匹配已打开窗口；也可手动选窗、使用受管浏览器或显式选择整个桌面 | 新目标模式的实施/上线状态见[接入记录](./mobile-target-modes-2026-09-27.md)；不用输入 PID |
| 跨应用完成任务 | 一个逐 Run 开关，四种起点均可使用；默认关闭 | 需要新版 Web、Host、Relay 同步部署；启用后授权本 Run 列窗/切窗，应用名和标题会发给模型 |
| 看进度与结果 | 状态、截图、完整回复、长回复展开 | 浏览器窄屏测试、真实 Run 资产读取；不是实时视频流 |
| 补充要求 | 对当前 Run 发送纠正 | 携程任务已验证一次纠正撤销旧调用并重新观察 |
| 暂停、恢复、停止 | 使用现有 Runtime 控制合同，展示接收和生效状态 | 自动化覆盖；没有逐项实体手机实测证据 |
| 审批 | 展示绑定请求的原因和动作预览，再批准或拒绝 | 自动化覆盖；不是批准一次后永久放行 |
| 窗口交接 | 展示 Runtime 待处理窗口请求，由用户明确选择 | 已有代码路径；完整真实跨窗口验收未通过 |
| 断线恢复 | 补读 Run 快照/事件，不自动重放鼠标键盘命令 | 联合测试；蜂窝网络切换仍待真手机验证 |

未实现：原生手机 App、手机语音入口、长期个性化偏好、完整离线能力、桌面视频串流、后台无焦点操作保证。现有大字/响应式布局不等于完成适老化或读屏用户验收。

## 3. 怎样启动和使用

### 本机预览

在已配置的工作树根目录打开 PowerShell：

```powershell
.\scripts\mobile.ps1 check
.\scripts\mobile.ps1 start
```

随后在电脑打开 `http://localhost:4317`。源码变化需要重建时使用：

```powershell
.\scripts\mobile.ps1 start -Build
```

依赖和隔离运行环境通过 `.harness.local.psd1` 配置。密钥只放在该文件引用的私有 env 文件，不写进命令参数、示例配置或聊天。启动窗口保持打开，Ctrl+C 停止 Host；启动器只清理自己启动的 CUA/开发服务，不停止之前已有的 CUA。

### 真手机使用

手机保留四种起点：自动选择（默认）、手动选择窗口、打开网站、整个桌面（高级）。自动选择仅在本机已打开的顶层窗口中有唯一可信匹配时自动开始；歧义时保留任务并提供选择。起点只决定首次 binding，不限制开启跨应用任务后的模型选窗范围；自动模式不会私自启动原生应用，也不会静默切入整个桌面。

“打开网站”与跨应用 companion 共用同一 Host-managed browser。浏览器默认偏好在手机“设置 → 浏览器与登录状态”选择“本机已准备的登录状态（saved）”或“临时空白浏览器（temporary）”；当前 Web 任务页不再提供逐任务选择。为旧客户端兼容，RemoteRun 的 browser target 仍接受 `sessionMode: "saved" | "temporary"` 覆盖默认值；这个会话模式字段不接受 profile path/label/Cookie。temporary 使用一次性空白 profile；saved 只复用这台受控电脑上的 Harness profile。起始 URL 可以留空，模型可从空白页开始；具体导航仍受任务指令与安全策略约束。

首次准备 saved profile：手机点击“准备登录状态”，电脑上会打开可见的 Harness-managed Edge。用户在电脑完成站点登录后回到手机点“我已在电脑完成登录”。重新认证使用“重新登录”，不会清除已有数据。状态 `ready` 表示用户确认且 Host 正常关闭准备窗口，不证明站点登录以后永远有效。网站可能要求重新登录。选 saved 但尚未准备好时，Host 会给出设置入口并拒绝 Run，不会静默改用 temporary；Host 正在使用或清理状态未知时也会 fail closed。没有“从手机输入完整登录密码”、多 profile、跨设备同步或清除 profile 功能。

手机与 Relay 不接收 profile 路径、标签、Cookie、CDP 地址、密码或 PID/HWND。Host 设置 API 只返回状态、saved/temporary 偏好、有限命令名，以及准备中的不透明 operationId；运行时也不把这些本机信息发送给 Provider。个人日常浏览器的登录不会自动复制进 Harness。

应用可通过 Web `App` 的 `commonSiteChoices` 注入常用网站选项；默认目录为空且不内置站点。选择一项只会填入“起始网址”，用户仍可编辑并明确提交；不会改写 Goal 或浏览器默认 profile 偏好，也不会附加站点用途或当前页面信息。

“整个桌面”是显式兼容模式：它能观察独立弹窗和跨窗口可见状态，但截图也可能包含其他可见应用内容。自动选择失败时不会静默切入整个桌面。

四种起点和跨应用开关需要新版 Web、Host 和 Relay 同步部署；单独刷新页面不能升级电脑服务。新版目前仅在源码/本机预览中，尚未部署公开手机页面。开始真实任务前以[跨窗口实施记录](./cross-window-implementation-and-validation-2026-10-02.md)的实际验证范围为准。

### 单次 Run 跨应用完成任务（默认关闭）

“跨应用完成任务”是四种起点共用的唯一开关，默认关闭。开启后 Host 将请求映射为 `windowSwitch: "opened-windows-v1"`，模型可以调用 `list_windows` 查看本次授权目录，再从实际 ToolResult 中选 opaque ref 调用 `switch_window`。Host 不代模型预选终点，也不会自动按 Goal 给窗口授权。关闭开关或旧客户端省略 `switchWindows` 时，两个工具不进入该 Run 的 Registry/Context，原单窗口行为保持不变。

窗口清单含受支持的已打开顶层窗口，可能包括非前台/最小化窗口；因此应用名和标题可能含文件名、客户名或其他个人信息，会发送给本 Run 的主 Provider。使用前可关闭不希望披露标题的窗口。Host 集成还可传 Host-only 精确 `windowSwitchAllowedTargets`：省略表示显式 opt-in 后全量枚举；非空列表仅含精确授权候选；空列表表示 deny-all。browser 起点或启用 `managedBrowserCompanion` 时，如果空列表与“必须列出自有 browser target”矛盾，Host 会在创建资源前拒绝；不会静默扩大范围。Host 只会在明确 managed-browser 路径追加本 Run 自有的确切 browser target，不会扩大其他窗口权限。切换过程中也不把 allowlist、PID/HWND、profile 路径或登录资料发给手机/模型。

列出不等于可操作：切换前后 Runtime 重新核对身份、激活、几何和新观察。最小化/后台窗口须经切换时 fresh activation/capture 验证；成功切换立即丢弃旧截图、Grounding 和坐标，重新观察后模型才能继续。切窗本身由用户对该 Run 的 opt-in 覆盖，不逐窗口再弹审批；Guard 对真正高风险操作（例如删除、外发、付款、账户/隐私动作）的原策略仍生效。失败、拒绝或结果未知时，UI/报告不会继续把旧目标标成当前，也不会自动重放。离开 Harness 自有浏览器不会提前关闭 Host/profile；Run 结束才清理。个人浏览器不会因品牌/标题得到 DOM，只有精确 binding 到 Run-owned browser 才启用 DOM。

先按部署指南配置服务器域名、HTTPS 和 Host 出站连接，再生成二维码。电脑确认手机后，手机输入 Goal、选择窗口并运行。手机中的 localhost 指向手机自己，不能直接连接电脑；本机预览二维码不是跨网可用的证明。

任务运行时不要另启 CLI/TUI 同时控制同一桌面。当前 CUA 前台输入会影响焦点，不能承诺用户同时操作其他应用不受干扰。停止请求不是回滚：已经发生的 GUI 修改不会被自动撤销。

### 当前配置差异必须知道

手机 Host 尚未复用 TUI 的完整功能选择页。目前 Host 的装配预设为 Planning 开启、Fact Memory、recent Context、same-control input Batch、Guard `layered`、Monitor `shadow`，并保留 legacy popup/foreground handoff 流程。切窗工具由显式逐 Run 开关控制。模型来自启动配置；这不是用户在 TUI 上次选择的配置。Web 通过 Host 的 sanitized profile status/preference API；CLI/TUI 使用本地配置，不调用手机 Host profile API。

特别是 **Host 当前固定开启 Guard**，因此模型工具合同包含 `_harnessEffect`。它描述当前动作的预期效果，由 Guard 消费，不是发送给 CUA 的输入参数。离线 on/off/on 对照已证明当前活动 Schema 和 GLM 历史回填随开关变化且不污染 Registry；自定义提示词或历史诊断文字中的字符串仍可能保留，不能仅凭字段文字出现判断。

## 4. 架构与模块职责

```text
手机浏览器
  HTTPS 命令 / SSE 事件 / 鉴权截图
        ↓
Relay（服务器） ← WSS 出站连接 ← Host（用户电脑）
                                      ↓
                              ApplicationSession
                                      ↓
                               现有 Runtime
                               ↙          ↘
                         Provider        CUA Adapter
                                         ↓
                                   本机桌面应用
```

| 模块 | 代码位置 | 不承担的职责 |
| --- | --- | --- |
| Web | `apps/web` | 不持有 Provider 密钥，不直接调用 CUA |
| Host | `apps/host` | 不实现第二套模型/动作循环 |
| Relay | `apps/relay` | 不运行模型，不执行 GUI，不允许任意代理路由 |
| Connector | `packages/relay-connector` | 不离线排队或重放 GUI 动作 |
| Run 远程适配 | `packages/app-runtime/src/remote-run-api.ts` | 不绕过 Runtime 的审批、Abort 和预算 |
| Runtime / Computer | `packages/runtime` / `packages/computer-cua` | 不依赖手机页面或 HTTP 协议 |

窗口 token 是短时、设备绑定、单次消费的引用；开始前会重新核验真实窗口。它不是持久 PID 配置。跨窗口交接需要新观察，不能拿旧截图坐标继续操作新窗口。

## 5. 技术与安全边界

- 手机通过配对 session 和同源/CSRF 检查访问指定电脑及所属 Run；其他设备不能任意读写该 Run。
- 桌面管理接口不经 Relay 暴露；截图只能通过授权资产接口读取，不能指定任意本地路径。
- 命令 ID 防重复启动/重复控制，但首版不承诺 Host 重启后的持久 exactly-once。网络结果未知时先查状态，不生成新命令盲目重试。
- 同一物理桌面由跨进程执行锁保护；异常退出后的未知状态需审计恢复，不能直接删锁继续。
- Provider 密钥留在电脑，Relay 不需要 GPU。但 Relay 能读取它中转的授权载荷；当前是 TLS 传输，不是端到端加密。
- Relay 配对/session 映射在内存，重启需要重新配对。公网日志不得记录 token、cookie、Goal、输入文本或截图。

2 核/2 GB 可作为单机、小团队 staging 的起点；不是容量压测承诺。实际负载主要受并发、截图大小和网络影响。部署前需核对服务器系统、域名、证书和网络。

## 6. 怎样理解测试结果

725 项自动化测试与真实 GUI 任务不是同一种证据。测试报告分别标记代码审查、替身集成、真实 Host/API、真实模型/桌面、人工恢复和真手机公网验收。工具 `completed` 只说明驱动接收/执行过程，不保证文字正确或用户目标完成；Runtime `succeeded` 也不能代替人工核验车次排序等业务答案。

原始截图、轨迹与测试文档留在本机 `runs/`，不打包上传。所有失败和复测保留独立 Run，不覆盖成一次“最终成功”。发布前应按问题清单逐项确认，而不是只看测试总数。

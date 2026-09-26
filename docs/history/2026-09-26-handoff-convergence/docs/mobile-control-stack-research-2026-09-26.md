# 手机控制 Harness：技术选型与平台边界

日期：2026-09-26

文档角色：调研 / 计划

状态：候选方案，未实施、未进行手机或桌面联测

当前入口：[文档索引](../../../DOCS-INDEX.md)

基线：Pi 工作树 `b2ab259` 加当前未提交窗口改动，以本次源码阅读为准
范围：手机提交任务、观察结果、纠正、暂停、审批和选窗；不包含手机自身 GUI 自动化或远程桌面视频产品。

## 1. 结论和推荐栈

针对现有 TypeScript/Node 项目，推荐 **React + Vite + TypeScript 的响应式网页/PWA，搭配电脑上 Node + Fastify 控制服务；手机命令使用 HTTPS JSON，事件使用 SSE，截图经鉴权 HTTP 获取**。产品首版必须支持“电脑显示二维码 → 手机扫码 → 电脑确认配对 → 开始使用”，不要求用户安装 VPN、输入 IP、配置端口或证书。为此将托管 HTTPS 入口和电脑主动连接的中继纳入首版范围；Tailscale 仅保留为研发/高级私有部署选项，不作为普通用户前置条件。MCP 留作其他 AI 客户端接入同一服务的适配器。

这是针对当前工程的选择，不是宣称某框架在所有项目中最优。手机页面与通信合同可以通用；电脑的 CUA 输入、权限、窗口管理和登录会话仍受宿主 OS 限制。首个完整验收组合建议为 Android Chrome / iPhone Safari → Windows 电脑，随后分别验收 macOS 和 Linux 桌面后端。

| 层 | 首选 | 选择依据 |
| --- | --- | --- |
| 手机及桌面控制界面 | React + Vite + TypeScript；浏览器先可用，再提供 PWA 安装 | 一份 UI 同时服务手机、平板、电脑；当前无既有 Web 框架负担，表单、截图、状态页无需 SSR。React/Vite 为方案选择，尚未添加依赖。[S1][S2] |
| 电脑控制服务 | Node + Fastify，复用现有 app-runtime | CUA 是本机原生依赖，适合常驻 Node 进程；Fastify 有 TS、请求校验和服务端测试基础。使用与项目及所选 Fastify 版本共同支持的 Node LTS，并在实施时锁定版本。[S3] |
| 命令和事件 | POST JSON + SSE；独立 GET 截图 | 控制命令低频，状态更新主要单向；现有事件序号/补读可复用。双向高频音频或鼠标控制确有需求时再增加 WebSocket/WebRTC。[S4] |
| 网络 | 托管同源 HTTPS 控制台 + 电脑出站连接中继 | 首版产品要求扫码配对，支持不同网络，不把网络配置交给普通用户；中继部署和安全是新增工作，尚未实现。Tailscale 仅为可选研发路径。[S5] |
| 记录与恢复 | 复用 trajectory；补小型持久化命令回执/配对记录 | 不复制 Runtime 日志体系。存储格式先沿用现有文件能力；并发/查询确有需要再引入 SQLite。 |
| 可选原生化 | Capacitor 包装同一 Web UI | 后续需要应用商店、原生推送/音频能力时再评估；iOS/Android 原生工程和平台权限仍要分别维护。[S6] |

## 2. 比较其他方案

- **Hono**：也是可行的 TypeScript API 方案，多 JS runtime 支持适合边缘服务。但本地执行器仍依赖 Node 原生 CUA，当前收益不足以改变首选；Fastify 与 Hono 的差异不会解决 GUI 延迟或窗口问题。[S7]
- **Next.js / 完整全栈 SSR 框架**：当前控制台不依赖 SEO/SSR，额外服务端渲染生命周期暂时没有消费者；Vite 静态产物可由同一个控制服务发布。
- **React Native / Flutter**：适合后续原生体验投入；首轮会增加手机平台构建、发行与 UI 维护，不如先复用 Web UI。Capacitor 同样不是“包装后就保证后台长连接”。
- **MCP**：适合支持 MCP 的 AI 客户端调用 Harness 的任务能力；它定义客户端与工具服务之间的协议，不能自动提供完整的移动控制台。后续 MCP Adapter 应包装相同的应用服务、审批和 Run 所有权，避免另外直连 CUA。[S8]
- **完整远程桌面/WebRTC 视频流**：只有明确要连续画面、手指遥控鼠标时才做。当前每次 Observation 的截图已足够辅助监督；视频传输不能替代窗口/动作正确性。

## 3. 当前源码能复用什么

以下是代码确认，不是远程功能已经完成：

| 现有位置 | 可复用部分 | 必须补齐的边界 |
| --- | --- | --- |
| `packages/app-runtime/src/application-session.ts`，`ApplicationSession` | 创建独立 Run、配置覆盖、暂停/恢复/Abort、用户输入 | 方法面向进程内调用，需外部身份、明确 Run ID 与命令去重；`resolveApproval(boolean)` 会读取当下待审批对象，不能直接作为远程接口。 |
| `packages/runtime/src/run-controller.ts` | 按 requestId 审批、inbox、window handoff/ignore、重新观察 | 远程命令必须在处理时核对对应 Run 和待处理请求；网络重试不等于重放 GUI 动作。 |
| `packages/app-runtime/src/event-feed.ts` | 已提交事件订阅、sequence、resync、慢订阅者通知 | 需网络重连、鉴权、手机可见数据投影；不能把全部原始 Provider/轨迹内容直接广播。 |
| `packages/app-runtime/src/environment-owner.ts` | 当前进程内的环境租约及 pending_cleanup | `Map` 不能阻止另一个 CLI 进程抢桌面。远程模式应统一由一个 Host 进程拥有 Runtime，辅以本机进程锁；TUI 与手机接入同一 Host。 |
| `apps/cli/src/tui.ts` | 现成选窗、Jev 排序、人工交接行为 | 策略与快捷键视图仍混在 TUI；共享选窗/请求解析应提到 app-runtime，TUI 和 Web 只呈现同一决策状态。 |

建议新增 `apps/host`（HTTP/SSE 和本机生命周期）、`apps/web`（响应式控制台）；两端共享小型远程 DTO/schema。仅在两个实际消费者存在后提炼共享包。`runtime` 不依赖 HTTP、React、手机或 Tailscale；`computer-cua` 不负责手机连接。

## 4. 第一版通信与运行规则

产品默认路径为：手机 UI → 托管 HTTPS 网关/中继 → 电脑主动建立的认证连接 → 本机 Host → ApplicationSession/Controller → Provider + Computer。手机侧仍使用 HTTP/SSE；电脑与中继的双向长连接候选为 WSS，需独立定义连接认证、命令回执、背压和重连协议，不能假设 SSE 自动解决穿透。私有部署可直接访问 HTTPS Host。EventFeed 经脱敏投影返回手机；截图按当前 Run 的 asset ID 读取。API key、CUA socket、文件系统路径不作为客户端可随意填写的执行配置。

建议的 API 形状（尚未实现）：

- `POST /api/runs`：创建 Run，携带幂等命令 ID，返回 runId。
- `GET /api/runs/:runId`：状态快照及对应 sequence 水位。
- `GET /api/runs/:runId/events`：SSE，携带/恢复事件游标；重复事件按序号去重，缺口要求 resync。
- `POST /api/runs/:runId/commands`：暂停、恢复、Abort、纠正、审批、窗口确认/忽略；携带 commandId 和相应 pending request ID 或事件序号。处理时拒绝过期命令，不把旧“同意”应用到新审批。
- `GET /api/runs/:runId/assets/:assetId`：鉴权后的截图/产物，不能让客户端提交任意本机路径。

同源页面采用配对后的 HttpOnly/Secure 会话 cookie，配合 Origin/CSRF 校验；配对口令一次性、短期有效。SSE 原生 EventSource 不需要自定义 Authorization 头；连接数控制为每个页面一条。Tailscale 网络访问身份与应用配对是不同层，不能仅因请求自称带身份头就信任它。[S4][S5]

命令回执区分“接收”与“已生效”，例如 pause 不宣称立刻撤销在途操作；Abort 同样不撤销已落地副作用。保存 commandId 与结果，重连先查询再决定补发。服务崩溃后有 started 无终态的动作仍是 outcome_unknown，不承诺 exactly-once，也不自动重复启动旧 Run。

Host 拥有任务生命周期。手机锁屏或短时断网后任务在预算内继续；需要审批/用户输入时停等，断网不自动批准。重新打开页面先同步状态和待处理请求。首版不让 Service Worker 离线排队发送审批、resume 或点击；仅缓存静态 UI，不缓存私密截图/轨迹。移动浏览器可能冻结或丢弃后台页面，不能用长连接存活证明手机仍在线。[S9]

## 5. 是否跨平台

| 部分/组合 | 结论 | 实际限制 |
| --- | --- | --- |
| Android Chrome / iPhone Safari 控制台 | 同一 Web UI 和网络协议可覆盖 | 安装方式、通知、后台生命周期不同；先保证浏览器前台使用和重连。iOS 主屏幕 Web App 的 Web Push 需满足系统和授权条件。[S10][S11] |
| 手机 OS 与电脑 OS 配对 | 没有同系统要求 | iPhone 可连 Windows，Android 可连 macOS；前提是 Host 可达、目标后端在该电脑可用。这是架构可行性，尚无本项目手机实测。 |
| Windows 本机 CUA | 首发验收对象 | UIA/HWND、DPI、前台权限、最小化和独立对话框继续沿用现有能力边界。Host/CUA 桌面执行器应处于登录用户会话；Windows 系统服务位于 Session 0，不能当作普通桌面执行进程。[S12] |
| macOS 本机 CUA | 通信层可复用；执行层需单独验收 | 原生绑定、Accessibility/屏幕权限和窗口激活行为；当前 Windows HWND 文本解析不能被当作 macOS 通用交接合同。 |
| Linux 本机 CUA | 通信层可复用；按 X11/Wayland 分开验收 | AT-SPI、输入/捕获后端及 compositor 的限制不同；CUA 官方按这些维度描述能力，不保证所有组合等价。[S13] |
| OSWorld Bridge | 可复用现有 HTTP Computer 后端 | 远程控制的是评测环境；这不证明任意 Linux/macOS 宿主桌面已支持。 |
| DOM / UIA | 与手机系统无关 | UIA 是 Windows 无障碍体系；macOS/ Linux 对应后端不同。DOM 依赖受管理浏览器/CDP 和现有身份绑定，不能因改成手机入口就读取任意个人浏览器。 |
| HarmonyOS 及其他手机浏览器 | 标准 HTTPS 页面可作候选 | PWA 安装、后台通知及浏览器能力尚未核实；默认路径不依赖 VPN 客户端，不得宣称与 Android/iOS 全等。 |

API 应返回经后端确认的功能能力，让 UI 隐藏不支持的控制；手机不自行根据 `win32/darwin/linux` 推测能力。窗口目标可使用 Host 签发的短期候选 token 绑定系统窗口和清单版本，显示应用名/标题；不要求用户手填 PID，也不把 HWND 数值当跨平台业务 ID。

## 6. 扫码即用：首版产品要求与网络部署

### 6.1 用户实际操作

1. 电脑已安装并打开 Harness，点击“连接手机”，显示二维码和连接状态；普通用户不需要终端参数。
2. 手机用相机或常用扫码入口打开 HTTPS 页面。内置浏览器不兼容时提供“在系统浏览器打开”的明确指引，不要求安装专用 App 或 VPN。
3. 手机发起配对，电脑展示请求及配对校验信息，用户确认一次后授权。扫码本身不直接授予电脑控制权。
4. 手机进入任务页，可输入 Goal、看进展、纠正和审批；可选添加到主屏幕。配对仍有效时再次访问无需重复配置。
5. 电脑端可查看并撤销已配对手机、关闭远程入口。电脑离线、休眠或权限不足时显示具体状态和恢复方法，而非无限转圈。

“扫码即用”指连接复杂性由产品承担，不代表绕过首次授权、操作系统权限或免除电脑开机联网条件。首次模型配置应由电脑端引导完成，不要求在手机再次填写密钥。

### 6.2 工程与隐私要求

首版提供托管入口、设备注册与认证、中继路由及连接健康状态；电脑主动出站连接，不开放个人电脑公网入站端口。中继只传输经过授权的应用命令和可见结果，不成为第二个 Runtime，也不持有 Provider API key。Host 对每条命令仍独立检查配对权限、Run/request ID 和幂等键。

二维码仅承载短期、一次性配对凭据，不含永久控制密钥；需要限流、有效期、消费后失效与本机确认，防止二维码泄露导致接管。敏感配对凭据不得进入访问日志或第三方分析，页面不加载第三方追踪脚本。持久配对凭据必须可撤销；审批仍逐请求确认，不能被“手机已配对”替代。

实施前确定中继信任边界：普通 TLS 中继可能接触截图和任务明文，不能宣传为端到端加密。须明确披露、默认不持久化这些载荷；若要求中继不可读，再选用成熟方案实现并验证端到端加密，不自创密码协议。部署域名、托管成本、服务区域、日志留存及安全方案应单独确认；本次文档更新不授权采购或公网发布服务。

Tailscale Serve 仍可作为研发/高级私有部署路径，但其通过不算“扫码即用”产品验收。[S5] 同网直连、P2P 和自托管入口可后续扩展，不阻塞首版中继闭环。实际网络可达性和延迟须实测；不承诺任意网络永远可达。

## 7. 最小实施顺序与验收

1. **先完成本机真实窗口门槛**：[待执行验收](../../../deferred-live-window-acceptance-2026-09-26.md)。手机控制不会修好尚未闭环的点击、截图与交接。可以并行写控制合同和 mock UI，但不能据此发布可用结论。
2. **提取共享应用控制边界**：请求绑定的审批/选窗、单 Host 所有权、命令去重与脱敏快照；用现有 mock 验证旧审批、重复命令、两客户端争用、慢订阅和未知副作用。
3. **本机 Web 控制台**：提交 Goal、状态/最终回复、最新截图、暂停/Abort/纠正/审批/选窗；与 TUI 复用同一 Host，界面显示操作已接收/生效，支持大字和读屏标签。
4. **扫码配对与真手机验收**：部署受控测试中继，Android/iPhone 无 VPN、无手填地址扫码配对；分别测试同 Wi-Fi 与手机蜂窝网络、锁屏返回、网络切换、重连、重复点击、审批过期、二维码过期/重复消费及撤销配对。电脑离线时须有清楚提示。无实体设备覆盖的系统标为待验收，私网演示或浏览器模拟不能代替该门槛。
5. **回到真实任务**：从手机发起至少两种出行任务及浏览器、记事本、WPS 交接任务，沿用现有结果核对与失败复测规则；记录新增网络/命令生效延迟，不把模型时间算成 SSE 延迟。
6. 证据支持后再增加 PWA 通知、按住说话/语音回复、Capacitor 或 MCP；它们复用同一 Host，不另建第二套 Run 状态。

完成标准：同一版本上手机能提交、看结果、纠正和处理中途选窗；重连无重复 GUI 输入，审批不能串到另一请求，桌面与手机不会各跑独立执行器抢同一桌面；真实任务成功与基础设施失败分开记录。每项失败保留首次和独立复测结果。

## 8. 适老化与无障碍：手机优先、两端共享

本节为产品设计补充，尚未实现或进行用户验证。推荐手机作为主要交互入口、电脑作为任务执行端，但不把“手机天然更无障碍”作为结论：用户习惯、视听与运动能力、辅助设备以及任务复杂度不同，电脑控制界面仍须可用。不要把所有老年用户或残障用户归为同一种需求。

例如，用户在手机说“查明天上海到杭州的高铁，上午出发，不要太早”，电脑执行查询；手机以简洁文字和可选语音呈现进展、结果及待确认事项。用户无需理解目标网站的全部界面，也不必为了审批切回电脑控制台。这是目标体验，不代表当前语音链路已接通。

### 8.1 配置分层与所有权

| 层级 | 示例 | 维护与消费边界 |
| --- | --- | --- |
| 界面偏好 | 字号、对比度、减少动画、语音输入/播报、读屏标签 | Web/TUI 各自实现，优先兼容系统设置；设备相关配置不强制同步。不把字号等 UI 配置注入模型 Context。 |
| 沟通偏好 | 简短解释、一次只问一个问题、关键结果重复确认 | 共享应用层维护，两端采用相同语义；只将实际影响模型回复的偏好交给 Context 策略。 |
| 任务偏好 | 避免夜间出行、优先少换乘、常用出发城市 | 独立、用户可编辑的偏好存储，按任务相关性进入 Context；当前用户明确要求优先，冲突不清楚时询问。 |

长期偏好不是 Run Memory：前者表达用户明确选择的持续偏好，后者维护本次任务的事实及有效性。不得借此提前实现完整长期 Memory 系统；先提供显式设置与有限任务偏好即可。不得根据一次操作推断年龄、障碍情况，或自动永久记住健康、账号、身份等敏感信息。

新增偏好合同须明确生产者（用户设置或用户确认）、消费者（UI、回复策略或 Context）、适用范围、更新和删除规则；只为真实消费者增加字段。进入 Run 的任务偏好应记录所采用的版本/投影，避免事后无法解释决策；不把完整敏感偏好库复制进每轮请求或公共日志。修改当前任务要求仍走已有纠正/inbox 链路，不能静默改变在途动作。

### 8.2 首版体验与安全底线

- 大字、清晰层级、易点击按钮、明确焦点和读屏名称；信息不只依赖颜色、图标或声音表达。
- 文字与语音为互补入口；语音能力未完成时明确标注，不用不可用按钮暗示支持。录音需显式触发，播报可停止，不默认公开朗读敏感内容。
- “暂停”“停止”“补充要求”保持易发现；明确暂停等待在途操作结束、停止不能撤销既成副作用，不能显示虚假的即时成功。
- 审批卡片说明将执行的动作、对象与影响，提供清楚的确认/拒绝；保持 requestId 绑定与过期校验，不因简化模式降低 Guard 或审批标准。
- 重连先显示真实 Run 状态和待处理事项，不重复提交任务；避免用不断滚动的技术日志作为主要反馈，保留按需展开详情。
- 不强制语音，也不强制持续盯着截图；长内容、复杂结果检查与精细操作仍允许在电脑端完成。

### 8.3 接入顺序与验收

将基础可访问性纳入第 7 节第 3 步的 Web 控制台，而非最后另加皮肤；第 4 步增加真手机大字体、读屏、焦点顺序、断线恢复和审批理解测试。共享沟通/任务偏好在应用控制合同稳定后接入；语音沿用第 6 步的独立能力验收，不阻塞文字版控制台。

验收至少覆盖：放大后关键控件不丢失；读屏能提交任务、读出结果并处理审批；语音关闭仍能完成同样流程；两端看到相同任务和审批状态；偏好关闭/删除后不再进入后续 Context；任务事实不会误存为永久偏好。技术检查通过不等于适老化效果已证明，后续还需目标用户试用，观察任务完成、误操作、求助次数与理解困难。

架构保持 **手机优先交互层 → 共享应用控制与偏好 → Runtime → Computer**。UI、语音和偏好投影可替换；Runtime 不依赖特定手机平台或“老年模式”，Computer 不承担用户画像业务。

## 9. 官方资料

- [S1 React 建议与应用形态](https://react.dev/learn/creating-a-react-app)、[S2 Vite 入门及环境要求](https://vite.dev/guide/)。
- [S3 Fastify TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/) 与 [LTS](https://fastify.dev/docs/latest/Reference/LTS/)。
- [S4 MDN：SSE、重连与事件 ID](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)。
- [S5 Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) 与 [平台安装入口](https://tailscale.com/docs/install)。
- [S6 Capacitor](https://capacitorjs.com/docs)、[S7 Hono](https://hono.dev/docs/)。
- [S8 MCP 官方架构](https://modelcontextprotocol.io/docs/learn/architecture)。
- [S9 Chrome 页面生命周期](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)。
- [S10 MDN：PWA 安装](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Installing)、[S11 WebKit：iOS 主屏幕 Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。
- [S12 Microsoft：Windows 交互式服务与用户会话](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)。
- [S13 CUA 官方合同](https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/contracts.mdx) 与 [按平台的操作能力证据](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/action-support.md)。上游 main 文档不能代替本项目已安装 0.22.2 的逐项实测。

本轮仅阅读源码与官方资料，未安装依赖、启动网络服务、修改系统配置、调用付费模型或操作桌面。

# 跨窗口实施与验证记录

日期：2026-10-02。状态：通用跨窗口代码、Host-owned managed-browser companion、Web/TUI/CLI 接线、离线回归及独立代码审查完成；隔离 Preview 已部署并完成边界 smoke checks，详见末节。正式发布和端到端生活任务尚未验收。较早的 11 HTTP Provider 探针之后，又完成一组 20 HTTP raw-context 矩阵：4/6 个合成场景完成，两个 native 往返场景未完成；其中 GLM 按 4 轮上限完成两次切换但来不及 terminate，Qwen 首轮 strict 响应无效。它们是合成 Computer 上的 Provider 协议结果，不是产品或 GUI 失败判定。此前的真实 SDK scripted 桌面往返中，空白页与公开网页 → WPS → 同一 Run 浏览器两轮通过，公开网页 DOM 来源恢复已验证。完整模型驱动生活任务、native↔native、最小化/resize/窗口关闭恢复仍未验收。

## 用户入口、起点与默认值

- 默认 `windowSwitch: "off"`。普通 TUI、CLI、Mobile 和 SDK Run 保持现有单目标行为；关闭时不把 `list_windows` / `switch_window` 注册进 Run ToolRegistry，也不增加相应 Context 动态片段。
- 四种 Run 起点保持不变：auto、window、browser、desktop。起点只决定最初 binding/capture，不是模型后续可选窗口的权限边界；desktop 也支持显式跨应用开关。
- TUI 在 `F` 页面提供一项 `Window switching`；Web 任务页在四种起点下都提供同一个“跨应用完成任务”开关，默认关闭。CLI 可用 `-WindowSwitch` / `--window-switch`。所有入口用户都不需要输入 PID/HWND。
- Web 的唯一公开 Run 字段是 `switchWindows?: boolean`，Host 严格解析并纳入每 Run 幂等指纹，投影为 `windowSwitch: "opened-windows-v1"`。省略或 false 兼容旧单窗口客户端；true 后模型可用同一个 Registry 调用 `list_windows` 和 `switch_window`。
- 用户的一次 opt-in 同时允许该 Run 列出/切换授权范围内窗口；切窗本身不逐窗弹审批。应用名/窗口标题会提供给主 Provider，可能含文档名、客户名或其他个人信息。Guard 对确有风险的删除、外发、付款、账户/隐私等动作仍按既有策略处理。
- 可选的 per-Run `managedBrowserCompanion` 是 Host/CLI/SDK 解析后的单一运行时字段，不是 Web 请求字段。当前 Web UI 已删除任务级 saved/temporary 选择，Host 偏好是当前主路径；为旧客户端兼容，RemoteRun 的 browser target 仍可携带 `sessionMode?: "saved" | "temporary"` 覆盖该次 browser target 的模式。此兼容字段不开放任意 profile path/label/Cookie/CDP。路径、profile 标识、Cookie、CDP 信息不进入手机 Relay 请求，也不投影给 Provider/报告。浏览器为起点与 native/desktop 起点加 companion 使用同一个 `ManagedBrowserComputer` 生命周期。

手机设置中的浏览器流程由配对 Host API 管理：手机发起 prepare/relogin，Host 在电脑屏幕打开可见的 Harness-managed Edge；用户在电脑端手动登录，再从手机确认 complete。只保存一份本机默认 profile，preference 为 `saved` 或 `temporary`。`ready` 只表示用户确认且 Host 正常关闭准备窗口，不保证某站点登录态仍有效。手机不收密码、Cookie、profile 路径/标签、PID/HWND；没有完整手机密码登录、多 profile、云同步或清除 profile 的能力。选 `saved` 但 Host 未 ready 时，Run 返回 `MANAGED_BROWSER_SETUP_REQUIRED`，不会静默回退到临时 profile；Host 正在使用或清理状态未知时也拒绝启动。

Profile API 是配对设备到本机 Host 的窄命令面：`GET /api/managed-browser-profile` 只回 `status`、`defaultSession`、固定 command 名，且仅在 `preparing` 时回 opaque `operationId`；preference 只接受 `saved|temporary`。`POST prepare/relogin` 启动可见登录窗口，`POST complete` 仅接收当前 operationId。写操作要求配对 session、允许的 Origin 与 CSRF；Relay 只转发这组 allowlist 请求。上述 settings API 不返回 profile path/label/Cookie/CDP；这不等于 RemoteRun 不保留旧 browser target 的 `sessionMode` 兼容输入。

```powershell
.\scripts\harness.ps1 start -WindowSwitch
```

`--window-switch` 是能力 opt-in，不是 Goal 语义授权，也不启动原生应用。无 Host 精确范围时，模型看到 Adapter 可报告的所有受支持已打开顶层窗口；目录不要求窗口当前前台，最小化/后台候选仍须在切换时通过 fresh 身份、激活、几何和截图验证。Host-only `windowSwitchAllowedTargets` 省略表示完整受支持目录；`[]` 表示 deny-all；非空列表只允许精确候选。若 browser-initial/companion 路径必须把自有 browser 加入一个显式 scope，`[]` 会在创建资源前作为矛盾配置拒绝；普通 native Run 不会因空目录而扩大范围。仅当使用 Run 自有 managed browser 初始目标，或明确启用 `managedBrowserCompanion`，Host 才会把其确切 HWND 加入非空范围；不会追加其他窗口。范围与 PID/HWND 不发送给 Provider/Context/手机报告。

自动选择或手动窗口仍可建立 native 初始 binding；browser 起点会打开 Harness-managed browser；desktop 保持整桌面 capture 起点。显式切窗后由模型自主查看目录并选择 opaque ref，不是 TUI/Host 替模型预选终点。独立脚本/开发者入口仍须经 Host 授予确切起点与范围。

## 合同与生命周期

- 唯一跨 Provider 的 Registry 工具为只读 `list_windows()` 与 Computer `switch_window({windowRef})`。工具仅在 Run 明确 opt-in 且 Computer 提供 `listWindows` 时注册；OSWorld/external 不支持此能力，开启后在资源启动前失败。
- 列表只含 opaque `windowRef`、可选 `appName/title` 和 `isCurrent`。Provider 不可构造 PID/HWND。清单覆盖 Host 允许的 Adapter 已打开窗口，不局限于当前前台；引用以最近一次有效列表结果为准，刷新、目标转换和 Run 结束会失效。
- 切窗独占一个动作轮次；执行开始即丢弃旧 Observation，必须通过当前 Adapter 精确解析并返回新的 `sessionAfter`，之后重新截图。非 completed 的切换（包含拒绝、失败、取消或结果未知）会使目标标记 unknown 并终止 Run，不复用旧目标、不自动重试。
- Provider 固定 System/Tool 描述不随窗口标题变化。Session、最新 Observation viewport、当前能力/grounding 与最近 inventory 是动态上下文。UI/报告用“starting target”“最近选择目标”或“无法确认”表达来源；不从 opaque ref 推导 PID/HWND。
- Browser 初始目标和 managed-browser companion 共用 wrapper；companion 仅把 Host 自有的准确 browser target 并入目录，不扩大对任意 app 的 Host 范围。离开浏览器窗口不会关闭 Browser Host/profile；Run 结束才清理。Native binding 没有其 browser 的 DOM 来源；切到 Run-owned browser 后 DOM+UIA 仅在精确 binding 匹配时启用，切回 native 立即关闭 DOM，返回 browser 时 fresh 读取新 tab/DOM。
- 切换不产生逐窗口 approval card，因此不要求用旧截图为切窗本身背书。后续真正进入 Guard 的动作预览仍由 Host 匹配实际 `windowRef`/target 标签，不能信任模型声明；只投影有界 app/title，不含 PID/HWND。任何切换非 completed 后，手机、TUI 和报告均不得继续显示先前 binding 为当前目标。

## 离线证据

以下均为独立定向命令，测试范围有交叉，不把数量相加成一个全仓总数；未调用真实桌面/API 的离线 suites 使用项目配置的 Node `v24.19.0`：

- Phase A CUA/app-runtime 目标切换与 companion：实施者定向 161/161 + Node24 build/typecheck 通过；独立审查另有 Runtime 13/13、CUA 原生探针 8/8，后续 Runtime tool/effect projection 11/11 与 Provider effect tests 2/2。均是各自专项命令，不累计为新的总数。
- Runtime 最终目标/trajectory 专项：162/162；Host/profile API + RemoteRun/Relay Phase B：65/65 + typecheck，独立复核 18/18。
- Web 和 CLI Phase C 最终定向 suite 分别 49/49、65/65；Web typecheck 通过。本任务另以 Node24 独立重跑 Web typecheck 和 5 个 focused files（HomeScreen、PreferencesScreen、API、App、voice-input），57/57 通过；这些覆盖有交叉，不与 Phase C 数字相加。
- `scripts/travel/tui-collector.test.mjs`：9/9；SDK managed-browser probe 最终 offline self-test：8/8；H.264/no-audio recorder mock test：10/10。全部是隔离/模拟回归，不代表真实应用生活任务。
- 本轮 `git diff --check` 与文档 UTF-8/stale-copy 扫描作为文档收敛检查，不是额外功能测试。

附加回归覆盖：

- Remote API 使用同一 Registry 的 `list_windows → switch_window`；desktop 与其他三个起点一样，可在 `switchWindows:true` 显式 opt-in 后使用该能力。Host 校验幂等指纹和目标字段；旧客户端关闭/省略状态不泄漏工具名/Schema。高风险动作预览不含 PID/HWND，目标标签来自 Host 数据而不是模型声明。
- 手机在已提交的 `action.execution.started` 事件后立即不再展示旧起始目标；只有 completed receipt 可用时才映射到新选择目标。refused/failed/cancelled 或结果未知会以 unknown 结束 Run。报告将最新 switch start 后的 final target 标为 unknown，且不从 opaque ref 推断身份。
- `ManagedBrowserComputer` 透传 inventory 和受支持的 handoff 方法，使用 `sessionAfter` 不提前 close managed Host，仅在 Run close 时释放。Browser-initial 与 companion 都能将准确 Host-owned target 合入用户明示的非空 allowlist；空 allowlist 对任何 opted-in managed-browser Run 都在资源启动前拒绝。
- Context 使用最新 Observation viewport，不将标题/窗口清单加入稳定 system prefix；Voice 与 Web 对新 action kind 有人类可读标签。
- OSWorld 显式拒绝 `switch_window`，不会把跨窗口 capability 假装成已实现。
- 收尾校验补齐 `switch_window` 的精确参数契约：Runtime validator 与 `toAction` 均拒绝除 `windowRef` 外的键（含 PID、windowId 和任意附加键），不只依赖 Provider JSON Schema。Provider 将合法 `_harnessEffect` 拆成顶层 `declaredEffect` 后再进入该校验，因此不破坏 Guard。实施者重跑 Runtime build 与 `computer-tools.test.ts`（9/9）通过。

## 独立审查

Sol 6.1 集中代码审查关闭了此前 P1/P2：窗口引用与轨迹失效、失败目标标记、程序来源标签/viewport、collector 一致性，以及 managed-browser partial-open/close/bootstrap/profile 清理传播。ManagedBrowserComputer 会尝试关闭所有已创建资源并保留原始/清理错误；cleanup 失败会被 Run 观察并使 owner 保持 pending-cleanup，不会伪报 lease 已释放。空 scope/browser-initial 校验在资源创建前拒绝。代码审查放行不代表生活任务效果或公开部署验收。

审查者独立执行 Runtime 切窗专项 13/13、原生探针自测 8/8、Provider 四组离线场景（各三次 scripted 调用、网络调用 0）和 `git diff --check`。Runtime 175、CUA 148、集成 237、collector 9 以及完整 typecheck 是实施者执行报告，不将它们重复称作审查者独立运行。

最后的精确参数修复再次由同一审查者核实：Runtime 的 Computer tools 与 effect projection 11/11、两 Provider 的 effect 声明用例 2/2 通过（其余 51 项未在该定向命令执行）；Guard 元数据拆分与严格参数校验兼容。没有为这处收尾重复运行全部套件。

## 真实 API 协议验证

### 本次新增矩阵：20 HTTP 请求

2026-10-02 18:57（Asia/Shanghai）使用实际 Registry、默认 Context 和 GLM/Qwen Adapter，运行了本轮唯一一组 live API 矩阵。Computer 与截图是明确标记的合成 fixture，没有打开、查看或控制真实 GUI。矩阵只跑 raw context；每 Provider 三个场景，单切换场景上限 4 次、native 往返场景当时也被配置为 4 次。6 份脱敏逐请求记录位于忽略目录 `runs/diagnostics/cross-window-provider-description-probe/2026-10-02T10-57-36.954Z-a59f53b5-bb3b-4e07-ac4a-a5762854187f/`；目录名使用 UTC。

| Provider / 场景 | HTTP 请求 | Prompt / completion / total tokens | HTTP 累计耗时 | 场景结果 |
| --- | ---: | ---: | ---: | --- |
| GLM / browser_to_wps | 3，均 200 | 8,626 / 3,585 / 12,211 | 74.902 s | 通过：list → switch → terminate |
| GLM / desktop_to_wps | 3，均 200 | 9,003 / 2,676 / 11,679 | 63.514 s | 通过：list → switch → terminate |
| GLM / native_browser_return | 4，均 200 | 13,282 / 1,891 / 15,173 | 51.960 s | 未完成：list → switch → list → switch 已完成，第 5 轮 terminate 被 4 次预算挡住 |
| Qwen / browser_to_wps | 3，均 200 | 6,716 / 286 / 7,002 | 5.075 s | 通过：list → switch → terminate |
| Qwen / desktop_to_wps | 3，均 200 | 6,948 / 383 / 7,331 | 7.131 s | 通过：list → switch → terminate |
| Qwen / native_browser_return | 4，均 200 | 8,725 / 247 / 8,972 | 8.156 s | 未完成：第 1 轮 `QWEN_INVALID_RESPONSE`；随后 list → switch → list，用尽预算 |

总计 20 次真实 Provider HTTP 请求，全部 HTTP 200；4/6 场景完成。GLM、Qwen 的累计耗时分别为 190.376 s、20.362 s，总计 210.738 s。响应 usage 累计为 53,300 prompt、9,068 completion、62,368 total tokens，包含两个未完成场景的已返回响应。它们是小型合成协议任务耗时与 token 数，不代表生活任务延迟或模型综合能力。

两个未完成项是外层探针场景结果，不记作跨窗口产品失败。脚本整体状态为 `failed`，原因是这两个合成场景没有达到完成条件。GLM 的模型按合同执行两次独占切换并返回新观察；原先的四请求预算没有给终止响应留一轮。Qwen 使用 strict JSON 模式时首个 HTTP 200 响应未通过 Adapter 解析（`QWEN_INVALID_RESPONSE`，未产生可执行工具调用）；后续响应走到首次切换后的重新列窗，预算也随即耗尽。20 次请求没有 HTTP 传输错误或超时。

发现预算欠配后，probe 默认上限已调整为 6；native 往返场景用 6 次，两个单切换场景仍各限 4 次。离线 selftest 现在完整覆盖 `list → switch → list → switch → terminate` 五次模型请求，并断言预算至少为 5。此代码修正没有重跑或追加任何真实 API 请求；20 请求矩阵仍如实记录修正前的四轮上限。

### 较早的 11 HTTP 探针记录

较早一组（原始脱敏记录位于 `runs/diagnostics/cross-window-provider-description-probe/2026-10-01T19-45-53.834Z-b8c66189-1e5a-4267-9a68-86d8e6f86f93/`）覆盖 GLM/Qwen 的 raw 与 recent context，总计 11 HTTP 请求且无 HTTP 失败/超时。GLM raw/recent 和 Qwen raw 各以 3 次请求完成；Qwen recent 的两次 HTTP 200 都是 `QWEN_INVALID_RESPONSE`，没有执行工具动作。请求采用 `response_format=json_schema`、`strict:true` 并要求 `{"calls":[...]}` 信封；两次响应分别是裸调用数组、裸调用对象，虽然都指向 `list_windows`，仍不符合信封合同。验证后缩短了 Qwen 紧凑目录说明，但本次 20 请求矩阵使用 raw context，不用它声称 recent context 已复测。旧 artifact 的 usage 数字被过宽脱敏规则隐藏，因此 token 数保持 unknown。该记录与上面的 20 请求矩阵分开统计，不合并计算。

## 本机准备与尚未完成的验收

- Qwen recent 的 strict 输出未通过；新短 description 尚未追加真实 API 复测。定向 Remote API 单测的 fixture Computer 仍不是真实桌面证据。用户明确要求实现闭环后等待新的“现在开始”授权，因此此后未再次调用模型 API 或桌面。
- 安全 WPS fixture 已准备，两轮 SDK/Adapter 往返和资源清理已实测通过；公开网页返回后的 fresh DOM 来源恢复通过，不拿空白页的空 DOM 代替，也不泛化为任意网站或个人浏览器已验收。
- 初次准备时安全 fixture 未就绪：记事本两次启动均报 `accessibility window-opened handler did not become ready`，没有改用已有私人 WPS 文档。用户随后准备新空白 WPS 后解除 SDK 准备阻塞；记事本辅助工具失败属于历史准备问题，不是项目切窗失败。
- 代码通过 `on_screen_only:false` 请求完整顶层清单，但未实测证明本次新链路能枚举/恢复最小化窗口。SDK 测试前由 Sky 激活最小化的空白 fixture，此动作不能算作项目 CUA 的恢复证据。完整 native ↔ native、resize/旧引用失效行为仍未实机验收，不以现有私人文档试输入、保存或关闭。
- 当前代码/模拟测试不能证明实际窗口选择与用户 Goal 相符，也不能证明主 Provider 对真实 app/title 的表现。政务任务批次仍暂停；这些能力不允许宣传成“自动打开/授权任意应用”或“全自动生活任务”。

独立审查已放行受控探针代码；SDK 空白页往返已在安全 fixture 和桌面所有权核验后执行。其他 GUI 场景仍需同样的精确范围和协调者放行。没有通过的链路记为未知/失败，不用整桌面模式替代窗口合同，不以脚本的 help/selftest 代替真实执行。

## SDK 往返探针的执行边界

`scripts/cross-window/sdk-managed-browser-probe.mjs` 复用实际 SDK/Runtime 和 Computer 组装，不通过 raw driver 绕过工具合同。scripted Provider 只从实际 `list_windows` ToolResult 选择引用，走五次决策：列窗 → 切 WPS → 重新列窗 → 切回 Run 自有浏览器 → finish。成功切换后引用失效，不能复用旧列表。它验证生命周期，不消费远程模型 API，也不能代替真实 Provider 对生活任务的理解测试。

live 使用产品跨进程桌面 owner 和实际 physical environment identity；已有进程占用时停止，不删除 lease、不并发抢桌面。只操作本 Run 创建的临时浏览器和用户新准备的空白测试文档，检查 fresh receipt/观察、UIA/DOM 来源及 cleanup diagnostics；关闭调用次数不作为成功证明。不开启 type、click、keypress、save，不关闭用户文档或共享 CUA daemon。

最小 SDK 准备：在 WPS 新建并保存一个空白文档，如 `HarnessProbe-WPS.docx`，保留原有文档；无需记事本。测试者以新清单确认实际 PID/HWND 和 ASCII fixture 标题，不要求用户自行查编号。原生 resize/关闭旧引用探针另需三个独立的 `HarnessProbe-*` 空白测试顶层窗口，不能用三个标签页代替，也不能拿私人文档完成此验收。未经实机执行，不宣称这两个探针通过。

产品 cleanup 路径现将 managed-browser delegate、Host、bootstrap 的关闭错误/关键 cleanup diagnostic 汇总并送达 Controller；独立 fake Host 回归确认报告包含 cleanup diagnostic、生产 owner 保持 `pending_cleanup`，不会假释放。`about:blank` 只验 binding 往返；公开测试 URL 才验证了实际 DOM collection，空白页没有候选不计作 DOM 召回证据。

Sol medium 最后独立复核关闭探针 owner/cleanup/空白页判定发现，独立重跑该探针 8/8 离线测试。复核当时 live 尚未执行，条件放行仅限安全 fixture + 临时浏览器的监督测试；随后实机结果见下一节，最终生活任务 Demo 仍未验收。

## 用户准备后的第一次 SDK 实机结果

用户确认准备后，Sky 最新窗口清单唯一匹配 `HarnessProbe-WPS.docx - WPS Office`。初次精确标题筛选未考虑扩展名/应用后缀，因此漏选；恢复清单查找后确认真实 WPS 身份，再仅激活该测试窗口，观察当前文档为一页、字数 0。未读取其他文档内容。探针标题规则补接受标准 `.docx - WPS Office` 后缀，仍要求完整标题与精确 PID/HWND 相等；作者 8/8、Sol 独立定向 1/1 通过后才放行实机。

真实生产路径 `ApplicationSession → ManagedBrowserComputer → CuaDriverComputer` 使用 ephemeral browser 与 `about:blank`：5 次 scripted 决策（两次列窗、两次独占切窗、结束），2 个 completed 切换、2 次动作后新观察、3 个不同绑定 session。WPS 无 DOM 来源；切回同一 Run 自有浏览器成功。Host 直到 Run cleanup 才关闭，Host/Run 无清理诊断，生产共享桌面 lease 已释放。

主协调者独立读取脱敏 `runs/diagnostics/cross-window-sdk-probe/2026-10-02T02-46-25-563Z-e43cd298/sdk-probe-summary.json`（目录名 UTC）。结果 `passed/succeeded`，模型网络调用为 0，未打印截图或网页内容，未输入/保存/提交/关闭 WPS。`managedReturnDomVerified:false` 是空白页边界，不声称网页 DOM 已恢复；此结果验证实际 SDK/Computer 生命周期，不等于真实模型已完成跨应用生活任务。

## 第二次 SDK 实机结果：公开网页 DOM 恢复

同一已复审探针使用 `https://example.com/` 与同一安全 WPS fixture，未使用个人登录 profile，未放宽断言。结果 `passed/succeeded`；5 次 scripted 决策、2 次列窗、2 个 completed 切换、2 次切换后新观察、3 个不同绑定 session。WPS `nativeBindingHasDomSource:false`，回到同一自有浏览器后 `managedReturnHasDomSource:true`、`managedReturnDomVerified:true`，DOM collections 为 2。Host 在 Run 清理阶段关闭，profile/cleanup diagnostics 与共享 owner 释放检查通过。

证据：`runs/diagnostics/cross-window-sdk-probe/2026-10-02T02-53-13-023Z-8ce875f4/sdk-probe-summary.json`（UTC 目录名）。主协调者独立读取该摘要核对通过项；实施者记录整轮约 19.3 秒，摘要本身没有耗时字段，不能据此拆分各阶段延迟。模型 API 调用为 0；实际使用网络加载公开测试页面，不称其为“零网络测试”。没有网页控件输入、文档输入/保存/关闭、外发或付款，也未输出截图/页面内容。

结论：Windows 的已打开窗口 opt-in SDK 基础链和受管浏览器 DOM 来源隔离/恢复已获得真实证据。尚未验证真实模型驱动的完整跨应用生活任务、native ↔ native、项目 CUA 最小化恢复、resize 后旧坐标/窗口关闭后旧引用拒绝、手机公开页面部署、macOS/Linux 这条新链路。Qwen recent 的 strict 信封失败仍保留，不因本轮 scripted SDK 成功而划掉。下一步先用 GLM 进行受控完整任务；关闭任意用户窗口或交易/发送不属于该基础验收权限。

## 取消的生活任务准备运行

一次 CW01 准备运行因协调者误解用户“离开后继续”的含义而启动；用户说明尚未准备好后立即取消。该记录分类为 `user_cancelled_preparation_misunderstanding`，不计入任务尝试、成功率或 Demo。

- Run：`run-1790924297601-4fe1ccf0-d25`，最终 `cancelled`；ApplicationSession owner 已释放，报告已写入。
- 仅有 `model.request.started=1`，取消导致 `model.request.failed=1`；没有完成的模型响应。
- `tool.call.received=0`，其中 `list_windows=0`、`switch_window=0`；`action.proposed=0`，执行开始/完成/失败均为 0。只有 Computer open 与首次只读观察，没有 UI 输入和文件副作用，目标输出文件不存在。
- 录像 `runs/cross-window-life-task/CW01-2026-10-02T06-58-14-223Z-9f8afc5a/cw01-desktop.mp4` 为 5,459,022 字节，H.264、无音轨；轨迹与 `cw01-attempt-classification.json` 位于同一尝试目录。保留录像是为了审计取消边界，不作为功能演示素材。

用户随后明确调整顺序：先完成任意初始目标、开放窗口目录、可选受管浏览器伴随环境及手机端配置的通用产品链，经过离线、集成和审查门禁；只有用户再次明确“现在开始”后才进行真实模型、桌面和录像任务。

## 2026-10-02 隔离 Preview 部署 smoke checks

跨窗口版本已部署到隔离 Preview release `/opt/computer-harness-preview/releases/2026-10-02-cross-window-v1`，部署包 SHA-256 为 `1411ED3B62BACD8123C913F1D95820396281AFAD9FB0BD5786F05CF273F46126`。stable 仍为 `/opt/computer-harness/releases/a-line-20260928-130957-252edf4`；此前 Preview release 保留，可供版本回退。详细部署与回滚说明见[语音 Preview 部署与手机测试记录](voice-preview-deploy-phone-test-2026-09-29.md)。

部署边界检查结果：Preview Relay active 且只监听 loopback `8788`；对正确 Host `47.108.197.221:8443` 的 health 返回 `200`，公网根页面引用的 `/assets/index-C5cxMpjt.js` 返回 `200`。匿名 `/api/runs` 与 managed-browser profile 查询返回 `401`；恶意 Origin 的 `prepare` 被拒绝为 `403`，正确 Origin 但缺少 session/CSRF 时返回 `401`。一次错误 Host 的 health 返回 `403`，是 Host 校验 fail-closed，正确 Host 检查已通过。本机 Host 的 `/connect` 返回 `200`，固定监听 `4318`；服务器观察到 Nginx 到 Relay `8788` 的 WSS established，并复用了既有 CUA daemon。Node PID 动态变化，不作为文档状态记录。

这组结果只验证隔离 Preview 的部署、连通和拒绝边界，不构成跨窗口生活任务或手机端验收。本次没有启动 Run、profile prepare、浏览器、模型请求或桌面操作；Relay 更新后手机端需重启并重新配对。首次远端尝试因缺少 `unzip` 在 symlink 切换前停止，之后通过 Python 安全校验 ZIP entry 并解压，再原子切换 release。旧 Preview release 留存；本次未执行回滚，也未更改 stable。

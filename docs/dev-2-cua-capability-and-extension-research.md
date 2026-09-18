# DEV-2 CUA 能力、Memory/Monitor 信号与扩展调研

日期：2026-09-17

仓库基线：`bc72ee543197510fce8d3943b0251d2fb51d33bb`

当前锁定依赖：`@trycua/cua-driver@0.22.2`，上游固定提交 `d114f35fec05ecd37bf529e5587be86852205b64`

最新稳定候选：`@trycua/cua-driver@0.28.2`，上游固定提交 `fc188250b4ca8549b8e61f937fdb1fb560770e86`

文档角色：DEV-2/4/5/6 的 CUA 事实边界与合同输入，不是实施完成报告。

## 1. 结论先行

1. **DEV-2 可以先不升级依赖开始做。** 继续锁定 `0.22.2`，先完成 doctor、Harness 自有 `computerSessionRef/generation`、全桌面 profile、`unknown/unsupported` 传播、审批/接管屏障和 Fake 合同。不要因上游有候选 API 就先改 lockfile。
2. **完整的窗口目标合同不能只靠现有 Adapter。** 当前 Adapter 只使用 `get_screen_size`、`get_desktop_state` 和主桌面 foreground 输入；`ObservationId` 只证明 Harness 观察顺序，不证明窗口、焦点、几何或画面身份。窗口 `(pid, window_id)`、bounds、window screenshot、AX snapshot 等必须经过实际 daemon inventory 和受控 fixture 才能发布为已支持能力。
3. **CUA 没有可直接持久化成 Harness `target generation` 的公开字段。** 上游的 session 私有 runtime generation 不序列化；`snapshot_id`/`element_token` 只绑定一次窗口状态快照。Harness Adapter 应自己铸造 opaque target generation，并用“窗口消失、owner PID 不符、session 重连/daemon 重启、重新绑定”驱动失效。
4. **焦点没有统一、持续、跨平台的精确公共信号。** `list_apps.active`、窗口 `z_index`、`is_on_screen/minimized/on_current_space` 是辅助证据，不等同于“此刻键盘焦点必在目标控件”。没有可验证焦点时，敏感 foreground typing 应为 `unknown` 并禁用或交给人工；不能用新截图或动作返回 `completed` 冒充焦点证明。
5. **Monitor 的核心仍由 Harness 自建。** CUA 能供应帧、窗口/AX 状态、动作 `effect/evidence/refusal` 和显式 `verify_state`；但去重、图像特征、循环窗口、stall 状态机、冷却/预算和任务进展判断属于 Harness。像素变化不是成功，像素不变也不必然停滞。
6. **升级候选值得隔离验证，但不应自动切默认。** `0.28.2` 的 portable contract 从 `0.7.0` 升到 `0.8.0`，portable manifest 新增 `list_apps/list_windows/get_window_state`，正好补强 DEV-2 目标合同；它在本轮查询时刚发布，且平台/应用矩阵仍有明确限制。建议独立 profile 验证后再决定升级。

## 2. 证据等级与本轮边界

| 标记 | 含义 | 本文使用方式 |
|---|---|---|
| O | 官方声明 | 固定 tag/commit 的 CUA 文档、manifest、源码；npm `latest` 元数据 |
| S | 源码确认 | Harness 固定基线或 CUA 固定提交的类型/实现/测试 |
| H | 历史作者证据 | 仓库既有审计、probe 源码和报告；不改写为本轮复测 |
| T | 本轮实测 | 本轮没有真实 daemon、桌面、截图、输入、模型 API 或 VM 实测 |

本轮只读了仓库固定基线、已安装 `0.22.2` 声明、CUA 官方固定 tag/commit、npm 官方元数据。没有读取 `.env`、用户图片或 ignored `runs/`，没有安装/升级依赖，也没有运行 probe。

版本事实：仓库 `package.json` 与 lockfile都精确锁定 `0.22.2`，六个 macOS/Windows/Linux native optional package 也同版。[本地 package](../packages/computer-cua/package.json)；[0.22.2 manifest](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/contract/manifest.json)。2026-09-17 查询 npm `latest=0.28.2`；官方 tag 指向 `fc188250...`。[npm](https://www.npmjs.com/package/@trycua/cua-driver)；[0.28.2 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.2)。

## 3. 当前 Harness 实际能力，不把候选当实现

固定基线的 [CuaDriverComputer](../packages/computer-cua/src/cua-driver-computer.ts) 实际行为：

- `open`：连接显式 daemon socket，`startSession`，再调用 `get_screen_size`；将截图/指针/键盘硬编码为 true、accessibility 为 false。
- `observe`：调用 `get_desktop_state` 写 PNG，再读入内存；只校验 PNG/structured 尺寸与打开时 viewport 一致。
- `execute`：所有非 wait 动作固定到 `{kind:"desktop", display_id:"primary"}` 和 `delivery_mode:"foreground"`。
- 引用：私有表只有 `ObservationId -> ComputerSessionId`，另有 `latestObservationId`；没有窗口 identity、focus evidence、geometry revision、CUA snapshot/token。
- 错误：明确 Tool error 映射为 refused；Transport/Abort/未知错误不制造终态，由 Runtime 保留 unknown outcome；不自动重试 GUI 副作用。
- close：为 `endSession/shutdown` 设置总 deadline；清理未确认时保留 owner 并阻止同实例重新 open。这是重要的执行所有权基础，但不是跨进程恢复。

现有测试是 Fake Driver 合同测试，覆盖 mapping、stale observation、本地 explicit refusal、transport 后 session 失效、close hang 和 pending cleanup；它不证明真实窗口、DPI、焦点或跨平台支持。[测试](../packages/computer-cua/src/cua-driver-computer.test.ts)。

已有 spike 分层合理：capability probe 读取 `metadata/listToolsJson/session/health_report/check_permissions`；action/adapter/runtime probes 使用隔离 WinForms fixture，并将 driver 接受与 fixture-owned state change 分开；runtime probe 还设计了 20 轮观察绑定和 daemon 断连 `outcome_unknown`。但固定基线没有提交对应本机原始结果，故本文只将其视为**可复用实验入口和历史作者设计证据**，不声称本轮通过。[probe 入口](../spikes/cua-driver/README.md)。

OSWorld 当前只提供 Harness 新 session id、desktop PNG、physical viewport、动作后捕获和 viewport 尺寸更新；capabilities 中 accessibility 固定 false。它没有窗口、focus、target generation 或 geometry revision 生产者。[OsworldComputer](../packages/computer-osworld/src/osworld-computer.ts)。

## 4. `0.22.2` 与 `0.28.2` 的确切差异

### 4.1 Portable contract

| 项目 | 锁定 `0.22.2` / `d114f35f` | 候选 `0.28.2` / `fc188250` | Harness 含义 |
|---|---|---|---|
| portable contract | `0.7.0` | `0.8.0` | 是合同升级，不能按 patch upgrade 处理 |
| portable tools | 25 | 28 | 新增 `list_apps/list_windows/get_window_state` |
| desktop capture | `get_desktop_state`，三平台 | 同 | 现有全桌面基线无需为此升级 |
| target action | `click` schema 已有 tagged window/desktop target，但 portable click 仍要求 x/y | 新合同继续强化 target/element 二选一 | 有参数不等于当前 Adapter 已建立 target binding |
| deterministic verifier | `verify_state` 已存在 | 继续存在 | DEV-5 可先设计消费者，不必等升级 |
| session | `get_session/list_sessions` 已存在 | 私有 runtime generation 仍不公开 | 只能读 lifecycle；Harness 自己 mint generation |
| clipboard | read/write 已存在 | 继续存在 | 不应因“已有”就默认接入 |

`0.22.2` 的 SDK 声明和 platform-extensible inventory 可能比 portable manifest 丰富；仓库历史 probes 也会尝试 `list_windows/health_report/check_permissions`。这里的差异是“portable manifest 尚未纳入窗口三件套”，不是“`0.22.2` SDK 一定不存在窗口能力”。因此 DEV-2 doctor 必须读取**实际 daemon** inventory，结果标为 declared/verified/unsupported/unknown，不能仅由 portable manifest 或 SDK 包版本推断运行 daemon 一定具备。[0.22.2 manifest](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/contract/manifest.json)。

`0.28.2` 固定源码把窗口结果定义为：`window_id`、nullable `pid`、`app_name/title`、bounds、`is_on_screen`、nullable `z_index`，以及可选 layer/minimized/space metadata；window state 包含可选 `snapshot_id`、elements、完整性/degraded/truncated 标志、截图尺寸/scale/frame validity 和 window bounds。[固定源码](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/libs/cua-driver/rust/crates/cua-driver-contract/src/windows.rs)。

### 4.2 平台边界

| 平台 | 官方 `0.28.2` 声明 | 对合同的保守解释 |
|---|---|---|
| Windows | Win32/UIA/native input/targeted messages；Electron、Tauri、WPF、WinUI3、WebView2 有 canonical coverage；部分 Chromium background gesture 和 elevated-integrity 边界仍不可用或未证实 | 每个 action/app/delivery cell 独立验证；`background_uipi_blocked` 等 refusal 是正常结果 |
| macOS | AppKit/AX/Quartz/HID/ScreenCaptureKit；需要 Accessibility 与 Screen Recording；部分 background scroll/drag refusal | permission 是独立前置；窗口可见不等于 TCC 已就绪 |
| Linux X11 | window discovery/capture、AT-SPI、foreground input 和部分 semantic background；toolkit 可拒绝 raw background | X11 接受事件不证明应用消费；必须 fixture state 验证 |
| Linux Wayland | compositor-specific；Sway 有受限支持，GNOME 需要 helper，KDE/其他 compositor 范围不同 | 不发布笼统 `linux=true`；profile 至少细分 X11/Sway/GNOME/KDE/other |

官方平台矩阵明确以真实应用结果而非“调用成功”定义支持。[Platform support](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/docs/content/docs/reference/cua-driver/platform-support.mdx)；[action support](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/libs/cua-driver/docs/action-support.md)。

### 4.3 daemon、取消与清理

- public session label 是人类可读标签，不是 caller identity、权限证据或独立桌面。
- 同一 daemon 的 session 仍共享屏幕、键盘、鼠标、AX tree 和 OS focus；上游只在单进程内串行承认 primitive input，更高层序列仍可交错，必须由 Harness owner 调度。
- daemon/transport 拥有私有 lifecycle identity；同进程 direct runtime 还有不序列化的私有 generation。这个 generation 不能写进 Harness Memory。
- transport EOF、显式 end、idle expiry走 cleanup；daemon 消失时客户端 fail closed。AbortSignal/取消请求不证明已经 dispatch 的 OS 输入没有发生。
- 当前 Adapter 的未知副作用停止与 cleanup owner 保留应继续高于 Monitor/replan；不得因重连创建新 session 就清掉旧 pending action。

来源：[Process model](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/docs/content/docs/reference/cua-driver/process-model.mdx)；[SDK reference](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/docs/content/docs/reference/cua-driver/sdk-reference.mdx)。

## 5. Memory scope：能力到稳定信号的合同矩阵

### 5.1 推荐字段、生产者、消费者与生命周期

下表名称是 Harness 待实现合同，不冒充现有类型。

| 信号/字段 | Producer | Consumer | 生命周期/可确定失效 | `0.22.2` 可用性 | `0.28.2` 可用性 |
|---|---|---|---|---|---|
| `runRef` | Runtime `runId` | run scope、事件/Memory | Run 创建到终态；确定结束 | 已有 Harness | 同 |
| `computerSessionRef` | Adapter 在成功 `open` 后 mint opaque ref；可在内部封装必要的实例代际 | owner、Memory computer_session scope、审批 | open→已确认 close；断连/cleanup unknown 时 Memory 标 `needs_check`，Runtime/owner 保持 blocked，不是假定结束 | 可实现；CUA label只作诊断 | 同 |
| `computerSessionGeneration` | Adapter/Harness，不从 public label推导 | stale approval、Memory dependency、recovery | 每次新连接/open/重连增代；daemon restart 后必新代 | 可实现 | 可实现；上游私有 generation 仍不可读取 |
| `sessionLifecycle` | CUA `get_session` / Adapter | doctor、owner、恢复 | `active/ending/absent`；只证明 CUA lifecycle | portable 有 | portable 有 |
| `targetRef` | Adapter 将已发现 `(pid, window_id)` 封装为 opaque ref | observe/execute、target scope、Guard/UI | Run/session local；不直接暴露 PID 给模型 | 仅当实际 daemon inventory+fixture 验证；否则 unsupported | portable 合同支持 discovery/state |
| `targetGeneration` | Adapter 绑定器 | target scope、candidate/approval | 首次绑定 mint；确认销毁/重建、session 换代或明确撤销绑定后旧代失效。仅切换当前选中/焦点目标不增代，也不销毁旧 target | Harness 自建的合同代际，不是 OS generation | Harness 自建；CUA没有同名字段 |
| `targetAlive` | `list_windows/get_window_state` 或明确 refusal | Memory reconciliation、preflight | 本次读取见到 exact window 为 true；`window_id_not_found`/owner mismatch 只确定该次检查失败；读取失败为 unknown | capability-gated | portable candidate |
| `geometryRevision` | Adapter 对 canonical bounds + capture space + scale + dimensions 归一化后 hash/sequence | 坐标动作、审批、定位 Memory | 任一几何/scale/space变化即增代；只使几何依赖失效 | desktop viewport 可做粗粒度；window需探测 | window state 有原料，revision仍由 Harness生成 |
| `focusEvidence` | 独立 OS/driver readback（若该 platform profile有） | sensitive input preflight | 单次短生命周期；目标/foreground变化即过期 | 没有统一已接信号 | 仍无统一 portable exact-focus字段 |
| `windowVisibilityEvidence` | `is_on_screen/minimized/on_current_space/z_index` | UI提示、preflight辅助 | 每次 discovery 快照；不可替代 focus | capability-gated | portable字段，但部分 nullable |
| `snapshotRef` | CUA `get_window_state.snapshot_id`，Adapter私有映射 | element action/AX Monitor | 下一次同目标 snapshot 取代；frame-bound | 不是 portable 保证 | portable window state候选 |
| `elementRef` | Adapter 映射 `element_token`，不把 raw token 持久化为通用协议 | element action、局部验证 | snapshot-bound；新 snapshot、target/session generation变化后失效 | typed SDK有相关类型但需实际工具探测 | 官方合同明确 stale refusal |
| `observationId` | Runtime | action decision lineage、事件审计 | 每次 observe 新建 | 已有 | 已有；**不得**用于上述任何 generation |

`(pid, window_id)` 仍只是一次观测可验证的系统句柄组合，不是永久 identity。系统可能复用两者；轮询也可能漏掉“窗口销毁后用相同组合重建”的间隙。因此 Adapter 只能保证自身 binding/撤销/rebind 的合同代际，不能宣称发现了可靠的 OS generation。若缺少可证明的销毁/重建证据，就保留 identity continuity 为 unknown，并在敏感 preflight 重新核验，而不是凭句柄相同自动恢复 Memory 或审批。

### 5.2 scope 的准确含义

| Memory scope | 允许绑定 | 失效/降级规则 | 不能声称什么 |
|---|---|---|---|
| `run` | `runRef` | Run终态后不跨 Run 自动导入 | 不证明登录、页面、焦点等动态事实仍真 |
| `computer_session` | 一个由 Adapter 绑定的 opaque computer-session dependency；仅在消费者确需分别比较时再拆 ref/generation | session 已确认结束/换代 → `needs_check`；cleanup/断连未知也只将 Memory 标 `needs_check`，Runtime/owner 另行阻塞执行 | public CUA label不是授权或 identity；同label重开不是同代 |
| `target` | 上述 session dependency + opaque target dependency；内部可含 target ref/generation | 已证实销毁/重建、session换代或明确撤销绑定 → `needs_check`；geometry change只失效带 geometry dependency 的事实。仅切换当前目标/焦点时旧事实保留，非当前目标只是不进入 Hot Memory | `(pid, window_id)` 不是永久业务对象或可靠 OS generation；snapshot/token也不是 target generation |

确定性失效只作用于声明了相应 dependency 的事实。例如窗口重建可以确定使 element token、坐标和“当前输入框 enabled”失效；不能据此删除“用户想编辑报告”或“曾打开设置”的历史事实。

下列只能由主模型或独立业务 verifier 结合新证据判断，Runtime/CUA 不应自动确认：是否登录、上传/保存/发送成功、页面文案是否表达错误、业务对象是否相同、像素变化是否代表任务推进、用户意图是否已经完成。`effect:"confirmed"` 也只表示 driver 读回了局部作用，不是业务目标成功。

### 5.3 focus、geometry 与审批/人工接管

- `list_apps.active` 只到 app 层；窗口 `z_index` 可能为 null，且 topmost 不等于 focused control。两者只能构成辅助 evidence。
- foreground action 的 `delivery.mode` 表示此次路由，不能证明下一动作前焦点仍在；用户、弹窗和应用都可改变 focus。
- background element action可降低对 OS focus 的依赖，但仅限上游为该 app/action/platform 支持的 cell；structured refusal 后由 Host 决定是否允许 foreground，不能自动升级。
- TUI 请求接管后先停止新调度，再等待已派发动作 settled/unknown；只有 quiescent 才交出桌面。恢复时新观察并重新核验 target/session/geometry/focus，旧批次不续跑。
- 审批至少绑定 decision/instruction epoch、session generation、target generation、geometry revision 和 action digest。新的 screenshot/ObservationId 不能单独刷新审批。

### 5.4 OSWorld 的诚实降级

| 信号 | OSWorld 当前结果 | Memory/Runtime 行为 |
|---|---|---|
| run | supported | 正常 run scope |
| computer session | Harness-local supported | 可用 `open` 产生的新 UUID 和 close 生命周期；不是 VM/桌面全局 identity |
| target/window | unsupported | 不允许模型提交 target scope；不静默改成 run scope |
| target generation | unsupported | 字段缺失为 `unsupported`，不是常量 0 |
| geometry | desktop viewport only | 尺寸改变可产生 desktop geometry revision；没有窗口 geometry |
| focus | unknown/unsupported | foreground typing的敏感场景不得以截图或 action completed 放行 |
| AX/snapshot/element | unsupported | 不注册对应工具，不伪造空树为“无元素” |

这样仍能在 OSWorld 保留 desktop pixel profile：Memory target scope不可用，但 run/computer_session scope和 Monitor的动作/截图候选可以工作。

## 6. Monitor：CUA 提供什么，Harness 必须自建什么

### 6.1 可消费的上游信号

| 信号 | 确切 API/字段 | 价值 | 成本/误报边界 | 是否额外模型调用 |
|---|---|---|---|---|
| post-action frame | 现有 `get_desktop_state`；候选 `get_window_state` screenshot | 视觉重复/变化特征、人工查看 | capture+PNG I/O；动态光标/动画/时钟会造成变化 | 否 |
| target/geometry | `list_windows`、window bounds、screenshot dimensions/scale/frame validity | 只在同 target+geometry 内比较；检测 window move/close | discovery轮询；nullable字段 | 否 |
| AX state | `get_window_state.elements`：role/label/value/enabled/selected/actions/frame，加 complete/degraded/truncated | 元素存在、值或 enabled 变化；结构签名 | AX walk官方说明可到 20s；虚拟列表、Electron echo、degraded/截断会误导 | 否 |
| frame-bound identity | `snapshot_id/element_token` | 拒绝旧 element reference | 新 snapshot 必然使 token stale，但这不代表页面业务变化 | 否 |
| action effect | action structured output `effect/route/delivery/evidence/escalation/refusal` | 强负信号：refused/suspected_noop；局部 readback | 当前 Adapter丢弃大部分 structured data；`confirmed`不是任务成功 | 否 |
| bounded predicate | `verify_state`：1–8 window/element predicates，`satisfied/unsatisfied/unknown`，stable samples与≤10s wait | 对明确预期做本地回访，如窗口仍存在、已知字段值 | 需要先有具体 predicate；absence常为 unknown；轮询有延迟 | 否 |
| lifecycle | `get_session/list_sessions` | daemon/session健康、ending/idle | 不是进展信号 | 否 |
| driver activity callback | direct SDK configured ActivityObserver | content-free action/refusal/session telemetry候选 | 当前 Adapter是 daemon `connect`，不能假定可收到该 callback；另接宿主才有 | 否 |

`verify_state` 在锁定 `0.22.2` portable manifest 已存在，并明确规定 unknown 不等于成功；element absence 在搜索域不完整时仍为 unknown。[0.22.2 manifest](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/contract/manifest.json)。

### 6.2 Harness 自建的最小 Monitor

1. **事件窗口与去重**：以 Runtime committed sequence 为主时钟，维护有界 action/receipt/error/observation/plan/memory 摘要；driver事件只作补充，不能建立第二个调度器。
2. **动作签名**：规范化 kind、target generation、geometry revision、离散化坐标/elementRef和关键参数。连续相似动作、A-B-A、重复 refusal 是候选，不直接定罪。
3. **本地图像特征**：对已持久化帧生成有界 thumbnail + pHash/dHash 或 SSIM类特征；只比较相同 target generation、coordinate space和geometry revision。特征本身不出工作目录，不增加 Provider 图像。
4. **AX/状态特征**：只在 capability可用且预算允许时，提取结构摘要；保留 complete/degraded/truncated，使“没找到”不会被误读为“不存在”。
5. **候选融合**：动作重复 + 画面近似不变 + explicit suspected_noop/refusal + plan/memory无实质变化，提高 stall 置信；缺任一信号只降低置信，不补造 false。
6. **有界干预**：shadow先记录；之后把候选证据摘要加入下一次正常主模型请求，默认不额外调用模型。cooldown、最大 guidance 次数、总预算和 unknown-outcome 硬屏障由 Runtime执行。

### 6.3 成本、误报与成功口径

| 方法 | 主要成本 | 常见误报/漏报 | 推荐用途 |
|---|---|---|---|
| exact image hash | 低 | 动画/光标导致“不同”；同画面下后台状态已变化 | 仅去重完全重复资产 |
| perceptual thumbnail | 低到中 | 小提示/文字变化漏掉；动画仍干扰 | stall候选特征，不作成功判定 |
| full-resolution SSIM/局部 diff | 中到高CPU/内存 | resize/DPI/遮挡破坏可比性 | 仅受控同geometry窗口，采样而非每帧全量 |
| AX structural/value diff | AX walk可很慢 | incomplete/degraded/虚拟化、web echo | 明确控件状态和值变化候选 |
| `verify_state` polling | 最长10s、重复AX读取 | predicate设计错误；absence unknown | 关键动作的少量显式 postcondition |
| 额外 VLM judge | 延迟、费用、数据外发、同模型偏差 | 可能把视觉变化误判为业务成功 | 非默认；只作为独立实验 profile |
| 下一轮主模型解释证据 | 不增加请求次数，只增加少量tokens | guidance是软建议 | DEV-5 默认干预路线 |

必须固定三条否定规则：

- 像素有变化 ≠ 任务成功；可能只是光标、动画、通知、滚动或焦点边框。
- 像素无变化 ≠ 没进展；后台保存、剪贴板、网络请求或不可见状态可能已变化。
- CUA `effect:"confirmed"` ≠ 业务成功；它至多确认局部 driver effect/readback。

Monitor 输出应是 `candidate + evidence + missingSignals + confidenceBand`，而不是伪造的 `progress=true/false`。真正任务进展通常仍由下一轮主模型利用当前观察判断；有 evaluator 时 evaluator结果仍与 Runtime outcome分开。

## 7. 基础之外的扩展优先级

只列固定官方文档/源码确实存在、且与当前路线有明确消费者的能力。

| 优先级 | 能力 | 价值 | 风险/评测污染 | 平台成熟度 | 建议阶段 |
|---|---|---|---|---|---|
| P0 | metadata、tool inventory、health、permission、session state | doctor、版本/daemon不匹配、fail closed | 低；报告需去路径/标题 | 三平台，但权限字段平台不同 | DEV-2 必须 |
| P0 | window discovery + window capture-only | target binding、隐私更小、geometry、Monitor可比性 | 标题/窗口清单是隐私；capture space与DPI错误会误点 | `0.28.2` portable；平台仍需fixture | DEV-2 必须候选 |
| P1 | bounded AX tree + element token | editable/enabled/value、精确 element action、stale refusal | 文本隐私、context膨胀、AX不完整、延迟 | 三平台有合同，app/toolkit差异大 | DEV-2窄用；DEV-5扩展 |
| P1 | `verify_state` | 无模型的显式 postcondition和稳定采样 | 只支持有限predicate；unknown常见 | `0.22.2`已portable | DEV-5 |
| P1 | background window/AX delivery | 不抢TUI焦点，改善接管体验 | app/action cell差异；不能silent foreground fallback | Windows/macOS/X11较成熟，Wayland分 compositor | DEV-2实验、DEV-6放行 |
| P1 | capability manifest / permission mode | 将底层工具和resource scope收窄 | 配置错误可拒绝全部；standard不是逐动作审批 | runtime层三平台；Host仍需自己的Risk/approval | DEV-6 |
| P2 | clipboard types/read/write | 粘贴体验、某些文件/图像工作流 | 高隐私、会修改用户全局clipboard、评测泄漏；文本不得默认记录 | 官方三平台 API | 以后，默认off，专用profile |
| P2 | typed browser binding/state/actions | 精确tab/ref、后台DOM、局部截图 | 改变OSWorld/纯GUI信息条件；existing profile授权敏感；Firefox/Safari无typed mutation | 主要 Chromium/Edge/Electron，平台/宿主限制明确 | DEV-8以后独立实验 |
| P3 | recording/history | 调试、轨迹回放 | 重复已有资产；磁盘/隐私/留存和评测观察效应 | 官方存在但非核心依赖 | 以后，仅诊断profile |
| P3 | Fleet/remote carrier | 远程隔离执行 | 外部服务、身份/网络/取消/成本边界显著扩张 | 独立产品能力 | 以后，不阻塞REL-2 |

Browser 只在 exact binding 时允许 typed mutation，Safari/Firefox 仍走 native fallback；新 snapshot/navigation 会使 page refs 失效。[Known limits](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/docs/content/docs/reference/cua-driver/limits.mdx)。Clipboard 官方明确标成 privacy-sensitive，不能因为“不写上游 telemetry”就允许 Harness 日志保存内容。[MCP tools](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/docs/content/docs/reference/cua-driver/mcp-tools.mdx)。

## 8. 推荐合同：能力 → API → 适配 → 缺口 → 实验

| Harness能力 | 上游确切API/版本 | 平台 | 已有适配/实验 | 当前缺口 | 受控实验 |
|---|---|---|---|---|---|
| doctor | `metadata/listToolsJson/get_session/health_report/check_permissions`；部分是 platform-extensible | 三平台 | capability probe源代码 | 未产品化、未冻结脱敏 schema、未核实运行daemon版本 | 只读，无截图；版本错配/权限/degraded fixtures |
| desktop observe/input | `get_desktop_state` + action tools，`0.22.2` portable | 三平台 | production Adapter + Fake tests；历史fixture probes | DPI/多屏/focus无本轮实证 | 100/125/150/200%四角与click；仅primary |
| window target | `list_windows/get_window_state`，`0.28.2` portable | 三平台有声明 | 历史 probes曾按generic tool设计 | `0.22.2` portable缺合同；Adapter无targetRef/generation | 每平台/WM专用fixture，move/resize/recreate/PID reuse |
| window pixel | target `{pid,window_id}` + window-local x/y | 三平台，delivery cell不同 | 未接 | 坐标转换、frame validity、DPI、旧几何拒绝 | 标题栏/边框/遮挡/弹窗/多DPI |
| element action | snapshot/token + element action | 三平台，toolkit差异 | 未接 | bounded投影、Provider tool合同、stale处理 | 同名控件、重排、new snapshot、window restart |
| focus guard | app/window discovery + platform-specific readback/refusal | 无统一portable exact field | 现有 production只用foreground | 独立focus evidence缺失 | TUI切换、弹窗夺焦、disabled field、输入泄漏oracle |
| Monitor local | frames + action effect + optional AX/verify | 三平台按capability | 只有离线轨迹基础 | 特征/阈值/窗口/状态机都未实现 | normal slow、no-op、A-B-A、动画页面、hidden progress |
| recovery | session lifecycle + Harness event/pending owner | 三平台 | unknown outcome和close retention已有 | 跨进程owner/持久pending/重连generation | dispatch前后kill、daemon restart、旧审批 |

## 9. 分阶段建议

### DEV-2 必须

- 保持 `0.22.2` lock；实现只读 doctor，区分 SDK metadata、实际 daemon metadata/inventory、declared与fixture-verified。
- 只为当前消费者且已有可证 producer 的信号冻结最小合同；例如现阶段需要的 opaque session dependency、可验证 geometry evidence、focus三态和 capability四态。未来 target generation 等候选可先保留设计，不为抽象完整度提前落字段，也不把 `runId + sessionRef + generation` 无必要地重复存储；没有 producer 时为 unknown/unsupported。
- 全桌面 profile继续可用，但敏感输入在无独立focus信号时限制；ObservationId只作decision lineage。
- window profile在实际 inventory和fixture通过后逐项启用；Adapter封装 PID/window ID，不直接给模型raw selector。
- target/session/geometry与审批、micro-batch每primitive preflight、接管quiesce共享同一事实源。
- OSWorld明确desktop-only降级，不阻塞公共合同，但不注册target/AX工具。

### DEV-4

- Memory scope只接受 Runtime/Adapter绑定后的 refs；模型不能提交raw session label/PID/window ID/token。
- 已证实的 dependency invalidation 写可重放 mutation；观测缺口或 identity continuity unknown 只把 Memory 标 `needs_check`，不新增 `blocked` Memory 状态，也不自动恢复 active。执行阻塞属于 Runtime/owner。
- 当前选中/焦点目标切换不使旧 target scope 全量失效；旧 target 事实保留，非当前目标只是不进入 Hot Memory。只有已证实销毁/重建、session换代或明确撤销绑定才按 dependency 失效处理。
- element/坐标事实绑定snapshot/geometry dependency；业务语义事实仍交模型重观察修订。

### DEV-5

- 先做无额外模型调用的 shadow：Runtime事件 + 本地图像特征 + 可选AX/verify + action effect。
- 明确采样预算、相同target/geometry比较规则、degraded/缺图降级、开发/验证集冻结。
- guidance塞入下一轮正常主模型请求；VLM judge作为独立非默认实验，不混入基线。

### DEV-6

- capability manifest/permission profile与Harness Risk Guard分层；Host deny和unknown不可被driver `confirmed`或普通approve覆盖。
- 持久化pending environment owner；新进程重连必须新session/target generation，旧审批作废。
- background、browser、clipboard等按独立profile和风险/隐私合同放行，不扩成raw `callTool`。

### 以后

- typed browser、clipboard、recording/history、Fleet/remote分别建立实验配置与评测标签；不能与OSWorld desktop-pixel基线混报。

## 10. 升级决策与验收门槛

**当前决策：能先不升级；建议并行验证 `0.28.2`，通过后再单独切默认。**

不升级即可完成：doctor框架、现有desktop profile、Harness session generation/owner、unknown传播、OSWorld降级、Fake target合同、Monitor本地算法骨架、Memory scope的run/computer_session部分。

不升级时不能预先承诺：portable window discovery/capture、跨平台 target identity、element token/UIA路径。若实际 `0.22.2` daemon inventory提供平台扩展，也只能在探针验证的精确平台/profile标记 supported。

`0.28.2` 升级门槛：

1. 独立环境固定 SDK、native package、daemon和校验来源；先比对 metadata/contract/tool schema。
2. 原有 desktop截图和全部现有动作零回归；Transport/Tool/Abort/cleanup错误分类不漂移。
3. Windows受控fixture通过窗口发现、move/resize/recreate、DPI、焦点抢占、element stale、background refusal；macOS/Linux分别记真实验证范围，不能继承Windows结论。
4. Adapter只发布验证过的 fields；nullable/缺失/degraded映射unknown，不设乐观默认。
5. 评测冻结 SDK/daemon/profile；升级前后结果分组，不覆盖既有OSWorld数据。

## 11. 官方与仓库依据

- Harness：[路线 DEV-2/4/5/6](./full-development-roadmap-v2.md)、[重构施工表](./module-refactoring-work-plan.md)、[现有 CUA Adapter](../packages/computer-cua/src/cua-driver-computer.ts)、[OSWorld Adapter](../packages/computer-osworld/src/osworld-computer.ts)、[历史 CUA 审计](./history/2026-09-17-roadmap-consolidation/audit-2026-09-16-cua-capabilities-upgrade.md)。
- CUA `0.22.2`：[manifest](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/contract/manifest.json)、[SDK README](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/typescript/README.md)、[动作实证矩阵](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/docs/action-support.md)。
- CUA `0.28.2`：[manifest](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/libs/cua-driver/contract/manifest.json)、[窗口合同源码](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/libs/cua-driver/rust/crates/cua-driver-contract/src/windows.rs)、[接口合同](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/docs/content/docs/reference/cua-driver/contracts.mdx)、[平台支持](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/docs/content/docs/reference/cua-driver/platform-support.mdx)、[进程模型](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/docs/content/docs/reference/cua-driver/process-model.mdx)、[权限模式](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/docs/content/docs/reference/cua-driver/permission-modes.mdx)、[已知限制](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/docs/content/docs/reference/cua-driver/limits.mdx)。

最终边界：本报告将官方声明与固定源码确认作为“候选能力事实”，将 Harness 当前路径作为“已适配事实”，将历史 probe仅作为作者证据；由于本轮没有实机，所有 platform/app-specific行为仍需受控实验后才能从 `declared` 晋级为 `verified`。

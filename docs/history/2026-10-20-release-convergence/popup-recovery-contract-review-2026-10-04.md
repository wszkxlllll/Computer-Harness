# Transient-parent recovery contract review

## 2026-10-07 独立只读复核：前台输入与跨应用闭环

日期：2026-10-07；实验时间以原记录 UTC 为准。

文档角色：审计。状态：当前审计补充；下文历史 GO 只适用于各自基线。

当前入口：[手机实机弹窗、输入回归与整改](./window-popup-regression-2026-10-04.md)。

基线：本地 `codex/runtime-surface-preview-20261003`，HEAD `bb17a7b`，加检查时未提交改动；共享工作树不是冻结快照。

范围：输入、窗口/弹窗闭环、浏览器启动语义、手机候选/状态、限制及跨平台影响。本审只读源码、测试源码及既有证据，仅写审计文档；未运行测试/构建、未发模型请求、未操作桌面、未读取 Codex 原始会话或秘密。

### 结论与版本范围

**暂不能放行“前台输入已修好”或“全部跨应用/手机闭环通过”。** 最近候选的真实文本损坏已由原轨迹、截图和完整读回独立对上。应保留已有局部成功，不预设需要整体重构；先区分底层输入时序/事务差异，再修部分列窗结果造成的恢复死路。

| 层次 | 本次核对 | 边界 |
| --- | --- | --- |
| Harness 源码 | 上述分支/HEAD；初次 diff 统计为66个已跟踪文件、6324增/562删，另有未跟踪实现/测试 | 包含CUA、Runtime、Host、Web、Context、协议等增量；不能仅看HEAD或旧公开仓库。统计是检查时点，不是冻结交付 |
| 构建与最近实验 | Adapter、ApplicationSession、RunController 的source/dist共六项SHA-256，均与最近失败实验的acceptance-summary对应字段一致 | 只证明这六项内容一致；mtime不证明版本，不能推广到全部产物和远端部署 |
| 默认CUA | `cua-sdk-platform.ts`：Windows/macOS为0.22.2，Linux为0.32.0；运行进程PID33812的路径位于另一checkout的`.tools/cua-driver/0.22.2/bin/cua-driver.exe` | 本审未调用daemon查询build ID；目录版本标记与实际二进制身份强度不同 |
| 实验CUA | 匹配SDK0.33.1，独立pipe `computer-harness-pi-v0331-paced-candidate`，artifact run37490081756 | 未成为默认版本；候选日志仅有listening/shutting down，无输入内部追踪 |
| 候选来源 | manifest commit `4e8857ccf6d638dee89bedf43881b77e65eba45e`；EXE SHA-256实算匹配`9d48777458c1a7270bd78973e1e8824edb6a573210db9f3dc3ddd6f68ffcc66c` | 本地候选HEAD为`824538cfa77ed259b91ff06b277ca2661e383eb8`；但keyboard.rs blob `1945596ce9df79af39648a7b03f3b98596805347`与manifest相同，只确认该输入实现 |
| 手机Web | 本地`apps/web/dist/assets/index-5Talrbto.js`早于当前相关源码；bundle缺“电脑收尾尚未确认”“重新载入截图”，源码已有 | 至少这两项本地构建落后；未查询正在服务的Web/Host build ID。主入口记Preview尚未部署最新源码，不能把源码修复当作已上线 |

### 1. 最近输入失败的可复核证据

证据根目录：`runs/diagnostics/full-foreground-task-acceptance-20261006160817512-5c27edaa/`。Run为`run-1791302904783-515b80c6-74e`，原轨迹为该目录`sessions/<Run>/trajectory.jsonl`，属于项目运行产物而非Codex会话。

- seq16：switch_window completed，明确下一观察仍为full primary desktop；seq25：Ctrl+T completed；seq27：新desktop观察。
- seq32/33：仅一次普通单行type proposal/started，91码点、唯一CH-RAW标记，无elementRef/换行，无第二次重输。实际SDK于`2026-10-06T16:09:10.011Z`开始，约773.1ms返回。
- seq35：completed，消息为`Typed 91 character(s) into the foreground application (scope:desktop)`。Receipt在诊断采样后提交，不能将started→Receipt总时间当作底层773.1ms。
- [完整读回](../../../runs/diagnostics/full-foreground-task-acceptance-20261006160817512-5c27edaa/candidate-document-readback.json)：唯一标记Notepad窗口，PID33052、HWND`0x31888`，唯一Document.value；读取调用isError=false/degraded=false。预期、实际均91码点，但**零基索引60**开始，预期U+0031（数字1）变为U+FF09（全角右括号），其后31字符全部是`）`。本审从原proposal.text和actualText独立重算长度、首次差异和尾部字符集合，结果一致，不仅依赖exactMatch字段。
- 预期正文尾部应为`19 杭州东 历时0时45分 二等座有票（页面未显示价格明细）`，实际已替换。读回SHA-256为`d93773ea325a9342f4fd5dbf31468df798b27c14a08fcaf05214bc5b86bbbfbc`；预期为`65d6bfe492674171983253a6a9f7aa33c035c8b8637a24f7ac3335811196307c`。
- 本审独立查看seq37对应的`driver-screenshots/f2232eb4-f740-4c98-9747-6f5aa37ce4ef.png`，正文连续括号与状态栏“91个字符”同时存在，也查看既有延迟采样第二图。记录中742.6ms与1695.2ms样本图片哈希相同，3131.5ms仍坏。因此不是仅采图过早，字符数相等也不能证明正文正确。

**路径与责任分界。** `cua-driver-computer.ts:4035`的actionRequest对无native binding使用primary desktop、foreground、type_text，正文原样传入。候选`platform-windows/src/tools/impl_.rs:4510`在执行时取得foreground HWND，调用send_text_synthesized，返回明确为`scope=desktop/path=SendInput/effect=unverifiable`。候选`input/keyboard.rs:506,551`在一次foreground transaction内逐码点发送、间隔3ms。Harness `cua-driver-computer.ts:3592,3660`把非error/degraded返回投影为completed，普通单行没有全文精确读回。此次不是UIA多行SetValue问题；没有证据是Harness修改了正文，但派发成功/字数判断使任务成功判定未拦住损坏。

**未知。** 读回foreground=null、inventory incomplete，不能证明输入时前台正确或错误。记录没有本次事务选中的HWND/PID、focused child HWND/TID、AttachThreadInput成否、各SendInput返回数量、drain成否/耗时。唯一标记文本证实实际落点，却不能补齐事务焦点历史。顶层前台检查也不等于编辑控件焦点证明。`keyboard.rs:708`调用wait_for_drain后未使用bool，是确认强度缺口；尚不能认定就是括号重复根因。

**有效但混杂的对照。** `20261006130451712-83eb44e0/paced-input-experiment-readback.json`记录一次模型type、91次顺序SDK RPC、每次前台探测同PID/HWND，耗时120356.4ms，全文精确一致，各effect仍为unverifiable。runner的`dispatchPacedDesktopTypeText:1258`保留actionArgs，只替换chunk文本，不能误写为切到element SetValue。该对照同时改变RPC/事务次数、探测间隔、attachment/drain生命周期和总耗时，不能单独推出“逐字就好”或“3ms足够”。

**最小下一实验，仅设计。** 待桌面协调且取得本轮实验许可，在同隔离SDK/候选、同受控空白文档、同91码点下，仍一次RPC/一次事务、每码点一组事件，仅把码点间隔改为成功91-RPC轨迹中的实测保守间隔（按逐调用时间取值，不凭平均数猜）；同时记录上述HWND/TID、attachment、SendInput count、drain结果，最后只读全文逐码点比较。慢单事务仍坏，单纯消费速度不足不能解释，应转事务/队列生命周期；成功则先收窄为时序敏感，再找可交付节奏。不要同时换UIA/剪贴板、重选窗口、自动重试或增加模型调用。本审未执行。

### 2. Harness输入语义的独立限制

Windows native-window多行由`executeMultilineType:3739`验证UIA token/snapshot、Session/Observation/Surface/geometry，再以background type_text发送新chunk；`3889–3902`只在同次value_readback confirmed时completed，否则partial。它是末尾追加，不是光标插入或选区替换；`runtime/computer-tools.ts:39–45`已告知。

候选CUA `tools/impl_.rs:4806–4811`仍在CurrentValue失败时unwrap_or_default后SetValue，存在旧正文读取失败时覆盖风险。本审未实测该分支，也不将v0.33.1源码检查冒充默认v0.22.2二进制实测。这是单独风险，不是本次SendInput损坏的原因证明。

`cua-driver-computer.ts:3249`让Windows所有含换行type进入该分支；desktop缺exact native binding，`3761`拒绝。工具说明与测试`1308`均明确此限制。Context `projections.ts:60`建议逐行type+Enter，但普通单行当前有真实损坏风险，不能把拆行作为可靠替代或整屏多行已通过。应修改这种可靠性暗示，保留“不盲猜UIA、不把unknown改为安全拒绝”的边界。

### 3. 窗口/弹窗闭环与明确的过严分支

保留成立链路：listWindows发Run-local windowRef，executeWindowSwitch消费旧列表；native transition做激活/新捕获，desktop `3017`只激活并保持desktop scope；activateWindowTarget核对driver foreground identity，不只信通用成功布尔。Runtime `observeAndCommit:2728`及Receipt validator `3369`消费parent/sibling/native/desktop safeRecovery，核对新SurfaceRef/transition；unknown保留，旧batch不重放。这些都有生产者/消费者，不应为了绕过失败而整体移除。

真实证据范围：

- 携程→Notepad Run `run-1791292339458-454347e9-dba`，seq105为partial+transient_parent_restored。本审独立读取实际TXT，与原type.text做CRLF/CR→LF规范化后全文一致。支持受管网页→native UIA报告→保存→父窗恢复；不证明desktop中文输入已修好，也不证明恢复后另完成了新GUI动作。
- WPS native Run `run-1791293020638-54a50b53-362`，24动作/26请求后失败、无输出，seq13为native_surface_reconfirmed的unknown。不能从completed点击断言菜单已打开或正确采图。
- WPS desktop Run `run-1791294022199-456e9415-043`原轨迹有1 refusal、6 partial/unknown；摘要18 completed不是总尝试数。既有fileValidation和作者记录支持正文/字体保存；本审未再次解包DOCX，不将其算本审实测。短ASCII和初始文档身份不足，不可扩大成完整中文新建能力。

**P1，代码确认：** `cua-driver-computer.ts:2304–2312`不看inventory.complete/truncated，只要缺boundPeer就markSurfaceUnknown；随后observe `1145`、executeWindowSwitch `2970`拒绝unknown Surface。测试`1272–1301`只证明目标重现后还能列窗，没证明普通observe/switch可恢复。一次partial清单漏行可使仍活着的目标进入正常恢复链的死路，和其他路径“不凭部分清单证明消失”冲突。不是已证实该条件触发了最近输入失败。

最小修正建议：partial/截断漏行归为本次发现不确定，撤销旧引用后做有界exact-target只读核实，不直接永久失效；保留真正关闭/错PID/HWND的拒绝。先编排“partial漏目标→精确目标仍活→新观察→新list/switch”以及complete absence、复用HWND换PID的反例。本审只阅读测试源码，未运行。

### 4. 浏览器自动启动与模型自主能力

手机Remote API `remote-run-api.ts:490,500,556,906`对非browser起点、switchWindows=true按saved/temporary设置准备managedBrowserCompanion、起始about:blank；saved还受profile准备与lease约束。`run-factory.ts:46–60`转hybrid，`computers.ts:357`在Computer.open时host.start。因此这是Host启动策略，不是模型先判断需要浏览器才启动；不开跨应用的普通native起点不创建companion。GoalComposer开关已告知“电脑也会按设置准备受管浏览器”，不是完全未告知行为。

标准computer工具有list_windows/switch_window及普通GUI动作，没有launch_app/open_app。开关不承诺任意应用自主启动；desktop可能经授权正常界面启动应用，但仍需模型与后续发现/激活链实际成功；native绑定不会自动获得整屏启动器能力。desktop切到受管浏览器仍是visual-only desktop，不自动取得native DOM scope。

建议保留显式opt-in、受管profile与个人浏览器区分。若目标是“只切原生应用、不额外开浏览器”，当前存在产品耦合，应单独确认按需启动/独立开关，不混入输入修复。不要合并“选择应用、启动应用、切换已开窗口、取得DOM授权”的能力承诺。

### 5. 手机候选、预览、控制与部署一致性

当前源码有精确candidate token/request/TTL、预览前后PID/HWND复核、可选预览不清普通选择、强制预览待图片load成功才确认、取消/过期/清理失败不返回可确认图。`window-discovery.test.ts:195,285,320,355`及PendingRequestPanel/useRunFeed测试有相关合同场景，但本审未运行。Host cleanup结束后另发状态，Web区分finished/pending_cleanup；这些边界应保留。

实机证据缺口：`real-window-preview-20261006-E8uWgJ/result.json`是no_wps_candidate，虽然WPS进程数7；`yX4sS1`也为no_previewable_wps_candidate。进程存在不等于可选HWND，它们不能当作真实WPS预览/手机触摸解码通过。先核对实际服务的Host/Web build ID，再只读列窗→确切候选预览→load/过期失效；另获桌面许可后才确认选择token、实际激活目标、最新截图、取消及owner released。

**P2静态竞态：** useRunFeed已隔离换Run的迟到数据；`apps/web/src/hooks/useRunCommands.ts:18–78`的busyCommand/notice/commandIds及异步回执没有runId/epoch隔离，`App.tsx:40`的RunWorkspace也未按runId加key。同一组件实例从A换B而A回执未结束时，旧notice/finally可能影响B。尚未实测，不能说是当前用户事故。最小验证：延迟A的send/get回执，rerender到B，再返回A，确认B提示、忙状态与registry不受影响；沿用现有epoch或Run-key生命周期，不另造控制层。

### 6. 优先级与保留/修改/移除

1. **P0输入正确性：** 3ms候选不升级；先完成第1节单变量对照，后续回归空白、中间光标、选区、中文、代理对、CR/LF，区分普通输入与追加合同。判定依据是实际内容，不是动作回执/字数；失败不重放。
2. **P1发现可恢复性：** 修partial inventory→永久unknown；保留exact identity、fresh capture、真实absence反例，不能泛化成任意窗口可选。
3. **P1交付一致性：** 源码、构建、服务资产身份分别记录；部署和桌面操作按现有协调授权。移除“源码GO=整体可用”的解读，保留历史证据原文。
4. **P2控制竞态与性能：** 补换Run的command回执隔离。post-input-observation-settler默认1500ms等待、250ms采样、最多7样本/约3000ms调度窗，只证明画面采样稳定，不证明正文正确；capture自身仍受其超时。不要为稳定损坏继续堆sleep，按轨迹衡量后收窄适用范围。
5. **平台与重复机制：** Windows SendInput/UIA/可见区域采图不能直接推广为Mac/Linux验收。可见区域采图以win32/local pipe/foreground为条件，失败回原采图，不是像素隔离保证。unknown防重放、fresh Surface、owner cleanup都有消费者，未发现应整体删除的证据。多行准入`3822/3833`重复检查可后续合并，但不是当前根因，不应以整理代码替代输入验证。

本审实际执行仅Git/源码/测试源码阅读、现有JSON/轨迹/图片和保存TXT核对、若干哈希比较。历史tests/build成绩均不算本审运行；没有实时屏幕接口，未捕获新画面或读取当前焦点。本机.codex目录被沙箱拒绝，未用memory_summary；所查项目.agents/skills入口不存在。本地证据已足以形成上述输入结论。

---

Status: final source/integration GO for fb4d7bb plus the scoped DOM replay-guard correction below; this is not an end-to-end desktop or phone acceptance result. Earlier sections retain the historical planning and incremental review record.

## 最终合并集成审查（2026-10-04）

审查基线为 origin/main..fb4d7bb，main 961a098 已合并，另包含本次授权的 CUA source/test 两文件最小修正。结论 GO，无剩余本审已发现的 P0/P1；放行源码集成与 root 后续 fresh build/full tests/真实验收，不宣称历史窄测试等于整体端到端成功。此次未 build dist、未操作 GUI、未调用模型或外部 API、未 spawn reviewer、未 commit/push；既有未跟踪文件未删除或修改。

合并边界检查：main 的 Mac focus、浏览器 chrome fingerprint、editable DOM 原生 click 后 focus verification、平台坐标/截图选择及 defaultManagedBrowserKind 均保留；shared Jev 仅 app-runtime 一份实现，CLI reexport，Host 显式 opt-in factory 与 CLI 消费同策略，应用约束和候选唯一性不因语义 selector 放宽。Windows one-base-key chord 仍一次 press_key dispatch，无出错 fallback；Darwin/Linux multiline 仍旧 type_text 路由，Windows private UIA on-demand 保持 Observation/session/Surface/geometry/token 精确绑定、查询 deadline/Abort、不发布私有证据到公开 catalog。

非空 Windows multiline 最终契约已取代前文历史 empty-value guard：删除 preValueEmpty 字段链和空值准入条件，只发送新 chunk，不在 Harness 读取文本后拼接；依赖 pinned CUA 0.22.2 ValuePattern 的 CurrentValue + chunk 逻辑末尾追加和同目标 read-back，不是光标插入或选区替换。已确认响应才 completed，明确 no-input 才 refused，发送后无可信 read-back 或 error 保持 partial 不重发。上游 CurrentValue 读取失败的 unwrap_or_default 风险必须保留，Harness 没有保证旧文本读取成功或绝对无损追加；本次未实测该失败分支，也未改剪贴板或绕行粘贴。

弱 owner/z-order/unknown popup 仍是 Registry 外 candidate，继续已验证 parent 不等于证明 child 消失或输入已获许可；正向 root 或 exact foreground+owner 的强 child 继续走 fresh capture/关系重验。parent/sibling/native reconfirmation 的 typed proof 都有 Runtime 消费者及匹配 fresh observation，unknown receipt 不变 completed，旧 batch 后缀不重放。无法确认进入真正 user barrier，peer 走 Host 原确认 gate。Remote handoff 刷新等待时 status 仍 waiting_window/abort，候选 settled 后才公开；超时/失败复用现有恢复合同，旧 request/终态结果取消。paired preview 的 Host cookie/CSRF/捕获后重新鉴权、HTTP→Relay route allowlist/bytes/no-store、exact candidate pre/post 验证和图片 load 后确认保留；不能把早期未刷新列表当最终零候选过滤。

发现并已按 root 的两文件授权修复一个合并联动 P1：main 保留的 managed DOM click/select_option completed 提前 return 原先没有更新本轮私有 unknown replay guard，导致真正完成不同 GUI 动作并 fresh observe 后仍过严锁住原 primitive。现在仅这两个已通过 tab/generation 验证的 completed 分支置同 Surface 的 alternativeActionCompleted，实际解除仍在 fresh observe；wait、refused、failed、partial/unknown 不解锁，没有增加字段或取消原焦点检查。新增两个集成 case 先产生 native unknown、再完成不同 DOM 动作，确认未 fresh 仍拒绝、fresh 后才允许原 primitive。测试 mock 用新对象构造只读 transport，不修改生产 readonly 契约或 any 绕过。

本次独立离线验证：集成 pattern 45/45（CUA 31、Remote 9、Pending UI 5）；共享 selector/Host factory/CLI reexport 与本地 Host HTTP→真实 Relay WSS 测试 11/11，合计 56 个不同相关 case 通过。修正后另按 root 要求重跑 DOM 两分支加原 wait/failed guard 三项，3/3；该三项已经包含在 56 项内，不重复计数。packages/computer-cua 的 tsc --noEmit exit 0，git diff --check 无新增空白问题。root 的 fresh 全量 build/tests 此时另行执行，未把其未返回结果写成通过。本地 HTTP/WSS 是 mock 窗口与设备夹具，不等于真实配对手机或原生桌面操作。

root 最终独立执行结果：fresh tsc-b 与 spike noEmit 通过，Vitest 111 文件、1654 项全部通过，built CLI --help 通过；13 个 Node script suites 合计 70 passed、1 个 Windows symlink skip。此前两个 main capability-tool-filter 测试已改为正常 ComputerWindowList 夹具，未放宽生产验证。本审没有进入该第三文件，这些全量结果明确归属 root，不能计为本审独立执行，也不等于真实桌面或手机验收。

### macOS CI 平台夹具修正窄审

root 随后读取 macOS CI 的 11 项失败日志，作者只改 CUA driver source/test 与 window-discovery test 三文件。本次只读窄审 GO：统一 capture 平台 resolver 按 configured → detected session → host 解析，补齐 initial child、parent restoration、sibling 三处 nested capture 的平台参数，原 Mac 正常 capture 路由未被强写为 Windows。resolver 仅源码文件导出供直接单测使用，未新增 package index export、options 或协议，也未放松身份、关系、foreground、capture 或 unknown 验证。WindowsFixtureDiscovery 只限定 Windows 测试默认值，显式 darwin/linux fixture 仍使用生产类；生产 discovery 的默认宿主平台没有修改。

本审独立仅三个必要 case 3/3 通过：session platform 优先于不同 host、already-open owned Menu 的 Windows capture、macOS inventory 正常路由。未改业务文件、未 build、未 GUI/API 或 spawn；真实 macOS CI 再跑尚未返回，不声称 CI 已修复通过。文档 UTF-8 读回验证后冻结，真实任务缺口仍按下段保留。

明确未实测边界：本轮没有实际 macOS/Linux SDK 多行端效果，没有验证原生邻窗 token 拒绝及 pre-read-default 覆盖风险，没有真实手机触摸/PNG 解码质量/网络取消体验，也没有重跑完整 WPS 与携程→记事本跨应用保存。真实任务结果只认 root 留存的 receipt、截图、输出文件及 cleanup 证据，不由本源码 GO 补造。

## Minimal contract

An ordinary GUI action on a registered transient child can retain an uncertain outcome as `status: partial`. It may carry `safeRecovery: { kind: transient_parent_restored, surfaceRef: SurfaceRef }` only after the adapter has completed exact registered-parent restoration, fresh exact-parent capture, and the existing child-pop transition. This summary is backend neutral. Native HWND, Win32 inventory, and CUA error strings remain adapter evidence, not Runtime decision inputs.

The adapter must require a complete, untruncated fresh Win32 relationship snapshot for this Windows recovery path: the exact registered parent is visible and foreground; the exact owned child is absent or hidden; no replacement owned interaction window exists. Partial inventory cannot establish disappearance. Transport failure and unrelated peer foreground remain unresolved. No input is retried and no completed action receipt is manufactured.

Runtime durably records action failure, tool failure, and unknown-side-effect diagnostic. It validates the recovery summary against the execution observation's exact direct parent, rejects switch/wait and malformed receipts, and stops the previous batch suffix. A standard fresh observation must match every SurfaceRef identity and generation field in the recovery summary. Only then may a new Provider decision inspect the failed tool result and fresh screen. Failure to observe or a mismatched SurfaceRef terminates as outcome_unknown.

The recovery attests a safe new decision boundary, not the semantic success of the uncertain click. Event history must retain that uncertainty even if subsequent work succeeds.

## Required verification

- Adapter positive: ambiguous foreground error after ordinary child action; complete exact owner/foreground evidence; child absent or hidden; fresh parent capture; child_pop; partial receipt with exact parent summary; one dispatch only.
- Adapter negatives: partial/truncated inventory, missing/wrong owner, hidden/absent parent, other foreground, replacement child, failed exact capture, transport error, unrelated peer, explicit no-input refusal. None receives a safe recovery summary.
- Runtime positive: failed action/tool and unknown diagnostic persist, old batch suffix never executes, standard fresh observation matches the recovery SurfaceRef, a new model decision sees failed result and fresh parent screenshot.
- Runtime negatives: malformed summary, wrong actionId, legacy unknown SurfaceRef, wrong parent, wrong generation/kind/admissionSource, switch/wait receipt, failed or mismatched fresh observe. All stay terminal outcome_unknown.
- Cleanup separately: a confirmed empty backend resource inventory permits release of the owner/lease even when historical action outcome is unknown; missing/incomplete cleanup evidence must retain the lease. Clearing resource uncertainty must never rewrite action uncertainty.

## Evidence and boundaries

Read repository AGENTS.md, current protocol SurfaceRef/ActionReceipt, CUA execute ambiguous-error branch and existing transient child-pop code, and Runtime receipt normalization/partial termination path. No tests or live desktop operations performed during this planning pass. Independent patch review follows implementation.

Subsequent independent lease review: the release check now requires an explicitly present array of cleanup diagnostics with zero entries. Missing or malformed diagnostics retain pending_cleanup. Historical outcome_unknown remains in the Run record. Ran `pnpm exec vitest run packages/app-runtime/src/application-session.test.ts`: 13/13 passed, including missing/malformed diagnostics cases. No API or GUI operations.

## Implementation review and independent verification

The implemented recovery is GO for a real Harness task retest. The direct parent capture uses the existing capture helper; it does not consume the pending Surface transition. Only after capture and a second complete relationship snapshot does the adapter apply child_pop. The subsequent standard observation consumes and reports that transition. Runtime validates the partial receipt and exact direct-parent reference, records failed action/tool and unknown-side-effect facts, validates a fresh matching Surface and child_pop, and relies on its existing failed ToolCall boundary to reject the old batch suffix before the next model decision.

Both structured Tool results and thrown Tool errors use this same recovery path. Explicit no-input refusals use the same strict restoration proof and remain refused, with a parent-restored code instead of an unnecessary foreground-mismatch picker. Failed restoration preserves the original boundary. Transport and unrelated foreground uncertainty do not receive recovery permission. Recovery SurfaceRef accepts only its defined keys and validates optional parent identity fields.

Independent command: `pnpm exec vitest run packages/computer-cua/src/cua-driver-computer.test.ts packages/runtime/src/index.test.ts packages/trajectory/src/index.test.ts`. Result: 314/314 passed (CUA 154, Runtime 110, Trajectory 50). Adapter cases include absent/hidden child recovery, text/structured explicit no-input, and incomplete/truncated snapshot, owner mismatch, wrong foreground, replacement, hidden parent, and capture failure rejection. Runtime cases verify durable partial failure, fresh decision input, batch suffix rejection, and mismatched fresh Surface termination. Existing tests retain generic unknown/cancellation and non-recovery partial termination coverage.

During expanded typed-candidate consumer review, found stale remote target identity after child_pop could suppress a later popup. The target-selection implementation agent accepted the correction: consume the adapter-attested ownership relation without filtering against the remote's stale target identity; output parent labels only when their identity is still exact. Shared Jev extraction and final target-selection consumer verification are pending separately. No live API or GUI operations were performed by this review agent. Passing these offline tests is not evidence that a complete user task has succeeded.

Final popup delta verification: the new thrown-Tool recovery case and invalid recovery extra-field/wait cases were independently exercised together with the existing absent/hidden positives, 5/5 passed. Combined with the earlier baseline, the current 317 distinct popup-related tests have independent coverage.

Expanded target-selection review is GO for real retesting. The selector implementation resides only in app-runtime; CLI re-exports it. Host defaults to local matching and requires explicit Jev mode plus a TypeSafe key. Remote auto selection uses local matching first, limits semantic candidates to an explicit app constraint, withholds indistinguishable app/title labels, and validates a suggestion against its submitted inventory before exact-target verification. Root's ignored full-task acceptance runner imports the same Host configuration factory and injects it into RemoteRunApi. Its Notepad task uses natural Chinese, without an executable-name workaround.

The stale-child remote filtering defect and duplicate-caption semantic-selection defect found during review were corrected. Parent labels are now projected only when their exact owner matches the remote's current identity; otherwise the adapter's attested child category is displayed without guessing a parent label. Indistinguishable captions cannot receive an automatic semantic selection.

Independent target tests: RemoteRunApi 47 and matcher 9 passed after fixture corrections; Host selector configuration 2 and shared selector 4 passed. Independent phone UI tests: HomeScreen 22 and PendingRequestPanel 9 passed. CLI TUI had 60/64 passed, with four test-fixture failures reported to its implementation agent: two missing Escape steps before quitting and two obsolete selector-call/text expectations. Source inspection found no production blocker in those four failures. These commands used the terminal's Node 18.19.0; root owns the separate Node 24 build and live verification.

At root's explicit request, this reviewer performed two small compile repairs: removed the extra remote-control union closing brace, re-exported hasExplicitApplicationIntent from the CLI matcher compatibility module, and removed the second duplicate RemoteRunApi import pair. The CLI identity helper already existed and was not duplicated. No other business code was edited by this reviewer.

## Profile-state namespace follow-up

Planning GO: the default persisted readiness state must be separated by the existing exact profile identity hash (normalized root and profile label), rather than a single shared file above the root. Read the namespaced file first. Only when it is missing may the default store read the legacy shared file, and only a version-2 state with the exact matching identity hash may be copied into the namespaced destination. Preserve the legacy file bytes in every case. Version-1 or mismatched-hash legacy state supplies neither readiness nor another profile's default-session preference. Reading mismatched state must not write false readiness to any other profile's file. An existing corrupted namespace fails closed rather than falling back to legacy. Cookies and profile configuration are outside this repair.

Required tests: distinct labels and roots select distinct namespaces; both profiles retain independent ready/default-session state across interleaved reads; matching-hash migration preserves valid state and legacy bytes; mismatching and hashless legacy states perform no writes; an existing namespace wins; corrupt namespace does not trigger fallback. The real runner must use the same selected Host profile configuration. Legitimate Harness prepare/complete can confirm the current profile lifecycle without manually forging ready JSON or requiring a new login.

Final implementation review: GO. Default store namespaces use the existing root-plus-label identity hash. Legacy migration uses fsynced temporary-file hard-link publication to create only an absent namespace; EEXIST does not overwrite a newer state. It then rereads the namespace and validates identity before using its actual readiness/default-session state. Ordinary saves retain their existing behavior. Foreign/hashless legacy reads do not write or inherit preferences. Existing corrupt/foreign namespaces fail closed. Shared/custom mismatched stores now preserve their original state instead of overwriting it during a read.

Independent verification: `pnpm exec vitest run apps/host/src/managed-browser-profile-service.test.ts`, 24/24 passed on Node 18.19.0. Tests cover label isolation/interleaved reads, matching migration with unchanged legacy bytes, mismatch and version-1 no-write behavior, namespace precedence, corrupted/foreign namespace rejection, and create-if-absent preservation of existing state. Source inspection verified the atomic migration race boundary. Root separately owns Node 24 build and legitimate Harness prepare/complete plus live full-task verification. This reviewer neither edited Cookie/profile configuration nor operated the browser, API, or desktop.

## Initial selector threshold follow-up

Root-approved threshold adjustment is GO after source review and a targeted selector test run. Initial candidate suggestions now require probability at least 0.85, confidence at least 0.80, and margin at least 0.30. Handoff retains 0.95, 0.90, and 0.50 respectively. These are implementation selection gates, not measured accuracy guarantees or GUI-action authorization. Exact candidate verification, app constraints, indistinguishable-caption rejection, native fresh evidence, and subsequent fresh-screen model decisions remain the authority boundaries.

The probability decoder now strictly accepts the submitted candidate IDs plus none, validates every value, and computes competitors only from those validated keys. This closes the previous path where an unvalidated extra nonnumeric probability could turn Math.max into NaN and bypass the margin comparison. Number.EPSILON accommodates floating-point equality only; clearly subthreshold margins remain refused.

Independent command: `pnpm exec vitest run apps/cli/src/window-selection-jev.test.ts`, 7/7 passed on Node 18.19.0. Cases cover observed probability 0.88/confidence 0.86 accepted for initial but refused for handoff, separate subthreshold confidence/probability/margin checks, a competing higher probability, unexpected probability keys, and exact 0.85/0.80/0.30 boundary acceptance. No API or GUI operations. Root owns the pending real-task results and final parameter/results documentation.

## 本轮最小窗口切片集中审查

初始候选链可推进真实验收。CuaWindowDiscovery 的 listInventory 保留同一快照的完整性与来源；Windows 关系探针只读，不激活、不输入。应用层 projector 仅在完整、未截断、可信关系快照中证明精确 owner PID/HWND，且 owner 本身为根窗口时附加 owned_child；初始筛选器只收窄本地匹配与 Jev 候选，不删除原始 inventory，不自动创建 Surface。Host 与 CLI 使用同一筛选器；“请帮我在 WPS 里”等开头语法是应用约束，不把后续来源或目标应用随意变成初始目标。

菜单身份校验与公开 grounding 开关解耦的方向正确：grounding=off 时，完整、未截断 Win32 关系证据允许对一个精确 child HWND 执行有界 get_window_state；不查询全桌面 UIA 树、不请求该查询的截图、不向模型提供 catalog 或 accessibility 工具。原有 same-HWND overlay 路径未扩大。真实独立 Menu 的正向结构化根证据可进入既有 child_push；无需额外证明全 UIA 树不存在其他菜单。

审查发现并直接修复一处 P1：原 non-blocking auxiliary 分支把 rootRole 未知也当作非菜单证据，导致未查询、缺失或截断根数据的潜在菜单被静默忽略。现只允许明确解析出的 rootRole=window 进入该分支；未知根走已有人工确认边界。完整 Win32 证明 exact child foreground 的既有关系路径保留；queryFailed 与未知根不得冒充辅助窗。没有动作重放。

独立离线验证：window-discovery 非 preview 8 项、window-target-discovery 7 项、window-target-matcher 15 项、computers 23 项、Remote API 48 项、CLI TUI 66 项，共 167 项通过。命令使用终端 Node 18.19.0；root 的 Node 24 构建另记。同文件正在开发的 preview 测试额外出现一项日期正则断言失败，本次未审查或修改 unfinished preview，不以此否定本切片。新增 initial-observe existingMenu helper 及补充未知根负例尚待作者 ready 后一次增量审阅，不能将待完成内容写成本轮通过。

菜单 gate 增量独立验证已通过：grounding=off 的真实结构 Menu 正例、Window 根带后代 Button 的负例、同 PID 和跨 PID 的明确辅助窗、既有 UIA 查询失败观察路径共 5 项通过；另单独运行 exact-root-query-error 保留人工候选用例，1 项通过。queryFailed 在 parent foreground 场景不会静默忽略候选。此验证仅针对已 ready gate，不把未完成的 initial-observe helper 算入结果。

Task1 实际验收关注两处尚未复现的后续边界，不据静态代码宣称已经失败或偷偷修改：第一，CUA 0.22.2 的坐标输入仍要求精确请求 child HWND 获得前台；owner chain 的发送后检查不能反向把 parent foreground 当作 child 输入授权，需记录真实 foreground_unavailable/landed/no-input receipt。第二，现有 native-child reconciliation 发现同 owner 的新 visible HWND 时会阻止旧 child pop；Menu 隐藏并打开 SaveAs dialog 的连续场景可能触发此保守边界。同 owner sibling 存在不反驳旧 exact Menu.hidden 的闭合事实，但会反驳“现在可恢复并直接操作 parent”的结论。若实际证据确认这种转换，应分别处理旧 child 闭合与新 sibling 的精确 admission 或人工选择，不可只删除 replacement guard 后让模型继续看父窗口截图。unknown safeRecovery 的无 replacement、父前台证明仍保持严格要求。

人工边界的实际消费者需区分：动作完成后 detectNewWindowHandoffCandidates 的 unknown 错误由 Runtime 生成 user.input.requested；此路径有真实用户请求消费者。新增 initial-observe helper 抛出 TRANSIENT_SURFACE_UNKNOWN 则经 ObservationCaptureError 进入 RunController 外层 catch；初始观察尚无 unresolved action 时会记录 runtime.error 并以 failed 结束，没有自动窗口选择或用户请求。因此该入口未知根、正向菜单捕获失败的当前结果必须称“显式失败、尚未实现人工继续闭环”，不能称为已经进入 manual picker。正向已有 Menu 观察切片可单独验收，未知恢复交互不在此小修中重构。

### Initial-observe 已有菜单切片最终增量结论

GO，范围仅限精确观察、SurfaceRegistry child admission 与截图，不等于菜单输入成功或完整 Task1 已修复。新增 admitExistingOwnedTransientChild 仅对 foreground 模式、Windows、当前可执行原生根窗口进行检查；使用完整未截断 Win32 快照、精确 direct owner 和唯一可准入 owned stack，并通过既有 exact-root parser 得到正向 Menu/Popup/Dialog 证据。一次 child fresh capture 后再次读取完整 Win32 快照，检查 parent 身份/几何、child 身份/owner/可见性/捕获几何及 fresh admission，全部通过才提交 child_push。成功捕获复用至本次观察，不扩大到其他窗口；grounding=off 不输出 catalog 或 accessibility 工具；same-HWND 路径不变。

增量审查再次发现并由该入口作者修复未知根缓存漏洞：现在仅明确 Window 根、查询未失败且 exact parent foreground/owned stack 证明非阻塞时才返回父观察并缓存；queryFailed、缺失或不可解析根均抛显式 TRANSIENT_SURFACE_UNKNOWN，且不缓存。捕获失败或二次关系验证失败也不提交 child。部分或无法读取的 Win32 首次快照不会永久标记已检查。成功转移明确报告 child_push，不被先前 generation_advanced 标记遮蔽。

独立只跑本次 6 项增量，全部通过：已有 Menu 在 parent foreground 时首次观察即截图到独立 child；Window 根带后代 Button 不误认菜单；capture、revalidation、root-query-failed、root-unparseable 四种失败均不提交 child，并可在后续明确状态下重新观察。作者报告 driver 测试 163/163 与 package build 通过，此处与独立 6 项区分记录。未等待 unfinished preview、未重跑整仓库、未调用 GUI/API。下一步是 root 主持 Task1 真运行并记录实际 receipt/截图；初始未知错误目前是 failed 终态而非已完成的人工继续闭环。

### 完整快照的初始可见性投影增量审查

GO。实机启动前完整 Win32 清单包含大量 hidden helpers，导致初始候选数上限阻止任务；本次投影仅在完整、未截断、来源可信的快照中排除明确 isOnScreen=false 且 minimized=false 的行。可见窗口、最小化窗口、缺少可见性字段的行继续保留；不新增 class/app 黑名单、不提高模型候选上限。原始完整快照仍用于同快照精确 owner 证明及 Computer 内部生命周期判断，不把展示筛选结果当作 child 消失证据。

审查发现并由作者立即修复初始筛选的过度删除：只有父窗口仍在 eligible target pool 且为 independent root 时才剔除已证明 owned_child；若父窗口因 hidden controller 属性被隐藏，visible child 保留，不把唯一可操作窗口一律删掉。owner 关系只是候选组织元数据，不自动授予 modal 或输入权限。

独立增量验证 window-target-discovery 13 项、window-target-matcher 15 项，共 28/28 通过。覆盖 318 hidden-helper 行过滤、visible/background/minimized 保留、缺字段兼容、raw owner 证明保留及 hidden-owner 唯一 visible child 不误删。Remote API 50/50 是作者报告，未计入此次独立验证。partial inventory 的逐行 fresh-visibility provenance 尚未实施，不纳入本次 GO；源标记 win32 在拒绝合并后的混合行中不足以单独授权 partial 行过滤。未审 unfinished preview，未 build，未调用 GUI/API；root 可构建后重启真实 Task1。

### 初始 Jev 请求语义增量审查

字符串契约只读审查 GO：仅 purpose=initial 选择任务第一阶段的 existing application window，允许任务随后新建 document/tab/file 或切换其他应用，不要求未来输出文件名已经出现在当前窗口标题中，也不因任务后续需要其他应用就自动选择 none。none 保留“没有安全起点或起点歧义”的条件；窗口标题继续声明为不可信数据。此修改不授予未来窗口或 GUI 输入权限、不包含应用名特例；Host 仍验证候选成员、应用约束与精确窗口证据。handoff 请求文案、两个 purpose 的阈值及解码规则均未改变。

本次只读源码与新请求契约测试，未 build、未调用 GUI/API、未重复旧全包。新请求契约 1/1、CLI 共享请求回归 7/7 是作者报告；实际同 goal/candidates 的 TypeSafe 与 Task1 结果由 root 主持记录，不能用字符串单测冒充真实目标正确性。

### Menu 隐藏后同 owner 新 dialog 的 reconciliation 审查

GO，可进入真实 Task1 重跑；不宣称真实任务已经成功。CUA 在 unknown 输入结果和 completed 动作两路都复用同一精确 reconciliation：原 child 已明确 hidden 或 absent；当前已注册 parent 的身份、可见性与几何可信；新 native child 与原 child 不同，具有相同精确 owner、唯一可准入 owned stack、正向 Menu/Popup/Dialog 根与成功 exact capture。捕获后再次验证完整未截断 Win32 快照、old child 闭合、parent/new child 身份与几何、owner/stack/foreground pair，并再次校验正向 root，随后才闭合旧 child、提交新 child。最后提交前检查 Abort。

unknown 路径最多三次 300ms 只读等待，优先确认 sibling，最终才尝试原有 parent restoration，避免 Menu 已隐藏、新 dialog 尚未出现的中间快照过早成为 parent 恢复结论。等待不重发 click。未知动作始终保持 partial，action/tool 失败和 unknown-side-effect 事实继续持久化；新的 transient_owned_surface_reconciled 不冒充 transient_parent_restored，更不改成 completed。已有 completed receipt 不因后续观察转换被改写。Runtime 要求恢复 Surface 与旧 Surface 不同、同一 exact parent、旧新 admissionSource 可信，再要求标准 fresh observation 精确匹配 SurfaceRef 所有字段与 child_push；原 batch 后缀停止，新模型只依据失败结果和新截图决策。Trajectory 消费可信同 parent sibling 的 child_push，不把它解释为任意 peer switch。

集中审查收口三项最小修正：Runtime sibling 验证与 Trajectory 对齐，旧新 admissionSource 均须可信；原 parent-restored 只要求 direct parent ID 精确匹配，删除错误的新 root-only 限制，保留合法嵌套父 Dialog 恢复；fresh root 返回后、pop/push 前明确检查 Abort。Runtime commitEvent 本身先 reduce 再 append，不会把被拒绝的 transition 写坏，因此 admissionSource 对齐的意义是尽早拒绝而非修复已证实的轨迹损坏。

独立只跑本次必要增量 18/18 通过（CUA 8、Runtime 9、Trajectory 1）。覆盖 unknown/completed 两路与无重放、Menu-visible→hidden-only→owned-dialog 顺序、false parent/wrong owner/multiple top/partial/capture failure/Abort、nested parent restoration、旧新 source/parent/Surface ID 错误，以及 sibling transition 与错 parent 拒绝。339/339 全目标与依赖链 build 是作者报告，未冒充本审独立整包执行。保留实机缺口：实际 SDK foreground 输入拒绝、真实等待时序与 Task1 连续保存结果仍需 root 的真实 receipt/截图/文件验收；纯 mock 通过不证明这些已成功。未 GUI 输入、未调用额外 API、未重复整仓库测试。

### Windows foreground 修饰键 chord 最小映射审查

GO。仅 Windows、绑定原生窗口、foreground、一个非修饰 base key 和至少一个已识别且无重复 alias 的 modifier，转换为一次 press_key(key, modifiers, exact target, delivery_mode)。其他平台、background、desktop、单键、文本、多 base key、未知 modifier 和重复 alias 保留原路径；拒绝、错误或 Abort 后不会再用 hotkey 重发。没有应用名特例或输入权限扩大。独立两轮小范围匹配执行覆盖 10 个不同相关 case：3 正向映射、3 未映射组合、background/Linux 两条旧路径、foreground refusal、Abort。181/181 与依赖 build 为作者报告；实际键效与任务结果仍由真实 Harness 后验，SDK 接收成功不等于目标已产生选择效果。

### multiline 平台分支最小修正审查

GO。isMultilineType 仅 Windows + type + newline，因此 Windows 仍走原私有 UIA 目标、empty-value、token/read-back 防护；Darwin/Linux newline 走原 actionRequest/type_text，保持原文本与 foreground exact target，不做 Windows CR 转换或要求 UIA。groundingRef 绕过普通 click-only 拒绝也严格限定此 Windows 私有分支，其他平台带 unsupported ref 仍明确拒绝，不偷偷丢弃 ref。

本次独立三个必要 case 3/3 通过：Darwin、Linux native multiline route 和 Windows non-empty refusal；17/17 multiline 集合为作者报告。只读业务源码、只更新本文档；未 build、未 GUI 输入或额外 API。其他平台的真实 CUA 后端多行效果未实测，不把 mocked dispatch 正确性等同平台端实际结果。

### Remote handoff 候选异步刷新时序审查

GO，无剩余已发现阻塞项。新 handoff request 先取消旧 refresh、清 token/fingerprint；刷新未 settled 时 HTTP snapshot 不发布暂态空候选，stream 发送 pending cleared，Run 仍明确 waiting_window 且保留 abort。刷新成功后才发同 request 的 token 候选。故此前 runner 在异步刷新结束前读到无 pending/空候选就 abort，不能把这一暂态证据报告为最终零候选过滤结果。

失败或 15 秒本地 deadline 后，复用现有 window_handoff request 发布空候选并保留恢复/取消入口，不新造协议，也不选择未知目标；foreground_mismatch 没有 ignore 授权，new_window_detected 仍只按原 Runtime 规则允许忽略继续。终态、ignore、completed 或新 request 都取消原 refresh；结果发布前要求同 refresh 对象、同 requestId、未取消及 Runtime waiting_window/sourceActionId 一致，旧 Run 晚结果不能污染新 Run。deadline 信号与取消组合，Promise.race 即使底层不响应信号仍返回，finally 清 timer，Abort listener 清理，迟到 reject 由 race 接住。

独立必要三个增量 3/3 通过：延迟刷新前不发布暂态空 request、成功候选随后发布；失败空 handoff 有正常 abort；abort 后取消旧查询、旧结果晚到不污染新 Run。55/55 整文件为作者报告。15 秒 deadline、ignore/new-request 取消由本次源码核查，未另跑专门 deadline 实时或手机测试；真实 HTTP/Relay 手机渲染体验不以这三项 mocked API 测试替代。未修改业务代码、未 build/dist、未 GUI 输入或额外 API；只更新审计文档并验证 UTF-8。

### 原生窗口发送后 unknown 与同 Surface reconfirmation 审查

GO，可进入真实任务验收，未发现剩余阻塞项。CUA foreground_unavailable 没有明确 no-input 证明时，普通 native root 动作返回 partial/ACTION_OUTCOME_UNKNOWN，不伪造 retry-safe refused；result 和 thrown Tool 两路一致，旧 Observation 私有引用立即失效。明确 no-input 仍保持原 refusal。强 owned child 使用既有 parent/sibling 恢复契约；新 peer 仍须正常 Host handoff 选择，不凭 unknown 自动换窗；没有可信目标恢复证据时 Runtime 发真实 user.input.requested 并 waiting_user。

native_surface_reconfirmed producer 只在完整未截断 Win32 快照、完整 pre-action baseline、同一 current executable SurfaceRef、精确 PID/HWND、稳定几何和 exact foreground 成立且没有待交给 Host 的候选时给 hint。源码 producer 此处提供 fresh native identity/geometry/foreground proof，截图由 Runtime 随后的标准 observe 捕获，不把 producer 描述为已经截图。Runtime 要求 hint 与执行 SurfaceRef 全字段相等，再要求 fresh observation 同一 ref 且无 transition；不匹配不能进入下一模型 turn。action/tool failed 与 unknown_side_effect 继续持久化，旧 batch 后缀被拒绝；恢复不升级旧动作 completed，不跳过原权限、Abort、预算和 inbox 流程。

私有 replay guard 在同一 Surface scope 记住不确定 primitive：不含 actionId/basedOn，对象键递归稳定排序（保留数组顺序），防止改变顶层或 point 属性顺序绕过同动作限制。wait、failed/refused/partial 替代动作均不解锁；只有不同 GUI primitive completed 后的新 observe，或真实已验证 Surface/generation 改变才解除。此次审查收口两个小问题：原 JSON.stringify 的键顺序依赖已修并用逆序字段测试；generic ACTION_OUTCOME_UNKNOWN 无 recovery hint 时的 runtime.error 也改为 unknown_side_effect，不再误标 partial_side_effect。未新增应用特例或 public 协议里的私有指纹。

独立必要首轮 8 项通过，最终两小修与原有明确 no-input/普通 partial 边界复跑 5 项通过，去重合计 10 个相关 case。覆盖 result/thrown Tool、旧 action 失效、同动作逆序字段拒绝、wait/失败替代不解除与完成替代后 fresh observe 解除、foreground 变化不能 reconfirm、hint/capture mismatch、真实 user barrier 与 peer Host gate。367/367 三包与四项目 tsc 为作者报告，未计作本审独立整包验证；没有 GUI 输入、额外 API 或 dist build。真实 SDK 发送后前台变更、WPS 后续完整任务与人机继续体验仍需真实 receipt/截图验收，不把 source GO 当 task success。

### ignored 验收 runner 文件控制审查

最终收口 GO：root 授权的最小 runner 修复已完成。task finally 通过 detachOperatorControlIfTerminal 仅断开未启动或已终态 handle；abort 失败仍 active 时保留原 exact handle 的文件控制，录像依然在 nested finally 收尾。outer 保留等待不再一小时后提前退出，直到 Run 真正终态，再断开控制；等待不重放 GUI 动作、不改 unknown 或 owner lease。此段取代下文初审的待修状态。

新增异常自测独立通过：pause/resume accepted，第一次 Remote abort 失败后队列仍连接且 ack failed，第二次 abort 正常完成并确认 owner released；终态 detach 后再追加 pause 不产生新 ack。node --check 通过，runner UTF-8 读回干净。证据 runs/diagnostics/full-popup-task-acceptance-20261004033410124-f97076cd/control-queue-selftest.result.json。仅修改 ignored runner 与本审计文档，未 commit、未 build dist、未 GUI 输入或真实 Remote Run。

正常路径 GO，异常仍 active 路径待收口。每次运行使用新的 diagnostics 目录和 wx 创建的 task 专用 queue/ack 文件；闭包绑定已核验 started.runId 的 exact handle/device，逐行 serial promise 排队，只有 pause/resume/abort 走正常 Remote API。每次获取当前 sequence，只有 STALE_SEQUENCE 重取重交；非法和非 ASCII 行逐条拒绝并 ack，不改 Run 事实。Abort 单 handle 去重并等待真实终态与同 runId owner released，未确认时失败，不伪造释放。waiting_window/handoff 不盲选，正常 Remote abort 后等 cleanup；recorder 在 detach 的 nested finally 中收尾。

独立执行一次 --selftest-control-queue，accepted pause/resume、abort owner released、非 ASCII 拒绝、window wait predicates 全部通过；GUI/model 未启动。证据在 runs/diagnostics/full-popup-task-acceptance-20261004033134205-c4a75823/control-queue-selftest.result.json。代码 source 核查串行、exact handle 与 stale sequence 重取边界；本次 selftest 没有模拟 stale conflict 或 abort failure，不声称这些已执行通过。

发现一个异常控制入口缺口：task catch 的 abort 若抛出且 Run 尚 active，task finally 仍 detach 文件控制；outer catch 随后 keepSessionOpen 与 waitForOperatorOrTerminal，但未重新接入文件控制。stdin 已不可靠时该未终态 Run 会失去这次新增的操作入口。应只对未终态 exact handle 保留或重新接入同一文件控制，终态后 detach，录像照常收尾；不能因此伪造 cleanup、业务 outcome 或擅自清 lease。已向 root 报告，待最小修复或明确异常外部恢复边界。

### Task2 初始观察弱 owned candidate 最小调整

GO，可进入真实 Task2；此结论替代前文 initial helper 对 query-failed/unparseable 一律硬失败的旧边界。完整可信 Win32 快照中的 owner/z-order 只是候选关系，不足以证明任意辅助 HWND 阻塞已验证 parent。exact-root unavailable 且没有显式身份 contradiction 时，无 exact child foreground+owner 正向证据就保留 parent 并将弱候选留在 Registry 外；不按应用、标题或窗口尺寸过滤，也不宣称 child 已消失或 UIA 普遍可用。后续输入仍使用原有精确前台拒绝规则，并非父窗继续观察就授权输入到其他窗。

若 root 不可用但完整 Win32 明确 exact child foreground 与 direct owner，则沿已有 relationship evidence 准入：成功 exact capture 后再读取完整快照，重新验证同一 parent/current Surface、child 身份/几何/owner、唯一 stack 及 exact foreground，才 child_push。捕获期间前台变化拒绝，不提交 child。正向 Menu/Popup/Dialog root 路径与显式身份 contradiction 拒绝保持不变；capture/revalidation 失败仍显式失败，而非虚构 manual consumer。

本次独立仅必要 pattern，7/7 通过：三个新增分支和四个 initial root/capture 不可用变体；191/191 整文件为作者报告。未 build dist、未 GUI 输入或调用外部 API。真实 WPS 父窗继续观察与后续完整 Task2 效果仍待真实 Harness 验收，不能以 source GO 宣称任务成功。

### 默认关闭公开 grounding 时 multiline 私有证据审查

GO，可进入真实 Task1 后验。仅 Windows multiline 在当前 Observation 缺少私有 grounding 时，对精确 action window 按需读取 UIA；结果只绑定本次 Observation/session/Surface/binding，不发布 catalog、工具或新 groundingRef。查询后重新验证同一 Observation、Surface generation/parent/admission、窗口身份与几何；原有唯一编辑目标、prevalue、token/snapshot、精确输入目标、同调用 read-back 和未知结果不重试规则保留。

本审提出的两个生产证据缺口已修：私有只读查询加入 2.5 秒本地 deadline、独立请求 AbortSignal 与 Promise.race，timer 与 caller listener 在 finally 清理，迟到 query rejection 已接住；不会取消调用方。超时内部 catalog 返回 unknown/degraded，最终 ActionReceipt 是 refused，且没有发送 type_text，不是未知输入副作用。另复用显式身份 mismatch 检查，响应明确携带不同 PID/HWND（包括 root_surface）时清空私有证据；SDK 未携带这些字段时不凭空拒绝原有合法响应。

独立首轮五项 private multiline 增量通过，最终仅复跑邻窗身份与 timeout 两项，2/2 通过，共七个不同相关 case；188/188 整文件与 package build 为作者报告。未 build dist、未 GUI 输入、未消费外部 API。2.5 秒查询预算尚无本轮真实窗口时延依据，应在实际 Task1 看 receipt 是否超时再决定调整，不把 mock 通过当成实机可用性证明。精确请求 PID/HWND、同 token/snapshot 已验证，但真实 SDK 的邻窗 token 拒绝行为未独立实测，不宣称已有该后端保证。

### 配对手机 candidate preview 集中审查

本节为原审查基线。2026-10-07 后续增量已将 raw／wire 限额统一为2MiB／3MiB；最新实现与验证见[当前整改入口](./window-popup-regression-2026-10-04.md)。以下1MiB／2MiB保留作当时证据，不是当前合同。图片成功解码也不等于软件已判断不同候选的画面足够可辨认，真实CUA候选仍须分别验收。

GO，无剩余已发现 P1；真实手机体验尚未验证。Web 只在用户点击具体候选时读取预览；初始候选和 handoff 分别绑定 device 的 opaque candidate token，以及当前 Run owner/requestId/candidate。Host 使用配对 cookie、CSRF 和捕获后 session revalidation；HTTP 与 Relay 路由只接受限定字段，不允许直接传入任意 PID/HWND。proof token 有效期两分钟，初始 proof 不超过候选列表有效期；刷新、候选或请求 token 改变会清除旧图与选择。预览前后核验同一精确 PID/HWND，允许 partial inventory 中的正向精确身份，不推断全局 absence。随后真正选择仍走原有精确 native verification。

预览使用临时只读 CUA session，不激活、不发输入、不创建 Surface/Run Observation 或资产；图片不进入模型上下文、轨迹或持久化文件。capture 信号上限 8 秒，cleanup 信号 5 秒；取消排队请求不新建 driver，清理失败保留待清理状态而不返回可确认图片。raw PNG 上限 1 MiB、Host/Relay JSON route 上限 2 MiB，并校验 PNG signature、canonical base64 和有界 viewport。Host 从鉴权之前就设置 no-store，包括错误响应；Relay 也使用 no-store。

人机确认必须等对应图片成功 load 后才开放；损坏图片、过期 proof 保持不可确认，并真实标注捕获时应用/标题、时间和关系，缺元数据不冒用旧候选标题。软件没有自动判定“图片内容可区分”的能力，看不清时不应确认；不能把加载成功当作该语义已验证。requestId/run/candidate token 改变在 layout effect 中立即清旧图，防止先绘制过期截图。本审发现并由 UI 作者修复一处不一致：handoff 重读同一候选时曾保留旧已加载截图和确认按钮；现在与 Home 一样，开始重读即清旧图/loaded/error 状态，pending 或失败均不能凭旧图确认。

独立仅 preview/paired 请求 pattern 加遗漏的关键负例，34 项通过；包含实际本地 Host HTTP→Relay WSS 往返，但截图与手机 UI 仍为测试夹具，并非原生 CUA 加真实配对手机实测。覆盖 token/TTL/owner/request、CSRF/revocation、route bytes bound、partial exact identity、post-capture identity 消失、取消/cleanup、图片 load gate、缺元数据/失败图片、request token 清图，以及重新读取失败不留下旧确认。134/134 九文件与 scoped noEmit、后续 UI/Host 小回归均为作者报告，未计为本审独立整包验证。未 build dist、未 GUI 输入、未调用外部 API。实际手机触摸/解码、原生窗口捕获质量和网络取消延迟仍待真实验收。

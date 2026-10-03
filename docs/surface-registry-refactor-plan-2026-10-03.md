# SurfaceRegistry 重构审计、设计与迁移计划

日期：2026-10-03。状态：架构方案，等待当前 CUA 多行输入实施线结束后再进入代码迁移。范围：在一个 ComputerSession 内管理多个原生窗口、临时菜单/弹窗、Harness-owned managed-browser 窗口、tab 与 DOM 文档；本文件不批准真实桌面、真实模型 API 或录像验收。

## 决策摘要

跨应用选择目标与临时弹窗需要同一个 Surface 生命周期模型。保留一个 Run、一个 ComputerSession 和一份 CUA daemon lease；在该 Session 内维护多个 Surface、一个 activeSurface 以及可验证的父子关系。模型显式切换平级 Surface；只有证据完整的临时子 Surface 才自动 push，关闭后 revalidate 并 pop 回父 Surface。窗口改变、弹窗出现或切回浏览器都不重开 ComputerSession，也不更换 ComputerSessionId。

首版用进程内、纯状态的 SurfaceRegistry 作为事实来源。它接收经过校验的发现/捕获/关闭证据并输出有限状态转移；不调用 CUA、不做异步 I/O、不持久化业务文件，也不引入服务端 Registry、分布式状态、租约协调或通用窗口代理层。CUA、Runtime、Protocol/Trajectory 仅围绕此状态机接线。

安全不变量：活动 Surface 身份或代次不确定时不得派发 GUI 输入；Surface 切换/弹窗出现不会使旧截图、坐标、元素或审批自动迁移到新 Surface；除驱动明确证明没有投递输入的拒绝外，未知副作用不重试、不回放，Run 以 outcome_unknown 结束并 Abort 当前工作。

## 现状审计

本节依据 2026-10-03 的只读代码快照。当前 worktree 有大量并行未提交改动；CUA 驱动文件正在被另一实施线编辑，以下是当时读取到的事实，开始迁移前必须对照实际合并结果重核，不将此文档视为锁定中的完整代码差异。

| 关注点 | 当前实现与风险 |
| --- | --- |
| 跨窗目标列表 | CUA 私有会话以 windowBinding 保存一个当前 PID/HWND；listWindows 通过 listWindowTargets 生成 opaque windowRef，当前列表引用由 Adapter 私有 Map 解析。普通 Observation 不刷新引用；刷新目录、切换、Run 结束或目标丢失会清理引用。见 [cua-driver-computer.ts](../packages/computer-cua/src/cua-driver-computer.ts) 中 PrivateSession、listWindows 与 transitionWindow。 |
| 跨窗切换 | transitionWindow 复用同一 driver，但切换成功后递增 handoffGeneration、清空 Observation/Grounding 并构造新的 ComputerSessionDescriptor.id。Runtime 将新的 descriptor 当成切换后的 session；Trajectory 对 sessionAfter 强制要求新 ID。生命周期实际复用而逻辑 ComputerSession 却被伪装成多个 session，正是要消除的分层冲突。 |
| 原生绑定与引用 | windowBinding、windowIdentityInvalidated、可见窗口 baseline、切换引用及 handoff 候选均堆在 PrivateSession；失效通过 clearTargetObservationState 清 Observation/Grounding、候选和 transientMenuSurface。大文件现同时承担 CUA transport、身份校验、坐标映射、Grounding、handoff 和状态机职责。 |
| 临时菜单/弹窗 | transientMenuSurface 只表示一个新出现的独立 HWND popup；observe 可能对它单独 capture，执行前重验父窗可见、popup 唯一 frontmost、bounds 未变。完整的新增窗口探测只在动作已 completed 后进行，并且最多短轮询一次。 |
| MenuItem 误分类点 | verifyTransientMenuSurface 取候选 HWND 的 bounded get_window_state，但通过对 elements 任意后代的 some(role === menu/menuitem/popup...) 来判定该独立 HWND 是菜单。后代 MenuItem 不能证明这个 HWND 的根 Surface 是菜单，也不能证明树没有从别的 root/window 混入节点。迁移必须改成按精确 HWND 返回、结构完整的 root-role/owner 证据分类；缺失就保持 unknown，不能靠 title 或任意后代补证。 |
| HWND 证据 | window-contract 的 CuaWindowInfo 可含 zIndex、ownerPid、ownerWindowId；字段可缺失。现有 transient 辅助检查看前台排序且要求 ownerPid 等于父 PID，但 ownerWindowId 缺失目前可被接受；窗口树 root 身份与层级 schema 没有强制合同。缺失证据不适合推断临时 child。 |
| 同 HWND 菜单 | 目前窗口差分只发现新增 HWND，因而同 HWND 的原生菜单 overlay 不会成为独立 transientMenuSurface。新设计应将它表示成同 HWND 的子 overlay/interaction layer；实际 action 仍走父窗口精确 HWND 与观察的物理坐标映射。 |
| Observation/Grounding | Adapter 私有 Observation 记 sessionId、viewport、geometry 和可选 transientSurface；UIA/DOM refs 记观察引用、几何和 managed Browser target，但没有通用 SurfaceId/generation。协议 ObservationFrame 只有 ObservationId、ComputerSessionId、viewport、截图与可选 Grounding。切换借助换 session ID 清理旧引用，而不是显式绑定 Surface incarnation。 |
| Managed Browser | ManagedBrowserTarget 私有含确切 windowTarget、tabId、generation、profileId 与 delivery；Host 对 Run 自有浏览器才提供 DOM。DOM 采集结果把当前 tabId/generation 合入 target，但窗口、tab、DOM 文档不是统一层级对象。切到 native 关闭 DOM 来源，切回重新采集的安全原则已经存在，应在新 Registry 中保留。 |
| Runtime/Trajectory | switch_window 是独占 GUI action，Runtime 校验新 sessionAfter、重置执行/观察上下文并提交新帧；Trajectory 的 computerSession 被切换 receipt 替换。自动 handoff completed 也以新的 ComputerSessionDescriptor 表示。Monitor 当前用 session/viewport 等证据分区；Guard 和 ApprovalEvidence 主要绑定动作、Observation、截图资产和 viewport，未绑定 Surface generation。 |

现有可复用路径包括精确 PID/HWND discovery、一次 activation、fresh capture、Abort、target allowlist、旧 Grounding 失效、managed-browser 所有权 gate、action unknown-side-effect/no-replay，以及大量既有 stale-reference 回归。它们迁入 Registry 时应保持语义，不复制成第二套状态。

## Surface 数据合同

SurfaceRegistry 是 ComputerSession 私有状态。公开/轨迹只投影不泄露 OS 句柄的 SurfaceStamp，不将 PID、HWND、CDP、profile 路径、UIA token 放入 Provider Context、公共 Runtime event 或移动端报告。

| 字段 | 含义与责任 |
| --- | --- |
| SurfaceId | Run 内 opaque、不可由模型构造的稳定逻辑身份。由 Registry 在确认一个逻辑节点后分配；native HWND 重用且可证明已是新 incarnation 时，旧 ID 进入 destroyed，新身份分配新 ID。 |
| generation | Surface incarnation/坐标语义的代次。SurfaceId 不变而窗口内容身份、tab/document generation 或有效几何重建时递增；所有私有/公共引用同时绑定 ID 与 generation。generation 不因普通截图 repaint 增长。无可验证的新 incarnation 证据时不得复用旧 generation。 |
| parentSurfaceId | 交互/呈现树的父节点：popup/dialog 归属于开启它的 native window/menu；browser tab 属于 browser window；DOM document 属于 tab。不存在已证明的父关系时省略，不从标题、进程名或层级缩进猜测。 |
| ownerSurfaceId | OS/Host 所有权关系的映射，要求来自 exact owner PID/HWND 或 Harness Host attestation。它与逻辑 parent 可相同，也可为空；父关系不等于拥有关系。 |
| modal | Registry 的交互阻塞语义，不是从单一 OS style 位直接复制的事实。可取 none、blocks_parent、blocks_owner_scope、unknown；unknown 不产生自动 parent pop/push 决策。菜单一般只遮挡局部，不默认当作应用级模态。 |
| kind | 受限枚举：native_window、native_menu_overlay、native_popup_window、native_dialog、browser_window、browser_tab、dom_document。没有足够根角色/关系证据时用 unclassified_native_surface，并维持 fail-closed 行为。 |
| status | discovered、active、inactive、closing、destroyed、unknown。active 只允许一个叶子 Surface；unknown 禁止输入。inactive 子项可在后续 fresh discovery 后重新选中，但必须通过当前一代验证。 |
| activeSurface | Registry 当前唯一活动叶 SurfaceStamp。坐标截图还需解析它的 capture ancestor（最近的可 capture native window）；DOM 动作解析 document/tab surface。派发前两条路径都必须属于活动 lineage 且代次匹配。 |

最小逻辑形状：Run 中可有多个 peer 根，临时 Surface 挂于明确 parent；browser tab 与 DOM document 使用相同 SurfaceStamp 规则。一个 Observation 可附 active SurfaceStamp 和从 capture ancestor 到 active leaf 的 lineage stamps，避免把“窗口截图”和“其中当前 DOM 文档”误写为同一个身份。Registry 私有保留精确 OS 绑定与证据，公共 lineage 只含 opaque ID、generation、kind 及必要的经过脱敏显示标签。

## 产生、消费与失效

| 数据/状态 | 生产者 | 消费者 | 失效/清理时点 |
| --- | --- | --- | --- |
| SurfaceId、generation、parent/owner、kind/status、activeSurface | 新的纯状态机 SurfaceRegistry；只接受 CUA/Host 已校验的 evidence event，不做 I/O 或自行猜关系。 | CUA Computer 的 capture/action resolver；Runtime 的 active Surface projection 与权限检查；Trajectory reducer 及 UI 的脱敏状态显示。 | hwnd/process incarnation 变化、精确目标消失、owner 关系不符、几何导致坐标空间失效、tab/document generation 变化、child 关闭、scope 撤销、Run close。销毁记录保留到 Run replay 可解释，但私有能力和 action refs 立即撤销。 |
| Surface/window opaque refs | Adapter 根据当前 allowlisted inventory 生产；Runtime 只投影引用和有限标签。 | 单独一轮 switch_surface 解析为私有 SurfaceStamp。 | 刷新同类目录、Surface generation 变化、目标删除、Host scope 更新、Run end 时撤销；一般 capture 不自动撤销 peer refs。 |
| Observation 与截图 Frame | Computer 在 Registry 当前 active lineage 上 fresh capture；Runtime 持久化截图并记录 SurfaceStamp、generation、capture ancestor 与 viewport。 | Provider Context、coordinate/DOM action preparation、approval review、Monitor、Trajectory。 | 后续帧不改变历史帧事实，但任何 active Surface/lineage generation 变化都使其不再可作为 dispatch frame；不跨 Surface 转换坐标。 |
| UIA/DOM element ref | Grounding collector 基于 exact Observation 与 exact root/tab/document 生成 opaque ref。 | Runtime 验证器和 CUA action dispatcher 二次验证 ref；driver token 仅留 Adapter。 | 新 Surface generation、document/tab navigation、重采集 Grounding、window resize/move 或候选指纹变更；旧 ref 不可因回到同一 Surface 而复活。 |
| active/native binding 与动作目标 | Adapter 从 Registry 取活动 leaf 并解析精确 capture ancestor；DOM 目标由 Harness-owned Browser Host 绑定到 tab/document。 | 每种 CUA 工具请求。 | 每次 action dispatch 前 fresh inventory/geometry/owner/tab 复核；身份不符将 Surface 标 unknown 并禁止输入。 |
| Guard/approval binding | Runtime 从已准备 Action 和其 decision Surface/Observation 构造；ApprovalEvidence 指向复核截图并含 SurfaceStamp。 | Guard、Host/Web/TUI 审批面板、批准后 execute 验证。 | 审批前/等待期间 active generation、截图坐标空间或 DOM document generation 变化，必须撤销审批并要求重新提案；不得把批准继承到相邻窗或 child。 |
| Monitor/Trajectory projection | Runtime 事件提交与 reducer 从事件流重建；唯一活动态以 surface transition/captured observation 共同确认。 | Stall/repeat Monitor、报告、回放与恢复。 | 不删除历史证据；按 SurfaceStamp 分区。Session close 清理 Registry 私有句柄，但 trajectory 保存末态及失败原因。 |

清理分两层：只撤销当前 Surface 作用域的 Observation/Grounding/action refs；不丢失同一 Run 的 Plan、run-scoped Memory 或此前 Surface 的已提交事件。缓存可留作只读历史，但 action resolver 必须要求当前 active SurfaceStamp、Observation lineage 与引用 generation 全等。Session close 时一次性销毁全部私有 binding、refs、Grounding、临时 surface state 和 CUA lease。

## HWND menu、独立 popup 与证据门槛

classification 不能把 UIA tree 中任一名为 MenuItem 的后代等价成 window 根 Surface。`verifyTransientMenuSurface` 当前的 `elements.some(role)` 检查是需要替换的分类依据，不是可以原样搬进 Registry 的合同。

| 场景 | 必需证据 | 目标表现 |
| --- | --- | --- |
| 同 HWND 菜单 overlay | 当前 active native Surface 精确 PID/HWND；UIA/driver 能把 popup/menu root 节点归属到此 HWND，且给出可核对的 root/overlay identity 与新鲜几何/可见状态。普通 Window root 下出现一个 MenuItem 后代不够。 | 新建同 HWND 子 overlay Surface，native identity 与 parent 相同；capture/action 仍精确绑定父 HWND，但 Observation lineage 标注 overlay。关闭后 pop 回父 Surface 并 fresh capture。若 driver 无法独立给 overlay root/坐标 evidence，则不注册 overlay Surface，按普通父窗视觉观察处理。 |
| 独立 HWND 菜单或 popup | 当前父 PID/HWND；本动作之前/之后窗口差分；候选精确 PID/HWND 唯一；候选 owner 精确指向父窗口（PID 与 HWND 都须有）；visible 且 zIndex 已知、全体可比较且 candidate 是唯一最前；对该 HWND 的 bounded window state 证明完整 exact root role 属于 Menu/Popup/MenuWindow 类；capture geometry 与窗口 identity fresh。 | 分类为 transient child 并自动 push；禁止出现在平级 peer picker。遗漏 owner、owner HWND、排序、root role、树完整性或身份任一证据时，不能 auto push。候选最多留作 unclassified/手动确认或由策略拒绝。 |
| 独立 HWND dialog | 与 popup 相同的精确 HWND、唯一 owner、z-order、窗口差分、完整 exact root role；Root 必须是 Dialog/AlertDialog/FileDialog 等经允许列表认可的角色。 | 仅精确 owner/Host scope 下自动 push；否则保持未分类候选，不按窗口标题包含“保存/打开”推断。 |
| 无 owner、跨不明进程、已有窗口或多个 frontmost tie | 身份存在但 ownership/层级/唯一 topmost/root evidence 缺失或矛盾。 | 不自动成为 child、不静默激活。只有 Run 的显式 peer opt-in / Host 精确 scope / 用户确认路径可以将其作为独立 peer 处理；缺少 peer 授权时 fail closed。 |

证据通用条件：list_windows/discovery 精确匹配一条 PID/HWND；driver capture 回报 identity 必须仍是所请求 HWND；accessibility/tree 请求参数需含该精确 PID/HWND；结果应回显 window identity 或通过可靠 per-window envelope 保证绑定；窗口 owner 要求 PID 与 HWND 成对相等；frontmost 的比较集合必须完整且 z-order 无缺失/平手。标题、appName、同进程、出现顺序都只能做说明信息，不能替代结构证据。

如果当前 CUA 版本无法证明上述返回值按 exact HWND 隔离，不能通过调整 role 关键字来“解决”；先扩展/修正 driver evidence contract 与 fixture。测试应证明 unrelated window 的 MenuItem、浏览器页面 role=menu、非 root MenuItem 后代、截断树、ownerWindowId 缺失与 z-order tie 均不会误判为临时根 Surface。

## 显式 peer 切换与自动临时 child

显式 peer：保留现有跨应用 opt-in 和 Host `windowSwitchAllowedTargets` 权限，建立 peer Surface inventory 与 opaque SurfaceRef。一次 `switch_surface` 独占当前 ModelTurn；只解析最近有效列表的 ref，按当前精确 PID/HWND 重新 discovery，再按 foreground 模式至多 activation 一次，随后 fresh exact capture。切换更新 Registry.activeSurface，但不 reopen/end/start ComputerSession；Runtime 随后必须持久化新 Surface observation 才允许下一个 model decision。窗口 title/app 名是动态、非可信输入，不能授权窗口操作。初版可保留 `list_windows/switch_window` 名称作为兼容工具映射，但其结果必须映射至 SurfaceStamp；不得继续通过伪造 sessionAfter 编码 target。

自动 child push：仅对在一次已 completed 动作之后出现且满足上一节全证据门槛的 owner child 自动 push。completed action 永远只执行一次；push 是后续只读 discovery/capture 的结果。全新 peer、跨进程不明窗口、已有窗口不因位于前景就自动 push。它们沿用既有显式 peer list/switch 或 Host confirm handoff，不能同时触发自动切换和手动 handoff。

自动 child pop：fresh inventory/root evidence 证明 child 已关闭/隐藏，或 child 显式关闭动作 completed 后验证 child 不再可见，才 pop。Pop 之后先复核父 Surface 精确 identity、owner/window presence、geometry 与 browser lineage，再捕获父帧；帧提交成功前不继续 Provider。父 Surface 丢失、身份换代、capture failure 或证据不完整时 activeSurface=unknown 并结束/等待用户处理，不猜测返回目标、不 replay 原 action。对阻塞型 modal，首版不允许从未解决 modal child 直接切到任意 peer；先 dismiss/pop，或走用户显式处理/abort。

对同 HWND menu overlay，push/pop 只改逻辑 active leaf，不调用 bring_to_front，也不伪造 HWND。若 overlay 没有可靠 capture/action geometry，则不切活动 leaf，让普通父 Surface 处理/请求更强观察；不得将任意根窗口 bounds 当菜单 bounds。

## Browser window、tab、DOM 层级

```text
ComputerSession（一个 per Run 的 CUA driver/lease）
├─ Browser native-window Surface（精确 PID/HWND）
│  ├─ browser-tab Surface（Host attested tabId + tab generation）
│  │  └─ dom-document Surface（navigation/document generation）
│  └─ 同 HWND browser/native chrome menu overlay（如能被精确证明）
├─ WPS native-window Surface
│  └─ owned native dialog/popup child（精确 owner relation）
├─ Notepad native-window Surface
└─ Explorer native-window Surface
```

Browser native-window 管理截图和坐标输入；browser-tab 身份来自 Harness-owned ManagedBrowserHost；DOM document 是 DOM ref 的实际身份域。Observation 同时绑定 capture window 与 active tab/document lineage。UIA 的 native Document/contentRect、DOM CSS viewport metrics、tabId 和 document generation 必须来自同一 Observation；DOM 坐标必须继续走现有可信 contentRect 与物理坐标校准，SurfaceRegistry 不放宽几何合同。

仅在 Host-owned browser target 与确切 native HWND 匹配、profile/lease 仍有效时建立 browser-tab/DOM Surface。不能因为标题含 Chrome/Edge、进程名或网页可访问就创建 managed DOM Surface。tab 切换、page navigation、目标 target change 或 Host generation 更新都会使文档 Surface generation 改变并清除相关 refs；切离后 DOM Surface inactive，切回时必须通过 Host 重采 active tab/document 并重新 Grounding。不得因回到同一个 window Surface 就恢复旧 tab/DOM refs。

当前 ManagedBrowserHost 面向一个经过 attestation 的启动窗口/活动 tab。多 tab/tab picker、浏览器新窗口映射和跨 tab ownership enumeration 要等 Host 提供 exact window↔tab 关系和可复现测试后再开放。此前仍只暴露一个已认证 DOM leaf；其余 tab/window 保持 native 可视 peer 或 unknown，不由 Registry 猜测。Browser popup 若被 Host 明确证明是其自有 window/tab，可挂 browser owner child；没有证明则走普通 native unclassified/peer 规则。

## Observation、action、审批、Guard、Monitor 与 Trajectory 绑定

1. Protocol 增加公共 SurfaceStamp（opaque surfaceId + generation + kind）及经脱敏的 lineage 描述。ObservationCapture/ObservationFrame 记录 active leaf 与 capture ancestor；GroundingCatalog 和元素 refs 同一代次绑定。ComputerSessionDescriptor 只描述稳定 session 与 capability，不承载动态当前窗口，也不因 target 变化重建。
2. ActionIntent 对所有 GUI action 持有 basedOn ObservationId；Runtime 由该帧解析 SurfaceStamp，在 prepared action 私有上下文冻结 `sessionId + activeSurfaceId + generation + observationId + viewport/geometryRevision + optional tab/document generation`。发往 CUA 前再次要求 Registry 当前 active lineage 完全匹配。旧帧跨 surface、旧 ref 跨 generation、旧坐标跨 geometryRevision 一律在 driver call 前拒绝。
3. GroundingElement public ref 继续 opaque；Adapter private ref map 增加 SurfaceStamp、ObservationId、geometryRevision、tabId/document generation。Runtime 验证外层 catalog 与 Observation 的 surface lineage 一致；Adapter 再检查当前 Surface 并解析 raw UIA token/DOM fingerprint。Raw PID/HWND/token/CSS identity 仍不发给 Provider。
4. ApprovalEvidence 增 decisionObservation 与 execution/evidence Observation 的 SurfaceStamp、generation、asset、viewport。审批屏展示 exact evidence frame 的脱敏 Surface 标签。等待用户期间任一 Surface/geometry/tab generation 改变、窗口外部切换或截图 lineage 失效时，清掉 pending approval 并拒绝原 ToolCall；获批后 execute 再核 exact evidence binding。Approval 是对 exact action+frame 的许可，不可转移。
5. Action Guard 在当前 action proposed/preflight 处拿冻结的目标 SurfaceStamp 与 Surface kind。Guard event 增 surface binding，使事后审计能解释审批针对 WPS/native dialog 还是 browser document。模型声明 effect 仍是不可信的业务意图描述；不能以 surface label 替代 effect 风险评估。
6. Monitor 的 action repeat/A-B-A/failure 统计按 Run、SurfaceId、generation、viewport/geometryRevision 分区。同一动作字符串在 Browser 与 WPS 各执行一次不构成一个循环；跨 Surface 切换后的 screen change 不是前 action 的因果进度。monitor.transition 的 pre/post Observation 要包含可比较 surface lineage，否则 transition=unknown 并不生成 no-progress 强结论。
7. Trajectory 把 Surface discovery/transition/invalidation 作为 reducer 可回放事实。建议新增窄事件 computer.surface.transitioned（cause 为 peer_selected、verified_child_opened、verified_child_closed、surface_invalidated、browser_generation_changed；含 from/to SurfaceStamp 和 source action/observation refs）；观察事件自身写 Surface lineage。Reducer 验证 transition parent、generation 单调、active 唯一、action basedOn 属于 transition 前 active Surface、post frame 属于 transition 后 active Surface。不要再把 `computerSession` 替换成一个新 descriptor 来代表 Surface。
8. 为读旧事件保留 bounded compatibility：没有 SurfaceStamp 的历史轨迹视为 legacy 单 Surface generation；只读回放时可以投影此虚拟 Surface。新 Run 必须写明确 SurfaceStamp，不能把 legacy stamp 用于新 action。同步 zod schema、eventType 列表、snapshot reducer、reporter/approval preview/voice/relay/mobile event projection 和协议 fixtures；event 读写不认识的新字段不得静默丢失。

## Abort、未知副作用与生命周期

在任何 CUA 操作、窗口 discovery、activation、capture、树查询、DOM transport 和 managed Host 回调前后检查 AbortSignal。状态机的纯 transition 可同步完成，IO orchestration 必须把 Abort 作为禁止后续步骤的边界。若 activation/capture 已开始后 Abort，当前 Surface 进入 unknown；不自动切回 parent、不再次 activation、不对输入动作重发。

只有驱动结构化返回明确 refused 且携带 no-input proof 时才可记录 refused 并执行被授权的人工 handoff；通用异常、transport 断线、Abort、degraded/partial 或含糊 foreground 错误按可能已经产生副作用处理：保留 unresolved action，Runtime 记 unknown_side_effect、run outcome_unknown、Abort tool loop。当前 `executeMultilineType` 的分段输入也不能在被中断后续写；调用已派发后无自动继续。

Surface identity 不确定时 Registry 可保留 last-known active 供日志说明，但必须附 status=unknown；它不代表仍然可输入。后续用户恢复是新 ComputerSession/新 Run 的明确重开，不在未知副作用的旧 Run 中自愈或重放。ComputerSession close/managed browser cleanup 仍沿用现有 bounded cleanup/owner lease 规则且只执行一次收尾链。

## 迁移顺序

1. **纯状态机先行**：新增独立的 surface-types、surface-registry、surface-evidence 与对应 test 模块；用手写 evidence 值定义最小契约，禁止从 cua-driver-computer.ts 复制一份业务逻辑。明确 transition 的总表、generation 规则、失效行为以及 unknown 吸收态；此步不改 GUI adapter/runtime。
2. **协议最小扩展**：在单独 surface contract module 声明 SurfaceStamp/lineage/transition；将必要类型从既有 barrel re-export。Observation、Grounding、Approval、Guard、Monitor 和事件 schema 的字段最少化；明确从旧轨迹读到新 trajectory 的兼容策略。避免把 reducer/helper 新逻辑继续追加在大型 protocol/index.ts、trajectory/index.ts。
3. **Computer API 稳定 Session**：引入 `listSurfaces`/`switchSurface` 或让现有 `listWindows`/`switch_window` 作为兼容 facade 转换成 Surface refs。成功切换返回新的 activeSurface 事实，禁止 sessionAfter/new descriptor ID。computer.open 一次、CUA startSession 一次、computer.close/endSession 一次；`ComputerSessionId` 在所有 peers/children/observations 中一致。
4. **CUA 适配器迁移**：先迁 peer inventory/switch，复用 listWindowTargets、exact target capture、bringWindowToFrontOnce、host allowlist 和窗口 capture retry；再替换 windowBinding/transientMenuSurface/handoffGeneration/baseline maps 为 Registry。分离 evidence parsing、state transition、coordinate binding、Grounding 与 CUA command orchestration；保留已有 stale-frame、identity-latch、partial cleanup 行为。编排文件只做 IO 与类型适配，不承载状态机细节。
5. **Runtime/Trajectory/Guard/Monitor**：替换 `sessionAfter`/`resetAfterTargetTransition` 的 session 替换语义为 Surface transition + 对新 active lineage 的 fresh observation。修改 reducer、schema、action preparation、approval lifecycle、Monitor partition、Context projection、reporting。保留 switch 独占动作轮次与现有 opt-in/allowlist；child push/pop 是已完成动作后的只读 postcondition，不是第二次模型 GUI action。
6. **经证据打开自动 child**：默认先支持独立 HWND 的 owner dialog/popup 和独立验证的同 HWND overlay；没有 CUA root-role/owner/zorder contract 的后端保持 child auto-detection off。未经 fixture 定向证据，不扩大到任意新窗口/跨进程/系统 dialog。
7. **Browser lineage**：首先只把当前 ManagedBrowserHost 已 attested 的一个 tab/document 接入 Surface lineage，验证 native round trip 后重新收集 DOM。之后若需多 tab，作为独立增量：扩展 Host API 到 exact tab/window inventory、每个 tab owner 和 page generation，再加对应 test。个人浏览器 DOM 不在本次重构中开放。
8. **删除旧 session 编码**：只有所有 adapter、Runtime、Trajectory、Host、SDK、reports 与旧轨迹兼容测试通过后，再移除 `sessionAfter`、对每次切窗新建 descriptor ID、`handoffGeneration` 等重复概念。完成后更新本项目 DOCS-INDEX 和 cross-window 入口，记录真实验收仍需的证据。

每一步作为单独可审阅 commit/变更集，先跑小而定向的纯状态机与单包测试，再跑包集成/typecheck；GUI/live/API 验收是最后单独授权门，不用它代替确定性 tests。当前并行多行输入线合入前不可改 CUA 业务源码；本计划落地之后等待协调者给出明确 merge window。

## 模块切分与纯状态机测试

建议拆成以下文件，名称可按现有 TS 配置微调；`index.ts` 只作为窄 re-export，不在 driver 单文件继续加字段分支。

| 模块 | 职责 | 允许依赖 |
| --- | --- | --- |
| packages/computer-cua/src/surface-contract.ts | 私有 Surface 类型、SurfaceStamp、Evidence 类型与状态枚举；PID/HWND 仅私有 native identity。 | 无 CUA driver/runtime I/O。 |
| packages/computer-cua/src/surface-registry.ts | 纯 transition：register peer、verified child push、verified pop、generation advance、mark unknown、invalidate、lookup active/capture ancestor。 | surface-contract。 |
| packages/computer-cua/src/surface-evidence.ts | 将 list_windows、accessibility per-window envelope、exact-window root state 解析为带 completeness 标记的 typed evidence；分类函数纯且缺字段返回 unknown。 | surface-contract；不调用 driver。 |
| packages/computer-cua/src/surface-binding.ts | Observation/action/Grounding/approval 的 SurfaceStamp 一致性判定、geometryRevision 检查和拒绝码映射。 | Surface contract 与协议 type only。 |
| 同目录独立 *.test.ts | 测 transition table、evidence adversarial cases 和 stale binding。 | fake values；不得启动真实桌面。 |
| cua-driver-computer.ts | 只负责串行 CUA/DOM IO、Abort、signal、调用 evidence parser/registry、执行 exact tool request、回传 receipt。 | 依赖 pure modules，不反向承载模块算法。 |

最小状态转移：initialize → registerPeer* → setActiveOnVerifiedCapture；(activeParent, evidence-complete child) → pushChild；(active child, evidence proves absent, parent freshly revalidated) → popChild；(any active, conflicting identity/unknown side effect) → markUnknown；(any, run close) → closeAll。非法 parent、错误 owner、generation 倒退、两项 simultaneous active、unknown->active 无 fresh discovery/capture、child 未验证而 pop、stale idempotency token 均拒绝。

最初纯状态机测试表：

| 测试组 | 主要断言 |
| --- | --- |
| Peer graph | Browser/WPS/Notepad/Explorer 都登记在一个 session；active peer 单一；peer switch 只改 Surface，不改 session id；activation/capture 未验证不 commit active。 |
| Child admissibility | 完整 baseline diff + exact PID/HWND + exact owner PID/HWND + unique z order + complete root role 才 push；missing/duplicate/tie/wrong owner/truncated/root absent 均 unknown 或拒绝；title/同 PID 不补证。 |
| Menu regressions | same-HWND root overlay 复用 native identity；普通 window tree 的任意 MenuItem 不建 Surface；另一个 HWND 树内出现 MenuItem 不把它当 popup root；MenuItem role 本身不是 window root。 |
| Pop/reparent | child 消失且 parent fresh identity/geometry 成立才 pop；父窗口关闭/换 generation/几何不能校准则 active unknown；child HWND 被重用时产生新 identity。 |
| Reference freshness | observation、coordinate、Grounding、surfaceRef 都拒绝跨 ID/gen；resize 更新 geometryRevision；browser tab/document generation 更新后 old DOM refs 失效。 |
| Unknown/Abort | activation 后 Abort、input transport throw、ambiguous result 不自动恢复、不重试、不执行下一命令；明确 no-input refusal 才允许既有人工兜底。 |

## 集成验证与验收门槛

### CUA Computer fake-driver 集成

- 单次 ComputerSession 生命周期断言：所有 native peers、popup child、browser round trip 始终相同 ComputerSessionId；driver startSession/endSession 各一次。切窗之后的截图 viewport 更新，但 descriptor identity 不变。
- 显式 peer switch 独占一轮；ref 来自本 Run 当前 Surface inventory，Host scope/identity 重验失败在激活前拒绝。成功次序为 fresh inventory → 可选一次 exact activation → exact geometry/capture → active Surface commit；任何 capture failure 不输入、不回滚猜测。
- 同 HWND menu overlay、owned native popup、owned dialog、unowned same-process window、different-process window、桌面系统菜单分别作为独立 fixture，断言 Window/PID/HWND 目标和 Registry kind。
- 对 root-role 解析做恶意夹具：root=Window 且子代含 MenuItem、tree 来自另一个 HWND、root 字段缺失、truncated/degraded、zIndex tie、ownerWindowId 缺失、owner 错、父窗消失，全部不得自动 child push。
- child 关闭后确认旧 child Observation/Grounding/action refs 先失效、父 identity fresh、父 frame 新建后才允许输入；关闭不可确认、父不见、窗口重用则 Active Unknown。
- `get_window_state` 对精确候选但不完整/另一个 HWND 返回数据时，分类与 capture 都拒绝；严格核对工具请求参数持续携带 exact pid/window_id。

### Runtime / Guard / Approval / Monitor / Trajectory

- list_surfaces/switch_surface 或兼容 window 工具串联多次 peers 往返，ComputerSessionId 不改变；每次切换后 fresh observation；切换与别的 ToolCall/Guard batch 混用继续拒绝。
- Auto child 在已 completed action 后进入 child Surface，未生成人工 peer handoff；普通新 peer 不 auto push且保留既有 opt-in/Host confirmation。child pop 时不回放打开/关闭 action。
- ActionProposal/ExecutionStart/Grounding event/Guard evaluation/Approval requested/evidence/Monitor transition/Observation 都能交叉验证相同 SurfaceStamp。审批等待时 Surface gen 改变会让原申请拒绝且 driver call count 为零。
- Monitor 对同一 Surface 连续重复仍可发现模式；跨 Browser→WPS→Browser 不把不同 Surface 的两次动作拼成 A-B-A loop。surface 缺失时 transition unknown。
- Trajectory 可从事件日志重建 peer 切换、child push/pop、active unknown、Abort/outcome_unknown；不因 session descriptor id 变动重置同一 Run 的 Plan/Memory。历史无 Surface 元数据轨迹仍能只读 replay。
- Tool/Context/Host/TUI/Web/Voice/Report/Relay 不暴露 PID/HWND/raw tree/token/profile/CDP；标签可显示但不作为权限依据。switch surface 授权仍由 Run opt-in+exact host scope，risk Guard 仍只针对实际内容副作用。
- managed-browser browser→WPS→browser 往返每步检查 parent/window/tab/document stamps；返回必须 new DOM collection、新 grounding refs；ordinary personal browser 永不连 DOM。

### 真实环境放行条件

以下不是此文档已完成的验收，只是后续独立放行清单：先用纯测试完成上述合同；CUA pinned version 能稳定产出 owner HWND、z order、per-window root role 和截图 bounds；协调者确认隔离的空白 Notepad/WPS/browser fixture 与精确窗口 scope；再在有限次数下验证同 HWND 菜单、owned Save/Open dialog、关闭后 parent pop 和 browser tab/document generation。任一 identity/root/owner/z-order 证据缺失即记录“不支持自动 push”，不改用桌面截屏猜测、不复用私人窗口、不进行输入/保存/发送/支付。

## 完成条件

- 每 Run 仅有一个 active ComputerSessionId 与一个 CUA lease；所有 Surface switching、child push/pop 不重开/重建/伪装成 session 替换。
- Registry 的 active lineage 唯一、可回放、代次单调；每一个新捕获/执行/grounding/审批都可证明所属 SurfaceStamp。
- 仅证据充分的 owned transient child 自动 push/pop；same-HWND menu 与独立 HWND dialog/popup 的分类有独立合同和反例测试；树中任意 MenuItem 永不证明根 Surface。
- peer switching 仍是显式能力，child ownership 是窄规则；每种缺证据情况都有确定拒绝/unknown 路径。
- Abort、未知副作用、high-risk Guard、用户审批、ManagedBrowser Host 清理与旧窗口 stale 检查没有被绕过。
- 纯状态机、adapter fake、Runtime/Trajectory/schema/typecheck 定向测试通过；真实 GUI 与模型验收单列并有新的明确放行。

## 本次边界

本轮只读审计上述文件与既有方案/测试索引，并新建本设计与迁移计划；没有运行测试、调用 Provider API、操作 GUI、启动 Browser 或编辑业务源码。CUA 共享实现文件仍由并行输入线管理，必须等协调者通知后再开始阶段二。

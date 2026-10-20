# SurfaceRegistry 集成独立审查

## 第八轮最终终审（2026-10-03）

**GO：放行WindowRelationshipProbe与SurfaceRegistry确定性集成阶段。** 第七轮两个P1、两个可用性/证据来源修正以及本轮补发现的structured degraded边界均已修正；最终源码复核、独立反例和相关回归通过。本轮没有新的已确认P0/P1。GO不代替真实Notepad/WPS的child输入、菜单操作、popup关闭和DPI功能验收；该实机边界仍需单独授权。

### 本轮实际验证与时间顺序

- 显式Node24.19.0；初始7个probe/merge/admission/Registry/CUA/factory/companion定向文件共**180 tests通过**，主工程和spike typecheck通过。
- 从物理cwd独立跑全量，**104文件1196 tests通过**，核对作者全量报告。随后发现并由实施线修补structured degraded残余；本审查没有编辑业务源码。
- 最后补丁后独立复跑probe/merge/admission/CUA四文件共**132 tests通过**，再次主工程/spike typecheck通过；按用户加速要求没有第三次全量。不能将补丁前1196计数表述为最后补丁后的全量执行。
- 作者报告native只读probe complete=true、342 rows。本审查没有调用生产probe、读取真实窗口或重做该实机结果；该数据只用于作者证据，不混入独立验证。

### 已关闭反例

| 关注点 | 独立结果/证据 |
| --- | --- |
| CUA truncated被完整probe擦掉 | node-e现为merged.complete=false、truncated=true；显式negative与missing complete attestation分开，缺metadata可补、负证据不补成complete |
| structured degraded=true且缺complete被补成complete | 最后node-e直接WINDOW_TARGET_UNKNOWN；relationship fallback调用数=0；新增adapter反例通过 |
| 普通completed action无overlay专属字段 | node-e detect返回[]、保留parent；不因不存在候选的可选overlay能力缺失终止 |
| 已admitted overlay再次读取缺专属证据 | node-e仍TRANSIENT_SURFACE_UNKNOWN、保留child且不pop；能力缺失宽容未转移到已有授权child |
| z-order链覆盖不足 | node-e完整flag被降为false；无rank的row不能用于完整stack证明 |
| z-order cycle或超cap | node-e重复链ID、超过maxWindowRows均拒绝；C#显式walk另有visited set、2048步预算与EnumWindows coverage比较 |
| 0尺寸窗与读取失败区分 | 已测量0面积row从关系/交互rows中忽略，不导致永久partial；GetWindowRect/PID/owner读取失败仍complete=false；parser回归覆盖zero size和read-failure语义 |
| managedBrowserCompanion隔离 | factory/companion定向通过；默认companion仍不注入probe，显式测试注入/null opt-out保持可控 |

zIndex已不再来自EnumWindows callback序号；native先枚举exact handles，再使用GetWindow(GW_HWNDFIRST/GW_HWNDNEXT)显式关系链，检测循环、cap、未知handle和coverage不符。parser只从链生成rank，链与rows不能完整对应时complete=false。跨平台Runtime仍不调用Win32，probe继续只读、EncodedCommand编码和ASCII输出限制不变。

overlay探测现在区分“没有候选marker的可选能力缺失”与“报告了候选但证明不完整”，以及“已经admitted child复核”。普通父观察可继续，真实候选失证仍fail closed。dialog exact foreground、menu完整unique owned stack、same-HWND精确overlay证据的三个合同继续独立；guard/approval/trajectory stamp与撤销规则没有被这些可用性修正放宽。

### 最终边界与下一步

沿用第七轮的隔离Notepad/WPS方案：先只读核对exact scope、class/owner/foreground/geometry，再做有限次空白文档普通动作、Find/Cancel dialog、菜单/Escape和fresh parent pop。不得保存用户文件、点击提交、绕过foreground guard、扩大peer scope或自动回放不确定动作。WPS自绘dialog和真实menu HWND输入支持、DPI bounds一致性、overlay incarnation仍需实机结果，不能由fake tests或342-row只读probe推定。

本轮仅更新审查文档并显式UTF-8读回检查；业务修补由实施线完成。建议入口最终标记“Probe+Surface确定性GO；真实GUI/API功能验收待隔离授权”。前七轮内容保留为历史，不将已关闭问题继续列作当前阻塞。

---

## WindowRelationshipProbe 最终专项复审（2026-10-03，第七轮）

**NO-GO：新增relationship probe尚有两个独立P1，先修再安排实机功能验收。** 前六轮的历史GO限定于当时的确定性Surface实现；本轮新增probe合并和overlay capability路径有新的反例。未发现P0；没有修改代码、运行生产probe、操作真实GUI或调用真实模型/API。

### 独立验证与作者结果核对

显式Node **24.19.0**：probe/merge/admission/Registry/CUA adapter/app factory/managed companion/Runtime/Trajectory/Context定向 **10文件366 tests通过**；主工程和spike typecheck通过。随后从**物理仓库目录**独立跑全量，确认 **104文件1193 tests全部通过**，与作者报告一致。

先从R: subst映射全量运行时，profile-recovery test拒绝映射后的realpath，Web suite也出现路径环境失败；改用物理cwd后全部通过。该首轮失败不是代码回归，不修改安全fixture/validator绕过。执行器仍用ASCII Node路径与ASCII相对脚本参数，未向外部进程传中文源内容。

### P1-1：成功merge擦掉CUA显式truncated证据

`window-relationship-probe.ts` 成功返回路径的complete仅看probe.complete/probe.truncated，truncated字段也只保留probe.truncated。因此CUA明确truncated=true但其剩余rows与probe一致时，完整probe会覆盖为complete=true且不再带truncated；Stage1拒绝truncated的规则被绕过。

本轮node-e输入 `CUA {complete:false,truncated:true,windows:[parent]}` 与完整exact PID/HWND probe，输出：`merged.complete=true; merged.truncated=undefined; assessOwnedTransientWindowAdmission.decision=admitted`。bounds conflict反例则正确返回complete=false且无foreground证据。

修正：区分“CUA缺complete/关系字段，可由独立probe补足”与“CUA显式truncated/degraded/矛盾”。后一类不能被补成自动admission证据；至少保留任一源的truncated标志，auto-admission仍fail closed。加CUA-truncated+complete-probe反例，不能只测probe自身truncated。

### P1-2：未admitted overlay的能力缺失导致普通动作后Run止步

完整inventory、没有新HWND时，detect仍无条件调用verifySameHwndOverlay；backend不提供root_surface/geometry_verified/overlay_root字段会返回unknown，随后抛TRANSIENT_SURFACE_UNKNOWN。relationship probe补足全局inventory后，这条分支更容易触发，普通UIA click/type的postcondition也可能被终止。

本轮node-e：inventory只有exact parent且complete=true、无新window；get_window_state返回完整elements、一个depth=0/role=Window的真实形状但不提供overlay专属字段。实际输出 `TRANSIENT_SURFACE_UNKNOWN: same-HWND overlay state did not prove the exact parent root and geometry`。没有active child也会失败。当前成功fixtures补了overlay_root:null/root_surface/geometry_verified，因此全量通过不能说明这个backend capability路径可用。

修正：**已admitted active overlay**复核失证继续拒绝；**尚未admitted的可选overlay探测**不支持专属合同则不push，保留父Surface普通视觉观察，或显式声明该backend不支持该feature。不要把“未证明有overlay”与“已授权overlay失证”合成必终止路径。补ordinary no-new-HWND、缺overlay capability、真实shape depth0 root的adapter测试。

### 正确实现与字段链

- PInvoke/PowerShell实现仅在app-runtime；portable Runtime没有user32.dll调用。Probe DTO不含title、UI文本、截图或raw tree。当前source枚举只有win32_relationship_probe，名称仍限定Windows实现；以后增加其他平台probe应扩展证据source，而不是让其他平台伪称Win32来源。
- Windows实现只有EnumWindows/GetWindow(GW_OWNER)、PID、geometry、visible/minimized/class、foreground等读取，没有SetForegroundWindow/SendInput/GetWindowText。fixed PowerShell path、NoProfile/NonInteractive、UTF16LE base64 EncodedCommand、ASCII-only JSON读取、class非ASCII置空、输出上限/timeout/Abort与无重试边界合理；本轮只用executor seam检查，不调用真实native probe。
- merge按exact PID/HWND对齐，已有row的bounds/owner/zorder/visibility等冲突保持incomplete、撤销foreground admission证据；duplicate和probe自身truncated反例通过。缺字段被补足而非永远要求CUA自己新增字段，方向合理，但P1-1需要保留显式负证据。
- factory默认仅Windows foreground且非managedBrowserCompanion注入；explicit injection/null opt-out存在。companion测试隔离通过，OSWorld不加载Win32 native实现。
- dialog与menu分策略：dialog必须exact foreground+samePID/exact owner/visible，允许nontruncated partial inventory；menu需要complete owned stack、候选在parent之上且是相关菜单唯一顶层。#32770/#32768提供窄原生class语义；custom WPS UIA root仍须独立exact root evidence，不按标题或任意MenuItem推断。根语义、visible、interactionPolicy、frontmostEvidence进入私有Registry，公共admissionSource贯通Guard/approval/Trajectory；parent/child generation、modal barrier与close cleanup仍在。

### P2与功能可用性待验证

1. Windows脚本在任何EnumWindows row geometry为零/读取失败时将**全局complete=false**，包括明确不可见的helper window。dialog exact-foreground路径能在partial情况下继续，但菜单仍依赖complete，可能长期不可用。尚未实机测到这种桌面形状；验收必须记录partial原因，确认irrelevant hidden row不会让所有菜单永久降级，不宣称已实现正常菜单操作。
2. 脚本用EnumWindows callback数组下标生成zIndex。Microsoft官方EnumWindows合同说明枚举top-level窗，未承诺callback排序；GetWindow的GW_*关系才明确描述Z-order。这里是**证据不足的推断**，并非已证明Windows实际返回错误顺序。建议读取或校验明确z关系，并有cycle/变动/预算防护，或给出pinned环境证明。参考：[EnumWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows)、[GetWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindow)。
3. GetWindowRect与CUA bounds要求全等，DPI/扩展frame边界可能造成永久conflict；这是待实机量测的合同风险，不能调大容差掩盖geometry身份冲突。#32770的class可证明标准dialog语义；WPS自绘dialog/class、same-HWND overlay不能因为该白名单成功就推定支持。
4. exact-foreground读在probe末尾、window geometry/owner读在枚举期间，并非原子snapshot；后续capture/action复核仍必需。完整fixture迁移加depth0根节点是合理合同修正，但probe.native零尺寸/异步变动和不支持overlay字段均须反例，不能只补fake字段。

### 建议实机Notepad/WPS验收方案（仅方案，未执行/未放行）

前置：先修两个P1并定向复审；由协调者单独授权真实GUI。用户或隔离Host准备**空白、未保存**Notepad/WPS文档，显式列出exact PID/HWND scope；不连接私人Browser、不打开现有用户文件、不输入路径、不保存/提交。使用ScriptedProvider或Host固定动作，不消费模型API。

| 阶段 | 动作与证据 | 放行/失败标准 |
| --- | --- | --- |
| 只读能力 | 每个fixture连续两次CUA inventory+probe，保留numeric identities/class/owner/foreground/geometry/source/complete/truncated及冲突原因；观察隐藏0尺寸row和DPI | exact parent能合并；不把truncated补成complete；probe失效不输入。不支持字段明确记录 |
| 普通动作回归 | 每app一个reversible focus/click或短ASCII本地编辑，再capture父窗 | 没有新HWND且无overlay合同也可fresh parent观察；同Session、无错误终止、不自动重复输入 |
| owned dialog | Notepad/WPS各尝试一个Find或打开后立即Cancel的Save/Open dialog；先读class/root/owner/foreground，不点击Save、不输入文件名 | 证据完整才child push；scope外unowned/不同PID/非foreground dialog拒绝。记录WPS custom dialog不支持，而非改标题规则 |
| 菜单/overlay | 打开一个fixture菜单；独立HWND用owned stack，same-HWND仅支持有精确overlay root的backend；Escape关闭 | 支持时fresh child frame，parent不能同时输入；缺能力保持父视觉处理。菜单未取得foreground时检查真实driver是否能合法投递，不绕过foreground guard |
| pop与清理 | child关闭后fresh inventory确认absence，再capture parent；复用旧child坐标/ref作一次**应拒绝**的请求 | pop增代、旧refs不复活、switch barrier解除；start/end lease各一次；异常/Abort不回放、不改选别窗 |

预算建议每app最多三种场景、每场景不超过8个GUI动作；遇unknown、scope冲突、root不支持或capture失败立即结束该场景。验收交付原始事件、exact-window截图与driver call计数，区分“功能成功”“安全拒绝”“backend不支持”。此方案不授权实际运行。

本轮只更新审查文档；入口与下一步由协调者汇总。

---

## 第六轮最终结论：owned-child admission（2026-10-03）

**GO：scope 外 owned-child admission 的确定性实现可以推进。** 第五轮的 off/dom-only picker 漏口与额外全局树读取均已关闭；本轮未发现新的P0/P1阻塞。与第四轮一样，GO仅涵盖源码/fake-driver/协议/Runtime/轨迹验收，真实GUI/API及backend owner/root/z-order能力仍未放行。

显式Node **24.19.0**，本轮7个定向Vitest文件共 **338 tests通过**（admission9、Registry15、CUA adapter101、Runtime106、Trajectory49、Context33、Risk Guard25）；主工程 `tsc -b` 和spike `tsc --noEmit`通过。独立node-e使用fresh Registry、fake driver与scope只有parent的状态验证下表，没有真实桌面/API。

| 独立复现 | 返回/状态 | exact root reads | global accessibility tree reads |
| --- | --- | --- | --- |
| grounding=off，scope外唯一owned HWND | TRANSIENT_SURFACE_UNKNOWN，父仍active、baseline consumed，不进picker | 0 | 0 |
| grounding=dom-catalog-v1，同候选 | 同上 | 0 | 0 |
| UIA，complete exact Dialog root | picker=[]，唯一active child，source=owned_transient_window_root_proof，baseline consumed | 1 | 0 |
| UIA，root声明别的HWND | TRANSIENT_SURFACE_UNKNOWN，父仍active、baseline consumed，不进picker | 1 | 0 |
| UIA，root=Window而非允许role | 同上 | 1 | 0 |
| UIA，Tool isError | 同上 | 1 | 0 |
| UIA，structured root state truncated=true | 同上 | 1 | 0 |

成功case实际请求为 `{pid:1, window_id:101, include_screenshot:false, max_depth:8, max_elements:64, session:"stable"}`。新root-only helper不再调用全局get_accessibility_tree；Stage1所需owner/visibility/z-order来自完整listWindowInventory。admission与active child复核都重新检查Stage1，之后只作一次exact candidate root读取，root error/unknown不再退到scope外picker。

测试继续覆盖parent Surface/generation/HWND/geometry基线的一次性消费、stale parent拒绝、wrong owner/differentPID/tie/incomplete inventory、错误proof第二次detect不重试，以及合法owned Dialog后的modal barrier、child专属input scope、parent pop增代和旧child observation拒绝。admissionSource仍由Registry生成，Grounding/Guard/approval/trajectory比较完整stamp；没有把scope外child升格为普通peer，也没有扩大Host peer allowlist。

本轮只更新本文并显式UTF-8读回检查。建议阶段入口记录“SurfaceRegistry与owned-child admission确定性GO；真实GUI/API和backend capability待单独验收”。overlay incarnation、更细modal语义与完整capture ancestor图仍按前述P2窄增量处理，不能作为真实backend已支持的推定。

---

## Owned-child admission 专项复审（2026-10-03，第五轮）

**NO-GO：本轮新加入的 scope 外 owned-child admission 例外暂不能放行。** 第四轮对既有 Surface 确定性集成的 GO 不作历史改写；本轮发现的是新增两阶段授权分支在 grounding off/dom-only 下绕过 Stage2 的候选投影漏口。

显式 Node 24.19.0 独立执行：admission pure、SurfaceRegistry、CUA adapter、Runtime、Trajectory、Context、Risk Guard 共 **7 文件335 tests通过**；主工程与spike typecheck均通过。只读node-e复现成功路径与失败漏口，没有GUI/API或业务修改。

### P1：无法执行Stage2时，scope外候选仍被送入picker

证据：`detectNewWindowHandoffCandidates` 的 readDiff 不区分 grounding模式，允许scope外唯一owned HWND通过Stage1；后面只有 `supportsTransientUia` 才执行exact candidate root proof。`grounding=off` 或 `dom-catalog-v1` 时此分支跳过，最后 `handoffWindows = pushedChild ? [] : surfaced` 仍把未经Stage2证明的scope外窗口返回。

独立node-e：Host scope只有parent PID=1/HWND=100；完整新inventory发现同PID/HWND=101，exact owner=parent、visible=true、唯一最高z-order。grounding=off时调用detect，实际输出 `[{pid:1,windowId:101}]`；`get_window_state` root reads=0。这是未经root-role证明的窗口进入Host候选，并非已观察到错误GUI投递：后续handoff scope guard仍可能拒绝该candidate。但其行为违反“失败/unknown不能进picker”和两阶段最小授权合同。

修正：只要 `potentialOwnedTransientChild` 存在而当前backend/mode不支持Stage2，立即 `TRANSIENT_SURFACE_UNKNOWN` 并清候选，不能fall through到普通handoff picker。off/dom-only均补反例；若选择不依赖grounding模式执行独立只读proof，也须保留exact root/role/complete合同，不能将Stage1当输入授权。

### 已确认正确的授权收缩

- preActionWindowBaseline冻结active SurfaceRef（包含generation/parent/admissionSource）、exact parent PID/HWND、geometry与完整inventory；detect进入后在任何async I/O前消费baseline。parent generation/binding改变会拒绝，geometry改变增代并清refs。错误proof的adapter test确认exact candidate root只调用一次，第二次detect不重试。
- Stage1只接一个新窗口，samePID、distinct HWND、exact owner PID/HWND、candidate明确visible、全inventory可比较visibility/z-order且唯一frontmost；complete/truncated、missing owner、wrong owner、different PID、tie/multiple candidates、stale parent的pure tests通过。此stage只授予继续读root proof，未直接push或activate。
- Stage2支持模式下要求complete/nontruncated exact candidate root、允许Menu/Popup/Dialog，Window根中的MenuItem不能补证。root error、wrong role时scope外候选被withhold；成功owned Dialog成为唯一active child，旧parent observation能力撤销，modal barrier在peer activation前拒绝，关闭后pop并增代清child旧refs。
- SurfaceRef新增admissionSource；Registry生成且所有current/executable引用比对该字段，grounding、Runtime、Guard、approval与Trajectory同stamp比对。node-e成功case picker count=0、source=owned_transient_window_root_proof、root reads=1、baseline consumed=true；把stamp的admissionSource删掉后 `isExecutableSurfaceRef=false`。轨迹Guard/approval丢失source反例test通过。Provider不能通过ActionIntent自己构造该Registry能力。

### P2：Stage2额外全局树读取与证据范围

Stage2复用 `verifyTransientNativeChild`，在exact candidate bounded `get_window_state`前调用无PID/HWND过滤的 `get_accessibility_tree({session})`。成功node-e记录candidate root reads=1、global tree reads=1。当前parser仅消费该树的window metadata、不传Provider，但这比“Stage1完整metadata inventory，Stage2只读exact candidate root”更宽。建议拆root-only proof helper并复用Stage1证据，或明确审阅所需全局metadata能力，不把无过滤UI树读取描述为完全exact-candidate-only。

还应补wrong-root HWND、truncated/degraded root、Abort期间candidate/proof、parent geometry变化与缺Stage2 capability反例。目前纯Stage1 tests合理，但其手填current/complete不能替代adapter全链测试。

建议先关闭off/dom-only的P1，再复跑admission/adapter定向与typecheck；实际backend owner/root/z-order能力及真实GUI验收继续单列授权。本轮只更新本文。

---

## 第四轮最终结论（2026-10-03）

**GO：放行本轮 SurfaceRegistry 的确定性集成阶段。** 第一至第三轮列出的已确认 P1 反例已修正并经本轮独立验证；本轮没有发现新的 P0/P1 阻塞。放行的是源码/协议/Runtime/轨迹/fake-driver 集成，不包含真实 GUI、模型 API、backend capability 或真实自动 child 验收，也不表示最初架构计划的每个可选字段都已实现。

### 本轮独立验证

显式 Node **24.19.0**；12 个 Vitest 文件共 **415 tests 通过**，其中 Trajectory 48 tests、CUA adapter 94 tests、Runtime 106 tests；cross-window/travel 四个 Node selftest 文件共 **31 tests 通过**。主工程 `tsc -b` 与 CUA spike `tsc --noEmit` 均通过。以上是本轮实际执行，不引用上一轮测试次数。未重复全量 suite。

| 第三轮反例/最终门槛 | 本轮结果 |
| --- | --- |
| v2 active A@4 直接 observation A@1，无 transition | node-e 拒绝：Observation Surface changed without a preceding computer.surface.transitioned event |
| 无父子关系的 root A→root B，reason child_pop | node-e 拒绝：child_pop requires a known direct child-to-parent Surface lineage |
| A@4→B→A@1，reason peer_switch | node-e 拒绝：transition target Surface peer-a must advance beyond generation high-water 4 |
| 普通 in-memory 缺 schemaVersion 事件冒充 legacy | node-e 拒绝同一缺 transition 错误；仅 readRuntimeEvents 对 v1/unversioned 解码结果加入不可由事件字段伪造的 WeakSet 标记 |
| 合法 parent→overlay child→parent fresh generation→finished | node-e 完成：finished；parent high-water=5，child parent=peer-a；pending transition 已消费；审计事实仍保留 |
| 重构前 switch_window 的 sessionAfter 新 ID 真实 JSONL | 本轮 Trajectory test 写入临时 JSONL、read/reduce 成功，产生 generation=0/kind=unknown alias，保存旧session alias来源事件；新普通/v2 receipt仍拒绝Session ID变化 |
| legacy unknown live/resume/action/approval/new-write | Runtime/Trajectory 定向 tests通过；unknown只供只读回放，不能恢复投递能力 |
| Surface parent opaque ID进入Context | Context test提供dom leaf+opaque tab parent，投影文字只保留kind，两种opaque ID均不出现 |

### 关闭证据

Trajectory 现在保留每 SurfaceId 的 generation high-water 与 immutable direct parent map，拒绝回退、改父、自己为父与cycle；reason分别核验同Surface增代、direct child push/pop、非父子peer切换。pending transition只能由匹配Observation消费；等待期间不接受下一动作/重复transition；终止时清pending但保留high-water、parent、lineage审计事实。

legacy兼容入口仅在JSONL reader中，普通内存事件没有“缺版本即可宽松”的旁路。旧独立Session换代receipt只在reader标记的旧日志中转换成只读unknown alias；新Run保持唯一稳定Session。缺parent或非法旧Surface形状也会降级为unknown，旧Grounding与Observation绑定一并规范化。

前几轮的overlay三态、inventory completeness、modal barrier、parent push/pop增代与source/target subtree清理、Monitor Surface分区、ApprovalEvidence/Guard stamp持久化、dispatch前检查、transition生产、OSWorld resize增代继续通过。managed-browser/DOM定向与SDK往返selftest均通过，没有发现新schema破坏这些确定性路径。

### 保留的 P2 与后续真实验收

- backend是否实际产出complete/root_surface/overlay_root、exact owner HWND和可比较z-order，仍需独立能力证据；当前缺字段fail closed是预期行为。
- overlay幂等仍以exact HWND+root role判断，尚无独立overlay root incarnation/geometry revision；不同submenu/root更替应作为窄增量补证。所有native transient/overlay保守阻断peer切换，不宣称已实现细分modal策略。
- 公共合同提供direct parent与transition timeline，尚不是包含所有capture ancestors/owner/modal节点的完整持久图。确定性当前范围可推进；完整架构扩展需明确增量合同与测试。

建议协调者更新阶段入口为“确定性Surface集成GO；真实GUI/API仍待单独授权与backend证据”，保留上述P2。本轮只更新本审查文档，UTF-8显式读回检查；没有业务/测试代码修改或真实GUI/API操作。

---

## 第三轮公共链复审（2026-10-03）

**当前结论：执行安全修复仍有条件 GO；完整 Surface 轨迹验收仍 NO-GO。** 第二轮提出的主要公共字段和生产链已经补上，但新的 transition reducer 校验仍有确定性反例。以下是本轮最新事实，前两轮段落保留为历史记录。

本轮显式 Node 24.19.0：12 个 Vitest 文件 **411 tests 通过**，cross-window/travel 四个 Node selftest 文件 **31 tests 通过**，主工程与 spike typecheck 均通过。检查新版源码、测试、编译产物；只读 node-e 验证 reducer 反例。未操作 GUI/API、未改业务或测试代码。

### 第二轮剩余问题的关闭情况

- **legacy 字段 decoder 已实现**：JSONL writer 写 schemaVersion=2；unversioned/v1 reader 为缺 Surface 的 observation/grounding/Guard/approval 生成稳定、generation=0、kind=unknown 的 replay-only ref。v2 缺字段继续拒绝。新增 legacy JSONL read/replay 用例通过；live capture、resume、action binding、approval recovery、新 JSONL write 均有未知 Surface 拒绝路径和 tests。此处“关闭”针对旧字段缺失的单 Session 日志，不包含下面旧跨窗 Session 换代兼容问题。
- **ApprovalEvidence 公共 stamp 已持久化**：evidence.surfaceRef 写入 schema/轨迹，Runtime 同时冻结 executionSurfaceRef，获批与dispatch前比对当前 frame；不同代次不审批/不执行。Guard input/event 新增 evaluatedSurfaceRef，Guard 返回后的当前帧/代次检查和 reducer active stamp 检查均存在。
- **transition producer/schema 已接通**：CUA capture 携带 peer_switch/child_push/child_pop/generation_advanced 等原因；Runtime 仅在前后 stamp 变化时写 computer.surface.transitioned，随后 fresh observation；reducer 维护 activeSurfaceRef、pending transition 与 surfaceLineage 时间线，避免同 stamp 普通 observation 重复转移。Context 保持脱敏，仅展示 surface kind；opaque SurfaceId 不加入 Provider grounding 文本。
- **OSWorld resize 已补**：observe 及completed-action post capture 尺寸变化均 bump desktop generation，返回 generation_advanced reason；新增 resize test 通过。
- overlay三态、truncated inventory、modal barrier、父引用失效、Monitor分区、peer source/target subtree cleanup 等第二轮修复在本轮 tests中继续通过。

### 本轮确定性 P1：v2 transition/replay 校验仍可被绕过

`trajectory/index.ts` 的 observation.created 分支在缺 pending transition 且 stamp 改变时，无论 schemaVersion 都接受并添加 reason=legacy_observation；`isValidSurfaceTransition` 对 peer_switch、child_push、child_pop 仅要求 SurfaceId 不同，对 surface_changed 无条件接受。surfaceLineage 是 from/to 时间线，不包含parent/capture ancestor或每个Surface的generation高水位。

本轮 node-e 使用 **schemaVersion=2** 合法事件序列，独立复现：

| 输入 | 实际结果 |
| --- | --- |
| active peer-a generation=4，直接提交同Surface generation=1的observation，无transition | 接受，active generation回到1，并被记成legacy_observation |
| peer-a → unrelated root peer-b，reason=child_pop，没有任何parent事实 | 接受，surfaceLineage记录child_pop |
| peer-a generation=4 → peer-b → peer-a generation=1，均reason=peer_switch | 接受，known peer generation回到1 |

这些反例没有证明adapter向真实窗口投递了错误输入，但确实违反新轨迹的代次单调、transition理由与可回放父子事实合同，不能因411 tests通过就宣称轨迹验收完成。

修正：只允许明确legacy version走隐式Observation兼容；v2要求对应transition，记录每个Surface已见最大代次，拒绝所有reason中的代次倒退；child_push/pop携带并核验parent/lineage证据，不能仅靠两个ID不同。增加missing-v2-transition、same-ID/peer-roundtrip generation倒退、unrelated-root child_pop及合法child-pop/managed-DOM peer切换反例。

### legacy跨窗仍需补验

旧版切窗会以新的sessionAfter.id代表新窗口。当前decoder没有对此类legacy receipt作版本化兼容，reducer仍要求所有switch_window sessionAfter.id等于当前Session。因此不能据单Sessionlegacy fixture通过，宣布重构前跨窗日志全部可replay。此项本轮已核对源码，未做磁盘JSONL全链复现；应补pre-Surface switch日志读取与reduce测试，legacy只读保留旧换代语义，新v2继续稳定Session严格要求。

### 下一步与边界

先收紧并复测上述三个reducer反例，再补legacy switch fixture。backend完整root/owner/z-order能力、overlay root incarnation与精确capture lineage仍需后续证据；真实GUI/API继续单独放行。本轮只更新本审查文档，入口由协调者汇总。

---

## 最新复审结论（2026-10-03，第二轮）

**有条件 GO：上轮执行安全反例的修复可以继续推进；NO-GO：不能宣布完整迁移验收完成。** 本节覆盖最新 worktree；下文第一轮结论和反例保留为历史证据，不表示那些已修复分支仍然存在。

本轮显式 Node 24.19.0 独立运行 12 个 Vitest 文件共 **404 tests 通过**；cross-window/travel 四个 Node selftest 文件 **31 tests 通过**；主工程 `tsc -b` 和 spike `tsc --noEmit` 均通过。增加检查 Context、Risk Guard、OSWorld producer；没有重复全量测试。只读内存复现调用编译产物，没有 GUI/API。

| 上轮问题 | 本轮结果与证据 |
| --- | --- |
| P1-1 公共 Surface 合同完全缺失 | **部分关闭**：protocol SurfaceRef 为 `{surfaceId,generation,kind}`；CUA/OSWorld capture、GroundingCatalog、Runtime frame、prepared action、approval 私有 pending、Monitor 已生产/消费。剩余公共审批/Guard、lineage/transition/replay 问题见下文。 |
| P1-2 overlay 失证误 pop | **关闭该反例**：verifySameHwndOverlay 已是 present/absent/unknown 三态；degraded 内存复现抛 TRANSIENT_SURFACE_UNKNOWN，active overlay 保留；完整 exact root+geometry+显式 overlay null/absent 才 pop。新增 adapter 同 HWND 正/反例通过。 |
| P1-3 truncated inventory auto-push | **关闭该反例**：baseline/post list-window inventory 和 accessibility inventory 都检查 complete/truncated；坏记录影响 completeness。内存复现 truncated accessibility 不 push，返回 1 个 manual candidate；新增 list-window truncated 反例通过。 |
| P1-4 Monitor 同尺寸 peer 混计 | **关闭**：partition 含 surfaceId/generation/kind；Runtime fingerprint 跨 Surface 时 transition=unknown。三个同 session/viewport、不同 Surface 的 click 内存复现 reasons=[]；新增 Monitor 用例通过。 |
| P1-5 父 refs 复活、modal barrier 缺失 | **关闭既有反例**：push/pop 父 generation 均 bump，deactivation/managed roundtrip 代次更新；清理按 Surface subtree/lineage 而非仅精确旧 leaf。old parent ref pop 后 executable=false；active child activatePeer=manual，adapter transition 在 activation 前拒绝 transient child 切 peer。 |
| P2 duplicate overlay 反复嵌套 | **关闭重复检测反例**：sameChildEvidence 返回原 active child，不增树深度；内存重复 push 返回同一 state。仍缺独立 overlay root identity，不能将幂等正例等同于能识别不同 submenu incarnation。 |
| P2 geometry generation 不统一 | **CUA 路径已补**：desktop 尺寸变化 bump generation；native observe/action geometry 变化沿 capture native Surface bump descendants，并撤销相关 refs；desktop resize adapter test 通过。OSWorld 的 viewport 更新仍不 bump其固定 desktop generation，应继续统一 producer 合同。 |

已实际检查 peer switch 同时清 source/target subtree refs；push/pop 清 parent/child subtree；managed lineage 改变清完整 capture-root observation state。没有发现 handoffGeneration/transientMenuSurface 旧双状态回归。sessionAfter 仍保留为兼容 facade，ID/backend 强制稳定，不是每次重开 Session；不能把名称存在误判成生命周期错误。

### 本轮仍需先完成的 P1

1. **旧轨迹只读 replay 回归未关闭。** `trajectory/index.ts` 的 observationSchema/groundingCatalogSchema 强制 surfaceRef，`readRuntimeEvents` 原样使用 strict runtimeEventSchema，没有 legacy normalization。内存复现一个原本合法、无 Surface 字段的历史 observation：safeParse=false，失败路径为 `observation.surfaceRef`；当前测试也明确要求缺该字段失败。新 Run 写入严格 schema 应保留，但历史读取需单独 bounded compatibility，将 legacy 单 Surface 投影为只读 stamp，不能把 legacy stamp 用于新 dispatch。增加历史 JSONL 读取/replay 用例，而不是只把 fixture 补字段后宣布兼容。

2. **全面公共 lifecycle 审计合同仍未完成。** 当前只有 active leaf 的 SurfaceRef，没有 capture ancestor/lineage、Surface transition/invalidation event，也没有 snapshot active Surface graph、generation 单调和 transition parent 校验。Trajectory reducer 对 observation 只检查 Run/session，不能验证同 Surface 代次回退，或 child push/pop 的因果事实。ApprovalEvidence 仍只包含两 observation IDs/asset/viewport；Surface 检查目前在私有 pending 完成，公共 Guard event 也没有目标 stamp。审批执行安全已有改善，但不能声称公共 frame/action/approval/Guard/Trajectory 已完成同一 lineage 的交叉验证。应完善最小 lineage 与可回放 transition，并让 approval/Guard 记录能够显式定位目标 Surface；若决定缩减原计划范围，应在验收入口明确列为后续阶段，而不是将完整计划标完成。

上述是本轮**全面迁移验收**的阻塞项，不是宣称当前确定性测试失败，也不是再次将已经修复的投递安全反例列成阻塞。未确认 P0。

### 本轮保留的 P2 与真实验收边界

- modal gate 当前将全部 native transient/overlay child 保守视为 modal，menu 也阻断 peer switch。这是安全收缩，解决了未解决 dialog 跨 peer 问题，但尚未实现原计划的 none/blocks_parent/blocks_owner_scope/unknown 证据语义。
- overlay 幂等以同 HWND+root role 判断，没有 root identity 或 overlay geometry revision。不同 submenu/root 的换代仍不能完整表达，补 replacement-root/geometry 变化反例。
- Context grounding 文本已显示 surface kind，结构化 Context 的完整 stamp/lineage 与公共 Guard target binding 尚未完成；其余跨窗 provider/travel tests 通过，不代替 lifecycle replay。
- backend 的 complete/root_surface/overlay_root/geometry_verified 生产能力仍未验证。当前缺字段会 fail closed/终止 opted-in postcondition，这是保守行为；不能用 fake fixture 补字段的成功当真实 pinned CUA 支持。确认 backend capability 后才安排真实 child GUI 验收。
- OSWorld producer 已提供真实 desktop kind 的稳定 SurfaceRef，但其 viewport resize 分支只改 descriptor.viewport，未更新 Surface generation；这是公共 producer 几何合同剩余项，本轮未进行真实 OSWorld 输入。

建议先补 legacy read-only replay，再完成公共 lifecycle 的最小 replay/approval/Guard 合同；随后补 backend capability 与剩余 identity 反例，重跑定向测试。此轮只更新本审查文件；入口由协调者汇总，不操作 GUI/API。

---

日期：2026-10-03。审查对象：当前未提交 worktree 的 SurfaceRegistry 及 CUA、Protocol、Runtime、Trajectory、Monitor、managed browser、cross-window/provider/travel 配套。审查方式：只读源码与差异、Node 24 确定性测试、仅使用 fake driver 的内存复现。没有操作 GUI、启动真实 Browser、调用模型 API 或修改业务代码。

## 结论

**NO-GO：不能宣布《surface-registry-refactor-plan-2026-10-03.md》的全面迁移完成，也不能放行自动 child 的真实桌面验收。** 稳定 ComputerSessionId 和 CUA 私有 Registry 已部分接通，现有定向测试/typecheck 通过；但公共 Surface 合同、审批/Guard/Monitor/Trajectory 绑定尚未迁移，且 child 失证被视为关闭、截断 inventory 被接受等确定性反例成立。没有发现本轮可确认的 P0；以下 P1 应先修。

可继续推进：纯状态机与 adapter 集成修正、协议/Runtime/Trajectory 接线、确定性反例测试。尚未放行：全面 Surface 生命周期验收、自动 child 的真实 GUI/API 使用。

## 本次独立验证

实际使用 Node `24.19.0`，由 `Computer-Harness-A/.tools/node/24.19.0/node.exe` 提供；通过 ASCII `N:` 映射访问运行时，通过已有 `R:` 映射访问本仓库。命令局部 PATH 前置该 Node，不依赖系统 Node 18。

| 执行 | 结果 |
| --- | --- |
| Vitest：surface-registry、cua-driver-computer、dom-grounding、runtime/index、progress-monitor、trajectory/index、provider-glm/index、provider-qwen/index | 8 文件，320 tests 通过 |
| Node selftests：cross-window/cua-probe、cross-window/sdk-managed-browser-probe、travel/travel、travel/tui-collector | 31 tests 通过 |
| `node node_modules/typescript/bin/tsc -b` | 通过 |
| `node node_modules/typescript/bin/tsc --noEmit -p spikes/cua-driver/tsconfig.json` | 通过 |
| 编译产物的 ASCII `node --input-type=module -e` 内存反例 | 5 个反例成立，详见下文 |

本次没有跑全量测试。通过的是既有测试，并不代表下面尚无测试的反例已被覆盖。内存复现直接构造 Registry/adapter 私有状态或 Monitor event，目的是验证分支行为；没有把它冒充完整 Run E2E。

## P1-1：公共 Surface 合同和事件链尚未迁移

证据：`packages/protocol/src/index.ts:613` 的 GroundingCatalog、`:627` 的 ObservationFrame、`:638` 的 ApprovalEvidence、`:647` 的 ObservationCapture 均没有 SurfaceId/generation/capture ancestor/lineage；`cua-driver-computer.ts:902` 返回 capture 时也不投影私有 surfaceRef。Runtime/Trajectory 没有 Surface transition event、active Surface projection 或 replay generation 校验。`run-controller.ts:1345` 附近审批只验证 session 与 viewport。Guard 也没有目标 Surface stamp。

因此 Registry 当前是 CUA adapter 私有事实，frame、approval、Guard、Trajectory 无法交叉证明同一 Surface。换成稳定 Session ID 后，旧有 session 分区已经无法替代 Surface 分区。审批截图即使视觉正确，公共记录仍不能解释动作决定于父窗、执行于 child 或 document 换代的差别。

修正：建立一个公共、脱敏 SurfaceStamp/lineage 合同；新 capture/frame/catalog 必须携带；prepared action 冻结 decision lineage，审批复核执行 lineage；Guard/Monitor/Trajectory 消费同一合同。新增可回放 transition/invalidation，并保留旧无 stamp 轨迹的只读兼容。不要仅向 event 加一个无人消费的可选字段。

验收：新 Run 的 frame/action/approval/Guard/Monitor 绑定一致；same-session/same-size 的不同 Surface 不能通过审批身份检查；child push/pop、browser document 换代、unknown 可以仅从事件流重建；legacy 无 Surface 的事件只读可回放。

## P1-2：overlay 的证据失败被误认为关闭

证据：`cua-driver-computer.ts:946` 的 overlay 分支调用 `verifySameHwndOverlay` 后直接执行 `childAbsent = evidence === undefined`。但是 `verifySameHwndOverlay` 在 Tool error、degraded、tree 不完整、root 缺失、错 PID/HWND、几何证据不成立时都会返回 undefined。随后只要 `discoverWindow` 找到父窗，就 `popChild(... childAbsent: true)`。

独立复现：构造已 active overlay，fake `get_window_state` 返回 `degraded:true`，父窗 inventory 仍有效；调用 reconcile 后输出 `overlay degraded root was popped: true`。这不是 child 关闭证据，而是读取失败。

修正：将 overlay discovery 结果区分为 present / proven_absent / unknown；只有新鲜、完整、精确 root inventory 的显式 absence 可以 pop。读取失败或身份矛盾应标 unknown 并拒绝后续输入，不能通过“undefined”恢复父目标。

验收：degraded、isError、不完整、错 root、无 geometry、Abort 都不 pop，不派发输入；完整精确 absence 才 fresh revalidate/capture 父窗并恢复。

## P1-3：截断或损坏的 accessibility inventory 仍能证明唯一 frontmost

证据：`verifyTransientNativeChild` 在 `cua-driver-computer.ts:123` 读取 accessibility inventory；`parseAccessibilityWindowEvidence`（`:227`）没有验证 structured 根的 complete/truncated/degraded 状态，且 flatMap 静默丢弃坏记录。即便漏掉真正更前的窗口，剩余窗口的 max zIndex 也会被当成全体唯一 frontmost。

独立复现：新独立 HWND 具 exact owner PID/HWND、zIndex=2，父窗 zIndex=1，候选 complete exact Menu root；`get_accessibility_tree` 返回 `{truncated:true, windows:[parent, child]}`，Tool envelope 本身非 degraded。调用 detectNewWindowHandoffCandidates 后输出 `truncated accessibility inventory auto-pushed child: true manual candidates: 0`。

修正：typed evidence parser 必须携带并验证 inventory completeness，且 malformed/重复/不可比较记录不能被过滤后继续证明唯一性。缺完整合同的 backend 不开放自动 child；保留手动候选或拒绝。可见状态应是明确证据，不能用缺少 false 当完整 visible 证明。

验收：structured truncated/degraded/complete=false、坏记录、遗漏 identity、重复 HWND、z-order tie/缺失、visible 未证明、owner HWND 缺失或错误、root 来自别 HWND，都不能 auto push。每条反例须穿过 adapter parser，不能只测试纯 Registry 的手填 boolean。

## P1-4：Monitor 仍按 session+viewport 分区，同尺寸 peer 混计

证据：`progress-monitor.ts:173` 将 Observation 归到 `observationPartition(computerSessionId, viewport)`；`:535` 的 key 只有 session hash、坐标空间和宽高。切窗已保持稳定 ID，因此 Browser/WPS/Notepad 相同 viewport 会进入同一分区。Runtime `run-controller.ts:2266` 也仅比较 screenshot fingerprint，未检查前后 Surface lineage；auto child 的变化可能被记为前动作的可比 screen transition。

独立复现：三个不同 Surface 标签、相同 session 与 800x600 viewport，每个各提议一次同点 click；第三次输出 `repeated_proposal`，关联三个 event。Surface 标签即使附在输入 event 上，也没有消费者。

修正：Monitor partition 使用 Run+SurfaceId+generation+geometry revision；跨 Surface/lineage transition 应为 unknown。普通 peer switch 后 reset Runtime 的局部 fingerprint 不足以清除 Monitor 已持久的同分区动作历史。

验收：同 Surface 重复仍被检测；跨 peer 相同 click、Browser→WPS→Browser 不拼成 repeat/A-B-A；child push/pop 和 document generation 改变不做跨 lineage 的 no-progress/causal change 强推断。

## P1-5：父 Surface pop 后旧引用可复活，modal 子窗也没有 barrier

证据：`surface-registry.ts` 的 popChild 关闭 child subtree，但父 Surface 保持原 generation 并直接 active。adapter reconcile pop 没有撤销父窗此前 observation/grounding。`clearTargetObservationState` 仅清显式传入的精确 leaf；push/pop 没有一套完整 lineage 清理。批准动作可通过 `executionObservationId` 指向新帧，因此单靠 latestObservationId 不能替代“旧引用不能复活”的生命周期合同。

独立纯状态复现：parent ref → push overlay → verified pop，输出 `pre-child parent ref executable after pop: true`。这证明 Registry stamp 失效规则不满足计划；本轮未把该结果宣称为完整审批 Run 漏投递。

另一反例：active transient child 未解决时，注册并 activate 另一个 peer，输出 `peer activation while transient unresolved: applied`。SurfaceRecord 没有 root role/modal/ownerSurfaceId；dialog 与 menu 都折为 native_window，无法落实 blocks_parent/blocks_owner_scope/unknown 的切换 barrier。

修正：child push/pop/返回父窗时明确撤销父旧 observation、coordinate、element 与 approval 能力；以 generation/geometry revision 或完整 lineage stamp 证明旧能力不可复用。补充有证据的 modal/ownership 表示，阻塞或未知模态 child 不允许直接 model peer switch；不把所有菜单盲目视为应用模态。

验收：旧 parent grounding/action/approval 在 pop 后不能因新 execution frame 而复活； fresh parent capture 后新 refs 可用。模态 dialog 未 dismiss 时 switch 不调用 bring_to_front；menu 非模态仅在策略证据允许时切换。

## P2 与覆盖边界

- 同 HWND overlay 没有稳定 overlay root identity。post-action detect 在已有 overlay 上仍可再次 push 相同 root，形成嵌套 overlay；absence 一次只 pop 一层。补 root identity/去重以及“菜单仍打开时重复动作不增树深度”测试。
- 普通 native observe 更新 geometry binding，但没有像独立 child geometry 变化那样统一 advance generation；应把 geometry revision/代次规则落实到公共与私有消费者，避免 Registry 代次只在显式 peer switch 时更新。
- `root_surface`、`overlay_root`、`geometry_verified` 的生产端 backend contract 尚未在本轮获得真实兼容证据。没有这些字段时 adapter fail closed 是可接受的“不支持”；手填 fake fields 通过不能表述成 pinned CUA 已支持自动 child。需要明确 capability 与版本合同。
- 纯 Registry 的 12 tests 使用手填 identityVerified/captureVerified/treeComplete/uniquelyFrontmost，合理验证纯 transition，但不能验证 parser 的证据来源。adapter 当前菜单正例和旧 ref 反例采用完整 fake root；缺同 HWND overlay 正/反例、owned Dialog complete root 正例、truncated inventory、wrong-root、z tie、modal barrier、父窗丢失/换代，以及审批等待中 generation 改变的集成测试。

## 已确认保留的正确行为

- 一个 descriptor ID 在 peer switch/handoff 后保留；Runtime receipt normalizer、Trajectory 和 cross-window probe 均改为要求相同 ID/backend。没有发现 handoffGeneration/transientMenuSurface 的旧双状态仍在 adapter 中使用。
- windowRefs 仍是兼容 list_windows/switch_window facade 的 opaque Map，值为 SurfaceRef，具有 refresh/switch/close 清理；不是新的 session 身份来源。sessionAfter 名称仍存在，但语义已是同 Session 的更新 descriptor，不能把该名称本身误报为每次创建新 session。
- desktop 使用真实 primary display Surface，没有伪造 HWND；overlay capture 沿 parent native identity；tab/DOM 私有 lineage 来自 managed Host target，个人 Browser 不因标题变成 DOM。
- peer list/switch 继续 opt-in、Host scope、fresh inventory、最多一次 foreground activation、exact capture，旧 coordinate/grounding refs 的已有跨窗测试通过。child 从 peer picker 排除。
- managed Browser 回 native 再回 Browser 重新 observe/DOM grounding，现有 roundtrip selftest 通过；DOM 的 contentRect/物理坐标合同未被 Registry 替代。
- multiline UIA 路径继续绑定 observation、surfaceRef、window binding/geometry；不确定结果为 partial 并撤销 observation/grounding，不续写/回放。pre-action inventory failure 不输入，completed receipt 后 inventory failure 留给 Runtime 终止处理；相关本轮 tests 通过。
- peer activation 后 Abort/capture failure 会 invalidation；unknown side effect 的异常路径没有自动重试；close 清理 window bindings、refs、grounding 与 Registry。没有执行真实 lease 生命周期验证。
- provider/cross-window/travel 对稳定 sessionAfter 与 fresh observation 的既有迁移 tests 通过；它们尚未消费 SurfaceStamp，不能代替公共绑定验收。

## 建议修复与复审顺序

1. 先修 overlay absence 与 inventory completeness 两个 fail-open 分支，补 adapter 反例。
2. 完成公共 Stamp/lineage、transition、prepared action/approval/Guard、Trajectory 的最小接线，同时修 Monitor partition。
3. 落实父引用撤销、modal barrier、overlay 去重和 geometry generation 合同；补 native/DOM roundtrip、child pop、approval 跨 generation E2E。
4. 复跑定向 tests/typecheck 后，再确认 backend root/owner/z-order capability；真实 GUI/API 仍需协调者单独放行。

本审查只新建本文；阶段入口/DOCS-INDEX 由协调者汇总更新，避免与共享文档并行编辑冲突。

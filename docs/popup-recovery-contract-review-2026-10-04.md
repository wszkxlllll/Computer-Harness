# Transient-parent recovery contract review

Status: conditional GO for implementation; no implementation or live GUI approval is implied by this planning review.

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

GO，无剩余已发现 P1；真实手机体验尚未验证。Web 只在用户点击具体候选时读取预览；初始候选和 handoff 分别绑定 device 的 opaque candidate token，以及当前 Run owner/requestId/candidate。Host 使用配对 cookie、CSRF 和捕获后 session revalidation；HTTP 与 Relay 路由只接受限定字段，不允许直接传入任意 PID/HWND。proof token 有效期两分钟，初始 proof 不超过候选列表有效期；刷新、候选或请求 token 改变会清除旧图与选择。预览前后核验同一精确 PID/HWND，允许 partial inventory 中的正向精确身份，不推断全局 absence。随后真正选择仍走原有精确 native verification。

预览使用临时只读 CUA session，不激活、不发输入、不创建 Surface/Run Observation 或资产；图片不进入模型上下文、轨迹或持久化文件。capture 信号上限 8 秒，cleanup 信号 5 秒；取消排队请求不新建 driver，清理失败保留待清理状态而不返回可确认图片。raw PNG 上限 1 MiB、Host/Relay JSON route 上限 2 MiB，并校验 PNG signature、canonical base64 和有界 viewport。Host 从鉴权之前就设置 no-store，包括错误响应；Relay 也使用 no-store。

人机确认必须等对应图片成功 load 后才开放；损坏图片、过期 proof、无法区分的内容保持不可确认，并真实标注捕获时应用/标题、时间和关系，缺元数据不冒用旧候选标题。requestId/run/candidate token 改变在 layout effect 中立即清旧图，防止先绘制过期截图。本审发现并由 UI 作者修复一处不一致：handoff 重读同一候选时曾保留旧已加载截图和确认按钮；现在与 Home 一样，开始重读即清旧图/loaded/error 状态，pending 或失败均不能凭旧图确认。

独立仅 preview/paired 请求 pattern 加遗漏的关键负例，34 项通过；包含实际本地 Host HTTP→Relay WSS 往返，但截图与手机 UI 仍为测试夹具，并非原生 CUA 加真实配对手机实测。覆盖 token/TTL/owner/request、CSRF/revocation、route bytes bound、partial exact identity、post-capture identity 消失、取消/cleanup、图片 load gate、缺元数据/失败图片、request token 清图，以及重新读取失败不留下旧确认。134/134 九文件与 scoped noEmit、后续 UI/Host 小回归均为作者报告，未计为本审独立整包验证。未 build dist、未 GUI 输入、未调用外部 API。实际手机触摸/解码、原生窗口捕获质量和网络取消延迟仍待真实验收。

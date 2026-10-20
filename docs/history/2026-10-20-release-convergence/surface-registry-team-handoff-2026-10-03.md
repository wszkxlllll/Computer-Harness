# Surface Registry 队友交接（2026-10-03）

## 目标与用户价值

Surface Registry 把一个 GUI Run 中的桌面、原生窗口、受管浏览器页签、DOM 文档、菜单、对话框和同 HWND overlay 表示为同一 `ComputerSession` 下可验证、可失效、可回放的 Surface 谱系。它解决的不是“多记一个窗口 ID”，而是：模型作出决策后，Runtime 能确认该动作针对哪个界面化身，窗口切换、弹窗出现、菜单关闭或页面换代后不再继续使用旧截图、旧坐标、旧 UIA/DOM 引用或旧审批。

直接用户价值是让跨窗口、菜单/弹窗和跨应用长任务保持连续，同时把错位点击、旧引用误操作和审批后页面已变的风险收敛为确定的拒绝、人工选择或重新观察，而不是猜测并重放动作。

## 当前状态

### 已完成（确定性实现）

- 每个 Computer 实例只维护一个稳定 `ComputerSessionId`；peer switch、child push/pop 和 browser tab/document 更新不再伪装成新 session。
- 公共 `SurfaceRef = { surfaceId, generation, kind, parentSurfaceId?, admissionSource? }` 已进入 Observation、Grounding、Approval evidence、Guard 评估、Runtime Event 和 Trajectory。新生产者不可产生 `kind=unknown`；它只用于旧轨迹的只读解码。
- CUA 私有 `SurfaceRegistry` 已实现 peer 注册/切换、transient child push/pop/deactivate、generation advance、unknown 吸收态和 close；原生 PID/HWND、driver token 与原始 UIA/DOM 标识不越过 Adapter 边界。
- Windows 已有注入式只读 `WindowRelationshipProbe`：使用线程 PMv2 DPI context、DWM visible-frame bounds、owner PID/HWND、foreground、visibility/minimized、window class 与显式 z-order 链；不读标题/文本，不激活窗口，不发送输入。
- Probe 与 CUA inventory 按 exact PID/HWND 合并。完整 probe 是 topology/bounds 权威源，CUA 只补充同一精确身份的 label；显式 truncated/degraded、foreground 冲突、重复身份、几何/关系冲突和不完整 z-order 均 fail closed。
- transient 分为独立 HWND 的 menu/dialog/popup 和同 HWND overlay。Stage 1 只评估精确 owner、visibility、minimized、parent/candidate 与所有者局部堆叠；Stage 2 必须用该候选 exact root 语义证明 Menu/Popup/Dialog，然后 Registry 才允许 child push。普通新 peer 不会因此自动获权。
- 同 HWND overlay 使用精确 root/geometry evidence；已 admitted child 复核失证时仍拒绝，未 admitted 且后端不具备 overlay 专用证据时不再让普通父窗口止步。
- 多行 `type` 保持一个公共工具，`elementRef` 可选。显式 ref 映射到当前 Observation 的 Adapter-private token；自动绑定只在完整 UIA catalog 中存在唯一、安全、空的文本编辑目标时启用。普通单行输入不依赖 token。多行只在同次 token-bound 返回 `confirmed + value_readback` 时记为 completed，其余为 partial/unknown 且不重放。
- Windows Notepad 菜单与 parent 回复已通过最终受控实机 bounded runner：Run outcome 为 `succeeded`，共 3 次 Provider call，全程保持同一 `ComputerSession`。Observation 谱系为父 `surface-1` generation 1 → 菜单 child `surface-2` generation 1（`parentSurfaceId=surface-1`、`admissionSource=win32_relationship_probe`）→ 父 `surface-1` generation 3；轨迹依次写入 `initial_observation`、`child_push`、`child_pop`。click 和 Escape 回执均为 completed，`run.finished` 已写入。收尾时 owner 已释放，lease 不存在/已释放，`cleanupConfirmed=true`。

### 正在验证

- Notepad 独立 Open dialog 尚需单独受控验证；已通过的 menu `child_push`/`child_pop` 不能自动代替独立 dialog 证据。
- WPS 的 Find/Cancel dialog、自绘 menu/popup 与 parent 回复。当前仅确认 same-HWND File panel 的 exact root 为 `Window` 且没有 overlay marker；系统因此正确保留 parent visual handling，并在 Escape 后恢复。测试未修改 WPS 文档，这不是 WPS 独立 dialog/menu 已通过的证据。
- 正确 foreground 组装下的 Provider→Runtime→CUA 多行端到端。已有 GLM Run 因测试组装成 background，`type` 被 capability filter 正常移出 tool catalog；该 Run 不是多行功能失败证据。

### 未完成

- Notepad menu `child_push`/`child_pop` 已通过；Notepad Open dialog 与 WPS 独立 dialog/menu 仍为 **pending**。不将 WPS same-HWND File panel 的 parent visual fallback 记为 child 准入成功。
- macOS/Linux 尚未提供与 Windows probe 等价的 owner/stacking/root-evidence 生产者，因此不可声称三平台自动 transient child 行为对等。
- 对于驱动无法证明 owner/root/stacking 的弹窗，仍需人工 picker/明确授权；不会回退到标题匹配、全桌面截图猜测或动作重放。

## 核心合同与生产者/消费者

| 合同/事实 | 生产者 | 消费者与更新规则 |
| --- | --- | --- |
| `ComputerSessionId` | Computer Adapter `open()` | Runtime/Trajectory；整个 Adapter session 不因 Surface 切换改变，`close()` 结束。 |
| `SurfaceRef` | CUA Registry；OSWorld desktop producer；Managed Browser Host attestation | Observation/Grounding/Action validation/Approval/Guard/Monitor/Trajectory/Context。切换、子表面、几何或 document incarnation 变化时换 ID/generation；旧 ref 失效。 |
| `computer.surface.transitioned` | Runtime 在 capture 表明 initial/switch/push/pop/generation change 时写入 | Reducer/Trajectory/UI 重建当前 Surface；不触发动作重放。 |
| `WindowRelationshipProbeSnapshot` | Host 注入的平台 probe | CUA inventory merge 与 transient Stage 1；仅 exact identity 合并，任一权威负证据/冲突都撤销自动准入。 |
| root/overlay evidence | CUA 对 exact candidate 的无截图 root-state 读取，或 Managed Browser Host attestation | `SurfaceRegistry.pushChild()`；证明对象是 root，不接受后代元素 role 替代根语义。 |
| `elementRef` | Adapter 从当前 Observation 的 bounded UIA/DOM catalog 生成 | Provider 只看到短引用；Runtime 校验 schema；CUA Adapter 在相同 session/Surface/Observation/geometry 下解析为私有 token。下一次 observation/切窗/几何变化后失效。 |
| action/approval Surface 绑定 | Runtime 将 decision Observation 的 `SurfaceRef` 写入候选与 evidence | Action validation、Risk Guard、Approval preview/execution。审批等待中 generation/parent/admission 任一变化就在 driver call 前拒绝旧动作。 |

Context 只投影必要的 Surface kind 和当前 grounding，不向 Provider 泄露 `surfaceId`、parent ID、PID/HWND、raw tree、token、profile 或 CDP identity。

## 跨平台边界与队友分工

`WindowRelationshipProbe` 是可选、只读、依赖注入的跨平台接口；Win32/PowerShell/PInvoke 仅位于 `app-runtime` 的 Windows 实现，portable Runtime、protocol 和 Registry 不得引用它。

- macOS 队友：从原生 window server/Accessibility 生产 exact window identity、owner/parent、visibility/minimized、physical bounds、foreground 和可验证 stacking；无法完整生产时返回 incomplete，不伪造 Win32 `source`。
- Linux 队友：按实际 X11/Wayland/desktop portal 能力实现平台 probe；Wayland 缺少 owner/z-order 时将 auto child 保持关闭，使用人工 picker，不从标题或截图推断。
- 两线只实现平台 evidence producer 与相应 fixture/native smoke；共享 `SurfaceRef`、Registry transition、Runtime/Guard/Trajectory 合同不分叉。不复制 Windows admission 逻辑或创建第二个 Surface 状态机。
- OSWorld 继续产生 desktop Surface；它的 desktop generation 验证不能代替原生平台 transient-child 验收。

## 已确认证据和已知边界

- 最终冻结源码的权威离线检查点：Node 24.19.0，authoritative merge/组装定向 254/254 tests 通过，全量 Vitest 为 105 个文件、1271/1271 tests 通过；主工程 typecheck、spike typecheck、build 与 dist checks 通过。这是已完成的实施/审查证据，不表示本文档更新时又重跑了测试。
- 受控原生 Notepad 已确认：新空白文档上的 Adapter 多行显式 `elementRef` 路径写入中文/数字/换行并返回 completed；独立单行无 `elementRef` 前台输入也通过。这不等于 Provider 端到端或 WPS/浏览器通过。
- 最新 Notepad 菜单 bounded runner（`runs/diagnostics/cua-notepad-menu-surface-probe.mjs`）已作为功能验收证据，输出保存于 `runs/diagnostics/notepad-menu-surface-1791028362519`：`succeeded`、3 次 Provider call、同一 ComputerSession、父→child→父 Surface 代次谱系完整、`win32_relationship_probe` 准入来源可追溯、click/Escape completed、`child_push`/`child_pop`、`run.finished`、owner/lease 清理确认。该证据只支持 Notepad menu 及其 parent 回复链路。
- Windows probe 的原生 complete 快照数量只有实施线的作者报告，独立审查未重做；不在本文档把该数量当成独立证据。
- 菜单和对话框需要“所有者局部”准入，不是整个桌面的绝对最前窗口。无关 Shell/helper/其他 app 不应阻断合法 child；同 owner 的更高 sibling、并列、未知 z-order、错 owner 或根语义缺失仍必须拒绝/人工处理。这是窄化证据域，不是放弃验证。
- Abort、transport 中断、partial/degraded 或结果含糊时不重试可能已发生的 GUI 副作用；进入 unknown/outcome_unknown 后要求重新观察或用户显式处理。

## 受影响文件（交接范围）

| 范围 | 主要文件 |
| --- | --- |
| 公共合同 | `packages/protocol/src/index.ts` |
| CUA 状态与证据 | `packages/computer-cua/src/surface-registry.ts`, `window-relationship-probe.ts`, `transient-window-admission.ts`, `window-root-projection.ts`, `window-contract.ts` 及同名 tests |
| CUA 编排/输入/Grounding | `packages/computer-cua/src/cua-driver-computer.ts`, `dom-grounding.ts`, `managed-browser-host.ts`, `index.ts` 及 tests |
| Windows probe 与组装 | `packages/app-runtime/src/windows-window-relationship-probe.ts`, `computers.ts`, `run-factory.ts`, `application-session.ts`, `managed-browser-companion.test.ts` 及相关 tests |
| Portable Runtime 消费 | `packages/runtime/src/run-controller.ts`, `contracts.ts`, `action-validation.ts`, `computer-tools.ts`, `action-effect-projection.ts`, `progress-monitor.ts` 及 tests |
| 审批/安全/回放/上下文 | `packages/app-runtime/src/approval-preview.ts`, `packages/risk-guard/src/index.ts`, `packages/trajectory/src/index.ts`, `packages/context/src/compiler.ts`, `packages/context/src/projections.ts` 及 tests |
| 其他 Computer producer | `packages/computer-osworld/src/osworld-computer.ts`, `action-mapper.ts` 及 tests |

上表是功能切片，不是当前脏工作区的全部 diff。当前工作区同时包含手机 UI、语音、README/开源材料、试点脚本和 Provider 诊断等其他修改，任何提交都不得使用全量 `git add .`。

## 建议的细粒度提交/PR 切片与合并顺序

1. **Protocol foundation**：只收 `SurfaceRef`/kind/admission/transition、Observation/Grounding/Approval/Event 字段，以及 OSWorld/Runtime/Trajectory/Context 为保持编译和 reducer 完整性所必需的最小消费修改。
2. **Pure Surface Registry**：`surface-registry.ts` 与纯状态机 tests；不含 driver I/O、Win32 或 Runtime 编排。
3. **Relationship evidence and Windows probe**：公共 probe DTO/merge/admission/root projection 与 tests，加 `app-runtime` 的 Windows PMv2+DWM 只读生产者/注入。其他平台不依赖该实现。
4. **CUA adapter integration**：稳定 session、peer switch、child push/pop、browser lineage、stale-reference cleanup 与 Adapter tests。这一片应保持可回退，不同时提交手机 UI 或 README。
5. **Runtime safety consumers**：Action validation、Guard/Approval、Monitor partition、Trajectory/Reducer、Context 脱敏投影与历史 trajectory 只读兼容。
6. **Multiline UIA type**：可选 `elementRef`、auto-binding 门、private token 映射、CR/LF 规范化、readback 和 partial/no-retry tests。这一片与 Surface 共用 observation/surface freshness，但应独立 PR 便于审阅和回退。
7. **Live evidence only after merge candidate is frozen**：Notepad menu/multiline、WPS dialog/menu、Provider foreground 端到端分别形成证据记录，不把实机日志或本机身份写入代码提交。

合并顺序建议为 1→2→3→4→5→6；4 与 5 的分支都应基于已合并的前置片重放，不应从当前大型 dirty worktree 直接整包提交。切片时按显式文件清单 `git add -- <paths>`，每片单独跑定向 tests/typecheck，最后才在集成分支跑全量。

## 本交接的操作边界

本文档来自当前源码、Git diff 以及 [SurfaceRegistry 集成独立审查](./surface-registry-integration-review-2026-10-03.md)、[owned transient 堆叠修复审查](./owned-transient-stack-fix-review-2026-10-03.md)、[多行输入实施记录](./multiline-type-implementation-results-2026-10-03.md) 收敛。本次未修改生产代码，未运行 GUI/API/测试，未提交或推送。

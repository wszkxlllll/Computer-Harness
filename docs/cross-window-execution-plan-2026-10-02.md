# 跨窗口执行与生活任务 Demo 实施方案（已批准；后续验收范围）

日期：2026-10-02。状态：通用跨窗口能力、Host-owned managed-browser companion、Web/TUI/CLI 接线及定向离线回归已完成并经代码审查。此前已有合成窗口上的 Provider API 探针和真实 SDK/managed-browser 往返证据；最近 compact tool descriptions 尚未重跑真实 API。完整生活任务、真实模型按目标选窗、其余 native 窗口恢复边界及公开页面部署仍未验收。用户要求本轮实现先闭环；在用户再次明确“现在开始”之前不开展新的真实 API、桌面或录像任务。详细证据见[实施与验证记录](./cross-window-implementation-and-validation-2026-10-02.md)。

## 1. 当前事实与真正缺口

- 四种起始模式保持独立：自动选择、手动窗口、Harness-managed browser、整个桌面。起点决定 Run 从哪里开始，不是模型之后切窗的权限边界；四种模式均可通过同一个跨应用开关 opt in，desktop 路径也有测试覆盖。
- 公共 Run opt-in 是 `switchWindows?: boolean`，Host 将其解析为 `windowSwitch: "opened-windows-v1"`；默认关闭。模型随后使用同一 ToolRegistry 的 `list_windows` 和 `switch_window`，不需 Jev 或 scripted Provider 预选目标。
- `windowSwitchAllowedTargets` 是 Host-only 精确范围：省略表示 opt in 后暴露 Adapter 返回的所有受支持已打开窗口；`[]` 表示 deny-all；非空列表只允许精确目标。若 managed-browser 初始路径/companion 需要把自有 browser target 加入一个显式非空 scope，`[]` 属于矛盾配置并在创建资源前拒绝；Host 只追加本 Run 自有 browser target，不扩大到其他窗口。
- `managedBrowserCompanion` 是单一 resolved per-Run 字段；浏览器 profile 的默认 saved/temporary 偏好由 Host 设置在装配 Run 前读取，当前 Web 不提供任务级 profile 选择。Host/RemoteRun API 仍为旧客户端保留 browser target 的 `sessionMode?: "saved" | "temporary"` 兼容覆盖；不能据此说公共 API 完全没有该字段。它只选择会话模式，不接受 profile path/label/Cookie。companion 字段和本机 profile 元数据不进入 Provider Context 或报告。浏览器初始目标与 native/desktop 初始目标加 companion 共用 `ManagedBrowserComputer` 生命周期。
- 任一初始 binding 切换到 Harness 自有 managed browser 时恢复该绑定的 DOM + UIA；切离后 DOM grounding 关闭；切回时重新采集 fresh tab/DOM，不复用旧引用。个人浏览器仍不能因品牌或标题获得 DOM 权限。

## 2. 产品边界

用户开启“跨应用完成任务”后，模型可在同一 Run 中查看当前 Host 范围内已打开的受支持窗口清单，并自行依据 Goal 选择 opaque 引用。没有 Host 精确范围时，清单是 Adapter 能报告的所有受支持顶层窗口；应用名/标题可能含个人信息并会发给本 Run 的模型。初始自动匹配/人工选窗仍决定启动 binding，但不是之后切换的授权边界。后台或最小化窗口可出现在 inventory；仅列出不代表可操作，切换仍需 fresh identity/geometry/activation/capture 验证。

默认 `switchWindows` 为 false，旧单窗口 Run 不变。一次 opt-in 同时允许该 Run 列窗和切窗，不再为每个窗口切换弹出单独审批；Guard 对真正高风险副作用（例如删除、外发、付款、账户/隐私操作）的既有策略仍生效。Host 可用精确 allowlist 收窄范围；窗口标题是非可信环境文本，不做 Goal 语义授权。未能验证的目标、身份变化、激活失败或结果未知会停止并将当前目标标为 unknown，不会复用旧截图/坐标或自动重放。

不自动安装或启动新应用，不接管个人浏览器的调试连接，不自动降级为整桌面，不使用 Alt+Tab 猜窗口顺序，不在每个动作前重复抢焦点，不恢复/重放结果未知的输入。Jev 不是必需依赖：主 Provider 已能消费窗口标题和应用名称并选择引用。

## 3. 模型工具与公共合同（已实现）

采用统一 ToolRegistry 投影，两个 Provider 不另维护窗口工具清单：

1. `list_windows()`：只读，返回当前 Run 授权范围内的候选 `{windowRef, appName?, title?, isCurrent}`。目录只包含显示与选择所需信息，不提供 profile、调试地址、Cookie 或私人驱动句柄。
2. `switch_window({windowRef})`：有 GUI 影响的 Computer 工具，不伪装成无副作用的 side tool。只接受程序刚发现的引用，不接受模型自编 PID/HWND 或应用字符串。

候选引用是 Adapter 私有映射的 Run 内不透明 token。发现时创建；重新发现、切换、Run 结束或目标失效时清理。不能因普通的一次新截图就全部失效，否则 `list_windows → 下一轮 switch_window` 无法工作。派发前仍重新核验真实目标，不靠 token 有效就盲目执行。

运行时工具转换为以下受约束动作：

```ts
// 工具参数由 Runtime 转为统一动作；basedOn 是本轮决策帧。
type SwitchWindowAction = GuiActionBase & {
  kind: "switch_window";
  windowRef: string;
};

// 仅成功的 switch_window 回执可产生该字段。
// Computer 生产，Controller 校验/消费，Trajectory 保存，Reducer 重建。
interface ActionReceipt {
  // 保留现有字段
  sessionAfter?: ComputerSessionDescriptor;
}
```

`ActionIntent`、receipt 验证和 trajectory 已实现上述合同：普通 click/type 不可携带 `sessionAfter`，failed/refused 切换不会被当作成功 binding 更新；switch 开始后旧 Observation 立即失效。新 session 的 backend、ID、viewport、capabilities 来自实际捕获，不由模型提供。该字段不是任意状态 patch。

Computer 提供可选只读 `listWindows(session, signal)`。只有 Run 明确启用且 adapter 实现该方法时才注册工具。OSWorld/external 不实现时，开启能力会明确拒绝而非静默忽略；不声称跨平台实机验收。

## 4. Runtime 流转

```text
当前窗口观察 → Provider 决定需要另一个应用
  → list_windows 的 ToolResult 进入现有历史
  → 下一轮 switch_window(windowRef)
  → 工具/参数/引用/授权范围/预算/Abort/动作安全校验（切窗不另触发单窗口审批）
  → append action.execution.started
  → 精确发现目标 → 一次激活 → 新身份、几何与截图核验
  → Receipt + sessionAfter
  → 提交终态事实 → 更新当前 session、清空旧观察和候选
  → 重新 observe 并提交新帧
  → Provider 用新窗口的截图与控件目录继续
```

- 首版切窗必须单独一轮，不与 click/type、Batch、Plan/Memory mutation 或 terminate 混用，防止切换前生成的后缀动作误落到新窗口。
- 切窗计入动作预算，发现计入普通工具/模型请求预算；沿用串行 Controller、inbox、暂停、Abort 和 Guard。切窗本身由本 Run 的 opt-in 授权，不逐窗要求用户批准；后续高风险动作仍服从 Guard，不另建执行循环或并发控制桌面。
- 激活只是请求，不证明成功；验证失败不继续输入。若激活结果未知，记录未知/失败并停止，不自行切回或重试抢焦点。证据未持久化不能开始后续输入。
- 复用既有交接后的清理逻辑；模型主动切窗和人工 handoff 走相同的目标转换实现。不要复制第二份清理、激活和观察逻辑。
- 现有 new_window_detected/foreground_mismatch 的人工流程先保留。模型主动切窗首版不静默取消它们；随后用同一目标转换接口接入可选自动候选选择，不能仅修改 reason 字符串就开放所有弹窗。

## 5. CUA、DOM/UIA 与上下文

将启动配置与“当前目标”分开：启动 options 负责权限、Grounding 选择和受管浏览器生命周期；当前 binding/session 负责正在操作哪一个窗口。抽取一个私有目标转换操作，供旧 handoff 和 switch_window 共用。不另起一个业务包，不重写 CUA 输入。

- 原生窗口：能读取时使用 UIA，始终有视觉坐标回退；UIA 失败的行为沿用实际捕获合同，不宣称已解除 pinned CUA 的截图/UIA 耦合。
- 本 Run 拥有的受管浏览器窗口：只有经过既有所有权/目标绑定校验才恢复 DOM+UIA。切到 WPS 时禁用该目标的 DOM；切回时重新识别当前 tab并采集，不复用旧 DOM ref。
- 普通个人浏览器：只能视觉/UIA；不能因为应用名是 Edge 就连接其 DOM。
- 浏览器/profile 由 Run 持有，离开浏览器窗口不关闭、不删登录状态；Run 结束才按既有生命周期释放。每个动作使用当前 session 的 viewport。
- Registry 在 Run 启动时按可支持能力注册稳定工具上限；当前目标不支持的工具由现有准入明确拒绝，Context 动态写明当前可用能力。无 DOM 时不得提示 select_option 可执行。两 Provider 必须从同一 Registry/能力投影消费。
- 稳定 system/tool 描述不随窗口标题重写；当前目标、候选、能力、观察属于动态信息，避免为切窗无谓破坏提示前缀稳定性。
- Plan 和业务事实保留在同一 Run。session-scoped Memory 不因切回同一应用就自动重新成立；切窗后按既有 scope 规则排除/标待核实。run-scoped 的已查结果保留，仍区分事实来源和当前页面状态。

## 6. 安全与失败处理

既有 tool policy、Guard 开关、窗口精确范围和高风险动作确认保留。Run opt-in 授权模型调用列窗/切窗工具；切换不逐次要求用户审批，但仍经过精确 ref、范围、身份、预算、foreground 与 fresh capture 校验。范围校验是确定性的，不宣称能验证模型选择在语义上正确，也不为每次切窗额外调用另一个模型。

标题/应用名是非可信环境文本，只作选择证据，不作系统指令。候选刷新后不匹配、窗口退出、无法读到身份、激活被系统拒绝时返回明确失败/拒绝。手动兜底只选择真实候选，不清理未知 lease，不取消原有前台保护。新的目标获得有效观察前，旧 Grounding、待执行动作和旧坐标不可继续消费。

需要单独验证“激活已发生但新截图/落盘失败”的崩溃边界；此时不得把旧窗口状态当当前状态，不自动重放。修改事件结构要同步更新 reducer/schema/报告/手机通知的消费者，不添加无人维护的 currentApp 等重复字段。

## 7. 开发与验收顺序

1–3. Runtime/Computer 生命周期、Context 与共享 Registry、Host/Web/TUI/CLI/profile 设置的实现和定向离线测试已完成；各阶段证据与独立复核范围见[实施与验证记录](./cross-window-implementation-and-validation-2026-10-02.md)。
4. 已通过的真实 SDK scripted 往返只验证 native↔自有 managed browser binding、DOM 来源切换和 Host 清理，不等价于真实模型选择或生活任务。仍待明确授权后的真实模型任务、native↔native、项目 CUA 对最小化/resize/关闭旧引用的验证，以及桌面/多窗口高风险场景的有界验收。
5. 完整生活任务 Demo 尚未执行；不得把工具链和模拟通过描述为“全自动跨应用”业务成功。政务批次仍暂停。

## 8. 最终 Demo 候选

候选 Goal：在携程查询指定未来日期上海到南京的直达列车，选取最多两个符合用户时间/预算约束的可见选项；在高德查南京南站到一个已预检的公开目的地的接驳；切换到已打开 WPS，将查到的铁路和地图信息分开整理为行程单，注明来源、观察时点和未知项，保存为指定测试文件，不预订、不支付、不发送。

展示链路：手机语音/文字发起 → 浏览器查询 → WPS 编辑/保存 → 必要时返回浏览器核对 → 手机查看结果/听取已完成进度。日期、站点和地图目的地须在执行前冻结并预检，不能固定过期日期。WPS保存/导出可触发新窗口，其策略和人工确认次数必须如实展示。

完成依据：查询约束符合、报告与截图字段一致、WPS成果保存正确、至少一次跨应用切换和切回成功、无未经授权副作用。允许选择中断/失败的展示素材说明恢复；精选 Demo 不代表六类场景成功率。

用户于 2026-10-02 批准按此方案开发。已发生的合成 fixture Provider API 探针和受控 SDK 桌面往返列于实施记录；紧凑工具说明尚未真实 API 复测。此后用户暂停新的 API/桌面/录像，必须等明确“现在开始”。政务批次仍暂停，不因跨窗口开发授权自动恢复。不得将本方案中的生活任务候选目标或剩余验收清单写成已完成结果。

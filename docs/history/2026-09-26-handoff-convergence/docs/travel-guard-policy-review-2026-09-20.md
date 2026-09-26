# Travel TUI Risk Guard 审查说明

日期：2026-09-20
文档角色：审计/用户规则审查。状态：集中代码复核完成，预览接入；真实业务未验收，用户要求停止追加实验。
当前入口：[出行试点第11节](../../../travel-pilot-preparation-2026-09-20.md#11-两次真实票务运行guard与审批交互整改)。
范围：当前工作树中的 `LayeredRiskGuard`、Runtime 审批边界和 Monitor 状态修复。本文是用户审查材料，不代表已经重新启动真实 TUI 或完成真实桌面验收。

**用户本轮决策：** Guard 先保留逐次审批；窗口限定后切换到 PowerShell，只要 capture target 没有改变，可以作为本轮可接受的操作方式。Run approval grant 仅作为后续候选，不阻塞本轮。查询关键词特例不加入，当前仍不扩大审批授权。

## 先区分真实运行与当前源码

用户最近的两次 TUI Run 发生在本轮修复前。两次 Run 都是 `riskGuard=layered`、`riskModel=off`，每次出现 3 次审批，原因均为 `external_commitment / semantic_review_unavailable`。对应证据只在本地 ignored `runs/travel/tui-*/run-*/metrics.json` 与 `trajectory.jsonl`；本文不复制截图、账号信息或完整目标文本。

当前工作树已经修改并构建；重新打开TUI才会加载新版本，不能把下面的新行为写回旧Run。用户决定停止新增实验，当前保留逐次审批和已知前台切换限制。一次本地scripted-provider审批已进入/解决，但click被驱动报告foreground_unavailable，未计为动作通过；不把这个报告当作新的真实业务验收。

## Guard 在动作前的实际链路

```text
Provider ModelTurn
  → ToolCall + model-declared declaredEffect
  → ToolRegistry 参数校验 / canonical ActionIntent
  → Runtime Policy
  → LayeredRiskGuard
  → allow / require_approval / deny
  → action.proposed → action.execution.started → Computer.execute
```

Guard 位于真实 GUI 副作用前。Guard 拿到的策略输入包括当前 Goal、最近用户输入、当前 Observation、Task/Memory Snapshot、ToolCall、canonical ActionIntent 和 ComputerSession；但本地规则路径实际扫描的是动作声明和结构化动作，不会自动 OCR，也不会把整张截图理解成业务语义。

主模型写入的 `declaredEffect` 是不可信的风险线索，不是安全证明。Provider 可以漏报或错误声明，Guard 不能仅凭模型声明保证安全。

## 当前分层标准

规则按以下顺序执行：

1. Computer 调用缺少效果声明：`deny`，原因 `missing_effect_declaration`。
2. 命中宿主明确禁止的快捷键：`deny`，原因 `forbidden_shortcut`。
3. `effects` 含 `destructive`、`financial`、`external_commitment`、`sensitive_disclosure` 或 `security_change`：本地直接 `require_approval`。
4. `type` 文本命中有限的凭据/高风险值模式（例如 `sk-...`、13–19 位数字、`password=`、`密码=`）：本地直接 `require_approval`，不能被低风险模型复核降级。
5. `unknown` 效果、动作与声明矛盾，或声明文本命中未声明的风险词：进入语义复核路径。
6. 其余明确的低影响声明：本地 `allow`。

本地文本扫描只检查当前动作声明的 `target` 与 `summary`；不扫描整个 Goal、Plan、Memory 或模型思考链来触发每个动作审批。Guard事件中的结构化`type`动作摘要仅保留`textLength`，但这不等于整份轨迹脱敏：原始ToolCall、Provider交换，以及模型写入的target/summary仍可能包含输入原文或私人信息。本地运行资产不得直接公开上传。

当前关键词包括：

| 类别 | 例子 |
|---|---|
| financial | `pay`、`purchase`、`transfer`、付款、购买、支付 |
| external commitment | `send`、`publish`、`post`、`submit`、发送、发布、提交 |
| destructive | `permanently delete`、`erase`、清空、永久删除 |
| privacy/account | `password`、`permission`、`credential`、密码、权限、凭据 |

### 查询按钮误报的当前状态

本轮不再通过增加“查询按钮”关键词特例来放宽审批。当前源码仍把 `submit/提交` 命中视为需要语义复核的风险信号；在 `riskModel=off` 且没有 assessor 时，仍会 fallback 到审批。这样不会把“查询”误判修复冒充成安全放行。

后续更合适的候选方向是显式的、用户选择的 Run 内审批复用（见下文的审批复用设计约束）：用户明确授予某个稳定动作范围后，后续同一动作可以复用该授权；它不是关键词放行，也不是每次按 Y 自动永久授权。该复用方案当前未实施。

## 何时调用风险模型、何时审批

只有进入 `semantic_review` 的不确定动作才会调用可选 `RiskAssessor`，并受独立的请求数和超时预算限制。风险模型必须返回单个 `risk_classification`，结果含 `effects`、`alignment` 和短证据。

当前 Travel TUI 配置是 `riskModel=off`。因此：

- 高风险效果不调用模型，直接审批；
- 不确定动作没有 assessor 时，fail-closed 为审批；
- assessor 超时、失败或预算耗尽时，也 fail-closed 为审批；
- fallback 原因现在保留原始触发原因，例如 `declared_unknown`、动作/声明矛盾或具体文本信号，而不是只显示“语义不明确”。

这解释了旧 Run 中查询按钮为何“莫名其妙”要求审批：旧实现把 `提交车票查询` 的“提交”当作 external commitment；旧配置又关闭了风险模型，所以最终落到了 `semantic_review_unavailable → require_approval`。当前工作树暂不通过查询特例绕过这一审批。

## 审批后的重新验证

当前工作树的审批流程是：

```text
approval.requested
  → 用户 Y
  → fresh observe
  → 比较私有截图指纹
  → 一致：执行原 ActionIntent，executionObservationId 使用 fresh observation
  → 不一致/证据缺失：拒绝旧 ToolCall，不执行、不自动重新批准
```

指纹是 Runtime 私有的当前 Run 状态，不进入公共 protocol、Provider Context 或模型工具 schema。它比较 session、mediaType、byteLength、viewport 和截图字节 SHA-256；不比较 observation UUID，因为每次 observe 都会生成新的 UUID。

这只能发现截图字节或 viewport 表示变化，不能证明：

- 页面语义仍然适合该动作；
- 同一截图下焦点没有变化；
- 隐藏窗口、输入焦点或系统状态没有变化；
- 动态光标、时钟、动画不会造成误拒绝。

因此当前所有审批后的 `type`/`keypress` 都采用保守策略：没有独立键盘焦点证明时不执行，转为 `waiting_user`，提示用户手动确认或完成输入，再用 TUI `I` 描述当前状态；Runtime 不自动重试该键盘动作。当前 Computer 合同没有独立 focus-proof 字段，不能宣称截图一致就保护了键盘焦点。

如果 fresh capture 本身失败，Runtime 只允许在“采图失败”边界尝试后续重新观察；截图资产写入失败或 Runtime event 落盘失败会让 Run 失败，不会拿旧 observation 继续执行。

## 审批复用：候选设计，当前未实施

用户提出的“同一动作批准后后续复用”不能等价于把第一次按 Y 变成永久放行。当前实现仍是 **一次 ToolCall 一次审批**；本节只记录下一步设计候选。

建议把授权分成两种明确语义：

- **One-shot approval**：现在的 Y，只批准当前 ToolCall；审批后仍必须 fresh observe。
- **Explicit Run grant**：用户额外选择“本 Run 对同一动作范围记住批准”，例如 TUI 中单独的 `remember for this run` 操作。不能由连续按 Y 隐式触发，不能跨 Run/跨机器持久化。

候选 `RunApprovalGrant` 至少需要绑定以下范围，不能只绑定坐标或工具名：

1. canonical action kind 与规范化参数摘要；文本值不保存原文，敏感输入使用不可逆摘要或只保留长度/类别；
2. 当前可用的 `ComputerSession.id`、坐标空间和 viewport；当前公共合同没有稳定的控件/窗口语义身份，因此换窗口、重连、close/open 后必须失效，不能凭空加入一个 generation 字段假装已有目标证明；
3. declared effects 集合、target/summary 的规范化意图摘要和当时的 Guard policy version；效果升级不能复用低风险授权；
4. Goal/correction 版本摘要；用户纠正、Goal 改变、Run 分支改变后失效；
5. fresh observation 的可信上下文证据。Grant 只能减少重复的用户确认，不能跳过页面变化校验、Host deny、protected input 或 Abort。

安全的最小范围应先排除 `financial`、`destructive`、`sensitive_disclosure`、protected input 和键盘 focus 未证明的 `type/keypress`。`external_commitment` 即使用户选择复用，也应要求独立的高风险确认，并默认不加入第一版。不能通过“查询按钮”关键词例外或坐标相同来绕过审批。

### 这对最近六次审批能解决多少

两次旧 Run 各出现 3 次审批。每次 Run 内点击坐标分别重复为约 `(852,785)` 和 `(855,785)`，但六次审批对应的 decision observation 截图文件 SHA-256 均不同；viewport 都是 `2560×1600/physical`，但 observation ID、截图内容和页面状态并不相同。因而：

- 只按坐标或工具名复用会把不同页面状态误当成同一动作，不能接受；
- 按当前严格截图指纹校验，这 6 次中没有一组可以安全地自动复用；
- 显式 Run grant 将来最多只能减少“同一 session、已有目标证据、同一语义、同一可信画面证据”下的重复确认；当前没有稳定目标身份，不能保证这次旅行任务的三次查询审批全部消失；
- 如果页面因加载、光标、时钟或动画导致字节变化，精确指纹还可能误拒绝，这需要单独测量，不能用近似图像或关键词先行放宽安全边界。

因此当前建议先审查并冻结 grant 的用户交互和失效规则，再单独实现与测试；本轮代码没有新增 grant 状态、公共协议字段或自动批准路径。

### 两种复用方向的取舍

| 方案 | 安全依据 | 对最近六次审批的效果 | 判断 |
|---|---|---|---|
| 严格截图指纹 + exact action grant | 同一 Run、同一 session、同一 action 参数摘要、同一 target/summary、同一截图字节与 viewport 才复用 | 六个 decision observation 的 SHA-256 均不同，安全复用数为 0 | 安全性清晰，但不适合作为主要体验解法；动态页面也会造成误拒绝 |
| 用户显式 task-scoped grant | 用户明确选择“本轮允许某类低风险查询/导航”，Runtime 仍逐动作校验并保留失效条件 | 可能减少同一任务中重复的低风险确认，但不能保证消除这六次审批 | 更贴近体验，可作为后续最小方案，但不能由模型声明或关键词自动产生 |

第二种方案也不能直接变成“本 Run 所有点击都放行”。当前公共合同没有稳定的控件语义身份或可验证的窗口/焦点身份，不能凭坐标、工具名或模型写出的 `target` 证明后续点击仍是同一个查询控件。当前可落地的最小边界应是：

1. 由用户在 TUI 审批界面显式选择一次“本轮允许低风险查询/导航”，这个选择是 grant 的唯一生产者；普通按 Y 不创建 grant。
2. Runtime/Guard 是唯一消费者。grant 只允许 `navigate`、无敏感输入、无 `financial`、`destructive`、`sensitive_disclosure`、`security_change` 的低风险点击/等待；不覆盖 type、keypress、protected input、Host deny 或 Abort。
3. 每个后续候选仍需重新做参数校验、动作预算、session/viewport 检查和声明一致性检查。效果升级、缺少声明、`unknown`、明显支付/购买/发送/删除/订单/申请等冲突词，不能由 grant 覆盖，必须回到审批或 deny。
4. Goal/correction 版本、ComputerSession、运行状态或用户明确撤销都会使 grant 失效。grant 只存在于当前 Run，不写入跨 Run Memory，也不把敏感原文写入授权记录。
5. 如果当前动作没有稳定的目标绑定证据，系统应把它标记为“用户显式信任的低风险类别”，而不是声称已经证明了具体控件身份；这限制了它只能用于用户愿意承担的查询/导航体验实验。

这个最小方案能减少“同一任务中反复确认低风险查询/导航”的交互负担，但不能安全地把支付、订单提交、账户修改或任意 `submit` 都纳入复用。若任务必须跨页面变化继续点击，仍需要后续的可靠控件/目标身份能力；不能用一个抽象 grant 字段伪造这项能力。当前 grant 仍未实现，等待用户审查后再决定是否进入代码。

## Monitor 与审批状态

Monitor 仍会消费 `waiting_approval`、`waiting_user`、`paused` 等控制事件以更新内部状态和生命周期；但只有 Run 处于 `running` 时才落盘 `monitor.proposal`。因此审批请求不再触发：

```text
monitor.proposal requires running status, got waiting_approval
```

这是一项状态机/事件落盘修复，不会自动放宽 Guard，也不会替代用户审批。

## 当前安全边界与未解决问题

已实现的规则是可审计的本地分流，不是通用 GUI 安全证明。仍可能存在：

- 模型低报或伪造低风险 `declaredEffect` 时的漏报；
- 未覆盖的语言、按钮命名和业务语义造成误报或漏报；
- 纯文字规则无法理解截图中的真实控件含义；
- 动态截图造成精确指纹误拒绝；
- 相同截图但焦点已变化的情况无法由当前截图指纹发现；
- Risk Model 打开后仍只是第二层语义意见，不能覆盖宿主 deny 或 protected input 的强制审批。

因此本轮结论只应是：查询类误报暂不通过关键词特例放行；审批等待期间的旧屏幕复用得到 fail-closed 保护；Monitor 状态错误已修复；Run 内审批复用仍是候选设计，尚未实施。真实 CUA/TUI 体验、动态页面误拒绝率和模型声明欺骗下的安全效果仍需在重新构建后的独立实验中验证。

## 本轮放行边界

本轮按用户决定继续采用每个受保护 ToolCall 单独审批，并保留 fresh observe、严格截图证据和键盘焦点保守策略。窗口限定后切换 PowerShell 只有在底层 capture target 实际保持不变时才接受；这不是对页面内容、焦点或动态截图稳定性的证明，不能据此取消 fresh observe，也不能承诺不会出现 hash 误拒绝。审批复用 grant 不属于本轮阻塞项，待后续有稳定目标身份和独立实验后再评估。

## 离线验收证据

- Risk Guard 与 Runtime focused tests（移除查询特例后重新运行）：99/99 通过（Risk Guard 22、Risk Guard Runtime regression 4、Runtime 73）。
- Runtime TypeScript typecheck：通过。
- `git diff --check` 与 UTF-8 replacement-character scan：通过。
- Guard实施worker自身没有调用真实API或操作桌面；后续整体窗口探针的真实操作与未通过项见当前入口。没有截图上传、commit或push。

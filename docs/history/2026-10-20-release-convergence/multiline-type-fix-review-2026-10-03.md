# 多行 type 修复独立审查（2026-10-03）

## 结论

**NO-GO：当前多行路径还不能作为完整生产修复放行。** 没有发现 P0；有两项 P1，分别是读回确认未绑定写入元素、绕过已有新窗 inventory/handoff 合同。公共 `set_text_value` / `elementValue` 和隐藏 Enter 拆分已经从当前源码清理，单行路径及 partial→outcome_unknown 主链可以保留。旧 transient popup 候选代码不属于本轮已验收的多行修复。

这是只读代码审查及离线模拟验证，写入本审查文档；没有修改业务代码、运行 GUI、调用模型/API、操作服务、提交或推送。工作树包含多项并行修改，以下定位和测试对应本次读取时点，不能代替最终合并后的再验证。

## 独立验证证据

先完整读取项目 AGENTS.md、runs/raw-cua-multiline-20261002/audit.md、raw-results.json 和 change-inventory.md，再读取相关源码及 git diff。原生 Notepad 结果是 **2026-10-02 的历史实验**，本轮没有重复实验。历史记录支持 foreground 多行可能损坏、background fresh-token 写入保存字符、换行 LF/CRLF→CR；不支持 WPS/Word/浏览器或 transient menu 的实测结论。

本轮使用仓库配置的独立 Node **v24.19.0** 工具链；没有使用 PATH 上的 Node 18 运行测试。

| 本轮实际执行 | 结果 |
| --- | --- |
| Vitest：computer-cua/cua-driver-computer、runtime/computer-tools、runtime/index、runtime/progress-monitor、trajectory/index、voice/index | 6 文件、273 tests 通过 |
| Vitest：risk-guard/index、provider-qwen/index、provider-glm/index、computer-osworld/index、runtime/action-effect-projection | 5 文件、98 tests 通过 |
| Node 24 `node_modules/typescript/bin/tsc -b --pretty false` | 失败：并行新增 surface-registry.ts:340、363，`false \| SurfaceRecord` 不能赋给 SurfaceRecord。不是多行代码错误；全工作树仍不能报告 typecheck 通过 |
| Node 纯 mock 调用现有编译产物 verifyFreshMultilineValue | 两个本应拒绝的样本返回 true，见 P1-1 |
| Node 纯 mock 调用 executeMultilineType，driver 抛含 token 的 Error | 异常 message 保留原始 token，见 P2-1 |

以上为 **371 项独立执行的测试**，不是转述作者的“301 项”。数量多并不弥补下面列出的缺少边界；部分测试还覆盖跨窗口等并行工作。两组 Node mock 通过 `Object.create(CuaDriverComputer.prototype)` 构造对象，driver 为内存函数，没有开原生 session、连接 daemon 或发送输入。tsc 虽然返回失败，已存在的编译产物中核心方法与本轮源码逐项一致；mock 使用的是这些现有方法。

## P1-1：fresh readback 可以把其他文本元素当成目标成功

位置：packages/computer-cua/src/cua-driver-computer.ts 的 `verifyFreshMultilineValue`（1423–1457，重点 1442–1448）。请求带准确 session/PID/HWND，且 snapshot 要与 pre snapshot 不同，这是必要条件，但当前只统计 **value 为 string 的文本 role**，要求其数量为 1、文字规范化后相等。它没有关联 dispatch 的目标元素，也不要求 post catalog 完整、未截断，未复核返回身份和 geometry；native 页/控件更替也没有独立代际证据。

独立 mock 1：pre 目标是 Document；post 同时有 Document（无 value，代表读不到目标）和另一个 Edit（value=`first\nsecond`）。结果 **accepted=true**。目标写入可能失败，而另一个字段已有相同文本；当前代码仍给 completed 并允许 Run 继续。这个场景不依赖伪造跨窗口回包，是同窗口两个合法文本节点。

独立 mock 2：post `snapshot_id=s00000002`、`truncated=true`、`complete=false`，携带另一个身份 `pid=999/window_id=999/generation=999`，唯一有 value 的 Edit 匹配 expected。结果也为 **accepted=true**。跨身份回包不是本轮原生实测；该样本证明 adapter 没有拒绝这些矛盾字段。截断/目标缺失则是普通可发生的读回边界。

修正原则：确认必须绑定同一目标，且必须证明新 snapshot 中目标仍属本 session/exact window、可可靠识别，完整读回中的同一元素逐字匹配。token 随 snapshot 更新，不能简单要求新旧 token 相等；应使用驱动支持的稳定身份/可靠目标重新解析。如果无法证明同一目标，就返回 partial，不能用“唯一有值文本节点”猜测成功。保留不重试语义。

验收补齐：目标 value 缺失但其他 Edit 正好匹配、目标消失后另一个文本控件出现、截断/不完整 post catalog、post identity/geometry/代际矛盾、显式 ref 在多个编辑器中成功解析、两个可读编辑器中的指定目标成功读回。当前“mismatch”测试只覆盖一个 Document 内容不同，没有覆盖这些情况。

## P1-2：多行提前 return，绕过 opted-in foreground 的新窗保障

位置：cua-driver-computer.ts `execute` 1138–1139、1257–1279，`clearTargetObservationState` 978–990，`detectNewWindowHandoffCandidates` 799–807；run-controller.ts 2230–2239。

多行分支直接返回 executeMultilineType，未进入后面的 `detectNewWindowHandoff=true` 预动作 visible-window inventory / baseline。completed 又清空 preActionWindowBaseline，Runtime 虽然照常调用 post-action detectNewWindowHandoffCandidates，adapter 因 baseline undefined 立即返回空列表。因此多行发生输入前 inventory 失败不会阻止输入，输入后出现的新对话框也不会走该动作的新窗确认链。

这与项目 AGENTS.md 明确要求的“opted-in native foreground Run 完成 GUI 动作后新窗 diff、inventory 失败阻止输入或在完成 receipt 后 fail Run”冲突。新调用内部使用 background 是正确的避损坏路线，但 Run 仍配置 foreground；不能因内部 delivery_mode 改变就默默省略 Run 的窗口安全合同。

修正原则：复用既有 inventory 准入和 fresh baseline，确保多行成功后保留一次可消费的新窗 diff 证据；清理旧 observation/token 时不要连同完成后必须消费的 baseline 丢弃。inventory 失败必须遵守既有 no-input / completed 后 fail 语义。未知或 partial 结果仍立即终止，不再发送输入。加入 opt-in 多行+新窗、输入前 inventory 失败、完成后 inventory 失败的定向测试。

这只是指出新多行分支与旧 popup/handoff 链的冲突；旧 transient menu 识别、Dialog/MenuItem 路由及前台候选本轮没有原生证据，不能写为已经修好。

## P2-1：正常投影无 token，但异常消息仍可能泄露

位置：cua-driver-computer.ts 1415–1420、`normalizeDriverError` 2234–2237；run-controller.ts 2152–2157。

正常 public catalog 只给观察级 `uia-...` elementRef，私有 Map 保存 uiaTarget.elementToken/snapshotId；type intent 只带 public groundingRef，固定 completed/partial/refused message 不含 token。现有测试也验证 capture/receipt 无私有 token。

但 driver 异常 message 原样进入 normalizeDriverError，再进入 Runtime 的 unknown_side_effect event。独立 mock driver 抛 `driver error: element_token=RAW-PRIVATE-TOKEN`，实际结果为 `CUA execute failed: driver error: element_token=RAW-PRIVATE-TOKEN`，**leaksToken=true**。这证明无法对“所有错误均不进入 trajectory/context”给出保证；不代表本轮发现真实 0.22.2 已经回显 token。

建议在私有调用边界脱敏已知 token/snapshot 等私有字段，持久化固定公开错误信息/代码；保持原异常的未知副作用分类，不为了脱敏改成 refused。加入 Tool/Transport/普通 Error/Abort 原因包含 token 的断言。按实际当前驱动回显概率列为 P2，若产品把私有 token 严禁持久化作为硬合同，应先修再放行。

## 其余要求逐项结果

| 检查项 | 独立结论及限制 |
| --- | --- |
| 公共 set_text_value / elementValue / 隐藏 Enter | 对 packages/apps 源码搜索无残留。ActionIntent、capabilities、ToolRegistry/filter、OSWorld mapper、Guard、approval preview、voice 没有该错误公共动作的消费者；多行仅一次 type_text，没有按行 press_key |
| type.elementRef → ActionIntent | computer-tools schema optional elementRef，校验长度 1–96；toAction 转 groundingRef；contracts/type draft、protocol GuiActionBase、Runtime validation、trajectory schema 均支持。显式 ref 检查当前 public catalog/session/source，adapter 再查私有 Map，无 raw token 写入 intent |
| 单行兼容 | 无 ref 的单行继续 actionRequest 原 type_text/foreground 路径；单行带 ref 在工具层拒绝，在 adapter 通用 grounded action 限制也拒绝。没有新增按行 Enter/clipboard/set_value |
| 多行候选和空值限制 | 显式 ref 优先；自动仅 complete UIA/hybrid catalog 中恰好一个 enabled/editable 未被明确否定的 UIA Document/Edit/TextBox。0/多个拒绝，无 focused 猜测。非空 pre value 拒绝；missing/null/空字符串放行，符合 raw 空白 Notepad 证据，但 missing value 并不证明普遍应用为空，仍需把跨应用范围留作未验收 |
| 操作前新鲜度 | requireSession、latest observation、catalog observation/session、窗口 discover 身份/geometry、private target PID/HWND、snapshot/token 存在均检查。approved stale basedOn 即使提供 fresh executionObservationId，也被多行自己的 basedOn 最新检查拒绝，安全但可能需重新规划。UIA/native 没有 DOM 式独立 page generation；snapshot/token 生命周期靠驱动验证，post readback 的目标代际尚缺，见 P1-1 |
| background 及 readback | dispatch 明确 background+pid/window_id/token/snapshot。fallback get_window_state include_screenshot=false，无额外截图；CRLF/CR/LF统一LF后完整字符串等值，不 trim、不 prefix、不舍弃数字/中文。NEL/LS/PS 被识别为多行但不参与换行折叠，是保守拒绝/partial边界，未有原生支持证据 |
| completed/refused/partial | 明确 no-input 或 structured effect=refused 的错误返回 refused；成功且 confirmed+value_readback 直接completed，否则尝试fresh读回；无法确认partial。直接confirmed分支信任驱动的value_readback，未执行独立fresh readback，这点应在合同明确，不能宣称所有completed都做了本地fresh逐字比较 |
| 异常、Abort、未知副作用 | dispatch 抛错会清观察/token再抛；Transport 标 inactive；Runtime记录unknown_side_effect、outcome_unknown，不重试。readback一般失败返回false→partial，Abort重新抛；没有自动重发。缺少多行专属dispatch抛错/Abort/explicit-no-input组合测试；通用Runtime边界测试不能替代这些adapter边界 |
| partial/Monitor/voice | partial 在protocol/trajectory终态schema合法；Runtime写action.execution.failed、tool.call.failed、partial_side_effect后结束outcome_unknown，不再请求Provider。Monitor trailingStatus 已包含partial，新增重复partial测试通过。voice有partial_side_effect分支及未知结果通告测试，不朗读原始多行正文；没有发现该链不一致 |

## 放行条件与下一步

先修 P1-1 和 P1-2 并加入上述反例；再补私有 token 异常脱敏，以及多行 dispatch/abort/refusal/readback 的边界测试。并行 surface-registry typecheck 错误解决后，在最终工作树再跑 Node24 typecheck 和定向合同测试。随后才运行用户授权范围内的独立空白原生 Notepad 验证；WPS/浏览器多行仍需要自己的原生结果，不能凭历史 Notepad 推广。

本报告不授权业务改动、真实桌面/API测试、发布或服务操作。文档索引入口由父审查流程统一更新，避免并行写同一文件；本文件为该次多行审查的具体交付。

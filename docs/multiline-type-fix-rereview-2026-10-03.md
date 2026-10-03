# 多行 type 修复复审（2026-10-03）

## 结论与放行范围

**GO（离线实现及安全合同），原生效果验收仍未放行。** 上轮 [独立审查](./multiline-type-fix-review-2026-10-03.md) 的两个 P1 和 token 异常 P2 已在当前代码关闭。本轮未发现新的 P0/P1。单行输入、显式元素选择、partial→outcome_unknown/no-retry、共同 inventory/handoff 链通过代码复核和离线测试。

一个 P2 合同描述差异需明确：当前实现只 canonicalize **CR/LF/CRLF→CR**，NEL/LS/PS 明确 no-input refusal，尚不是“所有 logical newline→CR”。安全性允许这项限制，但不得把全部换行支持写为已经实现。

本轮只读取代码、证据和 diff，执行离线测试/typecheck/build 等价检查，并写此文档；没有修改业务代码、调用模型/API、操作 GUI/daemon/服务、提交或推送。旧 transient popup 候选逻辑不因本轮多行通过而获得验收。

## 上轮问题关闭证据

| 上轮项 | 当前代码及独立结论 |
| --- | --- |
| P1-1：把其他有值编辑器当作目标读回 | `verifyFreshMultilineValue` 已删除；不再请求 post catalog、不数“唯一有值文本节点”、不以后来出现的匹配值升级 receipt。仅当前准确 token/snapshot 的同一次 background type_text 返回 `effect=confirmed` 且 `evidence.kind=value_readback`，并且没有 error/degraded，才 completed。否则 partial 并结束 Run。旧反例路径已经不存在 |
| P1-2：多行跳过 common inventory，清空 handoff baseline | 多行 dispatch 移到共同 pre-action visible-window inventory 后（cua-driver-computer.ts 1272–1294）。`invalidateObservationAfterAction` 仅清 observations/groundings，保留 baseline 与 source observation ID（1469–1475）。Runtime completed 后继续调用原 detectNewWindowHandoffCandidates；有新窗需确认，完成后 inventory 失败不能重放。三项新增测试覆盖新窗、pre inventory 失败、post inventory 失败 |
| P2-1：异常消息暴露 raw token | 多行 catch 不再把 driver 原文通过 normalizeDriverError 抛向 Runtime；改为固定、无 token 的 partial receipt，Transport 仍 inactive。异常也清私有 observation/grounding。新增含 RAW-PRIVATE-ELEMENT-TOKEN 的异常测试通过；unknown/Abort 后仍不重试。不声称其他旧动作的全部异常脱敏已由此解决 |

## 当前输入合同复核

公共词汇仍是 `type(text, optional elementRef)`，没有 `set_text_value`、`elementValue` 或隐藏 press_key ENTER。elementRef 只转为 ActionIntent.groundingRef；raw token/snapshot、结构 fingerprint、window generation 均留在 CUA 私有 Map，不进入 public catalog/intent/schema。正常回执及多行异常回执为固定公开文字。packages/apps 源码搜索未发现已删公共路线或 post-readback helper 的孤立消费者。

单行无 ref 仍通过原 actionRequest type_text/foreground 路线；单行带 ref 在工具层拒绝，adapter 也不会把它默认为 token typing。OSWorld/browser DOM/select 的原合同通过回归测试；DOM elementRef 不能冒充 UIA ref。managed-browser hybrid 中只有 source=uia 的元素可以进入这条 Windows UIA 多行路径，没有把 DOM element 指针传给原生 driver。

平台从 pinned 0.22.2 `health_report` attestation 获取；缺失/错误/未知平台时多行 fail closed，单行不因多行平台限制改变。这个新 health_report 准入的真实 daemon 可用性及 canonical CR 的实际 confirmed 比率，本轮没有 GUI 证据。

observation 收集时私有 grounding 记录准确 live windowBinding 和 current.handoffGeneration。执行时复核当前 session、latest basedOn、catalog observation/session、window generation、exact PID/HWND、geometry；还必须有 snapshot/token 和 private structural fingerprint。fingerprint 比较排除 value 和 token，包含同窗口结构角色、标签/描述及 bounds；重复同结构候选拒绝。这里的 generation 是 **Host 窗口绑定生命周期**，不是承诺实现了独立 DOM page generation；DOM 的旧 generation 路线保持独立。native 同一窗口内部控件有效性依赖 fresh driver token/snapshot 验证。

显式 elementRef 优先，允许 partial 但 nondegraded catalog，必须准确映射当前元素、空/缺失 UIA value、未明确 disabled/noneditable；这是明确 token 绑定路径，不以 partial catalog 猜测目标。无 ref 只在 complete、未截断的 catalog 中恰好一个支持编辑器时绑定；0/多个/incomplete 拒绝。Runtime 自动产生 groundingRef 仍仅限 complete catalog，adapter 不接受过时观察/ref。截断/driver degraded 导致 catalog degraded 会拒绝，多行默认不利用不可信候选。

缺失 value 不是一般跨应用“真正空文档”的证明；本轮保留的是历史 raw 空白 Notepad 的受限输入设计。该限制已有 no-insertion/no-submit 说明，非空 value 明确拒绝。当前代码没有提升为任意选区插入或任意应用替换能力。

driverText 将 CRLF/CR/LF 统一为 CR；原 action text 不改写，文字字符不 trim、不截断、无数字/中文替代，单次派发含准确 session/pid/window_id/element_token/snapshot_id、delivery_mode=background。confirmed/value_readback 意味着驱动在这一次指定目标调用中验证，不能写成 Harness 再拍屏或读取 post catalog 后完成独立逐字验证。unverifiable、缺失 evidence、degraded/error、driver 抛未知/Transport/Abort 均不会 completed；有 explicit refused/no-input 证据才 refused。其余 partial→Run outcome_unknown；不调用 Provider 重试，不重发整串。

partial 在 protocol/trajectory schema 中合法；Runtime action.execution.failed、tool.call.failed、partial_side_effect 后终止。Monitor trailingStatus 含 partial；voice 维持 partial/unknown 提示。没有发现这条链回退。

## 本轮实际验证

使用仓库配置的独立 Node v24.19.0 工具链，没有使用 PATH 上的 Node 18。

| 实际执行 | 结果 |
| --- | --- |
| Node24 `node_modules/typescript/bin/tsc -b --pretty false` | exit 0 |
| Node24 `node_modules/typescript/bin/tsc --noEmit -p spikes/cua-driver/tsconfig.json --pretty false` | exit 0 |
| Vitest 13 个定向文件 | **395 tests 全通过** |

两个 tsc 命令是根 package.json `build→typecheck` 的全部实际检查，因此本轮完成了其等价构建验证，没有只运行单包 noEmit 后声称全仓 build 通过。上一轮 surface-registry.ts:340/363 的 false|SurfaceRecord 类型错误已经不再复现；该并行模块目前仍未接入 cua-driver-computer，不能因此宣称旧 transient-menu 行为已由 registry 修复。

定向测试文件及数量：computer-cua/cua-driver-computer 91、dom-grounding 7、bootstrap-session 7；runtime/index 103、computer-tools 10、progress-monitor 14、action-effect-projection 3；trajectory/index 40；voice/index 25；risk-guard/index 25；provider-qwen/index 28；provider-glm/index 25；computer-osworld/index 17。以上是本轮独立运行，不复用上一轮 371 或作者 301 的结果。

多行新增测试检验了 CR/LF canonical payload、同次 confirmed evidence、unconfirmed partial、显式 partial catalog/自动 partial 拒绝、重复 selector 拒绝、多编辑器显式目标、pre/post inventory 和新窗、token异常、old ref及单行兼容。bootstrap/browser/provider/Guard/voice/trajectory 的定向回归一并通过。尚未见覆盖每个畸形 snapshot、所有 Abort 时点、完整 mixed receipt matrix 的专属多行参数化测试；当前实现这些分支采取保守拒绝/partial，不构成阻塞，但可补强。

## 证据边界与 P2

本轮再次核对原 runs/raw-cua-multiline-20261002 记录：background fresh-token LF/CRLF 保存文字，但调用当时是 unverifiable/pending；post snapshot CR 只证明后来状态。新的 **预先将 CR/LF canonicalize 为 CR，再要求同次 confirmed+value_readback** 没有包含在该原生实验里。离线测试证明路线和失败边界，不证明真实 Windows Notepad 一定转为 confirmed，不证明 WPS/Word/浏览器跨应用适用率。

P2：任务描述称“所有logical newline→CR”，源码 55–56 及 1427–1428 只处理 CR/LF，拒绝 NEL(U+0085)、LS(U+2028)、PS(U+2029)。现有测试也断言 LS refused。两种可接受收尾：将公开说明限定为 CR/LF，保留这项 fail-closed；或统一所有 logical separators，并补三个 Unicode 分隔符及混合/连续/首尾换行测试。不得改完后一边保留 refused 测试、一边宣称全部 canonicalization。

建议下一步先确定换行支持描述，必要时定向更新后再跑相关测试；然后在已授权隔离原生环境用新空白 Notepad synthetic strings 验证 exact CR payload、confirmed evidence、partial/no-retry 与窗口新窗链。其他应用按各自证据决定是否开放。没有新原生结果前，当前 GO 仅指离线实现和安全合同，不是完整原生效果验收。

文档索引由父流程统一链接本复审作为最新结论；旧 NO-GO 文档保留作为问题及修复证据。

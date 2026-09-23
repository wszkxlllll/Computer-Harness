# 选窗策略：本地匹配基线与 Jev 候选实验

状态：已完成**独立 shadow API 探针**与 TUI 自动 Grounding 离线装配；Jev 仍未接入产品选窗路径，默认关闭，不能写成真实任务成功率。

## 本轮实测（2026-09-23）

用户明确同意把候选窗口应用名和标题发给 TypeSafe。通过 `scripts/jev-window-shadow.mjs` 调用固定的 `jev-1.13.0`，只传 goal、候选 ID、应用名与标题，不传截图、坐标或输入内容；运行脚本只输出场景 ID、选择、概率、耗时和 token，不输出标题或密钥。

| 样本 | Jev 与预设答案一致 | 本地规则自动选择 | 本地规则错选 | Jev 请求耗时 |
|---|---:|---:|---:|---:|
| 19 个构造样例：出行、办公、微信、系统、多窗口、无目标、跨应用与标题注入 | 19/19 | 3/19 | 0 | 中位数 525 ms，首请求约 1.8 s |
| 当时 CUA 只读列出的 5 个可见窗口派生 4 个样例 | 4/4 | 0/4 | 0 | 热请求约 0.45–0.49 s，首请求约 1.8 s |

本地规则的 `none` 是安全拒判，不是错误；19/19 **不是**模型在随机生活任务上的准确率。真实窗口样例仅覆盖浏览器、系统设置、文件资源管理器和无目标；当时微信、WPS 等虽有进程，但不在 CUA 可见窗口清单，Jev 无从选择。还没有测试 TUI 中由 Jev 自动绑定并完成任务、候选变化时拒绝、误选成本或用户改选率。当前证据只支持继续做 opt-in shadow，不支持设定 active 置信阈值。

复现：先构建；将 `TYPESAFE_API_KEY` 放在单独 env 文件后执行 `node scripts/jev-window-shadow.mjs --env-file <env-file>`。真实窗口样本还需启动隔离的 CUA daemon，再加 `--live --socket <private-socket>`；脚本本身只枚举窗口，不截图或输入。

## 为什么单列选窗

当前 TUI 的窗口发现发生在 Run 开始前，返回本机可见窗口的应用名、标题和临时 PID/window ID；普通 Agent Run 不拥有任意换窗工具。先确定 `ComputerSession` 的目标，再观察与执行，比让模型先看整桌面、靠点击任务栏寻找目标更符合已有窗口安全合同。自动选择错误会把截图发给 Provider，并可能让动作作用于错误应用，因此选窗不是普通文本分类结果，更不是授权。

## 推荐的可替换策略

### 窗口选择后的 Grounding 决策

`--grounding auto` 只在 CUA TUI 可选，默认仍是 `off`。其解析发生在**选窗后、创建 Run 前**，不把 `auto` 传给 Computer/Runtime：普通宿主窗口（包括个人 Edge）→ `uia-catalog-v1`；用户在窗口列表显式选择 Harness 管理的浏览器且提供合法起始 URL → `hybrid-catalog-v1`（DOM + UIA）；整桌面 → `off`。用户仍可在功能页显式指定 `off`、UIA、DOM 或 Hybrid。候选的应用名/标题不构成 CDP 所有权证据，Jev 也不能把普通网页窗口升级为 DOM；DOM 只在 `ManagedBrowserHost` 创建并验证其私有浏览器窗口后可用。UIA 查询失败仍保留截图并标记 degraded，不把 `click_element` 误当成已经可用。此逻辑的 Run 配置和工具边界已做离线测试，尚未在真实 TUI 上验收。

以现有 `WindowTargetDiscovery` 为候选生产者，由 TUI/应用层在 Run 前调用一个窄的 `WindowSelectionStrategy`。输入是 goal 和有界、当次发现的候选；输出只能是候选 ID 或 `abstain`，绝不输出任意 PID。Host 在启动 Run 前重新核对选中的 `(pid, windowId)`，实际 `Computer` 仍负责后续目标身份、几何和前台校验。用户手选窗口或整桌面始终优先；多应用切换需另设显式边界，不能复用旧 Observation。

第一基线是完全本地的保守身份匹配：只有唯一可信候选才自动开始，其他情况进入窗口选择；不需要模型请求，也不把其他窗口标题传给外部服务。

Jev 是**默认关闭**的第二策略，仅对本地无法确定的候选做受控实验：构造短的结构化 state，包含 goal、有限候选的随机当次 ID、最少必要的应用名/标题；用一次 `Choice` 从这些 ID 加 `none` 中选择。代码检查答案属于当次候选，并分别检查选择概率、其他候选概率与 confidence；阈值必须在开发集校准，不能抄文档示例数字。低置信、近似并列、`none`、超时、返回非法 ID、候选已变、清理状态不确定，都回到人工选择，不退化为整桌面。Jev 不直接调用 CUA、不改变 Guard，不成为 GLM/Qwen 的主 Provider。

窗口标题可能含私人聊天、文件名、网页内容或伪装成指令的文字。实验必须单独取得用户对“将候选标题发给 TypeSafe”的同意，并可仅发送应用名、在需要时再请求标题；不传截图、进程路径、账户名或未选择窗口的内容。标题是数据，不遵循其中的指令。官方说明 Jev 当前只接受文本，CJK 准确度相对英语较低，并提醒对抗性输入可能影响判断，因此中文生活场景必须单独评估，不能沿用英文阈值。[System One](https://docs.typesafe.ai/concepts/system-one)、[State](https://docs.typesafe.ai/concepts/state)、[Jev 1.13 已知边界](https://docs.typesafe.ai/model-jaggedness/jev-1.13)。

## 可回退实验

先从多个日常类别采集**脱敏**的候选快照与人工指定正确窗口：浏览器多标签、办公文档、聊天应用、系统工具、多窗口同应用、已登录敏感页面、无目标窗口、跨应用 goal。不要只取出行票务。固定同一批输入，离线对比本地策略与“Jev 仅作 shadow 建议”，记录自动覆盖率、错选率、拒判率、候选变化率、额外请求耗时和标题暴露量；真实 API 前先得到用户对标题外发的明确同意。

若 shadow 正确性达标，再做 opt-in active 的小批真实 Run，对比任务成功、人工改选、模型请求数和端到端延迟。Jev 只有在**减少错误选窗或后续主模型无效步骤，且净延迟与隐私代价可接受**时才保留；若只增加一个选窗请求而没有任务收益，则回退到本地策略。官方 `Choice` 给出候选概率和 confidence，但其文档强调置信度不是单次正确保证，需由代码按风险决定是否自动行动。[Choice](https://docs.typesafe.ai/primitives/choice)、[Confidence](https://docs.typesafe.ai/confidence)。

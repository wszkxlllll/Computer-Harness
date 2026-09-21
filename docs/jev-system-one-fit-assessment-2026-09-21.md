# Jev / System One 与 Computer Harness 的适配性审计

日期：2026-09-21
状态：调研结论；只批准最小影子实验，不批准替换主 Provider 或重构 Runtime

## 1. 结论

Jev 值得做一个**可关闭、无执行权的窄实验**，但目前不值得正式接入为 GUI Agent 主模型，也不能替代视觉、UIA、DOM、Planning 或 Verification。

Jev 是 TypeSafe AI 于 2026-09-15 发布的闭源托管式 System One 模型。它接收文本或 JSON `state`，对调用方给出的封闭答案空间执行 Choice、Score 或 Noul 判断，并返回概率。它不接收图片、不生成文本、没有会话或 Memory，也不能自己发现屏幕元素。其正确定位是：在 Harness 已经把视觉、UIA 和 DOM 证据转换为少量规范候选之后，尝试承担快速候选排序、动作建议或旁路状态判断。

当前证据不足以支持更强结论：官方没有公开论文、模型卡、参数量、权重、训练数据或通用 GUI benchmark；主要 GUI 证据来自 Browser Use 的一个 Google Flights 小样本演示。

## 2. 已核实能力与限制

- 当前公开版本为 `jev-1.13.0`；`jev-latest` 会漂移，实验必须固定版本。
- API 为 `POST /v1/systemone`，一次请求共享一个 `state`，可并行询问多个相互独立的问题。
- Choice 最多 255 个候选；Score 支持 2–10 个有序等级；Noul 返回 yes 概率。
- 输入仅文本、JSON 对象或文本数组。截图、音频和视频必须先由其他组件转换。
- 官方价格为每百万输入 token 0.042 美元、输出免费；宣称端到端 70–500 ms，但这是供应商条件下的数据，不是本项目实测。
- Jev 不能生成输入文本。`type` 内容仍需来自用户原文、确定性抽取或生成模型。
- 英语是主要训练语言；官方说明 CJK 可输入但准确率较低。上海出行中文任务必须单独验证。
- “不会幻觉”只表示不会返回候选集合外的类型或选项，不表示不会选错合法候选。
- 数字、日期、计数、多跳、无关长上下文、冲突准则和对抗性 state 都是官方列出的风险。
- Jev 是 early-access 托管 API，不能离线部署；请求内容会离开本机，敏感 GUI 状态需要数据政策门禁。

## 3. 与现有 Hybrid Grounding 的关系

当前链路为：

```text
截图 / UIA / DOM
        ↓
Computer Adapter 规范化并保留私有 backend ref
        ↓
GroundingCatalog raw candidates
        ↓
DeterministicGroundingSelector（融合、去重、恢复提示、最多 16 项）
        ↓
Context + 主 Provider
        ↓
ModelTurn → ToolRegistry → Runtime 校验/Guard/预算/Event → Computer
```

Jev 不能取代上半段。它看不到截图，也不会自动把 UIA、DOM 与视觉候选对齐。现有 `GroundingCatalog` 才是合适输入边界：候选应继续由 Adapter 生产并由 Runtime 绑定 Observation；selector 负责预筛、去重和来源融合。Jev 只可以消费规范化后的候选 ID、role、name、description、状态、来源和有界局部上下文。

这与 Browser Use `jev-ultrafast` 的公开实践相似：代码从 DOM 生成动态编号元素表，Jev 选择 operation 和兼容 target；执行前代码重新检查页面、节点、可见性与遮挡。其默认循环不用截图，因此不能直接证明桌面视觉任务有效。

当前最多 16 个 hot elements，远低于 Jev 的 255 项上限。不要为了使用其上限扩大候选，否则会同时放大 context rot、重复元素和误选。

## 4. 项目内可复用边界

- `GroundingCatalog`：提供 UIA/DOM/hybrid 的统一安全候选。
- `GroundingSelector`：当前为可注入接口，但为同步确定性选择；首轮实验不修改它。
- `ModelTurn` 和 `ToolRegistry`：如果未来接受 Jev 建议，仍必须转换为现有 `ModelTurn`，不得绕过工具 schema。
- `RunController`：继续拥有预算、审批、Abort、未知副作用、事件先行和 post-observe。
- `ContextCompiler`：只编译输入，不能在内部发 Jev 网络请求。
- Monitor：继续做事后状态证据和恢复提示，不能被悄悄改成 Jev 调度器。
- Planning 与 Memory：首轮实验只读必要摘要，不允许 Jev 修改状态。

Jev 不应放入 Computer Adapter、ContextCompiler、Risk Guard 或 `computer.execute()`。这些位置分别会破坏后端隔离、纯 Context 组装、风险职责和统一执行安全链。

## 5. 最小、可验证、可回退实验

### E0：离线候选判断

从已脱敏 trajectory 中构造样本：目标、当前局部意图、Observation 元数据、最多 16 个候选、实际成功目标或人工标注目标。Jev 只返回 operation Choice、各动作兼容 target Choice，以及可选的 `needs_slow_model` Noul。

不回放桌面、不执行动作、不改 Runtime。先测：

- 候选覆盖率：正确目标是否已在 hot set；若不在，Jev 无法补救。
- top-1 / top-3、错误目标概率、低置信弃权率。
- 中文原文、英文规范字段、双语最小字段三种输入的差异。
- p50/p95 延迟、输入 token、费用、超时率和重复运行方差。
- 点击、输入、等待等动作分别统计；日期和数值任务单列。

### E1：在线 shadow advisor

仅当 E0 有明显价值时，新增独立 `off | shadow` 开关。advisor 在 Observation 已提交后异步消费同一 hot catalog，记录建议、概率、延迟、版本和 fallback 原因，但没有执行权，不进入主模型预算，不影响 Monitor 计数，不阻塞当前 Provider。

需要独立、脱敏事件，例如 `advisor.attempted/result/failed`；不得把它伪装成主 Provider request。超时、无候选、低置信、候选失效和 API 错误都只记为 abstain。

### E2：有限 active advisor

只有 E1 证明建议质量和延迟稳定后才讨论。增加窄 `FastPathAdvisor` seam，位置在 `RunController` 已经得到当前 Observation、但尚未调用完整 `ContextCompiler.compile()` 和主 Provider 之前。这样高置信命中时才能同时省去完整图片 Context 编译与 GLM/Qwen 请求；低置信或异常时复用同一 Observation 回落原链。

首版 active 白名单只允许**单个、Observation-bound 的 `click_element`**；接受的调用仍进入现有 `processToolCalls`。`wait` 不用于验证候选选择价值，首版也不开放。低置信、错误、过期 ref、Monitor recovery、Risk Guard 需要确认或非白名单动作均回退 GLM/Qwen。

首轮 active 不允许坐标 click、type 文本生成、Plan/Memory mutation、terminate、支付/预订等高风险动作。

### E2 的单轮输入与输出

这里的“一次上下文”不是把当前含截图和完整历史的 `ModelInput` 直接发送给 Jev。Jev 不接收图片，而且官方明确提示无关长 state 会降低准确率。应由独立的纯函数从权威 Runtime 对象构造小型 JSON：

- goal 的有界摘要；
- 当前 `observationId`、viewport 和最多 16 个 hot elements；
- 每个候选只含 `elementRef/role/name/description/bbox/state/source/browserRegion`；
- 最新用户纠正与少量当前 Plan 状态；
- 最近少量动作及 `changed/no_change/failed` 结果；
- 当前 ToolRegistry 和 action allowlist 投影出的可用操作。

单次 Jev 请求并行提出：

1. `operation` Choice：首版只有 `CLICK_ELEMENT` 与 `FALLBACK`；
2. `click_target` Choice：只包含当前可点击 hot elements；
3. 可选 `needs_system2` Noul：只作为额外回退信号。

问题在 Jev 内彼此独立，`click_target` 并不会自动以 `operation` 的答案为条件，因此代码只在 operation 选择 `CLICK_ELEMENT` 后消费 target head。未来若增加 type/select，应为每种动作建立各自兼容的 target head，不能混用一个候选表。

返回建议转换成标准 `ModelTurn{type:"tool_calls"}`，随后照常经过 ToolRegistry、schema、Risk Guard、审批、预算、ActionIntent、事件先行、Computer 执行和 post-observe。Jev 高置信表示“候选选择值得尝试”，不表示安全授权。

### 可控配置与失败回退

建议实验配置：

```ts
interface FastPathConfig {
  mode: "off" | "shadow" | "active";
  model: "jev-1.13.0";
  deadlineMs: number;
  maxRequests: number;
  maxConsecutiveAccepted: number;
  confidenceThreshold: number;
  minTopProbability: number;
  minTopMargin: number;
  allowedTools: readonly ["click_element"];
}
```

默认 `off`。`shadow` 不阻塞主 Provider，也不影响动作；`active` 才允许命中后跳过主 Provider。advisor 请求、token、费用、延迟和 fallback 必须独立统计，不能占用或污染 `modelRequestCount`。

一次 active 接受必须同时满足：版本固定、无 pause/approval/correction barrier、没有 Monitor recovery、候选非空、operation 与 target 均达到经本项目数据校准的门槛、top-1/top-2 margin 足够、恰好一个 `click_element`、ref 属于当前 Observation 且 enabled、工具仍在 ToolRegistry 中、Risk Guard 允许继续。任何失败只回退一次主 Provider；Abort 直接终止，不回退。

官方 `confidence` 只是从概率分布压缩出的峰锐程度，具体公式未公开，既不是 top probability，也不是单次正确率。实现必须保存完整 probabilities，并按动作类别、候选数量、来源和语言分别画 risk-coverage 曲线。不能直接采用 `confidence > 0.9` 之类拍脑袋阈值。

若 Jev 在 deadline 内没有结果，立即 fallback，critical path 不重试。平均延迟只有在

```text
T_jev < (1 - fallback_rate) × T_main_provider
```

时才可能优于基线。后续可以单独实验 hedged fallback，但只有主 Provider 的 Abort 确实取消推理和计费时才有意义。

## 6. 对照、通过门槛与停止条件

对照组至少包含：当前 deterministic selector + GLM/Qwen；Jev shadow；若 E2 获批，再加入 Jev active + 主 Provider fallback。开发集与验证集分离。

继续到 E1 的必要条件：候选覆盖率足够且 Jev top-1 明显优于简单 lexical/位置基线，中文条件下没有不可接受退化，p95 延迟显著低于主 Provider。

继续到 E2 的必要条件：shadow 建议在冻结验证集上维持质量；置信阈值能有效分开正确/错误样本；超时和 API 故障均可靠回退；数据外发范围可接受。

E2 还必须验证：高置信 bucket 的条件错误率及置信区间、fast-path coverage、fallback penalty、主 Provider 调用减少量、总 token/费用、端到端 p50/p95、stale rejection、重复/无进展率。Browser Use 的公开实现记录 confidence 但没有用它阻止动作，因此其 7 秒演示不能作为“高置信放行安全”的证据。

出现以下任一情况则停止：正确目标经常不在 16 项候选中；Jev 不优于确定性 selector；中文准确率不稳定；概率不能用于可靠弃权；网络 p95 抵消延迟收益；需要把完整截图或大段历史转写后才有效；或 active 需要绕过现有 Runtime 安全链。

## 7. 当前不做

- 不新增“Jev Provider”替换 GLM/Qwen。
- 不把同步 `GroundingSelector` 直接改成网络模型。
- 不为 Jev 改写 ModelTurn、ComputerSession、Memory 或 Planning 协议。
- 不复制 `jev-ultrafast` 的浏览器专用主循环。
- 不因供应商 confidence 宣称取消独立验证、Guard 或人工确认。

## 8. 主要来源

- TypeSafe 官方发布：<https://typesafe.ai/blog/introducing-system-one-models-and-jev>
- 官方 System One 概念：<https://docs.typesafe.ai/concepts/system-one>
- 官方 State：<https://docs.typesafe.ai/concepts/state>
- 官方 Primitives / Choice：<https://docs.typesafe.ai/primitives>、<https://docs.typesafe.ai/primitives/choice>
- 官方 API / Models / Confidence：<https://docs.typesafe.ai/api>、<https://docs.typesafe.ai/models>、<https://docs.typesafe.ai/confidence>
- 官方 Jev 1.13 已知边界：<https://docs.typesafe.ai/model-jaggedness/jev-1.13>
- Browser Use Jev Ultrafast：<https://github.com/browser-use/jev-ultrafast>
- Browser Use 性能边界：<https://github.com/browser-use/jev-ultrafast/blob/main/docs/performance.md>
- macOS Accessibility 社区实践：<https://github.com/savka777/jev-use>

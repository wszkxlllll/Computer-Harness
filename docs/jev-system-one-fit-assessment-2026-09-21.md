# Jev / System One 与 Computer Harness 的适配性审计

日期：2026-09-21；最近更新：2026-09-23

状态：**实验已收口，产品链路已移除（no-go）**。Jev 不再出现在 Runtime、CLI、TUI、PowerShell、协议事件或报告中。第 2–21 节保留的是形成结论的历史实验过程，其中出现的“当前实现”“下一步”或 recovery shadow 均不再是现行能力；现行结论与删除边界只以第 22 节为准。

## 1. 结论

Jev 本轮实验结论为 **no-go**：不作为主模型，也不保留 shadow/recovery 产品接线。它在封闭候选选择上比 GLM 快，但 all-observation、continuation、side-tool 与 recovery-only 四条路线均未在真实任务中稳定减少主 Provider 请求或端到端延迟；继续保留运行时接口只会增加配置、协议与维护成本。

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

这与 Browser Use `jev-ultrafast` 的公开实践相似：代码从 DOM 生成动态编号元素表，Jev 选择受限的下一步候选；执行前代码重新检查页面、节点、可见性与遮挡。其默认循环不用截图，因此不能直接证明桌面视觉任务有效。

主 Provider 的 Context 仍最多投影 16 个 hot elements。Recovery shadow 则从同一 Observation 的
authoritative raw catalog 独立过滤、去重和排序，默认最多发送 32 项，可配置到 255；扩大
候选池的目的仅是提高 target coverage，不代表越多越好，必须按候选规模分别评估准确率与延迟。

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

### E0：离线候选判断（历史实验记录）

从已脱敏 trajectory 中构造样本：目标、当前局部意图、Observation 元数据、候选目录、实际
成功目标或人工标注目标。历史轨迹通常只保存 16 项 hot projection，只能用于 hot-only
基线；新的在线 shadow 轨迹才可验证 raw 32/64 候选。V2 Jev 只返回一个有限的
`next_action` Choice：`FALLBACK` 或 `CLICK_cN`，不返回输入、滚动、等待或完成动作。

不回放桌面、不执行动作、不改 Runtime。先测：

- 候选覆盖率：正确目标是否进入 advisor 的 projected candidate pool；若不在，Jev 无法补救。
- top-1 / top-3、错误目标概率、低置信弃权率。
- 中文原文、英文规范字段、双语最小字段三种输入的差异。
- p50/p95 延迟、输入 token、费用、超时率和重复运行方差。
- 点击、输入、等待等动作分别统计；日期和数值任务单列。

### E1：在线 shadow advisor（历史设计，当前仅保留 recovery-only 变体）

仅当 E0 有明显价值时，才启用 `off | shadow`。当前实现只保留 recovery-only delegated shadow：Observation 已提交后，只有 Monitor/recovery 产生并严格绑定最近 unresolved click 的 typed local demand 时，才提交 `local_policy.request.started` 并并行启动有界 advisor Promise；主 Context/Provider 不等待它。普通 Observation 只记录 admission，不发网络请求。

需要独立、脱敏事件，例如 `advisor.attempted/result/failed`；不得把它伪装成主 Provider request。超时、无候选、低置信、候选失效和 API 错误都只记为 abstain。

### E2：有限 active advisor（停止，不进入当前路线）

历史方案曾考虑在完整 Context/主 Provider 之前增加窄 `FastPathAdvisor` seam，以便高置信命中时省去一次主请求；真实任务没有证明召回和延迟收益，且会引入另一套执行协议。该 seam 已删除，当前不进入 active 设计。

首版 active 白名单只允许**单个、Observation-bound 的 `click_element`**；接受的调用仍进入现有 `processToolCalls`。`wait` 不用于验证候选选择价值，首版也不开放。低置信、错误、过期 ref、Monitor recovery 或非白名单动作回到主 Provider；Risk Guard 的 `require_approval` 则进入审批等待，`deny` 则拒绝该 ToolCall，二者都不绕过 Guard 直接执行，也不把审批等待误写成“回退主 Provider”。

首轮 active 不允许坐标 click、type 文本生成、Plan/Memory mutation、terminate、支付/预订等高风险动作。

### E2 的单轮输入与输出

历史 active 方案中的“一次上下文”不是把当前含截图和完整历史的 `ModelInput` 直接发送给 Jev。Jev 不接收图片，而且官方明确提示无关长 state 会降低准确率。当前 recovery shadow 仍由独立纯函数从权威 Runtime 对象构造小型 JSON：

- goal 的有界摘要；
- 当前 `observationId`、viewport 和经独立过滤后的 advisor candidates（默认最多 64）；
- Runtime 内部候选含 `elementRef/role/name/description/bbox/state/source/browserRegion`；发给 Jev 的 state 去掉私有 `elementRef`，只用短的 `candidateId=cN` 做本次请求映射；
- 最新用户纠正与少量当前 Plan 状态；
- 最近少量动作及 `changed/no_change/failed` 结果；
- 当前 ToolRegistry 和 action allowlist 投影出的可用操作。

单次 Jev 请求只提出一个 `next_action` Choice：`FALLBACK`，或与当前候选一一对应的
`CLICK_c0`、`CLICK_c1` 等选项。候选详情只在 state 中出现，wire 选择项不复制完整字段。
因此动作与目标不会发生跨 head 不一致；未来若增加 type/select，应扩展新的协议
版本并单独做消融，不在本 V2 单 head 中混入参数生成。

返回建议只进入 `local_policy.*` 诊断事件和一次性 comparison，不转换成 `ModelTurn`，不创建 ToolCall，也不进入 Computer 执行链。Jev 概率不表示安全授权。

### 可控配置与失败回退

建议实验配置：

```ts
interface LocalPolicyShadowConfig {
  mode: "off" | "shadow";
  deadlineMs: number;
  maxCandidates: number; // 1..255, default 32
}
```

默认 `off`。当前 recovery shadow 默认 `K=32`、deadline `3500ms`，显式 CLI/Run 配置优先；advisor 请求、token、费用、延迟和 fallback 必须独立统计，不能占用或污染 `modelRequestCount`。

一次 active 接受必须同时满足：版本固定、无 pause/approval/correction barrier、没有 Monitor recovery、候选非空、`next_action` 是一个当前候选的 `CLICK_cN` 且 action probability/margin 达到门槛、恰好一个 `click_element`、ref 属于当前 Observation 且 enabled、工具仍在 ToolRegistry 中、Risk Guard 允许继续。Runtime 为 Jev 生成的 ToolCall 使用最小且诚实的 `unknown` immediate-effect declaration，不伪造“navigate”或“submit”；Guard 的语义 assessor 会看到所选 raw element 的有界 role/name/description/source/browserRegion，并明确这些只是 untrusted UI evidence，不是授权或效果证明。Guard/审批仍拥有最终决定权。默认实验门槛为 `minActionProbability=0.75`、`minActionMargin=0.15`；它只是 balanced 实验阈值，不是安全保证。任何失败只回退一次主 Provider；Abort 直接终止，不回退。

官方 `confidence` 只是从概率分布压缩出的峰锐程度，具体公式未公开，既不是 top probability，也不是单次正确率。实现只保存有界 action top-3，不保存完整分布；必须按候选数量、来源和语言分别画 risk-coverage 曲线。

若 Jev 在 deadline 内没有结果，立即 fallback，critical path 不重试。平均延迟只有在

```text
T_jev < (1 - fallback_rate) × T_main_provider
```

时才可能优于基线。后续可以单独实验 hedged fallback，但只有主 Provider 的 Abort 确实取消推理和计费时才有意义。

## 6. 对照、通过门槛与停止条件

对照组至少包含：当前 deterministic selector + GLM/Qwen；Jev shadow；若 E2 获批，再加入 Jev active + 主 Provider fallback。开发集与验证集分离。

继续到 E1 的必要条件：候选覆盖率足够且 Jev top-1 明显优于简单 lexical/位置基线，中文条件下没有不可接受退化，p95 延迟显著低于主 Provider。

继续到 E2 的必要条件：shadow 建议在冻结验证集上维持质量；置信阈值能有效分开正确/错误样本；超时和 API 故障均可靠回退；数据外发范围可接受。

历史 E2 设计还要求验证：高置信 bucket 的条件错误率及置信区间、FastPath coverage、fallback penalty、主 Provider 调用减少量、总 token/费用、端到端 p50/p95、stale rejection、重复/无进展率。Browser Use 的公开实现记录 confidence 但没有用它阻止动作，因此其 7 秒演示不能作为“高置信放行安全”的证据；该 active 路线当前已停止。

出现以下任一情况则停止：正确目标在 64 项有界候选池中仍经常缺失；扩大候选后 Jev 准确率
明显下降；Jev 不优于确定性 selector；中文准确率不稳定；概率不能用于可靠弃权；网络 p95
抵消延迟收益；需要把完整截图或大段历史转写后才有效；或 active 需要绕过现有 Runtime 安全链。

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

> **历史证据说明（第 9–21 节）**：以下章节保留真实 API/任务轨迹、召回失败、延迟和 no-go 证据。章节中出现的 FastPath、legacy、active、`jevPolicy` 或旧命令是当时实验实现，不是当前源码配置；不要按这些章节启动新 Run。当前实现合同以第二十二节为准。

## 9. 2026-09-21 合成真实 API 探针（历史证据）

在不启动桌面、不发送真实截图/轨迹/Memory 的条件下，历史 V1 探针曾对固定
`jev-1.13.0` 执行 3 个中文合成场景 × 16/32/64 候选 × 3 次重复，共 27 次请求；这是
V1 双 head 协议的历史证据，不应当直接当作 V2 单 head 的正确率。

2026-09-22 使用同样规模完成 V2 单 head 复测：27 次均正确、无 API 失败，延迟 p50 为
332 ms、p95 为 1.2 s。18 个 expected-click 样本中，balanced `0.75/0.15` 接受 16 个，
coverage 为 88.9%；旧 `0.9/0.2` 接受 9 个，coverage 为 50%。两组在这批合成样本中的
false-accept rate 都为 0，accepted precision 都为 1。结果保存在被 Git 忽略的
`runs/jev-live-probe-v2-20260922/`，不进入仓库。

这说明旧阈值在简单正确点击上确实过严，`0.75/0.15` 适合作为下一轮 shadow/active
实验起点；但 27 个合成样本不足以估计真实桌面的条件错误率，不能据此宣称生产安全。
`scripts/jev/live-probe.mjs` 会继续同时报告两组门槛的 click coverage、false-accept rate
和 accepted precision；click 阈值分母只包含 expected-click 样本。

第一次请求把候选详情同时重复在 state 与 Choice criteria，平均输入 token 随 16/32/64 项约为
4.7k/8.8k/16.9k。按官方允许的 `null` criteria 改为只在 state 保留详情后，降为约
2.9k/5.0k/9.4k，27 次合计 155,982 输入 token，按官方单价估算约 0.0066 美元；判断正确率
保持 27/27。该结果只证明接口、中文简单决策、候选放大和上海网络延迟具有继续实验价值，
不证明真实 GUI task success 或校准质量。

同机历史 10 个已执行 `click_element` 的主模型请求延迟为 p50 11.995 s、p95 37.222 s。
它们与合成 Jev 输入不同分布，因此只能作为“存在数量级延迟空间”的早期信号，不能报告为
严格加速比。下一门槛是用户明确同意数据外发后的真实 `shadow` 标注集，再画按候选规模、
来源、语言和阈值分桶的 risk–coverage 曲线；通过前不默认启用 active。

## 10. 当前实施边界（实验代码已落地）

当前实现新增独立 `@computer-harness/advisor-jev` 包。它只负责把 Runtime 提供的
Observation-bound 原始 `GroundingCatalog` 投影成脱敏、有限的 Jev state，调用固定的
`jev-1.13.0` API，并把结果映射回本地 `elementRef`。它不拥有 Computer、Context、
Risk Guard、Planning 或 Memory 的执行权；这些职责仍由 Runtime 及既有模块维护。

Runtime 的 `FastPathAdvisor` seam 位于已提交 Observation 与主 Context/Provider 请求之间，
支持 `off | shadow | active`：

- `off` 是默认值，行为与基线一致；
- `shadow` 可以阻塞当前决策用于测量，但建议不会执行，也不能据此宣称端到端加速；
- `active` 只接收同时通过单一 `next_action=CLICK_cN`、action probability、action margin、
  当前 Observation ref、连续命中上限和运行时门禁的单个 `click_element`。命中后
  仍经过 ToolRegistry、Policy/Guard、审批、预算、stale ref、event-first、Computer 和
  post-observe；低置信、超时、错误、Monitor recovery、无候选和不适用都回退主 Provider。

Jev state 默认最多 64 个候选，可配置 1–255。候选先在 advisor 内做独立的有效性过滤、
去重、相关性排序和来源配额；网络请求只发送短的 `c0` 等候选键，真实 `elementRef` 留在
本地映射中。state 只含有限 Goal、最近纠正、active Plan 摘要、相关且仍有效的 Run
Memory、最近四个动作/transition 和候选的 role/name/description/state/source/browserRegion/bbox，
不含截图、Asset、selector、backend token 或 reasoning/continuation 原文。首版 fast path 不使用
`needs_check` Memory；这类事实必须回退主 Provider 重新核实。失效或 superseded 事实也不会进入。

V2 还把最近完成动作投影为低敏语义证据：grounding ref 使用对应 raw catalog；坐标 click 优先
映射到包含点的最小 bbox，否则只在有界距离内给出 nearest 映射及 confidence/source；type/keypress
只在当时 Observation 的 focused（type 还需 editable）元素上绑定；scroll、drag、wait 不伪造目标。
动作产生 ModelTurn 的 assistantText 最多保留 320 字符，并标记为不可信的 completed-action narration，
绝不当作事实、授权或下一步命令。Runtime 还用纯 eligibility gate：首轮允许一次探测，之后只有
click 有 target/narration 或 type/keypress 有 focused target 才请求 Jev；scroll、drag、wait 直接回主
Provider，不增加 fastPathRequestCount。这样可以避免连续低收益网络探测。
每个 Observation 最多发起一次 Jev 请求；即使结果是 abstain/fallback，也会标记该 Observation
已经探测。Planning/Memory-only turn 不会重复付费探测；只有新的合格 GUI Observation/action
才可能再次进入 FastPath。

新增 `fast_path.request.started/result/abstained/failed` 事件和轨迹计数；事件只记录模式、
Observation、候选数、延迟、阈值判断、应用/回退原因，以及最多三个 `{action,targetRef,probability}`
摘要和 usage，不记录完整概率表或原始 GUI 文本。Jev 请求不增加主 `modelRequestCount`。API 失败不重试，Abort 直接
遵循 Runtime 取消语义。

可验证范围：`packages/advisor-jev` 的请求/响应、短候选映射、超过 16 项候选、Plan/Memory
有界投影、阈值、超时和 Abort；Runtime 的 active 命中、shadow 不执行、低置信回退、Guard
介入、stale ref 拒绝、预算与轨迹 reducer。当前真实 API 证据仅限第 9 节 V1/V2 合成状态，不包含
真实桌面或任务；也没有把 Jev 作为主 Provider 或默认 TUI 功能。启用需要显式 grounding、`TYPESAFE_API_KEY`、CLI/TUI 的
`--jev-mode` 与 `--confirm-jev-data-sharing`；没有密钥、没有显式数据共享确认或 grounding
为 off 时应在启动前报错。

## 11. 首次 V2 真实任务诊断

2026-09-22 的首次携程长任务使用 `active`、64 候选、`0.75/0.15` 门槛，共产生 3 次 Jev
网络请求，但没有接受或执行 FastPath。5 个 fallback/abstain 事实分别是：

- 1 次真实请求在 1500 ms deadline 后失败（实际 1522 ms）；
- 1 次在同一 Observation 的 Planning-only turn 被 `observation_already_probed` 正确抑制；
- 1 次选择 `CLICK_c35`，probability 0.41、margin 0.11；主 Provider 随后选择 `wait`，因此
  不能把它当作“只差一点门槛”的正确点击；
- 1 次在已完成 `wait` 后被 `unsupported_recent_action` 抑制；
- 1 次以 0.94 probability、0.92 margin 明确选择 `FALLBACK`，而主 Provider 随后执行坐标点击。

该 Run 中主 Provider 的 3 个 GUI 动作是 2 个坐标 `click` 和 1 个 `wait`，没有产生任何
`click_element` 调用。Jev V2 当前只能从 grounding catalog 中选择 `click_element`，无法生成
视觉坐标，也没有 `wait` 选项。因此当前 0 命中的主要原因依次是：

1. **动作空间不覆盖实际下一步**：主模型依赖坐标点击和等待，FastPath 只开放 grounded click；
2. **缺少局部下一步意图**：完整 Goal 和阶段级 PlanningTask 不能稳定表达“当前页面此刻应点展开”；
3. **grounding target coverage 尚未证实**：实际坐标点击对应的小控件是否进入 raw 64 候选，轨迹
   还没有权威覆盖率证据；
4. **deadline 偏紧**：1500 ms 对合成输入大多足够，但真实 64 候选请求已出现边界超时；
5. **阈值只解释一次拒绝**：直接降低到 0.4/0.1 会放行一个与主 Provider 的 `wait` 决策冲突的点击。

因此下一步不应继续整体降低阈值。先增加 observation-bound 的 grounding coverage 诊断，明确
主 Provider 坐标点击是否能映射回 raw candidate；再设计由主 Provider 在上一轮显式生产、由动作
结果和新 Observation 共同约束失效的短期 `next-step hint`。可单独消融一个由 Runtime 固定参数的
`WAIT_SHORT` 动作，以及“完成 wait 且页面发生变化”后的 eligibility；这些扩展仍必须与
`click_element` 分开统计。真实网络 deadline 可先提高到 2500 ms，但这只解决超时，不解决决策覆盖。

## 12. V2.1 局部意图与候选覆盖改造方案

实施状态（2026-09-22）：`DecisionFrame` 纯编译器、独立 `ExecutionSegment` 协议/事件/Reducer、
`execution_segment_set` ToolRegistry 工具、Context 明示投影、GroundingSelector 局部步骤加权、Jev state
投影及 completion-evidence 推进/失效链已完成离线首版。默认 Jev 仍为 off；本状态只表示机制可运行，
尚未完成真实 Provider 是否会正确创建 Segment、真实候选覆盖率和任务加速收益验证。
坐标点击还会写入脱敏 `grounding.coordinate_coverage` 事件，记录 containment/nearest/none、是否进入
hot projection 与归一化距离，不保存 UI 文本；出行指标采集器会单独汇总该上界证据。

### 12.1 不直接复用 recovery hint

项目已有 `GroundingRecoveryHint.localIntent`，但它只在无变化、执行失败或用户纠正后的 Monitor
恢复路径中产生，消费者是 `GroundingSelector`。Jev 当前遇到 recovery barrier 会退出，这是正确的
fail-closed 行为。其 `provider_hint` 又主要来自已完成动作同轮的 `assistantText`，通常描述“刚才要做
什么”，不能稳定表示“新页面下一步做什么”。因此不能把该字符串直接当成普通 FastPath 授权或下一步。

正常执行路径新增共享语义对象 `LocalIntentAnchor`，但不与 recovery 生命周期混用。来源优先级为：

1. 最新用户纠正；
2. 主 Provider 显式写入的短期 `ExecutionSegment` 当前步骤；
3. active PlanningTask 的阶段目标；
4. 原始 Goal 仅作为背景。

Recovery 仍可消费用户纠正、declared effect 和 provider narration；Jev 只消费第 1–3 项及背景 Goal。
任何 intent 都只是候选召回/选择证据，不是事实、效果声明或安全授权。

### 12.2 统一编译 `DecisionFrame`

单句 `next_step_hint` 不作为核心协议：它很容易退化成重复模板，不能表示任务进度、界面变化和未满足
约束。Runtime 改为从已有权威对象纯函数编译一份逐轮 `DecisionFrame`：

```ts
interface DecisionFrame {
  taskContract: {
    goal: string;
    invariants: string[];             // 例如不预订、不支付
    activeStage?: string;             // Planning 阶段，不是事实真值
    outstandingRequirements: string[];
  };
  turnState: {
    observationId: ObservationId;
    lastAction?: ActionSummary;
    lastReceipt?: ReceiptSummary;
    transition?: "changed" | "unchanged" | "unknown";
    focusedElement?: ElementSummary;
    recovery?: RecoverySummary;
  };
  localExecution?: ExecutionSegmentProjection;
  candidates: CandidateSummary[];
}
```

这不是新的持久化真值：Goal/correction、Plan、Observation、Receipt、Monitor 和候选目录仍是唯一生产者，
`DecisionFrame` 只是可重建视图。字段带来源/可信度：用户约束为 authoritative，UIA/DOM 为 observed，
Plan/Memory 为 agent-declared，provider narration 为 untrusted。主 Provider Context 和 Jev state 共同消费
同一个 Frame 的不同投影，避免两套“当前状态”逐渐漂移。

Context 组织由三层构成：

1. 可缓存稳定前缀：System、工具目录、任务不变量；
2. Run 工作状态：active Plan、已确认 Memory、未完成交付项；
3. Turn delta：当前 Observation、最近动作/Receipt/变化、当前局部执行步和相关候选。

Jev 只接收第三层及第二层中的少量相关内容，不再重复完整长 Goal、全部 Plan/Memory 和无关候选。

### 12.3 短期 `ExecutionSegment`，而非逐轮模板提示

真正可降低模型往返的是主 Provider 一次生成一个短期局部执行段，而不是每轮写一句 hint。例如：

```text
segment objective: 筛选 08:00–12:00
step 1: 展开出发时间筛选       allowed=click
step 2: 选择 08:00–10:00       allowed=click
step 3: 选择 10:00–12:00       allowed=click
```

Global PlanningTask 继续回答“整个任务做到哪个阶段”；ExecutionSegment 只回答“当前稳定界面阶段内接下来
几步怎么推进”。它由 Provider-neutral ToolRegistry 状态写工具产生，可与当前 GUI 调用同轮返回，不新增
模型请求。只有同一轮能描述当前点击和至少一个后续点击、确实有机会替代未来一次主 Provider turn 时才应
创建；简单一步动作不创建。Runtime 分配 segment/step ID，Provider 只给出有界 objective、2–4 个 semantic step、允许动作
和可选的可观察完成条件。

每一步仍执行 `Observe → validate → act → Observe`：Jev 只把当前 semantic step 映射到 `CLICK_cN`，
不负责重新规划，也不把高概率当成功证明。动作失败、无变化、候选缺失、用户纠正、ComputerSession
变化、页面 lineage/viewport 分区变化、步骤完成条件冲突或连续接受达到上限时，segment 暂停/失效并回到主 Provider。没有 segment 的
复杂任务默认不调用 active Jev；不另建 `next_step_hint` 协议。

这也使 Prompt Cache 更稳定：ExecutionSegment 与 Turn delta 位于末尾变化区，System、工具和任务不变量
保持稳定；完整 Trajectory 仍独立保存，不因 Context 裁剪丢失。

### 12.4 统一候选排序与执行边界

主 Context 的 hot-16 和 Jev 的 raw-64 可以保留不同容量，但应消费同一个 DecisionFrame 查询：最新用户
纠正、当前 segment step、active stage、未完成约束和背景 Goal。存在 segment step 时，先按 step 语义
重排并缩小到 24/32 个高相关候选；同时保留来源配额和 focused/editable 候选，不能只做文本匹配。

Jev 首版只解析 `click` step；同控件的 click/type/keypress 继续由现有 Action Batch 负责。固定参数
`WAIT_SHORT` 可以作为后续独立 step 类型，但不与本轮 Context/segment 改造同时归因。type 值、坐标
点击和任意 scroll 不交给 Jev 生成。

### 12.5 先补 coverage 证据，再扩动作空间

新增脱敏 coverage 事件：当主 Provider 最终使用坐标点击时，Runtime 用当时 authoritative raw catalog
计算 containment/nearest 映射，记录“是否存在可执行候选、映射来源和距离”，但不保存 UI 文本。当前实现的
`inHotProjection` 只表示目标是否进入主 Provider Context 使用的 Runtime hot-16，**不表示**是否进入
Jev advisor 独立选择的 projected-64。要区分 Jev 选错与其候选池根本不存在目标，还必须补充
`advisorProjected/rank/semanticClusterId` 等脱敏诊断；在此之前不得用 hot-16 指标推断 Jev shortlist recall。

第一轮仍以 `CLICK_cN` 为主要动作。`WAIT_SHORT` 只作为单独版本/消融：固定 Runtime 参数、独立预算、
post-observe、连续等待上限和独立指标；不得顺带开放 type、坐标点击或任意滚动。若 coverage 证明小控件
长期不在 raw catalog，应先修 DOM/UIA/视觉 grounding，而不是继续降低 Jev 门槛。

### 12.6 实施与验收顺序

1. 增加 coverage 诊断并回放一批真实坐标点击，建立 candidate upper bound；
2. 实现纯 `DecisionFrameCompiler`，先让主 Context、grounding selector 和 Jev shadow 消费同源投影；
3. 引入短期 `ExecutionSegment` 的 ToolRegistry 合同、事件/Reducer、cursor、暂停/失效和清理测试；
4. 让 GroundingSelector 与 Jev 共同消费当前 segment step；
5. 将真实 deadline 从 1500 ms 单独对照到 2500 ms；
6. shadow 对比 `Goal-only`、`DecisionFrame-only`、`DecisionFrame + segment` 的 top-1、coverage、
   false accept、主 Provider 请求减少量和端到端延迟；
7. 只有 segment 组显著提高 accepted precision/coverage 且实际减少主 Provider 请求后才恢复 active；
8. 最后单独实验 `WAIT_SHORT`，不与 Context/segment 改造同时归因。

## 十三、2026-09-22 多动作 Local Policy 与召回链路复审

### 13.1 架构结论

Jev 可以从 click-only 扩展为多动作，但不能注册成与 GLM/Qwen 互斥的完整 `ProviderAdapter`，也不能拥有
Computer、Plan、Memory 或最终完成语义。推荐增加可关闭的 `LocalPolicy`：Runtime 仍在已提交 Observation
之后、主 Provider 请求之前询问它；只有当前 `ExecutionSegment` 和有限动作空间足以表达下一步时才调用。
Jev 的结果必须转换为普通 `ToolCall`，继续经过现有 ToolRegistry、参数校验、Policy/Guard、审批、预算、
event-first、ActionIntent、Computer 和 post-observe。主 Provider 继续负责 Goal 理解、截图视觉推理、开放
文本生成、Plan/Memory、异常恢复、跨应用决策、用户交互和最终回复。

因此不得修改或复制以下权威边界：

- `ProviderAdapter → ModelTurn` 的开放决策合同；
- ToolRegistry 的工具定义和能力过滤；
- `ToolCall → ActionIntent → ActionReceipt` 的唯一执行链；
- Computer Adapter、Risk Guard、Event/Reducer、Abort/Approval 与未知副作用语义；
- ContextCompiler 的纯组装职责。

首版只在现有 `tryFastPath` seam 后方替换 advisor/投影，并以新版本开关 shadow 运行；不重写主循环。

必须区分目标合同与当前实验基线。当前 `shadow/active` 仍是 click-only FastPath：即使没有 active
`ExecutionSegment`，只要近期动作能提供最低限度的局部上下文，它仍可能询问 Jev；`active` 命中后也会直接
生成单个 `click_element` ToolCall。这一路保留用于历史对照，但不等于 delegated Local Policy。正式 delegated
模式必须使用独立的版本/开关，并同时满足“主 Provider 已建立有效 Segment、Runtime 已编译完整动作实例、
Jev 只返回实例 ID”三个条件；不能通过悄悄收紧旧 `active` 语义来制造不可比较的实验结果。

### 13.2 适合 Jev 的状态与动作空间

Jev 适合消费 Observation-bound、局部、有限、参数完备的状态，不适合完整 Agent Context。新增纯函数
`BoundedActionSpaceCompiler`，输入当前 raw Grounding、ToolRegistry 有效工具和 ComputerCapabilities，输出能够
直接变成 ToolCall 的有限动作实例。它只描述当前环境可执行什么，不承担 Goal/Plan/Memory 或局部 Segment 的
准入判断；这些信息由 Jev Context 和后续 Runtime gate 消费。
Jev 不得自行生成 selector、坐标、脚本或任意文本。

`actionInstanceId` 是每个 Observation 内由 compiler 分配的短键，不跨帧稳定。Runtime 本地保存
`actionInstanceId → {observationId, toolName, complete arguments, preconditions}`；发给 Jev 的语义投影仍包含
operation、目标 role/name/state、已有 literal 的值与来源以及当前 local step，不能只给数字 ID 或为所有候选
机械复制相同提示。Jev 返回 ID 后，Runtime 必须重新检查 Observation、focus/state、ToolRegistry、schema、
Guard 和预算；下一帧整张映射表失效。无法完整映射为现有 ToolCall 的候选不得获得 ID。

第一阶段可表达：

- `CLICK_ELEMENT(elementRef)`；
- `TYPE_LITERAL(valueId)`，但仅当目标已经聚焦，文字来自用户、已确认 Memory 或主 Provider；
- 有限 allowlist 的 `KEYPRESS/HOTKEY`；
- 有界方向、区域和 ticks 的 `SCROLL`；
- 有界 `WAIT`；
- DOM/UIA 已显式暴露时的 `SELECT_OPTION`。

任意坐标点击、任意文本、任意 drag、跨应用切换、全局 finish/interact、Plan/Memory 写入继续交给主 Provider。
现有 `type` 没有 elementRef 参数，因此未聚焦文本框不能被伪装成 element-bound type；首版应先 click、重新
observe 确认 focus，再开放 literal type，或另行设计经完整评审的复合动作，不能绕过现有 batch 合同。

一次 Jev 请求可以使用 operation 与 operation-specific action-instance 的并行 heads；Runtime 只消费所选
operation 对应的 head。每个 option 必须是 compiler 已批准的 immutable `actionInstanceId`，已经绑定完整
target/value/keypress/scroll 参数；禁止把独立 target/value heads 自由组合成 compiler 从未批准的 tuple。
如果实验确需分头返回参数，Runtime 必须对最终 tuple 做 exact membership 校验。是否可交给 Jev 用独立
Noul/Score 表达，不能继续让一个宽泛 `FALLBACK` 与数十个具体元素在同一 Choice 中竞争。所有 heads 共享
同一小型 state，因此不增加第二次网络往返。

本文所称 delegated Local Policy 是控制权合同，不是第三个完整 Provider：ActionSpaceCompiler 即使没有
ExecutionSegment 也可以生成当前 Observation 的有限候选；Jev Context 同时接收 Goal、Plan、Memory、最近
动作以及可选的 Segment。是否允许 active 执行由后续 Runtime gate 决定；当前 V0 仍只做合同/shadow，低置信、
候选缺失、用户纠正或异常时立即回到主 Provider。GLM/Qwen 始终负责 Goal、视觉、开放文本、Plan/Memory、
恢复、用户交互和最终回复。

### 13.3 当前召回链路的真实状态

当前存在两套独立选择器：

1. Runtime `DeterministicGroundingSelector`：raw → 去重/配额/排序 → hot-16，供主 Context 使用；
2. `advisor-jev.selectCandidates`：再次从 raw 独立去重/排序 → projected-64，供 Jev 使用。

它们的去重阈值、权重、来源配额和排序规则不同，已经形成漂移风险。最近真实 Run 的十次坐标点击都能
映射回 raw catalog，但仅三次进入 hot-16；这证明主 Context hot recall 不足，却没有证明 Jev-64 是否漏召回。
当前轨迹原先未持久化正确目标在 advisor pool 中的 membership/rank，因此 Jev top-1 错误与 retrieval miss
仍无法完全区分。新增诊断只对 advisor 实际完成 projection 的 observation 提供 exact-ref/spatial rank；它仍
是被 eligibility/request gate 条件化的样本，不能冒充全量 counterfactual recall。

另外，Jev 选择器在没有 active ExecutionSegment 时会把宽泛 Goal、Plan 和中文 2/3-gram 混入排序；64 项
候选再按 UIA/DOM 各半配额填充，既可能保留语义重复节点，也会把与当前动作无关的浏览器 chrome/页面元素
送入同一次 Choice。真实请求达到约 1.4–1.6 万输入 token 和 1.2–2.5 秒，说明状态仍然过大。

### 13.4 召回重构门槛

不能直接删除任一选择器或让 Jev 复用 hot-16。先增加共享、纯函数的 `GroundingRetrieval`，输出稳定的
semantic target cluster：保留 DOM/UIA aliases、代表元素、role/state/bbox/source、匹配证据和 rank。
hot Context 与 Jev ActionSpace 可以取不同 K，但必须消费同一 cluster ranking/query，不再各自实现词法和
去重算法。视觉坐标映射也应对 cluster 统计，而不是要求 DOM/UIA ref 字符串完全相等。

在 shadow 阶段至少记录以下无文本诊断：

- `rawTargetPresent` 与 raw rank；
- `clusterTargetPresent` 与 cluster rank；
- `contextHotPresent` 与 rank；
- `localPolicyPresent` 与 rank；
- operation-compatible candidate count；
- Jev operation/target top-1、margin、是否与目标 cluster 一致；
- 无 segment、候选不足和视觉-only fallback 的独立原因。

primary recall 只统计主 Provider 产生、Computer 最终 completed、raw containment 命中的动作；FastPath 自产
动作、failed/cancelled、nearest/none 必须单列，防止策略用自己的选择自证 recall。先用这些已发生动作作
弱标签回放，再抽样人工标注；主 Provider 动作仍只是代理，不是业务真值。projection 必须逐步从在线 advisor
调用中解耦成纯函数 counterfactual 计算，明确记录 projection version/K、not-evaluated reason 和全量分母。
只有 `localPolicyRecall@K` 达标后才评估 Jev ranking；只有 ranking 达标后才校准 Noul/Choice 放行门槛。不能
通过扩大 K 或降低阈值掩盖 retrieval miss。

### 13.5 安全实施顺序

1. 只补双投影 coverage/rank 诊断并回放现有轨迹；
2. 抽出共享 semantic clustering/ranking，保持 hot-16 与现有 active Jev 行为可回退；
3. 新增 `BoundedActionSpaceCompiler`，先做离线和 shadow，不执行；编译器不要求 ExecutionSegment，active
   是否需要有效 Segment 由独立 Runtime gate/实验模式决定；
4. Jev 改成 `can_execute` + operation + operation-specific heads，仍只 shadow；
5. 先 active `CLICK_ELEMENT`，证明 accepted precision、主 Provider 请求减少量和端到端成功率；
6. 再分别加入 focused `TYPE_LITERAL`、有限 key/hotkey、scroll/wait/select，每类独立消融；
7. 任一阶段出现任务成功率下降、错误动作无法被 post-observe 截断、Provider fallback 失效或架构边界绕过，
   立即回退到上一版本。

这个顺序保证 Jev 只是可拔插的局部策略；即使实验失败，关闭开关后仍回到未经改变的 GLM/Qwen 主链。

实施状态（2026-09-22）：步骤 1–2 的 counterfactual projection、共享 semantic clustering/ranking 与无文本
coverage 指标已经落地，但共享排序尚未替换现有两个 selector。步骤 3 已完成纯函数、shadow-only 的
`BoundedActionSpaceCompiler` V0：它不依赖 active Segment，只根据当前 Observation、Grounding、能力和已注册
`click_element` 工具产生有界候选；每个候选绑定 Observation、Session、完整 elementRef 参数，并携带有界、已
清理的 UI 语义证据。步骤 4 的 delegated wire 也已更新为消费现有 `FastPathAdvisorInput`，包含 Goal、Plan、
Memory、Corrections、RecentActions 和可选 Segment，并用编译器候选替换旧 raw candidate projection；随后已接入
RunController 的独立 delegated shadow seam。步骤 4 仍只做 shadow 合同验收，步骤 5–6 未开放，旧 click-only
`active` 继续作为可回退实验基线。

步骤 4 的纯 wire 合同随后完成，并已接入 `RunController` 的独立 shadow seam：V0 请求包含现有 Runtime advisor input 的有界
Goal、Plan、Memory、Corrections、RecentActions、可选局部 Segment，以及 Runtime 编译的候选语义；不包含
elementRef、ToolCall 参数或截图。由于 V0 只有一种 operation，wire 只询问 `can_execute: EXECUTE | ABSTAIN` 和 `click_action: actionInstanceId`；固定为
单选的 operation head 没有信息增益，暂不预留。等第二类动作真正具备 compiler 生产者和 Runtime 消费者时，
再增加 operation head。解析器严格校验概率全集、归一化和 request-local ID membership，输出只读 shadow
advice，不生成 ToolCall。当前仍处于“shadow 可测试、active 未接入”的安全阶段。

## 十四、2026-09-22 携程 shadow 召回实验

Development 任务 T03 使用 GLM-5.3-Flash、hybrid grounding、Jev shadow 和 persistent managed browser
运行；Jev 没有执行任何动作。Run 共完成 8 个 GUI 动作和 8 次主 Provider 响应，随后再次因 CUA window
capture 没有返回单张 PNG 而终止，因此本次只用于召回诊断，不计 Task Success。

七个由主 Provider 产生且 Computer 最终 completed 的坐标点击全部能在 authoritative raw catalog 中通过
containment 找到元素。主 Context hot-16 exact-ref 仅命中 1/7；counterfactual Jev projected-64 exact-ref
命中 3/7，排名分别为 3、56、58。说明 raw grounding 有覆盖，但当前 lexical/source 排序把部分实际目标压到
很后，且 DOM/UIA alias 可能造成 exact-ref 假阴性。

本次最初记录的 spatial rank 全部为 1，复核发现 projected pool 中的页面级 `Document` 大框覆盖所有点击点，
所以“任一包含框”没有判别力，不能报告为空间召回 7/7。实现已改为只记录包含点击点的最小面积 projected
候选之 rank；旧 Run 不回填新指标，必须由后续 shadow 重测。

Jev 共发出 7 次真实请求，延迟约 1.21–1.76 秒，单次输入约 14.1k–15.3k token。只有一个回合的最高
click 候选与主 Provider exact-ref 相同，但其概率 0.42，仍低于 `FALLBACK=0.54`；另一个实际目标虽在
projected rank 56，却只获约 0.01，而另一个 click 候选获 0.73。其余 exact target 未进入 top-3。该结果同时
说明：当前单一 `FALLBACK + 64 clicks` Choice 存在拒答/类别稀释问题，而且 broad Goal-only 排序不足。

本次主 Provider 没有创建 `ExecutionSegment`，因此不能评价“带局部 Segment 提示”的 active gate 效果；但它仍可
用于验证无 Segment 的 action-space/wire 构造与 Jev 的 shadow 选择。下一实验应在保留无 Segment 对照的同时，
完成 smallest-containing 指标、semantic cluster/alias 规则和 CUA read-only capture 恢复，再以 shadow 比较：

1. exact-ref recall；
2. smallest-containing spatial recall（仅辅助）；
3. 人工确认的 semantic-cluster recall；
4. 有/无 ExecutionSegment 的 operation/target accuracy；
5. input token、p50/p95 与主 Provider 调用减少上界。

同日第二次 T03 shadow 在加入只读 window capture 单次恢复和 smallest-containing 诊断后完成：Runtime outcome
与 model-reported status 均为 success，12 个动作全部 completed、13 次 Observation、无 Runtime/Tool/Provider
错误。当前成功路径没有独立的 retry-applied 事件，因此它只能证明补丁未造成明显回归且本次没有复现末尾崩溃，
不能证明真实 Run 中一定触发了 retry；重试分支的直接证据来自 first-empty→second-PNG、持续空图、Abort 和
action-count 的 adapter 回归测试。任务业务成功仍保留人工复核，不由 Runtime success 自动推出。

第二轮只有前三个动作是坐标 click，其余主要为 scroll，因此 primary recall cohort 为 3：hot-16 exact 0/3，
Jev-K64 exact 1/3（rank 56）；smallest-containing rank 分别为 56、1、1。后两个 rank 1 仍可能是页面祖先或
与目标同区域的不同 alias，仅能作为空间覆盖辅助，不能算 semantic hit。4 次真实 Jev 请求全部选择 FALLBACK，
延迟约 1.26–1.69 秒，输入约 14.1k–15.4k token；后续滚动 observation 虽通过纯 projection 计算 shortlist，
但网络 eligibility 正确地以 `unsupported_recent_action` 跳过。因此 counterfactual projection 已与网络调用
解耦，但 semantic-cluster recall 尚未闭环。

同日已加入第二条**只诊断、不执行**的共享语义召回链：`DeterministicGroundingRetrieval` 从同一 raw catalog
进行保守的 DOM/UIA alias 聚类和全量确定性排序，Runtime 只记录目标 cluster rank 以及其是否进入共享
hot-prefix/Jev-prefix。现有主 Context hot selector、Jev 在线 shortlist 和执行路径均未切换到该结果，因此这一步
只能用于比较召回算法，不能宣称已经改善模型可见候选或 Jev 成功率。该实现的目标测试、指标脚本和类型检查已
通过；下一门槛是用真实 shadow 轨迹比较旧 selector 与共享 cluster ranking，再决定是否让二者消费同一排序。

## 十五、2026-09-22 delegated Local Policy Runtime shadow 接入（历史实现快照，已被第二批收口 supersede）

> 本节保留真实实验对应的实现证据和事件语义。文中的 `legacy-fastpath`、`FastPathAdvisor`、`jevPolicy`、active 配置和旧 CLI 命令均为历史快照，不是当前可用配置；当前合同见第二十二节。

本轮曾将 delegated Jev 从“仅有请求/解析合同”接入 Runtime 的独立 shadow seam；当时没有替换
legacy FastPath，也没有开放 active 执行。后续收口已移除 legacy FastPath 执行 seam。

### 15.1 公共边界

Runtime 新增 provider-neutral `LocalPolicyAdvisor` 接口。它消费已有的 `FastPathAdvisorInput` 和
`BoundedActionInstance[]`，只能返回 `ok`、`abstain` 或 `failed`，并携带 action instance id、概率、margin、
confidence、`canExecuteProbability`、有界 `top3`、usage 和 latency。Runtime 不依赖 `advisor-jev`，也不把返回值
转换成 `ToolCall`。`canExecuteProbability` 和 `top3` 会以脱敏形式进入轨迹，便于按概率分桶和回看候选排序。

`JevDelegatedLocalPolicyAdvisor` 位于 `advisor-jev`，复用 Jev 的请求构造、严格 request-local id 解析、
HTTP client 和 deadline。它的输出仍是局部策略建议，不包含 `elementRef`、GUI 参数或执行权限。

### 15.2 Runtime 时序与边界

当历史 `jevPolicy=delegated-local` 且 `jevMode=shadow` 时，Runtime 在每个已提交 Observation 后最多发起一次
delegated shadow 请求。请求事件先提交，advisor Promise 随即旁路启动；主 Context 和 GLM/Qwen Provider
继续执行，不再串行等待：

```text
Observation committed
  → raw catalog + shared semantic retrieval
  → BoundedActionSpaceCompiler
  ├→ local_policy.request.started → bounded local advisor (parallel)
  └→ normal Context → GLM/Qwen Provider
       ├→ local_policy.result / abstained / failed (safe linearization point)
       └→ local_policy.comparison (at most once)
```

历史 `delegated-local` 实现有一个独立的 Runtime admission gate。没有可信的局部 click demand 时，不会发起 Jev
HTTP 请求，只登记 `local_policy.abstained(reason=insufficient_local_demand)` 并交给主 Provider。当前唯一的
网络准入来源是 Monitor/recovery 路径产生的带有界 `localIntent`、且严格绑定最近一次未解决 click
（failed/unchanged/unknown）的短期恢复提示。完整 Goal、全局 Plan、ExecutionSegment、普通最近动作和候选数量
都不能单独授权一次 Jev 请求。Plan、Memory、纠正和最近动作仍通过同一个 `FastPathAdvisorInput` 投影给 Jev，
但不能授予执行权。无 grounding、无 shared
retrieval、无候选、无 local demand、超时、异常、pause、correction 或 abort 都只会记录诊断并回到主 Provider；
pause、纠正和 abort barrier 不会让过期建议继续执行。GUI 动作提交新 Observation 后，旧 probe 会被标记
`superseded_by_observation`；其迟到结果只被有界等待收尾，不再比较。Run 结束前 Runtime 会对仍在途的
probe 做一次有界收口，确保不会留下未处理的拒绝或在 `run.finished` 后追加事件。

这些事件是脱敏诊断事实：`local_policy.admission`、`local_policy.request.started`、`local_policy.result`、
`local_policy.abstained`、`local_policy.failed`。同一 Observation 的局部结果和候选绑定只保存在 Runtime
内存中，并在新 Observation、pause/correction/abort 或 Run 结束时清理。主 Provider 下一步明确后最多生成一次
`local_policy.comparison`：它只记录 `mainDecisionKind`、操作是否一致、精确/语义目标是否一致、top1/top3
是否覆盖以及不可比较原因；不写入主 Provider 的坐标、`elementRef` 或完整参数。这个 comparison 是“主 Provider
与局部策略的 agreement proxy”，不是业务正确率、任务成功率或执行授权。它们不增加 `model.requestCount`、
GUI action budget 或 legacy `fastPath` 计数，也不写入 `elementRef`、完整 arguments、截图或 UI 私有文本。

### 15.3 历史用户开关（不可再使用）

```text
--jev-policy legacy-fastpath   # 旧 click-only FastPath，保持原行为
--jev-policy delegated-local   # 新 delegated Local Policy，当前只允许 shadow
--jev-mode off|shadow|active   # 运行模式；delegated-local 只能配 shadow
```

这些开关只用于复现实验轨迹，不代表当前 CLI 合同。当前默认模式仍为 `off`，shadow 只保留 recovery-only delegated local-policy。

### 15.4 当前验证范围与未验证项

离线验证覆盖：无 local demand 的零网络 abstain、recovery demand、shared retrieval 候选、每 Observation 一次、delegated 请求与主 Provider
并行进入、Provider/局部策略不同完成顺序、GUI 新 Observation 对旧 probe 的 supersede、主 Provider 继续调用、
abstain/failed 继续、pause/correction/abort barrier、一次性 comparison、click_element 精确/alias、坐标
containment、非 click/control 分类、事件脱敏、active 配置拒绝和 legacy 测试回归。metrics 脚本现在另外输出
局部策略概率分桶、top1/top3、operation/exact/semantic agreement 以及 unavailable reason，并明确标注为
主 Provider agreement proxy；如果主 Provider 更快而 Runtime 在安全边界等待局部策略，还会统计
`shadowWait`。本轮默认 delegated-local `K=32/deadline=3500ms`，legacy-fastpath `K=64/deadline=2500ms`，
显式配置覆盖默认值。上述旧配置名和 FastPath 测试已在第二批清理中移除。
以上是实现批次结束时的验证边界，已被下节真实实验更新；`delegated-local` 仍保持 shadow-only，不能据此
开放 active 或宣称端到端加速。

## 十六、2026-09-22 真实召回失败分析与改进门槛

### 16.1 已确认的真实证据

第二次 12306 T01 shadow 使用 `K=32/deadline=3500ms`，Jev 与主 Provider 并行，`shadowWait=0`。主 Provider
完成 5 次决策；其真实点击目标在共享语义召回中的 rank 依次为 `14/154/28/48/125`，只有 2/5 进入
advisor K=32。Jev 发起 5 次请求，1 次返回候选、4 次 abstain；唯一候选与主 Provider 目标不一致。这个结果
首先证明 retrieval coverage 不足，不能用它评价 Jev 的任务正确率。

本 Run 没有 `ExecutionSegment`、Planning、Memory、用户纠正或 recovery hint。五次 Observation 的检索查询
实际上都退化成同一条完整 Goal。算法无法知道局部目标已经依次变成日期、日期面板中的具体日、高铁/动车、
查询按钮和发车时间筛选。当前中文 2/3-gram 又按命中数量直接累加，长 Goal 和长候选文本容易靠大量弱匹配
获得高分；单个 Goal token 的权重还显著高于 actionable、focused/editable 和可靠来源奖励。页面菜单、长列表项
和重复 UIA/DOM 节点因此会压过短标签控件。扩大 K 只能增加 token 和延迟，不能修复该排序失真。

### 16.2 改进原则

召回改造采用“需求生产 → 安全聚类 → 分层排序 → 有界多样性”四步，而不是继续给特例加关键词：

1. **当前决策需求**：局部意图或 recovery 为最高优先级；当前 `in_progress` Planning task 次之；只允许通过
   scope/status/实体生命周期检查且与当前 task 相关的 Hot Memory 提供实体和约束；完整 Goal 仅作弱背景。
   不再拼接全部 pending tasks 或全部 Memory。
2. **有意义的局部意图生命周期**：主 Provider 可以在当前 ModelTurn 中显式建立短期 Segment；后续可实验
   一个可选、单次 Observation 有效的 next-step lease。它必须描述真实可预见的操作类别、目标语义和失效边界，
   缺失时不机械生成模板文本。新页面、用户纠正、失败、Monitor recovery 或完成一次约定动作立即使其失效。
3. **分层而非无界加分**：先过滤不可执行/无边界/broad ancestor，再按 local/recovery、active task、Hot Memory、
   Goal fallback 分层。每层使用 exact/phrase/token-overlap 的归一化相似度与 role compatibility，不能让文本长度
   或 n-gram 数量无限抬分。`enabled/actionable/source-region` 是准入和可靠性信号，而不是被一个弱 Goal token
   轻易覆盖的小 bonus。
4. **来源融合和多样性**：managed browser 内容区优先 DOM，浏览器 chrome 优先 UIA；同一可操作目标的安全
   DOM/UIA alias 只占一个槽位。对重复列表/同类兄弟节点做有界多样性控制，但 exact local match 可以突破配额。
   UIA-only/native 场景不套用 DOM 规则。
5. **没有决策需求就不浪费 Jev 请求**：若既无局部意图、recovery、active task，也无法把 Goal 判定为明确的
   单步局部目标，则 delegated policy 应直接记录 `insufficient_local_demand` 并交给主 Provider。主 Provider 可以
   在本轮建立下一 Observation 可消费的短期需求。

### 16.3 Planning 与 Memory 的激活要求

工具“已注册”不等于模型会使用。开启功能时，系统提示和工具描述应明确：多阶段、跨界面、比较/汇总任务在
首次 GUI 动作的同一 ModelTurn 创建一个 handoff-sized 当前阶段，并在阶段切换、真实阻塞或目标变化时更新；
简单单屏任务不强制建 Plan。Memory 只保存离开近期历史后仍需要的约束、对象或最终汇总事实，可在同一轮先写
1–2 条再继续 GUI；不得记录每次点击、复制 Plan 进度或把当前可见值自动当作稳定事实。

提高调用优先级必须以消费闭环验收：Plan 要成为 active-task retrieval/context 的输入；Memory 必须在后续 Context、
召回或最终交付中被实际读取。只写不读、机械创建、重复 Goal 或重复当前屏幕不算收益。

### 16.4 实施与验收顺序

1. 先持久化脱敏的 query-source、目标 rank、score components、alias 数量和 `recall@8/16/32/64`，不保存 UI 文本。
2. 用本次 5 个主 Provider 点击作为 silver diagnostic，补充日期面板、短标签下拉框、重复列表和 DOM/UIA alias
   反例；主 Provider agreement 仍不当作业务 ground truth。
3. 先替换长度敏感打分和来源配额，再接 active-task/Hot-Memory 投影；逐项 ablation，不能同时改阈值掩盖问题。
4. 达标线：明确局部需求样本 `recall@32 >= 95%`，无局部需求时可靠跳过 Jev（`insufficient_local_demand` 且无
   `request.started`），重复 alias 不挤占多个槽位；
   false-execute 仍为 0 的受控样本后，才重新评估 Jev ranking 和 active gate。

### 16.5 第一批 P0 实施状态

第一批实现没有扩大 K：共享 retrieval 已将 checkbox、radio、combobox、menuitem、option、tab、switch、
slider、spinbutton、treeitem、calendar 等常见 DOM/UIA 角色纳入可操作族；query channel 改为 name 优先、
description 有界辅助的归一化 exact/phrase/precision/overlap 评分，每个 channel 最多贡献其固定权重，DOM/UIA
alias 也不会重复放大文本证据。包含长菜单、长结果行和 154 个干扰项的 T01 形状测试中，日期输入、日期单元、
checkbox、查询按钮和 combobox 在 K32 内的 ranks 为 `1/4/3/5/2`。这是合成回归证据，仍需真实页面重测。

managed-browser DOM producer 同时补齐有界 accessible-name 近似：`aria-label` → `aria-labelledby` → 关联
`label` → `title/placeholder`；button/link 才使用有界文本。select/combobox 不再把全部 option 拼接成 name，
只把当前选项作为有界 description；input/password 值、DOM/node id 均不外发。

Planning/Memory 开启时，主 Agent 的 system prompt 与 ToolRegistry descriptions 现在共同说明激活条件。真实 API
协议回归中，GLM-5.3-Flash 与 Qwen3.8-Flash 均在一个 ModelTurn 正确返回
`task_create + memory_write_fact + click + type`，Runtime 分别持久化 1 个 PlanningTask、1 条 MemoryFact，并按序
完成 click/type；两者均在下一轮成功 finish。该实验只证明 Provider schema 与组合执行协议可用，不证明自然
任务会正确、适量地使用 Plan/Memory。下一次 T01/其他开发任务必须另外统计自然调用率、后续消费率和无效写入率。

## 十七、delegated Local Policy admission gate（2026-09-22，当前收缩版）

真实 T01/T03/T11 轨迹显示：在没有明确局部 click demand 时，delegated-local 每个 Observation 都触发一次
Jev 请求；这既浪费网络额度，也把 broad Goal/Plan 误当成了“下一步点击”的证据。当前修复将 gate 放在
`RunController.tryDelegatedLocalPolicy` 的 advisor 调用之前，使用纯函数 `evaluateLocalPolicyDemand`，
并进一步移除 ExecutionSegment 对该 gate 的准入作用，不改变 Jev wire schema、ToolRegistry、Guard、Abort
或 shadow-only 边界。

准入条件只有：

1. Runtime Monitor/recovery 产生带有界 `localIntent` 的短期提示，且最近一次动作是 unresolved click（失败、
   unchanged 或 unknown）；提示仍在最多三次的生命周期内，并且 `actionId` 必须严格相同。

完整 Goal、全局 Plan、普通 recent action、候选数量和“页面上存在可点击元素”都不单独触发请求。没有 demand
时 Runtime 仍可编译本地候选，但登记有界 `local_policy.admission(status=skipped, reason=insufficient_local_demand)`
和 `local_policy.abstained`，不会写入 `local_policy.request.started`，因此不会调用 HTTP advisor。新
Observation、Monitor changed、用户纠正和 Run 结束会使对应 demand 失效；Runtime 仍最多每个
Observation 处理一次，并清理临时 probe。

离线证据：`packages/runtime/src/local-policy.test.ts` 覆盖 recovery、attempted/changed/普通动作拒绝；
`packages/runtime/src/index.test.ts` 覆盖无 demand 的零 advisor 调用、主 Provider 继续、recovery demand 下的
并行 shadow 与 supersede。该 gate 只解决“何时值得询问 Jev”，不证明候选召回、Jev top-1 或业务任务成功率。
后续真实评测必须同时报告 demand coverage、no-demand zero-call rate、advisor K 内 recall 和 operation/target
agreement，不能把 skipped Observation 当成 Jev 错误。

### 17.1 Segment 生命周期修正

Segment 的完成证据不是尝试事实。Runtime 只有在主 Provider 的真实 Computer action 已经通过准备/校验并
写入 `action.execution.started` 后，且该 click 的 grounded target 与当前 step 的 intent/evidence 文本存在
有界语义匹配时，才写入 `step_attempted`；delegated Jev shadow 只产生诊断结果，不能写入该事件。随后新的
Observation 必须仍属于同一 `ComputerSession`、同一 viewport 分区，并且（由适配器提供时）保持同一不透明
才允许用 completion evidence 推进 cursor。未 attempted 的 step 即使页面上已经出现相同文字也不会推进；viewport
分区变化会使 Segment 失效。旧的单步 Segment 事件仍可回放，但新的 `execution_segment_set` 只接受 2–4 步，以
保证该机制在未来单独实验时有机会替代至少一个主 Provider turn；它不参与 delegated-local 的默认网络准入。

本批又补上了 recovery demand 的失效边界：`GroundingRecoveryHint` 不再跨用户纠正或新
Observation 携带旧的 `actionId`、失败区域和局部意图；纠正文本仍由正常 selector query 消费，
但不会与旧 click 绑定。delegated gate 还要求 hint 的 `actionId` 与最近一个 unresolved click
的 Runtime action identity 严格相同，并在缺少 identity、动作已 changed、hint attempt 超限或出现
其他动作时 fail closed。这样“旧 click 失败后用户改了目标”不会把旧区域和新目标拼成一次 Jev
请求。离线回归覆盖：不同 click 的 stale binding、缺少 action identity、attempt exhausted、纠正后
零 advisor 调用；实现位于 `packages/runtime/src/local-policy.ts`、`run-controller.ts` 及对应测试。

## 十八、2026-09-22 跨任务收敛与下一门禁

### 18.1 四条代表轨迹的分层损失

T01、T03 和 T11 的四条代表轨迹中（T11 两次是同一任务的 deadline 工程复测，不当作两个独立
benchmark），主 Provider 坐标点击进入 shared K32 的比例为 `15/34 (44.1%)`，进入主 Context hot-16 的
比例为 `11/34 (32.4%)`。51 次 delegated Jev 请求中，13 次返回候选、14 次 abstain、24 次 deadline
或 fetch failure。在 13 次可比结果中，9 次与主 Provider 的 click 操作类型一致；其中 target top-1
agreement 为 `6/9`，top-3 为 `7/9`。这些是 agreement proxy，不是人工正确率。

因此当前损失顺序为：候选召回不足 → 网络可用性不足 → click-only 策略在 type/scroll/control
轮次被无效调用 → 候选进池后仍可能选错。不能用降低置信阈值同时修复这四层。T11 6000ms
轨迹中出现三次 `click vs other_computer` 错配，其中两次 Jev 对 click 非常自信，证明需要在网络
请求之前判断本轮是否真的需要 click，而不是继续增强 Jev prompt。

### 18.2 operation applicability 与召回的职责分离

当前系统只把严格绑定最近 unresolved click 的 Monitor recovery（含有界 localIntent 和相同 actionId）作为
click-local demand。ExecutionSegment 仍是保留的显式实验能力，但不再参与 delegated-local admission；重新启用它
必须单独设计和验证。Goal、PlanningTask、Memory、ToolRegistry capability、assistant narration 和普通最近动作
只能作为主 Provider/候选排序背景，不能单独授权 Jev 网络请求。focused/editable 状态甚至更可能表示下一步是 type。

实验需要显式分为：

- `shadow-all`：仍可每 Observation 探测，只用于收集 counterfactual 数据；
- `demanded-shadow/active`：只有强 typed click demand 才发网络请求；无 demand 时记录
  `insufficient_local_demand`，但可继续离线计算 shortlist/recall，不消耗 Jev API。

### 18.3 Planning/Memory 的真实证据与边界

T03 自然使用 2 次 Planning，T11 两次均使用 4 次 Planning 和 2 次 Memory。T11 已证明两个
handoff-sized 阶段可被创建、完成并切换；第一阶段路线事实写入 `m1`，第二阶段写入 `m2`，后续
Context 可消费。这证明数据链路已打通，但没有同版本 off 对照，仍不能宣称它们已减少步数或提高
成功率。同时，页面查询结果被模型标为 `retentionClass=stable`，这与它们仅对当前 Run/观察时点有效的
事实不一致，是后续 Memory 质量门禁，不应通过扩大召回权重掩盖。

### 18.4 下一步真实任务

operation applicability 门禁和完整分母指标就绪后，先跑冻结任务 T07，检查同一网站旧日期→新日期的
Segment 生命周期、click/type 轮次跳过和新日期事实隔离；再跑 T09，检查携程→高德的跨应用清理、
Plan 交接、Memory 携带和新页面重建 local demand。两者都必须分开报告：业务结果、recall@K、
Jev 网络成功率、operation applicability、target agreement 和 Plan/Memory 消费闭环。

### 18.5 operation applicability 指标实现（2026-09-22）

为避免只统计“及时返回且进入 comparison 的请求”造成幸存者偏差，Runtime 新增脱敏的
`local_policy.admission` 事件。每个启用 delegated-local 的 Observation 最多产生一条 admission：
`eligible_demand` 表示通过 typed click demand 门禁，`insufficient_local_demand` 等枚举原因表示
零网络跳过；事件只含 advisor/model、Observation ID、候选数量和枚举原因，不含 UI 文本、坐标或私有
elementRef。旧轨迹没有该事件时，metrics 脚本从既有 request/abstain/failed 事件做保守回溯，因此不会
把历史结果静默丢掉。

出行 metrics 现在按 Observation 去重输出：`eligible`、`requested`、`eligibleCoverage`、
`skippedNoDemand`、`zeroCallRate`、`supersededBeforeComparison`、`comparable`、
`comparableCoverage`（另给出按 eligible 的覆盖率）及 `admissionReasons`。其中 comparable 只把主 Provider
在同一 Observation 上做出 click 决策的 comparison 纳入；type/scroll/control 等 operation mismatch
仍保留在 comparisonProxy，但不混进 click target 分母。superseded 是已发起
请求、在 comparison 前因新 Observation/纠正/暂停等被收口的请求；comparable 只表示主 Provider
在同一 Observation 上完成了可比决策，绝不表示业务正确或目标选择正确。agreement/top1/top3
仍仅作为诊断 proxy，不进入 truth、success 或 accuracy 结论。

全局 `usage`/`allModelUsage` 现在是 main Provider、Guard 和 delegated local-policy 的 all-model 合计，并保留
`usageByComponent` 与 `localPolicy.usage` 分项，避免把 Jev shadow 成本误算成主模型成本。该改动只
更新事件、聚合与测试，不改变 delegated-local 的 shadow-only 调度和执行权限。

## 十九、demanded shadow 真实任务结果（2026-09-22）

### 19.1 T07：同应用日期变更

T07 在 12306 完成了 09-23→09-24 的两阶段查询，Runtime 和模型均报告 success，9/9 GUI 动作
completed，无 Runtime/Tool/Provider 错误。业务结果仍需人工判定，不由 Runtime success 自动推出。

operation gate 在 10 个决策 Observation 中将 9 个判定为 `insufficient_local_demand`，对这些轮次零
Jev 网络请求。唯一请求来自一次点击无变化后的 Monitor recovery，848ms 后 Jev 选择 abstain。这
证明门禁修复了“每帧付费”，但幸福路径中主 Provider 未创建 `ExecutionSegment`，所以 Jev 仍无正常
接管点。Planning 创建/完成两个阶段（4 次操作）；Memory 未使用，对本任务是可接受的。

shared K32 对坐标点击的银标签覆盖为 `4/9`，ranks 为 `7/5/1/195/190/197/197/75/7`。其中一次
rank 195 的点击实际落在了错误日期栏，因此 coordinate containment 只是诊断上界，不能当作人工正确
target。后续必须分开报告“主模型点击所在 cluster”与“人工标注的正确控件”。

### 19.2 T09：跨应用难题的有效失败

T09 运行到 30 个 GUI 动作、29 次模型请求后人工终止；终止前 30 个动作均 completed，但模型在确认
09-22 白天直达列车已不可查后，又转向 09-23 并继续滚动搜索。这改变了用户明确约束，所以该 Run
只是 `constraint drift` 失败样本，不是携程或 Jev 特例。不为它增加日期/网站补丁；若后续形成机制，只能
实现为通用的“不得未授权放宽显式约束”语义边界。

该 Run 的 gate 对 28 个主决策全部记录 `insufficient_local_demand`，因此 Jev 请求为 0；取消时只记录
一个 cancelled sidecar。主 Provider 没有创建 `ExecutionSegment`，表明混合 type/scroll/click 的开放任务并不自然
产生 click-only demand。shared K32 的坐标银标签覆盖为 `11/18`；仍需人工 target 标注后才能评价
真实 recall。Planning 创建携程阶段并交接到高德阶段；Memory 用 task retention 保存了 09-22 无直达结果，
但模型在真正切换应用前又停留在次日替代搜索，说明“已写 Plan/Memory”不等于执行已按交接状态收敛。

### 19.3 当前判断

demanded gate 可保留：它大幅减少无效请求，且没有破坏主 Provider 任务。但不应开放 Jev active：真实任务中
typed demand 生产率近乎为零，候选召回仍不足，而且 coordinate agreement 缺少人工 truth。下一步不是再降 Jev
阈值，而是：先建立少量人工标注的真实局部 click 样本，分别评估 raw producer、shared retrieval 和 Jev ranker；
同时只在真正可预测的稳定 click micro-sequence 中继续验证 `ExecutionSegment`，不强迫所有任务为 Jev 生产伪 demand。

## 二十、recovery retrieval wiring 修正（2026-09-22）

首次 Observation 的 shared retrieval 在 Monitor 产生 recovery hint 之前就已缓存，因此恢复路径若直接复用
该缓存，会忽略失败区域和局部意图，造成“候选已在原始 catalog 中、但 recovery advisor pool 仍排不到”的假阴性。
Runtime 现在只在当前 recovery demand 通过 admission gate 时，从同一个 authoritative raw catalog 重新调用最新的
`groundingSelectionQuery`，再编译原有 bounded K；普通无 recovery 路径继续使用 Observation 缓存，不改变权重、K 或
站点规则。`local_policy.*` 事件只记录有界的 `retrievalSource`（cached/recovery_recomputed/cache-miss）以及比较时的
`targetPoolStatus`，不保存 UI 文本或坐标。

离线回归覆盖 recovery 重排确实改变 advisor candidates、changed post-observation 清理 recovery demand，以及主目标
未进入 bounded pool 的 `target_not_in_advisor_pool` 诊断。该修正只解决 retrieval wiring timing，不等价于提升 Jev
语义正确率，也不授权 active 模式。

## 二十一、GLM continuation 与 side-tool wire 探针复审（2026-09-23）

本节替代临时 next-click 探针文档，作为当前结论的唯一入口。两轮探针都只发送合成文本状态，未发送截图、真实网站、轨迹、Memory、账号或桌面操作；生产 `ModelTurn`、GLM/Qwen Provider、Runtime 和 ToolRegistry 均未修改。

### 21.1 原生 message 字段探针：no-go

对 GLM-5.3-Flash 进行了以下真实请求：

| 变体 | 请求数 | HTTP 200 | 动作有效 | 观察 |
|---|---:|---:|---:|---|
| 原生 tool call | 3 | 3 | 3 | `message` 只有 `content`、`reasoning_content`、`tool_calls`；content 为空，无独立 `nextClickIntent` |
| 原生 tool call + `response_format: json_object` | 3 | 3 | 3 | 仍返回原生 `tool_calls`，没有新增字段 |
| JSON-only，无 tools | 9 | 9 | 6/9 | JSON envelope 可解析；正例 3/3 填 hint，负例 6/6 省略；但 3 个 scroll 动作不符合现有 ToolRegistry 语义 |

原生 tool call 的真实响应不能承载一个独立、类型化的 `nextClickIntent`。`assistantText` 只是 Provider 对非空 `message.content` 的现有映射，本轮原生 tool call 6/6 content 为空，不能把它当作可靠的 continuation 字段。JSON-only 虽能承载该字段，却同时把动作变成另一套 JSON-content 协议，不能伪装成当前原生 ToolCall。

此前 JSON-only 关闭 thinking 的 3 次 HTTP 400/code 1210 是模型不允许关闭 thinking，不是格式结论；使用 `thinking: {type:"enabled"}` 后才纳入上表。

### 21.2 可选 `declare_next_click` side-tool：未过门槛

第二轮保留 `click/type/scroll/terminate`，增加可选 function tool `declare_next_click(target:string, 1..160)`，使用 `tool_choice:auto` 和 `parallel_tool_calls:true`。提示只说明“当前动作成功后下一 click 高度可预测时自愿声明”，没有强制每轮调用。共 15 次真实请求：正例 3 次，负例 12 次（type、scroll、finish、不确定 click 各 3 次）。

结果：

| 指标 | 结果 | 门槛 | 判断 |
|---|---:|---:|---|
| 正例 annotation recall | 2/3 = 66.7% | ≥80% | 不通过 |
| 负例误报率 | 0/12 = 0% | ≤5% | 通过 |
| 原生动作 schema 合法率 | 14/15 = 93.3% | ≥95% | 不通过 |
| 原生动作语义匹配率 | 14/15 = 93.3% | 诊断项 | 有 1 次超时，无动作结果 |
| annotation 自身参数合法率 | 2/2 = 100% | 诊断项 | 通过 |
| 总延迟 | 4.8–30.0s，中位约 6.2s | 不设单点门槛 | 不体现低延迟优势 |
| 总 token | input 8,761；output 3,895；total 12,656 | 诊断项 | 仍有成本 |

正例一次只返回 click、没有声明；两次同时返回 click 和合法声明。负例没有误报，但这只是小样本合成状态，不能推出真实任务安全性。一次不确定 click 请求达到 30 秒超时，因此动作合法率也未达门槛。该 side-tool 设计当前 **no-go**：不能进入生产 ToolRegistry、不能让 Runtime 自动 armed、不能替代 GLM，也不能因此重建 ExecutionSegment。

### 21.3 独立生命周期原型与后续边界

临时纯状态机曾验证一条候选 lease 规则：proposal 必须是一个 1–160 字符的 hint 和一个 GUI anchor；只有同 run/session 的 anchor completed、下一 observation 较新且 `changed` 才 armed；unchanged/unknown、失败/拒绝/取消、纠正、pause、approval、abort、run end 和 crash 均失效，且只允许绑定 observation 消费一次。这个原型不是生产协议，当前不保留独立接线。

若未来重新研究 continuation，必须先提出独立的 structured-turn Provider 合同，把规范化 action 与可选 hint 一起解析为当前 `ToolCall`，再分别验证 schema、控制调用、Guard、延迟、stale observation 和业务任务成功率。不得以自然语言 `assistantText`、额外 marker 或 side-tool 结果绕过现有执行链。

### 21.4 清理与当前路线

本节并入了原临时 wire 审计和 side-tool 结果；临时探针脚本及临时审计文档在本次复审后删除，真实摘要留在本节，运行目录仅作为本地证据，不属于生产代码。后续复测没有证明 delegated recovery 能节省主 Provider 请求：恢复机会稀少，实际恢复调用均 abstain，continuation/side-tool 也没有达到门槛。因此本文件从这里起作为 no-go 历史证据，产品主线回到 GLM/Qwen、Grounding、Monitor、Context/Plan/Memory 和 CUA/OSWorld 体验优化。

## 二十二、当前实现合同（2026-09-23 收口后）

当前源码已经移除 Jev 产品链路：

- CLI、TUI、PowerShell、App Runtime 配置、Run 报告和 Provider/Runtime 注入中不再存在 Jev 开关、凭据、旁路网络请求或 Jev 指标。
- Runtime/Protocol/Trajectory 不再注册或消费 `LocalPolicyAdvisor`、`local_policy.*` 事件、bounded advisor action space、Jev comparison 或 recovery shadow 状态。
- `packages/advisor-jev` 及其 live probe 已删除；通用 `grounding-retrieval`/selector、Monitor recovery hint、ExecutionSegment 显式实验能力仍独立保留，不再隐式服务于 Jev。
- 2026-09-20 至 2026-09-23 的真实证据：all-observation shared recall@32 仅 `15/34 (44.1%)`；51 次 Jev 请求只有 13 次可比候选；两次实际 recovery 调用均 abstain；最终 GLM T07 成功只用了 5 个主请求且没有产生 recovery demand。继续保留旁路不能形成可靠的延迟收益。

本次收口后，Jev 只能作为本文件的研究记录，不能通过旧参数或历史构建产物重新启用。若未来重新研究，必须先创建独立实验包和新的成功门槛，不得恢复已删除的产品接口或把历史 no-go 结果当作当前能力。

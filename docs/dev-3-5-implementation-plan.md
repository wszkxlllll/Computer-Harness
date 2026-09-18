# DEV-3 / DEV-4 / DEV-5 implementation plan

日期：2026-09-19

状态：共享规划与合同入口；本批已形成 Context/Trace/prepared-provider foundation、Memory scope/recall/lifecycle、Monitor policy/online consumer，以及 bounded semantic retrieval 的 Memory/Context 离线接入。修复 retrieval integration review 三项 finding 后，Node 24/pnpm 11.19 独立 full 为 36 files/393 tests，typecheck、CLI help、锁文件安装和 diff-check 通过；此前 389 项属于修复前历史计数。另有合成 Qwen embedding pilot 4 次 HTTP、usage 合计 64 tokens，以及 GLM/Qwen 各 2/2 的 synthetic ORCHID Memory tool protocol probe。上述不是 Hosted CI、真实桌面或 DEV-3/4/5 整体效果验收；DEV-3/4/5 仍未整体完成。本文是 DEV-3 Context、DEV-4 Memory、DEV-5 Monitor 的唯一新增施工入口；DEV-6 承接 Risk Guard 与执行边界加固。路线、验收编号和重构映射仍分别以 [完整开发路线 V2](./full-development-roadmap-v2.md)、[验收清单 V2](./development-acceptance-v2.md) 和 [分块重构施工表](./module-refactoring-work-plan.md) 为权威，本文不另造阶段编号。

### 当前实现交接（2026-09-18）

- DEV-3 Context/Trace/prepared-provider/cache foundation 对应本地提交 `dee64fb`、`638d131`；`6cd7ddb` 进一步把 Memory recall selection 接入 Context 的实际 ModelInput。InstructionState/revision、最终 wire budget enforcement、集成后的真实 cache hit 与集中审查仍待后续批次；现有 Trace/prepared/cacheRead 字段不能扩大解释为这些未完成项。`01a6d47` 是 DEV-4 Memory 首批 scope、current/history applicability、revalidation 与 lifecycle handoff；`ba97878` 补齐 current read 分区、lifecycle source、Store 失败诊断和 Trace 实际渲染 IDs；`2e72f99`/`f22f96b`/`67542c7`/`6cd7ddb` 完成 bounded lexical/hybrid retrieval、`memory_search`、Runtime mutation sync 和 Context 自动召回离线接入。语义质量、跨 Run/target/generation 验证、完整生产任务与独立最终审查仍待完成；窄 synthetic provider protocol probe 不扩大这些结论。
- DEV-5 policy foundation `294cdf5`、online consumer `adea8d7` 与边界修复 `ba97878`/`eec591c` 采用 `off|shadow|guidance`，默认 `off`。连续 3 次相同 action、2 次拒绝/失败、A-B-A 与 3 次 Plan/Memory churn 只产生候选，当前无视觉特征；shadow 不干预，过时候选 clear。guidance 只进入下一轮动态 Context block，help 仅在完整 action→ToolResult→post-observation 后走 Runtime `waiting_user`/Inbox；unknown、审批和在途副作用屏障优先，不自动执行或审批。`ba97878` 后 147 项、`eec591c` 后 149 项 focused/typecheck 证据均通过，最终 full、Sol 定点复核和真实 API/桌面/VM 验证仍待完成。
- `9820851` 是 semantic retrieval pilot 的隔离起点；后续 `2e72f99`/`f22f96b`/`67542c7`/`6cd7ddb` 已接入 Memory exports、`memory_search`、app configuration、Runtime mutation sync 和 Context ModelInput。pilot 的 4 次合成 Qwen HTTP 不等同于集成后的真实生产 API；默认 lexical 不联网，hybrid 必须显式独立 endpoint/凭据。
- 通用离线入口：`pnpm --filter @computer-harness/cli start -- --goal "<goal>" --model glm-5.3-flash --computer cua --cua-socket "<socket>" --monitor off`；明确试验时可改为 `--monitor shadow` 或 `--monitor guidance`。示例不带凭证或本机路径，默认行为保持 `off`。

## 1. 本次对齐结论

| 阶段 | 本计划定位 | 不得提前宣称 |
| --- | --- | --- |
| DEV-3 | Context V2、指令修订、prepared request 与 ContextTrace | Trace/hash 不是完整 prompt、语义授权或 Provider 精确 token；当前 Compiler 仍是近似预算 |
| DEV-4 | Memory applicability/reconciliation 最小闭环 | 现有 `runId` 隔离、`active/needs_check/superseded` 状态不等于 scope、retention 或自动真值验证 |
| DEV-5 | Monitor：shadow → 有界候选 → 可选 guidance → 求助/停止 | 缺少 Plan/Memory 不等于停滞；截图 ID、动作 receipt 或模型自报不等于页面进展；shadow 不等于有效干预 |
| DEV-6 | Risk Guard 与执行边界的后续加固 | 本地规则不是开放域语义/视觉完美检测；低风险声明不是权威许可；公开安全集结果不能冒充 GUI 阻断结果 |

Monitor 保持 DEV-5，不与 Risk Guard 调换编号。Guard 的规则优先级、Host deny、mandatory approval、语义复核和安全评测准备写入 DEV-6，不把本轮 DEV-5 变成 Risk 阶段。后续阶段仍按 V2 的 REL-2 依赖推进。

## 2. 当前源码盘点与缺口

### 2.1 DEV-3 当前基础

`packages/context/src/compiler.ts` 的 `DefaultContextCompiler` 当前按 Runtime events、Plan、Memory、最新 Observation 组装 `ModelInput`，并可通过 DI 使用 Memory recall selection；`packages/context/src/index.ts` 重导出 compiler/recall 公共入口。`raw/recent` 和 `maxHistoryEvents` 已存在，预算以 `Math.ceil(characters / 4)` 估算，能保护用户输入并按完整 tool-call 组裁剪；Memory retrieval 的 safe trace 只记录 method/status/计数/稳定 ID，实际排序已进入 ModelInput。当前仍没有 Provider tokenizer 精确的最终 wire budget enforcement，估算不能冒充真实 usage。

`packages/runtime/src/run-controller.ts` 当前在每次 Provider `generate` 前调用 Compiler、记录 `model.request.started`、消费响应并执行工具；已有用户输入/暂停/纠正屏障，当前工作树已有 `ContextTrace`、prepared request metadata、request/decision/attempt 关联和取消屏障。仍没有完整独立 `InstructionState`、`CurrentInstructionView`、`instructionRevision` 语义视图或最终 Provider wire budget enforcement；Provider 的兼容 `generate` 入口仍保留，prepared 合同只在已接入的 GLM/Qwen 路径生效。

GLM Adapter 保留 native `tool_calls`、JSON-string arguments、reasoning continuation、coordinate profile；Qwen Adapter 明确保留 native 与 strict flat JSON 两种模式。DEV-3 必须在语义合同上统一追踪，不得把两种 wire format 强行改成一种内部伪格式。

### 2.2 DEV-4 当前基础

当前 `MemoryFact` 支持 `scope={run|computer_session}`、`retentionClass={stable|task|short_lived}`、status reason 与共同 applicability gate；`target` scope 和 target/generation producer 仍明确 unsupported。`InMemoryMemoryStore`/`FileMemoryStore` 按 Run 读写，Runtime 在事件提交后调用 `afterMemoryCommit` 物化，retrieval service 在工具/lifecycle mutation 后同步并在 recall 时复核 canonical state。当前仍没有 dependency refs、独立 verification producer 或自动 retention TTL；short-lived 只是 last-known/recheck 线索，不按动作、事件或 frame ID 自动过期。

必须分开四件事：

1. **适用范围**：`run | computer_session | target`，由 Runtime/Adapter 绑定，模型不能伪造原始宿主句柄。
2. **保留/召回类别**：`stable | task | short_lived` 是召回优先级与保留策略，不是权限、永久真值或跨 Run 授权。
3. **当前有效性**：沿用 `active | needs_check | superseded` 与实体 stale；needs_check 仍可查，但必须展示原因和证据等级。
4. **本次是否召回**：由 Context 结合 task relevance、scope applicability、状态与预算决定，不把存储存在等同于注入 Hot Memory。

`task` 完成只降低相关性，不自动删除仍可复用事实；`stable` 也不代表永久正确。用户已明确否决按动作数量、事件数量或截图 ID 自动判定事实过期：它们至多反映新旧，不能证明事实失效。只有真实生命周期变化、显式失效或修订等可解释信号才能改变相应有效状态；缺乏信号时不得声称已自动检测页面语义变化。

### 2.3 DEV-5 当前基础

当前有 Runtime event/trajectory、Observation、Action receipt、Plan/Memory snapshot，以及 `294cdf5`/`adea8d7`/`ba97878` 提供的有界 progress/stall candidate、work-clock policy 和 online consumer；仍没有可证明的视觉特征或通用页面语义。当前阈值只把连续 3 次相同 action、2 次拒绝/失败、A-B-A、3 次 Plan/Memory churn 作为候选，不能只读取“Plan 缺失”或“Memory 没写”作为停滞证据；shadow 不干预，过时候选只清理，默认 off。

### 2.4 DEV-6 当前 Risk 基础

`LayeredRiskGuard` 当前顺序为：缺失 effect declaration/forbidden shortcut → deny；声明 high-impact effect 或 protected input → mandatory approval；unknown、effect/action contradiction、有限文本信号 → semantic review；reviewer 未配置、失败或预算耗尽 → require approval。`routeCandidate` 消费模型声明的 effects/target/summary，`hasProtectedInput` 只有有限 credential/card/password 模式，不能宣称完美识别。

当前模型 reviewer 只提供 effects/alignment/evidence，最终 `assessmentDecision` 可在低风险且 aligned 时 allow；因此低风险声明、裸坐标、receipt completed 都不是权威安全许可。DEV-6 要求所有决策输出包含 decision path、reason code、evidence source、unknown/uncertainty，并保持 Host deny 与 mandatory approval 不可被模型降低。

## 3. DEV-3 实施合同：指令、Context、Trace

### 3.1 InstructionState / CurrentInstructionView

首批建议由 Runtime 从已接收的真实 user events 投影不可由模型直接写入的状态；不要在首批新增“模型自动 revoke 用户约束”的工具：

```text
InstructionEvent {
  eventId, runId, source="user", text, receivedSequence, receivedAt
}
InstructionState {
  revision, events[], currentView, unresolvedClarifications[]
}
CurrentInstructionView {
  revision, activeGoal, activeConstraints[], provenance[eventId...], uncertainty[]
}
```

合同：

- 原始 `user.input.received` 按序保留，CurrentInstructionView 是带 provenance 的派生视图；摘要不能删除原始“不要上传”等约束。
- `instructionRevision` 只在有效用户变更/确认后递增；普通截图、Observation、Memory 写入、Plan 更新不改变它。
- `decisionEpoch` 独立表示接管、目标 generation 变化、session 失效或其他执行边界变化；不能拿 instruction revision 代替 epoch。
- 首批只消费真实 `user.input.received` 的顺序、原文和显式 revision；语义 revoke/replace/add 暂不自动改变权威视图。未来若加入语义修订，必须先有明确 producer/consumer、澄清/人类确认和回退测试；来源 ID 证明来源，不证明授权。
- Provider 响应、审批和待执行 action 绑定 revision + decisionEpoch；迟到响应、旧 approval、旧 target 在执行前拒绝或标记 unknown。
- 持久化原始事件、派生 state、失效原因和迁移版本；Run 结束后按既有保留策略清理运行态，不将普通 Memory 当长期指令仓。

### 3.2 分区 Context 与 preparation

Compiler 至少分为：

1. 不可静默裁剪的当前权威指令/Host Policy；
2. 当前任务/Plan 结构；
3. Memory index/hot values（独立软配额，带 scope/status/证据）；
4. 完整近期轨迹组（response-call-result/action 组）；
5. 当前 Observation 与必要错误/拒绝/未决状态。

Provider-neutral Runtime 负责选择语义块；各 Provider 负责自己的 wire serialization、schema、图像/坐标与 reasoning continuation。Preparation 必须支持：

- `prepare(input, signal) -> PreparedRequestMetadata`（可有 AssetReader IO，但不可标为纯函数）；公开合同只暴露 schema/profile、估算、版本和关联 ID。真实 wire body 由 Adapter 私有 WeakMap/私有对象保存，不进入 Runtime 事件、ContextTrace 分享摘要或 normalized protocol。
- `estimate(prepared) -> ProviderInputEstimate`（独立类型；估算与真实 `ModelUsage` 分开）；不把估算结果伪装成 usage。
- `send(prepared, requestId) -> ModelTurn`，实际发送复用同一 prepared body，不二次隐式组装；
- `decisionId` 标识一次逻辑决策，`requestId` 对每一次真实尝试唯一（从 1 开始的 attempt number 另存），主模型与 Risk reviewer 分开关联。不要再让 requestId 同时表示逻辑决策和网络 attempt。

没有 tokenizer 精确支持时只记录估算、Provider usage 和差值；不制造跨 GLM/Qwen 的假精确 token。

### 3.3 ContextTrace

建议合同（字段名可在实现前冻结）：

```text
ContextTrace {
  runId, decisionId, requestId, attemptNumber, compilerVersion, providerProfile,
  instructionRevision, decisionEpoch, featureFlags,
  blocks[{kind, sourceIds, selected, reason, estimatedTokens}],
  budget{limit, estimatedFixed, estimatedHistory, estimatedTools, imageCount},
  preparedPayload{schemaVersion, wireShape, estimate, payloadHash, cachePolicy},
  redaction{shareable, omittedKinds}, retryOf?
}
```

Producer 是 Compiler/Provider preparation/RunController；消费者是离线诊断、预算审计和安全摘要导出；持久化为安全 JSONL/summary，原始 prompt、typed text、Memory value、路径、URL、图片和完整 wire body 仍是 private opt-in。`payloadHash` 只能关联同一 payload，不能恢复正文、证明语义正确或证明两个 Provider wire 等价。TraceStore 关闭/Run cleanup 必须有界，孤立 trace 不得改变 Runtime outcome。

### 3.4 DEV-3 验收与提交顺序

- CT/I01–I06：用户约束保留、授权对象不扩大、迟到 response/旧 approval 失效、Memory/截图不能伪造用户来源、revision/epoch 触发各自正确。
- CT01–CT06：Memory 挤占历史仍保留指令；中文、大 schema、图像、Provider catalog、retry/Risk preparation 可追踪；工具结果截断带标记且有真实私有查询消费者。
- commit A：纯合同/类型与 fake Trace producer；commit B：Compiler 分区/裁剪原因；commit C：GLM/Qwen preparation 适配与 Mock HTTP golden；commit D：Runtime request/attempt/迟到失效集成。
- 每笔提交独立 focused；纯提取不混行为变更，不在本阶段引入跨包第二套 Store/Router。

## 4. DEV-4 实施合同：Memory 生命周期与 reconciliation

### 4.1 Schema 与生产者

在现有 Memory mutation 上增量增加（待代码冻结）：

```text
scope: {kind:"run"}
     | {kind:"computer_session", sessionRef: RuntimeOwnedRef}
     | {kind:"target", targetRef: RuntimeOwnedRef}
retentionClass: "stable" | "task" | "short_lived"
verification?: {source:"runtime_event"|"observation"|"host_readback", sourceEventId, observedAt?}
```

首批只实现能由现有公开 Host/Adapter 合同真实生产的 scope。当前 CUA 的 session/target generation 不是可直接消费的公共生产者，因此实施前先核对现有 contract；无法提供真实绑定时，该 scope 返回结构化 `unsupported`，不得伪造 `sessionGeneration`/`targetGeneration` 或静默降级为 run。首批不把 Memory dependency 变成 `action_precondition` 权威，也不新增没有消费者的 dependency refs。模型只提议 scope kind 和语义事实，不能填任意 host handle、权限或“已验证”结论。

`verification` 只允许已有真实 producer 的 runtime event、observation 或 host readback；没有该证据时保持未验证，不填 `model_claim` 冒充独立证据。Runtime 在 mutation 提交前绑定可用上下文、验证存在性、拒绝跨 Run/失效引用；Adapter/Host 是任何 session/target ref 的唯一生产者。

### 4.2 召回、保留与失效

- `memory_get` 默认 current view；显式 `history` 才返回 superseded，needs_check 可读但带原因/证据等级。
- 召回排序分离 task relevance、scope applicability、status、retentionClass、recent change 和预算；stable/task/short_lived 不构成授权。
- 已有公共合同能证明的目标销毁/session close/绑定变化才产生可重放的 `memory.invalidate`/`mark_needs_check` 事件；当前没有真实 generation producer 时保持 unsupported/unknown。切焦点、重截图、普通动画不自动失效。
- target 暂非当前目标不进 Hot Memory，但显式查询可返回 `applicable=false`；无关稳定事实不因页面/目标变化删除。
- task 完成降低任务相关性，不全量删除；short_lived 不配置按动作数、事件数或帧数推断真值的 TTL。其内容按 last-known 线索呈现，不能不加区分地宣称为当前 GUI 状态。
- Memory off 时不注册工具、不写 schema/prompt、不启监听器；已实现的 Run/session/target close 监听与临时缓存必须有界清理，未有真实 producer 的 target/session scope 不创建监听器。

#### 待核实区：准入与更新闭环

`memory_get` 与 Context 使用共同的适用性判定。已替代、显式失效、实体失效或会话不匹配的记录不得进入普通 Hot Memory；历史查询可返回，但须标明原因。动态 last-known 线索与当前可用事实分区，不能仅增加标签后仍按确定事实拼接。

待核实候选按当前 Task/Entity 相关性挑选，和普通 Memory 共用总预算，不全量反复注入。提供记录 ID、来源、旧值及核实原因；优先复用本轮已有 Observation，由主模型通过正常工具调用修订，不为每条记忆增设一次模型或截图请求。来源 ID 只证明来源，模型修订也不等于宿主独立验证。

旧记录被修订或替代后退出未决清单；新的短期记录仍保持 last-known 语义，但不得因为下一帧 ID 改变就无限重复同一个核实事项。沿用现有多工具 Turn Policy，允许合法的 Memory/Plan 更新与 GUI 调用同轮提出；依赖前一个调用结果的更新仍需等待结果，Control 独占规则不变。

#### 首批召回排序基线与无 Plan 限制

首批召回采用可解释的有界启发式，而不是把排序分数当作事实真值。先过滤 scope 不适用、跨 Run/会话不匹配、`superseded`/显式失效记录；`needs_check` 可保留但必须带状态和证据。剩余候选按以下顺序稳定排序：

1. 当前 Task 的显式 `relatedTaskIds`/任务键匹配；无匹配时不因缺 Plan 直接淘汰。
2. 当前 Entity 的显式引用或稳定 key/subject 匹配。
3. `active` 优先于 `needs_check`；后者作为带标记的 last-known/revalidation 候选，不冒充当前 GUI 真值。
4. `retentionClass` 只作为召回偏好（`task`/`stable`/`short_lived`），不作为授权或永久正确性证明。
5. `updatedSequence`/可解释的最近变更作确定性 tie-break，最后用记录 ID 稳定排序。

所有分区共用一个软预算，先按上述顺序选取，再限制数量/估算 token；不全量注入、不为单条记忆单独调用模型或截图。没有 Plan 时，Task relevance 取中性分（仍可按 scope、Entity、status、key 和 recency 召回），不伪造计划、不把 Memory 关闭，也不阻断普通任务；显式 ID/key 查询仍遵守同一 scope/status gate。该启发式是待独立语义验证的召回基线，不是页面真值判定。

验收至少包含“写入事实 → 裁剪原始历史 → 按需召回 → 实体/会话失效后阻止普通召回 → 显式修订 → 后续只消费新状态”。分类错误和环境变化无信号仍是明确边界，不以这些机制承诺零过期记忆或自动视觉真值。

### 4.3 Store/迁移/重放

事件提交 → Snapshot → Store materialization 仍是唯一写入顺序。新增 `schemaVersion`/`lastAppliedSequence` 只有在迁移、原子物化、重放幂等和修复命令真实消费时才允许加入。旧记录迁移为 `scope=run`，不伪造 target/session 验证；跨 Run 不导入。物化失败停止并可从已提交事件重建，不建立第二同步真相。

### 4.4 DEV-4 验收与提交顺序

FM01–FM15 按路线清单覆盖页面不变目标、target 重建、task 完成、current/history、登录冲突、milestone、物化失败、模型不写 Memory、漏 dependency、needs_check、重放/旧 schema、三类 scope、focus/截图/销毁/session 重建、Memory off、两 Provider + CUA/OSWorld fixture。

FM09 的 action precondition/dependency 语义保留为后续合同问题；DEV-4 首批只实现真实 scope 绑定、召回适用性、失效和重放，不让 Memory 成为执行前置权威。

- commit A：纯 schema/migration/parser/Store contract（旧数据显式迁移）；
- commit B：Runtime 绑定可用 scope/ref 与失效事件；不得为不存在的 generation producer 造字段；
- commit C：Context recall current/history/适用性与 budget 消费；
- commit D：GLM/Qwen tool projection + Fake/Mock HTTP；commit E：受控 fixture integration。

不以“新增字段”“Store 能写 JSON”或单一 Provider 通过作为 DEV-4 完成；每个新字段必须列出 producer、consumer、persist、invalidate、cleanup。

## 5. DEV-5 实施合同：Monitor / Progress-Stall

### 5.1 Shadow 输入与签名

Monitor 只读 Runtime committed events/Observation/receipt/Plan/Memory snapshot，不拥有 GUI 执行权。每一步生成脱敏、稳定的 action signature：按可比较的 session/target/geometry 分区，组合 tool/action kind 与规范化参数值后在本地私有散列，并附结果状态；不要把每步变化的 `observationId` 放进 equality signature，Observation 只做溯源。typed text、URL、截图正文或 secret 不进入可分享摘要。

可选 screenshot feature 只有在真实 image bytes 可读、相同 target/session binding、viewport/geometry 可比较时生产；若后端没有公开 generation/稳定 binding 则返回 unknown/insufficient。截图 ID 只是引用，不是相似度特征。特征缺失、capture 失败、resize、target 切换、动画等不猜页面循环。

Progress evidence 分层：动作/receipt、同目标局部视觉特征、状态回访、错误/拒绝、Plan/Memory delta、模型自报。重复 type 或相同坐标 click 只能形成 stalled candidate，不能直接判无效；Plan/Memory 缺失是缺信号，不是 stalled；Memory 写入也不能自动清除 stalled 候选。

### 5.2 有界状态机与消费者

```text
shadow -> candidate(uncertain) -> guidance_eligible
       -> help_required | stop_required | clear
```

- shadow 默认不改模型输入、不改执行规则，只记录候选、证据 source、阈值版本、成本和 unknown。
- guidance 默认是下一轮正常请求中的短安全摘要，不额外调用模型；设置 cooldown、最大 guidance 次数、总时/请求/字符预算。guidance 不解除 approval、Host deny 或 unknown side-effect barrier。
- 持续不确定时转 `user_input_required`/求助或停止；Monitor 不触发重试、绕过 approval、重放 unknown side effect 或释放未确认 owner。
- Monitor 的输出由 Runtime 消费为诊断/控制事件；任何真正改变调度的 guidance 必须有显式开关和 feature version，不能只写事件没人读。

### 5.3 DEV-5 验收与提交顺序

PM01–PM08：正常连续 GUI、慢加载、重复无变化、A-B-A、无 Plan 短任务、Plan/Memory 空转、shadow on/off、guidance cooldown、unknown outcome、缺图/resize/目标切换/动画/有界淘汰。Development 集设阈值，冻结独立验证集，记录误报/漏报、干预次数、额外耗时/Token、guidance 前后分支。

- commit A：offline action signature / comparator / feature absence contract；
- commit B：online bounded shadow store 与 candidate state machine；
- commit C：guidance/help/stop consumer、cooldown/budget、unknown barrier；
- commit D：fixture/trajectory replay 与 development-vs-validation report。

若效果无益，可以默认 off，但仍需交付实现、对照和失败结论；不能用“shadow 已接入”冒充自动纠偏有效。

### 5.4 当前 online checkpoint（`294cdf5` + `adea8d7`）

本批（`294cdf5`/`adea8d7`/`ba97878`/`eec591c`）只落地有界的 `off | shadow | guidance` consumer，默认 `off`；没有 `stop_required` 执行消费者，也没有自动重试、审批或副作用执行。当前连续 3 次相同 action、2 次拒绝/失败、A-B-A、3 次 Plan/Memory churn 只是候选，视觉特征缺失时不补猜测；shadow 不干预，候选过时只 clear。Runtime 在提交事件并完成 reducer/feed 后推进 Monitor，Monitor proposal 自身不递归触发；work clock 只取实际首轮 model decision 与 action completion，trace/重试/Monitor event 不冒充进度。`outcome_unknown`、abort、pending approval/user question、未决 action 或其他 side-effect barrier 优先产生 suppression/none，不改写终态。

proposal 只含脱敏 fingerprint、source event IDs、reason/evidence kind、有限计数和可选短 guidance，不含正文、typed text、URL、截图或 secret。`guidance` 进入下一轮动态 Context block，并受共同预算约束；预算不足时省略并记录原因。`help_requested` 只在完整 action→ToolResult→post-observation 边界后复用 Runtime `waiting_user`/Inbox，由 Controller 唯一消费，不由模型文本冒充；Monitor proposal append/diagnostic failure 不改变已提交业务 outcome。partition/run/session 变化会清理本地去重状态；状态机和 online consumer 当前有 `ba97878` 后 147、`eec591c` 后 149 项 focused/typecheck 证据，但集中审查、最终 full、真实 API/桌面/VM 与效果评估仍待完成。

通用离线命令为：`pnpm --filter @computer-harness/cli start -- --goal "<goal>" --model glm-5.3-flash --computer cua --cua-socket "<socket>" --monitor off`。明确做离线对照时可把最后一项改为 `--monitor shadow` 或 `--monitor guidance`；示例不携带凭证或本机路径，其他默认 profile/Guard/Memory/Planning 行为不因该开关改变。

## 6. DEV-6 Guard 与执行边界承接

DEV-6 不是本轮 DEV-5 Monitor 的替代编号。继续沿用现有 Risk Guard contract，并加固：

1. Host deny、结构非法、mandatory approval 是不可降级底线；模型 reviewer allow 永远不能覆盖。
2. `declaredEffect/target/summary` 是不可信 evidence；裸 click 坐标、completed receipt、稳定 prefix/hash 均不能独立证明无害或成功。
3. `decisionPath`（local/model/fallback）、`reasonCode`、`reason`、`evidenceSources`、`unknown` 和 model usage/request count 必须进入安全事件/诊断；低风险不是权威许可。
4. 模型只处理模糊高危/矛盾的语义复核，不让每个 click 都调用模型，也不因一个低风险字段绕过本地规则；高危和 protected input 维持强制审批/deny。
5. 评测拆三层：路由/合并正确性；合成/公开集上的检测召回、误报和旁路；专用 GUI fixture 上的实际副作用阻断。公开恶意集成绩不能冒充第三层。
6. 无 OCR、无完美语义识别、无通用焦点/目标证明；缺信号转 unknown/approval/help，不在 Monitor 中补权限。

DEV-6 后续 commit 先做决策合同与 fake route merge，再做 provider assessor/预算与脱敏，最后做受控 fixture 副作用阻断。公开安全集本轮只做来源/分类/许可缓存，不下载运行攻击样本；后续如需适配，须另行授权隔离安全研究，不调用未批准 API、不接入真实桌面。

## 7. Provider 适配研究（官方来源；只读缓存，不执行）

| 来源 | 官方事实/适配差异 | license / GUI / 本仓可复用边界 |
| --- | --- | --- |
| [智谱助手对话 API](https://docs.bigmodel.cn/api-reference/%E5%8A%A9%E7%90%86-api/%E5%8A%A9%E6%89%8B%E5%AF%B9%E8%AF%9D) | 官方 response 有 `tool_calls[]`、function `name/arguments`（JSON 字符串）、id/type、finish_reason、usage；调用前需验证 arguments。 | 官方 API 文档，不是本仓代码 license；需要凭证/网络，当前只复用 wire-shape 与 Mock HTTP 适配结论，不运行 API。 |
| [DashScope Qwen API reference](https://help.aliyun.com/en/model-studio/qwen-api-via-dashscope) 与 [Function Calling](https://www.alibabacloud.com/help/tc/model-studio/qwen-function-calling) | Qwen3.8-flash 走多模态接口；官方文档列出 thinking/reasoning_content、preserve_thinking、tool calling/JSON schema 等参数约束。当前仓库还保留 native 与 strict JSON 两种 profile，不能把官方 wire 差异抹平。 | 官方服务文档，模型调用需区域 endpoint/凭证/网络；只做 contract/golden/Mock HTTP，不在本计划下载或消费额度。 |

Provider preparation 必须分别记录 profile、wire shape、reasoning continuation、tool format、image/coordinate schema、usage 与 retry attempt；语义层只共享 Trace/Memory/Risk contract，不共享一个伪统一 JSON。

来源适配注意：智谱页面是公开助手/对话 response schema 的官方参考，不自动证明当前选择的每个 GLM snapshot 都有相同能力；DashScope 页面明确列出 qwen3.8-flash 的接口/思考约束，但 region、model snapshot 和参数支持仍须在获授权的真实 API 计划中重新核对。本文不添加未经核实的 provider feature flag。

### 7.1 Context-cache / usage 规则（供 Context worker 冻结字段）

- [Alibaba Model Studio Context Cache](https://www.alibabacloud.com/help/en/model-studio/context-cache) 说明 implicit cache 自动开启、prefix 命中不保证；一般 Model Studio 模型的技术门槛为共同前缀至少 1024 tokens，Zhipu-deployed GLM 的门槛为 512。显式 cache 使用 `cache_control: { type: "ephemeral" }`，cache block 通常 5 分钟并可由命中刷新；implicit cache 没有固定 TTL。
- 同一官方页的 OpenAI-compatible/DashScope response 示例把命中数放在 `usage.prompt_tokens_details.cached_tokens`；`input_tokens`/`prompt_tokens` 仍是总输入口径。缓存命中只能由 provider usage 证明，稳定前缀、prefix hash 或请求相似度不能写成 hit。
- [Alibaba GLM model page](https://help.aliyun.com/zh/model-studio/glm-zhipu) 明列 ZHIPU/GLM-5.3 与 Flash 支持 function calling、上下文缓存和思考控制，且该托管路径写明 implicit cache/512-token 门槛；这不能自动外推到当前仓库直连的智谱 endpoint，直连 cache 字段/TTL 目前记为 **unknown**。
- 当前仓库 `ModelUsage` 保留 input/output/total 三个基础 normalized 字段，并允许由已验证的 Qwen response parser 产生可选 `cacheReadTokens`；缺失、非法或 GLM 未验证的同名字段不填假值。`cacheWriteTokens`、`cacheMode`、`cacheHitObserved` 尚无生产者/消费者，不能预填。若真实 API 获授权后需要更多计费诊断，必须由对应 response parser 生产、diagnostics/Trace 消费，缺失保持 unknown。
- 当前 preparation 只记录 `cachePolicy: unknown|implicit|explicit`、稳定前缀布局/版本和 provider profile metadata，不存原始 body；若未来显式 cache 适配，cache marker 必须由对应 Adapter 私有 WeakMap/body 产生，Runtime 只见 metadata。GLM/Qwen 的自动/显式支持、字段名、最小前缀和 TTL 必须按真实 endpoint golden/官方响应再次确认后才能启用。

## 8. 公开安全评测来源（仅适配研究，不下载运行攻击集）

| 来源 | 公开定位与 license | 是否需要 GUI/可离线复用 |
| --- | --- | --- |
| [AgentDojo](https://github.com/ethz-spylab/agentdojo) / [MIT license](https://raw.githubusercontent.com/ethz-spylab/agentdojo/main/LICENSE) | Dynamic environments，用于 prompt-injection attacks/defenses；仓库 MIT。 | 主要是 Python 工具环境/函数调用，不等于真实桌面 GUI；可离线复用 threat taxonomy、tool-filter/defense 对照和结果 schema。本轮不下载样本；后续适配需隔离授权，不能把公开成绩当 GUI 阻断。 |
| [AgentHarm official Inspect Evals](https://ukgovernmentbeis.github.io/inspect_evals/evals/safeguards/agentharm/) / [license](https://raw.githubusercontent.com/UKGovernmentBEIS/inspect_evals/main/src/inspect_evals/agentharm/LICENSE) | Harmful multi-step agent requests；MIT 加安全用途限制，只能用于改进 AI safety/security。 | 不要求真实 GUI；可只读复用分类/拒答与多步一致性矩阵。本轮不下载/运行 harmful dataset；后续适配需隔离授权，本仓不写攻击正文。 |
| [BrowserART / Scale Labs](https://labs.scale.com/papers/browser-art) / [paper](https://arxiv.org/abs/2410.13886) | 100 browser-agent harmful behaviors，包含 synthetic 与 real websites；公开页面未在本次核读中确认可直接再分发 license。 | 需要浏览器/网页环境，非本仓离线单测；只复用行为分类与评测维度，本轮不下载或重放攻击集；后续需 license/data review 与隔离授权。 |
| [OSWorld](https://github.com/xlang-ai/OSWorld) / [Apache-2.0](https://raw.githubusercontent.com/xlang-ai/OSWorld/main/LICENSE) | Real computer environment、桌面/网页/文件任务；官方仓库 Apache-2.0。 | 需要 VM/desktop backend；不进 Hosted CI/离线单测。可复用 environment boundary、fixture/结果 schema 设计，不启动 VM。 |
| [OS-Harm](https://github.com/tml-epfl/os-harm) / [Apache-2.0](https://raw.githubusercontent.com/tml-epfl/os-harm/main/LICENSE) | 基于 OSWorld 的 computer-use safety，含 deliberate misuse、prompt injection、model misbehavior；公开仓库含 harmful tasks/trace 说明。 | 需要 OSWorld GUI/VM，且官方要求安全处理/避免训练污染；本轮只复用三类风险和 judge/结果分层，不下载、不运行、不输出样本；后续适配需隔离授权。 |

这些来源只能帮助定义测试维度和分轨，不构成当前 Guard/Monitor 的效果证明。任何实际 benchmark 运行都需单独授权、凭证/VM/预算/数据保留政策与安全 review。

## 9. 共享测试矩阵、顺序与停止条件

| 层 | DEV-3 | DEV-4 | DEV-5 | DEV-6 |
| --- | --- | --- | --- | --- |
| 纯合同/fake | revision/epoch、Trace block reason、provider preparation | schema/migration、scope binding、replay idempotence | signature/comparator、candidate state machine | mandatory precedence、unknown/fallback、path/evidence |
| Mock provider | GLM native / Qwen native+strict golden | scope tool projection、current/history | 不调用模型的 guidance | assessor schema/timeout/budget/usage |
| Runtime integration | late response/old approval invalidation | invalidation event → Snapshot/Store/Context | unknown barrier/help/stop and no retry | FakeComputer execute=0 for deny/mandatory |
| fixture/effect | no GUI required | CUA/OSWorld only authorized fixtures | replay + optional fixture observation | actual side-effect block, separate from detector metrics |
| 交付指标 | trace completeness/selection correctness | applicability/reconciliation/retention, not success rate | FP/FN/cost/guidance outcomes | route merge, detector recall/FP, GUI block |

停止条件：新字段无 producer/consumer/persist/invalidate/cleanup，或测试只能读取摘要不走生产路径时停止；出现未知副作用、旧审批执行、跨 Run 记忆、mandatory 被降级、Monitor 重试 unknown 时不得放行。每阶段只提交小批次，纯移动与行为变化分开，Sol 审阅后再进入下一 commit。

## 10. 现实缺口与非目标

- 本计划不实现 OCR、通用页面语义真值、完美 prompt-injection detector、跨 Run Memory、任意应用 focus/AX、真实用户桌面或完整 benchmark 运行。
- 稳定/task/short-lived 不提供权限；scope 不提供真值；Trace/hash 不提供可分享原文；Monitor 不提供执行权；Risk reviewer 不提供最终否决权。
- 本计划本次只更新文档路线与合同；前序实现提交已改动 `packages/**`/`apps/**` 并通过当前离线验证。本次文字整理本身未调用 Provider/API、GUI、VM，未下载公开攻击数据，也未推送；本轮独立 synthetic Memory protocol probe 的 10 次 chat HTTP 已由专属报告记录。此前受控 Qwen embedding pilot 的 4 次 HTTP/64 tokens 与本轮 chat probe 均不等同于完整生产任务、真实桌面或 DEV-3/4/5 整体效果。

## 11. DEV-4 semantic retrieval independent checkpoint (2026-09-18)

详见独立施工计划：[DEV-4 Memory semantic retrieval plan](./dev-4-memory-retrieval-plan.md)。`9820851` 是 `packages/memory/src/retrieval/` 隔离模块的起点；`2e72f99`/`f22f96b`/`67542c7`/`6cd7ddb`/`61c6aff` 已完成 retrieval service 的公共 export、bounded `memory_search`、app configuration、Runtime mutation sync、Context 实际 ModelInput 接入及三项 integration review 回归。检索 focused 19/19，Memory focused 42/42；当前全仓为 36 files/393 tests、typecheck 通过。受控 pilot 仅合成数据真实 Qwen embedding 4 次 HTTP、usage 合计 64 tokens；后续 synthetic ORCHID 协议 probe 由 GLM/Qwen 各 2/2 完成，无 GUI action。未发送真实 Memory/截图/桌面数据；Hosted、真实桌面任务、语义质量总体证明及 DEV-4 整体完成仍未宣称。

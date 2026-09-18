# DEV-4 Memory retrieval 集成审查

日期：2026-09-18
文档角色：独立专项审查
审查基线：`eec591c..6da1caa`，并定点复核 `eec591c`
状态：有条件放行；1 项 P1、2 项 P2 需修复后再作为生产集成完成态

## 1. 结论

未发现 P0。`eec591c` 已关闭上一轮 Monitor 多调用继续执行和 entity omission 误分类问题；retrieval 的 gate-first、current/revalidation 分区、lexical/hybrid 隔离、Qwen response 校验、超时 fallback、取消传播和实际 Context 排序主线基本成立。

当前仍有一项生产生命周期 P1：app-runtime factory 把 `memoryMutationApplier` 传错对象，导致 Runtime-owned session-scope cleanup 不会物化到默认 MemoryStore，也不会同步 retrieval cache。另有两项 P2：长原始 goal 会静默截掉最新用户 correction，且 fact/source/entity exact identifier 仍错误依赖 key/value lexical overlap。

因此：

- `memory-retrieval=off`、lexical 离线服务、独立 Qwen adapter、mock retrieval 与 Context 排序代码可保留；
- hybrid 仍只能视为显式 opt-in preview；修复下述三项并补 factory/查询反例后，才可放行本批生产 wiring；
- 真实 4-request synthetic pilot 仅证明 adapter/service/ranker 小样本链路，不证明生产 CLI/Context 端到端效果、总体检索质量或真实用户数据隐私。

## 2. Findings

### P1 — factory 未把 lifecycle Memory 物化器传给 RunController

位置：

- `packages/app-runtime/src/run-factory.ts:47-73`
- `packages/app-runtime/src/run-factory.ts:102-109`
- `packages/app-runtime/src/run-factory.ts:126-146`
- 消费位置：`packages/runtime/src/run-controller.ts:1670-1692`

factory 正确创建了 `memoryMutationApplier`：Store apply 后调用 retrieval `syncState(next)`。但组装时它被通过 object spread 传给 `new DefaultContextCompiler(...)`；Compiler options 不消费该字段。`new RunController({...})` 反而没有收到 `memoryMutationApplier`。

这不会被当前 TypeScript 构建发现，因为未知字段藏在条件 spread 中；独立 `@computer-harness/app-runtime` build 仍会通过。实际后果是普通模型 Memory 工具写入仍由 `afterMemoryCommit` 正常物化，但 Runtime-owned `source="lifecycle"` session scope cleanup 只更新 trajectory/Snapshot：默认 FileMemoryStore 中的事实仍可能保持 active，retrieval derived cache 也没有收到 lifecycle revision。该行为重新打开了上一轮已经修复的“事件权威与 Store/cache 分叉”边界。

最小修复：从 `DefaultContextCompiler` options 删除该 spread，并把同一个 applier 注入 `RunController` dependencies。补 app-runtime factory 生产路径测试，不只测裸 Controller：Memory enabled → 写入 session-scoped fact → Run finish → 注入 Store 中为 `needs_check/scope_ended`，retrieval service 收到新 state/revision；Store apply 失败时仍按既有合同记录 `memory_materialization_failed` 并把成功 outcome 降级。

### P2 — bounded query 会让长原始 goal 吞掉最新权威 correction，诊断却声称 correction 已使用

位置：`packages/memory/src/retrieval/hybrid-recall.ts:372-389`。

`buildQueryParts()` 先拼接 `explicitQuery, originalGoal, corrections, actionHints`，最后对整串做 `slice(0, maxQueryCharacters)`。自动 Context recall 没有 explicit query，但只要原始 goal 达到 512 字符，后面的真实 `user.input.received` correction 就完全不会进入 lexical/embedding query；`querySources.correctionCount` 仍报告该 correction，造成诊断与实际发送文本不一致。

独立只读复现：512 字符原始 goal + correction=`needle`，canonical Memory 中唯一匹配 `needle` 的 fact 未被 lexical recall，结果为空，但 diagnostics 仍为 `correctionCount=1`。主 Context 历史仍保留 correction，所以这不是授权绕过；它会使已纠正任务继续按旧目标召回 Memory，属于检索正确性阻塞。

最小修复：给权威来源分配独立有界额度，或按“最新 correction → original goal → 低信任 action hint”保护 correction，不允许末尾统一截断静默删除；diagnostics 应只统计实际进入 query 的来源。补 Plan off、超长 goal、多条最新 correction 的生产 Compiler → service 测试，并断言 ToolResult 不进入 query。

### P2 — fact/source/entity exact identifier 只有同时命中 key/value lexical token 才生效

位置：`packages/memory/src/retrieval/hybrid-recall.ts:117-125`、`438-464`。

循环先计算只覆盖 `fact.key + fact.value` 的 `lexicalScore()`；若 score 为 0 会立即 `continue`，之后才调用 `hasExactIdentifier()`。因此文档声明支持的 `fact.id`、`sourceEventId`、entity id 查询，如果文本没有同时出现在 key/value 中，就不会进入 exact set。无 embedding 的默认 lexical 模式直接返回空；hybrid 的 document text 也不含 fact/source ID，不能可靠补救。

独立只读复现：查询精确 `fact-special` 或 `source-special`，对应事实 key/value 均为 unrelated，两个查询都返回空。

最小修复：先独立计算 exact identifier；exact 命中不依赖 lexical overlap，并在 candidate/topK 前获得稳定优先级。建议使用 token/边界相等而非任意 substring，避免 `m1` 错配 `m10`。补 fact id、source event id、entity id 与相似前缀反例。

## 3. `eec591c` 定点结果

- Multi-call Monitor help：`flushDeferredMonitorHelp()` 后若进入 `waiting_user`，现在保存 `pendingToolTurn.nextIndex` 并立即返回；用户 correction 后剩余 call 被明确 rejected，不再继续执行 GUI。聚焦回归覆盖 Planning-before-GUI 合法多调用 turn。
- Memory Trace entity omission：`rememberOmitted()` 现在只有同时存在 fact `id + class` 才写入 fact omission；entity-only tiny budget 回归确认 entity ID 不再伪装成 admitted fact。

这两项可关闭，不再作为当前阻塞。

## 4. 已核对通过的 retrieval 边界

- 自动 recall query 只从 original goal 与真实 `user.input.received` 取 correction；不会把 ToolResult 当成用户输入，Plan off 仍工作。第 2 节 P2 仅涉及 bounded 拼接优先级。
- run/session/status/entity gate 在 document embedding 与 topK 之前完成；superseded、scope mismatch、stale/missing entity 的值不会发给 embedding provider。needs-check 与 short-lived 只进入 revalidation 分区。
- retrieval 只返回排序 ID/score/match 给 Context bridge；Context 用同一 canonical MemoryState 重新 join，并按 retrieval 顺序形成实际 hot/index/revalidation ModelInput。Memory soft quota另行记录 rendered/omitted，排名 metadata 不提升事实真值或授权。
- `memory=off`/retrieval off 不创建 service、不注册 `memory_search`；lexical 模式 provider 为 undefined，不发网络；hybrid 需要显式独立 HTTPS endpoint 与 `MEMORY_EMBEDDING_API_KEY`，不复用 chat key。Run summary 当前不写 endpoint/key。
- Qwen adapter 校验 batch count、乱序 index、duplicate/missing index、维度、非有限 component 与 zero vector；外部 abort 向上传播，未被 lexical fallback 吞掉。timeout/provider read failure保留 lexical/exact fallback且不自动 retry。
- vector cache 按 RunIndex、provider/model/dimensions 和 fact revision 分隔；普通 Memory tool mutation会 apply Store 后 `syncState`。P1 修复前 Runtime lifecycle mutation 是唯一已确认的生产缺口。
- 没有动作数、事件数、时间或 frame TTL；retrieval score 只决定相关性排序，不改变 lifecycle/status/scope。
- `createContextMemoryRecall()` 是 app-runtime 内的薄 assembly bridge，把具体 `HybridMemoryRecallService` 映射到 Runtime 的 metadata-only `MemoryRecallService` 合同；Runtime 没有反向依赖 Memory 包或 Qwen adapter。

## 5. 验证

独立执行：

```text
pnpm --filter @computer-harness/app-runtime build
pnpm --filter @computer-harness/memory build
pnpm exec vitest run \
  packages/memory/src/retrieval/index.test.ts \
  packages/memory/src/index.test.ts \
  packages/memory/src/runtime-regression.test.ts \
  packages/context/src/index.test.ts \
  packages/context/src/memory-projection.test.ts \
  packages/app-runtime/src/run-factory.test.ts \
  packages/runtime/src/index.test.ts \
  packages/trajectory/src/index.test.ts
```

结果：两个 package build 通过；8 files / 173 tests 全部通过。

另做三个无网络只读反例：caller abort 正确抛出 `caller-cancel`；长 goal 会漏掉 correction；fact/source exact identifier 会返回空。后两项说明全绿测试尚未覆盖本报告的 P2。

实施者报告的全量 36 files / 389 tests、typecheck、CLI help、offline frozen install 与 diff-check 未在本审查重复执行；它们是作者证据，不是本轮独立全量。

## 6. 放行边界

修复 P1 前不得把 scope lifecycle + retrieval cache 称为生产闭环。修复两项 P2 前，不得把 bounded correction query 与 exact identifier 合同称为完成。修复后只需定点复核 factory lifecycle、query composition 和 identifier tests，不需要重新扩大到桌面、真实模型质量或跨 Run Memory。

明确未放行：语义检索总体效果、真实用户 Memory、Hosted CI、跨 Run Memory、target generation、视觉真值、真实 Monitor 效果和完整 DEV-4/5 验收。

本轮未调用任何 API、桌面或 VM；只新增审查文档与原审查入口引用，没有修改业务代码，也没有 commit/push。

## 7. 三项 finding 修后定点复核

复核范围只包含本报告第 2 节三项问题；并行新增的真实 API fixture/script 不在本次范围。

### 复核结论

三项均已关闭，未发现新的 P0/P1/P2。当前 Memory retrieval 生产 wiring 可按“离线功能闭环、hybrid 显式 opt-in preview”范围放行。

1. **Factory lifecycle applier 已闭合。** `memoryMutationApplier` 已从无效的 `DefaultContextCompiler` options 移除并注入 `RunController`。新增 app-runtime 生产组装测试实际经过 `createRun`：成功路径确认 session fact 在 Store 中变为 `needs_check/scope_ended`，lifecycle event 无伪 ToolCall ID，retrieval `syncState` 看见 scope-ended revision；失败路径确认 Store 拒绝 lifecycle apply 时 Run outcome 降为 failed、记录 `memory_materialization_failed`，Store 不被假称已更新。
2. **权威 correction 预算已闭合。** query builder 先为 explicit query 与最新 correction 预留空间，再填 original goal、较旧 corrections 和低信任 action hints；新增 `included*` 计数与 `queryCharacterCount` 只报告实际进入 bounded query 的来源。长 goal 反例现能同时召回 explicit 与 latest-correction facts，且不超过字符上限。自动 Context 当前没有 explicit query，因此最新真实 correction 不再被原始 goal 挤掉；ToolResult 仍不参与 query。
3. **Exact identifier 已闭合。** exact 检查现在独立于 key/value lexical score；ASCII identifier 使用 lexical token equality，不再用 substring。精确 fact ID 可在 key/value 完全无重叠时召回，近似前缀不会误命中。同一 helper 同时覆盖 sourceEventId 与 entity id，gate/topK/分区顺序未改变。

### 独立验证

```text
pnpm exec vitest run \
  packages/app-runtime/src/run-factory.test.ts \
  packages/memory/src/retrieval/index.test.ts
```

结果：2 files / 29 tests 全部通过。未重复全量测试、真实 API、桌面或 VM；实施者此前的全量与 API fixture 证据不计入本次独立验证。

### 最终放行边界

- 放行：off 零 retrieval、默认 lexical 无网络、显式 hybrid 组装、Memory 工具/Context 共用 retrieval service、scope/status/entity gate-first、current/revalidation 分区、排序进入实际 ModelInput、Store/cache revision 同步、timeout/cancel fallback、Qwen response shape 校验和安全 Trace。
- 仍属 preview/未验收：真实用户 Memory、semantic quality/阈值、Hosted CI、跨 Run Memory、target generation、视觉真值、完整 DEV-4/5 和真实 Monitor 效果。
- 4-request / 64-token synthetic pilot 仍只证明受控 adapter/service/ranker 小样本链路；本复核没有扩大其证据含义。

本次只更新审查报告，没有修改业务代码、commit/push，也没有调用 API 或操作桌面。

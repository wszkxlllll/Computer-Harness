# DEV-3 / DEV-4 / DEV-5 foundation 集中审查

日期：2026-09-18
文档角色：独立审查结果
状态：DEV-3 有条件放行，需先修两项 P2；DEV-4 纯拆分与 DEV-5 离线 foundation 可按限定范围放行

## 1. 结论

本轮没有发现 P0/P1，也没有发现会让已取消请求继续发网、让旧 correction/pause 决策执行、让 Monitor 获得 GUI authority，或破坏 Memory 既有公共导出的阻塞问题。

当前未提交 DEV-3 行为增量有两项 P2 诊断正确性问题，应在建立行为 commit 前修复：

1. 安全 provider summary 会把 GLM 响应中的同形扩展误报成已验证的 Qwen cache read；
2. ContextTrace 的 `selectedEventIds` / `discardedEvents` 混合“进入历史选择器”和“实际进入模型投影”两层语义，可能把从不进入 ModelMessage 的事件标成已选择或因预算/历史上限而舍弃。

分范围结论：

- DEV-3 prepared request、重试关联、取消前零网络、pause/correction barrier、Memory 软配额与 trajectory 兼容路径可保留；修复第 2 节两项后再提交本批行为。
- DEV-4 `51a7128` 是保行为 RFT-5 纯拆分，既有公共入口仍由 `index.ts` 重导出；随后行为批次已由本地 `01a6d47` 实现 Fact scope/recall gate、revalidation 与 Runtime session lifecycle。该批次仍需独立 Sol 审查；target/generation、跨 Run 策略、独立 verification 与自动 retention 仍未验收。
- DEV-5 `5317b29` / `6c0662a` 只放行离线、只读、候选级 foundation。它按 Run 首事件绑定并在跨 Run 时 reset，状态有界，proposal 与 completed receipt 分开，输出没有 retry/stop/guidance/approval/execute 字段。本结论不覆盖 online consumer、视觉 feature、guidance/help/stop 或效果评测。

## 2. Findings

### P2 — provider summary 未按 Provider 限定 cache usage 语义

位置：

- `packages/app-runtime/src/diagnostics/provider-summary.ts:255-279`
- `packages/app-runtime/src/diagnostics/recording-clients.ts:20-36`
- `packages/app-runtime/src/diagnostics/recording-clients.ts:68-85`
- 对照：`packages/provider-qwen/src/index.ts:536-551`

`summarizeProviderUsage()` 只看响应 shape，只要发现 `usage.prompt_tokens_details.cached_tokens` 的合法整数就输出 `cachedReadTokens`。GLM 与 Qwen recording client 都调用同一个无 Provider 参数的 summary，因此 GLM 若返回同形、但尚未由本项目验证其语义的扩展，安全诊断仍会把它记成 cache read。与此同时，GLM Adapter 正确地不把该字段写入 canonical `ModelUsage`，实施记录也明确声称“GLM 未验证的同名扩展不产生该字段”。这会造成 canonical trajectory 与 provider diagnostic 对同一响应给出矛盾解释。

最小修复：让 usage summary 接收明确 Provider/capability 选项，只在 Qwen recording path 解析该字段；GLM path 将 `prompt_tokens_details` 视为未解释/省略字段。补两条 recording-client 回归：同形 GLM 响应不得产生 cache read，Qwen 合法响应仍保留；缺失和非法值继续保持 unknown，而不是补零。

### P2 — ContextTrace 没有区分历史选择与实际模型投影

位置：

- `packages/context/src/compiler.ts:197-225`
- `packages/context/src/history.ts:3-19`
- `packages/context/src/index.test.ts` 的 safe trace 回归

`selectHistoryEvents()` 的输入是全部 Runtime events；raw 模式会原样返回，recent 模式则只保留部分 event type。随后 Trace 直接把选择器结果写入 `selectedEventIds`，把不在 recent 候选中的所有事件写成 `history_limit`，并以全部 ordered events 计算 `omittedHistoryEvents`。但 Compiler 实际只把 response、tool result/rejection 和 user input 变成 ModelMessage；例如 `run.started` 从不进入消息，现有测试却要求它以 `history_limit` 被舍弃，而 raw 模式中的 `model.request.started` 会被列为 selected、预算成本为 0、也不会进入 Provider payload。

这不扩大模型输入，也不破坏当前预算上限，但会让审计消费者误把“选择器看过的事件”理解成“实际投影给模型的事件”，从而得到错误的裁剪原因和保留集合。

最小修复可二选一：

1. 在进入 history selection 前先形成明确的 Context-consumed/projectable event 集，并单独处理 observation；或
2. 保留现有选择层字段，但改名/补字段，明确区分 `considered/selected` 与 `projectedMessageEventIds`，并为非投影事件使用 `not_projected`，不得标成 `history_limit`/`input_budget`。

至少补 raw 与 recent 两组回归，断言 `run.started`、`model.request.started`、Trace metadata 不会被声称为 Provider 可见历史，同时 response-call-result 完整组和权威 user input 仍保持现有保护。

## 3. 已核对且可保留的实现

- GLM/Qwen prepared metadata 为冻结对象，真实 body 和解析用 input snapshot 留在 adapter 私有 WeakMap；伪造或跨 adapter token 被拒绝。
- `generatePrepared` 在调用 HTTP client 前检查 abort；独立回归确认准备后取消时 post 次数不增加。
- Runtime 在 compile、prepare、feedback re-prepare 后经过 Inbox barrier；pause/correction 会丢弃当前 prepared decision。same-input retry 复用同一对象，feedback retry 重新 prepare。
- 每个真实 attempt 有独立 `requestId`，同一逻辑 decision 共用 `decisionId`，attempt 从 1 开始；started/failed/response 可关联。新增 trajectory 字段均为 optional，旧事件仍可解析。
- Context 历史预算按 response/call/result/action 组淘汰，权威 `user.input.received` 超预算时失败而非静默删除；Memory 投影有独立软上限，Trace/请求诊断事件不计入模型历史 token 估算。
- Qwen canonical `ModelUsage.cacheReadTokens` 只在 Provider 返回非负整数时存在；缺失/非法不补零。Run snapshot 不制造不完整 cache 总量。
- Monitor 签名包含规范化参数值，同长度不同 text/key 不相等；分区变化不直接产生停滞，缺视觉 feature 只给 unknown evidence。Monitor 当前没有 online Runtime consumer，因此不会修改调度、审批或 GUI 执行。

## 4. 验证证据

独立执行：

```text
pnpm exec vitest run \
  packages/context/src/index.test.ts \
  packages/runtime/src/index.test.ts \
  packages/runtime/src/progress-monitor.test.ts \
  packages/provider-glm/src/index.test.ts \
  packages/provider-qwen/src/index.test.ts \
  packages/trajectory/src/index.test.ts \
  packages/app-runtime/src/diagnostics/provider-summary.test.ts \
  packages/memory/src/index.test.ts \
  packages/memory/src/runtime-regression.test.ts
```

结果：9 个测试文件、186 项测试全部通过。

集成 worker 的独立记录 `docs/dev-3-integration-validation.md` 报告当前共享工作树 `pnpm run typecheck`、33 files / 344 tests、direct CLI help 与 `git diff --check` 均通过。该全量结果是 worker 证据，本审查未重复执行全量。

## 5. 明确未放行范围

- 完整 `InstructionState` / revision 与最终 Provider budget enforcement；
- Memory 的 Sol 最终审查、跨 Run 策略、target/generation producer、独立 verification 与自动 retention；
- Monitor online consumer、visual feature、guidance/help/stop、阈值有效性与误报/漏报；
- 真实 Provider cache 命中、TTL、跨 Run cache 或 tokenizer 精确度；
- 真实模型 API、桌面、窗口、VM 与 Hosted CI。

本轮只写本审查文档，没有修改业务代码，没有调用模型 API，也没有操作桌面或 VM。

## 6. 协调复核：P2 修订交接

2026-09-18，实施提交 `dee64fb` 修正上述两项 P2。协调者只读核对：缓存摘要通过受信模型标识限定 Qwen，GLM/Qwen recording 测试分别断言字段不存在/存在；ContextTrace 增加 `projectedEventIds`，与历史选择事件分列。实施者报告修订后定向 5 个文件、66 项测试和 typecheck 通过。本节不是第二轮 Sol 审查，也不把此前 344 项全量结果写成修订后重跑。

本批可交接后续开发，完整 DEV-3 尚未完成；第 5 节未放行范围保持不变。DEV-4 生命周期及 DEV-5 在线集成需要各自测试和审查。

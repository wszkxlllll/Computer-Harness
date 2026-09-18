# DEV-4 Memory model API validation

日期：2026-09-18
状态：已完成有界真实协议探针；未形成完整 Provider→Memory→回答/finish 绿证据。
范围：仅合成 Memory、Planning off、lexical retrieval、无真实桌面/VM/截图/用户数据；没有自动重试。
## 1. 实际验证链路

本次脚本 `scripts/real-memory-model-api-validation.mjs` 使用生产组装路径的关键层：

`DefaultContextCompiler → Runtime ToolRegistry → InMemoryMemoryStore → RunController → GLM/Qwen adapter`

探针以 `memory_write_fact` 写入两个合成事实：

- `current_task_fact=ADMITTED_SYNTHETIC_FACT`，`stable`，run scope；
- `old_task_fact=RECHECK_ONLY_OLD_FACT`，`short_lived`，作为待复核候选。

目标明确关闭 Planning，先要求模型调用 `memory_search("task fact")`，再只依据 admitted 事实回答并结束；没有 Computer action。所有输出只保存脱敏请求形状、工具名、usage、错误码和轨迹元数据，不保存 key、原始 Provider body 或私密路径。

## 2. 请求账本与结果

每个 chat provider 的总上限为 3 次 HTTP；脚本把模型协议错误标成不可重试，避免 Runtime 自动重试扩大额度。

| 链路 | HTTP | 结果 |
| --- | ---: | --- |
| 历史 Qwen `text-embedding-v4` pilot | 4 | 0 失败/重试，usage 合计 64 tokens；不是本次 chat 集成证据 |
| GLM `glm-5.3-flash` | 3/3 | 第 1 次因旧合成图像得到 HTTP 400/1210；修正尺寸后两次实际完成 `memory_search`、`memory_get`，但预算耗尽前没有最终 finish |
| Qwen `qwen3.8-flash` | 3/3 | 第 1 次旧图像格式 HTTP 400；第 2 次 1×1 图像被拒绝（最小边需大于 10）；第 3 次使用 Node/zlib 验证的 16×16 PNG，真实调用 `memory_search`，但没有最终 finish |

GLM 两次成功响应 usage 分别为 1,642 和 3,618 tokens（第二次含 1,536 cached tokens）；Qwen 最后一次 usage 为 prompt 1,311、completion 65、total 1,376，其中 image tokens 66。两 provider 合计 chat HTTP 6 次，未发生自动重试或 GUI action。

GLM 的 `memory_get` 返回了 admitted 的 `current_task_fact`，证明真实 provider 响应可以进入生产 Memory tool 执行路径；但其前一步 `memory_search("task fact")` 的 lexical 命中为 0，不能宣称已证明搜索结果正确区分 admitted/revalidation。Qwen 的同一 lexical 查询也返回 admitted/revalidation 均为空，随后因本 provider 预算耗尽而结束为 failed。因而本探针是客观的部分通过/部分失败记录，不是完整模型质量或端到端回答验收。

## 3. 本批修复与离线证据

- `app-runtime` 将 `memoryMutationApplier` 从 `DefaultContextCompiler` 的未消费 options 移到 `RunController`，并增加 factory 真实组装回归：session-scope fact 在 Run 结束时物化为 `needs_check/scope_ended`，retrieval `syncState` 收到该状态；注入 Store 失败时 outcome 降为 `failed` 并记录 materialization error。
- Memory bounded query 保护显式 query 与最新 correction，diagnostics 同时报告输入来源和实际进入 query 的来源；长 goal 不再吞掉 correction。
- fact/source/entity identifier 使用 token 边界 exact 匹配，不再先被 lexical score=0 过滤，也不把短 ID 当作更长 ID 的 substring。

实际离线验证：

```text
pnpm exec vitest run packages/app-runtime/src/run-factory.test.ts packages/memory/src/retrieval/index.test.ts
29 tests passed (10 app-runtime + 19 retrieval)
pnpm run typecheck
exit 0
node --check scripts/real-memory-model-api-validation.mjs
pass
```

合成 PNG 在发出最后 Qwen 请求前由 Node 内置 zlib 解压检查：PNG signature 正确，IHDR/IDAT/IEND 完整，16×16、75 bytes；本机没有安装 `sharp`，没有把缺失的第三方解码器冒充成功。

## 4. 边界与后续

本批没有证明：完整 search→get/回答→finish、语义 embedding 质量、真实用户 Memory、跨 Run 继承、真实截图/桌面、Provider 重试策略或 Hosted CI。剩余 API 预算为零，不能通过再次请求补写成功结论。`ignoredruns/` 下的原始探针结果仅作本地审计留痕，不应暂存或提交；提交内容不包含 `.env`、原始请求 body、截图或凭据。

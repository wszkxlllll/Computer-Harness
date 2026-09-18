# DEV-4 Memory model API validation

日期：2026-09-18
状态：窄范围真实协议探针通过；不等于完整 DEV-4 或真实桌面验收。
范围：仅合成 Memory、Planning off、lexical retrieval、无真实桌面/VM/截图/用户数据；没有自动重试。
## 1. 实际验证链路

本次脚本 `scripts/real-memory-model-api-validation.mjs` 使用生产组装路径的关键层：

`DefaultContextCompiler → Runtime ToolRegistry → InMemoryMemoryStore → RunController → GLM/Qwen adapter`

探针以 `memory_write_fact` 写入两个合成事实：

- `current_task_fact=ADMITTED_SYNTHETIC_FACT ORCHID`，`stable`，run scope；
- `old_task_fact=RECHECK_ONLY_OLD_FACT ORCHID`，`short_lived`，作为待复核候选。

目标明确关闭 Planning，先要求模型调用 `memory_search("ORCHID")`，再只依据 admitted 事实调用 `terminate`；没有 Computer action。所有输出只保存脱敏请求形状、工具名、usage、错误码和轨迹元数据，不保存 key、原始 Provider body 或私密路径。

## 2. 请求账本与结果

首轮每个 chat provider 上限为 3 次 HTTP；修正 fixture 后的第二轮独立上限为每 provider 2 次。脚本把模型协议错误标成不可重试，避免 Runtime 自动重试扩大额度。

| 链路 | HTTP | 结果 |
| --- | ---: | --- |
| 历史 Qwen `text-embedding-v4` pilot | 4 | 0 失败/重试，usage 合计 64 tokens；不是本次 chat 集成证据 |
| GLM `glm-5.3-flash` | 首轮 3 + 第二轮 2 | 首轮第 1 次因旧合成图像得到 HTTP 400/1210，后两次完成 search/get 但无 finish；第二轮 2 次完成 `memory_search`→admitted/revalidation 分区→仅 admitted 的 `terminate` |
| Qwen `qwen3.8-flash` | 首轮 3 + 第二轮 2 | 首轮依次遇到旧图像格式、1×1 尺寸限制和无 finish；第二轮 2 次完成同一 search→admitted/revalidation→terminate 路径 |

首轮 GLM 两次成功响应 usage 为 1,642 和 3,618 tokens（第二次含 1,536 cached tokens）；首轮 Qwen 最后一次响应为 prompt 1,311、completion 65、total 1,376，其中 image tokens 66，但未完成。第二轮 GLM 两次 usage 为 2,102 和 2,869 tokens（第二次含 1,152 cached tokens）；Qwen 两次为 1,540 和 2,140 tokens（分别含 256/1,024 cached tokens，均含 66 image tokens）。两轮 chat 合计 HTTP 10 次，未发生自动重试或 GUI action。

首轮的 `task fact` fixture 与词法分词边界不匹配，导致 search 为空；这不是扩大产品 tokenizer 的理由。第二轮先离线确认 `ORCHID` 同时返回 1 个 admitted 和 1 个 revalidation，再由两个真实 provider 各用两次 HTTP 完成 search 与 terminate：GLM 的最终摘要只复述 admitted 值并明确不把旧值当 current，Qwen 的最终摘要也只包含 admitted 值。该结果证明窄范围真实 provider→Memory tool→分区消费→finish 链路；不证明语义检索、长任务质量或真实用户数据。

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
offline lexical fixture check: `ORCHID` → 1 admitted + 1 revalidation
second real round: GLM 2/2 and Qwen 2/2 succeeded; no GUI action
```

合成 PNG 在发出最后 Qwen 请求前由 Node 内置 zlib 解压检查：PNG signature 正确，IHDR/IDAT/IEND 完整，16×16、75 bytes；本机没有安装 `sharp`，没有把缺失的第三方解码器冒充成功。

## 4. 边界与后续

本批仍没有证明：语义 embedding 质量、真实用户 Memory、跨 Run 继承、真实截图/桌面、Provider 重试策略或 Hosted CI；成功只覆盖 Planning off、lexical、两个合成事实和两轮有界 tool protocol。累计 API 预算已用尽，不能通过再次请求扩写结论。`runs/dev4-memory-model-api-validation*` 下的原始探针结果仅作本地审计留痕，目录由 `.gitignore` 忽略，不应暂存或提交；提交内容不包含 `.env`、原始请求 body、截图或凭据。

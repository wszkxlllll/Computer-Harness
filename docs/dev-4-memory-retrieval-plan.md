# DEV-4 Memory semantic retrieval plan

日期：2026-09-18

状态：检索基础模块及离线生产接入已实现；本文件不替代 [DEV-3/4/5 共享施工入口](./dev-3-5-implementation-plan.md)，也不声明 DEV-4 整体完成。当前接入已覆盖 `memory_search`、Context 自动召回和实际 ModelInput 排序；未宣称 Hosted CI 或集成后的真实生产模型运行已完成。

## 1. 当前事实

当前源码已有 bounded `memory_search(query)`、显式注入的 embedding provider 和进程内 revision-keyed semantic cache。`memory_get` 仍按事实 `id/key` 读取；Context 自动召回通过同一个 `HybridMemoryRecallService` 取得有界排序，再把实际排序传入 ModelInput。现有 GLM/Qwen chat adapter 不负责 Memory embedding；embedding 使用独立 provider/endpoint/key 配置。

本批新增并已接入公共 exports/生产消费路径的文件：

- `packages/memory/src/retrieval/types.ts`：`CurrentRecallQuery`、provider-neutral embedding contract、bounded result/diagnostic 类型。
- `packages/memory/src/retrieval/qwen-embedding.ts`：显式 endpoint/API key 注入的 Qwen `text-embedding-v4` HTTP adapter；不读取环境变量、不复用 chat endpoint。
- `packages/memory/src/retrieval/hybrid-recall.ts`：gate-first exact identifier + dense cosine retrieval、admitted/revalidation 分区、bounded in-memory revision cache、迟到结果屏障和 deadline fallback。
- `packages/memory/src/retrieval/index.test.ts`：17 个 mock/adapter/service focused tests；没有在测试中使用真实凭证、模型或截图。

集成后离线验证已通过：retrieval focused 17/17；Memory focused 42/42；Context/trajectory/app-runtime focused 通过；全仓 `pnpm test` 为 36 files / 389 tests，`pnpm run typecheck` 退出码 0。上述是当前工作树证据，不等同于 Hosted CI 或集成后的真实生产 embedding run。

## 2. 查询合同

`CurrentRecallQuery` 的来源分层如下：

| 来源 | 用途 | 信任边界 |
| --- | --- | --- |
| 原始 goal | 基础检索语义 | 用户任务约束；不能被模型查询删除 |
| 最近真实 user correction | 纠正检索方向 | 权威输入；按有界数量保留 |
| 模型显式 query | 检索细化 | 只能改变召回相关性，不能改 run/session/status gate |
| 最近 action hint | 低信任辅助 | 只作弱提示，不使用 OCR，不把 action 自报当事实 |
| Plan | 可选排序辅助 | Plan 缺失时检索仍必须工作，Memory 不依赖 Planning |

首批不会引入独立 LLM query-generation，也不会从截图 OCR 产生查询。`memory_search(query)` 工具和自动 Context recall 已调用同一个 `HybridMemoryRecallService`，避免两个 applicability 规则；自动 Context 只从原始 goal 与最近真实 user correction 组装查询，不从 tool result 伪造 user input。显式 model query（若未来由调用方提供）只改变召回相关性，不能改变授权、scope、session 或 status gate。

## 3. Gate-first hybrid 设计

检索顺序固定为：

1. 依据 `runId`、computer session scope、fact status 和 entity status 过滤候选；superseded、scope mismatch、stale/missing entity 在 embedding/topK 前排除，不外发给远程 provider。
2. 对 fact key/id/source event/entity id 做 exact identifier 匹配，并对 key/value 做有界 Unicode lexical token overlap。两条路径都标记为 lexical，不把 hash、ngram 或 BM25 称为 semantic。
3. 对剩余有界候选调用真正的 dense embedding cosine；分数只用于相关性排序，不代表事实真值、验证等级或动作授权。
4. `admittedFacts` 与 `revalidationCandidates` 分开输出；`needs_check`、`short_lived` 不进入正常 current/hot 事实，也不与 admitted 重复。

MemoryState 仍是唯一事实来源。向量是进程内派生缓存，key 至少包含 run/fact revision/provider/model/dimensions；重启可从 canonical MemoryState 重建，不增加第二个事件 writer。

## 4. 更新与迟到结果

canonical Memory mutation 提交后，调用方应立即 `syncState`：

- changed value、scope、status 或 supersede 会删除旧 revision vector；needs-check 不能继续作为 admitted candidate；
- embedding 请求携带 `runId + factId + factRevision`；完成时重新核对当前 revision，迟到结果直接丢弃；
- deadline/abort 后，即使非合作 provider 后续 resolve，也不能写入 cache；
- 同一查询按 run/session/provider/model/dimensions/query digest 缓存，避免每轮重复网络；不自动 retry、不自动切换厂商；
- provider 不可用时保留 exact identifier 结果，输出 `semantic_unavailable`/`timed_out`，不假称 semantic 命中。

## 5. Provider 选择与成本边界

首个真实 adapter 选择 Qwen `text-embedding-v4`，原因是 Node `fetch` 即可接入、官方文档提供 OpenAI-compatible `/embeddings` endpoint、中文及 100+ 语言支持、可选维度和北京区域价格/免费额度。官方文档列出 v4 单条最多 8192 tokens、批量最多 10 条、默认 1024 维、CNY 0.0005/千输入 tokens及 90 天 100 万 tokens 免费额度；免费额度与区域/账户绑定，不能当作项目保证。[Qwen embedding 官方文档](https://help.aliyun.com/en/model-studio/text-embedding-synchronous-api)

GLM Embedding-3 是 provider-neutral 接口的后续可选实现：官方 endpoint 为 `/api/paas/v4/embeddings`，支持 256–2048 维、单条 3072 tokens、每批最多 64 条，价格 0.5 元/百万 tokens；当前官方模型页没有 embedding 专属免费额度说明。[GLM Embedding-3 官方文档](https://zhipu-ef7018ed.mintlify.app/cn/guide/models/embedding/embedding-3)

远程 embedding 默认关闭。Memory value 可能含路径或其他用户内容，因此首次真实 pilot 只能使用 synthetic 中英文事实，且必须由 root 先宣布授权；建议最多 6 次 embedding HTTP 请求、总输入不超过 10K tokens，不做自动重试。

隐私硬约束场景可后续评估本地 `intfloat/multilingual-e5-small` + `onnxruntime-node`：模型卡标注 MIT、384 维、多语种，并要求 query/passage 前缀；ONNX Runtime Node 提供 Windows/Linux/macOS CPU 预构建包，但模型权重、tokenizer、Node24 实机兼容和内存占用仍需单独批准与验证。本批不下载、不增加该依赖。[E5 模型卡](https://huggingface.co/intfloat/multilingual-e5-small) 、[ONNX Runtime Node.js](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)

## 6. 集成状态与后续顺序

1. 已完成：接入共同 `MemoryState` applicability helper；不复制第二套 gate（`f22f96b`、`67542c7`）。
2. 已完成：增加 bounded `memory_search(query)` consumer，并把自动 Context recall 接到同一 service；`memory=off`/retrieval `off` 不创建 retrieval service、不发 embedding 请求、不注入 retrieval prompt（`f22f96b`、`6cd7ddb`）。
3. 已完成：app-runtime 通过显式 provider 注入配置；Qwen/GLM chat adapter 不知道 Memory，Memory 也不绑定 Planning。`hybrid` 必须同时显式配置独立 endpoint 与 `MEMORY_EMBEDDING_API_KEY`，不会隐式复用 chat 凭证。
4. 已完成：检索排序实际进入 Context ModelInput，并与 index/hot/recheck 的 admission 分区共同使用有界 projection；safe trace 只记录 method/status/计数/稳定 ID，不记录 query/value/vector。Context 集成提交为 `6cd7ddb`。
5. 后续：Hosted CI、集成后真实生产 embedding run、以及更大规模语义质量评估仍未完成；不把本地离线测试或受控 pilot 当作这些验收的替代。

## 7. 必测矩阵

- `plan` 缺失时，goal + user correction 仍能召回 synthetic semantic paraphrase；Plan 存在时不能成为必要条件。
- exact identifier 在 provider disabled/unavailable 时仍可用；真正 dense paraphrase 才标 `semantic`。
- 跨 run/session、superseded、stale/missing entity 在 topK 前排除；needs-check/short-lived 只进 revalidation。
- 写入/替换/显式失效后旧 vector 立即不可用；迟到 provider response、timeout、abort 都不能污染新 cache。
- Qwen response 的 batch 数量、乱序 index、重复/缺失 index、维度、非有限值、零向量均拒绝；每批不超过 10 条。
- provider/model/dimension/query revision 改变时缓存隔离；诊断只记录计数、状态、错误码和安全 ID，不记录原 query、原文或向量。
- 每 Run 的 embedding request budget、canonical state revision 变化和 timeout/abort 都可在 safe trace 中观察；状态变化中的 recall 不返回旧 snapshot 的事实。

本批已完成独立模块、bounded tool/Context/Runtime 离线接入和 mock evidence；Hosted CI、桌面验证、以及集成后真实生产 API 运行仍未完成。`memoryRetrieval=off` 与 `memory=off` 的零 retrieval-call 行为有回归测试；默认启用 Memory 时 retrieval mode 为 lexical（无网络），hybrid 只能显式 opt-in。

## 8. 真实 synthetic pilot checkpoint

root 已宣布受控 pilot 后，使用 [Qwen synthetic pilot script](../scripts/dev4-memory-retrieval-qwen-pilot.mjs) 完成 4 次真实 embedding HTTP attempts（0 failure、0 retry、197 input characters、provider usage 5/46/9/4 tokens）。结果与安全边界见 [pilot results](./dev-4-memory-retrieval-qwen-pilot-results.md)。该 pilot 在集成前直接调用 adapter/service/ranker，未验证生产 CLI/Context/Runtime wiring；随后离线接入已由 `f22f96b`、`67542c7`、`6cd7ddb` 完成。没有发送真实用户 Memory、截图、路径或桌面数据；没有在集成后再次调用真实 API。

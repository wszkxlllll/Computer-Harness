# DEV-3/4/5 集成收尾报告

日期：2026-09-19

状态：本轮文档、离线验证与窄 synthetic API protocol 收口完成；retrieval integration review 的 P1/P2 已由 `61c6aff` 修复并纳入最终离线全量。本文不是 DEV-3/4/5 整体完成声明，也不替代独立 Sol 审查报告。

## 1. 当前可复核基线

当前分支为 `codex/dev3-context-memory-guard`，业务修复提交为 `61c6aff`，API 报告文档提交为 `be609f4`。本批相关实现提交包括：

- DEV-3 Context/Trace/prepared-provider/cache：`dee64fb`、`638d131`，以及把 Memory recall selection 接入实际 Context ModelInput 的 `6cd7ddb`。
- DEV-4 Memory scope/current-history/revalidation/lifecycle：`01a6d47`、`ba97878`；bounded retrieval、`memory_search`、Runtime mutation sync 和 Context 自动召回：`2e72f99`、`f22f96b`、`67542c7`、`6cd7ddb`。
- DEV-5 Monitor policy/online consumer 与边界修复：`294cdf5`、`adea8d7`、`ba97878`、`eec591c`。

此前实施者报告的历史证据为 36 files / 389 tests。修复 P1/P2 后，本次在当前源码树独立执行了 Node 24.19.0 / pnpm 11.19.0 的 `pnpm run typecheck`（退出 0）、`pnpm test`（36 files / 393 tests，退出 0）、CLI `--help`（退出 0）、`pnpm install --offline --frozen-lockfile --ignore-scripts`（退出 0，Already up to date）和 `git diff --check`（退出 0）。这仍是本地离线证据，不是 Hosted CI 或真实桌面/API 结果。

另有一次 root 明确授权的 synthetic Qwen embedding pilot：4 次 HTTP、0 失败/重试、provider usage 合计 64 tokens。后续受控 Memory tool protocol probe 累计 chat HTTP 10 次：首轮 GLM/Qwen 各 3 次，第二轮各 2 次；第二轮 GLM 2/2、Qwen 2/2 完成 synthetic ORCHID `memory_search` → admitted/revalidation 分区 → admitted-only `terminate`，无自动重试、无 GUI action。所有输入为 synthetic，未发送真实 Memory、路径、截图或桌面数据；该窄协议证据不证明语义检索质量、长任务质量、真实用户数据安全或 Hosted CI。

## 2. 已形成但有边界的能力

| 领域 | 当前证据 | 仍不能宣称 |
| --- | --- | --- |
| DEV-3 Context | ContextTrace、prepared metadata、request/decision/attempt 关联、Qwen 合法 `cacheReadTokens` 解析、Memory recall 实际排序进入 ModelInput | 完整 InstructionState/revision 语义视图、Provider tokenizer 精确 wire budget、GLM 直连 cache hit、跨 Provider cache 规则 |
| DEV-4 Memory | run/session scope、current/history 与 revalidation 分区、共同 applicability gate、无 TTL、bounded lexical/hybrid retrieval、`memory_search` 与自动 Context 共用 service；synthetic ORCHID 协议链路由 GLM/Qwen 各 2/2 验证 | 当前 semantic quality 总体证明、跨 Run/target/generation、独立 verification/视觉真值、真实用户数据或完整生产任务 |
| DEV-5 Monitor | `off|shadow|guidance`、有界候选、work clock、deferred help、unknown/approval/action barrier、合法 multi-call stop 边界 | 开放域视觉停滞检测、误报/漏报效果、跨 Run/target/generation 效果、真实 guidance/help 用户体验 |

检索模式边界：`off` 不创建 retrieval service、不注册 `memory_search`、不发 embedding 请求；默认 lexical 无网络；hybrid 需显式独立 endpoint 与 `MEMORY_EMBEDDING_API_KEY`，不会隐式复用 chat 凭证。检索结果只影响相关性排序，不是授权、审批或事实验证；tool result 不会伪造 user goal。

## 3. 已关闭问题与最终边界

此前独立 [DEV-4 retrieval 集成审查](./dev-4-retrieval-integration-review.md) 提出的三项定点阻塞已在当前源码树修复，并由上述 393 项 full 覆盖：

1. P1：app-runtime factory 现把同一个 `memoryMutationApplier` 传给 Runtime Controller，使 session-scope lifecycle mutation 同时物化到 Store 并同步 retrieval state/cache。
2. P2：bounded query 现保护最近真实 user correction，不再被长原始 goal 截掉；诊断计数对应实际进入 query 的来源。
3. P2：fact/source/entity exact identifier 现独立匹配，不依赖 key/value lexical overlap，并避免相似前缀误匹配。

本轮离线修复与窄 synthetic API protocol 验证已完成，结论如下：

1. focused 反例与 393 项 full 均对应 `61c6aff` 当前源码 tree；旧 357/363/389 计数仅保留为历史证据。
2. API 报告保留累计请求账本、失败与限制：第二轮 GLM/Qwen 各 2/2 完成 ORCHID 分区协议，但该窄验证不等同 DEV-3/4/5 整体完成、桌面验收或 Hosted CI。
3. 本轮提交范围仅包含状态文档、两份独立 Sol 审查报告与 API 结果文档；`runs/dev4-memory-model-api-validation*` 原始资产保持 ignored，不进入 Git。

## 4. 可后续处理而非本次收口阻塞

- 完整 InstructionState/CurrentInstructionView、语义修订 producer/consumer 与 revision/epoch 持久恢复；
- Provider 精确 tokenizer/wire budget、真实 GLM/Qwen cache hit/write/TTL 证据；
- Memory 跨 Run 策略、target/generation 公共 producer、独立 verification 与视觉真值；
- Monitor 视觉特征、真实效果集、误报/漏报与 guidance/help 产品效果；
- 真实桌面/OSWorld、通用 focus/AX、REL-1/T01..T14、公开安全集隔离适配。

这些项目不能通过增加文档字段、pilot 分数或本地 synthetic fixture 预先标记为完成；新增字段必须继续满足 producer、consumer、持久化、失效和清理条件。

## 5. 本轮操作边界

本轮整体包含 worker_probe 的 P1/P2 业务修复（`61c6aff`）及其独立 synthetic API 探针（报告文档 `be609f4`）；本 worker 独立执行当前修复树的 Node 24 typecheck/full/help/lock/diff 验收，未调用 API、操作真实桌面/VM、上传运行资产、推送或创建 PR。原始 prompt、Memory value、路径、URL、截图和凭证不进入本报告；原始探针资产仅保留在被 `.gitignore` 的 `runs/dev4-memory-model-api-validation*` 目录。

## 6. 通用下一步命令

以下命令仅展示 CLI help 已验证的参数形状，不自动启动模型或桌面；用户须自行提供批准的 env file/socket/output 目录：

```text
pnpm --filter @computer-harness/cli start -- --goal "<approved-goal>" --model glm-5.3-flash --computer cua --cua-socket "<socket>" --env-file "<env-file>" --memory facts --memory-retrieval lexical --monitor off --output "<runs-dir>"
```

`--memory-retrieval hybrid` 还必须显式提供独立 `--memory-embedding-endpoint` 与 `MEMORY_EMBEDDING_API_KEY`；不会复用 chat credential。`--monitor shadow|guidance` 只应在明确选择并理解其低置信候选/预算边界时启用。完整 model Run、真实桌面动作和 Hosted CI 不由本报告自动授权。

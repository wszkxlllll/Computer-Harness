# DEV-4 Memory RFT-5 实施结果

日期：2026-09-19
文档角色：结果
状态：RFT-5 拆分与 DEV-4 首批 scope/recall 行为已提交；本文前半保留各历史检查点，当前 retrieval/Context 离线接入与最终 P1/P2 状态见文末“当前收敛更新”
范围：RFT-5 的 Memory 拆分 commit，以及随后 DEV-4 首批 Fact scope/retention classification、current/history gate、revalidation recall 与 Runtime session lifecycle 行为。

## 1. 本检查点结论

Memory 原有单文件实现已按职责拆为四个内部模块，保持原有公共入口与行为：

- `index.ts` 只重新导出既有 `MemoryStore`、`InMemoryMemoryStore`、`FileMemoryStore`、`MemoryToolMode` 和 `createMemoryTools`。
- `store.ts` 承载内存/文件存储、原子写入和 mutation 应用流程。
- `tools.ts` 承载 facts/entities 工具定义与运行时提交回调。
- `validation.ts` 承载状态解析、边界校验、引用校验、mutation 归一化及工具结果解析。
- `constants.ts` 集中复用既有 `MEMORY_LIMITS` 映射。

模块间新增的导出仅供同一包内部使用；没有新增协议字段、Runtime/Context 依赖、工具能力或持久化格式。用旧版 `index.ts` 的 store/tools/validation 主体与新文件逐段比较，主体内容一致；变化仅为文件级 imports、内部函数可见性和 `randomUUID` 随文件存储实现迁移。

## 2. 实际验证

以下命令使用 Node.js `24.19.0`、pnpm `11.19.0`，均为 RFT-5 历史检查点在当时工作树执行的证据：

```powershell
pnpm --filter @computer-harness/memory build
pnpm exec vitest run packages/memory/src/index.test.ts packages/memory/src/runtime-regression.test.ts
```

结果：

- Memory package build：退出码 `0`。
- Vitest：2 个文件、19 项测试通过，退出码 `0`。
- 编译后直接加载 `packages/memory/dist/index.js` 并检查既有 `FileMemoryStore`、`InMemoryMemoryStore`、`createMemoryTools` 导出：通过。
- `git diff --check -- packages/memory/src`：无空白错误。
- focused 回归覆盖既有 InMemory/FileMemoryStore、facts/entities 工具、持久化与运行时回归；没有新增或删改测试。

本轮历史检查点没有运行全仓 typecheck/full test，没有调用模型 API、真实桌面、VM 或 Hosted CI。并行 worker 的 `context`、`protocol`、`runtime`、`trajectory` 变化当时保留在工作树，未纳入该 RFT-5 检查点范围；后续集成状态见文末，不应把本段当作当前仓库状态。

## 3. 与 DEV-4 合同的边界

RFT-5 部分只建立可审阅的代码职责边界；其历史“不实现语义”结论不适用于下面的 DEV-4 行为批次。当前实现仍不加入 `dependencies.requiredFor` 等会把记忆提升为执行前置权威的字段，也不伪造当前 CUA 尚未公开生产的 target/generation 或独立 verification claim。

RFT-5 的历史拆分检查点不关闭 DEV-4 后续行为；当前行为批次的剩余边界见第 5 节。

## 4. 留痕

RFT-5 代码与本报告的历史拆分 commit 已留痕；本次行为代码由独立 commit `01a6d47` 留痕。两笔均只在本地，未 push、未建 PR、未 merge。

## 5. DEV-4 首批行为（`01a6d47`，本地已提交）

- Fact 可带 `scope={kind:"run"|"computer_session"}` 与 `retentionClass="stable"|"task"|"short_lived"`；session id 只由 Runtime 当前 `ComputerSessionDescriptor.id` 盖章，target scope 明确 unsupported。Entity 保留既有 stale 生命周期，不复制 Fact 字段。
- Fact `statusReason` 只允许真实路径 `manual_review`（显式人工工具）和 `scope_ended`（Runtime 在 Run 完成前提交的 session-scope lifecycle mutation）；没有 TTL、action/event age 或按 frame ID 自动失效。
- 旧 JSON、旧 `memory.updated` replay 与 Store parser 都把缺省字段规范化为 run/stable；事件仍先 commit、Snapshot reducer 再由 app-runtime Store callback materialize。
- Memory `current` 与 Context 共用 applicability gate：superseded、scope mismatch、stale/missing entity 不进入普通/Hot；`memory_get` current 附 bounded `factAdmission`（admitted/revalidation），显式 `history` 返回并附安全 `factApplicability`。`needs_check` 与 active `short_lived` 只进入有界 revalidation 区；short-lived 是 last-known 线索，不是 current truth。
- Context trace 只记录 admitted/revalidation/excluded 的 ID 与 reason；revalidation 按 task/entity relevance 取少量候选，与 memory soft quota 共用文本预算，不新增模型维护调用。
- 当前 focused 结果：Memory 8 tests、Context 20 tests、Runtime 58 tests、Trajectory 33 tests 通过；root typecheck 通过。此前共享工作树的 34 files/357 tests 是行为收口前的历史证据，不宣称为本 commit 后的最终 full count；本批没有 Hosted/API/桌面/VM 证据。

仍未完成：跨 Run 记忆继承策略、target/generation producer、独立 verification/视觉真值、自动 retention TTL、Monitor 效果验收，以及 Sol 对本行为批次的最终审查。

## 6. 当前收敛更新（2026-09-18）

后续提交已把本报告第 5 节的 Memory 行为接入同一 retrieval/Context 路径：

- `2e72f99` 增加 bounded lexical/hybrid recall、safe trace、per-run embedding budget 与 canonical revision barrier；`f22f96b` 接入 Memory exports、`memory_search` 和 app retrieval mode；`67542c7` 让工具与 Runtime lifecycle mutation 后同步 retrieval state；`6cd7ddb` 让自动 Context 通过同一 recall service 排序并影响实际 ModelInput。
- 当前配置边界是 `memoryRetrieval=off|lexical|hybrid`：off 不创建 retrieval service/不发 embedding 请求；默认 lexical 无网络；hybrid 必须显式独立 endpoint 与 `MEMORY_EMBEDDING_API_KEY`，不隐式复用 chat credential。Plan 不是必要依赖，tool result 不会伪造 user goal，召回结果不是授权或事实验证。
- 修复 retrieval integration review 三项 finding 后，当前源码树独立离线证据为 Memory focused 42/42、全仓 36 files/393 tests、root typecheck 退出 0、CLI help/锁文件安装/diff-check 通过；此前 389 项属于修复前历史计数。该验证仍不是 Hosted CI 或集成后真实生产 API。
- 此前 root 授权的 synthetic Qwen pilot 仅 4 次 HTTP、0 失败/重试、usage 合计 64 tokens；它没有真实 Memory、截图、路径或桌面数据，且运行在公共 wiring 接入前，不能写成生产端到端证据。

retrieval integration review 指出的 P1/P2 已由 `61c6aff` 修复：Memory lifecycle mutation applier 现同时连接 Store 与 Runtime/Context consumer；长 goal 保留最近 user correction；exact identifier 不再依赖 lexical overlap。上述 393 项 full 覆盖这些回归；后续 synthetic ORCHID 协议 probe 由 GLM/Qwen 各 2/2 完成 search→admitted/revalidation→admitted-only terminate，无 GUI action。Monitor online consumer 已存在，旧文档中“仅测试 consumer/未接入 online”只描述早期 policy foundation 阶段，不代表当前状态；但 Monitor 误报/漏报、视觉特征、真实效果和完整生产任务仍未验收。

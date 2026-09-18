# DEV-4 Memory RFT-5 实施结果

日期：2026-09-18
文档角色：结果
状态：纯拆分 focused 回归通过；已建立独立本地 commit（见 Git 历史）
范围：仅 `packages/memory/src/**` 的保行为模块拆分；本轮不实现 Memory scope、retention、recall 或跨 Run 语义。

## 1. 本检查点结论

Memory 原有单文件实现已按职责拆为四个内部模块，保持原有公共入口与行为：

- `index.ts` 只重新导出既有 `MemoryStore`、`InMemoryMemoryStore`、`FileMemoryStore`、`MemoryToolMode` 和 `createMemoryTools`。
- `store.ts` 承载内存/文件存储、原子写入和 mutation 应用流程。
- `tools.ts` 承载 facts/entities 工具定义与运行时提交回调。
- `validation.ts` 承载状态解析、边界校验、引用校验、mutation 归一化及工具结果解析。
- `constants.ts` 集中复用既有 `MEMORY_LIMITS` 映射。

模块间新增的导出仅供同一包内部使用；没有新增协议字段、Runtime/Context 依赖、工具能力或持久化格式。用旧版 `index.ts` 的 store/tools/validation 主体与新文件逐段比较，主体内容一致；变化仅为文件级 imports、内部函数可见性和 `randomUUID` 随文件存储实现迁移。

## 2. 实际验证

以下命令使用 Node.js `24.19.0`、pnpm `11.19.0`，均在当前工作树执行：

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

本轮没有运行全仓 typecheck/full test，没有调用模型 API、真实桌面、VM 或 Hosted CI。并行 worker 的 `context`、`protocol`、`runtime`、`trajectory` 变化保留在工作树，未纳入本检查点范围或暂存。

## 3. 与 DEV-4 合同的边界

本检查点只建立可审阅的代码职责边界，不宣称 Memory 语义合同已经落地。后续 DEV-4 行为实施仍需明确并验证稳定/task/短期记忆的 scope、保留与召回优先级、适用性和失效规则；当前模型已有 `MemoryFact`/`MemoryEntity` 结构不能被解释为这些能力已经存在。首批不加入 `dependencies.requiredFor` 等会把记忆提升为执行前置权威的字段，也不伪造当前 CUA 尚未公开生产的 session/target generation。验证字段必须来自真实 runtime event、observation 或 host readback 证据。

本结果是 RFT-5 纯拆分检查点，不关闭 DEV-4 后续行为、跨 Run、生命周期或缓存实现任务。

## 4. 留痕

代码与本报告已以一笔独立本地 commit 留痕；repo-local author/committer 和 staged 文件范围已核对。按当前授权不 push、不建 PR、不 merge。

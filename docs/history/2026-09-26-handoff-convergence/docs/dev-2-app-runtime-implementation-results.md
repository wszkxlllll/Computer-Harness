# DEV-2 RFT2 app-runtime 实施记录

状态：按 Sol 集中复核意见完成整改并通过本批离线自审，待最终放行确认。当前分支为 `codex/dev2-app-runtime`，从 `origin/main` 的 PR #5 合并提交 `bc72ee5` 创建；未调用真实 API、桌面或 VM，未 push。

## 1. 本批范围与停止线

本批只做 RFT2 的 CLI 组装层迁移：把 Provider/Computer 工厂、run 目录/事件与资产 Store、诊断 recorder、Runtime Controller 组装和 summary/reporting 放入 `packages/app-runtime`。CLI 继续负责参数解析、env 文件读取、终端净化以及 CLI/TUI 控制循环；凭证只由 CLI 读取后通过依赖注入传入，不进入可序列化配置或报告。

不在本批实现 D2-SESSION、D2-EVENT、目标/focus/generation、quiesce、审批竞态、跨 Run 环境 owner、Monitor、Memory scope、真实 TUI 输入或 DEV-3/4/6 新合同。`RunController` 仍是每个 Run 唯一的主循环且只 `start` 一次；app-runtime 不创建第二个调度器。

## 2. 冻结的最小公共合同

### 2.1 `ResolvedRunConfig`

`ResolvedRunConfig` 是 CLI 完成参数/env 解析后交给 app-runtime 的单 Run 配置。它只含可 JSON 序列化的字符串、枚举、数字、布尔值和数组；不含 API key、Authorization、bridge token、HTTP client、Provider/Computer 实例、AbortSignal 或函数。可序列化不等于可分享或已脱敏。

字段与当前 CLI 的实际来源映射如下：

| 合同字段 | 当前来源 | 消费者 | 备注 |
|---|---|---|---|
| `runId?`, `goal`, `outputDir` | `index.ts` 的 runId/`--goal`/`--output` | `run-factory.ts`、reporting | 未提供 `runId` 时由工厂生成；每次创建独立输出目录 |
| `model`, `computer` | `parseArgs` 的模型/后端与 socket/bridge 配置 | `providers.ts`、`computers.ts` | 后端配置不含 bridge token |
| `maxSteps`, `maxModelRequests` | `--max-steps`、`--max-model-requests` | `DefaultRuntimePolicy` | 保持原默认值 |
| `planning`, `memory`, `batching` | `--planning`、`--memory`、`--batching` | tool registry、Context、Controller | 保持原开关与工具集合 |
| `contextMode`, `contextMaxHistoryEvents`, `contextMaxInputTokens?` | Context 参数 | `DefaultContextCompiler` | 只读 Context 组装 |
| `riskProfile`, `riskGuard`, `riskModel`, `riskMaxModelRequests`, `riskTimeoutMs` | CLI `resolveRiskConfig` 与 Risk 参数 | `LayeredRiskGuard`、features、summary、TUI metadata | 保持 interactive/confirm 语义；不把 key 放入 config |
| `cleanupDeadlineMs` | `--cleanup-deadline-ms` | `RunController` | 保持总 cleanup deadline |
| `qwenCoordinateMode?`, `qwenThinking?`, `qwenOutputMode?`, `qwenEndpoint?`, `qwenWorkspaceId?`, `glmThinking?`, `glmEndpoint?` | CLI 读取并校验非密钥 env/参数 | `providers.ts` | 两 Provider wire/开关保持各自实现 |
| `fixtureResult?` | `--fixture-result` | reporting | 只记录外部导入结果，不改变 Runtime outcome |

`ResolvedRunConfig` 的 `JSON.stringify`/summary 投影不得包含任何 `credentials` 字段；凭证值只存在调用栈中的依赖对象，goal/path/endpoint 等字段仍可能具有敏感性，Provider recorder 仍只写安全诊断，原始 trajectory 仍是私有执行记录。

### 2.2 `RunDependencies`

依赖注入是应用边界，默认实现由 app-runtime 提供，测试可替换为 Fake：

```ts
interface RunDependencies {
  credentials?: {
    glmApiKey?: string;
    qwenApiKey?: string;
    osworldBridgeToken?: string;
  };
  createProvider?: ProviderFactory;
  createComputer?: ComputerFactory;
  createEventWriter?: (path: string, runId: RunId) => RunEventWriter;
  createAssetStore?: (rootDir: string) => AssetStore;
  createPlanStore?: (rootDir: string) => PlanStore;
  createMemoryStore?: (rootDir: string) => MemoryStore;
  clock?: Clock;
  idFactory?: IdFactory;
  onCleanupError?: (diagnostic: CleanupDiagnostic) => void;
}
```

`ProviderFactoryOptions` 另有可选的 `httpClients.glm/qwen` 注入点，仅供离线 mock transport 回归；生产默认使用各 Provider 的 fetch client 与 recorder。

凭证及工厂函数是借用依赖，RunHandle 不调用其 `close`/`destroy`。由 RunHandle 通过默认或注入 factory 实际创建的 EventWriter、AssetStore、Provider、Computer 才属于本次 Run 的组装资源；Controller 在成功打开会话后负责一次 Computer cleanup，构造失败路径只关闭已创建且有明确 close 合同的 EventWriter。未创建的资源不清理，借用依赖不擅自关闭。若 Computer 自身在 `open` 中途失败，其 adapter 的既有 pending-ownership 合同继续生效。

### 2.3 `RunHandle`

`RunHandle` 是一次且仅一次的 Run 组装结果：

```ts
interface RunHandle {
  readonly runId: RunId;
  readonly config: ResolvedRunConfig;
  readonly controller: RunController;
  start(starter?: (controller: RunController, goal: string, markControllerStarted: () => void) => Promise<RunOutcome>): Promise<RunOutcome>;
  report(): Promise<RunReport>;
  close(): Promise<void>;
}
```

`start()` 默认调用 `controller.start(config.goal)`；CLI 可注入已有的 `runWithCliControls` callback，并在 Controller 接管前调用 marker，但仍由同一个 Controller 主循环执行，重复调用必须失败。starter 在接管前失败时，RunHandle exactly-once 关闭已创建 writer 并保留原始错误。`report()` 不接受外部 outcome，只读取已提交且已 finished 的 trajectory Reducer snapshot 和 cleanup diagnostics，不能改变 outcome；报告的 raw trajectory 路径和安全 provider diagnostics 继续分开。`close()` 在 start 前只释放该 Handle 创建的 writer，start 后只等待 Controller-owned cleanup，不重复关闭。RunHandle 不提供“重新打开已结束 Controller”的 API。

### 2.4 `createRun(config, dependencies)`

`createRun` 是无外部 API/桌面副作用的组装入口：它允许创建本地 run 目录并构造工具 Registry、Context、Provider/Computer、Policy 和 `RunController`，返回 RunHandle；真实 `Provider.generate`、`Computer.open` 只允许在调用 `start()` 后发生。任何构造中途异常都保留原始错误，并按创建顺序只清理已经创建且由本次 Run 拥有的 closable 资源。公共包 import 本身仍不得触发本地写入。

当前实现文件映射：

| 目标文件 | 职责 | 当前 CLI 来源 |
|---|---|---|
| `packages/app-runtime/src/config.ts` | `ResolvedRunConfig`、依赖/工厂类型、`RunHandle` 类型 | `CliOptions` 中已解析的单 Run 字段 |
| `packages/app-runtime/src/providers.ts` | GLM/Qwen Provider 工厂；接收已注入凭证；保持各自 wire 选项 | `apps/cli/src/index.ts::makeProvider` |
| `packages/app-runtime/src/computers.ts` | OSWorld 工厂与 CUA lazy importer；不在 help/OSWorld 入口加载 CUA native | `apps/cli/src/computer-factory.ts` |
| `packages/app-runtime/src/diagnostics/provider-summary.ts` | 安全 Provider response/transport 摘要 | `apps/cli/src/diagnostics/provider-summary.ts` |
| `packages/app-runtime/src/diagnostics/recording-clients.ts` | GLM/Qwen recorder 与私有 JSONL diagnostics | `apps/cli/src/diagnostics/recording-clients.ts` |
| `packages/app-runtime/src/run-factory.ts` | tools、Store、Context、Provider、Computer、Controller 的单次组装与失败清理 | `apps/cli/src/index.ts` 中 `main` 的 assembly 区域 |
| `packages/app-runtime/src/reporting.ts` | 读事件、snapshot/reducer、fixture 导入与安全 summary/report 写入 | `apps/cli/src/index.ts` 中 summary/`readFixtureResult` |
| `packages/app-runtime/src/index.ts` | 仅公共出口，无 import-time I/O/API/桌面副作用 | 新包根出口 |
| `apps/cli/src/index.ts` | `parseArgs`、env load、help、terminal 控制与 TUI/CLI starter；调用 app-runtime | 当前入口中保留的应用边界 |

既有 diagnostics 与 Computer 工厂测试随实现迁移到 app-runtime 包；CLI 只保留行为控制测试和入口 smoke。不得从其他包 import `src/`/`dist/` 私有文件。

## 3. 依赖与行为保持清单

- app-runtime 可依赖 protocol、trajectory、runtime、context、memory、planning、provider、risk-guard、computer adapter；runtime 不反向依赖 app-runtime，CLI/TUI 依赖 app-runtime。
- CUA 只能在 `createComputer({ kind: "cua" })` 的动态 import 路径解析；help、OSWorld 工厂和公共根 import 不触发 CUA native 加载。
- CLI 的 resolved Risk profile、Guard mode、confirm、cleanup deadline、planning/memory/batching/context 开关保持等价；非交互 experiment 默认 Guard off，交互入口默认 layered。
- GLM/Qwen 仍由各自 adapter 组装 wire payload；recorder 只写安全摘要，raw trajectory 不被 reporting 当作公开诊断。
- Provider/Computer 工厂失败、Controller start 一次、Computer cleanup 一次、writer close 一次均以 Fake 调用次数锁定；构造失败不关闭借用依赖，也不调用未创建对象。
- `report()` 不接受外部 outcome，只在 trajectory 已 finished 且存在 `snapshot.outcome` 时生成报告；starter 在 Controller 接管前失败会 exactly-once 关闭 writer，CLI finally 仅等待并保留原始错误。

## 4. 本批验收计划（实现后实际证据）

1. app-runtime 根导出与静态依赖边界；import 无 I/O/API/桌面副作用。
2. Fake `createRun` 正常路径：Provider 请求、RuntimeEvent 顺序、Controller 单次 start、报告字段与 CLI 旧路径等价。
3. GLM/Qwen 工厂选项和 recorder 安全诊断回归；两种 Provider 的开关及 wire 形状不交叉。
4. OSWorld/help 不触发 CUA 动态导入；CUA factory 失败保留原始 cause。
5. Provider/Computer/Writer 构造失败与 cleanup 计数：只清理已创建 owner，借用依赖不 close，Controller 关闭不重复。
6. CLI 参数/help、Risk confirm、cleanup deadline 与现有 focused/full 测试。

## 5. 实施后验证

- `pnpm exec vitest run packages/app-runtime/src/run-factory.test.ts packages/app-runtime/src/providers.test.ts packages/app-runtime/src/computers.test.ts packages/app-runtime/src/dependency-boundary.test.ts packages/app-runtime/src/diagnostics/provider-summary.test.ts packages/app-runtime/src/diagnostics/recording-clients.test.ts apps/cli/src/config.test.ts apps/cli/src/tui.test.ts`：8 files / 34 tests 全通过；其中 AST 越界合成反例为新增 test-only 收口。
- `pnpm run typecheck`：退出码 0；新增 AST test-only 收口前的最终 `pnpm test` 为 25 files / 264 tests 全通过；收口后相关 3 files / 14 tests 全通过，未重复全量。
- `pnpm --filter @computer-harness/cli start -- --help`：退出码 0；help 保留原 CLI 参数并显示 Risk/cleanup 选项，未触发 CUA native 加载。
- 静态边界测试使用 TypeScript AST 读取 production import/export 与动态 import，断言 app-runtime、CLI、Runtime 的允许依赖边；其 root smoke 从 `./index.js` 验证源码 barrel 可消费 `createRun/createProvider/createComputer/writeRunReport`，package exports/声明消费证据归 CLI 对 `@computer-harness/app-runtime` 的 typecheck。app-runtime 源码不读取 `process.env`，CLI 是凭证/env 唯一读取边界；Runtime 未新增 app-runtime 依赖；CLI 不再直接依赖具体 Provider、Computer、Context、Memory、Planning 或 Risk 实现。
- Provider mock transport 实际走 GLM/Qwen adapter `generate`，断言 endpoint、Authorization 注入、thinking、coordinate 描述、native/strict output 与响应映射；RunHandle 回归覆盖 unknown trajectory 与外部 succeeded 冲突、pre-start reject/double close、writer exactly-once。

本批没有改变 Provider wire、Runtime event 顺序、Risk/cleanup 开关或 raw trajectory 与安全 diagnostics 的既有语义；新增的是 app-runtime 公共组装入口及其安全配置/资源责任合同。所有测试离线执行；本批不声称 D2-SESSION、D2-EVENT、目标/focus/generation、跨进程 owner 或真实桌面能力完成。

# 分块重构施工表

更新：2026-09-17。状态：待实施；本轮只读核对当前源码，未搬代码或运行测试。

配套：[完整路线](./full-development-roadmap-v2.md)、[阶段验收](./development-acceptance-v2.md)、[实施入口](./stage-6-convergence-and-start-state-2026-09-15.md)。本文件只细化文件职责和迁移，不改变 DEV 顺序或提前实现后续功能。

## 1. 实施原则与入口门槛

现有 packages 已按业务域拆分；问题是部分包内部职责集中，不是缺少足够多的包。保持 TypeScript ESM，内部 import 使用现有 `.js` 后缀。`index.ts` 逐步成为公共导出入口，不要求所有短模块机械分文件。

每个工单先记录实际 Git 基线、未提交修改和文件所有者，补正常/异常特征测试，再迁移。已有缺陷先写反例并修复，不能把有缺陷的历史输出冻结成永久正确行为。纯移动与行为修复分开提交/审阅；未获得授权不 commit/push。

下表为建议目标文件，均不表示文件已存在。开工时列实际符号迁移清单；如检查到新实现已改变位置，更新本表后再做，不按旧行号搬代码。没有公共消费者的 helper 不从包根导出。

## 2. 原文件 → 目标模块 → 接口与验收

所有路径相对仓库根。除 RFT-2 明确的新组装包外，优先在原包内部拆分。

| 工单/阶段 | 当前来源与符号 | 目标文件及职责 | 保持的边界、主要验证 |
|---|---|---|---|
| RFT-1 / DEV-1 | `apps/cli/src/index.ts` 的 summarizeProviderResponse/StructuredContent/Arguments、Recording*HttpClient | 先提取 `apps/cli/src/diagnostics/provider-summary.ts`，记录客户端可随后放 `diagnostics/recording-clients.ts` | 纯摘要 import 不启动 CLI、不读 env、不发请求；L01/L02 与 Mock HTTP 记录测试。R02/F06 修复另批，不在搬迁时悄悄改输出 |
| RFT-2 / DEV-2 | CLI parseArgs/main/makeProvider/loadEnvFile/runWithCliControls/summary 组装 | CLI 保留 `args.ts`、`env.ts`、`controls.ts`、薄 `index.ts`；新增 `packages/app-runtime/src/{config,providers,computers,run-factory,reporting,index}.ts` | **本批已完成有界迁移（待 Sol 最终审阅）**：配置解析留应用入口，Provider/Computer 工厂、诊断、reporting 与 Controller 组装归 app-runtime；保留原参数/已修复默认值/摘要语义。已覆盖 CLI 等价、help、lazy CUA、import/依赖边界、启动失败资源清理；多Run/owner 不属于本工单，见 [DEV-2 实施记录](./dev-2-app-runtime-implementation-results.md) |
| RFT-3 / DEV-2，DEV-1仅按需提取 | `packages/runtime/src/run-controller.ts` 的 CommandInbox、批次判定、重试辅助函数 | 同目录 `command-inbox.ts`、`turn-preflight.ts`、`provider-retry.ts`；Controller 保留唯一主循环、状态、事件提交与副作用调度 | 现有 contracts/tool-registry/action-validation 不重建。模块通过参数/结果交流，不传整个 Controller，不起第二条调度循环。Inbox 顺序、Abort、批次中断、unknown、事件顺序回归 |
| RFT-4 / DEV-3 | `packages/context/src/index.ts` 的 DefaultContextCompiler、selectHistoryEvents/fitEventsToTokenBudget、formatPlan/Memory、selectMemoryForContext、modelTurnMessage | `compiler.ts` 组合；`history.ts` 完整历史组选择；`budget.ts` 估算/分配；`memory-recall.ts` 召回；`projections.ts` Plan/Memory 文本；`messages.ts` 历史消息/continuation | 保留 DefaultContextCompiler、selectMemoryForContext 及现有 options/selection 类型根导出。Context 只读输入，不写 Memory/Plan、不调用模型。C01..03、CT01..06；新 Trace/分区预算另批 |
| RFT-5 / DEV-4，DEV-1可先提校验 | `packages/memory/src/index.ts` 的 MemoryStore、InMemory/FileMemoryStore、createMemoryTools、参数/文件校验和 mutation 读取 | `store.ts` Store 合同；`stores/{in-memory,file}.ts`；`tools.ts` 注册；`validation.ts` 参数/文件校验；`mutations.ts` 提议构造与结果解析 | 保留 MemoryStore、InMemoryMemoryStore、FileMemoryStore、MemoryToolMode、createMemoryTools 根导出。reduceMemoryMutation 仍归 protocol，Context 召回仍归 context。M01/M02、FM01..15 分别区分搬迁与生命周期新增 |
| RFT-6 / DEV-3，独立按 Provider 迁移 | `packages/provider-glm/src/index.ts`；`packages/provider-qwen/src/index.ts` | 各自 `adapter.ts`、`http-client.ts`、`response.ts`、`coordinates.ts`、`tool-projection.ts`、`contracts.ts`；Qwen 再拆 `images.ts`，GLM profile 放 `profiles.ts` | 原 classes/types/profiles 根导出保持；Qwen strict flat/native、GLM native 分别保留。请求组装仍由各 Adapter 决定，不造统一大 parser。新增 prepared-request 合同在纯搬迁后单独实施 |
| RFT-7 / DEV-1按需、DEV-6完善 | `packages/risk-guard/src/index.ts` 的 LayeredRiskGuard、routeCandidate/scanDeclarationText、ProviderRiskAssessor | `guard.ts` 决策合并；`rules.ts` 确定性分类；`assessor.ts` 模型复核；`contracts.ts` 类型；index 保持出口 | 文件仅约250行，不为数量硬拆；修 R01/F08 时能独立测试规则和合并即可。不能移动后改变强制规则优先级或制造第二审批系统。R01a..c/R08a、超时与预算测试 |

RFT-2 迁移诊断记录客户端时从 CLI 移到 app-runtime，不能两处复制实现。同样，reporting 只聚合执行结果，不读取终端状态改变 Runtime outcome。

## 3. app-runtime 最小合同及应用边界

以下名称是建议新增接口，实施前连同类型导出提交合同审阅：

- `ResolvedRunConfig`：已经解析的单 Run 配置；显式包含模型、后端、功能开关与预算。CLI 输入解析和 env 文件加载不下沉；不得把密钥放进可序列化报告。
- `createRun(config, dependencies)`：创建一个只可启动一次的 RunHandle，提供 controller、已解析的安全配置、报告/清理入口。依赖注入 Provider/Computer 工厂、目录/存储和凭据解析器，方便 Fake 测试。组装本身不派发真实 GUI 或模型请求。
- `RunHandle`：一次 Run 的资源所有权；拥有者只清理由自己创建的资源。构造中途失败也有清理路径。Controller 已关闭的 Computer 不再次盲目 close；清理责任以接口说明和调用次数测试固定。
- 产品 TUI 的应用会话管理器负责下一 Run、环境 owner 和界面状态，不塞进 Provider 或 Computer。DEV-2 新的 ownership/quiesce 是行为开发，不能在纯组装迁移中冒称已实现。

新包需同步 package.json 的 workspace 依赖/exports、根 tsconfig references、包内 tsconfig，以及确有变化的 lockfile。新增 TUI 应用仍按 DEV-2 单独工单创建；本轮不把现有调试 tui.ts 改名就视作产品完成。

### 3.1 迁移后的独立 DEV-2 行为工单

这两项不是纯重构，不套用“行为完全不变”的验收，也不能遗漏到 DEV-7 才做：

| 工单 | 归属与新增接口 | 前置及验收 |
|---|---|---|
| D2-EVENT | Runtime `committed-events.ts` 定义提交后只读通知合同；app-runtime `event-feed.ts` 提供 `subscribe({ afterSequence, listener }) → unsubscribe` 与 `resync(afterSequence)`，RunHandle 暴露该 feed；类型从各自包根导出 | RFT-2完成、涉及Controller的RFT-3迁移批次落稳后，由一个worker接commitEvent通知点；T07与第4.2节慢消费者/丢失/重放/清理测试 |
| D2-SESSION | app-runtime `application-session.ts` 管一个活动Run，`environment-owner.ts` 管同进程桌面所有权；CLI/TUI只提交应用命令 | RFT-2及DEV-2 quiesce/目标合同冻结后实施；T09/T11/T12/T13覆盖新Run、历史显式导入边界、审批竞态与owner，禁止算作RFT-2已通过 |

D2-EVENT 的 Runtime 通知只是可选提交后观察者，不承担磁盘补读和 UI 队列。app-runtime 注入只读已提交事件读取器，维护有界队列及 sequence 水位；resync 先补到捕获的水位，再接增量并按序去重，测试订阅注册与历史读取期间发生新事件的竞态。UI 落后时发出独立传输状态 `resync_required`，不伪造一条业务 RuntimeEvent；读取器只能提供已提交序列。该能力启用前先冻结类型与关闭/异常语义，再接产品 TUI。

## 4. 事件与依赖必须守住的边界

### 4.1 依赖规则

- protocol 不依赖 runtime、UI 或具体 backend。
- runtime 可依赖 protocol/trajectory 等现有合同，不依赖默认 context、memory 实现、provider、computer、app-runtime 或 UI。
- context/memory/provider/computer 通过现有 runtime 合同接入；新增类型优先放实际拥有它的包，不为打破循环随意移到 protocol。
- app-runtime 是应用组装层，可依赖具体实现；CLI/TUI 依赖它，它不能反向 import CLI/TUI。
- 不跨包 import `src/`/`dist/` 私有文件，不让生产代码依赖 spikes，不让 Memory 或 Computer 直接调用另一 Provider。

在现有 Vitest 范围内增加静态依赖边界测试：用 TypeScript parser 读取 import/export 与字面量动态 import，检查上述禁止边；对非字面量动态加载要求单独审阅，不能声称文本正则能覆盖所有依赖。公共入口增加编译 smoke，验证当前根 exports 和声明文件仍可消费。

### 4.2 事件提交与订阅

纯重构保持现有 action/tool/memory 事件顺序，尤其 action.execution.started 必须先于实际输入，Memory 事件先提交再物化。先用 Fake Provider/Computer/Writer 记录调用序列，不能只比较最终 snapshot。

新增 UI 订阅属于 DEV-2 行为批次：沿用 RuntimeEvent 的 runId/事件标识/sequence，不另造竞争的业务事件。EventWriter append 成功、Reducer 更新后才通知；通知代表已提交到当前 writer，不额外声称 fsync/断电持久化。Memory 后续物化失败仍按既有错误事件报告。

订阅器不能回写 snapshot；慢订阅者用有界队列，溢出显式通知 resync，按已提交 sequence 补读，不能静默丢审批事件。持久化失败不能先向 UI 宣告成功。验证 listener 抛错、重复补读去重、取消订阅和 Run 结束的清理；界面只提交命令，由 Controller 决定顺序。

## 5. 工单顺序与可并行范围

1. **准备**：固定当前工作树状态，跑/记录可用基线；梳理受影响根 exports 和事件/Provider golden。没有结果时写未验证，不沿用历史179项当本次通过。
2. **DEV-1**：修确定性错误；RFT-1、校验等小提取先保行为再修缺陷。Risk 与 CLI 可由不同 worker 负责，Runtime/Context/Memory 共用合同由一位集成人协调。
3. **DEV-2**：RFT-2 先冻结工厂/RunHandle 合同，再迁移 CLI；RFT-3 按 Inbox→纯 preflight→retry 小批推进。随后单独实施 D2-EVENT 与 D2-SESSION 行为工单；二者有共享RunHandle时由集成人先冻结导出，再分文件。两个 worker 不能同时编辑 run-controller.ts 或共享 contracts.ts。
4. **DEV-3**：RFT-4 与两个 Provider 的 RFT-6 可分别拥有文件，但 prepared-request/ContextTrace 由集成人统一合同后接入，不独立发明多套类型。
5. **DEV-4**：RFT-5 纯拆分通过后，再单独增加 scope/依赖失效/迁移。不得把搬迁回归当作 FM12..15 的新功能验证。
6. **DEV-6/7**：完善风险模块与恢复，清理临时兼容入口；DEV-7 核查边界和交付，不发起第二次全仓大搬迁。

每批 worker 提交实际修改与验证报告→reviewer 只读审查→worker 修问题→集成人复核。未完成审查的共享合同不分派给下一批。业务新增前置按 V2 执行，不因本表编号提前。

## 6. 每批验证与停止条件

从仓库根使用满足 engines 的 Node 与 packageManager 固定的 pnpm；不依赖任何本机绝对路径。实施命令示例：

```powershell
pnpm run typecheck
pnpm exec vitest run packages/context/src
pnpm exec vitest run packages/memory/src packages/runtime/src
pnpm exec vitest run packages/provider-glm/src packages/provider-qwen/src
pnpm exec vitest run apps/cli/src packages/risk-guard/src
pnpm test
pnpm --filter @computer-harness/cli start --help
```

按改动范围选 focused tests，集成时全量检查；当前 build 等于 typecheck，避免将同一命令的别名当独立验证。CLI help 应无需密钥、无需创建真实 Computer。新增文件名以实际实现更新，以上不是已运行记录。

Provider golden 使用固定合成图片、用户文本与 Registry，包括单调用、多调用、Plan/Memory+Batch、Control 独占、continuation、坐标resize和错误响应；只归一化测试注入的时钟/随机ID，不忽略消息顺序、Schema、工具描述或坐标差异。纯迁移要求 wire 语义保持；新行为单列预期差异。用 Fake/Mock HTTP 不消费真实额度。

Runtime 回归覆盖 correction/approval/Abort竞态、批次中途失败与采图失败、未知副作用不重试、Memory 提交/物化失败、cleanup deadline。拆 Inbox 不能改变命令优先级，拆 retry 不能改变次数/预算或产生第二层重试。

停止条件：循环依赖、公开导出丢失、import 导致模型/桌面副作用、事件重排、参数默认值漂移、诊断泄露、两套调度器/状态写入者、无依据删测试。发现问题只回退本批明确改动，保留其他人的工作；需要广泛接口重设时先更新合同而不是继续局部补丁。

真实 API/桌面验收沿所属阶段单独进行，测试前说明模型、调用预算、数据和操作范围。纯文件移动不自动要求整批OSWorld重跑；不改正式任务与Validation。没有真实平台证据时只报告离线通过。

## 7. 完成交付表

每个 RFT 工单报告：实际源→目标映射、根 exports 对照、是否存在有意行为变化、依赖检查、focused/full 测试结果、Provider/事件序列对照、未验证项、回退边界。reviewer 核对运行路径而不是文件数。施工表完成不表示上述重构已经完成。

文档审阅记录：reviewer_sol 独立审阅后指出纯迁移与多Run验收混用、事件订阅缺工单归属；本版已分别移交 D2-SESSION 和 D2-EVENT，并补接口/迁移顺序。源码实施与测试均未开始。

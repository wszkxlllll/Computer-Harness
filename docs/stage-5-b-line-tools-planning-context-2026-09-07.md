# Stage 5 B 线交付：工具共同基础、Planning 与 Context

日期：2026-09-07  
文档角色：当前 B 线交接摘要  
状态：B-1～B-4 已在独立副本修复并验证；等待 A 集成公共补丁与 CLI/runner 接线

## 1. 基线与工作边界

- 原项目：`E:\MyDocument\大创调研\Computer-Harness`
- B 线副本：`E:\MyDocument\大创调研\Computer-Harness-B`
- 两者共同基线提交：`ef35e123fb1740aa37a259c0ad387d62abc05b26`
- 原项目在复制时已有三份未提交文档修改，已原样带入副本：
  - `docs/gui-agent-harness-v1-technical-plan.md`
  - `docs/run-turn-tool-and-user-correction-semantics.md`
  - `docs/stage-5-first-batch-analysis-and-next-gates-2026-09-07.md`
- 本线没有启动 VM、操作桌面或调用付费 API；没有修改 A 的目录，也没有提交/推送。

## 2. 已实现

### 工具共同合同

- `packages/runtime/src/contracts.ts`
  - `ModelToolSpec` 现在可携带 `category`、`coordinate.fields` 和 `control`。
  - 工具定义区分 Computer、Planning/Side 执行工具和 Control 决策工具。
  - `audiences` 控制主 Agent/Advisor 的模型可见范围；省略时只对主 Agent 可见。
  - 坐标转换只能依据显式 `coordinate.fields`，不再根据工具名或任意 `x/y` 参数猜测。
- `packages/runtime/src/tool-registry.ts`
  - 单一注册来源支持批量注册、按 audience 投影和执行前查询。
  - `modelTools()` 只输出可序列化的只读投影，不把执行句柄交给 Provider。
- `packages/runtime/src/control-tools.ts`
  - `terminate` → `finish`、`interact` → `user_input_required` 的统一定义。
  - `createDefaultToolRegistry()` 组合 Computer + Control；`createDefaultComputerTools()` 保留为兼容 helper。
- `packages/runtime/src/computer-tools.ts`
  - click/scroll/drag 的坐标字段已显式声明；type/key/hotkey/wait 不声明坐标。

### Planning 与事件投影

- `packages/protocol/src/index.ts`
  - `TaskSpec`、`PlanningTask`、`PlanState`、`PlanningTaskMutation`。
  - `planning.task.updated` RuntimeEvent。
- `packages/trajectory/src/index.ts`
  - `RunSnapshot.plan` 从带 `callId` 的 Event 归约得到；创建/更新任务会校验重复和不存在的 ID。
- `packages/planning/`
  - `InMemoryPlanStore`、`FilePlanStore`，按 Run 隔离；文件物化为 `<root>/<runId>/plan.json`。
  - `task_create/update/list/get` 四个工具；ID 由程序生成，TaskCreate 的结果返回后才能为后续更新提供 ID。
  - 写入顺序由 Runtime hook 约束为 `planning.task.updated` 事件后再物化 PlanStore。
  - `task_list/get` 可显式投影给 Advisor；写工具默认仅主 Agent 可见。
- `packages/runtime/src/run-controller.ts`
  - 每 Run 初始化空 Plan，并把最新 Plan 快照交给 Context。
  - Planning 工具成功时先写 `planning.task.updated`，再执行 PlanStore materialization hook。
  - 同一批调用中，前一工具失败/拒绝后，后续调用不再执行并得到明确 rejected 结果。

### Context 与 Provider

- `packages/context/src/index.ts`
  - 每轮在历史工具结果和用户纠正之后、最新截图之前加入当前 Plan 摘要。
  - ToolCall/ToolResult 配对规则保持不变，计划状态不冒充 GUI 完成证据。
- `packages/provider-glm/src/index.ts`
  - GLM 从 `ModelInput.tools` 生成工具 schema；控制工具按统一 metadata 映射成 ModelTurn。
  - 坐标编码/解码只遍历 `coordinate.fields`。
- `packages/provider-qwen/src/index.ts`
  - native tools 与 strict-json 的工具名、控制定义均来自 `ModelInput.tools`，不再私自追加 terminate/interact。
  - 坐标 schema、历史回传和响应解码只对声明坐标语义的工具做映射。
- `scripts/api-conformance.ts`
  - 适配 `ContextCompileInput.runId`。

## 3. 独立验证

在 B 线副本执行：

```text
pnpm typecheck
pnpm test
```

结果：

- TypeScript project build/typecheck：通过；
- Vitest：10 个测试文件、134 个测试通过；
- Planning：8 个测试覆盖程序 ID、Run 隔离、文件持久化、更新前 ID 检查、schema/validate 一致性、blockedBy 引用/自引用/环依赖、真实 RunController 闭环和失败恢复；
- Registry/Provider/Context：覆盖 audience 投影、Control 映射、显式坐标字段和 Plan 注入；
- 已执行一次小规模真实 Provider 协议探针；未执行 VM、CUA 或桌面操作。该探针使用的历史组合不包含 Planning 工具，详见第 5 节。

## 3.1 第一阶段整改（B-1～B-4）

### B-1：计划物化失败停止 Run，并支持事件重建

- `packages/runtime/src/run-controller.ts`
  - `planning.task.updated` 已提交后，如果 `afterPlanCommit` 失败，写入 `tool.call.failed`（`PLAN_MATERIALIZATION_FAILED`）、`runtime.error`（`planning_materialization_failed`），随后写 `run.finished(outcome="failed")`。
  - 不再进入下一轮 Provider/GUI/Planning 决策；已提交 Planning Event 保留为权威事实。
  - 前一工具失败后的剩余同批调用不会在 Run 已结束时继续写拒绝事件。
- `packages/planning/src/index.ts`
  - `PlanStore.rebuild`、`planningMutationsFromEvents`、`rebuildPlanFromEvents` 支持从已持久化 Event 重新物化 `plan.json`。
  - 文件物化保持原子临时文件 + rename；事件 append 失败时不会调用 Store。
- 测试：真实 `RunController → task_create → Event → 物化失败 → Run failed`；再用事件重建文件；另测 Event append 失败不写 Store。

### B-2：Runtime 执行前落实 main audience

- `RunControllerDependencies.toolAudience` 默认 `main`。
- `processToolCalls` 使用 `ToolRegistry.getForAudience()`，而不是只用未过滤的 `get()`。
- advisor-only 工具即使被 FakeProvider 伪造返回，也会在执行前 rejected，handler 不调用；审批/暂存批次沿用同一预检结果。

### B-3：Qwen strict/native 共用 Control metadata

- `packages/provider-qwen/src/index.ts`
  - strict envelope 不再硬编码 `terminate`/`interact`；finish/user-input/tool-call 全部交给 `mapQwen38ToolCall()`，按 `ModelInput.tools` 的 `control` metadata 映射。
  - 未提供的控制工具、控制名与 `kind` 不匹配、普通工具冒充控制均拒绝。
  - native 与 strict 共享同一控制分支和错误语义。
- `anyOf` 每工具独立 schema 继续保留，避免 Planning `status` 和 finish `status` 合并。

### B-4：Planning schema/description/validate 对齐

- `task_update` schema 增加 `anyOf`，明确 `taskId` 之外至少提供一个更新字段。
- `task_create`/`task_update`/`task_get` 本地 validate 拒绝未知字段，与 `additionalProperties: false` 对齐。
- subject 拒绝空白字符串；task_get 只接受 taskId；status/blockedBy 类型和枚举约束与 schema 对齐。
- 描述明确写出 TaskCreate 先返回程序 ID、TaskUpdate 至少一个变更字段、Planning status 不等于 GUI 完成证据。

### B-5：blockedBy 确定性验证

- `blockedBy` 中的每个 ID 必须存在于同一 Run 的 `PlanningTask[]`；不存在时拒绝更新。
- 禁止任务阻塞自身。
- 对完整 PlanState 做 DFS 环检测；形成间接环时拒绝更新和 Store 物化。
- `blockedBy` 仍然只是计划依赖声明，不会自动调度、暂停或阻止 Computer 工具；执行调度语义留给后续明确需求。

## 4. A 线集成顺序

1. 将本线公共合同补丁应用到 A 的同一基线；先编译 `protocol → trajectory → runtime`。
2. 将 `packages/planning` 加入 workspace、lockfile 和 TypeScript project references。
3. CLI/runner 从 `createDefaultToolRegistry()` 开始，而不是继续只调用 `createDefaultComputerTools()`；按 Planning 开关注册 `createPlanningTools(planStore)`。
4. CLI 构造 `DefaultContextCompiler` 时继续使用同一 registry；RunController 传入的 `snapshot.plan` 会自动进入下一轮 ModelInput。
5. Provider 不再新增本地工具表；GLM/Qwen 直接消费 Context 生成的 `ModelInput.tools`。控制工具必须在实际 registry 中注册，否则 Provider 不应生成 terminate/interact。
6. 用 FakeProvider/FakeComputer 验证：`task_create → completed ToolResult → 下一轮 Context 看见 task id/status → task_update → plan.json`；再接入 CLI/runner。
7. 最后再做真实任务实验；本交付不改变 Computer Adapter 或 VM。

## 5. 小规模真实 API 协议测试

使用原项目已授权 `.env` 和合成图片 `non-sensitive-ui.png`，没有读取或输出 API Key：

```text
Provider：GLM-5.3-Flash、Qwen3.8-Flash
每个 Provider：2 次请求、2 轮响应
Qwen：strict_json，thinking=disabled
结果：GLM 2/2 HTTP 200；Qwen 2/2 HTTP 200
```

证据：[runs/api-conformance/b-phase1-20260907/summary.json](../runs/api-conformance/b-phase1-20260907/summary.json)

确认事实：

- Qwen 服务端接受当前 `json_schema` + `anyOf` 请求格式并返回可解析 JSON envelope；
- GLM 接受当时的统一 Computer/Control 工具投影的 native Function Calling 请求；当时没有注册 Planning 工具；
- 仅验证普通协议联通、schema 接受和响应解析，没有把任何 ToolCall 派发给 Computer，也不能据此宣称 Planning 已验证。

另做了一次 Qwen native-tools 探针：请求体成功生成并包含统一 registry 的 `tools`、`tool_choice=auto`、`parallel_tool_calls=false`，但首个请求在传输层 `fetch failed`（HTTP status=0），没有拿到模型响应；没有重复重试。因而 native 的真实服务端响应未验证，native 的控制同源逻辑仍由本地 FakeHttpClient 测试覆盖。

## 6. 尚待 A 集成/复审

- 这是独立副本中的未提交补丁，尚未写回原项目或远端。
- CLI/OSWorld runner 尚未接入 Planning 开关和 `FilePlanStore`，这是 A 的集成面，不在本线擅自改动。
- Advisor 尚未实现；本线只提供 audience 合同和只读 Planning 投影，不实现 Advisor、后台队列、Memory 或 Replan。
- Qwen strict-json 仍使用现有 envelope，但 `anyOf` 为每个已注册工具生成独立分支，避免 Planning 的 `status` 与 terminate 的 `status` 合并；本次历史探针确认服务端接受普通 schema，但没有真实诱发 Planning 控制响应，也没有改变已冻结的 baseline 终止语义。A 的新 Planning smoke 结果以 A 线集成记录为准。
- Qwen native 控制别名和 strict 控制分支已用 FakeHttpClient 覆盖；native live API 已尝试一次，但请求在传输层 `fetch failed`，没有可用响应，不能据此判断服务端是否接受 native schema。
- CLI/runner 仍未完成统一 registry、Planning 开关和 FilePlanStore 接线；这是 A 的最终集成职责。
- 未启动 VM 任务评测、未操作真实桌面、未验证 CUA 动作和 OSWorld evaluator。

## 7. 给 A 的合并边界

- A 必须保留自己的动作预算、viewport/按键预检、GLM 网络诊断和 runner 改动；不要用 B 补丁覆盖这些文件的独立修改。
- 需要人工审查合并的公共文件：`packages/runtime/src/contracts.ts`、`packages/runtime/src/run-controller.ts`、`packages/provider-glm/src/index.ts`、`packages/provider-qwen/src/index.ts`、`packages/protocol/src/index.ts`、`packages/trajectory/src/index.ts`。
- A 应保留 `pnpm-lock.yaml`/`tsconfig.json` 的最终集成版本，并把 `packages/planning` 加入 workspace/project references。
- 交付补丁：[Computer-Harness-B-tool-planning.patch](<E:/MyDocument/大创调研/Computer-Harness-B-tool-planning.patch>)；该补丁刻意排除了复制时已有的三份共同文档修改。
- 原项目中复制来的三份文档修改属于基线前状态；A 合并时应按其当前文档版本处理，不要覆盖 A 的其他文档工作。

## 8. 交接验收标准

只有同时满足以下条件才算 B 线接通：

1. 模型看到的 Computer、Planning、Control 工具来自同一个 Run registry；
2. 禁用/Advisor 不可见工具不能被执行；
3. Qwen/GLM 的请求、响应和历史回传使用同一 `ModelInput.tools` 投影；
4. 坐标转换只发生在声明坐标字段的工具上；
5. 一次真实闭环完成 `task_create → 工具结果 → 下一轮模型看到更新 → task_update`，并在对应 Run 的 `plan.json` 留下更新；
6. Planning 关闭时，Computer-only baseline 的测试和行为保持通过。

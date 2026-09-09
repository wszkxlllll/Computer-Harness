# Planning 对比测试开跑审查

日期：2026-09-08  
状态：整改完成，可开始小规模配对实验  
审查对象：Computer-Harness-A 集成空间；不是原项目 main  
入口：[DOCS-INDEX.md](./DOCS-INDEX.md)

## 1. 结论

**核心链路已达到开展第一轮 Planning 效果对比的条件。无需继续等待新模块、重跑 30 条或再次完整验收 B。** A 已完成下述脱敏修复并通过构建/回归；现在只需固定本轮执行版本与参数。

这是技术放行意见，不是本次审计已执行 VM 的声明。用户此前只授权了 API 探针；VM 任务执行仍由用户启动或明确交给实施 Agent。

## 2. 本次独立核验

- 实读 CLI、OSWorld runner、Runtime、Context、Planning、GLM/Qwen adapter、组合测试和 A 集成报告。
- CLI 使用同一 registry 构造 Context 与 Runtime；默认 Computer + Control，`--planning` 才注册四个 Planning 工具和 FilePlanStore。runner 转发该开关，两个 summary 均记录 planning，CLI 记录实际工具名。
- Runtime 保留 action budget、compile 后纠正、audience 检查、计划物化失败终止及事件重建相关链路。
- Planning 组合测试使用 DefaultContextCompiler；FakeProvider 从 ModelInput 获取 task ID，不再依赖 Store 旁路读取。
- 独立解析下列 summary 和 trajectory，确认不仅是报告声称通过：

| 证据目录（A/runs 下） | 模型请求 | Planning 更新事件 | GUI 动作开始 | 结果 | total tokens |
|---|---:|---:|---:|---|---:|
| planning-api-glm-20260908-r3 | 3 | 2 | 0 | succeeded，计划 completed | 6,451 |
| planning-api-qwen-20260908-r4 | 3 | 2 | 0 | succeeded，计划 completed | 8,680 |

Qwen r4 使用统一 `kind=tool_call` wire envelope，再按 registry.control 转成 finish/user_input_required。该调整消除了两处重复表达决策类型的矛盾，不是绕过工具许可，也不改变公共 ModelTurn 的区分，可以保留。对照两组都必须使用这一版，不能用旧 r3/baseline 的协议作另一组。

这些记录证明真实 API + Planning/Context 的闭环，不证明 GUI 定位、自然采用 Planning 或任务成功率提高。smoke 的用户任务显式要求 create/update，实际任务不会这样引导。

A 报告 build、140 个 TS 测试、5 个 Python 测试通过。本次没有重跑这些命令，计数属于作者报告；独立核验的是源码与已有运行事件。未调用 API、未启动 VM、未更改业务代码。

## 3. 开跑前唯一确定的小修项：脱敏遗漏（已整改）

原审计发现（修复前）：`packages/provider-glm/src/index.ts:252` 的 sanitizeDiagnosticText 先做普通 `Authorization: 值` 替换，再做 Bearer。输入 `Authorization: Bearer synthetic-token-123` 会先变成 `Authorization: [redacted] synthetic-token-123`，后面的 Bearer 正则无法再匹配；当时集成报告与源码不一致，且缺少 Authorization 回归用例。

整改要求：先完整清理 Authorization/Bearer，再处理其他键值，或仅输出安全结构化诊断；用合成凭据补断言，确认最终消息完全不含 synthetic-token-123。该要求已在 3.1 完成，不要求重跑 API/VM 或整个集成周期。

### 3.1 整改复核

- `packages/provider-glm/src/index.ts` 已先处理完整 `Authorization: Bearer <token>`，再处理独立 Bearer、查询参数和其他键值；不会再出现只替换 `Authorization: Bearer` 而残留 token 的情况。
- `packages/provider-glm/src/index.test.ts` 已加入 `synthetic-token-123` 回归，断言最终错误消息包含 `Authorization: [redacted]` 且不包含原 token。
- `pnpm build`、`pnpm test` 已重新执行并通过：10 个测试文件、140/140；因此本修复已进入当前 A 的执行构建链路。

### 3.2 首轮 GLM 配对命令（仅准备，不代表已执行）

下列命令必须在用户授权 VM 执行后运行。每条 runner 启动独立 Bridge，并在启动阶段从同一快照执行 `reset(taskId)`；baseline 与 Planning 只差 `--planning` 和独立输出目录。请先把尖括号变量替换为本机路径，保持两组其他参数完全一致。

```powershell
$repo = "E:\MyDocument\大创调研\Computer-Harness-A"
$osworldRoot = "<OSWorld checkout>"
$vmx = "<Ubuntu.vmx>"
$python = "<OSWorld Python>"
$vmrun = "<vmrun.exe>"
$envFile = Join-Path $repo ".env"
$snapshot = "osworld_initial_1920x1080_clean_r4_20260906"
$cli = Join-Path $repo "apps\cli\dist\index.js"
$runner = Join-Path $repo "scripts\stage5-osworld\run-task.mjs"

function Run-PlanningPair($name, $taskId, $maxSteps, $maxRequests) {
  $common = @(
    $runner, "--osworld-root", $osworldRoot, "--path-to-vm", $vmx,
    "--snapshot-name", $snapshot, "--task-id", $taskId,
    "--model", "glm-5.3-flash", "--max-steps", "$maxSteps",
    "--max-model-requests", "$maxRequests", "--cli", $cli,
    "--python", $python, "--vmrun-path", $vmrun, "--env-file", $envFile
  )
  node @common "--output" (Join-Path $repo "runs\planning-compare\$name-baseline")
  if ($LASTEXITCODE -ne 0) { throw "baseline failed: $name" }
  node @common "--planning" "--output" (Join-Path $repo "runs\planning-compare\$name-planning")
  if ($LASTEXITCODE -ne 0) { throw "planning failed: $name" }
}

Run-PlanningPair "S07" "1273e544-688f-496b-8d89-3e0f40aa0606" 12 16
Run-PlanningPair "M05" "3f28fe4f-5d9d-4994-a456-efd78cfae1a3" 20 24
Run-PlanningPair "H02" "d9b7c649-c975-4f53-88f5-940b29c47247" 35 40
Run-PlanningPair "H05" "0326d92d-d218-48a8-9ca1-981cd6d064c7" 35 40
Run-PlanningPair "H07" "51719eea-10bc-4246-a428-ac7c433dd4b3" 35 40
Run-PlanningPair "H08" "98e8e339-5f91-4ed2-b2b2-12647cb134f4" 35 40
```

执行顺序应先单独运行 S07 的 baseline/planning 配对，检查 reset、Bridge、CLI 和结果落盘；确认无基础设施失败后，再按 M05、H02、H05、H07、H08 串行运行。每个输出目录必须为空且唯一；不要复用旧 `runs/` 目录或把旧结果作为本轮 baseline。

## 4. 实验配置：先 GLM，6 对任务

比较对象为：

- baseline：当前 A 版本，Planning 关闭。
- treatment：同一 A 版本，只增加 `--planning`（Planning 工具 + 当前 Plan Context）。

**本轮测的是 Planning 与 Plan Context 的组合效果，不拆分归因。** 不加入 Monitor、Memory、Advisor，也不强制用户任务包含“请使用计划工具”。未调用 Planning 本身就是重要实验结果。

第一轮使用此前冻结的 6 个任务：S07、M05、H02、H05、H07、H08，共 12 次 GLM 运行。先 S07 的两组确认真实入口与环境可用，然后继续余下配对；出现明确基础设施失败时停止受影响路径，而非全量盲跑。

- 两组共用同一代码/构建、模型参数、任务原文、快照、GUI action budget 和 model request budget；每次独立 reset，VM 串行运行。
- 显式传入两个预算，不依赖 runner 默认 30/30。沿用已约定预算或在开跑前统一固定；模型请求预算应给 Planning 和最后的 finish 留出空间，两组保持一致，运行后不能只给失败组补额度。
- 每个任务两组相邻运行，交替先后顺序；用不同新输出目录，不复用 PlanStore/run ID。
- 不用旧 30 条结果充当本轮 baseline，因为基础设施、Control 注册及 Provider 协议已变化。
- 保存实际 A 工作树/补丁快照与运行参数即可；不要求新建复杂版本追踪系统，不擅自提交推送。
- 第一轮是开发集验证，不是统计显著性结论。若效果接近且波动明显，再对关键任务补重复，不先扩大到全量。

Qwen 已可进入相同协议的对照，但建议先完成 GLM 这一组，避免同时改变模型和功能。随后 Qwen 选择同样任务做自身 baseline/treatment；不把 GLM baseline 与 Qwen treatment 比较成 Planning 收益。

## 5. 结果需要回答的问题

1. 官方 score 和 runtimeOutcome 分别是什么？不要合并成一个“成功”。
2. Planning 开启后是否实际调用 create/update？任务 ID、状态是否进入下一轮 Context，是否出现过时计划或错误完成声明？
3. GUI 动作数、模型请求数、总 token、Provider 累计延迟、Runtime 耗时怎样变化？减少 GUI 步骤但增加请求成本也应如实报告。
4. 相邻重复动作候选、拒绝/失败、恢复动作有哪些变化？相同动作不自动等于无意义，结合差异明显片段人工分析。
5. 收益/退化来自任务拆分、状态保持、信息复用还是额外规划负担？没有使用 Planning 与使用后无收益分开记录。

当前离线脚本足以开始。不要新增细粒度 reset/context 观测系统。预算耗尽、网络失败和环境失败单列，不能全部当模型规划失败。

## 6. 给 Agent A 的执行准备提示词

```text
你负责在 Computer-Harness-A 完成首轮 Planning 对比准备。先读 docs/stage-5-planning-comparison-readiness-audit-2026-09-08.md。

核心集成与真实 API Planning 闭环已通过审查，不必再重做 B 验收。第 3 节的 Authorization/Bearer 脱敏遗漏已修复，合成凭据回归、构建和全量测试均已通过；不要重复修改该问题。

固定当前 A 版本与两组相同的模型/动作/请求预算；准备 S07、M05、H02、H05、H07、H08 的 GLM 配对命令，每次新输出并独立 reset，只通过 --planning 改变实验组。不用旧结果代替新 baseline，不加入其他增强模块，不给任务额外规划暗示。

用户尚未授权 VM 执行时只交付命令；收到执行授权后先跑 S07 配对检查入口，再串行跑剩余任务。完整结果按第 5 节统计并分析，尤其区分没有采用 Planning、采用无收益和基础设施失败。不得提交推送或覆盖原实验记录。
```

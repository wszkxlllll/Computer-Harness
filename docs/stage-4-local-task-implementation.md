# Stage 4-A：Windows 本地任务验证

状态：当前执行入口（2026-09-02）

本路线验证完整 Harness 在 Windows 专用 fixture 上能否驱动真实 CUA 完成短任务，并把
Provider、Runtime、工具、评分和轨迹故障分开归因。它不代表 OSWorld 已接通，也不负责 Memory、
Verifier、RL 或 Dashboard。

## 当前范围

当前只运行两个模型：

- `glm-5.3-flash`，`packages/provider-glm`；
- `gui-plus-2026-02-26`，`packages/provider-qwen`。

`glm-4.6v-flash` 已退出现行代码和实验入口；旧结果留在 `docs/history/`，不再作为命令或新样本。

冻结输入位于 [stage-4-local-tasks-2026-08-31.json](./stage-4-local-tasks-2026-08-31.json)：3 个同构短任务，
两个模型各运行 3 题，共 6 个正式 Run；每 Run 最多 12 steps、16 次模型请求。两模型共享初态、目标、
预算和外部 evaluator，不给模型预设坐标或标准轨迹。scroll/drag 不放入共同任务。

## 已确认事实

- 真实闭环为：`Observe → Context → Provider → ModelTurn → Tool/Action 校验 → CUA → 新 Observe`。
- `apps/cli/src/index.ts` 只负责组装，不复制 Runtime；密钥只从环境读取。
- `packages/runtime` 的 `RunController` 负责 Run 控制、ToolCall 路由、预算、暂停/取消和终态。
- `packages/context` 负责按对话时序投影 goal、assistant ToolCall、tool result 和最新图片。
- `packages/computer-cua` 负责把 Harness Computer 合同接到 CUA daemon；`spikes/cua-driver/stage4-local-runner.ts`
  负责独立 daemon、fixture、CLI、evaluator 和清理。
- `scripts/stage4-local/evaluate-fixture.ps1` 是模型上下文之外的确定性评分器；不把模型自报 finish 当作任务成功。
- 当前本地回归：`pnpm test` 为 95/95，`pnpm run typecheck` 通过，runner contract check 通过。
- 旧的三模型首轮成功率和 Provider 失败记录属于历史证据，不能和本轮双模型结果混算。

## 当前阻塞与下一步

正式排名和扩大任务集前，先按总体审计关闭 P0：

1. 动作已确定完成但动作后 Observe 失败时，仍必须写入 ToolCall 终态；
2. Qwen native 与官方文本协议的对照必须在同一冻结输入上完成，先确认 wire 合同再决定是否改 Adapter；
3. GLM-5.3 的 `reasoning_content` 历史呈现需要补齐，避免多轮请求丢失模型上下文。

P0 通过后，先做一次 Qwen paired run，再按相同任务、预算和 evaluator 运行两个模型的 6 个正式 Run。
实验输出写入 ignored 的 `runs/`，每个 Run 单独目录，保存 Event、截图、请求计数、延迟、成本、评分和清理结果。

Paired runner 的临时位置约定为 `scripts/experiments/qwen-wire-paired.ts`；不修改 Runtime/Protocol，实验结束
可删除脚本和 `runs/experiments/qwen-wire-paired/`，只有通用结论才另开 Provider PR。

## 实施要求

- 开始真实桌面 Run 前取得宿主独占时间窗；不要同时操作 VMware、剪贴板或其他窗口。
- 每次使用独立 CUA daemon/socket/fixture；只清理本次记录的 PID、socket 和输出目录。
- 不修改 OSWorld、`dase_lab`、用户文件、`.env` 或其他 Agent 的运行环境。
- 记录工程故障、Provider 协议错误、工具拒绝、模型决策错误和 evaluator 失败，不能针对单条 bad case 添加 Prompt 补丁。
- 截图和轨迹可能包含隐私，不提交 Git；报告只写脱敏事实和路径。
- Provider/Driver 未证明副作用时禁止自动重试；优先重新观察并保留未知状态。

## 关键命令

先做无桌面副作用检查：

```powershell
pnpm run typecheck
pnpm test
pnpm --dir spikes/cua-driver run test:stage4-runner
```

真实 Run 只在用户确认独占桌面后执行：

```powershell
pnpm --dir spikes/cua-driver run run:stage4-task -- `
  --binary "<path-to-cua-driver.exe>" `
  --fixture "<path-to-ProbeWindow.exe>" `
  --task text-replace-alpha `
  --model glm-5.3-flash `
  --socket "<private-pipe>" `
  --output "<absolute-run-output>" `
  --env-file "<absolute-path-to-.env>"
```

模型只能填 `glm-5.3-flash` 或 `gui-plus-2026-02-26`。不要把旧 4.6V 命令恢复到当前入口。

## 交付格式

每个 Run 报告：模型和实际配置、`runtimeOutcome`、模型 summary、evaluator success/reason、动作/模型请求数、
耗时与用量、轨迹路径、人工介入、实验干扰和清理状态。完成后更新本入口的“当前阻塞与下一步”，不覆盖历史结果。


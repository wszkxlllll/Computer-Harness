# Qwen flat 回归与统一集成验收（2026-09-15）

日期：2026-09-15
文档角色：结果 / 验收
状态：当前证据
当前入口：[Stage 6 收敛与下一阶段起始状态](../../stage-6-convergence-and-start-state-2026-09-15.md)
基线：当前仓库工作树，Qwen3.8-Flash、GLM-5.3-Flash
范围：Provider、Runtime、Planning、Memory、Batch 和双后端 fake fixture；不覆盖真实 CUA daemon、OSWorld VM 或正式效果评测

## 结论

源码集成验收通过，可以继续进入统一 flat 协议下的真实任务准备。Qwen strict 的协议改造没有破坏 GLM、Planning、Memory、CUA Adapter 或 OSWorld Adapter。

但 Qwen 全返回矩阵为 21/24（87.5%），剩余失败属于模型偶发协议偏离，不应被写成“Provider 已 100% 稳定”。正式桌面/VM 效果评测仍应保留失败记录和重试预算，不能自动重放已经执行过的副作用。

## 实际执行

API 密钥通过 `--env-file <ENV_FILE>` 指定的本地环境文件加载，未写入产物；没有启动真实 CUA daemon、OSWorld VM 或操作桌面。

```text
node scripts/qwen-flat-return-matrix.mjs --env-file <env> --output runs/api-conformance/qwen-flat-matrix-post-migration-20260915 --repeat 3
node scripts/real-batch-api-conformance.mjs --model all --composite --env-file <env> --output runs/api-conformance/real-composite-post-flat-migration-20260915
node scripts/real-memory-api-conformance.mjs --model all --mode all --env-file <env> --output runs/api-conformance/real-memory-post-flat-migration-20260915
node scripts/stage5-planning-api-smoke.mjs --model glm-5.3-flash --env-file <env> --output runs/api-conformance/real-planning-glm-post-flat-migration-20260915
node scripts/stage5-planning-api-smoke.mjs --model qwen3.8-flash --env-file <env> --output runs/api-conformance/real-planning-qwen-post-flat-migration-20260915
node scripts/batch-backend-fixture.mjs runs/api-conformance/batch-backend-fixture-post-flat-migration-20260915
```

## 结果

| 验收项 | 结果 | 判断 |
|---|---:|---|
| Qwen 单 `terminate` | 3/3 | 通过 |
| Qwen 单 `type` | 3/3 | 通过 |
| Qwen `click→type` Batch | 3/3 | 通过 |
| Qwen Plan + Memory + GUI Composite | 3/3 | 通过 |
| Qwen Memory 写入→读取 | 3/3 | 通过 |
| Qwen Planning 创建→更新 | 2/3 | 1 次模型格式偏离 |
| Qwen state-only 多调用 | 2/3 | 1 次模型返回裸数组 |
| Qwen 单 click | 2/3 | 1 次重复已执行 ToolCall ID |
| GLM/Qwen Composite | 2/2 | 通过 |
| GLM/Qwen Fact/Entity Memory | 4/4 | 通过 |
| GLM/Qwen Planning smoke | 2/2 | 通过 |
| CUA fake backend Batch | 2/2 actions | 通过 |
| OSWorld fake bridge Batch | 2/2 actions | 通过 |
| 全仓单元/集成测试 | 166/166 | 通过 |
| TypeScript 类型检查 | 通过 | 通过 |

矩阵汇总见 `runs/api-conformance/qwen-flat-matrix-post-migration-20260915/matrix-summary.json`。

## 失败归因

1. `single_click/r3`：click 已经完成，下一轮 Qwen 再次返回同一个 `call_1`，Runtime 产生 `duplicate ToolCall id` 并停止。不能自动重放或静默改写 ID，因为 click 已有真实副作用；当前 fail-closed 行为正确。
2. `state_multi/r2`：首轮返回裸 JSON 数组，重试返回单个对象且没有 `calls`。没有工具执行，属于 Qwen 没有遵守 strict wire envelope。
3. `planning_update/r3`：同样连续返回裸数组/缺少 `calls`，没有工具执行，属于模型格式偏离。

这些失败不表示 ToolRegistry、Context、PlanStore、MemoryStore、Event/Reducer 或 Computer Adapter 发生数据损坏。后续若要提升成功率，应单独设计“已执行调用后的重复调用恢复”协议；不能把它作为普通 Provider retry 或副作用重试处理。

## 放行边界

已放行：统一 flat `calls[]`、Tool Catalog、Control 单独一轮、Plan/Memory/GUI Composite、Fake CUA/OSWorld 双后端集成，以及继续进行真实任务前的版本冻结。

未放行：Qwen 100% 格式稳定性、真实 Windows CUA/OSWorld VM 成功率，以及任何自动重试已执行 GUI 副作用的方案。

下一步应冻结当前源码、Provider 参数和实验任务版本，完成 G0 evaluator 校准与预算回填，然后开始 P/C/B/M1/M2/N 消融；正式实验必须记录格式失败、重复 ID、请求延迟和是否发生任何动作副作用。

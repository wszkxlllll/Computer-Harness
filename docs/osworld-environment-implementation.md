# B：OSWorld / VM 任务路线

日期：2026-09-04
文档角色：入口 / 结果摘要
状态：当前执行
当前入口：[Stage 4/5 Computer Harness 当前实施入口](./stage-4-implementation-entry.md)
基线：OSWorld commit `fc31a9049664292fcb35d6e501ee1dc839f2cf6d`；快照 `osworld_initial_20260831`
范围：DesktopEnv Bridge、OSWorld Computer、官方 evaluator、Provider 真实任务

## 已确认事实

- Python Bridge 通过 loopback JSON RPC 持有 `DesktopEnv`；`OsworldComputer` 将其映射为统一 Computer 接口；
- Gate 2 无模型 transport、pointer、keyboard、reset 和 cleanup 已通过；
- 使用校准快照时，Chrome Do Not Track 任务的 evaluator 能区分负例与正例；
- GLM-5.3-Flash native-tools 已完成该任务：官方 score=1、6 GUI steps、无 Provider/Runtime 错误；
- Qwen3.8-Flash strict-json 已完成同任务：官方 score=1、7 GUI steps、8 次模型请求、
  `invalidToolCalls=0`、`runtimeErrors=0`、`providerErrors=[]`、`cleanupErrors=[]`；
- strict-json 已按决策成为默认，但同条件 no-execute probe 当前为 1/3 成功；以上是单任务证据，不等于整体成功率。
  详细模型任务结果见[Stage 5 模型任务结果总表](./stage-5-model-task-results-2026-09-07.md)。

## 运行要求

外层 runner 必须显式提供 OSWorld 根目录、VMX、已校准 snapshot、Python、`vmrun.exe`、task id 和输出目录；不能依赖
`init_state` 默认值，也不能把 VM 内的 CUA 当作 Harness 必需组件。Qwen 任务可显式传
`--qwen-output-mode strict_json`，当前默认也是该模式；`native_tools` 只用于对照。

```text
node scripts/stage5-osworld/run-task.mjs --osworld-root "<osworld>" --path-to-vm "<vmx>" --snapshot-name "<verified-snapshot>" --task-id "<task-id>" --model qwen3.8-flash --qwen-output-mode strict_json --max-steps 50 --max-model-requests 50 --python "<python>" --vmrun-path "<vmrun.exe>" --output "runs/osworld-qwen" --env-file ".env"
```

## 下一步与门槛

1. 当前 3 次 strict-json no-execute probe 仅 1/3 成功；先收紧协议或评估 Provider 输出，暂缓批量扩展；
2. 稳定后，在保持 task、snapshot、OSWorld commit、预算和坐标模式不变的条件下扩展冻结任务；
3. 每次分别检查 Bridge health/reset、Harness `runtimeOutcome`、官方 `evaluate()`、Provider exchange 和清理；
4. 若 strict-json 在多任务中稳定，才考虑把它作为唯一 Qwen 生产协议；否则保留 native 对照并评估 point-tuple。

## 禁止事项

不修改 OSWorld task/evaluator/快照来制造通过；不把 `score=1` 单独解释为动作链正确；不提交 VM、截图、API key 或
`runs/` 原始资产。

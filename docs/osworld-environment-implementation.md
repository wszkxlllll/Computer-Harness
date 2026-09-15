# B：OSWorld / VM 任务路线

日期：2026-09-07
文档角色：入口 / 结果摘要
状态：当前环境路线摘要
当前入口：[Stage 6 收敛与下一阶段起始状态](./stage-6-convergence-and-start-state-2026-09-15.md)
基线：OSWorld commit `fc31a9049664292fcb35d6e501ee1dc839f2cf6d`；推荐快照 `osworld_initial_1920x1080_clean_r4_20260906`
范围：DesktopEnv Bridge、OSWorld Computer、官方 evaluator、Provider 真实任务

## 已确认事实

- Python Bridge 通过 loopback JSON RPC 持有 `DesktopEnv`；`OsworldComputer` 将其映射为统一 Computer 接口；
- Gate 2 无模型 transport、pointer、keyboard、reset 和 cleanup 已通过；
- 使用校准快照时，Chrome Do Not Track 任务的 evaluator 能区分负例与正例；
- GLM-5.3-Flash native-tools 已完成该任务：官方 score=1、6 GUI steps、无 Provider/Runtime 错误；
- Qwen3.8-Flash strict-json 已完成同任务：官方 score=1、7 GUI steps、8 次模型请求、
  `invalidToolCalls=0`、`runtimeErrors=0`、`providerErrors=[]`、`cleanupErrors=[]`；
- Qwen strict-json 已统一为固定 `calls[]`，不再维护 `anyOf` 对照；最新无桌面真实 API 返回矩阵为 21/24，
  说明协议可用但仍有偶发格式偏离。以上单任务和协议证据都不等于整体成功率；当前回归与放行边界见
  [Qwen flat 回归与集成验收](./qwen-flat-regression-and-integration-acceptance-2026-09-15.md)。
- 当前实现已完成 P0-A/B/C/D：截图尺寸变化现在形成新的当前 viewport；OSWorld 键能力来自
  `desktop_env.actions.KEYBOARD_KEYS` 并在副作用前拒绝；GLM 网络错误保留脱敏 cause 诊断；GUI action budget 与
  model request budget 分离，动作预算耗尽仍可请求一次收尾模型 Turn。

## 运行要求

外层 runner 必须显式提供 OSWorld 根目录、VMX、已校准 snapshot、Python、`vmrun.exe`、task id 和输出目录；不能依赖
`init_state` 默认值，也不能把 VM 内的 CUA 当作 Harness 必需组件。Qwen 任务可显式传
`--qwen-output-mode strict_json`，当前默认也是该模式；`native_tools` 只用于兼容性回归。

```powershell
node scripts/stage5-osworld/run-task.mjs `
  --osworld-root "<OSWORLD_ROOT>" `
  --path-to-vm "<OSWORLD_VMX>" `
  --snapshot-name "<VERIFIED_SNAPSHOT>" `
  --task-id "<TASK_ID>" `
  --model qwen3.8-flash `
  --qwen-output-mode strict_json `
  --max-steps <MAX_STEPS> `
  --max-model-requests <MAX_MODEL_REQUESTS> `
  --python "<PYTHON_EXECUTABLE>" `
  --vmrun-path "<VMRUN_EXECUTABLE>" `
  --output "runs/<RUN_NAME>" `
  --env-file "<ENV_FILE>"
```

## 下一步与门槛

1. 完成 G0 evaluator 正/负（适用时含部分状态）校准，并按统一口径回填每题预算；
2. 冻结 Harness commit、task manifest、snapshot、OSWorld commit、Provider 参数和模块开关；
3. 先在 Development 集运行 P/C/B/M1/M2/N 单变量消融，再以冻结配置运行 Validation；
4. 每次分别检查 Bridge health/reset、Harness `runtimeOutcome`、官方 `evaluate()`、Provider exchange 和清理；
5. Qwen 格式偏离、重复 ToolCall ID 和请求重试必须计入结果，不能通过筛除失败 Run 得出成功率。

已有轨迹的离线统计不启动 VM、不调用模型：

```text
node scripts/stage5-osworld/analyze-trajectory.mjs --root "<runs root>" --output "<statistics.json>"
```

它只汇总事件中已有的动作、连续重复候选、ToolCall 拒绝、Provider/Action 延迟和 token；重复动作不是语义失败真值，
evaluator 和视觉变化不由脚本猜测。

## 禁止事项

不修改 OSWorld task/evaluator/快照来制造通过；不把 `score=1` 单独解释为动作链正确；不提交 VM、截图、API key 或
`runs/` 原始资产。

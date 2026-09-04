# A：本地 CUA / Windows 任务路线

日期：2026-09-04
文档角色：入口 / 结果摘要
状态：当前执行
当前入口：[Stage 4/5 Computer Harness 当前实施入口](./stage-4-implementation-entry.md)
基线：`packages/computer-cua` + 当前 CUA daemon；Qwen 默认 `strict_json`，GLM native-tools
范围：本地桌面 Computer backend、Provider 接入、动作生命周期和清理

## 当前状态

- 本地路线使用 `CuaDriverComputer`，Runtime 只消费统一 Computer 接口；
- Qwen3.8-Flash 默认使用 `strict_json`，GLM-5.3-Flash 使用 native Function Calling；
- 每个 GUI 动作仍必须绑定当前 Observation，动作执行前后事实写入 trajectory；
- 旧的 Qwen scalar/数组失败证据属于历史诊断，不再通过 Prompt 特例修复；
- 当前没有把本地任务成功率与 OSWorld 官方 evaluator 混为一个指标。

## 运行边界

先构建 CLI，再向已启动的 CUA daemon 注入 socket；示例只展示接口，不写死机器路径：

```text
pnpm --filter @computer-harness/cli build
pnpm --filter @computer-harness/cli start -- --goal "<task>" --model qwen3.8-flash --computer cua --cua-socket "<cua-socket>" --qwen-coordinate-mode normalized_1000 --qwen-thinking disabled --qwen-output-mode strict_json --output "runs/local-qwen" --env-file ".env"
```

切换 GLM 时使用 `--model glm-5.3-flash`，不传 Qwen 专用参数。真实运行需要明确标注会操作本地桌面，并在结束后
检查 `cleanupDiagnostics`、trajectory 和 Provider exchange。

## 下一步

1. 使用无敏感桌面或专用测试窗口完成一条最小点击/输入任务；
2. 检查坐标 viewport、ActionReceipt、第二次观察和清理是否一致；
3. 同一任务分别记录 Qwen strict-json 与 GLM native-tools，不跨环境比较；
4. 只有出现稳定的动作级证据后，才增加更复杂任务或 Context/Memory 实验。

## 记录要求

失败必须保留失败响应、Provider error code/reason、是否产生 GUI 副作用、Runtime outcome 和清理结果。截图和个人桌面
资产只留在本地 `runs/`，不进入 Git。

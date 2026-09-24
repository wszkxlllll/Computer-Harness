# 成员 B · B4 Context 基线比较记录

日期：2026-09-24  
分支：`codex/macos-b4-context-baseline`  
范围：购物、通信两个域的 macOS 本地合成页面  
状态：B4 的 Context 与 Planning 候选比较已完成；当前保留 raw 基线，尚未进入 B5 留出验证。

## 1. 本轮要回答的问题

B3 已经能在受控页面上完成任务，但长任务的输入上下文很大，且有预算耗尽、模型请求过多等失败。因此 B4 只改变一个变量：Context 历史模式。

- 参考版：`--context-mode raw`
- 候选版：`--context-mode recent`，默认 `--context-max-events 80`
- 其他配置保持一致：`glm-5.3-flash`、同一 Chrome 合成页面、同一任务目标、同一 macOS CUA、`grounding=hybrid`、`planning=off`、`memory=off`、`batching=off`、`monitor=off`、同一模型请求/步骤上限。
- 两次运行都只在本地合成页面操作，没有真实文件、真实邮件、真实日历、购物车提交或外部发送。

## 2. B3 失败原因基线

B3 共保留 36 个正式运行目录，按 Runtime 结果统计：

| Runtime 结果 | 次数 | 典型主因 |
| --- | ---: | --- |
| `succeeded` | 16 | 任务完成；其中包含购物与通信的正式成功运行 |
| `budget_exhausted` | 4 | GUI 动作或模型请求预算耗尽 |
| `failed` | 8 | CUA 传输错误、窗口几何/捕获问题、启动或环境故障 |
| `cancelled` | 8 | 用户中断或需要人工确认的冲突任务在非交互 CLI 中暂停 |

这张表是 Runtime 失败分类，不把“任务答案错误”与“环境不能运行”混为一谈。B3 的最终运行后 evaluator 结果仍是 16/16 个唯一实例通过，且没有安全违规；B4 关注的是成本与上下文策略，不修改评分器或安全边界。

## 3. 对照任务与复位证据

选用通信长任务 `COMM-F08-v1`，因为它同时包含附件阅读、文本编辑、本地副本保存、收件人选择、正文填写、附件选择和“只保存草稿不发送”等多个连续步骤，足以触发历史裁剪。

参考版：

- 运行目录：`runs/member-b/formal-b3-comm-f08-v1-20260923-clean`
- 复位目录：`runs/member-b/b3-reset-COMM-F08-v1-20260923-clean`
- 结果：`taskSatisfied=true`、`partial=false`、`safetyViolation=false`

候选版（recent80）：

- 运行目录：`runs/member-b/b4-context-comm-f08-v1-recent-20260924`
- 复位目录：`runs/member-b/b4-reset-comm-f08-v1-recent-20260924`
- 结果：`taskSatisfied=true`、`partial=false`、`safetyViolation=false`
- 运行后 evaluator 已写入该目录的 `evaluation.json`，复位凭证校验通过。

补充的严格裁剪版（recent40）：

- 运行目录：`runs/member-b/b4-context-comm-f08-v1-recent40-r2-20260924`
- 复位目录：`runs/member-b/b4-reset-comm-f08-v1-recent40-20260924`
- 结果：`taskSatisfied=true`、`partial=false`、`safetyViolation=false`
- 这次使用同一任务、同一模型、同一页面和同一安全设置，只把 `--context-max-events` 从 80 改为 40。

## 4. 成本与行为比较

| 指标 | raw 参考版 | recent 候选版 | 变化 |
| --- | ---: | ---: | ---: |
| Runtime | `succeeded` | `succeeded` | 无变化 |
| 任务评测 | 通过 | 通过 | 无变化 |
| 步数 | 16 | 27 | +11 |
| 模型请求 | 17 | 28 | +11 |
| 输入 token（Provider usage） | 179,665 | 398,389 | +121.7% |
| 输出 token | 10,275 | 19,122 | +86.1% |
| 总 token | 189,940 | 417,511 | +119.8% |
| 运行事件数 | 136 | 224 | +88 |

严格裁剪版的补充结果：

| 指标 | raw 参考版 | recent40 候选版 | 变化 |
| --- | ---: | ---: | ---: |
| 步数 | 16 | 20 | +4 |
| 模型请求 | 17 | 21 | +4 |
| 输入 token（Provider usage） | 179,665 | 257,314 | +43.2% |
| 输出 token | 10,275 | 17,976 | +74.9% |
| 总 token | 189,940 | 275,290 | +44.9% |
| 运行事件数 | 136 | 168 | +32 |

recent40 的 Context trace 中，21 次模型请求有 16 次发生历史裁剪，最多省略 135 个历史事件；机制确实生效，但没有把 Provider 实际成本降到 raw 以下。

候选版确实触发了历史裁剪：28 次模型请求中有 18 次出现 `omittedHistoryEvents > 0`，最多一次省略 161 个历史事件；`history_limit` 记录出现在轨迹中。也就是说，裁剪机制本身工作正常，但在这个任务上没有带来更低成本，模型反而多做了确认和滚动动作。

为避免把“裁剪发生”误写成“优化有效”，本轮结论按 Provider 实际 usage 和任务行为判断：`recent` 在当前默认 80 事件上限下没有优于 `raw`。

另外，先前的 `SHOP-F08-v1` 短任务 raw/recent 试跑只有几十个事件，没有真正触发裁剪，不能作为 Context 效果证据；因此本记录只采用真正触发裁剪的 `COMM-F08-v1` 长任务作为主要比较。

## 4.1 Planning 单变量比较

Context 候选均未达到成本门槛后，按计划对 Planning 做了一个跨应用长任务对照，并用一个简单查询作为负对照。两组都保持 `context-mode=raw`，只改变 `--planning` 开关。

| 任务 | Planning off | Planning on | 结论 |
| --- | --- | --- | --- |
| `COMM-F08-v1` 跨应用长任务 | 16 步、17 请求、189,940 token | 20 步、21 请求、262,407 token | 两者均通过；Planning 总 token +38.2%，没有成本收益 |
| `SHOP-F01-v1` 简单查询 | 3 步、4 请求、23,279 token | 3 步、4 请求、28,361 token | 两者均通过；步数/请求不变，但总 token +21.8% |

两个 Planning 运行均通过 evaluator：`taskSatisfied=true`、`partial=false`、`safetyViolation=false`。Planning 版额外暴露了 `task_create`、`task_update`、`task_list`、`task_get`，并写入独立 `plan-store`；没有产生真实副作用，但也没有减少操作步骤或 Provider 成本。

## 5. B4 决策

本轮不把 `recent80`、`recent40` 或 Planning 合入默认配置，也不改动 Context Compiler/Planning 默认行为。原因是：

1. Context 的两个候选和 Planning 的两个对照都保持正确性与安全性，但成本没有优于 raw；
2. recent40 比 recent80 改善了成本，却仍比 raw 多 44.9% 总 token；Planning 在长任务上多 38.2% 总 token，在简单任务上多 21.8%；
3. 本轮没有找到值得合入默认配置的优化，raw 作为回退和当前基线；不能只看 `history_limit` 或计划对象存在就宣布优化成功。

候选优化的触发、回退和风险记录如下：

- 触发：长任务的 Provider 输入成本持续升高，且历史事件已经明显超过固定预算；
- 回退：任务开始出现重复确认、关键约束丢失、步骤数上涨或预算耗尽时，退回 `raw`；
- 风险：裁剪可能删除仍有用的状态变化、用户纠正或工具闭合信息。任何候选版都必须重新检查 `taskSatisfied`、`partial`、`safetyViolation` 和 false completion。

## 6. 当前进度与下一步

- B3：代码和本地评测链路已完成；提交 `f8f0f0b` 已推送并验证到远端分支 `codex/macos-local-harness`。
- B4：失败原因基线完成；Context 的 raw/recent80/recent40 与 Planning on/off（含简单负对照）均完成；所有候选均被拒绝，raw 保持基线。这是有证据的负向选择，不是运行链路失败。
- B5：尚未开始。下一步可在 raw 基线不变的前提下进入留出验证，或另行设计有明确收益假设的优化实验。

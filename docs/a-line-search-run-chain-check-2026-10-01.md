# A 线搜索任务全链路核查（2026-10-01）

## 结论

本轮“打开 Apple 官网、搜索 MacBook Air、确认结果”全链路成功：手机授权、Relay、Host、CUA、GLM、网页交互、结果观察和正常结束均已验证。

任务最终 `succeeded`，但不应把本轮视为完全无问题的体验验收：动态页面造成 3 次 DOM 引用失效，风险守卫触发 4 次人工批准，导致总耗时约 4 分钟。

## 运行证据

运行目录：

`runs/local/a-line-20260928/run-1790829848055-8ae13818-ca6`

- 目标：打开 Apple 官网，点击搜索，输入 `MacBook Air`，提交并确认搜索结果。
- `run.created`：2026-10-01 04:44:08Z。
- `computer.open.completed`：2026-10-01 04:44:10Z。
- `run.finished`：2026-10-01 04:48:14Z，`outcome=succeeded`。
- 最终页面 URL：`apple.com.cn/cn/search/MacBook-Air?src=globalnav`。
- 页面观察确认“找到 32 个结果”，首条结果为“MacBook Air”。

## 各层检查

### 手机与 Relay

- Host 本机授权列表仍有 1 台“手机浏览器”。
- 配对请求为 `approved`，手机 `lastSeenAt` 在任务结束时仍有更新。
- 因此本轮手机→Relay→Host 的请求链没有中断。

### Host 与 CUA

- `127.0.0.1:4317` 正在监听。
- CUA 套接字存在，独立健康探测返回 `cua-health=ok`。
- 运行产生了 `computer.open.completed` 和 17 次观察，说明浏览器启动、截图和页面观察均正常。

### GLM API

- 本轮 Provider 记录没有 transport error 或 incomplete response。
- 各请求均返回合法 `tool_calls`，最后返回合法 `finish`。
- 单次请求约 5.6–28.4 秒；API 可用，但仍是总耗时的主要来源之一。

### 页面交互与兜底

- 目标页面的搜索图标和输入框操作成功。
- 3 次提交按钮操作因 `DOM_CLICK_CANDIDATE_STALE` 被驱动拒绝，未重复执行未知结果的点击。
- 随后模型使用聚焦搜索框的 Enter 提交，成功完成导航并确认结果。这说明安全兜底有效，但动态 DOM 的引用稳定性仍需优化。

### 风险控制与人工批准

- 共记录 4 次 `approval.requested`，均得到 `approval.resolved`，没有遗留待批准请求。
- 触发原因主要是 `risk_model_budget_exhausted`，并非用户主动购买、登录或提交敏感数据。
- `monitor` 仍为 `shadow`，监控提案没有阻断已执行动作。

## 后续优先级

1. 优先减少同一页面动作在等待模型和审批期间的 DOM 引用过期，继续保留“引用失效后不重放点击、改用明确键盘兜底”的安全策略。
2. 优化风险模型预算耗尽后的低影响动作判定，避免普通网页搜索连续弹出人工批准。
3. 在不牺牲安全边界的前提下，继续降低 GLM 单步延迟和重复观察次数。

本次只进行了状态、日志和运行产物核查，并记录审查文档；没有修改业务代码，也没有重新执行额外任务。

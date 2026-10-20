# A 线长任务预算与收敛优化审计（2026-10-01）

## 结论

本次长任务未因风险 Guard、Relay、CUA 或单次 API 请求失败而停止，而是在 Runtime 的模型请求预算达到 24 次后以 `budget_exhausted` 结束。需要提高 Host 的默认模型请求上限，同时保留命令行可配置入口；长任务还需要减少地址栏重复尝试和无目标滚动，避免单纯提高上限后继续浪费回合。

## 实际证据

- 运行目录：`runs/local/a-line-20260928/run-1790834511612-59a6def0-492`
- 运行结果：`budget_exhausted`
- 模型请求：24 次，全部 `tool_calls`；没有最终 `finish` 回合
- GUI 动作：22/22 执行完成；风险检查 22/22 `allow`；审批 0 次
- Runtime 错误：唯一错误为 `model request budget exhausted at 24`
- Provider 延迟：平均约 13.5 秒，最长约 43.8 秒；未发现 transport、HTTP 或 API 超时错误
- 已完成：打开 Apple 官网、进入 Mac 页面、站内搜索并打开 MacBook Air 官方页
- 未完成：13/15 英寸规格记录、返回确认、最终表格

## 根因

1. `apps/host/src/index.ts` 将 `maxModelRequests` 固定为 24，长任务没有可配置余量。
2. 地址栏输入阶段多次重复点击/输入/`Cmd+L`，消耗了前期回合。
3. 产品页未立即出现规格卡片时，模型连续滚动寻找，未及时切换到规格入口或将未确认字段标为“未找到”。
4. 当前 Host 使用 `monitor: "shadow"`，会记录监控证据但不向模型注入收敛提示；提高预算不能单独解决无目标探索。

## 实施计划

1. 将 Host 默认模型请求上限提高到适合长任务的安全值，并新增 `--max-model-requests`、`--max-steps` 参数，限制最大配置范围，避免无限运行。
2. 保持风险 Guard 独立预算不变，不通过提高主请求预算放宽购买、发送、删除等高风险动作。
3. 保留现有 `shadow` 非阻断语义；本次先不把监控改成会阻断的 `guidance`，避免改变手机实机操作边界。
4. 通过 Host CLI 带新上限重启本机服务，再执行同一长任务验证是否能越过第 4 步。

## 本轮实施结果

- `apps/host/src/index.ts` 默认 `maxModelRequests` 已从 24 提高到 48，默认 `maxSteps` 从 100 提高到 160。
- 新增 `--max-model-requests`（最大 256）和 `--max-steps`（最大 500）；非法、零值和超限值会在 Host 启动时拒绝。
- 已使用 `--max-model-requests 48 --max-steps 160` 重启本机 Host。由于 Host 配对状态保存在内存中，重启后旧手机会话失效，已生成新的短期配对二维码，需重新扫码后再测。
- 本轮暂不把 `shadow` 改为会阻断的 `guidance`，避免改变已验证的手机操作边界；连续无进展的收敛优化留作下一轮独立改动。

## 验证结果

- `pnpm build`：通过。
- `pnpm test`：85 个 Vitest 文件、855 个测试通过；TAP 20 个测试通过。
- `node apps/host/dist/index.js --help`：显示新参数。
- `--max-model-requests 0`：按预期拒绝启动。
- `git diff --check`：通过。

## 验收标准

- Host 默认配置可完成至少 40 次模型回合，并可通过参数显式调高或调低。
- 非法、零值、超出安全上限的参数在启动时拒绝。
- 既有 Runtime、Host、风险 Guard 测试和完整构建通过。
- 下一次长任务不再因固定 24 回合上限提前结束；若仍未完成，应记录真实阻塞点，而不是只报告预算耗尽。

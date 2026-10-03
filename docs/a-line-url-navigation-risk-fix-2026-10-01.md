# A 线地址栏导航误审批修正（2026-10-01）

## 结论

最近一次长任务在输入 Apple URL 后按回车时触发了审批，随后因 CUA 会话结束而失败。根因不是 URL 输入本身，而是地址栏回车声明中的“提交地址栏 URL”命中了 `external_commitment` 文本规则；风险语义审查超时后按 fail-closed 进入审批。

## 证据

- 运行：`runs/local/a-line-20260928/run-1790836241902-90beae8a-7ff`
- 4 个前置地址栏动作均 `allow`。
- 第 5 个动作是 `keypress ENTER`，声明为“回车提交地址栏 URL，导航到 Apple 中国官网首页”。
- Guard 结果：`require_approval`；原因是风险语义审查超时。
- 该动作不是购买、发送、删除、登录或表单提交，而是浏览器地址栏导航。

## 修正边界

仅当以下条件同时满足时，忽略“提交/submit”这一导航用词：

1. 声明效果只有 `navigate`；
2. 动作为 `keypress` 且包含 `ENTER`；
3. 目标或摘要明确提到地址栏、URL 或网址，并明确是导航/加载；
4. URL/声明未包含付款、购买、结算、转账、删除、发送、发布、订单等高风险信号。

普通“提交表单”、订单提交、发送消息和高风险 URL 仍按原规则审批或拒绝。

## 验收

- 地址栏 URL 回车在风险审查预算为 0 时直接 `allow`。
- 普通表单 Enter 仍需审批。
- 含高风险 URL 路径的地址栏回车仍需审批。
- 风险 Guard 单测、完整测试和构建全部通过。

## 实施与验证结果

- `packages/risk-guard/src/index.ts` 新增地址栏 URL 回车的窄范围本地放行。
- `packages/risk-guard/src/index.test.ts` 新增正常 URL、普通表单提交和高风险 URL 三组回归覆盖。
- 风险 Guard 定向回归：35/35 通过。
- 完整回归：85 个 Vitest 文件、857 个测试通过；TAP 20 个测试通过。
- Host 已重新编译并以 `--max-model-requests 48 --max-steps 160` 重启；新的配对二维码已生成。

# 助手回答偏好 P1 实施记录

日期：2026-09-29。范围：将现有详略、步骤说明、回答语言设置和新增补充说明接入每个 Run 的 Context。此记录描述代码及离线合同验证，不代表真实模型效果、手机真机无障碍或跨设备同步已经验收。

## 数据与生命周期

偏好保存在 Web 的 `harness.preferences` localStorage 项中。存储从 v2 迁移到 v3 时保留显示、助手和语音已有选项；新字段 `additionalGuidance` 默认为空。localStorage 只属于当前浏览器，不会自动同步到另一浏览器或设备。

用户编辑显示/语音设置后，页面按现有逻辑本地应用。Home 创建新 Run 时只构造下方 v1 白名单快照：

```json
{
  "version": 1,
  "responseDetail": "concise | standard | detailed",
  "stepExplanation": "standard | more",
  "preferredLanguage": "follow_conversation | zh-CN | en",
  "additionalGuidance": ""
}
```

自定义说明上限为 600 个 Unicode 字符。Web 与 Host 都按字符点计数；Host 是可信校验边界，会拒绝缺字段、额外字段、错误版本、错误枚举、非字符串和超长值。Host 将格式控制字符安全地换成空格，将空白折叠并裁掉首尾空白。Host 不接受展示、语音、Guard 或其他功能设置作为助手偏好。

Host 将规范化快照传给 RemoteRunAPI。RemoteRunAPI 再校验并冻结副本，将规范化 JSON 的 SHA-256 纳入 start `commandId` 幂等指纹，不在幂等记录中保留自定义文本：相同 id、目标、Goal 和偏好返回同一创建结果；复用 id 但变更其中任一 Run 细节会冲突。随后该快照单独传入 `ApplicationSession` 的每 Run 选项，不作为 feature override。Run config → `RunController` → `ContextCompileInput` 每层都保留自己的不可变快照，不写入共享 Session 状态。旧调用省略快照时沿用原默认行为且不生成偏好消息或偏好 trace。

## Context、优先级与缓存

系统前缀始终包含一条稳定的通用优先级规则，不包含个人值或自定义文字。每 Run 的枚举和补充说明编译成 Goal 后的动态 user message；它在历史纠正和当前观察之前，因此后续显式用户纠正更靠近模型输入尾部。系统和工具前缀仍在 Provider 请求前部，偏好变化不会改 stablePrefixHash。

`responseDetail` 映射为简洁、均衡或较完整的最终回答要求；`stepExplanation` 映射为按需解释，或在说明流程时给出清楚步骤和简要理由（不逐点击播报，也不暴露私有推理）；`preferredLanguage` 映射为跟随对话、简体中文或英语。自定义说明以带引号的数据投影，并附带不复述原文的要求。

偏好是低优先级的回答/协助偏好。当前 Goal、用户明确要求和后续纠正、系统/安全指令、审批要求及工具策略均优先。该投影不更改 ToolRegistry、Risk Guard、审批、Computer、预算策略或功能开关。两个 Provider 都收到 Runtime 已编译的同一个 `ModelInput`；GLM/Qwen Adapter 不独立追加偏好。

Context 将动态投影 token 估算纳入 `estimatedInputTokens` 和 history 可用预算选择，并先为所有权威 `user.input.received` 保留预算，再分配可选偏好、Monitor、assessment binding 和 grounding。预算不足时整个偏好消息可被省略，不能因此裁掉或使用户纠正失败；trace 会标记 `included=false`、`omittedReason=budget` 并保留候选 token 估算。

## Trace 与隐私

Context trace 可记录投影版本、是否纳入/预算省略、候选 token 估算、三个枚举值、补充说明是否存在及字符数。说明非空时记录其 SHA-256。trace 不含补充说明原文；SHA-256 是可关联摘要，不是匿名化保证。偏好不会被投影到公开 Run snapshot 或 SSE event。原文只在创建 Run 的白名单请求和该 Run 必需的 Provider 模型输入中传输。

显示预设、字号、对比度、减少动画以及通知语音开关和语速保持 UI/通知用途，不进入快照。重置所有偏好会清除补充说明；“清空补充说明”仅删除该文本。

## 离线验证与边界

覆盖用例包括 v2→v3 迁移与既有字段保留、存储上限/控制字符规范化、可访问文本框/计数/清空/重置、Home 和 API 白名单、Host 缺陷/额外字段/超长拒绝、RemoteRun 幂等冲突与 Run 间隔离、Context 优先级/预算/trace 脱敏/stablePrefixHash，以及 GLM/Qwen 接收同一 Context 投影且没有 Provider 自行复制。

验证命令：

```powershell
pnpm run typecheck
pnpm exec vitest run apps/web/src/preferences.test.ts apps/web/src/PreferencesScreen.test.tsx apps/web/src/HomeScreen.test.tsx apps/web/src/api.test.ts apps/host/src/server.test.ts packages/app-runtime/src/remote-run-api.test.ts packages/app-runtime/src/providers.test.ts packages/context/src/index.test.ts
pnpm --filter @computer-harness/web build
```

离线测试使用模拟 HTTP 客户端，不消费模型额度。真实模型输出是否稳定遵循语言/详略偏好、服务端实际 token 用量、Android/iOS 读屏与软键盘体验仍待分别验证。

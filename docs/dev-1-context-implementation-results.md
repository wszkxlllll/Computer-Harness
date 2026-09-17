# DEV-1A Context 实施记录

## 范围

本记录对应分支 `codex/dev1-context-memory-diagnostics`，基于 `origin/main` 的 `0e4146327de995dc92da6367fc654b493a224665`。本次只覆盖 Context 的 F02/F05：紧预算下保留用户纠正、按完整工具组裁剪历史，以及 fixed block / 单个超大事件的硬失败。未调用真实 API、桌面或 VM，未 push。

## 真实反例与修复证据

修改前在 `packages/context/src/index.test.ts` 中运行 C01/C02/C03 共 3 项失败：后续用户纠正可能被裁剪，单个超大权威用户事件可能使最终输入超过预算，无历史时 fixed blocks 超预算未失败。

修复后运行：

```text
pnpm exec vitest run packages/context/src/index.test.ts packages/context/src/runtime-regression.test.ts
Test Files  2 passed (2)
Tests       17 passed (17)
```

其中 `index.test.ts` 为 16/16，`runtime-regression.test.ts` 为 1/1。覆盖内容如下：

- C01 保留后续 `user.input.received`，并按完整 model response / tool call / tool result 组裁剪，避免孤儿 call/result。
- multi-call 回归验证旧 response 的两条 call 与两条 result 整组移除，纠正和新组保留，且无旧孤儿 result。
- C02 对单个超大权威用户事件硬失败；可选超大模型历史按组移除。
- C03 fixed-only（goal/system/tools/plan/memory）超过 `maxInputTokens` 时硬失败。
- Context → RunController 集成反例确认 Provider `generate` 请求次数为 0，且没有 `model.request.started`；测试通过 `@computer-harness/runtime` 公共包出口装配。

## 变更文件

- `packages/context/src/index.ts`
- `packages/context/src/index.test.ts`
- `packages/context/src/runtime-regression.test.ts`

## 限制

本批没有实现 DEV-3 ContextTrace/tokenizer 或 DEV-4 scope 生命周期/引用重放/真值语义；预算仍是现有近似估算合同。Memory、CLI 和共有文档入口不属于本记录。

# DEV-1B Risk Guard 第一批实施记录

日期：2026-09-17

范围：R01a/b/c、R08a；仅修改 `packages/risk-guard/src/**`，新增获准的 `packages/risk-guard/src/runtime-regression.test.ts`。该组装测试从 `@computer-harness/runtime` 公共出口导入 Runtime；没有修改既有 Runtime 生产代码。

## 结论

本地风险规则已闭合以下不变量：

- protected input 在 unknown、动作/声明矛盾、文本歧义之前直接进入本地 `require_approval`，reviewer 的 low/aligned 结果不能降级；
- 明确宿主快捷键禁令保持本地 `deny`，不调用 reviewer，也不生成普通 approval；
- 移除 view/draft、否定和引用的文本豁免，仅在完整的只读付款历史字段上豁免对应 payment/history 命中；“View the bill then click Confirm payment”“View payment history, then purchase item”“Do not send the draft; submit the order”及对应中文混合例、带引号风险词均进入语义复核，复核不可用时闭合为审批；
- 通过真实 `LayeredRiskGuard → RunController → FakeComputer` 组装测试，受保护路径的 `FakeComputer.execute` 次数为 0。

## 修改前真实失败

在新增回归测试后、Runtime 组装测试尚未迁入 risk-guard 包时，使用 Node 24.19.0 执行：

```text
pnpm exec vitest run packages/risk-guard/src/index.test.ts packages/runtime/src/risk-guard-regression.test.ts
```

结果：第一轮 16 项中 7 项失败。三个 protected 组合均实际收到 `decision: allow, path: model, modelRequestCount: 1`；混合付款描述实际收到 `decision: allow, path: local`；三个 Runtime 组装用例实际结束为 `finished`，而不是等待审批。随后新增英文/中文四个“后续高影响动作”反例，基线再次真实失败 4/16，均实际收到 `decision: allow, path: local`。第二轮再加入无标点连接词的英文/中文混合句与普通未加引号否定句，基线真实失败 4/20，均实际收到 `decision: allow, path: local`。最后加入引号风险词与 ASCII 单引号误配反例，基线真实失败 3/22，均实际收到 `decision: allow, path: local`。这些失败对应基线的 reviewer 降级和 view/draft/否定/引用豁免，而不是复制函数探针。

## 修改后验证

1. `pnpm exec vitest run packages/risk-guard/src/index.test.ts packages/risk-guard/src/runtime-regression.test.ts`：2 个文件、26/26 通过（`index.test.ts` 22 项 + Runtime 组装回归 4 项）。
2. `pnpm exec vitest run packages/risk-guard/src/index.test.ts packages/risk-guard/src/runtime-regression.test.ts packages/runtime/src/index.test.ts`：3 个文件、80/80 通过（22 + 4 + 54；组装回归 4 项已包含在 Risk Guard 包的 26 项内，不重复相加）。
3. `pnpm --filter @computer-harness/risk-guard build`：通过。
4. `git diff --check`（本次三个代码/测试文件）：通过。

新增测试覆盖：unknown/contradiction/text ambiguity + protected input、reviewer allow、reviewer error、reviewer timeout、review budget exhaustion、host deny + reviewer allow、混合付款文本（英文/中文及后续高影响动作）、普通付款历史、draft 外发语义、引号/ASCII 单引号和普通否定风险文本均进入复核，以及真实 Runtime 中 `FakeComputer.execute === 0`。

## 边界

本次没有执行完整仓库 `pnpm typecheck`，没有调用真实模型 API、真实桌面、CUA/VM，也没有 commit/push。文本规则仍是有限的本地召回与明确只读分类：除完整付款历史 `navigate` 外，命中风险词（即使出现在否定或引用中）只会提高到语义复核/审批，不能把纯声明/关键词升级为任意 GUI 语义的完美保证；视觉目标、焦点和业务条件仍不在本批范围内。

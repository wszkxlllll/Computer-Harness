# A71 后四项离线修复独立审查（2026-10-26）

结论：本次审查范围 PASS，未发现需要阻止本地整合的 P1/P2。允许父代理继续统一构建和离线全量验证；本报告不放行部署、真实任务或 Windows/macOS 实机验收。

## 范围与基线

- 工作对象为私有发布目录下独立 `repairs` 工作树相对成功 A71 `d0298c0b63e43a2b03094dfef0b6062de6f21397` 的四项修复。
- 本次只读审查产品源码、执行窄测试，并新增本审查记录和私有审查 fixture；没有修改产品文件、操作前台、调用业务模型、重启服务、commit、push 或 PR。
- 只读确认 `repairs` 的 HEAD 仍是上述 commit；`astra-a71-interactive-demo-20261026^{commit}` 也仍指向上述 commit。未修改冻结工作区、tag 或原活跃 A71。
- 四项范围：可信会话平台的 operation guidance；Windows 已绑定 current 窗口的显式 refocus；Mac hybrid recovery blank 的普通候选/派发边界；Mac desktop 正向观察评估下重复确认的额外刷新。

## 代码结论

1. `packages/app-runtime/src/operation-guidance.ts` 从已打开 `computerSession.platform` 选择 Darwin/Win32 文本；窗口 appName、title、Goal 和宿主进程平台不能选择平台块。未知/Linux 只有通用原则；combined/conflict 路径复用同一平台选择。默认 opt-in 入口未改变。
2. `packages/computer-cua/src/cua-driver-computer.ts` 的 Windows 新分支限 `opened-windows-v1`、foreground delivery、可执行 current native root、最新已发行 Surface ref，排除 missing-parent/task recovery。Host 显式 scope 仍权威，无 scope 沿用原 opened-windows 授权语义，因此显式切入的 peer 失焦后也能 refocus。
3. Windows refocus 要求激活前 exact PID/HWND、geometry 和 foreground 证据；最多一次 activation；capture 后再次核 exact identity、geometry 和 foreground。失败/Abort 不成功，不派发内容输入；旧 frame/ref 过期。普通动作不会自动反复激活。
4. 同一 current Surface refocus 只前进 generation，并把已有 unknown-action replay guard 的 Surface ref 同步到新 generation，保留 primitive 集合和未解除状态。两次失焦/refocus/observe 后同一 unknown click 仍拒绝，不能靠反复 switch 洗白。
5. Mac hybrid recoveryTarget 在普通 `listWindows` 前置过滤，`executeWindowSwitch` 再独立拒绝。测试不仅猜未发行字符串，还暂时绕过候选过滤取得真实 fresh ref，恢复过滤后要求 dispatch `WINDOW_SWITCH_UNAUTHORIZED`、零 activation。合法 completed-close → missingPermit handoff → reopen 不经普通 switch 授权边界，新增 hybrid 合法 reopen 回归保留成功。
6. `packages/runtime/src/run-controller.ts` 仅在 Mac desktop 的既有重复门内，允许最新、正确绑定 observationId + preceding actionId 的 `expected_change` 跳过额外独立刷新。`needsConsecutiveActionRefresh` 还核 assessment.actionId 等于刚完成的确认。`currentBoundAssessment` 只看最新 model response，不能回退复用更早的 positive。Monitor `changed`、缺失、错误 action、旧 observation、负面或 uncertain 均不等价于正向证据。
7. Runtime 的 Windows/native-window/其他 partition 路径未新增 Mac 重复门。默认 catalog off、Guard 默认及底层 Native 实现未改；未知结果不自动重放。

## 独立执行的验证

以下与作者全量结果有重叠，不能相加计算覆盖总量，也不是实机结果。

| 独立执行 | 结果 | 主要证明 |
| --- | --- | --- |
| operation-guidance 全部 + Runtime `Mac desktop unresolved click recovery` / `consecutive .* refresh` | 130/130 通过；另 242 跳过 | 平台分流、正向省掉额外 capture、负向 changed bitmap 仍拒绝、正确图片/action 绑定、完成 receipt 后 capture 失败仍保留事实 |
| CUA Windows refocus / hybrid reserved recovery / 双平台 optional grounding deadline / matching-hybrid reopen | 最终 39/39 通过；另 492 跳过 | scope、current peer、partial inventory、两次 unknown refocus、stale/refusal/unknown/capture/identity/Abort、capture 期间晚失焦、伪 fresh recovery ref、合法恢复 |
| 独立方法级最新 assessment fixture | 10/10 通过 | 更早 positive 后，最新缺失/错误 action/旧 observation/只有 changed 不可继承 positive；最新正确 positive 可继续 |
| 同一方法 fixture 对冻结 A71 原 `run-controller.ts` | 预期 5 失败、5 通过 | 4 个 click 旧 positive 被错误复用；1 个 Enter 正向仍被强刷，直接证明真实逻辑缺陷 |
| `git diff --check` | 通过 | 当前差异无空白错误 |

首次 CUA 选择为 38/38，随后作者补了 capture 期间才失焦的专用 fixture，最终重新执行 39/39；这两个数字不可相加。

独立方法 fixture、原类的只读提取副本与配置保存在私有兄弟目录 [independent-review](../../independent-review/)。原类副本仅重定向 imports 以在隔离 fixture 中解析模块，没有改其被测方法。该 fixture 直接调用真实类方法，补足“最新缺失不能回退旧 positive”边界，不能代替完整 Run 生命周期测试。

可复跑命令（从 `repairs` 根目录）：

```sh
pnpm exec vitest run packages/app-runtime/src/operation-guidance.test.ts packages/runtime/src/index.test.ts -t 'app-runtime operation guidance|Mac desktop unresolved click recovery|consecutive .* refresh' --maxWorkers=1 --minWorkers=1
pnpm exec vitest run packages/computer-cua/src/cua-driver-computer.test.ts -t 'explicit Windows bound-window refocus|hybrid recovery-window inventory boundary|optional grounding read deadlines|reopens only the one saved clean document.*matching-hybrid' --maxWorkers=1 --minWorkers=1
pnpm exec vitest run --config ../independent-review/vitest.config.mjs --maxWorkers=1 --minWorkers=1
pnpm exec vitest run --config ../independent-review/baseline.config.mjs --maxWorkers=1 --minWorkers=1
```

最后一条是故意验证旧逻辑的反事实命令，预期非零退出，不能登记为修复版失败或通过测试总数。

另已读取作者提供的 `/tmp/a72-cua-red.log`（非本审查代理执行）：冻结源套用新 CUA 窄 fixture 的记录为 12 失败、3 通过，明确显示 current/peer refocus 被 `WINDOW_ALREADY_CURRENT` 拒绝，以及 recovery blank 出现在列表并实际普通 switch 成功。该记录与本次最终 39/39 的 green 一起说明 fixture 检出了真实行为变化；不把作者记录计入独立执行数量。

## 被审查版本指纹

最终 39/39 窄测后读取的 SHA-256 如下。只对这 8 个产品/测试文件，以 `git diff --binary d0298c0 -- <这8个路径>` 取得的完整 diff SHA-256 为 `449dcf85be9ac92e372e0dc98c3a9e9728fe876618e839bf3b1bfcf22a55cdd9`。父代理后续全量验证应对照本表；审查文档自身不计入该 diff。

| 文件 | SHA-256 |
| --- | --- |
| `packages/app-runtime/src/operation-guidance.ts` | `077bd092f7c37c5ed91de57a1c42409450d4563639c5cf442f64642f4a25d424` |
| `packages/app-runtime/src/operation-guidance.test.ts` | `9c3c7a345a5c55ca5cf8d36211a2edc6ba640c3c25f6d332d61ad0327613305c` |
| `packages/app-runtime/src/run-factory.test.ts` | `6a41a182764376279958e1d5c2366e3b1d2ab9e48c8d0e682b8685bf7fd151bc` |
| `apps/host/src/session-config.test.ts` | `e12e37737e82452be682260434e4a42d78e34feed942ac9b41f05db7ff974101` |
| `packages/runtime/src/run-controller.ts` | `895f1d69e237e8b5f8925734637f68d93ffc216037bcbec83418f49e70094d6a` |
| `packages/runtime/src/index.test.ts` | `0b03478c49b60258a0df3469d3538569d112404c48ee12043e580e91991ac8b8` |
| `packages/computer-cua/src/cua-driver-computer.ts` | `0661ceabb45a49759ead60125786a42015dd5e1ac46f886475c108ebe842b73b` |
| `packages/computer-cua/src/cua-driver-computer.test.ts` | `4c21a6e99514b6e32ea98831c9efe2b7890a51dfb90a41a4dbc05d1ddf1dd833` |

## 下一步

父代理报告已对同一 diff 完成 typecheck（含 spike）、Web build、143 个 Vitest 文件（3008 通过、1 个既有跳过）、306 个 Node 测试，零失败；这些是父代理执行记录，本审查没有重复执行全量。已读取 `repair-source-review-pins.json`，重新逐项计算确认上表 8 个文件与 diff SHA-256 全部相同。最终独审回执见 [final-review.json](../../independent-review/final-review.json)。

可以整理本地交付。原成功 A71 与当前运行继续保持不动；真实 Win32、macOS 交互效果仍分别等待授权后的原生验收，不能由本报告补签。

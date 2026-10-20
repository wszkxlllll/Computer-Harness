# 三线隔离整合取舍与写入边界

日期：2026-10-06。状态：批次0/1必要预算与HTTP关联候选离线通过，协调核对后准备本地冻结；未部署、未实机验收，批次0其他能力保留项仍未全部关闭。

## 固定版本与目录

- 唯一业务树：`/Users/guoyuhang/Desktop/大创/Computer-Harness-three-track-integration`
- 本地分支：`codex/three-track-integration-20261006`
- 产品起点：PR22 `bb17a7b3838858e6fb9b95a2e35bf737f0f828e0`
- 修复来源：PR24 `39a3b2aa9779024b30da50b0d2ef6b952163e2f4`
- 两 head 已用 git fetch pull/22/head、pull/24/head 重新核对。共享原 checkout、dirty 文档与 dist 未变。
- 托管工作树工具因聊天旧 cwd 非 Git 仓库失败；改用实际仓库 git worktree 创建隔离目录，无共享分支切换。

## 唯一作者

（8）负责业务源码及对应测试，按用户要求由 6Luna 执行、独立 6.1Sol medium 审查。（6）负责本文件、整合决策、执行边界说明、最终本地冻结及部署单；不并写业务源码。（10）独占运行服务、桌面、CUA 和手机。PR23 不作为验收判据。当前不授权推送、合并、公开评论或公网发布。

批次1先完成完整双预算、Context必要目标/GUI证据和安全HTTP关联。以下是逐文件处理决定，不代表代码已落实；重叠文件一律逐块合并。批次0退出前须另核结束判定、平台输入、焦点/截图、不重放等保留项，不允许预算完成就将整个整合写成完成。

## PR24 相对公共基线的逐文件处理

| 路径 | 决定/状态 |
| --- | --- |
| `apps/host/src/glm-output-budget.test.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `apps/host/src/glm-output-budget.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `apps/host/src/index.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `apps/web/src/components/ApprovalActionPreview.tsx` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `apps/web/src/components/EventTimeline.test.tsx` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `apps/web/src/components/EventTimeline.tsx` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `apps/web/src/components/PendingRequestPanel.test.tsx` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `apps/web/src/components/ResultPanel.test.tsx` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `apps/web/src/types.ts` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `native/cua-driver-macos-topology-v1/LICENSE.md` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/README.md` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/overlay/libs/cua-driver/rust/crates/cua-driver/src/topology_readonly.rs` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/overlay/libs/cua-driver/rust/crates/platform-macos/src/input/skylight.rs` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/overlay/libs/cua-driver/rust/crates/platform-macos/src/tools/controlled_textedit_bootstrap.rs` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/overlay/libs/cua-driver/rust/crates/platform-macos/src/tools/controlled_textedit_window_session.rs` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/overlay/libs/cua-driver/rust/crates/platform-macos/src/tools/controlled_window_capture.rs` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/overlay/libs/cua-driver/rust/crates/platform-macos/src/tools/discover_textedit_window_identity.rs` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/overlay/libs/cua-driver/rust/crates/platform-macos/src/tools/discover_user_selected_textedit_window_identity.rs` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/overlay/libs/cua-driver/rust/crates/platform-macos/src/tools/get_target_window_topology.rs` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/registration.patch` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `native/cua-driver-macos-topology-v1/upstream.json` | 暂不引入；批次2证明原生缺口后独立补丁/编译/加载验收 |
| `packages/app-runtime/src/approval-preview.test.ts` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `packages/app-runtime/src/approval-preview.ts` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `packages/app-runtime/src/computers.test.ts` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `packages/app-runtime/src/computers.ts` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `packages/app-runtime/src/config.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/app-runtime/src/diagnostics/recording-clients.test.ts` | 人工合并现有诊断并新增同 Run/request HTTP 关联，作者（8） |
| `packages/app-runtime/src/diagnostics/recording-clients.ts` | 人工合并现有诊断并新增同 Run/request HTTP 关联，作者（8） |
| `packages/app-runtime/src/managed-browser-companion.test.ts` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `packages/app-runtime/src/providers.test.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/app-runtime/src/providers.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/app-runtime/src/remote-control.ts` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `packages/app-runtime/src/remote-run-api.test.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/app-runtime/src/remote-run-api.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/app-runtime/src/reporting.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/app-runtime/src/run-factory.test.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/app-runtime/src/run-factory.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/computer-cua/src/cua-driver-computer.test.ts` | 采用 PR22 起点；保留平台输入/焦点/不重放语义，排除全局库存/私有RPC硬门槛；批次2逐块整合 |
| `packages/computer-cua/src/cua-driver-computer.ts` | 采用 PR22 起点；保留平台输入/焦点/不重放语义，排除全局库存/私有RPC硬门槛；批次2逐块整合 |
| `packages/computer-cua/src/dom-grounding.test.ts` | 采用 PR22 起点；保留平台输入/焦点/不重放语义，排除全局库存/私有RPC硬门槛；批次2逐块整合 |
| `packages/computer-cua/src/dom-grounding.ts` | 采用 PR22 起点；保留平台输入/焦点/不重放语义，排除全局库存/私有RPC硬门槛；批次2逐块整合 |
| `packages/computer-cua/src/macos-target-topology.test.ts` | 采用 PR22 起点；保留平台输入/焦点/不重放语义，排除全局库存/私有RPC硬门槛；批次2逐块整合 |
| `packages/computer-cua/src/macos-target-topology.ts` | 采用 PR22 起点；保留平台输入/焦点/不重放语义，排除全局库存/私有RPC硬门槛；批次2逐块整合 |
| `packages/computer-cua/src/managed-browser-host.test.ts` | 采用 PR22 起点；保留平台输入/焦点/不重放语义，排除全局库存/私有RPC硬门槛；批次2逐块整合 |
| `packages/computer-cua/src/managed-browser-host.ts` | 采用 PR22 起点；保留平台输入/焦点/不重放语义，排除全局库存/私有RPC硬门槛；批次2逐块整合 |
| `packages/computer-cua/src/window-contract.ts` | 采用 PR22 起点；保留平台输入/焦点/不重放语义，排除全局库存/私有RPC硬门槛；批次2逐块整合 |
| `packages/computer-cua/src/window-discovery.test.ts` | 采用 PR22 起点；保留平台输入/焦点/不重放语义，排除全局库存/私有RPC硬门槛；批次2逐块整合 |
| `packages/context/src/budget.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/context/src/compiler.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/context/src/history.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/context/src/index.test.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/context/src/projections.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/protocol/src/index.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/provider-glm/src/index.test.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/provider-glm/src/index.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/risk-guard/src/index.test.ts` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `packages/runtime/src/computer-tools.test.ts` | 采用 PR22 起点；逐块保留 PR24 结束判定/不重放/预算收尾，未审清前不计批次0完成 |
| `packages/runtime/src/computer-tools.ts` | 采用 PR22 起点；逐块保留 PR24 结束判定/不重放/预算收尾，未审清前不计批次0完成 |
| `packages/runtime/src/contracts.ts` | 人工合并 PR24 双预算/完整上下文；保留 PR22 增量，作者（8） |
| `packages/runtime/src/control-tools.ts` | 采用 PR22 起点；逐块保留 PR24 结束判定/不重放/预算收尾，未审清前不计批次0完成 |
| `packages/runtime/src/defaults.ts` | 采用 PR22 起点；逐块保留 PR24 结束判定/不重放/预算收尾，未审清前不计批次0完成 |
| `packages/runtime/src/index.test.ts` | 采用 PR22 起点；逐块保留 PR24 结束判定/不重放/预算收尾，未审清前不计批次0完成 |
| `packages/runtime/src/run-controller.ts` | 采用 PR22 起点；逐块保留 PR24 结束判定/不重放/预算收尾，未审清前不计批次0完成 |
| `packages/trajectory/src/index.ts` | 本批必要：仅合并 ContextBudget 的 maxWireInputTokens 与 estimate 的 visual/envelope/total schema 字段，避免轨迹校验丢失预算及估算；其余采用 PR22，作者（8），不整文件引入 |
| `packages/voice/src/index.test.ts` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |
| `packages/voice/src/run-notices.ts` | 采用 PR22；PR24 非预算增量待逐块复审，不覆盖 |

## 必要测试合同增量

最终检查作者报告：Vitest 1666 通过，但 TAP 70/71，provider-description-probe selftest 报 STABLE_PREFIX_DRIFT。该候选不得冻结；这些数字不是最终组合通过证据。

`scripts/provider-description-probe/probe.mjs` 及对应 selftest 纳入本批必要范围，仍由（8）唯一作者。动态请求预算提示须放入按预算计入的动态 message；非终局 system/tools 稳定检查保留。若终局 terminate-only 投影确需例外，只接受可核验的明确 final-budget 状态，保留非终局漂移拒绝、终局零 GUI 派发和必要上下文预算反例；不能删除全局 prefix 检查或凭自由文本推断例外。最终 diff 须独立 Sol medium 重审并重新验证失败 TAP 和全仓检查。

最终实际结果：上述是排查时允许的候选范围，不是最终变更。真实脚本位于 `scripts/cross-window/provider-description-probe.mjs` 及 `.selftest.mjs`，最终两文件零 diff，没有新增例外或降低原检查。修复只将预算提示放入动态消息并完整计费。独立最终审查见 `docs/a-line-sync/fixes/F-20261006-001-review-r5.md`；最终交付见 `F-20261006-002.md`。独立审查者报告同版本 pnpm test 111 Vitest 套件1667/1667、TAP71/71、typecheck0。协调方实际重算326文件指纹 `9eb8e96ad9f7b5667c536612b7b420223e55bbc7c261ec3e328413bf2ddc1c1f`、锁hash并核对25文件清单与diffcheck，与交付一致；协调方未重复全仓测试、未消费真实API或操作桌面。

## 冻结交接要求

当前整合 SHA 尚未形成。交付前补：实际变更文件及hunk、离线命令与结果、独立review、源码指纹、pnpm-lock hash、实际驱动版本/hash、需重建组件、恢复版本、待测平台和限制。HTTP必须关联同Run/request并有实际响应状态/交换，不以started推断网络。共享历史驱动hash只作盘点，不冒充此树已加载驱动。

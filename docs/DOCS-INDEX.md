# Computer Harness 文档索引

## 当前交接主线

最新接入：[手机自动选窗与受管浏览器接入](./mobile-target-modes-2026-09-27.md)。默认匹配已打开或最小化的唯一窗口、保留手动兜底，另提供起始网址可留空的持久profile浏览器入口；旧profile锁可显式安全恢复。最终798项测试通过，本机微信恢复、空白页启动/观察与公网请求链已验证并部署；消息发送等完整业务效果仍需试用。

下一阶段完整待办与分工入口：[产品开发、验证与稳定 Demo 清单](./product-next-stage-task-list-2026-09-27.md)。覆盖桌面执行、手机/语音、个性化、Guard、三平台、现有模块优化、评测发布及后续研究；第11节为可认领任务全集，第12节为认领规则。分工尚待用户确认。

语音阶段 A 实现记录：[可替换语音合同与运行通知基础](./voice-streaming-and-notices-implementation-2026-09-28.md)。独立 voice 包已定义分段转写、可取消输出、等待 action receipt 的 RuntimeEvent→RunNotice 投影与优先级调度；动态内容默认关闭，当前没有具体 STT/TTS Provider，也未接入 Host/Web 传输或手机播放。

当前交付：[手机 App 式界面与审批修复](./mobile-accessible-ui-implementation-2026-09-26.md)。已按成熟 App 参考重做实际界面；756 项测试通过，最终小屏裁切已修复并重建。2026-09-27 已部署公网 Web、启动新版本机 Host 并验证配对注册；未完成手机读屏及真实任务验收。

设计依据：[手机与电脑 App 式界面实施依据](./app-ui-design-proposal-2026-09-26.md)。电脑仅连接管理，手机采用任务/图片/设置的成熟交互；旧概念图不作验收依据。

历史实机失败复核：[手机真实任务的点击后前台失配与审批循环](./mobile-real-run-audit-2026-09-26.md)。保留输入成功/发送未执行的原始结论；审批循环已进行代码修复但未实机复测，点击失配仍未修复。

最新部署与 CI 复核：[手机 staging 进度、失败归因及修复顺序](./mobile-staging-ci-audit-2026-09-26.md)。公网安卓测试使用模拟执行后端，不能替代 Windows 实机验收。

部署历史：[修复、独立公网检查与部署状态](./mobile-staging-fixes-2026-09-26.md)。包含此前 staging 复验命令和回滚证据。PR #15 已合并，修复 head `4215599` 的三平台 CI 全通过；当前 Web 部署与真实验收缺口以手机 App 式界面实施记录为准。

新成员从以下五份主文档接手；源码与测试共同维护当前事实。

1. [项目目标、状态与问题](./PROJECT-HANDOFF.md)
2. [架构与公共装配接口](./ARCHITECTURE-AND-COMPOSITION.md)
3. [Runtime、事件与安全合同](./RUNTIME-AND-SAFETY-CONTRACTS.md)
4. [模块实现与能力边界](./MODULES-AND-CAPABILITY-STATUS.md)
5. [开发、运维与验证](./OPERATIONS-TESTING-AND-REMOTE-CONTROL.md)

## 当前操作、评测与验证专题

- 入门与本机启动：[开发者上手](./getting-started.md)、[本地启动器](./local-launcher.md)。
- SDK 与模块装配：[Run SDK 示例](./sdk-run-composition.md)、[Planning / Run Memory 组合](./pi-module-composition-2026-09-23.md)。
- 手机控制：[快速操作指南](./mobile-control-guide-2026-09-26.md)、[技术与测试报告](./mobile-control-technical-report-2026-09-26.md)、[独立审查](./mobile-control-review-2026-09-26.md)、[问题与验收边界](./mobile-control-issues-2026-09-26.md)。
- 实机验收：[窗口与出行验收清单](./deferred-live-window-acceptance-2026-09-26.md)、[CUA 坐标与输入诊断](./cua-coordinate-diagnosis-2026-09-26.md)。受控诊断入口为 `../scripts/cua-type-text-smoke.mjs`、`../scripts/cua-window-capture-probe.mjs`、`../scripts/cua-window-handoff-probe.mjs`；执行前须阅读各自 help 并取得桌面测试授权。
- 出行评测：[试点准备](./travel-pilot-preparation-2026-09-20.md)、[任务卡与反馈表](./travel-task-cards-and-feedback.md)。
- OSWorld 与候选集：[环境说明](./osworld-environment-implementation.md)、[复现说明](./stage-5-osworld-reproducibility.md)、[G0 预检进度](./g0-preflight-progress-2026-09-10.md)、[候选任务清单](./harness-development-validation-candidates-2026-09-10.json)、[Linux 平台验证记录](./linux-platform-adaptation-2026-09-17.md)。
- [开发文档规范](./development-documentation-standard.md)约束入口、证据和历史材料的维护方式。
- [本地缺陷复现探针](./verification/audit-39ff27f9-local-probes.mjs)作为独立验证工具保留。

## 历史证据

- [2026-09-26 首页改版前存档](./history/2026-09-26-readme-before-refresh.md)：保留旧首页的参数与阶段记录，当前使用入口以根 README 和专题指南为准。
- [2026-09-26 交接收敛归档与迁移索引](./history/2026-09-26-handoff-convergence/README.md)：记录旧阶段文档和一次性实验脚本的原路径、新路径、归档理由与恢复方式。
- [2026-09-17 路线整合归档](./history/2026-09-17-roadmap-consolidation/README.md)：旧设计、审计、实验结论及外部审计包。

历史报告中的“当前”“下一步”和命令只代表记录时点；当前执行顺序、验证事实和能力承诺以上述五份主文档及当前源码为准。

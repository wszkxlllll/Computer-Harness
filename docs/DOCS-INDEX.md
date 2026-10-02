# Computer Harness 文档索引

## 当前交接主线

项目材料：[项目说明、技术与开放边界、真实场景及待补内容](./project-materials.md)。集中整理可复用的内容和证据入口，沿用原定六类生活场景，不另设详细分工或比赛开发路线。

最新接入：[手机自动选窗与受管浏览器接入](./mobile-target-modes-2026-09-27.md)。默认匹配已打开或最小化的唯一窗口、保留手动兜底，另提供起始网址可留空的持久profile浏览器入口；旧profile锁可显式安全恢复。最终798项测试通过，本机微信恢复、空白页启动/观察与公网请求链已验证并部署；消息发送等完整业务效果仍需试用。

下一阶段完整待办与分工入口：[产品开发、验证与稳定 Demo 清单](./product-next-stage-task-list-2026-09-27.md)。覆盖桌面执行、手机/语音、个性化、Guard、三平台、现有模块优化、评测发布及后续研究；第11节为可认领任务全集，第12节为认领规则。分工尚待用户确认。

语音阶段 A+B1 实施记录：[语音合同、运行通知与 Host/Web 播报](./voice-streaming-and-notices-implementation-2026-09-28.md)。Host/RemoteRunAPI 可选投影最小 `run.notice` SSE 事件，手机显式开启后，新 Run 可朗读结构化中文审批提示、已验证 milestone 摘要、问题和结果；过期审批、SSE 重放、旧快照与敏感正文均有降级边界。Web 使用可替换的 Browser `speechSynthesis` 输出并固定请求普通话，真实云端 TTS 尚未接入。阶段 B2 已实现手机录音、Host 流式 ASR 会话与 Qwen Provider，mock、真实短探针和手机链路仍需按实施记录继续验收：[阶段 B2 实施记录](./voice-recording-b2-implementation-2026-09-29.md)。

语音 Preview 部署与手机测试入口：[隔离部署记录](./voice-preview-deploy-phone-test-2026-09-29.md)。新 Preview 在 `https://47.108.197.221:8443`；旧公网服务保持原状。公网基础检查已完成，手机完整语音链路待实测。

P1 助手回答偏好实施记录：[版本化 Run 快照与 Context 投影](./assistant-preferences-p1-implementation-2026-09-29.md)。代码闭环和离线合同测试已完成；真实模型行为与手机真机无障碍尚未验收。

受控真实 API 验证：[ObservationAssessment 与助手偏好](./semantic-assessment-and-preferences-real-api-validation-2026-09-29.md)。GLM/Qwen 共发起四次合成请求；Qwen assessment 经 Monitor/Context 消费，GLM 简中偏好有单次正向样本，Qwen 个性化选择 `wait` 且 assessment 与 unchanged transition 冲突。终端汇总截断了部分逐项指标，报告明确保留该证据限制。

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
- 队友扩展领域（设计草稿）：[政务与公共服务任务卡](./government-task-cards.md)（[manifest](../eval/government/government-candidate-manifest.v0.json)；域已转其他成员，草稿供交接）、[生活缴费与社区服务任务卡](./community-payment-task-cards.md)（[manifest](../eval/community-payment/community-payment-candidate-manifest.v0.json)；成员 C）。各 10 族×2 实例（6 族开发/4 族留出）；待环境验证与 evaluator 实现，使用前须确认真实入口可达性、建立受控测试环境、实现独立 evaluator、完成隐私与合规审查。
- 成员 C D01 精选任务卡（设计定稿候选）：[就医与健康服务](./medical-care-d01-task-cards.md)（[manifest](../eval/medical/medical-d01-manifest.v0.json)）、[生活缴费与社区服务](./community-payment-d01-task-cards.md)（[manifest](../eval/community-payment/community-payment-d01-manifest.v0.json)）。各 3 族×2 实例（v1 开发/v2 留出），含医院公众号/小程序、微信"生活缴费"小程序、物业 App 等非网页入口；对齐[项目材料](./project-materials.md) §4 官方示例口径；待真实入口验证与 evaluator 实现。
- OSWorld 与候选集：[环境说明](./osworld-environment-implementation.md)、[复现说明](./stage-5-osworld-reproducibility.md)、[G0 预检进度](./g0-preflight-progress-2026-09-10.md)、[候选任务清单](./harness-development-validation-candidates-2026-09-10.json)、[Linux 平台验证记录](./linux-platform-adaptation-2026-09-17.md)、[CUA Linux 0.32.0 配对验证](./cua-linux-0320-upgrade-verification-2026-10-02.md)。
- [开发文档规范](./development-documentation-standard.md)约束入口、证据和历史材料的维护方式。
- [本地缺陷复现探针](./verification/audit-39ff27f9-local-probes.mjs)作为独立验证工具保留。

## 历史证据

- [2026-09-26 首页改版前存档](./history/2026-09-26-readme-before-refresh.md)：保留旧首页的参数与阶段记录，当前使用入口以根 README 和专题指南为准。
- [2026-09-26 交接收敛归档与迁移索引](./history/2026-09-26-handoff-convergence/README.md)：记录旧阶段文档和一次性实验脚本的原路径、新路径、归档理由与恢复方式。
- [2026-09-17 路线整合归档](./history/2026-09-17-roadmap-consolidation/README.md)：旧设计、审计、实验结论及外部审计包。

历史报告中的“当前”“下一步”和命令只代表记录时点；当前执行顺序、验证事实和能力承诺以上述五份主文档及当前源码为准。

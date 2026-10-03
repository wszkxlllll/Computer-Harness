# Computer Harness 文档索引

## 使用、构建与许可

[项目概览与手机体验说明](../README.md)注明公共 Demo Relay 尚未开放，并提供 Windows 本机 Host 启动前置、平台状态、安全边界和许可入口；[开发者上手](./getting-started.md)补充模型、CUA、OSWorld和排错步骤。项目许可见根目录[LICENSE](../LICENSE)，直接依赖与 CUA notices 见[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 当前交接主线

最新修复验收：[窗口与中途播报修复（2026-10-04）](./window-and-progress-repair-results-2026-10-04.md)。Windows 记事本菜单返回、WPS 列窗切换与辅助窗复测通过；真实 API 已产生可消费的 Notepad milestone，携程仍有漏报。历史失败诊断见[携程→记事本轨迹](./travel-window-and-speech-diagnosis-2026-10-03.md)，用户已确认开始/取消有声音，缺的是中途播报，不是完全静音。

最新 main 与三平台跨窗口验收：[三平台进度同步（2026-10-03）](./platform-cross-window-status-2026-10-03.md)。PR #21 已合并，三平台 CI 全绿；macOS/Linux 跨窗口实机仍待验收，Windows 合并前窄路径成功也不替代新 main 回归。当前 Preview/本机 Host 尚未自动更新到该整合 main。

Surface Registry 与 Windows transient-child 当前交接：[Surface Registry 队友交接](./surface-registry-team-handoff-2026-10-03.md)。集中记录稳定 ComputerSession/Surface 谱系、Windows relationship probe 与权威合并、menu/dialog/overlay 准入、多行自动 element binding、跨平台队友边界和细粒度 PR 切片。最终冻结源码定向 254/254、全量 105 文件/1271 tests 通过；Notepad menu bounded runner 的 `child_push`/`child_pop` 已实机通过，Open dialog 与 WPS 独立 dialog/menu 仍为 pending。

多行文本输入可靠性与 Provider 验证：[多行输入修复与 Provider 验证记录](./multiline-type-implementation-results-2026-10-03.md)。Windows CUA 原始/Adapter 多行路径已通过受控 Notepad 验证；唯一一次 GLM Run 暴露 foreground keyboard 工具未进入 outbound catalog，尚未通过 Provider 端到端多行输入。文档记录真实边界、诊断误报修复和下一次受控验证命令。

多行上游 Issue/PR 开展前的调研与候选方案见[历史计划](./cua-upstream-multiline-issue-pr-plan-2026-10-03.md)；其 main SHA、batching 候选和当时的“尚未实测”只代表记录时点，不是当前 PR 状态。

跨窗口：[已批准实施方案](./cross-window-execution-plan-2026-10-02.md)、[代码、独立审查与验证记录](./cross-window-implementation-and-validation-2026-10-02.md)。四种起点保持；单一逐 Run `switchWindows` 默认关闭，用户 opt-in 后模型从 Host 授权目录调用 `list_windows` / `switch_window`，desktop 起点也支持。managed-browser 初始目标和显式 companion 共用生命周期；手机 profile setup 为“手机发起、电脑可见 Edge 手动登录、手机确认完成”。定向离线测试与代码审查通过；此前合成 Provider API 有三组成功、一组 Qwen recent 信封失败；两轮真实 SDK scripted browser↔WPS 往返与网页 DOM 恢复通过。没有完整真实模型生活任务验收，本轮后未再启动 API/桌面任务；新 Web/Host/Relay 源码尚未部署公开页面，稳定服务未改。

待人工预检：[三个跨窗口生活任务卡](./cross-window-life-task-cards-2026-10-02.md)：社区通知整理、敬老卡办事明白纸、长者出行准备单，含完整 Goal、应用准备及验收点；尚未执行，不替代原六类场景范围。

本轮可靠性修复：[试点可靠性与阶段交付修复（2026-10-01）](./pilot-reliability-and-delivery-fixes-2026-10-01.md)。记录通用 Context 指导、分层程序运行证据、CUA 有界观察恢复、离线验证边界及后续试点 100/100 默认预算；未重跑历史试点。

项目材料：[项目说明、技术与开放边界、真实场景及待补内容](./project-materials.md)。集中整理可复用的内容和证据入口，沿用原定六类生活场景，不另设详细分工或比赛开发路线。

历史接入：[手机自动选窗与受管浏览器接入（2026-09-27）](./mobile-target-modes-2026-09-27.md)。该记录保留当时 798 项测试及既有部署证据；它早于本轮 `switchWindows` 和 profile settings 新合同，不作为当前四种起点/跨应用开关/Profile API 的说明。

常用网站入口：[URL 选择器实施记录](./common-site-url-picker-implementation-2026-10-02.md)。Web 可选注入带标签的 URL 目录，默认空；选择只填入现有起始网址字段并须明确提交，浏览器 saved/temporary 默认值在设置中管理。

下一阶段完整待办与分工入口：[产品开发、验证与稳定 Demo 清单](./product-next-stage-task-list-2026-09-27.md)。覆盖桌面执行、手机/语音、个性化、Guard、三平台、现有模块优化、评测发布及后续研究；第11节为可认领任务全集，第12节为认领规则。分工尚待用户确认。

语音阶段 A+B1 实施记录：[语音合同、运行通知与 Host/Web 播报](./voice-streaming-and-notices-implementation-2026-09-28.md)。Host/RemoteRunAPI 可选投影最小 `run.notice` SSE 事件，手机显式开启后，新 Run 可朗读结构化中文审批提示、已验证 milestone 摘要、问题和结果；过期审批、SSE 重放、旧快照与敏感正文均有降级边界。Web 使用可替换的 Browser `speechSynthesis` 输出并固定请求普通话，真实云端 TTS 尚未接入。阶段 B2 已实现手机录音、Host 流式 ASR 会话与 Qwen Provider，mock、真实短探针和手机链路仍需按实施记录继续验收：[阶段 B2 实施记录](./voice-recording-b2-implementation-2026-09-29.md)。

历史语音部署与手机测试入口：[隔离部署记录](./voice-preview-deploy-phone-test-2026-09-29.md)。该记录保留当时的隔离部署、基础检查和手机测试状态；不作为当前 Quick Start 或稳定服务状态说明。

P1 助手回答偏好实施记录：[版本化 Run 快照与 Context 投影](./assistant-preferences-p1-implementation-2026-09-29.md)。代码闭环和离线合同测试已完成；真实模型行为与手机真机无障碍尚未验收。

受控真实 API 验证：[ObservationAssessment 与助手偏好](./semantic-assessment-and-preferences-real-api-validation-2026-09-29.md)。GLM/Qwen 共发起四次合成请求；Qwen assessment 经 Monitor/Context 消费，GLM 简中偏好有单次正向样本，Qwen 个性化选择 `wait` 且 assessment 与 unchanged transition 冲突。终端汇总截断了部分逐项指标，报告明确保留该证据限制。

ObservationAssessment wire schema 与 producer 指令实测：[GLM 真实 API 探针记录](./observation-assessment-live-probe-2026-10-04.md)。`progress` 现要求显式 object/null，解析器兼容旧缺字段响应；最终提示轮中 Notepad milestone 经 RunNoticeProjector/Scheduler 消费，Ctrip 正确结果图仍未返回外层 annotation。共 6 次受限真实请求；样本选择校正、隐私边界与尚未证实的物理播报详见报告。

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
- Linux CUA 实机证据：[0.32.0 配对验证摘要](./cua-linux-0320-upgrade-verification-2026-10-02.md)。这是作者在 Plasma X11 上的仓库外 SDK/daemon 验证报告，不代表当前 Runtime adapter 已接入 0.32.0；Wayland 未测试。
- 政务与出行评测：[上海真实 Harness 试点与入口预检](./shanghai-government-travel-pilot-2026-10-01.md)。旧批次17个终态Run/10道原题的成绩不变；新增2026-10-02只读预检：SG01–SG04公开资料可读，SG05官方普通身份证办点已核实、公交链仍待验证，不当作新实机通过。历史准备：[试点准备](./travel-pilot-preparation-2026-09-20.md)、[任务卡与反馈表](./travel-task-cards-and-feedback.md)。
- 政务与公共服务候选任务：[任务卡](./government-task-cards.md)（[candidate manifest](../eval/government/government-candidate-manifest.v0.json)）。来源为 PR #18（Yao GX / @Tangs-mo）；该 PR 说明政务域已交接。当前是未验证设计草稿，不作为活动题库或评测成绩证据。
- 生活缴费与就医候选任务（PR #18，Yao GX / @Tangs-mo）：[社区缴费 C01–C10 宽集草稿](./community-payment-task-cards.md)（[manifest](../eval/candidates/community-payment/community-payment-candidate-manifest.v0.json)）；D01 精选的社区 CP01–CP03 与就医 M01–M03 共六族，见[社区任务卡](./community-payment-d01-task-cards.md)（[manifest](../eval/candidates/community-payment/community-payment-d01-manifest.v0.json)）和[就医任务卡](./medical-care-d01-task-cards.md)（[manifest](../eval/candidates/medical/medical-d01-manifest.v0.json)）。全部是未验证候选，不是活动题库或成绩；D01 是宽集的精选子集，不能与 C01–C10 当作独立样本。
- OSWorld 与候选集：[环境说明](./osworld-environment-implementation.md)、[复现说明](./stage-5-osworld-reproducibility.md)、[G0 预检进度](./g0-preflight-progress-2026-09-10.md)、[候选任务清单](./harness-development-validation-candidates-2026-09-10.json)、[Linux 平台验证记录](./linux-platform-adaptation-2026-09-17.md)。
- [开发文档规范](./development-documentation-standard.md)约束入口、证据和历史材料的维护方式。
- [本地缺陷复现探针](./verification/audit-39ff27f9-local-probes.mjs)作为独立验证工具保留。

## 历史证据

- [2026-09-26 首页改版前存档](./history/2026-09-26-readme-before-refresh.md)：保留旧首页的参数与阶段记录，当前使用入口以根 README 和专题指南为准。
- [2026-09-26 交接收敛归档与迁移索引](./history/2026-09-26-handoff-convergence/README.md)：记录旧阶段文档和一次性实验脚本的原路径、新路径、归档理由与恢复方式。
- [2026-09-17 路线整合归档](./history/2026-09-17-roadmap-consolidation/README.md)：旧设计、审计、实验结论及外部审计包。

历史报告中的“当前”“下一步”和命令只代表记录时点；当前执行顺序、验证事实和能力承诺以上述五份主文档及当前源码为准。

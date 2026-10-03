# Computer Harness 文档索引

## 当前交接主线

A 线三聊天协作：[修复、实机测试与远端审查入口](./a-line-three-thread-coordination-2026-10-03.md)。聊天（8）负责修复、（10）负责实机测试、（6）负责远端代码更新和审查；当前共用同一 Git 分支，提交与运行版本切换须串行协调。

A 线双聊天协作：[修复与实机测试同步](./a-line-collaboration-sync-2026-10-03.md)。修复聊天维护代码与交付，测试聊天维护实际运行版本、问题和复验；共享事件记录及关键节点消息。

A 线本轮修复：[P0 输入焦点、DOM 指纹与工具合同修复](./a-line-p0-focus-fingerprint-fix-2026-10-03.md)。区分代码/离线回归与真实 Mac 验收，实际部署状态及放行门槛以该记录为准。

A 线当前总览：[2026-10-03 进度复核与优化方向](./a-line-progress-review-2026-10-03.md)。基本链路与简单任务已有通过证据，完整 T1 仍受焦点/DOM 问题阻塞；T2/T3 未完成验收。优先验证输入与指纹一致性，再完成核心任务与性能收口；下列历史记录不代表当前全部通过。

最新接入：[手机自动选窗与受管浏览器接入](./mobile-target-modes-2026-09-27.md)。默认匹配已打开或最小化的唯一窗口、保留手动兜底，另提供起始网址可留空的持久profile浏览器入口；旧profile锁可显式安全恢复。基线记录的 798 项测试仍代表当时交付；当前 A 线本机回归另通过 820 项 Vitest 与 20 项 TAP，详见 [macOS 本机预检](./macos-a-line-preflight-2026-09-27.md)。本机微信恢复、空白页启动/观察与公网请求链已验证并部署；消息发送等完整业务效果仍需试用。

下一阶段完整待办与分工入口：[产品开发、验证与稳定 Demo 清单](./product-next-stage-task-list-2026-09-27.md)。覆盖桌面执行、手机/语音、个性化、Guard、三平台、现有模块优化、评测发布及后续研究；第11节为可认领任务全集，第12节为认领规则。分工尚待用户确认。

当前交付：[手机 App 式界面与审批修复](./mobile-accessible-ui-implementation-2026-09-26.md)。已按成熟 App 参考重做实际界面；756 项测试通过，最终小屏裁切已修复并重建。2026-09-27 已部署公网 Web、启动新版本机 Host 并验证配对注册；未完成手机读屏及真实任务验收。

下一阶段 A 线入口：[通过真实任务完善产品](./a-line-runtime-delivery-plan-2026-09-27.md)。先在实际设备体验查询、文件保存和跨应用纠正三类任务，再修阻塞并补必要功能；完整配置、偏好和 Guard 策略不再列为必做，旧 B 实验保留为参考。

A 线最新性能结论：[性能与结构审计](./a-line-performance-architecture-audit-2026-09-29.md)。真实简单网页任务的主要耗时在模型往返而非 Relay 或本机动作，优化顺序为 GLM 请求合同与观测、减少回合、任务级工具裁剪、受管浏览器快速路径、Context/图片和流式反馈。

A 线最近一次失败复核：[运行失败审查](./a-line-run-failure-audit-2026-10-01.md)。本次运行已成功打开 CUA 并执行多次动作，最终因 GLM 响应达到 `max_tokens` 而失败；同时运行目标被误记录为错误提示文本，不能作为有效 A 线任务验收。

A 线最近一次成功链路核查：[搜索任务全链路核查](./a-line-search-run-chain-check-2026-10-01.md)。手机、Relay、Host、CUA、GLM 和网页搜索均成功，但仍有 3 次 DOM 引用失效及 4 次风险审批，后续应优先优化这两处体验。

A 线风险控制修正：[搜索误审批修正](./a-line-risk-control-search-fix-2026-10-01.md)。已为明确的只读搜索提交增加窄范围本地放行，并保留订单、付款、发送、删除等高风险审批；代码测试已通过，待手机实机复测。

A 线长任务预算优化：[长任务预算与收敛优化审计](./a-line-long-run-budget-optimization-2026-10-01.md)。最近一次复杂任务的风险检查和 GUI 动作均成功，但因 Host 固定 24 次模型请求上限耗尽；本轮提高上限并增加安全可配置入口，监控仍保持非阻断模式。

A 线地址栏导航修正：[地址栏导航误审批修正](./a-line-url-navigation-risk-fix-2026-10-01.md)。最近一次失败由地址栏回车中的“提交”措辞触发语义审查超时；新增仅限地址栏 URL 导航的窄放行，普通提交和高风险 URL 继续受 Guard 保护。

A 线长任务重试结果：[长任务重试审查](./a-line-long-run-retry-audit-2026-10-01.md)。地址栏放行已在真实任务中生效；本次失败转为 48 回合预算耗尽，主要问题是 DOM 引用过期、重复滚动和缺少收尾回合。

A 线 100 请求上限重试结果：[100 请求上限重试审查](./a-line-long-run-100-request-retry-audit-2026-10-01.md)。100 次上限没有被耗尽；本次在第 44 次请求期间由配对设备中止，主要问题转为网页输入焦点错位、DOM 引用过期和恢复回合过多。

A 线开工前 Mac 验收：[macOS 本机预检](./macos-a-line-preflight-2026-09-27.md)。代码、窗口级截图、Mac 辅助窗口过滤、临时受管浏览器、本机合成配对和普通 TextEdit 输入已通过；保存弹窗已加严格焦点拒绝与显式交接边界，实体手机控制待验收。

Windows 兼容复核：[Windows 兼容工作完整复核](./windows-compatibility-audit-2026-10-01.md)。当前审查在 macOS 完成；Windows 默认 Edge、profile/进程树、精确 HWND、PowerShell 清理和离线回归已覆盖，但 Windows 真机 CUA/Edge/UIA/DPI/多窗口验收仍未完成，不能把 Mac 成功当作 Windows 放行证据。

A 线推送说明：[A 线阶段改动推送说明](./a-line-delivery-note-2026-10-01.md)。汇总本次运行时、受管浏览器、风险控制、手机反馈、测试结果和 Windows 实机验收清单。

本机目录与私有配置：[项目本机文件整理记录](./project-local-files-organization-2026-09-28.md)。桌面仓库是唯一项目目录；Relay 配置、运行证据和旧空壳工作区元数据已归档到仓库内，SSH 私钥与应用缓存按安全边界保留在系统目录。

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

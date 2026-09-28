# Computer Harness 文档索引

## 当前交接主线

最新接入：[手机自动选窗与受管浏览器接入](./mobile-target-modes-2026-09-27.md)。默认匹配已打开或最小化的唯一窗口、保留手动兜底，另提供起始网址可留空的持久profile浏览器入口；旧profile锁可显式安全恢复。基线记录的 798 项测试仍代表当时交付；当前 A 线本机回归另通过 820 项 Vitest 与 20 项 TAP，详见 [macOS 本机预检](./macos-a-line-preflight-2026-09-27.md)。本机微信恢复、空白页启动/观察与公网请求链已验证并部署；消息发送等完整业务效果仍需试用。

下一阶段完整待办与分工入口：[产品开发、验证与稳定 Demo 清单](./product-next-stage-task-list-2026-09-27.md)。覆盖桌面执行、手机/语音、个性化、Guard、三平台、现有模块优化、评测发布及后续研究；第11节为可认领任务全集，第12节为认领规则。分工尚待用户确认。

当前交付：[手机 App 式界面与审批修复](./mobile-accessible-ui-implementation-2026-09-26.md)。已按成熟 App 参考重做实际界面；756 项测试通过，最终小屏裁切已修复并重建。2026-09-27 已部署公网 Web、启动新版本机 Host 并验证配对注册；未完成手机读屏及真实任务验收。

下一阶段 A 线入口：[通过真实任务完善产品](./a-line-runtime-delivery-plan-2026-09-27.md)。先在实际设备体验查询、文件保存和跨应用纠正三类任务，再修阻塞并补必要功能；完整配置、偏好和 Guard 策略不再列为必做，旧 B 实验保留为参考。

A 线开工前 Mac 验收：[macOS 本机预检](./macos-a-line-preflight-2026-09-27.md)。代码、窗口级截图、Mac 辅助窗口过滤、临时受管浏览器、本机合成配对和普通 TextEdit 输入已通过；保存弹窗已加严格焦点拒绝与显式交接边界，实体手机控制待验收。

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

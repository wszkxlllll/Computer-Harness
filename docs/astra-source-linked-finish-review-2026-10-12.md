# T1 source-linked finish：隔离实施审查

## 2026-10-12 11:01 当前范围

Sol 在独立 worktree `/private/tmp/astra-t1-source-linked-cb93` 审查 Luna 的 opt-in 实现。主 checkout 的 cb93d5d 源码、dist、正常 Web Host/Relay 保持冻结。本文不将草稿、类型构建或离线 fixture 当成 T1 业务通过；当前原卡仍是 793 UTF-8 字节，goal SHA f84e0557bcc4c36f9b3225938380a9adb63ffe059963c8412b0faf6570eaa264。

目标是让最终主结果由同 Run 已提交 Observation 中实际保留的 grounding 元素引用生成，阻止模型把已读回的来源原文改写成不同值。历史完整 catalog 和 Memory 叙述不成为真值；只有已持久化 hot subset 可引用。该机制证明引用及输出一致性，不机械证明来源与字段的语义对应、最低价标准配置或事实真伪。多来源保留原文并要求独立审查，模型报告的冲突理由须明确标为模型标签。

Sol 已检查并要求保持以下边界：32 个字段上限；完整摘录不可静默截掉 selected/disabled 等限定；单摘录、canonical summary 和 evidence 总量有界，超限在提交终态前拒绝；同 Run、Observation、computer session、Surface 与 earlier-event 身份绑定；普通 finish 的暂停、纠正、取消屏障先于新增 canonical 验证。默认未配置合同的 finish 行为保持。CLI 与 Host 需有真实显式 opt-in 装配入口，不能仅靠单测向 RunController 注入配置宣称产品可用。

私有 baseline 合同 `sol-t1-baseline-source-linked-contract-v1.json` 为 3760 UTF-8 字节，SHA 6f49a140b577b82d0ae116e79aaf2e58350fa22a3de4b33f0c416d2b295ed6a7：三产品各 9 字段，共 27 项；另有三项预算状态、预算内排序、配置价格口径，共 32 个唯一 required 字段。它只含 fieldId、label、required，无参考答案。Root 已独读此合同；Runtime 严格 validator 仍待实际通过。变体需按原任务预算另冻合同。

作者首次对 protocol、trajectory、runtime、context、GLM、Qwen、app-runtime 的 TypeScript 构建报告 exit 0。首条真实 createRunFactory/DefaultContextCompiler 离线集成正例在 fixture 的配置 Provider id 与注入 Provider id 不一致时启动前拒绝，尚无 Run、Provider 调用或外部 HTTP；作者正在修该 fixture 后重跑。此首失败保留，不归因为产品故障。后续冻结源码、实际集成和独立回归结果另追加。

11:09 作者修正 Provider id 后，沿同一 SDK 集成测试命令取得 1/1 PASS。真实默认 ContextCompiler 编入字段合同；引用 Runtime 自己生成并提交的 Observation；canonical 主 summary 使用 M6 原文并保留 enabled=false/selected=false；模型 M4 只在 reportedSummary 中作为审计保留，主 summary 不复写该值。run.report 与 readRuntimeEvents 回放的 finish evidence 一致，并保留权威 capturedAt。此为作者离线执行结果，Sol 尚未在冻结 pin 上独跑；CLI/Host 显式装配、控制屏障及负例尚待完成，不能标成正式 T1 或事实语义验收。

## 11:44 冻结独立检查

24 个源文件冻结于 cb93d5d 基线。作者收据 `/private/tmp/t1-source-linked-cb93-final-receipt.json` SHA dd8773a6e6af1414f28f97502c1ec12cb7e380acd336da630e15c1cf7713c44a 记录 10 文件/452 测试、涉及项目 tsc-b 和 diff-check 的成功退出；作者未持久化原始 stdout/stderr，此边界明确保留。

Sol 实际独跑 pure canonical、Host 配置、CLI、SDK、GLM、Qwen、Context、Trajectory 八个完整测试文件：239/239、exit0、session52194，完整日志在 A07 私有目录。Root 实际独跑 Runtime 169 与 RunFactory 44：213/213、exit0、session51155，独立收据 SHA 3ef0b069…；两组互补合计 452，不重复计数。Root 与 Sol 源码审查确认默认 unsolicited/malformed evidence 在 model.response 前剥离，enabled malformed 报告受控失败且可回放，普通 finish 屏障先于 canonical，跨 Run/session/Surface、空 canonical 与总量限制均保持拒绝。

Sol 逐文件核对作者冻结 hash，主 checkout 的既有目标文件逐字节仍等于 cb93 基线、四个新路径尚不存在；生成 89479 字节精确集成 patch（SHA 5f6f3d1b8519255920232b1a44a2802d3579636f7c173ec40c7bc0e126192146），主 checkout apply-check 与 apply 均成功。主构建与最终提交、当前 HEAD CI 继续按实际结果另记，不沿用 cb93 的历史绿。用户已指定本轮修复后停止，不再开始 Web、付费或 T3 新轮。

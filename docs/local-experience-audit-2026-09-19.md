# 首次本机真实体验审计

日期：2026-09-19
范围：最新本机 CUA/TUI Run 的脱敏 `summary.json`、`trajectory.jsonl` 与 provider exchange 摘要。未查看、展示或提交截图，不复述用户目标或输入文本，未调用模型或操作桌面。

## 1. 结论

该 Run 在协议层结束为 `succeeded`，但不能据此判断任务体验或语义结果成功。它暴露出的主要矛盾是：功能模块虽已接入，当前模型没有有效使用 Planning/Memory，Monitor 未形成干预，Guard 没有触发审批，而完整工具目录与不断增长的历史仍显著增加了成本和延迟。

下一步不宜继续叠加高级功能。应先围绕真实体验修复“结果语义、上下文成本、工具按需暴露、Monitor 消费和风险准入”五条主线，再进行同类任务复测。

## 2. 可复核事实

| 项目 | 本次结果 | 含义 |
| --- | ---: | --- |
| Runtime / 模型自报 | `succeeded` / `success` | 只表示主循环正常结束和模型调用 terminate；没有独立结果验证 |
| 模型请求 | 27 | GUI 动作基本仍是一动作一轮 |
| GUI 动作 | 26 | 24 completed、2 refused |
| 累计模型 usage | 398,608 input + 9,258 output = 407,866 tokens | 对一次本地体验明显过高 |
| Provider 延迟 | 合计约 368 秒；平均 13.6 秒，P50 11.6 秒，P95 22.4 秒 | 约占 Run 墙钟时间 436 秒的大部分 |
| Prompt 大小 | 第 1 轮 10,095；后期约 17k–18k tokens | recent/event cap 开始裁剪后趋稳，但固定前缀与工具目录已经很重 |
| Tool Registry | 20 个工具 | Computer、Control、Planning、Fact/Entity Memory 同时暴露 |
| Planning / Memory 调用 | 0 / 0 | 功能已启用但该任务中没有被模型消费 |
| 多调用 Turn | 1/27 轮返回 2 calls，其余均为单 call | Batch 的实际节省非常有限 |
| Monitor | 30 proposals：26 suppressed、4 candidate | 检出 2 次 action cycle、1 次 repeated proposal、1 次 repeated action，但未形成 guidance/help |
| Risk Guard | 25 evaluations，25 allow，0 approval | Guard 正常经过生产路径，但本次没有提供有效保护或人工检查点 |
| TUI 控制 | pause、resume、correction 各发生；1 个旧 call 被 supersede 拒绝 | 用户纠正屏障工作正常 |

## 3. 关键问题

### P0：`succeeded` 容易被误解为任务成功

当前 `runtimeOutcome=succeeded` 只证明 Runtime 没有以失败终止，`modelReportedStatus=success` 是模型自报。本次没有 evaluator、用户确认或确定性 readback。产品界面必须区分：

- `run completed`：执行链正常结束；
- `model reported success`：模型自报；
- `task verified`：只有真实 evaluator/readback/用户确认才能设置。

在第三种信号缺失时，TUI 不应把前两者合并展示成无条件“任务成功”。

### P1：Context 与工具目录成本过高

首轮已有约 10k prompt tokens，说明问题不只是历史累计；20 个工具的 schema、Risk effect declaration、系统说明和初始图片共同构成较大固定成本。到第 22 轮输入增长到约 18k，后续 event cap 才使其维持在 17k–18k。

优先措施：

1. 记录每轮固定指令、工具 schema、历史、Memory/Plan、图片各自的实际 token/字节占比；
2. Planning/Memory 关闭时继续保持零 schema；开启时也研究按阶段或模型请求按需暴露，而不是把全部工具永久发送；
3. 默认体验预设不同时开启 Entity Memory、Planning 和 Monitor guidance；
4. 在真实 provider payload 形成后执行总预算门槛，而不只按 Runtime event 数裁剪。

### P1：功能“启用”但没有形成消费闭环

Planning 和 Memory 工具存在，但 27 轮中调用数均为 0；因此不能将“功能已打开”写成“Planning/Memory 生效”。需要在 TUI/报告中分开显示 enabled、available、used、useful 四种状态，并通过对照任务证明其净收益。

当前 `summary.json` 记录了 Planning、Memory、Batch、Context 与 Risk Guard，却没有记录 resolved Memory retrieval 和 Monitor 模式。Monitor guidance 只能从事件反推；Hybrid 是否被选中无法仅凭 summary 复核。报告必须从同一个 resolved config 写出这两项，并记录 embedding request count、fallback 与实际 retrieval method，避免“F 页面保存了什么”和“Run 实际用了什么”失联。

Action Batch 仅一轮产生两个调用，尚未显著减少 round trip。应检查该双调用是否真正命中允许的同一控件输入序列，以及其余动作为什么不能批处理，不能仅用 `batching=on` 作为效果证据。

### P1：Monitor 检出了问题，却没有帮助主循环

Monitor 识别了 action cycle/repeated action，但 guidance 模式下仍只有 candidate；另有 26 个 proposal 因 execution barrier 被抑制。需要审查 proposal 生成时机和 deferred consumption：完整 action receipt + post-observation 后，应存在明确机会把候选转换为下一轮 guidance；若候选持续无法消费，guidance 模式与 shadow 在用户体验上没有区别。

### P1：Risk Guard 对真实交互信号不足

本次 25 次动作全部 `declared_low_impact` 并本地放行，未产生 approval。当前 Guard 过度依赖模型声明的 effect/target/summary 与有限关键词；没有利用控件角色、密码/OTP 字段、窗口/应用语义或独立风险证据。此前对真实密码和验证码无法保证审批的判断被本次 Run 进一步支持。

近期应先补 synthetic 登录 fixture：普通导航放行；密码字段、OTP、发送验证码、登录提交、账户设置、支付/外发分别验证 allow/confirm/deny。真实账号不作为第一轮测试材料。

### P2：CUA 前台窗口变化导致两次拒绝

两次 `CUA_TOOL_REFUSED` 都是预期的 foreground safety refusal：动作目标 HWND 与实际前台 HWND 不一致。拒绝本身是正确保护，但主循环为恢复付出了额外观察和模型请求。后续需要将 foreground mismatch 转换成结构化恢复建议，让模型优先重新观察/重新定位，而不是依赖自由推理反复试错。

## 4. 配置问题与产品问题的边界

- 本次使用 `planning=true`、`memory=entities`、`context=recent`、`batching=on`、Monitor guidance。这更像研究组合，不适合作为日常默认体验基线。
- 若只想体验 GUI 控制，先用 `assisted` 或 `baseline`，再逐模块打开做对照；不要用一次全开 Run 判断每个模块效果。
- 但 token 固定成本、无验证成功语义、Monitor 不干预、Guard 全放行不是单纯调开关可以根治，必须修改实现和验收。

## 5. 推荐顺序

1. 先修 TUI 结果语义与 per-request Context/工具成本可视化。
2. 修 Monitor candidate → deferred guidance 的真实消费链。
3. 增加登录/OTP/外发/金融 synthetic Guard fixture，测审批覆盖和误报。
4. 建立一个同类本地任务的 baseline/assisted/research 三组复测；比较成功确认、模型轮次、动作、重复、tokens、延迟和人工接管。
5. 上述稳定后再讨论 Memory 语义检索或更高级功能，不在当前问题上继续堆模块。

## 6. 操作边界

本审计是只读分析：没有调用 Provider、embedding、CUA 或桌面；没有打开/展示截图；没有输出目标、输入内容、坐标或应用隐私。原始运行资产继续只保留在被 Git 忽略的 `runs/`。

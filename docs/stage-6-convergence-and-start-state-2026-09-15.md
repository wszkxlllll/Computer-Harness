# Stage 6 收敛与下一阶段起始状态（2026-09-15）

日期：2026-09-15
文档角色：入口 / 收敛计划
状态：当前执行（工程集成已通过；验证集 G0 尚未闭合）
当前入口：本文件；由 `docs/DOCS-INDEX.md` 导航
基线：当前仓库工作树；尚未创建冻结 tag
范围：统一 flat Provider、G1–G3 集成验收、G0 收口和下一阶段消融起点；不覆盖验证集任务内容本身

本文件是下一阶段起始候选，不是最终实验冻结令。

## 1. 当前已确定的基线

- Runtime 已统一消费 `ComputerSession`、`ObservationFrame`、`ActionIntent`、`ActionReceipt`、`ModelTurn`、`ToolCall`、`RuntimeEvent`；Event/Reducer、Abort、审批、预算、失败传播和未知副作用语义共用。
- ToolRegistry 是唯一工具来源。Computer、Planning、Memory、Control 工具由同一注册表投影给 Context 和 Provider；Provider 不维护第二份工具清单。
- Qwen `strict_json` 已统一为固定 `{calls:[{id,name,arguments}]}`。`anyOf`、`kind=tool_call/tool_calls` 和对应开关已移除；精确参数和顺序仍由 Runtime 校验。
- Planning、Fact/Entity Memory、raw/recent Context、受限 `click→type` GUI Batch 已可插拔；Batch 同时覆盖 CUA Adapter 与 OSWorld Adapter 的执行边界。
- GLM-5.3-Flash 与 Qwen3.8-Flash 已完成无桌面真实 API conformance；Composite、Planning、Fact/Entity Memory 均有成功证据。

详细证据：[Qwen flat 回归与集成验收](./qwen-flat-regression-and-integration-acceptance-2026-09-15.md)、[源码迁移审计](./qwen-flat-source-audit-and-migration-2026-09-15.md)。

## 2. 仍未冻结的内容

G0 评测准备仍由并行验证线负责。当前修订 3 manifest 保持 20 Development + 20 Validation；两侧动态负态预检均已完成，原 V19 因 Hugging Face 输入缓存 TLS 失败由同层备用 R10 替代，证据见 `g0-preflight-progress-2026-09-10.md`。验证线仍需完成 evaluator 正/负（适用时部分）校准、预算回填和最终 manifest 冻结；在此之前不得启动正式效果实验，也不得把 score=0 的负态预检写成模型结果。

当前尚未创建正式实验冻结 tag。验证集闭合后，必须一次性记录源码版本、Provider 参数、模块开关、任务 manifest、OSWorld 快照、预算和环境版本，再开始效果消融。

## 3. 下一阶段实验矩阵

使用同一冻结版本和同一任务分集，先 Development 后 Validation：

| 组别 | 配置 | 目的 |
|---|---|---|
| P | 全部增强关闭、`raw` Context、Batch off | 原始基线 |
| C | 只启用 Context 策略 | 测 Context Size、Tokens、Latency 变化 |
| B | C + 受限 GUI Batch | 测 Model Turns、Primitive Actions 和 Batch Failure |
| M1 | C + Fact Memory | 测裁剪后关键事实保留与召回 |
| M2 | C + Entity Memory | 测实体状态维护是否有额外收益 |
| N | C + Planning | 测阶段规划是否改善长任务稳定性 |

每组记录 Task Success、Partial Reward、Model Turns、Primitive Actions、Screenshots、Tokens、Latency、Context Size、Memory Ops、Extra Model Calls、Repeated Actions、Batch Failure Rate、Plan Usage 和 Recovery Rate。全开组合只验证互操作，不作为首个效果结论。

## 4. 执行顺序与停止条件

1. 等待 G0 完成所有 Validation 动态预检、evaluator 正/负校准、历史暴露检查和预算回填。
2. 冻结代码/配置/任务/快照，保存一份 baseline 运行证据。
3. 在 Development 上按 P→C→B→M1/M2/N 做单变量消融；每次只改变一个模块。
4. 某模块若没有稳定收益或增加失败/延迟，保留接口但默认关闭，记录回退理由，不继续堆叠新功能。
5. Development 通过后再运行 Validation；Validation 期间不调参数。

真实任务命令以各路线文档和 G0 收口后的 manifest 为准。Qwen 只使用统一 flat 协议，不再运行 anyOf 对照；真实 CUA 与 OSWorld 仍分别统计，不混算。

## 5. 暂不进入的工作

Sandbox 后端、Subagent/Delegation、跨 Run Memory、自动逐步语义 Verifier 和复杂压缩策略不属于本阶段入口。P/C/B/M1/M2/N 效果实验不得混入尚未冻结的 Guard。

最新产品顺序允许最小 Risk Guard 在独立开关和独立测试下与 G0/Development 准备并行开发。它必须复用现有 RuntimePolicy、Approval、Inbox、Event 和 Batch 边界；关闭后保持当前基线。Risk Guard 受控验收后暂停新增功能，转向真实 CUA 稳定性、延迟、诊断和使用体验；统一后的全局设计与整改依据见[产品与架构基线](./multimodal-gui-agent-harness-product-plan.md)和[全局设计文档一致性审计](./global-design-consistency-audit-2026-09-15.md)。

Risk Guard 的当前唯一施工说明为 [Risk Guard 模块实施计划](./risk-guard-implementation-plan-2026-09-15.md)。该路线可以与 G0 预检并行，但不得自行启动正式 OSWorld 评测，也不得将 Guard 结果混入 P/C/B/M1/M2/N 首轮消融。

## 6. 文档边界

Risk Guard 已实现同轮逐 Computer 调用效果声明、分层策略、Approval 与按需语义复核；类型检查和 mock 回归通过。不以 Goal 关键词触发全程复核，也不依赖 OCR/Accessibility。真实 GLM/Qwen API 声明稳定性、真实 CUA 审批屏幕一致性和风险效果仍未验证，因此不改变正式 P/C/B/M1/M2/N 消融基线，也不混入现有结果。

本文件是当前阶段入口；`DOCS-INDEX.md` 是唯一导航。G0 候选与预检在验证集闭合前保留在当前目录。已经完成的 Stage 4/5 施工记录、旧 Planning 计划和旧 G1–G3 审计移入 `docs/history/`，只用于追溯，不再作为实施指令。

## 7. GitHub 发布前文档复核

2026-09-15 已复核 README、当前 `docs/` 文件和 OSWorld integration README：

- 删除了本机盘符、用户名、相邻工作树名以及本机 Python、VMX、VMware 路径；可执行命令统一使用仓库相对路径和 `<OSWORLD_ROOT>`、`<OSWORLD_VMX>`、`<ENV_FILE>` 等占位符；
- README 与 OSWorld 路线已改为当前固定 `calls[]`、双后端 fake fixture 已通过和 `clean_r4` 快照口径；
- 产品/架构、Run/Turn、Run Memory/长期演进和意图守护四份全局文档已统一到当前协议与优先级；
- Markdown 本地链接均可解析，且不再链接 Git 忽略的 `runs/` 或 `docs/history/` 资产；
- UTF-8 扫描未发现替换字符或连续问号损坏。

这项复核只表示公开文档可复现且状态一致，不改变本阶段门槛：工程收敛已完成，G0 evaluator 校准、预算回填、manifest 与实验版本冻结仍未完成。

# Stage 5 模型任务结果总表

日期：2026-09-07
文档角色：当前总体评测结果 / 后续原因分析入口
状态：当前执行
任务集：OSWorld 首批冻结任务 S01–S10、M01–M10、H01–H10
评测依据：官方 evaluator score；`runtimeOutcome` 只描述 Harness 是否正常收尾，不能替代 evaluator

## 1. 固定实验条件

- OSWorld commit：`fc31a9049664292fcb35d6e501ee1dc839f2cf6d`；
- VM 快照：`osworld_initial_1920x1080_clean_r4_20260906`；
- GLM：`glm-5.3-flash`，使用 GLM native tool calling；
- Qwen：Qwen3.8 Flash，使用当前 strict-json 路径；
- 任务定义：见 [首批任务候选集](./stage-5-osworld-first-batch-task-candidates-2026-09-06.md)；
- 结果目录：`runs/` 下的对应运行目录；原始截图和请求只保留本地，不提交；
- 本表没有启用重复动作提示、Verifier、额外 Memory 或其他任务特定干预。

本轮另外重跑了此前发生 Provider 网络失败的 GLM M10、H09、H10，重跑结果优先用于本表；第一次失败记录仍保留在原始目录中。

## 2. GLM 全部 30 个任务

| ID | 任务 | evaluator | runtimeOutcome | steps / requests | 结论或异常 |
|---|---|---:|---|---:|---|
| S01 | Chrome：开启 Do Not Track | 1 | succeeded | 6 / 7 | 通过 |
| S02 | Chrome：新建 Favorites 书签文件夹 | 1 | succeeded | 9 / 10 | 通过 |
| S03 | Chrome：调整默认字体大小 | 1 | succeeded | 6 / 7 | 通过 |
| S04 | Writer：前两段改双倍行距 | 1 | succeeded | 16 / 19 | 通过；有 7 次无副作用的 ToolCall 拒绝 |
| S05 | Writer：添加页码 | 1 | succeeded | 15 / 16 | 通过 |
| S06 | Writer：导出同名 PDF | 0.997741 | succeeded | 4 / 5 | 接近通过，需单独看 evaluator 差异 |
| S07 | Calc：复制 Revenue 列到 Sheet2 | 1 | succeeded | 7 / 8 | 通过 |
| S08 | Calc：复制并重命名工作表 | 0 | budget_exhausted | 20 / 20 | 达到简单任务预算 |
| S09 | Calc：新增 Profit 列并计算 | 1 | succeeded | 10 / 11 | 通过 |
| S10 | Calc：导出同名 CSV | 0 | outcome_unknown | 9 / 10 | 动作后 viewport 为 1920×1079，触发未知副作用 |
| M01 | Chrome：修改 profile 用户名 | 1 | succeeded | 8 / 9 | 通过 |
| M02 | Chrome：关闭时清除浏览数据 | 0 | budget_exhausted | 30 / 30 | 达到中等任务预算 |
| M03 | Thunderbird：新建两个本地文件夹 | 1 | succeeded | 23 / 24 | 通过 |
| M04 | Thunderbird：建立 Promotions 过滤器 | 1 | budget_exhausted | 30 / 30 | evaluator 通过，但 Run 未正常 finish |
| M05 | Thunderbird：设置纯文本签名 | 1 | succeeded | 10 / 11 | 通过 |
| M06 | Calc：冻结 A1:B1 表头 | 1 | succeeded | 9 / 10 | 通过 |
| M07 | Calc：计算 Period Rate 并突出最高值 | 1 | succeeded | 10 / 11 | 通过 |
| M08 | Calc：计算月度总销售并生成折线图 | 1 | succeeded | 18 / 19 | 通过 |
| M09 | Calc + Chrome：补全教授邮箱 | 0 | budget_exhausted | 30 / 30 | 达到中等任务预算 |
| M10 | PDF + VLC：设置全局播放/暂停快捷键 | 1 | outcome_unknown | 15 / 17 | 重跑 evaluator 通过，但出现 2 次非法 ToolCall；动作后 viewport 变为 1280×800 |
| H01 | Thunderbird + Calc：联系人 CSV 转 XLSX | 1 | succeeded | 19 / 21 | 通过 |
| H02 | Thunderbird + Calc：提取最新 5 封邮件生成报告 | 1 | succeeded | 27 / 28 | 通过 |
| H03 | Thunderbird + Calc + OS：提取 AWS 发票并追加 tally | 0 | succeeded | 34 / 35 | 模型自报完成，但 evaluator=0 |
| H04 | Thunderbird + OS：导出图片并设桌面背景 | 0 | outcome_unknown | 13 / 15 | 非法按键参数导致 Runtime 拒绝并进入 unknown side effect |
| H05 | Calc：销售总额、增长率和两类图表 | 0 | budget_exhausted | 50 / 50 | 达到困难任务预算 |
| H06 | Calc：Gross Profit 与 Year_Profit | 1 | succeeded | 19 / 20 | 通过 |
| H07 | Calc：Revenue 与产品 Pivot Table | 1 | succeeded | 35 / 36 | 通过 |
| H08 | VS Code + Writer：TXT 合并为 DOCX 并统一字号 | 1 | budget_exhausted | 50 / 53 | evaluator 通过，但预算耗尽且有 3 次网络重试 |
| H09 | GIMP + Writer + OS：去背景并保存 JPG | 0 | failed | 23 / 27 | 重跑后仍发生 GLM 网络失败，未正常结束 |
| H10 | OS + Image：筛选照片并压缩 ZIP | 0 | failed | 1 / 5 | 重跑后仍发生 GLM 网络失败 |

### GLM 汇总

| 难度 | 任务数 | evaluator=1 | 非满分 | evaluator=0 |
|---|---:|---:|---:|---:|
| 简单 | 10 | 7 | 1（S06） | 2 |
| 中等 | 10 | 8 | 0 | 2 |
| 困难 | 10 | 5 | 0 | 5 |
| **合计** | **30** | **20** | **1** | **9** |

GLM 的 20/30 只表示官方 evaluator 的原始结果，不等于 20 个 Run 都正常完成：M04、H08 evaluator 已通过但
预算耗尽；M10 evaluator 通过但 Runtime 为 `outcome_unknown`。H03 则反过来是 Runtime 正常结束但 evaluator=0。
这 30 个 Run 的记录 token 合计约 **5,951,879**。

## 3. Qwen 已完成的 5 个任务

| ID | 任务 | evaluator | runtimeOutcome | steps / requests | 结论或异常 |
|---|---|---:|---|---:|---|
| S01 | Chrome：开启 Do Not Track | 1 | succeeded | 7 / 8 | 通过 |
| S04 | Writer：前两段改双倍行距 | 0 | succeeded | 46 / 50 | strict-json 可重试，但最终目标未通过 |
| S07 | Calc：复制 Revenue 列到 Sheet2 | 1 | succeeded | 6 / 7 | 通过 |
| M03 | Thunderbird：新建两个本地文件夹 | 0 | budget_exhausted | 50 / 51 | 反复点击，无有效状态推进 |
| H01 | Thunderbird + Calc：联系人 CSV 转 XLSX | 0 | budget_exhausted | 50 / 50 | 反复点击，无有效状态推进 |

Qwen 当前为 **2/5 evaluator 满分**。S04 的主要问题是语义目标未被完成而不是 strict-json 传输失败；M03/H01
表现为没有效果后的恢复策略不足。
这 5 个 Run 的记录 token 合计约 **855,238**。

## 4. 运行证据来源

### GLM

- S01：`runs/stage5-attended-smoke-20260906/glm/S01-chrome-dnt/`；
- S04：`runs/stage5-clean-r4-glm-writer-20260906/`；
- S07、M03、H01：`runs/stage5-clean-r4-round2-glm-s07-20260906/`、
  `stage5-clean-r4-round2-glm-m03-20260906/`、`stage5-clean-r4-round2-glm-h01-20260906/`；
- 其余首次扫描：`runs/stage5-clean-r4-full-glm-20260906/`；
- M10、H09、H10 网络失败重跑：`runs/stage5-clean-r4-glm-network-rerun-20260907/`。

### Qwen

- S01：`runs/stage5-attended-smoke-20260906/qwen/qwen-S01-chrome-dnt/`；
- S04、S07、M03、H01：`runs/stage5-clean-r4-round2-qwen-s04-20260906/`、
  `stage5-clean-r4-round2-qwen-s07-20260906/`、`stage5-clean-r4-round2-qwen-m03-20260906/`、
  `stage5-clean-r4-round2-qwen-h01-20260906/`。

每个运行目录包含 `runner.json`、`harness/summary.json`、`trajectory.jsonl` 和脱敏的
`provider-exchanges.jsonl`；不要把截图、VM 或 API key 提交到 Git。

## 5. 后续原因分析入口

1. **Provider 稳定性**：GLM M10 重跑成功，但 H09/H10 仍重复网络失败；应把网络可用性作为独立实验变量，不能把这两个任务的 0 分直接归因于 GUI 能力。
2. **Runtime 收尾语义**：M04、H08、M10 说明 evaluator 成功、模型 finish 和 Runtime 正常收尾是三个独立事实，后续统计必须分列保留。
3. **Viewport 合同**：S10 出现 1920×1079，M10 重跑出现 1280×800，说明 clean snapshot 不能完全消除瞬时显示变化；需要继续区分 VM 显示状态问题与任务动作问题。
4. **动作参数与恢复**：H04 的非法按键由 Runtime 拒绝是安全行为，但模型没有及时改用可接受动作；Qwen M03/H01 则需要研究无效果动作后的 re-observe/恢复策略。
5. **完成判断**：H03 与 Qwen S04 都说明模型自报完成不能作为成功标准，必须以 evaluator 和可重建轨迹为准。

本文件是后续模型、Context、Tool 和 Runtime 原因分析的唯一结果入口；旧的单轮 smoke 和中间审计文档只保留在 `docs/history/`。

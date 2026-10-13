# 成员C：有效样本与证据清单

历史整理日期：2026-10-10；公开整理日期：2026-10-11。本文转述既有材料的提取结果；本次仅公开整理，未重读私人原始报告、轨迹或截图，也未新增桌面操作、模型调用、业务评测或验证。

## 使用口径

- 本轮范围为三处历史轨迹目录的20份JSONL，加10-08三个Windows真实模型Run的摘要/审计/oracle，以及四类辅助验证。不是整个工作区所有历史实验的全量业务成绩。
- 10-10历史提取记录重新解析20份JSONL共1603个事件，并报告20个文件hash均与10-07索引一致。该历史核对不是本PR原件核验；14个不同runId不等于14个独立题：8份fixture复用了两个runId。
- 历史12份非fixture轨迹属于基础设施/任务尝试；没有在本轮独立核对业务终态，不据Runtime成功计业务成功。三个WindowsRun也不是三道独立D01题。
- 下表请求/响应是事件数；fixture中的“模型”事件是模拟链路，不能算云API调用或真实性能。
- 本清单只发布白名单元数据和结论，不复制goal/model正文、个人目录、截图或私人报告正文。原件标为 **retained privately / not included**；本PR自身不能重核原件，也没有原件下载链接。历史hash只绑定历史字节，不是本PR新文件hash或核验通过标志。

## 历史轨迹逐文件清单

| ID | 分类 | Runtime终态 | 事件数 | 请求/响应事件 | GUI开始/完成事件 | 观察事件 | 事件耗时（秒） |
|---|---|---|---:|---:|---:|---:|---:|
| H01 | Linux CUA尝试 | failed | 5 | 0/0 | 0/0 | 0 | 0.047 |
| H02 | Linux CUA尝试 | failed | 336 | 43/43 | 40/40 | 41 | 996.421 |
| H03 | Linux CUA尝试 | failed | 16 | 2/1 | 1/1 | 2 | 357.255 |
| H04 | Linux CUA尝试 | failed | 272 | 34/33 | 33/32 | 33 | 949.906 |
| H05 | Linux CUA尝试 | 未知 | 86 | 11/10 | 10/10 | 11 | 未知 |
| H06 | Linux CUA尝试 | succeeded | 8 | 1/1 | 0/0 | 1 | 30.529 |
| H07 | OSWorld尝试 | succeeded | 136 | 17/17 | 16/16 | 17 | 215.211 |
| H08 | OSWorld尝试 | succeeded | 208 | 26/26 | 25/25 | 26 | 271.522 |
| H09 | 合成fixture | succeeded | 22 | 2/2 | 2/2 | 3 | 0.019 |
| H10 | 合成fixture | succeeded | 22 | 2/2 | 2/2 | 3 | 0.015 |
| H11 | OSWorld尝试 | 未知 | 134 | 17/16 | 16/15 | 17 | 未知 |
| H12 | OSWorld尝试 | 未知 | 18 | 2/2 | 2/1 | 2 | 未知 |
| H13 | OSWorld尝试 | succeeded | 80 | 10/10 | 9/9 | 10 | 166.509 |
| H14 | OSWorld尝试 | succeeded | 128 | 16/16 | 15/15 | 16 | 192.314 |
| H15 | 合成fixture | succeeded | 22 | 2/2 | 2/2 | 3 | 0.006 |
| H16 | 合成fixture | succeeded | 22 | 2/2 | 2/2 | 3 | 0.003 |
| H17 | 合成fixture | succeeded | 22 | 2/2 | 2/2 | 3 | 0.007 |
| H18 | 合成fixture | succeeded | 22 | 2/2 | 2/2 | 3 | 0.003 |
| H19 | 合成fixture | succeeded | 22 | 2/2 | 2/2 | 3 | 0.007 |
| H20 | 合成fixture | succeeded | 22 | 2/2 | 2/2 | 3 | 0.003 |

“完成事件”可能承载partial/refused，不等于业务完成；本批历史回执的详细状态在机器索引中。无run.finished的H05/H11/H12不以已观察跨度充当总耗时。

### 每项来源

下列来源ID只定位本包[公开来源目录](#公开来源目录)的元数据条目，不代表发布原始轨迹。

- **H01**：来源 `SRC001`；artifact kind `JSONL`；runId `run-1791168830024-016e21e7-489`；原SHA-256 `fded549e349065c3d9e2fd5c9c21cec19aa4c0ce9f7b1d262938d04c99a371ad`；retained privately / not included。
- **H02**：来源 `SRC002`；artifact kind `JSONL`；runId `run-1791075727513-718ffb8d-29c`；原SHA-256 `17ddb2ac16f9b47797635d069903e4ff2f62c90a24284665f75feca562b8d080`；retained privately / not included。
- **H03**：来源 `SRC003`；artifact kind `JSONL`；runId `run-1791077021577-76fcd530-037`；原SHA-256 `9624031cc3b4e603611c5a088077cf78dbce85b87e72f61a6eb6aa0c7d0d70a0`；retained privately / not included。
- **H04**：来源 `SRC004`；artifact kind `JSONL`；runId `run-1791077596213-54141e04-de9`；原SHA-256 `b864f899812bc7bde2bf0c7c6a1051514674ba3ca1c1c27f691fe6914540f861`；retained privately / not included。
- **H05**：来源 `SRC005`；artifact kind `JSONL`；runId `run-1791080566642-88f9f7c0-abb`；原SHA-256 `07f3a95cc50d2651706c2ccb862145d426c09e190e6279751b411cfa4ef6d1f1`；retained privately / not included。
- **H06**：来源 `SRC006`；artifact kind `JSONL`；runId `run-1790998278082-2a178333-c30`；原SHA-256 `f9cac3b6e0115903b1b879db1f601fc49fcdffb11500c729f242add732f87572`；retained privately / not included。
- **H07**：来源 `SRC007`；artifact kind `JSONL`；runId `run-1789624205205-4e4a2782736168`；原SHA-256 `e220a0f82bcb4c699ada0b5746589b5042a34ee93704a08719a177d8ee614e39`；retained privately / not included。
- **H08**：来源 `SRC008`；artifact kind `JSONL`；runId `run-1789626932229-ab26811bd0a288`；原SHA-256 `66f29e598aad07fe7d4fc70cfbe1b0c6a5b06c2989c5eed2df1a9327eb679800`；retained privately / not included。
- **H09**：来源 `SRC009`；artifact kind `JSONL`；runId `batch-backend-cua`；原SHA-256 `5a6b27e1d0cb9abb61c1f116188bd0a9c85be9017dce150d750a1bbd8fa35b46`；retained privately / not included。
- **H10**：来源 `SRC010`；artifact kind `JSONL`；runId `batch-backend-osworld`；原SHA-256 `2f50691a93c8453487497ffb882a941401b6202f26d7ef5cf5e2b2a39f8fef43`；retained privately / not included。
- **H11**：来源 `SRC011`；artifact kind `JSONL`；runId `run-1790245787601-f645dcc6-e82`；原SHA-256 `7091a67636b041d30b9dcc2f4f746ea1e1c1d062bbe89631290a751a5456f23a`；retained privately / not included。
- **H12**：来源 `SRC012`；artifact kind `JSONL`；runId `run-1790229060318-9825468a-a6a`；原SHA-256 `1f7b5dfa5ad14f16cafe88496ca14902c4303faa1cb980505ad171356107bfe9`；retained privately / not included。
- **H13**：来源 `SRC013`；artifact kind `JSONL`；runId `run-1790227960154-a434c361-dc2`；原SHA-256 `fa7f51580ce9d7cbb6599738f3262b65f0a916ae9ce111e897f5893986900fab`；retained privately / not included。
- **H14**：来源 `SRC014`；artifact kind `JSONL`；runId `run-1790175270192-353e3b5a-58b`；原SHA-256 `b94d6e2e1cd7fe1eca32eaf2ac2831fe70a378846bbd9fe86ddbc55fb3aca1e0`；retained privately / not included。
- **H15**：来源 `SRC015`；artifact kind `JSONL`；runId `batch-backend-cua`；原SHA-256 `80ecc2d6a708388920856b161714626c4470ca062be399928e4d2c3221a0da50`；retained privately / not included。
- **H16**：来源 `SRC016`；artifact kind `JSONL`；runId `batch-backend-osworld`；原SHA-256 `a13838174b859bbb5d12a67152642ec2c06eacd8081719bdf7e86a4558581362`；retained privately / not included。
- **H17**：来源 `SRC017`；artifact kind `JSONL`；runId `batch-backend-cua`；原SHA-256 `7dca2d57e8f25a16108732fada1a67ce2d688ca0dd7545c02b41560f2de1f594`；retained privately / not included。
- **H18**：来源 `SRC018`；artifact kind `JSONL`；runId `batch-backend-osworld`；原SHA-256 `ff120e04b37ab584ece713c5959c331e777cefb8ec8ec238868603391cf67e9d`；retained privately / not included。
- **H19**：来源 `SRC019`；artifact kind `JSONL`；runId `batch-backend-cua`；原SHA-256 `f19cdc928b6e1de305a5bf05f15915600cb74796474c25569eb1e2a16149533f`；retained privately / not included。
- **H20**：来源 `SRC020`；artifact kind `JSONL`；runId `batch-backend-osworld`；原SHA-256 `810d836f57f2aed5156ce6b3cd75d8f664900fe62414edbefcaa56ff9b2ea675`；retained privately / not included。

## 重复、同题与副本关系

- **H09/H15/H17/H19**复用同一CUA fixture runId；**H10/H16/H18/H20**复用同一OSWorld fixture runId。各文件hash不同，是多版本fixture快照；保留回归证据，不作为8个独立真实任务。
- **H02/H03/H04**的原始Goal字节hash相同，但runId不同；这是同目标尝试，不能合成一次成功或作为独立题重复算。
- **H07/H08/H11/H13/H14**原始Goal字节hash相同；H12也属OSWorld记录但Goal不同。未冻结任务变体，不把6份OSWorld轨迹算6道独立题。
- **W02/W03**同一跨应用任务的两轮新Run；第二轮改用新空白编辑器和foreground-caret路径，不是同配置稳定性重复。不得删首轮失败。
- 同一WindowsRun的summary、audit、oracle、acceptance是不同证据投影，不是更多运行样本。

## Windows三个真实模型Run

| ID | 任务范围 | Runtime | 外部实际结果 |
|---|---|---|---|
| W01 | 自主GLM单应用中文输入、保存、重开 | succeeded | 完整：仅限测试正文逐字输入、保存与GUI重开，不是医疗入口任务 |
| W02 | NHS跨应用首轮：UIA多行失败 | outcome_unknown | 失败/未交付：换行损坏且未保存；草稿来源事实有偏差 |
| W03 | NHS跨应用第二轮：技术交付通过、来源验收未过 | succeeded | 部分：文件交付与重开精确；健康报告来源一致性未全通过 |

### W01：证据绑定

Run `run-1791407478249-b5138a9c-185`；模型 `glm-5.3-flash`，源码基线 `079c1c4`，候选驱动 `7852ab1`。
- 来源 `SRC021`（acceptance）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。
- 来源 `SRC022`（summary）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。
- 来源 `SRC023`（audit）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。
- 来源 `SRC024`（oracle）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。

### W02：证据绑定

Run `run-1791409262649-f5fe1db8-86d`；模型 `glm-5.3-flash`，源码基线 `079c1c4`，候选驱动 `7852ab1`。
- 来源 `SRC027`（failed_run_summary）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。
- 来源 `SRC026`（failure_analysis）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。
- 来源 `SRC028`（oracle）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。

### W03：证据绑定

Run `run-1791409688300-a0a52941-612`；模型 `glm-5.3-flash`，源码基线 `079c1c4`，候选驱动 `7852ab1`。
- 来源 `SRC029`（summary）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。
- 来源 `SRC030`（audit）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。
- 来源 `SRC031`（oracle）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。
- 来源 `SRC025`（acceptance）；历史hash、runId绑定及kind见[公开来源目录](#公开来源目录)；retained privately / not included。

W02/W03实跑为079c1c4加原几何overlay；组长10-09追加ef007af/8bf63ac后修正版没有由这些10-08记录取得新实机验收。Windowsguest绝对时间有偏差，日期沿用宿主归档记录，耗时使用同源相对差。

## 辅助验证（不计自主业务样本）

### S01：候选驱动输入/追加/保存/重开及双原生窗口往返

两阶段通过；受管浏览器阶段multiple_candidates失败。指定动作fixture，不是自主模型任务。

- 来源 `SRC034`；历史hash及kind见[公开来源目录](#公开来源目录)；retained privately / not included。

### S02：Runtime只观察后结束与取消

succeeded/0动作与cancelled/0动作；owner释放。原取消smoke因期望aborted错误而ok=false，后续独立汇总确认cancelled，保留原失败。不能证明进行中动作取消或手机控制。

- 来源 `SRC033`；历史hash及kind见[公开来源目录](#公开来源目录)；retained privately / not included。
- 来源 `SRC032`；历史hash及kind见[公开来源目录](#公开来源目录)；retained privately / not included。

### S03：Windows离线/构建与真实DOM绑定

原079c1c4阶段1817 Vitest/71 Node；初版几何overlay阶段1820 Vitest及真实NHS DOM通过。历史数量，非当前head或本轮复测。

- 来源 `SRC032`；历史hash及kind见[公开来源目录](#公开来源目录)；retained privately / not included。
- 来源 `SRC037`；历史hash及kind见[公开来源目录](#公开来源目录)；retained privately / not included。

### S04：evaluator P1假阳性修复与真实CLI合成导入

同输入success/true→inconclusive/false；136回归及四种CLI导入组合历史通过。合成合同证据，不是真实D01评分。

- 来源 `SRC035`；历史hash及kind见[公开来源目录](#公开来源目录)；retained privately / not included。

## 完整性与定位

逐文件历史字节hash、runId、事件时间、回执、usage覆盖、工具类型和全部来源hash见[evidence-index.json](./evidence-index.json)。四类证据见[汇总](./evidence-summary.md)，展示边界见[demo候选](./demo-candidates.md)。

没有运行D01评分器、补写真人审核或推导整体成功率。

## 公开来源目录

此目录保留10-10索引全部38项来源的历史字节长度、SHA-256、artifact kind及已记录的样本/runId绑定。全部原件均 **retained privately / not included**；没有原件下载链接，PR自身无法重新核原件。`—`表示输入材料没有记录该支持材料的runId绑定，不能补造。`MAT01`–`MAT04`对应本次转换所读四份材料，输入hash保存在[机器索引](./evidence-index.json)的 `publication_provenance.input_materials`，同样不是公开新文件hash。

| 来源ID | artifact kind / role | 关联样本 | runId绑定 | 原字节数 | 原SHA-256 |
|---|---|---|---|---:|---|
| SRC001 | JSONL / trajectory | H01 | `run-1791168830024-016e21e7-489` | 1909 | `fded549e349065c3d9e2fd5c9c21cec19aa4c0ce9f7b1d262938d04c99a371ad` |
| SRC002 | JSONL / trajectory | H02 | `run-1791075727513-718ffb8d-29c` | 691078 | `17ddb2ac16f9b47797635d069903e4ff2f62c90a24284665f75feca562b8d080` |
| SRC003 | JSONL / trajectory | H03 | `run-1791077021577-76fcd530-037` | 31001 | `9624031cc3b4e603611c5a088077cf78dbce85b87e72f61a6eb6aa0c7d0d70a0` |
| SRC004 | JSONL / trajectory | H04 | `run-1791077596213-54141e04-de9` | 519713 | `b864f899812bc7bde2bf0c7c6a1051514674ba3ca1c1c27f691fe6914540f861` |
| SRC005 | JSONL / trajectory | H05 | `run-1791080566642-88f9f7c0-abb` | 92572 | `07f3a95cc50d2651706c2ccb862145d426c09e190e6279751b411cfa4ef6d1f1` |
| SRC006 | JSONL / trajectory | H06 | `run-1790998278082-2a178333-c30` | 9158 | `f9cac3b6e0115903b1b879db1f601fc49fcdffb11500c729f242add732f87572` |
| SRC007 | JSONL / trajectory | H07 | `run-1789624205205-4e4a2782736168` | 73783 | `e220a0f82bcb4c699ada0b5746589b5042a34ee93704a08719a177d8ee614e39` |
| SRC008 | JSONL / trajectory | H08 | `run-1789626932229-ab26811bd0a288` | 103081 | `66f29e598aad07fe7d4fc70cfbe1b0c6a5b06c2989c5eed2df1a9327eb679800` |
| SRC009 | JSONL / trajectory | H09 | `batch-backend-cua` | 7459 | `5a6b27e1d0cb9abb61c1f116188bd0a9c85be9017dce150d750a1bbd8fa35b46` |
| SRC010 | JSONL / trajectory | H10 | `batch-backend-osworld` | 7517 | `2f50691a93c8453487497ffb882a941401b6202f26d7ef5cf5e2b2a39f8fef43` |
| SRC011 | JSONL / trajectory | H11 | `run-1790245787601-f645dcc6-e82` | 152680 | `7091a67636b041d30b9dcc2f4f746ea1e1c1d062bbe89631290a751a5456f23a` |
| SRC012 | JSONL / trajectory | H12 | `run-1790229060318-9825468a-a6a` | 11903 | `1f7b5dfa5ad14f16cafe88496ca14902c4303faa1cb980505ad171356107bfe9` |
| SRC013 | JSONL / trajectory | H13 | `run-1790227960154-a434c361-dc2` | 88594 | `fa7f51580ce9d7cbb6599738f3262b65f0a916ae9ce111e897f5893986900fab` |
| SRC014 | JSONL / trajectory | H14 | `run-1790175270192-353e3b5a-58b` | 139765 | `b94d6e2e1cd7fe1eca32eaf2ac2831fe70a378846bbd9fe86ddbc55fb3aca1e0` |
| SRC015 | JSONL / trajectory | H15 | `batch-backend-cua` | 7459 | `80ecc2d6a708388920856b161714626c4470ca062be399928e4d2c3221a0da50` |
| SRC016 | JSONL / trajectory | H16 | `batch-backend-osworld` | 7517 | `a13838174b859bbb5d12a67152642ec2c06eacd8081719bdf7e86a4558581362` |
| SRC017 | JSONL / trajectory | H17 | `batch-backend-cua` | 7459 | `7dca2d57e8f25a16108732fada1a67ce2d688ca0dd7545c02b41560f2de1f594` |
| SRC018 | JSONL / trajectory | H18 | `batch-backend-osworld` | 7517 | `ff120e04b37ab584ece713c5959c331e777cefb8ec8ec238868603391cf67e9d` |
| SRC019 | JSONL / trajectory | H19 | `batch-backend-cua` | 7459 | `f19cdc928b6e1de305a5bf05f15915600cb74796474c25569eb1e2a16149533f` |
| SRC020 | JSONL / trajectory | H20 | `batch-backend-osworld` | 7517 | `810d836f57f2aed5156ce6b3cd75d8f664900fe62414edbefcaa56ff9b2ea675` |
| SRC021 | structured-summary-or-audit / acceptance | W01 | `run-1791407478249-b5138a9c-185` | 1315 | `c214f96a84c8d715747634052671fd2112258ff568e1d2e446a917a444b8629e` |
| SRC022 | structured-summary-or-audit / summary | W01 | `run-1791407478249-b5138a9c-185` | 10658 | `37ea76970acc9d9929496a3f5cc8c6daa128cee8fe8a963957e310fa9576988b` |
| SRC023 | structured-summary-or-audit / audit | W01 | `run-1791407478249-b5138a9c-185` | 52388 | `f6d457521a24368f33015b15835e8ab9147903e57bcf308afecc1b5d614a3a68` |
| SRC024 | structured-summary-or-audit / oracle | W01 | `run-1791407478249-b5138a9c-185` | 921 | `0530bffc4337eea993178176258de20c6db160cdf8c2d8cd3040bb18c24d803d` |
| SRC025 | structured-summary-or-audit / acceptance | W03 | `run-1791409688300-a0a52941-612` | 2647 | `07e1279075499ab6ef68e407a11ab38ecd7d62d475d114b826de94ab8db4d24c` |
| SRC026 | structured-summary-or-audit / failure_analysis | W02 | `run-1791409262649-f5fe1db8-86d` | 1094 | `d4b6eba3b71937262c259995980a86c575090e2a24459d01509a0e95ec083e61` |
| SRC027 | structured-summary-or-audit / failed_run_summary | W02 | `run-1791409262649-f5fe1db8-86d` | 119112 | `640d287c2788cdb9d26b5cc3fc5dc2b2bf8ae273047a1730aa117026ee4d1352` |
| SRC028 | structured-summary-or-audit / oracle | W02 | `run-1791409262649-f5fe1db8-86d` | 6191 | `d6a6901b9e78c3e646156c08a7d12f54c23bca6e995eab53b9f546024c4a5a3d` |
| SRC029 | structured-summary-or-audit / summary | W03 | `run-1791409688300-a0a52941-612` | 184772 | `5b14cd01ab9fff27e3178d14455d972c935ca38f8afd1d1225f2b8019380d2a8` |
| SRC030 | structured-summary-or-audit / audit | W03 | `run-1791409688300-a0a52941-612` | 170774 | `af014fdfe8e9157f720b0a8f8634980be4736e9616957b433ea561b88eb37f07` |
| SRC031 | structured-summary-or-audit / oracle | W03 | `run-1791409688300-a0a52941-612` | 5319 | `516ef6a5cebbcea82a75178487789f458f4879cc62f285b9e79e4ab0b52f68a2` |
| SRC032 | structured-summary-or-audit / test_summary | S02/S03 | — | 3174 | `ebd30752e72c97600689dad2da4d88293fbef6a1264c0eec2e8335cd99349b3e` |
| SRC033 | structured-summary-or-audit / runtime_summary | S02 | — | 68177 | `2fe0d66370cc1e618e7f1155c20303852fa0f5053f48d1c25acee90c0925ae2e` |
| SRC034 | structured-summary-or-audit / driver_fixture_summary | S01 | — | 9352 | `7f539242002c932276fded435b92f88ed27e0fe5f20c531276f05b1b75b6176f` |
| SRC035 | supporting-record / evaluator_repair_summary | S04 | — | 3513 | `9a711547c9bb74a8d37d0e49e8220f0e95413ef32b31e22f84a3cb45e550fe50` |
| SRC036 | supporting-record / linux_attempt_report | — | — | 4858 | `eaafb262e1735ac8f135d4b59d9d432d8b67df888a076bc30db400cc0255c168` |
| SRC037 | supporting-record / geometry_repair_report | S03 | — | 6094 | `abf1d466bbedae019de83997b94f1fec072586fa3a2c05270714f8187a8b86cb` |
| SRC038 | supporting-record / windows_test_report | — | — | 9140 | `c35565501641d7dacb5a0aa1295703201429ede9b51cee6829f5b99e97333b50` |

W01/W03交付文件也未公开：来源标识分别为 `W01-OUTPUT` / `W03-OUTPUT`，kind为 `utf8_text_file`；原字节数183 / 1912与历史文件hash保存在机器索引 `windows[].output_artifact`。未公开正文，不能由PR重做逐字读回。W02未交付文件，相关字节数和hash仍为null。

## 公开schema与当前状态

公开索引schema为 `member-c-materials-publication/v1`：原 `source_path` / `source_paths` / `sources.path` 改为 `source_id` / `source_ids`，所有计数、关系、metrics及unknown/null保留；源ID通过 `sources` 关联，无本机目录依赖。完整变换与输入hash见机器索引 `publication_provenance`。原材料未修改，未把历史报告声称的结果变成本次独立核验。

本文保留10-10任务1历史口径。10-11任务合同冻结、候选迁入和六项无模型初态预检的当前状态见[总入口](../README.md)及[Windows预检](../windows-preflight.md)；业务仍blocked，当前0模型Run、0评分、0复跑。Windows层5 DOM观察退出0和CP02失败均不能判成任务成功。

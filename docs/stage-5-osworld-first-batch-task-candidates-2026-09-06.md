# Stage 5：OSWorld 首批真实任务候选集

日期：2026-09-06
文档角色：评测规划 / 候选集
状态：候选，不等于最终冻结集
数据源：本地 OSWorld `evaluation_examples/examples`，当前仓库扫描到 369 条任务

## 目标

为第一阶段 Harness 评测准备一个贴近日常工作的任务池，覆盖：

- 简单：Chrome、Writer、Calc 单应用操作；
- 中等：设置修改、文件/邮件整理、多窗口和浏览器 + Office；
- 困难：多应用协作、较长动作链、文件副作用和需要重新观察/恢复的任务。

本文件提供 30 个首批候选和 10 个备用候选。正式运行前必须完成无模型预检，确认任务文件、snapshot、初始截图、evaluator 和应用启动均正常；预检失败的任务由备用集替换，不修改 OSWorld 原始任务。

## 筛选规则

首批候选优先满足：

1. `proxy=false`，避免第一阶段把网络代理问题混入模型能力；
2. `possibility_of_env_change=low`；
3. evaluator 可观察、不是 `infeasible`；
4. 任务目标有明确完成状态，能够通过官方 evaluator 或文件/界面结果验收；
5. 不要求真实账号密码、发送邮件、修改系统账号或不可逆系统设置；
6. 每个任务都从同一 snapshot reset，运行后记录官方 score、runtimeOutcome、Provider 错误、轨迹长度、恢复行为和清理结果。

## 首批 30 个正式候选

### 简单：单应用基础操作（10）

| 编号 | Task ID | 应用 | 任务摘要 | 主要能力 |
|---:|---|---|---|---|
| S01 | `030eeff7-b492-4218-b312-701ec99ee0cc` | Chrome | 开启 Do Not Track | 设置导航、开关确认 |
| S02 | `2ad9387a-65d8-4e33-ad5b-7580065a27ca` | Chrome | 在书签栏新建 Favorites 文件夹 | 菜单、文本输入、保存 |
| S03 | `af630914-714e-4a24-a7bb-f9af687d3b91` | Chrome | 将默认字体大小调到最大 | 设置页面、可访问性相关操作 |
| S04 | `0810415c-bde4-4443-9047-d5f70165a697` | Writer | 前两段改为双倍行距 | 文本区域定位、格式菜单 |
| S05 | `0e47de2a-32e0-456c-a366-8c607ef7a9d2` | Writer | 每页左下角添加页码 | 插入页脚/页码、跨页状态 |
| S06 | `4bcb1253-a636-4df4-8cb0-a35c04dfef31` | Writer | 将当前文档导出为同名 PDF | 文件菜单、导出、文件结果 |
| S07 | `1273e544-688f-496b-8d89-3e0f40aa0606` | Calc | 将 Revenue 列复制到 Sheet2 | 选择范围、复制、跨工作表粘贴 |
| S08 | `0cecd4f3-74de-457b-ba94-29ad6b5dafb6` | Calc | 复制并重命名工作表及备份表 | 工作表标签、复制、重命名 |
| S09 | `1e8df695-bd1b-45b3-b557-e7d599cf7597` | Calc | 新增 Profit 列并计算 Sales-COGS | 公式填充、列定位 |
| S10 | `3aaa4e37-dc91-482e-99af-132a612d40f3` | Calc | 将当前表导出为同名 CSV | 导出设置、文件生成 |

### 中等：设置、文件、窗口和跨应用（10）

| 编号 | Task ID | 应用 | 任务摘要 | 主要风险 |
|---:|---|---|---|---|
| M01 | `2ae9ba84-3a0d-4d4c-8338-3a1478dc5fe3` | Chrome | 将 Chrome profile 用户名改为 Thomas | 设置层级较深、状态确认 |
| M02 | `99146c54-4f37-4ab8-9327-5f3291665e1e` | Chrome | 设置关闭浏览器时自动清除浏览数据 | 多级设置、误改其他隐私选项 |
| M03 | `a10b69e1-6034-4a2b-93e1-571d45194f75` | Thunderbird | 新建 COMPANY 和 UNIVERSITY 本地文件夹 | 邮件客户端导航、列表状态 |
| M04 | `5203d847-2572-4150-912a-03f062254390` | Thunderbird | 创建 Promotions 文件夹和主题过滤器 | 多步骤设置、规则保存 |
| M05 | `3f28fe4f-5d9d-4994-a456-efd78cfae1a3` | Thunderbird | 设置两行纯文本签名 | 账户设置、文本输入、保存 |
| M06 | `4188d3a4-077d-46b7-9c86-23e1a036f6c1` | Calc | 冻结 A1:B1 表头 | 视图设置、范围选择 |
| M07 | `21ab7b40-77c2-4ae6-8321-e00d3a086c73` | Calc | 计算 Period Rate 并突出最高值 | 公式、数值格式、条件/字体格式 |
| M08 | `0a2e43bf-b26c-4631-a966-af9dfa12c9e5` | Calc | 计算月度总销售并生成折线图 | 公式、数据范围、图表 |
| M09 | `c7c1e4c3-9e92-4eba-a4b8-689953975ea4` | Calc + Chrome | 根据表格中的主页链接补全教授邮箱 | 浏览器与表格切换、网络可用性 |
| M10 | `386dbd0e-0241-4a0a-b6a2-6704fba26b1c` | PDF + VLC | 在阅读 PDF 时启用 VLC 全局播放/暂停快捷键 | 多窗口、焦点、全局快捷键 |

### 困难：多应用、长轨迹和副作用恢复（10）

| 编号 | Task ID | 应用 | 任务摘要 | 主要风险 |
|---:|---|---|---|---|
| H01 | `c867c42d-a52d-4a24-8ae3-f75d256b5618` | Thunderbird + Calc | 导出联系人 CSV，再转换为 XLSX | 两应用、文件格式转换 |
| H02 | `d9b7c649-c975-4f53-88f5-940b29c47247` | Thunderbird + Calc | 提取 daily 文件夹最新 5 封邮件生成报告 | 信息抽取、排序、表格写入 |
| H03 | `415ef462-bed3-493a-ac36-ca8c6d23bf1b` | Thunderbird + Calc + OS | 提取 AWS 发票、按旧命名规则保存并追加 tally | 邮件附件、文件操作、表格追加 |
| H04 | `c2751594-0cd5-4088-be1b-b5f2f9ec97c4` | Thunderbird + OS | 导出邮件附件图片并设为桌面背景 | 附件提取、文件路径、系统状态 |
| H05 | `0326d92d-d218-48a8-9ca1-981cd6d064c7` | Calc | 计算总销售、增长率并生成两类图表 | 长公式链、多个图表、结果校验 |
| H06 | `035f41ba-6653-43ab-aa63-c86d449d62e5` | Calc | 计算 Gross Profit 并在新表生成 Year_Profit | 多列公式、跨表映射、文本拼接 |
| H07 | `51719eea-10bc-4246-a428-ac7c433dd4b3` | Calc | 计算 revenue 并生成产品 Pivot Table | 多表数据、公式、透视表 |
| H08 | `98e8e339-5f91-4ed2-b2b2-12647cb134f4` | VS Code + Writer | 合并项目 TXT 文件为 DOCX 并统一字号 | 文件集合、多应用、格式一致性 |
| H09 | `09a37c51-e625-49f4-a514-20a773797a8a` | GIMP + Writer + OS | 去除照片背景、换白底并保存 JPG | 图像编辑、文件保存、视觉结果 |
| H10 | `82e3c869-49f6-4305-a7ce-f3e64a0618e7` | OS + Image | 筛选活动照片、复制到新目录并压缩 ZIP | 视觉筛选、批量文件操作、恢复成本 |

## 备用候选 10 个

备用任务用于预检失败、网络不可用、快照缺失或应用状态污染时替换；不与首批同时计入正式结果。

| Task ID | 应用 | 任务摘要 | 备用原因 |
|---|---|---|---|
| `9656a811-9b5b-4ddf-99c7-5117bcef0626` | Chrome | 开启危险网站警告 | 单应用安全设置 |
| `0b17a146-2934-46c7-8727-73ff6b6483e8` | Writer | 将 H2O 中的 2 设为下标 | 精细文本格式 |
| `12382c62-0cd1-4bf2-bdc8-1d20bf9b2371` | Calc | 创建 Sales & COGS 柱状图 | 图表替换任务 |
| `21760ecb-8f62-40d2-8d85-0cee5725cb72` | Impress | 添加 dissolve 页面切换 | 演示文稿单功能 |
| `2cd43775-7085-45d8-89fa-9e35c0a915cf` | Impress | 开启每 3 分钟自动保存 | 设置持久化 |
| `dd84e895-72fd-4023-a336-97689ded257c` | Thunderbird | 给 Bills 文件夹全部邮件加星标 | 批量列表操作 |
| `30e3e107-1cfb-46ee-a755-2cd080d7ba6a` | Calc | 新表合并标题并生成三张 Pivot Table | 长表格替换 |
| `3299584d-8f11-4457-bf4c-ce98f7600250` | Chrome | 修改 Chrome 启动时打开的默认页面 | 单应用设置替换任务 |
| `a82b78bb-7fde-4cb3-94a4-035baf10bcf0` | Chrome + PDF | 查找作者主页并建立书签文件夹 | 浏览器研究任务，需网络预检 |
| `2a729ded-3296-423d-aec4-7dd55ed5fbb3` | GIMP | 将图片背景变透明 | 图像编辑替换任务 |

## 难度和预算建议

| 层级 | 典型动作数预期 | 单任务预算建议 | 重点观察 |
|---|---:|---:|---|
| 简单 | 2–8 | 12 steps / 16 model requests | 坐标、焦点、基本工具和完成判断 |
| 中等 | 6–16 | 20 steps / 24 model requests | 多窗口、历史上下文、工具结果和轻微恢复 |
| 困难 | 12–30 | 35 steps / 40 model requests | Context 压缩、跨应用状态、失败后重新观察、未决副作用 |

预算只是首轮上限，不代表允许模型无界探索；每个任务仍需从干净 snapshot 开始。

## 预检和正式运行顺序

1. 对 30 个首批候选执行无模型预检：任务 JSON 可加载、snapshot 匹配、Bridge reset 成功、初始截图存在、evaluator 可调用、清理成功。
2. 预检失败的任务从备用集替换，并记录替换原因；不得修改原始 task/evaluator。
3. 先做 3 个 attended smoke（每个难度 1 个），确认 Harness 的动作链、轨迹落盘和 evaluator 结果分层。
4. 再固定 task、snapshot、预算、坐标模式和 Provider，运行 GLM/Qwen 的同条件正式比较。
5. 基线完成前不修改 Task System、Context、Memory 或 Prompt；基线结束后按失败簇决定下一轮只改一个模块。

## 结果字段

每次运行至少记录：

- task ID、OSWorld commit、snapshot、模型和 Provider output mode；
- `runtimeOutcome`、官方 evaluator score、步数、模型请求数；
- invalid tool calls、Provider errors、恢复次数、`outcome_unknown`；
- `trajectory.jsonl`、`provider-exchanges.jsonl`、runner/evaluator/cleanup 结果；
- 任务是否因环境预检被替换。

本文件只冻结候选范围和选择理由，不把任何模型成功率预先写成结论。

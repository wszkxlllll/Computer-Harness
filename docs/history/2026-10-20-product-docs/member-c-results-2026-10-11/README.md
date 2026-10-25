# 成员C：任务1材料与任务2阶段成果

首次发布整理日期：2026-10-11；本轮修复与续验执行日期：2026-10-12；PR更新发布：2026-10-13。本目录统一交付已有轨迹材料、两域公开入口任务合同、Windows阶段记录及本轮CP02通用启动期限修复。不是新增业务成功或人审评分；除该受管浏览器启动修复外，不修改Runtime、Guard或evaluator实现。

## 结论与范围

**可以接收这份材料与冻结合同；尚不能据此宣称医疗、缴费两域业务demo成功。**

| 成果 | 已取得内容 | 未取得内容 |
| --- | --- | --- |
| 任务1：已有轨迹与交付材料 | 20份历史JSONL／1603事件的分类与重复关系；三个Windows真实模型Run的脱敏结果；四类材料、demo候选及缺口 | 未重新核验全部历史业务终态；没有据此计算D01成功率；原轨迹、私人报告及正文不在PR |
| 任务2：公开入口＋本地准备合同 | 医疗、缴费/社区各3族×2变体；官方入口、安全停止点、Goal、真值、reset/cleanup、合成输入、日期/输出实例工具及来源证据 | 不是旧真实预约、真实账单或平台内草稿任务成功；合同冻结不等于执行放行 |
| 任务2：Windows阶段结果与生产修复 | 保留10-11原失败/构建未知；新增CP02配置期限修复、Windows两步tsc/53项测试与真实DOM回归；六项开发实例的来源/新输出初态核对及11份官网附件 | 候选已带本地修复，未重新冻结运行版本；未独立核环境字节/版本；GLM实跑已暂停，0新模型Run、0评分、0D02 |

## 阅读入口

### 任务1

- [有效样本与证据清单](./materials/sample-inventory.md)：H01–H20、W01–W03、辅助验证与来源ID。
- [四类证据汇总](./materials/evidence-summary.md)：实际结果、效率/成本、模块作用、语音与无障碍体验。
- [demo候选与未验收项](./materials/demo-candidates.md)：技术展示可用范围及业务交付缺口。
- [机器索引与私有来源绑定](./materials/evidence-index.json)：分类、计数、关系、unknown/null及历史source hash。

W01为指定测试文本输入、保存、重开；W02为未交付的首轮失败；W03技术文件交付通过但医疗来源事实未全通过。保留W02，不将两轮不同配置挑选成稳定性通过。57次请求是这三个既有主模型Run的合计，不是本次发布调用模型。

### 任务2

- [冻结合同总入口](../../../../eval/candidates/member-c-public-local-d01-20261011/README.md)。
- [医疗任务卡](../../../../eval/candidates/member-c-public-local-d01-20261011/medical-task-cards.md) · [医疗manifest](../../../../eval/candidates/member-c-public-local-d01-20261011/medical-manifest.v1.json)。
- [缴费/社区任务卡](../../../../eval/candidates/member-c-public-local-d01-20261011/payment-task-cards.md) · [缴费/社区manifest](../../../../eval/candidates/member-c-public-local-d01-20261011/payment-manifest.v1.json)。
- [操作者来源真值](../../../../eval/candidates/member-c-public-local-d01-20261011/oracle-guidance.json)：不是任务模型输入的人审结论，也不是已完成评分。
- [实例准备工具](../../../../eval/candidates/member-c-public-local-d01-20261011/prepare-instance.py)：只展开Goal，不启动Harness或写任务成果。
- [Windows预检报告](./windows-preflight.md) · [机器摘要](./windows-preflight.json) · [已查看的公开网页初态截图](./windows-evidence/)。
- [10-12 CP02修复与六项来源/初态续核](./windows-preflight-2026-10-12.md) · [脱敏机器摘要](./windows-preflight-2026-10-12.json) · [本轮官网附件](./windows-evidence/2026-10-12/)。
- [受管浏览器生产修复](../../../../packages/computer-cua/src/managed-browser-host.ts)：HTTP导航就绪使用配置的有限期限，blank/data短期限不变；不扩大窗口或动作权限。

M01/M02/M03及CP01/CP02/CP03使用新的公开入口＋本地准备任务ID。旧2026-10-02平台草稿保持不变，仅作历史候选；不能用新合同重标旧Run，fixture、无模型初态与真实模型任务不能混算。

## 验证与证据层级

任务1整理、合同冻结及两次Windows阶段的日期和执行范围分别记录。原有136项evaluator修复属于独立PR#23，不包含在本PR；新增依赖修订PR#27也未混入。本次新增53项现有浏览器测试通过和真实CP02延迟场景回归，不能与旧测试或业务样本累计成验收数量。

首次发布消费结果见[publication-verification.json](./publication-verification.json)，仅代表2026-10-11历史发布。本次更新按用户最新指令不执行发布校验，不新增或宣称校验通过记录。此前已执行的Windows两步类型检查、53项测试及实际DOM回归按执行时点保留；发布阶段没有重跑Windows/CUA/模型或安装。

公开机器索引保留原件hash与来源ID，原件仍受控保留，不提供缺失文件的下载链接。读者可以核公开附件，但不能仅凭PR重算未公开轨迹或验证私人交付正文。官网截图归原运营主体，仅作来源/界面证据，不声明项目Apache-2.0涵盖第三方素材。

## 下一步门槛

CP02启动问题和六项公开来源/页面/新输出初态已在10-12补齐；原失败、诊断脚本误报和环境未独立核验仍保留。GLM仅进入读取合同与计划准备，已按用户新指令暂停，0新请求/Run。后续先重新冻结含本次修复的运行版本，再由用户重新决定运行授权与预算，按当时页面/日期核初态并安排可信人审；之后才做六个开发任务首轮Run、逐动作核对、评分及同版每题连续三次、至少两次独立启动/重置的D02验收。

不真实预约、不付款、不外发、不修改账户，不自动批准Guard或重放未知动作。费用缺项继续记未知，不用Runtime succeeded或模型自报替代业务成功。

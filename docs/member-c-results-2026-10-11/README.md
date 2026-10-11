# 成员C：任务1材料与任务2阶段成果

发布整理日期：2026-10-11。本目录统一交付已有轨迹材料、两域公开入口任务合同和已执行Windows初态预检。不是新增业务验收，也不修改Runtime、Guard、CUA或evaluator实现。

## 结论与范围

**可以接收这份材料与冻结合同；尚不能据此宣称医疗、缴费两域业务demo成功。**

| 成果 | 已取得内容 | 未取得内容 |
| --- | --- | --- |
| 任务1：已有轨迹与交付材料 | 20份历史JSONL／1603事件的分类与重复关系；三个Windows真实模型Run的脱敏结果；四类材料、demo候选及缺口 | 未重新核验全部历史业务终态；没有据此计算D01成功率；原轨迹、私人报告及正文不在PR |
| 任务2：公开入口＋本地准备合同 | 医疗、缴费/社区各3族×2变体；官方入口、安全停止点、Goal、真值、reset/cleanup、合成输入、日期/输出实例工具及来源证据 | 不是旧真实预约、真实账单或平台内草稿任务成功；合同冻结不等于执行放行 |
| 任务2：Windows阶段结果 | 新候选迁入、离线缓存安装和构建日志；六项无模型初态预检、五项DOM观察/清理退出0、CP02失败及只读诊断 | 原构建退出码缺失；完整任务初态未通过；0新模型Run、0评分、0稳定性复跑 |

## 阅读入口

### 任务1

- [有效样本与证据清单](./materials/sample-inventory.md)：H01–H20、W01–W03、辅助验证与来源ID。
- [四类证据汇总](./materials/evidence-summary.md)：实际结果、效率/成本、模块作用、语音与无障碍体验。
- [demo候选与未验收项](./materials/demo-candidates.md)：技术展示可用范围及业务交付缺口。
- [机器索引与私有来源绑定](./materials/evidence-index.json)：分类、计数、关系、unknown/null及历史source hash。

W01为指定测试文本输入、保存、重开；W02为未交付的首轮失败；W03技术文件交付通过但医疗来源事实未全通过。保留W02，不将两轮不同配置挑选成稳定性通过。57次请求是这三个既有主模型Run的合计，不是本次发布调用模型。

### 任务2

- [冻结合同总入口](../../eval/candidates/member-c-public-local-d01-20261011/README.md)。
- [医疗任务卡](../../eval/candidates/member-c-public-local-d01-20261011/medical-task-cards.md) · [医疗manifest](../../eval/candidates/member-c-public-local-d01-20261011/medical-manifest.v1.json)。
- [缴费/社区任务卡](../../eval/candidates/member-c-public-local-d01-20261011/payment-task-cards.md) · [缴费/社区manifest](../../eval/candidates/member-c-public-local-d01-20261011/payment-manifest.v1.json)。
- [操作者来源真值](../../eval/candidates/member-c-public-local-d01-20261011/oracle-guidance.json)：不是任务模型输入的人审结论，也不是已完成评分。
- [实例准备工具](../../eval/candidates/member-c-public-local-d01-20261011/prepare-instance.py)：只展开Goal，不启动Harness或写任务成果。
- [Windows预检报告](./windows-preflight.md) · [机器摘要](./windows-preflight.json) · [已查看的公开网页初态截图](./windows-evidence/)。

M01/M02/M03及CP01/CP02/CP03使用新的公开入口＋本地准备任务ID。旧2026-10-02平台草稿保持不变，仅作历史候选；不能用新合同重标旧Run，fixture、无模型初态与真实模型任务不能混算。

## 验证与证据层级

任务1整理、合同冻结及Windows预检的日期和执行范围分别记录。原有136项evaluator修复属于独立PR#23，不包含在本PR，也不把旧测试数计为这份材料的新增验收。

本次发布的实际消费结果见[publication-verification.json](./publication-verification.json)。该记录只证明脱敏附件、锁、相对链接、来源关系和实例工具可消费，不证明Windows部署同版、网页当下可用、模型业务成功或人审通过。没有重新执行Windows/CUA/模型任务，也没有新增系统安装。

公开机器索引保留原件hash与来源ID，原件仍受控保留，不提供缺失文件的下载链接。读者可以核公开附件，但不能仅凭PR重算未公开轨迹或验证私人交付正文。官网截图归原运营主体，仅作来源/界面证据，不声明项目Apache-2.0涵盖第三方素材。

## 下一步门槛

先定位CP02受管浏览器启动问题，完成M01页面加载、CP01价目图/遮挡、M02具体日期列、M03/CP03完整来源与新输出初态核对。之后按任务合同独立放行实际Run、逐动作核对、人审和评分，再执行同版每题连续三次、至少两次独立启动/重置的D02验收。

不真实预约、不付款、不外发、不修改账户，不自动批准Guard或重放未知动作。费用缺项继续记未知，不用Runtime succeeded或模型自报替代业务成功。

# Astra 本地目录与当前进度重新核对

日期：2026-10-12，Asia/Shanghai。本轮针对用户“认真核对现在本地目录内容”，只读检查源码、Git、最新文档、实际成果文件、原始轨迹和既有独检/CI收据；未启动测试、GUI、服务、Provider 或部署。Root 与 Sol 分别核对关键证据。本次仅更新本报告与文档入口。

## 结论：此前进度答复使用了过时快照

不能继续用 fa19cbb 或 10 月 11 日远端审查代表现在本地。当前源码 HEAD 为 `e7bce7f7792b455d02212c717a34206412002d14`，fa19cbb 后已有 21 个提交。最新计划/账本顶部更新到 10 月 12 日 11:53。

需要纠正三点：

1. T2 已经有完整保存、关闭、恢复、重开、内容核对的基线/独立重复/原变体三轮成功，不是“尚未保存重开”。通过范围是同版本 95b8449 的 CLI L2 experiment，riskGuard/riskModel off；不能据此签收默认 layered、正常 Web 全任务或手机。
2. 10 月 11 日查出的 F1–F4 已在 08dec5e 选择性修复；不能继续当作当前源码未修待办。未部署仍是独立未完成项。
3. 最新记录中原生候选权限已恢复并用于真实三轮任务。不能继续说本地任务都在等旧系统权限挑战。远端管理员认证/部署、实体手机与真人评分仍需分栏。

因此，“完整最终交付尚未验收”仍成立，但直接概括为“0/3、T2没有成果”会掩盖已完成的重要里程碑。准确表述应为：T2 的 CLI 三轮业务里程碑完成；T1、T3 业务未完成；正常 Web/default Host 的 T2 与手机、部署出口尚未关闭。

## 目录与源码事实

当前聊天声明目录 `Documents/ChatGPT/Computer-Harness` 只有旧诊断文件和 docs 子目录，不是这轮实际源码 checkout。实际源码、任务证据和计划位于 `Desktop/大创/Computer-Harness-three-track-integration`；本报告按实际 Git 根目录核对，没有复制或清理目录。

新增本报告之前，检查时有 16 个已跟踪修改和 272 个未跟踪文件；已跟踪修改限 AGENTS.md 与文档，没有已跟踪产品源码未提交差异。未跟踪内容包括长期历史文档/脚本及一份 CI JSON，不能把数量等同未完成任务，也不能未经核对整批提交或删除。私有 runs 由 Git 忽略。

fa19cbb 后的提交包括：Unicode HID 输入、浏览器几何与预览/结果反馈、原生窗口点位拒绝与隐藏 sheet 回退、授权文件单次重开、保存事实 Observation、重开后报告目标失效、Web 原生文稿 profile 与任务文本保真，以及可选来源引用 finish。最新 e7bce7f 的 finish 功能默认关闭，需正常 CLI/Host 显式配置；不能把功能已存在写成所有运行默认启用。

## 已重新读取的 T2 原始证据

| 轮次 | Run | 原始终态 | 实际文件核对 | 保存/关闭/重开序号 |
| --- | --- | --- | --- | --- |
| 基线 v6 | run-1791764013665-187836ef-750 | seq160 succeeded | 196B，SHA58a4fcd4…，6LF，末1LF，0CR | 127 / 133 / 153 |
| 独立重复 v7 | run-1791764743356-a4021c89-db7 | seq119 succeeded | 196B，SHA58a4fcd4…，6LF，末1LF，0CR | 82 / 92 / 112 |
| 原变体 | run-1791765130536-e28cb507-99b | seq156 succeeded | 196B，SHAebe8f2f9…，6LF，末1LF，0CR | 123 / 129 / 149 |

Root 本次实际重新读取三条 trajectory.jsonl，确认 run.finished/outcome/sequence；读取三份实际输出文件并重算字节、SHA、LF/CR，与独检收据一致。Sol 另独立完成同样核查。每轮保存后有关闭、恢复窗口 handoff、singleton 正常应用重开、新 Surface 观察与末 PNG；本次核截图文件仍保留，未把历史“实际视检 PNG”误称本轮重新视检。

三轮模型请求分别 20 / 15 / 20；动作提案/完成/拒绝分别 16/14/2、11/11/0、15/13/2。不把所有提案都算 completed。原独检收据明确没有人工补正文/保存/关闭/重开，业务限定 PASS 与真人评分分开。

主要证据目录：`runs/astra-autonomous-20261010-sol-luna/A07-private/host-output/<上述Run>/` 中的 `trajectory.jsonl`、`sol-terminal-business-independent-review.json`、`root-terminal-independent-review.json`；实际文件在同批次 results。私有正文、轨迹与截图不随本报告提交。

## 旧四项遗漏现在的状态

直接读取当前源码确认：

- F1：`managed-browser-host.ts` 使用可信 scale，x/y/width/height 四维差异限制，已不再从候选宽高反推任意缩放。
- F2：protocol 原 PNG 上限 2 MiB，Relay Base64 JSON 上限 3 MiB，RemoteRunApi 已调用 `normalizeWindowPreviewPng`。
- F3：ResultPanel 无 reply 但有 outcome 时仍显示终态及原因，区分失败/取消/预算耗尽等。
- F4：unknown_side_effect 使用“请查看当前任务状态”，不再无条件声称停止；真正 partial_side_effect 的终止提示保留。

这些产品改动在提交 08dec5e，历史定向 229 项、窄视口五态验证记录仍在。本轮是源码/产物核对，没有重跑上述测试。08dec5e 发布准备已取代旧 fa19cbb 作为后续准备记录，但新代码/新包存在不等于线上已切版。

## 其它新增成果与剩余范围

正常 Host/Relay 已实现 opaque native-recovery profile：客户端选择预设，Host 限两窗口/一个授权文件及单 Run 消费。真实离线 Provider+真实 native 的 37B 短诊断完成保存重开，不能代正式 196B 原卡。正常 Web 原卡首次启动误多粘贴一个尾 LF（1134B 而原卡1133B），已取消保轨迹；随后表单已核准确1133B，但未再启动。这是正常 Web T2 尚未签收的具体原因，不能抹掉 CLI 三轮成果。

e7bce7f 的来源引用 finish 修复针对 T1“读取 M6 却报告 M4”的失真：用同 Run 已持久化 Observation 的保留元素生成主结果。独检 239+213=452 项、主构建及精确冻结核对记录完整；它验证引用与输出一致性，不机械判断 SKU/最低价或来源事实真伪，也没有新 T1 业务通过。

当前 HEAD 的本地 CI 原始快照 `A07-private/root-e7bce7f-ci-terminal-readonly.json` 绑定完整 e7bce7f、运行 38201158820、检查时间 2026-10-12T03:52:50Z，五 job completed/success。本轮重新读取该收据，未发新远端请求，不声称本轮实时重查 GitHub。

仍未关闭：T1 三产品完整比较及三轮、T3 真实查询/跨应用预算纠正及三轮、正常 Web/default layered 的完整 T2、实体手机 M1–M4、真人评分/独立试用、Preview 实际部署。Windows/Linux 不属于责任或完成条件。

## 用量与资源说明

本次逐个读取 A01–A07 counter：120+61+3+62+93+98+61=498 实际请求，其中490main/8risk。A07 actual61、reserve120/6/126 revision2。最新账本记录468份已知usage合8,600,579tokens、30请求usage未知；本轮未重算全部usage日志，不把账本汇总冒称独立逐请求重算。金额未知。本轮新增请求为0。

最新资源收尾记录显示自有Host/Relay/keeper已正常停止，既有Run终态，原生候选及stock保留；本轮未启动或停止任何进程，也未以历史进程号推断当前存活状态。

两份总计划和自主计划已保留详细历史，但后段 S3 等旧看板仍有“完整卡无文件成果”的旧句。阅读时须以顶部11:53与本报告核到的实际产物为准；不能仅取 tail 或旧阶段表推断现状。建议后续整理当前看板与历史记录分区，避免继续误报。本报告不改变产品或既有任务完成边界。

# 火山方舟 Flash low：CP01／CP02／M02 十二轮 Windows 实跑

2026-10-17。两批各六个真实模型样本，每题四轮；仅发布脱敏报告、[机器摘要](./volcengine-ark-twelve-runs-2026-10-17.json)与必要官网内容裁图，不夹带方舟旧源码改动或其他历史实验。

## 结论与证据边界

按必需清单与内容完整性复核：**5轮必需清单通过，4轮已交付但有事实错误或完整性瑕疵，3轮未交付**。Runtime为8 succeeded、3 failed、1 cancelled，不能把运行成功当成内容全对。尤其CP02-4虽然Runtime failed，要求的金额核对和停止结论已正确交付；M02-3／4虽succeeded，却抄错必需医生姓名。

共521次真实请求，520次HTTP200，另1次在宿主30分钟期限取消时尚未取得HTTP响应头；521次transport记录均为thinking=enabled、reasoning_effort=low、max_tokens=16384。首批274请求、追加批247请求。费用未知；Runtime接纳usage合计17202883 tokens，不含拒收或不完整响应的usage，不能当账单总量。十二轮均未形成多GUI动作Batch，不评价批处理提速或渠道性能优越。

来源为已持久化trajectory、生产transport记录、各轮实际官网截图及独立官方资料读取。原轨迹、请求体、隐藏推理、完整桌面、私有配置与本机运行器不公开；附件只裁留官网内容。这里是运行事实与业务复核，不是正式evaluator评分、D02、稳定性放行或受控A/B。

## 运行候选与配置

- 执行平台：WinBoat内Windows，既有156baad系候选，包含此前网页／Context／Monitor及Ark接入的本地改动。**本成果分支以main 282ac6c建立，但运行候选不是这棵main提交树的新实机验收**；本次没有把main重新部署到Windows，也未做字节对应核对。
- 渠道：火山方舟Agent Plan，模型deepseek-v4.1-flash；本机运行器通过既有createProvider接口选择生产共享ChatCompletionsAdapter的low profile，配套FetchArkHttpClient与RecordingArkHttpClient。有效强度依据transport，不依据既有硬编码thinkingMode=disabled标签。产品默认仍disabled，本报告不改变工程默认。
- 每轮200模型请求／200动作；输出16384；文本输入48000／wire64000；单请求180秒、单轮30分钟；Planning、facts Memory和same-control-input-v1 batching开启，Monitor guidance，hybrid grounding。
- 各轮独立ephemeral浏览器和Plan／Memory；受管窗口foreground，跨窗口switch／handoff关闭。保留layered Guard与仅公开查询范围审批，未知副作用不重放；未真实登录、预约、付款或提交。独立真值未提供给模型。
- Goal沿用已发布的[公开入口＋本地准备任务合同](../eval/candidates/member-c-public-local-d01-20261011/README.md)，不是同名的旧微信／小程序草稿。CP01／CP02来源见[缴费卡](../eval/candidates/member-c-public-local-d01-20261011/payment-task-cards.md)，M02见[医疗卡](../eval/candidates/member-c-public-local-d01-20261011/medical-task-cards.md)。M02明确目标2026-10-21星期三上午；两批当前可见周表均为10.17—23，独立初态及真实Run都满足1272 CSS宽门槛。模型可自行缩放页面，不能据浏览器样式改变说任务初态未达门槛。

## 十二轮逐项结果

轮次按每题真实模型样本顺序编号1—4。耗时从Run准备到Runtime终态，包含启动和等待，不含终态后的证据回收；不是纯模型延迟。

| 样本 | 批次 | 真实请求数 | 耗时（秒） | Runtime | 业务复核 |
| --- | --- | ---: | ---: | --- | --- |
| CP01-1 | 首批 | 96 | 949.124 | succeeded | 必需价目字段正确；漏认图注中的佛山供电局 |
| CP01-2 | 首批 | 127 | 1801.394 | cancelled | 30分钟期限取消，无最终清单 |
| CP01-3 | 追加 | 112 | 1627.376 | succeeded | 必需价目清单通过 |
| CP01-4 | 追加 | 74 | 457.464 | succeeded | 必需价目清单通过 |
| CP02-1 | 首批 | 5 | 66.503 | succeeded | 核对清单通过 |
| CP02-2 | 首批 | 2 | 31.602 | succeeded | 核心正确；附带非居民价2.83应为2.63 |
| CP02-3 | 追加 | 2 | 40.666 | succeeded | 核对清单通过，附带非居民价2.63正确 |
| CP02-4 | 追加 | 3 | 37.783 | failed | 核对清单通过；模型因差额自报failure |
| M02-1 | 首批 | 24 | 360.232 | failed | 已到目标表；task_update＋terminate混用被整组拒收 |
| M02-2 | 首批 | 20 | 366.780 | failed | 输出16384耗尽，length，无有效清单 |
| M02-3 | 追加 | 41 | 423.201 | succeeded | 已交付9人；周頔误写为周颢 |
| M02-4 | 追加 | 15 | 298.167 | succeeded | 已交付9人；周頔误写为周颉 |

### CP01：公开价目图查询

目标是从南网广东大厅进入公开电价信息，选择广东省／佛山市，读取完整表名、运营者、执行起点、单位和三档“到户电价”；说明真实账单的账号／用户编号前提，不进入登录，并保留“公开价目表非当期账单、未核后续调价”的限制。

独立官网图为《广东省佛山市居民、农业电价价目表》，标注从2021年12月1日起执行，单位分/千瓦时（含税）；三档到户价59.886875／64.886875／89.886875，不是电价列59.02／64.02／89.02。图注8写适用于广东电网佛山供电局。

- CP01-1必需价目字段正确，但额外称未找到具体供电局，保留完整性瑕疵。CP01-2走到营商环境信息公开支路，记录无数据后至30分钟取消；第127请求在等待响应头时被取消，不是402余额失败、180秒供应商超时或200请求预算耗尽。
- CP01-3／4交付完整必需价目清单；分别102completed＋1refused、66completed＋3refused，含1／0个wait。CP01-3有7次本地工具拒收和1次范围审批；CP01-4有1次参数拒收，地址栏／DOM焦点拒绝未被放宽。完成不等于过程没有错误。

附件：[CP01-1实际价目正文](./volcengine-ark-twelve-evidence-2026-10-17/cp01-1-tariff.png)、[CP01-3实际价目正文](./volcengine-ark-twelve-evidence-2026-10-17/cp01-3-tariff.png)。官网来源：[大厅](https://95598.csg.cn/#/gd/hall)、[电价查询](https://95598.csg.cn/#/gd/serviceInquire/LRLayer/elePriceInquire)、[官方价目原图](https://95598.csg.cn/ucs/sr/wt/priceInfoImg/1030600.jpg)。图上2021执行起点不证明2026最新适用。

### CP02：合成账单核对

合成表数1000→1025，本期前年度累计340，账面69.00元；按居民一般生活用气年阶梯350／500立方米、2.61／2.83／4.23元，25立方米分10／15，应计68.55元，账面多0.45元。地址“3栋2单元501”与“三栋2-501”只作合成文本格式比较，不是实际户号／物理地址验证。要求待人工核对、不建议支付，并声明非官方真实账单。

- 四轮核心金额、差额和停支付结论均正确。CP02-2额外把“执行居民价格的非居民户”写2.83，官网实图为2.63，故不当内容全对。
- CP02-1／3附带非居民价2.63正确；CP02-4也正确，但模型因账单金额不一致把terminate.status设failure，Runtime failed而核对业务已交付。CP02-4此前有一次普通文本非终态响应被拒收，既有有限feedback后完成终态，不隐去该过程。

附件：[CP02-2实际居民／非居民价格](./volcengine-ark-twelve-evidence-2026-10-17/cp02-2-gas-rules.png)、[CP02-4实际价格](./volcengine-ark-twelve-evidence-2026-10-17/cp02-4-gas-rules.png)。[官方来源](https://www.bjgas.com/tag/86.html)。这不是支付成功案例。

### M02：指定日期公开出诊表

从news_visitinfo公开入口，按“普通门诊(东院)→内分泌科→内分泌科门诊”读取当前周2026-10-21周三上午全部医生，附周范围、URL和访问时间。类别依据进入路径，表体本身未额外标院区；不得推为实时余号、可约或预约成功。

本轮官网目标格9名为：王鸥、赵维纲、**周頔**、肖新华、陈适、张化冰、夏维波、卢琳、柴晓峰。

- M02-1已到具体门诊周表，末次task_update＋terminate混用，ARK_INVALID_TOOL_CALL整组拒收，没有接纳的最终清单。M02-2到科室总表，但末次输出16384（reasoning15980）→finish_reason=length，hotkey参数JSON不完整，ARK_INCOMPLETE_RESPONSE；恢复提示不是模型排班交付。
- M02-3／4交付9人清单及日期、时段、周范围、来源、访问时间，且未把出诊表当实时余号；但分别把官网“周頔”写为“周颢”和“周颉”，其余8名匹配。姓名属于必需事实，两轮完整业务验收不通过，不替模型改字后记成功。

附件：[M02-1日期表头](./volcengine-ark-twelve-evidence-2026-10-17/m02-1-table-header.png)、[同轮上午医生格](./volcengine-ark-twelve-evidence-2026-10-17/m02-1-morning-cells.png)、[M02-3实际表头与目标格](./volcengine-ark-twelve-evidence-2026-10-17/m02-3-schedule.png)、[M02-4实际表头与目标格](./volcengine-ark-twelve-evidence-2026-10-17/m02-4-schedule.png)。[公开入口](https://www.pumch.cn/news_visitinfo.html)、[实际门诊周表](https://www.pumch.cn/expert_chuzhen_week/%E5%86%85%E5%88%86%E6%B3%8C%E7%A7%91%E9%97%A8%E8%AF%8A/3/1.html?linkage=990478)。两个M02-1裁图来自不同已记录序列，不拼接成一张假称单次截图。

## 收尾与发布范围

十二个模型Run均close确认；两批专用daemon stop均退出0且已退出，临时接收器／脚本与专用桥收尾，Windows、PowerShell及原Chrome控制台保留。本次只发布上述结果、机器摘要、8份官网内容裁图和文档入口；不修改产品源码、默认配置、评测器或任务卡，不附本机记忆／运行器／私有路径／凭据／原始轨迹／Provider exchanges／隐藏推理。官网素材归原运营主体，不把项目代码许可证扩展至第三方图文。

结果整理不额外触发安装、构建、测试、API复跑、CI检查或字节核对。未知成本保持未知；不把这12轮宣传为稳定成功率、main新树验收或批处理提速证据。

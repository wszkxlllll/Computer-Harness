# 八题真实任务运行记录（2026-10-16）

## 本轮范围与冻结边界

用户已明确授权依次执行G01、G02、T01、T02、T03、M01、M02、M03，跳过G03；不得删除、覆盖用户文件，失败与复跑各自留档，不因失败修改题面或放宽Guard。只有T03授权向微信“文件传输助手”发送本题生成的DOCX，其他联系人和文件不在授权内。

运行基底为main `6b1d6e20136b38c9a53c7033ba5e372f00add335`及本地`codex/life-eval-ready-20261015`未提交准备改动；完整源码、构建、题面与driver指纹以每次plan.json为准，不把Git HEAD单独当作完整版本。真实任务用Harness执行；本轮不开发或更改产品代码。

八题统一整个桌面前台路径，受管浏览器复用travel profile并打开各题起始网址；窗口切换只置前，保持完整桌面观察。模型DeepSeek Flash、thinking关闭，B00关闭Planning/Memory，其余配置按冻结计划。Monitor shadow不阻断，Guard layered不放宽。对照或重复实验不包含在当前单轮八题范围内；失败需复跑时另建包，保留首次记录。

## 结果汇总

Runtime终态、模型自报与业务评分分开记录。正文/来源可独立核对才给事实项判断，GUI成果、文件及微信送达缺少证据时保留待核验，不把Runtime succeeded换算成业务成功。

| 题目 | 运行状态 | 业务结论 | 记录 |
| --- | --- | --- | --- |
| G01 | Runtime succeeded；模型自报success | 部分完成，未通过完整验收 | `runs/life-business-20261015/G01-B00-20261017-7cd137bb` |
| G02 | Runtime failed；模型自报failure | 失败：未取得正文，动作预算耗尽 | `runs/life-business-20261015/G02-B00-20261017-be1706e2` |
| T01 | Runtime succeeded；模型自报success | 未通过核验：来源日期冲突 | `runs/life-business-20261015/T01-B00-20261017-f4c95d37`；旧窗口模式记录不并入本轮 |
| T02 | Runtime succeeded | 部分完成：换乘次数未核实；其他动态路线待核验；一次监督回复 | `runs/life-business-20261015/T02-B00-20261017-14f619ae` |
| T03 | 两次实际运行均cancelled；另一次启动拦截 | 未交付DOCX或微信，来源偏离中止 | 首包`c9dfcffc`、启动包`accb0b37`、复跑包`2de0f0db`均保留 |
| M01 | Runtime failed；模型自报failure | 失败：未交付来院信息，预算耗尽 | `runs/life-business-20261015/M01-B00-20261017-7be3048a` |
| M02 | Runtime succeeded | 部分完成：核心内容匹配官网，但额外电话抄错 | `runs/life-business-20261015/M02-B00-20261017-e25e831e` |
| M03 | Runtime failed；模型自报failure | 部分完成：地址匹配官网，路线因人机验证未完成 | `runs/life-business-20261015/M03-B00-20261017-e94bffd0` |

各题终态后补充实际Goal/日期、包路径、最终答复、事实核验、请求及动作数、Tokens、延迟、审批、重复步骤、错误与复跑原因。仅从真实产物推导指标，不补造未采集信息。

### 证据边界

业务操作均由用户的Harness真实执行，不以其他自动化工具代做。监督使用CLI和Runtime文本事件；独立画面读取工具此前因无法可靠确认浏览器URL而停止，没有绕过限制重试。本批没有独立截图视觉核验，不能把模型描述或Driver回执写成已确认点击命中、文件内容正确或微信送达。官方正文的独立读取只用于评分，不向执行模型提供答案或链接。原始模型答复、summary及评分空值保留，本文记录独立判断。

## M03：医院地址与公共交通

- 新包`M03-B00-20261017-e94bffd0`，run `run-1792088512963-e5c418a9-8e1`；与此前任务独立，使用相同冻结版本及整个桌面路径。
- 两次Enter审批要求核实当前截图与焦点，日志说明当前可能提交无关搜索，不能确认会进入医院官网。监督者通过正常CLI入口拒绝两次，没有批准未知动作、代导航或给答案；Harness随后自行恢复执行。审批干预单独记录，不称完全无人监督。
- [完整模型答复及Runtime报告](../../../runs/life-business-20261015/M03-B00-20261017-e94bffd0/runtime-output/report.md)。已结束：Runtime failed、模型failure；wrapper elapsed831478ms，Runtime created→finished829078ms；128主/20风险请求，API314791ms（均2127ms、峰3902ms）。121次执行尝试，120completed、1failed，不将失败点击写成完成动作。主模型2387124输入/36443输出/2423567总tokens。
- 共3次审批全部拒绝；第三次为风险分类证据不完整、未声明高影响信号。另有一次模型要求人工通过高德滑块，监督者仅经正常用户输入入口回复当前无人协助、不得绕过或编造路线；未代做验证，也未提供地址或路线答案。模型据此如实结束，没有卡在审批中；cleanupDiagnostics为空。
- 最终医院地址为乌鲁木齐中路12号，与评分员独立取得的医院官网信息一致；公共交通路线、换乘、步行及用时均未交付。模型同时称最后一次地点查询为“乌鲁木齐中路1号”，又称没有改起终点，答复内部矛盾；trajectory sequence1204的type实际输入12号，因此不能只据模型总结断言已经把目标改为1号。未独立视觉确认滑块画面，验证阻塞依据模型自述及interact记录，不把整题失败归咎网站。
- 2次list_windows完整性契约执行失败；另一次点击出现`ACTION_OUTCOME_UNKNOWN`及`runtime.error: unknown_side_effect`。121 steps包括120 completed及1个failed/partial。sequence936的partial receipt标`safeRecovery=desktop_surface_reconfirmed`，sequence939取得同desktop新观察后继续；未发现随后再次点击相同坐标。这支持允许安全续行的观察边界，不证明原点击效果已知或所有后续动作安全。
- 恢复报告的`unknownSideEffects: none_recorded`仅按最终snapshot的unresolvedActionId/outcome_unknown投影，partial终结receipt已清除unresolved，因此不表示历史从未发生未知副作用。历史unknown事件仍被evidenceEvents引用。应澄清字段展示语义，不把这次差异直接报成历史事件丢失；空列表不能作为“没有发生过未知点击”的证据。
- 业务为部分完成/完整验收不通过。没有实际预约、拨号、写文件或发送消息的记录；本轮不复跑需要真人验证的路线，不绕过网站限制。

## 统一计时与下一步

以下从真实trajectory的`run.created`到`run.finished`推导，含审批/用户回复等待；与各节原始wrapper elapsed相差约1–3秒启动收尾，不能混用比较。API累计包含主模型与风险模型，不包含人工等待，不把其他耗时全部归因采图或Driver。

| 题目/尝试 | Runtime耗时（秒） | 主/风险请求 | 完成动作/失败动作 | API累计（秒） |
| --- | ---: | ---: | ---: | ---: |
| G01 | 400.8 | 82/4 | 79/0 | 211.9 |
| G02 | 544.5 | 107/4 | 100/0 | 295.2 |
| T01 | 330.7 | 69/0 | 66/0 | 175.1 |
| T02 | 315.7 | 50/0 | 46/0 | 119.9 |
| T03首次 | 336.9 | 77/0 | 67/0 | 170.3 |
| T03第二次实际运行 | 331.5 | 75/4 | 71/0 | 166.3 |
| M01 | 384.0 | 85/1 | 80/0 | 180.9 |
| M02 | 349.9 | 77/2 | 75/0 | 156.7 |
| M03 | 829.1 | 128/20 | 120/1 | 314.8 |

八题均已尝试：T03另保留一次实际复跑和一次业务启动前拦截，共9次实际业务运行。当前没有足够证据判任何题完整通过：部分题有明确缺项/错误，T01有日期冲突，动态路线也没有独立验收。本表不是最终准确率或模型排名；T02/M03含程序性监督输入，T03环境修正改变初始状态，不能冒充严格无干预重复实验。

后续以文末离线修复为基础，先做小范围真实页面短验收：窗口列出/切换、取消后报告及资源状态、指定起始页与恢复标签、点击落点/焦点和输入读回。并非所有项已经修复：旧标签来源及真实取消资源清理仍需证据。现有证据没有将重复操作定位为DPI、CUA或模型的单一根因，不继续无依据叠补丁。用户再次授权后固定新版本、原Goal、新包复跑失败题，再开展同版本Planning/Memory对照；本轮没有跑模块对照，不能评价这些模块的效果，也不应直接扩大难题掩盖基础失败。

八题运行期间没有修改冻结源码、题面、预算或Guard，没有主动删除/覆盖用户文件。T03的预期DOCX均未生成、未进入微信发送阶段；保留原始结果、精确恢复记录及启动清单备份。业务测试已经停止，没有遗留待处理审批或用户输入；随后授权的离线修复见文末，不自动启动其他模型实验或部署。

## G01：敬老卡公开信息

- [模型完整答复及Runtime报告](../../../runs/life-business-20261015/G01-B00-20261017-7cd137bb/runtime-output/report.md)，原包与轨迹保留。
- 403045ms，79动作、82主请求、4风险请求、0审批。一次click.y参数非法；另一次未开放工具输出被Provider拒绝，明确未执行后反馈重试一次。二者均不能写成“零错误”。
- 实际观察Surface为desktop。模型多轮在搜索结果尝试打开官网；最终明确说只用了百度站内检索摘要，未逐一打开官方正文。Monitor统计30次changed、49次unchanged，不能把截图无变化单独等同于点击失败，但与模型自述未导航一致。没有独立画面证据将原因进一步确定为坐标、浏览器或网站故障。
- 答复包含本人身份证、代办人及老人证件、金融功能另需激活等核心要点，但引用2021旧办法和早期领卡文章，并添加回执、社保卡等旧领卡要求；未满足以现行官方来源清楚回答的完整要求，且给用户增加混淆。
- 评分员独立核对[2026版敬老卡管理办法](https://mzj.sh.gov.cn/MZ_zhuzhan2739_0-2-8-15-55/20260812/485d5bd3f3564ddf85022f6e7543e81b.html)：第7条本人居民身份证，第9条社区代办列双方居民身份证，第12条本人到发卡银行柜台带卡及身份证激活。核验只用于评分，没有注入执行模型。独立访问成功不代表Harness已通过GUI访问。
- 业务结论为部分完成/完整验收不通过；不使用Runtime succeeded替代。暂不复跑：当前无网络瞬态证据，多轮无导航原样重试缺少明确依据；后续题目继续检查失败是否共性。未观察到申请、填报或账户操作；不以此声称具备操作系统级安全证明。

## G02：居住证签注公开规则

- [完整失败答复及Runtime报告](../../../runs/life-business-20261015/G02-B00-20261017-be1706e2/runtime-output/report.md)。547043ms；100动作达到上限，107主请求、4风险请求，0审批、0API重试。API延迟合计295159ms，其中主请求288271ms、风险6888ms。
- 最终未回答周期、时间窗、搬家及逾期影响；模型明确未取得官方正文并报告failure。业务结论为失败，不把诚实报告失败计成任务成功。日志出现政府搜索结果和一网通办二维码页面的导航自述，但不能据此宣称已读政策正文。
- 四次`list_windows`执行失败：`Computer window candidate projection has invalid truncation metadata`；另一次该工具参数非法被拒绝，以及预算耗尽后的动作拒绝。无Provider错误，不等于无工具错误。候选统计信息的共享生产/消费链正在只读追溯，当前不能认定与标题点不开属于同一根因。
- [评分员独立核对的现行实施细则](https://www.shanghai.gov.cn/nw12344/20251201/ed714f24b362482a998de9a1652440f2.html?siteId=1)可读取，第14/16条覆盖本题关键问题；没有将链接或答案交给运行模型。网页抓取可获取正文不等于GUI路径已通过。
- 未见网络瞬断证据；先不原样复跑，不修改题目或预算。未观察到登录、填写或提交个人资料。

## T01：携程车次比较

- [完整模型答复及Runtime报告](../../../runs/life-business-20261015/T01-B00-20261017-f4c95d37/runtime-output/report.md)。333077ms，66动作，69主请求/0风险请求，API合计175060ms（平均2537ms、最大7931ms），0审批、2次参数拒绝，无工具执行/Provider/Runtime错误。
- 模型自报G201、G7319及票价/抢票状态，但给出的来源URL日期参数为2026-10-04，与冻结的2026-10-17冲突；虽声称表单日期正确，Observation没有记录来源URL，不能独立解决该冲突。因此业务未通过核验，不把自报success作为通过，也不声称已经证明实际查询日期就是10月4日。
- 查询期间多次误到汽车票页并返回；模型自行输入/推测查询URL，没有人为补网址或答案。模型未报告购票或候补。不能把“抢”当明确有余票。
- 主模型用量1250076输入/22365输出/1272441总tokens。API等待占总耗时约53%，操作和其他处理占其余部分；尚无独立分段计时，不能全部归因Driver或采图。
- 启动时一次socket字面量转义错误被预检挡住，尚未启动CLI/GUI/API；读取已有精确socket后同包合法启动。此为执行编排错误，记录但不冒充模型重试或新业务Run。业务终态不原样复跑，后续如复测必须新包。

## T02：高德公共交通路线比较

- [完整模型答复及Runtime报告](../../../runs/life-business-20261015/T02-B00-20261017-14f619ae/runtime-output/report.md)。317811ms，46动作，50主请求/0风险，API合计119854ms（平均2397ms、最大7046ms），0审批/工具执行失败。一次list_windows额外参数被拒绝；一次未开放工具输出在未执行工具的前提下反馈重试，不能记成零错误。
- 模型报告地铁2号线和320路两种公共交通方案，并提示地铁不在当时运营时间内。Goal要求每种方案的换乘次数，但方案一仅称“很可能0次/未核实”，没有展开确认；仅凭交付内容即可认定必需字段未完成，至少属于部分完成，不能只写待核验。线路、站数、步行和时长为模型自述，仍未独立核对地图结果，不能以succeeded判业务通过；静态答案不预写路线真值。
- 模型一次请求人工输入终点。监督者仅通过正常user-input入口回复不代填、保留原目标、自行尝试或报告失败，未给操作技巧或路线答案；一次user.input.requested/received，UTF-8回读通过。属于有过程介入的记录，不混入完全自主无介入对照。
- 无原样复跑；保留独立新包，后续人工可依据其轨迹核验动态路线。未观察到叫车、购票或改变指定起终点的最终交付。

## T03：首轮中止与环境修正

- 首包`T03-B00-20261017-c9dfcffc`，run `run-1792085991396-835eee85-9fb`；337211ms，67动作、77主请求/0风险，API170307ms（平均2212ms、最大3460ms）。8次list_windows完整性契约执行失败、1次参数拒绝、1次无工具执行的Provider反馈重试。
- 模型在携程404/频道绕路后准备使用12306替代携程，违反用户已明确的来源范围。当前CLI interactive只在waiting_user/approval接受输入，不支持TUI式进行中纠正；监督者通过正常Ctrl+C中止，轨迹cancelled且observe记录SIGINT，CLI exit1。live-attempt.final未完整落盘，不能以其空值当作仍在运行或成功。
- 预期新DOCX精确路径不存在，没有微信发送记录；未进入用户文件删除或覆盖步骤。原包、轨迹和review完整保留，评分空。
- 发现用户此前关闭12306标签并不会移除Harness自有`managed-browser-startup.json`中的注册网址；两条12306仍在清单里，后续启动又恢复。这是环境准备遗漏，不能只归咎模型。没有修改用户Goal去接受12306。
- 中止后本包CLI和对应profile浏览器进程已不存在，但遗留Harness锁/DevTools标记。按项目生产恢复命令核无占用后归档标记，恢复号`recovery-1792086503076-bdf23949`，未删除登录数据。保留自有启动清单备份，仅移除两条12306网址，保留携程/高德。源码、Driver、Goal、预算与Guard未改。
- 因有明确可纠正的环境原因，允许新包复跑一次；其初始启动清单不同，单独记录，不冒充完全同环境重复或正式对照。若再偏离来源，不无限重跑。其他七题原记录不修改。
- 环境修正后包`T03-B00-20261017-accb0b37`在业务启动前被旧Run桌面lease拦截，exit1/276ms、0API/0GUI，记录独立attempt，不计第二次实际业务运行。旧lease所属Run精确匹配、owner PID600已不存在；根据进程、事件阶段、目标文件不存在和浏览器恢复证据执行生产TTY恢复命令，原lease移入quarantine并产生committed审计（recoveryId `3d1a55d6-be76-4909-98d9-7177862d4d03`），没有删除或伪报旧Run成功。恢复说明明确未独立读取截图，不把软件证据写成视觉验收。
- 已另建第三个包承载第二次实际业务尝试，没有复用已有live-attempt文件。中止后报告/锁清理不完整列为独立产品体验问题，不能归咎网络或模型。
- 第三包`T03-B00-20261017-2de0f0db`已完成第二次实际业务尝试：Runtime created→finished为331532ms（非wrapper耗时）；75主/4风险，API166281ms，71动作，另有3次list_windows同一完整性契约执行失败。再次进入12306且目的地杭州东、日期10月16日，监督者依边界中止，outcome cancelled。未生成目标DOCX、未进入微信；不再复跑。
- 只读核第二次轨迹，没有type参数输入12306网址；assistantText与随后的click明确表示切换已有12306标签。因此自有启动清单的两条移除仍不足以保证旧标签不恢复；尚未确认是浏览器会话恢复还是其他机制，不能宣称环境问题已解决，也不能把此来源偏离归咎模型“凭空输入网址”。保留当前Ctrip/高德清单，不修改Cookie或浏览器私有Session/Prefs文件。
- 第二次中止后同样留stale标记/lease：生产profile恢复归档`recovery-1792087236460-fb229e7b`；精确旧Run/ownerPID43672已退出后，生产lease恢复quarantine并提交审计`d4cdfa2b-3716-434d-994c-03561fdde371`。只为继续独立医院题恢复空闲，不重放旧动作；原始异常及两个cancelled结果不改。

## M01：华山医院来院信息

- [完整失败答复及Runtime报告](../../../runs/life-business-20261015/M01-B00-20261017-7be3048a/runtime-output/report.md)。385578ms，80动作达到上限，85主/1风险，86条API交互，API累计180901ms（平均2103.5ms、最大5846ms），0审批/工具执行失败。
- 模型在官网首页与导航区域重复尝试，并多次报告Edge恢复提示遮挡导航；没有给出可确认的院区地址、地铁线路/站点或总机。最终failure，业务失败，wrapper exit0不改变业务结论。
- 两次Provider语义错误：bad JSON、普通文本终止格式，均未执行工具后反馈重试；另有click.y参数拒绝和预算拒绝。不属于网络断连/HTTP超时。
- 评分员独立读取[医院来院交通页](https://www.huashan.org.cn/mzdh/lyjt.htm)可取得本题信息，但未把此链接或内容给模型。不能据模型未抵达正文就判官网不可访问而更换题目。未观察到拨号/预约。
- Edge恢复提示是中止后浏览器状态污染的线索，尚未确认其与坐标落点的因果关系；先继续M02检查正常关闭后的初始状态，不盲目重复同一失败。

## M02：电话预约与到院准备

- [完整模型答复及Runtime报告](../../../runs/life-business-20261015/M02-B00-20261017-e25e831e/runtime-output/report.md)。352261ms，75动作，77主/2风险，API156693ms（平均1983ms、最大6707ms），0审批/执行失败/Provider错误；一次scroll方向参数拒绝。
- 评分员独立读取[华山医院预约说明](https://www.huashan.org.cn/mzdh/yygh.htm)：主要预约电话号码、语音提示流程、实名凭证/确认短信、就诊当日0点前按原渠道取消等核心内容与答复相符。该核验没有反馈给执行模型；来源URL在答复中有效，但Observation没有记录，仍缺独立GUI来源链证明。
- 细核发现额外补充信息出错：模型将现场/诊间取消电话写成`021-52887950`，本次可读取的官网正文为`021-52887980`；虽非用户主要选择的电话预约取消路径，既然给出就不能忽略错误。另有过多未要求分支及提醒，不利于长辈快速理解。结果为部分完成/需修正，不判完整通过。
- 本题没有实际拨号、预约、取消或填入个人资料的记录；不能把页面所述服务可查询等同于电话已接通/现场实践已验证。模型用量1390314输入/21485输出/1411799总tokens。

## 并行只读归因：桌面坐标链

Luna从G01文本事件核对：80次观察均为2560×1600 physical desktop，无grounding catalog；63个有效click的模型像素参数、ActionIntent及CUA回执屏幕点逐一一致。DeepSeek使用actual_pixels，工具schema按当前视口给范围，桌面输入不走窗口坐标映射。另一个click缺少y，在产生动作前被拒绝。

这只能排除已检查代码层的明显单位/缩放不一致，不能证明屏幕目标命中正确；未读截图，DeepSeek视觉定位、内部缩放、截图时序及Driver更底层输入效果仍不能排除。有效hybrid模式仍提供click_element/select_option，但桌面观察没有catalog；G01没有调用这两个工具，故不能把其暴露疑点当作本次失败的已证原因。当前不为坐标单位核对额外付费复跑。

## 四题已完成记录的步骤效率（只读推导）

以下按模型提交的调用计数，含被拒绝调用，不能与GUI完成动作数直接相加等同。

| 题目 | click | scroll | type | hotkey | keypress | Monitor unchanged/完成动作 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| G01 | 64 | 3 | 11 | 1 | 1 | 49/79 |
| G02 | 90 | 0 | 8 | 3 | 0 | 32/100 |
| T01 | 47 | 9 | 6 | 4 | 2 | 15/66 |
| T02 | 34 | 0 | 12 | 0 | 0 | 20/46 |

116/291次观察转移为unchanged（39.9%），只是无可见变化代理指标，不等同于每步无意义或点击失败。T02目的地重复type9次，其中8次后unchanged；起点重复3次，没有hotkey清空操作。但无焦点/字段读回，不能确定是否追加、未注册或目标未命中。type completed不验实际文本。

未发现多键keypress误用或Ctrl+V路径；组合键使用hotkey。四题5次明确参数拒绝：缺y两次、scroll方向一次、list_windows多带`_harnessEffect`两次。它们与G02四次候选metadata执行失败、预算拒绝分开计。

## 并行只读归因：窗口清单完整性契约

G02的四次空参数list_windows均在Runtime窗口列表校验失败，没有把候选交给Context。CUA producer的`truncated`同时表示源清单不完整或有已知候选被省略，`omittedCount`只统计已知投影省略数量；Runtime却要求二者严格等价。因而合法的“源不完整、已知省略数为0”组合会被拒绝。轨迹没有记录校验前原始tuple，这是源码契约与实际异常相符的推导，不伪称已直接观测其原值。

对应源码：CUA `cua-driver-computer.ts:2616,2704-2709`；Runtime `run-controller.ts:4145-4151`。companion路径不创建Windows relationship probe、SDK清单需明确complete证明才标完整，是可能触发条件，尚未从原始清单确认。第一次非空参数调用额外传了`_harnessEffect`，属于不同的模型参数错误，不能混为一项。

T03已再次复现此错误：首次8次、第二次3次。候选刷新失败会留下无有效windowRef的列表，阻断支持的显式窗口切换；桌面坐标仍可执行不代表窗口列表能力已通过。没有记录校验前原始tuple，不将源码推导冒充直接观测。运行时未修改冻结版本；用户随后授权的离线窄修及验证见下节，不回写原始运行结果。

## 运行后离线定位与有限修复（2026-10-16）

本节是八题结束后另获授权的源码修复，不是原冻结版本已具有的行为。没有再次调用模型、操作桌面、修改任务或替换Preview。旧包、Goal、失败、评分及恢复证据均保留；源码/构建指纹已变化，后续必须新建运行包，不能拿旧包绕过freeze校验。

### 已修：窗口清单合同及Context消费者

- Runtime允许`truncated=true, omittedCount=0`，表示源完整性未知而没有已知投影省略；仍校验布尔值、非负安全整数，并拒绝`false`配正省略数。不删除新鲜度/引用失效/激活校验，也不宣称全清单完整。
- 同步`ComputerWindowList`注释和Context投影：true/0说明还可能存在未知窗口；true/N说明至少已知N个被省略，源本身也可能不完整；不再将true/0说成“只省略了0个窗口”。Provider仍统一消费Context，没有第二套窗口列表。
- 回归通过真实Runtime调度测试`list_windows → 普通动作 → switch_window`，覆盖false/0、true/0、true/1；非法刷新后旧引用仍过期、不能执行切换。Context另覆盖false/0、true/0、true/3。离线通过不替代两端实机验收。

### 已修：评测脚本Ctrl+C最终记录丢失

- 两次T03的轨迹已有`run.finished(cancelled)`，但外层`live-attempt.final`为空。外层脚本原来没有SIGINT监听，Ctrl+C可令外层先退出、关闭日志管道，无法等子进程收尾并写final；这与子进程已记录取消可以同时发生。
- `scripts/life-eval/run.mjs`现在记录中断，保持输出管道直到子进程close及日志flush后再写final；不在收到终端Ctrl+C时另用`child.kill(SIGINT)`转发。Node官方说明Windows上的该kill并不是温和的console中断，而是强制终止：[child_process文档](https://nodejs.org/api/child_process.html#subprocesskillsignal)。
- 中断后有有界cleanup grace；未退出会记录cleanup超时及实际发出的终止信号，不无限等候，也不把强杀写成优雅清理。不根据进程死亡自动删除profile锁或环境lease，不推断旧动作未发生。
- 离线fixture验证“取消→延迟收尾输出→close→final落盘”和“子进程不响应→grace到期→明确强制终止”。它验证外层生命周期，不证明真实CLI所有取消路径都释放资源；现有CLI后续Ctrl+C仍可能打断自身清理，原timeout在Windows也有强杀风险，均未冒充本轮已修。

### 未动：旧标签恢复与登录数据

持久profile启动同时涉及Harness自有startup清单、浏览器已有/恢复标签。代码会打开并激活指定任务起始网址，但模型仍能看到其他标签。第一次T03原清单确含12306；删去自有清单条目后第二次仍见旧标签，不能继续声称只有自有清单一个原因，也不能确定是Chromium恢复还是已有窗口。

本轮没有操作真实profile、删除Session/Prefs/Cookie、自动关闭旧页或增加12306特例。Chromium的`disable-restore-session-state`涉及Cookie/session storage，不能为了去标签破坏已准备登录：[Chromium开关源码](https://chromium.googlesource.com/chromium/src/+/main/chrome/common/chrome_switches.cc)。后续短验收应独立记录启动后实际标签和激活页，先确认恢复生产者，再决定通用修复；不先靠提示词隐藏环境污染。

### 重复点击与Monitor：实际证据

只读检查G01/G02/T01/T02/M01/M02/M03七题，不含T03两次中止。口径：当前click与前6个GUI动作中最近的click相距不超过8个物理像素，属于近点重复；不是自动判无意义或目标未命中。

| 题目 | click执行尝试 | 近点重复 | 其中精确同点 |
| --- | ---: | ---: | ---: |
| G01 | 63 | 5 | 2 |
| G02 | 90 | 7 | 1 |
| T01 | 46 | 10 | 3 |
| T02 | 34 | 5 | 1 |
| M01 | 62 | 8 | 1 |
| M02 | 53 | 14 | 5 |
| M03 | 94 | 19 | 9 |

共442次click尝试（441完成、M03一次partial失败），68次近点重复，其中22次精确同点；28组先前对应click后画面unchanged仍重试，6组精确同点。最长连续近点click为M02四次。68组的先前模型响应和completed工具结果均在该决策的`projectedEventIds`中，故这些紧邻重复不能归咎recent80已经把上一动作裁掉。

七题均为shadow：每题至多64个Monitor proposal诊断事件；合计199次proposal进入选取历史，但0次进入最终投影；`monitorGuidanceIncluded=true`也为0。源码`monitor-policy.ts`、Context `compiler.ts/history.ts/budget.ts`说明shadow不生成/注入guidance，诊断proposal不作为模型可读历史。因此本轮模型未收到独立的Monitor恢复建议，不能据此评价guidance效果。但不能扩大为“看不到任何Monitor结果”：Context的当前assessment reference会在绑定成立时直接附带该动作的changed/unchanged/unknown标签，不受guidance开关控制。Provider日志没有完整请求体，结论来自逐请求Context trace和序列化源码，不伪称读过完整outbound messages。

模型能看到最近动作、发送完成回执、历史assessment（包括evidence）和最新一张图；当前assessment reference在绑定成立时还能带机器transition标签，但没有前后双图对比，也没有独立的针对性Monitor恢复建议。Completed只证明派发，不证明控件命中或输入框文本正确。全桌面观察没有grounding catalog。已有字段足以描述“刚才何种动作、何处、派发状态、画面是否变化”，但声明target不是已验证目标，不能把它包装成命中证据。此前将shadow解释成“完全看不到机器unchanged判断”不准确，在本次进一步核对Context后更正。

八题冻结版本的guidance文案是“重新观察/定位、不要盲目重复”等泛化建议，兜底还会展示reason/evidence代码，缺少具体动作定位信息。更重要，该版本guidance还会拒绝最新unchanged后的精确同坐标click，并在提示预算耗尽后要求用户输入，**不是纯旁路提示**。不能为得到提示直接把该旧版本shadow换成guidance，违反用户Monitor不阻断的要求。后续另获授权实施软提示，见文末；效果必须单独对照，不能现在宣称提示有效。

截图/坐标只读核对没有发现Harness层明确缩放错误：PNG metadata和physical viewport均2560×1600，DeepSeek原PNG+actual_pixels，441条完成click回执点与请求一致。Windows主桌面现有settler至少等1.5秒、每250ms检查、至多3秒/7帧、两帧稳定后返回；实际最终采图比completed回执晚约1.9–3.1秒，不是立即截图。稳定只说明画面停止变化，不证明目标响应，也不代表已经排除服务端缩放/视觉定位/焦点问题。本轮不增加任意等待、邻近硬拦截或应用规则；后续视觉短验收才可核落点、焦点与输入读回。

### 本次离线验收与交付边界

- Luna实施、Sol独立增量审查；审查发现的无限等待、close与日志flush间误报超时、已exit但stdio未close、重复SIGINT测试死锁及跨平台fixture路径问题均已修正。Sol最终只读复核无剩余具体问题，不把审查结论当真实桌面成功。
- 根Agent最终独立运行：Vitest **132文件、2418/2418通过**；`tsc -b`及spike的`tsc --noEmit`通过；最终构建后串行运行runner/start自测 **25/25通过**；`git diff --check`通过。没有运行真实CLI/桌面/API来替代单测，Provider/Windows输入/无障碍相关已有离线套件保持通过。
- 中间曾因并发构建导致冻结指纹自测失败；随后串行重跑通过。取消fixture还曾暴露测试自身死锁，已修，不能省略早期失败而宣称首次全绿。新增runner/start回归已接入常规`scripts/test.mjs`，不只靠本轮手工执行。
- 自测会生成测试包/临时目录，使用固定fixture日期（如2026-10-20）与测试profile标签，均不是新增业务复跑，不含模型调用。中断的离线fixture保留`G01-B00-20261020-eed86cbd`及其临时根`life-eval-cancel-timeout-test-ygA0Qy`；清理被命令策略拒绝后没有换方式重试。原八题包与用户文件未删除或覆盖。
- 本轮没有升级或改动CUA二进制、没有修改真实profile、没有更改Plan/Memory/Monitor/Guard启用配置、没有占用桌面、消费模型额度、提交推送或部署。当前仅可放行下一轮受控短验收；旧标签、真实取消释放、点击目标命中、Monitor软提示效果均不能判实机通过。

### Monitor针对性提示：已有字段与改造依据

已有`ObservationAssessment`不是候选接口：Provider解析、Runtime校验当前Observation绑定、ProgressMonitor消费，真实G02也有输出。字段为`observationId/actionId/actionOutcome/evidence`及可选用户进度`progress`。例如sequence40模型报告`no_effect`，evidence称政府首页搜索框仍为空、输入文字不可见；这比单独“画面无变化”更有针对性，但仍为模型自报，不是控件读回或独立验证。

当前Monitor会核对assessment对应最新动作/观察，并结合transition协调actionOutcome；但只输出原因、证据种类及eventIds，`monitor-policy.ts`生成提示时没有解引用原assessment.evidence或动作参数，因而具体描述丢在提示链之外。不能说字段没有消费者，准确问题是语义描述没有被提示消费者利用。另有changed与模型no_effect等组合被降为uncertain，这是保守协调规则，不表示页面一定成功或一定失败。

建议复用现有事件，不新建一套state、不加独立模型请求：将最近绑定动作、派发状态、transition、模型evidence及已观察重复次数组成有长度限制的建议。区分机器观察与模型描述，例如“type已派发；前后画面指纹相同；你刚报告搜索框仍为空。下一步先从最新截图核实焦点/控件，再选择恢复操作，避免直接重发同样文本。”不让单个unchanged自动推导失败，不机械要求多拍一张图；没有有效assessment时退回通用不确定提示，不能拿过期或其他Surface描述指导当前动作。原始evidence属于不可信界面文本，须有边界、长度和敏感内容处理，不能提升为指令或复用为语音进度事实。

用户随后授权将现有guidance改为非阻断提示，而不是再增加第四种模式。shadow可记录候选提示及依据但不注入、不拒绝、不暂停；guidance只向后续决策Context投影当前相关建议，不自动执行恢复或重放，删除旧Monitor硬拒绝/求助暂停路径。assessment由模型本轮响应携带时，本轮下一动作也已提出，故后续提示不能宣称能追溯改变已给/已执行动作。开发后先验证shadow候选文本及有效期，再获授权对照有无软提示的重复动作与成功率；当前改造验收记录在下节，未重跑真实任务。

### 当前实际历史投影口径

每请求只附最新截图一张，历史observation用于元数据/关联，不重新发送旧截图。模型历史包含被保留的assistant文本、ToolCall、对应ToolResult/失败/拒绝、Provider continuation（由适配器处理）、完整旧observationAssessment及用户纠正/输入；Task/Memory本批关闭。`modelTurnMessage`明确把旧assessment作为不可信模型报告文本回传，因此evidence并未在所有消费者中丢失，缺的是Monitor建议生成时的针对性重组，而非首次让模型看见它。

recent配置的`maxHistoryEvents=80`当前不是80轮，也不是严格截最后80个事件：`selectHistoryEvents`在超阈值后保留最近`floor(80/4)=20`个模型响应及配套调用/结果，保留用户输入，并额外保护最近已派发GUI动作的完整历史组；配置token预算时还可按组裁剪。未达阈值时保留全部事件，只有可投影类型变成messages。本批没有配置Context token硬预算。原来将其简称为FIFO/recent80不足以表达实际算法；上述是当前源码行为，不代表已重新运行API验证。

### DeepSeek thinking核对（2026-10-16；未改变配置）

[DeepSeek官方思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)说明`deepseek-flash`支持thinking；Chat Completions可用`thinking.type=enabled/disabled`，开启时effort为low/high/max。官方默认开启/high，不等于本项目默认：当前`DeepseekFlashAdapter`固定`thinking: disabled`，本轮真实八题均关闭，不能将此次表现归为thinking模式。

不能只把其他Provider开关照搬：DeepSeek带tools的后续请求要求回传历史assistant的`reasoning_content`，包括无工具调用的对应轮次；不正确回传可能400。当前共用适配器已有continuation读写，但DeepSeek专属入口没有开放thinking选项；若后续增加，需要逐项验证模式/effort组装、continuation与recent裁剪、输出上限和取消/超时，不能据共享代码已有类似实现就宣布可用。官方还说明thinking下temperature等采样参数不生效。

建议之后单独加入关闭/low对照，考虑更长输出与上下文成本；可能减少决策错误，但净延迟取决于单请求变慢是否换来更少步骤，当前无对应实测。此次用户只询问能力，不顺带修改DeepSeek或调用API，避免混入Monitor修复变量。

## Monitor非阻断提示实施验收（2026-10-16）

用户另行授权实施并在验收后推送；Luna实施、另一Luna补纯投影回归、Sol独立审查，根统一验收。保留现有`off/shadow/guidance`模式和协议字段，无新增模型输出字段、模型请求或截图。

| 模式 | 新行为 |
| --- | --- |
| off | 不运行Monitor提示链 |
| shadow | 在既有`monitor.proposal.guidanceText/sourceEventIds`记录有界候选；不注入模型、不拒绝动作、不暂停 |
| guidance | 将当前有效建议注入下一轮Context；删除原重复点击拒绝及提示耗尽求助暂停；普通安全策略仍独立执行 |

私有`packages/runtime/src/monitor-guidance.ts`复用已有assessment、动作及transition做纯投影。保留原evidence短引文，明确“此前模型报告，未验证”，结合派发/无变化描述，询问依据最新截图该问题是否已经解决；没有匹配证据时退回不确定提示，不猜控件身份、不直接认定失败。先清理/遮挡已知输入原文及有限敏感格式，再截断引文；240 UTF-16长度预算保留完整确认问题，不切开emoji。这里是有限清理，不是完整PII检测或提示注入防御证明。

真实离线时序覆盖`A → O1 → R1(assessment(A,O1)并提出B) → B/O2 unchanged → R2`：后续请求实际通过DefaultContextCompiler包含原描述，引用只在同Run/Surface的连续、已完成、无变化证据链成立时沿用，并保留原assessment/current observation等关键事件引用（最多12个）。新画面changed/unknown、换Surface、用户纠正或控制屏障令旧建议失效；旧模型文本不能当当前事实。稳定System前缀增加一条历史优先级规则，不逐轮重复另一大段指导。

提示按既有冷却/候选寿命/额度约束；同一未解决episode不会因换reason刷额度，像素变化使旧诊断失效或旧候选过期后可由真实新候选恢复额度，不把像素变化叫业务成功。正常`action_in_flight`只抑制输出、保留episode；审批、用户输入、Abort、未知结果屏障仍生效。未重放未知动作。日志上限仍64，但不再因达到日志上限而意外关闭已合法产生的实时建议。shadow日志有界，不承诺记录无限候选。

验收：根最终构建/类型检查通过（`tsc -b`及spike noEmit），完整Vitest **133文件、2432/2432通过**；纯投影11项覆盖短中文/长输入遮挡/emoji/过期，集成覆盖上述实际跨轮、shadow无注入、guidance不阻断、原安全边界、日志cap及长Run提示恢复。Sol最终增量GO。首轮全量曾因测试将Context固定前缀错误计入正文长度而失败一项；修断言后重跑全绿；类型检查发现两处TS收窄错误并修复，不省略中间失败。此前发现的引文预算被模板挤占、长原文先截再遮挡及Unicode计数问题均有回归。

真实效果尚未验证：本轮没有调用模型API、操作桌面、重跑八题或更换Preview；DeepSeek仍关闭thinking。旧运行数据不回写、包指纹不迁改，后续实机必须新建包。用户确定不设自动提醒，每天手动通知“开始”后才进行一轮固定版本测试，保留全部失败/部分完成，再定位修复和必要复验；不能自动占用桌面或把每日测试承诺写成已执行。

### 提交与接续

按用户随后授权，在`codex/life-eval-ready-20261015`整理提交：评测入口/CLI输入策略及取消记录为`c0e64f2`，窗口合同与Monitor软提示为`d2b03d2`，本报告/入口另作文档提交。不是合并main或发布Preview。评测目录history仅保留旧的空模板供离线自测确认不再使用，不含真实业务成果；当前任务不打开这些模板。

验证最终构建后串行runner/start自测25/25仍通过。运行产物位于被Git忽略的本地runs，报告中的对应链接是本地证据入口，不代表截图、聊天或登录资料已经公开。未上传.env、私有配置、profile或CUA二进制；作者和提交者使用仓库本地已核账号身份，推送后的GitHub解析另行核验。

Monitor及评测准备三项提交已经推送，文档提交`7e10b30`；GitHub API确认三个提交的author/committer均解析到`wszkxlllll`（账号ID142909575），远端分支head匹配。没有创建PR、合并main或替换Preview。

## 推送后接续：Guard指引与工具schema一致性

只读追溯又确认一处可窄修的模型可见合同问题：旧layered Guard系统指引要求“所有Computer调用（switch_window除外）带_harnessEffect”，但Provider没有向模型传内部ToolRegistry.category；`list_windows`实际是side只读工具，空参数schema且additionalProperties=false，没有此字段。四次实际轨迹（G02 sequence693，T02 sequence386，T03两次sequence555/687）均因额外_harnessEffect被拒；这是与提示歧义相符的重复模式，不宣称已证明模型每次犯错的唯一原因。

后续窄修只改共享Context文案及合同测试：以工具公开inputSchema为准，有声明才填写并满足必填要求，没有声明不得添加；明确list_windows空参数与switch_window仅windowRef。删除泛指内部Computer类别的重复要求。没有扩大schema、在Provider静默吞字段或放松Runtimevalidator；click/type仍须原效果声明，switch_window原Run授权/目标校验例外保持。

Luna实施、Sol独立增量GO。根完成构建/typecheck及完整Vitest2432项回归；最后精简同义的类别句后再次构建，并完整运行Context及action-effect-projection两文件46/46通过。此次未重跑业务、调用API或改Guard启用配置。该问题单独提交，效果是否减少错误参数仍待后续实机；继续保留浏览器旧标签/真实点击命中/真实取消释放等待验证项，不因改了一句提示词宣布全解决。

## 接续核查：全桌面元素、旧标签与CI（2026-10-16）

### 全桌面不是自动具备UIA/DOM目录

本批全桌面路径的`CuaDriverComputer.observe()`在desktop分支返回截图、viewport、Surface关联与时间，不携带grounding目录；`ManagedBrowserComputer.observe()`直接委托该方法，没有另行合并DOM。受管浏览器启动了CDP、配置为hybrid或descriptor声明accessibility，均不证明当前Observation向模型提供了元素。全桌面`switch_window`只激活目标并继续桌面范围，不会自动改成窗口截图/目录模式。因此这轮不能把点击问题解释为“模型已有UIA/DOM仍选错”。

现有窗口绑定路径有UIA/DOM支持。若将来支持全桌面混合grounding，需要由已验证的当前目标产生元素，做窗口局部到桌面物理坐标的转换，保持Observation、窗口及浏览器tab引用失效边界；不是打开一个开关就已经完成。本轮先说明真实能力，不把未实现的全桌面目录写成可用。

### 关闭标签仍返回：两种来源不能混为一谈

源码确认：persistent Host每次启动读取Harness自己的`managed-browser-startup.json`并打开记录网址；注册函数只追加/去重，最多8项，关tab和完成手机准备均未同步清单。因此已经注册的网址即使被用户关掉，仍可能在下次启动被显式重新打开。普通任务访问网页不会自动全部注册；生产注册入口是显式手动准备助手。浏览器自身session restore是另一种可能，本轮未读取真实profile的Prefs、Sessions或Cookie，不能断言用户每个旧tab都来自Harness清单。

修复范围限定为用户明确完成手动准备时，将当前保留的HTTP(S)标签同步到Harness启动清单；普通任务结束不改它，查询失败不误清空。登录资料与浏览器自身会话文件不在修改范围。实施/验证结果另补于本节，不用离线测试代替真实重开验收。

### CI：已确认失败原因与修复结果

旧运行[38867563875](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38867563875)只有Windows Node22自测失败：任务卡fenced Goal提取按LF匹配，Windows检出为CRLF后得到undefined；Vitest2432项已通过，不是Runtime或Monitor失败。提交`0fd1e00`仅修测试解析边界，规范化换行后仍严格比较原任务卡与manifest Goal，新增同一任务LF/CRLF一致性覆盖，不改题目、生产逻辑或跳过检查。Luna实施、Sol只读GO，根独立定向测试通过。

新运行[38868696849](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38868696849)在该提交上Windows、macOS及两组既有其他平台矩阵与ci-required全部通过。这是已查实际结果，不是只据推送成功推断。没有合并main或替换Preview。

### 旧启动页同步及取消清理：离线验收

Luna分别实施、Sol最终只读GO，根独立构建与回归。旧启动页修复落在`ManagedBrowserHost.syncStartupUrlsFromCurrentPages()`及共享`prepareManagedBrowserProfile()`：用户明确Enter/手机完成后、Host关闭前，最多1秒查询自己持有的loopback CDP；仅persistent profile同步。当前HTTP(S)页按原规则去重、去query/hash后，以同目录临时文件原子替换Harness清单；超过8项整体保留旧清单，不偷偷截断。明确存在空白页且没有HTTP(S)页时可以清空；空枚举、只有worker、查询超时/失败及写入失败保留旧值。中断及普通Run结束不调用同步。best-effort结果不改变原登录准备成功判定，也不新增“已保证同步成功”的用户提示；浏览器自身恢复标签尚未实机核验。

资源修复聚焦评测runner→CLI取消链，不是自动删除用户资源。旧timeout对Windows Node child调用`kill(SIGINT)`可能直接终止，跳过正常close；现在加一条固定IPC取消消息，CLI映射到已有`controller.cancel`。消息只允许`type=harness.cancel/reason=run-timeout`，不是新工具或任意执行通道。评测IPC路径的SIGINT监听持续到整个main结束（包括report与session.close），重复Ctrl+C不提前拆掉监听；非IPC普通CLI和TUI维持原行为。启动前取消排队到controller已start，避免丢请求。

runner先等待原cleanupDeadline；逾期再强制终止，并保留发送返回值、回调结果、清理超时、实际终止信号及childCloseObserved，IPC发送成功不等于浏览器已清理。子进程exit但stdio未close也有有界等待；最终无法确认close时解除管道和IPC保活，仍写`childCloseObserved=false`，不擅自清lease或profile。Sol发现新增IPC可能保活父进程的P1已补channel.unref及回归。未知副作用不重试、Guard与原预算不变。

根验证：`tsc -b`、spike noEmit通过；完整Vitest **134文件2440/2440通过**；CLI定向31项通过；runner/start **27/27通过**（包括真实Node小子进程收到IPC后flush/disconnect并退出，及强制终止/关闭未确认分支）。这不是启动真实Harness、浏览器或调用API；业务取消后真正释放桌面/profile及真实关tab→完成准备→重开仍待下一次授权验收。新增CDP测试用mock验证失败/超时/多页/blank，不把合成网页当业务成功。没有删用户文件、改Cookie/Prefs/Sessions、升级CUA或替换Preview；提交/CI的后续状态在本节接续。

代码分为独立提交：取消链`9ce79ff`、启动页同步`48a6ffe`，仍在`codex/life-eval-ready-20261015`，不合main、不建PR、不部署Preview。当前下一步只需检查推送后的新head CI；下一次用户手动授权实机时再验上述两条真实闭环，不直接重跑整批八题。

### 登录profile实机重开确认

用户另行授权打开已有`travel` profile，手动关闭不需要的标签后确认保存。首次诊断启动没有保留stdin，不能正常发送Enter；没有据此报告保存成功。随后仅对本次已核PID的准备进程进行本地诊断，调用其原有等待流程的Enter完成回调，没有手工修改启动清单或登录数据。原共享准备流程实际返回`outcome=enter`、`cleanupDiagnostics=[]`、`profileRetention=confirmed`。临时诊断脚本已移除。

以`tty=true`再次调用同一共享生产准备函数打开同一个profile（起始`about:blank`），用户确认恢复结果符合预期；此为用户对旧标签与登录状态的实际确认，不是独立页面内容抓取。确认后通过保留的stdin正常发送Enter，第二次也返回上述无异常、profile保留确认结果，退出码0。测试未调用模型API，未读改Cookie/Prefs/Sessions，没有清除锁或强杀其他浏览器。它验证此次profile准备→保存→重开链，不代替真实业务任务取消释放测试，也不证明所有Chromium会话恢复情况已覆盖。

同时检查新head运行[38870166375](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38870166375)：最终失败，Windows及Node22的一组矩阵未通过，macOS和Node24矩阵通过。Windows日志明确有既有F045窗口交接测试等待条件超时；另一个失败仍需分别检查，不能将新head宣布全绿或直接归因于浏览器同步。之前`0fd1e00`的CI成功仍属历史准确结果，不代表最新提交通过。

### 最新CI失败定位与合入准备

用户授权继续排查、通过后以中文PR合入main；不替换Preview。两项实际失败分别为Windows F045的`missing empty stays stopped`等待轮询耗尽，以及Relay真实协议集成测试监听时`EADDRINUSE`，不是此前CRLF问题复发。

- Runtime：`commitEvent`先append、更新snapshot，随后调用`onEventCommitted`。F045三参数场景改为等待匹配事件已存入历史且`waiting_window/sourceActionId`已投影，再继续断言；与提前终态和5秒watchdog竞争，消除固定次数`setImmediate`调度竞态。未修改生产Runtime，保留单次模型请求、单次动作、不重放与取消结果断言。Luna定向三场景六轮18/18、整文件193/193通过。
- Relay集成测试：原先探测空闲端口后释放，再启动真实服务，期间存在端口被占用的竞争。测试专用启动helper仅在实际listen明确抛`EADDRINUSE`且失败fixture已关闭后重新申请端口，至多三次；其他错误、清理失败以及业务执行/断言不重试。Host失败不重启已成功Relay。真实占用端口回归覆盖两端、失败资源关闭及恶意Origin仍403；没有为测试改生产Origin接口或伪造Host头。

两处Luna实施、Sol最终只读GO，无新增P1/P2。根构建、spike类型检查和Web生产打包通过，仓库统一`scripts/test.mjs`的Vitest阶段2442项通过（按实际CI日志复核计数，新增Relay测试为两项）；后续Node自测阶段因本机缺少创建symlink权限，main已有的评测器别名防覆盖fixture报EPERM，因此整个本机统一命令退出1，不能写成全量通过。没有为此修改系统设置、跳过安全测试或放宽评测器；其余本轮定向测试通过。远端既有矩阵具备不同权限环境，新head仍须完整CI成功才合入。

接续运行`38873622691`：Windows及两组兼容矩阵通过；Windows完整Vitest2442项、Node261项通过，确认本机symlink权限限制没有被跳过后伪装解决。macOS另暴露既有DeepSeek deadline测试`fetchStub`预期1次、实际0次，继续定位，不以其他矩阵通过代替macOS验收。

macOS新增失败已定位到测试混用时钟：生产`FetchChatCompletionsHttpClient`用`performance.now()`检查逻辑deadline，Vitest默认fake timers不模拟performance；测试设10ms时，CI真实耗时可在fetch前达到deadline，合法超时但不满足该测试“已经进入headers/body”的前提。仅该测试显式模拟performance及timer，等待fetch/json阶段屏障后再推进11ms；继续严格断言1次fetch、timeout、nonretry及对应phase，并增加推进前已进入阶段的证据检查。Luna两场景重复测试及全35项通过，根独立三个相关文件232项与构建通过；Sol增量GO，新head CI另行接续，不改生产Provider或GLM/Qwen行为。

最终修复head `88c21bc`的[完整CI 38874655299](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38874655299)全部通过，包含Windows、macOS、两个Node兼容矩阵和ci-required，未跳过评测器安全测试。按用户授权创建中文[PR #33](https://github.com/wszkxlllll/Computer-Harness/pull/33)，说明本批窗口合同、Monitor、Guard提示、启动清单、取消清理与评测/CI修复；PR自身检查与最终合入状态以该链接为准，不把创建PR当作已合并。Preview未替换，真实业务取消释放与全桌面UIA/DOM的边界保持不变。

### PR合入后共同测试等待机制

PR #33最终head `191a527`的[PR检查38875193625](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38875193625)全部通过，按授权以`8362360`合入main。合入后[main CI38878486310](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38878486310)Windows又有三项恢复用例在同一`waitUntil`辅助函数失败（恢复policy期间pause+correction、暂停纠正隔离及F045匹配marker）；其他矩阵通过。源码核对辅助函数上限实际为5000次`setImmediate`，不是此前简述的100次；固定循环次数不构成真实IO等待deadline。

为避免继续逐用例堆屏障，从最新main另开`codex/ci-runtime-waits-20261016`集中修测试辅助等待，不改生产Runtime或放松业务/不重放断言。原PR与main运行分别记录，不以PR已绿冒充合入后main全绿；后续审查、验证及小PR结果接续，Preview不变。

集中修复已完成：共同waitUntil采用单调时钟的5秒deadline与最多10ms真实timer yield，未改变任何消费者predicate/安全断言；唯一fake timer用例不调用该helper且正常还原。新增false predicate的25ms有界失败回归，不使用依赖机器调度的耗时上界。Runtime整文件194项、原失败组重复验证通过。同类检查将GLM四处普通fake timers纳入performance统一时钟，不动其自定义monotonic spy用例、取消先后及late promise断言，64项通过。

根首轮完整Vitest仍有新增Relay端口fixture超出默认5秒，其余2442项通过；未省略该失败。补全两项HTTP响应体读取并各设5秒deadline，fixture总预算15秒与原roundtrip一致；不改生产服务。未读body为实际资源处理遗漏，但没有单点计时证据证明它是首轮超时唯一原因。Sol对以上各增量最终GO。根独立相关三文件262项、构建及最终完整Vitest **134文件2443/2443通过**（本机最终全量使用`--maxWorkers 4 --minWorkers 1`控制并发，远端仍按原CI配置验证，不修改CI或跳过测试）。最后补充PR仍须实际四矩阵通过后再合main，入口由PR #33的关联补充说明进入；没有替换Preview。

## 同伴更新复审：任务卡与方舟渠道（2026-10-16）

范围：任务卡[PR #35](https://github.com/wszkxlllll/Computer-Harness/pull/35)已合main `e970fea`；方舟[PR #36](https://github.com/wszkxlllll/Computer-Harness/pull/36)检查head `1cdc14ea`，目标为旧`codex/runtime-surface-preview-20261003`/`d308906`，并非当前main。此处只读审源码、候选JSON和远端CI，抽查官方资料；未独立执行PR提交树测试、调用模型API、操作桌面、评论/修改PR或合并。

### 任务卡：可以保留，尚不能直接批量运行

新增购物售后S01/S02/S03及通信日程CM01/CM02/CM03，各为easy/medium/hard。根离线独立核对六个Markdown Goal与JSON逐字一致、九条sourceRegistry引用均可解析、每题五维权重合计100、输出文件夹与文件名分行；原九题manifest相对`b2425f6`字节不变。网页抽查商品页、重复日程手册和iCloud共享手册均可读；没有重复同伴对全部九个来源的完整预检，不把其curl回执称为本轮执行。

目前是五类共15张候选卡，第六类社区缴费仍未加入；历史八题运行和评分没有被扩写。四题是公开网页调研答复，两道hard为浏览器→WPS新DOCX。CM类查询Mac/日历说明不代表实际打开信息App、创建日程或验证提醒送达；可以作信息准确性题，不可包装成该类原生应用操作已通过。S03/CM03仍需运行包填`OUTPUT_DIR`；CM02日期在正式冻结前按实际测试时间确认，对照期间不能随意改Goal。

新增manifest为独立候选suite，现有`life-eval`入口仍固定原MANIFEST_PATH/SUITE_ID，且createPlan验证原suite；不能只输入S01就声称已接入。下一步在不修改旧九题的前提下接入明确suite选择、准备/冻结、成果检查和人工评分，保留来源/评分要求不进入模型Goal的边界，再做GUI预检。PR35唯一Web变更是等待录音取消后的实际焦点恢复，仍断言同一按钮及不提交文本，没有产品UI改动；PR35与合入后main CI均已实际成功。

### 方舟：是独立API渠道，不是另一个Planning系统

`ArkDeepseekFlashAdapter`仅约102行，复用ChatCompletionsAdapter与ToolRegistry投影，另有ARK_API_KEY、方舟endpoint/HTTP client、ARK错误前缀及recording provider=ark。官方DeepSeek渠道保留，不自动fallback，不改Computer/Context/Planning/Memory主循环。共享errorCodePrefix替代原先非GLM一律映射DEEPSEEK的分支，属于合理的最小适配；没有理由为此次接入重造Runtime。

[官方模型公告](https://docs.volcengine.com/docs/ark/agent-plan-personal-model-release?lang=en)列明`deepseek-v4.1-flash`及视觉理解能力；[官方接入页](https://docs.volcengine.com/docs/ark/agent-plan-personal-deepseek-harness?lang=en)列出OpenAI兼容的plan/v3地址。本次不评定套餐价格、费用或长期可用性。Agent Plan名称不改变本项目TaskState/Planning的职责。

### 优先级及接续建议

| 级别 | 发现/判断 | 建议 |
| --- | --- | --- |
| P1：集成前置 | PR36目标是旧Preview。两条DeepSeek前置改动已在main，旧树没有PR33/34的Monitor、清理和CI收尾；其CI全绿只说明该目标树通过 | 以最新main重建干净接入分支，移植Ark增量，不重复带入已合前置、不覆盖当前修复。对最新组合重跑构建、Provider/Host/CLI/诊断回归及CI，再授权API/桌面验证 |
| P1：回归覆盖 | Ark增量删除`apps/host/src/glm-output-budget.test.ts`整项source-contract测试，连同env加载顺序、GLM审计、输入预算及Windows输入接线检查消失 | 不为新渠道直接删除整项。可修必要文案断言，或用等价行为测试替换；明确覆盖GLM原接线且与Ark配置隔离 |
| P1：默认切换依据不足（不否定渠道接入） | 产品Ark adapter第92行固定thinking disabled。两轮业务通过却通过自定义createProvider注入low，历史运行还含PR30本地修复 | 现证据只放行继续接入实验，不能据此切产品默认/称最新main已通过。冻结可复现low入口与有效配置，再在同版同题做对照；不把其他修复收益算给渠道 |
| P2：统计与复现 | reporting.ts第137行把Ark thinkingMode硬编码disabled，注入low样本需靠transport才能识别；四轮没有多GUI batch | 分开报告配置默认与实际请求。先复用已有安全transport字段聚合有效thinking，不新增无消费者字段；不能从这四轮推出Batch收益或通用成功率 |
| P2：诊断与测试 | Ark按直连DeepSeek缓存字段投影；官方Ark Chat API常见nested cached_tokens不能据品牌推定相同。PR36测试仍使用旧fake timer设置 | 按Agent Plan实际脱敏usage核对缓存字段并加Ark recorder回归，不认定当前费用已测；移植main已修的performance统一时钟，Ark headers/body用例也验证确已进入对应phase |

本轮未发现证据证明模型渠道互相串key、自动回放未知动作或破坏平台Computer抽象，不虚构P0。也不因为CI通过就忽略上述集成及证据缺口。额外小项：`DEFAULT_ARK_MAX_OUTPUT_TOKENS`仅定义未消费，应统一到实际默认值生产者或删除，避免多处4096日后漂移。缓存判断依据为[Ark Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh&redirect=1)的字段说明；它不是Agent Plan当前账户的实回证据。

### 如何看四轮结果

同伴报告disabled两轮分别27请求/110.087秒（取消、无最终清单）与48请求/193.993秒（Runtime成功但业务未过）；注入low两轮41请求/391.743秒和19请求/111.910秒，均通过其M01必需清单。保留失败、区分Runtime/业务成功是正确改进。low有积极信号，但样本只有同题两次，较快与较慢的轮次都存在；没有匹配的官方渠道对照和同树验收，不能说“显著更快”或已解决事实丢失。价格和完整请求成本未知。

结论（初次只读审查时点）：任务卡更新可继续作为候选准备，先接runner，不把五类说成六类完成；方舟适配方向可接受，先整改目标分支与回归覆盖，再作为可选渠道验证，暂不切默认、不替换Preview。以下接续记录覆盖此处的执行状态，不改变上述历史样本的证据范围。

### 接续：Windows适用性与PR36验证合入

用户随后授权验证并合并PR36，真实API通过是合入前置；不替换Preview、不执行桌面业务任务。

PR35的六题按现有Goal均可在Windows执行：S01/S02查询商品和退货说明，CM01/CM02查询Mac信息与日历操作说明，执行环境只需浏览器；S03/CM03另在Windows WPS创建新DOCX。题目中的Mac是说明的对象，不是要求本机运行Mac应用。因此不为兼容Windows改写Goal，也不把这六题说成已验证真实聊天、日历操作。若要测实际Windows原生应用，需要另立任务变体和预检，不能悄悄改冻结题目。

六题JSON与任务卡Goal逐项一致，来源ID引用有效，各题评分权重合计100，两个文档任务换行正确；原九题manifest未改变。CM02的2026年11月4日至25日均为周三，正式冻结前仍须结合实际运行日核对时效。输出目录由准备步骤填入，文件名与目录分开，避免把整条路径当文件名。新增suite尚未接入现有固定九题runner，当前不能直接沿用旧任务启动命令；这属于运行准备缺口而非Windows不兼容。

PR36接续以最新main `e970fea`为基底，将其合入原PR历史，保留原作者，不重复改写DeepSeek前置提交。源码按最新main叠加Ark增量，近期Monitor、取消、浏览器清理、Windows输入与无障碍实现保持；恢复Host原GLM接线回归，修正Ark超时测试统一performance时钟与阶段屏障，删除未消费的默认输出常量。Luna实施、Sol生产代码与测试只读审查GO；构建与spike类型检查通过。真实API、完整回归及远端CI结果在本节后续记录，不以审查GO代替API通过。

独立真实API基础验收已通过：3请求、17项检查全真，首轮task_create+memory_write_fact+click，真实Runtime持久化、回执/历史与新图进入后续请求，独立terminate；单请求2.512–3.280秒。仅用非敏感测试PNG与受限Computer fixture，不是业务GUI成功。两个composite尝试均5请求完成但三个GUI动作分轮，严格Batch验收不通过，记P2能力限制，建议Ark先采用单GUI基线；不动GLM/Qwen或放宽Runtime。首轮旧ARK_API_KEY401，实际用户末尾HUOSHAN_API_KEY有效，probe可显式选择且不回退；生产环境仍需正确设置ARK_API_KEY。实际nested缓存字段已在Provider/诊断两处修复并回归，官方直连平级格式保持。

最终构建/spike/Web通过、完整Vitest2480/2480、旧runner27/27、新probe离线11/11；实现及增量Sol最终GO。中途旧缓存fixture失败已修并全量复验，没有隐藏失败或放松安全断言。详细请求时延、脱敏结果位置与通用复验命令见[Ark独立验收末节](./volcengine-ark-agent-plan-2026-10-16.md#最新main集成及独立api验收2026-10-16接续)。[PR36](https://github.com/wszkxlllll/Computer-Harness/pull/36)后续已改为main目标，[PR CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38897851567)全过后以`282ac6c`合入，[main CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38898351528)也已独立确认全过；Preview不变。

六题runner后续由用户授权单独接入，最新状态与对照命令见[评测操作说明新六题节](./life-business-evaluation-2026-10-15.md#新六题方舟对照准备2026-10-16接续)。这项离线准备不属于上述历史八题或API验收，也不代表新六题已经实机通过。

### 2026-10-17队友新增实跑：PR37状态同步（只读）

核对[PR37](https://github.com/wszkxlllll/Computer-Harness/pull/37) head `9a2bfe7`、专项Markdown与JSON摘要。此次仅按已发布材料同步，不重跑模型或独立复核私有轨迹，不修改、评论或合并PR；当前Windows六题准备包与Preview均不改。

队友跑的是其CP01/CP02/M02开发题，各4遍、两批共12遍，不是本机新接的S01—S03/CM01—CM03。其M02是协和医院2026-10-21上午公开排班，不是本机九题中同名的华山预约说明。CP01查佛山公开居民电价，CP02按官方燃气价核对合成账单（不支付），M02读协和指定日期的公开医生表。

按作者报告：CP01两遍清单通过、一遍漏认图注、一遍30分钟取消；CP02三遍清单通过、一遍附带非居民价格抄错，其中一遍正确指出账单差额却自报failure；M02无完整通过，两遍未交付、两遍交付但抄错同一医生姓名。合计5遍清单通过、4遍有事实/完整性瑕疵、3遍未交付；Runtime为8成功/3失败/1取消，不能混为业务成功率。

本轮521请求，520个HTTP200、1个在宿主期限取消时未获响应头；耗时合计约107.7分钟。CP01每遍约7.6—30分钟，CP02约32—67秒，M02约5—7分钟。不是纯API时延统计，不据此归因线路或供应商延迟；费用未知。材料显示没有普遍API连通失败，仍暴露导航效率、图片信息遗漏/识别错字、结束工具混用和思考输出耗尽问题。

所有轮次均显式开启low思考、Plan/Memory/Batch，输出16384、单请求180秒、每轮200请求/200动作、Monitor guidance。没有模块开关对照，实际也没有多GUI Batch；不能证明Plan/Memory或Batch净收益。执行的是WinBoat Windows内既有本地候选，浏览器窗口模式、跨窗口关闭；发布分支虽基于main `282ac6c`，不等于用这棵main树重新部署实测。与本机六题的默认disabled/单GUI/全桌面跨应用准备配置不同，不直接并表。PR仅新增报告/摘要/8张官网裁图和索引，无产品源码修改；作者报告12个Run已close、专用daemon已stop，本轮未独立检查这些进程。

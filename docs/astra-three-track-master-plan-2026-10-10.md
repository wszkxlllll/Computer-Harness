> 最新执行状态（2026-10-13）：八项 MR 已修复提交3b84287，test-only确定性等待修正9720350已推送且当前CI五项全通过。本地完整2076项Vitest＋72项Node、类型检查和Web构建通过；现进入新环境零真实Provider Mac诊断。T3新能力在隔离树实施，正式三线业务及手机专属验收尚未完成。详见 [本轮执行记录](astra-mr-repair-execution-2026-10-13.md) 与 [现场验证记录](astra-live-validation-2026-10-13.md)。

# Astra 三线总计划：目标与完整验收

## 2026-10-12 小组意见综合审查补充：当前整改完成条件

用户新要求已由Astra模型/medium综合审查，准备交接原测试修复对话。唯一意见表、源码位置与判定见[小组意见综合审查](./astra-member-feedback-integrated-review-2026-10-12.md)；执行顺序在[自主计划](./astra-autonomous-test-repair-plan-2026-10-10.md#2026-10-12-小组意见整改与执行交接)。下方11:53及旧看板是既往轮次事实，不能覆盖本节新增整改规划。

| 完成条件 | 纳入意见 | 关闭所需证据 |
| --- | --- | --- |
| 普通模式窗口与平台共同合同 | MR-01/02/07 | 真Runtime动作后协调顺序反例、机器信号、同Session有效平台一致；普通模式与native profile分证。MR-02只核共同层/Mac必要影响，Windows专属整改不纳入 |
| 审批、Provider与预览链 | MR-03/04/05/08 | GET/SSE→Relay→Web安全字段一致；可选日志不改变响应/原错误；实际出站Mac工具合同完整；预览慢阶段/清理诊断后有界返回及token安全 |
| 来源实验产品结果 | MR-06 | 清楚中文主结果与结构化审计证据分层，未知/推断/未选/冲突限定不丢；默认opt-in，不冒事实语义或业务通过 |
| 真实三线及交付 | 保留原出口 | 新冻结版本正常Web/default layered及Mac完整任务分别验收，手机/真人/部署独立；本轮纳入的PR26意见逐项出关闭证据，范围外意见记录移交，CI绿不替代 |

T2同95b CLI实验模式三轮限定PASS、已修F1–F4及有效Mac原生增量保留，不退回“没有成果”。T1/T3与正常Web完整T2仍未通过。Windows/Linux原生实现、专测、环境寻找和验收继续排除；PR28材料只参考，PR23/27评测隔离，不新增医疗/缴费业务任务或伪造真人评分。大重构不是本轮前置。

点击路线合同（PR22 F1）：受管浏览器内容仍优先使用观察内唯一匹配的 DOM 控件；全局 DOM 为 partial 不抹去该控件已知的 disabled 或实时点击校验拒绝。只有没有唯一 DOM 对应项时，非容器 UIA 控件才可走现有带身份、几何与精确点位检查的 native fallback。这项修复不改变正常 Web/Relay、Browser 与 native Surface 的既有边界。

本次只改审查/计划并传递，产品源码仍e7bce7f、Git HEAD6c0af49；498实际请求计数不变。交接对象为原执行对话01a124b9，实际送达状态见综合审查交接节。

2026-10-12 11:53 本轮修复完成并停止（用户要求本轮完成后停止，最新状态以本段为准）：F089已精确27文件提交并原SHA推送 `e7bce7f7792b455d02212c717a34206412002d14`；来源引用finish默认关闭，可经正常CLI/Host显式配置，Runtime只引用本Run已持久化Observation中的保留grounding并规范渲染结果，未知/推断明确标记。它验证来源与输出绑定一致性，不机械判断SKU语义或事实真值，不计T1业务通过。作者最终452/452，Sol独检239/239与Root独检213/213互补合452；主工作区tsc-b exit0，24源文件与冻结pin全部一致。当前HEAD CI38201158820已由Root于03:52:50Z实际核completed/success，4 verify及ci-required共5job全部success，不继承旧cb93五绿。详见[F089](./a-line-sync/fixes/F-20261012-089-source-linked-finish.md)及[来源引用审查](./astra-source-linked-finish-review-2026-10-12.md)。

本轮未新增真实Provider请求或GUI业务。A07仍actual61main/0risk/61、reserve120/6/126 rev2；累计498actual=490main+8risk、468known合8,600,579tokens、30unknown，金额未知。95b CLI L2 experiment的T2完整基线/独立repeat/原variant三轮限定通过；正常Web首录入1134B而原卡1133B，已取消并保留轨迹/文稿，不算原卡通过。新表单实际AX值曾逐字核1133B/尾1LF，尚未再次Start；不再启动新Web/paid轮。T1业务、T3完整闭环及其复验/变体、真人五维、实体手机/语音与Preview远端部署仍缺，T3只读设计保留，未实施。

收尾资源已核：所有既有Run终态后，自有Host26665与Relay26276逐UID/start/完整argv确认，各一次SIGTERM、ps gone且原PTY均exit0；Root keeper26995已由Root精确停止，不续保活。native98330、stock4254、归属未证debug21139及旧成果/错误路径文件未动。隔离T1工作树保留供审阅。六入口仅同步本地最终状态，不新增提交循环；本轮修复与CI已完成，现停止工作；不再启动任何后续任务。

2026-10-12 10:34 历史实施快照（最新见顶部）：F087 Host/API/Web/Relay 精确 native profile 已提交3001a1c；完整真实本地Host+Relay+native零Provider短诊断1b545917 seq168 succeeded，37B两行中文emoji/13proposed=13completed/13Guard，surface5 gen2/nativeCG18657、末PNG及298行journal已由Sol/Root分别核验；仅短fixture，不代正式196B或Web按钮业务。共享Relay严格selector透传/非法零转发已验。3001 CI三非macOS job失败均为两新测试未限定Darwin，旧失败保留；F088 cb93d5dfae624d7b1bb9ec66336e7cad4eea6318 同时窄修测试fixture及native-profile goal原文保留，旧mode trim不变。Sol边界38/API66、Root独检108、tsc-b/Web build均通过；cb93当前CI38194908632五job实际success，不继承旧head绿。

正常Chrome已实际完成本地Relay配对、预设文稿选择及Start，首Run1791771467257-f772b05d-579监督ready02:17:47.434Z<created.435Z<首Provider48.453Z；但Sol录入多一个末LF，实际1134B而非冻结1133B，故经正常API abort终态63cancelled，不计正式原卡PASS。六main请求/五known95247tokens+一unknown、四动作已执行（纯文本转换、196B输入、CMD S、CMD SHIFT G），完整原轨迹/正文保留。终态后仅ESC退出自有GoTo与Save面板，旧稿不删除/重放；原30aa目标仍absent。

A07 actual61main/0risk/61，reserve120/6/126 rev2/cap原样；累计498actual=490main8risk，468known8600579tokens、30unknown，金额未知。新正常空白primary18934/recovery18931经原生与Swift空值/精确focus验证，旧18739不用。新Host26665 start10:22:44/PTY34826，Relay26276 start10:13:59/session54313加载cb93；最终模板e9b61f99…及18source+11dist已核。新正常Web配对后，启动前实际textarea AXValue于02:27:43.855Z核1133B/SHA54fb4b96…/尾1LF与原卡逐字相等，receipt sol-web-prestart-actual-ax-goal-exact.json。随后CUA两次各100s返回user still interacting with Chrome，尚未再次Start，不用旧按钮索引或其他输入通路绕过用户活动保护；下一步正常刷新并重读表单后Start。

Root唯一keeper25677/UID501/start09:59:28/PTY41780至10:59:28；native98330/6f56签名/TCC未动，保活不等同focus。三轮95b CLI L2 experiment限定PASS仍与Web/defaultHost新组合分列；正常Web完整T2及其同版repeat/原variant未通过，T1/T3全出口、真人五维、实体手机/语音听感、Preview远端部署各独立保留。T3 hybrid只读设计并行准备，不把native-only profile套到hybrid。

2026-10-12 09:25 历史实施快照（最新见顶部）：新Host文稿profile的Host/API/Web回归已通过（Sol原128项及刷新后Home26项，Root strict-schema6项/expiry1项），F086 30c6五CI实际绿；尚未提交的新feature不冒已获CI验证。最终监督Node18/18与Python7/7分别实跑通过，8依赖manifest9c9a4079逐SHA核同，旧fixture/manifest失败保留。真实本地Host/Relay完整诊断首次4909c98b于01:21:55Z在POST /api/runs被Relay严格union拒400，0Run/0桌面业务动作/0Provider，已精确定位shared relay-connector routing未接native-recovery；单写者正在补精确selector与真实透传/非法零转发回归，再新UUID诊断，不重放未知动作。

A07 reserve120main/6risk rev2、actual55/0/55、累计492actual/463known8505332tokens/29unknown均未变。Web卡1133B/54fb4b96、196B/58a4及唯一30aa输出保持；下一正常Web完整Run仍待真实本地profile保存/关闭/恢复/一次重开链验证与最终pin。Root唯一keeper21334/UID501/start09:17:08/PTY39992至10:17:08，native98330不变；保活不等同焦点证明。


2026-10-12 09:12 历史实施快照（最新见顶部）：F086提交30c6d702725d2c16d33dda2410751019179c7cf2的CI38189564088已由Root实际GET核五job全绿。新Host文稿入口尚未提交/实机验收：15文件最终冻结，Sol独跑相关128/128、tsc-b exit0、Web production build exit0；Root独跑schema相关6/6，新增模式明确拒绝switchWindows true/false且零启动/零消耗，随后合法请求可启动。默认普通Run不继承grant；单次消费/同command幂等/失败后不再显示配置均已测。最终源码与dist记录见A07-private/sol-native-profile-frozen-source-independent-review.json（138aaef3…）。

A07 rev2预占120/6/126已正常完成，actual55/0/55及seq55/派发链不变，下一40请求余额充足；累计492actual、463known/8505332tokens、29unknown，尚无新Provider。Web完整卡仍1133B/54fb4b96、正文196B/58a4，仅唯一30aa路径变化。下一顺序为真实零Provider Host profile完整保存/关闭/恢复/重开诊断，再正常Web按钮完整T2；Host默认planning=true、facts/lexical记忆、same-control-input-v1 batching、recent/maxHistory32、live-interactive/layered、riskModel=same且riskMaxModelRequests1均如实保留，不称仅Guard变量变化。CLI三轮同95b限定通过不冒Web/defaultHost通过。私有监督18/18已独跑；monitor身份由substring收紧精确argv后作者7/7，最终live前独审中。Root唯一keeper17626至09:37:39，native98330/签名/TCC不变。

2026-10-12 08:53 历史实施快照（最新见09:12）：F086报告窄修已精确3文件提交30c6d702725d2c16d33dda2410751019179c7cf2并原SHA API同步PR26（session27018 exit0，未force），Sol完整RunHandle44/44+tsc-b exit0/diffcheck0；Root独立真实三轨迹只读report replay3/3+五场景focused1/1，原业务轨迹/summary不覆写。已开始reopen且无新exact handoff时报告最终target为null，两明确未launch拒绝码保原target，switch指标不混reopen。新HEAD CI38189564088实际in_progress，旧95b五绿仅属三轮冻结版本，不冒新绿。

下一付费验证合并真实Web入口与Host默认layered/riskModel=same，取消额外非interactive CLI paid轮（其默认实际experiment/Guardoff且approval会自动reject，不绕reopen禁interactive gate）。当前由Luna native_identity单写者实施最小Host启动native recovery profile：默认关闭、精确两自有blank/唯一文件、客户端只选opaque profileId、复用现pairing/CSRF/幂等和native-only uia gate；不新增admin/TTL体系、不放宽Guard或grant、不套T3hybrid。先完整正反回归+真实零HTTPprofile生命周期，之后正常Web完整T2有界Run；累计492/A07actual55尚未新消费，下一40仍需append-only续预占。三CLI同95b业务限定PASS详下方；Root唯一keeper17626至09:37:39、native98330不变。


08:57准备补记：A07已沿extendBatchReservation正式append-only续至120/6/126 rev2，actual55/0/55、seq55及dispatchchain25d136不变，Root已独核；尚无新Provider。新Web完整卡只换30aa0257…txt路径，goal1133B/54fb4b96、body196/58a4原样、目标absent。实施范围见[Web native recovery profile审查](./astra-web-native-recovery-profile-review-2026-10-12.md)，当前尚未实测此新入口。

2026-10-12 08:39 历史三轮终态稳定点（当前实施见顶部）：同一冻结版本95b8449/native8完成T2基线high-v6、独立repeat high-v7、原冻结variant三轮完整自主保存→关闭→恢复→重开→内容核对，均自然succeeded、真实PTY exit0、summary同Run且cleanupDiagnostics[]，Sol/Root分别独审限定PASS。三轮严格属于CLI L2 experiment（riskGuard/riskModel off）；默认layered与真实Web L3未据此签收。

最新variant `run-1791765130536-e28cb507-99b` seq156于2026-10-12T00:36:25.707Z succeeded，原1132B goal/d237535…、196B正文/ebe8未改。指定136d8091…txt实际196B逐字正确、88码点/6LF/末1LF/0CR，seq123保存verified→129CMDW→138list→140handoff→149singleton正常odoc重开→152/153新surface5 gen2完整AX正文，最终nativeCGID18598，末PNG已实际视检。15proposed=13completed+2明确native refused，另2参数派发前拒绝；20main/20known=260215input+9791output=270006tokens，全部实际high/enabled8192/nonstream；CLI15497/helpers15503/15504均退出，PTY30197 exit0。两次point拒绝保留：exact AXfocus成立但CG点位gate看到恢复blank18554覆盖目标；准备顺序未修复此矛盾，保持严格拒绝，后续仅零HTTP归因，不猜外部失焦。

三轮合计55main/0risk/55；A07 actual55/seq55、reserve80/4/84 rev1、cap120/6/126，剩25main不足下一40，后续需正常append-only续预占，不清actual/历史。累计492actual=484main+8risk，463known合8505332tokens，29unknown保持未知。95b当前CI38186986942五job实际success。Root唯一keeper17626/UID501/start08:37:39/PTY42505至09:37:39（旧8974精确退出）；native98330/6f56签名/TCC不变，保活非焦点证明。

下一步单写者Luna只修reporting.ts最终目标元数据：已派发singleton reopen后不得虚报恢复blank，保守unknown；明确pre-dispatch NOT_READY不抹仍有效旧目标，后续exact handoff可恢复。新版本与上述同95b三轮分列，先真实轨迹回归和定向独检再build/提交/新CI。T3原卡/来源后首保存前合法客户端预算纠正、default layered与Web按钮出口仍待实际验证；T3 hybrid不能直接套native-only单文件grant。v6 evaluator真实入口消费已完成，human五维仍null、仅human_review_missing/inconclusive，外部业务PASS不冒真人评分。Preview仅暂存未部署、远端sudo、实体手机与真人评分各自保留缺项。


当前Web实现缺口已只读定位：POST /api/runs仅接受单目标/browser/desktop/auto，无法正式配置双native recovery与单文件grant；现factory又明确拒grant与hybrid/companion混用。此项属于需实现的已授权范围，report窄修及默认layered CLI后，设计并实现默认关闭的Host-owned native recovery profile（客户端仅opaque选择、Host冻结双窗/单文件/会话作用域），再真实Web完整T2；不把API fallback或native-only路线冒作T3 hybrid全链。

2026-10-12 08:33 历史variant运行快照（最新见顶部）：原冻结完整T2 variant high Run `run-1791765130536-e28cb507-99b` 已实际启动，CLI15497/PTY30197/ttys018、唯一monitor15503/observer15504均UID/start08:32:10逐核；ready2026-10-12T00:32:10.594Z<created .599Z<firstProvider11.421Z，goal1132B/d237535…逐字原卡，正文196B/ebe8不变。当前6 actualfetch配置high/enabled8192/nonstream已核，source95b/17dist/native98330不改。Luna唯一PTY/业务，Sol与Root仅只读；此时活跃未签variant结果。下方472累计与A07actual35为本轮启动前稳定数，新请求终态后正式对账。

2026-10-12 08:32 历史repeat终态稳定点（variant最新运行见顶部）：同版独立T2 repeat high-v7 `run-1791764743356-a4021c89-db7` 已seq119自然succeeded（00:28:10.987Z），PTY3979 exit0、summary同Run/cleanupDiagnostics[]。Sol独立业务限定PASS：eb092f5c…txt磁盘196B逐字58a4/6LF末1，实际view重开PNG；seq82保存verified→92CMDW→97fresh list→103handoff→112singleton→115/116新surface5 gen2，native最终18548，完整自主链。11proposed=11completed、0nativefailure，seq86多键keypress参数在派发前拒绝后模型自主改hotkey；15main/15known=164041input+4528output=168569tokens，全部high/enabled8192/nonstream。A07 actual35main/0risk35 seq35、reserve80/4/84 rev1；累计472actual=464main8risk、443known8235326tokens/29unknown，旧baseline20与旧批次不清零。这与baseline共同构成CLI L2/experiment Guardoff两轮通过，默认layered与Web L3未据此签收。

真实baseline v6已由隔离PR27 evaluator HEAD3f22正式入口零Provider消费：manifest9f923…精确绑定任务卡/轨迹/初末PNG，assessmentf354… terminal160/succeeded且图片bound；五维全null、inconclusive/successfalse、唯一缺项human_review_missing。Sol/Root业务PASS是外部独审，没有冒human或用负面strict-findings通道伪填正分。产物A07-private/a07-t2-baseline-v6-evaluator-{assessment,receipt}.json，原始材料保私有。

原冻结T2-variant.json保持1132B goal/d237535…、196B正文/ebe8（10/5、8800元最多2人、08:45集合09:20出发），原136d8091…txt首次目标仍absent。正常新blank recovery18554→primary18557的CMDN/SDKraise/Swift AX0/focus/modifier证据通过，同95b17dist/native8/high40入口--check exit0；已交Luna唯一PTY一次variant，实际Run待创建。本轮A07剩45main足40，不新增预占/不改cap。95b CI38186986942五job实际success；Rootkeeper8974至08:55:28、native98330/6f56签名/TCC不变。T2 variant未过前不勾总验收，完整T1/T3各三轮仍待实证；Preview仅暂存/实体手机/sudo/真人五维保持独立缺项。

2026-10-12 08:27 历史repeat运行快照（最新见顶部）：同版独立T2 repeat high-v7 `run-1791764743356-a4021c89-db7` 已由Luna唯一正式PTY3979启动，CLI13679/monitor13685/observer13686实际UID/start08:25:43与ttys018均独核。ready2026-10-12T00:25:43.414Z < created .419Z < 首Provider44.237Z，完整goal1133B/d04a925逐字新卡，只换eb092f5c…txt输出路径、正文196/58a4不变；HEAD95b/17dist/native98330/6f56均同版，high/enabled8192/nonstream实际出站已核。新recovery18512先建、primary18515后建均正常CMDN/SDKraise/Swift空白证据，不动上轮18506成果。Sol/Root保持只读，不代业务；现活跃未签repeat结果。此前完整baseline PASS与累计457actual/428known8066757tokens/29unknown为启动前冻结基线，本轮新消耗终态后按counter正式对账，不把旧数字当当前实时值。A07预占80/4/84 rev1，终态前不重置actual。现有monitor磁盘初态字段只在启动/结束持久化，实时进展直接读轨迹，不能把observedModelRequests=0当当前无请求。

2026-10-12 08:22 历史基线终态稳定点（最新运行见顶部）：完整T2 baseline high-v6 `run-1791764013665-187836ef-750` 已seq160自然succeeded，真实PTY2623 exit0、summary同Run/cleanupDiagnostics[]；Sol与Root独立业务限定PASS。指定371b9081…txt实际196B逐字等于原正文、SHA58a4fcd47da3982ab890ad46febf0eecd7c3c8d52b19723d65092d43cac43beb、88码点/6LF/末1LF/0CR；seq127 saved verified→133 CMDW completed→138 fresh recovery list→144 handoff→153 singleton正常应用odoc重开completed→156/157新surface5 gen2、实际nativeCGID18506及完整AX格式/正文，两位检查方实际看末PNG。模型自主纠正单键S并在Save click被拒后用RETURN保存，无人工补输入/绑窗/关闭/重开。此为CLI L2/experiment Guardoff完整基线，非默认layered或Web L3通过，也不代T2 repeat/variant及其他两线出口；recoveryReport.businessResult按设计仍not_assessed，业务PASS由独审单列。

启动监督ready2026-10-12T00:13:33.742Z < created .745Z < firstProvider34.618Z，完整goal1133B/SHA8a8923…逐字原v6卡、CLI11440/monitor11446/observer11447真实TTY/身份已独核，终态均退出。16 action.proposed精确等于14 completed+2明确refused，非16completed；20main请求/20已知usage=255033input+8278output=263311tokens，20实际fetch配置全部high/enabled/8192/nonstream。A07 actual20main/0risk20、seq20，正常append-only预占已续至80main/4risk84（rev1/cap120/6/126），actual与派发chain不变；旧A06冻结97main1risk98，累计457actual=449main8risk、428known8066757tokens/29unknown，未知不估填。下一同版repeat/variant正常独立fresh和新唯一路径，禁止复用本成果覆盖。

新原生只读journal实际319rows，call9/root18455与call192/Save18476拒绝时frontmostPID22394、focusedCGID均exact；point gate实际阻断者为预备recovery18458且CG层序在target之上。不能再把这两拒绝泛称失焦/overlay/外部活动；保持严格拒绝且未重放，模型自己换正常键盘路径推进。报告summary.finalComputerTarget仍18458属reporting.ts72–84只跟踪最后handoff/switch而未投影reopen目标的旧元数据，新native末call319和surface观察证实18506；已登记窄报告缺口，暂不改95b以保持复验同版。独审原始回执位于本Run的sol-terminal-business-independent-review.json及root-terminal-independent-review.json（私有，不提交正文/PNG/轨迹）。

F085冻结HEAD95b8449已原SHA同步PR26；当前95b8449 CI38186986942已由Root实际GET核五job全部completed/success（root-95b8449-ci-terminal-readonly.json），不继承旧head。native98330/6f56/CDHasha47177/签名与TCC不变；Root唯一keeper8974至08:55:28，保活非focus证明。完整T1/T3与各repeat/variant仍未验收；Preview08dec仅暂存未部署，实体手机/远端sudo/真人五维独立待补。

2026-10-12 08:13 历史启动前稳定点（最新见顶部08:22）：F085已精确11文件提交95b8449bc1e3d1bef06f68621c94547f1c75c358并正常API原SHA同步PR26（session68411 exit0），新CI待实际核；此前f14cd66/38185945146五job实际success只属test-only历史版本。新增Host singleton opt-in Observation保存事实：精确授权文件ENOENT+稳定父身份才absent，exact当前clean/app/URL+初尾filepin才verified，其余unverified；默认/恢复blank/重开新CGID省略。不输出正文、路径或操作建议，不放宽grant/Guard/未知不重放。fingerprint只比较source/status，保持同状态新Observation ID的no-op拦截。

作者修前四文件595/595、tsc-b session82041 exit0；Sol捕获parent负例原fixture缺有效native proof并纠正，修后作者单例1/1、Sol独跑CUA20/20+Runtimefingerprint1/1、Root Context/trajectory2/2。EACCES/EIO仅生产classifier注入reader正反，不冒OS权限实验。Sol唯一GUI真实零HTTP完整singleton run-1791763650712-7605c90a-84e已succeeded：16本地fixture决策、13completed Computer动作回执、33B精确SHA244236，compiled Provider文本absent→保存verified→恢复/重开omit、持久obs/ref绑定，关闭/恢复/重开/fresh普通操作/finish通过，Root独读磁盘/轨迹/消息并实际view重开PNG。未额外采native launch原raw计数，1reopen提案不能冒原生调用计数；此为短诊断，非正式T2业务通过。详[F085](./a-line-sync/fixes/F-20261012-085-authorized-save-observation-evidence.md)。

A07新有界预占40main/2risk/42、cap120/6/126、actual0/seq0/rev0；旧A06仍97main1risk98，累计437actual=429main8risk、408known7803446tokens/29unknown，未知不估填/不重置。下一完整T2 high-v6仅新371b9081…txt路径，完整goal1133B SHA8a8923…、正文196B SHA58a4/6LF/末1不变；newblank主18455/恢复18458正常CMDN+SDK/Swift exact空白证据、17dist含Context/trajectory已冻结，最终--check exit0，已交Luna唯一正式PTY入口一次执行，尚待实际Run创建。正式基线沿experiment Guardoff，0HTTP layered诊断另列；不冒默认Guard业务通过。native98330/6f56/TCC与签名不变；Root唯一keeper8974/session92247至08:55:28，非持续focus证明。完整T1/T2/T3及repeat/variant仍待实证，旧失败文件保留；Preview08dec仅暂存未部署、实体手机/远端sudo/真人五维各独立。

2026-10-12 07:49 历史稳定点（最新见08:13）：T2 high-v5 `run-1791761681216-a295fdff-1f7` 已seq154 cancelled，真实PTY70880 exit0、summary同Run且cleanupDiagnostics[]。首事件前监督ready通过；20main请求全部真实high/enabled8192/nonstream，19known=236539tokens+1unknown；A06实际97main/1risk/98（seq98、rev2 reserve120/6/126，剩23main不足下一40），累计437actual=429main8risk、408known7803446tokens/29unknown，旧417保历史。模型自主保存/100CMDW/111handoff恢复空白后首次选择reopen_saved_document；120明确NOT_READY、未launch，因为指定dca26…txt不存在，实际无扩展名同basename文件196B/6LF/末1/SHA58a4准确保留；之后CMD+O未准入Open、focus拒绝，monitor在142/151同图后正常取消。完整T2仍不通过，不修改错误路径文件/不放宽grant/不手动拼接业务。

Sol独立两份新scratch有限Save诊断（各10真实动作/1Saveclick、0真实HTTP、非正式T2）复现：蓝勾自动.txt但省略后缀会落无扩展名；显式.txt则落正确.txt。33B诊断正文均精确SHA244236，SDK新鲜AXDocumentURL/clean/唯一域证明通过；不把checkbox画面当文件路径证明，也不归native输入吞字。依据[只读保存证据审查](./astra-authorized-save-evidence-review-2026-10-12.md)，下一最小实施仅Host singleton optin的独立Observation事实字段：精确授权文件明确ENOENT且父身份稳定才absent，当前exact native clean/app/URL+稳定filepin才verified，其余unverified；不合成AX元素/不输出正文路径/不改动作许可/不自动rename。Luna唯一产品作者、Sol检查，先定向测试和0HTTP再新有界批次paid。

F084只修Host relay测试误把opaque token值包含pID当字段泄露；递归键名检查保pid/windowId/socketPath隔离，作者2/2+Root独跑2/2/diffcheck0。首个最小两文件提交5abded5已原SHA API同步PR26，CI38185500145五job实际success；另server.test同因4处已作者8/8+Root独跑8/8，最小两文件后续提交f14cd66已原SHA同步，新head CI待独核。旧cf4随机token误报失败保留，不冒当前绿。A07已正常initializeBatch预占40/2/42、cap120/6/126、actual0/seq0/rev0，0700目录；Sol独核counterfc6f…与旧A06counter9c8e…未变，尚无Run/HTTP。native98330/6f56签名/TCC不变，Root唯一keeper4185至08:14:19；Preview08dec仍仅已暂存未部署、实体手机与真人五维各独立待补。T1 high循环与旧low事实错误分开，不同因盲跑；T3与T2三轮全出口仍待实际证据。

2026-10-12 07:36 历史运行中快照（最新见顶部/文末）：仅工具说明澄清F083最小2文件提交cf4e54b已原SHA同步，新CI待实际终态；此前a3fb五绿属已完成版本。完整T2 high-v5 Run `run-1791761681216-a295fdff-1f7` 正在运行，真实PTY70880/CLI6374/ttys021，唯一monitor6380/observer6381，ready2026-10-11T23:34:41.278Z早于created及首Provider42.048Z。原完整goal1133B SHA47bd98f3…/正文196B不变，仅新唯一dca26b32…txt路径；显式新变量为正常应用open-document handler的工具说明，非任务答案/权限放宽。fresh主18318/恢复18325正常新空白；Sol仅只读核FD/argv/轨迹/文件，不GUI。输入88字符已完成，首实际exchange均high/enabled8192/nonstream；尚不签保存/关闭重开/业务成功。本轮40请求上限、A06 rev2 reserve120/6/126，启动前actual77main1risk78/剩43main；实时累计须终态后按真实counter核，旧417终态总数保历史。native98330/6f56与TCC不变；Root keeper4185至08:14:19。

2026-10-12 07:28 历史T2 high-v4终态（最新见顶部）：完整1133B/goal07f347卡 Run `run-1791760881790-78afed3c-563` 已seq175 cancelled（真实PTY6058/CLI4845）；ready2026-10-11T23:21:21.846Z < created .851Z < firstProvider22.585Z，唯一monitor4851/observer4852启动前就绪，Sol/Root独核。22main请求/21已知响应268309input+6552output=274861tokens/1取消transport未知，全部22真实出站high/enabled8192/nonstream；A06 actual77main1risk78/seq78/reserve120/6/126 rev2余43main，累计417实际=409main8risk、389known7566907tokens/28unknown。指定6fa7829a…txt由Harness保存为196B/SHA58a4/6LF末1逐字准确；129CMDW完成后133list/137switch/140handoff/141fresh恢复空白均自主。模型实际收到reopen_saved_document，却在seq145明确因“应用正常打开”措辞选择CMD+O；149Open创建后未纳入现scope，list仍只有恢复blank，再次CMD+O及click被精确Guard拒绝，未重开目标正文。监控在matching163/172两次无进展后正常SIGINT，175cancelled，未人工绑Open/保存/关闭/重开或注入答案，完整T2未通过。summary绑定本Run/cleanupDiagnostics[]，PTYexit0；旧文件与Run均保留。F082真实Save返回正文已过且a3fb288当前CI38183706125五项实际success；不能把本轮Open能力缺口归F082。下一仅澄清正常应用open-document工具说明这一有证据新变量，不改原goal/不降Guard/不偷偷补正文末LF，不做同条件paid重试。新Open未准入仍独立缺口；既有singleton仅Host授权单文件。Root唯一keeper4185/session61950至08:14:19，native98330/6f56签名及TCC未变。

2026-10-12 07:20 历史修复稳定点（最新见顶部）：F082最小3文件提交 `a3fb288c77babca5068c9bec5cb0ad0e6f245537` 已通过正常API原SHA同步PR26；新CI38183706125尚in_progress，不继承583ad五绿。修复仅在已准入Mac AXSheet明确offscreen且完整局部AX-none时，一次80ms新库存/父几何/新AX证明重采后pop，保持身份、可见性、owner显式冲突、stack/session/abort拒绝；globalpartial原局部授权路径不变。作者全CUA333、修后focused11/tsc通过；Root corrected-fixture独跑11通过，纠正首fixture默认补owner遗漏。Sol独立typecheck/build成功，source8ce081…/dist0c83ced…；真实scratch `run-1791760483385-9ce97acf-d5d` 10真实动作/1Save点击/0HTTP，exact18226两轮hidden无owner/minimized，父18219 s95/s96局部AX-none/focus/几何全证，实际命中重采后seq99pop并fresh正文，诊断33B精确/无errors或cleanupError，Root独核。此仅Save→正文限定验真，非完整T2关窗重开。原580路径196B正式成果及失败Run保留；累计仍395实际/368known7292046tokens/27unknown，A06 actual55main1risk56/reserve120/6/126 rev2余65main。下一完整原196B/1133B high-v4仅路径改6fa7829a…txt，goalSHA07f347ba…；fresh正常File>New主18242/恢复18249空白证据通过、入口--check通过，桌面已明确交Luna正式执行，Sol只读监督。native98330/6f56及签名/TCC未改。Root唯一保活4185/session61950至08:14:19。T1/T2/T3及repeat/variant完整出口仍未验收，Preview暂存未部署/手机/远端sudo/真人五维独立。详见 [F082](./a-line-sync/fixes/F-20261012-082-macos-hidden-attached-sheet-pop.md)。

2026-10-12 06:55 历史终态快照（最新见顶部）：T2 high完整1133B/c777卡 run-1791759145646-03171953-90f（真实PTY78701、CLI2490）已seq75 cancelled。首事件前监督ready 2026-10-11T22:52:25.704Z < created .709Z < firstProvider 26.462Z；monitor2496/observer2497实际就绪。8main/8已知响应89055input+2242output=91297tokens，全部出站high/enabled/8192/nonstream，正式基线仍experiment Guardoff，不冒默认layered通过。指定58048215…txt已存在且独读196B/SHA58a4fcd4…/6LF/末LF1逐字符合原正文；但Save HID click seq71 completed后seq73弹窗unknown，未完成返回正文确认/关闭/重开，完整T2仍未验收。同步原生日志当刻call124全库存保留18195 offscreen，call125 PID库存无18195，call126父18178完整AXChildren checked-none+精确parentfocus；源码candidate存在即拒绝，后续只读定位/窄修，不重放已完成Save。A06 actual55main/1risk/56，sequence56，reserve120/6/126 rev2、余65main；累计395实际=387main+8risk，368已知usage7292046tokens、27未知。HEAD583ad75与CI38179849164五绿不变，native98330/6f56…不重签。T1 high旧轮不完整、T1/T2/T3及repeat/variant均未整体验收；Preview已暂存未部署，手机/远端sudo/真人五维独立。Root唯一保活142/session93626至07:26:37。

评测器 A 已完成：PR27 当前 `3f22c30` / CI38164866905五绿，严格 independent findings 的真实旧T1产物 `runs/astra-autonomous-20261010-sol-luna/pr23-real-evidence/sol-t1-a05-strict-findings-assessment.json` 已由 Sol/Root独核（独立业务failed、overall inconclusive、successfalse、humanReviewRequiredtrue、五维null）。`astra-t1-finish-evidence-contract-proposal-2026-10-12.md` 的 A 为历史设计，B仍仅设计；不重复实施A，不将报告表达修复冒充事实错误已修。本轮T1 high未完整比较，不能计为旧M4/M6冲突的新复现。

2026-10-12 06:40 历史终态快照（最新见顶部）：正常Web按钮启动的T1 high原793B/f84e卡 run-1791757425578-ba44eb55-c17 已于2026-10-11T22:38:22.490Z/seq195正常cancelled；Sol在第三次Air配置区上下往返、仍无新标准SKU/其余两源时，从waiting_approval点经正常API一次abort。15main+1risk=16实际请求，15已知响应386442input+6175output=392617tokens，risk超时14993ms无usage仍未知。全部16真实出站high/enabled/8192/nonstream；11动作回执completed，无native refusal，但完整三产品比较未完成，不能标业务成功或事实纠错已通过。monitor99503首ready早于created/首Provider，observer99666晚seq37；两者均terminal正常退出，延续monitor仅准备未启动。当前583ad75 exact-head CI38179849164五项实际绿，native98330/6f56…TCC有效。A06 actual47main/1risk/48、sequence48；正常append-only续reserve120/6/126 rev2，cap不变、actual不改。累计387实际=379main+8risk，360已知usage7200749tokens、27未知。下一T2 high仅原完整1133B/196B末LF正文及新唯一输出路径，入口静态校验/正常fresh尚待；T1/T2/T3及repeat/variant完整出口均未验收。Preview08dec已暂存未部署，远端sudo、实体手机与真人五维独立。Root唯一保活142/session93626至07:26:37。

2026-10-12 06:18 历史准备快照（最新见顶部）：第八版完整原生诊断补丁已按隔离 archive+前六补丁→native8 闭环重放，17源SHA与候选一致；原先“旧六补丁缺修改”的判断已撤回，原因是重放目录继承父Git导致apply跳过却exit0。正式补丁650bb5…、源码/F081最小提交583ad75。作者native370通过/2忽略、fmt/check/release及实际driver release均exit0；Root独核release2d35…与签名6f56…的40个Mach-O section一致。候选PID98330、CDHash a47177…，AX/两项TCC pass，独立bundle整体degraded/capture健康skip保持如实。真实SDK非空overlay诊断首次揭示私有journal缺函数，修后4/4独检与新UUID7e5e逐字段journal闭环通过；旧空journal失败保留，不能当旧T3拒绝根因已修。旧Host95099已正常退出；新T1 high Host99001/PTY43033已监听，尚无Run/新Provider。正常Chrome owned窗口已实际打开Web连接页并生成配对请求；为保真实Web按钮和首事件监督，正在接通原正常issueSession的私有只读凭据观察，不额外签发/轮换会话。T1沿原793B/f84e卡，仅high推理变量；40请求/90s，其余合同不变。A06仍32main/0risk/32、reserve80/4/84 rev1、cap120/6/126；累计371实际、345已知usage共6,808,132 tokens、26未知。完整T1/T2/T3均尚未验收；原b14五CI绿属于先前源码头，新583ad75 CI待实际核。Root唯一保活95737至06:37:48。

2026-10-12 05:38 历史T3终态快照：完整卡 `T3-baseline.json`（goal 1,091B，SHA `bf91c23c653d483c56b94ee9e7b3f78ad96fe7875ea613e42b498f1c9a793bfc`）的 Run `run-1791754389657-c38e7a64-b3a` 已在seq52终态cancelled。4次model.request.started中3次收到响应，已知usage 54,869 tokens；第4次取消且无usage。轨迹seq17/29/44三次pixel click均收到精确前台未聚焦/无遮挡证明失败、明确未派发pointer或mouse事件。monitor通过正常认证Host API收到HTTP202 accepted（expectedSequence 33）；这不是业务完成。native只读日志 `A06-private/host-output/native-readonly-cua-calls-39d20b01-3091-4ed3-9a25-b08c505f313a.jsonl` 共26次调用，记录Chrome PID95348/CGID17934；当时采样前台/焦点均为该窗口，但不能据此判断内部点击守卫的具体失败项。之后PID95348已不在进程表，Host PID95099仍监听4317。没有完成三车次来源查询、8800预算纠正或保存；唯一输出文件不存在，完整T3未通过。A06正式counter现为32main/0risk/32，sequence32；reserve80/4/84 rev1，cap120/6/126。累计371实际（364main+7risk），345个已知usage响应共6,808,132 tokens、26个usage未知。真实入口为authenticated Host API/Runtime，Web按钮未验证；详见运行目录的 `sol-terminal-independent-review.json`、monitor receipt及native journal。


2026-10-12 05:08 当前增量：完整卡 `T2-baseline-recovery-v2.json`（卡SHA `12679a13dcb6369000de73ceb7387da1601d37fdb80e396b6ba128bb2af05006`；goal 1,133B、SHA `7f9d391e16604b912b37afc8f93ec0e20c3d64d6a01dfa3522a8b43c8b0b5d4a`）已用真实TTY运行一次：`run-1791752596454-88e8d61c-a3f`，CLI 94044、session 36008；starter-ready 2026-10-11T21:03:16.511Z，首request-started 2026-10-11T21:03:17.338Z，监控94050/只读观察94051均在controller启动前就绪。Run于seq67 cancelled，8 request-started中7个有response、已知usage 80,645 tokens（input 78,995/output 1,650）；第8个启动后取消且没有usage，计1条未知。A06 counter从20/0升至28/0，reservation仍80/4/84 rev1，cap120/6/126；累计367实际=360 main+7 risk、342条已知usage 6,753,263 tokens、25条未知。AX在seq38观察到正文格式metadata为196B/88码点/LF6/末尾LF1；seq36 SHIFT+CMD+S新建副本后只读观察焦点转至17911，之后指向原17896的CMD+S因目标未聚焦被拒。monitor根据相同截图seq55/64于约60.4s后SIGINT；没有完成指定路径保存、关闭与重开，指定输出`T2-baseline-a40bae2f-8ce6-45b3-927b-78fbb9d292ad.txt`不存在，完整T2未通过。summary cleanupDiagnostics为空、无已记录副作用；report/summary与monitor/native-call/observer原始证据已逐字节保存在Run或其归档receipt，不手工修改现场。详见`runs/live-cli/run-1791752596454-88e8d61c-a3f/sol-run-archive.json`。


2026-10-12 04:27 历史快照（最新见顶部）：第七native及显式单文件重开链已签收限定范围。Sol独立16目标回归/相关tsc通过；真实生产SDK+Runtime本地fixture `run-1791750280897-8dd2f22d-bb7` 在13次layered Guard allow下完成33B短诊断保存→一次CMD+W→control-only list/switch空白17703→一次正常reopen新CGID17837→fresh图→普通ESC→再次观察→succeeded，errors/cleanup为空、0真实HTTP。文件精确字节及AXformat33B/12码点/LF2/尾LF1保持；真实odoc仅ctime变化，after-open四pin与1.5s/8次有界只读settlement通过，派发前五pin保持。此前77d77及79ed未知样本原样保留，不重发许可；六摘要下方04:13/旧阶段均按历史阅读。详见[F080](./a-line-sync/fixes/F-20261012-080-singleton-saved-document-reopen.md)。完整T2/T1/T3三轮出口仍未验收，下一步冻结与全卡正式T2；累计351/A06 actual12/0/12不变，正式40请求前append-only续额，native签名/权限不需重做。


2026-10-12 历史稳定点（最新见顶部）：恢复窄链最小提交 `756a285`（11产品文件及F078），共享测试修正后当前head `b84beee` 已原SHA非force同步PR26，CI38164594302实际五项全绿；`3594bad`五绿为前一组合。Sol独检相关363测试、最终全仓typecheck及选定文件diffcheck均通过；前轮Runtime164通过与本轮Computer306/CLI15/factory42分列。真实生产CuaDriverComputer/Runtime本地fixture `run-1791742995441-f9d7fa57-d83` 完成一次关闭→control-only list→switch预授权空白17703→fresh capture，四本地决策、0真实HTTP，旧截图/grounding未入两恢复请求；仅证明恢复生命周期，非生产Guard或完整业务通过。详见[F078](./a-line-sync/fixes/F-20261012-078-bound-window-recovery.md)及[独立生命周期审查](./astra-bound-window-recovery-review-2026-10-12.md)。

后续独立诊断明确原两窗scope仍不能覆盖正常打开：生产CMD+O生成非modal Open17724（AXParent为Application，非root direct child），下一输入按精确身份拒绝；辅助正常UI独立选择短诊断文件才生成新正文17742，原空白17703仍在。该辅助步骤不计Harness业务成功，诊断正文已正常关闭，旧195B正式成果保留。现已进入显式Host单文件重开实现：复用公开launch_app，初始空白以独立application identity固定bundle/executable/PID-start，保存后仅精确AXDocument、typed Edited=false及已完成关闭后真实缺窗链产生一次许可；新文稿仍须fresh唯一文档关系与capture。第七native证明已由作者完整测试、Root静审、Sol真实SDK验真并获Root独核；主repo单文件Run入口及固定负例正集中收尾，尚未签收完整业务。不把samePID/title/new window当关系证明、不付费撞已知屏障。T1确凿业务错误、T2末LF缺失/尚未重开、T3及三轮完整出口仍未验收。

当前第七候选PID83118/PTY63828，signed SHA544937…79b6b7/CDHash010956…a52401，两项TCC与AX pass；独立bundle身份预期degraded、health只读capture skip均如实保留。旧六版完整App回退副本保留，stock4254不动，无新增Provider。真实生产SDK新文档17768唯一full proof及1312×844截图、47B/17码点/LF2/尾LF1已独核，诊断文档已正常关闭；该诊断不是单文件许可Run或T2业务通过。详见[F079](./a-line-sync/fixes/F-20261012-079-saved-document-identity.md)。累计351实际=344main+7risk，327已知usage6585909tokens、24未知；A06 actual12/0/12，正式reserve40/2/42，下一40请求前须append-only续额。所有正式Run终态，无在途Provider。Root唯一自有保活84924/session34721至04:58:07，保活不代表前台或解锁证据。PR27严格failed findings已签收，5处随机token值正则误报已由Luna最小修复；Sol独立integration60/evaluator72通过，PR27当前head `3f22c30` 已原SHA非force同步、CI38164866905实际五项全绿；Preview08dec5e已暂存未部署，远端sudo认证与手机/真人条件仍独立。

2026-10-12 历史稳定点（最新见顶部）：第六格式元数据最小源码提交 `3594bad`，原SHA远端同步PR26，当前head CI38158346567实际五项全绿；旧65a CI成功仅为历史组合。候选PID62961/PTY54227，SHA `ca0afcdf6626533b8fcd950eb894f41b1cf44c52c702a7f207425d23a6b43392`、CDHash969fd62b…2e67e9，两项TCC及AX pass，独立bundle身份预期degraded。Sol从d114独立重放六补丁，10源文件全match；作者native359通过/2 ignored/check/build/fmt成功、Sol独立TS390通过/typecheck成功。真实生产SDK空字符串format全0；短中文emoji CFString为37UTF8B/14码点/LF3/尾LF2/CR0，native与Grounding投影精确一致，AX全文读回true，诊断自有文稿正常丢弃；仅证明AX格式，不证明磁盘字节。详见[F077](./a-line-sync/fixes/F-20261012-077-macos-ax-text-format.md)。

PR27 `9af208e` 严格独立findings已实现并独检172通过，真实T1/A06均validated failed、真人五维null；attempt1旧Runtime短等待失败，attempt2随机token包含“pId”被JSON值全文正则误报，属于共享测试键名检查缺陷，下一最小修，不盲重跑。当前继续显式两个精确scope/最多2请求/control-only选窗恢复；实现与真实验证尚待完成，暂无新paid。累计351实际/A06 actual12不变，所有正式Run终态。


2026-10-12 历史稳定点（最新见顶部）：源码 `65a674c` 已原SHA同步PR26，当前head CI38154699416实际success。第五native候选PID55846/SHA35a015e1…37aee011、CDHashe66042bb…6dffdd及录屏/辅助功能授权保持；独立native356通过/2 ignored、五补丁clean重放及正常窗口Cancel正例/错误焦点零派发负例已签收，stock4254与旧6664完整App可回退。

完整原卡T2 `run-1791735376974-18f3898f-d44` 使用1133B goal、fresh17640、真实TTY和40请求上限，已由Harness完成正文输入、Save→GoTo→Save、保存及CMD+W关闭。实际文件195B，SHA914a2131d82950ad515e30d8d65b9c8155bffd0c3ad218a75e99da52a69b22f2，恰为指定196B正文缺最后LF；首次model.response已只给87字符，不能归因native吞LF。seq118关闭后bound_window_missing暂停，尚未重开，正常取消至seq120 cancelled，cleanupDiagnostics为空。旧成果保留不覆盖；完整T2仍未通过。监控与只读observer实际于启动26秒后挂载，不能冒称seq0监督。

A06 actual12main/0risk、12条已知usage294247tokens，cap120/6/126、首reserve40/2/42；累计351实际=344main+7risk、327已知usage6585909tokens、24未知，金额未知。A05冻结92/1/93。所有正式Run终态，无在途Provider。下一步先完成PR27可选严格独立findings，显式保留T1确凿业务失败及真人五维null；再补原生文本格式元数据与仅显式自有空白scope的control-only恢复选窗。不得给type偷加LF、自动选未知旧稿、以人工绑窗拼完整成功；新完整T2须新唯一路径/新冻结卡，原正文不变，正式续预占后再运行。T1/T2/T3三轮完整出口均未验收。

Preview08dec5e闭包已正常用户0700暂存、逐SHA/default inspect及packaged Relay smoke通过，未部署，远端正常sudo认证独立待补；手机音频/真人试用评分独立待补。Root唯一保活61391/session80175至01:38左右，不改锁屏策略。

PR27独立findings增量已最小提交`9af208e`：Sol最终172/172独检，真实T1 source_conflict与A06 cancelled/incomplete_task两条均按Run/manifest/family/variant/trajectorySHA/terminal及实际PNG/动作绑定为validated failed；runtime outcome保持，五真人维度null、overall inconclusive并显式independent_business_conflict，不能读成仅差真人。元数据根因已进一步明确：native value_state在structured输出前trim末LF，不能从现有item.value计算末LF；第六补丁将仅从trim前CFString计算有界格式计数，不改type。详见[文本格式独审](./astra-text-format-evidence-review-2026-10-12.md)。

2026-10-12 历史阶段快照（最新见顶部）：第五native补丁 `a47655cc…94cb1` 已由Sol从显式d114基底顺序重放五补丁，9源文件与构建源逐字节一致；最终源码独立全native测试356通过/2 ignored（作者355为较早时点），fmt/check/build通过。候选SHA `35a015e1…37aee011`、CDHash `e66042bb…6dffdd` 已严格验签并正常切到PID55846/PTY83613，socket仍为A05独立socket；旧6664完整App备份可回退，stock4254未动。真实health录屏/辅助功能/AX能力均pass，overall仅独立bundle身份预期degraded，不冒全pass。

Sol互斥零Provider验真：新空白17616→Save17622，正常window foreground单左键Cancel中心480374一次后sheet消失、root checked-none；回执仍unverifiable，实际效果由新鲜窗口结果证明。另一自有空白17629前台时点17616，原生派发前拒绝且明确无pointer/mouse event，cursor前后700597、焦点17629及四修饰键释放不变。Root独立只读复核同结论；两自有诊断空白已正常关闭，旧正式稿不动。此仅修复签收，不是完整T2保存/关窗/重开通过；GUI已交Luna准备新有界A06原1133B/196B完整卡。A05 actual92/1/93及全历史339请求/315已知usage6291662tokens/24未知均未变，A06已通过initializeBatch创建，cap120/6/126、首reserve40/2/42、actual0/sequence0；所有正式Run终态、0新Provider。第五patch+F076最小提交`9bb3143`，当前head CI尚待实际结果，旧5fa五绿仅历史。既有完整T1业务失败（Mini M4/8核与实见M6/12核冲突及三SKU未绑定）、T2/T3未验收独立保留。Preview08dec5e仅已暂存未部署，正常sudo交互认证仍缺；手机与真人项分栏。Root唯一保活55022至00:46左右，不改变锁屏策略。

2026-10-11 历史阶段快照（最新见顶部）：`5fa93a5`当前五项CI全绿；完整T1 `run-1791731184145-e28eb930-653` runtime succeeded，但独立业务验收失败。最终Mini写M4/8核CPU/8核GPU，与本轮seq49截图M6/12核CPU/12核GPU及seq284刚读回的M6记忆冲突；三产品RAM/SSD仅灰色可选范围，不足证明最低价标准SKU已绑定。三官方页面、6999/9999/12499起价、来源与9000预算算术有证据，不升格完整任务通过。末请求选取包含seq284，不能归因简单记忆预算淘汰；不再同版付费复验/变体。PR27/cb6aacf现成评测器零Provider消费为inconclusive/success=false、human_review_missing，五维null；该结果与确凿业务错误并列。

本T1实际24main+1risk=25请求，25已知usage合计668230tokens。A05实际92main/1risk/93，cap/正式预占120/6/126 rev2；全历史339实际=332main+7risk，315已知usage共6291662tokens、24未知。所有正式Run已终态，无在途Provider；正常session已关闭managed Chrome51243，Host51224已收一次正常SIGTERM，TCP先关闭、Unix FDs短暂延迟后进程也退出，未发送第二signal。53589监控已退，51488只读观察按限时结束；Root于23:46正常续唯一自有保活55022/session39223至00:46左右，仅结束已核身份的旧50729，不改变锁屏策略。

Sol互斥零Provider新scratch17584对照：独立Save17590的Cancel中心480374由production window pixel路径单次posted后未关闭、前后PNG相同；正常ESC仅清该诊断sheet。另一独立Save17598经新桌面3024×1964/1512×982@2及精确关系/focus核验，真实桌面14001194单次global HID后sheet消失、root checked-none。核心泛化route字段不能单独证明派发方式；原始回执与源码path区分。此证据支持最小窗口foreground无modifier左键HID修复，Luna离线实施、Sol检查；现40307/6664a3ff候选尚未含该修复，后台/AX/生产Guard不变。旧正式正文/Save及unknown稿均保留，不用诊断冒保存成果。完整T1/T2/T3及三轮仍未验收；Preview08dec5e仅已暂存未部署，远端正常sudo认证与实体手机/真人试用评分分别留栏。

2026-10-11 历史阶段快照（最新见顶部）：源码 `5fa93a5` 已原SHA非force同步PR26，F075仅对嵌套sheet几何动画不一致作一次80ms只读重采；Sol独立337/337通过，实机8c6e5819确实命中inventory y261/AX proof y288，重采两侧y288后root→Save→GoTo自动push及双pop完成（0Provider、0type，非0input）。原生候选40307/SHA6664a3ff…与TCC不变。新5fa93a5当前head五项CI已实际全绿；前一dc4b64e五绿另列历史。

最新完整T2 `run-1791730632910-7a12d2e8-378` 使用新空白17443、原完整1133B/196B卡、真实TTY及40请求上限；完整正文、Save→GoTo导航、路径与文件名输入均取得completed回执，返回Save后连续正确按钮坐标click只有posted未验证且画面不变，指定输出仍不存在。唯一monitor实际晚至15:00:23Z才挂（不能冒称启动时已监督），随后同图阈值自动SIGINT，seq174 cancelled；未保存/关闭/重开，不算完整T2通过。旧17109未知副作用正文、17360及本轮17443未保存稿保留，不重放旧动作。下一步转独立完整T1原三产品卡，Save click再作零Provider精确归因，不同因付费盲重跑。

本Run18实际请求、17已知usage合计429214tokens，第18取消失败无usage保未知；A05 actual68/0/68，正式append-only预占与cap120/6/126 rev2，余52main。全历史314实际请求=308main+6risk，290已知usage共5623432tokens、24未知。T2 monitor50987/session34018及只读observer50989/session27671已退出，summary.cleanupDiagnostics为空。随后正常A05 Host51224/PTY10136、新配对创建完整T1 run-1791731184145-e28eb930-653，793B原goal SHA f84e0557…已独核；API abort监控初始51335/session20912在23:24:06精确正常退休，因有效三产品进展换为53589/session38404、1800s有界，旧收据和续监记录保留；Host只读observer51488/session42184按900s限时于23:22:46退出。监控实际启动后首次独核时seq22，当前T1活跃，不能再称所有Run终态。314为该T1启动前累计，活跃调用待终态对账。Root唯一保活50729/session43551至23:59左右，未改变锁屏策略。

Preview仍为已验08dec5e独立Web/Relay闭包：正常用户0700暂存、逐SHA、remote default inspect及packaged Relay smoke均通过，未部署，生产155349/current/health保持。正常远端sudo认证/策略核与实体手机、真人试用评分分别留栏，不因本机任务等待部署。

2026-10-11 历史稳定点（最新见顶部）：源码 `dc4b64e` 已原SHA非force同步PR26，当前head五项CI全绿；Mac type/ref合同修复作者与Sol独立11/11通过。原生候选40307/SHA6664a3ff…及TCC不变。最新完整T2 `run-1791726173541-4317c68e-58f` 实际原1133B/196B卡、17360新空白、真实TTY、40请求限额执行：首个显式ref被映射前明确拒绝后，模型省略ref并完整输入88字符，Save自动push成功；CMDShiftG完成后嵌套关系无法确认而暂停，正常取消至seq58 cancelled，未保存/关闭/重开，完整任务仍未通过。

本Run6请求、6已知usage合计106674tokens；A05 actual50/0/50、sequence50，正式append-only预占120/6/126 rev2与cap相同，余main70。全历史296实际请求=290main+6risk，273已知usage共5194218tokens、23未知。monitor47942/session70303与只读observer47943/session71763已正常退出；当前所有正式Run终态，无在途paid。observer在嵌套暂停后初段证明前台TextEdit22394/AXFocusedCGID17378，数分钟后前台其他应用不能倒推暂停原因；晚读raw无proof也不能单独证明原生缺陷。进行至多一次带实际原始调用记录的零Provider嵌套定向复现；无充分原因不盲改/同版重复T2，T1完整三产品卡可独立继续。

Preview仍为已验08dec5e独立Web/Relay闭包：正常用户0700暂存、逐SHA、remote default inspect及packaged Relay smoke均通过，未部署，生产155349/current/health保持。正常远端sudo认证/策略核与实体手机、真人试用评分分别留栏，不因本机任务等待部署。Root唯一保活47481/session80700至22:37，未改变锁屏策略。

2026-10-11 历史稳定点（最新事实见顶部）：08dec5e源码、CI38141124345 attempt2成功、候选40307/6664a3ff…及TCC保持；新完整T2 run-1791725133526-8670a646-c6d以1133B正确原卡、真实TTY及新空白17266执行，11请求/211677已知tokens。seq31/49为模型主动elementRef被拒；native精确焦点无文本派发拒绝为seq68/107，修后唯一monitor46785/session92658在107后0.207秒SIGINT，seq110 cancelled，无在途type及新副作用推定。17266之后AX只读为空；完整保存/关闭/重开仍未成。累计284main/6risk=290实际请求，267已知usage合计5087544tokens、23未知；A05 actual44/0/44，正式预占80/4/84 rev1余main36，下次40请求前必须按正常接口续预占，cap不变。

零Provider精确因果对照32bd6720：唯一normal bring_to_front后WS front_process_matches与workspace_frontmost_pid均证TextEdit22394/17266，逐步click→CMDShiftT→click→短中文诊断type后各次Swift frontmost/AX CGID一致，16字符精确AX读回且modifiers全释放；未复现旧Run失焦。事后Chrome前台不能倒推旧Run原因，不改原生Guard或把该诊断算业务成果；诊断稿未保存且旧17109完整196B稿保持。下一步仅最小Mac type/ref合同修及真实fresh前台门槛，不同版盲跑。新Preview08dec5e正常用户暂存/default inspect及本地packaged Relay smoke完成、未部署；正常远端sudo认证/实体手机/真人分别留栏。


2026-10-11 上一稳定点（最新事实见顶部）：源码08dec5e已原SHA非force同步PR26，F1可信浏览器四维几何/F2有界预览归一化与共享限额/F3无文字终态与错误详情/F4未知结果中性语音已选择性修复；Sol独立11个不同文件229项通过，Root正常生产Web headless五终态/390×844检查通过（fixture，不是实体手机）。当前CI38141124345首轮失败：Ubuntu22/24及macOS22通过，Windows离线测试两个短轮询窗口和一项TUI超时失败，ci-required随失败；已正常rerun failed jobs一次，attempt2 completed/success。旧2e6d898/fa19cbb五绿均为历史，旧fa19cbb包不得apply。

最新完整T2 Run run-1791723552415-4e080fc5-4fb的run.created.goal与1133B完整原卡逐字节一致，正文196B、真实TTY、target22394/17109、40请求上限。实际16请求/352654已知tokens，终态outcome_unknown：前两次type由native精确焦点守卫明确拒绝且未派发；Sol直接SIGINT时第三次type已开始，Rust future aborted后无法认定零副作用。只读AX随后确认17109正文与完整196B原卡（含末尾LF）精确匹配；文稿保留，不重放、不清空。指定文件仍不存在，保存/关闭/重开未完成，完整T1/T2/T3及各三轮均未通过。事后frontmost43919为哔哩哔哩、TextEdit应用局部AX焦点仍为17109；这是事后证据，不能倒推拒绝时根因或归责外部抢焦点。生产Guard不变。

原私有monitor仅计三类driverCode且completed click/PNG变化清拒绝，漏记本次精确CUA_TOOL_REFUSED no-text拒绝；自动monitor未取消，实际由Sol控制取消。Luna最小修独立语义拒绝streak已由Sol与Root独审，实际失败轨迹首次阈值seq123，合规生命周期合成投影/失败切换/generation/partial反例回放通过；冻结私有monitor cf31b455…，已授权新blank原完整卡一次复测。monitor session54416已记录，但自身PID未及时持久化是检查缺口；后续启动即记录PID/starttime/精确CLI归属。当前所有Run终态，无在途paid；累计273main/6risk=279实际请求、256已知usage合计4875867tokens、23未知、金额未知。A05 actual33/0/33、cap120/6/126、正式预占80/4/84 rev1不变。候选40307/6664a3ff…与stock4254均保留，TCC已通过无需再认证；Root自有保活43916。Preview新08dec5e本地闭包38files/5links与五SHA独检通过，正常账号0700新staging三件0600/逐SHA/远端默认inspect通过；Root隔离packaged Relay实际health200/匿名API401/四Web资产逐SHA200并关闭server（fixture，0Provider）。生产155349/current旧release/health200前后未变，已暂存未部署；远端sudo正常认证独立未完成；实体手机与真人项另列。


更新：2026-10-10，Asia/Shanghai。本文件整理 Astra 计划的目标、顺序和完成条件。2026-10-10 用户决定将本项目范围限定为 macOS 电脑端、Web/Relay 与手机客户端，Windows/Linux 平台目标已移出当前范围；原始阶段与诊断过程见 [10 月 6 日计划](./three-track-execution-plan-2026-10-06.md)和[历史验收台账](./three-track-acceptance-ledger-2026-10-06.md)。实际自主执行方式由[自主测试修复计划](./astra-autonomous-test-repair-plan-2026-10-10.md)规定，两份文件分别管理“最终要完成什么”和“现在怎样完成”，不建立竞争队列。

## 1. 目标、协作与当前起点

最终目标：用户从手机提出真实任务，电脑正确执行并交付可核对成果；用户能看到进度、修改要求、审批、暂停恢复和取消。失败要能定位，不能错窗输入、重复副作用或只凭模型自报宣布成功。

三条线是一组共同成果：

| 工作线 | 核心目标 | 完成依据 |
| --- | --- | --- |
| PR 审查整合与交付 | 以 PR22 为产品起点，逐项吸收 PR24 必要修复；形成可复现、可审查的最终组合 | 代码清单、版本/依赖/构建、独立审查、CI、任务证据及交付说明 |
| A 线真实任务 | 查询比较、中文文件保存重开、跨应用整理与手机纠正，以及控制闭环 | 真实 Run、网页来源、实际文件、控制结果、基线/独立复验/变体 |
| CUA 兼容与优化 | 修复候选预览、macOS 能力与弹窗，验证 macOS 原生链路 | 精确目标与真实原生执行证据；纯测试不代替现场 |

用户于 10 月 10 日决定不再沿用旧三个聊天，改由当前聊天统一推进；本次同时明确只负责 macOS 电脑端、Web/Relay 与手机客户端。Windows/Linux 目标、实现、修复、原生实测、环境寻找和交付责任均已移出本项目，既有源码与 CI 保留。旧（6）/（8）/（10）角色和逐次消息交接只作历史，代码修复、现场与 Git 由当前聊天统筹；旧聊天不再是前置条件，也不自动归档或唤醒。可用子代理做隔离实现和独立审查，同一桌面/服务仍只有一个执行者。

当前起点：产品整合树 `Computer-Harness-three-track-integration`；原分支 `codex/three-track-integration-20261006`，上次核对 HEAD `b1e44e1`，存在大量未提交改动。实际开工重新核对，不把 HEAD 当完整源码或进程版本。

已有 T095 手机中文输入/纯文本保存成功，7 次模型请求、93.699 秒；实际正文是模型自行生成的六行诗，原指定正文/路径及关闭重开未验收。其余历史局部成功按[进度审查](./astra-progress-review-2026-10-10.md)承接，不能推定最终组合已完成。

## 2. 批次 0：固定整合版本和运行环境

- 保留 PR22 产品起点和 PR24 修复来源，逐文件核对预算、上下文、结束判定、macOS 输入、精确目标、截图和不重放保护；不整文件覆盖重叠修改。
- 清点当前源码、dirty 内容、诊断文件、构建产物、依赖锁与驱动；区分产品修改和独立实验，不丢弃未提交工作。
- 记录源码→构建→Host/Relay/CUA→客户端页面四类版本、有效配置及可恢复版本。
- 核对现有 Run 和服务占用后接管；旧聊天空闲不代表进程或任务已释放。
- 保留基础精确窗口动作能力；仅在操作确实需要时要求窗口关系或完整库存证据，不恢复全局 complete 硬门槛。

完成条件：最终保留清单、单一源码写入安排、可复现构建和运行说明明确；未验收能力单列。

## 3. 批次 1：双预算、真实 HTTP 与部署合同

- 保留 Context 文本预算与 wire 总预算，后者覆盖视觉和外壳估算；传递至 Host、Runtime、Provider 与轨迹。
- 预算拒绝发生在 HTTP 之前；不能删任务正文、丢近期 GUI 证据或单纯延长超时掩盖错误。
- 区分准备失败、请求发出、响应头/正文超时、重试和模型输出；同 Run/request/decision/attempt 关联实际交换。
- Web/Host/Relay 合同及运行闭包同版，核对 Origin、认证/CSRF、字段正负控、冷启动和回退；不凭入口文件 hash 推断所有运行模块相同。
- 原完整查询任务必须复验，简短输入保存题不能替代大请求验收。

完成条件：预算边界和零 HTTP 拒绝反例通过；同版完整任务有真实网络证据；部署与客户端合同匹配。网络成功与 GUI/成果成功分别判定。

## 4. 批次 2：候选预览、macOS 能力与输入安全

| 范围 | 必须覆盖 |
| --- | --- |
| 候选/预览 | 一条充分的真实失败归因；两个真实同名窗口分别选对/预览，过滤无关对象；目标关闭/刷新、旧 previewToken、迟到、并发、解码失败、取消/撤销、身份复用不误确认或重复创建 Run；失败显示明确原因 |
| Mac | 默认 SDK 与实际 driver 加载；stock 基础精确窗口正例，能力协商和 session 失效；窗口发现、精确激活、焦点/截图；基本动作能力与增强能力分开；有/无独立 CGID 的 sheet 接管、输入、关闭、返回父窗及重新观察；无关新窗不阻断，真实身份变化使旧引用失效 |
| 共同保护 | 错误前台零输入、目标缺失拒绝、关系不足不自动切窗；unknown/partial 保留已发生事实且不重放；取消、审批和桌面归属有效；不能以全桌面截图或放宽身份校验绕过 |

历史 Windows/Linux 兼容性实现与 CI 记录保留，不形成当前平台责任或待验收项。

## 5. 批次 3：T2 中文输入、保存、关闭重开

macOS：TextEdit 新文稿。完整路径为指定中文多行→纯文本→唯一新路径保存→返回正文→关闭文稿→重开文件→核对全部内容。Harness 完成关键业务步骤，辅助工具只准备空白初态和只读核成果。

基线及独立复验正文，UTF-8、LF、末尾恰好一个 LF：

```text
中文出行清单
日期：2026年10月4日
预算：9000元（最多3人）。
1. 携带身份证、充电器与雨伞。
2. 09:30集合，10:15出发。
备注：只保存本地，不发送。
```

变体正文，同样保留末尾 LF：

```text
中文出行清单
日期：2026年10月5日
预算：8800元（最多2人）。
1. 携带身份证、充电器与雨伞。
2. 08:45集合，09:20出发。
备注：只保存本地，不发送。
```

日期数字是固定测试数据。每次全新空白文稿和唯一输出路径，文件已存在即换新任务准备，不能覆盖旧成果。

macOS 至少基线、独立复验、变体三轮。保存框出现、工具 completed、模型 success 都不能代文件存在、字符/编码/行尾正确及重开成功。关闭绑定窗口后须走明确的重新绑定/切窗路径，人工代做关键步骤仅记辅助完成。

## 6. 批次 4：T1 查询、T3 跨应用与控制

T1：真实公开页查询比较，冻结日期、路线或商品范围、预算、必需字段及来源核对方式；保留三项实际比较、价格/关键参数/来源/时间、预算约束以及不符合或未知项。若改用出行查询，冻结对应路线/日期/价格等比较字段，不能退化为只查询一个结果。最终版本补基线/独立复验/变体，不用历史短题代替。无符合项或数字未知如实写明。

T3：携程公开查询→macOS TextEdit 整理，途中通过客户端降低预算，旧要求失效，保留来源/时间，唯一文件保存并重开。只查询、不预订；真实网站不可达记环境阻塞，受控网页可测通用能力但不能代携程验收。macOS 同样完成三轮。

控制矩阵尽量并入这些 Run：一次批准恰好执行一次；拒绝零执行；审批中取消及纠正使旧请求失效；暂停生效后零新派发；恢复使用最新要求；刷新和断线恢复不重复创建 Run/重放动作。命令收到、控制生效和动作发生分别记录。

最终补实体手机操作/显示/网络体验及一位队友按说明独立完成一题。自主替代入口完成的是相应产品链路，实体手机栏保持待验。

## 7. 批次 5：最终审查、PR 与交付

- 审查最终组合 diff，运行相关定向检查、`pnpm run typecheck`、`pnpm test`、Web build；macOS 原生修改须对应实际编译，TS CI 不代原生或 GUI 证据。
- PR22/PR24 历史通过不相加；以一个清楚的产品整合分支承接实际取舍。远端状态与 CI 实时核对。
- PR23 评测器继续隔离：pending/缺 variant/缺可信证据不能判 success；未审计 click 或仍需人工复核时不得输出无条件 success=true。批处理与独立业务证据生产/集成核对；不代真实文件成果。
- 交付启动说明、版本与配置、任务卡、成果/日志索引、限制与回退。推送及草稿 PR 可按新授权自主办理；未覆盖范围写明，未满足完整出口不得宣称本项目范围已完整验收。

完成条件：本项目范围内无未解决 P0/P1，组合检查和 macOS 现场证据齐备，队友试用完成。允许先交付注明平台/入口边界的阶段成果。

## 8. CUA 升级与性能后续

当前 A 线批次结束并释放现场后，再评估固定上游候选与关联补丁；核 SDK、原生 driver、addon/动态库、工具参数、截图、回执、错误和清理一致性。同一 macOS 环境和任务比较冷启动/热路径分段耗时和失败率，无可靠收益或有回归就保留旧版。小样本不宣称稳定 p95 收益，版本升级本身不算任务成果。

## 9. 完成判定

分别报告源码完成、离线通过、部署完成、macOS 本机生产链路通过及实体手机通过。调整后完整 Astra 完成仍需上述范围相关出口全部关闭；Windows/Linux 不属于本项目完成条件，既有源码与 CI 保留。手机暂不可用时先完成全部可自主项目，并给出已证范围和最小手机补验清单。

## 10. 本轮逐项状态入口

2026-10-11 历史阶段快照（最新见顶部；本段旧锁定/TouchID条件是当时状态）：项目仅负责macOS电脑端、Web/Relay与手机客户端，Windows/Linux不属于责任或完成条件。完整T1三产品、T2指定196B保存关闭重开、T3三车次与跨应用纠正及各三轮均未通过，出口不降标。候选两项正常OS权限已实际恢复，新Unicode候选PID40307/socket a05-capturefix-unicode-route、signed SHA6664a3ff…的Accessibility/Screen Recording/AX真实health均pass，独立bundle身份overall degraded如实保留。源码2e6d898第四native补丁f784f6…已按原SHA非force同步PR26，当前head CI38138765523五项全绿，fa19cbb五绿仅列历史。Luna最终native351 passed/2 ignored、fmt/check/build0；Sol四补丁clean d114重放五源码逐字节匹配，生产SDK零Provider99161e2a实证中文LF文稿/中文GoTo路径精确AX读回、root→Save→GoTo自动push及双pop、新代际/旧ref拒绝/错误前台派发前拒绝与modifier释放。完整业务不由诊断通过替代。

正常认证controller同Run暂停零新派发、纠正恢复、精确批准去重/reject/旧approval失效/SSE及同名preview局部实证仍分列API、Web按钮与实体手机。此前PID shortcut无效果及Unicode partial0/169、0/71已派发后的未知副作用保留，不重放。此前入口误发Run run-1791721127906-572090aa-95f cancelled，6模型请求/5GUI动作；独检发现launch误将card.expectedText196B当完整goal，漏掉纯文本/唯一保存路径/关窗重开，不能算完整原卡复验或产品RTF/模型遵循失败。完整goal实际1133B，SHAca78d2cfa9e9152ab1c9e3c349425e941c3b41f92aeec775541414dc9ee41df2；私有持久TTY入口已修为仅card.goal来源并经Root全文独审，实际FD0/1/2为TTY。随后完整goal Run run-1791721677801-6954ca90-3dc仅1请求/1次completed click后转user.input.requested，已精确取消终态；未输入正文。新的独立零Provider空白首click复现completed且candidates为空，未复现未知弹窗；稍后前台为ChatGPT不能倒推原暂停原因，不以Dock行归因。指定输出仍不存在。累计A01–A05为257main/6risk/263实际请求，240份已知usage合计4523213tokens、23请求usage未知、金额未知；A04冻结60/2/62，A05实际17/0/17、cap120/6/126、正式预占80/4/84 revision1保持。PR27/cb6aacf157独检及业务缺项/真人评分缺失保持；Preview仅fa19cbb用户staging逐SHA/inspect通过、未部署，远端正常sudo认证独立未完成。

截至2026-10-10 18:42，当前提交组合17ec145。完整计划仍未验收：本机正常Web配对/Run/截图、真实Provider交换与离线合同已取得，但完整T2/T1/T3及原生窗口矩阵无成果通过；当前console会话锁定已独立证实。全部批次出口对应的已证范围、继续可执行项和具体外部条件见[执行计划看板](./astra-autonomous-test-repair-plan-2026-10-10.md#12-执行看板与续接格式)，实际请求main3/risk0与详细失败见[自主账本](./astra-autonomous-execution-ledger-2026-10-10.md)。实体手机与队友条件分别留栏；Windows/Linux 不属于本项目责任、待办或完成条件。


### 19:12 自主阶段最终状态

本轮5个产品/计数提交及a491076测试修复已独立审查，最终本地组合1866项Vitest+72项TAP；a491076跨平台五项CI全绿。正常公网Relay双HTTP会话配对/CSRF/隔离撤销与独立headless Web UI批准/刷新去重/失效码/390px布局通过，均零新增Run/Provider。PR23当前136项及真实失败报告导入完成；草稿PR26已附当前聊天，历史dirty与私有runs未混入。

完整Mac T2/T1/T3和真实原生控制/双窗/sheet仍需当前控制台正常解锁；公网Preview固定闭包7/34项不同且现有账号无合法写入/发布权；M1–M4需实体手机，队友试用需另一位参与者，评分校准需真实成功与真人复核。上述均分栏，不将配对或L1合同当业务任务通过。详见[最终执行看板](./astra-autonomous-test-repair-plan-2026-10-10.md#12-执行看板与续接格式)及[交付包](./astra-stage-delivery-and-phone-pack-2026-10-10.md)。


2026-10-11 历史SSE稳定点：SSE b08268c修复后同版正常Host五次断开恢复/并发cap/after-seq尾事件通过；批准重复commandId只一次执行、reject零执行、correct使旧approval409/零执行、随后cancel均独检。A01–A03累计180main/4risk/184请求，169已知usage2982210tokens、15未知。正常Host15648保留，所有Run终态；继续零Provider建议DOM定位，完整T1/T2/T3及剩余现场矩阵未升级。


## 2026-10-13 T3 主集成验证更新

Host-owned `native-web-document` 实现及其普通 Web/Relay 入口、Browser 与 TextEdit 独立能力边界、一次性文稿恢复已由 Luna 实现、Sol 独立审查并导入主分支，共25个路径。Root逐文件核SHA与审查清单一致，保留9720350的CI等待修正；主目录类型检查、119文件2089项Vitest、72项Node自检及Web构建全部通过。私有证据为 `T3-integration-20261013-private/root-final-integration-verification.json`。这是离线实现与组合夹具通过，真实三线业务任务仍待现场验证。9720350的五项CI已通过；此次T3新提交需单独等待CI，不继承旧结果。本轮真实Provider调用仍为0。

屏幕录制权限已完成off→on刷新，并按系统提示退出重开目标App。辅助功能刷新再次出现macOS本人认证，已请用户完成；执行者停在该实际认证面板，尚无刷新后的health或业务Run通过证据。

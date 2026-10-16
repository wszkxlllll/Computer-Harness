# 三类九题：真实生活任务评测操作说明

独立候选套件（2026-10-16）：[购物售后与通信日程六题](../eval/life-business-shopping-communication-20261016/README.md)已完成公开来源可读性核验，尚未接入此 runner，不属于原九题或八题历史运行范围。

更新：2026-10-16。状态：授权的八题已依次真实执行完毕、跳过G03，使用整个桌面前台路径；成功、失败、中止及复跑分别保留，详见[逐题结果](life-business-eight-task-results-2026-10-16.md)。没有足够证据判定完整业务通过，先处理已复现基础问题再开展模块对照。完整指令见[任务卡](life-business-task-cards-2026-10-15.md)，程序题面唯一来源是[tasks.json](../eval/life-business-20261015/tasks.json)。旧准备树及其历史记录保留，不继续使用旧包。

当前准备分支为`codex/life-eval-ready-20261015`，基底main `6b1d6e20136b38c9a53c7033ba5e372f00add335`（PR32已合入，main CI也已通过）。只搬入本批任务/脚本，另补CLI输入策略接线；没有带入原PR30未合入的DOM、网页来源绑定或Context/Monitor后续改动。未发布到远端、未部署Preview，不把原准备树的CLI构建直接当成新版本。

## 1. 本轮要验证什么

原 suite 仍是九题。本轮历史运行实际执行八题，明确排除G03：其中七题浏览器查询后直接答复，T03用WPS交付一个DOCX并把同一文件发送至指定微信会话。2026-10-16新增的六题是独立候选，不进入本轮或历史八题范围。此前T02/M02的微信草稿环节撤销，改为高德公共交通路线比较和就医准备咨询。单浏览器题是基础能力/短任务成本对照，不包装成桌面独有能力；T03的跨应用交付单独记录，不用九题总分宣称每题跨应用成功。

原九题的难度来自条件分支、多来源一致性和约束保持，不来自刻意切换、反复保存或三份格式。原九题仅两道真正需要打印阅读的题要求18磅文档。不要求每题测试记事本、PDF、文件管理器。业务必须经真实GUI执行，不能代码生成文档或直接调用网站业务API代替。离线单测不构成业务成功证据。

### 模型需求与评测要求分开

模型只收到manifest的goal（占位符替换后的goal.txt）及正常Harness上下文/工具。Goal包含真实用户背景、需要的具体信息、日期地点偏好、自然的成果要求和必要安全边界；不包含评分分数、证据采集、每项URL/查阅日期、至少访问几篇文件、固定三节排版、停留指定页面或保存对话框操作教学。保留“附来源，方便核实”这种正常需求，不要求用户逐条撰写研究报告。

checks/sourceIds/allowedHosts/requiredApps用于操作者预检、操作范围审核和评分，不作为额外题面注入模型。allowedHosts只是冻结的范围及人工审核依据，不是新增的网络沙箱或自动拦截器。必需业务字段必须同时在Goal里说清楚，不能在评分时暗加题。来源准确性由评分员结合实际GUI轨迹和原文核验，不因模型没按未要求的格式逐项写URL或查阅时间而扣分。明示的用户条件和事实准确性标准不降低。

## 2. 来源与预检

**2026-10-15静态核验及修题：** [仅供评分员的逐项答案与依据](life-business-static-answer-key-2026-10-15.md)包含G01/G02/G03/M01/M02及M03院址的静态事实、条号/段落和版本。T02、T03、M03的高德路线以及票务结果都是动态信息，不在静态答案中冻结。无法明确的问题已经从任务与评分要求移除，不以“再问银行/医院”替代必答答案。答案表不由runner读取或注入Goal。

下列页面本日已经公开网页初查，不占桌面、不调用模型；可读不等于本机GUI通过。评分用原条款不注入模型。

| 来源 | 题目 | 核验页面与待检查项 |
| --- | --- | --- |
| S-G1 | G01/G03 | [现行敬老卡办法](https://mzj.sh.gov.cn/MZ_zhuzhan2739_0-2-8-15-55/20260812/485d5bd3f3564ddf85022f6e7543e81b.html)：对象、本人/代办、金融激活；核有效期 |
| S-G2 | G02 | [居住证实施细则](https://www.shanghai.gov.cn/nw12344/20251201/ed714f24b362482a998de9a1652440f2.html?siteId=1)：签注/地址变更/逾期；不混首次申领 |
| S-G3 | G03 | [津贴高频问题](https://www.shanghai.gov.cn/nw17239/20261008/00f35085cab94f0a855d2f7489d6bb81.html)：与卡办法区分日期和适用范围 |
| S-G4 | G03 | [津贴发放管理办法](https://www.shanghai.gov.cn/gwk/search/content/cc638ba0342f4bd8b517ccabd1f133b1)：第三部分本人信息确认及渠道选择程序，至2029-04-30有效 |
| S-G5 | G03 | [完善津贴制度通知](https://www.shanghai.gov.cn/nw12344/20240207/007114e744bc43e7a4cfecd422837f2a.html?siteId=1)：免申请、双渠道及对象条件，至2029-04-30有效 |
| S-T1 | T01/T03 | [携程](https://trains.ctrip.com/)：已见查询入口，指定日期车次/价格/余票待GUI确认 |
| S-T4 | T02/T03/M03 | [高德](https://map.gaode.com/)：公开路线入口；动态路线、站点和时间未冻结，需在实际页面核对 |
| S-M1 | M01/M03 | [华山来院交通](https://www.huashan.org.cn/mzdh/lyjt.htm)：具体院址/轨交/电话可读，不保证实时交通或所有院区一致 |
| S-M2 | M02 | [华山预约说明](https://www.huashan.org.cn/mzdh/yygh.htm)：渠道/现场准备/取消可读；未标更新日期不编造，不要求当日医生号源 |

逐题只检必需信息与操作通路，不提前填写答案。无票、不可达、规则冲突如实登记，不暗改日期或换题后回填成功。政策/医疗说明不是资格审核或诊疗判断。

按用户要求处理核验缺口：G01代办限定社区办卡；G03只问本人办卡、确认津贴渠道与本人激活，删去家属代办和区级材料问题，不再依赖一网通办区级指南；M02明确长辈能接电话收短信，仅查询电话预约、到院材料和原渠道取消，不问无短信替代核验。业务必需信息仍明确保留。医院页面未显示更新日期，标准答案限核验日官网所述公开信息，不保证电话接通或现场执行。T02由用户在运行前基于12306登录状态无法保留而改为高德公共交通路线比较；这是环境选择，不是此前执行失败后放宽题目。T02只冻结公开地图入口，不把动态路线当已核验真值，也不要求地图账户登录。manifest已更新，旧计划需重新prepare。

## 3. 用户准备

### 本机本轮已确认的默认值（2026-10-15）

用户指定的输出目录、微信目标、已有profile和候选CUA socket保存在被Git忽略的 `.tools/life-eval.local.json`，不把个人绝对路径固化成项目默认。`start.mjs`读取这份无凭据配置并只离线准备：按北京时间的实际准备日记录as-of-date，默认出行日期为次日，允许显式覆盖；实际GUI预检确认日期后冻结。跨天尚未执行的包重新准备，不在运行中改日期。不创建空白的新profile来假装复用登录。

此前的一次只读检查记录了`travel`目录、浏览器Preferences、当时profile无Harness锁，以及启动元数据中的携程、高德和12306入口；这项历史检查不能证明网站目前仍登录，也不能证明持久启动清单已变更。随后用户在本轮准备时手动关闭12306标签、仅保留携程，并正常结束准备流程保留profile。未读取Cookie、密码或聊天历史。候选CUA二进制存在且SHA与原部署记录一致；该文件哈希不验证当前socket对应的运行中daemon。T02使用公开高德路线页，不要求登录；携程登录状态由正式人工预检确认。

G03/T03的Goal将保存文件夹与纯文件名分开，不把完整路径称作文件名。只给清楚的保存结果，不教学控件、快捷键或固定操作顺序；由Agent自主执行，评分员核实际文件。两题使用新建空白文档，不要求带答案或固定章节的模板。

CUA采用自有fork的0.22.2输入候选，源码commit `7852ab1983b60c0ce581b8736c9da13eaf04640a`。本轮为CLI补`--multiline-type-profile off|foreground-caret-v1`，评测明确选后者，经已有Computer配置传入适配器与type工具说明；未指定仍关闭，不改变Host原配置或输入算法。不能只给CLI设置Host专用环境变量就宣称策略开启。

本机驱动路径和期望SHA放在被忽略配置中；离线计划核文件并冻结指纹，live前再次核验。**文件哈希只证明磁盘候选，不能证明某socket就是该驱动**；实际daemon及socket对应关系必须人工预检并留回执。脚本不自动启动、停止或替换驱动，不凭离线检查填写通过。当前没有启动任何新的服务或浏览器。

1. 同一Harness受管profile按需登录携程。T02使用高德公开公交/地铁路线页面，不要求登录；政务和医院的公开说明也不要求个人账户，不打开订单或患者信息。
2. 只有T03需要已登录微信：从本机配置注入精确目标“文件传输助手”，把T03保存的那一个DOCX发给该会话。运行前由人工确认目标及发送授权；runner不选择联系人、不读聊天历史、不自动批准。其他八题不要求微信或发送消息。
3. 只在G03/T03打开WPS新建空白文档；不用模板或记事本。提供输出根目录，每次独立子目录，原有私人文件和旧答案隔离。
4. 冻结一个可查询的未来出行日期，T01/T03一致；示例2026-10-20不是已验证有票。
5. 每个live Run仍需明确授权、实际预检和终端确认；T03的文件发送仅在该题的授权范围内。此前空白WPS文档保留不覆盖，T03另存到本次attempt目录；不因微信已登录而自动运行或批准。

## 4. 固定配置与对照

固定main基底、准备分支源码/CLI构建指纹、驱动文件指纹及输入策略；不把旧Preview当作本分支已部署。准备分支含未提交修改时如实记录dirty状态，SHA不能单独代表完整代码；以源码/构建指纹共同核对。改变代码/config开新批次。

| variant | Planning | Memory |
| --- | --- | --- |
| B00 | off | off |
| P10 | on | off |
| M01 | off | facts/lexical |
| PM11 | on | facts/lexical |

先B00/PM11探索联合效应，再需要时补单开组；联合收益不能归因某单模块。组M01与题M01分别用variant/taskId记录。同一题其他项固定：DeepSeek Flash、thinking disabled、90秒单请求/4096输出、recent Context、managed-browser companion、same-control-input-v1 Batch、Guard layered/riskModel same、Monitor shadow。不自动批准或为成功率放宽Guard。

本轮八题使用同一桌面优先拓扑：CLI显式请求 `grounding off` 并开启 `--window-switch`，配合任务的受管浏览器URL；CLI派生managed-browser companion，RunFactory将其有效grounding提升为hybrid以启动浏览器Host。没有固定 `--cua-window-pid/--cua-window-id`，初始Surface是完整主桌面；在desktop Surface上执行 `switch_window` 只把指定窗口置前，下一观察仍是完整桌面截图，不切换成window-scoped capture。实际链路依据既有RunFactory与CUA Computer合约验证。七道浏览器查询题的业务需求仍限公开网页；窗口激活能力存在，不代表业务Goal要求跨应用。T03按题目需要另用WPS及微信。此前T01采用window-initial模式的历史结果不作为本轮desktop-first配置或业务的验证证据。

2026-10-16准备验收：Luna实施并运行评测脚本离线测试20/20、既有CLI/RunFactory/Computer/CUA桌面启动和激活匹配用例16/16，语法与UTF-8检查通过。Sol只读复核上述真实消费者链路、切换后desktop不变、T03精确微信目标及发送授权门槛、任务卡与九段Goal逐字一致，结论GO。此次模式调整只改评测脚本与说明，未新改产品源码、执行API或操作GUI；尚不能声称新模式的八题已实测通过。等待用户明确说“开始”后逐题执行，不自动运行G03或扩大到对照重复实验。

easy/medium/hard主请求100/120/180、动作80/100/150、总时限15/20/30分钟；风险请求另计20/24/36。本轮先按用户指令逐题运行八题；后续若获准做两组各三次重复，则为8×2×3=48 Run，不把建议视作整批授权。AB/BA交替，动态题相邻时段并按当时证据评分。复用登录不复用Plan、Memory、草稿和旧成果。预算/题面冻结后不因失败原地加额或改目标。

## 5. 评分、指标和证据

100分：事实40、来源20、真实成果20、约束10、表达可用10；具体以manifest检查项为准。浏览器核最终答复是否满足用户要求和当时网页事实；不要求最后一个页面或规定答复格式。文档核实际新文件、内容和用户要求的字号，不要求原三节模板或多份格式。跨应用次数、文件数、Plan/Memory调用次数不直接加分。

full_success要求必需事实、来源、成果、安全全部通过；partial保留缺项；failed无核心有效成果；environment_blocked需独立环境证据；constraint_blocked指确无符合结果且保持约束，不混为行程完成；assisted单列人工纠正/操作及辅助后结果。模型finish/exit0不是评分。正常审批与用户替做区分记录。

评分员独立核现行原文、实际访问URL及模型提供的来源；200不证明内容正确。来源名称或可用链接能让用户复查即可，不暗加“每条事实必须完整URL/日期”。模型若提供错链仍记录事实性错误。票价/地图用当次截图/录像与临近独立查询核验，后来的结果不能补模型遗漏。“待核实”不能掩盖页面明确的必需信息。保存全部失败、重跑关系、最终答复/文件及人工干预。

观察成功/部分/辅助；请求、tokens、缓存、总/API/人工等待；重复无效动作、错窗、重复路径输入；Plan有效阶段；Memory写入/召回/被采用及过期错误；Batch提议/准入/中断；手机审批/纠正/播报。无统计记unknown，不凭调用量证明效果。报告引用最早失败事件并区分环境、定位输入、窗口保存、来源转写、规划记忆、协议网络。

trajectory和截图私有保留。provider-exchanges是脱敏摘要，不是完整HTTP正文；被拒响应不能凭摘要恢复。未经单独审查不关脱敏、不记录密钥或隐藏推理。

## 6. 脚本与运行门槛

### 本机简化准备入口

先在被Git忽略的 `.tools/life-eval.local.json` 配置本机输出、已有profile、CUA socket及候选文件指纹；仅保留路径/配置，不放API key。`wechatChat`只供T03精确替换Goal里的目标占位符；该值进入待人工审核的计划与回执，但不会自动授权发送。API环境文件路径只用于打印获授权的live命令，不在离线准备读取正文。然后执行一行：

```powershell
node scripts/life-eval/start.mjs --task-id G01 --variant B00
```

这只是离线生成当次计划，打印含实际包路径的dry-run/监督运行命令；不会执行它们，不会把预检自动填写为通过。日期取北京时间准备当天，出行默认次日；指定其他合法日期可加 `--travel-date YYYY-MM-DD`。题号可换其余八题，组名可换P10/M01/PM11。API环境文件只在获授权live命令使用Node原生`--env-file`读取，离线入口不读.env。真实运行前必须人工预检所需应用、登录、精确微信会话、是否授权单文件发送和实际daemon身份；回执通过后才可运行，不能仅复制打印命令绕过预检。

prepare只离线生成单题/组计划包并冻结Goal/config/版本及空评分表；run默认dry-run。脚本不启动daemon、不部署、不读取profile登录内容、不自动循环/批准Guard。必要应用按题检查，T03需浏览器、WPS和微信，G03需浏览器和WPS，其余题只需浏览器；九题均无活动输入模板。T03文档在`deliverableReviews`单独核对，微信投递在`consumerReview.wechatDelivery`标为待人工确认，不自动评分或读取聊天记录。

从当前checkout用Node22.13+（本机验收24.19），每条一行：

```powershell
node scripts/life-eval/prepare.mjs --output-dir "E:\LifeEval-Output" --profile-label "LifeEval-20261015" --as-of-date 2026-10-15 --travel-date 2026-10-20 --task-id G01 --variant B00
node scripts/life-eval/run.mjs --package "<prepare打印的packageDir>"
```

以上不读.env、不启动GUI/模型。使用`start.mjs`准备T03时，目标从本机配置注入；直接调用`prepare.mjs`时T03需提供精确`--wechat-chat`，其他题不要传。题面/日期不能原地改旧包，重跑新建包；此前生成的旧题面包会因manifest指纹改变被拒绝，不修改其内容伪装新题。单次未知副作用不重放，先重观察/人工确认。

仅晚上明确授权且人工预检接受后：

```powershell
node --env-file="<私有.env绝对路径>" scripts/life-eval/run.mjs --package "<packageDir>" --cua-socket "<现有daemon socket>" --live --confirm-desktop-control --supervised
```

Node env-file只用于明确live，key不进计划。既有可信代理如需要，使用支持的Node `NODE_USE_ENV_PROXY=1`供子进程继承，不改系统代理/TLS。脚本不自动录屏；录屏另授权并关联Run时点。

先前自然Goal版本的15/15离线结果仅代表当时版本，不含T03微信投递。当前T03将新DOCX与指定微信文件投递分开留在`deliverableReviews`和`consumerReview.wechatDelivery`，由人工分别核验；其他八题没有微信目标。此前的测试与Run历史不改写，也不作为新T03投递通过证据。本次只更新任务/runner评测契约，不改业务Runtime或Guard，未调用API、未读.env、未操作桌面、未部署。

准备阶段的历史门槛已经进入监督执行；当前八题单轮已获授权，并非GUI或业务已验收通过。WPS保存/微信投递是否完成按真实结果判断，正式Planning/Memory对照和扩大重复实验仍待本轮结果及后续授权。不能用离线测试或Runtime succeeded声称九题已跑通。

### 当前主线准备验收（2026-10-15）

上述15/16项结果是题面收敛时的历史记录。当前候选基于main `6b1d6e2`，补齐CLI `--multiline-type-profile off|foreground-caret-v1`及评测入口的显式配置；默认关闭，不修改Host默认策略或其他平台输入实现。实施方已运行typecheck、Web build、全Vitest（132文件/2409通过）。最终审查发现live记录构造缺少review参数的阻塞，已窄修传参并补实际record builder的离线测试；life-eval最终18/18、typecheck通过，Sol只读复核GO。全Vitest2409为该脚本窄修前结果，不冒充修复后重新全跑。

本批计划冻结候选driver文件哈希、来源、版本与API环境文件路径。离线准备和dry-run不读取环境文件正文；真正live仍须人工填写daemon身份、socket和应用预检，磁盘文件哈希不能代替运行中daemon的身份证据。

用户另授权的最小真实DeepSeek联通测试已完成：`deepseek-flash`、thinking关闭、1请求、HTTP200、总耗时1071ms，输入1265/output67 tokens，原生terminate响应解析成功。这只证明文本API及适配器连通，不证明截图、混合工具或九道业务任务已通过。随后用户授权打开已有travel登录profile供手动检查；该准备操作不属于正式业务评测，不调用模型。

同日后续修题验收：移除未明确静态问题后，根独立回归16/16通过，新增社区/本人激活及可收短信场景边界测试；任务卡、Goal、checks与静态答案同步，Sol只读复核GO。无Runtime改动、API、桌面操作或部署。仅题面/评分范围收敛，旧包必须重建，不迁改原记录。

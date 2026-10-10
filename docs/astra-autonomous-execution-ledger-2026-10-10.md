# Astra 自主执行账本：Sol 协调 / Luna 执行 / Sol 检查

开始：2026-10-10 17:34，Asia/Shanghai。执行入口：[自主测试修复计划](./astra-autonomous-test-repair-plan-2026-10-10.md)。本账本追加实际事实，不将准备、历史测试或离线通过计作真实任务通过。

## 执行归属与保护

- 当前聊天统一接管；旧三聊天不派工、不等待 ACK。Sol 协调版本、账本、Git；Luna 唯一写产品源码、操作桌面、调用真实模型及切换服务；Sol 检查独立只读复核。
- 保留现有 dirty 文件及历史产物；不 reset/clean。未知副作用先只读核对，不重放。辅助 CUA 仅准备初态、操作正常 Web 和只读核成果；业务输入、保存、切窗、重开由 Harness 执行。
- 原历史恢复周期 main18/risk0 保留；T059 更早历史用量未知仍未知。本轮计数从实际新请求另记，旧期限及 marker 不作新运行权限。

## 自主批次 A01

| 字段 | 值 |
| --- | --- |
| 命名空间 | `astra-autonomous-20261010-sol-luna-A01` |
| 本地原始证据 | `runs/astra-autonomous-20261010-sol-luna/`（忽略，不提交截图、会话令牌及原始私密轨迹） |
| 模型请求上限 | main120 / risk12 / total132；含失败、重试、重定向；先预占再派发 |
| 当前新增实际调用 | main120 / risk0 / total120；A01达到原上限并冻结，所有A01实际Run终态，无在途paid |
| 当前可见返回usage | 109个已知usage响应合计prompt1712409 / completion33799 / total1746208 tokens；其余失败/取消请求无usage，金额未知，不冒称完整账单 |
| 当前预占 | 首Run40/2/42；正式revision3增量预占main120/risk4/total124，原actual/sequence/派发链保持；累计消耗120（失败/取消不退号） |
| 接管源码 HEAD | `b1e44e150579bbf5f0d2b6183a49f83aefe08bd0` |
| 当前提交组合 | 产品`1cec2ea3`（DOM名称对称规范化及9a449e20 Runtime hotset修复，含117c9cc受管浏览器AX/工具合同与2c361c3结构化inventory）、计数`d0313d9`（high有界配置及CDP只读分流），原生补丁`0ccc9ee`，共享测试`5247fb8`；各真实Run按实际加载版本分别记，保留旧失败 |
| S2冻结源码 HEAD | `2e64d90`（产品/测试 `e0ca96f`，自主计数入口 `2e64d90`；内容未随提交改变） |
| 分支 | `codex/three-track-integration-20261006` |
| 基线快照 | 2026-10-10 17:34:22，tracked changes24，untracked status entries245（目录折叠，不等于逐文件数） |
| 源码清单 | 451项；`baseline/source-manifest.json` SHA-256 `154d73a5ceb538f0b08835b1c3a1b7f9a6abd48e4d89afc1460f1a90974866cc` |
| 可恢复材料 | `baseline/git-status.txt`、`baseline/tracked-diff.patch`、源码 hash 清单；未跟踪文件保持原位 |
| 当前构建/进程/客户端 | 原Host89224已退出，4317当前无监听；原stock socket已无owner，恢复Luna正常重启原签名stock0.22.2 daemon4254，status/list-tools可达。历史Host17ec145闭包SHA `f17dd74bad35aea6286f16e083f277f6a5e5a1978a8420104e0f228b9c991c0d`/Web index-BxSWOU01.js不作当前运行版。最近CLI使用1cec2ea3已typecheck dist（含117c9cc受管浏览器flag/工具合同），Run已终态；Runtime/CUA/Context实际新标记已核；不能将磁盘构建更新冒称保留Host已热切版 |
| S1构建闭包 | 476个apps/packages dist文件，含Web4资产；`baseline/runtime-build-manifest.json` SHA-256 `310b5de388dc1f81a930a45b2029ae9f25b671787db16bc8ea4aba4671a41855` |

## 当前后续批次 A02

独立cap main60/risk6/total66；正式revision1预占60/4/64，实际main26/risk0/total26、sequence26。A01原120/0冻结，合计新增实际146/0；已知135个usage响应合计prompt2277075/completion40975/total2318050tokens，11请求usage未知、金额未知。当前全部Run终态、无在途paid。完整T1仍未完成，正在隔离修复PR23合法审批证据兼容，随后真实controller与T3继续。当前远端/PR26 HEAD `010388c`五项CI全绿（run38077084697）。

## 本轮事件

| 时间 | 版本 / 阶段 / 入口 | 事实与结果 | 调用 / 介入 / 下一步 |
| --- | --- | --- | --- |
| 17:34 | b1e44e1+dirty / S0 / L1 | 保存实际源码清单及 tracked diff；24 tracked、245 untracked status条目；无文件清理 | 新请求0；Luna只读核进程、端口、在途Run并检查S1测试入口 |
| 17:38 | b1e44e1+dirty / S0/S1 / L1 | Luna初核无本仓库Host/Relay/Web监听及可见在途Run；无关Node/Python/Codex CUA保留。Sol检查当前dirty关窗交接及正常配对合同，见[独立检查](./astra-sol-independent-review-2026-10-10.md) | 新请求0；正式基线开始；GitHub CLI未登录exit4，远端状态未取得 |
| 17:42 | b1e44e1+dirty / S1 / L1 | typecheck首跑通过；test唯一9例managed-browser-companion夹具失败，Luna修标准离线SDK fixture。Sol独立PR23 14/14合成通过，可信业务接口仍缺；已生成完整T2三卡，均196B、目标absent | 新请求0；T2 baseline/repeat SHA `58a4fcd47da3982ab890ad46febf0eecd7c3c8d52b19723d65092d43cac43beb`，variant SHA `ebe8f2f9eb4ff9b68b3a33d37e562e0388fbc1ed5dd7b0806598b37baacc242c`；下一步定向/组合复测后正常Web |
| S1收口 | b1e44e1+dirty / S1 / L1 | Luna定向13/13、组合114文件1841项Vitest+71项TAP、typecheck及Web build通过；Sol实际核两行测试fixture diff与日志，diffcheck0。T1三张完整比较卡prepared，无网页/模型执行 | 新请求0；首真实Run预占main40/risk2/total42，待physical guard实际安装后派发；正常Host/双浏览器配对准备继续 |
| S2计数签收 | b1e44e1+dirty / S2 / L1 | Luna最小单入口guard修订后8/8；Sol全文核三脚本并独立8/8、两语法检查exit0；第一Run可立即开始正常配对准备 | 新实际请求0；40/2/42预占待初始化；`counter.actual`是delegate前持久耗号，须对账Provider exchange后报告真实到网 |
| S2现场准备 | 2e64d90 / S2 / L2准备 | A01私有计数root0700/state0600已初始化，实际耗号0；找到原主checkout已证stock 0.22.2 SHA `82280013239871397bf57baf133271413640b3bba8a51661a841e5f2bc50219c`，fresh私有socket0600监听。首过长socket在launch前SUN_LEN拒绝，无该次进程残留 | 新请求0；正常Host/双浏览器配对继续；不使用PATH/app中的0.20.0冒匹配 |
| S2正常配对 | Host/runtime2e64d90，Web47228cd / S2 / L3部分 | 正常Host4317、本机Origin；正常管理页生成挑战。发现QR无备用链接，最小增加同challengeURL的noreferrer链接，Luna组件4/4+Web build通过、Sol核diff并提交47228cd。正常客户端pair请求→管理按钮批准→authorized/no pending | 实际请求0；本机合法device认证成立，不计实体手机；第二Chrome tab是否隔离尚待明确，不冒双浏览器隔离通过 |
| S3首Start拒绝 | 同上 / S3 / L3失败前置 | 首Start显示“受管浏览器的本机登录状态尚未准备好”，无run.created/HTTP。源码表明原生target启用switchWindows会附带managed-browser companion并检查saved profile；正常profile准备等待本机确认时辅助CUA两次timeout | 实际请求0；不计业务失败或手机依赖；优先关闭跨应用开关原生TextEdit完整goal取证，Web仍不可操作则转正常L2入口，同counter不归零 |
| PR23当前独检 | 独立PR23 `1f57852` / S5 / L1 | Git HTTP/1.1只读fetch成功；复用干净隔离树detach至实时head，保留原5ddd分支。Sol实际136/136当前v2测试exit0，tree clean；产品树未合并PR23 | 模型请求0；后续用真实成果核v2独立证据/CLI导入，不能将AI检查冒称已完成真人审核 |
| 18:02首Run终态 | Host/runtime2e64d90，Web47228cd / S3 / L3失败 | `run-1791626283697-82c22354-0ac`：正常TextEdit未命名2绑定、stock open/initial screenshot完成；9事件止于provider失败，无正文输入/保存动作。GLM `awaiting_headers` 90006ms/90000ms，未收到HTTP status，非已证实的桌面锁屏 | main1/risk0；143863B wire、1图、prepared13066tokens、8192输出、enabled/server_default。检查正常配置是否漏传历史180s/low再复测；目标文件仍absent |
| 首Run goal与观察边界 | 同上 / 独检 | run.created goal等于card.goal.trim()，仅外层末尾LF由既有Web规范化移除；196B正文与最终LF要求没有删减。辅助CUA提示locked，而root只读IOConsoleLocked=false；stock截图确为空白TextEdit，不能据辅助工具提示判实体锁屏 | 正文196B/hash标准保持；无HTTP响应不能写Provider成功，无GUI action不能写T2通过 |
| 首Run配置对照安排 | 同上 / S3 | Luna只读启动摘要证明90s/default、enabled/server_default；主env无timeout/thinking，本轮私有host.env空。历史T022正式180s/environment+enabled；low只见独立实验，没有180s+low同profile证据 | 仅正常Host显式180000ms单变量有界对照；不改产品默认或同时加low，不据默认值判entry丢配置缺陷 |
| Linux现有线索 | S5只读 | 发现已有ubuntu-vm SSH alias；BatchMode/ConnectTimeout5正常连接一次，22端口超时，未进入或修改课程系统。VMware常规目录/运行VM为空不能证明所有Linux环境都不存在 | 当前既有alias不可达；GUI与编译环境分开，Mac主线继续 |
| 18:10 L2正常CLI修复 | `907c0a9` / S3 / L1→L2准备 | 正常Host180s/environment摘要成立，但辅助native AX仍误报locked，第二Run未发。发现CLI不转发既有timeout env：最小补GLM限定映射/原validator，固定同guard入口host或cli；无新业务参数/launcher/正文写入端 | Luna CLI11/11、入口拒绝1/1、CLI build通过；Sol实际快审并独立11/11+1/1 exit0。保留counter main1，立即正常CLI同完整goal180s对照 |
| PR23真实失败证据消费 | 隔离 `1f57852` / S5 / L1真实轨迹离线处理 | 用明确T2本机manifest消费首实际90s失败轨迹，初/末锚点同一真实首截图，SHA `a909edc059c7a47d9c39d399cbb80a24b2f24912a6864a5b0e78980569bff237`，无真人复核文件 | `inconclusive`/success=false，五维null，human_review_missing；产物`pr23-real-evidence/first-provider-timeout-assessment.json`。不计D01、评分校准或T2成功，CLI报告导入待后续 |
| 18:13正常CLI Run | `907c0a9` / S3 / L2在途 | `run-1791627197280-8d482a65-af8`，stock精确PID22394/window14410初观察完成；goal1133B与原card逐字节一致。第一CLI进程因env路径不存在在Node入口前status9拒绝、零Run/HTTP，修正既有主checkout env即继续，没有新runner | main2/risk0；180s/enabled。正常CLI默认raw/无planning-memory，prepared4454tokens，与Host13066不同，不能单归因timeout；interactive保持live/layered Guard，未关Guard |
| CLI真实GUI拒绝终态 | 同Run / S3 / L2失败 | 两次exchange均HTTP200/body成功：134519ms、103159ms。仅一次click，stock明确off_space_or_ax_unresolved/refused，无输入；模型收到反馈后如实terminate failed。独立磁盘目标absent | main3/risk0；该CLI默认background仅4tools，键盘禁用；这是实际配置缺口，不能以“模型不会保存”归因，也不将request成功计任务成功 |
| 下一完整Run配置与现场 | `907c0a9` / S3准备 | 正常LaunchServices激活空白TextEdit；stock确认同PID22394/window14410、Space1/on-screen，verify_state stable=true。permissions accessibility/screen_recording=true，health0.22.2 ok；doctor session unknown不冒签动作成功 | 同CLI公开--window-switch启foreground/键盘/list/switch，不加browser URL，low/180s有界尝试；Web原生createRun本来显式foreground，缺键盘不误归Web默认；不改driver背景拒绝保护 |

| 18:22 foreground零派发 | `907c0a9` / S3 / L2失败前置 | 三Run `run-1791627585306-73958513-dda`、`run-1791627644864-77541a50-101`、`run-1791627717938-69731c32-9a2` 均止于精确激活验证：目标14410，stock观察前台14409；各5事件，零模型/捕获/输入 | main3/risk0不变；不再盲重跑。公开foreground/low配置尚未进入Provider，不能宣称low性能改善 |
| 18:25 精确前台根因投影 | 同版 / S3 / 只读 | helper14409为已有Codex Computer Use服务45928的126×126/layer0/z8窗，覆盖TextEdit底部49px；正常hide返回0但CG仍on-screen。TextEdit AX目标不在列表、focused=nil，helper AX不可读，故未盲最小化/杀服务 | 零新请求/业务输入；保护保持。System Events曾报TextEdit而NSWorkspace报loginwindow，不能单凭AppKit PID放行 |
| 18:30 会话级锁屏确认 | 同版 / S3外部条件 | Sol解析同一ioreg字典获CGSSessionScreenIsLocked=true且kCGSSessionOnConsoleKey=true；Luna独立IOService/IOConsole投影同为true/true，脱敏0600摘要`A01-private/console-session-lock-check.json`。全局IOConsoleLocked=false不足以证明用户会话解锁 | 停GUI/激活/最小化/paid重试，无在途；当前Mac现场需正常解锁。只证明当前条件，不追认此前全部失败均由锁屏导致；S4/S5/交付继续 |
| 907组合独检 | `907c0a9` / S1/S6 / L1 | Sol实际运行组合114/114文件1847/1847 Vitest、72/72 TAP，exit0；日志`s1/sol-907c0a9-combination-test.log`。dist476文件实际快照SHA `19f0027365635e543746faaa744b75fade3697ae0c6e9559a417186415a5f2cd`，不冒称每个进程已换该build | 无paid/GUI；源码后续变化再对应回归 |
| S4控制/预览合同 | `907c0a9` / S4 / L1 | Luna17文件302项通过，覆盖controller暂停/纠正/审批/取消/不重放、Remote token/idempotency、Host auth/CSRF、Relay fixture HTTP/WSS、Web feed/preview；摘要`A01-private/controller-preview-contract-tests.json` | 零paid/GUI；fixture网络只计L1。正常锁屏下Chrome DOM隔离配对/真Host控制待试，不冒真实S4通过 |
| PR23第二条真实失败 | 隔离`1f57852` / S5 / L1离线消费真实轨迹 | v2消费CLI背景输入拒绝轨迹，`pr23-real-evidence/cli-background-refusal-assessment.json`，inconclusive/success=false、无真人审核，不合成成功 | main3保持；真实CLI report导入仍可执行 |
| 18:42 PR24最小修复签收 | `17ec145` / S4/S6 / L1 | EventTimeline不再按retryable虚假承诺重试；select_option仅绑定可信request/decision/evidence/DOM唯一enabled选项才显短文字，其余redact。Sol实际40/40定向通过；Luna最终typecheck/Web build与114文件1866 Vitest+72 TAP通过 | main3不变；8文件显式提交，历史dirty未混入。160界限为原PR24 UTF16码元，Unicode计数另列；含中文边界/错绑定/敏感反例 |
| 当前正常服务冷启动 | `17ec145`同内容 / S2 / 真HTTP无Run | Luna正常Host PID87588、127.0.0.1:4317；GET页面200、本地管理session200（不输出csrf）、未配对session401 SESSION_REQUIRED、跨Origin无cookie/CSRF POST空Run403 ORIGIN_REJECTED；正常配置匹配TLS Relay连接成立 | 前后main3/risk0；无Run创建/模型/GUI。不计完整Relay控制；当前Web index-BxSWOU01.js SHA `7df7b87809af3262ce48b0f55c2619b923c001ad74103e5d19312dad24c29d99` |
| 正常报告消费真实CLI失败 | `17ec145` / S5 / 离线实际报告API | Sol用正常CLI parseArgs/toResolvedRunConfig→buildRunReport/writeRunReport消费原CLI失败与PR23评估，输出`pr23-real-evidence/normal-report-import/`；runtimeOutcome=failed、fixture external_import/success=false、businessResult=not_assessed | 无新Run/Provider/Computer；配置与toolNames从已知CLI/真实exchange重建、清理诊断未重建，provenance明确。不是新CLI任务或D01人工评分 |
| 交付准备 | S6 | T1/T2/T3各三张卡完整，集中手机包/回退说明已建立；选中分支234文件扫描无敏感文件名、private key/live token命中，未输出匹配原文 | 可继续远端推送/草稿PR/CI核查；私有runs不提交，未完成任务明确留栏 |
| 18:48 远端交付 | 文档head `26b19a6`，产品 `17ec145` / S6 | github.com:443正常Git transport连接超时；正常已授权GitHub API可达。按Git Data API逐一同步27个缺失tree/commit，所有SHA与本地一致、37新增祖先历史保留；非force建立整合branch ref。创建并attach [draft PR26](https://github.com/wszkxlllll/Computer-Harness/pull/26) | 无重写/force/合并；私有runs与8个历史tracked dirty未纳入。公开可复现任务模板已附 |
| PR26首CI | head `26b19a6` / S5/S6 | [run38046181339](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38046181339)：Ubuntu22/24与macOS成功；Windows1865/1866，单个Runtime retry边界测试在5000次setImmediate轮询内未等到初次Provider；required失败保留 | 交Luna最小确定性retry调度barrier修复，不跳过Windows、不改变生产期限或边界；新head CI待复验 |
| Relay实际注册缺口与定位 | Host87588 / S2 | 正常POST本机challenge两次503 RELAY_UNAVAILABLE、约10001ms，activeChallenge已取消/零request/Run。health200/TLS/WSS匿名101不能代合法ready。停自有Host后公开HostRelayConnector使用既有.env.relay合法凭据收到relay.ready与registration ACK并正常close | main3保持；公网不可用/版本不符推论不成立。旧Host终止前无四字段有效比对，保持未知；显式配置正常Host复验继续 |
| 18:57 真实公网HTTP配对闭环 | 产品`17ec145`内容 / S2 / 正常Relay→Host协议 | 正常Host89224用显式既有.env.relay启动，challenge200/46ms。两独立0600 CookieJar公网pair request202→本机正常confirm200→Relay session200→各session200；独立cookie/device成立。缺/错CSRF403、非法字段Run400、重复GET runs均200/count0 | main3不变/零Run/GUI。撤A204→401时B仍200，最后撤B204→401；两个自有测试device清理，旧设备未碰。摘要`baseline/host-pairing-http-e2e-20261010.json`。这是正常协议E2E，不冒浏览器UI或Provider/Computer成果 |

| 19:04 Windows CI修复复验 | 测试`a491076`，生产`17ec145` / S5/S6 | 只改Runtime retry边界测试：等待失败事件提交后实际500ms retry timer注册，再推进fake time。Sol独立单例1/1及Runtime137/137通过；[run38046814449](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38046814449) Ubuntu Node22/24、macOS、Windows及required五项全成功 | 首CI失败保留；生产期限/边界不改，无跳平台。当前CI与旧PR历史结果分列 |
| 19:10 正常headless UI闭环 | 产品`17ec145`本地Web / S2/S4 | 专用Chrome154新profile、独立admin/client contexts：可见链接申请→电脑批准→connected；客户端刷新前后pending均1。390×844无横向溢出；无效码提示过期且pending/device均0。摘要`baseline/headless-web-pairing-summary-20261010.json` SHA `f7a2b5c9…d9ee8b`；Sol实际读摘要并查看脱敏截图 | 零Run/Provider；3个自有测试device经正常UI撤销，headless/profile已关闭。测试本地JS hash7df7b878，不冒公网当前资产同版或实体手机 |
| 19:12 公网Preview同版发布边界 | S6 / 既有严格SSH只读 | 实际Host origin对应Preview服务；当前34项固定闭包27相同/7不同。Preview根/current父/releases/Web dist均不可写，sudo -n -l无可用非交互规则，本地无部署workflow/helper；历史激活操作属root管理 | 未写远端/切服务/发布可写但不同origin的stable。正常公网HTTP配对通过与同版发布分栏；剩余为服务所有者合法发布权限，不能由TCP/健康替代 |

| 2026-10-11 解锁续接 | 产品17ec145内容 / S3 / L2 | 用户确认已解锁；原精确window14410已失效，零Provider失败后正常重启自有stock daemon92890，同0.22.2二进制。旧Open框14603初态错误Run `run-1791647543220-67255bdc-45a` 7个HTTP200、66事件后正常取消，未输入正文；重新准备空白并stock fresh capture确认新窗14623 | 原A01 main3→10/risk0；不复用旧窗口，不根据派发receipt冒认GUI有效 |
| 2026-10-11 正文正例/保存未完成 | 同内容 / S3 / L2 | `run-1791647793800-73957d72-cf2` Harness实际输入完整196B正文，seq23截图正例；CMD+S后独立保存sheet14633出现，但Run仍绑定父窗14623。后续输入仅unverified/posted，默认文件名未改变；126事件终态cancelled，目标文件absent，未保存/关闭重开 | 原A01 main10→24/risk0，含末次取消请求；同因付费暂停，修公开list/switch反馈后一次复测 |
| 2026-10-11 sheet独检 | Sol只读 / S3修复中 | stock原始inventory有同PID22394的14623父窗与14633“保存”，但无owner/parent关系字段，完整attestation缺失；不称exact-owned child。CMD+S工具反馈仅提示新窗，无opaque ref，模型未调用已启用list_windows/switch_window；模型no_effect为自报观察，不是driver证明 | 最小补公共工具发现/单独切窗/新观察提示；保留精确身份和显式模型切换，不自动信任同PID窗口。当前修订尚未真实验收 |

| 2026-10-11 提示修订实测未通过 | cc2af36 / S3 / L2 | 原完整1133B goal、新空白14661的Run `run-1791648620167-5bbc26cb-dad` 正常输入正文/转纯文本/CMD+S；保存sheet出现后仍未调用list/switch、重复父窗输入。117事件终态cancelled，指定文件absent。三次补证父窗启动在sheet前台时精确拒绝，均零Provider/捕获/输入 | 原A01 main24→37/risk0，失败取消不退号；停止同因paid，转动作后结构化候选反馈 |
| 2026-10-11 新CI暴露catalog截断 | cc2af36 / S5/S6 | 当前CI1866 Vitest全通过，TAP provider-description-probe失败QWEN_TOOL_CATALOG_TRUNCATED；Qwen固定180字catalog截断新增sheet安全说明。旧全绿不冒当前状态 | 修保留公共list/switch完整安全说明与全probe；当前剩3main预占，复测前正式增量续预占，保留actual/sequence37及批次总120/12/132 |

| 2026-10-11 结构化候选修复/组合独检 | 80192f1产品+5ba8e0a计数 / S3/S5 | 公共动作后fresh opaque inventory、过期refs拒绝与Qwen完整安全说明修复；Sol独立183定向、Qwen真实出站离线probe及114文件1870 Vitest+72 TAP通过，另12 guard/entry通过 | 原A01正式扩预占40/2/42→80/4/84，actual/sequence37及派发链不变，审计追加extension1条；非force远端保原SHA同步 |
| 2026-10-11 全inventory真实不足 | 同组合 / S3 / L2 | `run-1791649481080-2f52f675-d30` 正常新blank14695/完整goal；seq40真实工具输出64项含4同名“保存”，但模型仍未switch，输入仍父窗。126事件/14请求终态cancelled，文件absent；修复证实能输出refs，不能证实能完成sheet操作 | 原A01 main37→51/risk0；转本动作前后私有native identity的首次观测信息delta，不能随机ref字符串比较或自动owner授权 |
| 2026-10-11 清理与直接取消监控 | S3 / 非paid | Luna正常丢弃本轮明确自有14623/14661/14695失败副本，stock确认消失，未知用户窗保留；自有caffeinate已结束。Sol私有有界2s轨迹/PNG监控已建立并历史check-only验证，无信号 | 下一Run独立发现dialog反馈后两次连续同图input，直接核精确自有CLI PID/starttime并SIGINT，不经多轮转达；不自动业务GUI或新Provider |

| 2026-10-11 delta独检冻结 | `2c361c3` / S3修复→L2复测 | Sol发现初稿在tool反馈后才计算delta，由Luna修为真实execute→list→detect→list顺序，completed baseline/current Surface/exact binding和明确visible native identity差集；新候选信息前置、读失败/下一动作/transition清旧标签，不扩大授权。Sol实际4文件451/451与diffcheck0，作者typecheck0 | 原A01 main51/risk0；9文件显式提交，非force远端同SHA/PR26同步，下一完整空白T2立即启动，2s直接取消监控就绪 |

| 2026-10-11 delta真实命中/直接取消 | `2c361c3` / S3 / L2 | `run-1791650511165-fb22d1f0-f33` 正常新blank14729/完整goal；seq35 CMD+S首次候选恰1个“保存”、sourceActionId与实际动作一致，完整67项；实际toolNames含list/switch，Context保留该工具结果且0遗漏。模型识别Save及随后输入无效，仍type→click旧父窗；文件absent | 原A01 main51→58/risk0。Sol已实际2s监控并在seq45/54两次同图input直接SIGINT，seq57 cancelled/CLI退出；不再付费加prompt，下一仅high thinking每Run单变量对照；正式revision2预占104/4/108，原actual/sequence58保留 |

| 2026-10-11 high单变量对照 | 产品`2c361c3`、计数`0a376a8` / S3 / L2 | 首high Run `run-1791650788726-16dfb303-84f` 因测试入口旧effort白名单拒绝，零HTTP/计数不变；最小允许undefined/low/high、max/未知仍拒，Sol独立13/13。随后 `run-1791650884337-6cfa4f69-d60` 实际出站high/180000ms/8192/11tools、HTTP200；Save后仍hotkey→click旧父窗/无switch | 原A01 main58→64/risk0；seq41/50同图input由Sol直接SIGINT，seq53 cancelled。两profile同因失败后停止paid重复；转当前精确Save sheet直接绑定的输入补证，仅诊断不签收完整T2 |

| 2026-10-11 sheet捕获真根因 | 原stock0.22.2 / S3 / 只读原生诊断 | 精确sheet补证`run-1791651193520-5dc21586-0dc`仅CMD+SHIFT+G/click，无type/保存，三PNG同hash；view显示父族内容被fit到sheet816×534，注册bounds408×267错域。SC/CG/AX SPI精确目标及parent关系成立；原生四矩阵证明includeChildWindows默认true，false才返回独立正确域 | 原A01 main64→67/risk0、终态cancelled，文件absent；停止paid，干净d114 native仅显式includeChildWindows=false修复/构建中，未冒已部署。原stock与历史dirty保留，补丁/构建/回退材料将入repo |

## 当前范围决定与未关闭出口

2026-10-10 用户决定本项目只负责 macOS 电脑端、Web/Relay 与手机客户端，并覆盖原三线计划中的 Windows/Linux 平台目标。历史 Windows/Linux 事件、实现与跨平台 CI 结果保留；不继续承担其实现、修复、原生实测、环境寻找或交付，也不将其列为当前待办、阻塞或完成条件。

本轮可自主完成的接管、离线修复/检查、正常公网HTTP认证配对、隔离headless UI、评测器真实失败导入、PR取舍、非force远端交付与手机包已完成。当前Mac已由用户正常解锁，完整T2/T1/T3三轮与真实控制/同名双窗/sheet继续自主执行，不再列为解锁外部阻塞。剩余具体外部条件：Preview服务所有者发布权限以安装同版闭包；实体手机M1–M4；另一位队友试用；真实成功任务及真人审核以完成评分校准。不将任何一项并作“等手机”，不以L1或配对通过关闭任务成果。详细逐项状态见执行计划看板。


2026-10-11 原生 exact-window capture 最小候选：干净 d114f35 源仅 capture.rs 显式 includeChildWindows=false；作者345 passed/2 ignored、fmt/offline locked build通过，Sol独立capture测试13/13及patch/产物SHA核对通过。候选PID97824、独立socket启动成功，但首精确sheet14759捕获被OS TCC明确拒绝，shell fallback也失败，screenshot_frame_valid=false；无输入/新模型HTTP，A01仍main67/risk0。原stock保持不变，Swift矩阵成功不计为新daemon部署验收。继续核合法权限/启动身份及共享Runtime测试竞态，未经真实图验证不重跑付费T2。

2026-10-11 T1正常managed-browser首Run：run-1791652409383-ab187e69-b4c已run.created，computer.open在CDP endpoint阶段失败，Provider/modelRequests/actions均0；A01仍main67/risk0。原因为全局physical fetch guard把正常127.0.0.1 /json/version拒为非GLM endpoint，Chrome已产DevTools端口、专用profile清理confirmed，不是Chrome安装故障。正在做仅只读CDP endpoint分流与零计数反例验证，未经独检不重跑。共享Runtime两处旧轮询已改持久事件barrier+终态/5s race，Sol完整handoff 11/11，提交5247fb8；原生补丁与构建说明0ccc9ee已同步PR26。

2026-10-11 T1两次真实对照终态：DOM-only Run run-1791652639520-19540328-e6c取消，12派发/11已知usage响应；初始catalog degraded/empty，地址栏type全部明确no-input拒绝。旧监控仅依Save marker未覆盖网页，Sol直接SIGINT自有CLI；改同一私有监控默认覆盖输入、两次同图或重复明确no-input拒绝，并零信号验证真实seq36前缀会停、read/wait/copy同图不误停。hybrid零Provider公开Computer首次open/observe/close只有14个toolbar UIA refs、DOM0；单次真实hybrid Run run-1791653048455-d434cc54-91a的初观察同样DOM0，但seq16/37/47/57各有8个DOM refs，seq25用DOM Mac链接实际导航到/mac/；4次MANAGED_BROWSER_DOM_REQUIRED均选UIA refs（含后两次Mac mini），监控8.11s自动SIGINT、seq60 cancelled，6派发/5已知usage响应。A01累计85/risk0、9请求usage未知；T1三产品查询未完成。下一paid门槛为零Provider先实际取得网页内容DOM refs与Apple产品链接/可读正文，toolbar不合格；继续查Mac AXWebArea/contentRect可信生产链，禁止削弱Guard或再仅换profile。PR22实时d4eae01源码同样DOM-only fail-closed，未找到可直接复用的独立trusted producer。

2026-10-11 T1根因补正：hybrid可信producer间歇恢复，不能称整Run无DOM或Mac producer恒失效。公共click_element description与elementRef schema只称UIA catalog，而实际managed-browser内容要求DOM或完整可信别名，工具说明与执行合同不一致。下一步最小纠正source适用边界，零Provider核Mac mini等产品DOM refs能进入实际出站hot-set；若融合配额保留必拒绝UIA内容却挤掉可执行DOM，修候选可执行性/排序而非放宽Guard。d0313d9远端ref/PR head匹配，当前五项CI均success。

| 2026-10-11 T1零Provider AX二分与DOM门槛 | d0313d9 + 实验spawn override / S3 / 只读 | 无flag三次仅14个toolbar UIA；精确raw树depth16/32均无AXWebArea。正常自有ephemeral Chrome加force-renderer-accessibility实验后六次稳定87候选、18DOM/16DOM链接和AXWebArea。/mac/实际84候选中25DOM，完整baseline goal走Runtime selector后16项8DOM/8UIA且保留Mac mini DOM引用，故不改hotset排序 | main85/risk0不变；脱敏证据A01-private/hybrid-zero-provider/summary-20261011.json，明确实验spawn覆盖尚非产品启动验证。生产最小flag及click_element DOM/UIA合同修订后独检，再真实T1；不放宽Guard |

| T1最小启动/工具合同冻结 | 117c9cc / S3 / L1 | 自有managed Chrome正常启动加force-renderer-accessibility，click_element公共合同明确DOM/UIA适用；守卫/selector不改。首新增persistent fixture缺路径导致55/56，补fixture后Sol56/56、完整Qwen selftest exit0，历史失败保留 | 仅四文件显式提交，main85不变；dist真实flag已核，正常产品launch零Provider门槛继续，通过后直接完整T1 baseline，未等待CI当作运行许可 |

| T1产品零Provider门槛与正式续额 | 117c9cc / S3 | 正常ManagedBrowserHost无spawn override：/mac/124候选/32DOM，完整goal实际selector16项/8DOM含enabled MacBook Air link、物理bbox及goal_match/dom_content_priority；Mac mini DOM在raw但未入此帧hotset。任一目标产品已可正常导航，不新增三者同帧要求。原生TCC尚未获用户回复 | Sol沿既有API正式revision3扩到120/4/124，actual85/seq85不变；首次reason长度拒绝零HTTP后正常完成，批上限120/12/132不变。117c9cc五CI实际全成功；放行完整T1 baseline，保持直接监控 |

| 117c9cc正式T1 baseline启动 | run-1791654303592-bfb49906-050 / S4 / 正常CLI L2 | 原完整goal、hybrid、正常自有ephemeral/mac/起点、low180s、20/20；CLI1291。Sol立即挂既有直接monitor900s。前5请求、2GUI completed，真实DOM进入Mac mini官方页；seq39普通配置价格入口导航触发fallback financial审批 | main90/risk0；Sol独立view绑定ffb4213e PNG，Apple/mac-mini/精确坐标783.995,461.165在蓝色购买配置入口，不是订单/付款；既有用户授权内交Luna正常CLI仅批准该次并留痕，不改Guard。完整三产品任务仍进行中，不能以点击/单品通过收口 |

| T1审批输入入口拒绝与修复 | 117c9cc / run-1791654303592-bfb49906-050 | seq39购买配置导航审批，y两次无approval.resolved。Sol lsof证FD0为zsh heredoc临时文件、FD1/2为PTY；不是Guard/controller已证缺陷。Luna正常SIGINT，seq41 cancelled，5响应usage90851 tokens，审批动作未执行 | main90；修固定模板恢复FD0=/dev/tty，原完整卡/源码/URL/profile不变，不重跑DOM准备 |
| T1正确TTY复验及时取消 | 117c9cc / run-1791654516049-31d9eb08-9ab | Sol lsof核FD0=/dev/tty、FD1/2=/dev/ttys006；monitor6.05s二次同图seq24/34直接SIGINT，seq37 cancelled。新增4请求/3usage39147tokens。wait completed，DOM_CLICK_BBOX_MISMATCH与UIA MANAGED_BROWSER_DOM_REQUIRED均明确拒绝无输入 | main94/risk0、84已知usage1226846 tokens、10请求usage未知；无paid在途。seq14只发UIA mini uia-…-25，模型请求未露出的dom-…-25，不能据此断言真实mini布局变动；同帧raw/投影/live几何和可执行候选投影继续零Provider定位，不同版盲跑 |

2026-10-11 selector最小修复9a449e20：仅Runtime hotset跨源enabled DOM/content alias规范化与Han/L/N分词边界，不删adapter完整catalog、不放宽Guard。作者与Sol分别完整定向280/280通过，原5回归恢复；typecheck/build通过。正常产品零Provider proof Mac mini DOM进入16项hotset、同框UIA别名降后而toolbar/UIA-only保留；raw CSS→physical projection与live readonly validateClick一致、无输入/0Provider。私有摘要A01-private/hybrid-zero-provider/product-launch-20261011/selector-fix/mac-mini-selector-proof.json。原始SHA/tree非force同步PR26。完整原卡T1新Run已进入Mac mini配置价页，首公开导航由正常CLI视觉批准；后续同坐标重提的fresh审批图已变化，拒绝陈旧动作后继续观察。当前不是T1完成。

9a449e20完整T1终态：run-1791655591349-293b16fd-445 seq70 cancelled，7模型请求/6已知usage113104tokens（prompt111795/completion1309），A01累计101/risk0、90已知usage1339950、11未知usage。正常TTY首审批完成，实际Mac mini配置页已加载；第二陈旧重复导航审批正常拒绝。随后两次真实公开M6 DOM refs的click在派发前DOM_CLICK_BBOX_MISMATCH拒绝，seq57/67公开bbox完全相同、PNG同图；直接monitor78.92s达到二输入阈值SIGINT确切CLI3019。未完成三产品任务，不重放。源码只读发现click target.name做NFKC而live nameOf未做，真实M6 label含全角逗号，需零Provider验证名称不对称而非预判页面滚动或缩放。

2026-10-11执行代理恢复：原Luna连续三次工具流断开后停止，新Luna（同用户指定模型）接续唯一写产品/真实GUI。继承已落一行name规范化，真实115字M6回归末版作者46/46、typecheck/build与Sol63/63通过。只读live probe第一次因raw.role未定义参数错误退出，finally关闭自有浏览器、0Provider；不能冒称产品失败或live通过。原Host/stock退出经核确认，固定原签名bundle SHA822800…正常恢复自有daemon4254，现stock只读可达；无需用户重新许可，无TCC库修改。

1cec2ea3名称补丁冻结：业务一行normalize(candidate.name,160)，真实M6 115字符fixture，作者46/46/typecheck/build、Sol host+selector63/63。正常生产readonly模板已持久化 A01-private/hybrid-zero-provider/product-launch-20261011/selector-fix/managed-browser-live-validate-template.mjs；原raw.role/fingerprint读取错误逐项记录，正式4a9a95a0…json得到唯一raw/public radio/name/frame/fingerprint与当前tab/generation匹配后，最终DOM_CLICK_OCCLUDED拒绝、0Provider/0输入/cleanup0，绝不称全通过。Sol核旧9a449版已存在validateOnly clip/hit-test与非editable DOM.click分支差异；修复未改变任一guard，只关闭名称不对称误报bbox根因。完整原卡T1继续同A01剩19模型请求；此前actual101保持，所有历史用量保留。


## A01达到原上限与A02正式续接（2026-10-11）

- A01最后Run `run-1791657013535-e2460d0f-9f1`：原完整T1三产品卡，19 requests/14 steps，CLI exit0，Runtime succeeded/model success；独立业务检查**未完成**：iMac从未访问、Air配置未知，Mac mini 256GB仅按列表首项推断不能作已证配置。真实M6选择、内存/存储滚动、Air页面导航已有输入正例；正常审批按各自新截图核验，陈旧购买ref落点购物袋的两次提案拒绝，未补发分产品任务。无购买/支付/未知副作用，直接监控482.86s以terminal正常退出。
- 该Run已知usage prompt400501/completion5757/total406258；A01最终main120/risk0，总known109响应1746208tokens，11请求usage未知。金额未知，原120/12/132批次cap与全部hash/anchor/audit保留。
- 隔离PR23 `1f57852`正常消费该真实轨迹：`pr23-real-evidence/t1-a01-incomplete-model-success-assessment.json`，verdict=inconclusive/success=false，五维null、human_review_missing及5个action_observation_mismatch；初末截图实际hash绑定成立。模型success未被当业务通过；没有编造真人审核或自动业务评分。
- A02理由：第一次真正跨过名称故障并有实际网页导航/读取进展，但A01剩19不足完整三产品独立验收。独立命名空间`A02-private`正常initializeBatch，cap main60/risk6/total66、首Run预占40/2/42，state/anchor/audit独立0；完整原卡、冻结版、持久TTY模板及直接取消监控复用，禁止拆单品拼成功。私有`A02-batch-decision.json`/`A02-private/batch-decision.json`与启动模板已持久。
- A02首次入口 `run-1791657677453-e6e5d51b-45f`：0GUI、首Provider请求在delegate前`COUNTER_IDENTITY_REFUSED`，实际main0。精确原因是initializeBatch允许较小cap，但guard读state仍硬要求cap等于120/12/132；Luna正最小修为每项不超过默认硬上限，保留全部identity/hash/audit，不重建A02或删除失败。
- `1cec2ea3`远端原SHA与PR26一致，当前五项CI全绿（run38075969909）；9a449的Windows共享TUI超时作为历史失败保留。

A02计数修复冻结`8952537f1de96b4c6b8b13b69b536841187cd487`：只有stateAndAnchor cap等值改每项≤默认硬上限，validCounts仍要求非负safe integer/total=main+risk，identity/hash/anchor/audit及原A01回归不变。作者和Sol各独立15/15通过。修复后同A02 root正常Run `run-1791657750228-282eae92-1e1`，原完整卡40/40、PID5705、TTY61934；实际guard加载8952537同内容（提交前加载），产品1cec2ea3不变；Sol直接监控session10310即时挂上。首配置导航仅正常审批当前蓝色购买按钮，无人工业务分步补发。

A02首有效Run `run-1791657750228-282eae92-1e1` 终态cancelled/CLI exit0：13 requests、11steps、4审批、usage prompt270842/completion3968/total274810。Sol在第二次Mini配置→overview→同配置/旧Buy UIA提案形成无新产品或已证字段进展的闭环时，直接核own PID5705/uid/argv后SIGINT，pending动作未批准；`business-loop-cancel.json`保seq87/98/111/116/130/133。A02实际main13/risk0（cap60/6/66、预占40/2/42不变），无在途；A01仍120/0，合计133/0。已知122响应合计2021018tokens，11请求usage未知，金额未知。停止同版paid，离线用真实轨迹核上下文/导航/完成证据约束；T1尚未通过，不能用completed派发替代业务进展。

下一单变量为正常CLI公开`--planning`（tasks-v1），不是新增prompt或单题解析。私有`A02-private/planning-proof/verify-tasks-v1-projection.mjs`使用完整T1卡、生产FilePlanStore/DefaultContextCompiler/GlmAdapter.prepare，作者及Sol独立0Provider/0GUI验证：phase持久到后续输入，task_create/update/list/get可见；最终remaining1仍有原goal/plan、仅terminate与未完成failure约束。phase明确synthetic、非模型成果；pending plan的DefaultRuntimePolicy.canFinish仍allowed，planning本身不构成完成证明。正式扩预占至60/4/64 revision1，actual13与cap60/6/66保留。首次reason超160字符按合同拒绝无更改，缩短后正常API成功。

`run-1791658406322-7e2a3f10-282`已同完整T1卡开启planning对照，40steps/requests、low/180s、hybrid/ephemeral不变，实际计数沿A02继续；Luna唯一执行、PID6777/TTY7756，Sol直接monitor36600即时挂上。持久正常启动命令`A02-private/launch-planning-t1.py`已Sol核完整batch-host wrapper/绝对root/reservation/--entry cli --/真实FD0 TTY，后续复用；此前漏wrapper首Usage零Run/零HTTP保留。首Mini公开配置导航正常审批仅核当时新截图，未补业务步骤。

Planning正式对照 `run-1791658406322-7e2a3f10-282`终态cancelled：13requests/10GUI steps/9审批，13个HTTP200 usage合计prompt293824/completion3208/total297032tokens。工具表真实暴露task_create/update/list/get，但task_*调用与planning.task.updated均0，不能称模型建立了phase。Mini 16GB“已含”有独立PNG证据；完整三产品仍未完成。第二次49B Air URL type提案在首次n后重复，审批PNG74695cab/aaa0f983逐字节同SHA `be27a35e647a126be7d9ee0adc3a6c3699f9f0a7fa7eaac70e0b8114e4d12e46`、地址栏未验证焦点；Sol直接核ownPID6777/uid/argv后SIGINT，不等转达，pending动作未批准，无unknown side effects。A02累计26/0，停止同版/同因付费，转PR23/controller/T3。

导航加载候选：Sol实际view首次DOM购买点击后的模型图f4523649，仍旧landing且Chrome显示spinner/停止X；当时旧Buy catalog与图相符，后续审批fresh图才到配置页。该事实支持后续观察暴露navigation pending或有界settle的候选，不证明当前catalog几何/上下文丢失，本轮不为此加新门槛或分散改产品。


## PR23 审批证据兼容闭环（2026-10-11）

隔离评测器冻结 `cb6aacfcd256cad84f6389d4933967984888f1c6`，仅 evaluator 与其测试两文件；独立 Sol 全量157/157、diffcheck通过。正常审批保留 decision basedOn、以新审核截图执行的链现在可核验；关联审批是独立不变量，唯一 request/call/action、proposal 全字段、批准顺序、新鲜 observation 均必须精确匹配，改成 wait/fresh basedOn/另一 actionId 不绕过。表驱动覆盖拒绝/待审/错ID/复用/乱序/过期及坐标、keys、raw text/sanitized length变体；合法click/type用合成人工审核成功正例。

真实A01末Run重消费后5个误报 observation mismatch 消除，仍 `inconclusive/success=false`、五维null且 `human_review_missing`；独立业务缺iMac/Air配置/未证存储结论仍保留，未编造真人评分或T1成功。按原SHA非force同步专用分支，依赖draft [PR27](https://github.com/wszkxlllll/Computer-Harness/pull/27) base为PR23的 `member-c/evaluator-20261005`；PR26说明已关联。未修改队友原分支，未混入产品分支。A02仍26/0、A01+A02合计146/0，无新Provider调用；下一自主项为正常Host/controller控制与T3来源查询。

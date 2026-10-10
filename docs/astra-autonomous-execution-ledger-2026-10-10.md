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
| 当前新增实际调用 | main3 / risk0 / total3；首90s失败与正常CLI两次HTTP200均保留，CLI终态failed/零输入 |
| 当前可见返回usage | 两个HTTP200合计prompt16343 / completion9740 / total26083 tokens；首timeout无usage，金额未知，不能把已知usage当本批完整账单 |
| 当前预占 | 首Run main40 / risk2 / total42；A01-private累计保留，累计消耗3（失败不退号） |
| 接管源码 HEAD | `b1e44e150579bbf5f0d2b6183a49f83aefe08bd0` |
| 当前提交组合 | 产品`17ec145`，测试修复`a491076`；后续仅交付文档，真实T2证据仍属此前明确版本 |
| S2冻结源码 HEAD | `2e64d90`（产品/测试 `e0ca96f`，自主计数入口 `2e64d90`；内容未随提交改变） |
| 分支 | `codex/three-track-integration-20261006` |
| 基线快照 | 2026-10-10 17:34:22，tracked changes24，untracked status entries245（目录折叠，不等于逐文件数） |
| 源码清单 | 451项；`baseline/source-manifest.json` SHA-256 `154d73a5ceb538f0b08835b1c3a1b7f9a6abd48e4d89afc1460f1a90974866cc` |
| 可恢复材料 | `baseline/git-status.txt`、`baseline/tracked-diff.patch`、源码 hash 清单；未跟踪文件保持原位 |
| 当前构建/进程/客户端 | 17ec145内容；476项dist闭包SHA `f17dd74bad35aea6286f16e083f277f6a5e5a1978a8420104e0f228b9c991c0d`；Host89224正常运行，无在途Run（87588已正常退出）；Web index-BxSWOU01.js，详细进程/资产baseline快照 |
| S1构建闭包 | 476个apps/packages dist文件，含Web4资产；`baseline/runtime-build-manifest.json` SHA-256 `310b5de388dc1f81a930a45b2029ae9f25b671787db16bc8ea4aba4671a41855` |

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

## 当前未关闭出口

本轮可自主完成的接管、离线修复/检查、正常公网HTTP认证配对、隔离headless UI、评测器真实失败导入、PR取舍、非force远端交付与手机包已完成。剩余具体外部条件：Mac当前console正常解锁后完整T2/T1/T3三轮与真实控制/同名双窗/sheet；对应Windows/Linux可达原生桌面（ubuntu-vm一次正常SSH超时）；Preview服务所有者发布权限以安装同版闭包；实体手机M1–M4；另一位队友试用；真实成功任务及真人审核以完成评分校准。不将任何一项并作“等手机”，不以L1或配对通过关闭任务成果。详细逐项状态见执行计划看板。

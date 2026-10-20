# Sol 独立检查记录

2026-10-12 11:53 本轮修复完成并停止（用户要求本轮完成后停止，最新状态以本段为准）：F089已精确27文件提交并原SHA推送 `e7bce7f7792b455d02212c717a34206412002d14`；来源引用finish默认关闭，可经正常CLI/Host显式配置，Runtime只引用本Run已持久化Observation中的保留grounding并规范渲染结果，未知/推断明确标记。它验证来源与输出绑定一致性，不机械判断SKU语义或事实真值，不计T1业务通过。作者最终452/452，Sol独检239/239与Root独检213/213互补合452；主工作区tsc-b exit0，24源文件与冻结pin全部一致。当前HEAD CI38201158820已由Root于03:52:50Z实际核completed/success，4 verify及ci-required共5job全部success，不继承旧cb93五绿。详见[F089](../2026-10-20-product-docs/a-line-sync/fixes/F-20261012-089-source-linked-finish.md)及[来源引用审查](./astra-source-linked-finish-review-2026-10-12.md)。

本轮未新增真实Provider请求或GUI业务。A07仍actual61main/0risk/61、reserve120/6/126 rev2；累计498actual=490main+8risk、468known合8,600,579tokens、30unknown，金额未知。95b CLI L2 experiment的T2完整基线/独立repeat/原variant三轮限定通过；正常Web首录入1134B而原卡1133B，已取消并保留轨迹/文稿，不算原卡通过。新表单实际AX值曾逐字核1133B/尾1LF，尚未再次Start；不再启动新Web/paid轮。T1业务、T3完整闭环及其复验/变体、真人五维、实体手机/语音与Preview远端部署仍缺，T3只读设计保留，未实施。

收尾资源已核：所有既有Run终态后，自有Host26665与Relay26276逐UID/start/完整argv确认，各一次SIGTERM、ps gone且原PTY均exit0；Root keeper26995已由Root精确停止，不续保活。native98330、stock4254、归属未证debug21139及旧成果/错误路径文件未动。隔离T1工作树保留供审阅。六入口仅同步本地最终状态，不新增提交循环；本轮修复与CI已完成，现停止工作；不再启动任何后续任务。

本轮协调/检查由 Sol 承担，Luna 为唯一产品源码及现场执行者；首次离线检查未操作 GUI、请求模型、重启服务或修改业务源码；后续经明确互斥交接的独立零Provider GUI验证按下方实际记录分列，未代写产品源码。因并发槽已被已完成历史代理占用，单独 Sol 检查代理创建失败，作者与检查者仍分离。

## 17:38：S0/S1前静态检查

实际读取当前 dirty 的 Runtime、协议、轨迹、Remote API、CLI、CUA driver/platform 改动及 Host 启动配置；读取正常配对/CSRF路由及CI/test入口。未将历史测试作为本次通过。

- 当前补丁引入 `BoundWindowMissingError`，仅已完成动作的父窗重新发现明确缺失时触发；Runtime 转 `waiting_window`，保持已完成动作并要求准确 sourceActionId 与新候选 token。候选刷新使旧 token 无效，Remote API指纹包含 token。方向符合“不重放未知副作用”的保护要求。
- 完整 T2 的真实关窗衔接仍需现场证明：关闭当前绑定文稿后若进入 `bound_window_missing`，正常 Web/CLI 明确人工选窗仅算补证，不自动关闭完整自主 T2 出口。现有 `switchWindows` opt-in 提供模型 `list_windows` / `switch_window`，但默认关闭；是否可由模型在有效绑定阶段安排第二窗口及重开须实测，不能凭源码声明通过。
- 正常 Host `apps/host/src/index.ts` 支持 loopback 正常配对；精确 origin 必须一致。管理页 `/connect` →新挑战→隔离客户端 `/pair`→管理批准→合法会话及CSRF，可在本机完成；无需手机 cookie 或匿名执行。
- 正式 `scripts/test.mjs` 是固定 Vitest 和显式 selftest 列表，独立 diagnostics 不在批量范围。测试实际副作用与结果由 Luna 再核并执行；未运行真实Provider验证。
- Git worktree清单确认 PR23 隔离树存在于 `Computer-Harness-pr23-evaluator`，HEAD `5ddd9b58bd431f2189da787df387730ffbc50829`；尚未复核其当前dirty和评测结果。
- GitHub CLI 当前未登录，`gh pr view`返回exit4；因此没有获得本轮PR/CI状态。后续尝试公开只读来源及已有Git授权能力，不冒称远端通过。现有CI固定Ubuntu/Windows/macOS离线矩阵，不证明相应GUI现场。

未发现可凭当前静态材料放行的真实T2/全平台出口；上述关窗能力为待实际验证范围，不预判当前驱动失败。

## 17:42：独立PR23与平台核查

本次在独立PR23树 `5ddd9b5` 实际运行 `node --test scripts/stage4-local/evaluate-trajectory.test.mjs`，14/14通过、exit0。该树当前 `git status --short` 无输出。已核 pending、缺variant、未审计click、不可信in-band证据、批处理不计pending为pass边界；仍缺受信任且绑定Run/manifest/family/variant的独立业务证据生产接口，不能以14项合成通过签收真实成果集成。

本机有 VMware Fusion 的 vmrun，`vmrun list` 返回0运行VM；常规VM目录仅 `.localized`，Parallels/VirtualBox及本树`.vmware_vms`不存在。Docker有desktop-linux context但daemon未运行，`docker ... info`无法连接。此仅说明当前未找到可立即执行的Windows/Linux GUI，不代表安装或启动容器就具备原生桌面验收；继续核已有配置，不猜测远程凭据。公网git读取未即时返回，不将CLI未登录直接推断为所有GitHub授权通道不可用。

S1首轮唯一9例失败的初步“漏bootstrap”归因已由Luna纠正：fixture已有bootstrap假实现；fake driver仍需CUA SDK输入工厂，触发Vitest `import.meta.resolve`。当前改用仓库标准离线SDK fixture，待定向/组合结果及diff复核；没有修改业务代码。

## S1收口：日志与补丁复核

Sol实际读取 `s1/S1-summary.txt`、首轮/修后suite输出及定向/Web日志，核 `git diff --check` exit0；修复仅 `managed-browser-companion.test.ts` import并调用既有 `installFakeCuaSdkModuleForTests()` 两行，不改生产SDK或跳过bootstrap/driver/failure-cleanup。原有标准假SDK连接器在未注入真实driver时直接throw，输入工厂替代真实native加载，适合该离线fixture。

Luna实际运行：typecheck exit0；定向13/13；组合114文件1841/1841 Vitest及71/71 TAP；Web build exit0。Sol核日志与源码，不冒称自己重跑所有基线；首轮9失败保持记录。S1可推进，真实Host/GUI/API通过仍待S2/S3。

## S2计数草稿检查（上线前）

实际读取新增 `scripts/autonomous/batch-fetch-guard.mjs`、test及单一 `batch-host.mjs`。首草稿尚未派发真实请求，发现并交Luna修正：自定义reservation误用默认值、anchor未绑定实际counter、expected limits回读自state而未固定、同步异常与assert.rejects测试合同不一致；正常Host控制工具 `terminate`/`interact` 漏分类。要求一次最小修正后检查，保持生产Guard和Provider响应合同；不引入旧TTL/多方发行审批链、不建第二runtime。下一Run必须保持同一批次实际累计，不能新目录重新归零冒充A01。

公开Git读取已取得当前refs：main `961a0982ee11bf2f4687756f5184869f197a1b4b`；PR22 `d4eae01a1f27b6c73e2bee64b57e769d39894954`；PR23 `1f57852879b53618029c24afedb1b5db0a786fe6`；PR24 `39a3b2aa9779024b30da50b0d2ef6b952163e2f4`。未认证公开REST PR22返回404；不由此判断PR状态或所有合法授权通道。PR23只读fetch至独立remote ref进行差异核查，不切换当前dirty实测组合。

## S2计数修订签收

Sol全文读取修订三脚本，实际运行 `node --test scripts/autonomous/batch-fetch-guard.test.mjs` 8/8、exit0，以及guard/Host入口 `node --check` exit0。固定batch120/12/132、动态reservation、state完整hash与anchor及sequence=total、async异常、正常Host控制工具分类已修。失败/超时不退号、重启续同计数、并行不超限、回拨及端点/redirect拒绝反例通过。允许首Run40/2/42预占的正常Host实测；这是技术检查结果，不新增授权门。

计数的 `actual` 字段实际上是delegate前持久消耗号，审计I/O失败等极端情形可能尚未真正到网，必须与Provider exchange逐项对账；保守耗号不能直接写全部HTTP已发生。首Run后后续reservation续额须保同一累计，不以新目录冒充A01清零。当前脚本未实现业务证据或完整任务通过，生产Guard及响应对象未被替换。

## 远端实时核查与源码冻结

正常Git credential helper可供内部管道调用GitHub API，本次未输出/保存凭据；GitHub CLI未登录不是远端交付认证阻塞。实时PR：

| PR | 状态与head | 本次核到的最新CI |
| --- | --- | --- |
| [22](https://github.com/wszkxlllll/Computer-Harness/pull/22) | open、非draft，`d4eae01`，base main | [run37952179569](https://github.com/wszkxlllll/Computer-Harness/actions/runs/37952179569) 五check success |
| [23](https://github.com/wszkxlllll/Computer-Harness/pull/23) | open、非draft，`1f57852`，base codex/runtime-surface-preview-20261003 | [run37597123063](https://github.com/wszkxlllll/Computer-Harness/actions/runs/37597123063) 五check success |
| [24](https://github.com/wszkxlllll/Computer-Harness/pull/24) | open、draft，`39a3b2a`，base main | [最新run37336228461](https://github.com/wszkxlllll/Computer-Harness/actions/runs/37336228461) 五check success；先前37336072911失败/取消保留 |

三者均未合并；这些CI是其远端head，不能替本地组合或真实GUI通过。PR23 fetch在约75秒后网络失败，未切当前树；独立本地5ddd9b5的14项不冒称远端1f57852测试。

协调分批提交已核产品/测试17文件为 `e0ca96f`，自主guard三文件为 `2e64d90`，未改内容、未reset/clean、未全量纳入未核历史diagnostics。当前运行源码基准 `2e64d90`；S1 build closure476文件（包括Web4资产）SHA `310b5de388dc1f81a930a45b2029ae9f25b671787db16bc8ea4aba4671a41855`，详细本地清单在baseline。历史docs/diagnostics未跟踪材料继续原位保留。

## 18:02：首个正常Web Run终态独检

实际读取 `run-1791626283697-82c22354-0ac` trajectory及provider-exchanges：9事件，原生TextEdit open与initial observation成功，随后唯一model请求90s awaiting_headers失败，run.finished failed；没有工具动作、正文输入、保存、关窗或重开。唯一exchange有fetch_invoked和fetch_failed，没有headers_received/httpStatus；保守计数main1与实际delegate证据对齐，失败不退号。

wire143863B、1image、17tools、8192输出；prepared文本12554+visual480+envelope32=13066tokens，低于24576 wire预算。实际thinking enabled/reasoning_effort server_default，deadline90000是正常Host默认；不是证据充分的“大goal超窗”，不删goal/正文/工具/图像。下一步核历史180000/low是否正常env传递漏项后有界复测。

run.created goal仅移除card.goal末尾LF，恰等于既有GoalComposer.submit的trim行为；196B正文、UTF8/LF及末尾LF明确要求仍保持。辅助CUA locked提示与root只读IOConsoleLocked=false、stock初始截图可用分别记实，不由辅助观察故障判定实体锁屏或人工解锁依赖。

## 18:10：正常CLI timeout转发快审

实际读取CLI源码/测试、同一batch入口/test及根test入口五文件。仅GLM读取timeout env，使用既有1000–240000ms validator；默认unset、180000转发、非法值拒绝、Qwen不受无关坏GLM值影响。batch入口仅固定host/cli真实路径，guard与A01累计不变。Sol实际独立CLI11/11与entry拒绝1/1 exit0；Luna另CLI build通过。提交 `907c0a9`，本次没有新增goal-file/CLI业务参数、产品默认或正文辅助写入。

隔离PR23当前v2实际消费首Run失败证据，明确T2本地manifest，退出0、inconclusive/success=false，五维null、人审pending；截图hash真实绑定。没有构造真人复核、D01成绩或CLI成功导入。

## 18:30：907组合、当前会话与S4范围

Sol实际运行907组合：114文件1847项Vitest、72项TAP全通过，exit0；日志`s1/sol-907c0a9-combination-test.log`。Luna另17文件302项controller/preview定向全通过，只计L1合同。其Relay HTTP/WSS使用fixture Provider/Computer，不能代正常生产L3。

三次foreground CLI均在computer.open止步、零模型/捕获/输入，累计main3不变。stock exact gate同时检查CG前台、AX焦点与SkyLight进程；当前helper14409确与目标几何重叠，不能因System Events前台PID一致即放宽。正常隐藏helper未移除其CG窗，AX又无法准确取得helper window，未执行盲最小化/kill。

此前IOConsoleLocked=false的推论在本稳定点修正：Sol直接解析ioreg同一字典的CGSSessionScreenIsLocked=true及kCGSSessionOnConsoleKey=true，Luna独立同得true/true并保存仅布尔摘要。当前console确实锁定，停止GUI与模型复试；不绕保护，也不把这个时点证据追溯成所有历史失败根因。继续浏览器DOM可行性、离线合同、PR增量与交付。

PR24现有head静态复审发现两项必要UI合同缺口，已交Luna最小恢复：EventTimeline的retryable不能承诺系统正在重试；select_option审批须按同request/observation可信DOM证据并排除敏感串后才显示短选项，否则redact。实施后独立审查与反例验证，未签收前不提交。

## 18:42：PR24最小安全UI增量最终检查

实际读取八文件完整diff，Sol独立定向40/40通过；错catalog session/surface、错evidence decision/asset/time、disabled/重复/截断/敏感项及中文160/161 UTF16边界均保持redact。原PR24界限是UTF16码元而非UTF8字节，文字计数为Unicode code point；没有改变生产Guard或把展示参数当执行结果。显式提交17ec145，未混入历史dirty。Luna最终typecheck/Web build及114文件1866项Vitest+72项TAP通过；此次Sol没有冒称独立重跑全套。

正常Host当前内容与17ec145一致，实际无模型HTTP冷启动200/200/401/403反例成立；只证明相应HTTP/认证边界，TLS连接存在不代Relay完整交互。浏览器DOM listTabs约30s超时，未绕锁或冒双浏览器隔离成功。

Sol实际使用正常CLI配置解析和报告API消费CLI真实失败轨迹与PR23外部评估：runtime failed、external_import success=false、business not_assessed。这是离线报告集成，不是新CLI业务Run；provenance说明配置重建/清理诊断未重建。

## 18:57：公网协议E2E与首CI失败归因

Sol实际读取脱敏真实HTTP E2E摘要。合法公开HostRelayConnector ready/注册ACK成立；正常Host89224挑战200，两个独立正常客户端202→管理确认200→会话200，缺/错CSRF403，非法createRun400/Run列表0，分别自撤销401且另一客户端不受影响。全程模型main3不变。这证明正常公网Relay/Host协议会话与反例，不代Browser UI、真实controller任务或手机。首次两次503记录保留，旧Host有效值未快照，不能断言旧凭据错；当前显式配置可工作。

PR26 head26b19a6首CI的Windows1865/1866，唯一测试在retry reserve case的5000次setImmediate轮询前未进入首次Provider；Ubuntu22/24/macOS均成功。Sol实际读下载日志与源码，发现该case还可能早于retry timer注册就advance fake time。交Luna仅该test用实际retry调度barrier，不扩轮询/跳平台/改生产期限。待独检和新CI。


## 19:12：最终CI、headless UI与发布权限边界

Sol实际审查a491076测试diff并独立运行单例1/1及Runtime137/137。修复等待失败事件持久提交后的500ms retry timer注册，保持119500拒绝/119499接受与生产期限不变。[当前CI38046814449](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38046814449)的Ubuntu Node22/24、macOS、Windows、required均成功；首Windows失败保留。

实际读取headless摘要并视觉核390×844脱敏截图：390px宽页面无横向溢出、无可见token/二维码；摘要记录独立contexts配对批准、pending刷新1→1、无效码pending/device0→0。该截图是清理后的连接管理页，不能单凭截图证明客户端已连接；连接事实取正常UI摘要/记录。3个自有device正常撤销、专用Chrome关闭；本地JS hash7df7b878，不冒公网同版或手机。

Luna以既有严格SSH只读核当前origin的Preview：34项闭包27同/7异，root管理发布目录全部不可写，无非交互sudo规则或本地发布helper。保留未发布状态，不改变权限、不部署可写stable冒替。公网协议配对通过与同版发布权缺口分列。当前本轮自主可执行项已穷尽，后续具体外部条件在执行看板/手机包列明。


## 2026-10-10：用户调整平台责任范围

按用户本次明确决定，Astra 当前责任限定为 macOS 电脑端、Web/Relay 与手机客户端；Windows/Linux 的实现、修复、原生实测、环境寻找和交付不再属于待办、阻塞或完成条件。Sol复核两份计划、交付包、账本当前出口、进度结论与AGENTS范围句；原历史事件、测试/CI事实、现有兼容源码及CI均保留。完整macOS任务、Web/Relay与手机验收标准保持；正常解锁仅是继续真实Mac GUI任务的前提，不妨碍离线或Web工作。

本次只修改文档并同步既有PR26；未重跑测试、付费模型、GUI或部署。AGENTS仅本次新增范围句纳入提交，其余既有dirty保留。


## 2026-10-11：解锁续接与保存sheet复核

用户正常解锁后，旧window14410已失效，未发Provider的精确绑定拒绝保留；正常重启自有同版stock daemon后重新发现。错误Open对话框初态Run正常取消并更换为空白14623，fresh capture确实改变，不能将此前图像不变直接归因捕获缓存。最新Run `run-1791647793800-73957d72-cf2` seq23真实截图有完整六行正文，CMD+S后独立保存窗口14633出现；输入仍向父窗14623派发，后续unverified receipt与默认文件名未变不构成保存成功。126事件终态cancelled，原A01累计main24/risk0，目标文件absent。

原始inventory无owner/parent关系字段，不能自动称exact-owned sheet。公开list_windows/switch_window已可用，Run未调用；最小工具说明补充dialog独立窗、无可见效果先list、显式切换并等新观察。Sol独立实际22/22已有Runtime/adapter切窗、安全域、过期与父子恢复定向测试通过（377未选测试不计通过）；新提示尚待真实验证。模型observationAssessment的no_effect为模型自报，不是driver验证字段。保留显式refs/身份/独立turn，未放宽同PID信任或自动切换。

T095原始trajectory位于既有私有临时root，直接读取75事件并查看初始截图：原始空白文档已命名b93…rtf；六个GUI动作只有两次输入、click、Return、转纯文本、CMD+S，全程surface1，无list_windows/switch_window/handoff。这验证历史149B诗文是已有命名RTF转TXT原地保存，并未覆盖本轮未命名文档的独立Save sheet及指定唯一路径；不将其旧成功推定为当前sheet链路已通过。原始私有轨迹/截图不提交。


2026-10-11 保存sheet delta复核：首次草稿仅在detect填标注，而真实Runtime在detect之前已提交fresh list工具结果；Sol拒绝该时序并由Luna修为execute→list→detect→list实序。已独立复跑4文件451/451定向测试exit0（私有日志`A01-private/sol-delta-targeted-test.log`），作者typecheck通过，独立diffcheck0。completed baseline与当前Surface generation/精确binding匹配后按私有native PID/window身份比较，只标明确visible候选；失败读取、下一动作及目标transition清信息，成功fresh list仅重投影仍visible身份。工具前置firstObservedOptions、Context新候选优先展示，均明确不证明创建/owner/前台/关系，未改变Host scope、opaque ref失效或自动切换授权。共享Runtime竞态测试仅等待持久化且已reduce的handoff事件，保留全部原断言。下一正常完整T2真实复测前原A01仍main51/risk0，无在途；离线通过不签收保存成果。


2026-10-11 原生sheet捕获根因独检：low/high完整T2均在Save后无switch，后者真实出站high/180000ms/8192/11tools，直接监控及时取消。直接绑定Save的补证Run只发生CMD+SHIFT+G与click，没有type/保存；不能记作sheet文本输入失败。Sol独立查看该Run816×534原PNG，父窗约642×534、右侧黑边约174px，与父586×488按高度fit一致，内容域不等于所注册sheet408×267。系统screencapture exact父/子ID均返回同1172×976父族图；SCWindow.frame、filter.contentRect与CG bounds却分别精确对应各目标。Luna只读AX SPI证明focused AXSheet14759→AXParent14748，同PID22394，非同PID或标题猜测。Sol实际读取0600 native-window-proof.json并view false图，确认SCStreamConfiguration默认includeChildWindows=true；四矩阵中false分别返回纯父文档或独立sheet，true把父族绘入sheet小画布，故仅验尺寸会伪通过。Apple公开配置提供[includeChildWindows](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/includechildwindows)；当前最小修复为原生exact-window capture显式false，保留身份/frame校验，不在TS裁黑边、不全屏替代。干净固定d114源隔离构建与真实new-daemon验证仍在执行，离线probe图不能当已部署修复。A01此稳定点actual/sequence67、risk0、revision2，无在途请求。


2026-10-11 原生最小补丁冻结独检：隔离 d114f35 worktree 仅 capture.rs 改变，配置 helper 显式 with_includes_child_windows(false)，exact filter、identity/frame/scale/尺寸及输入守卫不变；新增尺寸与 child flag 回归。Sol 独立读取完整 patch、复算 patch SHA980323a0737626152a27ad0edda2eb0408f944e707f5a63f6094bd74d3e8393b 与候选 SHA cf81ab359cfb2acf38096da455a1fecd3dbbdda5019c6780bcc65cc2b80131b0，并实际执行 capture::tests 13/13（包括身份变化拒绝与缓存失效）。作者 platform-macos 全 lib 345 passed/2 ignored、fmt 与 offline locked build 成功；原有 CoreMediaBridge 重复符号警告保留。候选未替换 stock，独立检查签收源码与离线验证，真实 fresh-daemon 图像仍待验。

2026-10-11 候选权限身份复核：独立 codesign --verify --deep --strict 通过；CaptureFix app 的签后 executable SHA a0c49e066d62fe54eaff29facbda658168610f70bb64f582a07351a2f0c8ddc7。原 stock executable SHA 仍82280013239871397bf57baf133271413640b3bba8a51661a841e5f2bc50219c，未替换。新候选是独立 bundle id com.trycua.driver.capturefix.local.20261011，非stock签名身份；实际TCC屏幕捕获拒绝、AX未解析，而同时既有Swift上下文可捕获同目标。正常OS屏幕录制/辅助功能授权作为具体外部条件交root向用户请求；没有改TCC数据库或通过伪装进程复用授权。

2026-10-11 非GUI续接独检：共享Runtime两等待已换持久事件barrier，含Run先结束与5s超时race/清timer；Sol完整handoff 11/11，单文件5247fb8。T1首次真实Run在computer.open终态failed、零Provider，系global fetch guard误拦CDP metadata；d0313d9仅允许精确127.0.0.1显式合法port的/json/version及/json/list，默认/GET、只允许signal/method/redirect、强制redirect:error，无body/auth/query/编码路径或其它fetch扩放。Sol完整diff、15/15 guard+entry反例独审通过；另实际生产dist default+DOM/select_option+windowSwitch 13tools零HTTP分类全main，无需扩大工具白名单。A01仍main67/risk0，真实T1复测正执行，未签收成果。

2026-10-11 T1逐事件补正与直接控制复核：原dom-only Run12派发/11usage，hybrid Run6派发/5usage，累计85/risk0，已知76响应1096848 tokens、另9请求usage未知。hybrid首次只有toolbar，但seq16/37/47/57各8个DOM refs，seq25 DOM Mac点击完成且后续实际/mac/内容，不能断言全Run无DOM。四次MANAGED_BROWSER_DOM_REQUIRED都选择UIA，后两次为Mac mini链接。通用私有监控默认input arm，实际hybrid8.11s后二次同图自动SIGINT，seq60 cancelled；零信号回放原dom-only seq36前缀可在两次停止，read/wait/CMD+C同图反例不触发。公共click_element说明/schema错误地只称UIA catalog，正在改正确DOM/UIA适用合同；无放宽Guard。原生raw树depth16/32均无AXWebArea/Document，非简单深度/256截断；继续正常force-renderer-accessibility零Provider对照。

2026-10-11 T1独立补核：实际读取零Provider脱敏摘要，无flag三次toolbar-only；加flag六次稳定WebArea/DOM。完整baseline selector保留Mac mini DOM hotset，未证排序缺陷，不调整配额。当前click_element description/schema将“UIA catalog”改为当前grounding catalog并明确managed内容用DOM ref，UIA内容只有唯一DOM等价时可能执行；只改公共文案及错误名，不改守卫。Sol独立computer-tools 11/11、完整provider-description selftest exit0，日志A01-private/sol-t1-description-probe.log；生产managed launch flag仍由Luna实施，尚未签收产品真实启动。

生产flag首轮独立定向保留失败：launcher/tool组合56项55通过、1失败，新persistent fixture遗漏显式executablePath而本机无Edge，故未到spawn；不是flag运行失败。交Luna仅补测试fixture路径后重跑，同组日志sol-managed-ax-contract-test.log保留。

117c9cc 四文件冻结复核：新persistent fixture补显式process.execPath后，Sol同组56/56实际通过exit0，首失败日志保留、复验日志sol-managed-ax-contract-retest.log。ManagedBrowserHost仅加force-renderer-accessibility于原自有profile spawn，不改个人浏览器、DOM信任或输入守卫；click_element合同明确DOM/UIA边界、<=180字符，完整Qwen selftest exit0/networkCalls0。typecheck dist实际包含flag；当前生产正常launch实图/refs门槛由Luna执行中，不以实验override冒产品部署通过。提交仅四指定文件，历史dirty未纳入。

117c9cc真实T1两轮独检：首Run五派发进入Mac mini产品页，seq39配置价格导航审批视觉核验可批准；实际FD0指向zsh heredoc临时文件、PTY仅在FD1/2，y回显未交readline，正常取消seq41。修模板后第二Run FD0=/dev/tty、FD1/2真实PTY；四派发中两动作明确拒绝，既有通用monitor6.05s二次同图直接SIGINT，seq37 cancelled，未盲耗预算。累计main94/risk0，新增两轮8已知usage129998 tokens，A01共84已知usage1226846、10未知usage请求。

第二Run seq14公开hotset仅uia-0e6e51f06e45-25为Mac mini 新款；dom-0e6e51f06e45-25首次出现于seq16模型响应，并非历史已发DOM引用。故DOM_CLICK_BBOX_MISMATCH不能被当作真实mini布局reflow证据。随后seq24/34仍热集UIA mini；产品零Provider已证raw DOM mini enabled且bbox完整但热集淘汰。source的跨源dedupe直接比较AXLink/link以及带空格/无空格名称，不能当已统一等价；交Luna最小managed可执行候选投影修复，Guard/状态/toolbar真实性保留，下一真实请求须先新修复独检。

候选投影首草稿独检拒绝：Sol实际driver+selector277项，272通过、5失败（sol-dom-projection-targeted.log）。adapter merge直接删public UIA alias使原DOM CDP、partial/ambiguous零fallback、editable DOM/UIA及Mac CSS→PNG by UIA测试拿不到原refs，属于层次合同回归，不能更改旧期待掩盖。作者撤回adapter草稿，转Runtime hotset排序/去重，原完整catalog/private refs与Guard保持；此稳定点main94不变，无新增paid。

9a449e20 selector最终独检：adapter草稿撤回后，Sol实际263 driver+17 selector合计280/280 exit0（sol-selector-final-targeted.log）；原5回归保留原期待。仅enabled DOM与UIA content跨源高IoU别名规范化AXLink/link及空白，原其它角色/来源/状态不变；Han边界修复保L/N与原中文grams。实际生产零Provider原Mini CSS框投影与公开bbox一致，live validateClick completed且无输入。新完整T1 Run run-1791655591349-293b16fd-445已挂exactCLI3019直接监控；首843223e4审批fresh PNG对应公开配置页入口，正常批准后fresh24e39289审批图已在配置页，而模型旧图拟点击原购买位置，要求正常拒绝陈旧动作，不把posted或旧屏幕当当前授权。

新T1失败名称二分：Sol使用冻结9a449生产dist的buildManagedDomClickExpression，输入seq57真实完整M6 label、完全同frame、生产domCandidateFingerprint，仅validateOnly纯VM复现DOM_CLICK_BBOX_MISMATCH（A01-private/sol-real-label-expression-repro.json）。target.name的NFKC将3个全角逗号转ASCII，但live nameOf返回原全角name，roleMatches直接相等因此为空。此补证是L1表达式复现，正常live字段及修复后真正输入仍待Luna验证；不能把同frame错误归因几何改变。

名称修复末版独检：候选name比较单行复用既有normalize(...,160)，真实115字M6固定fixture经正式collector/fingerprint/表达式validateOnly闭环，错名、5px移框、重复候选仍拒绝/歧义，无点击；Sol完整host46+selector17合计63/63 exit0（sol-name-normalization-final.log）。同一生产dist表达式/实际label/同frame纯VM前后证据由DOM_CLICK_BBOX_MISMATCH变为completed/no input（sol-real-label-expression-fixed.json），仅L1表达式复现，不替代正常现场输入成功。

1cec2ea3现场与路径独核：实际4a9a95a0 readonly proof raw/public radio各1，真实完整name，CSS797/431/328/143与public1041.413/676.723/428.587/186.817，当前tab/generation匹配，最终DOM_CLICK_OCCLUDED而非completed；证明名字/指纹/frame唯一匹配已过后原hit-test拒绝。Sol git show 9a449旧源码确认validateOnly专有clip/elementFromPoint与非editable正常element.click的既有差异，当前一行补丁没有删守卫。纯VM已通过与现场occluded分别留证，下一真实完整任务必须自行执行。


2026-10-11 A01最后完整T1独检：`run-1791657013535-e2460d0f-9f1`运行层succeeded及模型success与业务完成分开。真实轨迹明确iMac未访问、Air配置未知、Mini 256GB来自推断，故完整卡未通过。正常审批只核当前动作/截图、不教模型分步任务；PR23隔离评测器消费实际初末证据后inconclusive/success=false、五维null/human_review_missing及5个action_observation_mismatch，未伪造评分。A01最终120/0，A02独立60/6/66有界续接，首入口0HTTP身份拒绝已精确定位guard对较小cap错误等值约束；正在最小修复，原上限/历史不变。


## 2026-10-11 PR23 精确审批链独立复核

Sol只读审查Luna在隔离PR23工作区的两个文件，并独立运行157/157测试及diffcheck。发现并修复的边界包括：execution字段与proposal不同、已批准action/call被后续请求复用，以及把execution改成wait或fresh basedOn绕过原陈旧观察条件。最终关联审批检查独立于普通wait/current规则，完整合成review的click/type成功正例与字段变体拒绝均通过。冻结 `cb6aacf`，依赖draft [PR27](https://github.com/wszkxlllll/Computer-Harness/pull/27)，不升级PR26业务成果。真实A01评测仍inconclusive/false；独立T1缺iMac和配置证据结论不由human_review_missing替代。

2026-10-11 平台合同独检：冻结 `a8dad6d`，独立四套件491/491、diffcheck0；作者typecheck/build0。平台仅来自版本匹配driver health报告，未知省略，未以Host操作系统推断。Mac CMD/META+A select-all batching、其它/未知CTRL+A旧合同均有回归，未重写keys或改Guard。独立生产compiler→Qwen strict_json/native_tools出站完整21工具验证macOS提示及严格effect schema，0物理fetch/0GUI；这是合成合同证据，真实T3网页复测与完整跨应用成果另记。

2026-10-11 正常同名preview独检：Sol读取c188084a私有proof并独立view两个原PNG，红/蓝自有同标题Chrome分别可辨；四图SHA/IHDR尺寸/viewport/0600逐项符合，计数48及Run集合前后不变。正常刷新旧candidate/target+preview均409 STALE，缺错previewToken create409 REQUIRED且零Run，两自有窗均关闭后的两个candidate409 UNAVAILABLE。先前字段误读、CDP准备清理缺口及单窗顺序误配200均保留，未当产品失败或隐去；清理缺口已确认自有进程退出。签收上述真实否定链，完整竞态/身份复用/审批断线矩阵另验。


2026-10-11 精确审批独检：实际读私有command proof与原trajectory，确认同commandId accepted→duplicate applied→receipt applied，action e291f88c仅seq30一次execution.completed；第二pending无批准，seq43 cancelled。fresh PNG此前已独立核可正常公开导航；review预算耗尽fallback单列，不作风险分类一致结论。正常监控244.94s terminal、cancelSent=false。SSE429不能记重连通过；只读server源码发现登记terminate、dispose删除dispose，引用不一致导致device集合残留，已要求最小修与零Provider实际连接反例。已退出的自有无限SSE reader与产品清理缺陷分别记录。A02实际55main/2risk，A01+A02累计177请求、163已知usage2903563tokens，其余14usage未知。


2026-10-11 SSE修复独检：冻结b08268c，仅server.ts清理删除引用与server.test.ts回归两文件。Sol完整server.test独立7/7 exit0（A02-private/sol-sse-slot-server-test.log）；作者typecheck通过。真实loopback A三条200/第四429，B仍200；cancel/abort后三个subscription各close一次、A重新200；Host关闭剩余两个，总close五次，幂等保护保持。正常生产Host重启与同版pair/SSE补证继续，离线listen测试不冒实际controller矩阵通过。


2026-10-11 修后真实控制独检：实际读取sse-slot-live-after-fix-proof与reject原轨迹，正常新Host15334串行五次200/并发三条200第四429/关闭后恢复200；脚本自身零Provider但背景Run有调用，未以计数前后不同误记脚本调用。exact rejected action started/completed都0，正常abort终态cancelled；monitor22.27s见终态。SSE after-seq终态尾事件正在单独复核。A02稳定58main/3risk、A01+A02共181请求；166已知usage2942913tokens、15未知。


SSE终态独检补齐：读取完整after-seq proof，HTTP200的1–28终态、29–31尾事件、after31空尾与snapshot31一致。独立实际读A03 limits12/3/15、reserve8/2/10、actual0/sequence0、0600；A02仍58/3/61。允许正常切换受控Host并继续未覆盖correct矩阵，未重新初始化A02或修改原cap。


A03真实纠正独检：实际读proof与原trajectory，correct清pending后fresh-sequence旧request approve409 STALE_REQUEST；旧action无任何execution started/completed。正常abort终态cancelled，monitor24.29s见终态。A03 2main/1risk，三份usage39297；总184请求、169已知usage2982210、15未知。签收纠正失效与取消，不作恢复后完整业务/手机通过。


2026-10-11 onclick最小修独检：全文核bdf6e7a两文件，实际336/336及最终fixture47/47通过，diffcheck0。真实onclick函数与generic fallback/name在collector和pre-dispatch对称，纯cursor/非函数/handler移除、错name/几何、嵌套同帧歧义/native或ARIA disabled均拒绝/不可执行，未泛化所有li。实际读取ab2c3d4a零Provider完整proof并view after-selection原PNG，出发上海虹桥保留、原建议消失且到达面板打开；正常DOM ref click确有变化，不是直接handler/state写。正式DeterministicGroundingSelector消费同一after-type catalog和原完整T3 goal，187→16且合法generic DOM ref唯一在hotset，私有sol-onclick-real-frame-hotset-proof.json。全部诊断不计T3成果，原生保存仍待candidate TCC。


2026-10-11 A04真实T3独检：修后CMD+A与onclick建议真实执行成立；两次缺elementRef与复用过期ref均被严格拒绝，未发现需要继续放宽或加提示的合同缺陷。正常abort后seq100 cancelled，12main/0risk；未通过完整业务。下一完整T1采用同版现Host与原卡、正式续预占80/4/84，直接监控额外覆盖两次非法参数/ref无action进展，实际历史seq60/64回放可取消、有效读取/动作反例不误停。bdf6e7a当前远端匹配且五CI全绿。


A04 T1 low独检：真实配置页导航/滚动有正例，但仅Mac mini，Air/iMac未访问；灰显配置选项不能以模型推断当已选中配置。两轮only-call反馈在实际91/98/100请求trace selected/projected均保留，darwin来源可靠；最终拆为单hotkey pending106的恢复与abort竞争事实保留，Runtime108 cancelled。10main+1risk，A04累计22/1/23。完整T1失败独立于原生TCC；先补非重复真实控制/preview反例，再唯一high完整原卡新变量，范围与出口不降标。


2026-10-11 preview生命周期真实补证：A04正常Host/API、自有同标题纯色窗，并发preview实际200/409 WINDOW_PREVIEW_BUSY；client AbortError后首重试409 BUSY、第二次200恢复。refresh与in-flight真实命中409 WINDOW_TARGET_STALE；有效preview自然两分钟过期后create409 WINDOW_PREVIEW_REQUIRED且无Run/Provider。Sol核三张PNG0600/1568×1181并view原图，计数22/1/23与Run集合前后相同、cleanupErrors=[]。自有Node超时timer未立即退出后精确SIGTERM并确认退出，Chrome资源已正常关闭，正常Host/stock未动。proof `A04-private/window-preview-lifecycle/window-preview-lifecycle-a1f1f103-a04a-4560-9a80-396dbfa6e5e0.json`。same_title_replacement测试先refresh且proof已过期，其脚本assertion标签虽为identity，仅计refresh stale；真实同CGID复用、畸形PNG仍只L1，未冒完整preview出口。
## 2026-10-11 Chrome 地址栏焦点归因（修复进行中）

Sol独立核high T1 seq149的CMD+L回执与注册PNG：URL确实蓝选；随后两次type均被拒绝，零输入。因此没有把这条新失败归为模型规划失败。零Provider正常ManagedBrowserHost/stock SDK对照使用自有精确PID/window，CMD+L前后身份及surface一致，CDP document.hasFocus从true变false、activeElement仍BODY，DOM complete且无focused候选；原生get_window_state显式elements_complete=false，结构没有focused/editable证明，UIA只能partial。内容框存在，故第一false条件明确是readBrowserChromeFocus的complete要求，其后focused候选也为0。自有资源正常清理，零Provider、零业务正文输入。私有证据为A04-private/t1-high-focus-probe-be1b882a-e3ad-4865-9bd2-bb9b9806fd0f.json及544f1a12对照。

固定d114原生get_window_state.rs明确保留elements_complete=false：结构仅投影actionable节点，AX子读取未知不能证明完整域；AXNode/输出亦未携带focused/editable。TS却要求完整UIA、唯一聚焦地址栏及对应指纹，属于生产能力与消费合同缺口。保持其fail-closed，不将catalog标完整或仅凭图/DOM无焦点放行。Luna正在最小实现独立、精确窗口绑定的原生focus_proof及TS严格消费；SDK现有callTool structuredJson可透传，无需另造产品入口。尚未签收修复或真实地址栏type成功，新candidate实际运行仍需正常OS权限。

## 2026-10-11 焦点修复独检完成

产品282d528、native focus-only 0cfb382通过静态安全复核：proof要求snapshot与响应相同、精确PID/window/AX元素PID与ancestry、前台/AXFocusedWindow、真实enabled和AXValue settable、完整包含screen-point几何，并CFEqual重读同一焦点元素及身份/几何；TS仅可靠darwin接受，保留可信内容框/地址栏语义、DOM同tab/generation与无focused验证。proof不加入公开catalog，旧complete路径、one-shot和live fingerprint不变，Guard不变。作者与检查者仍分离。

Sol独立Computer284+SDK14=298项通过；native完整lib347通过/2 ignored，fmtcheck、diffcheck0；作者typecheck/check/debug build通过。新负例覆盖错snapshot/身份/前台/几何/坐标域/内容区、缺编辑/聚焦/ancestry、DOM冲突、未知/非Mac平台及live变化；one-shot复用零type。两repo补丁在clean d114重放后与构建三源文件逐字节相同。独立验签确认候选独立bundleID及SHA4f3f99d9…/CDHash91531a0d…，stock未替换，候选未执行。先临时stock bundleID包装已在执行前纠正，不构成权限复用。

本签收仅源码/离线测试与候选构建。stock原生没有新增proof，候选真实capture/focus仍需正常两项TCC授权；完整T1/T2/T3及三轮没有通过。正常controller同Run暂停零派发、纠正恢复、SSE与preview局部实证单列，未冒实体手机/真人评分。全部请求对账228物理/210已知usage/18未知，费用金额未知。


2026-10-11 本机权限UI状态补记：Sol已核脱敏AX记录/服务和计数投影；GUI挑战为操作者实证，未另抢桌面。操作者正常进入System Settings两项隐私权限并点击“添加”，二者均触发Touch ID/密码挑战；前两次取消，当前录屏与系统录音挑战留在屏幕供用户本人完成。未输入凭据、候选未选择/启用、权限未改；没有保存截图，脱敏AX结果记录于私有 `A04-private/system-settings-tcc-ui-attempt-20261011.json`。此前“未执行候选/授权待用户”的当前状态应解读为权限尚未获批，而非没有尝试正常UI。上一交付head e0923b6（产品源282d528）五项CI全绿；新文档head尚未核CI。


## 2026-10-11 候选真实验真及sheet生命周期最小修复放行

Sol已独立读取候选注册PNG/metadata、真实SDK输入guard结果及三条T2 trajectory；录屏与辅助功能已通过正常UI实际启用，candidate截图/地址栏焦点proof/一次输入及拒绝反例通过。完整T2仍未保存、关重开；首Run私有monitor误判已修并真实轨迹回放，错误target模板已单来源化，后续正确fresh Run按两次无进展取消。当前A04 60main/2risk/62，历史246；无paid在途。

已放行Luna最小补充版本化AXSheet→AXParent独立关系证明并接既有SurfaceRegistry push/pop：必须真实验证直接AXChildren唯一sheet、AXParent CFEqual、父子SPI/AX/WindowServer identity与几何、当前前台/焦点、当前父baseline和已授权switchWindows。仅成功完整directchildren读取可给checked-none并pop；错误、身份变化、多个sheet、无关系或非当前父均unknown/manual，旧refs按既有generation失效。不得以samePID、新出现、标题或伪完整inventory自动授权，不将Mac附件关系冒充Win32 foreground字段。先定向安全回归及真实0Provider parent→sheet→parent，再冻结和完整原卡；停止无修复paid重复。


2026-10-11 attached-sheet离线冻结独检：Sol集中只读核原生checked AXChildren（成功空数组与读取失败分开）、直接SPI父子ID、AXParent CFEqual、父子AX/WindowServer几何及尾读前台/焦点。TS使用真实Mac partial库存的baseline差分，只将唯一新窗与精确关系证明匹配，仍保留complete=false；既有push/pop、旧refs失效、unknown保持及Runtime/Trajectory admission source限制一致。独立session8006执行tsc-b及Computer/Surface/Runtime/Trajectory/Protocol相关28文件837测试全部通过；作者session3723同范围通过，native新增专用表1/1通过（未重复旧完整baseline）。当前源码冻结可进入可复现第三patch、候选构建及真实0Provider parent→sheet→parent；此签收不代表生命周期或完整T2业务通过，历史请求仍246、无新增paid。


2026-10-11 Sol独立真实生命周期签收：Luna暂停全部GUI后由Sol唯一接管。正确公开SDK合同在新空白16174首次遇实际sheet动画inventory y330/proof y352，严格拒绝，未手动handoff或代保存。Luna仅TS增加一次身份/关系/焦点全部已过且仅几何变化的80ms只读重采；同PID/CGID/parent、唯一候选、非截断、全严格几何不变，二次仍不稳/换ID/多窗拒绝。Sol独立Computer291通过及最终真实377×218帧4例通过。真实b06d1024生命周期自动push至16187、精确sheet截图754×436、ESC实际派发子窗、checked-none自动pop父generation3；旧child观察拒绝，native输入数2→2，cleanup=[]，零Provider。桌面随后交回唯一Luna执行A05完整T2，Sol停止GUI。当前blank无业务文字、无保存文件；此局部验真不关闭完整T2。


## 2026-10-11 A05独立复核及副作用语义更正

冻结da0fedf已非force原SHA同步PR26，五项CI全绿（38117633419）。A05首入口host.env误传目录导致EISDIR、无Run/HTTP，私有模板改为文件断言后正常真实TTY启动原196B完整卡。Run `run-1791699527821-1f9f981c-af1` target22394/16174，40请求上限，实际10main/0risk、8GUI动作，cancelled/CLI exit0。正文精确六行图已独立核对，CMD+S后自动child_push至Save，证明修复实际入口生效；CMD+SHIFT+G完成后路径type报type_text_incomplete 0/169，监控于连续同Save图阈值SIGINT，第10请求取消。文件不存在，未完成保存/关闭/重开，不签收完整T2。9份已知usage prompt169811/completion1888/total171699；A05实际10/0/10、cap120/6/126、预占40/2/42，全部历史250main/6risk/256，234已知usage4415027tokens、22未知、金额未知。

fresh只读证据（A04-private/t2-focused-ax-deep-read-v2.json及t2-panel-service-sdk-read.json）：focused AXTextField enabled/focused、AXValue settable，AXWindow属性unsupported，SPI16204；AXParent为AXSplitGroup(SPI16204)→AXSheet(SPI16203)，Save父文稿16174。CG16204真实owner22422 Open and Save Panel Service，当前onscreen=false；独立SDK状态ax_unresolved，不能据名称/owner建议当可输入surface。现exact_target会沿父链将此field归Save16203；foreground type实际向22394调用SLEventPostToPid/void fallback，再AX readback Unchanged生成delivered0，不能证明事件未发或实际无副作用。Runtime原summary unknownSideEffects=none_recorded如实保留，仅表示未记录，不是无副作用证明；未知路径不自动重放。继续新自有空白、零Provider核活跃GoTo关系/实际输入owner与capture，必要严谨修复，停止同版paid。候选两项权限已授予，不再列当前TCC阻塞。


当前关系语义补正：上述focused TextField/AXSplitGroup→Save链可能只是普通Save的内嵌remote内容，不证明新GoTo层。field位于Save顶部、AXValue长度8，模型原轨迹亦明确CMD+SHIFT+G未见弹窗；后续正常精确Save ESC一次completed且旧Save目标not found。继续新空白前后对照，不能为未证GoTo伪造独立surface或自动接管。


2026-10-11 Sol独立shortcut二分与正式续额：Luna暂停无在途后桌面互斥交Sol，0Provider复用正常SDK精确Save16228。生产CMD+SHIFT+G completed但PNG前后同SHA c6562f6885739703073ebfc34a6a29dffe1359be190dcf72502c71887f95df21，AXFocusedWindow/field不变；仅此后一次正常System Events shortcut作诊断，产生真正同PID onscreen AXSheet16235，Save direct AXChildren新增该sheet、focus16235。精确920×558 PNG仅GoTo本身，Sol及root分别view；普通Save remote AXSplitGroup16229非GoTo，不以跨进程名字/库存猜owner。证据`A04-private/sol-save-route-compare-63f7b8bb-b893-4091-93f1-413eb2e5bac6.json`；GoTo正常精确ESC回Save，Save再正常精确ESC回空白父16222，cleanup均[]，未写路径或保存。Sol停止GUI并明确交回Luna。当前根因是生产foreground无element hotkey使用NSMenu PID no-auth路线未产生可见效果，正常HID有效；真正GoTo属于Save直接AXSheet子窗，现producer只允许AXWindow parent。Luna实施最小strict exact-focus HID及AXSheet parent关系修复，Guard/unknown不重放保持，不新增cross-process surface。

A05已通过extendBatchReservation正式续预占80main/4risk/84 revision1，actual10/0/10及sequence10、硬cap120/6/126与全部256历史不变；为修后完整40请求保空间，没有派发新Provider。下次正式任务以真实候选验证通过为条件，不以续额当修复通过。


2026-10-11 独立评测器新轨迹消费：Sol在隔离PR27/cb6aacf使用既有T2 manifest消费A05真实run-1791699527821-1f9f981c-af1，CLI exit0、verdict=inconclusive/success=false，唯一deficiency=human_review_missing；初末真实PNG锚点bound，无新增Mac admissionSource或动作关联误报。产物忽略目录pr23-real-evidence/t2-a05-nested-shortcut-failure-assessment.json。未填写真人评分或制造success；指定成果文件不存在/保存关闭重开未成的业务失败独立保留，不能由缺人审掩盖。零Provider。


2026-10-11 嵌套Save→GoTo消费链离线独检：Sol对冻结TS最小改动运行Computer/Surface/窗口合同、Runtime、Trajectory相关20文件721/721，全仓typecheck退出0，四产品文件diffcheck无误；源码hash记录于私有A04-private/sol-nested-ts-independent-review.json。degraded元素catalog不升级complete，关系仅用独立snapshot精确绑定；完成动作的fresh baseline/唯一新库存/当前精确parent/直接AXSheet proof满足才自动push，pop仍需明确checked-none及精确父focus，旧Save/GoTo/root代际拒绝保持。Luna当前native完整lib349通过/2 ignored、fmt退出0，check/build及真实candidate生命周期尚待本轮完成，不继承旧native测试或将离线通过算完整业务通过。

私有直接取消监控只将已completed当前动作的真实macos_attached_sheet_proof child_push/pop及精确父子lineage作为surface进度；移除凭Save标题新窗重置。四零Provider回放通过：严格nested重置，title-only/Duplicate、未completed transition、重复no-input拒绝均继续取消；产物A04-private/sol-monitor-nested-transition-replay.json。无GUI/模型请求，全部历史仍256；旧type派发未知副作用不重放。


2026-10-11 nested/HID候选冻结与正常权限恢复：Luna当前native完整lib349 passed/2 ignored，fmt/check/build全部exit0；Sol相关20文件721/typecheck/diffcheck、clean d114依次三patch check/apply与四源文件逐字节匹配通过。第三patch SHA2e624c66251e1c2785fe43a452556ac73b7b29b76ddc725af37ee2ee1b8d432e；raw binary5a55c3b8a1b82d517fa455fab6487b137bd495c95627b405ec1f698753995bf3。新版独立candidate strict签名通过，signed SHA514de6e702c2c7449745b5a54d65f313742e307eaed12e239869137ac808b5e4、CDHash3965f1dee19cfab49ba2036ce767e53ea07e4cef、PID32348/socket a05-capturefix-nested；旧完整app回退SHA3d3c…保留，stock4254原样。

新CDHash真实health报录屏与辅助功能均not granted；不以旧on当当前授权。Luna正常Settings UI已移除旧录屏项、普通picker精确重添新候选，新行on且重启提示选择“以后”；辅助功能移除精确旧项时出现“隐私与安全性正在尝试解锁系统设置，使用触控ID或输入密码”真实原生挑战。当前挑战保留、未输入凭据、未移除/重添Accessibility，没有其它GUI/模型请求；root已请求用户本人认证。候选不再重包/变更CDHash。验证后正常重添辅助功能并统一重启，再health与零Provider真实nested/type/guard验真；本轮离线修复不能当完整T2通过。所有Run终态、实际请求256及A05 actual10/0/10/正式预占80/4/84 revision1不变。

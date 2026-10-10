# Sol 独立检查记录

本轮协调/检查由 Sol 承担，Luna 为唯一产品源码及现场执行者；检查未操作 GUI、请求模型、重启服务或修改业务源码。因并发槽已被已完成历史代理占用，单独 Sol 检查代理创建失败，作者与检查者仍分离。

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

# 当前阶段交付与集中补验包

2026-10-11 当前阶段（覆盖下方历史稳定点）：项目仅负责macOS电脑端、Web/Relay与手机客户端。平台CMD/META及onclick建议采集修复取得真实正例；完整T1三产品、T2指定196B保存关闭重开、T3三车次与跨应用纠正均未通过，三轮出口不降标。唯一high T1正确CMD+L后暴露原生焦点证明缺口；产品282d528的独立focus_proof与TS严格消费已完成离线修复，catalog仍partial、不凭截图或DOM失焦放行。Sol独立TS298项、原生347项/2 ignored及fmtcheck通过，作者typecheck/native check/debug build通过；组合CaptureFix候选尚未启动或安装；已在System Settings正常UI分别点击Screen & System Audio Recording与Accessibility的“添加”，两项均在文件选择器前要求Touch ID/密码认证，前两次已取消且未选中/启用候选；当前Screen & System Audio Recording原生认证挑战留给用户本人完成。上一交付head e0923b6（产品源282d528）五项CI全绿；本次文档head的CI尚未核。stock无法验证新增proof，真实修复成功尚未签收。

正常认证controller同Run已证paused后零新派发、correct投影、resume与最终纠正标记；精确批准去重/reject零执行/旧approval失效/SSE重连及同名preview并发、取消恢复、自然过期否定链通过，仍分列API协议、Web按钮与实体手机。A01–A04累计222main/6risk/228物理请求，210已知usage共3955751tokens、18请求usage未知、金额未知；A04 actual42/2/44、cap96/6/102、reserve80/4/84。隔离评估器cb6aacf/PR27经Sol157项独检，真实false-success重评仍inconclusive/false，业务缺项与真人评分缺失独立保留。当前源码/CI及服务事实以PR26、执行看板和账本为准。

以下1866/72、main3及锁屏结论属于10月10日历史交付稳定点，不能作为当前进程、调用或阻塞状态。

本包配合[执行计划](./astra-autonomous-test-repair-plan-2026-10-10.md)和[实际账本](./astra-autonomous-execution-ledger-2026-10-10.md)。它是尚未关闭出口的续接说明，不代表完整任务或实体手机已通过。产品源码/build冻结17ec145；测试修复a491076当前五项CI全绿，后续仅文档；PR24两处最小UI增量经Sol独立40项通过；Luna最终组合1866项Vitest/72项TAP、typecheck/Webbuild通过。

## 10月10日历史成果及限制（当前结论见顶部）

- 已保留历史dirty；本轮5个显式产品/计数提交及1个测试修复提交、最终组合1866项Vitest和72项TAP通过；当前PR23隔离head136项通过。
- 正常本机配对批准、Web Run创建、stock原生窗口截图成立。后续专用headless Chrome独立admin/client contexts正常UI配对批准、刷新去重、无效码及390px视口通过；公网两独立HTTP会话配对/认证/CSRF/隔离撤销通过。均不冒Provider/Computer业务或真实手机。
- A01 main3/risk0：一次90s未收到headers，两次正常CLI HTTP200；唯一GUI click遭driver明确拒绝，无正文输入/保存，完整196B任务未完成。三次foreground尝试均在模型前拒绝，不增加调用。费用金额未知。
- 历史console session锁定曾经两个独立只读路径确认；用户现已解锁，原生新候选权限另列。Mac无已交付成果文件。Windows/Linux实现与 CI 历史保留，不属于本项目责任或当前出口。
- 控制/预览302项是L1合同，PR23两条真实失败消费保持inconclusive/false。正常报告导入保留runtime failed与business not_assessed，未制造真人复核。

## 本机正常续接

实际工作树：`/Users/guoyuhang/Desktop/大创/Computer-Harness-three-track-integration`。原主checkout的私有.env仅本地加载，不能上传或复制到PR。stock driver固定0.22.2，SHA-256 `82280013239871397bf57baf133271413640b3bba8a51661a841e5f2bc50219c`；不是PATH中旧0.20。使用现有私有socket前确认原服务归属/无在途；进程退出后才重新启动。

构建入口：`pnpm run typecheck`、`pnpm test`、`pnpm --filter @computer-harness/web build`。正常Host启动参数保持`--env-file <本地私有env>`、`--socket <实际stock socket>`、`--model glm-5.3-flash`、`--output <本轮私有Run目录>`、`--port 4317 --origin http://localhost:4317`。实际Host管理地址为`http://localhost:4317/connect`。端口/Origin必须严格一致；不要把localhost配对URL当手机可达URL。

自主付费入口继续同一`scripts/autonomous/batch-host.mjs`。A01-private最终120/0已冻结，不能重新初始化或再派发；当前使用独立A04-private，cap96/6/102、revision1预占80/4/84，actual42/2/44；A02、A03也已结束且历史保持。完整mainenv与overlay分开加载、绝对batch root和真实TTY命令已持久保存，后续只替换任务/目标/必要参数；续额保留actual/sequence与历史链。CLI正常foreground使用公开`--window-switch`，不加managed browser URL则不引入profile准备。历史GLM timeout180000ms与low是有记录的每Run调优；当前正常受控Host已恢复90s low，默认90s保持；low/high均已进入后续真实请求，时延只作本轮观察，不宣称稳定性能改善。

完整本地任务卡在忽略目录`runs/astra-autonomous-20261010-sol-luna/task-cards/`，T1/T2/T3均各baseline、independent-repeat、variant。T2正文196B/UTF-8/LF/finalLF，三卡唯一新路径；文件存在则重新准备唯一卡，不能覆盖。T3已冻结路线/日期/2成人二等座/三结果与客户端预算降低节点，未开放票价须写未知，不能捏造携程结果。关闭重开由Harness完成，人工重绑只列补证。

## 当前组合候选与最小恢复动作

焦点修复产品提交为`282d5288312bc1f55ad2b3129a074b5b3574f46f`，原生focus-only源码提交为`0cfb382c183c7f6981c2402be0d8ff734c47d360`。两个独立补丁均在repo `patches/cua-driver/`，对clean d114按capture→focus应用重放后的三个源文件与构建输入逐字节一致；原stock保持0.22.2。详情见[F071焦点修复](./a-line-sync/fixes/F-20261011-071-macos-browser-focus-proof.md)。

组合候选为`/Users/guoyuhang/Desktop/大创/Computer-Harness-three-track-integration/.tools/cua-driver/CuaDriverCaptureFix.app`，显示名`Capture and Focus Fix Local Candidate`，独立bundleID `com.trycua.driver.capturefix.local.20261011`；signed binary SHA-256 `4f3f99d9ef6c91da9203ca202e70a2b2cc5682b784dd5d92921bcf5fbc414ebc`，CDHash `91531a0d8e6c8a68c6173c7d7a5da7d2811746c7`。Sol独立strict验签通过，未启动、未安装或改TCC。

已实际在“系统设置→隐私与安全性”分别进入“录屏与系统录音”和“辅助功能”并点击“添加”；两个正常流程都先要求Touch ID/密码，文件选择器未打开，候选未选择/启用且权限未改变。当前录屏与系统录音的原生认证挑战留给用户本人完成；无需手机操作。用户完成原生认证后，由智能体在文件选择器中选择精确候选app，分别启用并核实两项权限，再正常启动候选；先零Provider核精确sheet捕获/比例与地址栏focus_proof，再继续完整原卡及独立复验/变体，不能把离线测试算作真实T1/T2/T3通过。stock无新proof仍拒绝地址栏type，保护保持有效。

low Host20858已正常停止，4317无listener；停止前首页、local session与认证Run列表均200，Run列表0/无活动Run。stock PID4254及原socket `/private/tmp/a01-cua-luna.sock` 保留；旧high Host18761已退出，历史终态轨迹保留。当前Computer dist SHA256 `9fc76ac695cb8aad89d847adcb34e07ab58409c8c660f8490e80c7fdca291a1a`，Host entry及Web bundle与上次构建相同；不据文件hash推断整个进程缓存。自有reader、probe、caffeinate已关闭，stock与专用TextEdit证据现场保留；不动未知个人窗口。正常新配对凭据只在私有0600文件，公开包没有token。

## 手机集中补验（手机可用且同版电脑任务出口通过后）

1. 电脑正常Host/Relay健康后，在正常管理页生成新配对挑战；手机相机扫码或用同一备用链接打开，电脑正常批准。不得复用公开文档中的旧token；本包不保存token。
2. 手机上提交电脑已验证的完整T2卡，观察任务进度、截图和文件成果；正文如下，末行后恰好一个LF。唯一保存路径由当前卡给出。

```text
中文出行清单
日期：2026年10月4日
预算：9000元（最多3人）。
1. 携带身份证、充电器与雨伞。
2. 09:30集合，10:15出发。
备注：只保存本地，不发送。
```

3. 用正常手机按钮完成一次批准、一次拒绝、暂停恢复、取消与纠正；批准重复触摸只应执行一次，取消/纠正后旧请求应失效。选项审批必须同时看当前图与标为“尚未执行”的参数；隐去项不得当已确认内容。完整控制任务由电脑预先准备，不借真实付款/发信/删除验证机制。
4. 手机后台/锁屏再恢复、刷新；Wi-Fi与蜂窝切换；另同时关闭两者至少12秒再恢复。检查不重复创建Run/重放动作，状态和当前请求恢复正确。只操作测试客户端，不重置电脑整机网络。
5. 核手机尺寸、触摸目标、滚动及截图。若本轮没有改语音，不额外扩张麦克风/播报验收。失败只需提供屏幕错误文字、发生步骤及对应Run ID；无需发送token、Cookie或完整私有轨迹。

M1相机/移动浏览器、M2真实触摸、M3后台/真实手机网络、M4尺寸体验分别留栏。另一位参与者独立试用是一项单独人类条件。

## 回退与证据

当前产品提交可独立审查，原b1e44e1与历史dirty快照保持。回退服务需先取消确认归属的自有Run、核未知副作用、停止自有Host后再切匹配构建；不能对当前含历史dirty树直接reset/clean。私有截图/轨迹/计数位于忽略runs目录，不纳入PR。PR23继续隔离，不将pending/缺真人审核变为success。

## 10月10日历史候选构建与PR取舍

产品源码17ec145a57f742b8e65d4f6c5b368f9777b5aae0；本机476项dist实际闭包SHA-256 `f17dd74bad35aea6286f16e083f277f6a5e5a1978a8420104e0f228b9c991c0d`，manifest在本地baseline/runtime-build-manifest-17ec145.json。正常Host PID87588于18:38:43启动（现已正常退出；显式既有Relay配置的新Host89224通过公网HTTP配对E2E，无在途Run），源码内容与随后17ec145提交相同；entry hash `07b2c43a961c81ca0b3cc47adfd973bdfcba44c5c148df2bc751ee90a3096fd5`。Web bundle index-BxSWOU01.js hash `7df7b87809af3262ce48b0f55c2619b923c001ad74103e5d19312dad24c29d99`。完整闭包不等于每个文件已加载进该PID，未通过inspector读取模块缓存。

| 实时PR差异 | 当前取舍及证据 | 剩余边界 |
| --- | --- | --- |
| PR22 Host session-config拆分 | 现有Host createSessionConfig已连接输入/输出预算、timeout/thinking、layered Guard/handoff；glm-output-budget测试与真实180000/low启动摘要成立 | 不为纯模块拆分追整树；正常配对UI已补证；真实Runtime任务控制继续补验，旧锁屏不再是当前条件 |
| PR22 Windows visible-window-capture扩展（历史兼容实现） | 当前window-contract精确PID/HWND、零几何容差verify_state、PNG解析、共享deadline捕获重试、输入前新鲜visible inventory已有；全suite该driver文件262项通过 | 保留源码与 CI；Windows 原生修复及现场不属于本项目责任 |
| PR22 post-input-observation-settler | 当前RunController完成receipt后立即observeAndCommit，新鲜观察及有界transient重取已有 | 没有全动作稳定settler；无真实flaky症状前不加另一层等待，不宣称稳定性能 |
| PR24预算/网络/终态 | 当前双预算保最新GUI/权威输入、pre-HTTP拒绝、相关request/decision/attempt交换、bounded deadline/取消，以及Runtime诚实failed均保留；当前组合全通过 | 完整查询/保存任务仍无现场通过，历史CI不相加 |
| PR24 select_option/失败提示 | 已最小恢复17ec145；可信绑定选项显隐与真实状态40项独检 | 仅参数/证据预览，不代实际操作安全或结果；不改变Guard |
| PR24独立macos-target-topology | 精确identity/geometry注册capture、SurfaceRegistry generation/parent与transient/handoff保护已融合；不整文件覆盖当前更广实现 | 外部owned-window关系probe实际是Win32。Mac没有同等自动owned-sheet拓扑证明，新弹窗走handoff/unknown，不能列自动验收；现有AXSheet→AXParent实际关系补证尚未产品化，原生候选TCC待授权 |
| PR23评测器 | 隔离1f57852，136项独检；两条实际失败inconclusive/false；正常报告API导入失败保持failed/not_assessed | 无D01真实成功成果、评分校准或真人复核；不合并进产品冒成果 |

当前整合分支相对main包含此前已提交产品改动与diagnostics归档；这不是本轮新写234个文件。新源码提交只包含已明确审查的产品/测试/批次计数文件，本轮历史dirty和私有runs未加入。草稿PR只做阶段审查，不宣称本项目范围已完整验收。

## 可复现任务模板（公开PR读者）

模板无账号/令牌或个人绝对路径。实际执行前，用自己的专用输出根目录生成一个尚不存在的绝对路径，把`<唯一新绝对路径>`替换掉；准备专用空白TextEdit文稿。不得用辅助脚本写入正文冒Harness成果。

T2完整任务：逐字输入本页六行正文，UTF-8/LF/末尾恰好一个LF，转纯文本并保存到`<唯一新绝对路径>`；返回正文确认，关闭刚保存文稿，再用应用正常打开功能重开同一文件并核对全部内容。输入、保存、关闭和重开必须由Harness完成，不可确认就如实停止。baseline与independent-repeat使用本页正文及不同唯一文件；variant改为2026年10月5日、8800元/最多2人、08:45集合/09:20出发，其余字节保持，仍196B。

T1完整任务：仅在Apple中国大陆当前公开页查Mac mini、MacBook Air、iMac三个系列最低价标准配置，逐项记录名称/型号、价格/币种、芯片、RAM、存储、是否带显示屏、来源URL与查询时间；预算9000元，全部三项都保留并比较预算约束。未知或不可达如实标注，不登录/下单/支付；variant预算8800元。

T3完整任务：携程公开页比较上海虹桥→杭州东2026年10月17日09:00–13:00出发的三个不同高铁车次，2成人/二等座，记录车次、出发/到达/历时、单价/总价、可售状态、URL/查询时间。票未开放写未知，不捏造。初始预算9000元；在三个来源已取得、首次保存之前用正常客户端纠正为8800元并明确旧预算失效。整理TextEdit纯文本至`<唯一新绝对路径>`，保存关闭重开核全文；variant初8800→8500。每轮全新目标文件，辅助不能代业务步骤。

正常公网Relay协议已补证：两独立合法HTTP会话申请/电脑确认/领取会话全部成功；缺错CSRF403、非法字段Run400、两自有设备独立撤销成立，无Provider/Computer业务。首CI Windows单项retry测试race由a491076最小测试barrier修复，Sol Runtime137项复验通过；该head最新CI五项全绿，首失败保留。


## 10月10日历史交付与保留服务（PID已更替）

草稿[PR26](https://github.com/wszkxlllll/Computer-Harness/pull/26)已附当前聊天；正常Git transport不可达时使用已授权GitHub Git Data API保原SHA同步，非force更新分支，无历史重写。当前生产内容17ec145、测试a491076，[当前代码CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38046814449)五项成功；最终文档head/CI以PR实时记录为准。

保留本轮正常Host PID89224（4317，无在途Run）、stock CUA driver PID83913及专用TextEdit PID22394；自有headless Chrome/profile已关闭，HTTP两设备与UI三设备均正常撤销，旧设备/无关服务未动。PID仅为此稳定点，不代下次接管事实；续接先核进程与在途。

公网当前origin对应Preview服务。实际固定闭包34项中27同/7异：Relay package.json、protocol dist/index.js/package.json、relay-connector dist/routing.js/package.json、voice dist/run-notices.js/package.json。Preview current/父目录/releases/Web dist不可由现有SSH账号写入，sudo无非交互规则、本地无部署workflow/helper；未写远端或改服务。另一个可写stable目录不属于当前origin，未拿它冒同版发布。继续发布需服务所有者提供正常合法发布路径；健康/HTTP配对不等于闭包同版。

当前剩余：T1/T2/T3完整原卡及三轮未通过；stock缺新焦点proof且原生sheet捕获错误，组合候选实际运行需正常屏幕录制/辅助功能授权。T3网页模型参数/旧ref失败独立保留，不归入TCC或手机。Preview同版发布需服务所有者合法发布路径；M1–M4需实体手机；队友试用和评分需另一位真人与真实成果。解锁已完成，无需再次为离线或配对任务解锁；不以局部协议/离线通过替代业务验收。


2026-10-11 历史SSE稳定点：SSE b08268c修复后同版正常Host五次断开恢复/并发cap/after-seq尾事件通过；批准重复commandId只一次执行、reject零执行、correct使旧approval409/零执行、随后cancel均独检。A01–A03累计180main/4risk/184请求，169已知usage2982210tokens、15未知。正常Host15648保留，所有Run终态；继续零Provider建议DOM定位，完整T1/T2/T3及剩余现场矩阵未升级。

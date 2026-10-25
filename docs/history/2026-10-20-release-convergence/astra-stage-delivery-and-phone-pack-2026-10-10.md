# 当前阶段交付与集中补验包

2026-10-12 11:53 本轮修复完成并停止（用户要求本轮完成后停止，最新状态以本段为准）：F089已精确27文件提交并原SHA推送 `e7bce7f7792b455d02212c717a34206412002d14`；来源引用finish默认关闭，可经正常CLI/Host显式配置，Runtime只引用本Run已持久化Observation中的保留grounding并规范渲染结果，未知/推断明确标记。它验证来源与输出绑定一致性，不机械判断SKU语义或事实真值，不计T1业务通过。作者最终452/452，Sol独检239/239与Root独检213/213互补合452；主工作区tsc-b exit0，24源文件与冻结pin全部一致。当前HEAD CI38201158820已由Root于03:52:50Z实际核completed/success，4 verify及ci-required共5job全部success，不继承旧cb93五绿。详见[F089](../2026-10-20-product-docs/a-line-sync/fixes/F-20261012-089-source-linked-finish.md)及[来源引用审查](./astra-source-linked-finish-review-2026-10-12.md)。

本轮未新增真实Provider请求或GUI业务。A07仍actual61main/0risk/61、reserve120/6/126 rev2；累计498actual=490main+8risk、468known合8,600,579tokens、30unknown，金额未知。95b CLI L2 experiment的T2完整基线/独立repeat/原variant三轮限定通过；正常Web首录入1134B而原卡1133B，已取消并保留轨迹/文稿，不算原卡通过。新表单实际AX值曾逐字核1133B/尾1LF，尚未再次Start；不再启动新Web/paid轮。T1业务、T3完整闭环及其复验/变体、真人五维、实体手机/语音与Preview远端部署仍缺，T3只读设计保留，未实施。

收尾资源已核：所有既有Run终态后，自有Host26665与Relay26276逐UID/start/完整argv确认，各一次SIGTERM、ps gone且原PTY均exit0；Root keeper26995已由Root精确停止，不续保活。native98330、stock4254、归属未证debug21139及旧成果/错误路径文件未动。隔离T1工作树保留供审阅。六入口仅同步本地最终状态，不新增提交循环；本轮修复与CI已完成，现停止工作；不再启动任何后续任务。

2026-10-11 当前阶段（覆盖下方历史稳定点）：项目仅负责macOS电脑端、Web/Relay与手机客户端，Windows/Linux不属于责任或完成条件。完整T1三产品、T2指定196B保存关闭重开、T3三车次与跨应用纠正及各三轮均未通过，出口不降标。此前候选经用户两次正常原生认证取得两项权限，真实精确Save截图、地址栏独立focus_proof、一次输入及焦点变化/复用拒绝正反例已签收。此次nested/HID修复重建的新CDHash未继承权限；录屏已通过正常UI精确重添并显示on、待统一重启，辅助功能移除旧项时出现真实Touch ID/登录密码挑战，当前保持该挑战，未输入凭据、未重添或复验。产品edfe800的精确AXSheet/AXParent证明和da0fedf的单次80ms只读动画重采已离线独检；真实零Provider parent→Save自动push→ESC→checked-none自动pop及旧ref零输入拒绝通过。上一发布版本da0fedf已按原SHA非force同步PR26，五项CI全绿（run38117633419），不把历史测试数累计成当前重跑。

正常认证controller同Run暂停零新派发、纠正恢复、精确批准去重/reject/旧approval失效/SSE及同名preview局部实证仍分列API、Web按钮与实体手机。A05原完整T2 run-1791699527821-1f9f981c-af1真实输入196B并自动接管Save；随后CMD+SHIFT+G及路径type未完成，监控取消，指定文件仍不存在。起初误认为GoTo的offscreen remote实为普通Save内容；Sol零Provider对照证实生产PID shortcut无可见效果，正常shortcut生成独立onscreen同PID GoTo AXSheet，strict HID及嵌套直接关系修复已离线通过（Luna native349/2 ignored及fmt/check/build，Sol相关721/typecheck与clean patch重放）；新候选signed SHA514de6e702c2c7449745b5a54d65f313742e307eaed12e239869137ac808b5e4、PID32348，真实nested/type验真待正常权限恢复；type的0/169来自事件派发后AX回读Unchanged，不能证明无副作用，停止paid继续精确定位。累计A01–A05为250main/6risk/256实际请求，234份已知usage合计4415027tokens、22请求usage未知，金额未知；A04冻结60/2/62，A05实际10/0/10、cap120/6/126、正式预占80/4/84 revision1，actual/sequence及原cap不变。隔离PR27/cb6aacf与157项独检、真实false-success业务缺项/真人评分缺失保持。

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

自主付费入口继续同一`scripts/autonomous/batch-host.mjs`。A01-private最终120/0已冻结，不能重新初始化或再派发；当前使用独立A05-private，cap120/6/126、正式预占80/4/84 revision1，actual10/0/10；A04保持cap96/6/102、revision2预占96/6/102、actual60/2/62；A02、A03也已结束且历史保持。完整mainenv与overlay分开加载、绝对batch root和真实TTY命令已持久保存，后续只替换任务/目标/必要参数；续额保留actual/sequence与历史链。CLI正常foreground使用公开`--window-switch`，不加managed browser URL则不引入profile准备。历史GLM timeout180000ms与low是有记录的每Run调优；当前正常受控Host已恢复90s low，默认90s保持；low/high均已进入后续真实请求，时延只作本轮观察，不宣称稳定性能改善。

完整本地任务卡在忽略目录`runs/astra-autonomous-20261010-sol-luna/task-cards/`，T1/T2/T3均各baseline、independent-repeat、variant。T2正文196B/UTF-8/LF/finalLF，三卡唯一新路径；文件存在则重新准备唯一卡，不能覆盖。T3已冻结路线/日期/2成人二等座/三结果与客户端预算降低节点，未开放票价须写未知，不能捏造携程结果。关闭重开由Harness完成，人工重绑只列补证。

## 当前组合候选与最小恢复动作

上一已发布产品`da0fedff3099e13d8bd8c29b4880ed7bdefe4ae9`五项CI全绿（38117633419）；本次nested/HID修复源码以本提交为准，当前head CI另核。capture→focus→attached-sheet三个可复现补丁在repo `patches/cua-driver/`，对clean d114重放已独立逐字节核验。详情见[F071焦点修复](../2026-10-20-product-docs/a-line-sync/fixes/F-20261011-071-macos-browser-focus-proof.md)和[F072生命周期修复](../2026-10-20-product-docs/a-line-sync/fixes/F-20261011-072-macos-attached-sheet-lifecycle.md)。

新版组合候选仍为`.tools/cua-driver/CuaDriverCaptureFix.app`，独立bundleID `com.trycua.driver.capturefix.local.20261011`；signed SHA-256 `514de6e702c2c7449745b5a54d65f313742e307eaed12e239869137ac808b5e4`，CDHash `3965f1dee19cfab49ba2036ce767e53ea07e4cef`。Sol strict验签及clean d114三patch重放/四源文件逐字节核验通过。candidate PID32348/socket `/private/tmp/a05-capturefix-nested-20261011.sock`；新CDHash health首报两项未授权，未发模型请求或输入。旧完整候选回退包保留`/private/tmp/F-20261011-capture-childwindows.DzRfy5/rollback/CuaDriverCaptureFix-before-nested.app`，SHA3d3c783174d6e85da74a53ef9388e9ec12156aca1520fb8911fac1abefcf9f60；stock PID4254/socket `/private/tmp/a01-cua-luna.sock`原样。

正常Settings录屏旧项已移除、精确重添新项on，要求退出后生效时选“以后”；辅助功能移除旧项触发原生Touch ID/登录密码挑战，当前保持供用户认证，未输入凭据、未移除/重添。用户验证后沿正常picker精确重添辅助功能并开启，统一正常重启同一冻结candidate后逐项health确认，再零Provider自动父→Save→GoTo/type AX读回/返回两层及旧ref/错焦点零输入验证；成功才原完整T2基线、复验/变体。不得重新签名、绕TCC或重放旧0/169派发未知动作。A05正式预占80/4/84 revision1、actual10/0及全部256历史保持。完整T1/T2/T3均独立未通过。

low Host20858已停止、4317无listener，stock4254保留，所有模型Run终态，无paid在途。Luna唯一桌面操作者；前轮caffeinate28423已到期，本轮自有caffeinate30511有界1800秒、结束清理。当前服务与构建事实需在每次切版前读取，不能以本页PID永久推定进程状态；私有截图、原生AX与令牌均仅忽略目录0600，不上传PR。

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
| PR24独立macos-target-topology | 精确identity/geometry注册capture、SurfaceRegistry generation/parent与transient/handoff保护已融合；不整文件覆盖当前更广实现 | 外部owned-window关系probe实际是Win32。历史取舍已由edfe800/da0fedf最小实现及真实Save自动push/pop补足；嵌套跨进程GoTo尚在定位，完整T2未通过 |
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

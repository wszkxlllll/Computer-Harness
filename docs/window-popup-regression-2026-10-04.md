# 手机实机弹窗回归与整改

## 状态

### 当前放行结论（2026-10-07 部署后）

已允许进入独立 Preview 体验：本仓源码 `a9464d4023a0d1cc807d38cb69f483e237a2ff96` 已提交并推送至 PR #22，四个平台／Node CI 矩阵及 `ci-required` 全绿。TypeScript 构建、Vitest 1809/1809、额外 Node 脚本 70 通过／1 环境跳过。Windows 候选驱动来自 `wszkxlllll/cua@7852ab1983b60c0ce581b8736c9da13eaf04640a`，不是官方 SDK 升级或所有平台默认驱动替换。

本机整桌面、focused writable Document 的空白输入、文末追加及真实 GLM 保存链路已通过全文读回：新文件 431 字符精确，10 请求、194.243 秒；其中请求等待 165.285 秒。两次保存／取消点击仍保留 partial unknown，经新观察恢复而非重放。私有 Edge 地址栏和页面单行回归通过。证据在下方“真实Harness整桌面输入／保存复核通过”。

Preview Relay/Web 已部署到 `2026-10-07-desktop-input-v1`，本机候选 Host 监听 4318 并连接 8443；健康、静态资源指纹、匿名 API 拒绝和本机配对票据流程检查通过。稳定入口 443、默认 driver、原配置与登录 profile 保留。部署期间没有重跑业务任务或调用模型；手机须重新扫码配对。详见[部署、使用与回退记录](./voice-preview-deploy-phone-test-2026-09-29.md)。

体验携程→记事本时显式选择“整个桌面（高级）”并打开“跨应用完成任务”；单独记事本任务可关闭跨应用。整个桌面会暴露其他可见内容，开始前隐藏敏感窗口，执行期间不要同时操作鼠标键盘。手机 Guard 继续按既有审批工作，不提供关闭开关。

这不是所有弹窗、同名窗口预览、任意中间插入／选区替换、富文本、手机 TTS 或三平台输入全部通过的声明；本轮未重跑携程完整跨 APP 任务。PR #22 继续更新，不关闭重建，不合并 main。

### 后续效率优化与 Demo 验收（2026-10-07 开始，尚未验收）

用户授权继续优化不必要步骤与重复，不要求为应用添加特例。先按已保留轨迹逐轮区分必要观察／未知副作用恢复和无新证据的重复核验，再修改通用任务条件匹配的操作指导或已有 Context 投影；不凭总步骤数自动判错，不把 Guard、外发确认或必要观察当成冗余。模型请求等待是已验收单题的主要耗时（约85.1%），但降低步骤是否真正降低总延迟必须另做同条件对照，不能用提示词已改代替效果。

目标 Demo 链：受管浏览器查询真实信息 → 切换编辑器整理并保存文件 → 微信选择指定联系人和已保存文件 → 发送前审批。微信末段用于展示用户控制权；用户尚未登录，本轮跳过微信，不自动登录、选择联系人或对外发送。后续测试必须由用户给出联系人并准备登录状态；拒绝审批应不发送，批准后仍核验当前对象与文件，不能重放未知发送。

三项并行工作：轨迹效率诊断与独立实机验收准备；通用效率实现及离线回归；上游输入 Issue 进展整理。本轮先不向上游发 PR，也不把有条件 UIA 焦点输入替代路径描述为已定位 SendInput 内部根因。已有同问题 Issue 优先补充，不重复占位。

验收比较记录正确性、模型请求数、GUI动作数、重复输入／保存／核验、请求等待与总耗时、人工介入及未知结果恢复；不为减少步骤掩盖输出错字、跳过保存或绕过审批。真实桌面仅由指定执行者串行占用，运行中的 Preview 不因源码修改自动换版本。当前部署结论仍以上方为准。

准备阶段已独立复跑 `packages/risk-guard/src/index.test.ts`：90/90 通过，包含声明 external_commitment 直接审批和冲突信号升级等既有用例。这不是微信实际发送审批验收。源码检查另发现 Context 将 operation guidance 静默截为400字符；已交由实施方检查完整投影与整体预算省略，避免效率提示新增内容没有消费者。最新文档提交 `d0ffae2` 的四矩阵 CI 与 `ci-required` 已全部通过。

#### 用户真实手机任务复核（2026-10-07，进行中）

用户运行 `run-1791365937006-7c1a62d6-5cc` 后反馈满意，原证据位于 `runs/diagnostics/preview-host-candidate-a9464d4023a0/run-20261007-031949-1db4c33d/output/`。协调者独立按 requestId 配对轨迹：终态 succeeded，总耗时229.092秒，25请求／25响应，等待合计176.776秒（77.16%），均值7.071秒、最大11.749秒。22次GUI尝试，20 completed、2 failed且实际category均unknown_side_effect；另一次scroll漏direction被参数校验拒绝，不计为已执行动作。所有22次Guard评估均local allow，未发生审批模型调用。Memory更新一次，没有Planning任务事件。模型产生7条中文progress，但客户端消费和实际手机发声不能只用该字段证明。

实际文件、Goal保存位置约束、车次截图及冗余步骤已由唯一实机执行者只读复核，结论如下；不以模型summary单独断言完整成功，不拿旧fixture数值替代本Run。用户任务未包含微信外发。

执行者进一步逐字复核：目标文件1049字节、23行，type文本450个UTF-16单元；文件472单元与其差22个单元正好是22处CRLF/LF差异，规范化换行后精确一致，严格UTF-8解码且无替换字符。文件首项G7503（08:03→08:56、¥87）与type、run.finished summary一致；中间截图中的G245只是备选，曾被误记为最终采用项，已更正，不作为修复依据。新截图seq162显示最终选取车次；Goal、保存文件和模型最终回复的路径／首项没有已确认冲突。票价、时刻及余票来源截图亦单独检查，不把文本输入精确等同网页事实全部正确。

只读验收最终通过该单题：日期／出发到达城市、最终三车次的时刻／时长／二等座价格及票况与查询截图吻合，保存前目录空、保存后文件出现，未覆盖。跨APP走fresh list_windows→switch_window成功，激活后继续整桌面观察；23张Observation均desktop，写入Receipt明确focused Document已写入并验证450字符。没有把同一Run重建成新Session，也没有支付／外发。原证据截图分别为`44a7174e-ca3f-45d6-a3ab-e6b3d3c7746b.png`（日期筛选）、`c3579ea5-7dda-4885-b014-7d9aa83597f4.png`（最终结果）、`267fa33d-1e5b-4d1f-9b93-d580dc5ec95e.png`（保存前目录）、`cbe62382-4a25-4022-b7d1-46af60d70d67.png`（保存后文件列表），在本Run的assets/screenshots下，不随公共文档上传私人截图。

效率分类结论：6次实际滚动的截图均推进列表，不是无变化重复；页面只提供06:00–12:00六小时筛选，滚动是找到Goal要求08:00以后车次的必要过程。日期修改是纠正网站默认日期。两次Ctrl+Shift+S中仅第一次真正保存，第二次为读取实际保存位置／文件存在证据，没有二次写文件；现无可信独立文件readback工具可替代这次视觉验证，不直接删掉。两个unknown均在Save/Cancel关闭对话框后发生，fresh观察确认状态而非重放。确定可避免的额外回合是scroll漏direction，但未发现适配器剥参数的实现错误，不为一次模型缺参追加默认值／应用特例。本轮保留成功链路作为baseline，不为了声称减少步骤硬改已正确行为。

协调者已核实际Goal只要求文件名及告知保存位置，没有指定此前示例的E盘目录，因此不能把OneDrive位置判成路径违约。25次调用均有操作指导投影，stablePrefixHash始终相同；usage输入累计567,829、输出5,451 tokens。固定前缀相同不等于厂商缓存实际命中；轨迹未提供缓存命中指标，不据此推算缓存收益。7条progress为模型输出事实，尚未独立证明手机通知消费或TTS播放。

参数链只读核验：scroll定义在Runtime中将direction enum列为required，GLM schema投影保留inputSchema与required，未发现转换丢字段；seq129缺direction在seq130派发前拒绝，seq133已补齐。原脱敏exchange没有存参数schema，不能声称已核该次完整HTTP body；当前不加默认滚动方向或应用特例。输入567,829是25次累计，不是单次context；降低预算可能裁更多历史而非必然变快，本轮不盲改预算。缓存命中观测可后续独立补足，不以固定prefix hash假冒服务端命中率。

确定性Context修复已完成：删除operation guidance静默400字符截断，完整格式化后按既有预算原子纳入或整体省略，stablePrefix不变。Luna实施及Sol独立复跑Context 36/36通过；限定compiler和测试两文件，未修改catalog文案、未增加模型调用，尚未重建／部署，不能归因为本次用户任务表现改善。

协调者随后合并运行Context36项与Guard90项，126/126通过。该回归不替代预览缩图或真实微信审批验收。

#### 上游跟进与预览优化

上游原 Issue #4477 已由合并的 #4500 关闭，原有[进展评论](https://github.com/trycua/cua/issues/4477#issuecomment-6035452644)仅作关联历史，不作为新问题的唯一入口。用户确认后，新建 [Issue #4830：0.33.1 前台单行中文输入错误及 focused Document 调查](https://github.com/trycua/cua/issues/4830)。正文分开列出原始失败、0.33.1 单次可核对输入／读回、失败的节流实验、空白／追加／浏览器兼容及两次真实保存验证；不声称两类故障同根因，也不要求重开 #4477。逐字对照已明确补充：官方0.33.1上一次模型type拆为91次逐码点SDK调用，读回精确但派发耗时120.356秒；不是91次模型调用，也不是可交付输入策略。

用户随后授权移植并提交上游PR，已创建 [Draft PR #4836](https://github.com/trycua/cua/pull/4836)，基于最新main `b86959306a92dec1598f15df80249497e7ea3a85`，初始源码提交 `73d4148087e7d4a96a1e97bfabd71fa09733d888`，最终修正提交 `0492335190db987ec928bc95d7c5437860c438d7`。仅Windows focused Document输入能力、接入与测试共4文件，不混入独立的CurrentValue读取失败问题。复用main现有UIA single-flight worker和4秒deadline，保留原native queue drain；读写可能发生后不走native fallback。Sol源码审查修复两项P1后GO：使用core已识别的`ax`结果路径，并排除已有Chromium/Electron UIA echo边界以保留浏览器原路线，增加真实ActionExecutionRecord生产者／消费者归一化回归。随后协调者补查超时后的下一次输入，Sol确认Busy不能回退native，否则前一条迟到UIA写入可能与新SendInput交叉；最终提交将Busy与Timeout／Unavailable统一为不允许fallback的Unknown并更新测试，未增加调度框架。作者与提交者均经GitHub核为既定账户ID142909575，contributor-attribution已通过。

Issue正文已替换“暂无PR／仍在探索”旧状态并双向关联PR，而非只追加评论；原#4477下自己的旧评论也改为链接新Issue／PR，不重开原问题。旧候选的实机证据与新main版云端检查严格分开，尚未对新main二进制做本机输入验收。fork手动触发新版Windows workflow首次返回404（默认分支未注册），随后创建独立fork-only构建分支，提交 `ed0f27789875cd225d5cf4d342ede5d14db1dbe6` 仅新增构建workflow，父提交必须精确为初始PR源码提交；构建workflow不进入上游PR。经Sol轻审GO的 [首轮Windows云检查37627381679](https://github.com/wszkxlllll/cua/actions/runs/37627381679) 已全部通过：格式检查、整crate 276测试通过／1忽略及Release编译。最终Busy修正后另以 `c6888b01a7313d39d4331fa0ea5a21a326c01543` 为构建提交、精确父提交0492335运行 [最终版云检查37629865356](https://github.com/wszkxlllll/cua/actions/runs/37629865356)，也已全部通过：格式、276测试通过／0失败／1忽略，Release编译6分02秒；不能用首轮绿冒充最终提交。两轮均不使用artifact或cache actions，本机不编译或下载新产物，仅使用已安装的独立rustfmt格式化源码；两个新工作区均无target目录。上游多项workflow为`action_required`，是等待维护者批准，并非编译失败。CLA job明确要求贡献者签署协议，需用户本人阅读确认，不能代理签署；不影响已完成的源码检查和fork构建。当前Preview保持原已验收驱动，不随上游移植切换。

预览方向先检查原图捕获成功后是否可统一生成传输缩略图，从而减少2MiB超限；不放宽成同名盲选、不更改模型截图或坐标，也不把无法捕获伪装为缩图成功。调查后按下方最小方案实施，真实效果另行记录，不宣称已改善。

已批准最小后端预览实施：picker专用路径接受内部有界原PNG（上限16MiB），经尺寸／像素边界验证后生成保比例缩略图，最终传输保持2MiB；使用纯JS直接声明依赖，避免原生图像库安装影响三平台。模型Observation、执行坐标、身份核验和previewToken过期／消费规则不变。该方案只处理捕获成功后的大图，不能宣称解决底层capture失败；完成后须离线PNG测试和集中审查，当前尚未部署。

首轮实施为discovery25、Remote API72、缩图helper4，共101项通过，两个包noEmit类型检查通过。新增同名候选及child handoff大图proof回归。Sol独立复跑101项通过，并实际发现pngjs5允许重复IHDR覆盖metadata、interlaced inflate缺少展开上限，要求大图decode前唯一IHDR的有界chunk扫描及拒绝interlace旁路，负例修复未验完前不部署。该边界只针对需解码的大图，小图既有透传及手机img.onload确认规则不变。

最终修复已通过：大图decode前扫描有界chunk、首且唯一完整IHDR／interlace0／IEND；三个恶意或畸形负例确认decoder未调用。Luna定向102/102，Sol仅复核P1增量并独立helper5/5通过、最终GO。协调者全仓1817/1817通过，原始JSON为`runs/diagnostics/preview-thumbnail-context-regression-20261007.json`；代码分两commit保存：Context `6de2a509`、预览`d840000c`。

本机Host已按后者构建并更新：重启前后lease为unowned，仅精确重启Preview Host，CUA binary／pipe／home、profile、env、服务器Relay/Web保留；连接／session200及Relay连接通过，没有启动新业务／模型测试。手机须重新配对。详细版本矩阵见[部署记录](./voice-preview-deploy-phone-test-2026-09-29.md)。真实大图候选仍待用户复验，不能把合成指标或health200称为真实capture通过。

#### 完整版 Demo 录制安排（修复验收后执行）

用户确定本任务增加“保存文件→微信指定联系人→发送前审批”作为完整版Demo。微信当前未登录，未经用户准备与联系人确认不执行发送；演示优先使用本人测试会话或明确同意的接收者。审批须呈现实际接收者、附件及风险原因，批准后核验发送结果；审批拒绝不发送，不用假按钮或伪造成功。该终端真实展示能力仍需验收，不能因Guard单测通过就宣称具备。

电脑与手机分别保留原始录屏，剪辑以电脑执行为主画面、右侧手机竖屏为控制面；开始发任务、语音进度、纠正／审批和结果交付等关键时刻突出手机。个性化、预览等功能用单独截图说明，不为展示功能增加无意义任务步骤。正式录制前先做10秒音画预检，确认手机录屏确实包含Web语音；未收音时另选清晰音源，不事后配音冒充实际TTS。两路以提交任务的共同事件对齐，保留可核查时间线和原片。

API等待可以在展示版压缩，但必须标注“等待已压缩”，同时提供实际总耗时、请求数及剪辑说明；不剪掉失败后恢复并宣传一次无误，不用剪辑时长充当系统效率。发布素材需遮挡账号、联系人个人信息、二维码及配对秘密，不把真实完整轨迹公开。录制前验收文件正文、最终回复、发送附件三者一致，来源事实与当前截图吻合。

### 部署前调查正文（历史）

以下按调查时点保留原始结论；其中“尚未部署”“未放行”等表述由上方部署后结论取代，原失败证据不删除、不改成通过。

用户最新调整：暂不重复携程完整任务；查询、跨应用切换、保存及收尾已有链路证据，后续集中前台输入短对照、Demo效率与手机显示／播报。这不撤销正文准确性验收，也不把已发现的错字标成解决。

整体尚未通过真实任务验收，不能宣布修好或让用户替代验收。Preview仍是10月4日部署，本节源码修正尚未部署。

2026-10-07 用户暂缓完整任务实机测试，明确允许输入与浏览器启动短步骤；最新要求进一步明确不重跑携程。本轮继续在独立诊断页验证，不重启正在使用的 Host/CUA，不操作用户已有文档。最新统一 TypeScript 构建及Node24回归 **1807/1807** 通过，报告 `runs/diagnostics/unified-preview-limits-input-profile-final-20261007.json`；CUA spike类型检查在前一1804项增量已通过。历史回归及独立审查保留在下方记录；离线通过不替代手机或输入实机验收。

本轮修正：可选操作指导在无 Plan／未知应用的查询并保存任务中不会永远只选查询原则；Context 预算紧时整体省略，稳定 system/tool 前缀不变。Trajectory 保留其选择与省略 Trace。窗口候选仅精确重复合并，应用名／标题／关系独立序列化，避免分隔符碰撞。开关默认关闭，未增加维护模型调用，也未部署 Preview。

真实历史 Goal 的只读匹配核验：携程与 WPS 两题目前均命中保存原则；携程的查询与结果词间隔超出现有 matcher 的 12 码点门槛，因此未命中信息抽取原则。组合 note 的机制已回归，不等于所有自然语言任务都能选中它，也不证明改善了实际成功率。该召回缺口保留，先不在前台输入主线中追加词表或调整距离参数。

原整屏阻塞已定位：Windows desktop observation 没有原生窗口 binding，默认多行 UIA 分支会拒绝；普通单行走前台键盘注入。Host私有前台多行profile已接通，默认路线不变；20ms/40ms候选均未通过。focused-empty UIA全文与通用TextPattern末端追加短实验精确，最小源码候选CI已过，但实机两轮一轮命中精确、一轮退回旧输入后损坏；正在定位间歇fallback，尚不部署为修复。

提示源修正：短 fixture Run 的 `acceptance-start.json` 在 `hostExecutionPolicy` 与 `cuaSdkRuntime` 中均记录 `foreground-caret-v1`；任务摘要未序列化 Host 私有字段，缺项不能判为 profile-off。Context 的 desktop 投影已改为只描述无 native-window UIA/DOM scope，并引用同轮 ToolRegistry 的 `type` 描述；profile-off 的拆行回退保留在默认工具描述，且仅在目标确认支持换行、Goal确有换行时使用 Enter（可能提交／发送）。profile-on 仍由现有工具描述表达 caret 路线；这只是提示源对齐，不是输入可靠性修复或实机通过。

| 项目 | 当前结果 | 下一验收条件 |
| --- | --- | --- |
| 预算、标题／可执行候选、浏览器零退出等待、预览错误投影 | 已实施并经回归；本轮真实WPS已能发现与激活 | 手机候选可区分、真实预览仍须分别验收；进程存在不能冒充可操作窗口已出现 |
| 记事本多行写入／另存 | 当前构建正常GLM完整任务通过，13请求／10动作，正文逐字一致、owner释放 | 不推广到无Grounding路线或尚未实测的菜单路径 |
| WPS新建／字体／保存 | native窗口路径失败；整屏 Run `run-1791294022199-456e9415-043` 成功，28请求，无人工纠正；独立DOCX读取确认33字正文准确、四号14pt，owner释放、录像有效 | 整屏成功不推广为窗口菜单／弹窗全部可用，也不替代长中文输入回归 |
| 整屏记事本另存 | 最新正常GLM Run `run-1791280194657-60bad187-e57` 成功；34请求、35次动作尝试（33 completed、2 partial），无人工等待；新文件按UTF-8独立读回54字符逐字一致，owner释放 | 此题只验证已有正文另存，不是跨应用，也不证明中文长文本输入稳定 |
| 携程→记事本 | native/UIA Run `run-1791292339458-454347e9-dba` 走通，11请求；保存文本与原始type全文一致，查询主要字段吻合、child关闭后恢复父窗口；报告价格席别归属有语义备注 | 此次使用显式UIA新空白报告追加，不是普通整屏Unicode注入修复 |
| 前台中文输入 | 20ms/40ms候选失败；UIA源码候选CI通过，首轮命中后全文精确，次轮fallback旧SendInput后损坏 | 先定位间歇fallback，再继续矩阵；默认服务未替换，不放行部署为已修复 |
| 清理／下一任务启动 | 最新业务Run均释放owner；此前一个诊断pending lease经精确恢复留审计 | 保留历史失败及诊断，不推广为所有清理场景已解决 |
| 最新全仓回归 | Node24增量回归1807/1807、TypeScript构建通过；前一增量CUA spike类型检查、Host/PNG审查22/22通过 | 不作候选Driver实机或Preview部署通过声明 |

下方为本轮按时间积累的调查证据，不将某个早期“通过”推广为后续增量或整题通过；最终以本表和实际Run／文件核查结果为准。

#### 构建环境与操作留痕

官方0.33.1源码节流候选在ignored隔离目录，未替换默认Driver。最小Windows binary构建实际尝试107秒，未产出exe：缺MSVC `link.exe`，进一步确认虽有Rust自带 `rust-lld.exe`，但缺Windows SDK/UCRT与MSVC CRT import libraries。未安装工具链或编造链接库。新增下载7个锁定crate共4,311,893字节，E盘隔离产物约663MiB。用户已授权自有fork临时分支Windows Actions编译；仅编译单Driver和上传产物来源，不依赖上游受限测试、不开上游PR、不合并／发布。构建通过后仍须本机实测，不将源码或CI通过当作二进制行为通过。

自有fork `wszkxlllll/cua` 临时分支 `codex/paced-windows-driver-v0.33.1` 已创建；Git Data API 发布commit `24a641a28ce9f2738045f60371065abf91835436`，tree与本地已审候选一致，author/committer均由GitHub解析为 `wszkxlllll/142909575`。只变更Windows键盘实现与隔离构建workflow。构建已实际启动：[Windows Driver candidate run 37487060000](https://github.com/wszkxlllll/cua/actions/runs/37487060000)；启动检查时Windows runner与checkout已通过，编译进行中，未取得产物。意外触发的自有fork Image API run已按精确分支／head单独请求取消，未修改或禁用既有workflow。HTTPS git push曾有界挂起，替代发布保持同账户权限和source tree，不绕过权限错误。

后续第三次构建已成功：[run 37490081756](https://github.com/wszkxlllll/cua/actions/runs/37490081756)。前两轮分别发现类型模块路径错误与telemetry的两个稀疏检出资源遗漏，均已修复；只编译、没有运行上游受限测试。最终commit `4e8857ccf6d638dee89bedf43881b77e65eba45e`，exe 34,756,096字节，SHA-256 `9D48777458C1A7270BD78973E1E8824EDB6A573210DB9F3DC3DDD6F68FFCC66C`。协调者独立核下载文件哈希及manifest，来源／lock／patch信息一致。当前只放行独立daemon实测，默认服务未替换、未提交上游PR；CI成功不等于字符正确。

准备阶段曾因PowerShell `$home` 与只读 `$HOME` 大小写冲突，将依赖缓存误复制到 `C:\Users\lenovo\registry`。只读核验该目录含cache/index、904文件与原缓存哈希一致，合计97,496,267字节；清理被工具策略拒绝，未绕过，当前仍保留待清理。未改原 `.cargo`、凭据、浏览器profile或系统变量；后续全部使用显式E盘隔离路径和非保留变量。不能宣称本轮C盘零写入或误复制已清理。

### 下一轮验收与主 Demo

#### 2026-10-07 三项交付重点与最新短步骤证据

用户再次明确：前台输入正确性、真实Demo效率、手机体验与显示是本轮主线，不能以驱动单测代替产品验收。

同生产版本0.22.2的节流候选由自有fork Windows Actions构建成功（run `37508991404`，7项针对性测试通过），在独立pipe运行；没有替换默认daemon或用户登录profile。本机一次`type_text`内逐码点节流，而非逐字符RPC：91码点中文／数字／符号文本5次均真实读回精确；CRLF与LF测试中的换行按逻辑行结束符比较，两个非BMP字符保持完整。光标插入结果为`ABXCD`，选区替换结果为`XYZ`。证据分别在`runs/diagnostics/input-candidate-20261006183100832-ec0ab0cf/summary.json`与`runs/diagnostics/input-candidate-20261006183556900-4d00dde8/summary.json`。未知的truncation标志保留未知，不伪造false；精确全文比较与逻辑换行比较分别说明，不混为字节完全一致。

集成缺口已完成源码修正、仍待业务验收：未启用profile时Windows多行输入继续原UIA末尾追加路线；启用核验候选的Host私有profile后，无显式ref多行保持普通前台caret／selection语义，不强制模型召回element。其他平台及未启用的stock路线不变。焦点丢失实测尚未完成。

真实可见Edge短回归已通过：`runs/diagnostics/edge-input-candidate-20261006185352902-5e3f02ec/summary.json`记录149字符本地data URL一次CUA输入耗时3210.8ms，精确HWND的只读UIA确认地址栏值；随后本地页面16码点`Browser-测试-123!?`一次CUA输入耗时371.7ms，只读CDP确认DOM.value完全一致。UIA／CDP均未用于写入，没有访问外网或saved profile。浏览器启动PID交接导致第一次诊断零输入停下，已修正为唯一临时profile进程族的真实窗口身份。成功轮的正常关闭helper存在未定义引用，精确私有进程组兜底清理后均退出、owner释放；保留该脚本错误，不称正常关闭路径通过。临时profile目录仍保留，不宣称全部产物已删除。

效率验收在同一正常Harness业务Run中记录请求耗时、输入耗时、重复动作／重复保存与总耗时，不能把91字正确等同Demo高效。手机本轮headless fixture验证了截图授权与解码、旧截图更新提示、清理后第二题启动；不替代真实弹窗预览可辨识、手机端播报或Safari实测。源码尚未部署Preview，最终须核对部署指纹后验收这三项。

工程收尾次序：浏览器单行兼容回归已通过；默认关闭的Host本地`multilineTypeProfile: "foreground-caret-v1"`已实现并统一构建，Sol集中增量审查43个不同用例通过。Win32无显式ref走现有普通前台派发，显式ref保留UIA末尾追加；stock自动唯一选择仍在CUA内部，其他平台不改变。普通前台换行为Enter事件，可能在提交型控件触发提交，工具描述已区分，不能宣称所有多行输入都不会提交。诊断profile仅用于经核验的候选socket，不凭相同版本号自动识别；手机不得通过远程请求开启这个底层实验选项。

本增量构建后两次全量默认并行回归均为1797/1798，唯一失败是相同TUI小尺寸中文布局用例的5秒超时；该文件单独复跑66/66通过。限制为2个worker后的全量最终1798/1798通过，未改断言或机械放大超时。原始报告分别为`unified-foreground-profile-regression-20261007.json`、`unified-foreground-profile-final-regression-20261007.json`，独立复跑为`foreground-profile-tui-rerun-20261007.json`，最终为`unified-foreground-profile-bounded-workers-20261007.json`，均在`runs/diagnostics/`。已放行唯一桌面执行Agent按正常Harness／GLM、显式候选profile、保存的登录状态启动录像跨应用回归；完整任务结果尚未取得。源码／构建通过不等于部署Preview或业务验收通过。

**正常Harness实测更新，输入仍未放行**：Run `run-1791313873770-4be54747-d24` 的模型终态为succeeded，实际新文件存在（804 bytes），owner已进入核验，录像保留。协调者独立UTF-8读回文件与正文type参数，归一CRLF／CR后仍不一致：请求390单元、实际388；`wap.ctrip.com`变`wap.ctrip.oom`，`01:40`缺少前导0，空行缺失，末尾文字也有替换。后续正文没有再次type编辑，因此不能以任务终态或截图看似正常放行文字正确性。原始文件SHA-256为`1C82D035291008B7088435C015F46C913942B35484789F75EA55DA7136015709`，与LF归一化哈希分别记录。本轮不会部署为已修好版本；先针对真实长文本做受控读回与源码差异核查，不盲目重跑完整任务或增添应用特例。运行目录为`runs/diagnostics/full-foreground-task-acceptance-20261006191105523-751929ec/`。

该业务Run为20次模型请求、18次GUI尝试（14 completed、4 partial），约288秒；协调者按requestId配对请求／响应累计等待226秒，占78.5%，包含网络及服务端整体响应，不仅是模型推理。正文type派发约8.6秒，不是之前Edge149字符的3.21秒。四次partial均为点击产生／关闭另存对话框的前台确认未知，不是partial type；新观察后继续，不能将其计为四次输入失败。两处菜单选择发生额外点击，保存后又打开另存对话框核对同名文件；这些是效率分析对象，不能据此自动跳过必要保存确认。

任务输出语义核查：查询日期10/08与路线一致，三趟车次／时间／历时／余票有页面证据；只有第三趟显示价格83元，报告未强行归到具体席别，被遮挡的价格标未显示。实际owner释放、computer.close确认、dispose完成，H264录像有效。Runner的desktop任务没有生成browser-target生命周期对象，`usedManagedBrowser=false`／`leaseReleased=false`及初始目标匹配假值不是浏览器未使用或泄漏的证据；整屏实际显示受管携程，单独profile lease释放信号未直接观测。部分机械validator不适用于本模式，但全文输入不一致是实际阻塞，不会通过修评分脚本将其改成成功。

定位参考只作为实现对照：[Microsoft KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)说明Unicode packet需经目标线程消息处理转成字符；SendInput插入事件本身不是编辑器全文确认。[Microsoft winapp-cli UI Automation](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/ui-automation)区分真实SendInput与PostMessage，提醒WinUI窗口无独立子HWND时后者可能根本不接收；其布局键与Unicode fallback实现正在做只读源码比较。不能因此直接认定本机Notepad根因或换成PostMessage。Terminal历史高码点修复与本轮BMP错字并非同一缺陷，不拿外部Issue充当本机修复证据。

Microsoft WinApp CLI的[已合并PR #667](https://github.com/microsoft/winappCli/pull/667)提供相近的长输入丢字符案例：通过16字符自平衡小段／15ms间隔缓解整串SendInput突发，报告Notepad 1000字符5/5、Win32 EDIT 3000字符8/8。但示例以重复ASCII长文本为主，其可由键盘布局表达的字符使用真实VK，其他才回退Unicode packet，和本候选逐码点Unicode／20ms不是同一实验。只读源码已核对，不能用该结果放行中文、混合换行或本轮390字；分段节奏与编码策略必须分变量验证，也不会为了参考项目新增一套Computer backend。

同390码点原始正文的候选独立空白标签对照已完成，总计3次（不覆盖原业务文件，不保存，不让模型后续编辑）：`input-candidate-20261006195439364-3ff6bf2f`一试在cp92出现`c→o`；`input-candidate-20261006195838792-9200e9fd`两试中第一试丢失cp92的`c`及一个换行，第二试LF归一化后精确。三次单RPC派发约9.3–9.5秒、均completed且前台身份精确；即时与两秒后真实Document值不变，truncation flag未知如实保留。因此短测试5/5不能证明真实长输入稳定，截图过早不足以解释这些错误。诊断第一轮比较mismatch被脚本误当停止，后续仅修正该诊断状态区分，历史summary保留；另外两试使用新的空白标签，不重放未知副作用。现批准最多两个独立blank标签的同文本raw P/Invoke 20ms／40ms控制，不改默认驱动或引入应用特例。

raw对照已完成并由协调者独立核对390/390全文：请求20ms时实际起始间隔平均33.350ms，循环12.979秒；请求40ms时实际平均49.103ms，循环19.105秒。每档只有一试，即时与两秒后归一换行值一致，无unknown、会话结束和owner释放；不将这两次推广成可靠率或确定根因。证据为`input-candidate-20261006201659385-926ba72d/summary.json`与`input-candidate-20261006201836925-1df10b16/summary.json`。下一单变量native40ms变体仅改间隔、对应断言及测试名三处；Sol微审通过，自有forkcommit`39a67703a758d3848e926b8768d3dc6e55cd559b` author/committer均解析为已核账号。[Windows CI 37525946489](https://github.com/wszkxlllll/cua/actions/runs/37525946489)正在编译，未取得产物／未启用；保留20ms旧binary、manifest和daemon，不本地安装MSVC／SDK或构建。

40ms后续结果：上述CI成功、7项纯测试通过，exe hash为`CB4B1C6BABBB1F9FF09E463896B696458CC13419BE68CA4F53D2685A575A7C5D`，独立daemon PID38828／pipe `computer-harness-pi-v0222-paced40`经运行路径／哈希／metadata核验。真实390字三次独立空白标签测试，前两次约17.3秒派发并全文精确，第三次稳定少cp239一个空格（389/390），即时与两秒后不变；协调者独立比对确认。已按首个确定错误停止余下两试，不部署／不再无上限增加间隔；证据`input-candidate-20261006205126491-e1fa821f/summary.json`。20ms与40ms都没有可靠的长文本放行证据，不能将这两版作为“修复已解决”的上游PR结论。下一调查转向编码／焦点路径差异与语义等价的UIA方案，不能按应用名硬编码或通过改评分掩盖错误。

三个验收维度分别留证据：

- **输入**：全文读回正确、caret／selection语义正确、浏览器单行不退化；部分输入不重放。诊断通过与正常Harness整题通过分别记录。
- **效率**：统计实际API等待、输入派发及总耗时；按轨迹检查无依据的重复输入／重复保存／选错文件重建。简单加预算不作为效率改善。当前Context已有text/wire双预算及HTTP前Provider门禁，但没有按wire反馈自动回编译历史；超限零HTTP失败不等于可恢复。
- **手机**：每个候选有可辨识信息或有效预览；不存在同名盲选，截图失败可见且能重试；中途播报使用实际进度文字；Run结束清理后能启动下一题。headless fixture与真实手机观察分开标记，不能把机械开始／取消声音当作中途播报已验。

不把输入修好等同全部产品验收。最小顺序为：

1. 验证CI产物源commit／patch／lock／exe hash，独立daemon和SDK握手；不替换原daemon。
2. 本机同文本旧版／候选对照，中文英文数字符号、非BMP emoji、空白输入、光标中间插入、选区替换、单行网址和换行分开验证。至少重复5次的关键失败复现；真实文本读回及耗时必留。任何部分输入／焦点漂移停止后缀，不重放；取消／关闭语义另测，不假设blocking代码支持及时Abort。
3. 正常Harness复跑整屏携程→记事本与WPS任务；测试切窗、临时UI、保存后继续／结束以及下一Run可启动。窗口模式单独验收，不能用整屏成功冒充。
4. 手机截图加载／失败重试／旧图标记、候选可区分与真实预览、SSE重连和旧Run事件隔离、审批／纠正／取消、终态清理逐项测试。组件和HTTP测试不替代手机浏览器真机与实际语音输出。
5. 冻结同一源码／配置／binary，更新Preview后检查部署指纹，再双端录制。未通过项清楚保留，不把用户接手当自动成功。

主 Demo 推荐“为长者准备可直接使用的一日出行单”：录制前预检一组有真实结果的未来日期，手机语音提出上海→杭州当日往返需求与少步行偏好；电脑从携程查询合适班次、从地图查询车站到具体目的地路线，再在WPS保存大字、短句的中文准备单。中途手机纠正出发时间，模型应保留不变约束、更新候选并调整报告。只查询和整理，不购票、付款或对外发送；未显示的价格席别或无障碍设施明确未确认，不推测。

此主线可展示跨应用执行、用户纠正、适老化交互、阶段状态与结果交付。Planning／Memory／Monitor的字幕只依据实际tool/event/context证据，没用到不冒称发挥作用，Demo不证明净收益。风险审批另用一个明确授权、受控的发送／提交场景录短片，在最终审批选择拒绝，不人为把无害查询拦成风险。保留完整原片与实际总耗时；剪辑两端同步、明确标注等待缩短或加速，语音只使用实际播报。以上是录制候选，不是已经跑过的任务。

### 2026-10-06 最新写入问题：先取得真实文本证据，再决定修法

本次携程Run已取得2026-10-07上海虹桥→杭州东的查询结果并切到记事本。第一条车次输入原始参数为57字符，包含完整的 `G4915 00:34`；约2.31秒后的截图无法清晰确认分钟数字。模型随后执行查找／替换和重新写入，最终截图出现重复箭头与数字。这证明当前写入闭环不可靠，但尚不能仅凭截图确定第一次输入已经损坏，更不能把后续异常全部归因于截图过早。随后进行了精确、属于本次Run的记事本文本只读诊断；不读取其他用户文档、不通过剪贴板取值、不重放输入。

只读诊断已取得最终buffer：fresh CUA清单整体 `complete:false`，但唯一marker匹配窗口PID33052／HWND `0x31888` 可精确读取；`get_window_state(include_screenshot:false)` 非error、非degraded，唯一匹配 `Document.value` 为119个Unicode码点／177 UTF-8字节，SHA256=`eaf2e1bf16dda5fc04305678497bf86a9a70312269163c51b3fae7eed76cef81`。前三行marker、路线、日期存在，第四行为 `车次1：G4915 ` 后12个箭头及32个数字3。确认最终真实buffer异常，不再仅称“截图显示异常”；但首次type后未读回，因此仍不能归因到首次注入。临时session已确认结束，未激活／输入／读取其他tab。下一对照由正常Harness发出单次原57字符文本，禁止中途模型修正文，随后精确读回，以补首次送达证据。此诊断不代替完整任务验收。

终止原因独立于动作回执：Provider在下一请求前拒绝 `estimated=24762`（text=24250、visual=480、envelope=32），超过wire预算24576。100次模型请求预算并不能保证长历史可容纳；本题实际仅42次请求。40个动作回执completed只表示Driver执行层返回成功，不表示文字逐字正确。产物位于 `runs/diagnostics/full-foreground-task-acceptance-20261006100123816-6e668b57`，文件未生成，录像已保留，owner已释放。

预算调查已确认两者不是同一估算域：末次已启动请求的Context estimate=14268（全程最高15050），在16384内；GLM按剥离图片payload后的完整wire JSON估算，含额外Provider提示词、messages转义／结构与工具schema，因此逼近24576。recent模式最多保留76事件，末尾60事件，末次没有触发input_budget裁剪，不是已经证明的“单条消息不能裁剪”。修复候选应复用Provider prepare的投影反馈与现有完整历史组回收，在未发HTTP时有界重新编译；不得删除用户纠正、最新观察、必须的安全信息或拆开call/result配对。此能力尚未实施，不把建议写成已有自动回退。

优化顺序：先查实际文本，再对输入送达／焦点／呈现作最小受控对照；同时只读核对现有recent Context的预算估计及成组裁剪，避免为了绕过故障无界增加预算。应用SOP仅作为可选辅助：确认当前编辑区域、在遮挡或阅读范围不足时改善观察、避免凭一次不清晰截图重复重写、保存后确认目标文件。若采用，复用Context组装边界并保持稳定提示词前缀，不新增独立模型调用、不写网站答案、不按应用名补输入分支；不能用SOP替代底层写入验收。

上游依据已重新核实：[CUA PR #4500](https://github.com/trycua/cua/pull/4500) 于10月3日合并。维护者的Windows交互A/B指出，原foreground路径在SendInput后固定40ms恢复旧前台，目标线程尚未消费尾部事件；原分批方案没有改善，因此被撤回，最终采用目标输入队列sentinel drain后才恢复焦点（有界等待2秒）。这是上游多行问题的实验归因，不是本次单行57字符问题的直接证据。本机0.22.2仍不含此修复；先确认已发布Windows二进制与合并提交的对应关系，再考虑独立工具目录、独立daemon的对照，不直接替换原工具或再建设分批输入补丁。

已确认首个可追溯正式版本为 [CUA 0.33.1](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.1)：release notes明列#4500，并提供Windows二进制；[tag下keyboard源码](https://github.com/trycua/cua/blob/cua-driver-rs-v0.33.1/libs/cua-driver/rust/crates/platform-windows/src/input/keyboard.rs)含输入队列drain。附件并非“永远等待输入完成”：attach失败时仍有40ms fallback，drain有2秒上限，需实测。下一步仅独立目录准备二进制、验证SDK／daemon握手与动作契约，再进行有界A/B；默认依赖、原daemon和用户环境不变。不将下载完成或上游E2E当成本机业务通过。

### 2026-10-06：单次中文输入已取得真实buffer错误证据

正常Harness／GLM诊断Run `run-1791285067524-364e7afc-fe0`（目录 `runs/diagnostics/full-foreground-task-acceptance-20261006111059904-440a55b9`）实际list／switch到Notepad；仅一次91字符原始type，完整参数为唯一ASCII标记加原57字符车次行。底层调用返回约138.1ms，重复发送守卫未触发；后续4次只读全屏采图完成约124.4／675.5／1662.9／3140.6ms，不能把这些截图当成文本读回。Run最终12请求／11动作、budget_exhausted、没有保存文件，录像与owner释放均确认；这是一条输入诊断，不是业务通过。

随后精确PID33052／HWND `0x31888`的只读Document.value返回91码点／163 UTF-8字节，SHA256=`35ed011e35e30b0b9c8b13c0274ae4a2a86083d8a1fa3ed880e1cb5729266059`；在首个差异index63处，预期“杭”、实际“）”，后28个字符均为“）”（其中最后一字恰好与预期相同，共27字不匹配）。此题正文只有一次发送，已获得真实buffer异常证据，不再仅是最终截图或经过模型重写的值。当前可以定位到0.22.2这条输入送达链路，但具体机制仍需同路径的新版本对照；不得把不可靠的字符送达用应用SOP掩盖。

协调者独立按UTF-8解析本Run `owned-document-readback.json`，重算长度／首次差异／27处差异／SHA均与记录相符，并查看第4张直接采样PNG：输入返回后约3.14秒、下一模型修正前，已经可见 `01:19` 后重复“）”。因此不需再把此诊断中的异常解释为后续模型修正文造成；这也不等于已证明全部历史异常都具有同一根因。

0.33.1官方二进制及matching npm SDK已在仓库ignored `.tools`隔离准备；官方ZIP SHA、npm tarball integrity、二进制签名及SDK／native addon加载均验证。上游两版本desktop type分支均调用共享 `send_text_synthesized`，新版本drain确实覆盖整屏输入，不是仅显式native_window。SDK／独立daemon实际握手和输入A/B正在进行；原0.22.2daemon、默认依赖、lock、用户配置、PATH未替换。若A/B有效，仍必须走正常携程→记事本任务、浏览器单行输入及WPS回归，不能直接宣布所有输入场景修好。

### 新版对照与旧输入适配边界

0.33.1配对握手真实返回driverVersion=0.33.1、contractVersion=0.8.0、health=ok；不修改生产doctor支持表。首轮 `run-1791286424566-6d1291bf-8a4` 12次菜单click没有可见进展、0次type，不能作为输入A/B结论。第二轮 `run-1791286948297-7079fb15-a51` 接受一次通用纠正后实际list／switch，9请求／6动作，仅一次同长91字符type，返回917.3ms；4次采图保留，后续无正文修正。真实Document.value仍有1字错误：index75，预期“二”、实际“等”，成为“等等座有票”。读回SHA256=`9d07c4200947125a210611bc10f09eb1622c3bcfae1a215c67e7377ee58ae87c`，owner与读回session均释放，录像有效。错误从27字减少到1字不是准确输入通过，默认版本不升级。两Run目录分别按上述Run stamp存在于diagnostics；第二轮报告位于 `full-foreground-task-acceptance-20261006114218790-010444e4/owned-document-readback.json`。

Sol本轮只读审查了旧适配，协调者核对了对应源码与description：

- Windows `hasLineBreak(text)` 才进入 `executeMultilineType`；本次单行desktop走 `actionRequest→type_text(target=PrimaryDesktop, foreground)`，参数原样，无token。因此旧UIA多行适配不在这次异常的执行链里，不应误判为它改坏了这段文字。
- 旧UIA路线向精确element发送background ValuePattern写入。它读取旧值再末尾追加，不尊重caret／selection；工具description虽有提示，但它不等价于普通光标输入。选区替换／中间插入若误走此路可能反作用，且上游旧值读取失败以空值继续写入存在风险，未在本轮真实复现。依据为 [0.22.2上游源码](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L4235)。
- 该版本上游报告 `elements_complete=false`，当前要求完整目录的自动绑定不能仅凭mock绿灯承诺实机可用；fresh token／唯一role不等于焦点或追加意图。此前显式UIA成功不推广成所有type都有自动保护。
- post-input settler只等待／读取截图，不改文字、caret或前台身份；可缓解过渡画面，但不能修复损坏字符，也会增加等待成本。

下一步继续源码分析，并在ignored正常Harness诊断中尝试有限块、逐块等待同版SDK输入完成的对照，不在生产加入应用分支或盲目重发。后台真实dispatch数量、每段结果和任何未知前缀必须记录，不能把内部多次SDK发送称为一次原子输入。若发现解决方向，先核对完整文本及光标语义，再回归浏览器／WPS及跨应用Demo；任何仍有错字的版本都不放行默认替换。

源码进一步核实：两版均按Rust char的UTF-16 unit构建Unicode down/up，整段仅一次SendInput；91个BMP字符对应182个主输入事件。SDK生成边界为UTF-8，未发现ANSI转换。0.33.1的drain布尔结果未被调用方消费；attach失败／同线程退回40ms，timeout仅tracing警告，公开ToolResult不区分这些路径。`delay_ms`在desktop早返回路径未生效，不能只加该参数就宣称已节流。sentinel被目标线程读取不等于控件值已更新，具体错字机制仍未证明；现有隔离daemon没有保留下stdout/stderr，因此不能以“没有看到警告”排除fallback／timeout。依据见 [0.33.1键盘实现](https://github.com/trycua/cua/blob/cua-driver-rs-v0.33.1/libs/cua-driver/rust/crates/platform-windows/src/input/keyboard.rs)。

Demo与根因修复并行但桌面串行：已有browser起点→native Notepad→显式current UIA reference的路线，可用于“新空白文档整体报告末尾追加”这个符合语义的任务；不强制猜引用、不用它冒充普通caret／selection输入修好。现成 `full-popup-task-acceptance-runner.mjs` 有该task及100请求预算，先核对当前构建／产物再跑，不为业务另搭框架。raw路径源码／节奏实验继续，默认CUA与其他平台不变。

### 最新实施原则：可观察、可恢复，不将不确定直接升级为任务失败

- 候选可发现性、实际可激活性、当前可输入性是不同检查阶段。原生身份明确但未被CUA清单列出的窗口，目前仍有过滤点；需用已有精确目标接口验证可捕获／可激活后再决定纳入，不能仅凭进程存在承诺可操作，也不能无证据批量删除筛选。
- 已授权跨应用的Run，切换失败后应保留原授权范围并清除旧Frame／引用，允许只读重新观察／列窗。确认没有发送输入的拒绝可恢复；未知副作用不自动重放。单窗口Run不因此获得其他应用标题或整屏截图权限。
- 输入返回成功不等于界面已呈现完整。一次raw输入对照中，约186ms截图只有前缀，约645ms文字完整但状态栏仍落后，约1661ms及3128ms画面一致。正在实现Windows本地前台raw输入后的有界观察稳定等待，仅最终Frame进入Runtime，不修改文本、剪贴板、光标或输入算法。
- 预览是辅助辨别而不是所有明确窗口的使用前提。可选预览失败不能禁用本来已具备身份的普通窗口选择；无法区分的候选仍不得让用户面对一列相同标题盲选。
- 此节是当前修复方向，不是已部署或实机全部通过的声明。先完成配对的Adapter／Runtime实现与回归，再冻结版本跑正常Harness完整任务。

实现进度：输入稳定等待、Adapter／Runtime失败切换恢复、整屏native-only候选及可选预览已实施并冻结。作者CUA／候选投影282项、Runtime138项、新settler5项及相关类型检查通过；协调者统一构建后全仓1755项通过。Sol集中源码审查GO，独立运行CUA270／projection12／settler5／Runtime138共425项通过（14.23秒）。真实任务仍待结论，旧的1732项仅代表上一构建，不计作本次新增量证据。settler的3秒是额外等待／采样调度窗口，不会中途截断已经启动的SDK截图；慢capture仍受既有SDK／观察期限约束，不能宣称整次observe必在3秒内结束。

候选漏列的调查修正：CUA 0.22.2 Windows原生枚举过滤不可见与空标题行；`verify_state`先在CUA清单寻找精确身份，Windows `get_window_state`也依赖同类枚举。因此“先用现有verify_state核实native-only行就能补进窗口候选”不可行；删除本仓库 `cuaListed:false` 过滤仍不能保证窗口模式可打开。正在单独核实整屏授权路径的精确激活是否可绕过该清单依赖，未取得结果前不扩展候选或添加新的capture桥。

后续源码核实得到整屏专用路径：CUA显式 `bring_to_front(pid,window_id)` 经过原生HWND所属PID检查，不走PID-only候选枚举；只有精确目标真正成为前台才报告成功。desktop切窗随后仍调用 `get_desktop_state`，无需目标窗口capture。因此允许在已授权desktop Run内，用完整、未截断Win32快照中的唯一可见／可恢复且非noActivate、非菜单的native-only身份生成Run-local引用；执行前重新核实同一准入条件。此增量已实施并纳入1755项离线回归，特定native-only实窗仍待验证；不修改窗口模式／Host picker／preview的捕获门槛，不取消Host allowlist，也不新增输入桥。依据为上游 [Windows工具实现](https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs) 与 [精确窗口guard](https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/cua-driver-core/src/window_target.rs)。

### 2026-10-06：保存确实发生，但整屏unknown处理仍过严

新构建真实GLM save-only Run `run-1791276927259-8af406ae-d92`，100请求／100动作预算，实际21次请求／21个动作提案、19个completed及2个failed。第一次点击文件菜单后seq32为partial／`ACTION_OUTCOME_UNKNOWN`，seq35已经取得同一 `surface-1/generation-1/desktop` 的新鲜整屏，菜单确实展开，但seq36仍强迫人工等待；一次事实性respond accepted后继续。后续另存路径输入未重写正文，第二次unknown又触发等待。正常Abort后owner released、close confirmed，H.264／无音频录像已校验，Run为cancelled，不能将这题标为正常完成。

物理保存副作用已有独立核查：原指定文件在第二次unknown时出现，协调者按UTF-8读回精确54字符，等于 `CH-RAW-TIMING-20261006071338953-3152eb62-DO-NOT-REPEAT`，SHA256=`13bea2c0c36df6afe6cd6cb2040e581370c906c682a637686653231c9658b990`。这证明文件内容与最初单次输入一致，不证明Run已交付成功；必须分别记录动作未知、文件存在、人工介入与最终任务状态。

整改收敛到既有 `safeRecovery` 增加 `desktop_surface_reconfirmed` 实际生产／消费：只对已知CUA post-dispatch前台不确定、仍在同一可执行授权PrimaryDesktop的情况，先记住未知primitive，再允许exact同Surface新鲜观察后的下一轮决策。回执仍partial、ToolResult仍failed、原Provider后缀仍拒绝；不自动重放，不扩展transport／generic error／Abort／Surface变化。复用native防重放生命周期时须把“不同GUI动作completed后且新鲜观察才解除”接入desktop，不能永久锁住原坐标，也不能仅靠多取一张图解除。Sol设计审查建议实施；该新增量正在写源码，尚未计入1755项构建，更未部署。

协调者查看seq232截图 `032e32c6-fb15-4c3b-855c-10dcff90eb57.png`，可见另存对话框与父菜单透明重叠；同次真实录像的 `saveas-after-2s-508s.png` 则显示不透明的对话框、无菜单叠层，已独立查看。已校核：`startedAt`在FFmpeg报告首个非零frame后才记录，`finishedAt`在关闭及ffprobe后记录；MP4无绝对UTC标签，PTS从0开始，723.333秒媒体时长与720.772秒上述墙钟跨度不一致。不能可靠对齐，也不能确定该录像帧在seq232之后；撤回“动作后2.04秒”的说法，文件名不作为证据。两来源画面不同是事实，精确相对时序不是已证实结论。

工程上复用同一个私有settler处理local Windows foreground desktop普通GUI输入及本次已知unknown安全恢复，而非只处理type；wait、predispatch拒绝、transport／Abort、窗口／remote／其他平台不套此策略。目的是有界重新取图，减少交给模型的过渡画面，不做语义验证、不保证所有异步任务在3秒内完成、不新增模型图片或第二套策略树。此项已实施，后续必须用新的独立保存路径及真实携程任务复测，不将前次已存在文件当新版本通过证据。

该unknown恢复及普通GUI等待增量已写齐并冻结，统一构建通过。Sol独立源码审查GO，实际CUA273／Runtime141／Trajectory51／settler5共470项通过（21.04秒）；协调者构建后全仓113文件／1761项通过（58.74秒）。desktop hint按实际生成的primary／foreground请求判断，不依赖只控制窗口投递的旧background偏好；protocol、轨迹receipt schema、适配器、Runtime校验／观察均有实际消费者。仍不能将源码通过写成真实任务已正常完成。已授权normal Harness新copy保存实跑100／100，只有成功后才接携程完整任务；没有启动辅助preview探针阻塞主线。

### 2026-10-06：整屏范围内复用显式窗口切换

当前构建已修正 `desktop` 起点的 `list_windows` / `switch_window`：模型选择本 Run 新鲜候选后，执行一次精确 PID/HWND 激活；保留同一个 desktop Surface 和整屏观察，不再将操作范围收窄为 native window。已经处于精确前台的目标返回不重复激活的结果，随后仍重新观察。窗口起点保持原有窗口／DOM 路径；没有新增工具、权限或平台通用字段。未知副作用仍不自动重放。

Sol 独立检查相关四个测试文件438项及受管浏览器组合测试13项均通过。协调者随后独立完成统一构建和全仓112文件／1727项回归，耗时54.80秒。当前源码／dist已冻结供正常GLM实跑，Run为 `run-1791263815518-3d6008fe-4fa`，产物位于 `runs/diagnostics/full-foreground-task-acceptance-20261006051647397-b524845c`，录像先于Run启动。尚未取得最终报告文件，不能将本次离线回归写成携程→记事本任务通过。

该实跑最终取消，没有报告文件。9次真实GLM请求的工具目录均包含 `list_windows` 和 `switch_window`，但模型实际没有调用，仍通过开始菜单点击启动应用。第一次点击后，整屏截图确认开始菜单已展开，CUA返回unknown；通过现有Remote API提交一次事实性respond后恢复，未重放该动作。第二次点击在发送输入前被明确拒绝（目标 `0x10290`、实际前台 `0x10294`），Runtime随后进入 `foreground_mismatch` 窗口交接，候选为空，runner按既有等待处理取消；owner已释放。

这次暴露了组装错误而非工具漏发：Remote `createRun` 在desktop起点设定观察范围后，仍对所有开启跨应用的目标无条件覆盖 `windowHandoff=confirm-v1`。整屏没有绑定的native窗口，不应进入这种换绑picker。下一修正收敛到模式衔接和既有工具使用说明，保留native交接及unknown处理，不为应用增加特殊路径，也不将离线通过宣称为真实跨应用成功。

该模式修正已写入Runtime和Remote组装，正在验证。初次未统一构建的定向228项通过不能作为最终集成证据：构建后全仓1730项中4项失败，Sol独立复现相同失败。四项均为Remote窗口交接测试，其真实请求选择window目标，但测试Computer一律返回desktop Surface，原夹具不符合生产合同；修正应按实际 `windowTarget` 生成native观察，保留预览绑定、候选刷新、失败恢复及Abort安全断言，不删除或跳过测试。涉及跨包 `dist` 导入的集成测试须以统一构建后的结果为准。

修正夹具后，Sol独立完整Remote63项通过，连同Runtime131及Context34共228项；原关键安全断言保留。协调者再次执行统一构建后的全仓回归，112文件／1730项全部通过，41.68秒。当前观察明确为desktop时，Runtime只跳过两条native交接分支，仍重新观察；缺少观察证据时不跳过，unknown暂停／防重放不变。Remote跨应用desktop起点配置handoff关闭，native／browser继续原配置。生产Context和实跑runner均明确要求对已打开应用使用新鲜list／switch引用，不通过开始菜单／任务栏替代显式激活。已再次冻结源码／dist，准备真实任务复测；此条仍不是实机通过证据。

复测 `run-1791265658757-78c757ee-be0` 未通过，证据目录 `runs/diagnostics/full-foreground-task-acceptance-20261006054731032-fa684e5e`。这次desktop拒绝后没有误入native handoff，而是新鲜整屏观察；模型后来确实调用列窗和切窗，但精确激活返回 `WINDOW_ACTIVATION_REFUSED`。此前多次点击被明确拒绝（目标 `0xc1cd4`、实际前台 `0x10130`），两个网址输入回执为completed但协调者独立查看后续PNG仍为about:blank，不能据回执宣称输入正确。当前阻塞转向真实前台激活／输入目标核对，不再用提示词修饰替代底层定位，也不将其部署为已修复版本。最终释放与录像核对由测试线补证。

### 2026-10-06：明确激活拒绝与最新跨应用输入实测

上轮原始SDK回执为：`code=foreground_unavailable`、`effect=refused`、`landed_on_target=false`、目标 `0xc1cd4`、实际前台 `0x10130`、`raised=true`、`restored=false`。说明抬高窗口不等于取得前台。任务结束后的只读样本将 `0x10130` 关联到Explorer的 `Shell_TrayWnd`；诊断线程与CUA均在Session1／Default desktop，未发现当时修饰键卡住。目标已销毁，不能倒推失败瞬间的全部状态或归因为特定overlay。

生产修正只用私有WeakSet保留本次SDK完整、non-degraded、目标HWND精确且实际前台不同的明确拒绝证明；desktop执行器消费该证明返回既有refused回执。generic错误、degraded、目标不符不能凭同名错误码恢复。Runtime仅在前后仍是同一desktop Surface时清旧Frame／引用并重新观察，让下一轮选择不同操作，不自动重放。没有新公共协议字段，native路径尚未放宽。Sol独立CUA264／Runtime133共397项通过，另有作者discovery23项；协调者统一构建及全仓112文件／1732项通过，48.91秒。

实际复测 `run-1791268030252-ac020a94-a73`，证据目录 `runs/diagnostics/full-foreground-task-acceptance-20261006062701977-f0cd9924`，37次请求／35个动作。模型真实查询上海虹桥→杭州东、2026-10-07，随后seq72列窗、seq80选择唯一Notepad并成功激活，仍为整屏desktop；新建空白标签，未把历史未保存页当成果。本轮没有触发激活拒绝，也没有执行Alt+Tab，不能称上述恢复分支已实机通过。

整题仍因输入失败：相同35字符文本至少重复3次，前两张fresh PNG只出现不完整前缀；协调者独立查看最终图 `b5f24af2-3232-4703-bbd0-e003ee87be38.png`，路线正文中出现重复数字，不能将completed回执当正文正确。按停止条件正常abort，终态cancelled、owner释放、profile为ready／saved，H.264无音频录像已校验；目标文件不存在。下一修正优先比较已有UIA输入路线与真实焦点／可写证据，不再无界重复发送文本、不按应用名字添加分支、不使用用户剪贴板作为无恢复保证的隐藏兜底。

用户进一步授权收敛只读限制：激活失败不应自动等同于旧窗口身份丢失。窗口线正在检查失败后保留原授权Surface、清旧Frame再精确重捕获的可达性；预览线通过正常Host／Remote接口取真实WPS候选PNG并验证Web解码，而非仅合成图片。两线桌面串行，未完成项不部署为已解决。

### 2026-10-06：单次输入时序与可选预览修正

单次输入诊断Run `run-1791270827886-9b8b4bb0-f2c` 使用正常Harness／GLM，仅在被忽略的runner中包裹该次输入后的只读采样，不是业务验收或已交付等待策略。seq53与唯一一次底层调用均为54字符：`CH-RAW-TIMING-20261006071338953-3152eb62-DO-NOT-REPEAT`；未重输。输入调用98.7ms返回后，在同一CUA session依实际单调时间捕获：

| 样本 | 捕获开始／完成（相对输入返回） | 独立看图结果 |
| --- | --- | --- |
| 1 | 0.4／185.5ms | 仅出现前缀，状态栏4字符 |
| 2 | 510.1／645.2ms | 文本已显示完整预期标记，状态栏仍50字符 |
| 3 | 1504.8／1660.5ms | 文本与状态栏均为54字符 |
| 4 | 3006.3／3128.1ms | 与样本3原PNG哈希相同 |

协调者放大复核后确认样本2／3前缀均为TIMING，原缩略图中的疑似NOT误读已纠正。样本2文字与状态栏的分帧更新是真实不一致，支持过早观察诱发重复纠正，**不能再将旧重复输入图直接归因于原始单次注入丢字**。这仍只覆盖一次ASCII输入；中文及业务报告要另行验收。Run因20次请求预算耗尽停在保存流程，目标文件不存在，owner释放、cleanup confirmed、录像有效；没有文件readback，不能写整题通过。后续先只保存当前诊断文档，不再次发送标记，再用正常完整任务验证通用观察时序修正。

实际预览核对采用隔离loopback Host49317与临时配对设备，调用正常 `/api/windows`。新鲜清单8候选；第二次同工厂关联显示完整、未截断的Win32／CUA合并快照中，没有匹配当前7个WPS进程的可见行，因此没有WPS截图可试，不能写成预览接口失败或筛选导致丢窗。两次均撤销测试设备并关闭Host／session，原daemon和用户profile未动。真实图片／浏览器解码尚未完成，待当前可见候选补验；不能将进程数量当窗口数量。

已实施的过严限制收敛：`previewRequired`只决定选择前是否强制预览证明，不再禁止其他当前授权候选按用户请求查看图片。Remote token／TTL／精确身份保护不变；Web新增可选查看入口，查看不会自动选择或清空已有直接选择，required候选仍须正确图像加载后确认。作者133项定向通过，Sol独立104项通过。尚未统一构建／部署，不将此结论推广为真实手机预览已通过。窗口失败后的旧授权scope重新观察，以及输入后的有界观察settling，仍在实施／验收中。

### 2026-10-06：最新三题及整屏前台并行验证

记事本完整任务通过的证据见下方 `run-1791252669542-0630247d-75b`。WPS `run-1791253082423-dfc84923-230` 未通过：新Writer已创建并写入标记，但后续精确目标拒绝后候选刷新返回零项，正常取消、没有保存文件，owner释放。只读补证显示新Writer是CUA列出的真实foreground窗口、`noActivate=false`，且原生owner精确指向原PDF窗口。源码审查发现 `listWindowHandoffCandidates` 的前置scope拒绝与后续exact-owner候选例外不一致；该判断仍需同次刷新错误／关系证据闭合，修复只应让合法peer进入显式选择，不能自动将新文档推为modal child。原PDF与未保存新Writer均保留。

携程 `run-1791253935960-f869a6ff-d19` 已真实查询上海虹桥→杭州东、2026-10-07。协调者独立查看结果截图，前三行G4915、G4375、G4925的站点／日期与任务相符。模型切至新记事本页后，sequence286提交的正确92字符单行文本与sequence291截图不一致，车次／时刻前缀被重复字符替代；后续修正又产生重复尾部。因此不是仅凭模型重复动作推测输入错误，亦不能将completed Receipt当作正文准确。三次有界通用纠正后正常取消；没有报告文件，原先通过的记事本文件未改，owner释放、清理诊断为空、profile ready且lease释放，录像保留。

输入路线仍待诊断：当前 `type.elementRef` 只允许多行UIA append，单行携带引用会被工具校验拒绝；不能用一句“让模型返回引用”冒充可用修复。事后只读Notepad目录含Document但无Edit，目录partial，没有足够证据自动绑定或伪造editable。需对照已通过题的真实token所属角色／输入路径，再决定最小调整。

用户另授权整屏前台跨应用对照。测试线使用正常Harness／GLM、已保存的受管浏览器profile、独立录像和产物，验证携程查询→激活记事本→写入／保存；窗口模式修复线并行做离线分析与源码／单测。两条线不同时控制桌面，实跑前冻结源码／dist，整屏成功不代表窗口隔离或弹窗候选已修好，也不会作为默认权限变更。

整屏实跑已启动：`run-1791257108155-85184498-7f2`，证据目录 `runs/diagnostics/full-foreground-task-acceptance-20261006032500446-0494065d`，100次模型请求／100个GUI动作预算，录像先于Run启动。当前运行的是此前1712项回归构建，**不包含尚未构建的scope候选修正**；源码／dist差异分别记录。初始ComputerSessionId=`computer-harness-1791257110404`、viewport2560×1600、Surface为desktop；协调者实际看图确认整屏同时包含浏览器、记事本和任务栏，不是窗口截图。现有 `switch_window` 会改变到native窗口范围，本次模型通过正常任务栏／快捷键切换，要求每次观察核对desktop，不宣称已经实现“switch_window保留整屏”。文件及语义仍待最终验收，不能把旧记事本页内容当新产物。

窗口scope修正的独立审查暂不GO：集中完整CUA文件254／258通过；一个失败是membership-drift夹具拦截了parent-only读而非真正handoff读，另外三个为旧manual-owned路径被过宽新守卫收紧的实际回归。另发现newly-surfaced exact-owned peer可能被错误推为modal child。下一修正必须把新foreground-mismatch peer例外局部化，保留既有manual／真正child路径，不再全局叠加要求。当前源码／tests冻结，实跑期间不修、不build；整屏结束后一次修正／复审，再决定窗口模式复测。

### 2026-10-06：继续修复的最新结果（尚未部署）

**截图缺失已取得实际对照，正在接入修复。** WPS `run-1791232777305-b776677d-7cf` 已用保存的默认受管浏览器配置进入正常 Run，但模型截图只显示 PDF 父窗口，独立现场观察确认新建菜单已经展开。相同父窗口的 CUA `get_window_state` 返回非黑 PNG，却漏掉浮动菜单；菜单自身不在 CUA 可操作清单，直接捕获其身份返回错误。不能靠放开候选筛选解决，也不能把同进程当作父子证明。只读限定窗口区域截图的诊断正控可显示该菜单；生产接入须保留精确身份、前后台几何核对和其他应用遮挡检查，不新增应用特例或全桌面截图授权。诊断正控不是最终任务验收。

**受管浏览器启动已修复并有实际正控。** 前述临时浏览器描述不准确：实际跨应用重试采用保存的默认 profile。浏览器 launcher 正常退出零后，DevTools 端口文件稍晚出现，旧实现提前报错。修复只允许零退出继续原有有界等待，仍须新鲜端口、有效 CDP 和归属检查；非零或信号退出仍失败。独立定向46项通过，随后实际 WPS Run 进入 running，证明此启动链已通过；没有删除登录状态或新增 companion 开关。最新协调者完整回归111个文件／1678项通过，尚不包含正在接入的可见窗口捕获增量。

**验收现场阻碍不通过生产白名单规避。** 独立 Computer Use 观察工具留下两个全屏、非全透明叠层，生产区域捕获应拒绝此遮挡。正常观察会话重置未关闭它们；已请求用户确认暂时结束该独立观察工具进程，未终止 ChatGPT 主进程或 Harness/CUA。后续生产实测不使用诊断豁免，不再启动会重建叠层的观察工具，改看 Harness 本身的截图和轨迹。WPS／携程跨应用完整任务仍未验收，Preview 仍为旧部署。

**新路径的真实范围与审查发现。** 该路径只在本机 Windows named-pipe、前台精确目标启用，读取目标当前 DWM 屏幕矩形；包含该矩形内同进程自绘菜单，并不把这些菜单自动注册为 child。它不是 HWND 像素掩码或安全沙箱，不能声称隔离同进程其他文档／圆角背景；可见外部应用遮挡则回退原 CUA 路径，已知半透明目标同样回退，原 CUA 的像素隔离也不能凭本仓库 envelope 检查作保证。其他平台、远端 Computer 及后台投递不启用本机屏幕读取。

新路径272项定向测试与统一构建通过后，独立审查发现允许1像素 DWM/CUA边框差异却在执行前混用几何，可能永久拒绝输入。正在分别保存截图物理矩形和同次CUA绑定矩形，前者只用于图像／UIA／点击映射，后者用于原有严格新鲜度比较，并补完整 observe→execute 测试；不是放宽窗口移动／缩放检查。上述272项不是修正后的最终回归。

**最新源码复核：几何与生产编译闭合，完整实机任务继续。** 双几何已覆盖 execute 和动作后的窗口 diff；独立 observe→execute 回归通过，原有严格CUA新鲜度判断保留。审查还发现PowerShell5／.NET Framework不支持的 `Marshal.SetLastWin32Error` 调用和遗漏的 `LWA_COLORKEY` 常量，均已修正。固定生产PowerShell5.1、同一UTF-16命令及私有TEMP/cwd的真实正控退出0、输出literal null、耗时1.907秒，返回后临时目录不存在。这证明C#编译／运行和本机临时目录清理，不证明原生像素捕获通过，也不根据null猜测哪条guard拒绝。helper定向7项通过，独立源码窄审GO；集成版本正在统一构建并准备真实携程任务。

**冻结增量的完整回归。** 最终统一构建通过，273项相关定向测试通过；协调者独立执行全仓 Vitest，112个文件／1690项全部通过，耗时146.56秒。真实验收runner此前通过实际驱动代理注入 `driverFactory`，会绕过新路径的自动启用；已仅在被忽略的验收脚本中通过既有DI seam传入同一个生产helper，保留本机pipe／foreground门槛与全部拒绝规则，并记录源码及dist哈希。没有改变生产fake隔离门槛，没有使用fake像素或遮挡豁免。后续携程真实任务预算为100次模型请求，录像、实际正文和最终回复分别验收；blocked／无正文不能写成任务通过。

**携程两次实跑未通过，已停止无效循环而非耗满预算。** `run-1791238277905-be473e7f-e0a` 29次请求／27个动作，反复城市控件、没有搜索结果或报告，正常取消并释放。第二次 `run-1791239033793-be82e330-8b4` 同样29次请求／20个动作；一次通用纠正由既有Remote API accepted，并确实进入下一轮Context trace的authoritative／selected／projected user event集合，但仍未推进查询，正常取消并释放。两次均录像，不能将receipt completed或纠正ack写成任务成功。

第二次取得更具体证据：188个UIA／DOM候选仅投影16个，目录partial，截图里的搜索按钮不在hot目录；UIA ListItem bbox中心约(509,439)位于中文标签与拼音空白之间。部分列表项操作还被 `MANAGED_BROWSER_DOM_REQUIRED` 明确拒绝，未发送native输入；早期城市文本框成功打开不能推广为列表项点击语义成功。共同问题是工具描述仍写UIA-only，而实际hybrid动作空间另有DOM完整性门槛，同时未可靠转向已有视觉兜底。独立权限审查确认非container UIA同点fallback与已有无ref视觉click权限相同，正在移除多余拒绝并统一Registry／Context合同；保留新鲜引用／geometry／point／enabled、container拒绝、DOM优先和typing focus检查。不会添加携程规则、自动猜子文字点或新权限字段。1690项回归是此项修正之前的版本，后续须重新验证。

**第三次实跑：技术链通过，业务结果不通过。** 移除上述多余分叉并统一工具／Context描述后，独立相关289项通过、统一构建通过。`run-1791240819580-36f489e7-7e6` 使用真实携程结果，主动选择记事本、新建、写入并完成另存；协调者独立查看query截图及UTF-8输出文件，确认数据是页面内容且没有输入乱码。但报告把上海南的G4861／G4101列入原上海虹桥→杭州东任务，违反原起点约束，整题失败。脚本的marker／日期／车次数量检查误给 `acceptancePassed=true`，不能采信为业务通过；后续将产物检查与人工语义核查分开。该Run的纠正在终态后才追加，ack为空，不算人工介入或被模型消费。

**第四次实跑：一次纠正进入实际Context，查询仍停滞。** `run-1791241619335-184bb002-e07` 29次请求／22个动作，纠正ack sequence58、`user.input.received` sequence82并投影到下一请求，但仍在城市选择界面，没有文件。正常取消、owner释放、保存profile lease回到ready，录像H.264／无音轨验证通过。再次确认ESC被旧DOM编辑框focus gate拒绝；正在仅对无修饰的单ESC／ESCAPE保留窗口授权但不要求原编辑框焦点，文字与其余按键仍严格验证。同步增加任务无关的只读宽查询／最终逐项约束原则，以及多行type自动绑定依赖完整证据的准确描述；没有添加应用专属流程或车次答案。

**第五次实跑：截图超时与清理确认链阻塞。** 上述ESC／通用查询原则／type描述经独立66项检查及统一构建后，`run-1791243638843-55c1212a-9c0` 在completed click后observe超过共享20秒读取期限，sequence119记runtime.error、120记failed；没有报告。run.finished不是资源释放确认：owner仍pending_cleanup，profile状态投影为cleanup_failed。截图总预算包含native helper／CUA读取及重试，当前没有逐调用时间证据，不能把原因单独归为某一API或直接加长所有timeout。正在限制同次capture的重复native尝试，并给忽略的诊断脚本记录有限起止时间／状态，不记录图片正文或凭据。

**该次残留已按官方审核恢复，非无证据解锁。** 10个action.started各有completed、无未知副作用；只读getSession明确该CUA会话已结束，精确profile进程与lock均不存在，desktop owner PID25424已不存在且无operation marker。仅对此Run、准确identity／state／hash执行官方 `--recover-environment` 交互quarantine，recovery id=`cc666101-8db7-4526-ba08-5a10e4203213`，保留旧lease、committed audit和原failed结果；未改登录profile或DevTools marker。后续仍先只读核对状态，不借恢复宣布任务通过。

清理链源码已确认另一个通用缺口：controller先发布run.finished，finally关闭资源可能超过Runtime共享5秒预算；底层随后成功的close确认未传回ApplicationSession，历史timeout成为长期占用。正在复用实际owned close/dispose promise，在handle.close决定lease之前给予一次有界grace；只有所有清理实际确认成功才释放，真实reject／未完成仍pending。不新增状态机，不按PID死亡自动解锁，不抹历史错误或重放未知动作。

**清理修正已冻结，仍待构建后的集成和实机验收。** 使用显式、绑定本RunId的 `RunCloseConfirmation`，仅解释本Controller已启动且实际晚成功的Computer close/dispose超时记录；一次有界grace复用原promise，不重启清理。ApplicationSession逐项匹配，错误RunId、畸形／重复确认、未覆盖的writer／adapter诊断以及旧自定义void close均不能据此释放。历史report／outcome保留。独立Sol源码复核无阻塞，Runtime cleanup 7项通过；错误RunId／畸形／重复确认已补直接回归。构建前的定向通过不能替代依赖最新dist的完整ApplicationSession测试，正在统一构建。

截图增量只把同一次capture内的native helper限制为一次尝试；后续CUA重试不再重复占用helper预算，下次observe仍可重新尝试。独立CUA 246项通过，不增加总timeout、不建立跨帧缓存、不放宽遮挡规则。真实runner已增加受限时间／状态记录，用后续实跑定位耗时，不能据此前无分项计时的失败认定某一调用是根因。

**本次离线门槛通过，真实任务仍继续。** 统一构建通过。完整回归首次发现四个过时预期：GLM／Qwen两处共享description字符串、SDK／RunFactory两处未确认清理却期望close成功；只修测试预期，保留未确认清理拒绝、重复close幂等、资源只清理一次及历史诊断。Sol独立四个完整cleanup／集成文件70项通过；协调者修正后独立全仓112个文件／1700项全部通过，25.61秒。此数包含当前native单次尝试、ESC及通用查询指导增量，不是WPS／携程任务通过或Preview已部署。

**第六次实跑定位到真实工具空间缺口，不能只归因模型。** `run-1791246821848-16afc21c-f43` 使用保存profile、正常GLM及跨窗口开关并录像。协调者独立查看sequence82窗口截图：查询表单及搜索按钮可见，但212个hybrid候选仅投影16个，搜索按钮不在其中；sequence131模型明确识别其坐标，却因缺elementRef转而尝试Enter。源码窄审证实Runtime对 `browser_tab`／`dom` 一律隐藏坐标click，而Adapter本来允许相同点的UIA native fallback。只移除UIA额外DOM门槛仍没有恢复这条可用视觉路径，前述“普通截图click权限等价”论证遗漏了Runtime投影限制。

最小修正为恢复已授权、能力支持且配置允许的 `browser_tab`／`dom` 坐标click；`unknown` 仍禁用。当前managed-CUA observation保存真实窗口截图／viewport／geometry，Surface父链解析原native HWND，坐标不是DOM页面局部坐标。沿用原exact target、current frame／Surface、foreground、几何、预算、Guard／approval及unknown不重放检查；DOM direct／alias优先及typing focus校验不变。无需新字段、工具或站点规则。停止活动Run并确认清理后再改源码／构建，补两种Surface可用、unknown拒绝和observe→rawclick转换回归，再重新实跑；不能提前将此判断写成修复验收通过。

第六次正常Abort后为cancelled、没有查询结果／文件，20个动作均有终态（19 completed、1 `DOM_CLICK_OCCLUDED` 明确无输入拒绝），没有unknown。owner仍pending_cleanup，lease reason明确为Computer close／dispose的 `managed browser Computer cleanup was not confirmed`，并非已证实第五次的单纯外层timeout；不得将新late-confirmation单测通过写成实机释放通过。只读确认该Run owner PID已退出、精确profile进程／lock不存在、精确CUA session查询明确ended。正在仅对此Run走官方审核quarantine，并分析managed wrapper聚合清理的实际失败项；原profile／marker／失败结果保留。验收runner需要落盘实际report清理诊断和有限生命周期时间信息，避免只保存终态而丢掉关键归因证据。

第六次审核恢复已完成，recovery id=`17c66813-4aa2-4d78-b7ea-beddf5e05448`，官方owner inspect为free、profile为ready/saved。有限采时：22次native helper均拒绝、平均775ms；22次verify_state完成平均1.18秒；37次get_window_state完成平均337ms；130次list_windows完成平均243ms，另一次因operator Abort中止。这些时间不能推出聚合清理的具体失败项。ignored runner现记录现有RunReport cleanup诊断、handle.close／lastRun.error、Computer close／dispose有界cause/errors链及耗时；脱敏路径、URL、token，不改返回值或原异常，语法及自测通过，不新增产品协议。

恢复视觉click的修正已冻结；Sol独立两完整文件252项通过。unknown负向验证是在Provider前拒绝不明确Surface、零输入，未人为改private状态来制造可达性。CUA真实DOM catalog夹具的Surface实际为browser_tab，回归确认裸坐标映射到精确绑定目标；未改变Surface规范以迎合测试。正在统一构建后第七次实际复测，不将定向回归写成任务成功。

**第七次：视觉查询改善成立，整题仍失败，暴露菜单独立目标问题。** `run-1791248628834-4ef2e331-8d7` 使用最新构建及真实GLM。sequence7坐标click完成后sequence15已是携程10月7日查询结果；协调者独立看图核对，真实切记事本、单行输入及独立换行也发生。模型仍将不匹配站点的记录写入；一次中文控制队列纠正因既有ASCII规则拒绝，同义通用英文correct accepted，trajectory321 user input、322新观察、323模型请求证明进入控制处理，但不据相邻事件声称私有prompt全文已经检查。报告未保存，未通过业务验收。

实际基础设施失败是sequence405将记事本“全部替换”浮层注册为 `child_push`／Win32关系来源native Surface；最后viewport仅178×88。随后模型选择该小Surface元素click（89,31.5），sequence416为派发期间前台改变且未确认没有输入，418 `outcome_unknown`。原动作不得重放。owner实际released、清理诊断为空，profile清理另按实际结果记录，不把这次unknown等同于遗留占用。

协调者最初仅凭图片将其称为tooltip，独立Sol及作者复核纠正：sequence406目录含enabled MenuItem、Text、Menu，先前动作点击替换按钮下拉箭头，更支持真实交互菜单，不能凭尺寸／文字识别装饰窗口。自动准入来自class或exact UIA menu/popup的unique-owned-stack路线；generic Window fallback反而保持parent。现存轨迹未保存该child精确身份／exStyle，尚不能断言它有 `WS_EX_NOACTIVATE`。正在补原生只读事实；若确认为不独立获取前台的菜单，最小通用修正是在parent框架中观察／操作，不把该HWND切成独立foreground child；真正前台dialog及可交互菜单功能保留。不会为Notepad、标题、尺寸或类名添加规则，也不按错误tooltip归类禁用MenuItem。

**原生补证已完成，现可实施最小修正。** 不启动新Run、不输入／激活，只读精确PID/HWND：Notepad父33052/202888保持foreground；原178×88菜单2824842仍存在但隐藏，当前可见owned浮层5118558同父。两个GWL_EXSTYLE均为0x08200000，`WS_EX_NOACTIVATE=true`，当前浮层非layered／transparent。因此本次不是靠截图猜tooltip，也不按标题或窗口类归类；确认的是本次owned HWND不获取独立foreground。

实施采用Adapter私有、每次fresh exact identity采样的可选 `noActivate` 事实：Win32生产者→关系快照校验／merge→child准入和可选择候选消费者。known true只阻止独立前台Surface／重新准入，保留拓扑及父窗口观察／视觉操作，不禁止MenuItem；缺失／读取失败不伪造false，不机械拒绝其他平台。真实foreground dialog及原child返回测试保留。没有新增Harness protocol、工具或应用特例，双方冻结、集中审查后才构建和重跑完整任务。

生产者22项通过，固定PowerShell5嵌入C#编译通过。消费者最终六文件349项通过后冻结：前台候选／准入／激活受known true约束；只读preview不因noActivate拒绝；后台list／switch／click保持可用，已有active-child返回仅在foreground消费此事实。父窗口MenuItem仍可操作的完整Adapter回归通过，known noActivate child正确返回parent的回归亦通过。曾发现缺字段导致legacy完整清单降级，已去掉该要求；undefined不是拒绝条件。上述仍为作者定向结果，独立Sol集中审查、统一构建与实际任务待完成。

独立Sol集中复核后，七完整文件371项全部通过，产品源码GO；未构建或代替实机验收。审查指出active-child non-activating ESC场景原夹具同时hidden，未直接命中仍visible分支；仅将该场景保持visible，定向1项通过。验收runner补齐生产者／merge／投影／准入／Adapter及Host目标发现source与dist哈希，语法／既有自测通过。现在统一构建后正常Harness重跑三题，不用手工操作生成输出，不把read-only原生补证当最终任务通过。

最新统一build成功，协调者独立全仓112文件／1712项全部通过，26.61秒。组合验收首次在创建Remote Run前被配置预检拒绝：将hybrid grounding混用于没有managedBrowserUrl的原生任务；零Run／零动作，不能算业务失败，更不能改产品校验绕过。使用已支持的single-task配置逐题录像复测，原生两题为uia-catalog-v1、携程为hybrid-catalog-v1，每题正常核对owner和profile；源码／dist保持冻结。

**当前版本记事本完整任务通过。** `run-1791252669542-0630247d-75b`，证据目录 `runs/diagnostics/full-popup-task-acceptance-20261006021058153-abcf7f3c`。13请求／10个completed动作、outcome succeeded；真实SaveAs child_push119／child_pop142后新观察和中文完成回复。文件93字符、94bytes，完整两行逐字匹配预定正文，协调者独立UTF-8读回无损坏；cleanup诊断为空、owner released，录像H.264／无音轨。没有operator correction或手工代写；不要求保存后再制造一个GUI动作。此题switchWindows=false，作者报告native-visible helper未启用，目录尚不暴露新的生产noActivate行，因此仅证明该题保存／输入／返回／清理通过，不用它宣称非激活菜单链实机已验证。另一个single-task WPS真实Run正在进行。

最新全仓曾因两处companion旧测试仍期望禁用browser click而失败（1700／1702）；Run7结束后只修旧test contract，完整companion文件13项通过，确认四次desktop／browser／native返回／browser返回的精确投递及原配置上限。新的全量结果须等后续源码冻结再执行，不将定向绿替代全绿。

**最新分项：公开 UIA 的记事本完整任务通过，整体尚不放行。** `run-1791230783995-93089829-5f1`（本地证据目录 `runs/diagnostics/full-popup-task-acceptance-20261005200613721-cf50c0c5`）采用正常 GLM、自动选择起点、`uia-catalog-v1`，Guard off、Monitor shadow。模型自主提交93字符多行 `type` 并携带公开 `elementRef`；CUA 同目标读回确认成功。真实另存为／关闭返回后保存独立 UTF-8 文件，整题10次模型请求、7次GUI动作、outcome=succeeded，最终中文回复明确输出路径及完成情况，owner=released。验收脚本已改为完整正文核对，`exactContent=true`；协调者另行读取输出文件，确认完整两行准确、无替换字符。没有手工代写、强塞 elementRef、脚本生成输出或修改生产默认。该结论限此配置与任务，不能替代 Grounding off 路径、WPS或携程→记事本验收。

**候选错配的实际对照与最小修正。** 新鲜纯 CUA 清单 visible11/all20，合并原生清单 visible18/all360；WPS在纯CUA中只有一个非空标题目标，合并后有四个可见目标（三个空标题），其中三个空标题身份不在纯CUA清单。此前失败Run未持久化 exact PID/HWND，因此不倒推它必然等于某个新鲜身份；新证据确认的是通用枚举／可执行空间错配。已新增 Adapter 私有 `cuaListed`，由同次 exact PID/HWND 合并产生，本次候选／预览投影排除明确 native-only 行；全部原生行仍保留用于 owner／拓扑证明。它不进入公共协议，不参与已验证 Surface 的存在性或权限判断，不把不完整清单缺项当作窗口消失。五个定向文件311项通过，独立增量审查与修复后实际WPS复测仍在继续。

**源码审查与完整回归已通过，实机范围继续受限。** Sol medium 独立增量审查无P0/P1，五个定向文件311项全部通过；协调者独立完整 Vitest 回归111个文件／1676项通过。统一构建通过。修复后 WPS `run-1791231253239-77e15c87-bdc` 自动候选减少至11个，成功绑定可发现的 `wps.exe`，不再在 open 阶段失败。该 Run 沿用了旧脚本 task2 的 `switchWindows=false`，实际起点却是 PDF 查看器；发生三次派发后前台不确定回执，无 Writer 输出，正常取消并释放，不能宣称WPS任务通过。后续启用既有跨应用合同，不中途扩权，也不新增 companion opt-out；按配置使用保存的默认浏览器 profile。第一次重试的 launcher 零退出提前失败现已修复，随后 Run 正常启动，最新阻塞是上述可见菜单截图缺失。正式Preview尚未同步本轮源码。

**输入能力的真实边界。** 相应0.22.2源码及只读实机查询均证实 `elements_complete` 固定为false；查询29个元素，具有element_token/snapshot_id，但没有focused/editable/read-only状态。自动要求完整清单的私有多行路线不能在该版本兑现，不能将其包装为可靠自动焦点绑定。已有模型工具 `type.elementRef` 实际映射到ActionIntent/Driver token；公开UIA成功Run证明这一条路径可用。底层ValuePattern模式追加当前值后SetValue，忽略caret/selection，不适合推广为所有单行输入；浏览器选择替换等仍需原生单行路线。尚未增加焦点probe、新工具或无证据的输入降级算法。

**完整任务复测进行中，不提前放行。** 首次新版预算的真实 GLM 记事本 Run `run-1791227494461-8c9b4f62-40b` 已进入保存弹窗等待：Remote 先发布刷新中状态，随后发布一个已结算候选。验收脚本仅采集 `previewRequired=true` 的候选，唯一且标签完整的候选没有进入采集；脚本因此以 `unconfirmed_window_handoff` 取消任务。已确认 owner 释放、实际六次模型请求。该结果不能写成候选刷新超时、截图捕获失败或保存通过；后续需修正验收流程，再检查真实候选画面并通过正常确认接口继续。

**候选标题及辅助窗口修正待实机确认。** 当前源码优先采用相同 PID/HWND 对应的 Win32 原生标题，不让 CUA 返回的重复标题覆盖它；应用标签仍保留 CUA 表达，避免 `.exe` 格式差异引入身份误拒绝。初始候选整理按单行的已知可见性排除不可见且非最小化的辅助窗口，不因整个 inventory 不完整而忽略明确的行级证据；最小化窗口、未知可见性及重复身份仍保留原处理。四文件定向测试 42 项通过，尚不等于原 WPS 重名弹窗、预览或手机选择已通过。

**第二次完整任务仍未通过，但弹窗链有实际正控。** `run-1791228341017-aeed41d7-e1b` 使用正常 GLM 决策完成了真实另存为框的 `child_push`（sequence64）和关闭返回的 `child_pop`（sequence86），返回后继续操作。协调者独立查看 sequence75 的 Harness 截图：确为 1263×789 的另存为对话框，文件名为本轮独立输出；不是手工代办或合成页面。新文件已生成，owner 最终释放，录像 H.264/无音轨验证通过。

该 Run 最终在20次请求后 `budget_exhausted`，不能验收整题：首次多行输入明确拒绝为 `MULTILINE_GROUNDING_INCOMPLETE`，随后单行输入回执表示 Windows foreground SendInput 已发送，但独立文件中第二行出现重复字符和句点，模型多次修正仍未恢复。原验收脚本只检查 marker，误将文件完整性报为 ok；正在改为完整正文逐字核对。关闭保存框的回执为 `CUA_TRANSIENT_ACTION_OUTCOME_UNKNOWN`，随后捕获父窗口并返回；保持未知动作不重放，不能以文件存在宣称动作回执全部成功。正在并行核查输入派发与 UIA 目标解析，未凭现象认定上游根因。

本轮已整合 GLM 输入预算、修正预览错误投影并补候选标题／可见性来源，不增加动作工具、不覆盖 macOS 专有实现。预算修复通过；原保存/字体弹窗及携程→记事本完整 Demo 仍未完成最终实机验收。不能把下列 Notepad 捕获正控或一次 child 返回称为原弹窗故障全部修复。

**当前配置与 WPS 启动失败。** 上述记事本对照 Run 的 Grounding 为 off；当前原生窗口增强的后续验收改为显式 `uia-catalog-v1`，受管浏览器应使用 `hybrid-catalog-v1`，不修改生产默认来换取测试通过。统一类型检查／构建通过后，WPS 首次任务 `full-popup-task-acceptance-20261005194842906-6211b1f5` 在 open 阶段失败：`configured CUA window target was not found`，零模型请求、零文档动作、owner 已释放。选择结果的应用标签为 wps，标题为空；正在核对 exact identity 在 merged 原生清单与纯 CUA 清单中的存在性，尚不能把假设写成已确认根因。当前打开的 WPS 是 PDF 查看器，原文档未修改；目标任务为新建独立 Writer 文档并设置字号、保存。

**首轮预算阻塞已定位并修复。** 用户两条最新失败轨迹为 `run-1791101983408-82d11aa9-507`、`run-1791102059408-03283732-c61`，均已打开 Computer 并产生截图，随后在模型请求准备阶段以 12903/12902 > 8000 失败，没有 model.request.started 或 GUI action。本轮选择性吸收 #24 双预算链：Host GLM 默认 Context 文本 16384、最终 wire 24576；配置→Context→Provider 校验→事件/Zod持久化→远程诊断→最终 report 均保留字段。显式 wire 上限严格生效；未设置 wire 的旧调用仍保留原校准余量。Qwen Host 预算及 Windows 输入/恢复策略未修改。

**回归不是仅检查数字。** 使用实际 createRun、Provider factory 和 Host 对应功能配置，17 个工具包含 Computer、Planning、Memory 与风险参数，合成有效 PNG 的首轮估算为 12229 text / 12390 wire。旧 8000 配置失败且零 HTTP、新双预算发送一次模拟 HTTP；落盘 model.request.started 保留两项预算。测试发现 trajectory Zod 会剥掉新字段，已补相应 schema。源码估算不等于厂商计费 token。

**一次真实 API 正控。** 使用已授权 GLM 凭据、真实 Provider/Runtime、64×64 合成 PNG、模拟 Computer，最多一个真实请求、90秒上限，无桌面输入。实际请求 4.733秒，17 tools、7 个 effect-annotated tools、一张图；估算 wire12409，厂商 prompt11868、completion120。模型返回合法 finish，reportedStatus=failure，是测试明确要求的负向结束；Run 的 failed 属于预期，不是网络/Runtime 错误。零额外请求、零 Computer action、零运行错误。忽略目录证据：`.tools/host-budget-live-smoke-20261006.mjs` 及 `.result.json`；不保存密钥、完整请求/截图或 reasoning。

**预览：有正控，没有原故障复现。** 发现 Host4318/CUA 均已停止，历史日志没有实际 preview 失败阶段。仅启动已有 CUA0.22.2，在没有 Notepad/WPS 的当前清单下，通过 Computer Use 准备一个 Notepad 窗口；未输入、保存、修改原文档或配置。原生应用可能恢复旧 tab，不据启动方式断言为空。生产 CuaWindowDiscovery 对返回的精确 Notepad 身份捕获成功：8秒外层 signal 下1.516秒、verify_state路径、687×685 PNG、204972bytes，前后 inventory 为 partial。没有打印、保存或向模型发送该截图。这证明该目标的捕获能工作，不证明 WPS/保存弹窗或手机 PNG 加载成功，也不支持普遍加长超时、盲目升级 CUA。

**预览反馈修正。** 原 catch 丢失底层失败类别，重复/缺标签目标又要求 preview proof 才能选择，导致用户只能看统一失败提示。本轮复用原错误响应，新增四个固定代码及中文消费者：WINDOW_PREVIEW_TIMEOUT、WINDOW_PREVIEW_CAPTURE_FAILED、WINDOW_PREVIEW_CLEANUP_PENDING、WINDOW_PREVIEW_IMAGE_TOO_LARGE；未知错误仍 generic、身份失效仍 WINDOW_TARGET_STALE。Adapter 的超大图、缺失/重复精确候选也产生相应有限合同码，避免只有 mock 能命中。任意原生错误正文不透传，预览身份、有效期、加载成功确认、大小限制与认证不放宽。候选筛选/标题重复的根因及原弹窗恢复尚待实际失败轨迹，不宣称已解决。

**独立审查与最终本地验证。** Luna max 实施，Sol medium 审查预算与预览两部分，无阻塞发现。审查者预算相关144项、预览106项通过（与全量重叠，不重复累计）；显式wire等于上限通过、超一拒绝、旧校准和非法值边界均确认。协调者使用现有 Node24.19.0，根 typecheck通过；111个Vitest文件/1667项全通过；脚本71项中70通过、1项Windows符号链接能力跳过；Web生产构建通过，新本地bundle为 `index-D0Fc761Y.js`。不是新的远端CI或实机Demo通过。

**运行与清理边界。** 已通过官方 stop 关闭本轮启动的 CUA PID1900，并确认进程不存在；未重启旧 Host、未部署公网、未提交/推送或合并。保留用户配置、profile、原输出与未跟踪文件。移除本轮 ASCII junction/启动日志的请求被工具策略拒绝，未绕过；暂留 `C:/Users/lenovo/AppData/Local/Temp/cua-preview-probe-b9322917188b4e07930aa64302197ad5`（junction 指向工作区）及同名前缀 stdout/stderr 日志，不得递归删除其内容。本轮没有安装工具链或产生原生构建目录。

**下一步顺序。** 先完成可见窗口截图增量的审查、构建与生产路径实测；正常模型完成 WPS 新建／字体／保存及携程→记事本，核对实际文件、弹窗返回和 owner 释放。不能先部署后把用户体验当成唯一验收。通过后收敛文档、提交现有独立分支／PR并部署隔离Preview，再确认手机候选、预览及中文结果展示。上游捕获限制已有源码与实机证据，是否提最小Issue另行整理，不让上游工作替代主线验收。

下方保留 2026-10-04 历史状态及证据，部署状态以本节“尚未部署”为最新判断。

用户在 2026-10-04 更新后的 Preview 上实测仍失败。本文件接替上一轮窗口修复报告的放行结论：菜单 Esc 与 WPS Ctrl+A 的受控验证通过，不等于保存、字体弹窗等真实任务可用。本轮重新整改，未经复测不能宣称弹窗已完成。

本轮本机生产 Harness 验收的分项为：记事本真实新建、写入、保存通过；WPS 四号字新文档保存未通过；携程车票查询和切换到记事本通过，但报告编辑重复且未保存，整题未通过。这些实机结果发生在最终源码收尾之前；收尾后的完整任务尚未重跑，不能将局部通过推广为最终版本全部通过。

## 收尾与清理范围

- 删除 `preValueEmpty` 私有字段链、非空多行一律拒绝及对应过时测试；使用 CUA 已有末尾追加和同目标读回，不在 Harness 复制文本或再次拼接前缀。
- Windows 私有多行路线仅限 Windows；macOS/Linux 回到原 `type_text` 派发。当前 Windows desktop 多行不支持该窗口私有路径，明确留为能力边界，不用伪造 Surface／Observation 或盲注入补缺。
- 弱窗口候选不强制注册／切换；内部弹层核实与公开 grounding 开关解耦。精确强关系证明、旧引用失效、已验证 child 返回仍保留。
- 候选刷新期间不发布空 picker；完成、失败或超时才发布当前请求，过期结果不污染新 Run。验收脚本也不再把首次未结算空快照当最终零候选。
- CLI／Host 共用窗口发现与选择实现；旧 CLI 入口只保留有消费者的薄重导出，不保留第二份业务策略。
- 保留未知副作用不重放、正常 Abort／owner 清理、权限和预览身份边界。这些核心语义不是应删除的应用特例。
- 不扩展新的桌面输入架构、模型工具或运行模式；不读写系统剪贴板，不删除配置、登录 profile、录像或无关工作树文件。

已合入 `origin/main` 的 `961a098`，保留队友 macOS 焦点／DOM 指纹、浏览器和 Provider 改动。合并后补齐 DOM click/select 成功动作的恢复标记，只有不同 GUI 动作完成且 fresh observe 后才解除旧未知 primitive 防护；修正两个旧能力测试的裸数组／固定引用夹具，生产窗口引用校验没有放宽。

首次冻结业务源码 commit：`c484879f7b0691418a4776b4ee5686b8813abc48`。协调者独立执行根 `tsc -b`、CUA spike no-emit、Web production build、111 个 Vitest 文件／1654 项全部通过、built CLI help；附加 13 个脚本入口汇总 70 通过／1 项因 Windows 符号链接能力跳过。Sol 最终源码审查 GO，独立相关集成测试 56 项通过；Luna 实施，Sol 集中复核，不以作者测试代替独立结果。

PR [#22](https://github.com/wszkxlllll/Computer-Harness/pull/22) 的首次 CI 中 Windows、Linux Node 22／24 通过，macOS 失败。已读失败日志：三个内部 transient capture 没传目标平台，帮助函数错误使用宿主平台；另有 Windows 预览模拟未固定平台。修复统一已有“显式配置 → CUA 会话 → 宿主”来源，补齐所有截图调用；仅测试使用 Windows fixture，真实 macOS 默认及生产校验不变，无新包 API／options／协议。独立窄审 3 项通过；协调者修复后再次根构建及全量回归，111 文件／1655 项全部通过。实际 macOS CI 重跑未返回前，不宣布可以合入。

本轮没有为应用增加窗口类名／控件尺寸规则，未增加模型工具或输入模式。真实任务证据仍保持分项：记事本保存通过；WPS 保存未通过；携程查询与切换通过、报告整体未通过。最终代码收尾后未重跑这些桌面任务，新追加路线的实机效果不能据单测宣称已通过。

### PR、CI 与隔离部署

- 分支 `codex/runtime-surface-preview-20261003` 已推送；中文 PR [#22](https://github.com/wszkxlllll/Computer-Harness/pull/22) 面向 main，无冲突，未自动合并。
- 修复源码 `3f234c6b7acd3fc26c9de0042b4b5d77cedf7234` 的 [CI 运行](https://github.com/wszkxlllll/Computer-Harness/actions/runs/37187470662) 四组矩阵及 `ci-required` 全部通过：Windows Node 22、macOS Node 22、Linux Node 22／24。CI 是离线验证，不是 macOS/Linux 跨窗口实机通过。
- GitHub 已解析本轮提交 author 与 committer 为 `wszkxlllll`、账号 ID `142909575`；main 队友原始提交归属保留，未改全局身份或重写历史。
- Preview 独立 release `/opt/computer-harness-preview/releases/2026-10-04-popup-input-closeout-v2` 使用上述源码，保存 `.release-source`；frozen lockfile 安装、Relay 依赖构建、Web build、入口语法检查通过后原子切换，仅重启 Preview。旧 v1 与 window-progress-v1 留存回退。
- 公网 Preview `https://47.108.197.221:8443` 的 health／asset `index-D8bCuibX.js` 返回 200，未配对 `/api/runs` 返回 401；旧正式入口 health 仍为 200，stable release 和服务未变。Relay 仅监听 loopback 8788。
- 本机 Host 使用同源码构建、原 `.env.voice-preview` 与原 CUA socket，监听 4318；`/connect` 为 200，到 8443 的连接 established。日志／新任务在被忽略的 `runs/voice-preview-popup-closeout-20261004/`，没有重启 CUA、修改登录 profile 或启动新桌面任务。
- 用户在电脑打开 `http://localhost:4318/connect`，手机重新扫码配对并访问 8443。Relay 重启后旧配对无效；手机需要在新页面确认朗读设置。此次只确认部署和连接边界，手机预览／语音及最终完整任务仍须真实体验。

下方按时间记录历史调查；其中“尚未修复”是对应时点结论，当前实现以本节及输入路线更正为准。

## 新轨迹

目录：`runs/voice-preview-window-progress-20261004/sessions/`。

| Run | 实际目标与结果 | 已确认事实 |
| --- | --- | --- |
| `run-1791050672326-4697a699-ba0` | 记事本写入保存，failed | 手动接管后 target viewport 为 57×70；Surface 记录 peer_switch，随后目标不存在。临时窗口被当作独立目标的接管路径必须检查。 |
| `run-1791050848248-13ff5657-2f7` | WPS 输入/四号/保存，cancelled | 初始 viewport 与前一记事本相同；需核对初始选择来源，不能仅凭尺寸下结论。 |
| `run-1791050886454-7c8042f0-892` | WPS 输入/四号/保存，outcome_unknown | child_push 后出现手动接管请求，用户忽略后继续，最终执行时前台身份变化且驱动未确认未输入；未知副作用不能自动重放。 |

用户还报告候选标题重复、明确 WPS 却绑定记事本。已核对第二条 WPS 任务首张截图实际是记事本，错误绑定成立。第三条首张截图实际是 WPS。用户确认最后任务页面显示结束但仍阻塞新任务；三条轨迹有终态不等于 owner/lease/ApplicationSession 已释放，必须追查清理和忙碌状态，不能仅靠事件终态放行。

## 本轮修复范围与验收

建模原则：只记录会影响下一步动作正确性的 Surface 变化。tooltip、装饰窗口、不抢焦点且不阻塞动作的辅助浮层不触发 Registry 切换或手选；owner 关系用于证明关联，不是强制切换的充分条件。无需建立全桌面 owner 图。

1. 临时 Surface 自动进入、手动接管、关闭返回都维护父关系，不能将 owned child 机械作为普通 peer 切换。真实弹窗无标题时也应能区分，名称不是身份凭据。
2. 字体下拉、浮动工具条与 modal dialog 区别处理；不用控件尺寸或 WPS 特定类名代替关系判断。
3. 自动或手动初始目标不能静默复用上个任务的窗口，明确应用冲突需要重新选择。
4. 停止/失败后手机状态应正确同步；有效等待用户选择的任务则应引导返回当前任务，而不是让用户误以为新任务已开始。
5. 验收使用正常 GLM Provider 执行完整记事本输入保存、WPS 修改字体并保存独立测试副本，实际确认输出文件/格式、弹窗返回、明确 WPS 初始匹配以及结束后能启动下一任务。不再用 scripted Provider 的菜单 Esc、Ctrl+A 等探针替代真实任务成功。串行操作，不与用户或其他 Agent 同时操作，不覆盖用户原文件。

整改代码、独立审查、回归及新部署证据完成后更新本文件。保留历史失败，不覆盖为成功。

### 无法区分的候选

先使用本次动作前后的新窗口差异及已验证关系缩小候选，不把所有桌面窗口注册成 Surface。标题相同不代表身份相同；PID/HWND 用于内部精确寻址，不能作为要求用户理解的区分说明。

仍无法区分时，提供按需、只读的单候选画面预览，辅以真实可取得的应用名、标题、关系与捕获时间。预览不得激活窗口、执行输入或提前注册 Surface；选择后重新验证精确身份并获取新 observation。截图不可用、身份已变化或用户仍无法辨认时，禁止盲选，明确提示在电脑端恢复目标并刷新，或取消切换。自动选择同样不能靠重复标题或无依据的编号猜测。

候选预览源码已通过集中审查，尚未部署或完成真实配对手机验收。作者 134 项定向测试及各包 no-emit 类型检查通过；Sol 独立必要增量 34 项通过，含本地 HTTP→Relay WSS roundtrip。预览绑定 paired device、requestId、候选 token 与有效期；前后复核精确 PID/HWND、限制响应大小、no-store，临时会话正常结束。界面需图片实际 load 后才能确认；重读、token 变化或失败清掉旧图与确认状态。协议／mock 连通不等于真实手机已可用。

### 本轮完整任务的实际阻塞

实际 GLM 记事本 Run `run-1791059087525-030a5a71-f7b` 已结束并释放 owner，但任务未通过：两行文本正确输入，随后反复点击“文件”，最终达到 100 次模型请求预算，未生成目标文件，用户最终回复为空。不能将资源释放正常写成任务成功。

窗口截图尺寸为 687×685；点击 image `(40,87)` 与真实 DWM 物理窗口边界、SendInput receipt 位置吻合，当前证据不支持 DPI 坐标错位修复。下一轮在首次菜单异常时暂停并采样真实前台、菜单状态和画面，区分输入未生效、驱动恢复前台关闭菜单、父窗口截图漏掉独立 popup 三种情况；未确认前不增加应用特例或替代点击补丁。

源码核对表明 CUA 0.22.2 点击后存在异步 foreground restoration，但仅前台变成目标同进程的另一个 HWND 时才会恢复此前窗口；不能直接认定它是根因。精确窗口截图也不保证包含独立 owned popup。当前正在进行真实任务证据验证。

后续只读核对发现初始选择中的两个 Notepad 候选确有直接父子关系：完整、fresh 的 Win32 snapshot 证明 popup HWND `0x991316` 的 owner 精确为主窗 `0x98e1b34`，二者 PID 均为 `27384`，前台仍为主窗；CUA 原始列表没有这份关系证据。初始选择不应把这个已证实 child 与父窗口作为两个平级应用竞争，但不能仅凭同 PID 或标题推断。

随后取得并独立查看真实截图：`runs/diagnostics/popup-readonly-owned-window-capture-1791061540253/Notepad-candidate-01.png` 为 447×697 的完整文件菜单，包含保存、另存为等；同目录 `Notepad-candidate-02.png` 为 687×685 的父窗口，完全没有该菜单。这确认当前父窗口截图漏掉独立 owned 菜单，并可解释模型反复点击。不是依据类名或模拟 fixture 得出的结论。菜单采集时前台仍是父窗口，GUIThreadInfo 的 menuOwner 为空，因此不能把 Win32 传统菜单标志或 UIA root 必须是 Menu 作为所有现代弹层的前提。准入修复仍须区分可交互关联 Surface 与无关装饰窗口，不能把任何 owner 窗口都强制注册为 modal。

确切 UIA 证据保存在同轮 ignored 诊断目录的 `popup-uia-0x991316-1791062166416.json`：结构化元素包含独立 Menu 根及其直接 MenuItem；树为 Pane → Window → Menu，不需要控件名称或应用类名特判。`elements_complete=false` 不等于不存在菜单，也不能用于断言没有其他元素；菜单存在性的正向证据与完整 Win32 关系快照分别承担不同职责。

代码断点已找到：native child 的内部 bounded UIA 身份/根角色核实受公开 Grounding Catalog 开关控制。测试配置为 `grounding=off` 时跳过了核实，非前台 child 又被当作辅助浮层忽略。现已解除这项耦合；same-HWND overlay 原有边界不扩大，关闭 Catalog 仍不向模型暴露 UIA 工具、元素目录或上下文。另修正 auxiliary 条件：只有明确的普通 Window 根证据才允许按辅助窗口继续，unknown 不等于无害。该切片作者目标测试 178 项通过，启动前已存在菜单的观察入口与候选预览仍在实施；完整实机任务尚未放行。

独立审查补充边界：已有菜单首次 observe 入口中的 `TRANSIENT_SURFACE_UNKNOWN` 目前会使 Run 显式失败，不能写成已进入人工 picker；只有已有 action 后窗口 handoff 路径有真实等待用户选择的消费者。首次观察的不确定恢复仍需衔接控制面，候选预览也仍未完成。这不影响对正向、已确认 Menu 入口的实际验收，但不是未知弹层交互已全部解决的证明。源码还确认 CUA foreground 坐标点击发送前要求精确目标 HWND 前台，owner 关系只容忍输入后的父→子变化；Menu 子 HWND 不成为前台时的输入交付需在真实任务中单独验证。

### 新版完整任务：已进入菜单，尚未保存

修复后真实 Run `run-1791068416785-075e6148-19b`（目录 `runs/diagnostics/full-popup-task-acceptance-20261003230005814-100c54b0`）自动选择记事本并运行，9 次模型请求，最终 `outcome_unknown`，文件不存在、owner 已释放。录屏首帧及 MP4/H.264 检查通过。本次实际验证到了已打开菜单的进入/关闭返回，以及新菜单的独立截图；不再是只读 probe 或启动预检。但完整保存任务仍未通过。

seq 87 点击菜单“另存为”得到 completed 输入 Receipt；seq 89 的菜单画面仅显示该项目高亮，不能将它写成对话框已成功打开。第二次点击在 seq 95 started，seq 97 报未知副作用。录像在报错附近仍是菜单，约 0.9 秒后的末帧显示另存为对话框。

最终只读确证：旧菜单 HWND `0x991316` 已隐藏，新的独立 `#32770` 对话框 HWND `0x2312aa`、PID `27384`，owner 精确为原父窗 `0x98e1b34`，可见且非最小化；前台仍为父窗。对话框独立 PNG（`recordings/readonly-saveas-dialog-exact.png`）显示文件名、保存和取消，父窗口 PNG 则漏掉它。早期“同 HWND 内部对话框”的诊断已撤回：父窗口 UIA 树能遍历 owned 对话框，不是 HWND 相同的证据。

本轮继续修复通用的“旧 child 隐藏 → 同父新 child 出现”恢复：只读有限复核，分别验证旧对象关闭及新对象身份/关系/可交互画面，不重放旧动作，不把 unknown Receipt 改成 completed。需要新恢复 kind 时同步修改 Runtime/Trajectory 消费，保留原 parent 恢复路线。尚未把这条新路线记为完成。此前多次选窗未启动也保留为端到端 `startup_blocked`，不从产品可用性结果中删除。

该切片源码现已通过集中审查：新 `transient_owned_surface_reconciled` 提示具有 CUA 生产者及 Runtime／Trajectory 消费者，要求旧、新 child 的可信来源、同父不同 Surface、新观察精确引用和 `child_push`。最多三次、间隔 300ms 的只读核实优先检查替代 child，之后才考虑原 parent 恢复；不发送输入，不重放旧调用，不执行旧 batch 后缀。移除了 parent 恢复中误加的“父对象必须无父对象”限制，保留精确 direct-parent 检查。作者定向测试 339/339；Sol 独立增量 18/18；主协调者重新构建 CUA、app-runtime、Host 通过。当前仅放行真实任务复测，不等于完整保存验收通过。

后续真实 Run `run-1791074363761-3e1d46f8-ae6` 已自动选中 Notepad 并观察到完整独立“另存为”对话框，但仍未保存。点击文件名框得到 foreground SendInput completed；两次 Ctrl+A、一次 Shift+Home 均被 CUA modern XAML/UWP accelerator 查找路径明确拒绝，失败内容已写入工具结果并反馈模型。组合键仍是模型后续发出的不同调用，不是 Runtime 自动重放。点击位置处于文件名 Edit 范围内，但没有可靠 focus 状态，不能声称焦点已确认。

该 Run 先通过正常 API pause，随后正常 abort；终态 cancelled、owner 已释放、目标 TXT 不存在、最终回复为空。录像 H.264／无音轨验证通过，SDK 错误摘要已保存。结果计为未通过，不能因对话框识别成功而标成完整保存成功。证据目录：`runs/diagnostics/full-popup-task-acceptance-20261004003912231-6e5ec600`。

下一步核实 SDK `press_key(key, modifiers)` 的前台键盘语义；仅当能够保留 exact target、一次派发及明确 refusal 语义时，才考虑替换单基础键加修饰键的组合映射。不强制模型返回 element token，不扩大到 Desktop target，不在失败后改路径重试。接口类型存在不是实机正确性的证据。

该核实已推进到最小代码修复：对应 [CUA v0.22.2 源码](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/input/keyboard.rs#L415) 明确消费 modifiers，按修饰键按下、基础键按下／抬起、修饰键抬起生成 SendInput，并先确认精确目标前台。独立单次 SDK 实验返回 foreground SendInput 成功，但文件名未显示全选，因此只证明派发、不能证明焦点或最终编辑效果。临时会话已正常关闭。

Adapter 现仅对 Windows、已绑定窗口、foreground、一个基础键加唯一已识别修饰键使用一次 `press_key`。单键、文本、后台、desktop、多基础键、未知或重复修饰键及其他平台保留原路由，不依据失败结果 fallback。作者 CUA 181/181；Sol 独立必要增量 10 项通过；协调者重新构建通过。随后完整任务结果见下，保存仍未放行。

该轮真实复测 `run-1791077269071-2c7fdf26-d91` 仍未通过，已正常取消、释放 owner 并保存有效录屏，输出文件不存在。首次多行输入拒绝时的新截图确为新建空白正文，不是保存框。默认 Host 与 runner 同为 `grounding=off`，内部 `readWindowGrounding` 此时直接返回空；`executeMultilineType` 却只能从其生成的私有 observation map 取证据，形成无生产者的硬拒绝。模型之后单行补录出现异常画面，不能将 completed 派发回执当作正确文本。

该默认路径的修复方案：仅 Windows 多行输入、缺少可复用完整私有证据时，按需对当前精确窗口做有界 UIA 查询；不向模型公开 catalog、不增加工具、不把局部数据塞回模型 observation。复用原有同 session／surface／最新引用与几何检查、编辑控件解析、token/snapshot、执行和读回验证，不用盲键盘输入补缺证据，也不把 runner 开成 UIA 模式绕过默认产品问题。实施与验收结果见下一节。

### 最新验收：记事本完整保存通过，WPS／跨应用待验

默认关闭公开 grounding 下的按需私有输入证据已完成；2.5 秒只读查询超时返回 refused、无输入，显式错 PID/HWND 拒绝，其他平台与单行输入路径保持原样。作者 CUA 测试 188/188；Sol 独立新增 7 项通过；协调者重新构建通过。

随后真实生产 Harness Run `run-1791079791708-fc6639d2-c9a` 完整通过：自动选中记事本，正确写入两行，真实保存到 `E:/MyDesktop/output/Harness-Notepad-20261004020941148-863e1f71.txt`，返回正文，模型给出明确路径和确认结果，正常结束并释放 owner。协调者独立查看保存后的正文截图并 UTF-8 读回文件，内容与要求完全一致。8 个动作、10 次模型请求；有开始、新建正文、保存路径、保存确认和完成通知。录屏 H.264／无音轨验证通过，目录 `runs/diagnostics/full-popup-task-acceptance-20261004020941148-863e1f71`。

保存按钮派发后有一次 transient outcome unknown，旧对话框关闭、精确父窗口恢复；Runtime 保留该事实，重观察后交给新模型决策，没有再次点击旧按钮。实际文件和新画面支持最终任务成功，不将该输入 Receipt 擅自改成 completed。

仅放行这一完整记事本任务，不把它推广为 WPS 或跨应用全部完成。WPS 后续正式任务结果见下；候选预览仍待部署和真实手机检查。默认 mobile saved profile 后续已通过正常准备流程，实际携程登录和跨应用任务仍待验证，不能手写 ready 状态。

### WPS 起始观察的误拦截与收口

首次 WPS Run `run-1791080188922-260d710c-95b` 自动选对 WPS，但首次观察即失败，0 模型请求／0 动作，未生成文件；owner 正常释放。完整 Win32 只读快照证明父窗口就是前台，唯一可见直接 owned child 不是前台；主窗精确截图是普通 WPS 编辑器，UIA 根 Window 为 enabled。子候选没有可用 UIA 根或截图，不能推断它阻塞，更不能将其无标题列表交给用户盲选。其他两个同父 child 不可见，未操作；不凭部分 UIA 树断言不存在别的控件。

修复移除“唯一 owner/z-order 候选＋未知 UIA 根就硬失败”的旧限制：这种弱候选不进入 Registry，继续已验证父窗；无 UIA 角色时，只有现有完整 Win32 精确前台＋直接 owner 证据，捕获后再复核身份／几何／owner／前台，才接续 child。正向 Menu/Popup/Dialog 路径和明确身份冲突仍保留，动作前窗口检查不放宽。不使用应用名、标题、类名或尺寸特判。

作者 CUA 测试 191/191，Sol 独立必要 7 项通过。协调者构建发现三处测试 mock 参数类型问题，作者最小修正后协调者再次构建成功，现已放行 WPS 完整任务重跑；尚未标成 WPS 保存通过。本节取代前文首次观察中“unknown 必须让 Run 失败”的历史说明，弱候选不等于阻塞事实。

历史离线验证：当时 Node 24 构建通过，主测试 108 个测试文件、1358 项全部通过；附加脚本测试 31 项通过、1 项因 Windows 不支持当前测试权限下的符号链接而跳过。这是后续 unknown 恢复改动之前的结果，不作为当前全部增量的最终回归，也不替代完整任务验收。

### 最新 WPS：动作后未知与空恢复候选，尚未通过

真实 Run `run-1791087071720-00223012-b2e` 自动选择 WPS，发出 1 次模型请求和 1 次点击尝试。seq 10 开始点击，CUA 随后报告精确目标 HWND `0xc8177c` 在点击后不再是前台，实际前台为 `0x3cd0176`。错误没有证明输入未发送，因此 seq 12 保留 `ACTION_OUTCOME_UNKNOWN`，不能按普通拒绝重试。统计为 attempted=1、completed=0、partial/unknown=1，而不是“没有执行动作”。

seq 15 进入窗口恢复，控制面最初快照候选数为 0，随后验收 runner 立即通过正常 API 取消；seq 16 终态 cancelled，owner 已释放，有效 H.264 录像已保存，没有生成 DOCX。后续源码核对确认这是异步刷新尚未完成时的 provisional empty snapshot；此次取消截断了后续刷新，不能说最终候选为 0 或 Host 已把所有候选过滤掉。旧 `acceptance-summary.json` 已将此事件标注为非最终计数。

源码现有 Remote API 时序保持不变：刷新中为 `waiting_window` 且不发布可选 `pendingRequest`；成功、错误或 15 秒刷新超时后才发布已结算 handoff。忽略式验收 runner 已改为等待该结果，最多观察 30 秒；只有收到带候选数组的已结算请求（即使为空）或超过观察上限，才经正常 Remote API abort 并等待清理，始终不盲选。Node 语法检查及离线控制队列／候选刷新状态 self-test 通过；未 build、未启动 API/GUI，也没有新实机复测。取消和释放链可用，不代表 WPS 保存可用；不能要求用户在空列表或相同标题中盲选。

后续只读完整 Win32 快照中，历史前台 HWND 仍是可见、同 PID 的对象，但 owner 为 0；精确 `get_window_state` 失败且没有图像，诊断文件没有保存原始错误文字，不能还原错误原因。WPS 主窗的独立截图成功，显示测试文档和标记。事后的主窗前台状态不能证明恢复判断当时也是主窗前台；同 PID、类名或空标题也不能证明父子关系。Win32 边界与截图相差 2px 不参与同 Surface 几何谓词，不能把它当作根因。现有 `verify_state` 精确窗口截图不依赖 UIA 树，但对该弹层是否成功仍待只读实测，不是已解决。

方向保持可靠 Runtime，但收敛实现：Registry 只接纳当前 Run 使用且证据成立的 Surface。底层已支持窗口枚举、激活、定向截图及输入；部分弹层的捕获与关系证据仍需实测补齐。不能据此宣称所有弹窗可用，也不通过应用特例、盲目重放或静默全屏截图填补缺口。

`press_key` 是 CUA 已有底层接口，不是新增模型工具；本轮仅改变特定 Windows 前台组合键的 Adapter 映射，模型侧 `keypress`/`hotkey` 合同保持不变。

默认 `mobile` 受管浏览器 profile 已通过正常准备与完成流程，清理确认成立；这是配置就绪，不代表携程登录已经现场验证。携程 → 记事本任务后续实际结果见下，完整保存未通过。上述修复仍未部署到 Preview，当前线上版本不能用于验证这些未部署改动。

### 携程 → 记事本：查票与切换成立，编辑未完成

真实生产 Harness Run `run-1791091848162-250a734a-b93` 使用 mobile saved profile、跨窗口工具、100 请求／动作预算，Guard 关闭、Monitor shadow，全程录屏；日期按上海时区动态选择下一天 `2026-10-05`。模型在受管携程页面查到真实结果，再自行切到记事本新文档，没有外部操作者输入或手选目标。

协调者独立查看结果页资产 `ef9b8cb1-5011-4637-9681-6563fdc96e85.png`：前三趟为上海虹桥 → 杭州东，G4917 05:44–06:29／45 分／页面价格 83 元，G7541 05:52–06:51／59 分／57 元，G1321 06:07–06:56／49 分／80 元；截图有对应余票文字。没有进行下单或付款。这只放行查票及切换部分，不等于报告任务通过。

正文录入中出现一次明确无输入的 `MULTILINE_TYPE_INSERTION_UNSUPPORTED`，之后模型分段继续输入。最终报告的第三趟车次重复且没有保存，64 次模型请求、61 次 GUI 尝试，60 completed、1 refused、0 partial/unknown。先正常 pause 保留现场，再通过同一队列/API abort；ack 为 `aborted_and_released`、终态 finished/cancelled、owner 已释放、profile 回到 ready、H.264 录像验证通过。没有强杀、删除锁或编辑／关闭现场文档，目标 TXT 不存在、没有最终报告回复，整项未通过。

调用与截图对齐确认：两次模型分别发送同一完整 81 字符车次段落，每次只有一次 completed 输入；输入前只选中约 19／10 个字符，输入后留下第二／第三份车次。随后 SHIFT+HOME 只选中 3 个字符，DELETE 又造成局部混乱。协调者独立查看最终正文截图。此证据指向软换行下的选区判断和编辑恢复，不是单次 SDK 注入自动重复，也没有模型发送“333”的证据。不能凭 completed Receipt 宣称文字正确，不添加应用特例或未证实的输入节流补丁。

下一步要验证通用文本编辑证据与恢复：选择范围不明确时不能反复把完整段落输入到局部选区；能否利用现有 UIA 证明完整编辑范围及合法替换，须核对底层实际字段和语义再实施。既有空白多行输入验收不能推广为非空文档追加／修订全部可用。完整携程 → 记事本保存仍未通过。

### 收敛检查：全桌面与多平台输入范围

现有 Remote desktop 起点使用 `windowTarget:null`、公开 grounding 关闭，未绑定时观察走桌面截图、动作使用 primary desktop 前台输入。关闭窗口切换工具时能保持这个范围；开启后模型调用 `switch_window` 会注册并绑定 native peer，后续改成窗口截图。故不能将目前的 desktop + switch 工具宣传为全程全桌面模式，也不能静默扩大或缩小用户选择的范围。

早期实现曾让任意带换行的 `type` 都进入 Windows 私有 UIA 分支；当前源码已加 `current.platform === "win32"` 限制，非 Windows 回到原生 `type_text` 路线，并有 darwin/linux 路由回归用例。Root 已 fresh-build 验证这一平台 guard；本轮没有桌面实测。Windows desktop 多行仍没有 exact-window UIA binding，按需私有目录路径会拒绝；这部分保持未验收，不伪造 Observation、不重建 Session 或强塞 Registry。

### 输入路线与模型侧说明

上游 Windows XAML/WinUI 路径的精确 `cua-driver-rs-v0.22.2` 实现见官方 [`impl_.rs`](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L4194-L4264)：有 UIA 元素索引且元素有 `ValuePattern` 时，Driver 内部读取 `CurrentValue`，构造 `current + text` 后 `SetValue`，再按同一元素读回并比较。因此这一模式是**逻辑末尾追加**，不是由 Harness 预先拼接，也不是插入当前光标或替换选区。旧版官方 PR #1597 可作背景；实际 v0.22.2 语义以该 tag 为准。

本项目 Adapter 的私有 CUA 调用用 snapshot-bound `element_token`，通过通用 `callTool` JSON 边界传递；SDK 0.22.2 `.d.ts` 没有为该 MCP 字段提供专用的 TypeScript `TypeTextInput` 参数。其 element token 是精确快照中元素的寻址能力，不是 TextPattern/TextRange、选区起止或范围替换 API；`Home/End` 也只是键盘按键，不是 UIA 逻辑段/选区合同。

本项目 Windows 多行路径通过 exact-window 私有 UIA 观察取得元素 token。此前实现只保存 `preValueEmpty` 布尔值，并在非空元素上以 `MULTILINE_TYPE_INSERTION_UNSUPPORTED` 拒绝，因而没有使用上游已有的追加能力。当前源码切片已移除该空值 guard 与仅供该 guard 使用的旧值状态，向 Driver 传递的仍只有新 chunk；上游 Driver 自己负责 `CurrentValue + chunk → SetValue`，Harness 不能预读后再次拼接，否则会重复前缀。协调者已对当前切片 fresh-build；最终冻结审查及受控桌面验收仍未完成。上游 v0.22.2 对 `CurrentValue()` 读取错误使用 `unwrap_or_default()`，所以旧值不可读时可能被当作空值并覆盖未知文本；不得声称追加绝对无损。CUA 明确拒绝／证明未输入时 Adapter 回 `refused`；派发后无可信同目标读回或结果不确定时回 `partial`，要求重新观察且不自动重发。

0.22.2 SDK 存在类型化 `clipboardRead`／`clipboardWrite`，但项目模型 ToolRegistry 未暴露剪贴板工具；二者是分离的读取／覆盖操作，没有原值快照加原子粘贴／恢复事务。`clipboardRead(includeText=true)` 会接触标记为 privacy-sensitive 的文本，写入也会替换系统剪贴板；本轮没有读取或修改剪贴板。共享 ToolRegistry 的 `type` 说明已更正为窗口绑定 Windows CUA 多行末尾追加，并说明完整文本组织及软换行选区边界；GLM/Qwen 从同一注册表消费，未增加新工具或 Provider 私有工具清单。

Demo 收敛路线优先复用已有前台／桌面模式，但须先排除上述输入缺口，不能只换模式名就反复运行。截图范围、窗口激活和文本插入／替换属于不同职责；公开模型工具与 Driver 私有证据保持分离，后续修改仍以实际任务结果验收。

局部未知动作后的恢复契约见 [独立规划审查](./popup-recovery-contract-review-2026-10-04.md)：不把不确定动作宣称成功，不重放。已实现原 child 关闭后的精确 parent 恢复、同父新 child 接续，以及完整证据下同一 native Surface 重确认；Runtime 都必须取得 fresh observation 后才能进入新决策。同一 Surface 的未知 primitive 有私有重放防护，wait 或失败替代不能清除。普通传输未知和无证明的窗口变化仍不得自动继续。源码审查通过不等于 WPS 实机验收通过。

无法区分时的恢复不是降低身份要求后随机选择。先缩小关联候选，再展示真实预览；预览仍无法辨认或身份不稳定时，暂停并请用户在电脑端显示目标后刷新，或取消。不得把一排相同标题、原始句柄或编号交给用户盲选。关系证据足够的菜单／对话框应自动接续，不能为省事将所有临时 Surface 都转成人工选择；不确定的 candidate 也不能提前进入 Registry。

## 旧阻塞的受控恢复

已确认旧 Run 终态、旧 CUA session 查询不存在；临时只读 inventory 会话已正常 endSession(active=false)，没有输入。核验旧 Host PID 后停止，调用现有 `ProcessSharedEnvironmentOwner.recoverLease` 对精确 Run/lease hash 的 pending_cleanup 记录进行显式恢复。quarantine 与 committed audit 均保留，恢复后 owner 为 null；没有删除浏览器 profile、环境配置或历史事件，没有重放旧动作。

审计 ID：`518f2eee-96c3-45c7-9685-eeb2439cccde`。这是旧版本留下的锁的一次受控恢复，不作为新版本生命周期正确性的验收；新版本仍须证明真实任务结束后可正常开始下一任务。

### 2026-10-06：UIA 引用输入对照与显式追加候选（未实施）

本节只记录离线元数据与代码语义，不改变上方放行结论。`run-1791252669542-0630247d-75b` 中，无引用的多行 `type`（seq 31）因当前目录 `partial` 被拒绝；seq 42 提交同一长度文本并携带当前 UIA 引用，引用在该观察的公开目录中解析为 `Document`，状态为 `enabled=true`，但没有 `editable`／`focused` 字段。CUA 对该 token-bound 调用返回完成及同目标 `value_readback` 证据。旧成功样本 `run-1791230783995-93089829-5f1`、`run-1791240819580-36f489e7-7e6` 也映射到 `Document`，不是 `Edit`／`TextBox`。这些样本证明当前多行 token 路径能够对 `Document` 做 UIA 写入并取得 CUA 读回确认；不证明它是可编辑叶控件，也不等于 Host 逐字符核验最终全文或插入位置。

生产者侧后续只读 Notepad `get_window_state` 返回 39/39 项、`elements_complete=false`；包含一个有边界和 token 的 `Document`，但没有 `Edit`、`TextBox`、`Input` 或 `textarea`。其 `readOnly` 信息缺失，不能据此推断可编辑。另一个携程→记事本观察的 16 项公开 hot catalog 没有 `Document`，虽有 26 个已解析 UIA 候选；因此即便模型工具支持引用，模型也只能使用当前被投影出来的引用。原始候选未投影、原始树缺少编辑控件以及运行时 hot-set 截断是不同问题；不能以“如果可用就传 ref”的提示掩盖召回缺口。

消费者当前通过共享 `type` 工具的可选 `elementRef` 传入引用，再映射为内部 `groundingRef`；工具校验拒绝单行携带该字段，CUA 也只对 Windows 多行输入进入 token-bound UIA 路径。该路径以精确观察／session／Surface／窗口身份和几何绑定 token，使用 `type_text` 的 UIA Value 写入；其语义是末尾追加，不是按当前 caret 插入或替换选区。无引用的普通单行仍走窗口目标的前台 `SendInput`，由应用当前焦点、caret 与选区决定输入位置。携程 Run 中 seq 286 与 seq 317 的单行动作均未带引用；这类 completed receipt 不能证明正文正确，且不属于上述 UIA 追加路径。

留待整屏主对照结束后评估的最小候选，是把已有 `type.elementRef` 明确为“用户／模型显式选择当前 UIA 目标时，按末尾追加写入”，不新增 `type_append` 工具或协议字段。若批准实验，必须同时修改输入校验与 Windows Adapter 的显式引用分支；有引用的单行也须进入同一 fresh token／identity 验证与 UIA readback 路径，无引用的单行及其他平台原路径不变。过期、未投影、非 UIA 或不支持的角色须在派发前拒绝，不能自动绑定到 `Document` 或猜焦点。现有 Harness 接受的 readback 仅是 Driver `effect=confirmed` 且证据包含 `value_readback`；不声称 Host 比对了最终字符串，也不验证 caret／selection。

受控验证应使用空白合成 Notepad：显式引用路线在非空目标上证明只按约定追加，并检查精确预期结果；无引用对照分别从已知 caret 与已知选区输入，确认仍由前台键盘路径遵循原插入／替换位置；另验证 stale／错误引用零输入拒绝、平台限制及现有多行回归。未经此实验不放宽单行引用门槛、不改生产源码，也不将此候选写成修复或验收通过。

#### 桌面目标点击与前台变化（只读源码诊断）

另一次整屏 Harness 中，seq 79 的 taskbar 点击后 Adapter 收到 `foreground_unavailable` 并保守报告 `unknown`。本项目未绑定窗口时，`CuaDriverComputer.actionRequest` 传入 `PRIMARY_DESKTOP` 和 `delivery_mode=foreground`，坐标是桌面绝对点，而不是目标 PID/HWND。官方 v0.22.2 [`ClickTool` 桌面分支](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L2794-L2885) 先对坐标执行 `WindowFromPoint`／`GA_ROOT`，再调用 active `SendInput`。底层 helper 先要求该点命中的 HWND 精确成为前台，再发送鼠标输入；发送后只接受同一 HWND 或同一进程的已验证 owned window 仍在前台。该精确关系由 [`mouse.rs`](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/input/mouse.rs#L431-L443) 与 [`win32/windows.rs`](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/win32/windows.rs#L149-L195) 实现；后者明确拒绝无关同进程 sibling 与 foreign foreground。

因此，若屏幕点命中 Shell taskbar，而点击预期激活另一个进程的应用，发送前目标激活可以成功，但发送后的前台会变成与 taskbar 不同 PID 的应用，严格 post-check 就会返回 `foreground_unavailable`。源码只接受仍存活且可见的同一进程精确 HWND／owned 子窗口；若目标已销毁，则只接受回到动作前快照中的 owner。无关同进程 sibling 和其他进程均拒绝。active helper 见 [`mouse.rs`](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/input/mouse.rs#L431-L443)，派发后检查见 [postcondition 分支](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/input/mouse.rs#L663-L675)，身份谓词见 [`win32/windows.rs`](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/win32/windows.rs#L149-L195)。本轮已取得 raw CUA tool text，明确是 post-dispatch 分支：“exact target … or a verified same-process post-action window was not foreground after the click”；actual foreground 已关联到 Notepad HWND `202888`。目标 HWND `0x10130` 尚未独立关联，可能是 Shell/taskbar，但这一点未证实。该低层错误发生在 `SendInput` 鼠标事件完整发送并等待前台检查之后，所以本次是已派发、效果未确认的未知结果，不是“没有输入”；不要重放。若目标确为 Shell/taskbar，前台跨进程变化解释了严格谓词为何失败。Adapter 只把带有明确“未发送”证据的前台拒绝当作安全 refusal；同一错误前缀但未证明未发送时转 unknown，不重试，避免重复点击。

窗口绑定目标仍需要精确的 target／owned-child 前台检查；不应为桌面路径放宽窗口模式。桌面 scope 的公开合同则是从桌面绝对坐标操作，不绑定单一 PID/HWND，点击任务栏后切到另一应用可能正是桌面操作的预期效果。若产品选择支持此行为，最小上游候选是区分“发送前未激活／未输入”与“SendInput 已派发但桌面前台按预期变化、效果仍不可验证”，后者应保留 `unverifiable`、要求新观察，而不是报告可重试拒绝。需加入纯策略回归：window target 的无关前台变化继续 unknown；desktop target 的已派发前台切换不重放且转新观察；发送前明确无输入仍可安全拒绝。若产品决定 taskbar 激活不属于允许的桌面效果，则现有 unknown 是保守阻止而非应绕过的拒绝。Harness 侧仅靠匹配 `foreground_unavailable` 文本无法安全区分上述阶段；需上游结构化 disposition／合同确认后再决定是否提 issue 或改接入，当前不实施。

#### 2026-10-06：整屏 primary desktop 携程→Notepad 实机（未通过）

本次使用正常 Harness RemoteRunAPI、GLM、保存的默认 managed-browser companion 与 CUA；没有 Sky、probe、scripted Provider、人工选窗或手工代写。Remote target 为 desktop，saved companion 已就绪；请求上限 100，实际 7 次模型请求、6 个 completed 动作和 1 个失败的任务栏 click。CUA session 为 computer-harness-1791257110404，viewport 为 2560×1600。seq 5、14、27、37、47、57、68、85 共 8 个 Harness observations 全为 desktop；只有 seq 4 的初始 transition→desktop，模型没有调用 list_windows 或 switch_window，也没有 window handoff。此 Run 明确使用整屏前台截图范围，不等同于窗口级隐私范围。

seq 79 的可见任务栏 click 后，CUA 原始 tool 诊断记录 isError=true；target.kind 未被 instrumentation 保存。原始有限错误称精确 target 或同进程已验证窗口在 click 后不再处于前台；Runtime Receipt 为 ACTION_OUTCOME_UNKNOWN。没有重放该 click。seq 85 的新整屏截图显示 Notepad 已到前台、携程页面仍在后方，但 Notepad 展示的是旧的未保存标签；没有创建本 Run 的空白新文档，测试方没有编辑或关闭旧页。截图资产：[seq 85 全屏截图](../runs/diagnostics/full-foreground-task-acceptance-20261006032500446-0494065d/sessions/run-1791257108155-85184498-7f2/assets/screenshots/3a153341-607d-4494-a8a9-840951eb4c4b.png)。

seq 86 请求用户输入后，控制队列先拒绝中文行（rejected_non_ascii），随后接受一条 ASCII 等义事实回复：Notepad 已在前台，创建新文档并遵循原 Goal。请求与接受回复相隔 7 分 25 秒；seq 87 后没有新的模型请求，seq 88 的 get_desktop_state 报 CUA session 已结束，seq 89 Run failed。此次没有额外 CUA/inventory session；证据没有记录 daemon 的准确 session-end 时间或 SessionEndReason，不能单凭间隔断言 idle TTL。computer.close 在 runtime.error 之后的 03:33:55.505 开始并于 1.891 秒后完成，dispose 完成，owner 已释放。

原始 Goal 与 artifact verifier 使用同一保存路径：E:\MyDesktop\output\harness-full-foreground-20261006-20261006032500444-cc7301b6\Harness-Ctrip-Rail-20261006032500446-0494065d.txt。seq 77 的模型规划描述却写了 E:\MyDesktop\output\Harness-Ctrip-Rail-20261006032500446-0494065d.txt。复核时两处均不存在文件；因此 verifier 的缺文件结论与 Goal 路径一致，不是误查错目录。Run 没有最终回复，完整任务未通过。

保存配置在 Run 前后均由官方 profile 状态接口确认为 ready/saved，EnvironmentOwner 为 free；summary 中旧的 thirdTaskUsedHarnessManagedBrowser=false 与 thirdTaskSavedProfileLeaseReleased=false 不适用于本次 desktop companion 形态，不能解释为未使用 profile 或清理失败。录屏有效，H.264、无音轨：[整屏录屏](../runs/diagnostics/full-foreground-task-acceptance-20261006032500446-0494065d/recordings/ctrip-rail-to-notepad-20261006032500446-0494065d-f99c57e5-889b-4943-8816-6d60e70a2319.mp4)。Run 起始的相关 source/dist SHA-256 清单见 [acceptance-start.json](../runs/diagnostics/full-foreground-task-acceptance-20261006032500446-0494065d/acceptance-start.json)，仅覆盖清单列出的文件，不是整个工作树哈希；当时 HEAD 为 bb17a7b3838858e6fb9b95a2e35bf737f0f828e0。实跑前工作区已有候选生产 scope 修正及夹具改动，但均未 build；该候选源码当时定向9/10、另有三个旧回归，不能放行。实际加载的是不含这些改动的既有1712-pass dist，不能把候选源码的回归错误归到该dist上。本次只证明旧dist的整屏行为，不声称source/dist一致构建；legacy thirdTask profile flags不替代上述官方状态核验。

#### 输入批量注入对照的进一步定位（2026-10-06）

同一 91 码点单行文本的真实缓冲区对照：0.22.2 整段派发有 27 处字符不匹配；隔离的 0.33.1 整段派发有 1 处；0.33.1 每批最多 8 码点派发有 10 处。最后一组的 10 个错误字符全部等于各自批次最后的预期字符，已独立按原始字符串核算。它支持 Unicode packet 批量注入与目标输入栈消费时序相关的假设，但尚不能证明 WinUI 内部的具体缺陷；不能声称升级已完全修好。

官方 0.33.1 的 `send_text_synthesized_after_focus` 仍将整段按 UTF-16 单元构建后一次 `SendInput`。`wait_for_drain` 用目标线程读取 sentinel 判断输入队列进展，不是编辑控件全文提交证明；其失败也没有转换为全文读回失败。因此 Driver 执行确认不等于文本内容正确。后续逐码点对照仍让模型只发一次 `type`，仅实验边界拆分真实 SDK 派发，不能把逐字 RPC 当作已确定的正式方案。

此前两次逐码点尝试在实际输入前被诊断门槛阻止，均为零派发，不计入输入成功率。额外要求模型先列窗/切窗、要求 UIA 暴露可读空值并非此对照必要条件，已经从诊断 runner 移除；仅在本次受控空白文档和精确当前前台身份下测试，输入后再读取真实缓冲区。上一失败 Run 的 CUA session 已通过精确 `endSession` 确认 `active=false`；随后按现有 `ProcessSharedEnvironmentOwner.recoverLease` 精确恢复该 Run 的 dead-PID pending lease，隔离原记录并保留审计，恢复后 owner=null，未直接删除锁或配置。

逐码点实际 Run `run-1791291899354-e3a8924e-6cc` 已完成：模型在 2 次请求后发出一次 `type`，诊断代理完成 91 次真实 SDK 调用，均返回 `isError=false/degraded=false`，目标 PID/HWND 始终相同。完整派发耗时 **120.356 秒**。之后读取当前标记文档的 `Document.value`，实际文本 91 码点、153 UTF-8 bytes，与预期逐字符完全相同；协调者独立重算字符串比较和 SHA-256，均通过，SHA-256 为 `b582a04b77e071d0506c7861a6068e35b14327189fe9d921a1f78d4c44bb9aea`。Run close confirmed、owner released，读回会话 end 后 active=false，录像有效。证据见 [原始读回](../runs/diagnostics/full-foreground-task-acceptance-20261006130451712-83eb44e0/paced-input-experiment-readback.json)。

此结果将排查范围收窄到前台 Unicode 批量派发／消费时序，但对照同时改变了派发大小与调用间隔，不能单独证明具体内部机制。逐字 RPC 的延迟不可交付；正式修复候选应优先在底层一次 foreground transaction 内做小间隔注入，并回归光标插入、选区替换、中文、代理对与换行，不能增加 91 次模型请求或机械应用特例。此次单行输入对照通过，**不等于完整跨应用 Demo 通过**；生产默认 SDK 未升级，正式输入修复仍未放行。

#### 携程 → 记事本 → 保存：本轮真实链路已走通

Run `run-1791292339458-454347e9-dba` 使用既有 Harness、GLM、默认 0.22.2、saved managed browser、hybrid grounding 与 opt-in 窗口切换，预算 100 次请求；没有使用逐码点实验代理。真实目标为 2026-10-07 上海虹桥到杭州东查询并记录前三班车，不下单或支付。模型自主切到记事本，sequence 49 的一次多行 `type` 使用当轮真实 UIA `groundingRef`，写入新报告；随后通过真实另存为对话框保存。

协调者独立读取唯一输出文件，UTF-8 无替换症状，按 CRLF/CR→LF 规范化后与模型原始整份 `type.text` **逐字符一致**。路线、日期、407 个结果、三班车次、时刻、历时、可见余票与商务座数量与截图吻合。页面每行显示 ¥83，但截图未明确标明价格所对应的席别；报告把它写在二等座后属于待改进的语义归属，不能声称已确认二等座价格。保留原报告与最终回复，不人工改写证据。

轨迹独立统计为 11 次模型请求、9 个 GUI proposal、8 completed 和 1 次 transient unknown；从 Run 起始至 `run.finished` 约 284 秒。模型请求往返累计约 116 秒，不能把全部延迟归为 API；动作 started→receipt 中，切窗约 5.79 秒，整份 UIA 报告写入约 2.37 秒，保存弹窗关闭后的未知恢复约 15.35 秒。这些区间包含 Adapter 内部工作，不是纯底层函数耗时。保存 child 关闭后产生 `transient_parent_restored`，系统重新观察精确父 Surface 后继续，没有重放不确定点击。结果支持现有显式 UIA 多行追加路线能完成此新空白报告，不支持普通光标插入、选区替换或整屏 Unicode burst 已修复的推论，也不等于所有 WPS 弹窗已通过。已核对实施摘要：owner released、close confirmed、H.264 录像 validated；其他任务继续分别验收。

证据目录：[本轮实施记录](../runs/diagnostics/full-popup-task-acceptance-20261006131210541-4111ae2e/acceptance-summary.json)。实际输出是本机私有产物，不作为仓库 Quick Start 的固定路径。

#### WPS 窗口路线未通过，转整屏前台对照

Run `run-1791293020638-54a50b53-362` 用已有 WPS 新副本任务和 native-window 路线运行，26 次请求、24 个动作后失败，无目标输出。文件区点击多次返回 completed，但后续窗口截图仍为菜单关闭的空白 Writer 页；尚不能仅凭这一点区分点击无效、菜单采图遗漏或采图时序。一次通用纠正通过现有接口记录，未注入任务答案，也未使本轮成功。现有 `.docx` 输出审计不变，owner released、close confirmed、H.264 录像有效。

用户确认 WPS 窗口路径已有问题，下一轮采用 **primary desktop 全程整屏前台**，`switch_window` 只激活、不转回 native-window binding。不得将上方 native 携程成功冒充此整屏路径的验收。当前普通 Unicode 突发输入仍有已证实风险；新的 WPS 任务结果与输入风险继续分别记录，不偷偷启用 91-RPC 实验方案。

整屏后续 Run `run-1791294022199-456e9415-043` 已完成：28 次模型请求、18 个动作，未人工纠正。轨迹确认起点和切换后的观察保持 `desktop`，模型实际使用列窗与切窗，首次激活拒绝后重新观察，后一次激活完成，没有变成 native-window binding。唯一目标 DOCX 已保存。协调者使用共享只读文件流打开 DOCX 的 `word/document.xml`（普通独占打开被 WPS 文件锁拒绝，不是文档损坏），独立确认正文准确等于 33 字本轮标记，两个文字运行字号均为 28 half-points，即四号 14pt，无替换字符。owner released、close confirmed、H.264 录像 validated。此结果支持整屏 WPS 新文档写入／字体设置／保存链路；短 ASCII 标记不替代长中文 foreground 输入回归。

原自动摘要仍标 `incomplete_or_failed`，原因是沿用窗口模式的 WPS 初始标题与 child-pop 条件；整屏起点应是 Primary desktop，临时 UI 不要求注册 native child。按 scope 修正的仅是 ignored 验收 fixture，不改实际任务轨迹或生产接口，也不为了过测试追加无用点击。输出根目录审计先前无直接子 DOCX，结束时记录本轮同名文件和 WPS `~$` 锁文件两个新增项，后续原位置均不存在、目标嵌套路径文件存在。其短暂生成／迁移原因未证明，没有人为删除；没有覆盖目录外原 WPS 文档的哈希核验，不声称全机文档都已验证未改动。

记录见 [整屏 WPS 实施摘要](../runs/diagnostics/full-foreground-task-acceptance-20261006134013249-0eb32b7b/acceptance-summary.json)。

#### 2026-10-07：输入候选实机失败，默认版本不升级

自有 fork Windows Actions run `37490081756` 编译成功，只证明候选可以构建。该候选使用 v0.33.1，在一次 foreground transaction 中逐码点 SendInput、间隔 3ms。实际 Harness Run `run-1791302904783-515b80c6-74e` 经匹配 SDK 与独立 pipe 派发一次 91 码点输入，约 773ms，无重输。实际 Document.value 也是 91 码点，但从索引 60 开始，预期正文被 31 个末尾字符 `）` 替代。214ms 截图尚未写完；743ms、1.70s、3.13s 截图和只读文本结果均证实稳定损坏，不是单纯采图过早。

证据：[精确读回](../runs/diagnostics/full-foreground-task-acceptance-20261006160817512-5c27edaa/candidate-document-readback.json)。Runtime 的 diagnostic succeeded 不等于正文正确。该候选未升级为默认版本；候选 daemon 已正常停止，Run owner 和只读会话已释放，原 0.22.2 daemon 与登录配置未改动。后续须区分独立 RPC 与一次事务内注入在前台绑定、线程 attachment、队列等待上的差异，不能把此前 91 RPC 精确读回直接当作 3ms 修复的依据。

补正上方整屏 WPS 统计：28 次模型请求，25 次 GUI 尝试，其中 18 completed、1 次激活拒绝、6 次 unknown。证据支持输出副本正文与四号字体保存成功，但初始文档身份没有充分核验，不能声称已证明从零创建空白文档。保存路径实际输入两次，第一次字段已含完整路径，仅因横向滚动被误判缺少前缀；应分别分析可避免的模型重复与底层 unknown 恢复，不能都归为 API 延迟。

#### 2026-10-07：前台输入同文本 A/B 有效路径

短机械对照使用同一份 91 码点／219 UTF-8 bytes 的中文、数字和标点，两个不同的新空白 Notepad 标签页；均未保存，也未修改旧文档。默认 CUA 0.22.2 的 desktop-primary foreground `type_text` 无 element token，一次返回 completed，约 123ms；实际文本索引 82–89 的八个标点全变成末尾 `?`。随后另一空白页用原生 SendInput 每码点一组完整事件、20ms 间隔、无线程 attachment／剪贴板，一次发送 91 组共 182 个事件，输入循环约 3007ms，进程外总耗时约 4.08 秒；实际 Document.value 与期望逐字符一致。

协调者独立读取原始结果并重算：基线 SHA-256 `237aef995f44c1a55464a0b450d125e27ab8580b5d00ec21589b727720d3c133`；20ms 实际与期望均为 `f8673bed9b9f85bcbe61259a3fd50293c2a80f4a716076f3cb4dec5442636831`。证据：[基线读回](../runs/diagnostics/windows-input-baseline-readback-20261007-p33052-31888-95f5773d1167486891942dca4532d64d.json)、[20ms 发送](../runs/diagnostics/windows-input-20ms-send-20261007-p33052-31888-be163163ecc04127b39112d04964071b.json)、[20ms 读回](../runs/diagnostics/windows-input-20ms-readback-live-a79558c5df6b4c7489d60cb054eb6ad9.json)。该实验没有模型调用，不是完整 Harness 业务验收；改变了事件分组和发送间隔，支持路径可行，但不能单凭它证明 WinUI 内部某一个组件就是唯一根因。

验证入口也有两处真实缺口：0.22.2 与 0.33.1 的结构化窗口状态都会过滤空字符串，因此不能要求空白 Document 在该结果中必有 `value=""`；改用直接只读 UIA ValuePattern 验证真实空字符串，不将字段缺失当空白。默认 CUA 全局 inventory 在本次返回 partial／空，不代表原生窗口不存在；精确 Win32 PID/HWND、live 窗口状态与发送前后前台校验可证明本次单目标，不要求全局枚举完整。离线 Compare 不需要文件年龄限制，只有发送前的空白证据需要新鲜。以上均为 ignored 诊断工具修正，未偷换生产准入或用户任务结果。

后续先在同生产版本 0.22.2 上准备最小 Windows text-helper 候选，由自有 GitHub Actions 编译、隔离 socket 实测；不为输入修复直接升级整套 SDK／协议。必须补实际中文／符号／换行、光标中间插入、选区替换、浏览器地址栏回归，确认后再接入和跑完整跨应用 Demo。未知前缀输入仍不重放。

候选编译已完成：[自有 fork CI 37508991404](https://github.com/wszkxlllll/cua/actions/runs/37508991404) 成功，7 个 Windows 纯输入测试通过，Release 编译 10分48秒、workflow总计15分57秒。基于官方 0.22.2 tag commit `d114f35fec05ecd37bf529e5587be86852205b64`，候选 commit `cb61061de633969ea9da3a88bd833d676bfd96f5`，只改 Windows keyboard 源码与自有 CI。前次 CI 的语法检查失败留作历史，不覆盖。author／committer 经 GitHub 核验均为 `wszkxlllll`、ID `142909575`；没有开上游 PR或修改其 main。

本地仅下载产物，exe 28,606,976 bytes，SHA-256 `D2301FE1287C97556287E99DA7D46EB8888EFA235FC1D03F1FC2939D18DB2880`，协调者独立核对 manifest／源码／lockfile 与实际二进制一致。产物在 ignored `.tools/cua-driver-rs-v0.22.2-paced-input/artifacts/run-37508991404/`；未安装 MSVC／Windows SDK、未本地 Rust 编译、未替换默认 daemon。构建成功不替代下一步隔离候选实机矩阵。

#### 手机显示链路：真实 Headless 浏览器分项验证

本地 fake Host／Relay／Provider／Computer 加 Headless Edge、390×844 视口的 opt-in 验证已通过，不访问真实桌面或个人浏览器 profile。已授权测试会话 Cookie 进入隔离浏览器，实际 asset 请求携带 Cookie，经同源 Relay 返回 HTTP200／image/png；缩略图与全屏图片均真实解码 naturalWidth=1。全屏旧图保持固定并显示有更新提示，关闭后缩略图更新；finished／pending_cleanup 时首页禁止开始，owner released 后第二题显示其自己的 Goal／回复，未被前题覆盖。协调者独立读取结果确认这些字段。

初始证据：`runs/diagnostics/mobile-headless-relay-1791309088235.json`；普通 `relay-roundtrip.test.ts` 已将三字节伪 PNG 替换为合法 PNG 并验证签名／IHDR／尺寸。独立标准测试 1/1 通过；真实浏览器路径仅 opt-in，不让普通 CI 默认拉起 Edge。审查补齐测试私有 CDP connect／call／关闭及 taskkill 的超时；修后普通测试和 Headless 分项各 1/1 重新通过，最新证据为 `runs/diagnostics/mobile-headless-relay-1791309985417.json`。

此结果不是实际 iOS／Android 真机、语音播报、可辨认的真实多窗口图像或手机配对 UI 全过程验收，1×1 PNG 只证明浏览器鉴权和解码链路。公网 Preview 仍未替换本轮构建；不能以本地分项通过解释用户旧页面已修复。最新成功测试的 Edge 与临时 profile 已退出清理；开发中断的少量本轮 Temp 目录删除被工具策略拒绝，未绕过，也未动旧 profile／系统配置。

修后本次运行临时目录残留为 0，隔离 Edge 进程为 0；先前已知五个开发中断目录合计约 22.7 MiB，保持原样并记录私有路径，不再次绕过策略删除。

#### 保存路径效率核验（2026-10-07 录像复核）

效率证据补充：对成功携程 Run `run-1791292339458-454347e9-dba` 的原始录像约 200／208／212／228／251／270 秒抽帧，200–212 秒为选中的默认 basename，228 与 251 秒为同一次输入后的完整路径尾部，270 秒对话框关闭。对应 seq91 只有一次 119 字符完整路径 type，seq100 保存。该录像没有证明反复改写；完整路径放入 Windows Filename 字段且最终正确落盘本身不是错误。不能用此结论否定其他失败 Run 的重复问题；WPS 的两次完整路径输入已另有轨迹证据。

#### 跨应用为何预先打开浏览器（2026-10-07 源码核对）

手机端 `target.mode !== browser && switchWindows === true` 时，RemoteRunAPI 会按本机默认 saved/temporary 设置添加 managed-browser companion，Computer.open 在首次模型请求之前启动它。因此纯 WPS 或记事本任务只要打开跨应用，也会出现浏览器；浏览器启动失败可能连带使整个 Run 启动失败。这不是模型决定。未启用跨应用的非浏览器目标不添加 companion；浏览器起点则无论跨应用开关都启动受管浏览器。

当前模型的相关工具仅为 `list_windows`、`switch_window`：能切换 Host 提供的已打开候选，没有专门启动受管浏览器的工具。整屏模型可以尝试通过操作系统 GUI 打开普通浏览器，但不能据此声称能自主启动 Harness 的带登录 profile 浏览器。CLI/TUI 在有相应 URL/profile 配置时才装配 companion，与 Remote 条件并不完全一致。

本轮先记录实际行为，不擅自把现有跨应用体验改成只切已打开窗口。解除 eager browser 依赖须明确产品语义与生命周期，再按需修正；不能仅删除启动代码却让模型仍以为存在受管浏览器。源码依据：`remote-run-api.ts` 的 companionSessionMode 与 createRun、`computers.ts` 的 ManagedBrowserComputer.open、`runtime/computer-tools.ts` 的 windowSwitchTools。

#### CUA session idle TTL 与长等待（原因候选，未证实）

同一整屏轨迹中，taskbar click 时间约 03:26:30，下一次用户输入／CUA 调用约 03:33:55，相隔约 7 分 25 秒；seq 88 `get_desktop_state` 返回 `session has ended`。官方 v0.22.2 [`session.rs`](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/cua-driver-core/src/session.rs#L28) 默认 `DEFAULT_SESSION_IDLE_TTL` 为 5 分钟；[`evict_idle`](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/cua-driver-core/src/session.rs#L1414-L1442) 在无进行中 dispatch 且距最后一次 CUA 活动达到 TTL 时结束 session。可信的 per-session TTL override 可能改变该值，但当前 Harness 轨迹没有记录实际 override 或 `SessionEndReason`，所以 7:25 间隔与默认 idle expiry 一致、不能证明它就是本次 session 结束原因。它与点击后的 unknown 是两个独立现象；不要把 user input／模型思考时间误当成 CUA 活动，也不要静默重启／复活已结束 session。

#### 手机进度、语音与预览消费链路（2026-10-07 源码核对）

本节记录源码合同与本地 fixture 证据，不代表真实手机／真实 Host 验收。进度路径分两类：Runtime `model.response.received` 中与本次请求实际包含截图精确绑定的 milestone，由 `packages/voice/src/run-notices.ts` 生成有界 `RunNotice.text`；`packages/app-runtime/src/remote-run-api.ts` 经 scheduler 发布 `run.notice`；`apps/web/src/hooks/useRunFeed.ts` 解码后由 `apps/web/src/RunWorkspace.tsx` 交给 `RunNoticeSpeechController`／`BrowserSpeechOutput` (`apps/web/src/run-notice-speech.ts`)。普通 `run.progress` 是模型／动作／monitor 诊断，在 `apps/web/src/components/EventTimeline.tsx` 显示，不直接语音化；内部 `progressSemantic` 仅供 Host scheduler 使用，未进入 wire 是有意设计，手机播报消费的是文本等公开字段。

任务通知开关默认关闭（`apps/web/src/preferences.ts`）；用户须先在偏好设置开启，并在开启状态新建任务，Home 才会把 `runNoticeContentEnabled` 同意项送到 Host。浏览器 utterance 设置 `zh-CN` (`run-notice-speech.ts`)，但开启动态内容时播报的是模型原始安全摘要，代码不翻译／强制摘要为中文；偏好语言默认 `follow_conversation`。中文演示应先将偏好语言设为中文并用手机“测试语音播报”，实际 SSE 到达后的 iOS/Android 语音策略仍须真机确认。

Run 截图与候选预览是不同传输路径：最近截图通过同源 `GET /api/runs/:runId/assets/:assetId` (`apps/web/src/api.ts`, `apps/host/src/server.ts`) 提供，由 `ScreenshotPanel`／`ScreenshotViewer` 显示并固定已打开的 asset；候选清单经 `GET /api/windows`，精确预览经 `POST /api/windows/preview`，运行中窗口交接则经 `POST /api/runs/:runId/window-candidates/preview`。后两种预览作为 JSON base64 图片，由 `WindowTargetPicker`／`PendingRequestPanel` inline 显示，而非 Run asset URL。相同标签或缺少名称的候选要求预览图片成功加载及显式确认；真实电脑上能否看清不同窗口仍待验。

清理合同：`ApplicationSession.finishRun` 等待 close/report 后按该 Run 的清理确认记录 `ownerState`；Remote API 的 `listRuns` 与 `getRun` 共用 snapshot 投影。Home 对 `pending_cleanup` 禁止开始新题，Run 页提供刷新状态；Home 等待清理释放时需手动“刷新列表”，Run 页也可手动刷新，不承诺自动轮询。

本地 fake Host／Relay 的 Headless Edge fixture 已验证同源 cookie 下合法 1×1 PNG 解码、截图更新提示及 pending cleanup 释放后第二题不被旧 Run 覆盖；它不证明下列实机事项：

- 配对手机上的真实大图加载、中文动态进度文本及异步语音合成（尤其 iPhone Safari）。
- 真实多同名窗口候选经 inline preview 后可辨认，且确认对应正确窗口。
- 真实 Host 终态清理等待期间的手机提示、手动刷新释放状态及随后启动下一题。

最新正常GLM业务Run提供了真实生产／消费证据：`run-1791313873770-4be54747-d24`的模型返回具体中文`observationAssessment.progress`，Remote API发布8条具体中文中途里程碑，另有开始和结果通知。此证据证明字段不只是静态接口，仍不证明手机扬声器实际播出了声音。独立核对发现一条错误通知在可恢复unknown后过早写“任务已停止”，而Run随后继续并succeeded；已安排voice fallback最小修正，终态前不得宣称停止或成功。未知副作用与不重放规则保持不变，不引入新的推断字段。

该voice修正已完成源码与Sol审查，完整voice定向30/30通过：未知／部分副作用及未知error类别的预终态提示中性化，真实`run.finished: failed`仍明确“任务未能完成”。回归包含错误→新观察→具体里程碑→succeeded、三类中性错误→failed及重复终态拒绝。仅修改`packages/voice/src/run-notices.ts`及既有测试，不增字段／producer类别、不改Runtime恢复策略。已统一TypeScript构建，2worker全仓1802/1802通过，报告`runs/diagnostics/unified-foreground-profile-voice-final-20261007.json`；尚未部署，不能让旧Preview的用户以为此文案已更新。真实API原轨迹离线消费复验进行中，不等于再次调用API或真实手机发声验证。

后续离线消费核验通过，证据`runs/diagnostics/voice-projector-replay-run-1791313873770-20261007.json`：原轨迹195事件哈希未改、新编译projector生成8具体中文里程碑、unknown通知中性化、真实终态result保留。真实截图显示短验收也通过，`runs/diagnostics/mobile-headless-real-run-screenshot-1791319013099.json`使用本轮416,275B／1,525,289B PNG，在390×844隔离headless浏览器经本地fixture Host/Relay授权链路加载，传输哈希和2560×1600自然尺寸匹配；受控首次读取失败后同URL重试、旧图固定及新图提示均有证据。不是生产服务自然故障复现，不含真实inline候选／Safari／TTS。Sol微修测试注入按确切RunId而非图片大小识别，修后headless仍需复跑。

#### 2026-10-07 当前收敛：不重跑携程，继续修输入与手机体验

用户已确认携程完整链路暂不重跑。本轮优先级保持：前台输入准确性、Demo效率、手机显示与播报。真实任务的原始 `type.text` 在出错位置是正确的；模型终态 succeeded、Driver receipt completed 都不能替代实际全文读回。

同390码点真实报告的原生20ms候选三次中两次损坏；40ms候选五次计划在第三次失败后停止，前两次精确、第三次少一个空格，立即及两秒后相同。40ms自有构建 `37525946489` 成功不代表输入验收通过。两种候选均未部署，不继续靠增加等待延迟宣称修复。

聚焦UIA的独立短实验提供了新证据，但还不是生产修复：当前精确前台窗口中的 focused Document 具有 writable ValuePattern，直接成功读取真实空值，不依赖模型返回 element token，也不把目录缺失 value 当空白。Run `input-candidate-20261006212738097-d7370a94` 一次 SetValue 约10.3ms，立即及两秒后全文按CRLF/CR→LF规范化均与390码点原文精确相同。后续 Run `input-candidate-20261006213309197-57a1472a` 仅输入一次 `X`，两次读回均严格为 **X + 原文**，不是原文 + X；session结束、owner释放，诊断标签未保存，用户文件未改。

因此不能将 SetValue 直接视为普通光标输入的等价替换。下一步先调查通用 TextPattern 选区能力能否可靠保持末尾光标，再批准极窄候选；禁止应用名特例、强制模型token、键盘快捷键掩盖光标问题或 mutation 后回退重输。能力不适用应保留原路径，已尝试写入但结果不确定则沿用unknown、不重放。原生输入与显式element追加仍须分别回归，不能以此绕过非空插入／选区替换语义。

后续通用选区短实验已通过：不重新写全文，只对当前 `X + 原文` 的 TextPattern DocumentRange 复制后折叠至末端，一次 Select 约3.482ms；fresh GetSelection 的唯一退化range两端均等于文末，全文及精确焦点／前台不变。Run `input-candidate-20261006215614593-bec681b0` 再仅一次普通 `type_text("Y")`，约1251ms；立即及两秒后读回均严格为 `X + 原文 + Y`，392码点。协调者独立核对原始action与全文，session结束、owner释放。依据为微软[退化TextRange选择会移动插入点的契约](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-implementingtextandtextrange)及本机实测，而非应用名或时间猜测。

诊断工具有两处包装／摘要错误，保留历史：第一次Select底层成功，但runner错误读取JSON的readback层导致未发送Y；离线字段核对后才允许fresh只读确认与唯一Y。最终Y-only Run的top-level `typeYAttempted` 仍误留false，实际action记录有唯一Y及精确读回；不能只凭汇总字段决定通过。下一步批准官方0.22.2基底上的独立源码候选，仅改Windows内部focused-empty Document输入能力分支，不继承失败节流；覆盖window/desktop前台无显式ref路径，能力不适用保持旧路径、写后失败unknown不重输。候选须源码审查、GitHub构建及本机全文／光标／浏览器单行回归后才可接入；不宣称保留传统键盘输入的Undo或IME全部语义。

Host真实配置入口及可选通用操作指导已完成源码和定向审查，默认均关闭；没有修改本机真实env或服务。协调者执行统一 `tsc -b`、CUA spike noEmit及2worker全仓回归，**1804/1804通过**，报告 `runs/diagnostics/unified-host-mobile-input-review-20261007.json`。手机真实大PNG的修后headless与默认Relay各1/1通过，新证据 `runs/diagnostics/mobile-headless-real-run-screenshot-1791322838205.json`；按精确RunId注入读取失败后同URL重试、两张2560×1600图片真实解码、旧图固定与更新提示、清理释放后下一题均通过，隔离Edge退出、该次profile删除。此为本地fixture，不含真实inline候选、iOS或TTS。当前Preview仍是旧部署，不把源码通过或本地fixture当作手机真机已更新；1804项回归也不覆盖原生输入的已知实机失败。

手机inline候选路线补验：复用现有Headless/Relay fixture，两同名候选分别加载416,275B／387,718B的不同真实PNG，data URI自然尺寸均2560×1600、哈希对应各自源图；损坏预览不能确认／启动，重试成功后最终start仅携带候选B的新proof，不误用A。HomeScreen 26/26、默认Relay及opt-in各1/1通过，证据 `runs/diagnostics/mobile-headless-real-run-screenshot-1791323973973.json`，协调者独立核对。此为真实图像字节经过fake窗口capture，不是实际CUA同名弹窗可辨认性或手机TTS验收；生产UI／路由未因此改写。

同时确认一个跨层能力限制：原尺寸候选PNG目前在Discovery、Remote、Host、Web各受1MiB限制，Relay JSON上限2MiB，无跨平台resize。合法大窗口可能因此被拒，但尚未证明某次用户预览失败就是此原因。批准下一增量统一为2MiB raw／3MiB JSON-wire的有界限额，并补边界与大图inline回归；不按某张测试图调小数阈值、不添加图像库、不修改Run asset既有8MiB上限或身份／proof校验。未通过审查与回归前不部署。

该限额增量现已实现：raw共享常量由既有protocol包导出，CUA/Remote/Host/Web统一消费；Host与Relay共用3MiB preview JSON上限，Run asset仍8MiB。定向135/135通过，最大多字节metadata加2MiB原图仍有超过256KiB wire余量。Headless证据 `runs/diagnostics/mobile-headless-real-run-screenshot-1791324664013.json` 确认1,525,289B真实PNG经inline候选路径解码、失败重试及候选B proof绑定正确。首次全仓1806/1807发现connector测试仍用旧2MiB超限样本；改为共享新上限+1后，协调者重跑统一回归 **1807/1807通过**，报告 `runs/diagnostics/unified-preview-limits-input-profile-final-20261007.json`，旧失败报告保留。类型构建通过，源码冻结交集中Sol审查；未部署、不宣称真实CUA弹窗或iOS已验。

集中Sol审查已GO，仅放行自有fork云编译：输入候选以官方0.22.2 `d114f35fec05ecd37bf529e5587be86852205b64` 为基底，仅Windows `impl_.rs`及独立workflow。临SetValue前重新成功读真实empty/readonly，避免中间探测期间内容变化后被覆盖；文本以ValuePattern写后及Select后规范化exact为依据，TextPattern仅管caret，不要求其全文表示完全相同。源码blob `6fa23ec68c229d115d8b04b7707ab0295ea9a12c`，文件SHA256 `B66594C7080EFB66C890DB996D8D8A8A1F4F5334DFF1A311AE91379EEE45D69D`；workflow SHA256 `B5DDE8EBFDF06A9FBE74483EF728E2A7258FF8CAFDCB0A5C5D4CF03D1727F3A9`。Reviewer独立预览重点37/37通过，未操作GUI／生产API／本地Rust编译。已授权提交独立fork分支后云构建；默认服务与Preview不变，CI通过后仍需隔离实机矩阵与一次短GLM写入／保存验证，不再跑携程。

自有fork提交 `ac13517eed8b2db8aad4e8d6f6f96a0ea700b699` 已推送独立分支 `codex/v0222-focused-document`；GitHub author及committer均解析为 `wszkxlllll`／`142909575`。唯一[独立Windows构建37540450710](https://github.com/wszkxlllll/cua/actions/runs/37540450710)已启动，尚未取得产物；只运行纯focused单测与Release编译。默认daemon、SDK、用户profile及Preview仍未替换，没有开上游PR。

首轮 `37540450710` 在 `cargo fmt --all -- --check` 失败，来源／scope核对通过，但单测及编译未开始；保留该记录。只按日志调整imports、if与测试assert排版，没有语义修改或移除检查。修正提交 `3cef474ab4199232a6f3910857cb292a069f9352` author／committer同账户归属已核，[新构建37540596268](https://github.com/wszkxlllll/cua/actions/runs/37540596268)进行中。

效率只读复盘补正：最新携程整屏Run四个partial点击后的确均先observe；两组同点completed→partial不能仅按坐标就判定为同语义的无效重试。保存后再开SaveAs提供目标目录中同名文件存在的可见证据，尚无证据说明可由先前状态充分替代。当前不新增“禁止重开保存对话框”等提示补丁，保留已覆盖快捷键／路径裁剪误判的通用note。下一短GLM验证分别记录API等待、GUI动作、unknown恢复、保存复核次数和实际文件全文正确性，不把所有恢复成本当浪费，也不以步骤变少替代成功。

输入候选CI `37540596268` 已成功：纯focused Rust单测3/3（205 filtered），Windows x64 Release编译9分57秒，格式检查通过。独立产物28,633,088B，SHA256 `16793E27B6F0605F129824F199FEE22CEA64881A49D8E643726AD25F6FFDEEE5`。协调者另行核实际exe及manifest、HEAD源码blob `387eee9e91ad7f46ca986d679e51cfc1dd7fdcba`、workflow blob `b76c9f459ae380bb6c9416654212ee80a4d6878d`、Cargo.lock与预期一致。只放行新pipe隔离短矩阵：三份独立390字符与一次末尾追加、LF/CRLF/non-BMP、非空短中间插入／选区替换、Edge单行Edit／地址栏（desktop与至少一次window foreground no-ref）。实际返回route/effect及工具文本作命中证据，不机械补字段。默认驱动、SDK、个人profile、Preview不变；短矩阵未过前不跑短GLM保存，更不重跑携程。

实际矩阵遇到间歇性fallback，立即暂停后缀：隔离实例PID23308，Run `input-candidate-20261006224758942-86c15682` 两次desktop新空白390码点。第一份1338ms，真实返回Accessibility／confirmed／ValueReadback及候选确认文本，全文规范化精确；第二份1575ms，真实返回GlobalInput／unverifiable及原SendInput文本，归一后索引86预期c、实际换行，立即与两秒后损坏一致。两次写前直接UIA均证明精确窗口唯一Document确实为空。协调者独立核原始action和全文；session已结束、owner释放。此结果证明第一份命中新路径，第二份退回旧路径后损坏，不是“新UIA已确认后文本仍坏”。window trial、追加和API保存未启动，不放行部署。

只读源码调查发现可验证嫌疑：旧 `tools/page.rs`／`uia/mod.rs` 在复用的blocking线程上初始化MTA而不逐次卸载，新helper却要求STA、初始化失败便NotApplicable。微软[UIA线程规范](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)建议不持有窗口的UIA client工作线程使用MTA。需要核对pool与初始化日志再决定最小对齐，不建新守护线程、不加延时／应用规则；本次失败尚未记录实际COM HRESULT，不能宣称该嫌疑已是唯一根因。

后续只读确认：`get_window_state` 与新helper共用Tokio blocking pool，旧MTA初始化未配对卸载；也存在其他未配对STA旧工具，因此不能承诺仅改MTA就消除所有fallback。第二份事后focused UIA读数显示精确窗口中唯一可写Document、TextPattern Single及focus/root正常，但不能反推dispatch瞬间状态。只在新helper对齐MTA，并加私有 `focused_document_type` 日志（thread ID／HRESULT／NotApplicable阶段，不记录正文、标题、句柄）；成功初始化仍在COM对象drop后配对Uninit，失败仍不写。Sol窄审修一行unsafe标注后GO；候选源码blob `c66118c487ab79c18c00de57564d8c8a9c19670f`。提交 `d680f9a1ce6c46615dcc927074bbd6cfac197665` 已核GitHub author／committer同账户ID，[云构建37543982840](https://github.com/wszkxlllll/cua/actions/runs/37543982840)已启动。未改旧UIA模块、未新增线程设施、未替换默认实例；后续必须在新隔离实例收实际初始化日志和路线证据。

#### MTA候选短矩阵与真实API暴露的追加边界

构建 `37543982840` 已成功，产物 SHA256 为 `2BCA0E217B2E31B84983D2B59FA6EE3E7BFA56392786EA3560676DD930E9AE38`，协调者独立核对产物与来源。隔离desktop矩阵三份390码点全文均立即／两秒后精确；第三份再普通输入Y，严格位于文末。LF/CRLF、non-BMP及短中间插入／选区替换通过，私有Edge的地址栏与单行Edit精确。window正例在建立空文档的hotkey步骤报错，未取得可解释原错误，不能算通过；COM debug日志也未实际采到，不能声称拿到了初始化HRESULT证据。以上不替代真实任务。

真实GLM短任务 `run-1791330376714-3dd368f2-fd6` 未通过。证据在 `runs/diagnostics/full-foreground-task-acceptance-20261006234607770-c84f1bbf`，已正常Abort并释放，录像、原始请求和轨迹保留。模型选择分段输入，而非一次输入390码点：初始marker之后，seq76请求正确的13码点 `路线：上海虹桥 → 杭州东`，seq79返回旧native `Typed ... scope:desktop`，seq81原图显示 `路线：上海虹桥 东东东东东`。协调者独立查看原图确认不一致。随后模型反复删除／修订，没有完成正文和保存。不能把失败归于模型原文错误，也不能因之前空文档矩阵通过就宣称输入已修好；具体WinUI/IME内部机制仍未证明。

当前候选只处理空文档，正常分段输入后续会退回原生路径，这是必须补验的能力缺口。下一步先实验通用“唯一退化选区位于Document末端”的追加能力：读取真实前缀，前缀和输入分别规范化换行后拼接，写前复验原值／焦点／末尾选区，写后精确读回并保持末尾caret。仅在实验成立后复用现有helper做最小实现；中间插入／局部选区保持原语义，不新增应用名规则、强制模型token或“一次输入全部”提示。尝试写入后不确定仍unknown且不回退重输。不得把非空SetValue的Undo／富文本保留能力当作已证明。本轮不重跑携程完整任务，默认服务和Preview尚未替换。

文末追加首个能力实验已通过，仍不是生产驱动验收：`runs/diagnostics/uia-append-route-20261007002422725.json` 在新建私有文档的27字符前缀后，一次追加20字符中文／换行后缀。exact foreground、focused writable Document、原值及唯一文末退化选区写前核验通过；SetValue约10.574ms，立即及约2193ms后读回均规范化换行后精确，Select后光标确认在文末、目标稳定。原始行尾表示不同，raw equality为false，不把它写成字节级相同；协调者独立从UTF-8 seed及suffix重算47字符规范化expected SHA256 `c5b2e2a3f2f00fcc21a15ecfdb90b8641f08ff949798d1f63e2d601ce9104460`，与记录一致。普通Y续写尚待完成。实验前一次错误socket在metadata阶段失败，未开启session／dispatch文本；历史失败记录保留。仅放行最小源码候选实现、审查与云构建准备，不放行部署或宣称已有内容的任意位置输入已修复。

随后普通Y续写已通过：`runs/diagnostics/uia-append-y-run-1791330376714.json` 仅dispatch一次Y，立即及两秒后均为预期48字符、80UTF-8字节，前台身份不变，session结束确认inactive。实际回执仍是 `global_input / unverifiable`，成功依据是独立读回，不是回执宣称verified。协调者另从before-Y夹具重算：LF规范化全文加Y的SHA256为 `65d98feadf10acf5e827ca7341064bdcb2dfaca701d45e00b9425fdbf30a6bb9`；实际控件使用CR行尾，raw SHA256为 `7972498db850fe7217ed39b48c8ca870dbaa57c38c6c9b59071144076113a910`，与记录一致。作者消息曾将后者误称normalized hash，已更正口径，不改历史JSON。已授权最小候选源码增量，后续还须审查、云构建、候选驱动直测及真实Harness保存验收；默认服务／Preview未替换。

最小append源码已获Sol GO，自有fork提交 `7852ab1983b60c0ce581b8736c9da13eaf04640a`，GitHub author／committer均解析为既定账户ID。[专用Windows云构建37552571018](https://github.com/wszkxlllll/cua/actions/runs/37552571018)运行中，本机未编译Rust。Context增量后协调者 `tsc -b`、spike noEmit及全仓Vitest **1807/1807**通过，报告 `runs/diagnostics/unified-context-input-append-prebuild-retry-20261007.json`；第一次Vitest worker参数不完整导致0测试/退出1，保留原报告，不计通过。额外Node脚本selftests **69通过、1失败、1跳过**：provider-description probe发现Qwen Catalog仍按180字符截断说明，长switch描述尾部的sole-call／fresh-observe丢失，且type单一语义来源也受此限制。已安排最小修复真正的序列化消费者与回归，不以删测试或改阈值冒充修复；此缺陷独立于UIA追加实验，不能宣称全部检查已绿。

#### 新候选产物与普通desktop输入复验

上述云构建已成功：focused Rust测试4/4、Release编译通过；产物28,637,696B，SHA256 `400AB8670980ECD461F304FDC7E7A9D8A27F53585EA629B81EE1B7C260BC3095`。协调者独立核exe及manifest中的commit／source blob／lock，启动的是新隔离实例PID13356、独立pipe，未替换默认驱动。证据目录 `runs/diagnostics/candidate-v0222-document-append-37552571018-20261007`：普通desktop `type_text` 输入31字符seed，单次原生Enter后32字符，再普通 `type_text` 追加13字符中文，最后唯一Y；立即及两秒后读回均精确。seed／中文／Y真实返回 `accessibility / confirmed`，Enter为 `global_input / unverifiable`、以独立读回确认。中文后45字符规范化SHA为 `d4d680e26205094c1b83eddb1f7045c8ef3da6392c18ce7a2459e995ebaf8932`，Y后46字符为 `c78a71e33e7fcf1eea7b39fa9d4a2db278b195cb9f51b2e5745d7410cf85508a`；协调者从UTF-8夹具重新计算一致。此轮未用PS SetValue代写，没有重试，前台身份持续一致，各session关闭确认inactive。覆盖了真实失败中的“原生Enter后中文追加”边界，不只是空文档或已有LF；浏览器及真实Harness保存任务尚待完成。

Qwen消费者缺口已修复并集中审查GO：完整空白压缩的注册工具说明及一层已有参数说明进入strict Catalog，保留现有完整wire预算检查，超限明确拒绝、不截掉安全尾句；不恢复anyOf或维护另一份工具清单。switch说明压缩但保留scope／sole-call／fresh-observe语义。源码测试41/41；审查微修预算测试必填字段和probe措辞／合法type过滤错配，未放松真实工具存在时的完整说明断言。协调者统一构建后Node脚本selftests **70通过、1跳过、0失败**（Windows符号链接权限），Vitest **1809/1809**，报告 `runs/diagnostics/unified-append-context-catalog-final-20261007.json`。固定测试输入的Catalog体积增量不代表所有模块全开Token量；稳定系统前缀位置不变。源码已冻结，不在实机验收中途改生产代码／dist。

#### 真实Harness整桌面输入／保存复核通过（不是跨APP验收）

新候选的私有Edge单行回归通过，证据 `runs/diagnostics/edge-input-candidate-20261007010049754-5b659633/summary.json`：地址栏混合中文短文本及149字符local data URL、页面Edit均精确读回；session inactive、私有进程退出、owner lease释放，未触碰saved profile、剪贴板或外网导航。临时profile目录保留，不冒充已经删除。

随后唯一真实GLM Run `run-1791334981749-52dc04bf-654` 完成，证据目录 `runs/diagnostics/full-foreground-task-acceptance-20261007010253135-41d71a8e`。配置为Primary desktop、显式foreground-caret-v1、grounding off、switchWindows false、Guard off、Monitor shadow，100请求／100动作预算。不是携程查询或跨APP复测；模型正常决定动作，没有强制一次输入或人工补正文。实际正文430字符及独立Y均返回候选的focused Document确认文本；另一次134字符输入填写Save As路径。协调者严格UTF-8读取实际新文件，换行规范化后431字符与新marker＋原390字符fixture＋Y逐字一致，无替换字符；849字节，raw SHA256 `147dbdf66b05d11fa5258c203dbccbbe6ac7299d4b207a8d4081f55e6cea69d6`，LF逻辑文本SHA256 `50a2ed13f5b413e7bb863999bc424867238372984ea0461c686d3adc8f368ea2`。没有反复删改正文或重复填写路径。录像H.264、2560×1600、约199.067秒、无音轨；Run owner释放、close confirmed。

Run耗时194.243秒，10请求／10响应；请求等待合计165.285秒（约85.1%，含网络／服务响应／Provider处理，不能归因纯服务端推理）。9次GUI尝试为7 completed、2 partial ACTION_OUTCOME_UNKNOWN，分别是保存及取消验证对话框的点击。两次均保留原事实并获取新Observation；保存后是不同的Ctrl+Shift+S复核动作，取消后直接结束，没有盲目重放原点击。不能把它写成“零错误／所有动作confirmed”。此例依然主要慢在模型请求等待，不以输入修复宣称API延迟已解决。

原CLI输出 `incomplete_or_failed` 有明确的验收脚本缺陷：新增desktop fixture漏入起点验证，默认按 `Harness-managed browser` 判断，导致唯一基础谓词 `initialTargetMatchesGoalApp=false`。生产任务／文件并未失败。未来ignored runner改为按target.mode统一验证desktop起点，native/browser原匹配保留，离线正反测试通过；不改生产准入、不增加应用输入特例。原summary及失败状态不覆写，独立 `derived-reaudit-desktop-target.json` 依据实际Primary desktop起点重算全部基础谓词通过，同时保留2 partial。未选择的WPS／携程文件ENOENT不作为该单题的必需验收项。

本Run产生8条notice：3条中文（开始、unknown、完成，共37个CJK字符）及5条英文progress；作者消息一度误报5条中文，已纠正，以实际记录为准。此Goal为英文，不能据此宣称中文手机播报验收通过；无音轨也不证明或否定手机发声。本轮仅放行**候选驱动在本机整桌面、可写focused Document的空白输入及文末追加／保存链路**，不推广为所有应用、任意中间插入／选区替换、富文本Undo／格式或三平台输入全部解决。默认驱动与Preview尚未切换；实际部署另核版本及配置。

本轮新隔离daemon已正常停止：停止前核PID13356、exe路径／hash及专用pipe与新产物一致，同binary `stop --socket` 返回0，随后进程退出、专用pipe不再接受连接。默认及旧候选daemon未触碰，未删用户文件／登录profile／失败现场；新产物保留供后续部署。测试录像位于上述证据目录 `recordings/foreground-fixture-save-append-20261007010253135-41d71a8e-7478ee9c-9a9e-4e2f-8323-a025415250f0.mp4`。本轮主仓未commit／push或部署，只有自有CUA fork的候选提交与云构建。

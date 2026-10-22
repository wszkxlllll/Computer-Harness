# Computer Harness 技术文档

Lightspeaker是手机操作电脑的生活任务产品，Computer Harness是支撑它的执行内核。本文面向开发者，说明系统如何把模型决策、真实桌面操作和用户控制连接起来。安装与手机使用集中在[开始使用](./getting-started.md)，参与开发见[贡献指南](../CONTRIBUTING.md)。

## 总体结构

<!-- 总体架构图暂留空，待正式制作。 -->

手机网页通过HTTPS连接Relay，电脑Host主动建立经鉴权的WSS连接。Relay负责设备路由、转发和有界缓冲，不执行任务。Host将用户目标、审批和纠正交给ApplicationSession；每个任务建立独立Run，由同一RunController驱动，不在手机入口重建一套Agent循环。

模型从Context获得目标、截图、合法工具、相关历史及已启用的状态。Provider负责厂商请求格式和输出解析；Runtime负责校验、调度、动作准入及状态推进。Computer Adapter把公共动作转换为CUA操作，并返回观察和执行回执。Windows与macOS共享这些合同，平台输入和窗口证据在适配层分别处理。

代码入口：`packages/app-runtime/src/sdk.ts`、`application-session.ts`，`packages/runtime/src/run-controller.ts`；手机入口为`apps/host`、`apps/web`，中继为`apps/relay`与`packages/relay-connector`。

## 执行闭环与事实来源

<!-- 执行流程图暂留空，待正式制作。 -->

ComputerSession描述本任务操作的执行环境；ObservationFrame描述一次观察及其坐标范围。模型产生的ToolCall经统一ToolRegistry验证，Computer工具再转换为ActionIntent。动作根据当前观察进行校验和风险准入，执行后形成ActionReceipt，再取得新观察。

回执确认派发与执行状态，不能单独证明“已发送给正确联系人”或“文件内容准确”。模型需要从新画面核对任务进展；最终业务成果还可由人查看。程序记录动作开始、终态、工具结果和观察，避免把模型意图写成执行事实。

RuntimeEvent是状态变更的提交来源，轨迹以JSONL保存，reducer重建RunSnapshot。提交事件后再通知UI；通知订阅者异常不能撤销已提交事实。如果动作已经开始却缺少可信终态，保留unknown结果，不自动重放可能已发送、保存或删除的动作。模型请求可按有限规则重试，GUI副作用未知不采用相同策略。

暂停和恢复控制同一活动Run；纠正进入inbox并参与后续Context，过时的模型决定需要失效；停止取消后续推进并清理资源，不回滚已经发生的修改。轨迹重建不表示产品支持任意崩溃后的桌面自动续跑。

合同定义集中在`packages/protocol`、`packages/runtime/src/contracts.ts`，事件提交和重建在`packages/trajectory`。

## 跨应用与Surface

一个任务保留稳定ComputerSessionId，内部管理实际使用的Surface。SurfaceId与generation描述操作对象及其版本；切换窗口或页面后，旧观察、控件引用和坐标不能直接用于新目标。Registry不尝试建立完整桌面世界模型，仅接纳已有证据、且会影响当前操作正确性的对象。

在用户开启跨应用能力时，`list_windows`列出本Run可用的窗口候选，`switch_window`接受候选引用。候选被列出不等于可操作：适配层激活后重新确认身份与几何，取得新画面再继续。具有可靠父子关系的弹窗可进入相应生命周期；身份或关系不足时保留显式切换、用户确认或失败边界，不用同进程或同名窗口直接推断。

全桌面模式始终观察桌面可见画面，适用于跨应用兼容执行；可选的浏览器结构候选不应把桌面截图替换成单个浏览器截图，也不应在候选不可用时拒绝所有普通坐标操作。窗口范围采集与全桌面采集不同，都不提供操作系统沙箱或后台输入隔离保证。

Windows和macOS的私有输入、窗口/弹层证据、坐标机制位于`packages/computer-cua`内相应平台文件，共享协调器维护Session、Surface和Receipt。修改平台代码仍须回归公共合同，不以一端结果替代另一端实机验收。

## 视觉与可选结构定位

截图给模型提供整体布局、文字和视觉状态。UIA或macOS可访问性信息、受管浏览器DOM提供有界控件候选；模型既可用坐标`click`，也可用`click_element`等显式元素工具。元素目录由Computer产生，Runtime筛选并绑定当前观察，Context投影给模型，执行时再检查引用身份、几何和允许的动作。

DOM只对Host明确授权的受管浏览器开放，不因浏览器名称而访问个人浏览器。登录状态由用户在电脑端手动准备，保存于Harness自有profile。关闭标签页后的状态与清理属于受管浏览器生命周期，不从个人历史恢复页面。

UIA/DOM采集是独立能力，当前Host基础装配默认关闭额外grounding；具体Run及浏览器目标可覆盖配置。开启可能增加观察成本，不能把“工具已注册”当成模型实际消费或业务收益。坐标换算依据实际截图viewport与目标几何，不使用固定分辨率假设。

受管浏览器可随当前观察附带有界的可见正文片段（`visibleDocument`），独立于交互控件候选和原生表格文本：最多32块、合计4800字符、每块480字符及4个原生滚动区域。只保留完整且当前实际可见的块；过长、部分可见或超预算的块整体省略，不截成伪原文。Context仅投影与当前Observation、Session、Surface和已观察URL绑定一致的证据；预算不足时整体省略并记录trace，不挤掉原始Goal、纠正、最新截图、最近GUI闭环或最新reasoning，既有文本／wire上限不变。源文本是不可信的只读证据，不是输入授权；未见不代表不存在，片段不代表整页已读。滚动区域只报告原生`scrollTop`等当前指标，自定义CSS位移滚动仍未知。长文档的已见事实应按来源URL与要求项记入已启用的Memory／任务进度；反复滚动无新证据时改用当前GUI已暴露的查找或导航，或明确缺项。地址栏输入URL后仍须Enter及新观察的当前URL证明导航完成。采集、遮挡与坐标边界见[Computer CUA说明](../packages/computer-cua/README.md)。

## 工具与Provider

ToolRegistry统一维护工具名称、描述、参数、类别和audience。Provider消费当前注册表和Context合同，不维护另一份业务工具清单。GLM、Qwen、DeepSeek官方和火山方舟渠道各自负责请求参数、历史、思考续接及ModelTurn解析，Runtime保持公共ToolCall语义。

Qwen strict输出使用统一`calls[]`信封；工具目录仍提供参数语义，精确参数与调用组合在Runtime再次检查。其他Provider按其原生接口投影，不机械复制Qwen的wire格式。状态工具可以与合法GUI动作同轮返回；Control结束调用有独立边界，不能以任意多调用绕开依赖。

受限Batch采用同一文本控件内的连续输入序列，每个primitive独立校验、计预算、记录回执和观察。它不是任意连续点击，也不开放代码执行。中途失败、取消或观察失效时停止后缀，不重放未知副作用。

## Context Planning与Run Memory

默认Context实现位于`packages/context`；Runtime依赖接口而非反向绑定默认实现。稳定指令和工具投影与动态目标、截图、历史、纠正、Plan和Memory分开组织。raw/recent策略与预算控制历史范围，裁剪保持工具调用和回执配对及必要的Provider continuation。Context trace用于查看实际纳入和遗漏的内容，不把缓存友好组织等同于已证明的缓存命中收益。

Planning通过工具维护Run内TaskState，记录阶段目标、进度和阻塞，不是逐点击任务链或强制DAG。Run Memory保存继续任务需要的事实、证据及适用范围，与任务进度和完整轨迹分开。scope、状态、实体generation及证据参与使用准入；active、needs_check、superseded分别区分可用、待核实和已替代信息。默认lexical召回，hybrid需单独配置embedding服务；召回相关不等于事实当前仍成立。

Planning、Memory、Context和其他策略在Run启动时装配。关闭Planning/Memory时不创建其模块、注册工具或注入状态；不能残留另一条维护请求。Memory不是跨Run用户画像，手机编辑的个性化偏好是另一个入口：任务开始时冻结到该Run的Context，不更改权限或审批。

## 风险控制与Monitor

Guard是动作准入：本地扫描结合动作效果描述和当前调用判断放行、确认或拒绝；可配置额外语义模型，但手机Host当前源码默认`riskModel: off`，不能把它说成每一步另调模型审计。审批绑定待执行请求，用户同意后仍须复查当前操作条件，不授予后续任意动作永久通行。

Monitor是执行后的反馈，不是审批器。off关闭；shadow记录检测、证据和候选提示但不注入模型Context；guidance按当前实现提供后续提示。动作记录和已有assessment/evidence帮助描述重复或无进展，不新造一套同义字段。视觉变化和模型描述都不是独立业务真值。

手机Host基础配置由`apps/host/src/session-config.ts`定义：Planning开启、facts Memory、本地lexical、recent Context、受限输入Batch、layered Guard、风险模型关闭、Monitor shadow、额外grounding关闭。具体启动和Run覆盖以实际配置为准，不沿用旧报告或上次TUI状态推断。

## 手机语音与可访问交互

Web提供目标、状态、截图、审批、暂停/恢复/停止及纠正。配对凭据短时单用，电脑明确确认后才能建立设备会话；设备可撤销。Relay转发经鉴权请求，不排队重放GUI动作，未知回执需要先刷新状态。

语音输入由Host配置的识别服务处理，手机系统语音承担播报。任务开始、需要确认、进展和结束等通知由事件投影到用户端；进展文本要求描述已经确认的状态，而非把未来计划当成完成。手机播报受浏览器、声音、语言及用户设置影响；网页读屏通过语义标签、焦点、状态区域及完整句组织实现，需分别检查旁白与应用TTS的使用方式。

个性化配置允许编辑回答详略、说明方式、语言及附加文字，开始Run时投影到Context；显示和辅助交互偏好不提高操作权限。可访问性工程检查与老年人、视障用户的真实试用是不同工作，后续需持续结合反馈完善。

## 替换组件与参与开发

`createRunFactory`与`RunDependencies`提供Provider、Computer、Context、Planning、Memory和Policy等工厂接缝。外部实现必须遵守已有事件、状态、生命周期和清理合同；没有工厂时不静默回落默认实现。当前不要求动态加载插件或运行中热切换。

每个新字段必须有生产者、消费者、更新/失效和清理规则。不能把GUI副作用伪装成普通side工具绕过ActionPolicy。模块替换须覆盖关闭态、组合态、跨Run隔离和失败清理；CI运行离线合同，真实API和桌面动作另行授权。

更细的历史合同、实现审查和版本化证据保留在[历史资料](./history/README.md)，不作为用户安装的必读材料。

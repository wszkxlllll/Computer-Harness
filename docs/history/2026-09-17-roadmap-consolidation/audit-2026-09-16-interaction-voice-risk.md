# 实时交互、语音和 Risk Guard 深入审计

日期：2026-09-16  
文档角色：审计 / 后续设计建议  
状态：当前结论，建议尚未实现  
当前入口：[审计总览](audit-2026-09-16-overview.md) → Stage 6  
基线：`39ff27f`  
范围：实际桌面中的用户交互、输入抢占、审批、语音和隐私边界；不评判正式模型任务成功率。

## 1. 已具备的基础与缺口

`RunController` 已具备持久化事件、纯 Reducer、命令 Inbox、暂停/恢复、纠正、Abort、审批和未知副作用处理。这些不是需要重建的能力。`ProviderAdapter.generate()` 目前返回完整 ModelTurn，两个 Provider 的请求均设置 `stream:false`。

`apps/cli/src/tui.ts` 是一次 Run 的调试监视器：120ms 定时重画、复制全部事件、字母快捷键、字符隐藏输入。没有独立持续会话应用、语音或终端外全局热键实现。`packages/` 和 `apps/` 中未发现 STT/TTS/录音实现；其他仓库历史上的 Voice Bridge 不能算本仓库已具备。

## 2. 确认的问题

### I-01：审批时界面/焦点变化没有被检测（P0：高风险执行前）

位置：`packages/runtime/src/run-controller.ts:787` 的 `executeApprovedCall`；`packages/computer-cua/src/cua-driver-computer.ts` 的 `execute/actionRequest`。

目前批准保留 prepared Action，这是优点；但仅检查 Harness 的 `latestObservationId` 是否仍相等。等待期间桌面弹窗、窗口移动、用户切到 TUI，均不一定创建 Harness Observation。因此旧 ID 相等不代表目标仍相同。`type`/`keypress` 同样危险，因为当前 CUA 指向 primary desktop，输入到当时的焦点。

相反，“批准前再截图，然后只比 ID”会把正常情况也全部拒绝：新截图必然有新 ID。不能把身份标识用作画面比较算法。

**建议分两步实现：**

1. 当前主屏幕模式先采用保守恢复：一旦用户交互/审批/接管，旧坐标和焦点假设失效；重新观察，由主模型重提动作。新的单次审批授权若没有可验证目标绑定，不自动套用旧授权。允许多一次确认，但不做无限自动重提循环。
2. 窗口能力接入后再做可用的审批复用：批准绑定 Run、Action 内容摘要、目标引用、期望效果、用户约束版本、单次消费状态。恢复时检查目标窗口身份/几何、控件引用、焦点或可定向输入条件。能证明同一目标才执行；目标改变或证据缺失则取消旧授权并重提。

全屏 hash 不是理想方案：光标、时钟、动画会误触发；相似画面也不证明同一账号/订单。可把目标区域图像变化作为辅助信号，不能单独授权高风险动作。即便验证成功仍存在检查到执行间的竞态；窗口/元素定向可缩小它，不能声称原子业务事务。

### I-02：个人桌面的 TUI 本身会抢走执行目标（P0：交互式本机体验）

目前全部 CUA 动作使用 `delivery_mode:foreground` 和主屏幕；TUI 必须获得终端焦点才接收按键。用户开始纠正时，Agent 可能仍在等待模型或执行输入。自动输入也可能落入 TUI 并被解析为 P/R/A/Y/N。

这不是换一个 React 组件就能解决的问题。建议引入应用层 control ownership：`agent / user / handoff`。用户请求接管后先停止新动作准入，等待已提交动作收尾，再允许编辑；返回 Agent 时重新观察。紧急 Abort 独立于普通命令队列。前台操作期间不承诺用户可同时使用同一桌面；窗口后台能力通过单独验收后再开放共用。

终端内热键不等于全局热键。在桌面其他窗口获得焦点时，需要 OS-specific hotkey adapter 才能触发录音/接管。避免默认绑定飞行模式、媒体键等硬件功能键。按键事件需去重，不能靠模拟按键控制录音。

### I-03：暂停/纠正是排队生效，界面缺少及时反馈（P1）

`RunController.run` 直接 await `provider.generate`；普通 Inbox 在调用返回后处理。现有 API 可以保留纠正且不执行旧响应，但用户可能等待整个请求甚至重试窗口，才看到命令完成。TUI 的 `busy` 还把多个普通控制请求串成“前一个完成前直接忽略新操作”。

建议区分“命令已接收”和“已在安全边界应用”。为模型调用/风险复核设置子 AbortController，用户纠正使当前请求失效并尽快取消；不要取消整个 Run。已发给 Driver 的副作用不能套用模型请求的取消语义，仍需 Receipt/unknown 收尾。使用请求 generation 防止迟到响应回流。命令回执先显示 queued，再显示 applied/rejected，而不是显示用户点击没有反应。

### I-04：TUI 输入/渲染只完成了基本示例（P1）

`tui.ts:10/58/76` 附近：每120ms `getEvents()` structuredClone 全历史，renderer 又反向复制查找事件；输入仅接收 `text.length===1`，不能可靠支持多字符粘贴、组合输入或 UTF-16 surrogate pair；Backspace按 code unit 删除；全部输入隐藏使纠错难以使用。`clip` 只折叠空白，没有完整清理 ANSI 控制序列，错误文本进入终端显示前应做安全显示投影。

唯一 TUI 单测只验证渲染不显示 action.text；没有键盘、中文粘贴、终端尺寸、退出收尾和审批竞态测试。普通输入应可见，显式秘密输入才遮蔽。读屏模式采用追加式信息和稳定焦点，避免持续全屏刷新。

## 3. Risk Guard：现有分层值得保留，但信号不足

### R-01：风险关键词豁免存在直接漏洞（P0）

位置：`packages/risk-guard/src/index.ts` 的 `scanDeclarationText`。先把 target/summary 拼接，再用 `view|show|...|write|type|...` 的任意子串命中跳过全部高风险词。独立无桌面探针：

| 声明 | 动作 | 实际 Guard 返回 |
|---|---|---|
| navigate，target=`Submit order`，summary=`Open details` | click | require_approval |
| navigate，target=`Submit order preview`，summary=`Open details` | click | allow |

`preview` 含有 `view`。这只证明规则会跳过 signal，不证明当前按钮真的执行支付；但对于风险路由已足够构成确定的缺陷。不要只给英文正则加词边界就算修完，中文、否定和“查看并提交”等混合意图仍需测试。

修正方向：动作类型、目标信息和内容引用分开；type 文本里的“不要发送”不等价于点 Send；描述性词不能覆盖独立的提交/付款证据。歧义走 reviewer/审批，明确低风险保留本地放行。

### R-02：自述声明仍是主要放行依据（P0：安全承诺；P1：研究改进）

`routeCandidate` 的低风险路径不读画面内容。主模型把实际危险 click 说成“Details / navigate”，就可能直接通过。target/summary/effects 同属一个模型输出，三者一致不是独立证据。现有 `hasProtectedInput` 只覆盖少量字符串形状；普通密码、邮箱、地址、分隔银行卡号等并非都可识别。

**推荐的升级仍是分层，不逐动作再问一次模型：**

1. 确定规则：用户设置的禁用动作、已知高风险效果、可靠控件角色/标签/受保护输入来源 → deny/confirm。
2. 本地低风险：限定应用/目标中的可逆编辑、滚动、普通导航，且无矛盾信号 → allow。
3. 不确定且可能高影响：声明冲突、未知控件、跨账号/外部提交边界 → 按需模型复核；无法确认则请求用户。

现在没有 OCR，不建议为了此路由立即引入每帧 OCR。先修现有规则和产品模式，再利用 CUA 窗口/UIA 能力补充只读证据。控件文字依然是不可信页面数据，不能改变系统规则。纯像素模式无法识别全部隐性风险，须如实标记保护范围。

BERT 类文本分类器可以成为将来的低成本路由器候选，但它也看不到实际点击目标；没有标注集前不优于校准后的规则，更不能成为放行的可信证明。先积累误拦截/漏拦截样本，再离线比较召回、误报和路由成本。

### R-03：需要防止另一条副作用路径绕过 Guard（P1）

目前 Guard 针对 ComputerToolDefinition；Planning/Memory是状态工具，符合当前用途。以后增加 launch_app、剪贴板、browser mutation、文件/代码工具时，不能为了省事放进 side category 后避开 ActionPolicy。先分类“只读发现 / Runtime状态写入 / 环境副作用”，对后者统一 policy seam，再注册能力。

### R-04：脱敏没有覆盖整个数据流（P1）

reviewer 只删掉了 action.text，但仍发送 goal、最近纠正、Plan subject、声明和完整截图。Guard evidence 正则脱敏不等于出站截图或轨迹脱敏。CLI `summarizeProviderResponse` 保留 native tool arguments；Trajectory 的原始 ToolCall/Action也有文本。这是本地原始证据的设计选择，不能宣传为默认无敏感数据。

建议明确三条通道：原始本地证据（限制访问与保留时间）、脱敏 UI/共享导出、Provider 出站数据（明确数据源和配置）。不要破坏审计所需原始事实，但分享时必须重新生成脱敏包。riskModel不同于主Provider时，说明截图也会发送给它。TTS默认不播报凭据/完整隐私内容。

## 4. 产品交互建议：共享命令面，独立显示层

建议由共享应用组装创建 RunController，TUI 只消费事件/快照和发送命令。持续 App Session 管理多个一次性 Run；当前 RunController不能start两次是合理限制，不应为“多轮界面”强改成可重复 start。Run结束后的下一项任务开新Run；跨Run记忆和Crash恢复另行设计。

### 4.1 事件流

在事件成功持久化且 Reducer应用后，发布只读 committed event；订阅者异常不回滚执行。订阅使用 sequence cursor、取消订阅和有界缓存；消费者落后时从日志补读。UI更新可以合并，Approval/错误不能丢失。不要让慢 UI/TTS 阻塞事件写入。

模型的流式文本/工具参数片段可用单独 transient progress 通道，不把每个 token 写进权威 Event。只有完整响应通过解析/Runtime验证后才执行工具；不能边收到半个 JSON 边点击。当前非流式HTTP仍可先接事件TUI，之后独立验证Provider流式。

### 4.2 新字段按需添加

| 建议对象 | 生产者 → 消费者 | 生命周期 |
|---|---|---|
| commandId/queued/applied/rejected | App命令面 → UI/语音 | 当前Run，完成或关闭清理 |
| request generation | Runtime请求调度 → 迟到响应检查 | 每次模型请求，取消后失效 |
| target/evidence binding | Computer观察 → 准入/审批 | 每个有效Observation，目标变化失效 |
| approval binding摘要 | Runtime → UI及恢复验证 | 单次准入，纠正/取消/目标变化后失效 |

这些是建议，不要求一次把字段塞进 protocol。生成与消费闭环随实现同时落地。

## 5. 语音：作为可插拔交互通道

建议先采用“按键开始/停止录音 + 流式识别 + 一次最终提交”，最终回复TTS。暂不增加逐动作模型播报。可提供确定性阶段提示（等待审批、暂停、失败、完成），不需要新的VLM调用。

模块边界：AudioCapture/Playback/Hotkey由各OS适配；STT/TTS Provider仅负责协议；VoiceSession聚合识别片段并调用同一个应用命令面。Runtime不依赖麦克风、播放器和厂商SDK。TUI不必承担音频设备控制。

建议流程：`idle → recording → finalizing → submitted`，另有取消/错误；一次录音可以包含多个final sentence。按segment ID/revision更新，不把第一句final当整段结束；stop后等待服务端最终结果或明确超时。识别partial只预览，不触发动作。请求取消/Run变化后迟到音频结果不得发到新Run。

TTS按句或短段排队流式播放；用户开始录音时停止旧播放，清空旧generation队列，避免系统读自己。取消合成与停止本地播放都要做。不得把TTS回声中的“同意”作为审批。初版高风险确认仍用明确的审批交互；将来语音确认需绑定当前唯一requestId和目标摘要，而非全局yes关键词。

中国厂商可先验证已有账号能用的阿里云流式STT/TTS；这是一条协议候选，不是本轮价格/效果结论。官方有实时ASR和可取消流式合成，但模型/地域能力不同，需选定后验证。其他Provider/本地模型沿同一接口替换。[ASR模型文档](https://www.alibabacloud.com/help/zh/model-studio/asr-model/)；[流式TTS与取消说明](https://www.alibabacloud.com/help/zh/model-studio/realtime-tts-user-guide)。

TUI可考虑Ink；官方提供基础读屏支持，但不是选用后自动满足无障碍。必须真实验证中文输入、焦点、NVDA/目标终端和不重复播报。[Ink说明](https://github.com/vadimdemedes/ink#screen-reader-support)。

语音关闭时不初始化设备、不注册全局热键、不发网络请求、不残留录音状态。需保留文本输入作为同等功能入口。数据默认只持有到识别/播放完成；是否保留音频必须独立配置，不能随trajectory导出整段麦克风音频。第一版不需要开发另一个能自主操作电脑的语音Agent。

## 6. 验证和完成标准

1. 离线：低/高风险声明、错误声明、双语混合、否定、preview等豁免反例；确认Guard关闭基线、复核预算耗尽、异常和Abort。
2. 交互fixture：审批后移动目标、切焦点、弹窗、两次审批、旧Run确认、语音迟到、用户纠正与模型返回同时发生。旧目标不得执行；没有已知副作用重复投递。
3. 终端集成：中文/多行粘贴、长历史、resize、普通/秘密输入、Ctrl+C、异常恢复raw mode。初版以命令queued反馈p95<100ms为工程目标，实际停止时间独立记录，不伪造“即时停止”。
4. STT：两分钟多句、长停顿、stop-finalization、网络断开与重连、TTS回声；记录遗漏句、重复句、stop到final时间、首音频时间和打断到静音时间。不用Provider RTT代替整段体验延迟。
5. 风险质量：使用无真实交易/删除的模拟表单，独立标注应放行/审批/拒绝；报告误放行、误拦截、额外模型占比与延迟。179项回归和真实API格式通过均不能代替这项。
6. 本机只先体验可逆任务；遇到无法绑定目标的批准动作，回到重新观察路径。若规则/模型误报太高，调整路由和UI，不把全部动作升级成逐步双模型调用。

停止/回退：错误目标执行、过期审批生效、取消后新副作用、语音回声批准等任一发生，关闭相应交互增强，保留日志并回到单Run受控模式。不能为过测试放宽旧坐标检查。

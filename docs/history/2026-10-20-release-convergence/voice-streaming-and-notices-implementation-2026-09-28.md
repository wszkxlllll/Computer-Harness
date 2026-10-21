# 语音合同、运行通知与阶段 B1 实施记录

日期：2026-09-29
文档角色：结果 / 实施记录
状态：阶段 A、B1、B2 与 ObservationAssessment 语义进度扩展已实现；Browser TTS 已完成首轮 iOS 真机连通，真实 TTS 服务与完整跨端验收待实施
当前入口：[产品开发、验证与稳定 Demo 清单](./product-next-stage-task-list-2026-09-27.md) 第 4 节、第 11.4 节
基线：阶段 A commit `e98502b`；B1 当前工作树变更尚未提交
范围：provider-neutral 语音合同、流式录音/ASR、RuntimeEvent 到 RunNotice 的纯投影和通知调度、Host/SSE 安全通知投影、Web 可选浏览器播报。没有实现真实 TTS 服务、后台/锁屏保证或完整设备矩阵。

## 当前结论

新增 `@computer-harness/voice` 包，依赖仅为 `@computer-harness/protocol`。Runtime、Guard 与 RuntimeEvent 没有语音专用字段，也不依赖该包。`ApplicationRemoteRunApi` 通过可选 `runNotices` 配置为每个 Run 装配 projector/scheduler；默认关闭时，不增加公共事件。Host 允许经过筛查的动态通知，但每个 Run 默认关闭；手机只有在播报开关开启时才随新 Run 提交 `runNoticeContentEnabled=true`，该值参与幂等指纹。公共 SSE 仍沿用有序 `run.event`，只包含最小 notice 字段，不暴露原始 RuntimeEvent、Guard 英文 reason、坐标、输入内容、路径或内部 `progressSemantic`。

Web `useRunFeed` 从 SSE 读取 notice 并按 `noticeId` 去重，同时按 SSE 序列维护 pending request，旧 GET snapshot 不能覆盖更新的审批状态。手机端只有用户打开“朗读任务关键通知”才调用浏览器 `speechSynthesis`；默认关闭，速度可选慢/标准/稍快。创建 Run 后使用同文档导航以保留移动浏览器语音激活；普通话通过 `zh-CN` 与普通话 voice 优先级请求，最终音色由系统提供。Browser TTS 实现 `VoiceOutputAdapter`，`VoiceCapabilities.createOutputAdapter()` 可替换为后续真实 TTS。

旧 `apps/web/src/voice-capabilities.ts` 的 `VoiceCapabilities.readAloud` 与 `transcribeOnce` 保持原样，旧调用方不需迁移。新合同位于 `packages/voice/src/contracts.ts`，不把一次性 facade 假装成流式 Provider。

## 已实现的数据流

```text
录音 Provider
  └─ VoiceInputSession.events
       ├─ recording / finalizing / terminal state
       └─ transcript_updated(segmentId, index, revision, partial|final)
              └─ reduceVoiceInputEvent 合并成可编辑的有序 transcript

已提交 RuntimeEvent
  └─ RunNoticeProjector
       └─ RunNotice
            └─ RunNoticeScheduler（Run/generation 校验、pending 校验、去重、限频、优先级）
                 └─ Host 当前 pending ID 校验并发布最小 run.notice SSE 投影
                      └─ Web 按 noticeId 去重
                           └─ 显式开启后交给 BrowserSpeechOutput
```

### 录音和转写

`VoiceInputAdapter.start({ signal })` 由未来录音/识别 Provider 实现，产生一个唯一 `sessionId` 和 `VoiceInputSession`。Provider 先发 `recording` 状态，再按段产生转写更新；Web 录音界面消费 `events` 并调用 `finish()` 或 `cancel()`，继续读到一个 terminal state 后结束事件流。

| 字段/合同 | 生产者 | 消费者 | 结束、失效与清理 |
| --- | --- | --- | --- |
| `sessionId` | 每次录音的 Input Adapter | Transcript reducer / Web 录音状态，用于拒绝上次录音的迟到事件 | `finished`、`cancelled`、`failed` 或 Run 关闭后清除本地状态；不跨 Run 保存 |
| `state_changed.state` | Input Adapter | Web 用于展示录音、收尾、完成、取消或失败状态；Reducer 只接受合法状态迁移 | `finished`、`cancelled`、`failed` 为终态；终态后所有转写更新均被忽略 |
| `segmentId` | STT Provider，为一段可修订转写分配稳定 ID | Reducer 定位要替换的段落 | 生命周期限于 session；新 session 不能复用旧 session 的事件 |
| `index` | STT Provider，表示段落顺序 | Reducer 排序并组成完整可编辑文本 | session 终结时随 transcript 清理；同一 session 的不同 segment 不允许占同一 index |
| `revision` | STT Provider，每次修订递增 | Reducer 丢弃旧 revision，保留最新 partial/final | 仅在 session 期间比较；新 session 从头开始 |
| `text`、`state` | STT Provider；`state` 是 `partial` 或 `final` | Web 展示/编辑；Reducer 用稳定 segment ID 合并 | 一个 `final` 只终结该段当前版本；整个录音只能由 `state_changed: finished` 结束 |
| `finish()` / `cancel()` | Web 用户动作 | Input Adapter；调用方继续消费 events 直到 terminal state | finish 要求停止采集并冲刷识别；cancel 要求停止采集并丢弃未完成识别；二者不得将风险审批转成批准 |

`reduceVoiceInputEvent()` 已提供纯函数合并器：拒绝其他 session、低版本 revision、重复 index 及终态后的事件；排序后由 `transcriptText()` 拼成待编辑全文。Provider 必须在分段文本中保留自然空格/标点边界。该 reducer 有单元测试，但当前尚无真实录音或 STT 事件生产者。

### TTS 输出

Web 当前实现 `BrowserSpeechOutput.openSession()`，用浏览器 `speechSynthesis` 播放已准入的 `RunNotice`。其为首个低延迟输出适配器，不访问麦克风、不请求录音权限、不保证后台/锁屏持续播放，也未在真实 Android/iOS 设备测量延迟。后续服务端/系统语音 Provider 可通过 `VoiceCapabilities.createOutputAdapter()` 替换。

| 字段/合同 | 生产者 | 消费者 | 结束、失效与清理 |
| --- | --- | --- | --- |
| `chunkId` | Host/通知消费者，通常取 `RunNotice.noticeId` | Output Adapter 做同一语音流内去重/诊断 | 限于 output session；session 关闭后删除 |
| `sequence` | Host/通知消费者，在一个 output session 内递增 | Output Adapter 保证文本分块顺序 | 新 output session 重置；迟到的旧 session 分块不得进入新 session |
| `text` | RunNotice 消费者或经确认的文本回复切片 | Output Adapter | 不作为轨迹长期存储；播放后按产品保留策略清除 |
| `enqueueText` | Host/Web 对已准入文本分块的写入 | TTS Provider | Provider 接收后尽快开始工作；`finish` 后不得再写入 |
| `finish` / `cancel(reason)` | 通知调度器、用户停止键、Run 关闭或更高优先级通知 | Output Adapter | finish 排空后释放音频资源；cancel 应尽快终止合成和播放；Run 切换时旧 session 必须取消 |

本阶段只有类型合同，没有音频格式/编解码器、付费 Provider、自动播放许可、WebAudio 播放器或设备级延迟承诺；避免预先冻结 Host 与手机之间的音频传输形态。

### RunNotice 投影和调度

`RunNoticeProjector` 只消费单 Run、按序提交的 RuntimeEvent，每个事件最多产生一个 notice。它对 `run.created` 生成一次自然的开始提示，不读取 Goal。RemoteRun 在重放事件前创建 projector，因此客户端晚订阅也能从 SSE 缓冲恢复且不重复投影。动态正文必须同时通过 Host capability 与逐 Run opt-in；控制字符先规整、完整文本先做敏感扫描再截断。旧客户端、关闭开关或命中敏感模式时使用简短中文安全提示。

普通成功 GUI action 的旧进度候选路径已关闭：`assistantText`、`declaredEffect.summary` 与 Planning subject 不再绑定到动作 Receipt 上播报。没有明确语义进度时，动作完成、截图和 Guard 事件都不产生动作进度通知；不按动作数量发模板提示。

`ModelTurn.observationAssessment` 是可选的结构化回合注释，包含当前 `observationId`、前一 GUI `actionId`、`actionOutcome`（`expected_change`、`no_effect`、`unexpected_change` 或 `uncertain`）、简短可见证据，以及可选的 `progress: { kind: milestone | blocked, summary }`。GLM 与 Qwen 适配器把它作为正常 action/control ToolCall arguments 中的可选字段读取，再还原为 ModelTurn 顶层字段；不会因此发起额外模型请求。协议说明和 schema 留在稳定 Provider 前缀，具体观察/动作 ID 与 Monitor guidance 通过现有动态 Context 消息传递。此处描述的是 Harness 适配器合同，不表示远端 API 提供了独立的 ObservationAssessment 能力。

Runtime 在提交 `model.response.received` 前，要求 assessment 的 Observation 是当前最新帧、action ID 对应前一 GUI action 的回执，并且该帧在回执之后产生。字段无效、缺失、过期或动作不匹配时只丢弃可选 assessment，不让有效的模型回合失败。Monitor 将保留下来的语义分类与已提交回执及视觉 transition 一起归并；缺少确定性证据、回执失败或两者不一致时结论为 `uncertain`。`no_effect`、`unexpected_change` 与 `uncertain` 的指导继续走现有 `monitorGuidance` Context 路径，要求模型检查当前状态并据此选择动作，不替模型执行动作或覆盖回执。

RunNotice 只在当前 Observation/action、completed receipt、receipt/observation 来源 Event ID 与同一 `monitor.transition` 全部匹配时产生动作里程碑。仅接受 `changed + expected_change + progress.kind=milestone`；动态正文开启且摘要通过筛查时直接朗读 `progress.summary`，不添加机械前缀，也不朗读 `evidence`。`unexpected_change`、`no_effect`、`uncertain` 和 `blocked` 不语音播报，仍通过 Context guidance 影响模型。Planning 阶段可朗读安全的当前阶段主题，但不能表述为已完成。

通知类型：

| `kind` | 来源 | `delivery` | 当前文字策略 |
| --- | --- | --- | --- |
| `progress` | Run 开始、已验证 milestone 或 Planning 阶段变化 | `polite` | 开始提示自然简短；milestone 直接读安全摘要；Planning 只表述当前阶段；Monitor 原始结论不播 |
| `approval` | `approval.requested` + 精确 `callId` 关联的 Guard 事件 | `interrupt` | 按有限风险类别与动作类型生成中文“可能涉及”提示；不读英文 reason、坐标、输入值或未验证 target/summary |
| `question` | `user.input.requested` | `interrupt` | 动态 opt-in 且通过筛查时直接读问题，否则使用简短安全提示 |
| `error` | Runtime 错误或 Provider 请求失败 | `interrupt` | 通用提示查看详情，不朗读错误原文、密钥或路径 |
| `result` | `run.finished` | `interrupt` | 只有 `succeeded` 可朗读安全动态摘要；失败、取消、预算耗尽、结果未知始终读对应状态 |

`RunNotice` 字段由 projector 产生，scheduler 与未来 Host 消费：

| 字段 | 用途 / 生命周期 |
| --- | --- |
| `noticeId` | 由 Run、源 Event ID、kind 和固定/动态 variant 派生；scheduler 消除事件重放造成的重复通知 |
| `runId`、`eventSequence` | Host 绑定活跃 Run、保持先后次序；Run 切换后旧 notice 失效 |
| `eventId` | 对应权威 RuntimeEvent，供 Host/测试追溯来源；不反写 RuntimeEvent |
| `kind`、`delivery` | scheduler 决定通知类别、礼貌排队或请求中断当前播报 |
| `text` | TTS 消费的唯一文案；由安全 notice 投影产生，经长度限制和控制字符清理；公共 SSE 不含原始模型文本 |
| `dedupeKey` | 同一阶段/结果语义重复时去重；只保留当前 Run 的有限集合，Run 切换/clear 即释放 |
| `pendingRequestId` | approval/question notice 取自权威请求事件；scheduler 出队时要求 Host 提供当前仍 pending 的 request ID 集合，否则丢弃该 notice |

`RunNoticeScheduler` 对普通阶段提示保留 12 秒最小间隔；内部 `progressSemantic` 明确标记 Run 开始和已验证 milestone，使二者不被普通限流永久丢弃，该字段不进入公共 wire。审批、提问、错误和完成绕过限频并打断当前播放。Host 出队时重新核对当前 pending request ID；审批已解决即 fail closed 丢弃。结果通知清空队列并成为终态。队列与去重集合有界，切换 Run 会递增 generation 并清理旧状态；Web 再按 noticeId 去重 SSE 重放。

### Host 与 Web 的 B1 接入

- Host 装配启用 RunNotice capability；动态正文仍由每个新 Run 的显式手机 opt-in 决定。RemoteRunAPI 在 committed RuntimeEvent 后投影，审批用 requestId/callId 精确关联结构化 Guard 类别和对应动作，再于出队时核对当前 request ID。关闭 `runNotices` 时没有新公共事件。
- `useRunFeed` 只接收结构校验通过的最小 notice，按 `noticeId` 留存最近 24 条；同时直接消费有序 `run.pending_request`，审批 notice 早于 GET snapshot 时仍能及时播报，resolved 后立即取消。较旧 GET 不能回退新 SSE 状态。
- Preferences 的 `voice.runNoticesEnabled` 默认 `false`；`voice.speechRate` 为 `slow/normal/fast`，分别映射为 `0.85/1/1.15`。版本 1 的旧偏好保留显示/回答设置并迁移成语音关闭的版本 2。
- 用户启用后，BrowserSpeechOutput 逐 notice 创建普通话 utterance；`delivery: interrupt` 会取消当前语音。controller 用 intent epoch 保证新的高优先级通知淘汰未开始的旧通知。切换 Run、卸载、用户输入、审批/问题失效或录音开始都会取消输出；真正 `enqueueText()` 前再次核对 SSE pending 状态。
- 设置语速会取消旧速率的活跃输出 session；下一条通知以新速度重新打开 session。pending request ID 在相应 utterance 结束/失败后释放，后续 unrelated 通知不会再受它影响。Browser session 会把播放和 finish 失败传回 Web 可见降级文案。StrictMode 下重复 effect 通过 per-Run cursor/notice 去重；短暂 cleanup probe 不会误取消存活输出，真实卸载后取消。
- 不支持 `speechSynthesis` 时，设置页明确显示并禁用开关；播放抛错时运行任务不受影响，页面显示错误，通知仍在文字时间线。

审批不消费英文自由 reason 或模型声明正文；里程碑、阶段、问题与成功摘要只在逐 Run opt-in 且通过已知敏感模式过滤时进入 notice。该过滤是产品降级边界，不构成对任意模型文本的完整语义隐私保证。

## 本阶段验证

验证覆盖 GLM/Qwen assessment schema、当前 Observation/action 与来源 Event ID 绑定、Monitor 冲突、结构化中文审批、敏感降级、逐 Run opt-in、SSE pending 竞态与 replay、milestone 限流以及四类非成功终态。受控真实 GLM 已验证放宽后的 milestone 可产生；iOS 真机已确认普通话和基础任务播报连通。审批中文正文和阶段摘要仍需用户复测，真实 TTS、锁屏/后台和完整延迟矩阵尚未实现。

## 下一阶段接点与未实现项

1. 实现 `VoiceInputAdapter` 与 Web 录音控制，显示 partial/final、等待整段 session terminal、允许编辑后通过现有 Goal/Correction/Question 命令提交；取消、权限拒绝和网络失败要可见。
2. 选择第一个真实 STT/TTS Provider；密钥留在 Host/服务端。浏览器语音只证明输出合同与本地播放入口，不能替代真实服务评估。
3. Android/iOS 真机验证 TTS 起播延迟、后台/锁屏行为、焦点、取消时延、重复播报和失败降级；未验证前不声称移动语音链路已交付。
4. 录音到 partial/final、首个可听片段、完整播报与 cancel 生效的延迟；记录转写修订/漏句、误播敏感内容、重复进度和抢占成功率。

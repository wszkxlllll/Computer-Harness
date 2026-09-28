# 语音合同、运行通知与阶段 B1 实施记录

日期：2026-09-29
文档角色：结果 / 实施记录
状态：阶段 A 与 B1 已实现；STT/录音、真实语音服务和手机真机验收待实施
当前入口：[产品开发、验证与稳定 Demo 清单](./product-next-stage-task-list-2026-09-27.md) 第 4 节、第 11.4 节
基线：阶段 A commit `e98502b`；B1 当前工作树变更尚未提交
范围：provider-neutral 语音合同、转写段落合并、RuntimeEvent 到 RunNotice 的纯投影和通知调度、Host/SSE 安全通知投影、Web 可选浏览器播报。没有实现录音/STT Provider、真实 TTS 服务或设备级播放保证。

## 当前结论

新增 `@computer-harness/voice` 包，依赖仅为 `@computer-harness/protocol`。Runtime、Guard 与 RuntimeEvent 没有语音字段，也不依赖该包。`ApplicationRemoteRunApi` 通过可选 `runNotices` 配置为每个 Run 装配 projector/scheduler；默认关闭时，不增加任何公共事件。Host 显式开启投影并固定 `dynamicContentEnabled: false`。公共 SSE 仍沿用有序 `run.event`，其中 `data.type = "run.notice"`，只包含 `noticeId`、`kind`、`text`、`delivery`、Runtime `eventSequence` 和审批/问题通知所需的 `pendingRequestId`，不暴露原始 RuntimeEvent、Guard reason、路径或私有候选字段。

Web `useRunFeed` 从 SSE 读取该投影，并按 `noticeId` 去重；重连后的重复投影不会重复播报。手机端只有用户在偏好中打开“朗读任务关键通知”才调用浏览器 `speechSynthesis`；默认关闭，速度可选慢/标准/稍快。Browser TTS 实现 `VoiceOutputAdapter`，旧 `VoiceCapabilities.readAloud` / `transcribeOnce` facade 仍保留，并新增可选 `createOutputAdapter()` 供替换实现注入。Host 只提供固定安全 notice，不将模型自然语言或 Guard 原因转给语音输出。

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

`RunNoticeProjector` 只消费单 Run、按序提交的 RuntimeEvent，每个事件最多产生一个 notice。默认 `dynamicContentEnabled: false`，只生成固定状态文案；用户显式开启动态内容后，才会把筛查通过的动态文本放入 notice。

进度候选顺序为：

1. `model.response.received.turn.assistantText`；
2. 本轮 Computer ToolCall 的 `declaredEffect.summary`；
3. 当前 `in_progress` Planning task 的 subject；

候选只在模型响应中暂存，不立即播报：`model.response.received` 先按 `ToolCallId` 保存候选；`action.proposed` 将候选绑定到 `ActionId`；只有对应 `action.execution.completed` 且 Receipt 为 `completed` 时，才生成关键进度 notice。`tool.call.rejected`、`tool.call.failed`、action refused/failed/cancelled 都会丢弃候选。没有候选时不产生动作进度，不按动作数量发模板提示。

Plan 投影维护按 task ID 索引的当前 Run 任务；一个 pending/completed/blocked Task 不会清除其他 Task 的 in-progress 状态。Planning 阶段变化是已提交状态，可以产生一条阶段 notice。普通 GUI action 必须有对应的语义候选、成功 Receipt 并通过 Scheduler 限频/去重才会产生 notice；裸 `action.execution.completed`、截图事件和 `action.guard.evaluated.reason` 不产生普通进度。Guard 开关不影响通知投影。

通知类型：

| `kind` | 来源 | `delivery` | 当前文字策略 |
| --- | --- | --- | --- |
| `progress` | 已确认的 Computer 动作，或 Planning 阶段变化 | `polite` | 默认固定文案；用户显式开启动态内容后，使用筛查通过的阶段/模型说明，并标明是模型说明且正在核对结果 |
| `approval` | `approval.requested` | `interrupt` | 固定提示查看审批详情，不朗读模型 Guard 原因 |
| `question` | `user.input.requested` | `interrupt` | 默认固定提示；用户显式开启动态内容且问题通过已知模式筛查后才朗读原问题 |
| `error` | Runtime 错误或 Provider 请求失败 | `interrupt` | 通用提示查看详情，不朗读错误原文、密钥或路径 |
| `result` | `run.finished` | `interrupt` | 默认确定性结束提示；用户显式开启动态内容且摘要通过已知模式筛查后，朗读明确标成“文字摘要”的内容 |

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

`RunNoticeScheduler` 默认进度最少间隔 12 秒，审批/提问/错误/完成绕过该限频并返回 `interruptCurrent: true`；Web 播报控制器会先取消当前 utterance，再播放有效的高优先级通知。Host 出队时从该 Run 的当前 Runtime snapshot 重新构造 pending request ID 集合。审批/提问 ID 不再 pending 时 fail closed 丢弃。错误会淘汰排队中的 polite 进度，但保留尚可能有效的 approval/question；Run result 会清空全队列并成为唯一终态通知。队列有界为 16。只有实际进入队列的 notice 才写入去重集合；rate-limited/queue-full notice 可以重试。Notice ID 与语义去重键各最多保留 512 个；切换 Run 生成新 generation、清空队列和去重集合，旧 generation/Run 或较旧 event sequence 会被拒绝。`clear()` 使当前 generation 失效。Web 侧再按公共 `noticeId` 去重，覆盖 SSE 重放/重连。

### Host 与 Web 的 B1 接入

- Host 装配启用 RunNotice 投影，但固定关闭动态文本。RemoteRunAPI 在 committed RuntimeEvent 被接受后投影，Host 出队时核对当前 approval/question request ID，再写入既有事件回放缓冲和 SSE 序列。关闭 `runNotices` 时没有新的公共事件。
- `useRunFeed` 只接收结构校验通过的最小 notice，按 `noticeId` 留存最近 24 条；SSE 外层 event cursor 去重之外再做 ID 去重。Web 内部保留 SSE cursor，不扩展公共 notice schema：朗读关闭期间持续推进基线，用户打开时只读之后的新通知，不回放此前缓存的历史审批/提问；当前 pending 内容仍由页面 snapshot 展示。
- Preferences 的 `voice.runNoticesEnabled` 默认 `false`；`voice.speechRate` 为 `slow/normal/fast`，分别映射为 `0.85/1/1.15`。版本 1 的旧偏好保留显示/回答设置并迁移成语音关闭的版本 2。
- 用户启用后，BrowserSpeechOutput 逐 notice 创建 utterance；`delivery: interrupt` 会先取消当前语音。controller 用 intent epoch 保证同一轮里更新的 interrupt（特别是终态 result）淘汰尚未开始播报的旧通知；result 是该 Run 的最终通知。切换 Run、卸载页面、用户开始文字输入、审批/问题 ID 清除或更换、以及未来录音界面调用 `notifyVoiceInputStarted()` 都会取消当前输出。审批/问题通知会等 snapshot 的 SSE cursor 追上通知，再于真正调用 `enqueueText()` 前核对 `snapshot.pendingRequest`。
- 设置语速会取消旧速率的活跃输出 session；下一条通知以新速度重新打开 session。pending request ID 在相应 utterance 结束/失败后释放，后续 unrelated 通知不会再受它影响。Browser session 会把播放和 finish 失败传回 Web 可见降级文案。StrictMode 下重复 effect 通过 per-Run cursor/notice 去重；短暂 cleanup probe 不会误取消存活输出，真实卸载后取消。
- 不支持 `speechSynthesis` 时，设置页明确显示并禁用开关；播放抛错时运行任务不受影响，页面显示错误，通知仍在文字时间线。

动态内容默认关闭。已知词/模式（口令、验证码、电话、证件号、银行卡/长数字、邮箱及敏感 URL 参数）命中时，即使动态内容已启用，projector 也只生成固定安全文案。该启发式不具备语义隐私识别能力，不是保密保证；不能以“未命中”证明任意动态文本安全。下一阶段需提供明确开关，默认只播固定状态，并通过真机/真实任务确认锁屏等场景不会泄露。

## 本阶段验证

本阶段 B1 已执行定向离线验证：app-runtime public notice 投影/关闭基线/pending request/终态/SSE replay；Web notice ID 去重；Browser TTS 关闭默认、可打断、pending 失效取消、语音失败降级；偏好迁移。完整测试数和构建/typecheck/diff-check 结果在本轮交付汇报中记录。本阶段没有真实 STT/TTS Provider、手机真机、锁屏/后台播放或语音延迟实验；浏览器 API 用可控测试替身验证。

## 下一阶段接点与未实现项

1. 实现 `VoiceInputAdapter` 与 Web 录音控制，显示 partial/final、等待整段 session terminal、允许编辑后通过现有 Goal/Correction/Question 命令提交；取消、权限拒绝和网络失败要可见。
2. 选择第一个真实 STT/TTS Provider；密钥留在 Host/服务端。浏览器语音只证明输出合同与本地播放入口，不能替代真实服务评估。
3. Android/iOS 真机验证 TTS 起播延迟、后台/锁屏行为、焦点、取消时延、重复播报和失败降级；未验证前不声称移动语音链路已交付。
4. 录音到 partial/final、首个可听片段、完整播报与 cancel 生效的延迟；记录转写修订/漏句、误播敏感内容、重复进度和抢占成功率。

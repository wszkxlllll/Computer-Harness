# 语音合同与运行通知阶段 A

日期：2026-09-29
文档角色：结果 / 实施记录
状态：当前实现；Host/Web 接入待实施
当前入口：[产品开发、验证与稳定 Demo 清单](./product-next-stage-task-list-2026-09-27.md) 第 4 节、第 11.4 节
基线：`codex/voice-streaming-notices-20260928` 分支
范围：provider-neutral 语音合同、转写段落合并、RuntimeEvent 到 RunNotice 的纯投影和通知调度；不包含付费服务、录音 UI、Host/Web 传输或手机真机播放。

## 当前结论

新增 `@computer-harness/voice` 包，依赖仅为 `@computer-harness/protocol`。Runtime、Guard、RemoteRunAPI 与现有 RuntimeEvent 没有语音字段，也不依赖该包。后续 Host 可订阅已提交的 Run 事件，把投影后的 RunNotice 传到 Web；Web/Host 再分别装配录音、转写、合成和播放实现。

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
                 └─ Host 后续把取出的 Notice 交给 Web/TTS
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

未来 Host/Web 输出适配器实现 `VoiceOutputAdapter.openSession()`，逐步提交 `VoiceTextChunk`，并在用户停止、审批/问题/错误/完成需要抢占、Run 切换或连接失败时调用 `cancel(reason)`。自然完成时调用 `finish()` 排空已接收文本。Provider 可在 `enqueueText()` 后开始流式合成与播放，不需等整段回复生成。

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
| `text` | TTS 消费的唯一文案；经长度限制和控制字符清理 |
| `dedupeKey` | 同一阶段/结果语义重复时去重；只保留当前 Run 的有限集合，Run 切换/clear 即释放 |
| `pendingRequestId` | approval/question notice 取自权威请求事件；scheduler 出队时要求 Host 提供当前仍 pending 的 request ID 集合，否则丢弃该 notice |

`RunNoticeScheduler` 默认进度最少间隔 12 秒，审批/提问/错误/完成绕过该限频并返回 `interruptCurrent: true`，由下一阶段的 TTS consumer 取消当前输出后读取高优先级通知。审批/提问需要出队时的当前 pending request ID 快照；默认空快照会 fail closed 丢弃 stale interaction。错误会淘汰排队中的 polite 进度，但保留尚可能有效的 approval/question；Run result 会清空全队列并成为唯一终态通知。队列有界为 16。只有实际进入队列的 notice 才写入去重集合；rate-limited/queue-full notice 可以重试。Notice ID 与语义去重键各最多保留 512 个；切换 Run 生成新 generation、清空队列和去重集合，旧 generation/Run 或较旧 event sequence 会被拒绝。`clear()` 使当前 generation 失效。

动态内容默认关闭。已知词/模式（口令、验证码、电话、证件号、银行卡/长数字、邮箱及敏感 URL 参数）命中时，即使动态内容已启用，projector 也只生成固定安全文案。该启发式不具备语义隐私识别能力，不是保密保证；不能以“未命中”证明任意动态文本安全。下一阶段需提供明确开关，默认只播固定状态，并通过真机/真实任务确认锁屏等场景不会泄露。

## 本阶段验证

本次只跑本地离线测试和类型检查，不调用真实 STT/TTS、不发模型请求、不录音、不操作桌面。重点测试包括：多段转写与 revision 更新、final 不降级为 partial、starting 阶段快速 finish、assistantText 缺失回退、候选在拒绝/失败/未知动作后不播报而成功 Receipt 后才生成、Planning 多 task 状态、动态内容开关和敏感模式、限频/队列满后重试、终态结果清队列、error 保留有效 pending 交互、approval/question 过期校验与乱序 generation 丢弃。

## 下一阶段接点与未实现项

1. Host 从 `RunHandle.eventFeed` 的 committed event subscription 消费 RuntimeEvent，用 projector 生成 RunNotice，再经已有 RemoteRunAPI/SSE 对应路由显式投影；不要把 RunNotice 字段加入 protocol RuntimeEvent，也不要将 assistantText、Planning 或 Monitor 的原始事件泛化暴露给手机。
2. Web 录音界面实现 `VoiceInputAdapter`，展示 partial transcript、支持结束后等待全部 final 段、可编辑确认后走现有 Goal/Correction/Question 命令；取消、权限拒绝、网络失败必须可见。
3. Host/Web 选择第一种真实 STT/TTS 适配器；密钥不下发手机。TTS consumer 读取 scheduler 队列，遇 interrupt 取消当前输出，并检查 Run generation 后再播放。
4. 保留 `VoiceCapabilities` 旧 facade 兼容层。新 Provider/设备能力通过新合同接入，不要求原先的 `readAloud` / `transcribeOnce` 实现流式行为。
5. 记录录音到 partial、final、首个可听片段、完整播报、cancel 生效的延迟；同时记录转写修订/漏句、误播敏感内容、重复进度和抢占成功率。未完成 Android/iOS 实机验证前不声称语音链路可交付。

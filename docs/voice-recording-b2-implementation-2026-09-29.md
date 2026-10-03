# 手机录音与实时语音识别：阶段 B2 实施记录

日期：2026-09-29
状态：离线实现、mock 回归与真实 Qwen 约 4 秒短音频探针已通过；手机麦克风与 WAN Relay 实测尚未完成。
基线：阶段 A `e98502b`、B1 `74eeb86`。
范围：Web 按键录音、PCM16/16 kHz 音频流、Host 代理识别、partial/final 转写、编辑后交给已有输入接口。

## 用户可见行为

手机配对页面只查询一次语音能力，不自动申请麦克风。Goal、任务纠正和运行中待回答问题都显示“按下说话”。按下后申请麦克风并开始识别；屏幕显示录音时间与逐步转写。录音开始、录音中和停止收尾时，所属表单的编辑、提交、窗口选择等动作都会锁定；停止或取消后恢复。录音达到 Host 广告的最大时长（当前 60 秒）会自动停止采集、发送尾块并完成 finalization；用户也可以提前手动停止。只有完整 final 文本会填入原来的编辑框，用户仍需检查、编辑并手动发送。

取消、权限拒绝、HTTPS 不可用、连接中断和识别超时都有明确提示。取消不会将 partial 内容写入输入框。原有文字输入和提交行为不变。

## 结构与数据流

```text
手机按键
  → Web AudioCaptureAdapter（麦克风 + AudioWorklet）
  → 线性重采样 16 kHz + PCM16 little-endian
  → 100 ms / 3200-byte ordered chunks
  → 自适应有序批上传队列（64 KB 上限；首块立即发，后续最多四块一批）
  → HTTPS Relay 路由白名单 + 已配对 session / CSRF
  → 本机 Host VoiceSessionService（按 deviceId 绑定、有界、临时内存）
  → Qwen Realtime WebSocket Provider（密钥只在 Host）
  → partial text+stash / final transcript / session.finished
  → 可编辑 Goal / Correction / User answer
```

`@computer-harness/voice` 扩展了音频采集、PCM16 chunk、流式识别 Provider 与 Host 会话服务合同，同时保留旧 `VoiceInputAdapter`、`VoiceCapabilities.transcribeOnce` 与 B1 TTS 合同。Runtime、Guard 和 Computer 没有新增语音依赖。

`@computer-harness/voice-provider-qwen` 只处理 Qwen Realtime WebSocket 协议，WebSocket transport 可注入 mock。Provider 暴露自身 `providerId` 和 capabilities；Host 不写死 Qwen 名称/采集能力。Host 负责设备归属、配置、容量和时间限制；Relay 仅放行五个明确 API，不提供任意代理能力。Web 只知道采集和 API 合同，不接触 Qwen 密钥。

## 生命周期与边界

- 每台设备最多一个活动录音；Host session ID 随机生成并绑定配对 `deviceId`。内容上限严格为 60 秒 / 1,920,000 bytes，单 chunk 最多 4,096 bytes、单请求最多 4 块，终态记录最多保留 30 秒。Host 从第一次成功接收音频时开始计时；录音阶段另有固定 10 秒尾批次传输宽限，但字节上限不放宽。录音前权限等待与初始化有 60 秒 idle grace，避免正常麦克风授权超过 20 秒就令会话过期。进入 finalizing 后不再按录音时长/idle sweep 过期；由已有 finish timeout 限制等待 Provider 的时间。活动和保留会话总量均有上限。
- Chunk sequence 从 0 开始且必须连续，最大 1,200 个；相同 sequence、相同摘要的重试幂等确认但不重发给 Provider。Host 在转发任何新块前先验证整批的顺序、冲突和总预算，因此后续冲突不会造成有效前缀被静默执行。Provider 传输失败若发生在批次中途，会以明确失败终止该识别 session，而不是返回批次成功。Host 只保留块摘要以做去重，不保留原始 PCM。
- Qwen 启动配置使用 Host 私有环境变量 `DASHSCOPE_API_KEY`，以及 `DASHSCOPE_WORKSPACE_ID` 或显式 `DASHSCOPE_REALTIME_ASR_ENDPOINT`。显式 endpoint 优先；若 workspace 值过期或不安全，会忽略且不发送对应请求头。未设置 endpoint 时，仅对通过安全 label 校验的 workspace ID 派生北京专属 WSS `/api-ws/v1/realtime` endpoint；未提供安全 workspace 时能力保持 unavailable。Provider 加入 `model=qwen3-asr-flash-realtime`。
- Host 发送 `session.update`：文本输出、`input_audio_format: pcm`、16 kHz、普通话识别、`turn_detection: null`。停止时依序发送 `input_audio_buffer.commit` 和 `session.finish`。
- `conversation.item.input_audio_transcription.text` 将 `text + stash` 作为该 segment 的 partial 快照；`.completed` 使用 `transcript` 更新同一 segment 为 final。段 final 不代表会话结束；最终提交要等 `session.finished`。
- Host/Relay 不将音频或转写写入 Run trajectory、截图或应用日志。转写只在当前 Host 进程的有界内存 session 中存在，并经配对认证返回给对应手机；Host 退出后清除。
- 当前上传使用同源 JSON HTTP。第一个 100 ms 音频块立即请求，以降低首包等待；该请求在途时新块放入有界队列，响应后以最多四块（最大 Base64 体约 22 KiB）成批连续上传。单 in-flight/待发 PCM 队列总量最多 64 KB，超过即停止、取消识别并提示重试。300–400 ms 模拟 RTT 下，队列持续按序排空且未触发背压。单 WebSocket 上传是后续可替换的 transport，不属于本阶段验证结论。
- B2 未发布，因此 `/audio` 只接受 batch envelope `{ chunks, afterEventSequence }`，不保留旧版单块请求形状；Host、Relay 与 Web 必须同版本。
- `GET /api/voice/capabilities` 是一次很轻的本地 Host 配置读取，供已配对页面决定是否启用录音按钮；它**不尝试连接 Qwen，也不证明密钥、workspace endpoint 或公网链路可用**。真实短音频鉴权与协议验证结果见本节探针记录。
- WebAudioWorklet 停止时等待同源 Worklet 的 flush 确认，500 ms 未确认会拒绝停止；控件随后取消 Host session，不调用 finish，不把可能截尾内容填入表单。录音期间表单 submit/相关字段被禁用，程序处理也会再次拒绝提交。

## 验证情况

本阶段执行了以下 mock / 离线检查：

- Qwen Provider：9 项协议测试通过，覆盖 session 配置、providerId/capabilities、授权头、音频 append、partial/final 多 segment 映射、错误脱敏、finish/cancel/timeout、不安全 endpoint 与连接清理失败不覆盖原始超时。
- Host VoiceSessionService：13 项测试通过，覆盖设备归属、单设备单 session、并发容量 reservation、provider-owned capabilities、batch预校验/冲突原子性、幂等重发、60 秒首音频计时与严格字节上限、10 秒尾批次 grace、finalizing 不被年龄 sweep 清理及 finish timeout、finish/cancel（包括 finalizing 中断）、idle grace、空闲/终态清理。
- Host routes：配对 session、CSRF、Relay bridge 身份与音频块校验测试通过。
- Relay allowlist/schema：语音路由与 body 校验测试通过。
- Web：PCM/resampler/upload queue 5 项、麦克风捕获/flush/cancel 6 项、录音控件 8 项测试通过；在 350 ms 模拟 RTT、100 ms 产块下首块立即发送、后续最多 4 块/批、顺序不变且 12 块测试未触发 64 KB 背压。另覆盖 API batch contract、能力关闭时不申请麦克风、partial→final、取消、迟到旧 session 拒绝、flush 超时和 stop/cancel 竞态不 finish、60 秒自动停止，以及三个输入位置在录音/收尾中禁用表单提交。
- 工作区全量回归 `pnpm test`：92 个 Vitest 文件、891 项通过；附加脚本测试 19 项通过、1 项因 Windows 测试环境不支持符号链接而跳过。首次全量运行发现依赖边界测试漏列了 app-runtime 已声明并使用的 `@computer-harness/voice`，已修正规则后全量通过。
- 工作区 `pnpm run typecheck` 与 Web 生产构建 `pnpm --filter @computer-harness/web build` 均通过；构建产物包含同源 `harness-pcm-capture-worklet.js`。
- 测试输出仍有 Fastify `disableRequestLogging` 弃用提示；与本次录音链路无关，不影响测试通过。

**尚未验证：**手机真实麦克风权限与录音链路、iOS/Android AudioWorklet 行为、WAN Relay、长语音质量、真实弱网延迟，以及完整成本/稳定性。主 Agent 已完成一次真实 Qwen 短探针，证据见下节。没有操作真实桌面，也没有将音频写入仓库。

## 真实 Qwen 短探针（主 Agent 已执行）

已新增可复用的离线校验脚本 `../scripts/voice/probe-qwen-asr.mjs`。它只接受最多 10 秒、16 kHz 单声道 PCM16 little-endian WAV 或 raw PCM；每块按 3,200 bytes/100 ms 顺序发给已构建的 Qwen Provider，整个探针最多 20 秒。默认 WSS endpoint 从 `DASHSCOPE_WORKSPACE_ID` 拼北京 workspace host，也可由 `DASHSCOPE_REALTIME_ASR_ENDPOINT` 覆盖。密钥只从进程环境读取，不打印 endpoint/header/env；输出 Provider ID、耗时、partial/final 段数和最终转写。探针使用真实 API，可能产生费用，必须由主 Agent 在获得用户明确授权后执行。

**隐私注意：**最终转写会打印到终端，因此只使用无敏感内容的合成/测试语音；不要将私人录音作为探针输入。脚本不会把转写写入轨迹或文档，但终端输出可能被本地终端历史或录屏保留。

```powershell
pnpm run build
node --env-file=.env scripts/voice/probe-qwen-asr.mjs --input .\path\to\short-16k-mono-pcm16.wav
```

raw PCM 可以用 `.pcm` / `.raw` 扩展名自动识别，或显式追加 `--format raw`。离线检查：`node scripts/voice/probe-qwen-asr.mjs --help` 和 `node --test scripts/voice/probe-qwen-asr.test.mjs`。

| 结果字段 | 已记录结果 |
|---|---|
| 输入 | 本机 SAPI 合成的约 4 秒、16 kHz 单声道 PCM16 WAV；音频未入库 |
| Provider | `qwen3-asr-flash-realtime` |
| 耗时 | 4597 ms |
| Partial / final segments | 1 / 1 |
| 最终转写 | 上海到杭州，明天下午出发。 |
| 退出状态 | 正常退出 |

该结果只证明本次短音频的真实鉴权、Provider 协议和短时转写链路可用；**不证明**手机麦克风、WAN Relay、长语音、实际成本或稳定性已经通过。探针密钥、Authorization header、完整环境变量与本机音频路径不记录在此文档。

## 下一步

1. 在本机 Host 与手机真机上做短录音，验证授权、采集、编辑确认和取消链路。
2. 再测 WAN Relay 下的 RTT、partial/final 到达和漏句/积压情况。
3. 根据真实数据决定是否把手机到 Relay 的音频传输换成单条 WebSocket 流；mock 或短探针结果不能代替手机/WAN 结论。

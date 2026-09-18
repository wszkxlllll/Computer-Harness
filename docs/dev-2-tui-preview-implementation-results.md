# DEV-2 最小 TUI 预览实施记录

状态：既有最小 TUI/事件/会话核心已由 Sol 有限放行；本轮 bounded UX 收口已完成并获 Sol 定点有限放行（独立 18 项通过）。本批从 `fa89f24` 创建 `codex/dev2-tui-preview`，只覆盖最小受控 TUI、提交后事件订阅和同进程应用会话；本 worker 未调用真实 API、桌面或 VM，也不把 Fake 交互当作 CUA 实机通过。

## 本轮 bounded UX 收口（2026-09-18，基于 `9778b5d`）

用户体验回归集中在 TUI 本地呈现，不新增 Provider 重试、Runtime/Protocol 字段或共享诊断内容：

- Readline `key.name` 统一大小写，并在非编辑态对单字符 fallback 做归一化；Shift+I/大小写 I 都进入同一 correction 路径。Run 运行中仍先渲染“正在暂停、等待 in-flight work quiesce”，再等待 Controller `pause()` 完成；没有绕过未决 GUI 动作或把编辑态当成接管完成。
- goal 与 correction 输入在本地 TUI 中显示经 terminal sanitizer 处理后的原文（含中文粘贴），长度仍受 500 字符上限；达到上限会提示，编辑器使用 tail viewport 保证最新已接受字符可见，Escape 取消编辑。输入只通过既有 Controller/ApplicationSession 命令提交，不新增共享报告字段。
- `tui-text.ts` 使用正式声明的 `string-width@7.2.0` 与 `Intl.Segmenter`，对 reply/question/approval 做按 terminal-cell 的 Unicode-safe wrap 与 PageUp/PageDown 分页，按终端 rows 预算保留 footer；事件历史仍 compact/bounded。Run 页面显示 provider waiting、approval/question、model request failure、tool refusal/Computer failure；完成后首页保留最终 `snapshot.summary`。没有终稿时明确显示 `No final reply was reported (outcome)`，取消、Provider transport、Runtime error 与 Computer refusal 不互相冒充；不凭空生成 reply。terminal sanitizer 仍移除控制/双向字符，但保留 emoji 所需的 ZWJ 连接符。
- 运行中的 `I` 会立即进入本地 draft，同时以 origin `RunHandle` 绑定 pause/quiescence；迟到的旧 Run 回调不能 resume 或提交到新 Run。Enter 在 pause barrier 完成前排队且双击只提交/resume 一次；快速多键粘贴只合并 terminal paint，不丢输入，并在 Enter 前 flush 可见 draft。
- 首页明确键盘范围是当前 terminal，不宣称 global hotkey；可见输入会进入 terminal scrollback/录屏，不能当作隐私保证；本轮没有把输入新增到共享 diagnostic/report projection。resize、raw/cursor `finally` 清理、退出/未决 cleanup owner 语义保持原合同。

本轮 fake/PassThrough 回归覆盖 uppercase-I、pause pending 可见提示、pending 中文 Enter barrier、pause reject、Escape/Abort 迟到 pause、中文 goal/correction、tail input、长 question/approval/reply 分页、可见编辑内容、waiting/failure/reply rendering、两 Run reply 覆盖、取消/退出及 raw mode/cursor restore；其中 I 的 origin-handle 跨 Run 保护、双 Enter barrier 和旧回调不 resume 新 Run 是 mock/fake 证据；本 worker 未调用真实 API、桌面、截图或 `.env`。

最终验证：`apps/cli/src/tui.test.ts` focused 15/15；root `pnpm run typecheck` 通过；全量 `pnpm test` 32 files/320 tests 通过；CLI `--help` 通过。Sol 定点复核独立 18 项通过。worker_ci 以固定 TUI build `6D409F5E…F056717` 实测 no-goal Windows winpty PTY 的 rapid/slow × ESC→Q/Ctrl-C 四场景通过，含中文、tail/500、resize/footer、cursor restore、exit 0、无 force-close；这只证明无 goal 首页终端生命周期，不证明完整 model Run、跨 Run 实际 I、通用 focus/AX 或 CUA 业务动作。该结果不把 fake/PassThrough 或窄 PTY 证据扩展为真实用户桌面或 REL-1。

## 本批合同与边界

### D2-EVENT：提交后只读事件 feed

- Runtime 在 `EventWriter.append` 成功且 `reduceRunEvent` 更新 snapshot 后发出只读通知；通知异常只能被隔离记录，不能改变 Run 结果。
- app-runtime 的有界 feed 保存最近的已提交 `RuntimeEvent`，以 `sequence` 去重并只向订阅者发送增量；订阅者落后到缓存窗口之外时收到独立 `resync_required` 状态，不伪造业务事件。
- `resync(afterSequence)` 在捕获当前最高 sequence 后从只读已提交事件读取器补读到该水位，检查连续性并返回明确 `ok` 或 `resync_required`；TUI 只维护有界事件视图，不按定时器复制完整历史。
- 订阅取消、feed 关闭、listener 抛错、补读期间新事件和重复 sequence 均有离线回归；feed 不回写 Runtime snapshot，也不承担第二个调度器。

### D2-SESSION：单活跃 Run 与环境 owner

- `ApplicationSession` 同时只持有一个 active `RunHandle`。finished 后的新目标创建新 RunId、新输出目录和新的 Controller/Computer/审批/Memory Store；旧 Run 只作为历史摘要，不自动导入。
- 同进程 `EnvironmentOwner` 对 CUA 使用本地 physical desktop identity（不使用可改名的 socket），对 OSWorld 使用归一化 bridge 路由建立稳定的保守 identity。active、`outcome_unknown` 或 cleanup 未确认的 Run 保留 owner，拒绝同 identity 新 Run；明确不同 bridge 的环境互不阻塞。
- 该 identity 是 Harness 进程内的判断，不等价于跨进程/VM 锁，也不能证明同一 OSWorld bridge 背后的独立 VM 身份；没有可信 backend identity 时不接受任意调用者标签。跨进程 owner、持久 pending 屏障属于 DEV-6。

### 最小 TUI

- 首页持续接收目标；Run 中展示实际 snapshot、Guard 状态、审批、最近提交事件和 feed 状态。支持中文/多字符粘贴、审批 Y/N、暂停/恢复、Abort、用户纠正、退出、resize、EOF；退出始终恢复 raw mode 和 cursor。
- 纠正提交给 Controller 后才生效：Controller 线性化用户输入，作废待消费 Provider/Tool 决策并触发重观察；编辑态本身不宣称已接管。审批等待中的纠正先撤销旧审批再进入 Inbox，Abort 仍由 Controller 的 abort signal 优先处理。
- 非流式 Provider 只显示请求中/等待状态，不伪造思考或动作；未知/未决 GUI 派发沿用 Runtime 的 `outcome_unknown`，TUI 不自行放行控制。
- 本批不新增 target/focus/generation、Memory scope、Monitor、shell/tools、D2-SESSION 跨进程能力或真实 TUI 输入验证；CUA doctor/窗口/坐标/focus 只消费已有合同和 worker_ci 的受控实证。
- 界面实现遵循已读取的 UI 工程约束：键盘输入与状态呈现分离，首页空态、等待/审批、错误和清理中状态有明确提示；退出路径在 `finally` 中恢复 raw mode/cursor。本批不引入 Web/React UI。

## 生产者、消费者与失效

| 合同 | 生产者 | 消费者 | 失效/清理 | 验收 |
|---|---|---|---|---|
| committed event | Runtime `commitEvent` | app-runtime feed、TUI | append/reduce 未成功则不通知；listener 异常隔离 | T07、事件顺序/重复/补读 |
| active Run | ApplicationSession | CLI/TUI | Run 完成后清理并归档；新 Run 不继承旧句柄 | T09、T11 |
| environment owner | ApplicationSession/EnvironmentOwner | 同进程 Run 创建 | cleanup/unknown 保留 owner；不同 identity 独立 | T13、X02/X03 限制 |
| correction | TUI → Controller Inbox | Runtime 单一调度点 | 旧 Provider/Tool turn 标记 invalidated，已派发动作不回滚 | T01/T02/T12 |

## 预期验证

### 实际文件映射

- `packages/runtime/src/committed-events.ts` 定义只读 `CommittedEventListener`；`run-controller.ts` 在 append/reduce 后通知，并提供 `getEventsAfter`。审批等待中的用户纠正由同一 Inbox 先撤销审批、拒绝旧 ToolCall，再提交 `user.input.received`。
- `packages/app-runtime/src/event-feed.ts` 实现有界缓存、增量订阅、sequence 去重和带水位的 `resync`；`run-factory.ts` 将其接到真实 Controller，`RunHandle.eventFeed` 从 app-runtime 根出口暴露。
- `packages/app-runtime/src/application-session.ts` 与 `environment-owner.ts` 实现单 active Run、独立 Run 目录和进程内环境 lease；`apps/cli/src/tui.ts` 只呈现状态并提交命令，`apps/cli/src/index.ts` 让 `--tui` 在无 `--goal` 时进入首页。
- TUI 产品路径由 committed-event 回调驱动；兼容旧的单 Controller 函数只用 `getEventsAfter` 的 250ms 增量轮询，不复制完整历史。CLI 仍保留原来的风险默认、Provider/Computer 配置、lazy CUA、报告写盘和终端净化。

### 实际离线证据

修复前反例：基线的旧 TUI 只有一次 goal、120ms `getEvents()` 全历史轮询，不能证明 T07/T09/T12。实现过程先保留失败断言再收口：feed 补读首次因合并顺序丢失并发到达的 sequence 3（`expected [3], received []`），TUI 首次报告写盘改动下 Q 键在首页编辑态被当作目标而导致 5s timeout；分别修正为按 sequence 排序合并、首页空输入 Q 退出及完成态先回首页。审批纠正反例在真实 Runtime Controller 路径上验证旧候选 `Computer.execute=0`。实现后使用真实 `RunController`/`createRun` 路径与 Fake Provider/Computer/Writer/terminal 回归：

- `pnpm exec vitest run packages/runtime/src/event-notification-correction.test.ts packages/app-runtime/src/event-feed.test.ts packages/app-runtime/src/application-session.test.ts packages/app-runtime/src/run-factory.test.ts apps/cli/src/tui.test.ts apps/cli/src/config.test.ts`：6 files / 29 tests passed。
- 覆盖 append+reduce 后 listener 抛错、feed 窗口溢出/重复/补读期间新事件/关闭、真实 createRun feed、单活跃 Run/独立目录/不同 bridge、unknown cleanup owner、审批中纠正的 `Computer.execute=0`、中文粘贴、resize、Abort、Q 退出和 raw mode `true → false` 恢复。
- 针对集中复核的五项阻塞已补回归并修复：提交事件只入每订阅者有界异步队列，resync 读水位期间的同一订阅者增量不丢失；CUA owner 使用同进程 local physical desktop identity，换 socket 不能绕过，生产无清除 unknown lease 的接口；运行中按 `I` 先等待 Controller pause/quiescence，提交纠正后才 resume；approve 后在派发前遇到 correction/Abort 均撤销候选且 `execute=0`；退出把 TTY 恢复与不合作的 Run cleanup 解耦，超时保留 pending owner。Windows readline 的 Escape 可能携带 `undefined` 文本，产品和兼容入口均将其视为空字符串，ESC→Q 回归通过。
- `pnpm exec tsc -b packages/runtime packages/app-runtime apps/cli --force` 与最后的 `pnpm run typecheck`：均通过；Node `v24.19.0`，仅当前命令 PATH 前置隔离 Node 目录。
- `pnpm --filter @computer-harness/cli start -- --help`：通过，显示无 goal 的 `--tui` 首页说明；未启动真实 TUI/Provider。
- 最后全量 `pnpm test`：28 files / 282 tests passed；未调用真实 API/桌面/VM。worker_ci 的 `docs/dev-2-tui-preview-validation-results.md` 与 `spikes/cua-driver/dev2-capability-probe.ts`、`spikes/cua-driver/dev2-preview.ts` 未由本 worker 修改或暂存。

### 支持范围与限制

- 本地 fake 证明 Controller/Session/feed/TUI 的顺序和资源边界，不替代 LIVE-2 Fake TUI 以外的 LIVE-3 专用 fixture、CUA doctor/inventory、窗口/坐标/focus 或真实输入；这些由 worker_ci 独立验证。
- 同进程 owner 的 identity 是本地 physical desktop（CUA）或归一化 OSWorld bridge 路由；CUA 换 socket 仍共享 owner。相同 bridge URL 背后的独立 VM 无可信 backend identity 时会被保守视为同一环境；跨进程持久 owner、quiesce、target/focus/generation、未决动作重连属于 DEV-2 后续/DEV-6，未声称完成。
- ApplicationSession 在 `outcome_unknown`、报告/cleanup 未完全确认时保留 owner，当前没有自动恢复/人工解除 API；这是 fail-closed 限制而非全局 deny。不同 route identity 可并行。
- 本批未实现完整 DEV-3 指令语义解析；纠正安全性依赖 Runtime Inbox 的失效屏障，不把编辑态或界面文案当成安全接管证明。Memory/Plan 仍由各自既有 Run scope 管理。事件 listener 契约隔离异步慢 listener，但任意 JavaScript 同步死循环仍会阻塞单线程，不宣称可由本批隔离。
- worker_ci 的实机证据只代表 Windows + CUA 0.22.2 + 专用 fixture 的窄路径，不能外推通用 focus/AX 或完整 TUI Run 已放行；本轮固定 build 的 winpty no-goal home 已验证 rapid/slow 输入、中文/resize/footer、ESC→Q/Ctrl-C、tail/500、cursor restore 和 exit 0。完整 model Run、跨 Run 实际 I、通用 focus 和真实业务动作仍未验证；此前用户真实请求中的 Provider transport failure 与 CUA action refusal 仅作诊断记录，本批未修复其根因，也不推断未确认的根因。

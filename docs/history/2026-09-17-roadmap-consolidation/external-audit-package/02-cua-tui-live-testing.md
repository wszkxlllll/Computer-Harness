# CUA 能力利用与产品 TUI / 实机测试方案

基线：Computer-Harness `39ff27f9`；SDK 锁定 `@trycua/cua-driver@0.22.2`。上游依据固定到 `d114f35fec05ecd37bf529e5587be86852205b64`。

## 1. 先做 Adapter 扩展，不先改 CUA Rust

你不是“底层 CUA 基本没用”：已经使用了显式 daemon 连接、命名 session、桌面截图/屏幕尺寸、指针与键盘操作、错误映射、关闭与失效保护。没有利用的是更丰富的健康/权限诊断、目标窗口身份、结构化 UI 及部分受控投递能力。[S07、S15、S25]

所以第一步应扩展 `computer-cua` 的产品能力，而不是立即 fork CUA 增加功能。只有确认 0.22.2 没有需要的能力，或者最小真实 fixture 证明上游行为有缺陷，才单独开上游修复分支。升级 SDK、替换 daemon、重构 Harness、变更 GUI 动作语义不放进同一个 PR。

保持现有明确 daemon 方案，不因 SDK README 提供 create() 就切回 embedded。SDK 与 daemon 版本、操作系统、CPU 架构、DPI、执行方式一起记录。上游主干 manifest 的版本不能证明你安装版本具备相同能力。

## 2. 能力接入矩阵

| 层级 | 能力 | 当前情况/依据 | 接入位置与价值 | 是否直接给模型 |
|---|---|---|---|---|
| A：先做 | metadata / tool inventory / health / permission / session state | 已有 capability-probe 脚本实际调用 | 抽成 doctor；发现 SDK/daemon 不匹配、权限不足、残留 session | 默认不给，必要时给简短诊断 |
| A：先做 | 目标应用/窗口身份、几何、前台状态 | 产品只使用 primary desktop；上游有窗口/目标相关能力 | 建立 TargetBinding，降低 TUI 切焦点和旧坐标误用 | 展示受控目标描述，不暴露任意系统访问能力 |
| A：先做 | 有界 session/daemon 生命周期 | 已有 close，但不等于全程有界 | deadline、owned PID、generation、失联状态 | 不给模型做 cleanup |
| A：先做 | 截图和坐标合同 | 已有 physical viewport、尺寸拒绝 | 保留基线；增加目标窗口时显式引入映射与 source/presented 空间 | 模型只看一致坐标空间 |
| B：按需 | get_window_state / UIA 等结构化 UI 信息 | 上游 Windows 文档有，具体应用可用性不同 | 可用于目标 label、editable/focus 等辅助条件 | 小规模工具/选定 UI 摘要，不能一次塞满树 |
| B：按需 | pid/window_id/element_index 定向输入 | 上游 Windows 合同支持相关目标语义 | 对验证过的控件减少依赖全局前台焦点 | 由规范化工具表达，不穿透 raw callTool |
| B：按需 | background delivery | 上游有明确支持与精确拒绝矩阵 | 先在专用应用逐项验证；不自动 fallback foreground | 由 Host Policy 约束模式，不让模型偷偷提权 |
| B：体验 | agent cursor / activity observer | 上游 SDK 提供相关集成入口，平台与宿主方式有边界 | 可观测提示或活动计数；不是安全证明 | 通常不需要工具化 |
| C：后置 | Chromium/CDP、网页原生接口 | 会改变纯 GUI 执行方式及评测信息条件 | 独立 feature profile；单独 benchmark | 显式 opt-in |
| C：后置 | 历史预览、录制、跨任务长期状态 | 上游部分为特定平台 preview | 先做隐私、数据生命周期与收益评估 | 默认关闭 |

上述工具/字段以实际 `listToolsJson` 和版本合同为准。能力发现只能说明“声明了该接口”；一次 health 成功不证明背景输入、焦点或语义任务完成。[S14、U01—U04]

## 3. Doctor：复用现有探针，而不是重新探索一遍

当前 `spikes/cua-driver/capability-probe.ts` 已调用 metadata、listToolsJson、typed/generic session queries、health_report、check_permissions，并输出结构化状态。将其中 JSON-safe 编码、库存解析、诊断归一化拆成 Adapter 内可复用的纯函数；spike 继续作为实验入口，不让生产包反向 import spikes。[S14、S15]

建议新增产品 `doctor` 子命令，返回一份有限的 `ComputerDiagnostics`：SDK/daemon version、transport、platform/arch、session generation、capture/pointer/keyboard/targeted-input 的 supported/degraded/unsupported/unknown、权限缺口和诊断码。不要简单 boolean 全为 true，不要把故障提示或“未测试”隐藏成成功。

Doctor 默认只读、不截图、不点击、不加载用户浏览器 profile。可选的截图校准和输入验证必须是独立明确开关。诊断报告默认不包含窗口标题、完整路径、屏幕内容和密钥。

**验收：**版本不匹配、daemon 未启动、权限不足、部分能力 degraded、未知 tool schema、失联、残留 session 都有 fixture；失败明确可解释，不自动换 transport 绕过问题。

## 4. TargetBinding：先解决“动作发给谁”

### 4.1 最小合同

建议扩展 Computer/Observation 的可选目标信息：opaque target handle、session generation、window identity、geometry revision、capture coordinate space。这里的 handle 由 Adapter 管理，不把任意 pid/window_id 作为模型可以随便改的权限字段。

`ObservationFrame` 保留当前截图资产合同。新增窗口捕获或裁剪时，明确：源桌面物理坐标、窗口局部坐标、展示给模型的缩放图坐标，以及正反变换。旧的 Provider imagePreprocessor 已强调“裁剪需要不同空间合同”，不要只改图片大小却沿用旧坐标解释。[S12]

### 4.2 目标变化处理

窗口移动/resize/DPI/切屏 → geometry revision 变化 → 依赖旧几何的候选失效。窗口关闭或 PID/window handle 被复用 → session/target generation 变化 → 不允许旧句柄重用。用户切到 TUI → Host 输入进入人工控制期，不能让 Agent 同时往前台注入键盘。

重新截图不代表可以自动重标记旧 ActionIntent。当前 `basedOn` 与 executionObservationId 的区分保留，用于审计决策来源；重新决策时再生成新的 ActionIntent。

### 4.3 background 不是万能替换

0.22.2 支持矩阵明确记录 Windows Electron/Tauri/WPF 等应用的不同 delivered/refused 结果。例如一些键盘和组合键后台路径会明确返回 background_unavailable。不能把所有输入的 delivery_mode 从 foreground 改为 background 就宣布解决焦点问题。[U03、U04]

对明确的执行前 refusal，可按新策略重新规划是否允许 foreground；不能对 unknown outcome 直接换模式重试。即使上游诊断推荐 foreground，Host 仍拥有最终授权权。不要静默恢复已删除的 auto fallback。

## 5. 权限：两层边界，不是两个互相替代的 Guard

Harness Risk Guard 负责该用户任务中候选动作的语义风险与审批。CUA runtime 的 permission mode / capability manifest 负责底层可调用工具与资源范围；standard 并不等于每个动作都有人审批，上游文档明确其为正常自动化的 promptless 默认模式。bounded 模式需要受审核的 manifest，并在拥有 runtime 的进程启动时选择。[U01]

第一阶段保持 model-facing ToolRegistry 的小工具集合，不把 raw `callTool(name, json)` 暴露给模型。把必要的底层窗口查询/健康能力用于 Adapter 或有限工具封装。模型的 proposed risk/kind 都不能自动扩大 manifest、连接别的 session、读已有登录 profile 或解除用户限制。

`DriverAuthorizationHost`、ActivityObserver 等是特定 SDK/宿主集成能力，不能假设当前 daemon connect 客户端已经拥有相同 callback。要接这些能力，先核对实际 0.22.2 daemon/宿主合同，做单独 adapter probe。

## 6. 产品 TUI：已有调试界面，按现有计划产品化

仓库 `apps/cli --tui` 和两份 2026-09-16 计划都已存在。推荐延续现有 `apps/tui + packages/app-runtime` 方向；Ink/React 是仓库计划中的候选，不需要这次为了换 UI 框架重写执行内核。[S09、S17、S18]

### 6.1 应用边界

`packages/app-runtime` 只负责 resolved config、Provider/Computer/Tool/Store 工厂、run 目录、日志与 controller 组装。`apps/cli` 保持批处理入口；`apps/tui` 负责持续交互、用户命令和呈现。Runtime 不 import React、Ink、readline，不让 UI 再维护一份业务真相。

订阅接口必须在事件真正持久化并投影后发布。UI listener 异常不能使已经成功的状态迁移变成失败，也不能阻塞 GUI 执行。对缓慢消费者使用有界队列/按序列恢复快照；不要每 120ms structuredClone 整个历史。全量 `getEvents()` 可保留给离线诊断，但不作为热刷新 API。

### 6.2 最小界面

显示 Run/Provider/Computer/profile、已执行 primitive 数、模型请求数与耗时、当前阶段、最近工具结果、最新截图路径。审批卡片必须显示候选动作、目标应用/窗口、重要后果、基于哪张 Observation、是否过期；只给一句模型 reason 不够。

Plan 和 Memory 显示为模型声明/工作事实，不冒充真实完成度。自然语言结果标记已结束但未验证；外部 fixture/OSWorld evaluator 单独展示。

现有 Provider 都使用非流式请求时，只显示请求中、耗时和预算，不伪装实时“思考内容”。未来加流式也只能在完整响应解析、校验通过后执行工具，不能执行半段 JSON。

### 6.3 TUI 自身的安全与可用性

进入输入编辑或审批时先请求 quiesce，区分命令已接收与执行已停在安全边界；控制台获得焦点不意味着 Agent 已停止。恢复前校验受控目标并重新 Observation。Abort 保持独立于普通 UI busy 状态，但不得承诺撤回已发出的系统输入。

对模型文本、错误、窗口标题、文件名应用终端控制序列净化，尤其 ESC/CSI/OSC，防止清屏、改标题或伪造审批区域。仅 replace whitespace 不足。测试多字符粘贴、Unicode/中文宽度、换行、窗口缩放、非 TTY、EOF、SIGINT/SIGTERM、渲染异常后的 raw mode/cursor 恢复。

增加 plain/log 模式或低刷新模式，避免依赖持续全屏重绘；这也为未来无障碍/语音入口保留合同。截图首版通过资产路径查看，终端图片协议不是必要前置项。

### 6.4 产品化顺序

先把当前调试 TUI 的 Guard 默认、审批细节、净化和输入边界修好。再抽 app-runtime 和订阅。随后新建 apps/tui：先一个 Run，后同一应用内连续创建多个 Run。不要把“能重放事件看状态”误说成“进程重启后能安全恢复真实桌面执行”；后者另需环境重验证和恢复合同。

## 7. 实机测试分级门槛

| Gate | 环境 | 检查内容 | 不允许发生 |
|---|---|---|---|
| G0 | 无 CUA/无付费 API | 现有 typecheck/test、新反例、事件重放、配置解析 | 使用真实密钥或桌面 |
| G1 | CUA 只读 | doctor、版本、权限、session、尺寸/DPI | click/type；既有浏览器 profile 隐式授权 |
| G2 | Fake + 合成截图 | TUI 展示、纠正、审批、超时、异常渲染 | UI 直接调用 driver |
| G3 | 专用 WinForms/临时应用 | click/type、焦点失败、窗口移动、TUI 往返 | 输入落到非 fixture；unknown 自动重试 |
| G4 | 受控故障注入 | daemon 断开、审批期间变更、取消中的动作、cleanup hang | 假取消、误报成功、无限清理 |
| G5 | 隔离桌面上的真实模型 | 低风险可恢复任务，多次重复 | 自动放行真实支付/发送/删除 |
| G6 | 模拟高风险按钮 | 风险分级、审批拒绝、候选过期 | 使用真实资金/账户或真实破坏性目标 |

已有 adapter/runtime/action probe 和 fixture 应直接复用。它们已经把 accepted_by_driver 与语义成功分开，还包含 daemon 中断时 outcome_unknown 的验证入口。[S15]

每份实机报告固定版本、OS/架构/DPI、目标应用版本、任务开始状态、目标身份、配置、结果和诊断；不把一次通过推广到全 Windows 应用。测试结果用 fixture 自有状态/计数器断言，不只依赖截图肉眼或 receipt。

## 8. 建议的完成标准

CUA 扩展完成的标志不是多出十个工具，而是：能解释当前环境支持什么；能确定一次输入归属于哪个目标；交互期间焦点变化不会悄悄改变动作接收者；不支持时精确拒绝；unknown 仍保守停止；日志可安全分享。TUI 完成的标志是用户能理解、控制、暂停和退出执行，而不是面板多。


## 依据与定位

- [S07：CUA 产品适配器](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/computer-cua/src/cua-driver-computer.ts)
- [S09：当前调试 TUI](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/apps/cli/src/tui.ts)
- [S12：Qwen Adapter](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/provider-qwen/src/index.ts)
- [S14：CUA capability probe](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/spikes/cua-driver/capability-probe.ts)
- [S15：现有 CUA 探针、fixture 与验证入口](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/spikes/cua-driver/README.md)
- [S17：现有产品 TUI / 拆分计划](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/docs/product-tui-and-module-refactor-plan-2026-09-16.md)
- [S18：现有 Risk / 本机 TUI 验证计划](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/docs/risk-guard-real-api-and-local-tui-plan-2026-09-16.md)
- [S25：CUA 锁定依赖](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/computer-cua/package.json)
- [U01：CUA 0.22.2 说明与权限模式](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/README.md)
- [U02：CUA 0.22.2 TypeScript SDK 合同](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/typescript/README.md)
- [U03：CUA 0.22.2 实证动作支持矩阵](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/docs/action-support.md)
- [U04：CUA 0.22.2 Windows 目标与投递语义](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/rust/Skills/cua-driver/WINDOWS.md)

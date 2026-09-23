# Computer Harness

Computer Harness 是一个 **Provider-neutral 的 GUI runtime 开发预览**：它把模型 Provider、屏幕/窗口观察、Computer Tool、风险决策、运行状态和轨迹记录放在同一条可测试的运行链中。

当前仓库面向试用和贡献者，不是托管服务，也不是“任意桌面都安全可控”的成品。真实模型、桌面权限、焦点、窗口几何和 OSWorld VM 都必须单独预检；仓库内的 Fake、协议测试和受控 fixture 不能替代这些验证。

## 当前能力

| 能力 | 当前状态 |
| --- | --- |
| Provider | GLM 与 Qwen 适配器，共用 ToolRegistry、Runtime 和轨迹协议 |
| Computer | CUA 0.22.2 连接层、OSWorld loopback Bridge、FakeComputer |
| Runtime | 单 Run Controller、事件提交后 feed、Context、Planning、Run 内 Memory、受限 Batch |
| Risk Guard | 实验性 layered Guard；交互 profile 默认开启，实验 profile 默认关闭 |
| TUI | 无 goal 首页、中文粘贴、暂停/恢复、纠正、审批、Abort、分页回复、退出清理 |
| CUA window opt-in | TUI 可按应用名/标题选择窗口并使用 foreground 预览；当前实验性开放 click/type/keypress/hotkey/scroll/drag/wait，脚本 PID + window ID 入口仍是 background 的 click/wait |
| UIA/Hybrid grounding（实验） | 显式 CUA window target 上可选 `uia-catalog-v1` 或 managed-browser `hybrid-catalog-v1`：观察后投影有界、脱敏、Observation-bound 元素目录，并提供 `click_element`；只有 Hybrid 在同一观察中取得可信 UIA `Document` content rect 时才标注 UIA 元素的 `browserRegion`（content/chrome/unknown），普通 UIA 不猜浏览器区域；默认关闭，OSWorld/desktop 基线不变 |
| Monitor | 可选 off/shadow/guidance；记录动作前后 transition，guidance 可阻断同一观察后的完全相同重复动作，但不替模型重新定位 |
| 诊断 | `--doctor` 无模型、无截图/输入窗口动作且脱敏；会建立并结束临时诊断 session，cleanup 未确认时返回 `unknown` |

## 开发进度（2026-09-20）

当前仓库已形成可运行的 V1 开发基线。Context、Run Memory、Monitor、Planning、受限 Action Batch、Risk Guard、双 Provider、CUA/OSWorld Adapter 和 TUI 均已接入统一 Runtime；TUI 还支持按 Run 选择这些实验功能，本地 Windows 有隔离启动器。

当前基线由 [PR #7](https://github.com/wszkxlllll/Computer-Harness/pull/7) 收敛，合并前后都应以对应 CI 和提交记录为准。当前本地源码证据包括：

- Node 24 下 `pnpm run typecheck` 通过；
- `pnpm test`：最近一次离线证据为 49 个 Vitest 文件、563 项 Vitest 测试通过；另有 20 个 Node TAP 子测试（19 通过、1 个 Windows 符号链接限制跳过）；
- GitHub CI：Ubuntu Node 22/24、Windows Node 22、macOS Node 22 均通过；
- GLM/Qwen 合成 Memory 协议探针均完成 `search → admitted/revalidation → admitted-only terminate`，没有真实桌面动作。

这些证据证明的是工程链路和协议边界，不是完整产品效果。真实本机 Run 仍可能出现模型坐标偏移、重复尝试、前台失配、Provider 延迟或业务结果不完整；坐标映射能保证截图坐标投影到窗口几何，不保证模型点中控件中心。Monitor 只阻断同一观察后的完全相同动作，不能自动修正“相邻但错误”的点击。详见[本机真实体验审计](./docs/local-experience-audit-2026-09-19.md)、[最新出行轨迹审计](./docs/travel-trajectory-review-2026-09-20.md)和[出行票务试点准备](./docs/travel-pilot-preparation-2026-09-20.md)。

下一阶段不是继续无条件增加模块，而是冻结 20 个真实开发场景（简单、中等、困难均包含），用可验证结果、模型轮次、GUI 动作、重复动作、tokens、延迟、人工接管、审批和恢复率驱动 Context、Planning、Memory、Monitor、Guard 与 CUA 体验优化。跨 Run 长期 Memory、Subagent、Sandbox、后台异步任务、语音和更广 Accessibility 能力仍属于后续阶段。

## 出行票务任务样例与队友扩展

仓库当前有一批用于本机人工评测的上海出行票务样例。它们是开发中的候选集，不是已经冻结的排行榜，也不应把“运行结束”直接当作业务成功。完整 goal、人工反馈表、停止边界和指标解释见[20个任务与反馈说明](./docs/travel-task-cards-and-feedback.md)；机器可读的来源、分集和变体见[任务 manifest](./eval/travel/travel-candidate-manifest.v0.json)；预检和技术边界见[出行试点准备](./docs/travel-pilot-preparation-2026-09-20.md)。任务只允许查询、比较和整理行程草稿，禁止购票、占座、下单、支付、退改签和候补。

这20题按每个任务族两个变体组织，覆盖从单入口到跨应用、多约束和澄清：

| 任务 | 入口与关注点 | 难度提示 |
| --- | --- | --- |
| T01–T02 | 12306 单入口查票：时间窗、直达、到达偏好 | 基础约束 |
| T03–T04 | 携程单入口查票：价格、席别、到达/出发时间 | 基础约束 |
| T05–T06 | 携程约束查询：有结果则报告，无结果时区分无票、无解和加载失败 | 回退与澄清 |
| T07–T08 | 12306 日期变更后重新查询 | 状态刷新与事实隔离 |
| T09–T10 | 携程铁路结果切换高德公共交通接驳 | 跨应用组合，难 |
| T11–T12 | 高德路线修改起点后重新查询 | 参数修改与重新观察 |
| T13–T14 | 12306 与携程核对同一车次/区间/席别 | 多来源证据 |
| T15–T16 | 铁路方案、换乘/接驳和过夜约束 | 长链路与不可行条件 |
| T17–T18 | 可能冲突的偏好需要澄清 | 冲突处理 |
| T19–T20 | 不能由当前页面保证的有座/最低价要求 | 事实边界 |

默认出发城市是上海，但队友设计其他领域时应替换成自己的真实入口和情境，不要复制出行字段。任务手册第5节提供同构任务模板：每题写完整 goal、入口与初态、允许/禁止副作用、可观察验收、人工反馈、开发/留出 split 和隐私清理；新领域使用 `docs/<domain>-task-cards.md` 与 `eval/<domain>/<domain>-manifest.json`，再把入口补到 README 和 `docs/DOCS-INDEX.md`。报告、轨迹、截图和账号信息只留在本地 `runs/<domain>/`，不提交仓库。

任务设计至少应有单入口基础题、带状态修改的中等题，以及跨应用/冲突/澄清的困难题；每个任务族提供两个只改变参数的变体。反馈要把“完成、部分完成、环境阻塞、无法判断”分开，并记录来源、约束是否保持、旧状态是否误用、不必要步骤、延迟、人工接管和安全事件。程序指标用于定位机制问题，人工表用于判断业务结果，不能用模型最终文字自动替代人工核验。

出行任务的通用脚本入口（先准备本机 CUA、登录状态和窗口，不自动登录、不自动评分）是：

```powershell
.\scripts\travel\run.ps1 list
.\scripts\travel\run.ps1 tui -Preset research -Model glm-5.3-flash
.\scripts\travel\run.ps1 show -Task T01 -AnchorDate YYYY-MM-DD
.\scripts\travel\run.ps1 prepare -Task T01 -AnchorDate YYYY-MM-DD -Preset research
```

TUI 中如果正在编辑 goal，先按 `Esc` 回到首页；再用 `W` 选择窗口、`F` 选择下一 Run 的功能，`I` 输入目标或纠正，`P/R` 暂停/恢复，`A` 或 `Ctrl-C` 中止，`Y/N` 处理审批。每个 Run 独立落盘到 `runs/travel/tui-*/run-*`；完整 goal 仍从任务卡复制，README 摘要表不作为执行输入。

## 快速开始

要求：Node.js `>=22.13.0`、pnpm `11.19.0`。开发、测试和文档工作不需要 API key、桌面权限或 CUA daemon。

本 README 描述的是开发预览分支的能力。若默认分支尚未包含对应提交，请先 checkout 提供该功能的开发分支或待审 PR；不要把未发布功能当作远端 main 的稳定接口。

```text
git clone https://github.com/wszkxlllll/Computer-Harness.git
cd Computer-Harness
# 选择包含本 README 对应提交的开发分支/PR 后再继续
corepack enable
corepack install --global pnpm@11.19.0
pnpm install --frozen-lockfile

# 根 workspace 构建/类型检查，而不是只构建 CLI
pnpm run build
pnpm test

# 构建后查看真实 CLI 入口；--help 不读取 .env，不调用 Provider
node apps/cli/dist/index.js --help
```

更完整的安装、PowerShell、CUA daemon、OSWorld 和故障排查见[开发者上手指南](./docs/getting-started.md)。

### Windows 一键本地启动

本机运行不需要配置系统级 Node、CUA 或 API Key 环境变量。把机器路径写入被 Git 忽略的 `.harness.local.psd1`，密钥保留在 `.env`，然后在仓库根目录执行：

```powershell
.\scripts\harness.ps1 start
```

首次使用时，先把 `.harness.local.example.psd1` 复制为 `.harness.local.psd1`，填写 Node、env 文件、CUA daemon、socket、Model 和输出目录；API key 只放在 env 文件。之后不必为每个 Run 重输这些机器设置，`start` 会读取本地配置，必要时启动 daemon 并进入 TUI，退出时清理本次启动的 daemon。这是 PowerShell 启动的终端界面，不是免命令行的桌面 App。详细配置和预设见[本地启动器说明](./docs/local-launcher.md)。

可选地，配置完成后可显式运行 `./scripts/install-harness-shortcut.ps1 -Destination StartMenu`（也支持 `Desktop` 或 `Both`），创建一个打开本仓库 `harness.ps1 start` 的 PowerShell 终端快捷方式。安装器不会自动运行、不覆盖同名快捷方式，也不把 `.env`、本地配置或密钥写入快捷方式；点击后仍是终端 TUI，不是原生 GUI，首次使用仍须按上文准备机器配置。`-WhatIf` 可预览目标；脚本参数允许把菜单/桌面目录注入临时 fixture 以离线验证。

首页会并列显示模型、Computer/窗口目标、功能预设和 Risk Guard 状态。先输入目标并按 `Enter` 开始；`F` 查看高级功能。若要先选窗口，按 `Esc` 离开目标编辑（草稿保留在当前 TUI），再按 `W` 选择，最后按 `I` 继续编辑目标。

窄终端首页会优先保留目标、Guard、状态和下一步；按 `D` 或 `PageDown` 打开可翻页的完整详情，`PageUp`/`PageDown` 翻页，`Esc` 或 `Q` 返回首页。详情页始终用文字显示 Guard 与会话状态；长错误通知不会覆盖 `BLOCKED`，两者都可在详情中读完。返回首页后可用 `I`/`Enter` 继续编辑保留的目标草稿。

调试或受控 fixture 需要显式绑定窗口时，可使用已由 CUA 能力探针取得的 PID 与 window ID：

```powershell
.\scripts\harness.ps1 start -CuaWindowPid <pid> -CuaWindowId <window-id>
```

两个参数必须同时提供；未提供时保持 primary desktop。它们是脚本/调试接口，不要求日常用户手填编号。日常 TUI 在输入goal前先按 `Esc` 退出编辑，再按 `W` 打开只读窗口列表，用应用名/标题选择；选择保留到用户主动修改。菜单选窗使用显式foreground预览，动作可能激活目标，不保证自动切回终端；列表不可用或目标失效不会静默切换desktop。窗口动作能力仍以CUA后端验证为准，详见[当前体验与能力边界](./docs/travel-pilot-preparation-2026-09-20.md#115-无人工输入的窗口重测与放行边界)。

## 运行一个本地任务

普通 Run 必须显式提供 `--goal`、`--model` 和 Computer 连接。下面是当前验证过的 direct Node 入口，可减少 shell/pnpm wrapper 的参数差异；这与 CUA socket 是否可连接是两件事。Provider 请求只会在 Run 真正开始后发生。

```text
node apps/cli/dist/index.js --goal "describe the current screen" --model glm-5.3-flash --computer cua --cua-socket "<private-socket>" --output "runs/live-glm" --env-file ".env"

# Optional UIA grounding experiment; requires a preselected CUA window target.
node apps/cli/dist/index.js --goal "choose the departure-time control" --model glm-5.3-flash --computer cua --cua-socket "<private-socket>" --cua-window-pid <pid> --cua-window-id <window-id> --grounding uia-catalog-v1 --output "runs/live-grounding" --env-file ".env"
```

OSWorld 需要一个已经通过无模型 Gate 2 的 loopback Bridge；VM、快照和 Python 环境不在本仓库中：

```text
node apps/cli/dist/index.js --goal "<instruction returned by reset>" --model glm-5.3-flash --computer osworld --osworld-bridge "http://127.0.0.1:<port>" --output "runs/osworld-glm" --env-file ".env"
```

入口参数以 `node apps/cli/dist/index.js --help` 为准。`--interactive` 是行式审批/用户输入入口；`--tui` 是需要真实 TTY 的持续终端界面，两者都不改变 Controller 的调度责任。

## 默认值与显式开关

| 配置 | 默认/约束 | 说明 |
| --- | --- | --- |
| `--model` | 普通 Run 必填：`glm-5.3-flash` 或 `qwen3.8-flash` | `--doctor` 使用内部占位值，不调用模型 |
| `--computer` | `cua` | CUA 仍必须提供 `--cua-socket`；OSWorld 必须提供 `--osworld-bridge` |
| `--profile` | 非交互为 `experiment`；`--interactive`/`--tui` 为 `live-interactive` | 也接受源码兼容别名 `fixture`/`evaluation`/`live` |
| `--risk-guard` | 非交互/experiment=`off`；`--interactive` 或 `--tui`/live-interactive=`layered` | 交互模式关闭时必须显式 `--confirm-risk-guard-off` |
| `--risk-model` | `off` | 只有 layered Guard 可选择 `same`、GLM 或 Qwen 复核 |
| `--max-steps` / `--max-model-requests` | 各 `100`（可显式调低） | 正整数预算；出行脚本默认也使用 100 |
| `--planning` / `--memory` / `--batching` | `off` / `off` / `off` | `memory=facts` 提供事实工具；`memory=entities` 是 facts 的超集，保留事实工具并额外提供实体工具；Batch 可选 `same-control-input-v1` |
| `--context-mode` | `raw` | 可选 `recent`；历史事件默认上限 `80` |
| Qwen 坐标 | 必须显式 `--qwen-coordinate-mode` | `normalized_1000` 或 `actual_pixels`；默认 thinking=`low`、output=`strict_json` |
| 输出目录 | `runs/live-cli` | CUA screenshot 默认在输出目录下的 `driver-screenshots` |
| Cleanup / Risk timeout | `5000ms` / `30000ms` | 可分别用 `--cleanup-deadline-ms`、`--risk-timeout-ms` 调整 |
| Window target | 关闭 | 必须同时提供 `--cua-window-pid` 和 `--cua-window-id` |
| `--grounding` | `off` | `uia-catalog-v1` 只允许 CUA + 显式 window target；每次 Run 独立，ref 随 Observation/geometry 失效 |

默认组合是 `--planning`/Memory/Batch=`off`、Context=`raw`；非交互 `experiment` profile 的 Guard 默认 `off`，直接使用 `--interactive`/`--tui` 的 `live-interactive` profile 默认 `layered`。本仓库 Windows 启动器的 `research` 预设是联调例外，显式使用 `--risk-guard off --confirm-risk-guard-off`；TUI 的 `F` 页面可为下一次 Run 改回 `layered`。需要改变这些默认值时使用对应开关并记录配置。

## TUI 预览

TUI 需要 `stdin`/`stdout` 都是可交互 TTY。无 `--goal` 时先进入首页的目标编辑；首页显示当前模型、Computer/窗口目标、功能预设和 Risk Guard 状态。输入目标后按 `Enter` 开始，`F` 打开本次 Run 的高级功能设置。CUA 选窗步骤是：按 `Esc` 离开目标编辑、按 `W` 选择 host 窗口（或 primary desktop）、按 `I` 回到保留的目标草稿，再按 `Enter` 开始。直接使用 CLI 时仍需提供 `--model` 和 Computer 连接：

```text
node apps/cli/dist/index.js --tui --model glm-5.3-flash --computer cua --cua-socket "<private-socket>" --output "runs/tui" --env-file ".env"
```

上面的直接 `node` 命令从仓库根目录执行，因此 `.env` 指向根目录文件；如果使用 `pnpm --filter @computer-harness/cli start`，进程工作目录是 `apps/cli`，请改用仓库根目录 `.env` 的绝对路径，或传 `..\..\.env`，避免被解析成 `apps/cli/.env`。

快捷键只作用于当前 TTY，不是全局热键：

| 按键 | 作用 |
| --- | --- |
| `I` | 进入 goal/correction 编辑；Run 正在执行时先请求 pause/quiescence，不能用编辑态绕过未决动作 |
| `Enter` | 目标编辑中开始 Run；首页非编辑状态进入目标编辑；Run 中提交 correction。提交经过 Controller Inbox，旧决策失效；pause barrier 未完成时会排队 |
| `W` | 首页打开只读窗口选择器；编辑目标时先按 `Esc`，草稿会保留。按应用名/标题选择后续 Run 的 host target，或选择 primary desktop |
| `F` | 首页打开高级功能页；目标编辑中按大写 `F` 也可打开且保留草稿。用方向键或 `J/K` 移动，Space 切换布尔项，Left/Right 切换枚举（包括 Risk Guard `off`/`layered`），Enter 保存，Esc 取消 |
| `P` / `R` | 通过 Controller 暂停 / 恢复当前 Run |
| `A` / `Ctrl-C` | Abort 当前 Run；退出时保留未确认 cleanup，不把停止请求冒称底层已停止 |
| `Y` / `N` | waiting approval 时批准 / 拒绝 |
| `PageUp` / `PageDown` | 查看长 reply、question 或 approval 的分页 |
| `Esc` / `Q` | 目标编辑中 `Esc` 暂存草稿并回到设置首页；纠正编辑中 `Esc` 丢弃纠正；功能页/窗口页 `Esc` 取消该页；设置首页的 `Esc`/`Q` 退出并恢复 raw mode 和 cursor |

编辑态中的 `A`、`Q` 是正文，不是快捷键。必须把焦点放在当前终端；TUI 不注册全局热键，也不会把其他应用收到的按键冒称为输入。输入会显示在本地终端，可能留在 terminal scrollback、录屏或终端日志中；共享 diagnostics/report 仍不写入原始输入。真实 no-goal WinPTY 只证明终端生命周期、中文/resize、尾部可见、500 上限和退出清理，不证明完整 model Run、跨 Run 的真实纠正或通用焦点；另有一次 T10 synthetic fixture GLM 闭环，见“当前证据与限制”。

`--interactive` 不启动 TUI：它提供行式用户输入和审批；`P`/`R`/`I` 是 TUI 控制，不适用于行式入口。

功能选择页覆盖下一次 Run 的 Planning、Memory、Memory retrieval、Action batching、Context history、Risk Guard、Progress Monitor 和 Grounding。每次 Run 仍创建新的工具注册表、Context、Memory store、Monitor、Guard 和 grounding 生命周期；Provider、Computer 仍由启动参数和 profile 决定。UIA grounding 只有在已经显式选定 CUA window target 时才能启动；Context 会在当前 observation 附近投影有限的 role/name/bbox/低敏状态，模型可调用 `click_element`，执行后必须重新观察，不能把旧 ref 当作坐标或 backend token。UIA 查询失败保留截图并标记 `unknown/degraded`，不会回退到任意坐标。Guard 选择复用 `off`/`layered` 合同；关闭 Guard 只关闭风险评估、审批和风险模型请求，不关闭工具 schema/参数、Policy/audience、budget、Abort、stale observation、窗口 geometry/coordinate 或未知副作用处理。`Memory=entities` 包含 `facts` 的全部工具，再增加实体创建、列出和失效工具；它不是只保存实体而不保存 facts。Hybrid retrieval 只有在 Memory 不是 `off` 且同时配置了独立 embedding endpoint 和 key 时才可用；TUI 会显示配置状态，未配置时阻止该 Run 启动。

`same-control-input-v1` 是有界 Action Batch，不是任意 open-loop 宏：同一已激活文本控件内只允许 `click→type`、`Ctrl+A→type` 或 `click→Ctrl+A→type` 这类输入序列；不包含 Enter、Tab、提交、导航、scroll、drag、wait 或 state write。Runtime 仍逐动作执行、校验、记事件和 Receipt，并在失败、Abort、失效或观察失败时停止后缀；Plan/Memory 写操作可以与一个 GUI 调用在同一 ModelTurn 中出现，但 Control call 不能混用。关闭 Batch 即回到逐轮基线。

### Memory embedding 配置

Memory 的 `lexical` 检索是本地、无网络的默认路径；只要选择 `--memory facts` 或 `--memory entities`，就可以直接使用。`hybrid` 才会调用 embedding 服务，并且必须显式提供独立的 endpoint 与凭据：

```text
node apps/cli/dist/index.js --goal "<approved-goal>" --model glm-5.3-flash --computer cua --cua-socket "<private-socket>" --memory facts --memory-retrieval hybrid --memory-embedding-endpoint "<embedding-endpoint>" --env-file ".env"
```

`.env` 中使用 `MEMORY_EMBEDDING_API_KEY`，不要复用聊天模型的 key。当前内置适配器是 Qwen `text-embedding-v4` 兼容接口；它只接收经过 scope/status gate 的候选文本，向量仅用于相关性排序，不代表事实已验证，也不改变审批或工具权限。未配置 embedding key 或 endpoint 时，TUI 不会启动 Hybrid Run；非 TUI CLI 会在创建 Run 时拒绝该配置。已经启动后如果 embedding 请求超时或服务不可用，Hybrid 才会按既有逻辑返回受控的 lexical/exact fallback；不会自动切换供应商或无限重试。TUI 的 Memory retrieval 选择不会替你填写 endpoint 或读取并显示密钥。

Qwen 北京兼容接口的 endpoint 形状为 `https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings`；把完整的 `/embeddings` URL 作为 `--memory-embedding-endpoint` 传入。仓库当前默认维度由适配器固定为 `1024`，没有额外的 CLI 维度开关；若更换 embedding 厂商，需要实现新的 `MemoryEmbeddingProvider`，不能只替换聊天模型 endpoint。

## CUA daemon 与桌面边界

workspace 安装的是 TypeScript 客户端和平台 binding；它**不会自动启动 daemon**，也不把官方 daemon 可执行文件打包进本仓库。锁定版本为 `@trycua/cua-driver@0.22.2`，官方固定版本发布页提供 Windows x64/arm64、macOS universal/arm64/x86_64 和 Linux x86_64/arm64 资产、安装脚本及 `checksums.txt`：

- [CUA Driver 0.22.2 官方 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.22.2)
- [官方 daemon 生命周期说明（main 分支可变参考；固定版本以 release 为准）](https://github.com/trycua/cua/blob/main/docs/content/docs/how-to-guides/driver/keep-running.mdx)

下载与启动原则：

1. 只从上面的固定 release 选择当前 OS/架构资产，并用 release 内的 `checksums.txt` 校验；不要把 `latest` 或其他版本 daemon 与本仓库的 0.22.2 client 混用。
2. 本项目 Windows/CUA 0.22.2 窄路径实测的 daemon 入口形态是 `cua-driver serve --socket "<private-socket>"`；其他平台仍按对应 release 的安装/权限说明准备 daemon。release 页用于固定资产和 checksum，不把 main 文档或 release 描述当作本项目所有平台的 flag 证据。
3. Windows 使用登录用户的真实桌面会话；macOS 需要按系统提示处理 Accessibility/Screen Recording；Linux 的 X11/Wayland、窗口管理器和权限范围不同，代码可运行不等于真实桌面能力已验证。
4. 为 daemon 建立私有 socket，再将完全相同的值传给 `--cua-socket`。没有 daemon 时仍可运行 build、tests、fake path 和静态 CLI 检查。

无模型诊断优先使用 direct Node 入口：

```text
node apps/cli/dist/index.js --doctor --computer cua --cua-socket "<private-socket>"
```

`--doctor` 不读取 `--env-file` 或 Provider credentials，不截图、不输入窗口、不调用模型；它会访问 metadata/inventory，并为 session/health/permissions 建立、检查和结束临时诊断 session。cleanup 不能确认时仍报告 `unknown` 并返回非零退出码。它不是无副作用承诺，也不是完整桌面验收；不接受 `--tui`、`--interactive` 或 window target flags。

### 显式 window opt-in

默认 desktop CUA 路径不变。只有在用户明确选择 PID 和 window ID 时才启用 host-only window target：

```text
node apps/cli/dist/index.js --goal "observe the selected window" --model glm-5.3-flash --computer cua --cua-socket "<private-socket>" --cua-window-pid <pid> --cua-window-id <windowId> --output "runs/window-preview" --env-file ".env"
```

TUI 显式选窗使用 foreground 预览，可用能力以当前 CUA 后端门控为准：已接入 click、type、keypress/hotkey、scroll、drag 和 `wait`；显式 background 入口仍只开放 click 与 `wait`。窗口自动发现、通用 focus/AX、silent desktop fallback 和操作系统级隔离都不提供。截图坐标会从 action 所依据的 observation viewport 映射到已验证的窗口几何；窗口移动/resize、关闭或 identity 变化会使旧 observation/action 失效并拒绝执行。模型点偏或点击控件边缘仍需重新观察和重定位，不能把坐标映射当作业务成功保证；前台激活、遮挡和焦点恢复也受驱动与桌面状态影响。preflight 与 driver action 不是原子事务，OSWorld 不接受这些 CUA window flags。详见[出行任务手册](./docs/travel-task-cards-and-feedback.md#0-你现在照这个顺序做)的窗口边界。

### UIA / DOM grounding 状态

UIA/Accessibility 与 DOM 都是默认关闭的可选 Grounding 生产者。UIA 仅用于显式 CUA window target，以 depth 16、最多 256 个安全候选读取 Accessibility；DOM/Hybrid 只用于 Harness 自己启动的 managed Edge profile 和 loopback CDP，profile 可按 Run 选择临时或 Harness-owned 持久模式，不附加个人现有浏览器。Runtime 对 UIA/DOM 候选去重、融合和有界召回，每轮最多向 Context 投影 16 个 hot elements；最近失败区域、用户纠正和低信任 `declaredEffect/assistantText` 只用于召回，不是事实或授权。Provider 仍只从统一 ToolRegistry 获取 `click_element`；截图和普通坐标 `click` 始终保留，Canvas/WebGL/iframe 等边界不伪造 DOM ref。

在 TUI 体验 managed DOM/Hybrid 时，启动命令必须显式提供一个 HTTP(S) 起始 URL，然后在 `F` 页面选择 `dom-catalog-v1` 或 `hybrid-catalog-v1`：

```powershell
.\scripts\travel\run.ps1 tui -Preset research -Model glm-5.3-flash -ManagedBrowserUrl "https://example.com" -Build
```

如需先手动登录并保留 Harness-owned 持久 profile，先执行一次（仅启动 managed host，不创建 Run/Provider）：

```powershell
.\scripts\travel\run.ps1 browser-login -ManagedBrowserUrl "https://example.com" -ManagedBrowserProfileLabel travel
```

同一 label 的第二个站点继续使用相同参数即可登记：

```powershell
.\scripts\travel\run.ps1 browser-login -ManagedBrowserUrl "https://another.example" -ManagedBrowserProfileLabel travel
```

登录完成后在 PowerShell 按 Enter 保存 profile。之后用相同 label 启动 TUI：

```powershell
.\scripts\travel\run.ps1 tui -Preset research -Model glm-5.3-flash -ManagedBrowserUrl "https://example.com" -ManagedBrowserProfileMode persistent -ManagedBrowserProfileLabel travel -Build
```

同一个 label 可以多次执行 `browser-login` 登记不同站点；Harness 只在自己的 profile 元数据中保留最多 8 个去重后的 HTTP(S) origin/path，默认剥离 query 和 fragment，不读取 Edge 历史、cookie 或 storage。之后的 persistent Run 会把本次 `-ManagedBrowserUrl` 作为初始活动页，并在同一个 Harness-owned Edge window 中恢复已登记站点为后台 tabs；如果 profile 还没有登记清单，则只打开本次 URL。新 tab 不会被 DOM transport 混入当前活动 tab，且不能依赖 Edge session restore。

Managed 模式会自动启动可见 Edge、用 CUA 严格解析 Harness-owned browser window，并使用 foreground 交付以开放 type/keypress/hotkey/scroll/drag。profile mode 默认 `ephemeral`（临时 profile，Run 结束清理）；`persistent` 只接受 Harness-owned 的显式 label/profile root，用户需在可见 managed 浏览器中手动登录一次，Harness 不自动登录、不读取或输出 cookie/localStorage/password/input value，也不会静默回退个人 profile。运行时不要与 Agent 并发操作该窗口。DOM 每次观察都会在 Harness-owned browser window 内重新枚举 page targets：同一 tab 的跨站导航继续收集 DOM；同一 browser window 内切换到唯一 `visibilityState=visible` tab 会刷新 Adapter 私有 generation；popup/新 browser window、关闭 tab 或 0/多个可见 tab 一律降级为 UIA/视觉，不会把旧 tab 的 DOM 错配给新活动窗口。当前真实 fixture 只读 pilot 已验证 custom div/button/input/open shadow 可发现，但高德“换乘少”真实 DOM 命中与动作仍待下一轮人工观察验证。详见 [DOM Grounding 基础实施与门禁](./docs/dev-2-dom-grounding-foundation-2026-09-21.md)。

## Provider 与环境变量

`.env` 只放在本地，不提交。Provider key、endpoint 和兼容 aliases 的完整表见[开发者上手指南](./docs/getting-started.md)；不需要 API key 的路径包括 `pnpm test`、`pnpm run build`、`--help`、`--doctor` 和 Fake/协议回归。截图会随选定的 GLM/Qwen 请求发送；`runs/` 不公开上传不等于没有网络传输。

## OSWorld

OSWorld 是独立的 Python/VM 实验环境，不由 TypeScript workspace 安装或启动。先阅读：

- [OSWorld upstream](https://github.com/xlang-ai/OSWorld)
- [仓库 Bridge 说明](./integrations/osworld/README.md)
- [Stage 5 可复现说明](./docs/stage-5-osworld-reproducibility.md)

必须先准备固定 OSWorld checkout、Python 环境、VMX 和已验证快照，再通过无模型 Gate 2；不要把 `.vmx`、VM 磁盘、快照名称或 Windows 本机路径当作仓库依赖。

## 架构与目录

```text
apps/cli / SDK callers
          │
          ▼
packages/app-runtime  ── assembly / RunHandle / ApplicationSession / reports
          │
          ▼
packages/runtime      ── Controller / ToolRegistry / Guard / action routing
          │
          ├── Provider abstraction ── provider-glm / provider-qwen
          ├── Computer abstraction ── computer-cua / computer-osworld
          ├── context / memory / planning
          └── trajectory          ── events / assets / snapshot
```

CLI/SDK 负责组装和注入依赖，Provider 不反向依赖 CLI；贡献时优先保持公共 protocol、Runtime、app-runtime 和 adapter 边界清楚。不要为未消费的未来能力添加字段或入口，生产代码不应跨包导入另一个包的私有 `src` 路径。

## 当前证据与限制

- 离线基线：Node 24 下最近一次 `pnpm test` 为 49 个 Vitest 文件、563 项 Vitest 测试通过，另有 20 个 Node TAP 子测试（19 通过、1 个 Windows 符号链接限制跳过）；`pnpm run typecheck` 通过。测试不代表真实模型效果。
- CI 矩阵：Ubuntu Node 22/24、Windows Node 22、macOS Node 22 已通过；CI 通过只证明构建和协议测试跨平台可运行，不等于真实 Mac/Linux 桌面已验收。
- 真实 API 窄证据：GLM/Qwen 各完成两轮合成 Memory 协议消费，无 GUI action；这不证明语义检索质量、长任务质量或真实用户数据安全。
- 本机真实体验：已观察到模型坐标偏差、重复尝试、前台失配和高 Context/token 成本；这说明产品体验仍需优化，不能把 `runtimeOutcome=succeeded` 当作任务成功。
- `--doctor` 是无模型、无截图/输入窗口动作的诊断，但会建立/结束临时 session，仍可能 cleanup `unknown`；不能把 metadata/inventory 支持误读成 session、权限或 cleanup 全部通过。
- UIA 只读 probe、UIA Grounding 和 managed DOM/Hybrid fixture pilot 分别见[UIA 能力探针记录](./docs/dev-2-uia-readonly-probe-results-2026-09-20.md)、[UIA Grounding 实施结果](./docs/dev-2-uia-grounding-implementation-results-2026-09-21.md)和[DOM Grounding 基础实施与门禁](./docs/dev-2-dom-grounding-foundation-2026-09-21.md)；真实 fixture 通过不代表高德/携程业务操作已通过。
- Provider transport failure、CUA refusal、真实焦点、登录/OTP 审批和 OSWorld 业务结果需按独立验证记录解释；本 README 不把它们包装成已解决或成熟安全保证。

## 继续阅读与贡献

- [开发者上手指南](./docs/getting-started.md)：安装、平台排查、daemon/OSWorld 准备。
- [CUA 探针说明](./spikes/cua-driver/README.md)：只读探针、显式输入探针和隐私边界。
- [文档唯一入口](./docs/DOCS-INDEX.md)：当前阶段、验证边界和历史证据索引。
- [完整开发路线 V2](./docs/full-development-roadmap-v2.md)
- [验收清单 V2](./docs/development-acceptance-v2.md)

提交改动前至少运行：

```text
pnpm run build
pnpm test
```

默认贡献流程不调用真实 API、桌面或 VM；若要扩展这些路径，请单独记录平台、daemon/VM、权限、预算、隐私和 cleanup 证据，不要用 Fake 或截图替代真实边界。

# DEV-2 TUI / CUA 受控预览验证记录

日期：2026-09-18（含 2026-09-17 历史记录）
文档角色：独立验证记录
状态：Windows 专用 fixture 与 winpty PTY home（中文粘贴、resize、ESC→q、Ctrl-C）通过；真实 GLM 因整屏隐私闸门发现系统通知而未执行；完整 TUI Run、独立 ConPTY、跨平台与模型 API 仍未验证
范围：Windows CUA 能力盘点、现有 probe 入口、受控 fixture 与真实 PTY home 验证

## 1. 当前结论

在本轮 preflight 开始时，工作树没有可直接启动的 `cua-driver.exe`、CUA daemon 进程或相关 named pipe；pnpm store 中只有锁定的 Node SDK/native package。随后按授权下载并校验官方 daemon、启动私有 pipe 并完成一次 Windows fixture 窄链路；这仍不能外推为通用窗口发现、DPI、焦点、完整 TUI Run 或跨平台能力通过。

Windows host 为 x64；preflight 计划要求使用外部提供且版本来源明确的官方 `@trycua/cua-driver@0.22.2` 对应 daemon binary，配合专用 pipe 和只由本 probe 编译/启动的 `ProbeWindow.cs` fixture。该计划已在本轮按授权执行；后续批次仍不得复用本 daemon/fixture 或在未获具体 target 许可前启动、截图、输入。

## 2. 只读 preflight 实际证据

本次盘点命令使用 Node `24.19.0` / pnpm `11.19.0`（默认 shell 的 Node `18.19.0` 仅用于一次最初的只读版本显示，不作为能力证据）：

- Windows build `10.0.26200.0`，OS/process architecture 均为 x64。
- 未显式设置 DPI awareness 的 PowerShell/WinForms 进程读数为 1 个 primary display、screen bounds `1707x1067`、working area `1707x1019`、system DPI `96` / `100%`；该读数标为 `process-reported / DPI-awareness-pending`，不是物理尺寸或 CUA capture/frame 证据。
- 随后使用 Win32 `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)` 的独立只读进程核验成功（return `True`, last error `0`）：system DPI `144`，primary metrics `2560x1600`。这只设置该探测进程的 awareness，没有修改系统 DPI、窗口或桌面状态；CUA capture/frame 仍需专用 daemon 实验核对。
- `@trycua/cua-driver` package version `0.22.2` 已安装；lockfile 与 `packages/computer-cua`、`spikes/cua-driver` 均锁定 `0.22.2`。
- Windows optional native package 已安装，文件仅为 `cua_driver_node_runtime.node`、`cua_driver_sdk.dll`、NOTICE 与 package metadata；没有 standalone daemon executable。
- `cua-driver` / `cua-driver.exe` 命令未找到；精确名称过滤的 daemon/fixture 进程未找到；CUA/computer-harness/probe named pipe 未找到。
- preflight 时 workspace 中只找到 `spikes/cua-driver/fixture/ProbeWindow.cs` 源文件，没有已编译 fixture executable；Section 5 的受控实验随后只在 ignored output 编译了本轮专用 fixture。
- 已明确目录中存在可复用的历史 fixture executable：原工作树 `runs/stage3-runtime-contract-r1` 有 1 个、`spikes/cua-driver/runs/stage3-actions-daemon-r7..r15` 有 9 个，均为 `computer-harness-fixture.exe`、PE file version `0.0.0.0`、大小 `5120` 或 `9728` bytes；它们没有随 binary 保存可验证的 source/release provenance，暂不把它们当成通过证据，也不读取旁边的截图、trajectory 或 state 正文。已授权的外部 tools 目录只匹配到 Rust `clippy-driver.exe`，不是 CUA daemon；未找到 CUA release/manifest/hash 资产。
- 原工作树 `.env` 仅按 key 名存在性检查：`ZHIPU_API_KEY`、`DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID` 存在；`ZHIPUAI_API_KEY`、`GLM_API_KEY`、相关 endpoint、`CUA_DRIVER_BINARY`、`CUA_DRIVER_SOCKET` 不存在。未读取或输出任何值，也未复制到本仓库。

上述盘点没有启动 CUA/daemon/fixture，没有读取用户窗口标题或敏感路径，没有截图、输入、真实模型 API、VM 操作或用户进程清理。

## 3. 已确认的 probe 入口与副作用边界

入口均来自 `spikes/cua-driver/package.json` 与 README：

- `probe:capabilities`：metadata、tool inventory、session、health、permission 的只读合同探针；仍需要 SDK embedded 或显式 daemon socket，结果写到 ignored output。
- `probe:actions:daemon`：需要显式 binary/socket；会编译并启动隔离 WinForms fixture，执行 click/type/key/scroll/drag 矩阵，截图与 raw JSON 只写 ignored `runs/`，只清理由本 probe 启动的 fixture。
- `probe:adapter`：需要显式 binary/socket/fixture；执行 Adapter observe、fixture foreground、click/type/drag、observe、close；不使用 Notepad 或用户文件。
- `probe:runtime`：需要显式 binary/socket/fixture；20 轮 observation-bound click 与 daemon disconnect lifecycle，验证 unknown/no replay；不应在没有专用 fixture 和主协调许可时运行。

对应源文件已只读检查：`capability-probe.ts` 会启动/结束 embedded session 或连接显式 daemon并写报告；`adapter-contract-probe.ts` 会 launch/foreground/操作/清理 fixture；`ProbeWindow.cs` 状态文件包含 fixture 自有文本和事件，不能复制到模型上下文或普通报告。

## 4. 下一道实验闸门（preflight 计划，已由第 5 节执行）

1. 主协调提供外部官方 binary 的已验证路径、专用 pipe 名、ignored output 目录和目标能力；本轮不升级 lockfile。
2. 只编译并启动 `ProbeWindow.cs` disposable fixture，确认 PID/窗口来自本 probe；先执行 capability inventory，记录 metadata、tools、session、health、permissions 的安全摘要。
3. 通过主协调明确许可后，才做一次 fixture-only observe → click/type → observe；记录 viewport、DPI/显示尺寸、capture size、session lifecycle、action receipt、fixture-owned state change，并把截图/raw logs 留在 ignored `runs/`，不提交。
4. 若要验证 TUI PTY，单独记录真实 PTY/交互终端事实；fake input 或普通 CLI help 不能冒充真人 TUI 验收。以上 1–3 已在本轮执行；第 4 的 no-goal home 已在第 8、9 节以 pywinpty/winpty 实测，完整 TUI Run 仍待另行许可。

在 daemon binary、permission、window identity、focus readback 或 fixture state 任一环节无法证明时，结果标为 `unknown`/`unsupported`，不把 driver accepted、截图变化或 action completed 解释为业务成功。lazy CUA、Linux platform adaptation、真实模型 API 与产品化 DEV-2 owner/target/TUI 仍不在本只读 preflight 的通过范围内。

## 5. Windows 专用 fixture 受控实验（本轮实际证据）

主协调已明确授权本轮只做 synthetic fixture 的截图、一次 click、一次固定文本输入，不调用模型 API。实验使用官方 `cua-driver-rs-v0.22.2` release asset：zip `27,637,983` bytes，SHA-256 `1E264492F7F4D69D5B7920C445DD637BEF90E45A21A3A90DE4FBE63FEE0CB388`；官方地址为 `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.22.2/cua-driver-rs-0.22.2-windows-x86_64-binary.zip`。zip 预检共 6 个条目、无绝对路径或 `..` 穿越；未运行 install 脚本，只提取 daemon 及其随包依赖到 ignored `runs/dev2-tui-preview-validation/tools/`。`cua-driver.exe --version` 与 `--help` 均退出码 0，报告版本 `0.22.2`。

现有 `capability-probe.ts` 经过 pnpm 转发时未归一化 Windows named pipe，曾对所有 SDK 操作返回 `DriverError.Transport`；未把该失败当成 daemon 能力结论，也未修改既有 probe。新增本轮专用 `spikes/cua-driver/dev2-capability-probe.ts` 只做相同 capability/session/health/permission 只读调用并显式归一化 pipe，结果如下：inventory shape `object.tools`、`57` tools；metadata、listTools、start/get session、list sessions、host sessions、health、permission 均返回，errors `0`。去正文安全摘要保存在 ignored `runs/dev2-tui-preview-validation/capabilities/capability-report.json`。

fixture 使用仓库 `spikes/cua-driver/fixture/ProbeWindow.cs`，以 Windows Framework `csc.exe` 编译，编译退出码 `0`；生成的 `ProbeWindow-dev2.exe` 为 `9,728` bytes、SHA-256 `DE87218F0EB6B0FE5040E0F665B173A419B3E2549B91942944BE81700FD90785`，只复制到 ignored fixture 目录，未执行历史来源不明的 fixture binary。daemon 以 Hidden/private pipe 启动，fixture 由本 probe 启动并在 finally 清理；实验后 daemon stop 退出码 `0`，daemon/fixture 自有进程数均为 `0`。

本次实际链路为 `CuaDriverComputer.open` → exact launched fixture PID/`window_id` inventory → fixture `bring_to_front` 与 state `focused=true` → `observe` → 一次 click → 再次 exact PID/`window_id`/focus 核验 → `observe` → 一次 type → `observe`。结果：

- Adapter backend：`cua-driver-daemon`；opened viewport `2560×1600/physical`。
- Adapter capabilities：`screenshot=true`、`pointer=true`、`keyboard=true`、`accessibility=false`。
- 三张本地 screenshot（before/after-click/after-type）均为 `2560×1600`，四角像素读取均成功并与 opened physical viewport 匹配；PNG 只留在 ignored `runs/dev2-tui-preview-validation/preview-1/screenshots/`，未上传或写入普通报告。
- click 与 type receipt 均为 `completed`，但报告同时要求 fixture-owned state 证明：fixture state 的 text length 从 `6` 变为 `31`，固定输入长度 `25`，`typedByFixture=true`，`focusConfirmed=true`。
- 输入字符串仅为本轮授权的 synthetic `LightSpeaker harness test`；未操作私人窗口、用户文件、剪贴板、真实任务或模型。

这只证明当前 Windows host、0.22.2 daemon、当前 WinForms fixture 与全桌面 foreground adapter 的窄链路。`accessibility=false`，没有通用 AX/window focus producer；fixture 自有 focus state 与 `bring_to_front` 不是跨应用焦点保证。它不证明任意窗口 target、DPI 变更、PID reuse、Wayland/macOS、完整 TUI Run 或业务目标成功；driver receipt 仍不等于业务成功。no-goal TUI home 的 winpty PTY 结果见第 9 节，完整 TUI Run 仍未执行。

## 6. 下一步闸门

保留本轮 binary zip、提取文件、fixture、PNG 和去正文 JSON 摘要于 ignored `runs/dev2-tui-preview-validation/`，不纳入 Git。no-goal 的真实 winpty PTY home 结果见第 8、9 节；若继续完整 TUI Run，仍只使用专用真实终端会话记录交互事实。若继续 target/AX，先解决 `accessibility=false` 与平台 profile 的 producer/permission。任何模型 API 实验仍需单独给出模型、最多请求数、synthetic 数据和费用边界；本轮没有 API 证据。

## 7. TUI 与真实模型的两层待验方案

本节是下一阶段的执行门槛，不是已完成的完整 TUI Run 验收证据。当前 `apps/cli/src/tui.test.ts` 使用带 `isTTY`/`setRawMode` 模拟面的 `PassThrough`，已覆盖 home、中文粘贴、修正、resize、退出和 raw-mode 恢复的离线行为；它不是 Windows ConPTY/Windows Terminal/WinPTY，也不能单独证明真实 PTY 的字节流、焦点、粘贴或退出语义。此前未启动 Windows Terminal 或 winpty-agent；本机只读确认存在相应工具，但未把本机安装路径写入通用命令。第 8 节历史记录与第 9 节当前记录使用 pywinpty/winpty 启动了真实 no-goal TUI home，但仍未执行 TUI Run 或模型请求。

### 7.1 真实 PTY 离线闸门

取得主协调的终端实验许可后，先构造真正的 Windows ConPTY/终端会话，目标仍是本 probe 启动的专用 fixture 或不启动 run 的 TUI home；不把普通 pipe、PassThrough 或 CLI `--help` 当作 PTY 证据。建议检查顺序如下：

1. 用本机 Node 24 与仓库当前构建启动 no-goal TUI home；确认 `Enter` 前不启动模型 run，屏幕只显示受控提示。
2. 粘贴固定 synthetic 中文字符串（例如 `仅观察专用 fixture，不点击私人窗口`），验证换行被规范化、界面只显示长度掩码，终端转义序列不进入画面文本。
3. 在获得后续 run 许可后按 `Enter`，用 `I` 进入输入/修正，再粘贴同类固定中文内容；用 fixture-owned state 或 controller event 证明收到的内容，不把屏幕截图或键盘 receipt 当业务成功。
4. 用 `Q`/Escape（必要时 Ctrl-C）退出；确认 `setRawMode(false)`、光标恢复、session/owner/feed 关闭，且只清理本 probe 产生的进程和输出。

下一次真实终端会话可从以下命令开始。命令仅为待授权模板，`<PRIVATE_PIPE>`、`<RUN_ID>` 必须由该次隔离实验生成；本轮没有执行，也没有提交或上传任何运行资产：

```powershell
$repo = '<repo>'
$env:PATH = '<node24-bin>;' + $env:PATH
$pipe = '<PRIVATE_PIPE>'
$out = Join-Path $repo 'runs\dev2-tui-pty-<RUN_ID>'
pnpm --dir $repo --filter @computer-harness/cli start -- --tui --model glm-5.3-flash --computer cua --cua-socket $pipe --profile live-interactive --risk-guard layered --risk-model off --max-steps 4 --max-model-requests 6 --output $out --env-file '<envfile>'
```

该命令会在真正按回车开始 run 后进入 provider/daemon 路径；`<envfile>` 只允许由该进程读取，绝不读取、输出、复制或写入报告。若只验证 home，可在回车前手动退出，不产生模型请求；仍应把这次结果标为真实 PTY home 证据，而非完整 run 证据。daemon 的本机绝对安装/提取位置只在执行者交接中使用（当前 ignored 目录为 `runs/dev2-tui-preview-validation/tools/`），README 与通用文档不固化本机路径。
该命令是 no-goal TUI home 示例，故命令行不得添加 `--goal`；第二个终端若单独执行它，必须自行设置与 daemon 完全相同的 `<PRIVATE_PIPE>` 字面值，不依赖第一个终端的 `$pipe` 变量或 shell 会话。只有在新的隐私闸门和单独 API 许可后，才可提交 goal 并进入 provider/daemon 路径；`<envfile>` 只允许由该进程读取，绝不读取、输出、复制或写入报告。若只验证 home，可在回车前手动退出，不产生模型请求；仍应把这次结果标为真实 PTY home 证据，而非完整 run 证据。daemon 的本机绝对安装/提取位置只在执行者交接中使用（当前 ignored 目录为 `runs/dev2-tui-preview-validation/tools/`），README 与通用文档不固化本机路径。

### 7.2 真实 GLM synthetic fixture 闸门

真实模型层必须在 TUI 实现审查和单独许可后进行，最多 `6` 次主 GLM 请求、最多 `4` 个 primitive actions/steps，`--risk-model off`（不额外消耗风险模型请求），`--risk-max-model-requests 1` 仅作为配置上限而不宣称已调用。任务应只描述由本 probe 启动、PMv2、固定 title、PID 明确且覆盖 primary physical viewport 的专用 fixture；若无法证明整幅画面仅含 fixture，则改用合成 fixture 图/协议测试，绝不裁剪包含其他桌面的历史 PNG 来冒充新坐标或上传。建议目标是一次观察后对 fixture 的单次受控 click/type，并以 fixture-owned state、request/step 计数和安全摘要作为结果；模型完成、driver receipt 或画面变化都不能单独证明业务成功。

该层需分别记录：provider 实际请求数与响应数、run/step 上限是否触发、CUA target/focus/PID 校验、fixture state 变化、cleanup/owner 结果，以及费用/API/桌面边界。当前 `.env` 中仅确认存在 `ZHIPU_API_KEY` key 名，值仍是私密凭据；本轮未调用 GLM、未发送屏幕或 fixture 图、未访问私人窗口，故真实模型层仍为 `pending`。若实机 PTY 或整屏 fixture 任何一项不能证明，唯一可接受的替代是合成 fixture 图协议测试，不能把替代结果记为真人 TUI 或真实桌面验收。

## 8. 真实 no-goal winpty PTY home 实测（2026-09-17 历史记录）

主协调授权本次只启动当前已编译 CLI 的 no-goal home，不提交 goal，不启动 Run，不连接 CUA，不读取 `.env`，不调用 provider/API，也不做桌面 click/type。为避免把普通管道误记为 TTY，使用本机已存在的 `pywinpty` 0.4.3 `winpty` backend：`PtyProcess.spawn` 启动 `apps/cli/dist/index.js`，初始尺寸为 24×80，再调用 `setwinsize(30, 100)`。子进程环境移除了 API/bridge token key，且没有 `--env-file`；Node 使用 `<node24>` 24.19.0。
本次运行所用构建快照为 `dist/index.js` SHA-256 `374D5134EBB53820A7F104278159F8C3B57FE492918E6BE17B93ECD36B6E1A9F`、`dist/tui.js` SHA-256 `838A62E25428734B87D04046964E58EEED2393AA8538F07C5D972CB80A3E9CF6`；源码在实验期间未重建，后续源码变化不并入本证据。

实际入口参数（脚本复制到 ASCII 临时路径后执行；尖括号是该次临时目录，不是可提交路径）为：

```powershell
> <python-with-pywinpty> <ASCII-temp-copy-of-spikes/cua-driver/dev2-pty-probe.py> . <node24> <ASCII-temp-output-dir>
```

脚本中的真实 child argv 为：`node.exe apps/cli/dist/index.js --tui --model glm-5.3-flash --computer osworld --osworld-bridge http://127.0.0.1:9 --profile live-interactive --risk-guard layered --risk-model off --max-steps 6 --max-model-requests 6 --risk-max-model-requests 1 --output <ASCII-temp-output-dir>`。没有 goal 时，CLI 只构造 session 并进入 home；该桥接地址未被访问。

本次 Ctrl-C 退出链路实际结果：`probe_exit=0`、child `exit_status=0`、`passed=true`、home marker 存在、`--tui requires an interactive terminal` 不存在；粘贴 8 个中文字符后只出现 `(8 characters hidden)`，原文未出现在 transcript；初始 separator 宽度 `80`，resize 后为 `100` 且无 resize exception；写入 Ctrl-C 成功，`cursor_hide_count=1`、cursor restore 为 `true`，未强制终止。应用没有报 interactive-terminal 错误并成功设置/恢复 raw mode，是本次真实 PTY home 对 `process.stdin.isTTY`/`process.stdout.isTTY` 合同的实证；pywinpty 外层 socket 自身报告的 `isatty=false` 不被当作 child TTY 结论。输出 transcript/metrics 只留在本机 ASCII 临时目录，未进入 Git 或上传。
同一真实 winpty backend 的先行 ESC→q 尝试被单独记为失败证据，不计入上述通过：home、中文掩码和 80→100 resize 均发生，但 child 以 `exit_status=1` 结束，输出 `TypeError: Cannot read properties of undefined (reading 'length')`（当前 dist `tui.js` 的 keypress handler）；cursor restore 未出现。该结果说明当前构建在此 PTY backend 的 ESC 事件形态存在未处理旁路，需核心 TUI 审查；本验证 worker 未修改 app/CLI，也未把 Ctrl-C 通过扩大解释为 ESC/Q 通过。

本节证明范围仅为当前已编译版本、Windows 本机 pywinpty/winpty、no-goal home、一次多字符 UTF-8 输入、一次终端 resize 与 Ctrl-C clean exit。它不证明 Windows Terminal/ConPTY 独立实现、ESC/Q 退出、完整 TUI Run、CUA target、真实桌面、跨平台或 GLM API；后续若要验证这些层，仍需主协调分别授权并沿第 7 节的专用 fixture/费用边界执行。

## 9. 2026-09-18 固定构建 winpty 重跑

主协调在核心 TUI 修复并完成构建后授权再次只做 no-goal home。使用同一 `spikes/cua-driver/dev2-pty-probe.py` 的两个退出模式，实际调用形式为 `python-with-pywinpty <ASCII-temp-copy-of-dev2-pty-probe.py> . <Node24-absolute-path> <ASCII-temp-output-dir> esc-q` 与同样参数末尾的 `ctrl-c`；脚本通过 `PtyProcess.spawn` 启动当前 `apps/cli/dist/index.js`，不是 PassThrough。没有 goal、没有 `--env-file`，子进程移除 API/bridge token key，`--computer osworld --osworld-bridge http://127.0.0.1:9` 仅满足 CLI 配置校验且未访问；未启动 Run、provider、CUA、桌面动作或模型 API。独立 ConPTY 仍为 unsupported（见第 8 节历史说明）。

本次固定构建快照：`dist/index.js` SHA-256 `374D5134EBB53820A7F104278159F8C3B57FE492918E6BE17B93ECD36B6E1A9F`；`dist/tui.js` SHA-256 `74EA956E5E5D3E3D9A9CECB99B129A57548C1B9C5BC3CDEDF9318E87392F5792`。未在本轮重建；证据只适用于该已编译快照。

两次实测均为：pywinpty/winpty backend、初始 24×80，随后 resize 到 30×100；home marker=true，interactive-terminal error=false，8 字符中文输入仅出现 `(8 characters hidden)`，原文未出现在 transcript，separator width `80→100`，resize exception 为 none，cursor hide count `1` 且 restore=true，未强制终止，transcript 各 `9,884` bytes。

- `esc-q`：`probe_exit=0`、child `exit_status=0`、escape write=true、q write=true、forced=false、`passed=true`。
- `ctrl-c`：`probe_exit=0`、child `exit_status=0`、Ctrl-C write=true、forced=false、`passed=true`。

`PtyProcess` 外层 socket 的 `isatty=false` 是 wrapper 自身属性，不作为 child TTY 结论；child 能通过应用自身 `process.stdin.isTTY`/`process.stdout.isTTY` 检查并进入 HOME。cursor restore 与 exit 证据证明本次两种受测退出路径的可观测清理结果，但不扩展为未测试的完整 TUI Run 或独立 ConPTY 结论。运行后的已知 daemon、fixture、PTY helper 进程数均为 `0`；本次没有新增提交或推送。
`PtyProcess` 外层 socket 的 `isatty=false` 是 wrapper 自身属性，不作为 child TTY 结论；child 能通过应用自身 `process.stdin.isTTY`/`process.stdout.isTTY` 检查并进入 HOME。cursor restore 与 exit 证据证明本次两种受测退出路径的可观测清理结果，但不扩展为未测试的完整 TUI Run 或独立 ConPTY 结论。运行后的已知 daemon、fixture、PTY helper 进程数均为 `0`；`dev2-pty-host.cs` 仅是诊断实验 helper，不是产品运行时依赖；本次没有新增提交或推送。
`PtyProcess` 外层 socket 的 `isatty=false` 是 wrapper 自身属性，不作为 child TTY 结论；child 能通过应用自身 `process.stdin.isTTY`/`process.stdout.isTTY` 检查并进入 HOME。cursor restore 与 exit 证据证明本次两种受测退出路径的可观测清理结果，但不扩展为未测试的完整 TUI Run 或独立 ConPTY 结论。运行后的已知 daemon、fixture、PTY helper 进程数均为 `0`；失败的独立 ConPTY helper 未作为产品依赖保留；本次没有新增提交或推送。

## 10. 2026-09-18 真实 GLM 闸门中止

按授权启动了独立 hidden CUA daemon、ASCII 临时路径的同一 PMv2 borderless/topmost fixture，并完成了模型发送前的 CUA preflight。preflight 返回 backend=`cua-driver-daemon`、viewport=`2560×1600/physical`、screenshot/pointer/keyboard=true、accessibility=false；fixture 自有状态确认 `dpiAwarenessSet=True`、DPI `144`、primary/window bounds 均为 `2560×1600`、borderless/topMost/active=true。preflight PNG 为 `420,217` bytes，尺寸与 physical viewport 一致，且只在本机临时目录保存。

本地视觉检查发现 primary 画面右下角仍有 Windows 安全中心通知 toast，故截图不能证明“仅 synthetic fixture 完整覆盖”。立即停止并未创建 go marker，未启动 TUI child、未加载 `<envfile>`、未发送 screenshot/fixture 图给 GLM，provider/API 请求数为 `0`，也未执行任何 click/type/keypress。该 PNG 及临时 daemon/fixture 输出随后已删除，不上传、不入 Git；PNG 是本次临时生成的运行资产，删除后不能从仓库恢复，若需重新取证只能在新的隐私闸门下重新生成；本次中止不计为真实模型或真实桌面验收。

cleanup：只清理由本 probe 创建的 daemon/fixture/编排进程；已知自有 daemon、fixture、helper 进程均为 `0`。因此真实 GLM 任务、provider diagnostics、run/events 与 fixture action 结果本轮均为 `not run`；只有第 9 节 winpty no-goal home 与本节隐私闸门失败可报告。`dev2-fullscreen-fixture.cs`、`dev2-glm-pty.py`、`dev2-glm-tui-run.ts` 均为本轮诊断脚本，不表示产品依赖。

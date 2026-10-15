# Developer getting started

本页承接根目录 README 的通用安装步骤，集中放置平台准备和排查；它不把真实桌面、模型或 OSWorld VM 当作安装后的默认依赖。

## 1. 选择代码版本并安装

本文描述开发预览能力。先确认目标功能所在的开发分支或待审 PR，再执行：

```text
node --version
pnpm --version
corepack enable
corepack install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @computer-harness/web build
pnpm test
```

Node 应为 `22.13.0+`，pnpm 应为 `11.19.0`。根 `pnpm run build` 会构建 workspace references 和类型检查，不要只构建 `apps/cli` 来判断仓库是否完整。

普通 CLI 的直接入口是：

```text
node apps/cli/dist/index.js --help
```

依赖安装在本仓库 workspace 内；不要把全局 Node、其他项目的 OpenClaw/LightSpeaker 环境或本机密钥复制进仓库。

## 2. Windows PowerShell 排查

pnpm 在 Windows 下可能同时生成 `.cmd` 和 `.ps1` wrapper。先确认当前终端不是 WSL/Git Bash 混用：

```powershell
$IsWindows
where.exe node
where.exe pnpm.*
pnpm --version
```

原生 PowerShell 中 `$IsWindows` 应为 `True`。若 wrapper 内出现 `/mnt/` 等 Unix 路径，通常是依赖在另一种 shell 中生成或 PATH 混用。只清理本仓库的 `node_modules`，再用 `pnpm.cmd` 重装；保留 lockfile：

```powershell
Remove-Item -LiteralPath .\node_modules -Recurse -Force
pnpm.cmd install --frozen-lockfile
pnpm.cmd run build
pnpm.cmd test
```

如果执行策略阻止 `.ps1`，持续使用 `pnpm.cmd` 即可；这与路径转换问题是独立问题。

## 3. CUA SDK 按平台路由

当前上手范围为 Windows/macOS，使用 SDK 与 daemon `0.22.2` 配对。computer-cua 按运行平台懒加载对应客户端和原生 binding，不会自动安装或启动 daemon。SDK 与 daemon 必须同版本且 contract 版本匹配；跨版本组合会由 doctor 标记为 `unknown`，不能作为受支持组合。仓库保留的其他兼容依赖以锁文件和第三方声明为准，不作为本指南的安装目标：

- [官方 0.22.2 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.22.2)
- [官方 daemon 生命周期文档（main 分支可变参考；固定版本以 release 为准）](https://github.com/trycua/cua/blob/main/docs/content/docs/how-to-guides/driver/keep-running.mdx)

选择当前平台对应的 daemon release，并按该 release 提供的 checksum 校验下载物。不要用另一平台的 SDK alias 或把不同版本的 SDK 与 daemon 混用。

平台准备要点：

- Windows：使用登录用户的真实桌面会话；服务会话、Session 0 或 RDP 切换可能改变屏幕/焦点权限。
- macOS：按系统提示授予 Accessibility 和 Screen Recording；窗口可见不等于这些权限已生效。

本项目 Windows/CUA 0.22.2 窄路径实测的 daemon 入口形态是 `cua-driver serve --socket "<private-socket>"`；其他平台按对应 release 的安装/权限说明准备 daemon。release 页用于固定资产和 checksum，不把 main 文档或 release 描述当作本项目所有平台的 flag 证据：

```text
cua-driver serve --socket "<private-socket>"
```

再用完全相同的 socket 值运行 Harness。Windows named pipe 与 Unix socket 的写法由 daemon 和当前 shell 决定，README 示例中的 `<private-socket>` 不是本机路径。

无模型、无截图/输入窗口动作的诊断：

```text
node apps/cli/dist/index.js --doctor --computer cua --cua-socket "<private-socket>"
```

诊断可能返回 `unknown` 并以非零码结束；这表示字段、权限、session 或 cleanup 无法确认，不是可以忽略的“全通过”。`--doctor` 不读取 `--env-file`，不截图、不输入窗口、不调用模型，但会建立、检查并结束临时诊断 session；也不支持 TUI、interactive 或 window target。

### CUA 探针

`spikes/cua-driver` 的直接 SDK 依赖固定为 `0.22.2`，下列旧探针不会采用 computer-cua 的平台 alias 路由。先使用上方 Harness `--doctor` 核对平台配对，再按专用桌面授权执行当前 adapter 的集成验证。

默认探针只做只读能力检查；输出目录可能包含当前桌面截图，只能在专用桌面运行并保持本地。输入探针不是任务执行器，也不会判断点击是否符合目标：

```text
pnpm probe:cua
pnpm --filter @computer-harness/cua-driver-spike probe -- --allow-input --click-x <x> --click-y <y>
```

输入探针需要额外的专用桌面授权；完整参数见[`spikes/cua-driver/README.md`](../spikes/cua-driver/README.md)。不要把 probe、fixture 或 screenshot 结果写成模型成功率。

## 4. Provider 与本地 secrets

只在本机创建 `.env` 或使用其他未跟踪 secrets 文件，不要把它加入 Git。`--env-file` 读取普通 `KEY=VALUE` 行；已有进程环境变量优先。CLI 当前实际读取：

| Provider/用途 | Key | 备注 |
| --- | --- | --- |
| GLM key | `ZHIPUAI_API_KEY` | 兼容别名：`ZHIPU_API_KEY`、`GLM_API_KEY` |
| GLM endpoint | `GLM_BASE_URL` | 可选，自定义 OpenAI-compatible endpoint |
| GLM thinking | `GLM_THINKING` | GLM-5.3-Flash 强制思考；使用 `low`、`high` 或 `max` 控制强度。`low` 延迟较低，`max` 为最深档。旧 `enabled` 仍表示由 Provider 使用默认强度；`disabled` 会被当前 GLM-5.3-Flash API 拒绝。 |
| Qwen key | `DASHSCOPE_API_KEY` | Qwen3.8-Flash |
| Qwen endpoint | `DASHSCOPE_BASE_URL` | 别名：`DASHSCOPE_ENDPOINT` |
| Qwen workspace | `DASHSCOPE_WORKSPACE_ID` | 可选；用于生成 workspace endpoint |
| DeepSeek key | `DEEPSEEK_API_KEY` | 官方 `deepseek-flash`；只从本机环境注入，不放在命令行、配置或公共响应里 |
| DeepSeek endpoint | `DEEPSEEK_BASE_URL` | 可选；默认 `https://api.deepseek.com/chat/completions`，接受 API base URL 或完整 chat completions URL |
| DeepSeek request timeout | `DEEPSEEK_REQUEST_TIMEOUT_MS` | 单请求默认 `90000`；可覆盖为 `1000`–`240000` 整数毫秒 |
| DeepSeek output budget | `DEEPSEEK_MAX_OUTPUT_TOKENS` | 默认 `4096`；可覆盖为 `1`–`131072` 整数 token（服务端也可能施加更低限制） |
| Memory embedding key | `MEMORY_EMBEDDING_API_KEY` | Hybrid Memory 专用 key；不要复用聊天模型 key |
| Jev window selector | `TYPESAFE_API_KEY` | 仅显式启用 CUA TUI Jev 选窗时需要；还需允许分享窗口标题，见[配置步骤](./local-launcher.md#jev-辅助选窗可选) |
| OSWorld Bridge | `OSWORLD_BRIDGE_TOKEN` | 可选 loopback Bridge token，不进轨迹 |

普通运行示例：

```text
node apps/cli/dist/index.js --goal "describe the current screen" --model glm-5.3-flash --computer cua --cua-socket "<private-socket>" --output "runs/live-glm" --env-file ".env"
```

### 模型选择与切换范围

CLI Run 必须显式选择 `--model glm-5.3-flash`、`qwen3.8-flash` 或 `deepseek-flash`。切换模型就是结束当前 Run / 退出 TUI 后，以不同 `--model` 启动新 Run / TUI 会话；模型在每个 Run 内固定，TUI 没有模型选择器。CLI 的 `--risk-model` 接受 `off`、`same` 和以上三个模型名；`same` 跟随本 Run 的主模型。

Host 已有启动参数 `--model`（省略时仍默认 GLM），新增 DeepSeek 后可显式选择以上三个模型。Host 进程内的新 Run 使用启动时的模型；要切换须停止旧 Host、确保其 Run 完成清理后，以另一个 `--model` 重启。Web / 手机界面没有每 Run 的模型选择器，也不能修改 Host 的模型。没有运行中热切换、自动 Provider fallback 或动作重放。

DeepSeek 使用截图 `image_url` 和原生 tools，默认发送 `thinking: { type: "disabled" }`，坐标为 `actual_pixels`；它不是 GLM 的别名，也不接受 Qwen 专用参数。只有 CLI 的 Qwen Run 必须额外指定 `--qwen-coordinate-mode normalized_1000` 或 `actual_pixels`（Host 的 Qwen 配置现为 `normalized_1000`）。

DeepSeek 的临时网络错误、429/5xx由Runtime按原请求有限重试；完整响应中的工具协议错误可在零执行前带反馈重新生成。两者共用请求次数、时间窗和预算，不是Provider内部无限循环。鉴权/参数HTTP错误、主动截止、用户取消、完整body无法解码及截断响应不会盲目重试；未知工具仍整组拒绝，结果未知的GUI动作绝不自动重放。本地响应校验不等于启用了服务端strict。

如果环境需要代理，已有 `HTTPS_PROXY` 不一定表示 Node fetch 已启用它。使用可信且已授权的代理时，Node 24.5+（或22.21+）可在启动进程时加 `--use-env-proxy`，例如 `node --use-env-proxy apps/cli/dist/index.js ...`；其他参数保持原命令。该开关只作用于本次进程，不修改系统代理，也不默认改变其他Provider的网络路径。不要关闭TLS校验。若Node版本不支持该开关，先按部署环境选择兼容的代理方案，不把这个参数直接加到所有版本的启动脚本。参见[Node官方说明](https://nodejs.org/api/cli.html#--use-env-proxy)。

从仓库根目录启动新模型的示例（先把 key 放进私有 `.env`，不要把 key 写进命令）：

```text
node apps/cli/dist/index.js --goal "describe the current screen" --model deepseek-flash --computer cua --cua-socket "<private-socket>" --output "runs/live-deepseek" --env-file ".env"
node apps/cli/dist/index.js --goal "describe the current screen" --model qwen3.8-flash --qwen-coordinate-mode normalized_1000 --computer cua --cua-socket "<private-socket>" --output "runs/live-qwen" --env-file ".env"
node apps/host/dist/index.js --env-file ".env" --socket "<private-socket>" --model deepseek-flash --output "runs/host-deepseek"
```

Host 示例里的 `--model` 换为 `glm-5.3-flash` 或 `qwen3.8-flash` 即可为重启后的新 Run 选择对应模型。凭据仍留在 Host 私有环境，Web 不接收 key。

2026-10-14 Windows 实跑：[脱敏结果与历史记录](./member-c-m01-registered-click-2026-10-14.json)。组长修复后的`d973e12`新增两轮真实DeepSeek M01：第一轮47响应、44completed后因点击结果未知停止，Runtime cancelled、无交付；第二轮92请求/91接纳响应、84completed，实际进入新版出诊表并交付正确门诊楼层、发布时间和URL，但未交付两院区具体地址，Runtime succeeded不等于完整业务成功。第二轮一次非JSON工具参数错误实际触发有界feedback恢复；两轮均无API超时。详见[修复记录的Windows实跑补充](./pr30-deepseek-repair-2026-10-14.md#修复后windows真实桌面两次m01实跑补充)。此前GLM错误事实、初始DeepSeek未知工具失败及既有构建/回归结果保留为历史，不称本次发布重新验收或历史超时已修复。

2026-10-15另完成[三轮Planning／Memory／Batching开启实跑](./member-c-deepseek-all-on-2026-10-15.json)，附三份运行前生成的无凭据实际配置投影、生产报告及已提交状态事件。Planning与Memory三轮都有实际使用；Batching开启但没有多GUI动作Batch提议／执行，不能称Batch或三功能组合稳定。三轮Runtime succeeded，但交付出诊表链接均404，业务没有完整通过。此前两轮off配置与本组三轮on配置分开记录，不把开关声明、事实写入或Runtime终态当业务成功证明。

Provider 请求、截图和运行轨迹可能包含敏感内容；截图会随选定的 GLM/Qwen/DeepSeek 请求发送。检查结果时只分享脱敏 summary；不要上传 `runs/`、screenshots、`.env` 或真实窗口截图。`runs/` 不公开上传不等于没有网络传输。

路径提示：直接从仓库根目录执行 `node apps/cli/dist/index.js` 时，`--env-file ".env"` 指向根目录；通过 `pnpm --filter @computer-harness/cli start` 启动时，工作目录是 `apps/cli`，请传根目录 `.env` 的绝对路径或 `..\..\.env`。

启用 Memory `hybrid` 时还要把完整 Qwen embeddings URL 传给 `--memory-embedding-endpoint`，形如 `https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings`。只设置 `MEMORY_EMBEDDING_API_KEY` 而不提供 endpoint，或只提供 endpoint 而没有 key，都不能启动 Hybrid；`lexical` 模式不需要这两个配置。

## 5. OSWorld

OSWorld Python、VM、磁盘和快照在仓库外维护。先阅读：

- [OSWorld upstream](https://github.com/xlang-ai/OSWorld)
- [本仓库 Bridge 指南](../integrations/osworld/README.md)
- [固定环境和 Gate 2 说明](./stage-5-osworld-reproducibility.md)

在 Bridge 前准备与团队约定一致的 OSWorld checkout、Python 环境和 VM artifact；使用无模型 Gate 2 验证 `DesktopEnv`、loopback RPC、显示尺寸和快照，再启动模型。不要复制别人的绝对路径、VMX、快照名或 `vmrun.exe` 路径。

仓库内 Python contract 测试不需要 VM：

```text
python -m unittest integrations.osworld.test_bridge -v
```

Gate 2 和模型 runner 的完整参数以上述 Bridge/Stage 5 文档为准；README 不为不存在的本地 VM 写快捷命令。

## 6. 常见边界

| 现象 | 先检查 |
| --- | --- |
| `--tui requires an interactive terminal` | stdin/stdout 是否真实 TTY；PowerShell 重定向、CI 和普通管道不能启动 TUI |
| 普通 Run 报 `--model is required` | Run 必须显式 `--model`；只有 doctor 使用内部占位值 |
| Qwen 参数报 coordinate 错误 | 加 `--qwen-coordinate-mode normalized_1000` 或 `actual_pixels`，并按需选择 thinking/output mode |
| CUA socket 连接失败 | Windows/macOS 的 SDK/daemon 是否均为 0.22.2、socket 是否相同、桌面会话和平台权限是否有效 |
| doctor 输出 `unknown` | 把它当作未确认边界；不要以 npm 版本、RPC envelope 或静态 tool 名单推断实际 daemon 能力 |
| window action 被拒绝 | window PID/ID、observation 和 geometry 是否仍有效；当前不支持 keyboard、自动发现或 desktop fallback |
| 运行后找不到“回复” | 查看 TUI 的 waiting/failure/final reply 区块与 `runs/<output>`；没有终稿时 UI 会明确显示 unknown/failure，不生成虚构答案 |

TUI 必须将焦点放在当前终端，不注册全局热键；visible input 可能留在 terminal scrollback/recording，这不是隐私保证。`--interactive` 行式模式与 `--tui` 快捷键不同；P/R/I 只属于 TUI 控制面。

### 受管浏览器窗口身份

受管 Edge／Chromium 启动必须同时满足进程归属、CDP 选定窗口和唯一原生窗口证据。几何核对对位置与尺寸逐项限制边框差异（最多 16 DIP），不从候选宽高比例推断缩放，不选最大或最接近的窗口。Windows 使用选定目标的两次原生 `Page.getLayoutMetrics`：物理 viewport 与 CSS viewport 的比值除以 page zoom，得到 CDP 外窗 DIP 到 CUA 原生像素的尺度，并验证横纵及前后读数一致。macOS 两边均为屏幕点，按 1:1 比较。窗口身份不使用页面脚本可改写的 `window.devicePixelRatio`；DOM 内容坐标转换仍保留其独立合同。

缺失、异常或变化中的尺度证据只允许 1:1 的有界帧差；多个合法候选仍拒绝 `multiple_candidates`。当前合同针对本机受管浏览器及已选定的本机 CUA 后端，不代表 Wayland 原生、混合 DPI 或任意多屏原点已经实机验收。拒绝时保留 CDP／CUA 几何诊断，不扩大容差或改用整屏冒充受管 DOM 成功。

### 受管 DOM 点击与新标签页

受管 DOM 点击使用观察绑定的控件中心点；候选收集和点击派发共用视口、裁剪、遮挡及开放 shadow root 命中检查。不可见或中心被遮挡的控件不列入 DOM 候选；控件在观察后被遮挡时，点击明确拒绝并保证未发送输入，应重新观察，不自动重放。

非标准标签的点击资格来自真实 `onclick` 或 CDP 检查到的本元素注册 click 监听器，不靠光标样式或文字猜测。此类控件未声明 ARIA 角色时保留 `generic`，使用自身可见名称；嵌在链接或按钮内的子控件另附父项上下文，独立引用指向子控件自身，不替换成父链接中心。点击前再次发现监听器并执行既有几何、唯一性和命中检查；仅靠该监听器取得点击资格的控件在监听器消失时拒绝，不自动重放。只绑定到祖先的委托事件不据此推断所有后代可点击。

只有实际 DOM 点击的 CDP `Runtime.evaluate` 设置 `userGesture: true`，以支持页面正常的 `target="_blank"` 链接；只读候选收集、点击验证和输入焦点验证不授予用户手势。后续观察仍只接纳已绑定受管窗口内的唯一活动标签页，新窗口不自动接管。`completed` 表示点击已派发，不表示导航或业务任务成功，须从新观察确认预期页面。

混合观察中，Windows UIA 的 `Hyperlink` 与 DOM `link` 使用同一角色。只有已确定属于网页内容区、且本次 DOM 覆盖完整的 UIA 超链接，才要求存在唯一、可见且几何对应的 DOM 项；这类轮播裁剪、遮挡或非活动标签页残留链接不能走原生点击兜底。浏览器工具栏和区域不明的 UIA 控件保留原有受控原生路径，不因网页 DOM 缺少对应项被删除。当前视口有可见但未遍历的 iframe 时，DOM 覆盖标记为不完整；不把“未列出”当作不可见证明，既有 UIA 回退保留。原生窗口、截图点路径和旧引用/禁用控件约束不变。

无可访问名称的轮播箭头仍可按当前观察中的元素引用操作；名称两侧使用相同规范化规则，不能把未命名控件误拒绝为边界变化。控件的指纹、几何、唯一性和中心命中约束保持不变。

注册 click 子控件的 Windows 复现、独立引用导航与已有回归结果见 [2026-10-14 脱敏证据](member-c-m01-registered-click-2026-10-14.json)。其中保留了单次 GLM 超时且未交付清单的结果；控件修复通过不等于完整 M01 业务成功。

### 受管页面的来源 URL

受管 DOM 观察提供当前页的 `pageUrl`，可见原生 HTML 链接提供解析后的 `href`；
它们随同一 observation 持久化并进入 Context，不从地址栏截图、链接文字或启动 URL 猜测。
同名链接按各自实际目标区分。当前页 URL 与当前图片的元数据绑定，即使可选 grounding
候选目录因预算被省略也会保留；历史页面 URL 仅随已保留的历史观察进入上下文。
写 Memory 和最终回答时应原样引用这些观测地址，不能把模型先前自行写的网址当作来源。

URL 证据只接受有界、无 userinfo 的 HTTP(S) 地址；常见认证 token/session 参数、控制字符、
非 Web 地址和过长地址整体省略，允许的 query、fragment 与转义不被截短或重写。
无受管 DOM 证据的原生/UIA fallback 不生成 URL。URL 与网页内容都是来源数据，不会扩大操作权限。
启用 source-linked finish 时，引用所绑定的 observation/element 中的原始地址由 Runtime 渲染，
而不是采用模型另外提供的网址；普通自由文本回答仍须核对，不因 Runtime succeeded 自动视为业务通过。

2026-10-15 的 URL 链路修复完成 Windows 定向回归和真实受管 Edge 的本地页面验证：
覆盖重定向后的当前 URL、同名不同目标链接、导航后地址、历史来源以及引用式交付。
这轮没有调用模型 API，不代表修复后完整 M01 已实跑通过，也不替代 macOS 实机验收。

### 导航恢复、Monitor 与预算收尾

优先使用当前唯一 DOM 元素引用；父链接导航与独立展开控件不是同一操作。
`completed` 只表示派发完成，导航效果须由下一次观察的 URL、页面或菜单状态确认。
地址栏没有肯定焦点证据时仍拒绝输入；不要原样重试 type，改选 Goal 范围内的可见链接。

Run 级 `monitor=guidance` 可为连续安全拒绝提供有界策略反馈；默认开关不变。
guidance 额度针对尚未解决的停滞：新的 changed 观察重置该额度；changed／unknown
转换会作废上一候选的延迟人工接管请求，但不清除未知副作用保护，也不自动回答人工请求。
持续同一问题耗尽额度后仍会等待用户。Monitor、模型自报与来源引用均不是业务成功判据。

总请求预算至少为3时，末尾 `min(3, max(1, floor(limit/10)))` 个请求只提供结束工具。
收尾中的 GUI 工具组整体拒绝，剩余额度可消费反馈并交付已知结果与缺项，不增加总预算。
小预算1／2保留原有行为。source-linked finish 仍为可选的来源证据渲染；
它不能替代截图中读取的完整事实清单，启用前须确认交付合同适用。

2026-10-15 两轮 DeepSeek Flash M01 实跑及上述修复见
[运行与修复报告](member-c-deepseek-convergence-2026-10-15.md)和
[脱敏结构化摘要](member-c-deepseek-convergence-2026-10-15.json)。
两轮分别因过早接管和结束工具连续违规而未交付最终清单，不作为完整业务通过。

同日后续按 `low` 思考及扩额配置实跑的两个独立 Windows M01 Run 均交付完整清单：
[业务完成报告及来源截图](member-c-deepseek-low-expanded-2026-10-15.md)、
[实际配置与原样最终清单](member-c-deepseek-low-expanded-2026-10-15.json)。
91次真实HTTP均确认enabled／low；这是本轮两个开发样本的业务通过，不是稳定性、
多GUI Batch或macOS验收。产品默认配置未变，既有失败和时序／记忆投影限制保留。

## 7. 贡献前检查

默认贡献路径不需要 API、桌面或 VM：

```text
pnpm run build
pnpm --filter @computer-harness/web build
pnpm test
```

提交文档或代码时同时说明：实际运行的命令、Node/pnpm、是否读取 secrets、是否触碰桌面/VM、测试范围和未验证限制。保持包边界，不从生产代码跨包导入私有 `src`；不要提交真实 runs、截图、VM、token 或本机绝对路径。

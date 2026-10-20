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
| 火山方舟 Agent Plan key | `ARK_API_KEY` | 独立渠道 `deepseek-v4.1-flash`；不复用或回退到官方 `DEEPSEEK_API_KEY`，只从本机环境注入 |
| 方舟 Agent Plan endpoint | `ARK_BASE_URL` | 可选；默认 `https://ark.cn-beijing.volces.com/api/plan/v3`，接受 base URL 或完整 `/chat/completions` URL |
| 方舟 request timeout | `ARK_REQUEST_TIMEOUT_MS` | 单请求默认 `90000`；可覆盖为 `1000`–`240000` 整数毫秒，与官方 DeepSeek 配置独立 |
| 方舟 output budget | `ARK_MAX_OUTPUT_TOKENS` | 默认 `4096`；可覆盖为 `1`–`131072` 整数 token，服务端仍可能施加更低限制 |
| Memory embedding key | `MEMORY_EMBEDDING_API_KEY` | Hybrid Memory 专用 key；不要复用聊天模型 key |
| Jev window selector | `TYPESAFE_API_KEY` | 仅显式启用 CUA TUI Jev 选窗时需要；还需允许分享窗口标题，见[配置步骤](./local-launcher.md#jev-辅助选窗可选) |
| OSWorld Bridge | `OSWORLD_BRIDGE_TOKEN` | 可选 loopback Bridge token，不进轨迹 |

普通运行示例：

```text
node apps/cli/dist/index.js --goal "describe the current screen" --model glm-5.3-flash --computer cua --cua-socket "<private-socket>" --output "runs/live-glm" --env-file ".env"
```

### 模型选择与切换范围

CLI Run 必须显式选择 `--model glm-5.3-flash`、`qwen3.8-flash`、`deepseek-flash`（DeepSeek 官方）或 `deepseek-v4.1-flash`（火山方舟 Agent Plan）。切换模型就是结束当前 Run / 退出 TUI 后，以不同 `--model` 启动新 Run / TUI 会话；模型在每个 Run 内固定，TUI 没有模型选择器。CLI 的 `--risk-model` 接受 `off`、`same` 和以上四个模型名；`same` 跟随本 Run 的主模型。

Host 启动参数 `--model` 接受以上四个模型，省略时仍默认 GLM。Host 进程内的新 Run 使用启动时的模型；要切换须停止旧 Host、确保其 Run 完成清理后，以另一个 `--model` 重启。Web / 手机界面没有每 Run 的模型选择器，也不能修改 Host 的模型。没有运行中热切换、自动 Provider fallback 或动作重放。

DeepSeek 官方和方舟 Agent Plan 均使用截图 `image_url` 和原生 tools，默认发送 `thinking: { type: "disabled" }`，坐标为 `actual_pixels`；两者使用独立模型标识、端点、凭据和请求设置，方舟诊断记录为 `provider: "ark"`。它们不是 GLM 的别名，也不接受 Qwen 专用参数。只有 CLI 的 Qwen Run 必须额外指定 `--qwen-coordinate-mode normalized_1000` 或 `actual_pixels`（Host 的 Qwen 配置现为 `normalized_1000`）。

这两条 DeepSeek 渠道的临时网络错误、429/5xx由Runtime按原请求有限重试；完整响应中的工具协议错误可在零执行前带反馈重新生成。两者共用请求次数、时间窗和预算，不是Provider内部无限循环。鉴权/参数HTTP错误、主动截止、用户取消、完整body无法解码及截断响应不会盲目重试；未知工具仍整组拒绝，结果未知的GUI动作绝不自动重放。本地响应校验不等于启用了服务端strict。

如果环境需要代理，已有 `HTTPS_PROXY` 不一定表示 Node fetch 已启用它。使用可信且已授权的代理时，Node 24.5+（或22.21+）可在启动进程时加 `--use-env-proxy`，例如 `node --use-env-proxy apps/cli/dist/index.js ...`；其他参数保持原命令。该开关只作用于本次进程，不修改系统代理，也不默认改变其他Provider的网络路径。不要关闭TLS校验。若Node版本不支持该开关，先按部署环境选择兼容的代理方案，不把这个参数直接加到所有版本的启动脚本。参见[Node官方说明](https://nodejs.org/api/cli.html#--use-env-proxy)。

从仓库根目录启动新模型的示例（先把 key 放进私有 `.env`，不要把 key 写进命令）：

```text
node apps/cli/dist/index.js --goal "describe the current screen" --model deepseek-flash --computer cua --cua-socket "<private-socket>" --output "runs/live-deepseek" --env-file ".env"
node apps/cli/dist/index.js --goal "describe the current screen" --model deepseek-v4.1-flash --computer cua --cua-socket "<private-socket>" --output "runs/live-ark" --env-file ".env"
node apps/cli/dist/index.js --goal "describe the current screen" --model qwen3.8-flash --qwen-coordinate-mode normalized_1000 --computer cua --cua-socket "<private-socket>" --output "runs/live-qwen" --env-file ".env"
node apps/host/dist/index.js --env-file ".env" --socket "<private-socket>" --model deepseek-flash --output "runs/host-deepseek"
node apps/host/dist/index.js --env-file ".env" --socket "<private-socket>" --model deepseek-v4.1-flash --output "runs/host-ark"
```

Host 示例里的 `--model` 可换为以上任一模型名。凭据仍留在 Host 私有环境，Web 不接收 key；同一私有 env 文件可分别设置 `ARK_API_KEY` 与 `DEEPSEEK_API_KEY`，选择渠道不会覆盖另一条渠道的配置。

火山方舟渠道的完整配置、Run 级 low 与产品默认值的区别，以及 Windows 接入 smoke、两轮 disabled／两轮 low 的脱敏运行结果，见[火山方舟 Agent Plan 接入与运行记录](./volcengine-ark-agent-plan-2026-10-16.md)。历史样本使用既有 Windows 修复候选，不是对本提交树重新部署或实跑；不要把 Runtime 成功或启用开关当作业务成功。

Provider 请求、截图和运行轨迹可能包含敏感内容；截图会随选定的 GLM/Qwen/DeepSeek 官方/方舟请求发送。检查结果时只分享脱敏 summary；不要上传 `runs/`、screenshots、`.env` 或真实窗口截图。`runs/` 不公开上传不等于没有网络传输。

路径提示：直接从仓库根目录执行 `node apps/cli/dist/index.js` 时，`--env-file ".env"` 指向根目录；通过 `pnpm --filter @computer-harness/cli start` 启动时，工作目录是 `apps/cli`，请传根目录 `.env` 的绝对路径或 `..\..\.env`。

启用 Memory `hybrid` 时还要把完整 Qwen embeddings URL 传给 `--memory-embedding-endpoint`，形如 `https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings`。只设置 `MEMORY_EMBEDDING_API_KEY` 而不提供 endpoint，或只提供 endpoint 而没有 key，都不能启动 Hybrid；`lexical` 模式不需要这两个配置。

### 有限恢复与 Run 墙钟

Runtime 最多重试一次。单个 decision 的恢复窗口按两次已配置的 HTTP 请求期限加一次 500ms 延迟计算，不再使用独立的固定 120 秒窗口；每次恢复仍须同时满足请求次数、decision 剩余时间和 Run 剩余墙钟。默认工厂和注入 `createProvider` 使用同一份配置期限；自定义 Provider 必须遵守工厂传入的对应请求期限，不能把更长的真实 HTTP 等待伪装成较短预留。

Ark 的可重试状态与有界 `Retry-After` 建议仍按 Provider 的现有策略处理；等待和重新准备请求后仍须重新检查独立预算。请求次数收尾保持最后一次请求只供 `terminate`，不恢复旧的三请求预留；墙钟收尾与请求次数边界独立，任一进入收尾都不允许继续 GUI 探索。

通过 app-runtime `createRun` 使用可选 `runTimeoutMs` 时，硬期限从 `start()` 开始计算，包含观察、准备请求和等待用户输入。Runtime 在剩余时间进入收尾预留区后停止 GUI 探索，Context 只提供 `terminate`，并保留最终硬取消；默认收尾预留为一次 Provider 请求期限。这是程序化 Run 配置，不是新增 CLI flag；外部宿主若另设硬取消，须把同一总期限传入 Run，不能只在宿主维护一个 Runtime 不可见的计时器。

完整的协议错误只允许零执行后的有限反馈重决策；`terminate` 仍须独占响应。截断 `length` 无论参数看似完整与否都不执行，也不自动重试；此前已经完成的动作和结果未知的动作都不会因为模型响应恢复而重放。核对任务是否完成与记录是否一致分别表达，不强行改写模型的原始状态。

### 受管浏览器的只读可见表格证据

DOM/hybrid 观察可附带独立于交互元素 hot set 的 `grounding.visibleText`。它只面向当前主文档视口内可证明可见的原生 HTML 表格，保留原 Unicode、行列索引、表头和跨行跨列关系；继承同次 observation、页面和 surface 绑定，不生成可点击元素引用。

页面来源只补充同次受管采集的有界 `pageUrl`，不从启动地址或截图猜测；Context 要求当前 observation/session/surface 一致。只保留无 userinfo、无常见认证参数的完整 HTTP(S) 地址，无法安全提供时标记未知；地址是来源数据，不是指令或额外导航授权。

采集与请求投影都有界：最多 2 个区域、24 行、12 列、192 个单元格、每格 320 字符及总计 4800 字符。超限或可见性不足时省略整格并标记 partial/truncated；Context 放不下时整块省略并记录 trace，不把半格文字冒充完整证据。这里的 complete 只描述该有界表格采集，不代表整页覆盖。

隐藏、裁剪、遮挡或绘制无法可靠界定的内容不作文字证据；图片/canvas、div/ARIA grid、iframe 和 shadow table 不由此通路读取。空或 partial 证据不能证明官网未提供某字段。字段与来源绑定有助于准确转录，但不代替业务真值核对，也不保证模型不会误读或改写最终答案。

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

只有实际 DOM 点击的 CDP `Runtime.evaluate` 设置 `userGesture: true`，以支持页面正常的 `target="_blank"` 链接；只读候选收集、点击验证和输入焦点验证不授予用户手势。后续观察仍只接纳已绑定受管窗口内的唯一活动标签页，新窗口不自动接管。`completed` 表示点击已派发，不表示导航或业务任务成功，须从新观察确认预期页面。

混合观察中，Windows UIA 的 `Hyperlink` 与 DOM `link` 使用同一角色。只有已确定属于网页内容区、且本次 DOM 覆盖完整的 UIA 超链接，才要求存在唯一、可见且几何对应的 DOM 项；这类轮播裁剪、遮挡或非活动标签页残留链接不能走原生点击兜底。浏览器工具栏和区域不明的 UIA 控件保留原有受控原生路径，不因网页 DOM 缺少对应项被删除。当前视口有可见但未遍历的 iframe 时，DOM 覆盖标记为不完整；不把“未列出”当作不可见证明，既有 UIA 回退保留。原生窗口、截图点路径和旧引用/禁用控件约束不变。

无可访问名称的轮播箭头仍可按当前观察中的元素引用操作；名称两侧使用相同规范化规则，不能把未命名控件误拒绝为边界变化。控件的指纹、几何、唯一性和中心命中约束保持不变。

## 7. 贡献前检查

默认贡献路径不需要 API、桌面或 VM：

```text
pnpm run build
pnpm --filter @computer-harness/web build
pnpm test
```

提交文档或代码时同时说明：实际运行的命令、Node/pnpm、是否读取 secrets、是否触碰桌面/VM、测试范围和未验证限制。保持包边界，不从生产代码跨包导入私有 `src`；不要提交真实 runs、截图、VM、token 或本机绝对路径。

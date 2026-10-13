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
| Memory embedding key | `MEMORY_EMBEDDING_API_KEY` | Hybrid Memory 专用 key；不要复用聊天模型 key |
| Jev window selector | `TYPESAFE_API_KEY` | 仅显式启用 CUA TUI Jev 选窗时需要；还需允许分享窗口标题，见[配置步骤](./local-launcher.md#jev-辅助选窗可选) |
| OSWorld Bridge | `OSWORLD_BRIDGE_TOKEN` | 可选 loopback Bridge token，不进轨迹 |

普通运行示例：

```text
node apps/cli/dist/index.js --goal "describe the current screen" --model glm-5.3-flash --computer cua --cua-socket "<private-socket>" --output "runs/live-glm" --env-file ".env"
```

Provider 请求、截图和运行轨迹可能包含敏感内容；截图会随选定的 GLM/Qwen 请求发送。检查结果时只分享脱敏 summary；不要上传 `runs/`、screenshots、`.env` 或真实窗口截图。`runs/` 不公开上传不等于没有网络传输。

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

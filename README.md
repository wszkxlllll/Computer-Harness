# Computer Harness

### 面向真实桌面任务的可组合 GUI Agent

用自然语言发起任务，在终端或手机网页中观察进度、补充要求与处理审批。模型负责决策，Harness 负责连接桌面、管理执行状态，并保留可追溯的运行记录。

**TypeScript · 可替换模块 · 桌面与网页 · TUI / Web · 开发预览**

[快速开始](#快速开始) · [手机控制](#手机控制) · [架构与扩展](#架构与扩展) · [任务与评测](#任务与评测) · [开发文档](./docs/DOCS-INDEX.md)

> 当前为开发预览。手机控制目标模式与受管浏览器入口已接入，公网资源和本机只读启动链路已有验证；真实手机完整业务任务、复杂跨窗口任务和其他平台仍需单独验收，不是稳定产品承诺。

## 能做什么

| 能力 | 使用方式 |
| --- | --- |
| **执行桌面任务** | GLM / Qwen 结合截图提出动作，由 CUA 操作本机，或通过 OSWorld Bridge 操作评测环境。 |
| **选择目标窗口** | TUI 按应用名和标题选择；唯一可信的本地匹配可自动绑定，不确定时交给用户。支持受控的激活与窗口交接。 |
| **结合视觉与控件信息** | 可选 UIA / Accessibility；托管浏览器可增加 DOM。元素点击与普通坐标操作共存。 |
| **控制执行过程** | 暂停、恢复、纠正、审批和 Abort 进入同一个 Runtime，不另建执行循环。 |
| **组合实验策略** | Context、Planning、Run Memory、受限 Action Batch、Monitor 和 Risk Guard 按配置参与执行。 |
| **保留运行证据** | 记录事件、截图、动作回执与结果，区分工具完成、模型报告和真实任务验收。 |

项目面向日常应用与网页任务，不局限于浏览器或出行票务。当前优先改善 Windows 本机体验；其他平台的代码与 CI 支持不等于真实桌面已全面验证。

## 快速开始

### 1. 获取代码并构建

需要 Node.js `>=22.13.0`、pnpm `11.19.0`。仅构建和离线测试不需要模型密钥或桌面权限。

```sh
git clone https://github.com/wszkxlllll/Computer-Harness.git
cd Computer-Harness
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @computer-harness/web build
```

还没有 pnpm 或使用隔离 Node 环境？先读[安装指南](./docs/getting-started.md)。

### 2. 配置本机环境

Windows PowerShell 中复制配置模板：

```powershell
Copy-Item .harness.local.example.psd1 .harness.local.psd1
```

填写 Node 路径、CUA Driver 路径、私有 socket、模型和输出目录；pnpm 不在 PATH 时填写 `PnpmCliPath`。Provider 密钥放入本机 `.env`，不要写进命令或提交到仓库。

本机操作需要匹配版本的 **CUA Driver 0.22.2**，它不随仓库打包。驱动准备、模型变量及隔离环境配置见[开发者上手](./docs/getting-started.md)与[本地启动器](./docs/local-launcher.md)。

### 3. 打开 TUI，输入任务

```powershell
.\scripts\harness.ps1 start -Grounding auto
```

在首页输入目标，按 Enter 开始。窗口和功能可在界面中选择，模型沿用本机配置，不必为每次任务填写一长串参数。

| 操作 | 按键 |
| --- | --- |
| 输入目标 / 补充或纠正要求 | `I` |
| 选择窗口 / 调整下一次 Run 的功能 | 首页 `W` / `F`；目标编辑中可先按 `Esc` |
| 暂停 / 恢复 | `P` / `R` |
| 批准 / 拒绝待审批动作 | `Y` / `N` |
| 中止当前任务 | `A` / `Ctrl+C` |
| 查看长回复 | `PageUp` / `PageDown` |

快捷键仅在当前终端和对应状态生效；编辑中的字母仍是输入内容。暂停与 Abort 不是回滚，已经发生的操作不会自动撤销。

`Grounding auto` 按所选目标解析：普通窗口使用 UIA，Harness 托管浏览器使用 DOM + UIA，整桌面关闭 Grounding。它不会让个人浏览器自动开放 DOM 权限。登录与持久浏览器配置见[启动器说明](./docs/local-launcher.md)。

## 可选：Jev 辅助选窗

Jev 只负责从窗口候选中做选择，任务执行仍由 GLM / Qwen 决策。先在 `.harness.local.psd1` 的 `EnvFile` 指向的私有文件中添加 TypeSafe 密钥（默认是仓库根目录 `.env`），保留原来的主模型密钥：

```dotenv
ZHIPUAI_API_KEY=your_glm_key
TYPESAFE_API_KEY=your_typesafe_key
```

上例使用 GLM；使用 Qwen 时主模型密钥改为 `DASHSCOPE_API_KEY`，其他配置见[模型环境变量](./docs/getting-started.md)。不要把真实密钥提交到仓库。

```powershell
.\scripts\harness.ps1 start -Grounding auto -WindowSelector jev -ShareWindowTitles
```

这会允许发送 **goal、候选应用名和窗口标题** 给 TypeSafe；不会向 Jev 发送截图。密钥存在并不会自动启用该功能。常驻配置、关闭方法和故障排查见[Jev 配置指南](./docs/local-launcher.md#jev-辅助选窗可选)。目前仅支持 CUA TUI，不是手机 Host 或通用动作 fast path。

## 手机控制

手机浏览器是同一套 Harness 的另一入口：发任务、看进度与截图、补充要求、处理审批和查看结果。Provider 与桌面执行仍在电脑端，服务器只承担中继。

配置好本机环境后：

```powershell
.\scripts\mobile.ps1 check
.\scripts\mobile.ps1 start
```

源码变化后需要重建时使用：

```powershell
.\scripts\mobile.ps1 start -Build
```

在**电脑**打开 `http://localhost:4317` 预览控制台。真手机需要通过已部署的 HTTPS Relay 访问；手机中的 `localhost` 指向手机自己，不能直接连接电脑。

手机每次发起任务可以选择三种目标模式：

- **自动选择（默认）**：按 Goal 在本机已打开或最小化的顶层窗口中匹配应用名和标题。只有唯一且可信的匹配才自动绑定；无匹配或有歧义时保留任务并转入手动选择，不静默接管整桌面，也不会自动启动未打开的原生应用。
- **手动选择窗口**：由用户从当前可见窗口中选择，作为自动匹配的兜底。
- **打开网站**：使用 Harness 管理的浏览器会话。`临时浏览`是默认选项，使用一次性 profile；`使用已登录网站`是显式选项，使用 Host 管理的持久 profile。临时模式网址留空会打开空白页；已登录模式网址留空会恢复 Host 登记的网站；填写网址时只能使用允许的 HTTP(S) 地址。

浏览器的 profile 根目录、标签、Cookie 和 CDP 地址始终由 Host 管理，手机不能传入任意路径或登录数据；个人日常浏览器的登录状态不会自动复制到 Harness。若受管浏览器异常退出并留下运行标记，先停止 Host，再执行：

```powershell
.\scripts\mobile.ps1 recover-browser-profile
```

该命令只在 Host 和 profile 所有者均已停止时运行，并将 Host-owned profile 中的陈旧运行标记归档，不删除登录数据或任意用户文件。

- [手机使用指南](./docs/mobile-control-guide-2026-09-26.md)：配对、操作和配置边界。
- [手机目标模式与浏览器接入记录](./docs/mobile-target-modes-2026-09-27.md)：自动选窗、临时/已登录浏览器、profile 安全边界和验证证据。
- [服务器部署](./apps/relay/README.md)：HTTPS/WSS、凭据、服务运维与回滚。
- [验证与问题清单](./docs/mobile-control-issues-2026-09-26.md)：哪些已验证，哪些尚未放行。

Host 当前使用固定组合预设：Planning、Fact Memory、lexical retrieval、recent Context、same-control input Batch、layered Guard、shadow Monitor 和人工确认的窗口交接；原生窗口目标默认不启用 UIA/DOM，受管浏览器目标使用 Hybrid Grounding。Host **不会继承 TUI 上次选择的功能**。不要同时用手机与 TUI 控制同一桌面；手机公网完整业务任务和无障碍验收仍需单独完成。

## 架构与扩展

Pi 式改造的重点是明确组合入口，让开发者替换组件，同时复用执行、审批、预算与事件合同。

```text
TUI / CLI / SDK                         手机 Web
       │                                  │
       │                        HTTPS Relay → 本机 Host
       └────────────────┬─────────────────┘
                        ▼
                  app-runtime
              每 Run 装配 / 用户控制
                        │
                        ▼
                     Runtime
              观察 → 决策 → 执行 → 观察
                 │      │       │
           Provider   策略模块   Computer
           GLM/Qwen   Context    CUA/OSWorld
                      Plan/Memory

              全程记录 Events / Trajectory
```

| 想替换或扩展 | 从这里开始 |
| --- | --- |
| Provider、Computer、工具与 ContextCompiler | [SDK 装配示例](./docs/sdk-run-composition.md) |
| Planning / Memory 的工具、状态与 Context 投影 | [模块组合合同](./docs/pi-module-composition-2026-09-23.md) |
| 包职责、资源所有权与应用入口 | [架构与组合说明](./docs/ARCHITECTURE-AND-COMPOSITION.md) |
| 动作有效性、审批、未知副作用与清理 | [Runtime 安全合同](./docs/RUNTIME-AND-SAFETY-CONTRACTS.md) |

这些是 workspace 内的代码级扩展接口；包尚未发布到 npm，也没有动态插件市场或运行中热替换。Monitor 等能力仍在 Runtime 内，不是每个模块都具有独立工厂。

## 任务与评测

**真实生活任务**用于发现体验问题，**OSWorld**用于可复现对照。两者互补，不把运行结束直接当作任务成功。

- [20 个出行任务与人工反馈表](./docs/travel-task-cards-and-feedback.md)：完整 goal，覆盖 12306、携程、高德的查询、比较、修改约束和跨应用整理。
- [任务 manifest](./eval/travel/travel-candidate-manifest.v0.json)：机器可读的任务组织；[试点准备](./docs/travel-pilot-preparation-2026-09-20.md)说明登录、日期与环境要求。
- [OSWorld Bridge](./integrations/osworld/README.md)及[复现指南](./docs/stage-5-osworld-reproducibility.md)：独立准备 VM、快照和 evaluator。

队友可参考任务手册第 5 节，为自己的领域建立 `docs/<domain>-task-cards.md` 与 `eval/<domain>/<domain>-manifest.json`。每题说明目标、初态、允许/禁止操作、可观察结果和人工评分，并区分开发与留出任务。

当前出行样例只做查询与整理，不购票、占座、下单或付款。原始截图、轨迹和账号信息保留在本地 `runs/`，不提交仓库。

## 当前验证与限制

2026-09-27 检查点：根构建、Web 构建通过；**84 个 Vitest 文件、814 项测试通过**，脚本测试 19 项通过、1 项因 Windows 无法创建符号链接而跳过。公网 Relay/Web 资源健康检查通过；这不是所有远端 CI、手机网络环境或真实业务任务均已通过的声明。

仍需解决或验收：

- 原生整段输入、浏览器弹层捕获，以及 WPS / 完整跨窗口任务的可靠性。
- 模型定位偏差、重复动作和延迟；UIA、DOM、Monitor 不保证业务成功。
- 真手机公网配对、真实网络切换、审批和实体设备无障碍体验；当前浏览器二态与窗口恢复主要是 Windows/CUA 的只读验证。
- macOS 等平台的 managed-profile 恢复尚未放行：默认进程检查无法可靠保留 `argv` 边界时会返回 `unknown` 并拒绝恢复；需要接入边界保持的进程 API 后再做真实验收。其他平台的真实桌面适配也仍待验证。

窗口模式不是操作系统沙箱，也不保证后台输入或用户并发操作不受影响。截图会发送给所选模型；可选 Jev 选窗需明确允许分享应用名和窗口标题。受管浏览器的启动/观察通过只读真实验证，不等于网页导航、消息发送或复杂任务已完成。不要使用无授权账号或敏感生产环境试验。

详细证据、失败复测及后续顺序见[项目交接](./docs/PROJECT-HANDOFF.md)和[测试报告](./docs/mobile-control-technical-report-2026-09-26.md)。

## 开发与贡献

```sh
pnpm run build
pnpm --filter @computer-harness/web build
pnpm test
```

提交通过 PR 审查合并。说明改动范围、验证结果与剩余限制；真实 API、桌面和 VM 测试需明确授权，不用 mock 通过代替实机证据。

继续开发从[五份交接文档](./docs/PROJECT-HANDOFF.md#2-接手只需按顺序读这五份)开始，专题导航见[文档索引](./docs/DOCS-INDEX.md)。长期 Memory、Subagent、Sandbox、无障碍个性化与受控自进化仍是后续方向，不是当前功能承诺。

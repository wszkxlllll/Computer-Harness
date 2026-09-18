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
| CUA window opt-in | 仅显式 PID + window ID；当前只开放已验证的窗口观察/单击/wait 路径，keyboard 不开放 |
| 诊断 | `--doctor` 无模型、无截图/输入窗口动作且脱敏；会建立并结束临时诊断 session，cleanup 未确认时返回 `unknown` |

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

## 运行一个本地任务

普通 Run 必须显式提供 `--goal`、`--model` 和 Computer 连接。下面是当前验证过的 direct Node 入口，可减少 shell/pnpm wrapper 的参数差异；这与 CUA socket 是否可连接是两件事。Provider 请求只会在 Run 真正开始后发生。

```text
node apps/cli/dist/index.js --goal "describe the current screen" --model glm-5.3-flash --computer cua --cua-socket "<private-socket>" --output "runs/live-glm" --env-file ".env"
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
| `--max-steps` / `--max-model-requests` | 各 `30` | 正整数预算 |
| `--planning` / `--memory` / `--batching` | `off` / `off` / `off` | Memory 可选 `facts`/`entities`；Batch 可选 `same-control-input-v1` |
| `--context-mode` | `raw` | 可选 `recent`；历史事件默认上限 `80` |
| Qwen 坐标 | 必须显式 `--qwen-coordinate-mode` | `normalized_1000` 或 `actual_pixels`；默认 thinking=`low`、output=`strict_json` |
| 输出目录 | `runs/live-cli` | CUA screenshot 默认在输出目录下的 `driver-screenshots` |
| Cleanup / Risk timeout | `5000ms` / `30000ms` | 可分别用 `--cleanup-deadline-ms`、`--risk-timeout-ms` 调整 |
| Window target | 关闭 | 必须同时提供 `--cua-window-pid` 和 `--cua-window-id` |

默认组合是 `--planning`/Memory/Batch=`off`、Context=`raw`；非交互 `experiment` profile 的 Guard 默认 `off`，`--interactive`/`--tui` 的 `live-interactive` profile 默认 `layered`。需要改变这些默认值时使用对应开关并记录配置。

## TUI 预览

TUI 需要 `stdin`/`stdout` 都是可交互 TTY。无 `--goal` 时先进入首页，输入目标并按 Enter 开始新 Run；使用时仍需提供 `--model` 和 Computer 连接：

```text
node apps/cli/dist/index.js --tui --model glm-5.3-flash --computer cua --cua-socket "<private-socket>" --output "runs/tui" --env-file ".env"
```

快捷键只作用于当前 TTY，不是全局热键：

| 按键 | 作用 |
| --- | --- |
| `I` | 进入 goal/correction 编辑；Run 正在执行时先请求 pause/quiescence，不能用编辑态绕过未决动作 |
| `Enter` | 首页开始 Run；Run 中提交 correction。提交经过 Controller Inbox，旧决策失效；pause barrier 未完成时会排队 |
| `P` / `R` | 通过 Controller 暂停 / 恢复当前 Run |
| `A` / `Ctrl-C` | Abort 当前 Run；退出时保留未确认 cleanup，不把停止请求冒称底层已停止 |
| `Y` / `N` | waiting approval 时批准 / 拒绝 |
| `PageUp` / `PageDown` | 查看长 reply、question 或 approval 的分页 |
| `Esc` / `Q` | 取消编辑或退出；退出会恢复 raw mode 和 cursor |

编辑态中的 `A`、`Q` 是正文，不是快捷键。必须把焦点放在当前终端；TUI 不注册全局热键，也不会把其他应用收到的按键冒称为输入。输入会显示在本地终端，可能留在 terminal scrollback、录屏或终端日志中；共享 diagnostics/report 仍不写入原始输入。真实 no-goal WinPTY 只证明终端生命周期、中文/resize、尾部可见、500 上限和退出清理，不证明完整 model Run、跨 Run 的真实纠正或通用焦点；另有一次 T10 synthetic fixture GLM 闭环，见“当前证据与限制”。

`--interactive` 不启动 TUI：它提供行式用户输入和审批；`P`/`R`/`I` 是 TUI 控制，不适用于行式入口。

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

当前只开放已验证的 window-local observation、single-click 和 `wait`；keyboard、其他 pointer primitive、自动发现窗口、通用 focus/AX 和 silent desktop fallback 都不开放。窗口移动/resize、关闭或 identity 变化会使旧 observation/action 失效；preflight 与 driver action 不是原子事务，不能宣称业务动作一定成功。OSWorld 不接受这些 CUA window flags。

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

- 离线基线：`pnpm test` 32 files / 320 tests，`pnpm run typecheck` 通过；测试不代表真实模型效果。
- 实机窄证据：Windows + CUA 0.22.2 专用 fixture 的 adapter window observe/single-click/wait；另有一次 T10 synthetic fixture GLM 闭环（4 requests/responses、3 primitive actions、4 fixture observations）。这与 no-goal WinPTY rapid/slow × ESC→Q/Ctrl-C 四场景分别记录，不能外推通用桌面、focus/AX、所有平台或完整业务 Run。
- `--doctor` 是无模型、无截图/输入窗口动作的诊断，但会建立/结束临时 session，仍可能 cleanup `unknown`；不能把 metadata/inventory 支持误读成 session、权限或 cleanup 全部通过。
- Provider transport failure、CUA refusal、真实焦点和 OSWorld 业务结果需按独立验证记录解释；本 README 不把它们包装成已解决或成熟安全保证。

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

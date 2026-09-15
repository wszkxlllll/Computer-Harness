# Computer Harness

Computer Harness 是一个独立的、Provider-neutral 的多模态 GUI Agent Runtime
实验仓库。它位于多模态模型和 Computer Driver 之间，负责统一 Observation、
ToolCall、GUI Action、运行状态和轨迹记录。

当前仓库已完成 V1 核心运行时和 Stage 6 工程收敛：Context、canonical Computer Tools、
GLM/Qwen Provider、CLI、可插拔 Planning/Run Memory，以及受限 Action Batch 已接入同一
Runtime 与 ToolRegistry。工程集成已通过；正式效果实验仍需等待 G0 evaluator、预算和任务清单冻结：

- 已建立 pnpm workspace；
- 已固定 TypeScript、Vitest 工程基线和 CUA Driver 0.22.2；外部输入需要 Schema 校验时再按包引入 Zod；
- 已实现核心 protocol 类型；
- 已实现 JSONL RuntimeEvent Writer、最小 FileAssetStore 和纯函数 RunSnapshot Reducer；
- 已加入 CUA 0.22.2 的安全技术探针和真实 `packages/computer-cua` 适配器；
- 已实现 `packages/runtime` 的 FakeProvider/FakeComputer RunController、命令 Inbox、
  失败注入和统一 Action/Capability/Viewport 校验；
- 已实现 `packages/context` 的时序投影、`packages/provider-glm` 的 profile 抽象（当前生产 profile 为 `glm-5.3-flash`）、
  `packages/provider-qwen` 的 Qwen3.8-Flash strict-json/native-tools 双路径适配，以及 `apps/cli` 组合入口；
- 已实现 `packages/context` 的 raw/recent 历史策略与近似预算报告、`packages/memory` 的 Run 内事实/轻实体 Store，
  以及 Runtime 的同控件输入 Batch（默认关闭）；CUA 与 OSWorld fake backend seam 的受控 fixture 已通过；
- 已实现 `packages/computer-osworld`、loopback Python Bridge 和 `--computer osworld` CLI 组装；真实
  `DesktopEnv`/VM 仅由 Stage 5 脚本在专用环境启动；
- Qwen `strict_json` 已统一为固定 `calls[]` 协议；真实 API 集成已通过，但返回矩阵仍有偶发格式偏离；
- fake 契约不等于真实模型成功率；Stage 5 已有单任务真实 API/OSWorld 证据，正式批量比较须等 G0 冻结后按当前入口运行。

## 环境

- Node.js 22.13 或更高版本（pnpm 11 的最低运行版本）；
- pnpm 11.19.0；
- Windows、macOS、Linux 均可参与代码开发；
- 真实 CUA 探针需要对应平台的原生权限和桌面会话。

依赖只安装在本仓库的 workspace 中，不修改其他 OpenClaw 或 LightSpeaker 环境。

## 安装与检查

从 GitHub 获取仓库后，依赖会安装在本仓库的 pnpm workspace 中，不会改动其他项目的
Node.js、OpenClaw 或 LightSpeaker 环境。推荐使用仓库声明的 pnpm 版本：

```text
git clone https://github.com/wszkxlllll/Computer-Harness.git
cd Computer-Harness
corepack enable
corepack install --global pnpm@11.19.0
pnpm install --frozen-lockfile
```

安装前先确认版本：

```text
node --version
corepack --version
pnpm --version
```

`node --version` 应为 `v22.13.0` 或更高，`pnpm --version` 应为 `11.19.0`。
如果 Node 自带的 Corepack 过旧或无法启动，可在升级 Node 后执行
`npm install --global corepack@latest`，再重新执行 `corepack enable` 和
`corepack install --global pnpm@11.19.0`。不要在 Node 18 上强行运行 pnpm 11；如必须使用
Node 18，需要另行固定 pnpm 10 并重新验证仓库，不能混用本 README 的 pnpm 11 lockfile 流程。

`pnpm install` 会安装 `@computer-harness/computer-cua` 所需的
`@trycua/cua-driver@0.22.2` 及当前平台的原生 Node 绑定。可以用下面的命令确认 CUA
依赖已经进入对应 workspace package：

```text
pnpm --filter @computer-harness/computer-cua list @trycua/cua-driver --depth 0
pnpm --filter @computer-harness/cli build
pnpm run typecheck
pnpm test
```

### Windows PowerShell 的 `.ps1` shim

pnpm 在 Windows 下会同时生成 `.cmd` 和 `.ps1` wrapper。`.ps1` 文件可能同时包含
Windows 分支和 POSIX/WSL 分支，因此看到 `/mnt/e/...` 这一行本身不代表损坏；原生
PowerShell 会在 `$IsWindows -eq $true` 时走 Windows 分支。可以这样检查当前 shell 和入口：

```text
$IsWindows
where.exe node
where.exe pnpm.*
pnpm --version
```

原生 PowerShell 中 `$IsWindows` 应为 `True`，`where.exe pnpm.*` 不应指向 WSL/Git Bash
脚本。如果 Windows 分支的实际路径仍是 `/mnt/...`，说明依赖曾在 WSL/Unix shell 中生成，
或当前 PATH 混用了另一套 pnpm。请关闭 WSL/Git Bash 终端，在仓库根目录的原生 PowerShell
中仅清理本仓库的 `node_modules` 后重新安装（不要删除 `pnpm-lock.yaml`）：

```text
Remove-Item -LiteralPath .\node_modules -Recurse -Force
pnpm.cmd install --frozen-lockfile
```

如果 PowerShell 的执行策略阻止 `.ps1`，可暂时使用 `pnpm.cmd` 执行所有 pnpm 命令；这与
路径转换问题是两件独立的事。重新安装后再运行 `pnpm --filter @computer-harness/cli build`、
`pnpm run typecheck` 和 `pnpm test`。

### 环境变量

真实模型运行需要本地 `.env`（不要提交到 Git）。CLI 会在 `--env-file` 指定的文件中读取：

```dotenv
# GLM-5.3-Flash
ZHIPUAI_API_KEY=replace-with-your-key
# 可选：兼容 OpenAI 协议的自定义端点
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions
# 可选：GLM thinking 档位；默认 enabled，可用 disabled 做延迟对照
GLM_THINKING=enabled

# Qwen3.8-Flash
DASHSCOPE_API_KEY=replace-with-your-key
# 可选：工作空间或自定义端点，未设置时使用公共 compatible-mode 端点
DASHSCOPE_WORKSPACE_ID=replace-with-your-workspace-id
# 与 WORKSPACE_ID 二选一；同时设置时以 BASE_URL 为准
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

只需要测试 fake provider、协议或类型检查时不需要 API key。API key 只从进程环境或
`--env-file` 读取，轨迹和 `summary.json` 不会写入密钥。

### CUA 依赖与 daemon 的边界

仓库安装的是 CUA 的 TypeScript/Node 客户端和平台绑定；`@computer-harness/computer-cua`
是连接层，不会自动启动 CUA daemon，也不包含可直接分发的 `cua-driver` 可执行文件。
因此真实桌面运行还需要单独准备与启动官方 CUA daemon，并把同一个私有 socket 传给 CLI：

```text
# 在已经准备好的隔离桌面上启动 daemon（示例；替换为实际二进制路径）
<path-to-cua-driver> serve --socket "<private-socket>" --no-overlay

# 在另一个终端运行 Harness
pnpm --filter @computer-harness/cli build
pnpm --filter @computer-harness/cli start -- --goal "click the input and type Harness" --model glm-5.3-flash --cua-socket "<private-socket>" --output "runs/live-glm" --env-file ".env"
```

Planning、Memory、Batch 和 Context 策略均在同一 CLI/Registry 上显式选择；省略对应参数即关闭扩展或使用 raw baseline：

```text
pnpm --filter @computer-harness/cli start -- --goal "create and complete a plan" --model glm-5.3-flash --cua-socket "<private-socket>" --planning --output "runs/live-glm-planning" --env-file ".env"
pnpm --filter @computer-harness/cli start -- --goal "edit the active field" --model glm-5.3-flash --cua-socket "<private-socket>" --batching same-control-input-v1 --context-mode recent --memory facts --output "runs/live-glm-extensions" --env-file ".env"
```

Qwen 运行必须显式选择坐标单位；严格 JSON 实验建议同时关闭 thinking：

```text
pnpm --filter @computer-harness/cli start -- --goal "click the input and type Harness" --model qwen3.8-flash --cua-socket "<private-socket>" --qwen-coordinate-mode normalized_1000 --qwen-thinking disabled --qwen-output-mode strict_json --output "runs/live-qwen" --env-file ".env"
```

Windows named pipe、macOS/Linux socket 路径必须与 daemon 完全一致。daemon 的安装、路径和
桌面权限属于运行环境准备，不由 `pnpm install` 或本仓库自动完成；没有 daemon 时仍可运行
类型检查、单元测试和 fake/静态 API 探针。

## 本地 CUA CLI（隔离真实运行）

CLI 只从环境变量读取密钥，并把完整 Event 与截图资产写入指定输出目录。需要一个已经运行的
CUA daemon socket；不会自动启动 daemon，也不会把 fixture 结果写成模型结果。`summary.json` 同时展示
实际 Computer session 的 backend、viewport 与 capabilities，便于确认运行时能力。

```text
pnpm --filter @computer-harness/cli build
pnpm --filter @computer-harness/cli start -- --goal "click the input and type Harness" --model glm-5.3-flash --cua-socket "<CUA socket>" --output "runs/stage4-glm53" --env-file ".env"
# 需要终端回答时才追加：--interactive
```

允许的 `--model` 值为 `glm-5.3-flash` 和 `qwen3.8-flash`。GLM 使用
`ZHIPUAI_API_KEY`，Qwen 使用
`DASHSCOPE_API_KEY`；Qwen 若未提供 `DASHSCOPE_BASE_URL/ENDPOINT`，会由
`DASHSCOPE_WORKSPACE_ID` 生成已验证的 Workspace endpoint，否则使用公共 compatible-mode endpoint。
可用 `GLM_BASE_URL` 或 `DASHSCOPE_BASE_URL` 覆盖端点；GLM 可用进程级
`GLM_THINKING=disabled|enabled` 做 thinking 对照。可选
`--max-steps`、`--max-model-requests`、`--fixture-result`、`--batching`、`--memory`、`--planning`、`--context-mode`、`--context-max-events`、`--context-max-tokens` 和
`--screenshot-dir` 用于隔离实验。Qwen 还支持
`--qwen-output-mode native_tools|strict_json`；默认是 `strict_json`，
`native_tools` 仅用于协议对照或兼容性回归。Qwen 还必须设置
`--qwen-coordinate-mode normalized_1000|actual_pixels`。

Stage 5 OSWorld 路径由外层 runner 先调用 Bridge 的 `environment.reset`，再把返回的 instruction
交给同一个 CLI。无模型的 Gate 2 连接测试命令和 Python 环境要求见
[`integrations/osworld/README.md`](./integrations/osworld/README.md)；CLI 只需指定：

OSWorld 的 VMware 虚拟机和快照是实验外部 artifact，不会随 Git 仓库下载。队友若要复现实验，必须获取完整 VM
目录及快照 manifest，或自行创建等价的 1920×1080 基线快照；不能只复制 `.vmx` 或填写一个不存在的快照名。
完整的获取、校准、Gate 2 和模型运行步骤见
[`docs/stage-5-osworld-reproducibility.md`](./docs/stage-5-osworld-reproducibility.md)。

```text
pnpm --filter @computer-harness/cli build
pnpm --filter @computer-harness/cli start -- --goal "<reset 返回的 instruction>" --model glm-5.3-flash --computer osworld --osworld-bridge "http://127.0.0.1:<port>" --output "runs/stage5-osworld" --env-file ".env"
```

## 阶段 0：CUA 安全探针

默认只读取屏幕，不执行鼠标或键盘输入：

```text
pnpm probe:cua
```

输出位于 `spikes/cua-driver/runs/<session>/`，其中可能包含当前桌面截图，
该目录已加入 `.gitignore`，不得提交或上传隐私截图。

只有在准备好专门测试桌面后，才显式执行输入探针：

```text
pnpm --filter @computer-harness/cua-driver-spike probe -- --allow-input --click-x 300 --click-y 200
pnpm --filter @computer-harness/cua-driver-spike probe -- --allow-input --type "probe text"
```

这两个命令不是默认测试，也不会自动判断点击是否符合用户目标。它们只验证
Driver 的底层输入和前后观察链路。

## 代码边界

```text
packages/protocol       公共运行协议，不依赖 CUA 或 Provider
packages/trajectory     Event 落盘、资产引用和 Snapshot 投影
packages/runtime        RunController、Policy、Tool Registry 和 GUI Action 路由
packages/context        默认时序 Context 编译器
packages/memory         Run 内 Memory Store 与 Memory 工具
packages/provider-glm   GLM-5.3 profile
packages/provider-qwen  Qwen3.8-Flash Adapter
packages/computer-cua   trycua/cua-driver 适配器
packages/computer-osworld OSWorld DesktopEnv Bridge 适配器
apps/cli                组合依赖、运行展示和轨迹输出
spikes/cua-driver       可删除的底层 CUA 探针
```

每个包必须有当前生产者、消费者和测试，不为未来能力提前加入空接口。当前首版已包含可关闭的
Memory、Context 和受限 Batch；Verifier、RL、后台 Job、Subagent、Dashboard 或第三个 Provider 仍未实现。GLM 使用原生 Function Calling；
Qwen3.8 默认使用固定 `calls[]` 的 strict-json，并保留 native-tools 作为兼容性对照。两条路径都从本轮
ToolRegistry 投影工具；strict-json 由紧凑 Catalog 提供工具语义，并以动态工具名枚举约束 wire envelope。
Qwen3.8 在 Adapter 边界使用 canonical 的 click/scroll/drag/wait 参数和显式坐标模式；Schema
和 Parser 都不会让未知工具或缺失字段进入 Runtime。Qwen 官方 text `computer_use` 协议仅作为历史兼容错误检测，
不是当前生产请求格式。

## 施工顺序

```text
CUA 探针与平台事实
        ↓
Protocol + EventWriter + Reducer
        ↓
FakeProvider/FakeComputer + RunController（Stage 2 已完成）
        ↓
CUA 能力矩阵与协议决策（Stage 3 已关闭）
        ↓
S4-0 Context/Asset/预算合同
        ↓
S4-1 canonical Computer Tools
        ↓
S4-2 GLM/Qwen Adapter
        ↓
S4-3 CLI 与隔离真实短任务
        ↓
S5-0 OSWorld Bridge/Computer 合同
        ↓
S5-1 OSWorld 无模型 Gate 2 与单题门
        ↓
Stage 6 统一 flat 协议、集成验收与模块消融
```

文档先读 [docs/DOCS-INDEX.md](./docs/DOCS-INDEX.md)。它区分当前执行、长期设计、历史证据和已废弃路线；新增或修改文档遵守 [开发文档规范](./docs/development-documentation-standard.md)。详细协议、状态机、失败语义和验收门槛见：

- `docs/stage-6-convergence-and-start-state-2026-09-15.md`
- `docs/multimodal-gui-agent-harness-product-plan.md`
- `docs/DOCS-INDEX.md`（当前入口和历史文档边界）

## 安全与隐私

- API Key 使用环境变量或本地 Secret 管理，不写入 Event；
- 截图只保存在本地 ignored 目录；
- 未确认的 GUI 副作用不能自动重复执行；
- Event 中的 `action.execution.started` 缺少终态时表示 `outcome_unknown`，
  恢复默认先重新观察。

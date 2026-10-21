# Stage 5 OSWorld 可复现实验说明

本说明定义如何在另一台机器上复现 OSWorld Bridge、无模型 Gate 2 和模型任务实验。

## 先明确：VMware 快照不在 Git 仓库中

Git 仓库只保存 Harness、Bridge、runner、任务清单和实验文档，不保存 OSWorld 虚拟机、虚拟磁盘、VMware 快照、截图或 API Key。

因此，队友必须二选一：

1. 从团队共享的 VM artifact 获取完整虚拟机目录（`.vmx`、所有 `.vmdk`、`.nvram`、快照增量盘和相关描述文件），并确认快照清单中存在指定快照；
2. 按 OSWorld 官方文档自行准备等价 Ubuntu 环境，在固定 OSWorld commit、应用集合和显示设置后创建自己的基线快照。

只复制 `.vmx` 或只复制快照名称不能恢复快照。不能把任务 JSON 中的 `snapshot` 字段当作 VMware 快照名称，也不要使用已经污染的 `init_state`。

## 当前实验基线

- Harness：当前 Git commit；
- OSWorld：`fc31a9049664292fcb35d6e501ee1dc839f2cf6d`；
- VMware：Workstation/`vmrun`；
- 推荐的干净显示校准快照：`osworld_initial_1920x1080_clean_r4_20260906`；
- 旧原始快照：`osworld_initial_20260831`。它用于历史对照，已观察到部分任务会出现实际 guest display 漂移，不作为当前截图一致性实验的默认快照；
- `osworld_initial_1920x1080_fixed_20260906`、`fixed_r2` 和 `clean_r3` 已删除：前者会阻塞 reset，后两者分别存在显示/应用恢复状态问题。

`clean_r4` 已通过无模型 reset/observe/wait/evaluate/cleanup Gate 2，截图为 1920×1080，且 Writer 任务不会再弹出 LibreOffice 文档恢复窗口。正式批量比较仍需保持同一快照、commit 和预算。

## 队友交付 VM 时必须附带的 manifest

共享 VM artifact 时，请同时提供一份不含密钥的文本 manifest：

```text
vmx=<absolute path or artifact-relative path>
osworld_commit=fc31a9049664292fcb35d6e501ee1dc839f2cf6d
snapshot=osworld_initial_1920x1080_clean_r4_20260906
guest_display=1920x1080
host_backend=vmware-workstation
```

并在发送前验证：

```powershell
& "<vmrun.exe>" -T ws listSnapshots "<Ubuntu.vmx>"
```

输出必须包含 manifest 中的 `snapshot`。VM 运行期间不要在 GUI 中手动调整窗口缩放或 guest display；每个任务由 runner 从该快照 reset。

## 每台机器的准备步骤

## 平台支持边界

| 宿主平台 | Harness 构建/单元测试 | OSWorld 实验 | 当前要求 |
|---|---|---|---|
| Windows 11 | 支持，已验证 | 支持，已验证 | VMware Workstation、`vmrun.exe`、完整 VM artifact |
| macOS | 代码层可支持 | 条件支持，需单独预检 | VMware Fusion/兼容 `vmrun`、可启动的 VMX/磁盘链、屏幕与辅助权限 |
| Linux | 代码层可支持 | 条件支持，需单独预检 | VMware Workstation/兼容 `vmrun`、可启动的 VMX/磁盘链、X/Wayland 与虚拟化权限 |

这里的“代码层可支持”只表示 Node/TypeScript Harness、Python Bridge 和测试可以在该平台运行；不表示当前 OSWorld runner 已经为每个平台自动发现 VMware、转换路径或处理权限。macOS/Linux 队友必须先通过无模型 Gate 2，再运行模型任务。当前 runner 不直接支持 VirtualBox、libvirt 或 Docker 作为 VMware 的无修改替代品。

### 1. 准备代码和依赖

```text
git clone <Computer-Harness repository>
cd Computer-Harness
git checkout <experiment commit>
pnpm install --frozen-lockfile
pnpm --filter @computer-harness/cli build
```

还需要安装：

- Node.js `>=22.13.0`；
- pnpm `11.19.0`（仓库 `package.json` 已声明）；
- Git；
- Python 3.12 左右的 OSWorld 独立环境；
- 对应宿主平台的 VMware Workstation/Fusion 与 `vmrun`；
- Windows/macOS/Linux 上允许 VMware、虚拟机窗口和屏幕捕获的系统权限。

`.env` 只在每个人本机创建，至少包含实际使用 Provider 的 API Key。不要通过聊天、Git 或 VM artifact 共享 `.env`。

另外准备 OSWorld checkout，并固定到上面的 commit。使用 OSWorld 自己的 Python 环境，不要让 TypeScript 安装过程替代它：

```text
<OSWorld Python> -c "from desktop_env.desktop_env import DesktopEnv; print(DesktopEnv.__name__)"
```

### 2. 准备 VM / 快照

优先使用团队共享的完整 VM artifact。若自行创建，必须按照 OSWorld 官方环境说明安装系统和应用，设置 guest 实际显示为 1920×1080，关闭自动适配/自动缩放，然后关机并创建快照。创建后先做无模型 Gate 2，不要直接运行模型。

队友拿到 VM artifact 后，不要把其中的绝对路径原样复制到命令中；先替换为本机 VMX、Python 和 `vmrun` 路径。macOS/Linux 的 `vmrun` 文件名可能不是 `vmrun.exe`，但参数语义必须能完成 `listSnapshots`、`revertToSnapshot`、`start`、`stop` 和 guest 程序调用。

### 3. 运行无模型 Gate 2

```text
node scripts/stage5-osworld/gate2-computer.mjs --osworld-root "<OSWorld checkout>" --path-to-vm "<Ubuntu.vmx>" --python "<OSWorld Python>" --vmrun-path "<vmrun.exe>" --snapshot-name "osworld_initial_1920x1080_clean_r4_20260906" --task-id "<frozen task id>" --action wait --duration-ms 100 --output "runs/gate2-<name>"
```

只有在以下条件全部满足时，才进入模型任务：health、reset、observe、wait、evaluate、close 成功，且初始/动作后截图的实际尺寸均为 1920×1080。

### 4. 运行模型任务

GLM：

```text
node scripts/stage5-osworld/run-task.mjs --osworld-root "<OSWorld checkout>" --path-to-vm "<Ubuntu.vmx>" --snapshot-name "osworld_initial_1920x1080_clean_r4_20260906" --task-id "<frozen task id>" --model glm-5.3-flash --max-steps 50 --max-model-requests 50 --python "<OSWorld Python>" --vmrun-path "<vmrun.exe>" --env-file ".env" --output "runs/osworld-glm-<task>"
```

Qwen：

```text
node scripts/stage5-osworld/run-task.mjs --osworld-root "<OSWorld checkout>" --path-to-vm "<Ubuntu.vmx>" --snapshot-name "osworld_initial_1920x1080_clean_r4_20260906" --task-id "<frozen task id>" --model qwen3.8-flash --qwen-coordinate-mode normalized_1000 --qwen-thinking disabled --qwen-output-mode strict_json --max-steps 50 --max-model-requests 50 --python "<OSWorld Python>" --vmrun-path "<vmrun.exe>" --env-file ".env" --output "runs/osworld-qwen-<task>"
```

每个实验必须使用独立输出目录。提交时只提交脱敏的 `summary.json`、`runner.json` 和必要的聚合结果，不提交 VM、截图、`provider-exchanges.jsonl` 原始请求、API Key 或包含桌面隐私的轨迹。

## 常见错误

- `snapshot not found`：队友没有导入完整 VM，或 manifest 中的快照名与本机不同；先修复环境，不要改 runner 默认值。
- `SCREENSHOT_VIEWPORT_CHANGED` / `screenshot ... does not match session viewport`：guest 实际显示发生漂移。停止模型实验，重新锁定 guest display 并从干净快照重做 Gate 2。
- `DesktopEnv` import 失败：OSWorld Python 环境不完整或 commit 不一致。
- `score=0`：不能单独说明模型失败；先查看 `runtimeOutcome`、Bridge 错误、截图尺寸和 evaluator 结果。

## 官方参考

- OSWorld server screen resolution：[官方说明](https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/server/README.md#screen-resolution)
- OSWorld server screenshot path：[官方源码](https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/server/main.py)
- 已知显示尺寸漂移问题：[OSWorld Issue #317](https://github.com/xlang-ai/OSWorld/issues/317)

# OSWorld Bridge

> 可复现实验入口见[`docs/stage-5-osworld-reproducibility.md`](../../docs/stage-5-osworld-reproducibility.md)。特别注意：VMware 快照不在 Git 仓库中，队友必须获取完整 VM artifact 或自行创建等价快照；只拿到 `.vmx` 或快照名称是不够的。

当前真实 VM 路径已在 Windows 11 + VMware Workstation 上验证。macOS/Linux 可以运行 Harness 代码和测试；要运行同一 OSWorld VM 实验，还必须先用本机 VMware/`vmrun` 通过无模型 Gate 2，不能把 Windows 的绝对路径或 `vmrun.exe` 路径直接照搬。

`bridge.py` is the only process in this repository that owns an OSWorld
`DesktopEnv`. It exposes a loopback JSON RPC endpoint at `POST /rpc` with the
following methods:

```text
health
environment.reset       {"taskId":"..."}
computer.describe
computer.observe
computer.execute        {"action": { ...typed action... }}
environment.evaluate
environment.close
```

The Gate 2 script writes `gate2-summary.json`, `initial.png`, `post-action.png`, and
`reset-after-evaluate.png`
under the selected output directory when those observations are reached.

The bridge reads the task JSON and evaluator inside the OSWorld process. It
returns only the task instruction, screenshot metadata/bytes, typed action
receipts, and the final numeric evaluation; evaluator definitions are never
sent to the model.

The bridge binds to `127.0.0.1` by default. If authentication is needed, set
`OSWORLD_BRIDGE_TOKEN` in the bridge and client environments. The token is not
accepted as a command-line argument and must not be written to a trajectory.
The client uses separate defaults: 30 seconds for computer RPCs and 300 seconds
for environment reset/evaluate/close operations.

After the workspace has been built, the no-model Gate 2 entrypoint is below. Commands are written on one line so they can be
pasted into PowerShell, bash, or zsh without shell-specific continuation characters:

```text
node scripts/stage5-osworld/gate2-computer.mjs --osworld-root "<OSWorld checkout>" --path-to-vm "<VMX path>" --python "<OSWorld Python executable>" --vmrun-path "<vmrun executable>" --snapshot-name "<verified VMware snapshot>" --task-id "<frozen task id>" --action wait --duration-ms 100 --output "<run output>"
```

Use `--action click --x <pixel-x> --y <pixel-y>` only after selecting a
known-safe, reversible target in the dedicated OSWorld VM. This command does
not invoke a model. A real task run can use the CLI backend directly after the
runner has called `environment.reset`:

```text
node apps/cli/dist/index.js --goal "<instruction returned by reset>" --model glm-5.3-flash --computer osworld --osworld-bridge "http://127.0.0.1:<port>" --output "<run output>" --env-file ".env"
```

The Python environment and VM are intentionally not installed or started by
the TypeScript build.

Before starting a bridge, prepare the OSWorld checkout and its Python
environment according to the upstream OSWorld instructions, then verify that
the selected interpreter can import `DesktopEnv`:

```text
<OSWorld Python executable> -c "from desktop_env.desktop_env import DesktopEnv; print(DesktopEnv.__name__)"
```

Build the TypeScript workspace before using either the Gate 2 script or the
model-backed CLI:

```text
pnpm install --frozen-lockfile
pnpm --filter @computer-harness/cli build
```

The Python-side contract can be checked without OSWorld dependencies or a VM:

```text
python -m unittest integrations.osworld.test_bridge -v
```

Before a model run, verify the local VM snapshot and guest display. The current calibrated
experiment name is `osworld_initial_1920x1080_clean_r4_20260906`; it is a local VMware
artifact, not a repository file. The VM must be powered off or controlled only by the runner,
and the guest must report an actual 1920x1080 display. If a run reports
`SCREENSHOT_VIEWPORT_CHANGED`, stop the model run and repair the VM baseline first.

For a model-backed task, use the runner so reset/evaluate remain outside the
Harness Run:

```text
node scripts/stage5-osworld/run-task.mjs --osworld-root "<OSWorld checkout>" --path-to-vm "<VMX path>" --python "<OSWorld Python executable>" --vmrun-path "<vmrun executable>" --snapshot-name "<verified VMware snapshot>" --task-id "<frozen task id>" --model glm-5.3-flash --env-file "<local secrets file>" --output "<run output>"
```

Add `--planning` for the Planning/Plan Context arm. Without it, the same
runner uses the Computer + Control baseline; both arms share the same
infrastructure, budgets and Control definitions.

```text
node scripts/stage5-osworld/run-task.mjs --osworld-root "<OSWorld checkout>" --path-to-vm "<VMX path>" --python "<OSWorld Python executable>" --vmrun-path "<vmrun executable>" --snapshot-name "<verified VMware snapshot>" --task-id "<frozen task id>" --model glm-5.3-flash --planning --env-file "<local secrets file>" --output "<run output>"
```

Qwen 任务需要显式坐标和输出协议；建议在完成 no-model Gate 2 后再运行：

```text
node scripts/stage5-osworld/run-task.mjs --osworld-root "<OSWorld checkout>" --path-to-vm "<VMX path>" --python "<OSWorld Python executable>" --vmrun-path "<vmrun executable>" --snapshot-name "<verified VMware snapshot>" --task-id "<frozen task id>" --model qwen3.8-flash --qwen-coordinate-mode normalized_1000 --qwen-thinking disabled --qwen-output-mode strict_json --env-file "<local secrets file>" --output "<run output>"
```

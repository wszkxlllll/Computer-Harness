# Stage 4-B：OSWorld 环境与 Harness 迁移

状态：当前执行入口（2026-09-02）

本路线负责维护一套可复现的 OSWorld 官方环境、评分和 reset，并研究如何把 Harness 迁移到
OSWorld 的原生控制接口。OSWorld 不要求客体安装 CUA；本地 Windows CUA 只属于 Stage 4-A。

## 已确认事实

- 独立环境位于 `E:\OSWorldLab`，源码固定在提交
  `fc31a9049664292fcb35d6e501ee1dc839f2cf6d`（如实际记录不同，以结果证据为准）。
- 使用独立 Python 环境 `env\osworld-py312`，不修改 Harness 的 Node/pnpm 或 base Python。
- 专用 VMware Ubuntu VM：4GB RAM、4 vCPU、NAT；不要复用或修改 `dase_lab`。
- Guest Server 曾以 `192.168.5.129:5000` 连通；`/screenshot` 返回 1920×1080 PNG，`/execute` 返回成功。
  IP 由 VMware DHCP 分配，重启后必须重新查询。
- marker evaluator 已完成负例 0.0、正例 1.0、reset 后 0.0。
- 官方 Chrome 原题 `030eeff7-b492-4218-b312-701ec99ee0cc` 已完成真实 GUI 正/负/reset 校准。
- 官方固定版本包含约 369 条任务、10 个应用域；任务 JSON 的 `instruction` 给操作者看，`config` 和
  `evaluator` 是环境/评分定义，不能泄露给模型作为答案。
- 以上是 OSWorld 环境和评分通道通过，不是 Harness 已完成 OSWorld 端到端任务。

## 关键基础设施

OSWorld 侧的核心入口：

- `desktop_env/desktop_env.py`：VM 生命周期、reset、截图、动作和 evaluator；
- `evaluation_examples/examples/<domain>/<task-id>.json`：任务指令、初始化配置和评分器；
- `quickstart.py`、`run.py`、`lib_run_single.py`：官方运行入口。

本机 `E:\OSWorldLab\results` 下的 `official-chrome-calibration.py`、`run_scoring_calibration.py` 等是本次
校准辅助脚本，不是 OSWorld 官方源码，也不是 Harness 生产代码；它们不应复制成新的通用评分器。

## 当前下一步：B4 Harness 分离与迁移探索

只做只读源码核对和小范围接口验证，不调用模型、不安装客体 CUA、不直接开发生产 Adapter：

1. 确定 Harness 运行在宿主、客体，还是宿主 Python 控制端 + TypeScript Runtime 的组合；比较路径、延迟、
   网络和安全边界。
2. 将 Harness 的 `ComputerSession`、`ObservationFrame`、`ActionIntent`、`ActionReceipt`、capabilities、
   Abort/断连/reset 和 Trajectory 逐项映射到 OSWorld `DesktopEnv`；每项写明源码生产者、消费者和未验证处。
3. 保持 Provider/Context/Tool/Trajectory 与 Computer backend 解耦；不要为了 OSWorld 复制一套 Runtime。
4. 给出 Stage 5 的最小改动清单、通信方式（HTTP/进程/队列）、事件落盘边界、任务评分接入点和回归门槛。
5. B4 方案通过后，再另开实现 PR；本文件不把“接口映射完成”写成“模型任务成功”。

## 环境操作要求

- 所有操作只针对专用 OSWorld VM；不停止、不回滚、不删除 `dase_lab`。
- 下载、解压、VM 启停与 A 的真实桌面 Run 错峰；不要让 VMware 窗口抢宿主焦点。
- reset 只在用户确认的专用快照上执行；每次评分前后保留任务 ID、初态、分数和 reset 证据。
- 不把宿主 `.env`、个人文件、隐私截图或模型凭据复制进 guest 或 Git。
- 不用模型结果反推 evaluator；正/负校准必须使用确定状态，并区分 GUI 操作、评分调用和 reset。
- 所有路径都应参数化；文档中的 `E:\OSWorldLab` 只是已验证环境，不是队友必须使用的固定路径。

## 关键命令

以下命令只适用于已确认的专用 VM；执行前将路径替换为实际环境：

```powershell
$OSW = "E:\OSWorldLab"
$VMX = "$OSW\vms\OSWorld-Ubuntu\Ubuntu.vmx"
$VMRUN = "E:\VMware\VMware Workstation\vmrun.exe"
$PY = "$OSW\env\osworld-py312\python.exe"

& $VMRUN -T ws start $VMX nogui
& $VMRUN -T ws list
& $VMRUN -T ws getGuestIPAddress $VMX

$GUEST_IP = "<vmrun 返回的 IP>"
curl.exe --noproxy "*" --fail --silent --show-error `
  "http://$GUEST_IP`:5000/screenshot" -o "$OSW\results\guest-check.png"
```

停止专用 VM：

```powershell
& $VMRUN -T ws stop $VMX soft
```

评分和 reset 必须使用 OSWorld 官方 `DesktopEnv` 入口及已确认的任务配置；校准辅助脚本的命令和结果
保存在环境结果目录，不在本仓库维护第二套任务逻辑。

## 交付格式

B4 交付一份脱敏报告，至少包含：源码提交和环境版本、部署布局选择、OSWorld 原生控制接口证据、Harness
对象映射、未验证项、通信/事件/评分边界、Stage 5 实施顺序、回归门槛和清理方式。若需要管理员操作、
系统重启、额外下载或额外支出，集中列出后再执行。

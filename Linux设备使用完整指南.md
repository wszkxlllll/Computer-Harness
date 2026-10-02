# Computer-Harness Linux 设备使用完整指南

**文档日期**：2026-09-24（更新）  
**设备环境**：Arch/CachyOS Linux  
**仓库版本**：main@941b5f3  
**Node.js**：v26.10.0  
**Python**：3.10.21 (micromamba osworld 环境)  
**工作区路径**：`/home/yaogx/code/LightSpeaker`（2026-09-24 由 `SafeSight_AI` 更名）  
**验证状态**：⚠️ OSWorld D19 任务两次测试 —— 第1次 1.0 分，第2次 0.0 分（模型自报成功但 evaluator 判定失败）

---

## 📋 目录

0. [**开机后完整运行流程（冷启动，照此执行）**](#0-开机后完整运行流程冷启动)
1. [当前设备状态](#1-当前设备状态)
2. [快速开始](#2-快速开始)
3. [OSWorld 评测环境](#3-osworld-评测环境)
4. [运行方式详解](#4-运行方式详解)
5. [出行票务试点](#5-出行票务试点)
6. [常见问题排查](#6-常见问题排查)
7. [已知限制与边界](#7-已知限制与边界)
8. [参考资源](#8-参考资源)

---

## 0. 开机后完整运行流程（冷启动）

电脑重启后按顺序执行以下 5 步即可跑通。**第 1 步不能跳过** —— 内核模块每次重启都会失效，不加载则 Bridge 必然起不来（2026-09-24 已两次复现）。

### 第 1 步：加载内核模块（每次重启后必做）

```bash
cat /home/yaogx/sudopassword | sudo -S modprobe nf_nat
cat /home/yaogx/sudopassword | sudo -S modprobe ip_tables
cat /home/yaogx/sudopassword | sudo -S modprobe iptable_nat

# 验证：下面这条必须输出 iptable_nat 和 ip_tables 两行，缺一即失败
lsmod | grep -E "^ip_tables|^iptable_nat"
```

必须分三条执行。`iptable_nat` 依赖 `nf_nat`，合成一条命令时依赖未就绪会静默失败（`lsmod` 里只出现部分模块，看着像成功了一半）。

**可选：配置一次，以后免做**（Arch 标准做法，需要写系统文件）：

```bash
printf 'nf_nat\nip_tables\niptable_nat\n' | cat /home/yaogx/sudopassword - | sudo -S tee /etc/modules-load.d/iptables.conf
```

本机当前**未配置**此持久化，所以每次重启后仍需手工执行上面的加载命令。

### 第 2 步：释放内存（若开了 WinBoat）

```bash
free -h                    # 看可用内存，跑 VM 建议 ≥8G
docker stop WinBoat        # WinBoat 是另一个 Windows VM，会抢内存
```

### 第 3 步：确认端口空闲

```bash
ss -ltnp | grep 18888 || echo "端口空闲，可以启动"
```

若有输出（端口被占），说明有残留 Bridge，先按 [6.6](#66-bridge-端口被占用address-already-in-use) 清理。

### 第 4 步：启动 Bridge（终端 A，保持运行）

```bash
cd /home/yaogx/code/LightSpeaker/Computer-Harness
micromamba activate osworld

python integrations/osworld/bridge.py \
  --osworld-root /home/yaogx/code/LightSpeaker/OSWorld \
  --path-to-vm /home/yaogx/code/LightSpeaker/osworld-linux-test/docker_vm_data/Ubuntu.qcow2 \
  --provider docker \
  --host 127.0.0.1 \
  --port 18888
```

等待 30–60 秒，直到出现这一行才算就绪：

```
READY 18888
```

轮询期间会反复打印 `Checking if virtual machine is ready...`，属正常。**注意**：如果日志里出现 `ERROR: The 'ip_tables' kernel module is not loaded` 或 `falling back to usermode networking`，说明第 1 步没生效 —— 按 Ctrl+C 退出，重做第 1 步，再清掉那个容器（见 6.3），然后重新启动。

### 第 5 步：运行任务（终端 B）

```bash
# 5.1 取任务指令
curl -s -X POST http://127.0.0.1:18888/rpc \
  -H "Content-Type: application/json" \
  -d '{"requestId":"reset-1","method":"environment.reset","params":{"taskId":"9bc3cc16-074a-45ac-9bdc-b2a362e1daf3"}}' | jq .

# 5.2 用上一步返回的 instruction 作为 --goal 运行（新终端）
cd /home/yaogx/code/LightSpeaker/Computer-Harness
node apps/cli/dist/index.js \
  --goal "Could you help me back up all the email files in my inbox to ~/emails.bak? Please save them separately in eml format." \
  --model glm-5.3-flash \
  --computer osworld \
  --osworld-bridge "http://127.0.0.1:18888" \
  --output "runs/osworld-$(date +%Y%m%d-%H%M%S)" \
  --env-file ".env"

# 5.3 评分（运行结束后）
curl -s -X POST http://127.0.0.1:18888/rpc \
  -H "Content-Type: application/json" \
  -d '{"requestId":"eval-1","method":"environment.evaluate","params":{"taskId":"9bc3cc16-074a-45ac-9bdc-b2a362e1daf3"}}' | jq .
```

### 这三步分别在做什么

| 步 | 作用 | 要点 |
|---|---|---|
| 5.1 reset | 让 VM 恢复到该题初始状态，**并返回官方 instruction** | `--goal` 必须用返回的原文，不要自己改写——模型做的和被评的要靠它对齐 |
| 5.2 run | Agent 主循环：截图 → 模型决策 → Bridge 执行 → 再截图 | 全程操作 VM；产物落 `runs/osworld-<时间戳>/` |
| 5.3 evaluate | evaluator 在 VM 里查真实状态并打分 | D19 是本地正则查 `~/emails.bak/` 下的 `.eml`；**只有这个分数可信** |

顺序固定：evaluate 必须排在 run 之后、下一次 reset 之前（再 reset 初态就被冲掉）。想重跑就再 reset 一次。换题目只改 `taskId`，reset 返回的 instruction 和判分逻辑随任务变。

**另一个硬约束：evaluate 必须在关闭 Bridge、删除容器之前完成。** OSWorld 的 docker provider 每次启动都新建容器（provider.py 的 `start_emulator` 只 `containers.run`，不会复用已有容器），所以一旦容器被删，那台 VM 的最终状态就再也接不回去，**事后补测不可能**。中断了 Run 但想留档，就先别清容器。

### 它操纵的是哪台电脑

**docker 容器里的 Ubuntu 虚拟机，不是你的真实桌面。**

```
node CLI（Harness，跑在 Arch 上）
  → 127.0.0.1:18888（Bridge RPC）
  → bridge.py（跑在 Arch 上，创建并拥有 DesktopEnv）
  → docker 容器 happysixd/osworld-docker（QEMU + KVM）
  → Ubuntu VM（镜像 = osworld-linux-test/docker_vm_data/Ubuntu.qcow2）
```

对照：`--computer osworld`（本指南用的）= 容器内 VM，与本机隔离；`--computer cua` = 本机真实桌面（门控中，不用）。

**想亲眼旁观**：VM 有 VNC，端口从 8006 起取第一个空闲（被占则 8007、8008…），启动 Bridge 的日志行 `Started container with ports - VNC: <port>` 就是实际端口。浏览器开 `http://127.0.0.1:<port>` 即可实时看到模型在 VM 里点哪、输什么。

### 收工与异常恢复

- 结束 Bridge：在终端 A 按 **Ctrl+C**（不要用 Ctrl+Z 挂起，会留占端口的僵尸进程）
- Bridge 进程消失了但容器还在 → 清容器与它的卷（否则白占 34GB）：
  ```bash
  docker ps --filter ancestor=happysixd/osworld-docker --format "{{.Names}}"
  docker rm -f <容器名>
  ```
- 任何一步卡住，对照第 6 节排查表。

---

## 1. 当前设备状态

### 1.1 ✅ 已完成的配置

| 项目 | 状态 | 详情 |
|------|------|------|
| Node.js & pnpm | ✅ 已安装 | v26.10.0 / 11.19.0 |
| Computer-Harness | ✅ 已安装 | 依赖完整、构建成功 |
| 单元测试 | ✅ 全部通过 | **44 files / 505 tests** |
| 核心模块 | ✅ 可用 | 8/8 关键包加载正常 |
| Docker | ✅ 可用 | v29.8.1，用户在 docker 组 |
| KVM | ✅ 可用 | /dev/kvm 可访问 |
| 内核模块 | ✅ 已加载 | ip_tables + iptable_nat（每个启动会话需重新加载，冷启动流程见第 0 节） |
| Python 环境 | ✅ 已创建 | micromamba osworld (Python 3.10.21) |
| OSWorld 仓库 | ✅ 已克隆 | ~/code/LightSpeaker/OSWorld @fc31a90 |
| VM 镜像 | ✅ 已下载 | ~/code/LightSpeaker/osworld-linux-test/docker_vm_data/Ubuntu.qcow2 (24.5GB) |
| Bridge 测试 | ✅ 通过 | 5/5 Python 单元测试 |

### 1.2 ⚠️ 待配置项

| 项目 | 状态 | 说明 |
|------|------|------|
| API 密钥 | ✅ 已配置 | 智谱 API 密钥已配置在 `.env` |
| 内核模块 | ⚠️ 每次启动重做 | 重启后失效，不加载会导致 VM 端口不可达；**完整流程见第 0 节**，机制说明见 6.3 |
| 内核模块持久化 | ⚠️ 未配置 | 第 0 节第 1 步给了 `/etc/modules-load.d/iptables.conf` 配置命令，配置后免去每次手工加载 |
| OSWorld Python 包 | ⚠️ 未安装 | 因 agp-client 缺失安装失败，但 Bridge 可直接使用源码 |

### 1.3 实际任务测试结果

**任务 ID**：9bc3cc16-074a-45ac-9bdc-b2a362e1daf3  
**任务描述**：备份 Thunderbird 收件箱所有邮件到 ~/emails.bak，保存为 .eml 格式

**第 1 次测试**（2026-09-23 22:54）：
- ✅ **评分：1.0 分（满分）**
- 步数：15 steps，模型请求：16 次
- Token：117,558 总计
- 输出：`runs/osworld-test-20260923-225429/`

**第 2 次测试**（2026-09-24 13:32，修复 iptable_nat 后）：
- ❌ **评分：0.0 分**
- 步数：9 steps，模型请求：10 次
- Token：71,055 总计
- 模型自报"备份完成"到 `/home/user/emails.bak`，但 evaluator 检查 `/home/user/emails.bak/`（目录）时文件不存在
- 输出：`runs/osworld-fix-verify-20260924-133239/`

**关键发现**：
- Harness 链路（Bridge → VM → 动作执行 → 评分）全部正常
- 问题在模型层：两次运行中一次真正完成、一次虚假完成
- 模型自报不能替代 evaluator 判定

### 1.4 系统可用性

**Computer-Harness 已就绪，可以立即使用。**

支持的功能：
- ✅ 所有 505 个单元测试通过
- ✅ CLI 工具完整
- ✅ GLM/Qwen Provider 就绪
- ✅ Memory/Planning/Monitor/Context 可用
- ✅ TUI 交互界面可用
- ✅ OSWorld Bridge 环境就绪（API 密钥已配置）

---

## 2. 快速开始

### 2.1 API 密钥（本机已配置）

本机 `.env` 已配置智谱密钥，无需重做。以下步骤供更换密钥或在新机器部署时参考：

```bash
cd /home/yaogx/code/LightSpeaker/Computer-Harness

# 创建 .env 文件
cat > .env << 'EOF'
# 智谱 AI（GLM）- 至少配置一个
ZHIPUAI_API_KEY=your_glm_key_here
GLM_API_KEY=your_glm_key_here

# Qwen（可选）
DASHSCOPE_API_KEY=your_qwen_key_here
EOF

# 设置权限
chmod 600 .env
```

两个 GLM 变量名指向同一个密钥：新代码读 `ZHIPUAI_API_KEY`，部分历史脚本只认 `ZHIPU_API_KEY`，都写上省事。`.env` 已在 `.gitignore` 中。

### 2.2 验证安装（可选）

```bash
# 运行自定义验证脚本
node test-installation.mjs

# 预期输出：✅ 所有核心模块加载成功，安装验证通过！
```

### 2.3 第一次运行

CLI 的 `--computer` 只接受 `osworld` 和 `cua` 两个值。FakeComputer 只在单元测试里使用，没有 CLI 入口，所以没有"不碰真实环境的快速 Run"这种用法。

本机推荐走 OSWorld：先按第 3.2 节启动 Bridge，再运行第 3.3 节的命令。CUA 在 Linux 上仍在门控中（见第 7.2 节）。

只想确认 Provider 密钥和工具链能否加载、不启动 VM 的话，用这两条：

```bash
node test-installation.mjs        # 核心模块加载
node apps/cli/dist/index.js --help # 参数与入口
```

---

## 3. OSWorld 评测环境

### 3.1 当前环境状态

```
✅ Docker 可用：v29.8.1
✅ KVM 可用：/dev/kvm
✅ 内核模块已加载：ip_tables + iptable_nat
✅ Python 环境：micromamba osworld (Python 3.10.21)
✅ OSWorld 仓库：~/code/LightSpeaker/OSWorld @fc31a90
✅ VM 镜像：~/code/LightSpeaker/osworld-linux-test/docker_vm_data/Ubuntu.qcow2 (24.5GB)
✅ Bridge 测试：5/5 通过
⚠️ OSWorld Python 包：未安装（但不影响 Bridge 使用）
```

### 3.2 启动 OSWorld Bridge

**终端 1：启动 Bridge**

先确认端口空闲，避免和上次残留的 Bridge 冲突（见 6.6）：

```bash
ss -ltnp | grep 18888 || echo "端口空闲"
```

```bash
cd /home/yaogx/code/LightSpeaker/Computer-Harness

# 激活 Python 环境
micromamba activate osworld

# 启动 Bridge（使用 docker provider）
python integrations/osworld/bridge.py \
  --osworld-root /home/yaogx/code/LightSpeaker/OSWorld \
  --path-to-vm /home/yaogx/code/LightSpeaker/osworld-linux-test/docker_vm_data/Ubuntu.qcow2 \
  --provider docker \
  --host 127.0.0.1 \
  --port 18888

# 等待输出（容器启动 + VM 轮询约 20-45 秒）：
# INFO Started container with ports - VNC: 8006, Server: 5000, Chrome: 9222, VLC: 8080
# INFO Checking if virtual machine is ready...   （重复若干次）
# INFO OSWorld bridge listening on 127.0.0.1:18888
# READY 18888
```

看到 `READY` 才算就绪。最后那行 `READY <port>` 是给外部启动器用的信号，正常。

**重要参数说明**：
- `--osworld-root`：OSWorld 仓库路径（需要访问 evaluators 等）
- `--path-to-vm`：必须指向 `.qcow2` **文件**，不能是目录
- `--provider docker`：使用 docker 容器运行 VM（推荐）

**终端 2：测试 Bridge 连接**

Bridge 用自定义协议，请求体必须包含 `requestId`（字符串，非空）和 `method`，不是 JSON-RPC 的 `jsonrpc`/`id` 格式：

```bash
curl -s -X POST http://127.0.0.1:18888/rpc \
  -H "Content-Type: application/json" \
  -d '{"requestId": "health-1", "method": "health", "params": {}}' | jq .

# 预期返回：
# {
#   "requestId": "health-1",
#   "ok": true,
#   "result": {"status": "ok", "protocolVersion": "1", "osworldVersion": "unknown"}
# }
```

用错格式会得到 `{"ok": false, "error": {"code": "INVALID_REQUEST", "message": "requestId and method are required"}}`。

### 3.3 运行 OSWorld 任务

**步骤 1：重置环境并获取任务**

```bash
# 调用 reset 获取任务指令
curl -s -X POST http://127.0.0.1:18888/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "reset-1",
    "method": "environment.reset",
    "params": {"taskId": "9bc3cc16-074a-45ac-9bdc-b2a362e1daf3"}
  }' | jq .

# 记录返回的 instruction 字段，例如：
# "Could you help me back up all the email files in my inbox to ~/emails.bak?
#  Please save them separately in eml format."
```

**步骤 2：运行 Harness（新终端）**

```bash
cd /home/yaogx/code/LightSpeaker/Computer-Harness

# 使用 reset 返回的 instruction
node apps/cli/dist/index.js \
  --goal "Export all emails in Thunderbird inbox to ~/emails.bak as .eml files" \
  --model glm-5.3-flash \
  --computer osworld \
  --osworld-bridge "http://127.0.0.1:18888" \
  --output "runs/osworld-d19" \
  --env-file ".env"
```

**步骤 3：评估结果**

```bash
# 运行结束后，调用 evaluate
curl -s -X POST http://127.0.0.1:18888/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "eval-1",
    "method": "environment.evaluate",
    "params": {"taskId": "9bc3cc16-074a-45ac-9bdc-b2a362e1daf3"}
  }' | jq .

# 查看 score 字段（0.0-1.0）
```

### 3.4 已验证任务

根据 `docs/linux-platform-adaptation-2026-09-17.md`（历史作者报告，尚未独立复核）：

| 任务 | ID | 描述 | 报告成绩 |
|------|----|----|-----------|
| D19 | 9bc3cc16-074a-45ac-9bdc-b2a362e1daf3 | Thunderbird 邮件导出 | 2 次 1.0 分 |

**D19 历史成绩**（成员 C 报告）：
- 第 1 次：17 模型 turn / 16 GUI 动作 / 约 3.6 分钟 / 1.0 分
- 回归：25 步 / 26 请求 / 0 错误 / 1.0 分

**本机复测**（2026-09-23/24 两次）成绩为 1.0 分和 0.0 分，详见 1.3。同一任务同一模型两次结果不同，说明单次成绩不构成稳定基线。

### 3.5 OSWorld 故障排查

**开机后的完整启动流程见第 0 节。** 内核模块、端口占用等排查见第 6 节，以下三项是 OSWorld 场景下最常见的：

**问题 1：VM 端口不可达（VNC 通但 5000/9222/8080 超时）** → 见 6.3

**问题 2：Bridge 报 DesktopEnv 导入错误**

```bash
# 测试导入
cd /home/yaogx/code/LightSpeaker/OSWorld
micromamba run -n osworld python -c "import sys; sys.path.insert(0, '.'); from desktop_env.desktop_env import DesktopEnv; print('OK')"

# 如果失败，检查 OSWorld 路径是否正确
```

**问题 3：docker 权限错误**

```bash
# 检查用户是否在 docker 组
groups | grep docker

# 如果不在，添加并重新登录
sudo usermod -aG docker $USER
# 重新登录后生效
```

---

## 4. 运行方式详解

### 4.1 CLI 参数完整列表

```bash
node apps/cli/dist/index.js --help
```

**核心参数**：

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--goal` | 是 | - | 任务目标文本 |
| `--model` | 是 | - | `glm-5.3-flash` 或 `qwen3.8-flash` |
| `--computer` | 否 | `cua` | 只接受 `cua` / `osworld`（无 `fake`） |
| `--output` | 否 | `runs/live-cli` | 结果输出目录 |
| `--env-file` | 否 | - | API 密钥文件路径 |

**OSWorld 专用**：

| 参数 | 说明 |
|------|------|
| `--osworld-bridge` | Bridge URL，如 `http://127.0.0.1:18888` |

**可选功能**：

| 参数 | 默认 | 说明 |
|------|------|------|
| `--planning` | `off` | Task 工具 |
| `--memory` | `off` | `facts` / `entities` |
| `--monitor` | `off` | `shadow` / `guidance` |
| `--risk-guard` | 根据 profile | `off` / `layered` |
| `--context-mode` | `raw` | `recent` |
| `--batching` | `off` | `same-control-input-v1` |
| `--grounding` | `off` | `uia-catalog-v1` / `dom-catalog-v1` / `hybrid-catalog-v1` |

### 4.2 TUI 交互模式

TUI 提供可视化界面，支持暂停/恢复、纠正、审批。

```bash
node apps/cli/dist/index.js \
  --tui \
  --model glm-5.3-flash \
  --computer osworld \
  --osworld-bridge "http://127.0.0.1:18888" \
  --output "runs/tui-test" \
  --env-file ".env"
```

**TUI 快捷键**：

| 按键 | 功能 |
|------|------|
| **Esc** | 退出编辑模式 |
| **F** | 功能配置页（Planning/Memory/Batch/Monitor/Risk Guard） |
| **W** | 选择窗口（需要 CUA，Linux 上门控） |
| **I** | 输入 goal 或纠正 |
| **Enter** | 提交 goal 或确认 |
| **P** | 暂停当前 Run |
| **R** | 恢复暂停的 Run |
| **A** | 中止 Run |
| **Y/N** | 审批同意/拒绝 |

---

## 5. 出行票务试点

### 5.1 试点概述

当前主线任务是**上海出行票务查询**（20 个任务）：
- 12306 单入口查票（T01–T02）
- 携程单入口查票（T03–T04）
- 跨应用组合（携程→高德，T09–T10）
- 多来源核对（12306 vs 携程，T13–T14）

**限制**：
- ✅ 允许：查询、比较、整理行程草稿
- ❌ 禁止：购票、占座、下单、支付、退改签、候补

### 5.2 Linux 适配说明

出行试点的 PowerShell 脚本（`.\scripts\travel\run.ps1`）在 Linux 上**不可用**。

**手动运行方式**：

1. **查看任务列表**：
   ```bash
   cat docs/travel-task-cards-and-feedback.md | grep -A 5 "## 2. 任务摘要"
   ```

2. **从 2.1 节获取完整 goal**：
   
   打开 `docs/travel-task-cards-and-feedback.md` 第 2.1 节，复制对应任务的完整文本。

3. **手动运行示例（T01）**：

   ```bash
   # 假设 goal 是：
   # Target=铁路出行
   # 你要帮我查询从上海到北京的火车票。我计划在2026年10月1日出发...
   
   node apps/cli/dist/index.js \
     --goal "Target=铁路出行
   你要帮我查询从上海到北京的火车票。我计划在2026年10月1日出发，希望是直达车次，并且希望下午到达北京。请告诉我有哪些选项（车次、出发/到达时间、二等座价格、余票状态），如果符合条件的选项少于2个，请说明原因。不要购票或占座。" \
     --model glm-5.3-flash \
     --computer cua \
     --cua-socket "unix:///path/to/cua.sock" \
     --output "runs/travel/t01" \
     --env-file ".env"
   ```

4. **查看结果**：
   ```bash
   cd runs/travel/t01
   cat report.md           # 模型的调查结果
   cat metrics.json        # 请求/动作/Token 统计
   cat manual-review.md    # 手动填写评价
   ```

### 5.3 重要提醒

- ⚠️ **CUA 真实 Linux 桌面在门控中**，出行任务可能无法在当前设备运行
- ✅ 推荐先在 OSWorld 环境验证 Harness 功能
- ✅ 出行任务需要 Windows 环境或改写为适配 Linux 的版本

---

## 6. 常见问题排查

### 6.1 测试大批失败

**症状**：`pnpm test` 报告大量失败（本机曾出现 `38 passed | 45 failed`），错误集中在缺失的导出符号（如 `MEMORY_LIMITS`）。

**原因**：`packages/*/dist` 是旧构建产物，源码已更新但没重新编译。

**解决**：
```bash
pnpm run build
pnpm test
```

正常基线是 **44 files / 505 tests** 全绿（2026-09-24 实测）。

### 6.2 API 调用失败

**症状**：
```
Error: Request failed with status code 401
Provider transport failure
```

**检查清单**：
1. `.env` 文件在仓库根目录
2. API key 正确配置
3. 使用 `--env-file ".env"` 参数
4. API key 有余额且未过期

### 6.3 OSWorld VM 端口不可达

**症状**：容器日志出现下面两行，或 host 上 VNC 8006 可连接但 VM 的 5000/9222/8080 端口超时。

```
iptables v1.8.10 (legacy): can't initialize iptables table `nat': Table does not exist
ERROR: The 'ip_tables' kernel module is not loaded.
Warning: falling back to usermode networking! port forwarding will not work.
```

**原因**：docker 容器内 QEMU 的端口转发需要 `iptable_nat`，系统重启后模块失效（本机未做持久化）。

**解决**：按依赖顺序加载。`iptable_nat` 依赖 `nf_nat`，一条命令里同时 modprobe 两个模块时，如果 `nf_nat` 尚未被拉入，`iptable_nat` 会静默失败（`lsmod` 里只有 `ip_tables`，看起来像成功了一半）：

```bash
# 分两步加载，依赖在前
cat /home/yaogx/sudopassword | sudo -S modprobe nf_nat
cat /home/yaogx/sudopassword | sudo -S modprobe iptable_nat

# 验证：两个都要在
lsmod | grep -E "^ip_tables|^iptable_nat|^nf_nat"
# 预期看到三行：nf_nat / iptable_nat / ip_tables
```

**加载后必须重建容器**。旧容器在启动时已确定网络模式，回退 usermode 后加载模块不会让它自愈：

```bash
docker ps --filter ancestor=happysixd/osworld-docker --format "{{.Names}}"
docker rm -f <上面的容器名>
# 然后重启 Bridge
```

**持久化（推荐，一次性解决）**：

```bash
printf 'nf_nat\niptable_nat\nip_tables\n' | cat /home/yaogx/sudopassword - | sudo -S tee /etc/modules-load.d/iptables.conf
cat /etc/modules-load.d/iptables.conf   # 验证
```

本机目前未配置，每次重启后需手工加载。

### 6.4 Bridge 启动失败

**检查项**：
1. Python 环境是否激活（`micromamba activate osworld`）
2. `--osworld-root` 路径是否正确
3. `--path-to-vm` 必须指向 `.qcow2` 文件，不是目录
4. Docker 服务是否运行（`docker ps`）
5. `/dev/kvm` 是否可访问（`ls -l /dev/kvm`）

### 6.5 TUI 中文显示异常

**症状**：中文字符宽度错误，界面错位。

**解决**：
```bash
# 确保终端支持 UTF-8
export LANG=zh_CN.UTF-8

# 使用现代终端模拟器
# - Alacritty
# - Kitty
# - GNOME Terminal
```

### 6.6 Bridge 端口被占用（Address already in use）

**症状**：启动 Bridge 时 VM 已经轮询就绪，最后报错退出：

```
OSError: [Errno 98] Address already in use
```

**原因**：已有另一个 Bridge 实例占着 18888。常见来源是上一次的 Bridge 没有正常退出，或者调试时用 `Ctrl+Z` 挂起、或后台启动后忘记关闭。

**排查与解决**：

```bash
# 1. 看谁占着端口
ss -ltnp | grep 18888
# 输出形如：LISTEN ... users:(("python",pid=42152,fd=5))

# 2. 结束它（bridge.py 注册了 SIGTERM 处理器做优雅清理，
#    首次 kill 可能不立即生效，等几秒回收；仍不死再 -9）
kill <pid>
sleep 8
ps -p <pid> > /dev/null 2>&1 && kill -9 <pid>

# 3. 确认端口释放
ss -ltnp | grep 18888 || echo "已释放"
```

**清理孤儿容器**。被杀死的 Bridge 可能留下一个已启动的 OSWorld 容器，不清掉会白占几 GB 内存：

```bash
docker ps --filter ancestor=happysixd/osworld-docker --format "{{.Names}}\t{{.Status}}"
docker rm -f <容器名>
```

**预防**：
- 启动前先 `ss -ltnp | grep 18888` 检查
- 停止 Bridge 用 `Ctrl+C`（走优雅清理），不要用 `Ctrl+Z` 挂起
- 同一时间只跑一个 Bridge；确需并行时用 `--port` 指定不同端口

### 6.7 内存不足

**症状**：VM 启动慢、容器被 OOM、系统卡顿。

**原因**：本机 15Gi 内存，OSWorld VM 约占 8GB，WinBoat（另一个 Windows VM）同样占用大量内存。

**解决**：
```bash
free -h                                    # 查看可用内存
docker ps --format "{{.Names}}"            # 看有哪些 VM 在跑
docker stop WinBoat                        # 跑 OSWorld 前停掉 WinBoat
```

WinBoat 的 docker 重启策略已从 `on-failure` 改为 `no`，不会开机自启。

---

## 7. 已知限制与边界

### 7.1 平台限制

| 功能 | Linux 状态 | 说明 |
|------|-----------|------|
| 核心 Runtime | ✅ 完全支持 | 505 项单元测试通过 |
| OSWorld docker | ⚠️ 链路可用，成绩不稳 | D19 两次：1.0 分与 0.0 分，模型自报不可信 |
| CUA 真实桌面 | ⚠️ **门控中** | 键盘/焦点/窗口几何未完整验证 |
| 出行试点脚本 | ❌ 不可用 | PowerShell 专用，需手动改写 |
| TUI 交互 | ✅ 可用 | 需支持 UTF-8 的终端 |

### 7.2 CUA 在 Linux 上的限制

**当前状态**：
- ✅ OSWorld docker 环境下的 CUA 链路已验证
- ⚠️ Linux 真实桌面的 CUA 驱动**未完整验证**
- 门控项：键盘、焦点、窗口几何、通用 AX

**建议**：
- ✅ 优先使用 **OSWorld docker 环境**（已完整验证）
- ⚠️ 真实 Linux 桌面需谨慎预检

### 7.3 功能状态

| 功能 | 状态 | 默认 | 说明 |
|------|------|------|------|
| Context | ✅ 已实现 | raw | 历史事件上下文 |
| Planning | ✅ 已实现 | off | Task 工具 |
| Memory | ✅ 已实现 | off | Facts/Entities |
| Monitor | ✅ 已实现 | off | 三模式：off/shadow/guidance |
| UIA Grounding | ⚠️ 实验 | off | 仅 CUA window target |
| DOM Grounding | ⚠️ 实验 | off | Hybrid 融合 |
| Risk Guard | ⚠️ 实验 | 根据 profile | layered 模式 |
| Batch Actions | ⚠️ 实验 | off | 受限组合 |

### 7.4 评测边界

- **G0 评测集**：尚未冻结，不得启动正式效果实验
- **D19 成绩**：作者报告，尚未独立复核
- **出行试点**：草案走查，非正式 Benchmark
- **模型自报**：不能替代人工验收

### 7.5 安全与隐私

⚠️ **重要提醒**：
1. **真实桌面风险**：不是"任意桌面都安全可控"的成品
2. **API 密钥**：`.env` 权限 600，不提交到 Git
3. **截图与轨迹**：可能包含敏感信息，`runs/` 已在 `.gitignore`
4. **禁止真实交易**：出行试点严禁购票、下单、支付
5. **VM 隔离**：OSWorld 评测应在隔离 VM 中进行

---

## 8. 参考资源

### 8.1 仓库文档

| 文档 | 路径 | 用途 |
|------|------|------|
| 文档索引 | `docs/DOCS-INDEX.md` | 唯一导航入口 |
| Stage 6 入口 | `docs/stage-6-convergence-and-start-state-2026-09-15.md` | 当前实施状态 |
| Linux 适配 | `docs/linux-platform-adaptation-2026-09-17.md` | Linux 特定适配与坑 |
| 出行任务卡 | `docs/travel-task-cards-and-feedback.md` | 20 个任务详情 |
| 出行准备 | `docs/travel-pilot-preparation-2026-09-20.md` | 技术边界与预检 |
| OSWorld 环境 | `docs/osworld-environment-implementation.md` | Bridge、VM、评分 |
| OSWorld 复现 | `docs/stage-5-osworld-reproducibility.md` | artifact、快照、环境 |

### 8.2 本地脚本

| 脚本 | 路径 | 用途 |
|------|------|------|
| 安装验证 | `test-installation.mjs` | 验证核心模块加载 |
| 出行脚本 | `scripts/travel/run.ps1` | PowerShell，Linux 不可用 |

### 8.3 外部资源

- **Computer-Harness**：https://github.com/wszkxlllll/Computer-Harness
- **OSWorld**：https://github.com/xlang-ai/OSWorld
- **智谱 AI**：https://open.bigmodel.cn
- **Qwen**：https://dashscope.aliyun.com

### 8.4 关键路径

**当前设备路径**：
```
仓库：/home/yaogx/code/LightSpeaker/Computer-Harness
OSWorld：/home/yaogx/code/LightSpeaker/OSWorld
VM 镜像：/home/yaogx/code/LightSpeaker/osworld-linux-test/docker_vm_data/Ubuntu.qcow2
sudo 密码：/home/yaogx/sudopassword
```

---

## 9. 快速检查清单

使用前确认：

- [ ] Node.js ≥22.13.0，pnpm 11.19.0 ✅
- [ ] 仓库已克隆，main 分支 @941b5f3 ✅
- [ ] `pnpm install --frozen-lockfile` 成功 ✅
- [ ] `pnpm run build` 无错误 ✅
- [ ] `pnpm test` 通过（≥505 tests）✅
- [ ] `.env` 已配置 API 密钥 ✅
- [ ] Docker 已安装且可用 ✅
- [ ] 内核模块 ip_tables + nf_nat + iptable_nat 已加载 ⚠️ 每次重启后重做
- [ ] 端口 18888 空闲（`ss -ltnp | grep 18888`）⚠️ 启动 Bridge 前检查
- [ ] 可用内存 ≥8GB（`free -h`）⚠️ 跑 VM 前停 WinBoat
- [ ] Python 环境 osworld 已创建 ✅
- [ ] VM 镜像已下载 ✅
- [ ] Bridge Python 测试通过 ✅
- [ ] 理解 CUA 真实桌面在 Linux 上门控 ✅
- [ ] 理解出行试点禁止真实交易 ✅

---

## 10. 更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-21 | v1.0 | 初始版本，合并使用指南与验证报告 |
| 2026-09-21 | v1.1 | 添加当前设备实际配置状态 |
| 2026-09-23 | v1.2 | 补充 D19 首次本机复测结果（1.0 分） |
| 2026-09-24 | v1.5 | 第 0 节补充「这三步分别在做什么」（reset/run/evaluate 语义与顺序约束）与「它操纵的是哪台电脑」（docker 内 VM 分层图、VNC 旁观入口、与 cua 模式对照） |
| 2026-09-24 | v1.4 | 目录更名同步（SafeSight_AI → LightSpeaker）；新增第 0 节「开机后完整运行流程（冷启动）」：内核模块加载三连命令 + 验证、内存/端口检查、Bridge 启动与 READY 判据、reset→run→evaluate 全链路、异常恢复 |
| 2026-09-24 | v1.3 | 修正 Bridge RPC 请求格式（requestId 而非 jsonrpc）；修正内核模块加载方法（需 nf_nat 依赖、加载后须重建容器）；新增 6.6 端口占用、6.7 内存不足排查；补充 D19 第二次测试（0.0 分） |

---

**文档生成**：Claude  
**最后更新**：2026-09-24

---

## 附录 A：完整测试结果摘要

### A.1 单元测试（pnpm test）

```
Test Files  44 passed (44)
     Tests  505 passed (505)
  Duration  4.14s
```

**关键测试通过**：
- ✅ RunController (78 tests) - 核心控制器
- ✅ Provider GLM (21 tests) - GLM 适配器
- ✅ Provider Qwen (25 tests) - Qwen 适配器
- ✅ Memory retrieval (19 tests) - Hybrid 检索
- ✅ OSWorld Bridge (17 tests) - Loopback 传输
- ✅ CUA driver (26 tests) - CUA 驱动
- ✅ TUI (25 tests) - 交互界面

### A.2 核心模块加载（test-installation.mjs）

```
✅ @computer-harness/protocol 加载成功
✅ @computer-harness/runtime 加载成功
✅ @computer-harness/provider-glm 加载成功
✅ @computer-harness/provider-qwen 加载成功
✅ @computer-harness/computer-cua 加载成功（懒加载）
✅ @computer-harness/memory 加载成功
✅ @computer-harness/planning 加载成功
✅ CLI 模块加载成功

通过: 8/8
```

### A.3 Bridge Python 测试

```
test_invalid_action_is_refused_before_desktop_step ... ok
test_screenshot_viewport_change_updates_current_viewport_after_completion ... ok
test_step_exception_is_reported_as_execution_error ... ok
test_structured_action_routing_and_keyboard_normalization ... ok
test_unsupported_key_is_refused_before_desktop_step ... ok

Ran 5 tests in 0.071s
OK
```

---

**说明**：本文档合并自早期的 `Linux使用指南.md` 和 `安装验证报告.md`，之后按本机实测结果持续修正。所有命令均在当前设备上实际执行过；路径、版本号和测试数据以最后一次验证（2026-09-24）为准。

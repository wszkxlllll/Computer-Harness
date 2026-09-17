# Linux 平台适配与验证证据（2026-09-17）

日期：2026-09-17
文档角色：结果
状态：历史证据
当前入口：从属于 [Stage 6 当前实施入口](./stage-6-convergence-and-start-state-2026-09-15.md)
基线：main `cf59133`（Stage 6 收敛态）；关联修复 PR #3（computer-cua 懒加载）在 rebase 至 `0e41463` 后复验
范围：Linux 宿主机运行本仓库的适配项与验证证据：依赖安装、单测、GLM 真实 API 冒烟、OSWorld docker 链路端到端。不覆盖：macOS、真实本机桌面驱动（AGENTS.md 与 Risk Guard 门控）、Qwen 真实 API 本机实测。

## 1. 结论

1. OSWorld Linux（docker provider）链路全通且可复跑：任务 D19 两次 evaluator 验证 1.0 满分（非模型自报），可扩到 G0 其余 19 个 Dev 任务。
2. 单测 166/166（含 computer-cua 5/5）与作者 Windows 报告一致；bridge Python 单测 5/5。
3. 唯一的仓库级缺陷已由 PR #3 修复：CLI 与 batch fixture 静态 import computer-cua，原生绑定缺失时非 cua 路径也在进程启动期崩溃。
4. 其余适配均为环境层，共三个坑：path_to_vm 语义、内核 iptables 模块、pnpm optional 原生包静默漏装。修法见 §3、§4。

## 2. 验证环境

- 机器：成员C Linux 开发机（Arch/CachyOS，内核 7.2.5-1-cachyos-bore，15G 内存，/dev/kvm + docker 可用）。
- 运行时：Node 24 / pnpm 11.19；micromamba `osworld` env（Python 3.10.21，torch 2.5.1 CPU 版）。
- OSWorld：checkout `fc31a90`；VM 镜像 `Ubuntu.qcow2` 24.5GB（`qemu-img check` 通过）；docker 镜像 `happysixd/osworld-docker:latest`。
- 网络：受限出口（HTTP 代理 + 镜像源），策略见 §5。

## 3. OSWorld docker 链路适配（两个坑）

### 3.1 path_to_vm 必须传 qcow2 文件，不能传目录

bridge.py 原生支持 `--provider docker`，无需改代码；但 DesktopEnv 收到显式 path_to_vm 就不再走 manager 默认文件路径（OSWorld `desktop_env.py`），docker provider 会把传入值 bind 成容器内的 `/System.qcow2`。传目录时 QEMU 无盘可引导，进程 exit 64，外层表现为 VM ready 超时。

正确传法：`--path-to-vm <绝对路径>/docker_vm_data/Ubuntu.qcow2`（指向文件）。此坑与 Linux 无关，是显式传参引入的；不传 path_to_vm 时 VM 镜像取 bridge 进程 cwd 的 `./docker_vm_data/`。

### 3.2 内核需加载 ip_tables / iptable_nat

症状：qemu-docker 容器回退 usermode 网络，VM 的 5000/9222/8080 端口在 host 全不可达，但 VNC 8006 正常（8006 是容器自身服务，不经 NAT 进 QEMU）。排查时"VNC 通而服务端口全不通"即指向 NAT 缺失。

修法：`sudo modprobe ip_tables iptable_nat`。重启后失效；持久化方案为在 `/etc/modules-load.d/` 加配置（本机未做，待用户确认）。

## 4. pnpm optional 原生包静默漏装（trycua 绑定）

- 现象：CLI 启动即 `ResolveLibPathError` / MODULE_NOT_FOUND，报错文案含 "platform not in the published matrix"，容易误导成上游没发布 Linux 绑定。
- 事实（npm registry 实测）：`@trycua/cua-driver-linux-x64-gnu` 从 0.11.0 到 0.28.2 全版本发布（含本仓库锁定的 0.22.2，另有 linux-arm64-gnu）。
- 真因：受限网络下 `pnpm install` 静默漏装该 optional 平台包——`.pnpm/@trycua+cua-driver-linux-x64-gnu@0.22.2/` 只剩空壳目录，dep 链接悬空。且事后 `pnpm install`（含 `--force`、删空壳再装）不自愈：pnpm 信任 `node_modules/.modules.yaml` 的已安装记录，不校验包目录实体。
- 排查：`ls node_modules/.pnpm/<pkg>*/node_modules/` 看包目录是否有实际文件。
- 修法（node_modules 层，不动仓库与 lockfile）：
  1. `npm pack @trycua/cua-driver-linux-x64-gnu@0.22.2` 取得 tarball；
  2. `openssl dgst -sha512 -binary <tarball> | openssl base64 -A`，与 `pnpm-lock.yaml` 中该包 integrity 逐字节对照；
  3. 解包进 `.pnpm/<pkg>@<ver>/node_modules/`（tar 内顶层 `package/` 用 `--strip-components=1` 上移一层），原悬空 dep 链接自动生效；
  4. import 冒烟验证无 warning 无报错。
- 仓库侧修复：PR #3 把 CLI 与 batch fixture 改为懒加载 computer-cua，绑定缺失只在 cua 路径报明确错误，不再误伤 osworld 路径与进程启动。
- 版本边界：cua-driver 保持 0.22.2 不升不降；0.27.0 起主包新增 `./fleet` 导出；是否升级 0.28.2 由组长决定。

## 5. 网络受限环境参考策略（本机实例，非项目要求）

- PyPI：直连与代理均不稳（频繁 IncompleteRead），走镜像站直连最稳；torch 选 CPU 版（约 190MB，避免 CUDA 版 906MB 及 3GB nvidia 依赖）。
- HuggingFace 大文件：镜像站 CDN 限速不可用；源站走代理单连接约 1MB/s。aria2 经代理 TLS 握手失败不可用；curl 分块 Range 并行 + 断点续传有效（24.5GB 约 1.5 小时）。
- 大文件不放 /tmp（本机 /tmp 为 7.7G tmpfs）；VM 与本机大内存容器互斥，跑 VM 前释放内存。
- API key 双别名：`.env` 需同时写 `ZHIPUAI_API_KEY`（CLI 认）与 `ZHIPU_API_KEY`（memory 脚本认）；文件权限 600，不进 Git。

## 6. 验证证据

### 6.1 单测与冒烟（实测）

| 项 | 方法 | 结果 |
|---|---|---|
| 全量单测 | `pnpm vitest run` | ✅ 166/166（含 computer-cua 5/5；补装真绑定前为 161/161） |
| bridge Python 单测 | `python -m unittest integrations.osworld.test_bridge -v` | ✅ 5/5 |
| batch fixture | `node scripts/batch-backend-fixture.mjs` | ✅ cua + osworld 双后端 succeeded |
| 绑定二进制体检 | `file` + `ldd` | ✅ ELF x86-64，动态依赖全解析（glibc 无 not found） |
| tarball 完整性 | openssl sha512 对照 lockfile | ✅ 逐字节一致 |

### 6.2 GLM 真实 API 冒烟（实测，glm-5.3-flash）

- Planning smoke：task_create → task_update 闭环 succeeded。
- Memory：facts / entities / multi 三模式全 succeeded。
- Qwen 真实 API：本机未实测（作者 Windows 报告：全矩阵 21/24，3 失败为模型偶发协议偏离，fail-closed 行为正确）。

### 6.3 端到端：OSWorld D19（实测）

任务 D19 = `9bc3cc16-074a-45ac-9bdc-b2a362e1daf3`（Thunderbird 收件箱邮件导出 eml 至 `~/emails.bak`；evaluator 为 check_list 本地正则，无需云端 gold 文件）。

| 跑次 | 结果 | 说明 |
|---|---|---|
| 第 1 跑 | 失败 | path_to_vm 传目录，QEMU exit 64（§3.1） |
| 第 2 跑 | 0 分 | ip_tables 未加载 + trycua 静态 import 崩（§3.2 / §4） |
| 第 3 跑 | ✅ 1.0 | run-d19-134908：17 模型 turn / 16 GUI 动作全成 / wall 约 3.6 分钟；evaluator 两正则全中 |
| 回归跑 | ✅ 1.0 | run-d19-143438：25 步 / 26 请求 / 8 项错误计数全零；真绑定状态下复验 |

公共时序：VM healthy 约 45s（KVM 加速），reset 秒级（HF cache 已建）。原始 trajectory、evaluate.json 与分步复跑手册存于成员C 工作区（仓库外），不进 Git。

## 7. 边界与遗留

- 未实例化 CuaDriver 驱动本机真实桌面（AGENTS.md 与 Risk Guard 双重门控，保持 VM 隔离路线）。
- ip_tables / iptable_nat 重启失效，持久化方案待确认。
- Qwen 真实 API 本机未实测。
- G0 评测集冻结（evaluator 正/负校准 + 预算回填 + 冻结 tag）完成前不启动正式效果实验。

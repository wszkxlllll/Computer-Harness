# Linux 平台适配与验证证据（2026-09-17）

日期：2026-09-17
文档角色：结果
状态：历史证据
当前入口：从属于 [Stage 6 当前实施入口](./stage-6-convergence-and-start-state-2026-09-15.md)
状态更新（2026-09-17）：PR #3 的 lazy CUA 加载修复（`7f85234`/`b2f0a82`）与 PR #4 的 Linux 文档修复（`1ecce58`/`5c84d38`）已合并；下文保留原作者历史证据与当时的基线表述，不重写其测试数据。
证据基线：成员 C 的环境与端到端结果产生于 `cf59133`；本文档 PR 基于 `0e41463`，其 Hosted CI 另列，不混用测试数量。关联修复 [PR #3](https://github.com/wszkxlllll/Computer-Harness/pull/3) 在本文原始记录时尚未合并，当前状态见上方更新。
范围：Linux 宿主机运行本仓库的适配项与验证证据：依赖安装、单测、GLM 真实 API 冒烟、OSWorld docker 链路端到端。不覆盖：macOS、真实本机桌面驱动（AGENTS.md 与 Risk Guard 门控）、Qwen 真实 API 本机实测。

## 1. 结论

1. 成员 C 报告 OSWorld Linux（docker provider）链路已跑通：任务 D19 两次 evaluator 返回 1.0（非模型自报）。原始 trajectory/evaluate 文件仍在成员工作区，仓库内只有本结果摘要，因此该成绩尚未获得独立复核，也不自动放行其余 G0 任务。
2. 历史 `cf59133` 环境报告包含仓库测试 166/166（含 computer-cua 5/5）和 bridge Python 测试 5/5；本文档 PR 基于 `0e41463` 的 Hosted CI 为 15 个测试文件、200/200。两组属于不同 commit，不能直接比较。
3. 本轮 Linux 适配发现一项仓库级启动缺陷：CLI 与 batch fixture 静态 import computer-cua，原生绑定缺失时非 cua 路径也在进程启动期崩溃。PR #3 提议通过懒加载修复；合并及回归通过前不标记为已修复。
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
- 本机直接原因：受限网络下 `pnpm install` 后该 optional 平台包目录为空，dep 链接悬空。事后常规重装在该机器上没有自愈；“pnpm 依据 `.modules.yaml` 误判为已安装”是本轮排查解释，不是已经由 pnpm 上游确认的通用结论。
- 排查：`ls node_modules/.pnpm/<pkg>*/node_modules/` 看包目录是否有实际文件。
- 经 integrity 校验的应急恢复方法（直接修改 `node_modules`，不是团队默认安装流程；优先在可用网络中重新执行干净的 frozen-lockfile 安装）：
  1. `npm pack @trycua/cua-driver-linux-x64-gnu@0.22.2` 取得 tarball；
  2. `openssl dgst -sha512 -binary <tarball> | openssl base64 -A`，与 `pnpm-lock.yaml` 中该包 integrity 逐字节对照；
  3. 解包进 `.pnpm/<pkg>@<ver>/node_modules/`（tar 内顶层 `package/` 用 `--strip-components=1` 上移一层），原悬空 dep 链接自动生效；
  4. import 冒烟验证无 warning 无报错。
- 仓库侧候选修复：PR #3 把 CLI 与 batch fixture 改为懒加载 computer-cua，使绑定缺失只影响 cua 路径。其自动回归与最终合并状态以 PR 本身为准。
- 版本边界：cua-driver 保持 0.22.2 不升不降；0.27.0 起主包新增 `./fleet` 导出；是否升级 0.28.2 由组长决定。

## 5. 网络受限环境参考策略（本机实例，非项目要求）

- PyPI：直连与代理均不稳（频繁 IncompleteRead），走镜像站直连最稳；torch 选 CPU 版（约 190MB，避免 CUDA 版 906MB 及 3GB nvidia 依赖）。
- HuggingFace 大文件：镜像站 CDN 限速不可用；源站走代理单连接约 1MB/s。aria2 经代理 TLS 握手失败不可用；curl 分块 Range 并行 + 断点续传有效（24.5GB 约 1.5 小时）。
- 大文件不放 /tmp（本机 /tmp 为 7.7G tmpfs）；VM 与本机大内存容器互斥，跑 VM 前释放内存。
- API key 名称：CLI 当前兼容 `ZHIPUAI_API_KEY`、`ZHIPU_API_KEY` 和 `GLM_API_KEY`，部分历史脚本只读取 `ZHIPU_API_KEY`。同时设置两个名字是运行旧脚本的临时兼容方式，不是长期产品合同；密钥文件权限设为 600，且不得进入 Git。

## 6. 验证证据

### 6.1 历史本机测试与当前 Hosted CI

| 项 | 方法 | 结果 |
|---|---|---|
| 历史仓库测试（`cf59133`，成员 C 本机报告） | `pnpm vitest run` | ✅ 166/166（含 computer-cua 5/5；补装真绑定前为 161/161） |
| bridge Python 单测 | `python -m unittest integrations.osworld.test_bridge -v` | ✅ 5/5 |
| batch fixture | `node scripts/batch-backend-fixture.mjs` | ✅ cua + osworld 双后端 succeeded |
| 绑定二进制体检 | `file` + `ldd` | ✅ ELF x86-64，动态依赖全解析（glibc 无 not found） |
| tarball 完整性 | openssl sha512 对照 lockfile | ✅ 逐字节一致 |
| 本文档 PR Hosted CI（`0e41463` 基线） | [Actions run 35210872542](https://github.com/wszkxlllll/Computer-Harness/actions/runs/35210872542) | ✅ Linux/Windows/macOS 与 Linux Node 24：15 files / 200 tests，`ci-required` 成功；不含真实 API/桌面/VM |

### 6.2 GLM 真实 API 冒烟（成员 C 本机报告，glm-5.3-flash）

- Planning smoke：task_create → task_update 闭环 succeeded。
- Memory：facts / entities / multi 三模式全 succeeded。
- Qwen 真实 API：本机未实测（作者 Windows 报告：全矩阵 21/24，3 失败为模型偶发协议偏离，fail-closed 行为正确）。

### 6.3 端到端：OSWorld D19（成员 C 本机报告）

任务 D19 = `9bc3cc16-074a-45ac-9bdc-b2a362e1daf3`（Thunderbird 收件箱邮件导出 eml 至 `~/emails.bak`；evaluator 为 check_list 本地正则，无需云端 gold 文件）。

| 跑次 | 结果 | 说明 |
|---|---|---|
| 第 1 跑 | 失败 | path_to_vm 传目录，QEMU exit 64（§3.1） |
| 第 2 跑 | 0 分 | ip_tables 未加载 + trycua 静态 import 崩（§3.2 / §4） |
| 第 3 跑 | ✅ 1.0 | run-d19-134908：17 模型 turn / 16 GUI 动作全成 / wall 约 3.6 分钟；evaluator 两正则全中 |
| 回归跑 | ✅ 1.0 | run-d19-143438：25 步 / 26 请求 / 8 项错误计数全零；真绑定状态下复验 |

公共时序：VM healthy 约 45s（KVM 加速），reset 秒级（HF cache 已建）。原始 trajectory、evaluate.json 与分步复跑手册存于成员 C 工作区（仓库外），当前 PR 没有提供可供其他维护者复算的脱敏 manifest 或 checksum。因此本节保留为有来源的作者报告，不作为正式 Validation 或独立复核证据。

## 7. 边界与遗留

- 未实例化 CuaDriver 驱动本机真实桌面（AGENTS.md 与 Risk Guard 双重门控，保持 VM 隔离路线）。
- ip_tables / iptable_nat 重启失效，持久化方案待确认。
- Qwen 真实 API 本机未实测。
- D19 需要补充不含截图、密钥和正文的运行 manifest（源码/环境 commit、模型与预算、evaluator 摘要、artifact SHA-256），才能升级为仓库可独立核对的证据。
- G0 评测集冻结（evaluator 正/负校准 + 预算回填 + 冻结 tag）完成前不启动正式效果实验。

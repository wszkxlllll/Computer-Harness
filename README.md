<div align="center">

# Lightspeaker

**用自然语言交代生活任务，在手机上掌握电脑的执行过程。**

Powered by **Computer Harness** · 面向真实桌面的可靠 GUI Agent Runtime

[开始使用](#开始使用) · [工作原理](#工作原理) · [真实验证](#真实验证) · [文档](./docs/DOCS-INDEX.md) · [贡献](#参与贡献)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

</div>

把要做的事告诉 Lightspeaker，例如查询乘车信息、整理办事材料，再把结果交付到指定应用。电脑负责执行，你可以在手机上查看进度和画面，补充条件、纠正方向，在发送等关键步骤确认后继续。

**让 Agent 适应不同使用者，而不是要求使用者适应 Agent。** 我们希望把电脑任务的执行能力，交还给每个能表达需求的人。

### 轻松托付

手机、语音、大字显示、读屏支持和可编辑偏好，降低交代任务与调整设置的负担。用户不必先理解坐标、工具参数或复杂 Prompt。

### 全程知情

进度、实际截图、结果和审批接入同一 Run；用户可以查看或听取已确认的进展，补充条件、纠正方向，不必只面对一个“正在运行”的状态。

### 关键把关

本地风险扫描、动作准入和人工审批承接发送等关键边界；暂停、停止和纠正是正式执行状态。结果不确定时不盲目重放，让用户保有决定权。

### 隐私有界

明确区分窗口与全桌面范围，结构化信息按能力开关采集；受管浏览器登录状态留在电脑，按任务使用。模型可能收到的画面与上下文、第三方服务和公开记录的脱敏要求均明确说明。

<!-- 主 Demo：手机发起任务 → 电脑跨应用执行 → 手机审批/纠正 → 最终成果。重录要求见 docs/project-materials.md 第9节。 -->

## 为什么需要 Computer Harness？

模型能看懂界面、决定下一步，CUA 等驱动能点击和输入。但真实任务还会遇到窗口切换、弹窗、旧引用失效、部分执行和临时纠正。把这些都交给模型临场猜，远不足以支撑持续使用。

**模型负责决策，CUA 负责动作，Computer Harness 负责让任务在变化、出错和用户介入后仍能继续。**

| 直接拼接模型与工具 | 由 Harness 承接 |
| --- | --- |
| 切换应用后重新猜操作对象 | 在同一 Session 中管理目标 Surface 与显式切换 |
| 动作返回成功，就当目标已完成 | 区分执行回执、动作后观察与最终交付证据 |
| 副作用不明时继续重试 | 保留未知结果，不自动重放可能已发生的操作 |
| 用户只能等待或重开任务 | 在同一 Run 中审批、纠正、暂停或停止 |

### 连续的桌面任务

Surface Registry 管理任务实际使用的窗口、浏览器页面及有可靠关系证据的子界面，跟踪身份、代际和引用新鲜度。跨应用通过明确选择和切换完成，不试图建立完整的桌面世界模型。

窗口范围可以减少无关画面的采集；全桌面模式适合跨应用任务，但会采集当前桌面，并共享前台输入。两者都不是后台隔离或操作系统沙箱。

<!-- Surface Registry 示意图：稳定 Session、peer switch、child push/pop、generation 与引用失效。 -->

### 有证据的执行与恢复

**观察 → 决策 → 校验与审批 → 执行 → 回执 → 再观察 → 结果核对**

Runtime 统一处理工具注册、参数与权限、预算、有限重试、取消和失败传播。Context、Planning、Run Memory 与非阻断 Monitor 服务于这个循环，运行事件和轨迹用于追查实际发生了什么。

动作成功不等于业务完成。结果核对结合新观察、模型评估与必要人工验收；当前不宣称具有通用自动业务验证器，或能保证模型不会误判。

<!-- Runtime 执行闭环图：Observation / ActionIntent / Receipt / 新观察 / 用户介入。 -->

### 人机协作控制

手机连接的是电脑上的同一个 Run：查看截图、审批动作、补充要求、暂停和停止。语音输入、进度播报、完整语句的读屏提示及可编辑偏好，让交互不只依赖看清按钮和反复输入长指令。

无障碍是持续验收的产品能力，而不是效果口号；网页语义与交互检查、iPhone 真机体验和目标用户试用分别记录。

## 工作原理

```text
手机 Web / 语音
       │ 目标、纠正、审批、控制
       ▼
  HTTPS Relay ↔ 电脑 Host
                    │
             Computer Harness
             ├─ Runtime / ToolRegistry
             ├─ Context / Planning / Run Memory
             ├─ Guard / Monitor / Trajectory
             └─ ComputerSession / Surface Registry
                    ↕                 ↕
              Model Provider     Computer Adapter
                                      │
                                 CUA / 真实桌面
                          视觉 + 可选 UIA / 受管浏览器 DOM
```

Windows 与 macOS 复用公共合同和 Runtime，平台输入及窗口机制分别适配。模型、Context、Planning、Memory 和 Computer 后端通过 Run 级装配替换，不需要复制主循环。

CUA 提供底层桌面能力；本项目实现其上的执行控制、状态与上下文、人机交互及应用装配。DOM 由受管浏览器接入，不意味着能够读取用户任意个人浏览器。

<!-- 系统架构图：模型、Runtime、Host/Relay/Web、Computer Adapter 与上游 CUA 的自主边界。 -->

## 真实验证

已有真实 Harness 记录覆盖官网查询、桌面输入、跨应用和人工纠正。最近一次代表性流程是 **携程查票 → 微信文件传输助手**：本轮新输入、审批、发送和动作后消息均经独立核验，而非把旧聊天当作本次成果。

该次运行有 **13 次模型请求、9 次完成动作、0 动作失败**，同时包含 **1 次日期纠正和2次审批**。这是有人工协助的案例，不是总体成功率，也不证明 Planning / Memory 已有稳定净收益。原始失败和重试与成功记录一并保留，详见[真实任务与 Demo 记录](./docs/life-business-evaluation-2026-10-15.md)。

任务范围沿用六类：政务公共服务、就医健康、购物售后、出行票务、缴费社区、通信日程与个人资料。场景范围不是已全部通过的承诺；[活动任务及评分方法](./eval/life-business-six-domain-20261018/README.md)区分候选、实跑与独立验收。

<!-- 六类真实任务评测结果图：样本数、完整/部分/失败、人工参与、总耗时与API耗时；待统一统计后发布。 -->

## 开始使用

手机是主要体验入口，电脑 Host 执行任务。需要电脑处于可交互会话，准备模型凭据、匹配版本的 CUA，以及手机可访问的 HTTPS Relay。手机不需要安装原生 App。

1. 安装 Node.js `>=22.13.0`、pnpm `11.19.0`，按[上手指南](./docs/getting-started.md)准备依赖、模型和 CUA daemon。
2. Windows 用户在仓库根目录复制并编辑本机配置。模板中的路径、socket、模型及私有 env 文件必须换成自己的值，不能直接使用占位配置：

   ```powershell
   Copy-Item .harness.local.example.psd1 .harness.local.psd1
   ```

3. 构建并启动手机连接入口：

   ```powershell
   .\scripts\mobile.ps1 start -Build
   ```

4. 在电脑连接页配置可访问的 Relay，手机扫码配对，再输入目标。首次使用网站时，在电脑上准备受管浏览器登录状态；账号和 profile 不随源码提供。

macOS 的权限与安装步骤见[上手指南](./docs/getting-started.md)，不使用 Windows PowerShell 启动器。跨设备接入见[手机指南](./docs/mobile-control-guide-2026-09-26.md)与[Relay 部署说明](./apps/relay/README.md)。公共评审 Demo Relay 尚未开放，不能把个人 Preview 当成公共控制服务。

## 开源生态

Lightspeaker 不把上游驱动或云模型当作自研成果。我们也把真实使用中发现的问题反馈给社区：

- **CUA**：[多行输入 Issue #4477](https://github.com/trycua/cua/issues/4477)及[已合并 PR #4500](https://github.com/trycua/cua/pull/4500)，贡献复现、测试夹具和验证；[DPI PR #3450](https://github.com/trycua/cua/pull/3450)与[前台输入 PR #4836](https://github.com/trycua/cua/pull/4836)仍为开放提案，不写成已发布能力。
- **OpenClaw**：[Run 后资源复用 #126399](https://github.com/openclaw/openclaw/pull/126399)、[Windows 重复审批 #127177](https://github.com/openclaw/openclaw/pull/127177)已合并。OpenClaw 不是本项目的运行依赖。

上游合并不代表已进入本项目锁定的驱动版本。具体来源、自主边界和依赖许可见[项目材料](./docs/project-materials.md)与[第三方声明](./THIRD_PARTY_NOTICES.md)。

## 当前状态与安全

- 产品聚焦 **Windows / macOS**；共享协议、离线测试和某一端的实机结果，不互相替代平台验收。
- 模型请求可能包含目标、截图及必要上下文；语音识别使用配置的第三方服务。不要在未经授权的账户、资料或桌面上运行。
- Guard 和人工审批不能识别所有危害，也不能撤销已经发生的操作。全桌面运行期间，不要同时操作鼠标键盘。
- 源码、演示版本与部署版本分开记录，不能因为分支已更新就认为服务已更新；[部署记录](./docs/voice-preview-deploy-phone-test-2026-09-29.md)给出实际版本与回退边界。

## 参与贡献

欢迎提交包含复现步骤、环境和脱敏证据的 Issue / PR。涉及真实桌面或收费 API 时，请说明授权、结果及未验证部分。后续重点是可靠性、真实任务效果与无障碍体验，而非堆叠功能数量。

产品名为 **Lightspeaker**，技术内核为 **Computer Harness**；现有仓库地址、`@computer-harness/*` 包名和接口保持不变。

原创代码采用 [Apache-2.0](./LICENSE)。第三方代码、模型服务、系统软件及用户素材分别受其许可或条款约束。

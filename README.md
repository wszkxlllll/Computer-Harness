# Computer Harness

**模型决定下一步，CUA 执行动作；Harness 让真实桌面任务在变化中持续成立。**

Computer Harness 是面向真实桌面环境的 GUI Agent Runtime，处理跨窗口、跨应用任务中的界面变化、部分失败、风险审批与用户纠正。

| Without Harness | With Harness |
| --- | --- |
| 状态变化或部分成功后，模型与桌面的上下文容易脱节。 | 一个 Run 持续核验目标与结果；副作用不明时先确认，再恢复或请人判断。 |

[设计](#capabilities) · [架构](#architecture) · [Demo](#demo) · [手机端 Quick Start](#phone-quick-start) · [开源生态贡献](#open-source) · [状态与限制](#status-and-limitations)

<a id="capabilities"></a>
## 运行时能力

- **动态目标拓扑**：Surface Registry 组织窗口与子 Surface 的关系、身份和引用新鲜度。界面或目标变化后重新观察；只在当前 Run 允许的范围内切换 Surface。
- **可靠执行闭环**：Observe → Act → Receipt → Re-observe → Verify。回执说明动作已派发，不等于目标效果已证实；Risk Guard / Monitor 处理准入与风险。副作用未知时不盲目重放，先复核、恢复或请用户决策。
- **同一 Run 的人本控制**：手机、语音、审批、纠正、暂停/停止和个性化偏好接入同一个 Run，让用户按熟悉方式参与，不必先学习坐标或复杂 Prompt。

<a id="architecture"></a>
## 架构

```text
Model Provider → Harness Runtime → CUA Computer Adapter → Desktop
                      ↕ Surface Registry
Desktop ── observations / receipts ──→ Runtime
Phone / Voice ── same Run: goal · approval · correction · stop
```

> 架构图占位。

模型 Provider 负责决策；CUA 是独立上游桌面驱动。本仓库维护 Runtime、Surface Registry、策略、公共协议和 Host。

<a id="demo"></a>
## Demo 与评测

**主演示路径：** 手机发起任务 → 电脑跨应用执行 → 手机查看进度与截图，并审批或纠正。

> Demo 占位：待录制主路径演示。

> 评测占位：围绕公共服务、健康、购物、出行、缴费与个人事务等真实任务；统一结果待补。

<a id="phone-quick-start"></a>
## 手机端 Quick Start

手机端唯一 Quick Start 主线是配置并启动本地 Host/连接页。需要 Node.js <code>>=22.13.0</code>、pnpm <code>11.19.0</code> 和模型 Provider key（<code>ZHIPUAI_API_KEY</code> 或 <code>DASHSCOPE_API_KEY</code>）。

CUA SDK/daemon 必须按平台配对：Windows/macOS <code>0.22.2</code>，Linux <code>0.32.0</code>。Capability Doctor 严格核对 driver 与 SDK 版本及 contract；不匹配时不会报告为可用。

1. 复制本机配置模板：

   ```powershell
   Copy-Item .harness.local.example.psd1 .harness.local.psd1
   ```

2. 按[开发者上手](./docs/getting-started.md)安装依赖并准备对应版本的 CUA daemon，在 `.harness.local.psd1` 中填写本机路径与模型设置，并在其引用的私有 EnvFile 中配置 Provider key。

3. 在 Windows PowerShell 启动本地 Host/连接页：

   ```powershell
   .\scripts\mobile.ps1 start
   ```

更多资料见[文档索引](./docs/DOCS-INDEX.md)、[架构说明](./docs/ARCHITECTURE-AND-COMPOSITION.md)和[手机控制指南](./docs/mobile-control-guide-2026-09-26.md)。

## 参与与贡献

欢迎提交 Issue 和 Pull Request，请说明验证命令、结果与适用边界。入口见[文档索引](./docs/DOCS-INDEX.md)。

## License 与第三方依赖

本项目原创代码采用 [Apache License 2.0](./LICENSE)；CUA、依赖和模型服务按各自许可证与条款使用，详见[第三方声明](./THIRD_PARTY_NOTICES.md)。

<a id="open-source"></a>
## 开源生态贡献

基于真实使用 CUA 发现的问题，我们通过 [Issue #4477](https://github.com/trycua/cua/issues/4477) 与 [PR #4500](https://github.com/trycua/cua/pull/4500) 回馈上游。#4477 仍 Open；#4500 已 Ready、Open、MERGEABLE，维护者接手输入 drain 根因修复并保留我方 fixtures、app-owned oracle 与 tests，尚未合并。[PR #3450](https://github.com/trycua/cua/pull/3450) 仍 Open、MERGEABLE，但为 BLOCKED / CHANGES_REQUESTED。

早期上层 Agent Host 集成中，我们在 OpenClaw 合并了[跨 Run 复用修复 #126399](https://github.com/openclaw/openclaw/pull/126399)和[防止 Windows 设备重复审批修复 #127177](https://github.com/openclaw/openclaw/pull/127177)。这些经验影响 Harness 的独立设计；OpenClaw 不是当前依赖，这些 PR 也不代表 Harness/CUA 已具备相同能力。

<a id="status-and-limitations"></a>
## 状态与限制

| 平台 | 当前验证深度 |
| --- | --- |
| Windows | 本工作树验证最深入；能力仍受桌面会话、权限与具体应用影响。 |
| macOS / Linux | SDK 版本已分配；完整桌面链路尚未在本工作树独立验证。 |

- 手机跨设备连接暂无公共 Relay 地址或配对二维码；Relay 需可访问 HTTPS，使用 TLS 转发但无端到端加密。
- Demo/评测仍是占位；暂无统一跨应用结果或可报告成功率。老年人、低数字素养和无障碍场景的实际成效未验证。
- 手机语音识别需配置 Qwen 实时 ASR，录音发送到所配服务且转写可编辑；播报使用浏览器/系统 `speechSynthesis`。
- Provider 请求可能含目标、截图与运行上下文；启用跨窗口选择时，也可能包含授权窗口的应用名和标题。审批、暂停或停止不能撤销已发生操作，窗口模式不是操作系统沙箱；轨迹、截图、凭据和个人浏览器资料可能含敏感信息。

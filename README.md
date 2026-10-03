# Computer Harness

**让会操作电脑的模型，真正能够在真实桌面环境中持续完成任务。**

今天的 Computer-Use 模型已经能看懂界面、决定下一步，CUA 等工具也已经能完成点击、输入和观察；但一个真实桌面任务远不止“看一张截图、点一次鼠标”。窗口会切换，弹窗会出现，操作引用会失效，输入可能只完成一半，用户会临时纠正目标，高风险操作还需要确认。

**Computer Harness 补的是 Model 与 Computer-Use Backend 之间缺失的 Runtime 层。**

模型负责决定下一步，CUA 负责执行动作；Harness 负责让整个任务在变化的真实环境中持续成立：知道当前在操作什么、过去发生了什么、动作是否真的产生了预期结果，以及失败、不确定或用户介入之后应该如何继续。

> **我们不是让 Agent 更会点鼠标，而是让已经会操作电脑的模型，能够在复杂、变化、会出错的真实环境里可靠、可控地完成任务。**

| 没有 Harness | 有 Computer Harness |
| --- | --- |
| 弹窗、新窗口或跨应用后，模型需要重新猜当前目标 | Surface Registry 持续维护任务中的可操作 Surface |
| 界面变化后仍可能使用旧坐标、旧元素或旧状态 | Surface identity / generation 失效旧引用并触发重新观察 |
| 工具返回成功后容易直接认为任务完成 | Receipt 之后继续 Re-observe / Verify，区分“动作已执行”和“结果已确认” |
| 部分执行或副作用不明时容易重复操作 | Unknown side effect 不自动重放，先验证、恢复或请求用户判断 |
| 用户纠正、审批和暂停只是额外 Prompt | Correction、Approval、Pause / Resume 属于同一个 Run 的正式状态 |

> [主 Demo：手机发起任务 → 电脑跨应用执行 → 手机查看进度、审批与纠正]

---

## 核心设计

### Surface-aware：让任务跨越真实桌面

真实桌面不是一个固定页面。一个任务可能从浏览器进入文件管理器，再打开编辑器，中途经过菜单、模态框、新窗口和浏览器 Tab。

Computer Harness 的 **Surface Registry** 将这些界面组织成任务内部可追踪的操作空间：维护 peer Surface、child/modal Surface、浏览器层级以及引用的新鲜度，使 `ComputerSession` 对应完整任务，而不是绑定某一个瞬时窗口。

这让跨窗口和跨应用不再是异常恢复，而成为 Runtime 的正常状态变化。

> [Surface Registry 示意图：Browser / Editor / Dialog / Tab、peer switch、child push/pop、generation invalidation]

### Reliable execution：不仅执行，还确认发生了什么

Computer Harness 将一次操作组织为持续闭环：

**Observe → Decide → Admit → Act → Receipt → Re-observe → Verify**

工具回执只说明动作被执行或派发，不等于用户目标已经完成。界面变化、引用失效、部分成功或结果未知时，Runtime 可以重新观察、重新规划、恢复执行或请求人工判断，而不是默认重试。

Planning、Context、Run Memory、Monitor 和 Risk Guard 都服务于同一件事：**让一个长任务在真实环境中的每一步都有状态、有依据、有后续。**

> [Runtime 执行闭环图]

### Human-in-the-loop：让 Agent 适应人

用户不应该为了使用 Agent 先学习坐标、窗口结构或复杂 Prompt。

手机端、语音、自然语言纠正、审批、暂停/恢复和个性化偏好都接入同一个 Run。用户可以在任务执行过程中随时补充条件、纠正方向、处理风险步骤或接管任务，而无需重新开始。

这套交互也为老年人、数字工具使用门槛较高的用户以及无障碍场景提供了进一步扩展空间：**让 Agent 适应不同使用者，而不是要求所有人适应 Agent。**

---

## 架构

```text
                    Phone / Voice / TUI
                           │
                    goal / correction
                    approval / control
                           │
                           ▼
                    Computer Harness
              ┌─────────────────────────┐
              │          Runtime        │
              │                         │
              │ Task / Planning         │
              │ Context / Run Memory    │
              │ Risk Guard / Monitor    │
              │ Verification / Recovery │
              │                         │
              │     Surface Registry    │
              └────────────┬────────────┘
                           │
               Computer Adapter Contract
                           │
                           ▼
                          CUA
                           │
                  UIA / Vision / DOM
                           │
                           ▼
                      Real Desktop
```

Model Provider 负责理解目标并提出下一步动作；Computer Adapter 负责将 Runtime 的动作落实到具体环境。

CUA 是独立的上游 Computer-Use Driver，并不是 Computer Harness 的自研组件。本项目主要实现其上的 **Runtime、Surface 生命周期、执行控制、Context / Planning / Run Memory、风险与用户控制、Host 和多入口接入层**。

Windows、macOS 和 Linux 共用公共协议，不同平台可以采用不同 Computer Adapter 和底层能力。

> [系统架构图]

---

## Demo 与评测

主演示将围绕一个完整的跨应用长程任务展开，而不是展示单个 click / type：

**手机提出目标 → Agent 在电脑执行 → 跨窗口 / 跨应用 → 处理动态 Surface → 手机查看过程 → 风险审批或中途纠正 → 完成并验证最终结果**

> [Demo 视频 / GIF 占位]

除主演示外，项目将用统一任务协议覆盖六类真实使用场景：

- 政务与公共服务
- 就医与健康服务
- 购物与售后
- 出行与票务
- 生活缴费与社区服务
- 通信、日程与个人事务

评测不仅记录最终是否完成，还将记录失败位置、恢复情况、人工纠正与接管次数以及最终可观察证据。

> [六类真实任务评测结果图]

---

## 手机端 Quick Start

手机端是当前主要体验入口：在手机发起目标、查看进度和截图，并完成纠正、审批、暂停或停止；模型推理和桌面执行仍运行在电脑 Host。

当前需要：

- Node.js `>=22.13.0`
- pnpm `11.19.0`
- 与平台配对的 CUA SDK / daemon：Windows、macOS `0.22.2`，Linux `0.32.0`
- GLM 或 Qwen Provider Key

复制本机配置：

```powershell
Copy-Item .harness.local.example.psd1 .harness.local.psd1
```

按照[开发者上手](./docs/getting-started.md)配置本机 Node、CUA、Provider 和输出路径后启动：

```powershell
.\scripts\mobile.ps1 start
```

本地 Host 会启动电脑端连接页面。跨设备手机访问需要 HTTPS Relay；公共 Demo Relay 正在准备中，开放后可直接通过二维码完成配对体验。

更多配置与故障排查见[文档索引](./docs/DOCS-INDEX.md)、[手机控制指南](./docs/mobile-control-guide-2026-09-26.md)和 [Relay 部署说明](./apps/relay/README.md)。

---

## Open-source ecosystem

Computer Harness 建立在开源 Computer-Use 生态之上，同时也将真实使用中发现的问题反馈回上游。

### CUA

在 Harness 的 Windows 实机开发中，我们发现并隔离了 foreground 多行输入异常，最终形成：

- [Issue #4477](https://github.com/trycua/cua/issues/4477)：将问题从模型和 Harness 中剥离，提供独立 CUA reproduction；
- [PR #4500](https://github.com/trycua/cua/pull/4500)：加入 WPF / WinUI3 multiline fixtures、app-owned state oracle 和回归测试，并与 maintainer 一起定位 foreground input queue drain 问题；该修复现已合并；
- [PR #3450](https://github.com/trycua/cua/pull/3450)：针对 Windows embedded SDK 下 DPI virtualization 与物理像素捕获问题进行修复与回归验证；当前仍为 Open / Changes Requested。

这些工作来自真实 GUI Agent 开发过程中暴露出的底层边界：

**使用开源 → 发现真实问题 → 最小复现 → 测试与源码定位 → 向上游提交修复。**

### OpenClaw

在更早的 Agent Host 实践中，我们也向 OpenClaw 提交并合入了与 Computer-Use 生命周期和 Windows 设备控制相关的修复：

- [#126399](https://github.com/openclaw/openclaw/pull/126399)：修复 Computer Run 完成后的资源清理，使同一 Computer Node 能被后续 Run 正常复用；
- [#127177](https://github.com/openclaw/openclaw/pull/127177)：修复 Windows CLI / TUI / Node Host 之间等价设备 metadata 导致的重复审批问题。

OpenClaw 不是 Computer Harness 的运行依赖，但这些真实系统问题推动了 Harness 对 **Run 生命周期、资源清理、审批状态和可恢复执行** 的设计。

---

## 状态与限制

| 平台 | 当前状态 |
| --- | --- |
| **Windows** | 当前验证最深入，主要 Runtime、CUA Adapter 和本地 Host 路径围绕 Windows 开发与测试 |
| **macOS** | 公共协议和适配工作正在推进，完整真实桌面链路仍需继续验证 |
| **Linux** | 已按平台路由 CUA `0.32.0`，仍需针对不同显示后端和权限环境继续验证 |

当前 Demo 和统一跨应用评测仍在整理，因此暂不发布整体成功率。

手机跨设备访问需要 HTTPS Relay；公共 Relay 尚未开放。语音输入使用所配置的实时 ASR 服务，语音数据会发送到相应 Provider。

模型请求可能包含任务文本、截图和必要运行上下文。Risk Guard、审批、暂停和停止可以限制后续动作，但不能撤销已经发生的系统操作；当前窗口执行环境也不等同于操作系统级沙箱。

---

## 参与与贡献

欢迎提交 Issue 和 Pull Request。

如果改动涉及真实桌面、模型 API 或外部服务，请同时说明测试环境、验证方式和仍未覆盖的边界。

项目后续重点包括：

- 跨应用长程任务与统一评测；
- Surface / grounding freshness 和失败恢复；
- 手机端与语音交互；
- 无障碍与适老化体验；
- 更多平台的 Computer Adapter 验证。

---

## License

Computer Harness 原创代码采用 [Apache License 2.0](./LICENSE)。

CUA、第三方依赖、模型 Provider、评测环境和用户素材仍分别受各自许可证或服务条款约束。具体依赖、版本和 notice 信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

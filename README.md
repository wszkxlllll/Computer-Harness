# Computer Harness

面向真实桌面环境的跨平台、可扩展、可观测 GUI Agent Runtime。

模型能够看见界面并决定下一步，CUA 能把点击和输入送到桌面；但没有 Runtime，跨窗口任务遇到弹窗、旧操作引用、部分成功或界面变化时，后续动作、纠正和审批就只能让模型临场猜。Computer Harness 让桌面任务连续持有目标与运行状态，知道当前操作对象，核验动作实际效果，并在结果不确定时停下、重新观察或恢复，让用户始终掌握控制权。

**我们不是让 Agent 更会点鼠标，而是让已经会操作电脑的模型，真正能够在复杂、变化、会出错的真实环境里持续完成任务。**

Surface Registry 将窗口和子 Surface 组织为有身份、有关联、可校验的操作对象。跨窗口不等于默认开启全桌面任意观察：同一 Run 围绕任务所需、已识别或获授权的 Surface 跟踪并切换目标，例如从浏览器到记事本/WPS；设计上尽量缩小无关窗口进入观察与操作的范围，以落实隐私最小化和作用域控制，同时用户仍可正常查看其他窗口。Runtime 把任务规划、上下文和 Run Memory 与每一步的观察、准入、执行回执和新观察连在一起。结果不完整或引用失效时，系统不把模型的一句话当作完成证明，也不盲目重放动作，而是让它重新确认、继续恢复或请求用户判断。Risk Guard 与 Monitor 处理风险和不确定状态；用户可以通过手机、语音、自然语言补充或纠正、审批、暂停或停止同一 Run，并按个性化偏好参与，无需先理解窗口、坐标或复杂 Prompt。目标是让 Agent 适应不同使用者，而不是要求使用者适应 Agent；相关设计也旨在降低老年人、数字素养较低者和无障碍场景的参与门槛。

模型 Provider 负责提出操作，Computer Adapter 负责把 Runtime 的动作落到桌面。视觉、UIA 与受管浏览器 DOM 是适配层按当前目标选择的观察来源；本仓库维护公共协议、Surface Registry、Runtime、策略和 Host。CUA 是独立上游项目，提供底层桌面驱动，不是本仓库自研组件。Windows、macOS、Linux 共用公共协议，平台内部可以采用不同 Computer Adapter。

> [Surface Registry 示意图]

> [Runtime 执行闭环图]

> [系统架构图]

## Demo 与评测

手机发起任务、电脑跨应用执行、手机查看进度与截图并审批或纠正，是主要演示路径。

> [主 Demo：手机发起任务→电脑跨应用执行→手机审批/纠正]

评测围绕六类真实生活任务组织：政务与公共服务、就医与健康服务、购物与售后、出行与票务、生活缴费与社区服务、通信、日程与个人资料。

> [六类真实任务评测结果图]

## 手机端 Quick Start

**Public demo relay is planned / 尚未开放。** 当前没有公共 Relay 地址或配对二维码；手机端公共演示暂不可用。开放后的体验流程是：电脑启动受控 Host → 手机扫码配对 → 输入文字或语音目标 → 查看进度与截图 → 审批、纠正、暂停或停止。

本地 Host 需要 Node.js <code>>=22.13.0</code>、pnpm <code>11.19.0</code>、CUA Driver 0.22.2 daemon 和模型 Provider key（<code>ZHIPUAI_API_KEY</code> 或 <code>DASHSCOPE_API_KEY</code>）。先复制本机配置模板：

~~~powershell
Copy-Item .harness.local.example.psd1 .harness.local.psd1
~~~

再按[开发者上手](./docs/getting-started.md)安装依赖并准备 CUA daemon，在 `.harness.local.psd1` 中设置本机 Node、pnpm、CUA、模型与输出路径，并在该文件引用的私有 EnvFile 配置 Provider key。模板里的示例路径不能直接运行。完成本机配置后，用 Windows PowerShell 启动电脑 Host/连接页：

~~~powershell
.\scripts\mobile.ps1 start
~~~

本地 Host/连接页不等同于跨设备配对；手机跨设备连接需要可访问的 HTTPS Relay。

## 状态与限制

| 平台 | 当前验证深度 |
| --- | --- |
| Windows | 本工作树验证最深入；实际能力仍受桌面会话、权限和具体应用影响。 |
| macOS | 队友适配线仍在推进；本线未独立验证完整桌面链路。 |
| Linux | 有共享协议与相关 Adapter 代码；本线未验证发行版、显示后端或权限组合。 |

当前没有统一的跨应用端到端评测结果或可报告的成功率；Demo 与结果图仍是素材占位，待录制和评测稳定后替换。手机语音识别需配置 Qwen 实时 ASR，录音会发送至所配置的识别服务，转写可在提交前编辑；语音播报使用手机浏览器和操作系统的 `speechSynthesis`，没有云端 TTS Provider。老年人、数字素养较低者和无障碍场景的实际使用成效尚未验证。

截至 2026-10-03，CUA foreground 多行输入问题已通过 [Issue #4477](https://github.com/trycua/cua/issues/4477) 反馈；[Draft PR #4500](https://github.com/trycua/cua/pull/4500) 仍待 Windows 重复验证，[PR #3450](https://github.com/trycua/cua/pull/3450) 仍为 Open。它们是对上游的反馈和提议，不是已发布的 CUA 修复。

- Provider 请求可能包含用户目标、截图和运行上下文；启用跨窗口选择时，授权窗口的应用名和标题也可能发送给 Provider。
- Relay 经 TLS 转发但没有端到端加密；Relay 运营者可能接触获授权的任务请求、事件和截图。
- Guard、审批、暂停和停止不能撤销已经发生的系统操作；窗口模式不是操作系统沙箱。
- 轨迹、截图、凭据和个人浏览器资料可能包含敏感信息，不要提交到仓库。

## 参与与后续工作

欢迎提交 Issue 和 Pull Request。请说明改动目的、验证命令、运行结果和适用边界。新贡献按仓库 Apache-2.0 许可提交，本仓库当前不要求单独 CLA。后续重点是稳定的跨应用 Demo、可复核的恢复证据、手机交互和更广的平台实测。

更多材料见[文档索引](./docs/DOCS-INDEX.md)、[架构说明](./docs/ARCHITECTURE-AND-COMPOSITION.md)、[手机控制指南](./docs/mobile-control-guide-2026-09-26.md)和[阶段计划](./docs/product-next-stage-task-list-2026-09-27.md)。

## License 与第三方依赖

本项目原创代码采用 [Apache License 2.0](./LICENSE)，根 `package.json` 标记为 `Apache-2.0`。该许可不覆盖 CUA、pnpm 依赖、模型服务、评测环境或用户素材；各自仍受其 license、服务条款和来源要求约束。实际版本、许可证、用途、核验来源与 notice 边界见[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

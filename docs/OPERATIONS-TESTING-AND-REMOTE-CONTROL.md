# 开发、运行、测试与远程控制

项目入口见 [PROJECT-HANDOFF](./PROJECT-HANDOFF.md)。以下命令使用仓库相对路径，不依赖作者机器盘符；真实模型/桌面测试需要明确授权和独占目标。

## 1. 安装与构建

仓库声明 Node >=22.13.0、pnpm 11.19.0。本地使用隔离 Node 24.19.0 验证过；不要混用系统旧 Node 与配置的 Node，也不要把一次已有依赖环境的测试当作锁定版本冷安装成功。

```text
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @computer-harness/web build
pnpm test
node apps/cli/dist/index.js --help
```

`build` 调用 TypeScript project references/typecheck，并检查 CUA spike；它不生成 Web 的 Vite 生产产物。手机页面另需：

```text
pnpm --filter @computer-harness/web build
```

该 Web 构建也必须先于读取 `apps/web/dist` 的 Host 联合测试；CI 已在 `pnpm test` 前显式加入这一步，不能用本机残留的 dist 代替干净环境的构建。

普通离线构建/单测不需要模型密钥或真实桌面。缺依赖时先安装，不通过删除锁文件或临时改版本来让报错消失。代码以 TypeScript/ESM 为主，保持现有两空格风格和 `.js` 模块导入约定；未配置的 lint/format 命令不要写成存在。

## 2. 本机与 SDK 入口

Windows 首次将 `.harness.local.example.psd1` 复制为忽略的 `.harness.local.psd1`，填写隔离 Node、pnpm、CUA、socket、env 文件和输出位置。API key 不写入该示例或命令参数。常用入口：

```powershell
.\scripts\harness.ps1 start
.\scripts\travel\run.ps1 tui -Preset research -Model glm-5.3-flash
.\scripts\mobile.ps1 check
.\scripts\mobile.ps1 start
```

TUI 是终端交互界面；`I` 输入 Goal/纠正，`P/R` 暂停/恢复，`A`/Ctrl+C 中止，`Y/N` 审批，`W/F` 在适当主页状态选择窗口/下一 Run 功能。具体以界面当前提示为准，不能在模型执行中把按键当作任意时刻均可重新配置。

非 Windows 或 SDK 使用者按 `node apps/cli/dist/index.js --help` 和已验证的 Computer 连接配置启动；不要假定 PowerShell 脚本可以跨 OS 直接使用。外部 Provider/Computer/模块替换见[架构文档](./ARCHITECTURE-AND-COMPOSITION.md)，不是给 CLI 随便传一个模型名。

受管浏览器登录状态存于 Harness 自有 profile。用户手动登录，不要求在聊天输入密码/验证码，不静默给个人浏览器开启调试接口。DOM 只对明确的受管浏览器目标开放；一般原生应用主要依赖视觉和可选 UIA。

## 3. 测试层次与命令

| 层 | 验证内容 | 不能替代 |
| --- | --- | --- |
| 类型/单测 | 协议、策略、reducer、参数、错误、取消、资源清理 | 真实模型遵循合同或 GUI 生效 |
| Fake/集成 | 完整 Runtime、模块开关/组合、Host/Relay/API、重复与撤销 | 实体手机网络或真实驱动 |
| 真实 API | Schema、多工具、坐标、continuation、格式错误/反馈 | 桌面任务成功 |
| 受控真实 Computer | 输入、截图、焦点、窗口、失效/未知结果 | 复杂业务答案正确 |
| OSWorld / 本地任务 | evaluator/人工业务验收、耗时、成本、恢复 | 未测试场景、跨平台承诺 |
| 手机公网 | TLS、扫码、确认/撤销、锁屏、换网、重连 | 本机 Host 单测不能代替 |

```text
pnpm run typecheck
pnpm --filter @computer-harness/web build
pnpm test
pnpm exec vitest run packages/app-runtime/src/remote-run-api.test.ts
pnpm exec vitest run packages/computer-cua/src/cua-driver-computer.test.ts
pnpm --filter @computer-harness/web test
```

根 `test` 经 `scripts/test.mjs` 执行 Vitest 和 Node TAP，不是只跑一个测试器。CI 配置包含 Ubuntu Node22/24、Windows Node22、macOS Node22；它运行离线构建/测试，不控制真实 macOS/Windows 桌面。本地未推送改动没有新的远端 CI 结果，不引用旧绿灯为本轮背书。

新功能最低回归：全部关闭基线、单开、必要组合、双 Run 隔离、两 Provider 投影、相关后端、失败/Abort/清理。新增代码测试与模型/GUI实测分别保存，不能以模拟返回值冒充真实调用。

## 4. 实验和人工验收

使用同一代码/依赖/配置检查点对照；固定任务、初态、预算和停止条件。Planning、Context、Memory、Batch 等尽量分别 ablation；全开只说明互操作，不说明净收益。

开发集用于调整，Validation 不用于针对性调参；同题变体不应跨 split 造成泄漏。本地生活任务按场景覆盖基础、中等、跨应用/冲突任务，出行只是示例。完整 Goal、日期、允许/禁止副作用和人工评分来自任务卡，不能用 README 摘要替代。

现有出行入口：

```powershell
.\scripts\travel\run.ps1 list
.\scripts\travel\run.ps1 show -Task T01 -AnchorDate YYYY-MM-DD
.\scripts\travel\run.ps1 prepare -Task T01 -AnchorDate YYYY-MM-DD -Preset research
```

任务卡 `docs/travel-task-cards-and-feedback.md`、manifest `eval/travel/travel-candidate-manifest.v0.json`；队友新领域保持同样的 Goal/初态/验收/安全/反馈结构，不复制领域答案。OSWorld 的环境 reset、快照和 evaluator 应按已有环境文档单独验收；Harness 的 Computer Adapter 负责观察/动作映射，不需要在 VM 再安装 CUA。

每次记录：业务完成/部分完成/阻塞/未知、模型请求数、GUI primitive 数、截图数、tokens、总耗时、请求等待、人工纠正/审批/恢复、安全事件、Plan/Memory使用与Context大小。用单一事件来源统计，避免报告与轨迹重复相加。Memory写入次数不等于有效召回，Monitor提示次数不等于恢复成功；模块收益要看后续消费与任务结果。

## 5. 产物与故障调查

Run 的事实来源是 outputDir 中的 `trajectory.jsonl` 与资产目录；还可能有 Provider 脱敏 exchange、Plan/Memory store、context/metrics/report。不是每种入口都会生成同名 summary 文件，先检查实际目录和 Run 终态。

排障顺序：配置/版本→最近提交事件→动作started及终态→当前观察/目标身份→模型参数→驱动结果→业务页面。只有completed回执时不能假定文字/菜单生效；只有started时不能重放。失败复测用新 Run/新产物，保留首次失败及改变了什么条件。

本轮独立诊断脚本包括 `scripts/cua-type-text-smoke.mjs`、`cua-window-capture-probe.mjs`，以及新增的 `cua-window-handoff-probe.mjs`。它们不是日常用户入口，必须先读各自 `--help`、检查精确目标、取得桌面测试授权。跨窗口脚本已有静态审查，但实际运行被后续缺失的 CUA/记事本环境阻塞，不能据此写实机通过。新增脚本不自动属于先前冻结的源码 ZIP。

## 6. 手机架构与部署

手机 Web → HTTPS/SSE/鉴权资产 → Relay → 电脑主动 WSS → Host → ApplicationSession → 同一 Runtime。电脑无需开放公网入站端口；Host/Relay 后端默认 loopback。Windows Host 仍需启动，电脑休眠/离线时不能继续执行。

首版功能是 Goal、目标选择、状态/截图/完整结果、纠正、暂停/恢复/Abort、请求绑定审批/选窗。配对二维码短时单用且需电脑确认；可撤销设备。Remote command accepted 与 applied/rejected/outcome_unknown 分开，远程投影序号不等于 RuntimeEvent.sequence。

2核/2GB服务器可作为小规模 staging 起点，不需要GPU。需真实域名/TLS、非root服务账号、仅公开443、正确WSS/SSE代理、受限凭据文件和安全日志。完整可执行步骤、systemd/Nginx及回滚见 [Relay 部署指南](../apps/relay/README.md)。localhost二维码不能供另一台手机连接。

Relay会接触授权明文载荷，当前不是E2EE；重启清空内存配对/session映射，需要重新配对。Host命令去重不承诺跨重启exactly-once。发布前必须真手机测试确认、撤销、锁屏返回、换网、重复命令、断线与重启；本轮尚未完成这些。

## 7. 协作、文档与发布

- 先读 AGENTS.md，保留用户未提交修改；小范围实现、集中审查、分阶段提交，通常通过 PR 合并。
- 测试/构建前说明是否使用付费模型或控制桌面；只有一个操作者控制同一目标。真实任务禁止未经许可购买、支付、发送或覆盖原文件。
- Windows 中文文件用 apply_patch，写后显式UTF-8读回；不要依赖管道/外部程序自动保留非ASCII文本。
- 不提交 `.env`、本机配置、登录profile、截图/轨迹、API响应隐私或恢复锁。部署包用显式清单、校验值和独立检查点。
- 以 `wszkxlllll` 提交时，仅配置仓库本地身份 `142909575+wszkxlllll@users.noreply.github.com`；核对author/committer及PR head，推送后核对GitHub归属，不修改其他作者身份或全局邮箱。
- 修改合同/默认值/验证状态时，同步这五份主文档的对应章节。历史审计保留为证据，不继续作为当前功能描述；README和DOCS-INDEX指向主入口，不再堆砌相互矛盾的“最新状态”。

发布必须列出准确代码/依赖版本、实际测试命令、通过/跳过/未验证项、已知风险、回退方法和需要用户完成的部署准备。不能把本地测试通过写成远端CI通过，不能把开发完成写成所有业务场景验收通过。

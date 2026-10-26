# 提交报告审查与 Windows 电脑端验证

日期：2026-10-24。审查和实测基线：`82151e79dae4b5d632440ef232f83acc9d9f6410`（main）。本文是报告编辑与复现工作的审查记录，不是比赛报告附件，也不是新增的平台支持承诺。

## 结论

Windows 独立 checkout 已完成实际克隆、锁定依赖安装、工作区类型检查、Web 生产构建和本机 Host 启动。官方 CUA 0.22.2 的生产 Computer 适配器完成了只读桌面观察与正常关闭，电脑端页面和说明面板可用。

仍需处理两项实测问题：已有有效 NodePath 可能被 PATH 前置检查拒绝；CUA doctor 返回 unknown 并退出 1。原样首次准备流程与完整测试套件没有全部执行，不能写成“完整冷安装和全套测试通过”。

报告正文可以继续修订和排版。正式提交前，应补充可复现版本与 Demo 环境，明确 Windows 安装范围，并保留尚未验证的能力边界。本次不修改业务代码，也不修订团队已有 Demo 的历史结论。

## 审查覆盖范围

| 文件或目录 | 本次覆盖 | 未覆盖的内容 |
| --- | --- | --- |
| [开始使用](../getting-started.md) | 安装步骤、脚本衔接、平台与凭据前提；后续执行 Windows 电脑端验证 | 原样首次交互准备全流程、真实手机配对和跨网验收 |
| [技术文档](../technical-guide.md) | 与报告及安装入口的范围一致性 | 所有架构描述的逐项实测 |
| [文档索引](../DOCS-INDEX.md) | 安装入口和平台范围说明 | 不代替功能验收 |
| [技术报告](../submission/technical-report.md) | 正文中的平台、任务验证、Demo 复现条件及安装入口 | 最终 PDF 页数、体积、排版和最终视频成片 |
| [第三方资源清单](../submission/third-party-resources.md) | 资源版本与安装方案的一致性 | 重新完成许可证、服务条款和素材授权审计 |
| [真实任务卡](../submission/real-task-cases.md) | 六类题面与报告表述的对应关系 | 逐张重新实跑，不能据任务卡认定所有任务成功 |
| [提交材料入口](../submission/README.md) | 文件用途、提交规格与待确认事项 | 报名平台最终上传验收 |
| `docs/submission/figures/` | 报告引用的图片目标文件存在 | 逐图视觉审查、标注及可编辑源文件审查 |
| `docs/history/` | 按需参考与当前问题相关的实现和记录 | 全量历史审查 |

公开仓库和安装文档页面在当次不带登录参数的访问中返回 HTTP 200；两个 Windows 官方驱动下载地址的 HEAD 请求返回 HTTP 200。安装指南的五个 Relay shell 代码块通过 `sh -n`，主要文档的 21 个本地链接目标存在。这些是当时的资源和文档检查，不等于服务器部署、驱动完整性、图片内容或最终提交物验收。

## Windows 实际验证

使用独立源码目录和依赖 store，没有叠加旧工作树修复或链接旧候选的 node_modules。Git、Node、Edge 是指南要求的前置环境：测试机原先缺 Git，补齐官方便携 Git 后完成 clone；Node、npx、Edge、PowerShell 7 复用已有安装。包管理器使用固定的 `pnpm@11.19.0`，驱动来自指南指定的官方 Windows x64 CUA 0.22.2 Release。

为无模型本机验证单独生成路径配置和空 env 文件，使用独立 CUA 命名管道与输出目录，不配置 Relay。这不是普通用户首次填写连接资料及模型密钥的原样交互流程。驱动单独下载和解压，本轮没有完成原样准备脚本的完整性验证分支，不据此声称发行物完整性已验证。

| 执行项 | 实际结果 |
| --- | --- |
| Git clone 并检出上述 main 提交 | 通过 |
| `npx --yes pnpm@11.19.0 install --frozen-lockfile --store-dir ...` | 退出 0；新依赖安装到独立 checkout 和 store |
| `pnpm run typecheck` | 退出 0，包含项目引用构建及 CUA spike 类型检查 |
| `pnpm --filter @computer-harness/web build` | 退出 0 |
| 已构建 CLI `--help` | 退出 0 |
| 明确排除项后的 Vitest | 134 个文件、2,000 个用例通过，0 失败、0 pending |
| 明确排除项后的 Node 测试 | 13 个入口、68 个用例通过，0 失败、0 skipped |
| CUA daemon `status` | 退出 0，daemon running |
| CLI CUA `--doctor` | 退出 1，overall unknown；具体问题见下文 |
| 生产 Computer `open → observe → close` | 退出 0；1280×720、physical 坐标的真实 desktop 截图已保存并查看，正常关闭 |
| 本机 Host 和电脑端页面 | 仅监听 `127.0.0.1:4317`；页面 HTTP 200，真实 Edge 中可见，说明面板可展开 |
| 本机管理只读 API | 本机 session 可用，无配对请求或挑战；未生成二维码 |
| 正常停止 | 专用 Edge 正常关窗；Host Ctrl+C 后返回提示符；相关 runtime 进程及 Host 监听为空，无强制结束 |

生产 Computer 验证使用当前构建的真实 `createComputer`，不是模拟实现；grounding 为 off。该路径没有执行 GUI 动作、模型请求、输入任务、切窗或业务提交。只读截图通过不能替代输入、跨应用和业务成败验证。

## 实测问题与修订原则

### 1. 已有 NodePath 被 PATH 前置检查阻断

**影响：条件性安装阻塞，已复现。**

已有本机配置指向有效 Node，且已用该 Node 完成构建。仅对子进程移除 PATH 中的 Node 后运行生产准备脚本，脚本在第 98 行提前退出 1，提示安装 Node.js 22.13.0 或更高版本。此时配置中的 Node 文件仍然存在。

原因见基线源码：[setup-mobile.ps1:92-127](https://github.com/wszkxlllll/Computer-Harness/blob/82151e79dae4b5d632440ef232f83acc9d9f6410/scripts/setup-mobile.ps1#L92-L127)。脚本先通过 `Get-Command node.exe` 从 PATH 找 Node，失败就退出，之后才读取已有配置的 NodePath。

建议优先读取并验证已有 NodePath；需要创建新配置时再从 PATH 自动发现。暂不改代码时，指南应明确已有配置路径仍要求 PATH 中有合格 Node。该问题不代表正常安装 Node 并重开终端的新用户必然失败。

本次只触发原脚本最前面的失败分支，没有进入配置写入、交互提示、依赖安装或驱动校验；未修改原脚本来制造复现条件。

### 2. 官方配对驱动的 doctor 未通过

**影响：诊断链未通过，不能据此宣称能力全部健康。**

诊断确认 SDK/daemon metadata 为 0.22.2 配对，工具清单有 57 项，但结果为：

```text
session: unknown / desktop_capture_scope_unconfirmed
health: unknown / session_start_invalid
permissions: unknown / session_start_invalid
cleanup: unknown / session_start_unknown
overall: unknown
exit code: 1
```

基线源码：[默认会话创建与失败传播](https://github.com/wszkxlllll/Computer-Harness/blob/82151e79dae4b5d632440ef232f83acc9d9f6410/packages/computer-cua/src/capability-doctor.ts#L155-L164)、[会话状态判定](https://github.com/wszkxlllll/Computer-Harness/blob/82151e79dae4b5d632440ef232f83acc9d9f6410/packages/computer-cua/src/capability-doctor.ts#L338-L351)。0.22.2 路由要求 `desktopUnlocked === true`，否则不继续 health/permissions 检查。

同一驱动随后在另一个新会话中完成生产 Computer 的真实桌面观察。因此当前证据是“doctor 未通过，桌面观察可用”，不能推导出 CUA 完全不可用，也不能写成全部能力健康。需要定位原生会话状态与 doctor 判定的兼容性，不能只把 unknown 改成 supported。保留窗口、输入、权限及未知结果处理边界。

doctor 的 cleanup unknown 保留为原结果。收尾已通过启动器正常停止本轮独立 daemon，最终无该驱动进程；没有重放 doctor 旧会话。

### 3. 首次自动就绪探针超时不列为产品启动失败

首个自动探针把每次 HTTP 请求超时设为 2 秒，未取得成功响应，保留了失败记录。随后没有重启 Host，同一进程的页面在 Edge 正常显示并返回 HTTP 200。

实测同一 Host 的 `127.0.0.1` 请求为 6 ms，`localhost` 为 2,056 ms，超过原探针时限。Host 仅监听 IPv4，localhost 地址列表先列 `::1`，后列 `127.0.0.1`。IPv6/IPv4 回退是可能解释，但没有进行网络栈跟踪，不能当作已证实根因。

按实际 HTTP 与可见页面证据认定页面可用；首次失败作为探针时限不足保留，不计为产品启动失败，没有为此修改产品配置或安全检查。

### 4. 非阻塞 Fastify 告警

真实 Host 控制台出现 `FSTDEP023`：顶层 `disableRequestLogging` 选项已弃用。位置见基线 [server.ts:76](https://github.com/wszkxlllll/Computer-Harness/blob/82151e79dae4b5d632440ef232f83acc9d9f6410/apps/host/src/server.ts#L76)。该告警没有阻止监听和页面访问；本轮没有通过升级依赖、屏蔽日志或修改源码消除它。

## 报告与安装文档待收口事项

1. **记录 Demo 复现环境。** 安装指南明确默认官方 CUA 0.22.2 不含后续 Windows 输入修复；技术报告第 5.4 节展示跨应用微信交付，但未列出该次 Demo 的源码提交、实际驱动来源与版本。建议补充源码、驱动、模型及必要应用登录条件。上游修复已合并不代表默认安装已包含修复；也不能反向推断历史 Demo 不真实。
2. **电脑和 Relay 固定同一版本。** Windows 步骤直接 clone 默认分支，Relay 步骤则要求 `APPROVED_COMMIT` 并与电脑一致，但电脑侧未给出对应检出步骤。建议正式交付时让两端使用同一提交或 tag。这是版本漂移风险，不是本轮观测到的通信故障。
3. **明确安装平台范围。** 当前完整用户安装步骤仅覆盖 Windows，macOS 流程待补。报告中的 Windows/macOS 开发和平台适配验证不等于两端用户安装均可复现，建议在报告安装链接旁注明范围。
4. **补齐资源版本。** 提交资源清单仅写 CUA SDK 0.22.2，实际代码路由为 Windows/macOS 0.22.2、Linux 0.32.0。建议区分当前 Windows 安装方案与保留的 Linux 适配线，不因此扩展安装支持承诺。本项只是版本表述核对，不是重新完成许可审计。
5. **完成提交稿信息。** 基线报告团队名称、编号仍是占位；提交入口仍列最终代码、驱动、排版、成员和上传事项待确认。仓库公开安排的文字也应由团队依据实际安排更新，页面可达不等于平台已提交。
6. **保留任务与无障碍证据边界。** 六类任务卡是题面，不能据此宣布所有任务成功。报告现有“若干任务测试”“代表委托”和实际用户测试、读屏/截图限制应保留，不新增未经验证的总体成功率或用户效果。

相关位置：基线 `docs/getting-started.md:18-20,118-124,140-147`，`docs/submission/technical-report.md:9-11,49,183-211,281-283,309-319`，`docs/submission/third-party-resources.md:5`，`docs/submission/README.md:33-39`，`packages/computer-cua/src/cua-sdk-platform.ts:19-35`。这些位置描述上述已审查基线，不代表未来 main 行号不变。

## 测试子集和未执行项

本轮为限定范围验收，没有完成原样首装交互和完整性验证分支，也没有执行 `setup-mobile.test.ps1`、未经筛选的 `pnpm test` 或完整 CI job。仅执行了原生产 setup 的 NodePath 前置失败路径。

没有删除断言、修改测试文件或变更 Vitest 配置来取得通过结果。涉及来源文件摘要或文件内容精确比较的入口未在本轮运行，整文件排除如下。此处只说明本轮范围，不修改项目现有测试或发行验证要求，也不建议删除项目校验。

### Vitest 排除的七个文件

```text
packages/computer-cua/src/cua-driver-computer.test.ts
packages/computer-cua/src/windows-visible-window-capture.test.ts
packages/trajectory/src/index.test.ts
apps/host/src/relay-roundtrip.test.ts
apps/host/src/managed-browser-profile-service.test.ts
packages/computer-cua/src/managed-browser-profile-recovery.test.ts
packages/computer-cua/src/managed-browser-host.test.ts
```

使用默认 include，额外传入上述逐文件 `--exclude`；worker 设置为 `--minWorkers=1 --maxWorkers=2`，同时输出 default 和 JSON reporter。不得将该结果称为默认 Vitest 或 `pnpm test` 全套通过。

### Node 排除的八个文件

```text
scripts/life-eval/start.test.mjs
scripts/life-eval/prepare-batch.test.mjs
scripts/life-eval/life-eval-runner.test.mjs
scripts/history/2026-10-24/stage4-local/evaluate-trajectory.test.mjs
scripts/life-eval/summarize.test.mjs
scripts/travel/metrics.test.mjs
scripts/travel/tui-collector.test.mjs
scripts/travel/travel.test.mjs
```

剩余 Node 入口按以下命令执行：

```powershell
node --test --test-concurrency=1 --test-reporter=tap `
  scripts/cross-window/cua-probe.selftest.mjs `
  scripts/cross-window/cw01-runner.selftest.mjs `
  scripts/cross-window/life-task-policy.selftest.mjs `
  scripts/cross-window/local-screen-recorder.selftest.mjs `
  scripts/cross-window/provider-description-probe.selftest.mjs `
  scripts/provider-ark-conformance.selftest.mjs `
  scripts/cross-window/sdk-managed-browser-probe.selftest.mjs `
  scripts/cua-window-handoff-probe.test.mjs `
  scripts/life-eval/supervision.test.mjs `
  scripts/autonomous/batch-host.test.mjs `
  scripts/history/2026-10-24/execution-segment-api-conformance-metrics.test.mjs `
  scripts/travel/shanghai-pilot-policy.selftest.mjs `
  scripts/voice/probe-qwen-asr.test.mjs
```

### 本轮未验收

- 手机扫码、生成配对挑战、真实手机配对和跨网络 Relay；新建公网 Relay、DNS、TLS、systemd/Caddy 实际部署。
- 模型 API、GUI 输入、切窗、中文编辑、跨应用完整 Demo、业务任务和逐张任务卡重跑。
- macOS 用户安装与实机验证。
- 最终 PDF、视频成片、图件视觉与可编辑源文件、许可及服务条款和素材授权的最终确认。

本轮结束时没有发起模型或业务 Run，没有真实手机连接。原始日志、截图和私有运行配置在测试环境保留，不随本记录公开。发布本审查记录时没有追加构建、测试、CI 查询或发布验收；文中的执行结果均来自前述已完成的测试阶段。

## 建议顺序

先处理 NodePath 条件和 doctor 诊断差异；同时补齐提交版本、Demo 环境、平台及资源版本表述。之后由具备相应环境和授权的测试方补齐原样首次安装、完整离线套件及尚未验收的平台/交互范围。简单页面和只读观察的结果与完整跨应用 Demo 分别记录。

# 队友 PR 与平台分支合入审查（2026-10-03）

后续 Mac 整合以[跨分支兼容审查](./macos-runtime-surface-integration-2026-10-03.md)为准：下文对 `5addbdc` 的问题清单是历史快照。新整合保留完整无标题窗口身份清单，将 Mac 代理窗口过滤限定 darwin，并加入 Windows/Linux 几何反例；不以历史快照判定新版本已通过或未整改。

## 当前集成结论（2026-10-03 21:20，上海时间）

PR #18、#19、#20 的有效内容已经选择性吸收到 `codex/runtime-surface-preview-20261003`，不是把三个旧 head 依次整体 merge。集成提交保留 `Co-authored-by: Yao GX <guanxiongme@gmail.com>`；原 PR 的历史仍由 GitHub 保存。

| 来源 | 已吸收内容 | 集成时修正 | 不吸收内容 |
| --- | --- | --- | --- |
| #18 | 政务、社区缴费、就医候选任务卡与 manifest | 修复三处 JSON 转义；参数化固定账期/日期；标明候选、未验证、非成绩；宽集与精选集不重复计数 | 机器专属 Linux 大指南、过时分支与运行说明 |
| #19 | Plasma X11 / CUA 0.32.0 作者实机报告；Monitor 边界测试意图 | 用已提交的 approval/user-input 事件 Promise 代替固定轮询，保留事件顺序断言 | 将单次作者报告扩大为当前 Runtime 或 Wayland 已验收 |
| #20 | Windows/macOS 0.22.2、Linux 0.32.0 双 SDK alias、按平台懒加载、Doctor 与文档 | Doctor 先严格校验 SDK/daemon 相等，再检查 contract/health；按 alias 缓存；增加双向错配和真实 alias import 测试；保留 Surface/probe/multiline | 跨版本错配误判、覆盖当前 adapter 的旧共享文件 |

集成后 Node 24 冻结回归为 106 个测试文件、1274/1274 通过；根类型构建、历史 0.22.2 spike 类型检查和 computer-cua 14 个测试文件/298 项测试通过。独立审查无 P0/P1。当前三个原 PR 不应再原样合入本分支，否则会重新引入已修正内容或覆盖当前 Surface 生命周期；它们可以由作者关闭、改为指向选择性集成提交，或按团队需要保留为历史审查记录。

macOS 兼容分支仍没有开放 PR，且候选过滤的平台作用域与无标题 child/sheet 保留问题尚未整改，因此本轮没有吸收。后续应基于当前分支重新提最小 PR。

## 合入前复审快照（2026-10-03 19:48，上海时间；历史）

本节是再次从 GitHub 获取的当前结果，不是沿用首次审查缓存。开放列表仍只有 #18/#19/#20，没有新增或关闭的开放 PR；三者 head 都未更新，下面的整改尚未体现在远端提交中。#17 为 CLOSED、未合并；#14/#15/#16 为已合并历史。Pi 当前 HEAD 为 `d9495c21d1ae1c6bf58b721b319a5fce9ca6cd79`，另有 Surface、probe、多行输入、手机端和 README 等未提交改动。

| PR | 当前 head | 最新可见 CI | 合并状态 | 能否原样吸收 |
| --- | --- | --- | --- | --- |
| #18 | `c76b108bf91b74965395043d259966482dc69da0` | run 36978062762 全矩阵绿 | MERGEABLE / CLEAN | 不建议整个 PR 原样合；有效就医/缴费任务卡可以吸收，先修损坏的政务 JSON |
| #19 | `e4ce63478774b191c6b91df03f68e7329f937d7c` | run 36981223074 Windows 和汇总失败，其余绿 | MERGEABLE / UNSTABLE | 独立验证事实可吸收；最终活动指引需与 #20 同步，当前红未重跑 |
| #20 | `9ede2e98079c051c422449acae1394b9b67cccca` | run 37094307862 全矩阵绿 | MERGEABLE / CLEAN | 不能直接替换本地 adapter；先修版本配对，再人工集成共享文件 |

这次重新读取 #19 失败 job 日志，仍为 Monitor 的 `waitUntil` 在 `packages/runtime/src/index.test.ts:746` 未达到条件，结果 946 passed / 1 failed；没有新失败类型。这次也重新读取 #18 四份完整 JSON，政务 candidate 仍 INVALID，其余三份 VALID；重新读取 #20 的 `validateMetadata`，仍缺 SDK/daemon 相等检查。macOS 分支 SHA 仍为 `5addbdce7f60599aa077a2d5bbaa0dd3f8a3a74d`，相对 voice 仍 ahead 3 / behind 12。

GitHub 的 MERGEABLE 只说明已提交目标分支可自动合并，不包含当前 Pi 的未提交变更。当前 adapter 仍直接依赖 0.22.2，已新增 `windowRelationshipProbe` 参数及多行 `type_text` 路径；#20 的 SDK seam 尚未吸收。因此 GitHub CLEAN 不能作为覆盖本地共享文件的依据。

吸收决策：有效任务卡、历史 Linux 配对证据、SDK 分平台路由思路可以复用；损坏 JSON、旧的“路由尚未实现”活动说明、doctor 的跨版本误判以及 macOS 全平台几何过滤/无标题窗口删除规则，不应照搬。README 的成员分工新增段落不重新吸收，领域入口归入文档索引，保留当前产品主线。

## 结论与事实边界

当前开放的队友 PR 为 [#18](https://github.com/wszkxlllll/Computer-Harness/pull/18)、[#19](https://github.com/wszkxlllll/Computer-Harness/pull/19)、[#20](https://github.com/wszkxlllll/Computer-Harness/pull/20)，作者均为 `Tangs-mo`，目标分支均为 `codex/voice-streaming-notices-20260928`。三个 PR 是栈式提交：#18 → #19 → #20，不能当成三个完全独立的 diff 审查。

方向总体正确：平台 SDK 配对留在 Computer adapter；任务卡不改 Runtime 协议；macOS 的平台证据可以不同，但必须归一化为共同的窗口关系和动作结果合同。建议先做下述小整改，再按栈式顺序合入。CI 绿不代表真实桌面动作已经验证。

本轮读取 GitHub PR、分支比较、源码和失败日志，独立解析四个远端 JSON。没有切换工作树、执行真实 GUI/模型 API、安装 SDK、运行本地编译，也没有合并、推送或修改 PR。以下 CI 是 GitHub 已有结果，Linux 实机结果来自作者报告。

| 对象 | 目的 | 当前 GitHub 状态 | 本轮判断 |
| --- | --- | --- | --- |
| #18 | 就医与社区缴费 D01 任务卡、manifest、交接草稿 | MERGEABLE / CLEAN；四矩阵及汇总绿 | 政务候选 JSON 损坏；先修或明确移出活动 JSON |
| #19 | Linux 0.32.0 配对和独立验证文档 | MERGEABLE / UNSTABLE；Windows 单测及汇总红 | 红来自 Runtime Monitor 等待测试；另需同步 #20 已实现状态 |
| #20 | Linux 0.32.0、Windows/macOS 0.22.2 SDK 路由 | MERGEABLE / CLEAN；Ubuntu Node22/24、Windows Node22、macOS Node22及汇总绿 | adapter 分层合理；doctor 丢失 SDK/daemon 版本一致检查，先修 |
| macOS 兼容线 | 窗口激活证据、窗口候选过滤、浏览器清理、手机重连 | 没有开放 PR；与 voice 分支分叉 | 先约束平台过滤、保留合法无标题窗口，再基于当前目标提 PR |

## #18：任务卡和评测材料

独立 JSON 解析：`eval/medical/medical-d01-manifest.v0.json`、`eval/community-payment/community-payment-d01-manifest.v0.json` 和社区 candidate manifest 均通过；`eval/government/government-candidate-manifest.v0.json` 在 `taskFamilies[1].manualChecks[1]` 第 116 行失败，字符串内直引号未转义。作者已在 PR 说明该文件 INVALID，但加入活动 `.json` 会让后来扫描目录的工具失败，不能仅靠口头交接。

任务卡区分 development/heldout，并写明不付款、不提交预约等停止点，符合当前人工检查路线。医院公众号、小程序和物业 App 的入口可行性仍需要领域负责人实机确认；这些是候选任务，不能记为完成率证据。

与当前本地工作重叠：`README.md`、`docs/DOCS-INDEX.md`。领域内容可进入独立任务文档，README 应保留本轮产品叙事，不把成员分工表重新插回前半部分。新增 `docs/government-task-cards.md` 与上海 pilot 的政务任务应登记主入口和交接关系，避免两套活动题库被误用。

给实施 Agent 的修复提示词：

> 在 #18 自己的分支修复政务 manifest 的 JSON 转义并解析全部新增 manifest；若尚不能作为活动任务使用，将交接原文放在 docs/history，并移出活动 eval JSON。保留原题意，不补造验收结果。将任务卡链接并入 DOCS-INDEX；README 只留合适的领域入口，合入时保留当前产品叙事。真实入口验证继续由领域负责人执行。

## #19：CI 红灯与文档状态

失败 run：[36981223074](https://github.com/wszkxlllll/Computer-Harness/actions/runs/36981223074)。Windows 结果为 92 个文件通过、1 个文件失败；946 个测试通过、1 个失败。失败测试为 `packages/runtime/src/index.test.ts` 的 `RunController Monitor online consumer > defers Monitor help until the action, ToolResult and post-action observation are committed`；`waitUntil` 报 `condition was not reached during the deterministic test window`。`ci-required` 是矩阵失败的汇总，并非第二个独立缺陷。

#19 只改文档，没有修改失败测试。相同栈上 #18 和后续 #20 Windows 都通过，支持它属于间歇性等待问题的判断，但本轮没有证明具体调度根因。可重跑该失败 job；若再失败，使用事件/Promise 同步替代固定次数 `setImmediate` 轮询，保留原有顺序断言，不放大时间窗掩盖问题。

#19 的 `docs/getting-started.md`、`docs/linux-platform-adaptation-2026-09-17.md`、Linux 指南仍写“仓库依赖 0.22.2、路由尚待批准、仓库 CLI 不可用”。#20 已实现路由，所以两者一起合入后这些描述过时。历史验证报告可以保留当时状态，但活动使用指引必须更新为最终配对。

冲突面：`docs/DOCS-INDEX.md` 与本地修改直接重叠；`docs/getting-started.md` 与新手机 Quick Start、第三方版本说明存在语义联动。Linux 长指南中个人机器信息、绝对路径应作为示例模板处理，不能替代通用上手入口。

给实施 Agent 的提示词：

> 在 #20 最终分支更新 #19 活动指引：Linux SDK/daemon 同为 0.32.0，Windows/macOS 同为 0.22.2；真实验证范围仅 Plasma X11，不扩大为 Wayland。注明 CI 离线合同与实机验证的区别。#19 的 Windows 红先重跑失败 job；若重现，用确定性同步修复 Monitor 测试，不改生产语义。合并后再次确认最终目标提交的 CI。

## #20：SDK 路由与抽象质量

新增 `cua-sdk-platform.ts` 懒加载 npm alias，`cua-sdk-contract.ts` 描述 adapter 消费的结构类型。Provider、Runtime 和公共 `packages/protocol` 没有改动。按平台选择具体驱动版本符合“公共接口一致、内部平台实现可不同”的原则。作者报告 Linux doctor 和完整截图 Run 已成功；CI 覆盖类型检查、离线测试、Web build、CLI help，不覆盖 Windows/macOS 实机输入。

### 必须先修：doctor 接受错误的跨版本配对

`capability-doctor.ts::validateMetadata` 现在根据 **daemon 自报的 driverVersion** 查询 `SDK_EXPECTATIONS`，只要是 0.22.2/0.7.0 或 0.32.0/0.8.0 就返回 supported；旧实现会与锁定 SDK 版本相等比较。这样 Windows 0.22.2 SDK 连到 0.32.0 daemon、或 Linux 0.32.0 SDK 连到 0.22.2 daemon，均可通过 metadata 校验；health 又以 daemon 自报版本作为期望，不能补回这道检查。这正是本 PR 要解决的配对问题，不能削弱。

修复：先检查 `driverVersion === cuaSdkVersionForPlatform()`，再检查该版本的 contract；为两种反向错配各补测试，并确认最终 report 未判 supported。

### 可同时收敛

- loader 缓存只有一个 module，却公开支持 `platform` 参数。真实进程默认平台不变，通常没有影响，但显式请求不同平台仍会复用第一次缓存。删去无消费者的平台参数，或按 alias 缓存并测试。
- `setCuaSdkModuleOverrideForTests`、`resetCuaSdkModuleCacheForTests` 从生产包 index 导出，测试 seam 应留内部测试入口，避免形成公共替换 API。
- 结构类型用 `as unknown as CuaSdkModule` 连接真实 SDK，编译无法验证两个实际 SDK 是否匹配手写合同。为两个 alias 加编译期合同断言，关键 runtime 字段保持当前边界校验。
- 未新增独立 SDK 路由测试文件；当前测试通过 fake override 绕过真实加载。应补 win32/darwin/linux 的选择表、版本错配、lazy-load/help 与测试清理覆盖。真实 Windows/macOS doctor 冒烟可与后续验收合并，避免重复桌面测试。

与当前未提交改动的具体冲突面：`packages/computer-cua/src/cua-driver-computer.ts` / `.test.ts`（Surface、多行输入、driver类型和工厂）、`window-contract.ts`（owner/stacking/probe解析及输入工厂）、`managed-browser-host.ts` / `.test.ts`（profile清理及加载）、`index.ts`（新增Surface导出）、`dom-grounding.test.ts`、`spikes/cua-driver/uia-grounding-production-probe.ts`。`packages/computer-cua/package.json`、`pnpm-lock.yaml` 与当前 license/第三方声明有联动。新 Windows probe 本身没有直接 SDK import，但其 window DTO 消费必须保留。

集成原则：只把 import、factory construction 迁到新 SDK seam，保留本地 Surface Registry、WindowRelationshipProbe、multiline 的最终行为。不要以任何一整份旧 `cua-driver-computer.ts` 覆盖另一线。变更 alias 后扫描所有活动 SDK import；历史 probe 使用固定 0.22.2 要显式标注，Linux 0.32.0 验收不能误用历史 probe。

给实施 Agent 的提示词：

> 基于 #20 修复 SDK/daemon 严格版本配对，补两种跨版本错配与路由/lazy-load测试；收敛 loader 缓存和测试导出。保留公共 Harness 协议，不将 CUA 私有类型上移。待 Surface 主线稳定后人工整合重叠文件，执行 typecheck、computer-cua/app-runtime/Runtime 回归、CLI help，并在 Windows/macOS/Linux 分别记录实际 SDK/daemon 配对。更新活动文档、第三方 notices 和 lockfile，保留队友作者信息。

## macOS 分支：需要的最小整改

`codex/a-line-macos-compat-20260928` 当前 SHA `5addbdce7f60599aa077a2d5bbaa0dd3f8a3a74d`，相对 main 前进 3 个提交；相对 voice 分支前进 3、落后 12，尚无开放 PR。主要包为 computer-cua、app-runtime 窗口匹配、web 的 SSE 重连；没有修改 Harness 核心协议。

合理部分：`bringWindowToFrontOnce` 委托统一 `activateWindowTarget`；解析 Cocoa/AX 的实际 foreground/window identity；ephemeral profile 在进程未确认退出时保留；手机断网 12 秒提示并在恢复后清除。

需要整改的候选归一化：

1. `isMacMenuBarWindow` 和 `isMacProxyWindow` 没有平台门控，按位置/几何/名称过滤在 Windows/Linux 也生效。例如原点宽≥600、高≤48的有效工具栏或窄窗口可能消失。平台私有证据应在 darwin producer/normalizer 内解释。
2. `normalizeWindowInventory(...dropUntitledSiblings: !onScreenOnly)` 会从完整 inventory 删除同应用的所有无标题窗口。有效保存 sheet/dialog 也可能无标题，这会妨碍当前主线“发现所有已打开候选并管理 child Surface”。应保留完整身份清单；只在首次自动匹配评分中降低服务窗口优先级，不在原始清单删除合法候选。
3. `window-target-matcher.ts` 同样按 appName 降低无标题候选，但没看 owner/kind。可以作为首次匹配的偏好，不可作为手动picker或Surface完整性依据。当前 Surface 主线应生产明确的关系，避免第二套启发式生命周期。
4. macOS errorCode 新增 `WINDOW_ACTIVATION_UNCONFIRMED`，集成时确认所有用户交互/重选消费者处理它；不把“被拒绝且无输入”转成已执行。

给队友的最小整改提示词：

> 将 macOS inventory 特殊过滤限定 darwin；保留所有有效 PID/window identity，无标题dialog/sheet仍进入完整清单和手动选择。自动初选偏好由 matcher 管理，不删底层候选；用平台证据归一化为共同 WindowRelationship/Surface 合同。补 Windows/Linux几何反例、macOS无标题保存sheet和多窗口测试。在当前 voice目标上更新分支，保留受管浏览器进程未退出的profile保护与SSE重连改进。避免在旧window-contract上另建child生命周期。

## 合入顺序与交接

1. 队友并行修 #18 JSON、#20 doctor/路由测试、macOS 候选边界；主线继续实机Surface验证。
2. #18 整改后 → #19（检查失败job与最终文档）→ #20；同一目标base，保留栈提交作者。若主线先落commit，应先让队友更新目标再算冲突。
3. macOS 分支完成上述整改并基于当前目标提PR，再单独审查。当前没有可直接合的 macOS PR。
4. 合 #20 前由集成人处理 SDK seam 与 Surface/multiline重叠；合 macOS 时共享生命周期以主线合同为准，平台只提供证据。
5. 最终版本统一跑离线回归并补对应平台真实doctor/窗口流程；禁止把本轮本地未提交成果算成GitHub PR已包含的能力。

最近已合的 #14 是手机Relay/部署线，#15 手机UI/审批、#16目标模式已在 main；它们不是待处理冲突PR。本轮开放列表没有另一位队友的新增PR，后续有新链接再按具体head复审。

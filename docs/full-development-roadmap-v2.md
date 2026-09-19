# Computer-Harness 完整开发路线 V2：从审计修复到可评测的 GUI Harness

日期：2026-09-17  
源码审计基线：`39ff27f9a4ef5431450df6991793403ec890f993`  
性质：开发建议与验收计划，不是实施完成报告。  
本地复核修订：2026-09-17，已将会话、接管、环境所有权、指令/Memory合同及实验分组意见并入正文；修订文档不表示对应能力已经实现。
仓库入口：保留既有 Stage 6 作为共同入口；本路线使用 `DEV-0..DEV-8`，实机门槛使用 `LIVE-0..LIVE-6`，不占用正式评测准备的 G0 名称。

当前入口：[Stage 6](./stage-6-convergence-and-start-state-2026-09-15.md)。配套：[阶段验收清单](./development-acceptance-v2.md)。原始证据按需查[历史索引](./history/2026-09-17-roadmap-consolidation/README.md)，实施时以本文件和验收清单为准。

## 1. 对复核报告的结论

认可复核报告的主要源码判断、证据分级及首轮修复顺序。新增 R01 应立即修：本地强制敏感输入检查位于 unknown/矛盾/文本歧义提前返回之后，reviewer 的低风险结果可能导致最终 allow。新增 R02 成立：诊断摘要读取旧的顶层 kind/id/name/arguments，不遍历正式 flat calls[]；这损害诊断，不代表 Runtime 丢失执行调用。[S1、S2]

原外部 V2 审阅曾通过 GitHub 读取固定提交的 Risk Guard、CLI 诊断及 pnpm/action-setup action.yml。[S3] 当前文档整理以本地源码和归档复核为依据；179 项测试与 9 项缺陷探针属于此前本机复核证据，并非本轮重跑。本轮只修订文档，未修改业务代码、操作桌面、调用付费模型或变更远端设置。

我不同意把“无需作为第一次低风险体验的前置条件”解释为“完整项目不需要做”。旧方案是保守的首轮整改/放行计划，不是完整能力路线。本 V2 将指令修订、ContextTrace、Memory 生命周期与跨状态一致性、在线 Monitor、受控恢复列入明确的核心开发阶段。它们有交付物，不再无限期挂在候选项中。

必须区分：
- 确定性缺陷：有反例，修复并通过真实路径回归后关闭。
- 项目核心能力：需实现最小完整闭环，不能只加 schema 或空接口。
- 效果策略：必须实验，但没有收益时可以不默认开启。
- 不符合产品定位的要求：不为面试而强行实现，例如多个 Agent 争用一个桌面、每三步强制 Plan、所有事实随截图变化删除。

## 2. 三个完成里程碑

**REL-1：受控交互可用（DEV-0..2）。** 可以在专用可丢弃应用和隔离低风险环境中持续体验。具备 CI、关键缺陷修复、停止/接管、目标绑定、最小 TUI；不代表任意桌面敏感操作安全。

**REL-2：核心能力闭环（DEV-3..6）。** 指令、Context、Memory、Monitor、权限与恢复都有明确执行机制和回归用例。此时仍不能预先承诺成功率增益。

**REL-3：效果与交付闭环（DEV-7）。** 冻结实验版本、完成配对评测和失败案例分析，在一个明确支持平台完成干净环境交付验证。DEV-8 为下一次能力扩展，而不是 REL-1/REL-2 的无限前置项。

REL 编号仅用于产品里程碑；现有实验组 M1/M2 继续表示 Fact/Entity Memory。只完成 REL-1 不能宣称后续核心能力全部完成；达到 REL-2 但没有实验不能宣称 Memory/Monitor 已有效提升性能。每个旧缺陷按自身支持范围和回归独立关闭，不必等待整条路线结束。

## 3. 路线总表

| 阶段 | 目标 | 主要范围 | 主要出口 |
|---|---|---|---|
| DEV-0 | 基线与 CI，和修复并行 | 问题台账、生产回归、Hosted CI | 可重跑基线和合并门禁 |
| DEV-1 | 修确定性错误 | F02/03/04/05基础/06/07、F08具体规则、R01/R02、F10基础、F12净化 | 协议/预算/隐私/规则/清理不变量通过 |
| DEV-2 | 受控执行与最小产品 TUI | CUA doctor/target、接管、审批、micro-batch、app-runtime/订阅 | 专用 fixture 可交互运行，REL-1 |
| DEV-3 | Context V2 与指令修订 | CurrentInstructionView、revision、分区预算、ContextTrace、Provider preparation | 指令与最终请求可追踪 |
| DEV-4 | Memory 生命周期与状态对齐 | 依赖、needs_check、按需验证、召回/预算、事件物化一致性 | 工作记忆可维护、冲突可解释 |
| DEV-5 | 在线 Progress/Stall 闭环 | shadow→标注→有界 guidance→求助/停止 | 检测与干预机制，效果单独验收 |
| DEV-6 | 执行边界、隔离与恢复 | Host Policy、审批业务条件、CUA增强、持久未决动作、受控恢复 | 支持范围内故障恢复，REL-2 |
| DEV-7 | 联合评测与可交付版本 | 消融、风险/取消回归、发布候选、单平台安装验证 | 可信实验结论与 REL-3 |
| DEV-8 | 渐进工具与只读 Subagent | 工具发现、能力隔离、委派合同、返回结果生命周期 | 一次明确的扩展版本 |

阶段不是单个大 PR；每一阶段按独立测试边界拆提交。纯移动代码与行为修改分开。

DEV-3/4/5 的共享实施合同与公开来源缓存见[DEV-3/4/5 实施计划](./dev-3-5-implementation-plan.md)。编号保持：DEV-3=Context/指令，DEV-4=Memory reconciliation，DEV-5=Monitor；Risk Guard 与执行边界加固归 DEV-6，不将 Monitor 改号。该计划只定义 producer→consumer→持久化/失效→测试闭环，不表示目标能力已实现。

文件级执行见[分块重构施工表](./module-refactoring-work-plan.md)。其 RFT 工单按本路线所属 DEV 阶段执行，不要求先全仓重构再修缺陷。

### 3.1 现有基础与待新增合同（2026-09-17 本地复核）

下文未特别标成“现有”的交付要求均为待实现目标；不能因用了具体字段名就当作现有 API。新增能力不是禁止项，必须补生产者→消费者→持久化/失效→测试闭环。

| 模块 | 源码已有基础 | 本路线新增及其前置条件 |
|---|---|---|
| Memory | protocol 的 runId/subject/status/relatedTaskIds；MemoryStore 按 Run 隔离；工具提议 mutation、Runtime 提交事件后物化 | DEV-4 新增 scope、依赖失效、验证依据与 current/history 查询合同；不把现有 status 当自动失效器 |
| 指令与接管 | RunController 的 Inbox、pause/approval/用户输入；不是持久应用会话 | DEV-2 新增 quiesce、环境 owner、调度版本屏障；DEV-3 新增 InstructionState/CurrentInstructionView，不能直接调用尚不存在的字段 |
| Computer | CUA 目前以 PRIMARY_DESKTOP + foreground 派发，已有会话及私有帧引用 | DEV-2 新增可验证 target/focus/generation 合同；内部句柄不能直接充当通用协议。CUA、OSWorld 分别声明能提供什么，未支持不能伪造信号 |
| Context/Provider | ContextBudgetReport 有估算和数量；ProviderAdapter 当前只有 generate 主接口 | DEV-3 新增分区 Trace 和 prepared request 估算/发送合同，两 Provider 均须接入；现有数量统计不等于完整裁剪原因链 |
| Monitor | 有离线轨迹与分析基础，没有在线状态回访/停滞识别闭环 | DEV-5 新增有界历史、截图特征和候选检测；不能假定截图 ID 能判断页面相同或变化 |
| 恢复 | memory.updated→Snapshot→afterMemoryCommit，已有 rebuild 方法和未知结果停止 | DEV-4 新增版本/序列校验与物化幂等；DEV-6 新增跨进程未决环境核对。已有 rebuild 不代表自动 crash recovery 已完成 |

核查入口：`packages/protocol/src/index.ts`、`packages/runtime/src/contracts.ts`、`packages/runtime/src/run-controller.ts`、`packages/memory/src/index.ts`、`packages/context/src/index.ts`、`packages/computer-cua/src/cua-driver-computer.ts`。实施前再次确认这些位置的实际版本。

## 4. DEV-0：基线、问题台账与 CI

### 交付

保留 F01..F17，新增 R01/R02。每项记录基线、证据等级、反例、目标阶段、当前状态、实际测试、剩余范围。旧“探针 pass”标记为“成功复现缺陷”，不得作为修复验收。

在当前满足 engines 的环境重跑 typecheck/test；保留复核报告的 Windows/Node/pnpm 结果为历史基线，支持其他 Node/OS 的结论需各自 runner 验证。无需等待 CI 完美才开始写失败测试。

普通 PR 使用 Hosted Runner、最小读权限、无模型密钥、无桌面。核对模板真实安装行为，建立稳定聚合检查名；真实 API 和桌面验证独立。不要将公开 PR 执行到日常 Windows 开发机。[S4]

CI 记录构建、单元与合同测试、CLI help、锁文件漂移；保留合成测试报告，不上传整个 runs。分支保护、规则与发布权限要获得仓库所有者授权，按当前套餐/可用设置核实，不虚构已配置。

每次 PR 的必跑矩阵包含 Linux、Windows、macOS，三者使用同一受支持 Node 基线（满足仓库 engines），执行冻结锁文件安装、类型检查、构建、离线单元/合同测试与 CLI help smoke；`ci-required` 汇总三平台结果，不将 macOS 设为可忽略失败。另在 Linux 增加一档受支持 Node 版本做兼容检查，首版不扩展为所有 OS × 所有 Node 版本的全排列。具体 runner 镜像、架构和 Node 版本由实施时固定并记录。

macOS Hosted CI 只证明所测 runner 的代码与构建兼容性，不证明真实 Mac Computer Use 可用。截图、屏幕录制/辅助功能授权、焦点、点击及键盘输入须在获授权的真实 Mac 桌面单独验收，注明系统与架构；未执行时明确标记未验证，不以 mock 或 CI 成绩替代，也不默认覆盖 Intel 与 Apple Silicon 两种架构。

### 验收

一次真实 PR 能看到检查；失败不能通过 continue-on-error、跳过包或重写测试断言掩盖。记录本次实际通过/失败数，不长期锁死为 179。通过当前测试与发现新反例可以同时成立。

### 面试闭环

“如何证明这次修改没有破坏其他模块？”用生产路径回归、合同测试和 CI 回答，而不是“本机跑了一遍”。

## 5. DEV-1：关键错误先闭合

### 1A：Context / Memory

F02：把权威用户输入从可驱逐轨迹分离，保留顺序，完整驱逐 assistant/tool-call/result 组。固定区放不下就显式拒绝请求，不让模型靠 Memory 维护用户限制。

F05 基础：修单个超大事件、空历史固定区溢出的所有路径；明确这是估算文本预算，不冒充真实 Provider 硬 token 上限。加入有实际执行消费者的单记录大小边界；输出预留必须说明与 Provider 输入/输出限制的关系，在没有消费路径前不新增空字段，完整序列化预算放 DEV-3。

F03/F10 基础：新建、同值更新、异值 replacement、实体写入统一校验。检查 task/entity/run 引用和字符串/集合上限；读取文件用完整 schema，不仅看 facts/entities 是数组。非法 replacement 不能先 supersede 旧记录，也不能写事件或物化。

### 1B：Risk / Diagnostics

F08：移除“只要出现 view/draft 就整体跳过高风险词”的不安全短路。允许讨论付款历史等良性上下文，但用明确分类和回归处理，不能由一个描述词消除其他高影响信号。

R01：先计算不可被语义模型降低的本地约束。执行决策建议为：
1. 结构非法/Host 禁止 → deny；
2. 本地规则要求强制审批 → 保留 mandatoryApproval；
3. 对其余语义不确定项按预算复核；
4. 最终合并时，reviewer allow 不能覆盖 mandatoryApproval 或 Host deny。
`semantic_review` 是流程状态，不是可直接与 allow/deny 排序的风险等级。风险识别规则自身可能漏检；修决策合并并不使 hasProtectedInput 成为完美敏感内容识别器。

F06/R02：native tool_calls 和 strict calls[] 统一归一为安全诊断投影，再脱敏。记录工具数量、名称、id、结构/长度和必要诊断码，默认不记录 typed text、Memory value、路径与 URL 中的私人内容。未知 envelope 记录 shape/parse error，不回退存全文。

区分执行所需的本地私有事件、截图资产与可分享遥测。不要通过删除执行日志内容破坏重放后还声称可完整恢复。明确保留期、权限和安全导出；原始本地诊断必须明确 opt-in。

F04：实验 profile 与交互实机 profile 分离，resolved config 为唯一默认值来源。开启 TUI 不自动代表 guard 已启用；界面必须显示实际状态。实验显式关闭 Guard 保留，但实机关闭保护须明确确认。

F12 最小：终端 ESC/CSI/OSC 等控制字符净化优先于布局重写；模型/错误文本不能伪造审批区域。

### 1C：退出与清理

F07：为 flush/close、endSession、shutdown 等 awaited 操作定义总 deadline 和分步剩余预算。保留 GUI unknown outcome 终止，不将它重标为普通 cancelled。

“超时返回”“底层真的停止”必须是两个字段/状态。Promise.race 或 AbortSignal 不会自动撤销已经派发的 OS 输入；不合作的调用需要连接隔离/宿主进程生命周期处理，不能释放控制权后立即让新 Run 使用可能仍在执行的 session。进程终止只针对明确由应用拥有的宿主/daemon，绝不 kill 任意用户进程。[S5；设计建议]

### 验收反例

覆盖用户禁止发送后预算变小；单条/空历史预算溢出；Planning on/off 的非法 replacement；unknown/contradiction/ambiguous + protected input 的全部路由；reviewer allow/超时/错误；native/flat 等价日志；ESC 注入；close 永不 resolve。

R01 必须断言最终决策与 Computer.execute 调用次数，不仅断言 reviewer 被调用。F06/R02 的纯函数回归以后再加真实组装的 Mock HTTP/CLI 测试，消除 import main 的测试困难。

### 面试闭环

“为什么低风险模型复核不能绕过本地规则？”“截断会不会丢用户约束？”“更新失败是否破坏旧事实？”“退出卡死怎么办？”有真实代码路径可讲。

## 6. DEV-2：目标/人工接管/最小 TUI，同步建设

不等完整 Memory/Monitor 才接触实机，但这里的“实机”先指专用可丢弃 fixture。

### 2A：共用 app-runtime 与事件订阅

从 CLI 抽 resolved config、Provider/Computer 工厂、run 目录、诊断、Controller 组装。保留默认 CLI 语义。新 Run 用独立目录，不能绕开 writer 的 write-once 保护。

事件持久化并投影后发布只读订阅；UI 用有界增量队列和 sequence 恢复，不每 120ms clone 全历史。listener 异常不改变执行结果，缓慢 UI 不成为第二个执行调度器。

**应用会话与 Run：**当前 Controller 只能 start 一次，finished 后不能继续接收命令。产品 TUI 的应用会话持续存在，同一时刻拥有一个活动 Run。运行中的回答/纠正进入该 Run Inbox；结束后的新请求创建新 Run、新目录与审批状态。旧记录可继续查看，但旧 Action、Approval、Computer handle 不继承。

需要追问前一任务时，显式选择历史摘要/引用作为新 Run 输入并重观察；首版也可不提供此继承能力，界面须说明。Run Memory 不静默跨 Run 搬运。要支持任务/记忆 continuation，必须单独定义来源、导入与有效性合同，不能通过重新打开 finished Controller 实现。

### 2B：CUA 最小目标合同

复用现有 capability probe，产品化只读 doctor：SDK/daemon版本、权限、已声明/已实测能力、session 状态。不支持/未验证明确标记。

引入 Adapter 管理的 opaque target handle、session generation、geometry revision 和捕获坐标空间。初版保留全桌面基线；窗口捕获必须有显式坐标映射。UIA/background 只对验证过的控件启用；不把所有 foreground 改 background。[S6]

目标 binding 首先防输入落入错误窗口，不是假装应用窗口本身就是安全沙箱。相同窗口内的业务内容变化仍需审批专门处理。

### 2C：人工接管与调度隔离

TUI 编辑/审批前请求 quiesce。区分命令收到、停止新调度、已派发动作 settled/unknown、允许用户接管四个状态。不能收到 pause 请求就显示“已停止”。

允许撤销旧审批并接收纠正，但不能让普通 correction 直接绕过 waiting_approval。新增 revoke/invalidate 路径需要事件和明确优先级。

对已进入 Provider 的旧请求可取消请求级 signal，不必取消整个 Run；无法及时取消时，其迟到结果必须被决策版本屏障拒绝。真正派发 GUI 输入前仍检查最新版本。防并发的关键是调度边界，不是“把新版提示词放进下一轮”。

未执行动作作废；已执行动作保留；未决动作维持 unknown。旧批次不能在接管结束后自动恢复。

**状态转换与所有者：**当前 pause 仅接受 running，不能直接套用到 waiting_approval。实施前画清 running、waiting_approval、takeover_requested、quiescent、unknown 的转换，区分 Runtime 状态和应用控制状态。只有一个控制层决定是否已停止，UI 不能独立认定暂停成功。

展示审批本身不应递增一个会使该审批失效的指令版本；实际纠正、目标切换或环境变化才按对应规则作废候选。批准/拒绝、纠正、Abort、迟到响应的先后顺序必须在单一调度点线性化，加入竞态测试。

**跨 Run 执行所有权：**app-runtime 依据 Host 确定的环境身份记录 owner、session/连接 generation、在途动作和阻塞原因。RunId、新 socket 名不能代替桌面身份。DEV-2 至少保证同一应用进程内，旧 Run 未确认停止时不能把同一桌面交给新 Run；此时明确多进程控制尚未支持。DEV-6 再扩展为持久阻塞和启动核对，不提前引入分布式锁。

cleanup 超时可以返回诊断，但不等于释放桌面控制权。迟到的清理完成如何释放资源、如何保留旧 Run 终态需明确；不同桌面/VM 的独立运行不应被全局阻塞。

### 2D：审批与 micro-batch

审批绑定 candidate digest、decision/instruction epoch、目标 generation 和相关前置条件。DEV-2 先提供运行时版本与原始用户消息序列；完整语义指令视图在 DEV-3。

批准后重获状态；不能只刷新 observationId 使旧坐标通过。目标身份/几何与业务内容是不同校验项。对无法验证的敏感业务条件，暂不自动执行；用隔离模拟页面完成功能验收。

批次仍用窄白名单。每子动作已有截图；新增的是焦点/可编辑/目标匹配检查，失败就取消后续动作。单次 type 同样需要目标前置条件，不能只修 batch。无独立焦点信号时禁用敏感输入/限制场景；把批次拆开并让模型观察只是降风险，不是数学保证。

上述 target、generation、focus 与几何变化信号必须在 DEV-2 先探测再实现，当前不假定已有统一输出。Adapter 只发布它能验证的元数据，Runtime 校验与审批消费同一合同；缺失信息标 unknown/unsupported，不用 observationId 自增冒充环境变化检测。测试同时覆盖“只是重新截图、窗口未变”和“窗口/焦点真的改变”，前者不能使所有审批永久失效。OSWorld 与 CUA 各有合同测试与支持范围，业务条件识别不足的场景仍按本节限制处理。

### 2E：最小产品 TUI

只完成持续应用会话、活动 Run 输入、连续创建新 Run、状态、候选审批、暂停/恢复/Abort、Plan/Memory查看、截图入口、安全报告导出。中文/粘贴、resize、非TTY、EOF、异常退出恢复均有测试。模型输出显示“声明”，任务结束显示“外部验证未配置/通过/失败”。

非流式 Provider 显示请求中和耗时，不伪造实时思考。流式体验不是 REL-1 前置项。

### 验收与 REL-1

LIVE-0 离线→LIVE-1 只读→LIVE-2 Fake TUI→LIVE-3 专用 fixture。覆盖切到 TUI、目标窗口移动、输入框 disabled、弹窗夺焦、拒绝审批、纠正中批次、daemon 断连、退出挂起。先对支持范围验收；正常场景也必须能运行，不能用“全部拒绝”冒充完整可用。

通过 REL-1 即开始持续低风险体验，不等待 DEV-3..6。允许在此里程碑暂停功能扩张，优先优化实际体验；后续核心能力按各自阶段继续验收。

## 7. DEV-3：Context V2、指令修订和 Trace，正式核心阶段

### 指令状态

增加独立 `InstructionState / CurrentInstructionView`，不将其塞入模型可随意更新的 Memory，也不混淆现有 Planning 的 TaskSpec。保存原始用户事件、当前有效目标/约束、revision 与来源。

Runtime 对每次已接收有效用户变更维护单调 revision，用于决策/审批失效；自然语言的 add/replace/revoke 关系由主模型在正常决策中提出，含糊处澄清。不是“最后一句话覆盖全部旧消息”。

重要安全规则和授权单独存于 Host Policy / Approval 机制。derived summary 不是授权证明；仅引用真实消息 ID 也不能解除限制。明确安全约束放宽采用结构化确认，不能由 model memory / screenshot / subagent 提权。

第一版的权威来源仍为原始用户输入及其顺序；CurrentInstructionView 是带来源的派生视图。不能让模型提议 revoke 后直接删除原始“不上传”等约束。普通语义归纳有歧义时保留原文并澄清；敏感授权放宽须显式人类操作。后续若压缩原文，另行验证压缩、确认/不确定性与回退合同。

`instructionRevision` 跟随用户指令变化；`decisionEpoch` 可因接管/目标失效而改变。分别列出生产者、消费者、持久化和失效触发，不能把每次截图都视为用户指令修订。派发 GUI 前验证决策 epoch，不能只在请求开始时检查。

### Context 预算和组合

建立五类块：不可裁剪的当前权威输入/规则、当前任务结构、被选择的 Memory、完整近期轨迹组、当前 Observation。普通块竞争剩余预算。保护最新错误/拒绝/未决状态反馈；超大工具结果截断必须有标记与可查询路径。

给 Memory index/hot values 设独立软配额而非无界 fixed 占用。当前未生效/待核实事实不能无标记地出现在“当前状态”中。instruction view 放不下时明确要求澄清/缩小任务，不能无声总结解除约束。

Provider 提供无模型网络调用的 request preparation/estimation：统一语义依然在 Runtime，但序列化 profile、额外系统文本、schema、图像成本估算与输出预留在边界可见。没有 tokenizer 精确支持时记录估算与实际 usage，不宣称严格相同 token。

接口拆为有 IO 的资产加载/预处理和无网络的序列化/估算；含 AssetReader 的整体 preparation 不标为无 IO 纯函数。发送时复用已估算的 prepared payload，避免再次组装改变内容。requestId 对应每次实际尝试，区分主模型与 Risk reviewer，记录其关联决策和重试次数。

### ContextTrace

从本阶段开始固定 runId/requestId、compiler/provider版本、特性开关、instruction revision、selected/discarded IDs/reasons、各块预算、Observation引用、最终请求结构 hash。完整 prompt 只用于明确授权的本地私有诊断或合成 fixture；hash 不证明语义正确，也不支持单靠 hash 重放正文。

ContextTrace 是新增诊断合同，不是当前 ContextBudgetReport 的别名。Compiler 产生块选择与裁剪原因，Provider preparation 补最终 payload 估算/hash，调度层补每次请求标识，TraceStore/安全导出与预算审计消费。重试应能关联同一决策但区分请求尝试；超大工具结果的“可查询路径”也需在本阶段实现并验收，不能仅输出一个无消费者的引用。常驻未决/错误状态须来自 Runtime，而非依赖已经可能被裁剪的历史文本。

### 验收

覆盖：“不要上传”→“改PDF”仍保留不上传；“允许发给A”不自动授权发给B；晚到模型响应与旧审批失效；Memory挤占历史仍保留有效用户限制；长中文/大schema/单超大结果。Trace能解释一次具体裁剪。

### 面试闭环

“哪些内容常驻？”“旧约束怎样撤销？”“跨Provider预算怎么算？”“失败时模型到底看到什么？”可以明确回答。

## 8. DEV-4：Memory 生命周期与 Reconciliation，必须完成最小闭环

### 概念边界

当前实现没有 Memory `scope` 字段或 task/session/page 作用域系统：`MemoryState.runId` 与按 RunId 读写的 MemoryStore 提供 Run 级数据隔离；`MemoryFact.subject` 的 run/entity 表示事实描述谁，不表示权限或有效期；`relatedTaskIds` 用于任务关联及召回排序。现有 status 表示有效性状态，但不等于已经实现页面变化等自动失效机制。

本阶段设计需分开存储保留、当前有效性、本轮是否召回、权限四个维度。taskId 是关联，不必等同过期；来源事件证明写入上下文，不证明事实。scope 可以新增，但必须表示明确的适用边界，不能把 task/session/page 混成单线排序，更不能表示模型自行授予的权限。

### 新增 Memory scope：DEV-4 实施合同

推荐在 MemoryFact 增加判别联合 scope（待实现），首轮包含 `run`、`computer_session`、`target`：分别表示该 Run 内适用、依赖某次 Computer 会话、依赖某个目标实例。这里 computer_session 明确不是聊天会话。所有记录仍属于外层 MemoryState.runId，不新增跨 Run 记忆；subject 仍回答“事实描述谁”，relatedTaskIds 仍回答“与哪些任务相关”。实体身份本身不自动因窗口关闭而删除，其瞬时状态事实可具有更窄 scope。

- **生产与校验：**Memory tool 接受模型提出的 scope 类型；Runtime 绑定当前 Run、ComputerSession 与 Adapter 发布的目标引用/generation，不允许模型伪造或任选原始宿主句柄。跨 Run、已失效或不存在的目标引用在提交前拒绝；目标信号不受后端支持时明确返回不支持，不静默改为 run。
- **消费与更新：**召回先判断 scope 适用性，再按任务相关性/状态/预算排序；target 暂非当前目标时不注入 Hot Memory，显式查询仍可返回并标明不适用。确定的 session 结束/目标销毁或 generation 改变触发可重放的 Memory mutation，将相关事实标 needs_check 并记录原因；只是切焦点或重截图，不自动等同销毁或过期。重新观察不自动恢复 active，仍需带来源的新修订。
- **持久化与迁移：**scope 进入 mutation/Event、Snapshot、Store schema、工具说明和两 Provider 投影；派生适用性不另存一份容易漂移的状态。旧记录按显式迁移保留为 run 范围，不伪造目标绑定或验证证据；跨 Run 不导入。过期记录按历史保留策略处理，不直接删除事实历史。
- **防漏标边界：**run scope 也不证明登录、焦点或其他瞬时状态持续正确。模型把动态事实写成 run 是可能的语义错误，需提示词与真实 API 测试评估；动作前置条件和风险授权不能因此被放宽。page/document revision 首轮不加入：待有可靠生产者再扩展，不能以 ObservationId 代替。
- **前置条件与开关：**先完成 DEV-1 mutation/schema 校验、DEV-2 会话/目标信号及 DEV-3 Context 合同，再启用目标型 scope 的端到端路径。合同可用 Fake Computer 先开发；单个后端未支持时只声明其已验证范围。Memory 关闭时无新增工具、Context 内容、模型调用或遗留监听器。

验收须包含 FM12..FM15 的离线矩阵及两 Provider 的工具协议实验，最终用各后端获授权的受控 fixture 验证。测试的是新增 scope 语义，不以“多了一个字段”验收通过。

复用 active / needs_check / superseded 与实体 stale，不另起平行 confirmed/dirty/invalid 体系。增加必要的 dependency refs、失效原因与最近验证引用；字段必须有实际读写消费者。

### 机制

模型仍是自然语言事实的语义写入者。Runtime 盖来源/序列、校验引用和大小、处理可确定的依赖失效。例如 target generation 改变后，旧目标句柄与坐标定位依赖失效；不能因此删除“用户要编辑报告”这一类无关事实。

语义事实无法凭截图ID确认：账号是否登录、上传是否成功由下一轮主模型利用当前可见证据检查。需要时以显式工具更新/标记；不要每个frame额外调VLM。没有独立视觉识别时不能声称Runtime自动检测到页面写着Upload failed。

对 needs_check 按需展示“待验证原因”，避免把它当确定真相；恢复 active 需要新依据/修订，而不是重复写同值就视为外部验证。纯模型自报确认应保留其证据等级。

检索支持当前有效视图与历史查询，避免 memory_get(key) 将旧 superseded 与新事实混在一起又没有明确处理。选择策略把任务相关性、状态、依赖、近期变化和预算分开；不以最近更新时间独占排序。

默认 memory_get 查询 current，history 通过显式模式查询并标明 superseded。needs_check 仍可读取，展示待核实原因，不视为读取失败。现有旧记录已经携带 status，整改重点是默认查询语义与呈现，而非假定历史记录完全没有标记。

依赖合同先列清允许引用类型、绑定者、失效事件和 Context 消费方式，首版仅使用 Host/Adapter 能产生的 session/target generation 等信号。模型漏填依赖不能使危险动作获得许可；执行前置条件独立于 Memory 存在。新增最近验证引用必须区分模型声明与独立观测证据。

### Store 一致性

保持事件提交→Snapshot→物化视图。物化失败可停止并从已提交事件修复，不新增相互竞争的同步写入者。新增 schemaVersion/lastAppliedSequence 等应服务于真实校验与恢复。

上述版本/序列字段必须同时有迁移、重放幂等与原子物化消费者，不能只写入 JSON 却不参与恢复校验。

区分历史milestone、当前条件、持续约束。返回Home不自动撤销“曾进入Settings”；“当前在Settings”则需过期处理。语义冲突交主模型下一轮，确定性的ID/sequence/依赖冲突由Runtime拒绝或标记。

此处 milestone/当前条件/约束是设计语义，不是当前 MemoryFact 已有的 kind 枚举。持续用户约束的权威来源仍为 DEV-3 指令状态；Memory 中的引用不能覆盖它。页面内容冲突在没有独立识别信号时由主模型发现并修订，不能将这个例子写成 Runtime 已能自动识别。

### 验收

页面变化但目标文件不变；窗口重建后定位信息失效；task完成但事实仍有后续用途；登录状态变更需新证据；Plan completed与当前要求不混淆；同key冲突/失效实体/重放物化一致。模型不写Memory时系统仍能运行；不存在事实不应被自动编造补齐。

### 面试闭环

“只有模型写Memory，Runtime还能做什么？”“来源与正确性有什么区别？”“task完成是不是全删？”“各Store冲突怎么办？”都有机制和例子。

## 9. DEV-5：Progress/Stall 从观测走到有界干预

本阶段是核心必做，不无限期停在 shadow；但是是否默认开启干预由数据决定。

### 5A：Shadow

复用离线重复签名，在线记录动作相似度、明确拒绝/失败、目标相对截图变化、状态回访、Plan/Memory变动和模型自报。缺失Plan/Memory是缺信号，不是没进展。新Memory写入不自动清除停滞怀疑。

图片相似度与状态回访特征是本阶段新增算法，不是现有设施：从已持久化帧提取有界缩略特征，限定相同目标/几何下比较，处理采图失败及分辨率变化；相同/不同像素都不直接证明任务进展。实现特征生产、窗口淘汰、阈值、缺信号回退与成本记录，再启用对应规则；没有可靠特征时仅报告动作/错误候选，不虚构页面循环。

Shadow 功能可以在 DEV-2/3 后开始旁路收集；需要新增协议时先统一后并行。其开关不改变模型输入和动作。固定一个有代表性的开发样本包并完成标注与错误分析，不因“数据还可更多”无限延迟结束。

这里“不改变动作”指不主动修改决策和调度规则，不承诺真实桌面轨迹逐位相同；额外计算会影响时间，动态页面也会变化。记录 shadow 自身开销并限制计算预算。

### 5B：指导与升级

实现从正常到疑似、guidance、求助/停止的有界状态。把候选证据摘要插入下一轮正常请求，默认不额外调模型。设 cooldown、最大干预次数和硬预算；不得强制每三次Action调用Plan。

持续不确定时提出明确求助，不让模型无限自我反思。unknown outcome 的执行屏障高于 Monitor，不能让 replan 重新触发未决的外部副作用。

### 5C：验收

使用正常连续点击、慢加载、重复无变化、A-B-A循环、长时间Plan/Memory空转、无Plan的短任务。记录误报/漏报、干预次数、开销、干预前后同任务分支。阈值在开发集定，验证集冻结。

必须交付干预实现和对照结果；如实测无益，可默认 off，保留已验证候选机制与失败结论。这是验收后的策略选择，不是没有开发。

### 面试闭环

“正常探索与走偏怎么分？”“为什么不固定检查Plan？”“Hook是否真能强制模型改变？”回答包括：启发式检测有误差、guidance是软建议、硬停止由Runtime落实。

## 10. DEV-6：执行约束、隔离与恢复

### 6A：权限与风险的最终边界

完成 HostPolicy / model proposal / reviewer / human approval 的职责分离。Host deny不能由主模型、reviewer或普通approve覆盖；要变更Host配置使用独立受信配置操作。本地强制审批在所有路由保留。

审批既校验目标身份与几何，也校验重要业务条件：收件人、金额、文件目标等来自哪里、批准时用户看到了什么。候选digest只绑定动作参数，截图/字段不变检查也不能证明隐藏业务状态。无法独立核实时明确要求新观察、新决策/人工执行，而不是宣称适用于任意支付页面。

扩充既有Guard的对抗测试：页面指令诱导、误分类、模糊target、reviewer错误、敏感内容模型漏报。独立UIA/窗口信息按需交叉校验；不训练一个专用risk模型作为必做前提。

### 6B：可用的环境隔离 profile

从 DEV-2 开始就使用可丢弃fixture/测试桌面；本阶段产品化隔离配置、准备、reset和诊断。至少一个可重复的隔离桌面环境，与日常账号/凭据分离；按能力限制共享目录、剪贴板、网络或权限。

本地window-targeted模式说明不是安全沙箱：目标应用可能访问网络/文件或弹新窗口。权限表同样不能识别所有点击语义；隔离是限制损害面，不替代风险判断。

优先集成既有虚拟环境/OSWorld与CUA配置，不自行实现通用虚拟化平台。新增targeted input、background、window capture或UIA要各自记录能力合同；新增能力不改变现有GUI基线，分别验收。[S6]

### 6C：受控恢复

保留执行前后事件和未决状态；异常进程退出后先以只读方式重放日志、验证schema/sequence和尾部完整性，再重建物化视图。明确文件append与可承诺的持久化级别，不把flush队列自动视为断电持久。

新进程不自动续发旧ActionIntent。重新连接产生新session/target generation，旧批准失效，重观察再规划。对已经dispatch但结果未知的动作保留持久“未决”标记；不能通过重新创建Run清除该警告并盲目重发。

在可验证的低风险任务里实现恢复继续；支付/发送等无查询或无可确认结果时，停止并交由人工核对。无需用一个不可实现的“语义等价click检测器”替代明确未决屏障。

### 验收

进程在dispatch前后退出、结果写回前断连、半行JSONL、物化失败、旧审批恢复、daemon重启、session句柄复用。必须同时证明一类低风险任务能够恢复，以及未知高影响动作不会自动重做。

### 面试闭环与 REL-2

“Abort不成功怎么办？”“日志重放等于安全续跑吗？”“沙箱限制什么？”“模型伪装危险动作时Runtime的真实边界是什么？”具备支持范围内的可执行回答。

## 11. DEV-7：联合评测、重构收尾与交付

评测从 DEV-0 就存在，本阶段做冻结后的正式比较，不是在此时才开始测试。

### 7A：分轨评测

工程合同轨：不依赖模型随机性，验证版本/审批/预算/引用/取消/日志/unknown的硬不变量。

GUI能力轨：固定任务起始快照、模型配置、primitive action与model request预算、图像策略、超时口径。保留 Stage 6 的单模块矩阵，不用组合实验替代已有 Batch 或 Memory 形态对照：

| 组别 | 配置 | 比较目的 |
|---|---|---|
| P | raw Context，增强关闭 | 原始基线 |
| C | recent Context，其他增强关闭 | Context 策略 |
| B | C + 受限 Batch | 减少模型轮次及其失败代价 |
| M1 | C + Fact Memory | 事实保留/召回 |
| M2 | C + Entity Memory | 实体组织的额外收益 |
| N | C + Planning | 阶段规划 |

完成单模块对照后再选 +Plan+Memory 等组合，并对选定配置做 Monitor on/off。Memory 的工具和 prompt 属于干预的一部分。Guard、targeted input、UIA、background 和图像模式须在对比双方一致，或明确作为独立变量。

DEV-3/4/5 各阶段先在 Development 做小规模效果检查，依据结果决定参数和默认值；DEV-7 承接冻结后的正式确认与总结。Validation 不用于这些阶段反复调参。

风险轨：独立报告已知风险样本的漏放、误审批/误拒、候选过期与人工接管；一次正常成功不证明安全。

Provider轨：各自官方支持/已验证格式做实际系统比较；需要隔离protocol影响时额外做内部消融。不要为形式公平硬改成同JSON，也不要把跨Provider总token数当天然同价。

### 7B：结果与归因

同时报告任务成功分子分母、类别、配对胜负、动作/请求、输入输出usage、延迟口径、人工干预、unknown/失败分类。runtime结束、模型声明成功、external evaluator分开。

Counterfactual的决策点重放只支持局部输出差异；端到端比较需要同环境快照分叉并重新执行。20+20是起点，不是自动具有高统计把握。验证集不反复调阈值；使用后转开发集必须显式重新划分。[旧方案01；设计约束]

新增结构化UI/CDP、sandbox profile、修复前后版本分别标记。环境reset耗时可以排除，但必须写清统计边界，不能在不同组采用不同口径。

### 7C：重构与交付

收尾大文件的行为保持拆分与依赖测试：Runtime不导入UI/具体Driver，Provider不自己操作Computer，生产代码不依赖spikes。不要把所有Provider parser合并成巨大通用适配器。

候选交付workflow继续产生源码、manifest、checksum。随后至少选一个主要支持平台完成实际可运行安装：workspace依赖闭合、CLI/TUI入口、native SDK、明确daemon获取与校验、干净机器启动与卸载。不要把源码归档叫安装包。其他平台按实际证据添加。

整理至少几个真实失败→定位→修复案例，更新架构说明、支持矩阵和限制说明。每个结论链接真实报告而不是手填成功率。

### REL-3

交付一版可运行、可重现、有限范围验收的产品和实验报告。到这里当前主项目的核心整改闭环完成，不必等待DEV-8。

## 12. DEV-8：一次明确的扩展版本——渐进工具与只读 Subagent

### 8A：渐进式工具暴露

当加入已确认有价值的CUA/研究只读工具后，在受控实验里实现简要能力目录→候选完整schema→search/inspect补救。不为证明“可扩展”虚构80个无用途工具。

工具被发现不等于被授权。隐藏工具仍需Runtime执行校验；历史调用保留对应工具schema版本，不能因当前目录变化导致历史无法解释。能力不等价要显式拒绝/兼容模式，不偷偷改变语义。

验收重点是漏召回时能找到工具、无权限工具不能靠inspect获得执行权、总成本和错误选择率是否改善。即使当前小目录默认全量，机制与实验可以完成。

### 8B：Advisory Subagent

8A 工具检索与 8B 委派分别验收，不互为硬前置；当前目录较小时，Subagent 可使用静态白名单先完成受限委派闭环。

落实用户既定定位：主Agent独占GUI执行；子Agent仅分析/检索，不能直接改主TaskStore/Memory。只读不等于无数据泄漏风险；子Agent同样受工具、网络与可见上下文限制。

委派合同包括goal、context slice、allowed tools、预算、deadline、parent instruction revision、结构化返回和来源。纠正主任务后，旧结果取消/标过期，不无条件注入。主Agent明确采纳后才持久化。

运行采用独立局部状态，子结果不是新的用户指令。子Agent超时、取消、过量输出、错误或含注入内容时主任务继续有定义的策略。权限在executor校验，不能只靠隐藏工具或system prompt。

验收：两条只读委派并行不触碰GUI；主目标变更后旧结果不能污染；子Agent无主状态写权；结果可追溯；多Agent开销有上限。

### 以后研究分支

个性化/跨Run记忆、语音无障碍、更多平台、多种浏览器原生模式是可选产品研究，不计入当前漏洞关闭。选择个性化时先做用户可查看、编辑、删除与授权，再研究学习；不先做训练。选择语音时复用命令/事件边界，保留明确审批。多执行者共用GUI并非既定方向，不纳入必须开发。

既有“独占隔离 ComputerSession 的 Execution Subagent”仍保留长期研究方向；限制共用桌面的并发写入不等于删除隔离执行者设计。

## 13. 原审计项的明确去向

| 项目 | 阶段 | 关闭口径 |
|---|---|---|
| F01 | DEV-2、DEV-6 | 支持目标上的新鲜度/审批条件闭合；不宣称任意业务语义可验证 |
| F02 | DEV-1；DEV-3增强 | 裁剪缺陷关闭与指令语义修订分别验收 |
| F03 | DEV-1 | mutation所有内容分支无引用旁路，旧值不受非法更新影响 |
| F04 | DEV-1 | resolved实机配置与Guard实例/UI一致 |
| F05 | DEV-1基础、DEV-3/7完整口径 | 估算硬边界与实际成本分开报告 |
| F06 | DEV-1、DEV-7发布导出 | native/flat/错误统一安全诊断，私有原始事件另有合同 |
| F07 | DEV-1；DEV-6恢复 | bounded等待不伪造停止，资源ownership清楚 |
| F08 | DEV-1具体规则；DEV-6风险边界 | 规则bug可关闭；任意语义识别是已知限制而非无限整改 |
| F09 | DEV-2 | 单动作/批次焦点合同及支持范围测试 |
| F10 | DEV-1基础、DEV-4 | schema/长度/读取/依赖/按需验证闭环 |
| F11 | DEV-3、DEV-7 | 选择与裁剪可定位、实际成本可解释 |
| F12 | DEV-1净化、DEV-2产品化 | 接管/审批/增量刷新/终端恢复验收 |
| F13 | DEV-2起逐阶段、DEV-7收尾 | 职责边界与行为保持，而非文件数KPI |
| F14 | DEV-0、DEV-7交付 | 真CI和实际仓库门禁；交付阶段单独验证 |
| F15 | DEV-2基础、DEV-6扩展 | 能力探测/目标合同/可验证输入 |
| F16 | DEV-2呈现、DEV-7报告 | outcome/report/evaluator分离 |
| F17 | DEV-5 | shadow和干预有实现及数据；默认启用按效果决定 |
| R01 | DEV-1 | 强制结论不可被reviewer allow降级 |
| R02 | DEV-1 | flat calls[]与native同一诊断合同 |

## 14. 并行方式和停止扩张条件

DEV-0与DEV-1并行。DEV-2的Fake TUI、app-runtime、CUA doctor可以并行，但协议由一位集成人先冻结。DEV-3的Trace骨架可在DEV-1结束后并行开发，不等UI美化。DEV-4先定依赖合同；DEV-5 shadow可旁路收集。DEV-6的隔离测试准备可提前，但敏感放行必须过相应门槛。

每个阶段优先完成“输入→执行→持久化→呈现→测试”的薄闭环，不把所有schema先设计完才接真实流程。已完成的阶段保持回归，后续不通过大量字段代替运行机制。

完成DEV-7后先冻结主版本，再进入DEV-8。禁止因“为了让项目更完整”同时启动长期记忆、语音、多平台、分布式调度和新语言重写。

## 15. 面试准备与工程交付同步

每个DEV阶段附一页《本阶段可讲案例》：问题现场、失败测试、旧控制流、改动位置、替代方案/代价、实际验证和剩余限制。用户应亲自走读一个正常路径和一个异常路径，而不是只接收开发Agent摘要。

项目追问的完成标准不是“再也问不倒”，而是能准确区分已实现、支持范围、待验证和主动不做。字符串/递归手撕、网络/并发基础仍需独立练习；加项目功能不会自动补齐基础能力。

## 16. 源码与文档依据

[S1] Risk Guard，固定提交（routeCandidate / assessmentDecision / LayeredRiskGuard.evaluate）：
https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/risk-guard/src/index.ts

[S2] CLI诊断，固定提交（summarizeProviderResponse / summarizeStructuredContent）：
https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/apps/cli/src/index.ts

[S3] pnpm action.yml，固定提交，本次重读：
https://github.com/pnpm/action-setup/blob/b906affcce14559ad1aafd4ab0e942779e9f58b1/action.yml

[S4] GitHub Actions Secure use（本次在线核对，含最小权限、SHA pin与自托管风险）：
https://docs.github.com/en/actions/reference/security/secure-use

[S5] Node.js AbortController / AbortSignal 官方说明（本次在线核对；取消支持依赖具体异步API）：
https://nodejs.org/api/globals.html#class-abortcontroller

[S6] CUA 0.22.2 动作支持矩阵，原审计已固定读取：
https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/docs/action-support.md

其余工程现状引用前一轮审计附件01..04及其固定源码链接。用户提供的《外部审计复核：39ff27f9 的实际问题与推进顺序》是本路线的重要输入；其179项/9项本机结果保留来源归属，本次未独立重跑。所有新增类型、profile、CLI命令和测试名称均为建议，不能当作当前已存在API。

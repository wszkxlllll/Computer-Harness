# 生活评测修复：集中独立审查（2026-10-18）

本页记录本轮修复工作树的集中审查及其定向整改复审。旧监督接线及历史评测产物不作为本轮新增回归。

## 发布 CI 追加：测试路径别名

**GO（测试路径别名修正的增量审查）**，已有业务代码审查 GO 保持。根协调器随后核验 [修正后 CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/39105768682)，head `a38a815` 的四矩阵和 ci-required 全部通过；不是审查者本机执行数。首轮 CI run 39105278735 四矩阵 Vitest 2563 项均通过，但 macOS/Windows 的 scripts/life-eval/supervision.test.mjs 第 167 行将生产 realpath 结果与词法路径直接比较，分别受 `/private/var`／`/var` 和 `runneradmin`／`RUNNER~1` 别名影响。

本次只审该测试文件的最小 diff，最终三项期望均已核对：trajectoryPath 期望 await realpath、latestScreenshotPath 期望 await realpath(fixture.screenshotPath)，以及“不是文档交付目录”的 negative 期望 await realpath(fixture.outputAttemptDir)。保留严格相等及不等比较，比较双方使用相同路径语义；生产代码及 containment 未变。本审查曾指出最初只修 trajectory 会遗漏下一截图断言，现已补齐。本机独立 supervision 测试此前 **8 passed、0 failed**；作者报告最终三项修正后重跑同样 8/8 通过。本机路径未复现 CI 别名，最终 Mac/Windows 收口依据为顶部实际 CI 结果，不用本机结果冒充。

## 最终追加：审批朗读已有计划

**GO（审批最小增量的功能、类型及两项集成断言复审）。** 此前主修复及 Web/voice 增量的审查结论保持。已独立核对最终最小签名：approvalPlanVoiceText 返回 ready、sensitive、unavailable 三个独立判别分支，没有使用 as 绕过检查。根协调器实际重跑 tsc -b、spike noEmit 及 Web production build 均通过。

根协调器最终验收补记：整改后的完整组合 Vitest 为 **141 文件、2563/2563 通过**，不是审查者独立执行数。Node 脚本测试仍有 10 项本机 symlink fixture 权限 EPERM 失败，保留此边界。审查时未部署、未运行真实任务或 iPhone VoiceOver；用户随后授权的推送、备份与 Preview 发布见[部署记录](../../voice-preview-deploy-phone-test-2026-09-29.md)，不追溯作为实机功能验收。

集成断言捕获与整改：组合全量 Vitest 曾为 **2561 passed、2 failed**；两项失败位于 remote-run-api.test 的旧审批精确文案断言，因新增计划文本而不再匹配。已审该测试文件的唯一新 diff：两处仍采用严格完整预期，纳入当前计划、未核验提示及风险句；保留 pendingRequestId 绑定与 hunter2/password 敏感 raw reason 排除断言，新增 preview 精确 target/summary 及 verified:false 断言，没有降为宽泛包含匹配。独立筛选这两个原失败 case，**2 passed、0 failed**；其余 82 项因筛选未运行。两项断言缺口已关闭，后续最终组合结果见顶部根验收补记；前一版本 2554 项通过不替代最终结果。

构建捕获与整改记录：功能定向审查和 74 项单元测试通过后，根协调器集成 `tsc -b` 曾发现 `packages/voice/src/run-notices.ts` 第 422 行 TS2339：返回类型将 sensitive/unavailable 合并为一个 union 分支，TypeScript 不能在前两个判断后推导剩余项必为 ready，因而不能访问 plan.text。本审查据此临时撤回审批增量最终 GO；作者将类型最小拆成三个独立分支，根协调器重新构建通过后才恢复本结论。unit GO 不替代 build。

`projectApprovalVoiceContext` 从精确 requestId/callId 对应的 approval 和已接收工具调用提取既有 target/summary，Guard 类别及动作仍来自匹配的 Guard 记录。没有引入新 LLM 调用、公共协议字段或审批权限。voice 仅在当前请求匹配并已 opt-in 时朗读计划；没有计划、计划不完整、过期请求或隐私匹配时采用有限说明，不拿其他工具调用的计划补位。

voice 和 Web ARIA 均先规范化并扫描完整计划，再对 target/summary 使用 64/96 字符上限；voice 最终仍受 320 上限约束，Web 计划块有界。尾部敏感字段及跨 target/summary 拆开的敏感模式不会因先截短而绕过过滤。Web pendingRequestKey 纳入计划，当前请求计划更新不会静默漏公告。计划明确属于拟执行说明、仍需核对；“这项操作还没执行”指当前待审批操作，不表示此前 batch 中已经完成的操作未执行，也不改变已完成 receipts。

独立执行 approval-preview、voice index、Web run-accessibility 三文件 **74 passed、0 failed**。另从当前 voice 源码即时转译并离线构造无标点 target 200 字符、summary 300 字符及全部五类风险的反例：输出 268 字符，保留完整“说明仍需核对，请勿仅凭说明批准”。作者另报告同组 74 项及 Web noEmit 通过，不重复计入独立验证。

**审批说明更具体不等于听觉核验充分。** Guard、请求绑定截图及 evidenceLoaded 门禁没有变化；计划仍是模型声明，不能证明当前对象、金额、收件人或后果。实际 VoiceOver、iPhone 语音和只听审批可用性均未实机验收。未执行 GUI/API/部署，审查仅修改本文档。

## 最后增量：Web 通知、语音截断及进展语言

**GO（已审的最后增量范围）**，主修复五项 GO 保持。未发现这组增量的 P0/P1/P2 必须修项；本次不扩展成产品全量无障碍审计。

实际读取 Web 五文件、voice 两文件及 Context 稳定语言指导的 diff，并独立执行五个测试文件：Web 45、voice 37、Context 1，合计 **83 passed、0 failed**。非交互 run-target 将标题、值及免责声明合成单个 sr-only 句子，原可见片段 aria-hidden，不合并 GoalComposer、Preferences、Pairing 控件标签。运行通知保持单个 atomic live region，应用 TTS 关闭不移除屏幕阅读器可读文字，近期通知仍可从时间线读回。

voice 保留完整值隐私扫描，随后才在原 120/240 上限内寻找句段边界并加省略号；无边界时回退到不切断 Unicode 代理对的前缀。Context 的进展语言指令处于稳定前缀，明确用户偏好优先，否则跟随 Goal 语言，不被英文工具／来源页面带偏；中英文 Goal 的前缀 hash 测试通过。指令不保证模型每次遵从，也不改写历史输出。

根协调器报告最终组合独立验收：141 个测试文件、2554/2554 通过，tsc -b、spike noEmit 及 Web Vite 8 生产构建通过。这是根协调器的全量验证，不混入本审查执行数。其最新 voice 产物回放历史 16 条轨迹仍有 171 raw、165 projection、1 fallback、3 条英文，属于历史模型输出，不可声称新语言提示已将它们修正。

**没有操作真实 iPhone 或运行 VoiceOver，不声称真实屏幕阅读器朗读顺序、语音效果或听觉审批已经验收。** 本次无 GUI、模型 API、Preview 或部署操作。

## 追加核实：审批只听是否足够

以下保留初查时的审批缺口与建议。已获授权的最小整改现已完成并通过定向增量审查，见本页顶部；未新增 LLM 服务、公共协议或审批权限。

初查时审批声音能提示风险类别和动作类型，**不足以仅凭声音核对具体目标与后果**。当时 `projectApprovalVoiceContext` 只投影 Guard categories、reasonCode 和 actionKind；voice 的 approvalVoiceText 只能生成“可能涉及付款的点击操作”等概括。Web 的 pendingRequestAnnouncement 已读请求 reason/description 和动作类型，但没有读 preview 中现成的 modelDeclaredEffect.target/summary。ApprovalActionPreview 页面已将这两项显示为“模型说明（未经验证）”，屏幕阅读器可手动读到；当时自动公告与该说明存在缺口。

最小下一步是先消费这份已绑定当前 request/call 的现有说明，无需先加模型调用：以“模型计划对……执行……，该说明未经验证”的结构提供可重听的具体摘要，并保留隐私过滤、长度界限及请求过期失效。不能把模型 target/summary 包装成 Host 已证实的目标或已执行结果。仅当现有说明确实缺失或含糊、用户主动要求进一步解释时，再评估审批节点按需 LLM 解释；其角色仍是解释现有证据，不能创造新证据、改 Guard 分类或批准操作。本次仅提出建议，没有实现新服务。

Web 的 computer action approval 仍由 requiresVisualReview 及 evidenceLoaded 门禁控制；模型说明不能替代请求绑定的截图证据。截图加载成功也只证明图片可用，不证明用户听懂／看懂或确认了对象、金额、收件人及不可逆后果。无法独立核对时应拒绝或由可信任的人协助，不能宣布“只听已充分核验”或因增加解释而放宽审批门禁。

## 最新结论：五项整改增量复审

**GO（仅此前 2 项 P1、3 项 P2 的整改范围）**。实际读取整改源码后，五项原问题均已关闭，本次定向复审无剩余 P0/P1/P2 必须修项。全量 build/test 由根协调器执行，本结论不代替其结果，不构成实机部署或新一轮业务评测成功的证明。本阶段当时未覆盖 Web 无障碍；后来新增的有限 Web/voice 审查见本页顶部，不等于真实 VoiceOver 验收。

整改证据：

- CUA 显式 ref 的候选 bbox 在 DOM 采集前后分别使用完整、新鲜 inventory 检查遮挡、前台精确身份及窗口几何；未知 z 顺序、partial inventory 或新覆盖窗均拒绝。无 ref 的普通视觉点击没有进入这一新门禁。已有负 origin、私有窗口局部 bbox 与 viewport 分发边界保持。
- Ark 不再凭裸 quota、credit 或 permission 单词判永久失败；RPM/TPM/每分钟窗口限流保留现有一次重试，明确余额、账单、认证及硬额度失败保持禁止重试。
- 新 declared-effect 语义重复仅比较 click；不同文本段落不再仅因同一编辑目标而被合并，真正重复输入的既有检测仍保留。
- 用户纠正、handoff、unknown transition 和 Surface 变化截断重复动作历史，投影及 assessment 同时限制在最新边界之后；新 episode 的正常重复候选仍可生成。
- SOURCE_EVIDENCE_GUIDANCE 改为仅在主张依赖来源范围时保留相关适用限制，且只在影响结论时说明覆盖缺口；稳定前缀和局部缺失不推全局缺失的原则保持。

本次独立执行：

- 四个定向测试文件：progress-monitor、monitor-guidance、compiler-source-guidance、rate-limit，共 **56 passed、0 failed**。
- CUA 新鲜遮挡参数化反例筛选：**3 passed、0 failed**；其余 409 项是筛选未运行，不能写成本次全套通过。
- 从当前 TypeScript 源码即时转译、在内存离线执行原反例：连续三个不同段落输入且逐次 changed 不再产生误报；TooManyRequests 每分钟 quota、bare QuotaExceeded 和 RPMQuotaExhausted 保持临时限流，InsufficientBalance 与 invalid_api_key 保持永久失败，全部通过。
- 从当前 CUA 源码即时转译私有门禁，独立模拟第一次 inventory 正常、DOM 采集后第二次才出现覆盖窗／未知 z／partial inventory：三者均拒绝；前后无遮挡的正对照通过。没有网络或真实桌面操作。

作者报告的 A 49 项、C 62 项、D 485 项通过属于作者验证；根协调器全量验收另记，不混入以上独立执行数。增量复审只修改本文档，未修改业务代码。

## 初审快照与当时必须修项（保留历史）

初审 **NO GO**：未发现 P0；下列 P1/P2 需完成修正和反例回归后，由根协调器给出最终放行判断。

1. **P1，CUA 显式候选执行前缺少新遮挡复验。** `packages/computer-cua/src/cua-driver-computer.ts` 的 `revalidateDesktopManagedGrounding` 前后读取 inventory，却只通过 `currentForegroundWindowWithSameGeometry` 检查前台目标及几何，不验证完整性或选中候选是否被新窗口覆盖。桌面执行的 `actionWindowBinding` 为空；UIA 原生坐标路径以及可编辑 DOM 控件的原生点击最终向桌面分发，没有绑定窗口的前台拒绝兜底。不抢前台的置顶覆盖窗可保持同一 PID/HWND 和几何。修正应只对显式 groundingRef 使用新鲜遮挡证据，不使无 ref 的视觉动作依赖 inventory 完整性。验收应覆盖观测后出现覆盖窗、未知 z 顺序及 partial inventory，并断言拒绝前未发送输入。
2. **P1，Ark 短时限流可能被当成永久额度失败。** `packages/provider-glm/src/ark.ts` 的 `isPermanentArk429Failure` 采用裸 `quota|credit|permission...` 正则；离线 mock 的 `TooManyRequests`、`Per-minute request quota exceeded. Retry later.` 和 Retry-After=2 实际得到 `retryable=false`。仅明确硬额度、账单或认证失败才应禁止现有一次重试；每分钟配额不能仅凭 quota 单词判永久失败。
3. **P2，正常分段输入会触发重复声明候选。** `packages/runtime/src/progress-monitor.ts` 的 `completedActionReasons` 对同 target/effects/kind 聚合，仅排除 scroll。离线反例中向同一文档连续输入三个不同段落，每次截图 changed，第三个 completed receipt 仍产生 `repeated_declared_effect`。应保留真正重复输入的既有检测，并排除仅因相同编辑目标而出现的普通分段输入。
4. **P2，新语义重复路径可跨用户纠正复用旧证据。** `reduceProgressMonitor` 未在 `user.input.received` 截断重复历史；`projectRepeatedDeclaredEffectGuidance` 和 `latestAssessmentForActions` 未采用纠正边界。控制器虽清空 pending，纠正后的新候选仍可能把纠正前的动作和 assessment 拼接回来。应限定语义重复证据在最新纠正、目标切换及 unknown 边界之后，且保留 changed 不等于业务成功的原则。
5. **P2，通用来源指导无条件要求全部元字段。** `packages/context/src/compiler.ts` 的 SOURCE_EVIDENCE_GUIDANCE 首句要求每个 observation 说明 source/date/version/application/channel。应仅保留与当前主张有关的来源范围，避免简单任务填无用字段；稳定缓存前缀与“局部没找到不等于全局不存在”可保留。

## 独立验证与已核边界

- 完整读取根 AGENTS.md 和生活评测文档顶部，按新改动范围检查实际 diff，未把历史脏树整体作为新回归。
- 两个离线 mock 反例分别独立确认 Ark 配额误判和正常分段输入误判；无网络调用。
- 使用本机受支持 Node 执行 `node --test scripts/travel/metrics.test.mjs scripts/life-eval/summarize.test.mjs`：14 passed、0 failed、1 skipped。跳过项为 Windows 无符号链接权限，不能写成已通过。
- Memory task-linked 候补从 classifyMemoryFactAdmission 已准入集合选取，且要求 stable recall snapshot；未发现将 needs_check/short_lived 或其他不适用事实变成 admitted 的新路径。Planning/Memory 参数校验未改成吞未知字段。
- 所有实际 collectMetrics consumers 已转交 providerExchanges；每条实际调用独立累计，包括同 decision 重试及风险调用，无 usage 保持 unknown。Monitor budget/trace 标记采用同请求 OR。analysis-id 创建新目录且报告 wx 写入，保留旧报告。
- CUA 仅从 Host 已发放 managed Browser 的精确窗口产生候选；off 早退；无关窗口只用于遮挡判断。producerViewport/dispatchBBox 私有保留，桌面公开坐标与窗口局部分发分离。负 origin 已有参数化正向测试，不是仅 fallback 测试。未新增 registry/platform 耦合。
- Retry-After 解析及 Runtime 窗口检查保持有界；Abort 先于错误分类，same_input 和已有重试次数门禁仍保留。其他 Provider 未接入 Ark 专属 advice。

初审时未独立运行全量 build/test；这部分由根协调器执行。作者自报 target tests 与根协调器后续测试应分开记录，不追溯写成本审查已执行。以上初审问题的当前整改状态，以本页顶部增量复审结论为准。

## 操作边界

只读源码审查、离线 mock 和临时测试产物；仅新增本文档。未修改业务源码、评测 Goal 或旧 raw 数据，未调用 GUI、模型 API 或读取密钥，未 commit/push/部署，未浏览用户 iPhone。

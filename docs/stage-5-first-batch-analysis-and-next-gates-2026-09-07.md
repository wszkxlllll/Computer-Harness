# Stage 5 结果分析与下一阶段路线

日期：2026-09-08
文档角色：当前分析与实施路线
状态：A 空间已完成本轮前三项修复并通过针对性离线回归；新扩集候选已选定，等待人工审查后再做 OSWorld 预检/配对实验
执行代码：Computer-Harness-A；原项目同名文档仅作本轮基线，本轮实施记录在 A 空间同名文档第 10 节
入口：[DOCS-INDEX.md](./DOCS-INDEX.md)。本轮 A 空间实施记录见本文第 10 节。

## 1. 当前结论

**可以推进 Context/Plan 的下一轮优化，不需要继续用延长超时、增大预算或重复全量实验作为前置。** 网络目前足以开展实验，但没有证明公网波动根因已修复或今后不会超时。正式选用的 r4 六次运行无 Provider failure；旧 H05 Planning 两次超时必须保留为传输失败，不能从可靠性统计中消失。

Planning 作为可用工具已经接通；作为效果增强手段尚未证明稳定净收益：

- 六个不同任务中，Planning 组只有 H02、H08 实际调用 task 工具；S07/M05/H05/H07 未调用。
- H02 使用 Planning 后失败、成本增长；H08 使用后成功、成本下降。都是单次路径证据，不是因果定论。
- H05 的 Planning 组未调用任何计划工具，不能把 1→0 解释成“计划内容导致失败”；它是“暴露 Planning 工具”的实验组，不等于“模型使用了计划”。
- 最确定的浪费是 GUI 预算耗尽后继续大量请求已不可执行的动作；其次是历史推理/恢复上下文增长，以及模型抄写长 task ID 出错。

当前顺序：有限收尾与短任务 ID、必要 Context/Plan 调整 → 离线验证 → 直接扩充新的长步骤任务并测试（不重跑旧任务）→ 根据结果设计 Memory、压缩/裁剪。当前不引入 AI Monitor、Verifier、Advisor，不实现 MemoryStore，也不直接删 reasoning。

## 2. 证据与比较口径

原始证据均在 A 的 runs 下：runner.json 为任务、快照、预算与官方 score；harness/summary.json 为 Runtime 汇总；trajectory.jsonl 为事件事实；provider-exchanges.jsonl 为实际响应耗时与 usage。Plan 文件仅表示模型维护的进度，不替代官方结果。

- r3：planning-compare-20260908-r3，S07/M05/H02，各自两组同预算；早期网络策略与 r4 不完全相同。
- r4：planning-compare-20260908-r4，使用 H05-baseline-r4、H05-planning-r4-retry、H07-baseline-r4、H07-planning-r4、H08-baseline-r4、H08-planning-r4。每组 60 GUI steps / 90 model requests，GLM-5.3-Flash，非流式、thinking enabled，未启用裁剪/Memory/Monitor。
- 排除于任务效果配对但保留于传输记录：旧 H05-planning-r4（0 GUI、两次 240s 超时）、未完成目录。H05 baseline 与 Planning 重跑不同时间执行，线路/缓存时序并非严格随机对照。
- OSWorld commit：fc31a9049664292fcb35d6e501ee1dc839f2cf6d；快照：osworld_initial_1920x1080_clean_r4_20260906。

六个不同任务只能按批次/任务展示，不把不同网络与预算的 r3/r4 拼成同条件总体成功率。也不能将旧 30 条当作新版本 baseline。此前历史 GLM 30 条为 score=1 的 20 条、正分 1 条（S06 约 0.997741）、0 分 9 条；Qwen 5 条为 2/5 满分。它们用于发现问题，不是本轮 Planning 效果证据。

本次独立读取以上六个 r4 runner/summary/trajectory/provider-exchanges、H08 Plan 文件与部分模型文本，并对请求/拒绝原因作统计。未重新执行 API/VM，不以模型自述替代截图独立核验。

## 3. 已完成结果

### 3.1 r3 前三对（历史诊断）

| 任务 | score 基线/Planning | GUI steps | 请求数 | total tokens | Runtime 分钟 |
|---|---|---|---|---|---|
| S07 | 1 / 1 | 8 / 11 | 10 / 14 | 45,920 / 73,635 | 6.80 / 12.31 |
| M05 | 1 / 1 | 5 / 7 | 6 / 8 | 28,100 / 42,962 | 1.27 / 1.35 |
| H02 | 1 / 0 | 34 / 35 | 35 / 51 | 350,747 / 1,145,600 | 9.05 / 33.19 |

S07/M05 Planning 组 task 调用为零。S07 基线有一次约 301 秒响应头超时，Planning 有两次；不能把分钟级差距归为规划开销。H02 Planning 六次 task 调用，不是不停调用 Plan；后段表格修复产生长 reasoning，最大 prompt 56,160。首次预算拒绝对应响应起共 12 个响应消耗 622,242 total tokens，超过该运行总量一半。

H02 cached input：基线 24,064/339,279（约 7.1%），Planning 315,072/1,097,018（约 28.7%）。缓存更多不代表总成本更低。

### 3.2 r4 后三对（独立核验）

| 任务/组别 | score | outcome | GUI steps | 请求数 | total tokens | 分钟 | task 调用/成功更新事件 |
|---|---:|---|---:|---:|---:|---:|---|
| H05 baseline | 1 | succeeded | 42 | 43 | 805,465 | 15.18 | 0 / 0 |
| H05 Planning 重跑 | 0 | failed | 60 | 64 | 1,305,905 | 15.87 | 0 / 0 |
| H07 baseline | 1 | succeeded | 29 | 30 | 345,367 | 7.87 | 0 / 0 |
| H07 Planning | 1 | succeeded | 33 | 34 | 291,130 | 7.52 | 0 / 0 |
| H08 baseline | 0 | budget_exhausted | 60 | 90 | 1,889,882 | 19.60 | 0 / 0 |
| H08 Planning | 1 | succeeded | 60 | 66 | 1,089,450 | 13.14 | 10 / 7 |

上述六次 Provider failure 为零；不是把旧失败也算为零。H05/H07 没有 Plan 使用，所以不能宣称 task 状态帮助或妨碍了它们。

### 3.3 纠正“invalid tool calls”的误读

| 运行 | 拒绝/失败明细 | 解释 |
|---|---|---|
| H05 Planning | 2 次 GUI 预算拒绝；1 次 keypress 含多个键被拒绝 | 仅后者为参数问题，应使用 hotkey |
| H08 baseline | 30 次全部为 action budget exhausted | 不是 30 次 schema/参数无效；当前汇总名容易误导 |
| H08 Planning | 1 次 GUI 预算拒绝；另有 2 次 task_update 执行失败 | 参数中的任务 ID 不存在；tool.call.failed 不在 rejected 数里 |

统计脚本应按现有事件区分 budget_rejected、argument_rejected、tool_failed、provider_failed；不用新增事件体系。保留原总数以兼容旧数据，解释原因不能只看 invalidToolCalls 汇总。

## 4. 任务层面结论

### H05：图表任务的恢复开销，不是已使用 Plan 的反效果

基线 42 步成功；暴露 Planning 工具的重跑 60 步耗尽，模型未用 task 工具。模型终态报告第一张图完成、第二张图仍在向导，后续保存未完成；官方 score=0。具体图表 UI 根因仍需局部截图审查，不能仅凭自述判定全部细节。

下一步重点是复杂任务是否需要更清楚的可选阶段规划指导、Context 是否保留当前图表目标/选区/未完成事项，而不是又给它增加几十步。不要为 H05 写专属向导规则。

### H07：未采用 Planning，也未明显退化

两组均成功，暴露工具组多 4 步，但 token 从 345,367 降到 291,130；任务路径/推理长度变化足以造成这种差异。没有调用 Plan，不能把 token 下降称为“外部计划减少上下文”。作为短长流程邻近回归保留。

### H08：有价值的正例，但成本收益被收尾浪费放大

Planning 组确实创建三个阶段（找文件、创建文档、保存），10 次 task 调用产生 7 次成功 mutation，最后三个任务 completed。官方 score=1；基线停在保存附近、score=0。

基线耗尽 60 个 GUI 动作后继续 30 次同一预算拒绝。首次拒绝之后的 29 个模型响应合计 862,513 total tokens；不含产生首次拒绝的那个响应。这与两组 800,432 total-token 差值同量级，因此不能将全部 token 节省归功于计划改善。下一次归因要分“有动作预算期间”与“预算耗尽收尾期间”。

另外，H08 Planning 两次把 task ID 的片段拼错，得到 does not exist；不是 Store 丢数据。最终从 Context 取对 ID 才完成更新。长 UUID 让模型重复抄写是可改的接口负担。

模型通过 GUI 在终端输入命令核验文件/字号，最后还试图输入 Python 内容比对脚本，被预算拒绝。本次没有调用 Harness Shell 工具，但“GUI 操作终端”也不等于纯视觉任务。后续实验须固定是否允许终端行为；不能把该案例宣传为纯视觉完成或悄悄仅禁用某组。当前保留其官方 score，标注行为边界即可。

## 5. 网络与缓存：已足够继续开发，不等于根因消失

现有结果表明实验能跑完，停止反复重跑四格延迟矩阵、停止继续上调首请求超时。保持本轮 thinking enabled / 非流式，网络策略固定。

- 早期矩阵 disabled 没有更低延迟保证；首增量约 4 秒并不等于完整动作可执行。两轮探针无法推断服务 SLA。
- ECONNRESET、连接超时、响应头超时不能仅靠错误码判定代理或服务端责任；少量零失败运行也不能证明永久稳定。
- 当前源码为单次 240s、至多一次重试、480s 窗口；Runtime 新检查要求剩余窗口能容纳整个下一次请求+退避。因此第一次用满 240s 后可能不再重试。这是有界策略，不应描述成“保证会重试一次”。
- Runtime 仍依赖默认 Provider attempt 时长假设而非可取消的绝对总 deadline；不要宣称任意自定义 Provider 都严格满足 480s。对当前默认路径不再作为全面重跑门槛，后续集中维护配置边界。
- 缓存已生效，现有 exchanges 可直接统计。r4 累计 cached input：H05 60,672/821,376，H07 83,712/23,744，H08 902,208/692,736（顺序均 baseline/Planning）；应同时看总 input、输出和时间，不只看命中 token。
- 本轮不切生产流式，不接缓存数据库，不用“相似截图”缓存旧动作。

探针历史审查要点保留：必须使用真实 registry schema、解析完整 JSON/SSE、校验工具参数、记录阶段/usage，不能用首 chunk 或 contentSeen 代替有效结果。原 tmp 脚本与各 API runs 保留；不再在当前分析里重复多版过时的待修指令。

## 6. 下一轮：先改可证实的负担，再试 Context/Plan

### 6.1 A：有限收尾与统计口径（优先）

动作预算到零后，明确只允许完成/失败报告和必要计划收尾；最多 1～2 次额外模型决策，仍受总请求预算。再次请求 GUI 保留拒绝事实，但不要继续放任数十轮。未完成仍按 budget_exhausted/已有 outcome 合同报告，不能自动 success，不重放动作、不恢复预算。

这是预算机制修复，不是 AI Monitor。用 H02/H08 旧轨迹和 FakeProvider 测：最后一步完成仍有 finish 机会、未完成诚实终止、重复 GUI 不执行、Plan 收尾不能无限拖延。两组共用该修复后再比较，不能将此收益归给 Plan。

### 6.2 B（或 A）：减轻 Plan 的引用与使用负担

- 在每 Run 内由程序产生短、唯一、稳定的 task ID（如 t1/t2），Provider 原样引用，RunId 负责跨 Run 隔离。唯一性、事件重建与 Store 重建需验证；不让模型生成 ID。
- 旧 UUID 事件仍可读取，不重写历史产物；新 ID 仅影响新 Run。
- 在统一工具说明中提示模型：当任务包含多个可交接阶段时，可以用 Plan 记录阶段目标、当前进度和未完成事项。这里不增加程序侧的“复杂任务分类器”，不根据应用名或 task ID 选择提示词，也不强制调用 Plan。
- 例如“收集资料 → 整理到目标文档 → 保存交付”可以是三个阶段；“点击菜单 → 点击输入框 → 输入文字”通常只是一个阶段里的动作，不必各建一个 task。只有任务要求保存/交付时才写该阶段，不能给用户追加未要求的验收目标。
- 保留自主使用；简单任务不用 Plan 是正常的。若要明确鼓励规划，把新指导作为独立实验参数，不更改用户原任务，不按 task ID 写模板。

### 6.3 Context：先组织与可观测性，暂不实现裁剪

保留最新图、用户纠正、当前 Plan、完整工具交互组。检查长恢复过程中的重复状态表达与任务事实放在哪里：H02 邮件字段/空值、H05 图表范围/目标、H08 文件集合/顺序/保存状态。Context 与 Plan 的事实消费者要明确，不把全部数据塞进 description。

当前 Plan 展示应简洁、有当前进度；同一状态不在多个注入块重复出现。保留关键字段原文，不在本轮引入摘要调用、MemoryStore 或自动删 reasoning。对 Provider continuation 只调查协议可删除边界，结论分别列可删/不可删/待验证，不能先删再猜。

缓存友好的原则：稳定 system/tools，动态状态在尾部；不要每轮重排保留历史或加时间戳。先统计 input/output/reasoning 字符和 cache，用实际响应解释增长，不凭截图 KB 换算 token。

## 7. 修复后直接扩充长步骤任务与交接提示词

按用户最新要求：第 6 节修改完成并通过必要的离线测试后，直接选择新的长步骤任务开始测试，不重跑 H05/H08/M05 等旧任务。旧轨迹可用于离线检查，不再要求旧任务真实回归作为扩集门槛。

1. 收尾修复、短 ID、必要的 Context 组织与通用 Plan 指导固定为新版本，旧结果保留。用 FakeProvider/历史事件验证引用、收尾、事实保留，不调用旧 VM 任务。
2. 新任务优先选择多目标、跨应用、数据收集后复用、阶段切换与保存交付等长流程；不能仅因为反复点击或环境不可用导致步骤多就入选。预估难度可以依据任务说明与环境条件，不先偷看成功轨迹或答案来调提示词。
3. 实施 Agent 提交新任务清单、选择理由和统一能力边界，开跑前固定任务、模型、预算、代码与输出目录；无需等待 Memory/压缩设计完成才扩集。
4. 在新任务上按同版 baseline/Planning 配对测试，两组共同使用基础修复与相同预算，仅改变声明的 Planning 开关。旧成绩不能直接当新测试集 baseline。若同时改了多项 Context/Plan 行为，结论只针对该组合，不声称拆出了每项独立贡献。
5. 记录真实 task 使用、阶段状态、ID 错误、数据遗漏、预算前后请求/token/耗时与官方 score；不因步骤较少但提前失败就认定优化成功。
6. 新长任务结果用于决定后续 Memory 与压缩/裁剪机制；不因某模块一次没收益就禁止下一设计，也不把单次成功写成论文结论。

## 8. 扩集后的 Memory 与压缩设计

先完成当前修复并直接运行新的长步骤测试集，再依据新旧任务的事实丢失/重复读取证据设计 Memory 的写入、来源、更新与召回消费者；按实际 Provider continuation 协议设计压缩/裁剪。扩集不依赖这些模块先实现，也不依赖重跑旧任务。

扩集侧重多目标、跨应用、数据复用与恢复场景；本轮不要求另跑旧简单任务，基本行为由离线测试覆盖。Memory 经验来源与目标任务分开；保留未用于调参的任务供后续评测。各模块可单独关闭，先独立后组合；对终端命令、Shell、Accessibility 等能力边界提前统一。

## 9. 文档与审计边界

本文件替换了“后三题待跑”“继续定位网络直到稳定”“尚未集成 Plan”等过时结论，保留历史数字和产物路径，不删除实验数据。早期开跑审查仅是当时门槛，当前行动以第 6～8 节为准。

第 1～9 节记录上一轮分析边界；本轮 A 空间实施和验证见第 10 节。网络责任归属仍未知；任务具体 UI 原因中依据模型自述的部分已明确，不伪装成逐帧人工验收。

官方机制参考：[Node 代理](https://nodejs.org/api/http.html#built-in-proxy-support)、[Node AbortSignal](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay)、[Undici Client](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md)、[智谱缓存](https://docs.bigmodel.cn/cn/guide/capabilities/cache)、[千问缓存](https://help.aliyun.com/zh/model-studio/context-cache)。它们解释机制，不替代本次实测证据。

## 10. A 空间本轮实施交接（2026-09-08）

本节是 A 空间当前实现状态，覆盖本轮前三项修复；不改变第 2～5 节的历史结果，也不把尚未运行的 OSWorld 实验写成通过。

### 10.1 已实施修改

1. **有限收尾与统计分类**
   - `packages/runtime/src/run-controller.ts` 在首次 GUI action budget 拒绝后，最多允许两次额外模型决策，用于显式 `finish` 或必要的非 GUI 收尾；不恢复动作预算。再出现模型请求前若收尾次数用尽，写入预算 `runtime.error` 并以 `budget_exhausted` 结束。
   - 最后一个动作后模型直接返回正常 `finish` 仍按原路径处理；Runtime 不因动作预算耗尽自动判成功。
   - `apps/cli/src/index.ts` 和 `scripts/stage5-osworld/analyze-trajectory.mjs` 分开统计预算拒绝（含收尾上限触发的 budget runtime error）、参数/GUI 校验拒绝、工具执行失败和 Provider 请求失败；保留原 `invalidToolCalls` 字段以兼容旧汇总。

2. **Plan 短 ID与通用语义**
   - `packages/planning/src/index.ts` 的 `task_create` 根据当前 Run 的 Plan 分配 `t1`、`t2`……；同一 Run 内唯一稳定，不让模型生成 ID；不同 Run 仍由 `RunId` 隔离。
   - 旧 UUID 任务仍可由 `PlanStore` 读取和由事件重建；新任务分配只扫描 `t<number>`，不会重写旧轨迹。
   - `task_create/update/list/get` 描述已明确：Plan 记录可交接阶段、实际阻塞和目标变化，不要求逐次点击；`completed` 是模型声明状态，不是官方验收结果；description 只写阶段目标和必要未完成事项。

3. **Context 与 Plan 的连接**
   - `packages/context/src/index.ts` 保留完整的 assistant ToolCall 与对应 ToolResult/拒绝/失败消息，未删除 reasoning continuation、用户纠正、当前截图或历史事实。
   - 末尾的当前 Plan 块只列未完成阶段，并用完成数量概括已完成阶段，避免在工具结果和状态块中重复展开相同任务；新短 ID、状态和未完成事项会在下一轮 ModelInput 中出现。
   - 稳定 system prompt 和 ToolRegistry 投影仍位于动态 Plan/截图之前，未引入时间戳、摘要调用、Memory 或裁剪逻辑，保持可缓存前缀。

### 10.2 本次实际验证

- `pnpm build`：通过（TypeScript project build + CUA spike typecheck）。
- `pnpm exec vitest run packages/runtime/src/index.test.ts packages/planning/src/index.test.ts packages/context/src/index.test.ts`：通过，3 个测试文件、62 个测试通过。
- `node scripts/stage5-osworld/analyze-trajectory.mjs --root runs/planning-compare-20260908-r4/H08-baseline-r4`：通过；离线统计将该历史轨迹拆分为 `budgetRejected=30`、`budgetRuntimeErrors=1`、`argumentRejected=0`、`toolExecutionFailed=0`、`providerFailures=0`。
- 覆盖内容：动作预算耗尽后的有限收尾、拒绝后不执行 GUI、不恢复动作预算；同一 Run 短 ID唯一性、跨 Run 隔离、旧 ID/事件重建；`task_create → 下一轮 Context → task_update`；完整工具调用/结果保留和未完成 Plan 摘要；用户纠正边界。
- 本轮未启动 VM、未操作真实桌面、未调用付费模型、未覆盖旧 runs、未提交或推送。

### 10.3 新扩集候选（等待审查，不代表已预检/已运行）

候选均来自 OSWorld 当前任务 JSON，排除已作为首批结果使用的 S01–S10、M01–M10、H01–H10；共同约束为 `proxy=false`、`possibility_of_env_change=low`，每组从同一已校准快照独立 reset。选择理由只依据任务声明、配置和 evaluator，不依据模型成功轨迹调参。

| 候选 | Task ID | 应用/范围 | 选择理由 | 建议同对照预算 |
|---|---|---|---|---|
| N01 | `23393935-50c7-4a86-aeea-2b78fd089c5c` | OS 文件管理 | 递归查找并复制 JPG，验证文件集合复用与批量副作用 | 30 steps / 40 requests |
| N02 | `48c46dc7-fe04-4505-ade7-723cba1aa6f6` | Chrome + OS | 终端、文件管理器、Chrome 多窗口联动，验证跨应用焦点与收尾 | 30 / 40 |
| N03 | `f5c13cdd-205c-4719-a562-348ae5cd1d91` | Thunderbird + Calc + OS | 从付款记录反查未缴费收件人并回填草拟邮件，验证数据复用和跨应用 | 45 / 60 |
| N04 | `20236825-b5df-46e7-89bf-62e1d640a897` | VS Code + Writer + OS | 阅读教程文档、编辑 Python 函数、生成桌面结果文件，验证阶段切换和交付 | 45 / 60 |
| N05 | `bf4e9888-f10f-47af-8dba-76413038b73c` | LibreOffice Impress | 多图片顺序插入六页并另存，验证重复但有目标的长轨迹和保存收尾 | 60 / 90 |
| N06 | `0c825995-5b70-4526-b663-113f4c999dd2` | Calc + Chrome + OS/Drive | 从资料文档提取 Introduction 写入新报告，验证资料读取、跨应用复用与登录/文件交付风险 | 60 / 90 |

N06 含外部文档/登录步骤，先做无模型预检；若快照、登录或 evaluator 不满足条件，记录替换原因，不修改原始任务。N01–N02 可先作为短链路门槛，N03–N06 再作为长流程 Planning 配对。正式实验两组只切换 `--planning`，固定模型、Context、坐标、快照、预算和网络设置；本轮不把候选任务当作已完成结果。

### 10.4 交接边界

请先审查本节的预算语义、短 ID 和新任务清单。审查通过后再执行：

```text
无模型预检（按 N01–N06，串行、独立 reset）
固定通过的任务/快照/预算/模型
每个任务运行 baseline 与 Planning 一对，只改变 --planning
分别保存 runner.json、harness/summary.json、trajectory.jsonl、provider-exchanges.jsonl 和 evaluator 结果
```

不得重跑旧 H05/H08/M05 作为新扩集结果；不得在本轮加入 Memory、摘要/裁剪、Monitor、Verifier 或新的任务分类器。

### 10.5 扩展长难任务池（静态候选，等待预检）

用户要求扩大“步骤较多、难度较高”的候选范围。本表是从当前 OSWorld 任务 JSON 静态筛出的候选池，不是冻结集，也不是运行结果。`configCount` 只是任务初始化动作数量，不等于模型 GUI step；真正预算仍需在无模型预检后固定。所有候选均排除了已用于首批结果的 S01–S10、M01–M10、H01–H10，并优先满足 `proxy=false`、`possibility_of_env_change=low`。

E05/E06/E19 与第 10.3 节的 N05/N06/N01 是同一任务的重复标记，便于按“长难/批处理”维度查看；去重后候选总量为 24 个。

#### 核心长难候选

| 编号 | Task ID | 应用范围 | 任务形态 | 主要模块价值 | 建议预算 |
|---|---|---|---|---|---|
| E01 | `869de13e-bef9-4b91-ba51-f6708c40b096` | Writer + Calc + OS + Impress | 按内容识别桌面文件并分拣到三个目录 | 多目标规划、批量副作用、收尾事实 | 60 / 90 |
| E02 | `881deb30-9549-4583-a841-8270c65f2a17` | Calc + PDF/OS | 从 2015–2023 多份 PDF 提取各校 ECS 通过率并填表 | 长数据抽取、跨文件复用、Context 保持 | 60 / 90 |
| E03 | `185f29bd-5da0-40a6-b69c-ba7f4e0324ef` | Calc + PDF + OS | 将员工表格数据批量填入多个 PDF 表单并按姓名保存 | 批量交付、文件命名、长轨迹恢复 | 60 / 90 |
| E04 | `7e287123-70ca-47b9-8521-47db09b69b14` | Calc + PDF/OS | 从 2019–2023 GRF 报告提取 HKU 数据并计算成功率 | 多年数据复用、公式/表格交付 | 60 / 90 |
| E05 | `bf4e9888-f10f-47af-8dba-76413038b73c` | Impress | 创建六页并按顺序插入六张图片后保存 | 重复动作、动作预算、保存收尾 | 60 / 90 |
| E06 | `0c825995-5b70-4526-b663-113f4c999dd2` | Calc + Chrome + OS/Drive | 从资料文档提取 Introduction 并写入新报告 | 资料读取、跨应用复用、交付 | 60 / 90 |
| E07 | `aceb0368-56b8-4073-b70e-3dc9aee184e0` | Thunderbird + OS（任务文字还提到已打开表格） | 比对多份考试答案并写入评分表 | 批量数据处理、Context 保持、恢复 | 60 / 90 |
| E08 | `26150609-0da3-4a7d-8868-0faf9c5f01bb` | VS Code + OS | 修复 Snake 游戏逻辑并通过测试 | 代码阅读、编辑、执行、结果交付 | 45 / 60 |
| E09 | `68a25bd4-59c7-4f4d-975e-da0c8509c848` | Calc + Chrome | 从论文列表下载首篇 PDF，并查找引用关系写入 DOCX | 浏览器检索、文件下载、文档交付 | 45 / 60 |
| E10 | `7f35355e-02a6-45b5-b140-f0be698bcf85` | Calc + VS Code | 导出 CSV、填补均值、计算中位数并保存结果 | 数据转换、代码/表格往返、最终文件 | 45 / 60 |

#### 跨应用与阶段切换备用候选

| 编号 | Task ID | 应用范围 | 任务形态 | 备注 |
|---|---|---|---|---|
| E11 | `8e116af7-7db7-4e35-a68b-b0939c066c78` | Calc + OS + Image + PDF | 从交易文件更新记账表 | 多来源数据，需预检输入文件和 evaluator |
| E12 | `51f5801c-18b3-4f25-b0c3-02f85507a078` | Impress + Writer | 提取全部演讲者备注生成 Word | 跨文档阶段切换，轨迹长度中等 |
| E13 | `bb83cab4-e5c7-42c7-a67b-e46068032b86` | Impress + Writer + OS | 将演示文稿文字转为 Writer 文档 | 文件读取、跨应用复制与保存 |
| E14 | `6f4073b8-d8ea-4ade-8a18-c5d1d5d5aa9a` | Calc + Chrome + OS | 汇总多个会议年份和城市到表格 | 数据收集与表格补全，网络需预检 |
| E15 | `30e3e107-1cfb-46ee-a755-2cd080d7ba6a` | Calc | 新表格式化并创建三个 Pivot Table | 单应用但多阶段，适合作为中等难度对照 |
| E16 | `1f18aa87-af6f-41ef-9853-cdb8f32ebdea` | Writer + OS | 参考答案格式补完两个测试文档 | 多文件读取、格式保持和交付 |
| E17 | `8df7e444-8e06-4f93-8a1a-c5c974269d82` | Writer + OS | 按提交规范整理并打包 essay 文件 | 规范读取、文件选择和压缩交付 |
| E18 | `f918266a-b3e0-4914-865d-4faa564f1aef` | VS Code + OS | 完成 calculator.py 并保存运行日志 | 代码执行和文件交付，长度中等 |

#### 文件批处理与恢复备用候选

| 编号 | Task ID | 应用范围 | 任务形态 | 备注 |
|---|---|---|---|---|
| E19 | `23393935-50c7-4a86-aeea-2b78fd089c5c` | OS/终端 | 递归收集 JPG 到 cpjpg | 重复文件操作多，但语义难度较低 |
| E20 | `5c1075ca-bb34-46a3-a7a0-029bd7463e79` | OS/终端 | 按目录层级复制 `*failed.ipynb` | 文件树保持和批量副作用 |
| E21 | `37887e8c-da15-4192-923c-08fa390a176d` | OS/终端 | 按修改时间压缩/移动文件 | 有不可逆移动风险，必须快照预检 |

### 10.6 扩集使用规则

1. 第一轮不必运行全部候选；先对 E01–E10 及第 10.3 节 N01–N06 中尚未预检者做无模型预检，再从通过者中选择 6–10 个，保证至少包含：两个跨应用数据复用、一个长重复动作、一个代码/文档交付、一个文件批处理。
2. E06、E09、E14 依赖网页或外部文档，E07 存在任务文字与 `related_apps` 不完全一致，E21 存在批量移动副作用；它们先列为风险候选，不直接进入核心因果比较。
3. 所有正式任务仍做 baseline/Planning 配对，同一任务两组只改变 `--planning`；模型、快照、坐标模式、Context、网络和预算固定。
4. 任务很长不等于 Planning 一定有收益。分析时分别记录实际 Plan 调用、阶段状态、动作预算前后请求/token、事实遗漏、官方 score 和 Runtime outcome。

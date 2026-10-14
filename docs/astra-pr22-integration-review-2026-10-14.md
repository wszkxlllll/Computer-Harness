> 历史审查快照；后续修复、PR23实际合并及最新组合验证以[执行记录](./astra-prfix-merge-execution-2026-10-14.md)为准。本文固定版本和当时未合入状态不冒充当前进度。

# Astra PR22 集成分支专项复审（2026-10-14）

## 1. 合并建议

**可以继续整合，当前不能直接放行 main 合并。** 本轮PR22更新到正式点击修复 `392b6ca`，PR23更新到正式输入保护修复 `59a952d`。F1已通过新diff独审与定向验证，F2的输入保护也通过正式评测160项及直接CLI复核；但新原子写入引入**既有私有结果0600→0644的P2权限回归**，PR22的Windows required CI也失败。再加上PR23/679尚未纳入及组合验证未完成，现阶段不能签收最终候选。旧P2不直接套用到新提交，下面逐项区分。

本轮针对用户提供的 [PR22](https://github.com/wszkxlllll/Computer-Harness/pull/22) 重新采集远端正文、review/comment/checks，核对不可变 Git 树，两个 Sol 分别复审核心与 Web/API/评测合同，Luna 核对元数据与新head验证。首次捕获时仍是156，复用其已有独立全套证据；18:08发现两个head更新，随即转审新提交并执行必要新测试。详细旧反例见[前一轮合并前审查](./astra-premerge-review-2026-10-14.md)，不将旧测试写成新版本全套通过。

本方仍仅负责 macOS、Web/Relay、手机相关共享问题，Windows/Linux 原生专项实现和实测不纳入完成条件，既有源码和 CI 保留。此审查不修改执行对话的现场、正式源码或既有成果。

## 2. 最新版本和“已集成”的准确范围

首次远端 API 采集于 **2026-10-14 17:59:06（北京时间）**，18:08:35发现更新，18:10采集新head详情：

| 对象 | 当前版本 / 状态 | 与 PR22 的关系 |
| --- | --- | --- |
| main | `961a0982ee11bf2f4687756f5184869f197a1b4b` | PR22 当前 base |
| PR22 | **`392b6ca9dc89136852b3c1f517ddfd1cdced6145`**，非草稿 | 156的一个子提交，8文件，正式F1修复 |
| PR23 | **`59a952d1be8229fe7992e25969c39fd691ef118e`**，非草稿 | 1f的一个子提交，3文件，正式F2修复；尚未纳入PR22 |
| PR26 / 本地 | **`679b08c43e1806b3cc0aae2db39b84d0487977d4`**，PR26 仍草稿 | 已更新；新提交不在 PR22 祖先链 |
| PR27 | `3f22c308b1b6c762b6dc52c3206a7e07154f7dc4`，草稿 | 依赖 PR23；不是本轮必合前置 |

17:59时四个旧head各自最新五项CI成功。新392/59另起CI；18:13:38刷新后，PR23 [38547248255](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38547248255)五项成功，PR22 [38547377207](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38547377207)的Windows22与ci-required失败，Ubuntu22/24、Mac22成功。不能把156旧绿色继承给392，也不能因Mac定向通过而忽略required检查。

旧156已包含旧PR26 `594fa8e`，旧提交到156为0/36；新392继承该历史。**现在本地已前进到679，与PR22各有独有历史**：156对679为36/1，392对679为37/1。不能把“594及以前已被包含”表述成“当前PR26全部已集成”。

`679` 的 parent 为 `594`，共 19 个路径、+4446/-14：包含缺少模型凭据时提前拒绝的共享代码/测试、native9/10/11 诊断 patch/source-chain 归档以及现场文档。这些归档不代表 PR22 或运行中驱动已经加载相同 native 二进制。

156/392树中均不存在 `scripts/stage4-local/evaluate-trajectory.mjs`，PR23/27有该文件；评测器缺陷不在PR22当前树里，也不能宣称新392已纳入新59的修复。

PR22 相对 main 共 408 个路径：apps 77、packages 109、docs 173、eval 20、scripts 17、patches 8，另有 AGENTS/README/notices/lockfile 各一。apps/packages 中 104 个非测试文件还含 README、契约和 package.json；文件数量不等于功能完成率。重点核对集成边界，未声称逐行认证全部文件。

## 3. 两项P2的正式修复复核

### PRFIX-22：正式修复392，保留partial中的已知目标限制

旧156 [cua-driver-computer.ts:4234–4238](https://github.com/wszkxlllll/Computer-Harness/blob/156baad40c74edbe4f97b4199c544167add8797f/packages/computer-cua/src/cua-driver-computer.ts#L4234) 的 `domComplete===true` gate已被[392正式修复](https://github.com/wszkxlllll/Computer-Harness/commit/392b6ca9dc89136852b3c1f517ddfd1cdced6145)移除。唯一已观测UIA/DOM对应项在partial时仍走DOM约束，已知disabled/live-validator refusal继续拒绝；真正missing/ambiguous仍保留受保护native fallback。

此前exact156六项4绿2红、main961/594负向控制与私有402绿保留作历史。正式392另补complete/partial的disabled/live-refusal、missing/ambiguous fallback及unique partial UIA对应项CDP正例；源码注释、Runtime工具说明和Context提示同步修改。旧反例的fake live-validator是“若调用则拒绝”，不描述成先收到refusal再重放。

新diff未给所有partial inventory增加统一硬拒绝，未移除身份/几何/点位/stale约束。Sol独立18/18（10个正式适配器场景、6个原Darwin探针、2个提示合同）通过；Luna exact392完整适配器402+Context42+工具11合计455/455、类型与Web构建通过。**F1可在exact392关闭**，不等于尚未构成的679/评测组合获批。

PR22正文应以最终候选写明F1正式修复与新增反例，保留旧GO和失败时间关系，不能把历史“小范围GO”当作新392及未来组合的整包批准。

### PRFIX-23：正式修复59，保护显式输入和截图并原子写入

旧1f只比较resolve字符串，writeFile会跟随别名覆盖输入。新[59正式修复](https://github.com/wszkxlllll/Computer-Harness/commit/59a952d1be8229fe7992e25969c39fd691ef118e)增加canonical+dev/ino身份检查，读取截图前注册输入身份，写前再次核对；同目录随机临时文件以wx独占写入，close后rename，失败关闭并清理。输入别名、截图和失败清理回归同时加入。PR27未自动继承此修复，不借其旧172项放行新PR23。

**本轮新补充的旧版红例**：exact1f的output直接等于已读取`assets/initial.png`，CLI exit0；68字节PNG被2109字节结果JSON覆盖，结果仍标记bound并带覆盖前SHA。新59独立直接CLI复跑为exit1，全部输入字节不变、无临时文件残留。仅私有合成文件，无用户截图。正式评测文件完整160/160、0skip；首轮159/160是独立snapshot漏抽batch helper，补齐exact helper后完整通过，不归因产品。**F2输入保护本体可有限关闭，但新writer权限问题仍需修复。**

新测试有一处覆盖缺口：`evaluate-trajectory.test.mjs:257–264` 的“替换已有正常输出”先写old result，却调用会先rm(output)的fixture.invoke，实际未覆盖已有文件替换。独立直接CLI已验证真正的已有结果可替换，但正式回归仍应改为不删除原文件的调用，并检查权限。该测试覆盖缺口单列P3，不与下面的实际权限回归混淆。

### PRFIX-23-MODE：新P2，原子写入放宽既有私有结果权限

新59的`writeOutputAtomically`调用`open(temporaryPath, "wx")`未指定mode。正常umask022下临时文件创建为0644，rename把原结果替换成新inode，原0600隐私限制丢失。Sol直接CLI已复现，Root再次独立执行新旧exact源码对照：同一合成有效输入、原output0600、umask022，旧1f返回0且仍0600；新59返回0变0644，输入保持不变。没有恶意并发或链接前提。

输出含评测结果及证据来源信息。若父目录允许其他本机用户遍历，原明确私有结果现在变成其他用户可读；这是实际文件权限回归，不能因别名保护成功而放行。正式实现至少将临时文件设为0600，或可靠保留更严格原权限；回归必须真正预置0600旧结果，不经会rm文件的helper，并断言替换后不放宽、无临时残留。此项需要在最终组合前修复并重测；没有将其解释为远程攻击或整个评测器安全失效。

## 4. 新增 679 成果的整合：5 个文本冲突之外还有语义适配

本轮在 `/private/tmp` 的隔离 bare 对象库做 `git merge-tree --write-tree`，只写无引用 tree，没有建立正式提交、修改分支、解决冲突或推送。

| 组合 | 本轮机械分析 |
| --- | --- |
| PR22 + PR23 | clean，tree `e761aecee695b99a6b90414a106d818fc4ee9c98` |
| PR22 + 679 | **5 个内容冲突**，未解决 tree `d43c53f4c6965a0877b046fe61a85d3e5d30f158` |
| PR22+PR23 的结果，再加679 | 同样 5 个内容冲突 |

以上旧156/1f模拟留作历史；本轮新392+新59再次模拟为clean，tree `baebf03ce0fd68a8dba16ed3026105488ccc19d4`，随后加679仍为相同5个冲突；392直接加679也相同。机械clean的392+59尚未编译/测试，不等于最终候选已通过。

冲突需要保留的合同：

| 文件 | 处理原则 |
| --- | --- |
| `apps/host/src/server.test.ts` | 保留 PR22 退役目标拒绝测试及679缺凭据409/中文指引回归，不为旧fixture恢复被移除的入口 |
| `packages/app-runtime/src/application-session.ts` | 同时保留 RunCloseConfirmation/清理诊断逐项释放，以及679 assertRunProviderConfiguration；注入 Provider/Run工厂合同不被误拦 |
| `packages/app-runtime/src/remote-run-api.ts` | 保留现有幂等结果先返回；新请求在消费窗口token、discover、预留新commandId和分配Run前核凭据；保留新预览timeout/cleanup错误及PROVIDER_CREDENTIALS_MISSING |
| `packages/app-runtime/src/run-factory.test.ts` | 同时保留工具/operation-guidance测试和主模型、有效distinct layered risk模型、注入工厂的凭据测试 |
| `packages/app-runtime/src/run-factory.ts` | 保留 unified source-finish Registry/Context、tool presentation、operation guidance和closeConfirmation，再加入资源分配前的凭据校验 |

**额外语义适配：** `remote-run-api.test.ts` 机械自动合并，但679 [:391](https://github.com/wszkxlllll/Computer-Harness/blob/679b08c43e1806b3cc0aae2db39b84d0487977d4/packages/app-runtime/src/remote-run-api.test.ts#L391) 的新凭据用例仍传 `nativeRecoveryProfile` 与 `native-recovery`。PR22 已删除这些 options/target 类型，且 [:523](https://github.com/wszkxlllll/Computer-Harness/blob/156baad40c74edbe4f97b4199c544167add8797f/packages/app-runtime/src/remote-run-api.test.ts#L523) 明确要求这些退役目标 INVALID_TARGET/零分配。因此不能把机械 clean 当作行为兼容。

本轮新增 exact156 API 纯探针确认：两种退役模式均在归一化阶段返回INVALID_TARGET，discovery/allocation/preflight调用均为0。应将凭据测试迁到保留的合法 window/browser/auto 或对应 CLI 单文件授权边界，保留“缺凭据不消费 token、不 discover、不分配 Run”和幂等重用断言。不要只删测试，也不要为了旧用例恢复已退役 API。本轮未编译或测试未解决的组合 tree，故不把潜在组合类型/测试失败冒称成156本身的新 bug。

## 5. 重点集成模块与路线判断

| 模块 | 可以保留的改进及审查结论 | 合并注意事项 |
| --- | --- | --- |
| CUA 拆分与 Mac 证据 | 输入路由、瞬态、sheet与文稿身份模块分离，但会话、观察、receipt/Abort与未知副作用仍由共享协调器管理；未发现新增已证实清理/重放缺陷 | 保留串行清理promise、RunId绑定、逐项诊断确认和ownerState，不能用旧整文件覆盖 |
| Browser 启动与点击 | readiness期限、DOM/UIA可见性与iframe覆盖、点位验证方向合理 | PRFIX-22必须修；全局 partial 与已知目标负证据分开处理 |
| Runtime/Context/Provider | finish schema 单一注册、默认关闭不残留额外参数、tool presentation与operation guidance一致性值得保留 | 来源绑定不等于事实或SKU语义验证；并入679时保留这些合同 |
| Web/Relay/API | Run/epoch/序号、device ownership、token单次消费、幂等及审批白名单等先前19项通过；七份源码pin仍匹配当前156 | 混版兼容及679 preflight整合后须重新测实际组合 |
| 语音/手机体验 | 手动播报输出会话、输入取消和无障碍焦点等代码改进保留 | 未实测实体手机/VoiceOver/实际扬声器，不能凭代码合并签收 |
| GLM 预算与配置 | 显式wire硬界限；默认Host text16384/wire24576；新thinking/timeout解析语义明确 | legacy未显式wire路线+4096须有明确决定，不能套旧PR24整文件 |

PR22 明确删除公共 Web/API 的 `native-recovery`、`native-web-document` 及固定任务编排，保留 CLI direct 的显式 URL、临时浏览器、精确窗口/单文件授权。这是有意的产品路线收缩，不是无意漏合。两份 Astra 计划必须按最终路线描述正常 Web 文稿任务，不能仍把被删除起点算成已交付。

混版风险保持：旧594 Host返回合法含旧profile列表，新156 Web校验器会拒绝整份响应；普通列表通过。发布时核对 Host/Web/Relay 同版，合并不自动替换现有现场或 Preview。

PR24 的独有 Mac topology/DOM字段等按行为另审，不以此扩大成本轮整包必合。PR27增量继续独立，后续纳入须继承PR23保护，不能重引F2。

## 6. 测试、review与证据边界

PR22新CI的两个失败已读Windows原日志/JUnit定位：

- `packages/runtime/src/index.test.ts:1018` 的“freshly observes a desktop foreground refusal without native handoff or replay”，`:917`的固定5000次setImmediate窗口未等到finished/waiting_window，报condition was not reached。
- `packages/app-runtime/src/environment-owner.test.ts:118` 的“quarantines an explicitly reviewed dead pending lease and writes an audit record”，超过Vitest5000ms，实际约5.607s。

没有expected/actual值不匹配；两测试文件均未被392修改，但不能仅凭这一点宣称纯flake或排除新增并行压力。应审清异步状态/文件操作依赖，做最小可解释修复或有证据的验证，保留断言，再等待实际最终head required CI；不扩大成Windows原生专项，也不删除测试、改skip或全局加时换绿。

| 证据 | 时间/对象 | 可以支持的结论 |
| --- | --- | --- |
| GitHub head/base/body/review/comment/CI | **本轮fresh采集**；22/23/26/27/main | 156没变，679已前进，latest checks绑定当前SHA；机械clean不是人工批准 |
| typecheck、Web build、2324 Vitest+72 Node | 本日上一轮实际执行；**同一 exact156** | 当前156现有套件通过；不是本轮重跑，也不能覆盖新负例或未来组合 |
| Web/API/Host/语音19项及7份源码pin | 上一轮实际执行，本轮重核源码仍一致 | 既有隔离合同探针仍适用于156；不是手机/实服验收 |
| F1红例、main/594对照、私有402绿 | 上一轮实际执行，本轮确认gate仍在 | 当前点击缺陷仍未关闭，私有修正方向可用；正式组合还未测试 |
| 两轮merge-tree、冲突块与自动合并用例检查 | **本轮新执行/静态核对** | 679合入存在5文本冲突及额外测试适配；没有执行未解决tree |
| 退役目标API纯探针、PR23截图覆盖反例 | **本轮新执行**；exact156与exact1f | 两退役目标INVALID_TARGET/零调用；截图直接同路径可被覆盖，F2须扩大输入保护 |
| 679凭据修复与native归档 | 本轮读提交与代码；CI当前head五绿 | 必须保留新成果；不冒称本轮独立跑过679全套或driver实测 |
| 新392类型/Web与定向检查 | **本轮新执行**；exact392 | Luna455/455；Sol18/18；关闭F1修复diff，不批准未来组合 |
| 新59评测文件、截图/真覆盖CLI及权限对照 | **本轮新执行**；exact59与old1f对照 | 160/160，输入保护通过；确认0600→0644新回归及正式替换测试覆盖缺口 |

PR22最新正式review仍为10/05 COMMENTED；当前body中的历史Sol GO不能排除后来新增反例。PR26最新正式review为10/13对**旧594**的COMMENTED，不涵盖新679；执行方需对实际新增/组合diff做Sol独审。这里区分GitHub正式review记录与有证据的独立代码审查，不伪造APPROVED。

本轮原始证据入口为 Git 忽略的 `runs/astra-autonomous-20261010-sol-luna/pr22-integration-review-20261014-private/`：

- `summary.json/md`、`version-comparison.json`、`prs/*/`：fresh API与正文/检查/review。
- `root-679-pr22-merge-tree.json`、`root-pr22-pr23-679-merge-tree.json`：两种组合的完整机械结果。
- `root-new-head-merge-tree.json`、`new-heads-20261014T1010Z/`：新392/59组合、元数据、455项及CI失败日志/分析。
- `root-pr22-file-inventory.json`：408文件分类与非测试文件清单。
- `sol-core-private/frozen156-local679-core-review.json`：核心源码pin、F1与679整合合同。
- `sol-web-private/integration-contract-evidence.json`：Web/API依赖、7份pin、语义冲突位置与相关私有探针。
- `sol-web-private/evaluator-screenshot-input-probe.json`、`sol-web-private/retired-target-probe.json`：新增合成覆盖反例与API拒绝回执。
- `sol-core-private/head392-f1-independent-review.json`、`sol-web-private/pr23-59a-review/`：新F1/F2独审、160项及Root新旧权限对照。

证据最初在0700的`/private/tmp/astra-pr22-integration-review-20261014-private/`生成，最终复制到上述忽略目录保存；仅公开报告和索引，不提交私有证据。前轮full-suite/red-green证据保持原路径，没有改写或相加。

## 7. 可执行的合并条件与交接

1. 继续既有执行对话的PRFIX-22/23最高优先批次，不新开竞争写入者。该对话已确认接收并在隔离目录实施；审查侧不改其代码/现场。
2. F1与F2输入保护已在新392/59有正式实现及独立验证；先修新writer权限回归、真正覆盖已有输出的正式测试，并处理PR22两个CI失败。保留679有效代码、测试和native归档，解决5处文本冲突及自动合并测试的语义适配。
3. 对实际修复diff完成Sol独审；按PR23→PR22依赖整合。最终组合head重跑类型、Web生产构建、完整仓库/评测与新增负向回归，等该head必要CI；新增变化需相应复核。
4. PR22正文更新到最终候选：准确列出679去向、PR23纳入状态、已关闭P2和实际测试，保留失败历史，不沿用旧“无阻塞GO”作为新批准。
5. 最终检查通过后按用户已有授权将PR22合入main，不再重复索要例行合并许可；不force push或跳过仓库强制规则。重新核main实际树/合并提交及两PR状态，保留审查、CI和merge证据。
6. 合并后接续Astra三线未完成出口；代码合并与发布、Mac/Web真实业务、手机/真人验收分别记账。不会把手机/新App权限等待改成这两项离线修复的阻塞。

本轮不提交/推送、发送GitHub review/comment或执行合并。新增审查结论与冲突处理原则交现有授权执行对话落实；正式修复和合并状态以其当前实际证据为准。

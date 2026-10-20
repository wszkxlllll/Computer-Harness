## 2026-10-14 最高优先：PR22/PR23 修复、独审与合入 main

2026-10-14 33后续：33b6c28完整离线2338Vitest+234Node/typecheck/Web/CLI及Sol复核通过。实际CI38552037147 Windows与Ubuntu22/24成功，Mac仅App.test.tsx401 gate焦点断言失败（DOM标题存在、activeElement仍body）；经App/RouteFocusOnMount生命周期独审，findByRole不保证passive useEffect焦点已结算。现只修测试deferred session结算/等待真实focus，保全部loading/不抢焦点等断言，不改生产；下一实际head继续完整测试/独审/CI后main。Actions已恢复，不把此失败误称账单或Windows问题。

2026-10-14 Actions恢复后接续：用户本人已确认恢复，fresh66cf92f的CI38550964967正常运行但Windows三个evaluator故障注入测试在加载前因--import磁盘路径（protocol d:）拒绝；2338Vitest全通过、Node231通过/3失败/0skip，其余三verify成功，required按Windows失败正确拒绝。此时不再是账单阻塞。Luna只修测试hook为标准file URL，不删负例/skip或改产品；新提交继续完整/typeWeb/CLI、Sol独审与同headCI，通过后按既有授权合main。66离线2338+234及Sol审查保留为旧head证据，不替代新head。

本轮冻结接收：MODE最终162/162与真实umask022/0755父目录CLI已Sol独验；679语义移植六套件218/218及typecheck已Sol独验、16文件pin/9–11段native来源闭合，已导入最终组合。evaluator接入标准测试列表。最终实际head全套/CI/组合独审继续执行；GitHub中间8fd四verify绿，但required作业因账户付款/额度未启动，已请账户负责人处理，main未合并。

### 本轮追加优先条件：权限保护与679整合

用户最新授权把PRFIX-23-MODE与PRFIX-679作为同一最高优先批次持续执行，**正式修复、实际最终组合测试、Sol独审、同head必要CI全部通过后，完成PR22→main合并**。现有对话01a124b9为唯一执行负责人，沿用Sol协调/Luna实施/Sol独审；不重复合并已经完成的PR23→PR22（8fd7c9d），也不因历史停止条款或手机等待停住这批离线工作。详见[专项审查及证据](./astra-pr22-integration-review-2026-10-14.md)。

1. **先完成MODE正式修复及回归。** 59及8fd的原子writer临时文件未设mode，umask022下将0600旧结果换为0644。采用显式0600或经证明不放宽原限制的实现；替换测试必须在子进程明确umask022，预置真实0600结果后直接调用CLI/保留输出的helper，不先rm。断言替换成功、内容合法、权限不放宽、全部输入（含初末截图）字节不变、临时文件无残留；保留direct/symlink/hardlink/父目录别名及open/write/rename失败回归。候选162绿只属作者阶段证据，Sol复核实际源码和有意义测试后记录正式commit。
2. **并行完成679移植，避免文件覆盖。** 基线679b08c/PR26是共享凭据提前拒绝及native诊断链归档；对实际最新PR22核diff，不把“旧594已包含”当“679已包含”。ApplicationSession/run-factory尊重注入Provider/Run工厂；仅检查主模型及实际启用的distinct layered risk模型；新请求在消费窗口token、discovery、预留新commandId和分配Run资源前拒绝缺凭据；已有幂等结果优先返回。保留错误码/Host409中文提示及零副作用回归。
3. **解决文本冲突并核机械clean文件。** 五个已定位冲突是Host server.test、ApplicationSession、RemoteAPI、RunFactory及其test；两边有效合同同时保留：closeConfirmation/迟到cleanup逐项释放、ownerState、统一finish schema、工具说明和operation guidance不退回。remote-run-api.test虽机械clean，679新凭据用例却引用已退役nativeRecoveryProfile/native-recovery；迁到保留的window/browser/auto或相应CLI单文件边界，保留零discovery/零allocation/token不消费及幂等断言，不删除保护或恢复退役入口。保留native9/10/11 patch/source-chain来源，不能冒称运行中driver已部署。
4. **冻结并验证真正组合。** 两项修复合入后记录源码pin与最终head；重跑typecheck、Web build、完整仓库/评测/新增负例，确认evaluator接入标准测试入口或有明确完整独立命令，Sol独审实际组合及来源。旧156的2324+72、392的455/18、59的160、候选162、679的旧CI均不替代最终组合检查。源变则对应重核，不盲目重复已验证无变模块。
5. **处理最终head的CI并完成合并。** 392历史失败为Runtime固定轮询窗口与租约集成测试期限；046已做事件等待和该单项有界期限修正进入8fd，不能把旧失败冒充新head失败，也不能直接继承旧绿。定位新失败的真实原因，保留断言和失败历史，等待实际最终head全部必要CI成功、Sol独审无新阻塞，再按已授权PR22→main合并。不得force push、跳过分支强制规则或删/skip测试。Windows/Linux原生工作排除，现有required共享CI保留。
6. **合并后核验并续办。** fresh读main、PR22/23状态及实际merge/tree，证明含F1/F2/MODE与679有效行为/归档；若采用选择移植，不用679整commit祖先性作唯一判据，保留逐文件/行为映射与回归。落测试exit、review、CI run和merge SHA，更新两份计划及执行记录。PR24/27不强制合入；代码合并不签收部署、正常Mac/Web业务或手机验收，之后继续原Astra未完成部分。

本节是正式最高优先执行/验收要求，接续时按最新证据更新状态；接收、作者候选测试和派工不算修复或合并完成，不重复请求例行实施/合并许可。共享现场、私有文件及已知/未知用量记录保留。

新增复审接收（2026-10-14，同一PRFIX批次）：[专项集成审查](./astra-pr22-integration-review-2026-10-14.md)发现PR23-MODE（0600旧结果原子替换后0644，旧existing测试先rm文件）。已派Luna修mode及真正existing替换回归；旧160绿及独审仅限定已覆盖部分，main不得据此放行。同时隔离移植679凭据提前拒绝与native归档，保留PR22新cleanup/finish/API合同、迁移旧profile测试到合法目标，不恢复退役入口。最终组合全套、必要CI与Sol独审仍为main前置。

当前批次进度（2026-10-14）：PR22/F1正式修复392b6ca及两项共享CI测试修正046019d均已Sol独审；PR23/F2正式修复59a952d完整160项与CI五绿，已实际合入PR22，merge为8fd7c9d。现在冻结最终组合，接入evaluator标准测试并重跑全仓/类型/Web/CI与最终Sol审查；main尚未合并。392失败历史保留，不用中间CI或旧594/679的绿授权当前组合。

执行接收（2026-10-14，本轮 PRFIX-20261014）：Root 已接收最高优先队列；fresh API 核实 PR22=156baad、PR23=1f57852、main=961a098、PR26=679b08c。679 的 CI38544542836 已 completed/success；其新凭据预检及 native patch 交付独立保留，尚未计入 PR22。现在建立隔离候选，由 Luna 分目录单写、Sol 独审；未操作前台、服务或实体手机，未开始合并。源码、review、CI 与合并证据持续写入新私有批次 prfix-merge-20261014-private。

本轮接续记录：[PRFIX 正式修复、版本分叉与合并证据](./astra-prfix-merge-execution-2026-10-14.md)。PR22 最终产品路线移除旧 native-recovery/native-web-document 公共 Web 起点；旧594 profile交付只作历史，后续按普通Web和CLI显式受限实验分别验收。679及其CI五绿保留在PR26，尚不属于PR22。native11权限同意已收到，当前仅延期前台操作，不重复请求该App授权。

用户明确授权本轮执行 **修 PR22/23 → 测试与 Sol 独审 → PR23 合入 PR22 → PR22 合入 main**，并要求现有执行对话优先完成、不因历史停止条款或手机条件停住。负责人“审查并同步 AStra 计划进度”（01a124b9-c56b-7a91-89d8-2581f4ae15a6），Sol 协调、Luna 单写者实施、Sol 独审；本节优先于下方旧 R1–R6/现场队列。证据与位置见[详细审查](./astra-premerge-review-2026-10-14.md) F1/F2；最高优先不是将 P2 改为 P0 严重度。

### A. 接收、核版与隔离

- 先记录当前现场、已存在 dirty 和新提交 `679b08c`，fresh 核对 PR22/23/main/PR26 的 head/base、检查及 review。17:47 的审查参考是 156baad/1f57852/961a098，不是未来版本保证。保留新凭据拒绝修复及其测试，不 reset、覆盖或混入未经审查的改动。
- 使用适合的隔离 checkout/worktree 承接两个 PR 修复；不切换共享现场分支或抢占桌面/服务。两个修复可分目录并行，由每个目录唯一写入者负责；不要并发修改同一 CUA/API/评测文件或共享构建。
- 私有反例/原型在 `runs/astra-autonomous-20261010-sol-luna/premerge-review-20261014-private/`，源码固定与测试记录齐全。可读这些证据重新构建有意义回归，但不得提交私有日志、凭据或用户轨迹，也不能用私有绿例替代正式源码检查。

### B. PRFIX-22：保留已知 DOM 负证据

- exact PR22 `packages/computer-cua/src/cua-driver-computer.ts:4234–4238` 以 `domComplete===true` 限制寻找 DOM 对应项。反例是同一次 observation 的 UIA 与唯一已观测 DOM 按钮角色/名称/bbox 相符，UIA enabled，DOM disabled；或 fake DOM live click 若调用会拒绝遮挡。仅全局 complete=false 就导致 native 1、DOM 0、completed。
- 正式修复不得因全局 partial 丢弃已知 disabled/点位限制。可走保留约束的 DOM 验证路线，或证据不足时拒绝该目标；真正 missing/ambiguous 的合法 native fallback 保留，不给所有 partial inventory 增加全局硬拒绝。
- 新增 complete/partial 的 disabled 与 live-validator 负例，并保留 missing/ambiguous fallback 正例、精确身份/点位、stale ref 零新增派发。审查工具提示、源码注释和测试路线合同，不能仅删 gate 并改成宽松期望。
- 私有历史为当前六项 4绿2红，最小原型6绿；首完整401/402中的失败来自旧 positive partial fixture 写死 native 路线，经独审更新为 DOM1/native0 后402/402、0skip。该历史保留；正式实现须重新执行适配器全套和相关常规检查，取得新的源码 pin 与独审。

### C. PRFIX-23：评测输入保护及安全写入

- 在 PR23 正式评测器修复输出保护：保留 resolve 同路径检查，比较 canonical 路径和已有文件 dev/ino，拒绝输出是输入别名。保护 trajectory、manifest、human-review 以及该实际版本支持的 independent-findings；不要为测试导入 PR27 才有的新功能。
- 覆盖直接同路径、末端软链接、硬链接、父目录别名，断言非零退出、原输入字节/SHA 不变。保留正常新输出/现有合法结果覆盖合同。使用同目录独占随机临时文件写入再原子 rename，或证明同等输入保护的实现；补写入/rename失败、临时文件清理与不截断输入的检查。
- exact PR23/27 软链接反例均已独跑复现；172/173及三类别名红绿属于旧 PR27/私有原型证据，不继承成 PR23 的正式结果。对修复的实际 PR23 运行自身完整评测测试及新增回归，再由 Sol 独审实际 diff/源码。

### D. 推送、组合验证与合并

1. 两项正式修复各自通过相关测试与 Sol 独审后，精确提交并非 force 推送，更新对应 PR 描述/验证。无直接写分支权限时用针对原分支的修复 PR，仍保留 PR23→PR22→main 依赖，不另造互相替代的产品分支。
2. 以 fresh 远端 base/head 将修复后的 PR23 合入 PR22 所在 `codex/runtime-surface-preview-20261003` 分支。PR23 当前不是以 main 为 base；不要只改 base 到 main 来跳过整合验证。修复/审查后的源码发生变化时重查相应部分。
3. 对实际组合 head 重跑全仓 typecheck、Web production build、完整仓库与评测测试、新反例，等待该 head 全部必要 CI，并由 Sol 检查组合 diff、公共合同和无漂移。旧156的2324+72、旧CI绿色、COMMENTED或mergeable=clean不能替代。
4. PR27 不作为本轮必合依赖。若后续另行选择吸收，原模拟显示 `remote-run-api.test.ts` 有一处冲突，须保留双方有效回归，并重新验证组合；不许为消冲突删除断言或重引 F2。
5. 核对 PR22 两个 Web profile 的路线收缩并同步计划说明；核对新本地679b08c与PR26去向。其他独有能力/PR24选择暂不扩成本轮整包合并或手机前置。
6. 最终 PR22 当前 head 测试、CI、独审通过且无新阻塞后，按用户本轮授权执行 PR22→main，无需再次请求例行合并许可。保留历史，不 force push、不跳过仓库强制分支规则；如果实际分支规则要求外部审批或工具自动审批拒绝，记录确切原因并继续未受影响工作。
7. 用 fresh API/Git 验证 main 实际树/合并提交包含两项修复、PR23与PR22的最终状态；merge方式可能产生不同SHA，以实际树/补丁及回归核对，不能只用旧head祖先关系判失败。记录测试命令、exit、源码pin、review、CI run和merge SHA，更新两份计划状态。

### E. 完成后的续办

合并不自动部署或签收业务成果。随后回到 Astra 三线现有未完成事项，按同版 Host/Web/Relay、正常 Guard、真实 Mac/Web与手机独立出口继续；保留 T2 CLI 三轮限定通过和所有历史失败/未知用量。Windows/Linux原生专测仍排除。本轮两项离线修复及代码合并不等待新App TCC、前台空闲或实体手机。

交接状态：本节已准备供执行，发送与接收结果由协调方追加；实际修复/合并尚未由本节证明。


> 最新执行状态（2026-10-13）：八项 MR 已修复提交3b84287，test-only确定性等待修正9720350已推送且当前CI五项全通过。本地完整2076项Vitest＋72项Node、类型检查和Web构建通过；现进入新环境零真实Provider Mac诊断。T3新能力在隔离树实施，正式三线业务及手机专属验收尚未完成。详见 [本轮执行记录](./astra-mr-repair-execution-2026-10-13.md) 与 [现场验证记录](./astra-live-validation-2026-10-13.md)。

# Astra 自主测试与修复计划

## 2026-10-12 小组意见整改与执行交接

本节是用户最新要求下新增的执行队列；由Astra/medium综合审查，意见MR-01至MR-08、源码和验收详见[唯一审查表](./astra-member-feedback-integrated-review-2026-10-12.md)。下方11:53是上一轮收尾，不抹除已证成果，也不能作为拒绝本次计划接收的理由。此处规划未计为修复通过。

| 顺序 | 工作 | 实施与有意义验收 |
| --- | --- | --- |
| R1 | MR-01+MR-07：普通恢复顺序、机器信号 | 先真实Runtime组合失败fixture，再最小共享协调修复；completed/unknown不重放，普通模式与受限profile分证，不扩Mac面板特例 |
| R2 | MR-02：共同有效平台必要影响 | 先缺/无效/冲突报告下共同合同与Mac消费者核查，再按证据最小修；Windows专属绕过移交，不建Windows专项实现/验收任务 |
| R3 | MR-03/04/05：实时审批、Qwen日志与出站合同 | 过滤后四字段GET/SSE/Relay/Web一致；fake Provider一次调用且成功对象/原错误不被日志失败改变；GLM与Qwen实际启用输出模式的出站说明完整、有界、同Registry |
| R4 | MR-08归因、MR-06呈现 | 慢阶段/取消/清理的可控期限复现决定改法；来源结果用中文说明但证据状态限定、回放和默认关闭保持。先离线，不凭数值差宣称取消故障 |
| R5 | 必要零Provider→新冻结版本正常Web/Mac任务 | 先独检/构建/相关检查，必要Mac恢复/预览诊断后再正式原卡；正常Web/default layered完整T2与T1/T3三轮分别出证，原卡/唯一输出/预算不降标 |
| R6 | 评测、手机预留与交付 | PR23/27依赖隔离；业务成果/评测器/真人评分分栏，PR28材料不当业务通过；新发布包按实际源码/资产核版，手机M1–M4专属项保留 |

接续时先读本节和综合审查，核HEAD/source/dist/预算与服务现状；不复用旧PID/window/表单索引、旧认证挑战或已消费Run。先完成意见接收和离线反例/最小修复，不在收到交接的瞬间启动新的付费GUI业务轮。需要真实运行时沿既有有界账本与监控流程，不能把498历史请求清零。

组织方式继续Sol统筹、Luna实现、Sol独检；Astra/medium用于本次意见整合与计划接收。重叠模块单写者、桌面与服务切版互斥。每条MR记录版本/反例/改法/定向结果/真实入口/计数/未覆盖范围；review历史339项与追加5项失败不能当本轮重跑。没有新变量不付费重试，不用实验功能扩张替代共享问题收敛。

T2同95b CLI L2 experiment、Guard/risk off三轮限定PASS与F1–F4已修保留；它们不关闭MR普通模式问题或正常Web/default layered出口。Windows/Linux原生工作及其专项测试仍排除，实体手机与真人项另列。主目标与验收见[总计划新增条件](./astra-three-track-master-plan-2026-10-10.md#2026-10-12-小组意见综合审查补充当前整改完成条件)。

点击路线合同（PR22 F1）：受管浏览器内容仍优先使用观察内唯一匹配的 DOM 控件；全局 DOM 为 partial 不抹去该控件已知的 disabled 或实时点击校验拒绝。只有没有唯一 DOM 对应项时，非容器 UIA 控件才可走现有带身份、几何与精确点位检查的 native fallback；此合同适用于正常 Web/Relay 与共享 CUA，不扩大平台专项工作。

本地内容核对补充（2026-10-12）：[实际源码、成果与旧进度纠正](./astra-local-directory-verification-2026-10-12.md)。三份T2成果文件和原始轨迹已重新核实；后段旧看板不能覆盖顶部当前状态。

2026-10-12 11:53 本轮修复完成并停止（用户要求本轮完成后停止，最新状态以本段为准）：F089已精确27文件提交并原SHA推送 `e7bce7f7792b455d02212c717a34206412002d14`；来源引用finish默认关闭，可经正常CLI/Host显式配置，Runtime只引用本Run已持久化Observation中的保留grounding并规范渲染结果，未知/推断明确标记。它验证来源与输出绑定一致性，不机械判断SKU语义或事实真值，不计T1业务通过。作者最终452/452，Sol独检239/239与Root独检213/213互补合452；主工作区tsc-b exit0，24源文件与冻结pin全部一致。当前HEAD CI38201158820已由Root于03:52:50Z实际核completed/success，4 verify及ci-required共5job全部success，不继承旧cb93五绿。详见[F089](../../a-line-sync/fixes/F-20261012-089-source-linked-finish.md)及[来源引用审查](./astra-source-linked-finish-review-2026-10-12.md)。

本轮未新增真实Provider请求或GUI业务。A07仍actual61main/0risk/61、reserve120/6/126 rev2；累计498actual=490main+8risk、468known合8,600,579tokens、30unknown，金额未知。95b CLI L2 experiment的T2完整基线/独立repeat/原variant三轮限定通过；正常Web首录入1134B而原卡1133B，已取消并保留轨迹/文稿，不算原卡通过。新表单实际AX值曾逐字核1133B/尾1LF，尚未再次Start；不再启动新Web/paid轮。T1业务、T3完整闭环及其复验/变体、真人五维、实体手机/语音与Preview远端部署仍缺，T3只读设计保留，未实施。

收尾资源已核：所有既有Run终态后，自有Host26665与Relay26276逐UID/start/完整argv确认，各一次SIGTERM、ps gone且原PTY均exit0；Root keeper26995已由Root精确停止，不续保活。native98330、stock4254、归属未证debug21139及旧成果/错误路径文件未动。隔离T1工作树保留供审阅。六入口仅同步本地最终状态，不新增提交循环；本轮修复与CI已完成，现停止工作；不再启动任何后续任务。

2026-10-12 10:34 历史实施快照（最新见顶部）：F087 Host/API/Web/Relay 精确 native profile 已提交3001a1c；完整真实本地Host+Relay+native零Provider短诊断1b545917 seq168 succeeded，37B两行中文emoji/13proposed=13completed/13Guard，surface5 gen2/nativeCG18657、末PNG及298行journal已由Sol/Root分别核验；仅短fixture，不代正式196B或Web按钮业务。共享Relay严格selector透传/非法零转发已验。3001 CI三非macOS job失败均为两新测试未限定Darwin，旧失败保留；F088 cb93d5dfae624d7b1bb9ec66336e7cad4eea6318 同时窄修测试fixture及native-profile goal原文保留，旧mode trim不变。Sol边界38/API66、Root独检108、tsc-b/Web build均通过；cb93当前CI38194908632五job实际success，不继承旧head绿。

正常Chrome已实际完成本地Relay配对、预设文稿选择及Start，首Run1791771467257-f772b05d-579监督ready02:17:47.434Z<created.435Z<首Provider48.453Z；但Sol录入多一个末LF，实际1134B而非冻结1133B，故经正常API abort终态63cancelled，不计正式原卡PASS。六main请求/五known95247tokens+一unknown、四动作已执行（纯文本转换、196B输入、CMD S、CMD SHIFT G），完整原轨迹/正文保留。终态后仅ESC退出自有GoTo与Save面板，旧稿不删除/重放；原30aa目标仍absent。

A07 actual61main/0risk/61，reserve120/6/126 rev2/cap原样；累计498actual=490main8risk，468known8600579tokens、30unknown，金额未知。新正常空白primary18934/recovery18931经原生与Swift空值/精确focus验证，旧18739不用。新Host26665 start10:22:44/PTY34826，Relay26276 start10:13:59/session54313加载cb93；最终模板e9b61f99…及18source+11dist已核。新正常Web配对后，启动前实际textarea AXValue于02:27:43.855Z核1133B/SHA54fb4b96…/尾1LF与原卡逐字相等，receipt sol-web-prestart-actual-ax-goal-exact.json。随后CUA两次各100s返回user still interacting with Chrome，尚未再次Start，不用旧按钮索引或其他输入通路绕过用户活动保护；下一步正常刷新并重读表单后Start。

Root唯一keeper25677/UID501/start09:59:28/PTY41780至10:59:28；native98330/6f56签名/TCC未动，保活不等同focus。三轮95b CLI L2 experiment限定PASS仍与Web/defaultHost新组合分列；正常Web完整T2及其同版repeat/原variant未通过，T1/T3全出口、真人五维、实体手机/语音听感、Preview远端部署各独立保留。T3 hybrid只读设计并行准备，不把native-only profile套到hybrid。

2026-10-12 09:25 历史实施快照（最新见顶部）：新Host文稿profile的Host/API/Web回归已通过（Sol原128项及刷新后Home26项，Root strict-schema6项/expiry1项），F086 30c6五CI实际绿；尚未提交的新feature不冒已获CI验证。最终监督Node18/18与Python7/7分别实跑通过，8依赖manifest9c9a4079逐SHA核同，旧fixture/manifest失败保留。真实本地Host/Relay完整诊断首次4909c98b于01:21:55Z在POST /api/runs被Relay严格union拒400，0Run/0桌面业务动作/0Provider，已精确定位shared relay-connector routing未接native-recovery；单写者正在补精确selector与真实透传/非法零转发回归，再新UUID诊断，不重放未知动作。

A07 reserve120main/6risk rev2、actual55/0/55、累计492actual/463known8505332tokens/29unknown均未变。Web卡1133B/54fb4b96、196B/58a4及唯一30aa输出保持；下一正常Web完整Run仍待真实本地profile保存/关闭/恢复/一次重开链验证与最终pin。Root唯一keeper21334/UID501/start09:17:08/PTY39992至10:17:08，native98330不变；保活不等同焦点证明。


2026-10-12 09:12 历史实施快照（最新见顶部）：F086提交30c6d702725d2c16d33dda2410751019179c7cf2的CI38189564088已由Root实际GET核五job全绿。新Host文稿入口尚未提交/实机验收：15文件最终冻结，Sol独跑相关128/128、tsc-b exit0、Web production build exit0；Root独跑schema相关6/6，新增模式明确拒绝switchWindows true/false且零启动/零消耗，随后合法请求可启动。默认普通Run不继承grant；单次消费/同command幂等/失败后不再显示配置均已测。最终源码与dist记录见A07-private/sol-native-profile-frozen-source-independent-review.json（138aaef3…）。

A07 rev2预占120/6/126已正常完成，actual55/0/55及seq55/派发链不变，下一40请求余额充足；累计492actual、463known/8505332tokens、29unknown，尚无新Provider。Web完整卡仍1133B/54fb4b96、正文196B/58a4，仅唯一30aa路径变化。下一顺序为真实零Provider Host profile完整保存/关闭/恢复/重开诊断，再正常Web按钮完整T2；Host默认planning=true、facts/lexical记忆、same-control-input-v1 batching、recent/maxHistory32、live-interactive/layered、riskModel=same且riskMaxModelRequests1均如实保留，不称仅Guard变量变化。CLI三轮同95b限定通过不冒Web/defaultHost通过。私有监督18/18已独跑；monitor身份由substring收紧精确argv后作者7/7，最终live前独审中。Root唯一keeper17626至09:37:39，native98330/签名/TCC不变。

2026-10-12 08:53 历史实施快照（最新见09:12）：F086报告窄修已精确3文件提交30c6d702725d2c16d33dda2410751019179c7cf2并原SHA API同步PR26（session27018 exit0，未force），Sol完整RunHandle44/44+tsc-b exit0/diffcheck0；Root独立真实三轨迹只读report replay3/3+五场景focused1/1，原业务轨迹/summary不覆写。已开始reopen且无新exact handoff时报告最终target为null，两明确未launch拒绝码保原target，switch指标不混reopen。新HEAD CI38189564088实际in_progress，旧95b五绿仅属三轮冻结版本，不冒新绿。

下一付费验证合并真实Web入口与Host默认layered/riskModel=same，取消额外非interactive CLI paid轮（其默认实际experiment/Guardoff且approval会自动reject，不绕reopen禁interactive gate）。当前由Luna native_identity单写者实施最小Host启动native recovery profile：默认关闭、精确两自有blank/唯一文件、客户端只选opaque profileId、复用现pairing/CSRF/幂等和native-only uia gate；不新增admin/TTL体系、不放宽Guard或grant、不套T3hybrid。先完整正反回归+真实零HTTPprofile生命周期，之后正常Web完整T2有界Run；累计492/A07actual55尚未新消费，下一40仍需append-only续预占。三CLI同95b业务限定PASS详下方；Root唯一keeper17626至09:37:39、native98330不变。


08:57准备补记：A07已沿extendBatchReservation正式append-only续至120/6/126 rev2，actual55/0/55、seq55及dispatchchain25d136不变，Root已独核；尚无新Provider。新Web完整卡只换30aa0257…txt路径，goal1133B/54fb4b96、body196/58a4原样、目标absent。实施范围见[Web native recovery profile审查](./astra-web-native-recovery-profile-review-2026-10-12.md)，当前尚未实测此新入口。

2026-10-12 08:39 历史三轮终态稳定点（当前实施见顶部）：同一冻结版本95b8449/native8完成T2基线high-v6、独立repeat high-v7、原冻结variant三轮完整自主保存→关闭→恢复→重开→内容核对，均自然succeeded、真实PTY exit0、summary同Run且cleanupDiagnostics[]，Sol/Root分别独审限定PASS。三轮严格属于CLI L2 experiment（riskGuard/riskModel off）；默认layered与真实Web L3未据此签收。

最新variant `run-1791765130536-e28cb507-99b` seq156于2026-10-12T00:36:25.707Z succeeded，原1132B goal/d237535…、196B正文/ebe8未改。指定136d8091…txt实际196B逐字正确、88码点/6LF/末1LF/0CR，seq123保存verified→129CMDW→138list→140handoff→149singleton正常odoc重开→152/153新surface5 gen2完整AX正文，最终nativeCGID18598，末PNG已实际视检。15proposed=13completed+2明确native refused，另2参数派发前拒绝；20main/20known=260215input+9791output=270006tokens，全部实际high/enabled8192/nonstream；CLI15497/helpers15503/15504均退出，PTY30197 exit0。两次point拒绝保留：exact AXfocus成立但CG点位gate看到恢复blank18554覆盖目标；准备顺序未修复此矛盾，保持严格拒绝，后续仅零HTTP归因，不猜外部失焦。

三轮合计55main/0risk/55；A07 actual55/seq55、reserve80/4/84 rev1、cap120/6/126，剩25main不足下一40，后续需正常append-only续预占，不清actual/历史。累计492actual=484main+8risk，463known合8505332tokens，29unknown保持未知。95b当前CI38186986942五job实际success。Root唯一keeper17626/UID501/start08:37:39/PTY42505至09:37:39（旧8974精确退出）；native98330/6f56签名/TCC不变，保活非焦点证明。

下一步单写者Luna只修reporting.ts最终目标元数据：已派发singleton reopen后不得虚报恢复blank，保守unknown；明确pre-dispatch NOT_READY不抹仍有效旧目标，后续exact handoff可恢复。新版本与上述同95b三轮分列，先真实轨迹回归和定向独检再build/提交/新CI。T3原卡/来源后首保存前合法客户端预算纠正、default layered与Web按钮出口仍待实际验证；T3 hybrid不能直接套native-only单文件grant。v6 evaluator真实入口消费已完成，human五维仍null、仅human_review_missing/inconclusive，外部业务PASS不冒真人评分。Preview仅暂存未部署、远端sudo、实体手机与真人评分各自保留缺项。


当前Web实现缺口已只读定位：POST /api/runs仅接受单目标/browser/desktop/auto，无法正式配置双native recovery与单文件grant；现factory又明确拒grant与hybrid/companion混用。此项属于需实现的已授权范围，report窄修及默认layered CLI后，设计并实现默认关闭的Host-owned native recovery profile（客户端仅opaque选择、Host冻结双窗/单文件/会话作用域），再真实Web完整T2；不把API fallback或native-only路线冒作T3 hybrid全链。

2026-10-12 08:33 历史variant运行快照（最新见顶部）：原冻结完整T2 variant high Run `run-1791765130536-e28cb507-99b` 已实际启动，CLI15497/PTY30197/ttys018、唯一monitor15503/observer15504均UID/start08:32:10逐核；ready2026-10-12T00:32:10.594Z<created .599Z<firstProvider11.421Z，goal1132B/d237535…逐字原卡，正文196B/ebe8不变。当前6 actualfetch配置high/enabled8192/nonstream已核，source95b/17dist/native98330不改。Luna唯一PTY/业务，Sol与Root仅只读；此时活跃未签variant结果。下方472累计与A07actual35为本轮启动前稳定数，新请求终态后正式对账。

2026-10-12 08:32 历史repeat终态稳定点（variant最新运行见顶部）：同版独立T2 repeat high-v7 `run-1791764743356-a4021c89-db7` 已seq119自然succeeded（00:28:10.987Z），PTY3979 exit0、summary同Run/cleanupDiagnostics[]。Sol独立业务限定PASS：eb092f5c…txt磁盘196B逐字58a4/6LF末1，实际view重开PNG；seq82保存verified→92CMDW→97fresh list→103handoff→112singleton→115/116新surface5 gen2，native最终18548，完整自主链。11proposed=11completed、0nativefailure，seq86多键keypress参数在派发前拒绝后模型自主改hotkey；15main/15known=164041input+4528output=168569tokens，全部high/enabled8192/nonstream。A07 actual35main/0risk35 seq35、reserve80/4/84 rev1；累计472actual=464main8risk、443known8235326tokens/29unknown，旧baseline20与旧批次不清零。这与baseline共同构成CLI L2/experiment Guardoff两轮通过，默认layered与Web L3未据此签收。

真实baseline v6已由隔离PR27 evaluator HEAD3f22正式入口零Provider消费：manifest9f923…精确绑定任务卡/轨迹/初末PNG，assessmentf354… terminal160/succeeded且图片bound；五维全null、inconclusive/successfalse、唯一缺项human_review_missing。Sol/Root业务PASS是外部独审，没有冒human或用负面strict-findings通道伪填正分。产物A07-private/a07-t2-baseline-v6-evaluator-{assessment,receipt}.json，原始材料保私有。

原冻结T2-variant.json保持1132B goal/d237535…、196B正文/ebe8（10/5、8800元最多2人、08:45集合09:20出发），原136d8091…txt首次目标仍absent。正常新blank recovery18554→primary18557的CMDN/SDKraise/Swift AX0/focus/modifier证据通过，同95b17dist/native8/high40入口--check exit0；已交Luna唯一PTY一次variant，实际Run待创建。本轮A07剩45main足40，不新增预占/不改cap。95b CI38186986942五job实际success；Rootkeeper8974至08:55:28、native98330/6f56签名/TCC不变。T2 variant未过前不勾总验收，完整T1/T3各三轮仍待实证；Preview仅暂存/实体手机/sudo/真人五维保持独立缺项。

2026-10-12 08:27 历史repeat运行快照（最新见顶部）：同版独立T2 repeat high-v7 `run-1791764743356-a4021c89-db7` 已由Luna唯一正式PTY3979启动，CLI13679/monitor13685/observer13686实际UID/start08:25:43与ttys018均独核。ready2026-10-12T00:25:43.414Z < created .419Z < 首Provider44.237Z，完整goal1133B/d04a925逐字新卡，只换eb092f5c…txt输出路径、正文196/58a4不变；HEAD95b/17dist/native98330/6f56均同版，high/enabled8192/nonstream实际出站已核。新recovery18512先建、primary18515后建均正常CMDN/SDKraise/Swift空白证据，不动上轮18506成果。Sol/Root保持只读，不代业务；现活跃未签repeat结果。此前完整baseline PASS与累计457actual/428known8066757tokens/29unknown为启动前冻结基线，本轮新消耗终态后按counter正式对账，不把旧数字当当前实时值。A07预占80/4/84 rev1，终态前不重置actual。现有monitor磁盘初态字段只在启动/结束持久化，实时进展直接读轨迹，不能把observedModelRequests=0当当前无请求。

2026-10-12 08:22 历史基线终态稳定点（最新运行见顶部）：完整T2 baseline high-v6 `run-1791764013665-187836ef-750` 已seq160自然succeeded，真实PTY2623 exit0、summary同Run/cleanupDiagnostics[]；Sol与Root独立业务限定PASS。指定371b9081…txt实际196B逐字等于原正文、SHA58a4fcd47da3982ab890ad46febf0eecd7c3c8d52b19723d65092d43cac43beb、88码点/6LF/末1LF/0CR；seq127 saved verified→133 CMDW completed→138 fresh recovery list→144 handoff→153 singleton正常应用odoc重开completed→156/157新surface5 gen2、实际nativeCGID18506及完整AX格式/正文，两位检查方实际看末PNG。模型自主纠正单键S并在Save click被拒后用RETURN保存，无人工补输入/绑窗/关闭/重开。此为CLI L2/experiment Guardoff完整基线，非默认layered或Web L3通过，也不代T2 repeat/variant及其他两线出口；recoveryReport.businessResult按设计仍not_assessed，业务PASS由独审单列。

启动监督ready2026-10-12T00:13:33.742Z < created .745Z < firstProvider34.618Z，完整goal1133B/SHA8a8923…逐字原v6卡、CLI11440/monitor11446/observer11447真实TTY/身份已独核，终态均退出。16 action.proposed精确等于14 completed+2明确refused，非16completed；20main请求/20已知usage=255033input+8278output=263311tokens，20实际fetch配置全部high/enabled/8192/nonstream。A07 actual20main/0risk20、seq20，正常append-only预占已续至80main/4risk84（rev1/cap120/6/126），actual与派发chain不变；旧A06冻结97main1risk98，累计457actual=449main8risk、428known8066757tokens/29unknown，未知不估填。下一同版repeat/variant正常独立fresh和新唯一路径，禁止复用本成果覆盖。

新原生只读journal实际319rows，call9/root18455与call192/Save18476拒绝时frontmostPID22394、focusedCGID均exact；point gate实际阻断者为预备recovery18458且CG层序在target之上。不能再把这两拒绝泛称失焦/overlay/外部活动；保持严格拒绝且未重放，模型自己换正常键盘路径推进。报告summary.finalComputerTarget仍18458属reporting.ts72–84只跟踪最后handoff/switch而未投影reopen目标的旧元数据，新native末call319和surface观察证实18506；已登记窄报告缺口，暂不改95b以保持复验同版。独审原始回执位于本Run的sol-terminal-business-independent-review.json及root-terminal-independent-review.json（私有，不提交正文/PNG/轨迹）。

F085冻结HEAD95b8449已原SHA同步PR26；当前95b8449 CI38186986942已由Root实际GET核五job全部completed/success（root-95b8449-ci-terminal-readonly.json），不继承旧head。native98330/6f56/CDHasha47177/签名与TCC不变；Root唯一keeper8974至08:55:28，保活非focus证明。完整T1/T3与各repeat/variant仍未验收；Preview08dec仅暂存未部署，实体手机/远端sudo/真人五维独立待补。

2026-10-12 08:13 历史启动前稳定点（最新见顶部08:22）：F085已精确11文件提交95b8449bc1e3d1bef06f68621c94547f1c75c358并正常API原SHA同步PR26（session68411 exit0），新CI待实际核；此前f14cd66/38185945146五job实际success只属test-only历史版本。新增Host singleton opt-in Observation保存事实：精确授权文件ENOENT+稳定父身份才absent，exact当前clean/app/URL+初尾filepin才verified，其余unverified；默认/恢复blank/重开新CGID省略。不输出正文、路径或操作建议，不放宽grant/Guard/未知不重放。fingerprint只比较source/status，保持同状态新Observation ID的no-op拦截。

作者修前四文件595/595、tsc-b session82041 exit0；Sol捕获parent负例原fixture缺有效native proof并纠正，修后作者单例1/1、Sol独跑CUA20/20+Runtimefingerprint1/1、Root Context/trajectory2/2。EACCES/EIO仅生产classifier注入reader正反，不冒OS权限实验。Sol唯一GUI真实零HTTP完整singleton run-1791763650712-7605c90a-84e已succeeded：16本地fixture决策、13completed Computer动作回执、33B精确SHA244236，compiled Provider文本absent→保存verified→恢复/重开omit、持久obs/ref绑定，关闭/恢复/重开/fresh普通操作/finish通过，Root独读磁盘/轨迹/消息并实际view重开PNG。未额外采native launch原raw计数，1reopen提案不能冒原生调用计数；此为短诊断，非正式T2业务通过。详[F085](../../a-line-sync/fixes/F-20261012-085-authorized-save-observation-evidence.md)。

A07新有界预占40main/2risk/42、cap120/6/126、actual0/seq0/rev0；旧A06仍97main1risk98，累计437actual=429main8risk、408known7803446tokens/29unknown，未知不估填/不重置。下一完整T2 high-v6仅新371b9081…txt路径，完整goal1133B SHA8a8923…、正文196B SHA58a4/6LF/末1不变；newblank主18455/恢复18458正常CMDN+SDK/Swift exact空白证据、17dist含Context/trajectory已冻结，最终--check exit0，已交Luna唯一正式PTY入口一次执行，尚待实际Run创建。正式基线沿experiment Guardoff，0HTTP layered诊断另列；不冒默认Guard业务通过。native98330/6f56/TCC与签名不变；Root唯一keeper8974/session92247至08:55:28，非持续focus证明。完整T1/T2/T3及repeat/variant仍待实证，旧失败文件保留；Preview08dec仅暂存未部署、实体手机/远端sudo/真人五维各独立。

2026-10-12 07:49 历史稳定点（最新见08:13）：T2 high-v5 `run-1791761681216-a295fdff-1f7` 已seq154 cancelled，真实PTY70880 exit0、summary同Run且cleanupDiagnostics[]。首事件前监督ready通过；20main请求全部真实high/enabled8192/nonstream，19known=236539tokens+1unknown；A06实际97main/1risk/98（seq98、rev2 reserve120/6/126，剩23main不足下一40），累计437actual=429main8risk、408known7803446tokens/29unknown，旧417保历史。模型自主保存/100CMDW/111handoff恢复空白后首次选择reopen_saved_document；120明确NOT_READY、未launch，因为指定dca26…txt不存在，实际无扩展名同basename文件196B/6LF/末1/SHA58a4准确保留；之后CMD+O未准入Open、focus拒绝，monitor在142/151同图后正常取消。完整T2仍不通过，不修改错误路径文件/不放宽grant/不手动拼接业务。

Sol独立两份新scratch有限Save诊断（各10真实动作/1Saveclick、0真实HTTP、非正式T2）复现：蓝勾自动.txt但省略后缀会落无扩展名；显式.txt则落正确.txt。33B诊断正文均精确SHA244236，SDK新鲜AXDocumentURL/clean/唯一域证明通过；不把checkbox画面当文件路径证明，也不归native输入吞字。依据[只读保存证据审查](./astra-authorized-save-evidence-review-2026-10-12.md)，下一最小实施仅Host singleton optin的独立Observation事实字段：精确授权文件明确ENOENT且父身份稳定才absent，当前exact native clean/app/URL+稳定filepin才verified，其余unverified；不合成AX元素/不输出正文路径/不改动作许可/不自动rename。Luna唯一产品作者、Sol检查，先定向测试和0HTTP再新有界批次paid。

F084只修Host relay测试误把opaque token值包含pID当字段泄露；递归键名检查保pid/windowId/socketPath隔离，作者2/2+Root独跑2/2/diffcheck0。首个最小两文件提交5abded5已原SHA API同步PR26，CI38185500145五job实际success；另server.test同因4处已作者8/8+Root独跑8/8，最小两文件后续提交f14cd66已原SHA同步，新head CI待独核。旧cf4随机token误报失败保留，不冒当前绿。A07已正常initializeBatch预占40/2/42、cap120/6/126、actual0/seq0/rev0，0700目录；Sol独核counterfc6f…与旧A06counter9c8e…未变，尚无Run/HTTP。native98330/6f56签名/TCC不变，Root唯一keeper4185至08:14:19；Preview08dec仍仅已暂存未部署、实体手机与真人五维各独立待补。T1 high循环与旧low事实错误分开，不同因盲跑；T3与T2三轮全出口仍待实际证据。

2026-10-12 07:36 历史运行中快照（最新见顶部/文末）：仅工具说明澄清F083最小2文件提交cf4e54b已原SHA同步，新CI待实际终态；此前a3fb五绿属已完成版本。完整T2 high-v5 Run `run-1791761681216-a295fdff-1f7` 正在运行，真实PTY70880/CLI6374/ttys021，唯一monitor6380/observer6381，ready2026-10-11T23:34:41.278Z早于created及首Provider42.048Z。原完整goal1133B SHA47bd98f3…/正文196B不变，仅新唯一dca26b32…txt路径；显式新变量为正常应用open-document handler的工具说明，非任务答案/权限放宽。fresh主18318/恢复18325正常新空白；Sol仅只读核FD/argv/轨迹/文件，不GUI。输入88字符已完成，首实际exchange均high/enabled8192/nonstream；尚不签保存/关闭重开/业务成功。本轮40请求上限、A06 rev2 reserve120/6/126，启动前actual77main1risk78/剩43main；实时累计须终态后按真实counter核，旧417终态总数保历史。native98330/6f56与TCC不变；Root keeper4185至08:14:19。

2026-10-12 07:28 历史T2 high-v4终态（最新见顶部）：完整1133B/goal07f347卡 Run `run-1791760881790-78afed3c-563` 已seq175 cancelled（真实PTY6058/CLI4845）；ready2026-10-11T23:21:21.846Z < created .851Z < firstProvider22.585Z，唯一monitor4851/observer4852启动前就绪，Sol/Root独核。22main请求/21已知响应268309input+6552output=274861tokens/1取消transport未知，全部22真实出站high/enabled8192/nonstream；A06 actual77main1risk78/seq78/reserve120/6/126 rev2余43main，累计417实际=409main8risk、389known7566907tokens/28unknown。指定6fa7829a…txt由Harness保存为196B/SHA58a4/6LF末1逐字准确；129CMDW完成后133list/137switch/140handoff/141fresh恢复空白均自主。模型实际收到reopen_saved_document，却在seq145明确因“应用正常打开”措辞选择CMD+O；149Open创建后未纳入现scope，list仍只有恢复blank，再次CMD+O及click被精确Guard拒绝，未重开目标正文。监控在matching163/172两次无进展后正常SIGINT，175cancelled，未人工绑Open/保存/关闭/重开或注入答案，完整T2未通过。summary绑定本Run/cleanupDiagnostics[]，PTYexit0；旧文件与Run均保留。F082真实Save返回正文已过且a3fb288当前CI38183706125五项实际success；不能把本轮Open能力缺口归F082。下一仅澄清正常应用open-document工具说明这一有证据新变量，不改原goal/不降Guard/不偷偷补正文末LF，不做同条件paid重试。新Open未准入仍独立缺口；既有singleton仅Host授权单文件。Root唯一keeper4185/session61950至08:14:19，native98330/6f56签名及TCC未变。

2026-10-12 07:20 历史修复稳定点（最新见顶部）：F082最小3文件提交 `a3fb288c77babca5068c9bec5cb0ad0e6f245537` 已通过正常API原SHA同步PR26；新CI38183706125尚in_progress，不继承583ad五绿。修复仅在已准入Mac AXSheet明确offscreen且完整局部AX-none时，一次80ms新库存/父几何/新AX证明重采后pop，保持身份、可见性、owner显式冲突、stack/session/abort拒绝；globalpartial原局部授权路径不变。作者全CUA333、修后focused11/tsc通过；Root corrected-fixture独跑11通过，纠正首fixture默认补owner遗漏。Sol独立typecheck/build成功，source8ce081…/dist0c83ced…；真实scratch `run-1791760483385-9ce97acf-d5d` 10真实动作/1Save点击/0HTTP，exact18226两轮hidden无owner/minimized，父18219 s95/s96局部AX-none/focus/几何全证，实际命中重采后seq99pop并fresh正文，诊断33B精确/无errors或cleanupError，Root独核。此仅Save→正文限定验真，非完整T2关窗重开。原580路径196B正式成果及失败Run保留；累计仍395实际/368known7292046tokens/27unknown，A06 actual55main1risk56/reserve120/6/126 rev2余65main。下一完整原196B/1133B high-v4仅路径改6fa7829a…txt，goalSHA07f347ba…；fresh正常File>New主18242/恢复18249空白证据通过、入口--check通过，桌面已明确交Luna正式执行，Sol只读监督。native98330/6f56及签名/TCC未改。Root唯一保活4185/session61950至08:14:19。T1/T2/T3及repeat/variant完整出口仍未验收，Preview暂存未部署/手机/远端sudo/真人五维独立。详见 [F082](../../a-line-sync/fixes/F-20261012-082-macos-hidden-attached-sheet-pop.md)。

2026-10-12 06:55 历史终态快照（最新见顶部）：T2 high完整1133B/c777卡 run-1791759145646-03171953-90f（真实PTY78701、CLI2490）已seq75 cancelled。首事件前监督ready 2026-10-11T22:52:25.704Z < created .709Z < firstProvider 26.462Z；monitor2496/observer2497实际就绪。8main/8已知响应89055input+2242output=91297tokens，全部出站high/enabled/8192/nonstream，正式基线仍experiment Guardoff，不冒默认layered通过。指定58048215…txt已存在且独读196B/SHA58a4fcd4…/6LF/末LF1逐字符合原正文；但Save HID click seq71 completed后seq73弹窗unknown，未完成返回正文确认/关闭/重开，完整T2仍未验收。同步原生日志当刻call124全库存保留18195 offscreen，call125 PID库存无18195，call126父18178完整AXChildren checked-none+精确parentfocus；源码candidate存在即拒绝，后续只读定位/窄修，不重放已完成Save。A06 actual55main/1risk/56，sequence56，reserve120/6/126 rev2、余65main；累计395实际=387main+8risk，368已知usage7292046tokens、27未知。HEAD583ad75与CI38179849164五绿不变，native98330/6f56…不重签。T1 high旧轮不完整、T1/T2/T3及repeat/variant均未整体验收；Preview已暂存未部署，手机/远端sudo/真人五维独立。Root唯一保活142/session93626至07:26:37。

评测器 A 已完成：PR27 当前 `3f22c30` / CI38164866905五绿，严格 independent findings 的真实旧T1产物 `runs/astra-autonomous-20261010-sol-luna/pr23-real-evidence/sol-t1-a05-strict-findings-assessment.json` 已由 Sol/Root独核（独立业务failed、overall inconclusive、successfalse、humanReviewRequiredtrue、五维null）。`astra-t1-finish-evidence-contract-proposal-2026-10-12.md` 的 A 为历史设计，B仍仅设计；不重复实施A，不将报告表达修复冒充事实错误已修。本轮T1 high未完整比较，不能计为旧M4/M6冲突的新复现。

2026-10-12 06:40 历史终态快照（最新见顶部）：正常Web按钮启动的T1 high原793B/f84e卡 run-1791757425578-ba44eb55-c17 已于2026-10-11T22:38:22.490Z/seq195正常cancelled；Sol在第三次Air配置区上下往返、仍无新标准SKU/其余两源时，从waiting_approval点经正常API一次abort。15main+1risk=16实际请求，15已知响应386442input+6175output=392617tokens，risk超时14993ms无usage仍未知。全部16真实出站high/enabled/8192/nonstream；11动作回执completed，无native refusal，但完整三产品比较未完成，不能标业务成功或事实纠错已通过。monitor99503首ready早于created/首Provider，observer99666晚seq37；两者均terminal正常退出，延续monitor仅准备未启动。当前583ad75 exact-head CI38179849164五项实际绿，native98330/6f56…TCC有效。A06 actual47main/1risk/48、sequence48；正常append-only续reserve120/6/126 rev2，cap不变、actual不改。累计387实际=379main+8risk，360已知usage7200749tokens、27未知。下一T2 high仅原完整1133B/196B末LF正文及新唯一输出路径，入口静态校验/正常fresh尚待；T1/T2/T3及repeat/variant完整出口均未验收。Preview08dec已暂存未部署，远端sudo、实体手机与真人五维独立。Root唯一保活142/session93626至07:26:37。

2026-10-12 06:18 历史准备快照（最新见顶部）：第八版完整原生诊断补丁已按隔离 archive+前六补丁→native8 闭环重放，17源SHA与候选一致；原先“旧六补丁缺修改”的判断已撤回，原因是重放目录继承父Git导致apply跳过却exit0。正式补丁650bb5…、源码/F081最小提交583ad75。作者native370通过/2忽略、fmt/check/release及实际driver release均exit0；Root独核release2d35…与签名6f56…的40个Mach-O section一致。候选PID98330、CDHash a47177…，AX/两项TCC pass，独立bundle整体degraded/capture健康skip保持如实。真实SDK非空overlay诊断首次揭示私有journal缺函数，修后4/4独检与新UUID7e5e逐字段journal闭环通过；旧空journal失败保留，不能当旧T3拒绝根因已修。旧Host95099已正常退出；新T1 high Host99001/PTY43033已监听，尚无Run/新Provider。正常Chrome owned窗口已实际打开Web连接页并生成配对请求；为保真实Web按钮和首事件监督，正在接通原正常issueSession的私有只读凭据观察，不额外签发/轮换会话。T1沿原793B/f84e卡，仅high推理变量；40请求/90s，其余合同不变。A06仍32main/0risk/32、reserve80/4/84 rev1、cap120/6/126；累计371实际、345已知usage共6,808,132 tokens、26未知。完整T1/T2/T3均尚未验收；原b14五CI绿属于先前源码头，新583ad75 CI待实际核。Root唯一保活95737至06:37:48。

2026-10-12 05:38 历史T3终态快照：完整卡 `T3-baseline.json`（goal 1,091B，SHA `bf91c23c653d483c56b94ee9e7b3f78ad96fe7875ea613e42b498f1c9a793bfc`）的 Run `run-1791754389657-c38e7a64-b3a` 已在seq52终态cancelled。4次model.request.started中3次收到响应，已知usage 54,869 tokens；第4次取消且无usage。轨迹seq17/29/44三次pixel click均收到精确前台未聚焦/无遮挡证明失败、明确未派发pointer或mouse事件。monitor通过正常认证Host API收到HTTP202 accepted（expectedSequence 33）；这不是业务完成。native只读日志 `A06-private/host-output/native-readonly-cua-calls-39d20b01-3091-4ed3-9a25-b08c505f313a.jsonl` 共26次调用，记录Chrome PID95348/CGID17934；当时采样前台/焦点均为该窗口，但不能据此判断内部点击守卫的具体失败项。之后PID95348已不在进程表，Host PID95099仍监听4317。没有完成三车次来源查询、8800预算纠正或保存；唯一输出文件不存在，完整T3未通过。A06正式counter现为32main/0risk/32，sequence32；reserve80/4/84 rev1，cap120/6/126。累计371实际（364main+7risk），345个已知usage响应共6,808,132 tokens、26个usage未知。真实入口为authenticated Host API/Runtime，Web按钮未验证；详见运行目录的 `sol-terminal-independent-review.json`、monitor receipt及native journal。


2026-10-12 05:08 当前增量：完整卡 `T2-baseline-recovery-v2.json`（卡SHA `12679a13dcb6369000de73ceb7387da1601d37fdb80e396b6ba128bb2af05006`；goal 1,133B、SHA `7f9d391e16604b912b37afc8f93ec0e20c3d64d6a01dfa3522a8b43c8b0b5d4a`）已用真实TTY运行一次：`run-1791752596454-88e8d61c-a3f`，CLI 94044、session 36008；starter-ready 2026-10-11T21:03:16.511Z，首request-started 2026-10-11T21:03:17.338Z，监控94050/只读观察94051均在controller启动前就绪。Run于seq67 cancelled，8 request-started中7个有response、已知usage 80,645 tokens（input 78,995/output 1,650）；第8个启动后取消且没有usage，计1条未知。A06 counter从20/0升至28/0，reservation仍80/4/84 rev1，cap120/6/126；累计367实际=360 main+7 risk、342条已知usage 6,753,263 tokens、25条未知。AX在seq38观察到正文格式metadata为196B/88码点/LF6/末尾LF1；seq36 SHIFT+CMD+S新建副本后只读观察焦点转至17911，之后指向原17896的CMD+S因目标未聚焦被拒。monitor根据相同截图seq55/64于约60.4s后SIGINT；没有完成指定路径保存、关闭与重开，指定输出`T2-baseline-a40bae2f-8ce6-45b3-927b-78fbb9d292ad.txt`不存在，完整T2未通过。summary cleanupDiagnostics为空、无已记录副作用；report/summary与monitor/native-call/observer原始证据已逐字节保存在Run或其归档receipt，不手工修改现场。详见`runs/live-cli/run-1791752596454-88e8d61c-a3f/sol-run-archive.json`。


2026-10-12 04:27 历史快照（最新见顶部）：第七native及显式单文件重开链已签收限定范围。Sol独立16目标回归/相关tsc通过；真实生产SDK+Runtime本地fixture `run-1791750280897-8dd2f22d-bb7` 在13次layered Guard allow下完成33B短诊断保存→一次CMD+W→control-only list/switch空白17703→一次正常reopen新CGID17837→fresh图→普通ESC→再次观察→succeeded，errors/cleanup为空、0真实HTTP。文件精确字节及AXformat33B/12码点/LF2/尾LF1保持；真实odoc仅ctime变化，after-open四pin与1.5s/8次有界只读settlement通过，派发前五pin保持。此前77d77及79ed未知样本原样保留，不重发许可；六摘要下方04:13/旧阶段均按历史阅读。详见[F080](../../a-line-sync/fixes/F-20261012-080-singleton-saved-document-reopen.md)。完整T2/T1/T3三轮出口仍未验收，下一步冻结与全卡正式T2；累计351/A06 actual12/0/12不变，正式40请求前append-only续额，native签名/权限不需重做。


2026-10-12 历史稳定点（最新见顶部）：恢复窄链最小提交 `756a285`（11产品文件及F078），共享测试修正后当前head `b84beee` 已原SHA非force同步PR26，CI38164594302实际五项全绿；`3594bad`五绿为前一组合。Sol独检相关363测试、最终全仓typecheck及选定文件diffcheck均通过；前轮Runtime164通过与本轮Computer306/CLI15/factory42分列。真实生产CuaDriverComputer/Runtime本地fixture `run-1791742995441-f9d7fa57-d83` 完成一次关闭→control-only list→switch预授权空白17703→fresh capture，四本地决策、0真实HTTP，旧截图/grounding未入两恢复请求；仅证明恢复生命周期，非生产Guard或完整业务通过。详见[F078](../../a-line-sync/fixes/F-20261012-078-bound-window-recovery.md)及[独立生命周期审查](../../astra-bound-window-recovery-review-2026-10-12.md)。

后续独立诊断明确原两窗scope仍不能覆盖正常打开：生产CMD+O生成非modal Open17724（AXParent为Application，非root direct child），下一输入按精确身份拒绝；辅助正常UI独立选择短诊断文件才生成新正文17742，原空白17703仍在。该辅助步骤不计Harness业务成功，诊断正文已正常关闭，旧195B正式成果保留。现已进入显式Host单文件重开实现：复用公开launch_app，初始空白以独立application identity固定bundle/executable/PID-start，保存后仅精确AXDocument、typed Edited=false及已完成关闭后真实缺窗链产生一次许可；新文稿仍须fresh唯一文档关系与capture。第七native证明已由作者完整测试、Root静审、Sol真实SDK验真并获Root独核；主repo单文件Run入口及固定负例正集中收尾，尚未签收完整业务。不把samePID/title/new window当关系证明、不付费撞已知屏障。T1确凿业务错误、T2末LF缺失/尚未重开、T3及三轮完整出口仍未验收。

当前第七候选PID83118/PTY63828，signed SHA544937…79b6b7/CDHash010956…a52401，两项TCC与AX pass；独立bundle身份预期degraded、health只读capture skip均如实保留。旧六版完整App回退副本保留，stock4254不动，无新增Provider。真实生产SDK新文档17768唯一full proof及1312×844截图、47B/17码点/LF2/尾LF1已独核，诊断文档已正常关闭；该诊断不是单文件许可Run或T2业务通过。详见[F079](../../a-line-sync/fixes/F-20261012-079-saved-document-identity.md)。累计351实际=344main+7risk，327已知usage6585909tokens、24未知；A06 actual12/0/12，正式reserve40/2/42，下一40请求前须append-only续额。所有正式Run终态，无在途Provider。Root唯一自有保活84924/session34721至04:58:07，保活不代表前台或解锁证据。PR27严格failed findings已签收，5处随机token值正则误报已由Luna最小修复；Sol独立integration60/evaluator72通过，PR27当前head `3f22c30` 已原SHA非force同步、CI38164866905实际五项全绿；Preview08dec5e已暂存未部署，远端sudo认证与手机/真人条件仍独立。

2026-10-12 历史稳定点（最新见顶部）：第六格式元数据最小源码提交 `3594bad`，原SHA远端同步PR26，当前head CI38158346567实际五项全绿；旧65a CI成功仅为历史组合。候选PID62961/PTY54227，SHA `ca0afcdf6626533b8fcd950eb894f41b1cf44c52c702a7f207425d23a6b43392`、CDHash969fd62b…2e67e9，两项TCC及AX pass，独立bundle身份预期degraded。Sol从d114独立重放六补丁，10源文件全match；作者native359通过/2 ignored/check/build/fmt成功、Sol独立TS390通过/typecheck成功。真实生产SDK空字符串format全0；短中文emoji CFString为37UTF8B/14码点/LF3/尾LF2/CR0，native与Grounding投影精确一致，AX全文读回true，诊断自有文稿正常丢弃；仅证明AX格式，不证明磁盘字节。详见[F077](../../a-line-sync/fixes/F-20261012-077-macos-ax-text-format.md)。

PR27 `9af208e` 严格独立findings已实现并独检172通过，真实T1/A06均validated failed、真人五维null；attempt1旧Runtime短等待失败，attempt2随机token包含“pId”被JSON值全文正则误报，属于共享测试键名检查缺陷，下一最小修，不盲重跑。当前继续显式两个精确scope/最多2请求/control-only选窗恢复；实现与真实验证尚待完成，暂无新paid。累计351实际/A06 actual12不变，所有正式Run终态。


2026-10-12 历史稳定点（最新见顶部）：源码 `65a674c` 已原SHA同步PR26，当前head CI38154699416实际success。第五native候选PID55846/SHA35a015e1…37aee011、CDHashe66042bb…6dffdd及录屏/辅助功能授权保持；独立native356通过/2 ignored、五补丁clean重放及正常窗口Cancel正例/错误焦点零派发负例已签收，stock4254与旧6664完整App可回退。

完整原卡T2 `run-1791735376974-18f3898f-d44` 使用1133B goal、fresh17640、真实TTY和40请求上限，已由Harness完成正文输入、Save→GoTo→Save、保存及CMD+W关闭。实际文件195B，SHA914a2131d82950ad515e30d8d65b9c8155bffd0c3ad218a75e99da52a69b22f2，恰为指定196B正文缺最后LF；首次model.response已只给87字符，不能归因native吞LF。seq118关闭后bound_window_missing暂停，尚未重开，正常取消至seq120 cancelled，cleanupDiagnostics为空。旧成果保留不覆盖；完整T2仍未通过。监控与只读observer实际于启动26秒后挂载，不能冒称seq0监督。

A06 actual12main/0risk、12条已知usage294247tokens，cap120/6/126、首reserve40/2/42；累计351实际=344main+7risk、327已知usage6585909tokens、24未知，金额未知。A05冻结92/1/93。所有正式Run终态，无在途Provider。下一步先完成PR27可选严格独立findings，显式保留T1确凿业务失败及真人五维null；再补原生文本格式元数据与仅显式自有空白scope的control-only恢复选窗。不得给type偷加LF、自动选未知旧稿、以人工绑窗拼完整成功；新完整T2须新唯一路径/新冻结卡，原正文不变，正式续预占后再运行。T1/T2/T3三轮完整出口均未验收。

Preview08dec5e闭包已正常用户0700暂存、逐SHA/default inspect及packaged Relay smoke通过，未部署，远端正常sudo认证独立待补；手机音频/真人试用评分独立待补。Root唯一保活61391/session80175至01:38左右，不改锁屏策略。

PR27独立findings增量已最小提交`9af208e`：Sol最终172/172独检，真实T1 source_conflict与A06 cancelled/incomplete_task两条均按Run/manifest/family/variant/trajectorySHA/terminal及实际PNG/动作绑定为validated failed；runtime outcome保持，五真人维度null、overall inconclusive并显式independent_business_conflict，不能读成仅差真人。元数据根因已进一步明确：native value_state在structured输出前trim末LF，不能从现有item.value计算末LF；第六补丁将仅从trim前CFString计算有界格式计数，不改type。详见[文本格式独审](./astra-text-format-evidence-review-2026-10-12.md)。

2026-10-12 历史阶段快照（最新见顶部）：第五native补丁 `a47655cc…94cb1` 已由Sol从显式d114基底顺序重放五补丁，9源文件与构建源逐字节一致；最终源码独立全native测试356通过/2 ignored（作者355为较早时点），fmt/check/build通过。候选SHA `35a015e1…37aee011`、CDHash `e66042bb…6dffdd` 已严格验签并正常切到PID55846/PTY83613，socket仍为A05独立socket；旧6664完整App备份可回退，stock4254未动。真实health录屏/辅助功能/AX能力均pass，overall仅独立bundle身份预期degraded，不冒全pass。

Sol互斥零Provider验真：新空白17616→Save17622，正常window foreground单左键Cancel中心480374一次后sheet消失、root checked-none；回执仍unverifiable，实际效果由新鲜窗口结果证明。另一自有空白17629前台时点17616，原生派发前拒绝且明确无pointer/mouse event，cursor前后700597、焦点17629及四修饰键释放不变。Root独立只读复核同结论；两自有诊断空白已正常关闭，旧正式稿不动。此仅修复签收，不是完整T2保存/关窗/重开通过；GUI已交Luna准备新有界A06原1133B/196B完整卡。A05 actual92/1/93及全历史339请求/315已知usage6291662tokens/24未知均未变，A06已通过initializeBatch创建，cap120/6/126、首reserve40/2/42、actual0/sequence0；所有正式Run终态、0新Provider。第五patch+F076最小提交`9bb3143`，当前head CI尚待实际结果，旧5fa五绿仅历史。既有完整T1业务失败（Mini M4/8核与实见M6/12核冲突及三SKU未绑定）、T2/T3未验收独立保留。Preview08dec5e仅已暂存未部署，正常sudo交互认证仍缺；手机与真人项分栏。Root唯一保活55022至00:46左右，不改变锁屏策略。

2026-10-11 历史阶段快照（最新见顶部）：`5fa93a5`当前五项CI全绿；完整T1 `run-1791731184145-e28eb930-653` runtime succeeded，但独立业务验收失败。最终Mini写M4/8核CPU/8核GPU，与本轮seq49截图M6/12核CPU/12核GPU及seq284刚读回的M6记忆冲突；三产品RAM/SSD仅灰色可选范围，不足证明最低价标准SKU已绑定。三官方页面、6999/9999/12499起价、来源与9000预算算术有证据，不升格完整任务通过。末请求选取包含seq284，不能归因简单记忆预算淘汰；不再同版付费复验/变体。PR27/cb6aacf现成评测器零Provider消费为inconclusive/success=false、human_review_missing，五维null；该结果与确凿业务错误并列。

本T1实际24main+1risk=25请求，25已知usage合计668230tokens。A05实际92main/1risk/93，cap/正式预占120/6/126 rev2；全历史339实际=332main+7risk，315已知usage共6291662tokens、24未知。所有正式Run已终态，无在途Provider；正常session已关闭managed Chrome51243，Host51224已收一次正常SIGTERM，TCP先关闭、Unix FDs短暂延迟后进程也退出，未发送第二signal。53589监控已退，51488只读观察按限时结束；Root于23:46正常续唯一自有保活55022/session39223至00:46左右，仅结束已核身份的旧50729，不改变锁屏策略。

Sol互斥零Provider新scratch17584对照：独立Save17590的Cancel中心480374由production window pixel路径单次posted后未关闭、前后PNG相同；正常ESC仅清该诊断sheet。另一独立Save17598经新桌面3024×1964/1512×982@2及精确关系/focus核验，真实桌面14001194单次global HID后sheet消失、root checked-none。核心泛化route字段不能单独证明派发方式；原始回执与源码path区分。此证据支持最小窗口foreground无modifier左键HID修复，Luna离线实施、Sol检查；现40307/6664a3ff候选尚未含该修复，后台/AX/生产Guard不变。旧正式正文/Save及unknown稿均保留，不用诊断冒保存成果。完整T1/T2/T3及三轮仍未验收；Preview08dec5e仅已暂存未部署，远端正常sudo认证与实体手机/真人试用评分分别留栏。

2026-10-11 历史阶段快照（最新见顶部）：源码 `5fa93a5` 已原SHA非force同步PR26，F075仅对嵌套sheet几何动画不一致作一次80ms只读重采；Sol独立337/337通过，实机8c6e5819确实命中inventory y261/AX proof y288，重采两侧y288后root→Save→GoTo自动push及双pop完成（0Provider、0type，非0input）。原生候选40307/SHA6664a3ff…与TCC不变。新5fa93a5当前head五项CI已实际全绿；前一dc4b64e五绿另列历史。

最新完整T2 `run-1791730632910-7a12d2e8-378` 使用新空白17443、原完整1133B/196B卡、真实TTY及40请求上限；完整正文、Save→GoTo导航、路径与文件名输入均取得completed回执，返回Save后连续正确按钮坐标click只有posted未验证且画面不变，指定输出仍不存在。唯一monitor实际晚至15:00:23Z才挂（不能冒称启动时已监督），随后同图阈值自动SIGINT，seq174 cancelled；未保存/关闭/重开，不算完整T2通过。旧17109未知副作用正文、17360及本轮17443未保存稿保留，不重放旧动作。下一步转独立完整T1原三产品卡，Save click再作零Provider精确归因，不同因付费盲重跑。

本Run18实际请求、17已知usage合计429214tokens，第18取消失败无usage保未知；A05 actual68/0/68，正式append-only预占与cap120/6/126 rev2，余52main。全历史314实际请求=308main+6risk，290已知usage共5623432tokens、24未知。T2 monitor50987/session34018及只读observer50989/session27671已退出，summary.cleanupDiagnostics为空。随后正常A05 Host51224/PTY10136、新配对创建完整T1 run-1791731184145-e28eb930-653，793B原goal SHA f84e0557…已独核；API abort监控初始51335/session20912在23:24:06精确正常退休，因有效三产品进展换为53589/session38404、1800s有界，旧收据和续监记录保留；Host只读observer51488/session42184按900s限时于23:22:46退出。监控实际启动后首次独核时seq22，当前T1活跃，不能再称所有Run终态。314为该T1启动前累计，活跃调用待终态对账。Root唯一保活50729/session43551至23:59左右，未改变锁屏策略。

Preview仍为已验08dec5e独立Web/Relay闭包：正常用户0700暂存、逐SHA、remote default inspect及packaged Relay smoke均通过，未部署，生产155349/current/health保持。正常远端sudo认证/策略核与实体手机、真人试用评分分别留栏，不因本机任务等待部署。

2026-10-11 历史稳定点（最新见顶部）：源码 `dc4b64e` 已原SHA非force同步PR26，当前head五项CI全绿；Mac type/ref合同修复作者与Sol独立11/11通过。原生候选40307/SHA6664a3ff…及TCC不变。最新完整T2 `run-1791726173541-4317c68e-58f` 实际原1133B/196B卡、17360新空白、真实TTY、40请求限额执行：首个显式ref被映射前明确拒绝后，模型省略ref并完整输入88字符，Save自动push成功；CMDShiftG完成后嵌套关系无法确认而暂停，正常取消至seq58 cancelled，未保存/关闭/重开，完整任务仍未通过。

本Run6请求、6已知usage合计106674tokens；A05 actual50/0/50、sequence50，正式append-only预占120/6/126 rev2与cap相同，余main70。全历史296实际请求=290main+6risk，273已知usage共5194218tokens、23未知。monitor47942/session70303与只读observer47943/session71763已正常退出；当前所有正式Run终态，无在途paid。observer在嵌套暂停后初段证明前台TextEdit22394/AXFocusedCGID17378，数分钟后前台其他应用不能倒推暂停原因；晚读raw无proof也不能单独证明原生缺陷。进行至多一次带实际原始调用记录的零Provider嵌套定向复现；无充分原因不盲改/同版重复T2，T1完整三产品卡可独立继续。

Preview仍为已验08dec5e独立Web/Relay闭包：正常用户0700暂存、逐SHA、remote default inspect及packaged Relay smoke均通过，未部署，生产155349/current/health保持。正常远端sudo认证/策略核与实体手机、真人试用评分分别留栏，不因本机任务等待部署。Root唯一保活47481/session80700至22:37，未改变锁屏策略。

2026-10-11 历史稳定点（最新事实见顶部）：08dec5e源码、CI38141124345 attempt2成功、候选40307/6664a3ff…及TCC保持；新完整T2 run-1791725133526-8670a646-c6d以1133B正确原卡、真实TTY及新空白17266执行，11请求/211677已知tokens。seq31/49为模型主动elementRef被拒；native精确焦点无文本派发拒绝为seq68/107，修后唯一monitor46785/session92658在107后0.207秒SIGINT，seq110 cancelled，无在途type及新副作用推定。17266之后AX只读为空；完整保存/关闭/重开仍未成。累计284main/6risk=290实际请求，267已知usage合计5087544tokens、23未知；A05 actual44/0/44，正式预占80/4/84 rev1余main36，下次40请求前必须按正常接口续预占，cap不变。

零Provider精确因果对照32bd6720：唯一normal bring_to_front后WS front_process_matches与workspace_frontmost_pid均证TextEdit22394/17266，逐步click→CMDShiftT→click→短中文诊断type后各次Swift frontmost/AX CGID一致，16字符精确AX读回且modifiers全释放；未复现旧Run失焦。事后Chrome前台不能倒推旧Run原因，不改原生Guard或把该诊断算业务成果；诊断稿未保存且旧17109完整196B稿保持。下一步仅最小Mac type/ref合同修及真实fresh前台门槛，不同版盲跑。新Preview08dec5e正常用户暂存/default inspect及本地packaged Relay smoke完成、未部署；正常远端sudo认证/实体手机/真人分别留栏。


2026-10-11 上一稳定点（最新事实见顶部）：源码08dec5e已原SHA非force同步PR26，F1可信浏览器四维几何/F2有界预览归一化与共享限额/F3无文字终态与错误详情/F4未知结果中性语音已选择性修复；Sol独立11个不同文件229项通过，Root正常生产Web headless五终态/390×844检查通过（fixture，不是实体手机）。当前CI38141124345首轮失败：Ubuntu22/24及macOS22通过，Windows离线测试两个短轮询窗口和一项TUI超时失败，ci-required随失败；已正常rerun failed jobs一次，attempt2 completed/success。旧2e6d898/fa19cbb五绿均为历史，旧fa19cbb包不得apply。

最新完整T2 Run run-1791723552415-4e080fc5-4fb的run.created.goal与1133B完整原卡逐字节一致，正文196B、真实TTY、target22394/17109、40请求上限。实际16请求/352654已知tokens，终态outcome_unknown：前两次type由native精确焦点守卫明确拒绝且未派发；Sol直接SIGINT时第三次type已开始，Rust future aborted后无法认定零副作用。只读AX随后确认17109正文与完整196B原卡（含末尾LF）精确匹配；文稿保留，不重放、不清空。指定文件仍不存在，保存/关闭/重开未完成，完整T1/T2/T3及各三轮均未通过。事后frontmost43919为哔哩哔哩、TextEdit应用局部AX焦点仍为17109；这是事后证据，不能倒推拒绝时根因或归责外部抢焦点。生产Guard不变。

原私有monitor仅计三类driverCode且completed click/PNG变化清拒绝，漏记本次精确CUA_TOOL_REFUSED no-text拒绝；自动monitor未取消，实际由Sol控制取消。Luna最小修独立语义拒绝streak已由Sol与Root独审，实际失败轨迹首次阈值seq123，合规生命周期合成投影/失败切换/generation/partial反例回放通过；冻结私有monitor cf31b455…，已授权新blank原完整卡一次复测。monitor session54416已记录，但自身PID未及时持久化是检查缺口；后续启动即记录PID/starttime/精确CLI归属。当前所有Run终态，无在途paid；累计273main/6risk=279实际请求、256已知usage合计4875867tokens、23未知、金额未知。A05 actual33/0/33、cap120/6/126、正式预占80/4/84 rev1不变。候选40307/6664a3ff…与stock4254均保留，TCC已通过无需再认证；Root自有保活43916。Preview新08dec5e本地闭包38files/5links与五SHA独检通过，正常账号0700新staging三件0600/逐SHA/远端默认inspect通过；Root隔离packaged Relay实际health200/匿名API401/四Web资产逐SHA200并关闭server（fixture，0Provider）。生产155349/current旧release/health200前后未变，已暂存未部署；远端sudo正常认证独立未完成；实体手机与真人项另列。


2026-10-11 最新远端审查覆盖发布结论：[详细内容与进度审查](../../astra-remote-detailed-review-2026-10-11.md)。PR26/fa19cbb 五项 CI 成功，但遗漏可信浏览器几何、预览大小/归一化合同、无 reply 终态反馈及恢复中语音状态修复。现有暂存包仅字节验证通过，不能直接发布；先选择性修复、独检、重新打包冻结，再进行正常发布。下方“仅待认证按冻结事务安装”须以本条新增产品前置为准。完整三线验收出口不变。

更新：2026-10-10，Asia/Shanghai。执行主入口：本文件。完整目标见 [Astra 三线总计划](./astra-three-track-master-plan-2026-10-10.md)。状态：本项目仅负责 macOS 电脑端、Web/Relay 与手机客户端。2026-10-10 用户决定将原三线计划中的 Windows/Linux 平台目标移出当前范围；既有源码与 CI 保留，但不承担其实现、修复、原生实测、环境寻找或交付。

## 1. 新授权与执行责任

用户明确决定弃用原三个协作聊天，要求当前聊天自己测试、定位和修复。本次用户将项目范围限定为 macOS 电脑端、Web/Relay 与手机客户端，Windows/Linux 平台目标已移出当前范围；用户暂不能协助连接/操作手机，只留下确实需要实体手机的部分。用户同时授权完成这些工作的必要权限。

据此，当前聊天统一负责 macOS 电脑端、Web/Host/Relay/CUA、手机客户端链路，以及这些范围内的版本、源码、离线验证、真实模型请求、桌面实测、问题修复、独立审查、提交/推送和阶段交付，不再等待旧聊天 ACK、逐次放行或让用户代做本机可执行步骤。可以使用子代理并行读码、隔离实现和复审，桌面/运行时变更由主代理串行执行。旧聊天保留作证据，不派工、不以其空闲代表现场释放。

此前“只审查”“必须由（10）操作”“每步等待（6）许可”等流程限制由本次直接用户授权覆盖。历史一次性记录、marker、身份和调用计数保留，不能伪造其未消费；需要新运行时创建新自主批次记录，旧 TTL 不再是新工作的审批门。保留生产 Guard、精确目标、未知副作用不重放及现有文件保护。

本计划主动推进，不以等手机作为通用阻塞。系统实际权限、登录/验证码或硬件缺失若确实无法自动处理，记录具体原因并继续独立项目；授权不等于这些物理条件已具备。用户只需在未来可用时集中完成实体手机清单。

## 2. 真实测试层次

| 层次 | 自主入口和用途 | 能签收的范围 |
| --- | --- | --- |
| L1 离线 | 仓库单元/集成测试、无真实网络的注入客户端、协议/错误反例 | 代码与合同；不能计真实 GUI/HTTP 成果 |
| L2 本机生产 Runtime | 正式 CLI/TUI 或 ApplicationSession/SDK→真实 Provider→正式 CUA→真实应用 | 本机任务、模型交换、输入/保存/切窗/成果；不代 Web/手机入口 |
| L3 正常 Web/Relay | 本机浏览器开正常配对客户端，走合法令牌/Host批准/会话/CSRF→同一产品 API→Runtime | Web/Relay/Host 全链路、客户端控制与刷新/断线恢复；仍不是实体手机 |
| L4 实体手机 | 以后集中由用户触摸真实手机 | 相机扫码、移动浏览器、后台/锁屏、真实手机网络及触摸体验 |

优先 L3，可用同机第二浏览器/隔离会话作客户端，经正式配对流程，不偷用手机 cookie、不伪造认证、不开放匿名执行。若 L3 被实际缺口阻塞，先 L2 推进任务、修 L3，再补 L3 重跑；L2 与 L3 的通过分别记，最终同一产品配置。

辅助电脑工具可启动专用应用、准备空白文稿、操作正常 Web 控制页和只读核成果；受测任务的正文输入、保存、切窗及重开必须由 Harness 自己执行。测试驱动不能直接写目标正文或点击保存后把它计入 Harness 成功。故障注入只用于明确标记的测试，不改变生产风险默认值。

## 3. S0 接管、版本与批次记录

1. 以实际 Git 根目录为准，保留 dirty/未跟踪文件，保存源码清单、内容摘要、依赖/driver/build 标识和可恢复基线；不复制一份伪工作区，不 reset/clean 丢历史。
2. 核实际 Run、Host、Relay、CUA、专用端口和窗口；仅取消/停止已确认归属且无待核副作用的测试实例，确认退出后再切版。身份未知先只读取证，其他离线工作继续。
3. 新批次使用自有命名空间/输出目录和持久账本，记录 `source/build/process/client`。私密原始轨迹、截图、凭据保持本地忽略；文档只留脱敏索引。
4. 原恢复周期已记录 main18/risk0，T059 事故历史用量未知单列；新授权下的新批次从实际新请求另记，不宣称历史归零或旧余额已核清。
5. 优先复用正常 Host/CLI，不继续为每个字段新增一套 launcher、逐次审批卡和 SDK-only 探针。确有缺口时写最小可维护的自主测试入口，并覆盖其计数与错误边界。

输出：可操作的环境清单、无在途输入的接管结论、新批次账本和首个任务入口。已有同版有效证据复用，不为凑数量重复准备。

## 4. S1 离线基线与必要修复

先静态检查测试入口不会误入真实 fetch，再运行当前组合的基线：`pnpm run typecheck`、`pnpm test`、`pnpm --filter @computer-harness/web build`。有网络/原生副作用的独立 diagnostic 不因后缀为 test 就批量运行；明确隔离/注入后才执行。

按失败只修必要范围，重点为双预算与结束判定、HTTP期限和计数、SDK默认加载、Mac精确窗口与sheet、候选/预览token、取消/纠正以及 Web 错误显示。历史提到的轮询清 error 问题先复现，不能直接当 QR 首因。

修复流程：保留失败→最小复现→改代码→定向验证→同版本实际任务复测。涉及公共合同/Runtime/Host 再做组合回归；相同通过套件不反复累加。独立审查在版本稳定或风险边界变化时进行，普通准备字段不逐项开审批流程。

输出：可构建候选、问题/修复对应清单、未解决项；离线失败不妨碍互不依赖的只读研究。

## 5. S2 正常本机 Web 与生产任务入口

- 核 localhost Origin、正常 Host 管理页、Relay 依赖闭包与版本；同机客户端走正常 pairing URL 和批准，不要求相机扫码。
- 具体流程：管理浏览器打开 Host `/connect` 生成挑战，隔离客户端浏览器打开正常 `/pair?token=…`，管理页批准后由客户端正常取得会话。契约在 `apps/host/src/server.ts`，页面在 `ConnectPhoneScreen.tsx`/`PairingScreen.tsx`；令牌只在本地流程使用，不进入公开文档。
- 核认证、CSRF、命令 ID 去重、Run 创建、事件流、截图、候选预览与终态。受控过期/错误 token 走反例，不复用历史用户会话。
- 用已准备空白目标先进入正式 Runtime；已有 SDK/发现证据可复用，只在真实入口失败时做一次有界定位。
- L3 如需修复则修产品合同与可诊断错误，不加隐藏测试成功出口。必要服务重建/重启/部署在新授权内自主完成，先备份可回退的匹配版本。

输出：一份客户端→Host→Runtime→Computer 的当前版本证据。正常 CLI 是并行可用路径，但不能替 L3 签收。

## 6. S3 Mac 完整 T2，优先取得真实成果

1. 将总计划的完整六行、唯一新路径、UTF-8/LF/末尾LF、停止点写入可机器核对的任务卡。先核实际 run.created.goal 与卡一致，禁止只输入标题。
2. Harness 自己新建/输入、转纯文本、调用保存界面、指定路径并返回正文。只读核字节、实际格式、文件路径和 Run 完成结果。
3. 解决关闭绑定窗口后的重新发现/显式绑定或切窗问题，Harness 自己关闭并重开刚保存文件。两个 Run 默认分列保存与重开补证，不冒称单Run成功；只有最初完整任务由 Harness 自主衔接、无人工代切窗/重绑/补发任务，才可评估为完整任务通过，否则保留完整 T2 缺口。原计划不额外增加单Run硬门槛；需要修产品重开/衔接能力时按实际缺口修公共能力。
4. 同一冻结版本完成基线、独立新空白复验、变体三轮；保留文件、hash、格式/行尾、保存/重开动作及截图。

初始准备以外无手工代做关键步骤才计自主通过。模型回执与磁盘不符按失败处理；未知输入/保存结果先只读核对，不能盲重放。同一失败无新证据不反复跑整题。

输出：三组可重开文件与关联证据，本机 L2/L3 入口分别签收；实体手机发起这一栏保持待补。

## 7. S4 查询、跨应用、控制及预览反例

- T1：真实公开页面，冻结查询字段/条件/来源，在当前版本跑基线、独立复验与变体；查询结果逐项核页面，不凭旧记忆。
- T3：正常受管浏览器查询携程→TextEdit，主代理在正常 Web 客户端于预定节点降低预算，验证旧要求失效、真实跨窗、保存重开与来源保留。客户端纠正可自主完成，手机触摸单列待验。
- 网站若不可达，先调查可复现原因；受控站点完成通用跨应用/纠正后继续其他项目，携程本身保持外部阻塞，不伪造来源或将替代网页记作携程成功。
- 控制矩阵：批准一次/重复批准、拒绝、审批中取消、过期请求、纠正失效、暂停恢复、刷新、测试客户端断线重连、重复命令/乱序事件。不重置整机网络，用客户端连接或测试代理制造断线；真实手机 Wi-Fi/蜂窝切换待补。
- 候选与预览：同名双窗、过期引用/token、撤销、竞态、目标关闭/身份变化，检查明确拒绝和零错误输入。合成反例与真实双窗结果分栏。

控制测试使用自有资料和无外发动作；需要审批的机制用显式测试策略验证后还原，再补生产 Guard 正常/危险/模糊分类。对真实收件人发送、付款、删除个人资料不是本计划的验收手段。

普通 CLI `--interactive` 不覆盖完整暂停恢复及窗口确认控制，因此矩阵优先正常 Web，其次公开 SDK controller；TUI 需要 PTY。`apps/host/src/relay-roundtrip.test.ts` 虽用真实 HTTP/WSS，但 Provider/Computer 为 fixture，只计 L1 合同证据。`scripts/test.mjs` 未囊括所有独立脚本测试，按修改范围补必要自测，不盲跑整个 diagnostics 目录。

输出：T1/T3 各三轮、控制矩阵和预览问题关闭情况，所有介入可追溯。

## 8. S5 评测器与必要优化

- PR23 保持隔离：false success、pending、variant、可信证据和批量汇总边界整改/复核；用本轮 macOS 真实成果验证业务证据生产/集成，再报告覆盖边界。
- 当前任务稳定后才评估 macOS CUA 升级/性能，比较同任务分段耗时和失败率；无证收益不扩大升级。只优化已实测瓶颈，不为版本号投入无限探针。
- 既有 Windows/Linux 源码及跨平台 CI 结果作为兼容性历史保留；不因此开展平台实现、修复、原生实测、环境寻找或交付。

输出：评测器可信结果及有证据的 macOS 必要优化结论。

## 9. S6 收口、远端交付与手机预留包

冻结最终源码/依赖/build/client组合，独立审查；修复新增问题后跑必要定向及组合检查。核远端 PR/CI，整理产品 diff，提交/推送或创建/更新草稿 PR；创建 PR 后附到当前聊天。部署按产品需要执行并核健康/版本/回退，不重复已有效的公网发布。

提交不混入凭据、私人截图、无关历史实验或未核文件；本地阶段、远端 CI、本机生产验收、实体手机验收分别表达。最终未验收出口按 macOS 电脑端、Web/Relay 与手机客户端范围如实表达。

给用户一个集中手机补验包：冻结版本、正常启动/配对方式、完整可复制任务、预期结果、极少步骤、失败时只需提供的提示。手机重新配对和实际显示如有变化才补测，不要求用户重复已经核实的电脑步骤。

## 10. 必须保留给实体手机的项目

| 编号 | 用户未来需要做的动作 | 我提前完成的准备 |
| --- | --- | --- |
| M1 | 用真实手机相机扫码/打开链接，确认移动端连接；电脑批准可由我处理 | 正常配对页、可达地址、版本与失效提示、可复制备用链接 |
| M2 | 手机提交完整任务，查看截图/进度/成果并实际触摸批准、拒绝、暂停恢复、取消和纠正 | 已验离线控制合同与正常配对UI；候选两项权限及真实控制协议已证，仍需Mac完整成果，再用最短手机序列复验 |
| M3 | 手机后台/锁屏后恢复、真实刷新及 Wi-Fi/蜂窝切换；另同时关闭 Wi-Fi 和移动数据至少 12 秒后恢复，检查不重复执行 | 已完成客户端断线/重连、去重、状态恢复与安全边界的L1合同；真实controller恢复已证，实体手机恢复另行补验 |
| M4 | 核真实手机尺寸、触摸目标、滚动/截图显示；若本轮涉及语音，再核手机麦克风和实际播报 | 桌面窄视口、Web组件/音频协议测试与必要修复；语音不额外扩大必做范围 |

队友独立试用需要另一位实际参与者，是单独的人类条件。普通本机系统交互优先自主处理，只有 OS/账号明确要求真人且确实无法代理时才报告具体动作。

## 11. 费用、停止与恢复规则

真实模型按新批次持久记录 main/risk/重试/失败请求，先预占再派发，重定向不得漏计。正常生产每Run原步数/请求上限保留；控制测试尽量无付费模型。第一自主批次默认不超过 main120、risk12、总132 次实际模型请求，分段推进；这是本计划自行设置的保守执行上限，不是要求用户逐次许可。历史计数保留，金额未知不能写零费用。

达到批次上限先汇总实际用量、成果和缺口，不能无记录续跑。有新的已修复版本或尚未覆盖的明确任务时，可在本授权内自主建立下一有界批次并记录理由，无需用户逐轮确认；同一失败没有新证据则不追加付费重跑。离线修复和非付费验收继续，不因内部批次额度停止全部工作。模型慢、网站失败和代码失败分别定位，不通过无限加次数或超时掩盖。

每个阻塞最多先取一条充分失败证据并做一轮最小修复复测；第二次同因失败转离线根因，其他独立项继续。只有剩余事项均依赖实体手机或真实外部条件、无法继续取得实质进展，才阶段收口并列证据，不因一次失败停止整个计划。

本地同一时间只有一个桌面操作者；子代理不得并发运行真实 GUI、paid API、重启服务或改同一源码。任务结果 unknown 时停止该副作用路径并核事实，不擅自重放；正常取消/关闭已确认自有测试资源后释放环境。

## 12. 执行看板与续接格式

| 阶段 | 当前状态 | 本轮完成出口 |
| --- | --- | --- |
| S0 接管与版本 | 完成；历史dirty保留、账本/版本/stock0.22.2/服务归属已核 | 环境/归属与新批次 |
| S1 离线基线 | 历史完整组合17ec145：Luna114文件1866 Vitest+72 TAP/typecheck/Webbuild；Sol40项UI独检、a491076 Runtime137项独检。onclick产品bdf6e7a定向Sol336项/真实fixture47项及五项CI通过；焦点282d528独检TS298项/native347项/2 ignored；attached-sheet edfe800相关837项、动画修正da0fedf Computer291项及真实帧4例独检通过；历史2e6d898五项CI全绿（38138765523）；当前08dec5e定向229项与Root Web五态通过，CI38141124345首轮失败、正常failed-jobs重跑attempt2全绿；Unicode最终作者native351/2ignored与Sol四补丁重放、99161e2a真实验证分列 | 首失败与修复保留，历史完整suite不冒当前重跑 |
| S2 Web/Runtime入口 | 正常Web Run/stock截图；两独立公网HTTP会话配对、CSRF与隔离撤销通过；headless独立contexts正常UI批准/刷新去重/无效码/390px通过 | Provider/Computer业务与真实手机未通过；公网部署闭包未同版 |
| S3 Mac T2 | 两项权限已正常恢复，Unicode候选真实中文LF/GoTo读回及自动nested双pop已证；最新完整goal1133B Run首click后未知弹窗暂停取消，零Provider新blank未复现；完整卡仍无文件成果 | 生产PID shortcut无可见效果、正常HID产生真正同PID嵌套GoTo已实证；最小修strict HID与直接AXSheet关系，0/169派发后回读的未知副作用不重放；保存关闭重开、独立重复与变体仍缺 |
| S4 T1/T3/控制 | a8dad6d平台与bdf6e7a onclick修复取得真实正例；完整T1三产品与T3三车次仍未通过。A04唯一high T1正确CMD+L后命中Chrome焦点证明生产缺口；原生/TS修复282d528现已真实focus/type及拒绝反例通过，完整网页业务仍未重验 | 正常controller同Run已证paused后零派发、纠正投影与resume最终报告；批准去重/reject零执行/correct旧approval失效/SSE恢复及同名preview并发/取消恢复/过期等实证与L1分栏。候选真实focus/capture已证；完整T2/T3保存待冻结nested/HID修复真实验真与完整原卡，网页业务失败不归入手机 |
| S5 评测器 | 隔离PR23审批证据兼容cb6aacf经Sol157/157，依赖draft PR27；真实A01重评inconclusive/false，5个误报mismatch消除，业务缺iMac/配置独立保留；PR22/24取舍已核 | 真实成功样本/真人审核缺口 |
| S6 交付与手机包 | 08dec5e已非force原SHA同步PR26；当前CI首轮失败、正常failed-jobs重跑attempt2全绿；A05完整goal/TTY入口经Root全文审核，当前actual33、最新outcome_unknown。旧fa19cbb Preview三件正常账号0700暂存/逐SHA/default inspect通过，但F1–F4修后须重打包，旧包不得apply | 已暂存未部署：生产PID/current未变。正常sudo Password挑战入口已实证，需本人认证后sudo-l策略/无活动Run确认再部署；不再称仅服务所有者可发布 |

### 总计划出口历史映射（10月10日19:12；当前见下方A05审计）

| 总计划出口 | 本轮可自主项完成证据 | 尚未关闭的具体条件 |
| --- | --- | --- |
| 批次0整合/版本/保护 | S0快照、5个产品/计数提交及a491076测试修复、476项dist闭包、PR22/24逐项取舍与回退 | 无新的自主准备缺口；未核历史dirty仍原位 |
| 批次1双预算/HTTP/部署 | 最终1866+72；实际143863B/13066tokens请求、两次HTTP200；真公网HTTP认证/CSRF/非法Run400/隔离撤销 | 完整大查询任务仍待Mac真实任务链路补验；公网Preview安装匹配闭包需服务所有者合法发布权 |
| 批次2候选/预览/共同保护 | 精确目标拒绝零输入、302项L1合同、可信选项/失败提示修复及40项独检 | macOS原生同名双窗/sheet仍待候选驱动真实复验；L1不冒真实现场 |
| 批次3 macOS完整T2三轮 | 196B三卡、唯一abs路径、失败轨迹/真实截图/磁盘absent复核 | 用户已正常解锁；候选原生驱动TCC待正常授权，辅助不能代业务输入保存 |
| 批次4 T1/T3三轮与控制 | 完整三轮卡/公开模板、正常headless配对UI及真实controller暂停纠正恢复/审批/SSE链；Mac快捷键及携程建议DOM真实正例 | T1三产品/T3三车次网页任务真实失败；Chrome地址栏独立焦点证明已真实验真。原生跨应用保存待嵌套GoTo定位与完整复验，手机触摸另列 |
| 批次5评测器与交付 | PR23审批兼容依赖PR27/157项独检、真实失败与不完整success重评inconclusive、正常CLI报告导入；PR26及当前CI、最终包 | 无真实成功成果和真人复核，不制造评分校准；队友试用需另一人 |
| CUA性能/升级 | stock0.22.2实际hash固定、实际延迟/超时与拒绝保存，必要SDK/CLI修复已审 | 无同任务成功样本，不宣称性能收益；low已有真实HTTP200及GUI输入观察；无成功同任务性能对照，不为版本号盲升级 |
| 实体手机/队友 | 手机包M1–M4与最短续接步骤齐备 | 手机与另一位队友分别是外部条件 |


每轮只追加：版本｜任务/Run｜入口L1–L4｜结果｜成果/日志｜实际调用累计｜介入｜问题/修复｜下一动作。历史事件继续引用，不再向旧三聊天逐次报备。续接当前聊天时直接从此看板第一个可执行项继续；用户已授权，无需再重复请求开始、测试、修复或普通部署的确认。

本轮实际记录见 [Sol/Luna 自主执行账本](./astra-autonomous-execution-ledger-2026-10-10.md)。

最终启动/回退与集中补验见[阶段交付与手机包](./astra-stage-delivery-and-phone-pack-2026-10-10.md)。


2026-10-11 最新控制出口：SSE b08268c修复后同版正常Host五次断开恢复/并发cap/after-seq尾事件通过；批准重复commandId只一次执行、reject零执行、correct使旧approval409/零执行、随后cancel均独检。A01–A03累计180main/4risk/184请求，169已知usage2982210tokens、15未知。正常Host15648保留，所有Run终态；继续零Provider建议DOM定位，完整T1/T2/T3及剩余现场矩阵未升级。


### 2026-10-11 完整出口覆盖审计（历史稳定点；当前进度见顶部）

主计划批次2原文要求“目标关闭/刷新、旧 previewToken、迟到、并发、解码失败、取消/撤销、身份复用不误确认或重复创建 Run”；批次4要求“暂停生效后零新派发；恢复使用最新要求；刷新和断线恢复不重复创建 Run/重放动作”。本表不会把局部控制或修复提升为上述完整出口。

| 项目 | 已证范围 | 当前继续动作或明确缺口 |
| --- | --- | --- |
| T1三产品、三轮 | A04 low/high均进入Mac mini来源配置，缺Air/iMac；high正确CMD+L但焦点确认拒绝，仍失败 | 零Provider已证stock原生catalog不完整且无focused/editable字段，独立精确窗口focus_proof修复282d528已离线通过；不伪造complete/不凭截图放行，候选真实地址栏focus/type及拒绝反例已证；候选权限与零Provider验真已过；当前F1–F4选择性修复统一冻结后继续完整原卡 |
| T3三车次、纠正、跨应用、三轮 | CMD+A和onclick城市建议真实执行；随后缺参数/旧ref，完整卡取消 | 网页业务真实未完成，不归因TCC/手机；无新合同缺陷不重跑同版。原生GoTo中文读回与双pop已证，仍需完整原卡业务成果 |
| Mac T2、原生sheet与父窗往返 | 正文196B真实图、原生捕获错域根因及false补丁离线验证 | 新版candidate两项权限已实际通过，中文LF/GoTo读回与自动nested双pop/旧ref拒绝已证；最新完整goal首click后未知弹窗暂停取消，新blank零Provider未复现；保存关闭重开/三轮仍缺 |
| 正常controller | 模型Run/请求中取消、批准去重/reject/correct旧request失效、SSE断开恢复/尾事件；A04同Run实证paused后2.035秒零新派发/零action、correct→resume、后续实际context保留纠正及最终标记 | 已证正常认证API协议与Runtime链，不冒Web按钮/手机触摸；报告旧句与纠正标记矛盾保留，不计业务任务成果 |
| 同名候选preview | 真实两窗图可辨、refresh stale、缺/错proof、目标关闭拒绝；并发200/409 BUSY、abort后恢复、in-flight refresh stale、自然两分钟过期create拒绝，均零Provider/无新Run | 同标题替代测试被refresh/过期混杂，仅计stale；畸形PNG、精确CGID复用等不可经正常入口确定制造的边界保留L1证据，不伪造现场 |
| 评测器、交付 | PR27精确审批证据修复157独检、真实A05失败重评；PR26产品fa19cbb已非force同步，五项CI全绿（38120158120）；A05模板静态独检及Preview暂存实际通过 | 无真实完整成功样本/真人评分；Preview尚未部署，认证后才可核sudo-l策略并执行冻结事务 |
| 外部条件 | 旧candidate两项权限曾实际授予/验真；新版CDHash正常录屏重添on待重启、Accessibility原生认证挑战保留 | 当前macOS Touch ID/登录密码与远端正常sudo Password认证分别待本人完成；远端策略须认证后sudo-l核。M1–M4实体手机、真人试用/评分另列；Windows/Linux不在责任/阻塞/完成条件 |

正常认证controller同Run暂停零新派发、纠正恢复、精确批准去重/reject/旧approval失效/SSE及同名preview局部实证仍分列API、Web按钮与实体手机。此前PID shortcut无效果及Unicode partial0/169、0/71已派发后的未知副作用保留，不重放。此前入口误发Run run-1791721127906-572090aa-95f cancelled，6模型请求/5GUI动作；独检发现launch误将card.expectedText196B当完整goal，漏掉纯文本/唯一保存路径/关窗重开，不能算完整原卡复验或产品RTF/模型遵循失败。完整goal实际1133B，SHAca78d2cfa9e9152ab1c9e3c349425e941c3b41f92aeec775541414dc9ee41df2；私有持久TTY入口已修为仅card.goal来源并经Root全文独审，实际FD0/1/2为TTY。随后完整goal Run run-1791721677801-6954ca90-3dc仅1请求/1次completed click后转user.input.requested，已精确取消终态；未输入正文。新的独立零Provider空白首click复现completed且candidates为空，未复现未知弹窗；稍后前台为ChatGPT不能倒推原暂停原因，不以Dock行归因。指定输出仍不存在。累计A01–A05为257main/6risk/263实际请求，240份已知usage合计4523213tokens、23请求usage未知、金额未知；A04冻结60/2/62，A05实际17/0/17、cap120/6/126、正式预占80/4/84 revision1保持。PR27/cb6aacf157独检及业务缺项/真人评分缺失保持；Preview仅fa19cbb用户staging逐SHA/inspect通过、未部署，远端正常sudo认证独立未完成。

2026-10-11 系统设置权限历史挑战（已由后续用户认证及实际授权覆盖）：两项正常UI“添加”均触发Touch ID/密码挑战，未输入凭据、未选择候选或更改权限；当前录屏与系统录音认证挑战留给用户本人完成。上一交付head e0923b6（产品源282d528）五项CI全绿；新文档head的CI尚未核。证据见私有 `A04-private/system-settings-tcc-ui-attempt-20261011.json`。


### 历史稳定点：2026-10-11 用户要求继续后的执行看板（已由顶部当前状态覆盖）

fa19cbb当前五CI绿包含完整组合，源码/候选签名保持冻结；A05模板PASS_STATIC_ONLY、历史target清空、fresh绑定与实际FD0/1 TTY在启动时核。Preview冻结包已正常账号0700暂存三件0600、逐SHA/远端默认inspect通过；生产PID155349/current旧release未变、health200，为“已暂存未部署”。正常sudo-l实际Password挑战已取得并正常退出，不再泛称只缺所有者；须本人正常认证后核策略/无活动Run再apply。当前Accessibility真实Touch ID/登录密码挑战保持，录屏on待统一重启；未收到完成证据，不再反复GUI触发。两个认证条件互不替代；所有Run终态、256请求与A05 actual10/正式预占80/4/84不变。官方Apple参考只供独立审查，价格未知、不计业务/不注入Provider。完整T1/T2/T3未验收，实体手机与真人项另列。详细产物见账本最新节，本次不改源码/签名、不重跑CI，不为状态立即推送。


历史状态补正（后续已由顶部当前状态覆盖，本次“已验证”之后）：正常UI已精确完成Accessibility添加，两项列表on；同签名候选已重启PID35455，真实两TCC与AX pass。health整体degraded仅因独立bundle与hardcoded canonical不等及只读capture skip，保留原字段，真实capture/nested/type尚未验。随后当前onConsole CGSSessionScreenIsLocked=true独立证实Mac实际锁屏；现在需正常解锁，不再要求重复TCC认证。远端sudo认证独立未完成，Preview仅暂存未部署；历史256/全部Run终态保持。解锁后直接零Provider生产验真→A05原完整T2，未经成果核不得签收完整业务。


## 2026-10-13 T3 主集成验证更新

Host-owned `native-web-document` 实现及其普通 Web/Relay 入口、Browser 与 TextEdit 独立能力边界、一次性文稿恢复已由 Luna 实现、Sol 独立审查并导入主分支，共25个路径。Root逐文件核SHA与审查清单一致，保留9720350的CI等待修正；主目录类型检查、119文件2089项Vitest、72项Node自检及Web构建全部通过。私有证据为 `T3-integration-20261013-private/root-final-integration-verification.json`。这是离线实现与组合夹具通过，真实三线业务任务仍待现场验证。9720350的五项CI已通过；此次T3新提交需单独等待CI，不继承旧结果。本轮真实Provider调用仍为0。

屏幕录制权限已完成off→on刷新，并按系统提示退出重开目标App。辅助功能刷新再次出现macOS本人认证，已请用户完成；执行者停在该实际认证面板，尚无刷新后的health或业务Run通过证据。

# 小组修改意见综合审查与测试修复交接

日期：2026-10-12，Asia/Shanghai。用户要求综合审查小组意见，使用 Astra 中等推理模型，加入另一测试修复对话的两份计划并传递。本次已用 `gpt-6-astra` / `medium` 只读审查；主代理整合文档与交接，不实施产品修复或真实模型/桌面任务。

## 基线、证据与综合结论

当前 Git HEAD `6c0af497ddbbf85d8d6ce9a697a2bdd2ed7de801`，产品源码仍为 e7bce7f；两者间仅文档变更。新鲜 GitHub 核查时间为2026-10-12T12:56:32Z（20:56:32），PR26仍有两次 CHANGES_REQUESTED、4条行评论，无新增 review。

原始小组意见：2026-10-11 [review5483774523](https://github.com/wszkxlllll/Computer-Harness/pull/26#pullrequestreview-5483774523)、2026-10-12针对e7bce7f的 [review5488994312](https://github.com/wszkxlllll/Computer-Harness/pull/26#pullrequestreview-5488994312)。已与实际源码逐项比对。评审所称“339既有测试通过、追加5项缺陷检查失败”保留为评审者既有证据，本轮没有重跑，不冒称独立复现。

结论：可以进入共享正确性整改，不能按 CI 成功直接放行整合。最新五项主要缺陷均有当前源码依据；其中 Windows 专属修复/原生验收受用户范围排除，共同 Session 平台合同只按本项目必要影响纳入。Mac 既有增量、T2 CLI三轮实验成果与来源绑定实验保留，不整树回退、不把它们扩大成普通模式/Web验收。

以下 MR-01 至 MR-08 是两份计划与执行对话共同使用的唯一意见编号；具体证据、修正原则和验收以本文件为准，后续不再各维护一份不同队列。

## MR-01 / P1：附加列窗破坏普通模式窗口恢复

**成立，优先修。** `packages/runtime/src/run-controller.ts:2714` 先附加刷新清单，`:2895` 后正式恢复检测；`packages/computer-cua/src/cua-driver-computer.ts:2816–2825` 的 preserve 仅覆盖 Mac、recoverBoundWindowMissing、foreground 等受限条件，其余目标消失时会先置 Surface unknown。

修正原则：共享层明确已完成动作协调、正式恢复检测与附加清单读取的顺序/职责，或让附加读取不消耗恢复资格。不能靠不断扩展 Mac 应用/面板特例掩盖普通模式问题。若某模式有意不支持恢复，明确其合同与受控退出，不能由附加读取隐式决定。

最小验收：沿真实 Runtime 主循环组合覆盖 completed→旧窗消失→清单读取→waiting_window/显式选新窗→新观察→继续；普通模式、受限 native profile分别出证。完成动作不重放，unknown动作不重放，错误/多候选/陈旧ref拒绝保持。必要 Mac 真实诊断在定向通过后进行，不新增 Windows 原生任务。

## MR-02 / 评审P1：有效平台来源与消费者不一致

**缺陷成立，按责任裁剪。** `cua-driver-computer.ts:1387` 保存 health 推导平台；`:5878` 对缺失/不匹配报告返回 undefined。`:4156` 多行分流只认 current.platform，`:4046` 快捷键和`:4437`工具映射却会回退配置/本机。

纳入本项目的是共同 Session 平台来源与 Mac 消费者一致性：连接边界产出稳定的有效平台及来源，明确有效 health、显式配置、宿主回退和冲突的合同，平台敏感消费者共同使用；缺 health 不等于全面禁止正常输入。

评审的 Windows 多行绕过属于范围外的具体平台修复，保留证据交对应成员，不建立 Windows/Linux 专项实现、专测、原生实测或验收阻塞。已有兼容源码和CI保留。

最小验收：先用离线缺/无效/schema或版本不符/冲突报告，确认共同合同及 Mac 工具映射、批处理、底层派发一致；证明本项目必要影响后最小修共享生产/消费。没有 Mac/共同层影响时记录边界并移交，不能只为解决 Windows 专属负例扩大责任。

## MR-03 / P2：审批安全字段在实时出口丢失

**成立。** `packages/app-runtime/src/approval-preview.ts:234–248` 已生成安全字段；`remote-run-api.ts:1619` 的 publicRequest action白名单丢失 `groundingRef`、`optionText`、`optionCharacterCount`、`optionTextStatus`；`apps/web/src/components/ApprovalActionPreview.tsx:104` 已有消费者。

仅转发生产者过滤后的四字段，保留显式白名单，不 spread 原始模型参数。验收同一 pending approval 的 GET与SSE经Relay到Web一致；包括可见、脱敏、敏感、失配/截断选项，刷新前后不改变可理解的批准内容。Web链路可自主验证，真实手机触摸另留M2。

## MR-04 / P2：Qwen可选诊断失败污染请求结果

**成立。** `packages/app-runtime/src/diagnostics/recording-clients.ts:175–193` 成功后直接 await appendFile，catch内再次写日志，可能把成功响应变失败或覆盖原Provider错误。GLM的安全日志辅助函数已有隔离示例。

将可选记录构造、序列化及写入错误与Provider成功/失败隔离；不重发请求。成功fake客户端+不可用日志目录必须返回同一成功对象、调用一次；失败fake客户端+日志失败必须抛同一Provider错误、调用一次。Runtime权威事件持久化的失败语义不放宽。

## MR-05 / P2：Qwen实际出站工具合同截断

**成立，但须准确区分输出模式。** `packages/provider-qwen/src/index.ts:648` 的 strict_json catalog 将普通工具description截180字符，统一 `packages/runtime/src/computer-tools.ts:39` 的Mac省略elementRef约束在后段；compactToolArguments未补完整参数说明。native_tools走独立function tools路径，不能笼统声称所有Qwen模式都被同样截断。

从统一Registry投影关键平台约束，必要时依共同有效平台过滤；不新增另一套工具清单。拦截GLM/Qwen真正出站body，覆盖当前启用的strict_json/native_tools，核Mac输入限制完整可见、无冲突建议、旧模式兼容与预算仍有界。不只测试Registry原文或执行端拒绝。

## MR-06 / P2产品出口：来源绑定结果需区分用户说明与审计证据

**成立，属于opt-in来源实验交付质量。** `packages/runtime/src/source-linked-finish.ts:150,205` 目前主summary包含role/source/name/state工程摘录、英文Unknown/Inference；直接用于Web/语音不够清楚。

结构化原文、状态限定、Observation/Surface绑定及审计输出保留；用清楚中文呈现用户主结果、未知/推断和需复核内容，不用自由模型总结覆盖权威证据。保留selected=false、disabled、歧义/多源和捕获时间等限定，不能把历史来源说成当前有效、把未选择说成已选择。验收未知、推断、多源冲突、未选择/禁用等固定反例与可回放绑定；失效来源不能从格式绑定自动推为仍有效。功能默认关闭不变，修完不能据此认定SKU语义、最低价或T1业务完成。

## MR-07 / 随MR-01：机器信号代替展示文案控制流程

**成立。** `run-controller.ts:2714` 依赖receipt.message包含换行和图标触发列窗。与MR-01一起协调，用明确机器结果或已取得窗口发现结果驱动，文案只展示。修改/本地化/删除图标不改变控制流，只有相同文本而无可信信号不能触发权威状态变更。不为此新增第二Runtime或大规模拆包。

## MR-08 / P2先归因：预览总期限与清理状态

**需定向复现，不能只看8秒/20秒认定取消失效。** `remote-run-api.ts:140,1782` 外层8秒；`window-discovery.ts:159` 前清单→捕获→后清单；`window-contract.ts:263` 内层20秒已用AbortSignal.any合并外层信号。已开始操作还可能等待取消/清理。

先做可控时钟/慢阶段诊断，分别覆盖前清单、捕获/重试、后核对、排队、清理。定义用户返回期限与资源清理期限，再决定统一剩余预算、错误分类或队列状态的最小改动。届满不颁previewToken；前后精确身份、旧token失效和解码/大小合同不删；清理未确认不能假装会话可安全重启。先离线，修后仅必要的一次Mac真实预览；历史缩略图修复不重复计为本问题关闭。

## 应保留、参考接收及不纳入内容

- 保留已修F1–F4、Unicode/点位/附着sheet等Mac增量。T2同95b CLI L2 experiment、riskGuard/riskModel off 的基线/repeat/原variant三轮已证；默认layered/正常Web要在新冻结版本另出证，不覆盖旧结果。
- PR23→PR27评测器保持隔离；独立业务失败证据不冒真人评分，真实成果、evaluator判定、真人评分分别记录。PR28只作为材料/冻结合同参考，不变成医疗/缴费业务任务，不重标历史Run，也不加进本地498调用累计。
- Windows/Linux原生实施、专测与验收，以及Windows发布脚本根路径问题范围外；大规模拆分CuaDriverComputer属于后续可选重构，不作为修当前缺陷的前置。
- 实体手机M1–M4、语音实际听感、独立试用和真人评分分栏；可自主完成的Web、离线合同和Mac测试不推给用户。正常系统本人认证或真实外部条件按实际现场报告，不复用旧挑战状态。

## 两份计划落点及执行顺序

总计划补完成条件：共享恢复/合同、真实审批链、Provider诊断边界、来源结果可读性与预览期限的MR证据；原T1/T2/T3三轮出口不降标。自主计划补有序队列：MR-01+07 → MR-02共同影响核实 → MR-03/04/05 → MR-08定向归因及MR-06呈现 → 同冻结版本正常Web/Mac完整任务 → 手机预留/交付。

优先最小离线失败复现，再最小实现与Sol独检；没有新证据不追加付费重试。每项记录source pin、反例、改法、定向结果、真实入口、计数及未覆盖边界。维持一个Runtime、重叠模块单写者、桌面/服务切版互斥，未知副作用不重放；不要再用扩大预配置实验替代普通模式正确性。

## 交接对象与授权

已读取并核对的承接对话为“审查并同步 AStra 计划进度”，thread `01a124b9-c56b-7a91-89d8-2581f4ae15a6`，与本审查对话同名但ID不同。它的末轮执行到e7bce7f，已停止自有Host/Relay并指向本仓库相同两份计划。

用户在当前对话明确授权向另一个测试修复执行对话传递。本次计划更新和交接不等待旧三聊天ACK；也不自动派工旧（6）/（8）/（10）。发送时用Astra/medium接收整合，实施沿已约定Sol统筹/Luna执行/Sol检查；本审查聊天不并发改产品或操作桌面。先核收两计划并承接离线缺陷整改，不在交接瞬间直接启动新付费GUI业务轮。

实际交接已完成：发送工具成功返回目标thread ID，指定接收模型`gpt-6-astra`、推理`medium`。随后状态核查确认接收对话active，新turn `01a13034-8b33-71a0-a9a1-08d08850716c` 已开始；其进度消息表示先核收两份计划、综合审查与源码，随后承接离线复现，不启动付费模型或桌面业务测试。这证明已投递并开始接收，不代表MR修复完成。

发送原文及工具收据在私有`member-review-20261012-private/handoff-send-receipt.json`。两计划已交由接收端维护；本审查端释放产品/计划写权，后续不并发实施或操作桌面。此次计划增补和交接记录目前本地保存，尚未新增Git提交或推送，接收端可按最终有效范围整理最小提交，不能整批提交历史dirty。

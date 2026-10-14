> 历史审查快照；后续修复、PR23实际合并及最新组合验证以[执行记录](./astra-prfix-merge-execution-2026-10-14.md)为准。本文固定版本和当时未合入状态不冒充当前进度。

# Astra 远端 PR 合并前详细审查（2026-10-14）

## 1. 结论与审查范围

**暂不建议将当前候选直接合并 main。已独立复现两项 P2：PR22 在部分 DOM 观测下绕过已知点击限制；PR23/PR27 评测器可通过输出路径别名覆盖输入证据。应先修复，再验证整合后的确切提交。** 没有据此判定其余全部改动不合格，也没有将手机真机验收设为代码合并的统一前置条件。

本轮按 Sol 协调/审查、Luna 隔离验证完成。读取了五个开放 PR 的正文、提交/差异、审查与评论、当前 head 的检查结果；核对 Git 祖先关系；重点审查 Mac/CUA、浏览器点击、Host 生命周期、Web/Relay 身份与事件顺序、语音、GLM 预算和评测输入保护。不是对 408 个文件作逐行完整安全认证。

本报告接续 [当天远端与本地对比](./astra-remote-local-comparison-review-2026-10-14.md)。此前“未发现新的已证实阻塞问题”属于当时有限静态审查与纯探针的结论，**本轮新增反例将其更新为上述两项合并前必修问题**。以前的测试、现场成果和未验收范围仍分别保留。

用户范围：macOS、Web/Relay、手机相关共享代码；Windows/Linux 原生实现、专项实测与交付不纳入本方待办，保留现有兼容源码及 CI。新发现的点击问题用配置为 Darwin 的 fake driver 复现，属于共享代码问题。

## 2. 固定版本与远端状态

首次 GitHub API 采集为 2026-10-14 17:09:53（北京时间）；两次收尾重读为 17:26:02 与 **17:36:55**。五个开放 PR 的 head、base、draft 状态与 main 均未变化。本地 HEAD 仍为 `594fa8e9b38d6ec8da066da214468789756319ea`，本轮未改生产源码。

17:26 时 tracked 生产源码无 dirty；17:36 的最后核对发现共享 checkout 另有 10 个 Host/Web/AppRuntime 源码或测试文件产生未提交修改。本轮没有写入/回退这些文件，也未将它们纳入远端 PR 的验证范围。所有测试结论绑定上表确切 Git 版本与隔离 snapshot，不能将随后变化的共享工作区当作已验证候选。

| PR | 当前 head | 实际目标分支 | 状态 / 相对其 base 的规模 | 本轮建议 |
| --- | --- | --- | --- | --- |
| [#22](https://github.com/wszkxlllll/Computer-Harness/pull/22) | `156baad` | `main` | 非草稿；126 提交 / 408 文件 | 主要整合候选；先修 F1，再吸收评测链并复测 |
| [#23](https://github.com/wszkxlllll/Computer-Harness/pull/23) | `1f57852` | `codex/runtime-surface-preview-20261003` | 非草稿；3 提交 / 4 文件 | 评测基础；先修 F2，与 #27 按依赖整合 |
| [#24](https://github.com/wszkxlllll/Computer-Harness/pull/24) | `39a3b2a` | `main` | 草稿；2 提交 / 314 文件 | 不整包重复合入；逐项处理独有能力 |
| [#26](https://github.com/wszkxlllll/Computer-Harness/pull/26) | `594fa8e` | `main` | 草稿；90 提交 / 306 文件 | 已完整位于 #22 祖先链，不需要重复合并 |
| [#27](https://github.com/wszkxlllll/Computer-Harness/pull/27) | `3f22c30` | `member-c/evaluator-20261005` | 草稿；3 提交 / 6 文件 | 依赖 #23；共同修 F2，保留新增审批证据绑定 |

精确固定值：

```text
main 961a0982ee11bf2f4687756f5184869f197a1b4b
PR22 156baad40c74edbe4f97b4199c544167add8797f
PR23 1f57852879b53618029c24afedb1b5db0a786fe6
PR24 39a3b2aa9779024b30da50b0d2ef6b952163e2f4
PR26 594fa8e9b38d6ec8da066da214468789756319ea
PR27 3f22c308b1b6c762b6dc52c3206a7e07154f7dc4
```

五个 PR 各自最新一轮的 `ci-required` 和四个验证矩阵检查均成功，并核对到对应 head。PR24 同一 SHA 的历史失败/取消记录仍存在；“最新一轮成功”不等于删除旧失败。PR22 当前 CI 为 [38423839391](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38423839391)，PR26 为 [38347772526](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38347772526)。

GitHub 当时五项均报告 `mergeable=true / clean`，仅表示与**各自当前 base**机械上可合并。它不证明 PR22 与 PR24、PR27 两两兼容，不证明新增反例已覆盖，也不构成人工批准。

PR26 保留 10/11、10/12 两次 `CHANGES_REQUESTED`；10/13 在当前 `594fa8e` 的最新正式记录是 [COMMENTED](https://github.com/wszkxlllll/Computer-Harness/pull/26#pullrequestreview-5503620106)，内容接受主要 MR 整改，状态不是 `APPROVED`。PR22 的正式 review 仍是 10/05 的历史 `COMMENTED`，新 issue comment 和绿色 CI 不能替代当前候选的最终审查。

## 3. F1 — P2：部分 DOM 观测会丢弃已知负证据并发出 native click

**位置：** PR22 [cua-driver-computer.ts:4234–4238](https://github.com/wszkxlllll/Computer-Harness/blob/156baad40c74edbe4f97b4199c544167add8797f/packages/computer-cua/src/cua-driver-computer.ts#L4234)，尤其 `privateGrounding?.domComplete === true` 条件；后续 DOM disabled/live-click 检查因此不再执行。

**触发：** 同一次 hybrid observation 同时含 UIA 与 DOM 的按钮，名称、角色和边界相符，已有唯一观测内对应关系。UIA 报 enabled；DOM 明确 disabled，或 DOM 点位验证会拒绝遮挡点击。遮挡反例的 fake transport 设为“若调用则拒绝”，partial 分支实际上完全没有调用该验证。只将全局 `complete` 从 true 改为 false，例如页面还存在未完整遍历的 iframe。

| 同一按钮 / 同一动作 | DOM complete=true | DOM complete=false（当前 #22） |
| --- | --- | --- |
| DOM 明确 disabled | refused，native 0 次 | completed，native 1 次、DOM 0 次 |
| DOM live click 拒绝遮挡 | refused，native 0 次 | completed，native 1 次、DOM 0 次 |

**影响：** “全局还有未知 DOM”使已经拿到的目标负证据失效，动作转入 native point 路线。这里不是要求整个页面完整才允许一切动作，也不是将完全没有 DOM 对应项的正常 native fallback 判为错误；问题是已知目标限制被绕过。可导致点击禁用或被遮挡目标，或点到上层控件。

**版本对照：** exact `main961` 与本地 `594` 的四项负向控制均通过，均未发 native click；exact `156` 新增六项为 4 通过、2 失败。根代理独立复跑得到相同结果，确认是相对 main/本地的新回归。全部使用 fake transport，不操作真实浏览器或桌面。

**修正原则：** 全局 partial 不得抹去已知目标的 disabled/遮挡等限制。可保留对应 DOM 验证路径，或在证据不足时拒绝该目标；对真正缺失/歧义对应项的 native fallback，继续按既定身份、几何、点位限制处理。不能改成“任何 partial inventory 都拒绝基本 exact-window 动作”。

私有最小试验取消这个全局 gate，六项反例/正例均通过。首次完整适配器回归为 401/402：唯一失败是旧测试把“已知、唯一、可用 DOM，仅 complete=false”的路线明确写成 native。审查该 fixture 后，只在私有副本将这一场景改为 DOM 1/native 0；保留 missing/ambiguous 的 native 正例、completed 回执、错误点位拒绝、过期引用拒绝与调用次数不增加的断言。随后 **402/402 通过、0 skip**。

**放行条件：** 正式源码实现并同步相关路线说明/提示，加入这些有意义的负向回归与 fallback 正例，重新跑适配器全套及仓库常规检查。私有试验仅证明修正方向有效，远端尚未修复。

## 4. F2 — P2：评测器输出路径别名可以覆盖输入轨迹

**位置：** #27 [evaluate-trajectory.mjs:535–539](https://github.com/wszkxlllll/Computer-Harness/blob/3f22c308b1b6c762b6dc52c3206a7e07154f7dc4/scripts/stage4-local/evaluate-trajectory.mjs#L535) 只比较 `resolve()` 后的路径字符串；[:643](https://github.com/wszkxlllll/Computer-Harness/blob/3f22c308b1b6c762b6dc52c3206a7e07154f7dc4/scripts/stage4-local/evaluate-trajectory.mjs#L643) 的 `writeFile` 跟随链接。#23 [同文件:299–303](https://github.com/wszkxlllll/Computer-Harness/blob/1f57852879b53618029c24afedb1b5db0a786fe6/scripts/stage4-local/evaluate-trajectory.mjs#L299)、[:363](https://github.com/wszkxlllll/Computer-Harness/blob/1f57852879b53618029c24afedb1b5db0a786fe6/scripts/stage4-local/evaluate-trajectory.mjs#L363) 同样存在。此项由 #23 继承至 #27，不能说是 #27 新引入。

**复现：** 创建有效 synthetic trajectory/manifest，将另一个名字的 output 软链接到输入 trajectory，执行正常 CLI。两个 exact 版本都返回 exit 0，原输入 SHA 改变，轨迹被评测结果 JSON 覆盖。硬链接以及父目录软链接指向同一文件也可复现。根代理与另一位 Sol 分别独跑软链接反例，执行源码逐字节匹配固定 Git 版本。

**影响：** 普通本地输出命名/路径别名即可破坏原始评测证据，违背脚本已有的“output must not overwrite evaluator inputs”合同；不需要假设恶意调用者。输出结果里的轨迹来源信息也无法恢复已覆盖的输入。

**修正原则：** 保留直接路径保护，核对输入与已有输出的 canonical 路径及 `dev/ino`，拒绝别名；输出先写同目录随机临时文件（独占 `wx`），再原子 rename，避免最后 `writeFile` 跟随链接。保护范围应包含 trajectory、manifest、human-review、independent-findings，错误时不得改写输入。

**验证：** exact #27 原有评测测试 **172/172 通过**，但新增软链接反例失败。私有 inode 保护原型跑原有 172 项加一项软链接回归为 **173/173 通过**；另将软链接、硬链接、父目录别名三项一起定向跑，未修版 3/3 失败、原型 3/3 通过。未把定向三项与 173 项相加冒充执行过完整 175 项，也未宣称原型已经实现正式原子写入方案。

**放行条件：** 在实际评测整合候选上修复并补三类别名回归，断言失败退出且全部输入字节不变，再跑完整评测与仓库检查。修复 #27 的最终候选即可覆盖其继承链，但不要将仍有缺陷的 #23 中间版本当作独立可发布评测器。

## 5. 其余重点模块的审查结论

| 模块 | 本轮证据及结论 | 合并/发布注意事项 |
| --- | --- | --- |
| Web GET/SSE 与 Run 切换 | 真实源码转译、内存 DOM 探针覆盖旧 Run 事件、迟到 GET、较低序号快照、epoch 切换和事件先于快照；未发现新的已证实 P1/P2 | 这些是隔离函数/React 测试，不代表手机网络与读屏验收 |
| Remote API / Relay 边界 | 设备所有权、stale seq 零 dispatch、commandId 去重/改参拒绝、审批事件白名单、窗口 proof 单次消费通过 | 保留身份、序号及 token 绑定，不因整合放宽 |
| Host 清理与 owner state | 检查串行 promise、RunID 诊断绑定；终态 snapshot 在 history 释放前保留 cleanup-pending 的探针通过 | 未发现新的已证实清理竞态；不将终态文本等同完成释放 |
| 手动播报与输入取消 | 终态结果后的手动阅读重新取输出会话、输入取消活动语音通过 | 没有真实扬声器/手机 TTS 验收；旧版本已存在的录音期间通知行为不列为本轮新回归 |
| Host Guard / 浏览器配置 | 默认 layered 与显式 text/wire 预算、opt-in 非法值拒绝、远端目标拒绝注入 Host 路径/profile 通过 | CLI 实验成功不替代默认 Guard 的真实入口验收 |
| Mac / inventory | F1 使用 Darwin 配置复现；其余 exact identity、保存证据、单文件授权、finish 来源重点静态审查未发现新的已证实阻塞 | `current.platform` 缺省落回 process.platform 的旧调用点仍需按共享合同收窄完成表述，未证明普通 Mac 路线失效，不扩展 Windows 专项任务 |
| 评测审批证据 | #27 新增 fresh execution / approval 绑定值得保留；F2 与其评分规则无关 | 不能以 runtime succeeded 或模型自报替代独立终态证据及人工评分 |

上述 Web/API/Host/语音探针总计 **19/19 通过**，七份执行源码 SHA 与 `156` 匹配。它们使用依赖替身和内存 DOM，没有 HTTP 实服、真实 Provider 或 GUI。

### 路线与兼容性决策

1. #22 明确移除了 Web 的 `native-recovery`、`native-web-document` 两个起点及相应 Host profile 配置，保留 CLI 显式 URL、临时浏览器、精确绑定和单文件授权等路线。这是产品路线收缩；合并前须确认两份 Astra 计划对正常 Web 文稿路径的描述与最终路线一致，不能把它记为“两个 Web 起点已交付”。
2. 当天前一轮已用 API validator 复现：新 `156` Web 读取启用任一旧 profile 的 `594` Host 窗口列表时，Host 返回合法的含 profile 列表，但新 Web 校验器拒绝整份响应并报格式无效；普通列表通过。这是实际混版兼容风险，应同批核对 Host/Web/Relay 版本并安排发布，不是本轮发现的同版新 bug。
3. GLM 显式 `maxWire` 仍为硬界限；默认 Host 显式 text=16384/wire=24576。legacy 未显式 wire 且 text>=1000 的路线可增加 4096，应明确保留还是统一，不能概括成“所有场景都无条件降低预算”。
4. #24 与 #22 的 GLM 默认语义不同：#24 未配置 thinking 时为 `low`、固定 90000ms；#22 为 `enabled`，并解析 `GLM_REQUEST_TIMEOUT_MS`。不得整文件复制覆盖最新 Host 配置。

## 6. 依赖关系、模拟合并与 PR24 去重

精确 Git 对照：`merge-base(PR26, PR22)=594fa8e`，left/right 为 `0/36`；因此本地已提交代码全在 #22 祖先链中。这 36 个提交包含原有分支历史，不是 36 项新修复。#22 相对本地树为 198 文件、+24141/-3101；相对 main 为 408 文件、+68530/-3936。

本轮在隔离 bare 对象库运行 `git merge-tree --write-tree`，仅生成无引用 tree，没有创建正式提交、更新分支、解决冲突或推送：

| 假设组合 | 结果 |
| --- | --- |
| #22 + #23 | 无冲突，组合 tree `e761aecee695b99a6b90414a106d818fc4ee9c98` |
| #22 + #27（包含继承的 #23） | 1 个冲突：`packages/app-runtime/src/remote-run-api.test.ts` |
| 先 #23、再 #27 到 #22 | 仍为上面同一测试文件冲突，不能写成完全无冲突 |
| #22 + #24 | 34 个内容冲突，涉及 Host/Web/AppRuntime/CUA/Context/Runtime/Voice/docs |

#27 的 API 测试冲突应保留 #22 的新合同回归与 #27 的隐私/执行证据断言，不能任选一边删除。此处只有测试文件冲突，不代表组合代码已通过检查；本轮未构建或测试这个组合 tree。

#24 有 66 个非 docs/eval 路径，仅 4 个整个文件 blob 与 #22 完全相同（ApprovalActionPreview、approval-preview、context/budget、runtime/defaults）。这不是“其余 62 个功能未合入”，也不是“所有能力已覆盖”。#22 已有不少演进后的替代实现，必须按行为确认。

#24 明确还含需要处置的独有内容：只读、目标绑定的 Mac topology 及配套 upstream `d114f35` native overlay；DOM `checked` 与 `focusEvidence` 字段。#22 的 sheet/document 证据与新 click/UIA 检查不能自动证明这些等价。建议逐项选择保留、移植或暂缓，并记录理由，**不要整体合并 #24，也不要仅凭文件相似就宣称全部吸收**。这些未决能力不是本报告额外断定的新 P2。

已合并的 #28/#29 目标是 #22 所在分支，并非 main；#29 历史 Windows 测试失败与 #22 最终五项绿色检查分别保留，不把历史失败描述成当前 head 失败。

## 7. 本轮实际验证与证据分层

| 实际执行对象 | 结果 | 证据边界 |
| --- | --- | --- |
| exact #22 archive；Node 22.17.0 / pnpm 11.19.0 | offline frozen install；typecheck exit 0；Web production build exit 0 | 21 workspace，184 包复用，0 下载；依赖链接核对在隔离 snapshot 内 |
| exact #22 `pnpm test` | 130 Vitest 文件、2324/2324；Node 72/72；0 fail / 0 skip | 本轮 Luna 实际执行，非复制作者 CI 数字；仓库 fake/loopback 测试 |
| #22 核心点击新增反例 / 两历史对照 | 当前 2 fail/4 pass；main 与本地各四项负控通过 | Sol 发现；根代理独立复跑当前红与私有绿 |
| F1 私有修正 + 路线合同测试更新 | 完整适配器 402/402、0 skip | 保留首次 401/402 的失败历史；不是正式远端修复 |
| #22 Web/API/Host/语音 | 19/19 | exact source + stubbed seams / 内存 DOM |
| exact #27 评测器原有测试 | 172/172 | 根代理本轮实际执行；未覆盖新别名反例 |
| F2 原型回归 | 173/173；三类别名定向由 3 红变 3 绿 | synthetic 输入；非正式写入实现；另一 Sol 独跑两个版本的软链接红例 |
| 假设组合 merge-tree | #23 clean；#27 一冲突；#24 34 冲突 | 仅 Git 机械整合分析，未测试组合 tree |

没有新增付费模型请求、真实 SDK/桌面输入、实体手机操作或生产服务启动/重启。本轮离线通过不追加 T1/T2/T3 正常入口完成度，也不改写已有 CLI T2 三轮限定通过的历史。

私有证据位于 Git 忽略目录 `runs/astra-autonomous-20261010-sol-luna/premerge-review-20261014-private/`，目录 0700、证据文件 0600。主要入口：

- `summary.json/md`、`prs/*/`、`root-end-head-check.json`、`root-final-head-check.json`：远端版本、检查、review 与共享目录变化边界。
- `validation-logs/`：exact #22 typecheck/build/full test。
- `core-probes/finding-known-dom-bypass.json`、`known-dom-conflict-results.json`：F1 条件、各版本回执及源码匹配。
- `core-probes/root-independent-remote156.log`、`root-independent-private-patch.log`：根代理独立红/绿复验。
- `core-probes/partial-route-contract-validation.json`、`patched-full-contract-updated.log`：402 项及中间失败说明。
- `root-evaluator-*-probe.json`、`root-pr23-evaluator-output-alias-probe.json`、`sol-evaluator-output-alias-independent.json`：F2 输入 SHA/exit 与独立核验。
- `pr27-evaluator-test.log`、`pr27-evaluator-proposed-regression.log`、`pr27-evaluator-three-alias-{red,green}.log`：原有及原型测试。
- `sol-web-probe-results.json`、`merge-tree-results.json`、`pr24-nondocs-coverage.json`：19 项、冲突路径与去重清单。

原始私有日志、凭据、用户运行数据和原型不提交；本报告只公开代码位置、合成复现结果与放行条件。

## 8. 后续合并执行顺序

1. 以确切 #22 / 评测链 head 建立隔离修复候选，先完成 F1、F2 正式实现和回归；共享现场当前仍由测试执行对话管理，不在其 checkout 切分支或替换服务。
2. 明确 #22 Web 文稿起点收缩、GLM legacy 预算及 #24 独有能力的处置。产品说明和两份计划与最终行为保持一致；不必为了代码合并恢复所有历史路线。
3. 按依赖整合评测链：可先将修复后的 #27 合入 #23 所在分支，再将更新后的 #23 合入 #22。若采用其他 Git 组织方式，同样保留 #23 基础及 #27 增量，不把它们当互斥二选一。解决上述 API 测试冲突，保留双方有效断言。
4. 对**实际组合并包含修复的最终 head**重跑 typecheck、Web build、完整仓库与评测测试、新增负向回归，并等待该 head 的 CI；重新读取 head/base/review，避免拿本报告的旧 SHA 放行新改动。
5. 更新 PR22 描述，明确最终内容、两项修复、验证与剩余现场限制；draft 与正式 review 状态按最终候选整理，再决定 PR22 → main 的合并。PR26 已被包含，合并后核对 GitHub 状态并留历史，避免重复操作；PR24 仅按选定内容处理。
6. 代码合并后再做同版 Host/Web/Relay 构建与受控发布验证。正常 Web/default Guard 的完整任务、真实 Mac 原生链路与手机专属验收分别登记，代码合并不等于 Astra 产品全部完成或可直接上线。

本轮只新增本报告及索引入口，并生成隔离私有测试/原型；没有修改正式业务代码，没有提交/推送，没有在 GitHub 发送 review/comment，也没有执行任何 PR 合并、关闭或部署。

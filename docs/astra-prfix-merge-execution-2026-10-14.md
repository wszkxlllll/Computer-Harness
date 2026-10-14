# Astra 两项合并前修复执行记录（2026-10-14）

## 授权与当前批次

用户授权优先完成已复现的 PR22/F1 与 PR23/F2，测试、Sol 独审及当前提交 CI 通过后，依次 PR23 → PR22 → main。Sol 协调、Luna 分隔离目录单写、Sol 独审；不切换共享现场、不操作前台或服务，不等待手机及新 App 权限才能推进离线工作。PR27 审批增量不作为本轮必合前置，PR24 不整包合入。Windows/Linux 原生实现和专项实测排除，既有共享兼容测试与 CI 保留。

本记录接续[详细合并前审查](./astra-premerge-review-2026-10-14.md)。旧私有原型、旧 CI 和历史审查不替代本轮正式候选结果。

## 接收时核版

fresh GitHub API 及正常 fetch 核对：

| 对象 | 当前 SHA / 关系 |
| --- | --- |
| main | `961a0982ee11bf2f4687756f5184869f197a1b4b` |
| PR22 | `156baad40c74edbe4f97b4199c544167add8797f`，目标 main |
| PR23 | `1f57852879b53618029c24afedb1b5db0a786fe6`，目标 PR22 所在分支 |
| PR26 | `679b08c43e1806b3cc0aae2db39b84d0487977d4`，draft，目标 main |

PR26 当前与 PR22 的 merge-base 是 `594fa8e9b38d6ec8da066da214468789756319ea`，left/right 为 **1/36**。因此此前“PR26 全部在 PR22 中”的表述仅适用于旧 594，不适用于当前 679。679 的缺模型凭据提前拒绝、测试、三份文档及 native9/10/11 patch 交付已在本地与远端 PR26 保留；没有反向覆盖 PR22 新合同或重新引入它已移除的 Web profile。PR26 正文已更新到实际关系。

679 的 [CI38544542836](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38544542836) 实际 completed/success，四 verify 与 ci-required 五项均成功。该结果不授权尚未生成的修复/组合提交。fresh branch API 显示 main 和 PR22 分支 protected=false；rulesets API 不可用，后续仍以实际合并 API/检查要求为准，不绕过分支规则。

## 新增专项复审接收：MODE 与 679 语义适配

[集成专项复审](./astra-pr22-integration-review-2026-10-14.md)新增P2 MODE：exact59的wx临时文件未指定mode，正常umask022下原0600结果被替换为0644；原existing-output测试又经fixture.invoke先rm旧文件，不能证明原有输出替换。此前160项及Sol放行只支持实际覆盖到的别名/失败清理，不能继续作为完整writer权限安全通过。Luna已修显式0600与真实existing-output回归，完整162项通过；Sol独跑162/162并以umask022、0755父目录实际CLI独验new/existing0600、输入不变和tmp清理，3文件pin放行并导入最终PR22候选。main未合并。

用户同批要求保留679有效成果并完成语义适配。另建046基线隔离port树，由Luna完成4生产/6测试及6份native归档；作者和Sol分别实际六套件218/218、typecheck通过，16pins已导入最终PR22候选；保持PR22的RunCloseConfirmation、统一finish/tool/context/operation guidance与preview错误合同，旧native-recovery测试迁到合法window/browser/auto目标，不恢复退役API。曾误套旧测试整文件，Root审diff发现后撤回，恢复046并只手工新增凭据测试；错误候选六失败不作当前证据，完整首轮日志被作者误覆盖，保留真实可得失败摘要，未伪称原始完整日志仍在。Root不整合679旧profile配置；旧679现场文档继续在原提交/PR26保留，当前有效状态与来源按本批新文档映射；最终组合重新全套/CI/Sol独审。原679和PR26远端引用保留，最终是否祖先包含与行为移植分开记录。

## 正式修复与独审合同

| 任务 | 本轮要求 | 当前证据状态 |
| --- | --- | --- |
| PRFIX-22 | partial 不抹去已观测唯一 DOM 的 disabled/live-click 负证据；完整/部分 DOM 正反对照、真实 missing/ambiguous native fallback、精确点位/stale 零新增派发；同步源码和工具提示 | 正式提交392b6ca：作者相关785/typecheck通过；Sol独跑455（含adapter402）通过，精确8文件pin放行 |
| PRFIX-23 | 实际 CLI 输入及已读取初末截图证据的 canonical/devino 别名保护；非零拒绝且原字节不变；独占临时写入、原子替换、拥有权与失败清理；正常输出/合法覆盖 | 正式提交59a952d：作者及Sol分别完整160/160，3文件pin放行 |
| 组合交付 | 两项独审后精确非 force 推送；PR23 合入 PR22 后当前实际 head 重跑 typecheck、Web build、完整仓库/评测、新负例，核同 head CI 与 Sol 独审，再合 main | PR23已实际合入PR22；最终组合全套/CI/独审待完成，main未合并 |

PR23 现版本 CLI 支持 trajectory、manifest、human-review，未支持 PR27 的 independent-findings；不为本修复引入 PR27 功能。截图由现有 bindObservation 读入，也属于需保全的原始证据。独审预读指出原子 writer 不能在 open(wx) 失败、尚未取得临时文件所有权时删除已有文件；该问题已反馈实施者，最终ownership修复及open/write/rename回归已通过；Sol另对实际writer作EEXIST注入确认未取得所有权时不rename/unlink。

PR22正式修复提交为 `392b6ca9dc89136852b3c1f517ddfd1cdced6145`，PR23为 `59a952d1be8229fe7992e25969c39fd691ef118e`；Root用普通Git凭据和GitData API上传逐blob核同的本地提交，force=false，更新前检查parent、更新后重读ref。PR23 CI38547248255实际completed/success，五项全绿。PR22 CI38547377207实际failure：三组verify成功，Windows共享测试两项失败并导致ci-required失败；完整日志保留，未合并或重跑旧版本掩盖。独立审查只绑定实际source pins，不冒将来组合head。

### CI 测试可靠性续修

392的Windows job115796673057明确失败在两个既有共享测试：runtime foreground-refusal用5000次setImmediate轮询，在134ms内耗尽而非等待实际Run/持久化事件；environment-owner真实子进程与持久化审计case执行5607ms，超过默认5000ms。Luna已冻结两个test-only改动：foreground拒绝case等待真实Run promise与committed handoff事件，异常handoff立即失败并清理；真实跨进程租约审计case并行读三文件、只为该case设有限15s（约历史5.607s的2.7倍）。全部原行为断言保留，生产源码/全局或产品超时未改。Mac相关34文件650项及typecheck通过，Sol独跑两个完整文件190/190、diffcheck0放行；已提交/非force推送046019df3a333db7d85444244ac2423dab9d4e4f。不称本机Windows复现。

组合阶段把evaluator160项接入scripts/test.mjs标准Node测试列表；此前CI未执行这一套，不能仅用原72项声称F2回归已在CI覆盖。

### PR23 实际合并

PR23在独审160/160与同head CI38547248255五绿后，通过普通GitHub merge API合入PR22目标分支。实际merge SHA为 `8fd7c9dbc53d297e137b39efe70bd5bff2f9b6c5`，tree为 `80963600409c2dd7254a9a3d83a008490259d51c`，与Root预先git merge-tree的树逐字一致。fresh API核PR23 merged=true/closed、目标分支指向该merge；没有force或改base。046的中间CI不冒绿，旧392失败保留；随后所有合入内容按最终组合head重验，main仍未合并。

## 679 逐文件与行为映射

采用语义移植，不以679整commit祖先关系代替行为证明。原679及PR26引用保留；本候选包含以下有效增量，避免重引已退役profile：

| 文件 | 适配与保留 |
| --- | --- |
| packages/app-runtime/src/providers.ts | 纯builtin凭据检查与固定typed错误，构造器复用，不读ambient环境 |
| packages/app-runtime/src/run-factory.ts | 主模型/有效distinct layered risk资源分配前检查；保留finish Registry、tool presentation、operation guidance、closeConfirmation |
| packages/app-runtime/src/application-session.ts | 默认factory纯预检，注入Provider/Run factory豁免；保留逐项cleanup/ownerState |
| packages/app-runtime/src/remote-run-api.ts | 幂等结果/容量优先，新请求在token、discovery、commandId预留和Run之前固定409；保留预览错误合同 |
| packages/app-runtime/src/providers.test.ts | 固定凭据错误与不泄漏键值 |
| packages/app-runtime/src/run-factory.test.ts | 缺主/有效risk凭据零资源，off/same及注入factory兼容；原cleanup/guidance回归保留 |
| packages/app-runtime/src/application-session.test.ts | 纯检查无Run/资源、override与注入豁免 |
| packages/app-runtime/src/remote-run-api.test.ts | 迁到合法browser/auto/window；幂等优先、零discovery/allocation、token可复用，退役目标仍INVALID_TARGET且零preflight |
| apps/host/src/server.test.ts | 配对后固定typed409中文；原退役目标/隐私/preview断言保留 |
| apps/web/src/api.test.ts | 显示固定中文配置错误；原ownerState和退役列表/preview断言保留 |
| patches/cua-driver/d114f35-macos-sharing-control-after-f018.patch | native9，逐字与679相同 |
| patches/cua-driver/native9-source-chain.json | 9段来源闭合，逐字与679相同 |
| patches/cua-driver/d114f35-macos-foreground-oracle-diagnostic-after-native9.patch | native10，逐字与679相同 |
| patches/cua-driver/native10-diagnostic-source-chain.json | 10段来源闭合，逐字与679相同 |
| patches/cua-driver/d114f35-macos-foreground-oracle-risk-classification-after-native10.patch | native11，逐字与679相同 |
| patches/cua-driver/native11-diagnostic-r2-source-chain.json | 11段来源闭合，逐字与679相同，不当作已加载driver |

## 当前组合与外部 CI 阻塞

最终候选把MODE、上述679增量与evaluator标准测试入口纳入同一提交，尚需对这个实际head完成全仓/类型/Web/CLI和组合独审、同head必要CI。中间8fd的CI38548782845四组verify已success，`ci-required`未启动（runner_id=0、steps=[]）；GitHub注释明确账户近期付款失败或支出额度需要调整。046中间run38548701074已cancelled，不冒绿。已请账户负责人恢复Actions；不能以本地测试或四verify替代必要gate，不修改billing/支出设置、不跳过用户要求合main。

## 产品路线及真实验收

PR22 已移除公共 Web/API 的 native-recovery、native-web-document 两个实验起点及 Host profile 编排。最终路线以普通 Web 入口和现有 CLI 显式 URL、临时浏览器 profile、精确窗口配对、单文件授权分别说明；不将旧 594 的两个 Web 起点继续描述成最终候选已交付。Host/Web/Relay 混版校验风险需以同版发布解决，不在这轮离线修复中假称已部署。

代码合并不计 Astra 三线业务完成。T2 同 95b CLI L2 experiment/risk off 三轮限定通过保留；正常 Web/default-layered T2、T1/T3 完整业务、复验/变体、真人评分、实体手机 M1–M4、语音听感与 Preview 部署均各自留待实际证据。本轮没有新付费请求，A08 实际仍为零，历史 498 次请求及未知用量不清零。

## 证据入口

私有批次 `runs/astra-autonomous-20261010-sol-luna/prfix-merge-20261014-private/` 保存 fresh remote/review/check、隔离候选、精确 diff/SHA、测试 exit、独审、CI 及未来 merge receipt。原始私有运行数据、凭据和用户轨迹不提交。

最终进度仍在[总计划](./astra-three-track-master-plan-2026-10-10.md)与[自主计划](./astra-autonomous-test-repair-plan-2026-10-10.md)顶部同步；后续逐项以本轮实际结果更新本记录，不用“mergeable=clean”代替审查。

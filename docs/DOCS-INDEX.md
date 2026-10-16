# Computer Harness 文档索引

2026-10-16新六题启动准备：购物售后/家庭通信日程通过同一life-eval脚本显式选择独立suite，默认方舟`deepseek-v4.1-flash`、Batch关闭，B00/P10/M01/PM11控制Plan/Memory。各题从manifest指定官网开始，四题答复、两题WPS；不需登录Apple/iCloud。新key仅live读取指定私有变量，离线不读env，原九题及历史记录不改。见[六题与对照操作说明](./life-business-evaluation-2026-10-15.md#新六题方舟对照准备2026-10-16接续)。当前不调用API/GUI、不启动评测，实机预检及首次监督留今晚授权后完成。

2026-10-16 PR36接续完成：已合main `282ac6c`，[PR CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38897851567)与[main CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38898351528)均全绿，真实Ark基础API17项及完整2480项Vitest通过。三GUI动作同轮Batch两次未过并保留原记录；不替换Preview。PR35六题Windows适用性见[总报告末节](./life-business-eight-task-results-2026-10-16.md)，新suite脚本接入状态以上一段本轮记录为准；[Ark独立验收](./volcengine-ark-agent-plan-2026-10-16.md#最新main集成及独立api验收2026-10-16接续)保留协议通过与业务未测的区别。

## 火山方舟 Agent Plan 接入与 Windows 运行记录（2026-10-16）

[接入、使用说明与运行边界](./volcengine-ark-agent-plan-2026-10-16.md)、[脱敏结果 JSON](./volcengine-ark-agent-plan-2026-10-16.json)：新增独立 `deepseek-v4.1-flash`／`ARK_API_KEY` 渠道，保留官方 DeepSeek。记录接入 smoke、disabled 两轮未完整通过和 Run 级 low 两轮业务通过，保留失败、有限恢复和截图／DOM时序限制。产品默认仍 disabled；low 是样本 Run 级配置，不修改团队默认。新 PR 只集成适配及材料，未把既有 Windows 修复候选的实跑冒充新分支验收。
2026-10-16同伴更新复审：[原报告末节](./life-business-eight-task-results-2026-10-16.md)核对已合PR35的六张候选任务卡及PR36方舟渠道。当前五类15题，新增suite未接runner；Ark是独立API渠道不是Planning模块，目标仍为旧Preview，需在最新main集成、保留GLM回归覆盖后验证。低思考实跑为历史注入样本，不代表产品默认或当前main放行；本轮只读审查/写意见，未修改或合并同伴PR。

本批修复最新入口：[中文PR #33](https://github.com/wszkxlllll/Computer-Harness/pull/33)；修复head的[完整CI已通过](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38874655299)，PR自身检查与合入状态以PR实时结果为准。[详细报告](./life-business-eight-task-results-2026-10-16.md)已记录profile保存重开实机确认、三类CI根因及本机symlink权限限制。Preview未替换；本条优先于下方按时点保留的等待状态。

PR #33检查通过并已合main；合入后Windows又暴露共同测试等待器的固定次数轮询问题，补充分支`codex/ci-runtime-waits-20261016`集中修等待机制、同类GLM测试时钟及Relay fixture响应释放。Luna实施、Sol GO，根构建及2443项完整Vitest通过（本机限制并发4），不改生产Runtime/Provider/安全接口。补充PR及实际CI/合入结果通过PR #33关联说明查阅；不将原main失败隐去，Preview不变。

2026-10-16 当前：[八题结果及离线修复/Monitor验收](./life-business-eight-task-results-2026-10-16.md)。八题全桌面前台DeepSeek/B00已结束、跳过G03，T03额外尝试均保留；没有足够证据判完整业务通过。后续修窗口清单合同、取消记录及非阻断Monitor，shadow记录候选不发送，guidance只提示不拒绝/暂停；2432项测试及类型检查通过，尚未重跑或部署Preview。评测入口提交`c0e64f2`、Runtime提交`d2b03d2`，目标分支`codex/life-eval-ready-20261015`，按用户授权推送，不合main。旧冻结记录不回写，后续须新包；用户每天手动通知开始实机，不设自动提醒。此记录优先于下方历史状态。

推送后接续修复：layered Guard指引改为按公开schema决定是否填写`_harnessEffect`，消除list_windows额外参数歧义，保持Runtime校验/Guard准入不变；单独提交，Sol GO，完整回归及最终46项合同回归通过。详见同一报告末节，不另建分散文档。

最新接续：全桌面observe当前没有UIA/DOM目录，不能把hybrid配置当作该帧已有元素。旧启动页改为显式完成手动准备时同步当前标签，不动登录资料；runner超时改为IPC先请求正常取消，再有界强制兜底。Sol GO、构建及2440项Vitest/27项runner自测通过；真实重开/取消释放尚未实机验收，Preview不变。原CI的Windows CRLF测试问题已修，`0fd1e00`的[CI全部通过](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38868696849)。详细范围与后续提交状态见同一报告末节。

接续状态：用户已确认同一travel profile保存重开符合预期，两次准备正常关闭；真实业务取消释放仍未验收。窗口交接轮询、Relay监听端口冲突及DeepSeek超时自测混用时钟均仅修测试，Sol GO；2442项Vitest、构建/Web打包通过，最后三文件232项独立通过。本机Node评测器既有symlink fixture因权限EPERM未全绿，保留失败、不改安全测试；远端Windows完整Node261项已过，最后时钟修复的新head四矩阵仍须核对。用户授权远端CI通过后中文PR合main，Preview不变。当前合入结论以同一报告末节及对应PR实际检查为准。

2026-10-15 当前评测准备：[九题完整Goal](./life-business-task-cards-2026-10-15.md)、[静态标准答案（评分员）](./life-business-static-answer-key-2026-10-15.md)、[准备/评分/启动说明](./life-business-evaluation-2026-10-15.md)。以已合DeepSeek的main `6b1d6e2`为基底，在`codex/life-eval-ready-20261015`准备CLI输入策略与候选驱动冻结；不带入PR30后续网页改动、不替换Preview。另获授权的一次DeepSeek文本联通已通过HTTP200，用户已授权打开已有登录profile供手动检查；正式桌面评测仍等待授权和监督预检，不能用联通结果代替业务验收。

2026-10-15 [PR30拆分与队友接续](./pr30-deepseek-only-integration-2026-10-15.md)：仅提取DeepSeek注册、恢复及凭据预检；DOM/网页绑定、Context/Monitor后续改动留原PR30。新分支验收及CI完成后单独合入，不关闭PR30、不替换Preview，队友先同步最新main再接续整改。

2026-10-14 最新：33的Windows及两Ubuntu已绿；Mac gate焦点测试按实际useEffect生命周期窄修，保留手机focus合同，新head完整检查/CI后main。见[执行记录](./astra-prfix-merge-execution-2026-10-14.md)。

2026-10-14 接续：Actions已恢复，66实际Windows共享evaluator hook路径错误已定位，测试portable file URL修复/新head验证优先；详见[当前执行记录](./astra-prfix-merge-execution-2026-10-14.md)。

2026-10-14 优先执行：[两项修复、MODE回归与679语义适配及合并记录](./astra-prfix-merge-execution-2026-10-14.md)，[合并前审查](./astra-premerge-review-2026-10-14.md)、[集成专项复审](./astra-pr22-integration-review-2026-10-14.md)。PR23已合入PR22；main仍等待最终组合测试、CI与Sol独审。最终产品路线按两份Astra计划顶部说明，旧profile记录不作当前交付。

## 最新队友提交复审（2026-10-13）

最新检查补充：后续文档提交 `6e5b9ab` 的Windows CI有两项窗口恢复测试等待失败，已将三处同根因测试改为已提交事件同步，Runtime183项及完整Vitest2324项通过，Sol增量审查GO。没有生产代码修改，新提交远端CI待确认；见同一审计文档顶部，Preview不变。

[PR26 集成与有限解耦完成记录](./pr26-integration-audit-2026-10-11.md)：PR22 已吸收 PR26 `594fa8e`，保留PR28/修正后的PR29及无障碍基线，代码冻结 `aaac0f5`、交付 `b58cc4c`。Windows/macOS机制拆为四个私有模块，工具合同统一，公共实验入口隔离。完整Vitest **130文件2324/2324**、构建通过；Node自测71通过/0失败/1环境跳过；Sol两次复核GO，独立25项通过。[交付CI五项全绿](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38418800406)。本轮没有实机/API/部署或Preview切版；下一步是双端真实任务及手机验收。下方旧状态按历史保留，以本条为准。

## M01点击修复与真实GLM运行（2026-10-13）

[受管浏览器点击、UIA可见性修复与M01实跑](./member-c-m01-click-repair-2026-10-13.md)：Windows 实测通过用户手势、隐藏链接过滤、可见 Hyperlink 别名及未命名轮播箭头路径。完整修复后的 GLM Run 遇 Guard 审批边界被宿主取消，没有最终清单；不记 M01 业务成功或正式评分。源码、脱敏运行结果及原失败保留在同一成果中，没有全前台兜底、整机升级或附加发布验收。

## PR28 集成与无障碍源码交付（2026-10-13）

当前开发分支 `codex/runtime-surface-preview-20261003` 纳入 PR28 `06b5974`，保留网页无障碍独立提交 `a897fc6`；只合并文档索引冲突，没有覆盖 Web 源码。393 项定向测试、Web/CUA 类型检查、隔离 Web 构建及 Chrome 50/50 检查通过，JS/CSS 与原 Preview 一致。见[无障碍集成复验](./mobile-accessibility-experience-review-2026-10-08.md)顶部。Preview 不替换，PR26 保持整改待集成；下面“尚未提交”和旧部署阶段描述均以本条及各文档最新日期为准。

## PR26早期审查（历史，以顶部复审为准）

[PR26分级问题与整合门槛](./pr26-integration-audit-2026-10-11.md)：保留6c0af49阶段的失败、整改和Mac受限CLI证据；该阶段尚未整包合入的结论已由顶部集成完成记录覆盖。产品目标为Windows/macOS，成员分工不覆盖整个项目范围。

## 非视觉 Web 接入与原部署记录（2026-10-10）

[手机无障碍实施与验收](./mobile-accessibility-experience-review-2026-10-08.md)记录三线实施、审查与验证：连接／设置／导航、任务控制与动态通知、输入／选窗／截图；沿用真实 Run 与认证合同，不新增原生 App 或重做视觉风格。10 月 10 日完整 Web 227 项、类型检查、生产构建通过，独立 Sol 审查 GO；隔离 Chrome 50/50，真实 320 CSS 像素大字审批溢出已修并复测。已 Web-only 发布独立 Preview `2026-10-10-web-accessibility-v1`，无服务重启、已有配对保留，公网产物哈希核对通过；[发布与使用步骤](./voice-preview-deploy-phone-test-2026-09-29.md)已更新。源码 10 月 13 日已整理为独立提交并完成集成复验；iPhone VoiceOver／语音控制及独立非视觉使用仍待真机验收，截图才能确认的歧义候选仍明确限制。
## 成员C材料与D01阶段成果（2026-10-12更新）

[任务1与任务2统一成果入口](./member-c-results-2026-10-11/README.md)：已有轨迹分类、重复关系与四类材料；医疗、缴费/社区两域公开入口＋本地准备冻结合同；Windows候选阶段记录。新增[CP02生产修复与六项来源/初态续核](./member-c-results-2026-10-11/windows-preflight-2026-10-12.md)：两步tsc/53项浏览器测试与真实DOM回归通过，六个开发实例来源和新输出初态已核；原失败与构建未知保留。候选带本地修复须重新冻结，GLM实跑已暂停，0新模型Run/评分/D02；不混入evaluator PR#23/#27，不用材料或观察代替业务demo验收。


## 当前体验优化与上游跟进（2026-10-09）

PR #25完整历史与手机体验改动已集成PR #22；源码head `d2ee1a3`对应四矩阵CI及ci-required全绿（run `37946804774`），没有合并main或改写作者。Node24／固定pnpm 11.19.0根build、Web build、Node自测70通过／0失败／1项本机符号链接能力跳过。Vitest 1841/1843，剩余两项CLI窄屏长中文分页5秒超时；未改timeout，不称本机全绿。独立Preview现为release `2026-10-09-pr22-d2ee1a3-v2`；本机Host 4318 `/connect`、`/api/local/session` 200且Relay WSS已建立。尚未做手机配对或业务Run。受管浏览器100%／125%GUI缩放未验收：隔离node_repl缺Node `process`全局，错误发生于SDK加载前，没有启动Edge窗口；不是产品回归。详情见[统一修复记录](./window-popup-regression-2026-10-04.md)顶部。

字段补查发现手机端`updatedAt`无真实Host生产者，已按用户要求移除字段及展示／朗读／模拟数据；定向复核和Web回归195项通过。4335曾短期开启只读模拟预览，截至后续核验无监听；当前综合版本已部署至独立Preview v2。详见下方手机体验记录第5节。

[手机端适老化与无障碍体验审查、实施记录](./mobile-accessibility-experience-review-2026-10-08.md)：保留现有布局，收敛输入、状态、审批、结果重听、连接恢复和字号重排；单独Web回归195项、隔离浏览器检查74项通过，综合版本现已部署但尚未重新配对验收。最新[部署记录](./voice-preview-deploy-phone-test-2026-09-29.md)列出v2 asset、4318 Host及重新扫码步骤。CUA #4836当前已Ready，真实记事本最小验收通过；官方矩阵shared通过、native有光标超时，整轮不是全绿。另有Draft替代提案#4901，尚缺Windows实机证据；路线区别与保留基线的判断见[统一修复记录](./window-popup-regression-2026-10-04.md)。

2026-10-12 队友历史核对：[目录、源码与实际成果验证](./astra-local-directory-verification-2026-10-12.md)。当时 e7bce7f；T2 CLI 实验模式三轮已限定通过，旧 F1–F4 已修；正常 Web/default Host、T1/T3 及手机/部署出口分别保留。本条不是当前集成版本或本轮实机验收。

## 使用、构建与许可

[项目概览与手机体验说明](../README.md)注明公共 Demo Relay 尚未开放，并提供 Windows 本机 Host 启动前置、平台状态、安全边界和许可入口；[开发者上手](./getting-started.md)补充模型、CUA、OSWorld和排错步骤。项目许可见根目录[LICENSE](../LICENSE)，直接依赖与 CUA notices 见[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 当前交接主线

**2026-10-09 PR25与手机体验集成**：[受管Edge窗口几何修复与跨应用结果](./edge-window-geometry-verification-2026-10-08.md)的完整历史已正常合入PR #22，merge commit `85e74d8`；综合源码head `d2ee1a3`的四矩阵CI通过，隔离Preview v2已部署。窗口绑定改用可信CDP指标，移除可伪造DPR身份来源，DOM坐标合同不变；手机端收敛和孤立`updatedAt`移除也已包含。部署Host 4318连接与WSS边界通过，不表示手机已扫码或Run业务验收。保留本机两项TUI 5秒超时和GUI zoom未验收的准确边界；文档保留原作者跨应用成功、UIA多行失败与unknown及健康报告事实偏差，不将旧实机证据重计为新版本全面验收。

**同日最新进展（2026-10-07）**：用户手机携程→记事本任务通过只读截图／实际文件验收，25请求、229.092秒，请求等待176.776秒；后续没有盲删必要恢复步骤。Context／预览增量源码`d840000c`全仓1817/1817，已更新本机Host；服务器Relay/Web和候选CUA不变，手机需重新配对。使用与版本矩阵见[部署记录](./voice-preview-deploy-phone-test-2026-09-29.md)，效果／边界与Demo录制安排见[统一收尾](./window-popup-regression-2026-10-04.md)。[项目材料](./project-materials.md)第7节补入AIC正式要求与提前准备，明确开放成果不等于必须无限免费公网控制。

**当前状态（2026-10-07 部署后）**：PR #22 源码 `a9464d4` 已推送、四矩阵 CI 与 `ci-required` 通过；统一构建及 Vitest 1809/1809 通过。候选 CUA 的整桌面空白输入／文末追加、真实 GLM 保存任务全文读回和 Edge 单行回归通过。Preview Relay/Web 与本机 4318 候选 Host 已部署，手机重新扫码连接 8443；稳定入口、默认 driver 和原登录状态保留。使用方法、候选下载及回退见[Preview 部署记录](./voice-preview-deploy-phone-test-2026-09-29.md)，证据与未验收范围见[统一收尾](./window-popup-regression-2026-10-04.md)。部署阶段只检查连接／配对边界，没有重跑跨 APP 业务或手机播音验收。

### 本轮演进记录（按时点保留）

下方部署前“未替换／未部署／输入未放行”等结论保留作失败调查证据，以本节顶部的部署后状态为准，不作为新的实施指令。

2026-10-07 独立只读复核已补入[现有弹窗、候选与输入审计](./popup-recovery-contract-review-2026-10-04.md)：最近3ms候选一次91码点输入从索引60起稳定损坏，原轨迹/截图/全文读回一致；另识别partial列窗使绑定Surface进入恢复死路、手机源码与本地bundle不同步及控制回执跨Run静态风险。报告区分当前源码、构建、默认驱动和隔离候选，给出单变量最小实验与优先级；未运行测试、未操作桌面，不以历史GO放行整体Demo。

队友新 PR 审查：[PR #24 macOS 与共享 Runtime 改善审查（2026-10-06）](./pr24-macos-hardening-review-2026-10-06.md)。预算、终态和控件状态有改善；stock CUA 的增强能力协商、全局 inventory 硬门槛、实际弹窗恢复及与 #22 的输入语义取舍仍需整改，不能把原生两图只读正控视为生产跨应用验收。

**当前修复与收尾入口**：[手机实机弹窗、输入回归与整改](./window-popup-regression-2026-10-04.md)。2026-10-06 携程→记事本报告的窗口/UIA链路已走通；整屏WPS副本正文、四号字体与保存已验证，窗口WPS路径仍失败，初始新建身份未充分核验。2026-10-07 自有fork Windows CI编译通过，但一次事务内逐码点3ms候选仍发生真实文本损坏，未升级默认版本；独立逐码点RPC虽正确但过慢，输入修复仍未放行。未知输入前缀消费者历史Node24回归1764/1764通过；手机截图、候选、终态恢复与可选操作指导正在统一增量验收。新源码尚未部署，不把分项通过推广为所有弹窗、前台输入或手机实机通过。

本轮冻结源码统一构建及 Node24 回归1793/1793通过，Sol独立增量16/16通过。用户暂缓完整任务，允许输入与浏览器启动短步骤实测；整屏多行输入的原生身份获取缺口仍需处理。源码通过、当前Preview和实机结果继续分开记录。

最新进展：同生产0.22.2的20ms候选短测试及真实Edge单行通过，Harness私有前台多行profile接通、构建与Sol审查通过，全量1798/1798绿。但最新正常GLM携程→记事本录像Run虽终态成功、文件已保存，390字符正文真实读回仍错字／缺字，输入验收不通过。已转入同真实长文本受控对照；默认服务与Preview未替换。任务约288秒，20次请求等待约226秒，效率与手机体验也继续验收。当前交付仍以**前台输入、Demo效率、手机体验**三项真实结果为准，详见收尾入口；短测试通过不能替代业务全文正确。

**最新验收（2026-10-07）**：候选驱动的整桌面空白输入、已有正文后原生Enter＋中文追加＋Y均读回精确；私有Edge地址栏／单行输入回归通过。真实GLM＋Harness本地保存任务完成，实际新文件431字符逐字正确，10请求、9动作尝试（7 completed／2 unknown，均保留并新观察恢复）、194.243秒，其中请求等待165.285秒。原CLI因测试题起点错误套用browser规则而假失败，历史报告不改，独立复核通过。未重跑携程／跨APP，不宣称任意选区编辑、富文本或其他应用全部修复。默认服务及Preview未替换，已正常关闭本轮新隔离daemon；原配置、登录状态与用户文件保留。

配套源码集中审查GO；类型构建、Vitest1809/1809及额外Node脚本70通过／1环境跳过。Qwen Catalog修复180字符截断导致的语义丢失，Context统一消费ToolRegistry说明，稳定系统前缀保持。预览2MiB raw／3MiB wire及真实大PNG本地fixture通过；真实CUA同名弹窗可辨认性与手机TTS不冒充验收。候选来源、录像、原始失败和全部复核证据仍集中在上述[收尾入口](./window-popup-regression-2026-10-04.md)，不新增独立路线。

本轮独立审查：[弹窗恢复、候选刷新与输入合同审查](./popup-recovery-contract-review-2026-10-04.md)。记录代码范围、独立测试与未实测项；未知动作保留事实、不重放，恢复必须使用新观察。源码 GO 不等于真实任务成功。

历史窄路径证据：[窗口与中途播报修复（2026-10-04 早期）](./window-and-progress-repair-results-2026-10-04.md)。保留记事本菜单返回、WPS 列窗切换和播报样本，不作为本轮完整任务验收。历史失败诊断见[携程→记事本轨迹](./travel-window-and-speech-diagnosis-2026-10-03.md)，用户已确认开始/取消有声音，缺的是中途播报，不是完全静音。

历史跨窗口进度：[平台进度同步（2026-10-03）](./platform-cross-window-status-2026-10-03.md)。PR #21 合并及早期CI、隔离Preview记录保留；当前Windows/macOS源码集成、部署与实机状态分别以顶部交付记录为准。
队友 main 整合记录：[Mac 与 Runtime Surface 兼容审查](./macos-runtime-surface-integration-2026-10-03.md)。保留整合版本、冲突取舍、离线与 Windows 实机验收边界及 main 合并结果；本轮再整合后的状态以顶部收尾入口为准。

A 线三聊天协作：[修复、实机测试与远端审查入口](./a-line-three-thread-coordination-2026-10-03.md)。聊天（8）负责修复、（10）负责实机测试、（6）负责远端代码更新和审查；当前共用同一 Git 分支，提交与运行版本切换须串行协调。

A 线双聊天协作：[修复与实机测试同步](./a-line-collaboration-sync-2026-10-03.md)。修复聊天维护代码与交付，测试聊天维护实际运行版本、问题和复验；共享事件记录及关键节点消息。

A 线本轮修复：[P0 输入焦点、DOM 指纹与工具合同修复](./a-line-p0-focus-fingerprint-fix-2026-10-03.md)。区分代码/离线回归与真实 Mac 验收，实际部署状态及放行门槛以该记录为准。

A 线当前总览：[2026-10-03 进度复核与优化方向](./a-line-progress-review-2026-10-03.md)。基本链路与简单任务已有通过证据，完整 T1 仍受焦点/DOM 问题阻塞；T2/T3 未完成验收。优先验证输入与指纹一致性，再完成核心任务与性能收口；下列历史记录不代表当前全部通过。

Surface Registry 与 Windows transient-child 当前交接：[Surface Registry 队友交接](./surface-registry-team-handoff-2026-10-03.md)。集中记录稳定 ComputerSession/Surface 谱系、Windows relationship probe 与权威合并、menu/dialog/overlay 准入、多行自动 element binding、跨平台队友边界和细粒度 PR 切片。最终冻结源码定向 254/254、全量 105 文件/1271 tests 通过；Notepad menu bounded runner 的 `child_push`/`child_pop` 已实机通过，Open dialog 与 WPS 独立 dialog/menu 仍为 pending。

多行输入早期调查：[多行输入修复与 Provider 验证记录](./multiline-type-implementation-results-2026-10-03.md)。保留受控诊断和当时的 Provider 问题；最新记事本完整 GLM Run、非空追加语义及平台回归以本轮收尾入口为准。

多行上游 Issue/PR 开展前的调研与候选方案见[历史计划](./cua-upstream-multiline-issue-pr-plan-2026-10-03.md)；其 main SHA、batching 候选和当时的“尚未实测”只代表记录时点，不是当前 PR 状态。

跨窗口：[已批准实施方案](./cross-window-execution-plan-2026-10-02.md)、[代码、独立审查与验证记录](./cross-window-implementation-and-validation-2026-10-02.md)。四种起点保持；单一逐 Run `switchWindows` 默认关闭，用户 opt-in 后模型从 Host 授权目录调用 `list_windows` / `switch_window`，desktop 起点也支持。managed-browser 初始目标和显式 companion 共用生命周期；手机 profile setup 为“手机发起、电脑可见 Edge 手动登录、手机确认完成”。定向离线测试与代码审查通过；此前合成 Provider API 有三组成功、一组 Qwen recent 信封失败；两轮真实 SDK scripted browser↔WPS 往返与网页 DOM 恢复通过。没有完整真实模型生活任务验收，本轮后未再启动 API/桌面任务；新 Web/Host/Relay 源码尚未部署公开页面，稳定服务未改。

待人工预检：[三个跨窗口生活任务卡](./cross-window-life-task-cards-2026-10-02.md)：社区通知整理、敬老卡办事明白纸、长者出行准备单，含完整 Goal、应用准备及验收点；尚未执行，不替代原六类场景范围。

本轮可靠性修复：[试点可靠性与阶段交付修复（2026-10-01）](./pilot-reliability-and-delivery-fixes-2026-10-01.md)。记录通用 Context 指导、分层程序运行证据、CUA 有界观察恢复、离线验证边界及后续试点 100/100 默认预算；未重跑历史试点。

项目材料：[项目说明、技术与开放边界、真实场景及待补内容](./project-materials.md)。集中整理可复用的内容和证据入口，沿用原定六类生活场景，不另设详细分工或比赛开发路线。

历史接入：[手机自动选窗与受管浏览器接入（2026-09-27）](./mobile-target-modes-2026-09-27.md)。该记录保留当时 798 项测试及既有部署证据；它早于本轮 `switchWindows` 和 profile settings 新合同，不作为当前四种起点/跨应用开关/Profile API 的说明。

常用网站入口：[URL 选择器实施记录](./common-site-url-picker-implementation-2026-10-02.md)。Web 可选注入带标签的 URL 目录，默认空；选择只填入现有起始网址字段并须明确提交，浏览器 saved/temporary 默认值在设置中管理。

下一阶段完整待办与分工入口：[产品开发、验证与稳定 Demo 清单](./product-next-stage-task-list-2026-09-27.md)。覆盖桌面执行、手机/语音、个性化、Guard、Windows/macOS、现有模块优化、评测发布及后续研究；第11节为可认领任务全集，第12节为认领规则。分工尚待用户确认。

语音阶段 A+B1 实施记录：[语音合同、运行通知与 Host/Web 播报](./voice-streaming-and-notices-implementation-2026-09-28.md)。Host/RemoteRunAPI 可选投影最小 `run.notice` SSE 事件，手机显式开启后，新 Run 可朗读结构化中文审批提示、已验证 milestone 摘要、问题和结果；过期审批、SSE 重放、旧快照与敏感正文均有降级边界。Web 使用可替换的 Browser `speechSynthesis` 输出并固定请求普通话，真实云端 TTS 尚未接入。阶段 B2 已实现手机录音、Host 流式 ASR 会话与 Qwen Provider，mock、真实短探针和手机链路仍需按实施记录继续验收：[阶段 B2 实施记录](./voice-recording-b2-implementation-2026-09-29.md)。

历史语音部署与手机测试入口：[隔离部署记录](./voice-preview-deploy-phone-test-2026-09-29.md)。该记录保留当时的隔离部署、基础检查和手机测试状态；不作为当前 Quick Start 或稳定服务状态说明。

P1 助手回答偏好实施记录：[版本化 Run 快照与 Context 投影](./assistant-preferences-p1-implementation-2026-09-29.md)。代码闭环和离线合同测试已完成；真实模型行为与手机真机无障碍尚未验收。

受控真实 API 验证：[ObservationAssessment 与助手偏好](./semantic-assessment-and-preferences-real-api-validation-2026-09-29.md)。GLM/Qwen 共发起四次合成请求；Qwen assessment 经 Monitor/Context 消费，GLM 简中偏好有单次正向样本，Qwen 个性化选择 `wait` 且 assessment 与 unchanged transition 冲突。终端汇总截断了部分逐项指标，报告明确保留该证据限制。

ObservationAssessment wire schema 与 producer 指令实测：[GLM 真实 API 探针记录](./observation-assessment-live-probe-2026-10-04.md)。`progress` 现要求显式 object/null，解析器兼容旧缺字段响应；最终提示轮中 Notepad milestone 经 RunNoticeProjector/Scheduler 消费，Ctrip 正确结果图仍未返回外层 annotation。共 6 次受限真实请求；样本选择校正、隐私边界与尚未证实的物理播报详见报告。

当前交付：[手机 App 式界面与审批修复](./mobile-accessible-ui-implementation-2026-09-26.md)。已按成熟 App 参考重做实际界面；756 项测试通过，最终小屏裁切已修复并重建。2026-09-27 已部署公网 Web、启动新版本机 Host 并验证配对注册；未完成手机读屏及真实任务验收。

下一阶段 A 线入口：[通过真实任务完善产品](./a-line-runtime-delivery-plan-2026-09-27.md)。先在实际设备体验查询、文件保存和跨应用纠正三类任务，再修阻塞并补必要功能；完整配置、偏好和 Guard 策略不再列为必做，旧 B 实验保留为参考。

A 线最新性能结论：[性能与结构审计](./a-line-performance-architecture-audit-2026-09-29.md)。真实简单网页任务的主要耗时在模型往返而非 Relay 或本机动作，优化顺序为 GLM 请求合同与观测、减少回合、任务级工具裁剪、受管浏览器快速路径、Context/图片和流式反馈。

A 线最近一次失败复核：[运行失败审查](./a-line-run-failure-audit-2026-10-01.md)。本次运行已成功打开 CUA 并执行多次动作，最终因 GLM 响应达到 `max_tokens` 而失败；同时运行目标被误记录为错误提示文本，不能作为有效 A 线任务验收。

A 线最近一次成功链路核查：[搜索任务全链路核查](./a-line-search-run-chain-check-2026-10-01.md)。手机、Relay、Host、CUA、GLM 和网页搜索均成功，但仍有 3 次 DOM 引用失效及 4 次风险审批，后续应优先优化这两处体验。

A 线风险控制修正：[搜索误审批修正](./a-line-risk-control-search-fix-2026-10-01.md)。已为明确的只读搜索提交增加窄范围本地放行，并保留订单、付款、发送、删除等高风险审批；代码测试已通过，待手机实机复测。

A 线长任务预算优化：[长任务预算与收敛优化审计](./a-line-long-run-budget-optimization-2026-10-01.md)。最近一次复杂任务的风险检查和 GUI 动作均成功，但因 Host 固定 24 次模型请求上限耗尽；本轮提高上限并增加安全可配置入口，监控仍保持非阻断模式。

A 线地址栏导航修正：[地址栏导航误审批修正](./a-line-url-navigation-risk-fix-2026-10-01.md)。最近一次失败由地址栏回车中的“提交”措辞触发语义审查超时；新增仅限地址栏 URL 导航的窄放行，普通提交和高风险 URL 继续受 Guard 保护。

A 线长任务重试结果：[长任务重试审查](./a-line-long-run-retry-audit-2026-10-01.md)。地址栏放行已在真实任务中生效；本次失败转为 48 回合预算耗尽，主要问题是 DOM 引用过期、重复滚动和缺少收尾回合。

A 线 100 请求上限重试结果：[100 请求上限重试审查](./a-line-long-run-100-request-retry-audit-2026-10-01.md)。100 次上限没有被耗尽；本次在第 44 次请求期间由配对设备中止，主要问题转为网页输入焦点错位、DOM 引用过期和恢复回合过多。

A 线开工前 Mac 验收：[macOS 本机预检](./macos-a-line-preflight-2026-09-27.md)。代码、窗口级截图、Mac 辅助窗口过滤、临时受管浏览器、本机合成配对和普通 TextEdit 输入已通过；保存弹窗已加严格焦点拒绝与显式交接边界，实体手机控制待验收。

Windows 兼容复核：[Windows 兼容工作完整复核](./windows-compatibility-audit-2026-10-01.md)。当前审查在 macOS 完成；Windows 默认 Edge、profile/进程树、精确 HWND、PowerShell 清理和离线回归已覆盖，但 Windows 真机 CUA/Edge/UIA/DPI/多窗口验收仍未完成，不能把 Mac 成功当作 Windows 放行证据。

A 线推送说明：[A 线阶段改动推送说明](./a-line-delivery-note-2026-10-01.md)。汇总本次运行时、受管浏览器、风险控制、手机反馈、测试结果和 Windows 实机验收清单。

本机目录与私有配置：[项目本机文件整理记录](./project-local-files-organization-2026-09-28.md)。桌面仓库是唯一项目目录；Relay 配置、运行证据和旧空壳工作区元数据已归档到仓库内，SSH 私钥与应用缓存按安全边界保留在系统目录。

设计依据：[手机与电脑 App 式界面实施依据](./app-ui-design-proposal-2026-09-26.md)。电脑仅连接管理，手机采用任务/图片/设置的成熟交互；旧概念图不作验收依据。

历史实机失败复核：[手机真实任务的点击后前台失配与审批循环](./mobile-real-run-audit-2026-09-26.md)。保留输入成功/发送未执行的原始结论；审批循环已进行代码修复但未实机复测，点击失配仍未修复。

最新部署与 CI 复核：[手机 staging 进度、失败归因及修复顺序](./mobile-staging-ci-audit-2026-09-26.md)。公网安卓测试使用模拟执行后端，不能替代 Windows 实机验收。

部署历史：[修复、独立公网检查与部署状态](./mobile-staging-fixes-2026-09-26.md)。包含此前 staging 复验命令和回滚证据。PR #15 已合并，修复 head `4215599` 的CI全通过；当前 Web 部署与真实验收缺口以手机 App 式界面实施记录为准。

新成员从以下五份主文档接手；源码与测试共同维护当前事实。

1. [项目目标、状态与问题](./PROJECT-HANDOFF.md)
2. [架构与公共装配接口](./ARCHITECTURE-AND-COMPOSITION.md)
3. [Runtime、事件与安全合同](./RUNTIME-AND-SAFETY-CONTRACTS.md)
4. [模块实现与能力边界](./MODULES-AND-CAPABILITY-STATUS.md)
5. [开发、运维与验证](./OPERATIONS-TESTING-AND-REMOTE-CONTROL.md)

## 当前操作、评测与验证专题

- 购物售后与通信日程（2026-10-16）：[六题任务卡与独立来源预检](./life-business-shopping-communication-preflight-2026-10-16.md)；独立manifest、runner选择及待GUI验收边界见[套件说明](../eval/life-business-shopping-communication-20261016/README.md)。不属于原八题运行记录。

- 入门与本机启动：[开发者上手](./getting-started.md)、[本地启动器](./local-launcher.md)。
- SDK 与模块装配：[Run SDK 示例](./sdk-run-composition.md)、[Planning / Run Memory 组合](./pi-module-composition-2026-09-23.md)。
- 手机控制：[快速操作指南](./mobile-control-guide-2026-09-26.md)、[技术与测试报告](./mobile-control-technical-report-2026-09-26.md)、[独立审查](./mobile-control-review-2026-09-26.md)、[问题与验收边界](./mobile-control-issues-2026-09-26.md)。
- 实机验收：[窗口与出行验收清单](./deferred-live-window-acceptance-2026-09-26.md)、[CUA 坐标与输入诊断](./cua-coordinate-diagnosis-2026-09-26.md)。受控诊断入口为 `../scripts/cua-type-text-smoke.mjs`、`../scripts/cua-window-capture-probe.mjs`、`../scripts/cua-window-handoff-probe.mjs`；执行前须阅读各自 help 并取得桌面测试授权。
- 政务与出行评测：[上海真实 Harness 试点与入口预检](./shanghai-government-travel-pilot-2026-10-01.md)。旧批次17个终态Run/10道原题的成绩不变；新增2026-10-02只读预检：SG01–SG04公开资料可读，SG05官方普通身份证办点已核实、公交链仍待验证，不当作新实机通过。历史准备：[试点准备](./travel-pilot-preparation-2026-09-20.md)、[任务卡与反馈表](./travel-task-cards-and-feedback.md)。
- 政务与公共服务候选任务：[任务卡](./government-task-cards.md)（[candidate manifest](../eval/government/government-candidate-manifest.v0.json)）。来源为 PR #18（Yao GX / @Tangs-mo）；该 PR 说明政务域已交接。当前是未验证设计草稿，不作为活动题库或评测成绩证据。
- 生活缴费与就医候选任务（PR #18，Yao GX / @Tangs-mo）：[社区缴费 C01–C10 宽集草稿](./community-payment-task-cards.md)（[manifest](../eval/candidates/community-payment/community-payment-candidate-manifest.v0.json)）；D01 精选的社区 CP01–CP03 与就医 M01–M03 共六族，见[社区任务卡](./community-payment-d01-task-cards.md)（[manifest](../eval/candidates/community-payment/community-payment-d01-manifest.v0.json)）和[就医任务卡](./medical-care-d01-task-cards.md)（[manifest](../eval/candidates/medical/medical-d01-manifest.v0.json)）。全部是未验证候选，不是活动题库或成绩；D01 是宽集的精选子集，不能与 C01–C10 当作独立样本。
- OSWorld 与候选集：[环境说明](./osworld-environment-implementation.md)、[复现说明](./stage-5-osworld-reproducibility.md)、[G0 预检进度](./g0-preflight-progress-2026-09-10.md)、[候选任务清单](./harness-development-validation-candidates-2026-09-10.json)。
- [开发文档规范](./development-documentation-standard.md)约束入口、证据和历史材料的维护方式。
- [本地缺陷复现探针](./verification/audit-39ff27f9-local-probes.mjs)作为独立验证工具保留。

## 历史证据

当前三线执行入口：[统一六批计划](./three-track-execution-plan-2026-10-06.md)、[隔离整合取舍](./three-track-integration-decisions-2026-10-06.md)、[预算与HTTP关联交付](./a-line-sync/fixes/F-20261006-002.md)。原A线独立队列停用，历史证据保留；新版离线通过不等于已经部署或实机通过。

本轮本地冻结：[批次0/1部署单](./three-track-batch01-deployment-2026-10-06.md)。仅预算与请求关联候选离线放行，实机签收待测试方记录。

- [2026-09-26 首页改版前存档](./history/2026-09-26-readme-before-refresh.md)：保留旧首页的参数与阶段记录，当前使用入口以根 README 和专题指南为准。
- [2026-09-26 交接收敛归档与迁移索引](./history/2026-09-26-handoff-convergence/README.md)：记录旧阶段文档和一次性实验脚本的原路径、新路径、归档理由与恢复方式。
- [2026-09-17 路线整合归档](./history/2026-09-17-roadmap-consolidation/README.md)：旧设计、审计、实验结论及外部审计包。

历史报告中的“当前”“下一步”和命令只代表记录时点；当前执行顺序、验证事实和能力承诺以上述五份主文档及当前源码为准。

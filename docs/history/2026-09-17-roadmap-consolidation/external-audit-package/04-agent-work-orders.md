# 给开发 Agent 的实施工单

## 使用方式

一次只派发一个工单。先核对目标仓库提交是否仍为 `39ff27f9a4ef5431450df6991793403ec890f993`；若已变化，先重新定位相应函数与测试，记录哪些结论已被修复。不要直接对过期行号打补丁。

通用执行要求：先读 AGENTS.md、当前阶段入口和本次审计文档。输出“现状证据 → 新增失败测试 → 最小实现 → 实际验证 → 剩余限制”。没有授权不调用付费模型、不连接真实桌面、不修改远端权限。每个 PR 写清实际执行的命令，不把作者历史测试算成本次通过。中文文件按 UTF-8 读回。

## W01：基线与 CI

**输入：**方案 03、模板目录。**范围：**.github、测试脚本配置、文档；不改业务语义。

建立 Linux/Windows 上的 typecheck/Vitest/CLI help 检查。确认 `pnpm@11.19.0`、当前 lockfile、CUA optional native packages 的安装行为。工作流不传模型 key、不运行 probes/live desktop。第一次 runner 失败允许调整环境，但不得静默跳过测试。报告当前有效测试数、失败数和各平台差异。

**验收：**PR 状态可见；稳定的 ci-required 名称；依赖锁无漂移；没有 runs/ 或凭据 artifact；本机与 CI 命令一致。分支保护的设置变更另行申请授权。

## W02：修 Context 用户输入裁剪（F02/F05 的最小部分）

**输入：**方案 01 F02/F05、提取复现。**范围：**context 和对应合同测试。

先用真实 `DefaultContextCompiler` 写一个 maxInputTokens 紧张、有旧 goal 和后期禁止提交纠正的测试。确认当前纠正会丢失，再把 authoritative user inputs 与可裁剪 trajectory 分离。保证完整 tool-call/result 组，单个超大结果有明确策略，固定区不足显式失败。

**禁止：**靠强制 memory_write 保存用户要求；用额外模型总结替代确定性修复；只加 prompt 文案；顺便改 Provider wire。

**验收：**纠正和最新截图保持；工具结果配对；超预算没有偷偷发请求；旧 Context fixture 的变化有解释而非一键更新全部快照。

## W03：补齐 Memory mutation 校验（F03）

**范围：**run-controller 校验、Memory 工具和测试，必要时纯 mutation visitor。

给新建、同值更新、异值 replacement、Planning disabled 分别构造合法/非法 relatedTaskIds。覆盖真实执行路径。统一校验所有引入内容的 mutation；引用失败前不得 supersede 或写事件。补 subject/entity 引用与输入长度的对称校验。

**验收：**replacement 无旁路；旧事实保持；文件状态与事件 replay 一致；未来新增 mutation 要显式处理。不要在本 PR 引入完整 scope 层级体系。

## W04：实机默认风险与诊断隐私（F04/F06）

**范围：**app config、CLI 诊断、risk 默认、测试和文档。

让交互实机 profile 与实验 profile 分离；TUI 的默认风险状态显式且可见。对 native tool_calls 与 strict calls 统一脱敏，递归处理参数中的合成敏感标记；默认只输出诊断 allowlist。保留本地事件与可分享日志的不同数据合同。

**验收：**相同 type(text) 不因 Provider 协议不同而泄漏；key/header/body 不出现在公开输出；headless 消融依然能显式关闭 Guard；用户关闭保护有明确交互说明。

## W05：有界清理和 unknown outcome（F07）

**范围：**CUA lifecycle、Runtime cleanup、Fake fault tests。

保留现有 GUI 不自动重试及 outcome_unknown 终止。引入总 cleanup deadline，检查每个 awaited call，而不是只限制 sleep。记录 Run-owned daemon/connection ownership；不能 kill 非本 Run 拥有的进程。

**验收：**endSession/shutdown 永不返回时退出有界；未知副作用不被改写成 cancelled；controller/TUI 不无限等待；未执行后续动作保持未执行。

## W06：抽 app-runtime 与事件订阅（F12/F13）

**范围：**新组装包、CLI、Runtime 只读订阅接口、测试。

先移动配置、工厂、日志、目录，不改 loop。事件广播必须发生在持久化/投影之后；listener 报错不传播为执行失败。消费者支持 afterSequence 或拿当前快照恢复。TUI 热刷新不再获取整段 events。

**验收：**原 CLI fixture 的语义轨迹不变；两个连续 Run 使用不同目录；UI 崩溃后事件仍完整；没有具体 Driver/UI import 进入 Runtime。

## W07：CUA doctor 和目标合同（F01/F15）

**输入：**方案 02、0.22.2 上游支持矩阵、现有 probe。

先实现只读 doctor，再以专用 fixture 验证 target handle、session generation、geometry/focus。记录“不支持/未验证”而非假 true。审批等待期间的目标变化必须使候选失效。不要单纯更新 basedOn 让旧动作通过。

**禁止：**升级 SDK 同时重构所有动作；默认接已有浏览器登录 profile；raw callTool 暴露给模型；background 不支持时静默 foreground；把截图 hash 不同直接当作业务失败。

**验收：**切到 TUI、移动目标窗口、审批后表单变化、daemon 重连句柄失效各有真实 fixture 证据。没有这些证据，不宣称敏感实机动作放行。

## W08：micro-batch 条件与产品 TUI（F09/F12）

先修 `click/Ctrl+A/type` 的焦点条件与可恢复范围；使用可获取的独立焦点/控件信号，没有就限制场景。明确当前每个子动作已有截图，不是从零加 screenshot。

产品 TUI 用共用 app-runtime，先 Fake 后 CUA。实现审批候选展示、过期状态、人工接管 quiesce、Abort、输入净化、中文/粘贴与异常恢复。不要让 UI 自己驱动 CUA。

**验收：**模型动作不会在用户向 TUI 输入时打进终端；旧批次/审批不会跨 revision 复用；输入落空时不继续敏感 typing；UI与事件重放状态一致。

## W09：可解释 Context 与实验（F10/F11/F16）

提供版本化 ContextTrace 与 run manifest，记录选择/裁剪原因和 Provider presentation。把 runtime 结束、模型声明和外部 evaluator 分开。加入同 Provider 固定预算下的 recent-only/Memory 对照，必要时普通摘要对照。

**禁止：**宣称离线替换 prompt 后复用旧环境轨迹即可证明任务成功；默认记录/上传完整敏感 prompt；以增加 Memory 字段数作为完成指标。

**验收：**一个失败样本能定位被挤掉的 history 和召回 Memory；实际 token/延迟可比较；报告分子分母和不确定性；所有重放/反事实结论有准确边界。

## W10：Monitor shadow 与行为保持拆分（F13/F17）

按方案 03 拆大文件，但行为迁移 PR 与 Monitor 干预 PR 分开。Monitor 先复用离线重复签名，产生候选记录，不执行强制 Plan。使用 shadow 数据标注正常探索、重复无变化、页面循环、慢加载，评估误报后再开 guidance。

**验收：**shadow 开关不会改变模型输入/动作；阈值只在开发集选择；正式开启后有 cooldown/预算与误报统计；缺失 Plan/Memory 信号不当失败。

## 最终交付格式

每份实施结果包含：基线和修改后 commit；受影响文件；新增反例；真实执行命令和结果；未执行的 API/桌面测试；行为是否变化；回滚方式；审计 F 编号的关闭/保留状态。只写“测试通过”“已增强安全性”“架构更清晰”不算验收。

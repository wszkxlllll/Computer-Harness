# 上海出发：出行票务试点准备

日期：2026-09-20
文档角色：入口 / 实施交接
状态：TUI自由goal与逐Run记录离线验收通过，首选第9节启动；旧逐题CLI保留兼容；真实运行结果以轨迹审计为准。
基线：准备开始时仓库HEAD为 `bd49417`；当前实现由后续提交继续演进。
上级计划：[生活服务评测与优化](./scenario-evaluation-and-three-person-plan-2026-09-19.md)第14节。
范围：用户已选择上海出发，铁路12306、携程、地图路线；先查询比较与保存行程，不做真实交易。

## 1. 本轮能开始什么

开始独立于生产Runtime的评测准备：任务候选、显式日期固定、任务身份、证据目录、人工走查及评分模板、离线校验。用户新增要求后，补充显式逐题启动和轨迹指标收集，实际调用由用户执行run并确认。复用现有CUA与应用入口，不另建Agent Loop，不先开发自进化框架，不把模拟订票网页充当真实App。完整题目与填写说明见[20题及反馈表](./travel-task-cards-and-feedback.md)。

开发验收期间不执行真实模型/桌面任务；交付后用户可显式启动单题。脚本不自动连续执行题库、不自动下单/支付/退改签/候补或修改账号；登录与验证码由用户处理。提示词边界和现有Guard不是绝对安全隔离，用户须现场观察，出现越界意图立即停止。

## 2. 入口与环境确认

| 入口 | 本轮查证 | 仍需本机走查 |
| --- | --- | --- |
| [铁路12306](https://www.12306.cn/index/) | 官方公开网站入口存在 | 未登录能查询到哪里，日期控件、站点选择、结果页、登录/验证码边界 |
| [携程火车票](https://wap.ctrip.com/webapp/train/) | 官方页面提供出发/到达城市、日期与搜索入口 | 当前电脑布局、列表/筛选、弹窗与登录边界 |
| [高德路线](https://ditu.amap.com/dir) | 官方路线入口及[帮助](https://www.amap.com/ssr/doc/route-plan)可查询 | 可用出行方式、起终点消歧、地图拖拽/滚动和结果文字能否正确观察 |

这些是网页来源查证，不是CUA交互通过。网页可作为起步入口，不替代原生App/微信小程序覆盖。后续如指定小程序，先手工打开确认PC可用；手机专属功能不默认由当前桌面CUA支持。

本轮只读本机检查：`node_modules`、`apps/cli/dist/index.js`、本地启动配置文件存在；常见安装路径下检测到Edge `153.0.4234.32`、Chrome `153.0.8010.50`。未读取账号/密钥，未启动客户端；文件存在不证明构建与当前源码同步，也不证明CUA daemon在线。微信安装及小程序能力尚未确认，不能按有限路径检查宣称未安装。现有 `scripts/harness.ps1` 可作为后续启动入口，不必另造应用启动器。

使用公共起点（如人民广场）和合成乘客约束，不需要住宅地址、身份证或私有订单。登录若必需，由用户手动完成；不收集账号密码。日期必须在每次准备时显式固定，人工确认位于目标网站当前可查询范围；脚本不推断售票窗口。

## 3. 任务设计与分集

目标10个任务族、每族两个不同输入实例，共20个草稿。族内变体必须同一split，目标12开发/8留出。不是20个独立业务流程，也不是已校准正式集。

候选覆盖：基础查询、站点消歧、时间/预算筛选、候选比较、接驳路线、跨入口核对、无可行方案说明、日期纠正、替代方案和本地行程整理。不同入口如果流程相同，不仅凭换平台算新题族。简单题用于检查优化是否增加负担；复杂题检验跨页面约束、纠正和信息保存。

任务输出只要求可验证的查询结论或指定本地行程草稿；不进入提交订单。票价、余票、路程耗时不能写成静态标准答案。动态事实必须附当时页面证据及时间；后一天重新查询不是对上一轮正确性的充分判断。

留出题默认不进入准备列表或调试流程；人工预检并不等于自动泄漏给优化器，但接触题面的人员需记录。准备留出任务需要显式操作并记录暴露情况；在这些题上调试后，不再声称未见验证。

## 4. 实施顺序与边界

1. 离线：校验任务族/实例ID、split、约束与模板；prepare写入新的唯一试次目录，日期/目标/题目版本固定。重复目录必须拒绝覆盖。
2. 人工入口预检：从开发题中选查票、地图、跨入口各一个，确认可完成、允许边界、所需账号和可保存证据。先做三例，不把全部20例一次扔给模型。
3. 人工评分校准：各任务写清正确、部分完成、明显错误和近似成功反例。区分模型完成声明、Runtime终止结果、真实任务满足程度。
4. 接现有应用入口：明确将试次ID、运行目录、实际模块配置、模型/代码版本与运行证据绑定。不能仅导入一个匿名 `passed=true` 当结果。
5. 经用户确认桌面与费用预算后，开发集小批运行。失败/中断也保留证据，评分先于清理。之后才能评估是否引入离线自动优化。

前两步没有通过前，不宣称具备自动化出行benchmark。公共站点不能彻底reset，初期记录初态与人工恢复；严格可复现机制实验和真实站点迁移应分开，不混算成功率。

## 5. 生产与评测数据边界

任务输入交给Agent；评分rubric、预期结果和人工判定不注入模型Context。证据在本地被忽略的 `runs/` 保存，不提交真实截图。评测侧不能借内部接口直接查业务答案给Agent。

prepare只代表“已准备”，不是“已运行”。未评分、缺证据、站点不可用均不能算通过。未知副作用不自动重试；登录/验证码请求交给用户；涉及付款、候补或真实订单立即停止本轮任务。

### 首次人工走查记录

每个入口至少记录：日期/客户端版本、Web或真实小程序、是否登录、实际初态、可达结果页、弹窗/验证码、能否人工完成目标、预期停止位置、评分依据以及清理方法。任一项未确认就保持pending，不用搜索引擎结果替代走查。

首个开发小批依次选择：

1. 上海到一个明确目的地的指定日期查票：验证站点与日期选择、结果读取。
2. 公共地点到上海某车站的接驳路线：验证地点消歧、路线方式与耗时读取。
3. 综合前两类信息形成行程回复：验证跨页面约束保留与来源/时点标注。本批不强制另开应用保存文件。

后续才加入多条件比较、主动纠正和无可行方案。本批日期/起点更改是预先写在goal里的顺序任务，不能宣称验证了Inbox中途纠正。另做实时纠正实验时，应在语义里程碑触发并记录实际收到的Inbox事件，不用固定第N步假定模型已进入同一页面。出发日期和目的地从任务准备结果读取；不使用此处文字作为额外隐藏要求。

## 6. 交付和下一步

Luna只读源码预检（不是运行通过）：`spikes/cua-driver/stage4-local-runner.ts` 已有daemon、fixture前台确认、CLI启动、evaluator和cleanup组织，可参考控制流；`scripts/stage4-local/evaluate-fixture.ps1` 仅做文本fixture精确匹配，不能直接评分出行任务；`packages/app-runtime/src/reporting.ts` 生成summary；`integrations/osworld/bridge.py` 的reset/evaluate只属于OSWorld。现有 `run:stage4-task` 不应直接包装成真实票务runner。结论是复用生产CUA/CLI与报告能力，新增评测侧准备和评分绑定，而非重建核心。

已落盘候选：[任务manifest](../eval/travel/travel-candidate-manifest.v0.json)。本轮独立用PowerShell按UTF-8解析JSON，确认10族20实例、6个开发族/4个留出族，出发日期最大偏移10天。此检查只证明基本结构，不是完整任务质量或执行验收。

首次预检仅交付任务草稿；当前已补充prepare/逐题run/collect、自动化回归和与真实Run目录绑定的人工评分记录。Luna首次任务草稿已进一步明确时间/预算/席别、地图具体起终点及最终回复交付方式。manifest整体保持 `draft_not_frozen`，不提供自动启动整批评测的命令。

本批已实现以下边界，不扩展Runtime：

- 无额外依赖的 `validate` 与 `prepare` 命令；默认开发集，留出需显式启用并记录暴露。
- 显式 `anchor-date`，展开具体日期与中文goal；记录manifest摘要、任务/试次ID、代码版本、待填写的实际运行配置；评分标准单独保存在评测侧。
- 在被Git忽略的 `runs/travel/` 新建唯一目录，拒绝覆盖、路径逃逸、无效日期和未展开变量；不启动应用、不发送模型请求。
- 初态、页面证据、人工评分模板默认pending，缺失证据不能通过。真实运行绑定与结果导入需另行验收。
- 单测覆盖上述拒绝路径和12/8分集；实际客户端走查前不能改为ready。

2026-09-20新增指标要求：除基础计数，按[反馈表第4节](./travel-task-cards-and-feedback.md#4-脚本记录的指标)保留Context、Memory、Planning、Batch、Monitor、Guard和人机控制的参与证据。只复用已有trace；不能观测的记未知，净效果由人工检查和后续对照确认，不为填指标新增模型裁判。

准备资产不修改Computer/Provider/Runtime协议；本机能力和真实页面可用性另做实际走查，不能用离线检查替代。本轮未消费业务模型API额度、操作桌面、安装依赖或commit/push。

## 7. 逐题操作命令

### 人工介入与结果交付：接入原则

普通CLI只能在waiting_user时回答、waiting_approval时审批，不能用于运行中主动纠正目标。人工评价表是运行后记录，不能替代运行中的补充需求。因此新增TUI自由goal入口作为本轮首选；保留旧CLI作有限兼容，不把二者混称。

已有TUI具备I纠正、P暂停、R恢复、A取消，操作须终端聚焦且不在文本编辑态；I在running时先请求安全暂停，再进入纠正编辑。这不是全局快捷键，也不能撤回已经发生的GUI副作用。新入口按会话目录下的每个 `run-*` 独立收集，不与旧CLI的 `runtime/` 层级混用，不静默选择最新一条。

模型最终结果目前并非未保存：`packages/app-runtime/src/reporting.ts` 将 `snapshot.summary` 写入 `summary.json` 的 `modelSummary`，轨迹的 `run.finished.summary` 同样保留最终文本。普通逐题CLI位置是 `<trial>/runtime/summary.json`。该文本是模型提交的最终回复，不保证内容完整或正确，不能用Runtime成功代替报告验收。

新交付要求：从已绑定Run原样导出UTF-8的 `report.md`（附runId/终止状态，不再调用模型总结）；中途取消或没有最终文本须明确标缺失，不能编造调查报告。保留 `manual-review.md` 为人工事实检查和评价。同步将纠正/审批/暂停等事件关联到对应Run，区分用户澄清与实际鼠标键盘接管。后台采集只读现有文件，不额外调用模型，不把用户手动操作推断成已记录事件。实作及验证结论见第9节。

以下从仓库根目录执行，复用现有 `.harness.local.psd1` 中的隔离Node、CUA和模型凭据路径。没有该配置时，先参考现有 `.harness.local.example.psd1`；不把密钥填入任务manifest。脚本的离线验收见第8节；真实站点效果仍待用户测试。

### 查看与准备（不调用模型、不控制桌面）

```powershell
.\scripts\travel\run.ps1 list
$TrialDate = "2026-09-20" # 示例：改为本批明确选定的基准日期
.\scripts\travel\run.ps1 show -Task T01 -AnchorDate $TrialDate
.\scripts\travel\run.ps1 prepare -Task T01 -AnchorDate $TrialDate
```

prepare只生成待运行记录；run会新建另一份独立试次，不续用preview目录。不要把prepare当已运行。留出候选的show/prepare/run需要明确加 `-AllowHeldout`，生成记录会标记暴露。

### 旧CLI：指定一题（保留兼容，不支持主动插话）

先保存当前工作并关闭敏感窗口。打开任务需要的网页或小程序，登录由用户完成；不要把审批页面和真实付款操作作为初态。记录入口、预填条件与登录情况，后续重复时尽量一致。

终端A保持CUA服务运行（已有服务则复用，不另启动）：

```powershell
.\scripts\harness.ps1 daemon
```

终端B启动一题：

```powershell
$TrialDate = "2026-09-20" # 改为你的固定基准日期
.\scripts\travel\run.ps1 run -Task T01 -AnchorDate $TrialDate -Preset research -Model glm-5.3-flash
```

阅读题面与预算，确认后输入 `RUN`。默认每题最多100个GUI动作、100次主模型请求；可用 `-MaxSteps`、`-MaxModelRequests`显式调整并记录，不承诺等价人民币费用上限。Risk额外请求按现有运行配置计入指标，不将主请求预算误认为所有服务总额度上限。`research`为本轮默认，Plan/Memory/Context/Batch/Monitor开启，Risk Guard默认关闭以避免联调被逐次审批阻断；可用 `-RiskGuard layered` 显式恢复逐次保护，也可在TUI的F页面为下一Run切换。未自动开启新embedding服务。

每次run只执行指定题；结束后再把T01换为T02等，不提供无人值守整批循环。普通CLI仅支持模型等待输入时回答、审批时y/N和Ctrl+C取消，不支持TUI快捷键。人工接管先停止当前Run。

若修改核心源码，显式加 `-Build`确保重建；现有构建存在不证明一定与源码一致。本轮脚本不更改TS核心，离线脚本功能不依赖重编译，但先前本机核心是否已构建需按实际状态确认。

### 收集与人工反馈

正常返回时自动collect；被强制退出或想重新汇总时：

```powershell
.\scripts\travel\run.ps1 collect -TrialDir "runs\travel\<本次试次目录名>"
```

只使用启动时打印的本次目录，不自动寻找“最近的Run”。在该目录填写 `manual-review.md`；`metrics.json`是自动统计，不能代替人工业务结论。把试次目录与人工反馈交给分析Agent即可，不必重跑才能补评价。人工表不会被collect覆盖。

停止服务由用户在不再使用它时执行现有launcher命令；逐题脚本不擅自关闭或重启共享CUA daemon。截图和原始交换仍留在被Git忽略的runs目录，分享前检查隐私。

## 8. 本轮离线验收

任务调整：用户要求全部使用携程替代原第三方候选，跨平台比较收敛为12306与携程，已去重入口。T09/T10改为携程→高德并在任务卡标为难题；用户可提前登录三平台，实际初态仍需记录。无票不自动计失败，按任务卡的查询/环境阻塞/分支未覆盖规则人工评价。旧runs中的任务快照不回写，新准备使用新manifest。调整后重新执行12项Node测试，11通过、1项symlink权限跳过，未执行真实任务。

实际产物：

- `eval/travel/travel-candidate-manifest.v0.json`：20题草稿。
- `scripts/travel/travel.mjs`：题目展开、日期/分集校验、准备与collect入口。
- `scripts/travel/run.ps1`：用户显式逐题启动，不循环题库。
- `scripts/travel/metrics.mjs`：仅从绑定的summary/trajectory提取指标，不读截图和Provider完整交换，不改人工反馈。
- `scripts/harness.ps1`：新增输出目录和预算参数，拒绝指定非空输出目录；不修改生产Runtime/Provider。

Node原生离线测试：`node --test scripts/travel/travel.test.mjs scripts/travel/metrics.test.mjs`，共12项，11通过、1跳过。跳过的是创建symlink的安全反例，当前Windows权限不允许创建；代码有拒绝检查，但不能把这项记为实测通过。包含正常/缺失/截断/空轨迹、runId冲突、人工表不覆盖、请求时间关联及模块证据。前缀A→B→A按2次变化计数；lexical禁用语义不算检索降级。

独立操作验证：20题渲染无未展开变量；PowerShell 7预览/prepare/缺数据collect通过；Windows PowerShell 5预览及确认前输入非RUN取消通过，中文正常，记录not_started且没有Runtime目录。离线试次仅用于验证脚本，不是任务成绩。

PowerShell解析及launcher替身验证使用 `scripts/travel/run.parse.test.ps1`：复制launcher到受限临时目录，由只记录argv的假CLI检查中文goal、输出目录、预算与Guard参数，以及非空输出目录拒绝，不启动生产CLI/模型/daemon。最终root独立在PowerShell 7与Windows PowerShell 5均复跑通过。早期检查发现的数组splat命名参数误绑定、条件表达式及测试PATH恢复过早问题已修正；测试临时目录经绝对路径校验后清理，不触及用户任务文件。

未验证：本批20题的真实客户端可行性、模型成功率、GUI效果与模块净收益；未执行付费API或桌面操作。数据采集工具通过不等于业务评测通过。无commit/push。代码SHA与dirty状态、manifest摘要以及requested配置写入试次；未提交工作树不能只凭HEAD复现，应保留当前修改版本。

## 9. TUI自由goal测试入口

本节为用户最新要求，替代“只能按题号启动普通CLI”的使用建议。新增代码单独验收，旧第8节结果不自动涵盖本节。

### 启动命令与操作说明

**面向用户的唯一完整步骤、启动命令和20题完整goal统一在[任务操作手册第0节及第2.1节](./travel-task-cards-and-feedback.md)。**先按那一份做，不需要拼接本文件的旧CLI命令。首次TUI启动保留Build；生产报告新增字段需要重建。新入口不带Task/AnchorDate，用户在TUI内输入明确日期的goal。

每个Run在会话目录下独立保存summary、trajectory、run-metadata、report、metrics和manual-review。后台采集器随TUI启动，在退出时收尾；普通单题CLI的runtime目录与TUI会话/run-*目录不混用。

需要事后补收集时（不调用模型、不操作桌面），从仓库根目录执行：

```powershell
$LocalHarness = Import-PowerShellDataFile .\.harness.local.psd1
& $LocalHarness.NodePath scripts/travel/tui-collector.mjs collect --session-dir "runs/travel/tui-<会话ID>"
```

占位符换成实际会话目录。这与旧 `collect -TrialDir` 不同，后者读取单题CLI的runtime子目录。

### 交互方式

1. 在仓库根目录启动CUA daemon（已运行则复用）。
2. 通过 `scripts/travel/run.ps1 tui` 打开已有TUI，默认research预设；不会自动输入goal或执行20题。
3. 首页先按大写F：方向键选择项，空格/左右切换，Enter保存。F改变Plan/Memory/召回/Batch/Context/Risk Guard/Monitor，只作用于下一Run；Model和预算仍由启动配置决定。先选配置再输入goal，避免切换配置页清掉未提交的编辑草稿。
4. 输入或粘贴goal，写具体日期、目标和边界，Enter开始。可以用任务卡，也可自定义；自定义不自动获得题号或验证集资格。
5. 运行中I进入纠正（可能先等待安全暂停）；P请求暂停，R恢复，A取消。手动操作桌面前等待暂停已确认；已发生动作不可撤回。键盘焦点必须在终端，编辑态下字母是文本输入。
6. 一轮结束后首页显示最后回复，可以再选配置、输入另一个goal。每轮创建新的Run及结果目录，不复用上一轮Memory/Plan当作同一任务。修正同一在途任务应使用I，而不是结束后又新建goal。

### 记录边界

TUI会话下每个Run分别保留实际goal、实际配置、Run ID、原始summary/trajectory、模型原文report、模块metrics与人工评价表。不能拿入口的preset代替F调整后的实际配置。模型报告不是经核验事实，人工评价不自动变为成功。

后台采集器仅负责读文件和输出报告，不读终端stdin、不新增API调用/GUI动作、不干预主循环。正常运行中在终止记录/summary可用后收集；退出时再收集一次，异常或不完整Run标partial。不存在最终文本时明确“未产生最终结果”，不额外调用模型补写。人工表仅首次创建，重新collect不覆盖。

进程只管理自己启动的采集器，退出不关闭已有共享CUA服务。若整个终端被强制杀死，仍应允许事后手动collect；不能保证操作系统强杀后finally一定执行。所有这些产物可能含私人goal/回复，保留在ignored runs目录，不自动上传。

### 验收记录

已独立复核：两个不同goal和功能配置的Run隔离、原文结果导出、失败/取消缺结果、人工表不覆写、旧单题CLI兼容、PS参数/编码以及相关AppRuntime/TUI回归。Node脚本最终16通过/1项Windows symlink权限跳过；AppRuntime RunFactory/ApplicationSession与TUI共31通过；PS5/PS7 fake TUI双Run及命名参数测试通过。AppRuntime noEmit类型检查由root独立通过。目录名作为预期Run ID参与冲突检查；TUI明确拒绝Task/AnchorDate/TrialDir/AllowHeldout单题参数，不静默忽略。未以离线验收替代真实任务效果。

第9节初次交付的生产改动限于reporting白名单字段：goal、预算、有效memoryRetrieval和monitor，当时未改Runtime主循环、Provider和TUI控制语义。后台采集器是独立本地Node进程，仅负责文件产物，不是AI Monitor。该次离线验收不包含真实API、截图和桌面操作；后续构建验证见第10节，用户真实运行及后续整改见第11节。

## 10. 普通PowerShell缺少pnpm的启动修正

用户首次实际使用Build时暴露：隔离Node已配置，但Invoke-Build仍调用PATH中的pnpm.cmd。开发工具终端碰巧能找到pnpm，普通用户终端不能；此前离线fake启动验收没有覆盖这一真实构建依赖。这是启动器缺口，不是用户丢失了Node环境。

本机只读确认：项目隔离Node为24.19.0，现有pnpm为11.19.0；已给Git忽略的本机配置补充PnpmCliPath。仓库模板使用通用路径，不把维护者的工具缓存路径写入公共启动脚本，不安装全局pnpm、不改系统PATH。

真实诊断进一步确认：只用node执行pnpm入口仍不够，因为package.json的build/typecheck内部会再次调用pnpm。修正必须同时支持嵌套调用，并在构建结束/失败后恢复进程环境。实现使用显式NodePath/PnpmCliPath及当前构建专用入口；不复制或改写package.json的构建逻辑。

失败会话保留为failed证据，未创建实际Run，不能称TUI已成功启动。启动器结束提示现已区别finished与failed。

修正后独立验证：在调用者PATH中移除所有可找到pnpm.cmd的目录，再运行 `scripts/harness.ps1 check -Build`，PowerShell 7和Windows PowerShell 5均实际构建成功、exit 0；内部的pnpm run typecheck及pnpm exec均通过，PATH恢复断言通过。PS5/PS7离线启动器/TUI替身回归通过，另覆盖嵌套pnpm、构建失败退出码传播和环境恢复。本次只运行构建及离线测试，没有启动真实TUI、模型任务或共享daemon，没有安装全局依赖。本机已完成此次重建，源码未再变化时下一次启动可省略Build。

## 11. 两次真实票务运行：Guard与审批交互整改

日期：2026-09-20。角色：从属于本文的审计与整改记录。基线：本地工作树，用户已把CLI默认动作/请求预算调整为100，保留该改动。状态：调查确认，整改进行中；不等同于真实任务通过。

### 11.1 已核对事实

证据保留在本地 `runs/travel/`，不提交截图、完整用户轨迹或Provider原始交换：

| 会话后缀 | Run后缀 | 实际结局 | 动作步/模型请求 | 审批 |
|---|---|---|---|---|
| `095350-276cc4bc` | `a1e19e8e-fb2` | `budget_exhausted`，无最终报告 | 30 / 29 | 3次，均批准 |
| `101358-b8e6b3df` | `c8a21a8e-dec` | 用户取消，无最终报告 | 19 / 20 | 3次，均批准 |

六次审批全部针对查询按钮，声明效果为`navigate`，但summary包含“提交车票查询”。当前规则把裸“提交/submit”识别为`external_commitment`信号；`riskModel=off`使其进入`semantic_review_unavailable`审批回退。这是本例明确的查询误报，不是实际支付或预订证据。

六次`approval.requested`之后均出现Monitor诊断：`monitor.proposal requires running status, got waiting_approval`。审批仍然能够通过，不能把诊断异常解释为所有审批都死锁。第二轮另有两次CUA `foreground_unavailable`拒绝，应与Guard误报分开计数。

六次批准后均直接出现`action.proposed → action.execution.started`，未先生成新Observation；receipt为desktop scope的SendInput点击。当前`executeApprovedCall`只检查Harness内部Observation是否被替换，无法证明审批期间外部页面/焦点没变。现有窗口geometry检查也不能证明窗口内容没变。

### 11.2 当前Guard的真实标准

供用户逐项审查的完整规则、输入来源、审批后校验及安全局限见[Guard审查说明](./travel-guard-policy-review-2026-09-20.md)，代码状态与旧运行记录分别标注。

1. Computer调用缺少效果声明、命中宿主禁止快捷键：拒绝。
2. 声明破坏、财产、对外承诺、敏感披露或安全设置变更，以及输入内容命中有限凭证/财务模式：直接审批。
3. 声明unknown、动作与声明矛盾、target/summary命中高影响文字：进入可选语义复核；未配置复核模型、超预算或失败则审批。
4. 声明低影响且没有升级信号：放行。

这是启发式保护，不是完整隐私/财产安全证明。当前低影响声明来自主模型，关键词也可能误判；没有通用OCR、完整页面语义验证或操作系统级隔离。修复不得以关闭Guard、自动批准或“包含查询字样全部放行”替代。

### 11.3 整改与窗口范围

- Luna实施：保留具体升级原因、Monitor审批状态屏障、可见且可操作的TUI审批提示及审批后旧动作校验。最初的“查询提交”豁免被用户指出过于针对特例，现决定撤回本轮新增豁免；改为研究明确授权范围与本Run审批复用，不把查询白名单当成最终解法。
- Sol在实现完成后集中审查安全性、状态机和回归，避免多轮重复全面审查。
- 用户澄清：不要求本人并行输入其他应用，只要求截图与动作限定选定窗口，其他窗口显示/遮挡不污染目标。这仍要求定向输入，单纯裁剪截图不够。调查起点的window opt-in仅开放background single-click与wait；type/keypress/scroll/drag等不能未经验证直接对真实票务任务开放。
- 日常入口应按应用名/窗口标题选择，内部绑定`PID + window_id`；不要求用户手填编号。成对的`-CuaWindowPid <pid> -CuaWindowId <window-id>`仅供脚本/调试。选择取消不能意外改变目标，窗口关闭不能自动退回desktop，窗口清单不进入Provider上下文。
- 用户已授权受控窗口实测：独立测试daemon和自有合成窗口/本地浏览器页面，验证遮挡、定向输入、焦点及失败无fallback。不开模型API、不操作用户账户和票务业务、不重启共享daemon，只清理自己创建的进程。不提交/推送代码。
- 目标定义是精确系统窗口，不是“整个Edge/整个微信”。同一应用可有多个系统窗口；标签页可能共用一个窗口，独立聊天、小程序、弹窗可能另有目标。浏览器窗口/标签/新窗口边界纳入受控测试，微信没有安全实证时明确记为未验证，不能从WinForms测试外推。新窗口不自动继承旧窗口授权。

验收状态将在实施和集中审查后补充；当前不要把这两次失败计成模块效果通过，也不要通过继续增加步数掩盖审批问题。

用户曾提出“批准后同样动作不再反复审批”，随后明确决定本轮仍保留逐次审批，优先解决切PowerShell影响操作目标的问题。候选grant移为后续非阻塞设计，详见[Guard审查说明](./travel-guard-policy-review-2026-09-20.md)；目前尚未实现，不得称为已有能力。窗口限定可避免把PowerShell画面当成操作目标，但不能保证焦点/光标变化不改变目标截图，fresh截图严格校验仍可能误拒绝。

### 11.4 窗口模式的验收条件（计划，不代表已通过）

| 范围 | 验证方式 | 不通过时 |
|---|---|---|
| 可读选择 | TUI显示应用名和标题；方向键确认、刷新、取消；选中目标进入下一Run配置/报告 | 不能用手填编号替代日常入口 |
| 截图范围 | 自有窗口处于非零桌面坐标、被另一测试窗部分遮挡；截图仍对应目标窗口 | 不开放真实任务 |
| 输入范围 | 点击、输入、按键、滚动分别检查目标oracle，并检查旁边witness未收到输入 | 仅开放独立通过的primitive，不隐式desktop或foreground fallback |
| 几何和生命周期 | 移动/缩放后旧观察拒绝；关闭/重建不能复用旧授权；重新观察仅更新同一有效目标 | 明确拒绝，不按标题自动重绑 |
| 浏览器边界 | 自有本地页面内输入/滚动、同窗标签、独立新窗口；不使用用户浏览器profile | 单独记录不支持项，不能外推微信/小程序 |
| 端到端组装 | TUI选择→Run配置→Computer绑定→Provider获得窗口viewport与有效工具清单→报告记录目标 | 窗口编号不进入通用GUI协议，不把全部窗口列表发送模型 |

“窗口”指操作系统窗口对象。应用名/标题是供人选择的标签，不是身份凭证；标题可重复或变化，不能拿标题自动授权。窗口模式也不等于VM隔离、后台安全保证或多用户并发控制。

受控实测的中间失败必须保留：`runs/dev2-adapter-window-contract-r5/adapter-window-contract-summary.json`中后台scroll返回`background_unavailable`；后台type的消息明确提到投递未完整确认，即便receipt暂记completed，也不能称语义输入成功。该次`ok=false`，不是放行证据；其中`keyboardDispatched=false`与实际type/key调用不一致，探针记录待修。用户不要求完全后台，因此下一步可验证显式foreground窗口投递（可能临时激活目标并还原），但必须作为可见配置，禁止background失败后静默升级。生产能力是否开放以最终实测和审查为准。

随后用户确认上述测试期间可能有人工鼠标/键盘操作，并授权在停止人工操作后重新测试。因此旧轮次的焦点、输入和行为结论标为“可能受人工干扰，不用于最终验收”；保留错误原文，但不直接归因为CUA实现缺陷。新一轮必须使用独立输出目录、短文本精确oracle、witness输入检查、明确的delivery profile及有界cleanup；没有最终summary的轮次不计通过。

### 11.5 无人工输入的窗口重测与放行边界

新证据：`runs/dev2-adapter-window-foreground-retest-r2/foreground-retest-summary.json`。用户声明停止人工输入，测试仅使用自有fixture和私有daemon；root已读取原始summary。

- 测试前target处于非前台、witness处于前台。窗口局部截图为959×679；foreground click、32字符type、F2和PAGEDOWN都有目标fixture事件。原文type使用`containsProbeText`与长度检查；PAGEDOWN只证明按键送达（文本不足一页），不能称为已验证页面滚动效果。
- click、F2、PAGEDOWN后target仍在前台，只有type后witness恢复前台。因此该探针整体`ok=false`，不能改写成完整通过。允许作为显式foreground预览的输入送达证据，不承诺恢复TUI/原前台。
- 默认background必须保持`keyboard=false`、仅click/wait；显式foreground预览可使用已验证的type/单键keypress。scroll、hotkey、double/right click和drag保持关闭；不从background自动升级foreground。
- 本轮没有真实浏览器本地页、浏览器多窗口/标签/popup或微信小程序的受控验收。系统窗口绑定语义可由源码解释，但这些应用的具体投递效果仍为未验证；不得把WinForms结果外推为完整票务可用。
- worker报告自有fixture/daemon/子进程均已清理，共享daemon未动；root已通知用户可以恢复输入。没有新增模型API请求。

用户随后要求验证scroll、组合键与drag的前台/后台两种投递。矩阵的foreground-r2证明Ctrl+A后selectionLength=1229，REPLACED替换后textLength=8，dragCount增加为1。因此当前显式foreground预览增加hotkey/drag；background仍click/wait。该矩阵使用raw driver，生产适配器只有映射/门控单测，此限制不能省略。此前worker口头称witness无输入过于宽泛：文本没变不等于未收到滚轮事件，下面的独立审计予以纠正。

矩阵的scroll未观察到firstVisibleLine变化；用户指出可能是探针问题，现交独立Luna检查坐标、滚动内容、oracle时机与参数，不能直接归因基础设施不支持。probe整体ok=false不等于所有primitive失败，也不能把receipt无错误当成动作效果成功。

独立审计（root已读回文件）：foreground-r1/r2的`witness-state.txt`最终均为`event=v_scroll`，r1的firstVisibleLine为9，target未记录对应位移。旧硬编码scroll点落在witness覆盖区，旧结果还存在替换长文本后再滚动的顺序问题。因此不能称“没有滚动”，也不能声称“witness没有收到任何输入”。下一轮分无遮挡/遮挡两种场景，核对本地scroll坐标契约、target及witness双oracle。仅无遮挡成功不足以证明遮挡场景定向输入可靠；若明确window目标仍滚到witness，必须保留失败，不能靠改测试点隐藏。

root已独立执行隔离启动器`check -Build`及全量Vitest：37文件418项通过。Sol集中审查后的picker/cleanup/模式门控问题已修；whole-frame SHA可能因动态像素误拒是已知限制，不是本轮已实测的新失败，旧跨步骤截图不能用来证明同一次审批前后误拒。窗口仍为有限预览，完整票务体验需要应用级验证，不启动批量评测。

TUI worker另外执行了一次已编译`CuaWindowDiscovery`真实只读调用：共享socket返回3个窗口，3个均有标题或应用名、3组PID/windowId合法，cleanup完成，10秒上限未触发。仅输出计数，不记录/上传标题清单；没有截图、聚焦或输入，没有停止共享daemon。这证明真实响应解析可为picker提供列表，不等于应用动作效果通过。

### 11.6 独立scroll探针纠正与双场景结果

独立worker查证本地0.22.2工具描述：Window目标的scroll x/y使用窗口截图局部像素；本次按生产映射的`by:"line"`验证，不拿page语义代替line。探针改成先滚动长文本，再Ctrl+A替换，并分别记录target/witness的settled读数与遮挡关系。

root已读取`runs/dev2-window-action-matrix-retest-dual-foreground-r1/window-action-matrix-summary.json`：

| 模式/场景 | 真实效果 | 判定 |
|---|---|---|
| foreground、无遮挡 | target firstVisibleLine 0→2，witness不变，后续精确替换通过 | 基本scroll通过 |
| foreground、有遮挡 | receipt无错，但target与witness均未滚动 | 定向遮挡场景未通过 |
| background、两种场景 | `background_unavailable`，无自动升级 | 当前fixture不支持 |

这纠正了“scroll完全不可用”的早期表述。随后`covered-front-r1`补验中，bring_to_front receipt无错但fixture未确认target成为前台，仍不能作为遮挡滚动成功证据。探针后续改为前台oracle未通过即跳过滚动，不以receipt代替状态。生产接入的最新决定见下一节，不能再把此处旧门槛当成当前功能清单。

### 11.7 用户决定停止追加实验：当前交付状态

用户最终要求直接接入窗口功能，不再追加测试；布局由用户自己调整，不把“左控制台/右目标”写成自动布局或程序规则。本轮不修改系统窗口布局、不自动移动用户应用、不新增授权复用、不commit/push。

当前生产链路：TUI在非编辑态按W→按应用名/标题选择→精确PID/windowId进入后续Run→Computer窗口截图和动作→报告记录computerTarget。窗口位置/尺寸由用户自行安排；窗口标题只供本地展示，完整清单不进Provider。现有全桌面默认不变，不静默退回桌面。

| 入口/模式 | 当前工具开放范围 |
|---|---|
| TUI菜单选窗：显式foreground预览 | click、type、keypress/hotkey、scroll、drag、wait |
| 显式编号CLI：默认background | click、wait |
| primary desktop | 保持原有工具集合，不受本轮窗口门控影响 |

window模式右键/双击仍禁用。foreground可能激活目标，遮挡/前台恢复并无保证，窗口绑定不是操作系统沙箱。scroll已按用户当前可见窗口使用范围接入factory allowlist与adapter两层门；background不升级、不开放scroll。接口已接入不等于所有场景测试通过。

补充真实证据与未通过项：

- `runs/dev2-adapter-window-side-by-side-r1`：生产adapter click/type/Ctrl+A替换/drag有目标oracle；控制窗focus切换前后目标截图hash相同。该轮scroll因加载旧dist被拒绝，是构建版本问题；随后已重建，但按用户停止实验要求没有补跑。
- 同轮scripted-provider审批进入并获批准；点击返回`foreground_unavailable`，未计为动作完成。原文包含“after the click”，不能仅凭文本/dragCount不变证明绝无点击副作用；不将Run最终状态冒充操作成功。
- 浏览器独立profile本地页两轮：窗口布局/身份及窗口截图通过，click焦点oracle未确认，未继续输入。用户要求停止后已清理自有浏览器、私有daemon、临时profile及subst映射，保留脱敏summary，不计浏览器动作通过。
- 最后整仓418项与构建通过记录是其执行时树的证据；停止测试之后仅做文案/接入收口及必要构建，不声称又跑了完整回归或新的真实任务。

用户日常命令和键盘操作统一见[任务操作手册第0节](./travel-task-cards-and-feedback.md#0-你现在照这个顺序做)。spikes中保留了matrix、side-by-side、browser探针及使用说明供以后复核，但启动TUI不需要先跑这些探针。本轮Guard最终为逐次审批：Y只允许当前调用，fresh observe仍校验旧画面，查询关键词豁免已撤回，授权grant仅为后续候选。

最终收口：停止实验后已再次完成隔离Node 24.19.0下的`check -Build`，CLI/CUA输出与当前源码同步。没有再运行模型、GUI或单元测试；此前418项结果不冒充最后文案树的重跑结果。重新打开TUI即可载入新构建，现有共享daemon可以复用，无需重新登录或重装环境。

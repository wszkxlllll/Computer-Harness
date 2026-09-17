# 长期架构、模块拆分与 CI/CD 深入审计

日期：2026-09-16  
文档角色：审计 / 实施建议  
状态：当前结论，未更改代码或工作流  
当前入口：[审计总览](audit-2026-09-16-overview.md) → Stage 6  
基线：`39ff27f`  
范围：包依赖、组装合同、持久化、测试可信度、CI/CD和发布；用户已确认无需本轮设计新的CLI命令体系。

## 1. 当前架构值得保留什么

当前依赖大致为：

```text
apps/cli + 实验脚本（组装）
  ├─ runtime ← context / planning / memory / risk-guard
  ├─ provider-glm / provider-qwen
  └─ computer-cua / computer-osworld

runtime → trajectory → protocol
各Adapter → runtime合同 + protocol
```

Runtime不直接选择具体Provider，不理解CUA私有句柄；工具由Registry投影，Context可以替换；副作用之前写started、每个动作独立Receipt、失败未知不重放。这些是实验和产品共用的正确基础。

复杂性主要集中在“模块内部职责”和“入口重复组装”，还没有证据要求重写成另一个框架或引入动态插件系统。

## 2. 本轮确认的工程问题

### A-01：功能开关和实际实例可以不一致（P1，提取组装前修）

`RunController`构造函数同时接受 `features.batching` 和单独 `batching`，实际准入读取后者；Risk Guard是否运行取决于 `actionPolicy`，提示/schema取决于 `features.riskGuard`。例如 features写layered但不传actionPolicy，能够出现“有声明要求但没有动作Guard”的组装。当前CLI正确地共同传入，不代表新的TUI/SDK入口也一定正确。

建议做一个规范化配置对象与启动校验：一份run features解析到实例和工具投影；不一致立即失败。不要允许Context开了Memory、Registry却没注册，或工具存在而状态投影关闭。关闭模式测试还需检查prompt、schema、状态、额外Provider调用和事件。

### A-02：单文件不是核心问题，边界混杂才是（P1）

本轮行数快照（仅用于定位，不作为质量评分）：RunController1554、Trajectory933、Qwen802、GLM531、CLI512、Protocol430、Context416。

特别是RunController已经比分别的index.ts更大，旧拆分计划低估了这部分。它同时承担Inbox、Provider重试、ToolTurn预检、Batch、Guard、Approval、Plan/Memory提交和动作生命周期。未来仅继续拆外围包而不明确Controller内部职责，会在这里继续堆分支。

建议先抽纯逻辑，再拆执行协作者：

| 模块 | 建议职责拆分 | 必须保留的唯一权威 |
|---|---|---|
| Runtime | command-inbox、provider-attempt、turn-preflight、batch-admission、action-executor、state-tool-commit | Controller拥有Run状态和执行顺序；协作者不得各自建主循环 |
| Trajectory | event-validation、reducer、jsonl-writer、asset-store、reader | persisted event顺序与Reducer |
| Provider | request presenter、tool projection、parser、HTTP transport、image/coordinate | 每厂商保留自己的wire语义，不强制一套“兼容OpenAI”实现 |
| Context | compiler、history selection、budget、plan/memory projection | Context为事实视图，不更新Memory/Plan |
| Planning/Memory | tools、store、mutation validation | Runtime事件提交后再物化，不新增第二份进度状态 |
| Risk Guard | router、assessor、policy、redaction | 单个ActionPolicy结果，复核器不能执行GUI |

不是每一行表格都要变成独立package。优先同包文件；只有独立消费者、依赖隔离或发布需要时拆包。index.ts保留稳定export，重构不顺便改变Provider输出和事件顺序。

### A-03：共享组装应抽出，但不要成为新大单体（P1）

建议 `packages/app-runtime`（名称可调整）只承载：解析后的Run配置、工厂、统一工具/Context/Guard组装、资源所有权、输出布局、诊断回调。CLI/TUI负责输入输出，env/argv在应用边界解析，OSWorld reset/evaluate仍留在评测environment runner。

建议公共结果是RunHandle：controller、只读view、命令面、明确关闭方法。不是把整个512行CLI原样搬进一个新index。ProviderHTTP记录decorator可共享，但不得重新耦合到CLI的日志形状。

所有入口共用配置一致性验证。RiskGuard是每Run实例，不能把其累计 `modelRequests` 状态作为全局singleton复用。

### A-04：持久化语义要区分进程退出与断电（P1：可靠性说明）

`JsonlRunEventWriter.append` await `appendFile`，`flush`等待队列，没有fsync/datasync。这足以保证程序的写入顺序，但不承诺掉电后started一定留在磁盘。不要把它描述为已经有完整事务式恢复或exactly-once副作用。

现在Replay是事件读取/状态重建，不等于可以恢复操作电脑。建议为真实高风险执行提供显式durability策略，至少在执行前关键started屏障可选sync；成本独立测量。读取残缺尾行时要报告截断/未知状态，不能偷偷跳过中间损坏。恢复必须重新观察，不自动重投started但无terminal的动作。

### A-05：实验日志和产品日志尚未形成统一出口（P1）

CLI native ToolCall摘要保留arguments，flat摘要却仍读取legacy根级kind/name/arguments，遗漏当前 `calls[]` 信息。Trajectory仍有完整事实，因此不代表请求丢失，但两Provider诊断显示不对称。

建议建立typed的脱敏DiagnosticProjection，所有wire先正常解析/分类后展示，原始证据保存策略单独设置。CLI默认output固定 `runs/live-cli`，Writer以wx拒绝已有trajectory：不会静默覆盖，这是优点；产品应用应自动生成每Run目录，不能要求用户每次手改路径。

### A-06：CLI退出状态不足以作为CI任务判定（P1）

main在Run正常返回failed/budget_exhausted/outcome_unknown后仍写summary并自然退出，只有顶层throw才exitCode=1。CI不能仅因进程exit=0判定任务成功。建议独立定义“程序失败”和“任务未完成”的机器结果/退出约定；评测官方分数与runtimeOutcome继续分开。

### A-07：被用户废弃的风险复核仍可能产生费用，但缺事件（P1：计量）

`processToolCalls`先await ActionPolicy，再drainCommands；若有纠正/暂停，在commitGuardDecision之前返回。LayeredRiskGuard内部已经累计modelRequests，但RunSnapshot/summary可能没有该次请求。这个路径正确地阻止了旧动作，却不能完整记录复核开销。建议为复核请求增加独立开始/完成/失败事实，并把“决策已作废”与“请求未发生”分开；不能为记账而应用作废决策。复核请求字段必须由真实请求路径生产，不能靠推算补数。

## 3. 测试和构建的实际边界

- 本次179项测试和typecheck通过；CUA测试使用fakeDriver，OSWorld测试包含fake bridge process，不代表真实三系统能力都通过。
- `vitest.config.ts`没有workspace源码alias，包export指向dist。测试文件可以来自src，而跨包依赖来自dist。因此CI必须先干净构建再测试，不能直接复用开发者dist缓存。
- root `build`实际上调用typecheck；typecheck内 `tsc -b`会生成JS和声明，另外检查spike。不能声称它是纯noEmit，也不能把它当作已经验证可分发安装包。
- package tsconfig include了src下测试；未来产品构建应区分library emit与测试类型检查。不要在第一次结构拆分中顺带大改所有构建语义。
- 当前没有formatter/linter/coverage脚本。建议先上必要静态规则、依赖方向和新增代码格式检查；不要为了CI门槛把整个仓库重排制造巨大diff。覆盖率先报告，再对关键状态分支设门槛，不随意规定全仓80%。

## 4. CI：现在应该建，而非等产品做完

### 4.1 已核实远端状态

仓库为private；`actions/workflows`返回0；本地无跟踪的 `.github` 工作流。branch protection API返回403并明确提示套餐限制。这不能表述为“已配置强制审核”。CI与分支保护是不同能力；可先建立CI及团队合并规则，是否升级套餐由仓库所有者决定，不改公开性来绕过。

[GitHub分支保护适用范围](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)。

### 4.2 推荐工作流分层

| 工作流建议名 | 触发 | 执行内容 | 密钥/桌面 |
|---|---|---|---|
| `ci.yml` | pull_request、push main | frozen安装、干净构建、179项及新增离线测试、包导入/帮助smoke、文档/编码/依赖检查 | 无模型密钥、无真实桌面 |
| `api-conformance.yml` | workflow_dispatch、明确受信版本 | GLM/Qwen最小合成协议probe、Guard/多调用边界 | 限预算密钥；无GUI |
| `desktop-contract.yml` | 手动、选定SHA/平台/目标 | 受控CUA生命周期/坐标/窗口/取消测试 | 专用桌面runner，串行独占 |
| `release.yml` | 手动候选tag | 重跑所需门槛、打包、版本/校验和/能力支持表、release artifact | 不自动部署到个人电脑 |

第一次只实现ci.yml，其余作为有负责人和资源后再落地的工作流。不要搭一个依赖尚不存在桌面runner而永远红灯的required check。

### 4.3 PR CI顺序和平台

1. Checkout受测提交，记录SHA；使用仓库固定pnpm 11.19.0与Node基线。
2. `pnpm install --frozen-lockfile`；缓存pnpm store，不缓存跨平台node_modules、native binaries或可过期dist。
3. `pnpm typecheck`（当前实际也emit）；随后 `pnpm test`；最后无密钥CLI help/公共包导入smoke。
4. 检查tracked diff、中文UTF-8、坏链接和新增层间反向依赖；错误应展示明确路径。
5. 上传最小测试报告与配置摘要，禁止默认上传整个runs、屏幕或.env。

首版Windows+Linux离线矩阵；macOS离线安装/import检查可按团队资源加入，真实macOS桌面另算。Windows CI至少有一个中文/空格临时目录fixture，避免开发者中文路径问题一直回归。Node升级按单独矩阵验证，不在每次PR浮动追latest。

### 4.4 权限、取消和任务互斥

普通CI `permissions: contents: read`，第三方Actions固定review过的commit SHA。PR检查不用 `pull_request_target`执行PR代码；真实API/桌面不对不受信PR自动开放。官方也特别提示self-hosted runner能暴露宿主资源。[GitHub安全说明](https://docs.github.com/en/actions/reference/security/secure-use)。

离线CI可对同PR `cancel-in-progress:true`。桌面任务必须 `cancel-in-progress:false`、同一desktop串行，另有显式安全停机步骤；不能用GitHub取消job代替Runtime取消已发动作。runner不得是日常带账号工作的个人桌面。API任务有总费用/请求上限，失联时停止，不自动再跑一整轮。

### 4.5 CD在本项目中的含义

现阶段主要是版本化分发，不是部署服务器。当前workspace package均private，不能直接规划自动npm publish。先发布可复现源码/安装说明和经验证artifact；真正支持可安装TUI前，增加干净目录安装测试、bin入口/shebang、依赖打包和native平台验收。

每个候选记录Harness SHA、Node/pnpm、CUA SDK和daemon各自版本/来源/平台、配置schema、能力模式、测试范围。不把PR head旧测结果贴到新merge SHA上。保留上一候选的源码、lockfile和配置回退；CUA daemon和SDK成对回退，旧日志仍可只读查看。

## 5. 实验性与稳定性如何并存

保留同一Runtime，在组装入口提供可记录的profiles：研究基线（明确开关）、本机受控体验、将来的增强窗口模式。Profile只是配置，不是复制三条循环。试验功能默认关闭，开启后日志记policy/context/toolset/backend版本；不要用environment变量偷偷改变已有freeze行为。

同一代码可跑研究和产品，但评测动作空间必须可追溯。新增AX/browser/set_value后，不能混入旧OSWorld pixel-only组并声称模型自然变强。功能回归、协议API、真实动作合同、任务效果分别报告。

## 6. 推荐拆分批次和完成标准

| 批次 | 前置 | 改动 | 验收/停止 |
|---|---|---|---|
| A | 当前179测试基线 | CI + 配置一致性校验 | 干净环境构建通过；缺Guard实例等负例启动即失败 |
| B | A | 共享组装、日志投影、输出布局 | CLI与fixture旧轨迹在去除随机ID/时间后等价；结果语义不变 |
| C | B | Trajectory/Provider/Context同包拆文件 | 公共export/Provider请求fixture/Reducer回归不变 |
| D | C | Runtime纯预检、Inbox、retry分离 | 故障注入事件顺序、审批、Batch、Abort和unknown不变 |
| E | B，可与C/D分开 | 事件订阅、产品TUI | 不阻塞writer，慢订阅可补读，持续输入和多个Run隔离 |
| F | CUA独立验收 | 发布候选 | 当前SHA打包安装+平台支持表；无实际桌面验证的平台只标开发支持 |

“行为保持”不要求所有随机事件字节完全相同；需比较事件类型/因果ID关系/顺序/决策/工具投影，不掩盖有意义变化。遇到行为偏移先拆出单独修复再推进，不把改变悄悄包装成移动文件。

本轮没有创建任何workflow、分支规则或release，也没有commit/push。

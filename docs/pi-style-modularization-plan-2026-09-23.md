# Pi 式模块化改造路线与阶段验收

状态：第一、第二切片已完成离线实现与定点复审；第三切片（内置后端策略边界）尚未开始。基线 `73412c8`；仅在 `codex/pi-style-harness` 工作树实施。本计划借鉴 Pi 的薄执行循环、统一会话与可扩展装配，不复制其文本/编码 Agent 工具模型。GUI 的 Observation、动作前置校验、未知副作用和 Event/Trajectory 仍是不可绕开的核心合同。

## 目标与不变量

产品默认配置应开箱即用；开发者也能以 TypeScript 代码替换 Provider、Computer、Context、工具与策略，而不修改主循环。CLI/TUI 是同一装配的界面，不能各自维护工具清单。关闭可选模块后不应残留工具 schema、提示词或副作用。每个 Run 固定其配置和依赖，不做热替换。Jev 仅保留研究结论；未来若证明收益，应是可选的、受核心准入约束的局部决策实现，不成为主 Provider 或主循环的特殊分支。

差异化不是复刻 Pi 的编码 Agent。产品方向同时保留三条可独立验证的轴：可分包替换的 GUI Runtime；基于轨迹与评测的受控改进循环；面向无障碍、适老化的交互与个性化配置。默认产品可以精简，但不能因为“极简”丢掉 GUI 状态、事件和安全语义。

## 自进化与用户体验的边界

- **分包自进化**：Provider、Grounding、Context、Memory、Monitor/Policy、交互界面应能分别更换和做版本化对照；一次实验只升级被测包，固定任务集和其他依赖，用 Task Success、无效动作、纠正次数、延迟与成本共同判断是否保留。轨迹是证据源，不能把模型自评当作成绩。首版先支持显式装配与版本记录，不做自动改代码、自动发布或在线自修改。
- **无障碍/适老化**：语音输入/播报、较慢的确认节奏、清晰的状态反馈、键盘可达和低视觉负担应在 UI/交互层配置；不应以年龄标签推断能力，也不能靠改变 Provider Prompt 代替界面可用性。完成基础 SDK/TUI 稳定化后，用真实用户流程验证，不与这一轮装配改造混测。
- **个性化**：区分本次 Run 偏好、用户显式保存的长期偏好，以及待核实的模型推断。默认仅本次 Run；长期保存需明确同意、可查看/纠正/删除、作用域和失效规则。敏感账户、健康、财产信息不得由普通轨迹自动晋升为长期 Memory。Context 只纳入当前任务相关且仍有效的偏好，并记录其来源和使用位置。
- **Jev/快决策**：未来可作为可替换的局部决策策略做 A/B；必须实际减少主 Provider 请求且不降低任务成功率。不能为使用 Jev 而让主模型额外输出机械字段或使主循环依赖某个模型。

## 当前事实与缺口

`packages/runtime` 已定义 Provider、Computer、ContextCompiler、ToolRegistry 合同；`packages/app-runtime` 的 `RunDependencies` 已可注入多数实现。但 `ResolvedRunConfig.model`、`ComputerBackendConfig` 是内置封闭联合；默认装配在 `providers.ts`、`computers.ts`，而 `run-factory.ts` 含 CUA/DOM/窗口专属校验与工具筛选。现状更像内部测试注入，不是清晰的外部 SDK。直接把全部模块改成动态插件会扩大安全与兼容面。

## 施工顺序

1. **第一切片：显式应用装配。** 定义稳定的 SDK 入口和 `createRun` 使用示例：默认内置装配与开发者替换 Provider/Computer/Context/ToolRegistry 至少一条端到端路径。外部实现仍须返回现有合同类型；不增加无消费者字段。内置 GLM/Qwen、CUA/OSWorld 行为保持不变。
2. **第二切片：模块组合与易用入口。** Planning/Memory 先形成协调的 Run 范围模块；并行收敛 TUI 首页、安全状态和单一启动入口。下节给出合同和体验验收。
3. **第三切片：内置后端策略边界。** 将 CUA/DOM/窗口专属准备与工具限制收束到 Computer 装配策略；核心 Runtime 只消费统一能力/工具视图。迁移时保留旧路径回归，再删重复分支。
4. **第四切片：可分发包。** 在外部替换链路和模块组合通过后，确定 package exports、peer dependency、版本边界和安装/发现机制；不提前加入任意路径加载、热重载或插件市场。
5. **差异化验证。** 在稳定装配上分别建立分包改进实验、无障碍/适老化用户流程、个性化偏好生命周期测试；三条线分别验收，不能用架构可插拔推断体验已改善。

## 第二切片：模块合同与易用入口

模块线先让 Planning 与 Run Memory 能以**整组行为**替换，而非仅换 Store：工具定义、状态写入/重建、Context 投影或召回必须由同一个 Run 范围的模块实例协调。兼容现有 `PlanState`/`MemoryState`、`PlanningTaskMutation`/`MemoryMutation` 与 Event/Replay；如果想改状态语义，要另行设计协议迁移，不能在装配层偷偷塞 opaque 字段。默认实现仍来自现有 planning/memory 包。RunDependencies 的旧工厂保持兼容，但新旧入口同时提供同一模块时应明确报错或有文档化优先级，不能默默混合。模块关闭时不创建 Store、工具、Context 内容或额外模型请求。至少做两个 Run 的隔离测试、模块单开/全关测试、工具实际执行/回放测试，以及自定义模块与默认模块的对照。

体验线不改核心 Runtime。把 TUI 首页变成“当前目标、目标窗口/桌面、模型、模式、安全状态、开始动作”一眼可见的工作台；高级开关保留但从主流程退后。现有的左侧终端/右侧操作窗不应被 TUI 重绘或额外弹窗打断。以已有 `.harness.local.psd1` 为机器设置，用户偏好与机器路径/密钥分离；不要把凭据显示在 TUI 或写入报告。首次缺配置时给出一条具体可执行的修复提示，默认设置不得绕过交互 Guard。键盘路径必须全程可见，确认、暂停、纠正、错误状态有文字而非只靠颜色，窄终端和屏幕阅读器式线性读取不丢关键信息。先收敛成单一入口命令；真正免命令行的桌面启动器单列后续交付，不能把脚本伪称已实现原生 App。

两条线可在独立文件范围并行，先分别通过测试，再做一次统一 TUI→Run 装配验收。分包是后续自进化的实验边界：替换某模块时应能记录其身份/版本、固定其余组合并比较轨迹；本切片只定义合理边界，不自动改写代码或提升未经人工核验的策略。

第二切片结果：Planning/Run Memory 已有协调的 Run-scoped 模块入口、状态副本隔离、有界关闭与离线 `restoreFromEvents`；TUI 首页保留安全状态与草稿，20×12 下可进入只读详情翻页，另提供需用户显式安装的 Windows 快捷方式。最终离线 `pnpm typecheck` 与 `pnpm test` 通过（584 项 Vitest、19 项 TAP，1 项 Windows 符号链接跳过），快捷方式仅在注入临时目录测试。仍未完成真实桌面、读屏、快捷方式点击或策略效果验证；模块身份/版本的 Run 报告记录属于后续自进化实验基础工作。

## 第一切片验收

- 内置配置与基线的模型输入、工具投影、Event/Trajectory、审批和 Abort 语义无回归。
- 外部示例包无需修改 Runtime 或 app-runtime 源码即可接入一个 Mock Computer 和一个 Mock Provider，完成 Observe→Tool→Receipt→Observe→Finish；同一入口可注入自定义 Context/ToolRegistry。
- 错误配置在 Run 启动前明确失败，不能静默回落到 GLM/CUA；依赖只在选中时初始化和关闭。
- `pnpm typecheck`、离线测试、SDK 集成测试通过；真实 API/桌面测试另行授权和记录，不能用 mock 成绩宣称产品体验已改善。

第一切片结果：新增 `createRunFactory` workspace SDK 入口；显式 external Provider/Computer descriptor、对应注入工厂、实际能力投影和报告身份；正常/失败/未启动路径有界释放 adapter。Mock Run 覆盖两轮观察与动作回执、跨 Run 隔离、能力拒绝和失败清理。离线 `pnpm typecheck`、`pnpm test` 通过（572 项 Vitest、19 项 TAP，另 1 项 Windows 符号链接跳过）。这只证明装配链路，不证明可发布包或真实体验。

已知边界：external Computer 暂不能使用 app-managed UIA/DOM grounding；riskModel 仍只接受内置模型；自定义 ToolRegistry 在 Planning/Memory 开启时仍由 app-runtime 追加对应工具，不是任意工具完全替换；内置配置配合测试注入工厂时，报告仍记录配置选择值。第二切片应处理适配策略的边界，但不得把上述限制误写成已解决。

## 审计重点与停止条件

审计检查 SDK 是否只是给已有测试缝换名、是否仍要求外部开发者修改闭合联合或 CLI、是否出现两套 ToolRegistry/Context、是否把敏感配置写入事件、是否削弱 GUI 安全边界。若第一切片必须大改 RunController 或 CUA 私有协议，停止并回到装配层缩小改动。不得为了 Pi 相似度增添没有真实生产者/消费者的抽象。

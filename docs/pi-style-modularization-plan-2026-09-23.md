# Pi 式模块化改造：第一条纵向切片

状态：第一切片已完成离线实现与定点复审；第二切片尚未开始。基线 `73412c8`；仅在 `codex/pi-style-harness` 工作树实施。本计划借鉴 Pi 的薄执行循环、统一会话与可扩展装配，不复制其文本/编码 Agent 工具模型。GUI 的 Observation、动作前置校验、未知副作用和 Event/Trajectory 仍是不可绕开的核心合同。

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
2. **第二切片：移出内置分支的产品策略。** 将 CUA/DOM/窗口专属准备、工具可用性和清理收束到 Computer 侧或明确的应用装配策略；核心 Runtime 只消费统一能力/工具视图，不能通过 `kind === "cua"` 决定通用生命周期。迁移时先保留旧路径回归，再删除重复逻辑。
3. **第三切片：可分发包。** 有一条外部替换链路通过后，再确定 package exports、peer dependency、版本边界和安装/发现机制。第一轮不做任意路径自动加载、热重载或插件市场。
4. **体验收敛。** 默认 TUI/CLI 以同一 Run 装配运行；文档给出最小外部 Provider 或 Computer 示例及恢复默认配置的方法。
5. **差异化验证。** 在稳定装配上分别建立分包改进实验、无障碍/适老化用户流程、个性化偏好生命周期测试；三条线分别验收，不能用架构可插拔推断体验已改善。

## 第一切片验收

- 内置配置与基线的模型输入、工具投影、Event/Trajectory、审批和 Abort 语义无回归。
- 外部示例包无需修改 Runtime 或 app-runtime 源码即可接入一个 Mock Computer 和一个 Mock Provider，完成 Observe→Tool→Receipt→Observe→Finish；同一入口可注入自定义 Context/ToolRegistry。
- 错误配置在 Run 启动前明确失败，不能静默回落到 GLM/CUA；依赖只在选中时初始化和关闭。
- `pnpm typecheck`、离线测试、SDK 集成测试通过；真实 API/桌面测试另行授权和记录，不能用 mock 成绩宣称产品体验已改善。

第一切片结果：新增 `createRunFactory` workspace SDK 入口；显式 external Provider/Computer descriptor、对应注入工厂、实际能力投影和报告身份；正常/失败/未启动路径有界释放 adapter。Mock Run 覆盖两轮观察与动作回执、跨 Run 隔离、能力拒绝和失败清理。离线 `pnpm typecheck`、`pnpm test` 通过（572 项 Vitest、19 项 TAP，另 1 项 Windows 符号链接跳过）。这只证明装配链路，不证明可发布包或真实体验。

已知边界：external Computer 暂不能使用 app-managed UIA/DOM grounding；riskModel 仍只接受内置模型；自定义 ToolRegistry 在 Planning/Memory 开启时仍由 app-runtime 追加对应工具，不是任意工具完全替换；内置配置配合测试注入工厂时，报告仍记录配置选择值。第二切片应处理适配策略的边界，但不得把上述限制误写成已解决。

## 审计重点与停止条件

审计检查 SDK 是否只是给已有测试缝换名、是否仍要求外部开发者修改闭合联合或 CLI、是否出现两套 ToolRegistry/Context、是否把敏感配置写入事件、是否削弱 GUI 安全边界。若第一切片必须大改 RunController 或 CUA 私有协议，停止并回到装配层缩小改动。不得为了 Pi 相似度增添没有真实生产者/消费者的抽象。

# Pi 第三切片：Computer 装配边界与实机烟测

状态：装配边界已实施，离线定向审查通过；真实 GLM＋CUA 任务进入模型和动作链路，但因前台目标未确认而失败，不能宣称实机任务验收通过。

## 本次改动

`packages/app-runtime/src/computers.ts` 的 `prepareComputerRunAssembly` 统一负责 CUA/UIA/DOM 的 Run 前校验、有效 Computer 配置、Grounding 工具和窗口模式工具白名单。`run-factory.ts` 只消费该装配结果，再建立 Provider、Computer、ToolRegistry 和 Controller；通用 Runtime/协议未加入 CUA 私有分支。无效 UIA 窗口目标、DOM URL/profile、非 CUA grounding 在创建输出/Event 资源前失败。直接调用 `createComputer()` 的 managed-browser 配置仍独立校验，避免绕过 Run 装配。

窗口工具边界保持原样：background 仅 `click/wait`；foreground 可额外 `type/keypress/hotkey/drag/scroll`；启用 Grounding 才暴露 `click_element`，managed DOM/hybrid 才暴露 `select_option`。自定义注册的未验证 Computer 工具不会因窗口模式而进入 ModelInput；即使 Provider 强行返回调用，Runtime 仍拒绝，且不执行该工具的动作转换。桌面、OSWorld 和 external Computer 不套用 CUA 窗口白名单；external 仍不能选用 app-managed Grounding。

## 验证事实

- 实施 Agent 的 app-runtime 定向测试 77 项及包构建通过；随后新增 Run 级未验证工具回归，`run-factory.test.ts` 23 项通过。Sol 集中只读复审未发现 P0/P1/P2 回归。
- 本轮根 `pnpm run build` 通过。`pnpm test` 首次被 Windows＋隔离 Node 的 `spawnSync pnpm.cmd EINVAL` 包装脚本问题阻断；修正为固定参数的 `cmd.exe` 分派后，全仓 Vitest 50 文件、587 项通过，Node TAP 19 项通过、1 项因本机无法创建符号链接而跳过。
- 真实测试用本机官方 CUA 0.22.2、隔离 WinForms 文本 fixture 和 GLM-5.3-Flash。截图随模型请求发送到 GLM；原始运行产物只位于 Git 忽略的 `runs/pi-slice3-smoke/`，未复制密钥，也未向公开仓库提交截图或运行目录。
- `run-01`：旧 runner 的 2 秒 daemon `status` 子检查超时，fixture 和模型均未启动。将此测试脚本的子检查延长为最多 8 秒、仍受总启动期限约束。
- `run-02`：daemon 子检查仍超时；仅延长总启动时间不足以解决该脚本问题，模型未启动。
- `run-03`：daemon 与 fixture 启动，但测试清单误填了 fixture 初始文本，runner 在调用模型前拒绝继续。清单已修正。
- `run-04`：完整进入 CLI→CUA observation→GLM→ToolCall→Runtime 校验→CUA action receipt→复观察。10 次模型请求、8 次 GUI 动作均收到 `CUA_TOOL_REFUSED/foreground_unavailable`，随后 2 次调用因动作预算被拒，最终 `runtimeOutcome=budget_exhausted`、fixture 精确文本评分 `false`。Provider 请求未报传输错误；fixture 文本保持原值，未发生误输入。daemon 和 fixture 均由 runner 清理；CUA 的 `kill_app` 返回 `foreign_process_termination_denied`，runner 使用其自有 PID 的兜底结束，未留下该 fixture 进程。

## 判断与下一步

这次失败不指向新装配策略本身。旧 Stage-4 runner 使用整桌面观察；测试时目标 fixture 被别的窗口遮住，模型从整桌面截图无法定位目标，尝试切换窗口。CUA 随后无法确认目标窗口处于前台，按原有安全规则拒绝派发动作。这证明拒绝路径和预算路径保持工作，但没有证明窗口模式的正向操作链路。

下一次正向验收应使用 runner 自己发现的精确 fixture PID/window ID，把 Run 显式绑定到该窗口；测试目标和评分应只依赖 fixture 自有状态。若需 `type`，必须显式选择并实测 foreground delivery，不能暗中将 background 放宽。测试期间确保目标窗口未被其他窗口抢占；若前台确认仍失败，记录为平台/驱动边界，不通过降低校验强行通过。完成该受控正向验收后，再以独立任务检验 TUI、真实应用与用户体验。

## 直接输入 goal 的窗口发现边界

当前 `ApplicationSession` 的窗口发现只供 Host/TUI 使用，且仅在没有活动 Run 时列候选；TUI 的 `W` 让用户显式绑定窗口。模型当前没有 `list_windows`/`select_window` 工具，也不能在单个 Run 中随意把 ComputerSession 切到另一个进程。直接输入 goal 不等于自动授权模型观察或操作任意已登录窗口。

后续的 TUI 切片已实现 **Run 前本地匹配**：先枚举可见窗口，仅当 goal 与唯一候选存在可信应用/标题身份对应时自动绑定并开始；不确定、多个匹配、发现失败时保留 goal，进入可滚动的手选列表。显式选择的窗口或 desktop 始终优先，managed browser 路径保持自身所有权。此切片只有离线测试，未做真实桌面选窗准确率验收；它不是“主模型自己调用选窗工具”。

若以后加入 Jev 辅助排名，也应只返回当次候选 ID，由 Host 核对实时窗口身份并遵守现有权限闸门。候选标题可能含隐私或恶意指令，外发前须单独同意。实验设计和停止条件见[选窗 Jev 候选实验](./pi-window-selection-jev-experiment-2026-09-23.md)。跨应用任务仍需要明确切换边界和重新观察，不能在旧 Observation 上继续动作。

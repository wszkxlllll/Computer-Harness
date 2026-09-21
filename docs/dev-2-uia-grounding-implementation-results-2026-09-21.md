# UIA Grounding 实施结果（2026-09-21）

状态：**已完成离线可控入口，并完成自有 WinForms fixture 的生产链路探针；真实应用/真实任务仍未宣称通过。**

## 实施范围

- 新增公共 `GroundingCatalog` / `GroundingElement` / `GroundingBoundingBox` 合同。
- `ObservationFrame` 与 `ObservationCapture` 可携带同一 observation/session 绑定的目录；原始 UIA 树、PID/HWND、snapshot token 和原始 value 不进入公共协议。
- CUA Adapter 新增 `grounding: "off" | "uia-catalog-v1"`。只有显式 window target 才允许启用；默认关闭，desktop 和 OSWorld 不变。
- window observation 后调用 `get_window_state`（无截图），使用深度 16、最多 256 个元素，先把 desktop-origin UIA frame 转为 window-local native pixels，再按 `viewport/bounds` 比例映射到截图的 physical pixels。Adapter 先保留最多 256 个脱敏安全候选；Runtime 在落盘前用 goal、最近纠正和可选活动计划做无模型调用的确定性 lexical 选择，最多保留 16 个 hot elements，并把 strategy、候选数、选中 ref 与有限 reason code 写入 selection/ContextTrace。Adapter 私有 ref map 保留安全候选，selected ref 仍可由 `click_element` 解析。
- UIA 查询失败仍返回截图，但目录为 `unknown/degraded`；元素 ref 含 observation-local discriminator，只在对应 observation/session/geometry 内有效；Abort 不会被降级吞掉。
- ToolRegistry 仅在该 Run 启用时增加 `click_element({ elementRef })`。Runtime 从当前 catalog 计算 bbox 中心，并拒绝明确 `enabled=false` 的元素；CUA 再用 adapter-private ref map 校验 ref、geometry、中心点和 disabled 状态，然后复用现有 click ActionIntent、budget、policy、guard、Monitor、Receipt 和 Event 链路。
- Context 在最新截图附近注入有限 grounding 文本，计入 token budget，并在 `ContextTrace.grounding` 记录 present/projected/truncated/completeness/count/token estimate；不进入稳定 system prefix。
- TUI `F` 页面和 CLI `--grounding off|uia-catalog-v1` 已接入；启用时无显式 CUA window target 会拒绝启动。报告记录实际模式。
- GLM 与 Qwen 继续从统一 ToolRegistry 投影 `click_element`，没有新增 Provider 私有工具表。
- `GroundingSelector` 位于 Runtime，Computer 不反向依赖 Context；默认 `DeterministicGroundingSelector` 可替换。没有 query 命中时仍按 focused/editable/enabled/bbox 和原始稳定顺序回退；goal 命中可提升原始候选第 20 位之外的元素。disabled 元素可以作为证据投影，但永远不能执行点击。

## 验证

本轮离线验证通过：

- `pnpm run typecheck`
- `pnpm --filter @computer-harness/cua-driver-spike exec tsx uia-grounding-production-probe.ts --binary <private-cua-driver> --socket <private-private-socket> --output <redacted-output> --session <private-session>`（自有 fixture、无模型请求）
- CUA focused tests：22 项通过
- Runtime computer tools：6 项通过
- Runtime grounding selector：5 项通过（含中文 2/3-gram、goal/correction、>64 candidate `click_element`）
- Context：25 项通过
- Trajectory schema：33 项通过
- App Runtime：14 项通过
- ApplicationSession grounding wiring：8 项通过
- CLI TUI：23 项通过
- GLM/Qwen provider focused tests：包含 `click_element` schema/调用投影回归

最终全量离线回归：38 个测试文件、447 项测试通过；`pnpm run typecheck` 通过。

覆盖的反例包括：grounding 关闭基线、catalog 上限与脱敏、partial/unknown/degraded、当前 ref 中心映射、旧 observation、resize/geometry stale、窗口目标缺失、Context budget omission、TUI/CLI 配置、统一 Provider schema 和 trajectory schema。

## 自有 fixture 生产探针结果

探针使用私有 CUA Driver 0.22.2 和临时 WinForms fixture，不读取 `.env`、不调用模型、不触碰用户窗口，也不停止共享 daemon。最近一轮摘要保存在本地运行目录的 `runs/uia-grounding-production-20260921-r14/uia-grounding-production-summary.json`，不保存截图、窗口标题或原始控件值。

- `open(window target, foreground, uia-catalog-v1) → observe` 成功，实际 screenshot viewport 为 physical `1356×917`。
- 生产 `get_window_state` 返回 5 个安全元素（Button、Edit、MenuItem、TitleBar），ref 均带 observation discriminator；目录为 `partial`，没有静默声称完整。
- 通过生产 `groundingComputerTools().toAction` 选择自有 enabled Button，生产 CUA adapter 执行一次 click，fixture 布尔 oracle 确认命中；全链路 `modelRequests=0`、`productionActionCount=1`。
- fresh observe 生成不同 ref；复用旧 ref 被生产 adapter 拒绝为 `STALE_OBSERVATION`，没有发出第二次 CUA click。
- 该 CUA/WinForms 组合没有在真实 `get_window_state` 中暴露 `enabled=false` 元素（禁用 Button/MenuItem 仍被报告为 enabled/或没有该字段），因此“生产禁用元素拒绝”本次只能由 adapter/runtime 单测覆盖，不能宣称 live disabled verification 通过。这是基础设施返回形状限制，不应在 Harness 中把缺失状态推断成可点击；探针明确记录 `coreOk=true`、`disabledVerified=false`、`complete=false`，而不是把部分通过报告为完整通过。

结论：**启用元素的生产闭环和 stale 防护可继续作为实验基础；禁用状态必须保持 fail-closed，并在 CUA 返回真实 disabled evidence 后补 live 验收。**

## 最新真实高德轨迹的边界证据

对本地 TUI Run `runs/travel/tui-20260920-170623-ff35c77b/run-1789924020843-b1690806-eb2` 重新用离线 metrics 聚合（不读取 Provider 原文、不判断业务正确性）得到：

- 实际模式为 `uia-catalog-v1`；8 次 observation 都有 catalog，均为 `partial`、`degraded=false`、`truncated=true`。
- UIA 每次约返回 20 个候选，Context 每次投影 16 个；7 次 Context 的 grounding 估算均为约 517 tokens。
- selector 记录了 `deterministic-lexical-v1` 和 `query_match`，但本轨迹实际 `click_element` received/completed/rejected/failed 均为 0。
- 该真实 Edge/高德场景的 catalog 主要是 Edge chrome 层候选，没有可用于网页输入的 Edit 元素；因此 UIA 当前没有解决高德网页下拉框/输入框的视觉错位问题，不能把 WinForms fixture 的 enabled click 结果外推到网页。

该 TUI Run 使用的是深度 8/旧候选上限，不能代表刚调整的 depth16/max256 生产配置；要验证新配置必须在当前窗口身份上重新启动一次实时 Run。TUI 记录中的 PID/windowId 是历史窗口身份，窗口重启或 Edge 重建后立即失效，不能复制到下一次运行；应每次用当前 TUI 的窗口选择重新绑定。该 TUI Run 没有 travel `trial.json`，所以通用 metrics 的 `dataQuality` 会标为 partial；上述 grounding 数字来自其 summary/trajectory 的可观测记录，仍不代表路线业务成功或失败。下一步应把“网页 DOM/可访问性元素缺失”作为独立能力边界记录，而不是继续扩大 UIA prompt 或把 chrome 候选当作网页控件。

补充的 depth 矩阵 probe 表明：depth8 只有约 12 个 chrome 元素；depth16 才出现 `Document` 和 2 个内容区 `Edit`，约 85–161 个元素；depth24/32 没有继续增加，max_elements 256 已足够，512 没有收益。因此当前实现采用 depth16/max256，但真实高德网页是否能稳定暴露可用网页 Edit，仍须用实时窗口 Run 验证。

## 尚未验证

- 真实 Edge、微信、小程序或高德的 UIA 覆盖与焦点语义。
- 真实模型选择 `click_element` 后的业务成功率。
- 浏览器 DOM grounding；它仍应作为独立 Browser/DOM provider 研究。
- UIA 元素状态跨动作的可靠变化检测；Monitor 当前只能复用已有 transition 旁路，不能把截图或 UIA 变化当作业务成功。
- OSWorld 不启用该能力。

## 当前实验命令

构建后，在已准备的 CUA daemon 和已由用户选择的窗口上运行：

```text
node apps/cli/dist/index.js --goal "<approved-goal>" --model glm-5.3-flash --computer cua --cua-socket "<socket>" --cua-window-pid <pid> --cua-window-id <window-id> --grounding uia-catalog-v1 --output "runs/uia-grounding" --env-file ".env"
```

实验只允许使用自有 fixture 或用户明确授权的窗口；本记录没有调用模型 API、读取 `.env`、操作真实用户窗口或停止共享 daemon。

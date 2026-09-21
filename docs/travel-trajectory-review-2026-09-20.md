# 出行 TUI 最新轨迹审计（2026-09-20）

## 结论

最新一次 T01 风格运行是一条有价值的“失败—人工纠正—恢复”样例，不是纯自动成功基线。Runtime 最终以 `succeeded` 结束并生成完整调查报告，但业务结果仍是 `manual_pending`，必须由人工核对。

审计对象为本地 `runs/travel/tui-20260920-142759-f5afec33/run-1789914515659-16914aea-01c`。运行产物和截图不提交仓库；本文只保留非敏感结论。

## 点击偏移与人工纠正

模型连续给出 `(1441,524)`、`(1440,524)` 等坐标，而截图中的下拉框中心约为 `(1436,499)`。因此这次失败来自视觉坐标 grounding 偏下，不是窗口坐标映射错误；轨迹中没有 `WINDOW_GEOMETRY_CHANGED`、Computer 执行失败或 Provider 错误。

Monitor 拒绝了第三次完全相同的点击，但模型换成相邻坐标后仍可继续尝试。这证明当前机制能阻止 exact repeat，不能识别“附近但仍错误”的点击。用户输入“点击选择框中心、当前位置偏下”后，该纠正作为权威输入进入下一轮，模型改点 `(1436,499)` 并继续执行。

中心点击后的截图只有少量字节变化，Monitor 将其标为 `changed`，但控件值并未立即改变；随后 `DOWN` 才把值改为新的时间段。因此 `changed` 只表示截图字节变化，不代表控件或业务语义成功。

## Memory 是否产生作用

本次不是一次，而是两次 `memory_write_fact`：

1. 写入候选车次、余票及“票价待查”；
2. 查询票价后以新事实 supersede 旧事实，补齐票价和来源。

第一条事实在后续跨页面阶段被 Context 自动召回约 17 次；历史裁剪后仍保留，随后被第二条事实正确替换。这证明了以下闭环：

```text
阶段性事实写入 → 历史裁剪 → 自动召回 → 跨页面继续 → 新事实替换旧事实 → 最终报告消费
```

它没有修复点击定位，也不能单独证明 Memory 提升了成功率；需要 Memory off/on 对照才能判断净收益。第二次写入发生在结束前，主要价值是状态一致和留痕。

## 可量化事实

- 31 次模型请求，27 个 GUI 动作，运行约 6 分 48 秒；
- 输入约 52.6 万 tokens，Context 成本仍高；
- 3 次 `unchanged` transition，1 次 exact-repeat 拒绝，1 次人工纠正；
- Planning 0 次，真正的 multi-call Batch 0 次；
- Memory 写入 2 次，旧事实被 supersede；
- Guard 关闭，没有风险评估或审批；
- 业务结果尚未人工确认。

## 研究价值与后续用途

建议将该轨迹标记为：`coordinate_grounding_failure`、`nearby_wrong_click`、`exact_repeat_monitor_block`、`semantic_noop_after_visual_change`、`human_correction_resume`、`memory_write_supersede`、`cross_page_task`、`manual_business_review_required`。

它适合用于：

1. 验证 UIA/DOM 的有界 GroundingCatalog 是否减少坐标误点；
2. 改进 Monitor，使“截图变化”与“目标控件语义变化”分开；
3. 对照 Memory on/off 的跨页面事实保持与 token 成本；
4. 检查人工纠正后的恢复质量；
5. 说明 Tool Receipt 只证明输入事件已发送，不能证明页面目标已达成。

它不应计入“全自主成功”，也不能用于宣称 UIA/DOM 已产品化。UIA 目前仅完成自有 fixture 的只读 probe。

## 同一 TUI Session 的后续两次实验

### 携程 T03 风格任务

运行 `run-1789916040167-fce2232c-4a0` 正常结束：23 个 GUI 动作、24 次模型请求、无 Tool/Provider/Runtime 错误，也没有人工纠正。模型报告了 G7004 与 G7268 两个候选，总耗时约 4 分 44 秒，输入约 22.9 万 tokens。

该 Run 可作为当前窗口链路的首个无人工纠正正例，但业务状态仍是 `manual_pending`。最终报告需人工核对车次、具体站点、时间、票价和“附加费用未知”是否均来自页面；`runtimeOutcome=succeeded` 仍不能代替业务验收。本 Run 虽启用了 research 组合，但 Planning、Memory、Batch 与 Monitor guidance 均未实际触发，因此不能据此评价这些模块的效果。

### 高德 T11 风格任务

运行 `run-1789916407070-e0a10ee9-b07` 在用户取消前没有完成。关键事实是：

- 模型多次点击起点区域并执行 `type("人民广场地铁站")`；CUA Receipt 均只证明 SendInput 已发送；
- fresh observation 中起点始终保持“我的位置”或“请输入起点”，没有出现输入文本；
- 单键 `A`、独立 `Ctrl+A`、以及一次 `click → Ctrl+A → type` Batch 都没有把文本写入控件；
- 后续截图出现网页正文整体选中，说明快捷键作用在 document，而不是目标输入元素；
- 两次用户纠正都正确暂停、使旧调用失效并恢复 Run，但没有改变焦点事实；
- 最后一次 `model.request.failed(category=cancelled)` 的直接原因是 TUI `Ctrl+C`，不是另一个网络错误。

因此这不是中文编码问题，也不是 `type_text` 调用没有发出，而是“视觉上点击了输入行，但真实 DOM/可访问性焦点没有进入可编辑元素”。窗口级截图和 byte-diff Monitor 看不到 `activeElement`，所以每次局部渲染变化都被记为 `changed`，仍不能判断输入是否成功。

这条轨迹适合作为 UIA/DOM grounding 的首个真实失败样例：未来应让受限 GroundingCatalog 暴露 focusable/editable 元素、Observation-bound bbox 和低敏状态，并让 Monitor 使用“目标字段值或 focused/editable 状态是否变化”的证据，而不是继续增加坐标或提示词特例。接入前不应把 WinForms UIA probe 外推为高德网页已支持。

## 2026-09-21 跨应用新任务：UIA 正例后的自定义控件边界

运行 `run-1789958527612-2a1c632b-6c8` 完成了携程阶段，并在高德生成了杭州东站到断桥残雪的公共交通路线；但在把偏好从“换乘少”改为较短耗时时卡住，最终由用户取消。这不是整个窗口坐标变换再次失效：

- 模型的窗口内点 `(96,381)` 被稳定映射到屏幕点 `(845,445)`，与截图中“换乘少”区域一致；
- 相邻点、短拖拽和键盘方向键均未改变页面；Computer Receipt 只能证明 `SendInput` 已发送；
- 24 个 GUI 动作均在 Driver 层完成，没有 Tool/Runtime 拒绝或失败；任务因 TUI `Ctrl+C` 结束；
- Monitor 记录 5 次 `unchanged`，产生 2 次 guidance，并在第三次持续无变化后正确暂停、请求人工确认；用户回复“现在是正确的道路，只是你点击没有效果”后，模型才改用拖拽和键盘继续尝试；因此检测与求助本身生效，缺口在人工反馈后的结构化恢复语义和二次尝试预算；
- 26 个 Observation 都含 UIA catalog，平均有 128.5 个安全候选、投影 16 个热元素，但 `click_element` 调用为 0。

为区分“Selector 没选中”与“底层没暴露”，又对同一 Edge 目标执行了无截图、无输入、无模型请求的只读 `get_window_state` 探针。首次 depth16/256 返回 167 个元素，但没有名称包含“换乘”、“较快”或“较短”的元素，历史点击点也不落在任何 UIA bbox 内。随后在同一当前页面上把上限提高到512，分别使用 depth16/24/32，三档都返回相同的162个元素，仍然是零匹配。因此本次不是 UIA 深度不够，而是高德自定义控件没有通过 Windows UIA 暴露；不能只靠扩大深度或改 Selector 排序解决。

本次与上一次成功 Run 并不矛盾：上一次的站点建议文本能被 UIA 暴露，`click_element` 4/4 成功；本次的自定义偏好下拉未暴露，所以回退为视觉坐标路径。UIA 是有价值的补充信号，不是网页 DOM 的完整替代。

### 修复优先级

1. **P0 恢复策略**：保留已实现的“两次 guidance 后暂停并求助”，不重复建造另一套停止机制。需要补的是结构化的求助回复语义：区分“按当前可见结果交付”、“由用户操作后继续”、“允许一种新策略再试”和“结束”，并对求助后的新策略继续使用有界预算。本例的多条路线耗时已可见，若用户选择按可见结果交付，模型应报告当前最短方案以及偏好控件未切换的限制。
2. **P1 DOM/CDP Grounding**：沿用现有 `GroundingCatalog` / observation-bound ref / `click_element` / Guard / Receipt / Event 链，增加受限、脱敏、有界的浏览器 DOM 生产者；不建第二套 Runtime。
3. **P1 Monitor 与 Grounding 联动**：把最近局部目标、失败区域和 guidance 纳入下一轮有界检索。这可解决“元素已在 UIA/DOM 候选中但没投影”，但不应声称能解决本次“UIA 原始数据本身没有元素”。
4. **P2 语义验证**：Monitor 继续区分“发送成功”、“像素变化”和“目标值已改变”；后两者不能由 Tool Receipt 推导。
# 2026-09-21 托管浏览器首次真实 Hybrid Run 补充审计

最新 session `tui-20260921-103104-8195daf0` 不能归类为“DOM 点击失败”。其事实链为：

- TUI 初始 goal 被误输入为启动命令 `scripts/travel/run.ps1 tui ...`，所以首轮模型合法返回 `interact`，询问真正的 travel 目标；用户随后输入的真实任务已由 `user.input.received` 保存并继续执行。
- 启动 URL 只指定高德；persistent profile 保存登录状态，不等于恢复登录准备阶段的所有 tab。携程页面需要显式导航。
- 窗口绑定与真实 DOM collect 已成功。后续 Observation 为 `source=hybrid`、`degraded=false`，原始计数 UIA 126、DOM 117，去重后239，Runtime投影16项。
- 本 Run 共6个 GUI 动作，全部为 `Ctrl+T / Ctrl+L / type`，没有任何 `click` 或 `click_element`，因此不能用它判断点击能力。
- 模型在 reasoning 中明确计划“type URL 后下一轮 Enter”，但看到地址栏视觉截断后误判成只输入了部分 URL，连续重新聚焦并覆盖输入，始终没有执行 Enter。携程未显示的直接原因是导航没有提交，不是登录态丢失或 DOM transport 失败。
- Run 最后由用户 Ctrl+C 取消；`runtimeOutcome=cancelled`，不是 driver/tool failure。

下一次使用时，PowerShell 只运行启动命令，TUI goal 输入框只输入业务任务。对于以携程为第一阶段的任务，优先将 `ManagedBrowserUrl` 设为携程，减少浏览器地址栏导航步骤。若继续支持跨站任务，应单独评估受限的 managed-browser navigate 能力或明确的地址栏提交恢复规则，不能把视觉截断当成输入失败证据。

## 2026-09-21 完整跨站 Run 与关键修复

运行 `run-1789991423577-6533fdc6-f22` 在同一 managed Edge 窗口内完成了携程车次查询与高德公交接驳查询。页面证据支持 2026-09-22 上海至杭州东的 08:00 后直达候选，以及高德当前时点下 39 分钟、地铁 1 号线 5 站、总步行约 1.4 公里的方案。Runtime 无 Provider、Computer 或 Tool 执行失败，但仍只能判为“部分完成”：最终 `finish.summary` 只报告任务已完成，没有向用户交付 Goal 要求的车次、换乘、步行、观察时点和不确定性明细。

本 Run 同时给出了 DOM 坐标错误的直接证据。DOM 的“到达城市”候选来自页面 CSS viewport，bbox 约为 `(352,317,164,30)`，旧实现却把它直接标记为 physical，最终点击到 `(1227,393)` 且页面无变化；UIA 对同一控件给出的 physical bbox 约为 `(455,506,209,38)`，切换 UIA 后操作成功。该问题不是模型选择错误，而是 Adapter 坐标语义错误。

已完成以下离线修复：

1. Hybrid 模式使用同一 Observation 的 UIA `Document` bbox 作为可信网页内容 physical rect；DOM CSS bbox 再按独立 X/Y 比例与真实原点投影。缺失可信 content rect 时 DOM 候选 fail closed；DOM-only 当前明确 degraded，不再猜浏览器 chrome、侧栏或 DPI。Monitor 的失败区域仍只影响 Runtime 热候选召回，不会伪装成 DOM 采集输入。
2. `terminate.text` 改为必填且必须不是纯状态标签，GLM/Qwen 不再把缺失文本自动降级成成功摘要；统一系统契约要求 `finish.summary` 本身就是完整用户交付，并在 Memory 开启时复核相关事实及其 caveat。一次有界真实 GLM 回归已经从两条 Run Memory 事实生成包含车次、39 分钟方案、换乘/步行、观察时点和不确定性的完整结果。
3. Monitor 的确定性重复拒绝仅针对无变化后的 click-like 动作，不再误伤合法重复的 scroll、type 或 keypress。

全仓验证为 44 个测试文件、505 项测试全部通过，根级 `pnpm run typecheck` 通过。登录态已由独立 persistent-profile 实验验证，不属于本 Run 的阻塞项。

### 修复后的真实点击复验

Run `run-1789994984014-a42f31b1-c12` 已补齐真实复验。模型使用 DOM `click_element` 定位携程“到达城市”，Runtime 投影的窗口内点为 `(559.15, 524.87)`；CUA 执行后页面立即变化，Monitor 记录 `changed`，没有出现旧轨迹中的错位与 `no_observed_change`。随后完成 `Ctrl+A → type("北京") → 选择候选`，最终截图确认到达城市为北京。整个 Run 为4次模型请求、4个动作、0拒绝、0 Tool/Provider/Runtime 错误。

最终 `finish.summary` 不再只是“任务完成”，而是完整说明原值、修改结果、当前页面字段、未搜索/未预订边界，并指出测试 Goal 同时包含“改为北京”和“确认杭州东”的歧义。由此可以放行普通网页文本控件的 Hybrid DOM 点击路径；Canvas、高德自定义地图控件、iframe 和缺少可信 UIA content rect 的页面仍不在该结论范围内。

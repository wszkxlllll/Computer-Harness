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

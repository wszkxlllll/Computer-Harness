# Edge UIA 深度与元素上限探针（2026-09-21）

## 结论

本次只读矩阵表明：当前 Edge 页面内容缺失的首要嫌疑不是 `max_elements=128`，而是生产适配器固定使用 `max_depth=8`。在同一个已知目标身份上，`max_depth=8` 只返回 12 个元素，角色只有 `Button` 和 `Edit`；提高到 `16` 后返回 85–161 个元素，并出现 `Document`、更多 `Edit`、`Text` 和 `Hyperlink`。其中有 2 个 Edit 位于窗口内容区域，而深度 8 没有内容区域 Edit。

`max_depth=24` 与 `32` 没有继续增加元素数；`max_elements=256` 与 `512` 也没有继续增加元素数。因此第一阶段应优先验证 `max_depth=16`，而不是盲目把元素上限扩大到 512。

这次不能直接作为“当前实时 Edge 窗口”的完整验收：矩阵运行时，`list_windows` 没有重新确认到历史运行中的目标 PID/window；但 `get_window_state` 对该身份仍返回了结构化 UIA 状态。这说明 CUA 可能保留了可查询的旧窗口状态，或列表与状态查询的生命周期不一致。生产代码不能把这种状态当作新鲜目标，必须先让目标身份通过 `list_windows` 校验，再使用深度矩阵结论进行实时复测。

## 实验范围与安全边界

- CUA Driver 0.22.2，连接已有共享 daemon；没有停止或重启 daemon。
- 只调用 `list_windows` 和 `get_window_state`；`include_screenshot=false`。
- 没有 click、type、keypress、hotkey、scroll、drag、bring-to-front 或窗口移动。
- 没有调用模型 API，没有读取 `.env`。
- 结果只保存角色计数、元素数量、frame 覆盖率、状态字段覆盖和 Edit 区域计数；不保存窗口标题、元素名称/描述/值或原始 UIA 树。

脚本：`spikes/cua-driver/uia-edge-depth-probe.ts`

脱敏结果位于被 Git 忽略的 `spikes/cua-driver/runs/uia-edge-depth-probe-20260921-r5/`，没有截图或原始响应。

## 脱敏矩阵结果

| `max_depth` | `max_elements` | 返回元素 | 主要角色 | Edit | Document | 内容区 Edit |
| ---: | ---: | ---: | --- | ---: | ---: | ---: |
| 8 | 128/256/512 | 12 | Button 10, Edit 2 | 2 | 0 | 0 |
| 16 | 128 | 85 | Button 12, Edit 3, Document 1, Group 37, Text 32 | 3 | 1 | 2 |
| 16 | 256/512 | 161 | Button 20, Edit 4, Document 2, Group 58, Text 62, Hyperlink 15 | 4 | 2 | 2 |
| 24 | 128 | 85 | 与 depth 16 相同 | 3 | 1 | 2 |
| 24/32 | 256/512 | 161 | 与 depth 16 相同 | 4 | 2 | 2 |

`max_elements=128` 在 depth 16 时返回 85 个元素，`max_elements=256` 才返回 161 个；但这不表示 161 个元素就是完整树。响应仍标记为不完整，且部分元素没有 frame。这里的 `max_elements` 影响可见数量，但不是当前“完全没有网页内容”的主因。

## 对现有实现的影响

历史 probe 运行时 `packages/computer-cua/src/cua-driver-computer.ts` 中的生产请求固定为：

- `max_depth: 8`
- `max_elements: 128`

当前实现已依据本 probe 改为 `max_depth: 16`、`max_elements: 256`；`packages/runtime/src/grounding-selector.ts` 仍只向模型投影 16 个 hot elements。即使把查询深度提高，仍可能因为排序策略优先选择浏览器标签栏、工具栏和地址栏而丢掉网页输入框。矩阵证明“源 UIA 数据中存在内容 Edit/Document”，但没有证明当前 selector 会把它们选入 Context。

因此要分两步处理：

1. **先做适配器深度实验**：在可验证的实时目标上把 `max_depth` 暂时设为 16，`max_elements` 先设为 256，记录目标存在性、返回数量、内容区 Edit 是否出现，以及 Context 投影是否包含该元素。
2. **再做选择器实验**：若原始数据有内容 Edit 但 hot set 仍只有 Chrome UI，调整选择器的结构/区域/交互优先级，并保留当前视觉 `click(x,y)` 作为 fallback。不要先把 hot limit 无上限放大，避免上下文膨胀。

## 下一次实时复测门槛

只有满足以下条件，结果才可用于判断高德输入问题：

- `list_windows` 在同一 probe session 中确认精确目标仍存在；
- `get_window_state` 的返回不是错误或 degraded；
- 不执行任何输入的探针已经看到至少一个内容区域 `Edit` 或 `Document`；
- 将该候选投影到模型上下文后，脱敏轨迹能证明它确实进入 hot set；
- 再单独测试 `click_element → fresh observe → type`，不要同时改变 selector、Monitor 和 Batch。

如果深度 16 的实时探针仍只返回 Chrome 外壳，才需要继续调查 Edge/WebView 的 UIA provider 暴露限制，并转向隔离浏览器 DOM grounding；不能仅凭“加大元素上限”继续堆参数。

## 验证命令

在目标窗口保持打开且已由当前 Harness 目标选择确认后运行：

```powershell
pnpm --dir spikes/cua-driver exec tsx uia-edge-depth-probe.ts -- `
  --socket '\\.\pipe\<shared-cua-socket>' `
  --pid <target-pid> `
  --window-id <target-window-id> `
  --session 'uia-edge-depth-retest' `
  --output 'runs/uia-edge-depth-retest'
```

本探针不修改生产代码，不执行桌面输入，也不提交或推送结果。

# CUA UIA 只读能力探针结果（2026-09-20）

状态：**这是 2026-09-20 的只读探针记录；Windows 自有 fixture 的窄链路已验证。生产侧默认关闭的 `uia-catalog-v1` 后续实施见[UIA Grounding 实施结果](./dev-2-uia-grounding-implementation-results-2026-09-21.md)。**

本记录只覆盖 CUA 0.22.2 的只读观察能力。探针使用独立 named pipe 和本探针编译的 WinForms fixture，只调用 `launch_app` 启动自有 fixture、`list_windows`、`get_window_state` 和 `verify_state`；没有调用 `click`、`type_text`、`press_key`、`hotkey`、`scroll`、`drag`、`bring_to_front` 或 `set_window_frame`。没有模型/API 请求、没有读取 `.env`、没有访问用户 Edge/微信/账号窗口，也没有保存截图、窗口标题、原始 UIA value 或完整 UIA 树。

证据摘要保存在被忽略的 [uia-readonly-summary.json](../runs/uia-readonly-probe-20260920-r3/uia-readonly-summary.json)，探针源码为 [uia-readonly-probe.ts](../spikes/cua-driver/uia-readonly-probe.ts)，fixture 为 [UiaReadonlyFixture.cs](../spikes/cua-driver/fixture/UiaReadonlyFixture.cs)。

## 1. 实际 daemon 能力

真实 inventory 返回 57 个工具，以下三个工具均存在：

| 工具 | required 参数 | 本次调用 | 结果 |
|---|---|---|---|
| `list_windows` | 无 | 是 | 返回自有 fixture 的 PID、window id 和 bounds |
| `get_window_state` | `pid`, `window_id` | 是 | 返回 UIA 元素摘要和 `snapshot_id`；`include_screenshot=false` 时无图片 |
| `verify_state` | `pid`, `window_id`, `expect` | 是 | 窗口存在 + `ComboBox` 元素存在，两条 predicate 均 `satisfied` |

`verify_state` 本次使用 `stable_samples=1`、`timeout_ms=0`，结果为 `status=satisfied`、`stable=true`、`samples=1`。这只证明本地可观察 predicate 成立，不证明业务目标完成。

## 2. UIA 元素结果

完整读取请求使用 `include_screenshot=false`、`max_depth=8`、`max_elements=128`。返回 10 个元素：

```text
Edit: 1
ComboBox: 1
Text: 1
Button: 2
CheckBox: 1
MenuItem: 3
TitleBar: 1
```

10 个元素均带有 name 字段；9 个带有 frame，1 个菜单子项没有 frame。可观察到的状态字段包括：

- `Edit`、`ComboBox`、`Text`、`TitleBar`：`enabled` 与 `value` 字段存在；
- `CheckBox`：`enabled` 与 `selected` 字段存在；
- `Button`、`MenuItem`：`enabled` 字段存在。

探针只记录字段是否存在和 value 的存在性，不记录具体文字或值。返回了 `snapshot_id`，但没有将其内容写入报告。

重要限制：返回的 `elements_complete=false`，即使本次 `returned_element_count` 与 `total_element_count` 都为 10，也不能把这棵树当成完整、穷尽的 Accessibility tree。`degraded` 和 `truncated` 字段没有在该结构化结果中出现，不能擅自解释成“完整”或“发生截断”。较小的 `max_elements` 请求同样返回 `elements_complete=false`，说明边界和搜索域必须保留在结果中。

## 3. 生命周期与 stale 观察

探针只终止并重新启动**自己创建的 fixture**，没有操作任何用户窗口。旧 PID 在替换后不再出现在 `list_windows`，对旧 PID/window id 的 `get_window_state` 返回错误；新 fixture 获得新的 PID。当前 portable 只读结果没有提供可直接消费的 `generation` 字段，因此 Harness 必须在重建后重新发现目标并使旧 `snapshot_id`/element reference 失效。

本轮没有调用 `set_window_frame`，所以不能宣称窗口 resize 后的 stale 行为已经通过。需要下一轮单独的受控几何实验，且必须标为有副作用的 fixture-only probe。

## 4. 给 Provider 的最小投影建议

UIA 不应把原始树、`tree_markdown`、PID/HWND、完整 value 或 snapshot token 直接塞进模型上下文。建议由 Adapter 在当前 Observation 内生成可选、有限大小的 grounding sidecar：

```json
{
  "source": "uia",
  "completeness": "partial",
  "elements": [
    {
      "ref": "element-1",
      "role": "ComboBox",
      "name": "…",
      "bbox": {"x": 390, "y": 491, "width": 510, "height": 30},
      "state": {"enabled": true, "valuePresent": true}
    }
  ]
}
```

实现边界：

1. `ref` 只在当前 Observation/target geometry 内有效，由 Adapter 私有映射到 CUA 的 snapshot/element token；Provider 不得到 PID、window id 或原始 token。
2. 默认只投影当前 viewport 内、与目标相关的少量元素，设置硬上限（例如 8–32 个）；不发送完整 tree，也不为每轮额外调用模型。
3. 默认只给 `valuePresent`、`enabled`、`selected`、`expanded` 等低敏状态；具体 value 需要显式、受权限和脱敏规则控制。
4. `elements_complete=false`、缺 frame、degraded 或查询失败统一标记 `partial/unknown`，不能让模型把“没有找到”理解成“元素不存在”。
5. UIA sidecar 与 screenshot 共用同一 Observation、target identity、geometry revision 和失效规则；导航、窗口重建或 snapshot 更换后，旧 `ref` 必须失效。

## 5. 放行结论

本轮可以确认：**CUA 0.22.2 Windows daemon 能够为自有 WinForms 控件提供只读 UIA role/name/frame/部分 state，并支持窗口存在与角色存在的确定性 `verify_state`。** 这足以进入 Adapter 侧 grounding 设计和 Monitor Transition Evidence 设计。

本轮不能确认：任意真实应用的 UIA 完整性、浏览器原生弹层的 UIA 覆盖、后台输入、焦点稳定性、resize 后 token 失效、跨平台能力，以及 Provider 已经能够消费 UIA。后续实验已补齐默认关闭的生产 Adapter producer、Context consumer、隐私过滤和 GLM/Qwen 离线 schema 回归，但仍没有真实 Edge/微信/高德证据。

后续离线 `GroundingCatalog` 投影、字段预算、ref stale/geometry 拒绝和 Provider schema 回归已记录在[UIA Grounding 实施结果](./dev-2-uia-grounding-implementation-results-2026-09-21.md)；仍不要把 UIA 结果直接等同于真实旅行任务成功。

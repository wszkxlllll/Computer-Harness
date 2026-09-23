# `@computer-harness/computer-cua`

薄的 CUA daemon `Computer` Adapter。它只连接一个由调用方启动的独立 daemon，不启动嵌入式
runtime，也不自动重连或重放 GUI 副作用。

```ts
import { CuaDriverComputer } from "@computer-harness/computer-cua";

const computer = new CuaDriverComputer({
  socketPath: "\\\\.\\pipe\\computer-harness",
  screenshotDir: "runs/screenshots",
});
```

`open → observe → execute → observe → close` 由上层 Runtime 编排。Adapter 私有地维护
`ObservationId` 与 daemon session 的绑定；`ActionReceipt` 只报告 Driver 调用结果，不声称 GUI
目标或用户任务已经完成。

当前支持 primary desktop 的 click、double-click、right-click、type、keypress/hotkey、scroll
和 drag。scroll 使用 `point + direction + positive ticks`，Adapter 将 ticks 映射为 CUA 的
wheel `amount`。Transport 失败后 session 进入失效状态，调用方必须重新 `open()`。

显式 `windowTarget` 时，截图使用 window-local physical pixels，动作携带精确的
`{ pid, window_id }`，绝不静默回退到 primary desktop。默认 `background` 模式只开放
`click` 与 `wait`；经 Host 显式选择并单独验证的 `foreground` 模式才开放
`type`、`keypress`/`hotkey`、`scroll` 和 `drag`。右键与双击仍由 Host 工具 allowlist
拒绝。窗口输入投递可由 Host 显式选择 `windowDeliveryMode: "background" | "foreground"`；
`foreground` 不是回退，但当前仅保证目标动作投递，不承诺每个动作后恢复原前台窗口。
`foreground` 的 scroll 仅在用户保持目标窗口可见且不被其他窗口遮挡的 side-by-side
预览条件下验证过；窗口模式不是 sandbox，也不保证遮挡场景安全。

Window-local `open`/`observe` 对 CUA daemon 短暂返回空图或非法 PNG 的情况执行有界恢复：
最多三次 `verify_state` 只读 capture，每次重做 `list_windows`/geometry discovery，退避固定为 75ms、
150ms（额外等待最多 300ms）。只读 capture 以外的 geometry、权限、transport、身份和
action 错误不会重试；`execute` 永远只向 driver 发一次动作。Abort 在 discovery、退避和
下一次 capture 前后都会阻止继续调用。若三次 capture 最终仍为
`WINDOW_CAPTURE_SCHEMA`，adapter 只再对同一显式 PID/window_id 做一次 fresh discovery，
随后最多调用一次同 session 的 `get_window_state(include_screenshot: true)`；只接受一个
合法 PNG 及 window-local physical 尺寸。fallback 的 identity、geometry、transport、权限、
degraded、Abort 或 schema 失败均 fail-closed，不裁剪 desktop，也不重放动作。

Host picker 可以通过 `CuaWindowDiscovery.listWindows()` 获取只读的窗口身份与本地显示标签。
选择结果必须在每个 Run 中显式传入；新窗口、tab、popup 或 PID/window_id 重建不会自动接管。

UIA grounding 是显式实验开关：`grounding: "uia-catalog-v1"` 必须与 `windowTarget` 一起使用。
每次 window observation 会额外以 depth 16 读取 UIA window state，并返回最多 256 个脱敏安全候选；Runtime 在落盘前确定性选择最多 16 个 hot elements 到
`ObservationCapture.grounding`；原始树、PID/HWND、snapshot token 和控件 value 留在 Adapter
内部或被丢弃。`click_element` 由 Runtime 从当前目录映射为普通 click，Adapter 再校验其
observation/geometry-bound ref；旧 ref、resize、重建或 UIA 查询失败不会静默回退到坐标点击。
默认 `off`，primary desktop 与 OSWorld 不调用 UIA。

Managed DOM grounding 使用 CDP 的 CSS viewport frame，但可执行的 DOM
`click_element` 只在 Hybrid 模式中放行：Adapter 必须从同一 observation 的
UIA `Document` 候选取得可信 physical content rectangle，再进行独立的 x/y
scale 与 origin 投影。当前 `dom-catalog-v1` 没有可信 content-rect producer，
因此保持 degraded empty catalog，不能执行 DOM click；这是一项 fail-closed
边界，不会根据浏览器窗口 bounds、DPI 或工具栏高度猜坐标。DOM/Hybrid 的
transport 仍然是 loopback、managed-browser、observation-bound 的只读 sidecar。

DOM candidate 的 name 使用有界 accessible-name 近似：依次读取 `aria-label`、
`aria-labelledby`、关联 `label`、`title`/`placeholder`，仅 button/link 使用有界可见文本。
select/combobox 的当前选项只作为有界 description；option 列表、DOM id 和 input/password
值不会外发。

在 `hybrid-catalog-v1` 中，Adapter 只有在同一 observation 的 UIA `Document`
候选证明了可信 physical content rect 后，才给 UIA 元素标注粗粒度
`browserRegion`：可靠位于 content rect 内为 `content`，明确位于受控浏览器
viewport 内且与 content rect 不相交为 `chrome`，跨边界或几何不确定为
`unknown`。边界只使用有界的 2px 测量容差，不按固定工具栏高度、Y 坐标或 DPI
猜测。`uia-catalog-v1`、缺少 `Document/contentRect` 的 Hybrid 和普通桌面 UIA
均省略该字段；public catalog 与 adapter-private ref map 使用同一已标注元素，
不会改变执行点或坐标映射。

真实 daemon contract test 属于 S3-4，不由这个 package 的 fake-driver 单元测试替代。

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

真实 daemon contract test 属于 S3-4，不由这个 package 的 fake-driver 单元测试替代。

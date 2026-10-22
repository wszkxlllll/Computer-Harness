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

### 输入审批、浏览器入口与完成证据

- 启用 layered Risk Guard 时，包含 CR、LF、NEL、Unicode 行分隔符或段分隔符的 `type`
  在派发前必须经过一次本地审批，即使声明为可逆编辑或携带 UIA `elementRef`；语义复核不能豁免。
  当前没有可信动作字段证明所有输入路线都保留字面换行。审批说明和对应语音会提醒换行可能成为
  Enter 并触发发送/提交；Guard 关闭时不新增这条审批边界。已有高影响或凭据边界保持优先。
  对 Enter 即发送的控件优先使用单段文字，先观察核对输入，再单独执行有意的发送/提交。
- Host 明确设置 HTTP(S) 受管浏览器入口、启用 `managedBrowserCompanion` 与
  `opened-windows-v1`，且没有预选 native `windowTarget` 时，在首次桌面观察前对精确
  受管浏览器 PID/window_id 尝试一次聚焦。不缩小 desktop Surface、不在每次观察或动作前重激活；
  拒绝或未知聚焦结果继续全桌面观察和手动切窗，Abort 仍传播。`about:blank`、未设置入口、
  已选择 native 目标均不触发此辅助。
- Completion context 要求：发送、保存、编辑、创建等变更声明必须同时由本 Run 对应动作/回执
  和动作后的新 Observation 支持。启动前已有同样结果只是既有状态；未执行或证据不足应报告
  未完成/未知，不能当作本 Run 的成果。此为模型上下文约束，不是额外的自动完成判定器。

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

同次受管主文档采集还可提供独立的 `GroundingCatalog.visibleDocument`：
`source: "dom-document-v1"`、`scope: "current-viewport"`、`completeness: "partial"`。
它不是操作目录，也不是授权；最多 32 个完整 text node、合计 4800 字符、每块 480 字符，
及 4 个真实原生滚动区域。每块都必须以 text-node `Range` 的全部行框、祖先 style/overflow
裁剪、已检查绘制范围与命中结果证明完整可见；部分行、超长节点、超预算节点整块省略，
不拼接片段、不读取整页 `innerText/textContent`，不读取 input/password/contenteditable 值。
隐藏、离屏、覆盖、未绑定 frame/shadow、后台页面、导航/身份或几何不确定时省略证据；
无任何已证明块/区域时省略整个字段，而不是声称页面没有正文或没有可滚动内容。

滚动区域只报告 document viewport 或原生 `overflow-y: auto/scroll` 的当前
`scrollTop/scrollHeight/clientHeight`；CSS 位移实现的自定义滚动不冒充原生滚动状态。
采集不自动滚动、聚焦或点击。伪元素只有在绘制范围能由简单几何或真实祖先 clip 证明时，
才按该范围判遮挡。单个居中、零 spread、正 blur 的普通柔和外阴影视为盒子后方装饰，
不再使整页正文作废；其盒子仍参与遮挡检查。偏移、spread、inset、多重阴影或未知
序列化不使用这条有限规则。其他未证明范围的 generated/shadow/custom/effect paint
仍保守省略整个正文 sidecar，不能仅以 host bbox 不相交推断清晰可读；
缺失不是“没有正文”的证据。
单个完全透明阴影没有绘制效果，CSS 保留的透明零模糊占位不会使正文失效。
正文证明允许轴向单位矩阵和纯二维平移：Range/client rect 已包含浏览器计算的平移，
CSS 长度及轴向裁剪不变；旋转、缩放、3D 或未知矩阵仍拒绝。原表格路径不沿用此扩展。

正文 bbox 与目录的当前 Observation 使用同一 physical 坐标。原生窗口保留原来的
CSS→可信 UIA content rect→capture 映射；desktop 仅在精确受管浏览器处于前台、
前后完整且稳定的 inventory、capture/window 几何和 tab/document 身份均成立时，
逐个块/滚动区域映射并排除实际/未知遮挡和 desktop viewport 外框。
正文不依赖 interactive hot set，即使没有可点击 DOM 候选也能提供已证明的正文。
旧 `visibleText` 原生表格路径不变，仍不直接放开 desktop 转发；macOS 继续既有
Retina/native-window 路径，此改动不代表 macOS 实机验证。

定向行为回归（由集成端统一执行）：
`pnpm exec vitest run packages/computer-cua/src/dom-grounding.test.ts -t "document"`；
`pnpm exec vitest run packages/computer-cua/src/cua-driver-computer.test.ts -t "paragraph-only|visible table text"`。
真实 GUI 验证应使用 `packages/computer-cua/dist/index.js` 的 `ManagedBrowserHost`、
`CuaDriverComputer`：Host `start(signal)` 得到 record，传入 Computer 的
`browserTarget: record.target`、`domGroundingTransport: host.createTransport()`、
`grounding: "hybrid-catalog-v1"` 与已有可信 desktop probe，
再以 `open → observe → execute(scroll) → observe` 验证当前可见块的更替与原生 scrollTop；
fixture 必须同时含 hidden/offscreen/clipped/covered/private 反例，不能用 transport 回显代替。

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

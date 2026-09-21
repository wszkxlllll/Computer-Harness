# DEV-2 可选 DOM Grounding 基础实施与门禁（2026-09-21）

## 结论

本轮已有条件完成可选 DOM Grounding 的公共协议、UIA/DOM 有界融合、Monitor 局部恢复提示和安全 transport gate。它没有建第二套 Agent loop：截图视觉始终存在，UIA 和 DOM 都只产生同一 `GroundingCatalog`，模型继续使用同一 `click_element` 或普通坐标 `click`。

本轮仍不无条件放行真实 DOM 业务动作。CUA 0.22.2 没有 browser/DOM/CDP typed surface，因此仓库新增了零新依赖的 managed browser host、loopback CDP 只读 transport 和严格 CUA window resolver。TUI 配置和持久 Profile 已接线；真实独立 Edge fixture pilot 已通过窗口绑定、候选采集、跨标签启动和 profile 持久化。完整跨站 Run 已证明真实携程/高德页面可以产生 Hybrid catalog，但也暴露并离线修复了 CSS viewport 到 CUA physical capture 的坐标投影错误。修复后的真实 DOM 点击尚待一次复验；实现不会附加或读取个人现有 Edge profile。

## 为什么 DOM 能补充 UIA

UIA 只能读取网页向 Windows Accessibility 树暴露的语义。DOM/CDP 可读取真实网页元素和边界，因此常能定位 UIA 不可见的自定义 `div/button` 或 `role/tabindex` 控件。但 Canvas、WebGL、视频、远程桌面位图没有可操作 DOM 子元素，仍然必须使用截图视觉坐标。

## 显式浏览器目标

真实 DOM 模式必须同时满足：

1. 用户按 Run 显式开启 DOM 或 Hybrid；
2. Host 启动自己管理的可见 Edge/Chromium、专用临时 profile 和 loopback CDP transport；
3. 启动后由严格 CUA resolver 枚举窗口，并用 Harness-owned Profile 的 Edge 进程树证明 PID 所有权；CDP `browserWindowId` 与 browser bounds 只用于活动窗口绑定和多候选消歧，不使用标题或 URL 猜测；
4. Host 将解析后的窗口信息交给 TUI 展示/确认，`tabId/generation` 必须与 transport 结果一致。

Adapter 不会扫描、猜测或静默附加任意个人浏览器调试端口，也不向模型暴露 cookie、完整 DOM、selector、node id、PID 或 HWND。

## 融合与召回

Runtime 保持最多 16 个模型可见 hot elements，不拼接整棵 UIA/DOM 树。当前 `bounded-fusion-v1` 顺序为：

1. 最近失败动作的局部区域；
2. focused/editable 元素；
3. 与最新用户纠正、当前 Plan 或有界局部意图匹配的元素；
4. 少量全局回退元素。

局部失败区域只从已提交的 `ActionIntent.point` 或已验证 grounding bbox 生成，不由模型随意扩展。局部意图的信任顺序为用户纠正 > 同轮 `declaredEffect` > 同轮 `assistantText`；后两者只是召回提示，不是事实、授权或成功证据。Trace 只保存是否使用及来源，不保存提示原文。

UIA/DOM 候选使用 bbox IoU、规范化 name/role/source 去重。网页 content 冲突优先 DOM，浏览器 chrome/原生控件优先 UIA；来源配额可借用，不会因一方候选少而浪费上限。

## 生命周期与降级

- ref 仍绑定 Observation/ComputerSession；下一次观察后必须重新获取；
- 每次 collect 都重新枚举 page targets，并通过每个 page 的 `document.visibilityState`、必要的 `hasFocus` 与 `Browser.getWindowForTarget` 限定到 Harness-owned 的同一 `browserWindowId`；同一 `tabId` 的跨站导航允许继续 DOM，同一 browser window 内唯一可见 tab 切换时刷新 Adapter 私有 generation；popup/新 browser window、关闭 tab 或 0/多个可见 tab 都返回脱敏 transport gate，降级为空 DOM catalog 并回退 UIA/视觉；
- collect 仍校验 host-owned window/profile 边界；页面 identity、generation 和 endpoint 只留在 Adapter 私有状态，不写入 URL 或原始 target trace；
- 有意义的画面变化、窗口/会话变化、用户纠正或有界尝试结束会更新或清理 recovery hint；
- DOM transport 异常或 identity 不匹配返回脱敏空 catalog（`unknown/degraded`），Hybrid 仍保留 UIA，截图视觉不被阻断；
- DOM-only 不会伪装为原生 OS Accessibility capability。

## 验证

根层独立复跑：

- `pnpm run typecheck`：通过；
- 基础融合批次：6 个定点测试文件，173 tests passed；
- managed host 批次：7 个定点测试文件，103 tests passed；
- app-runtime/TUI 接线批次：4 个定点测试文件，56 tests passed；
- 覆盖 UIA-only、DOM mock、Hybrid、不对称来源借用、跨源去重、局部失败区域、`declaredEffect/assistantText` 召回、stale/identity gate、Canvas 视觉回退和 DOM degraded 留痕。

真实跨站 Run 暴露的坐标语义已经补入回归：CDP 候选明确保持 CSS viewport space；Hybrid 模式使用同一 observation 的 UIA `Document` bbox 作为可信 physical content rect，再做独立 x/y scale 与 origin 投影。窗口 resize、DPI/截图缩放和同控件 UIA/DOM 对齐均有覆盖。当前没有接入 Runtime recovery hint 到 Computer observe 的 failure-point 参数，因此不再声称支持 failure-point 反向投影；该死代码已移除。DOM-only 没有可信 content-rect producer，保持 degraded empty catalog，禁止猜坐标执行。修复后全仓 505/505 tests 和根级 TypeScript 检查通过。

独立真实 fixture pilot 使用 Node 24、现有 CUA daemon、managed Edge 临时 profile 和 loopback CDP：exact window resolver 通过，收集8个有界候选/全8个bbox，包含3个button、textbox、checkbox、radio、slider、generic custom div；open shadow 元素可见，Canvas 保持 visual-only，iframe 不遍历。模型请求、桌面输入、截图、cookie/storage 读取均为0，浏览器/profile 已清理。脱敏证据位于 `runs/managed-browser-dom-pilot-20260921043635850/summary.json`，不上传运行目录。

后续持久 Profile TUI 首次真实启动暴露了窗口 bounds 语义差异：CDP 报告约 `1050×1000` 的 device-independent bounds，CUA/Win32 对应窗口约 `1557×1490`，与本机 150% DPI 一致。旧 resolver 的整数 exact equality 会错误拒绝正确窗口。修复后仍先要求候选 PID 属于 Harness-owned 进程树；若没有 exact bounds，则只允许统一 DPI scale、长宽比误差不超过 8% 且几何兼容候选唯一。个人 Edge PID 始终排除，多候选仍 fail-closed。第二次真实只读 pilot 已成功绑定，并再次采集8个 DOM 候选；模型、输入、截图、cookie/storage 读取仍为0。脱敏证据位于 `runs/managed-browser-dom-pilot-20260921102022809/summary.json`。

## 下一道门禁

app-runtime/CLI/TUI 的显式 DOM/Hybrid 选项已接通：必须同时提供 CUA socket 和 `--managed-browser-url`，managed Run 自动归一化为 foreground，从而使用与普通 foreground window 相同的 click/type/keypress/hotkey/scroll/drag/wait 和 `click_element`。profile mode 默认 `ephemeral`；`persistent` 需要 Harness-owned 的显式 label/root、单实例 lock，并保留 profile state 供后续 Run 复用，用户必须手动完成登录，Harness 不自动登录或读取/输出 cookie、localStorage、password/input value，且没有个人 profile fallback。进程异常退出留下 stale lock 时只 fail-closed 并给出不含路径的恢复提示，不自动删除可能仍被占用的 lock；reset/delete 仍需独立显式操作。Run 启动失败、Abort 或正常结束均由 app-runtime 管理 bootstrap session、managed host 和 delegate Computer 的清理，不停止共享 daemon。

DOM 不限制在起始网站。Managed host 在每次 Observation 重新枚举当前同一 browser window 的 page targets，通过 `document.visibilityState` 选择唯一活动 tab：同 tab 跨站导航继续收集 DOM，tab 切换会刷新 Adapter 私有 generation 且旧 ref 随 Observation 失效；后台 tab 不进 Context，popup/新 browser window 不与当前 CUA window 混合。0或多个可见 tab 时 fail-closed 为 degraded DOM，保留 UIA/截图。

无模型登录准备入口为 `browser-login`：它只启动 Harness-owned managed Edge 并等待用户手动登录，按 Enter 后关闭浏览器、保留 profile 并释放 lock，不读取 `.env` 或 Provider 凭据，不创建 Run、截图或桌面输入。相同 profile label 的多次 `browser-login` 会将显式传入的 HTTP(S) URL 规范化为 origin/path（剥离 query 与 fragment）写入 profile 私有的有界启动清单，最多 8 个且去重；该清单不是 Edge session restore，也不读取历史、cookie 或 storage。后续 persistent Run 把命令行 URL作为首个活动页，并将清单中的其他站点在同一 Harness-owned browser window 中作为后台 tabs 启动；无清单时保持只打开命令行 URL。CLI 使用稳定 OS-local Harness state root，不把 root、URL 或 tab identity 写入模型、report 或 trajectory；SDK 直接使用 persistent 模式时必须显式注入 root。

下一道门禁：

真实携程复验 `run-1789994984014-a42f31b1-c12` 已通过首项门禁。模型使用 DOM `click_element` 点击“到达城市”，投影后的窗口内点为 `(559.15, 524.87)`；CUA 执行后 post-observation 为 `changed`，没有再次出现 `no_observed_change`。随后 `Ctrl+A`、输入“北京”和选择候选均成功，最终截图显示出发城市上海、到达城市北京、日期 2026-09-22。该 Run 为4次模型请求、4个动作、0拒绝、0 Tool/Provider/Runtime 错误，完整 `finish.summary` 同时交付结果并指出测试 Goal 的文字歧义。

这只放行普通网页文本控件的 Hybrid DOM 点击路径，不自动外推到 Canvas、自定义地图控件、iframe 或缺少 UIA `Document` content rect 的页面。后续门禁调整为：

1. 对高德自定义控件执行只读候选审计与受控 `click_element`，核对 post-observation 和 DOM 语义状态；
2. 明确 DOM-only 当前只验证 fail-closed degraded 行为；保持 OSWorld、UIA-only、普通 CUA 与个人浏览器基线不变；
3. 将独立 profile 重新登录成本作为产品交互问题单独评估。

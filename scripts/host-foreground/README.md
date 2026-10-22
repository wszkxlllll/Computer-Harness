# Windows Host 前台作用域模块

这里发布的是 2026-10-22 整理的既有 Host 修复及六个既有行为测试，不是新的任务启动器，也没有接入默认产品启动流程。通用模块来自 `member-c-main-local-20261022/runner`；`foreground-scope.ps1` 采用 `member-c-main-foreground-eight-20261022/runner` 中“无编辑器所有权记录时禁用 editor 角色”的版本。来源名称仅用于追溯，不是运行时依赖。

## 内容与接口

- `browser-source-evidence.mjs`：保留 `sourceUrls` 数组的多来源通用接口；把当前受管浏览器、页面、标签、文档代际及前台窗口证据绑定到新观察，派发前重新确认，拒绝过期观察与动作重放。不补造 DOM 元素或修改旧观察。
- `browser-find-admission.mjs`：只有已完成的 Ctrl+F、唯一新增直接拥有的 popup 及一致的 UIA Edit 焦点证据同时成立才承认查找弹窗；不是任意浏览器 popup 的授权。
- `point-scope.mjs`、`driver-point-contract.mjs`、`host-scope-computer.mjs`：观察绑定、当前 Win32 命中、坐标投影、拖动采样、最终 Driver 派发门及一次性执行许可。
- `focused-editor-evidence.mjs`：多行输入只允许精确拥有、当前聚焦、可写的原生多行 Edit。
- `native-scope.mjs`、`foreground-scope.ps1`：局部窗口身份、关系、DPI、焦点和点命中查询；失败时不授权输入。
- `window-preparation.mjs`、`host-factories.mjs`：复用产品 `ManagedBrowserHost` 和 `CuaDriverComputer`，不接管浏览器桥或启动任务。
- `host-action-policy.mjs`：原有公开来源浏览与本 Run 新文档策略；调用方必须显式提供来源和新输出文件授权，模块本身不附带任何历史任务授权。
- `owned-notepad.ps1`：按显式所有权记录管理新建 Notepad，保留 `-Operation Launch|Foreground|Close -RecordFile <path>` 接口。`Foreground` 只检查当前前台归属；`Close` 可能强制结束该精确拥有的进程，Host 不替用户保存文档。
- 六个 `*.test.mjs`：保留来源证据、Ctrl+F admission、点作用域、Driver 坐标、Computer 派发和多行编辑器的既有行为测试。这些合成行为测试不是实际桌面业务成功证据。

## 调用方配置

需要已登录的 Windows 桌面、支持 `import.meta.dirname` 的 Node.js、PowerShell 7，以及调用方明确指定的产品构建根目录。这里不负责构建、安装、凭据加载、模型配置或 Driver 启动。

1. `DS_PWSH` 指定调用方的 PowerShell 7 可执行文件；仓库不内置任何个人机器路径。
2. `DS_DRIVER_POINT_CONTRACT` 必须为 `windows-cua-0.22.2-desktop-f64-as-i32-v1`。这只是对已知 Driver 行为的显式声明，不是对任意二进制的自动识别：物理主桌面坐标，click/scroll 与 drag 端点按 f64 向零截断为 i32，drag 使用默认 20 步及 Rust 的远离零半值舍入。不要给未知 Driver 设置该声明来绕过门禁。
3. `createForegroundScope({recordFile,getBrowserTarget,runner})`：`recordFile` 必须是调用方选择的本 Run 所有权记录路径；`getBrowserTarget()` 返回专用受管浏览器的 `{pid,windowId}`；`runner` 默认本模块目录。仅浏览器场景应传入本 Run 新目录中不存在的记录路径以禁用 editor，不能复用其他 Run 的记录。原生脚本保留必需的 `-EditorRecord`、可选的 `-BrowserPid/-BrowserWindowId` 和成对的整数 `-PointX/-PointY`。
4. `createHostFactories(root,{sourceUrls,foregroundScope,onEvidence})` 的 `root` 显式指向产品根目录，读取该目录下 `packages/computer-cua/dist` 的现有导出；返回 `dependencies`、`browserSourceEvidence`、`inspectScope` 供现有 Host 接线。初始化完成前 `inspectScope` 拒绝输入。
5. 通用 `createTaskActionPolicy({risk,riskTimeoutMs,sourceUrls,outputFile,foregroundScope,inspectScope})` 使用调用方的风险模块与作用域检查器；`outputFile` 是明确授权的新文件，不能指向已有用户文档。模块不自行提供自动批准处理器。
6. `onEvidence` 默认不记录；若调用方启用，应自行决定日志存放与脱敏。运行时证据和所有权记录不应作为本目录的发布内容。

### 独立的仅浏览器公开查询 profile

`profiles/browser-only-public-query.mjs` 来自第二批四题的既有 Host-only 策略，保留 `createTaskActionPolicy({risk,riskTimeoutMs,initialUrl,foregroundScope,inspectScope})` 和单 URL 的 `officialUrlPredicate(initialUrl)` 接口。它仅允许精确前台浏览器中的公开查询，拒绝窗口切换、账户、预约、提交、付款和外部承诺，不授权编辑器。

使用该 profile 时，通用 `createHostFactories` 仍传 `sourceUrls: [initialUrl]`，并按上节禁用 editor；从 profile 文件导入策略，不覆盖通用 `host-action-policy.mjs`。单来源实验的 `browser-source-evidence.mjs` 没有覆盖这里的多来源实现，也无需复制另一套证据依赖。

## 能力边界与历史结果

原生查询和 Driver 派发是分开的调用，不是原子化的 OS 检查并发送。当前实现绑定已知 Windows Driver 坐标行为，不能直接视为跨平台支持或任意 stock Driver 的保证；这里不包含该本机候选二进制。浏览器窗口最大化、桌面预检、任务启动器、外部桥、凭据加载器、PowerShell 批处理队列、旧运行 claim 和本机坐标部署记录均未纳入。

历史行为测试与两批共 16 轮实跑结果属于此前的验证记录，不代表本发布组合在本轮重新测试通过。整理发布时没有执行测试、构建、lint、formatter 或桌面操作；实跑报告由本次 PR 的独立报告内容承载。

本轮真实业务没有全部通过：Ctrl+F/browser-popup 以及翻译弹窗仍出现业务拒绝。保留这些失败关闭的边界，不把已完成输入回执或合成测试名称解释为业务完成，也不声称“已完整修好”。

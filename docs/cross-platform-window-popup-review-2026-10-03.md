# 跨平台、跨窗口与弹窗 probe 复审

日期：2026-10-03。审查基线：Mac 分支 `abb54b2b0c38100ad9f089ea58e0e8a0639a7185`。本轮为代码审查与离线回归，不是部署或真机验收。

## 结论

有条件推进受控验收，不能宣称三平台完整跨窗口任务已经可用。显式列窗/切窗、稳定 ComputerSession 与 Surface 代次失效链已经实现；Windows 自研只读关系 probe 已实现并在部分生产路径接入。macOS/Linux 没有等价本机 probe，Windows companion 路径默认也不自动注入。切窗成功不等于后续点击、输入、弹窗关闭和回到父窗口都成功。

## 已实现与未覆盖

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Run 内授权列窗、精确激活、切换后新观察 | 有公共生产链与离线测试；旧 scripted browser↔WPS 有实机记录 | 有公共生产链及 Cocoa/AX 激活合同；当前整合版完整往返未实测 | 有公共生产链；当前整合版完整往返未实测 |
| 独立只读窗口关系 fallback probe | 已实现；限定 foreground、非 companion 默认注入 | 无等价生产实现 | 无等价生产实现 |
| 自动弹窗 child push/pop | 作者记录证明 Notepad menu；Open dialog、WPS 独立弹窗仍 pending | 缺完整关系/root 证据，不能承诺自动恢复 | 缺完整关系/root 证据，不能承诺自动恢复 |
| 原生 UIA 多行输入新路径 | 有实现及限定场景证据 | 明确返回不支持 | 明确返回不支持 |

历史 Windows 实机记录不是本轮独立执行，也不等于所有应用、起点和弹窗覆盖。缺少自研 probe 不意味着 CUA 自身完整证据永远不能工作；但不能用通用接口存在来证明平台证据生产能力齐全。

## 关键证据与问题

### 1. “弹窗要自己实现 probe”已经做了 Windows 部分

- `packages/app-runtime/src/windows-window-relationship-probe.ts:49`：`createWindowsWindowRelationshipProbe()`，内嵌 PowerShell/C# 的 `HarnessReadOnlyWindowProbe`，读取 Win32 owner PID/HWND、可见性、最小化、窗口类、前台身份、z-order 与 DWM bounds；不是单独实验脚本。
- 该 probe 不发送输入、不激活窗口、不读取窗口标题；有超时、输出及枚举数量上限。第 63 行拒绝非 Windows 生产执行。
- `packages/app-runtime/src/computers.ts:247`：Windows foreground、非 `managedBrowserCompanion` 默认创建并注入。
- `packages/computer-cua/src/window-contract.ts:158`：CUA 原始 inventory 缺关系字段时调用 fallback；失败保持不完整，不伪造权限证明。
- `packages/computer-cua/src/window-relationship-probe.ts:19`：当前 source 合同仅接受 `win32_relationship_probe`。Mac/Linux 扩展需要真实平台证据和来源合同，不能把来源伪装为 Windows。
- `packages/computer-cua/src/window-root-projection.ts:151`：root 角色识别已有 Menu/Dialog 等规范值，但没有直接映射 AXMenu/AXDialog。若上游返回 AX 原生角色，需做平台归一化并验证精确身份、几何及父子关系；只改字符串不足以证明准入。

### 2. 手机常用跨窗口模式存在 probe 覆盖边界

`remote-run-api.ts:327,383,682` 对非 browser 起点且启用跨窗口的任务配置 managed browser companion；`computers.ts:249` 明确排除该模式的默认 Win32 probe 注入。因此这些路径依赖 SDK 自身关系证据，不能套用直接 foreground/browser 起点的弹窗结论。

这是已有明确设计边界（`surface-registry-integration-review-2026-10-03.md` 第八轮表格记录），不是本次整合新引入的回归。需要先确认隔离意图，给 companion/原生切换后的关系证据生产建立专项方案和回归，不能未经评估直接删除排除条件。

### 3. 切换成功后仍可能因 inventory 不完整终止

- `cua-driver-computer.ts:1228`：Run 内 opaque 引用和 Host scope 限制。
- `cua-driver-computer.ts:1519`：重验候选、精确激活、捕获新目标并推进 Surface generation，旧观察/输入许可失效；不重放未知副作用。
- `window-contract.ts:524`：Mac Cocoa/AX 明确验证合同已适配；sheet 若无独立焦点身份仍拒绝，不能按普通顶层窗口强切。
- `run-factory.ts:58` 与 `remote-run-api.ts:696`：跨窗口启用 handoff 检查。
- `cua-driver-computer.ts:1375`：动作后 inventory/baseline 不完整且没有新窗口时也会抛 `WINDOW_INVENTORY_UNKNOWN`。因此缺 probe/完整 SDK evidence 时，即使切窗本身成功，普通动作之后仍可能停下。这是源码确认的条件性失败路径，本轮未在真实 Mac 复现。

修正原则：先补可靠证据或明确功能降级，不移除 foreground/owner 检查，不猜测窗口，不自动重放已经完成或结果未知的输入。

### 4. 跨应用搬运文本存在额外平台边界

`cua-driver-computer.ts:2284` 的原生多行输入执行路径仅允许 Windows，其他平台返回 `MULTILINE_PLATFORM_UNSUPPORTED`。这不等于所有网页多行输入均不可用，也不影响对单行路径的独立验收；但不能承诺 Mac 的“网页整理多行内容→TextEdit”完整任务已经支持。

## 本轮实际验证

两个子智能体分别审查 CUA/Surface/平台证据与 Host/RemoteRunAPI 装配，主线程交叉检查关键路径。在当前 Mac checkout 使用 Vitest `--no-cache` 重跑以下 9 个文件，合计 **335/335 通过**：

- window-relationship-probe：18；transient-window-admission：19；window-root-projection：21；surface-registry：16。
- windows-window-relationship-probe：15；window-discovery：11；app-runtime/computers：23。
- remote-run-api：42；cua-driver-computer：170。

Windows probe 测试在 Mac 上使用离线 fixture/executor，不代表本机执行过 Win32 调用。本轮没有重跑全量构建，没有调用真实模型 API、真实 probe、真实桌面或手机，也未验证当前部署版本。

历史证据入口：`surface-registry-team-handoff-2026-10-03.md:21,31,32`；`cross-window-implementation-and-validation-2026-10-02.md:113`。旧 browser↔WPS 记录早于当前稳定 Session/Surface 合同，不替代本版本实机复验。

## 建议执行顺序与验收门槛

1. 先做当前整合版 Mac 小闭环：受管浏览器→空白 TextEdit→点击、单行唯一标记→切回同一浏览器。分别覆盖 browser 起点和 native/companion 起点；不保存、不发布、不覆盖已有文件。
2. 验收需同时证明：精确窗口身份、新观察与坐标、原生窗口不携带浏览器 DOM、切回后 DOM 更新、没有 inventory/foreground 错误、没有旧输入重放、Run/owner/lease 正常收尾。只看到窗口前置不算通过。
3. 在实施授权后补 Mac 关系 probe/AX root 归一化及 sheet 处理，并单独审查 Windows companion 默认隔离。保留 source、完整性、截断/矛盾、超时和失证拒绝测试。
4. 再测菜单→Escape、打开/保存对话框→取消→返回父窗口；独立窗口与同窗口 overlay 分开，记录 child_push/pop 与代次。不保存实际文件。Windows 继续补 Open dialog/WPS；Linux 区分 X11/Wayland，权限受限时明确降级。
5. 多行原生输入作为独立平台能力补齐后，再跑跨应用整理长文本的完整任务。

本轮仅新增审查文档并更新索引，未修改业务代码、提交、推送或重新部署。

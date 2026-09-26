# DEV-2 CUA 窗口能力接入盘点

日期：2026-09-18

仓库基线：`f7f7357`（分支 `codex/dev2-tui-preview`）

依赖：`@trycua/cua-driver@0.22.2`

文档角色：CUA doctor 实施与窗口能力边界记录；Sol 定向复核已有限放行，不是通用窗口安全能力的完成报告。

## 1. 结论

本批有限放行只读 capability doctor，并已实现 host 明确选择的精确窗口 Adapter opt-in；现有 primary desktop 全屏观察和默认 foreground 动作不变。受控 fixture 与 production `CuaDriverComputer` 的窗口 observe/click/stale lifecycle 窄链路已通过，但由于 frame/client 存在约 2px 边界差异、通用目标身份与权限闭环尚未产品化，窗口能力不向模型自由发现，也不把 `bring_to_front` 或窗口置顶返回值写成持续焦点证明。

worker_ci 的独立记录证明了以下受控链路：Windows + 官方 CUA 0.22.2 daemon + 本 probe 启动的 WinForms fixture，`list_windows` 能返回精确 PID/window_id/bounds，`bring_to_front` 返回 `landed_on_target`，fixture 自有状态能确认 `focused=true`；`verify_state(include_screenshot)` 对 960x680 与 1040x720 fixture frame 分别观察到 958x678 与 1038x718，显示约 2px non-client/frame 边界；现有 `CuaDriverComputer` 随后完成全桌面 physical capture，以及使用 primary desktop target 的 click/type，fixture-owned state 发生预期变化。能力目录为 57 tools，metadata/session/health/permission 预检 errors 为 0。

上述证据不证明：任意应用的焦点、通用 AX、PID/window_id 的永久身份、跨平台支持、业务目标成功或完整 model Run。`accessibility=false`。第10节历史 GLM 尝试曾因整屏隐私闸门中止；随后第11节 T10 synthetic fixture 窄链路通过，但不等同真实用户桌面或 REL-1。

## 2. 当前生产边界

`packages/computer-cua/src/cua-driver-computer.ts` 当前只做：

- `open` 连接显式 daemon、启动 session、读取 primary desktop physical viewport；
- `observe` 调用 `get_desktop_state`，将全桌面 PNG 写入 adapter 私有 screenshot 目录，再由 Runtime 持久化；
- `execute` 将非 wait 动作路由到 `{ kind: "desktop", display_id: "primary" }` 与 foreground delivery；
- 以 `ObservationId` 绑定当前 session，并在 transport/cleanup unknown 时 fail closed。

现有 `ComputerSessionDescriptor.capabilities.accessibility=false` 是诚实状态。Runtime 的 model-facing `ToolRegistry` 仍只有通用屏幕坐标/键盘动作；不应因为 CUA SDK 类型中存在 `ActionTarget.Window` 就让模型直接提交 PID/window_id。

## 3. 建议的最小合同

### 3.1 只读 capability doctor（先行项）

归属 `packages/computer-cua`，不改变 `Computer` 接口和默认 Run 路径。doctor 只接受显式 socket/driver factory 与 `AbortSignal`，读取并归一化：

- driver metadata 与版本/平台摘要；
- `listToolsJson` 的工具名和数量；
- session lifecycle、health report、permission report 的结构化状态。

输出只允许 `supported | unsupported | unknown | degraded` 等状态、能力名、受限原因和版本摘要；不得保存原始窗口标题、路径、截图、clipboard、token 或任意 daemon 文本。Transport/permission/shape 失败必须保持 `unknown`，不能把缺失工具当成支持，也不能让 doctor 的错误改变 Run outcome。doctor 不调用 click/type/keypress、window mutation 或 capture。

### 3.2 host-only 精确窗口预检（条件接入）

先定义 adapter 私有/host-facing 类型，不进入 protocol、Memory 或 model tool schema：

```ts
type CuaWindowTarget = {
  pid: number;
  windowId: string;
  bounds: { x: number; y: number; width: number; height: number };
  coordinateSpace: "physical";
};
```

生产动作只有在调用者显式提供该 target 时才可走 target opt-in；默认仍使用 primary desktop。每次敏感动作前应重新读取并比较精确 PID/window_id/bounds/viewport，窗口不存在、PID 不符、bounds/scale 不一致或 transport 错误都拒绝/返回 unknown，不静默降级到 desktop，也不由 socket/session label 充当身份。即使这些检查通过，也不能把敏感输入视为安全；没有独立、短生命周期的 focus readback 时，通用 target action 继续不接入。`bring_to_front` 只能是一次性 preflight 辅助步骤，不得返回“焦点已证明”。

当前 worker_ci 与 production adapter 实证只支持把这条合同用于专用 fixture/明确 host target；在通用应用上仍应标 `unsupported` 或 `unknown`。本批 adapter 只启用 click+wait，键盘与其他 pointer primitive 继续禁用。target generation、geometry revision、审批绑定和 Runtime 消费者属于下一步合同，不能用 ObservationId 自增冒充。

动作前 `list_windows` preflight 与随后 driver click 不是原子操作；当前上游没有可消费的 generation/geometry lease，窗口可在两次调用之间移动或关闭。因此本批只降低 stale-action 风险，不把 preflight 或 receipt 写成 click 已落点/业务目标成功证明。

### 3.3 窗口级 capture 的有限接入边界

worker_ci 已在专用 fixture 上验证 `verify_state(include_screenshot)` 能返回窗口观察帧，production adapter 已在显式 host target 下消费真实 PNG viewport。当前记录到的 frame/client 约 2px 差异、目标变化、遮挡/权限与 cleanup 后失效语义仍不构成通用窗口安全合同；因此不新增 Protocol `observeWindow` 或模型自由选窗，不把全桌面裁剪冒充窗口截图，也不在窗口级能力失败时回退为“看起来成功”的 desktop capture。

只有后续另批将 PID/window_id 绑定、bounds/scale/frame validity、遮挡/权限和 cleanup 后失效固化为生产合同，才可设计 `windowCaptureRef` 与 Observation/审批消费；本次 probe 不直接授权这些接入。

## 4. 实施顺序与验收

1. 先实现 doctor 的纯 fake 合同测试：metadata/inventory/health/permission 正常、缺工具、malformed JSON、permission denied、transport unknown、Abort；断言不发生 GUI action、不写 screenshot、不泄露原始文本。
2. 基于 worker_ci 已给出的受控 probe，production adapter 已实现并通过 host-only target discovery/preflight fake 与窄实机链路：精确 PID/window_id、窗口消失、bounds/viewport 变化与 background click stale refusal；PID reuse/changed window_id、`bring_to_front` structured refusal、focus unknown、daemon 断连仍需另批继续覆盖；默认 desktop 路径的请求形状保持不变。
3. 在 2px frame/client 边界、遮挡/权限和 cleanup 语义未闭环前，维持 window capture unsupported；不要为填工具目录暴露 57 个工具，不新增 Memory scope、Monitor、跨进程 owner 或通用 target lock。

代码所有权限于 `packages/computer-cua` 及其测试和本实施记录；除非 Runtime/Protocol 已有消费者合同无法表达，否则不修改 Runtime、Provider、Memory 或 TUI。任何真实 daemon、桌面、截图或模型验证由 worker_ci 独占，本 worker 不执行。

## 5. 当前放行矩阵

| 能力 | 当前结论 | 可否本批生产接入 |
|---|---|---|
| metadata/tool inventory/session/health/permission doctor | Sol 定向复核有限放行；direct CLI 真实结果为 metadata/inventory supported（57 tools），session desktop capture scope 未确认，health/permissions/cleanup unknown、退出码 1；pnpm wrapper 另有 transport unknown | 仅只读、显式诊断；不视为整体通过 |
| 精确 window discovery (`pid/window_id/bounds`) | 专用 fixture 通过；不是永久身份 | 仅 host-only opt-in 预检 |
| `bring_to_front` | 专用 fixture + fixture-owned focus 状态通过 | 只能作一次性辅助，不能宣称通用 focus |
| fixture 上的 primary-desktop click/type | 专用 fixture action/state 链路通过；不是 CUA Window-target 动作 | 不改变默认；不据此接入通用 target action |
| window-level screenshot/state | 受控 fixture 与 production adapter 的显式 host opt-in observe 通过；存在约 2px frame/client 边界，通用安全语义未闭合，模型自由发现仍禁用 | 仅 host-only opt-in；不向模型开放 |
| generic focus/AX、跨平台 target | 未验证/不统一 | 不接入 |

## 6. Doctor 实施结果（Sol 定向复核有限放行；真实结果为有限诊断且不整体通过）

已在 `packages/computer-cua` 实现 `inspectCuaCapabilities`，并由 `packages/app-runtime` 保持 native binding lazy 后提供给 CLI；`apps/cli --doctor --computer cua --cua-socket <socket>` 是无 goal、无 model、无 `.env`/provider credentials 的真实入口。报告只包含 schema/status/reasonCode、工具数量和声明能力，不输出 socket、session label、daemon 原文、窗口标题、路径、截图或凭证。

fake focused 证据：doctor 正常路径、metadata contract/schema、tools-list schema mismatch、malformed inventory、permission error、连接构造失败、metadata/start timeout、abort race、独立 cleanup signal、health contradiction/version check、settled transport reason、desktop capture scope 未确认（不等同物理锁屏）和 error-code 脱敏回归通过；window adapter/app-runtime/runtime focused 与 doctor 回归见实施记录。`pnpm exec tsc -b packages/runtime packages/computer-cua packages/app-runtime apps/cli --force`、CLI `--help` 通过；CI commit `5ba1373` 的 root `pnpm run typecheck` 通过。真实 direct CLI doctor 的 metadata/inventory 为 supported（57 tools），但 session=`unknown/desktop_capture_scope_unconfirmed`、health/permissions=`unknown/session_start_invalid`、cleanup=`unknown/session_start_unknown`，总状态 unknown、退出码 1；正式 pnpm wrapper 的 transport unknown 仍未解决，因此不把 doctor 写成整体通过。production adapter 的真实 window observe/click/stale/close 窄证据见[独立验证记录](./dev-2-adapter-window-validation-results.md)，坐标合同与 fixture 边界见[Window target 验证记录](./dev-2-window-target-validation-results.md)。T10 synthetic fixture、window probe 与 doctor 真实边界仍分别见验证记录第11/12/13节；T10 的原始运行资产已清理，报告中的 JSON 仅为当时脱敏转录，不能从原始资产独立重算；T10 不等 REL-1。完整 model Run、通用 focus/AX 和产品化通用 window target/capture 仍未完成。

窗口 capture/target 仅在显式 host opt-in 下由该实现触发；默认生产仍是 desktop observation/action。worker_ci 与 production adapter 的窄证据不提升为通用 fixtureVerified、focus proof 或敏感输入授权；doctor inventory 中即使声明 `list_windows`/`bring_to_front`，也只记录 declaration status；约 2px frame/client 边界、通用 target identity 与后续 pointer/keyboard primitive 语义留待后续合同批次。

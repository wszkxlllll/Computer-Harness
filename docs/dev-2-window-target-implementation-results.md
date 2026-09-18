# DEV-2 显式窗口目标与窗口观察实施记录

状态：代码完成，待 Sol 定向复核；本批只做 CUA host-only opt-in，不改变默认 desktop、OSWorld、Provider 或模型工具语义。worker_ci 已用真实 fixture 验证 production adapter 的窄 click/lifecycle 路径；本 worker 的实现验证仍使用 fake driver。

## 1. 最小合同（先冻结）

### Host 配置

CUA 配置可显式提供 `{ pid, windowId }`。未提供时继续使用现有 primary desktop 路径；模型不能从 inventory 自由发现或选择窗口，PID/windowId 不进入 Protocol、ObservationFrame、Memory 或 Provider schema。

### 绑定与几何证据

Adapter 在目标 Run 的 session 内用 `list_windows` 读取 exact PID/window_id/bounds，并保存私有 binding。每次 observe/execute 前都重新读取同一 PID/window_id：目标消失、身份变化、bounds 变化或结构化结果缺失均拒绝/标 unknown，不回退 desktop。observe 可以在 host 已移动/resize 后重新读取并建立新的私有 geometry binding；旧 observation 的 action 不因此恢复有效。

### 窗口观察坐标

窗口观察调用上游 `verify_state`，使用 exact `pid/window_id`、bounds predicate、`include_screenshot=true` 和稳定结果。返回 PNG 的实际 IHDR width/height 是本次 Observation 的 viewport；不硬编码 non-client 边框差值，也不把 outer window bounds 当成图像尺寸。模型收到的坐标因此直接对应实际窗口图像，adapter 私有保存 outer bounds/target 证据。

### 动作与失效

显式窗口 opt-in 的首个生产 primitive 仅为 `click`，使用上游 `{ target: { kind: "window", pid, window_id } }`、窗口图像局部坐标和 `delivery_mode: "background"`；`double_click/right_click/scroll/drag` 及键盘 primitive 先不暴露，直到各自 receipt/focus 合同独立通过。同一 `list_windows`/geometry 校验用于普通 action、审批后 action 和 batch 中每个 primitive。旧 observation 或 geometry 不匹配返回明确 refusal，绝不静默改发 desktop action。Runtime 在 session open 后按实际 `ComputerCapabilities` 从 Provider tool input 移除 `type/keypress/hotkey`；键盘输入暂不开放，当前批没有通用 focus/输入保证，后续经独立实证再启用。

### 生命周期

窗口绑定随 CUA session 关闭而失效；目标消失会把 session 的 window identity 不可逆地置为 invalidated，即使相同 PID/window_id/bounds 随后重现，旧 observation 与新的 observe/execute 也都拒绝，只有 close 后新 session 才能重新绑定。geometry changed 仍允许 host 显式 fresh observe；目标消失、重建或 cleanup unknown 不创建新 target、不复用旧 approval、不自动打开 desktop fallback。默认 CUA desktop 和 OSWorld 完全保持原请求形状。

`list_windows` 的动作前检查与随后 driver click 不是原子事务；上游当前没有可消费的 generation/geometry lease，因此窗口仍可能在两次调用之间移动或关闭。本批只降低 stale-action 风险，不能把 preflight 当成 click 已落点的证明；receipt 也不扩大为通用目标成功证明。

## 2. 实际文件与验证

- 生产代码在 `packages/computer-cua` 增加 adapter 私有 binding/verify/capture/action 逻辑；`packages/app-runtime` 与 CLI 只传递显式 host 配置（`--cua-window-pid` + `--cua-window-id` 成对出现）。
- Runtime capability gate 消费 opened session 的 `keyboard=false`，Provider tool input 不再包含键盘 primitive；app-runtime 通过既有 `enabledToolNames` allowlist 将本批 window opt-in 的 Computer tools 收窄为 click+wait；validation 仍保留为第二道边界。完成后报告从 `RunController.getEffectiveToolNames()` 读取同一 `ToolRegistry.modelTools` 投影，避免用另一份静态清单描述可用工具。
- fake 回归覆盖：默认 desktop 不变、目标绑定、窗口 PNG viewport、移动/resize 后旧 action refusal、新 observation 恢复、目标关闭与同 ID 重现后的不可逆失效、driver 错误、无 keyboard capability、无 desktop fallback；window adapter/app-runtime/runtime/CLI focused 37 tests 通过。
- `pnpm exec tsc -b packages/runtime packages/computer-cua packages/app-runtime apps/cli --force`、root `pnpm run typecheck` 通过；全量 `pnpm test` 32 files/311 tests 通过。未运行真实桌面/API/VM。
- 本 worker 不调用真实 daemon、模型 API、桌面或 VM；worker_ci 另行验证 0.22.2 Window target 的真实坐标与动作 receipt。
- 不新增 target generation、Memory scope、Monitor、AX 或跨进程 owner 字段；ObservationId 只做 Runtime 决策帧标识，不冒充窗口变化检测。

worker_ci 的坐标合同见[Window target 验证记录](./dev-2-window-target-validation-results.md)，production adapter 的真实窄链路见[adapter 验证记录](./dev-2-adapter-window-validation-results.md)：窗口 PNG 是 window-local pixel 坐标；960x680/1040x720 frame 对应 958x678/1038x718 PNG；production adapter 已通过 open/observe/background click、move/resize stale refusal、fresh observe/click、关闭拒绝与 cleanup。double/right/scroll/drag、键盘、foreground、跨平台和模型仍未放行；adapter 不使用 2px 常量，也不把 CI fixture receipt 写成通用能力。

# DEV-1 F04/F12/F07 Controls cleanup 实施记录

状态：Sol 已完成本轮有限复核并放行；CLI、Runtime/CUA、文档已分别建立本地提交，未 push。

## 基线与范围

本批在 `codex/dev1-controls-cleanup` 上实施，先从旧 DEV-1 分支创建并以 merge commit `4913fc6` 合并 `origin/main` `1f9f362`。合并冲突仅发生在 `apps/cli/src/index.ts`：保留 PR #3 的 Computer lazy loading、第二批 diagnostics recorder，以及 PR #4 的 Linux 文档/测试和 fixture 修改。未调用真实模型 API、桌面或 VM，未 push。

范围严格为 DEV-1 的 F04/F12/F07：Risk profile resolved 配置、TUI 实际 Guard 状态、终端控制序列净化，以及 Runtime/Computer cleanup 的有界等待。没有实现 DEV-2 的 app-runtime、UI 订阅、人工接管或同环境 owner，也没有实现 DEV-6 的跨进程持久屏障。

## 修复前反例

- F04：现有 `--tui` 仅打开交互，`riskGuard` 默认仍为 `off`；TUI 只显示 Guard 计数，不显示 resolved 配置，因此文档默认值、实际 Guard 实例和界面状态可能不一致。新增反例还确认了 `tui + profile=experiment + riskGuard=off` 可绕过关闭确认。
- F12：TUI 的原 `clip` 仅折叠空白，真实注入 `ESC/CSI/OSC` 的反例仍把控制字节写入 frame；该反例修改前实际为 1 failed / 2 tests。
- F07：Runtime `finally` 直接 await writer flush/close/Computer close，CUA close 对 `endSession` / `shutdown` 的等待也没有统一总 deadline；源码审计确认 hanging fake 会无限等待。新增 active/cleanup-pending 状态反例修改前均在整段等待耗尽后未执行 retry；启动成功但后续 open 失败、cleanup transport error 修改前还会 `destroy` driver。

本轮反例补齐后，实际命令 `pnpm exec vitest run apps/cli/src/config.test.ts apps/cli/src/tui.test.ts packages/computer-cua/src/cua-driver-computer.test.ts` 为 3 files / 16 tests，其中 5 failed：F04 1、F12 1、F07 3；这些失败先于下述修复产生。

## 实施

- 新增 `apps/cli/src/config.ts` 的 `resolveRiskConfig`：非交互 experiment 默认 Guard off；`--tui`/`--interactive` 默认 `live-interactive` + layered；任何交互标志或 live profile 关闭保护都必须显式 `--confirm-risk-guard-off`，即使同时显式写了 experiment。非交互 experiment 的显式 off 仍可用。同一个 resolved 对象用于 action policy、Context feature、summary 和 TUI metadata。
- TUI 显示 `Profile` 与 `Risk Guard: ENABLED/DISABLED`，所有模型、错误、路径、观察信息和 notice 先经过终端控制序列净化；保留中文和普通 UI 文本，并过滤 ESC/CSI/OSC、C1、U+2028/U+2029 与 U+061C。CLI 非 TUI 的动态 question/approval/error 输出也复用净化函数。
- Runtime 增加 `cleanupDeadlineMs`（默认 5000ms），flush、writer close、Computer close 共用一条总 deadline；超时记录 `status: timed_out`，不改写既定 Run outcome。同一 Computer 实例存在未决 cleanup 时拒绝再次 open；迟到 close 完成只解除复用阻断，不改写旧快照/终态。
- CUA `endSession`、cleanup-pending 重试等待和 `shutdown` 使用同一有限 deadline；poll/backoff 间隔小于剩余预算，active 与 cleanup-pending 均可在 deadline 内重试。超时或失败保留 session/driver，启动成功但 open 后续步骤失败时也登记 pending ownership，禁止新 session 覆盖未确认的资源；未确认的 endSession/shutdown 不触发 destroy。

## 验证

新增/修改的离线回归覆盖：

- F04：experiment/live-interactive 默认、交互标志下的显式关闭确认、TUI frame 的实际 profile/Guard 状态；
- F12：中文、ESC/CSI/OSC、C1 控制序列、U+2028/U+2029/U+061C、换行/伪终端文本，断言 frame 和 CLI 动态输出不含终端控制字节；
- F07：正常 cleanup、flush hang、Computer close hang、late close completion、未知 GUI 副作用后 cleanup timeout；同实例复用阻断，`outcome_unknown` 保留；CUA `endSession` 与 `shutdown` hang 的 fake-timer 回归，以及 active→inactive、cleanup_pending→inactive retry 和 partial-open pending ownership。

本批 focused 实际结果：CLI config/TUI 6/6；Runtime cleanup + CUA cleanup 15/15；Runtime 既有回归 54/54。Sol 集中复核的中间版本为 5 files / 72/72；补齐三项反例后的最终复核为 3 files / 16/16，并已有限范围放行。最后统一验证实际通过：`pnpm run typecheck` 退出码 0；`pnpm test` 为 22 files、251/251；`pnpm --filter @computer-harness/cli start -- --help` 退出码 0，Usage 含 profile/确认/cleanup 参数且未加载 CUA 原生绑定。没有把实机或跨进程 owner 结论写成离线通过。

## 边界与下一步

本批只证明进程内同一 Computer 实例/会话不会在 cleanup 未决时被 Runtime 盲重用，且 cleanup 返回超时不等于底层已停止。不同 Computer 实例的同环境所有权/quiesce 属于 DEV-2；跨进程、持久化的环境 owner/屏障属于 DEV-6，X02 后两者仍待开发和实机故障注入。真实 Windows CUA、OSWorld、终端接管和 VM 运行均未在本批执行。

# 启动方式兼容约定

- `docs/getting-started.md` 是 Windows 与 macOS 的维护启动入口。后续修改 Host/Relay、CLI 参数、环境变量、构建产物、浏览器发现、驱动来源/打包或权限流程时，必须检查文档中的准备、构建、启动、停止及配对步骤仍可用；不得只在个人私有脚本或绝对路径下跑通。
- 优先保持已有命令与配置兼容。确需改变启动合同或固定版本时，在同一变更中更新入门文档、示例与迁移步骤，说明 Host/Relay 配套版本和旧配置保留方式；不静默替换用户密钥、驱动或已运行任务。
- 按影响范围验证命令解析、构建产物及平台流程，区分静态/离线检查和实际新机安装。没有对应平台实测就明确登记未验范围，不声称已通过；不要为验证说明而扰动现有 Demo 服务。
- macOS 普通启动保持文档规定的本机签名 App、系统权限、独立 socket、Host 与正常配对流程。实验性的 Guard 设置、私有批次启动器或临时修复版本不得当作公共默认流程。

# 工作目录与本机配置

当前桌面产品聚焦 Windows 和 macOS，同时维护 Web/Relay 与手机控制端。成员的单平台分工不能覆盖整个项目范围；修改共享合同、Runtime 或 CUA 协调代码必须保留双方能力并做对应回归。平台专属实机验收分别由具备环境的成员完成，不用一端结果替代另一端；保留现有源码、依赖许可声明与 CI 配置。

- 以当前 checkout 的 Git 根目录作为源码、文档、测试证据和本地运行产物的基准；不得在仓库级说明中假定某位贡献者的绝对路径。若任务从非仓库目录启动，先定位正确 checkout，不复制第二份源码或用软链接伪装工作区。
- 本机私有配置使用仓库已约定且被 Git 忽略的 `.env`、`.env.relay` 与 `.harness.local.json`，不得输出其中的值。SSH 私钥及其他机器凭据保留在操作系统的标准凭据位置，不写入仓库或仓库级说明。

# 审计与规划输出约定

用户确认于 2026-08-31，适用于本项目后续代码审查、阶段验收和实施规划。

- 审计意见与下一步指导先落成 `docs/` 下的文件，再向用户汇报；在当前阶段入口链接最新结论，避免实施 Agent 找不到。
- 默认只审查和写文档；没有实施授权时，不顺带修改业务代码、调用付费 API 或操作真实桌面。
- 最终汇报沿用以下顺序，保持简洁、通俗，不把整篇审计文档复制到回复中：
  1. **结论**：可以推进、有条件推进或暂不能推进；明确放行范围与未放行范围。
  2. **验证**：本次实际检查/执行了什么、结果如何；区分作者报告和独立验证，不把历史测试写成本次执行。
  3. **关键问题**：按模块列出少量重点，说明影响及哪些必须先修、哪些可以并行处理；没有发现阻塞项时直接说明。
  4. **文档与下一步**：给出可点击的绝对路径，说明建议执行顺序和入口是否更新。
  5. **操作边界**：简述本次是否修改代码、消费模型额度或操作桌面；不为显得完整而增加无关工作。
- 文档保留详细证据、代码位置、修正原则及验收条件；最终回复优先呈现用户需要作决定的信息。
- Windows 下文本编辑使用 `apply_patch`；中文写入后显式按 UTF-8 读回，检查连续问号、替换字符和路径损坏，不依赖 PowerShell 默认编码。

# A 线双聊天协作

- 用户于 2026-10-03 另指定 `确定三人分工步骤 (6)`（Thread `01a10088-17c4-7351-a68b-953b0af94781`）负责远端代码更新和审查，并与（8）、（10）建立联系。三方角色、共享工作树及 Git 操作协调见 [三聊天协作入口](./docs/history/2026-10-20-product-docs/a-line-three-thread-coordination-2026-10-03.md)；（6）读取双聊天事件证据，不代替（10）操作实机或覆盖其验收记录。
- 用户于 2026-10-03 指定：`确定三人分工步骤 (8)`（Thread `01a10059-ed82-78a1-9a0a-156c56cd1673`）负责修复；`确定三人分工步骤 (10)`（Thread `01a10084-4097-7200-8cf3-5c0c7f65c413`）负责实机测试。仅对这两个聊天应用职责分工。
- 两者每轮先读取 [同步协议](./docs/history/2026-10-20-product-docs/a-line-collaboration-sync-2026-10-03.md) 与 `docs/a-line-sync/` 新事件。修复方写源码及 fixes，测试方写 issues/tests 并管理本机运行；关键交接使用对应 Thread ID 通知，记录优先于消息。
- 共享 checkout 的源码、构建和桌面按协议交接；实机测试占用期间不并发改相关源码或构建，不由修复方重启服务。未提交版本以源码指纹核对，不将离线通过或源码已改当作实机已部署。

# Exact-window activation and handoff

- For a host-selected native CUA window in `foreground` delivery mode, call `bring_to_front` once with the exact PID/HWND before the first fresh identity/geometry capture. Do not activate in background mode. Treat the call as an activation attempt, not proof of continuing focus; keep the per-action foreground refusal guard.
- Do not reactivate a bound window before every action, and never retry an action whose outcome may be unknown. A `WINDOW_FOREGROUND_MISMATCH` handoff is permitted only for the driver's explicit refusal that says no input was sent.
- After that refusal, re-enumerate visible windows and run the configured Jev selector against newly surfaced candidates from the current task. Auto-handoff only for a uniquely high-confidence candidate proven new since the prior target observation, in the bound process, and equal to the exact foreground HWND reported by the driver; then recheck exact identity and capture a fresh frame. Missing HWND evidence, existing windows, and different-process candidates stay in the manual picker; do not replay the refused action.
- In an opted-in native foreground Run, a completed GUI action may trigger a read-only visible-window diff against a fresh pre-action baseline. If it finds a new window, emit `computer.window.handoff.requested` with `new_window_detected`; Jev may highlight a suggestion, but this route always requires explicit Enter confirmation. Do not activate automatically without exact driver-reported foreground/ownership evidence. Global inventory incompleteness alone must not reject basic exact-window actions with sufficient fresh identity, focus and action-specific evidence. Failed or incomplete inventory must block only the operations that require its missing evidence (such as automatic child admission or proof of child disappearance); never fabricate completeness. Preserve completed receipts and never replay an action with unknown side effects.
- For `new_window_detected` only, the host may explicitly choose `C` to ignore an incidental popup and continue on the bound target. This records `computer.window.handoff.ignored`, clears the pending handoff and old observation, and requires a fresh target observation before the Provider continues. Never offer this escape for `foreground_mismatch`; that route requires choosing a target or aborting.
- Manual window pickers and in-Run handoff candidates use the driver's on-screen inventory. For the initial phone auto-target path only, the Host may inspect the complete top-level inventory, choose one uniquely matched PID/HWND, call `bring_to_front`, and proceed only after that exact identity reappears in a fresh on-screen inventory. This minimized-window restore path was independently verified on Windows with CUA 0.22.2; it is not permission to auto-activate ambiguous candidates or to generalize the behavior to in-Run handoff and other platforms without evidence.

# Explicit cross-window feature authorization

- The 2026-10-04 window repair supersedes the historical requirement above to fail a Run merely because the global inventory is partial. Preserve the completed receipt; use fresh exact-target evidence and never infer child disappearance from a partial inventory. An unresolved transient becomes a user-confirmation boundary rather than an action replay. Complete Win32 snapshots may prove an exact cross-process owner relationship; same-PID and UIA root classification are not universal prerequisites. See `docs/history/2026-10-20-product-docs/window-and-progress-repair-results-2026-10-04.md` for the verified scope.

- On 2026-10-02 the user approved the opt-in model-requested `list_windows` / `switch_window` plan in `docs/history/2026-10-20-product-docs/cross-window-execution-plan-2026-10-02.md`. This is a separate explicitly authorized target-switch operation, not a relaxation of the legacy automatic foreground-mismatch/new-popup handoff rules above.
- Reuse exact activation and identity/capture verification. A model may select only a Run-scoped candidate reference discovered by the adapter and allowed by the Host. Background/minimized candidates require fresh verification after activation before subsequent input; inclusion in inventory alone does not prove operability.
- Preserve default single-target behavior, per-action foreground guards, desktop ownership, Abort/approval and unknown-side-effect handling. Switching never silently enables whole-desktop capture or personal-browser DOM access.

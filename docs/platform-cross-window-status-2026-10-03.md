# 三平台跨窗口进度同步（2026-10-03）

## 当前结论

macOS 与 Linux 跨窗口实机验收均未通过完整门槛。当前可以继续验证；不能把代码合入 main、离线测试或三平台 CI 全绿写成三平台跨应用任务已经可用。

GitHub [PR #21](https://github.com/wszkxlllll/Computer-Harness/pull/21) 已于上海时间 2026-10-03 22:10:26 合入 main，merge commit 为 `961a0982ee11bf2f4687756f5184869f197a1b4b`。该 PR 同时包含此前 Runtime Surface Preview `4ecddd2` 与 macOS A 线改动，保留双方历史。Ubuntu Node 22/24、Windows Node 22、macOS Node 22 和汇总检查均成功。

## 代码与证据分开记录

| 平台 | 已接入或已有证据 | 跨窗口验收判断 | 仍需补验 |
| --- | --- | --- | --- |
| Windows | 合并前 Preview 已有 scripted 浏览器↔WPS 往返与 DOM 恢复；Notepad 同 Session 父窗口→菜单→父窗口的 child_push/child_pop 实测成功 | 窄路径已有实机证据；新 main 尚未复测，完整模型生活任务未验收 | 新 main 的 Edge↔Notepad/WPS、独立保存/打开对话框、中文多行与重开核对、DPI 坐标回归 |
| macOS | 注册窗口截图/坐标、DOM 指纹/焦点、平台快捷键和 Surface 动态工具裁剪已合入；作者报告本地构建与离线回归成功；集成前短中文单次任务成功且有一次人工审批 | 不能标记跨窗口通过；集成前单窗口中文成功不证明新 main 跨应用链路 | 浏览器↔TextEdit/其他原生应用、保存 sheet/菜单进出返回、旧引用失效、手机纠正；Retina、多显示器与 AX 焦点证据 |
| Linux | 当前 adapter 路由 SDK/daemon 0.32.0；作者报告 Plasma X11 下仓库外配对、完整截图、Chromium 静态页点击输入成功 | 不能标记 Harness 跨窗口通过；基础 SDK 证据尚不能覆盖当前 Runtime | 当前 main 的 doctor/权限/窗口枚举、两应用主动切换、child 生命周期、输入落点与截图、失败后清理；Wayland 单列，不能沿用 X11 结论 |

PR #21 作者记录的最终离线结果为 107 文件 / 1465 Vitest + 71 TAP；本次读取并核对报告及 GitHub CI，未重新执行这套测试，也未独立复现 Mac/Linux 桌面。

## 合并后的主要变化

- 保留 Surface Registry、跨窗口工具、平台 SDK 路由、语音和偏好；融合 macOS 注册截图、像素坐标、DOM 指纹与实际输入焦点。
- 导航豁免与输入许可绑定当前 session/Surface/browser 和完整控件证据；证据不足可返回 `BROWSER_CHROME_FOCUS_UNCONFIRMED`。这一严格路径仍需真实任务验证是否可用，不能仅以拒绝安全证明可用性。
- 工具目录随当前 Surface 调整：受管浏览器限制原生坐标降级，切到原生窗口后恢复对应能力，返回浏览器后重新裁剪。
- GLM 输出预算、90 秒 Host 请求期限、effort 配置、失败传播及手机重连显示已整合。

## 当前运行版本

main：`961a098`。本机 Pi 工作分支：`codex/runtime-surface-preview-20261003`，原 head `4ecddd2`，是 main 的祖先；本次只 fetch/对比，没有合并或重建本机运行版本。

服务器 Preview release 仍为 `2026-10-03-runtime-surface-v2`，部署业务源码 `600ccec`。本机 Host 此前从该 Preview 系列构建启动。它们都不自动包含 PR #21 的 macOS 整合改动；本次没有重启 Host、切换服务器或操作桌面。

## 下一步验收

各平台先锁定 main SHA、实际 SDK/daemon、Provider 配置和入口，再按统一语义做三项验证：平级应用切换后正确输入；子菜单/对话框进入后关闭并返回父 Surface；跨应用完整任务含人工纠正并交付可核对结果。每项记录同一 ComputerSession、Surface transition、动作 receipt、新观察、最终文件/截图与 cleanup。

失败时保留轨迹并归因；只证明列窗/激活、靠全屏代替窗口链路、人工代切或外部工具代输入，均不能记为自动跨窗口通过。Windows 先回归新 main；Mac/Linux 由各自实机负责人补验，然后更新此台账。

来源：PR #21；main 中 `docs/macos-runtime-surface-integration-2026-10-03.md`、`docs/a-line-progress-review-2026-10-03.md`、`docs/a-line-sync/tests/T-20261003-018.md`；[Linux 配对摘要](./cua-linux-0320-upgrade-verification-2026-10-02.md)与[Windows Surface 交接](./surface-registry-team-handoff-2026-10-03.md)。

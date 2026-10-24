# 安装审查修复与验证

对应队友 PR #45 的安装检查。Demo 环境及默认驱动选择保持原方案。

- 准备脚本先读取已有 NodePath，仅首次配置才从 PATH 查找 Node；补充已有配置且 PATH 无 Node、新目录无 Node 两种测试。
- doctor 明确创建桌面范围的诊断会话。官方 CUA 0.22.2 默认 Auto 会话实际返回 `captureScope=0, effectiveScope=0, desktopUnlocked=false`，不能拿它验证桌面范围已开放。
- Windows 权限按原生 `elevated/integrity_level/integrity_level_rid/post_message/uia` 结构解析；普通非管理员进程可以通过。macOS 的权限判断保留。
- Windows 健康报告明确标为 `not applicable on Windows` 的三个 macOS 项不再导致 degraded；其他 skip、fail、格式错误仍按原规则报告。
- 移除 Fastify 已弃用的 disableRequestLogging 选项；logger=false 仍关闭请求日志。
- 电脑端和 Relay 安装步骤固定到相同源码提交；更新仓库已公开和 Windows 教程范围说明。

## 验证

PowerShell 5.1、7 的准备脚本测试均通过；Node 24.19.0 下 doctor 与 Host HTTP 边界共 28 项测试通过，TypeScript 项目构建通过。首次 Host 测试误用了 PATH 中的 Node 18，SSE 用例超时；改用项目支持的 Node 24 后通过，未调整测试超时。

从官方发布下载 Windows x64 CUA 0.22.2，校验 ZIP SHA-256 为 `1e264492f7f4d69d5b7920c445dd637bef90e45a21a3a90de4fbe63fee0cb388`。通过独立命名管道启动无 overlay 的 daemon，使用实际 SDK 验证默认会话及修复后的 doctor；最终 metadata、inventory、session、health、permissions、cleanup 均为 supported。会话和本轮 daemon 正常关闭；未执行 GUI 点击、输入或截图。

同一官方驱动下，实际 CLI `--computer cua --doctor` 使用默认诊断时限，退出码为 0，整体 supported；诊断结束后独立 daemon 正常退出。

上游依据：

- [0.22.2 会话采集范围](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/cua-driver-core/src/capture_scope.rs)
- [Windows 健康检查及不适用项](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/health_report.rs)

本记录用于维护与复现，不属于比赛报告附件。

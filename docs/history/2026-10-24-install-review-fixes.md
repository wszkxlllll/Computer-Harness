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

## 2026-10-25：按公开说明完成源码冷安装

验收版本为 [v0.1.0-rc.2](https://github.com/wszkxlllll/Computer-Harness/releases/tag/v0.1.0-rc.2)，源码提交 `78d85b4ff4e4c24ef00601f52b6c74a49042a00b`。Windows 从公开版本页重新下载 ZIP，在全新目录执行说明中的两条 PowerShell 命令；服务器重新克隆并检出相同标签，按说明构建、创建独立服务和配置 HTTPS 代理。未复制原工作区的配置、node_modules 或构建产物；依赖安装使用正常的包管理器缓存。

| 步骤 | 结果 |
| --- | --- |
| 源码 ZIP 与配置模板 | 下载解压成功，包含 `.env.example`、`.harness.local.example.psd1` 和两个用户入口脚本 |
| Windows 首次准备 | 真实交互填写连接资料与模型密钥；自动生成私有文件、下载校验官方 CUA 0.22.2、安装锁定依赖；退出 0 |
| Node 多版本环境 | 验证并使用 Node 24.19.0；修订版依赖安装未再出现旧 Node 的 engine 告警 |
| Relay 部署 | Node 22.22.1、pnpm 11.19.0；新目录构建成功，systemd 服务正常，公开 HTTPS 健康检查 200 |
| 电脑端启动 | 按说明 `start -Build` 完成构建，启动本轮官方 daemon 和 Host，连接页面可用 |
| 配对 | 通过电脑网页生成配对二维码、页面提供的配对链接、电脑确认及移动尺寸浏览器连接完成；未调用隐藏管理接口绕过授权 |
| 教程首个任务 | 真实 GLM 调用，打开 example.com 并阅读页面标题与用途；结果返回 Example Domain 和页面用途 |
| 收尾与继续使用 | 同一任务页面确认资源清理完成；新任务表单加载完成后，开始按钮可用 |
| 退出与再次启动 | 按 Ctrl+C 后 Host 监听和本轮 daemon 均退出；再按说明运行不带 `-Build` 的启动命令成功 |

两次 rc.2 任务记录为 `run-1792860311928-d21585a5-fc2` 和 `run-1792860615358-4abc0c88-d8b`，均由发布源码的实际 Harness 执行，未通过外部脚本代替模型读取网页。第二次用于在同一配对会话中补查任务清理。首次补查脚本另建浏览器会话访问前一设备的任务，未取得结果；另一次对刚加载的开始按钮判断过早。后续按实际界面加载与清理状态等待，未修改产品权限或放宽运行校验。

rc.1 首次安装曾出现 npx 使用 PATH 中旧 Node 18 的告警，安装最终完成；rc.2 改为用已验证的 Node 直接运行 npm CLI，补充了回归测试并重新从全新目录安装。两次部署均保留原文件和记录。真实 iPhone 扫码、录音及系统读屏体验由用户后续验收，本轮配对与任务检查使用 Edge 的桌面及移动视口。

发布版本的 [CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/40112288163) 全部通过，包含 Windows、macOS 和两个 Node 基线，以及 Windows PowerShell 5.1/7 准备脚本测试。原服务器服务保留，新实例独立部署。

# 开源发布材料独立审查（2026-10-03）

审查范围：根 LICENSE、package.json、THIRD_PARTY_NOTICES.md、README.md、docs/DOCS-INDEX.md、docs/project-materials.md。除本报告外仅做只读检查，没有启动桌面任务、模型调用、部署、提交或推送。本报告依据当前工作树，用户已确认全体核心贡献者同意原创代码采用 Apache-2.0。

## 结论与分级

当前结论：**GO，源码与文档材料可交付**。Quick Start 的一个 P1 已修正并重新读取核验；这里的发布范围仅为源码和文档，不代表完整安装包、Web bundle、公共 Relay 或跨平台实机体验已经完成发行审计。

- P0：未发现。
- P1：当前未发现。审查中发现的模板复制后直接启动问题已关闭：最新 README 将复制、准备依赖/daemon、编辑本机配置与私有 EnvFile、启动分开，明确示例路径不能直接运行。
- P2：完整传递依赖 JSON、非 Windows x64 binding 的包内 notice、实际发行物的归属文本仍待补齐；材料已明确披露，未冒充完整审计。当前不是源码材料的额外阻塞，打包发行时需完成。

## 许可与依赖核验

LICENSE 与 Apache 项目标准 Apache-2.0 全文按空白归一化逐字比较一致，包含第 1–9 条、条款终止行和附录；没有改写法律条款或填改附录模板。比较来源为 [Apache httpd 官方 LICENSE 的标准 Apache 段](https://raw.githubusercontent.com/apache/httpd/trunk/LICENSE)。根 package.json 为 `Apache-2.0`，README 与项目材料一致。workspace manifest 没有冲突的许可证字段；当前内部包未单独发布。

直接依赖清单覆盖根及全部 workspace 的外部直接运行/开发依赖，名称与锁定版本同 manifest、lockfile importer 一致。NOTICE 表 27 项版本和 license 均通过实际包 metadata 或精确 npm registry metadata 独立核验；运行依赖与开发工具用途分类合理。

CUA SDK `@trycua/cua-driver@0.22.2` 为 MIT；SDK optionalDependencies 精确列出六个平台包，均为 0.22.2。六个 binding 的精确 metadata 都为 `MIT AND MPL-2.0`，已安装 Windows x64 包的 `node-runtime-NOTICE.md` 原文与文档引用吻合；其他五平台使用精确 registry metadata 核验，未假称已检查本机不存在的 tarball。daemon 被单列为用户另备的非 npm 程序，没有与 SDK、binding 或本项目原创实现混同。

TypeScript 5.7.2 的 `LICENSE.txt` 与 `ThirdPartyNoticeText.txt` 在实际安装中存在。其他已安装直接包的许可证文本存在；CUA npm SDK 的本机目录未自带独立 LICENSE 文件，文档提供精确上游 tag LICENSE 来源，未误称其中附带该文件。项目没有用根 Apache-2.0 覆盖第三方代码、外部模型 API、系统环境或用户素材。完整传递清单缺失及 pnpm store 错误均被明确记录，未声称所有传递组件无需 NOTICE。

## 产品、体验与事实边界

最新 README 前半以 Runtime 的桌面目标连续性、Surface 身份、动作后验证、恢复、安全和用户干预为主线，说明 CUA 是独立底层生态；不是模块清单或开发日志首页。手机、语音、个性化与适老定位存在，真实用户无障碍收益仍限定为未验证。Windows、macOS、Linux 分别披露实际验证深度，没有把共享协议当成全平台完成证据。

同日人本交互补充已重新核验：手机、语音、自然语言补充/纠正、审批、暂停/停止及个性化偏好均连接同一 Run 的用户干预能力，仍服务于可靠 GUI Runtime 主线。降低老年人、数字素养较低者和无障碍场景参与门槛使用“目标”“旨在”等设计目标表述；状态段明确实际使用成效尚未验证。没有宣称已获得特定人群收益，没有把产品改造成垂直适老助手；本次复审无新增 P0/P1，GO 保持。

README 只有一个手机 Quick Start，公共 Relay 明确 `planned / 尚未开放`，没有假地址或二维码。TUI/SDK/OSWorld 没有占据首页主使用路径。最新修订明确本地 Host/连接页不等于跨设备配对，手机连接需要可访问的 HTTPS Relay。

五个指定图示/Demo/评测占位各出现一次。六类生活场景与项目材料一致；Demo 与结果图明确待补，没有虚构成功率或把单次探针当成端到端成绩。

2026-10-03 独立查看 GitHub：CUA [Issue #4477](https://github.com/trycua/cua/issues/4477) 为 Open。[PR #4500](https://github.com/trycua/cua/pull/4500) 已合并；最终方案修复 foreground input drain，并保留我方 fixtures、app-owned oracle 和 tests。该合并进入上游代码库，不等同于已经发布到本项目当前锁定的 CUA 版本。[PR #3450](https://github.com/trycua/cua/pull/3450) 为 Open / Changes Requested；验证说明仍保留 Windows native lane 42/43 和一项失败。项目材料所述 OpenClaw [PR #126399](https://github.com/openclaw/openclaw/pull/126399) 与 [PR #127177](https://github.com/openclaw/openclaw/pull/127177) 已合并，范围与其标题/描述一致。

原创代码授权记录限定于用户确认的核心贡献者与 Apache-2.0 选择；没有据此宣称第三方授权已清算、法律风险为零或 AI 生成物为团队独占。README 对新贡献的许可及当前不要求单独 CLA 的描述与 Apache 第 5 条不冲突。

## 只读检查记录

- 六份材料按显式 UTF-8 读取，没有 Unicode replacement 字符或问号替换症状。
- README、NOTICE、索引和项目材料中的本地 Markdown 链接全部存在。
- `mobile.ps1 help` 成功；parser 的 `start`、固定 Node/pnpm 版本和 Provider key 名称与材料一致。最新 Quick Start 已明确示例配置编辑与本机依赖准备步骤。
- 指定材料未发现实际 API key、个人绝对路径或本地 IP 泄漏；扫描中的 `10.4.2` 是 `@testing-library/dom` 版本，属于误报。
- `git diff --check` 对指定范围通过，仅有仓库 CRLF 转换提示。

没有据此声称做过新的冷安装、公共手机配对、模型任务或跨平台实机验证。

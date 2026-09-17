# 可复制的工程模板

这些文件是针对 `Computer-Harness@39ff27f9` 编写的起点，**未提交至 GitHub、未在 GitHub runner 上运行**。已做本地 YAML/结构检查；首次真实 CI 必须验证安装、原生依赖、TypeScript 和 Vitest。不要把这些模板称为“已通过 CI”。

## 文件放置

在新分支逐项审查后，将本目录 `.github/` 的文件复制到仓库根 `.github/`，将 `scripts/create-source-candidate.mjs` 复制到仓库根 `scripts/`。若仓库已经有同名文件，应合并而不是覆盖。文档本身建议保存到 `docs/audits/2026-09-17/`。

根 `.gitignore` 建议添加：

```gitignore
.ci-reports/
release-assets/
```

## CI

`ci.yml` 只使用仓库当前可见的 typecheck、Vitest 和编译后 CLI help。没有配置真实 Provider 密钥、CUA socket 或 OSWorld URL，也不创建 self-hosted job。Linux/Windows 的 Node 22 是基本验证，Linux Node 24 是兼容性验证。pnpm 从根 `packageManager` 读取；本次基线是 pnpm 11.19.0。

验证矩阵的统一门禁名称是 `ci-required`。必须先让它在真实 PR 运行并确认检查名称，再在仓库规则中要求该检查通过。只有一位维护者时，不要配置自己永远无法满足的 reviewer 要求。

测试报告只上传 `.ci-reports/vitest.xml`。不能为排错方便把 `runs/`、`.env`、真实截图或 Provider 原始交换上传。即便是 JUnit，也应确保测试仅使用合成输入，错误信息不包含真实密钥。

所有外部 Action 均固定为本次从官方仓库读取的完整提交 SHA；Dependabot 只先管理 GitHub Actions 更新。不要自动合并供应链更新。版本与来源见附件审计的 `verification/action-pins.json`。

## 候选交付

`release-candidate.yml` 只在 main 上手动运行，执行构建和测试后产生**源码归档**、manifest 和校验和。它不创建 GitHub Release，不发布 npm，不部署桌面，也不是可执行安装包。`create-source-candidate.mjs` 只归档指定提交中 Git 跟踪的文件，拒绝有 tracked 未提交变更的工作目录与已存在的输出目录。

源码归档仍可能包含作者此前错误提交的敏感内容；脚本不提供 secret scanning，也不宣称归档已安全审计。发行前应审查所提交内容。未来要发布产品 TUI，必须另做 OS/arch 打包、依赖闭合、native payload、daemon 获取、许可证和干净机器启动测试。

## 首次落地验收

先在干净 checkout 运行 `pnpm install --frozen-lockfile`，再运行 `pnpm run typecheck`、`pnpm test` 与 `node apps/cli/dist/index.js --help`。实际结果以 runner 日志为准。若原生依赖安装导致问题，应修复平台包/加载隔离，不得通过跳过相关测试伪造通过。不要把 GUI 实机探针偷偷放进普通 PR 的测试命令。

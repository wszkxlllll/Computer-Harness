# Third-Party Notices

审计日期：2026-10-03。本文核对当前 `pnpm-lock.yaml`、根目录及所有 pnpm workspace manifest 的直接运行/开发依赖，并单独核验了集成的 CUA Driver 0.22.2 及其平台可选包。内部 `@computer-harness/*` workspace 包不是第三方依赖；本项目根目录的 Apache-2.0 许可不会把第三方代码改成 Apache-2.0。

除另有说明外，每个表格条目的实际版本与 license 字段均以锁定版本对应的 npm 包 `package.json` 为准，并检查了已安装包附带的许可文本和 notice 文件。包名链接指向精确 npm 版本。运行时包与开发工具按当前源码使用方式区分；仓库当前是 pnpm 源码工作区，没有 npm 发布包或独立应用安装包。Web 生产构建会将 Web 运行依赖打入前端静态资源；Host、CLI、CUA 等 Node 运行依赖仍由 pnpm 安装管理。

## 直接依赖

| 包名与版本 | License | 用途与交付方式 | 核验来源 |
| --- | --- | --- | --- |
| [`@trycua/cua-driver@0.22.2`](https://www.npmjs.com/package/@trycua/cua-driver/v/0.22.2) | MIT | Runtime：`packages/computer-cua` 使用的 CUA TypeScript SDK 客户端；npm 包不包含单独运行的 CUA daemon。 | 锁文件 importer、npm 包 metadata；[CUA 0.22.2 上游 LICENSE](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/LICENSE.md) 声明 MIT。 |
| [`@trycua/cua-driver-darwin-arm64@0.22.2`](https://www.npmjs.com/package/@trycua/cua-driver-darwin-arm64/v/0.22.2) | MIT AND MPL-2.0 | Runtime 可选原生 binding；pnpm 按目标平台安装，不进入 Web bundle。 | CUA SDK `optionalDependencies`、精确 npm metadata；本机未安装此平台包。 |
| [`@trycua/cua-driver-darwin-x64@0.22.2`](https://www.npmjs.com/package/@trycua/cua-driver-darwin-x64/v/0.22.2) | MIT AND MPL-2.0 | Runtime 可选原生 binding；pnpm 按目标平台安装，不进入 Web bundle。 | CUA SDK `optionalDependencies`、精确 npm metadata；本机未安装此平台包。 |
| [`@trycua/cua-driver-linux-arm64-gnu@0.22.2`](https://www.npmjs.com/package/@trycua/cua-driver-linux-arm64-gnu/v/0.22.2) | MIT AND MPL-2.0 | Runtime 可选原生 binding；pnpm 按目标平台安装，不进入 Web bundle。 | CUA SDK `optionalDependencies`、精确 npm metadata；本机未安装此平台包。 |
| [`@trycua/cua-driver-linux-x64-gnu@0.22.2`](https://www.npmjs.com/package/@trycua/cua-driver-linux-x64-gnu/v/0.22.2) | MIT AND MPL-2.0 | Runtime 可选原生 binding；pnpm 按目标平台安装，不进入 Web bundle。 | CUA SDK `optionalDependencies`、精确 npm metadata；本机未安装此平台包。 |
| [`@trycua/cua-driver-win32-arm64-msvc@0.22.2`](https://www.npmjs.com/package/@trycua/cua-driver-win32-arm64-msvc/v/0.22.2) | MIT AND MPL-2.0 | Runtime 可选原生 binding；pnpm 按目标平台安装，不进入 Web bundle。 | CUA SDK `optionalDependencies`、精确 npm metadata；本机未安装此平台包。 |
| [`@trycua/cua-driver-win32-x64-msvc@0.22.2`](https://www.npmjs.com/package/@trycua/cua-driver-win32-x64-msvc/v/0.22.2) | MIT AND MPL-2.0 | Runtime 可选原生 binding；包含 CUA SDK DLL、Node runtime 和 `node-runtime-NOTICE.md`；不随 Computer Harness 源码仓库提交。 | 锁文件与已安装包 `package.json`、notice 文件；其 license 字段也经 pinned pnpm 对精确 npm 版本核验。 |
| [`fastify@5.12.5`](https://www.npmjs.com/package/fastify/v/5.12.5) | MIT | Runtime：Host HTTP server，Node 运行依赖。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`ws@8.21.3`](https://www.npmjs.com/package/ws/v/8.21.3) | MIT | Runtime：Relay、Relay Connector 与实时语音连接，Node 运行依赖。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`string-width@7.2.0`](https://www.npmjs.com/package/string-width/v/7.2.0) | MIT | Runtime：TUI 终端文本宽度和布局，Node 运行依赖。 | 锁定版本的 npm metadata 与包内 `license`。 |
| [`qrcode@1.5.4`](https://www.npmjs.com/package/qrcode/v/1.5.4) | MIT | Runtime：Web 配对二维码，进入 Web 静态构建资源。 | 锁定版本的 npm metadata 与包内 `license`。 |
| [`react@19.3.0`](https://www.npmjs.com/package/react/v/19.3.0) | MIT | Runtime：Web UI，进入 Web 静态构建资源。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`react-dom@19.3.0`](https://www.npmjs.com/package/react-dom/v/19.3.0) | MIT | Runtime：Web UI DOM renderer，进入 Web 静态构建资源。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`zod@3.25.76`](https://www.npmjs.com/package/zod/v/3.25.76) | MIT | Runtime：轨迹和协议数据校验，Node 运行依赖。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`@types/node@22.10.2`](https://www.npmjs.com/package/@types/node/v/22.10.2) | MIT | Development：Node.js 类型声明，不进入运行或 Web bundle。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`typescript@5.7.2`](https://www.npmjs.com/package/typescript/v/5.7.2) | Apache-2.0 | Development：TypeScript 编译器，不进入运行或 Web bundle。 | 锁定版本的 npm metadata、包内 `LICENSE.txt` 与 `ThirdPartyNoticeText.txt`；[v5.7.2 上游 notice](https://github.com/microsoft/TypeScript/blob/v5.7.2/ThirdPartyNoticeText.txt)。 |
| [`vitest@2.1.8`](https://www.npmjs.com/package/vitest/v/2.1.8) | MIT | Development：workspace 单元和集成测试运行器。 | 锁定版本的 npm metadata 与包内 `LICENSE.md`。 |
| [`@types/ws@8.18.1`](https://www.npmjs.com/package/@types/ws/v/8.18.1) | MIT | Development：WebSocket 类型声明，不进入运行或 Web bundle。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`@types/qrcode@1.5.6`](https://www.npmjs.com/package/@types/qrcode/v/1.5.6) | MIT | Development：二维码库类型声明，不进入运行或 Web bundle。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`@types/react@19.3.0`](https://www.npmjs.com/package/@types/react/v/19.3.0) | MIT | Development：React 类型声明，不进入运行或 Web bundle。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`@types/react-dom@19.3.0`](https://www.npmjs.com/package/@types/react-dom/v/19.3.0) | MIT | Development：React DOM 类型声明，不进入运行或 Web bundle。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`@testing-library/dom@10.4.2`](https://www.npmjs.com/package/@testing-library/dom/v/10.4.2) | MIT | Development：Web DOM 测试工具，不进入运行或 Web bundle。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`@testing-library/react@16.3.3`](https://www.npmjs.com/package/@testing-library/react/v/16.3.3) | MIT | Development：React 组件测试工具，不进入运行或 Web bundle。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`@vitejs/plugin-react@6.1.1`](https://www.npmjs.com/package/@vitejs/plugin-react/v/6.1.1) | MIT | Development：Vite React 构建插件，不进入运行或 Web bundle。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`happy-dom@20.14.5`](https://www.npmjs.com/package/happy-dom/v/20.14.5) | MIT | Development：Web 测试 DOM 环境，不进入运行或 Web bundle。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |
| [`vite@8.3.1`](https://www.npmjs.com/package/vite/v/8.3.1) | MIT | Development：Web 开发服务器和静态构建工具；Vite 自身不进入生成的 Web bundle。 | 锁定版本的 npm metadata 与包内 `LICENSE.md`。 |
| [`tsx@4.19.2`](https://www.npmjs.com/package/tsx/v/4.19.2) | MIT | Development：CUA driver spike/探针的 TypeScript 执行器，不进入应用运行包。 | 锁定版本的 npm metadata 与包内 `LICENSE`。 |

此 workspace 的 Host 使用 Fastify；Hono 未出现在当前直接依赖清单和 lockfile workspace importers 中。若未来加入新包、升级版本、增加操作系统 binding 或把应用依赖打入安装包，应重新核对 metadata、许可证文本和对应平台产物。

本仓库不把这些第三方包改写为 Apache-2.0。若单独发布 Web 静态 bundle，应随发布物保留其中运行时依赖对应 npm 版本提供的许可文本和版权声明；Host/CLI 或 CUA 发布物也应保留其随包提供的许可/notice 文件。本仓库没有提交 `node_modules` 或生成的 `dist` 产物，本表链接用于定位精确发行物及其包内许可文件。

## CUA 0.22.2 的边界与保留声明

Computer Harness 自行维护 `computer-cua` adapter、窗口/Surface Registry 和 Runtime 接线；CUA SDK、平台原生 binding 与 CUA daemon 来自 [trycua/cua](https://github.com/trycua/cua)，不是本项目原创组件。SDK 包 metadata 声明 MIT，精确 release tag 的 [LICENSE.md](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/LICENSE.md) 为 MIT。六个平台 binding 包各自的 npm metadata 均声明 `MIT AND MPL-2.0`；不得将它们统称为 MIT-only 或 Apache-2.0。

| 外部组件 | 版本 | License | 用途与交付方式 | 核验来源 |
| --- | --- | --- | --- | --- |
| CUA Driver daemon（非 npm 包） | 0.22.2 | MIT | Runtime 前置条件；使用者按平台单独取得，不包含在 pnpm 安装、Computer Harness 源码仓库或 Web bundle 中。 | [CUA 0.22.2 官方 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.22.2) 与同 tag [LICENSE.md](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/LICENSE.md)。 |

已安装的 Windows x64 binding 附带以下 `node-runtime-NOTICE.md` 声明。其余平台包未安装在本次审计主机上；它们的 metadata 已核对，具体 tarball 内文件仍需在向对应平台分发前逐包检查。

> `cua_driver_node_runtime.node` is a compatibility build derived from the N-API runtime in `uniffi-bindgen-react-native` 0.31.0-3, copyright its contributors and licensed under the Mozilla Public License 2.0. The corresponding source is the pinned npm development dependency plus the deterministic transformations in `scripts/build-node-runtime.mjs`. The source and build script are available in the Cua repository at the release tag that matches this package.

MPL-2.0 正文：[Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/)。MIT 授权文本与版权行见上方精确 CUA release 的 `LICENSE.md`。如果发布物包含任一 CUA 平台 binding，保留该平台包内 `node-runtime-NOTICE.md`、对应 license 声明及适用的上游 MIT/MPL 文本。CUA daemon 是用户在仓库外单独准备的程序，不随此仓库打包；其当前开发指南固定到 0.22.2 release 并要求校验官方 checksum。

## 完整传递依赖清单

上表只展开 workspace 直接运行/开发依赖与 CUA 0.22.2 平台可选包，不手工抄列数百个传递包。完整已安装依赖 license JSON 应在每次发行准备时从锁文件安装结果生成并保存：

```powershell
$licenseJson = pnpm licenses list --json --long
if ($LASTEXITCODE -ne 0) { throw "License scan failed: $LASTEXITCODE" }
$licenseJson | Set-Content -Path .\third-party-licenses.json -Encoding utf8
```

2026-10-03 已使用 Node 24.19.0 和仓库固定的 pnpm 11.19.0 执行该命令；当前本机 pnpm store 缺少 `@types/node@22.10.2` 的 package index，命令以 `ERR_PNPM_MISSING_PACKAGE_INDEX_FILE` 退出，因此**未生成或附带完整传递依赖 JSON**。重新安装/修复 lockfile 对应依赖后再生成，不能把本表当作完整传递依赖审计的替代品。Windows x64 本机已安装包的 NOTICE 文件扫描发现 CUA `node-runtime-NOTICE.md`；未安装平台的 notice 文件仍待各自分发包核验。

当前根目录没有单独的 Apache `NOTICE` 文件。直接 Apache-2.0 第三方依赖 TypeScript 是开发工具；其 npm 包包含 `LICENSE.txt` 和 `ThirdPartyNoticeText.txt`，后者在本机开发安装中保留于 TypeScript 包内。当前源码发行不包含 `node_modules`，Web/Host/CLI 运行产物也不打包 TypeScript；若未来把 TypeScript 工具包一并分发，须保留这两个文件。完整 lockfile 传递依赖清单尚未成功生成，故本次不据此宣称所有传递组件均无 NOTICE/归属文本；报告恢复后需继续检查 Apache-2.0 包及其 notice。

## 外部服务与资源

GLM、Qwen API、可选 TypeSafe/Jev、手机 Relay 托管、OSWorld VM/测试素材和用户打开的网站均不是 pnpm 开源依赖，也不会因根目录 Apache-2.0 获得相同许可。其服务条款、模型权重、用户数据处理和素材授权应按实际部署及账号分别确认。浏览器系统语音和操作系统也由用户环境提供。

# A 线阶段修复 PR 交付说明

日期：2026-10-05。状态：可推送功能分支并建立 Draft PR，不放行 main 合并或宣称完整 A 线验收。

用户本轮范围仅第一项：整理本地 A 线成果、推送独立分支并创建 PR。组员 PR22/PR23 的终审和合并另行处理，本轮未拉取其 head、修改其分支或合并。

## 版本与范围

- Base：`main`，`961a0982ee11bf2f4687756f5184869f197a1b4b`。
- 交付分支：`codex/a-line-cua-provider-hardening-20261005`。
- 原共享分支：`codex/a-line-macos-compat-20260928`，`abb54b2` 已进入上述 main；两提交源码 tree 相同，本轮在保留全部 dirty 改动的条件下建立新分支，没有重置或丢弃已有工作。
- 源码范围：Host GLM 配置、Provider 合同和诊断、Context 预算/进展、Runtime 终态及窗口能力、CUA 控件/输入/拓扑、审批参数与手机状态反馈、对应回归测试。
- Mac 原生材料：`native/cua-driver-macos-topology-v1/` 中的固定上游清单、MIT notices、标准 unified patch 和八个源码镜像；不包含二进制，不自动安装或替换 CuaDriver。
- 文档范围：最新计划、修复/问题/实机事件、跨平台/CUA 审查、交付和协作说明。历史事件按原版本保留，不能将每条历史待测段落当作最新状态。
- 排除：`.DS_Store`、本机配置/凭据、原始 Run、私人截图、profile/cookies、缓存/dist、独立 profile-isolation 工作树以及临时 Rust 工具链/产物。

## 本轮实际验证

下列项目由交付聊天实际执行，不挪用作者报告：

| 验证 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过，exit 0；包含工程引用构建和 CUA spike noEmit |
| `pnpm test` | 通过，exit 0；完整 Vitest 及 71 项 Node TAP 全通过 |
| Vitest JSON 独立复跑 | 108 文件，1663/1663 通过，0 failed/0 pending；不与上一行重复累计 |
| `pnpm --filter @computer-harness/web build` | 通过，exit 0；未部署 Web 或公网 |
| 原生 patch 重放 | 新下载固定 commit `d114f35fec05ecd37bf529e5587be86852205b64` 上 dry-run/apply 通过；15 个 patched file hash、八个镜像及 Cargo.lock 全匹配 |
| 提交前安全和空白检查 | 候选文件未检出常见 GitHub/API token 或私钥标记；未纳入私人配置；apps/packages/原生 overlay 和清单的严格 staged `diff --check` 通过；全范围保留 Markdown 硬换行和 unified patch 空上下文后检查通过 |

这是基础模式扫描而非保证无敏感信息的完整审计；事件只保留脱敏证据索引，不纳入真实像素或凭据。既有 Fastify 弃用警告仍存在，不影响测试结果。

全量新文件的原始 `git diff --cached --check` 会将历史 Markdown 两空格硬换行、`registration.patch` 空上下文行的必需单空格报告为 trailing whitespace。这些文档/补丁字节不作格式重写，以保留原证据、标准 patch 语法和哈希。源码路径单独执行严格检查，全范围另执行 `git -c core.whitespace=-blank-at-eol diff --cached --check`；只改变该命令的检查设置，不修改全局 Git 配置或放宽源码检查。

原生补丁未在本轮重新 cargo 编译或运行。独立重放仅证明交付可复现和源码一致；原生 check/link、219 执行/209 去重测试及真实两图会话来自测试聊天的 T0577/T0578，必须单列为历史实机证据。

## 已改善的体验

- 显式 Host low 推理强度、文本/wire 双预算及安全诊断；保留实际 GUI 回执和最近相关历史，避免预算问题被笼统显示为连接故障。
- 请求末段预留结束工具；裸文本不能绕过显式结束合同误报成功；任务额度耗尽和启动失败准确说明未完成，不重放未知副作用。
- 单窗受管浏览器不伪装开放跨窗能力；Mac 原文多行不误走 Windows 专用 UIA 分支，前台、拓扑和旧 Surface 失效保护保持。
- 独立 checked/mixed/unknown 状态、输入焦点的有限诊断、审批 select 参数的绑定证据和敏感信息遮蔽。
- Mac 原生拓扑及新窗口观察会话源码；富文本控件兼容、附属子角色拒绝、关闭/取消/超时和固定错误分类。

本 PR 不证明服务商响应时间已根治，也不以源码已改宣称旧产品进程已加载新版。

## 实机与放行边界

- T1：T0421 三机型全字段一次成功约122秒；T0422独立重复额度耗尽。仍需新版稳定性复验和变体。
- T2：T0578 同进程准备→官方 GUI 新建→绑定→两次原生 PNG→关闭观察会话/释放通过。input/run/global/activation 许可始终 false；尚未完成生产 Run 桥、正文输入、保存 panel、文件落盘、关闭文稿重开和逐字节核对。
- T3：跨应用、途中纠正预算、旧请求失效和另存重开尚未完整验收。
- 控制：已有一次批准/拒绝及刷新证据；审批中取消、纠正、重复消费、暂停恢复和最新版真实手机仍待成套回归。
- Windows：源码/离线合同有验证，Windows 真机的 DPI、弹窗、Edge/profile 与清理路径尚未完整验收。不能用 Mac 通过代替 Windows 实机。
- 产品环境保持暂停；本轮没有桌面输入、模型 API 调用、Host/CUA/Relay 重启、TCC 修改、公网部署或已安装驱动替换。

## 原生补丁可复现说明

重放以 exact upstream commit、锁文件及 `upstream.json.patchedFileSha256` 为准。GitHub 下载 archive 的压缩 hash 可能因端点/包装变化不同；本轮下载 archive SHA 为 `1033b5b04e068202ec683856069cb4b4bc454b27ddae1d3e0ade791de3ba5857`，不替代作者旧 archive SHA，更不改任意源码/依赖 hash。

本轮只更新 README 和清单的最新验证状态，注册 patch SHA 仍为 `f93988ee6ffde5761d79fcb6061a480f9b1d0af1408fbfe135d35d33930deec9`，全部 Rust 源码 hash 不变；历史 F0526-r2 的66文件交付指纹包含当时文档，不能拿旧指纹强称本轮文档字节相同。

## PR 审查和后续验收

保持 Draft。远端 CI 覆盖 Linux、Windows、macOS 和额外 Linux Node 版本；它是离线合同验证，不编译此隔离 Rust overlay，也不操作真实桌面。

下一步按最新 A 线计划推进生产可信会话接入、T2 保存重开及独立复验，补 T1 稳定性、T3 和剩余手机/团队试用，再评估 main 放行。其他成员 PR 的逐文件审查、冲突取舍与合并是另一项任务，不能以本 PR 建立成功代替。

证据入口：[累计进度/CUA](./review-thread-delivery-status-2026-10-05.md)、[原计划](./a-line-runtime-delivery-plan-2026-09-27.md)、[最新原生 T0578](./a-line-sync/tests/T-20261005-078.md)、[原生源码与复现](../native/cua-driver-macos-topology-v1/README.md)。

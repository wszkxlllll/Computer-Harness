# 模块重构、团队协作与 CI/CD 落地方案

固定基线：`39ff27f9a4ef5431450df6991793403ec890f993`。本方案是在仓库现有 2026-09-16 拆分计划上补充实施次序、正确性约束和 CI，不另起一套互相竞争的架构。[S17]

## 1. 重构结论

继续使用 TypeScript + pnpm monorepo。没有证据支持现在迁移语言、引入微服务、把每个功能都拆成 package，或给 Runtime 套一个庞大通用插件框架。

Runtime 的 `src/index.ts` 已经是 barrel，并有 computer-tools、control-tools、action-validation、action-effect-projection、tool-registry 等文件；真正需要拆的是仍很大的 Controller，以及 Provider、Trajectory、Context、Memory、Planning、Risk 和 CLI 的多职责实现。审计树元数据显示：run-controller.ts 约 64.6 KB，Qwen index.ts 约 42.0 KB，Trajectory index.ts 约 36.5 KB；这是文件字节量，不是复杂度评分。[S01、S06、S12]

原则是 **先行为测试，再移动，再单独改行为**。一次 PR 不同时改变 Event 顺序、模型实际看到的 prompt、Provider wire 和审批机制。

## 2. 第一刀：共用应用组装层

从 `apps/cli/src/index.ts` 抽出 `packages/app-runtime`，让 CLI/TUI 共用：

```text
packages/app-runtime/src/
  config.ts                  # resolved config、默认值、互斥与 profile 校验
  create-run.ts              # controller、工具、store、writer 的组装
  providers.ts               # GLM/Qwen 工厂；不实现 Provider parser
  computers.ts               # CUA/OSWorld 工厂；不实现 GUI 动作
  run-directory.ts           # 每 Run 独立目录、manifest、覆盖策略
  diagnostics.ts             # Recording HTTP 包装与统一脱敏
  index.ts                   # 公共接口
```

CLI 留下参数解析、非交互命令和退出码；TUI 留下展示、输入和 UI 生命周期。配置加载可以共用，但真实 Provider 密钥只在应用组装层读取，不塞进 RuntimeEvent 或 TUI ViewModel。

当前默认输出 `runs/live-cli` 与 writer 的 write-once `wx` 配合，会在第二次复用目录时拒绝写入而不是静默拼接，这个保护应保留。产品入口改为 `runs/<timestamp>-<runId>/`，用户显式复用目录时依然拒绝或要求明确的新 Run 子目录，不能改成 append 解决体验问题。[S06、S08]

## 3. 按包拆分的具体落点

| 包 | 建议内部文件 | 应保留的公共合同 |
|---|---|---|
| protocol | ids.ts / json.ts / computer.ts / model.ts / planning.ts / memory.ts / events.ts / memory-reducer.ts / index.ts | 现有类型及纯状态函数导出；不依赖 UI/具体 Driver |
| trajectory | snapshot.ts / reducer.ts / event-schema.ts / jsonl-writer.ts / asset-store.ts / reader.ts / index.ts | reduceRunEvent、writer、asset 读写行为与序列校验 |
| runtime | command-inbox.ts / model-turn-runner.ts / tool-turn-executor.ts / approval-coordinator.ts / event-committer.ts / run-controller.ts | Controller 外部命令和单执行者不变；分阶段拆，不同时移动所有私有状态 |
| context | compiler.ts / history-selector.ts / budget.ts / memory-selector.ts / projections.ts / trace.ts / index.ts | ModelInput 语义、tool-call/result 配对、用户输入保护 |
| memory | store.ts / fact-tools.ts / entity-tools.ts / validation.ts / index.ts | 模型为语义写入者，mutation 经 Runtime 提交再物化 |
| planning | store.ts / tools.ts / validation.ts / index.ts | 任务状态声明、ID 与依赖引用校验 |
| provider-qwen | adapter.ts / presenter.ts / parser.ts / flat-schema.ts / coordinates.ts / http-client.ts / errors.ts | 各种 wire 回到统一 ModelTurn；保留自家最佳格式 |
| provider-glm | adapter.ts / presenter.ts / parser.ts / tool-schema.ts / coordinates.ts / http-client.ts / errors.ts | GLM continuation 与坐标语义不变 |
| risk-guard | policy.ts / router.ts / provider-assessor.ts / redaction.ts / index.ts | GuardDecision、fail-closed fallback、预算计数 |
| computer-cua | 当前类 + diagnostics.ts / target-binding.ts / coordinates.ts / result-mapping.ts / lifecycle.ts | 不向 Runtime 泄漏 raw CUA 对象；明确 adapter-owned 状态 |

不要立刻把相似的两家 Provider parser 合成一个“大统一 Provider”。先分离各家的 wire 细节，只有真正相同并有双边合同测试的纯代码再复用。例如 token usage 归一、图片 data-url、HTTP deadline 可以评估共用；flat envelope、native control 组合、reasoning continuation 不因长得像就合并。

## 4. 依赖方向与协作边界

```text
apps/cli ─┐
          ├─> app-runtime ─> context / memory / planning / risk / providers / computers
apps/tui ─┘                                  │
                                             v
                                          runtime ─> trajectory ─> protocol
```

具体已有 type import 可保持；重点是 Runtime 不反向依赖 app-runtime 或具体 Adapter，生产代码不 import spikes，Provider 不自己创建 Computer，UI 不直接调用 driver。`protocol` 不为了拆文件而引入上层依赖。初期用静态导入检查或测试维护边界即可，不急着安装庞大架构治理平台。

有 2—3 人/Agent 并行时，最容易冲突的是 protocol/events 和 run-controller。指定一位集成负责人管理协议变更；先合并 DTO/测试合同，再并行做 CUA 与 TUI 实现。不要让三个分支各自给 RuntimeEvent 加同名不同语义字段。

## 5. 测试重新组织

现有 Vitest 默认扫描 `packages/*/src/**/*.test.ts` 与 `apps/*/src/**/*.test.ts`，并不覆盖 scripts/spikes 中全部实验程序；root typecheck 会构建项目引用并额外检查 spike。CI 应先使用这些真实存在的脚本，不调用不存在的 `lint`、`test:e2e`、`test:coverage`。[S19—S21]

测试分四层：

**纯函数层：**预算裁剪、Memory 选择/校验、坐标变换、风险本地规则、文本脱敏。输入输出稳定，适合精确反例和属性测试。

**合同层：**Runtime + fake Computer/Provider + EventWriter，验证事件先后、取消、审批、未知结果、store 物化失败、预算拒绝。

**Adapter 层：**Fake CUA、Mock HTTP、合成图片；不能调用真实 API 或桌面。现有 CUA 测试已经注入 fakeDriver，是可继续扩展的基础。[S23]

**受控集成层：**真实 API conformance、Windows fixture、OSWorld。显式入口、单独预算、专用环境，不默认混到每个 PR。

移动代码时以现有公共接口 golden/fixture 测试保护行为。避免对所有实时随机 ID 和时间写脆弱快照；在测试中注入 clock/idFactory。新增 test helper 可以放同包 `test/` 或统一 testing 包，但不要为了去重一个 fixture 就新增发布单元。

## 6. CI：第一批即可落地

附件 `templates/.github/workflows/ci.yml` 使用现有命令，包含 Linux/Windows Node 22，以及 Linux Node 24 兼容性运行。Node 的精确小版本先由首次 CI manifest 记录，若要求严格重现，再固定到团队已验证补丁版本；不用用户旧机器版本代替安全维护策略。

流程：checkout → setup Node → 安装 packageManager 指定 pnpm → frozen lockfile install → typecheck/build → Vitest → 编译后的 CLI --help → 检查 lockfile 未漂移。JUnit 只作为受控报告上传，不上传 runs、截图、provider exchanges 或 .env。单独 `ci-required` 聚合检查名用于分支保护。

Action 版本采用本次实际查询到的完整 commit SHA，注释标记对应 major：checkout v6、setup-node v6、pnpm action-setup v4、upload-artifact v4。固定 SHA 仍需持续审查升级，附件有 actions Dependabot 起点。[G01、G03]

**模板验证状态：**本次只做 YAML/结构检查；没有在 GitHub Runner 上执行这份 workflow，也没有代替当前工程完成首次安装。首个 PR 必须根据真实 runner 结果修复平台/依赖问题，不能直接宣称全部绿色。

## 7. 真 API / 桌面任务与公开 PR 隔离

公开仓库的 PR 代码不能在你的日常 Windows 开发电脑上使用 self-hosted runner 执行。GitHub 明确警告公开 fork PR 对自托管机器的风险。[G02]

普通 PR 使用 GitHub-hosted、最小 contents:read 权限、不传模型 key；不使用 pull_request_target 来 checkout 外部 PR 并执行测试。真实 API smoke 以后放在 main-only 手动 workflow、受保护 Environment 下，有请求次数/费用上限和合成数据。真实桌面测试更应放私有测试仓库或专用隔离 VM 的显式人工执行流程，不能拿 windows-latest 成功当成你的交互桌面验证。

即使是手动 self-hosted，也要限制可信 ref、专用账户/机器、无日常凭据、可重置环境、拥有权明确的 daemon、并发独占和超时清理。Environment 审批是辅助，不是让任意 PR 代码变安全。

## 8. CD：先交付可追溯候选，再谈自动发布

项目根和当前包使用 private workspace，未验证跨平台可独立安装的 TUI 发行包。不要现在就加 npm publish、自动推送用户桌面，或把未处理 native 依赖的 dist/ 叫便携版。[S19、S25]

附件 `release-candidate.yml` 是 **Continuous Delivery 的起点**：只允许 main 上手动运行，重新安装/构建/测试，生成当前提交的源码归档、manifest 和 SHA256，并上传候选 artifact。**它不是可执行安装包，也不会创建 Release、发布 npm 或部署任何机器。**普通 CI 是合并门禁，候选流程是可复现交付记录。

产品 TUI 通过 fixture 后再增加第二阶段：按 OS/arch 打包，验证 workspace 依赖闭合、CLI bin、native SDK payload、外部 daemon 获取与校验、许可文件、干净机器启动、卸载与回滚。发布使用受保护环境和显式 tag；发布权限只给最终发布 job，构建测试 job 保持只读。首次发布先做 draft，人工确认后放行。

## 9. 仓库治理

本次 main 返回 protected=false，固定提交没有 .github。合并 CI 后再把 ci-required 设置为必需检查；开启禁止随意 force push 和删除主分支。真实多人协作时启用至少一位 reviewer；只有一位实际维护者时不要配置无法满足的审批规则。

附件 CODEOWNERS 仅用真实维护者账号作为初始默认，不虚构团队成员。后续按 protocol/runtime、computer-cua、TUI 分工调整。新增 PR 模板要求写明：行为是否变化、事件/协议是否变化、新反例、执行了哪些测试、是否接触模型 API/真实桌面、文档是否同步。

固定提交根目录未见 LICENSE。公开可读不等于已经给出可复用许可；在外部贡献/发布前由仓库所有者选择并添加合适的许可证，同时保留依赖许可说明。这里不替你选择法律授权条款。

## 10. 小 PR 路线

| PR | 主要内容 | 前置条件 | 退出门槛 |
|---|---|---|---|
| 01 | 基线清单、CI、当前反例测试 | 固定源码和工具版本 | 首次真实 runner 结果已记录；失败不伪装通过 |
| 02 | F02/F03 修复 | 反例已进真实测试 | correction 保留、replacement 无旁路 |
| 03 | F04/F06、日志与默认 profile | 不改变评测默认含义 | 实机 Guard 配置明确、合成敏感标记不泄漏 |
| 04 | F07、cleanup deadline | fake fault injection | 清理有界且 unknown 不改写 |
| 05 | app-runtime、run 目录、事件订阅 | CLI 行为 fixture | CLI/TUI 共用组装；UI 失败不改状态 |
| 06 | 大文件行为保持拆分 | PR05 稳定 | exports / event order / wire fixtures 不变 |
| 07 | CUA doctor、目标与审批边界 | PR03/04；明确合同 | 专用 fixture 的切焦点/窗口变化测试通过 |
| 08 | 产品 apps/tui | PR05/07 | Fake→只读→低风险 fixture 门槛逐级通过 |
| 09 | ContextTrace、预算报告、Memory 小增强 | PR02 | 失败归因可追踪，真实成本有记录 |
| 10 | Monitor shadow/消融与候选交付 | PR09/08 | 效果/误报数据，不仅演示成功 |

这是依赖顺序，不是承诺工期。PR02/03 可由不同人并行，但修改同一 Controller 时要指定集成人；纯文件迁移和正确性补丁不要互相交织。以每个 PR 的验收作为完成单位，比按“重构两天、TUI三天”的日历承诺更可靠。


## 依据与定位

- [S01：Runtime 主执行路径](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/runtime/src/run-controller.ts)
- [S06：Trajectory Reducer / Writer / AssetStore](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/trajectory/src/index.ts)
- [S08：CLI 参数、组装与 Provider 日志](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/apps/cli/src/index.ts)
- [S12：Qwen Adapter](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/provider-qwen/src/index.ts)
- [S13：GLM Adapter](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/provider-glm/src/index.ts)
- [S17：现有产品 TUI / 拆分计划](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/docs/product-tui-and-module-refactor-plan-2026-09-16.md)
- [S19：根 package.json](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/package.json)
- [S20：pnpm workspace 与 native 依赖配置](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/pnpm-workspace.yaml)
- [S21：Vitest 配置](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/vitest.config.ts)
- [S23：CUA Adapter 测试](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/computer-cua/src/cua-driver-computer.test.ts)
- [S25：CUA 锁定依赖](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/computer-cua/package.json)
- [S26：CLI TypeScript 构建输出](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/apps/cli/tsconfig.json)
- [G01：GitHub Actions 安全参考](https://docs.github.com/en/actions/reference/security/secure-use)
- [G02：GitHub 自托管 Runner 风险](https://docs.github.com/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access)
- [G03：pnpm action-setup 已核对的说明](https://github.com/pnpm/action-setup/blob/b906affcce14559ad1aafd4ab0e942779e9f58b1/README.md)

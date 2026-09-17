# Computer-Harness 源码审计与整改入口

**审计日期：2026-09-17**  
**仓库：wszkxlllll/Computer-Harness**  
**固定源码：39ff27f9a4ef5431450df6991793403ec890f993（简称 39ff27f9）**  
**结论：有条件推进。保留现有架构，先补正确性与实机交互边界，再做产品 TUI、CUA 扩展和模块重构。**

## 1. 放行范围

可以推进无真实桌面的 Fake / fixture 回归、纯重构、CI 建立、Context 与 Memory 修复、只读 CUA 能力探测。真实 GUI 输入先限定为专用临时应用或隔离测试桌面，必须有人在场，且不能把“有审批按钮”当作已解决环境新鲜度问题。

暂不建议在包含真实账号、凭据、私人文档的日常桌面上放行支付、发送、删除、权限变更等动作。这里的 P0 表示“进入该实机使用范围前的阻塞项”，不是宣称已经发现任意远程代码执行漏洞。

## 2. 本次实际做了什么

通过 GitHub 连接器固定提交读取了 Runtime 主循环、Context、Memory、Planning、Risk、CUA Adapter、CLI/TUI、两家 Provider 的关键路径，以及 Trajectory 的核心状态迁移和持久化逻辑；抽查 Context、CUA 的测试，阅读现有产品计划、能力探针和轨迹统计脚本。针对 CUA 扩展，对照的是项目真正锁定的 **0.22.2**，对应上游提交 **d114f35fec05ecd37bf529e5587be86852205b64**，不是拿最新主干功能反推旧版本能力。

本次另外在 Node **v22.16.0** 执行了 **6 个提取逻辑复现用例**，覆盖 5 类行为：用户纠正被预算裁剪、单事件预算溢出、Memory replacement 校验遗漏（2 个用例）、风险文本规则漏检、原生工具参数日志保留。详细结果见 [verification/probe-results.tap](verification/probe-results.tap)。它们全部复现了预期的当前行为。

**没有完成的验证：**当前容器无法联网 clone / 安装这个仓库的依赖，因此没有执行整个仓库的 `pnpm typecheck`、`pnpm test`，没有调用付费 Provider，也没有连接 CUA 或操作真实桌面。提取逻辑复现不是仓库集成测试，更不是 Windows 实机证明。仓库文档中的“179 项测试”等是作者历史记录，不作为本次独立运行结果。

GitHub 的 `main` 分支查询返回 `protected: false`，required status checks 为 off；固定提交根目录也没有 `.github/`。这是本次读取时的设置，不代表之后不会改变。

生成的工作流完成本地 YAML/结构校验，候选源码归档脚本在合成 Git 仓库中完成了归档、校验和、拒绝覆盖和拒绝未提交变更检查；这些也不等于 GitHub CI 已通过。结果见 [verification/template-checks.json](verification/template-checks.json)。

## 3. 先纠正面试讨论中不准确的判断

| 讨论中的印象 | 源码实际情况 | 正确整改方向 |
|---|---|---|
| 没有处理用户中途纠正 | 有命令队列、旧 ModelTurn / ToolTurn 失效、重观察路径 | 补预算裁剪保护、交互响应与当前指令版本，不重写整个 correction 系统 |
| unknown outcome 没保护 | GUI 执行异常已有 `outcome_unknown` 终止、未决 action 保留，不自动重试 | 保留这一保守机制，补实机说明和有界清理 |
| Memory 依赖 observationId 变化就全部拒绝 | 当前源码使用运行时盖章的 `sourceEventId + updatedSequence`；有 active / needs_check / superseded | 不按旧口述实现“替换 observationId 校验”；修真实 mutation 校验、长度与生命周期边界 |
| Receipt 完全不进上下文 | `actionReceiptOutput` 的状态/说明会作为 ToolResult 投影进入 Context | 区分原始执行遥测与模型可见结果投影，不能当作任务成功证明 |
| 所有包都只有一个文件 | Runtime 已拆多个文件，CUA 也有独立实现；但 Controller、Provider、Trajectory 等仍大 | 按职责继续拆分，而不是机械增加文件数 |
| TUI 从零开始 | 已有 `apps/cli --tui`，且仓库已有独立产品 TUI 计划 | 把调试控制台产品化，复用执行内核 |
| 完全没有评测诊断 | 已有离线重复动作、请求、延迟、token 统计 | 补每轮 Context 组成、实际请求预算、归因和在线 shadow monitor |
| Risk 只有关键词 | 已有可选 ProviderRiskAssessor、预算、超时与审批 fallback | 修默认开关和输入信任边界，而非再加一个重复 verifier |

这些判断分别可在 S01、S03—S10、S16—S18 定位。

## 4. 文档导航

| 文件 | 用途 |
|---|---|
| [01-runtime-context-memory-remediation.md](01-runtime-context-memory-remediation.md) | 17 项审计问题、修复边界、测试要求，以及 Memory / Monitor / Evaluation 的可行设计 |
| [02-cua-tui-live-testing.md](02-cua-tui-live-testing.md) | CUA 能力利用顺序、窗口/焦点与坐标合同、TUI 产品化和实机验收门槛 |
| [03-refactor-ci-cd.md](03-refactor-ci-cd.md) | 具体拆文件方案、依赖边界、协作 PR 顺序、CI/CD 与发布治理 |
| [04-agent-work-orders.md](04-agent-work-orders.md) | 可交给开发 Agent 的实施工单、输入输出、禁止事项、验收条件 |
| `verification/` | 六项提取逻辑复现、真实 TAP 输出与验证范围说明 |
| `templates/` | CI、候选交付制品 workflow、Dependabot、CODEOWNERS 起点；未写入远端 |

## 5. 推荐执行顺序

**第一批：建立基线和门禁。** 在用户本机或干净 runner 上跑现有 typecheck/test，记录版本与失败；先提交 CI。同步补 F02/F03 的失败测试，再修代码。日志脱敏和 TUI 默认风险配置属于另一组相对独立补丁。

**第二批：封住实机边界。** 做有界清理、目标窗口/焦点绑定、审批新鲜度与人工接管。此阶段不把后台投递当成通用替代方案，不升级 CUA 依赖来顺带解决一切。

**第三批：行为保持重构与产品 TUI。** 抽出共用 app-runtime 和事件订阅，再拆大文件；产品 TUI 先接 Fake，再接只读 CUA，最后专用 fixture 输入。

**第四批：可解释评测与增益优化。** ContextTrace、run manifest 与预算校准先于复杂 Memory 生命周期。Monitor 先 shadow 只记录，再评估触发式 guidance。Subagent、全量工具检索、跨运行记忆不放进这次必修清单。

## 6. 总体约束

保留单主 Agent GUI 执行者；子 Agent 未来只做只读调研。保留模型管理工作记忆语义的方式；Runtime 管引用、生命周期和硬边界，不冒充语义裁判。不强制每几步 Plan，不默认每一步增加一次模型复核。不能用“来源 ID 存在”“receipt completed”“页面变化”分别冒充“事实正确”“任务成功”“任务进展”。

本次只在附件包生成文档、验证代码和模板，没有修改远端业务代码、工作流、分支保护或仓库 docs 入口。将来合并文档时，把这些文件放到仓库 `docs/audits/2026-09-17/`，并从当前阶段入口链接本页。


## 依据与定位

- [S01：Runtime 主执行路径](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/runtime/src/run-controller.ts)
- [S03：Context 编译、裁剪与 Memory 召回](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/context/src/index.ts)
- [S04：Memory 工具与文件存储](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/memory/src/index.ts)
- [S06：Trajectory Reducer / Writer / AssetStore](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/trajectory/src/index.ts)
- [S08：CLI 参数、组装与 Provider 日志](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/apps/cli/src/index.ts)
- [S09：当前调试 TUI](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/apps/cli/src/tui.ts)
- [S10：Risk Guard 分流与可选语义评估器](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/risk-guard/src/index.ts)
- [S16：离线轨迹统计脚本](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/scripts/stage5-osworld/analyze-trajectory.mjs)
- [S17：现有产品 TUI / 拆分计划](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/docs/product-tui-and-module-refactor-plan-2026-09-16.md)
- [S18：现有 Risk / 本机 TUI 验证计划](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/docs/risk-guard-real-api-and-local-tui-plan-2026-09-16.md)
- [S25：CUA 锁定依赖](https://github.com/wszkxlllll/Computer-Harness/blob/39ff27f9a4ef5431450df6991793403ec890f993/packages/computer-cua/package.json)

后续审计与实施以本入口、工单及固定提交为依据，不依赖先前口述印象或跨会话记忆。

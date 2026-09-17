# 产品 TUI 与模块拆分计划

后续审计补充：[2026-09-16 深入审计总览](audit-2026-09-16-overview.md)。实施本计划前先读其中交互/风险和架构/CI/CD 分项：补充了前台焦点冲突、审批后目标复核、RunController 内部拆分、配置一致性和先建 CI 的要求。本文件原有拆分表仍是建议，不代表已实施。

## 1. 当前判断

`apps/cli --tui` 是验证 RunSnapshot、EventStream、Approval 和控制命令的调试界面，不是最终产品 TUI。Claude Code 同样由终端命令启动，但其命令进入的是持续交互应用；本项目最终也应提供独立 `apps/tui` 可执行入口，而不是在一次性 CLI Runner 上继续堆显示逻辑。

当前单文件 package 是 Stage 驱动开发留下的结构债，不是目标架构。拆分依据应是职责、依赖方向和可独立测试边界，而不是机械追求文件数量。`index.ts` 最终只做公共 API barrel，不承载几百行实现。

## 2. 应用分层

```text
apps/cli                 无交互/脚本/批量实验入口
apps/tui                 Claude Code 风格持续交互入口
        \               /
         packages/app-runtime     组装 Provider、Computer、Tools、Stores、RunController
                    |
              RunController
                    |
        Snapshot + Event subscription + Commands
```

`apps/tui` 推荐使用 Ink/React 构建组件化终端界面：会话历史、ToolCall 卡片、Plan/Memory 面板、Guard/Approval 对话框、输入框和状态栏。它只调用既有 `submitUserInput`、`resolveApproval`、`pause`、`resume`、`cancel`，不复制 Agent Loop。截图首版通过资产路径打开；终端图片协议作为可选增强。

Runtime 需要增加只读事件订阅接口或可组合的 Event Writer，避免产品 TUI 每 120 ms 复制全部事件。Snapshot Reducer 仍是权威状态，TUI 本地 ViewModel 不是第二份业务状态。

## 3. 行为保持拆分

第一轮只移动代码，不改协议或行为：

| Package | 建议文件 |
|---|---|
| `protocol` | `ids.ts`、`json.ts`、`computer.ts`、`model.ts`、`planning.ts`、`memory.ts`、`events.ts`、`index.ts` |
| `trajectory` | `event-schema.ts`、`reducer.ts`、`jsonl-writer.ts`、`asset-store.ts`、`reader.ts`、`index.ts` |
| `provider-qwen` / `provider-glm` | `adapter.ts`、`presenter.ts`、`parser.ts`、`tool-schema.ts`、`coordinates.ts`、`http-client.ts`、`errors.ts`、`index.ts` |
| `context` | `compiler.ts`、`budget.ts`、`history-selector.ts`、`projections.ts`、`index.ts` |
| `planning` | `tools.ts`、`store.ts`、`validation.ts`、`index.ts` |
| `memory` | `fact-tools.ts`、`entity-tools.ts`、`store.ts`、`validation.ts`、`index.ts` |
| `risk-guard` | `router.ts`、`policy.ts`、`provider-assessor.ts`、`redaction.ts`、`index.ts` |

原有测试先不按文件一一搬迁；随后按公共合同、纯函数和 Adapter 集成三层组织。禁止在拆分时顺便改变 Provider wire、Event 顺序、审批语义或 Context 内容。

## 4. 实施顺序

1. 冻结当前真实 API 摘要、179 项测试和 CLI help 作为基线；
2. 抽出 `app-runtime`，让 CLI 与未来 TUI 共用同一组装函数和配置类型；
3. 拆 `protocol`、`trajectory`，每步保持公共 export 不变并运行全量测试；
4. 拆 Provider、Context、Planning、Memory、Risk Guard；
5. 新建独立 `apps/tui`，先接 Fake Computer，再接 CUA 只观察任务；
6. 通过 TUI 做低风险本机体验，体验问题回到所属模块修复。

## 5. 产品 TUI 最小验收

- 启动后可创建 Run，并在同一界面持续输入多轮纠正；
- ToolCall、Receipt、Guard 和 Approval 按事件顺序展示；
- 高风险默认拒绝，批准必须显式操作；
- Plan、Memory、Token、延迟和截图路径可查看但不复制权威状态；
- Abort 后界面不再接受旧 Run 的审批或输入；
- Headless CLI 与 TUI 对同一 fixture 产生一致 Runtime 轨迹；
- TUI 崩溃不改变已经落盘的 Event，也不导致未知 GUI 副作用自动重试。

当前 `--tui` 保留为内部调试工具，独立产品 TUI 验收前不把它写成最终产品能力。

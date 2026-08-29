# Computer Harness

Computer Harness 是一个独立的、Provider-neutral 的多模态 GUI Agent Runtime
实验仓库。它位于多模态模型和 Computer Driver 之间，负责统一 Observation、
ToolCall、GUI Action、运行状态和轨迹记录。

当前仓库已完成 Stage 2 Fake Runtime 和 S3-0 合同收口，下一步进入 Stage 3：先完成 CUA
能力/Schema 探测和协议决策，再实现真实 `CuaDriverComputer`。当前状态是“Runtime 可测试、
真实桌面未宣称通过”：

- 已建立 pnpm workspace；
- 已固定 TypeScript、Vitest 工程基线和 CUA Driver 0.22.2；外部输入需要 Schema 校验时再按包引入 Zod；
- 已实现核心 protocol 类型；
- 已实现 JSONL RuntimeEvent Writer、最小 FileAssetStore 和纯函数 RunSnapshot Reducer；
- 已加入 CUA 0.22.2 的安全技术探针；
- 已实现 `packages/runtime` 的 FakeProvider/FakeComputer RunController、命令 Inbox、
  失败注入和统一 Action/Capability/Viewport 校验；
- 尚未接入真实 Provider 或产品级 CuaDriverComputer，不能把 59 项 Fake 测试通过写成真实
  桌面成功率。

## 环境

- Node.js 18.19 或更高的 LTS 版本；
- pnpm 11；
- Windows、macOS、Linux 均可参与代码开发；
- 真实 CUA 探针需要对应平台的原生权限和桌面会话。

依赖只安装在本仓库的 workspace 中，不修改其他 OpenClaw 或 LightSpeaker 环境。

## 安装与检查

```text
pnpm install
pnpm run typecheck
pnpm test
```

## 阶段 0：CUA 安全探针

默认只读取屏幕，不执行鼠标或键盘输入：

```text
pnpm probe:cua
```

输出位于 `spikes/cua-driver/runs/<session>/`，其中可能包含当前桌面截图，
该目录已加入 `.gitignore`，不得提交或上传隐私截图。

只有在准备好专门测试桌面后，才显式执行输入探针：

```text
pnpm --filter @computer-harness/cua-driver-spike probe -- --allow-input --click-x 300 --click-y 200
pnpm --filter @computer-harness/cua-driver-spike probe -- --allow-input --type "probe text"
```

这两个命令不是默认测试，也不会自动判断点击是否符合用户目标。它们只验证
Driver 的底层输入和前后观察链路。

## 代码边界

```text
packages/protocol    公共运行协议，不依赖 CUA 或 Provider
packages/trajectory  Event 落盘、资产引用和 Snapshot 投影
spikes/cua-driver     可删除的底层 CUA 探针，不属于正式 Adapter
```

后续正式包将按技术计划逐步加入：`computer-cua`、
`providers`、`tools`、`context`、`policy` 和可选 `planning`。每个包必须有
当前生产者、消费者和测试，不为未来能力提前加入空接口。

## 施工顺序

```text
CUA 探针与平台事实
        ↓
Protocol + EventWriter + Reducer
        ↓
FakeProvider/FakeComputer + RunController（Stage 2 已完成）
        ↓
CUA 能力矩阵与协议决策（Stage 3 当前入口）
        ↓
CuaDriverComputer
        ↓
第一个真实 Provider
        ↓
第二个 Provider 和真实任务
```

详细协议、状态机、失败语义和验收门槛见：

- `docs/gui-agent-harness-v1-technical-plan.md`
- `docs/multimodal-gui-agent-harness-product-plan.md`
- `docs/stage-3-implementation-entry.md`
- `docs/stage-3-cua-capability-audit-and-provider-boundary.md`
- `docs/stage-3-s1-capability-probe-results.md`

## 安全与隐私

- API Key 使用环境变量或本地 Secret 管理，不写入 Event；
- 截图只保存在本地 ignored 目录；
- 未确认的 GUI 副作用不能自动重复执行；
- Event 中的 `action.execution.started` 缺少终态时表示 `outcome_unknown`，
  恢复默认先重新观察。

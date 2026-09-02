# Computer Harness

Computer Harness 是一个独立的、Provider-neutral 的多模态 GUI Agent Runtime
实验仓库。它位于多模态模型和 Computer Driver 之间，负责统一 Observation、
ToolCall、GUI Action、运行状态和轨迹记录。

当前仓库已完成 Stage 3 的真实 CUA 合同收口，并按 Stage 4 入口接入
Context、canonical Computer Tools、GLM/Qwen Provider 和 CLI。当前状态是“Runtime、CUA
适配器和 Provider fake 契约可测试，真实模型/桌面任务仍需在隔离环境中运行”：

- 已建立 pnpm workspace；
- 已固定 TypeScript、Vitest 工程基线和 CUA Driver 0.22.2；外部输入需要 Schema 校验时再按包引入 Zod；
- 已实现核心 protocol 类型；
- 已实现 JSONL RuntimeEvent Writer、最小 FileAssetStore 和纯函数 RunSnapshot Reducer；
- 已加入 CUA 0.22.2 的安全技术探针和真实 `packages/computer-cua` 适配器；
- 已实现 `packages/runtime` 的 FakeProvider/FakeComputer RunController、命令 Inbox、
  失败注入和统一 Action/Capability/Viewport 校验；
- 已实现 `packages/context` 的时序投影、`packages/provider-glm` 的两个 profile、
  `packages/provider-qwen` 的 GUI-Plus 原生工具调用适配，以及 `apps/cli` 组合入口；
- fake 契约不等于真实模型成功率，真实 API 和隔离 CUA fixture 仍需按 Stage 4 门槛运行。

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

## Stage 4 CLI（隔离真实运行）

CLI 只从环境变量读取密钥，并把完整 Event 与截图资产写入指定输出目录。需要一个已经运行的
CUA daemon socket；不会自动启动 daemon，也不会把 fixture 结果写成模型结果。`summary.json` 同时展示
实际 Computer session 的 backend、viewport 与 capabilities，便于确认运行时能力。

```text
pnpm --filter @computer-harness/cli build
pnpm --filter @computer-harness/cli start -- --goal "click the input and type Harness" --model glm-5.3-flash --cua-socket "<CUA socket>" --output "runs/stage4-glm53" --env-file ".env"
# 需要终端回答时才追加：--interactive
```

允许的 `--model` 值为 `glm-5.3-flash` 和 `gui-plus-2026-02-26`。GLM 使用
`ZHIPUAI_API_KEY`，Qwen 使用
`DASHSCOPE_API_KEY`；Qwen 若未提供 `DASHSCOPE_BASE_URL/ENDPOINT`，会由
`DASHSCOPE_WORKSPACE_ID` 生成已验证的 Workspace endpoint，否则使用公共 compatible-mode endpoint。
可用 `GLM_BASE_URL` 或 `DASHSCOPE_BASE_URL` 覆盖端点。可选
`--max-steps`、`--max-model-requests`、`--fixture-result` 和
`--screenshot-dir` 用于隔离实验。

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
packages/protocol       公共运行协议，不依赖 CUA 或 Provider
packages/trajectory     Event 落盘、资产引用和 Snapshot 投影
packages/runtime        RunController、Policy、Tool Registry 和 GUI Action 路由
packages/context        默认时序 Context 编译器
packages/provider-glm   GLM-5.3 profile
packages/provider-qwen  GUI-Plus Adapter
packages/computer-cua   trycua/cua-driver 适配器
apps/cli                组合依赖、运行展示和轨迹输出
spikes/cua-driver       可删除的底层 CUA 探针
```

每个包必须有当前生产者、消费者和测试，不为未来能力提前加入空接口。V1 暂不包含
Memory、Verifier、RL、后台 Job、Subagent、Dashboard 或第三个 Provider。Qwen GUI-Plus 当前只声明
官方 `computer_use` 的 `key/type/left_click/wait/terminate/interact` 子集；scroll/drag 不会被伪装为已支持。

## 施工顺序

```text
CUA 探针与平台事实
        ↓
Protocol + EventWriter + Reducer
        ↓
FakeProvider/FakeComputer + RunController（Stage 2 已完成）
        ↓
CUA 能力矩阵与协议决策（Stage 3 已关闭）
        ↓
S4-0 Context/Asset/预算合同
        ↓
S4-1 canonical Computer Tools
        ↓
S4-2 GLM/Qwen Adapter
        ↓
S4-3 CLI 与隔离真实短任务
```

文档先读 [docs/DOCS-INDEX.md](./docs/DOCS-INDEX.md)。它区分当前执行、长期设计、历史证据和已废弃路线；新增或修改文档遵守 [开发文档规范](./docs/development-documentation-standard.md)。详细协议、状态机、失败语义和验收门槛见：

- `docs/gui-agent-harness-v1-technical-plan.md`
- `docs/multimodal-gui-agent-harness-product-plan.md`
- `docs/stage-4-implementation-entry.md`
- `docs/DOCS-INDEX.md`（当前入口和历史文档边界）

## 安全与隐私

- API Key 使用环境变量或本地 Secret 管理，不写入 Event；
- 截图只保存在本地 ignored 目录；
- 未确认的 GUI 副作用不能自动重复执行；
- Event 中的 `action.execution.started` 缺少终态时表示 `outcome_unknown`，
  恢复默认先重新观察。

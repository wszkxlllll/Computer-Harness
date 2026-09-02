# P0 开工就绪复审

日期：2026-09-03  
文档角色：审计 / 实施门  
状态：当前执行  
审计基线：`HEAD=d967b0d`；本轮包含未提交的 P0-4 Schema 实现与定向测试  
上游入口：[Stage 4 实施入口](../stage-4-implementation-entry.md)  
详细问题定义：[Runtime / Trajectory / CUA Adapter / Provider 复审](./runtime-trajectory-cua-adapter-issues-2026-09-02.md)

## 1. 结论

**P0-4 的实现已经通过静态质量门和真实 API conformance；P0 整体仍未关闭，必须完成 P0-1、P0-3 和
Qwen 坐标对照后，才能恢复 Stage 4 正式评测。**

本轮删除的是 `glm-4.6v-flash`，不是 Qwen。删除后的现行执行面已经统一为：

- `glm-5.3-flash`；
- `gui-plus-2026-02-26`。

CLI、API conformance runner、Stage 4 runner 和冻结任务 manifest 均未再消费
`glm-4.6v-flash`。活动文档中的少量 4.6V 文本仅用于说明它已被移除，不是执行指令。

当前不需要先补 P1/P2，也不需要扩展任务、Memory、Verifier 或 Dashboard。应保持四项 P0 的变量隔离。

## 2. 当前验证

- `pnpm test`：8 个测试文件，99/99 通过；
- `pnpm run typecheck`：通过；
- `pnpm --dir spikes/cua-driver run test:stage4-runner`：通过；
- 真实 API conformance：GLM-5.3-Flash 与 Qwen GUI-Plus 均 HTTP 200，两个 Provider 各完成 2 轮，
  每轮返回一个原生 `message.tool_calls`，解析为 Harness `ToolCall`；没有执行 CUA 或桌面副作用。
- 证据目录：`runs/api-conformance/function-schema-live-20260903/summary.json`（请求 URL、图片和凭据均已脱敏）。
- 当前工作树包含本轮未提交的 Provider、Runtime 测试和文档改动；不能把它误报为干净 checkout。

这些结果说明当前 Schema 改造没有破坏既有覆盖路径；它们不能替代 P0-1、P0-3 和 Qwen 真实坐标对照的新增验收。

## 3. P0 的正确拆分

### PR A：Runtime 动作后观察失败的事实顺序

当前顺序仍是：

```text
Action 终态 → post-action observe → ToolCall 终态
```

应改为：

```text
Action 终态 → ToolCall 终态 → post-action observe
```

若 post-action observe 失败，记录 `runtime.error` 并以 `failed` 结束 Run；不得删除或反向改写已经确定的
Action/ToolCall 事实，也不得再次执行动作。只有 Driver 本身未能返回确定结果时才使用
`outcome_unknown`。

必须增加定向测试：首次观察成功、动作 completed、第二次观察抛错；断言 Action 与 ToolCall 都有终态、
Run 为 failed、动作只执行一次。

### PR B：GLM-5.3 reasoning continuation

当前 Adapter 开启 thinking，却不读取或回传 `reasoning_content`。修复不能使用无生命周期的 Adapter
内存 Map，也不能在公共协议中放无人消费的 `unknown`。

最小合同必须明确：

1. GLM 响应解析是生产者；
2. `model.response.received` / Context 投影负责保存并传递；
3. 下一轮 GLM 请求呈现是消费者；
4. 只在同一 Run、同一 Provider 的被选中历史中存在，Run 结束后释放；
5. 默认 UI/摘要不展示该内容；若轨迹持久化它，要沿用模型响应的隐私边界。

建议用一个窄类型的 provider continuation 合同承载它，内容类型为 `string` 或 `JsonValue`，不要使用
`unknown`，也不要顺手建立通用 Memory/Cache 系统。验收采用固定两轮 fixture：第一轮返回
`reasoning_content + tool_calls`，第二轮必须原样带回 reasoning、同一 ToolCall ID 和 tool result。

`packages/provider-glm` 中剩余的 `normalized_1000`、任意自定义 profile 和条件 Prompt 已无生产执行消费者，
仅测试仍在使用。因为 PR B 本来就会修改 GLM Adapter，可在同一 PR 中把生产合同收敛到
`glm-5.3-flash + actual_pixels + thinking enabled`；保留 `httpClient`、`endpoint`、`assetReader` 这些已有的
测试/部署接缝。不要为这项清理另造一套抽象或独立大 PR。

### Experiment C：Qwen wire paired comparison

这一步先是实验，不是预设结论的 Provider 修复。临时脚本只比较：

- 同一 Function Calling wire 下的实际像素坐标；
- 同一 Function Calling wire 下的 0--1000 归一化坐标。

两组都必须使用 `tools` 请求字段和 `message.tool_calls` 响应，不再把官方 text `<tool_call>` 协议作为本实验
变量。模型快照、Endpoint、任务输入、截图字节、Viewport、工具集合、历史窗口、Prompt、思考开关、预算和
外部 evaluator 必须固定；唯一变量是坐标表示及其对应的 Schema/解析映射。两组分别保存脱敏请求、原始响应、
解析结果、外部 evaluator、成本、延迟和坐标转换诊断。禁止正则修复损坏 JSON，禁止同时改 Prompt、任务或
Context。

实验结束后只选择一个有证据支持的正式坐标默认：另一种只作为明确配置或后续实验，不在生产 Adapter 中
同时保留隐式猜测。实验开关和临时解析器只能放在实验 runner 中，不能永久留在生产 Adapter 中。

### P0-4：Provider Function Calling Schema 细化（Experiment C 之前的静态门）

本项已经在当前工作树实现，并已通过静态质量门及一次真实 API conformance；它仍需作为独立 PR 提交，不能和
坐标对照实验混在一起：

- Qwen 已从单一 `computer_use(action=...)` 改为“每个可用 Runtime 工具一个独立 Function Schema”；
  `click/type/keypress/hotkey/scroll/drag/wait` 各自携带自己的 `required`、字段描述和
  `additionalProperties: false`，并额外提供 `terminate(status)` 与 `interact(text)`。
- Qwen/GLM 都根据当前 Observation 的 Viewport 为坐标字段添加生成阶段边界：归一化模式是 0--1000，
  实际像素模式是当前 viewport 的宽高；没有 viewport 时只保留描述，不能伪造边界。
- Qwen/GLM Parser 都检查返回的函数名是否属于本轮 `input.tools`；未知工具在进入 Runtime 前拒绝。
- Qwen 的 wire 参数与 GUI-Plus 实际返回形状对齐：`click.coordinate`、`drag.coordinate/coordinate2`、
  `scroll.coordinate/pixels/direction`、`wait.time`；Parser 将其严格映射为 Harness 的 `x/y`、`fromX/...`、
  `direction/ticks` 和 `durationMs`。
- Runtime 的 ToolRegistry/Policy 校验仍然必须保留。Schema 只是模型生成约束，不能替代 Parser、工具
  存在性、参数合法性、坐标新鲜度和副作用 Policy。

静态门验收：测试断言两种 Provider 的函数名集合、字段级 `required`/description、Viewport 边界、未知工具
拒绝和坐标映射；通过后再运行 Experiment C，避免把 Schema 改动误归因于坐标表示。

## 4. 并行和合并顺序

- PR A、PR B 与 P0-4 Schema 改造可以在独立工作树并行，二者业务文件基本独立；
- Experiment C 的静态 fixture/runner 可并行准备，但正式真实 API 对照应基于 PR A 合入后的 Runtime；
- 推荐合并顺序：PR A → PR B → P0-4 Schema → Qwen 坐标对照结论对应的 PR（若需要）；
- 每个 PR 都先跑定向测试，再跑全仓 `pnpm test` 与 `pnpm run typecheck`；PR A 合入后再跑 Stage 4
  runner contract test。

## 5. 恢复正式评测的门槛

同时满足以下条件后，才能重跑 3 个冻结任务 × 2 个模型：

1. PR A 的失败路径测试通过，EventStream 不再产生悬空 ToolCall；
2. PR B 的两轮 fixture 证明 reasoning 被产生、持久传递并实际消费；
3. P0-4 的 per-tool Schema 静态门通过，未知函数和不完整参数在 Provider 边界被拒绝；
4. Qwen paired comparison 已冻结正式坐标默认，而不是同时保留两个生产默认；
5. 全仓测试、类型检查和 Stage 4 runner contract test 通过；
6. 正式 Run 使用新输出目录，不覆盖旧轨迹。

评测后再根据证据决定 P1 顺序。当前不要用单个 bad case 给 Prompt 加补丁，也不要把 Provider 成功率和
`runtimeOutcome` 混成同一个指标。

## 6. 文档精简后的一个明确取舍

`docs/history/` 目前被忽略，历史内容仍可从 Git 历史和本地目录追溯，但新的干净 clone 无法直接浏览这些
文件。这不阻断 P0；如果团队确实需要在当前 checkout 中浏览历史，后续只补一个受控的历史索引或发布
归档，不应把全部旧计划重新放回活动文档。

## 7. 操作边界

本轮修改了 Runtime 的模型侧工具描述、Qwen/GLM Provider 的 Function Schema 与边界映射，并补充了
Provider/Runtime 定向测试；另用脱敏合成图片完成了真实 GLM/Qwen API conformance（无 CUA、无桌面操作）。
P0-4 的实现仍应在独立 PR 中提交，不覆盖其他 Agent 的工作树。

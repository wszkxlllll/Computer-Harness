# 真实 API 协议验证报告（2026-09-15）

日期：2026-09-15
文档角色：结果 / 证据
状态：当前证据
当前入口：[Stage 6 收敛与下一阶段起始状态](./stage-6-convergence-and-start-state-2026-09-15.md)
基线：当前仓库工作树
范围：GLM/Qwen 无桌面 API 协议流转与历史失败样本；不覆盖真实 CUA、OSWorld VM 或正式效果评测

补充说明：本报告保留 G1–G3 受控 API conformance 的详细证据

当前状态（2026-09-15 源码复审后）：Qwen `strict_json` 已统一为固定 `calls[]` 协议，`anyOf` 双路径及其实验开关已删除。下文 4.2–4.4 保留迁移前的对照证据；其中“继续保留实验开关”的阶段性建议已被本次源码复审结论取代。

迁移后的完整回归和统一集成验收见：[qwen-flat-regression-and-integration-acceptance-2026-09-15.md](./qwen-flat-regression-and-integration-acceptance-2026-09-15.md)。

本轮只验证 Provider、ToolRegistry、Context、RunController、Planning 和 Run Memory 的真实协议流转。使用 64×64 合成图片和 Fake Computer；没有启动 CUA、OSWorld、VM，也没有执行真实 GUI 动作。API key 只从本地 `.env` 读取，报告和运行产物不保存密钥。

## 1. 执行入口

构建前置：`pnpm typecheck` 通过。

Planning smoke：

```text
node scripts/stage5-planning-api-smoke.mjs --model glm-5.3-flash --env-file <env-file> --output <output>
node scripts/stage5-planning-api-smoke.mjs --model qwen3.8-flash --env-file <env-file> --output <output>
```

Memory 闭环与多调用验证：

```text
node scripts/real-memory-api-conformance.mjs --model all --mode all --env-file <env-file> --output <output>
node scripts/real-memory-api-conformance.mjs --model all --mode multi --env-file <env-file> --output <output>
```

实现入口：[real-memory-api-conformance.mjs](../scripts/real-memory-api-conformance.mjs) 和 [real-batch-api-conformance.mjs](../scripts/real-batch-api-conformance.mjs)。它们使用正式 ToolRegistry、DefaultContextCompiler 和 RunController，不是测试专用的伪工具。

## 2. 迁移前结果摘要

本节记录统一 flat 协议落地前的受控 API 证据。表内 Qwen 的 `kind=tool_call/tool_calls` 是历史 wire format，不能作为当前请求实现示例；当前格式只使用固定 `calls[]`。

| 验证项 | GLM-5.3-Flash | Qwen3.8-Flash | 结论 |
|---|---:|---:|---|
| Planning：create → update → terminate | 通过，18 events | 通过，18 events | 两 Provider 能消费统一 Planning schema |
| Fact Memory：write → get → needs_check → terminate | 通过，22 events | 通过，22 events | 写入、召回、纠正状态和事件链闭合 |
| Entity Memory：create → entity fact → get → invalidate → terminate | 通过，27 events | 通过，31 events | 实体 ID 传递、关联 Fact、失效均可用 |
| 同一 ModelTurn 返回两个独立 Memory calls | 通过；首轮两个 `memory_write_fact` | 复测通过；首轮 `kind=tool_calls` 两个调用 | Composite 的状态写入部分已得到真实 Provider 证据 |

主要产物目录：

```text
runs/api-conformance/real-glm-planning-20260915
runs/api-conformance/real-qwen-planning-20260915
runs/api-conformance/real-memory-20260915
runs/api-conformance/real-memory-multi-qwen-r2-20260915
```

## 3. 关键观察

1. GLM 的多调用使用原生 `tool_calls` 数组；Qwen strict JSON 使用 `{"kind":"tool_calls","calls":[...]}`，两者最终都被 Provider Adapter 归一为同一个 `ModelTurn.tool_calls`。
2. Qwen Entity 首次曾返回不存在的 `relatedTaskIds`。Runtime 正确拒绝该调用，模型随后去掉该字段并完成任务。这证明权限/合同校验有效，但也说明 Provider 提示词仍需减少“凭空创建 Task ID”的倾向。
3. Qwen 多调用首次实验中，首轮两个写入已经成功提交；后续模型曾返回缺少 `kind` 的响应，重试又复用了已用过的 `call_1`，因此该次 Run 失败。独立复测成功。该现象不是 Memory 数据损坏，而是模型续轮格式和 ToolCall ID 复用的可靠性问题，需作为 P1 稳定性样本保留。
4. 本轮只证明 Planning/Memory 工具协议可用，不证明它们改善真实桌面任务成功率。还没有真实 CUA/OSWorld Action Batch 证据，也没有完成 Development/Validation 消融。

## 4. 迁移前真实 Provider 的 Batch 探针

命令：

```text
node scripts/real-batch-api-conformance.mjs --model all --env-file <env-file> --output <output>
```

结果：

| Provider | 首轮 ModelTurn | Runtime 执行 | 后续 |
|---|---|---|---|
| GLM-5.3-Flash | `click` + `type` 两个 native `tool_calls` | 两个 primitive 均 completed；各自有 started/completed event | 第二轮 terminate，Run succeeded |
| Qwen3.8-Flash | strict JSON `kind:"tool_calls"`，calls 数组含 `click` + `type` | 两个 primitive 均 completed；各自有 started/completed event | 第二轮 strict `kind:"tool_call"` terminate，Run succeeded |

两者都产生 3 次 observation（初始、click 后、type 后），证明 Runtime 的 Batch 只合并模型请求，不跳过逐 primitive 观察和 Receipt。坐标示例中 Qwen 线上的 `500,500` normalized 坐标被 Adapter 转成约 `319.5,179.5` 的物理像素；GLM 本次直接返回物理坐标 `320,180`。

这仍是 Fake Computer 的真实 Provider 探针：尚未证明 CUA daemon 和 OSWorld bridge 在真实后端上可以安全执行同一批次。真实后端的下一门槛仍是分别运行同一编辑 fixture，验证动作后观察、失败后缀停止、Abort 和未知副作用。

随后已完成双 Adapter 受控 fixture：`scripts/batch-backend-fixture.mjs` 分别接入 CUA fake daemon seam 和 OSWorld fake bridge seam，使用同一个 Runtime/同一组 `click→type` ToolCalls。两条路线均 `succeeded`，均产生 2 个 `action.execution.started`、2 个 terminal Receipt 和 3 次 Observation；CUA 记录了 `click → get_desktop_state → type_text → get_desktop_state`，OSWorld 记录了 `execute(click) → execute(type)`，并消费每次动作后的 `postActionCapture`。证据目录：`runs/api-conformance/batch-backend-fixture-20260915-r2`。

这一步放行的是 Adapter 合同和 Runtime 调度，不是实际 Windows CUA daemon 或 OSWorld VM 的成功率。真实后端仍需在单独授权下跑无敏感文本框 fixture，并测试中途失败、Abort、采图失败和未知副作用。

## 4.1 Composite ModelTurn：Plan/Memory 前缀 + GUI Batch

本次进一步使用正式 Registry 的五个启用工具：`task_create`、`memory_write_fact`、`click`、`type`、`terminate`，要求第一轮一次性返回：

```text
task_create → memory_write_fact → click → type
```

结果：

- GLM-5.3-Flash：完整通过；PlanState 创建 `t1`，Run Memory 写入 `m1`，随后两个 GUI primitive 均完成，第二轮 terminate 成功。
- Qwen3.8-Flash：第一轮 strict 响应先因缺少 `kind` 被拒绝；重试后返回四个调用，Plan、Memory、click、type 全部提交并执行。但后续终止轮又返回非法 strict 内容，Run 最终失败。

因此可以确认 **Qwen strict 已经能够在同一 ModelTurn 表达并执行“Plan/Memory 状态写入 + GUI Batch”**；但不能宣称完整 Run 的续轮稳定性已经通过。完整请求体保存在本地 ignored 产物 `runs/api-conformance/real-composite-20260915-r2/`，不随仓库发布。

## 4.2 `anyOf` 与固定 `calls[]` 对照实验

为验证“去掉 discriminated `anyOf`，统一固定 envelope”的建议，新增了实验性 `strictSchemaMode: "flat_calls"`，默认模式仍为 `"any_of"`。两组都只启用 `task_create`、`memory_write_fact`、`click`、`type`、`terminate`，使用同一 Composite 目标和同一合成屏幕。

| 指标 | 当前 `any_of` | 实验 `flat_calls` |
|---|---:|---:|
| Run outcome | succeeded | succeeded |
| Provider requests | 3 | 3 |
| 首轮结果 | 缺少 `kind`，重试后合法 | 返回 `[]`，重试后合法 |
| Composite 首轮 | 4 calls，Plan/Memory + click/type | 4 calls，Plan/Memory + click/type |
| 终止轮 | 1 个 terminate | 1 个 terminate |
| prompt tokens（3 请求） | 2495 / 2560 / 3007 | 871 / 938 / 1365 |
| 完整响应 tokens | 2688 / 2802 / 3089 | 1097 / 1193 / 1407 |
| 延迟 ms | 12525 / 13030 / 2328 | 3053 / 3827 / 3290 |

固定 envelope 在这次对照中把请求 schema 从约 22 KB 降到约 5 KB，并显著降低 prompt tokens 与首轮延迟；但两组都各发生一次首轮格式重试，因此不能据一次实验宣称 strict 已完全稳定。`flat_calls` 如果没有额外 system 指令，模型会添加 Runtime 不接受的额外参数或继续输出旧的 `kind` 结构；当前实验性 Adapter 已增加明确的 flat envelope 指令，才得到上表的成功结果。

完整单体请求体保存在本地 ignored 的 `runs/api-conformance/` 对照产物中，不随仓库发布。

阶段性建议（已由 4.4 后的源码复审取代）：当时先保留 `flat_calls` 实验开关，等待续轮协议泄露与 Control 边界修复。

### 4.2.1 修正后的公平对照

上面的初始对照仍有一个变量差异：`any_of` 依靠 schema 分支携带工具语义，而 `flat_calls` 依靠额外提示。现已加入可选的 `strictToolCatalog`，由同一个 `ModelInput.tools` 自动生成紧凑 Tool Catalog，并同时注入两组 system prompt；两组只差 `response_format`。

修正后结果：

| 条件 | 结果 | 观察 |
|---|---|---|
| `any_of` + 同一 Tool Catalog（重复 2 次） | 2 次均失败 | 首轮常返回 JSON 数组而不是对象；一次重试收到 Qwen HTTP 400，提示 JSON generation abnormal；没有执行 GUI 动作 |
| `flat_calls` + 同一 Tool Catalog（1 次） | 成功 | 2 请求完成 Plan/Memory + click/type + terminate，无重试；2 个动作、3 次 Observation |

本次 `flat_calls` 请求的 prompt tokens 为 1071、1586；`any_of` 首轮约 2695，且仍未进入执行。样本量还不足以给出最终统计结论，但它说明：在保留相同 Tool Catalog 后，`anyOf` 的复杂 response schema 仍可能与 Qwen strict generation 发生冲突，而固定 `calls[]` 更容易稳定生成。

该对照完成了 wire schema 选择，不再作为当前待办。后续稳定性实验只使用统一 `calls[]`，不再继续维护双协议。

公平对照的完整请求体保存在本地 ignored 的 `runs/api-conformance/fair-*/` 产物中，不随仓库发布。

### 4.2.2 Envelope instruction 控制实验

为进一步排除提示词差异，已给两组都加入各自明确但等价的 envelope instruction：`any_of` 明确说明单调用/多调用对象格式，`flat_calls` 明确说明固定 `calls[]` 格式；Tool Catalog、目标、Provider 参数和 Fake Computer 完全相同，各重复 3 次。

| 方案 | 成功次数 | 每次请求数 | 总 prompt tokens（每次） | 总延迟 ms（每次） |
|---|---:|---|---|---|
| `any_of` + Catalog + explicit instruction | 3/3 | 3、2、2 | 8858、6017、6043 | 12947、16347、7677 |
| `flat_calls` + Catalog + explicit instruction | 3/3 | 2、3、3 | 2718、3815、3804 | 5437、13888、12273 |

这个控制实验修正了原先“flat 额外拥有 envelope instruction”的偏差：在双方都有明确协议提示后，两种方案都能完成 Composite ModelTurn 和 terminate。`flat_calls` 的稳定性优势尚不能成立，但 token/schema 优势仍然明显：本组每次总 prompt tokens 约为 `2.7k–3.8k`，而 `any_of` 为 `6.0k–8.9k`。

因此当前结论应分成两条：

- **已支持**：固定 `calls[]` 能显著缩小 Provider wire schema，并在等价 envelope instruction 下保持功能可用。
- **尚未支持**：不能再说 Qwen 的格式失败主要由 `anyOf` 单独造成；此前失败至少部分来自协议提示词不对称和模型对 schema 的随机偏离。

后续仍需扩大到至少 10 次/方案，并分层测试单调用、Control、Plan/Memory off、参数错误、长历史和不同工具数量。

## 4.3 flat_calls 返回方式矩阵（Qwen，重复 3 次）

已使用 [qwen-flat-return-matrix.mjs](../scripts/qwen-flat-return-matrix.mjs) 对不同 ModelTurn 返回形态做了 3 次重复。所有实验均使用 `flat_calls + strictToolCatalog`、Fake Computer 和同一 Runtime。

| 场景 | 成功率 | 平均 prompt tokens | 说明 |
|---|---:|---:|---|
| 单 `terminate` | 3/3 | 621 | 单调用 Control |
| 单 `click` | 3/3 | 1914 | click 后 terminate |
| 单 `type` | 3/3 | 1616 | type 后 terminate |
| `click→type` Batch | 3/3 | 2004 | 两个 GUI primitive 同轮 |
| Plan + Memory 多调用 | 2/3 | 1909 | 失败样本为 Control 混入同轮或格式重试后重复 ID |
| Plan + Memory + Batch Composite | 3/3 | 2442 | 四调用前缀/后缀 + terminate |
| Memory 写入→读取→terminate | 1/3 | 2765 | 续轮偶发空 envelope，重试复用旧 ToolCall ID |
| Planning 创建→更新→terminate | 2/3 | 3462 | 续轮格式错误/重复 ID |

这组结果说明：flat_calls 对单调用、GUI Batch 和 Composite 已经很稳定；主要失败集中在需要多轮读取结果、更新状态或严格控制 Control 混入的场景。它们暴露的是两个独立问题：

1. 模型有时把 `terminate` 与状态写入放在同一个 calls 数组，Runtime 正确拒绝；
2. Provider retry 使用相同 ToolCall ID 时，Runtime 会正确阻止重复执行，但当前 Run 会失败。

该矩阵随后通过历史投影和 Control 边界修复得到定向复测，详见 4.4。重复 ToolCall ID 仍由 Runtime fail-closed，不做静默改写。

## 4.4 flat outbound-history invariant 复核

源码审计确认原 flat 模式确实存在一个协议泄露：历史 assistant tool call 曾被序列化为 `{"kind":"tool_call",...}`，与当前 flat `calls[]` 协议混杂。现已修复：strict 历史统一投影为 `{"calls":[...]}`，并删除 legacy `any_of` 历史路线。新增回归断言确保 outbound messages 不含 legacy `kind` tool-call serialization。

同时增加了 Control 边界审计：只要 `terminate` 出现在当前 ToolRegistry 投影中，Provider system prompt 必须明确说明 `terminate` 是该轮唯一调用，不能与 Computer、Planning、Memory 或其他调用混用；对应单测已覆盖。

针对失败场景的定向复测结果：

| 场景 | 修复前 | history 投影修复后 |
|---|---:|---:|
| Memory 写入→读取→terminate | 1/3 | 3/3 |
| Planning 创建→更新→terminate | 2/3 | 3/3 |
| Plan + Memory state-only | 2/3 | 2/3 |

这验证了 `memory_read` / `planning_update` 的主要问题确实包含 Harness 历史协议泄露，而不是单纯模型随机漂移。`state_multi` 剩余失败仍是模型把 terminate 混入状态写入轮，或格式 retry 后复用旧 ID；需要单独处理 Control 边界和 retry feedback。

补加 `terminate` 唯一调用审计后，`state_multi` 定向复测为 3/3；这说明把 Control 边界写成明确的 Provider 协议提示确实有效，但仍需在更大样本上确认。

## 5. Qwen strict JSON 当前请求与响应格式

当前请求是 OpenAI-compatible `POST /compatible-mode/v1/chat/completions`。ToolRegistry 会被投影为紧凑 Tool Catalog；`response_format` 只约束固定 wire envelope 和当前已注册工具名，精确参数仍由 Runtime 校验。请求体核心字段为：

```json
{
  "model": "qwen3.8-flash",
  "messages": [
    { "role": "system", "content": "...GUI Harness system prompt..." },
    { "role": "user", "content": [{ "type": "text", "text": "..." }] },
    { "role": "user", "content": [{ "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }] }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "qwen_model_turn",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "calls": {
            "type": "array",
            "minItems": 1,
            "maxItems": 5,
            "items": {
              "type": "object",
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "name": { "type": "string", "enum": ["当前 ToolRegistry 中的工具名"] },
                "arguments": { "type": "object", "additionalProperties": true }
              },
              "required": ["id", "name", "arguments"],
              "additionalProperties": false
            }
          }
        },
        "required": ["calls"],
        "additionalProperties": false
      }
    }
  },
  "stream": false,
  "temperature": 0,
  "vl_high_resolution_images": true,
  "reasoning_effort": "low",
  "preserve_thinking": true
}
```

无论单调用还是多调用都使用同一结构。Batch 示例：

```json
{
  "calls": [
    { "id": "call_1", "name": "click", "arguments": { "x": 500, "y": 500 } },
    { "id": "call_2", "name": "type", "arguments": { "text": "batch-ok" } }
  ]
}
```

单调用和终止响应分别是：

```json
{ "calls": [{ "id": "call_3", "name": "terminate", "arguments": { "status": "success", "text": "..." } }] }
```

strict 模式的历史工具调用不会放在原生 `tool_calls` 字段，而是作为 assistant 的 JSON 文本；工具结果作为后续 user 文本 `Tool result for <callId>: {...}`。脱敏后的完整请求样例在 `runs/api-conformance/real-batch-20260915/qwen3.8-flash/request-1-shape.json` 和 `request-2-shape.json`。

## 6. Qwen strict 错误格式

Provider 解析错误统一为 `QwenProviderError`：

```text
name: "QwenProviderError"
code: "QWEN_INVALID_RESPONSE" | "QWEN_DUPLICATE_TOOL_CALL" | ...
retryable: boolean
retryMode: "feedback" | "same_input"
message: string
```

已在真实运行中观察到的错误：

```json
{
  "type": "model.request.failed",
  "category": "provider",
  "code": "QWEN_INVALID_RESPONSE",
  "message": "Qwen strict JSON response requires a non-empty calls array; no tool was executed; retrying model request 1/1",
  "retryable": true,
  "retryMode": "feedback"
}
```

该次重试随后复用了已用过的 `call_1`，Runtime 产生独立的：

```json
{
  "type": "runtime.error",
  "category": "runtime",
  "message": "duplicate ToolCall id: call_1"
}
```

其他 strict 解析保护包括：native `tool_calls` 出现在 strict 模式、内容不是 JSON、缺少或空 `calls[]`、调用字段非法、重复 ID、未注册工具，以及 Control 与其他调用混合。网络或超时则分别使用 `QWEN_NETWORK_ERROR`、`QWEN_REQUEST_TIMEOUT` 或 `QWEN_HTTP_<status>`，不能与模型格式错误混为一类。

## 7. 当前处置

本报告用于保留迁移过程和历史失败样本，不再充当阶段放行入口。统一 flat 源码与最新真实 API/双后端集成结论以
[Qwen flat 回归与统一集成验收](./qwen-flat-regression-and-integration-acceptance-2026-09-15.md) 为准；正式效果实验的唯一门槛和顺序以
[Stage 6 收敛入口](./stage-6-convergence-and-start-state-2026-09-15.md) 为准。

当前仍须把 Qwen 格式偏离、重复 ToolCall ID 和 retry 计入正式实验结果；在 G0 evaluator 校准、预算和 manifest 冻结前，不启动 20+20 Development/Validation 消融。

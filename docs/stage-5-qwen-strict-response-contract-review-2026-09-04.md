# Stage 5：Qwen strict response 请求合同复审

日期：2026-09-04

状态：**当前 strict-json 已完成一次官方任务，但请求 Schema 仍需收紧；目标是保证只有严格合法的响应能够执行，
不能承诺远端模型每次都产生合法响应。**

## 结论

需要修改当前请求格式。现有 `response_format=json_schema + strict:true` 的外层调用方式正确，但
`qwen_model_turn` 内层 Schema 把三类决策、九种 name 和所有 arguments 合并成一个大对象，导致结构约束与业务语义脱节。

已有 no-execute 证据中，服务端在相同 strict Schema 下两次返回根数组 `[]`、一次返回合法对象。因此即使继续优化
Schema，也不能把 `strict:true` 当成信任边界。系统能实现的严格保证是：

```text
Provider response
        ↓
JSON parse + 分支 Schema 校验 + canonical Tool 校验
        ├─ 全部通过 → 生成程序侧 ToolCallId → ModelTurn → Runtime
        └─ 任一失败 → 不执行动作，记录 Provider 协议错误
```

也就是保证“被执行的响应严格合法”，而不是保证“远端永不返回非法内容”。

## 当前 Schema 的问题

### 1. `kind` 与 `name` 是两套重复决策

当前允许 `{"kind":"finish","name":"click","arguments":{}}`。它符合现有根 Schema，却在语义上矛盾。
`terminate/interact` 与 `finish/user_input_required` 也重复表达控制状态。

### 2. `arguments.required=[]` 没有动作级严格性

当前 click 可以合法返回 `{"kind":"tool_call","id":"x","name":"click","arguments":{}}`。strict 只能保证
x/y 如果出现则是 number，不能保证 click 必须同时提供 x/y。type、keypress、scroll、drag、wait 也有同样问题。

### 3. `id` 不应由模型生成

ToolCallId 的消费者是 ToolResult、RuntimeEvent 和历史关联。它不需要开放语言判断，应在 Adapter 接受合法动作后由程序的
ID factory 生成。让模型生成只会增加重复、空值和跨轮冲突风险。

### 4. finish 与用户询问缺少自己的字段

- finish 应明确生产 `status + summary`；
- user input 应明确生产 `question`；
- GUI type 才消费 `text`。

三者不应靠 `kind/name` 的组合猜测同一个 `arguments.text` 字段含义。

### 5. strict 模式的 System Prompt 仍在描述 native tools

strict-json 请求没有发送 `tools`，模型实际应“输出一个符合 response schema 的 decision object”，而不是“use available
tools”。坐标单位也应直接说明为当前截图上的 0..1000 归一化数值。这里是协议说明，不是针对某个 bad case 的 Prompt
补丁。

## 推荐的单响应合同

Qwen 私有 wire object 直接使用动作/控制类型作为 `kind`，删除 `id`、`name` 和通用 `arguments`：

```text
click                 → kind, x, y
type                  → kind, text
keypress / hotkey     → kind, keys
scroll                → kind, x, y, direction, ticks
drag                  → kind, fromX, fromY, toX, toY
wait                  → kind, durationMs
finish                → kind, status, summary
user_input_required   → kind, question
```

概念 Schema 应是精确分支联合，而不是一个包含全部可选字段的对象：

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "kind": { "type": "string", "enum": ["click"] },
        "x": { "type": "number", "minimum": 0, "maximum": 1000 },
        "y": { "type": "number", "minimum": 0, "maximum": 1000 }
      },
      "required": ["kind", "x", "y"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": { "type": "string", "enum": ["type"] },
        "text": { "type": "string" }
      },
      "required": ["kind", "text"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": { "type": "string", "enum": ["finish"] },
        "status": { "type": "string", "enum": ["success", "failure"] },
        "summary": { "type": "string" }
      },
      "required": ["kind", "status", "summary"],
      "additionalProperties": false
    }
  ]
}
```

正式生成时应加入当前 V1 实际支持的其余动作分支；这里只展示三类形状，不是让实施者只实现三个动作。每个分支必须来自
当前 ToolRegistry 的真实工具，且 Adapter 有对应消费者。不要为尚未实现的工具预留字段。

Adapter 映射：

- GUI kind → 生成 ToolCallId → canonical `ModelTurn.type="tool_calls"`；
- finish → canonical `ModelTurn.type="finish"`；
- user_input_required → canonical 同名分支；
- 坐标继续复用现有 normalized→Observation viewport 逻辑；
- Runtime、ActionIntent、Computer Adapter 和 OSWorld 不变。

## 能否让 Response 绝对严格

不能仅靠一次模型请求实现数学意义上的绝对保证。本次已经观察到 `strict:true` 下返回 `[]`，所以必须保留客户端校验和
fail-closed。

可以达到的工程保证：

1. 服务端 strict JSON Schema 作为第一层生成约束；
2. Adapter 对根类型和 exact branch 再校验；
3. ToolRegistry 对 canonical arguments 再校验；
4. Observation/viewport/Policy 在 Runtime 执行动作前校验；
5. 非法响应不生成 ActionIntent、不写 `action.execution.started`、不触发 Computer；
6. 可做一次无副作用的有界重试；同类错误再次出现就终止，不连续消耗三次相同请求。

这不是重复防御：Provider 是外部信任边界，而 GUI 动作可能产生真实副作用。

## 实验门

### S1：联合 Schema 能力探针

先不启动 VM，使用保存的非敏感截图：

1. 用最小 click/type/finish 三分支 `anyOf` 请求一次；
2. API 400 表示服务端不支持该联合关键字或形状；
3. HTTP 200 但返回根数组/不匹配分支，表示 strict 仍未实际执行；
4. 通过后补齐 V1 全部分支，再运行 3 次完整工具空间 no-execute 探针。

### S2：放行真实任务

只有 3/3 都满足以下条件，才运行一次 OSWorld：根为 object、恰好匹配一个分支、必需字段和类型正确、没有额外字段、
Adapter 能映射为 canonical ModelTurn，并且探针没有调用 Computer。

### S3：联合 Schema 不支持时

不要退回当前 `required=[]` 大对象并称其为 strict。按顺序选择：

1. Qwen 私有 point-tuple native Function Calling；
2. 若特别重视格式而可接受延迟，再评估“两次调用：先选动作、再用该动作的精确 strict Schema 生成参数”；
3. 最后用 Qwen3.8-Max 做模型能力对照。

两阶段调用能让第二次 Schema 非常严格，但会近似增加一次模型调用延迟和成本，不应在没有单调用失败证据前成为默认。

## GLM 边界

GLM-5.3-Flash 当前 native Function Calling 已在同一任务完成 6 个动作、0 invalid ToolCall、官方 score=1。公开文档只确认
`response_format=json_object`，没有确认与 Qwen 等价的 server-enforced `json_schema/strict:true`。因此本次不修改 GLM
请求；如需研究，只做独立无副作用能力探针。

## 实施边界

应修改：Qwen strict-json 私有 Schema、System Prompt、Parser、程序 ID 生成和定向测试。

不应修改：公共 Protocol、ToolRegistry 的 canonical Schema、Runtime ActionIntent、Computer Adapter、OSWorld Bridge、
task/evaluator/snapshot。

合同复审阶段只完成了指导；随后追加的探究实验不修改业务代码、不启动 VM，且所有请求均为 no-execute。

## 2026-09-04 探究实验结果

随后进行了隔离的 no-execute API 探针，使用同一非敏感合成截图、同一任务、
`qwen3.8-flash`、`temperature=0`、关闭 thinking；所有请求均没有调用 Computer、CUA 或 VM。
实验脚本保存在本地 `scripts/history/experiments/`，运行证据保存在 `runs/`，均不属于生产代码。

| Schema / 协议 | 试验次数 | 合法根对象 | 观察 |
|---|---:|---:|---|
| 当前扁平 Envelope | 3 | 1/3 | 其余两次 HTTP 200 但 `content` 为根数组 `[]` |
| 直接动作分支 `anyOf`（click/type/finish） | 6 | 5/6 | 两批结果分别为 2/3、3/3，说明有改善但仍有波动 |
| 直接动作分支 `oneOf`（click/type/finish） | 3 | 3/3 | 服务端接受该关键字，最小分支探针通过 |
| 完整九分支 `anyOf` | 6 | 4/6 | 包含全部 GUI 与控制分支后仍出现 `[]` |
| 完整九分支 `oneOf` | 3 | 1/3 | 复杂联合分支没有稳定改善 |
| 仅单个 `click` 分支 | 3 | 1/3 | 即使 Schema 最简单仍出现 `[]`，证明问题不只是 Schema 规模 |
| 七个 GUI 动作分支 `anyOf` | 3 | 2/3 | 控制分支不是唯一原因 |
| 当前独立 Function Calling（native_tools） | 3 | 2/3 | 两次正常，一次返回无法解析的 `click.x` |

证据目录：

- `runs/qwen-strict-contract-probe-20260904/summary.json`
- `runs/qwen-strict-contract-probe-20260904-r2/summary.json`
- `runs/qwen-strict-contract-probe-20260904-r3/summary.json`
- `runs/qwen-native-tools-probe-20260904-r1/summary.json`
- `runs/qwen-native-tools-probe-20260904-r2/summary.json`
- `runs/qwen-native-tools-probe-20260904-r3/summary.json`

### 实验判断

1. `anyOf`/`oneOf` 直接动作分支确实能提高部分探针的合法对象比例，并且服务端没有因联合关键字返回 HTTP 400。
2. 但即使只有一个 `click` 分支，也会在 HTTP 200 下返回 `[]`；因此不能把 `strict:true` 视为远端绝对约束，也不能据此宣称正式 Provider 已修复。
3. 当前 native Function Calling 的 2/3 结果与完整联合 Schema 的 4/6 结果处于同一量级，暂时没有证据证明某条路径稳定优于另一条。
4. 所有非法响应都在客户端 fail-closed，没有生成 `ActionIntent`，没有写入 `action.execution.started`，没有真实副作用。

### 下一步结论

暂不把直接分支联合 Schema 合入生产 Adapter，也不据此进入 OSWorld 批量任务。保留当前 `strict_json` 和
`native_tools` 作为可切换实验路径；正式改造前还需要固定同一批次、同一请求协议做更大样本的重复实验，或验证
Qwen3.8-Max/其他兼容端点是否能消除 `[]`。无论采用哪条路径，客户端根类型、分支、字段、ToolRegistry 和坐标校验
仍必须全部保留。

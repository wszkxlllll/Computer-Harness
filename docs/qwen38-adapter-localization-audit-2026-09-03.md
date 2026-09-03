# Qwen3.8 Adapter 与定位实验审计

日期：2026-09-03  
文档角色：审计  
状态：Qwen3.8 三题工程门通过；删除 GUI-Plus 仍受 P1-4 阻塞  
当前入口：[Stage 4-A：Windows 本地任务验证](./stage-4-local-task-implementation.md)  
基线：工作树 `fd67faf` 之上的未提交 Qwen3.8 实现与 2026-09-03 本地证据  
范围：Qwen3.8 Provider Adapter、API conformance、无 CUA 坐标校准及进入真实桌面前的门槛；不涉及业务任务或 GUI-Plus 删除

## 1. 结论与放行范围

当前结论是**Qwen3.8 normalized 已通过无 CUA 定位门，alpha/beta/gamma 三题 attended 工程门均通过；仍不能删除
GUI-Plus，直到 P1-4 的 plain-text finish 语义收紧并通过回归测试**。

首次校准中，`normalized_1000` 的两条可解析响应经 Adapter 换算后几乎落在目标中心；第三条失败是模型返回了非法 JSON。
审计还发现校准 fixture 曾传入不完整的 click schema，导致一次重跑的三个 raw arguments 都是字符串数组，不能作为模型结论。
修正 canonical schema 后的唯一确认实验中，三个 normalized 响应均可解析、在范围内且命中目标。
`actual_pixels` 则明确不稳定：一条准确、一条落在目标外、一条超出 viewport，但最后一条没有保留原始参数，尚不能判断
模型究竟输出了归一化数值、错误像素，还是其他格式。

首次校准暴露的实现问题已处理；仍需保留的后续问题是：

1. 三个同构任务已通过，但样本量仍不足以代表通用 GUI 成功率；
2. plain assistant text 的终止语义（P1-4）仍未收紧，正式验收前必须避免把普通文本当作成功完成；
3. 图像 resize 与 viewport 同步、全部 thinking 档位配置和 Provider 原始证据已实现并通过本轮回归。

上述证据和核心坐标问题已修复，并已完成一次修正后的 normalized 校准；不应根据这 3 个样本给 Prompt 添加位置特例。
后续若重新运行桌面任务，仍必须显式使用 `normalized_1000`、`reasoning_effort=low`、冻结任务与外部 evaluator，并保持用户独占桌面。

## 2. 本次独立验证

### 2.1 实际执行

- 阅读 [Qwen Provider Adapter](../packages/provider-qwen/src/index.ts)、[Provider 单测](../packages/provider-qwen/src/index.test.ts)、
  [坐标校准脚本](../scripts/experiments/qwen38-coordinate-calibration.ts)、CLI 与 Stage 4 runner 的相关差异；
- 读取 non-thinking/low conformance 与 6 个坐标校准结果；
- 原始尺寸查看 3 张 640×360 合成图片，确认目标框与 manifest 坐标一致、没有裁剪；
- 独立执行 `pnpm exec vitest run packages/provider-qwen/src/index.test.ts`：20/20 通过；
- 独立执行 `pnpm test`：112/112 通过；
- 独立执行 `pnpm run typecheck`：通过；
- 独立执行 `pnpm --dir spikes/cua-driver run test:stage4-runner`：通过；
- 独立执行 `pnpm --dir spikes/cua-driver run test:stage4-runner-lifecycle`：10/10 通过；
- 读取实施 Agent 修复后生成的 `normalized_1000` 确认证据：R2 为 3/3 `overallPassed`，且标注为无 CUA、无桌面副作用；
- 复跑 attended alpha，并在 alpha 通过后按同配置完成 beta/gamma；三个 Run 均有独立 `provider-exchanges.jsonl`。

实施 Agent 本轮报告调用了修正后的三条 normalized 校准请求；随后按固定配置完成了 alpha、beta、gamma 三个 attended Run。
第一次因不完整 schema 产生的 R1 记录保留为实现缺陷证据，不纳入模型定位结论。

### 2.2 已有 API 证据

- `runs/api-conformance/qwen38-disabled-20260903-r1/summary.json`：non-thinking 两轮 HTTP 200，ToolCall ID 往返成功；
- `runs/api-conformance/qwen38-low-20260903-r1/summary.json`：low thinking 两轮 HTTP 200，第二轮完整带回长度 166 的
  `reasoning_content`；
- `runs/stage4-local/qwen38-coordinate-calibration-20260903-r1/summary.json`：6 个请求均 HTTP 200，actual 记为 1/3，
  normalized 记为 2/3。
- `runs/stage4-local/qwen38-normalized-confirm-20260903-r2/summary.json`：修正 schema 后的唯一有效 normalized 确认实验；
  3/3 `apiSucceeded`、`toolCallParsed`、`coordinateInRange`、`localizationHit` 和 `overallPassed`，并保留每条 raw
  ToolCall 的 `id/name/arguments`、响应 model、finish reason、延迟和 usage。

## 3. 定位链路核对

当前链路为：

```text
640×360 PNG + Observation viewport 640×360
        ↓ identity image preprocessor
Qwen3.8 image_url + per-tool JSON Schema
        ↓ native message.tool_calls
raw x/y
        ↓ Qwen38FlashAdapter
normalized: x * (640 - 1) / 1000, y * (360 - 1) / 1000
actual: 原值
        ↓ canonical ToolCall / ActionIntent
Runtime viewport validation → CUA
```

本次校准使用 identity preprocessor，且图片像素与 viewport 一致，所以当前失败不能归因于 Harness 截图裁剪、CUA、DPI
或本地桌面坐标。`vl_high_resolution_images=true` 也已随请求发送。

### 3.1 normalized 两个有效样本

| fixture | 目标中心（物理像素） | 可反推的模型原始 0..1000 坐标 | Adapter 输出 | 结论 |
|---|---:|---:|---:|---|
| left-top | (114, 90) | (178, 249) | (113.92, 89.64) | 几乎正中 |
| right-bottom | (526, 280) | (821, 775) | (525.44, 279) | 几乎正中 |

这两条表明 `mapQwen38Arguments()` 在普通非边界坐标上的 normalized 换算正确。center 样本报
`Unexpected token . in JSON at position 16`，由于原始 `function.arguments` 未落盘，只能判定为语法/协议失败，不能判成
视觉定位失败。

### 3.2 actual 样本

- center 输出 `(319,179)`，接近目标中心 `(320,177)`；
- left-top 输出 `(178,149)`，落在目标框外；
- right-bottom 在 Adapter 中触发 `QWEN_COORDINATE_OUT_OF_RANGE`。

这组表现说明模型没有稳定遵循 actual-pixel schema。一个合理但尚未证实的解释是，模型在部分样本中仍沿用了视觉模型常见的
1000-grid 坐标习惯。Qwen3.8 API 文档本身没有规定 Computer Use 坐标制；Qwen3-VL 官方维护者曾明确说明该模型的
Computer Use 使用 1000×1000 相对坐标，但这只能作为相关模型的旁证，不能直接当成 Qwen3.8-Flash 合同。Qwen3.8
开源版本目前也有“grounding 坐标偶尔超过 1000”的公开问题，和本次越界现象方向一致，但服务端模型与开源版本不完全等价。

- [Qwen3.8-Flash 官方模型说明](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)
- [Qwen3-VL Computer Use 坐标说明](https://github.com/QwenLM/Qwen3-VL/issues/1521)
- [Qwen3.8-Flash-Next 坐标超过 1000 的公开问题](https://github.com/QwenLM/Qwen3.8-Flash-Next/issues/4)

### 3.3 修正后的 normalized 确认样本

修正校准 fixture 的 canonical click schema 后，只运行一组新的 normalized 实验。三条 raw arguments 分别为
`{"x":178,"y":250}`、`{"x":500,"y":491}` 和 `{"x":821,"y":775}`；Adapter 输出的物理坐标均落入对应目标框。
三条记录的 `apiSucceeded`、`toolCallParsed`、`coordinateInRange`、`localizationHit` 和 `overallPassed` 全部为 3/3。
这证明当前 normalized 映射和证据链可用，但只证明合成单击定位，不等价于真实桌面任务成功率。

## 4. 问题分级

### P0：已修复并验证

#### P0-1 失败响应缺少可诊断的原始 ToolCall

原问题是校准脚本内的 `RecordingHttpClient` 只保存 HTTP 状态、request keys、工具名、finish reason 和 usage；Adapter
抛错时结果只剩错误码和消息，导致：

- 无法知道 right-bottom actual 的原始 x/y；
- 无法知道 center normalized 的具体非法 JSON；
- 无法区分模型忽略坐标单位、服务端序列化错误和 Adapter 解析错误。

修复后：每个响应在进入 Adapter 解析前保存脱敏的 `response.model`、每个 ToolCall 的 `id/name/raw arguments`、finish
reason、延迟和 usage；即使 Adapter 抛错也会落盘，不保存 API Key、图片 Base64 或 thinking 原文。

#### P0-2 校准指标混合了三类失败

修复后汇总输出相互独立的字段，非法 JSON、越界和定位未命中不再混合：

- `apiSucceeded`：HTTP/API 是否成功；
- `toolCallParsed`：ToolCall 是否为合法 JSON 且符合基本 Schema；
- `coordinateInRange`：坐标是否属于声明空间；
- `localizationHit`：转换为物理坐标后是否落入目标框；
- `overallPassed`：以上全部成立。

只有 `toolCallParsed && coordinateInRange` 的样本才能进入定位准确率分母；工程可用率仍以 `overallPassed` 计算。

#### P0-3 Qwen3.8 的坐标模式在通过门槛前不应隐式默认

真实 CLI/Stage 4 入口现要求 Qwen3.8 显式提供 `--qwen-coordinate-mode`；校准和 conformance 也显式传入。Adapter 的默认值
仅保留给直接单元测试和非桌面调用，不能绕过生产入口门槛。

### P1：不阻塞诊断复跑，但阻塞最终验收或扩大工具集

#### P1-1 normalized 边界换算不闭合（已修复）

旧实现使用：

```text
x * viewport.width / 1000
y * viewport.height / 1000
```

修复后统一为：

```text
decode: normalized * (size - 1) / 1000
encode: physical * 1000 / (size - 1)
```

`size=1` 时正反转换均固定为 0，不能执行除零。补充 0、1000、右下角和 1×1 viewport 的针对性单测。当前两个
normalized 成功样本不在边界，因此这不是它们的误差来源。

#### P1-2 Qwen3.8 重建工具 Schema 时丢失 canonical 语义（已修复）

旧实现对已知 Computer Tools 重新手写 schema，导致：

- `type.text`、scroll 字段和 key 字段的详细 description 丢失；
- `keypress.keys.maxItems=1` 丢失；
- Provider 展示给模型的合同与 Runtime 最终校验合同存在漂移。

修复后复用 `tool.inputSchema`，只对坐标字段追加单位、minimum/maximum；若坐标工具 schema 不完整才使用最小 fallback。
`terminate/interact` 仍作为 Provider 控制工具单独定义。canonical required、description 和数组约束已有单测覆盖。

#### P1-3 图像预处理后的 viewport 同步（已修复）

`QwenPreparedImage` 现在必须返回 bytes、mediaType 和实际呈现给模型的 pixel viewport。Adapter 同时维护 source viewport
（Harness Observation/Computer Action）和 presented viewport（模型实际看到的图像）。normalized 坐标映射回 source；
actual-pixel 坐标先在 presented 范围校验，再映射回 source；历史 ToolCall 执行反向变换。无效 prepared viewport 会被拒绝。
默认 identity 行为不变，400×300 presented image 到 800×600 source observation 的右下角映射已有定向测试。

#### P1-4 plain assistant text 会被当作成功结束

Qwen3.8 已显式提供 `terminate`，但 `parseResponse()` 在没有 ToolCall、只有文本时仍生成无 `reportedStatus` 的 finish；Runtime
会把它视为 `succeeded`。这不解释坐标校准失败，但可能在桌面实验中制造 false-positive finish。应在 Qwen3.8 profile 中要求
结束必须来自 `terminate`；普通文本若不属于已定义的用户交互语义，应作为 Provider 协议错误，而不是默认成功。由于本次
alpha 有独立 evaluator，若该路径出现会被记录为 false-positive 而不会污染外部任务成功率，因此不阻塞一次诊断 smoke；
但在三题正式门和 GUI-Plus 删除前必须修复并补测试。

### P2：不阻塞下一次诊断复跑

- non-thinking 响应若返回空 `reasoning_content`，Adapter 仍会创建长度 0 的 continuation；应忽略空字符串，减少无消费者状态；
- CLI/runner 已开放 Qwen3.8 支持的 `disabled | low | medium | xhigh`，默认仍为 `low`；实际档位写入 CLI summary 和
  runner 结果。档位是显式实验变量，不能因一次参数解析失败直接换档；
- 校准输出目录当前允许覆盖同名文件。应要求目录不存在或为空，避免新旧证据混合；不需要为此增加哈希。

## 5. 下一步实施顺序

### 第一步：只修证据和确定性合同（已完成）

1. P0-1、P0-2、P0-3 已完成；
2. P1-1 已完成，并补足 normalized 0/1000 边界测试；
3. P1-2 已完成，并通过 canonical schema 保真测试；
4. Provider 定向测试、typecheck、runner contract 和校准 `--plan-only` 均通过。

### 第二步：一次 normalized 确认实验（已完成）

按用户授权只重跑了一组相同的 3 个 normalized fixtures，保持：

- `enable_thinking=false`、`preserve_thinking=false`；
- 相同图片、Prompt、tool set、temperature 和高分辨率设置；
- 不运行 actual，不调整单个 fixture Prompt，不自动修复非法 JSON。

判定规则：

- 3/3 `overallPassed`：选定 normalized，进入 attended alpha；
- 定位命中 3/3 但存在解析失败：定位能力通过，Provider 工程门不通过，先处理 Function Calling 稳定性；
- 出现新的合法但未命中坐标：定位仍不稳定，停止桌面实验，保留 GLM 为唯一主模型；
- 再次出现越界：结合已保存 raw arguments 判断是坐标单位漂移还是随机定位错误，不做 clamp 或 fixture 特例。

确认命令只传 `--coordinate-mode normalized_1000`，输出中的 `apiSucceeded`、`toolCallParsed`、
`coordinateInRange`、`localizationHit` 和 `overallPassed` 分开统计，并保留脱敏的 raw ToolCall arguments。

结果为以上五项均 3/3，满足进入 attended smoke 的定位门槛。

### 第三步：桌面门（三题工程门已完成）

normalized 确认通过后，先用 `reasoning_effort=low` 运行 alpha；只有失败明确属于规划/状态追踪，才按入口文档允许一次
medium 对照。坐标、Prompt、工具 Schema 与 thinking 不能同时改变。三题达到既定门槛后，才执行 GUI-Plus 删除清单。

本轮使用固定的 `normalized_1000 + reasoning_effort=low` 完成三个 attended Run：

- alpha：`runs/stage4-local/qwen38-20260903-r2/text-replace-alpha/runner.json`，4 steps、5 requests、31,597 tokens；
- beta：`runs/stage4-local/qwen38-20260903-r2/text-replace-beta/runner.json`，4 steps、5 requests、32,032 tokens；
- gamma：`runs/stage4-local/qwen38-20260903-r2/text-replace-gamma/runner.json`，4 steps、5 requests、31,810 tokens。

三题均由外部 evaluator 判定成功，Runtime 均为 `succeeded`，15 次请求合计 95,439 tokens；每个 Run 都生成了本地
`provider-exchanges.jsonl`，无 Provider/Parser/Trajectory/cleanup error。daemon 均正常退出，只有已知的
`foreign_process_termination_denied` cleanup warning。

这证明 Qwen3.8 在当前冻结 ProbeWindow 任务上通过工程门，但不等价于通用 GUI 成功率。此前 alpha 失败的 R1 记录仍保留为
历史 Provider schema/解析问题，不与本批次成功率混算。

### 独立复审放行条件

本次曾只放行以下一个动作：运行冻结的 `text-replace-alpha` attended smoke。配置必须为：

- `--model qwen3.8-flash`；
- `--qwen-coordinate-mode normalized_1000`；
- Provider 固定 `reasoning_effort=low`、`preserve_thinking=true`；
- 使用新的空输出目录、独立 daemon/socket/fixture 和现有外部 evaluator；
- 不同时修改 Prompt、Context、Tool Schema、任务、预算或坐标换算；
- 记录 `runtimeOutcome`、外部 evaluator、每轮 ToolCall、continuation、动作/观察事件、清理结果和任何 false-positive finish。

alpha、beta、gamma 均已通过，当前三题工程门放行；后续若进入删除 GUI-Plus 的变更，仍必须先关闭 P1-4，并保留这些 Run
及其 `provider-exchanges.jsonl` 作为脱敏证据。不得因为本批次成功就直接修改 Prompt 或添加坐标特例。

## 6. 验收条件

- 定向测试和 typecheck 通过；
- 失败响应即使被 Adapter 拒绝，也能从脱敏证据还原原始 ToolCall 参数；
- normalized 的 0 和 1000 均映射到合法 viewport 边界，正反转换一致；
- 模型看到的已知 Computer Tool Schema 保留 canonical required、description 和数组约束；
- Qwen3.8 真实桌面入口没有隐式坐标默认；
- 修正后的 normalized 校准结果分别报告 API、解析、范围、定位和 overall 指标。
- attended alpha 仍由外部 evaluator 决定任务成功，不能用模型自报或 Runtime `succeeded` 代替。
- Qwen Run 的 summary 必须记录 thinkingMode，并通过 `providerExchanges` 指向本地脱敏 Provider 交换文件。
- 三题 attended 工程门必须由外部 evaluator 和 Runtime 同时成功，且无 Provider/Parser/Trajectory/cleanup error；本轮已满足。

## 7. GUI-Plus 基线保留与删除计划复审

### 7.1 结论

用户提出的五步顺序**可以执行，但需按以下修正版实施**。Qwen3.8 已在固定
`normalized_1000 + low` 下完成 alpha/beta/gamma 3/3，因此关闭 plain-text finish 后，只需一条 alpha 验证该窄改动，
不需要再次消费额度重跑 beta/gamma。GUI-Plus 删除后仍需一条 post-delete alpha，确认共享 Provider/CLI 装配未被误删。

### 7.2 先保存的必须是 commit，不是脏工作树指针

当前 `main` 仍指向 `fd67faf`，工作树存在 27 项修改/未跟踪内容，且尚无保存当前状态的 tag。Git branch 和 tag 都只指向
commit，不能保存未提交修改。因此不能直接在当前 HEAD 上打“当前状态”标签，否则标签实际不包含 Qwen3.8 Adapter、
最新 runner、实验脚本和文档。

正确顺序：

1. 审查 staged 文件，只纳入当前实现所需的源码、测试、manifest、实验脚本和当前文档；
2. 排除 `.env`、`runs/`、隐私截图以及 `.stage4-qwen38-fixture-alpha/` 等临时构建目录；
3. 在专门分支形成一个明确的 **pre-GUI-Plus-removal baseline commit**；
4. 如需不可移动标记，再在该 commit 上创建 annotated tag；branch 用于继续追溯/修补，tag 用于冻结准确提交；
5. ignored 的历史 Run 继续本地保留，当前文档保存脱敏摘要和路径。Git tag 保存可复现代码，不会自动打包 ignored 证据。

提交前仍需按仓库规则核对 repository-local author/committer 身份；本审计不代替实际提交或远程归属验证。

### 7.3 plain-text finish 修复边界

只修改 `Qwen38FlashAdapter.parseResponse()` 的无 ToolCall 分支：

- 显式 `terminate({status,text})` 继续映射成带 `reportedStatus` 的 finish；
- 显式 `interact({text})` 继续映射成 `user_input_required`；
- ToolCall 同时带有普通 content 时，content 仍可作为 assistantText 保留；
- `finish_reason=stop` 且只有普通文本时，不得生成隐式成功 finish，应返回稳定的 Provider 协议错误；
- 空响应和 `finish_reason=tool_calls` 却没有 calls 仍保持原有错误。

新增测试至少覆盖：plain text 拒绝、terminate success/failure、interact、ToolCall+assistantText、空响应。不要修改 Runtime
的通用 finish 语义，也不要改变 GUI-Plus 历史 Adapter；问题属于 Qwen3.8 已声明控制工具后的 Provider 合同。

### 7.4 修正后的执行顺序

1. **冻结基线**：形成包含 GUI-Plus、Qwen3.8、当前复现脚本和文档的 baseline commit；可再加 annotated tag。
2. **单独修终止语义**：只改 Qwen3.8 无 ToolCall 文本分支及对应测试，形成独立 commit。
3. **修复后验证**：运行 Qwen Provider 定向测试、全量测试、typecheck、runner contract/lifecycle；随后只跑一条固定配置
   Qwen3.8 alpha。Runtime 与外部 evaluator 必须一致成功，最后仍为显式 `terminate(success)`，无 Provider/Parser/
   Trajectory/cleanup error。
4. **单独删除 GUI-Plus**：删除活动 Adapter、model union、CLI/runner 参数、manifest 候选、conformance 候选、专用单测、
   `qwen-wire-paired` 和其他 GUI-Plus 活动探针；保留 provider-qwen 包、Qwen3.8 与共享 HTTP/图片/坐标/诊断代码。历史结果
   和文档事实不删除，只移除活动入口。
5. **删除后验证**：全量测试、typecheck、runner contract/lifecycle 全部通过；再执行一次 Qwen3.8 low alpha。它验证的是
   删除没有误伤共享 Adapter/CLI/runner 真实装配，不替代此前三题结果。通过后才能宣布 GUI-Plus 已安全退出活动代码。

### 7.5 删除时的审查清单

- 搜索 `gui-plus-2026-02-26`、`QwenGuiPlusAdapter`、GUI-Plus 私有 `coordinate/coordinate2/pixels/time` 映射，区分活动代码
  和历史叙述；
- 不删除 Qwen3.8 正在消费的 `QwenHttpClient`、endpoint/auth、image preprocessing、normalized 坐标、continuation 和
  `provider-exchanges.jsonl` 记录；
- 测试总数会因删除 GUI-Plus 专用测试而减少，验收依据是所有剩余测试通过，而不是继续等于删除前的 112；
- 删除 commit 保持单一目的，不夹带 Prompt、Context、Runtime 或任务修改，便于回滚和比较。

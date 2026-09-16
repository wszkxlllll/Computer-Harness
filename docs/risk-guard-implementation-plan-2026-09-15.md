# Risk Guard 模块实施计划

日期：2026-09-15
文档角色：入口 / 交接
状态：工程实现及首轮无桌面真实 Provider API 已完成；真实桌面安全效果待验证
当前入口：[Stage 6 收敛与下一阶段起始状态](./stage-6-convergence-and-start-state-2026-09-15.md)
基线：源码核对基于 `cf59133`；实施前记录实际 HEAD 和已有修改
范围：可插拔动作效果声明、分层 Guard、Approval、双 Provider 合同验证；不启动正式评测

## 1. 本轮决策与实施范围

主模型已经看到截图并在生成动作，因此要求它在同一次响应中附带“当前动作预期产生什么效果”。Runtime 对本轮声明、动作参数和明确宿主规则进行本地分流：

- 声明或已有证据表明涉及财产、隐私、安全设置、破坏性修改、外部承诺：直接审批，无额外模型调用。
- 声明为普通导航或局部编辑，且没有本轮矛盾/敏感信号：按低风险策略放行。
- 命中明确宿主禁令：直接拒绝。
- 当前动作效果未知、声明矛盾或疑似高危但证据不足：至多一次独立语义评估；仍不明确则审批。

**Goal 是意图与授权背景，不能因出现“购买”而检查整段购买流程。OCR、Accessibility、控件身份和应用适配器均不是本轮输入或前置条件。**

主模型的声明只是自报信息，不能证明点击目标正确或实际无害。本轮目标是形成低延迟、可衡量漏报与误拦截的安全辅助机制；不能把它宣传为隐私/财产安全保证。已知高危的强制审批规则不得被主模型或复核模型降级。

本轮先完成协议探针和 mock，再集成主循环。模型真实协议测试通过之前，不开始真实桌面安全效果实验。

## 2. 当前源码与需要调整的位置

本次独立检查的是源码，没有重跑类型检查、API 或桌面实验。

| 当前位置 | 已有实现 | 本轮改造 |
|---|---|---|
| `packages/protocol/src/index.ts` | ToolCall、ModelTurn、ActionIntent、RuntimeEvent | 增加 ToolCall 上可选的类型化效果声明；Guard 事件 |
| `packages/runtime/src/contracts.ts` | ToolRegistry/ModelInput、ToolCall 级 Policy | 增加声明模式、共享投影合同、action-level policy |
| `packages/runtime/src/run-controller.ts` | 参数/预算校验、逐动作执行、pendingApproval | 准备候选组、Guard、保留批准的动作、恢复校验 |
| `packages/provider-glm/src/index.ts` | 原生 tool_calls，解析后映射坐标 | 共享声明 schema 投影、分离元数据、历史重新编码 |
| `packages/provider-qwen/src/index.ts` | strict 固定 calls[]、Tool Catalog、native_tools | 保持 flat envelope，适配声明参数及跨轮历史 |
| `packages/context/src/index.ts` | 统一 ToolRegistry 投影、raw/recent Context | 开启时注入简短声明说明，工具预算包含声明成本 |
| `packages/trajectory/src/index.ts` | Zod schema、纯 Reducer、Approval | 声明/Event 读写兼容、Guard 统计、恢复验证 |
| `apps/cli/src/index.ts` | 组装模型/工具、waiting_user、Ctrl+C | Guard 开关、waiting_approval 交互、指标 |
| `packages/risk-guard/`（新增） | 尚不存在 | Router、Mandatory Policy、语义评估器、最小评估 Context |

当前两种 Computer backend 都没有向 Runtime 提供 Accessibility 数据；ObservationFrame 只有截图和 viewport。Provider 的普通文本/思考内容也不能当作已经可靠解析的动作效果。

现有 Approval 已有 allow/deny/require_approval、事件和 resolveApproval；CLI 目前没有处理 waiting_approval。批准后重新从 ToolCall 生成 Action 的路径也需要改造。

## 3. 协议：效果声明属于本轮的每个 Computer 调用

### 3.1 公共类型

推荐协议草案（待双 Provider 探针验证）：

```ts
type DeclaredActionEffect =
  | "observe"
  | "navigate"
  | "local_edit"
  | "destructive"
  | "financial"
  | "external_commitment"
  | "sensitive_disclosure"
  | "security_change"
  | "unknown";

interface ActionEffectDeclaration {
  effects: DeclaredActionEffect[];
  target: string;
  summary: string;
}

interface ToolCall {
  id: ToolCallId;
  name: string;
  arguments: JsonValue;
  declaredEffect?: ActionEffectDeclaration;
}
```

- effects 非空、去重；上限为枚举数量。允许一个动作同时为 financial 和 external_commitment，不能单选丢失风险。
- observe/navigate/local_edit 是对本轮预期效果的描述；永久删除和覆盖已有重要文件必须报 destructive，不能因发生在本机而报 local_edit。
- target/summary 各设短长度上限，例如 120/240 字符；不得包含密码、验证码、完整账号、私人正文或链式思考。
- 不加入模型自报的 riskScore、approved、safe=true 或可信度数字。
- 属性在公共协议上可选，兼容旧轨迹和 Guard off；Guard on 的 Computer 调用由 Runtime 强制要求。Planning/Memory/Control 不要求此字段。
- ToolCall 已有 id；Runtime 将声明与该调用、生成的 ActionId 和当轮 Observation 绑定，模型不再提供 observationId。
- Batch 每个 Computer call 都有声明；不能用整个 Turn 的一个标签覆盖 click/type 等多项。
- 声明是计划效果，ActionReceipt 是执行事实；不把声明写成已完成结果或自动转存 Memory。

### 3.2 GLM/Qwen 共用的 wire 表达

不向 GLM 原生 API 臆造顶层字段；不改变 Qwen 已验证的 `{calls:[{id,name,arguments}]}` 外形。推荐在 Computer 工具的模型可见参数中保留专用键 `_harnessEffect`：

```json
{
  "calls": [
    {
      "id": "c17",
      "name": "click",
      "arguments": {
        "x": 820,
        "y": 690,
        "_harnessEffect": {
          "effects": ["financial", "external_commitment"],
          "target": "确认付款按钮",
          "summary": "提交当前订单付款"
        }
      }
    }
  ]
}
```

上例只说明 Qwen wire 形状，坐标含义继续服从选定 Provider 的坐标模式。GLM 同样把 _harnessEffect 放在原生 function.arguments 内，不改 API 的 tool_calls 外壳。

共享投影/解码流程：

```text
ToolRegistry 的原始工具合同
   → 开启声明时，仅装饰 Computer 的模型可见 schema
   → GLM tools / Qwen Tool Catalog 与 response_format
   → 同一响应：动作参数 + _harnessEffect
   → 共享 decoder 分离并校验 _harnessEffect
   → ToolCall.arguments（纯动作参数） + ToolCall.declaredEffect
   → 原参数校验、原坐标映射
   → Runtime / Guard
```

实现共享纯函数放在 runtime 的 Provider 合同支持文件，例如 `action-effect-projection.ts`。risk-guard 包消费规范声明；Provider 包只处理表示转换，不执行风险规则。

必须做到：

1. 装饰后的 schema 含准确类型、required、additionalProperties 和效果语义；不修改 ToolRegistry 的执行参数合同。
2. Qwen flat 的 arguments 仍保持现有宽松对象；具体字段说明由统一生成的 Catalog 提供，不重新引入 anyOf。
3. GLM/Qwen 共用同一声明 schema 和分离逻辑，不能各维护一份效果枚举。
4. 坐标映射只处理原坐标字段，不修改 target/summary；Computer 永远收不到 _harnessEffect。
5. 历史 ToolCall 重投影到 Provider 时，把 declaredEffect 编回原 wire 位置；Context 的裁剪继续保持 ToolCall/ToolResult 闭合。
6. Guard off 不增加声明 schema、说明或必填校验；旧 API conformance 与旧 JSONL 可读。
7. 主模型不调用额外的“报告风险工具”，不额外占用 ToolCall 数量、Action budget 或 Batch slot。
8. 语义复核器的分类工具不属于 Computer，因此不能再被装饰，避免递归要求声明。

## 4. Context 与用户意图

开关在 Run 启动时确定：建议 `RunFeatureConfig.riskGuard?: "off" | "layered"`，缺省 off。CLI、Context、Provider projection 和 Runtime 必须消费同一个配置；不要设置相互独立的“声明开”和“Guard 开”造成漏接。

Guard on 时的主模型说明只要求：

- 对当前每个 Computer 调用报告预期即时效果和目标；
- 搜索、浏览、选规格报告 navigate；点击最终付款报告 financial；
- 输入草稿报告 local_edit；发送草稿报告 external_commitment；
- 不确定时报告 unknown；不要猜“已批准”或“安全”；
- 报告当前动作，不把整个 Goal 的最终目的贴到所有中间动作；
- 高危声明会交给宿主处理，主模型不得自行绕过审批。

Goal 和 user.input.received 是授权背景。Plan/Memory 是模型维护的辅助状态，只能帮助理解当前动作，不能授权付款、解除限制或改变强制审批类别。

不把自然语言否定词正则转换成可靠的权限合同。例如“不要删除提示中的文字”不能机械产生 forbid(delete)。明确宿主配置的禁令可本地执行；需要理解自然语言冲突时，在本轮已有疑似高危信号的条件下调用语义评估器。禁止只凭 Goal 中出现“支付”触发每次点击复核。

原始 Goal 与后续用户输入从已有 Event/Controller 状态取得，不新建长期约束 Store。截断上下文时，不能将缺少更早约束理解为授权；复核输入放不下相关指令时转审批并说明信息不全。

## 5. Router 的具体规则

Router 是纯函数，输入为本轮 canonical candidate、对应 declaredEffect、原始动作参数、已有用户指令和宿主策略。没有 OCR、界面定位器或“已识别当前应用”的隐式依赖。

按以下优先级执行：

| 本轮条件 | 路径 | 额外模型调用 |
|---|---|---|
| 违反明确宿主禁令，例如禁用某快捷键 | deny | 0 |
| 任一声明为财产/外发/破坏性/安全设置效果 | require_approval | 0 |
| 动作参数命中宿主已配置的敏感值保护规则 | require_approval | 0 |
| 声明 observe/navigate/local_edit，target/summary 与参数扫描均无升级信号 | allow，注明“基于声明放行” | 0 |
| unknown、动作与声明明显矛盾、疑似未申报高危操作 | semantic_review | ≤1/候选组 |
| 高危歧义且复核关闭、预算耗尽或调用失败 | require_approval | 0 或已失败的一次 |

### 5.1 扫描对象和执行顺序（必须实施）

上一版只说明声明矛盾与敏感参数检查；本节明确 target/summary 也必须参与本地扫描。先读 effects 不等于看到 navigate 就立即放行。

1. 先执行原有 Tool/参数及声明结构校验；非法声明按格式错误拒绝。
2. 检查明确宿主禁令，再读取 effects 枚举。禁令直接 deny；包含任一强制审批类别直接 require_approval。这些路径不需要额外模型，也不必继续做用于放行判断的文本扫描。
3. 对剩余候选，分别扫描 target、summary，并检查实际动作参数（如 type.text、keypress.keys）。三个来源不能简单拼成一段文字：target/summary 是模型声明，type.text 是准备输入的内容，引用危险词不一定表示要执行危险操作。
4. 汇总本轮信号：强敏感保护规则命中直接审批；unknown、声明/动作矛盾或疑似高危含义进入 semantic_review；只有低风险声明且扫描无升级信号才本地放行。
5. 扫描只能提高关注级别，不能把已申报 financial 等高危类别降级为安全；组级策略聚合所有 Computer 调用，禁止只检查 Batch 第一项。

| 字段 | 检查方式 | 规则命中的意义 |
|---|---|---|
| effects | 类型化枚举匹配，不做关键词识别 | 高危类别直接审批；unknown 保留不确定性 |
| target / summary | 本地风险词、短语和有限上下文规则 | 识别未申报高危含义或矛盾，通常触发复核；不把文字当真实控件证据 |
| type.text | 受保护值匹配、有限敏感格式规则 | 强规则审批，弱规则疑似信号；不记录原始匹配秘密 |
| keypress.keys 等原动作参数 | 规范化动作形状、宿主禁令、与 effects 的一致性 | 明确禁令拒绝；可疑矛盾复核 |

首版采用枚举 + 小规模可审计规则集，不引入 BERT 或另一份本地模型部署。关键词负责召回，单个“支付/删除/发送”命中不能直接证明高危。规则实现为独立纯函数，输出 ruleId、字段来源与信号类别；Router 消费并将命中规则 ID 写入 Guard Event 供审计。不保存匹配到的敏感原文，不为规则单独增加 Store。后续有独立标注集后，可在相同信号接口比较文本分类器的漏检、误报和延迟。

必须包含的示例：

- navigate + “查看支付记录”：能被明确的查看语境规则解释时放行，不因“支付”单词直接审批；规则解释不了则进入歧义分支。
- navigate + “确认付款，支付当前订单”：发现声明矛盾，进入语义复核；主模型已报 financial 时直接审批。
- local_edit + type.text 为讨论“不要发送邮件”的普通文字：不能因正文出现“发送”认定外部提交。
- local_edit + type.text 命中用户配置的受保护秘密：直接审批。
- navigate + 实际点击坐标落在付款按钮，但 target/summary 也写“查看详情”：文本扫描可能无法发现，必须计入视觉误报/漏报测试，不能宣称规则可以解决。

扫描范围限定为当前动作的结构化字段；不扫描整个 Goal/Plan/Memory 来触发全程审批，不扫描主模型思考链。普通回复审查和截图/Context 上传 Provider 的隐私保护属于其他数据边界，本轮动作 Guard 不自动覆盖。

### 5.2 执行细则

- 声明 navigate 的 click 可以本地放行；这不证明按钮安全，漏报必须独立评测。
- type 自报 observe、Shift+Delete 自报 navigate 等明显矛盾不得直接放行。
- 普通键、Enter、点击都不能脱离声明和本轮信号按关键词认定效果；Enter 可能换行也可能发送。
- 敏感内容探测只针对当前输入，不能将任意长数字、邮箱地址都确认为秘密。强规则可直接审批，弱匹配只作为高危歧义信号。默认规则和误报样本须列明。
- 缺失或结构非法声明：在副作用前拒绝整个 Turn，返回具体格式错误，由主循环下一轮纠正；不得按低危放行或为格式错误调用独立模型。重试受现有 Run 请求预算约束。
- 同组任意高危项触发审批边界；非 GUI 的 Plan/Memory 前缀不能覆盖该项。
- 不缓存“这个坐标是安全的”，不把一次批准扩大到后续同坐标调用。

示例：Goal 始终为“选好商品并购买”，搜索、翻页、选规格各报告 navigate，零额外风险请求；最终付款报告 financial，直接审批。Goal 不变不影响按动作分流。

## 6. 独立语义评估与策略裁决

新增 `packages/risk-guard`，依赖 runtime 合同；Runtime 通过注入的 ActionPolicy 调用，不能反向依赖 risk-guard。复用现有 ProviderAdapter 与 AssetReader，具体 Provider 在 CLI 组装。

评估器只在 semantic_review 路径使用：输入当前截图、canonical actions、主模型声明（明确标为不可信）、Goal/相关纠正、有限 Plan/Memory；不复制完整运行历史，不执行工具，不维护跨轮聊天。

模型返回一个 `risk_classification` 调用：

```ts
interface SemanticRiskAssessment {
  effects: DeclaredActionEffect[];
  alignment: "aligned" | "conflicts" | "unclear";
  evidence: string; // 简短依据，不要私密原文或推理链
}
```

由固定策略表处理：

- 任何高危 effect → 审批；不能因为 aligned 就放行。
- 仅低风险 effects 且 aligned → 可放行，记录依据来自模型分类。
- conflicts → 停止当前候选；明确宿主违规可 deny，只有模型推断的自然语言冲突采用审批/用户澄清，避免把概率判断伪装成确定事实。
- unknown、unclear、模型格式错误、超时 → 审批。
- 已命中本地高危/禁令的候选本就不调用模型；模型无法降低这些约束。

每候选组最多一次复核；独立 timeout 和请求上限，超时不叠加多层重试。取消合并 Run AbortSignal，晚到结果不得执行动作。只传输必要截图和动作信息；Provider 已接收数据不等于可自由二次传播敏感内容，复核服务应由用户配置，默认不开独立远程复核。

## 7. Runtime / Batch / Approval 工程改造

### 7.1 候选准备与执行分离

提取无 Driver 副作用的 prepare 路径，生成与 ToolCall 一一对应的 canonical Action；toAction 必须纯转换。Guard on 在任何 Plan/Memory 写入和 GUI 动作前预检整个候选组。

保留原始 decision Observation；逐 primitive 执行时使用当时最新 execution Observation 再做确定性校验、预算和取消检查。候选预检不能提前把所有 executionObservationId 固定为第一帧。ActionId 保持稳定，ActionIntent 不混入声明字段。

Guard off 保持现有调度/拒绝顺序，用回归验证，避免为 Guard 改动已有基线事件语义。

### 7.2 事件与数据生命周期

- ToolCall.declaredEffect：主 Provider 生产，Runtime/Guard 消费；随 model.response.received、tool.call.received 持久化。下一轮不自动复用，不写入 Memory。
- canonical Action：Runtime 生产，Guard/Computer 消费；与 callId、原始 Observation 关联。
- `action.guard.evaluated`：保存 callIds、候选 Action、最终 decision、reasonCode、path（local/model/fallback）、短原因、policyVersion；真实复核时附 requestCount、latency、usage。
- path=model/fallback 的计数必须区分“预算耗尽未请求”和“超时请求已发出”；不要从 fallback 字样推算请求次数。
- Guard 事件更新 protocol union/type list、Trajectory Zod/纯 Reducer、summary/分析消费。记录决策前不得执行 action；落盘失败停止。
- local allow 计数与“安全事实”分开，报告明确称为声明驱动放行。
- 新增统计可从事件派生；只将在线预算确实需要的计数放 RunSnapshot。原始效果声明保留在已有 ToolCall，不重复建 Store。
- Guard 延迟期间收到纠正/暂停/Abort：执行前处理 inbox，旧候选失效；恢复时重新观察并让主模型提出新候选。
- 崩溃恢复不自动重放待审批或未知副作用动作；沿用当前 outcome_unknown 规则。

### 7.3 Approval 与多调用边界

单个 Computer 调用需审批时，pendingApproval 保存原调用、声明、canonical Action、session、原始 Observation 引用和 Guard 决策引用。用户看到的是动作目标、预期后果和声明来源，不仅是坐标。

批准仅适用于这一候选，不重新 toAction 生成其他动作，不调用第二次风险模型。批准后仍检查 session、预算、取消和内部失效。

含多个调用的组需审批/拒绝时，整组不执行，返回要求将敏感动作单独提出的 ToolResult。首版不扩大现有 Approval 为整组授权。受限 Batch 形状维持现状，不加 Enter/导航/提交；每步继续独立 Receipt、观察、失败截断。

外部桌面可能在审批等待期间变化，保存 ActionId 不等于保存了点击对象。当前实现只检查 Harness 内的 latestObservationId 没有被新观察替代；它能阻止内部状态已推进后执行旧候选，却无法发现用户、动画或其他进程在同一 ObservationId 期间改变桌面。没有元素身份或经过验证的视觉变化检测前，仅放行 mock 审批验收，不能宣称真实桌面高危审批已可安全使用。不要使用截图 ID 判断内容变化；每次观察的 ID 本来就不同。也不使用原始文件哈希作为默认门槛，因为光标闪烁、动画和编码差异会导致大量误拒绝。

## 8. CLI 和依赖注入

建议参数（计划，尚不存在）：

```text
--risk-guard <off|layered>
--risk-model <off|same|glm-5.3-flash|qwen3.8-flash>
--risk-max-model-requests <n>
--risk-timeout-ms <n>
```

默认 Guard off；layered 默认独立 risk-model off，高危歧义直接审批。same 表示复用模型/鉴权配置，复核 ModelInput 独立，不共享 continuation/历史。主声明增加的 tokens 与独立复核 tokens 分开统计。

CLI --interactive 支持 waiting_approval 的 approve/reject、requestId、防重复提交及 Ctrl+C；非交互模式明确拒绝并结束/返回模型处理，遵守现有有限预算，不能无限等待或自动批准。用户纠正不能充当批准，模型文本不能调用 resolveApproval。

模块依赖：protocol 存声明/事件；runtime 存策略合同及公共 wire 投影；context 消费声明开关；provider-glm/qwen 调共享投影；risk-guard 实现分流/复核；CLI 组装。无需改 Computer Driver、OSWorld Bridge 或实际动作映射。

## 9. 开发顺序与验证门槛

### R0：基线盘点

记录 HEAD、修改范围和当前测试；读取现有入口。保护并行 G0 任务数据、manifest 和预算。先固定 Guard off 的 schema/Context/Event 快照。

### R1：声明协议与双 Provider 探针

实现共享 schema 装饰、分离、历史编码、类型与 Zod 兼容；增加可注入的 ModelInput 开关，不直接接真实 Driver。

必须验证 GLM native、Qwen strict 和已支持的 Qwen native：
单 Computer、纯 Plan/Memory、Plan+Memory+Batch、Control 单独返回、多轮历史、坐标映射。
检查声明在本轮和第二轮均保留，执行参数没有多余键，工具清单仍由 Registry 产生。
真实 API 探针使用 FakeComputer；用户授权后执行并保留完整脱敏 wire 样本。
协议不稳定先修投影/提示，不通过忽略缺失声明来通过测试。

### R2：本地 Router 与纯策略测试

表驱动验证高危直接审批、低风险零复核、明确禁令拒绝、unknown/矛盾分流。
必须包含同一个购买 Goal 的多个正常导航步骤，证明不会因为 Goal 关键词全程触发。
包含 type-local_edit 的敏感输入、混合高危 effects、伪造授权、Plan/Memory 企图解除禁令。
按第 5.1 节验证 target/summary 的扫描确实被消费：低风险 effects 不得绕过扫描；“查看支付记录”和“确认付款”必须分开；正文引用风险词不得当作动作；记录命中 ruleId 但不能泄露敏感匹配值。

### R3：Runtime/Approval 集成

Guard 事件在副作用前；缺声明/非法声明整组拒绝；高危组无状态前缀执行；
approved exact Action、拒绝、重复 requestId、晚到模型结果、用户纠正、Abort、预算、
Harness 内 Observation 被替代、落盘失败、unknown side effect、清理分别覆盖；外部桌面变化检测标为未实现。
CUA 与 OSWorld fake seam 都验收逐动作 observation，不能互相代替。

### R4：独立复核与 CLI

复用 ProviderAdapter；risk_classification 不注册为主工具，不要求自身声明。
验证复核 off、超时、次数耗尽、非法返回和取消；高危已知路径的复核次数恒为 0。
补 CLI waiting_approval 测试与通用示例，命令不使用作者机器路径。
运行 `pnpm typecheck`、`pnpm test`；真实 API 与桌面操作按已获授权的具体范围执行。

### R5：独立风险样本与交付

普通 OSWorld 成功率不能证明隐私/财产保护有效。使用脱敏/合成界面及 FakeComputer
设计：付款/隐私外发/删除/账号设置/发送；对应普通导航负例；误报安全标签、错误坐标、
缺失声明、截图中的指令注入、敏感数据漏报、Batch 隐藏高危步骤。
样本标签来自 fixture 预期或人工核对，不能由声明自己给自己评分。

比较三组：Guard off、声明+本地策略、声明+本地策略+按需复核。
单独统计声明正确率/漏报、危害动作最终放行率、低危误审批率、审批次数、
声明 token 开销、主请求延迟变化、独立复核次数/tokens/延迟、格式失败、
Batch 拆分、用户拒绝后的重复尝试。指标从统一 Event/Provider usage 取数。

完成标准：
- 规则和状态机测试全部通过，Guard off 与原基线一致；
- 已申报高危零自动执行；低风险 fixture 零独立复核；
- 同 Goal 中风险边界只影响相关候选；
- 双 Provider 声明/历史/混合调用有证据；
- 漏报被实测并如实报告，不以 mock 三态通过代替安全有效性；
- 若频繁缺声明、低危误拦截过多或静默高危漏报，暂不开放真实敏感操作，保留开关迭代。
协议失败回退 Guard off 只用于隔离实验，不能在正在保护用户的 Run 中静默降级。

## 10. 交付与实施 Agent 指令

实施产物写回本文件结果区，保持 Stage 6 / DOCS-INDEX 为统一入口。源码、测试、通用命令、
脱敏证据索引和未验证项分别列清；不上传桌面截图、敏感文本或密钥，不擅自 commit/push。

> 先读 AGENTS.md、DOCS-INDEX 和 Stage 6，再按本文件 R0→R5 开发。核心是同轮每个 Computer call 的效果声明，经 GLM/Qwen 共享 wire 投影进入 ToolCall 元数据；本地规则依据本轮声明分流，已申报高危直接审批，低风险直接放行，仅 unknown/矛盾/疑似高危才按需复核。Goal 不作为整段任务复核开关，不引入 OCR/Accessibility 前置。效果声明不是安全证明，必须测漏报。先完成双 Provider/FakeComputer 协议验证，再集成 Runtime/Approval；保留原工具参数、坐标合同和双后端执行链。按文档验证关闭兼容、跨轮历史、Batch、纠正/Abort、事件落盘和 CLI。交付审计后再决定正式风险效果实验；不修改 G0 分集，不自动跑 VM 批量评测。

## 11. 实施结果（2026-09-16）

### 已实现

- protocol 增加 `ActionEffectDeclaration`、`ToolCall.declaredEffect`、Risk 类别和 `action.guard.evaluated`；Trajectory schema/Reducer 可读写并统计 Guard 与独立复核请求。
- runtime 提供共享 `_harnessEffect` schema 装饰、wire 分离和历史重编码；Computer 只收到原始动作参数。
- Context 在 `riskGuard=layered` 时向每个 Computer schema 和 system instruction 注入逐调用效果声明；关闭时保持原工具合同。
- GLM native tool_calls、Qwen strict calls[] 与 Qwen native tools 共用相同声明类型；坐标映射后声明独立保留，历史回投影恢复 wire 字段。
- 新增 `packages/risk-guard`：本地 effects/target/summary/动作参数分流、敏感输入规则、Scripted Assessor、复用 ProviderAdapter 的按需语义分类、独立超时和预算、失败转审批。
- RunController 在 GUI 副作用前准备并校验候选组；高危单动作进入现有 Approval，混合/Batch 高危整组拒绝并要求单独提出；批准执行同一个 ActionId。
- Approval 保存 exact Action，并在执行前确认 Harness 的 latestObservationId 未被新观察替代。Guard 评估期间的用户纠正/暂停会使候选失效。
- CLI 增加 `--risk-guard`、`--risk-model`、复核预算/超时、interactive Approval、非交互拒绝和 summary 指标。
- Guard Event 对 type 只保存 `textLength`，不重复落盘输入正文；Provider 复核输入也只发送输入长度。效果声明若疑似包含凭据/长金融标识会被拒绝，复核 evidence 落盘前做有限脱敏。

### 独立验证

- `pnpm typecheck`：通过。
- `pnpm test`：14 个测试文件、179 项测试全部通过（含 TUI 脱敏渲染）。
- `pnpm --filter @computer-harness/cli start -- --help`：通过，Risk Guard 参数可见。
- 新增测试覆盖 schema 装饰/剥离、非法声明、GLM/Qwen 解析及历史回投影、本地低风险/高危/歧义路径、exact-action Approval、风险评估期间用户纠正、Composite Turn 副作用原子边界和 Guard-off 回归。

### 尚未验证及限制

- 首轮无桌面真实 API 已完成：Qwen 低风险/高风险/模糊复核一次通过；GLM 高风险声明首次超过 `target` 长度合同。探针补齐正式 Runtime 的一次格式反馈重试能力后，独立复测首请求通过，未实际消费重试。该结果仅证明协议可用，尚未形成足够样本估计漏报率与稳定性。
- 未操作真实 CUA 或 OSWorld VM。当前没有外部桌面变化或元素身份检测；Approval 等待期间若用户、动画或其他进程改变页面，Runtime 可能仍执行旧坐标。
- 主模型可把高危点击误报成 navigate/local_edit；本地文本扫描只能发现部分矛盾，无法看到坐标实际对应的控件。当前实现必须保持实验性开关，不应宣称已经保证隐私或财产安全。
- 完整 Trajectory 既有的 `model.response.received`、`tool.call.received` 和允许执行后的 `action.proposed` 仍可能包含 `type.text`。本轮只避免 Guard Event/复核摘要额外复制敏感正文；轨迹加密、保留期和字段级脱敏属于后续数据存储策略。
- 自然语言 Goal/Plan/Memory 不被正则转换为长期权限合同；明确宿主禁令目前只支持注入 forbidden shortcuts。更完整的宿主策略配置和标注风险集尚待后续阶段。

### 回退

CLI 省略 `--risk-guard` 或设置 `--risk-guard off`。此时 Context 不装饰工具 schema，Provider 不要求声明，RunController 不调用 ActionPolicy，也不产生 Guard Event/额外模型请求。

## 12. 实施后自审结论（2026-09-16）

结论：**工程与首轮 FakeComputer 真实 GLM/Qwen API 门槛通过，可进入本机低风险递增测试；真实敏感桌面任务暂不放行。**

本轮自审发现并已修复：

- 原审批方案使用截图原始字节哈希，真实桌面会因光标/动画/编码变化大量误拒绝；已撤销。当前只防止 Harness 内 Observation 被替代，并明确外部变化不可见。
- Guard Event 原计划持久化完整 ActionIntent，可能复制 type.text；已改为 type 仅记录 textLength。效果声明疑似包含凭据时拒绝，复核 evidence 有限脱敏。
- 用户纠正可能在独立复核等待期间排队，旧候选随后仍执行；已在 Guard 返回后先 drain inbox，纠正/暂停使候选失效。
- Provider 返回的声明手工解析原先可能接受额外字段或重复 effects；已严格拒绝。
- Qwen strict Tool Catalog 原先只显示 `_harnessEffect:object`；已展开 effects 枚举、target 和 summary，并验证跨轮历史重编码。

剩余风险：

- P0（进入真实敏感任务前）：扩大脱敏声明/复核矩阵，测缺失、错报、格式反馈重试和第二轮漂移；首轮连通性通过不能代替风险准确率。
- P0（真实 CUA 高危动作前）：解决 Approval 等待期间的外部桌面变化/目标身份问题。ObservationId 只能表示 Harness 观察版本，不能证明按钮仍在原坐标。
- P1：完整 Trajectory 的既有 ToolCall/Action 仍可能保存敏感输入，需要独立的数据保留、加密或字段脱敏策略。
- P1：Router 的 target/summary 规则只是漏报召回层，主模型低风险误报仍可能直接放行；必须通过标注集测量，不能把工程测试解释为安全准确率。
- P2：审批目前是单动作授权；批量审批、授权范围和可撤销 grant 尚未设计。

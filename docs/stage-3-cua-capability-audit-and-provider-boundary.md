# Stage 3 审计、CUA 能力探测与 Provider 边界

日期：2026-08-29
审计基线：`5128021 feat: close stage 2 runtime and computer contracts`

## 1. 结论

最新 S3-0 代码可以进入 Stage 3，但下一步应先进入 **S3-1 能力探测与协议决策**，不能直接把
CUA 方法逐个包装成模型工具。

本轮已重新运行：

```text
pnpm run typecheck  通过
pnpm test           通过（2 个测试文件，59 项）
git diff --check    通过
```

上一轮要求收口的内容已经真实落地：

- `ToolDefinition.validate` 已成为必需合同，参数错误会在整批工具产生副作用前拒绝；
- pause/resume 不再维护第二份 `paused` 状态，同批命令以最终 Snapshot 为准；
- `ComputerSession` 已收敛为稳定、可序列化描述，Driver handle 没有进入 Protocol；
- cleanup 失败可以通过窄的 diagnostic callback 被观察，又不会覆盖既定 RunOutcome；
- GUI Action 在 `action.proposed` 前统一校验当前 Observation、Viewport 和基础能力；
- 公开 Snapshot/Event 读取返回副本，Fake Runtime 的故障注入和控制语义已有测试。

因此不需要回头重写 Runtime，也不需要增加通用状态机、DI 框架或新的事件总线。

S3-1 的首个只读子探针已经完成，结果见
[`stage-3-s1-capability-probe-results.md`](./stage-3-s1-capability-probe-results.md)。它只
证明 SDK/daemon 的能力清单、session 读写、健康检查和权限检查可调用；截图、输入、坐标、
`ActionResult`、取消和过期行为仍未通过实测，不得把本节的“API 存在”写成“GUI 行为已通过”。

## 2. 新发现的两个 Stage 3 合同问题

### 2.1 `scroll` 的 Harness 语义与 CUA 0.22.2 不等价

当前 Harness：

```ts
{ kind: "scroll", deltaX: number, deltaY: number }
```

CUA 0.22.2 的公开输入是：

```text
x / y + direction + by(line|page) + amount
```

其中 `(x,y)` 对桌面或窗口内的嵌套滚动区域有实际意义。Adapter 不能把缺失落点默认为当前
鼠标位置或 Viewport 中心，否则相同 `ActionIntent` 在不同机器上会有不同语义。

S3-1 必须通过真实实验决定 Harness 的规范形式。建议优先采用：

```ts
{ kind: "scroll", point: Point, direction: "up" | "down" | "left" | "right",
  amount: number, unit: "line" | "page" }
```

如果 Provider 更适合输出连续 delta，转换也应在 Provider/Tool presentation 层明确完成，不能在
CUA Adapter 内凭经验猜测。修改后同步更新 `GuiActionDraft`、Trajectory Schema、Runtime 校验和
测试。这是一个窄协议修订，不需要建立通用手势系统。

### 2.2 “Frame 新鲜度”必须分两类能力

CUA 当前存在两种不同路径：

1. 窗口 Accessibility 路径：`get_window_state` 返回 `snapshot_id` 与 `element_token`；新快照会
   使旧 token 明确失效，能够由 Driver fail-closed。
2. 主显示器像素路径：`get_desktop_state` 返回完整桌面图，但普通桌面 click 不携带 Frame token。
   Harness 只能证明动作绑定的是“自己保存的最新 ObservationId”，不能证明截图后桌面从未被
   用户、动画或后台进程改变。

因此 Stage 3 不能笼统承诺“CUA 会拒绝所有旧 Frame”。V1 的正确承诺是：

- Runtime 拒绝不绑定当前 `ObservationId` 的 GUI Action；
- Adapter 拒绝 Session/daemon generation 已变化的动作；
- 使用窗口 element token 时，保留并执行 Driver 的强 stale-token 校验；
- pause、人工审批或用户纠正后，不直接恢复旧像素动作，而是重新 Observe 并让模型重规划；
- 对普通桌面像素动作，不虚构不存在的 Driver Frame token，也不默认每次动作前重复截图并做脆弱
  的全图哈希比较。

这一区分应写入对外能力说明：`logical latest-observation binding` 不等于
`driver-attested visual freshness`。

## 3. CUA 是否应单独成为 package

应该。建议新增一个正式 package：

```text
packages/computer-cua/
├─ package.json
├─ tsconfig.json
└─ src/
   ├─ index.ts
   ├─ cua-driver-computer.ts
   └─ cua-driver-computer.test.ts
```

只有当结果映射代码明显增长时，再增加 `result-mapping.ts`；不要预建 `session-manager`、
`capability-service`、Windows/macOS/Linux 三套目录。

理由不是“看起来更模块化”，而是它确实具备独立依赖和替换边界：

- `@trycua/cua-driver` 是 OS/CPU 相关的可选原生依赖；
- `runtime` 不应反向依赖 CUA 私有类型；
- 后续其他 Computer Backend 可以独立替换它；
- CUA live tests 与纯 Runtime tests 的环境、权限和运行成本不同。

建议包名为 `@computer-harness/computer-cua`。它实现 `Computer`，只向外导出
`CuaDriverComputer` 和必要的配置。内部可以用一个窄的
`Pick<CuaDriverLike, ...>`/factory 作为测试缝，不把整个 CUA SDK 重新包装一遍。

### 3.1 生命周期边界

Stage 0 已证明 Windows 当前应使用独立 daemon 路线。正式 Adapter 在本阶段负责：

- 连接已知 socket；
- 创建/附着一个明确的命名 Session；
- 在 `close()` 时结束自己的 Session 并释放 SDK client；
- 识别 daemon generation、断连和权限拒绝。

它暂不负责下载安装到全局、静默拉起任意 daemon 或终止共享 daemon。以后 CLI composition root
需要一键启动时，再增加受控的 daemon supervisor；不要把安装器塞进 `Computer.open()`。

## 4. 已确认的 CUA 0.22.2 能力面

本机 npm registry 的 `latest` 与项目锁定版本均为 `0.22.2`。实际只读调用得到：嵌入式 SDK
Driver `0.22.2`、contract `0.7.0`、56 个工具；独立 daemon 同版本返回 57 个工具（额外的
`check_for_update`）。下面是能力分类，不代表都应暴露给模型。工具清单会随运行模式变化，
不能以总数作为协议依据。

### 4.1 V1 核心执行候选

- 观察：`get_desktop_state`、`get_screen_size`；
- 像素输入：`click`、`double_click`、`right_click`、`drag`、`scroll`；
- 键盘输入：`type_text`、`press_key`、`hotkey`；
- 生命周期：`start_session`、`get_session`、`end_session`；
- 元数据：`metadata`、`listToolsJson`、Driver 可用性与 execution mode；
- 取消：TypeScript SDK 的异步调用接受 `AbortSignal`。

这里的“核心候选”也不等于全部模型可见。当前 Agent Loop 已在 Run 开始和每个 GUI Action 后
自动 Observe；V1 可以暂不提供一个重复的模型 `observe` Tool。等待页面稳定时使用 cancellable
`wait`，随后仍由 Runtime 统一 Observe，避免模型在没有状态变化时无限截图。

### 4.2 有价值，但不应立刻成为模型工具

- 窗口与结构化观察：`list_apps`、`list_windows`、`get_accessibility_tree`、
  `get_window_state`；
- 确定性检查：`verify_state`，支持 window bounds、元素 exists/value/enabled/selected、有限等待和
  stable samples；
- Action 结果：`effect`、`route`、`delivery`、有限 evidence 与 escalation；
- 焦点/窗口控制：`bring_to_front`、`set_window_frame`、`invoke_menu`；
- 剪贴板：`clipboard_read`、`clipboard_write`。

这些能力先作为 Adapter 内部观测、验证或后续受策略约束的 Side Tool 候选。尤其
`verify_state` 不应默认在每一步调用，也不能把 Accessibility 的 `unknown` 当成失败或成功。

### 4.3 Host 内部能力，禁止直接交给模型

- daemon shutdown、全局配置、授权 host、权限提示、Session TTL/权限模式；
- capability manifest、unrestricted acknowledgement 和残余授权决策；
- recording/replay、进程终止、文件传输和浏览器 profile 授权；
- Driver activity observer 与诊断元数据。

这部分由可信 Host/Policy 管理，不属于 Agent 自由调用空间。

### 4.4 当前 Harness 尚未表达的能力

- 精确目标：CUA 区分 `{window: pid + window_id}` 与 `{desktop: display_id}`；当前 Harness 只有
  Viewport，没有 Observation target identity。Stage 3 V1 应明确只支持主显示器桌面，不要在
  Adapter 私下假装支持窗口模式。窗口 Observation 等真实消费者出现后再新增清晰的 target。
- 细粒度能力：当前 `pointer/keyboard/accessibility` 是粗粒度布尔值。V1 若实验证明核心动作在
  三个平台上成组可用，可暂时保留；若出现“能 click 但不能 drag/scroll”等真实差异，再改为
  可枚举 Action kind，不能复制 CUA 的 56 项清单进入 Protocol。
- Accessibility 数据通路：当前 `ObservationCapture` 只有截图。因此即使 CUA 支持 AX，也不能
  先把 `ComputerSession.capabilities.accessibility` 写成 true 后不提供消费路径。
- Viewport 权威性：`ComputerSession.viewport` 只能解释为打开 Session 时的初始描述；动作校验
  继续以它所绑定的 `ObservationFrame.viewport` 为准。`ComputerOpenOptions.viewport` 若存在，
  应作为调用方期望值进行一致性检查，不能命令 Driver 静默缩放桌面来迎合它。
- Action 效果回执：当前 `ActionReceipt` 只有 completed/refused/failed/cancelled。S3-1 要验证
  CUA 的 `confirmed/partial/unverifiable/suspected_noop/refused` 是否稳定，再决定是否增加一个
  小型规范化 `effect` 字段；不要把 CUA 原始 JSON 塞进公共协议。

## 5. S3-1 必做实验

实验结果先落到 ignored 的本机目录，提交时只保留脱敏摘要。固定记录 OS、DPI、显示器布局、
CUA/contract 版本、execution mode 和 daemon generation，不记录私人窗口标题或截图。

### E1：能力与 Schema 清单（无 GUI 副作用）

- 调用 `metadata()`、`listToolsJson()`、`get_session`、`get_session_state`、
  `listHostSessionsJson`、`health_report`、`check_permissions`；
- 保存每条运行路径工具清单的名称、risk、capabilities 和相关工具的 input/output schema；
- 对比 typed SDK 与通用 `callTool` 路径，确认 Stage 3 实际采用哪一条；
- 锁定正式 Adapter 的最小依赖方法，不把全部工具注册进 Harness。

当前实现的只读探针已经完成上述调用，并在嵌入式/daemon 两条路径都得到成功结果。需要保留
的事实是：`listSessions` 在嵌入式路径本次返回空数组，而 daemon 路径能看到刚创建的命名
session；host 级摘要在两者都能看到活动 session。正式 Adapter 应以自己创建的 session
加 `getSession` 为生命周期依据，不能依赖跨 transport 的全局列表。

独立 daemon 的无输入尺寸复核随后也已完成：`get_screen_size` 与 `get_desktop_state` 均返回
主显示器 `2560×1600 @ 1.5`，保存 PNG 同为 `2560×1600`。这只关闭了 E2 的“独立 daemon
截图尺寸/保存链路”子项，不关闭坐标、输入和多显示器门禁。详细输出见
[`stage-3-s1-capability-probe-results.md`](./stage-3-s1-capability-probe-results.md)。

### E2：Observation 与坐标

- 在 Windows 100%/125%/150% DPI 中核对 PNG 像素、Driver screen size、物理桌面和 Viewport；
- 验证主显示器全屏捕获、多显示器布局和不支持 display ID 的明确拒绝；
- 分别测 desktop screenshot、window screenshot、window bounds 和结构化元素坐标；
- 验证截图资产完整落盘，不发生缩放、裁剪或坐标静默换算。

### E3：核心 Action 矩阵

使用可恢复的本地测试窗口完成 click/double/right、drag、scroll、英文与中文 type、单键、组合键，
每个动作均执行 `observe → action → observe`。测试 fixture 只用于 Driver 合同，不作为模型任务
Benchmark。

每项记录：

- 输入语义与目标坐标空间；
- CUA action effect/route/delivery/error；
- OS 是否实际产生预期副作用；
- ActionReceipt 应如何规范化；
- 延迟与失败是否可取消。

### E4：新鲜度与生命周期

- 窗口元素：新 `get_window_state` 后旧 `snapshot_id/element_token` 必须 fail-closed；
- 桌面像素：验证并明确其没有 Driver-attested Frame token；
- daemon 重启、generation 改变、连接断开、Session end/idle expiry 后旧动作不能继续执行；
- Abort 在 Driver 接收副作用前应为 cancelled；无法确认是否已执行时必须进入
  `outcome_unknown`，不得自动重试；
- 正式 Adapter 连续完成至少 20 轮 `observe → action → observe`，再关闭资源。

### E5：低成本校验能力

- 对 `verify_state` 分别测试 window exists/bounds、element value/enabled/selected；
- 特别测试元素缺失、树截断、多匹配和不支持控件，确认返回 `unknown` 而不是伪造结论；
- 比较 `stable_samples=1/2` 与 timeout 的延迟；
- 验证 Action 的 suspected-noop/effect-unconfirmed 是否能提供比截图差分更可靠的信号。

该实验决定后续 Verifier 的设计空间，但 Stage 3 不把它接入每步主链。

## 6. Stage 3 的施工顺序与门禁

### S3-1：完成上述能力探针

产出一张“工具/能力—平台—证据—是否进入 V1”的矩阵。清单/生命周期/健康/权限的只读子项
已完成；截图、坐标、动作、`verify_state`、取消和过期仍标记为 unknown。未实测字段不得从
官方宣传页推断成功。详细结果见
[`stage-3-s1-capability-probe-results.md`](./stage-3-s1-capability-probe-results.md)。

### S3-2：只修真实阻塞合同

- 修订 `scroll` 语义；
- 明确主显示器 Desktop target；
- 明确 CUA ActionResult 到 ActionReceipt 的映射；
- 把 Frame 新鲜度分为 Harness latest binding 与 Driver token 两级。

没有证据时不扩建 Accessibility Event、通用 Target hierarchy 或 56 项 Capability enum。

### S3-3：实现 `@computer-harness/computer-cua`

先用窄的 fake CUA port 做 contract tests，再运行真实 daemon。实现过程中不修改
`RunController` 的 Provider/Context 逻辑。

### S3-4：Live contract test

必须通过：

1. `open → observe → execute → observe → close` 的事实和资产完整；
2. DPI/Viewport/坐标一致；
3. 核心动作矩阵通过，非法动作在副作用前拒绝；
4. Session generation 变化与 element token 过期明确拒绝；
5. Driver 断连/取消/未知副作用不自动重试；
6. 20 轮稳定性、资源释放、脱敏报告通过；
7. 全仓 typecheck/test 与 package contract tests 通过。

## 7. Provider 统一层应如何使用 Computer 工具

需要阅读每个 Provider 的最新官方文档并做协议级小实验，但不要为每个 Provider 创建不同的
Runtime 语义。正确关系是：

```text
Harness 注册的工具
        ∩ 当前 Computer Backend 已验证的能力
        ∩ Runtime Policy 本轮允许的能力
        ∩ Provider 能表达且当前模型支持的协议
        ↓
EffectiveToolSet
        ↓
Provider-specific presentation
        ↓
统一 ToolCall → ActionIntent → Computer.execute
```

因此，模型看到的工具空间对 CUA 56 项能力而言通常是一个严格裁剪后的**投影**，但不是机械
子集：

- `wait` 可以由 Runtime 实现，并非 CUA 工具；
- Harness 的 `keypress` 可以映射到 CUA `press_key` 或 `hotkey`；
- Provider 可能更适合多个独立 function，也可能更适合一个带判别联合的 `computer` function；
- 原生 Computer Use Provider 将自己的 action event 转成相同 `ActionIntent`，仍不能绕过
  Runtime 校验和 Event 记录。

第一版 Provider 默认只看经过验证的 GUI Action 与 Planning Tool。CUA 的 Session、metadata、
权限、`verify_state`、浏览器 API 和 Accessibility discovery 不直接暴露；如果以后成为正式
消费者，再作为 Runtime 内部能力或受 Policy 约束的 Side Tool 分批加入。

### 7.1 已核对的官方能力差异

- Qwen 当前视觉模型文档明确支持图像输入与 Function Calling；部分模型还支持结构化输出、
  `tool_choice` 和并行 Tool Call。Provider Adapter 应按具体模型能力开关，而不是只按厂商品牌。
- GLM-4.6V 官方文档明确支持图像输入和原生多模态 Function Call；智谱通用工具调用文档当前
  `tool_choice` 只支持 `auto`，这会影响 Harness 是否能强制动作调用。
- 豆包/火山方舟同时提供视觉理解与 Function Calling，但在选定具体 endpoint 前，必须确认同一
  模型是否同时支持图像、工具调用、流式 ToolCall 和所需 JSON Schema；不能把产品目录中的两项
  能力自动视为同一模型可组合。

Stage 4 建议先定义小型 `ProviderCapabilities`，只包含已有消费者的字段，例如：

```text
visionInput / functionCalling / parallelToolCalls / toolChoiceModes /
structuredOutput / streamingToolCalls / imageTransport / maxImages
```

再为每个 Provider 实现 Tool presentation 与响应解析。不要现在新增完整 Provider package，也
不要先求最低公共分母；等 S3-4 通过后再以 Qwen 与 GLM 各做一个最小 conformance probe。

## 8. 官方依据

- CUA Driver MCP Tools：<https://cua.ai/docs/reference/cua-driver/mcp-tools>
- CUA Driver Interface Contracts：<https://cua.ai/docs/reference/cua-driver/contracts>
- CUA Driver Known Limits：<https://cua.ai/docs/reference/cua-driver/limits>
- CUA 独立后置条件验证示例：<https://cua.ai/docs/how-to-guides/driver/verify-a-desktop-action>
- Qwen 视觉模型能力：<https://help.aliyun.com/zh/model-studio/vision-model/>
- Qwen Function Calling：<https://help.aliyun.com/zh/model-studio/qwen-function-calling>
- GLM Function Calling：<https://docs.bigmodel.cn/cn/guide/capabilities/function-calling>
- GLM-4.6V：<https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v>
- 火山方舟文档入口：<https://www.volcengine.com/docs/82379/1541594?lang=zh>

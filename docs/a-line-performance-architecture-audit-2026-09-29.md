# A 线性能与结构审计

更新：2026-09-29。

状态：只读审计完成；尚未修改运行时代码，也未为本审计发起新的付费模型请求。

## 1. 结论

当前最主要的性能问题不是手机 Relay、网页加载或本机点击，而是一次简单任务被拆成了过多模型回合，并且每一回合都携带较重的固定上下文。最近一次真实冒烟任务用时约 150 秒，其中 7 次 GLM 请求合计约 135.7 秒，占 90.5%；电脑打开与 6 个动作合计约 10.8 秒。

因此应按以下顺序优化：

1. 先修正 GLM-5.3 请/Users/guoyuhang/Desktop/大创/Computer-Harness/docs/a-line-performance-architecture-audit-2026-09-29.md求参数，并补齐可观测性。
2. 再减少模型回合：优先利用已有“起始网址”，随后补任务级工具配置和安全批处理。
3. 为受管浏览器增加有界的原生导航、页面元信息读取能力。
4. 再压缩工具和上下文、按需传图。
5. 最后接流式响应和做 Provider 对比。

这不是一次大重构。现有 Protocol、Runtime、Provider、Computer、Context、App Runtime、Host/Web 和 Relay 的职责边界基本合理；问题主要来自 Host 的静态满配置、Provider 参数落后于当前模型合同，以及已经存在的能力没有组成低延迟路径。

## 2. 审计范围与证据

本次检查了：

- 最近真实运行：`runs/local/a-line-20260928/run-1790669635262-e7bb0cc2-f60`
- `packages/provider-glm`、`packages/runtime`、`packages/context`
- `packages/computer-cua` 受管浏览器、截图、UIA/DOM grounding
- `packages/app-runtime` 组合根和 Provider 诊断
- `apps/host` 默认运行配置、`apps/web` 任务创建入口
- Relay 在当前执行链中的职责和连接状态
- 智谱官方的思考、上下文缓存、流式消息和流式工具调用文档

本次没有：

- 发起新的真实 GLM/Qwen 请求；
- 修改业务代码；
- 操作真实桌面；
- 用一次成功任务推断所有网站和所有任务都已稳定。

## 3. 真实运行基线

任务：打开受管浏览器，访问 Apple 中国官网，只读取页面标题，不点击页面内容、不购买、不下载。

| 指标 | 实际值 | 判断 |
| --- | ---: | --- |
| Run 总时长 | 149.981 秒 | 明显偏慢 |
| 模型请求 | 7 次 | 简单任务回合数过多 |
| 模型累计时长 | 135.747 秒 | 占总时长 90.5% |
| 单次模型时长 | 8.428—31.718 秒 | API/推理是首要耗时 |
| Computer 打开 | 2.386 秒 | 非主要瓶颈 |
| 6 个动作累计 | 8.445 秒 | 非主要瓶颈 |
| 单次输入 Token | 8,828 增至 10,781 | 固定负担重且历史持续增长 |
| 单次输出 Token | 117—509 | 正式输出不大，思考等待更值得优化 |
| 工具数 | 18 | 简单只读任务也携带完整工具集 |
| 工具 Schema 估算 | 4,530 Token | 占固定输入的大头 |
| Guard 模型请求 | 0 次 | 本次风险守卫走本地路径，不是瓶颈 |

模型动作序列为：

1. 点击地址栏；
2. 输入网址；
3. 因画面仍像 `about:blank` 再次点击地址栏；
4. 使用 `CMD+L`；
5. 再次输入网址；
6. 按 Enter；
7. 最后再调用模型生成完成结论。

这条序列同时暴露了三个问题：

- 任务表单已有“起始网址”，但本次网址只写在自然语言目标中，浏览器从空白页开始。
- 点击焦点不一定产生可见画面变化，模型将“没有可见变化”误判成输入未生效。
- Provider 提示要求每回合最多一个 Computer 调用，Runtime 虽支持有限批处理，模型却被明确阻止使用。

## 4. 当前结构评价

### 4.1 合理且应保留的部分

- 单一 RunController 是正确的权威执行环；手机、CLI 和 Host 不应各自复制 Agent Loop。
- Provider 只负责模型协议，Computer 只负责观察和执行，风险策略位于执行前；这些边界清晰。
- 每次 GUI 动作后的重新观察、精确窗口绑定、审批绑定截图、取消/暂停屏障属于安全合同，不能为了速度删除。
- Relay 只做远程连接和事件转发，不持有 Runtime，也不应承担任务规划。
- 受管浏览器 CDP 连接仅绑定回环地址和已验证目标，这个安全边界应继续保留。

### 4.2 主要结构性问题

Host 当前对所有任务使用一套固定配置：

- Planning 开启；
- Memory 与词法召回开启；
- 18 个工具全部暴露；
- layered risk guard 开启；
- hybrid UIA/DOM grounding；
- 每次动作后都重新观察并再次请求模型；
- Context 上限配置为 8,000 Token，但 Provider 实际收到 8,828—10,781 Token。

这套配置适合复杂、长任务，但对“打开一个网址、读取标题”属于过度装配。优化方向应是“按 Run 冻结能力档位”，而不是在运行中随意切换安全合同。

建议新增三类任务级配置：

| 档位 | 适用任务 | 主要能力 |
| --- | --- | --- |
| browser-readonly | 单站查询、标题/页面字段读取 | 受管浏览器、导航、滚动、只读元信息、必要点击、结束 |
| desktop-edit | TextEdit/WPS 等编辑保存 | 键盘、窗口、保存弹窗、审批、结束 |
| cross-app | 多窗口、纠正、长期任务 | Planning、Memory、窗口交接、完整控制 |

档位在创建 Run 时确定并写入轨迹；不能因为模型临时想要更多权限而静默扩权。

## 5. 关键问题与优化方向

### P0-1：GLM-5.3 请求合同与当前官方说明不一致

当前 Host 默认 `glmThinking=disabled`，Provider 请求发送：

- `stream: false`
- `thinking: { type: disabled }`
- 没有 `reasoning_effort`
- 没有 `max_tokens`

智谱当前官方文档明确说明 GLM-5.3 / GLM-5.3-FLASH 不再支持关闭思考，且默认推理强度为 `max`；轻任务支持 `reasoning_effort: low`。真实响应仍带有 188—1,857 字符的 reasoning content，说明当前“disabled”没有带来可验证的低思考效果。

建议：

1. 把模型能力写成 Provider profile，而不是让 Host 用通用布尔值猜测。
2. GLM-5.3-FLASH 使用 `thinking.enabled + reasoning_effort.low` 作为交互任务候选默认。
3. 给交互步骤设置有界 `max_tokens`，初始候选 512—1,024；复杂总结另设上限。
4. 保留 `high/max` 配置，只给复杂规划显式使用。
5. 先做离线 request-body 测试，再在用户授权的固定任务上做 A/B。

验收：

- 发送给 5.3 的请求不再包含不支持的 disabled；
- 轻任务 p50/p95 延迟下降，成功率和工具参数正确率不退化；
- 超出输出上限时明确失败或重试，不能截断后误执行。

### P0-2：先补测量能力，否则无法证明优化

现有 Provider 诊断只记录整次 `latencyMs`，无法区分：

- 建连/等待响应头；
- 首个 reasoning/content/tool delta；
- 工具参数完整；
- 响应结束。

GLM 响应里的 `prompt_tokens_details.cached_tokens` 和其他 usage 扩展目前被标为未知字段；Protocol 已有 `cacheReadTokens`，但 GLM Adapter 有测试明确选择不解析它。这个决定来自旧的“语义未验证”边界，而当前官方文档已经明确了该字段含义，可以重新建立验证证据后接入。

建议新增：

- headers、first-delta、first-tool-name、tool-arguments-complete、complete 五段时延；
- request 文本字节、图片字节、工具 schema 字节；
- provider-reported cached tokens；
- provider-reported reasoning tokens（若当前响应提供）；
- 每 Run 的模型回合、动作回合、无变化观察、重复动作统计。

日志继续只记录白名单摘要，不能写 API Key、完整截图、敏感输入或完整 Provider 原文。

### P1-1：优先消除不必要的模型回合

当前 Web 已有“起始网址（可选）”，RemoteRunApi 也会把它传给受管浏览器。如果本次任务填入该字段，浏览器可以直接打开目标站点，预计可消除地址栏点击、两次输入、快捷键和 Enter 对应的多个模型回合。

立即可用的流程改进：

- 选择“打开网站（推荐）”；
- 在“起始网址”填完整 URL；
- 自然语言目标只写读取/比较要求。

产品改进：

- 当浏览器任务的目标文本中只有一个明确的 http/https URL 时，在表单中可见地预填“起始网址”；
- 用户仍可修改或删除；
- 多 URL、非 http(s)、含凭据 URL 不自动填；
- 不在 Host 内静默猜目标网址。

下一次同题目标：在无需页面内交互时，把 7 次模型请求降到 1—2 次。由于尚未真实 A/B，不能提前宣称具体秒数。

### P1-2：修复批处理提示和 Runtime 语法不一致

当前 Context 合同允许有限 GUI batch，但 GLM profile prompt 无条件要求“每回合最多一个 Computer 调用”。真实 reasoning 明确引用了这条限制，因此 `type` 和 Enter 被拆成多个模型回合。

Runtime 的 `same-control-input-v1` 还只识别：

- `click -> type`
- `Ctrl+A -> type`
- `click -> Ctrl+A -> type`

它不识别受管浏览器实际暴露的 `click_element`，也不识别 macOS 的 `CMD/META+A`。因此即使删除 Provider 限制，当前浏览器路径仍无法使用有效 batch。

建议：

1. Provider prompt 从 Run feature 生成，只描述 Runtime 真正接受的 batch。
2. 扩展并测试 `click_element -> type` 与 macOS `CMD/META+A -> type`。
3. 保持 Enter、提交、导航、滚动、拖拽、等待和审批动作不能混入不透明批次。
4. 整批动作仍绑定同一观察、同一控件和同一 Guard 决策；中途窗口变化必须停止。

### P1-3：使用已有 CDP 构建有界浏览器能力

受管浏览器已经维护 Host 私有的 loopback CDP 连接，用于 DOM grounding、点击和下拉选择，但没有公开的：

- `browser_navigate(url)`
- `browser_read_page_metadata()` 或 `browser_read_title()`

结果是模型必须像人一样操作地址栏，连读取标题也依赖截图/可访问性目录。

建议增加受管浏览器专属、有界工具：

- 导航只接受 http/https，拒绝凭据、file/javascript/data 等危险 scheme；
- 继续绑定已验证的浏览器 PID、窗口和 CDP target；
- 导航声明 `navigate` effect，照常经过 Guard；
- 元信息只返回 URL、title、加载状态等白名单字段；
- 不开放任意 `Runtime.evaluate`，不返回完整 DOM、表单值、Cookie 或存储内容；
- 导航后仍生成新的 Observation，再由模型判断完成。

对于当前标题任务，这条路径有机会把“规划导航—执行—确认”压到 1—2 个模型回合，同时不破坏窗口和证据合同。

### P1-4：按 Run 裁剪工具，而不是每次都发送 18 个

本次固定输入约 5,612 Token，其中工具 schema 约 4,530 Token。18 个工具包括 Planning 4 个、Memory 4 个，但简单冒烟任务完全没有使用它们。

风险装饰 `_harnessEffect` 约增加 1,614 个估算 Token。不能直接删除这个安全合同，但可以通过减少本 Run 暴露的 Computer 工具数量同步降低其成本。

建议：

- 为任务档位配置固定工具白名单；
- browser-readonly 默认不注册 Planning/Memory 写工具；
- 简单任务不暴露 drag、文件编辑等无关能力；
- 需要澄清时保留 `interact`，需要结束时保留 `terminate`；
- 先按 Run 固定，避免逐回合工具集合变化破坏上下文缓存和可重放性。

目标：把简单浏览器任务的工具 schema 降低至少 50%，并验证 Guard 与回放仍一致。

### P2-1：Context 的 8,000 Token 不是实际 wire 上限

Context compiler 用字符数/4估算文本，并把 8,000 作为内部预算；Provider 实际 prompt 从 8,828 增长到 10,781。差值来自 Provider 包装、视觉输入和估算误差。

建议：

- 引入 Provider-aware 安全余量；
- 用 Adapter 的 prepared request estimate 反馈预算检查；
- 若 wire estimate 超限，重新裁剪历史和 grounding，而不是照常发送；
- 固定前缀保持字节稳定，变化内容放后面，增加隐式缓存命中机会；
- reasoning continuation 是否可以缩短必须依照 Provider 连续工具调用合同验证，不能直接删除。

官方文档说明重复前缀建议至少约 500 Token；当前 system + tools 远超该门槛，理论上具备缓存条件，但只有 provider-reported cached tokens 才能证明实际命中。

### P2-2：视觉输入改为按需，而不是盲目压缩

当前每个模型回合都附最新全窗口 PNG；本次后期截图达到约 454 KB。截图/grounding 本机耗时不是第一瓶颈，但图片上传和视觉编码会放大 API 延迟。

建议顺序：

1. 先减少模型回合；
2. 元信息任务优先用有界 DOM/CDP 结果；
3. 只有需要视觉定位时才附图；
4. 再评估下采样、裁剪或 JPEG。

任何图片变换都必须同步坐标映射，并保留原始审计图；审批绑定图不能被低清或裁剪版本静默替代。

### P2-3：本机观察链有次要优化空间

窗口观察当前先截图，再读 UIA，再依赖 UIA content rect 读取 DOM，三段存在顺序依赖。不能简单 Promise.all。可做的优化是：

- 页面元信息任务绕过完整 UIA/DOM 目录；
- 只有需要窗口交接时才做额外窗口 inventory；
- 对完全相同的 observation fingerprint 记录重复率；
- 在不破坏“动作后必须观察”的前提下，减少无用目录字段和落盘开销。

由于本次 Computer 侧总耗时仅约 10.8 秒，这一项排在模型回合和请求参数之后。

### P3：流式响应主要改善反馈，不等于可提前执行

当前 GLM 使用 `stream:false` 并等待完整 JSON。官方支持 `stream:true` 和 `tool_stream:true`，可以更早展示“模型已响应、正在生成工具参数”。

必须保持：

- 不执行不完整的流式工具参数；
- 参数完整后仍做 schema、Guard、窗口和 observation 校验；
- usage 在最终 chunk 到达后再记账；
- 断线时未完成工具调用不得当成成功。

因此流式首先改善“卡住没反应”的感知延迟；是否降低任务总时长，要由完整参数时间实测。

### P4：最后才比较 Provider 或做模型路由

项目已经有 Qwen Provider，可以用同一冻结任务做每 Run 级别对比。但在 7 个回合未减少、工具 schema 未裁剪前，换模型只能掩盖结构浪费。

建议先完成 P0/P1，再比较：

- 成功率；
- p50/p95 完成时长；
- 模型回合数；
- 输入/输出/缓存 Token；
- 重复动作率；
- 人工介入率；
- 单任务成本。

暂不建议同一 Run 中途切 Provider；continuation、工具调用历史和回放语义会明显复杂化。

## 6. 不应作为当前优化重点

### Relay

手机只负责创建任务、控制和查看事件，真实模型/Computer 执行在本机 Host。当前连接已建立，本次 135.7 秒模型等待不由 Relay 造成。Relay 继续维护 SSE、心跳和断线恢复即可。

### Risk Guard

本次 6 个动作全部由本地低影响规则允许，`modelRequestCount=0`。不能为了性能关闭 Guard；应继续压缩其工具 schema 表达，但不削弱效果声明和审批边界。

### Monitor

Monitor 已是 shadow，不阻断任务。它会影响 grounding recovery 提示，但不是本次 API 延迟来源。后续可减少“焦点变化不可见”导致的误恢复，不能直接移除无进展检测。

### 并行 GUI 动作

GUI 状态具有顺序依赖，点击、输入、导航不能为了速度并行。可以并行的是独立的只读网络/元数据任务，前提是结果不改变窗口状态，并且 Runtime 能明确表达其一致性边界。

## 7. 推荐实施顺序

### 阶段 0：建立可信基线

- 补 GLM usage 与分段时延诊断；
- 固定 3 个轻任务、2 个中等任务；
- 每题记录 Run ID、模型回合、动作数、总时长、人工介入；
- 不重复调用失败题，先用离线 mock 验证。

### 阶段 1：修 Provider 参数

- GLM-5.3 capability profile；
- `thinking.enabled + reasoning_effort.low`；
- 有界 `max_tokens`；
- request-body、响应解析、错误边界测试；
- 经用户授权后做少量真实 A/B。

### 阶段 2：减少回合

- 明确使用起始网址；
- 单 URL 可见预填；
- 修 GLM batch prompt 与 Runtime grammar；
- browser-readonly 工具白名单；
- 简单任务关闭 Planning/Memory。

### 阶段 3：受管浏览器快速路径

- 有界 navigate 与 page metadata/title；
- Guard、窗口、target、scheme、重定向测试；
- 原题与不同域名变体复验。

### 阶段 4：Context 和图片

- Provider-aware wire budget；
- cache usage；
- grounding/历史裁剪；
- 视觉按需与坐标回归。

### 阶段 5：流式与 Provider 对比

- SSE/tool stream；
- 手机端细粒度进度；
- GLM/Qwen 同任务基准；
- 再决定默认 Provider，不凭单次速度切换。

## 8. 阶段验收门槛

| 项目 | 最低门槛 |
| --- | --- |
| 正确性 | 任务成果与人工核对一致；不假报完成 |
| 安全 | 窗口绑定、审批、取消、暂停、未知副作用合同不退化 |
| 简单网页任务 | 中位模型回合不超过 2；不再重复输入同一 URL |
| API 延迟 | 记录 p50/p95 和 first-delta；不能只看一次最快值 |
| 上下文 | 实际 prompt 和内部预算差异可见；工具 schema 至少下降 50% |
| 稳定性 | 原题 3 次 + 至少 2 个变体，无人工代做关键步骤 |
| 可回退 | 每个优化有配置开关或清晰回退提交，不混成一次大改 |

性能目标不能以关闭 Guard、跳过观察、忽略失败或预填任务答案来达成。

## 9. 建议下一步

下一步先实施“阶段 0 + 阶段 1”，范围控制在：

- GLM profile/config/request/usage/diagnostics；
- 对应离线测试；
- 一份固定性能基准脚本或汇总器；
- 不改 GUI 执行安全语义。

完成后再用同一个标题任务验证“填起始网址”和“未填起始网址”两条路径。只有第一轮数据证明参数与回合数分别带来收益，才进入 CDP 快速路径开发。

## 10. 官方资料

- 智谱深度思考：[thinking](https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md)
- 智谱上下文缓存：[cache](https://docs.bigmodel.cn/cn/guide/capabilities/cache.md)
- 智谱流式消息：[streaming](https://docs.bigmodel.cn/cn/guide/capabilities/streaming.md)
- 智谱流式工具调用：[stream-tool](https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool.md)

## 11. 2026-09-29 晚间真实运行回归

最新 Run `run-1790695562250-5487c916-35e` 暂停在地址栏动作的人工审批边界，补充确认了两个独立问题：

- 目标没有传入起始网址时，`RemoteRunApi` 按合同把临时浏览器启动到 `about:blank`；这不是浏览器加载失败。要验证网页查询，应在手机任务表单的“起始网址”填写完整的 `https://` 地址。
- 风险扫描器把动作说明中的“购买页网址”命中“购买”关键词，转入语义审查。该次 GLM 风险请求在 90 秒超时后消耗了审查预算，随后地址栏点击回退为人工审批。动作本身只是聚焦地址栏/导航，没有支付、提交或购买效果，属于误报。

当前运行不应重复批准多次；应取消后用显式起始网址重跑。代码修复需要单独授权，候选修复是让“地址栏导航 + 只读目标”不因页面/购买页措辞进入金融风险分支，同时保留真实购买按钮的审批。

### 最新 Run `run-1790696287182-5cb022b6-e9f`

- 首次观察已经是 Apple 中国首页，说明本次起始网址配置生效；但首页不是目标购买页，模型仍然执行了地址栏导航，因此不能仅靠填写首页 URL 消除后续导航。
- 首次输入动作的说明包含“MacBook Air 购买页网址”，风险守卫触发语义审查；审查请求 15 秒超时后回退为人工审批。随后回车动作的说明再次包含“购买页”，因风险审查预算已耗尽而直接要求审批。
- 人工审批从 `15:39:37` 到 `15:45:11`，等待约 334 秒。审批通过时受管浏览器会话已失效，动作以 `WINDOW_TARGET_UNKNOWN` 拒绝，随后观察因 CUA 会话结束失败，Run 以 `failed` 结束。
- 本次普通 GLM 请求分别约 21.6 秒、22.4 秒和 4.6 秒；本次主故障不是 90 秒 API 超时，而是风险误判 + 长审批等待造成的窗口生命周期失效。

结论：当前需要修复地址栏只读导航的风险文本误报，并在审批等待期间保持/重新验证受管浏览器会话；在修复前不要把“购买页”相关导航当作已通过的稳定回归。

### 最新 Run `run-1790697988651-b27ecdb9-c3a`（2026-09-30 00:06—00:16，本地时间）

这次运行已经进入目标页面，失败点与上一轮不同，证据链如下：

- `seq 103` 的观察标题为“购买 MacBook Air - Apple (中国大陆)”，UIA 已读到 13 英寸 `RMB 9999 起`、15 英寸 `RMB 11,999 起` 以及页面的“每位顾客限购 2 台”提示；因此本次不是配对失败、空白页或网页无法打开。
- 模型在同一阶段重复输入同一个 URL 三次，并额外执行 `CMD+L` 与 `ENTER`。第一次输入被判定为低影响，后两次输入和回车都因 `risk_model_budget_exhausted` 转人工审批；同一只读导航动作因此产生了三次审批边界。
- `seq 109` 的受保护动作实际上只是 `wait(2500ms)`，声明效果为 `observe`，但仍被标记为 `financial`。同一模型回合还携带了包含“购买页/限购”的 `memory_write_fact` 与任务描述，说明风险扫描/候选聚合把规划或记忆文本的购买关键词污染到了只读观察动作。这是比“关键词误报”更具体的实现缺陷。
- 风险边界拒绝了该回合的三个调用（`task_update`、`memory_write_fact`、`wait`），随后 GLM 连续两次请求各等待 90 秒：`seq 114`、`seq 121` 为 `GLM_REQUEST_TIMEOUT`，`seq 123` 达到重试上限，`seq 124` 结束为 `failed`。因此本次的直接终止原因是 GLM 超时；风险误判和重复导航是造成额外回合、审批和上下文负担的前置诱因。
- 该请求的固定上下文约 5,709 tokens，工具 schema 约 4,530 tokens；后续请求仍带约 6,505 tokens 的输入估算，且一次响应耗时约 80 秒。说明“把超时调大”只能延后失败，不能解决回合膨胀和工具上下文过重。

结论：这次需要同时修复三处：①风险扫描只读取实际 Computer 动作的 target/summary，不能把 task/memory 文本合并进候选动作；②对同一只读 URL 导航做去重，并在页面已到达目标时禁止模型再次导航；③为 browser-readonly 路径缩减工具 schema/历史并设置 provider-aware 超时与重试。修复前不建议继续重复人工批准同一类动作。

### API 超时专项审查（2026-09-30）

并行只读审查确认，当前“API 慢”由请求过重、模型推理时长和重试策略共同造成，不能只把 90 秒阈值继续调大：

- 最新 Run 共 14 次 GLM provider exchange，累计约 485.2 秒，约占整次运行 603.8 秒的 80.4%。末段 `seq 113–123` 连续发生 90.005 秒超时、0.502 秒退避、80.544 秒成功、90.003 秒超时、0.504 秒退避、90.008 秒超时；三次超时合计约 270 秒，最后两次达到重试上限。
- 超时重试不是 GUI 重放：两组 retry 的 `payloadHash` 分别保持 `4ef14d7f0b…`、`5158526385…` 不变，且失败前没有工具执行。因此是同一份重请求被完整重复发送。
- Host 在 `apps/host/src/index.ts` 将 `glmRequestTimeoutMs` 固定为 90,000ms；`packages/provider-glm/src/index.ts` 的单一 deadline 同时覆盖 `fetch` 和 `response.json()`，现有日志无法区分等待响应头、服务端推理或正文读取。已完成响应耗时 46.486 秒和 80.544 秒，且分别带 1,673/2,793 completion tokens 与较长 reasoning，说明服务端生成时间确实参与了延迟，但无法据此排除网络等待。
- 更关键的预算问题在 `packages/context/src/compiler.ts` 与 `packages/provider-glm/src/index.ts` 的估算口径：工具 schema 实际已经进入 `fixedText` 并计入 `estimatedFixedTextTokens`，不能简单归因于“工具完全漏算”；但两处都用字符数除以 4，且上下文预算只记录图片数量，不估算图片视觉 token。本次轨迹显示内部估算约 6,505–7,955 tokens、provider 实际 `prompt_tokens` 为 9,355–10,993，差额约 29%–40%，主要来自中文/JSON token 化偏差和图片成本。这使得名义上的 `8000` 上限不能可靠约束真实 wire prompt，直接放大 GLM 首 token/推理耗时。
- 当前默认 GLM profile 仍启用 `thinking`，并将 `max_tokens` 设为 4,096；`stream:false` 要等完整响应后才能得到结果。Runtime 把 timeout 标为 `retryable + same_input`，固定允许一次完整重试；对于已经消耗 90 秒的重请求，这个策略会再次支付完整 deadline，交互上不合理。

审查结论按优先级排序：

1. **P0**：先修正上下文预算口径，使用 provider-aware 的保守 token 估算，把图片视觉成本纳入硬预算，并增加“内部估算 vs provider 实际 tokens”的诊断；不要重复计算已经属于 fixedText 的工具 schema，否则会误删历史或直接使固定块超限。
2. **P1**：超时不应无条件对同一大请求再给完整 90 秒；应按已耗时、错误类型和请求大小决定是否重试，或在达到交互预算后直接结束并给出可恢复错误。
3. **P1**：增加不记录正文的分段时延（request start、response headers/first byte、body complete），才能定量区分 GLM 服务端推理慢与网络/响应体读取慢。
4. **P2**：只读浏览路径缩减工具 schema、关闭不必要的 Planning/Memory 写调用，并继续修复风险文本污染和重复导航；这些会减少 API 回合数，但不是此次 90 秒 timeout 的唯一根因。

当前未修改业务代码，也未调用真实 API；本节结论来自运行产物、provider 交换记录和源码静态审查。

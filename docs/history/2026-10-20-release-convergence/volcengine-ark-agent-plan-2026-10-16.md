# 火山方舟 Agent Plan：DeepSeek 适配与 Windows 运行记录

2026-10-16。新增火山方舟独立渠道，保留 DeepSeek 官方渠道。本文记录已完成的接入与实跑，不将历史 Windows 候选的结果冒充本 PR 提交树的新验收。

**接续放行范围**：最新main集成后的真实API基础合同已通过；Plan/Memory与一个GUI动作同轮返回可用，三GUI动作Batch尚未获真实API通过证据。基础渠道接入不等于批处理效果或真实业务任务成功。远端CI及合入结果以本文末节和PR36实时状态为准；Preview不变。

## 接入范围与前置提交

PR初始base为 `codex/runtime-surface-preview-20261003`，因此历史中先带入 `455a219`（官方接入／共用实现）及 `ee0b752`（有限恢复／凭据预检）的等价提交，再加入方舟适配。接续集成已合入最新main `e970fea`，以main源码叠加Ark增量，保留原作者及近期Monitor、清理、取消、Windows输入与无障碍修复；不整包带入PR30未合入的网页改动。最终PR目标、API及CI放行状态见本文末尾接续记录，不能以初始旧base的CI通过替代。

方舟与官方渠道各自拥有模型标识、凭据、端点、HTTP 客户端和诊断名称。支持 CLI 主模型、独立风险模型及 Host 启动模型选择；凭据不进入可序列化的 Run 配置、公共响应或日志。没有自动 Provider fallback、运行中热切换或未知 GUI 动作重放。

## 使用方法

| 配置 | 火山方舟 Agent Plan | DeepSeek 官方（保留） |
| --- | --- | --- |
| 模型选择 | `deepseek-v4.1-flash` | `deepseek-flash` |
| 私有 key 环境变量 | `ARK_API_KEY` | `DEEPSEEK_API_KEY` |
| 可选 base URL | `ARK_BASE_URL` | `DEEPSEEK_BASE_URL` |
| 默认 API 地址 | `https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions` | `https://api.deepseek.com/chat/completions` |
| 可选单请求期限 | `ARK_REQUEST_TIMEOUT_MS` | `DEEPSEEK_REQUEST_TIMEOUT_MS` |
| 可选输出上限 | `ARK_MAX_OUTPUT_TOKENS` | `DEEPSEEK_MAX_OUTPUT_TOKENS` |
| 请求诊断 provider | `ark` | `deepseek` |

把 key 放进本机未跟踪的私有 env 文件，不放在命令行、公共 JSON、截图或仓库中。`ARK_BASE_URL` 可使用 `https://ark.cn-beijing.volces.com/api/plan/v3` 或完整 chat completions URL。单请求默认 90000ms，可设置为 1000–240000 的整数；输出默认 4096，可设置为 1–131072 的整数，服务端仍可能施加更低限制。选择方舟不会读取官方 key 作为 fallback，也不会把官方渠道配置覆盖成方舟。

从仓库根目录启动；下面的 socket 必须是当前已授权的本机 CUA socket：

```text
node apps/cli/dist/index.js --goal "describe the current screen" --model deepseek-v4.1-flash --computer cua --cua-socket "<private-socket>" --output "runs/live-ark" --env-file ".env"
node apps/host/dist/index.js --env-file ".env" --socket "<private-socket>" --model deepseek-v4.1-flash --output "runs/host-ark"
```

选择官方渠道时将模型换回 `deepseek-flash`，并单独配置 `DEEPSEEK_API_KEY`。模型在每个 Run／Host 会话内固定；切换 Host 模型需要先完成旧 Run 清理并重启 Host。Web／手机端没有每 Run 模型选择器。

### 产品默认与 low 样本必须分开

当前默认工厂仍使用 `thinking: { type: "disabled" }`、原生 tools 和实际像素坐标；本 PR 不改变产品默认思考强度，也不新增 `ARK_THINKING` 或 CLI 思考参数。

下述 low 样本由运行器通过现有 `createProvider` 接口选择共用 `ChatCompletionsAdapter` 的 `thinking: "low"` profile，配套真实的 `FetchArkHttpClient`、`RecordingArkHttpClient` 和 Ark 严格响应／错误边界。真实 HTTP 配置为 `thinking=enabled`、`reasoning_effort=low`。这是 Run 级选择，不是新的默认工厂能力。原报告的 `thinkingMode: disabled` 是默认工厂标签，不能用于判断这些注入式样本的有效模式；有效模式依据来自生产 transport 记录。思考续传通过既有 Provider continuation 合同保留，不能公开隐藏推理或依赖复制原始请求体复现。

## 已有验证与执行环境

接入阶段在已有 Windows 修复候选中完成根构建、CUA spike 类型检查及 7 文件 196 项定向回归；CLI／Host help 退出 0。另一次实际 CLI 接入 smoke 发出 1 个方舟 HTTP200 请求，识别合成绿图并完成原生 `terminate`，Runtime succeeded，0 真实桌面动作。

以下四个 M01 样本使用同一既有 Windows 修复候选，该候选另含 PR30 的网页／Context／Monitor 相关本地修复。该运行环境不等同于本 PR 的适配分支；新分支没有重新安装、构建、测试、部署或实跑，不能沿用历史检查作为新提交树通过声明。

M01 目标：从协和患者版进入内分泌科，交付三类门诊位置及位置页日期、两院区地址、未明确的科室院区对应关系，以及新版门诊出诊表路径和精确 URL。仅查询官方公开页面，不登录、不提交或付款。四轮均使用独立临时浏览器和 Plan／Memory，Planning／Memory／Batching 开启、Monitor guidance，200 请求／200 动作、16384 输出、48000 文本／64000 wire、180 秒单请求、30 分钟单轮；保留 Guard、限定范围审批及未知动作不重放。

## M01 运行结果

| 模式／轮次 | HTTP 请求 | 耗时（秒） | Runtime | 业务复核 |
| --- | ---: | ---: | --- | --- |
| disabled 1 | 27，全部 200 | 110.087 | cancelled | 无最终清单；末段无变化后触发人工确认边界 |
| disabled 2 | 48，全部 200 | 193.993 | succeeded | 未通过：否认已观察的位置／日期，并交付旧版 URL |
| Run 级 low 1 | 41，全部 200 | 391.743 | succeeded | 必需清单通过 |
| Run 级 low 2 | 19，全部 200 | 111.910 | succeeded | 必需清单通过 |

耗时包含 Run 启动，不包含结束后的证据回收。费用未知，Runtime token 用量和最终完整清单见[脱敏结果 JSON](../2026-10-20-product-docs/volcengine-ark-agent-plan-2026-10-16.json)。这不是受控 A/B、正式评分或稳定性放行；四轮均无多 GUI 动作 Batch，不能用于评价批处理提速。

### 保留失败与恢复事实

- disabled 第一轮已观察两院区地址，但未到科室位置页和新版出诊表。末两次模型 assessment 为 `no_effect`，观察无变化，Monitor 请求人工确认；宿主取消而不是自动回答或绕过边界。
- disabled 第二轮的真实图像和 Memory 都有 5／5／3 层与 2017.12.09，最终清单却写“未明确／未找到”；只到旧 `visitinfo.html`，并误称没有新版入口。两院区地址正确不等于业务通过，事实丢失根因未定位，也未因本次两轮 low 成功而宣称已修复。
- low 第一轮有一次结束控制与其他工具混用，生产整组拒收、零执行后进行有限 feedback 恢复；两轮各有两次本地参数拒收，随后继续。没有放宽 Guard 或自动重放未知动作。
- 第二轮 low 的 seq212 DOM URL 已前进到新版，截图仍是上一页面；采用后续稳定 seq223 判定实际到达，不仅凭 URL 或 completed receipt。
- 接入 smoke 及各轮安全记录保留 `response_model_mismatch` 诊断，未保存原始返回模型标识，不能声称服务端原始名称与请求名完全相同。

## 业务证据与来源

两轮 low 均交付并经本轮实图复核：门诊楼 5／5 层、国际部门诊 3 层，页面“时间”2017.12.09；东单帅府园一号和西单大木仓胡同41号来自所引官网页脚，明确院区地址不证明内分泌科门诊所属院区；新版 URL 为 `https://www.pumch.cn/news_visitinfo.html`。西单页脚地址与医院位置面板的辟才胡同7号属于不同来源上下文，不把这种差异直接判为幻觉。

公开附件仅保留官网页面内容裁图，裁去浏览器和宿主标记，不包含操作员桌面：

- disabled 第二轮：[已观察却在最终清单否认的位置／日期](../2026-10-20-product-docs/volcengine-ark-evidence-2026-10-16/disabled-2-location.png)。
- low 第一轮：[位置／日期](../2026-10-20-product-docs/volcengine-ark-evidence-2026-10-16/low-1-location.png)、[新版落地](../2026-10-20-product-docs/volcengine-ark-evidence-2026-10-16/low-1-schedule.png)、[页脚地址](../2026-10-20-product-docs/volcengine-ark-evidence-2026-10-16/low-1-addresses.png)。
- low 第二轮：[位置／日期](../2026-10-20-product-docs/volcengine-ark-evidence-2026-10-16/low-2-location.png)、[稳定新版落地](../2026-10-20-product-docs/volcengine-ark-evidence-2026-10-16/low-2-schedule.png)、[页脚地址](../2026-10-20-product-docs/volcengine-ark-evidence-2026-10-16/low-2-addresses.png)。

来源：[患者版](https://www.pumch.cn/patient.html)、[科室位置](https://www.pumch.cn/detail/12497.html)、[医院位置](https://www.pumch.cn/nosocomial.html)、[新版门诊出诊表](https://www.pumch.cn/news_visitinfo.html)。外部真值未输入模型；当前网页读取与各轮截图分别作为独立资料和运行事实，不互相替代。

两个 disabled 和两个 low Run 均完成 close 确认，专用 daemon 正常停止；临时脚本／桥及自动化连接收尾，用户 Windows／PowerShell／Chrome 会话保留。未公开私有配置、key 文件、原轨迹、Provider exchanges、隐藏推理或本机启动器。此次 PR 提交阶段仅排除私人信息，不追加测试、安全审查、依赖或发布验收、CI 查询、字节校验或模型运行；不合并 PR。

## 最新main集成及独立API验收（2026-10-16接续）

以上是原作者提交时点的运行记录；本节是用户另行授权的验证合入工作，不覆盖原有失败、不替换Preview。

- 合入main `e970fea`后保留原PR作者历史；Host GLM/Windows接线测试恢复，Ark deadline测试统一performance与阶段屏障，未消费的默认值常量移除。
- 实回发现缓存字段为 `usage.prompt_tokens_details.cached_tokens`。Provider与安全诊断均映射到已有缓存读计数，官方DeepSeek仍读其平级hit/miss，Qwen保持原嵌套格式；不推断Ark的miss或费用。
- Luna实施、Sol各增量最终GO。TypeScript构建、spike noEmit、Web打包通过；最终完整Vitest **134文件2480/2480**，原评测runner27/27，新API probe离线自测11/11。缓存修正途中一项Ark旧平级fixture失败，已改为真实嵌套格式并保留凭据/请求/阶段/usage断言，再完成全量通过。

| 本次独立真实API | 请求数及结果 | 放行范围 |
| --- | --- | --- |
| 默认旧 `ARK_API_KEY` | 1次，HTTP401，未执行工具 | 不通过；不是网络超时或模型格式问题 |
| 显式末尾新 `HUOSHAN_API_KEY`，composite第一轮 | 5次，Runtime成功；首轮task_create+memory_write_fact+click，hotkey/type分轮 | 严格同轮Batch验收失败，原记录保留 |
| 已激活输入框视觉前提修正后，composite第二轮 | 5次，仍分轮；每请求1.379–3.876秒 | 不将三个分轮动作算作Batch；不为此改产品准入或其他Provider |
| 独立baseline，batch关闭 | 3次，17项合同检查全部通过；每请求3.231/2.512/3.280秒 | 图片、Plan/Memory与click同轮、工具回执、状态持久化、多轮历史、新截图及独立terminate通过 |

API使用实际Ark factory与Runtime，Computer仅接不含隐私的测试PNG及受限无系统输入fixture；因此这是渠道协议验收，**businessTaskOutcome=not_assessed**，不是桌面业务成功、性能优越或成功率结论。请求thinking disabled/输出4096/单请求90秒，每次probe上限12；本次四个probe合计14次请求（含401），没有额外桌面/模型后台实验。

新脚本默认offline，只有显式live才读取指定UTF-8 env；`--key-env`默认ARK，可显式HUOSHAN且不回退。生产CLI/Host仍只读ARK_API_KEY，使用新密钥启动产品时需在私有启动环境将正确key设置为ARK_API_KEY；没有覆盖原env，也没有新增跨渠道fallback。通用复验：

```text
node scripts/provider-ark-conformance.mjs --offline
node scripts/provider-ark-conformance.mjs --offline --scenario baseline
node scripts/provider-ark-conformance.mjs --live --env-file <private-env-file> --key-env HUOSHAN_API_KEY --scenario baseline
```

独立证据保存在被忽略的`runs/ark-conformance/`：401 `live-20261016114951784-b4bbd546`；composite `live-20261016115045197-7add4a11`及`live-20261016115430445-3bfddde7`；baseline `live-baseline-20261016120051545-496011f5`，各自`probe-report.json`。报告只公开工具名、形状、安全错误码与数字usage，不输出密钥、原回答/隐藏推理或私有截图。脚本同轮Batch判据绑定同一响应callId及对应Receipt，并有跨轮负例；baseline单独评分，不覆盖composite失败。当前P2限制是Ark三GUI动作Batch未证实，应以单GUI基线做后续业务实验；不影响既有GLM/Qwen设置。

最新PR36的[远端CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38897851567)已全矩阵通过，API基础通过后已以`282ac6c`合入main；合入后的[main CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/38898351528)也全部通过，详见评测总报告末节。本轮不部署、不改Preview模型默认或服务。用户后续授权的新六题离线runner接入见[操作说明](./life-business-evaluation-2026-10-15.md#新六题方舟对照准备2026-10-16接续)，不把它算作真实业务通过。

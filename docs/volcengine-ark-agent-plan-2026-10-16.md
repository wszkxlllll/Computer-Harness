# 火山方舟 Agent Plan：DeepSeek 适配与 Windows 运行记录

2026-10-16。新增火山方舟独立渠道，保留 DeepSeek 官方渠道。本文记录已完成的接入与实跑，不将历史 Windows 候选的结果冒充本 PR 提交树的新验收。

## 接入范围与前置提交

PR base 为 `codex/runtime-surface-preview-20261003`。该分支尚无 main 已合入的 DeepSeek 共用 Chat Completions 实现，因此本 PR 先带入 `455a219`（官方接入／共用实现）及 `ee0b752`（有限恢复／凭据预检）两条必要前置提交，再加入方舟适配。原作者保留，不整包带入 PR30 的网页、来源绑定、Context 或 Monitor 修复。

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

耗时包含 Run 启动，不包含结束后的证据回收。费用未知，Runtime token 用量和最终完整清单见[脱敏结果 JSON](./volcengine-ark-agent-plan-2026-10-16.json)。这不是受控 A/B、正式评分或稳定性放行；四轮均无多 GUI 动作 Batch，不能用于评价批处理提速。

### 保留失败与恢复事实

- disabled 第一轮已观察两院区地址，但未到科室位置页和新版出诊表。末两次模型 assessment 为 `no_effect`，观察无变化，Monitor 请求人工确认；宿主取消而不是自动回答或绕过边界。
- disabled 第二轮的真实图像和 Memory 都有 5／5／3 层与 2017.12.09，最终清单却写“未明确／未找到”；只到旧 `visitinfo.html`，并误称没有新版入口。两院区地址正确不等于业务通过，事实丢失根因未定位，也未因本次两轮 low 成功而宣称已修复。
- low 第一轮有一次结束控制与其他工具混用，生产整组拒收、零执行后进行有限 feedback 恢复；两轮各有两次本地参数拒收，随后继续。没有放宽 Guard 或自动重放未知动作。
- 第二轮 low 的 seq212 DOM URL 已前进到新版，截图仍是上一页面；采用后续稳定 seq223 判定实际到达，不仅凭 URL 或 completed receipt。
- 接入 smoke 及各轮安全记录保留 `response_model_mismatch` 诊断，未保存原始返回模型标识，不能声称服务端原始名称与请求名完全相同。

## 业务证据与来源

两轮 low 均交付并经本轮实图复核：门诊楼 5／5 层、国际部门诊 3 层，页面“时间”2017.12.09；东单帅府园一号和西单大木仓胡同41号来自所引官网页脚，明确院区地址不证明内分泌科门诊所属院区；新版 URL 为 `https://www.pumch.cn/news_visitinfo.html`。西单页脚地址与医院位置面板的辟才胡同7号属于不同来源上下文，不把这种差异直接判为幻觉。

公开附件仅保留官网页面内容裁图，裁去浏览器和宿主标记，不包含操作员桌面：

- disabled 第二轮：[已观察却在最终清单否认的位置／日期](./volcengine-ark-evidence-2026-10-16/disabled-2-location.png)。
- low 第一轮：[位置／日期](./volcengine-ark-evidence-2026-10-16/low-1-location.png)、[新版落地](./volcengine-ark-evidence-2026-10-16/low-1-schedule.png)、[页脚地址](./volcengine-ark-evidence-2026-10-16/low-1-addresses.png)。
- low 第二轮：[位置／日期](./volcengine-ark-evidence-2026-10-16/low-2-location.png)、[稳定新版落地](./volcengine-ark-evidence-2026-10-16/low-2-schedule.png)、[页脚地址](./volcengine-ark-evidence-2026-10-16/low-2-addresses.png)。

来源：[患者版](https://www.pumch.cn/patient.html)、[科室位置](https://www.pumch.cn/detail/12497.html)、[医院位置](https://www.pumch.cn/nosocomial.html)、[新版门诊出诊表](https://www.pumch.cn/news_visitinfo.html)。外部真值未输入模型；当前网页读取与各轮截图分别作为独立资料和运行事实，不互相替代。

两个 disabled 和两个 low Run 均完成 close 确认，专用 daemon 正常停止；临时脚本／桥及自动化连接收尾，用户 Windows／PowerShell／Chrome 会话保留。未公开私有配置、key 文件、原轨迹、Provider exchanges、隐藏推理或本机启动器。此次 PR 提交阶段仅排除私人信息，不追加测试、安全审查、依赖或发布验收、CI 查询、字节校验或模型运行；不合并 PR。

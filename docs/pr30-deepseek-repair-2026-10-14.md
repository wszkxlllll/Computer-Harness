# PR30 接入修复与回归记录

## 范围与当前状态

用户于2026-10-14授权开始修复。Luna max实施，Sol medium审查；本轮在独立分支 `codex/pr30-deepseek-repair-20261014` 工作，不覆盖原PR30、运行中的Host或Preview。

基底为main `a2757d6`，按来源保留作者移入PR30的 `da6ea55`、`f477f0f`，对应 `246fbf3`、`0be23ca`，提交含cherry-pick来源。冲突保留main凭据脱敏断言；合并不代表已完成验收。依赖通过frozen/offline安装，184项均复用缓存，无锁文件或驱动升级。

## 已确认问题与修复边界

- DeepSeek的协议解析错误全部不可恢复，零工具执行也会直接结束Run。只对白名单响应协议错误启用现有Runtime有限feedback；整组拒绝、不猜工具名、不重放GUI动作，网络、取消、超时及截断保持独立分类。
- 接入必须扩展main模型凭据预检，保留主模型和独立风险模型在Computer/Run分配前的检查、幂等及注入工厂豁免。
- 单目标DOM/hybrid受管浏览器的旧组装限制隐藏坐标click，与Runtime对已知browser Surface的现有许可脱节。只对foreground路径对齐工具供给；不扩大background、unknown或后端能力。
- Batch说明必须消费本轮真实过滤后的tools，不宣称未开放的click/hotkey/type组合；click_element不因此获得Batch权限。
- 不默认启用额外穷尽工具提示或server strict，不扩大共享Chat Completions重构，不改变GLM默认策略或Qwen flat协议。

## 前置诊断证据

前轮真实DeepSeek诊断累计12请求：10个HTTP200、2个无HTTP网络错误。没有复现原未知工具名，但无catalog时增强提示产生过不存在的`e3`引用，因此不能靠工具名约束替代Runtime引用校验。成功HTTP平均1.654秒，已知usage75716 tokens；这是静态截图/模拟回执协议测试，不是任务成功率。原始PR30失败响应的具体未知名称仍缺失，不将新实验冒充原样复现。

## 已完成的实现与离线验收

修复提交为 `6251dcb`（DeepSeek恢复与凭据预检）和 `7021d6b`（click供给与Batch提示一致性）。Luna实施，Sol复核后未发现阻塞级源码问题。保留main已有Host消费者回归，未升级CUA或修改Qwen源码。

- 完整Vitest：134个文件，2419/2419通过；全仓类型检查、Web生产构建及CLI help通过。
- GLM抽取前后同输入对照：历史/坐标/usage、Guard、finish、未知工具与重复ID共5种场景的请求和解析结果一致。没有调用GLM/Qwen付费API。
- Runtime回归覆盖：协议反馈重试、网络/429/503原请求重试、次数预算、Abort/纠正、失效引用零执行；未知工具整组拒绝，不能执行其中看似有效的子集。
- Node脚本测试另计：234项中222通过、2跳过、10项在创建symlink测试fixture时因本机权限 `EPERM` 失败，尚未进入断言。相关源码及测试与main相同；没有关闭测试或修改系统权限。因此只能称Vitest完整通过，不能称所有测试全绿。

## 重试语义

DeepSeek临时网络错误及HTTP 429/5xx由现有Runtime进行有预算的 `same_input` 重试；完整响应中的白名单工具协议错误使用 `feedback`。两者共用请求预算、重试次数及时间窗，Provider没有自己的隐藏重试循环。HTTP鉴权/参数错误、用户取消、请求主动截止、完整body解码失败和不完整finish仍停止。已经执行且结果未知的GUI动作不重放；模型请求可重试不代表GUI动作可重试。

## 真实API验收与网络诊断

第一轮修复版4次API尝试均在响应头前约10.7秒失败，错误为 `DEEPSEEK_NETWORK_ERROR`，正确分类为 `same_input`；没有模型响应、usage或GUI动作，不能计作通过。直接调用Adapter的测试也没有假装Runtime已经完成重试。

无密钥传输检查发现：本机解析API地址得到代理地址，进程存在代理环境变量，但Node默认fetch未使用环境代理；底层报 `UND_ERR_CONNECT_TIMEOUT`。仅对Node24测试进程启用 `--use-env-proxy` 后，159毫秒获得HTTP401，证明传输路径已可达，不代表模型调用已通过。没有修改系统代理、关闭TLS或更改其他Provider默认网络行为。

追加验收使用真实createRun、ToolRegistry、Controller和DeepSeek Adapter，注入FakeComputer；覆盖单动作、task_create+memory_write_fact+动作同轮、上述两种写入+合法输入Batch同轮、模拟回执后独立terminate。Memory使用Run范围，不引用同轮尚未产生的Task ID。每类2次，共8个真实请求；后续合成收尾只用于观察状态投影，不计真实模型成功。

测试脚本经Sol审查并按SHA-256冻结为 `0C4C0A4F941EAC52B27A11D27BD6B4422812DAC8FD8A03DDA4B4ACDF6D374D2A`。无网络离线预演8/8经过实际Controller通过；真实批次结果如下：

| 场景 | HTTP | 满足完整同轮要求 | 实际消费者证据 |
| --- | --- | --- | --- |
| 当前引用click_element | 2/2 | 2/2 | 两次均映射为click，完成FakeComputer动作，无工具拒绝 |
| task_create + memory_write_fact + click_element | 2/2 | 1/2 | 两次Plan/Memory均落事件并进入下一轮Context；一次同时完成click，一次省略click |
| task_create + memory_write_fact + Ctrl+A→type | 2/2 | 0/2 | 两次均只返回Plan/Memory；状态写入及下轮投影成功，未返回Batch，也没有Batch执行/拒绝证据 |
| 模拟完成回执后独立terminate | 2/2 | 1/2 | 一次正确finish；一次stop且无tool_calls、仅普通文本，被Adapter判为可feedback的DEEPSEEK_INVALID_TOOL_CALL |

合计8/8 HTTP200、7/8可解析ModelTurn、4/8满足各自完整组合要求。不能把HTTP成功等同工具组合成功，也不能把“模型没有返回Batch”误报成“Runtime拒绝了Batch”。Planning/Memory共4次组合均产生实际提交事件，后续Context同时包含新Task和新Memory；其中1次有真实API三工具同轮完整执行证据。合法四调用Batch组合目前只有离线执行证据，真实API稳定性未放行。

延迟1.139–3.052秒，平均2.066秒；8个响应合计prompt 97,890、completion 2,268、total 100,158 tokens，cache hit 80,512。该批只测协议，不代表业务任务耗时或成功率。响应均非length、completion最高496 tokens，漏动作不是1024输出预算截断。失败terminate只保留了形状诊断，未保存原始assistant文本，不能补写其具体措辞。

批后离线重编译同构请求，system SHA-256与两次真实Batch请求一致（`739000d15981f3ca503b2f2c6d469271731610c215f7aa542fe4fb75812af21f`）。提示明确允许最多两项Planning/Memory写入后接一个Computer动作或一个Batch，列明Windows `hotkey [CTRL,A]`→type；目录确有这些工具，合成textbox标为focused。未发现禁止该组合的硬性冲突。模型为什么省略动作仍未确定，不能据此说底层不支持，也不能宣称模型稳定支持；没有为此改提示词、自动补动作或继续消费API额度。每Run只有一轮真实请求，后续合成失败收尾意味着本测试不评价模型下一轮会不会继续。

私有证据位于忽略目录 `.tools/deepseek-pr30-capability-2026-10-14T13-40-31-477Z-db284e9b-adcb-45b8-bd01-d3c5ae4e05d4.jsonl`；只存脱敏调用摘要、事件/状态核对及usage，没有Authorization值或完整截图Base64。之前4次网络失败记录保留，不用新成功覆盖旧失败。

## 放行与边界

历史对照：2026-09-15真实GLM API已返回 `task_create → memory_write_fact → click → type`，实际Runtime完成Plan、Memory与两个FakeComputer动作，下一轮terminate成功；迁移后GLM/Qwen Composite也通过。见[历史真实API记录第4.1节](history/2026-09-17-roadmap-consolidation/real-api-conformance-2026-09-15.md)及[统一集成验收](history/2026-09-17-roadmap-consolidation/qwen-flat-regression-and-integration-acceptance-2026-09-15.md)。这是当时版本的真实API协议证据，不是本轮GLM复测或真实桌面效果证明。

可以推进DeepSeek修复的代码集成审查及受控实验；不能宣称DeepSeek的Plan+Memory+Batch同轮输出稳定。同构Context静态检查已完成，下一步建议先隔离测单独Batch，再与Plan/Memory同轮组合比较，并允许观察真实下一轮是否自然继续。对照须保留原失败，记录完整脱敏文本及调用结构；不为凑成功自动补动作、放宽未知引用或重放副作用，也不改变GLM/Qwen策略。本批严格按预定8次结束，没有无界追加请求。

上述测试不是业务任务成功率，也没有验证本轮真实桌面输入、macOS或手机体验。用户确认可以先推送独立修复分支，DeepSeek组合稳定性留待后续优化；不修改原PR30、不合并main、不替换Preview或重启Host。

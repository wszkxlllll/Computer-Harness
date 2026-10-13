# Astra MR 整改执行记录（2026-10-13）

本记录只记本轮实际执行的离线复现、修复、独立检查和未覆盖边界。意见及验收依据为 [综合审查](astra-member-feedback-integrated-review-2026-10-12.md)，队列为 [自主测试修复计划](astra-autonomous-test-repair-plan-2026-10-10.md) 顶部 R1–R6。

## 基线与操作边界

- 开始时 HEAD `6c0af497ddbbf85d8d6ce9a697a2bdd2ed7de801`，产品源码 pin `e7bce7f7792b455d02212c717a34206412002d14`。`git diff --name-only -- packages apps` 为空；仓库已有大量文档改动和未跟踪文档，均不并批暂存或覆盖。
- 本轮先只做离线工作：0 次真实 Provider 请求，0 次 GUI 操作，0 次生产/业务 Host 或 Relay 启动及切版；允许测试套件内短暂回环 HTTP/WSS fixture，结束即销毁，另记实际结果。不读取或输出私有环境变量、令牌。历史 498 次 actual、30 次 unknown 原样保留，不清零。
- macOS 电脑端、Web/Relay 和手机是交付范围；Windows/Linux 原生实现和专项验收排除。实体手机专属项另列。
- R1 由 Luna 单写 Runtime controller/CUA 相关源码及测试，Sol 逐项独检。前序逐项记录由 Sol 单写；综合冻结后已交由 Root 收尾。前序未提交或推送，当前状态见后续综合验证。

## R1：MR-01 + MR-07（离线闭环，真实 Mac 待后续验证）

| 事项 | 本轮证据 |
| --- | --- |
| 源码故障定位 | 基线 `run-controller.ts` 在 completed receipt 后先按 `receipt.message` 图标/换行条件附加 `refreshWindowOptions`，然后才执行正式 `detectNewWindowHandoffCandidates`；`cua-driver-computer.ts` 的 `listWindows` 对已消失 bound peer 仅在 Mac/恢复开关等条件下保留 Surface。此处为静态核查，尚不冒称复现。 |
| 反例先红 | Luna 新增 `RunController` 主循环 + FakeComputer 镜像 fixture，基线 1 failed：completed click 后前置 advisory `listWindows` 模拟清除 bound observation，正式 diff 随后只见 `TRANSIENT_SURFACE_UNKNOWN`；期望 `waiting_window` 实为 `waiting_user`，并有一次已完成 click 与 `user.input.requested`。这是 Runtime 协调用例，尚不算生产 CUA 驱动组合。 |
| 最小修复 | 只改 `run-controller.ts`：`confirm-v1` 下不在正式 diff 前执行附加列窗，让已持久化的 action/tool 收据之后由正式检测建立 handoff boundary；普通 window-switch 首次 seed 仅由 `latestWindowOptions` 状态触发，移除 `receipt.message` 图标/换行判断。未新增协议字段或 Mac 应用特例。 |
| 先绿与独检 | 作者 Runtime 170/170、CUA driver 339/339、两包构建 exit 0。Sol 在首轮冻结树独跑两文件全量 509/509（`node_modules/.bin/vitest run packages/runtime/src/index.test.ts packages/computer-cua/src/cua-driver-computer.test.ts --reporter=dot`），F045 定向 27/27；`pnpm exec tsc -b packages/runtime packages/computer-cua --pretty false` exit 0。最后仅补强 CUA 组合断言，Sol 独跑该定向 1/1；三文件 scoped `git diff --check` exit 0。全树 diff-check 因预存 dirty 文档尾部空行返回 2，不归于 R1 源码。 |
| 边界 | completed/unknown 动作不重放；错误、多候选、陈旧 ref 拒绝；不扩应用特例。Mac 真实诊断与正式业务任务待冻结后另证。 |

最终 R1 源文件 SHA-256：`run-controller.ts` `9ef911d78de6024e915a45a82bc39c95295f555c0fe5b486e2722912508265e8`；`runtime/src/index.test.ts` `970403c9d7fe25ce648f50f050c6aeb5fbad18985e06510fdbd15f0d0406494b`；`computer-cua/src/cua-driver-computer.test.ts` `2513313347e533a1a71aac4e1a3c227b204caab3d94f425442f7772081bc8a9f`。三个文件是本轮 R1 全部产品/测试改动。

生产 `RunController + ProductionCuaDriverComputer` fake driver 组合分别验证：普通 mode 完成关闭动作后，正式 diff 先进入 `waiting_window`，Host 精确列候选/显式 handoff，新 native Surface 观察后 finish；action/tool completed 各一次且序列早于 handoff，driver 最后 activation/capture 指向所选 PID/windowId，原 hotkey 只一次。受限 native recovery fixture 继续验证正式 diff→私有候选列窗；无缺窗而 receipt 仅带旧图标文字时，正式 diff 不产生 handoff，Provider 显式 `list_windows` 仍可达。现有全量测试包含无授权/错误 marker、多候选保护、陈旧 windowRef 和 handoff token 拒绝，以及 unknown action 不自动重放。R1 离线合同闭环；真实 Mac GUI 诊断及正式 Web/Mac 原任务尚未执行，不将 509 个离线用例计为业务通过。

## R2：MR-02（离线闭环，真实 Mac 待后续验证）

Luna 已在 `packages/computer-cua/src/cua-driver-computer.test.ts` 写入配置 Darwin 与 health 缺失、degraded、schema 不符、对应 SDK 版本不符、有效但冲突 win32 的五个离线反例。`pnpm exec vitest run packages/computer-cua/src/cua-driver-computer.test.ts -t 'uses one configured Darwin platform contract'` 基线 **5 failed / 5**：前四项 `session.platform` 为 undefined，冲突项被 health win32 覆盖。记录基线红时尚未修改 R2 产品源码，也未把红用例当修复通过。

本轮审定并实施的合同：`open` 一次确定本 Session 的有效平台，来源优先级为受控 Host/test `options.platform` > schema/对应报告平台 SDK 版本有效的 health 报告 > 宿主回退。health 是报告证据，并非硬性正常输入许可或平台真实性证明。私有 Session 保留 `effective/source/configured/health(status、reportedPlatform、bounded schema/driverVersion)/conflict`，不存任意原始 JSON，也未扩协议或对外 telemetry。后续捕获、快捷键、Mac focus proof、恢复 inventory、批处理与底层派发共用 `current.platform`。仅最终来源非受支持三平台才拒绝。Windows/Linux 原生专项排除，既有兼容CI测试保留。

Luna 将五项反例修绿，并将既有 `non-macos` 与 `unknown-platform` 的焦点证明负例按新合同改写保留；新增生产 `RunController + CuaDriverComputer` 的 Darwin 同一控制输入 click→两行 type 组合，核 Runtime type 不带 elementRef、一次底层 `type_text`、无 `press_key`、无拒绝。作者 CUA driver + SDK 359/359、两包构建 exit 0。Sol 独跑同两文件 359/359（`node_modules/.bin/vitest run packages/computer-cua/src/cua-driver-computer.test.ts packages/computer-cua/src/cua-sdk-platform.test.ts --reporter=dot`）、`pnpm exec tsc -b packages/computer-cua packages/runtime --pretty false` exit 0、两文件 scoped diff-check exit 0。R2 冻结 SHA-256：`cua-driver-computer.ts` `c7bc25532aebf85c755425de4f9519f57e70609e4381416c99736fd785e79cc8`，`cua-driver-computer.test.ts` `d68c4819c1c3f1c842a8a55db96089e6749284a32b33b2d1d8cad0d3c8a2753d`（此测试文件包含先前 R1 组合测试）。离线合同闭环，尚无真实 Mac CUA、业务 Web 或手机验证。

## R3–R6 状态

MR-03、MR-04、MR-05、MR-06、MR-08 已完成离线闭环。新冻结版本的正常 Web/Mac 原卡任务及手机专属验收另计。未验证部分不能把计划视为结果。

### MR-04：Qwen 可选诊断（离线闭环）

`RecordingQwenHttpClient.post` 基线红：作者新增 fake 成功客户端，日志路径指向临时目录内不存在的子目录；`pnpm exec vitest run packages/app-runtime/src/diagnostics/recording-clients.test.ts` 得 1 failed，成功响应因 `appendFile` 的 `ENOENT` 被拒绝。修复将请求字段投影、响应摘要、错误摘要、JSON 序列化与 `appendFile` 全放进不改变 Provider 结果的可选记录边界，Provider 调用仍一次；并把本次请求编号在 await 前固定。fake 成功+日志失败保持同一响应对象，fake Provider 失败+日志失败保持同一原 Error 对象，抛 getter/不可摘要对象也不抢占结果。不修改 GLM 或 Runtime 权威事件持久化。

作者绿 `recording-clients.test.ts` 8/8；Sol 独跑同命令 8/8，文件 scoped diff-check exit 0。冻结 SHA-256：`recording-clients.ts` `c75a8e036d0a45fa16e4b4ecc61838e0f59e18f68fb8c9d291ac96dad2163070`，`recording-clients.test.ts` `1e6e1d02ab752f871e544a961fb6f9239b27496f721c09886be2e523ce361411`。仅离线 fake，无真实 Qwen 请求；日志不可用是可选诊断故障，不等于放宽权威事件写入失败语义。

### MR-03：审批安全字段（离线闭环）

生产者 `approval-preview.ts` 已有可见/脱敏/敏感/陈旧/截断等过滤合同；本轮只把生产者过滤后的 `groundingRef/optionText/optionCharacterCount/optionTextStatus` 四字段加入 `publicRequest` SSE 白名单。初版仅测辅助字段复制，未覆盖同一真实 pending 审批，Sol 退回。修正后以带可信 DOM 选项的真实 Runtime fixture，单个 Provider turn 只发一个 `select_option`，真实到达 `waiting_approval`；同一 requestId 的 `api.getRun()` 与 `api.subscribe()` 在可见和脱敏两种情形下绿。作者临时移除生产 SSE 四字段重跑，visible 情形在 GET/SSE 动作深比较上红：SSE 仅 `operation/kind`；恢复白名单后绿。脱敏项不含 `optionText` 或原始 arguments，秘密合成串不在 GET/SSE 中。两项工具调用若错误地放同一 turn，因 batching off 全拒并直接 finish，已作为 fixture 错误纠正，不算产品红。

另一个 transport-only fixture 将已过滤的 visible/redacted 审批快照和事件通过测试内短暂启动、配对并关闭的本地 Relay/Host WSS→HTTP GET/SSE 链路，同一 requestId 的四字段传输一致；它不冒充生产者到手机的单一真实 Run。Web hook 测试验证 SSE 先到、延迟 GET 后审批预览四字段仍完整；Panel 测试验证脱敏状态只显字符数，不显示即使被错误传入的文本。作者 4 文件 93/93、全局 `pnpm run typecheck` 和目标 scoped diff-check 均通过；Sol 独跑含 MR-04 日志文件共 5 文件 101/101、scoped diff-check 通过。Sol 退回生产 API 文件两处无关缩进差异后，作者精确恢复并重跑真实审批定向 1/1；Sol 复核最终生产 diff 只有四个安全字段，五文件 scoped diff-check exit 0。

MR-03 冻结完整文件 SHA-256：`remote-run-api.ts` `d7521531e4b5b4b3df1c533fbbec65848ac81a13e20583bfca2b453dc219680f`，`remote-run-api.test.ts` `f48b096df2526e4d48eac99e36057bb369914c96fbf43bc0b09aeade0e57ba30`，`relay-roundtrip.test.ts` `4cc9e1ae29a33abc70486b908c04185a90511e89c890118b246a5459ccb41b31`，`useRunFeed.test.tsx` `f0a65205e64728c9569ac46f037631f6f3e7ebdac3314cb98c6f687946239116`，`PendingRequestPanel.test.tsx` `e6e4bf23294eaadde488851c86a65bd14d9ec1a0be2f30d2ddca3279b88691ae`。后续 MR-08 将继续改同一 API 源码/测试，故综合冻结时须另算合并后的文件 SHA。

### MR-05：Qwen 出站工具合同（离线闭环）

先红：在真实 Qwen strict JSON outgoing body 中，统一 Registry 的 `type` 描述被截为 180 字符，结束于 `provide elementRef when available,`，缺少后续 Mac 省略 elementRef、使用原生焦点输入，以及普通单行不使用 elementRef 的约束；native tools 走独立 function tools，原本带完整描述。修复仅在 `qwenToolCatalog` 既有 `list_windows/switch_window` 完整描述例外加入 `type`，描述仍来自同一 Registry；其余较长工具描述保持旧 180 字符，现有 wire token 预算不变，无新全局拒绝阈值。没有另建平台规则或修改 Registry。

作者实际截取 Qwen strict JSON 与 native tools 的出站 body、GLM function tools body；strict 有 `response_format` 无 native `tools`，native 反之，三者均见完整 Mac `type` 约束且无冲突；普通 Registry strict目录 1,748 字符，加入 window-switch opt-in 后 2,379 字符，均成功生成，长自定义说明仍按旧 180 字符。作者 Qwen/GLM/Runtime tools 122/122、三包构建 exit 0。Sol 独跑同三文件 122/122（`node_modules/.bin/vitest run packages/provider-qwen/src/index.test.ts packages/provider-glm/src/index.test.ts packages/runtime/src/computer-tools.test.ts --reporter=dot`）、scoped diff-check exit 0。冻结 SHA-256：`provider-qwen/src/index.ts` `2d850b02bacdb7b7dac25229025c1cc1a0fc1ff5a30390ae2f960b797ef4cea2`，`provider-qwen/src/index.test.ts` `b31003ca776b019835ee28093bbcc8fc97654e2fda9299406c3d807b9f7a03e1`，`provider-glm/src/index.test.ts` `91c5b37f09827c384b2478541a04bac05c7b09da18d5bb668a8b338a65521959`。只有 fake HTTP 记录出站体，0 次真实 Provider 请求；不计真实模型遵循度或业务完成。

### MR-06：来源绑定结果用户呈现（离线闭环）

先红：在已有提交的 Observation 上，新回放 fixture 含已禁用且未选中的来源、两个候选来源、推断、未知及历史捕获时间；原主 summary 输出 `role/source/name/state` 工程摘录、英文 `Inference/Unknown`，缺少时间有效性限定。修复只替换 canonical 主 summary 的确定性渲染：中文说明当时可见文字/辅助说明/选项及状态，捕获时间均注明“仅表示当时记录，尚未证实为当前状态”；多来源提示需复核且系统未自动判一致；推断注明未核实并把提交方理由标为原文；未知的受支持原因用中文。已禁用/未选中、选项列表不完整、来源不可用均明确显示。不改变 `resultEvidence` 结构、原始 excerpt/source/状态/原因或引用绑定，不打开默认关闭的实验，也不凭来源绑定宣称 SKU 语义或现时库存为真。

作者最初 `source-linked-finish.test.ts` 12/12，Sol独审指出协议允许 `optionsTruncated=true` 但没有 `options`，主摘要会漏报。追加独立显示与固定反例后，作者及 Sol 均重跑该文件 13/13，Runtime build/`pnpm exec tsc -b packages/runtime --pretty false` exit 0、scoped diff-check exit 0。最终冻结 SHA-256：`source-linked-finish.ts` `acd7bee1eef833f736b919d001cd378af29a7bdacf374d8070791086e9cea96e`，`source-linked-finish.test.ts` `f674030c9a3692d64b3c29593e524ab8cce38ac7ad67f4df491c1c1ba7f0770a`。这是离线可读性与证据绑定验证，不代表事实真值、最低价、T1 业务或语音实际听感通过。

Root 综合 `pnpm run typecheck` 与 Web build 均 exit 0；`pnpm test` 首轮 118 文件、2,076 项里 2,075 项通过，唯一失败为 `runtime/src/index.test.ts:2993` 的旧英文摘要字面预期（实际已是 MR-06 中文 Unknown 说明），不是控制行为失败，原始日志保存在私有 `MR-review-20261013-private/root-full-test.log`。原 MR-06 Luna 只把该一行改为 `Availability：未知（未在引用的观察中看到相关信息）`，保留暂停/纠正/恢复、Provider 输入仅两次、成功终态及无 invalid-event 断言；作者及 Sol 各独跑 Runtime index 170/170，Sol scoped diff-check clean。共享 R1+MR-06 最终 `runtime/src/index.test.ts` 完整文件 SHA-256 改为 `33d323c40a3ea64548c615ad98ed329a9fafdcde6ed933524de6e833efb75713`，原 R1 段 `970403c...` 是修前阶段 pin。Root 的全量重跑及后续脚本结果尚未回报，不能称总 suite 已绿。

### MR-08：预览期限与清理（离线闭环，真实 Mac 待验证）

独立 Sol 在仓库外 `/private/tmp/mr08-probe/mr08.test.ts` 绝对导入当前 `remote-run-api.ts`，以 fake handoff 后核对 `listWindowHandoffCandidates` 第二次调用停在 gate、忽略传入 signal。显式取消及实际超过 8 秒外层期限后释放 gate 两个反例中，进入后核对时的 signal 均已 aborted，但当前 `previewWindowHandoffCandidate` 仍成功返回并保存有效 32 字符 previewToken（`node_modules/.bin/vitest run --config /private/tmp/mr08-probe/vitest.config.ts`：2 passed，约 8.1 秒）。故障点限定为 `remote-run-api.ts:404–416`：后核对 await 返回后、颁 token 前缺最后一次取消检查；普通入口的图像归一化已检查取消，不能把它算作同一缺陷。fake 忽略 signal 是诊断前提，未证明真实 driver 一定如此。

另 `window-discovery.test.ts` 清理定向为 13 passed / 37 skipped；等待已开始操作和清理是现有有意语义，不能单凭外层 8 秒与内层 20 秒认定取消失效。正式 MR-08 在同一 API 测试文件加了四个 handoff 受控 gate（前清单与后核对清单各覆盖调用方取消、模拟 8 秒期限），以及普通候选在不响应 signal 的捕获未 settle 前保持 Busy 的反例。基线定向 4 failed / 1 passed：前清单取消后仍继续捕获，后核对取消后仍颁新 proof；普通入口的捕获 Busy 已符合合同。此前仓外独立探针另有真实等待超过 8 秒的后核对反例，不能把受控模拟期限称作再次真实等待。

最小生产修复只在普通入口捕获 await 后、handoff 的前清单/捕获/后清单 await 后核验同一个 `captureSignal`，并在捕获与 handoff 清单 helper 的 await 完成或异常后、转换错误前核验 signal。已开始操作仍可等底层清理完成才返回；未 settle 前 `WINDOW_PREVIEW_BUSY` 拒绝第二次预览，settle 后才允许同 requestId/候选的显式重试，取消/期限届满不颁 previewToken。独立验前后同 PID/windowId、过期及旧 token 拒绝、PNG 解码/大小等旧合同仍在全文件回归内。作者目标 5/5、全 `remote-run-api.test.ts` 72/72、全局 typecheck 通过；Sol 独跑 API 72/72 与底层 `window-discovery.test.ts` 50/50、两文件 scoped diff-check exit 0，源码 diff 只含本项各异步边界 signal gate 及 MR-03 四字段。最终合并完整文件 SHA-256：`remote-run-api.ts` `ed02965c6fa6733ff4cfeafe50871d1ee43a36ddc4dc634e57a805048981367e`；`remote-run-api.test.ts` `86a270cc3d02ef923a0f90d96461966a24d5aa2917f20633a3d89298cf2bea87`。

阶段界定：API 新反例覆盖 handoff 前清单、后核对及普通捕获；捕获/重试的原精确身份和归一化边界、底层队列前取消、已开始操作等待及 cleanup/pendingCleanup 由既有 `window-discovery.test.ts` 回归覆盖，本项未改底层队列或清理实现。8 秒是取消与颁证资格期限，不承诺用户响应恰在 8 秒返回；底层最多 20 秒等待及清理可使返回更晚。本轮 fake 忽略 signal 用于验证上层安全 gate，不证明真实 Mac driver 同样忽略；0 次真实预览或业务验收。


## Root 综合冻结与回归（2026-10-13）

Root 实际复算 16 个产品/测试文件，五个关键产品 pin 与 Sol 最终审查一致。执行 `pnpm run typecheck` exit 0、Web `pnpm --filter @computer-harness/web build` exit 0。第一次 `pnpm test` 为 2075 passed / 1 failed，唯一失败是 command inbox 的旧英文摘要预期；未掩盖失败。Luna 仅将该字符串更新为 MR-06 确定性中文摘要，暂停/纠正/请求次数等行为断言保留，Sol 再验 Runtime 170/170。

Root 对修正后的 16 文件重新冻结，只有 `runtime/index.test.ts` 相对首轮冻结变动，SHA 为 `33d323c40a3ea64548c615ad98ed329a9fafdcde6ed933524de6e833efb75713`。完整重跑 `pnpm test` exit 0：Vitest **118 文件、2076/2076**，随后 Node 自检 **72/72**。Web 资产构建通过；这是整体离线回归，不是 Mac/Web 原卡业务通过。

独立日志与带文件/日志 SHA 的收据均在忽略目录 `runs/astra-autonomous-20261010-sol-luna/MR-review-20261013-private/`：首轮 `root-full-test.log`、最终 `root-full-test-final.log`、`root-web-build.log`、`root-final-integration-verification.json`。本轮无真实 Provider 或 GUI、业务 Host/Relay；测试内回环服务器已随套件退出。历史498 actual/30 unknown不变。当前准备精确提交16产品/测试文件及本轮四份计划/审查文档，其他历史 dirty 不并批。

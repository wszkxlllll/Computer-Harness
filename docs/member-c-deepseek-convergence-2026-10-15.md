# DeepSeek Flash M01：导航、来源与收尾修复及两轮 Windows 实跑

## 结论

**两轮均没有最终模型清单，M01 业务未通过。** 本次更新公开对应的来源 URL、导航／焦点反馈、Monitor 生命周期与预算内收尾修复，以及已有 Windows 验证结果；不把本地回归、Memory 笔记或 Runtime 恢复提示当作业务交付。

## 两轮生产运行

两轮都使用生产 DeepSeek Flash、关闭思考、原 M01 Goal；Planning 开启、Memory facts／lexical、Batching same-control-input-v1、Monitor guidance。保留受管 Edge／foreground／hybrid、layered Guard、范围审批、未知动作不重放与 user-input 边界。每轮独立 Run、临时浏览器和 Plan／Fact stores；上限仍为100模型请求、100动作、20分钟，单请求90秒、输出4096、Context文本24000／wire30000。source-linked finish 未强行开启。

| 项目 | 上一轮：Monitor 生命周期补修前 | 本轮：补修后，关闭思考 |
| --- | --- | --- |
| Run ID | d01-convergence-1792033550852-74f5633b-6c87-472a-bd9b-ccfaf5198621 | d01-post-monitor-1792034704809-e02c055f-33cf-4f1a-a988-ab5a98ab6e95 |
| 模型请求 | 9 | 99 |
| Runtime outcome | cancelled | failed |
| 动作 | 7 completed | 79 completed（含9 wait）、7 refused |
| 范围审批 | 0 | 6／6通过 |
| Runtime接纳tokens | 161929 | 2018317 |
| 最终模型清单 | 无 | 无 |
| 实际多GUI Batch | 无 | 无 |

金额均未知。拒收 Provider 响应的 usage 不包含在 Runtime 接纳 usage 中；不以这两个样本评价批处理提速或建立受控 A/B 因果结论。

### 上一轮：9请求后过早接管

DOM 引用已进入内分泌科页。模型随后提交一个失效元素引用，拒绝后以坐标误进科室“荣誉”页；模型已识别走错，准备恢复。

两次 guidance 已进入 Context，但 Monitor 把前一段问题消耗的额度带入新状态，且新观察后仍保留延迟 help：seq88排队 help，seq97新观察／seq98 unknown 后，seq99仍发出 user.input.requested。宿主遵守既有边界取消，没有自动回答或重放未知动作。该 Run 没有最终模型清单。

随后修正：明确 changed 且没有新候选的观察重置上一停滞的 guidance 额度；changed／unknown 转换作废旧候选延迟接管，但保留待发送 guidance。持续同一故障仍能要求人工确认；未知副作用保护不被清除。

### 本轮：99请求均HTTP200，结束工具连续违规

生产 transport 的99次请求全部 `thinking=disabled`、HTTP200，耗时465.649秒；不是 API 超时。Monitor 产生14次 guidance、1次 help 提议，但没有 user.input.requested 或提前接管取消。

实际观察到新版出诊表 `news_visitinfo.html`、科室位置 `detail/12497.html`、医院位置 `nosocomial.html`。Memory记录了正确来源网址、普通／特需门诊5层、国际门诊3层、2017.12.09及两院区地址；这只是模型笔记，未在本轮逐项独立复核，也不是最终交付。后段仍回访已记资料，甚至又把已看过的出诊表路径记为“待确认”，不能宣称循环问题全解。

第98、99请求已各自仅提供一个结束工具，模型仍连续调用未提供工具；生产反馈重试一次后仍为 `DEEPSEEK_UNAVAILABLE_TOOL`，有限重试耗尽，Runtime **failed**。它不是 model_requests 预算耗尽，也没有最终错误 URL 可验收。另一次非JSON工具参数由既有有限反馈恢复，无工具派发。

最后停留在医院位置页东单地址面板。79 completed 包含9 wait；70个非等待完成回执不等于完成业务。7次拒绝为3 DOM_CLICK_BBOX_MISMATCH、2 BROWSER_CHROME_FOCUS_UNCONFIRMED、2 DOM_INPUT_FOCUS_MISMATCH，未绕过。

## 对应生产修复

- **来源 URL 链路**：受管 DOM 采集当前 `pageUrl` 与可见原生链接 `href`，经协议、grounding、trajectory、预算内 Context 保留。保留允许的 query／fragment／转义；敏感或不合规地址整体省略，不按网站特例改写。
- **输入焦点与导航**：Windows 原始 UIA 地址栏缺少 focused／editable，目录标为不完整。安全拒绝保留；消息明确不要原样重试 type，可改选 Goal 范围内当前可见链接。唯一 DOM 引用优先，父导航与独立展开控件分开；以 fresh observation 的实际 URL／页面／菜单状态确认效果，不采用 completed 或 declaredEffect 作为到达证明。
- **重复拒绝反馈**：复用既有 Monitor 阈值、冷却和有界 guidance，不添加全局重复动作封禁，不自动重放 unknown。
- **预算内提前交付**：总请求上限至少3时，最后 `min(3,max(1,floor(limit/10)))` 次请求只提供结束工具；收尾GUI调用组整体拒绝后，仍可使用剩余额度反馈并 finish。1／2请求小预算保留原边界，不增加总预算或默认开关。
- **Monitor 生命周期**：如上所述，避免把上一停滞额度与延迟help带到新观察；持续故障和人工接管边界仍保留。
- **source-linked finish限制**：已有可选渲染器能从已提交 observation／element 原样生成来源 URL，但只渲染元素元数据，不能保留任意截图事实清单。本轮真实来源试验证明 reported 清单会被替换，因此没有为网址可靠性而牺牲原任务完整回答；普通文本最终交付仍需复核。

## 已执行验证（历史结果，不在发布阶段重跑）

- 来源链修复：Windows根／spike／CUA编译通过，最终35项定向回归通过、520未选中。真实受管Edge本地页面验证重定向落地、同名不同链接、历史来源和canonical引用；0模型调用。
- 首次收敛修复：Windows根／spike编译通过；4文件66项定向回归通过、589未选中。
- 真实Edge焦点／替代导航smoke：地址栏type保持拒绝、0文字发送；当前DOM链接completed，fresh observation与截图确认实际到达本地目标页；cleanup通过，0模型调用。
- 脚本化Provider＋真实Windows Computer：20决策预算，第19／20只供terminate；第19的click＋wait整组拒收、0click派发，第20finish成功。这不是DeepSeek业务样本。
- Monitor补修：首次尝试产生3项回归失败，修正后Windows编译通过、2文件42项通过／164未选中。重放已有9请求真实轨迹的生产reducer，原过早接管不再出现；这是语义重放，不是新模型实跑。

这些定向测试互有重叠，**不能相加为独立样本数或全套测试总数**；macOS无本机实机验收。一度出现本地fixture启动等待超时，后来hybrid fixture成功，未确定该偶发启动根因，不宣称已修复所有启动问题。

## 收尾与发布边界

两轮Run清理均确认，专用daemon均正常停止；专用桥、自动化连接与临时脚本收尾，用户Windows／PowerShell／Chrome保留。本次提交只发布生产源码、既有行为回归、本文和脱敏运行摘要；不发布凭据、私有配置、启动器、原轨迹／Provider exchanges、隐藏推理或操作员桌面截图。

发布阶段仅排除凭据和同类私人信息，没有追加测试、安全审查、依赖／权限／发布审计、字节级校验、CI查询、桌面操作或模型调用。未执行merge／auto-merge。

结构化结果见 [脱敏摘要](member-c-deepseek-convergence-2026-10-15.json)。

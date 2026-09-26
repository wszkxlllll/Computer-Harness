# Runtime、事件与安全合同

源码依据：`packages/protocol/src/index.ts`、`packages/runtime/src/contracts.ts` / `run-controller.ts`、`packages/trajectory/src/index.ts`。这是当前合同，不是未来设计愿望。

## 1. 核心对象与生产/消费

| 对象 | 生产者 | 消费者及失效边界 |
| --- | --- | --- |
| ComputerSession | Computer.open，经 Runtime 记录 | Computer 执行/观察、能力投影；关闭或切换窗口后旧 session 不继续授权 |
| ObservationFrame | Computer 返回观察，Runtime 分配引用并保存资产 | Context、Provider 坐标、Action 校验、Grounding；旧引用不能跨 session 复用 |
| ModelTurn | ProviderAdapter | Runtime 分派；当前为 tool_calls / user_input_required / finish |
| ToolCall | Provider 解析后的统一调用 | ToolRegistry/Policy/状态工具或动作工具；ID和参数受校验 |
| ActionIntent | Computer Tool 将合法调用转为动作 | ActionPolicy 和 Computer；非 wait 的 GUI 动作绑定 basedOn 观察 |
| ActionReceipt | Computer Adapter | Runtime 终态、ToolResult、事件；completed 不证明目标或实际文字正确 |
| PlanState / MemoryState | 状态工具 mutation 经事件提交后物化 | Context/查询工具；Run-owned，不是跨 Run 用户画像 |
| RuntimeEvent | Controller 唯一提交路径 | JSONL、纯 reducer、Snapshot、feed、报告；已提交事实不能被UI异常撤销 |
| RunSnapshot | reducer 从事件重建 | TUI/Host/control/后续判断；不是另一份手写权威状态 |

ModelTurn 的 `assistantText` 是说明文字，不是已验证事实。审批来自 Runtime 的风险判断和等待状态，不应把早期计划中的 `approval_required` ModelTurn 分支当成当前协议。Provider `reportedStatus` 也只是其结束声明。

## 2. 主执行链

1. 应用取得环境所有权，创建 Run；Computer open 与首次 observe。
2. 截图存 AssetStore，事件记录 Observation；Context 选择历史/状态/当前观察。
3. Provider 产生 ModelTurn。需要用户输入则等待；finish 进入结束处理；工具调用进入 Registry。
4. 检查工具、参数、权限/audience、能力、预算和调用组合。Planning/Memory走状态路径，Computer工具转 ActionIntent。
5. 动作经过 ActionPolicy，可能放行、审批或拒绝。真正执行前写 started，调用驱动后记录终态，再形成工具回执。
6. 取得新观察，之后才发布基于前后观察的 Monitor transition，进入下一轮。

一轮可包含合法的状态工具和受限动作序列，不代表所有工具都可并行。Control 调用有独立组合边界。Action Batching 仍逐个动作执行/校验/记录/观察，失败或失效就停止后缀；不是任意脚本执行，也不是放任一串坐标开环运行。

## 3. 提交与崩溃语义

Controller 先用 reducer 校验候选事件，再 append 持久化，核对 writer 返回的 Run ID/Event ID/sequence，然后更新快照与内部事件，最后通知外部订阅者。订阅者异常不改写已提交结果。

定位：[Controller 的 commitEvent](../packages/runtime/src/run-controller.ts)、[事件与 reducer](../packages/trajectory/src/index.ts)。Remote 游标和回执定义在 [remote-control](../packages/app-runtime/src/remote-control.ts)，设备/Run 路由在 [remote-run-api](../packages/app-runtime/src/remote-run-api.ts)。

动作先写 `action.execution.started` 再产生副作用；随后写 terminal receipt。若只见 started、没有可确认终态，结果可能是 `outcome_unknown`。**未知副作用默认重新观察/人工核对，不自动重试。** 不能声称这个日志方案实现了与操作系统副作用的原子事务或崩溃后的 exactly-once。

轨迹重建能恢复已记录事实；不等于按日志重放鼠标键盘，也不保证自动续跑。事件序号属于单 Run；RemoteRunApi 的投影游标是另一个序列，不能混用。

## 4. 用户控制与生命周期

Run 状态包括 created、starting、running、waiting_user、waiting_window、waiting_approval、paused、finished。结果包括 succeeded、failed、cancelled、budget_exhausted、outcome_unknown。

- **纠正**：提交用户输入，可能使在途旧模型决策失效；新决策使用更新后的上下文。
- **Pause/Resume**：控制同一活动 Run 的推进，不是从任意崩溃轨迹重启。
- **Abort**：请求停止在途工作并走清理；已经发生的 GUI 副作用不会回滚。
- **审批**：绑定当前待处理 request/call，而非永久同意未来相似动作。过期请求不能批准新动作。
- **窗口等待**：不是普通用户问答；须核验具体候选与新观察，不能复制旧坐标继续。

“命令已接收”与“已经生效”分开。手机失联不代表 Run 自动停止，也不代表已发送命令失败；应先读取状态，不能换一个 ID 重发可能有副作用的请求。

**审批采用请求绑定的人工核对。** Controller 在提出 Computer 审批之前采集新观察，检查会话与视口，并将具体动作及证据写入审批事件。手机经鉴权资源接口展示该截图；批准只消费这一 ToolCall，保留原决策 `basedOn`，用审批帧作为 `executionObservationId`。批准后不再因全图编码字节变化强制重提审批，亦不再对所有键盘动作无条件拒绝。用户纠正/Abort、失效帧、驱动实时窗口/几何保护仍可阻止执行，不自动重放。键盘焦点与截图之后的页面语义变化并未获得机器验证：批准是用户对具体动作及画面的核对，不是稳定焦点或全局安全证明。详见 [实施及验收记录](./mobile-accessible-ui-implementation-2026-09-26.md) 和 [Controller](../packages/runtime/src/run-controller.ts)。历史整图 fingerprint 阻塞证据保留在实机失败报告中。

## 5. 桌面所有权与窗口

同一物理 CUA 桌面使用跨进程 lease，身份为 `cua-local-physical-desktop:<platform>`；换 socket 或窗口不能绕过互斥。Host/TUI/direct CLI 都应使用默认所有权服务。清理未知时标为 pending_cleanup，不因 PID 消失自动释放。

恢复需要检查外部状态，核对 Run、身份哈希和锁状态，交互确认，保存 quarantine 与审计。这里的 hash 是规范化环境身份的 SHA256，不是 lease 文件内容的 hash。不要手动删锁、忽略未知结果或重写旧 Run 为成功。

foreground 窗口首次精确激活后重新核验身份/几何；这不是持续焦点保证。驱动明确“没有发送输入”的前台失配才允许相应交接流程。新窗口检测和前台失配是不同原因：前者可显式忽略附带弹层后重新观察；后者不能这样绕过。

TUI 的 Jev 自动交接仅在显式开启且同时满足以下条件时成立：原因是 foreground_mismatch、候选同进程且是新 surfaced 窗口、与驱动实际报告的 foreground HWND 一致、Jev 给出唯一高置信度选择。`new_window_detected` 路径始终需要用户确认。Host/裸 CLI 不因此自动获得同样能力；最小化恢复、所有弹层可见性、跨应用后台操作也不能从 bring_to_front 推导。实现入口见 [TUI](../apps/cli/src/tui.ts)。

## 6. Guard 的真实安全能力

开启 layered 时，Context 为 Computer schema 增加 `_harnessEffect`；Provider 将其解析为 `ToolCall.declaredEffect`，从真实执行参数剥离。它是模型对立即效果的声明，不可信证据，也不是模型自行审批。

本地路由检查缺失声明、禁用快捷键、高影响 effect、声明/动作矛盾以及有限文本信号：

- 明确高影响声明进入审批；缺声明/禁用动作可拒绝。
- target/summary 扫描高影响关键词；type.text 另有少量凭据、长数字和密码样式检查，**不是任意输入语义扫描**。
- unknown/矛盾等模糊情况才调用可选模型审查；受预算和超时约束，无法审查时回退审批，不是每步多调用一个模型。
- 模型审查中的 type 原文被缩成 textLength；上下文/截图与模型声明仍可能不完整。

Guard 不是 OS capability sandbox，也不能保证识别所有付款、发送、隐私和意图偏离。用户确认不能免除后续参数、观察、目标和预算校验。不要用“关闭 Guard 能跑完”代替修复交互或合同问题。

源码定位：[声明投影/解析](../packages/runtime/src/action-effect-projection.ts)、[Guard 路由与模型审查](../packages/risk-guard/src/index.ts)、[Context 启停投影](../packages/context/src/compiler.ts)。

## 7. 数据与隐私

截图、轨迹和模型上下文可能含隐私，应留在私有 runs 目录，不随 Git/部署包上传。Provider 请求会把选中观察送给配置的服务商；选择整桌面可能包含无关应用。Relay 的 TLS 不等于端到端加密。日志脱敏、资产授权、最小截图范围、密钥独立配置均需在扩展入口保持。

任何新增字段/异步消费者都必须明确提交顺序和清理归属。不要在 action→receipt→observation 事实链中插入另一个可失败的必需 AI 判断；新增旁路策略应有预算、取消、失败隔离和可回退路径。

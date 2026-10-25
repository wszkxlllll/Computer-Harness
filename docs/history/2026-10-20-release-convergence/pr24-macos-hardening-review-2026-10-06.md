# PR #24：macOS 与共享 Runtime 改善审查

审查日期：2026-10-06。结论：方向有价值，可继续开发；目前不建议将整个 PR 直接合入产品分支，也不能据此宣布 macOS 弹窗、保存与跨应用任务已通过。

## 1. 版本与审查范围

- PR：[A 线阶段交付：运行稳定性、手机反馈与 Mac CUA 原生观察 #24](https://github.com/wszkxlllll/Computer-Harness/pull/24)。
- 审查 head：`39a3b2aa9779024b30da50b0d2ef6b952163e2f4`；base：`961a0982ee11bf2f4687756f5184869f197a1b4b`。
- 我们的窗口修复参照：PR #22，`bb17a7b3838858e6fb9b95a2e35bf737f0f828e0`。两条线基于同一个 main，#24 没有包含 #22，不能将另一条线已修问题视为 #24 已修。
- 用户提供的 HTML 审计主要固定于 #22 的旧快照；作为问题清单与正确性原则参考，不作为 #24 的实现或实机证据。
- 本次读取 GitHub PR、固定 Git 对象、共享 TypeScript 改动、macOS 拓扑消费者、隔离 Rust 源码包的合同/交付记录与 T0578；没有逐行终审全部原生 Rust 补丁，也没有在 macOS 重新编译或实机执行。

## 2. 改善了什么

| 关注的问题 | 本轮可确认的改善 | 尚不能推出的结论 |
| --- | --- | --- |
| Host 首轮输入预算拒绝 | GLM 默认拆为 Context 文本 16384、最终 wire 24576；贯穿配置、Context 合同、Provider 准备校验及远程诊断，去掉原来的隐式 4096 余量；Host 默认 reasoning effort 为 low | 是代码层面改善，不证明我们的 Preview 已使用此版本，也不是长任务上下文无限增长的解决方案 |
| 任务状态与用户反馈 | 裸文本不能在 finish 工具暴露时绕过显式终态；末段保留结束请求；本地准备/启动失败及预算耗尽说明未完成；模型格式错误、截断、超时不再统称连接失败 | 不保证每次业务任务都成功，也不证明手机实体扬声器已播报 |
| 看不出控件是否勾选 | `checked: boolean | mixed` 独立于 selected，DOM/UIA 生产、Context 消费及回归覆盖；缺字段不自动解释成未勾选 | 不能仅凭一次勾选状态推断整个业务流程完成 |
| 浏览器不开跨应用也触发窗口接口 | ManagedBrowserComputer 可选方法按授权和生命周期暴露，Runtime 检查实际完整能力组合；缓存回调重新核验 delegate | 应与 #22 的 companion、候选刷新和返回浏览器逻辑一起验收，不能整文件覆盖 |
| macOS 多行误走 Windows UIA | 分支按平台区分；绑定前台 macOS 窗口原文一次 type_text，不自行拆行或补 Enter；未知派发不重试 | 新增测试主要是模拟驱动，完整中文输入、保存、关闭重开尚未完成 |
| macOS 缺少目标级原生证据 | 增加严格目标拓扑消费者和来源固定、可重放的隔离 CUA 原生源码包；T0578 报告同进程新 TextEdit 窗口绑定、两次真实 PNG、关闭观察会话/释放 | 这是只读正控。input/run/global/activation 均为 false，不等于生产 Harness 能编辑、操作保存 sheet 或跨应用完成任务 |

macOS 坐标重复缩放的调查及浏览器短输入成功材料是累计证据；不能把所有历史改进都算成本 PR 相对 main 新增的修复，也不能把合成浏览器局部通过当作真实生活任务稳定通过。T1 曾完整成功一次（122.053 秒、13 请求），独立重复仍耗尽请求预算；T2/T3 未完整通过。

## 3. 合入前问题与优先级

### P1-A：普通 macOS CUA 被强制要求提供私有拓扑 RPC

固定源码：`packages/computer-cua/src/cua-driver-computer.ts:1088,2319`；`packages/computer-cua/src/macos-target-topology.ts`。

开启动作后的新窗口检查、绑定 foreground 窗口时，darwin 分支直接调用 `get_target_window_topology_capabilities` / `get_target_window_topology`。消费端要求固定 producer/source/schema；已安装 stock CUA 没有这份隔离补丁时，会得到 unsupported，失效当前 Surface，并拒绝动作。源码包 README 同时明确不会自动安装或替换 stock Driver。

本次独立离线调用真实消费者，模拟 stock 返回 unknown tool：只调用 capabilities 一次，即以 unsupported 失败，无 fallback。单测证明了拒绝行为，不能证明正常安装可用。

处理原则：将这条强化拓扑路线作为显式实验能力协商，不按 darwin 自动变为所有动作的先决条件。stock 后端保留已成立的基础精确窗口操作；确实需要但无法证明的 child 关系才进入接管边界。不能把缺少增强能力解释成当前普通窗口必然不安全。发布前须有生产 Run 在 stock 和增强 Driver 两种配置下的正控。

### P1-B：共享路径重新引入全局 inventory 完整性硬门槛

固定源码：`packages/computer-cua/src/cua-driver-computer.ts:2346–2351`。

这不是仅 macOS 的改动：非 darwin 路径在派发前发现 `!inventory.complete` 或 truncated 就拒绝全部动作。重复/坏行又在 window-contract 中降低完整性。检测到坏行本身合理，但不能自动推出精确绑定目标也不可操作。

这与我们 #22 的收敛原则冲突：全局清单 partial 不得单独阻断已有精确目标；它限制的是“从全局缺失推断 child 消失/所有权”等结论。否则 Windows/Linux 可能因无关窗口的坏行或上游缺少 complete 字段再次无法点击/输入。

处理原则：区分精确目标的输入准入与自动 child 关系准入。保留 partial 标记，不伪造 complete；用当前目标身份、几何与前台证据决定已绑定操作。只在所需关系证据不足时禁用自动切换或要求显式选择，不恢复旧的全桌面硬封锁。

### P1-C：macOS 真正的弹窗仍终止任务，而不是进入可选择的恢复路径

固定源码：`packages/computer-cua/src/cua-driver-computer.ts:1183–1200`；`packages/runtime/src/run-controller.ts:2347–2355`。

当前新 CG window 一律抛 WINDOW_TOPOLOGY_UNKNOWN；dialog 或多个 overlay 抛 TRANSIENT_SURFACE_UNKNOWN，随后失效当前 Surface。方法没有返回这些对象的可选择候选，Runtime 只能接住异常走失败/清理。错误文字说 manual handling，并不意味着手机已产生接管请求。

同时 parser 要求全层 CG before/after 完全相同，post diff 又把任何新 CGID 视为 unsupported；无关浮层/其他应用新窗也可进入拒绝链。目标级证据仍被桌面整体稳定性绑住，存在过严风险。

不能声称该 PR 解决了我们关注的“保存/字体弹窗识别后继续、关闭后回父窗”。应把不能自动准入的新对象保留为候选，复用明确的手动/显式切换通道；不凭标题、same-PID 强认父子，也不重新执行已完成动作。需要实际 Harness Run 证据：正文 → 保存/字体弹窗 → 继续操作 → 返回正文 → 下一任务可启动。

### P1-D：与 #22 的输入和恢复修复存在语义回退风险

两个 PR 的 apps/packages 有 25 个重叠改动文件，涵盖 adapter、Runtime、Context、Computer wrapper、手机与语音；不是只解决 Git 文本冲突即可。

#24 仍保留 `preValueEmpty` 和非空多行拒绝（adapter:2548），工具说明仍称 Windows full-value replacement；#22 已移除这条硬拒绝并明确 Driver 的末尾追加语义，且 grounding=off 下有私有精确目标取证。#24 相对旧 main 没有删除 #22——它没有包含 #22——但合并时用 #24 整文件替换会回退修复。

取舍：保留 #24 的 macOS 原文路线，保留 #22 的 Windows 私有取证、真实追加说明及不重放恢复；按平台核验 Linux 普通输入，不让 macOS 的支持限制变成其他平台的普遍拒绝。两种输入不能被描述为同一种替换语义。

### P2：原生实验包需收敛交付，不应替代通用 backend

native 包约 1.3 万行增量中包含 patch 与源码镜像的重复呈现，不能直接解读成 1.3 万行独立运行逻辑；但 564 行 README 叠加大量历史轮次，交接成本仍偏高。

拓扑合同留在 CUA Adapter 私有层，没有把 TextEdit、AX/CG token 塞入公共 Observation，方向正确。不过 bootstrap/发现/观察会话有固定 TextEdit 范围，属于受控实验设施，不是适用于所有应用的生产能力。下一轮优先接已有 Computer 生命周期，明确当前入口与安装/启用方式，再归档历史，禁止让“为拿证据开发的工具”无限演化成第二个 Runtime。

## 4. 旧 HTML 审计哪些仍成立

| 旧结论 | 本次判定 |
| --- | --- |
| 稳定 Session、Surface generation、旧引用失效应保留 | 仍成立；#24 基本保持原抽象，不要求推翻 |
| unknown 不自动重放，清理不能改写历史副作用 | 仍成立；本轮也在保留完成回执和失败事实 |
| Windows CurrentValue 读取失败当空串的上游风险 | #24 不修改该 Rust Windows 分支，也没有补对应旧值保留证据；不能算已修。此次未重查最新上游，因此不更新 HTML 的“最新版本”判断 |
| verify_state 最终抓图错误被吞、satisfied 不保证有图 | #24 未证明关闭该上游风险；macOS 两图正控不解决 Windows 候选截图链 |
| modal 是串行交互策略，不自动证明 OS 父窗禁用 | 仍需明确；新 macOS overlay 仍填 modal，不能泛化所有 owned 窗口为强模态 |
| 手机候选预览失败、普通 asset 错误包装是两条链路 | 仍应分开；#24 相对 main 没有修改候选 preview 捕获及 Host→connector→Relay asset 错误传递，未提供本机真实候选预览成功证据 |
| 完整输出、保存重开和取消后释放必须实测 | 仍未完成；T0578 关闭的是观察会话，不是文稿保存/重开 |

HTML 对版本/部署/PR 状态的时间戳属于历史，不能原样继续称“最新”；本文不升级 CUA、不推定本机已加载新 Driver。

## 5. 验证、接口判断与下一步

实际独立验证：GitHub 最终 CI run `37336228461` 中 Windows、macOS、Ubuntu Node 22.13、Ubuntu Node 24.19 及 ci-required 成功。此前 cancelled 的 run 不称作当前 CI 失败。CI 不编译此 Rust overlay，不证明真实弹窗可操作。

本地只执行四项小型离线检查，直接读取 PR 固定版本并内存转译：Host 默认双预算、默认 low、非法预算顺序拒绝、stock 缺 RPC 的拒绝行为，4/4 通过。没有执行全量本地测试、模型 API、桌面操作、服务重启或部署；1663 Vitest、209 原生去重测试和两张 PNG 是队友交付/测试记录，不是本次独立实机结果。

接口抽象：基本保持。新增 checked 有 producer/consumer；maxWireInputTokens 贯穿 config/compiler/GLM/事件及远程投影；requestBudget 是可选 Runtime Policy 合同。Mac 原生私有类型留在 Computer 实现内，Provider/Planning/Memory 不需要理解 AX/CG。主要问题是能力协商和过严策略，不是已经破坏公共协议。

建议执行顺序：

1. 先解决 P1-A/B：增强能力显式启用，stock 正控；不要把全局 partial 变成已绑定窗口不可执行。
2. 与 #22 按行为整合 P1-D，而非按文件保留单方；预算/终态/checked 修复可先取，原生实验包暂不作为默认能力。
3. 修 P1-C 的真实候选/接管通道，补菜单、保存 sheet、字体 dialog、正常 peer switch、关闭返回及取消释放测试。
4. Mac 通过生产 Run 完成中文输入、保存、关闭重开和内容核对；再做浏览器→编辑器→浏览器。Windows 复跑现有 Notepad/WPS 和携程→记事本，Linux 保留平台验收。
5. 最后才放行整个 PR 合并与产品部署；实际成功的范围分项报告，不把四平台 CI 绿称为三平台跨窗口已验收。

本次仅新增审查文档和入口链接，未改业务代码、合并、评论或推送 PR。

## 6. 两边下一步的具体取舍（用户反馈后收敛）

不要另起“先改全屏架构”的主线，也不要要求两边先各自验收全部功能再整合。使用 #22 作为产品集成起点，逐项吸收 #24；这是沿用既有 Windows 修复的整合顺序，不表示 #22 已完成实机验收。

### 6.1 我们这边负责共享整合与 Windows 阻塞

1. **先取双预算及真实失败反馈**：吸收 `glm-output-budget.ts`、Host config、Context/Runtime 合同、GLM 校验和远程预算投影。保留 #22 当前控制面配置及 Provider annotation/历史投影。验收用实际手机 Host 创建新 Run，确认不再在首张观察后以 12902 > 8000 结束，而是实际发出模型请求；不能只跑 parse 单测。双预算修正已能消除该已知 8000 配置矛盾，不承诺所有长任务不会超限。
2. **再修候选展示与预览的具体链路**：当前 `filterPresentableWindowCandidates` 实际保留所有候选，只按重复/缺标签设置 previewRequired；Web 又要求这类候选图片成功加载后才能选择。因此大量相同标签 + 捕获失败会形成真实死路。先沿用户请求检查 POST 到 capture 的阶段、时限、图片体积、身份及 cleanup，不先延长超时或删验证。共享投影负责区分/分组，Adapter 负责返回与本次交接有关的候选；多个真实同名窗口不按标题合并成一个。缺少可操作/相关证据的辅助项不要伪装成推荐目标。验收必须在真实手机列表上看见可区分目标并选成功，而不是 mock 返回 base64 即通过。
3. **沿现有 Windows 路径完成保存与返回**：保留私有多行绑定、末尾追加、精确 activation、unknown 不重放及新观察恢复。对实际保存/字体对话框核对 identity/owner/foreground 与画面；只有具体所需证据不足才要求接管，不能因为全局 partial 拒绝当前可操作窗口。先用真实 Harness 完成记事本保存闭环，再跑携程查询→记事本→保存。WPS 作为后续变体验证，不把应用特例写入准入。

本轮不新增 Surface 类型、不重做 planning/memory，也不把 mac 原生实验包自动安装到产品。每项修复留一份真实请求/Run 的前后证据；无证据时保留原因未知，不以新分层替代归因。

### 6.2 发给 mac 队友的可执行反馈

> 请在 #24 上先完成以下整改，之后将平台改动接入统一集成版本，不另建生产 Runtime。
>
> 1. 合并“接口转换”和“能力匹配”为一个任务：`macos-target-topology.ts` 是 Adapter 私有证据源；在 open/初始化阶段决定该 Run 是否可使用增强拓扑，不在每步按 darwin 强制要求私有 RPC。stock 不支持时不能将基础精确窗口操作失效；缺少足够关系证据时，只禁用对应自动 child 准入，保留真实可用的显式选择/接管。实际查询失败与接口不支持要分开，不能将失败后的旧图继续用于输入。
> 2. 修改 `cua-driver-computer.ts` 的非 darwin preflight：不要将 !inventory.complete 作为全部动作拒绝条件。与我们 #22 保留同一条规则：partial 限制关系/消失推断，不自动否定精确目标。该共享部分由集成方最终整合，避免两边同时重写。
> 3. 修改 `detectMacosTopologyChange`：新 CGID 不等于当前任务的阻塞弹窗，不应一概失效目标；可疑对象先成为候选。需要用户选择时，实际返回既有候选/请求，让手机能够接管；只写 manual handling 然后抛异常不算实现。普通 dialog/sheet 是任务必经对象，不能无限停留在 unsupported。身份确实改变或派发结果未知仍不得重放。
> 4. 保留原生对象/token 在 Adapter 内，继续复用既有 Surface push/pop、Observation、Receipt、list/switch/handoff。只读 new-TextEdit session 是验证设施，不要求其 32-app/128-root/唯一新 AX root 等创建验证条件成为所有用户窗口操作的先决条件。
> 5. 本轮必须用真实 Harness Run 验收：普通 stock 后端基础窗口任务可执行；增强后端中文多行→保存 sheet→文件落盘→关闭重开内容一致；随后浏览器→TextEdit→浏览器往返。记录每次实际加载的 Driver 与集成 commit。T0578 两图不能替代这些结果。
> 6. 回复拟修改文件和上面每条的现状即可；不再扩展原生探针、全局桌面模型或增加新的动作工具。不能实现的具体步骤请明确标出，不笼统回复“安全拒绝符合预期”。

### 6.3 统一放行与退出条件

- 首个 Demo 固定：手机发起查票 → 浏览器获取信息 → 显式切编辑器 → 写入 → 保存对话框 → 输出文件 → 手机交付具体结果；不付款、不发送、不修改真实用户文档。平台分别用 Notepad/TextEdit，应用不同但 Run/控制面合同相同。
- 共享整合先做必要离线回归；首次真实失败就按动作、截图、Receipt、候选及手机响应定位。没有新的定位证据，不再堆规则重跑。
- 两边使用同一集成代码版本，平台必要参数不同；通过一次再独立重复一次。一次只能算成功样本，不叫稳定。
- 如果 target-bound popup 捕获在实际 Driver 上不可用，要记录准确调用失败并评估上游接口替代或用户明确授权的 desktop 运行方式；不能先宣称全屏会解决全部问题，也不能静默扩大截图范围。
- 未验证的 mac 原生增强可以从默认发布中隔离；但不能将完整跨 APP Demo 的输入/保存/恢复缺口藏在“增强可选”后面。

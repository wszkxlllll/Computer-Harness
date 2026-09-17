# CUA 实际使用、扩展空间与版本升级审计

日期：2026-09-16  
文档角色：审计 / 上游调研 / 验证方案  
状态：当前建议；上游能力未在本机重新验收  
当前入口：[审计总览](audit-2026-09-16-overview.md) → Stage 6  
基线：Harness `39ff27f`，依赖 `@trycua/cua-driver@0.22.2`  
范围：本地CUA Adapter、固定tag合同、窗口/元素/后台输入、准确性/延迟和升级；不在本轮安装或操控桌面。

## 1. 我们实际使用了多少能力

`packages/computer-cua/src/cua-driver-computer.ts`：

- open：连接指定daemon socket，startSession，再get_screen_size；能力硬编码为screenshot/pointer/keyboard=true、accessibility=false。
- observe：get_desktop_state写PNG到临时截图目录，读取文件字节，Runtime再写进AssetStore；要求尺寸等于open时的主屏幕viewport。
- execute：所有输入target固定primary desktop，delivery固定foreground；click/count/right/type_text/press_key/hotkey/scroll/drag；wait由Node定时器完成。
- 引用：Adapter的Map只保存ObservationId→sessionId，latestObservationId只记录本地调用顺序；没有CUA snapshot token、窗口身份或焦点证据。
- close：endSession、可能等待后重试、shutdown、destroy。没有自动重放GUI动作，这是应保留的。

所以用户所说“像Python脚本”的实际原因是只暴露了截图+全局输入这个子集，不是TypeScript或Python的问题。已有daemon隔离、生命周期、统一Receipt、未知副作用、资产/事件记录仍有价值。换语言不会自动获得窗口定向和元素稳定性。

## 2. Adapter自身需要先改进的地方

| 问题 | 代码依据/影响 | 建议 |
|---|---|---|
| 能力静态声明 | open不查询daemon版本/工具/权限，SDK安装版本不等于运行daemon版本 | 启动只读discovery，记录实际版本与合同；未知功能关闭而非猜测 |
| 观察ID≠桌面稳定 | observations仅存sessionId | 独立保存目标/快照引用，动作前验证当前执行证据；不以ID相等证明画面未变 |
| 固定viewport | 尺寸变化直接observe失败 | 首版给出明确显示变化诊断并重新开session；后续可做显式geometry更新，禁止静默沿用旧坐标 |
| 多一次磁盘往返 | Driver先写PNG，readFile后AssetStore再次写；fallback读尺寸可能再读一次文件 | 对比SDK images内存结果与file路径；由AssetStore统一留档；先量化再替换 |
| 丢弃动作结构化信息 | execute主要消费isError/degraded/text | 保存经过标准化的driver诊断，如refusal/effect/route；不把confirmed当业务目标成功 |
| “有界close”并非总时长有界 | cleanupWaitMs只限制两次调用间的sleep；endSession/shutdown没有总deadline | 诊断并隔离失联session；自有daemon和外部daemon区分所有权，不杀共享进程、不重试未知动作 |
| 长Run引用增长 | Map每次observe追加、只在close清理 | 保留当前执行与必要decision引用，显式pin/release；Batch原始decision引用不能提前删除 |
| typed SDK未充分使用 | 大量callTool(name,JSON)由本地字符串手写 | 与选定版本typed SDK比较，先为高价值读/目标操作接typed方法；无需全量机械替换 |

其中“动作结构化信息被丢弃”不是要求重建之前删除的无人维护effect状态。先确定生产者、消费者：由Adapter解析、错误路由/诊断消费、事件保存；没有消费者的字段仍不加入协议。

当前Adapter只用公共session label创建session，没有在这里配置24小时授权。其他OpenClaw实验改过的TTL不能自动套用到本Harness。SDK README提到的五分钟是implicit session闲置行为，不能据此断言本项目命名session必定五分钟失效。升级探针需分别验证命名session闲置、审批等待、显式end、daemon重启和断连；延长TTL不能使旧窗口/元素引用重新有效。

## 3. 是否升级：建议验证0.28.2，再切默认

### 3.1 已核实的版本信息

2026-09-16查询npm registry，`latest=0.28.2`。GitHub release `cua-driver-rs-v0.28.2` 发布时间为2026-09-15 21:55:39 UTC。官方说明GitHub的pre-release标记用于monorepo的Latest指针管理，普通SemVer仍属于稳定渠道。应按产品tag/npm稳定标签判断，不用仓库通用Latest接口猜版本。[0.28.2 Release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.2)。

这是“最新稳定发布”，不代表本项目已验证。当前本机运行daemon版本本轮未连接查询，不能从package.json推断它一定是0.22.2。

### 3.2 固定tag合同对比（本次实际读取）

| 项目 | 0.22.2 | 0.28.2 | 对本项目意义 |
|---|---|---|---|
| portable contract_version | 0.7.0 | 0.8.0 | 升级有合同变化，需按新schema验收 |
| manifest工具数 | 25 | 28 | 新增list_apps/list_windows/get_window_state进入portable manifest；不等于老平台完全没有这些工具 |
| click | x/y必填，兼容旧target/scope | target/delivery必填，坐标或element_token二选一 | 当前desktop输入已显式target/delivery，有兼容基础；元素操作需新映射 |
| get_desktop_state | 文件/内存截图 | 读取到的manifest项相同 | 原始截图基线可直接作为升级第一关 |
| type_text / verify_state | manifest存在 | 本次比较manifest项相同 | 不是所有扩展都必须等升级才有，实际平台合同仍需探测 |
| start_session | 公共命名session | input大体相同，输出合同有变化 | 不能盲转旧返回类型/假设 |

来源：[0.22.2 manifest](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/contract/manifest.json)、[0.28.2 manifest](https://github.com/trycua/cua/blob/cua-driver-rs-v0.28.2/libs/cua-driver/contract/manifest.json)。Portable manifest只描述可移植子集，平台工具列表可以更丰富。

### 3.3 相关版本演进，不把全部新特性都接入

- 0.24.0：window state可跳过a11y树并返回capture metadata；daemon关闭清理修正。[Release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.24.0)
- 0.25.0：Windows UIA健康检查和不可用click处理修正；远程envelope能力本轮不是优先项。[Release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.25.0)
- 0.26.0：typed native-window SDK流，适合从字符串callTool逐步走向类型约束。[Release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.26.0)
- 0.28.1：前台验证排除cursor overlay、encoder/shutdown诊断等。[Release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.1)
- 0.28.2：桌面snapshot identity和payload ownership统一，修旧token落到替换元素的竞态。[PR #3616](https://github.com/trycua/cua/pull/3616)

#3616不是“截图所有过期问题已经解决”：其描述明确不覆盖Windows geometry freshness、general SDK cancellation draining和browser迁移；上游延迟实验基本持平，不能引用它声称性能明显提高。新版本仍需本项目的焦点、DPI和审批验证。

## 4. 值得接入的功能：先定向，后丰富

### 4.1 第一优先：选择确切应用和窗口

目标是让Agent知道在控制哪个应用/窗口，减少误操作TUI和跨窗口焦点丢失。先接只读list_apps/list_windows和window observation，再接window-local pixel action。窗口截图比整个桌面更聚焦，也减少把无关个人窗口发给Provider。

窗口截图和桌面截图坐标不能混用。必须区分：物理屏幕坐标、窗口截图像素、Provider缩放/归一化坐标；转换放在对应Provider/Computer Adapter，Runtime的Observation记录当前空间及target引用。拖拽起终点也必须同一明确空间。窗口移动/缩放或重新创建时旧引用失效。

建议Host给应用窗口分配Harness不透明targetRef，CUA内部映射PID/窗口ID及generation；不要让Provider用自己的猜测PID直接执行。只读发现工具可分类side，但所有窗口修改/输入必须走统一动作准入。

### 4.2 第二优先：元素定位与定向输入

最新工具文档支持window state返回截图与结构化元素、快照绑定element token。推荐将少量可交互元素投影给模型，模型选Harness elementRef，Adapter映射CUA token；新快照替换引用后拒绝旧token。限制树深/元素数，避免AX树比图片历史更膨胀。

不要立即替换所有click：画布、游戏、自绘控件常需像素；缺少Accessibility不应导致普通像素任务完全不可运行。set_value若接入，应成为含明确语义的新动作/工具，而不是偷偷把type改成覆盖整框。两者对事件触发、追加/替换和应用行为不同。

上述能力和background delivery的输入合同见[Windows工具文档](https://cua.ai/docs/reference/cua-driver/mcp-tools-windows)与[Interface Contracts](https://cua.ai/docs/reference/cua-driver/contracts)。当前网页为新版本说明，不反推0.22.2所有平台都已支持。

### 4.3 第三优先：受控后台执行

在可定向窗口内优先验证后台路径，获得明确unsupported/refused后才考虑前台路径。UIA/后台能力不是“永不抢焦点”的跨应用保证。不要收到timeout就重试前台：只有能证明未产生副作用的拒绝才可重试，unknown仍停止。

同一目标窗口后台可用时，用户在终端互动才不必频繁抢桌面；但同时修改同一文档仍会竞争。需要应用层控制权和目标所有权，而不是多个Agent任意并行。

### 4.4 局部状态验证，不重建逐步VLM Verifier

可评估verify_state的少量确定predicate（字段值/元素状态/窗口状态）用于“输入是否投递/目标是否仍有效”。结果区分满足、不满足、未知；不升级为“订单已业务完成”。只在明确消费场景调用，例如审批恢复、后台fallback判断；不为每个GUI步骤追加全量检查。

来源：[Verify a desktop action](https://cua.ai/docs/how-to-guides/driver/verify-a-desktop-action)。

### 4.5 Browser和远程能力延后

上游已有浏览器语义操作，但依赖确切绑定且有浏览器/平台限制，不是所有网页通用后台控制。OSWorld Firefox任务不能据此假定可切CDP；增加DOM工具必须是新实验配置。远程Fleet、历史服务和更多平台可作为未来Backend，不是本机稳定性的前置条件。[Known Limits](https://cua.ai/docs/reference/cua-driver/limits)、[Platform Support](https://cua.ai/docs/reference/cua-driver/platform-support)。

## 5. 协议如何扩展，避免把CUA复制进核心

建议逐阶段增加下面的最小合同，均为拟议而非已存在：

| 数据 | 生产者 → 消费者 | 保存和失效 |
|---|---|---|
| TargetRef + target kind | Computer发现 → 观察、动作、Guard/UI | Run-local；窗口重建/driver generation变化后失效 |
| Observation target/geometry | Computer.observe → Provider投影与动作校验 | 随frame落盘；移动/尺度变化需新证据 |
| ElementRef与role/label/bounds | Computer观察 → 模型选工具、准入 | frame-bound；CUA token在Adapter私有表 |
| 能力profile | 启动discovery → Registry和校验 | Run冻结，失效后停止或重开 |
| 标准化driver diagnostics | execute → 失败路由/事件/UI | 随Receipt；无消费用途的上游字段不纳入 |

Action addressing建议采用明确联合（pixel target+point / element ref），不要积累彼此可冲突的可选x/y/pid/token字段。只为已实现能力注册新工具。Provider仍读取Registry；GLM native和Qwen flat都要测试元素工具参数，不能默认只有computer adapter要变。

OSWorld保留desktop pixel profile；不支持的window/element工具不注册、不伪造。Context和Guard读取可选证据时必须处理unsupported，不能把缺失解释成“没有风险”。

## 6. 准确性验证：截图尺寸相同不代表截全

吸取历史截图问题：get_screen_size与图片尺寸一致，只是必要条件；如果两个接口都取错DPI坐标，仍可能一致但截取不全。

建议受控窗口/桌面四角放不同标记，在100%/125%/150%/200%缩放中验证四角都在图里、点击落点一致；每轮保存原图尺寸、坐标来源、变换参数和结果，不只肉眼看宽高。加入窗口移动、缩放、边框/标题栏、遮挡、弹窗、TUI接管和显示器变化。多屏首版只宣称已测primary，其他屏明确拒绝。

元素路径测试：同名控件、列表重排、下一次snapshot、窗口重启复用ID、unsupported AX和像素fallback。token能防旧引用，不等于控件业务语义永远相同；仍需核对目标上下文。

## 7. 降延迟：按链路测，先不减少观测保证

本轮没有测本机新版本延迟，因此以下是优化假设：

1. 对同一受控应用拆出capture、编码/落盘、Provider请求、动作投递、post-observe耗时，报告warm/cold、median/p95和失败，不混合网络与Driver成本。
2. 比较full desktop、window screenshot、window screenshot+bounded AX、AX-only四种读取。只有Context支持无图观察后才在正式循环用AX-only；现有ObservationCapture要求screenshot，不能直接返回空图片。
3. 比较file PNG与SDK memory image；避免Driver临时文件+AssetStore重复I/O。不要为了快关闭证据保存。
4. 比较图片长边/编码策略，但同步viewport变换与点击回归；不能只压图不改坐标。缓存按asset/hash并限容量，不能返回旧截图冒充当前观察。
5. 等待可用性尽量用有上限的本地条件检查，取代盲目长sleep；仍保留timeout与unknown。
6. Batch继续每primitive执行/记录/观察；优先减少模型round trip。不要为了优化CUA把整批动作丢给driver并失去逐步Abort和Receipt。

建议先做20次以上成对暖态和独立冷启动样本的Driver微基准，超过预先约定的10% p95回退须解释；这只是工程候选门槛，不是已经统计显著。模型任务收益另测，不用单次快请求证明升级有效。

## 8. 升级与验收步骤

1. 保留0.22.2 lockfile/旧daemon来源和baseline；新版本在独立环境或worktree测试，不覆盖实验runner。
2. 固定0.28.2 SDK、native包、daemon与校验和；检查workspace的minimumReleaseAgeExclude旧版本条目，不能直接全局放宽安装策略。
3. 从新daemon读取version/工具合同/权限；验证typed返回、generic callTool、错误tag、Abort/shutdown。不以SDK编译通过代替daemon兼容。
4. 原有主屏幕工具零功能变化验收：截图、click/double/right、type/hotkey、scroll/drag、wait、session关闭；中文/组合键/剪贴板副作用分别记录。
5. 生命周期注入：observe失联、execute响应前断连、审批久等、daemon重启、close挂起；记录unknown，绝不自动重试潜在副作用。
6. 通过后才换默认版本；窗口发现、窗口pixel、元素输入分别单独提交和fixture。每阶段都有旧模式可选。
7. 实验基线SDK/daemon版本冻结；新产品模式单独标记，不重写已有OSWorld结果。若升级只在Windows通过，不能宣称macOS/Linux真实桌面已验收。

当前推荐是“值得升级，并先验证0.28.2”。不推荐继续在0.22.2上大规模补自研窗口/UIA系统，也不推荐为了升级转成MCP或嵌入式运行。daemon隔离方式可保留，新SDK仍说明connect可用。[固定tag SDK README](https://github.com/trycua/cua/blob/cua-driver-rs-v0.28.2/libs/cua-driver/typescript/README.md)。

本轮只做官方源/合同与本地代码审计，没有改变依赖、安装二进制或完成上述真实验收。

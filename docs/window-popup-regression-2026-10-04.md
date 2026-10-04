# 手机实机弹窗回归与整改

## 状态

用户在 2026-10-04 更新后的 Preview 上实测仍失败。本文件接替上一轮窗口修复报告的放行结论：菜单 Esc 与 WPS Ctrl+A 的受控验证通过，不等于保存、字体弹窗等真实任务可用。本轮重新整改，未经复测不能宣称弹窗已完成。

本轮本机生产 Harness 验收的分项为：记事本真实新建、写入、保存通过；WPS 四号字新文档保存未通过；携程车票查询和切换到记事本通过，但报告编辑重复且未保存，整题未通过。这些实机结果发生在最终源码收尾之前；收尾后的完整任务尚未重跑，不能将局部通过推广为最终版本全部通过。

## 收尾与清理范围

- 删除 `preValueEmpty` 私有字段链、非空多行一律拒绝及对应过时测试；使用 CUA 已有末尾追加和同目标读回，不在 Harness 复制文本或再次拼接前缀。
- Windows 私有多行路线仅限 Windows；macOS/Linux 回到原 `type_text` 派发。当前 Windows desktop 多行不支持该窗口私有路径，明确留为能力边界，不用伪造 Surface／Observation 或盲注入补缺。
- 弱窗口候选不强制注册／切换；内部弹层核实与公开 grounding 开关解耦。精确强关系证明、旧引用失效、已验证 child 返回仍保留。
- 候选刷新期间不发布空 picker；完成、失败或超时才发布当前请求，过期结果不污染新 Run。验收脚本也不再把首次未结算空快照当最终零候选。
- CLI／Host 共用窗口发现与选择实现；旧 CLI 入口只保留有消费者的薄重导出，不保留第二份业务策略。
- 保留未知副作用不重放、正常 Abort／owner 清理、权限和预览身份边界。这些核心语义不是应删除的应用特例。
- 不扩展新的桌面输入架构、模型工具或运行模式；不读写系统剪贴板，不删除配置、登录 profile、录像或无关工作树文件。

已合入 `origin/main` 的 `961a098`，保留队友 macOS 焦点／DOM 指纹、浏览器和 Provider 改动。合并后补齐 DOM click/select 成功动作的恢复标记，只有不同 GUI 动作完成且 fresh observe 后才解除旧未知 primitive 防护；修正两个旧能力测试的裸数组／固定引用夹具，生产窗口引用校验没有放宽。

首次冻结业务源码 commit：`c484879f7b0691418a4776b4ee5686b8813abc48`。协调者独立执行根 `tsc -b`、CUA spike no-emit、Web production build、111 个 Vitest 文件／1654 项全部通过、built CLI help；附加 13 个脚本入口汇总 70 通过／1 项因 Windows 符号链接能力跳过。Sol 最终源码审查 GO，独立相关集成测试 56 项通过；Luna 实施，Sol 集中复核，不以作者测试代替独立结果。

PR [#22](https://github.com/wszkxlllll/Computer-Harness/pull/22) 的首次 CI 中 Windows、Linux Node 22／24 通过，macOS 失败。已读失败日志：三个内部 transient capture 没传目标平台，帮助函数错误使用宿主平台；另有 Windows 预览模拟未固定平台。修复统一已有“显式配置 → CUA 会话 → 宿主”来源，补齐所有截图调用；仅测试使用 Windows fixture，真实 macOS 默认及生产校验不变，无新包 API／options／协议。独立窄审 3 项通过；协调者修复后再次根构建及全量回归，111 文件／1655 项全部通过。实际 macOS CI 重跑未返回前，不宣布可以合入。

本轮没有为应用增加窗口类名／控件尺寸规则，未增加模型工具或输入模式。真实任务证据仍保持分项：记事本保存通过；WPS 保存未通过；携程查询与切换通过、报告整体未通过。最终代码收尾后未重跑这些桌面任务，新追加路线的实机效果不能据单测宣称已通过。

### PR、CI 与隔离部署

- 分支 `codex/runtime-surface-preview-20261003` 已推送；中文 PR [#22](https://github.com/wszkxlllll/Computer-Harness/pull/22) 面向 main，无冲突，未自动合并。
- 修复源码 `3f234c6b7acd3fc26c9de0042b4b5d77cedf7234` 的 [CI 运行](https://github.com/wszkxlllll/Computer-Harness/actions/runs/37187470662) 四组矩阵及 `ci-required` 全部通过：Windows Node 22、macOS Node 22、Linux Node 22／24。CI 是离线验证，不是 macOS/Linux 跨窗口实机通过。
- GitHub 已解析本轮提交 author 与 committer 为 `wszkxlllll`、账号 ID `142909575`；main 队友原始提交归属保留，未改全局身份或重写历史。
- Preview 独立 release `/opt/computer-harness-preview/releases/2026-10-04-popup-input-closeout-v2` 使用上述源码，保存 `.release-source`；frozen lockfile 安装、Relay 依赖构建、Web build、入口语法检查通过后原子切换，仅重启 Preview。旧 v1 与 window-progress-v1 留存回退。
- 公网 Preview `https://47.108.197.221:8443` 的 health／asset `index-D8bCuibX.js` 返回 200，未配对 `/api/runs` 返回 401；旧正式入口 health 仍为 200，stable release 和服务未变。Relay 仅监听 loopback 8788。
- 本机 Host 使用同源码构建、原 `.env.voice-preview` 与原 CUA socket，监听 4318；`/connect` 为 200，到 8443 的连接 established。日志／新任务在被忽略的 `runs/voice-preview-popup-closeout-20261004/`，没有重启 CUA、修改登录 profile 或启动新桌面任务。
- 用户在电脑打开 `http://localhost:4318/connect`，手机重新扫码配对并访问 8443。Relay 重启后旧配对无效；手机需要在新页面确认朗读设置。此次只确认部署和连接边界，手机预览／语音及最终完整任务仍须真实体验。

下方按时间记录历史调查；其中“尚未修复”是对应时点结论，当前实现以本节及输入路线更正为准。

## 新轨迹

目录：`runs/voice-preview-window-progress-20261004/sessions/`。

| Run | 实际目标与结果 | 已确认事实 |
| --- | --- | --- |
| `run-1791050672326-4697a699-ba0` | 记事本写入保存，failed | 手动接管后 target viewport 为 57×70；Surface 记录 peer_switch，随后目标不存在。临时窗口被当作独立目标的接管路径必须检查。 |
| `run-1791050848248-13ff5657-2f7` | WPS 输入/四号/保存，cancelled | 初始 viewport 与前一记事本相同；需核对初始选择来源，不能仅凭尺寸下结论。 |
| `run-1791050886454-7c8042f0-892` | WPS 输入/四号/保存，outcome_unknown | child_push 后出现手动接管请求，用户忽略后继续，最终执行时前台身份变化且驱动未确认未输入；未知副作用不能自动重放。 |

用户还报告候选标题重复、明确 WPS 却绑定记事本。已核对第二条 WPS 任务首张截图实际是记事本，错误绑定成立。第三条首张截图实际是 WPS。用户确认最后任务页面显示结束但仍阻塞新任务；三条轨迹有终态不等于 owner/lease/ApplicationSession 已释放，必须追查清理和忙碌状态，不能仅靠事件终态放行。

## 本轮修复范围与验收

建模原则：只记录会影响下一步动作正确性的 Surface 变化。tooltip、装饰窗口、不抢焦点且不阻塞动作的辅助浮层不触发 Registry 切换或手选；owner 关系用于证明关联，不是强制切换的充分条件。无需建立全桌面 owner 图。

1. 临时 Surface 自动进入、手动接管、关闭返回都维护父关系，不能将 owned child 机械作为普通 peer 切换。真实弹窗无标题时也应能区分，名称不是身份凭据。
2. 字体下拉、浮动工具条与 modal dialog 区别处理；不用控件尺寸或 WPS 特定类名代替关系判断。
3. 自动或手动初始目标不能静默复用上个任务的窗口，明确应用冲突需要重新选择。
4. 停止/失败后手机状态应正确同步；有效等待用户选择的任务则应引导返回当前任务，而不是让用户误以为新任务已开始。
5. 验收使用正常 GLM Provider 执行完整记事本输入保存、WPS 修改字体并保存独立测试副本，实际确认输出文件/格式、弹窗返回、明确 WPS 初始匹配以及结束后能启动下一任务。不再用 scripted Provider 的菜单 Esc、Ctrl+A 等探针替代真实任务成功。串行操作，不与用户或其他 Agent 同时操作，不覆盖用户原文件。

整改代码、独立审查、回归及新部署证据完成后更新本文件。保留历史失败，不覆盖为成功。

### 无法区分的候选

先使用本次动作前后的新窗口差异及已验证关系缩小候选，不把所有桌面窗口注册成 Surface。标题相同不代表身份相同；PID/HWND 用于内部精确寻址，不能作为要求用户理解的区分说明。

仍无法区分时，提供按需、只读的单候选画面预览，辅以真实可取得的应用名、标题、关系与捕获时间。预览不得激活窗口、执行输入或提前注册 Surface；选择后重新验证精确身份并获取新 observation。截图不可用、身份已变化或用户仍无法辨认时，禁止盲选，明确提示在电脑端恢复目标并刷新，或取消切换。自动选择同样不能靠重复标题或无依据的编号猜测。

候选预览源码已通过集中审查，尚未部署或完成真实配对手机验收。作者 134 项定向测试及各包 no-emit 类型检查通过；Sol 独立必要增量 34 项通过，含本地 HTTP→Relay WSS roundtrip。预览绑定 paired device、requestId、候选 token 与有效期；前后复核精确 PID/HWND、限制响应大小、no-store，临时会话正常结束。界面需图片实际 load 后才能确认；重读、token 变化或失败清掉旧图与确认状态。协议／mock 连通不等于真实手机已可用。

### 本轮完整任务的实际阻塞

实际 GLM 记事本 Run `run-1791059087525-030a5a71-f7b` 已结束并释放 owner，但任务未通过：两行文本正确输入，随后反复点击“文件”，最终达到 100 次模型请求预算，未生成目标文件，用户最终回复为空。不能将资源释放正常写成任务成功。

窗口截图尺寸为 687×685；点击 image `(40,87)` 与真实 DWM 物理窗口边界、SendInput receipt 位置吻合，当前证据不支持 DPI 坐标错位修复。下一轮在首次菜单异常时暂停并采样真实前台、菜单状态和画面，区分输入未生效、驱动恢复前台关闭菜单、父窗口截图漏掉独立 popup 三种情况；未确认前不增加应用特例或替代点击补丁。

源码核对表明 CUA 0.22.2 点击后存在异步 foreground restoration，但仅前台变成目标同进程的另一个 HWND 时才会恢复此前窗口；不能直接认定它是根因。精确窗口截图也不保证包含独立 owned popup。当前正在进行真实任务证据验证。

后续只读核对发现初始选择中的两个 Notepad 候选确有直接父子关系：完整、fresh 的 Win32 snapshot 证明 popup HWND `0x991316` 的 owner 精确为主窗 `0x98e1b34`，二者 PID 均为 `27384`，前台仍为主窗；CUA 原始列表没有这份关系证据。初始选择不应把这个已证实 child 与父窗口作为两个平级应用竞争，但不能仅凭同 PID 或标题推断。

随后取得并独立查看真实截图：`runs/diagnostics/popup-readonly-owned-window-capture-1791061540253/Notepad-candidate-01.png` 为 447×697 的完整文件菜单，包含保存、另存为等；同目录 `Notepad-candidate-02.png` 为 687×685 的父窗口，完全没有该菜单。这确认当前父窗口截图漏掉独立 owned 菜单，并可解释模型反复点击。不是依据类名或模拟 fixture 得出的结论。菜单采集时前台仍是父窗口，GUIThreadInfo 的 menuOwner 为空，因此不能把 Win32 传统菜单标志或 UIA root 必须是 Menu 作为所有现代弹层的前提。准入修复仍须区分可交互关联 Surface 与无关装饰窗口，不能把任何 owner 窗口都强制注册为 modal。

确切 UIA 证据保存在同轮 ignored 诊断目录的 `popup-uia-0x991316-1791062166416.json`：结构化元素包含独立 Menu 根及其直接 MenuItem；树为 Pane → Window → Menu，不需要控件名称或应用类名特判。`elements_complete=false` 不等于不存在菜单，也不能用于断言没有其他元素；菜单存在性的正向证据与完整 Win32 关系快照分别承担不同职责。

代码断点已找到：native child 的内部 bounded UIA 身份/根角色核实受公开 Grounding Catalog 开关控制。测试配置为 `grounding=off` 时跳过了核实，非前台 child 又被当作辅助浮层忽略。现已解除这项耦合；same-HWND overlay 原有边界不扩大，关闭 Catalog 仍不向模型暴露 UIA 工具、元素目录或上下文。另修正 auxiliary 条件：只有明确的普通 Window 根证据才允许按辅助窗口继续，unknown 不等于无害。该切片作者目标测试 178 项通过，启动前已存在菜单的观察入口与候选预览仍在实施；完整实机任务尚未放行。

独立审查补充边界：已有菜单首次 observe 入口中的 `TRANSIENT_SURFACE_UNKNOWN` 目前会使 Run 显式失败，不能写成已进入人工 picker；只有已有 action 后窗口 handoff 路径有真实等待用户选择的消费者。首次观察的不确定恢复仍需衔接控制面，候选预览也仍未完成。这不影响对正向、已确认 Menu 入口的实际验收，但不是未知弹层交互已全部解决的证明。源码还确认 CUA foreground 坐标点击发送前要求精确目标 HWND 前台，owner 关系只容忍输入后的父→子变化；Menu 子 HWND 不成为前台时的输入交付需在真实任务中单独验证。

### 新版完整任务：已进入菜单，尚未保存

修复后真实 Run `run-1791068416785-075e6148-19b`（目录 `runs/diagnostics/full-popup-task-acceptance-20261003230005814-100c54b0`）自动选择记事本并运行，9 次模型请求，最终 `outcome_unknown`，文件不存在、owner 已释放。录屏首帧及 MP4/H.264 检查通过。本次实际验证到了已打开菜单的进入/关闭返回，以及新菜单的独立截图；不再是只读 probe 或启动预检。但完整保存任务仍未通过。

seq 87 点击菜单“另存为”得到 completed 输入 Receipt；seq 89 的菜单画面仅显示该项目高亮，不能将它写成对话框已成功打开。第二次点击在 seq 95 started，seq 97 报未知副作用。录像在报错附近仍是菜单，约 0.9 秒后的末帧显示另存为对话框。

最终只读确证：旧菜单 HWND `0x991316` 已隐藏，新的独立 `#32770` 对话框 HWND `0x2312aa`、PID `27384`，owner 精确为原父窗 `0x98e1b34`，可见且非最小化；前台仍为父窗。对话框独立 PNG（`recordings/readonly-saveas-dialog-exact.png`）显示文件名、保存和取消，父窗口 PNG 则漏掉它。早期“同 HWND 内部对话框”的诊断已撤回：父窗口 UIA 树能遍历 owned 对话框，不是 HWND 相同的证据。

本轮继续修复通用的“旧 child 隐藏 → 同父新 child 出现”恢复：只读有限复核，分别验证旧对象关闭及新对象身份/关系/可交互画面，不重放旧动作，不把 unknown Receipt 改成 completed。需要新恢复 kind 时同步修改 Runtime/Trajectory 消费，保留原 parent 恢复路线。尚未把这条新路线记为完成。此前多次选窗未启动也保留为端到端 `startup_blocked`，不从产品可用性结果中删除。

该切片源码现已通过集中审查：新 `transient_owned_surface_reconciled` 提示具有 CUA 生产者及 Runtime／Trajectory 消费者，要求旧、新 child 的可信来源、同父不同 Surface、新观察精确引用和 `child_push`。最多三次、间隔 300ms 的只读核实优先检查替代 child，之后才考虑原 parent 恢复；不发送输入，不重放旧调用，不执行旧 batch 后缀。移除了 parent 恢复中误加的“父对象必须无父对象”限制，保留精确 direct-parent 检查。作者定向测试 339/339；Sol 独立增量 18/18；主协调者重新构建 CUA、app-runtime、Host 通过。当前仅放行真实任务复测，不等于完整保存验收通过。

后续真实 Run `run-1791074363761-3e1d46f8-ae6` 已自动选中 Notepad 并观察到完整独立“另存为”对话框，但仍未保存。点击文件名框得到 foreground SendInput completed；两次 Ctrl+A、一次 Shift+Home 均被 CUA modern XAML/UWP accelerator 查找路径明确拒绝，失败内容已写入工具结果并反馈模型。组合键仍是模型后续发出的不同调用，不是 Runtime 自动重放。点击位置处于文件名 Edit 范围内，但没有可靠 focus 状态，不能声称焦点已确认。

该 Run 先通过正常 API pause，随后正常 abort；终态 cancelled、owner 已释放、目标 TXT 不存在、最终回复为空。录像 H.264／无音轨验证通过，SDK 错误摘要已保存。结果计为未通过，不能因对话框识别成功而标成完整保存成功。证据目录：`runs/diagnostics/full-popup-task-acceptance-20261004003912231-6e5ec600`。

下一步核实 SDK `press_key(key, modifiers)` 的前台键盘语义；仅当能够保留 exact target、一次派发及明确 refusal 语义时，才考虑替换单基础键加修饰键的组合映射。不强制模型返回 element token，不扩大到 Desktop target，不在失败后改路径重试。接口类型存在不是实机正确性的证据。

该核实已推进到最小代码修复：对应 [CUA v0.22.2 源码](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/input/keyboard.rs#L415) 明确消费 modifiers，按修饰键按下、基础键按下／抬起、修饰键抬起生成 SendInput，并先确认精确目标前台。独立单次 SDK 实验返回 foreground SendInput 成功，但文件名未显示全选，因此只证明派发、不能证明焦点或最终编辑效果。临时会话已正常关闭。

Adapter 现仅对 Windows、已绑定窗口、foreground、一个基础键加唯一已识别修饰键使用一次 `press_key`。单键、文本、后台、desktop、多基础键、未知或重复修饰键及其他平台保留原路由，不依据失败结果 fallback。作者 CUA 181/181；Sol 独立必要增量 10 项通过；协调者重新构建通过。随后完整任务结果见下，保存仍未放行。

该轮真实复测 `run-1791077269071-2c7fdf26-d91` 仍未通过，已正常取消、释放 owner 并保存有效录屏，输出文件不存在。首次多行输入拒绝时的新截图确为新建空白正文，不是保存框。默认 Host 与 runner 同为 `grounding=off`，内部 `readWindowGrounding` 此时直接返回空；`executeMultilineType` 却只能从其生成的私有 observation map 取证据，形成无生产者的硬拒绝。模型之后单行补录出现异常画面，不能将 completed 派发回执当作正确文本。

该默认路径的修复方案：仅 Windows 多行输入、缺少可复用完整私有证据时，按需对当前精确窗口做有界 UIA 查询；不向模型公开 catalog、不增加工具、不把局部数据塞回模型 observation。复用原有同 session／surface／最新引用与几何检查、编辑控件解析、token/snapshot、执行和读回验证，不用盲键盘输入补缺证据，也不把 runner 开成 UIA 模式绕过默认产品问题。实施与验收结果见下一节。

### 最新验收：记事本完整保存通过，WPS／跨应用待验

默认关闭公开 grounding 下的按需私有输入证据已完成；2.5 秒只读查询超时返回 refused、无输入，显式错 PID/HWND 拒绝，其他平台与单行输入路径保持原样。作者 CUA 测试 188/188；Sol 独立新增 7 项通过；协调者重新构建通过。

随后真实生产 Harness Run `run-1791079791708-fc6639d2-c9a` 完整通过：自动选中记事本，正确写入两行，真实保存到 `E:/MyDesktop/output/Harness-Notepad-20261004020941148-863e1f71.txt`，返回正文，模型给出明确路径和确认结果，正常结束并释放 owner。协调者独立查看保存后的正文截图并 UTF-8 读回文件，内容与要求完全一致。8 个动作、10 次模型请求；有开始、新建正文、保存路径、保存确认和完成通知。录屏 H.264／无音轨验证通过，目录 `runs/diagnostics/full-popup-task-acceptance-20261004020941148-863e1f71`。

保存按钮派发后有一次 transient outcome unknown，旧对话框关闭、精确父窗口恢复；Runtime 保留该事实，重观察后交给新模型决策，没有再次点击旧按钮。实际文件和新画面支持最终任务成功，不将该输入 Receipt 擅自改成 completed。

仅放行这一完整记事本任务，不把它推广为 WPS 或跨应用全部完成。WPS 后续正式任务结果见下；候选预览仍待部署和真实手机检查。默认 mobile saved profile 后续已通过正常准备流程，实际携程登录和跨应用任务仍待验证，不能手写 ready 状态。

### WPS 起始观察的误拦截与收口

首次 WPS Run `run-1791080188922-260d710c-95b` 自动选对 WPS，但首次观察即失败，0 模型请求／0 动作，未生成文件；owner 正常释放。完整 Win32 只读快照证明父窗口就是前台，唯一可见直接 owned child 不是前台；主窗精确截图是普通 WPS 编辑器，UIA 根 Window 为 enabled。子候选没有可用 UIA 根或截图，不能推断它阻塞，更不能将其无标题列表交给用户盲选。其他两个同父 child 不可见，未操作；不凭部分 UIA 树断言不存在别的控件。

修复移除“唯一 owner/z-order 候选＋未知 UIA 根就硬失败”的旧限制：这种弱候选不进入 Registry，继续已验证父窗；无 UIA 角色时，只有现有完整 Win32 精确前台＋直接 owner 证据，捕获后再复核身份／几何／owner／前台，才接续 child。正向 Menu/Popup/Dialog 路径和明确身份冲突仍保留，动作前窗口检查不放宽。不使用应用名、标题、类名或尺寸特判。

作者 CUA 测试 191/191，Sol 独立必要 7 项通过。协调者构建发现三处测试 mock 参数类型问题，作者最小修正后协调者再次构建成功，现已放行 WPS 完整任务重跑；尚未标成 WPS 保存通过。本节取代前文首次观察中“unknown 必须让 Run 失败”的历史说明，弱候选不等于阻塞事实。

历史离线验证：当时 Node 24 构建通过，主测试 108 个测试文件、1358 项全部通过；附加脚本测试 31 项通过、1 项因 Windows 不支持当前测试权限下的符号链接而跳过。这是后续 unknown 恢复改动之前的结果，不作为当前全部增量的最终回归，也不替代完整任务验收。

### 最新 WPS：动作后未知与空恢复候选，尚未通过

真实 Run `run-1791087071720-00223012-b2e` 自动选择 WPS，发出 1 次模型请求和 1 次点击尝试。seq 10 开始点击，CUA 随后报告精确目标 HWND `0xc8177c` 在点击后不再是前台，实际前台为 `0x3cd0176`。错误没有证明输入未发送，因此 seq 12 保留 `ACTION_OUTCOME_UNKNOWN`，不能按普通拒绝重试。统计为 attempted=1、completed=0、partial/unknown=1，而不是“没有执行动作”。

seq 15 进入窗口恢复，控制面最初快照候选数为 0，随后验收 runner 立即通过正常 API 取消；seq 16 终态 cancelled，owner 已释放，有效 H.264 录像已保存，没有生成 DOCX。后续源码核对确认这是异步刷新尚未完成时的 provisional empty snapshot；此次取消截断了后续刷新，不能说最终候选为 0 或 Host 已把所有候选过滤掉。旧 `acceptance-summary.json` 已将此事件标注为非最终计数。

源码现有 Remote API 时序保持不变：刷新中为 `waiting_window` 且不发布可选 `pendingRequest`；成功、错误或 15 秒刷新超时后才发布已结算 handoff。忽略式验收 runner 已改为等待该结果，最多观察 30 秒；只有收到带候选数组的已结算请求（即使为空）或超过观察上限，才经正常 Remote API abort 并等待清理，始终不盲选。Node 语法检查及离线控制队列／候选刷新状态 self-test 通过；未 build、未启动 API/GUI，也没有新实机复测。取消和释放链可用，不代表 WPS 保存可用；不能要求用户在空列表或相同标题中盲选。

后续只读完整 Win32 快照中，历史前台 HWND 仍是可见、同 PID 的对象，但 owner 为 0；精确 `get_window_state` 失败且没有图像，诊断文件没有保存原始错误文字，不能还原错误原因。WPS 主窗的独立截图成功，显示测试文档和标记。事后的主窗前台状态不能证明恢复判断当时也是主窗前台；同 PID、类名或空标题也不能证明父子关系。Win32 边界与截图相差 2px 不参与同 Surface 几何谓词，不能把它当作根因。现有 `verify_state` 精确窗口截图不依赖 UIA 树，但对该弹层是否成功仍待只读实测，不是已解决。

方向保持可靠 Runtime，但收敛实现：Registry 只接纳当前 Run 使用且证据成立的 Surface。底层已支持窗口枚举、激活、定向截图及输入；部分弹层的捕获与关系证据仍需实测补齐。不能据此宣称所有弹窗可用，也不通过应用特例、盲目重放或静默全屏截图填补缺口。

`press_key` 是 CUA 已有底层接口，不是新增模型工具；本轮仅改变特定 Windows 前台组合键的 Adapter 映射，模型侧 `keypress`/`hotkey` 合同保持不变。

默认 `mobile` 受管浏览器 profile 已通过正常准备与完成流程，清理确认成立；这是配置就绪，不代表携程登录已经现场验证。携程 → 记事本任务后续实际结果见下，完整保存未通过。上述修复仍未部署到 Preview，当前线上版本不能用于验证这些未部署改动。

### 携程 → 记事本：查票与切换成立，编辑未完成

真实生产 Harness Run `run-1791091848162-250a734a-b93` 使用 mobile saved profile、跨窗口工具、100 请求／动作预算，Guard 关闭、Monitor shadow，全程录屏；日期按上海时区动态选择下一天 `2026-10-05`。模型在受管携程页面查到真实结果，再自行切到记事本新文档，没有外部操作者输入或手选目标。

协调者独立查看结果页资产 `ef9b8cb1-5011-4637-9681-6563fdc96e85.png`：前三趟为上海虹桥 → 杭州东，G4917 05:44–06:29／45 分／页面价格 83 元，G7541 05:52–06:51／59 分／57 元，G1321 06:07–06:56／49 分／80 元；截图有对应余票文字。没有进行下单或付款。这只放行查票及切换部分，不等于报告任务通过。

正文录入中出现一次明确无输入的 `MULTILINE_TYPE_INSERTION_UNSUPPORTED`，之后模型分段继续输入。最终报告的第三趟车次重复且没有保存，64 次模型请求、61 次 GUI 尝试，60 completed、1 refused、0 partial/unknown。先正常 pause 保留现场，再通过同一队列/API abort；ack 为 `aborted_and_released`、终态 finished/cancelled、owner 已释放、profile 回到 ready、H.264 录像验证通过。没有强杀、删除锁或编辑／关闭现场文档，目标 TXT 不存在、没有最终报告回复，整项未通过。

调用与截图对齐确认：两次模型分别发送同一完整 81 字符车次段落，每次只有一次 completed 输入；输入前只选中约 19／10 个字符，输入后留下第二／第三份车次。随后 SHIFT+HOME 只选中 3 个字符，DELETE 又造成局部混乱。协调者独立查看最终正文截图。此证据指向软换行下的选区判断和编辑恢复，不是单次 SDK 注入自动重复，也没有模型发送“333”的证据。不能凭 completed Receipt 宣称文字正确，不添加应用特例或未证实的输入节流补丁。

下一步要验证通用文本编辑证据与恢复：选择范围不明确时不能反复把完整段落输入到局部选区；能否利用现有 UIA 证明完整编辑范围及合法替换，须核对底层实际字段和语义再实施。既有空白多行输入验收不能推广为非空文档追加／修订全部可用。完整携程 → 记事本保存仍未通过。

### 收敛检查：全桌面与多平台输入范围

现有 Remote desktop 起点使用 `windowTarget:null`、公开 grounding 关闭，未绑定时观察走桌面截图、动作使用 primary desktop 前台输入。关闭窗口切换工具时能保持这个范围；开启后模型调用 `switch_window` 会注册并绑定 native peer，后续改成窗口截图。故不能将目前的 desktop + switch 工具宣传为全程全桌面模式，也不能静默扩大或缩小用户选择的范围。

早期实现曾让任意带换行的 `type` 都进入 Windows 私有 UIA 分支；当前源码已加 `current.platform === "win32"` 限制，非 Windows 回到原生 `type_text` 路线，并有 darwin/linux 路由回归用例。Root 已 fresh-build 验证这一平台 guard；本轮没有桌面实测。Windows desktop 多行仍没有 exact-window UIA binding，按需私有目录路径会拒绝；这部分保持未验收，不伪造 Observation、不重建 Session 或强塞 Registry。

### 输入路线与模型侧说明

上游 Windows XAML/WinUI 路径的精确 `cua-driver-rs-v0.22.2` 实现见官方 [`impl_.rs`](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L4194-L4264)：有 UIA 元素索引且元素有 `ValuePattern` 时，Driver 内部读取 `CurrentValue`，构造 `current + text` 后 `SetValue`，再按同一元素读回并比较。因此这一模式是**逻辑末尾追加**，不是由 Harness 预先拼接，也不是插入当前光标或替换选区。旧版官方 PR #1597 可作背景；实际 v0.22.2 语义以该 tag 为准。

本项目 Adapter 的私有 CUA 调用用 snapshot-bound `element_token`，通过通用 `callTool` JSON 边界传递；SDK 0.22.2 `.d.ts` 没有为该 MCP 字段提供专用的 TypeScript `TypeTextInput` 参数。其 element token 是精确快照中元素的寻址能力，不是 TextPattern/TextRange、选区起止或范围替换 API；`Home/End` 也只是键盘按键，不是 UIA 逻辑段/选区合同。

本项目 Windows 多行路径通过 exact-window 私有 UIA 观察取得元素 token。此前实现只保存 `preValueEmpty` 布尔值，并在非空元素上以 `MULTILINE_TYPE_INSERTION_UNSUPPORTED` 拒绝，因而没有使用上游已有的追加能力。当前源码切片已移除该空值 guard 与仅供该 guard 使用的旧值状态，向 Driver 传递的仍只有新 chunk；上游 Driver 自己负责 `CurrentValue + chunk → SetValue`，Harness 不能预读后再次拼接，否则会重复前缀。协调者已对当前切片 fresh-build；最终冻结审查及受控桌面验收仍未完成。上游 v0.22.2 对 `CurrentValue()` 读取错误使用 `unwrap_or_default()`，所以旧值不可读时可能被当作空值并覆盖未知文本；不得声称追加绝对无损。CUA 明确拒绝／证明未输入时 Adapter 回 `refused`；派发后无可信同目标读回或结果不确定时回 `partial`，要求重新观察且不自动重发。

0.22.2 SDK 存在类型化 `clipboardRead`／`clipboardWrite`，但项目模型 ToolRegistry 未暴露剪贴板工具；二者是分离的读取／覆盖操作，没有原值快照加原子粘贴／恢复事务。`clipboardRead(includeText=true)` 会接触标记为 privacy-sensitive 的文本，写入也会替换系统剪贴板；本轮没有读取或修改剪贴板。共享 ToolRegistry 的 `type` 说明已更正为窗口绑定 Windows CUA 多行末尾追加，并说明完整文本组织及软换行选区边界；GLM/Qwen 从同一注册表消费，未增加新工具或 Provider 私有工具清单。

Demo 收敛路线优先复用已有前台／桌面模式，但须先排除上述输入缺口，不能只换模式名就反复运行。截图范围、窗口激活和文本插入／替换属于不同职责；公开模型工具与 Driver 私有证据保持分离，后续修改仍以实际任务结果验收。

局部未知动作后的恢复契约见 [独立规划审查](./popup-recovery-contract-review-2026-10-04.md)：不把不确定动作宣称成功，不重放。已实现原 child 关闭后的精确 parent 恢复、同父新 child 接续，以及完整证据下同一 native Surface 重确认；Runtime 都必须取得 fresh observation 后才能进入新决策。同一 Surface 的未知 primitive 有私有重放防护，wait 或失败替代不能清除。普通传输未知和无证明的窗口变化仍不得自动继续。源码审查通过不等于 WPS 实机验收通过。

无法区分时的恢复不是降低身份要求后随机选择。先缩小关联候选，再展示真实预览；预览仍无法辨认或身份不稳定时，暂停并请用户在电脑端显示目标后刷新，或取消。不得把一排相同标题、原始句柄或编号交给用户盲选。关系证据足够的菜单／对话框应自动接续，不能为省事将所有临时 Surface 都转成人工选择；不确定的 candidate 也不能提前进入 Registry。

## 旧阻塞的受控恢复

已确认旧 Run 终态、旧 CUA session 查询不存在；临时只读 inventory 会话已正常 endSession(active=false)，没有输入。核验旧 Host PID 后停止，调用现有 `ProcessSharedEnvironmentOwner.recoverLease` 对精确 Run/lease hash 的 pending_cleanup 记录进行显式恢复。quarantine 与 committed audit 均保留，恢复后 owner 为 null；没有删除浏览器 profile、环境配置或历史事件，没有重放旧动作。

审计 ID：`518f2eee-96c3-45c7-9685-eeb2439cccde`。这是旧版本留下的锁的一次受控恢复，不作为新版本生命周期正确性的验收；新版本仍须证明真实任务结束后可正常开始下一任务。

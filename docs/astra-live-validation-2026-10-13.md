# Astra 新冻结版现场验证记录（2026-10-13）

> 2026-10-14 审查更正：原 A08 preload 的 JSON 换行是合法 LF 转义，并无双重转义 bug。Root 已用完整原 SHA 重建证明；此前关于该 bug／四测试“不可能通过”的结论撤回，保留历史并见文末更正。首 Run 的实际会话/allowlist 缺失仍有效，未归因换行。

本记录从离线八项 MR 修复完成后接续 R5，只记新冻结版现场前置、真实诊断和原卡运行的实际证据。八项 MR 的红绿、独检与未覆盖边界见 [本轮修复执行记录](astra-mr-repair-execution-2026-10-13.md)。历史 498 次 Provider actual、30 次 unknown 不清零；旧 CLI L2 experiment 三轮不抵本版正常 Web/default layered 验收。

## 冻结版只读预检（CI 未放行、未启动现场）

- HEAD `3b8428723b3ae123d444ddd53f1b5c2a4e7adc0d`；Root 已在此版完成本地综合 2,076 个 Vitest、72 个 Node 测试、typecheck、Web build 并精确 20 路径非 force 推送。当前这一步只读核主仓产品工作树 clean，原有无关 dirty 文档与未跟踪历史资料不处理。Root 实核当前 CI `38344052541` 终态：macOS、Ubuntu 22/24 verify 成功，Windows verify 失败、ci-required 随之失败；Root 正定位日志。CI 未通过，不继承旧 SHA 的绿灯；仅处理必要离线兼容问题，不扩为 Windows/Linux 原生实施或验收。
- 从 `packages/runtime`、`computer-cua`、`app-runtime`、`provider-qwen`、`provider-glm`、`relay-connector` 及 `apps/host`、`relay`、`cli` 共九个项目读取 91 个非测试 TypeScript 源文件，用本仓 TypeScript 的 ES2022/ESNext/isolatedModules 编译选项在内存转译，逐字节比较相应 `dist/*.js`：**91/91 相等**，0 缺失。检查未写 dist 或源码。此覆盖当前运行链的 JS 源码闭包；不把它说成 native 二进制或 Web bundler 的独立重建。
- Web `apps/web/dist/index.html` SHA-256 `26e6b6a898eeed287a864e4c04dfb1ad76402c6f5ea31a359c4ab472d9cf57b2`，其引用的 JS `index-DnXbYSt4.js` SHA `062308c5b4ebe52ef04e3f53e6cd64c4a73cad44814eac4e1399e9fd2ce44604`、CSS `index-CC44qBMs.css` SHA `093543fcf1c0de315739a8d73e117e3a3511d229e76771fee454136b82b61ff3` 均存在。额外工作线程资产 `harness-pcm-capture-worklet.js` SHA `2ac7da2350398eea97a5d326f25ce08fddbc8d14928d88335e46a29370c9e40a` 存在。Web 源文件没有晚于产物 index 2026-10-13 11:48:45 +08 的修改，Root 的 Web build exit 0；尚未现场加载页面或核 HTTP 传输资产。
- 用 `ps` 逐核旧自有 Host `26665`、Relay `26276`、native `98330` 和 stock `4254` 均不存在；全系统进程 argv 的限域只读匹配未见 Computer-Harness 业务进程，TCP listener 未见 Host/Relay，`/private/tmp` 顶层未见 A07/CUA socket。系统 Chrome/ChatGPT 辅助进程不冒作业务进程。旧 PID、窗口 CGID、表单位置和配对认证均不得复用。
- 主仓 native8 app `.tools/cua-driver/CuaDriverCaptureFix.app` 的二进制 SHA-256 `6f56f90e516a3d410c77f8bfc739f3aa0af4a4f68b7004e63d0913858aa58722`；`codesign --verify --deep --strict` valid on disk，Identifier `com.trycua.driver.capturefix.local.20261011`、CDHash `a47177f46d26c25830f258627c0ffe7fe9ad019d`、adhoc。**当前没有该 daemon 进程或 socket**；磁盘签名不代新启动后的 health/TCC/focus 证据。
- A07 私有 counter 只读：`batchId=A07`、actual `61 main / 0 risk / 61 total`、sequence 61、reservation revision 2、reservation与limit均 `120 main / 6 risk / 126 total`。counter SHA `b27dbf63f1213e776c2a49f585c46792c466d28e885a8dd5e71f9000512e2ebb`，anchor SHA `cb41a888ea2386fe05fda6555767718b03dc0e2d89427672e99891cc2f9323c8`；state digest 与 anchor 一致，audit 63 行末 seq61。此是旧批次现状，不自动授权新付费 Run；下一新批次须另分 scope/预算并维持历史累加。

## 冻结任务卡与输出门

| 任务卡 | 原卡 SHA-256 | 当前唯一输出只读状态 |
| --- | --- | --- |
| T2 正常 Web baseline native profile | `8acbe1c67ebb5fddf6d869d0b01c6e1978809d82bb4906fe8c91442229df65cb` | 原目标不存在；goal 1133 B / SHA `54fb4b960858d7d56db4bd4872186e01d4512e2e8873998842713c38e97a4b2c`。 |
| T2 独立 repeat | `fc69f884459c5fa721200f98578a402d7ba3ccea7a0be90ca0787fdf5cd28925` | 原目标不存在；正式 Web 入口和语义仍须与 baseline 对齐审定。 |
| T2 原 variant | `e9770743c6e8de4db1bdc62501f1a35e842315ab85444105c74aa83549eeb8e4` | 原目标已存在，不覆盖；同语义复验须保留原卡，另派生只更换唯一输出路径的新卡并重新核 goal/hash。 |
| T3 baseline / repeat / variant | `69ee175953270edb63a18bff2acf071d0f0475aa3f48b70741b179269b65c1a2` / `a5f6ca6828a61e9ea399fad99abc8ba35abb4361edbc0b7418ec585563e8b8cc` / `8bb4a398d16d29c67161e1fd8fdba180c6457ca453928de123c25936c27a6837` | 三个目标当前均不存在；T3 hybrid 同 Run 完整链在本 HEAD 尚无产品能力，不以旧 browser target 或 native-only profile 冒充。 |

T1 三张原卡 SHA 分别为 baseline `42485b83cc47c35ba09f77858096fd7bf61bd6018daf93a35c7575667b7e14f4`、repeat `d340ff10640ebb3f433b87540b27e2491c883fad97c0cd42eb41e13aa80026ae`、variant `13a2c306b7404461f904d7f6975c571b2ff7441a2733b51700c3ea13e4c47f42`；T1 是来源/结果任务，不用 T2/T3 文件存在性字段代替事实验收。

## 下一现场门（尚未执行）

Root 定位并修复当前 CI 的必要离线兼容失败，新 HEAD/CI 通过后，才核当前权限、解锁、daemon 新 PID/socket/health 及 TCC，并以新 scratch 与精确当前窗口身份做 MR-02 平台合同、MR-01 普通/受限恢复、MR-08 必要的一次真实预览零 Provider 诊断；记录 action/tool 序列、正式 handoff、清理 Busy 和新 observation，不重放 unknown。然后准备新 batch/reservation、严格原卡/唯一输出/监控 ready、正常 Web Start 与默认 layered 配置，分别执行 T2 baseline、独立 repeat、原 variant 的同版完整任务；T1/T3 后续另证，T3 先需隔离分支的 Host-owned hybrid capability 完成、审查、合并和零 Provider 组合验证。实体手机 M1–M4、真人评分、语音实际听感及远端 Preview 发布另列，不计电脑/Web 替代通过。

截至本记录：0 次本轮 Provider 请求，0 次 GUI 动作，0 次业务 Host/Relay/daemon 启动，0 次真实预览，0 次正式原卡 Run；只有源/构建/进程/签名/卡片/旧账本的只读检查。


## 当前CI与零Provider现场诊断授权

Root实际2026-10-13T04:15:21Z核新HEAD972035044f7b05a3609a5981547ce9cfd95f1ce6已同SHA推送，CI38345102253五job全部success。测试修正仅迁移一项旧轮询等待为已提交handoff事件，产品仍是3b的八MR源码。已交Luna作为唯一现场执行者重新启动验签native8、核新PID/socket/当前health与权限，并进行新scratch的普通/受限恢复及必要预览零真实Provider诊断；此时尚未出具真实诊断通过结果。Root与隔离T3组不操作桌面或切主业务服务。


## 新native会话健康检查：当前系统授权缺失

Luna经正常 `open -n -g -a` 启动同一验签native8，socket `/private/tmp/ch-r5-45fb1c94-3710.sock`，wrapper43724/daemon43726、UID501、2026-10-13 12:16:07开始，argv带serve/该socket/no-overlay。Root独读 `R5-private/45fb1c94-3710-49ec-9765-250226de17a9/native-health.json`：driver/SDK0.22.2、darwin、session_active通过；辅助功能、屏幕录制、AX trusted均fail，overall degraded。自定义bundle identity与canonical名称不同属于既有候选标识，不能把canonical提示当作换binary的许可；当前SHA/CDHash仍匹配native8。health session已end、active=false。`desktopUnlocked=false`单字段不据此断言锁屏。

此时没有窗口枚举、屏幕捕获、输入或真实Provider。实际诊断尚未执行。用户已授权必要任务权限，Luna继续准备该已验签app的正常系统授权入口；能直接完成的正常开关在授权范围内，出现Touch ID/系统密码等本人验证则停在具体界面由用户完成。不得改TCC数据库、绕过本人认证或悄换canonical旧native。Info.plist显示名为 `Capture and Document Fix Local Candidate (seventh)`，CFBundleName `CuaDriverCaptureFix`，bundle `com.trycua.driver.capturefix.local.20261011`。Root/T3组不并发操作桌面。


## 2026-10-13 T3 主集成验证更新

Host-owned `native-web-document` 实现及其普通 Web/Relay 入口、Browser 与 TextEdit 独立能力边界、一次性文稿恢复已由 Luna 实现、Sol 独立审查并导入主分支，共25个路径。Root逐文件核SHA与审查清单一致，保留9720350的CI等待修正；主目录类型检查、119文件2089项Vitest、72项Node自检及Web构建全部通过。私有证据为 `T3-integration-20261013-private/root-final-integration-verification.json`。这是离线实现与组合夹具通过，真实三线业务任务仍待现场验证。9720350的五项CI已通过；此次T3新提交需单独等待CI，不继承旧结果。本轮真实Provider调用仍为0。

屏幕录制权限已完成off→on刷新，并按系统提示退出重开目标App。辅助功能刷新再次出现macOS本人认证，已请用户完成；执行者停在该实际认证面板，尚无刷新后的health或业务Run通过证据。


## 594fa8e 新冻结与授权续办

T3提交594fa8e9b38d6ec8da066da214468789756319ea已同SHA非force推送。Sol独立核25实现路径/哈希和29提交范围一致，972测试修正保留；92/92运行链源与dist一致，Web四资产齐全，冻结清单 `R5-private/freeze-594fa8e9-20261013.json` SHA eca3a0c566c301becf1d1bbe6770133ce2c202a6cb288605d70ae6170164d2ee。新CI38347772526当前进行中，不计旧CI为本版通过。

用户已完成辅助功能第二次本人认证并表示亲自开启。唯一GUI执行者重新核当前开关及同验签native8健康；此条尚无刷新后健康通过证据，不能先执行真实Runtime或预览。

Luna离线T2准备回执指出：A07当前61main/0risk、reservation120main/6risk/rev2不变，余59main不足三轮；需新独立批次并保留全局498实际请求（490main+8risk）、468known合计8600579tokens及30unknown。旧Web模板绑定旧源码，旧CLI repeat/variant及已存在输出不可重用。新卡只允许原文唯一输出路径替换，保留末尾LF与原卡日期/正文，不放宽任务或default-layered配置。三轮真正启动仍需fresh窗口/预算/monitor ready等门。


## 新CI通过与权限刷新后矛盾

Root于2026-10-13T04:48:10Z读取594fa8e CI38347772526终态：四平台verify及ci-required五job全部success，保存 `MR-review-20261013-private/root-594fa8e-ci-terminal-readonly.json`。保留跨平台既有CI不扩展Windows/Linux原生任务。

用户完成两次本人认证后，两系统开关fresh读均ON；唯一执行者标准owned重开得PID48866/48867、socket `/private/tmp/ch-r5-perm-health-20261013.sock`、原native8签名/SHA。child不再带internal missing-gate flags；新health仍degraded且TCC/AX检查fail，session已end。证据 `R5-private/post-permission-restart-20261013T0446Z/native-health-post-restart.json` SHA bd5979b72c0ae6edac69c1e34784f54c355bed6c87366adc30d6ffdc7e1f9edc。已停止反复刷新/重启，Sol检查health判定实现是否合并了canonical bundle guard与真实权限；未获得实际操作能力通过证据，不越门启动Runtime。

Root独立复核三份新T2候选：原卡SHA、rawgoal字节/LF及仅输出路径替换均一致，全部新输出absent。保存 `T3-integration-20261013-private/root-t2-candidate-independent-verification.json`。目前仍0真实Provider。


### Sol原生健康独检的阶段证据

同bundle ID和signed native8 SHA的A06历史health在bundle_identity=fail同时，三项TCC/AX均pass；本次三项变fail，因此不能以“自定义bundle guard造成误报”解释当前健康结果。`capability-doctor.ts`只转读原生health schema，native8的17个patch差异不包含health/permissions实现。Sol继续只读定位基础原生实现及UI同名条目的责任身份差异；当前不能将ON开关当作操作能力验收。


### 原生预检实现独立核验

Sol依据pinned trycua/cua d114f35源码：health各分支独立，TCC/AX来自AXIsProcessTrusted()及CGPreflightScreenCaptureAccess()；并非bundle identity文案派生。证据已存 `R5-private/sol-native8-health-independent-diagnostic.json`。当前App adhoc designated requirement为cdhash a47177…；同目录四rollback复用bundle ID且有相同显示名但不同CDHash，系统同名ON可能指旧路径/设计要求仅为待证假设。唯一GUI执行者只读核条目精确路径，另可同owned socket check_permissions(prompt:false)核责任身份，不触发权限索取。未经当前实际TCC/AX通过不启动Runtime/preview；真实capture另证，health本身不探测capture。


限定补充：`check_permissions` 的source.attribution只识别CuaDriverLocal.app/CuaDriver.app路径，CaptureFix将被硬编码标caller/bundle_id=null，不能据此认定真实OS责任身份或更换bundle。仅其实时权限布尔用于二次预检；UI精确路径/当前签名要求仍需正常系统核验。


### 两系统授权条目精确路径已确认，重新添加待用户确认

Luna分别从辅助功能和屏幕录制同名行“在访达中显示”，均确认指向主工作树 `.tools/cua-driver/CuaDriverCaptureFix.app`，并非四个rollback。证据 `R5-private/permission-ui-identity-20261013T0450Z/settings-finder-identity.json` SHA b36400e8b763a211bfe3da4349407007e411013279438855bbd957537afd3d67。实际live schema核后同owned PID48867/socket执行check_permissions({prompt:false})并end：accessibility=false、screen_recording=false；无capture/input。source caller标签不作为实际责任身份证明。

当前最小标准修复候选：仅移除这两个已证精确App条目，再从精确绝对路径重新添加开启，保留其他App/rollback不动。CUA权限变更动作时确认规则要求此不同于原off/on的新操作即时确认；Root已提问，尚未收到答复，故无移除/重新添加动作。本人认证仍必须用户完成。


## 2026-10-13 重加授权修复通过

用户明确授权后，Luna只对当前精确App两记录进行系统UI移除/重新添加，未需新本人认证。一次正常owned重开为PID51462/51463、socket `/private/tmp/ch-r5-readd-health-20261013.sock`，same native8 SHA/CDHash；health TCCaccessibility、TCCscreenrecording、AX全部pass，check_permissions(prompt:false)亦true/true，session已end。custom bundle canonical-only fail继续记录，不换binary不删guard；capture skip仍不能当实际capture通过。证据 `R5-private/readd-permission-refresh-20261013T0503Z/` health+permissions SHA537d6fcb045202ee82d92ac389c63d57f325c758d8ea55e260c6f4a59aa7b91c。下一步仅正常capture能力和fresh TextEdit两空白窗口准备，尚无Runtime/预览/正式原卡通过，无真实Provider请求。


## 实际捕获与新窗口准备

Sol基础源核验：startSession.desktopUnlocked为旧capture-scope policy Auto默认false，只在正式escalate中改true，并非macOS登录锁屏状态；证据 `R5-private/sol-desktop-unlocked-field-readonly-review.json`。Luna fresh CUA看正常系统界面，实际capture生成3024x1964 PNG、1482339B、SHA8e31ce05cb70a0dfc3fc17f5a609f20a00ead84e9a3d1f5e016c55b1cbd90074，Root已查看确为实际桌面像素，非锁屏。首次因URL编码误用路径未生成PNG仅为无结论失败，后用真实文件系统路径成功；session已end。

新建TextEdit同PID52147两份空白未保存窗口：primary3605（未命名5）、recovery3610（未命名6），fresh原生inventory与AX映射，未输入正文/未保存关闭。准备收据 `R5-private/desktop-prep-20261013T0520Z-a4c86f58-ae82-45c7-960e-b1443c1d93da/desktop-prep-receipt.json`；这是准备身份，执行前必须fresh复核，不能复用已消失窗口。profile另需新pair，新scratch/output仍absent。尚无Runtime/预览/正式原卡结果、0真实Provider。


## 普通恢复一次诊断执行门

两窗exact get_window_state真实PNG均valid、matched、one-shot available，primary3605/PID52147 SHA bce6fd15410daedfba4bab773b3a8dbf7ca7d6c71758e11fcf44d058c827c6b8，recovery3610 SHA3988b9296bfa7f5b549f7baa9af0437c8a5fa2f69361e3ce0fca8a47615027bb。原生frame_freshness=unknown保留，不伪造；捕获动作时间、前后exact inventory及实际PNG另证本次获取。候选 `R5-private/ordinary-candidate-20261013-ceca12ac-62c5-4977-ad22-65f660de4e8f/`。

R5参数化ordinary/profile两脚本已Luna实施、Sol修正复审冻结，static check无SDK/service/scratch/output副作用；四mjs语法通过。Sol回执SHA1d4f0a1ec8d33e5ec110f96b0b4a2f74b2f6a961abcd7f14d50ed962562cdf92，Root六文件逐SHA一致，另实核全92源/dist及Web4资产。已落 `R5-private/root-ordinary-execution-gate.json`，仅授权唯一GUI执行者fresh核门后运行一次ordinary零真实Provider关闭空白→正式恢复→fresh observation诊断。profile需另freshpair，preview/付费任务不在此门中。尚未收到ordinary执行结果，不能提前记通过。


## 普通恢复首个现场Run：输入前拒绝

唯一一次ordinary execute生成Run run-1791869139438-22a6806c-f61，finished/failed，退出1；仅run.created/run.started/computer.open.started，open目标PID52147/CGID3605时observed/focused3605但独立frontmost3622不一致，exact_verified=false，明确no capture/no input sent。未到关闭/list/switch/handoff，Provider调用0/真实请求0。handle.close无异常，后续list_sessions为空，native51463仍持有socket。证据 `R5-private/2718e4cd-4e53-4127-9e24-4832c65e5d5a/`，proof SHA84e7f7a75cb171362218e882ee95a4bae143afeb7bddd9c2cef06ef9e9984c39，trajectory SHA dc04e96d8532a24d3b57d7dabe44ef4f988b3d6a4cafe247fe87da3c140a1b27。执行者立即停止，没有重放。

Sol核是否为同PID Window浮层/菜单导致真实前台保护拒绝；需依据当前UI而非推断，不能删focusguard。若确证输入前无效果且仅正常UI预置修复，新Run需新scratch/记录，不能复活旧Run或对unknown重放。当前普通恢复未通过。


## 用户再次授权继续与清理证据纠正

用户已再次明确持续推进Astra三线，不以本轮修复结束为停止条件。Root重新核HEAD594fa8e、apps/packages无tracked变更，按Sol协调/检查、Luna唯一桌面执行继续。两计划顶部已改为当前T3集成与现场真实状态，避免历史972或T3未实施快照覆盖最新事实。

Sol对首个ordinary失败的限定：bring_to_front可能改变焦点，no-effect只限无内容操作/捕获/Provider；新transport list_sessions为空不是旧transport session确证结束，handle.close无抛错也不足排除completion收集的cleanup failures。继续先核旧会话owner清理/无pending、当前UI及3622来源，保留前台guard。新Run仅在fresh身份与清理证据后分配新UUID/scratch；不恢复旧Run，不重放unknown。


## 再续接：旧连接代际隔离与清理报告补证

Luna fresh只读看到TextEdit Open对话框，未证当前3622为菜单；不沿用旧菜单假设。owned native51462/51463仍在，未见本任务Host/Relay/runner。旧proof未存Run report.cleanupDiagnostics，Sol核handle.close不抛错不等于清理通过；无法追溯补写原会话成功。独检 `R5-private/sol-r5-resume-cleanup-contract-review.json`。

Root授权唯一执行者先核无activebusiness/paid/nativeclient，再仅正常停止已证owned native pair并重开同签名native8/new socket，以旧进程消失和无listener证明代际资源终结；不倒写旧endSession成功，不改TCC/签名/canonical。Open对话框可正常Cancel，fresh自有blankpair另证。ignored ordinary runner将最小追加 await handle.report()持久化及cleanupDiagnostics=[]断言，经Sol复审后再放一次新UUID Run；旧Run仍failed，0内容输入/Provider，不能恢复重放。


## 2026-10-14 续接：代际资源已终结，新清理报告脚本通过独检

北京时间已进入10/14，旧13日窗口收据均不作当前现场门。执行者核无本任务业务服务/Run后正常停止owned native51462/51463，确认gone及旧socket无owner/listener；旧socket节点保留。正常重开同签名native8为10881/10882，新socket `/private/tmp/ch-r5-resume-20261013-155600-a71343cc.sock`（UTC命名），新health15:58:31Z SDK/version/platform/session/TCC/AX通过，permissions true/true，session end active:false。原始证据实际文件 `R5-private/resume-20261013T155600Z/health-and-permissions.json`，此前口头native-health.json为文件名误记。该代际边界终结旧连接，不补写旧会话endSession成功。旧3605/3610已消失，当前Open dialog CGID7065，执行者正常取消并准备新空白pair。

ordinary runner仅新增report持久化及cleanupDiagnostics空数组断言，最终SHA4c5832157ac458bcf76b5a6ca5cd54ca8918ec42dd81801433ba41ddbdfc6030；Sol静态独检/语法通过，剔除新增块还原旧文件SHA一致，其余五文件未变。新staticreview SHA7a7714cfeef0a8f032f0ce9d3e01253a6c1cf6d245501fdbefdadb5334069204，尚未新execute。

离线评测准备：已核外部evaluator worktree清洁、HEAD3f22c308b1b6c762b6dc52c3206a7e07154f7dc4/入口hash一致，T2三模板的Run/trajectory/终态均明确pending，索引16证据路径存在；`R5-private/r6-resume/INDEX.md`。模板不计业务或真人通过，尚无本轮Provider请求。


### 10/14 离线评测独检及当前UI准备限定

Sol R6独检已核三卡/rawgoal/正文及唯一路径替换、输出absent，三manifest Run/trajectory/terminal均pending/null；INDEX 16链接全存在，评测器HEAD与entryhash一致、工作树clean。收据 `R5-private/sol-r6-offline-review-20261014.json` SHA566720bb3a4956de7395890fa5e9cbfe6f70c6baf4dd517f4686fb5f9eea4dcf。没有运行评测器或产生验收结果。

GUI当前原Open ID7065已被系统替换为7113；一次正常exact Escape返回unverifiable，后Open条目offscreen，不能仅CUA AX仍列举就判仍可见。执行者先核当前可见UI及完整/onscreen原生inventory，无可见面板则正常New自有空白；只有确实可见阻挡时才正常精确激活/Cancel，保留foreground guard，不盲重抬已隐藏旧pane。没有新ordinary Run或Provider。


## 2026-10-14 共享控制浮层分类问题已定位，未绕过

两份新空白文稿已正常建立/真实像素与AX零字节通过，但exact激活仍focused7150与frontmost小Window不同，未启动Run。小Window(66x20)现有真实AX为AXWindow[id=_NS:8]→AXButton WindowSharingSessionButton[press]，PNG显示紫色共享控制，属于可点击遮挡物，不能按尺寸/标题/同PID忽略，不能关闭系统共享标记规避问题。证据交Sol独检。保留源代码显示ordinary仅按layer0和z-order排序，缺AX类型分类；当前确切native8源码临时目录已失效，先在持久隔离目录恢复pinned d114+六patch+after-six完整闭包并核17hash/基底bring_to_front行为，再决定最小修复。当前不改前台保护、没有新增Run或Provider。

594离线Preview候选发布包已完成allowlist copy与Relay bytes/layout/Web4闭包校验，包SHA29dcc6ea3219d85f280925a1c6e062a642f5c379026bd8bea8d2bb482a623867，位置 `R6-private/preview-release-594fa8e-preparation/`。没有build/部署/切生产/手机验收；不得将候选包当上线结果。


### 原生源码闭包恢复的具体线索

Root核六patch+after-six的17触及清单不含bring_to_front，firstexactcapturepatch仅capture.rs；当前binary的exact-foreground字段则对应历史F005/F018。保留 `docs/a-line-sync/diagnostics/F-20261007-018/native.patch` 含main、macos/lib、diagnostic_preflight及独立测试、bring_to_front；F005为bring单文件，F013为diagnostic四文件。恢复时分别保留纯d114+六+after6与历史F018变体，核累计关系和实际安全合同，不得静默补patch或只17match宣称全部源码对应binary。F015纯Windows不展开。

共享pill真实AXWindow子AXButton可press，不能从AXWindow角色、尺寸、标题、同PID推安全忽略。任何候选普通窗口分类必须保留真实modal/别文稿/unknown拒绝及点命中遮挡检查；先恢复精确源，当前不构建/安装新binary、无新Run或模型调用。


### 完整源已恢复，下一受控归因是捕获对象释放

已在持久ignored `R5-private/native8-source-recovery/` 从公开trycua/cua pinned d114/tree1be75321ea36185d2fd660107785c07cc1daa67c恢复纯17变体及F018-on-17变体；17哈希全相等且F018增五文件不改变17。F018 bring文件与历史F005候选一致，但不追认旧binary五路径源码绑定。新候选可由完整、明确保留F018安全合同的baseline前向建立来源。

Sol读pinned capture.rs确认SCScreenshotManager one-shot，但SCContentFilter/SCStreamConfiguration Plan由staticcache Arc保留，2秒TTL只惰性清理；成功返回无主动evict，模块无session-clear。这不证明持续录制或共享pill因果。Root已授权一次native-only对照：无业务client下停旧owned代际，newdaemon首capture前CGinventory，再仅一个自有blank一次capture，随后0/3/10秒CGinventory；整个对照不用CUA截图/输入避免另一客户端影响，不碰共享按钮/隐私标记。待真实结果决定是否最小释放Plan而非分类豁免。

Preview594候选经Sol独检：tar/38payload及内部5链接、Web4/11运行文件内存转译、Relaybytes/layout均通过；runtimeLoaded/processAttested=false，未部署。独检 `R6-private/sol-preview-594-offline-independent-review.json` SHAa0f628fcff9cde3188649b45edc7e7b42da156eaf0e0c2fe75b6170b99d0f070。


### native-only一次对照结果：未证明cache为共享pill主因

仅正常停止owned10881/10882并重开同签名native8为13987/13989、新socket `/private/tmp/ch-r5-control-20261014-162200Z-029ed1c8.sock`，必需health/TCC/AX通过。整个对照不用CUA/不输入/不激活/不Run。在newdaemon首次window capture前旧pill7168/7171已存在；仅一次capture自有blank7150，0.246秒返回有效68849B PNG、AX0字节；随后3秒/10秒两pill ID/位置均未变，session end active:false。raw `R5-private/generation-capture-control-20261014T0021Z-44ebfacb-90a3-48ec-bc63-6ae18b5da341/one-shot-control-receipt.json`。

此结果不能支持旧daemon/Plan cache为pill存在必要原因，不直接以resourcefix声称解决。cache惰性TTL风险独立保留。当前进一步审最小ordinary分类：真实AX共享按钮特征、非文稿/非modal/非focused、exact窗证明与unknown拒绝；点命中occluder必须保留。恢复的F018-on-17完整baseline将先独检/测试构建，旧binary五source绑定未证不追认。


## native9隔离实施已获Root门控

完整baseline独立source审查及构建收据通过，436workspace files/381.rs，395pass/2ignore、check/release0、fmt1(F018格式)保留。Root已读Sol最小设计SHA4fa8680a58cbcc516eb7a2924413caa4b4c45eefc0567c1a6cdbb7c0067a460f并授权Luna从冻结baseline另建native9variant实施。范围只ordinary排序+固定enum诊断，保留点遮挡、前台其他拒绝、capture与输入行为；checked bounded AX与受信目标app语义、exact identifier/title/description fallback、模态/焦点/错误/多节点/陈旧证据均保留阻断，不能以尺寸/标题/同PID或TextEdit特例豁免。必须有负例、全nativecheck/test/fmt/release及新完整来源/patch，再Sol复审，未安装/签名/运行候选。

现有MCP56工具不暴露原始AX属性，schema审计无新capture，sessionendactivefalse；新classifier在native内读原始属性并出bounded诊断，不要求现MCP提供不存在字段。Root同时交唯一现场执行者最多一次已有可信远端的sanitized只读Preview状态核验，不发布/上传/切生产/认证；缺已证配置即保留缺口，不猜主机/密钥。


## 2026-10-14 T1正常Web并行准备（未Start）

Sol确认T1纯网页任务可与TextEdit恢复/共享pill修复分离；normal managedBrowser仍用native bootstrap及Browser自身exactfocus/capture门，不能声称DOM-only旁路。只解除TextEditblankpair作为T1前置，保留正常Web明确Browser模式、defaultlayered/生产Guard/风险模型、sourceLinkedFinish默认optin省略。原baseline卡SHA42485b83cc47c35ba09f77858096fd7bf61bd6018daf93a35c7575667b7e14f4，唯一goal793UTF8B/SHAf84e0557bcc4c36f9b3225938380a9adb63ffe059963c8412b0faf6570eaa264、无末LF，不套用T2末LF。

唯一现场执行者先准备全新officialboundedbatch+40main/2risk首reservation、监控ready-before-firstProvider、新Host/Relay/正常Web配对及当前native身份/健康；A07/global历史不变。Root+Sol检查后再Start，native9仅隔离构建，T1活跃时不安装候选/切Settings/抢GUI。评测保持独立来源/事实/输出/cleanup及真人分栏。审查 `R5-private/sol-t1-browser-launch-dependency-review-20261014.json`。此条未新增Run或真实Provider。


### A08正式初始化已核，尚未Start

Sol直接读取实际counter核A08、reservation T1-baseline-managed-browser-L3-20261014，limits120main/12risk/132、首reserve40/2/42、actual0/0/0、sequence0、anchor存在。旧stdout写A01不作为ID证据，旧prestartplan“未初始化”为历史准备快照。A07及全局498actual/30unknown保持不变。新monitor/Host生产配置/实际Webgoal收据尚待，Root未放行Start。

native9隔离初稿已完成sharing classifier及bring ordinary接线，point occlusion未改；Sol初审反馈全局窗口数量不应变新guard门，以及VisibleChildren/Sheets的类型化空数组/同子节点处理，作者正定向编译修正。此为实施中状态，尚无最终独检/native9发布/实机结果。


### 10/14 T1正常GUI配对已完成，尚未Start

CUA createBrowserTab/getState多次timeout不是已证用户活动拒绝；执行者无盲重试，用正常nativeSDK GUI打开新private0700 ControllerChrome profile，精确PID24577/CGID7186，localhost4317 Host console，不读personalcookies/DOM、不API造Run。正常Connect UI生成新一次性challenge，同一freshprofile进入pairlink，唯一pending“手机浏览器”被准确Connect AX按钮批准，页面显示“手机已连接”。这是桌面Web client与directHost local配对，非实体手机/Relay链通过。当前正从配对tab进入任务列表并核实际goal与配置，未Start/Provider。

A08监控到期修复经Sol静审通过：900s fresh核同Host/session/exactRun且active才一次logicalabort，terminal/mismatch/unknown不取消，30s有界终态等待；readiness先于Runtime start接缝保留。新收据 `A08-private/sol-a08-deadline-static-review.json` SHA90ff40ef2dd08a76ba66310e169e6ba80dcc0b07f06ec14a43f78929006577c3。native9三静审问题已修，定向/完整原生404测试和checks通过，最终format/release与离线独立签名候选打包进行中，不改当前native8或T1服务。

### 2026-10-14 native9 最终离线独检

Sol 最终独检通过：437 个源码文件哈希与五文件增量补丁严格重放一致，404 项平台库测试通过（0 失败、2 忽略），fmt/check/release 构建通过；App 二进制、plist、签名一致。文件节计数已排除 thread zerofill，从 38 更正为 37，全部签名前后字节一致，未更改二进制。Root 独立复核签名包 SHA、plist SHA 与严格 codesign 验证均通过，收据 `R5-private/root-native9-frozen-app-verification-20261014.json`。这些是离线证据，不代表现场激活或手机验收。T1 准备期间保持 native8 与 594 源码冻结。

### A08 实际预启动审查发现及修复中

Sol 已从实际 Web 读回收据核对 T1 goal 793 UTF-8 字节及 SHA 完全一致，Browser/crossWindow 配置为真。实际 Host argv 使用绝对 batch-host.mjs 路径，而 private monitor 用相对路径字面值匹配；这会使真实 monitor 拒绝就绪，不能 Start。Root 已交唯一执行者修正为 exact resolved 绝对脚本路径，并添加实际绝对 argv 正例和同 basename 错目录负例，不放宽身份匹配。修复和独检前仍不启动、不消费 Provider。

### A08 单次 T1 正常 Web Start 放行

实际 prestart v2 及 Sol 最终独检通过，Root 复核 793B 无末 LF 原始 goal、四个 monitor/test 文件哈希、preloader、卡片及 594 HEAD/apps/packages clean。已保存 `A08-private/root-single-t1-start-gate-20261014.json`，放行唯一现场执行者正常 Web Start 一次：40 main/2 risk 首 reservation、生产 layered/same，现有 native8 不变。真实 Run ready 必须在其默认 starter 内先于 Provider，不要求创建 Run 前已有 ready。401 未认证查询不作为无 Run 证明；此前新 Host、output 空、从未 Start、counter0 是保留证据。未知 Start 结果不得重按。启动后的业务结果、cleanup 与实际用量另审，桌面 direct Host 不算 Relay/手机验收。

### native9 可重放交付源码准备

已将最终独检增量原样保存为 `patches/cua-driver/d114f35-macos-sharing-control-after-f018.patch`（SHA4a0d6112699ab059ddebc09bd2b5f778ab1f6e6c3e01ab03b0ed9f83f59a1c49），并保存 `patches/cua-driver/native9-source-chain.json`：明确 d114 upstream → 六补丁 → after-six complete → F018 → native9 增量的唯一顺序和每步 SHA。九项补丁实际文件哈希核对一致；不叠加 native7，不将新基线追认为旧 native8 的源码证明。仅准备可交付源码与审计清单，未提交/应用到运行源码，594 Live 冻结不变，现场验收仍待。

Sol 顺带独核交付 source-chain：九个文件路径/哈希及顺序全部一致，manifest SHA c7092348fc6ca02934909747c220c22b3bbf46c665ae84996daa11d94f292442；增量原样，offline/live pending 与旧二进制边界正确。未重复既有 437 文件审计，不改运行 HEAD。

### A08 首次 Start 形成空 Run，尚无业务执行证据

执行者按 gate 只点击一次，生成 `run-1791912019279-9dd3ec1a-f19`，UI 报通用“电脑服务遇到问题”。Sol 独读该目录为空，无 trajectory/monitor/starter-ready，A08 counter 仍 sequence0/actual0；这不构成业务执行或 monitor-ready 通过。保持不重按，正在取实际启动异常。Root 另外从源码发现 private preload 四个 JSON 写入使用双反斜杠 n，疑似产生 JSON 外 literal suffix；已交执行者/Sol 以实际 session 内存解析及错误核因，不输出认证内容，当前尚不将其猜测写成唯一 Run 原因。

后续核实：真实 controller session 及 pairing allowlist 均不存在，不能将首次 Start 写成 JSON.parse 失败。四处 JSON newline 编码 bug 独立确认需要修；当前 starter fixture 自身 sessionJson/Host entry 写盘也存在同类编码，先前“4/4 pass”为作者报告，Root 已要求保存完整命令/日志/exit 并核对矛盾，修后冻结文件再独立执行。下一次正常配对须在实际 requestId 已知时创建精确 owned0600 allowlist，再实际 issueSession 捕获；不能把 fixture 的手造 session 当现场准备。旧 Run 保留，counter0 不变。

Sol 独核确认上述测试矛盾：sessionJson 及 Host entry 尾部均 literal\\n，正常执行当前字节不应出现首 fixture 通过。未找到持久化完整 TAP/exit 收据；原“4 starter fixtures pass”降为未独证，不再作为放行依据。Root 已实际执行 Python policy 四项通过，此证据独立保留。下一次须冻结修复后的源码 SHA，Root 真实执行 node --test 并保存完整 TAP 和 exit，不以作者摘要替代。

### Preview 新版本部署事务静态准备完成

Luna 准备全新 594 Preview stage/apply/rollback 事务，Sol 修后静审通过：脚本 SHA fdf70870cda193fc2aeec832bb5f10daa3a5c46ed06acbd8c9b9022a5a81b343，最终 manifest SHA 497088d5fd1c6da31abc25ae38ae69fb81bfc74e42d4da07f839aa78733dbbfd。严格匹配 Preview unit/唯一 ExecStart argv，共用无 symlink/root0755 路径 anchor，固定旧六 Web 资产 disk/HTTP 哈希；旧 remote receipt 陈旧须现场重核。审查 `R6-private/sol-preview-transaction-r6-revised-static-review.json` SHA209e11d28695598724f034992fe4a491c7aee9f4fcba247d0ba2aa501118da6c。尚未 SSH/upload/stage/apply/rollback，不构成部署通过；stable 不在变更范围。

### A08 修后 Root 真实独跑通过

Luna 修复 private preload 四个 JSON 输出及 fixture 写盘为显式 LF；positive fixture 经实际 installA08T1PairingSessionCapture 包装的 fake PairingStore.issueSession 写盘、JSON.parse、默认 starter binding、真实 Python monitor-ready。Root 先核冻结 SHA（preload c8cc25018fa2dbc6eb37299574d58423733ce9c293cc4e04898a8d91f2fcf17c / test9c7007519aeead74b122e56bbf5d7bb6284d7d66f17392e29125d19aba45fee5），再实际执行完整 node --test：4 pass/0 fail/exit0，TAP SHA4e0dbf198bfa5637176412428e1331fbc796fd157de3f1822c3f3de115de070b。完整命令、exit、日志哈希保存在 `A08-private/root-a08-paircapture-starter-test-receipt-20261014.json`。此新证据替代先前未独证摘要，不抹旧矛盾。未真实 Provider/GUI；正常 owned Host 重启和 fresh UI 配对正在进行，新 Start 仍需新的实际 prestart gate。

Sol 对 LF 修复和 Root TAP 收据复核通过（`A08-private/sol-a08-paircapture-lf-fix-review.json`，SHAd67e293f009fab8e6db73767dc83e065549ae112ff09c3dbe1d787cc3caa2876）：positive 使用真实 preload 捕获 hook，但 PairingStore/createRun/controller 为 mock；不是生产 PairingStore 或现场配对证明。执行者已 fresh 核旧 Host23866 exact identity 后正常 TERM，旧进程/监听消失；新 Host31264 UID501/lstart Wed Oct14 01:26:05 2026，command SHA8017785e321bbdabeef2df97be99cac8cef1c62cd9c175dc007bb3e9ba594419，新的0600日志绑定，监听4317/HTTP200。新现场配对准备进行中，尚无新的 Start。

新配对 GUI 导航诊断：执行者在新标签页 AX 地址值与 localhost Connect 匹配，但默认 background press_key 两次均 unverifiable，页面未加载，未生成 pairing request。Root 从实际调用脚本确认未传 delivery_mode，并从恢复的完整 press_key 源码确认 background PID 与显式 foreground exact-window 守卫/HID 为不同路径；已交执行者先核实际工具 schema，再鲜核 exactCGID/焦点及地址，最多一次显式 foreground 导航诊断。只针对自建 localhost 页且不存在业务操作，不泛化为重放未知操作许可；guard 拒绝即保留阻断，不广播。恢复源码不作为旧 native8 五文件来源闭包证明。

前台导航诊断：显式 foreground RETURN 仍 unverifiable，随后 fresh AX 地址框像素 focus 点击被前台守卫明确拒绝，focusedWindow=7192 但 frontmostPid=20333 而 targetChrome=24577，point-hit 未执行、无鼠标派发。未再按 Return。CG 列表 top 不等于 App 前台已被证据区分。Root 授权一次新的 exact bring_to_front 诊断，只有实际 exact_verified 与 fresh 焦点通过才恢复正常导航；拒绝则保留，不改守卫。尚无新的 Run/Provider，session/allowlist未生成。

新的 exact bring_to_front 诊断返回 activated / bring_to_front_exact_window_verified，fresh 前后均绑定自有 Chrome24577/7192，session end active:false。Root 已读取 `A08-private/browser-prep/bring-controller-exact-once-20261014.json` 复核 code/身份/清理；继续 fresh per-action guard 下的正常导航，不将该次激活当持续焦点保证。

精确激活后 fresh 像素点击仍被同一 frontmost20333 拒绝且无输入；执行者停止。Root 只读 `ps -p 20333 -o pid=,comm=` 查明该进程为 macOS UserNotificationCenter（系统通知中心组件），不是 Chrome。已交唯一现场执行者只读枚举/AX 核具体系统面板，不点击未知权限/通知按钮，不继续重复 Chrome 输入。此处未推测通知内容，也未将进程名当可关闭授权。

### Preview 阶段 1 传输与暂存放行

Sol 对新版八文件包、固定 source pins/sidecars、quoted alias/UUID/knownhost 命令和实际本地负测独检通过（review SHA80c7901a968cd10cd76fdc370adb225ea99816390a1d0610e0ace4481246a946）。Root 已保存 `R6-private/root-preview-stage1-gate-20261014.json`，仅放行唯一现场执行者在可信既有 Preview SSH 上 fresh HOME UUID 上传八个固定0600文件、远端哈希/mode核、inspect、一次 stage 及下载 sanitized receipt。不含 apply/sudo/service/current/stable/生产切换；未知传输/暂存结果先只读核，不重放或覆盖。实际尚待执行，不能计部署完成。

UserNotificationCenter 只读核验只列不可见窗2607，无可见通知/授权/认证面板，因此未读取窗口内容、未关闭系统组件。Root 单独 fresh Swift AppKit 查询返回 Chrome24577；执行者保存近邻对照 `A08-private/browser-prep/compare-frontmost-readonly-20261014.json`：Swift17:38:58.449Z24577，daemon documented list_apps17:38:59.404Z24577 active=true（64858 false）。这不是点击守卫内部 NSWorkspace oracle 的同时同源测量，不能覆盖旧拒绝或定因 stale；Luna 离线继续核 list_apps/bring/click 三路来源，不改冻结 native9。GUI 暂停输入，唯一现场执行者可先做已放行 Preview 阶段1。

阶段1目标澄清：旧只读收据保存了实际 user@host 及已核 ED25519 fingerprint，但没有 SSH-config alias。Root 的 alias-only 描述是实现约束，非用户限制；已更新 gate 允许同一已验证 exact destination 字符串，保留 quoted/ASCII/--/BatchMode/StrictHostKeyChecking 与固定 trustFingerprint，不需用户提供别名或新凭据。未引入新主机、未放宽信任。

### Preview 阶段1首次连接：认证前失败，未远端暂存

唯一现场执行者本地 verify-package exit0 后，freshUUID ede802ea-fcf7-4a3d-93a2-74d9a77d9b72 的 remote mkdir SSH 在认证前 exit255 / Permission denied(publickey,password)，未上传、inspect、stage，未重试。实际收据 `R6-private/preview-stage1-execution-20261014.json`。Root 交执行者核本任务此前16:41成功只读连接的准确已授权选项是否遗漏，仅连接元数据，不读取凭据；若恢复已成功准确选项，先BatchMode只读确认再新的UUID，不复用失败UUID。需要新密码/凭据则保持认证边界，不绕过。

Luna 离线源码审计：list_apps active 走 NSRunningApplication.isActive，click frontmost 走 NSWorkspace.frontmostApplication，bring 使用 WindowServer exactPSN/AX/CG 三项证据；daemon 非PiP/cursor条件下主线程 joinserve、Tokio worker 调 AppKit，支持runloop相关假说但不证实当前根因。未修改native9或弱化point/focus守卫；Sol正在设计可证伪只读下一步。

### 下一隔离只读 oracle 诊断候选获准实施

Root 已读取 Sol 设计 SHA83dad6c87537304e38240171303a770ee15eb04655ebcc2744f040bfa0c3d28d，授权 Luna 从冻结 native9 另建 native10-diagnostic：只新增明示只读 tool/注册/负例，0/100/300ms 下 shared500ms deadline typedunknown，记录 AppKit/WindowServer exactPSN前后/AXfocusedowner/CGpoint+ordinary 无文本证据。禁止 activation/warp/输入/setter/capture/mainloop改变，不加 optional mainthread dispatch；现有任何 guard 不改。先 Sol 审最小源码、定向及完整locked tests/check/fmt/release，再决定候选现场权限，当前不安装/签名/启动/TCC。此为诊断准备，不把runloop假说当已证根因。

现场独立替代准备：不在旧新标签反复 Enter，正常 LaunchServices 启动另一个自建0700 Chrome profile及initial localhost Connect URL，新 PID35258/CGID7213，exact bring code verified，AX页面标题为 Harness 控制台。只是恢复正常入口，仍按 normalUI pairing→精确allowlist→实际sessionfile核，尚未新 Start。远端 SSH 当前认证边界保留。

Root 准备一次受控同 native8 代际对照（`A08-private/root-native8-generation-foreground-control-20261014.json`）：新专用 Chrome active 状态下，fresh核所有owned身份与无其他active session后正常重启同签名驱动到新socket、对应ownedHost加载新socket；不改guard/二进制/权限，不删除旧socket或Run。先官方只读 GET pairing核旧AX按钮是否生成challenge，再决定正常UI下一步，不以界面无变化断言noeffect。此对照仅测代际变量，不预先证明cache根因、不放行Run。

代际对照前置：daemon list_sessions 为0，CG 仍列35258/7213，而 daemon list_apps 指旧Chrome24577且未列35258。执行者在任何 TERM/click 前停下。Root 澄清门控要求是独立 fresh Swift+OS 进程/CG exact ownership；daemon AppKit list 不作为替代，分歧本身是对照变量，不可用来放行输入。若 Swift 不是自有35258，仅允许一次正常 exact 激活后重核；未知仍停止。尚未发生本次代际重启。

Root 再次独立 Swift 查询实际 frontmost35258/com.google.Chrome，OS ps核35258 UID501/lstart Wed Oct14 01:44:36 2026。执行者也核其自建profile/CG7213；SDK同一连接list_windows后短暂出现的visible session，在连接关闭后独立transport list_sessions为0，未将其作可重放许可。daemon list_apps仍旧24577，保留为不同oracle证据；正在继续已放行受控同binary重启。

受控代际执行：旧owned13987/13989正常 SIGTERM 后均消失，旧socket无listener且inode54165304保留。首次 LaunchServices 使用相对App路径返回exit1、stderr未持久（证据缺项保留）；fresh核无新服务/1757Z socket/lsof owner。Root交执行者正常改为已核同App绝对路径及全新socket，保存stdout/stderr/exit继续恢复，不重新索取用户许可、不改binary/权限/guard。Host暂仍绑定旧socket，未有新Run/Provider。

同 native8 新代际启动成功：PID40372/40373 UID501，新socket `/private/tmp/ch-r5-control-20261014-1758Z-d766ea60-13b2-4aca-abae-0c46904ac7f6.sock` mode0600/inode54292435，SHA/CDHash精确同旧版本；执行者 health核 version/platform/TCC AX/ScreenRecording pass，仅known canonical bundle_identity fail及capturecapability skip，外部list_sessions0，Swift仍35258。收据 `A08-private/native8-generation-health-20261014.json`。接续正常owned Host31264更新socket重启，尚未新Run/Provider。

native10 只读tool三path初审有三项待修：caller timeout后实际worker仍可能运行，需singleflight占用持有至真实退出；返回AX窗口需设remaining timeout；AppKit缺失不得误判oracle disagreement。Sol已交Luna具体修法与真实worker timeout/gate retention负例。guard/input/capture保持未改，4项定向分类测试仅作者初稿结果，不代表最终候选全验证。

新代际一次真实 foreground pixel click 已经通过 guard 并派发，route global_input/effect unverifiable，官方 GET 仍 no challenge/requests0，未计按钮成功。此前 local syntax/schema/import 错误均 pre-dispatch保留。Root 实际查看截图，156/532 位于蓝色按钮内，但仍须核 screenshot resize-registry/实际点击映射，不能仅截图点位当正确事件证据。

Root 另查得具体状态变量：ConnectPhoneScreen 只在mount getLocalSession，轮询不刷新adminCSRF；当前页面早于 Host40529重启加载，故旧token可能导致POST被拒且4s refresh清error。尚未证该POST实际发生或CSRF拒绝；已授权执行者先只读AX/日志，再正常UI刷新自建页面载当前session，同连接fresh screenshot/geometry，一次guarded按钮动作后立即读AX错误/官方GET，不API POST代替UI、不Start。此为新页面/CSRF变量，未知动作不重放。

### native10 只读诊断候选完整离线独检通过

Sol 最终核 383 个 .rs 源码哈希、native9 上三path delta严格重放、四日志哈希及实际411 pass/0fail/2ignored、fmt/check/release exit0；unsigned artifact SHA e498c51899886087125ed4323def06d32933135fbc0af1fbfc00ecdc7bb93978、30,441,328B符。现有click/bring/getstate/windows/capture逐hash与native9不变；真实5ms recv timeout后gate仍busy、实际退出后释放fixture已核。审查 `R5-private/sol-native10-final-independent-review-20261014.json` SHA3a59d4f9b15053e0ea8cc1b28a4c82574333ba19d5ea6d4df5baf6188e115e58。仅unsigned offline接受，未签名/安装/启动/授权，不代表任何新guardauthority或live通过。

坐标生命周期独检补正：ResizeRegistry 是共享ToolState Arc，未找到start/endSession清ratio；截图snapshot_id s00000001符合非observation_only，所以不能声称不同连接必丢ratio。click自身px_frame也可fresh capture校scale。实际click未保存ratio及最终screenpoint，guardpass不证buttonhit；保留未知，不以假定坐标错误重放。当前优先正常页面刷新及旧CSRF变量验证。

Root 再独立核 native10 四日志SHA及unsignedartifact大小/SHA，并将原样增量保存为 `patches/cua-driver/d114f35-macos-foreground-oracle-diagnostic-after-native9.patch`（b78f6c8e9d76dfddcd015fdf4a56b7778dceb36423f4f429541a2d74087e425f），追加唯一十步来源清单 `patches/cua-driver/native10-diagnostic-source-chain.json`。只读诊断源码可交付准备，不提交/应用到现场；当前主HEAD仍594。

远端认证补充有界变量：Root授权在本机UI验证之后，对完全相同的已信任Preview目标用现有SSH配置增加 macOS UseKeychain=yes / AddKeysToAgent=no / IdentitiesOnly=yes 做一次只读 id -u，保留BatchMode/StrictHostKeyChecking。不换key/host、不ssh-add、不读取/打印/复制key或密码；如有实际系统本人认证则停下请本人。成功仅可新UUID原阶段1，未放行sudo/apply/service。当前尚未执行，不能说认证已恢复。

### native10 独立 App 可审查结果

CuaDriverAstraDiagnostic.app（唯一ID com.trycua.driver.astradiagnostic.local.20261014）已完成独立App签名及Sol最终独检（review SHA642997378568b5a5cc96c5d6ba424a7d629c66638b135d94bc62fff6fc5b8b09）。签后binary SHA500c669124fe9a139da862d7af1b696bbdb443898144d83562e56880dbfe5813、plist SHAd15e52db4f959495fcb4ae3a05b2661bfc3a1472a5bda6cbc0e35c91417a7d48、CDHasha2e0a5058e94a872bc783c7a8c8412dcb768fc4b；37 file-backed非LINKEDIT节与预签artifact一致。Root再次独核两SHA和codesign严格验证exit0，收据 `R5-private/root-native10-frozen-app-verification-20261014.json`。预签输入实际已有linker ad-hoc签名；此前unsigned仅指未作独立App身份重签，不代表无MachO签名。旧native9 App保留未运行；新的诊断App也未启动或授予TCC，后续应以新诊断App取代此前旧候选的待授权对象，现有CaptureFix运行不变。

Root发现并交执行者修正另一个明确配置变量：A08allowedOrigin仅localhost4317，当前任务页却为127.0.0.1。GET读成功不代表POSTOrigin校验通过。将正常UI导航到精确localhost页面后，再一次按钮验证；具体先前错误文本尚未保存，不能追认已证ORIGIN_REJECTED。

### 精确 localhost Origin 挑战生成已证

标准 Chrome 启动 fallback 经后续只读检查已转交到原 owned window7213，AX地址变 localhost:4317/connect，无新增window/未关闭旧窗。该正确origin页面上一次guarded pixel click仍effect unverifiable，但官方GET紧接HTTP200/activeChallenge=true（expiry18:27:47.355Z），构成挑战生成真实业务证据，不能仅凭之前driver效果枚举否定。尚无request/会话/Run。Root重申使用页面可见“在另一浏览器打开配对链接”在自有桌面profile正常UI发起client，不等用户手机、不计手机验收；挑战过期则原UIfresh新码，不复用token/输出secret。

SSH只读UseKeychain认证变量实际仍exit255 Permission denied，无系统认证提示、无远端命令/上传，现停止该路径等待有效既有认证，不反复猜凭据。

### 桌面真实配对请求与精确allowlist已生成

Fresh localhost challenge 的可见 pair-link 原生AX open曾suspected_noop，后一次fresh screenshot-derived guardedpixel真正打开任务profile remote `/pair` 页面（query/private token不回显），官方GET恰好一项pending、challenge消费，页面显示请求已发送。执行者已由当前唯一pending ID内存创建精确ownedUID501/mode0600 allowlist，验证 `A08-private/browser-prep/t1-pairing-allowlist-created-20261014.json`。当前7213为remote pairtab需保留，正在另开自有localhostConnect正常UI批准；尚未approve/issueSession/Run。

本次实际pairclient为既有远端Relay origin，与早先directHost-only准备不同；remoteWeb未部署594，源码版本不得推定594。Host40529后端仍594/frozen，后续Start前由Root+Sol核实际scope/目标/配置/监控；不把Relay页面当实体手机。

Sol 对新T1 launch scope静审意见：原卡normalWebL3/managedBrowser未要求前后端同SHA，故正常remote client→Relay→Host40529/594实际Run可作为“Host594业务＋真实Relay桌面链”实测；远端Web index/assets SHA及版本known/unknown必须单列，不计全594Web已部署验收，不把旧UI状态当新源码行为。保持actualsession、793Bgoal、URL/browser、production layered/same/noSourceLinked及首Provider前ready，Root下一单次gate后可执行，不额外等待Preview部署。未Start，尚无真实Provider。

### 桌面client请求已正常UI批准

先前7226批准点击被自建admin7232遮挡，point guard明确noinput，保留receipt且未重放。Root授权改选明确自有7232精确目标，fresh bring/唯一allowlisted pending/唯一允许按钮通过，一次guarded foregroundpixel后官方GET证 status=approved（`A08-private/browser-prep/approve-pending-on-owned-7232-20261014.json`）。未Provider/Start。正关闭仅自建admin7232、保留7226pairtab，选择remote pairtab等待normalUI issueSession及实际私有会话文件验证。

Root已明确持久委派：任务专用profile内已核自建窗/tab可正常选择/激活/关闭过期或纯管理页，无需逐次Root索许可，仍保持exact身份/每动作guard/未知业务不重放；其他用户窗、系统安全或用户活动拒绝照常停。该项不是守卫豁免。

### 实际配对会话文件已核

正常UI批准后已生成 `A08-private/controller-session-a08-private.json`，执行者只读核regular/non-symlink、UID501、0600、286B、JSON有效、无runId；字段base/origin/deviceId/cookie/csrfToken/commandSequence，base127.0.0.1:4317及originlocalhost:4317为正常directHost abort监控使用，不回显凭据。7226remote pairtab显示手机已连接/已获授权（仅桌面UI标签，不算实体手机），原query已消失，pending0/approved真实，收据 `A08-private/browser-prep/select-issued-pair-tab-7226-20261014.json`。

正在正常打开任务列表先选Browser temporary/URL/crossWindow再填原793Bgoal，避免默认window advice预运行请求；新v3prestart将核actualcounter/Host40529/当前native/remoteWebhash及会话metadata。旧7232正常CmdShiftW为unverifiable未关，未重放；可在持续授权内正常选择/关闭自有管理窗，guard保持。尚不Start。

### 用户已明确授权新诊断 App 两项权限

用户同时答复SharingFix及AstraDiagnostic两个问题，均同意开启辅助功能/屏幕录制。当前选已最终双检的CuaDriverAstraDiagnostic.app（唯一astradiagnostic ID/签后SHA500c...），不再重复索这两项许可；在当前bounded T1终态后正常系统设置办理，不能在active Run切driver。实际本人认证仍请用户在系统面板完成，不收密码。private明确consent收据 `R5-private/human-native10-app-permission-consent-20261014.json`。

T1表单当前已实读：临时空白浏览器radio1、Browser推荐网站起点、原URL exact、跨窗口checkbox1；最后原task-card goal AX读回793B/hash f84e0557...eaa264完整吻合。未Start，执行者正收齐v3实际身份/会话/用量/远端Web哈希。

### 审查更正：原 preload 换行正确（完整SHA重建证明）

Root 发现此前把工具结果对象的 JSON 显示转义误读成源码反斜杠。现从 c8cc 当前版本移除新增 JSON_LINE_END 定义、把四插值分别还原为一个／两个真实反斜杠+n：单反斜杠版本完整SHA恰为原 f8611c92abecb62f9f6b4fe2db03f267e81ca163110a6d0a2214bf248b772c1c；双反斜杠版本为7fa8a730...，不匹配。因此原源码是正确JS LF escape。此前“换行bug已确认”及“原4测试不可能pass”判断撤回；原作者4pass仍为未持久独证历史报告，不能说被源码反证。当前显式LF写法仅等义改写；新增真实capturehook回环测试及Root独跑4pass仍有效。首Run实际allowlist/session不存在、emptyrun/provider0是真实缺口，不能归因换行。详细数值证据 `A08-private/root-original-preload-newline-reconstruction-20261014.json`。Root对此审查失误负责，后续读源码输出raw stdout、以真实字符数量/完整SHA判断，不用JSON显示层计数。

### T1 v3 单次正常 Web Start 正式放行

Sol实际v3独检SHA86825f0cb5faf5089fc0c937827c002cc8648dc6fd8c1df9b5da009d7b874fb3通过；Root再核v3/card/原793Bgoal/五monitor文件SHA、594 HEAD和apps/packages clean，已保存 `A08-private/root-single-t1-start-gate-v3-20261014.json`。允许配对7226正常WebStart新Run一次，40main/2risk首reservation、productionlayered/same/noSourceLinked，Host40529/native40372/40373/socket固定。真实Run内monitorready必须先于首Provider，未知Start不重按，900s exactactive onceabort规则保留。期间不Settings/切native/抢GUI；终态后对账actualknown/unknown/fullcleanup，再办已授权native10新App权限。remoteFrontendunknown/非手机限制继续单列，旧emptyRun保留不复用。


### T1 v3 唯一 Start 已派发，当前 Host 未创建 Run

执行者按 v3 gate 在 owned Chrome35258/CG7226 前台精确目标单次点击开始，原793B goal、URL、temporary Browser、crossWindow均fresh核对。收据 `A08-private/browser-prep/single-t1-start-dispatch-20261014.json` 显示dispatchCount1、isError/degraded=false、effect=unverifiable，SDK会话已end。随后10次间隔约1秒的实际认证GET /api/runs均200、count0；无新runId/host-output，尚无monitor-ready/Provider/业务成果。此为启动效果未知而当前Host无新Run证据，不能重按Start或称T1已验收。继续只读保存页面明确错误与现有链路日志，核无activeRun后办理已授权native10权限；远端前端版本未知的限制保持。


### T1 v3 空目录补正与装配阶段定位

Sol随即独读发现新目录 `run-1791918326994-b8b3d2cd-5e9` 与click同刻创建，目录为空。上条“无host-output”来自执行摘要的错误推断，现撤回：原script仅GET出现Run时枚举output，不能证明目录不存在。当前准确证据为GET runs0、new emptydir、actual0、无monitor/trajectory。源码只读显示ApplicationSession在createRunFactory完成后才记record；factory在mkdir后装配Provider等，异常可形成emptydir且释放lease。尚无具体异常证据，不认定前端未送达或monitor问题。

已委派Luna离线静态追装配依赖，唯一现场执行者固定AX明确错误与请求终结。无公开busy getter，不通过另Start探忙。若UI已明确返回错误，结合GET0/actual0/空轨迹可释放现场；若响应未知，正常停止精确自有Host40529终结潜在pending，保留所有emptyRun后再切已授权新诊断App。禁止重放未知Start或为等待不可取busyAPI无限停滞。


### 旧 Host 已正常结束；Provider 装配配置候选待事实确认

Luna仅对精确自有Host40529发一次SIGTERM，后fresh ps该PID不存在、4317无listener；native8原PID/socket仍在。收据 `A08-private/stop-owned-host-after-unknown-start-20261014.json` SHA90f150e8a8ecad463d8ec37b1e3c152e742baeb075e6b340a8602b56f270ba64。这是Host代际收尾，不冒充Run正常cleanup。整行命令hash与gate不同已保留，UID/lstart/确切A08参数匹配，不追认全部argv字节相等。现可继续已获人类明确授权的新诊断App权限。

Luna离线发现候选根因：本次Host只指定relay env文件，batch wrapper不注入Provider凭据；factory先mkdir、构造lazy writer，然后默认createProvider，缺GLM key会同步throw，足以解释emptydir/GET0/no trajectory/no monitor。实际error/key presence尚未核，当前只能列候选。下一受控启动应先通过既有正常loader验证凭据存在boolean、明确主env继承链并完成安全装配错误诊断；不回显任何秘密、不读取打印env内容、不立即付费重试。native10权限/零Provider诊断与此离线排障并行。


### native10 权限设置已到真实本人认证

用户本轮对AstraDiagnostic确切App/两项权限的明确答复已作为此次设置动作确认，未重复请求许可。Host已退出后，唯一GUI执行者进入系统设置→隐私与安全→辅助功能，点击添加触发真实面板：“隐私与安全性”正在尝试修改系统设置，要求Touch ID或系统密码。执行者未输入/关闭/代填，面板保持；Root已向用户请求在系统面板完成本人认证。此时native10尚未添加/授权/启动，不能报TCC通过。等待期间继续隔离provider配置preflight及合成测试，不触碰认证面板。


### Provider 配置新鲜布尔验证已取得

Root使用Sol已审的??优先级r2隔离脚本，实际正常Node loader三次检查均exit0：当前shell继承false、现有主env正常加载true、现有relayenv正常加载false。只输出非空boolean，无秘密值/长度/hash，无Provider/Run/SDK/HTTP/服务/桌面操作。证据 `A08-private/root-provider-env-presence-20261014.json`。合法现有配置路径位于Desktop/大创/Computer-Harness，先前旧无“大创”路径已不存在，仅保留为历史来源，不能作为当前启动参数。此为新进程的实际事实，不能倒推停止Host40529环境；未来受控Host应由外层Node正常加载主env并保留Host relay loader。尚未重Start，认证面板仍待本人完成。


### 隔离预检修正与独立审查出口

Root实读发现初版preflight使用some(nonblank)与Host的??优先级不一致，可能空primary遮住合法fallback而误报true；初版未放行。Luna改为同??链+trim并补合成反例，Sol独立实际7tests全部pass（TAP `A08-private/sol-provider-env-preflight-r2-20261014.tap`，审据SHA577151da6dfff1909ad2eeda73b364e18e94abc0b9dca2fae09ce521634a439d）。R6已撤回两个Node env-file等价Hostchain的表述：仅主env由outerNode加载，Hostrelay保持undefined-fill。Root真实三项boolean收据另由Sol核SHA/范围通过（审据SHAa332b3b6d87ce5dbe2ab8b16b7604d86c67eb707420ce8a099428c6a18c17b75）。原产品诊断patch只留历史并标superseded，未应用；apps/packages仍无未提交产品源码变化。


### 用户已完成本次系统本人认证，继续权限办理

用户最新回复“已完成”，对应当前辅助功能添加触发的本人认证。Root已交唯一GUI执行者fresh读取面板并继续确切native10两项权限，不重复请求同意；当前尚待实际添加/on与新进程TCC/AX证据，不能仅用户回复计权限通过。离线执行者并行准备主env正常继承的新Host启动链，审查者等待fresh绑定的一次零Provider诊断。


### native10 新权限与健康实际通过

用户本人认证后，唯一执行者正常添加exact冻结AstraDiagnostic App，两列表toggle均on。新wrapper51426/daemon51429 UID501已启动，独立socket ch-native10-diagnostic-20261014-1931Z-1c54fc6e-19bb-438c-92d2-5be737db1931.sock，0600/inode54340299/owner51429。Root实读新health receipt：darwin0.22.2，TCC辅助功能/屏幕录制及AXcap全pass，check_permissions(prompt:false)true/true，无failure，会话end active=false。overall degraded仅自定义bundle与canonical比较fail；capture capability仍skip/未探测，不能说截图通过。AppSHA500c.../CDHasha2e0...冻结不变，未Provider/Run/diagnostic。正在准备fresh owned target的一次只读oracle诊断，输入/gate按30秒新鲜度绑定；无输入保护放宽。证据在native10-diagnostic-app-receipts-20261014目录launch及health两JSON。


### native10 实际路径转义误拒绝（未执行诊断）

Fresh owned task-profile Chrome35258/CG7226已一次exact bring verified，AX无截图probe31元素通过、on-screen uniqueCG/bounds44,78,1200,904/中心644,530、sessionendfalse。下一freshinput采集在SDK前因lsof LC_ALL=C将中文“大创”输出为真实hex UTF8转义字段而exactexe比较拒绝；不是daemon身份变化。实际lsof exit0且escaped字段存在、literal字段不存在，raw fixture收据SHA2527250c63a10511fc079ed89c25c8652b7378cd39298ba185cf6747382a51e0。未写liveinput/nonce、未SDK/diagnostic/Provider。已交Luna隔离修私有runner严格lsof字段解析、真实Unicode/畸形/错path反例并Sol复审，不宽松匹配或更改inputguard。修完再fresh采样一次执行。


### 新鲜度流程改为Root本地绑定；SDK加载阻断已定位

初次input→消息→gate流程超过30秒，runner确定在nonce/SDK前拒绝，v2亦过期未发gate。Root改用受控本地watcher：实际校验同代PID/start/完整binary+CDHash+socket/权限/ownedtarget+bounds+point/20秒采样后原子写30秒gate，actor立即一次execute，未放宽时效。v3input SHA73257c2d76e80ec1c1a40d0fbd96d1c059b3126b34bda1827b9edd9a78a5b626已绑定。

v3nonce已消费，run2dbf5956-eead-497d-bb25-d75346a03c12结果incomplete：SDK包仅exports.import，runner却createRequire加载，报No exports main defined；startAttempted=false/sessionstart及endnull，diagnostic未调用，无Provider/capture/input。旧result/nonce保持，不重放。已交私有runner改用当前Computer-CUA正常ESM loadCuaSdkModule，补实际module-load-only与默认check不import反例，独审后另freshinput/gate；不需新增人类许可，也不改native/Guard。


### 私有runner r4与真实wire字段误拒绝

ESM修复r4 runner SHA1429b0553db299c8b124da5c793fd42f978131f49a135f2330cc05db887a52f1，经Sol审据a727b5859505442f40f138accad85f46de66937debe0ba9cc094c26403e0c65a核11实际tests0fail。Root v4本地watcher绑定freshinput SHA9b347793ca0db9c1210e7fc483d7e00a4d6b34d27bbaa9fc471b2c1f82f36324，唯一runner Run2de76d59-4c9f-41b8-8784-bedf76719ea5在metadata/listTools之后报schema mismatch，startAttempted=false/诊断未调用，nonce保留已消费。

执行者随即只读metadata/listTools（无session）固定真实wire，收据SHAbe247f151d448d746c8a2354963da97d5e76fa12211a81c506fe54d5cbcfd51c，PID51429/0.22.2、57tools、诊断tool唯一，实际字段input_schema，runner却查inputSchema。required/properties/additionalProperties与冻结Rust合同完全吻合，属于私有runner确定误拒绝，不是原生诊断失败或TCC问题。已交最小r5 snakecase+真实wirefixture/缺错字段反例，审后新gate执行；旧调用未诊断，无未知原生副作用重放。


### 2026-10-14 本人认证后最新推进：T1与原生诊断解耦

AstraDiagnostic两权限已正常添加/on，新daemon51429实际TCC辅助功能/录屏与AXpass，会话正常end。私有runner已修中文lsof路径、ESM加载、wire snakecase、正向参数/返回桥，最终13tests与Sol复审通过；前几次均在诊断dispatch前拒绝并保留nonce，不冒现场成果。v6 starttrue/endfalse但Tool异常，Root与Sol已用exactwire riskunclassified+冻结授权/registry源闭包确认：新diagnose_foreground_oracles缺风险登记，在platformdispatch前必拒，sampler未调用。隔离native11按同类AX检查R2注册修复，保留policy/manifest/unknown deny与输入Guard，不改当前运行App。

T1网页业务不依赖这项只读诊断。Root已委派唯一现场执行者直接准备已修主env正常继承的新Host594/原A08不initialize/当前native10代际、fresh桌面配对与exactsession监控；正式新trial仍须单次明确放行，不复用旧command或nonce。旧Host已结束且无Provider/业务动作，历史空目录不覆盖。远端Web版本未知仍仅Host594＋实际Relay桌面链范围，不计手机。Windows/Linux原生任务排除不变。详见现场验证记录文末。


### T1新Host准备及前台使用时机

新Host55583 UID501已用outerNode合法mainenv＋Hostrelayenv启动，监听4317/localhost，无initialize，A08seq0/actual0/预占40+2保持。旧session/allowlist已移入0700归档、文件0600，未覆盖历史；新自有Chrome55689/CG7689/profile0700用于freshpair。前台Guard先后阻止点击，全部未派发；最终只读Swift前台为用户微信4543，执行者已停止抢前台，Root仅询当前是否方便测试的时机，非重复授权。期间离线native11构建/审查继续。

健康端点补正：Host源码没有/healthz路由，先前200是通配静态HTML，不是健康诊断通过证据。后按实际路由GET /api/local/session200（token仅内存校验不输出）、GET /api/local/pairing200（challengefalse/requests0）核官方API可用，PID/监听仍匹配。没有新Run/Provider，配对尚未完成。


### 实际用户活动确认与native11离线完成

Root补正仅应用前台不等于人工活动，委派唯一执行者只读核硬件输入idle时间（不读内容）。2026-10-14T05:43:52Z实际mouse idle4.56s/keyidle7.28s，前台有道PID61249，确认近期真实输入；未激活/点击测试Chrome。锁屏key不可得，不拿loginDone推未锁。收据SHA0c881911346c0cdafcab0d7d3a84e1697374f7d4996018dc92c93bbc22f9a60a。当前需用户协调前台空闲时机，原实施授权不变，离线继续。

native11作者最终构建包收据c64ab1fa7a3a0d29f6a1ba18f9c7895eba8f01084fdd9bfdf55239202205e522：仅core authorization/tool两文件补R2 active private-observation分类及selfPID拒绝，590core/411mac+2ignored/fmt/check/alltargets/release作者pass；缺测试资源经原d114tree/blob精确恢复后通过，失败保留；linker既有Swift重复符号warning exit0。独立新App AstraDiagnosticR2Candidate，IDcom.trycua.driver.astradiagnostic.r2fix.local.20261014，签后SHA b04cb18afd773bbcc7e5e314216bed63aef814661a07b5a7ef92938d6e954fe8/CDHash777c83767324a5c8e58d13c5c9a743274be5518f/37filebacked sections一致。Root已实核receipt/二进制/plistSHA与codesign deep strict exit0（Root收据SHA3ad5a1ba9322bc78c821211262370718911a2f63bd1a2e3225e7a8043dd2f314），Sol最终源码/日志/产物独检中。尚未向新App授予权限/启动，不沿用旧App明确许可。


### native11最终独检及交付源码链已完成，当前真实外部条件

Sol最终独检通过（SHA5b37eb6ae3524b6069ffa3dc9bf1ef31d2e582ee110fe5c8e006b2ed4cef60c4）：native11两文件patch strict重放byteequal、383源清单/全部日志/三项原upstream测试资源哈希匹配，590core与411mac/2ignored、fmt/check/alltargets/release最终通过；37节签名前后匹配、App签名独跑严格通过。Root交付native11两文件delta及完整11步source-chain，后者SHA229f6b5ddde5340a8d521747385cc85e17f8aab0be098606224eff52c0ee860b，Sol再核11patch逐SHA及artifact/fixture边界全部一致。当前仍未启动/安装/授权新App、不计现场诊断通过。

已向用户请求exact CuaDriverAstraDiagnosticR2Candidate.app辅助功能/屏幕录制当次确认，并合并当前前台使用时机选项；旧App确认不泛化。此前硬件idle4.56s/7.28s已证真实用户活动，保持不抢前台。旧T1空目录、私有runner各次消费nonce和失败全部保留；A08actual仍0。等待期间准备native11专用staticpins/零Provider runner，不覆盖native10历史。


### 用户明确当前仅离线，新App同意有效但现场延后

用户已答复：先继续离线修复，暂不占用前台；同意exact CuaDriverAstraDiagnosticR2Candidate.app两权限，暂不占前台。Root已记录同意，未来不重复请求同一App许可；现在不系统设置/激活/输入/新App启动，不以硬件空闲或问题超时自行恢复前台。Host55583无Run/预算0保持，原生native11尚未launch/TCC。

native11专用runner本地14tests/defaultnoSDKconnect通过，但此前作者误将App独检当runner独检，现已更正runner独审pending。原Sol6.1实例连续两次capacity失败，Root启用另一Sol6实例继续同角色离线独审，禁止把capacity失败或作者报告当通过。确认新receipt后完成离线交付；全部live字段仍空。


### native11专用runner独立审查完成；旧现场helper已隔离

另一Sol实例实际完成独审PASS_OFFLINE_ONLY（SHA25e5f966397ac00b7dbcee6a7a324b4e8308f96ff1aeccc194e001c7192e5e83）：native11专用runner SHA0fb793126fa3de818d89e60c5e1aabe3dc565f138ee4e4e883300066bc5d702f/test78e3479160848d5ce819b008cb9378dc2823ede73d82ee97754edf0cf96e100f，独跑14tests、语法/default/check均exit0，源码/产物pins匹配、private-runs不存在。fixture为source-projected，未冒native11livewire；unknownreturned不算正向前台结论。

审查发现新目录复制了旧native10硬编码fresh-input/root-bind脚本，Root将两文件移到目录外0700私有archive、旧native10原件不动，不改已审runner/templates/tests。Root移动收据SHA46a166441a2be2040bd6371d765a627abe7a66c8bee6a995a824fafe5d41f5e1；Sol补充核验已移除/归档hash/冻结files未变（addendum SHA29a8b39fee4b8d130e034172097317943534fa33937e551b3d7ee2b8ce91c605）。此误用风险已解除；未来现场须另绑定新PID/socket权限窗口，用户目前明确不占前台。

继续离线修实际缺模型凭据的产品提示：四文件隔离候选，共享typed默认builtin main/risk预检，directFactory目录/Computer前保护，RemoteAPI既有idempotency结果优先且profile/token/目标副作用前检查，保留Host无凭据配对/设置、自定义Provider/RunFactory路径和其他401/network错误。尚未导入主源码、Host594保持冻结。


### 本轮主工作区组合验证完成（仅离线，不占前台）

Root已逐SHA导入Sol批准的精确10文件（4生产/6测试），旧Host55583导入前已不存在、4317无监听，退出原因未知且未发送SIGTERM，不冒正常Run cleanup。主工作区实际pnpm build、Web build、完整pnpm test均exit0：119文件2098 Vitest通过＋72 Node自检通过；92运行链TS源内存ESM转译与dist逐字节相等，4Web资产齐全。Root综合收据SHA c045a9cea384e6424456a069da37993c915bf345b622cd3402cca031c042121b。已有未选中历史ledger EOF空行导致整棵dirty diffcheck提示，未擅改；本次精确source/tests/三文档diffcheck通过。

新产品行为：默认内置主模型或实际启用的独立风险模型缺/空凭据时，创建任务资源、消费一次性profile/window token及自动目标发现之前返回固定PROVIDER_CREDENTIALS_MISSING/409与中文配置提示。既有command幂等结果优先；custom Provider/RunFactory不被强制内置凭据；Host仍可无凭据启动配对/设置；401、网络、SDK错误不被混类。所有测试为synthetic/mock，未触真实模型/GUI/native。

native9/10/11交付源码链与补丁已保留完整重放顺序，最新native11链SHA b1862a61171bbcb3754916027284889a3c5d925113a05cbbaaba403b33d7096f，明确用户已同意新App两权限但GUI/授权设置/启动延后。旧native10清单澄清未启动仅指artifact freeze当时，后续真实TCC/授权层拒绝单列，不将pre-App-signing产物冒绝对未签名。当前准备精确提交与该新提交CI核验，不继承旧594CI为新提交结果。所有现场任务与实体手机验收仍未升级，用户“不占前台”指令保持。

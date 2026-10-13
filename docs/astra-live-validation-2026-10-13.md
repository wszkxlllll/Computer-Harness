# Astra 新冻结版现场验证记录（2026-10-13）

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

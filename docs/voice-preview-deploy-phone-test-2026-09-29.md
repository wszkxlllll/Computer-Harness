# 语音手机 Preview 部署与测试记录

日期：2026-09-29（持续更新）
状态：2026-10-19 Preview 本机 Host 已更新至 [PR #42](https://github.com/wszkxlllll/Computer-Harness/pull/42) 的功能源码 `903048d`；服务器 Web/Relay 仍为 `2026-10-18-life-repair-480126a`，本次不替换。默认风险模型关闭，全桌面跨 APP 不再隐式采集 UIA/DOM。旧源码、构建及配置保留，登录 profile 未清理。Host 重新启动，手机需重新扫码并由用户在电脑确认；以下旧日期记录按历史保留。

## 2026-10-19：默认纯视觉与本地 Guard 发布

- 中文 [PR #42](https://github.com/wszkxlllll/Computer-Harness/pull/42)，分支 `codex/desktop-visual-default-20261019`，尚未合并；PR41 未吸收。三次功能提交分别修正候选缩放／网页 readiness、解耦采集并关闭 Host 风险模型、同步评测配置和回执。后续仅文档提交不要求再重启 Host。
- 电脑连接页：`http://127.0.0.1:4318/connect`；手机：[Preview](https://47.108.197.221:8443/)。在电脑连接页重新扫码，并由用户确认配对；不代用户批准配对，也不自动开始任务。
- 默认模型仍为 GLM-5.3-Flash low。Plan 开启，Memory=facts/lexical，Batch=same-control-input-v1，Context=recent/32，Monitor=shadow（只记录，不注入提示）。本次未改动声音、无障碍、个性化或手机界面；手机真实播音仍由用户后续确认。
- Guard=layered／riskModel=off：本地扫描与必要人工审批保留，不创建风险模型 assessor，不增加风险模型请求。基础权限、Abort 和未知副作用规则不变；模糊项仍可能要求审批，不等同于 Guard 关闭。
- **全桌面＋跨 APP 的默认 grounding=off**，受管浏览器仍启动且复用原登录资料，列窗和切窗继续可用；关闭时不附带 grounding 窗口采图、UIA/DOM 和专属清单读取。原生窗口沿用默认 off。独立“受管浏览器”目标仍显式请求 hybrid，CLI 显式 auto/DOM/hybrid 属主动开启；不把本次发布描述为全入口强制关闭采集。

### 验证与保留范围

全量 Vitest 单线程2580/2580、类型构建与spike检查通过，评测脚本45/45；Sol 审查生产改动和三处测试修改通过。并发下旧预期及超时失败保留，不延长测试超时或跳过用例。真实用户 Harness＋方舟 DeepSeek 验证两组：关闭采集时携程登录可见并实际切到微信（5主请求、0风险请求）；开启 hybrid 后选“出发城市”，CUA SendInput 屏幕 `(707,618)` 点击并展开城市列表（4主请求、0风险请求）。根独立检查截图和轨迹，没有发送、输入、搜索、购票或付款。成功切窗限定 Host 明确授权的两个目标，不宣称任意自动选窗或完整业务任务均已通过；此前无页面变化的点击失败仍保留。Windows 当前几何已实测，macOS 此轮只有合同回归。详见[完整验证记录](./history/2026-10-20-release-convergence/life-business-evaluation-2026-10-15.md#采集开销取舍与-preview-核对2026-10-19)。

本机旧 Host 本来已退出，此次启动新 Host PID42184，核对命令指向本 checkout 的 host dist；4318连接页200、Host到8443的WSS established，Preview及正式health200、匿名Preview任务API401。直接读取同构建默认配置确认 riskModel=off、riskGuard=layered、grounding=off；不是只检查 TypeScript 源码。没有调用真实模型去复验手机配对后的 Run，真实机制验收在相同生产构建的 ApplicationSession 中完成。

### 备份与回退

本机忽略目录 `runs/preview-release-20261019/backup/` 保留修复前 HEAD `8742865` 的 tracked source archive、未提交补丁、旧 Preview 构建副本及原启动配置；原 `runs/preview-desktop-grounding-20261018/backup/` 和旧工作区原地保留，没有覆盖。源码归档可恢复紧邻本轮的基线，复制的旧构建属于之前已保留的发布点，不能混称为同一版本。日志和本次版本信息在新日期目录，不推送 GitHub；私有配置、浏览器 profile、截图及原始轨迹不上传。

此次没有重启服务器 Relay、切换服务器 current 或替换正式443，也没有替换 CUA daemon二进制。Windows继续使用已核验的0.22.2 foreground-caret-v1候选、SHA-256 `400AB8670980ECD461F304FDC7E7A9D8A27F53585EA629B81EE1B7C260BC3095`。回退前先结束任务并核对准确 Host 进程，再用保留的源码或已知旧构建恢复，不删 profile、不恢复旧动作；服务器没有本轮变更，不应跟随盲目回退。机器专属启动命令仍在本机原启动文档，不把个人绝对路径推广给其他用户。

## 2026-10-18：全桌面浏览器候选增量发布

[PR #39](https://github.com/wszkxlllll/Computer-Harness/pull/39) 四组CI及必需检查通过后合入main。本次仅更新电脑Host所用的App Runtime/CUA构建，保留全桌面截图、普通视觉操作及原窗口切换路线；补齐专用窗口证据并对非原子枚举抖动做有界只读重采样，不重试GUI输入。真实Harness已验证DOM候选进入API、模型调用`click_element`、回执完成及动作后文章截图；不将此受控机制测试等同于整批业务成功。

- 地址不变：电脑 `http://127.0.0.1:4318/connect`；手机 [Preview](https://47.108.197.221:8443/)。刷新并扫描新的二维码，在电脑确认连接。
- 默认模型仍为GLM-5.3-Flash low；本轮真实机制验证使用方舟DeepSeek，不代表Host默认已切换。模块及操作范围按用户设置，没有自动批准动作。
- 新Host进程和8443 Relay连接已核对，本地连接页、公网页面与health均HTTP200。未替换正式443服务；没有清理持久登录资料，手机交互/声音需用户后续体验。
- 本机旧构建备份位于本次checkout的 `runs/preview-desktop-grounding-20261018/backup/`，保留Host、App Runtime、CUA原dist及旧启动配置副本；本轮未改变CUA daemon二进制。部署操作记录和日志保留在同一忽略目录。回退时先确认无活动Run，再关闭本次Host、恢复这三个旧dist目录，并使用原启动入口；不要清理profile或重放旧动作。

本轮原始失败和成功Run都保留，详见[实测记录](./history/2026-10-20-release-convergence/life-business-evaluation-2026-10-15.md)。

## 2026-10-18：生活任务修复与无障碍／审批朗读版本

### 使用入口

1. 在运行新版 Host 的电脑打开 `http://127.0.0.1:4318/connect`。
2. 手机扫描新二维码，并在电脑确认连接。手机使用 [新版 Preview](https://47.108.197.221:8443/?v=life-repair-20261018)，不是手机上的 localhost。关闭旧内存页面再打开，不需要清理网站账号或重新准备登录 profile。
3. 本机默认模型保持 GLM-5.3-Flash、thinking low，没有擅自改成付费新模型。Planning/Memory/Batch/Guard 等仍按现有手机设置和 Host 合同使用；部署本身不会自动运行任务或批准操作。
4. 使用 iPhone 旁白时建议先关闭应用自动播报，单独确认导航和通知；两种声音是独立链路，可能重叠。关闭应用播报不关闭旁白状态通知。运行页目标说明合并为完整朗读单元；进展和审批通知保留可读文字。

审批新增朗读已有、请求绑定的模型计划与目标，并标明尚未执行、仍需核对；没有增加额外 LLM 请求。敏感或缺失说明采用安全提醒，不替代用户批准。GUI 审批仍要求请求绑定的画面证据，不能宣称已经完成独立非视觉审批验收。

### 版本与验证

- 远端分支：`codex/life-eval-six-ark-20261016`；部署源码 `480126a857cd4050c96016bc5a0df157e929075f`。拆分提交为评测监督、Runtime/grounding/Memory/限流、无障碍/审批朗读及任务入口状态修正。
- 修复前代码备份分支：`codex/backup-before-life-repair-20261018`，基线 `1ae5b0a61e66f48d84f5afb2407248bd31e8338e`。
- 本地最终 Vitest 141 文件、2563/2563 通过；类型检查、CUA spike 与 Web 生产构建通过，Sol 复审通过。Node 脚本另有 10 项本机 symlink 权限 EPERM 失败，未记为通过。
- 服务器从 Git tracked source 归档构建，frozen lockfile 安装、TypeScript、Web 构建及 Relay 入口语法检查通过；不上传私有 env、浏览器 profile、任务截图或运行轨迹。
- 源码归档 SHA-256：`3B3E926186672E582D5B08C298868816CB919741FA163D42EE97AF2619F12E60`。
- 公网 HTML SHA-256：`6FCA0E30C561D83CA2C8AF13ACAB69C974BC96BA5F9C0E39BF7CFAB65E07C724`。
- 新 JS：`index-DJu8rd0w.js`，SHA-256 `D21296B691137737FFE8F2A20C27AB9D7547BE9974687C22276975C1B0A1F7E3`；本地、服务器和公网一致。
- 新版 health、主页、JS 均 HTTP 200；匿名任务 API 401。本机 `/connect` 200，Host 到 8443 的连接 established；旧正式入口 health 仍为 200。
- [首轮 CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/39105278735)四矩阵应用测试 2563 项均通过，但 Mac/Windows 一条评测脚本路径断言失败：realpath 与同文件词法别名比较不一致。仅修测试的轨迹、截图及交付目录规范路径预期，没有改生产 containment；补齐截图断言前的一次 CI 已主动取消。[修正后 CI](https://github.com/wszkxlllll/Computer-Harness/actions/runs/39105768682)验证代码 head `a38a815`，四矩阵及 `ci-required` **全部通过**。部署功能源码仍为 `480126a`；后续只有测试和说明变更，不需要重复切换服务。CI 不代替真实桌面任务或手机听感验收。

本机 Host 已从本轮修复工作区运行，不是旧 Preview 工作区。复用已运行并核验的 Windows CUA 0.22.2 候选：源码 `7852ab1983b60c0ce581b8736c9da13eaf04640a`、二进制 SHA-256 `400AB8670980ECD461F304FDC7E7A9D8A27F53585EA629B81EE1B7C260BC3095`，配套 `foreground-caret-v1` 输入策略。未重新编译或替换系统级 CUA，未修改系统环境变量。当前 Preview 与评测使用同一物理桌面及候选 daemon，不得同时运行任务。

### 备份和回退

- 服务器旧 release `/opt/computer-harness-preview/releases/2026-10-10-web-accessibility-v1` 完整保留；原 unit、私有 Relay 配置和旧 current 指向已备份到仅 root 可读的 `/opt/computer-harness-preview/backups/2026-10-18-before-life-repair/`。
- 新 release 为 `/opt/computer-harness-preview/releases/2026-10-18-life-repair-480126a`，包含 `.release-source` 来源标识。仅 Preview 的 current 原子切换；正式入口的 current 未修改。
- 本机忽略目录 `runs/preview-release-20261018/backup/` 保存修复前 Git bundle/patch、原 Preview tracked source 归档、原构建及私有启动配置。本机旧工作区及旧启动器未改；登录资料和原 Run 原地保留，私有备份不推 GitHub、不上传服务器。
- 本机忽略目录 `runs/preview-release-20261018/` 中的启动器、日志和 sessions 是机器专属部署文件；其他电脑仍按通用 `scripts/mobile.ps1` 配置启动，不能照搬本机绝对路径。本机具体命令见同目录 `DEPLOYMENT-LOCAL.md`。
- 回退前先确认没有进行中的任务。服务器将 Preview current 恢复到保留的旧 release，再重启 `computer-harness-relay-preview`；本机停止新版 Host 后用未改动的旧启动器恢复。重新扫码，复查 health、资源哈希和匿名 API 拒绝；不要改正式入口、删除 profile 或清理未知桌面 lease。

本次只完成推送、备份、部署和连接／安全边界检查；没有调用付费模型、启动真实桌面业务任务或代替用户确认手机配对。iPhone VoiceOver 听感、实际审批理解和修复后的业务效果仍待用户真机验收。

2026-10-12 只读复核：公网首页、JS、CSS 三项 SHA-256 均与下方 10 月 10 日记录相同；经已固定服务器指纹的 SSH 登录读取，Preview current 仍为上述无障碍 release，Relay active、PID 155349、启动时间仍为 10 月 9 日 22:57:38 CST；release 标记仍记录 backend d2ee1a3、Web base d4eae01 加未提交无障碍改动。未发现当前部署被 PR26 替换的证据，未重启或改动服务。本次默认 SSH 密钥未获授权，但原有密码认证成功，不是已确认的服务器密码失效。此核对不保证期间从未发生又回退的部署，也不代替本机 Host 版本或真实任务验收。
范围：仅记录语音 Preview 部署、连接检查、手机测试入口和回滚方式；未更改旧服务。

## 2026-10-10：网页无障碍版本已发布（无需清空配对）

使用 iPhone Safari 打开 [无障碍 Preview](https://47.108.197.221:8443/?v=a11y-20261010)。先关闭旧页面再打开此链接，避免旧内存页面仍在运行。已经在同一 Safari 配对且会话有效时可以直接继续；首次改用 Safari 或会话过期时，在电脑 `http://127.0.0.1:4318/connect` 扫码并由用户本人／可信协助者确认。此轮没有重启 Relay，因此**不是要求所有人重新配对**；不要照搬下方 2026-10-09 重启后的历史要求。

这次无障碍语义默认可用，不需要先打开项目里的某个模式。按[手机无障碍文档](./mobile-accessibility-experience-review-2026-10-08.md)顶部步骤，先练习系统旁白退出手势，再检查设置、输入、进展、暂停／纠正、请求和结果。建议先关应用自动播报，单独测试旁白，随后再试两套语音并用。没有触发的审批／提问记“未覆盖”；图片才能确认的窗口／审批记“需视觉协助”，不得盲批。

### 发布事实和版本

- 当前 Preview `current`：`/opt/computer-harness-preview/releases/2026-10-10-web-accessibility-v1`；回退点：`2026-10-09-pr22-d2ee1a3-v2`。新 release 从旧 release 独立复制，覆盖匹配的 Web source 与 dist，backend／node_modules／原 `.release-source` 不变。旧哈希资源同时保留，避免已打开页面请求旧资源时 404。
- Git base 为 `d4eae01`，Web 改动仍未提交，不称 Git HEAD 已发布新源码。`.web-release-source` 记录 uncommitted 来源、77 个 source 文件指纹 `7db6e662041a830de69350c4134ff2e0f9f08834d39b4f9b6c836873805cfdcf`，以及 source+dist tar SHA-256 `8A8BCCD6671F05C47A2A55586384BAC1C56F320387D17FA23AB76D3088E95C0D`。未上传 `.env`、运行记录、账号 profile、密钥或本机 node_modules。
- 新 JS：`index-BlAUldwj.js`，SHA-256 `3271F27F8DBC4BF2B2BA884CCFC0DA0A584A7AB32E1F2EB9D1C81317E9E4EDE7`；新 CSS：`index-C8yJJOYs.css`，SHA-256 `FEDD42E600E12477B4F66B4F224D83ACE3F5EF9113C92A074BE38D63C2963457`；index SHA-256 `9C841A904847749F4D2807426B8BB205FEB2E6856686DADDA9B21648849E833D`。协调者从公网重新下载读取并核验，均与本机产物一致，中文 UTF-8 无替换症状。
- Preview／stable health 200，匿名 Preview `GET /api/runs` 为 401；旧 `index-Dksr18pu.js` 仍 200 且原 SHA 不变。Preview／stable PID 与 service state 未变，443 current 不变；本机 Host 4318 在线、WSS established，设备数量仍 2，未代用户生成或批准配对。原登录状态、CUA 候选与配置不变，没有实际桌面／模型调用。

### 回退与边界

当前 Relay 配置的 `webRoot` 是 `/opt/computer-harness-preview/current/apps/web/dist`，进程使用该符号路径读取文件，而非固定旧 release 的 realpath。因此本次只原子替换 Preview current，不需重启服务或清空内存会话。回退时同样只原子指回上述前一 release，然后核对 root／asset／health／匿名 401／两个服务 PID 及 stable current；不得改 443、默认 Host／driver、登录 profile 或自动重放任务。切换脚本失败时只有 current 仍指向自己发布的目录才回退，不覆盖其他人的并发发布。

本轮完成发布与独立公网核验；不宣称已完成真实 iPhone 读屏、物理声音、真实业务任务或完整 WCAG 合规。上一轮 Web 227 项、隔离浏览器 50/50 与 Sol 审查结论见手机文档，不能把本次发布重计为新一轮实机成功。

## 2026-10-09：只读部署状态核对

PR25完整历史与本地手机体验已按保留作者方式合入PR #22；代码head `d2ee1a3`的新CI四矩阵及ci-required全部通过。Node24／固定pnpm 11.19.0根build、Web build、Node自测70通过／0失败／1项环境跳过；本机Vitest 1841/1843，两例CLI窄屏长中文分页检查超5秒，未改timeout。集成报告见`runs/diagnostics/pr22-integration-20261009-2235/`。

独立Preview已原子切换到`/opt/computer-harness-preview/releases/2026-10-09-pr22-d2ee1a3-v2`，新JS为`/assets/index-Dksr18pu.js`（SHA-256 `256A9FF98C08A259644982087047D2776AF376F0ED201AF0FB9A5C5C8FA52C85`），公网health/root/asset为200，匿名`GET /api/runs`为401。Relay重启清空手机内存session，stable 443/current未变；原Preview release `2026-10-07-desktop-input-v1`保留作回滚点。回退时只把Preview `current`原子指回旧release并重启`computer-harness-relay-preview.service`，随后复查health/asset/匿名API；不得改stable。

本机Host PID 47180监听4318，`/connect`、`/api/local/session`均200，页面引用新asset；Host到Preview `:8443`存在ESTABLISHED WSS，Host stderr无Relay认证错误。物理桌面owner lease及operation marker均不存在，新Host run目录无Run轨迹，未发送pairing请求、未approve、未CreateRun、未执行桌面/模型API任务。

用户重新连接步骤：在电脑浏览器打开`http://127.0.0.1:4318/connect`，用手机重新扫描该页面显示的二维码，并在需要时由用户本人确认手机配对请求；不能自动配对或自动批准。只有重新连接后才能继续同一个Preview体验；本次部署与连接检查本身不证明手机语音或真实任务通过。

受管Edge网页zoom 100%／125%窗口绑定短实机检查未完成。尝试入口通过隔离`node_repl`运行时调用既有`openCuaBootstrapSession`，但该工具运行时没有Node全局`process`；SDK在`cua-sdk-platform.ts:22`读取`process.platform`时抛出`ReferenceError`，失败发生在连接候选pipe前，没有启动Edge窗口。这是工具运行时限制，不是产品代码或候选驱动回归；也不把单测/CI代替GUI验收。

## 2026-10-07 Preview 部署与 Windows 输入候选

### 同日后续更新：仅本机Host（已完成）

本机Host随后更新为源码`d840000c90651fd21a6d34173435e68cb5a5e205`，包含Context完整操作指导投影及大图候选预览缩略图。服务器Relay/Web仍是下方`a9464d4`的release／asset，没有改协议或前端，不因本机代码提交就宣称服务器全部切到新commit。候选CUA二进制／pipe／home／profile保持不变，未重启driver。

- 全仓Vitest1817/1817通过，预览定向102/102、两个包noEmit及实际Node24.19.0根`tsc -b`通过；Sol独立审查放行。输入／查询真实任务仍是更新前用户Run验收，不把离线缩图测试写成新实机整题通过。
- 构建与重启前后物理桌面owner均unowned；只核验并重启精确Preview Host，未停止默认CUA或服务器。新Host`/connect`、`/api/local/session`均200，Relay连接建立；本次没有业务Run、桌面输入或模型API调用。env修改时间不变，登录profile未操作。
- Host入口hash可能不变，但本次记录了新`app-runtime/dist/window-preview-image.js`（`01798F…C46F3F5`）、`remote-run-api.js`（`1F5F69…A7D561`）和`context/dist/compiler.js`（`3C563F…66F0F27`）及完整本机指纹，避免用旧入口hash误认依赖未更新。私有state中保存新sourceRevision和构建hash；沿用旧launcher目录名称不代表旧源码。
- 手机需重新打开电脑`http://localhost:4318/connect`扫码配对。大图捕获成功时会在Host端有界缩为预览PNG，最终仍≤2MiB；模型截图／坐标不变。离线合成图9,834,668字节（2048×1200）→1,550,797字节（819×480），651ms；真实capture失败不在此修复承诺中。

### 服务器 Relay/Web（已部署）

- PR22 源码 commit `a9464d4023a0d1cc807d38cb69f483e237a2ff96` 已 push；GitHub 核验 author 与 committer 均解析为账号 ID `142909575`。部署包来自该 commit 的 clean archive：SHA-256 `CD889A783D6EFA3143C0901FAAEB56895626E618DC79476B434F45ABD5ADA01E`。归档审计为 759 项，未包含 `.env*`、`.harness.local.*`、`runs/`、`.tools/`、profile、截图/图片、key 文件、`node_modules/` 或 `dist/`。
- Preview `current` 现指向 `/opt/computer-harness-preview/releases/2026-10-07-desktop-input-v1`。构建使用已有 Node `/opt/node-v24.19.0/bin/node` 与 pnpm 11.19.0；frozen-lockfile 过滤安装报告 131 个包全部复用、0 次下载，Relay TypeScript refs 与 Web 顺序构建成功。服务器 Relay 配置仍为 0600、原 owner，`webRoot` 指向 `current/apps/web/dist`，监听 `127.0.0.1:8788`，公网 origin 为 `:8443`。没有部署或启动 CUA driver 服务，也没有重新安装 Node 或全局依赖。
- Preview unit `computer-harness-relay-preview.service` 重启后 active。公网 TLS 校验通过：Preview health `200`，根页面加载 `index-jH9TY0Xe.js`，asset SHA-256 `53EAC427391087DE5311327C1319E580B45EE01EF063258F4BCB893F13590BFA` 与本地/服务器构建一致；匿名 `GET /api/runs` 返回 `401`。旧 stable health `200`，其 `current` 仍为 `/opt/computer-harness/releases/a-line-20260928-130957-252edf4/three-track-relay-20261006.ENXj6t/release`；本轮未改 stable 的 `current`、443 服务或配置。Relay 重启会清空手机内存 session，需重新配对。
- 新 release 保留旧 Preview `/opt/computer-harness-preview/releases/2026-10-04-popup-input-closeout-v2` 作为回滚点。回滚时仅将 Preview `current` 原子指回该目录并重启 Preview unit；不得触碰 stable。

### Windows 本机输入候选（单独验收）

- 本机输入候选是独立的 Windows x64 driver binary，不是项目 CUA SDK 升级：本轮不改 SDK/lockfile，实际调用 v0.22.2；仓库既有 v0.22.2/v0.32.0 兼容依赖均保留。Mac/Linux 不使用这份 Windows binary。候选 source commit `7852ab1983b60c0ce581b8736c9da13eaf04640a`，artifact SHA-256 `400AB8670980ECD461F304FDC7E7A9D8A27F53585EA629B81EE1B7C260BC3095`，来自自有 fork 的 [Windows 构建 workflow](https://github.com/wszkxlllll/cua/actions/runs/37552571018)；CI formatting、4 个 focused test 与 x64 release build 全绿。PR22 源码 commit 的 CI run `37565173013` 四矩阵与 `ci-required` 也全绿。artifact 保留 7 天，可用于本轮 Preview 验证但不是长期正式发布渠道；如过期需从同一 source workflow 重建，正式 Release 另行安排。

在仓库根目录使用有权限的 GitHub CLI 重新下载候选并核验哈希（命令不包含凭据）：

```powershell
gh run download 37552571018 --repo wszkxlllll/cua --name cua-driver-v0.22.2-focused-document-caret-win-x64 --dir .tools/cua-driver-v0222-focused-document
Get-FileHash .tools\cua-driver-v0222-focused-document\cua-driver.exe -Algorithm SHA256
```

- 该 driver 仅在 Windows Host 上用独立配置与唯一 Preview pipe 做受控测试；默认/旧 driver、默认 pipe 与 stable 配置保留。服务器不部署 CUA。当前 run 的 SDK metadata 为 `0.22.2`、contract 为 `0.7.0`。手机没有单独的 Guard 关闭开关；本轮不改变默认 Host-layered Guard 政策。
- 组长启动的 run-local launcher 是忽略目录中的脚本，不是仓库随附的团队通用工具。若在同一测试 checkout 复现，请从仓库根目录运行：

  ```powershell
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\runs\diagnostics\preview-host-candidate-a9464d4023a0\start-preview.ps1"
  ```

  Host 进程专用设置为 `HARNESS_MULTILINE_TYPE_PROFILE=foreground-caret-v1`、`HARNESS_OPERATION_GUIDANCE=catalog-v1`、`GLM_THINKING=low`，测试上限为 100 requests / 100 steps；Host 使用既有私有 env-file，但其路径和值不记录。候选路径、SHA、唯一 pipe 与隔离 CUA home 由 run-local launcher/state 管理，不复制到共享文档或默认配置。候选 Host 和 CUA 使用独立进程/pipe；默认 CUA socket、配置、env-file 与浏览器 profile 未修改。已核验 `/connect` 与 `/api/local/session` 为 `200`、Relay TCP 已连接且 Host stderr 无 auth/disconnect 提示。Host `POST /api/local/pairing` 返回 `200`，本机 CSRF 流程正常；短期票据的 origin 与私有 Relay public origin 匹配，随后经 admin API 明确拒绝；核验后 active ticket=false、pending requests=0、device count=0。未输出或持久化 token、CSRF 或 Host ID；没有手机实际配对、设备批准、任务或模型调用。
- whole-desktop 必须由用户明确选择，可用于整桌面输入／弹窗兼容或跨应用任务。携程→记事本选择“整个桌面（高级）”并开启“跨应用完成任务”；单独记事本可关闭跨应用。整屏可能把其他可见窗口内容发送给模型，开始前关闭或遮挡敏感内容。Run 期间不要用鼠标、键盘或触控板操作同一台电脑，以免改变焦点或画面；需要人工介入时应先暂停或取消。
- 回退时按该 run 的私有 `preview-state.json` 核对精确 Host PID，只停止该候选 Host；再校验候选 exe SHA，并在同一隔离 CUA home 下对记录中的候选 pipe 执行该 exe 的 `stop --socket <candidate-pipe>`，确认候选进程退出且该 pipe 不可连接。不要把 PID、私有 env 路径或 pipe 值抄入文档；绝不停止默认 `\\.\pipe\computer-harness-pi-local` daemon、改写 `.harness.local.psd1`/原 `.env` 或清理浏览器 profile，也不要用 `scripts/mobile.ps1` 清理这个 run。候选停止后，因配置和 env 未改，恢复使用原 socket/env 不需要恢复文件；launcher 没有配套 stop 子命令，候选清理必须使用该 run 的私有 state。
- 手机入口仍为电脑上的 `http://localhost:4318/connect`，扫描配对后连接 Preview `https://47.108.197.221:8443`；Relay 重启后必须重新配对。候选尚未替换默认 driver，也不以本机连接检查代替完整业务验收。

### 队友从新 checkout 启动 Windows 候选

先按[开发者上手](./getting-started.md)完成依赖与 Host/Web 构建，准备自己的 Preview Relay／模型私有配置文件 `.env.preview`，不要复制他人的密钥或浏览器 profile。使用 Node 24.19.0 和上方已核验 SHA 的候选；这不是 Mac/Linux 的安装步骤。下列命令在仓库根目录、两个专用 PowerShell 终端中执行，环境变量仅影响当前进程及其子进程，不修改系统变量。

终端一保持候选 driver 运行（pipe 名必须未被其他服务占用）：

```powershell
$env:CUA_DRIVER_RS_HOME = Join-Path (Get-Location).Path '.tools\cua-team-preview-home'
& '.\.tools\cua-driver-v0222-focused-document\cua-driver.exe' serve --socket '\\.\pipe\computer-harness-team-preview' --no-overlay
```

终端二启动 Host；`node` 必须是已配置的 Node 24.19.0，可替换成该机器的 node.exe 绝对路径：

```powershell
$env:HARNESS_MULTILINE_TYPE_PROFILE = 'foreground-caret-v1'
$env:HARNESS_OPERATION_GUIDANCE = 'catalog-v1'
$env:GLM_THINKING = 'low'
node .\apps\host\dist\index.js --env-file .env.preview --socket '\\.\pipe\computer-harness-team-preview' --model glm-5.3-flash --output .\runs\team-preview --port 4318 --max-model-requests 100 --max-steps 100
```

此输入 profile 只能与核验过的候选 pipe 配套，不凭版本号相同自动开启。打开 `http://localhost:4318/connect`，扫码并在电脑确认配对；手机应进入 Preview 8443，而不是旧 443。保存登录状态需要在这台电脑上单独准备受管浏览器。退出前先结束当前任务并关闭专用 Host，再在终端一停止该候选；不要停止默认 driver。以上是交接命令，不代表已在队友机器实测。

## 部署状态

- Preview 当前使用独立 release：`/opt/computer-harness-preview/releases/2026-10-07-desktop-input-v1`，源码 `a9464d4023a0d1cc807d38cb69f483e237a2ff96`；Preview 的 `current` 已原子切换。此前 `2026-10-04-popup-input-closeout-v2`、`popup-input-closeout-v1`、`window-progress-v1`、`2026-10-03-runtime-surface-v2` 和 `2026-10-02-cross-window-v1` 均保留回滚。
- `computer-harness-relay-preview` 服务处于 active，只监听 loopback `8788`。Nginx 在 `8443` 提供 TLS：`https://47.108.197.221:8443`，使用现有有效 IP 证书。用户已开放 `8443`。
- 旧入口 `https://47.108.197.221` 及旧服务、旧 `current` 均未修改，仍健康。
- stable `current` 的只读核验路径见上方 2026-10-07 部署记录；本次未切换或重启 stable。
- 当前公网检查结果及边界见上方 2026-10-07 更新记录；下方旧日期为历史。它们不代表手机麦克风或完整语音任务已经验收。

## 2026-10-04 窗口与播报修复部署

### 本轮收尾更新

当前源码、审查、CI 与真实任务边界见[统一收尾记录](./history/2026-10-20-release-convergence/window-popup-regression-2026-10-04.md)。源码 `3f234c6` 本地 111 文件／1655 项通过，四组 CI 及 `ci-required` 全绿；服务器从已验证 Git commit 构建，Web asset 为 `index-D8bCuibX.js`。Preview health／asset 200，匿名任务 API 401，stable health 200。本机 Host 已对齐构建并监听 4318、连接 8443，日志／新任务目录 `runs/voice-preview-popup-closeout-20261004/`。

现在在电脑打开 `http://localhost:4318/connect`，手机重新扫码，使用 `https://47.108.197.221:8443`。不需要重新配置 Node／API key，不要求重新登录已保存的网站，但网站自身登录是否过期仍以实际页面为准。没有操作桌面或重跑本轮未通过的任务；下方旧部署与测试数量是历史，不代表当前端到端放行。

### 早期 window-progress-v1 部署（历史）

部署 commit：`5f0efe00b6d1ca3e66320283a745f15755858f07`，分支 `codex/runtime-surface-preview-20261003`；源码 tar.gz SHA-256：`0C7BD877FF33135B4239D6486AC6C33BF91492EA5B478B956EDFC81A26D73533`。服务器保存 `.release-source`，不含本机密钥、轨迹或截图。

- Windows 根构建通过；全量 107 文件、1312 项通过，脚本 31 通过、1 项跳过。记事本菜单返回与 WPS 列窗/切换/Ctrl+A/Esc 实机成功，见[修复验收](./window-and-progress-repair-results-2026-10-04.md)。
- 服务器 frozen lockfile 安装、Web/Relay 依赖构建和入口语法检查通过，Preview current 已原子切换。重启后第一次 health 发生启动竞态而连接失败；稍后公网复查 health `200`、新 asset `/assets/index-Br-MqOQ2.js` `200`、匿名 `/api/runs` `401`；stable health `200`。旧服务未切换。
- 本机旧 Host 已停止，新 Host 使用本轮构建与原 `.env.voice-preview`、原 CUA socket，监听 4318；`/connect` 返回 `200`，至服务器 8443 的连接 established。没有重启 CUA 或清除浏览器登录 profile。
- 新日志与任务目录：`runs/voice-preview-window-progress-20261004/`，任务在其 `sessions/` 下。手机必须重新配对，新页面应来自上述新 asset。任务中途语音仍可能被模型漏报，不能用基础 health 证明语音端到端通过。

现在打开 `http://localhost:4318/connect`，手机重新扫码配对，使用 `https://47.108.197.221:8443`。首先复测 WPS 菜单/弹窗与携程→记事本任务，开启朗读关键通知；无需重新登录已保存的网站。

## 2026-10-03 Runtime / Surface Preview 更新记录（历史）

部署源码来自分支 `codex/runtime-surface-preview-20261003` 的 commit `600ccecc713737049267b350cfc983cb3942d80c`；源码归档 SHA-256 为 `09931D26140D9FB4CB80BBD361E07567CBF3225E94ECD7DE2E3A2B97D4884562`。服务器 release 内保存 `.release-source`，记录分支、commit 与归档哈希。

- 本机 Node 24 冻结回归为 106 个测试文件、1274/1274 通过；根类型构建和历史 CUA spike 类型检查通过。Notepad 实机验证在同一 ComputerSession 中完成父窗口 → 菜单 child Surface → 父窗口，记录 `child_push` 与 `child_pop`，两次动作均 completed，Run、owner 与 lease 正常释放。
- Preview release 在切换前完成 frozen lockfile 安装、Web 构建、Relay 及其 workspace 依赖构建、Relay 入口 `node --check`。`current` 从 `2026-10-02-cross-window-v1` 原子切换到 `2026-10-03-runtime-surface-v2` 后重启 Preview unit。
- Preview unit 为 active；loopback health 与 `https://47.108.197.221:8443/healthz` 均返回 `200`。根页面引用 `/assets/index-BcxT7NPa.js`，该 asset 返回 `200`；匿名 `GET /api/runs` 返回 `401`。旧 stable health 仍返回 `200`，本次未切换 stable。
- 本轮只更新服务器 Relay/Web release；电脑端 Host 仍需从同一分支启动，才能实际使用本轮 Surface Registry、平台 SDK 路由和 Runtime 修复。Relay 重启会清除内存会话，手机需要重新配对。

如需回退本轮 Preview，仅将 Preview `current` 原子恢复到保留的 `2026-10-02-cross-window-v1`、重启 `computer-harness-relay-preview.service`，再复查 health、静态 asset 与匿名 API 拒绝。不得改动 stable 的 `current`。

## 2026-10-02 Preview 更新记录

本次部署包 SHA-256：`1411ED3B62BACD8123C913F1D95820396281AFAD9FB0BD5786F05CF273F46126`。隔离 Preview 的 `current` 已指向 `/opt/computer-harness-preview/releases/2026-10-02-cross-window-v1`，旧 Preview release 留存；stable 仍指向 `/opt/computer-harness/releases/a-line-20260928-130957-252edf4`。

- Preview Relay active，服务只监听 loopback `8788`。使用正确 Host `47.108.197.221:8443` 检查 health 返回 `200`。一次错误 Host 的 health 请求返回 `403`，属于 Host 校验 fail-closed；使用正确 Host 后检查通过。
- 公网根页面引用 `/assets/index-C5cxMpjt.js`，该 asset 返回 `200`。匿名 `GET /api/runs` 与 managed-browser profile 查询返回 `401`。恶意 Origin 的 profile `prepare` 请求返回 `403`；正确 Origin 但没有配对 session/CSRF 的请求返回 `401`。这些结果表明边界拒绝符合预期，不是已完成登录或 profile 准备。
- 本机 Host 固定监听 `4318`，`/connect` 返回 `200`。Node PID 会动态变化，故不记入文档。服务器侧观察到 Nginx 与 Preview Relay `8788` 之间已有 established WSS；本次复用既有 CUA daemon。
- 首次远端尝试发现系统缺少 `unzip`，在切换 symlink 前即停止，未改变当前 release。随后通过 Python 对 ZIP entries 做安全校验和解压，再原子切换 `current`。本次没有记录密钥、口令或私有日志正文。
- 本次只进行部署及连接边界检查；没有启动 Run、profile prepare、浏览器、模型请求或桌面操作。Relay 更新后手机必须重新配对，不能沿用重启前的 session。

如需仅回退 Preview 应用版本，可将 Preview `current` 原子恢复到保留的 `/opt/computer-harness-preview/releases/2026-09-29-voice-natural-v6`，然后重启 `computer-harness-relay-preview.service` 并重做正确 Host 的 health 与静态 asset 检查。此版本回退尚未执行，且不得改动 stable 的 `current`。本文件后面的“服务器回滚”命令表示完全停用 Preview 服务和入口，不是应用版本回退。

2026-09-29 第二次更新加入：语音开关在用户手势内立即试播、首次进入 Run 时只补发固定“任务已开始”通知、手机显式整个桌面目标，以及 GLM-5.3-Flash `reasoning_effort=low`。整个桌面不会由自动选窗静默启用；它可能把其他可见窗口送入 Provider，仅作为独立弹窗未被窗口捕获时的显式兼容路径。部署前本地全量为 93 个测试文件、930 项通过；脚本 19 项通过、1 项因 Windows 无符号链接能力跳过，强制 Web 构建和服务器构建均通过。

2026-09-29 第三次更新修复手机播报的可观察性和语言选择：开始提交任务的直接手势会先播报“正在发送任务”，用于解锁限制后台自动播音的移动 WebView；所有浏览器 TTS utterance 固定为 `zh-CN`，优先选择普通话 voice 并排除粤语 voice；播放中的 utterance 保持强引用，避免移动 WebView 提前回收。动作后判断的 milestone 标准放宽为“新截图已确认完成一个独立用户子目标或稳定阶段结果”，但聚焦、选中、打开菜单和动作 receipt 不算进展。更新后全量为 93 个测试文件、932 项通过；脚本 19 项通过、1 项跳过。真实 GLM low 两轮协议探针成功，但手机是否真实出声仍必须由真机验收。

2026-09-29 第四次更新修复审批通知的客户端竞态：Web 现在直接按 SSE 序列维护当前 pending request，旧 GET snapshot 不得覆盖更新的审批状态；审批 resolved 后会立即取消或抑制旧通知。创建 Run 后使用同文档 History API 导航，不再整页刷新并丢失移动浏览器的语音激活上下文。新增测试覆盖审批通知早于 GET、快速 resolved、SSE replay 去重和同文档导航；全量为 93 个测试文件、937 项通过，脚本 19 项通过、1 项跳过。该修复不改变 Guard、RuntimeEvent 或 TTS Provider。

2026-09-29 第五次更新增加逐 Run 的动态通知正文 opt-in：只有手机开启“朗读任务关键通知”后新建的 Run 才会朗读当前审批原因和已验证的 milestone summary；旧客户端和关闭设置的 Run 继续使用固定安全文案。动态正文在截断前执行控制字符规整和敏感内容扫描，审批继续绑定当前 requestId，普通 assistantText 与 Monitor 原始结论不朗读。`run-start` 不再占用 12 秒进度冷却，首个真实 milestone 可立即发布；后续进度仍限流。Monitor transition 的 receipt/observation 来源事件 ID 也加入绑定校验。Luna 实施、Sol 复审均通过；全量为 93 个测试文件、945 项通过，脚本 19 项通过、1 项跳过，完整 typecheck 通过。

2026-09-29 第六次更新不再朗读 Guard 的英文内部 reason。审批通过 `callId` 精确关联已提交的 `action.guard.evaluated`，只用有限结构化风险类别与动作类型生成简短中文“可能涉及”提示；不播坐标、输入值或模型未验证的 target/summary。已验证 milestone 直接朗读安全的 `progress.summary`，不再添加机械前缀；内部 `progressSemantic` 使已验证 milestone 不被普通阶段提示的冷却永久丢弃，字段不进入公共 wire。只有 succeeded 可朗读动态终态摘要，失败、取消、预算耗尽和结果未知始终播报各自状态。Luna 实施、Sol 多轮复审后无 P0/P1/P2；全量为 93 个测试文件、947 项通过，脚本 19 项通过、1 项跳过，完整 typecheck 与构建通过。

真实 GLM 探针先验证 `thinking.type=disabled` 被服务端以 HTTP 400/1210 拒绝，随后使用 `thinking.type=enabled` 与 `reasoning_effort=low` 成功：单请求约 24.1 秒，输入 219、输出 644、合计 863 tokens。该探针使用无截图、无桌面动作的合成文本，不证明真实 GUI 任务质量；它证明 GLM-5.3-Flash 不能关闭思考，Preview 只能降到 low。

## 2026-09-29 历史来源与摘要

首轮部署内容来自工作树快照；发现 Relay 未接受新增 `assistantPreferences` 后，修复已提交为 `082dbf8a5e1b7e1c37d91860d7fff77ffcce73b4`，服务器从该提交的 `git archive` 构建并原子切换到当时 Preview release。它仍不是 Git tag 或正式 GitHub Release。

| 项目 | 标识 |
| --- | --- |
| 基线 commit | `743e94da00ac29bad05884e869a178159b47d626` |
| 已跟踪 diff SHA-256 | `ae693be41c45b8c3cb5c8e9f346d206a4cb1081af3106300649dd05fd5ecd6ce` |
| 部署 overlay SHA-256 | `9f7fcb6027b424bf518fb33e4f8dea5308ea05b9632928c77fa28590cbb0a3a3` |
| 构建 artifact SHA-256 | `29a93e8af3da2defadf69d55bec1f93e26ae191b12777cb96e4a9099d4930ae9` |

此前 `082dbf8` 修复 release 的源码 ZIP SHA-256 为 `91122c31e79572ca3296e656fa51e9b593ffa1cfa11a8e692162191791e8715b`。首轮手机已成功配对，语音 session/audio/finish 均返回成功；开始任务时 `POST /api/runs` 连续返回 `400`，且 Host 未创建 Run。根因是 Relay 的精确请求白名单尚未接受 Web 新增的 `assistantPreferences`，请求在到达 Host 前被拒绝。修复后 Relay 复用 Host 同一份 protocol normalizer，并补充 Relay 合同及真实 Web→Relay→Host WSS roundtrip 测试。Preview Relay 重启会清空内存 session，用户必须重新扫码配对后复测。

第二次更新的未提交 tracked diff 摘要哈希为 `3ff57e58d70cad30e24b7d777909e3880b38354c`；服务器仅从 Git tracked 基线与这组 tracked overlay 构建，不包含 `.env.voice-preview`、本机运行轨迹、截图或 API 密钥。它仍需后续形成正式 commit 后才能作为可复现源码基线。

本机私有配置 `.env.voice-preview` 存在；本文不记录其中的 hostId、凭据、密钥或配对 token，也不附私有截图。

## 手机测试入口

1. 在运行本机 Host 的电脑上打开 `http://localhost:4318/connect`。
2. 用手机扫描该页面提供的配对码，并在本机页面确认配对请求。Preview Relay 更新或重启后必须重新配对，不能继续使用重启前的手机 session。
3. 手机使用 Preview 地址 `https://47.108.197.221:8443` 继续测试。不要把旧地址 `https://47.108.197.221` 与 Preview 混用。
4. 记录手机浏览器、配对是否成功、麦克风权限、录音/转写、取消和弱网表现；这些手机端结果目前尚未提供，本记录不宣称它们已通过。

入口区分：

| 用途 | 地址 | 状态 |
| --- | --- | --- |
| 本机 Host 配对与本地确认 | `http://localhost:4318/connect` | 当前后台 Host |
| 本次 Preview 手机端 | `https://47.108.197.221:8443` | 新隔离部署 |
| 旧公网服务 | `https://47.108.197.221` | 保持原状、健康 |

本机当前 Host 日志：`runs/voice-preview-popup-closeout-20261004/host.stdout.log`、`runs/voice-preview-popup-closeout-20261004/host.stderr.log`。

## TLS 尝试记录

- `sslip.io` 的 Let's Encrypt HTTP-01 尝试失败：CA 报告 unauthorized / invalid response `403`；服务器访问日志同时显示有一个 Let's Encrypt validator 收到 `200`，结果在不同验证 vantage 之间不一致。未签发证书。
- `nip.io` 的 Let's Encrypt HTTP-01 尝试失败：CA 报告 `Connection reset by peer`。未签发证书。
- 本机和服务器侧的预检 challenge 文件可访问。临时 ACME Nginx 站点及预检文件均已移除；没有为 `sslip.io` 或 `nip.io` 创建证书。当前 Preview 使用现有有效 IP 证书。

## 停止本机 Preview

先查询 `4318` 的监听 PID，检查其命令行，并沿 `ParentProcessId` 确认专用本机 Preview launcher。只对已核实的 launcher PID 执行以下命令；不要把未经核对的端口 PID 直接代入：

```powershell
Get-NetTCPConnection -LocalPort 4318 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId = <已核实的 launcher PID>" |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
taskkill /PID <已核实的 launcher PID> /T /F
```

这只停止本机 Preview launcher 及其进程树；若该 launcher 启动了 Preview CUA，CUA 也会随树停止。它不会停止服务器上的 Relay Preview。

## 服务器回滚（记录命令，未执行）

需要撤下 Preview 时，仅停止 Preview unit、移除 Preview Nginx 站点链接并校验/重载 Nginx：

```bash
sudo systemctl disable --now computer-harness-relay-preview.service
sudo rm /etc/nginx/sites-enabled/harness-relay-preview
sudo nginx -t
sudo systemctl reload nginx
```

只有 `nginx -t` 成功后才执行 reload。回滚保留 Preview release、配置和现有证书；不得触碰旧服务或旧 `current`。上述服务器命令仅作操作记录，本次没有执行回滚。

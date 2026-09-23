# 成员 B：购物与通信/个人事务预检记录

日期：2026-09-21
文档角色：实施准备 / B0与B1入口
状态：B0本地预检、Mac新增能力适配与实验种子准备已完成；B1真实入口人工走查尚未开始
个人计划：[成员B个人实施计划](./member-b-shopping-communication-implementation-plan-2026-09-21.md)

## 1. 本次完成范围

本次只做不涉及账号和业务副作用的准备：

- 核对出行试点已有manifest、prepare、collect、metrics、report和人工评价结构；
- 盘点Mac系统、显示、语言和已安装的购物/通信相关客户端；
- 建立两域入口预检表、合成数据清单和团队确认清单；
- 明确哪些出行代码可复用、哪些仍与travel目录和合同绑定。

没有打开微信、邮件、日历或购物网站，没有读取账号、聊天、邮件、日历内容，没有调用模型或操作桌面。本记录不是入口可用性证明，也不是任务成绩。

## 2. 当前Mac基线

| 项目 | 只读结果 | 对评测的含义 |
| --- | --- | --- |
| 系统 | macOS 26.4，Apple Silicon arm64 | 后续TrialManifest固定系统版本 |
| 显示 | 内建Liquid Retina XDR，物理3024×1964 | 主参照先固定该显示；逻辑缩放仍需在人工走查时记录 |
| 语言 | `zh_CN` / 简体中文 | 三人比较时语言和输入法状态必须显式记录 |
| Chrome | 153.0.8010.48 | 可作为购物Web候选入口；尚未验证具体站点 |
| 微信 | 4.1.7，bundle `com.tencent.xinWeChat` | 已安装不等于登录、小程序、附件和草稿路径可用 |
| Mail | 16.0 | 仅在专用测试邮箱/受控fixture下使用 |
| Calendar | 16.0 | 需建立独立测试日历，不使用私人日历 |
| Finder | 26.4 | 可承载合成附件/收据归档；不能覆盖用户文件 |
| Preview | 11.0 | 可查看合成PDF/图片材料 |
| TextEdit | 1.20 | 可编辑合成文本附件 |

CUA 0.22.2、权限、只读截图和cleanup已在同日通过。GLM真实接口已通过修复后的本地Adapter验证，但正式评测基线仍需团队决定本地提交`445b09a`如何进入共享代码。

远端`main`的Hybrid DOM Grounding已于本地merge基线`39fcc67`合入。Mac适配现已补齐：运行时在Windows默认选择Edge，在macOS/Linux默认选择Chrome/Chromium；加入macOS与Linux可执行文件候选路径和POSIX受控浏览器进程树追踪；登录准备入口及DOM试点脚本也改为按平台选择浏览器和socket。

适配后typecheck、44个测试文件/511个测试及3个本地Harness测试通过，CUA doctor为supported。真实Mac受控页面试点完成两次Chrome启动、精确窗口绑定、持久配置复用、11个DOM交互候选读取与零残留进程清理；项目自带的自有浏览器点击/输入/滚动探针也通过。随后又通过生产`CuaDriverComputer`完成真实`hybrid-catalog-v1`观察：Accessibility能力已启用，识别到网页文档区域，输出为未降级的Hybrid目录，共46个可访问元素，其中11个为DOM元素。2026-09-22又补齐Retina精确坐标映射，最终一键探针真实执行4次CUA输入：DOM小按钮点击、输入框聚焦、文字输入和页面滚动，每次都由新DOM状态确认生效。该试点不调用模型、不读取个人数据、不操作真实网站。详见[macOS DOM/Hybrid实施结果](./macos-managed-dom-hybrid-results-2026-09-22.md)。首个正式受控实验仍保留`grounding=off`视觉基线，同时可以直接运行`hybrid-catalog-v1`对照组。

## 3. 出行评测资产的复用结论

### 可以直接复用的合同与行为

- manifest采用`schemaVersion`、`manifestId`、domain、entry tracks、safety、6/4 family split和每族2实例；
- heldout默认不可prepare，显式暴露时必须留下标记；
- 每次试次使用唯一目录，记录manifest内容hash、代码SHA和dirty状态；
- `summary.json`、`trajectory.jsonl`、`report.md`、`metrics.json`、`manual-review.md`分工明确；
- model summary、Runtime outcome和人工taskSatisfied不能混为一谈；
- metrics只读受限summary/trajectory，不读取截图、完整Provider交换、goal正文或人工表；
- runId冲突、缺文件、截断轨迹和symlink均不能静默当作有效结果。

### 不能直接复制的部分

- `scripts/travel/travel.mjs`固定`domain=travel_ticketing`、日期展开和`runs/travel`；
- `scripts/travel/tui-collector.mjs`的session/run metadata仍使用travel kind；
- `scripts/travel/metrics.mjs`大部分统计通用，但根目录和kind仍为travel；
- PowerShell入口和任务卡包含出行日期、票务客户端和票务安全边界。

因此购物/通信不能简单复制整套脚本后各自长期分叉。正确准备顺序是先与A/C确认最小公共评测层，再让领域适配器负责manifest校验、goal展开和人工rubric。公共化之前，本轮只建立文档和候选数据，不改Runtime协议。

## 4. 购物入口预检表

下表是候选，不是已验证入口。B1须由本人在无敏感窗口、无模型情况下人工打开并填写。

| 候选ID | 入口类型 | 预期用途 | 当前状态 | 必须确认 | 默认停止位置 |
| --- | --- | --- | --- | --- | --- |
| SHOP-E01 | 官方/合法电商Web候选A | 规格查询、多条件比较 | `pending_manual_reachability` | 地区可达、登录边界、动态价格字段、弹窗 | 商品详情或比较结果 |
| SHOP-E02 | 官方/合法电商Web候选B | 物流/售后规则、价格核对 | `pending_manual_reachability` | 规则页来源、未登录可达范围、验证码 | 公开规则/结果页 |
| SHOP-E03 | 官方/合法电商Web候选C | 跨布局迁移、公开规格 | `pending_manual_reachability` | 页面布局、搜索/筛选、是否强制登录 | 商品详情页 |
| SHOP-E04 | 桌面微信小程序候选 | 小程序surface迁移 | `client_installed_capability_unknown` | Mac微信是否支持、测试账号、窗口边界 | 查询/草稿确认前 |
| SHOP-E05 | 自有受控fixture | 购物车、合成地址、动态库存/价格、售后草稿 | `not_built` | reset/state/evaluate、答案隔离 | fixture规定的草稿或测试提交 |

B1结束时至少从E01—E04中确认3个真实入口候选；E05属于受控环境，不替代“至少3个真实入口”的调查要求。具体服务名称只有在人工核对合法入口、地区和客户端可达性后写入，不凭搜索结果直接定案。

## 5. 通信/个人事务入口预检表

| 候选ID | 入口类型 | 预期用途 | 当前状态 | 必须确认 | 默认停止位置 |
| --- | --- | --- | --- | --- | --- |
| COMM-E01 | Mac微信4.1.7 | 测试通知、草稿、附件 | `installed_not_opened` | 专用测试会话、小程序、窗口/附件/草稿能力 | 输入框有草稿但不发送 |
| COMM-E02 | macOS Mail 16.0 | 邮件草稿、附件准备 | `installed_not_configured_for_eval` | 专用测试邮箱、草稿保存/清理、无真实收件人 | 草稿，不发送 |
| COMM-E03 | macOS Calendar 16.0 | 查询、测试日程、提醒 | `installed_not_configured_for_eval` | 独立测试日历、时区、事件清理、邀请关闭 | 测试日历草稿/事件 |
| COMM-E04 | Finder/Preview/TextEdit | 合成附件编辑与归档 | `installed_not_seeded` | 独立fixture目录、版本hash、无覆盖写 | fixture输出目录 |
| COMM-E05 | 受控通信fixture | 可reset消息/收件人/冲突 | `not_built` | state/audit/evaluate、内容与答案隔离 | fixture草稿或明确测试提交 |

真实微信、Mail和Calendar的运行结果必须分列。Finder等本地应用可用于跨应用任务，但不能把文件整理成绩冒充通信客户端适配。

## 6. 合成数据包清单

先定义数据类别和ID，不在本轮写入真实姓名、地址、邮箱或聊天内容。

### 购物数据

- `PRODUCT-*`：合成商品名称、型号、规格字段；
- `SKU-*`：颜色/容量/尺寸/数量组合；
- `PRICE-*`：基础价、优惠条件、附加费用与观察时点；
- `STOCK-*`：可用、缺货、变化和未知状态；
- `ADDRESS-*`：完全虚构的测试地址，不对应真实住户；
- `RECEIPT-*`：合成PDF/图片收据与内容hash；
- `AFTERSALE-*`：测试问题描述、图片和申请草稿状态。

### 通信数据

- `CONTACT-*`：测试联系人/角色，不复用真实通讯录；
- `NOTICE-*`：合成通知及明确时间、地点和来源；
- `MESSAGE-*`：草稿正文、变更版本和禁止发送目标；
- `ATTACH-*`：合成文本/PDF/图片，带版本和hash；
- `CAL-*`：独立测试日历事件、冲突和提醒；
- `FILE-*`：输入文件、预期命名和只写输出目录。

每个实例只引用ID和版本；评分答案、隐藏rubric、真实账号与凭证不进入Provider Context。动态价格、库存和消息状态必须绑定观察时点，不能作为永久常量。

## 7. B1人工走查表模板

每个入口复制一份填写：

```text
entryId:
checkedAt:
surface: native_desktop | wechat_desktop_miniprogram | wechat_devtools | web
clientAndVersion:
loginState: logged_out | dedicated_test_account | not_applicable
initialPageOrWindow:
desktopAvailable: yes | no | unknown
reachability: desktop_available | controlled_only | unsupported_client | temporarily_unavailable
reachableStage:
captchaOrVerification:
manualGoalPossible:
resetMethod:
cleanupMethod:
safeStopPoint:
sensitiveDataObserved: no | yes（若yes立即停止，不抄录内容）
notes:
```

入口走查只证明人能到达，不证明CUA或模型能完成。需要登录、验证码或账号设置时由本人处理；不得让Agent读取密码或绕过验证。

## 8. 开始B2前仍需确认

| 项目 | 负责人 | 当前状态 |
| --- | --- | --- |
| GLM修复进入共享评测基线 | A/团队 | pending；本地提交未推送 |
| 公共TaskSpec/TrialManifest最小字段 | A+B+C | pending；已有travel实现可参考 |
| 公共EvaluationResult/失败分类 | C+B | pending |
| 购物3个真实入口名称与可达性 | B | pending人工走查 |
| 微信专用测试会话/测试联系人 | B/团队 | pending，不使用私人聊天 |
| 测试邮箱 | B/团队 | pending |
| 独立测试日历 | B | pending |
| fixture输出目录与合成数据版本 | B | pending |
| 首批8实例的人工正/负/近似成功校准 | B，C审核 | 未开始 |

以上事项未完成时，不启动真实购物/通信入口的模型任务；但本机已经具备运行本地受控fixture基础实验的条件。

已准备但不可执行的本地资产：

- `eval/member-b/b0-experiment-baseline.v0.json`：合并后的Mac基线、建议首个受控Run配置和平台缺口；
- `eval/shopping/shopping-b2-seed.v0.json`：SHOP-F01/SHOP-F03共4个开发实例的纯合成种子；
- `eval/communication/communication-b2-seed.v0.json`：COMM-F01/COMM-F03共4个开发实例的纯合成种子。

三份JSON均标记为`draft_not_executable`或`prepared_not_authorized_to_run`，不是TaskSpec、页面fixture或模型启动授权。

## 9. 下一步

收到明确指令后，先进行B1人工入口走查：购物3个候选Web/小程序入口和通信的微信、Mail、Calendar。走查结束后再确定真实入口名称、选出SHOP-F01/SHOP-F03与COMM-F01/COMM-F03的8个开发实例，并开始受控fixture设计。

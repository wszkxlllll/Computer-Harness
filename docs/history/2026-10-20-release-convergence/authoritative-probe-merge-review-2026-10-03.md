# Authoritative relationship-probe merge 独立复审

## 当前结论

GO（最终冻结版已复验）：complete probe 权威拓扑主路径安全边界保持，partial 仅为 CUA existing exact rows 补缺失 owner/visibility/minimized/class 和已存在 foreground，不补 z、不改 bounds、不新增行、不提升 complete。此前 WPS partial dialog 正向回归已关闭。

## 已通过的安全边界

- CUA explicit negative attestation、truncated，以及 probe incomplete/truncated 均不能获得 complete 拓扑。CUA degraded 在 `listWindowInventory` 调用 probe 前抛错，不能被 probe 洗白。
- CUA/probe exact foreground 冲突及同 exact PID/HWND 的 explicit owner、z、visibility、minimized、class 冲突仍 fail-closed；重复 identity、缺 z 或无效 probe row 也拒绝。
- complete probe 控制当前行集及 bounds；CUA 行消失正常退出行集，probe 新行不继承其他 identity 的 title/appName。labels 仅 exact PID/HWND join，且后续 scope authorization 按 PID/HWND，不按标题。probe 不是扩大 Host allowedTargets 的授权源。
- 成功 merge 的 source 标为 win32_relationship_probe，foreground 仅采用 probe；拒绝 merge 清 foreground 并标 negative attestation。completeAttestation 仅 list/merge 消费，不存在下游把缺字段理解为 explicit negative 的分叉。
- native switch 仍 fresh exact capture 后才 commit，generation advance 并清旧 references；baseline admission 仍重新检查 exact parent、geometry、generation，child 的 geometry 变化仍 generation advance。非原子 bounds churn 不直接授权输入。

## 已关闭 P1：partial dialog 特例被无意移除（初轮记录）

`mergeWindowRelationshipInventory` 当前在 `!probe.complete` 时一律 rejectedMerge，删除 probe foreground/owner metadata。既有 `admits a WPS-style #32770 dialog from partial inventory only when exact owner and foreground agree` 因此报 `WINDOW_INVENTORY_UNKNOWN`。该路径此前是明确保留的非 truncated、exact owner + exact foreground dialog 特例，而非 menu 完整栈授权。

建议：保留非权威 partial probe 的 exact-row metadata augmentation，仅允许 CUA 已有 exact identities，不新增 topology、不提升 complete；所有 explicit negative/truncated/conflict 仍拒绝。由实施者与 complete 主路径一并回归。不能给 incomplete rows 编造完整栈或允许 menu 自动 push。

## 本轮独立执行

- Node 24.19.0 node-e 离线矩阵：bounds/row churn、exact labels、新行无标签、negative/truncated、foreground pair/conflict、explicit relationship conflicts、duplicate/missing z 均符合预期。
- Node24 定向 merge、Windows executor/parser、Stage1、adapter：155 通过、1 失败，即上述 WPS 正向回归。
- `tsc -b`：通过。未重复全量，由并行实施者提供后续全量结果；没有把历史全量当作本轮通过。

## 竞态与实机边界

fresh capture、root/owner proof 与 generation 消除已观测到的 identity/geometry 失效，但不能证明同进程同 HWND 在两次采样之间被销毁后复用、且 geometry/root 完全相同的创建身份。当前没有 creation token 或原子 snapshot，不能宣称完全消除 HWND reuse/TOCTOU；只可按现有受监督、严格 action foreground guard、no replay 的边界验收，不作为 OS 原子权限保证。

本轮仅审查、离线测试和本文档写入，未修改 merge 业务代码、操作 GUI/API 或清理 lease。需等 partial 回归修复及重新验证后更新 GO。

## 最终冻结版独立复验

上述初轮 P1 已由实施者修复，没有删除 WPS positive fixture。partial 只在 existing exact CUA rows 补缺失关系字段，保留 CUA bounds/labels，不新增 probe-only rows、不补 z、不提升 complete。foreground 必须存在 probe rows，partial 还必须存在 CUA rows 且满足可见 projection。explicit negative/truncated/relationship conflict/foreground conflict 仍拒绝并清 foreground。

本轮独立 Node 24.19.0 检查：

- 定向 merge 14、Windows executor/parser 15、Stage1 19、adapter 110、managed-browser companion 11：169/169，全通过，含未改成 complete 的 WPS partial 正向。
- `tsc -b`：通过。
- 独立 node-e partial-authority matrix：existing row owner/foreground 能补；无新行/新 z/新 bounds/complete；negative/truncated/foreground与owner冲突清 foreground；probe-only 或 absent identity foreground 不导出。
- managed-browser synthetic fixture 显式 `windowRelationshipProbe: null`，防止 Windows 测试进程枚举真实桌面污染 fixture；该禁用仅测试注入，生产 adapter 隔离未放宽。
- 实施者报告全量 exit 0；本复审未重跑全量，不把报告转换为独立全量验证。

最终 GO：允许继续受监督实机验收，未发现新阻塞项。保留上节 HWND reuse/TOCTOU 的非原子限制。本轮仅文档更新、离线测试，没有修改冻结业务代码、操作 GUI/API 或清理 lease；UTF-8 回读检查通过。

## 实机相对 z-order 尺度修正

进一步实机证据明确：CUA zIndex 是其 visible list 相对序号（Notepad menu 6、parent 5），Windows probe 是 global GetWindow chain rank（menu 699、parent 639）。二者同序而非同值，绝对等号不是冲突证据。

已局部修 merge：删除每行绝对 zIndex 等号比较；收集共同 exact PID/HWND 且双方都有 z 的行，按 CUA rank 排序，要求 probe rank 严格递增。相邻严格递增保证任意两行 order sign 一致；任一侧重复 rank 或反序仍 rejectedMerge。单 common row 或缺 z 不建立 rank 冲突，最终 complete 输出仍采用 probe global z。其他 owner、visibility、minimized、class、foreground、negative/truncated 规则均不变，partial 仍不补 z。

独立 Node 24.19.0 验证：

- merge 18、Stage1 19、adapter 110：147/147。
- `tsc -b` 与 spike `tsc --noEmit`：通过。
- 一次全量：105 文件、1249/1249。
- 新例覆盖 CUA 6>5 / probe 699>639 正向、反序、CUA duplicate、probe duplicate、单 row/缺 z。Notepad modern Menu E2E 显式使用上述两种尺度，仍 child_push；Window 根仍拒绝。
- 既有 ambiguous popup tie 现在在 merge 层更早拒绝为 WINDOW_INVENTORY_UNKNOWN，而非 Stage1 TRANSIENT_SURFACE_UNKNOWN，候选仍不进 picker；该断言更新反映明确更早失效，没有移除反例。

GO：可继续受监督实机验收。本轮按明确授权修改上述局部逻辑及测试，未操作 GUI/API 或 lease，文档 UTF-8 回读通过。

## 最终生产接线：owned-child 优先于 peer allowlist

实机定位：Stage1 与 exact Menu root 可成立，但 `readDiff` 之前只对 unauthorized peer candidates 做 child proof；`windowSwitchAllowedTargets` 未设置或已包含 child 时，合法 child 被当普通 peer 请求 handoff。

已局部重排 `readDiff`，不改证据算法：先识别同 exact parent PID、owner 无明确冲突且存在 exact/partial owner match（或 trusted transient class）的 potential child，执行原 Stage1；admitted 时无论 peer allowlist 如何均进入原 exact root proof/child push，manual/unknown 不降级 peer。明确不同 PID、owner 不匹配或 owner=0 的窗口仍按 Host peer scope 进入普通 handoff；同 PID 本身不等于 owned。多个 surfaced windows 不获得单 child admission。

本轮独立 Node 24.19.0 验证：

- 初轮定向 adapter、Stage1、merge、Runtime：263/263；扩充 ambiguous stack scope 后 adapter 122/122。Runtime 既有 confirm-v1/off 用例保持通过，未伪称这是 native 实机 Runtime 集成成功。
- `tsc -b` 与 spike `tsc --noEmit`：通过。
- 一次全量：105 文件、1261/1261。
- 新 12 项矩阵：Menu/Window root × unrestricted/includes-child/parent-only × windowSwitch off/open。合法 Menu 无 peer handoff并 child_push；Window root withhold。额外 ambiguous owned stack 在三种 scope 下均 withheld。
- 真正同 PID peer fixture 明确 owner=0，普通 handoff、delayed poll 和 managed native handoff 保持通过；原 exact-owned Window fixture 改为明确拒绝负例，不再把失败 root 降级到 peer picker。改变测试预期是本次要求的安全边界，而非删除失败证据。

最终 GO：可以继续受监督实机菜单流程验收。此次只改上述 adapter 接线及回归测试，未操作 GUI/API、付费模型或 lease，文档 UTF-8 检查通过。

# Exact-root projection与临时runner终审

日期：2026-10-03。结论：**GO，限当前确定性实现和已限定目标的bounded runner；本轮没有GUI/API操作。** 经用户授权直接修了下列局部边界，未修改协议或Runtime架构。

## 修补与证据

- counted fallback原本能覆盖state.complete=false；现在缺complete允许完整计数证明，显式false/非法complete拒绝。elements_complete=false仍仅在exact顶层PID/HWND、三种safe count全部等于实际长度、唯一最浅node、严格Menu/Popup/Dialog角色且无truncated/degraded时允许。
- 既有depth0路径现在检查root_surface/rootSurface每个显式声明，拒malformed record、identity/role矛盾；不因优先一个alias而忽略另一个。没有扩大Window/MenuItem或任意后代角色的分类。
- unknown-class候选只有通过既有Stage1 owner/visibility/foreground或complete unique stacking才可读exact root。共享实施线已把完成root证明的candidate纳入其owned menu stack，解决unknown class永远无法成为相关menu的死路径；其他row仍只按trusted menu class归类。counted-menu adapter端到端测试通过。
- 临时runner启动超时且active Run已出现时，先mark pending并Abort；无handle路径同步调用app.close设置关闭屏障，避免微任务延迟期间late factory继续启动。晚返回handle保留审计，不回放动作。cleanup仍要求closed、无active、environment无lease及ownerState=released，不能将unknown/pending lease标成已释放。
- outer finally无论事件/summary投影异常都会清keepalive；start/run/cleanup的deadline仍保留。没有增加lease删除或恢复逻辑。

## 本轮独立验证

显式Node24.19.0：root projection/admission/CUA adapter三个Vitest文件**141 tests通过**；临时runner的纯fake控制流**4 Node tests通过**，覆盖成功收尾、start超时保留pending owner、late factory被同步closed屏障阻止、summary/event异常不泄keepalive。runner --check、主工程/spike typecheck与diff whitespace检查通过。没有重复全量。

node-e额外反例：完整counted Menu可投影；同样数据加complete=false返回undefined；WPS同HWND的complete depth0 Window仍返回Window；unknown-class候选非frontmost时Stage1返回manual。现有degraded/truncated/错PID/HWND/计数alias矛盾/多个minimum节点/Window或MenuItem最低角色反例也通过。

临时runner与其fake测试位于ignored `runs/diagnostics/`，未将依赖临时文件的测试加入正式CI列表。native库、真实会话、文件写入在fake runner测试中全部替换；本轮只编辑代码/离线文档。

## 实机边界

下一步只能由协调者按此前隔离Notepad/WPS范围启动runner，并在fresh capture确认坐标/窗口后执行限定一次打开菜单动作；不选择菜单项、不保存、不打开用户文件、不扩scope。不确定副作用/Abort/timeout保持pending barrier，不依据脚本结束自动清lease。SIGINT默认进程终止仍可能留下待显式恢复的owner，不能据此报告cleanupConfirmed。

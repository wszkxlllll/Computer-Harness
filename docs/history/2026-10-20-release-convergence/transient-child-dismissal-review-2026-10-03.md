# Active transient child dismissal 生命周期修复

## 结论与根因

GO：可继续受监督的 Notepad menu 实机验收。本轮不声明实机第三次父观察已成功。

实机 parent → menu child_push 成功，ESC receipt completed 后失败为 `the candidate is not proven on-screen`。代码顺序已经是 completed receipt → Runtime post-action detection → reconcile → new-candidate diff；问题不是漏调 reconcile，而是它使用全窗口 inventory，关闭后保留的 menu HWND 仍有 exact row，但 isOnScreen=false，于是被错误重送 Stage1。

## 局部修复

仅修改 `packages/computer-cua/src/cua-driver-computer.ts` 的 native child reconciliation：

- complete inventory 下，exact child row 不存在，或明确 hidden/non-minimized 且 exact owner 仍匹配 parent，可作为交互 Surface absent；hidden HWND 不等于 OS HWND 已销毁。
- pop 前必须在同一 inventory 证明 exact parent present/visible/non-minimized、parent SurfaceRef current，并排除同 parent PID 的 visible owned replacement 以及同 child HWND 的其他 PID replacement。之后保留原 fresh parent discover 和 popChild generation 验证。
- incomplete/unknown、hidden child minimized/owner conflict、parent missing/hidden、replacement 均拒绝。visible child 仍走原 owner/root/frontmost proof，不 pop、不改证据算法。
- 成功 pop 保留原 child_pop transition、parent generation bump、windowRefs/旧 observation/grounding 清理、child binding 删除。post-action detection 的已有 one-shot baseline 失效检查使它直接返回空候选，不再对关闭后的 child 做新窗口 admission；下一 observe fresh capture 父窗口。
- execute 仍先返回 completed receipt。没有把已经完成的 ESC 后处理错误变成 action outcome_unknown，也没有重放 ESC。

## 独立验证

显式 Node 24.19.0，物理 repo 路径：

- 定向 adapter 132、SurfaceRegistry 16、Runtime 106：254/254。
- `tsc -b`、spike `tsc --noEmit`：通过；dist 已重新生成，`node --check packages/computer-cua/dist/cua-driver-computer.js` 通过，并确认包含 hiddenChild/replacement guard。
- 一次全量 Vitest：105 文件、1271/1271。
- 10 项 ESC fixture：hidden/absent 回父并 child_pop、父 generation 升、旧 child observation action 拒绝；visible 留在 child；incomplete、minimized、parent missing/hidden、replacement HWND、同 HWND 其他 PID、owner conflict 拒绝，ESC 仅调用一次、失败无新 handoff candidates。

## 风险与边界

完整证据仍是非原子 snapshot，fresh parent capture 在后续 observation 再验证；同 PID/HWND 完全相同形态的瞬间复用仍不具备 creation token 保证。实机需复跑受监督 runner 检查第三次父观察、child_pop lineage 与 cleanup。若 DWM/窗口读取不完整，仍宁可停止手工处理，不以 hidden 猜测关闭。

本轮仅按授权修改上述 adapter、其测试及本文档，重建 dist；未提交/推送、操作 GUI/API、消费付费模型或清理 lease，未改无关 dirty changes。文档 UTF-8 显式回读检查通过。

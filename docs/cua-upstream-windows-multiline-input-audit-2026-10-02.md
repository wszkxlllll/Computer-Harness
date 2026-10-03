# CUA Windows 多行输入上游核对（2026-10-02）

## 结论

本项目锁定 `@trycua/cua-driver@0.22.2`。本次只读核对确认，上游 Windows `foreground type_text` 把普通字符的 `KEYEVENTF_UNICODE` 事件和换行对应的真实 Enter 事件合并为一次 `SendInput` 调用；成功返回仅证明系统接受了事件数量，结果标记为 `effect: "unverifiable"`，不证明目标编辑器得到正确文本。该机制与本次“首个换行后内容异常”的观察相容，但尚不能证明重复字符的具体成因。

即使提供 `element_token`，`delivery_mode: "foreground"` 仍走 `SendInput`，只多了定位和聚焦控件的步骤。上游已有在现代 Notepad 等 XAML/WinUI 控件上以 `element_index` 使用 UIA `ValuePattern` 的实现（#1597）；该路径位于 `background` 分支。不能把“给当前前台调用补 token”当成已验证修复。

## 已核对证据

- 本地 `packages/computer-cua/package.json`、`pnpm-lock.yaml`：版本为 0.22.2；当前 `type` 请求位于 `packages/computer-cua/src/cua-driver-computer.ts`，发送文本和 `delivery_mode`，未发送 `element_token`。
- [0.22.2 `keyboard.rs`](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/input/keyboard.rs)：`send_text_synthesized_after_focus` 构造全部事件，再一次调用 `SendInput(&events, ...)`；只检查返回的事件数量。核对当前 `main`，这一批量发送设计仍在。
- [0.22.2 `impl_.rs`](https://github.com/trycua/cua/blob/cua-driver-rs-v0.22.2/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs)：`Foreground` 分支在 UIA 分支前执行，成功结果为 `effect: "unverifiable"`。
- [已合并 PR #1597](https://github.com/trycua/cua/pull/1597)：上游明确指出现代 Notepad 对普通消息注入不可靠，并引入按元素的 UIA ValuePattern 输入。它没有解决本次前台混合事件疑点。
- 已检索上游 issue/PR 的 `type_text`、Notepad、newline、multiline、SendInput 组合；未发现与“前台多行输入后出现重复字符”完全对应的现成报告。[#1607](https://github.com/trycua/cua/issues/1607) 讨论现代 Notepad 的 hotkey，[#2861](https://github.com/trycua/cua/issues/2861) 讨论大文本超时，均不能直接代表本问题。

## Issue / PR 判断与最低复现门槛

可以准备上游 issue，但现在应标注为“待独立复现”，不能断言上游已确诊。用全新空白的现代 Notepad，绕过 Harness 主循环，直接调用同一版本 CUA，分别比较：

1. `foreground type_text`，无 token，短多行测试文本；
2. `foreground type_text`，有当前快照的 token；
3. `background type_text`，有当前快照的 token，并记录实际路径及读回文本。

每组使用独立空白文档；记录 CUA 版本、Windows/Notepad 版本、输入、结果结构和实际文本，脱敏截图。若第 1/2 组独立复现内容错误，而第 3 组正确，则上游 issue 可明确要求修复前台输入完整性或报告受影响控件，并补相应回归测试。PR 应在上述复现后确定方案；不要先假设“拆成多次输入”或“改用 `set_value`”必然正确，后者还涉及追加与覆盖语义。若直接调用都正确，先定位 Harness 聚焦、窗口切换或输入编码链路。

本次未改项目代码、未调用模型 API、未操作真实桌面，也未创建上游 issue/PR。

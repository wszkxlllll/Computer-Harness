# Windows 原生 ComboBox 列表派发补丁

此文件随 Harness PR 交付此前尚未上传的原生 Driver 修复，不包含编译后二进制，不表示 CUA 上游或当前 npm 包已经包含该修复。它不是 macOS 补丁链的一部分，也不修改 SDK／锁文件。

## 来源与应用范围

- 源仓库：<https://github.com/wszkxlllll/cua>。
- 已有修复的基线提交：`7852ab1983b60c0ce581b8736c9da13eaf04640a`。
- 补丁：[7852ab1-windows-owned-combo-popup.patch](./7852ab1-windows-owned-combo-popup.patch)，路径相对 CUA 仓库根；Rust workspace 为 `libs/cua-driver/rust`。
- 原生源码许可证：MIT，Copyright (c) 2025 Cua AI, Inc.；完整许可保留于[同名 LICENSE](./7852ab1-windows-owned-combo-popup.LICENSE.md)。

在该基线的 CUA 源码仓库中应用补丁，然后由具备 Windows 编译环境的维护者构建 `cua-driver`。应用与构建均是维护者明确操作，本 Harness 仓库不自动下载、替换或启动 Driver。本次发布只导出此前修复，没有重新应用补丁、编译或测试。

## 修复内容

原生 ComboBox 弹出的列表可能不激活，前台仍是所属对话框。不能要求列表 HWND 先成为前台，也不能简单关闭前台检查。

补丁涉及四个 Windows 源码路径：

- `input/combo_popup.rs`：沿当前 GUI 线程鼠标捕获／焦点父链有界查询，用 `GetComboBoxInfo` 的精确控件／列表关系及当前命中证明归属。不是同 PID、窗口类名或邻近矩形放行。
- `input/mouse.rs`：只对已证明列表上的单次、无修饰键左键点击，使用已处于前台的所属窗口，仍走原 `SendInput` 路径。
- `input/mod.rs`、`tools/impl_.rs`：接入精确分支，普通点击保留原路径。

事件前重新检查身份、前台、捕获、控件关系、命中及几何；失配不派发，不激活列表，不重放动作。派发后保留既有前台检查与未知结果语义。控制与列表允许存在实际关系的跨进程情况，PID 相同不是证明。

## 历史实证与限制

2026-10-19 的既有无模型 Windows 专项曾完成 UTF-8 保存和打开列表选择、合成文件 GUI 重开及返回官网；列表旁空白、已关闭列表旧坐标、任务栏和外站变更等反例保持拒绝。该专项记录为 23 个 Computer 动作：18 completed、5 refused、0 partial；不是 M03／CP03 业务通过。

实测范围为 Windows、96 DPI、`--no-overlay`、native desktop。不能外推其他 DPI、多屏、overlay、macOS 或所有原生控件。Host 的点采样合同仍须显式绑定这个候选，不能把修复的坐标语义用于未知 Driver 或未知 socket。Host 实验模块见[说明](../../scripts/host-foreground/README.md)。

本次 16 轮业务结果及仍存在的来源／弹窗缺口见[发布记录](../../docs/history/2026-10-22-member-c-unpublished-repairs/README.md)。

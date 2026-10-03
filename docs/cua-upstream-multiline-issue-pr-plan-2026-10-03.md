# CUA Windows 前台多行输入：上游 Issue / PR 计划（2026-10-03）

## 结论与范围

有条件推进上游修复：现有 raw 实验足以支持一份内容损坏 Bug report，建议先提交 Issue，保留可直接提交小型 focused PR 的路径。现在没有经实测红转绿的修复候选，不能声称节流、拆分或升级 main 已解决问题。本次只读检查本地证据和远端公开源码，写本报告；没有修改 Harness 业务代码、操作桌面、运行新原生实验、提交/推送或发布 Issue/PR。

上游当前 main 为 `f04cd5f6ff3e9fe463cf49ae7b34cf6a8ce96178`（commit 时间 2026-10-02T15:39:08Z），0.22.2 tag `cua-driver-rs-v0.22.2` 指向 `d114f35fec05ecd37bf529e5587be86852205b64`。两者前台文字路径仍把 UTF-16 Unicode packet 和真实 Enter 合并为一次 SendInput；**源码未见本故障的专门修复，main 是否仍实机复现尚未执行验证**。main 与 tag 不能当作已实测同等行为。

## 独立读取的历史实验

本次回读 [audit.md](../runs/raw-cua-multiline-20261002/audit.md)、[raw-results.json](../runs/raw-cua-multiline-20261002/raw-results.json)、[change-inventory.md](../runs/raw-cua-multiline-20261002/change-inventory.md)，并核对 [上一轮源码审计](cua-upstream-windows-multiline-input-audit-2026-10-02.md)。以下是历史实验，不是本次重新执行。

| 路径 / 合成输入 | 实际读取结果 | 证据解释 |
| --- | --- | --- |
| foreground，无 token，ASCII 单行 / 中文数字单行 | 完整相等 | 单行正控 |
| foreground，无 token，ASCII LF 两行 | 内容完整，LF → CR | 仅换行规范化；不能说所有 LF 都损坏 |
| foreground，无 token，ASCII CRLF 两行 | 第一行完整，第二行变为 20 个 `7` | 真实内容损坏 |
| foreground，无 token，中文/英文/数字 LF 三行 | 第一行内容改变，后续内容丢失，末尾 8 个 `5` | 真实内容损坏 |
| background，fresh token，同类型多行 | 所有字符完整；LF/CRLF → CR | 调用是 `unverifiable/accessibility`、verification pending；后续快照证明状态 |
| background，fresh token，中文数字单行 | 完整相等 | 唯一这组调用本身报告 confirmed/value_readback |
| set_value，fresh token，单行/中文多行 | 内容完整；多行规范化为 CR | effect unverifiable、delivery unknown；覆盖语义不同 |

每组使用新空白 Notepad tab，操作前 fresh UIA observation 证明唯一 Document 为空，有当前 token。raw 调用经 `openCuaBootstrapSession` / `CuaDriver.callTool`，绕过 Harness 主循环和模型。foreground + token **没有在该 raw 记录中测试**；只能根据源码说它仍走 SendInput，不能声称已实机复现。没有 WPS / Word / 浏览器多行原生证据，也没有重复次数与发生率。原记录未提供 Windows build、Notepad package version、驱动可执行文件 hash、CPU 架构、键盘布局/IME状态和 foreground+token 对照；对外报告应明确缺失，后续受控复现补齐，不能填入猜测值。

## 上游源码定位及相关工作

固定提交引用避免 moving main 导致误读：

- [0.22.2 keyboard.rs](https://github.com/trycua/cua/blob/d114f35fec05ecd37bf529e5587be86852205b64/libs/cua-driver/rust/crates/platform-windows/src/input/keyboard.rs#L506)：`send_text_synthesized_after_focus`，L518–546 构建事件，L551–562 一次 SendInput；CRLF 已折叠为一个 Return，故本例不是简单“CRLF发两个Enter”缺陷。
- [main keyboard.rs](https://github.com/trycua/cua/blob/f04cd5f6ff3e9fe463cf49ae7b34cf6a8ce96178/libs/cua-driver/rust/crates/platform-windows/src/input/keyboard.rs#L506)：同一事件规划与单次发送仍在，差异主要是错误诊断。`unicode_key_input` 设置 wVk=0、KEYEVENTF_UNICODE；非 BMP 字符通过 UTF-16 encode 处理。不能凭重复7/5猜测 buffer lifetime 错误：本函数的 Vec 在同步 SendInput 返回前有效。
- [main impl_.rs](https://github.com/trycua/cua/blob/f04cd5f6ff3e9fe463cf49ae7b34cf6a8ce96178/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs)：TypeTextTool 的 foreground 分支先执行，并返回 unverifiable。带 token 只在已确认前台后定位/聚焦对应控件；不会转入后面的 UIA ValuePattern 写入。
- background 的 token 分支读取 CurrentValue，写入 `current + text`，再进行严格值读回。其追加语义不等同于任意光标处插入/替换选择；raw 只用空白文档，尚不能证明已有文本时的选区语义。单独 set_value 是整个值替换，不能作为前台 type_text 的无条件替代。
- `with_confirmed_foreground` 在发送前确认前台/聚焦，成功后统一等待 40ms 再恢复原前台。背景 PostMessage 路径已有 baseline 4ms、Enter后额外20ms，但这是另一机制的应用兼容措施，不能直接证明前台采用同样数值会成功。

相关检索覆盖 `multiline`、`SendInput`、`type_text + newline` 以及历史 Notepad 项目：

- [#1597](https://github.com/trycua/cua/pull/1597) 已合并，解决 XAML targets 的 UIA ValuePattern 路由，不是本次 foreground 批量输入完整性修复。
- [#1607](https://github.com/trycua/cua/issues/1607)、[#1614](https://github.com/trycua/cua/issues/1614) 是 hotkey / PostMessage / modifier 问题；与前台文字损坏不可等同。
- [#2861](https://github.com/trycua/cua/issues/2861) 已关闭，是 macOS 0.12.3 Electron 大文本 120s transport timeout，非本次短文本 Windows 内容损坏。
- [#3210](https://github.com/trycua/cua/issues/3210) 是 VMware foreground/scancode focus proxy 问题；[#2083](https://github.com/trycua/cua/issues/2083) 是 macOS RDP Unicode/scancode 问题，均不能替代现代 Notepad 回归。
- [#3834](https://github.com/trycua/cua/pull/3834) open、未合并，head `b4e5f6f54b34534378fc0a343cffd948e535d7f8`。其描述明确当前阶段是键盘执行记录、结果和 focus 失败的 red-case / tech-spec，未开始 typed-producer implementation，也未声称修复本次多行文字损坏。此处依据公开 PR 描述，不是认证其全部分支实现；后续改错误记录需与该工作协调。
- keyboard.rs 最新路径历史含 [#4282](https://github.com/trycua/cua/pull/4282) 的 elevated-launch 及键盘诊断更新、[#4046](https://github.com/trycua/cua/pull/4046) Windows key extended flag、[#3068](https://github.com/trycua/cua/pull/3068) focus-before-input；直接读取 main 已确认核心批量文字路径仍在。

检索未找到完全匹配本合成输入症状的现成 Issue；这表示当前检索范围无匹配，不能证明不存在重复报告。

微软 [SendInput 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)说明返回值表示进入输入流的事件数，同一调用的事件按序插入且不被其他输入穿插；[KEYBDINPUT 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)说明 Unicode packet 通过 VK_PACKET/TranslateMessage 形成字符。这些机制不提供编辑器最终内容完整性的保证，也没有文档要求 Unicode 和 Enter 必须分调用。时序/编辑器消费假设因此只能作为调查方向。

## 最小修复候选及取舍

最小生产改动首选局限 `platform-windows/src/input/keyboard.rs::send_text_synthesized_after_focus`，保留现有目标 admission、foreground focus callback 和恢复边界；必要时在 `tools/impl_.rs` 对失败的执行事实做真实投影。不要在 Harness 隐藏拆成多个模型动作，不要自动重试未知结果。

| 方案 | 可测试的作用 / 优点 | 待验证与限制 |
| --- | --- | --- |
| 仅按逻辑换行分段：Unicode run、独立 Return pair、下一个run | 最小变更；检验混合批次边界是否触发故障，维持键盘光标插入语义 | 无节流仍可能连续淹没消费队列；单行Unicode本身也可能有应用特有问题；尚未实测 |
| 分段 + 有界 settle；必要时每个完整字符/小批次节流 | 检验异步编辑器对Enter/字符的消费时序；更细控制 | sleep不是ack；增时扩大焦点/取消窗口和transport预算；4/20ms不能凭背景路径直接定为修复常量；尚未实测 |
| foreground带token优先UIA / 全部切换background token | 历史空白Notepad对照成功，适合作为明确可选路径 | ValuePattern追加不保留任意选区/光标语义，浏览器UIA回声可能虚假，跨应用支持不一致；不是最小语义等价修复 |
| clipboard paste / set_value | 某些应用可处理整段内容 | 剪贴板有全局副作用，set_value覆盖；扩大合同与授权边界；不纳入此最小PR |

受控 A/B 顺序：固定基线后先“拆分但零延时”，再“只在Enter后有界settle”，最后“小批次/字符节流”。每个候选同一环境、同一合成字符串和新空白控件多次执行，记录通过率及耗时；采用最小有实测收益方案。若仅现代 Notepad 在所有SendInput候选下失败，应报告应用限制、请求维护者选择显式能力/路由合同，而非继续堆延时或改为静默覆盖。

分批后的必要不变式：CRLF跨分段仍只产生一个Enter；不拆Unicode down/up或代理对；一个工具调用只激活/聚焦一次，每批前确认仍是允许目标，不能每批抢回焦点；保持action序列化。发送前失焦才可报告“no input was sent”。发送过任一批后失焦、短计数、超时/取消必须停止，记录已尝试/系统接受的事件事实与未知应用结果，不声称零输入，不重放整串，不把SendInput计数当作delivered字符数。最终统一清理/恢复；完整成功仍保持unverifiable除非有可信独立读回。预算包含最坏字符节流，过大请求在首个输入前拒绝，不靠运行后超时截断。

## 上游回归测试设计

上游 [AGENTS.md](https://github.com/trycua/cua/blob/f04cd5f6ff3e9fe463cf49ae7b34cf6a8ce96178/AGENTS.md)要求 plain cargo test hermetic，桌面测试 opt-in、放 cua-driver-e2e 或 ignored，由canonical runner覆盖；不向生产代码新增test-only注入开关。单元测试验证规划纯逻辑，原生测试验证真实编辑结果，两者不能互相替代。

1. Hermetic Windows unit：提取最小私有纯事件/段规划helper，断言空字符串、LF/CR/CRLF、连续空行、首尾换行、CRLF边界、中文与emoji完整UTF-16、Return down/up。不是照抄实现作唯一oracle，而是检查明确输入协议不变量；无需真实SendInput。
2. 合成 WinUI3 主回归：复用 [harness_winui3_test.rs](https://github.com/trycua/cua/blob/f04cd5f6ff3e9fe463cf49ae7b34cf6a8ce96178/libs/cua-driver/rust/crates/cua-driver-e2e/tests/harness_winui3_test.rs)。现 `harness_winui3_type_text` 只测background单行；[MainWindow.xaml](https://github.com/trycua/cua/blob/f04cd5f6ff3e9fe463cf49ae7b34cf6a8ce96178/libs/cua-driver/tests/fixtures/apps/windows/winui3/MainWindow.xaml) 的 `txt-input` 未设 AcceptsReturn。新增独立 multiline TextBox（AcceptsReturn=true）和独立模型镜像/状态oracle，避免改变原单行控件的Enter行为。公共工具 foreground无token和fresh token分别执行；background token为控制组。
3. WPF multiline TextBox 与传统 Win32 EDIT/RichEdit（ES_MULTILINE）做跨应用/框架覆盖：WPF复用现fixture，classic EDIT若无现成等价控件则新增最小测试app。不要认为WinUI3可替代Notepad自身的具体编辑器。若共享Electron/Tauri textarea已支持多行，公共 foreground路由增加同组回归并用应用模型/DOM oracle，UIA回声不作唯一ground truth。
4. Notepad product repro：在明确允许的交互式Windows环境、独立临时文档中运行0.22.2、固定main、候选SHA。记录package版本/OSbuild，屏蔽恢复旧session并证明空白；用UIA值或明确UTF-8保存文件读取，只保存合成内容。截图作为辅助。该项可自动化，但Store版本、恢复tab、窗口选择和编辑器实现随系统变，适合版本固定的专门native/外部app lane，不作为普通hermetic必过测试。

统一样本：`ABC-31\nDEF-47`、等价CRLF/CR、`\u8f66\u6b21 G7391\nASCII-20261002\n\u6570\u5b57 12345`、重复空行、末尾换行、emoji代理对、长Unicode run。每组首尾都放独特marker。blank、已有内容光标中部、选区替换分别断言内容/选区语义；单行positive control同样执行，避免多行修复破坏普通输入。

oracle只规范化换行（CRLF→LF，再CR→LF），不trim、不删除空行/空格，不忽略丢字；内容必须逐字符相等。对fixture读取应用模型的独立状态，在有界deadline内等稳定状态，记录原始值与时间；不通过重复调用type_text“等到正确”。原生日志可记录目标控件Char/Key消息与合成文本，但日志本身不是内容oracle。前台sentinel验证恢复，另一窗禁止接收残留输入；选区、撤销/redo、键盘状态、首批前失焦拒绝、受控中途焦点切换的停止/无重放需覆盖。不能靠模拟SendInput成功来证明应用正确。

本机可自动执行：纯逻辑与编译检查（本次未执行），获桌面授权后原生fixture/Notepad。GitHub可自动执行：已有Windows native WPF+WinUI3+WebView2 canonical lane，strict GUI preflight通过才算native证据；不能假定GitHub-hosted Windows在Session 0。canonical入口为 `scripts/ci/windows/run-rust-e2e.ps1 -RequireGui`；[Windows runner说明](https://github.com/trycua/cua/blob/f04cd5f6ff3e9fe463cf49ae7b34cf6a8ce96178/libs/cua-driver/tests/runners/windows/README.md)。测试CI inventory必须包含新ignored测试；先focused unit/contract/平台smoke，稳定候选SHA再按上游要求完成跨平台desktop矩阵一次。此报告没有运行/dispatch上述测试。

## Issue 草稿（未发布）

标题：`Windows: foreground type_text corrupts short multiline text in modern Notepad (0.22.2)`

**Problem**：Windows modern Notepad中，raw driver `type_text`、`delivery_mode: foreground`，短CRLF或中英数字多行文本会被改变或丢失；调用返回unverifiable/global_input。不是仅line-ending normalization。

**Environment**：`@trycua/cua-driver 0.22.2`，Windows，modern/tabbed Notepad，raw SDK工具调用，经`openCuaBootstrapSession`与`CuaDriver.callTool`，无模型与Harness loop。Windows build/Notepad version/driver binary hash/architecture/IME与keyboard layout未记录（补充复现时填写）；源码tag commit `d114f35fec05ecd37bf529e5587be86852205b64`。main源码保持机制，main原生未测试。

**Steps**：

1. 启动全新空白Notepad测试文档；取exact PID/HWND，bring_to_front，再fresh `get_window_state`确认Document为空且编辑器focused。不要使用个人文档或恢复tab；每组新空白文档。
2. 直接执行 `type_text`，内容见下面JSON，以foreground、exact window发送且不提供token。
3. fresh `get_window_state`读取Document原始value，比较只规范化line ending后的内容，不依据success message。
4. 单行positive control应完整；LF ASCII控制组应保留文本（本历史结果LF→CR）。新空白文档中background + fresh element_token/snapshot做对照。
5. foreground+fresh token是请求补充的对照；本记录尚未测试。

```json
{"pid":"<PID: replace with number>","window_id":"<exact window id>","delivery_mode":"foreground","text":"RAW-CUA-FT-CRLF-A-31\r\nRAW-CUA-FT-CRLF-B-47"}
```

**Expected**：两个逻辑行完整，允许Notepad UIA把CRLF规范化为CR；光标输入/选择语义保持。driver若没有可信读回可以继续报告unverifiable。

**Actual minimum evidence**：

```json
{
  "input": "RAW-CUA-FT-CRLF-A-31\r\nRAW-CUA-FT-CRLF-B-47",
  "readback": "RAW-CUA-FT-CRLF-A-31\r77777777777777777777",
  "receipt": {"delivery":{"mode":"foreground"},"effect":"unverifiable","route":"global_input"}
}
```

另一个合成输入（ASCII源码用Unicode escapes保证编码边界）：

```json
{
  "input": "\u8f66\u6b21 G7391\nRAW-CUA-FT-\u4e2d\u6587-\u4e0a\u6d77\u8679\u6865-20261002\n\u6570\u5b57 12345",
  "readback": "\u8f66\u6b21 T-\u4e2d\u6587-\u4e0a\u6d77\u8679\u6865-20261002\r55555555"
}
```

**Control**：background + fresh token保留这类合成文本所有字符，仅换行规范化；多行调用仍pending/unverifiable，后续快照证明状态，不能宣称receipt confirmed。历史每种1次，不声明100%发生率。

**Request / related work**：请维护者确认现代Notepad复现并选择最小foreground路径修复；候选是line-boundary SendInput分段及有界节流，需实测，勿静默改成覆盖式SetValue。Refs #1597、#3834；#2861是不同macOS大文本问题。附最小合成前后值、receipt和版本，后续补可独立运行公共SDK repro；不要附整个窗口inventory、旧tab、个人窗口标题/内容、真实PID/HWND或本地敏感路径。

## PR 实施与贡献策略（未实施）

依据 [CONTRIBUTING.md](https://github.com/trycua/cua/blob/f04cd5f6ff3e9fe463cf49ae7b34cf6a8ce96178/CONTRIBUTING.md#choose-where-work-starts)：可复现bug从Bug report开始；问题/证据清楚的小独立修复可直接focused PR，维护者review前是unselected contribution。此处缺root-cause与候选native通过，建议Issue先行；若fixture可稳定red、最小实现跨应用green，可直接draft PR并清晰记录缺口。若选UIA改变光标/替换/public routing contract，应先RFC决定，不塞入最小bugfix。

1. 新建隔离upstream工作目录，基于最新canonical main（不是Harness worktree、不是旧0.22.2分支）；记录base SHA，先复现0.22.2和main。不要撤回或混入本地并行改动。
2. 分支建议 `fix/windows-foreground-multiline-text`。先检查当前GitHub账号/仓库权限；有write权限直接canonical repo分支，无write才用个人fork；不凭已存在fork推断权限。提交前核实effective author和committer、PR head repo/branch。
3. 增加WinUI3/WPF真实多行回归并证明baseline红；最小私有规划/发送变更，保留foreground边界与现有single-line行为，加入no-replay/partial-admission记录和预算验证；不重构跨平台键盘executor，不重复#3834工作。
4. 本地focused unit/contract/native smoke通过，再exact candidate SHA canonical desktop矩阵；未通过的OS环境明确记录，不把编译pass算native pass。PR标题 `fix(cua-driver): preserve Windows foreground multiline text`，production bugfix按patch release；不用no-release隐藏用户行为改变。描述列明触发、语义、候选取舍、各平台实测/未测、测试SHA，Refs issue；只有完整解决才用Fixes。
5. 贡献身份按用户已验证账号使用repository-local `user.name=wszkxlllll`、`user.email=142909575+wszkxlllll@users.noreply.github.com`；有效author与committer必须两者核实，不能用global学校邮箱、改global config或覆盖他人authorship。复用贡献用cherry-pick -x保留provenance/coauthors，不invent identityOverrides。
6. 推送后API检查GitHub author与committer均resolve到account ID `142909575`，核实PR head owner/branch，等实际`contributor-attribution`和`CI: Release metadata`结果。失败先读job log；区分邮箱未resolve与trusted base policy比旧head增加mapping。后一情况比较configs，必要时只cherry-pick -x精确upstream policy commit，完整保留trusted mappings；不削弱validator、乱改credentials或重写别人历史。最新版attribution workflow以pull_request_target当前trusted base执行，PR head不执行；不能沿用过时“只看PR记录base SHA”的判断。

本次未配置身份、未建上游分支、未提交/推送，以上是实施策略而非已完成操作。报告中不保留个人窗口inventory与真实测试窗口标识。

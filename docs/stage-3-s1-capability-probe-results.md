# Stage 3 S3-1 能力探针结果

日期：2026-08-29
基线：`5128021 feat: close stage 2 runtime and computer contracts`

## 1. 本次完成的范围

本轮只完成 CUA 0.22.2 的**只读**能力探测，不执行截图、鼠标、键盘、窗口操作，也不
创建正式 `CuaDriverComputer` package。探针对嵌入式 SDK 和独立 daemon 各运行一次，比较：

- `metadata()` 与 `listToolsJson()`；
- typed session API：`startSession`、`getSession`、`getSessionState`、`listSessions`；
- host 级 session 摘要：`listHostSessionsJson`；
- generic `callTool` 的 `get_session` 与 `get_session_state`；
- `health_report` 与 `check_permissions`；
- `executionMode`、可用性和错误。

本次没有保存截图、没有向桌面发送副作用、没有修改全局 CUA 配置。原始 JSON 只保存在
被 Git 忽略的本机 `spikes/cua-driver/runs/` 下。

## 2. 实测结果

### 2.1 版本与传输模式

| 项目 | 嵌入式 SDK | 独立 daemon |
|---|---:|---:|
| Driver | `0.22.2` | `0.22.2` |
| Contract | `0.7.0` | `0.7.0` |
| tools schema | `1` | `1` |
| capability version | `1` | `1` |
| MCP protocol | `2025-06-18` | `2025-06-18` |
| `executionMode()` | `0`（embedded） | `1`（daemon） |
| `isAvailable()` | `true` | `true` |
| `health_report` | `ok` | `ok` |
| `check_permissions` | UIA/PostMessage 可用 | UIA/PostMessage 可用 |
| 输入/截图 | 未执行 | 未执行 |

两条路径的所有探测操作都返回成功，没有把“可以读到 API”误判为“已经通过 GUI 动作门禁”。

### 2.2 工具清单

- 嵌入式路径返回 `56` 个工具；
- 独立 daemon 返回 `57` 个工具；
- 本次差异只有 daemon 额外出现 `check_for_update`。

这说明工具清单可能随 Host/运行模式变化。正式 Adapter 不应把 56/57 项清单复制进
Harness Protocol，也不应依据工具总数决定能力；应在连接时读取清单，再选择经过验证的
最小方法集合。

两条路径共同包含的核心候选为：

```text
get_desktop_state  get_screen_size  click  double_click  right_click
drag               scroll           type_text  press_key  hotkey
start_session      get_session      get_session_state  end_session
get_window_state   verify_state
```

其中最后两项仍未执行真实窗口观察/校验，暂时只能记为“API 存在”，不能记为行为已通过。

### 2.3 Session 与生命周期

两条路径均能完成命名 session 的创建、读取和结束；`listHostSessionsJson` 能返回 host
级活动 session 摘要。独立 daemon 的 `listSessions` 能看到刚创建的命名 session，而嵌入式
路径本次 `listSessions` 返回空数组，但 `getSession` 和 host 级摘要都能看到它。

这不是足够证据来断言 SDK 有 bug。当前最保守的解释是：`listSessions` 是按 transport/lease
作用域过滤的视图，而 `listHostSessionsJson` 才是 host 级摘要。正式 Adapter 不应依赖
`listSessions` 证明自己的 session 存在，应使用自己创建的 session 名称配合 `getSession`，
并在 daemon 对照测试中继续观察。

两条路径的 typed session 都返回：

```text
state = active
implicit = false
transport = 1
expiresInSeconds = 299
```

这次探针确认默认 trusted session 大约有五分钟的过期窗口；没有修改 TTL。正式 Adapter
必须把 session 结束、idle expiry、daemon 断连和旧 frame 失效作为 S3-4 生命周期测试，不能
靠把 TTL 调长来替代恢复语义。

### 2.4 健康与权限

Windows 独立 daemon 的 `health_report` 报告：

- 平台与二进制版本检查通过；
- UIAutomation 可达；
- D3D11 屏幕捕获可达；
- macOS 专属 TCC 检查标记为不适用。

`check_permissions` 报告当前进程为 Medium integrity、非 elevated，但 UIA 和 PostMessage
均可用。这支持“Windows daemon 路径可进入后续真实动作探针”，不支持“所有应用和所有动作
都一定成功”。

## 3. 两个需要保留的原始观察

### 3.1 typed 与 generic 的 transport 字段不要直接解释为进程模式

在嵌入式 SDK 中，`executionMode()` 明确为 `0` 且 metadata 标记 `embedded=true`；但 typed
session 的 `transport` 数值为 `1`，generic session 的结构化结果写作 `transport:"daemon"`。
独立 daemon 也返回相同的 session transport 字段。

因此当前报告以 `executionMode` 和 metadata 作为“实际连接模式”，把 session transport 原样
保存为协议字段，不把它推断成宿主进程拓扑。这避免在没有源码或跨版本证据时把字段含义写死。

### 3.2 `listSessions` 不是跨传输的权威清单

嵌入式和 daemon 对 `listSessions` 的可见性不同，host 级摘要则能看到活动命名 session。
这进一步支持 Adapter 只管理自己创建的 session，不把全局 session 列表当作唯一事实来源。

## 4. 对 S3-2 的直接影响

S3-1 的“清单/生命周期/健康权限”子探针已完成，但 S3-1 的动作与观察部分仍未完成：

- 尚未测 `get_desktop_state` 的真实输出尺寸和目标坐标；
- 尚未测 `click/type/scroll/drag` 的输入语义和 `ActionResult`；
- 尚未测 `verify_state` 的 unknown/多匹配/超时边界；
- 尚未测 Abort、daemon 断连、session expiry 后的旧动作拒绝。

因此现在只能进入 **S3-2 的协议草案整理**，不能进入正式 Adapter 实现。S3-2 首先应固定
以下小范围实验：

1. 使用独立 daemon 做一次 `get_screen_size → get_desktop_state` 只读尺寸核对；
2. 在用户明确授权、可恢复的本地窗口上测试一条 `click/type → observe`；
3. 专门测试 `scroll` 的落点、方向、`line/page` 粒度，并决定是否修订 Harness 的
   `deltaX/deltaY` 语义；
4. 对比 desktop 像素路径与 window element token 路径的 Frame 新鲜度承诺。

只有这些结果落盘后，才创建 `packages/computer-cua`，并把 CUA 私有类型限制在 Adapter 内部。

## 5. 可复现命令

嵌入式只读探针（使用绝对输出目录，避免 pnpm package cwd 造成路径歧义）：

```text
pnpm --filter @computer-harness/cua-driver-spike exec tsx capability-probe.ts \
  --output <absolute-output-dir> \
  --session stage3-capabilities-embedded
```

连接已经运行的 daemon：

```text
pnpm --filter @computer-harness/cua-driver-spike exec tsx capability-probe.ts \
  --output <absolute-output-dir> \
  --socket <private-socket> \
  --session stage3-capabilities-daemon
```

本轮实际输出目录（均为本机 ignored 证据）：

- `spikes/cua-driver/runs/stage3-capabilities-embedded-r3/`
- `spikes/cua-driver/runs/stage3-capabilities-daemon-r2/`

## 6. 独立 daemon 的只读观察尺寸复核

在完成能力清单探测后，又用私有 named pipe 启动同版本独立 daemon，执行了一次不带输入的
`get_screen_size → get_desktop_state`。结果为：

```text
screen size: 2560 × 1600 @ 1.5
PNG:         2560 × 1600
input:       false
```

这与 Stage 0 的独立 daemon 结论一致：daemon 路径的截图资产和报告尺寸在当前 Windows
主显示器上相同，未观察到 Harness 侧的缩放或裁剪。该结果不能外推到嵌入式 Node 路径，
后者仍保留已记录的 DPI 缺陷。

本次证据目录为 `spikes/cua-driver/runs/stage3-observation-daemon-r1/`，其中的 PNG 只作为
本机临时证据，已被 Git 忽略，不应上传或分享。

## 6. 门禁判断

```text
S3-1 清单/版本/健康/权限/生命周期读探针     通过
S3-1 截图尺寸（独立 daemon，只读）            通过
S3-1 坐标/动作/ActionResult                   未完成
S3-1 verify_state/取消/断连/过期              未完成
S3-2 协议决策                                可开始整理，等待动作证据
S3-3 正式 CuaDriverComputer                  暂不开始
Provider / Dashboard                         不在本阶段
```

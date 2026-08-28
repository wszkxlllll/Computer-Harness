# Stage 0 Windows 截图不完整调研与执行建议

日期：2026-08-28  
状态：根因已定位，独立 daemon 截图与输入动作验收已通过

## 1. 调研目标

解释 Computer-Harness Stage 0 中以下现象：

- Windows 物理主屏幕为 `2560×1600`；
- `@trycua/cua-driver@0.22.2` 返回 `1707×1067`；
- 保存的 PNG 不是完整屏幕的缩小图，而是物理桌面左上区域；
- 判断问题属于 Harness、图片保存逻辑、CUA 使用方式，还是 CUA 上游实现。

本轮没有修改正式 Runtime 或 `Computer` 接口；新增的独立 daemon probe 仍属于
Stage 0 spike，用于验证驱动契约，不改变正式运行链路。

## 2. 已核实事实

### 2.1 Harness 当前调用链

Stage 0 探针直接调用：

```ts
CuaDriver.create(undefined)
startSession(...)
getScreenSize(...)
getDesktopState({ screenshotOutFile })
```

`getDesktopState` 产生的 PNG 被直接保存。探针没有实施裁剪、缩放或 JPEG 转换，
因此 `1707×1067` 不是 Harness 后处理产生的。

### 2.2 嵌入式 Node SDK 结果

在当前机器上：

| 项目 | 结果 |
|---|---|
| 物理显示分辨率 | `2560×1600` |
| Windows 显示缩放 | `150%` |
| CUA `getScreenSize` | `1707×1067`，`scale_factor=1.0` |
| CUA 保存 PNG | `1707×1067`，桌面左上区域 |
| 承载进程 | `node.exe` |
| `node.exe` DPI awareness | `PROCESS_DPI_UNAWARE`（数值 `0`） |

尺寸关系为：

```text
2560 / 1.5 ≈ 1707
1600 / 1.5 ≈ 1067
```

### 2.3 同版本独立驱动对照

使用相同版本的官方 `cua-driver.exe 0.22.2` 启动独立 daemon，调用
`get_screen_size` 得到：

```json
{
  "width": 2560,
  "height": 1600,
  "scale_factor": 1.5
}
```

因此显示器、Windows 捕获能力和 CUA 独立驱动路径均能识别完整物理桌面。问题只
在当前 `CuaDriver.create(undefined)` 的嵌入式 Node 路径复现。

### 2.4 上游代码与历史问题

CUA Windows 捕获实现使用 `GetSystemMetrics` 得到截图宽高，再将该宽高用于 GDI
`BitBlt`。代码注释假定宿主已经启用 Per-Monitor V2 DPI awareness。

独立 `cua-driver.exe` 带有声明 PMv2 的 manifest；嵌入式 TypeScript SDK 则加载
到宿主 `node.exe` 内，独立可执行文件的 manifest 不会作用于 Node 宿主。

trycua 已在 Issue #1879 和 PR #1883 中修复过独立可执行文件的相近 DPI 问题，
但该修复没有解决 DPI-unaware Node 宿主。对比 `0.22.2` 与调研时的 CUA main，
相关捕获代码仍保留相同宿主前提。

## 3. 根因判断

以下链路得到本地实验和上游源码的共同支持：

```text
node.exe 没有 DPI awareness
        ↓
GetSystemMetrics 被 Windows 虚拟化为 1707×1067
        ↓
CUA 使用该尺寸创建截图缓冲区并调用 BitBlt
        ↓
只复制物理桌面左上角 1707×1067 区域
        ↓
截图不完整，且 scale_factor 被报告为 1.0
```

结论：这是 CUA 嵌入式 Windows SDK 与宿主 DPI 上下文之间的问题，不是
Computer-Harness 的图片保存问题。

## 4. 对 Stage 0 的影响

嵌入式 Node 路径当前不能进入坐标点击和 Runtime 集成验收，因为错误不只影响画面
展示，还会破坏：

- `ObservationFrame.viewport` 的可信度；
- 截图坐标与真实物理桌面的对应关系；
- 右侧、底部控件的可见性；
- 后续 Action、Trajectory 和 Replay 的坐标语义。

完整桌面截图和统一坐标空间应继续作为 Stage 0 的强制进入门槛。

## 5. 当前决策

### 5.1 近期路线

Windows Stage 0 优先验证独立 `cua-driver.exe` daemon，通过 SDK/socket 连接，避免
使用 `CuaDriver.create(undefined)` 的同进程嵌入方式。

该路线仍属于同一个 `CuaDriverComputer` 后端，只改变 Driver 生命周期和连接方式，
不需要重新设计 Agent Runtime。

### 5.1.1 独立 daemon 对照结果（已执行）

本地使用官方 `cua-driver-rs-v0.22.2` Windows x64 binary，在私有 named pipe
上启动 `serve`，再由 TypeScript SDK 的 `CuaDriver.connect(socketPath)` 连接。
探针只执行 session、尺寸查询和桌面截图，随后调用 `endSession`、`stop`，不注册
自启动，也没有执行输入动作。

结果：

| 项目 | 结果 |
|---|---|
| Driver | `cua-driver.exe 0.22.2`，独立进程 |
| Socket | 私有 Windows named pipe |
| `getScreenSize` | `2560×1600`，`scale_factor=1.5` |
| `getDesktopState` | `2560×1600` PNG，报告尺寸一致 |
| 视觉核对 | 包含桌面四边、任务栏和右侧窗口，不是左上裁剪 |
| 清理 | `stop` 返回 0，测试后无残留 `cua-driver` 进程 |

证据目录（本机临时文件，已被 `.gitignore` 排除）：

```text
spikes/cua-driver/.stage0/daemon-probe-r7/
```

因此，当前 Stage 0 的完整桌面截图门槛在独立 daemon 路径上通过；嵌入式 Node
路径仍保留已记录的 DPI 缺陷。坐标和输入验收也应继续固定在 daemon 路径，不应把
两种路径混用。

### 5.1.2 独立 daemon 输入动作结果（已执行）

在同一私有 named pipe 上执行一次经用户明确授权的输入试验：先将当前记事本窗口
置前，再用桌面坐标 `(400,400)` 点击文本编辑区，输入 `Lightspeaker`，最后重新
抓取完整桌面截图。测试没有保存或修改用户文件。

| 项目 | 结果 |
|---|---|
| Driver / session | `cua-driver.exe 0.22.2` / `stage0-input-r1` |
| 目标窗口 | `Notepad.exe`，PID `32484`，窗口标题 `无标题 - Notepad` |
| 点击 | `scope=desktop`、`delivery_mode=foreground`，返回 `route=global_input` |
| 输入 | `type_text("Lightspeaker")`，返回 `route=global_input` |
| 动作后截图 | `spikes/cua-driver/.stage0/daemon-run-r8/after-input.png`，`2560×1600` PNG |
| 视觉结果 | 记事本编辑区出现 `Lightspeaker`，光标位于文本末尾；说明点击和输入均落在目标窗口 |
| 清理 | 已停止本次测试 daemon，PID `50160` 不再运行 |

CUA 的点击和输入结果对象将 effect 标为 `unverifiable`，这表示驱动接口本身不
对应用语义结果作断言，不表示动作失败。本次验收以动作后完整截图作为独立证据，
避免把“调用返回成功”误当成“文本已经写入”。

### 5.2 禁止采用的临时补丁

不要在 Harness 内把宽高或坐标固定乘以 `1.5`。这种补丁无法正确处理：

- 125%、150%、175% 等不同缩放；
- 多显示器不同 DPI；
- 窗口跨显示器；
- SDK 当前错误的 `scale_factor=1.0`；
- 截图与输入 API 可能不同的坐标虚拟化行为。

也不要把裁剪图重新拉伸为 `2560×1600`，因为丢失的屏幕区域无法通过缩放恢复。

## 6. 交给执行 Agent 的任务

### 任务 A：验证独立 daemon 接入（已完成）

1. 查明 `@trycua/cua-driver` 当前版本连接已有 daemon 的正式 API 和生命周期要求。✅
2. 在 Stage 0 spike 中增加一个独立、可撤销的 daemon 对照入口；不要立即替换正式
   `Computer` 接口。✅
3. 使用私有 socket/pipe，避免依赖机器上可能存在的全局 CUA 服务。✅
4. 只运行只读调用：启动 session、查询尺寸、保存桌面截图、结束 session、关闭测试
   daemon。✅

### 任务 B：验证截图与坐标契约

独立 daemon 已满足以下截图契约：

- `getScreenSize` 返回 `2560×1600`；✅
- `scale_factor` 返回与 Windows 设置一致的 `1.5`；✅
- PNG 包含完整桌面四边和任务栏；✅
- PNG 尺寸与 Driver 报告的截图坐标空间一致；✅
- session 结束后不残留测试进程。✅

输入动作验收已完成：在记事本编辑区点击后输入 `Lightspeaker`，动作后截图显示
文本确实出现。该结果只证明独立 daemon 的基础点击/输入链路和截图坐标契约可用，
不等于已验证所有应用的控件语义或复杂窗口焦点场景。

本次已完成经过用户明确授权的：

```text
observe → click/type → observe
```

以确认输入动作和截图使用同一坐标空间。

### 任务 C：准备上游 Issue

若独立 daemon 对照通过，整理一个最小复现提交给 trycua：

- Windows `2560×1600 @ 150%`；
- `@trycua/cua-driver@0.22.2`；
- `CuaDriver.create(undefined)`；
- 嵌入模式返回 `1707×1067 @ 1.0` 和左上裁剪图；
- `node.exe` 为 `PROCESS_DPI_UNAWARE`；
- 同版本独立驱动返回 `2560×1600 @ 1.5`；
- 当前 main 的相关实现仍依赖宿主 DPI-aware 前提。

Issue 只报告机制和复现，不预先限定维护者必须采用进程级或线程级修复。

## 7. 验收与停止门槛

### Stage 0 通过条件

只有以下条件全部满足，才继续开发正式 `CuaDriverComputer` Adapter：

1. 完整桌面截图可稳定复现；✅
2. Driver 尺寸、PNG 尺寸和输入坐标空间一致；✅
3. 一次授权输入动作能够作用到预期控件；✅
4. 动作后的新 Observation 能看到实际变化；✅
5. session 和 daemon 能正常清理。✅

上述五项在独立 daemon 路径均已通过，因此可以进入正式 Adapter 的最小实现；仍
需把 daemon 连接方式、窗口/坐标契约和输入后的再观察写成自动化回归测试，避免
后续重构退回到嵌入式 Node 路径。

### 停止条件

若独立 daemon 仍无法满足上述条件，停止在 Harness 层增加补丁，转而等待或参与 CUA
上游修复。不要在错误坐标契约上继续建设 Provider、Context 或 Agent Loop。

## 8. 证据与官方资料

- 本地初始探针记录：`docs/stage-0-cua-probe-result.md`
- CUA Windows 捕获实现：<https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-windows/src/capture.rs>
- CUA Windows 工具实现：<https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs>
- CUA SDK Reference：<https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/sdk-reference.mdx>
- trycua Issue #1879：<https://github.com/trycua/cua/issues/1879>
- trycua PR #1883：<https://github.com/trycua/cua/pull/1883>
- Microsoft `PROCESS_DPI_AWARENESS`：<https://learn.microsoft.com/en-us/windows/win32/api/shellscalingapi/ne-shellscalingapi-process_dpi_awareness>
- Microsoft 设置默认 DPI awareness：<https://learn.microsoft.com/en-us/windows/win32/hidpi/setting-the-default-dpi-awareness-for-a-process>

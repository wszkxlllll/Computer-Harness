# 阶段 0 CUA 探针结果

> 后续根因调研已完成。执行前请继续阅读
> [`stage-0-windows-dpi-investigation.md`](./stage-0-windows-dpi-investigation.md)。

## 已执行内容

在当前开发仓库中执行了默认的安全探针：

```text
pnpm probe:cua -- --session stage0-capture-r2
```

探针使用真实 TypeScript SDK：

```ts
CuaDriver.create(undefined)
startSession({ session })
getScreenSize({ session })
getDesktopState({ session, screenshotOutFile })
endSession({ session })
shutdown()
```

默认没有鼠标和键盘输入。

## 事实记录

| 项目 | 结果 |
|---|---|
| CUA Driver | 0.22.2 |
| Runtime mode | embedded / same-process |
| Host | Windows x64 |
| Node | v18.19.0 |
| Driver metadata | contract 0.7.0，tools schema 1，capability 1 |
| Driver PID | 由本次探针动态分配 |
| SDK 屏幕尺寸 | 1707×1067，scale factor 1x |
| 保存 PNG 尺寸 | 1707×1067 |
| Windows 显示器物理分辨率 | 2560×1600 |
| Session | 命名 session，正常结束 |
| 输入动作 | 未执行 |

## 结论（修订）

安全的命名 session、屏幕尺寸查询和 PNG 保存链路可以运行，但“完整全桌面截图”
门槛未通过。当前 Windows 物理显示器为 2560×1600，CUA 返回并保存的图像为
1707×1067；两组尺寸接近按 150% DPI 缩放后的逻辑尺寸（2560/1.5≈1707，
1600/1.5≈1067）。肉眼核对图像也显示它是桌面左上区域，而不是把 2560×1600
完整画面缩放到 1707×1067。

因此当前证据指向 Windows DPI 感知/坐标空间与 CUA 捕获像素没有对齐，不能把该
结果归因于 Harness 保存、JPEG 压缩或审计页面裁剪。后续对照已经确认：同版本
独立 `cua-driver.exe` 能正确返回 `2560×1600 @ 1.5`，而嵌入式 Node SDK 的宿主
处于 DPI-unaware 状态。完整证据和执行建议见后续调研文档。

截图文件位于 `spikes/cua-driver/runs/stage0-capture-r2/`，只作为本机临时证据，
不应提交到 Git 或分享给队友。

## 下一道门槛

按照 [`stage-0-windows-dpi-investigation.md`](./stage-0-windows-dpi-investigation.md)
先验证独立 CUA daemon 接入。只有拿到完整物理桌面和一致坐标空间后，才继续输入
动作测试。

完整截图门槛通过后，才运行有限次数的：

```text
observe → click/type（显式授权）→ observe
```

确认 Frame 尺寸、坐标空间、动作返回和资源清理后，才能进入正式
`CuaDriverComputer` Adapter 和 Runtime 集成。

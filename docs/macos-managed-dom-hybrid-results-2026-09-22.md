# macOS Managed DOM / Hybrid 落地与真机验证

日期：2026-09-22
文档角色：macOS 平台实施结果 / 本地使用入口
状态：受控 Chrome fixture 的启动、DOM 读取、Hybrid 目录、精确点击、输入、滚动和清理均已在本机通过；真实购物/通信站点尚未开始评测

## 1. 通俗结论

Mac 现在已经能走和 Windows 相同的主链路：Harness 自己打开一个隔离的 Chrome，从网页结构中找到按钮和输入框，同时保留 CUA 截图，再把两者合并给模型。点击仍由 CUA 投递，DOM 只提供当次观察中的可验证位置，不会把 CSS 选择器、Cookie、存储值或输入内容发给模型。

## 2. 本次补齐的 Mac 部分

- Windows 默认继续使用 Edge；macOS/Linux 默认使用 Chrome/Chromium。
- 增加 macOS Chrome/Chromium/Edge 安装路径和 POSIX 进程树追踪，只允许 Harness 自己启动的浏览器窗口进入 DOM 通道。
- macOS 启动 Chrome 时开启渲染层可访问性，使 Hybrid 能取得可信的网页内容区域。
- 修复 Retina 精确点击：Chrome 报告的 `devicePixelRatio` 现在作为适配器私有校准信息，绑定到同一次 DOM 观察，用于把截图坐标转成 CUA 的 macOS 显示像素坐标。该值不会进入模型 Context。
- 增加可重复的 `pnpm harness dom-probe` 入口，自动启动私有 CUA daemon，结束后自动停止。
- 本机 `.harness.local.json` 使用项目专用 socket `/tmp/computer-harness-project-501.sock`，避免与旧 CUA 应用留下的默认 socket 冲突。该文件已被 Git 忽略，不会上传本机路径。

## 3. 本机真实验证

最终执行：

```bash
pnpm harness dom-probe --allow-input
```

结果为 `status=passed`，且取得以下证据：

- 两次 Chrome 启动均绑定到唯一的 Harness-owned 窗口；
- 持久测试 Profile 的 Cookie/本地存储标记可复用，但它们的值没有被读取或写入摘要；
- 识别 11 个 DOM 交互候选，包括 button、textbox、checkbox、radio、slider、自定义 role 和 open shadow DOM；
- Canvas 仍走视觉路径，iframe 不跨边界遍历；
- Hybrid 观察为未降级状态，共46个元素，其中11个来自 DOM，并找到网页 Document/WebArea；
- 4次真实 CUA 输入均完成：DOM 小按钮精确点击、DOM 输入框聚焦、测试文字输入、页面滚动；
- 点击、输入和滚动后均用新的 DOM 观察确认页面状态已改变；
- 调用模型 0 次，读取 Cookie 0 次，读取 storage 0 次；
- 第一次关闭后该 Profile 的活跃自有进程数为0，Profile lock 已释放，最终浏览器和 daemon 均由脚本清理。

运行目录和测试页截图保留在已忽略的 `runs/`，不上传。

## 4. 本地使用方法

只读验证：

```bash
pnpm harness dom-probe
```

完整点击/输入/滚动验证（只操作自有测试页）：

```bash
pnpm harness dom-probe --allow-input
```

正式使用时，先在一个终端运行：

```bash
pnpm harness daemon
```

另一个终端启动 CLI/TUI 时使用同一 socket，并显式选择 `hybrid-catalog-v1` 和目标网址：

```bash
pnpm --filter @computer-harness/cli start -- --model glm-5.3-flash --computer cua --cua-socket /tmp/computer-harness-project-501.sock --grounding hybrid-catalog-v1 --managed-browser-url "https://example.test" --tui
```

`https://example.test` 必须替换为本次受控实验入口。首次涉及登录的持久 Profile 仍必须由用户手动登录；Harness 不能读取密码或复用个人 Chrome Profile。

## 5. 边界与下一步

这次证明的是“Mac 平台 DOM/Hybrid 基础设施与动作链路可用”，不是“任意真实网站都已评测通过”。购物和通信的真实入口还需按成员B计划完成人工可达性、登录边界、验证码、安全停止点和重置方式检查。任何真实购买、付款、发消息或提交售后仍不在本次放行范围内。

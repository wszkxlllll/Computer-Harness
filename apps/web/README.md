# Harness Web 控制台

这是手机优先的 React/Vite 控制台，也是电脑本机的“连接手机”管理页。界面请求实际 Host API，不内置模拟 Run。

## 开发

在仓库根目录安装工作区依赖后运行：

```powershell
pnpm --filter @computer-harness/web dev
```

Vite 将 `/api` 请求代理到 `http://127.0.0.1:4317`，可用 `VITE_HOST_ORIGIN` 指向其他本机 Host 地址。Host 必须将实际 Vite 来源列入开发来源白名单，并继续检查 loopback；不要将该来源配置用于公网部署。

## 构建与部署边界

```powershell
pnpm --filter @computer-harness/web typecheck
pnpm --filter @computer-harness/web build
pnpm --filter @computer-harness/web test
```

产物位于 `apps/web/dist`。应由同源 Host 或已配置的受控中继托管，并将 `/pair`、`/connect` 和 `/run/:runId` 回退到 SPA 入口。控制 API、SSE 和截图都使用同源地址与配对 Cookie；不要把网页单独放到另一个跨域静态站点。

配对二维码由 Host 生成。页面不改写二维码地址，会在提交一次性凭据前清除 URL 查询参数；请求状态可以恢复，永久会话凭据只放在 HttpOnly Cookie 和内存中的 CSRF token。静态页面不缓存截图或 Run 内容，也不会离线排队发送暂停、审批、纠正或点击。

## 当前原型限制

当前只支持本机 Host 开发联调。中继尚未部署和验收；如果 Host 生成的是 `localhost` 或 `127.0.0.1` 地址，手机扫码时会访问手机本身，不能连接运行 Harness 的电脑。页面会明确提示这一点，不将本机 QR 页面描述为“扫码即用”。真实手机、跨网络和真实桌面 Run 均需单独验收。

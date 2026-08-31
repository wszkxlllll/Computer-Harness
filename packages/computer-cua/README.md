# `@computer-harness/computer-cua`

薄的 CUA daemon `Computer` Adapter。它只连接一个由调用方启动的独立 daemon，不启动嵌入式
runtime，也不自动重连或重放 GUI 副作用。

```ts
import { CuaDriverComputer } from "@computer-harness/computer-cua";

const computer = new CuaDriverComputer({
  socketPath: "\\\\.\\pipe\\computer-harness",
  screenshotDir: "runs/screenshots",
});
```

`open → observe → execute → observe → close` 由上层 Runtime 编排。Adapter 私有地维护
`ObservationId` 与 daemon session 的绑定；`ActionReceipt` 只报告 Driver 调用结果，不声称 GUI
目标或用户任务已经完成。

当前支持 primary desktop 的 click、double-click、right-click、type、keypress/hotkey、scroll
和 drag。scroll 使用 `point + direction + positive ticks`，Adapter 将 ticks 映射为 CUA 的
wheel `amount`。Transport 失败后 session 进入失效状态，调用方必须重新 `open()`。

真实 daemon contract test 属于 S3-4，不由这个 package 的 fake-driver 单元测试替代。

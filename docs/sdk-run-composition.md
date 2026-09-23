# TypeScript Run 装配示例

第一条 Pi 式模块化切片提供 workspace 内的 `@computer-harness/app-runtime` SDK 入口。应用创建一次 `createRunFactory(dependencies)`，然后把每次的 `ResolvedRunConfig` 交给返回函数；每次装配都会调用已配置的依赖工厂创建 Provider、Computer、ToolRegistry 与 ContextCompiler，未覆盖的依赖沿用产品默认装配。运行主循环、Event、Trajectory、审批和清理仍由现有 Runtime 负责。

`packages/app-runtime` 当前仍标记为 `private`，因此这是 workspace SDK 示例，不表示该包已经能发布到 npm。

## Mock 端到端 Run

下面的装配通过公开包入口替换 Provider、Computer、ToolRegistry 和 ContextCompiler。ToolRegistry 从内置工具集合扩展，保留 `click` 和 `terminate` 以支撑示例动作与 Finish；完全自定义的 registry 需要自行提供 Runtime 要执行/展示的相应工具。`fixture_marker` 只是无副作用的 `side` 示例；side 工具不受 GUI ActionPolicy 保护。`DemoProvider` 第一次请求调用 `click`，第二次在收到完成回执和新 Observation 后结束 Run。

`createToolRegistry` 提供的是应用工具组合的起点。启用 Planning、Memory、Execution Segment 或 CUA Grounding 时，app-runtime 会在工厂返回的 registry 上追加对应内置工具；这个入口不能替换或移除这些已启用模块的工具。要关闭它们应使用各自的 Run 配置开关，并避免自定义注册同名工具。

```ts
import { createRunFactory, type ResolvedRunConfig } from "@computer-harness/app-runtime";
import { DefaultContextCompiler } from "@computer-harness/context";
import type { ComputerSessionDescriptor, ToolCallId, Viewport } from "@computer-harness/protocol";
import {
  createDefaultToolRegistry,
  type Computer,
  type ComputerSession,
  type ProviderAdapter,
} from "@computer-harness/runtime";

class DemoProvider implements ProviderAdapter {
  public readonly id = "demo-provider";
  private turn = 0;

  public async generate() {
    if (this.turn++ === 0) {
      return {
        type: "tool_calls" as const,
        calls: [{ id: "demo-click" as ToolCallId, name: "click", arguments: { x: 20, y: 30 } }],
      };
    }
    return { type: "finish" as const, summary: "Fixture target clicked and checked.", reportedStatus: "success" as const };
  }

  public async close() {}
}

class DemoComputer implements Computer {
  private observationNumber = 0;
  private readonly viewport: Viewport = { width: 100, height: 100, coordinateSpace: "physical" };
  private readonly session: ComputerSession = {
    id: "demo-session" as ComputerSessionDescriptor["id"],
    backend: "demo-computer",
    viewport: this.viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: new Date().toISOString(),
  };

  public async open() { return this.session; }

  public async observe() {
    this.observationNumber += 1;
    return {
      capturedAt: new Date().toISOString(),
      viewport: this.viewport,
      screenshot: { mediaType: "image/png", data: new Uint8Array([this.observationNumber]) },
    };
  }

  public async execute(_session: ComputerSession, action: Parameters<Computer["execute"]>[1]) {
    return { actionId: action.actionId, status: "completed" as const };
  }

  public async close() {}
  public async dispose() {}
}

const sdkRun = createRunFactory({
  createProvider: () => new DemoProvider(),
  createComputer: () => Promise.resolve(new DemoComputer()),
  createToolRegistry: () => {
    const tools = createDefaultToolRegistry();
    tools.register({
      name: "fixture_marker",
      description: "Application-specific example tool.",
      category: "side",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validate: () => undefined,
      async execute() { return { marker: "available" }; },
    });
    return tools;
  },
  createContextCompiler: (tools) => {
    const base = new DefaultContextCompiler(tools);
    return {
      async compile(input, signal) {
        const modelInput = await base.compile(input, signal);
        return { ...modelInput, system: `${modelInput.system}\nThis application adds its own context.` };
      },
    };
  },
});

const config: ResolvedRunConfig = {
  goal: "Click the fixture target, observe again, then finish.",
  model: { kind: "external", id: "demo-provider" },
  computer: { kind: "external", id: "demo-computer" },
  outputDir: "./runs/sdk-demo",
  maxSteps: 3,
  maxModelRequests: 3,
  planning: false,
  memory: "off",
  batching: "off",
  contextMode: "raw",
  contextMaxHistoryEvents: 20,
  riskProfile: "experiment",
  riskGuard: "off",
  riskModel: "off",
  riskMaxModelRequests: 1,
  riskTimeoutMs: 100,
  cleanupDeadlineMs: 500,
};

const run = await sdkRun(config);
try {
  console.log(await run.start());
  console.log((await run.report()).events.map((event) => event.type));
} finally {
  await run.close();
}
```

端到端事件顺序包含首次 `observation.created`、`tool.call.received`、`action.execution.completed`（Computer 回执）、第二次 `observation.created` 和 `run.finished`。`tool_result` 也会进入下一轮 `ModelInput`。这用 Mock 证明装配和既有 Runtime 合同可连通，不表示真实桌面、API 或用户任务体验已经验证。

## 当前类型边界

`ResolvedRunConfig` 对主模型与 Computer 各增加了一个窄的 external descriptor：`{ kind: "external", id }`。`id` 必须是 1–64 位 ASCII 字母、数字、点、下划线或连字符；external Provider 的 `ProviderAdapter.id` 必须与配置 ID 一致。没有传入对应工厂时，Run 会在创建文件和资源前明确失败；默认 Provider/Computer 工厂也会拒绝 external descriptor，不会回落到 GLM 或 CUA/OSWorld。报告会保留 external kind 和 ID，而不是伪报成内置选择值。`riskModel` 仍只接受既有 `off`、`same` 或内置模型选择。

若配置仍选内置 `model` / `computer`，但用 `createProvider` / `createComputer` 注入了其他实现，Run 会照常使用注入对象，报告则继续记录配置中的内置选择值。需要让配置与报告表达外部实现身份时，请改用 external descriptor。

外部 Computer 目前要求 `grounding: "off"`；CUA 的窗口、UIA、DOM 与 Hybrid 准备/筛选只适用于内置 CUA。external Computer 在 `open()` 后仍按实际 `ComputerSession.capabilities` 投影可用工具，不会套用 CUA window allowlist。Risk Guard 只检查既有 ComputerTool 到 GUI Action 的路径；`category: "side"` 的自定义工具并不经过 GUI ActionPolicy。不要把会点击、输入或产生其他桌面副作用的实现伪装成 side tool；要进入 GUI 审批/风险路径，必须使用现有 `ComputerToolDefinition` / `ActionIntent` 合同。

`RunDependencies.createProvider` 与 `createComputer` 成功返回的实例归该 Run 所有；若工厂在返回前失败，它必须自己清理未交给 Run 的部分资源。Provider 可实现可选 `close()`；Computer 的 session 由 RunController 通过 `close(session)` 关闭，可选 `dispose()` 用于释放构造期资源或失败 `open()` 的残留。未启动的 Run 在 `RunHandle.close()` 时也会释放这两类资源；装配失败会关闭已创建的实例，清理失败会经 cleanup diagnostic / error callback 显示。应用工厂应每 Run 返回独立 Provider 和 Computer 实例，不要从多个 Run 共享一个有状态实例。此切片没有加入任意模型名、任意 backend 配置、动态插件发现、热替换或发布包合同。

若不传覆盖工厂，现有 GLM/Qwen 与 CUA/OSWorld 默认装配继续生效。TypeScript 实现应满足现有 Provider、Computer、ContextCompiler 和 ToolRegistry 合同；运行时行为若违反合同，会沿现有装配或 RunController 错误边界传播，不会静默回退到另一个默认后端。

需要恢复产品默认装配时，创建 `createRunFactory()` 即可；无需维护另一份默认模块清单。

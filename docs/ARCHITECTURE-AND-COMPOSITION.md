# 架构与装配合同

当前源码交接说明；项目状态与问题以 [PROJECT-HANDOFF](./PROJECT-HANDOFF.md) 为入口。

## 1. 一条执行链、多个应用入口

```text
CLI / TUI / 手机 Web → Host（手机路径）
                ↓
       app-runtime：ApplicationSession / createRunFactory
                ↓
            RunController
       ↙         ↓          ↘
 Context     ToolRegistry    EventWriter → Snapshot / feed / reports
   ↓         ↙      ↘
 Provider  状态工具  Computer tools → ActionPolicy → Computer Adapter
                                           ↓
                                      桌面 / OSWorld
```

Relay 只转发远程入口通信，不拥有 Runtime。Provider 不直接执行 GUI；Computer 不理解用户 Planning/Memory 业务状态。所有入口应复用应用组合根，不能各自实现第二个 Agent Loop。

## 2. 包与依赖方向

| 位置 | 职责与依赖边界 |
| --- | --- |
| `packages/protocol` | 序列化协议和共享类型；不依赖模型/驱动实现 |
| `packages/trajectory` | Event JSONL、校验/reducer、RunSnapshot、AssetStore；不执行动作 |
| `packages/runtime` | Controller、Registry、Policy 合同、工具执行、Monitor/Grounding 调度；不自行装配 GLM/Qwen/CUA |
| `packages/provider-glm`, `provider-qwen` | 模型 wire schema、消息/图片/历史与坐标转换、ModelTurn 解析 |
| `packages/computer-cua`, `computer-osworld` | Computer 后端；CUA 还拥有窗口、UIA/DOM、受管浏览器和诊断细节 |
| `packages/context` | 默认 Context 编译和投影策略；Runtime 依赖合同，不反向依赖此默认实现 |
| `packages/planning`, `memory` | Run 内状态模块、工具、物化与投影/召回 |
| `packages/risk-guard` | 分层 ActionPolicy 实现及可选模型审查 |
| `packages/app-runtime` | 公共组合根：工厂、配置、所有权、控制、feed/report 和远程适配 |
| `apps/cli` | CLI/TUI、环境解析、选窗与交互，不拥有另一套动作语义 |
| `apps/host`, `apps/web` | 电脑控制服务及浏览器 UI；Web 不读取模型密钥或直接调用驱动 |
| `packages/relay-connector`, `apps/relay` | Host 出站连接、设备路由和有界转发，不排队重放 GUI 动作 |

新代码优先放在职责所属包。跨包共享类型先确认确有生产者和消费者，不能把仅某驱动理解的私有引用塞进公共 protocol。

## 3. 公共装配入口

[SDK 入口](../packages/app-runtime/src/sdk.ts) 的 `createRunFactory(dependencies)` 先返回 RunFactory；这个返回的函数再接收 `ResolvedRunConfig`，返回 `Promise<RunHandle>`。`ApplicationSession` 负责多次用户任务的生命周期和一次一个 active Run；每个新任务仍获得独立 Run ID、输出目录和模块实例。

[RunDependencies](../packages/app-runtime/src/config.ts) 支持：

- `createProvider`、`createComputer`：替换模型和环境。
- `createToolRegistry`：基础工具集合；启用模块的工具仍由组合根追加，不能靠此入口偷偷移除它们。
- `createContextCompiler`：替换上下文策略。
- `createPlanningModule`、`createMemoryModule`：在既有状态/Event 合同中替换工具、物化、投影和可选召回。
- `createPolicy`、`createActionPolicy`：Runtime 准入及动作风险策略。
- EventWriter、AssetStore、clock、id 等测试/存储接缝。

可用 `{kind:"external", id:"my-provider"}` / external Computer descriptor 加对应工厂表达外部实现身份。没有工厂时必须失败，不静默回落内置实现；当前 CLI 模型枚举不等于整个 SDK 的扩展范围。

最小装配形式：

```ts
const createRun = createRunFactory({
  createProvider: providerFactory,
  createComputer: computerFactory,
  createContextCompiler: contextFactory,
  createPlanningModule: planningFactory,
  createMemoryModule: memoryFactory,
});
const run = await createRun(resolvedConfig);
try { await run.start(); }
finally { await run.close(); }
```

这里省略的变量必须实现仓库现有公共合同；不是可直接粘贴的完整应用。完整可运行的 Mock 装配例子见 [SDK 示例](./sdk-run-composition.md)。

## 4. 资源和状态所有权

- 工厂每 Run 创建独立有状态实例，成功返回后归 Run 所有；返回前失败，工厂负责清理尚未交付的资源。
- Provider 可 `close()`；Computer session 由 Controller 关闭，`dispose()` 处理构造或失败 open 的残留；模块可有 `close()`。
- 未启动的 Run 也需要关闭。清理有截止时间，超时或不确定状态不能宣称资源安全释放。
- Planning/Memory 新 module factory 不与同领域旧 Store/Recall factory 同时启用。关闭模块应不创建实例、不注册工具、不注入 Context、不产生维护请求。
- 模块只在事件提交后接收 mutation 进行物化，快照/事件副本避免扩展代码篡改权威事实。
- `restoreFromEvents` 是离线状态重建接缝，不意味着产品已经支持活动 Run 任意崩溃续跑。

## 5. 如何增加或替换能力

| 需求 | 应改哪里 | 必须保持 |
| --- | --- | --- |
| 新模型 | ProviderAdapter＋应用工厂 | 消费统一 ToolRegistry/ModelInput；输出统一 ModelTurn；明确坐标/continuation |
| 新桌面/VM | Computer＋应用工厂 | session、capabilities、观察/坐标、Receipt、关闭语义；不把失败伪装成功 |
| 新 Plan/Memory 策略 | Run-owned module factory | 既有状态与事件合同、Run 隔离、关闭无残留 |
| 新 Context 策略 | ContextCompiler | 工具调用/回执配对、当前观察、纠正、预算和 Provider continuation |
| 新工具 | Registry 与相应执行合同 | category/audience/参数/权限，Provider 不维护另一份清单 |
| 新入口 | ApplicationSession/RemoteRunApi | 同一预算、审批、Abort、所有权、轨迹，不能绕开 Controller |

`category:"side"` 工具不自动经过 GUI ActionPolicy。不要把点击、输入或其他 GUI 副作用伪装成 side tool。外部 Computer 当前不自动获得 CUA 专属窗口/UIA/DOM能力；新增适配要明确能力生产者，不能只打开一个配置值。

Monitor 仍在 Runtime 内，没有对等的独立 `createMonitorModule`。当前没有动态插件发现或热替换承诺；改接口时先维护现有消费者，避免为了未来扩展添加暂时无人更新的字段。

## 6. 架构变更检查

每个新增字段写清：谁产生、谁消费、何时更新、是否落盘、何时失效、由谁清理。每个新扩展点至少有默认实现和一个实际替换/测试消费者。新 Provider 或模块不得改变未知副作用、事件提交和桌面所有权语义。改动应先以小 PR 建合同与离线测试，再单独接应用入口与真实验证。

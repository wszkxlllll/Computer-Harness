# Planning / Run Memory 模块装配

本切片在 `createRunFactory` 的每个 Run 内分别创建 Planning 与 Memory 模块。默认模块仍使用现有工具与 Store；开发者可通过 `RunDependencies.createPlanningModule` / `createMemoryModule` 替换一整组行为：工具定义、已提交 mutation 的物化、Context 投影，以及 Memory 的可选召回。这里替换的是遵守现有 `PlanState` / `MemoryState` 和 Event 合同的策略，不是任意状态格式或运行中热切换。

两种模块都必须返回当前 `runId`；工具执行、写入和投影均检查 Run 隔离。Runtime 先提交 Event，再将 mutation 副本交模块 `apply`；投影也只接收状态副本，防止自定义代码改变权威快照或历史。工具仍由同一 `ToolRegistry` 提供给 Provider。关闭 Planning/Memory 时，不创建该模块、不注册其工具、不注入其 Context 内容。新模块入口与同一模块的旧 Store/Recall 工厂同时启用时明确报错，不做隐式合并。

若模块持有资源，可以实现可选 `close()`，由 Run 的有界清理负责。`restoreFromEvents` 是离线重建接口：可供分析或后续恢复功能消费，**目前不会恢复或续跑活动 Run**。模块工厂应每 Run 创建独立实例；策略版本与评测归因仍需下一阶段加入显式记录，不能仅凭包名推断一次 Run 使用了什么策略。

验证包括默认装配与关闭态、自定义工具真实调用、Context/Recall 消费、双 Run 隔离、恶意原地改写下的快照/Event/JSONL/文件重放一致性，以及正常、失败、未启动和超时清理。此轮只做离线验证；真实任务效果与自进化收益尚未证明。

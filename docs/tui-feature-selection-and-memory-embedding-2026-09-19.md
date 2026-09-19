# TUI 功能选择与 Memory embedding 配置

日期：2026-09-19  
状态：已实现并完成离线 focused 验证

## 1. 变更内容

TUI 首页现在支持在启动每个新 Run 前配置实验功能，不需要重新输入 CLI 开关：

- 首页按大写 `F` 进入 FEATURES 页面；
- 方向键或 `J/K` 移动；Space 切换布尔值；Left/Right 切换枚举值；Enter 保存；Esc 取消；
- 可选择 Planning、Memory（off/facts/entities）、Memory retrieval（off/lexical/hybrid）、Action batching、Context history 和 Progress Monitor；
- Risk Guard、Provider 和 Computer 不在此页面修改，继续由 profile/启动参数控制；
- 保存的选项只作用于下一次 Run。`ApplicationSession.startRun` 接受 feature-only overrides，Run 仍使用独立的 ToolRegistry、Context、Memory store 和 Monitor 状态。

Memory 关闭时 retrieval 会被强制为 off。选择 hybrid 只改变 Run 配置，不会自动联网；仍需在启动命令中提供 embedding endpoint，并通过 `MEMORY_EMBEDDING_API_KEY` 注入独立凭据。

## 2. 设计边界

TUI 不复制 Runtime 主循环，也不动态修改正在运行的 Run。Provider/Computer 连接、Qwen 坐标模式和 Risk Guard 仍在进程启动时确定。功能页的 hybrid 提示是配置约束提示，不是 API 连通性检查。

内置 embedding 适配器为 Qwen `text-embedding-v4` 兼容接口；默认 lexical 模式无网络。Embedding 只参与 gated Memory 的相关性排序，不构成事实验证、授权或审批依据；超时/不可用时按既有受控 fallback 处理，不自动切换供应商。

Qwen 北京兼容 endpoint 形状为 `https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings`，需要把完整 `/embeddings` URL 传给 `--memory-embedding-endpoint`。当前应用默认使用适配器的 1024 维配置，没有 CLI 维度开关；其他 embedding 厂商应实现 `MemoryEmbeddingProvider`，不要复用聊天模型 endpoint。

## 3. 验证

在 Node 24 / pnpm 11 环境执行：

```text
pnpm exec vitest run apps/cli/src/tui.test.ts packages/app-runtime/src/application-session.test.ts
pnpm run typecheck
```

结果：21 项 TUI/ApplicationSession 测试通过，typecheck 通过。新增回归确认功能页的选择会进入下一次 `createRun` 配置；没有启动 Provider、CUA、OSWorld 或真实 embedding 请求。

## 4. 后续边界

Hybrid 的真实语义质量、embedding 成本与隐私评估仍需独立实验；TUI 页面不替代真实 API/桌面验收。新功能应继续通过 `ApplicationSession` 与 Runtime 合同接入，不在 TUI 内注册工具或维护第二份 Memory 状态。

# Qwen flat 源码复审与单协议迁移

日期：2026-09-15
文档角色：审计 / 结果
状态：当前证据
当前入口：[Stage 6 收敛与下一阶段起始状态](./stage-6-convergence-and-start-state-2026-09-15.md)
基线：当前仓库工作树
范围：Qwen Provider schema、历史序列化、提示词注入、解析和回归；不覆盖真实桌面成功率
结论：**通过源码门槛，已删除 `anyOf` strict 双路径；允许继续做统一 flat 协议的真实任务验证。**

## 复审发现

迁移前 flat 已通过单调用、GUI Batch、Plan/Memory Composite、多轮 Memory/Planning 和 Control 定向 API 探针，但源码仍有四个不适合直接设为默认的问题：

1. Tool Catalog 由 `strictToolCatalog` 可选开关控制。flat schema 不携带精确工具参数分支，关闭 Catalog 会让模型失去必要语义。
2. flat schema 的 `name` 只是非空字符串，未限制为当前 ToolRegistry 投影，无法在 Provider wire 层阻止虚构工具名。
3. flat envelope 提示可能在 `native_tools` 模式下注入，与原生 tool-calling 协议冲突。
4. strict JSON 响应中的 `reasoning_content` 被解析但未写入 `ModelTurn.continuation`，与 GLM 和 Runtime continuation 合同不一致。

## 已实施收口

- 删除 `Qwen38StrictSchemaMode`、`strictSchemaMode`、`strictToolCatalog`、legacy `kind=tool_call/tool_calls` 解析和 `anyOf` schema 生成器；
- `strict_json` 现在始终使用 `{ "calls": [...] }`，始终从 `ModelInput.tools` 注入紧凑 Tool Catalog；
- response schema 的 `name` 使用当前已注册工具名枚举，`arguments` 保持宽松 object，精确校验仍由 ToolRegistry/Runtime 承担；
- strict 历史 assistant 调用统一序列化为同一 `calls[]` envelope；
- 只有 `strict_json` 接收 Catalog 和 flat envelope 指令，`native_tools` 不接收错误协议提示；
- 当前存在 Control 工具时，动态列出其名称并明确每个 Control 必须单独一轮返回；
- strict tool-call turn 现在保留 `reasoning_content` continuation；
- 实验脚本移除 `--qwen-schema` 和旧配置参数，避免继续产生双协议结果。

## 提示词注入判断

注入位置正确：它发生在 Qwen Provider 边界、基于本轮 `ModelInput.tools`，不会污染公共 Runtime 或其他 Provider。职责分为三层：Catalog 说明可用工具与参数；Envelope instruction 说明 Qwen wire format；Control boundary 说明跨轮不变量。最终权限、参数、顺序、Batch 和副作用校验仍由 Runtime 执行，提示词不是安全边界。

## 验证

- `pnpm exec vitest run packages/provider-qwen/src/index.test.ts`：18/18 通过；
- `pnpm typecheck`：通过；
- `pnpm test`：166/166 通过；
- 两个相关 `.mjs` 脚本通过 `node --check`；
- 源码扫描未发现 `strictSchemaMode`、`strictToolCatalog` 或 `any_of` 活动引用。

本次未调用付费 API、未操作 CUA/OSWorld/真实桌面。既有真实 API 证据支持协议选择；下一次真实任务实验应只使用统一 flat 版本，不再运行 anyOf 对照。

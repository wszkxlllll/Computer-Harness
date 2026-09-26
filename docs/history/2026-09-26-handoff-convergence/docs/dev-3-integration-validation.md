# DEV-3/4/5 离线集成验证结果

日期：2026-09-18
文档角色：验证结果
状态：本地离线验证通过；未执行 Hosted CI、真实模型、真实桌面或 VM
范围：当前工作树的全仓 typecheck、Vitest、CLI help 与 whitespace 检查；不代表任一 Hosted run 或实机闭环。

## 1. 实际环境与命令

使用 Node.js `24.19.0`、pnpm `11.19.0`，Node 路径按项目约定前置。实际执行：

```powershell
pnpm run typecheck
pnpm test
node apps/cli/dist/index.js --help
git diff --check
```

## 2. 结果

- `pnpm run typecheck`：退出码 `0`。包含 workspace project references 与 CUA spike `tsc --noEmit`。
- `pnpm test`：退出码 `0`；Vitest **33 个测试文件、344 项测试**通过。
- Monitor 计数：`packages/runtime/src/progress-monitor.test.ts` 在本次 full test 中实际通过 **9 项**，已包含在上述 344 项中，不另行相加。
- Direct CLI help：退出码 `0`，打印 usage 后退出；未读取 provider credential、未调用模型、未执行桌面动作。
- `git diff --check`：退出码 `0`。Git 仅提示工作树文件将按仓库规则由 LF 转换为 CRLF，没有 whitespace error。

## 3. 证据边界

本次验证覆盖当前共享工作树，包括并行 worker 尚未提交的 Context、Provider、Runtime、Trajectory、Protocol 与 app-runtime 修改；不能把它等同为某个单独 commit 的独立回归。Monitor 9 项测试确实随 full suite 执行，但 Monitor 尚未接入 online Runtime consumer，不能宣称在线 stall 检测、guidance、help/stop 或视觉特征能力已验收。

此前文档或 worker 消息中的 **335 tests** 属于旧 baseline/历史快照，不是本次最终计数；本次可复核的 full test 计数是 33 files / 344 tests。

之后 DEV-4 行为批次在 `01a6d47` 完成并新增了 scope/applicability/revalidation 代码与 focused 回归；本报告的 344 项不是该 commit 之后的最终 full 证据，不能移作最终计数。DEV-4 行为批次当前以 root typecheck 与 Memory/Context/Runtime/Trajectory focused 证据为准，待 Monitor 收口后再由协调者安排一次最终 full。

没有调用真实 GLM/Qwen API、没有读取 `.env`、没有操作真实桌面/窗口/VM、没有上传运行资产，也没有 Hosted CI 结果。当前工作树仍保留其他 worker 的未提交修改，本次只新增本报告，未暂存或提交它们。

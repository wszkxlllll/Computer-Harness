# PR27 第二次 CI 失败独立核对

日期：2026-10-12。Root 按 Sol 交接只读获取 GitHub Actions 日志，未重跑 CI、修改源码或操作桌面。

PR27 `9af208e` 的工作流 `38156351258` attempt 2 实际失败。失败 job 为 `114522262790`，Windows 离线测试 1 failed / 1808 passed；另外三个验证 job 成功，ci-required 随矩阵失败。不得把 attempt 1 的 Runtime 等待超时当成本次原因。

本次失败为 `packages/app-runtime/src/remote-run-api.test.ts:2211` 的公开候选列表测试。它对整个 JSON 字符串执行 `/pid|windowId/iu` 否定断言。随机不透明 token 恰好包含 `HpId`，被大小写不敏感的 `pid` 正则命中；日志中的候选仅有 `token`、`appName`、`title`、`previewRequired`，未出现被禁身份键。

这是公共测试对随机值的误判，不是 Windows 原生实现问题，也不是本次评测器业务发现功能的失败。应检查序列化后的结构键，而非在任意值中搜索键名；保留真正泄露 `pid` / `windowId` 字段的拒绝反例。无需为此扩展平台工作，也不建议第三次盲重跑。

私有只读证据保存在 `runs/astra-autonomous-20261010-sol-luna/A06-private/root-pr27-ci-attempt2/` 的 jobs.json 与失败 job 日志。获取 API 凭据仅用于内存中的认证 GET，日志重定向未携带认证头；未保存凭据。已将最小修复建议交 Sol / Luna。

01:38 Root 在 integration 当前源码只读搜索确认：同文件共有五处未给字段名加结构边界的 `/pid|windowId/iu` 断言，分别检查三处 `choices`、一处 `completed` 和一处 `first`。后两者的随机 Run 标识也有同样误判可能，应一并改为键检查。已有 `events` 的 ` /"pid"|"windowId"/iu ` 断言带字段引号，不属于本次随机字符串误判范围。行号会随分支变化，修复应按断言内容定位；本条未修改测试或重新运行 CI。

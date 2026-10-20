# 批次0/1本地冻结与部署单

日期：2026-10-06，Asia/Shanghai。状态：冻结源码，允许（10）准备本地生产链路验收；未部署、未实际API验收、未保存重开、未远端推送。整个批次0尚未全部完成。

## 固定交付

- 树：`/Users/guoyuhang/Desktop/大创/Computer-Harness-three-track-integration`；分支 `codex/three-track-integration-20261006`。
- 源码冻结 SHA：`c84d6d11b9cf884e697cab11a81d1a09b111e784`。本部署单的后续文档提交不改变此源码版本。
- 起点 PR22：`bb17a7b3838858e6fb9b95a2e35bf737f0f828e0`；来源 PR24：`39a3b2aa9779024b30da50b0d2ef6b952163e2f4`。
- 326 tracked apps/packages/native 源码指纹（排序path-NUL-content-NUL）：`9eb8e96ad9f7b5667c536612b7b420223e55bbc7c261ec3e328413bf2ddc1c1f`。
- pnpm-lock SHA256：`44081c30484355a86f76adf86e9da8b61f309eef8d1a2ecb20cb0b2687295c60`。
- 实际25业务/测试文件与逐项功能见 [F002](../../a-line-sync/fixes/F-20261006-002.md)；其余变化仅执行说明与交付证据。computer-cua/native/Web源码、两个probe脚本均零diff。

## 验证边界

独立6.1Sol medium最终r5报告：同一源码版本 pnpm test exit0，111 Vitest套件1667/1667、TAP71/71；typecheck0、diffcheck0。协调方实际重新核源码指纹、锁hash、25文件清单、关键diff及staged diffcheck并冻结，未重复运行全部测试。历史r1-r4失败保留。全部HTTP正负控是mock或loopback，不算真实API通过。

默认text/wire=16384/24576；显式私有配置可覆盖，测试方必须核有效值，不打印私密配置。wire未配置回退text。超时、Qwen默认、风险审批未以本批为由全局放宽。

## 部署执行与四类版本

唯一现场负责人（10）。先读 [统一计划](./three-track-execution-plan-2026-10-06.md) 与F002，确认无在途Run/输入并发布test_reserved；不切共享原checkout、不覆盖原dirty或共享dist。使用本隔离树按既有安全配置准备依赖、重建Host及其workspace依赖，并核Web产物；必要时重建本地Relay，但不进行正式公网发布。不要复制或输出凭据。

1. 源码：确认冻结SHA、clean或仅明确测试文档dirty，重算指纹和lock。
2. 构建：记录实际Host/Web/Relay输出hash与构建命令；F002已有Web hash仅作比较，不据产物存在宣称手机加载。
3. 进程/驱动：记录PID、启动时间、源码/构建来源、有效预算、实际CUA版本和加载binary/addon/dylib hash。本批未替换原生驱动；T0606001安装盘点不是此次加载证据。能力问题仍按批次2处理。
4. 手机：记录实际origin与JS/CSS资源hash对应构建，确认页面/Host/Relay合同一致。配对仅在失效时重新生成，本轮不提前要求用户重复扫码。

批次1采用原完整任务和真实可预览新空白目标；不要盲选或让人工代输入。取得同Run/requestId/decisionId/attempt/preparedHash及预算估算四项，在脱敏provider-exchanges.jsonl查headers_received/status或可靠交换，证明真实HTTP进入。started或fetch_invoked单独不算HTTP成功；记录缺失不算零请求。分别记录prepare、响应头、正文、超时和取消；失败无条件重试或重放GUI均禁止。

## 待验收与回退

目前只关闭离线预算/请求诊断修复；真实API响应性能、手机网络、预览、Mac能力/sheet、Windows旧值追加保护、中文输入保存重开、跨应用及控制都未计通过。PR23不作为当前成功判据。测试端形成自己的测试revision后再签收。

共享原PR24和本PR22起点仍保留。实际回退单位为测试方已记录的源码/依赖/驱动/构建组合，不把历史版本当全功能放行。先结束Run、确认无输入在途、发布test_released，再由（10）回退；保留失败日志/成果，unknown副作用只读取证、不重放。不自动push/merge/公开评论/公网发布。

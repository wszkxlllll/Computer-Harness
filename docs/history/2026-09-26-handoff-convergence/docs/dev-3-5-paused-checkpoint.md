# DEV-3/4/5 暂停检查点

日期：2026-09-18。历史状态：用户曾明确要求暂停；该暂停已由后续明确恢复指令解除。本文件保留暂停时证据与边界，不代表当前仍禁止已授权的文档收敛；本轮只做文档一致性整理，不自动调用 API、操作桌面或推送。

## Git 状态

- 分支：`codex/dev3-context-memory-guard`。
- HEAD：`6da1caafec0123ab94d2279450154f09e3816548`。
- 暂停前唯一未跟踪文件：`docs/dev-4-5-integration-review.md`，保留独立审查证据，不删除。
- 本检查点文件在暂停时也是尚未提交的状态记录。暂停时未 push、未创建或合并 PR；恢复后的文档工作仍未 push。

## 已完成的实现与证据

- Context：职责拆分、历史组裁剪、Memory 配额、ContextTrace、Provider prepared request、请求/重试关联、Qwen 实际 cache usage 解析及稳定前缀离线回归。
- Memory：Run/ComputerSession scope、current/history、普通事实与待核实线索分区、实际 rendered/omitted Trace、生命周期物化处理。没有按动作数、事件数或帧数自动判定事实过期的 TTL。
- Monitor：有界候选检测、off/shadow/guidance、Runtime 安全边界接入、CLI 开关；审查发现的 shadow 求助、多调用中断、事件递归等问题已作实施修复。最新两项修复为 `eec591c`，最后一轮独立确认尚未完成，不能宣称最终全部放行。
- 检索：`memory_search` 与自动 Context 共用服务；off/lexical/hybrid，默认无网络 lexical，hybrid 要求显式独立 endpoint/凭据；Plan 非必需。实际排序影响 ModelInput。上轮已记录的 4 次合成 Qwen embedding HTTP/64 tokens 仍只是 pilot 证据，不是集成后真实生产运行；源码与结果见现有 Memory retrieval 文档。
- 实施者最后全量验证：Node 24.19.0 / pnpm 11.19.0，36 个文件、389 项测试通过；typecheck、CLI help、offline frozen install、diff-check 通过。不是暂停时重新运行的测试，也不是 Hosted CI。
- 真实 embedding pilot：仅合成内容，Qwen text-embedding-v4 共 4 次 HTTP、0 失败/重试，返回 usage 合计 64 tokens。它证明 Adapter/检索服务小样本链路，不证明完整桌面任务或检索总体质量。

## 暂停时未完成的工作（历史记录）

1. Sol 的最终检索专项审查及 `eec591c` 定点确认被中断；尚无新的完成报告。
2. 刚安排的 GLM/Qwen 合成 Memory 工具协议测试被中断，未收到执行结果，不计为通过。恢复前先核对是否留下请求记录，不能假定预算完全未使用，也不能把此前 embedding pilot 当成此次模型测试。
3. 暂停时两个运行 Agent 已中断，另一实施 Agent 已完成。对本轮 Memory probe 名称的进程检查未发现匹配的存活进程；这不是对所有系统进程的扫描结论，不终止用户自己的服务。

## 恢复后当前收敛顺序

用户已明确要求继续后：先读取本文件、Git 状态和当前入口；retrieval integration review 的 P1/P2（lifecycle consumer、长 goal/correction、exact identifier）已由 `61c6aff` 修复，并由当前树 36 files/393 tests 的独立 full 覆盖。随后 synthetic ORCHID 协议 probe 已由 GLM/Qwen 各 2/2 完成，无 GUI action；真实桌面/VM、正式评测和远端推送不由本恢复指令自动授权。

完整 InstructionState/语义指令修订、最终 Provider 输入预算硬约束、target/generation、独立视觉验证、真实 Monitor 效果、跨 Run Memory 等仍按既有文档列为未完成或未验证；不要把本次检查点称为 DEV-3/4/5 全部完成。

## 当前文档整理备注

- 修复前 36 files/389 tests 是历史证据；当前修复树独立 full 为 36 files/393 tests，root typecheck、CLI help、锁文件安装和 diff-check 均通过。
- retrieval integration review 的 P1/P2 已关闭；API 第二轮实际结果已由独立报告记录，仍不得从窄 synthetic 协议结果外推语义质量、真实桌面或 DEV-3/4/5 整体完成。

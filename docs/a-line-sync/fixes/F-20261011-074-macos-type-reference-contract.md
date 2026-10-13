# macOS type 引用合同修复（2026-10-11）

真实完整 T2 Run `run-1791725133526-8670a646-c6d` 中，模型在两次 `type` 调用主动提供 `elementRef`，适配器按既有 Mac click-only grounding 合同拒绝；这两次拒绝没有原生输入派发。它们与随后两次原生前台焦点拒绝分别记录，不能合并归因。

本次仅修改 Runtime 工具映射和合同测试：已知 `darwin` 的显式 `elementRef` 在映射前明确拒绝并提示省略引用、使用原生焦点输入；macOS 多行输入不再自动附加 UIA 引用。工具说明与 schema 说明同步。其他平台与未声明平台的原有行为保留，适配器及原生输入守卫不变。

Luna 实施：11 项定向测试、Runtime build、diff check 通过。Sol 独立阅读两文件改动，并实际重新执行同一 11 项测试通过；已核查 controller 的映射异常走正常 rejectToolCall 反馈且不派发原生动作。未重复原生构建、签名或真实输入。后续完整业务 Run 仍须新空白目标和真实焦点证据；本修复不代表 T2 完成。

正式预算 API 已将 A05 预占续至 main120/risk6/total126、revision2；独立读取状态及回执匹配，实际仍 main44/risk0/total44、sequence44，硬上限不变。全历史仍 290 次实际请求、267 次已知 usage 共 5,087,544 tokens、23 次 usage 未知。

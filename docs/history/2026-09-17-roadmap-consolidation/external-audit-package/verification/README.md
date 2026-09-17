# 本次验证范围与复现说明

运行环境：Node v22.16.0，Linux 容器。源码依据固定到 Computer-Harness `39ff27f9a4ef5431450df6991793403ec890f993`。

执行命令：

```text
node --test verification/behavior-probes.mjs
```

`probe-results.tap` 是本次真实输出：6 个用例，6 pass，0 fail。**pass 的意思是成功复现当前有问题的行为，并不是修复后应该保留这些行为。**正式回归测试应在仓库真实实现上断言相反的期望。

| 用例 | 源码位置 | 实际证明的范围 |
|---|---|---|
| 用户纠正被裁剪 | context/index.ts::fitEventsToTokenBudget | 特定事件序列在预算裁剪中删除了 user input |
| 单事件超预算 | 同上 | 单个大事件未被该函数限制 |
| replacement 未知 taskId | runtime/run-controller.ts::validateMemoryTaskLinks | mutation 分支遗漏校验 |
| replacement / Planning off | 同上 | 同一遗漏也绕过 Planning enable 条件 |
| 描述词抑制风险关键词 | risk-guard/index.ts::scanDeclarationText | 仅证明本地文本分支漏掉信号，不是完整危险 GUI 实验 |
| native arguments 日志 | cli/index.ts::summarizeProviderResponse 的 native 分支 | 合成文本保留在诊断投影中 |

代码提取去除了 TypeScript 类型；Runtime 实例字段改成函数参数；诊断测试仅提取 native tool-call projection。它们不 import 仓库，不使用真实 API、秘密、用户文件或桌面。对照出处在源码审计文档 S01/S03/S08/S10。

容器不能联网克隆并安装该仓库依赖，因此完整 pnpm install/typecheck/Vitest 未在这里执行。也没有执行 CUA native、Windows fixture、OSWorld 或 GitHub Actions。其他问题按“源码确认/条件风险/设计缺口”标注，不将静态分析写成动态验证。

模板 YAML 经本地解析和必要字段检查；GitHub 执行结果仍以用户合并模板后的首轮 workflow 为准。

## 附件模板的独立检查

`template-checks.json` 记录了工作流 YAML 解析、只读权限、完整 Action SHA、上传路径和超时配置的结构检查，以及候选归档脚本在临时合成 Git 仓库中的烟测：只归档 tracked source、manifest/校验和正确、拒绝覆盖已有候选、拒绝 tracked 未提交修改。没有在用户仓库运行构建，也没有启动 GitHub Actions。

`validate-deliverables.py` 可在安装了 Python/PyYAML、Node 和 Git 的环境运行；它只检查这份附件并创建临时合成仓库。`action-pins.json` 保存本次核对的官方 Action 提交。

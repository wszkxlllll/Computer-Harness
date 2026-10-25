# 早期实验脚本归档

这里保留 16 个早期脚本及说明文件，供追溯和回归验证。

| 内容 | 用途 |
| --- | --- |
| `stage4-local/` | 早期本地夹具评分、批量评分与 runner 检查 |
| `stage5-osworld/` | 早期虚拟机任务执行、预检与轨迹分析 |
| `batch-backend-fixture.mjs` | 批处理后端合成夹具 |
| `create-nonsensitive-fixture.ps1` | 生成早期 API 实验使用的无敏感信息图片 |
| `execution-segment-api-conformance-metrics*.mjs` | ExecutionSegment 实验指标统计与测试 |

从仓库根目录运行这些文件。相对导入及相关入口已调整到归档位置；原有评分与统计回归测试继续由 `scripts/test.mjs` 执行。历史文档中的旧命令按本目录的对应路径查找。

当前手机使用入口仍是 `scripts/setup-mobile.ps1` 和 `scripts/mobile.ps1`；真实生活任务评测使用 `scripts/life-eval/`。

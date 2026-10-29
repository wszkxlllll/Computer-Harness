# 脚本入口

普通使用只需要两个入口：

| 脚本 | 用途 |
| --- | --- |
| `setup-mobile.ps1` | 首次准备配置、官方驱动与项目依赖 |
| `mobile.ps1` | 启动电脑端，连接手机 |

安装和使用步骤见[开始使用](../docs/getting-started.md)。

其余脚本供开发与验证使用：`harness.ps1` 提供桌面命令入口；`life-eval/` 运行当前生活任务评测；`cross-window/`、`voice/` 和根目录探针用于诊断；`test.mjs` 组织回归测试。`travel/` 中的指标采集仍被生活任务评测复用，保留在原位。

`validation/` 保留当前测试入口使用的指标与轨迹核验脚本。

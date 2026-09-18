# DEV-4 Qwen embedding synthetic pilot results

日期：2026-09-18

状态：受控真实 embedding pilot 已完成；这是独立 retrieval service 的证据，不是正式 `memory_search`/Context/Runtime 集成，也不是完整 DEV-4 完成证明。

## 实际执行

运行入口：

```text
<repo>/scripts/dev4-memory-retrieval-qwen-pilot.mjs --env-file <env-file>
```

实际使用的是 Qwen 北京区域官方 OpenAI-compatible embeddings endpoint，由进程内读取原 `.env` 的 `DASHSCOPE_API_KEY` 和 `DASHSCOPE_WORKSPACE_ID` 组成官方 workspace endpoint；没有输出或复制 key、workspace、endpoint 实值。模型为 `text-embedding-v4`，维度 256。脚本没有 fallback、retry、endpoint rotation，也没有读取截图、桌面、VM 或真实用户 Memory。

由于当前 Memory package 整体 build 仍被其他 worker 尚未合入的 `classifyMemoryFactAdmission` 导入阻塞，本次用 Node24 对 retrieval 四个源码文件做了独立 TypeScript 编译后运行；调用链仍是真实 Qwen adapter → `HybridMemoryRecallService` → gate/ranker，不是 curl 或仅 mock。

## 安全边界与计数

| 指标 | 实际结果 |
| --- | ---: |
| HTTP attempts | 4 |
| 成功/失败 | 4 / 0 |
| 自动重试 | 0 |
| 合成输入字符总数 | 197 |
| Provider 返回 usage | 5、46、9、4 tokens（总计 64；按请求顺序） |
| 最大请求预算 | 6 attempts、10K input tokens |
| 原始响应/向量/凭证落盘 | 否 |

4 次请求顺序为：首次 query、一次 document batch、exact query、中文 query。所有 facts、goal、query 均为脚本内 synthetic 中英文内容；usage 是 provider 实际返回值，不推断 cost 或免费额度。

## 结果摘要

| 场景 | admitted 首位 | match | superseded `legacy-invoice` |
| --- | --- | --- | --- |
| English paraphrase：bill deadline | `invoice` | `semantic` | 排除，reason=`superseded` |
| Exact identifier：`invoice_record` | `invoice` | `exact` | 排除，reason=`superseded` |
| 中文 paraphrase：会议地点 | `meeting` | `semantic` | 排除，reason=`superseded` |

三次搜索都输出 `semanticStatus=used`。查询对象没有 Plan 字段，证明该独立 service 的 query path 不依赖 Planning。高相似旧 invoice 事实在 gate 阶段排除，未进入 document embedding batch；不能因 semantic 相似度重新召回 superseded 事实。

## 限制与下一步

- 本次只验证 synthetic facts 的真实 embedding、exact identifier、中文/英文 paraphrase、superseded gate 和实际 usage；没有发送用户 Memory、文件路径、截图或桌面状态。
- 本次直接调用独立 service，尚未接入公共 exports、`memory_search` tool、Context projection、app config 或 Runtime mutation hook。
- 没有宣称 Qwen embedding 的语义质量、成本、免费额度或 Hosted CI 状态；正式接入前仍需 mock 回归、late revision/timeout、跨 session gate 和共享 Memory 修复交接。

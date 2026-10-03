# A 线修复聊天与实机测试聊天同步

日期：2026-10-03  
文档角色：入口 / 交接  
状态：当前执行  
当前入口：[A 线实际任务计划](./a-line-runtime-delivery-plan-2026-09-27.md)  
基线：`codex/a-line-macos-compat-20260928`，HEAD `2fd5074`，存在未提交修改  
范围：两个指定 Codex 聊天共享问题、修复、版本和实机结果；不新建 Git 分支，不自动合并聊天历史。

## 聊天与职责

| 角色 | 聊天原名 | Thread ID | 写入职责 |
| --- | --- | --- | --- |
| 修复 | 确定三人分工步骤 (8) | `01a10059-ed82-78a1-9a0a-156c56cd1673` | 源码、回归测试、`a-line-sync/fixes/` 中的修复交付及接收记录 |
| 实机测试 | 确定三人分工步骤 (10) | `01a10084-4097-7200-8cf3-5c0c7f65c413` | 页面/配对/运行版本准备、问题复现、`a-line-sync/issues/` 和 `a-line-sync/tests/` 中的证据与运行占用记录 |

双方实际共用同一 Git checkout。桌面项目目录是当前 Git 根目录；聊天声明的旧 Documents 工作目录为空，不在其中复制源码或建软链接。此处的“分支”指聊天分工，当前并非两个隔离 Git 工作树。

用户还在“确定三人分工步骤 (6)”（Thread `01a10088-17c4-7351-a68b-953b0af94781`）明确指定它负责远端代码更新和审查，并要求与这两个聊天联系。三方角色与远端操作见由 (6) 独占维护的[三聊天协作入口](./a-line-three-thread-coordination-2026-10-03.md)；本文件维护实机问题与修复反馈，不并行改写三方入口。`git switch/add/commit/push` 由 (6) 协调，真实运行、构建与重启由 (10) 协调。

用户已在测试聊天直接要求两个聊天协作并建立信息同步。该授权用于这两者之间的任务相关通知；修复聊天可读取测试聊天本轮原始用户消息核实授权。其他聊天不属于本协议。

## 每轮同步与通知

每次开始工作先读本文件及 `a-line-sync/` 下的新增记录。以文件中的证据为依据，消息只负责提醒。建立连接、问题已接收、修复可复测、实机通过或同问题重现时，向对应 Thread ID 发一条简短消息，包含记录路径、issue ID、event ID、版本和下一动作。

测试聊天发现问题先落 `issues/` 的新文件，再通知修复聊天；修复聊天在 `fixes/` 追加接收记录，之后按用户已有修复授权执行。修复完成写 `ready_for_retest`，列修改文件、回归结果、需构建/重启的组件和复测条件，再通知测试聊天。测试聊天核对运行版本后复测，写 `tests/` 新文件，并将结果通知修复聊天。

双方无需用户手工转述已落盘的诊断。聊天空闲时不会凭空实时共享上下文；收到消息或下一轮开始时处理共享记录。本轮没有创建定时轮询任务。

### 状态与记录规则

问题流程：`new → accepted/fixing → ready_for_retest → verified`。同一问题在对应新版仍出现则 `reopened`；新原因建立新 issue。环境不可用、版本不匹配、取消、部分完成分别记 `blocked / version_mismatch / cancelled / partial` 的测试结局，不能自动算成该修复失败或通过。

文件按事件追加，不覆盖旧证据，命名示例：`issues/I-20261003-001.md`、`fixes/F-20261003-001.md`、`tests/T-20261003-001.md`。同事件修改由原作者完成；另一方通过新事件回应，避免同时写同一个台账。每条记录包括：

```text
event_id / kind / issue_ids / previous_event_id
author_role / source_thread / occurred_at（Asia/Shanghai）
status / source_revision / fix_revision / test_revision
目标与初态 / 预期 / 实际 / 最小复现步骤
Run ID与脱敏日志位置 / 人工介入 / 下一动作
```

`previous_event_id` 和版本建立关联；旧版本的迟到测试不能关闭新版 issue。`verified` 写明实际覆盖的场景，离线通过和实机通过分别记录。敏感配置、凭据、完整私人截图和原始 Run 不进入同步文档，仅留本地脱敏索引。

## 共用源码与运行环境的交接

测试角色负责本轮本机 Host/Web/CUA、配对和桌面的运行准备；修复角色负责源码。源码与 build/运行进程分别交接，不能因文件已改就推定手机看到新版。

修复可复测后停止本批相关源码写入。测试聊天接受 fix revision，先发布 `test_reserved` 记录，再构建/启动并发布 `testing`，结束后写 `test_released`。每次占用记录写 owner thread、issue/fix revision、开始时间、Run ID（未创建写 pending）及结束条件。占用期间双方都不改相关源码、不同时构建共享 dist；测试角色以外不重启 Host/CUA/Relay 或操作被测桌面。

聊天中断或等待超时不自动释放；先确认 Run 已结束、无输入在途，再写释放记录。暂停的 Run 仍占用环境，不能据此改源码后恢复旧 Run。只有失败明确证明没有输入发出时才考虑恢复；未知副作用不重放。占用期间若必须改动源码，测试先结束 Run 并确认无在途输入，再释放并由修复接手。与测试代码无关的文档记录可以继续追加。

每个测试记录关联以下四类版本：

1. 源码：分支、HEAD、dirty 状态、修复记录；未提交修改增加相关源码内容指纹。
2. 构建：组件、构建时间、对应源码指纹与命令结果。
3. 进程：Host/CUA 的 PID、启动时间与不含秘密的配置摘要；说明是否由上述构建启动。
4. 手机页面：实际 origin、页面版本/资源标识与配对结果（不保存 token）。

指纹是指定文件范围的标识，不代替完整依赖版本。下列命令是初始七文件指纹的唯一复现入口；后续修复扩展范围时在 fix 记录声明新增文件：

```sh
node -e 'const fs=require("node:fs"),crypto=require("node:crypto");const files=["apps/host/src/index.ts","packages/risk-guard/src/index.ts","packages/computer-cua/src/cua-driver-computer.ts","packages/computer-cua/src/dom-grounding.ts","packages/computer-cua/src/managed-browser-host.ts","packages/context/src/projections.ts","packages/provider-glm/src/index.ts"];const h=crypto.createHash("sha256");for(const f of files){h.update(f);h.update("\0");h.update(fs.readFileSync(f));h.update("\0");}console.log(h.digest("hex"));'
```

## 初始同步状态与下一步

初始修复交付：[F-20261003-001](./a-line-sync/fixes/F-20261003-001.md)。接收状态：[T-20261003-001](./a-line-sync/tests/T-20261003-001.md)。问题来源：[I-20261003-001](./a-line-sync/issues/I-20261003-001.md)。

双向已确认：修复方已新增[ACK F-20261003-002](./a-line-sync/fixes/F-20261003-002.md)，测试方记录[连接完成 T-20261003-002](./a-line-sync/tests/T-20261003-002.md)。源码指纹匹配，修复方停止本批相关写入；目前等待运行准备，没有新实机 Run。

已继承上轮 P0 输入焦点/指纹与 P1 工具合同代码修复，历史离线 872+20 项、独立 266 项通过；本次建立同步不重复运行这些测试。该修复尚缺实机验收，部署及正在运行的进程版本本轮未检查。

下一步由测试聊天核对构建/进程并接受修复版本，然后用地址栏→网页输入框的小场景重复验证 5 次，覆盖缺省 type、search、动态重绘及失焦拒绝；短测试通过再跑完整 T1。此协议建立本身不启动桌面任务或应用模型 API，不推送远端。

Codex 聊天和工作树的产品概念参考 [OpenAI Docs：远程工程工作](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)；本项目以上同步方式由共享文件与指定聊天通知实现。

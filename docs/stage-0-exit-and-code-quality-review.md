# Stage 0 退出审查与代码质量检查

日期：2026-08-28  
审查方式：只读代码审查、TypeScript 类型检查、现有测试和最小运行诊断  
结论：可以继续 Stage 1；暂不进入 Stage 2 `RunController`

## 1. 总体结论

Stage 0 已经证明以下核心可行性：

- 独立 `cua-driver.exe 0.22.2` daemon 能返回完整 `2560×1600 @ 1.5` 桌面；
- TypeScript SDK 可以通过私有 named pipe 连接 daemon；
- 截图、点击、输入、动作后再观察和进程清理已完成一次授权验收；
- 嵌入式 Node 路径的 DPI 缺陷已经和 Harness 保存逻辑分离。

因此，上游 Issue 不阻塞 Computer-Harness 继续开发。Windows 正式 Adapter 应固定使用
独立 daemon 路线，直到上游明确修复嵌入式 Node DPI 问题。

当前可以继续完成 Stage 1 的 Protocol、Trajectory 和 AssetStore，但不能直接开始
Stage 2 `RunController`。审查时发现的 Trajectory 不变量问题已经在本轮修复并由测试
锁定；Stage 1 仍需完成其余存储边界和集成验收后，才能进入 RunController。

## 2. 已执行验证

### 2.1 自动检查

```text
pnpm run typecheck  通过
pnpm test           通过
```

现有测试结果：1 个测试文件、3 个测试通过。

这些结果只能证明当前代码可编译且已有断言通过，不能覆盖下述状态语义问题。

### 2.2 最小运行诊断

对当前编译产物执行了两项不修改源码的诊断：

```json
{
  "afterCompletion": {
    "status": "running",
    "stepCount": 1,
    "unresolvedActionId": "action-1"
  }
}
```

动作已经产生 `action.execution.completed`，但投影仍保留
`unresolvedActionId="action-1"`。

重新打开同一个 JSONL 文件并追加事件后：

```json
{
  "reopenedSequences": [0, 0]
}
```

同一个 Run 出现重复 sequence，违反 `sequence` 是 Run 内权威顺序的协议。

## 3. 必须先修复的问题

### P0：完成或失败事件没有清除 unresolved action（已修复）

位置：`packages/trajectory/src/index.ts:65-77`

当前 `nextSnapshot` 通过展开旧 Snapshot 保留了 `unresolvedActionId`，匹配当前动作的
`completed/failed` 事件也没有显式删除该字段。

影响：

- 已确定结束的副作用仍被当作结果未知；
- 恢复逻辑可能错误暂停；
- 后续动作可能覆盖或继承错误状态；
- `outcome_unknown` 语义失去可信度。

要求：匹配当前 unresolved action 的终态事件必须清除该字段；不匹配、没有 started
的终态事件不能静默被当作正常步骤。

### P0：重新打开轨迹文件会从 sequence 0 继续（已修复）

位置：`packages/trajectory/src/index.ts:118-170`

`JsonlRunEventWriter` 总是以 append 模式打开文件，但 `nextSequence` 每次实例化都从 0
开始。

当前阶段采用最小且明确的策略：

- 新 Run 的 writer 在目标轨迹已存在时直接失败；
- 暂不实现“扫描旧轨迹并恢复写入”；
- 等真正开发 Run 恢复流程时，再设计 resume writer。

不要在没有恢复消费者的阶段提前实现复杂断点续写，但也不能静默产生重复 sequence。

### P1：Reducer 对非法事件顺序过于宽松（已修复当前范围）

当前行为包括：

- 没有 `action.execution.started` 也能接受 completed/failed；
- terminal receipt 的 Action ID 不匹配时仍可能增加 `stepCount`；
- 没有验证 Event sequence 是否连续、递增；
- `approval.resolved` 不清除 `pendingApproval`，也不恢复 Run 状态。

这与技术计划中“非法事件顺序产生明确投影错误，不私自修正历史事实”的原则不一致。

要求：只验证当前已实现事件的必要不变量，不在本轮建设完整状态机。

### P1：现有测试没有覆盖其名称声称的行为（已修复）

位置：`packages/trajectory/src/index.test.ts:52-75`

测试名称是“records the latest observation and clears a completed action”，但测试只创建
Observation 并断言 `latestObservationId`，没有产生 started/completed，也没有断言动作
被清除。

至少补充：

1. started 后没有终态，保留 unresolved；
2. started → completed，清除 unresolved；
3. started → failed，清除 unresolved；
4. terminal Action ID 不匹配，明确报错；
5. 已存在轨迹不能用新 writer 从 sequence 0 追加；
6. approval requested → resolved，清除 pending 状态。

## 4. 不阻塞 Stage 1、但应在首个提交前处理的问题

### 4.1 仓库还没有初始提交

当前 `main` 没有 commit，所有文件均为 untracked。继续多人施工前应先建立可回退的
Stage 0 基线提交，并确保本地截图、下载的 CUA binary 和 `.stage0` 证据不进入 Git。

### 4.2 README 有两处失效说明（已修复）

- 根 README 原使用 `--click 300 200`，实际探针参数是
  `--click-x 300 --click-y 200`；
- 根 README 原指向 `../lightspeaker/docs/...`，实际计划书已经位于当前仓库 `docs/`。

当前 README 已使用正确参数和仓库内 `docs/` 路径。

### 4.3 构建缓存尚未排除（已处理）

当前工作区出现 `packages/*/tsconfig.tsbuildinfo`，已在 `.gitignore` 排除
`*.tsbuildinfo`；首个 commit 前仍应确认这些可再生缓存未被暂存。

### 4.4 Stage 0 输入证据不可复跑

`probe-daemon.ts` 当前只执行尺寸和截图，`comparison.json` 明确记录
`inputExecuted=false`。文档中的输入验收来自一次人工授权实验，而其
`daemon-run-r8` 临时目录已保留为本机 ignored 证据，但它不是可提交的自动化测试
fixture；正式 Adapter 前仍应把有限输入动作做成显式授权的 live contract test。

这不阻塞 Stage 1，因为底层可行性已经由人工验收确认；但在进入 Stage 3 正式
`CuaDriverComputer` 前，仍不能只依靠文字记录。

## 5. 代码质量中的正确方向

以下设计值得保留：

- `protocol` 不依赖 CUA 或 Provider 私有类型；
- 核心 ID 使用有限 branded type，没有给所有字符串过度加壳；
- 所有 GUI 副作用（除 wait）绑定 `ObservationId`；
- `ToolCall` 与 `ActionIntent` 保持两层语义；
- `RunSnapshot` 由无 IO 的纯函数 reducer 投影；
- JSONL 写入通过单队列串行化，并发 append 能得到调用顺序的 sequence；
- TypeScript 开启 strict、`noUncheckedIndexedAccess` 和
  `exactOptionalPropertyTypes`；
- Stage 0 spike 与正式 Adapter 边界清楚；
- 当前没有提前创建 Subagent、后台 Job、Verifier 或复杂 Context 框架。

整体架构方向正确。当前问题集中在少数运行不变量没有被测试锁住，不需要推翻协议或
重写仓库。

## 6. 推荐施工顺序

### Step 1：保存 Stage 0 基线

1. 修正 `.gitignore`，确认截图、binary、日志和 TypeScript 构建缓存不会提交；
2. 建立初始 commit；
3. 上游 CUA Issue 可独立准备，不阻塞后续本地代码。

### Step 2：修复 Trajectory 不变量

只修改 Reducer、Writer 打开策略和对应测试：

- 清除已终结 unresolved action；
- 拒绝不匹配或缺少 started 的 terminal event；
- approval resolve 恢复正确状态；
- 防止已存在 JSONL 被新 writer 从 sequence 0 追加；
- 用测试锁定上述行为。

### Step 3：完成 Stage 1 缺失产物

按技术计划继续实现：

- 最小 `AssetStore`，采用临时文件写入后 rename；
- 当前 RuntimeEvent 的必要顺序校验；
- 磁盘读取边界的最小 Schema 校验；
- Event → Snapshot 的完整 Stage 1 测试。

本阶段不实现 RunController、Provider、正式 CUA Adapter 或 Planning。

### Step 4：Stage 1 退出门槛

满足以下条件后进入 Stage 2：

1. 类型检查通过；
2. Reducer 的 started/completed/failed/outcome_unknown 测试通过；
3. JSONL 不会产生重复 sequence；
4. Event 写入失败时不会继续模拟副作用；
5. Asset 在 Event 引用前已经完整落盘；
6. 从合法 Event 序列可稳定重建 Snapshot；
7. 非法 Event 顺序得到明确错误。

## 7. 关于 Stage 0 的“20 轮”门槛

技术计划曾写“20 轮 observe → action → observe”。当前留存证据支持一次完整输入链和
多次只读 daemon 探针，不支持声称已经完成 20 轮输入稳定性测试。

建议不因此阻塞 Stage 1，因为 Protocol 和 Trajectory 可以脱离真实桌面开发；但应把
20 轮稳定性门槛移动到 Stage 3 的 `CuaDriverComputer` live contract test。届时由正式
Adapter 执行，获得的结果比继续扩充一次性 spike 更有价值。

## 8. 最终判定

```text
Stage 0 技术可行性       通过
独立 daemon 路线        通过
上游嵌入式 DPI Issue    待提交，不阻塞
Stage 1 当前代码         Trajectory 不变量已修复，资产/集成门槛待完成
直接进入 Stage 2         不允许
整体架构是否需要重做     不需要
```

## 9. 本轮实施记录（2026-08-28）

按照本审查的施工顺序，已完成 Trajectory 第一批不变量修复：

- `action.execution.completed/failed` 必须匹配未决的 `action.execution.started`，终态
  事件会清除 `unresolvedActionId` 并只计一步；缺少 started、重复 started 或 Action
  ID 不匹配都会明确报错；
- `approval.requested/resolved` 校验请求 ID，resolve 会清除 `pendingApproval`；批准
  恢复 `running`，拒绝结束 Run 并标记 `cancelled`；
- `reduceRuntimeEvents` 要求同一 Run 的 sequence 从 0 连续递增；
- `JsonlRunEventWriter` 对已有轨迹文件使用独占创建，拒绝新 writer 从 sequence 0
  静默追加；恢复写入留待未来单独设计；
- `readRuntimeEvents` 增加 JSONL 行号、事件类型和必要字段的最小边界校验；
- `FileAssetStore` 采用临时文件写入后 rename，并拒绝越出资产根目录的相对路径；
- 测试从原来的 3 项扩展为 13 项，覆盖上述成功和失败路径。

验证结果：

```text
pnpm run typecheck  通过
pnpm test           通过（1 个测试文件，13 项）
```

本轮仍未实现 RunController、Provider、正式 CUA Adapter 或 Planning；下一步是补充
Stage 1 的事件重建/资产引用集成测试，再重新检查进入 Stage 2 的门槛。

## 10. 上一阶段实现复审（纳入更新后的技术设计）

复审日期：2026-08-28
复审范围：commit `d1596ba` 中的 Protocol、Trajectory、AssetStore、测试与文档
当前结论：本节记录的两个数据完整性 P0 和协议收口工作已在后续修改中完成；Stage 1
仍需集成验收，修复前不进入 Stage 2 的原门槛已经解除。

### 10.1 已确认完成且实现方向正确

- `action.execution.completed/failed` 已正确清除匹配的 `unresolvedActionId`；
- 缺少 started、重复 started 和 Action ID 不匹配会明确报错；
- `reduceRuntimeEvents` 已检查从 0 开始的连续 sequence；
- 新 Writer 已拒绝从 sequence 0 追加到已有 JSONL；
- README 参数、仓库内文档链接和 `*.tsbuildinfo` 忽略规则已修正；
- `FileAssetStore` 已采用临时文件后 rename，避免 Event 引用半写文件；
- 当前 `pnpm run typecheck` 和 13 项测试全部通过；
- 已建立初始 Git commit，工作树干净。

这些实现没有因为后续新增用户纠正设计而失效，应继续保留。

### 10.2 P0：一个轨迹 Writer 可以混写多个 Run（已修复）

位置：`packages/trajectory/src/index.ts:156-188`

`JsonlRunEventWriter` 没有绑定 `RunId`，每次 `append` 都接受调用者传入的任意
`draft.runId`。最小诊断已经写出：

```json
{
  "mixedRunIds": ["run-a", "run-b"]
}
```

这会让一个 Run 的权威轨迹包含另一个 Run 的事件，直到重建 Snapshot 时才报错，文件
本身已经被污染。

Stage 1 修复要求：一个 Writer 在创建时绑定唯一 `RunId`，或者在第一次 append 后锁定
该 RunId 并拒绝后续不一致输入。由于当前没有正式消费者，优先采用构造时绑定，减少
调用者重复传错的可能。

### 10.3 P0：AssetStore 会静默覆盖已经存在的资产（已修复）

位置：`packages/trajectory/src/index.ts:249-290`

同一个 `relativePath` 连续写入两次时，当前 Windows 实测第二次没有报错，旧文件内容
由 `[1]` 变成 `[2]`：

```json
{
  "assetOverwrite": {
    "error": null,
    "finalBytes": [2]
  }
}
```

一旦旧 `observation.created` Event 已引用该路径，后续覆盖会在不修改历史 Event 的情况
下改变旧 Observation 的实际图片，破坏 Trajectory 的不可变事实语义。

Stage 1 修复要求：资产目标路径必须是 write-once；目标已存在时明确失败。实现仍应保证
临时文件完整写入后，才原子地发布为最终文件，并补充重复路径测试。不要通过“覆盖后
更新旧 Event”修补历史。

### 10.4 P1：磁盘事件校验过浅，且容易与协议枚举漂移（已修复当前范围）

位置：`packages/trajectory/src/index.ts:308-460`

当前解析器只检查部分嵌套字段。例如以下不完整 Observation 会被接受：

```json
{
  "type": "observation.created",
  "observation": { "id": "o0" }
}
```

它缺少 `runId`、`computerSessionId`、`capturedAt`、`viewport` 和 `screenshot`，后续消费者
却会按完整 `ObservationFrame` 使用。

同时事件类型目前分别存在于：

- Protocol 的 TypeScript union；
- `runtimeEventTypes` 手工集合；
- `parseRuntimeEvent` switch。

更新设计刚加入 `user.input.requested/received` 后，这三处已经出现现实的同步压力。

Stage 1 应把磁盘边界 Schema 收敛为一个运行时权威来源，并由它校验实际会被消费者
读取的完整字段。可以引入技术计划已经选定的 Zod；不要继续通过更多分散的字符串集合
补丁扩充手写解析器。

### 10.5 P1：拒绝一次审批不应默认取消整个 Run（已修复）

位置：`packages/trajectory/src/index.ts:106-125`

当前 `approval.resolved(approved=false)` 会直接产生：

```text
status = finished
outcome = cancelled
```

这会把“用户不允许这一个风险动作”等同于“用户取消整个目标”。更新后的交互设计需要
让 Agent 能收到拒绝结果并重新规划。

Stage 1 建议语义：审批拒绝只清除 `pendingApproval` 并回到 `running`；审批结果作为事实
进入下一轮 Context。只有显式 cancel 或 `run.finished(cancelled)` 才结束整个 Run。

### 10.6 更新设计中应回补到 Stage 1 的内容（已完成数据协议部分）

更新后的
[`run-turn-tool-and-user-correction-semantics.md`](./run-turn-tool-and-user-correction-semantics.md)
并不要求当前代码立即实现完整交互。Stage 1 只回补数据协议：

1. `user.input.requested` RuntimeEvent；
2. `user.input.received` RuntimeEvent；
3. `RunSnapshot.pendingUserQuestion`；
4. requested → `waiting_user`、received → `running` 的纯函数投影和测试；
5. 磁盘 Schema 对新增事件的完整校验。

以下内容不属于当前阶段，缺失不能算本轮代码缺陷：

- 每 Run 单消费者命令队列：Stage 2 `RunController`；
- `submitUserInput` 和安全 Turn 边界：Stage 2；
- 真实 Provider 的提问/回答：Stage 4；
- CLI 过程纠正体验：Stage 6；
- 后台 Job 队列：V1 之后出现真实后台工具时再设计。

### 10.7 Stage 1 最新施工顺序

```text
绑定 Writer 与单一 RunId
        ↓
保证 Asset write-once
        ↓
收敛 RuntimeEvent 磁盘 Schema
        ↓
加入 user.input requested/received 与 Snapshot 投影
        ↓
修正 approval denied 语义
        ↓
补一条 Event + Asset + Snapshot 集成测试
        ↓
重新执行 typecheck/test 和 Stage 1 退出审查
```

本轮仍不实现 RunController、命令队列、Provider、正式 CUA Adapter、Planning 或后台
Job。

## 11. 更新意见实施记录（2026-08-28）

已按本节新增意见完成以下实现：

1. `JsonlRunEventWriter` 在构造时绑定唯一 `RunId`，append 其他 Run 的事件会立即
   拒绝，不会污染轨迹文件；
2. `FileAssetStore` 使用临时文件完整写入后，以同目录不可覆盖的原子发布方式落盘。
   目标路径已存在时明确失败，旧资产内容保持不变；
3. 磁盘事件校验收敛到导出的 `runtimeEventSchema`（Zod discriminated union），覆盖
   事件类型、公共字段、Observation、Action、Receipt、ModelTurn 和用户输入事件，
   不再维护独立的事件类型集合与解析 switch；
4. Protocol 增加 `user.input.requested` 与 `user.input.received`；Reducer 增加
   `pendingUserQuestion`，requested 进入 `waiting_user`，received 清除问题并回到
   `running`。没有待回答问题时收到的输入仍可作为过程纠正，不会结束 Run；
5. 审批拒绝只清除 `pendingApproval` 并恢复 `running`，不会自动把整个 Run 标记为
   `cancelled`。真正结束 Run 仍需显式 `run.finished` 或后续控制逻辑。

本轮新增和更新测试后，验证结果为：

```text
pnpm run typecheck  通过
pnpm test           通过（1 个测试文件，16 项）
```

因此，本节列出的实现缺口已处理。Stage 1 剩余工作是把 Event、Asset 和 Snapshot
串成一条集成测试；完成后再决定是否进入 Stage 2 `RunController`，不在本轮提前实现
命令队列或真实 Provider。

# G0 评测集预检进度与暂停记录

日期：2026-09-15
文档角色：结果 / 交接
状态：当前执行（主集动态预检已完成，尚未冻结）
当前入口：[Stage 6 收敛与下一阶段起始状态](./stage-6-convergence-and-start-state-2026-09-15.md)
基线：Harness 仓库工作树（提交 `db06ddb`）；OSWorld `fc31a9049664292fcb35d6e501ee1dc839f2cf6d`；VM 快照 `osworld_initial_1920x1080_clean_r4_20260906`
范围：候选任务的静态核查、部分无模型动态 reset/observe/wait/evaluate/cleanup；不包含模型效果评测、模块开发或正式对照实验。

## 1. 当前结论

G0 尚未完成，不能把候选 JSON 标记为冻结，也不能开始正式模型实验。当前修订 3 manifest 共 51 条：Development 20/20、Validation 20/20 已完成动态预检（原 V19 被 R10 替代），备用 11 条按用户要求暂不预检。静态候选结构 51/51 通过。

原 V19（GRF 年报）在 reset 阶段需要从 Hugging Face 获取 `GRF-p5y.bak.xlsx`，发生 TLS EOF；这属于外部输入缓存依赖，不是 Harness/evaluator 失败。按用户授权选择同层信息型 Calc 备用 R10 替代，R10 已通过动态预检。原 V19 失败证据保留，不再进入主 Validation。

## 2. 已实际执行的检查

### 静态候选检查

命令：

```powershell
python scripts/stage5-osworld/preflight-candidates.py `
  --osworld-root "<OSWORLD_ROOT>" `
  --candidate-doc "docs/harness-development-validation-candidates-2026-09-10.json" `
  --output "runs/g0-static-preflight/summary.json"
```

结果：当前 manifest 的 51/51 任务 JSON 可定位；evaluator 函数、getter、`proxy=false`、`possibility_of_env_change=low`、snapshot 字段和 config 均通过静态检查。静态脚本已修正为 JSON manifest 只读取任务对象的 `taskId`，不会把 `replacementOf` 等审计字段误当任务。该结果只说明协议和源文件可解析，不证明 VM、应用或评分正例有效。

### 动态无模型预检

使用 `preflight-batch.mjs`，每题执行：

`reset → open → observe → wait(100ms) → observe → close → evaluate → reset → observe → close`

证据目录：

- `runs/g0-dynamic-preflight-20260910/results/`：D01–D20、V01–V05；25 个唯一任务中 24 个首次通过，D09 首次 reset 超时。
- `runs/g0-dynamic-preflight-20260910/d09-retry-results/`：D09 的一次受控重试，完整流程通过，score 为 0（未执行任务，属于预期负态）。
- `runs/g0-dynamic-preflight-20260915/validation-remaining/`：V06–V20；15 个任务中 14 个通过，原 V19 失败于外部 Hugging Face 输入缓存。
- `runs/g0-dynamic-preflight-20260915/reserve-r10/`：R10 替代任务；完整流程通过。

初始和动作后截图均由脚本保存；本记录不提交截图。动态 score=0 不能作为模型失败或 evaluator 无效的结论，因为预检只执行了 wait，没有完成任务。

D09 原始失败：`environment.reset request timed out after 300000ms`。当时 `vmrun list` 已无运行 VM，但残留一个空闲 `vmware-vmx`；在确认没有运行 VM 后终止该孤儿进程，再执行一次重试。重试使用相同 OSWorld commit、VMX 和快照，未修改任务或 evaluator。V19 的新失败信息见下一节。

本次主集剩余预检命令（替换前执行，选取原 Validation 的 V06–V18、V20；原 V19 失败证据单独保留）：

```powershell
node scripts/stage5-osworld/preflight-batch.mjs `
  --osworld-root "<OSWORLD_ROOT>" `
  --path-to-vm "<OSWORLD_VMX>" `
  --snapshot-name "<VM_SNAPSHOT_NAME>" `
  --candidate-doc "docs/harness-development-validation-candidates-2026-09-10.json" `
  --python "<PYTHON_EXECUTABLE>" `
  --vmrun-path "<VMRUN_EXECUTABLE>" `
  --labels "V06,V07,V08,V09,V10,V11,V12,V13,V14,V15,V16,V17,V18,V20" `
  --output "runs/g0-dynamic-preflight/validation-remaining"
```

替代 R10 的受控预检命令：

```powershell
node scripts/stage5-osworld/preflight-batch.mjs `
  --osworld-root "<OSWORLD_ROOT>" `
  --path-to-vm "<OSWORLD_VMX>" `
  --snapshot-name "<VM_SNAPSHOT_NAME>" `
  --candidate-doc "docs/harness-development-validation-candidates-2026-09-10.json" `
  --python "<PYTHON_EXECUTABLE>" `
  --vmrun-path "<VMRUN_EXECUTABLE>" `
  --include-reserve `
  --labels "R10" `
  --output "runs/g0-dynamic-preflight/reserve-r10"
```

## 3. 候选平衡与历史暴露

当前 manifest 仍为 `status=proposed_not_frozen`、主集 40 条 `preflightStatus=pass`、备用 11 条 `preflightStatus=pending`、`budget=null`，尚未冻结。修订 3 保持 20 Development / 20 Validation；V19 位置由 R10 替代并记录 `replacementOf` 与原因，主候选 family 没有因模型结果做选择。

按 OSWorld 源文件中的 `snapshot`（应用/任务快照标签，不是 VMware 快照）统计：Development 为 Calc 9、Writer 5、Impress 4、Thunderbird 2；Validation 为 Calc 11、Writer 5、OS 2、multiapps 1、Impress 1。该分布不是完全同构，冻结前要结合人工参考步骤、信息对象数量、应用切换和 evaluator 类型确认难度是否失衡，必要时只能按同层备用替换，不能按模型结果挑题。

对所有保留的历史 `runs/**/runner.json` 执行记录完成候选 ID 扫描后，没有发现当前候选曾被模型运行；静态任务目录不视为历史模型使用。正式冻结前仍需保留该检查结果和任何新增历史证据。

## 4. 尚未通过或尚未完成

- D09 的环境超时作为 transient infrastructure incident 保留；复核已通过。
- 原 V19 因外部输入缓存 TLS 失败被替换为 R10；R10 的动态证据已通过，不能把原 V19 标成通过。
- 主集 20 Development + 20 Validation 均已有动态负态预检通过；未做任务动作，因此所有 score=0 仍只是负态，不是模型成功率。
- 尚未做已知满足态正控制或部分满足态控制；冻结前至少应按 evaluator 类型完成受控正/负校准，或明确记录无法安全构造正例的原因。
- R01–R09、R11–R12 按用户要求尚未动态预检，继续保持备用 pending。
- 预算尚未回填。预算应在预检得到人工参考 primitive 区间、信息量和应用切换范围后统一设定，不能因单个未来模型超时临时放宽。
- 预检没有启动模型、没有调用 Provider、没有改变 Runtime/Provider/Computer/Context/Planning/Memory 代码。

## 5. 恢复后的下一步

1. 按当前主集继续做 evaluator 正/负/部分状态校准，所有控制均不进入模型输入；原 V19 的外部依赖问题单独记录，不重新下载碰运气。
2. 根据 20+20 的人工参考 primitive 区间、信息量和应用切换统一回填预算；不能因单个未来模型超时临时放宽。
3. 回填每题 `preflightStatus`、证据路径、替换关系和预算；只有 20+20 都有可复现环境与有效评分口径时，才将 manifest 状态改为 `frozen`。
4. 备用 R01–R09、R11–R12 仅在主集预检失败或分层失衡时再处理，不因模型分数筛选。
5. 更新本文件和 `DOCS-INDEX.md` 后，再把冻结 manifest 交给实验 Agent。G0 完成不等于授权启动正式模型效果评测。

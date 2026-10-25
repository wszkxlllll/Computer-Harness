# F073：受管浏览器几何与候选预览、终态反馈修复

2026-10-11，Sol 协调和独立检查，Luna 实施。此修复只处理已独核的 F1–F4，不改变 Guard、精确窗口身份、未知副作用处理或任务完成标准。完整 T1/T2/T3 仍未通过。

- F1：窗口匹配不再从候选宽高自推 scale 或忽略 x/y；从独立稳定 CDP metrics 取得 scale（macOS 现有合同为 1），所有候选与两侧 validator 统一核四维几何。删除 DIP 巧合候选短路，保留进程归属和唯一性。
- F2：此前 raw 1MiB/JSON 2MiB 内部一致但缺较新候选预览合同。现统一 raw 2MiB/JSON 3MiB，并在精确身份/app 验证后进行候选图片专用归一化；源最大 16MiB，边长 8192、总像素 16777216，PNG chunk/维度检查后最多五次缩略。Run 原截图和动作坐标不变；previewRequired、token、新鲜度和原 SSE 清理保留，不移植参考版本无关 Windows 捕获分流。
- F3：无文字结果时展示各终态对应说明与折叠原因；空白 reply 同样处理，Workspace 避免重复同一原因。正常长文字结果及展开行为保留。
- F4：unknown_side_effect 只陈述未确认，不提前承诺已停止或正在恢复；run.finished/outcome_unknown 明确已结束，保留 failureAlreadyExplained 去重。

Sol 全文独核上述产品 diff，实际 10 文件 226 项通过（session69376）；限额期待更新后另核 relay 两文件 7 项通过，其中 routing 四项重核，新增独立 index 三项。即 11 个不同文件 229 个不同测试，未累加重复运行。F1 单独 59 项是前置复核，不再累加。diffcheck clean。Luna最终pnpm run typecheck与Web build均exit0（Vite93模块）。Root 390px headless生产Web fixture、新冻结版本CI和完整真实T2仍分别待实际记录，不继承历史成功。

最近完整 goal T2 Run run-1791721677801-6954ca90-3dc 在首 completed click 后未知弹窗边界取消，仅一请求，无正文；新空白零Provider首click未复现。不得据 Dock 行或稍后前台变化猜根因。后续私有 Node preload 只包装真实 detect 方法单次 delegate，异常有界写0600本地 journal并原样 throw；不新增 runtime.error/public event、不改变返回值/暂停/审批/输入行为。

旧 fa19cbb Preview staging 已暂存未部署，不得直接 apply；本修复冻结后重建并验证发布闭包。实体手机/真人评分、远端正常 sudo 认证分别保留外部条件，不把本次离线修复当业务验收。

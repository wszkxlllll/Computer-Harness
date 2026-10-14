# 文本格式证据独立审查

日期：2026-10-12，Asia/Shanghai。Root 只读源码与既有轨迹核对；未操作桌面、修改原生源码、调用 Provider 或改动成果文件。

## 已证事实

- A06 `run-1791735376974-18f3898f-d44` 的 seq7 模型 `type` 参数为 87 字符 / 195 UTF-8 字节，没有末尾 LF；seq10 action 参数相同。实际保存文件也是 195 字节，恰为冻结卡 `expectedText` 去掉最后一个 LF，SHA256 `914a2131d82950ad515e30d8d65b9c8155bffd0c3ad218a75e99da52a69b22f2`。这轮首先是模型参数遗漏，不能归责驱动吞掉换行。
- 旧 Run `run-1791726173541-4317c68e-58f` 的 seq26、30 模型 `type` 参数均为 88 字符 / 196 字节，末尾含 LF。Sol 对保留文稿 17360 的正常只读 SDK 结果中，structured `value` 却为 195 字节、末 LF 0。这条差异不能单独证明文稿文本已被改变。

## 源码原因

当前第五候选构建源码基于 d114f35，位于本机原生 checkout 的 `libs/cua-driver/rust/crates/platform-macos/src/`：

1. `ax/tree.rs` 先通过 `copy_stringish_attr(element, "AXValue")` 读取 CFString，保存 `copied_value.string_value`。
2. 同文件 `control_state.value_state` 构造链明确执行 `.map(|v| v.trim().to_owned())`，移除前后空白。
3. `tools/get_window_state.rs` 构造 structured `elements[].value` 时，优先使用 `node.value_state`，再回退 `node.value`。因此正常 SDK 的 structured `value` 已可能被原生层 trim。
4. TypeScript `packages/computer-cua/src/cua-driver-computer.ts` 的 `boundedGroundingLabel` 又将控制字符替换为空格、折叠空白并 trim。模型当前收到的文本标签无法据此检查末尾 LF。

当前 structured `value` 不是可用于原始格式核验的 CFString。直接从它统计末 LF 会持续给出零，不能称为解决了格式证据缺口。

## 最小修复边界

若实施格式元数据，须在原生 trim 之前从成功读取的 CFString 统计，并经正常 SDK / Computer grounding 传递。只输出有界计数、来源和完整性，不额外暴露正文，不改变已有标签隐私规则，不偷偷修改 `type` 参数或追加 LF。

完整性只能说明本次原始 AX 字符串读取和计数是否完整；不得据此宣称磁盘编码或文件字节完全相同。缺值、非 CFString、截断或读取失败要明确表示未知。应分别验证 trim 前的 LF、CR、空白字符串以及缺值边界；实际候选签收与文件保存仍另列。

本文不推断旧文稿目前的磁盘内容，也不把新增元数据或原生重建冒称已完成。已将原因与修复边界交 Sol / Luna，避免用已归一化值生成无效的格式证明。

## 第六候选实机签收

后续已实施第六补丁 `d114f35-macos-ax-text-format.patch`，SHA256 `5db869d3c5b9180832cac08bce2c584a3426ceb8d5501a5e23fc2300085e73f5`。Sol 六补丁干净重放 receipt 显示 d114 原始基底、10 个涉及源文件与构建源码全部一致。Root 只读核对该 receipt，未重跑原生构建。

Root 实际计算当前应用二进制 SHA256 为 `ca0afcdf6626533b8fcd950eb894f41b1cf44c52c702a7f207425d23a6b43392`；实际 ps 核对 PID62961、UID501、2026-10-12 01:01:12 启动，与 `sol-sixth-candidate-live.json` 一致。权限与签名检查由 Sol 正常执行，独立 bundle 身份仍按 health 的 degraded 表达。

在 `sol-sixth-format-live-338fb797-4cef-4f62-8ed9-918557658adc.json` 中，Sol 使用自有空白窗，经生产 Computer 正常输入短中文、emoji 和换行，0 Provider。Root 读取该诊断文本后独立计算得到 UTF-8 37 字节、14 码点、3 个 LF、末尾 2 个 LF、CR 0，与生产 `textAreas[].textFormat` 完全一致；空白值各计数为 0，type 回执 completed，`axValueMatches` 与 `formatMatches` 为 true，errors 为空。

此前 probe 的错误 basedOn 在原生输入前被拒绝，原失败 receipt 保留。诊断文稿已由 Sol 正常不保存关闭，旧业务文件未改变。这项结果签收格式证据链，不能计作 T2 文件保存、关闭、重开成功。

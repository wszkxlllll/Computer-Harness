# 嵌套 sheet 动画几何一次重采（2026-10-11）

真实完整T2 `run-1791726173541-4317c68e-58f` 已完成正文输入和Save自动接管，CMD+Shift+G后进入安全暂停，完整保存/关闭/重开未通过。随后唯一零Provider定向复现 `421a8a21-caff-4b1c-8605-b6505bc99fae` 捕获了同一GoTo CGID17398的WindowServer库存y235/236与紧接着AX关系证明y259；身份、前台、直接AXSheet→Save17394→root17389父链及其余字段全部有效。它证明动画期几何差异，不能归成缺失父链或模型忽略切窗。

本修仅将根sheet已有的有界只读重采策略应用到嵌套sheet：仅geometry_unstable状态等待80ms一次，然后重新读取库存、原精确父窗及独立AX关系快照；原唯一candidate PID/CGID、父窗bounds、root edge/generation、active/executable leaf及完整证明仍须全部匹配，fresh proof返回后再次校验当前栈才允许push。任何读取失败、身份变化、多候选、二次不稳、none/unknown或取消均不授权；不重放已完成快捷键，不增加几何容差，也不要求Mac全局库存伪装complete。

产品改动仅adapter与相关合同测试，原生可执行文件、签名、TCC及Guard保持。作者相关336项与build通过，随后新增等待Abort与动作计数回归，7案通过；Sol独立重新执行三个相关文件共337项全部通过。Sol互斥接管零Provider检查 `8c6e5819-fc4a-493d-baeb-477bb84ad003`：新root17403→Save17408→GoTo17412自动push，实际首次库存y261/AX y288后，仅只读重采得到同ID库存与新AX证明均y288并接管；两个ESC逐层自动pop，Save与root均恢复新generation3，无type，最终正常关闭SDK会话。Sol实际视检GoTo精确920×690 PNG，只含该面板。原诊断有CMD+S与CMD+Shift+G两次快捷键派发，0type/0Provider，不算完整业务成功。原始轨迹/关系/图片仅留ignored私有证据目录。

# PR30拆分与队友接续说明

2026-10-15。按负责人要求，DeepSeek接入先单独合入，网页相关改动继续整改。不整包合并PR30、不关闭原PR、不改写队友历史、不替换Preview。

## 本次范围

基于main `a2757d64a48245510a31905068569ea7e65f04bb`，提取：

- `0be23ca797950ad980bdd73a730248a0c6c6e535`：Provider、CLI/Host模型注册、配置与诊断，含GLM共用Chat Completions抽取。保留原作者及原始`f477f0f`来源，不带无关DOM业务报告。
- `6251dcb6246b2641dbb035e61bf77513e089db00`：DeepSeek有限错误恢复、临时网络错误分类与main凭据预检回归，完整保留Host消费者测试修复。

无自动Provider fallback，无GUI副作用重放。GLM/Qwen原行为由回归核对。本轮不读密钥、不调用API、不占桌面，不将原PR实验当作本拆分树的新实机验证。

## 未纳入，仍由原PR继续

| 提交/部分 | 本次决定 |
| --- | --- |
| `da6ea55` / `246fbf3` | registered child DOM点击及上下文留在PR30 |
| `7021d6b` | raw click供给与Context Batch文案本次不混入Provider接入 |
| `dd922f67dbddbd4f4e218b80887b68930e621e58` | 网页来源绑定、Context、Monitor、Runtime及协议/Trajectory联动全部排除 |
| 后续业务实验报告 | 原PR完整保留，不当作本次效果证明 |

未纳入不等于全部无效，只表示尚未授权整包带入。新main的网页/窗口能力保持原main基线；本地评测树与Preview不会自动更新，开始评测前必须重新冻结实际版本。

## 队友如何接着做

1. 保留PR30及原提交、证据，不强推重写，不关闭重提。
2. DeepSeek-only合入后，在自己的PR30分支拉取并合并最新main；先自行保存未提交工作。冲突不能通过用旧文件整包覆盖main解决，尤其保留DeepSeek恢复与Host凭据预检。
3. 检查相对新main的剩余diff，后续只提交和解释尚未合入的DOM/网页来源、Context/Monitor等改动，不重复搬旧Provider版本。
4. 继续整改时保留失败和部分完成记录，说明字段生产者、消费者和失效规则；不为单站点硬编码URL或答案，不为提高成绩放宽Guard。
5. 重新跑相关测试及CI，真实GUI/API另外授权。新增提交需要按新main差异复审，不拿旧CI或旧GO代替。

## 验收边界

实施Luna max，审查Sol medium，协调者核对最终diff、署名、CI和合入。原PR30最后核对head为`7464d50e75b203090cd1b83a70cbfec8c831b0be`；队友后续提交不被本次提取覆盖。

本说明创建时纯分支尚在离线验收，未标记main已更新。最终CI及合入结果以本独立PR的检查与时间线为准；没有因此部署Preview或启动业务任务。

已完成本地提取提交：`455a219c`（接入，保留Yao GX作者）与`ee0b752`（恢复/预检，wszkxlllll作者）。全仓类型构建通过，定向10文件326项测试通过；首次新树因未生成dist而无法收集测试，构建后重跑已通过，不属于断言失败。Sol核对源码与原已修复版本一致，main原Host消费者测试保留，上述排除目录相对main无改动。完整回归与CI由后续交付记录确认。

# 受管 Edge 窗口几何修复与 Windows 验收

日期：2026-10-08。基线：PR #22 head `079c1c418405236a3b1be6176f83ef9ab7a74370`。

## 结论与提交范围

受管 Edge 的窗口身份绑定阻塞已在 Windows 实机修复，浏览器 → 原生编辑器 → 保存／重开 → 返回原浏览器的真实 GLM 执行链路通过。**生成的健康资料仍有来源事实偏差，业务内容未全通过验收**；不得把 Runtime `succeeded` 写成医疗资料正确或产品全部验收通过。

本提交只含受管浏览器几何合同、回归测试、开发说明及本脱敏报告。不含 CUA 二进制、模型凭据、个人目录、截图、浏览器 profile、原始轨迹或生成的健康资料。

## 问题与修复

原实现根据候选窗口的宽高比例推断共同缩放，未约束实际尺寸和位置。实测同一 owned PID 下，344×206 的小窗口与 1036×653 的主窗口都被判为兼容 CDP 的 1050×660 窗口，导致 `multiple_candidates`。既有唯一性门禁正确拒绝，没有选错 HWND 后继续输入。

修改位置：

- `packages/computer-cua/src/managed-browser-host.ts`：从选定 CDP 页面的活动证据读取 `devicePixelRatio`，传入绑定提示和 ownership 验证；几何比较同时约束 x、y、width、height，最多允许 16 CSS 像素的帧差，不再从候选比例推断任意 DPI。
- `packages/computer-cua/src/managed-browser-resolver.ts`：候选过滤、诊断计数及验证器使用同一规则；即使存在一个完全相等候选，也不跳过其他兼容候选的模糊性检查。
- `packages/computer-cua/src/managed-browser-resolver.test.ts`：增加比例小窗排除、错位／未证实缩放拒绝、多兼容窗口拒绝和异常比例拒绝；已有 1.5 缩放用例显式提供独立缩放证据。

缺少缩放时仅允许 1:1 有界帧差。保留 PID 所属关系、CDP 窗口、精确 HWND 和唯一性合同；不选择最大、最接近或标题相似窗口，不退回整屏冒充受管 DOM。

## 本次实际验证

环境：WinBoat Windows 10 build 19045，已登录用户 Session 1；Node 24.21.0、pnpm 11.19.0、Edge 154.0.4258.62；单屏 1280×720。CUA SDK 0.22.2，使用 PR22 文档指定的独立 Windows 候选：`wszkxlllll/cua@7852ab1983b60c0ce581b8736c9da13eaf04640a`，二进制 SHA256 `400ab8670980ecd461f304fdc7e7a9d8a27f53585ea629b81ee1b7c260bc3095`。这不是升级官方 SDK，也没有替换默认 driver。

| 验证 | 实际结果 |
| --- | --- |
| Windows `pnpm run typecheck` | 退出 0 |
| Windows 全仓 Vitest，最多 2 workers | 1820 通过，0 失败 |
| 原两个 owned 候选的实机绑定 | 兼容候选由 2 收敛为 1，精确主窗口 open／observe 成功 |
| NHS 实际目标页面 | DOM 控件目录与 `dom` Surface 成功，清理通过 |
| 完整 GLM 跨应用第二轮 | 同一 ComputerSession 两次切换，保存弹窗 child_push／child_pop，重开文件后返回原 DOM |
| 最终清理 | owner released、session cleanup passed、专用 daemon stop 退出 0、测试 Node／CUA／记事本／Edge 无残留 |

首次 Example 页面冒烟成功绑定窗口，但该帧无 DOM actionable 控件，非空 DOM 断言失败；保留此结果，随后对任务实际 NHS 页面验证 DOM，不把首轮断言失败改成通过。

提交用工作树从 Windows 的改后源码导出，三个源码／回归文件及 `getting-started.md` 逐文件 SHA256 一致。本次发布整理没有重新执行 Linux 原生 Harness，也没有把既有测试重新计作新测试。

## 真实 GLM 完整任务与失败保留

来源：[NHS Dehydration](https://www.nhs.uk/conditions/dehydration/)。任务要求实际读网页、写中文报告、UTF-8 保存新文件、GUI 重开，并返回同一受管浏览器。使用生产 `GlmAdapter`／GLM-5.3-Flash low，layered Guard、明确窗口 allowlist、hybrid grounding 和已验证候选的 `foreground-caret-v1`；没有脚本指定动作、人工代写、人工代保存或人工代切窗口。

第一轮 `run-1791409262649-f5fe1db8-86d`：14 请求、13 GUI 尝试，实际读取网页并成功切到原生编辑器；模型选择显式 `elementRef` 多行 UIA 路线，回执 `partial / MULTILINE_TYPE_UNCONFIRMED`，外部读回确认换行损坏，Runtime `outcome_unknown`，未保存文件。草稿还加入来源未列出的内容。原轨迹和文本保留，未知输入没有重发。

第二轮使用新空白编辑器、新 Run／输出目录，明确采用已启用的普通前台多行输入，不传 `elementRef`，仍由真实 GLM 决定动作与正文。结果：

| 项目 | 第二轮实际值 |
| --- | --- |
| Run | `run-1791409688300-a0a52941-612` |
| 真实模型请求／响应 | 24／24 |
| GUI 尝试 | 20：19 completed、0 refused、1 partial unknown |
| 耗时 | 328.485 秒 |
| Runtime outcome | `succeeded` |
| ComputerSession | 全程同一 session |
| 文件 | UTF-8，1912 bytes |
| 文件 SHA256 | `b67ac7fc9d5e201b7aaf92db2e48dcfa8b14eec6c0643c1aca47e94c0def627a` |
| 独立全文核验 | 文件、模型 type 正文及重开窗口文本一致，仅归一 CRLF／LF |

唯一 unknown 为瞬态关闭后父窗口已经重新捕获的 `CUA_TRANSIENT_ACTION_OUTCOME_UNKNOWN`；保留回执，通过新观察继续，没有重放。最终截图确认仍为同一 NHS 来源页，DOM 恢复。两轮共 38 次真实模型请求，金额未知；不填零、不猜缓存收益。

## 内容问题与未覆盖边界

第二轮技术交付通过，但健康报告未满足严格来源忠实性：

- 将原文“运动后大量出汗”改为“运动时间过长”。
- GP／111 条件加入“口渴持续存在”等原页未列概括。
- 将 cold skin 扩写成“冰冷潮湿”。
- 称 111／999 免费，但当前来源页面未建立价格事实。

这些偏差未被手工修改或删除。定义、常见症状和部分补水／急症资料有页面支持，不足以放行整份医疗资料。此 PR 不修复模型事实忠实性或显式后台 UIA 多行路线。

未验证任意网页 zoom、负原点／混合 DPI 多显示器、所有应用、任意选区替换、手机语音或真实高风险审批。窗口几何不符时继续 fail-closed，不扩大容差掩盖不确定性。原始截图、provider exchange、trajectory 和本机文件保留在执行机器的私有证据目录，不随 PR 上传。

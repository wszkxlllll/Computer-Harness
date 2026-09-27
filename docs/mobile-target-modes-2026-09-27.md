# 手机自动选窗与受管浏览器接入

日期：2026-09-27。角色：实施与验证记录。状态：已接入、已部署；完整业务任务效果待用户试用。
基线：PR #15 后；当前分支 `codex/mobile-target-modes-20260927`。
入口：[文档索引](./DOCS-INDEX.md)。关联任务：完整待办 B03、L02、L05、U01。

## 问题与确认

用户确认新版审批可用，但手机必须手动选窗，之前的自动绑定和浏览器入口不可用。源码确认：Web 的 GoalComposer/HomeScreen 强制存在 targetToken；Host POST /api/runs 只接受该令牌；远程适配始终绑定一个原生窗口；Host 尚未提供浏览器会话二态。

自动窗口匹配存在于 TUI，受管浏览器及持久 profile 在 Computer/组合根已有实现。本次补手机入口与共享接线，不修改 Agent 主循环。普通浏览器窗口原先可作为视觉目标，缺的是自动绑定和受管浏览器/DOM模式，不能泛称浏览器所有操作均不支持。

## 用户确认的目标

- 默认自动选择已打开窗口；唯一明确匹配时开始，不明确时保留 Goal 并提示手动选择。
- 保留显式手动选窗；短时设备令牌、开始前再次核验与单次消费继续有效。
- 独立提供受管浏览器入口；手机端可选择“临时浏览”或“使用已登录网站”。临时浏览使用一次性 profile，不读取登录状态；已登录网站使用 Host 管理的固定 profile。网址可留空：临时模式打开临时空白页，已登录模式恢复电脑端登记的网站；填写网址时，已登录模式沿用电脑端已准备的登录状态。
- 不自动扩大为全桌面控制；未打开应用不宣称可以自动启动。自动匹配只证明应用名/标题匹配，不证明理解任意含糊需求。

## 合同与分工

目标选择为 auto / window(token) / browser(sessionMode, url?)。旧客户端缺少 `sessionMode` 时安全映射为 `temporary`，旧 targetToken 仍兼容，新客户端发送 target，禁止同时发送两者。临时模式省略网址时使用精确 `about:blank`；已登录模式省略网址时从 Host-owned profile 的登记清单选择第一个站点，无登记站点时安全回退 `about:blank`。其他非HTTP(S)协议仍拒绝。幂等键比较包含模式、会话模式和规范化目标输入。

窗口匹配器抽到 app-runtime，由 TUI 重导出复用；窗口元数据默认在本地匹配，不新增静默外发至 Jev。浏览器 profile 路径、标签由 Host 设置，不接受手机传任意文件路径或CDP地址；复用既有 profile 根目录约定。登录状态取决于所选 profile，不把个人浏览器已有登录当作受管浏览器登录。

后端实施范围为 app-runtime/Host及共享匹配器；前端范围为 apps/web。Runtime、审批策略和主执行循环保持既有合同。

## 验证门槛

1. 自动唯一匹配、歧义、无匹配、窗口失效、已有活动Run、同commandId重试/冲突。
2. 手动令牌过期、跨设备访问与原行为兼容。
3. 浏览器 URL 校验、Host-owned profile 与 Hybrid/foreground 实际配置投影；客户端不能指定profile路径。
4. 手机目标模式与浏览器临时/已登录二态提交体正确、切换模式保留Goal、自动失败进入人工选择；没有候选窗口也可选择浏览器入口。
5. 类型检查与相关单测；上线前确认本地没有活动Run，再更新Host和Web。真实任务验证与模拟测试分开记录，不把适配器Mock通过写成浏览器实机完成。

## 结果

三种目标模式代码接入完成，随后根据用户反馈追加“网址可选”和浏览器会话二态。共享窗口匹配器/浏览器配置根目录位于 app-runtime，CLI 保留重导出；Host/Relay 接受两种浏览器会话模式，同时兼容旧 targetToken。浏览器 saved profile 的标签和路径始终由 Host 配置，手机不能传入。浏览器默认 profile 为 `mobile`；已有本机配置的标签由启动器传给 Host，并在启动器退出时恢复环境变量。用户本机原有 `travel` 配置无需改名，其他用户无需创建同名配置。

集中审阅发现并修正自动选窗503重试问题：仅确定未创建Run的 WINDOW_DISCOVERY_FAILED 允许生成新commandId；保留既有4xx重试处理，网络/通用5xx未知结果继续复用原ID。没有新增静默模型选窗或自动全桌面回退。

主 Agent 独立在 Windows、Node 24.19.0 下完成类型检查、82个文件774项Vitest、19项脚本测试通过，1项Windows符号链接权限跳过；Web生产构建通过。两次中间失败分别为旧联通测试传字符串给新Web方法，以及测试错误假定ApplicationSession会写summary.json；已按实际合同修复测试，未为测试新增生产文件写入。

真实只读窗口探针发现6个窗口：以完整应用名/标题构造匹配输入时，4个唯一匹配、2个保持歧义。无鼠标/键盘输入；这不是自然语言任务成功率测量，也不是Jev准确率实验。

网址必填检查点产物为 `index-Bl_yaeJd.js` / `index-CojNu-Ku.css`，已由下面的可选网址版本替代。

### 可选网址最终验证

主 Agent 独立 Node 24.19.0 类型检查通过，82文件778项Vitest通过；19项脚本通过、1项Windows符号链接权限跳过。Sol 对可选网址边界追加只读审阅，无剩余发现。精确 about:blank 被允许，其他 about 变体和 file/data/javascript 在远程入口仍拒绝；已有内部静态data测试能力未扩大到手机接口。

Luna 的 headless Edge 模拟API检查覆盖390×844/320×568大字三种模式，未见横向溢出；提交可滚动到导航栏上方，草稿保持，浏览器模式不依赖窗口列表请求。追加320×568可选网址检查确认空字段可提交。截图为合成数据，本地保存、不纳入Git。

真实只读浏览器探针使用独立临时profile，通过远程适配器的无网址 browser 模式创建Run；实际启动受管浏览器，规范化为 about:blank，Hybrid观察1次，空白页DOM候选0（预期），提供给finish-only假Provider的输入含1张图片及Grounding。Run成功，约6.4秒，Provider关闭、桌面lease释放；无真实模型API调用和点击/输入。这验证启动与观察，不证明Agent已能自主完成网页导航或复杂任务。

探针未配置RemoteAssetReader，因此探针直接调用getAsset不可用；只读检查实际资产文件确认PNG签名有效、71559字节。浏览器/profile锁与进程均已退出。精确临时目录的递归删除被自动工具策略拒绝，保留在忽略的 `.tools/managed-browser-smoke-2e9954c74b4640f3a9a56354bc953aef`，探针脚本已移除；这属于未完成的临时文件清理，不是会话资源泄漏，不提交该目录。

### 部署与使用

公网当前 release 为 `/opt/computer-harness/releases/2026-09-27-target-modes`，由既有 `2026-09-26-02` 复制后覆盖本轮 Web 及 Relay 路由产物/对应源文件；不是完整仓库已提交版本。原release保留，可将current切回后重启Relay回退。电脑Host运行本地新构建；本轮尚未commit/push。

最终Web产物 `index-D2ATiQPI.js` / `index-CojNu-Ku.css`。公网HTML/JS返回200、引用新产物，Relay active，服务器路由验证无网址browser请求可接受。本地Host重启后，主Agent实际走公网配对→本机确认→公网auto请求→本机无匹配响应409 WINDOW_SELECTION_REQUIRED；测试设备随后撤销。无付费调用及GUI输入。第一版探测脚本误把公网请求ID当作本机配对ID，修正为读取本机新增请求后通过；未改动产品配对语义。

电脑打开 `http://localhost:4317/connect` 重新生成二维码并确认手机；手机刷新后默认自动选择，也可切换“手动选择窗口”或“打开网站”。起始网址可不填。新用户默认mobile配置；本机既有travel仅来自本地配置。网站登录仍受网站有效期影响。

### 2026-09-27 实机缺陷修复

用户实测空白浏览器任务直接结束。对应 Run `run-1790503162718-96ae0732-7fd` 在 `computer.open` 前失败：本机 `travel` profile 留有前一天的 `.computer-harness-profile.lock` 与 `DevToolsActivePort`，且没有进程使用该精确 profile。新增 `scripts/mobile.ps1 recover-browser-profile`：要求Host停止，使用本机配置的Harness-owned profile，核对精确 `--user-data-dir` 进程参数与路径安全，只把两个运行标记移入 profile 内的 recovery 归档。实际执行成功，归档ID `recovery-1790505746956-08d2b1cd`，随后检查profile为ready、无运行标记；登录数据未读取或删除。手机端把此类失败映射为具体恢复提示。

微信自动匹配失败由两层原因造成：原窗口发现固定 `on_screen_only:true`，最小化的 `Weixin.exe / 微信` 不在6个可见窗口中；完整清单15项能找到它。其次旧中文边界没有识别“微信上”的位置助词，并曾过滤两字标题。现改为：初始自动模式读取完整顶层窗口清单，唯一匹配后若不可见，则按精确PID/HWND激活，再由可见清单和既有createRun检查复核同一身份。手动选择和Run内handoff继续只看可见窗口；不自动选择歧义窗口。不同启动请求串行解析，避免争抢焦点。

Windows/CUA 0.22.2实测：微信最小化时完整清单16项、可见清单6项，“在微信上给测试联系人发消息”唯一匹配；生产发现器激活后，同一PID/HWND在可见清单出现，未发送鼠标/键盘输入。此前直接CUA实验也返回 `restored:true` 和 `landed_on_target:true`。这证明初始自动绑定可恢复本机微信窗口，不证明消息发送任务已完成。

较早的最小化窗口检查点为Node 24下84个文件、798项Vitest通过；其后浏览器会话与并发修复的最终全量结果见下文。macOS恢复默认已按 fail-closed 处理：`ps` 输出无法可靠保留含空格未加引号的真实 `argv` 边界，因此默认进程库存返回 `unknown`，检查/恢复拒绝；只有注入边界保持的进程库存后才能测试状态机。本轮不能宣称三平台 profile 恢复均已验证。

本机Host已用最终构建重启；公网Web产物更新为 `index-KIxIw0S7.js`，HTML/JS返回200。Relay协议无需为最小化窗口修复再变更。代码仍未commit/push。

### 持久浏览器多标签启动修复

用户随后实测“打开网站”会恢复12306后立即关闭。轨迹 `run-1790507647817-60ff1cba-107` 证明Run尚未发出模型请求，失败发生在 `computer.open`：`travel` profile 会同时恢复高德、携程和12306等已登记标签，而旧启动门禁要求所有CDP页面只能对应一个可见浏览器窗口；失败后的资源清理关闭了受管浏览器，因此表象是“打开后秒退”，不是模型主动结束。

第一轮修复允许启动时用唯一 `document.hasFocus()` 页面区分不同的恢复窗口，但真实复测 `run-1790508401353-e6cf34a1-bee` 仍失败。新增的脱敏诊断只记录 `browserWindowId`、`visibilityState` 和 `hasFocus`，不记录URL、标题、正文、Cookie或登录数据。实际组合为同一窗口多个页面全部暂时报 `hidden`，其中焦点状态也不稳定。最终改为确定性启动：当前 Run URL 不再作为命令行 tab，Host 通过 CDP `Target.createTarget` 获得确切 `targetId`，再 `Target.activateTarget`；该 target 即使短暂 hidden 也只能按这个精确身份绑定，不能由旧同源 tab或任意 hidden页接管。prepared tabs 保留；无 prepared tabs 时使用随机 Host-owned bootstrap，只有能精确识别时才关闭。绑定完成后的 collect/selectOption 仍要求目标窗口内恰好一个 visible 页面，避免DOM局部坐标错映射。

最终真实只读Run `run-1790508907434-d9a07baa-1ec` 使用同一持久 `travel` profile、12306入口和Hybrid Grounding成功：受管浏览器恢复5个标签，ComputerSession建立，Accessibility/DOM链路可用，模型观察一次后结束；`runtimeErrors=0`、`modelRequests=1`、GUI动作0、审批0。测试没有点击、输入或提交内容，登录profile保留。定向测试为managed-browser-host 27/27、managed-browser-resolver 6/6，computer-cua构建通过。

二态合同的离线验证已补齐：legacy browser payload 缺省安全映射为 temporary；temporary 覆盖 ephemeral profile，saved 覆盖 Host-owned persistent profile；saved 无网址通过 Host 读取 `<profileRoot>/<profileLabel>/managed-browser-startup.json` 选择第一个站点，无登记站点回退 `about:blank`。saved 的省略、空字符串和纯空白网址语义统一为“恢复登记站点”，显式 `about:blank` 仍表示打开空白页。手机 UI 默认临时浏览，并提供“使用已登录网站”二选项；手机不会看到 profile 路径或标签。

真实只读二态验收均通过。temporary Run `run-1790511700162-ede84595-88d` 使用独立 ephemeral profile，活动页为 `about:blank`，未读取或显示 `travel` 登记站点。saved Run `run-1790511756104-a8462bc4-60e` 使用 Host-owned `travel` profile，从登记清单确定性激活高德；站点登录头像可见，携程/12306标签作为后台恢复页保留。两次均仅观察后结束，未点击、输入或提交，`runtimeErrors=0`。

连续验收还发现：Runtime 已发布 `run.finished` 时，旧 Run 可能仍在执行 Computer close、报告写入和环境 lease 释放，立即启动下一项曾短暂返回 `RUN_BUSY`。现由 `ApplicationSession.waitUntilIdleAfterTerminal()` 在 Remote入口取得启动串行锁后、saved profile检查或auto/manual窗口发现之前统一等待完整清理；仍在运行的Run立即拒绝，`pending_cleanup`/`outcome_unknown`继续阻断。等待期间若session关闭，会在获取lease和创建factory前再次拒绝。相关ApplicationSession/AppRuntime测试124/124通过。

最终完整回归为84个文件、814项Vitest全部通过；脚本测试19项通过，1项因Windows环境不能创建符号链接而跳过。根类型检查通过，Sol复审关闭全部P2。

公网创建新release `/opt/computer-harness/releases/2026-09-27-browser-sessions`，从上一release复制后仅覆盖已构建Web、Relay及relay-connector产物，保留旧release用于回滚；`current`已原子切换并重启Relay。首次健康检查紧跟systemd restart过早执行而连接失败，等待4秒后确认服务active、127.0.0.1:8787监听、`/healthz`返回`{"status":"ok"}`。公网HTTPS首页和JS均返回200，当前资源为 `index-BQke8zyL.js` / `index-BsDYwWuu.css`，产物包含“临时浏览”和“使用已登录网站”入口。本机Host随后以最终构建重启。

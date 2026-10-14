# Web native recovery profile: implementation scope

2026-10-12 初始设计快照（实现与验证见下方）。T2三轮同95b CLI experiment已完整通过；这不是默认layered或正常Web完整出口通过。现有Web严格target parser只有单window/browser/desktop/auto，不能配置已验证native-only双窗恢复与Host单文件grant；hybrid/browser companion也被现factory与该grant的组合门拒绝。此为需实现的入口缺口，不能以API名称或fixture替代Web验收。

已选最小方案：Host本机启动配置显式登记单个profile，冻结两个不同的自有blank精确身份、唯一不存在的本地文件及TextEdit应用身份。Web只显示并选择opaque profileId；不接收任意PID/CGID/path/grant，也不新增admin routes、profile CRUD、TTL/epoch/token-store体系。使用现有配对、CSRF、设备+commandId幂等和环境所有权，同步oneRun消费；重复已知命令返回原结果，unknown不重新派发。

profile只经新的selector投影typed per-Run私有overrides，不能写入ApplicationSession全局base computer配置污染普通Run。默认未配置时旧行为和schema不变；有profile时普通auto/window/browser仍无recovery/grant。保native `uia-catalog-v1`、现factory/CUA精确两target/singlefile/app proof门、initial activation与每action焦点拒绝、completed/unknown不重放。不扩大到T3 hybrid，不改变Guard策略。进程startstamp若作为配置字段必须真正比对；相关域证明失败不能假装verified，也不以全局partial硬挡普通充分exact动作。

复用现有Provider配置脱敏，不创造“所有PID/path禁止出现事件或goal”的新合同：合法完整任务路径保留，原handoff事件照旧，私有grant/proof和会话凭据不能外泄。保存状态仍仅证明Host授权路径/当前clean文档身份，字节内容、LF、编码与业务完成独立核验。

验收顺序是默认/严格schema/私有投影/单次消费/幂等并发/失败unknown回归，随后真实native+正常Host完整零HTTP生命周期，最后正常Web按钮启动完整T2，使用Host既有live-interactive/layered/riskModel=same。当前没有该新入口的实测通过；另一次非interactive CLI付费轮取消，已有F085真实零HTTPlayered链保留为局部证据。正常Web控制若改变Mac前台，必须保正常暂停/恢复和新鲜目标证据，不能把客户端操作造成的焦点变化误归native，也不人工代业务。

当前单写者Luna native_identity负责产品实现；executor_recovery只准备A07私有首事件监督/正常pairing capture/只读journal与离线合同，Sol负责独检/Git/构建/服务/现场，Root只读审查。A07已正常append-only续reserve120/6/126 rev2，actual55与旧chain不变；完整新卡仅换30aa0257…txt路径、goal1133B SHA54fb4b960858d7d56db4bd4872186e01d4512e2e8873998842713c38e97a4b2c、正文196B SHA58a4原样，尚无新paid。

## 09:12 冻结与独立检查

首轮产品15文件已冻结，Host与RemoteRunApi各自严格接受仅mode/profileId的新selector；Root发现通用helper兼容switchWindows导致新模式误接收后，作者仅新模式明确拒绝true与false，旧模式兼容不变。回归证明拒绝前不发现窗口/不start/不消费，随后合法无extra请求仍成功。单次profile在async前消费，重复同设备/commandId沿原Promise返回；失败也保持消费，列表刷新不再显示已消费profile。Host选项拷贝并冻结，正常后续browser Run不会继承grant/recovery。

Sol实际独跑5个相关文件128/128通过，TypeScript tsc-b和Web production build均exit0；Root独跑schema相关6/6并逐SHA核15源码/9dist。相关证据为私有sol-native-profile-frozen-source-independent-review.json（138aaef3…），仅该时点冻结；之后Root发现native mode的两分钟发现期限到期没有刷新按钮，正进行窄Web状态/刷新入口修正，后续新pin另记。配置fixture的macOS executable URL仍固定file URL，文件路径改为宿主临时目录canonical绝对路径，避免共享Windows CI把POSIX假路径当无效配置。

私有监督Node18/18和最初Python6/6已由Sol独跑；Root发现monitor进程身份substring校验偏弱后，作者改为精确shlex唯一batch root/id/reservation/entry与Node/batchhost路径。Sol修后Python7/7通过，Root另独证wrong reservation value/root/id/entry/重复flag拒绝；首错位fixture反例（修改旗标非值）随后纠正为值，旧检查历史保留。ready先原starter，正常默认仍start→mark；未知transport不重发，只有确定STALE_SEQUENCE可一次重新GET，deadline仅退出helper不冒Run取消。

真实桌面两新blank已用正常CMDN/一次exact raise及Swift空AX值/焦点核实，primary22394/18612、recovery22394/18609。准备不是profile完成证据，仍先真实零Provider完整链再正式Web完整卡。Host正常配置不只Guard变化，还保planning=true、facts/lexical memory、same-control-input-v1 batching、recent/maxHistory32、live-interactive/layered、riskModel=same/riskMaxModelRequests1、shadow monitor。任何本地Provider fixture和真实模型业务均分列。

09:17补记：native profile的发现期限沿既有窗口列表两分钟合同保留，新增本页加载/失败/过期提示及“刷新文稿任务”按钮，复用原刷新接口；Sol独跑Home26/26和Web新build均exit0，Root独跑expiry→failure→success→新profileId start回归。最终源码/dist快照另存sol-native-profile-final-source-independent-review.json（8ea75839…）；旧138冻结仍保历史。真实Host/Relay本地pair-only预检使用正常会话接口已通过，0模型/0SDK/0Run；初两次CLI配置/双requestId误用失败均为诊断脚本错误，保留且已修，尚不当产品完整链通过。

## Relay native-recovery ingress correction (2026-10-12)

The first full A07 Host/Relay diagnostic attempt (`4909c98b-d965-405a-9824-de8e306f6caf`) paired successfully but stopped before a Run or provider call: 0 Run, 0 total fixture calls, and 0 real/remote Provider requests. Its local receipt reported HTTP 400 as generic `request_failed` because Relay errors are serialized as `{error: "invalid_request_body"}` while the diagnostic formatter expected a nested error code.

The rejected request was `POST /api/runs` with the exact Host-supported selector `{mode: "native-recovery", profileId}`. Relay's shared `isValidRunTarget` union did not include that mode, so Relay rejected the request before forwarding it to Host. Host's exact parser already accepts only `mode` and `profileId` for this selector. The shared Relay validator must accept an opaque identifier profileId and reject `switchWindows` both true and false, raw PID/window/path/grant fields, and missing or invalid profileId. Existing target modes and their switchWindows behavior stay unchanged. Verify both the routing predicate and a Relay server fake-Host round trip: the valid payload is forwarded intact, while invalid shapes return 400 without a Host bridge request. The failed diagnostic receipt remains unchanged and is not a product Run failure.

The ingress fix now adds exactly that one selector to the shared Relay schema. A profileId must pass the shared identifier validator and match the Host's 16–128 character opaque-ID bound. The valid fake-Host server case confirms the payload reaches Host unchanged; selector variants with either `switchWindows` boolean, PID, path, missing/short/non-string profileId, or extra fields return 400 without any bridge request. The focused routing/server suites passed 14/14 tests after refreshing only the relay-connector TypeScript output required by the Relay test runtime. `pnpm exec tsc -p packages/relay-connector/tsconfig.json --pretty false` exited 0. This validates schema forwarding only; the failed A07 diagnostic was not rerun and remains a pre-Run failure receipt.

## Final local lifecycle evidence (2026-10-12 09:29)

After the Relay selector correction, Sol independently ran the three routing/server suites (14/14, exit 0) and `pnpm exec tsc -b` (exit 0). The new UUID local diagnostic `1b545917-304c-4386-bc0c-11262faf04e6` used the normal local Host/Relay pairing and opaque start selector, real ApplicationSession/factory/CUA/native, and an injected offline Provider. Run `run-1791768544688-512247e1-397` naturally finished succeeded at sequence 168: 16 offline main decisions, zero risk fixture calls, zero real Provider HTTP, 13/13 completed actions, no failed action, errors/cleanup errors empty. The saved file is exactly the diagnostic's 37 UTF-8 bytes (SHA 47f07b3c04833748ba21983efe69e43b5dd2c5baa3f77938433863f722f00ab5), two LF and one trailing LF. Completed close, list/switch-only control turns without an old image, fresh recovery observation, one singleton reopen, new surface-5 generation 2, and a following ordinary Escape action all passed.

Sol and Root actually viewed the final PNG 81452f95-30d8-4bd1-b270-568ccaecc674; its two Chinese/emoji lines match. The final AX format is 37 bytes/16 code points/2 LF/trailing 1/0 CR, and the readonly native journal has 298 rows with final focused exact CGID 18657. Root's limited terminal receipt is stored beside the diagnostic receipt. This is local API/Relay plus an offline fixture, not normal Web button acceptance or the formal 196-byte business card. The first 400 receipt remains unchanged. The final private closure records all 18 product/test source files and 11 dist files in `sol-native-profile-relay-final-source-review.json`; formal paid launch still needs a new Web session/profile and fresh blanks.

## 10:08 正常 Web 首次启动前的任务文本保真修正

正常本地 Relay/Host 已从 3001a1c 新闭包启动，Chrome 原生界面正常配对、选择电脑预设文稿并粘贴完整原卡，但未点击开始、未创建正式 Run。启动前静态检查发现 GoalComposer 与 RemoteRunApi 原来均 trim goal；原 1133B 卡末尾两个 LF 会被裁掉。这是入口保真问题，不是模型输入或磁盘正文丢 LF。Host requiredString、Relay 转发、Web API 不再次 trim。

仅 native-recovery 新模式保留原始 goal，trim 仍用于非空验证，原始长度仍受 20000 字符上限约束；其它模式原 trim 行为保持。幂等比较使用精确保留文本，不把尾 LF 差异当同一个请求。Web/Host/Relay 现有边界用含前导空格、中文和末两个 LF 的任务验证逐字转发，Sol 实跑 38/38，通过 tsc-b 与 Web production build。最初进度口述 43 项为计数错误，以日志 38 项为准。

3001a1c CI 的三非 macOS job 均为同两新增 native-profile 正例受到正确 Darwin gate 拒绝（2033 pass/2 fail）；Luna 只修测试环境作用域，生产 gate 不放宽，实际非 Darwin 拒绝保留。旧 CI failure 不覆盖，修后新 HEAD/CI 另记。正式原卡仍完整 1133B/54fb4b96…、正文 196B/58a4…、output absent；A07 actual55，累计492，0新真实 Provider。服务及配对需要新构建后正常重启，旧未绑定 session/allowlist 原样私有归档并保 receipt，绝不把它们补写为正式启动。

# 购物售后与通信日程来源预检（2026-10-16）

状态：下列官方页面正文在 2026-10-16 可读取；runner接入及离线验收状态见[操作说明最新节](./history/2026-10-20-release-convergence/life-business-evaluation-2026-10-15.md#新六题方舟对照准备2026-10-16接续)，GUI预检仍须在实际运行前完成。此来源核验不证明本机浏览器可用、商品/政策今后不变、账户资格或真实业务结果；不授权登录、下单、退货、发送消息、建删日程或共享日历。

## 购物售后

### S01 · 确认 iPhone 15 适用的充电器

字段核对（官方正文行号来自来源预检）：
- 当前商品页标价：RMB 149；S01-1，全文行32-35。
- 额定功率和接口：20W，USB-C 接口；S01-1，标题行32；规格行60-63。
- 与 iPhone 15 兼容：兼容性清单包含 iPhone 15；S01-1，全文行66-84。
- 包装是否含线：线需单独购买；包装内容列 Apple 20W USB-C 电源适配器；S01-1，全文行52-58。
- [购买 20W USB-C 电源适配器 - Apple (中国大陆)](https://www.apple.com.cn/shop/product/mwvw3ch/a)（读取：2026-10-16；web open canonical URL; official HTML full text, 188 lines）。关键商品正文可读，无需登录。无跟踪参数的 canonical URL 可直接打开，关键字段与此前参数化 URL 正文一致。
- 依据/限制：价格会变化；答复应表述为读取日页面标价，不保证之后仍相同。

### S02 · 确认 Apple Store 零售店 iPhone 退货条件

字段核对（官方正文行号来自来源预检）：
- 标准时间窗口：从购买日起 14 个日历日内；S02-1，全文行32-35及77-81。
- 一般产品退货状态与材料：未损坏、按原样，并带原始零件/配件、原始发票和原始包装；Apple按原付款方式退款或调换；S02-1，全文行32-35。
- iPhone 退货所需物品：未损坏、原始包装、原始收据、附件、手册和文件；S02-1，全文行77-80。
- 运营商协议影响：退货不自动取消移动网络协议；与运营商服务协议一起购买的协议 iPhone 不适用上述 14 日政策，适用法律或运营商条款另有允许的除外；S02-1，全文行80-81。
- 原店退货：大陆 Apple Store 零售店购买的产品仅可在原店退货或调换；S02-1，全文行41。
- [Apple Store 零售店购买政策](https://www.apple.com/legal/sales-support/sales-policies/retail_cn.html)（读取：2026-10-16；web open official full text, 85 lines）。正文可读，无需登录。此卡限定实体零售店购买渠道。
- 依据/限制：最终退货资格以产品检查和适用条款为准；任务询问公开政策，不操作真实订单。
- 预检历史：此前预检的 Apple 中国在线退货帮助页 /cn/shop/help/returns_refund 直接 open 返回 HTTP 503，记录保留于 preflight.txt；本卡改为已成功打开的官方实体零售店政策全文，不以该失败页面作为证据。

### S03 · 比较 iPhone 与 Mac 的三包期限和 Apple 有限保修

字段核对（官方正文行号来自来源预检）：
- 法定三包期限：iPhone 1 年；Mac 整机 1 年、主要部件 2 年；注明浙江销售和维修的 Mac 台式机享有整机 3 年地方规则；S03-1，全文行34-36及58-59。
- 三包第一年退换修时间段：摘要列出 0-7 天退货、8-15 天换货、16 天至 1 年维修；回答必须说明只有符合商品性能故障等法定适用条件时才适用；S03-1，全文行30、60-62。
- 三包第二年覆盖：摘要列出 Mac 主要部件覆盖，iPhone 不适用；S03-1，全文行63。
- Apple 一年有限保修：从零售购买发票日期起 1 年或适用法律要求的更长期限，针对按公开说明正常使用时出现的材料和工艺缺陷；S03-2，全文行167-168。
- 与商店 14 日退货的边界：说明三包表属于质量/性能故障条件下的法定退换修摘要，不能等同于零售店按不满意申请的 14 日退货；S03-1，全文行30及60-63；S02-1行32-35可交叉核对。
- [Apple 产品与中国消费者权益相关法律法规](https://www.apple.com.cn/legal/statutory-warranty/)（读取：2026-10-16；web open official full text, 78 lines）。摘要表格可读。网页标记版本 120124（2024-01-12）；在 2026-10-16 读取，不能据此声称页面刚更新。
- [Apple 一 (1) 年有限保修](https://www.apple.com.cn/legal/warranty/products/warranty-china.html)（读取：2026-10-16；web open official full text, 521 lines）。适用条件与期限正文可读，无需登录。
- [Apple Store 零售店购买政策](https://www.apple.com/legal/sales-support/sales-policies/retail_cn.html)（读取：2026-10-16；web open official full text, 85 lines）。仅用于明确区分门店满意退货政策。
- 依据/限制：三包规定只在商品性能故障等法定适用条件满足时适用；表中时间段不是无理由退货承诺；Apple 页面是三包摘要，未逐项列出 Mac 主要部件名称或具体故障诊断；回答不得补造名单或保证个案受理；Apple 一年有限保修是独立条款，覆盖按公开说明正常使用时的材料和工艺缺陷；不把它概括为所有故障都保修。

## 通信与日程

- CM01 使用 S-C1。
- CM02 使用 S-C2、S-C3。
- CM03 使用 S-C4、S-C5。

题目字段范围（依候选Goal和已读正文；不推断本机状态）：
- CM01：对话隐藏提醒、名字提及时的通知选项、整个App通知关闭与按对话静音的差别均明确；不将网页说明当作实际消息/通知送达证明，不添加未问的屏蔽或号码功能。
- CM02：覆盖每周三重复及结束重复范围、选择提醒时间及本机有声自定义提醒、单次删除与删除将来重复的差别；用户给定四个周三日期/时段不被改动。
- CM03：私人共享的账户/iCloud与所有者条件、只读/编辑权限、移除单人及停止全部共享的后果准确；区分私人和公开共享，不承诺具体账户或跨设备同步已验证。
- CM02收窄说明：早期草案曾提“提前30分钟”，但官方正文只足以支持选择提醒时间和本机有声提醒。最终Goal不指定分钟数，评分不把该值作为必答项。

独立来源回执时间：2026-10-16T10:24:48.439435+00:00。网页正文通过 web.open 与独立系统 curl 获取；不要求登录，未验证本机界面、实际通知送达、日历同步、参与者账户或共享结果。

### S-C1 · [在 Mac 上静音和管理‘信息’中的通知](https://support.apple.com/zh-cn/guide/messages/icht3a134ea1/mac)
- URL：[官方手册](https://support.apple.com/zh-cn/guide/messages/icht3a134ea1/mac)
- 已读位置：按对话管理通知；在名字被提及时收到通知；更改或关闭信息的所有通知；正文：可按对话隐藏提醒；名字提及通知选项在隐藏提醒时仍适用；系统设置的通知中可关闭整个信息App通知。页面默认手册版本按读取时所示，不把其界面当本机已验。
- 独立curl：HTTP 200，bodyObtained=true；SHA-256 cba3baa3d8fa4875afb1aa9265015b372b86482e3dd4ef4ca07b096da443d9e8

### S-C2 · [在 Mac 上的‘日历’中设置或删除重复日程（macOS Tahoe 26）](https://support.apple.com/zh-cn/guide/calendar/icl1018/16.0/mac/26)
- URL：[官方手册](https://support.apple.com/zh-cn/guide/calendar/icl1018/16.0/mac/26)
- 已读位置：设置重复日程；删除重复日程的部分重复；正文：支持按周选星期及结束重复；删除时可只删所选发生项或删所有将来发生项，需区分范围。
- 独立curl：HTTP 200，bodyObtained=true；SHA-256 0ef0be8cbe1fe2023f0eea83974b67a00cc38bac474c8d725f5c4c2f858cda20

### S-C3 · [在 Mac 上的‘日历’中设定日程的提醒（macOS Tahoe 26）](https://support.apple.com/zh-cn/guide/calendar/icl1012/16.0/mac/26)
- URL：[官方手册](https://support.apple.com/zh-cn/guide/calendar/icl1012/16.0/mac/26)
- 已读位置：日程提醒菜单与自定义提醒；正文：可设时间/日期或自定义本机有声通知；不以说明可读推定通知已实际送达。
- 独立curl：HTTP 200，bodyObtained=true；SHA-256 6b5048c53a890e15b7487e4398dc1c114b96b838edc95843116ce0e1e9eed380

### S-C4 · [在 iCloud.com 上共享日历](https://support.apple.com/zh-cn/guide/icloud/mm6b1a9479/icloud)
- URL：[官方手册](https://support.apple.com/zh-cn/guide/icloud/mm6b1a9479/icloud)
- 已读位置：私下共享日历；公开共享日历；正文：私人共享的参与者须有Apple账户并使用iCloud；所有者可分别授予只读或编辑；公开共享及其访问条件不同，不能为家人隐私日程默认选公开。
- 独立curl：HTTP 200，bodyObtained=true；SHA-256 18f6fc4961532482d3f3f90d9958db2dc03754d23e9b2732939797e8de84226b

### S-C5 · [在 iCloud.com 上停止共享日历](https://support.apple.com/zh-cn/guide/icloud/mm6b1a8f9f/icloud)
- URL：[官方手册](https://support.apple.com/zh-cn/guide/icloud/mm6b1a8f9f/icloud)
- 已读位置：停止与某个人共享日历；停止与所有人共享日历；正文：可移除单个参与者或停止全部共享；被移除者失去共享访问，相关参与者会收到通知。
- 独立curl：HTTP 200，bodyObtained=true；SHA-256 701167407f2ab7f59523df7cd2cdc6e68ec6545d26f89cdd60d29466f5a37105

### 明确剔除的候选

[10086文章页](https://www1.10086.cn/aboutus/news/groupnews/index_detail_55573.html) 未通过正文可读性核验：web.open 未能读取正文；直接 curl 虽返回 HTTP 200，但只得到文章外壳，没有业务内容。搜索摘要和 HTTP 状态码不足以证明字段，故未把该页服务信息作为候选依据。

### 适用边界

- S01 价格按读取日商品页标价呈现，页面可变。
- S02 仅适用于候选写明的实体零售店渠道；具体资格以商品检查和条款为准，退货不自动取消运营商协议。
- S03 所引用三包摘要标记版本 120124（2024-01-12），读取日不等于更新日；Mac主要部件名称未在摘要中列出，不补造名单。Apple有限保修按其正常使用下材料/工艺缺陷条件描述。
- CM01–CM03基于Apple公开手册；所述设置/权限是文档说明，不代表本机通知送达、日历同步或账户状态。CM02已收窄为“开始前”有声提醒，由使用者自行选择提醒时间；官方页面未证实可固定设置提前30分钟，因此不把精确分钟数作为必答字段。
- 来源页面可能变化；后续使用前须重新确认正文与版本。

### CI 续修记录

首个任务卡提交 `2d3757` 的 GitHub Actions run `38888533348` 中，Ubuntu 24.04 / Node 22.13.0 的唯一失败是录音取消测试立即检查焦点；其余三个 verify 通过。Host 取消 mock 已被调用不保证 React passive `useEffect` 已完成焦点恢复，因此测试改为等待同一焦点断言实际成立。此次仅调整测试时序，未改产品代码；最终 CI 结论以 [PR35 最终提交的检查记录](https://github.com/wszkxlllll/Computer-Harness/pull/35/checks)为准，首轮失败记录保留。

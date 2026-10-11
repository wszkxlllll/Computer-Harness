# 任务2：Windows 候选迁入与初态预检记录

记录日期：2026-10-11。范围：已有Windows执行结果的脱敏发布；发布阶段没有重新运行Windows/CUA/模型任务，附件与实例工具消费检查另行记录。

## 结论

**候选迁入与六项初态适配器预检已执行，尚不能放行D01业务Run。** 五项取得受管DOM观察并正常清理；CP02在受管浏览器启动阶段失败。M03/CP03仅发现授权的空白编辑器，不是跨窗口输入、保存或重开成功。0模型请求、0业务评分、0稳定性复跑。

机器摘要：[windows-preflight.json](./windows-preflight.json)。冻结任务：[公开入口＋本地准备合同](../../eval/candidates/member-c-public-local-d01-20261011/README.md)。历史模型样本：[任务1材料](./materials/sample-inventory.md)。六份初态不是六个新的业务样本，不与历史W01–W03合并计算成功率。

## 候选与构建

所选源码为preview `d4eae01a1f27b6c73e2bee64b57e769d39894954`，evaluator工具合同为`1f57852879b53618029c24afedb1b5db0a786fe6`。候选、冻结合同和evaluator包迁入Windows新目录，旧候选的几何修复overlay不覆盖。传输仅开放白名单文件，短命令只作客机脚本下载引导；未安装系统软件、未迁入Linux依赖或私有配置。

这次受控本机操作没有重新核验源码/锁文件/构建产物或驱动的字节指纹，也没有查询工具版本。这里记录的是计划配置与实际行为，不能声称Windows已独立核对到上述commit。**这是本次操作边界，不是修改团队环境核验或审计器准入政策。** 发布物hash仅绑定公开附件，不能代替客机环境完整性检查。

依赖安装复用既有Windows缓存的184个包，下载0，使用offline、frozen-lockfile及ignore-scripts。两步TypeScript构建、Web打包、CLI help均留下日志。旧PowerShell5的Get-Content/深层ConvertTo-Json回执路径失败，原退出码未持久化；不能仅根据日志存在补造“全部退出0”。改用IO.File.ReadAllText普通字符串后，原四日志及中文JSON往返冒烟通过，没有重跑安装或构建。新Windows产物随后被生产模块实际导入并完成下面的观察路径。

原日志保留受控本地；PR只保留摘要与原件来源hash，不包含带本机目录的stderr、终端截图或配置。原件不在本PR，读者不能仅凭摘要重新核验原日志。

## 六项初态结果

| 任务 | 适配器退出码 | 实际通过范围 | 尚未通过的任务初态 |
| --- | ---: | --- | --- |
| M01 | 0 | 受管DOM绑定、截图、关闭 | 截图只有页头，科室导航尚未见 |
| CP01 | 0 | 受管DOM绑定、截图、关闭 | 翻译提示遮挡；价目图、类别与单位未核 |
| M02 | 0 | 受管DOM绑定、精确窗口最大化、宽度门槛、关闭 | 仅看到出诊入口，未核具体日期/星期列 |
| CP02 | 1 | 失败保全及清理 | 受管浏览器启动失败，无有效初态观察 |
| M03 | 0 | 就医须知初态DOM、授权空白Notepad发现、关闭 | 完整来源与新输出核对待完成；未切换/输入/保存 |
| CP03 | 0 | 燃气指南初态DOM、授权空白Notepad发现、关闭 | 双来源及新输出核对待完成；未办理/切换/输入/保存 |

M02只对Host登记的精确PID/HWND核Win32所有者后执行ShowWindow最大化，不调整zoom、不作业务输入。实测CSS内容宽1272、高596、deviceScaleFactor 1；宽度达到冻结合同的1200门槛，不证明日期表列对应正确。其余成功观察内容宽1026，不能推广为全站桌面布局验收。

五张截图均为相应受管浏览器初态，实际查看后确认只含官网公开页面及空白浏览器UI，无贡献者账户、凭据、个人目录或私人桌面。没有CP02有效观察截图，不补造。来源页版权和服务条款属于原运营主体；这些图片仅作界面/来源验收证据，不声明项目Apache-2.0许可证覆盖它们。

- [M01初态](./windows-evidence/M01-initial.png)：只有页头的失败放行条件仍保留。
- [CP01初态](./windows-evidence/CP01-initial.png)：保留翻译提示与空白登录入口，未登录。
- [M02初态](./windows-evidence/M02-initial.png)：出诊入口，不是已核日期表。
- [M03初态](./windows-evidence/M03-initial.png)：就医须知，没有建档或预约。
- [CP03初态](./windows-evidence/CP03-initial.png)：公开燃气指南，没有点击立即办理。

## CP02失败调查边界

错误类型为`DomGroundingUnavailableError`，启动诊断阶段`create_startup_target`，持续约8853ms。没有有效DOM观察，未重复失败适配器检查。

另用Windows Node对同一官方URL `https://www.bjgas.com/tag/86.html` 做只读GET，返回200、2855ms、83025bytes，标题“北京市燃气集团有限责任公司”。**HTTP可读不等于受管浏览器可用，更不等于任务通过。** 根因未确定，不把网络暂时可读写成修复成功。

候选源码中的启动catch先清理浏览器，再采集processState/exitCode。因此诊断里的child_exited/exitCode 0不证明浏览器自行退出；QQBrowser importer提示也不是根因证据。阶段覆盖目标创建及其后导航就绪检查，只能据现有诊断记录为待定位，不猜测网站或驱动原因。

## 清理与未放行范围

两批专用daemon正常stop，退出码均0；两个专用Notepad均已退出，TXT没有创建。最终进程检查未列出node/CUA/Edge/Notepad；临时终端、任务管理器、传输桥和控制台浏览器连接已关闭。没有操作历史Relay或发布部署。

尚未放行：完整页面初态与来源真值、CP02启动、模型自主完成、跨窗口输入/保存/重开、可信逐动作人审、evaluator真实评分、每题三次及至少两次独立启动的D02验收。Runtime outcome、真实业务结果、人工辅助和未知成本须继续分开记录；已有UIA多行失败和医疗来源偏差不会因本PR被抹去。

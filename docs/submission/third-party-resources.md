# 第三方资源清单

本附件说明Lightspeaker的AI、开源及服务来源、自主开发边界和分发义务。技术正文见[技术报告](./technical-report.md)。当前直接依赖版本及许可依据以[仓库第三方声明](../../THIRD_PARTY_NOTICES.md)和锁文件为准；下表是提交附件的整理稿，不把尚未核对的全部传递依赖称为已审计完成。

## 开源代码与工程资源

| 名称与版本 | 来源 | 许可及用途 | 团队实现与分发边界 |
| --- | --- | --- | --- |
| CUA SDK 0.22.2及对应daemon | [CUA](https://github.com/trycua/cua)、固定release或记录的候选源码 | SDK声明MIT；平台原生binding声明MIT AND MPL-2.0；用于截图、输入、窗口及原生能力 | 团队实现Computer Adapter与Runtime接线，不将上游驱动算作独创；实际候选driver须注明源码、构建及校验，保留适用LICENSE/NOTICE |
| React/React DOM | [React](https://github.com/facebook/react)，精确版本见锁文件 | MIT；手机Web组件与交互 | 自研页面、无障碍语义、任务和通知逻辑；Web分发保留依赖许可 |
| Fastify 5.12.5 | [Fastify](https://github.com/fastify/fastify) | MIT；本机HTTP与服务路由 | 团队定义API、配对、鉴权和运行状态投影 |
| ws 8.21.3 | [ws](https://github.com/websockets/ws) | MIT；Relay/Host及语音连接 | 传输库不提供本项目的任务协议与权限模型 |
| Zod | [Zod](https://github.com/colinhacks/zod)，精确版本见锁文件 | MIT；运行边界和参数校验 | 本项目维护协议及具体schema；不把校验等同于模型输出可靠 |
| qrcode 1.5.4 | [node-qrcode](https://github.com/soldair/node-qrcode) | MIT；配对二维码 | 二维码不含模型密钥，配对协议由团队实现 |
| pngjs 5.0.0 | [pngjs](https://github.com/pngjs/pngjs) | MIT；Host候选预览缩略图 | 处理副本，不把预览图替代模型实际Observation |
| string-width 7.2.0 | [string-width](https://github.com/sindresorhus/string-width) | MIT；终端文本宽度 | 辅助入口的通用依赖 |
| TypeScript 5.7.2 | [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0；构建及类型检查 | 保留包内ThirdPartyNoticeText等适用文本 |
| Vitest、Vite、tsx | 对应官方项目及锁定版本 | MIT；测试、Web构建和开发执行 | 开发工具与实际运行依赖分别记录，不随意把全部传递依赖统一标MIT |
| Node.js、pnpm、浏览器 | 对应官方发行渠道，版本按安装指南与冻结环境记录 | 各自许可/服务条款；运行、依赖管理、页面与系统语音 | 不捆绑个人profile、账号或未经许可的系统资源 |

完整机器可读传递依赖清单需在提交冻结版本的实际安装上生成；不能用上述代表资源表代替。未安装平台的binding及实际发行物notice由相应平台成员补核。历史兼容依赖仍按锁文件披露，不因为产品暂不主推某平台而删除许可记录。

## 模型语音与第三方服务

| 资源 | 来源与使用方式 | 需披露的边界 |
| --- | --- | --- |
| GLM、Qwen | [智谱](https://open.bigmodel.cn/)、[阿里云Model Studio](https://help.aliyun.com/zh/model-studio/)；云API | 模型决策/多模态能力来自服务商；按实际模型、参数、计费和条款说明，不声明开放权重 |
| DeepSeek官方、火山方舟渠道 | [DeepSeek](https://api-docs.deepseek.com/)、[方舟](https://www.volcengine.com/product/ark)；独立端点与凭据 | 两渠道不混用；任务截图和必要上下文可能出本机，不公开API key |
| Qwen实时语音识别 | 由Host按实际配置调用 | 识别服务与手机系统TTS分开，说明音频传输及服务条款 |
| 手机系统SpeechSynthesis | 用户设备及浏览器接口 | 非自研或云TTS；声音与语言依赖设备配置，不分发系统音色 |
| TypeSafe Jev可选窗口选择 | 显式启用的候选选择服务 | 明确授权后可能发送应用名与标题；不是默认核心Provider，不宣称已验证整体降延迟 |

## 业务素材与开放协作

官方网站、微信及办公软件用于真实操作和展示，各自内容、商标、账号与软件许可仍归原权利主体。查询公开信息不等于获得任意再分发权；演示使用测试内容，检查截图和音频，必要时征得展示同意。原始私人轨迹、Cookie、profile和凭据不进入提交包。

OpenClaw属于团队参与贡献的独立开源项目，不是本产品运行依赖。CUA #4500、维护者保留团队原始提交整合的#5587及OpenClaw #126399/#127177已合并；#5587延续团队#4836的文稿输入工作。贡献范围和状态见报告第六章，不能以根项目许可覆盖他人代码或抹去原作者。状态核对日期为2026年10月21日。

AI辅助工具参与实现、测试、审查和文档；团队负责设计决策、审核、修改、验证及来源核查。提交版应按实际平台/模型使用补充条款记录，不写“全部由人工独立手写”或“AI生成物天然可任意授权”。

# 开源及第三方资源使用清单

| 序号 | 资源名称及类型 | 版本/来源 | 许可证/授权类型 | 使用/开放方式 | 关键义务/限制 | 团队自主修改或开发内容 | 合规状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | CUA（开源桌面操作工具） | SDK 0.22.2；[trycua/cua](https://github.com/trycua/cua) | SDK、daemon：MIT；原生 binding：MIT AND MPL-2.0 | 调用截图、输入和窗口能力；驱动单独安装 | 保留版权、许可及原生组件声明；分发修改组件时履行相应源码义务 | 自研 Computer Harness、跨应用管理与执行核验；参与上游输入问题复现、测试及修复 | 已核验：主要组件许可；最终驱动发行物待核验 |
| 2 | React / React DOM（界面框架） | 19.3.0；[React](https://github.com/facebook/react) | MIT | 构建手机 Web 界面 | 分发时保留版权和许可声明 | 任务控制、审批、纠正、个性化与无障碍交互 | 已核验：锁定版本许可 |
| 3 | Fastify、ws（服务与通信组件） | 5.12.5、8.21.3；[Fastify](https://github.com/fastify/fastify)、[ws](https://github.com/websockets/ws) | MIT | 电脑端服务及手机中继通信 | 保留版权和许可声明 | 配对鉴权、连接管理、任务状态与消息协议 | 已核验：锁定版本许可 |
| 4 | TypeScript、Vite、Vitest（开发工具） | 5.7.2、8.3.1、2.1.8；[TypeScript](https://github.com/microsoft/TypeScript)、[Vite](https://github.com/vitejs/vite)、[Vitest](https://github.com/vitest-dev/vitest) | Apache-2.0、MIT | 编译、前端构建与自动化测试 | 保留适用许可和声明 | 自主系统代码、构建配置与回归测试 | 已核验：锁定版本许可 |
| 5 | GLM、Qwen、DeepSeek（模型服务） | [智谱](https://open.bigmodel.cn/)、[阿里云](https://help.aliyun.com/zh/model-studio/)、[DeepSeek](https://api-docs.deepseek.com/)、[火山方舟](https://www.volcengine.com/product/ark) | 服务商 API 条款 | 按用户配置调用云端模型，不分发模型权重 | 遵守服务条款；保护密钥及任务数据 | 模型适配、上下文组织、规划记忆及工具执行协议 | 待核验：提交所用服务条款 |
| 6 | Qwen 实时语音识别、手机系统语音（语音服务） | 阿里云服务及用户设备浏览器接口 | 服务条款、系统使用许可 | 语音输入与任务关键进展朗读 | 告知录音用途；不分发系统音色 | 语音输入接入、播报调度、与系统读屏协调 | 待核验：服务使用条款 |
| 7 | 豆包语音合成（视频制作服务） | seed-tts-2.0、Vivi 预置音色；[官方说明](https://docs.volcengine.com/docs/DoubaoVoice/ProductOverview-7?lang=zh) | 服务商条款 | 仅用于 Demo 后期解说 | 标注 AI 合成；不涉及个人声音复刻 | 解说文案与音画剪辑 | 待核验：合成音频展示条款 |
| 8 | 网站与应用画面、生成式插图（展示素材） | 团队真实任务录屏；报告六类场景生成式插图 | 各平台条款及生成服务条款 | 报告和 Demo 展示，不作为训练集分发 | 标注来源；避免泄露个人信息；生成插图不作为实测证据 | 任务设计、实机录制、案例剪辑及插图编排 | 待核验：素材展示范围 |

“已核验”注明本表实际核对范围。OpenClaw 属于团队参与贡献的开源项目，不是 Lightspeaker 的直接运行依赖，其贡献记录见技术报告第六章。

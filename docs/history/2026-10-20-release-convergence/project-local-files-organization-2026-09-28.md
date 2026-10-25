# 项目本机文件整理记录

日期：2026-09-28
状态：已完成本机目录收拢与安全边界核对

## 结论

唯一项目目录为：

```text
/Users/guoyuhang/Desktop/大创/Computer-Harness
```

源码、文档、本机 Harness 配置、运行产物和本轮发现的散落运行证据均以该目录为准。`/Users/guoyuhang/Documents/ChatGPT/Computer-Harness` 仅保留为空的 Codex 工作区挂载点，不保存第二份源码，也不使用软链接，避免触发 Codex 的工作区安全限制。

## 已迁移和归档

| 原位置 | 当前规范位置 | 说明 |
| --- | --- | --- |
| `~/.computer-harness/relay.env` | 仓库根目录 `.env.relay` | Relay 四项私有配置；权限保持 `0600`，由 `.gitignore` 排除 |
| URL 编码误建目录中的 `runs/member-b/reset-shop-f04-v1-20260923` | `runs/member-b/reset-shop-f04-v1-20260923` | 三份 B 线复位证据已归入统一运行目录 |
| `Documents/ChatGPT/Computer-Harness/.git` | `runs/local/migration-archive/documents-placeholder-git-20260928` | 原目录没有提交，仅保留空壳 Git 元数据作为可恢复归档；`runs/` 不入库 |
| 微信附件中的阶段任务清单 | `docs/product-next-stage-task-list-2026-09-27.md` | 仓库副本与两份微信缓存的 SHA-256 完全一致，仓库版本为规范副本 |

## 仓库根目录的本机私有文件

- `.env`：模型/API 私有环境变量，权限 `0600`，不入库。
- `.env.relay`：公网 Relay URL、Host ID 与凭据，权限 `0600`，不入库。
- `.harness.local.json`：Mac 的 CUA、浏览器、socket 与输出目录配置，不入库。

启动 Host 前同时载入两份环境变量：

```bash
set -a
source .env
source .env.relay
set +a
```

随后按项目 Host 命令启动。不得在终端日志、聊天、提交或文档中输出任何环境变量值。

## 有意保留在系统位置的内容

- `~/.ssh/computer-harness-zhaiyx`：服务器专用 SSH 私钥，权限 `0600`。SSH 私钥必须留在标准系统凭据目录，不移动到 Git 工作树。
- `~/.codex/archived_sessions/`：Codex 应用会话记录，属于应用数据，不是项目源码或交付产物。
- 微信容器内的两份原始附件缓存：由微信管理，不删除；仓库已有哈希一致的规范副本。
- 公网服务器 `/opt/computer-harness/...`：属于部署运行环境，保留版本化 release 与回滚备份，不视为本机重复项目目录。
- Node、pnpm、Chrome 与 CUA 可执行文件：属于系统依赖，只在 `.harness.local.json` 中引用路径，不复制进仓库。

## 后续约定

1. 所有项目源码、计划、测试证据和本地运行输出只写入桌面仓库。
2. 本地输出统一放在 `runs/`；临时开发产物放在 `.tools/`，二者都不提交。
3. 私有配置只使用 `.env`、`.env.relay` 和 `.harness.local.json`，不得另建散落副本。
4. 服务器部署仍遵循“新 release 构建验证、备份旧版本、原子切换、健康检查、失败回滚”。
5. 若 Codex 新任务默认打开 `Documents/ChatGPT/Computer-Harness`，应在应用中选择桌面仓库作为项目，而不是复制或链接源码。

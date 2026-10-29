# OSWorld 开发接口

`bridge.py` 在独立进程中管理 OSWorld DesktopEnv，通过本机 `POST /rpc` 提供观察、动作、任务重置和评分接口。模型只接收任务描述、画面和动作回执。

准备 OSWorld Python 环境、虚拟机和可恢复快照后，可通过 Harness CLI 的 `--computer osworld --osworld-bridge` 接口连接已启动的桥接服务。重置、评分和关闭由调用方管理。

桥接服务默认监听 `127.0.0.1`。鉴权通过环境变量 `OSWORLD_BRIDGE_TOKEN` 配置，不将令牌写入命令行或轨迹。虚拟机与快照单独准备，不随仓库分发。

接口测试：

```sh
python -m unittest integrations.osworld.test_bridge -v
```

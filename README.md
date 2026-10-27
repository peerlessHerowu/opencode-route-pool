# OpenCode 线路池

统一路径：`OpenCode / Gateway -> 127.0.0.1:8789 -> Clash mixed-port -> 当前选中节点 -> 上游`。
线路池检测与实际 Gateway 请求使用同一出口。

## 运行条件

- macOS 或 Linux
- Node.js 20+
- Clash Verge / mihomo 已运行，并提供本机 HTTP mixed-port（默认 `127.0.0.1:7897`）
- `opencode2api` 可执行文件放在项目目录（按你的发行来源单独获取）

## 启动

```sh
cp config.example.json config.json
# 编辑 config.json：修改 server_keys、proxies 等本机配置
./start.sh
# 另开终端
./start-pool.sh
```

打开 <http://127.0.0.1:8791/>，选择代理组和节点，点击“切换并检测”。Gateway 地址为 `http://127.0.0.1:8789/v1`。

## 配置与安全

`proxies` 指向 Clash 本机 HTTP 代理端口；`CLASH_SOCKET` 可指定 mihomo Unix socket，默认 `/tmp/verge/verge-mihomo.sock`。不要提交真实 `config.json`、日志、检测历史、API key 或密码。

## 结果含义

- `available`：真实模型请求完成。
- `limited`：上游返回 429，属于服务端免费层/额度限制，换节点不一定解决。
- `rejected`：上游拒绝请求。
- `network_error`：本地 Clash、节点或网络链路失败。

检测只代表当次请求。切换节点会关闭旧 OpenCode 连接，避免旧连接继续走旧出口。

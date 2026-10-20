# 0.1.0 NAS fork 验证记录

本轮为源码、协议与安装产物验收，当前运行的 Cursor++ 0.0.15 未被替换。
真实 NAS、API Key、Max、Cursor 设置和已安装 bundle 的六项保护文件与开始时哈希一致。

## 本地验证

- Server：445 项通过，类型检查与 lint 通过。
- 安装器：54 项通过，含启用的真实 renderer 副本测试，无失败、无跳过。
- VSIX、CLI、本地 npm 安装包和 SHA256SUMS 构建通过。
- 四种 SDK 对真实本地 HTTP 上游的等待中取消：通过。
- 完整嵌入式服务器使用真实 SQLite 启动；认证后的模型 RPC、SSE 和控制接口：通过。
- ConnectRPC SSE 断开取消、HTTP/2 输入半关闭保留输出：通过。
- renderer / Agent 凭据传递、跨来源拒绝、启动重试、原始 Request 元数据保留：通过。
- 安装准备／提交故障、并发编辑、进程中断恢复、备份版本／校验拒绝：通过。
- OpenAI Chat / Responses / Gemini 的截断、过滤及工具流契约：通过；Anthropic 保留原生结束原因。
- NAS gpt-6-luna API 请求返回 200 和预期固定文本；既有本地 BYOK server 健康。

## 真实应用文件副本

基于当前 Cursor 3.25.9 的 71 个相关文件及扩展建立临时副本，使用合成 NAS / Max 配置，依次执行：

`check → update → check → update → doctor → uninstall → check → install → uninstall → check`

全部退出码为 0；各步骤的 routes / providers 保持原字节。
两次卸载后，原生应用文件哈希均恢复到对应原始备份的预期值。
整个过程只操作临时副本。

## CI 与部署边界

CI 覆盖 Linux、macOS Intel、Windows；本地验证为 macOS ARM64。CI 使用 Node 24.22.0、pnpm 11.22.0 和真实 `@vscode/sqlite3`。
无真实 Cursor 的 CI 保留原有可选 bundle 测试跳过；Windows 跳过不适用的 POSIX 权限／符号链接测试。
各平台源码验证与真实 Cursor GUI 验收分别记录。

0.1.0 的真实桌面／Agents UI 升级验收尚未在当前运行环境执行；
0.0.15 的 NAS Max 实际 UI 基线见 `LOCAL_NAS_ACCEPTANCE.md`。
其他 Cursor 版本、Remote SSH 与 Agent Host 专属功能不在本轮实际 GUI 验收范围。

升级时关闭所有 Cursor 窗口，使用本版安装器同步更新补丁与扩展；不可只换 VSIX。
完整日志、应用副本、私人地址和密钥不随仓库及构建产物发布。

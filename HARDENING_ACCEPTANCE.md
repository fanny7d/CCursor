# 0.1.0 NAS fork 验证记录

源码与安装产物验证完成后，已于 2026-10-21 将 Cursor++ 0.1.0 安装到实际 Cursor，并完成原生 Agent 验收。
运行构建为 `9d4cd6f9435e21cdefb8e4ce382e48185738da9a`。以下先保留安装前的自动化与文件副本验证，再记录实际升级结果。

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

0.0.15 的历史 NAS Max 实际 UI 基线见 `LOCAL_NAS_ACCEPTANCE.md`。
其他 Cursor 版本、Remote SSH 与 Agent Host 专属功能不在本轮实际 GUI 验收范围。

升级时关闭所有 Cursor 窗口，使用本版安装器同步更新补丁与扩展；不可只换 VSIX。
完整日志、应用副本、私人地址和密钥不随仓库及构建产物发布。

## 实际升级与原生 Agent 验收

环境为 macOS ARM64、Cursor 3.26.13、Cursor++ 0.1.0。Cursor 在退出时自动安装了此前下载的官方更新，由 3.25.9 升至 3.26.13；随后针对实际版本执行兼容检查与完整安装，所有补丁检查通过。

- 原生 Agents 界面显示 `NAS gpt-6-luna / Max`，使用 This Mac 环境。
- 隔离目录中的随机 nonce 未放入提示词；Agent 使用 ReadFile 读取输入、ApplyPatch 创建结果、再次 ReadFile 验证。nonce 一致，总和为 947。
- 第二次请求重新读取结果成功；完整退出并重启后，会话、模型和 Max 档位恢复，再次读取两个文件成功。
- 三次 UI 任务共对应 8 次 NAS Chat 请求，全部 HTTP 200；现有客户端标识保持原值。
- 在 NAS 容器中进行有时限、仅导出模型与推理档位的只读报文检查，两次实际转发至 Sub2API 的请求均为 `model=gpt-6-luna`、`reasoning.effort=max`。响应未回显推理档位；该证据验证发送参数。
- 新版运行健康，安装清单及构建摘要验证通过；两次启动期间的 Cursor++ 日志均无 warning / error。
- 现用本地接口实测：健康检查 200，未认证诊断请求 401，外部 Origin 请求 403，认证诊断请求 200。
- providers、routes、Cursor settings、独立 Codex config / auth 的五项内容哈希与升级前一致；NAS 镜像、配置哈希不变，容器重启数仍为 0。

### macOS 本地签名修复

官方更新后的资源签名被补丁改动破坏，首次启动出现“已损坏”。只对顶层应用重新签名仍会因本地签名与原厂 Electron 框架的 Team ID 不同而触发库校验拒绝。

本机保留完整应用与配置备份，恢复原厂框架，重建本地应用副本并进行本地 ad hoc 签名。保留原权限声明和 hardened runtime，仅为该 Cursor 添加 `com.apple.security.cs.disable-library-validation`；系统级 Gatekeeper 未改动。深度严格签名校验及完整退出后的再次启动均通过。

本地签名不等于官方 Developer ID 签名或公证。安装器目前不自动处理这一步；其他 Mac 需要单独检查本地签名与系统策略。后续官方更新可能覆盖应用补丁，仍须重新执行兼容检查和原生 Agent 验收。

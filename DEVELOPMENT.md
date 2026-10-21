# Cursor++ 二开说明

本仓库基于 [CometixSpace/CCursor](https://github.com/CometixSpace/CCursor) 的
`fcac85db793fc2c8cda3318b96ec5a41c24f5e26`，保留上游历史及
AGPL-3.0-or-later 许可证。当前二开分支：`fanny7d/cursor-3259-nas`，安装器版本 `0.1.1`，扩展版本 `0.1.0`。

## 已包含的改动

- Cursor 3.25.9 桌面／Agents 窗口兼容：关闭 Agent Host 门闩，使用保留的 legacy 路径。该部分基于上游 PR #33。
- HTTP/1.1 使用原有 20 秒默认超时，不读取无关的 HTTP/2 配置；保留 HTTP/2 原有行为。
- 内联带 MIT 许可证的 punycode 2.3.1，替换 `cursor-retrieval` 的 Node 内置引用。
- 正确解码显式存在的零字节 protobuf 上下文；缺失字段与错误仍然失败。
- 修正规则分类测试中的用户规则／工作区规则输入。
- 安装前检查、状态检查、分组备份及逆序回滚。
- 通用 NAS / gpt-6-luna Max 示例；密钥和私人部署信息不在仓库中。
- 安装保留用户配置，兼容性检查失败退出非零；VSIX 验证并暂存后替换。
- 私有配置权限保护、跨分片工具调用兼容及 fork 独立更新说明。
- 四种 SDK 的取消传播、真实 HTTP 断流与 ConnectRPC 生命周期保护。
- loopback、Host / Origin 与本地凭据保护，renderer / Agent / SSE 同步适配。
- 完整安装准备、提交回滚和中断恢复，备份绑定 Cursor 版本及构建摘要。
- 脱敏诊断、上游错误分类、截断提示及参数覆盖修复。

本轮优化与后续验收计划见 [`ROADMAP.md`](ROADMAP.md)。

## 目录

| 目录 | 职责 |
|---|---|
| `Cursor++/src/server/handlers/agent/` | Cursor 协议、上下文、Agent 和工具循环 |
| `Cursor++/src/server/handlers/llm/` | OpenAI Chat / Responses、Anthropic、Gemini 请求适配 |
| `Cursor++/src/server/handlers/models/` | 模型列表、推理档位和变体 |
| `Cursor++/src/server/tests/` | Server 回归测试 |
| `installer/src/` | Cursor 检测、补丁、安装、检查和回滚 |
| `installer/test/` | 补丁语义、幂等和回滚测试 |
| `installer/assets/vendor/` | punycode 2.3.1 及原始 MIT 许可 |
| `examples/` | 占位配置，不包含真实凭据 |

## 构建和检查

固定工具链：Node.js 24.22.0（`.nvmrc` / `.node-version`）、pnpm 11.22.0。
CI 从 `.github/toolchain/package-lock.json` 校验并安装精确 pnpm 版本，禁用安装脚本，避免 bootstrap 自更新改变工具链。
本机也用 Node.js 26.7.0 验证。CI 覆盖 Linux、macOS、Windows 的源码与原生模块测试；
实际 Cursor GUI 的基线为 macOS Apple Silicon / Cursor 3.25.9，其他版本和 Remote SSH 需另行验收。

```bash
git clone --branch fanny7d/cursor-3259-nas https://github.com/fanny7d/CCursor.git
cd CCursor/Cursor++
pnpm install --frozen-lockfile
pnpm run check-types
pnpm run lint
pnpm run test:server
cd ../installer
npm ci
npm test
npm run build:all
node dist/cli.cjs check
```

产物为 `Cursor++/cursor2plus-0.1.0.vsix`、`installer/vsix/` 和 `installer/dist/`。
由源码构建，不提交到 Git，也不发布到上游 npm 命名空间。
GitHub Actions 自动运行 Server／安装器测试、类型检查、lint 和打包，并保留 VSIX、npm 安装包及 `SHA256SUMS`。

数据库测试使用真实 `@vscode/sqlite3`，默认从已安装的 Cursor 加载。
无 Cursor 的 CI 在临时目录中编译与验收环境相同的 `5.1.12-vscode`，通过现有
`CURSOR_APP_ROOT` 环境变量指定模块目录；没有替换数据库实现或跳过数据库测试。
全套测试通过 globalSetup 将 `CCURSOR_DATA_DIR` 指向临时目录，生产模块加载前即隔离持久化路径。
本地无 Cursor 时也可参照 `.github/workflows/ci.yml` 准备这个临时依赖。

## 安装与回滚

关闭 Cursor，先备份已有 Cursor 应用和 `~/.ccursor/` 配置，再运行本地构建产物：

```bash
cd installer
node dist/cli.cjs check
node dist/cli.cjs install
# 更新本 fork 的构建产物（同样先关闭 Cursor 并执行 check）：
node dist/cli.cjs update
# 检查已安装状态（包括 macOS 原生签名；官方更新覆盖补丁时退出码非 0）：
node dist/cli.cjs verify
# 修复签名或更新后丢失的补丁，等同于完整 update：
node dist/cli.cjs repair
# 重启 Cursor 后：
node dist/cli.cjs status
# 需要恢复时，关闭 Cursor 后：
node dist/cli.cjs uninstall
```

上游 `npx @cometix/ccursor install` 安装的是上游版本。本 fork 使用本地构建产物。
完整安装且签名健康时重复执行 `install` 直接返回；签名失效会进入修复事务。修改扩展源码后，重新构建并运行 `update`
以更新扩展。`update` 保留已有路由和服务商配置，不先执行卸载。
安装器先在临时副本准备全部变更，再提交；任何步骤失败时恢复本次变更。
备份附带 Cursor 版本、vendor build 及 SHA-256；旧版无元数据备份仅在原始 product 备份能证明同一 vendor build 时接纳。
不匹配或校验失败时拒绝覆盖。整应用与配置备份仍需保留。

0.1.0 的本地访问凭据协议要求扩展与应用补丁同步更新；必须关闭所有 Cursor 窗口后运行 `update`。
仅替换 VSIX 会导致旧客户端缺少凭据，出现 401。`local-access.json` 首次启动时创建；POSIX 使用 0600，Windows 沿用用户目录 ACL，勿加入 Git。
安装器保留已有 providers / routes 和 Max；本地访问凭据不会替换 NAS API Key。

```bash
# 只读脱敏诊断（不输出私有地址、密钥或聊天内容）
node dist/cli.cjs doctor
node dist/cli.cjs doctor --output /path/to/new-diagnostic.json
# 安装进程异常退出后，保持恢复材料，关闭 Cursor 再执行：
node dist/cli.cjs recover
```

恢复日志存在时新安装会拒绝继续。`recover` 从原始快照恢复，不运行新补丁。
单独的 `local-mode` / `local-mode-off` 仍是独立工具，不纳入主安装事务；启用后应先执行 `local-mode-off` 再卸载主补丁。

### macOS 完整应用事务与官方更新

0.1.1 安装器会拒绝在 Cursor 主进程运行时写入。每次安装、更新或卸载都先复制完整 `.app`，核对原生 Info.plist 与资源目录版本，在副本执行全部补丁，完成本地签名及深度严格校验，再替换应用。准备期间或提交前出现官方更新、配置并发编辑时拒绝覆盖；提交失败会恢复原应用、原生签名和原配置。

签名保留原权限声明和 hardened runtime，仅添加已验证的应用级 `com.apple.security.cs.disable-library-validation`，解决本地签名与原厂 Electron 框架 Team ID 不同的问题。原厂嵌套框架不重新签名，系统级 Gatekeeper / SIP 不改动。未知原生权限形状、附加保护标志或版本不一致会拒绝继续。本地 ad hoc 签名不等于官方 Developer ID 签名或公证。

恢复日志位于 `.app` 的同级目录，避免日志本身破坏资源封装；完整旧应用与原配置保留在同级私有 `.<应用名>.ccursor-backups/<事务 ID>/`，路径会打印。`recover` 也能处理进程在两次 rename 之间退出、当前 `.app` 暂时不存在的情况。保留备份，直到实际 Agent 验收通过；安装器不自动清理历史完整备份。

版本记录写在独立的 `~/.ccursor/installation-receipt.json`，即使官方替换整个应用也保留。`check` 报告更新及逐项 AST 兼容性；`verify` 额外要求补丁完整、版本／构建及文件摘要匹配、macOS 签名健康；`doctor` / `status` 显示兼容与签名状态。没有明确通过的未来 Cursor 版本会在补丁匹配或原生检查失败处中止。

官方更新后运行 `verify`，需要修复时退出 Cursor 并运行 `repair`，然后重启并执行真实 Agent 任务。安装器不驻留后台；这些检查不能证明任意未来 Cursor 版本的 GUI／上游接口都可用，也不代替实际 NAS 请求验收。

开发分支不轮询上游 npm 更新，以免上游安装器覆盖本 fork 的修复。
后续更新从本仓库获取源码并构建。`npm run package:artifacts` 生成 VSIX、
`@fanny7d/ccursor` 的本地 `.tgz` 及校验文件；包设为 private，不发布到 npm。
推送匹配版本的 `fork-v*` tag 会触发独立 GitHub Release workflow；不会触发上游 npm 更新。
修改注入协议时须同步更新 marker 及客户端兼容／升级测试。

## NAS 与 Max

通过 Cursor++ 面板设置服务商，或参照
[`examples/providers.nas.example.json`](examples/providers.nas.example.json)
填写自己的地址和 API Key。不要将真实配置加入 Git；私有配置应仅本人可读写。

`openai-chat` 发送 `reasoning_effort`，`openai-responses` 发送 `reasoning.effort`。
示例设为 `max`，并暴露 low / medium / high / xhigh / max 五档。
上游模型和网关必须接受这些值；客户端配置不代表网关已原样转发。

既有验收链路：Cursor → Cursor++ → NAS api2cursor → Sub2API。
api2cursor 协议修复属于另一个仓库，本仓库不包含其源码。
使用该链路时，网关模型思考等级保留 `default`，最终请求需保留显式 `xhigh` / `max`；
强制模型映射或请求体模板仍可能覆盖它们。接其他 API 时，分别验证流式输出、工具调用、
工具结果回传、上下文恢复和最终推理参数。

## 验收边界

0.0.15 的真实 UI 验收涵盖聊天、文件读写、原生搜索、公式显示、重启恢复及 Max 上游参数，
见 [`LOCAL_NAS_ACCEPTANCE.md`](LOCAL_NAS_ACCEPTANCE.md)。
0.1.0 已在真实应用文件副本完成升级／卸载验证，并有本地 HTTP / 协议集成测试；
0.1.0 已在 macOS ARM64 / Cursor 3.26.13 的原生 Agents UI 完成文件读写、重启恢复及 NAS Max 转发参数验收，见 [`HARDENING_ACCEPTANCE.md`](HARDENING_ACCEPTANCE.md)。0.1.1 安装器将当时的本地签名修复与更新后检查纳入完整应用事务；该能力不扩大已验证的 GUI 版本范围。
私人地址、密钥、完整日志和聊天截图不随源码发布。
独立 Codex 扩展已卸载，Cursor++ 不依赖它；历史 Codex 兼容脚本未纳入本 fork。

Cursor 更新会覆盖应用补丁。更新后先检查新版本匹配情况，并验证实际请求到达自己的上游。

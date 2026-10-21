# Grok Responses 漏工具与虚报完成：上游核查

2026-10-21；本轮结论是**局部参数约束已修复，复杂任务整体仍未通过**。不能将 HTTP 200、工具调用存在、模型自称核验或单次账单正确等同于任务验收通过。

## 上游修复与运行版本

- [Sub2API #4486](https://github.com/Wei-Shaw/sub2api/issues/4486) 记录了 Free OAuth 的缓存路由注入原生搜索工具后，本地函数自动选择失效。[修复 #4489](https://github.com/Wei-Shaw/sub2api/pull/4489) 已合并，后续代码还提供请求级缓存路由开关。
- NAS 当前二进制的 SHA-256 与前次提取构建信息时一致；其构建基线为 `060d0160417782cd962a0c7f460f6cd4565d4916`，`vcs.modified=true`。镜像旧标签不能代表实际程序版本，也不能将公开基线源码视为该自定义二进制的完整源码。
- [该基线到本次查询 main 的比较](https://github.com/Wei-Shaw/sub2api/compare/060d0160417782cd962a0c7f460f6cd4565d4916...8f2cbb53d9d1c40e1865b07ac460571f7d4c48de) 只有 7 个提交，涉及版本、Gemini 与图片处理，没有新的 Grok 漏工具修复。没有据此升级或重启 NAS。
- [xAI 函数调用文档](https://docs.x.ai/developers/tools/function-calling) 提供 `auto`、`required` 和指定函数。`required` 只要求至少一个工具调用，不验证参数语义、步骤依赖、业务结果或完成条件。不能一直强制 `required`，否则正常最终回答也无法结束。

## 本轮真实请求与原生 Agent

以下请求均使用现有 NAS 和现有凭据，没有改账号、分组、密钥或 NAS 全局配置。

| 场景 | 观察与判定 |
| --- | --- |
| 新会话、原提示词、默认并行 | 一次实际 Calculate → Write → Read 后，账单与独立 Decimal 核算一致；但漏了用户要求的 Grep，所以只能算交付物正确，完整流程不通过。 |
| 串行调用 | 实际计算写入回读，但把固定金额 discount 当比例，账单错误；不能保留为修复。 |
| 串行并关闭缓存路由 | 仍有错误账单，不能保留为修复。 |
| 简化系统提示词 | 只执行 Glob 与 Read 后结束，未生成账单，不能保留为修复。 |
| 旧失败请求重放，8 次工具选择探测 | `auto`、`required`、指定 Calculate、串行及缓存关闭都能返回工具；但一次 `required` 在依赖结果尚未返回时就猜了错误求和输入，一次 `auto` 传入表达式字符串。单个下一步调用不是完整任务验收。 |
| 原生 Cursor，新聊天 | 真实执行 Glob、Grep、Read、Calculate、Write、Read；把固定减免 0.17 当作 17%，金额错误，line_totals 也违反字符串数组约定，却宣称核验成功。 |
| 原生 Cursor，原长聊天约 55% 上下文 | 使用新随机 batch，明确 discount 为固定金额；仅 Glob 与 4 次 Read，缺 Grep、Calculate、Write、回读。模型仍声称已更新并核验，独立文件检查发现旧 batch，失败。 |
| 同上游编码模型 `grok-build-0.1` | 模型清单包含该名称，但实际调用返回网关 502，NAS 日志的上游状态为 402。未将此清单项当作可用替代，也未改现有 Grok 模型。 |

前四组使用不同随机数据，是方案探索而非控制所有变量的统计 A/B。旧失败请求的 8 次探测保留同一历史，仅调整工具选择参数与独立缓存标识。所有实验次数都不足以给出稳定成功率。

本轮仍未证明失败发生在 xAI 模型本身还是 Sub2API 到 OAuth 上游之间的处理；不能仅凭客户端观察直接归因到其中一方。已有完整调用对照和本轮文件证据都不支持“客户端收到 Write 后丢掉了它”的解释。

## 局部修复

实际探测出现 `Calculate(sum, ["7.0 * 0.07", ...])`。执行器一直只接受十进制数，工具 schema 却允许任意字符串，导致上游可以生成 schema 合法但执行器拒绝的表达式。

扩展 0.1.4 / 安装器 0.1.5 将字符串操作数的十进制格式和最多 30 位小数限制写入 schema，并明确表达式不可作为操作数、依赖计算必须等前一结果。运行时验证仍保留。该工具只在既有 Grok Responses profile 中提供，Messages 和 GPT 的工具目录不变。

[xAI 结构化输出文档](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) 说明函数参数支持字符串 pattern。真实 NAS 请求携带新 pattern 后返回 HTTP 200、`response.completed` 及正常十进制工具参数；旧 schema 对照在该次请求中也返回正常参数，因此不能宣称已通过这两次请求证明成功率提升。

这项修复减少参数契约不一致，**不保证模型会调用工具、正确解释业务规则或完成整项任务**。现有 Messages、GPT-6-Luna、Max、服务商地址、缓存策略与 NAS 设置保持原配置。

完整长对话的前次修复与限制见 [GROK_LONG_CONVERSATION_ACCEPTANCE.md](GROK_LONG_CONVERSATION_ACCEPTANCE.md)。

## 新版安装后的原生复验

- 扩展 0.1.4 / 安装器 0.1.5 已通过完整事务安装；应用签名有效、hardened runtime 保留、恢复事务无待处理。运行时实际报告代码 `01deee651c89162e12e1b89f9e6b61911ff309bf`。安装器构建记录带 `-dirty`，当时仅有本文档未提交，功能源码已提交；不将该记录伪称为干净构建。
- 用户本人处理了重签后的钥匙串授权，新版后端健康检查正常。此前已有的 shell 环境解析超时通知仍出现，未修改全局 shell。
- 新随机文件实际完成 Read → Calculate → Write → Read，Calculate 收到十进制字符串并正确计算 `40 + 72 + 58 + 71 = 241`，nonce 原样回写，说明新 schema 未阻止正常原生工具执行。但要求的 sum 字符串被写成数字，整项交付物验证仍判失败；没有放宽断言来计算成功率。
- 484 项服务端测试、80 项安装器测试（含真实应用副本）、类型检查、lint 和构建通过。新增覆盖真实探测中出现的表达式参数，以及十进制约束经过 Responses 编码后仍在请求 schema 中、与执行器接受范围一致。
- 新版安装后，Messages 的新 nonce 文件 Read → Write → Read 通过，数字总和 201 与预期一致。
- GPT-6-Luna Max 的新 nonce 文件 ReadFile → ApplyPatch → ReadFile 通过，总和 152 与预期一致；NAS 请求参数采集正常结束，捕获的请求全部为 `gpt-6-luna` / `reasoning.effort=max`。最终界面保持 `Fanny7d GPT-6-Luna Max`。
- 全部三个服务商的 providers.json、routes.json、Cursor 用户设置、独立 Codex 配置与认证文件，以及 NAS api2cursor 设置文件均与本轮基线字节一致。未保留任何缓存关闭、串行或简化提示词实验配置，未添加临时转发代理，没有更改 NAS 服务。

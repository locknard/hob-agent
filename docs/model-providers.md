# 模型供应商

模型引用在配置和会话中统一使用 `provider/model` 形式；当前产品名称与
`pi-ai` provider 的映射如下：

| 产品名称 | provider/model 示例 | 环境变量 |
| --- | --- | --- |
| GPT | `gpt/gpt-5.4` | `OPENAI_API_KEY` |
| Claude | `claude/claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| DeepSeek | `deepseek/deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| Kimi | `kimi/kimi-k2.6` | `MOONSHOT_API_KEY` |
| GLM | `glm/glm-5.2` | `ZAI_API_KEY` |

在当前 pi provider 实现中，以上五个产品路径均可走 API key；Claude 的 pi provider
另有 OAuth login 实现。GPT/OpenAI API provider 不提供 OAuth，因此 hob-agent 不会把
它显示为可选认证方式。Claude OAuth 的 token 只存 SecretVault，pi 刷新或删除后仅将
`expiresAt`/`needs_auth` 写回 profile 状态与运行中选择器；完整用户流程仍在迁移中，不能
视为已可用的产品接入。

Provider 目录与协议兼容层由 `pi-ai` 管理；hob-agent 不自行模拟
OpenAI-compatible API，也不会在模型 prompt、审计日志或 `home/` 文件中写入
credential。

DSH 是唯一 Agent Runtime。标准 env API-key 路径使用官方
`@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.7`，由它转换 text/tool/reasoning/image、usage、
replay、取消和应用归因头；hob-agent 的 `mountDshPiHomeAgent` 只负责把产品 provider 名
映射到 pi route 并让 adapter 与 Home Agent 共用一个 Cordis 生命周期。自写的最小 stream
转换器已经移除，避免 tools 被静默丢弃。

## 选择与切换

- 添加或更新一个供应商的凭据，只会让它可用，不会自动替换正在使用的默认模型。
- 选择模型前应显示该 provider/model、可用性与一次小额真实请求的“测试连接”提示。
- 切换会话模型仅改变推理 provider；工具策略、审批与 HA 桥的权限边界不变。
- 模型不可用时，在同一安全等级的已配置 fallback 中显式重试；不得悄悄降级到未知
  provider 或把凭据交给第三方代理。

## 凭据与诊断

`createProviderModels` 可注入 pi 的 `CredentialStore`；这使选定 profile 的 credential
能进入 provider 解析，而不需要放进 agent prompt。未注入时，pi 仍按供应商标准环境
变量解析 API key。API-key profile 可引用显式 allowlist 的 `env:NAME`，或 macOS
`keychain:service/account`；其 locator/order 位于权限 `0600` 的本地配置，SQLite 只保存
非 secret 的状态与健康信息。

Claude OAuth 的 profile-scoped login、Keychain token store、本地 logout 和最小 live
probe 已有代码路径。OAuth agent 与 probe 必须注入 `PersistedAuthProfileCoordinator`（或
等价的 metadata writer），否则会被拒绝启动，防止 refresh 后状态失真；但在完成真实账户
授权/刷新/退出的集成验证及产品 UI 前，仍不能称为已完成的 OAuth 产品接入。外部 Claude
Code credential 只可按需发现，或经用户显式动作导入；被动状态读取不访问 Keychain。

当前官方 DSH adapter 的生产组合已真实调用 DeepSeek 成功；标准 env key 和选中的
API-key profile 都通过 env-shaped DSH alias 进入 credential seam，后者再按请求解析 hob
的 env/Keychain SecretRef，并遮蔽 ambient credential。Claude OAuth `CredentialStore`
仍需上游 adapter 支持可插拔 OAuth；不能因为 pi 基础件存在就声称它已进入 Home Agent。

本地 `.env` 和 `home/` 工作区都不是长期存放生产 credential 的位置。

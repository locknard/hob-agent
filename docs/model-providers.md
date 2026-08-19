# 模型供应商

模型引用在配置和会话中统一使用 `provider/model` 形式；当前产品名称与
DSH runtime route 的映射如下：

| 产品名称 | provider/model 示例 | 环境变量 |
| --- | --- | --- |
| GPT | `gpt/gpt-5.4` | `OPENAI_API_KEY` |
| Claude | `claude/claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| DeepSeek | `deepseek/deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| Kimi | `kimi/kimi-k2.6` | `MOONSHOT_API_KEY` |
| GLM | `glm/glm-5.2` | `ZAI_API_KEY` |

以上五个产品路径均通过 DSH credential seam 提供 API key。GPT/OpenAI API route 不提供
OAuth。Claude 保留 OAuth profile、SecretVault、刷新锁和 expiry metadata 基础件，但官方
DSH rc.7 adapter 没有交互式 login/logout contract；未安装未来的 provider-specific DSH
OAuth adapter 时默认 fail closed，不能视为已可用的产品接入。

Provider 目录与协议兼容层由官方 `dsh-llm-pi-ai` 插件管理。其内部 provider SDK 是
插件实现细节；hob-agent 不直接依赖或导入该 SDK，也不自行模拟 OpenAI-compatible API。

DSH 是唯一 Agent Runtime。标准 env API-key 路径使用官方
`@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.7`，由它转换 text/tool/reasoning/image、usage、
replay、取消和应用归因头；hob-agent 的 `mountDshHomeAgent` 只负责把产品 provider 名
映射到 DSH route 并让 adapter 与 Home Agent 共用一个 Cordis 生命周期。自写的最小 stream
转换器已经移除，避免 tools 被静默丢弃。

## 选择与切换

- 添加或更新一个供应商的凭据，只会让它可用，不会自动替换正在使用的默认模型。
- 选择模型前应显示该 provider/model、可用性与一次小额真实请求的“测试连接”提示。
- 切换会话模型仅改变推理 provider；工具策略、审批与 HA 桥的权限边界不变。
- 模型不可用时，在同一安全等级的已配置 fallback 中显式重试；不得悄悄降级到未知
  provider 或把凭据交给第三方代理。

## 凭据与诊断

正式启动入口会从 `HOB_DATA_DIR/auth-profiles.json` 加载该 provider 显式排序中的第一个
profile；存在有效选择时不读取相应的环境 API key，不存在选择时才兼容旧的环境变量路径。
在 macOS 上设置或轮换当前 `HOB_MODEL` 对应的 primary key：

```sh
pnpm credentials:model
```

该命令交互输入不回显，secret 通过 stdin 写入 Keychain；命令参数、JSON 配置和日志中都
不包含 key。选中的 API-key profile 通过 `DshProfileCredentialProvider` 将标准 credential alias 映射
到唯一 SecretRef，并在每次操作重新读取。底层 API-key profile contract 仍可表达显式
allowlist 的 `env:NAME`，但正式持久化选择只接受 macOS
`keychain:service/account`；环境变量只作为未配置 profile 时的兼容回退。locator/order 位于
权限 `0600` 的本地配置，SQLite 只保存非 secret 的状态与健康信息。

`pnpm credentials:test` 通过相同的 profile-scoped DSH runtime 发起一次最小付费请求，
立即销毁临时 Cordis fiber，只输出 model、归类后的 status 与 latency；不保存 prompt、
response 或 secret。

Claude OAuth 的 provider-neutral login/logout seam、Keychain token store 和生命周期元数据
已有代码路径。OAuth adapter 与 probe 必须注入 `PersistedAuthProfileCoordinator`（或
等价的 metadata writer），否则会被拒绝启动，防止 refresh 后状态失真；但在 DSH 提供并
完成真实账户授权/刷新/退出的 provider adapter 及产品 UI 前，仍不能称为已完成接入。外部 Claude
Code credential 只可按需发现，或经用户显式动作导入；被动状态读取不访问 Keychain。

当前官方 DSH adapter 的生产组合已真实调用 DeepSeek 成功；标准 env key 和选中的
API-key profile 都通过 env-shaped DSH alias 进入 credential seam，后者再按请求解析 hob
的 env/Keychain SecretRef，并遮蔽 ambient credential。Claude OAuth 仍需上游结构化
contract 与 provider adapter；不能因为本地生命周期基础件存在就声称它已进入 Home Agent。

本地 `.env` 和 `home/` 工作区都不是长期存放生产 credential 的位置。

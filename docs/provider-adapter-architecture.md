# Provider 接入架构

本项目借鉴 OpenClaw 的边界，而不是复制其代码：模型选择、认证、provider
协议适配、探测和 fallback 必须是独立层，不能散落在 agent 或 HA bridge 中。

## 统一引用

所有模型以 `provider/model` 表示，例如 `glm/glm-5.2`。一个会话的模型选择
只包含引用和可选的 profile ID；绝不包含 key、OAuth token 或 endpoint secret。

## Provider adapter

每个 adapter 必须声明：

- 模型目录与能力（文本/图片、工具调用、推理、上下文、最大输出）。
- 认证方式：`api_key`、`oauth`、`external_cli` 或 provider 特有流程。
- 凭据输入 UI、token 刷新、登出/撤销、最小 live probe 及错误分类。
- 供应商特有的协议转换和 tool schema 兼容处理。
- 可安全 fallback 的失败类别与冷却策略。

共享 agent loop 只接受 provider 已解析的模型和短生命周期请求凭据；不会自行猜测
endpoint、读取任意环境变量或修改 provider 的请求格式。

## Auth profile store

每个 profile 归属于一个 provider，包含不可显示的 credential material 和可显示的
元数据（类型、创建时间、过期时间、最后成功 probe、冷却状态）。支持：

- 多个 API key profile，按用户指定顺序尝试；只在限流时轮换。
- OAuth access/refresh token；刷新必须经单写者持久化，避免并发双刷新。
- 外部 CLI profile；仅在用户选择对应 provider/runtime 时发现，状态页不得触发
  Keychain 弹窗。
- Secret reference；静态 key 可引用安全存储，OAuth 可变 token 不能分裂保存。

profile 的解析顺序是显式配置。被排除的 profile 不得在失败后偷偷尝试。认证、账单、
限流、超时、格式和未知错误必须分开报告。

## 用户流程

1. **添加供应商**：显示该 provider 支持的 API key / OAuth / CLI 方法及数据去向。
2. **授权**：写入 profile store；添加认证绝不自动替换正在使用的模型。
3. **测试连接**：提示会产生一笔最小模型请求；只显示分类结果、延迟与模型可用性。
4. **选择模型**：从已授权 provider 的目录中选择 `provider/model`，再明确设为主模型
   或 fallback；不能因新认证而静默变更。
5. **健康与恢复**：显示过期、限流冷却、账单或失效；用户可重试、重新授权、登出或
   删除 profile。

## 分阶段交付

1. `ProviderAdapter`、`AuthProfile`、SecretStore、模型路由及不泄密的 probe 结果。
2. API-key profile、显式顺序、限流轮换、健康状态；GPT/Claude/DeepSeek/Kimi/GLM。
3. OAuth adapter 生命周期（授权 URL、PKCE/state、回调、刷新、撤销）及供应商实现。
4. 外部 CLI adapter、profile cooldown、fallback 与控制台 UI。

只有第 2 阶段完成后，才可宣称 API-key provider 已“接入”；只有某个 OAuth adapter
真实拥有并测试授权、刷新和撤销后，才可将该 provider 的 OAuth 标记为已接入。

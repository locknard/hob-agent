# DSH OAuth seam migration report

状态：产品边界迁移完成；真实 provider OAuth adapter 仍未接入。

## 结论

DSH `0.1.0-rc.7` 的官方接口目前不能直接承载交互式 OAuth：

- `@deepseek-ai/dsh-credentials` 的公开 contract 是 credential reference 的
  `resolve`、`describe`、`set`、`unset`，不定义 login、callback、refresh 或 logout；
- `@deepseek-ai/dsh-llm-pi-ai` README 的 “Known Limitations and Deferred Work” 明确说明：
  OAuth-only provider 依赖已存储的 OAuth credential，而该 adapter 不持有 OAuth
  credential store，也不运行 login flow。

因此没有把 OAuth token 塞进 `apiKeyEnv`，也没有在 DSH 旁边保留第二个 Agent Runtime。
本次采用最小的 DSH-owned/provider-neutral OAuth seam，等待上游提供结构化 OAuth
contract 后再接入具体 provider。

## Seam 设计

[`dsh-oauth-seam.ts`](../packages/agent-layer/src/dsh-oauth-seam.ts) 定义：

- `DshOAuthInteraction`：text/secret/select/manual-code prompt，以及 info/auth-url/
  device-code/progress event；
- `DshOAuthCredential`：canonical `access`、`refresh`、`expires` OAuth value；
- `DshOAuthProvider`：以 DSH runtime route、profile id 和 interaction 执行 login/logout；
- 默认 provider fail closed，未安装真实 OAuth adapter 时不会假装已经支持登录。

provider adapter 不接触 SecretVault。产品边界负责：

- 受保护的 profile-scoped SecretVault 写入/删除；
- 既有 `(provider, profileId)` 跨进程 OAuth lock；
- login 前的 `needs_auth`、成功后的 expiry metadata、logout 前的不可用标记；
- 对外稳定错误，绝不返回 provider/token 原文。

DSH runtime route 使用 `ProviderSetup.runtimeProviderId`（例如 `claude →
anthropic`）；锁身份仍使用产品 profile identity，避免把 provider route 和 profile
生命周期混为一谈。

## 变更范围

- `oauth-profile-login.ts`、`oauth-profile-logout.ts`、`oauth-profile-lifecycle.ts` 不再
  直接 import `@earendil-works/pi-ai`；
- 相关测试改为验证 DSH seam、SecretVault 写回、错误隔离和无 pi-ai 直接依赖；
- hob-agent manifest 已删除显式 `pi-ai` 依赖；它只由官方 DSH adapter 传递引入。

## 验证

迁移目标与全仓验收由仓库标准命令覆盖：

```text
pnpm test
pnpm check
```

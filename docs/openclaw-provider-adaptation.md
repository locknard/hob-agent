# OpenClaw provider subsystem：迁移验收矩阵

来源仓库：`openclaw/openclaw`，审阅版本 `f72782d8`。借鉴限于机制、接口形状
与测试语义；本项目不复制其 Gateway、聊天通道或控制台实现。

## 当前产品可用性（不要把基础件等同于已接入）

| 用户选择 | 当前状态 | 精确边界 |
| --- | --- | --- |
| 五个 provider 的标准 API key 环境变量 | 通过 DSH credential seam 与官方 adapter 使用；2026-08-18 已真实探测 DeepSeek `deepseek-v4-flash` | API key 不会进入 prompt、状态列表或 SQLite；仍缺设置界面。 |
| 标准 env API key → DSH Home Agent | 官方 `dsh-llm-pi-ai` 拥有 DSH LLM seam，并映射 GPT/Claude/DeepSeek/Kimi/GLM runtime route | 已真实验证 DeepSeek；设置 UI 和跨平台安全存储仍未完成。 |
| 选中的 API-key profile → DSH Home Agent | read-only DSH credential provider 将标准 alias 映射到唯一 SecretRef，每次请求重新读取且遮蔽 ambient env | allowlist env 与 macOS Keychain 均可用；`describe` 按 DSH contract 检查凭据当前是否可解析，因此可能访问 Keychain。跨平台加密后端与设置 UI 未完成。 |
| Claude OAuth | hob-agent 保留 profile-scoped PKCE、token 规范化、跨进程刷新锁、Keychain 与 non-secret expiry 同步，并迁入 DSH-owned OAuth seam | 官方 DSH rc.7 不提供交互式 OAuth adapter；默认 fail closed，故**不可标为产品已接入**。 |
| GPT/OpenAI API OAuth | 不支持 | 当前选择的是官方 DSH `openai` provider route，其真实认证方式为 API key；不会伪造 OAuth 选项。 |
| 外部 Claude/Codex CLI 凭据 | Claude Code 有文件 reader、按需发现、显式 OAuth 导入和仅在导入许可时读取 Keychain；被动发现不触碰 Keychain | Codex reader 不迁移（见下方理由）；还缺外部 CLI runtime。 |

## 已适配（有代码与测试）

| OpenClaw 机制 | hob-agent 适配 | 证据 |
| --- | --- | --- |
| 统一 provider/model 模型目录 | 统一 provider registry：GPT、Claude、DeepSeek、Kimi、GLM | `model-providers.ts`、`model-providers.test.ts` |
| canonical model reference | 只接受受支持 provider 的精确 `provider/model`，拒绝别名、空白与多段引用 | `model-reference.ts`、测试 |
| provider 目录与认证映射解耦 | `ProviderSetup` 仅保存 provider id 和 env 名称，绝不含 key | `model-providers.ts` |
| auth profile 联合类型 | API key、token、OAuth、external CLI profile 类型 | `auth-profiles.ts` |
| 显式 profile 顺序 | 指定 order 后不尝试被排除 profile | `auth-profiles.test.ts` |
| OAuth 过期语义 | 过期 profile 不参与候选链并显示 `expired` | `auth-profiles.test.ts` |
| cooldown / auto-expiry | 瞬态失败的 profile 排后，过期 cooldown 自动清除 | `auth-profiles.test.ts` |
| runtime profile rehydration | 私有 locator 配置 + SQLite non-secret state 重建 profile 选择；启动路径不读取 credential | `auth-profile-runtime-loader.ts`、测试 |
| profile metadata repository | locator 配置与 SQLite public state 通过单一 repository 写入，保持 secret locator 不进入状态库 | `auth-profile-metadata-repository.ts`、测试 |
| runtime metadata writer | durable config/SQLite 成功后才更新运行中 selector；OAuth expiry、顺序和删除在重启前后语义一致 | `auth-profile-runtime-metadata.ts`、测试 |
| profile removal / order cleanup | 删除 profile 时同时清除 config、SQLite health、运行中 selector 与全部显式顺序引用 | `auth-profile-config-store.ts`、`auth-profile-state-store.ts`、`persisted-auth-profile-coordinator.ts`、测试 |
| scoped credential disconnect | 先将 profile 从可选链解除，再精确删除其 SecretVault locator；清理失败不恢复 profile，返回可重试的无敏感提示 | `auth-profile-disconnect.ts`、测试 |
| 稳定失败分类 | auth、billing、rate-limit、timeout、overloaded、format 分类 | `provider-failover.ts`、测试 |
| 限流轮换纪律 | 仅 rate-limit / overload / timeout 可尝试下一 profile | `provider-failover.ts` |
| profile failover runner | 显式 profile 顺序执行；仅短暂失败轮换并持久写入冷却状态 | `profile-failover-runner.ts`、测试 |
| profile health observation | 成功清除 cooldown/连续失败计数并记录 last-success；只持久化 credential-scoped auth/billing/rate-limit，provider-wide overload/timeout/format/unknown 不污染 profile | state store、coordinator、runner 测试 |
| safe failover error boundary | 最终只返回 provider/profile/reason 的稳定错误，绝不透传供应商原文 | `profile-failover-runner.ts`、测试 |
| DSH credential seam | 选定 profile 通过 SecretVault 按操作解析为 DSH `CredentialProvider`；`describe` 会解析凭据以准确报告当前可用性。被动的 profile 状态查询仍走独立 availability seam，不读取 secret | `dsh-profile-credential-provider.ts`、`auth-profile-secret-availability.ts`、`secret-vault.ts`、测试 |
| provider runtime credential injection | 官方 adapter 从 `ctx.credentials` 解析 env-shaped alias；产品代码不接触 provider SDK credential store | `home/home-agent-composition.ts`、测试 |
| official DSH pi-ai adapter | 使用 DSH 官方 rc.7 adapter 处理 tools/reasoning/images/replay/usage/attribution/cancellation；hob 只保留产品名映射与组合生命周期，不维护第二套转换器 | `home/home-agent-composition.ts`、兼容集与组合测试 |
| profile → DSH credential seam | 选中的 API-key profile 通过只读 alias→SecretRef provider 按请求解析；不缓存、不枚举、不向未映射 provider 泄露 | `dsh-profile-credential-provider.ts`、组合测试 |
| selected profile → provider runtime | 选中的 API-key profile 仅映射到其对应的 DSH route，不可越权供给其他 provider | `home/home-agent-composition.ts`、`dsh-profile-credential-provider.ts`、测试 |
| OS Keychain SecretVault | macOS `keychain:service/account` 精确读写；写入经 stdin 而非子进程参数，不枚举钥匙串且 SQLite 不存 secret | `macos-keychain-secret-vault.ts`、测试 |
| API-key profile provisioning | 先写 secret 再写元数据；元数据失败时恢复旧 secret 或删除新项，避免遗留或丢失凭据 | `api-key-profile-provisioner.ts`、测试 |
| turn-local fallback | 显式模型候选链，成功 fallback 不改 session 的 selected model | `model-fallback.ts`、测试 |
| OAuth PKCE/state | 通用 authorization-code + PKCE 授权 URL 与 callback state 校验 | `oauth-pkce.ts`、测试 |
| OAuth token 生命周期 | token 响应规范化、5 分钟刷新余量、拒绝较旧刷新结果覆盖 | `oauth-credentials.ts`、测试 |
| OAuth refresh serialization | store 内串行修改；默认文件锁按 `(provider, profileId)` 跨进程序列化 `modify/delete`，具备 expiry double-check、`0600`、hard timeout、stale recovery 与稳定脱敏错误 | `oauth-profile-credential-store.ts`、`oauth-refresh-lock.ts`、测试 |
| OAuth credential persistence | selected OAuth token JSON 只存 SecretVault；文件锁内重新读取并执行 expiry double-check，两个 store 实例不会用旧 refresh token 覆盖新值；仅向状态层传递 `expiresAt` / 删除标记 | `oauth-profile-credential-store.ts`、测试 |
| DSH-owned OAuth login seam | provider-specific adapter 负责 callback/device mechanics；hob 边界持久化 token、使用 profile lock 并脱敏错误；缺 adapter 时 fail closed | `dsh-oauth-seam.ts`、`oauth-profile-login.ts`、测试 |
| DSH-owned OAuth local logout | provider-specific adapter 可撤销当前 credential，成功后才删除本地 token；缺 adapter 时不删除 | `oauth-profile-logout.ts`、测试 |
| OAuth lifecycle metadata | login 前标为 `needs_auth`，成功写入 expires；logout 先标不可用再删除 local token；refresh/import 只同步 non-secret metadata | `oauth-profile-lifecycle.ts`、`persisted-auth-profile-coordinator.ts`、测试 |
| external OAuth bootstrap guard | 健康的本地 OAuth 始终优先；过期时仅接受 provider 与明确账户身份都一致的外部凭据 | `oauth-bootstrap.ts`、测试 |
| provider adapter registry | provider 逐项声明 API key / OAuth / external CLI 能力；Claude OAuth 明确标记为 `dsh_adapter_required` | `provider-adapters.ts`、测试 |
| explicit live probe | 显式、最小的连接 probe；只保留延迟与分类结果，不存响应/密钥 | `provider-probe.ts`、测试 |
| DSH live probe executor | 仅显式调用时经 `LlmRuntime.stream()` 发送 `OK` 最小请求；响应立即丢弃，只返回模型/延迟/分类 | `provider-live-probe.ts`、测试 |
| bounded profile live probe | API key/OAuth profile 只向自身 provider 发起请求；同 profile 并发合并、30 秒 throttle、10 秒 hard timeout、父级取消和 cooldown margin 均已实现 | `profile-live-probe.ts`、`provider-probe-policy.ts`、测试 |
| structured SecretRef / passive availability | 只接受 `env:NAME` 与 `keychain:service/account`；env 必须 allowlist，返回 available/missing/blocked，Keychain 被动检查只返回 unknown 且不触发读取 | `secret-ref.ts`、env/Keychain vault 与测试 |
| credential-aware selection | 无 locator 或被动状态为 missing/blocked 的 profile 不参与选择并显示 needs-auth；Keychain unknown 不因状态渲染触发读取 | `auth-profile-secret-availability.ts`、`auth-profiles.ts`、测试 |
| secret-free diagnostics | ready/cooldown/expired/disabled/needs-auth 映射到 none/wait/reauthorize/fix-billing，输出不含 locator、token 或 raw error | `auth-profile-diagnostics.ts`、测试 |
| scoped external-CLI discovery | 仅发现用户明确选择、且声明 external CLI 能力的 provider；发现过程禁止 Keychain 弹窗 | `external-cli-discovery.ts`、测试 |
| Claude Code file credential reader | 仅解析 `~/.claude/.credentials.json` 的完整 OAuth 条目；被动读取不访问 Keychain | `claude-cli-credential-reader.ts`、测试 |
| Claude Code external profile adapter | 仅 Claude 被明确请求且文件 credential 未过期时返回非 secret external profile 元数据 | `claude-cli-external-discoverer.ts`、测试 |
| Claude Code explicit OAuth import | 仅显式调用时写入本地 OAuth profile；拒绝覆盖健康的本地 credential，返回值不含 token | `claude-cli-oauth-import.ts`、测试 |
| Claude Code Keychain reader | 仅显式 import 流程且用户许可 prompt 时读取固定 service；被动发现不会调用 | `claude-cli-keychain-reader.ts`、测试 |

## 正在迁移（设计已定，尚无可声称的用户能力）

| OpenClaw 机制 | 目标适配 | 尚缺内容 |
| --- | --- | --- |
| 持久 auth profile store | 私有 profile 配置存 locator/order（同进程串行与跨进程 lockfile、版本 fail-closed），SQLite 存元数据/state，密钥与状态分表 | config store + state store + coordinator 已让启动恢复 profile、顺序/冷却；未来新增 schema 时仍需提供显式迁移 |
| SecretRef | API key 指向系统安全存储或受控 env | canonical grammar、passive tri-state、env allowlist、macOS Keychain 与 scoped disconnect 已落地；仍缺跨平台 encrypted 后端、写入/清理重试 UI、密钥轮换 |
| live provider probe | DSH live probe executor、throttle/timeout/cancellation 已落地，调用方只能获得模型/延迟/分类 | 产品 UI 的成本提示与用户确认 |
| fallback chain | profile failover 与 turn-local model fallback 基础件均已落地，且不改会话选中模型 | agent turn runner 集成、fallback 配置与审计 |
| OAuth profile lifecycle | provider-neutral DSH seam、token 规范化、跨进程 refresh lock、安全写回、本地 logout 与 expiry metadata 已落地 | 上游/专用 DSH OAuth adapter、产品 UI、供应商 revoke、错误分型与真实集成测试 |
| OAuth profile → DSH LLM seam | API-key env/Keychain profile 已由官方 adapter 接入，DSH 继续独占 Agent loop | 官方 adapter 当前 credential contract 仅为 API key；需上游可插拔 OAuth CredentialStore，不能把 OAuth token 伪装成 API key |
| external CLI profile | Claude Code 文件 reader、按需发现与显式 OAuth 导入已落地，状态页不触发 Keychain | external CLI runtime、持久化 UI 与用户授权流程；Codex adapter 为明确不迁移项 |
| profile 健康 | last-good、连续失败计数、cooldown、auth/billing stable failure 的持久禁用与 secret-free diagnostics 已落地 | 诊断命令/UI 与 provider-specific repair hint |

## 仍未完成的通用机制

以下项目不能因已有接口或 mock 测试而标为完成：

- 把 profile/fallback runner 接到真实 DSH agent turn，并在产生部分输出后禁止重放。
- config JSON 与 SQLite 双存储更新的 journal/补偿事务；当前 repository 仍可能在第二步失败时留下半完成状态。
- schema migration ledger、旧版本备份与 secret-free doctor/repair。
- Claude OAuth 的真实授权、token refresh、invalid-grant/revoked 分类、登出与供应商端 revoke 验证。
- Claude Code external credential 的受控 DSH provider runtime；当前只有发现与显式导入。
- 产品设置页、成本确认、profile 排序、诊断/恢复、轮换与删除重试流程。

## 真实接入证据

- 2026-08-18：通过生产路径 `DSH LlmRuntime → 官方 dsh-llm-pi-ai → DeepSeek`
  对 `deepseek/deepseek-v4-flash` 发起 `maxTokens: 1` 的显式最小请求，返回
  `finish: stop`（约 661 ms）。响应内容被丢弃，临时 credential 未写入
  仓库、配置、Keychain、SQLite 或命令参数。
- 局域网 `homeassistant.local:8123` 已解析并返回 HTTP 200；WebSocket `/api/websocket`
  握手返回 `auth_required`，HA 版本为 `2026.6.4`。本次未发送 token，因此只能标为
  “实例与桥协议可达”，不能声称 registry/state bootstrap 已完成。

## 明确不迁移（附理由）

| OpenClaw 功能 | 理由 |
| --- | --- |
| Gateway 与聊天通道账户认证 | hob-agent Phase 0 不提供远程 Gateway 或 IM 通道；HA bridge 有独立的最小权限认证边界。 |
| 多 agent 的 profile 复制/继承 | 当前为单家庭、单 agent；复制 OAuth refresh token 会增加泄露与轮换竞争风险。未来多 agent 时仅做只读继承。 |
| 跨 agent 的 OAuth shared-store / identity mirroring | 当前没有多个 agent home 或账号共享边界；在该边界未设计前复制 refresh token 会产生账户错配和并发刷新风险。 |
| session override / user-pinned auth profile | Phase 0 尚无持久会话模型选择或多用户会话；先由显式 profile/model 配置决定，避免隐式 session fallback。 |
| 环境变量、配置命令、遗留文件的全量 ambient credential 扫描 | hob-agent 只允许显式 allowlist env ref、Keychain ref 或用户选择的 Claude CLI source；任意扫描会破坏用户对凭据来源的知情权。 |
| plugin-provided external auth | Phase 0 不加载第三方 provider 插件；在插件签名、权限与 secret ownership 没有治理前，不允许插件提供 credential reader。 |
| Codex/Claude CLI 作为完整 agent runtime | DSH 是唯一 Agent Runtime；外部 CLI 可作为 credential source，不能替代受治理的 hub 工具面。 |
| Codex CLI OAuth credential adapter | 当前 GPT 路径是 pi `openai` API-key provider；Codex OAuth 属于 pi 独立 `openai-codex` provider。未经单独模型/协议适配就导入会把订阅 token 用在错误认证路径，因此不迁移。 |
| OpenClaw 控制台与插件市场 UI | Phase 0 的用户表面是 HA bootstrap 与提案收件箱；直接引入会扩大攻击面且偏离产品。 |
| 供应商的使用量/订阅抓取 | 不是连接与治理必需条件，且通常需特定账户权限；仅在 provider adapter 有安全 API 后按需加入。 |

## 验收规则

在本表“正在迁移”的项目具备代码、测试与可运行用户流程前，不能在 README、UI 或
发布说明中声称其已接入。尤其是 OAuth：必须真实验证授权、刷新、过期与登出/撤销，
才能标记为完成。

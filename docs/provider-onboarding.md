# 模型供应商接入流程

目标是让用户始终知道：正在授权哪个 provider、凭据会去哪里、测试会产生什么成本，
以及该变化不会自动改变家庭 agent 当前使用的模型。

## 1. 选择 provider 与模型用途

先选择 GPT、Claude、DeepSeek、Kimi 或 GLM，再选择“主模型”或“fallback”。界面在此
阶段只展示模型目录、能力、区域/价格链接和当前支持的认证方式；不能因发现本机环境变量
或 CLI 登录而自动切换模型。

## 2. 选择认证方式

- **API key**：显示该 provider 的变量名或安全存储位置；输入框永远不回显、日志不记录。
- **OAuth**：先显示 provider、授权页面、预期账户和将保存的数据类型（access/refresh
  token）；只有该 provider 的完整回调、刷新和登出能力都实现后才显示为可用。
- **外部 CLI**：仅当用户明确选择相应 provider 时发现，默认不触发 Keychain 弹窗；必须
  明确说明是“使用本机 CLI 登录态”而不是把 token 静默复制到家庭数据目录。

当前真实状态以 [OpenClaw 迁移验收矩阵](openclaw-provider-adaptation.md) 的“当前产品
可用性”为准：五个 provider 支持 API key；Claude OAuth 与外部 CLI 仍是基础件，不可在
产品界面标作已完成。

认证卡片必须展示四个彼此独立的状态，不能合并成一个含糊的“已连接”：

| 状态 | 含义 | 可用动作 |
| --- | --- | --- |
| 未配置 | 没有 locator，或 allowlist env 不存在 | 添加 API key / 开始授权 |
| 已配置、未验证 | locator 可用或 Keychain 被动状态为 unknown，但尚未发送真实请求 | 测试连接、删除 |
| 可用 | 最近一次显式测试成功，且不在 cooldown/expired/disabled | 设为主模型或 fallback |
| 需处理 | missing、blocked、expired、auth/billing disabled | 修复来源、重新授权、处理账单 |

## 3. 保存为 profile，不改变会话

保存后创建一个具名 profile（例如 `gpt:primary`），并让用户设置其顺序。profile 元数据、
顺序和冷却状态可保存；secret material 必须留在安全存储或明确 allowlist 的环境变量中。
保存凭据不会自动把当前会话切换到新模型。

## 4. 明确同意后测试连接

按钮文案为“测试连接（将发起一次最小模型请求）”。结果仅显示：模型、耗时和分类状态
（成功、认证、限流、计费、超时、过载、格式或未知）；不得显示响应内容、HTTP 原文或
credential。

测试必须有 10 秒 hard timeout、同一 profile 30 秒 throttle，并合并重复点击产生的并发
请求。cooldown 距离结束较远时不发测试请求。2026-08-18 的 DeepSeek 实测已经验证这条
路径可返回 `model/status/latency`，但这不等于设置 UI 已完成。

## 5. 选择主模型与 fallback

测试成功后，用户显式设定 `provider/model` 主模型和同安全等级的 fallback 顺序。单次
fallback 成功不会篡改会话的选中模型。profile 轮换只允许在限流、过载和超时后发生；认证
或计费失败必须停止并要求用户处理。

## 6. 健康与恢复

状态页展示 ready、cooldown、expired 或需重新授权，并提供“重试测试”“调整顺序”与未来
的“重新授权/登出”。状态页是被动读取：不得扫描未选择的 CLI、读取任意环境变量，或因
渲染而唤起 Keychain。

删除采用两段式语义：先让 profile 从选择器和顺序中不可达，再删除精确 SecretRef 指向的
credential。后一步失败时不恢复 profile，只展示可重试的“清理本地凭据”，避免一个半删除
profile 又被 agent 选中。

## 接入事务与页面恢复

页面刷新或应用重启后，根据持久状态恢复到以下检查点，而不是要求用户重新粘贴 secret：

1. provider 与认证方式已选；
2. secret 已安全写入、metadata 尚未完成；
3. profile 已保存、尚未测试；
4. 测试成功、尚未选择主模型/fallback；
5. 已启用。

当前 API-key provisioning 已实现 secret 写入失败回滚与 metadata 失败补偿；跨 config JSON
和 SQLite 的通用 journal/repair 尚未实现，因此产品 UI 在该能力完成前不能声称所有中断都
可自动恢复。

## 完成门槛

一个认证方式只有在真实用户流程、秘密存储、失败恢复和集成测试全部完成后才可称为“已
接入”。通用接口、mock 测试或 provider library 的潜在能力均不足以通过该门槛。

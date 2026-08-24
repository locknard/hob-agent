# 迁移产品浏览器 Fixture

`pnpm dev:migration-fixture` 启动一个只用于产品验收的本地 HTTP fixture。它复用生产 `ProposalInboxHttpService` 和 Product Shell renderer，只创建一个 Cordis `Context` 与一个最小 `homeInbox` projection owner；它不启动 Home Assistant、Bridge、模型、Agent、Hub runtime 或迁移状态机。

服务只绑定 `127.0.0.1`，默认监听 `4173`。启动时必须显式提供本地 Basic Auth 密码；端口可以显式指定：

```bash
HOB_MIGRATION_FIXTURE_TOKEN='use-a-local-token-with-at-least-32-characters' \
  pnpm dev:migration-fixture -- --port 4173
```

进程只输出 loopback origin，不输出认证密码、selection token、native rule identity 或 source fingerprint。缺少 `HOB_MIGRATION_FIXTURE_TOKEN` 时，进程会在打开 listener 之前失败。浏览器打开 `http://127.0.0.1:4173/automations`，Basic Auth 用户名为 `home`，密码使用启动时的 `HOB_MIGRATION_FIXTURE_TOKEN`。

页面固定提供以下验收状态：

- 迁移候选：`selectable`、`prepared`、`unavailable`
- 已安装自动化：`active`、`recovery_required`、`enable_failed`

选择一条 `selectable` 候选会走真实 `/automations/migration/prepare` HTTP 入口，并在内存 projection 中转为 `prepared`；该动作不会触碰设备或持久化家庭数据。`recovery_required`、暂停/恢复/关闭和失败重试按钮同样只改变 fixture 内存状态。

验收至少检查 390×844 和 1440×900 两个 viewport，并确认浏览器 console 没有错误。按 Ctrl-C 或发送 SIGTERM 会正常释放 HTTP listener 和 Cordis context。

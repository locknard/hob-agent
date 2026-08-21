# Frontend Layout Extensions

Status: proposed
Date: 2026-08-21

## Decision

hob-agent 支持多个可切换的家庭视图。首批内置两个同等级的 View Provider：

- **生活视图（Life View）**：以家庭成员、空间、当前情况和意图为中心，采用克制、连续、
  接近 Apple 产品逻辑的体验；它是新家庭的默认视图。
- **控制视图（Control View）**：以仪表盘、实时指标、历史趋势、设备状态和快捷按钮为中心，
  满足熟悉 Home Assistant Lovelace、需要高信息密度和精细控制的用户。

两者不是两套产品，也不拥有两套家庭逻辑。它们消费同一个中立 presentation model，
提交同一种 typed intent，经过同一套 Hub policy、approval、execution 和 audit。用户可以在
任何时候切换；活跃 Agent Turn、空间上下文、运行时确认、持久提案和家庭连接状态不能因切换
而丢失。运行时确认与持久提案是两套生命周期，不得被 Provider 合并成一个 `reviews` 队列。

未来第三方 Plugin 可以贡献新的布局。为了同时满足开放性和家庭安全，布局贡献分为两级：

1. **声明式 Layout Recipe**：使用版本化 schema 组合 Host 提供的页面、卡片、查询和动作
   intent；适合绝大多数 Dashboard、空间视图和主题化体验。
2. **隔离 View Application**：允许真正自定义交互代码，但只能在独立 origin 的 sandbox
   容器中运行，通过版本化 broker 接收有界数据并提交 intent。它不能访问 Host DOM、cookie、
   credential、原始 bridge payload、任意网络或设备 executor。

当前 Phase 0 只冻结契约和交互原型，不装载第三方 UI。两个内置 View Provider 可以先作为
仓库内 T0 代码使用同一契约注册；这不等于提前开放插件市场。

## Why two first-party views

生活视图和控制视图服务的是两种都合理、且经常出现在同一个家庭里的使用方式：

| 维度 | 生活视图 | 控制视图 |
| --- | --- | --- |
| 首要问题 | “家里现在有什么值得我注意？” | “所有设备和数据现在分别是什么状态？” |
| 信息密度 | 低到中；按当前情境逐步展开 | 中到高；并列展示指标、趋势和操作 |
| 主要输入 | 文字、语音、空间和建议 | 卡片、图表、筛选器、快捷动作 |
| 典型用户 | 普通家庭成员、移动端、快速使用 | 管理者、爱好者、墙面屏、诊断和精细控制 |
| 共同安全边界 | 建议、动作、持久行为分级 | 同一分级；按钮不获得额外权限 |

“默认生活视图”是 onboarding 的产品选择，不是永久锁定。每个成员可以有自己的默认视图，
也可以按设备类型保存偏好，例如手机默认生活视图、墙面平板默认控制视图。

## Reference projects

### Backstage: extension tree and replaceable app structure

Backstage 的新前端系统把页面、导航、API 和其他插件内容都建模为 extension；页面可以从
插件自动进入导航，`NavContent` 甚至可以替换整个导航组件。它最值得借鉴的是“Host 组装
扩展树”，而不是让插件互相直接 import。

- <https://backstage.io/docs/frontend-system/architecture/plugins/>
- <https://backstage.io/docs/frontend-system/building-plugins/common-extension-blueprints/>

**采用：**稳定 extension ID、typed input/output、Host 组装、可覆盖但可验证的扩展树。
**不采用：**把家庭关键治理也做成可被前端覆盖的普通 extension。

### Grafana: app plugins, extension points, add/expose split

Grafana App Plugin 可以提供完整自定义页面、导航和 Scenes，并将 UI 能力分成向已知插槽
`add` 与供其他插件选择性使用的 `expose`。这证明 Dashboard 和完整 App 可以存在于同一个
扩展生态中。

- <https://grafana.com/developers/plugin-tools/key-concepts/plugin-types-usage>
- <https://grafana.com/developers/plugin-tools/how-to-guides/ui-extensions/ui-extensions-concepts>

**采用：**布局、卡片、操作入口是不同 contribution kind；extension point 独立版本化。
**不采用：**让第三方页面天然继承宿主全部前端权限。

### Kibana: full application mount lifecycle

Kibana 插件可以注册完整 application，并以 lazy mount/unmount 生命周期进入同一个 SPA。

- <https://www.elastic.co/docs/extend/kibana/tutorials/registering-an-application>

**采用：**显式加载、挂载、卸载和清理；布局失败不能污染 Host Shell。
**不采用：**任意 UI library 在相同 DOM/权限上下文直接运行的默认信任模型。

### JupyterLab: multiple shell modes and layout restoration

JupyterLab 同时提供 simple/single-document 和 multiple-document 两种布局模式，extension
可以向 shell 加入 widget，并由 layout restorer 恢复用户工作区。

- <https://jupyterlab.readthedocs.io/en/stable/user/interface_customization.html>
- <https://jupyterlab.readthedocs.io/en/stable/extension/extension_tutorial.html>

**采用：**模式切换与内容状态分离、per-user layout state、崩溃/重载后恢复。
**不采用：**面向 IDE 的自由停靠窗口作为普通家庭成员的默认交互。

### Home Assistant: custom cards and full-page panels

Home Assistant 已证明社区愿意开发自定义卡片和整页 Panel；Panel 可以使用任意框架，Custom
Card 也能声明编辑器和网格尺寸。

- <https://developers.home-assistant.io/docs/frontend/custom-ui/creating-custom-panels/>
- <https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/>

**采用：**布局与卡片都应是生态对象，并配套可视化配置。
**不采用：**把完整 `hass` 对象和实时服务调用能力直接交给任意前端扩展。hob-agent 只提供
scope-filtered neutral presentation data 和 governed intent broker。

## Host and provider boundary

```text
Stable Host Shell
├── identity / tenant / onboarding
├── view switcher and safe fallback
├── active-turn and runtime-confirmation continuity
├── persistent-proposal continuity
├── cross-view safety alerts
├── accessibility, locale and responsive context
├── Presentation Broker
│   ├── neutral snapshots and subscriptions
│   └── freshness / partial / unknown semantics
└── Intent Broker
    ├── navigation and harmless UI preference intents
    ├── Agent turn intents
    ├── proposal / review intents
    └── governed device intents -> Hub policy / approval / audit

View Registry
├── builtin.life
├── builtin.control
└── plugin-provided providers
    ├── declarative recipe
    └── isolated view application (future)
```

### Host Shell always owns

- 当前家庭/成员身份、认证、onboarding 与退出；
- View switcher、插件失效后的安全回退和“恢复默认布局”；
- 全局 active Turn、`等待你放行` 数量与 TTL、`给家的建议` 独立 `n/5` 容量与自然过期；
- 漏水、烟雾、燃气与 policy 判定门锁风险等安全级异常；
- intent 的校验、policy、approval 和 audit 入口；
- accessibility 基线、语言、主题 token 和响应式环境；
- 插件安装、权限、更新、隔离、禁用和诊断。

布局插件不能隐藏或替换这些逃生路径。它可以设计自己的局部导航，但 Host 必须始终提供一个
可访问的布局切换/恢复入口。

安全级异常是 Host Shell 的强制穿透层。Provider 不得隐藏、snooze、降级、延迟订阅或把它排在
普通关注点之后；第三方布局必须为 Host 横幅保留可见空间。`acknowledged` 只表示有人看到，
告警只在 Hub 证实危险解除或进入明确处置状态后消失。

### Cordis owns package lifecycle, not browser authority

Cordis 可以管理 Plugin generation 的 install/enable/disable/dispose 生命周期，并让后端注册
经过验证的 UI contribution metadata。实际浏览器布局由 Host 的 View Registry 挂载，不把
React component、DOM 或浏览器 credential 放入 Cordis Context。后端 Plugin 被禁用或撤销时，
Host 收到 provider generation 失效事件，停止新 intent、切回安全布局并卸载对应前端资源。

因此“一份 Plugin 包同时贡献 Skill、bridge 和布局”只表示分发单元相同；每种 contribution
仍有独立 schema、grant、runtime 和撤销路径，UI 不能继承该包其他 contribution 的权限。

### View Provider receives

- `HomePresentationSnapshot`：空间、能力、状态、freshness、数据质量和有界历史序列；
- `TurnProjection`：问题、产品级进度、回答、恢复标识；
- `RuntimeConfirmationProjection`：允许当前用户看到的精确动作、eligible roles、TTL 与状态；
- `ProposalProjection`：允许当前用户看到的持久提案、dedup latch、snooze 和自然过期；
- `SafetyAlertProjection`：Host 已分级的安全异常、来源、新鲜度、处置和 resolved 状态；
- `ViewEnvironment`：viewport class、locale、color scheme、motion/transparency/contrast 偏好；
- `ViewPreferences`：当前 provider 的版本化、per-user/per-device 配置。

所有对象都是只读投影。Provider 不接收 Bridge、Cordis Context、DSH session internals、
credential、raw event、模型私有推理或 executor handle。

### View Provider emits

Provider 只能发送版本化 `ViewIntent`：

- `navigate`
- `set-view-preference`
- `start-agent-turn` / `cancel-agent-turn`
- `prepare-action`
- `submit-review-decision`
- `submit-runtime-confirmation-decision`
- `snooze-proposal` / `reject-proposal`
- `request-governed-action`

Host 根据当前用户、tenant、snapshot revision、目标 capability、policy 和 approval 重新验证。
“按钮来自受信布局”也不能跳过这一步。

## Provider contract sketch

这只是用于冻结边界的 TypeScript 草案，不是 Phase 0 的可执行 loader：

```ts
type ViewProviderManifest = {
  apiVersion: "1";
  id: string;
  title: string;
  kind: "life" | "control" | "custom";
  routes: readonly ViewRouteDeclaration[];
  renderer:
    | { kind: "builtin"; entrypoint: string }
    | { kind: "declarative"; recipe: string; schemaVersion: "1" }
    | { kind: "isolated-app"; entrypoint: string; protocolVersion: "1" };
  settingsSchema?: JsonSchemaReference;
  requestedData: readonly PresentationCapability[];
  requestedIntents: readonly ViewIntentKind[];
  compatibility: { hostViewApi: "1" };
};
```

Plugin manifest 应将其列入 `contributions.ui.layouts`，并单独请求：

- `ui.layout.contribute`
- `home.presentation.read.<scope>`
- `ui.intent.agent`
- `ui.intent.proposal`
- `ui.intent.action.request`（默认拒绝，且只表示可请求）

layout contribution 的声明、安装和可见，不等于任何 data 或 intent grant。

## Switching behavior

### Preference precedence

```text
temporary session choice
  > per-user + device-class preference
  > per-user default
  > household recommended default
  > builtin.life safe default
```

墙面设备可以由家庭管理员设置推荐视图，但个人设备上的成员选择优先。个人设备默认值可由
当前成员修改；共享设备或家庭推荐默认值只允许 Owner/Admin 修改。访客不能修改家庭级默认值，
只能在当前会话临时切换；未认证共享屏只显示修改请求的管理员 handoff。

### Switcher presentation

切换器不能设计成只容纳两个值的永久 Toggle，因为未来会出现第三方布局：

- 桌面端由 Host 顶栏显示当前布局名称，打开 anchored popover；移动端打开 bottom sheet；
- 首屏展示“生活视图”“控制视图”和最近使用的第三方布局，每项有静态预览、适合场景、
  发布者与当前可用性；
- 选择后先安全预加载，再提供“切换到此视图”；“设为这台设备的默认视图”是独立动作，
  不因一次临时查看自动改变默认值；
- 插件管理、权限和布局编辑位于下一层，不把安装市场塞进日常切换器；
- 键盘和屏幕阅读器可以获知当前项、加载状态和失败原因，reduced-motion 使用交叉淡化。

只有两个内置布局时，Host 可以额外提供“切换到上一个视图”的快捷动作，但它仍调用相同
registry 和状态机，不形成绕过 provider 检查的第二条路径。

### Semantic route continuity

切换保存的是语义位置，不复制 URL：

| 语义位置 | 生活视图示例 | 控制视图示例 |
| --- | --- | --- |
| `home` | 家庭当前摘要 | 总览 Dashboard |
| `space/:spaceId` | 空间故事/建议 | 空间设备与指标面板 |
| `turn/:turnId` | 对话 Sheet | Turn 状态卡/侧栏 |
| `confirmations` | 等待你放行；TTL 与角色 | 运行时确认队列；不可批量批准 |
| `proposals` | 给家的建议；低压力审阅 | 提案影响表格；最多 5 项 |
| `activity` | 家庭可读时间线 | 可筛选事件与诊断图表 |
| `settings` | 简化设置入口 | 完整配置工作区 |

如果目标 provider 不支持当前语义位置，Host 回到该 provider 的 `home`，保留原对象，并显示
“这个布局没有对应页面；已回到总览”。不能丢失 Turn、Review 或草稿。

### Mobile processing surface

移动端可以用一个 Host-owned 处理页承载两个语义 route，但不能聚合计数：

1. `confirmations` 固定在上方；每条使用独立 TTL badge，过期后按钮失效。
2. `proposals` 位于下方；显示独立 `n/5`，其中 `snoozed` 与 `pending-review` 都占容量。
3. 底部导航不显示两者相加的红点或数字。Provider 可以改变卡片排版，不能改变顺序与 badge 语义。
4. 运行时拒绝只提交 `submit-runtime-confirmation-decision`，不得触发 proposal dedup latch。

### Switch state machine

```text
stable(current)
  -> selecting
  -> preloading(target)
  -> ready(target) -> apply for session -> stable(target)
                   -> set device default -> stable(target)
                   \-> cancel -> stable(current)
  -> failed(target) -> stable(current) + retry / disable plugin / restore default
```

切换必须从当前画面连续发生、可被取消，并在 target ready 前保留原视图可用。不得先卸载当前
布局再显示加载器。Agent Turn 和 device action 不属于 View 生命周期，切换不会取消它们。

## Configuration and editing

两种内置视图分别保存自己的 presentation configuration：

- 生活视图：常用空间、首页关注项、建议密度、封面和语音入口偏好；
- 控制视图：Dashboard 页面、网格、卡片、指标时间窗、快捷按钮和默认筛选；
- 共享设置：家庭连接、成员、模型、媒体、设备映射、policy 与 approval，不随布局复制。

布局编辑采用 `draft -> preview -> save`。预览使用当前用户允许看到的真实投影，但所有动作
intent 禁用；保存失败保留草稿。重置只删除当前 provider 的 presentation preferences，
不删除家庭数据、设备绑定、Agent 历史或其他布局配置。

### F1 declarative presentation preferences

A trusted provider may declare up to 8 bounded select preferences. Each declaration
contains a stable key, household-facing label and description, 2–8 closed choices,
and one default choice. The Host validates declarations during registration and
validates every saved provider/key/value tuple again at the HTTP boundary.

The Host owns the settings form, the private browser-profile cookie and the same
member/device permission used for the device default. Reset clears the active
provider's declared preferences. The provider receives an immutable presentation
snapshot. The values stay confined to layout and remain outside Hub intents, Agent
prompts, bridge contracts, review decisions and semantic route selection.

Registry registration snapshots and freezes provider metadata. Every render receives
a deep-frozen copy of the model and route context; the Host renders safety, identity,
navigation and review counts from its original canonical model.

The bundled Life provider declares `overviewFocus` (`focused` or `expanded`). The
bundled Control provider declares `rowDensity` (`comfortable` or `compact`). This
F1 contract keeps preference UI declarative; executable provider settings remain
part of the later isolated View Application phase.

### F2a bounded recipe compilation

The first declarative ecosystem slice accepts data and produces an immutable Host
slot plan. A V1 recipe contains an exact API version, bounded publisher-scoped id
and title, 1–7 unique semantic pages, one closed layout mode per page, and 1–12
unique Host slot references per page. Registration accepts up to 64 slots across
the recipe. The `builtin.*` namespace belongs to the Host.

V1 semantic routes are `overview`, `conversation`, `reviews`, `activity`, `control`,
`settings` and `onboarding`. Slots use an exact route-scoped vocabulary. The
confirmation/proposal surface remains one indivisible `reviews.workspace` slot;
the recipe cannot split, reorder or recombine its two lifecycles. Control stays one
`control.workspace` slot so governed forms and feedback remain Host-rendered.

The recipe grammar contains no HTML, CSS, JavaScript, URL, asset, query, secret,
credential, model prompt, native bridge identity, handler or action field. Compilation
validates the entire object before returning a deeply frozen plan. F2b adds Host slot
rendering; a later F2 milestone adds isolated third-party loading.

### F2b Host slot rendering

A declarative provider is created only from a compiled V1 recipe. For a declared
page, the Host maps each slot identifier to its existing renderer and arranges the
result in a bounded six-column layout. `full`, `half` and `third` span six, three and
two columns; compact viewports place every slot on one column. Every slot receives
markup from its Host renderer. The overview heading is first and full-width; the
optional composer is last in DOM order and remains immediately above mobile
navigation.

A semantic route omitted by the recipe uses its canonical Host page while the
provider remains active. This preserves conversations, reviews, control and setup
as complete product paths. The fixed Host Shell owns safety alerts, navigation,
identity, view recovery and queue badges.

### F2c deterministic recipe conformance

`@hob-agent/inbox-web/view-recipe-conformance` exposes one pure publication check
for a data-only recipe. A successful report binds the exact compiled plan to a
`sha256:` digest and records seven closed checks: compilation, immutable plan,
deterministic render, one semantic heading per page, fixed Host boundary, canonical
fallback and responsive layout. The report and every check are immutable.

Compilation failure returns one failed check followed by blocked dependent checks.
The report contains stable check names and statuses, keeping submitted titles,
household content and invalid fields inside the validator boundary. The digest
changes when the ordered page or slot plan changes, so a publisher can bind later
review evidence to one exact recipe generation.

This Phase 0 seam evaluates recipe data directly. Package installation, plugin
manifests, signatures, catalog publication and grants enter through their separately
reviewed phase gates. A passing layout report establishes presentation conformance;
the Hub continues to decide identity, data scope, intents, approval and execution.

### F2d explicit local contribution registration

`ProposalInboxHttpOptions.viewRecipes` accepts up to 16 explicitly supplied recipe
values. Startup compiles each value into one immutable plan, runs the F2c conformance
set against that exact plan and creates the Host-rendered provider before opening the
HTTP listener. Any rejected contribution produces one stable redacted startup error.

This path gives deployments and developer fixtures a complete data-only integration
seam. The existing `viewProviders` option remains the trusted in-process seam for the
two bundled views and repository-owned tests. Filesystem discovery, package loading,
network retrieval, watching and manifest interpretation belong to later phase gates.

### F2e scalable Host view selection

Two available views remain direct Host shortcuts. Three or more views use one compact
current-view trigger: an anchored panel on desktop and a bounded bottom panel above
mobile navigation. The panel lists every registered choice, marks the current view
and links to the separate settings surface for default-view management.

The native disclosure keeps keyboard semantics. Host behavior closes it on Escape,
returns focus to the trigger and closes it when the person points elsewhere. Long
labels truncate inside the trigger and list rows, recovery text receives its own row,
and the document retains its viewport width. Opening and closing the panel leaves the
current page, active Agent turn, safety surface and both review badges unchanged.
Review selection and control result references travel with the semantic route, so a
view switch keeps the proposal detail, action feedback or batch result in context.

### F2f durable authoring drafts

Layout authoring uses `draft → preview → save`; activation remains a separate future
command. A draft record contains an opaque id, owner principal, positive revision,
household-facing label, at most 64 KiB of inert UTF-8 source and an update timestamp.
The Hub stores at most 32 drafts in a private SQLite file and applies optimistic
revision checks to every update and explicit deletion. Deletion releases one draft
slot while leaving active providers and household data unchanged.

The draft store treats source as inert content. It returns source only to its owner
through the authenticated advanced settings path. Logs, Agent prompts, household
projection and provider registration receive metadata only. Preview parses JSON,
compiles V1 recipe data and runs conformance for the exact draft revision. A stable
redacted result describes syntax, recipe or conformance failure while preserving the
draft source for another edit.

Preview uses the current member's allowed presentation projection and a Host-owned
interaction-disabled render mode. Save records the draft; preview establishes no
grant, provider registration, default change, approval or device action. Activation
later binds an exact draft revision and digest through its own permission and audit
path. Private-device administrator access is the Phase 0 authoring boundary.

## Failure and recovery

- Provider 加载超时、崩溃、版本不兼容或被撤销：继续显示当前安全视图；不可用 provider
  从快速切换中移除，并保留诊断入口。
- 当前第三方 provider 启动后崩溃：Host 显示 `builtin.life` 或用户最近可用的内置视图，
  明确说明布局失效，但不把家庭误报为离线。
- 插件卸载：删除其可执行包和 provider preference binding；是否保留可迁移的声明式布局
  草稿由用户选择。家庭事实和 audit 不随之删除。
- 数据部分不可用：Provider 必须渲染 freshness/unknown；不能用缓存值伪装实时状态。
- Freshness 必须区分“连接正常但家中无变化”和“连接中断”；只显示“更新于多久前”不合格。
- 自定义布局不满足 keyboard、contrast、reduced-motion 或屏幕尺寸 conformance：不得发布
  到公共 catalog；本地开发模式也保留“恢复默认布局”。

Control availability is an exhaustive projection of the neutral connection state:

| Connection state | Presented value | Action state | Recovery path |
| --- | --- | --- | --- |
| `connected` | current value | available | normal control feedback |
| `quiet` | current value, connection healthy | available | normal control feedback |
| `connecting` | last known value | waiting | connection completion |
| `disconnected` | last known value | waiting | connection recovery |
| `unknown` | last known value | waiting | connection classification |

Control feedback has four valid shapes: `verified` may offer the bounded undo,
`pending_confirmation` may show its approval expiry, and `failed` or `unknown`
render stable, informational feedback. Both built-in providers pass the same
state table and render identical governed control content for the semantic route.

## Delivery sequence

Current checkpoint (2026-08-22): F0 and F1 are complete. F1 includes the shared
presentation kernel, `ProductViewRegistry`, `builtin.life`, `builtin.control`,
browser-profile device defaults, semantic-route continuity and deterministic
recovery to `builtin.life`. Top-level switching applies to the current browser session. The
Host-owned settings command persists or resets a device default; a bound private
device is managed by its member and a shared device is managed by an administrator.
The Control provider renders a continuous dense space-and-action surface from the
same governed intents. The Host is the single owner of the view switcher; providers
render content for the active semantic route. The connection and control-feedback
error-state matrix is complete. The shared accessibility matrix covers one page
heading, skip navigation, labelled controls, native time fields, semantic progress,
visible keyboard focus, touch feedback, reduced motion/transparency, increased
contrast and responsive safe areas. Provider metadata and every render input are
immutable at runtime. Provider-specific presentation choices are closed declarations
validated and persisted by the Host.

F2a–F2e now provide the strict V1 recipe compiler, Host-rendered slot layout,
canonical semantic-route fallback, a digest-bound conformance report and explicit
local contribution registration, plus scalable Host-owned view selection. The
remaining F2 work covers developer authoring and the later phase-gated package
registration, signature, compatibility and grant path.

1. **F0 — contract and prototype:** 在交互稿中加入生活/控制视图切换、失败回退、per-device
   preference 和语义路由连续性；不装载第三方代码。
2. **F1 — shared presentation kernel:** 在 `packages/inbox-web` 内建立 presentation/intents
   contract 和 View Registry；两个 built-in provider 都通过 registry 注册并通过同一套
   conformance tests。
3. **F2 — declarative ecosystem:** 冻结 recipe schema、card/layout extension points、可视化
   编辑器、签名/compatibility/grant 和无代码执行的 renderer。
4. **F3 — isolated applications:** 只有独立 origin sandbox、CSP、broker、资源预算、崩溃隔离、
   accessibility 和供应链 gates 完成后，才开放 executable View Application。

## Acceptance invariants

- 两个 built-in provider 对相同 snapshot 和 intent 具有相同权限结果。
- 切换视图不会重启 Agent、重新连接 Bridge、重复执行动作或丢失 active Turn。
- View Provider 永远不能取得 raw secret、Bridge client、Cordis Context 或 executor。
- 第三方布局失效时始终能恢复到内置布局；恢复入口不由插件渲染。
- 每个 provider 的配置独立，家庭连接、policy、approval 和 audit 只有一份。
- 任何 provider 都不能批准过期运行时确认、绕过成员角色、合并运行时确认与持久提案，或隐藏
  Host 安全级异常。
- 任何 provider 都不能把 snoozed 提案排除在容量之外、把运行时拒绝映射成提案闩锁，或在移动端
  显示两类对象的聚合 badge。
- 所有布局都通过 keyboard、responsive、reduced-motion、contrast、loading、partial、error 和
  recovery conformance。

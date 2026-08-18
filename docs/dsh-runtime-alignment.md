# DSH Runtime 对齐决策

> 状态：已接受。DSH 是 hob-agent 唯一的 Agent Runtime；不保留第二套 Agent loop。

> 接入进度：DSH 已是唯一生产 Agent Runtime。当前精确锁定
> `@deepseek-ai/cordis@4.0.1` 与 DSH core `0.1.0-rc.7` compatibility set；HA bridge、
> DSH production service、家庭只读工具和官方 `dsh-llm-pi-ai` provider seam 均有组合
> 测试，DeepSeek 路径已真实调用成功。`pi-agent-core` 已删除；`pi-ai` 仅作为 provider SDK。

## 唯一 Runtime 决策

hob-agent 只维护一个 DSH Agent Runtime，不设置第二套兼容路径或回退内核。生产组合
只能由 DSH 拥有以下语义：

- Agent loop、inbox、取消和生命周期；
- session、turn、step 和事件日志；
- system prompt 组合；
- tool registry 与执行管线；
- Agent scope 与后续 subagent/compaction 能力。

`pi-ai` 与 `pi-agent-core` 不作同类处理。前者只作为官方 DSH LLM adapter 的传递依赖，
hob-agent 不声明、不导入，也不让其类型进入产品 API；后者属于竞争 Runtime，已经移除。
Keychain、profile、fallback 与 probe 机制保留在产品治理层，但调用边界分别收口到 DSH
credentials、OAuth seam 与 LlmRuntime。

## 背景

hob-agent 的唯一产品目标是家庭 Agent。我们不计划在同一个项目中继续建设代码、
金融或其他垂直 Agent。因此，引入 Cordis 和对齐 DeepSeek Harness（DSH）的目的，
不是让 hob-agent 变成一个通用 Agent 平台，也不是为不存在的第二条产品线预留大量
抽象。

我们希望复用并跟随 DSH 对通用 Agent Runtime 的前沿实践，包括：

- Agent loop、inbox、取消和生命周期；
- 事件溯源 session；
- system prompt 组合；
- tool registry 与执行管线；
- skill registry、发现和按需加载；
- Agent scope、子 Agent、任务和 compaction；
- LLM provider seam 与运行时组合。

hob-agent 自己集中建设家庭领域能力，包括 Home Assistant、家庭世界模型、提案、
审批、自动化产物、设备执行和家庭审计。

相关上游：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Cordis 原始上游](https://github.com/cordiverse/cordis)

实际运行依赖采用 DSH 发布并维护的 `@deepseek-ai/cordis`，其版本与选定的 DSH
compatibility set 一起锁定。`cordiverse/cordis` 是概念和原始代码上游，不作为与 DSH
发行版混用的第二套 Cordis 依赖。

## 核心判断

建议采用以下表述：

```text
DSH Agent Runtime
= 通用 Agent 怎样运转

hob-agent Home Product Bundle
= 家庭 Agent 做什么、理解什么、遵守什么规则
```

不再把两边称为并列的 “DSH Core Spine” 和 “Home Spine”。后者容易让人误解为
hob-agent 还要建设第二套 Agent 内核。

两者的关系是：

```text
hob-agent Home Product Bundle
            ↓ 使用
      DSH Agent Runtime
            ↓ 组合于
          Cordis
```

Cordis 是统一的组合和生命周期底座；DSH 提供通用 Agent Runtime；hob-agent 是在
该 Runtime 上运行的固定家庭产品组合。

## 目标架构

```text
Cordis Runtime
└── DSH Agent Runtime
    ├── LLM seam
    ├── event-sourced session
    ├── system-prompt registry
    ├── tool registry and execution pipeline
    ├── skill registry and model-facing loader
    ├── agent registry and scope
    ├── agent loop
    └── hob-agent Home Product Bundle contributions
        ├── home LLM profile adapter
        ├── home prompt and knowledge sections
        ├── home skills files
        ├── governed home tools
        └── home domain services
            ├── Home Assistant bridge and world model
            ├── proposal and evidence generation
            ├── home policy and human approval
            ├── automation artifact compiler and executor
            └── home audit
```

`Home Product Bundle` 是 hob-agent 的固定组成部分，不需要设计成用户可替换的垂直
产品插件。它内部可以使用 Cordis 管理真正需要独立生命周期或作用域的组件，但不要求
每个普通模块都变成 Service Definition / Provider / Consumer 三层结构。

`Home Product Bundle` 是产品组合边界，不要求成为单一代码包或单体 Service。它可以由
多个普通模块和 Cordis plugin 组成；“固定”表示产品始终加载这套家庭语义和治理规则，
而不是把全部实现收进一个不可拆分的模块。

## Product Bundle、租户与第三方 Plugin

Cordis 视角下，Home Product Bundle 本身可以实现为一个 bundle plugin，第三方能力也
是 plugin。两者的技术形态可以相同，但产品身份、信任等级和权限不同：

```text
DSH Agent Runtime
└── Home Product Bundle（定义这是什么产品）
    ├── tenant scope/configuration（定义这个家庭是什么样）
    └── third-party plugins（为这个家庭产品增加能力）
```

Home Product Bundle 是第一方、产品必需并随 hob-agent 发布的组合。它定义家庭领域模型、
proposal-first 流程、风险和审批语义、设备执行边界与审计要求。移除它后 Runtime 仍可能
运行，但系统不再是 hob-agent。

租户不拥有另一份 Product Bundle 实现。每个家庭在独立 scope 中提供自己的成员、设备、
Skills、策略配置和启用的 plugin，共享相同的产品安全语义和代码基线。

第三方 Plugin 是独立发布、可选安装和可卸载的扩展单元。它可以贡献设备适配器、只读
数据源、Skill、分析器、提案生成器、通知渠道和 UI，但只通过 Home Product Bundle
公开的 seam 工作。它提供的是候选能力，不是最终授权：

```text
third-party plugin 提交能力或动作
              ↓
Home Product Bundle 规范化和策略判定
              ↓
必要时批准 → 受治理执行 → Home audit
```

第三方 Plugin 不得覆盖家庭风险语义、伪造批准、绕过 executor 或跳过审计。安装成功、
在 Agent scope 中可见和获得执行授权是三个不同状态。

## DSH 与 hob-agent 的职责边界

| 领域 | DSH Agent Runtime | hob-agent Home Product Bundle |
| --- | --- | --- |
| Agent loop | 拥有 | 使用，不复制 |
| Session、turn、step | 拥有通用事件和重放语义 | 关联家庭提案和审计 ID |
| Prompt | 提供组合机制 | 提供家庭 persona、知识和安全约束 |
| Tools | 提供 registry 与执行管线 | 注册家庭只读、提案和受治理执行工具 |
| Skills | 提供 registry、发现、作用域和加载 | 提供家庭 Skill 文件和必要的领域元数据 |
| LLM | 提供 adapter seam | 接入现有 profile、OAuth、Keychain 和 fallback |
| Home Assistant | 不理解 | 完全拥有 |
| 世界模型 | 不理解 | 完全拥有 |
| 自动化提案 | 不理解 | 完全拥有 |
| 设备风险和策略 | 不理解 | 完全拥有 |
| 人工批准 | 可提供通用交互机制 | 定义家庭审批票据和安全语义 |
| 设备执行与审计 | 不拥有 | 完全拥有 |

依赖方向必须保持单向：家庭代码可以依赖 DSH seam，DSH Runtime 不依赖任何家庭
概念。

## Skills 边界

这里不应存在两套 Skill 系统。

DSH 负责的是 Skill 基础设施：

```text
Skill Registry
├── 注册、查找和重名处理
├── Agent scope 可见性
├── 目录变化后的刷新
├── 内容按需加载
└── 面向模型的 skill 工具
```

hob-agent 初期只提供内容：

```text
home-template/skills/
├── night-lighting/SKILL.md
├── energy-review/SKILL.md
└── away-mode/SKILL.md
```

如果这些 Skill 能由 DSH 的通用 filesystem provider 在家庭产品要求的路径 containment、
非符号链接和内容大小边界内直接读取，就不创建 `HomeSkillProvider`。当前 rc.7 provider
会按需重读无大小上限的 body，并在 Node fallback 中跟随符号链接，因此第一片只使用
官方 registry/loader 加载第一方内嵌 Skill；租户 Skill 根目录保持关闭。

只有出现真实需求时，才增加家庭专用 provider，例如：

- 按家庭成员或 Agent 动态过滤；
- 根据设备和家庭配置生成 Skill；
- 从 SQLite 或远程家庭模板读取；
- 合并多个来源并处理覆盖优先级；
- 携带房间、成员或风险等级等领域元数据。

即使届时增加 `HomeSkillProvider`，它也只是向 DSH `ctx.skills` 贡献内容，不会形成
另一套 registry 或 model-facing loader。

## 为什么只有一个家庭产品仍然保留边界

该边界的价值不是支持其他垂直 Agent，而是隔离不同的变化来源：

- DSH Runtime 跟随上游 Agent 架构演进；
- Home Product Bundle 跟随家庭产品、安全和 Home Assistant 演进。

它还提供现实价值：

- HA 断线时可以独立重启 bridge；
- Agent 销毁时可以清理工具、监听器和后台工作；
- 不同成员或 Agent scope 可以看到不同能力；
- 测试可以使用假的 HA 实现；
- 只读部署不挂载设备执行能力；
- 审批不可用时，受保护动作可以 fail closed；
- 升级 DSH 时，可以用边界契约测试识别兼容性变化。

## 避免过度抽象的规则

不是所有东西都因为运行在 Cordis 上就必须成为公共 Plugin 或 Provider。

采用以下判断规则：

1. 只有一个实现、没有独立生命周期、没有作用域差异的逻辑，先写成普通模块。
2. 需要独立启动、停止、清理、替换或测试隔离时，使用 Cordis Service/Plugin。
3. 需要多个来源向同一能力目录贡献内容时，引入 registry/provider seam。
4. 不因为“未来可能”建立第二种实现；出现真实第二实现或真实边界需求后再抽象。
5. Cordis 的动态装载能力不等于授权。能力是否允许执行仍由家庭策略判定。

现阶段不提前建设：

- 通用 `HomeSkillProvider`；
- 多后端 world-model framework；
- 多实现 proposal engine；
- HA 之外的 bridge marketplace；
- 通用垂直产品加载器；
- 可选择不加载 Home Product Bundle 的产品模式。

## 安全与事实源

DSH session log 与家庭审计解决不同问题：

- DSH session log 是 Agent 的模型交互事实源；
- Home audit 是设备、策略、批准和自动化产物的安全事实源。

两者通过稳定 ID 关联，但不应合并为一个模糊日志。家庭设备操作至少需要记录：

- session、turn 和 tool-call 身份；
- proposal 与 artifact 身份；
- 精确动作和参数；
- policy 版本和判定；
- approval 票据及有效期；
- 执行结果和设备侧证据。

Cordis 可以管理 policy、approval 和 executor 的生命周期，但插件成功加载不能自动
授予设备权限。

## 接入顺序

### 1. DSH-hosted read-only agent

直接由 DSH 托管唯一的只读 Agent，由 Cordis 管理 HA bridge 与 DSH runtime 的生命周期。
验证依赖、scope、卸载清理和 fail-closed 行为。

### 2. 接入模型凭据

通过唯一的 DSH LLM seam 接入 hob-agent 已有的 profile、OAuth、Keychain、cooldown 和
fallback，不在 Agent loop 内重复这些逻辑。

### 3. 接入 Skills

先用 DSH registry 与 `dsh-tool-skill` 承载第一方内嵌家庭 Skill。待通用 filesystem
provider 具备或外接家庭产品所需的 containment、非符号链接和大小边界后，再读取
`home-template/skills`；不建立第二套 registry/loader。

### 4. 增加家庭提案和治理链

在 DSH tool pipeline 上增加家庭只读工具、提案、证据、审批、artifact、执行和审计，
保持 Phase 0 的 proposal-first 边界。

### 5. 跟进上游动态能力

逐步评估 subagent、jobs、goals、compaction 和运行时插件挂载。先开放给 Skill、分析
和提案等低风险能力，再单独评估设备执行相关能力。

## 上游版本策略

DSH 当前仍处于 developer preview，源码和 npm 各 package 的发布进度可能短期不同。
接入时应：

- 精确锁定同一个 release family，不使用宽松自动升级；
- 记录对应 DSH tag 或 commit；
- 维护一份列出每个实际 package 精确版本的 compatibility set，且仅在所需 npm tarball
  全部可用并通过安装 smoke test 后升级；
- 不复制或重新发明 DSH 公共类型；
- 为 session、tools、prompt、LLM 和 cancellation 建立兼容测试；
- 每次升级作为显式变更处理；
- 通用修复优先贡献上游，家庭语义保留在 `@hob-agent/*`。

### 当前 compatibility set

生产 runtime 采用 DSH tag `dsh-v0.1.0-rc.7`（源码 commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`）。`packages/agent-layer` 将 core
及其必需 peer 精确锁定为 `0.1.0-rc.7`：`dsh-llm`、`dsh-session`、
`dsh-system-prompt`、`dsh-tools`、`dsh-scope`、`dsh-agent`、`dsh-agent-loop`，以及
`dsh-attachment`、`dsh-brand`、`dsh-code-runtime`、`dsh-credentials`、`dsh-invariants`、
`dsh-launch-environment`、`dsh-llm-pi-ai`、`dsh-repeat-tool-reminder`、
`dsh-commands`、`dsh-compaction`、`dsh-compaction-basic`、
`dsh-session-persistence`、`dsh-session-persistence-sqlite`、`dsh-settings`、
`dsh-session-projection`、`dsh-skill`、`dsh-timeout`、`dsh-token-meter`、
`dsh-tool-skill`、`dsh-typert-protocol`、
`dsh-user-approval`。底层 `@deepseek-ai/cordis` 固定为 `4.0.1`；DSH core 所需的
`@deepseek-ai/schemastery` peer 固定为 `3.18.1`。

这些所需 npm tarball 均已发布并已写入锁文件；安装通过 pnpm supply-chain policy，官方
adapter 的精确 rc.7 tarball 作为审阅后的单项 minimum-release-age exception 记录。
`dsh-compatibility-set` gate 要求声明 exact versions，并在缺失、range 或混用其他 DSH
release family 时 fail closed。传递依赖的 install scripts 默认拒绝执行。

## 开放问题

1. DSH session persistence 应直接采用其后端，还是由 `packages/hub` 实现兼容的 SQLite
   persistence provider？
2. 上游何时提供结构化 OAuth contract/provider adapter，使 Claude OAuth 能进入 DSH
   LLM seam，而不复制 `llm-pi-ai` 或把 token 降格成 API key？
3. `home-template` 的现有顶层 Markdown 如何映射到 prompt sections、memory 和 Skills？
4. 哪些 Cordis 插件允许动态重载，哪些家庭安全组件必须在活动操作期间固定版本？

## 已接受决策

以下方向已接受，后续变更不得重新引入第二套 Agent Runtime：

> hob-agent 使用 Cordis 作为组合和生命周期底座，使用 DSH 作为通用 Agent Runtime
> 上游，并将全部家庭语义收敛到一个固定的 Home Product Bundle。我们保留清晰的
> Runtime/Product 边界，但不为假想的其他垂直产品或第二实现提前建立抽象。

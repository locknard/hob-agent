# Stage 5 扩展与插件治理决策稿

> 状态：已接受，作为 Stage 5 的冻结治理边界；本文不表示第三方插件运行时已经实现。
>
> 本文只定义扩展治理和准入，不实现插件安装器、插件运行时或新的 Skill
> 格式。它服从 [DSH Runtime 对齐决策](dsh-runtime-alignment.md)、[DSH Home
> Skills first slice](dsh-home-skills.md)、[governed action plane](governed-action-plane.md)
> 与 [Bridge Design v6.3](bridge-design.md)。

## 0. 冻结决策

1. **Home Product Bundle、tenant Skill、third-party executable plugin 是三种不同的产品对象。**它们可以都由 Cordis 组合，但不能共享信任、权限或卸载语义。
2. **Cordis 统一生命周期，不授予授权。**`plugin()`、Service、Provider 的注册、启动、停止、abort 和 dispose 只说明代码如何被组合；是否可见、是否可读、是否可提出或执行动作，另由 Hub policy、Agent scope、approval 和审计决定。
3. 对可执行插件，`install → verified → enabled → scope-visible → authorized` 是五个独立门。后一个门不能隐式补齐前一个门，任何门撤销都 fail closed。
4. 插件 manifest 是**插件包元数据**，不是 Skill 格式、Skill registry 或 model-facing loader。Skill 仍是官方 DSH `SKILL.md`；插件至多贡献符合官方格式的文件。
5. 第三方可执行代码不得以不受限的 in-process import 进入 Hub、Agent loop、policy、approval、executor、vault 或审计库。没有可证明的进程隔离时，第三方可执行插件保持关闭。
6. 所有能力声明都是请求，不是权力。Hub 以声明、信任等级、租户配置、数据 scope 和 policy 的交集产生有效 grant；插件 payload、Skill 文本、模型输出都不能扩大交集。
7. `actions@1` 与 `artifactHost@1` 仍遵守 governed action plane 的精确 approval ticket、一次性 nonce、幂等、`indeterminate` 和 postcondition 语义。插件不能绕过 Hub executor，也不能从自己的 payload 取得 authority。
8. 安装、更新、授权、执行、隔离、撤销和卸载都产生 Hub-owned、追加式审计；卸载不能删除、重解释或隐去既有安全事实。

## 1. 范围与对象分类

| 对象 | 来源和信任 | 能提供什么 | 能否执行代码 | 生命周期和权限 |
| --- | --- | --- | --- | --- |
| **Home Product Bundle** | 随 hob-agent 发布的第一方固定产品组合 | 家庭领域模型、neutral tools、proposal/evidence/policy、审计、HA bridge 接入、第一方 Skill | 可以，在产品受信代码边界内 | 产品版本生命周期；不能被租户单独卸载；动作仍须 Hub policy/approval |
| **tenant Skill** | 家庭目录中的不可信内容 | 官方 DSH `SKILL.md` 的路由描述和 Markdown 指令文本 | **不能**；不含可执行入口、工具注册或权限 | 由官方 `ctx.skills` registry 发现和按需加载；可 scope-visible，但永远不因此 authorized |
| **third-party executable plugin** | 独立发布、签名、可选安装的代码包 | 受审核的 read-only data/tool、bridge adapter、proposal source、通知和受限 UI | 可以，但必须通过本文隔离和 conformance gates | 每租户、每 generation、每 capability 独立；授权可撤销；默认无设备写权限 |

### 1.1 Home Product Bundle

Home Product Bundle 定义“这是什么家庭产品”，拥有 proposal-first、设备风险、人工审批、
neutral world、action authority 和 Home audit 语义。它不是可从租户配置中替换的通用插件，
也不是第三方扩展的权限父级。Bundle 内部可以使用 Cordis Service/Plugin 管理真实需要独立
生命周期的组件，但固定产品语义不能被插件覆盖。

第一方内嵌 Skill 仍按精确 DSH Skill definition 注册；加载它不会注册工具、授予设备权限或
绕过 Hub 的覆盖/证据检查。第一方 bridge 适配器仍须通过 catalog、`AdapterRegistration`、
neutral contract 和合成桥 conformance。

### 1.2 tenant Skill

Tenant Skill 是文本数据，不是插件。它只能通过现有 DSH `ctx.skills` registry 和官方
model-facing `skill` tool 可见；不得建立第二个 registry、loader 或 frontmatter 方言。
租户 Skill 的 containment、无符号链接、单文件/总量预算、严格 frontmatter 和按需读取规则
由 [dsh-home-skills.md](dsh-home-skills.md) 决定。

租户 Skill 不声明网络、文件、进程、bridge、tool 或 action permission。`metadata` 仅是
provider-specific 数据，不能被解释为授权；Markdown 中出现的“允许执行”“批准”等文字仍是
不可信模型输入。

### 1.3 third-party executable plugin

第三方插件必须是不可变、可寻址的 package generation。其 manifest 只描述包、兼容性、贡献
面和权限请求；运行时必须向 Home Product Bundle 暴露的 typed seam 贡献能力。插件不能：

- import Hub 内部 SQLite、policy、vault、approval、executor 或原生 bridge 对象；
- 直接把生态原始 payload 送入 contracts、world model 或 agent layer；
- 自己决定 `bridgeId`、remote identity、`hwId`、`hwCapabilityId`、principal 或 action target；
- 把“已安装/已加载/模型可见”当作“已授权”；
- 注册隐形工具、任意 shell、任意 HTTP endpoint 或绕过审计的后台任务。

## 2. 独立状态门和状态机

可执行插件的 durable record 至少包含：

```text
{ pluginId, packageDigest, generation, manifestHash, publisherKeyId,
  installState, verificationState, enableState, scopeBindings[], grants[],
  quarantineState, revocationState, installedAt, updatedAt }
```

`pluginId` 标识产品扩展，`packageDigest` 标识不可变包，`generation` 标识一次安装/更新
实例。旧 generation 的 grant、scope binding 和 bridge authority 不自动迁移到新 generation。
包、manifest、签名、grant 和审计记录都按 digest/hash 关联，避免同名重装覆盖历史。

```text
install
  └─ verify ── enable ── scope-visible ── capability grant authorized
       │          │            │                 │
       └──────────┴────────────┴─────────────────┴── 每一门都可独立失败/撤回
```

“authorized”不是插件的全局布尔值，而是至少按
`{tenantId, pluginId, generation, capability, scope, policyVersion, expiry}` 绑定的
grant。只有所有必要门同时成立，某次特定调用才有**有效能力**：

```text
effective capability
= installed ∧ verified ∧ enabled ∧ scope-visible
  ∧ grant.authorized ∧ currentPolicyAllows ∧ runtimeHealthy
```

| 操作/状态 | 必要检查和结果 |
| --- | --- |
| **install** | 接收不可变包并写入私有 store；检查包大小、文件数、路径、符号链接/硬链接和 manifest 资源预算。只安装不加载、不见 scope、不获 secret。失败留 bounded rejection/audit。 |
| **verified** | manifest schema、digest、签名链、publisher trust、host/DSH/Cordis compatibility、声明的 capability 和静态约束全部通过。未知字段或未知 capability fail closed。 |
| **enabled** | 操作者/产品配置在指定租户启用已 verified 的 generation；依赖和隔离环境准备完成后才启动。启用不是授权；代码仍不能观察未绑定的 scope。 |
| **scope-visible** | 贡献以确定性名称和 scope 原子注册到 DSH/Hub 目录。未选中的租户、Agent scope 或 bridge config 不可见；可见内容仍只有 candidate/summary，不能取得未授权数据。 |
| **authorized** | Hub policy 对具体 capability、tenant/scope、generation、数据/动作目标和期限作出 grant。read-only 能力可由明确 policy 自动 grant；proposal 和 action 仍遵守证据/approval。插件不能签发此 grant。 |
| **disable** | 先撤销有效 grants、阻断新调用，再 abort/dispose。保留已安装包、配置、digest 和审计；重新 enable 必须重新验证 runtime/compatibility，不能恢复已撤销的 action grant。 |
| **uninstall** | 先按 disable 停止并从所有 scope 原子移除，再删除可执行包/临时文件。写入 tombstone，保留 digest、generation、来源、grant、执行和安全审计；重装得到新 generation。 |
| **quarantine** | 对 protocol/resource/security 违规、签名问题、崩溃风暴或人工安全事件立即撤销 scope/grants，停止新工作并隔离包。不得自解封；保留取证 hash 和 bounded diagnostics，待 review/reinstall。 |
| **revocation** | publisher key、包 digest 或安全版本进入 Hub denylist；所有匹配 generation fail closed。不得自动回滚到已撤销包；新包须由未撤销信任根签名并重新走五门。 |

Disable、quarantine、revocation 的 runtime 停止必须有 deadline；超时后强制终止隔离进程，
并记录未完成清理。若插件参与一个已经 claim 的 action ticket，不能猜测远端状态：按
[governed action plane](governed-action-plane.md) 转为 `indeterminate`，不得自动重试。

状态转换、scope registry 交换和 grant 失效必须在同一 Hub transaction/版本边界中可观察；
任何崩溃恢复默认取更安全状态（不可见、未授权、执行中为 indeterminate）。

## 3. Trust tiers

Trust tier 是 host 对来源和审查的判断，不是 plugin 自报字段，也不能单独产生权限。

| Tier | 定义 | 默认允许 | 明确禁止 |
| --- | --- | --- | --- |
| **T0 product** | Home Product Bundle 随产品发布、源码/构建受审查并由产品发布密钥保护 | 产品声明的全部已审核 seam；仍受 Hub policy、approval 和审计 | 以 Bundle 身份让租户替换安全语义或跳过 action plane |
| **T1 reviewed provider** | 第一方/合作方签名包，通过对应 bridge/tool conformance 和人工审查 | 隔离的 bounded read-only、proposal、已批准的 adapter seam | 未声明的网络/文件/secret；任意设备写；自定义 executor |
| **T2 isolated third-party** | 可验证签名和 digest、自动 conformance 通过、严格进程隔离的第三方包 | 默认 read-only 数据、分析、通知和 proposal candidate | 直接 action/artifact、任意 bridge authority、跨租户数据 |
| **T3 tenant content** | 租户 `SKILL.md`、prompt 或 household data | DSH 内容发现和模型输入；永远是 untrusted data | 任何 executable entrypoint、tool/permission/secret/bridge 注册 |
| **rejected/quarantined** | 未签名、签名无效、被撤销、未知格式、违反资源/隔离策略 | 仅保留审计和取证元数据 | 运行、scope-visible、grant、更新为同一 digest |

T1/T2 的每个 capability 仍须独立 grant。低 tier 只能缩小权限，不能通过声明更多字段
升级 trust；T0 也不能使模型直接获得设备执行 authority。

## 4. Manifest 和 package 边界

### 4.1 Manifest 是包元数据

manifest 使用独立、版本化、Zod-first 的 plugin package schema，例如：

```json
{
  "manifestVersion": 1,
  "pluginId": "example.vendor.energy",
  "version": "1.2.3",
  "publisherKeyId": "publisher-key-1",
  "entrypoint": "dist/main.js",
  "hostCompatibility": {
    "extensionApi": "1",
    "dshRelease": "0.1.0-rc.7",
    "cordis": "4.0.1"
  },
  "contributions": {
    "skills": ["skills/energy-review/SKILL.md"],
    "tools": ["energy.read"],
    "bridges": [],
    "ui": []
  },
  "permissions": ["home.read"],
  "secretRequirements": [],
  "network": { "outbound": [] },
  "filesystem": { "read": [], "write": [] },
  "process": { "spawn": false }
}
```

此示例只展示元数据形状，不代表这些声明会被批准。实际冻结 schema 必须：

- 拒绝未知顶层字段、重复键、重复 contribution、非法 id/version、绝对路径、路径穿越、
  symlink/hardlink 和超预算包；先做包/结构资源预算，再做深层 schema 校验；
- 将 `manifestHash`、package digest、signature 和生成的 permission request 作为不可变
  verification 输入；manifest 不得包含 secret value、raw token、private key 或 native ID；
- 把 trust tier、effective scope、grant、policy version 和 approval 状态留给 Hub，不接受
  插件在 manifest 里自报；
- 对扩展 metadata 采用明确命名空间和大小上限；未知 metadata 不得影响授权或加载路径；
- entrypoint 只描述隔离运行时入口，不能让插件选择 Node flags、环境变量、工作目录、
  socket、子进程权限或宿主 import 路径。

### 4.2 Skill 文件不是第二格式

包中的 `skills/**/SKILL.md` 必须是官方 DSH Skill definition；manifest 只能列出受包
containment 约束的相对路径和贡献声明。Hub 仍把它送入现有 `ctx.skills` registry，且
Skill 的 `description`、body、metadata 都是 untrusted model input。不得通过 manifest
增加 `tools:` frontmatter、脚本块、隐式 command、权限字段或另一套 loader。

### 4.3 Package store

安装器（未来实现）必须使用私有、0600 元数据/密钥引用和不可变 digest 目录；解包前拒绝
绝对路径、`..`、符号链接、硬链接、设备文件和超出文件/字节/深度上限的 archive。下载、
解包、验证和启用分别记录状态；验证失败的原始包按产品保留策略隔离，不能被 runtime
从临时目录加载。插件不能读取 Hub database、其他 plugin store、家庭根目录或 agent
credential 文件。

## 5. Capability、secret 与 scope

### 5.1 Permission declaration

能力 key 必须是 catalog/extension SDK 预登记的 canonical key，声明是最小请求：

| 能力类 | 例子 | 默认策略 |
| --- | --- | --- |
| Skill contribution | `agent.skill.contribute` | 仅按官方 DSH registry；不产生工具或 authority |
| Read-only tool/data | `home.read`, `home.observe`, `analysis.propose` | 可按租户 policy 自动 grant；输出 bounded neutral shape |
| Proposal | `home.proposal.create` | 只产生 reviewable proposal，不应用持久行为 |
| Bridge read | `bridge.read.<adapterType>` | 仅受信/隔离 adapter；通过 neutral contract、schema catalog 和 bridge registry |
| UI contribution | `ui.card.contribute`, `ui.view.contribute`, `ui.layout.contribute` | Phase 2 仅 declarative schema；读数据与 intent 仍按 scope/policy。未来 isolated app 需要独立 phase gate |
| Network | `network.outbound` + host/port allowlist | deny by default；不得由 payload 扩展 allowlist |
| Filesystem | `filesystem.read` / `filesystem.write` + virtual root | deny by default；仅插件 data dir 或声明的受控输入 |
| Process | `process.spawn` | deny by default；Phase 0/1 不授予任意 shell/child process |
| Action/artifact | `actions@1`, `artifactHost@1` | 仅 M3 action plane；逐 capability、policy、approval、ticket 授权 |

未知 capability、宽于 host allowlist 的参数、未声明的实际调用和声明/实际不一致都触发
拒绝或 quarantine，不按加载顺序取第一个定义。`permission` 不等于 DSH tool 可见；tool
必须仍通过官方 registry、scope、调用预算和 Hub policy。

### 5.2 Secret ownership

Secret 的 owner 永远是 Hub vault/家庭配置，而不是 plugin、Skill、模型或 UI。插件只声明
`{ alias, kind }` requirement，Hub 通过桥级/租户级受限视图按需 resolve：

- 不提供 vault 枚举、raw `SecretRef`、其他桥/插件/LLM provider 的 alias 或 secret export；
- `kind` 必须和声明完全匹配，alias 与 `tenantId + pluginId + generation` 绑定；
- secret 只进入隔离运行时需要的调用，禁止写入 manifest、Skill、tool result、prompt、
  URL、异常、diagnostic 或 audit；审计只保留 alias、kind、调用结果和 policy decision；
- disable/quarantine/revocation 立即撤销 resolve；rotate/rebind 后旧 grant 不复用；
- uninstall 默认不删除 vault 中的 secret，因为可能由家庭配置或其他已审计 owner 共享。
  只有 Hub 明确记录的、一次性且经用户确认的 cleanup policy 才能清除插件专属 secret，
  插件自身不能调用删除接口。

### 5.3 Scope

每个 plugin instance 绑定明确 tenant、Agent scope、bridge scope（如有）和 generation。
scope-visible 只表示该 scope 的目录/工具/Skill 能看到一个 contribution；它不表示：

- 可以读取其他 tenant、其他 bridge 或 raw native payload；
- 可以把 capability candidate 变成 `hwCapabilityId` 或 authority；
- 可以读取模型上下文、家庭审计或其他插件的状态；
- 可以把自己的 UI 点击直接变成设备 action。

所有 cross-bridge identity、remoteInstanceId、schema ownership 和 action target 仍由
Hub/homeWorld 产生，插件输出只可能成为受审核 candidate 或 proposal。

## 6. Isolation 和运行时边界

| 资源 | 默认 | 最小可接受实现 |
| --- | --- | --- |
| In-process import | 仅 T0/仓库内受信代码 | 第三方包不可直接 import Hub/Agent internals；没有证明时不加载 |
| Process | deny child process | T2 必须独立 OS process/等效 sandbox；`worker_threads` 不算安全边界 |
| Network | deny outbound | 按 manifest + host policy 的域名/IP/port allowlist；无任意 proxy、listen 或 loopback escape |
| Filesystem | deny host filesystem | 独立 package/data/temp roots；只读声明输入；禁止 Hub DB、vault、home 根目录和其他 plugin root |
| Environment | 空白最小 env | 不继承 token、SSH、shell、PATH 或宿主秘密；参数经 schema/budget 校验 |
| Resource | 有界 CPU、内存、输出、并发、队列和 deadline | 超限先 cancel，重复超限 quarantine；diagnostic bounded |
| IPC | typed broker | 只传 versioned neutral request/result；禁止传 Node handle、raw socket、native object 或可执行代码 |

进程 broker 负责 cancellation、heartbeat、restart、stdout/stderr redaction、出口网络和
文件映射。插件崩溃、失联或 dispose 超时不得污染既有一致 world snapshot；当前 action
执行状态按 `indeterminate` 处理。隔离不是授权，授权不是隔离的替代品。

## 7. Contributions 和 typed seams

### 7.1 Bridge

Bridge plugin 只能贡献 catalog 认可的 `AdapterRegistration<C>`：`configSchema`、声明的
`credentialRequirements`、已登记 `capabilitySchemas`、可选的审核
`EquivalenceMapping` 和同步纯 factory。factory 不做 I/O；联网从 `events()` 开始。

Hub 仍产生 `bridgeId` 并验证 catalog/config/registry 的 `adapterType` 三方一致；adapter
不自报类型、不选择 authority。首个 `sync-start` 必须提供 `remoteInstanceId`，变化必须
显式 rebind；schema 冲突、未知 major、header/epoch/seq/manifest/资源违规按 bridge v6.3
规则 fail closed。原始生态 payload 不越过 adapter 投影和 contracts 边界。

第三方 bridge 在 Phase 0 不进入 in-process catalog；未来隔离 bridge 也不能直接持有
全局凭证或写 journal。它通过 typed event/control seam 由 Hub ingest、registry、world
model 和 audit 归属。

### 7.2 Tool 和 Skill

Tool contribution 使用唯一 DSH tool registry，必须有稳定命名、typed schema、参数/结果
预算、scope、取消和 audit hook。只读和 proposal tool 可以在授权后运行；任何工具输出都
不能成为 policy/approval 的事实源，也不能把 native identity 送给 agent。

Skill contribution 使用唯一 DSH Skill registry；Skill 只是模型可读内容，不是工具或
plugin API。插件包中的 Skill 与 tenant Skill 一样受内容边界，不可通过正文动态注册工具。

### 7.3 Action 和 artifact

`actions@1`/`artifactHost@1` 只由 Hub action plane 暴露。插件可提交 neutral proposal、
artifact draft 或 compiler candidate，但不能消费 approval ticket、取得 nonce、指定
native route、调用 executor 或自报 risk。Hub 重新计算 risk、检查 affected
`hwCapabilityId`、bridge generation、remote identity、水位、policy 和 postconditions；
不完整或过期即回 review/fail closed。

### 7.4 UI

Phase 0 不接受插件 UI。完整 View Provider、Host Shell、语义路由与切换契约见
`frontend-layout-extensions.md`。Phase 2 UI contribution 只允许 versioned declarative
card/view/layout、label、status、bounded data query 和指向 Hub proposal/review 的 action
intent：

- 不允许任意 HTML/JS/CSS、服务端路由、iframe 逃逸、websocket、凭证读取或模型 prompt 注入；
- 仅能显示当前 scope 的脱敏 neutral snapshot、插件健康、提案和 audit 状态；
- UI 点击先进入 Hub policy/proposal/approval，不直达 bridge 或 executor；
- renderer 做 schema、长度、URL、HTML/markdown 和 accessibility 检查，插件失效时 UI
  变为 unavailable，不显示过期 authority。

两个仓库内 built-in View Provider 可以作为 T0 代码通过同一 View Registry 注册，以证明
契约没有第一方特殊通道；这不开放 third-party loader。真正的 executable View Application
不与 Host 同 origin、不同享 DOM/cookie/network/secret。只有独立 origin sandbox、CSP、
versioned broker、资源/崩溃隔离和前端 conformance 完成后，才可在 Phase 3 单独评审。

## 8. Signature、更新、回滚和兼容性

### 8.1 Verification

验证对象是不可变 package digest 加 canonical manifest；签名覆盖 digest、manifest hash、
pluginId、version、publisher key id 和 compatibility declaration。信任根由产品/租户配置
持有，插件不能自增信任根。签名通过不代表允许任何 capability。

验证失败、签名 key 被撤销、digest 重用、archive 资源超限、manifest/文件不匹配或 conformance
失败都不可进入 verified。不要把“下载来源 HTTPS”当作签名或 trust tier。

### 8.2 Update

更新以新 generation side-by-side 安装：先 install/verify，再按 policy enable，最后对每个
scope 原子替换 contribution。旧 generation 在新 generation 健康和可见前继续保持不可用
或只读 last-known，不共享新 grant；不做原地覆盖和隐式 config migration。

升级必须声明并通过：

- `extensionApi`、contracts/schema major、DSH compatibility set、Cordis 版本和 host product
  版本兼容性；当前 DSH release family 精确锁定为 rc.7/ Cordis 4.0.1；
- capability/secret/bridge binding 的新增、删除、降级和 data migration 影响；
- 最小启动、dispose、crash/restart、scope isolation、audit、rollback conformance；
- 不能在升级过程中把旧 approval ticket、bridge generation 或 action authority 迁移给新包。

未知 future major、缺少明确 migration、或向后兼容性无法证明时拒绝更新，不静默降级。

### 8.3 Rollback

回滚选择此前 verified 且未 revoked 的 generation，经过相同 enable/scope/authorization
门并写入新 audit；旧 grant 不自动复活。若远端 action/artifact 已经可能应用，回滚插件
代码不等于回滚设备状态；Hub 仍须 fresh consistent read、review 或显式 rollback proposal。
已撤销版本永不作为回滚候选。

### 8.4 Release age

24 小时发布年龄不是 trust、signature、conformance 或 compatibility 的替代品，也不应
成为本地开发阻塞项：

- development/test/local package policy **禁用** minimum publication age；测试必须使用显式
  allowlist、临时 trust root 和 isolated directory；
- public catalog 可以把“发布时间至少 24h”作为可选 supply-chain 风险控制，默认由 catalog
  policy 决定而非 core manifest；
- T0 安全修复、紧急撤销后的替代包和受审查的内部发布可由显式 policy override，但 override
  需要 publisher、操作者、原因、时间和 audit；
- age gate 只延迟安装，不把未成熟包变成 invalid，也不允许绕过 revoked/failed verification。

## 9. Audit、恢复和卸载语义

### 9.1 Audit minimum

Hub audit 至少记录：package source/digest、manifest/signature/trust result、compatibility、
每次 state gate、scope binding、grant/revoke、secret alias resolve、network/file/process
denial、tool/bridge/action invocation、resource violation、quarantine/revocation、update/
rollback、disable/uninstall，以及关联的 DSH session/turn/tool-call、proposal、approval、
watermark 和结果。记录中不存 secret value、raw token、private key、完整原生 payload 或
不必要的家庭内容。

Audit 是 Hub-owned append-only 安全事实源；插件、Skill、模型和 UI 没有删除/改写接口。
DSH session log 仍是模型交互事实源，两者用稳定 id 关联而不合并。bridge ingest journal、
Home audit 和 plugin lifecycle audit 的 retention/访问边界分别保留。

### 9.2 Retention baseline

Retention 不能由插件自行决定，也不能在卸载时隐式缩短。开源发行版应把法域、家庭删除
选择和产品安全基线合成为一项显式 Hub policy，而不是在 core contract 中硬编码一个全球
适用的期限。建议的默认基线是：

- plugin lifecycle、signature、grant、quarantine、revocation、uninstall 和 action authority
  记录：安装期间及最后一个 generation 卸载后默认 24 个月；活动 denylist、未决安全事件、
  未终结 action 或仍被 artifact/audit 引用时不得提前删除；
- 已进入 governed action plane 的 proposal、approval、execution、`indeterminate` 和
  postcondition audit：服从 action plane/Home audit 的更长 retention，不能因插件卸载缩短；
- 安全 denylist、publisher revocation 和 tombstone：直到明确安全保留期结束且没有活动
  引用；压缩只能保留 hash、时间、主体、结果和引用完整性；
- raw plugin diagnostics、stdout/stderr 和 network metadata：有界短期 retention，先脱敏，
  不得成为第二份家庭数据仓库。

如果适用法律或家庭删除选择要求更短期限，Hub 按 data-retention policy 脱敏或物理清理
可识别内容，并仅在合法、必要、明确的期限内保留不可逆 digest、状态结果、时间和安全
引用。任何清理都不得使仍有效的 action、artifact、revocation 或未结安全事件失去引用
完整性，也不得把已经发生的安全事实伪装成从未发生。

### 9.3 Uninstall/recovery

- uninstall 先撤销 grant、阻断新调用、abort/dispose、移除 scope contribution，再清理包；
  顺序失败时保持 quarantined/unavailable，不强行删除运行中的文件；
- 已产生的 proposal、evidence、snapshot provenance、journal、audit、approval 和 Hub-owned
  artifact registry 记录不删除。依赖该插件的读模型标为 unavailable/stale，不能由另一个
  同名插件重新解释旧数据；
- 由插件创建的远端 artifact 不因本地卸载自动删除或启用。若 action 已 claim，按
  `indeterminate` 恢复；后续清理必须是新的、受审查的 proposal/action ticket；
- 默认不删除 vault secret、家庭配置、bridge registry、identity binding 或历史 generation。
  可删除的 plugin-private cache 需有 Hub retention policy，不由插件自行决定；
- 重装同一 `pluginId` 是新 generation，必须重新 verify/enable/scope-visible/authorize；旧
  grant、approval、remote identity 和 native binding 绝不继承。

## 10. Conformance gates

插件进入 `verified` 前必须通过与其贡献面相匹配的 gate；缺少某个 gate 即不能通过最小
权限运行。

1. **Package gate**：canonical manifest、digest/signature、archive containment、资源预算、
   无 secret/原生身份泄漏、重复/未知字段拒绝。
2. **Lifecycle gate**：单次初始化、abort/dispose 幂等、流结束后的重启/退避、超时强制停止、
   无后台泄漏；disable/quarantine/uninstall 后旧入口均不可调用。
3. **Isolation gate**：进程/网络/文件/env/IPC deny-by-default；尝试越权、资源耗尽、崩溃和
   broker 断线的 fail-closed 与诊断有界测试。`worker_threads` 单独不得作为通过理由。
4. **Scope/secret gate**：跨 tenant/bridge/Agent scope 隔离；secret alias/kind/owner 约束；
   日志、错误、tool result 和 UI 无 secret；不可枚举 vault。
5. **Skill gate**：只用官方 DSH registry/loader；`SKILL.md` 形状、frontmatter、body、
   resource 和重名规则服从现有 provider；Skill 不可注册工具或权限。
6. **Tool gate**：typed schema、输入/输出/时间/并发预算、取消、scope 和 audit；不返回 raw
   native data，不调用 shell、executor 或未声明 capability。
7. **Bridge gate**：`AdapterRegistration` 三方 adapterType 校验、纯 factory、bridgeId/remote
   instance/rebind、schema catalog/hash 冲突、epoch/seq/manifest/journal/heartbeat、原生
   payload containment 和 synthetic bridge matrix 全部通过。
8. **Action gate**：仅在 actions/artifactHost milestone 开启；完整 immutable approval tuple、
   nonce 原子 claim、idempotency、timeout、postcondition、crash recovery、`indeterminate`
   和 no-auto-retry 证明齐全。
9. **UI gate**：仅 declarative schema、CSP/renderer containment、XSS/URL/size/accessibility、
   scope redaction；UI intent 只能产生 proposal/review，不直达设备。
10. **Supply-chain/compatibility gate**：精确 host/DSH/Cordis/contract compatibility、更新和
    回滚测试、revocation denylist、可选 age policy、generation 不复用 authority。
11. **Audit/recovery gate**：每个 gate 和调用有 Hub audit；重启、卸载、撤销、进程崩溃、半途
    action 和清理超时后既有一致视图与安全事实不被污染。

Conformance harness 的结果绑定 `packageDigest + generation + manifestHash`。仅升级文档、
版本号或权限声明也要重新验证；不能用“同 pluginId 已通过”替代当前 generation 的结果。

## 11. Phase 0/1/2 门槛

### Phase 0（当前）

允许：固定 Home Product Bundle、仓库内受信 bridge、官方 DSH Skill registry、已有受限
tenant `SKILL.md` provider、Hub neutral tools、proposal/evidence 和只读 world snapshot。

明确不实现：third-party package install/store、manifest loader、动态 executable plugin、
public catalog、plugin UI、plugin-owned network/process、plugin secret broker、bridge
marketplace、`actions@1`/`artifactHost@1` 写路径。仓库内适配器不是“插件市场”，仍受 trusted
code boundary 和 bridge conformance。Phase 0 不把 Cordis 动态装载当作授权，也不接受任意
`.js`、Skill 脚本或 manifest 来扩展工具权限。

Phase 0 exit 只要求本文作为治理边界被审查；不因设计文档存在就开启第三方代码路径。

### Phase 1（控制面和低风险扩展）

只有同时满足以下条件才开启：

- 私有 package store、不可变 digest/generation、manifest v1、签名/撤销/兼容性检查、
  install/verify/enable/scope/quarantine/disable/uninstall audit 已持久化；
- 有平台级 OS process sandbox 和 broker（没有则继续 Phase 0）；网络、文件、env、secret、
  process、CPU/内存/输出预算可测试；
- 只允许 T1/T2 的 bounded read-only、analysis、notification、proposal 和官方 DSH Skill
  contribution；工具/Skill 不产生设备 write authority；
- lifecycle、scope、secret、crash/restart、uninstall、rollback、revocation 和 conformance
  gate 有 focused + property/crash tests；
- agent-facing 输出、中立 bridge seam、Hub audit 和 existing Home policy 不被 plugin import
  或 payload 绕过。

Phase 1 默认不启用 bridge write、action/artifact host、任意 UI code、任意 child process 或
跨租户数据；本地开发可用显式 ephemeral trust root，但不能改变 production policy。

### Phase 2（受治理 bridge/UI/action 扩展）

需在真实家庭 pilot 和 action plane M3 gates 后逐项开放，而非一次打开所有插件能力：

- bridge plugin 通过中立 contracts、schema catalog、remote rebind、journal/world consistency
  和 HA/Xiaomi/synthetic conformance；
- UI 经过 declarative renderer、scope redaction、CSP/accessibility 和 proposal-only intent；
- `actions@1`/`artifactHost@1` 通过完整 approval/executor/audit/indeterminate/no-retry gate，
  并为每个 action route 明确 policy、binding generation、remote identity 和 rollback/review；
- public catalog 若启用，才评估 24h minimum publication age、publisher reputation、staged
  rollout 和 emergency override；这些是分发风控，不替代本地 verification；
- 每个 capability 单独从 Phase 1 read-only grant 提升，历史 grants 不自动升级。

Phase 2 的 UI 仅包含声明式 card/view/layout recipe。它可以形成完整 Dashboard 或不同信息
架构，但不能执行第三方 JavaScript。

### Phase 3（隔离的 executable View Application）

只有同时满足以下条件，才允许第三方布局运行自定义前端代码：

- 独立 origin sandbox，禁止访问 Host DOM、cookie、credential、service worker、任意网络和
  其他插件；CSP、frame policy 和资源预算可自动验证；
- 只通过 versioned Presentation/Intent Broker 通信；输入是 scope-filtered neutral projection，
  输出只是待 Hub 重新验证的 typed intent；
- Host Shell 始终拥有布局切换、safe fallback、身份、approval 和恢复入口；插件无法覆盖；
- mount/unmount、timeout、crash、revocation、upgrade、responsive、keyboard、screen reader、
  reduced-motion、contrast 和数据 freshness conformance 全部通过；
- executable layout 与 bridge/tool/action 权限分别授权，不能因同属一个 Plugin 包互相升级。

## 12. 现在不做和不可推断的事项

- 不创建第二套 Skill 格式、registry、loader、watcher 或 plugin-specific model tool。
- 不让 Cordis plugin registration、manifest 声明、Skill 文本、tool visibility 或 UI click
  自动授予设备/bridge/action authority。
- 不引入任意动态 `require`、shell、child process、代码执行服务、microservice、sidecar
  marketplace、向量库或远程插件自动发现。
- 不把 plugin trust tier 当作审批，不把签名当作 policy，不把 24h release age 当作安全保证。
- 不让 plugin 拥有或枚举 vault secret，不把 secret、native identity、raw event、prompt 或
  private audit 传给模型/tenant/其他 plugin。
- 不因 disable/uninstall/revocation 自动删除或重放远端 automation、action、journal、world
  state、approval、identity binding 或 audit；不自动重试可能已执行的 action。
- 不承诺跨桥全局 snapshot isolation；插件只能看到带 per-bridge watermark 的中立一致点。
- 不在 manifest 中预先冻结所有未来生态 payload 或把 open extension declaration 变成核心
  类型枚举；新 seam 必须有 canonical key、schema、权限、conformance 和独立阶段门槛。

本文接受后，任何新增 extension surface 都必须先更新对应 manifest/schema、permission
catalog、audit 事件、conformance gate 和 Phase gate；“只是 Cordis plugin”不能成为绕过
这些边界的理由。

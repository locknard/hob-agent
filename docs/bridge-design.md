# 桥接设计(Bridge Design)v6.3（冻结版）

> 状态:**已冻结；Phase 0 读侧已实现**（冻结于 2026-08-18，完成验收于 2026-08-19）。整合十一轮评审，取代所有早期版本。除非实现证明契约自相矛盾或存在安全缺陷，不再扩大设计范围；参数选择按 §7 在实现中落定。**契约编码（第 0 步）以本版为准；附录 A 为自包含冻结基线，不依赖任何被取代文档。**迁移 0–6 已落地并由合成桥、HA adapter、SQLite 恢复/权限及 agent 中立性测试覆盖；迁移 7 的 actions / artifactHost 仍按 M3 明确延期。
> v6.3（冻结修订）:开放扩展声明与 module augmentation 对齐；身份来源改为封闭判别联合；凭证材料支持 secret text / OAuth / certificate；schema catalog 增加命名空间所有权与冲突拒载；补全 WorldCapability；心跳与同步超时独立；重放禁止 device-removed；桥远端身份变化必须显式 rebind；诊断集合有界。实现审查消歧：纯 factory 无法在联网前获知远端身份，因此 `remoteInstanceId` 由首个 sync-start 回报，而不属于构造期 BridgeInfo。
> v6.2(第十轮,开工前最后消歧):重放期 heartbeat 穿插规则;manifest 对账排除重复投递(唯一 seq 口径);流终止分类与协议违规解耦(BridgeStreamError);扩展命名闭合(canonical key);AdapterRegistration 泛型化 + factory 纯构造;adapterType 三方一致校验(adapter 不自报);BridgeCredentialProvider 最小接口;journal 持久化 receivedAt;broken epoch 水位冻结;per-bridge resync coordinator;能力自动绑定默认关闭;附录 A 自包含类型清单。
> v6.1(第九轮,协议状态机消歧):adapter 重启状态机冻结(dispose→factory 新建);broken epoch 处置;heartbeat/journal 关系(流内保留+区间压缩);journal 安全硬上限提前到第 2 步;bridgeId 类型绑定(防类型劫持)+ 桥级受限凭证视图;ControlResult 封闭性(CoreReasonCode 与 adapterCode 分离);causality 引用完整性;ExtensionHandleRegistry(module augmentation);等价声明来源资格;manifest 改信封计数;跨桥一致性明示为 per-bridge。
> v6 破坏性修订(相对 v5):**sync-start 显式 epoch 边界**;**core 纯化**(cause/roomHint 移出 core,经 `ext` 事件承载;health 事件化);**bridgeId 由 hub 分配**(工厂签名与 catalog 注册项);**能力自动绑定再收紧**(默认只产提案);**present-but-invalid 存在标记**(防误判 removed);**heartbeat 活性协议**;**权威切换的一致点程序**;**核心 ReasonCode 第 0 步冻结**;**SQLite ingest journal 归迁移第 2 步**。
>
> **总则:桥中立 ≠ 桥同等可信或同等权威。中立性属于架构;权威、权限与信任属于 hub policy,永远不由 adapter payload 自己争取。**

## 0. 决议摘要

1. 中立契约唯一语言;原始 payload 不越界;HA 为普通适配器;仓库内适配器 = 受信代码,不可信适配器禁止进程内装载。
2. 内核 = info / events / health(事件化)/ control + **冻结的 BridgeAdapter 接口与 AdapterFactory 签名**;扩展经协商信封 + `ext` 流内承载,core 类型纯状态。
3. 运行协议:单流 (epochId, seq);epoch 以 `sync-start` 开、`sync-complete`(snapshotManifest)收;ingest 六步流水线;折叠不产生假缺口;heartbeat 保活。
4. 日志诚实:正常容量内合法唯一事件必落库(SQLite ingest journal,第 2 步);日志背压 pause→quarantine;缺口写 history-gap;resync 恢复一致性不伪装恢复历史。
5. 身份三层(hwId / hwCapabilityId / principal)全由 homeWorld 分配;能力绑定**默认只产提案**,自动绑定仅限显式等价声明。
6. 双权威按 hwCapabilityId;state authority 自动重裁决须经"候选 resync → 一致快照 → 原子切换"程序;action authority 无隐式换路、无字典序兜底、无配置即无权威。
7. schema 准入 = catalog 已登记 (schema, majorVersion);词表非门槛,已审核 schema 是门槛。
8. 第 0 步冻结:内核四面 + BridgeAdapter/AdapterRegistration + 协商信封 + ExtensionHandleRegistry + **核心 ReasonCode** + 附录 A(自包含基线)。

## 1. 分层与装载

```
生态 adapter(受信代码;原生协议;payload 投影;原始字节上限)
      ↓ 中立契约(contracts/:zod 为源)
BridgeAdapter(§2.2)
      ↓
homeWorld:ingest(六步流水线+journal+诊断)/ identity(三层身份+identity-link)
          / worldview(reducer+影子+水位+双权威+连接状态机)/ registry(catalog+schema 登记+优先级)
      ↓
agent 中立工具(零生态 import;读一致点;不可用扩展 fail closed)
```

**catalog 注册项(v6)**:每个适配器类型注册——`configSchema`(zod)、`credentialRequirements`(凭证经 CredentialProvider 注入,不入 config)、`factory`、其命名空间 capability schemas、受审核的跨桥能力等价 mapping(§2.6)。配置与 secret 由此真正中立化。

**bridgeId 类型绑定(v6.1,防类型劫持)**:registry 持久记录 `{ bridgeId, adapterType, createdAt, generation }`。同一 bridgeId 变更 adapterType → **fail closed**,或走显式 bridge migration 提案(收件箱);普通配置修改不得悄悄让新 adapter 继承旧身份绑定、权威、journal 与凭证作用域。

**远端实例身份绑定(v6.3)**:adapter 连接成功后的首个 `sync-start` 必须回报稳定的 `remoteInstanceId`，registry 将其与 bridgeId 绑定。URL、账户、installation id 等身份相关配置发生变化，或新 epoch 回报不同 remoteInstanceId 时，不得接受该 epoch、沿用旧 journal、权威与设备绑定；必须 fail closed 并走显式 rebind/migration 提案。凭证轮换不改变远端实例身份。factory 只完成纯构造，不能提前伪造或猜测远端身份。

**桥级受限凭证视图(v6.3)**:factory 收到的 CredentialProvider 是 **scoped 视图**(global vault → scope(bridgeId, 声明的 requirements) → factory):禁止枚举;只能解析该桥声明的 alias，且返回材料 kind 必须匹配 requirement;alias 与 bridgeId 绑定;不返回其他桥或模型 provider 的凭据;凭证错误信息不含 secret。`credentialRequirements` 是执行边界,不是文档信息。

```ts
interface AdapterRegistration<C> {        // 注册处保有正确配置类型;registry 内部可类型擦除
  adapterType: string;
  configSchema: ZodType<C>;
  credentialRequirements: readonly CredentialRequirement[];
  capabilitySchemas: SchemaRegistration[];
  equivalenceMappings?: EquivalenceMapping[];   // 受审核跨桥等价;schema 未定稿前本项无效(§2.6)
  factory(ctx: AdapterFactoryContext<C>): BridgeAdapter;   // 同步、纯构造;一切联网从 events() 开始,禁止 factory 内 I/O
}
interface AdapterFactoryContext<C> {
  bridgeId: string;                        // hub 分配;BridgeInfo 仅回显 bridgeId
  config: C;
  credentials: BridgeCredentialProvider;   // 桥级受限视图,见附录 A
}
```

`bridgeId` 是身份绑定、权威策略、journal、凭证作用域、审计的根,**由 hub 配置分配**;适配器升级/重装不得产生"新桥"。
**adapterType 三方一致(v6.2,adapter 不自报)**:adapterType 只存在于 catalog 注册、配置条目、registry 持久记录三处;hub 校验三者一致才调用 factory;BridgeInfo **不含 adapterType**——adapter payload 不参与类型身份判定。

## 2. 读侧内核

### 2.1 info 与版本

```ts
interface BridgeInfo {
  bridgeId: string;                    // 回显 hub 分配值
  coreVersion: string;                 // 主版本不匹配 → 拒载整桥
  ecosystem: string;
  heartbeatIntervalMs: number;         // 静默期内必须发 heartbeat 的最大间隔(默认 60s)
  extensions: readonly ExtensionDeclaration[]; // 开放集合;主版本不匹配 → 仅该扩展不可用
}
```

### 2.2 BridgeAdapter(冻结)

```ts
interface BridgeAdapter {
  readonly info: BridgeInfo;
  events(signal: AbortSignal): AsyncIterable<Envelope>;
  readonly control: BridgeControl;
  extension<K extends keyof ExtensionHandleRegistry>(name: K): ExtensionHandleRegistry[K] | undefined;  // name = canonical key(§3)
}

interface ExtensionHandleRegistry {}      // v6.1:module augmentation 模式——各扩展包自行注册,core 永不因扩展重发布
// declare module "@hob/bridge-contract" { interface ExtensionHandleRegistry { "actions@1": ActionsExtension } }
// extension<K extends keyof ExtensionHandleRegistry>(name: K): ExtensionHandleRegistry[K] | undefined
// causality / orgHints 经 ext 事件承载,无独立 handle
```

生命周期(冻结):订阅唯一(重复订阅=编程错误);声明了扩展但 handle 缺失=声明无效,该扩展不可用+审计。
**重启状态机(v6.1 冻结,adapter 只需支持一次生命周期)**:

```
events() 正常结束或抛错
→ abort 当前订阅 → await control.dispose()(旧实例终态)
→ 退避 → factory 新建实例 → 校验 BridgeInfo(bridgeId 回显一致)
→ 启动新订阅(必然新 epochId,以 sync-start 开始)
```

不存在"对同一实例二次调用 events()"的路径。
**流终止分类(v6.2,与协议违规解耦)**:`events()` 抛错须为 `BridgeStreamError { reason: "upstream_unavailable" | "authentication_failed" | "rate_limited" | "protocol_error" | "internal_error" }`;未知异常归 internal_error。**只有 reason="protocol_error" 计入 protocolViolationCount**——协议违规仅来自 header 不合法、seq/epoch 违规、core schema 违规、生命周期约定违反;网络断开、DNS、上游超时、token 失效是环境故障,走各自的退避与告警曲线,不得把好桥送进 quarantine。

### 2.3 事件集与 epoch 边界

```ts
interface Envelope { epochId: string; seq: number; event: BridgeEvent }

type BridgeEvent =
  | { kind: "sync-start"; snapshotId: string; remoteInstanceId: string; reason: "initial" | "resync" | "resume" | "upstream-reset" }
  | { kind: "device-upserted"; device: DeviceDescriptor }
  | { kind: "device-removed"; nativeId: string }
  | { kind: "state"; state: StateEvent }
  | { kind: "device-health"; nativeId: string; status: "reachable" | "unreachable" | "unknown" }
  | { kind: "bridge-health"; status: "up" | "degraded"; clockOffsetEstimateMs?: number;
      extensionAvailability?: Partial<Record<string, "available" | "unavailable">> }
  | { kind: "heartbeat" }
  | { kind: "ext"; ext: string; payload: unknown }     // 扩展流内承载,见 §4.0
  | { kind: "sync-complete"; manifest: SnapshotManifest };

interface SnapshotManifest {   // v6.1:信封计数——payload 非法时也可数;规范能力数由 hub 从合法 descriptor 推导,不由 adapter 自报
  snapshotId: string;
  deviceEnvelopeCount: number;
  stateEnvelopeCount: number;
}
```

**epoch 规则(v6)**:
- 新 epoch 首条必须 `sync-start, seq=1`;收到即创建影子状态、启动重放 timeout。未经 sync-start 出现的新 epochId = 协议违规(丢弃+计数)。
- 重放序:sync-start → 全量 device-upserted(各设备紧随其 state 与 device-health)→ sync-complete(同 snapshotId)。重放期实时变化由 adapter 缓存,sync-complete 后按序发出。
- **重放期穿插(v6.3)**:`heartbeat` 与 `bridge-health` 可在重放期间穿插发出:seq 属当前 epoch、不计入 manifest 对账、不改变影子状态。心跳超时与同步超时是两条独立时钟：静默超过 `2×heartbeat 生效间隔` 判连接 down；超过 syncTimeout 仍未 sync-complete 判同步失败。长重放必须持续发 heartbeat，不能用 syncTimeout 掩盖死连接。
- `requestResync()` 返回 completed 仅表示**请求被接受**;同步完成只由对应 epoch 的 sync-complete 判定。
- epoch 新旧由订阅生命周期确定;旧 epochId 迟到事件丢弃计数。
- **broken epoch(v6.1;v6.2 收紧水位语义)**:发现缺口(seq>高水位+1)→ 当前 epoch 立即标记 `broken`:**高水位冻结在缺口前的值,此后永不推进**;写入开放的 history-gap;缺口后的事件不进入正常 journal、不进入 reducer——只进**有硬上限的 diagnostic sample**(不逐条写 rejection ledger,防故障流放大磁盘);requestResync accepted 后等待**不同 epochId** 的 sync-start,超时 → quarantine;新 epoch sync-complete 后关闭 history-gap——**恢复的是当前一致状态,不是丢失的历史**。诊断状态永不伪装成已完整消费。
- **heartbeat(v6.1 细化)**:静默超过 heartbeat 间隔适配器必须发 heartbeat;间隔由 adapter 声明但 **hub 施加上下限钳制**;hub 静默超 2× 生效间隔 → connectionState down → 走重启状态机。`paused` 状态暂停 heartbeat 超时判定(或由成功 control 响应维持活性)。`lastSuccessfulContactAt` 在 **ingest 实收时**更新(事件/heartbeat/成功 control 响应),不等 journal 落盘——日志拥堵不得被误判为断线。
- **重放删除语义(v6.3)**:sync-start 与 sync-complete 之间禁止 `device-removed`；全量快照中的删除只由“上一一致视图存在、当前合法 descriptor 与 quarantined presence 均缺席”推导。sync-complete 后的增量流才允许 device-removed。
- **health 语义**:device-health 为**增量**(仅变更时发,重放时逐设备发全量);bridge-health 为整桥状态。无界 Record 不存在,与 Envelope 大小上限自洽。

### 2.4 ingest 六步流水线(次序不可变)

```
1. 资源预算:adapter 侧在解析原生网络 payload 前执行原始字节上限;hub 侧执行结构预算
   (字段数/嵌套深度/字符串长度/序列化估算)。zod 是校验不是资源隔离;进程内 adapter 属受信代码,
   双层责任必须写明;进程外(方向 C)才有真正的 transport 帧限。
2. 最小 header 校验(epochId/seq/kind)——不过关 = 桥协议违规,不推进水位,无设备级归因
3. 去重(≤高水位丢弃)与连续性检查
4. payload schema 校验
5a. 合法:事务性追加 ingest journal + 推进高水位(原子,崩溃注入测试保障)
    · journal 行为 IngestRecord { bridgeId, receivedAt, envelope }(v6.2):receivedAt 在 ingest 实收时生成,
      与 envelope、高水位同一事务落库——学习环的接收时间、history-gap 边界、sourceTsQuality=none 的回退时间均以此为准
    · heartbeat 特例(v6.1):留在流内(其序号顺带证明此前有序事件均已送达),但 journal 将连续
      heartbeat 压缩为**连接区间记录**(from/to/count),不逐条落库;压缩策略随第 2 步一起交付
5b. 非法:追加 rejection ledger(**尽力提取 nativeId 记 presence**)+ 推进高水位
6. 折叠(仅 state,按 (nativeId, nativeInstanceId) latest-wins)→ reducer / 隔离裁决
```

- 折叠不变量:折叠在定序与落库之后、reducer 之前;只保护 reducer,不影响定序与历史;折叠计数入诊断,学习环对折叠窗口降权。
- **present-but-invalid(v6,防误判 removed)**:重放中 descriptor 校验失败但 nativeId 可提取 → 影子状态记 **quarantined presence 标记**。交换时三分:manifest 内未出现且无 rejection presence → removed;出现但 descriptor 非法 → **present-but-invalid**(保留 last-known descriptor,能力标 invalid-source);descriptor 合法而 state 非法 → 该能力 invalid-source。nativeId 不可提取的按协议违规计,由 manifest 数额不符挡住误交换。
- 确定性坏设备(rejection ledger 跨多次 resync 佐证)→ 隔离该设备能力 + 审计,不判整桥。
- manifest 核对(v6.3 定死口径):hub 侧统计量为 **acceptedUniqueReplayEnvelopeCount**——过 header 校验、属当前 epoch 重放区间、**按 seq 去重后唯一**、kind 仅 device-upserted/state、包含 payload-rejected、不含 heartbeat/health/ext/sync-start/sync-complete;分别对照 manifest 的 deviceEnvelopeCount/stateEnvelopeCount,不符 → 不交换 + degraded(at-least-once 的重复投递不得造成误判)。规范能力数由 hub 从合法 descriptor 推导。snapshotId 为切面标识,非原子性证明;manifest 是传输一致性检查,非完备性证明。

**日志语义(诚实)**:正常容量内所有过校验的唯一事件落库;日志背压 → pause → 无法 pause 则 quarantine(不做 resync 循环);缺口写 `history-gap`(桥/窗口/原因),学习环跨 gap 降权,dry-run 披露;resync 只恢复当前一致性。总规则:缓冲丢弃后无法续传 ⇒ 开新 epoch。读侧只见上一个一致点:**桥的失效永远不污染已有一致视图**。

### 2.5 状态与 schema 准入

```ts
interface AdapterCapabilityRef {
  nativeInstanceId: string;   // 派生自稳定原生标识(HA=entity registry 不可变 id;Z2M=IEEE+endpoint;Mi=siid/piid);绝不用显示名
  schema: string;             // "hob.*" 或 catalog 已登记的生态命名空间
  schemaVersion: string;
}
interface DeviceDescriptor {
  nativeId: string;
  name?: string;                        // name 是核心描述信息;roomHint 已移入 orgHints 扩展(v6)
  capabilities: AdapterCapabilityRef[];
  via?: string[];                       // 拓扑 hint
  identityClaims?: IdentityClaim[];
}
interface StateEvent {                   // v6:core 纯状态,cause 移入 causality 扩展承载
  nativeId: string; nativeInstanceId: string;
  attrs: Record<string, JsonValue>;      // 完整当前值(绝对快照)
  time: TimeMeta;                        // { sourceTs?, sourceTsQuality };receivedTs 由 hub 盖章
  origin: "observed" | "imported";
}
```

schema 准入:homeWorld 只接受 catalog 已登记 (schema, majorVersion);未登记 → 隔离该能力 + `unsupportedSchemaCount`;所有 schema 受资源限制;agent 工具对命名空间能力默认只显示安全摘要。词表非门槛,已审核 schema 是门槛。时间消费:`device > platform > none→退 receivedTs 且降权`。

**catalog 冲突与命名空间所有权(v6.3)**:catalog 对每个 `(schema, majorVersion)` 计算规范 schema hash；相同键的重复注册只有 hash 完全一致才可接受，否则整座冲突 adapter 拒载，禁止按加载顺序覆盖。`hob.*` 仅由 core 注册；生态命名空间必须在 catalog 中绑定唯一 adapterType（如 `ha.* → home-assistant`），跨命名空间映射只能走受审核 EquivalenceMapping。

### 2.6 身份三层

- **设备 hwId**:claim 资格约束(自动合并仅设备自报/独立来源确定性匹配;平台注册表来源→提案);identity-link 审计。
- **能力 hwCapabilityId(v6 再收紧;v6.1 补来源资格;v6.2 定默认)**:**自动绑定默认关闭**——在 EquivalenceMapping schema 定稿并入 catalog 前,每个 adapter capability 初始获得独立 hwCapabilityId,一切跨桥合并只产提案;mapping schema 定稿后,仅 catalog 受审核 mapping 与 hub 本地配置可启用自动绑定。来自设备/平台 payload 的 role/channel claim、adapter 运行时自称的"等价"→ 永远只产提案(与 identity claim 资格约束同一原则)。"同 hwId + 同 schema + 双方唯一"不自动绑定(室内/室外双温探反例);带 action 的绑定提案强制人工。一切仲裁/归并/查询以 hwCapabilityId 为单元。第 2 步按"默认关闭"实现,不为赶工临时设计合并格式。
- **principal**:平台 user ID 不入模型;无映射时桥域盐化;身份表归一。
- 隔离语义:被隔离能力保留 last-known 值 + `validity: "stale" | "invalid-source"`;unknown 仅限从未见过。

### 2.7 双权威(按 hwCapabilityId)

- **state authority**:可信配置 → 能力可用性 → 字典序兜底(仅读侧)。**切换程序(v6)**:结构变化 → 候选权威 → 对候选桥 requestResync → 候选完成一致快照(其 sync-complete)→ **在一致点原子切换 authority + 当前值**;切换前继续展示旧权威 last-known 并标 stale。不采用"直接用旧日志值"或"干等新事件"。
- **per-bridge resync coordinator(v6.2)**:权威候选变化引发的 resync 按桥合并——并发请求合一;进行中的 resync generation 可满足多个 capability 的候选切换,新请求附着当前 generation;当前 generation 不含目标绑定时才排下一次;权威原子切换按同一个 sync-complete **批量**完成。能力级仲裁不得在桥级控制面制造 resync 风暴。
- **候选缺席(v6.3)**:候选桥完成一个合法一致快照后仍未包含目标 binding，或目标 binding 为 present-but-invalid，则本次切换失败并报告 unavailable/invalid-source；不得无限排队 resync。旧权威 last-known 继续保留并标 stale。
- **action authority**:无隐式换路;自动变更仅限预批准 action routes 或同一已批准执行域;其余 → unavailable → 重绑定提案 → 批准 → policy 更新;**无配置即无权威(fail closed),禁止字典序兜底**;瞬时不可用一律 fail closed。
- `via` 不参与任何裁决。
- **跨桥一致性明示(v6.1)**:一致点是 **per-bridge consistency**,不是全局事务——各桥独立影子交换,世界视图携带**水位向量**(每桥各自的 lastSyncCompleteAt);dry-run 报告列出所涉各桥的水位与 freshness;**不承诺跨生态 snapshot isolation**。"一致视图"永远指桥内一致 + 向量标注,不得被理解为全家原子快照。

### 2.8 诊断(hub 自算)与 control

```ts
interface HubBridgeDiagnostics {
  connectionState: "starting" | "syncing" | "ready" | "degraded" | "paused" | "quarantined" | "down";
  lastSyncCompleteAt?: string; lastEventReceivedAt?: string; lastSuccessfulContactAt?: string;
  droppedInvalidCount: number; strippedFieldsCount: number; staleEpochDropCount: number;
  foldedStateCount: number; unsupportedSchemaCount: number; protocolViolationCount: number;
  historyGapCount: number;
  recentHistoryGaps: Array<{ from: string; to: string; reason: string }>; // hub 固定上限;完整记录在 journal
}

type CoreReasonCode =              // v6:第 0 步冻结;生态细节用命名空间 code,不得直入 agent
  | "timeout" | "cancelled" | "protocol_error" | "invalid_payload" | "unsupported"
  | "not_ready" | "resource_exhausted" | "upstream_unavailable" | "internal_error";

type ControlResult = {          // v6.1:封闭核心语义;adapterCode 仅诊断
  status: "completed" | "unsupported" | "failed";
  reason?: CoreReasonCode;      // 核心状态机只读取此字段,可穷尽判断
  adapterCode?: string;         // 命名空间格式 + 长度限制,仅诊断;未知 code 由 adapter 映射为 internal_error / upstream_unavailable
  detail?: string;
};
interface BridgeControl {
  requestResync(signal: AbortSignal): Promise<ControlResult>;   // completed = 请求被接受(§2.3)
  pause?(signal: AbortSignal): Promise<ControlResult>;
  resume?(signal: AbortSignal): Promise<ControlResult>;
  dispose(): Promise<void>;
}
```

detail 纪律:大小上限、脱敏、不直入 agent prompt 或用户文案;机器语义走 ReasonCode。三指标各答各题(一致性/事件活跃/连接活性)。

## 3. 契约包边界与扩展命名闭合

zod 为源。**第 0 步冻结:内核四面 + BridgeAdapter/AdapterRegistration + ExtensionDeclaration 信封 + ExtensionHandleRegistry(空接口,module augmentation)+ CoreReasonCode + `ext` 事件外壳 + 附录 A 全部类型**。各扩展 payload schema 随首个真实使用定稿。

ExtensionDeclaration 是开放数组项，不在 core 中枚举扩展名字；扩展专属声明元数据由对应扩展 schema 校验。这样新增扩展只需扩展包注册 module augmentation 与 schema，不要求 core 重发。

**扩展命名闭合(v6.2,唯一口径)**:声明用 `{ id: "actions", version: "1.2.0" }`;homeWorld 协商后解析为 **canonical key = `<id>@<major>`**(如 `actions@1`);`extension()` 的入参、ExtensionHandleRegistry 的键、`ext` 事件的 `ext` 字段,三处**共用同一 canonical key**,不存在第三种命名。

## 4. 扩展

### 4.0 流内承载(v6)

扩展的逐事件数据经 `{ kind: "ext"; ext: string; payload: unknown }` 在同一流内承载(享受 epoch/seq 定序);`ext` 字段 = canonical key(`<id>@<major>`,§3);该扩展启用且 schema 已登记时按其 schema 校验,未启用/未知 ext → 丢弃 + 计数(扩展级,不算协议违规)。
- **causality**:`payload = { refSeq: number; cause: CauseRef }`,回指同 epoch 内被注释的 state 事件。CauseRef 为判别联合(user→principalRef / foreign_rule→ruleRef / hob_artifact→artifactId / physical / unknown),平台原生 ID 不入模型。**引用完整性(v6.1)**:causality ext 必须紧随目标 state(最大 seq 距离,默认 32);只能引用已过校验、已入 journal 的 state;无效引用(目标非法/被拒/非 state/超距/跨 sync-complete)→ **extension rejection ledger**,不影响 core 高水位;reducer 折叠不删除 journal 中的因果关系;**当前世界值永不等待 cause**——cause 是事件证据,不影响状态可见性,reducer 不为其停留。
- **orgHints**:`payload = { nativeId: string; spatialDisposition?: "non_spatial"; roomHint?: string; personHints?: ... }`;一律 hint,bootstrap 核对后入工作区。缺失 `spatialDisposition` 恒为未知；适配器只能从结构化源事实声明 `non_spatial`，不得从名称或能力类型猜测。

### 4.1 actions(M3):indeterminate 禁自动重试、高危上浮;幂等两层(homeWorld 治理/审计 + adapter 执行边缘);只发 action authority。
### 4.2 history:`fetchHistory(range)`,origin 恒 imported,证据降权,dry-run 声明血统。

`history@1` 的最小 handle、预算、独立 imported-history 分区、resync stale、
去重与 recorder 完整度规则冻结于
[`docs/bridge-history-profile.md`](./bridge-history-profile.md)。REST 是首个
实现 transport；历史读取不得推进 live watermark、不得进入 snapshot manifest，
也不得由 recorder 时间线推断 cause。
### 4.3 foreignRules:清单/启发式警告/证据/防重复提案/低保真迁移;不承诺确定性干涉模拟;steps 上限 64KB;IR 未来工作(双驱动:迁移保真 + 干涉模拟);归属以制品登记簿裁决。
#### 4.3.1 automationTrace companion:`automationTrace@1` 是 ForeignRules profile 的独立只读 companion handle；只接受精确 live context 关联,不接受 recorder 时间匹配,不暴露 raw trace,不写 journal/watermark/world。请求、降级 reason、epoch/resync 规则冻结于 [`docs/automation-trace-profile.md`](./automation-trace-profile.md)。
### 4.4 artifactHost:随写路径里程碑;登记簿彼时实现,唯一真相源;平台标签仅 hint。

## 5. 参考实现与测试

- **HA**:entity registry 不可变 id → nativeInstanceId;registry+states → 重放;subscribe_events+context → state / causality-ext;entity→device 聚合凭 device registry,归适配器单测(改名不迁移身份为第一断言)。
- **Mi**:siid/piid 映射;history 有限、causality partial、artifactHost false。
- **合成参考桥**覆盖:声明组合与降级、声明/实现不符、sync-start/epoch 违规、resync(超时/熔断/manifest 不符/坏设备隔离/present-but-invalid)、背压两路、heartbeat 静默、缺口、能力绑定(等价声明自动 vs 唯一同 schema 只产提案)、双权威(含切换程序与 action 无配置 fail closed)、ext 承载、schema 准入、control 各结果码、bridgeId 回显不符拒载。
- **性质测试**(随机化):at-least-once 不变性、epoch 交替、溢出折叠、影子交换原子性、折叠不产生假缺口、journal 追加与水位推进原子性(崩溃注入)、正常容量内合法唯一事件必落库、present-but-invalid 永不误判 removed。

## 6. 迁移计划

0. 契约入 contracts/(冻结范围见 §3)。
1. 合成参考桥先行,CI 常驻。
2. homeWorld 落地(四分块)+ **最小 SQLite ingest journal**(信封/rejection/history-gap/高水位四职责;崩溃注入测试在此步)。**journal 安全硬上限随本步交付,不得推迟(v6.1)**:磁盘硬配额、heartbeat 区间压缩、最低保留窗口、逼近上限 → pause/quarantine、无法保留 → history-gap、SQLite 文件权限 0600、敏感字段不入日志文本。分层归档与聚合表仍归第 6 步。不含制品登记簿。
3. HA 投影(原始 payload 禁越界;派生纪律单测)。
4. agent 中立化(inject homeWorld;契约形状输出;一致点 + 三指标)。
5. 组合根与配置(catalog:configSchema/credentialRequirements/factory/schemas;bridgeId 由 hub 分配;受信代码边界)。
6. P1 折叠:**world-model 索引、聚合表、保留与压缩策略**(journal 已于第 2 步存在,此步只加读模型)。
7. 写路径随 M3:actions + artifactHost + 制品登记簿;各扩展启用时定稿 schema 并补降级测试。

守卫(常驻 CI):agent 层零生态引用;hub 核心不 import 适配器;合成桥全绿;"只对 HA 形状可用"=构建失败。
非目标:不引入新进程/自动发现;契约不投机扩张;ForeignRuleIR 未来工作。

## 7. 仍待定(参数级)

- EquivalenceMapping schema 定稿(定稿前自动绑定保持关闭,§2.6);指纹归一化规则表;20 种 `hob.*` 起步词表与 instanceId 命名约定。
- 桥优先级 / action routes 配置面;重放硬上限、resync/熔断/退避、背离阈值、heartbeat 默认值。
- 命名空间 ReasonCode 词表;detail 脱敏规则。
- journal sizing 与高负载验证;保留/压缩策略(承接 ARCHITECTURE 7.4)。
- actions 幂等保存期限、indeterminate 确认策略(M3);ForeignRuleIR 评估(Phase 1)。

## 附录 A:自包含核心类型清单(第 0 步冻结基线)

正文引用而未定义的类型在此定义;本附录 + 正文 §2/§3 = 可独立编码的完整契约,不依赖任何被取代文档。

```ts
// ---- 基础值与时间 ----
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
interface TimeMeta { sourceTs?: string; sourceTsQuality: "device" | "platform" | "none" }

// ---- 身份 ----
interface IdentityClaim {
  type: "mac" | "ieee" | "serial" | "miotDid" | "other";
  value: string;
  source:
    | { kind: "device_reported" }
    | { kind: "independent_registry"; registry: string }
    | { kind: "platform_registry"; platform: string }
    | { kind: "inferred"; method: string };
  confidence: "high" | "medium" | "low";
}

// ---- 扩展协商 ----
interface ExtensionDeclaration {
  id: string;
  version: string;
  metadata?: JsonValue;                  // 对应扩展 schema 校验;core 不解释
}
interface ExtensionHandleRegistry {}      // 各扩展包 module augmentation 注册,键 = canonical key(§3)

// ---- 凭证(桥级受限视图;桥专用 seam,不复用模型层 provider)----
type CredentialKind = "secret_text" | "oauth" | "certificate";
interface CredentialRequirement { alias: string; kind: CredentialKind }
type CredentialMaterial =
  | { kind: "secret_text"; value: string }
  | { kind: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: string }
  | { kind: "certificate"; certificatePem: string; privateKeyPem: string; caPem?: string };
interface BridgeCredentialProvider {
  resolve(alias: string): Promise<CredentialMaterial | undefined>; // kind 必须与声明一致
  describe(alias: string): Promise<{ configured: boolean }>;
  // 不提供:枚举 / raw vault / SecretRef / 其他桥或 LLM provider 的 alias
}

// ---- schema 登记与资源预算 ----
interface SchemaRegistration<T extends Record<string, JsonValue> = Record<string, JsonValue>> {
  schema: string;                        // "hob.*" 或命名空间
  majorVersion: number;
  attrsSchema: ZodType<T>;               // zod 为契约源,受 hub-owned ResourceBudget 约束
  canonicalHash: string;                 // catalog 冲突检查;不得由加载顺序覆盖
}
interface ResourceBudget {               // 缝隙结构预算(zod 是校验不是资源隔离)
  maxFields: number; maxStringLength: number; maxDepth: number; maxSerializedBytes: number;
}
interface EquivalenceMapping {           // schema 待定稿(§7);定稿前 registry 忽略本项
  // 占位:跨桥能力等价的受审核声明
}

// ---- hub 分配的规范世界身份 ----
interface WorldCapability {
  hwCapabilityId: string;
  hwId: string;
  schema: string;
  bindings: Array<{ bridgeId: string; nativeId: string; nativeInstanceId: string }>;
}

// ---- journal 行 ----
interface IngestRecord { bridgeId: string; receivedAt: string; envelope: Envelope }

// ---- 流终止 ----
class BridgeStreamError extends Error {
  reason: "upstream_unavailable" | "authentication_failed" | "rate_limited" | "protocol_error" | "internal_error";
}
```

其余核心类型(Envelope、BridgeEvent、SnapshotManifest、DeviceDescriptor、AdapterCapabilityRef、StateEvent、BridgeInfo、BridgeAdapter、AdapterRegistration、AdapterFactoryContext、BridgeControl、ControlResult、CoreReasonCode、HubBridgeDiagnostics)已在正文定义,以正文为准。`ZodType` 由契约包显式从 zod 导入。`ValidatedConfig` 概念由 `AdapterRegistration<C>` 的泛型 `C` 取代,不再作为独立类型存在。

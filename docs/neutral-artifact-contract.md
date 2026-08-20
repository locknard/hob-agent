# M3b 中立自动化 Artifact Contract

> 状态：M3b 基础已部分实现。严格 Artifact revision/schema/hash、三类动态 assessment、
> 不可变 SQLite Registry、生产进程中的只读服务边界和精确 approved Proposal revision
> source gate 已经落地。新的 automation Proposal 还必须携带一个经 Hub 重新校验、可在
> Inbox 精确审阅的闭集中立 ECA candidate；旧 Proposal 仍可读取但不能成为 Artifact source。
> Hub-only Artifact producer core 已能从精确 source gate 幂等生成 revision 1，但尚未挂入
> 生产组合；EvidenceProducer、AuthorityProducer 的 unmounted core 已能分别从 approved
> Proposal + HomeWorld query/snapshot port、以及 Hub-private fresh-world opaque binding input
> + candidate registry 生成 immutable assessment；notify-only authority scope 明确为空。
> 三类 assessment 的动态输入 identity、Artifact Registry 持久化（含 risk 对
> evidence+authority 的 exact cross-check）和私有 authority candidate registry core 已实现并
> 测试。Artifact Registry 的只读查询已由 HomeArtifactService 接入生产；unmounted
> HomeWorldAuthorityBindingSource、ArtifactRiskConflictSource 与 RiskProducer core 已实现，
> unmounted private coordinator 已能顺序生成并交叉校验完整 receipt；fresh current-catalog
> conflict refresh 和 production mutation wiring 尚未接入。
> `ActionAuthorityConfiguration` 的 Hub-private projection 现在要求 `configIdentity` +
> `configRevision`；compiler、dry-run、approval ticket 和执行器仍未实现。
>
> 本文定义 M3b 之后第一版（下文称 Artifact Phase 1）的最小、可持久化、不可执行 artifact
> 形状。它复用已有 proposal v1、HomeWorld、证据和 Bridge v6.3 语义；不修改当前
> `contracts/`，不把 Home Assistant、Xiaomi 或其他生态词汇放进中立 contract。

## 0. 决策摘要

1. **Artifact 是 Hub-owned 的中立事件—条件—动作（ECA）文档，不是 Agent tool、Skill、bridge payload 或远端规则。**Agent 可以提出 proposal，之后由 Hub 产生 artifact draft；模型、插件和 bridge 不能直接写 Artifact Registry。
2. 每个 artifact revision 是不可变记录。`artifactId + revision` 不复用；`contentHash` 是稳定行为意图 canonical payload 的 SHA-256。只有行为意图、ECA、rollback、postcondition 或 source proposal revision 改变才产生新 revision；动态 assessment 刷新只产生新的 attestation/dry-run identity。
3. Phase 1 只允许一个小型中立闭集：有界 schedule 或 capability-change trigger；AND 条件；`set_level`、`set_boolean`、`notify_local` 三种动作；显式 previous-state rollback 或 no-remote-change。不得携带表达式、模板、脚本、URL、provider payload 或任意 JSON action。
4. Artifact 行为意图中的设备目标只引用 Hub-owned `hwCapabilityId`。动态的 action authority candidate 只出现在 Hub-owned authority assessment、compile/dry-run attestation 和 M3d ticket；Artifact/hash 不绑定某次 bridge route。
5. Hub 产生的 per-bridge consistent watermark、coverage、policy risk 和 authority candidate 都是绑定 artifact ref/hash 的不可变 assessment/attestation。水位、policy 或 bridge authority 刷新不改 artifact revision；模型不能提交 epoch、seq、coverage、risk 判定或 authority。
6. M3b 只有非应用的 registry、revision/hash、状态和审计；M3c 才有纯读 compiler/dry-run；M3d 才有 exact approval ticket/executor seam。任何阶段都不能由 artifact 直接写设备。
7. 第一用例是**窗帘舒适度**的可逆时段试验：以 schedule/中立 capability 状态触发，向一个受 Hub authority candidate 绑定的 level capability 提交 bounded level change，并能恢复此前值。Artifact contract 只表达中立 level，不表达任何生态平台的 entity、service、rule 或 payload。

本文的 “Artifact Phase 1” 是 M3b 的第一版 artifact contract，不是把项目当前 Phase 0 的
review-only 边界提前变成执行能力。当前生产组合只挂载 Registry 的只读查询和元数据诊断；
没有面向 Agent、Inbox、bridge 或插件的 Artifact 创建入口，也不编译、模拟或应用 artifact。

## 1. 与现有产品边界的关系

```text
DSH Home Agent
  -> proposal v1（意图、Hub 绑定的 evidence、review）
  -> Hub Artifact Registry（不可变 artifact revision）
  -> M3c compiler + dry-run（读取最新 attestation，产生新的只读结果 identity）
  -> M3d exact approval ticket（绑定 proposal + artifact ref/hash + 最新 attestation）
  -> 后续 Hub executor / actions@1 / artifactHost@1
```

现有 proposal 仍是人审对象，现有 `applicationStatus: "not_available"` 语义不变。批准
proposal 只表示人接受该 proposal 的 review 结果；它不等于 artifact 已编译、已模拟、已
安装、已启用或已执行。M3d 的 approval ticket 必须再次绑定完整的 artifact revision/hash
和 compiler/dry-run 事实。

### 1.1 所有权

| 对象 | 所有者 | 允许的操作 | 不允许的操作 |
| --- | --- | --- | --- |
| Proposal v1 | Hub proposal service/store | Agent 通过 governed tool 创建 pending draft；人审 approve/reject | 直接生成远端操作或覆盖 artifact |
| Artifact revision | Hub Artifact Registry | Hub 从 proposal 产生 draft；追加 revision、状态和 audit | Agent、Skill、bridge、Inbox 直接写任意 artifact |
| Compiler/dry-run result | Hub compiler seam | 读 artifact/world cut，返回 neutral plan/diff/conflict | 连接 bridge 写路径、修改 artifact 内容或隐式授权 |
| Approval ticket | M3d Hub approval/executor | 绑定 exact tuple、一次性 claim、审计 | plugin/model/bridge 生成 nonce 或改变目标 |
| Remote automation/action | 后续 Hub action plane/artifact host | 仅在 M3d+完整 ticket 后由 Hub executor 操作 | M3b/M3c/M3d 之前的 artifact registry 自行应用 |

Artifact Registry 是 artifact revision 的唯一事实源；assessment/compile/dry-run attestation
由 Hub 追加并精确指向一个 artifact ref/hash。bridge 的远端 rule ID、标签和平台字段只能
作为未来 adapter binding/recovery hint，不能成为 artifact ownership 或 identity。DSH
session log、proposal audit、Home audit 和未来 artifact audit 分开保存，并用稳定 ID 关联。

## 2. Phase 1 Artifact Revision

### 2.1 不可变 envelope

实现时以 Zod 为 runtime source of truth；所有 object 使用 `.strict()`，所有数组、字符串、
数字、嵌套深度和 canonical byte size 先过 Hub-owned resource budget。以下是冻结的 shape
（字段名和闭集是 contract，示例中的 TypeScript 仅用于说明）：

```ts
type ArtifactRevision = {
  schemaVersion: "1";
  kind: "event-condition-action";
  artifactId: BoundedHubId;       // Hub 生成；不含 native/provider identity
  revision: PositiveSafeInteger;  // 从 1 开始、单调递增、不可复用
  title: BoundedText120;
  summary: BoundedText1000;
  sourceProposal: {
    proposalId: BoundedHubId;
    proposalRevision: PositiveSafeInteger;
  };
  content: ArtifactContent;
  createdAt: IsoTimestamp;
  contentHash: Sha256Digest;
};
```

`ArtifactRevision` 只表达稳定行为意图：proposal source、trigger、conditions、actions、
rollback 和 postconditions。它不含动态 evidence watermark、risk assessment、action
authority candidate、compiler output、dry-run output、approval nonce、执行结果或 audit
数组。那些记录由 Hub 以不可变 assessment/attestation rows 和 append-only audit 保存；
状态改变不能改变 revision bytes。`createdAt` 是审计元数据，canonical hash 的 payload
不包含它，避免同一行为意图因时钟变化产生不同 hash。

### 2.2 Canonical bytes 和 hash

`contentHash` 的输入是以下 immutable payload 的 canonical JSON UTF-8 bytes：

```text
{
  schemaVersion, kind, artifactId, revision, title, summary,
  sourceProposal, content
}
```

`revision` 在 hash 中，因此即使内容相同的重新发行也不会与旧 revision 共享 hash；
`createdAt`、Registry status、compiler result、dry-run result、audit 和任何运行时缓存不在
hash 输入中。canonicalization 规则冻结如下：

- Zod 严格校验和资源预算先成功；未知字段、重复 JSON key、`undefined`、非有限数字和
  不支持的值拒绝，不能先 strip 再 hash；
- object key 按 Unicode code-point 升序排序；array 顺序有意义且不排序；数字使用有限的
  JSON 数值表示；无空白、无尾随内容，最终编码为 UTF-8；
- digest 格式为 `sha256:` 加 64 个小写十六进制字符；算法和 canonicalization 版本是
  `schemaVersion`/host compatibility 的一部分；
- canonical payload 最大 64 KiB，字段/字符串/嵌套预算不得由调用者提高；
- 同一 `(artifactId, revision)` 只允许同一 hash 的幂等重放；不同 hash 是 revision
  conflict。不同 artifactId 的相同 hash 不自动合并，只能生成 bounded duplicate finding。

Revision 的写入需要 expected previous revision：首次为 1；后续必须是当前最大 revision
加一。删除以 `superseded`/tombstone 表达，不删除既有 revision。artifact 内容、目标、
rollback、postcondition 或 source proposal revision 的任一变化均不得原地 update；evidence、
risk、authority candidate、compiler version 或 watermark 的变化只追加新的 assessment 和
compile/dry-run attestation（必要时更新 latest pointer），不制造 artifact revision。

### 2.3 资源预算

以下是 Phase 1 的最小上限，部署可进一步收紧但不得放宽 contract 的安全默认值：

| 项目 | 上限 |
| --- | ---: |
| canonical artifact payload | 64 KiB |
| `artifactId` / proposal ID / candidate ID | 200 UTF-8 bytes |
| title | 120 Unicode characters |
| summary / risk reason | 1,000 characters |
| conditions | 8；仅扁平 AND，不递归 |
| actions | 4；按数组顺序执行的意图，第一用例只使用 1 个 device action |
| postconditions | 4 |
| action/condition scalar string | 512 characters |
| watermark entries | 16 bridges |
| conflict findings / diff operations | 20 |
| schedule days | 1–7 个去重的 weekday 值 |

资源超限必须是 `resource_exhausted`/invalid artifact，不能截断、折叠、自动删字段或把
剩余动作静默丢弃。

## 3. 中立 ECA 闭集

Artifact 不支持通用 rule language。conditions 是数组中的**全 AND**；不支持 `or`、递归
布尔树、脚本、模板、正则、任意 attribute path、动态查询、外部 HTTP 或模型生成的表达式。

### 3.1 Shared references and scalar

```ts
type CapabilityRef = {
  hwCapabilityId: BoundedHubId;
};

type ActionTarget = {
  hwCapabilityId: BoundedHubId;
};

type NeutralScalar = string | number | boolean | null;
```

`CapabilityRef` 只用于读侧 trigger/condition/postcondition；`ActionTarget` 只用于 device
action 和 rollback，并且只绑定稳定的 `hwCapabilityId`。`actionAuthorityCandidateId` 是
后续 Hub-owned assessment 的动态 opaque reference，不是 artifact target、bridge ID、
adapterType、native ID、remote instance ID 或可由 model/plugin 自造的路由。Hub 在 compiler
和 approval 前验证 candidate 与 `hwCapabilityId` 的绑定和当前可用性；最终 ticket 才包含
governed-action-plane 要求的 bridge、adapter、binding generation 和 remote identity。

Artifact/hash 中禁止以下 target 字段（即便放在 metadata/ext 中也拒绝）：
`bridgeId`、`nativeId`、`nativeInstanceId`、`entityId`、`siid`、`piid`、`adapterType`、
`remoteInstanceId`、URL、service name、provider rule ID、raw command 或 arbitrary route。
Authority assessment/compile/dry-run result 可以携带 Hub 生成的 opaque
`actionAuthorityCandidateId`，但仍不得携带上述 final route 字段。

### 3.2 Trigger

```ts
type Trigger =
  | {
      kind: "schedule";
      timezone: BoundedTimezone;
      daysOfWeek: readonly [0 | 1 | 2 | 3 | 4 | 5 | 6, ...];
      at: "HH:MM";                 // local wall-clock, no cron/expression
    }
  | {
      kind: "capability_changed";
      source: CapabilityRef;
    };
```

`timezone` 是由 host 验证的 bounded IANA-style identifier；schema 不接受任意 offset、cron、
日出/日落、天气或生态 event 名。若 host 无法解析 timezone，compiler 返回 unavailable，
而不是猜测本地时区。一个 artifact 只有一个 trigger；多 trigger、OR 和 debounce 在此版
不可表达。

### 3.3 Conditions

```ts
type Condition = {
  kind: "capability_value";
  source: CapabilityRef;
  operator: "equals" | "not_equals" | "greater_than" | "less_than";
  value: NeutralScalar;
};
```

Conditions 按数组顺序验证、按逻辑 AND 解释；空数组表示只由 trigger 决定。比较的 scalar
类型和 capability schema 不匹配时，compiler/dry-run 失败或 unavailable，不做字符串强制
转换。Condition 不能读取 raw attrs、任意字段 path、历史数据库或另一租户 scope。

### 3.4 Actions

```ts
type Action =
  | {
      kind: "set_level";
      target: ActionTarget;
      value: number;                // 0 <= value <= 1，有限数字
      transitionSeconds?: number;   // 0..3600
    }
  | {
      kind: "set_boolean";
      target: ActionTarget;
      value: boolean;
    }
  | {
      kind: "notify_local";
      message: BoundedText512;
    };
```

`set_level` 是中立的归一化 level 意图；目标是否支持该意图由 Hub schema catalog、policy
和 compiler 验证。第一用例用它表达一个 cover-like capability 的舒适位置，不在 artifact
里写任何生态 domain、service、entity 或平台百分比约定。`set_boolean` 只表示受 catalog
认可的中立布尔能力。`notify_local` 不选择设备 authority，且只产生本地 review/notification
candidate，不得成为隐藏的执行入口。

不支持 arbitrary `set_value`、批量 provider command、场景、脚本、设备组、shell、HTTP、
模板、循环、并发分支或任意 vendor extension。多 action 的执行顺序是数组顺序；任何 action
无法做确定性 policy/risk 评估，整个 artifact compile fail closed。

### 3.5 Rollback and postconditions

```ts
type Rollback =
  | {
      kind: "restore_previous_state";
      target: ActionTarget;
      maxAgeSeconds: number;         // 1..86400
    }
  | {
      kind: "no_remote_change";     // 仅 notify_local 或 observe-only 结果
    };

type Postcondition = {
  kind: "capability_value";
  source: CapabilityRef;
  operator: "equals" | "not_equals" | "greater_than" | "less_than";
  value: NeutralScalar;
  withinSeconds: number;             // 1..300
};

type ArtifactContent = {
  trigger: Trigger;
  conditions: readonly Condition[];  // max 8, AND
  actions: readonly Action[];        // max 4, min 1
  rollback: Rollback;
  postconditions: readonly Postcondition[]; // max 4
};
```

`comfort_reversible` 必须有 device action、`restore_previous_state` 和至少一个与 action
目标相容的 bounded postcondition；`observe_or_notify` 只能使用 `notify_local` 和
`no_remote_change`。Phase 1 不接受 safety-sensitive artifact；locks/access control、
cooking、water/gas、alarms、medical、destructive operation 等必须在 schema/policy gate
外 fail closed，而不是仅把 risk label 改成 high。

## 4. Evidence、水位、risk 和 authority attestations

Artifact revision 的 hash 只承诺稳定行为意图。Hub 对会随家庭状态、policy 或 bridge
registry 改变的事实另存不可变 attestation；每一条都精确绑定 artifact ref/hash 和自己的
input identity。这样可以审计“当时基于什么输入编译”，也不会因为水位刷新制造语义上相同的
artifact revision。

### 4.1 Stable artifact reference

```ts
type ArtifactRef = {
  artifactId: BoundedHubId;
  revision: PositiveSafeInteger;
  contentHash: Sha256Digest;
};
```

`ArtifactRef` 是 assessment、compile、dry-run 和 M3d ticket 的共同外键；它不是一份可由
Agent 自造的 authority route。所有 attestation 都是 immutable rows：同一个 input identity
只能幂等返回同一记录；水位、policy、candidate 或 compiler input 变化必须产生新的
attestation/result identity，不能修改旧记录或 ArtifactRevision。

### 4.2 Hub-produced evidence attestation

```ts
type ArtifactEvidenceAttestation = {
  kind: "evidence-attestation";
  attestationId: BoundedHubId;
  artifact: ArtifactRef;
  inputIdentity: Sha256Digest;       // Hub consistent-cut/query input
  source: "home-world-consistent-cut";
  sourceProposal: {
    proposalId: BoundedHubId;
    proposalRevision: PositiveSafeInteger;
  };
  proposalEvidenceIdentity: Sha256Digest; // exact approved Proposal evidence envelope
  selectedHwCapabilityIds: readonly BoundedHubId[]; // canonical unique behavior refs, max 16
  capturedAt: IsoTimestamp;
  watermarks: readonly {
    bridgeId: BoundedHubId;
    epochId: BoundedHubId;
    lastSeq: NonNegativeSafeInteger;
    lastSyncCompleteAt?: IsoTimestamp;
    freshness: "fresh" | "stale" | "unknown";
    gapCount: NonNegativeSafeInteger;
  }[];                                // 1..16
  coverage: "complete" | "partial" | "unavailable";
  reasons: readonly HomeWorldEvidenceCoverageReason[];
};
```

这里的 `HomeWorldEvidenceCoverageReason` 复用现有 HomeWorld 闭集，不另造
artifact-specific reason vocabulary。`inputIdentity` 是 Hub 对 consistent-cut、proposal
evidence references 和相关 world-model 输入的 canonical hash；它不是 artifact contentHash。
`proposalEvidenceIdentity` 必须由 Hub 对 source gate 返回的完整 evidence envelope 计算，不能
接受 Agent 提交的 digest；`selectedHwCapabilityIds` 必须由 ArtifactContent 的 trigger、条件、
动作、rollback 和 postcondition 引用重新推导。二者都进入 `inputIdentity`，使 Registry 重启后
仍能验证 attestation 自身没有遗漏这些依赖；producer/compiler 还必须回到 Proposal source gate
交叉验证 digest，而不是把一个格式正确的 digest 当作权威事实。

水位和 coverage 必须由 Hub 从当前 `HomeWorldSnapshot`、journal/world model 和 proposal
evidence 重新绑定；Agent 不能提交或覆盖 `epochId`、`lastSeq`、gap、freshness、bridge
diagnostics 或“complete”断言。`bridgeId` 在 evidence 中只是 Hub 的中立一致性坐标，不是
artifact 的 action target。attestation 不复制 state values、raw attrs、native IDs 或
provider payload；需要具体事件引用时沿用 proposal v1 的 bounded neutral references。

水位是 per-bridge vector，不承诺跨桥 global snapshot isolation。artifact 的 trigger、
conditions、targets、postconditions 和 conflict inputs 涉及的每个 bridge 都必须在 vector
中有条目；缺少桥条目不是“无数据”，而是 `coverage: unavailable`。同一 artifact 在下一次
consistent cut 得到不同水位时，Hub 追加新的 `attestationId`/`inputIdentity`，不追加
ArtifactRevision。

### 4.3 Hub risk assessment

```ts
type ArtifactRiskAssessment = {
  kind: "risk-assessment";
  assessmentId: BoundedHubId;
  artifact: ArtifactRef;
  inputIdentity: Sha256Digest;       // artifact ref + current policy/evidence inputs
  evidence: {
    attestationId: BoundedHubId;
    inputIdentity: Sha256Digest;
  };
  authority: {
    assessmentId: BoundedHubId;
    inputIdentity: Sha256Digest;
  };
  conflictInputIdentity: Sha256Digest; // Hub hash of exact conflict assessment/query input
  class: "observe_or_notify" | "comfort_reversible";
  reasons: readonly BoundedText1000[]; // max 10，Hub policy 生成
  policyId: BoundedHubId;
  policyVersion: BoundedVersion;
  requiresHumanApproval: true;
  assessedAt: IsoTimestamp;
};
```

Risk 是 Hub policy 对稳定 artifact、目标能力、rollback、当前 evidence attestation、既有
conflict 和可用 authority assessment 的计算结果。模型/Agent 传来的 risk label、文字理由
和“低风险”不能成为 authority；draft 若尚未完成 policy assessment 则不能进入 `compiled`
或 `simulated`。Phase 1 所有 artifact 都 `requiresHumanApproval: true`；没有审批的低风险
默认不是可执行路径。policy version、class、理由或 policy input 改变时，Hub 追加新的
`assessmentId`/`inputIdentity`，不修改 ArtifactRevision。

### 4.4 Hub authority assessment

```ts
type ArtifactAuthorityAssessment = {
  kind: "authority-assessment";
  assessmentId: BoundedHubId;
  artifact: ArtifactRef;
  inputIdentity: Sha256Digest;       // registry/config/world-cut input
  authorityRegistryIdentity: Sha256Digest; // Hub config/binding generation identity
  candidates: readonly {
    actionAuthorityCandidateId: BoundedHubId;
    hwCapabilityId: BoundedHubId;
    status: "available" | "unavailable" | "not_approved";
  }[];
  checkedWatermarks: readonly ArtifactEvidenceAttestation["watermarks"][number][];
  assessedAt: IsoTimestamp;
};
```

Candidate 是 Hub 生成的 opaque assessment reference；它不把 final bridge/native route、
adapter、registry generation 或 remote instance 放入 artifact。authority rebind、adapter
migration、registry generation 变化时，Hub 追加新的 authority assessment；旧 assessment
和任何引用它的 compile/dry-run/ticket 都保持不可变但变为 stale。最终 route 只在 M3d ticket
中由 Hub 根据最新 candidate 和 binding 重新解析。稳定 candidate、rebind 和私有 route
边界见 [`authority-candidate-registry.md`](authority-candidate-registry.md)。

Evidence、risk、authority 三类记录都必须通过严格 schema 和同一 artifact ref/hash 校验；
它们的刷新是新的 immutable assessment/attestation identity，而不是稳定行为意图的
revision。任何一类 attestation 缺失或 stale 都必须 fail closed，不能用旧行悄悄冒充最新
输入。

## 5. Registry 和 lifecycle

### 5.1 M3b registry contract

Hub-owned Artifact Registry 的最小职责：

- `createDraft`：验证 Hub-owned proposal source、稳定 ECA closed set、target `hwCapabilityId`
  和 content hash，追加 revision 1；不把 evidence、risk 或 authority candidate 放入 revision，
  不调用 bridge、不写远端；
- `appendRevision`：要求 expected previous revision，计算并验证新 hash，原子写入 immutable
  row 和 lifecycle audit；
- `getRevision`/`list`：按 artifact ID/revision/hash 查询 bounded neutral metadata；
- `markSuperseded`：只新增状态/audit，不删除旧 revision；
- `recordEvidenceAttestation`/`recordRiskAssessment`/`recordAuthorityAssessment`：校验
  `ArtifactRef` 和各自 Hub input identity，追加不可变 assessment；水位、policy 或 candidate
  刷新只产生新的 assessment identity；
- `recordCompile`/`recordDryRun`：校验所有 assessment/ref/hash 交叉绑定，追加不可变结果
  attestation；这些结果不能修改 artifact bytes；
- `listAttestations`/`latestAttestation`：按 artifact ref 查询历史或明确选择当前可用的最新
  evidence/risk/authority/compile/dry-run 记录，stale 行必须保留并标记，不能静默替代。

Artifact Registry core 已由 Hub 以私有 SQLite 持久化，包含 0600 文件/WAL 边界、不可变
revision/assessment rows、幂等、重启恢复和 append-only audit；risk row 写入还会 exact
cross-check 已持久化且属于同一 artifact/revision 的 evidence 与 authority input identities。
它的只读查询和元数据 diagnostics 已由 `HomeArtifactService` 挂入生产组合；ArtifactProducer
mutation、EvidenceProducer、AuthorityProducer 和执行相关路径仍未挂载到生产组合。EvidenceProducer
只读 approved Proposal source 与 HomeWorld query/snapshot port；AuthorityProducer 只读
Hub-private fresh-world opaque binding input，并通过 candidate registry 生成 authority
assessment；notify-only scope 明确为空。私有 `AuthorityCandidateRegistry` core 已具备持久化
candidate lifecycle 和 metadata-only audit。未挂载的 `HomeWorldAuthorityBindingSource`
从中立 snapshot 与 Hub-private authority selector 生成 fresh、gap-free、binding-scoped input；
未挂载的 `ArtifactRiskProducer` 只消费精确 persisted evidence、authority 与 Hub-private
conflict input。未挂载的 `ArtifactRiskConflictSource` 从 exact approved Proposal 的冻结
conflict check 与 bounded Artifact Registry scan 产生 closed findings；任何截断或 source
mismatch 都保持 unavailable。它生成的 opaque source identity 绑定完整 Proposal conflict
input 和本次 scan 的每一个 Artifact row；即使 findings 仍为空，输入变化也会刷新 risk
identity。fresh current-catalog conflict refresh、private coordinator 的 production invocation
和 mutation composition 尚未接入。当前 unmounted `ArtifactMutationCoordinator` 只接受 exact approved
Proposal identity 或 exact ArtifactRef，顺序调用 producer，并在 same-run risk dependencies
与 receipt identity 全部一致后才返回 metadata-only success。Agent、Inbox 和 bridge 只通过
窄的 typed service 接口访问。插件如果未来参与，只能提交 proposal/compiler candidate，
不能拥有 registry 或 audit。

### 5.2 Lifecycle states

沿用 governed action plane 的状态词，但按 milestone 开启：

```text
draft -> compiled -> simulated -> awaiting_approval -> approved
approved -> executing -> applied -> verified
approved -> executing -> failed | indeterminate
verified -> superseded | rollback_proposed
```

M3b 只允许 `draft`、`superseded`/tombstone 及对应的 non-applying audit；M3c 产生
`compiled`/`simulated` result；M3d 才允许 `awaiting_approval`/`approved`/`executing` 等
后续状态。不存在 `approved -> apply` 的隐式 shortcut。`indeterminate` 对自动执行是终态，
只能由 fresh consistent read 或新的人审 proposal 继续。

### 5.3 Idempotency and concurrency

- Registry 的写操作使用 Hub 生成的 idempotency key；相同 source proposal revision、artifact
  revision 和 canonical hash 的重放返回同一 revision，不新增语义重复记录；
- 相同 artifact ID 的不同 stable content hash、缺失 expected revision、旧 proposal revision
  或语义内容变更都返回 revision conflict/要求 expected-next revision；不采用 last-writer-wins；
- 不同 evidence watermark、coverage、policy reason/version、authority candidate、compiler
  input 或 dry-run input 不返回 revision conflict：它们必须以新的 immutable attestation/result
  identity 追加，并精确绑定同一个 `ArtifactRef`；同一 input identity 才可幂等重放；
- registry status、revision/assessment/result append 和 audit append 使用同一 Hub transaction
  或明确的 durable version boundary；崩溃恢复只能看到完整的 immutable row 或完全看不到新
  状态，不能看到半个 artifact/attestation；
- `superseded`、policy revoke、evidence stale、authority rebind 都会阻止旧 revision 或旧
  attestation 进入新的 approval ticket；不自动迁移 grant、route 或 postcondition。旧 ticket
  仍必须失效并要求新的 Hub assessment 和人工审批，不能因为 revision 未变而复活。

M3b 的私有协调器保持同步且没有外部副作用，因此不引入通用 outbox 或跨 Proposal/Artifact
SQLite 的伪原子事务。每一个 immutable row 与对应 audit 仍在所属 Registry transaction 内
原子提交；协调器只有在 evidence、authority、risk 的 exact same-run references 全部一致时
才返回完整 receipt。中途失败可以留下可识别但不完整的 immutable rows，它们不会进入
approval/compile 状态，也不会在启动时自动继续；只允许显式 Hub command 通过 producer-owned
idempotency 重试。未来第一次加入异步远端副作用时，再单独设计 durable outbox/claim，而不
把当前本地 assessment 链伪装成一次跨库事务。

## 6. Compiler input/output（M3c seam）

M3c compiler 接受 typed、只读的 neutral input；它不接受 bridge adapter 实例、生态 payload、
native route 或远端 credentials。概念输入：

```ts
type ArtifactCompileInput = {
  artifact: ArtifactRevision;
  proposal: {
    id: BoundedHubId;
    revision: PositiveSafeInteger;
    status: "pending_review" | "approved" | "rejected" | "expired";
  };
  evidence: ArtifactEvidenceAttestation;
  risk: ArtifactRiskAssessment;
  authority: ArtifactAuthorityAssessment;
  worldCut: {
    devices: readonly NeutralDeviceSummary[]; // 仅与引用 hw IDs 相关的 bounded projection
    cutIdentity: Sha256Digest;
    watermarks: readonly ArtifactEvidenceAttestation["watermarks"][number][];
  };
  foreignRuleChecks: readonly NeutralConflictInput[];
  compiler: { id: BoundedHubId; version: BoundedVersion };
};
```

`NeutralDeviceSummary` 只能是 Hub 中立 projection（hw IDs、schema/semantic hint、受限当前
值摘要和 validity）。对 artifact 中每个设备 action，它还携带由 Hub-private exact-schema
resolver 产生、按连续一基 action order 绑定的 compatibility 结果；结果只含 closed status/
reason 和 neutral `before`/`after`，不能含原生格式或 writable metadata。Compiler 不得从
`semanticKind`、schema 名或 scalar shape 再推断动作能力。它不得把 `HomeWorldSnapshot` 中的
native binding、raw attrs 或 adapter payload 穿过 Agent-facing/compiler contract。
`foreignRuleChecks` 缺失、未准备好或
epoch 与 committed watermark 不一致时，输入保持 `unavailable`，不能伪造零 conflict。
`evidence`、`risk` 和 `authority` 的 `artifact` 必须等于 `artifact` 的 `ArtifactRef`；
compiler 只能消费 Hub 已生成的 assessment，不能接受 Agent 提供的 watermarks、risk 或
candidate。Compiler input identity 是对 artifact ref、三类 attestation ID/input identity、
`worldCut.cutIdentity`、foreign-rule cut 和 compiler id/version 的 canonical hash；任何输入
变化都会产生新的 compile result identity，但不会改变 artifact revision/hash。

Compiler output 也是中立的：

```ts
type ArtifactCompileAttestation = {
  kind: "compile-attestation";
  resultId: BoundedHubId;
  artifact: ArtifactRef;
  inputIdentity: Sha256Digest;
  proposal: { id: BoundedHubId; revision: PositiveSafeInteger };
  evidenceAttestationId: BoundedHubId;
  riskAssessmentId: BoundedHubId;
  authorityAssessmentId: BoundedHubId;
  status: "compiled" | "rejected" | "unavailable";
  compiler: { id: BoundedHubId; version: BoundedVersion };
  usedWatermarks: readonly ArtifactEvidenceAttestation["watermarks"][number][];
  plan?: {
    trigger: Trigger;
    conditions: readonly Condition[];
    actions: readonly Action[];
    rollback: Rollback;
    postconditions: readonly Postcondition[];
  };
  diff: NeutralDiff;
  conflicts: NeutralConflictResult;
  blockingReasons: readonly ClosedReasonCode[];
};
```

`ArtifactCompileAttestation` 是不可变的 dynamic result row。`compiled` 只表示闭集 artifact
在所引用的 evidence/risk/authority inputs 下已映射为可审查的 neutral plan；不表示某个 bridge
接受、远端规则已安装或 action authority 已被调用。刷新水位、policy reason/version、candidate
或 compiler version 时，Hub 生成新的 assessment/compile result identity，原
`ArtifactRevision` 的 ref/hash 不变。provider-specific compilation（未来可能有多个 adapter）
留在 Hub 内部 typed adapter seam；其结果必须再投影为本 contract 的 neutral diff，不能把
平台对象加入 artifact bytes 或 Agent output。M3c 首先完成这一 neutral plan/diff contract，
不宣称已经生成 HA automation；HA-specific translation 只在 M3e 经过审查的内部
`artifactHost@1` seam 后开始，并继续投影回本文的中立结果。

## 7. Dry-run、diff 和 conflict semantics

### 7.1 Dry-run

M3c dry-run 是一个纯读、可重复的模拟：

```ts
type NeutralDryRunAttestation = {
  kind: "dry-run-attestation";
  resultId: BoundedHubId;
  artifact: ArtifactRef;
  inputIdentity: Sha256Digest;
  compileAttestationId: BoundedHubId;
  evidenceAttestationId: BoundedHubId;
  riskAssessmentId: BoundedHubId;
  authorityAssessmentId: BoundedHubId;
  status: "passed" | "failed" | "unavailable";
  compiler: { id: BoundedHubId; version: BoundedVersion };
  checkedWatermarks: readonly ArtifactEvidenceAttestation["watermarks"][number][];
  diff: NeutralDiff;
  conflicts: NeutralConflictResult;
  writesPerformed: false;
  summary: BoundedText1000;
};

type NeutralDryRunState =
  | { status: "not_run"; artifact: ArtifactRef }
  | NeutralDryRunAttestation;
```

M3b 的 `not_run` 是没有该 row，而不是伪造一个通过的结果；registry 查询应明确返回
`not_run`。`NeutralDryRunAttestation` 的每一行都有自己的 `resultId`/`inputIdentity`，并
精确绑定 compile、evidence、risk、authority 和 artifact ref。`passed` 表示所有目标、
schema/action semantics、risk、rollback、watermark、authority candidate、conflict 和
postcondition 检查在**该次输入**下通过；只说明“此输入下可以生成审查 diff”，不代表 approve
或 apply。刷新任一 assessment 或 world cut 会产生新的 compile/dry-run identity，不改
ArtifactRevision。
- `failed`：输入完整但确定性违反 contract/policy/conflict，例如 action 与 target schema 不兼容；
  不得发 approval ticket。
- `unavailable`：缺少 ready consistent cut、证据 coverage、authority candidate、foreign-rule
  catalog 或 compiler dependency；不能将 unavailable 降格为 passed/zero-conflict。

所有 status 都必须 `writesPerformed: false`。dry-run 不调用 bridge `control`、`events` 写
路径、action executor、artifact host、凭证 provider 或远端 API；它只能读 Hub-owned snapshot、
journal evidence、catalog 和已登记 conflict metadata。

### 7.2 Neutral diff

```ts
type NeutralDiff = {
  status: "no_change" | "changes" | "unavailable";
  operations: readonly {
    order: PositiveSafeInteger;
    kind: "set_level" | "set_boolean" | "notify_local";
    hwCapabilityId?: BoundedHubId;
    actionAuthorityCandidateId?: BoundedHubId;
    before?: NeutralScalar;
    after?: NeutralScalar;
  }[];                                // max 20，保留 artifact action order
  unchangedCount: NonNegativeSafeInteger;
  redacted: true;
};
```

Diff 只展示 neutral capability ID、bounded scalar、candidate opaque ID 和 action kind；不得
展示 native route、provider error、secret、raw attrs 或不受控的 URL。`operations` 必须保留
artifact action order，并生成从 1 开始的连续 `order`；不能为了 target/key canonicalization
重排有语义的 action array。当前值缺失时使用 `before` absent 并把覆盖状态标为
unavailable/stale，不猜测“无变化”。

### 7.3 Conflict

```ts
type NeutralConflictResult = {
  status: "none" | "duplicate" | "possible_overlap" | "unavailable";
  findings: readonly {
    kind: "existing_artifact" | "foreign_rule" | "stale_evidence"
      | "authority_unavailable" | "target_invalid" | "policy_blocked";
    severity: "blocking" | "warning";
    hwCapabilityId?: BoundedHubId;
    reference?: BoundedHubId;          // Hub opaque reference only
    reason: ClosedReasonCode;
  }[];                                  // max 20
};
```

Conflict 规则：

- Registry 中同一 canonical trigger/target/action/hash 的重复 proposal/artifact 是
  `duplicate`，不得静默覆盖；
- 目标、时间窗、条件或 action 与现有 artifact/foreign rule 可能重叠但无法证明互斥时是
  `possible_overlap`。它应阻止 `passed` 或要求明确 review，不能用零 match 宣称无干涉；
- foreign rule catalog 必须是当前 bridge committed epoch 的完整可用 catalog；缺失、部分、
  epoch mismatch、restart 或 truncation 是 `unavailable`，不是零 rules。M3c capture 必须把
  bounded canonical catalog identity 与 capture 前后 exact bridge watermark 一起绑定；只有
  epoch 而没有稳定 catalog/watermark identity 时，不得把结果宣称为 current；
- stale/gapped/partial evidence、目标 present-but-invalid、candidate 不可用或 policy
  缺失是 blocking finding；旧 artifact 不因为新 bridge epoch 自动重新有效；
- findings 使用 bounded neutral reason code，不把原生 provider error、rule ID、URL 或模型
  文字作为事实。

## 8. Approval 精确绑定（M3d seam）

M3d 的 ticket 必须同时绑定以下 immutable tuple；任何一个字段变化都使 ticket 失效并回到
review/新 ticket：

```text
proposalId + proposalRevision
artifactId + artifactRevision + contentHash
evidenceAttestationId + evidence input identity + exact watermark vector
riskAssessmentId + risk input identity + policyId + policyVersion + risk class
authorityAssessmentId + authority input identity + candidate for every action target
compileAttestationId + compile input/result identity + compilerId + compilerVersion
dryRunAttestationId + dry-run input/result identity
affected hwCapabilityIds
Hub-resolved final action authority route for every action
exact neutral postconditions + bounded verification deadline
approval principal + issuedAt + expiresAt + one-use nonce
```

Artifact 内只保留 `hwCapabilityId`；candidate 只存在于 Hub authority assessment、compile/
dry-run attestation 和 ticket。`authorityRegistryIdentity` 只保存 Hub 对 authority config、
binding generation 和适用 scope 的不可逆 identity，不暴露 route/native payload；当前
AuthorityCoordinator 已验证并投影带 `configIdentity`、`configRevision` 的显式 action
configuration。未挂载的 AuthorityProducer 已能消费完整 Hub-private fresh-world opaque
binding input 和 candidate registry；未挂载的 `HomeWorldAuthorityBindingSource` 已能从
中立 snapshot 与精确 configuration binding 生成该 input。它仍未进入 production
coordination，因此生产路径不得据此宣称可用 authority assessment。最终
authority target（bridgeId、catalog adapterType,
bridge-registry binding generation、remote-instance identity）由 Hub 在 ticket 中重新产生，
永远不接受 model/plugin/artifact payload 提供的值。Candidate 被撤销、bridge rebind、adapter
migration、registry generation 改变、watermark/coverage 变旧、policy assessment 变化、
compiler/dry-run 输入变化或 artifact supersede 时，旧 ticket 不可 claim；即使稳定
ArtifactRevision 的 hash 未变，也必须生成新的 assessment/dry-run/ticket 并重新取得人工审批。

Approval 的一次性 nonce 必须和 `approved → executing`、audit-start 在同一 Hub transaction
中 claim；M3b/M3c 没有这个执行路径。审批不把 artifact revision 改成 mutable “approved
content”，也不把 proposal approval 当作 artifact approval。M3d ticket 是对某一 artifact
ref/hash、某一组最新 Hub attestations 和某一最终 route 的一次性授权；证据刷新或 authority
rebind 不制造 artifact revision，但会使旧 ticket stale 并要求新的人工审批。

## 9. 窗帘舒适度第一用例（中立示例）

以下只是 fixture 语义，ID 均为 Hub opaque fixture；它没有 HA/Xiaomi vocabulary：

```json
{
  "schemaVersion": "1",
  "kind": "event-condition-action",
  "artifactId": "artifact-comfort-window-1",
  "revision": 1,
  "title": "在晨间时段试用较柔和的遮光位置",
  "summary": "在有证据支持的时间窗执行一次可逆 level 调整。",
  "sourceProposal": { "proposalId": "proposal-17", "proposalRevision": 2 },
  "content": {
    "trigger": {
      "kind": "schedule",
      "timezone": "Etc/UTC",
      "daysOfWeek": [1, 2, 3, 4, 5],
      "at": "07:30"
    },
    "conditions": [{
      "kind": "capability_value",
      "source": { "hwCapabilityId": "hwc-light-context" },
      "operator": "less_than",
      "value": 0.4
    }],
    "actions": [{
      "kind": "set_level",
      "target": {
        "hwCapabilityId": "hwc-cover-1"
      },
      "value": 0.65,
      "transitionSeconds": 30
    }],
    "rollback": {
      "kind": "restore_previous_state",
      "target": {
        "hwCapabilityId": "hwc-cover-1"
      },
      "maxAgeSeconds": 900
    },
    "postconditions": [{
      "kind": "capability_value",
      "source": { "hwCapabilityId": "hwc-cover-1" },
      "operator": "equals",
      "value": 0.65,
      "withinSeconds": 120
    }]
  },
  "createdAt": "2026-08-20T01:00:00.000Z",
  "contentHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

示例 hash 仅为 stable fixture 占位，实际实现必须按 §2.2 重新计算；它只覆盖直到
`content`/source proposal 的稳定行为意图。下面是同一 stable revision 的动态 attestation
fixture（为便于阅读拆成一个 bundle；生产实现按各自 row 持久化）：

```json
{
  "evidenceAttestation": {
    "kind": "evidence-attestation",
    "attestationId": "evidence-comfort-window-v1",
    "artifact": {
      "artifactId": "artifact-comfort-window-1",
      "revision": 1,
      "contentHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "inputIdentity": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "source": "home-world-consistent-cut",
    "capturedAt": "2026-08-20T01:00:00.000Z",
    "watermarks": [{
      "bridgeId": "bridge-1",
      "epochId": "epoch-7",
      "lastSeq": 42,
      "lastSyncCompleteAt": "2026-08-20T00:59:00.000Z",
      "freshness": "fresh",
      "gapCount": 0
    }],
    "coverage": "complete",
    "reasons": []
  },
  "riskAssessment": {
    "kind": "risk-assessment",
    "assessmentId": "risk-comfort-window-v1",
    "artifact": {
      "artifactId": "artifact-comfort-window-1",
      "revision": 1,
      "contentHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "inputIdentity": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    "class": "comfort_reversible",
    "reasons": ["Bounded reversible level change with previous-state restore."],
    "policyId": "policy-home-v1",
    "policyVersion": "1.0.0",
    "requiresHumanApproval": true,
    "assessedAt": "2026-08-20T01:00:00.000Z"
  },
  "authorityAssessment": {
    "kind": "authority-assessment",
    "assessmentId": "authority-comfort-window-v1",
    "artifact": {
      "artifactId": "artifact-comfort-window-1",
      "revision": 1,
      "contentHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "inputIdentity": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    "candidates": [{
      "actionAuthorityCandidateId": "aac-hwc-cover-1-v3",
      "hwCapabilityId": "hwc-cover-1",
      "status": "available"
    }],
    "checkedWatermarks": [{
      "bridgeId": "bridge-1",
      "epochId": "epoch-7",
      "lastSeq": 42,
      "freshness": "fresh",
      "gapCount": 0
    }],
    "assessedAt": "2026-08-20T01:00:00.000Z"
  }
}
```

`evidence-comfort-window-v2` 可以在同一 artifact ref 下记录更高 `lastSeq`；policy
理由/version 变化可以记录新的 risk assessment，authority rebind 可以记录新的 candidate
assessment。每种刷新都产生新的 compile/dry-run result identity，但不改 artifact revision 或
stable `contentHash`。这个 fixture 不承诺目标 capability 必然可写；compiler 必须用 schema
catalog、当前 validity、明确 candidate、evidence freshness、conflict catalog 和 policy
重新检查。`Etc/UTC` 只代表 fixture，生产 timezone 必须由 host 验证。任何生态映射、平台
rule、native endpoint 和远端 action route 都在 Hub/adapter 内部，绝不进入该 artifact。

## 10. TDD 验收矩阵

实现 M3b/M3c/M3d 时，先写每行的失败测试，再实现最小行为。以下是必须进入 focused
contract/conformance suite 的矩阵；“未实现”不是测试通过的理由。

| 阶段 | 先失败的验收测试 | 必须证明的行为 |
| --- | --- | --- |
| M3b schema | unknown/duplicate key、非法 hash、超字节/深度/数组、非有限数、脚本/URL/raw command | Zod strict + 资源预算先行；整份 artifact 拒绝，不 strip/截断/部分接受 |
| M3b canonical | object key 重排、相同 fixture 重放、不同目标/rollback/postcondition/source proposal revision、仅改变证据/risk/candidate/watermark | stable canonical bytes/hash 稳定；行为意图变化生成不同 revision 或明确 conflict；仅动态输入变化保持同一 artifact ref/hash 并产生新 attestation identity |
| M3b revision | revision 0、跳号、旧 expected revision、同 revision 不同 hash、重启后重复写 | 从 1 单调、不可复用、幂等重放不重复语义；SQLite/文件恢复保留完整 revision/audit |
| M3b target | 注入 bridge/native/adapter/remote 字段；把 candidate 放入 ArtifactRevision；自造 authority assessment；condition 使用 native path | artifact target 只接受 `hwCapabilityId`；candidate 只能由 Hub assessment 产生；model/plugin 不能提供 route/authority |
| M3b ECA | cron/OR/递归表达式/未知 trigger/action/任意 JSON；合法 schedule + AND + level fixture | 仅闭集 trigger/condition/action/rollback/postcondition；第一用例 fixture 可校验 |
| M3b risk | model 提供低风险、缺 rollback、safety-sensitive action、`requiresHumanApproval:false`；policy reason/version 刷新 | risk 由 Hub policy 产生并单独持久化 assessment；Phase 1 只允许两类低风险、所有 artifact 要求人工审批；刷新生成新 assessment，不改 revision |
| M3b evidence | Agent 伪造 epoch/seq/complete；缺 bridge watermark；gap/stale/current-state-only；同一 artifact 的新水位 | Hub 重新绑定 per-bridge vector；缺失/partial/gap 诚实保留，不提升为 complete；刷新生成新 evidence attestation，不改 revision |
| M3b registry | pending/rejected proposal、旧 proposal revision、重复 idempotency、删除后查询、assessment/ref 错绑 | Registry 只接受 Hub source，稳定 revision 与动态 assessment 分开版本化、审计化、无远端写入口；旧记录不被删除/重解释 |
| M3c compiler | schema/semantic mismatch、candidate unavailable、timezone invalid、foreign catalog epoch mismatch、输入 attestation 不同 | 返回带新 input/result identity 的 `rejected`/`unavailable` closed result；不猜测转换、不把缺失 conflict 当 zero；artifact ref/hash 保持不变 |
| M3c diff | 同一 input 重跑、不同水位/当前值、before 缺失、多个 action、candidate refresh | neutral diff 稳定、bounded、只含 hw/candidate/scalar；动态 candidate 只在 result 中；无 native/provider error 泄漏 |
| M3c dry-run | 用 bridge spy、credential spy、action spy 运行 passed/failed/unavailable | 所有结果 `writesPerformed:false`；无 `control`/remote/credential/executor 调用；状态语义准确 |
| M3c conflict | duplicate、possible overlap、foreign rule unavailable、stale evidence | conflict status 不静默归零；blocking findings 阻止 passed/approval |
| M3d approval | proposal revision、artifact hash、compiler、evidence/risk/authority attestation identity、watermark、authority candidate 任一改变 | ticket exact tuple mismatch 失效；必须生成新 attestation/dry-run/ticket 和人工审批，旧 nonce 不可复用；稳定 artifact revision 不因动态刷新改变 |
| M3d crash | claim 后立即 crash、执行前 crash、timeout/ack lost、并发 claim | 原子 audit+nonce；`executing` 恢复为 `indeterminate`；无自动重试或旧 artifact 复用 |
| M3d authority | candidate→route rebind、binding generation 改变、freshness 过期 | ticket 只消费 Hub-resolved target；rebind/stale watermarks fail closed |

性质测试至少随机化：canonical key/order、at-least-once proposal/artifact replay、revision
交替、重复 candidate、per-bridge watermark gap、action permutation、registry crash point
和 concurrent ticket claims。测试 fixture 只能使用 neutral IDs；不能用生态 payload 证明
中立 contract。

## 11. M3b → M3c → M3d Gate

### M3b：contract、hash、registry（无应用）

**进入条件**：M3a proposal review loop 已能产生稳定 `proposalId/revision`、Hub evidence
watermark/coverage 和审计；已有真实家庭 pilot 的 useful review 证据；当前 Phase 0 仍以
review 终止。

**交付/退出条件**：

- Zod-first artifact/revision、canonicalization/hash、resource budget 和 closed ECA conformance
  测试通过；
- Hub-owned registry 可持久化稳定 revision/hash，并分别持久化可重启恢复的 evidence/risk/
  authority assessments、幂等、expected-revision conflict、0600/retention 边界和 append-only
  audit；
- proposal source、稳定 ECA/target `hwCapabilityId` 和各类 Hub assessment 的 artifact
  ref/input identity 均能被重新验证；动态刷新只新增 assessment，不新增 artifact revision；
- registry 与 Agent/Inbox/bridge 没有 device write、artifact host、action executor 或
  credential/remote call seam；
- 窗帘舒适度 stable fixture 可存储、读取、hash 重放，动态 evidence/risk/authority fixture
  可追加，但只能是 `draft/not_run`。

### M3c：pure compiler、dry-run、diff/conflict（仍无应用）

**进入条件**：M3b 所有 focused/property/crash tests 通过，且没有未闭合的 target、risk、
evidence、hash 或 registry 状态边界。

**交付/退出条件**：

- compiler 只读 neutral HomeWorld cut、最新 evidence/risk/authority attestation、candidate 和
  conflict catalog；
- `compiled`/dry-run output 有 compiler id/version、artifact ref/hash、各 assessment/input
  identity、used watermarks、exact bounded diff、closed conflict status 和诚实
  unavailable/failed reasons；
- evidence/risk/candidate/watermark 刷新产生新的 compile/dry-run identity，但 stable
  artifact revision/hash 不变；
- 使用 spy/crash test 证明所有 dry-run 路径没有 bridge write、remote API、credential resolve、
  action nonce 或 artifact host 调用；
- existing foreign rule catalog 缺失/epoch mismatch、stale/gap、authority unavailable 均不
  被显示为“无冲突”；
- neutral curtain fixture 能生成可审查 diff，仍不能 install/enable/execute。

### M3d：approval ticket、executor shell（第一次允许准备执行）

**进入条件**：M3c 的 dry-run `passed` 只代表指定 attestation inputs 下的 in-memory plan
通过；Control Center 能显示 artifact hash/revision、最新 assessment/result identities、
compiler、diff、authority candidate/最终 route、watermark freshness、risk、ticket expiry、
conflict 和 rollback 状态。

**交付/退出条件**：

- Hub 生成 exact approval ticket；完整 immutable tuple 原子比较，nonce claim 与 audit-start
  同一 transaction；
- proposal revision、artifact revision/hash、compiler、assessment/input identity、policy/
  watermark/authority/postcondition 任一变化都会回 review；动态刷新不改变 stable artifact
  revision，但旧 ticket 必须失效并要求新的人工审批；
- synthetic bridge + crash/concurrency injection 证明 replay、failed、timeout、ack lost 和
  `indeterminate`，restart 不会自动重试；
- M3d 仍不等于生产写路径。只有后续 `artifactHost@1`/`actions@1` gate 通过，且每个具体
  route 有 policy、approval、idempotency、postcondition、resync 和 audit，才可考虑远端写。

## 12. 非目标和不可推断事项

- 不把当前 non-applying Artifact Registry 或孤立的 private authority-candidate registry core
  误述为已实现 artifact compiler、dry-run、approval executor、`actions@1`、`artifactHost@1`
  或任何远端写路径；这些后续能力仍未实现。
- 不创建新的 Skill、automation DSL、plugin manifest、bridge contract、model-facing tool
  或第二个 registry；artifact 不是 `SKILL.md`、foreign rule 或 bridge extension payload。
- 不将 HA/Xiaomi/provider vocabulary、native IDs、远端 rule IDs、原始 attributes、service
  calls、URL、template、shell、任意 JSON 和 secret 放入中立 artifact。
- 不支持 safety-sensitive actions、任意场景/组、OR/循环/并发编排、天气/日出语义、导入的
  vendor history、跨桥 global snapshot isolation 或自动跨桥 capability binding。
- 不把 `semanticKind` hint 当作可写证明；目标 schema/action mapping、authority candidate、
  state/action authority 和 bridge binding 仍由 Hub policy/catalog/coordinator 决定。
- 不把 proposal approval、dry-run passed、artifact compiled、action candidate available 或
  plugin loaded 当作 device authority；不自动选择字典序 action route。
- 不在 uninstall、rebind、policy change、bridge epoch change 或 artifact supersede 后复用旧
  approval、nonce、route、watermark 或 rollback claim；可能执行的动作永不自动重试。

本文接受后，M3b 的实现只能按本闭集和 gate 增量交付。任何新增 trigger、condition、action、
risk class、target reference、compiler output 或 remote seam，都必须先增加 versioned schema、
hash/approval 绑定、TDD conformance、audit 事件和新的 milestone gate；不能以“先放一个开放
字段，未来再解释”扩大 Phase 1 contract。

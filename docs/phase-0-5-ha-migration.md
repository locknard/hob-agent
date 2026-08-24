# Phase 0.5：Home Assistant 迁移决议

状态：当前实施基线
日期：2026-08-24
范围：在单一 DSH/Cordis 产品运行时内，把一组可解释、可回退的 Home Assistant 自动化迁移为 HobAgent 管理的中立 Artifact。

## 决议摘要

Phase 0.5 的产品目标是让家庭成员选择迁移范围，并完整看到每条规则从发现、评估、翻译、模拟到切换和回退的证据。HA 继续承担现有设备生态和首期自动化执行宿主；HobAgent 负责中立语义、治理、证据、部署编排、读回验证和审计。

运行时固定为一个 TypeScript 服务、一个 Cordis 组合根和一个 DSH Agent Runtime。当前 HA 适配器作为同一服务中的受信适配器挂载；桥契约保留未来进程边界，Phase 0 和 Phase 0.5 的组成只包含这一套服务、这一套 Agent loop 和受信桥适配器。

## 迁移状态机

```text
discovered → assessed → translated → simulated → ready → switching → verified
      │           │            │            │          │          │
      └───────────┴────────────┴────────────┴──────────┴──────────┴→ needs_attention

verified → rolling_back → restored
```

- `discovered`：Hub 从 HA `foreignRules@2` 目录取得有界规则摘要，并绑定 `epochId + lastSeq`。
- `assessed`：Hub 完成能力覆盖、空间映射、证据新鲜度、现有规则冲突和权限评估。
- `translated`：Hub 生成绑定 Hub capability identity 的中立 Artifact candidate，并保留逐项差异。
- `simulated`：Hub 在一致性 world cut 上执行无写入双跑模拟，记录预期触发、动作和现有规则干涉结果。
- `ready`：证据、策略、编译、模拟和回退计划均达到可审阅标准；此状态才进入家庭决定面。
- `switching`：家庭成员已经作出一次启用决定，Hub 以精确 Artifact revision 部署并等待 HA 读回。
- `verified`：HA 返回 Hub 创建的自动化身份和配置指纹，Hub 验证运行状态、目标和审计记录。
- `needs_attention`：任一阶段的证据、能力、策略、桥连接、编译、模拟、部署或读回结果需要家庭成员处理；修复后重新评估并保留原始失败证据。

双跑输入由 Hub 服务端的只读证据端口提供，端口回传与请求完全一致的
`bridgeId + epochId + lastSeq + configFingerprint`。模拟 receipt 同时绑定中立候选内容、
Artifact id/revision/content hash、compile result 和 dry-run result；Store 在进入
`simulated` 以及进入 `ready` 时都重新校验这些绑定。进入 `ready` 前，runtime 再次通过
受信 HomeWorld 翻译路径复查候选和来源指纹。任何 source cut 漂移、证据缺失、制品版本
变化或 receipt 不一致都会停在固定的 needs-attention 状态，且不会执行远端写入。

生产组合根在 HomeWorld 挂载后自动提供这一只读证据端口。端口只读取同一 source cut 下
完整的规则目录、逐条中立翻译和最近七天的 Hub journal evidence；目录前后必须完全稳定，
evidence coverage 必须完整且未截断，事件必须来自同一 bridge/epoch 并位于 catalog baseline
之后。至少出现一次候选 trigger 才能形成双跑 receipt。首期 journal 不记录 schedule 的实际
触发历史，因此 schedule candidate 固定保持 simulation unavailable；系统不会根据当前时间
合成触发样本。这个限制在 Hub 拥有可审计的 scheduler occurrence source 后才能解除。

- `rolling_back`：家庭成员或 Hub 按明确回退条件请求恢复；Hub 先停止 HobAgent 创建的自动化，再恢复原配置并等待读回。
- `restored`：回退后的 HA 状态与切换前快照一致，Hub 写入完成审计；回退失败继续进入 `needs_attention`。

状态转换由 Hub 原子记录。进程重启、桥超时、watermark 漂移、重复请求和 stale revision 都进入可恢复的明确状态；系统从不重复部署或把未知结果标记为成功。

## 权限边界

| 角色 | 允许的能力 | 永久保留的边界 |
| --- | --- | --- |
| DSH Agent | 读取 Hub 提供的中立规则摘要、世界模型证据和评估结果；通过 governed tool 提交迁移候选和解释 | Agent 权限止于中立读侧和候选提交；HA 写入、原生 service、native route、authority candidate 和状态机决定全部归 Hub 所有 |
| 家庭成员 | 选择迁移范围；审阅精确 diff、证据、冲突和回退方案；对 `ready` 方案作一次启用决定；暂停、关闭或请求回退 | 家庭成员通过产品审阅面行使决定；Bridge client 和远端执行权限归 Hub 所有；高影响动作沿用 Hub 的在场设备确认规则，成人管理员不是产品角色 |
| Hub | 读取和绑定 watermark；运行评估、翻译、编译、模拟、策略检查、部署、读回、状态迁移、回退、审计和通知 | Hub 通过已注册的中立 Bridge contract 访问生态；所有写入绑定精确 Artifact revision、幂等键、策略结果和审计记录 |
| HA Bridge | 返回中立设备/能力/规则摘要和健康状态；接收 Hub 编译的自动化；返回部署、启停和读回结果 | Bridge 职责限于中立数据和精确命令回执；家庭意图、Artifact、迁移决定和 Agent payload 解释权归 Hub 所有；HA 外部规则继续由 HA 自己管理 |

## 首期迁移子集

首期迁移以可解释、可回退的家庭舒适行为为边界。Hub 只接受同时满足下列闭集的 HA 规则：

1. 触发器是固定时区的有界 `schedule`，或一个已注册 capability 的 `capability_changed`。
2. 条件是最多八项的扁平 AND，每项比较一个 Hub capability value；比较值通过 capability schema 校验。
3. 动作使用中立 `set_level`、`set_boolean` 或 `notify_local`。首个真实切换切入单个灯光或开关 capability；每个设备动作带有 `restore_previous_state` 回退和有界 postcondition。
4. 目标只引用 Hub-owned `hwCapabilityId`。编译时由 Hub 解析 HA binding，Artifact 只保存中立目标和行为意图；entity、service、native id、provider rule id、URL 与原生 payload 留在 Hub-owned binding 和审计边界内。
5. HA 规则目录、事件水位和设备能力在同一个一致性窗口内可读，且现有规则冲突可以由 Hub 精确列出。

模板、脚本、场景、任意 service call、表达式、嵌套 OR、循环、外部 URL、锁/门禁、燃气/供水、报警、医疗和其他安全敏感行为进入后续专项能力评估。媒体持久化规则继续沿用受治理的一次性媒体动作链，待中立媒体 Artifact contract 单独通过后再进入迁移子集。

## 一次决定和回退规则

后台准备在 `ready` 之前完成证据、冲突、权限、编译和无写入模拟。家庭成员在 `ready` 状态对精确 Artifact revision 作出一次启用决定；该决定直接触发 Hub-owned 部署和验证。

迁移使用显式、Hub-owned 的 migration review lane。它复用同一套 Proposal、Artifact、证据、编译、dry-run、一次决定和审计边界，但不占普通主动建议的五条注意力名额。迁移 lane 自己保持有界并只接纳家庭成员明确选择的规则；producer 名称、文案或任意请求字段都不能隐式获得该 lane。

部署成功只在 HA 读回匹配目标、配置指纹和运行状态后显示为 `verified`。读回出现未知、超时或漂移时，Hub 显示 `needs_attention` 并保留切换前快照。暂停、关闭和回退都由 Hub 发送带幂等键的明确命令，并分别记录 actor、revision、bridge watermark 和结果。

### 切换写侧桥合同

原 HA 规则使用独立、版本化的 `foreignRuleControl@1` 中立扩展进行状态读回和启停。该扩展只接受 `foreignRules@2` 产生的 opaque `ruleRef`、Hub 生成的操作幂等键和预期 source fingerprint；原生配置 id、entity、service、URL 与原生响应始终留在适配器内部。`automations@1` 继续只管理 Hub 创建的自动化，两个扩展互不扩张权限。

家庭成员批准精确 `ready` revision 后，Hub 先读回原规则的运行状态和配置指纹，再原子记录 `switching`。首期切换先停用原规则并确认其为暂停状态，再通过现有 Proposal 部署通道创建并验证 Hob 自动化；这段有界切换窗口不允许原规则和新规则同时运行。Hub 只有在原规则保持暂停、新规则运行、部署 identity 和配置指纹全部匹配时记录 `verified`。任一步出现 stale source、超时、未知结果或读回不一致时，Hub 停止后续写入；已知失败恢复原规则，未知结果先读回再决定恢复或继续，系统不盲目重放命令。

回退固定执行 `verified → rolling_back → restored`：Hub 先停止并撤下 Hob 自动化，确认其不再运行，再按切换前快照恢复原规则并读回。回退中的未知结果保留两个自动化的最后已知状态、操作幂等键、actor、精确 Proposal/Artifact revision、source fingerprint 和 bridge watermark，并进入可恢复的 `needs_attention`。

迁移在一次决定之后发生的切换或回退失败，向 Proposal 产品面投影为 `recovery_required`，不会投影为“运行中”或“已关闭”。家庭成员选择“继续恢复”时沿用已经批准的 Artifact 与部署意图，Hub 先读取原规则和 Hob 自动化的当前状态，再为恢复动作签发新的操作幂等键；该动作不是第二次批准。只有源规则恢复且 Hob 自动化已经撤下时，Proposal 才进入 `closed`；任何一侧状态未知时保持 `recovery_required`，不盲目重放写命令。

### 家庭选择入口

Hub 在迁移 runtime 与 Inbox 之间提供独立的 assessment facade。该 facade
读取同一进程中已经挂载的 migration runtime，向已认证产品面投影 assessment
状态、家庭可读的规则名称和闭合的选择状态。Raw assessment、`ruleRef`、source
fingerprint、bridge watermark、原生 identity 和 provider payload 保持在 Hub
边界内；Inbox、HTML、URL、日志与浏览器提交均不包含这些字段。

每个可选择规则由服务端签发短期 opaque `selectionToken`。Hub 把 token 绑定到
当前产品 principal、精确 assessment/source cut、`migrationId + ruleRef` 和运行时
generation。Raw token 只进入当前认证页面和有界的进程内 token cache；SQLite
selection audit 只保存 token digest、绑定关系和状态。Token 不可跨 principal 重放，
进程重启、过期、source cut 变化或完成一次提交后即失效；页面重新读取 projection
可取得新的 token。浏览器表单只提交 token，actor 由已认证产品 session 注入。

Migration SQLite 是 selection audit 的唯一耐久 owner。每条记录保存 selection id、
迁移与规则引用、source bridge/epoch/seq/fingerprint、认证 principal、私人设备绑定结果、
token digest、runtime generation、签发/过期时间、revision、闭合状态和可选 Proposal
引用；它不保存 raw token、session credential、原生规则 body 或 provider payload。
状态使用 `issued → processing → prepared`，以及终结出口 `unavailable`、`expired`、
`invalidated`。`issued → processing` 使用 revision/generation CAS；同 token、同 principal
重放返回既有结果，不同 principal、旧 generation 和变化后的 source cut 均不创建
Proposal。

选择 actor 永久记录在 selection audit 中，后续 producer-owned Proposal `created`
事件不会覆盖这条身份事实。若进程在 Proposal 创建后、selection completion 前退出，
重启恢复只按确定性 Proposal identity 补写关联；找不到精确 Proposal 时记录
`unavailable`，系统不会以 `system` 或 producer 身份重新选择。Token 签发对同一
principal、rule、source cut 和 generation 幂等，避免页面刷新制造无界审计记录。

选择状态使用闭集：

- `selectable`：aggregate 为 `assessed`，规则为 `eligible`，workflow 为初始
  assessed 状态；家庭成员可选择“准备迁移建议”。
- `prepared`：规则已经进入 `translated`、`simulated` 或 `ready`；产品链接到现有
  migration Proposal，并保持幂等。
- `unavailable`：aggregate、rule disposition、workflow、source cut 或 token 不满足
  当前准备条件；产品显示固定恢复说明，不创建 Proposal。

读取列表需要已认证产品 session；提交选择需要绑定的私人设备，并复用现有
same-origin mutation gate。提交只调用 `prepareRuleReview`，创建本地 migration review
draft 并进入既有 Artifact、compile、dry-run 和一次决定管线。该入口不挂载第二个
runtime，不向 Agent 注册选择工具，也不调用 `foreignRuleControl@1`、
`automations@1` 或 `actions@1`。HA 写入能力只在家庭成员随后批准精确 `ready`
Proposal 后进入既有 deployment seam。

## Phase 1 原生适配器进入门槛

原生 Matter、Zigbee、BLE、ESPHome 或其他协议适配器在 Phase 0.5 的迁移证据达到以下门槛后进入评审：

1. HA 首期迁移子集完成一条真实家庭纵切：发现、评估、翻译、模拟、一次切换、读回验证和真实回退全部有可审计结果。
2. 迁移链通过重启、桥断连、超时、状态漂移、重复提交和回退失败验收；每种情况都保持 fail-closed 和可恢复状态。
3. 新适配器通过同一版 Bridge contract、一致性测试套件、能力 schema、事件 epoch/seq、动作 ack/幂等、健康区分和读回验证。
4. 适配器宿主登记物理资源唯一属主，具备生命周期、崩溃恢复、日志归集、版本锁定和撤销审计。协议栈怪癖库较厚的适配器可以在 Phase 1 采用受管 sidecar；轻量协议采用 TypeScript 进程内形态。
5. 真实家庭观察周期显示迁移行为保持稳定，人工覆盖、回退和未知结果处于可接受范围，且家庭成员可以独立解释每条行为的原因和停止方式。

门槛通过后，Hub 仍以同一中立 contract、策略边界和 Artifact/审计路径接入原生适配器。适配器形态不会改变 Agent、家庭成员和 Hub 的权限分工。

## 废止的旧口径

- 独立 pi 或 `pi-agent-core` 作为 Agent runtime 的方案已废止。DSH 是唯一 Agent Runtime，Cordis 是唯一组合与生命周期底座；`pi-ai` 仅作为官方 DSH provider adapter 的实现依赖。
- “方向批准 → 试运行 → 第二次批准 → 启用”的提案链已废止。准备完成后，家庭成员对精确方案作出一次启用决定，启用立即进入受治理部署和验证。
- “成人管理员”作为产品权限模型已废止。高影响动作使用 Hub 的动作档位、在场状态和绑定私人设备确认；兼容存储字段不构成新的产品角色。
- Phase 0 采用 HA sidecar、独立 Bridge 进程或第二套执行 runtime 的实现口径已废止。Phase 0/0.5 使用单一 TypeScript 服务中的受信适配器；受管 sidecar 只属于通过门槛后的 Phase 1 宿主规范。

## 实施顺序与验收

实施顺序固定为：

1. `foreignRules@2` 目录和 Hub watermark 读侧；
2. 有界评估、能力映射和冲突报告；
3. 中立 Artifact candidate、编译和无写入双跑；
4. `ready` 收件箱和一次启用决定；
5. HA 自动化部署、读回验证、持续状态和耐久通知；
6. 暂停、关闭、回退和重启恢复；
7. 真实家庭纵切与 Phase 1 适配器门槛评估。

真实 HA 的只读 assessment operator 使用：

```sh
pnpm assess:home-migration -- --bridge-id <configured-bridge-id>
```

该命令只读取现有 `HOB_DATA_DIR`/`HOB_BRIDGES` 配置下的一个明确桥，等待
当前一致性 cut，通过 `foreignRules@2` 和 `foreignRuleMigration@1` 完成中立
分类，并把 assessment 持久化到本地 `home-automation-migrations.sqlite`。
输出只包含 opaque assessment id、规则聚合计数和固定状态；远端写入标记始终为
`false`。它不创建第二 runtime，不调用 `foreignRuleControl@1`、
`automations@1` 或 `actions@1`，也不替代 Proposal、Artifact、simulation、一次
决定或 deployment gate。

评估完成后，可对一个明确的 opaque assessment id 做只读 candidate preview：

```sh
pnpm preview:home-migration -- --assessment-id <assessment-id>
```

命令只接受上一阶段生成的 32 位小写十六进制 id，重新读取 durable assessment，
仅逐条调用现有 `createArtifactCandidate` 处理 `eligible` 规则。开始和结束都必须
看到与 assessment 完全相同的 source bridge `epochId + lastSeq`；切换中发生漂移时
返回固定 `source_unstable`，不交付 partial counts。输出只有 assessment id、eligible /
candidate / needs-attention 聚合、固定原因计数和 `remoteWritesPerformed: false`。
它不创建 Proposal/Artifact，不调用 prepare、refresh、deploy、control 或 actions，
同一 assessment 可安全重跑。

完成评估、选择或后续工作流步骤后，操作员可以查询同一个 opaque assessment id 的
耐久证据聚合：

```sh
pnpm status:home-migration -- --assessment-id <assessment-id>
```

status 命令是独立的只读证据面。它只对已经存在的
`home-automation-migrations.sqlite` 和（存在 workflow Proposal link 时）
`proposals.sqlite` 做 `readOnly` 打开，并在打开前用 `lstat` 拒绝 symlink 和非普通文件；
它不执行 schema setup、schema migration、`PRAGMA` 写入、过期清理、recovery、prepare、
deploy、control 或任何桥/设备调用。输出固定为 assessment 状态和 disposition/workflow/
failure 聚合、selection status 聚合，以及 linked migration Proposal 的 review/lifecycle/
application/deployment 聚合，并明确
`readMode: "durable_only"`、`remoteWritesPerformed: false`、
`localWritesPerformed: false`。输出不包含家庭名称、`ruleRef`、principal、token digest、
source cut/fingerprint、Proposal/Artifact id、native id 或 provider payload。

status 只接受一个明确的 32 位小写十六进制 assessment id。assessment 缺失、SQLite 文件
缺失/损坏、Proposal payload 超出有界读取上限、Proposal row 与 payload 元数据不一致，或
workflow 与 Proposal 跨库不一致时，命令固定返回 `outcome: "needs_attention"` 及有限 reason，
并保持 fail-closed。没有 linked workflow 的 assessment 直接报告零 Proposal 聚合，因此不
要求尚未创建的 Proposal 数据库；存在 link 时缺少 Proposal 数据库或 Proposal row 则返回
固定的 unavailable/inconsistent reason。status 从不创建缺失文件。

每一步都以确定性测试、`pnpm test`、`pnpm check`、`git diff --check` 和真实浏览器双视口证据交付。任何实现都以本决议的状态机、权限边界、首期子集和 fail-closed 规则为验收依据。

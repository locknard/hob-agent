# One Decision Automation：第六轮实现评审

## 评审对象

- 分支：`claude/one-decision-automation`
- 评审提交：`560b0beb86e7329a38be084cc9c9d694332c4e2b`
- 评审日期：2026-08-22
- 结论：方向正确，完成以下 4 个 P0 后进入合入验收。

## 产品判断

DR-017 的方向成立：家庭是一个信任域，安全跟随动作后果，而不是家庭成员等级。

核心产品规则应保持简单：

- 直接动作按既定动作策略执行。
- 需要确认和高影响保护动作由“在场 + 绑定到本人的私人设备”完成确认。
- 家庭成员角色不参与设备动作的确认资格判断。
- 共享屏承担查看与操作入口，私人手机承担需要身份连续性的确认。
- TTL、设备绑定、部署一致性、状态读回用于防止误操作和系统漂移。
- `admin`、`adult_member`、`administrator`、`adult_admin` 可以作为兼容数据继续存在，但不再决定设备控制行为，也不作为用户需要理解的产品概念。

本轮采用现有模型完成根因修复。无需增加新的权限体系、第二套 revision、制品引用层或额外状态机。

## P0：合入前必须完成

### P0-1：重新验证后的 proposal 无法持久化回读

#### 现状

`returnToPreparation` 和 `markEnableBlocked` 都会把 `revalidation_required` 写成 pending proposal 的最新审计事件：

- `packages/hub/src/home/proposal-store.ts:1183`
- `packages/hub/src/home/proposal-store.ts:1244`

但 `PENDING_TAIL_AUDIT_ACTIONS` 没有包含 `revalidation_required`：

- `packages/hub/src/home/proposal-store.ts:2469`

#### 实际影响

写入调用会返回一个看起来正确的对象。下一次 `get()` 或 `list()` 从 SQLite 读取该记录时，`fromRow` 会把它判定为损坏记录并抛出 `corrupt_store`。

这同时破坏两个新增闭环：

1. 世界变化后回到 preparing；
2. 动作无法自动化后停在 ready 并显示受阻原因。

#### 根因修复

统一 pending proposal 的持久化不变量，让 `revalidation_required` 成为 preparing/ready 状态允许的最新审计事件。

#### 验收

- `returnToPreparation` 写入后，重新调用 `store.get(id)` 能读取相同 revision 和 lifecycle。
- `markEnableBlocked` 写入后，重新调用 `store.get(id)` 能读取相同 reason 和 lifecycle。
- 关闭并重新打开 SQLite store 后，两种记录仍可读取。

### P0-2：启用受阻事实没有进入产品界面

#### 现状

Hub 的 `ProposalEnvelope` 已经持有 `enableBlockedReason`，但该字段没有进入：

- `ProductProposal`；
- `projectProductProposal`；
- proposal 详情页渲染。

相关位置：

- `packages/inbox-web/src/product-shell.ts:83`
- `packages/inbox-web/src/proposal-inbox-service.ts:1247`
- `packages/inbox-web/src/product-shell.ts:958`

#### 实际影响

受阻方案仍显示普通 ready 卡片，并提供“启用”“以后再说”“不用了”“在对话里改”。用户看不到受阻原因，点击“启用”只会再次进入同一条受阻路径。

这与已经确定的产品语义不一致：受阻卡应诚实停住，并只保留“在对话里改”和“不用了”两个出口。

当前实现还把 `authority unavailable` 和真正的高影响保护统一描述为“动作已进入高影响保护”。临时不可用、配置缺失和动作后果升级属于不同事实，应使用对应的家庭语言。

#### 根因修复

- 把 `enableBlockedReason` 投影到 `ProductProposal`。
- ready 详情根据该字段渲染受阻状态。
- 受阻状态展示具体原因，并只提供“在对话里改”和“不用了”。
- 分别表达“动作进入高影响保护”和“当前执行能力不可用”。

使用现有字段即可完成，无需增加新生命周期。

#### 验收

- Hub 返回 blocked reason 后，刷新页面仍显示同一受阻原因。
- 受阻卡不存在“启用”和“以后再说”。
- 受阻卡保留“在对话里改”和“不用了”。
- 高影响保护与执行能力不可用显示不同、准确的文案。

### P0-3：DR-017 尚未进入一次性动作的真实放行路径

#### 现状

`one-shot-action-plane.ts` 的 `isEligible` 仍然根据 `admin/adult_member` 判断确认资格：

- `packages/hub/src/authority/one-shot-action-plane.ts:851`

当前行为是：

- `member` 和 `child` 即使在场并使用绑定本人的私人手机，也无法确认；
- `admin` 和 `adult_member` 可以在共享设备上确认 confirmation 动作；
- administrator 分支没有检查 `present`。

这些判断仍直接作用于 `approve`、`canApprove` 和 `reject`，因此属于真实业务行为，而非兼容拼写。

#### 根因修复

统一待确认动作的资格判断：

```text
actor.present
&& actor.device.kind === "private"
&& actor.device.boundPrincipalId === actor.principalId
```

`policyClass` 继续描述动作后果和产品披露，不再改变家庭成员的确认资格。

#### 验收

- `member` 在场并使用绑定本人的私人手机，可以确认。
- `child` 在场并使用绑定本人的私人手机，可以确认。
- 任意角色使用共享屏都无法确认。
- 任意角色不在场都无法确认。
- 私人设备绑定到另一位成员时无法确认。
- confirmation 和兼容名为 administrator 的档位遵循同一设备规则。

### P0-4：具名确认设备变化不会触发重新准备

#### 现状

`BridgeAutomationDeployment.resolveIntent` 只比较准备时与启用时的动作档位集合：

- `packages/hub/src/home/bridge-automation-deployment.ts:93`

接口只接收 `actionPolicyClasses`，没有接收准备时披露的 `confirmationDeviceNames` 或对应 capability 集合。

#### 实际影响

一个方案同时包含 direct 和 confirmation 动作时，需要确认的设备可能发生互换，而档位集合仍然是 `direct,confirmation`。系统不会重新准备，用户看到的具名设备披露已经过期。

这破坏了已经建立的批准语义：用户看到的设备、用户批准的设备、系统部署的设备应保持一致。

#### 根因修复

把准备时的确认设备事实传入 `resolveIntent`，同时比较：

- 动作档位集合；
- 需要确认的设备集合。

推荐比较稳定 capability id 集合，并使用当前家庭设备名生成展示文案。若本阶段继续使用名称，则至少完成排序、去重和完整集合比较。

#### 验收

- 档位集合不变、确认设备集合变化时，方案回到 preparing。
- 重新准备后的卡片显示新的具名设备。
- 确认设备集合和档位集合均未变化时，启用路径正常收敛。

## P1：建议本轮一起收口

### P1-1：deploymentIntent 需要轻量运行时完整性校验

`decideProposal` 目前只要求 `targets.length > 0`，`validateDecideInput` 没有验证 deployment intent 的字段、边界、重复项和覆盖范围：

- `packages/hub/src/home/proposal-store.ts:1430`
- `packages/hub/src/home/proposal-store.ts:2524`

生产 resolver 会生成完整向量，但 store 的公开服务仍可接收残缺数据。建议增加一组轻量断言：

- deployment id、target 和 binding 字段满足长度与字符边界；
- capability id 不重复；
- 每个 target 属于同一部署桥；
- 部署前，intent targets 与编译规格使用的 capability 集合完全一致。

这是一条输入不变量，不需要建立新抽象层。

### P1-2：Onboarding 仍有无意义的成员身份选择

第四步显示“成员身份”下拉框，但只有“本人手机 · 家庭确认”一个选项：

- `packages/inbox-web/src/product-shell.ts:518`

用户没有需要做出的选择。浏览器在 390px 移动端宽度下也确认该单选项真实存在。

建议：

- 从界面删除 `memberRole` 字段；
- 服务端继续填入兼容命令值 `adult_admin`；
- 第五步的“设置操作权限/权限级别”改成家庭语言，例如“这些动作怎么确认”。

## 已确认成立的修复

以下实现可以保留：

- preparation job 的 succeeded 状态与 receipt refs 在同一条 UPDATE 中原子写入；
- receipt refs 成为 `completePreparationJob` 的必填参数；
- 自动化草案不能再通过 `/review` approve；
- 洞察 approve 不再进入 `enabling`；
- 修订合并时，缺席的可选字段会清空；
- `drift_detected` 与 `drift_restored` 审计事件成对；
- 世界披露变化进入重新准备，动作明确无法自动化进入稳定受阻状态；
- 兼容层保留旧角色枚举与命令值，避免无收益的数据迁移。

## 验证记录

在提交 `560b0be` 上完成：

- `pnpm test`：1277 tests passed；
- `pnpm check`：通过；
- `git diff --check 321d368..HEAD`：通过；
- 工作区：干净；
- 浏览器检查：390px 移动端宽度，确认 Onboarding 第四步存在只有一个选项的“成员身份”字段。

测试全绿说明现有用例稳定。本评审指出的 P0 主要位于新增路径的持久化回读、产品投影和跨层不变量，当前测试尚未覆盖这些组合。

## 合入验收结论

完成四个 P0，并补齐对应的持久化回读、权限矩阵、具名披露变化和受阻卡浏览器测试后，可以进入最终合入验收。两个 P1 都是局部收口，建议本轮同步完成。

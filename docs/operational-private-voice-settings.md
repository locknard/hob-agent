# 运行期私有语音设置

状态：已采纳并按本文边界实现。本文定义 Phase 0 的运行期私有语音设置；它不改变家庭自动化、动作治理或 DSH Agent 的权限边界。

## 先解决家庭正在遇到的事

首次设置中的“本次跳过语音”是合理选择，不是失败。家庭常在以下情形先启用文字产品：

- 搬家、换路由器或首次接入 Home Assistant 时，先确认家庭状态、提案与审核工作正常；语音服务可以稍后再接入。
- 自建 ASR/TTS 尚在下载模型、校准麦克风、选择语言或等待一台家庭设备到位；此时文字入口让家庭立即开始使用产品。
- 家中不同成员对声音、语言和是否在本地处理语音有不同偏好；家庭需要在日常使用后再作决定。

已经启用语音的家庭也会自然地迁移服务。家庭服务器维护、模型升级、地址变更、声音或语言调整、某个服务暂时离线，都是普通运营事件。产品应让成员在设置中验证新服务，平稳切换；正在使用的旧语音继续完成已经开始的一轮，而文字、家庭状态和审核入口始终可用。语音短暂不可用时，产品明确显示恢复路径并提供重试，不把家庭带回首次设置，也不要求重启整个家庭助手。

这项体验承诺与治理并不冲突：家庭成员应当能方便地启用、重配和关闭自己的本地语音；同一时刻，每一轮请求仍清楚地使用一组已验证的输入和输出服务，且任何语音内容都不获得设备执行权。

## 业务现状与已经收口的断链

当前实现已完成首次设置的最小闭环：

- `ProductVoiceSetup` 分别对本地 Wyoming 或 OpenAI-compatible 的 ASR、TTS 进行 probe；凭据只以 staged Vault reference 保存，probe 成功后才进入设置草稿。
- `ProductSetupController` 允许在语音步骤明确跳过；跳过后启用配置不含 `voice`，文字产品照常激活。
- `ProductBootstrapConfigStore` 将已验证的可选 `voice` 与产品 generation 一起持久化。`ProductRuntimeSupervisor` 在首次激活或进程启动加载该配置时创建 `PrivateVoiceProviderRuntime`，后者仅在两条轨道都可用时成为 `active`，否则给出 `degraded`。
- 浏览器 voice surface 管理每个页面的采集、取消、文字接管与播报状态；Product HTTP gateway 将最终 transcript 送入既有 Inbox/DSH 对话路径，并以 `PrivateVoiceProviderRuntime` 调用已验证的 ASR/TTS。它不新建 Agent loop，不接触 Hub 动作或 Home Assistant 原生调用。

实施前的断链同样明确：operational Inbox 没有语音设置对象、路由或配置编辑事务；Supervisor 只在初次 mount 时把一个 `PrivateVoiceProviderRuntime` 交给 operational bundle。当时的 generation commit 仅供首次激活使用，运行期没有“候选语音配置 -> probe -> generation CAS -> 原子替换”的路径。因此：

1. 跳过语音的家庭不能在完成 setup 后启用它；
2. 已启用家庭不能重配或关闭它；
3. 若直接重用首次激活 mount 来实现更新，就会重新 mount operational HomeAgent/DSH/Inbox 组合，破坏现有会话、对象 identity 和正在进行的工作；
4. 旧 provider 在替换时没有明确的 drain、失败回退或旧 Vault reference 清理所有权。

根因不是缺少一个表单，而是“首次设置候选的所有者”承担了唯一的语音装配职责，而运行中的 Supervisor 没有稳定、可交换的语音边界。本轮在该所有权边界补齐了稳定 gateway、运行期配置事务、代际 lease 与精确凭据清理；更新语音不再重跑 setup 或重建 Agent。

## 决策：Supervisor 拥有稳定且可切换的 Voice Gateway

`ProductRuntimeSupervisor` 成为运行期 voice gateway 的唯一 owner。它在 operational 产品 mount 前创建一个稳定 gateway，并将这个相同对象交给 Inbox/voice surface。之后启用、重配、关闭与恢复只替换 gateway 当前指向的 provider generation；**Inbox 已持有的 gateway 对象 identity 不变**。

gateway 只负责三件事：选择当前可接受新 turn 的 provider generation、为每个 turn 签发 lease、在代际替换时 drain 或停止 provider runtime。它不采集音频、不播放音频、不解释文本、不创建 DSH session，也不调用 Hub、bridge 或 Home Assistant。capture surface 继续执行现有状态机 effects；DSH 继续是唯一的 Agent loop。

```text
Inbox / voice surface（持有同一个 VoiceGateway 对象）
  -> 每轮申请 lease：captureMode + provider generation 固定
  -> ASR final
  -> 既有 Inbox -> DSH Agent loop -> 既有 Hub governed tools
  -> 同一 lease 的 TTS

ProductRuntimeSupervisor
  -> 稳定 VoiceGateway
  -> active provider generation / draining provider generations
  -> 运行期配置事务、CAS、Vault cleanup ledger
```

此设计将“服务替换”限制为语音接入层的局部变化。HomeAgent、DSH、Hub、bridge 和已存在的 session 不重新 mount；普通对话与语音页面也不会读取 provider endpoint 或 secret。只有已认证的本地 Settings 表单通过窄配置端口读取 canonical endpoint，方便家庭核对和修改自建服务；密钥始终只进入请求体与 Vault。gateway 的状态与 provider 错误继续使用闭合、面向产品的分类，而不是展示内部错误或密钥信息。

### 每轮 lease 的不变量

gateway 在接受一个新 voice turn 时创建不可变 lease，包含 gateway 本地 `leaseId`、配置 generation、provider generation 和 `captureMode`。HTTP owner 另行签发只绑定当前产品会话的 opaque `voiceTurnId`，浏览器从不接触 `leaseId`。这些身份各自承担一种职责：配置 generation 是持久化 CAS revision；provider generation 是 lease 钉住的运行时实例；candidate id 是提交前凭据与清理所有权的唯一标识；`voiceTurnId` 只是浏览器访问这条服务端 lease 的短生命周期能力。`captureMode` 由 ASR transport 决定（当前为 `encoded_audio` 或 `pcm_s16le`），并与同一 provider generation 一起钉住。

产品配置中的 `activatedAt` 保留“家庭首次启用”的含义。运行期语音账本记录候选凭据的建立时间、配置 generation 与所有权阶段；语音设置不会重写家庭首次启用时间。

- capture surface 在开始采集前取得 lease，并据此编码音频；它不会在流中途根据新配置改编码。
- ASR、final transcript 以及该轮的 TTS 均通过同一 lease 调用同一 provider generation。新配置从不接管已开始的一轮。
- 一个 lease 在播报完成、显式取消、未请求播报的有界保留期结束、超时或 drain 期限结束时释放。DSH 回答完成后，lease 继续保留到同一轮 TTS 完成或保留期结束；释放后 gateway 才能 dispose 对应旧 provider。
- 新 turn 只从当前 `active` generation 取得 lease。`disabled` 或 `degraded` 时不签发 lease，voice surface 直接给出文字入口和明确恢复动作。

这一规则同时保护体验与正确性：一轮请求始终由同一个服务 generation 完成；迁移让正在说话、等待 DSH 或播放答复的成员继续当前轮次。对已进入 Hub 的动作，既有浏览器语音状态机与 Hub 的核验规则继续决定结果，语音切换保持动作状态独立可追溯。

### 浏览器在采集前取得 lease

ASR transport 可能改变浏览器编码方式，因此浏览器在请求麦克风之前先取得一条短生命周期 lease。运行中的产品使用以下单一路径，并直接替换尚未发布的旧语音路由：

- `POST /voice/turns` 接受空的同源请求，返回 opaque 256-bit `voiceTurnId` 与该 lease 的 `captureMode`。浏览器拿到结果后才请求麦克风权限。
- `POST /voice/turns/:voiceTurnId/transcribe` 只接受一次有界音频上传；格式校验与 ASR 都使用 lease 钉住的 mode 和 provider。成功启动既有 DSH 对话后，服务端把同一 lease 原子绑定到 canonical `adviceId`。
- `GET /voice/turns/:voiceTurnId/speech` 只读取该 lease 已绑定且完成的 canonical answer，并通过同一 provider generation 完成 TTS。客户端不提交 answer 或其他 `adviceId`。
- `POST /voice/turns/:voiceTurnId/release` 幂等释放本地音频、ASR 与 TTS 等待；它不取消 DSH、Hub 或设备动作。已进入 DSH 的取消继续只走 canonical conversation stop 路由。

HTTP owner 将 opaque id 绑定到当前产品会话，最多保留 8 条；id 不编码 provider、generation 或配置。采集/上传/ASR 从签发起最多 60 秒，绑定 advice 后最多保留 5 分钟，回答完成后 30 秒内可开始播报。到期或释放会中止本地 provider 调用并移除映射，canonical 文字回答继续存在。进程重启会释放全部内存 lease，仍在运行或已完成的 DSH 对话以文字继续。

## 运行期配置事务

设置提交不是直接改 active config。它以一次有版本的候选事务完成，路径如下：

1. **开始候选。** Settings 从当前非 secret 的 voice projection 创建一个带 expected configuration generation 的草稿。首次跳过的家庭从 `disabled` 开始；已启用家庭以当前 active 配置为只读基线。草稿只属于当前已认证的本地 operational session。
2. **逐轨验证。** ASR 与 TTS 继续使用现有窄 transport 和真实、有限 probe。新凭据在写入 Vault 前先取得 durable staging lease；后台事务只向页面交付面向家庭的完成、取消或可修复失败结果。候选必须同时拥有已验证的 ASR 与 TTS 才能启用或替换。
3. **构造候选 generation。** Supervisor 从同一已验证 revision 构造完整 voice config，创建并启动 candidate provider runtime。候选在 provider 内部完成双轨 health/probe 后才可进入提交；它不接收用户 turn。
4. **CAS 持久化。** Supervisor 以 expected generation 调用配置 store 的 compare-and-swap commit。成功配置获得下一个 durable generation；冲突表示另一次设置已完成，页面刷新为当前状态，不覆盖他人的改动。
5. **同步 swap。** commit 成功后，Supervisor 在一个串行临界区将 gateway 的 active 指针切到 candidate provider generation，再向 Settings 返回成功。新 turn 从此使用候选；gateway 立即把旧 generation 标为 `draining`。这一交换不重新 mount operational bundle。
6. **drain 与收尾。** 旧 generation 拒绝新 lease，等待其既有 leases 完成。正常 drain 后 dispose 旧 runtime，并由 cleanup ledger 删除仅属于旧 generation 的 Vault references。超过明确上限的 lease 依照现有取消/不确定性语义结束本地等待；Hub 已认领工作继续可核验。

候选在步骤 2、3 或 4 失败时，gateway 保留旧 `active` provider 和持久化配置；Settings 展示该候选失败、可修正字段和重试。失败不会关闭旧语音，不会影响文字，也不会删除当前 active references。关闭语音是一种同样的代际事务：CAS 将 config 切为无 `voice`，gateway 同步进入 `disabled` 并停止接受新 lease，已有 lease drain 后释放 runtime 与该 generation 的 references；模型、bridge、媒体、DSH 和文字通道保持运行。

### commit 与 swap 的恢复规则

`commit` 与内存 swap 不可能跨进程构成单条原子指令，因此明确恢复点：

- commit 前候选失败：丢弃候选 runtime 和候选 staged refs，旧 generation 不变。
- CAS 冲突：丢弃候选 runtime 和候选 staged refs，重新读取 durable active configuration。
- commit 成功、swap 尚未完成时进程退出：重启时 Supervisor 从最新 durable generation 重新构造并启动 provider；旧进程内 runtime 不再是权威。cleanup ledger 继续清理已替换 generation 的 exact refs。
- 冷启动先用 durable config 对账 staged refs：与当前 generation、track 和 exact ref 完全一致的记录晋升为 active；其余 staged 记录转入待清理。系统据此区分“配置已提交但账本尚未晋升”和“候选尚未提交便退出”，避免删除当前配置正在引用的凭据。
- swap 后 drain/cleanup 失败：新 generation 仍是 active；ledger 保留待办并在启动、下一次设置操作及受限后台 retry 中重试。清理失败不回滚已成功的家庭设置。

该规则的产品结果是“失败保留旧，成功才切新”。它避免为了严格性而让家庭在服务迁移期间失去可用语音。

## gateway 的运行状态与重试

Settings 和 voice surface 从 gateway 得到一个稳定的、provider-detail-free projection：

| 状态 | 含义 | 新语音 turn | 家庭可见操作 |
| --- | --- | --- | --- |
| `disabled` | 家庭主动关闭，或从未启用。 | 不开始采集；文字入口可用。 | 启用私有语音。 |
| `active` | 当前 ASR 与 TTS generation 已验证且可服务。 | 签发 lease。 | 重新配置或关闭。 |
| `degraded` | 已持久化的语音配置暂时不可用，或运行期调用以闭合错误失败。 | 不签发新的 lease；正在进行的 lease 依实际结果完成。 | 重试、重新配置、改用文字、关闭。 |
| `retrying` | gateway 正在以有界、可取消的方式重新检查当前 generation。 | 不签发新的 lease；文字入口保持可用。 | 继续等待、取消等待、重新配置、改用文字。 |
| `switching` | 已验证候选正提交或已提交后正切换；旧 generation 仍服务已有 lease。 | 切换前签发给旧 generation，切换后签发给新 generation；不产生混合 lease。 | 查看进度；取消仅取消尚未提交的候选。 |

`degraded` 表示私有语音暂时不可用，家庭产品与文字入口保持运行。Gateway 以固定超时和最多三次的有界退避恢复同一 durable config；每次 retry 要求 ASR 与 TTS 都 ready 后回到 `active`。家庭也可以主动重试，或用 `cancelRetry()` 结束当前恢复周期；下一次主动重试仍使用家庭已保存的服务。操作页面与 voice surface 始终给出文字出口。

## Settings 产品流程

入口放在 operational Inbox 的“设置 > 私有语音”，而不是首次设置页面。页面使用家庭语言，显示当前结果而非实现细节：

- **未启用：** “语音尚未开启。你可以继续使用文字，也可以连接家庭里的语音输入和语音输出服务。”主操作为“设置私有语音”。
- **已启用：** 显示“语音可用”和输入/输出的服务类型；提供“更换服务”“关闭语音”。“更换服务”在一次提交中检查输入与输出并保存，保持一个清楚的候选生命周期。
- **正在验证或切换：** 按轨道显示“正在检查语音输入/输出”；超过十秒给“继续在后台完成”“停止这次检查”和“改用文字”。停止未提交候选不会触及旧服务。
- **暂时不可用：** 显示“私有语音暂时不可用，文字对话仍可使用。”并提供“重试”“检查设置”“关闭语音”。对于具体失败，展示稳定分类的可操作说明，例如“服务无法连接”或“服务不兼容”，而非网络拓扑。
- **关闭确认：** 说明“关闭只会停用家庭语音入口，不会停止外部服务。”用户确认后开始 disable transaction；已经开始的本地语音轮次按 generation lease 完成或释放，文字对话继续可用。关闭完成后显示“语音已关闭，随时可以再次设置”。

表单继续分别收集 ASR 与 TTS 的 transport、地址、可选 model/voice、locale 与短生命周期凭据。每条服务必须先通过验证才可保存；已认证的本地 Settings 可在编辑框中回显 canonical endpoint 与非 secret 参数，密钥输入始终为空，并以“已保存凭据”提示是否需要重新输入。页面用 revision/expected generation 处理并发编辑：若家庭另一台已配对设备先保存，当前页面明确刷新，不覆盖已保存配置。

该页面保留 Apple-style 的直接性与连续反馈：常用动作位于当前状态旁，细节一层展开；切换与重试可中断，动画不锁定输入；在 reduced motion、reduced transparency 与 increased contrast 下提供等价状态变化。浏览器权限、无输入、采集、等待、失败、恢复和文字接管继续遵循现有 voice surface 状态机。

## Vault 与精确清理账本

运行期事务沿用 staged reference 原则，并将清理从“best effort 的设置请求尾部工作”提升为 Supervisor 持久化的精确 ledger：

- 每个候选凭据使用仅属于该 track、candidate id 和 nonce 的 staged ref；页面、日志、非 secret config 和 Inbox projection 永远不接触 secret value。
- durable config 只在 CAS 成功时引用该候选已有的 exact staged refs；这些 locator 从此成为该成功 generation 的 active refs。Vault 的现有读写接口无需复制、改名或“提升” secret。候选取消、probe 失败、启动失败和 CAS 冲突只登记并删除这一次候选产生的 exact refs；下一次候选始终创建不同 locator。
- 成功替换后，ledger 将旧 generation 的 ASR/TTS refs 标记为 `pending_cleanup`，并保留 generation、track、exact ref、原因、创建时间与尝试计数；它不按前缀扫描、不删除共享或不属于自己的 ref。
- 旧 provider 完成 drain 且不再持有 lease 后，Supervisor 删除 ledger 中对应的 exact refs 并 durably ack。若 Vault 暂不可用，ledger 留待后续 retry；active generation 的 refs 永不被 cleanup 任务删除。
- 关闭完成后遵循同一规则。没有凭据的 transport 仍记录 generation 的完成状态，但没有要删除的 ref。

locator 采用现有 `track + candidate id + nonce` 规则。candidate 在 CAS 成功后成为 active generation，替换时成为 draining generation，因此同一个 locator 在一条生命周期内保持稳定，不发生 secret 复制。每个新 candidate 使用新的 locator；配置、浏览器、审计事件和错误消息只接触非 secret 元数据。

## 迁移与兼容路径

已有 `product-config.json` 中的可选 `voice` 是第一批 active generation 的来源。启动时 Supervisor 为它建立 gateway active generation；配置缺少 `voice` 时建立 disabled gateway。两种情形都 mount 相同的 operational bundle，Inbox 总能获得 gateway 对象。

迁移保持现有家庭直接进入 operational 产品，文字入口立即可用。启动时，Supervisor 把当前 durable config 精确引用的 setup 语音 refs 幂等登记为该 generation 的 active 所有权；只接受 ref 自身携带的 track 与 candidate id，并拒绝同一 generation 的冲突引用。首次进入运行期语音设置时，系统以现有 config 生成只读摘要；家庭选择“重新配置”时才创建新的候选。Setup 草稿继续由自己的 staging/cleanup 账本收口，运行期账本只认领 durable config 精确引用的 active refs，两者不按前缀扫描或猜测所有权。

版本升级时，配置验证继续拒绝 secret-shaped 字段、未知字段、任意 headers 和不受支持的 endpoint。旧配置能够启动而服务暂时不可达时，gateway 进入 `degraded`，文字产品继续；它不把服务离线解释为配置无效或强制关闭。

## 明确不做

本决策保持 Phase 0 的边界，以下内容不属于本次实施：

- 不重新 mount HomeAgent、DSH Agent loop、Inbox operational bundle、Hub 或 bridge 来更新语音；全程只有一个 DSH Agent loop。
- 不增加自定义 automation runtime、微服务、向量数据库、Postgres/Redis、第二套语音 agent 或新的 skill format。
- 不接管 Home Assistant Assist pipeline，不把 Home Assistant 变成语音运行时，也不让 ASR/TTS 调用 HA service/entity。
- 不引入常驻唤醒、连续录音、声纹身份、跨房间播报、动态工具授权或语音对设备动作的额外授权。
- 不以浏览器 Web Speech、云端回退或未验证 provider 静默替代家庭选择的私有服务。
- 本地 `product-config.json` 持久化运行时重启所需的 canonical endpoint 元数据；已认证的本地 Settings 允许查看和编辑该地址。语音页、对话、DSH、Hub、审计与日志只接触服务类型和闭合状态，不展示 endpoint、原始 provider payload、Vault locator 或 secret。本文不规定任何私有硬件或集群拓扑。

## 验收门槛

先写确定性测试，再落生产代码。CI 只使用 fake Vault、fake transports、fake clock、fake configuration store 和 synthetic DSH/Hub ports，不连接家庭设备、局域服务或真实凭据。

- **稳定 identity 与唯一 Agent：** 断言 operational Inbox 在 enable/reconfigure/disable/retry 后保有同一个 gateway 对象；断言不调用 `mountOperational`、不重新 mount HomeAgent/DSH，且 voice final 只进入现有的单一 DSH loop。
- **lease 隔离：** 覆盖 Wyoming 与 HTTP captureMode；切换过程中旧 lease 的 ASR/TTS 都由旧 provider 执行，新 lease 都由新 provider 执行；不存在混合 generation 或中途改编码。
- **事务结果：** 覆盖首次启用、重配、主动关闭、candidate probe 失败、candidate start 失败、CAS 冲突、commit 后崩溃再启动、swap 后 drain。断言任何候选失败保持旧 active generation；成功后才向新 lease 切换。
- **drain 与动作恢复：** 验证旧 provider 拒绝新 lease、已有语音 turn 完成或按既有取消语义结束；Hub 已认领的执行/核验不会因切换或关闭被撤销，结果仍可在文字界面读取。
- **状态与体验：** 覆盖 disabled、active、degraded、retrying、switching，以及 retry 成功/取消/超时；真实浏览器覆盖设置、权限拒绝、无输入、采集、等待、失败、重连、关闭、完成和文字接管，并验证键盘、屏幕阅读器和各项偏好辅助功能。
- **Vault ledger：** 覆盖 staged 成功/失败/取消、CAS 冲突、active->reconfigure、active->disabled、drain 未完成、删除失败重试和重启恢复；断言只删除 ledger 所列、属于已停止 generation 的 exact refs，永不删除 active/shared/未知 refs。
- **权限与数据边界：** 断言 Settings/gateway/DSH/Hub/HA 不新增跨层能力；日志、审计、HTML 和配置均不含 credential、Vault ref、raw audio、完整 transcript 或 provider body。

## 已采纳的关键决定

1. 同意将 `ProductRuntimeSupervisor` 定为稳定 gateway、运行期 voice generation 和 cleanup ledger 的唯一 owner，而不是将这些职责放入 Inbox、setup controller 或 provider runtime。
2. 同意“每轮 lease 钉住 captureMode + provider generation”作为迁移期间不中断家庭体验的核心不变量，以及 drain 的最大时长和超时后对本地等待的产品文案。
3. 同意 candidate 双轨 ready、generation CAS、同步 swap、旧 generation drain 的提交顺序；特别是 commit 后进程退出以 durable config 为权威、重启恢复的规则。
4. 同意关闭语音采用 drain，而不是强制中止已开始的语音轮；并同意 Hub 已认领工作独立于语音 provider 生命周期。
5. 同意 Vault ledger 的精确所有权模型与旧 cleanup 记录的迁移策略，包括“无法证明所有权就不自动删除”。
6. 确认 Settings 中可展示的安全摘要和故障分类，及哪些细节只进入本地工程诊断而不进入产品界面。

实施顺序从 Supervisor-owned gateway 的窄接口、配置/ledger 事务和失败测试开始，再接入 operational Settings 与浏览器验收。每个阶段都保持文字产品、单一 DSH loop 与既有 Hub 治理边界完整可用。

# Changelog · dsh-plugin-agent-bus

> dsh 首个原生插件（mac-mini 中枢开发）｜ 语义化版本（SemVer）
> 格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)

## [1.5.18] - 2026-10-04

> 主题：**quick-restart 守护升级为读回验证 + 有界重试（MBP 事故 #6 / R043）**。

- 单发 open 不验证 ⇒ 新实例被陈旧单实例锁静默自杀 1.4s（exit 0、boot marker/exit-trace 三处零痕迹）
  而守护零信号。守护脚本改为：open → 读回（exit-marker pid/startedAt 更新 + 进程存活）→
  5 轮重试 → 无进程时清陈旧 Singleton{Lock,Socket,Cookie} 再试 → 全程写 agentway-relaunch.log。

## [1.5.17] - 2026-10-04

> 主题：**quick-restart countdown 语义澄清（MBP 4821 误读归因订正）**。

- countdown = **停机时长**（守护在 countdown+2s 拉起），非广播倒计时；广播文案与返回
  instruction 均写明，并如实标注「守护有效性尚未实证」。

## [1.5.16] - 2026-10-04

> 主题：**行为层投递探针并入 CLI 冒烟（MBP sandbox-agent-way 判据采纳，P11 判据与故障同层）**。

- **真 apply + 真 agentBus.send 断言 delivered**：冒烟子进程从「noop 全代理」升级为带
  fake agents/agentDefaultModel/settings/sessionPersistence/agentPresets 的富 stub，
  send(跨机会话 from → 本机活目标) ⇒ 断言 status=delivered 且 followup 被调用。
- **负控实测**：对 1.5.13 源码（c449ccd）同探针 ⇒ status=queued followup=false（P0 必被抓）；
  对 1.5.16 ⇒ delivered ✓。判据与故障同层：静态 reexport 判据之外的行为层第二道。
- 探针 id 用合法 UUID（非法形态会被决策表归一化成 unattributed——探针第一版自己的 bug）。

## [1.5.15] - 2026-10-04

> 主题：**reply-hint 任意标签死前缀修复（MBP 六形态实测：1.5.12 只堵 session-* 形态）**。

- **白名单方案**：`peerNodeHint` 只对真实黑板监听节点（mac-mini/macmini/mbp/mbp-bus/i9）
  拼 `notes/<node>/`；`bus:` 别名同样过白名单；`ui`/任意未登记标签 → 通用指引
  （1.5.14 旧逻辑把任何短标签当节点 ⇒ `notes/ui/` 死前缀 ⇒ 对端照回即静默丢失，G13 家族）。
- **selfcheck reply-hint 判据扩六形态**：session-id/bus:mac-mini/mbp/ui/unknown-thing/bus:ui
  全部断言（「修了一个形态」≠「修了这一类」——判据必须覆盖同类其它形态）。
- 负控实测：1.5.14 旧逻辑 ui→"ui"、unknown-thing→"unknown-thing"（死前缀）；1.5.15 均 → null。

## [1.5.14] - 2026-10-04

> 主题：**P0 投递全挂 16h 根因修复（MBP 决定性证据：export{}from 再导出无本地绑定）**。

- **① 真 import replyCardHint**：182 行 `export {peerNodeHint, replyCardHint} from` 是再导出、不建本地绑定 ⇒
  deliver() 三处 replyCardHint(...) 抛 ReferenceError ⇒ 被静默 catch 吞 ⇒ 跨机投递全挂
  （我侧 405 条 queued 同病；MBP 侧 12.5h 投递中断，加一行 import 即恢复 1067/1067 delivered）。
  补 `import { peerNodeHint, replyCardHint } from './reply-hint.js';`（与再导出共存）。
- **② 三处兄弟静默 catch 出声**（MBP 验收残留）：deliverViaBlackboard / notifyAgent / deliverWake
  的 catch{return false} 全部加 lastError + logLight('deliverFail')。
- **③ selfcheck 新增 reexport-silentcatch 判据**：再导出名被本地调用而无 import 绑定 ⇒ FAIL；
  catch{return false} 无 lastError ⇒ FAIL。负控实测：对 1.5.13 源码判据命中 4 处（1 再导出+3 静默 catch），
  1.5.14 源码 0 命中。

## [1.5.13] - 2026-10-04

> 主题：**queued 终态化修复（MBP 对等自查决定性根因：queued 真达率 15% vs delivered 100%）**。
> 触发：MBP 卡 1791080859/1791080974 —— `targetLive:true` 却 `status:queued` 的自相矛盾组合，
> 代码级定位两处静默失败：`deliver()` 吞异常 + `autoWake()` 反风暴空实现后**没有任何**
> 「目标变 idle 时 deliver」的触发点 ⇒ queued 事实上是终态，除非再有人发新消息顺带 flush。

- **① 失败出声（必须第一）**：`deliver()` catch 落 `msg.lastError`（≤120 字符）+
  `logLight('deliverFail', to, from, lastError)`。此前 followup 抛错（会话忙/运行时拒绝）
  静默降级 queued、零信号——类别 B 教科书形态。
- **② idle 主动 flush**：`ctx.on('agent/status')` 处理器内，目标回 idle 即 `flushQueue()`。
  投递只在 idle 窗口能成功的物理事实由此转正：排队最迟下一回合送达。
- **③ 程序化 flush 暴露**：`agentBus` 服务新增 `flush()`，看护脚本无需 HTTP 端点即可清队列。
- **selfcheck 新增 delivery-guard 判据**：源码断言三处落点（失败出声 / idle flush / flush 暴露），
  防回退；CLI selfcheck 输出 `delivery-guard: PASS`。

## [1.5.12] - 2026-10-04

> 主题：**回复卡键提示死前缀修复（MBP 实测 3 处 502/511/518 指引写死前缀无人监听）**。

- `replyCardHint` 抽纯模块 `lib/reply-hint.js`：session-id → 通用指引、bus:别名 → 节点名。
- 门建议文案前缀修正 `notes/session-xxxx/` → `notes/<本机节点>/xxx`。
- selfcheck 新增 reply-hint 判据（session-id→null / bus:alias→node，无死前缀）。

## [1.5.11] - 2026-10-03

> 主题：**方案 A 唤醒语义补实现（A-1/A-2）+ 冒烟独立化 + fs 导入修复**。
> 触发：重启前验收脚本机械源码断言抓出「A-2 常量声明但从未使用、A-1 仍是旧 I7
> 看黑板前缀判定」——总结里的『方案 A 全套落盘』对 A-1/A-2 是不实陈述，照规格补实现。

- **A-1 唤醒反转（补实现）**：`deliver()` 定向消息默认 followup（唤醒）；
  `inject`（不唤醒）仅限 `msg.notifyOnly===true` 或发端限速降级 `msg.rateLimited===true`。
  旧 I7「看黑板」内容前缀判定废止——唤醒开关归位信封语义，内容不再决定唤醒；
  notify_only 与 reply_required 并存时 notify_only 优先（显式 opt-out）。
- **A-2 发端限速（补实现）**：`sendMessage` 同 from→to 对 10 分钟窗口（RATE_WINDOW_MS）
  已有 ≥RATE_N=10 条 ⇒ 本条起 `msg.rateLimited=true`（deliver 侧降级 inject），
  返回体 `rate_limited:true`。去重与自回声守卫不变。
- **agent_send 新增 `notify_only` 参数**：true=纯通知不唤醒（方案 A-1 显式 opt-out）。
- **fs 导入修复**：`deliverViaBlackboard` 裸用 existsSync/readFileSync 未导入
  （central-inbox os 事故同族）→ 已补 `import { existsSync, readFileSync } from 'node:fs'`。
- **冒烟独立化**：selfcheck 新增 `runApplySmoke`（子进程隔离 HOME + 断网面 + 防重入守卫），
  绝不在 apply 调用链内执行（central-inbox 0.2.9 冒烟递归链 livelock 事故教训）；
  符号扫描改正则（多符号/default/namespace import 三形态）+ index.js 传 sourceFile 扫 11 符号。
- **门禁文案对齐 A-3**：阈值 50→200 字文案全部更新。
- **验证**：正控 selfcheck 全绿 exit 0（含冒烟 pass 仅 1 次）；负控删 fs 导入 → FAIL exit 1
  精确报 symbol:existsSync/readFileSync；重启后跑 post-restart-acceptance.py（A-2 判据：
  同对连发 12 条 ⇒ 第 11/12 条 rate_limited:true）。
- **部署纪律**：不单独重启——随下次自然重启生效（2026-10-04 04:00 维护窗口）。

## [1.5.9] - 2026-10-03

> 主题：**身份归一化系统性收口 —— 单一决策表**。触发：通讯逻辑同类缺陷多次复发
> （normalizeTo fallback 语义两度误判；1.5.8 把 bus:* 合法别名匿名成 unattributed，
> 用户实测 3h 内 25 条消息 8 条匿名不可读）。

- **决策表单点化**：A4d（from）/ A4（to）/ A6（自回声）/ I1 迁移 / resolveDisplayName /
  广播收件人**全部**收敛到 `normalizeIdentity(raw)`（dsh-comm-shared 1.0.2），
  删除本文件的 normalizeTo+variantsToIds 两段式用法（其 fallback「非空≠有 id」曾两次引发判据 bug）。
- **决策表 8 路径**：完整 id → 短 id → 裸 UUID（补全前缀，不再截成 8 位）→ 含 id 展示名 →
  bus:<设备> 别名（保留原文）→ 设备别名白名单（保留原文）→ 变体表 → 纯角色标签
  `unattributed(<标签>)`（匿名但可读；1.5.8 的裸 `unattributed` 观感像故障）。
- **裸 UUID 收件人修复**：旧管线把裸 UUID 截成 8 位短 id ⇒ 无法解析 ⇒ 永久 queued；
  现补全为完整 id（语料实测 55+ 个 distinct to 值受益）。
- **裸标签收件人修复**：变体表命中的收件人（星桥/明鉴/i9-hr/驿使…）直接解析到规范 id
  ⇒ 不再 queued 滞留（原 normalizeTo 只字面保留）。
- **自回声 v3**：身份键 = 规范 id 优先，无 id 形态用 display 兜底（mbp→mbp、同标签互发仍拦；
  未知标签匿名形态互不相等 ⇒ 放行）。
- **验证**：comm-shared selftest 69/69；selfcheck CLI 新增 identity-table 12 例断言 PASS；
  agent-bus.json 真实语料差分（161 from / 225 to）全部 118 处差异落入预期修复类别，零意外回归。
- **部署纪律**：不单独重启——随下次自然重启生效；重启后跑 post-restart-acceptance.py
  （已加「身份决策表」第 8 项）。

## [1.5.8] - 2026-10-02

> 主题：**标签处置（bus:* 别名被误伤）**。触发：A4d 无 id 标签一律置 `unattributed`，
> 误伤合法的 bus:<设备> 寻址形态与设备别名（bus:mbp/bus:i9/mbp/mac-mini…），
> 用户实测跨设备消息大面积匿名不可读。1.5.9 用决策表系统性修复本版缺陷。

- A4d 无 id 标签 → `unattributed`（匿名）；A6 以 normalizeTo 结果是否 session 形态判定。
- **已知缺陷（1.5.9 修复）**：bus:* 与设备别名属合法设备形态却被匿名；
  裸 UUID 收件人被截成 8 位短 id 无法投递。

## [1.5.7] - 2026-10-02

> 主题：**A6 第 4 层（裸标签）+ I7a（reply_required 唤醒）**。触发：与 MBP 跨设备通讯实测。

- **A6 第 4 层**：from 为裸标签（如「星桥」）时，normalizeTo 会 fallback 保留原文（非空），
  原 v2 判定「from ∩ to 交集含自己」拦不住 ⇒ 五形态探针实测 1/5 漏（裸标签注入回自己）。
  修复：`variantsToIds(from)` 无条件补充身份变体表（identity-variants.json，20 身份/37 变体/0 分裂）。
  约束（与 MBP 共同结论）：未知标签放行+日志告警（漏收代价 > 自回声代价）；绝不用裸节点名子串匹配。
  验证：等价模拟（含 resolveShortId）8/8 全过；生产五形态探针待重启后复测。
- **I7a reply_required 唤醒**：`agent_send` 新增 `reply_required` 参数；deliver 时
  「看黑板」指针若 replyRequired=true 则走 followup（唤醒）而非 inject（不唤醒）。
  背景：跨设备「要求回复」的信封在收件方空闲时排队等自然回合（实测 47-249s），
  与 MBP 约定 reply_required=true 触发唤醒；MBP 06:52 实测判据卡已备。
- **依赖**：dsh-comm-shared 1.0.1（variantsToIds）；central-inbox 0.2.2 同步透传 replyRequired。

## [1.5.4] - 2026-10-01

> 主题：**收件人解析与自回声判定的根因修复**。触发背景 = 用户手动清理约 190 条上下文注入，
> 追问「架构是否有缺陷」。本条为其中 bus 站（A 通道）的部分；黑板注入器见 central-inbox。

### 修复
- **A4 / A4b / A4c · `to` 解析三处缺口**（`queued` 永久滞留的根因）
  - A4（沿用 2026-10-01 早先修复）：`to` 先 `normalizeTo` 再解析，修复「显示名后缀/列表直查失败」。
    落盘实证：探针消息 `to="session-…-… (后缀探针A4)"` 入库为**无后缀规范 id**。
  - **A4b（新）**：归一化后仍可能是 **8 位短 id**（`明鉴 (a190c54c)` → `session-a190c54c`），
    而 `agentsSvc.get()` 需完整 UUID ⇒ 归一化了却照样 queued。改为按**活跃会话**做唯一前缀解析。
    **歧义一律 fail-closed 返回 null**（会话 id 是时间序 UUID，8 位高位前缀**会跨会话碰撞**：
    实测 `e7bfeea8` / `0e84e65c` / `f38244df` 各对应 2 个不同真实会话）——猜一个 = 投递错人。
    规模：queued 中纯短 id 形态 16 种 / 103 条。
  - **A4c（新）**：`broadcast` 的收件人此前**原样入库**，与 sendMessage 同根因。
    实测 4,509 条广播 **0 条** 受害者（调用方恰好都传了规范 id）⇒ 属**未激活的同类缺陷**，一并修掉。
    同时把「排除自己」从字面比较改为**规范 id 比较**（原先传自身短形态会漏过 ⇒ 广播给自己）。
  - **A4d（新）**：`from` 也做归一化 —— **`to` 那个缺陷在 `from` 上的镜像**。
    实测（INVARIANTS.md §I1 行为审计）bus 中 **1785 条** 的 `from` 是展示标签而非身份，近 7 天新增 **106** 条，
    其中 94 条形如 `老登 session-aa528267 (mac-mini)` / `明鉴 session-a190c54c-…（mac-mini）`，
    另有 8 条是**缺 `session-` 前缀的裸 UUID**。这些**不是本插件工具路径发的**（工具路径 `from` 恒为 `exec.agent.id`），
    而是**跨设备桥经 `agentBus.send(from, …)` 转发**时把"地址串"当成了发件人；
    危害是**所有按身份判定的下游（自回声 / 去重键 / @提及排除 / 显示名）全部失真**，且标签可被任意伪造。
    修法：与 `to` 完全同构（`normalizeTo` → 短 id 唯一前缀解析，歧义 fail-closed），
    并对**裸 UUID 先补 `session-` 前缀**（否则会被截成 8 位短 id，白白丢掉可完整恢复的信息）。
    **实证**：真实 11 种违规 `from` 中 **9 种被救回**；残留 2 种（`i9-hr`/`mbp-ops`）是**角色标签、无 id 可抽**，须由跨设备发送侧改约定。
- **A6 v2 · 自回声判定语义颠倒（v1 是一颗哑火地雷）**
  - v1 判的是 `from`（`isSelfEcho(from, _SELF)`），而发送时 `from` 恒等于调用者自己
    （`sendMessage(exec.agent.id, …)`）⇒ 语义颠倒；**一旦 `ownSession` 被填上**（v1 注释写的意图）
    就会拦掉本机发出的**每一条**消息。v1 之所以没出事，只因 `_SELF.ownSession` 恒为 `''`、
    `DSH_NODE_ID` 在环境中也不存在（实测 `_SELF = {nodeId:"", ownSession:""}` 恒定）。
  - 改为 `normalizeTo(from) ∩ normalizeTo(to) ≠ ∅`：**比较完整规范 id 精确相等**，不按 8 位前缀近似
    （前缀碰撞会误拦真实消息）。
  - 实测样本：**33 条** `session-fa1f9150 → session-fa1f9150` 的【迭代报告】/【交付修正】
    全部 `delivered` ⇒ 千字级报告被注入回**发件人自己的上下文**（自我注入污染）。
  - `isSelfEcho` 保留给**接收侧**（central-inbox 用它判「绕回自己的消息」，15 条断言含 4 条自回声用例）。

### 变更（文档与语义对齐）
- 去重键文案三处更新：键已改为「同发件人·同收件人·同内容（**不含 thread**）」，但**淘汰策略仍是
  10 分钟窗口**，且**未改**——同内容重发间隔 >10 分钟仍会漏判（即最初观察到的「相隔 10 分 16 秒」
  场景换键后**并未因此被拦住**）。键与淘汰是两件事；是否统一到成员集合语义属**产品决策**，未擅动。
- `selfcheck.js`：**ESM 死码修复**。原 ①(`typeof require`) 与 ②(`typeof __filename`) 两个守卫
  在 ESM 下**恒为 undefined** ⇒ peerDeps 探测与关键符号检查**双双被跳过**，只跑 ③ type:module，
  却打印 `✅ 自查通过`。负例控制实证：传入绝不可能存在的符号，`missing` 仍为 `[]`。
  改用 `createRequire(import.meta.url)` / `fileURLToPath(import.meta.url)`；新增 `resolved` 字段
  记录 peer 解析路径（可暴露「插件 node_modules 遮蔽 runtime」= M1 根因）。新增 **CLI 入口**
  （原先 `node lib/selfcheck.js` **静默退出 0**、零输出，外观与「通过」无异）。

### 迁移与兼容
- 对 `to` 的归一化改动经**真实语料差分**验证：agent-bus.json 全量 **221** 个不同 `to` 值，
  改前/改后 **218 个输出完全一致**；仅 3 个变化且**全部为本次修复目标**（`明鉴` → `session-a190c54c` 提到首位）。
- 已知良性副作用（已固化断言）：括号内孤立 8 位数字（如 `(20261001)`）会被当短 id ⇒
  产出**解析不到的**短 id ⇒ 仍留队列，**不会误投**（fail-safe）。
- 回滚点：`~/dsh-collab/guard/backups/…identity.js.bak-good-2026-10-01-16-1`、
  `…agent-bus__lib__index.js.bak-good-2026-10-01-16-1`、`…selfcheck.js.bak-good-2026-10-01-16-1`。

### 验证
- `dsh-comm-shared/selftest.js` **44 PASS / 0 FAIL**（本模块此前**零断言**）。
- `plugin-preflight.py --plugin dsh-plugin-agent-bus` → **GO**（A 组合完整性 / B 真挂载冒烟 pass / C 遮蔽 0）。
- 行为验收（需重启后复验）：带后缀 `to` 不入 queued、`from=to=自己` 返回 `status:'self-echo'`。

## [1.5.5] - 2026-10-02

> 主题：**官方机制接入**（I3/I4/I5/I7）。依据 `~/dsh-comm-shared/INVARIANTS.md` §2ter 的实测规格
> （S1–S8：第三方插件可订阅官方 inbox 事件、事件原样带回我们传入的 message id）。

### 新增
- **I3/I4 · 官方 inbox 回执订阅**：`apply()` 内 `ctx.on('agent/inbox/inserted'/'claimed')`，
  按 **message id 精确关联**（S2/S3：只认 inflight 里**我们发过的 id**，绝不把"用户自己打字"误判为回执）。
  消息新增字段：`acked: sent→received→claimed`、`ackedAt`、`claimedTurn`（`serialize` 无白名单，自动落盘）。
  这也让审计器 I3/I4 从 GAP 变为可验证（`delivered`=投递尝试，`acked`=官方事件观测）。
- **I5 · 载体原子写**：`writeNow()` 改用官方 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`（tmp+rename，0o600），
  替代 `writeFile` —— 读方只见旧内容或完整的新内容。依赖以符号链接解析（与 cordis/dsh-tools 同模式）。
- **I7 · 通知不唤醒**：`deliver()` 对指针式通知（正文以「看黑板」开头）改用官方 **`agent.inject()`**
  （追加到 next-step inbox **不唤醒**），其余仍 `followup`。实测 17.0% 的已投递消息属此类。

### 验证
- `plugin-preflight.py --plugin dsh-plugin-agent-bus` → **GO**（B 真挂载冒烟含新 `ctx.on` 与原子写导入）。
- 行为验收（**待重启后**）：① 发一条「看黑板 …」给在线会话 → 事件应含 `wake:'inject'` 且目标不被唤醒；
  ② 发消息给在线会话 → 数秒内 `acked: received → claimed`；③ `agent-bus.json` 写入期间读取应始终完整。

## [1.5.6] - 2026-10-02

> 主题：**清淤（A2 过期+DLQ、I1 存量迁移）与 I4 区间右端**。与 1.5.5 同属一个重启窗口。

### 新增
- **A2 · queued 过期 → expired（DLQ 语义）**：`flushQueue` 内对 `queued` 超 **7 天**（`QUEUE_TTL_MS`）的消息
  标记 `status:'expired'` + `expiredAt`，**不删除**（DLQ 可枚举可回放）；并在 `load()` 后**启动即清扫一次**（验收确定性，不必等第一条消息触发）。
  **预期影响**（实测现网数据推算）：queued 2073 条中 **1771 条（85%）将入 expired**，剩余 302 条正常排队。
  这是首个能让 queued 数下降的动作（A4 只拦新增、不回收历史）。
- **I1 存量迁移**：`load()` 完成后对历史消息的 `from` 做**幂等**归一化（含裸 UUID 补 `session-` 前缀，
  与 A4d 同规则）。**预期修复约 1284 条**；残留为 `bus:*`/`node:角色` 等**跨设备角色标签**（无 id 可抽，
  须发送侧改用身份——见 INVARIANTS R2）。
- **I4 区间右端**：新增 `ctx.on('agent/status')` —— 目标 agent 回到 `idle` 时，为 inflight 中该 agent
  所有 `acked:'claimed'` 的消息写 `idleAt`（运行区间闭合）。左端 `ackedAt`（回执）、右端 `idleAt`（空闲）。

### 验证
- 预检 **GO**（B 真挂载冒烟）；`QUEUE_TTL_MS`/`expired`/`idleAt`/`migChanged` 均已在位。
- 行为验收（**待重启**）：重启后 queued 应骤降（预期 ≈302）；`agent-bus.json` 中 85% 原 queued 变 `expired`；
  历史 `from` 中展示名+id 形态应被归一化。

## [1.3.1] - 2026-08-29

### 修复
- 注入消息显示智能体自命名（R009，替代 session-id）

## [1.0.0] - 2026-08-27

### 里程碑
🎉 **dsh 第一个原生插件正式定版**——跨设备注入链路验证通过（mac↔MBP 零轮询多轮验证 v1 通过，3 轮纯注入）。

### Added（本次定版新增）
- `package.json` 完整元数据：license（MIT）/ author / keywords / repository / files
- `CHANGELOG.md`（本文件）
- git 仓库初始化（版本管理基础）
- `.gitignore`（排除状态文件/备份/node_modules）

### 核心能力（1.0.0 全量）
- **消息总线**：`agent_send` / `agent_broadcast` / `agent_thread`（消息经 `agentsSvc.get(to).followup()` 注入目标会话上下文——「注入」本质）
- **红绿灯互斥锁**：`agent_light` / `agent_lock` / `agent_unlock` / `agent_unlock_all`（exclusive/shared/排队/续租/转交）
- **能力登记**：`agent_profile` / `agent_profiles`（谁会什么/资源归谁）
- **治理**：v2.3 最短提示门禁（工具层注入 `_gate.warn`）、10 分钟去重、审批（`agent_approval_*`）、受控重启（`agent_restart_*`）
- **持久化**：`~/.dsh/agent-bus.json`（线程/锁/档案/审批，防抖写盘，跨重启保留）
- **agentBus 服务**：`ctx.provide('agentBus', {list, send, broadcast, threads, light, lock, unlock, snapshot})`——供 central-inbox 等插件复用
- **侧边栏面板**：dashboard.html + webServer API（`/agent-bus/api/*`）
- **系统提示词纪律注入**：REPORT_PROMPT（迭代完成报告登记）+ 红绿灯前置

### 演进历史（内部迭代 → 正式版）
内部多版迭代（备份文件为证），关键节点：
- **防风暴版**（index.js.bak-antistorm-051743）：消息风暴防护（去重/限流）
- **v2.3 最短提示门禁版**（index.js.bak-agentsend-v23）：`>200字且无黑板引用` → `_gate.warn`（agent_send 是唤醒通道不是汇报通道）
- **SSE 修复**（2026-08-27，MBP 定位）：central-inbox 的 `AbortSignal.timeout(0)` 是 0ms 立即 abort → 改 `fetch(SSE_URL)` 无限流

### 跨设备扩展（1.0.0 关联）
- **central-inbox**（注入桥）：SSE 监听 8803 → `agentBus.send` → 注入本机会话
- **dsh-tools agent-msg/agent-thread**：跨设备消息（写黑板 notes/<node>/）
- **零轮询验证**：mac↔MBP 双向注入 3 轮 ping-pong 通过（无轮询补查）

## [0.1.0] - 2026-08-17

### Added（初版）
- 跨会话消息总线骨架：agent_peers / agent_send / agent_broadcast / agent_thread
- 线程持久化（~/.dsh/agent-bus.json）
- 侧边栏面板（dashboard.html）

---

## 版本管理约定

- **版本号**：语义化（major.minor.patch）
  - major：破坏性变更 / 里程碑
  - minor：新增能力
  - patch：修复
- **发布流程**：改源码 → bump 版本 → 更新 CHANGELOG → git commit + tag → genebank 交付 → 台账登记 → 黑板通知
- **git tag**：`v1.0.0` 格式（本版本开始）
- **台账**：tools-registry.md 登记（插件版本/状态/三端部署）

## [1.1.0] - 2026-08-27

### Changed（更名）
- **包名 `dsh-plugin-agent-bus` → `dsh-agent-way`**（npm 同名包冲突：MistyBridge 已发布 dsh-agent-bus）
- 品牌意象：跨智能体「高速公路」（agent highway）——常驻、高速、承载所有智能体流量
- 跨设备通讯桥品牌：**HubBridge**（central-inbox + node-bridge + 黑板协议的对外统称）
- cordis.patch.yml 的 id 保持 `agent-bus` 稳定（避免重启加载断裂），name 改为 `dsh-agent-way`

### 不变
- 全部能力（19 工具 / agentBus 服务 / 红绿灯 / 档案 / v2.3 门禁 / 面板 / 跨设备注入）
- 持久化文件 ~/.dsh/agent-bus.json（保持兼容）

## [1.1.1] - 2026-08-27

### Changed（命名统一）
- **`dsh-agent-way` → `dsh-plugin-agent-way`**：与我们 profile 内 17 个 `dsh-plugin-*` 插件命名统一（dsh-agent-way 是唯一例外，不一致）
- 官方内核包用 `dsh-tool-*`/`dsh-<类别>-<名>`（无 plugin）；社区插件主流 `dsh-plugin-*`——我们采用社区约定
- cordis.patch.yml id 保持 `agent-bus` 稳定；持久化文件不变

## [1.2.0] - 2026-08-27

### Added（主动自适应）
- **lib/adapt.js 版本自适应层**：宿主 dsh rc 升级主动检测 + 自动适配
  - 指纹采集：启动读宿主 6 关键包版本（dsh/dsh-tools/dsh-agent/dsh-session/dsh-llm/cordis）→ 串联 hash
  - 基线存储：~/.dsh/plugin-adapt/dsh-plugin-agent-way.json
  - 定期检测（timer 6h）：重读指纹 → 变化 = 宿主 rc 升级 → 告警黑板 + 记录 adapt-log.jsonl
  - 能力探测（probeCapabilities）：agents/followup/webServer/timer 存在性——比版本号更可靠的自适应依据
  - 宿主锚点探测：DSH_RUNTIME_NODE_MODULES 环境变量 / CLD 常见路径（mac/win/linux）直读
- 实测：rc.6 基线采集 0 缺失；模拟 rc.6→rc.8 正确触发告警

## [1.3.0] - 2026-08-27

### Changed（独立可安装关键）
- **peerDependencies 补全到 11 个**（修复可靠性审计 #1）：
  - 原 3 个（cordis/dsh-tools/dsh-client-runtime）→ 补 8 个
  - 新增：dsh-agent / dsh-session-persistence / dsh-settings / dsh-system-prompt / dsh-host-webserver / dsh-agent-default-model / dsh-agent-presets / dsh-client-locale
  - 全部语义化 ^0.1.0-rc.6（覆盖宿主 rc.8/rc.2）
- 目的：pnpm 依赖解析完整 → MBP/i9 可用 dsh plugin add 官方安装（FlowerNet 蓝图 M1）

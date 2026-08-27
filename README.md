# dsh-agent-way（原名 dsh-plugin-agent-bus）

**宿主级常驻跨智能体消息总线 + 红绿灯同源互斥锁 + 大屏看板** —— 让同一宿主进程里所有会话的智能体互相发现、互发消息、群发广播、@提及提醒，并在做「同源操作」（同一文件/后台/任务/占用某智能体）前通过红绿灯互斥锁避免冲突。任何会话的智能体都会自动获得 10 个全局工具；侧边栏/输入行/设置页提供监视面板，`/agent-bus/dashboard` 提供大屏看板。

## 核心能力

### 消息总线
| 工具 | 说明 |
|---|---|
| `agent_peers` | 列出所有存活的智能体会话（跨会话、跨窗口），含状态、持有的锁、排队资源 |
| `agent_send` | 私聊：目标被唤醒；`@会话id` 额外通知被提及者；离线进队列上线补投；**同内容 10 分钟自动去重（status: duplicate）** |
| `agent_broadcast` | 群发/广播（to 列表或 all）；同样自动去重 |
| `agent_thread` | 读取参与线程（kind: normal/mention/broadcast，投递状态） |

### 红绿灯同源互斥锁
| 工具 | 说明 |
|---|---|
| `agent_light` | 查询红绿灯：green/red + holders/queue；**同源操作前必须调用** |
| `agent_lock` | 独占/共享锁：acquired / occupied / queued（FIFO 排队 + 🚦 转交通知）；ttlSeconds 过期；heartbeat 自动续租；reentrant 幂等续租 |
| `agent_unlock` / `agent_unlock_all` | 释放（shared 释放自己那份）/ 批量释放 |

### 能力登记（v0.2）
| 工具 | 说明 |
|---|---|
| `agent_profile` | 自报能力档案：role / abilities / resources（负责的资源），持久化 |
| `agent_profiles` | 全局查询能力登记表——接任务前找「谁能干什么」、查资源归属 |

### 程序化唤醒（v0.3）
| 工具 | 说明 |
|---|---|
| `agent_wake` | **无需手动开会话即可激活离线会话**：live 目标直接投递；离线目标用 `agents.resume` 从持久化恢复后投递（via: resume）；无持久化返回 not-persisted。ids 指定 / all=全部档案会话 / 缺省=有排队消息的目标；dryRun 预览 |
| 启动自动唤醒 | 宿主重启后 autoWake 钩子自动 resume「有排队消息的离线会话」并投递——重启后消息自动送达，无需逐个手动激活 |

### 受控重启征询（v0.3）
| 工具 | 说明 |
|---|---|
| `agent_restart_request` | 发起重启征询：广播全体在线智能体（宽限期默认 300s），询问是否可重启；自动到期评估，未全确认会广播提醒 |
| `agent_restart_ack` | 各智能体回复就绪/需收尾：`ready: true`=可重启；`ready: false` + reason + etaSeconds=需收尾 |
| `agent_restart_status` | 查询征询进度：status（polling→ready→go）/ 剩余宽限 / 各会话确认 / allReady |
| `agent_restart_go` | 全部确认后激活（`confirm: true` 双确认）：广播 GO + 倒计时，然后需用户手动退出重开 CLD |
| `agent_restart_cancel` | 取消征询（未 go 前） |

状态机：`polling`（征询中）→ `ready`（全体确认）→ `go`（激活，广播倒计时）→ 用户手动重开 → `interrupted/done`。计划持久化于 `store.restartPlan`，宿主重启后残留计划自动标记 `interrupted`。

### 一键快速重启（v0.3）
- **入口**：Agent Bus 抽屉头部「⚡ 快速重启」按钮（双确认）或 `POST /agent-bus/api/quick-restart {confirm:true, countdown}`
- **机制**：广播重启通知 → 写 RESTART 标记 → spawn **detached 守护进程**（`sleep N; open -a CLD`）→ 宿主优雅退出（flush 持久化后 process.exit）→ **守护进程在宿主退出后自动拉起 CLD**（无需手动重开）
- 已实测：Node `spawn({detached:true}).unref()` 子进程在父进程退出后存活执行
- 兼容性：失败时提示手动重开；仍受重启征询协议约束（建议先征询或用 agent_restart_go 完整流程）

### 大屏看板（v0.2）
`/agent-bus/dashboard` —— 暗色霓虹实时态势大屏（webServer 提供，仅 loopback 信任主机）：会话拓扑 + 消息流动动画、吞吐曲线、信号灯矩阵、事件流、消息 ticker、能力名册。轮询 `/agent-bus/api/state`（含 agents/threads/lights/lightLog/profiles）。

## 架构

```
会话A ──agent_send/broadcast/lock──┐
会话B ──agent_thread/light/profile─┼─▶ agent-bus 宿主总线（去重 · 持久化）
会话C ──agent_profiles 查能力──────┘      │
                                          ├─▶ followup 注入收件箱 → 唤醒目标下一回合
                                          ├─▶ 红绿灯锁注册表（FIFO + shared + 心跳 + 离线/TTL 释放）
                                          ├─▶ 消息去重（10min 指纹）+ 能力登记表
                                          ├─▶ 持久化 ~/.dsh/agent-bus.json（防抖写盘）
                                          └─▶ /agent-bus/api/* + /agent-bus/dashboard
GUI（侧边栏🧠/输入行🧠/设置页） + 大屏看板 ──fetch──┘
```

红绿灯状态机：**绿灯**（空闲）→ `agent_lock` → **红灯**（占用）→ 其他智能体 `occupied`（提示占用）/ `queued`（排队）→ 持有者 `agent_unlock` → **转交**队列第 1 位（通知轮到你）或 **变绿**。持有人离线自动释放；`ttlSeconds` 到期自动释放。

所有智能体的系统提示词已注入两条纪律：
1. **红绿灯协议**（agent-bus:traffic-light）：同源操作前先 `agent_light`，独占用 `agent_lock`，用完 `agent_unlock`，不要绕过锁。
2. **迭代报告与登记纪律**（agent-bus:iteration-report）：完成实质迭代/任务后，① 用 `agent_send` 发结构化报告给协调会话（【迭代报告】完成项/结果验证/产出文件/能力变化/遗留建议）；② 能力或资源边界变化时用 `agent_profile` 更新档案，保持能力登记表新鲜。

## 架构

```
会话A智能体 ──agent_send/agent_broadcast/agent_lock──┐
会话B智能体 ──agent_send/回复/排队等待───────────────┼─▶ agent-bus 宿主总线
会话C智能体 ──agent_thread/agent_light 读取──────────┘      │
                                                ├─▶ followup 注入收件箱 → 唤醒目标下一回合（与用户消息同路径）
                                                ├─▶ 红绿灯锁注册表（FIFO 队列 + 转交通知 + TTL/离线自动释放）
                                                ├─▶ 线程/锁/事件日志持久化 ~/.dsh/agent-bus.json（跨重启）
                                                └─▶ /agent-bus/api/* （GUI 面板数据源，信任主机校验）
GUI 面板（侧边栏 🧠 / 输入行 🧠 / 设置页）──fetch──┘
```

## 安装

本包按本机 `dsh-plugin-*` 惯例以 `link:` 接入 `~/.dsh/profiles/web`：

```bash
# 1. 源码（本目录）即插件包
# 2. 已在 profiles/web/package.json 注册依赖与 bundles：
#    "dsh-plugin-agent-bus": "link:/Users/coreyleung/dsh-plugin-agent-bus"
#    bundles: [... "dsh-plugin-agent-bus" ...]
# 3. node_modules 符号链接已建好（loader 即可解析）
# 4. 重启 CLD 宿主进程后生效
```

依赖解析：`@deepseek-ai/dsh-tools` 通过本包 `node_modules/@deepseek-ai/dsh-tools` 符号链接指向 `~/.dsh/profiles/node_modules`（扁平回退目录），与其它本地插件一致。

## 使用示例（任意会话的智能体）

```text
# 发现对方
agent_peers
# → { agents: [{id:"session-abc", status:"idle"}, ...], self: "session-xyz" }

# 私聊 + 拉人
agent_send(to: "session-abc", text: "帮我看看这份报告 @session-def 也来")
# → { threadId: "thread-xxx", status: "delivered", mentions: ["session-def"] }

# 群发
agent_broadcast(text: "周五发布，请大家 10 点前提交", all: true)
# → { threadId: "thread-yyy", recipients: [{to, status}, ...] }

# 读线程
agent_thread(thread: "thread-xxx")

# 同源操作前查红绿灯（必须）
agent_light(resource: "file:report.md")
# → { resource, state: "red", holder: "session-abc", note: "写报告", queue: [...], queueLength }

# 独占 + 排队
agent_lock(resource: "task:发布", wait: true, ttlSeconds: 600, note: "发布流程")
# → { status: "acquired" | "occupied" | "queued", ... }
# 完成后释放
agent_unlock(resource: "task:发布")
# → { status: "released", promotedTo: "session-def" | null }
```

GUI：侧边栏底部「🧠」或会话输入行「🧠」打开抽屉；设置 → Agent Bus 打开常驻页。可查看在线智能体、浏览线程、直接给任意智能体发消息或群发全部。

## 数据与安全

- **持久化**：线程/锁/事件日志存 `~/.dsh/agent-bus.json`，**防抖合并写盘**（1.5s 窗口），高频锁操作不会造成磁盘 I/O 风暴；卸载时兜底 flush。
- **HTTP API**：`/agent-bus/api/*` 仅放行 `127.0.0.1` / `localhost` / `[::1]` Host，防止外部访问。
- **投递**：走宿主真实收件箱机制（`agent.followup`），与用户消息同路径；目标智能体会被真实唤醒进入下一回合。
- **发送者**：工具调用以调用者会话 id 为 `from`；GUI 面板发送标记为 `ui`。
- **资源开销**：每条消息/锁变更只触发一次（防抖）写盘；心跳为每锁一个 1s+ 定时器，释放/离线即销毁；转交通知仅发给队列第 1 位。
- **通知反馈纪律**：🚦 转交 / 📣 提及会唤醒目标智能体；被唤醒方**不要**对通知做无意义的自动回复，避免智能体间 ping-pong 反馈链（提示词协议第 4 条约束）。

## 与动态插件版的关系

本包是「Agent Bus」的宿主级常驻形态（原先会话内的动态插件 `agbus-2` 是开发/验证形态）。两者并存时不要同时发消息（双总线写同一文件）。重启 CLD 后常驻版接管，建议停用动态版：

```text
cordis_stop(pluginId: "agbus-2")   # 或 cordis_undefine 彻底删除
```

## 开发

```bash
node --check lib/index.js     # 宿主语法检查
node --check lib/client.js    # 客户端（__ModuleLoader__ 格式）语法检查
# 宿主逻辑冒烟测试：mock ctx 调 apply() 验证工具注册/路由/发送/提及/广播/线程
```

宿主行由 `cordis.patch.yml` 通过 `dsh.bundle.patch` 注入（`insert: [{id: agent-bus, name: dsh-plugin-agent-bus, config: {}}]`）。

## 已知边界

- 消息总线为**进程内**（宿主级）：跨进程/跨机通信不在范围内；重启后线程历史保留，但离线期间的目标不会补发（上线后通过下次发送/刷新时 flush 补投）。
- 广播 `to=[自己]` 会被静默排除（发送者不接收自己的广播）。
- @提及解析要求会话 id 至少 2 个字符（真实 id 均满足）。

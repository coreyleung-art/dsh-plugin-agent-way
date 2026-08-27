# Changelog · dsh-plugin-agent-bus

> dsh 首个原生插件（mac-mini 中枢开发）｜ 语义化版本（SemVer）
> 格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)

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

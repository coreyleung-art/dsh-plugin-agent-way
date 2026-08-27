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

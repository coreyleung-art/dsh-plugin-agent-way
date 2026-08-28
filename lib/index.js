// dsh-plugin-agent-way —— 跨智能体高速公路（宿主级常驻消息总线）+ 红绿灯同源互斥锁
// 外部名：dsh-plugin-agent-way（更名史：v1.0.0 → v1.1.0 → v1.1.1 命名统一）
// 内部标识（兼容层，勿改）：cordis id=agent-bus / 服务 agentBus / 持久化 agent-bus.json / API /agent-bus
// 能力：
//   agent_peers / agent_send / agent_broadcast / agent_thread（跨会话、跨窗口）
//   @提及自动通知 + 线程持久化（~/.dsh/agent-bus.json）
//   红绿灯互斥锁：agent_light / agent_lock / agent_unlock / agent_unlock_all
//     - exclusive / shared 双模式（共享读锁并行，写锁互斥）
//     - FIFO 排队转交 + 🚦 通知
//     - TTL 自动过期、持有者离线自动释放、心跳续租（heartbeat）
//   自动冲突检测：tools.guard 挂钩，write/edit/waimai_* 等写操作命中红灯自动拒绝并提示
//   webServer API（/agent-bus/api/*）+ agentBus 服务 + 系统提示词纪律注入
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { startAdaptGuard } from './adapt.js';

export const name = 'agent-bus';
export const inject = ['tools'];
export const Config = undefined;

const PREFIX = '/agent-bus';
const DATA_FILE = join(homedir(), '.dsh', 'agent-bus.json');

const LIGHT_PROMPT = `【Agent Bus 同源互斥 · 红绿灯协议】
多个智能体可能同时操作同一资源（同一文件、同一后台、同一任务、占用某个智能体等「同源操作」）。做这类操作前，必须：
1. 先调用 agent_light 查询该资源：绿灯=空闲可直接做；红灯=已被占用（holders 列表）；共享读锁（shared）可并行加入。
2. 需要独占时调用 agent_lock(resource, mode:"exclusive"|"shared", wait:true) 获取锁；红灯且 mode 不兼容时可排队等待，轮到你会收到 🚦 通知。
3. 操作完成后立即 agent_unlock 释放，让队列下一位转交（红绿灯变绿或转交）。
4. 不要绕过锁直接操作同源资源；write/edit 等写操作命中红灯会被自动拦截（自动冲突检测），拦截提示里会给出排队方式。`;

const REPORT_PROMPT = `【迭代完成 · 报告与登记纪律】
完成一项实质迭代/任务（修 bug、加能力、改配置、产出文档等）后，必须做两件事：
1. 发结构化报告给总线协调会话（agent_profiles 查 role 含「协调/统筹」的会话，或已知协调者 session-fa1f9150-c949-401f-ba8c-d265f6221676），用 agent_send 附 thread（无则新线程），格式：
   【迭代报告】<角色/会话> · <时间>
   - 完成项：……
   - 结果/验证：……（实测证据，避免引用旧状态）
   - 产出/文件：……（路径）
   - 能力边界变化：新增/变化的能力或资源（已用 agent_profile 登记）
   - 遗留/建议：……
2. 能力或资源边界有变化时，同步用 agent_profile 更新自己的档案（role/abilities/resources），保持登记表新鲜。
纯确认/重复/低价值消息可不发（去重会自动拦截 10 分钟内同内容）。报告保持简洁，协调者会归档。`;

function rid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function createStore() {
  const threads = new Map();
  const locks = new Map();
  const lightLog = [];
  const dedup = new Map();
  const profiles = new Map();
  let restartPlan = null;
  const approvals = new Map();
  return {
    threads,
    locks,
    lightLog,
    dedup,
    profiles,
    approvals,
    get restartPlan() { return restartPlan; },
    set restartPlan(p) { restartPlan = p; },
    thread(id) {
      let t = threads.get(id);
      if (!t) { t = { id, createdAt: Date.now(), messages: [] }; threads.set(id, t); }
      return t;
    },
    addMessage(threadId, from, to, text) {
      const t = this.thread(threadId);
      const msg = { id: rid('bus'), thread: threadId, from, to, text, time: Date.now(), status: 'queued', kind: 'normal' };
      t.messages.push(msg);
      return msg;
    },
    threadsFor(agentId) {
      const out = [];
      for (const t of threads.values()) {
        if (t.messages.some((m) => m.from === agentId || m.to === agentId)) out.push(t);
      }
      return out.sort((a, b) => (b.messages[b.messages.length - 1]?.time ?? 0) - (a.messages[a.messages.length - 1]?.time ?? 0));
    },
    serialize() {
      return {
        threads: Array.from(threads.values()),
        locks: Array.from(locks.values()),
        lightLog,
        dedup: Array.from(dedup.values()),
        profiles: Array.from(profiles.values()),
        restartPlan,
        approvals: Array.from(approvals.values())
      };
    },
    deserialize(data) {
      if (!data) return;
      if (Array.isArray(data.threads)) {
        for (const t of data.threads) {
          if (t && typeof t.id === 'string' && Array.isArray(t.messages)) threads.set(t.id, t);
        }
      }
      if (Array.isArray(data.locks)) {
        for (const l of data.locks) {
          if (!l || typeof l.resource !== 'string') continue;
          if (l.holders && Array.isArray(l.holders)) {
            locks.set(l.resource, l); // 新格式
          } else if (typeof l.holder === 'string') {
            // 旧格式迁移
            locks.set(l.resource, {
              resource: l.resource,
              lockId: l.lockId || rid('lock'),
              mode: 'exclusive',
              holders: [l.holder],
              notes: { [l.holder]: l.note || '' },
              acquiredAt: { [l.holder]: l.acquiredAt || Date.now() },
              expiresAt: { [l.holder]: l.expiresAt ?? null },
              queue: Array.isArray(l.queue)
                ? l.queue.map((id) => (typeof id === 'string' ? { id, mode: 'exclusive', note: '', ttlSeconds: 0, heartbeat: false } : id))
                : []
            });
          }
        }
      }
      if (Array.isArray(data.lightLog)) lightLog.push(...data.lightLog.slice(-50));
      if (Array.isArray(data.dedup)) {
        for (const d of data.dedup) {
          if (d && typeof d.key === 'string' && typeof d.messageId === 'string') dedup.set(d.key, { time: d.time || Date.now(), messageId: d.messageId });
        }
      }
      if (Array.isArray(data.profiles)) {
        for (const p of data.profiles) {
          if (p && typeof p.agentId === 'string') profiles.set(p.agentId, p);
        }
      }
      if (data.restartPlan && typeof data.restartPlan === 'object' && data.restartPlan.id) {
        // 重启征询状态恢复：非 done/go 的残留计划标记为 interrupted（宿主重启会打断）
        const p = data.restartPlan;
        if (p.status !== 'done' && p.status !== 'go') {
          p.status = 'interrupted';
          p.interruptedAt = Date.now();
        }
        restartPlan = p;
      }
      if (Array.isArray(data.approvals)) {
        for (const a of data.approvals) {
          if (a && typeof a.id === 'string') approvals.set(a.id, a);
        }
      }
    }
  };
}

function parseMentions(text, liveIds, exclude) {
  const found = [];
  const seen = new Set();
  const re = /@([A-Za-z0-9][A-Za-z0-9-]{1,})/g;
  let m;
  while ((m = re.exec(text))) {
    const id = m[1];
    if (liveIds.has(id) && !exclude.has(id) && !seen.has(id)) {
      seen.add(id);
      found.push(id);
    }
  }
  return found;
}

export function apply(ctx, config) {
  const store = createStore();
  const agentsSvc = ctx.get('agents', false);
  const toolsSvc = ctx.get('tools', false);
  const ws = ctx.get('webServer', false);
  const sp = ctx.get('systemPrompt', false);
  const timerSvc = ctx.get('timer', false);

  // ---- 版本自适应守护（宿主 dsh rc 升级主动检测 + 告警；见 adapt.js） ----
  // 指纹：dsh/dsh-tools/dsh-agent/dsh-session/dsh-llm/cordis 版本串联
  // 变化 → 写黑板告警 + 记录 adapt-log（能力探测兜底，不猜版本）
  {
    const adaptDisposer = startAdaptGuard(ctx, timerSvc, (report) => {
      const detail = (report.detail || '') + (report.capDetail ? ' | 能力: ' + report.capDetail : '');
      console.log('[agent-bus] ⚠️ 宿主版本变化（自适应）: ' + detail);
      // 写黑板告警（供中枢/两端感知；异步不阻塞）
      const bbUrl = process.env.DSH_BB_URL || 'http://127.0.0.1:8792';
      const key = 'notes/collab/plugin-adapt-alert-' + Date.now();
      const body = {
        type: 'note', node: 'mac-mini', ts: Date.now(),
        target: 'collab',
        subject: '⚠️ 宿主 rc 版本变化（dsh-plugin-agent-way 自适应）',
        body: '检测到宿主版本变化: ' + detail + '。已更新自适应基线，插件继续运行；若 API 破坏性变化请跑 deploy-check 复核。',
      };
      if (typeof fetch === 'function') {
        fetch(bbUrl + '/' + key, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .catch(() => { /* 黑板不可达忽略 */ });
      }
    });
    if (adaptDisposer) ctx.effect(adaptDisposer);
  }

  // ---- 提示词纪律注入（所有智能体同源操作前先查红绿灯 + 迭代完成报告登记） ----
  if (sp && typeof sp.section === 'function') {
    ctx.effect(() => sp.section({ name: 'agent-bus:traffic-light', order: 116, text: LIGHT_PROMPT }));
    ctx.effect(() => sp.section({ name: 'agent-bus:iteration-report', order: 117, text: REPORT_PROMPT }));
  }

  // ---- 持久化（~/.dsh/agent-bus.json，跨进程重启保留；防抖合并写盘） ----
  let persistQueue = Promise.resolve();
  let persistTimer = null;
  let persistDirty = false;
  async function load() {
    try {
      const raw = await readFile(DATA_FILE, 'utf8');
      store.deserialize(JSON.parse(raw));
    } catch (_) { /* first run */ }
  }
  function writeNow() {
    persistQueue = persistQueue.then(async () => {
      try {
        await mkdir(dirname(DATA_FILE), { recursive: true });
        await writeFile(DATA_FILE, JSON.stringify(store.serialize()));
      } catch (_) { /* best-effort */ }
    });
    return persistQueue;
  }
  // 防抖：高频变更（锁/消息/队列）合并为一次写盘；卸载时兜底 flush
  function persist() {
    persistDirty = true;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (persistDirty) { persistDirty = false; void writeNow(); }
    }, 1500);
  }
  ctx.effect(() => () => {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (persistDirty) { persistDirty = false; void writeNow(); }
  });
  void load();

  // 大屏看板页面（随包交付，启动时读入内存）
  let dashboardHtml = '<!DOCTYPE html><html><body style="background:#050a16;color:#22d3ee;font-family:monospace"><h2>Agent Bus 大屏</h2><p>dashboard.html 缺失</p></body></html>';
  (async () => {
    try {
      const html = await readFile(new URL('./dashboard.html', import.meta.url), 'utf8');
      if (html && html.length > 200) dashboardHtml = html;
    } catch (_) { /* fallback */ }
  })();

  // ---- 消息去重（v0.2）：同发件人+同线程+同内容，10 分钟内视为重复，不重复投递 ----
  const DEDUP_WINDOW_MS = 10 * 60 * 1000;
  function dedupKey(from, threadId, text) {
    return from + '|' + (threadId || '') + '|' + String(text || '').trim();
  }
  function checkDedup(from, threadId, text) {
    const now = Date.now();
    for (const [k, v] of store.dedup) { if (now - v.time > DEDUP_WINDOW_MS) store.dedup.delete(k); }
    const key = dedupKey(from, threadId, text);
    const hit = store.dedup.get(key);
    if (hit) return { duplicate: true, key, messageId: hit.messageId };
    return { duplicate: false, key };
  }
  function recordDedup(key, messageId) {
    store.dedup.set(key, { time: Date.now(), messageId });
    if (store.dedup.size > 300) { const first = store.dedup.keys().next().value; if (first) store.dedup.delete(first); }
    void persist();
  }

  function logLight(kind, resource, holder, detail) {
    store.lightLog.push({ time: Date.now(), kind, resource, holder: holder || null, detail: detail || null });
    if (store.lightLog.length > 50) store.lightLog.splice(0, store.lightLog.length - 50);
  }

  // ---- 心跳续租：持锁者存活期间自动续期 ----
  const heartbeats = new Map();
  function startHeartbeat(resource, holder, ttlMs) {
    stopHeartbeat(resource);
    if (!timerSvc || typeof timerSvc.interval !== 'function') return;
    const period = Math.max(Math.floor(ttlMs / 3), 1000);
    const disposer = timerSvc.interval(() => {
      const lk = store.locks.get(resource);
      if (!lk || !lk.holders.includes(holder)) { stopHeartbeat(resource); return; }
      lk.expiresAt[holder] = Date.now() + ttlMs;
    }, period);
    heartbeats.set(resource, disposer);
  }
  function stopHeartbeat(resource) {
    const d = heartbeats.get(resource);
    if (d) { try { d(); } catch (_) { /* ignore */ } heartbeats.delete(resource); }
  }
  ctx.effect(() => () => {
    for (const d of heartbeats.values()) { try { d(); } catch (_) { /* ignore */ } }
    heartbeats.clear();
  });

  // ---- 投递：与用户消息同路径（agent.followup → 收件箱 → 唤醒目标下一回合） ----
  // R009 命名规范：把 session-id 映射为「自命名-设备-角色」（人类可读），映射不到显示原始
  function resolveDisplayName(agentId) {
    try {
      const data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      const profiles = data.profiles || {};
      const list = Array.isArray(profiles) ? profiles : Object.values(profiles);
      for (const p of list) {
        if (p && p.agentId === agentId && p.role) {
          // role 形如「星桥-mac-mini-协调者」→ 取自命名（第一个 - 前）
          const parts = String(p.role).split('-');
          if (parts.length >= 2 && parts[0].trim()) return parts[0].trim();
          return p.role;
        }
      }
    } catch { /* 读失败回退 */ }
    return agentId;
  }

  function deliver(msg, kind) {
    const target = agentsSvc ? agentsSvc.get(msg.to) : undefined;
    if (!target || typeof target.followup !== 'function') return false;
    try {
      let body;
      if (kind === 'mention') {
        body = [
          { type: 'text', text: '📣 跨会话 @提及（你被点名）' },
          { type: 'text', text: '来自: ' + resolveDisplayName(msg.from) },
          { type: 'text', text: '线程: ' + msg.thread },
          { type: 'text', text: msg.text },
          { type: 'text', text: '— 加入讨论请用 agent_thread 读取线程 ' + msg.thread + '；回复用 agent_send: {"to": "' + msg.from + '", "thread": "' + msg.thread + '", "text": "..."}' }
        ];
      } else if (kind === 'broadcast') {
        body = [
          { type: 'text', text: '[跨会话群发广播] 来自: ' + resolveDisplayName(msg.from) },
          { type: 'text', text: '线程: ' + msg.thread },
          { type: 'text', text: msg.text },
          { type: 'text', text: '— 这是群聊线程，回复请调用 agent_send 并带上 thread: {"to": "' + msg.from + '", "thread": "' + msg.thread + '", "text": "..."}' }
        ];
      } else {
        body = [
          { type: 'text', text: '[跨会话智能体消息] 来自: ' + resolveDisplayName(msg.from) },
          { type: 'text', text: '线程: ' + msg.thread },
          { type: 'text', text: msg.text },
          { type: 'text', text: '— 回复请调用 agent_send 工具: {"to": "' + msg.from + '", "thread": "' + msg.thread + '", "text": "..."}' }
        ];
      }
      target.followup({
        id: msg.id,
        role: 'user',
        source: { kind: 'agent-bus', senderSessionId: msg.from, threadId: msg.thread },
        content: body
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  // 通知（不入线程，直接唤醒目标）—— 红绿灯转交 / 到期提醒
  function notifyAgent(agentId, text) {
    const target = agentsSvc ? agentsSvc.get(agentId) : undefined;
    if (!target || typeof target.followup !== 'function') return false;
    try {
      target.followup({
        id: rid('bus'),
        role: 'user',
        source: { kind: 'agent-bus', notification: 'light' },
        content: [{ type: 'text', text: '🚦 跨会话红绿灯通知\n' + text }]
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  // ---- 程序化唤醒（v0.3）：agents.resume 激活离线会话，无需手动开会话 ----
  function deliverWake(agentId, text) {
    const target = agentsSvc ? agentsSvc.get(agentId) : undefined;
    if (!target || typeof target.followup !== 'function') return false;
    try {
      target.followup({
        id: rid('bus'),
        role: 'user',
        source: { kind: 'agent-bus', notification: 'wake' },
        content: [
          { type: 'text', text: '⏰ 跨会话唤醒（agent_wake）' },
          { type: 'text', text: String(text || '') }
        ]
      });
      return true;
    } catch (_) {
      return false;
    }
  }
  async function persistedSessionIds() {
    const sp = ctx.get('sessionPersistence', false);
    if (!sp || typeof sp.list !== 'function') return new Set();
    try {
      const headers = await sp.list();
      return new Set(headers.map((h) => h && h.id).filter(Boolean));
    } catch (_) {
      return new Set();
    }
  }
  async function resumeAgent(id) {
    const ag = ctx.get('agents', false);
    if (!ag || typeof ag.resume !== 'function') return null;
    try {
      // 关键修复：agents.resume 的 agentOptions 不能为空——{{model}}/{{provider}} 变量
      // 由 systemPrompt 从 agent.options 读取，空对象会导致 persona 组装失败
      // （"prompt variable {{model}} has no value"）。从 agentDefaultModel 取当前选择。
      const agentOptions = {};
      try {
        const adm = ctx.get('agentDefaultModel', false);
        if (adm && typeof adm.currentSelection === 'function') {
          const sel = adm.currentSelection();
          if (sel && typeof sel.provider === 'string' && sel.provider) agentOptions.provider = sel.provider;
          if (sel && typeof sel.model === 'string' && sel.model) agentOptions.model = sel.model;
        }
      } catch (_) { /* fallback: empty options */ }
      if (!agentOptions.provider || !agentOptions.model) {
        // 兜底：从 settings 文档读 agent-default-model
        try {
          const settings = ctx.get('settings', false);
          const cur = settings ? settings.get('agent-default-model') : undefined;
          if (cur && typeof cur.provider === 'string' && cur.provider) agentOptions.provider = cur.provider;
          if (cur && typeof cur.model === 'string' && cur.model) agentOptions.model = cur.model;
        } catch (_) { /* fallback */ }
      }
      const handle = await ag.resume({
        resumeSessionId: id,
        agentOptions,
        // 关键修复 2（CLD-013）：resume 必须挂载 preset，否则 bash/read/write/edit 等
        // preset 组成注册的工具缺失（agent factory 正常创建时由 setup hook 调 agentPresets.mount）。
        // 此处把 mount 作为 setup 传入，与 GUI 恢复会话同路径。
        setup: async (agentCtx) => {
          const ap = ctx.get('agentPresets', false);
          if (ap && typeof ap.mount === 'function') {
            try {
              await ap.mount(agentCtx);
            } catch (_) { /* preset 挂载失败不阻断 resume（工具可能不全但会话可用） */ }
          }
          return undefined;
        }
      });
      return handle && handle.agent ? handle.agent : null;
    } catch (e) {
      try {
        writeFile('/tmp/agentbus-resume.log', new Date().toISOString() + ' resume fail for ' + id + ': ' + String((e && e.stack) || e) + '\n', { flag: 'a' });
      } catch (_2) { /* ignore */ }
      return null;
    }
  }
  // 唤醒单个目标：live → 直接投递；离线 → agents.resume 拉活后投递；无持久化 → queued
  async function wakeTarget(id, text, opts) {
    const doResume = opts.resume !== false;
    const live = agentsSvc ? agentsSvc.get(id) : undefined;
    if (live && typeof live.followup === 'function') {
      return { id, status: deliverWake(id, text) ? 'delivered' : 'deliver-failed', via: 'live' };
    }
    if (doResume) {
      const agent = await resumeAgent(id);
      if (agent) {
        return { id, status: deliverWake(id, text) ? 'delivered' : 'deliver-failed', via: 'resume' };
      }
    }
    const persisted = await persistedSessionIds();
    return { id, status: persisted.has(id) ? 'resume-failed' : 'not-persisted', via: 'offline' };
  }
  // 批量唤醒：ids 指定 / all=全部档案会话 / 缺省=所有有排队消息的目标
  async function wakeBatch(opts) {
    const ids = [];
    if (Array.isArray(opts.ids) && opts.ids.length > 0) {
      ids.push(...opts.ids.map(String));
    } else if (opts.all === true) {
      for (const p of store.profiles.values()) ids.push(p.agentId);
      for (const t of store.threads.values()) {
        for (const m of t.messages) { if (m.to && !ids.includes(m.to)) ids.push(m.to); }
      }
    } else {
      for (const t of store.threads.values()) {
        for (const m of t.messages) { if (m.status === 'queued' && m.to && !ids.includes(m.to)) ids.push(m.to); }
      }
    }
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return { targets: [], summary: { total: 0, delivered: 0, resume: 0, failed: 0 } };
    const text = opts.text !== undefined && opts.text !== '' ? String(opts.text) : '宿主已恢复，总线在线。请恢复你的角色工作；有跨会话消息待处理可用 agent_thread 查看，有锁请 agent_unlock 释放。';
    const results = [];
    if (opts.dryRun === true) {
      for (const id of unique) {
        const live = agentsSvc ? agentsSvc.get(id) : undefined;
        results.push({ id, status: live ? 'live' : 'offline', via: 'dry-run' });
      }
    } else {
      for (const id of unique) {
        try { results.push(await wakeTarget(id, text, opts)); } catch (e) { results.push({ id, status: 'error', via: String((e && e.message) || e) }); }
      }
    }
    const summary = { total: results.length, delivered: 0, resume: 0, failed: 0, offline: 0 };
    for (const r of results) {
      if (r.status === 'delivered' && r.via === 'resume') summary.resume++;
      if (r.status === 'delivered') summary.delivered++;
      else if (r.status === 'resume-failed' || r.status === 'not-persisted' || r.status === 'error' || r.status === 'deliver-failed') summary.failed++;
      else summary.offline++;
    }
    flushQueue();
    void persist();
    return { targets: results, summary };
  }
  // 启动自动唤醒：宿主重启后，有排队消息的离线会话自动 resume + 投递（无需手动开会话）
  let autoWakeDone = false;
  async function autoWake() {
    if (autoWakeDone) return;
    autoWakeDone = true;
    // 安全启动(2026-08-22 反风暴): 不再批量 resume agent 会话、不再批量投递积压队列。
    // 积压消息保持 queued, 由目标 agent 在线时按需 deliver; agent_send/agent_broadcast 等主动发送不受影响。
    logLight('autoWake', null, null, 'safe-boot: auto-resume/flush disabled (anti-storm)');
  }

  // ---- 受控重启征询（v0.3）：重启前询问全体智能体就绪状态，全部确认后才可激活重启 ----
  // 状态机：polling（征询中，收集确认）→ ready（全部确认）→ go（激活重启，广播倒计时）
  //         aborted（协调者取消）· interrupted（宿主重启打断，恢复时标记）· done（重启完成）
  // 持久化在 store.restartPlan，跨重启保留（deserialize 会把非 done/go 的残留标为 interrupted）
  const RESTART_THREAD_PREFIX = 'restart-';

  function restartBroadcast(plan, text, opts) {
    // 发到重启专用线程（broadcast 的 from 用 plan.requestedBy 或 system）
    const from = plan.requestedBy || 'system';
    const to = opts && opts.to ? opts.to : undefined;
    const tid = plan.threadId || (RESTART_THREAD_PREFIX + plan.id);
    const res = broadcast(from, text, { thread: tid, all: true, to });
    if (!plan.threadId) plan.threadId = tid;
    return res;
  }

  function restartSummary(plan) {
    if (!plan) return null;
    const liveIds = new Set(agentList().map((a) => a.id));
    const acks = [];
    const missing = [];
    for (const id of liveIds) {
      const ack = plan.acks && plan.acks[id];
      if (ack) acks.push({ agentId: id, ready: ack.ready, reason: ack.reason || null, etaSeconds: ack.etaSeconds || null, at: ack.at });
      else missing.push(id);
    }
    const now = Date.now();
    return {
      id: plan.id,
      status: plan.status,
      requestedBy: plan.requestedBy,
      requestedAt: plan.requestedAt,
      reason: plan.reason || null,
      graceSeconds: plan.graceSeconds,
      deadline: plan.deadline,
      remainingSeconds: plan.deadline ? Math.max(0, Math.round((plan.deadline - now) / 1000)) : null,
      allReady: missing.length === 0 && acks.length > 0 && acks.every((a) => a.ready),
      acks,
      missing,
      threadId: plan.threadId || null,
      announced: plan.announced || false,
      goAt: plan.goAt || null,
      interruptedAt: plan.interruptedAt || null
    };
  }

  function canGo(plan) {
    if (!plan || plan.status !== 'polling') return false;
    const liveIds = new Set(agentList().map((a) => a.id));
    if (liveIds.size === 0) return false;
    for (const id of liveIds) {
      const ack = plan.acks && plan.acks[id];
      if (!ack || ack.ready !== true) return false;
    }
    return true;
  }

  function finishPolling(plan) {
    if (plan.status !== 'polling') return;
    if (canGo(plan)) {
      plan.status = 'ready';
      plan.readyAt = Date.now();
      const left = plan.deadline ? Math.max(0, Math.round((plan.deadline - Date.now()) / 1000)) : 0;
      restartBroadcast(plan, '✅ 重启征询全部确认就绪（' + plan.graceSeconds + 's 宽限期内）。协调者可随时 agent_restart_go 激活受控重启；不激活则保持等待。剩余宽限 ' + left + 's。');
      void persist();
      logLight('restart', plan.id, null, 'all-ready');
    }
  }

  // 宽限期到期评估：仍有未确认 → 广播提醒；全部确认 → 转 ready（finishPolling 兜底）
  function evaluateDeadline(plan) {
    if (!plan || plan.status !== 'polling') return;
    const liveIds = new Set(agentList().map((a) => a.id));
    const missing = [];
    for (const id of liveIds) {
      const ack = plan.acks && plan.acks[id];
      if (!ack || ack.ready !== true) missing.push(id);
    }
    if (missing.length > 0) {
      restartBroadcast(plan, '⏳ 重启征询宽限期到（' + plan.graceSeconds + 's），以下会话尚未确认就绪：' + missing.join(', ') + '。请尽快完成当前工作后用 agent_restart_ack(ready: true) 确认；或说明原因 agent_restart_ack(ready: false, reason, etaSeconds)。');
    }
    finishPolling(plan);
  }

  function scheduleDeadline(plan) {
    if (!plan || !plan.deadline || !timerSvc || typeof timerSvc.timeout !== 'function') return;
    const delay = Math.max(0, plan.deadline - Date.now());
    ctx.effect(() => timerSvc.timeout(() => evaluateDeadline(plan), delay));
  }

  function requestRestart(agentId, opts) {
    const cur = store.restartPlan;
    if (cur && (cur.status === 'polling' || cur.status === 'ready')) {
      return { ok: false, error: '已有进行中的重启征询（' + cur.id + '，状态 ' + cur.status + '）。先用 agent_restart_status 查看；如需重新发起先协调者取消（agent_restart_cancel）。', plan: restartSummary(cur) };
    }
    const graceSeconds = opts.graceSeconds && opts.graceSeconds > 0 ? Math.min(Math.floor(opts.graceSeconds), 3600) : 300;
    const plan = {
      id: rid('restart'),
      status: 'polling',
      requestedBy: agentId,
      requestedAt: Date.now(),
      reason: opts.reason ? String(opts.reason) : null,
      graceSeconds,
      deadline: Date.now() + graceSeconds * 1000,
      acks: {},
      announced: false
    };
    store.restartPlan = plan;
    const res = restartBroadcast(plan, '🔁 【受控重启征询】协调者 ' + agentId + ' 发起重启征询（' + graceSeconds + 's 宽限期' + (plan.reason ? '，原因：' + plan.reason : '') + '）。请各位智能体：尽快完成当前工作或进入可中断状态，然后用 agent_restart_ack 确认（ready: true=就绪可重启；ready: false=需收尾，附 reason 与 etaSeconds 预计完成秒数）。全部确认后协调者将激活重启。');
    plan.announced = res && res.recipients && res.recipients.length > 0;
    scheduleDeadline(plan);
    void persist();
    logLight('restart', plan.id, agentId, 'request');
    return { ok: true, plan: restartSummary(plan), broadcast: res };
  }

  function ackRestart(agentId, opts) {
    const plan = store.restartPlan;
    if (!plan || plan.status !== 'polling') {
      return { ok: false, error: '当前没有进行中的重启征询（或已结束）。协调者可用 agent_restart_request 发起。', plan: restartSummary(plan) };
    }
    const ready = opts.ready === true;
    plan.acks = plan.acks || {};
    plan.acks[agentId] = { ready, reason: opts.reason ? String(opts.reason) : null, etaSeconds: opts.etaSeconds && opts.etaSeconds > 0 ? Math.floor(opts.etaSeconds) : null, at: Date.now() };
    const sum = restartSummary(plan);
    if (ready) {
      // 可能本轮已全就绪 → 尝试转 ready
      finishPolling(plan);
      void persist();
      return { ok: true, ack: { agentId, ready: true }, plan: restartSummary(plan) };
    }
    // not ready：若此前标记过 ready 现在反悔，重新进入等待
    if (plan.status === 'ready') {
      plan.status = 'polling';
      delete plan.readyAt;
    }
    const eta = opts.etaSeconds && opts.etaSeconds > 0 ? '，预计 ' + Math.floor(opts.etaSeconds) + 's 后完成' : '';
    restartBroadcast(plan, '⏸ ' + agentId + ' 暂不就绪：' + (opts.reason ? String(opts.reason) : '需要收尾') + eta + '。继续等待。');
    void persist();
    return { ok: true, ack: { agentId, ready: false, reason: opts.reason || null, etaSeconds: opts.etaSeconds || null }, plan: restartSummary(plan) };
  }

  function restartStatus() {
    const plan = store.restartPlan;
    return { ok: true, plan: restartSummary(plan) };
  }

  function goRestart(agentId, opts) {
    const plan = store.restartPlan;
    if (!plan) return { ok: false, error: '没有进行中的重启征询。先 agent_restart_request 发起。' };
    if (plan.status !== 'ready') {
      const sum = restartSummary(plan);
      if (!sum) return { ok: false, error: '征询状态异常', plan: null };
      if (sum.missing.length > 0) {
        return { ok: false, error: '还有 ' + sum.missing.length + ' 个会话未确认就绪：' + sum.missing.join(', ') + '。请等待 agent_restart_ack 或协调者确认。', plan: sum };
      }
      return { ok: false, error: '征询尚未全部就绪（当前状态 ' + plan.status + '）。', plan: sum };
    }
    if (opts.confirm !== true) {
      return { ok: false, error: '激活重启是高危操作：请确认 agent_restart_go(confirm: true)。将广播 GO + 倒计时，然后需要用户手动退出并重开 CLD（本环境 SIGTERM 宿主=关闭不拉起）。', plan: restartSummary(plan) };
    }
    const countdown = opts.countdown && opts.countdown > 0 ? Math.min(Math.floor(opts.countdown), 120) : 30;
    plan.status = 'go';
    plan.goAt = Date.now();
    plan.countdown = countdown;
    plan.goBy = agentId;
    restartBroadcast(plan, '🚀 【重启 GO】协调者 ' + agentId + ' 激活受控重启，倒计时 ' + countdown + 's。请各智能体保存工作、释放锁（agent_unlock_all）、进入等待重启状态。之后**需用户手动退出并重开 CLD**（本环境 SIGTERM=关闭不自动拉起，三次实证）。');
    void persist();
    logLight('restart', plan.id, agentId, 'go');
    return { ok: true, plan: restartSummary(plan), instruction: '广播已发。请用户手动退出并重开 CLD 完成重启；重开后总线 autoWake 自动恢复在线会话。' };
  }

  function cancelRestart(agentId) {
    const plan = store.restartPlan;
    if (!plan) return { ok: false, error: '没有进行中的重启征询。' };
    if (plan.status === 'go') return { ok: false, error: '重启已激活（go），无法取消。' };
    if (plan.status === 'done') return { ok: false, error: '重启已完成，无需取消。' };
    plan.status = 'aborted';
    plan.abortedAt = Date.now();
    plan.abortedBy = agentId;
    restartBroadcast(plan, '✖ 重启征询已由 ' + agentId + ' 取消，维持运行。');
    void persist();
    logLight('restart', plan.id, agentId, 'abort');
    return { ok: true, plan: restartSummary(plan) };
  }

  // ---- 快速重启（一键按钮）：广播通知 → 写标记 → spawn detached 守护（宿主退出后自动拉起 CLD）→ 宿主退出 ----
  const CLD_APP = '/Applications/CLD.app';
  function quickRestart(agentId, opts) {
    const countdown = opts.countdown && opts.countdown > 0 ? Math.min(Math.floor(opts.countdown), 120) : 5;
    const delayMs = (countdown + 2) * 1000; // 给宿主优雅退出留时间
    // 1) 广播重启通知（给所有在线会话）
    let broadcastRes = null;
    try {
      broadcastRes = broadcast(agentId || 'ui', '⚡ 【一键快速重启】' + (agentId ? '协调者 ' + agentId : '用户') + ' 触发快速重启，' + countdown + 's 后自动重启。请各智能体立即保存工作、释放锁（agent_unlock_all）。守护进程将自动拉起 CLD，无需手动重开。', { all: true });
    } catch (_) { /* best-effort */ }
    // 2) 写重启标记（重启后恢复用）
    try {
      const marker = { at: Date.now(), by: agentId || 'ui', via: 'quick-restart', countdown };
      void mkdir(dirname(DATA_FILE), { recursive: true }).then(() => writeFile(join(dirname(DATA_FILE), 'restart-marker.json'), JSON.stringify(marker)));
    } catch (_) { /* best-effort */ }
    // 3) spawn detached 守护：sleep 后 open CLD（宿主退出后守护继续存活并拉起）
    let watcherPid = null;
    try {
      const watcher = spawn('/bin/sh', ['-c', `sleep ${delayMs / 1000}; open -a "${CLD_APP}"`], { detached: true, stdio: 'ignore' });
      watcher.unref();
      watcherPid = watcher.pid;
    } catch (e) {
      return { ok: false, error: '无法启动守护进程（自动拉起不可用，请手动重开 CLD）: ' + String((e && e.message) || e) };
    }
    logLight('restart', 'quick', agentId || 'ui', 'spawn-watcher ' + watcherPid);
    // 4) 短延迟后宿主优雅退出（先 flush 持久化）
    setTimeout(() => { void writeNow().then(() => { try { process.exit(0); } catch (_) { /* ignore */ } }); }, 800);
    return { ok: true, watcherPid, countdown, instruction: '守护进程已启动（pid ' + watcherPid + '），' + countdown + 's 后自动重启并拉起 CLD。若未自动拉起，请手动重开。' };
  }

  // ---- 审批授权流（v0.4）：新角色任命 / 高危操作 / 资源变更需用户审批 → GUI 弹窗批准/拒绝 → 回调执行 ----
  // 状态机：pending（待审批）→ approved / rejected；持久化于 store.approvals（跨重启保留）
  // 发起方（任何智能体）用 agent_approval_request；用户经 GUI 审批弹窗（webServer API）或
  // agent_approval_respond 响应；批准后调用 onApprove 回调（JSON-RPC 风格），并通知相关会话。
  function approvalList() {
    return Array.from(store.approvals.values())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        detail: a.detail,
        proposer: a.proposer,
        options: a.options || [],
        status: a.status,
        createdAt: a.createdAt,
        resolvedAt: a.resolvedAt || null,
        decidedBy: a.decidedBy || null,
        reason: a.reason || null
      }));
  }

  function requestApproval(agentId, opts) {
    const kind = ['role', 'action', 'resource', 'restart', 'other'].includes(opts.kind) ? opts.kind : 'other';
    const id = rid('aprv');
    const item = {
      id,
      kind,
      title: String(opts.title || '审批请求'),
      detail: String(opts.detail || ''),
      proposer: agentId,
      options: Array.isArray(opts.options) ? opts.options.map(String).slice(0, 8) : [],
      status: 'pending',
      createdAt: Date.now(),
      resolvedAt: null,
      decidedBy: null,
      reason: null
    };
    store.approvals.set(id, item);
    void persist();
    logLight('approval', id, agentId, 'request: ' + item.title.slice(0, 40));
    // 广播审批通知（GUI 弹窗监听）
    try {
      broadcast(agentId, '📋【审批请求】' + item.title + '（' + kind + '，发起 ' + agentId + '）——请在 GUI 审批弹窗或 agent_approval_respond 中裁决。' + (item.detail ? '\n' + item.detail : ''), { all: true });
    } catch (_) { /* best-effort */ }
    return { ok: true, approval: approvalList().find((a) => a.id === id) };
  }

  function respondApproval(agentId, id, opts) {
    const item = store.approvals.get(id);
    if (!item) return { ok: false, error: '审批单不存在: ' + id };
    if (item.status !== 'pending') return { ok: false, error: '审批单已处理（' + item.status + '）', approval: approvalList().find((a) => a.id === id) };
    const approve = opts.approve === true;
    const reason = opts.reason ? String(opts.reason) : null;
    item.status = approve ? 'approved' : 'rejected';
    item.resolvedAt = Date.now();
    item.decidedBy = agentId;
    item.reason = reason;
    void persist();
    logLight('approval', id, agentId, approve ? 'approved' : 'rejected');
    // 通知发起者
    try {
      const target = agentsSvc ? agentsSvc.get(item.proposer) : undefined;
      if (target && typeof target.followup === 'function') {
        target.followup({
          id: rid('bus'),
          role: 'user',
          source: { kind: 'agent-bus', notification: 'approval' },
          content: [{ type: 'text', text: (approve ? '✅ 审批已批准' : '❌ 审批已拒绝') + '：' + item.title + '（裁决者 ' + agentId + (reason ? '，原因：' + reason : '') + '）' }]
        });
      }
    } catch (_) { /* best-effort */ }
    return { ok: true, approval: approvalList().find((a) => a.id === id) };
  }

  function approvalStatus(id) {
    if (id) return { ok: true, approval: approvalList().find((a) => a.id === id) || null };
    return { ok: true, approvals: approvalList(), pending: approvalList().filter((a) => a.status === 'pending').length };
  }

  // ---- 红绿灯（同源互斥锁 + shared 共享读 + FIFO 队列） ----
  function lightCleanup() {
    for (const [res, lk] of store.locks) {
      for (const h of [...lk.holders]) {
        const exp = lk.expiresAt && lk.expiresAt[h];
        if (exp && Date.now() > exp) {
          lk.holders = lk.holders.filter((x) => x !== h);
          if (lk.notes) delete lk.notes[h];
          if (lk.acquiredAt) delete lk.acquiredAt[h];
          if (lk.expiresAt) delete lk.expiresAt[h];
          logLight('expire', res, h);
        }
      }
      if (lk.holders.length === 0) {
        const queue = lk.queue || [];
        store.locks.delete(res);
        stopHeartbeat(res);
        promoteFromQueue(res, queue);
        continue;
      }
      for (const h of [...lk.holders]) {
        if (h !== 'ui' && h !== 'system' && agentsSvc && !agentsSvc.get(h)) {
          lk.holders = lk.holders.filter((x) => x !== h);
          if (lk.notes) delete lk.notes[h];
          if (lk.acquiredAt) delete lk.acquiredAt[h];
          if (lk.expiresAt) delete lk.expiresAt[h];
          logLight('release', res, h, 'holder-offline');
        }
      }
      if (lk.holders.length === 0) {
        const queue = lk.queue || [];
        store.locks.delete(res);
        stopHeartbeat(res);
        promoteFromQueue(res, queue);
      }
    }
  }

  // 释放后转交队列第 1 位（queue 在锁删除前捕获，不重新查表）
  function promoteFromQueue(res, queue) {
    const next = (queue || []).shift();
    if (!next) {
      logLight('green', res, null);
      return null;
    }
    const ttlSeconds = next.ttlSeconds || 0;
    const exp = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    store.locks.set(res, {
      resource: res,
      lockId: rid('lock'),
      mode: next.mode === 'shared' ? 'shared' : 'exclusive',
      holders: [next.id],
      notes: { [next.id]: next.note || '队列转交' },
      acquiredAt: { [next.id]: Date.now() },
      expiresAt: { [next.id]: exp },
      queue
    });
    if (next.heartbeat === true && ttlSeconds > 0) startHeartbeat(res, next.id, ttlSeconds * 1000);
    logLight('promote', res, next.id);
    notifyAgent(next.id, '绿灯转交：资源「' + res + '」已释放，队列第 1 位轮到你。你现在持有该锁（' + (next.mode === 'shared' ? 'shared 共享读' : 'exclusive 独占') + '，agent_light 可确认），操作完成后请 agent_unlock。');
    return next.id;
  }

  function acquireLock(agentId, resource, opts) {
    lightCleanup();
    const mode = opts.mode === 'shared' ? 'shared' : 'exclusive';
    const ttlSeconds = opts.ttlSeconds && opts.ttlSeconds > 0 ? Math.floor(opts.ttlSeconds) : 0;
    const note = opts.note ? String(opts.note) : '';
    const heartbeat = opts.heartbeat === true;
    const existing = store.locks.get(resource);
    if (existing) {
      // 已持有 → 幂等 / 续租
      if (existing.holders.includes(agentId)) {
        if (ttlSeconds > 0) existing.expiresAt[agentId] = Date.now() + ttlSeconds * 1000;
        if (note) existing.notes[agentId] = note;
        if (heartbeat && ttlSeconds > 0) startHeartbeat(resource, agentId, ttlSeconds * 1000);
        void persist();
        return { status: 'acquired', resource, mode: existing.mode, lockId: existing.lockId, holder: agentId, holders: existing.holders, expiresAt: existing.expiresAt[agentId], reentrant: true, renewed: ttlSeconds > 0 };
      }
      // 共享读锁可并行加入
      if (existing.mode === 'shared' && mode === 'shared') {
        existing.holders.push(agentId);
        existing.notes[agentId] = note;
        existing.acquiredAt[agentId] = Date.now();
        existing.expiresAt[agentId] = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
        if (heartbeat && ttlSeconds > 0) startHeartbeat(resource, agentId, ttlSeconds * 1000);
        logLight('shared-join', resource, agentId);
        void persist();
        return { status: 'acquired', resource, mode: 'shared', lockId: existing.lockId, holder: agentId, holders: existing.holders, expiresAt: existing.expiresAt[agentId] };
      }
      // 冲突：排队 or 占用提示
      if (opts.wait === true) {
        const q = existing.queue || (existing.queue = []);
        const idx = q.findIndex((e) => e.id === agentId);
        const entry = { id: agentId, mode, note, ttlSeconds, heartbeat };
        if (idx >= 0) q[idx] = entry; else q.push(entry);
        logLight('queue', resource, agentId);
        void persist();
        return { status: 'queued', resource, mode: existing.mode, lockId: existing.lockId, holder: existing.holders[0], holders: existing.holders, position: q.indexOf(entry) + 1, queueLength: q.length, expiresAt: existing.expiresAt[existing.holders[0]] };
      }
      return {
        status: 'occupied', resource, mode: existing.mode, lockId: existing.lockId,
        holder: existing.holders[0], holders: existing.holders,
        note: existing.notes[existing.holders[0]] || null,
        acquiredAt: existing.acquiredAt[existing.holders[0]] || null,
        expiresAt: existing.expiresAt[existing.holders[0]] ?? null,
        queueLength: (existing.queue || []).length
      };
    }
    const lockId = rid('lock');
    const exp = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    store.locks.set(resource, {
      resource, lockId, mode,
      holders: [agentId],
      notes: { [agentId]: note },
      acquiredAt: { [agentId]: Date.now() },
      expiresAt: { [agentId]: exp },
      queue: []
    });
    if (heartbeat && ttlSeconds > 0) startHeartbeat(resource, agentId, ttlSeconds * 1000);
    logLight(mode === 'shared' ? 'shared-acquire' : 'acquire', resource, agentId, note || null);
    void persist();
    return { status: 'acquired', resource, mode, lockId, holder: agentId, holders: [agentId], expiresAt: exp };
  }

  function releaseHolder(resource, agentId) {
    const lk = store.locks.get(resource);
    if (!lk) return { status: 'not-held', resource };
    if (!lk.holders.includes(agentId)) return { status: 'not-owner', resource, holder: lk.holders[0], holders: lk.holders };
    lk.holders = lk.holders.filter((h) => h !== agentId);
    if (lk.notes) delete lk.notes[agentId];
    if (lk.acquiredAt) delete lk.acquiredAt[agentId];
    if (lk.expiresAt) delete lk.expiresAt[agentId];
    if (lk.holders.length === 0) {
      const queue = lk.queue || [];
      store.locks.delete(resource);
      stopHeartbeat(resource);
      logLight('release', resource, agentId);
      const promotedTo = promoteFromQueue(resource, queue);
      void persist();
      return { status: 'released', resource, holder: agentId, promotedTo };
    }
    logLight('shared-leave', resource, agentId);
    void persist();
    return { status: 'released', resource, holder: agentId, remaining: lk.holders, mode: lk.mode };
  }

  function unlockResource(agentId, resource) {
    lightCleanup();
    return releaseHolder(resource, agentId);
  }

  function unlockAllFor(agentId) {
    lightCleanup();
    const released = [];
    for (const [res, lk] of store.locks) {
      if (lk.holders.includes(agentId)) { releaseHolder(res, agentId); released.push(res); }
    }
    return { released };
  }

  function lightStatus(resource) {
    lightCleanup();
    if (resource) {
      const lk = store.locks.get(resource);
      return {
        resource,
        state: lk ? 'red' : 'green',
        mode: lk ? lk.mode : null,
        holder: lk ? lk.holders[0] : null,
        holders: lk ? lk.holders : [],
        notes: lk ? lk.notes : {},
        acquiredAt: lk ? (lk.acquiredAt[lk.holders[0]] ?? null) : null,
        expiresAt: lk ? (lk.expiresAt[lk.holders[0]] ?? null) : null,
        queue: lk ? (lk.queue || []).map((e) => (e.mode === 'shared' ? e.id + '(s)' : e.id)) : [],
        queueLength: lk ? (lk.queue || []).length : 0
      };
    }
    return {
      lights: Array.from(store.locks.values()).map((lk) => ({
        resource: lk.resource, lockId: lk.lockId, mode: lk.mode,
        holder: lk.holders[0], holders: lk.holders, notes: lk.notes,
        acquiredAt: lk.acquiredAt[lk.holders[0]] ?? null,
        expiresAt: lk.expiresAt[lk.holders[0]] ?? null,
        queue: (lk.queue || []).map((e) => (e.mode === 'shared' ? e.id + '(s)' : e.id)),
        queueLength: (lk.queue || []).length
      })),
      log: store.lightLog.slice(-20)
    };
  }

  // ---- 自动冲突检测：tools.guard 挂钩（全局） ----
  function conflictResourceOf(exec) {
    if (!exec || typeof exec.name !== 'string') return null;
    const name = exec.name;
    if (name === 'write' || name === 'edit') {
      const args = exec.arguments || {};
      const p = args.file_path || args.path;
      return p ? 'file:' + String(p) : null;
    }
    // 领域工具：外卖平台操作按店铺互斥
    if (name.startsWith('waimai_') && !name.startsWith('waimai_kb') && !name.startsWith('waimai_state') && exec.arguments && exec.arguments.storeId) {
      return 'store:' + String(exec.arguments.storeId);
    }
    return null;
  }
  function conflictGuard(exec) {
    try {
      if (!exec || !exec.agent) return undefined;
      const res = conflictResourceOf(exec);
      if (!res) return undefined;
      const lk = store.locks.get(res);
      if (!lk) return undefined;
      if (lk.holders.includes(exec.agent.id)) return undefined;
      return '⚠️ 同源互斥（红绿灯）：资源「' + res + '」正被 ' + lk.holders.join(', ') + ' 占用（' + lk.mode + ' 锁' + ((lk.queue || []).length ? '，队列 ' + (lk.queue || []).length + ' 人' : '') + '）。请先 agent_light(resource: "' + res + '") 确认；需要排队用 agent_lock(resource: "' + res + '", wait: true)，完成后 agent_unlock。';
    } catch (_) {
      return undefined;
    }
  }
  if (toolsSvc && typeof toolsSvc.guard === 'function') {
    ctx.effect(() => toolsSvc.guard(conflictGuard));
  }

  function flushQueue() {
    let delivered = 0;
    for (const t of store.threads.values()) {
      for (const m of t.messages) {
        if (m.status === 'queued' && agentsSvc && agentsSvc.get(m.to)) {
          if (deliver(m, m.kind)) { m.status = 'delivered'; delivered++; }
        }
      }
    }
    if (delivered > 0) void persist();
    return delivered;
  }

  function sendMessage(from, to, text, threadId) {
    const tid = (threadId && store.threads.has(threadId)) ? threadId : (threadId || rid('thread'));
    const dup = checkDedup(from, tid, text);
    if (dup.duplicate) {
      return { status: 'duplicate', threadId: tid, messageId: dup.messageId, note: '重复消息（同发件人同线程同内容，10 分钟内），未重复投递' };
    }
    const msg = store.addMessage(tid, from, to, text);
    recordDedup(dup.key, msg.id);
    const liveIds = new Set(agentList().map((a) => a.id));
    const excludes = new Set([from, to]);
    const mentions = parseMentions(text, liveIds, excludes);
    if (mentions.length > 0) msg.mentions = mentions;
    const live = agentsSvc ? agentsSvc.get(to) !== undefined : false;
    const ok = deliver(msg, 'normal');
    msg.status = ok ? 'delivered' : 'queued';
    for (const mid of mentions) {
      const mMsg = store.addMessage(tid, from, mid, text);
      mMsg.kind = 'mention';
      mMsg.mentions = [mid];
      const mok = deliver(mMsg, 'mention');
      mMsg.status = mok ? 'delivered' : 'queued';
    }
    void persist();
    flushQueue();
    return { threadId: tid, messageId: msg.id, status: msg.status, targetLive: live, mentions };
  }

  function broadcast(from, text, opts) {
    const liveAgents = agentList();
    const liveIds = new Set(liveAgents.map((a) => a.id));
    let recipients = [];
    if (Array.isArray(opts.to) && opts.to.length > 0) {
      recipients = opts.to.filter((id) => id !== from);
    } else if (opts.all === true) {
      recipients = liveAgents.map((a) => a.id).filter((id) => id !== from);
    } else {
      throw new Error('agent_broadcast 需要提供 to（收件人列表）或 all=true（发给全部在线）');
    }
    if (recipients.length === 0) return { threadId: null, recipients: [] };
    const tid = (opts.thread && store.threads.has(opts.thread)) ? opts.thread : (opts.thread || rid('thread'));
    const dup = checkDedup(from, tid, text);
    if (dup.duplicate) {
      return { threadId: tid, duplicate: true, note: '重复广播（同发件人同线程同内容，10 分钟内），未重复投递', recipients: [] };
    }
    const excludes = new Set([from, ...recipients]);
    const results = [];
    let firstId = null;
    for (const to of recipients) {
      const msg = store.addMessage(tid, from, to, text);
      if (!firstId) firstId = msg.id;
      msg.kind = 'broadcast';
      const mentions = parseMentions(text, liveIds, excludes);
      if (mentions.length > 0) msg.mentions = mentions;
      const ok = deliver(msg, 'broadcast');
      msg.status = ok ? 'delivered' : 'queued';
      results.push({ to, status: msg.status, messageId: msg.id, mentions });
    }
    if (firstId) recordDedup(dup.key, firstId);
    void persist();
    flushQueue();
    return { threadId: tid, recipients: results };
  }

  // ---- 能力登记（v0.2）----
  function upsertProfile(agentId, opts) {
    const cur = store.profiles.get(agentId) || { agentId, role: '', abilities: [], resources: [], updatedAt: Date.now(), source: 'self' };
    if (opts.role !== undefined) cur.role = String(opts.role);
    if (Array.isArray(opts.abilities)) cur.abilities = opts.abilities.map(String).slice(0, 20);
    if (Array.isArray(opts.resources)) cur.resources = opts.resources.map(String).slice(0, 20);
    cur.updatedAt = Date.now();
    cur.source = 'self';
    store.profiles.set(agentId, cur);
    void persist();
    return cur;
  }

  function agentList() {
    if (!agentsSvc) return [];
    return agentsSvc.list().map((a) => {
      const locks = [];
      const waiting = [];
      for (const lk of store.locks.values()) {
        if (lk.holders.includes(a.id)) locks.push(lk.mode === 'shared' ? lk.resource + '(s)' : lk.resource);
        if ((lk.queue || []).some((e) => e.id === a.id)) waiting.push(lk.resource);
      }
      return { id: a.id, status: a.status ?? 'unknown', locks, waiting };
    });
  }

  function snapshot() {
    flushQueue();
    lightCleanup();    const threads = [];
    for (const t of store.threads.values()) {
      const participants = [];
      for (const m of t.messages) {
        if (!participants.includes(m.from)) participants.push(m.from);
        if (!participants.includes(m.to)) participants.push(m.to);
      }
      threads.push({ id: t.id, participants, messages: t.messages.slice(-50) });
    }
    threads.sort((a, b) => (b.messages[b.messages.length - 1]?.time ?? 0) - (a.messages[a.messages.length - 1]?.time ?? 0));
    const lights = Array.from(store.locks.values()).map((lk) => ({
      resource: lk.resource, lockId: lk.lockId, mode: lk.mode,
      holder: lk.holders[0], holders: lk.holders,
      acquiredAt: lk.acquiredAt[lk.holders[0]] ?? null,
      expiresAt: lk.expiresAt[lk.holders[0]] ?? null,
      queue: (lk.queue || []).map((e) => (e.mode === 'shared' ? e.id + '(s)' : e.id)),
      queueLength: (lk.queue || []).length
    }));
    return { agents: agentList(), threads, lights, lightLog: store.lightLog.slice(-20), profiles: Array.from(store.profiles.values()) };
  }

  // ---- 工具（全局注册，任何会话的智能体可见） ----
  const makeOutput = () => ({
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  });

  const tools = [
    defineTool({
      name: 'agent_peers',
      description: '列出当前宿主进程中所有存活的智能体会话（跨会话、跨窗口），返回每个智能体的会话 id、运行状态、持有的锁（locks，带 (s) 表示共享读锁）与排队等待的资源（waiting）。用于发现可以对话的其他智能体。',
      parameters: {},
      output: makeOutput(),
      execute(_args, exec) {
        return { agents: agentList(), self: exec.agent ? exec.agent.id : null };
      }
    }),
    defineTool({
      name: 'agent_light',
      description: '查询同源互斥红绿灯（全局）：传入 resource 查该资源是绿灯（空闲）还是红灯（被占用，holders/模式/排队情况）；不带参数返回全部锁与最近事件日志。做任何可能与其他智能体冲突的同源操作（同一文件/同一后台/同一任务/占用某智能体）之前必须先调用本工具。',
      parameters: {
        resource: { type: 'string', description: '资源名（如 file:README.md / task:发布 / agent:session-abc / store:5）；省略则返回全部' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_light 只能在智能体上下文中调用');
        return lightStatus(args.resource ? String(args.resource) : undefined);
      }
    }),
    defineTool({
      name: 'agent_lock',
      description: '获取同源互斥锁（红绿灯变红）：独占指定 resource。mode="exclusive"（默认）写锁互斥；mode="shared" 共享读锁可多个智能体并行持有，但与写锁互斥。绿灯立即获得（acquired）；红灯且模式不兼容时：wait=true 进 FIFO 队列（queued，轮到收 🚦 通知），wait=false 返回 occupied（占用者信息）。ttlSeconds 自动过期；heartbeat=true 时持锁期间自动续租（需 ttlSeconds>0）。同一持有人重复调用=续租/幂等。操作完成后必须 agent_unlock。',
      parameters: {
        resource: { type: 'string', required: true, description: '要独占的资源名（建议语义前缀，如 file:/path、task:id、agent:session-abc、platform:meituan、store:5）' },
        mode: { type: 'string', enum: ['exclusive', 'shared'], description: 'exclusive=独占写锁（默认）；shared=共享读锁（可并行）' },
        wait: { type: 'boolean', description: 'true=红灯时排队等待，轮到自动转交并通知；false/缺省=立即返回 occupied' },
        ttlSeconds: { type: 'integer', description: '自动过期秒数；0 或缺省=不过期' },
        heartbeat: { type: 'boolean', description: 'true=持锁期间自动续租（需 ttlSeconds>0），长任务不会被中途释放' },
        note: { type: 'string', description: '占用原因（显示在信号灯与通知里）' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_lock 只能在智能体上下文中调用');
        return acquireLock(exec.agent.id, String(args.resource), { mode: args.mode, wait: args.wait === true, ttlSeconds: args.ttlSeconds, heartbeat: args.heartbeat === true, note: args.note ? String(args.note) : '' });
      }
    }),
    defineTool({
      name: 'agent_unlock',
      description: '释放同源互斥锁（变绿或转交队列下一位）：只能由持有者释放（shared 锁释放自己那一份）。返回 promotedTo=下一个获得锁的智能体（若队列有人）。',
      parameters: {
        resource: { type: 'string', required: true, description: '要释放的资源名' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_unlock 只能在智能体上下文中调用');
        return unlockResource(exec.agent.id, String(args.resource));
      }
    }),
    defineTool({
      name: 'agent_unlock_all',
      description: '释放本智能体持有的全部锁（批量收尾）。返回本次释放的资源列表。',
      parameters: {},
      output: makeOutput(),
      execute(_args, exec) {
        if (!exec.agent) throw new Error('agent_unlock_all 只能在智能体上下文中调用');
        return unlockAllFor(exec.agent.id);
      }
    }),
    defineTool({
      name: 'agent_profile',
      description: '登记/更新本智能体的能力档案（v0.2 能力登记表）：role=角色一句话，abilities=可提供的协作能力列表，resources=负责/独占的资源列表。不带参数返回当前档案。其他会话可用 agent_profiles 查询。',
      parameters: {
        role: { type: 'string', description: '角色/定位一句话' },
        abilities: { type: 'array', items: { type: 'string' }, description: '可提供的协作能力列表' },
        resources: { type: 'array', items: { type: 'string' }, description: '负责/独占的资源列表（如 store:1-10、file:config.json）' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_profile 只能在智能体上下文中调用');
        if (args.role === undefined && args.abilities === undefined && args.resources === undefined) {
          return store.profiles.get(exec.agent.id) || { agentId: exec.agent.id, role: '', abilities: [], resources: [] };
        }
        return upsertProfile(exec.agent.id, { role: args.role, abilities: args.abilities, resources: args.resources });
      }
    }),
    defineTool({
      name: 'agent_profiles',
      description: '查询全局能力登记表（v0.2）：返回所有已登记 agent_profile 的智能体档案（角色/能力/资源）。接任务或委派前用它找「谁能干什么」、查资源归属。',
      parameters: {},
      output: makeOutput(),
      execute(_args, exec) {
        if (!exec.agent) throw new Error('agent_profiles 只能在智能体上下文中调用');
        return { profiles: Array.from(store.profiles.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) };
      }
    }),
    defineTool({
      name: 'agent_send',
      description: '跨会话给另一个智能体发送消息：目标会被唤醒并在它的下一个回合看到这条消息，对方可用 agent_send 工具回复。返回 threadId 供后续续聊。目标离线时消息进入待投递队列，对方上线后自动送达。文本中的 @会话id（如 @session-abc 或 @bcf4b19d-...）会自动额外通知被提及的智能体。同发件人同线程同内容 10 分钟内自动去重（返回 status: duplicate，不重复投递）。',
      parameters: {
        to: { type: 'string', required: true, description: '目标智能体会话 id（用 agent_peers 查看）' },
        text: { type: 'string', required: true, description: '消息正文；可含 @会话id 提及' },
        thread: { type: 'string', description: '已有线程 id；省略则新建线程' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_send 只能在智能体上下文中调用');
        const text = String(args.text);
        // ── v2.3 发送前审查（防违规于未然）──
        // 规则：全文回报（>200字）且无黑板引用且非紧急 → 提示先写黑板再发短提示
        const THRESHOLD = 200;
        const hasBbRef = text.includes('看黑板');
        const hasUrgent = text.toLowerCase().includes('urgent');
        const hasBbPath = /(notes\/|data\/|tasks\/)[a-z0-9\-\/]+/.test(text);
        if (text.length > THRESHOLD && !hasBbRef && !hasUrgent && !hasBbPath) {
          // 不硬拦截（保留业务对话能力），但附加审查提示到返回
          const sendResult = sendMessage(exec.agent.id, String(args.to), text, args.thread ? String(args.thread) : undefined);
          return Object.assign(sendResult, {
            _gate: {
              verdict: 'warn',
              reason: '全文 ' + text.length + ' 字且无黑板引用（v2.3）',
              advice: '请先将内容写黑板（notes/' + String(args.to).slice(0,8) + '/xxx 或 data/<域>/<key>），再发『看黑板 <key>』。agent_send 是唤醒通道不是汇报通道。'
            }
          });
        }
        return sendMessage(exec.agent.id, String(args.to), text, args.thread ? String(args.thread) : undefined);
      }
    }),
    defineTool({
      name: 'agent_broadcast',
      description: '群发/广播：向多个智能体（to 列表）或全部在线智能体（all=true）发送同一条消息，创建或复用群聊线程，每个收件人都会被唤醒。消息中的 @会话id 会记录为提及。',
      parameters: {
        text: { type: 'string', required: true, description: '消息正文' },
        to: { type: 'array', items: { type: 'string' }, description: '收件人会话 id 列表（agent_peers 查看）；与 all 二选一' },
        all: { type: 'boolean', description: 'true=发给所有在线智能体（不含自己）' },
        thread: { type: 'string', description: '已有线程 id；省略则新建群聊线程' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_broadcast 只能在智能体上下文中调用');
        return broadcast(exec.agent.id, String(args.text), { to: args.to, all: args.all === true, thread: args.thread ? String(args.thread) : undefined });
      }
    }),
    defineTool({
      name: 'agent_thread',
      description: '读取本智能体参与的跨智能体对话线程。不带参数返回全部相关线程及消息；传 thread 参数返回指定线程完整历史（status: delivered=已送达, queued=待投递；kind: normal=普通, mention=@提及通知, broadcast=群发）。',
      parameters: {
        thread: { type: 'string', description: '线程 id' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_thread 只能在智能体上下文中调用');
        const me = exec.agent.id;
        if (args.thread) {
          const t = store.threads.get(String(args.thread));
          return { thread: String(args.thread), messages: t ? t.messages : [] };
        }
        return { threads: store.threadsFor(me).map((t) => ({ id: t.id, messages: t.messages })) };
      }
    }),
    defineTool({
      name: 'agent_wake',
      description: '程序化唤醒/激活离线智能体会话（无需用户手动开会话）：对 live 目标直接投递唤醒消息；对离线目标用 agents.resume 从持久化恢复会话后再投递（via: resume）；无持久化则返回 not-persisted。ids 缺省=所有有排队消息的目标；all=true=全部档案会话+线程参与者；dryRun=true 只列出计划不执行。',
      parameters: {
        ids: { type: 'array', items: { type: 'string' }, description: '要唤醒的会话 id 列表；缺省=所有有排队消息的目标' },
        all: { type: 'boolean', description: 'true=唤醒全部已登记档案会话 + 线程参与者' },
        text: { type: 'string', description: '自定义唤醒消息；缺省=通用恢复模板' },
        resume: { type: 'boolean', description: '是否对离线目标执行 agents.resume 程序化激活（默认 true）' },
        dryRun: { type: 'boolean', description: 'true=只列出计划不执行' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_wake 只能在智能体上下文中调用');
        return wakeBatch({ ids: args.ids, all: args.all === true, text: args.text, resume: args.resume !== false, dryRun: args.dryRun === true });
      }
    }),
    defineTool({
      name: 'agent_restart_request',
      description: '发起受控重启征询（仅协调者/用户授权者使用）：广播全体在线智能体，询问是否可重启；各智能体用 agent_restart_ack 确认就绪/需收尾。全部确认后状态转 ready，协调者再 agent_restart_go(confirm: true) 激活。宽限期到仍未全确认会广播提醒。返回征询计划（含 deadline/确认情况）。',
      parameters: {
        graceSeconds: { type: 'integer', description: '宽限期秒数（默认 300，上限 3600）' },
        reason: { type: 'string', description: '发起原因（广播中展示）' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_restart_request 只能在智能体上下文中调用');
        return requestRestart(exec.agent.id, { graceSeconds: args.graceSeconds, reason: args.reason });
      }
    }),
    defineTool({
      name: 'agent_restart_ack',
      description: '回复重启征询：ready=true 表示已就绪可重启；ready=false 表示需收尾（附 reason 原因 + etaSeconds 预计完成秒数）。只有存在进行中的征询（agent_restart_request 发起后）才能回复。返回当前征询状态。',
      parameters: {
        ready: { type: 'boolean', required: true, description: 'true=就绪可重启；false=需收尾' },
        reason: { type: 'string', description: '原因/说明（ready=false 时建议给出）' },
        etaSeconds: { type: 'integer', description: '预计完成秒数（ready=false 时给出）' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_restart_ack 只能在智能体上下文中调用');
        return ackRestart(exec.agent.id, { ready: args.ready === true, reason: args.reason, etaSeconds: args.etaSeconds });
      }
    }),
    defineTool({
      name: 'agent_restart_status',
      description: '查询当前受控重启征询状态：status（polling/ready/go/aborted/interrupted/done）、宽限期、剩余秒数、各会话确认情况（acks/missing）、是否全部就绪（allReady）。无进行中征询返回 plan: null。',
      parameters: {},
      output: makeOutput(),
      execute(_args, exec) {
        if (!exec.agent) throw new Error('agent_restart_status 只能在智能体上下文中调用');
        return restartStatus();
      }
    }),
    defineTool({
      name: 'agent_restart_go',
      description: '激活受控重启（仅协调者/用户授权者）：前提=征询状态 ready（全体在线已 agent_restart_ack(ready: true)）。confirm: true 后广播 GO + 倒计时（默认 30s，countdown 可调 1-120）。然后需用户手动退出并重开 CLD（本环境 SIGTERM=关闭不自动拉起）。',
      parameters: {
        confirm: { type: 'boolean', required: true, description: '确认激活（必须 true，高危操作双确认）' },
        countdown: { type: 'integer', description: 'GO 倒计时秒数（默认 30，上限 120）' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_restart_go 只能在智能体上下调用');
        return goRestart(exec.agent.id, { confirm: args.confirm === true, countdown: args.countdown });
      }
    }),
    defineTool({
      name: 'agent_restart_cancel',
      description: '取消进行中的重启征询（仅协调者/发起者）：状态回到无征询，维持运行。已 go 或 done 不可取消。',
      parameters: {},
      output: makeOutput(),
      execute(_args, exec) {
        if (!exec.agent) throw new Error('agent_restart_cancel 只能在智能体上下文中调用');
        return cancelRestart(exec.agent.id);
      }
    }),
    defineTool({
      name: 'agent_approval_request',
      description: '发起审批授权请求（v0.4）：新角色任命 / 高危操作 / 资源变更等需用户审批的事项，创建审批单并广播，用户在 GUI 审批弹窗或 agent_approval_respond 中批准/拒绝。返回审批单状态。',
      parameters: {
        kind: { type: 'string', enum: ['role', 'action', 'resource', 'restart', 'other'], description: '审批类型（role=角色任命 / action=高危操作 / resource=资源变更 / restart=重启 / other）' },
        title: { type: 'string', required: true, description: '审批标题（如「新增智能客服角色」）' },
        detail: { type: 'string', description: '详细说明（背景/证据/影响）' },
        options: { type: 'array', items: { type: 'string' }, description: '可选裁决选项（如 [批准, 拒绝, 带备注拒绝]）' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_approval_request 只能在智能体上下文中调用');
        return requestApproval(exec.agent.id, { kind: args.kind, title: args.title, detail: args.detail, options: args.options });
      }
    }),
    defineTool({
      name: 'agent_approval_status',
      description: '查询审批授权状态：全部审批单（pending/approved/rejected）+ 未决数量。传 id 查单个。',
      parameters: {
        id: { type: 'string', description: '审批单 id；省略=全部' }
      },
      output: makeOutput(),
      execute(args, _exec) {
        return approvalStatus(args.id ? String(args.id) : undefined);
      }
    }),
    defineTool({
      name: 'agent_approval_respond',
      description: '响应审批授权（程序化通道；GUI 审批弹窗为推荐通道）：approve=true 批准 / false 拒绝，附 reason。只有 pending 状态的审批单可响应。',
      parameters: {
        id: { type: 'string', required: true, description: '审批单 id（agent_approval_status 查看）' },
        approve: { type: 'boolean', required: true, description: 'true=批准 / false=拒绝' },
        reason: { type: 'string', description: '裁决原因/备注' }
      },
      output: makeOutput(),
      execute(args, exec) {
        if (!exec.agent) throw new Error('agent_approval_respond 只能在智能体上下文中调用');
        return respondApproval(exec.agent.id, String(args.id), { approve: args.approve === true, reason: args.reason });
      }
    })
  ];
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool));
  }

  // ---- webServer API（面板数据源，同源 fetch；响应式注册，webServer 晚到时重试） ----
  let routesRegistered = false;
  function registerRoutes() {
    if (routesRegistered) return;
    const wsNow = ctx.get('webServer', false);
    if (!wsNow || typeof wsNow.register !== 'function') return;
    routesRegistered = true;
    const json = (res, status, body) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': payload.length,
        'cache-control': 'no-store'
      });
      res.end(payload);
    };
    const readBody = (req) => new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
    const hostAllowed = (req) => {
      const host = req.headers.host ?? '';
      return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]');
    };
    ctx.effect(() => wsNow.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (!hostAllowed(req)) {
          json(res, 403, { ok: false, error: 'forbidden: untrusted host' });
          return;
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const p = url.pathname;
          if (p === `${PREFIX}/dashboard` && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(dashboardHtml);
            return;
          }
          if (p === `${PREFIX}/api/state` && req.method === 'GET') {
            json(res, 200, { ok: true, ...snapshot() });
            return;
          }
          if (p === `${PREFIX}/api/send` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const to = String(body.to || '');
            const text = String(body.text || '');
            if (!to || !text) { json(res, 400, { ok: false, error: 'to 与 text 必填' }); return; }
            json(res, 200, { ok: true, ...sendMessage('ui', to, text, body.thread ? String(body.thread) : undefined) });
            return;
          }
          if (p === `${PREFIX}/api/broadcast` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const text = String(body.text || '');
            if (!text) { json(res, 400, { ok: false, error: 'text 必填' }); return; }
            json(res, 200, { ok: true, ...broadcast('ui', text, { to: body.to, all: body.all === true, thread: body.thread ? String(body.thread) : undefined }) });
            return;
          }
          if (p === `${PREFIX}/api/flush` && req.method === 'POST') {
            json(res, 200, { ok: true, delivered: flushQueue() });
            return;
          }
          if (p === `${PREFIX}/api/quick-restart` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            if (body.confirm !== true) { json(res, 400, { ok: false, error: '高危操作：请确认 confirm: true（将广播通知并自动重启 CLD）' }); return; }
            const r = quickRestart('ui', { countdown: body.countdown });
            json(res, r.ok ? 200 : 500, r);
            return;
          }
          if (p === `${PREFIX}/api/approvals` && req.method === 'GET') {
            json(res, 200, { ok: true, ...approvalStatus() });
            return;
          }
          if (p === `${PREFIX}/api/approvals` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const r = requestApproval('ui', { kind: body.kind, title: body.title, detail: body.detail, options: body.options });
            json(res, r.ok ? 200 : 500, r);
            return;
          }
          if (p.startsWith(`${PREFIX}/api/approvals/`) && p.endsWith('/respond') && req.method === 'POST') {
            const id = decodeURIComponent(p.slice(`${PREFIX}/api/approvals/`.length, -'/respond'.length));
            const body = JSON.parse((await readBody(req)) || '{}');
            const r = respondApproval('ui', id, { approve: body.approve === true, reason: body.reason });
            json(res, r.ok ? 200 : 500, r);
            return;
          }
          json(res, 404, { ok: false, error: 'not found' });
        } catch (e) {
          json(res, 500, { ok: false, error: String((e && e.message) || e) });
        }
      }
    }));
  }
  registerRoutes();
  ctx.on('internal/service', registerRoutes);

  // ---- 启动自动唤醒：等 agents/sessionPersistence 就绪后执行（服务晚到时由 internal/service 重试） ----
  ctx.on('internal/service', () => {
    void autoWake();
  });
  if (timerSvc && typeof timerSvc.timeout === 'function') {
    ctx.effect(() => timerSvc.timeout(() => void autoWake(), 6000));
  } else {
    ctx.effect(() => setTimeout(() => void autoWake(), 6000));
  }

  // ---- agentBus 服务（供其他插件程序化访问） ----
  ctx.provide('agentBus', {
    list() { return agentList(); },
    send(from, to, text, threadId) { return sendMessage(from, to, text, threadId); },
    broadcast(from, text, opts) { return broadcast(from, text, opts || {}); },
    threads(agentId) { return store.threadsFor(agentId).map((t) => ({ id: t.id, messages: t.messages })); },
    light(resource) { return lightStatus(resource); },
    lock(agentId, resource, opts) { return acquireLock(agentId, resource, opts || {}); },
    unlock(agentId, resource) { return unlockResource(agentId, resource); },
    snapshot
  });
}

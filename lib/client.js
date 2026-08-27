// dsh-plugin-agent-bus —— 客户端（web 平台，__ModuleLoader__ 格式）
// 入口：① 侧边栏「🧠 Agent Bus」 ② 会话输入行 🧠 按钮 ③ 设置页「Agent Bus」
// 面板：图形化霓虹风格（暗色 + 发光 + 卡片 + Spark + 拓扑感）
// 结构：单一 DrawerPortal（sidebar 入口持有唯一 portal），store 驱动开关
window.__ModuleLoader__.load({
  id: "dsh-plugin-agent-bus",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const reactMod = require("react");
    const React = reactMod && reactMod.__esModule ? reactMod.default : reactMod;
    const reactDomMod = require("react-dom");
    const createPortal = reactDomMod && reactDomMod.createPortal ? reactDomMod.createPortal : reactDomMod.default?.createPortal;

    // ---- 共享状态（唯一 store：open + listeners） ----
    var store = (() => {
      let open = false;
      const listeners = new Set();
      const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
      const getSnapshot = () => open;
      const set = (v) => { if (open !== v) { open = v; for (const fn of listeners) fn(); } };
      return { subscribe, getSnapshot, toggle: () => set(!open), open: () => set(true), close: () => set(false) };
    })();

    // ---- CSS（暗色霓虹 · 图形化面板，与大屏同语言） ----
    var CSS_ID = 'agent-bus-css';
    var cssInjected = false;
    var CSS = `
      .ab-side-entry { background: transparent; border: none; cursor: pointer; font-size: 15px; line-height: 1; padding: 4px 6px; border-radius: 6px; color: inherit; }
      .ab-side-entry:hover { background: rgba(255,255,255,.1); }
      .ab-side-active { color: #22d3ee; text-shadow: 0 0 8px rgba(34,211,238,.6); }
      .ab-composer-entry { background: transparent; border: none; cursor: pointer; font-size: 15px; line-height: 1; padding: 4px; border-radius: 6px; color: inherit; }
      .ab-composer-entry:hover { background: rgba(255,255,255,.1); }
      .ab-overlay { position: fixed; inset: 0; z-index: 99999; background: rgba(2,8,20,.55); backdrop-filter: blur(2px); display: flex; justify-content: flex-end; }
      .ab-drawer { width: min(540px, 94vw); height: 100%; background: #050a16; color: #d7e6ff; display: flex; flex-direction: column; box-shadow: -12px 0 48px rgba(0,0,0,.65); font-size: 12px; line-height: 1.5; border-left: 1px solid rgba(64,200,255,.18); font-family: "SF Mono","Menlo","JetBrains Mono",monospace; position: relative; }
      .ab-drawer::before { content:""; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,#22d3ee,transparent); opacity:.8; }
      .ab-head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid rgba(64,200,255,.18); background: rgba(14,165,233,.05); flex-shrink: 0; }
      .ab-head .ab-pulse { width: 8px; height: 8px; border-radius: 50%; background: #34d399; box-shadow: 0 0 10px #34d399; animation: abBlink 2.2s ease-in-out infinite; }
      @keyframes abBlink { 0%,100%{opacity:1} 50%{opacity:.35} }
      .ab-head h3 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: 2px; color: #22d3ee; text-shadow: 0 0 12px rgba(34,211,238,.6); flex: 1; }
      .ab-head .ab-sub { font-size: 10px; color: #5b7ba6; letter-spacing: 1px; }
      .ab-close { background: transparent; border: none; cursor: pointer; font-size: 16px; line-height: 1; color: #d7e6ff; opacity: .7; padding: 2px 8px; border-radius: 6px; }
      .ab-close:hover { opacity: 1; background: rgba(255,255,255,.1); }
      .ab-body { flex: 1; overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; scrollbar-width: thin; scrollbar-color: rgba(34,211,238,.3) transparent; }
      .ab-panel { background: rgba(13,27,52,.72); border: 1px solid rgba(64,200,255,.18); border-radius: 10px; padding: 10px 12px; position: relative; box-shadow: 0 0 18px rgba(14,165,233,.05) inset; }
      .ab-panel::before { content:""; position:absolute; top:0; left:12px; right:12px; height:1px; background:linear-gradient(90deg,transparent,#22d3ee,transparent); opacity:.6; }
      .ab-ph { display:flex; align-items:center; gap:6px; font-size:11px; letter-spacing:1px; color:#22d3ee; margin-bottom:8px; }
      .ab-ph .dot { width:6px; height:6px; border-radius:50%; background:#34d399; box-shadow:0 0 6px #34d399; }
      .ab-stats { display:flex; gap:8px; }
      .ab-stat { flex:1; text-align:center; padding:8px 4px; background:rgba(255,255,255,.02); border:1px solid rgba(64,200,255,.12); border-radius:8px; }
      .ab-stat b { font-size:22px; font-weight:600; display:block; color:#fff; }
      .ab-stat span { font-size:10px; color:#5b7ba6; }
      .ab-stat b.c{color:#22d3ee} .ab-stat b.g{color:#34d399} .ab-stat b.a{color:#fbbf24} .ab-stat b.r{color:#f87171}
      .ab-chips { display:flex; flex-wrap:wrap; gap:6px; }
      .ab-badge { padding:2px 9px; border-radius:999px; font-size:10px; white-space:nowrap; border:1px solid transparent; }
      .ab-live { background:rgba(34,197,94,.15); color:#34d399; border-color:rgba(34,197,94,.3); }
      .ab-idle { background:rgba(148,163,184,.1); color:#94a3b8; border-color:rgba(148,163,184,.2); }
      .ab-busy { background:rgba(250,204,21,.12); color:#fbbf24; border-color:rgba(250,204,21,.3); }
      .ab-spark { display:flex; align-items:flex-end; gap:3px; height:44px; margin:6px 0 2px; }
      .ab-spark i { width:9px; background:linear-gradient(180deg,#22d3ee,#0ea5e9); border-radius:2px; opacity:.85; }
      .ab-kpi-row { display:flex; justify-content:space-between; padding:3px 2px; border-bottom:1px dashed rgba(64,200,255,.12); font-size:11px; }
      .ab-kpi-row span:first-child{color:#5b7ba6} .ab-kpi-row b{color:#fff}
      .ab-thread { border:1px solid rgba(64,200,255,.14); border-radius:8px; padding:6px 9px; cursor:pointer; margin-bottom:6px; background:rgba(255,255,255,.02); }
      .ab-thread:hover { border-color:rgba(34,211,238,.4); }
      .ab-thread-id { color:#22d3ee; font-size:10px; letter-spacing:.5px; }
      .ab-thread-prev { color:#5b7ba6; font-size:11px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ab-msg { border-left:2px solid rgba(34,211,238,.4); padding:2px 8px; margin:4px 0; white-space:pre-wrap; word-break:break-word; cursor:default; font-size:11px; }
      .ab-msg-mention { border-left-color: rgba(251,191,36,.6); }
      .ab-send { display:flex; flex-direction:column; gap:6px; }
      .ab-input, .ab-textarea { background:rgba(0,0,0,.4); border:1px solid rgba(64,200,255,.25); border-radius:6px; color:#d7e6ff; padding:5px 9px; font-size:12px; font-family:inherit; outline:none; }
      .ab-input:focus, .ab-textarea:focus { border-color:#22d3ee; box-shadow:0 0 8px rgba(34,211,238,.2); }
      .ab-btn { background:#0ea5e9; border:none; border-radius:6px; color:#fff; padding:4px 12px; cursor:pointer; font-size:12px; }
      .ab-btn:hover { background:#0284c7; }
      .ab-btn-ghost { background:rgba(255,255,255,.1); }
      .ab-btn:disabled { opacity:.5; cursor:default; }
      .ab-notice { font-size:11px; color:#fbbf24; }
      .ab-muted { font-size:10px; opacity:.6; color:#5b7ba6; }
      .ab-restart { border:1px solid rgba(239,68,68,.4); border-radius:10px; padding:11px 13px; background:rgba(239,68,68,.06); }
      .ab-restart-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .ab-restart-title { font-size:12px; font-weight:600; color:#f87171; letter-spacing:1px; }
      .ab-restart-desc { font-size:10px; opacity:.7; margin-top:2px; color:#d7e6ff; }
      .ab-restart-actions { display:flex; align-items:center; gap:8px; margin-top:9px; }
      .ab-btn-danger { background:#ef4444; border:none; border-radius:6px; color:#fff; padding:5px 14px; cursor:pointer; font-size:12px; }
      .ab-btn-danger:hover { background:#dc2626; box-shadow:0 0 12px rgba(239,68,68,.4); }
      .ab-btn-danger:disabled { opacity:.5; cursor:default; }
      .ab-btn-cancel { background:transparent; border:1px solid rgba(255,255,255,.25); border-radius:6px; color:#d7e6ff; padding:5px 14px; cursor:pointer; font-size:12px; }
      .ab-btn-cancel:hover { background:rgba(255,255,255,.08); }
      .ab-restart-warn { font-size:11px; color:#fbbf24; margin-top:6px; }
    `;
    function ensureCss() {
      if (cssInjected || typeof document === 'undefined') return;
      cssInjected = true;
      if (!document.getElementById(CSS_ID)) {
        const tag = document.createElement('style');
        tag.id = CSS_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
    }

    // ---- API ----
    async function api(path, init) {
      const res = await fetch(path, init);
      return res.json();
    }
    function loadState(setSnap) {
      api('/agent-bus/api/state', { cache: 'no-store' }).then((s) => {
        if (s && s.ok) setSnap(s);
      }).catch(() => setSnap(null));
    }

    const h = React.createElement;

    function useQuickRestart() {
      const [confirming, setConfirming] = React.useState(false);
      const [sending, setSending] = React.useState(false);
      const [warn, setWarn] = React.useState('');
      const start = () => { setConfirming(true); setWarn(''); };
      const cancel = () => { setConfirming(false); setWarn(''); };
      const go = () => {
        setSending(true); setWarn('');
        store.close();
        fetch('/agent-bus/api/quick-restart', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: true, countdown: 5 })
        }).then((r) => r.json()).then((res) => {
          if (res && res.ok) setWarn('⚡ 重启已触发：' + (res.countdown || 5) + 's 后自动重启并拉起 CLD。');
          else { setWarn('重启触发失败: ' + ((res && res.error) || '未知错误')); setSending(false); setConfirming(false); }
        }).catch((e) => { setWarn('重启触发失败: ' + String(e)); setSending(false); setConfirming(false); });
      };
      return { confirming, sending, warn, start, cancel, go };
    }

    function RestartZone() {
      const r = useQuickRestart();
      if (!r.confirming) {
        return h('div', { className: 'ab-restart' },
          h('div', { className: 'ab-restart-head' },
            h('div', null,
              h('div', { className: 'ab-restart-title' }, '⚡ 快速重启 CLD'),
              h('div', { className: 'ab-restart-desc' }, '广播通知 → 自动重启并拉起（无需手动重开）')),
            h('button', { className: 'ab-btn-danger', onClick: r.start }, '重启')),
          r.warn ? h('div', { className: 'ab-restart-warn' }, r.warn) : null);
      }
      return h('div', { className: 'ab-restart' },
        h('div', { className: 'ab-restart-title' }, '确认重启？'),
        h('div', { className: 'ab-restart-desc' }, '将广播通知所有在线智能体，约 5 秒后自动重启 CLD 并拉起。所有会话短暂中断后自动恢复。'),
        h('div', { className: 'ab-restart-actions' },
          h('button', { className: 'ab-btn-danger', disabled: r.sending, onClick: r.go }, r.sending ? '重启中…' : '确认重启'),
          h('button', { className: 'ab-btn-cancel', disabled: r.sending, onClick: r.cancel }, '取消')),
        r.warn ? h('div', { className: 'ab-restart-warn' }, r.warn) : null);
    }

    function BusContent() {
      const [snap, setSnap] = React.useState(null);
      const [expanded, setExpanded] = React.useState(null);
      const [target, setTarget] = React.useState('');
      const [text, setText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');

      const refresh = () => loadState(setSnap);
      React.useEffect(() => { refresh(); const iv = setInterval(refresh, 4000); return () => clearInterval(iv); }, []);

      const doSend = (all) => {
        if (!text.trim()) { setNotice('请填写消息内容'); return; }
        if (!all && !target) { setNotice('请选择目标智能体，或点「群发全部」'); return; }
        setBusy(true);
        const p = all
          ? api('/agent-bus/api/broadcast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, all: true }) })
          : api('/agent-bus/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: target, text }) });
        p.then((r) => {
          setBusy(false);
          if (r && r.ok) {
            setNotice(all ? ('群发完成 → ' + ((r.recipients && r.recipients.length) || 0) + ' 个智能体') : ('已投递 → ' + target));
            setText(''); refresh();
          } else setNotice('发送失败: ' + ((r && r.error) || '未知错误'));
        }).catch((e) => { setBusy(false); setNotice('发送失败: ' + String(e)); });
      };

      const agents = snap && snap.agents ? snap.agents : [];
      const threads = snap && snap.threads ? snap.threads : [];
      const lights = snap && snap.lights ? snap.lights : [];
      const lightLog = snap && snap.lightLog ? snap.lightLog : [];
      const running = agents.filter((a) => a.status === 'running').length;
      const locked = agents.filter((a) => (a.locks || []).length > 0).length;
      const queued = agents.filter((a) => (a.waiting || []).length > 0).length;
      const sparkHeights = [3, 5, 4, 7, 6, 9, 8, 12, 10, 14];

      const chips = agents.map((a) => {
        const held = (a.locks || []).length > 0;
        const waiting = (a.waiting || []).length > 0;
        const cls = a.status === 'running' ? 'ab-live' : (held || waiting) ? 'ab-busy' : 'ab-idle';
        const mark = a.status === 'running' ? '●' : held ? '🔒' : waiting ? '⏳' : '○';
        return h('span', { key: a.id, className: 'ab-badge ' + cls, title: (held ? '持有: ' + a.locks.join(',') + ' ' : '') + (waiting ? '排队: ' + a.waiting.join(',') : '') },
          mark + ' ' + a.id);
      });
      const options = agents.map((a) => h('option', { key: a.id, value: a.id }, a.id));
      const lightViews = lights.map((l) =>
        h('div', { key: l.resource, className: 'ab-thread' },
          h('div', null, h('b', { style: { color: '#f87171' } }, '🔴 ' + l.resource), ' · ' + l.holder + (l.note ? ' (' + l.note + ')' : '')),
          h('div', { className: 'ab-muted' }, '等待: ' + (l.queue && l.queue.length ? l.queue.join(', ') : '空'))));
      const logViews = (lightLog || []).map((e) =>
        h('div', { key: e.time + '-' + e.resource + '-' + (e.holder || ''), className: 'ab-msg' },
          h('span', { className: 'ab-muted' }, new Date(e.time).toLocaleTimeString()), ' ', e.kind, ' ', e.resource));
      const threadViews = threads.map((t) => {
        const open = expanded === t.id;
        const last = t.messages[t.messages.length - 1];
        const preview = last ? (last.from + ' → ' + last.to + ': ' + (last.text.length > 44 ? last.text.slice(0, 44) + '…' : last.text)) : '';
        const msgs = open ? t.messages.map((m) => {
          const isMention = m.kind === 'mention';
          const tag = isMention ? '📣提及 ' : (m.kind === 'broadcast' ? '📢广播 ' : '');
          return h('div', { key: m.id, className: 'ab-msg' + (isMention ? ' ab-msg-mention' : '') },
            h('div', null, h('b', null, m.from + ' → ' + m.to), ' ', tag,
              h('span', { className: 'ab-muted' }, m.status === 'queued' ? '⏳ 待投递' : '✓ 已送达')),
            h('div', null, m.text));
        }) : null;
        return h('div', { key: t.id, className: 'ab-thread', onClick: () => setExpanded(open ? null : t.id) },
          h('div', { className: 'ab-thread-id' }, '💬 ' + t.id),
          h('div', { className: 'ab-thread-prev' }, preview),
          msgs);
      });

      return [
        h('div', { key: 'stats', className: 'ab-panel' },
          h('div', { className: 'ab-ph' }, h('span', { className: 'dot' }), '实时态势'),
          h('div', { className: 'ab-stats' },
            h('div', { className: 'ab-stat' }, h('b', { className: 'c' }, String(agents.length)), h('span', null, '在线会话')),
            h('div', { className: 'ab-stat' }, h('b', { className: 'g' }, String(running)), h('span', null, '运行中')),
            h('div', { className: 'ab-stat' }, h('b', { className: 'a' }, String(locked)), h('span', null, '持锁')),
            h('div', { className: 'ab-stat' }, h('b', { className: 'r' }, String(queued)), h('span', null, '排队')))),
        h('div', { key: 'spark', className: 'ab-panel' },
          h('div', { className: 'ab-ph' }, h('span', { className: 'dot' }), '消息吞吐 · 近 10 轮'),
          h('div', { className: 'ab-spark' }, sparkHeights.map((v, i) => h('i', { key: i, style: { height: v + 'px' } }))),
          h('div', { className: 'ab-kpi-row' }, h('span', null, '线程数'), h('b', null, String(threads.length)))),
        h('div', { key: 'agents', className: 'ab-panel' },
          h('div', { className: 'ab-ph' }, h('span', { className: 'dot' }), '在线智能体'),
          h('div', { className: 'ab-chips' }, chips.length ? chips : h('span', { className: 'ab-muted' }, '暂无在线'))),
        h('div', { key: 'lights', className: 'ab-panel' },
          h('div', { className: 'ab-ph' }, h('span', { className: 'dot' }), '🚦 信号灯 · 同源互斥'),
          lightViews.length ? lightViews : h('div', { className: 'ab-muted' }, '全部绿灯，无占用'),
          logViews.length ? h('div', { style: { marginTop: 6 } }, logViews) : null),
        h('div', { key: 'threads', className: 'ab-panel' },
          h('div', { className: 'ab-ph' }, h('span', { className: 'dot' }), '对话线程'),
          threadViews.length ? threadViews : h('div', { className: 'ab-muted' }, '暂无线程')),
        h('div', { key: 'send', className: 'ab-panel' },
          h('div', { className: 'ab-ph' }, h('span', { className: 'dot' }), '发送消息'),
          h('div', { className: 'ab-send' },
            h('select', { className: 'ab-input', value: target, onChange: (e) => setTarget(e.target.value) },
              h('option', { value: '' }, '选择目标…'), options),
            h('textarea', { className: 'ab-textarea', rows: 3, value: text, placeholder: '消息内容…（@会话id 提及）', onChange: (e) => setText(e.target.value) }),
            h('div', { className: 'ab-row', style: { display: 'flex', gap: 8 } },
              h('button', { className: 'ab-btn', disabled: busy, onClick: () => doSend(false) }, busy ? '发送中…' : '发送'),
              h('button', { className: 'ab-btn ab-btn-ghost', disabled: busy, onClick: () => doSend(true) }, busy ? '…' : '📢 群发全部')))),
        notice ? h('div', { key: 'notice', className: 'ab-notice' }, notice) : null
      ];
    }

    // ---- 审批授权弹窗（v0.4）：轮询未决审批单 → 右下角弹窗 → 批准/拒绝回调 ----
    function ApprovalToast() {
      const [pending, setPending] = React.useState([]);
      const [handling, setHandling] = React.useState(null);
      React.useEffect(() => {
        const poll = () => {
          api('/agent-bus/api/approvals', { cache: 'no-store' }).then((r) => {
            if (r && r.ok && Array.isArray(r.approvals)) {
              setPending(r.approvals.filter((a) => a.status === 'pending').slice(0, 3));
            }
          }).catch(() => { /* silent */ });
        };
        poll();
        const iv = setInterval(poll, 5000);
        return () => clearInterval(iv);
      }, []);
      const decide = (a, approve) => {
        setHandling(a.id);
        api(`/agent-bus/api/approvals/${encodeURIComponent(a.id)}/respond`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approve, reason: approve ? 'GUI 审批通过' : 'GUI 拒绝' })
        }).then(() => {
          setPending((p) => p.filter((x) => x.id !== a.id));
          setHandling(null);
        }).catch(() => setHandling(null));
      };
      if (pending.length === 0) return null;
      return h('div', { style: { position: 'fixed', bottom: 20, right: 20, zIndex: 999999, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 360 } },
        pending.map((a) => h('div', { key: a.id, style: { background: '#0b1428', border: '1px solid rgba(34,211,238,.4)', borderRadius: 12, padding: 12, boxShadow: '0 8px 32px rgba(0,0,0,.6)', fontFamily: '"SF Mono","Menlo",monospace', fontSize: 12, color: '#d7e6ff' } },
          h('div', { style: { fontSize: 11, color: '#22d3ee', letterSpacing: 1, marginBottom: 6 } }, '📋 审批请求 · ' + (a.kind || 'other')),
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, a.title),
          a.detail ? h('div', { style: { fontSize: 11, opacity: .75, marginBottom: 8, whiteSpace: 'pre-wrap' } }, a.detail.slice(0, 300)) : null,
          h('div', { style: { fontSize: 10, opacity: .6, marginBottom: 8 } }, '发起：' + (a.proposer || 'ui') + ' · ' + new Date(a.createdAt).toLocaleTimeString()),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { disabled: handling === a.id, onClick: () => decide(a, true), style: { flex: 1, background: '#10b981', border: 'none', borderRadius: 6, color: '#fff', padding: '6px 10px', cursor: 'pointer', fontSize: 12 } }, handling === a.id ? '处理中…' : '✅ 批准'),
            h('button', { disabled: handling === a.id, onClick: () => decide(a, false), style: { flex: 1, background: '#ef4444', border: 'none', borderRadius: 6, color: '#fff', padding: '6px 10px', cursor: 'pointer', fontSize: 12 } }, '❌ 拒绝')))));
    }

    // ---- 抽屉 ----
    function BusDrawer() {
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') store.close(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);
      return h('div', { className: 'ab-overlay', onClick: (e) => { if (e.target === e.currentTarget) store.close(); } },
        h('div', { className: 'ab-drawer', role: 'dialog', 'aria-label': 'Agent Bus 跨智能体总线', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'ab-head' },
            h('span', { className: 'ab-pulse' }),
            h('h3', null, 'AGENT BUS'),
            h('span', { className: 'ab-sub' }, '跨智能体实时态势'),
            h('button', { className: 'ab-close', onClick: store.close, title: '关闭 (Esc)' }, '✕')),
          h('div', { className: 'ab-body' },
            h(BusContent, null),
            h(RestartZone, { key: 'restart' }))));
    }

    // ---- 抽屉 portal（唯一渲染点：sidebar 入口持有）----
    function DrawerPortal() {
      const open = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      if (!open || typeof document === 'undefined' || !createPortal) return null;
      return createPortal(h(BusDrawer), document.body);
    }

    // ---- 入口组件 ----
    function SidebarEntry() {
      const open = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('button', { className: 'ab-side-entry' + (open ? ' ab-side-active' : ''), onClick: store.toggle, title: 'Agent Bus 跨智能体总线' }, '🧠'),
        h(DrawerPortal, null),
        h(ApprovalToast, null));
    }

    function ComposerEntry() {
      return h('span', { style: { display: 'inline-flex' } },
        h('button', { className: 'ab-composer-entry', onClick: store.open, title: 'Agent Bus 跨智能体总线（发送/群发/查看线程）' }, '🧠'));
    }

    // ---- 设置页 ----
    function BusSettingsPage({ close }) {
      ensureCss();
      return h('div', { style: { padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12, lineHeight: 1.5 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('b', null, '🧠 Agent Bus 跨智能体总线'),
          h('span', { className: 'ab-muted' }, '宿主级常驻 · 线程持久化于 ~/.dsh/agent-bus.json'),
          h('button', { className: 'ab-btn ab-btn-ghost', onClick: close }, '关闭')),
        h(BusContent, null),
        h(RestartZone, { key: 'restart-settings' }));
    }

    // ---- 注册 ----
    var inject = ['slots'];
    function apply(ctx) {
      console.info('[agent-bus] client loaded (portal-drawer v4)');
      ensureCss();
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'agent-bus',
        order: 20,
        label: () => 'Agent Bus'
      }, SidebarEntry)));
      ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'agent-bus',
        order: 30,
        label: 'Agent Bus'
      }, ComposerEntry)));
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'agent-bus',
        order: 30,
        label: 'Agent Bus'
      }, BusSettingsPage)));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});

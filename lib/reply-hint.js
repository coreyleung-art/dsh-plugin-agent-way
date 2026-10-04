// lib/reply-hint.js — 跨机回复卡键提示（纯函数，index.js 与 selfcheck.js 共用，无循环依赖）
// ★ 1.5.12（MBP 逐行核 2026-10-03）：绝不产出 notes/session-* 死前缀。
// ★ 1.5.15（MBP 六形态实测 2026-10-04）：1.5.12 只堵住 session-* 形态，任意短标签（ui/unknown-thing）
//   仍被当节点拼成 notes/<标签>/ 死前缀（G13 家族：「修了一个形态」≠「修了这一类」）。
//   修法（MBP 白名单方案）：只有真实存在黑板监听者的节点才拼 notes/<node>/，其余一律通用指引。
// 判据（可自证）：
//   session-abc…  → null（通用指引，不拼 session 前缀）
//   bus:mac-mini  → mac-mini
//   mac-mini/mbp/i9（真实节点，含别名 macmini/mbp-bus）→ 节点名
//   ui / unknown-thing / 任意未登记标签 → null（通用指引，绝不拼死前缀）
export const REPLY_NODE_ALIASES = ['mac-mini', 'macmini', 'mbp', 'mbp-bus', 'i9'];

export function peerNodeHint(from) {
  const f = String(from || '').trim();
  if (f.startsWith('bus:')) {
    const node = f.slice(4).trim().toLowerCase();
    // 1.5.15：bus 别名同样过白名单（bus:ui ⇒ null，不拼 notes/ui/）
    return REPLY_NODE_ALIASES.includes(node) ? node : null;
  }
  if (/^session-/.test(f)) return null;      // 会话 id 无法推出节点名——绝不拼 session-id 键
  const lower = f.toLowerCase();
  if (REPLY_NODE_ALIASES.includes(lower)) return lower;   // 1.5.15：仅真实节点
  return null;   // 1.5.15：任意其它标签 → 通用指引（防死前缀）
}

export function replyCardHint(from) {
  const node = peerNodeHint(from);
  return node
    ? '— 跨机回复请写黑板卡 notes/' + node + '/ 键（agent_send 跨机不通，会静默过期）'
    : '— 跨机回复请写黑板卡 notes/<对端节点>/ 键（如 notes/mbp/、notes/i9/；不要写 notes/session-*/ 或未登记标签前缀——无人监听）';
}

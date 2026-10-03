// lib/reply-hint.js — 跨机回复卡键提示（纯函数，index.js 与 selfcheck.js 共用，无循环依赖）
// ★ 1.5.12（MBP 逐行核 2026-10-03）：绝不产出 notes/session-* 死前缀。
//   判据（可自证）：session-abc… → null（通用指引）；bus:mac-mini → mac-mini。
export function peerNodeHint(from) {
  const f = String(from || '');
  if (f.startsWith('bus:')) {
    const node = f.slice(4).trim();
    return node || null;
  }
  if (/^session-/.test(f)) return null;      // 会话 id 无法推出节点名——绝不拼 session-id 键
  if (f && /^[a-z][a-z0-9-]{0,15}$/i.test(f)) return f;   // 合法节点别名形态
  return null;
}

export function replyCardHint(from) {
  const node = peerNodeHint(from);
  return node
    ? '— 跨机回复请写黑板卡 notes/' + node + '/ 键（agent_send 跨机不通，会静默过期）'
    : '— 跨机回复请写黑板卡 notes/<对端节点>/ 键（如 notes/mbp/、notes/i9/；不要写 notes/session-*/ 前缀——无人监听）';
}

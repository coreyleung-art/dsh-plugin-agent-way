// selfcheck.js — 插件自查门 v1.0（R014：插件依赖完整性自查基础设施）
// 作用：插件 apply() 最前执行，检查自身依赖完整性（peerDeps/ESM 匹配/关键导入/符号）
//       缺模块 → 写黑板告警（data/ops/plugin-selfcheck/<plugin>-<ts>）+ 文件日志
//       → 返回 { ok, missing[], warnings[] } 供插件决定是否继续
// 目标：缺模块在加载前暴露，而非等崩溃/被外部 restart-guard 发现
//
// 用法（插件 apply 开头）：
//   import { runSelfCheck } from './selfcheck.js';
//   const sc = runSelfCheck('<plugin-name>', {
//     requiredPeers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'],
//     requiredSymbols: ['join', 'homedir', 'fs'],   // 顶层必须导入的符号
//     allowRequire: false,                          // type:module 下禁止裸 require
//   });
//   if (!sc.ok) { /* 依赖缺失，写告警 + 决定是否继续 */ }

import { writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
// ★ 2026-10-01 修复（ESM 死码）：本模块是 ESM，而原实现用 `typeof require === 'function'`
//   与 `typeof __filename !== 'undefined'` 做守卫 —— **两者在 ESM 下恒为 undefined**
//   ⇒ ① peerDeps 探测 与 ② 关键符号检查 **双双被跳过**，只剩 ③ type:module，
//   然后打印 `✅ 自查通过`。实测负例控制：传入绝不可能存在的符号，missing 仍为 []。
//   ⇒ 生产中的 R014 自查门是一个**空转绿灯**（正是 R006 坑表「空集通过」）。
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadIdentityVariants, variantsToIds, normalizeIdentity } from '../../dsh-comm-shared/identity.js';
import { peerNodeHint } from './reply-hint.js';

// ─── A6 第 4 层断言（2026-10-02）────────────────────────────────────────
// 变体表双向可核（0 分裂）+ 裸标签解析到规范 id；失败 = A6 守卫修复未生效
export function checkIdentityVariants() {
  try {
    const splits = [...loadIdentityVariants().entries()].filter(([, id]) => id === null);
    const base = variantsToIds('星桥');
    const ok = splits.length === 0 && base.length === 1
      && base[0] === 'session-fa1f9150-c949-401f-ba8c-d265f6221676';
    return { ok, splitVariants: splits.length, resolved: base,
      note: ok ? '变体表 0 分裂且裸标签解析正确（A6 第 4 层就绪）' : 'A6 第 4 层断言失败' };
  } catch (e) {
    return { ok: false, splitVariants: -1, resolved: [], note: '异常: ' + e.message };
  }
}

// ─── normalizeIdentity 决策表断言（2026-10-03 系统性收口）───────────────
// 12 例矩阵覆盖决策表全部 8 条路径：完整 id / 短 id / 裸 UUID / 含 id 展示名 /
// bus 别名 / 设备别名 / 变体表 / 纯角色标签匿名 + 空串 + 匿名形态幂等。
// 失败 = 单一决策点被改坏（身份判定口径漂移）→ 阻止部署。
export function checkNormalizeIdentity() {
  try {
    const cases = [
      ['session-20b800d4-98f6-4e5e-90e4-34f7b6ca61d7', 'session-20b800d4-98f6-4e5e-90e4-34f7b6ca61d7'],  // 1 完整 id
      ['session-20b800d4', 'session-20b800d4'],                                                          // 2 短 id
      ['20b800d4-98f6-4e5e-90e4-34f7b6ca61d7', 'session-20b800d4-98f6-4e5e-90e4-34f7b6ca61d7'],          // 3 裸 UUID
      ['老登 session-aa528267 (mac-mini)', 'session-aa528267'],                                           // 4 含 id 展示名
      ['bus:mbp', null],                                                                                   // 5 bus 别名
      ['mbp', null],                                                                                       // 6a 设备别名
      ['coordinator', null],                                                                               // 6b 设备别名
      ['星桥', 'session-fa1f9150-c949-401f-ba8c-d265f6221676'],                                           // 7 变体表
      ['明鉴', 'session-a190c54c-ca73-4845-9a65-9dc002d45044'],                                           // 7 变体表
      ['cld-monitor', null],                                                                               // 8 纯角色标签 → 匿名
      ['mbp-ops', null],                                                                                   // 8 纯角色标签 → 匿名
      ['', null],                                                                                          // 空串
    ];
    const fails = [];
    for (const [inp, want] of cases) {
      const got = normalizeIdentity(inp);
      if (got.id !== want) fails.push(JSON.stringify(inp) + ' → id=' + got.id + ' (期望 ' + want + ')');
    }
    if (normalizeIdentity('cld-monitor').display !== 'unattributed(cld-monitor)') fails.push('纯角色标签 display 可读性断言失败');
    if (normalizeIdentity('unattributed').display !== 'unattributed') fails.push('遗留匿名形态幂等断言失败');
    if (normalizeIdentity('unattributed(x)').display !== 'unattributed(x)') fails.push('匿名形态幂等断言失败（二次包裹）');
    return {
      ok: fails.length === 0,
      fails,
      note: fails.length === 0 ? '决策表 12 例 + 3 显示断言全过（身份判定单一决策点）' : '决策表断言失败: ' + fails.join('; ')
    };
  } catch (e) {
    return { ok: false, fails: ['异常: ' + e.message], note: '异常: ' + e.message };
  }
}

const HOME = homedir();
const SELFCHECK_DIR = join(HOME, '.dsh', 'plugin-selfcheck');
const BB_URL = process.env.DSH_BB_URL || 'http://127.0.0.1:8792';
const LOG_FILE = join(SELFCHECK_DIR, 'selfcheck.log');

/**
 * 提取源码全部顶层 import 符号（named / default / namespace 三形态）。
 * ★ 2026-10-03 修复：原扫描只匹配 `import { SYM` 开头形式，
 *   多符号 import（如 `import { readFile, writeFile } from ...`）的非首位符号
 *   以及 default/namespace import 全部漏检 ⇒ 改正则整体提取后集合判断。
 */
export function extractImportedSymbols(src) {
  const out = new Set();
  const re = /import\s*(?:\{([^}]*)\}|\*\s*as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))\s*from/gs;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) out.add(name);
      }
    }
    if (m[2]) out.add(m[2]);
    if (m[3]) out.add(m[3]);
  }
  return out;
}

function log(msg) {
  try {
    mkdirSync(SELFCHECK_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, { flag: 'a' });
  } catch (e) { /* 日志失败不阻塞 */ }
}

function putBlackboard(key, value) {
  try {
    if (typeof fetch !== 'function') return;
    fetch(`${BB_URL}/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    }).catch(() => {});
  } catch (e) { /* 黑板不可用不阻塞 */ }
}

/**
 * 依赖完整性自查
 * @param {string} pluginName 插件名
 * @param {object} opts 检查选项
 * @returns {{ok: boolean, missing: string[], warnings: string[]}}
 */
export function runSelfCheck(pluginName, opts = {}) {
  const { requiredPeers = [], requiredSymbols = [], allowRequire = false } = opts;
  const missing = [];
  const warnings = [];
  const resolved = [];   // ★ 修复后新增：peer 的实际解析路径（用于暴露「遮蔽 runtime」= M1 根因）

  // ① peerDependencies 可解析性（探测）
  // 修复：ESM 下没有全局 require ⇒ 原实现恒走 else 分支、直接跳过。
  // 改用 createRequire(import.meta.url) 得到**以本文件为基准**的解析器。
  // 附带价值：解析结果可暴露「插件 node_modules 里遮蔽了 runtime 包」（M1 版本遮蔽根因）。
  const req = (() => {
    if (typeof require === 'function') return require;      // CJS 环境
    try { return createRequire(import.meta.url); } catch (e) { return null; }
  })();
  if (req === null) {
    warnings.push('无法构造 require（既无全局 require 也建不出 createRequire）——peerDeps 探测跳过');
  } else {
    for (const peer of requiredPeers) {
      try {
        const resolvedPath = req.resolve(peer);
        resolved.push(`${peer} → ${resolvedPath}`);
      } catch (e) {
        missing.push(`peer:${peer}`);
        warnings.push(`依赖 ${peer} 不可解析（node_modules 缺失或符号链接断）`);
      }
    }
  }

  // ② 关键符号导入完整性（当前文件顶层 import 扫描）
  if (requiredSymbols.length > 0) {
    try {
      // ★ 2026-10-01 修复：原用 `typeof __filename !== 'undefined'` 守卫 + readFileSync(__filename)
      //   —— ESM 下 __filename 不存在 ⇒ 整段被跳过（实测负例控制证实为死码）。
      //   改用 fileURLToPath(import.meta.url)。语义与原意一致：扫描**本文件**的顶层 import。
      //   ⚠️ 已知局限（未改）：扫描对象是 selfcheck.js 自身，**不是调用方** index.js
      //   ⇒ 它能验证"本模块的符号"，却无法验证"调用方的符号"。如需验证调用方，
      //     由调用方传 opts.sourceFile（见下）。
      const srcPath = opts.sourceFile ? String(opts.sourceFile) : fileURLToPath(import.meta.url);
      const src = readFileSync(srcPath, 'utf8');
      const imported = extractImportedSymbols(src);
      for (const sym of requiredSymbols) {
        if (!imported.has(sym)) {
          missing.push(`symbol:${sym}`);
          warnings.push(`符号 ${sym} 未在 ${srcPath} 顶层导入（ESM 下裸调用 → ReferenceError）`);
        }
      }
    } catch (e) { /* 读自身失败跳过 */ }
  }

  // ③ type:module 匹配（本文件所在包）
  try {
    const pkgPath = new URL('../package.json', import.meta.url).pathname;
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const isEsm = pkg.type === 'module';
      const hasExport = requiredSymbols.length > 0; // 有 requiredSymbols 说明用 ESM
      if (hasExport && !isEsm) {
        warnings.push(`package.json 缺 type:module（ESM 语法按 CJS 解析 → SyntaxError）`);
      }
    }
  } catch (e) { /* 包解析失败跳过 */ }

  const ok = missing.length === 0;
  // 结果落盘 + 黑板告警（非阻断，仅标记）
  const ts = Date.now();
  const result = { plugin: pluginName, ok, missing, warnings, resolved, ts };
  try {
    mkdirSync(SELFCHECK_DIR, { recursive: true });
    writeFileSync(join(SELFCHECK_DIR, `${pluginName}.json`), JSON.stringify(result, null, 2));
  } catch (e) { /* 落盘失败不阻塞 */ }
  if (!ok) {
    log(`❌ ${pluginName} 自查失败: ${missing.join(', ')}`);
    putBlackboard(`data/ops/plugin-selfcheck/${pluginName}-${ts}`, result);
  } else {
    log(`✅ ${pluginName} 自查通过`);
  }
  return result;
}

/**
 * ★ 1.5.12（MBP 判据建议落门）：跨机回复卡键提示不得产出 notes/session-* 死前缀。
 *   两例「应该判失败」的输入：session-abc…（跨机会话 id）与 bus:mac-mini（合法别名）。
 */
export function checkReplyHint() {
  try {
    const sessionCase = peerNodeHint('session-abc12345-0000-0000-0000-000000000000');
    const busCase = peerNodeHint('bus:mac-mini');
    // ★ 1.5.15（MBP 六形态实测）：判据必须覆盖同类其它形态——任意未登记标签不得拼死前缀
    const uiCase = peerNodeHint('ui');
    const unknownCase = peerNodeHint('unknown-thing');
    const nodeCase = peerNodeHint('mbp');
    const busUiCase = peerNodeHint('bus:ui');
    const ok = sessionCase === null && busCase === 'mac-mini' && nodeCase === 'mbp'
      && uiCase === null && unknownCase === null && busUiCase === null;
    return { ok, note: ok ? '回复卡键提示：session-id/未知标签 → 通用指引、bus:别名/真实节点 → 节点名（无死前缀）'
                          : '回复卡键提示断言失败: session=' + JSON.stringify(sessionCase) + ' bus=' + JSON.stringify(busCase)
                            + ' ui=' + JSON.stringify(uiCase) + ' unknown=' + JSON.stringify(unknownCase)
                            + ' busUi=' + JSON.stringify(busUiCase) };
  } catch (e) {
    return { ok: false, note: '异常: ' + e.message };
  }
}

// 1.5.13 投递守护判据：deliver 失败出声 + idle 主动 flush + agentBus.flush 暴露（MBP 2026-10-04 根因 ①②③）
export function checkDeliveryGuard() {
  try {
    const src = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf-8');
    const failVisible = src.includes("msg.lastError = String(") && src.includes("logLight('deliverFail'");
    const flushExposed = /flush\s*\(\)\s*\{\s*return\s*flushQueue\(\s*\);\s*\}/.test(src);
    // idle 处理器必须调用 flushQueue：截取 ctx.on('agent/status' 块再断言（防止误中其他 4 处调用点）
    const i0 = src.indexOf("ctx.on('agent/status'");
    let idleFlush = false;
    if (i0 >= 0) {
      const block = src.slice(i0, i0 + 1400);
      idleFlush = block.includes('st !== \'idle\'') && block.includes('flushQueue()');
    }
    const ok = failVisible && flushExposed && idleFlush;
    return { ok, note: ok ? '投递守护：deliver 失败出声 + idle 主动 flush + agentBus.flush 暴露'
                          : '投递守护断言失败: failVisible=' + failVisible + ' flushExposed=' + flushExposed + ' idleFlush=' + idleFlush };
  } catch (e) {
    return { ok: false, note: '异常: ' + e.message };
  }
}

// 1.5.14 P0 判据（MBP 决定性根因）：`export {X} from './y.js'` 是再导出、不建本地绑定 ⇒
// 本文件若调用 X( 而无真 import {X} ⇒ ReferenceError 被静默 catch 吞 ⇒ 投递全挂（16h 实测）。
// 另扫「静默 catch 残留」：catch{return false} 且无 lastError 记档 ⇒ 兄弟路径仍在吞异常。
export function checkReexportAndSilentCatch() {
  try {
    const src = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf-8');
    const bad = [];
    const reexport = new Set();
    for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*from/g)) {
      for (const name of m[1].split(',')) {
        const n = name.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) reexport.add(n);
      }
    }
    const importNames = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
      for (const name of m[1].split(',')) {
        const n = name.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) importNames.add(n);
      }
    }
    for (const n of reexport) {
      if (!importNames.has(n) && new RegExp('\\b' + n + '\\s*\\(').test(src)) {
        bad.push('再导出当本地用: ' + n + '( 被调用但无 import 绑定');
      }
    }
    for (const m of src.matchAll(/catch\s*\(\s*_?\s*\)\s*\{\s*return\s+false\s*;?\s*\}/g)) {
      bad.push('静默 catch 残留: ' + m[0].slice(0, 40));
    }
    const ok = bad.length === 0;
    return { ok, note: ok ? '再导出当本地用=0 · 静默 catch 残留=0'
                          : bad.slice(0, 4).join(' | ') };
  } catch (e) {
    return { ok: false, note: '异常: ' + e.message };
  }
}

// ─── 真挂载 apply 冒烟（CLI/CI 专用，子进程隔离）────────────────────────
// ★ 2026-10-03 对齐 central-inbox 0.2.10 教训（冒烟递归链事故）：
//   1) 冒烟绝不放在 runSelfCheck 内（runSelfCheck 被 apply 调用，冒烟再调 apply ⇒ 无限递归）
//   2) 子进程隔离 HOME：agent-way apply 会 load() 真实 ~/.dsh/agent-bus.json 并可能
//      flushQueue → 对 NODE_ALIASES 目标调 deliverViaBlackboard（真实双板写）⇒ 冒烟必须
//      在临时 HOME 下跑（store 空、零投递），杜绝冒烟触发真实消息外发。
//   3) 断网面：DSH_BB_URL 指向不可达端口，防 adapt/selfcheck 告警写板。
let _smokeInFlight = false;

/**
 * 真挂载冒烟：子进程（临时 HOME + 断网面）import index.js + apply(stubCtx) 三态判定
 * @returns {Promise<{state: 'pass'|'fail'|'skipped', detail: string}>}
 */
export async function runApplySmoke(opts = {}) {
  if (_smokeInFlight) {
    return { state: 'skipped', detail: '防重入守卫：已有冒烟在跑，跳过本次' };
  }
  _smokeInFlight = true;
  try {
    const tmpHome = mkdtempSync(join(tmpdir(), 'aw-smoke-'));
    const indexUrl = pathToFileURL(fileURLToPath(new URL('./index.js', import.meta.url))).href;
    const childCode = `
      const noop = new Proxy(function () {}, { get: () => noop, apply: () => undefined });
      // ★ 1.5.16 行为层投递探针（MBP sandbox-agent-way 同层判据采纳）：
      //   真 apply + 真 agentBus.send → 断言 status=delivered（判据与故障同层，P11）。
      let followupCalled = false;
      const fakeTarget = { id: 'session-aaaa1111-2222-4333-8444-555566667777', followup() { followupCalled = true; }, inject() {} };
      const services = {
        agents: {
          get: (id) => (id === 'session-aaaa1111-2222-4333-8444-555566667777' ? fakeTarget : undefined),
          list: () => [{ id: 'session-aaaa1111-2222-4333-8444-555566667777', status: 'idle' }],
          resume: async () => ({ agent: fakeTarget }),
          register: () => undefined,
        },
        agentDefaultModel: { currentSelection: () => ({ provider: 't', model: 't' }) },
        settings: { get: () => undefined },
        sessionPersistence: { list: async () => [{ id: 'session-aaaa1111-2222-4333-8444-555566667777' }] },
        agentPresets: { mount: async () => undefined },
      };
      let providedAgentBus = null;
      const stubCtx = new Proxy({ effect: () => undefined, on: () => undefined, provide: (name, svc) => { if (name === 'agentBus') providedAgentBus = svc; } }, {
        get: (t, k) => (k === 'get' ? (name, required) => (services[name] !== undefined ? services[name] : (required ? noop : undefined)) : (k in t ? t[k] : noop)),
      });
      const mod = await import(${JSON.stringify(indexUrl)});
      mod.apply(stubCtx, {});
      console.log('SMOKE_OK');
      if (providedAgentBus && typeof providedAgentBus.send === 'function') {
        const r = providedAgentBus.send('session-bbbb2222-1111-4333-8444-555566667777', 'session-aaaa1111-2222-4333-8444-555566667777', 'delivery-probe');
        console.log('DELIVERY_PROBE status=' + (r && r.status ? r.status : String(r)) + ' followup=' + followupCalled);
        try {
          const ths = providedAgentBus.threads ? providedAgentBus.threads('session-aaaa1111-2222-4333-8444-555566667777') : [];
          if (ths && ths.length) {
            const last = ths[ths.length - 1].messages[ths[ths.length - 1].messages.length - 1];
            console.log('DELIVERY_PROBE lastError=' + (last && last.lastError ? last.lastError : '(none)'));
          }
        } catch (e) { console.log('DELIVERY_PROBE lastError=(threads err)'); }
      }
      process.exit(0);
    `;
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, HOME: tmpHome, DSH_BB_URL: 'http://127.0.0.1:1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ } }, 15000);
      child.on('close', (code) => { clearTimeout(killTimer); resolve({ code, out, err }); });
    });
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch (_) { /* 清理失败不阻塞 */ }
    const joined = result.out + result.err;
    // ★ 1.5.16：投递探针同属冒烟判定 —— SMOKE_OK 且 DELIVERY_PROBE status=delivered 才算 pass
    const probeOk = /DELIVERY_PROBE status=delivered followup=true/.test(result.out);
    if (result.code === 0 && result.out.includes('SMOKE_OK') && probeOk) {
      return { state: 'pass', detail: 'apply(stub·隔离HOME·断网面) 正常返回 + 行为层投递探针 delivered' };
    }
    if (result.code === 0 && result.out.includes('SMOKE_OK') && !probeOk) {
      return { state: 'fail', detail: '投递探针未达 delivered: ' + (result.out.match(/DELIVERY_PROBE[^\\n]*/) || ['(无输出)'])[0].slice(0, 120) };
    }
    if (/ERR_MODULE_NOT_FOUND|Cannot find/.test(joined)) {
      return { state: 'skipped', detail: '依赖缺失: ' + joined.slice(0, 80) };
    }
    return { state: 'fail', detail: 'apply 异常(exit ' + result.code + '): ' + joined.slice(-160).replace(/\n/g, ' ') };
  } catch (e) {
    return { state: 'fail', detail: '冒烟编排异常: ' + String((e && e.message) || e).slice(0, 100) };
  } finally {
    _smokeInFlight = false;
  }
}
// ⚠️ 为什么必须有：本模块原先**只导出 runSelfCheck、无 CLI 入口** ⇒
//    `node lib/selfcheck.js` 会**静默退出 0**、零输出，外观与「通过」完全无异。
//    2026-10-01 实测：agent-way 的 selfcheck.js 与 central-inbox 的 selftest.js
//    都处于该状态（两个自检模块都无法从命令行运行）。这是「空集通过」坑的又一实例。
const _isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isCli) {
  const _name = process.argv[2] || 'unknown';
  const _peers = process.argv.slice(3);
  const _r = runSelfCheck(_name, {
    requiredPeers: _peers,
    requiredSymbols: ['join', 'homedir', 'existsSync', 'readFileSync', 'dirname', 'spawn', 'readFile', 'writeFile', 'mkdir', 'defineTool', 'http'],
    sourceFile: fileURLToPath(new URL('./index.js', import.meta.url)),
  });
  const _v = checkIdentityVariants();
  const _n = checkNormalizeIdentity();
  const _h = checkReplyHint();
  const _d = checkDeliveryGuard();
  const _r2 = checkReexportAndSilentCatch();
  const _s = await runApplySmoke();
  console.log('');
  console.log('  selfcheck: ' + _name + ' → ' + (_r.ok ? 'PASS' : 'FAIL'));
  if (_r.resolved.length) for (const x of _r.resolved) console.log('    peer  ' + x);
  if (_r.missing.length) console.log('    missing: ' + _r.missing.join(', '));
  for (const w of _r.warnings) console.log('    warn   : ' + w);
  console.log('  A6-variants: ' + (_v.ok ? 'PASS' : 'FAIL') + ' · ' + _v.note);
  console.log('  identity-table: ' + (_n.ok ? 'PASS' : 'FAIL') + ' · ' + _n.note);
  console.log('  reply-hint: ' + (_h.ok ? 'PASS' : 'FAIL') + ' · ' + _h.note);
  console.log('  delivery-guard: ' + (_d.ok ? 'PASS' : 'FAIL') + ' · ' + _d.note);
  console.log('  reexport-silentcatch: ' + (_r2.ok ? 'PASS' : 'FAIL') + ' · ' + _r2.note);
  console.log('  [' + _s.state + '] 真挂载冒烟 — ' + _s.detail);
  console.log('');
  process.exit(_r.ok && _v.ok && _n.ok && _h.ok && _d.ok && _r2.ok && _s.state !== 'fail' ? 0 : 1);
}

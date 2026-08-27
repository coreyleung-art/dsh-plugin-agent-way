// dsh-plugin-agent-way · 版本自适应层（adapt.js）
// 目标：宿主 dsh rc 版本更新时，插件【主动检测 + 自动适配】，而非等崩溃/等人工。
// 原理：
//   ① 指纹采集：启动时读宿主关键包版本（dsh/dsh-tools/dsh-agent/dsh-session/dsh-llm/cordis）→ hash
//   ② 基线存储：~/.dsh/plugin-adapt/dsh-plugin-agent-way.json
//   ③ 定期检测（timer）：重读指纹 → 变化 = 宿主 rc 升级 →
//        - API 能力探测（按能力选实现，不按版本号猜）
//        - 告警黑板（notes/collab/plugin-adapt-alert）
//        - 记录自适应事件（~/.dsh/plugin-adapt/adapt-log.jsonl）
// 能力探测优先于版本判断：版本号会变，能力存在性最可靠。
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const HOME = homedir();
const ADAPT_DIR = join(HOME, '.dsh', 'plugin-adapt');
const STATE_FILE = join(ADAPT_DIR, 'dsh-plugin-agent-way.json');
const LOG_FILE = join(ADAPT_DIR, 'adapt-log.jsonl');

// 参与指纹的关键包（宿主 rc 版本变化的主要影响面）
const KEY_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/cordis',
];

// 宿主 node_modules 锚点探测：
//  1. 环境变量 DSH_RUNTIME_NODE_MODULES（显式指定）
//  2. CLD 常见路径（mac/win/linux）
//  3. 从插件自身位置向上推导（import.meta.url → 插件在 profile/node_modules → 向上找）
const HOST_NM_CANDIDATES = [
  process.env.DSH_RUNTIME_NODE_MODULES,
  '/Applications/CLD.app/Contents/Resources/dsh-runtime/runtime/node_modules',
  'C:\\Program Files\\CLD\\resources\\dsh-runtime\\runtime\\node_modules',
  'E:\\Program Files\\CLD\\resources\\dsh-runtime\\runtime\\node_modules',
];
// 插件位于 <profile>/node_modules/dsh-plugin-agent-way/lib/adapt.js → 宿主 = 插件父级向上
// 但 CLD runtime 与 profile 不同路径，插件实际在 profile node_modules（link 到源码目录）。
// 最可靠：显式锚点 + CLD 常见路径。

/** 找到宿主 node_modules（存在即返回） */
function findHostNodeModules() {
  for (const c of HOST_NM_CANDIDATES) {
    if (c && typeof c === 'string') return c;
  }
  return null;
}

/** 读宿主包版本（文件直读，不依赖 require 解析链） */
function readHostVersion(pkg) {
  try {
    const nm = findHostNodeModules();
    if (nm) {
      const raw = readFileSync(join(nm, pkg, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version) return parsed.version;
    }
  } catch { /* 路径不对则回退 require */ }
  try {
    const v = req(`${pkg}/package.json`).version;
    return v || '?';
  } catch {
    return null; // 解析不到 = 宿主无此包（异常）
  }
}

/** 采集宿主指纹 */
export function collectFingerprint() {
  const versions = {};
  let missing = 0;
  for (const p of KEY_PACKAGES) {
    const v = readHostVersion(p);
    if (v === null) { missing++; versions[p] = 'MISSING'; }
    else versions[p] = v;
  }
  // 指纹 = 版本串联（稳定 hash 便于比较）
  const raw = KEY_PACKAGES.map((p) => `${p}@${versions[p]}`).join('|');
  return { versions, fingerprint: raw, missing, ts: Date.now() };
}

/** 能力探测（比版本号更可靠的自适应依据） */
export function probeCapabilities(ctx) {
  return {
    agents: typeof ctx.get('agents', false) !== 'undefined' ? 'present' : 'absent',
    followup: (() => {
      try {
        const agents = ctx.get('agents', false);
        return agents && typeof agents.get === 'function' ? 'present' : 'absent';
      } catch { return 'absent'; }
    })(),
    webServer: typeof ctx.get('webServer', false) !== 'undefined' ? 'present' : 'absent',
    timer: typeof ctx.get('timer', false) !== 'undefined' ? 'present' : 'absent',
    systemPrompt: typeof ctx.get('systemPrompt', false) !== 'undefined' ? 'present' : 'absent',
  };
}

/** 加载基线 */
async function loadBaseline() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch { return null; }
}

/** 追加日志 */
async function logEvent(evt) {
  try {
    await mkdir(ADAPT_DIR, { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify(evt) + '\n');
  } catch { /* 日志失败不影响功能 */ }
}

/** 自适应检查（返回 { changed, before, after, alert } 或 null=无变化/首次） */
export async function adaptCheck(ctx) {
  const fp = collectFingerprint();
  const caps = probeCapabilities(ctx);
  const prev = await loadBaseline();

  await mkdir(ADAPT_DIR, { recursive: true });

  if (!prev || !prev.fingerprint) {
    // 首次：记录基线
    const baseline = { fingerprint: fp.fingerprint, versions: fp.versions, caps, firstSeen: Date.now() };
    await writeFile(STATE_FILE, JSON.stringify(baseline, null, 1));
    await logEvent({ type: 'baseline', ts: Date.now(), versions: fp.versions });
    return null;
  }

  if (prev.fingerprint === fp.fingerprint) {
    return null; // 无变化
  }

  // 宿主 rc 版本变化！生成自适应报告
  const changed = {};
  for (const p of KEY_PACKAGES) {
    if (prev.versions[p] !== fp.versions[p]) changed[p] = `${prev.versions[p]} → ${fp.versions[p]}`;
  }
  // 能力变化检测
  const capChanged = {};
  for (const k of Object.keys(caps)) {
    if (prev.caps && prev.caps[k] !== caps[k]) capChanged[k] = `${prev.caps?.[k]} → ${caps[k]}`;
  }

  // 更新基线（记住新状态）
  const newBase = { fingerprint: fp.fingerprint, versions: fp.versions, caps, lastChange: Date.now() };
  await writeFile(STATE_FILE, JSON.stringify(newBase, null, 1));
  await logEvent({ type: 'change', ts: Date.now(), changed, capChanged, versions: fp.versions });

  return { changed, capChanged, versions: fp.versions };
}

/**
 * 启动自适应守护（在插件 apply 中调用）：
 *  - 立即检测一次（首次记录基线；变化则告警）
 *  - timer 定期重检（宿主 rc 升级后自动发现）
 */
export function startAdaptGuard(ctx, timerSvc, notifyFn) {
  const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 每 6 小时（兼顾及时与开销）

  async function run() {
    try {
      const result = await adaptCheck(ctx);
      if (result && result.changed && Object.keys(result.changed).length > 0) {
        const detail = Object.entries(result.changed).map(([p, v]) => `${p}: ${v}`).join('; ');
        const capDetail = Object.entries(result.capChanged || {}).map(([k, v]) => `${k}: ${v}`).join('; ');
        // 回调通知（写黑板告警由宿主侧实现）
        if (notifyFn) notifyFn({ changed: result.changed, capChanged: result.capChanged, detail, capDetail });
        console.log(`[agent-bus] ⚠️ 宿主版本变化: ${detail}${capDetail ? ' | 能力: ' + capDetail : ''} —— 已更新基线并通知`);
      }
    } catch (e) {
      console.log('[agent-bus] adapt-check error: ' + (e.message || e));
    }
  }

  // 立即跑一次
  void run();

  // 定期重检（timer 服务可用时）
  if (timerSvc && typeof timerSvc.setInterval === 'function') {
    const disposer = timerSvc.setInterval(run, CHECK_INTERVAL);
    return () => { try { disposer?.(); } catch { /* 忽略 */ } };
  }
  // 无 timer：用全局 setInterval 兜底（宿主级插件环境一般有）
  if (typeof setInterval === 'function') {
    const id = setInterval(run, CHECK_INTERVAL);
    return () => clearInterval(id);
  }
  return null;
}

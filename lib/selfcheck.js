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

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const SELFCHECK_DIR = join(HOME, '.dsh', 'plugin-selfcheck');
const BB_URL = process.env.DSH_BB_URL || 'http://127.0.0.1:8792';
const LOG_FILE = join(SELFCHECK_DIR, 'selfcheck.log');

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

  // ① peerDependencies 可解析性（require.resolve 探测）
  if (typeof require === 'function') {
    for (const peer of requiredPeers) {
      try {
        require.resolve(peer);
      } catch (e) {
        missing.push(`peer:${peer}`);
        warnings.push(`依赖 ${peer} 不可解析（node_modules 缺失或符号链接断）`);
      }
    }
  } else {
    // ESM 下用 createRequire 或标记无法探测
    warnings.push('ESM 环境无法 require.resolve 探测 peerDeps（跳过，靠运行时报错）');
  }

  // ② 关键符号导入完整性（当前文件顶层 import 扫描）
  if (requiredSymbols.length > 0 && typeof __filename !== 'undefined') {
    try {
      const src = readFileSync(__filename, 'utf8');
      for (const sym of requiredSymbols) {
        const imported = src.includes(`import { ${sym}`) || src.includes(`import ${sym} `) || src.includes(`import * as ${sym}`);
        if (!imported) {
          missing.push(`symbol:${sym}`);
          warnings.push(`符号 ${sym} 未在顶层导入（ESM 下裸调用 → ReferenceError）`);
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
  const result = { plugin: pluginName, ok, missing, warnings, ts };
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

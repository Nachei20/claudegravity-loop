#!/usr/bin/env node

/**
 * Claudegravity Loop Runner — Hardened v1.2.0
 * Standard-library zero-dependency CLI adapter for automating cross-model review rounds.
 * Node.js 18+ (Windows, macOS, Linux).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import path, { dirname, resolve, join, basename, extname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let PKG_VERSION = '1.2.0';
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  PKG_VERSION = pkg.version || '1.2.0';
} catch {
  PKG_VERSION = 'unknown';
}

export const FALLBACK_SIGNALS = [
  /policy\s*(?:violation|block|filter)/i,
  /\[bio\]/i,
  /safety\s*guardrail/i,
  /content\s*filter/i,
  /rate_limit_exceeded|overloaded_error/i,
  /ETIMEDOUT|ECONNRESET/i,
  /UND_ERR_CONNECT_TIMEOUT/i
];

export function pickExecutable(lines, platform = process.platform) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  if (platform === 'win32') {
    const exeMatch = lines.find((l) => l.toLowerCase().endsWith('.exe'));
    if (exeMatch) return exeMatch;
  }
  return lines[0];
}

export function isWindowsShim(binPath, platform = process.platform) {
  if (!binPath || platform !== 'win32') return false;
  const base = win32.basename(binPath).toLowerCase();
  const ext = win32.extname(base);
  return ext === '' || ext === '.cmd' || ext === '.bat' || ext === '.ps1';
}

export function resolveNpmShim(binPath, { platform = process.platform, fsMock } = {}) {
  if (!binPath || platform !== 'win32') return null;
  const fsImpl = fsMock || { existsSync, readFileSync, realpathSync };
  const pathMod = platform === 'win32' ? win32 : path;
  const pathSep = platform === 'win32' ? win32.sep : path.sep;

  let targetShim = binPath;
  const lower = binPath.toLowerCase();

  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    targetShim = binPath;
  } else if (lower.endsWith('.exe')) {
    return null;
  } else {
    // Win32 where.exe often returns extensionless shim first
    const cmdSibling = `${binPath}.cmd`;
    if (fsImpl.existsSync(cmdSibling)) {
      targetShim = cmdSibling;
    } else if (fsImpl.existsSync(binPath)) {
      targetShim = binPath;
    } else {
      return null;
    }
  }

  let content;
  try {
    content = fsImpl.readFileSync(targetShim, 'utf8').slice(0, 8192);
  } catch {
    return null;
  }

  let relEntry = null;
  // Match .cmd shims: %dp0%\node_modules\... or %~dp0\node_modules\...
  const cmdMatches = [...content.matchAll(/%(?:~dp0|dp0%)[\\/](node_modules[\\/][^"'\r\n]+)/gi)];
  if (cmdMatches.length > 0) {
    const jsMatch = cmdMatches.find((m) => /\.(?:m?js|cjs)$/i.test(m[1])) || cmdMatches[cmdMatches.length - 1];
    relEntry = jsMatch[1];
  } else {
    // Match sh shims: $basedir/node_modules/...
    const shMatches = [...content.matchAll(/\$basedir[\\/](node_modules[\\/][^"'\r\n]+)/gi)];
    if (shMatches.length > 0) {
      const jsMatch = shMatches.find((m) => /\.(?:m?js|cjs)$/i.test(m[1])) || shMatches[shMatches.length - 1];
      relEntry = jsMatch[1];
    }
  }

  if (!relEntry) return null;

  const shimDir = pathMod.dirname(targetShim);
  const resolvedEntry = pathMod.resolve(shimDir, relEntry);

  if (!fsImpl.existsSync(resolvedEntry)) return null;

  try {
    const realShimModules = fsImpl.realpathSync(pathMod.join(shimDir, 'node_modules')) + pathSep;
    const realEntry = fsImpl.realpathSync(resolvedEntry);
    if (!realEntry.toLowerCase().startsWith(realShimModules.toLowerCase())) {
      return null; // Traversal attempt outside node_modules
    }
  } catch {
    return null;
  }

  let nodeBin = process.execPath;
  const localNode = pathMod.join(shimDir, 'node.exe');
  if (fsImpl.existsSync(localNode)) {
    nodeBin = localNode;
  }

  return { bin: nodeBin, entry: resolvedEntry };
}

export function getExecutable(bin) {
  if (bin === 'agy') {
    if (process.env.AGY_BIN_PATH && existsSync(process.env.AGY_BIN_PATH)) {
      return process.env.AGY_BIN_PATH;
    }
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
      const winPath = join(localAppData, 'agy', 'bin', 'agy.exe');
      if (existsSync(winPath)) return winPath;
    } else {
      const unixPath = join(os.homedir(), '.local', 'bin', 'agy');
      if (existsSync(unixPath)) return unixPath;
    }
  }
  if (bin === 'claude') {
    if (process.env.CLAUDE_BIN_PATH && existsSync(process.env.CLAUDE_BIN_PATH)) {
      return process.env.CLAUDE_BIN_PATH;
    }
    if (process.platform === 'win32') {
      const localBin = join(os.homedir(), '.local', 'bin', 'claude.exe');
      if (existsSync(localBin)) return localBin;
      const localAppData = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
      const progPath = join(localAppData, 'Programs', 'claude', 'claude.exe');
      if (existsSync(progPath)) return progPath;
    } else {
      const unixPath = join(os.homedir(), '.local', 'bin', 'claude');
      if (existsSync(unixPath)) return unixPath;
    }
  }

  const lookupCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const res = spawnSync(lookupCmd, [bin], { encoding: 'utf-8' });
  if (res.status === 0 && res.stdout.trim()) {
    const lines = res.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const picked = pickExecutable(lines, process.platform);
    if (picked) return picked;
  }
  return bin;
}

export function parseArgs(args) {
  if (args.length === 0) {
    console.error("❌ Error: Missing command. Expected 'review', 'preflight', or 'help'.");
    printUsage();
    process.exit(1);
  }

  const firstArg = args[0];
  if (firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    printUsage();
    process.exit(0);
  }
  if (firstArg === '--version' || firstArg === '-v') {
    console.log(`claudegravity-loop v${PKG_VERSION}`);
    process.exit(0);
  }

  if (firstArg.startsWith('-')) {
    console.error(`❌ Error: Unknown flag '${firstArg}'. Expected 'review', 'preflight', or 'help'.`);
    printUsage();
    process.exit(1);
  }

  if (!['review', 'preflight'].includes(firstArg)) {
    console.error(`❌ Error: Unknown command '${firstArg}'. Expected 'review', 'preflight', or 'help'.`);
    printUsage();
    process.exit(1);
  }

  const options = {
    command: firstArg,
    plan: 'PLAN.md',
    log: 'PLAN-REVIEW-LOG.md',
    rounds: 5,
    host: 'claude',
    model: null,
    fallbackModel: null,
    autoFallback: false,
    fallbackOnTimeout: false,
    insecureTls: false,
    track: 'auto',
    timeout: 600000,
    stdin: true,
    skipLint: false,
  };

  let hasHelp = false;
  let hasVersion = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      hasHelp = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      hasVersion = true;
      continue;
    }

    if (arg.startsWith('--plan=')) options.plan = arg.slice(7);
    else if (arg === '--plan') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error(`❌ Error: Flag '--plan' requires a file path argument.`);
        printUsage();
        process.exit(1);
      }
      options.plan = args[++i];
    }
    else if (arg.startsWith('--log=')) options.log = arg.slice(6);
    else if (arg === '--log') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error(`❌ Error: Flag '--log' requires a file path argument.`);
        printUsage();
        process.exit(1);
      }
      options.log = args[++i];
    }
    else if (arg.startsWith('--rounds=')) {
      const r = parseInt(arg.slice(9), 10);
      options.rounds = isNaN(r) ? 5 : r;
      console.warn('⚠️ Warning: --rounds is deprecated and ignored (one round per CLI invocation to allow host arbitration in PLAN-REVIEW-LOG.md).');
    }
    else if (arg === '--rounds') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-') && !isNaN(parseInt(args[i + 1], 10))) {
        options.rounds = parseInt(args[++i], 10);
      }
      console.warn('⚠️ Warning: --rounds is deprecated and ignored (one round per CLI invocation to allow host arbitration in PLAN-REVIEW-LOG.md).');
    }
    else if (arg.startsWith('--host=')) options.host = arg.slice(7);
    else if (arg === '--host') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error(`❌ Error: Flag '--host' requires a provider argument ('claude' or 'antigravity').`);
        printUsage();
        process.exit(1);
      }
      options.host = args[++i];
    }
    else if (arg.startsWith('--model=')) options.model = arg.slice(8);
    else if (arg === '--model') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error(`❌ Error: Flag '--model' requires a model name argument.`);
        printUsage();
        process.exit(1);
      }
      options.model = args[++i];
    }
    else if (arg.startsWith('--fallback-model=')) options.fallbackModel = arg.slice(17);
    else if (arg === '--fallback-model') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error(`❌ Error: Flag '--fallback-model' requires a model name argument.`);
        printUsage();
        process.exit(1);
      }
      options.fallbackModel = args[++i];
    }
    else if (arg === '--auto-fallback') options.autoFallback = true;
    else if (arg === '--fallback-on-timeout') options.fallbackOnTimeout = true;
    else if (arg === '--insecure-tls') options.insecureTls = true;
    else if (arg.startsWith('--track=')) options.track = arg.slice(8);
    else if (arg === '--track') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error(`❌ Error: Flag '--track' requires an argument ('code', 'artifact', or 'auto').`);
        printUsage();
        process.exit(1);
      }
      options.track = args[++i];
    }
    else if (arg.startsWith('--timeout=')) {
      const t = parseInt(arg.slice(10), 10);
      options.timeout = isNaN(t) ? 600000 : t;
    }
    else if (arg === '--timeout') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error(`❌ Error: Flag '--timeout' requires a numeric millisecond argument.`);
        printUsage();
        process.exit(1);
      }
      const t = parseInt(args[++i], 10);
      options.timeout = isNaN(t) ? 600000 : t;
    }
    else if (arg === '--no-stdin') options.stdin = false;
    else if (arg === '--skip-lint') options.skipLint = true;
    else if (arg.startsWith('-')) {
      console.error(`❌ Error: Unknown flag '${arg}'.`);
      printUsage();
      process.exit(1);
    }
    else {
      console.error(`❌ Error: Unexpected positional argument '${arg}'.`);
      printUsage();
      process.exit(1);
    }
  }

  if (hasHelp) {
    printUsage();
    process.exit(0);
  }
  if (hasVersion) {
    console.log(`claudegravity-loop v${PKG_VERSION}`);
    process.exit(0);
  }

  // Normalize and validate host
  options.host = (options.host || 'claude').toLowerCase();
  if (options.host !== 'claude' && options.host !== 'antigravity') {
    console.warn(`⚠️ Unrecognized host '${options.host}'. Defaulting to 'claude'.`);
    options.host = 'claude';
  }

  return options;
}

export function detectTrack(planContent, requestedTrack = 'auto') {
  if (requestedTrack && requestedTrack !== 'auto') {
    if (requestedTrack === 'code' || requestedTrack === 'artifact') {
      return requestedTrack;
    }
    console.warn(`⚠️ Unknown track '${requestedTrack}'. Defaulting to 'auto'.`);
  }

  const hasStrongCodeIndicators =
    /\bPROOF_CMD\b/.test(planContent) ||
    /\bgit\s+worktree\b/i.test(planContent) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run|install|build)\b/i.test(planContent) ||
    /\b(?:pytest|cargo\s+(?:test|build)|go\s+(?:test|build))\b/i.test(planContent) ||
    /(?:^|\s|`)(?:[\w.-]+[/\\])+[\w.-]+\.(?:ts|js|mjs|cjs|py|go|rs|cpp|c|java|cs|sh|rb|php)\b/i.test(planContent);

  const artifactPatterns = /\.(?:pptx|pdf|docx|xlsx|svg|drawio|cad)\b/i;
  const isArtifactDeliverable = artifactPatterns.test(planContent) && !hasStrongCodeIndicators;
  return isArtifactDeliverable ? 'artifact' : 'code';
}

export function buildChildEnv(options = {}, baseEnv = process.env) {
  const childEnv = { ...baseEnv };
  // Case-insensitive scrubbing of ambient NODE_TLS_REJECT_UNAUTHORIZED in Windows and cross-platform
  for (const k of Object.keys(childEnv)) {
    if (k.toUpperCase() === 'NODE_TLS_REJECT_UNAUTHORIZED') {
      delete childEnv[k];
    }
  }
  if (options.insecureTls || process.env.CLAUDEGRAVITY_INSECURE_TLS === '1') {
    childEnv.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const source = options.insecureTls ? 'user flag (--insecure-tls)' : 'environment variable (CLAUDEGRAVITY_INSECURE_TLS=1)';
    console.warn(`⚠️ [SECURITY WARNING] Insecure TLS mode enabled by ${source} for local proxy traversal.`);
  }
  return childEnv;
}

export function decideFallback({ currentModel, reviewer, status, output, autoFallback = true, timedOut = false, fallbackModel = null, fallbackOnTimeout = false }) {
  const isTimeoutSignal = (timedOut || /print timeout after/i.test(output)) && fallbackOnTimeout;
  const isFallbackSignal = isTimeoutSignal || FALLBACK_SIGNALS.some((pattern) => pattern.test(output));
  if (status !== 0 && autoFallback && isFallbackSignal) {
    if (fallbackModel) {
      return { shouldFallback: true, nextModel: fallbackModel };
    }
    if (reviewer === 'claude') {
      if (currentModel === 'opus' || !currentModel) {
        return { shouldFallback: true, nextModel: 'sonnet' };
      }
    } else if (reviewer === 'antigravity') {
      if (!currentModel || currentModel.includes('pro') || currentModel.includes('thinking')) {
        return { shouldFallback: true, nextModel: 'gemini-3.7-flash-medium' };
      }
    }
  }
  return { shouldFallback: false, nextModel: null };
}

export function decodeXmlEntities(str) {
  if (!str) return '';
  return str.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (match, hex, dec, named) => {
    if (hex || dec) {
      const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
      if (cp > 0 && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF)) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return match;
        }
      }
      return match;
    }
    switch (named) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'amp': return '&';
      default: return match;
    }
  });
}

export function extractStructuredArtifact(slideXml, options = {}) {
  const { presentationXml = null, maxShapes = null } = options;
  if (typeof slideXml !== 'string') {
    return { slide_dimensions: null, shapes: [], shape_count: 0, text_nodes: [], total_text_nodes: 0, truncated: false };
  }

  let slide_dimensions = null;
  const szXml = (typeof presentationXml === 'string' && presentationXml) || (slideXml.includes('<p:sldSz') ? slideXml : null);
  if (szXml) {
    const sldSzMatch = szXml.match(/<p:sldSz\s+[^>]*cx="(\d+)"\s+cy="(\d+)"/i) ||
                       szXml.match(/<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/i);
    if (sldSzMatch) {
      slide_dimensions = {
        width_emu: parseInt(sldSzMatch[1], 10),
        height_emu: parseInt(sldSzMatch[2], 10),
        width_cm: parseFloat((parseInt(sldSzMatch[1], 10) / 360000).toFixed(2)),
        height_cm: parseFloat((parseInt(sldSzMatch[2], 10) / 360000).toFixed(2)),
      };
    }
  }

  const textMatches = [...slideXml.matchAll(/<a:t\b[^>]*>([^<]+)<\/a:t>/gi)];
  const text_nodes = textMatches.map((m) => decodeXmlEntities(m[1].trim())).filter(Boolean);

  const shapeMatches = [...slideXml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/gi)];
  const allShapes = shapeMatches.map((m, idx) => {
    const shapeBody = m[1];
    const nameMatch = shapeBody.match(/name="([^"]+)"/i);
    const textMatch = shapeBody.match(/<a:t\b[^>]*>([^<]+)<\/a:t>/i);
    const colorMatch = shapeBody.match(/<a:srgbClr\s+val="([^"]+)"/i);
    return {
      id: idx + 1,
      name: nameMatch ? decodeXmlEntities(nameMatch[1]) : `Shape ${idx + 1}`,
      text: textMatch ? decodeXmlEntities(textMatch[1]) : null,
      color: colorMatch ? colorMatch[1] : null,
    };
  });

  const truncated = typeof maxShapes === 'number' && allShapes.length > maxShapes;
  const shapes = truncated ? allShapes.slice(0, maxShapes) : allShapes;

  return {
    slide_dimensions,
    shapes,
    shape_count: allShapes.length,
    text_nodes,
    total_text_nodes: text_nodes.length,
    truncated,
  };
}

export function extractEquationSegment(line) {
  const eqIdx = line.indexOf('=');
  if (eqIdx === -1) return null;

  let left = line.slice(0, eqIdx);
  const right = line.slice(eqIdx);

  // 1. Cut at ';' if present before '='
  const lastSemi = left.lastIndexOf(';');
  if (lastSemi !== -1) {
    left = left.slice(lastSemi + 1);
  }

  // 2. Cut at the last ':' whose prefix does NOT contain an arithmetic operator that connects terms (+ or -)
  const colons = [...left.matchAll(/:/g)];
  for (let i = colons.length - 1; i >= 0; i--) {
    const colIdx = colons[i].index;
    const prefixBeforeCol = left.slice(0, colIdx);
    const hasMinusOp = /\d\s*(?:cm|mm|px|pt|%)\s*-\s*/i.test(prefixBeforeCol) ||
                       /(?:^|[^\d\s])\s*-\s*\d+(?:[.,]\d+)?\s*(?:cm|mm|px|pt|%)/i.test(prefixBeforeCol);
    const hasArithmeticInPrefix = /\+/.test(prefixBeforeCol) || hasMinusOp;
    if (!hasArithmeticInPrefix) {
      left = left.slice(colIdx + 1);
      break;
    }
  }

  return (left + right).trim();
}

function normalizeLocale(str, locale) {
  if (locale === 'US') {
    // US: comma is thousands separator, dot is decimal separator
    return str.replace(/\b(\d{1,3})(?:,(\d{3}))+\b/g, (m) => m.replace(/,/g, ''));
  } else {
    // EU: dot is thousands separator, comma is decimal separator
    let s = str.replace(/\b(\d{1,3})(?:\.(\d{3}))+\b/g, (m) => m.replace(/\./g, ''));
    return s.replace(/(\d),(\d{1,4})(?!\d)/g, '$1.$2');
  }
}

function evaluateUnitEquation(segment, locale) {
  const norm = normalizeLocale(segment, locale);
  const hasNonLinear = /\d\s*(?:cm|mm|px|pt|%)?\s*[x×*\/^]\s*\(?\s*\d/i.test(norm) ||
                       /\)\s*[x×*\/^]\s*\d/i.test(norm);
  if (hasNonLinear) return { skip: true };

  const unitMatch = norm.match(/(.+)=\s*(-?[\d.]+)\s*(cm|mm|px|pt|%)(?!\w)/i);
  if (!unitMatch) return null;

  const leftSide = unitMatch[1];
  const declared = parseFloat(unitMatch[2]);
  const unit = unitMatch[3].toLowerCase();
  const unitPattern = unit === '%' ? '%' : unit;

  const unitRegex = new RegExp(`([+-]?\\s*\\d+(?:\\.\\d+)?)\\s*${unitPattern}(?!\\w)`, 'gi');
  const terms = [...leftSide.matchAll(unitRegex)];
  if (terms.length < 2) return null;

  const values = terms.map((m) => parseFloat(m[1].replace(/\s+/g, ''))).filter((v) => !isNaN(v));
  if (values.length < 2) return null;

  const calculated = values.reduce((sum, v) => sum + v, 0);
  const diff = Math.abs(calculated - declared);
  return {
    ok: diff <= 0.05,
    calculated,
    declared,
    unit,
  };
}

function evaluateGeneralEquation(segment, locale) {
  const norm = normalizeLocale(segment, locale);
  const hasNonLinear = /\d\s*[x×*\/^]\s*\(?\s*\d/i.test(norm) ||
                       /\)\s*[x×*\/^]\s*\d/i.test(norm);
  if (hasNonLinear) return { skip: true };
  if (/[()]/.test(norm)) return null;

  const eqMatch = norm.match(/(?:^|:\s*)([0-9\s.+-]+)=\s*(-?[\d.]+)\s*$/);
  if (!eqMatch) return null;

  const leftSide = eqMatch[1].trim();
  const declared = parseFloat(eqMatch[2]);
  const terms = [];
  let currentNum = '';
  let currentSign = 1;
  for (let j = 0; j < leftSide.length; j++) {
    const ch = leftSide[j];
    if (ch === '+') {
      if (currentNum) terms.push(currentSign * parseFloat(currentNum));
      currentNum = '';
      currentSign = 1;
    } else if (ch === '-') {
      if (currentNum) terms.push(currentSign * parseFloat(currentNum));
      currentNum = '';
      currentSign = -1;
    } else if (/[\d.]/.test(ch)) {
      currentNum += ch;
    }
  }
  if (currentNum) terms.push(currentSign * parseFloat(currentNum));

  if (terms.length >= 2 && terms.every((t) => !isNaN(t))) {
    const calculated = terms.reduce((a, b) => a + b, 0);
    const diff = Math.abs(calculated - declared);
    return {
      ok: diff <= 0.05,
      calculated,
      declared,
      leftSide,
    };
  }
  return null;
}

export function runPreflightLinter(planContent) {
  const errors = [];
  const warnings = [];

  const lines = planContent.split(/\r?\n/);
  let inBacktickFence = false;
  let inTildeFence = false;

  // 1. Balance of code blocks (``` and ~~~)
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) inBacktickFence = !inBacktickFence;
    if (trimmed.startsWith('~~~')) inTildeFence = !inTildeFence;
  }

  if (inBacktickFence) {
    errors.push('Unbalanced markdown code blocks: unclosed backtick fence (```).');
  }
  if (inTildeFence) {
    errors.push('Unbalanced markdown code blocks: unclosed tilde fence (~~~).');
  }

  // 2. Budget and arithmetic consistency checker (line-by-line, non-quadratic)
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || !line.includes('=')) continue;

    // Skip explanatory lines discussing equations or examples
    if (/\b(?:ej\.|example|e\.g\.|vs\s+total)\b/i.test(line)) continue;

    const segment = extractEquationSegment(line);
    if (!segment) continue;

    // Check A: Unit-based budget equations (e.g., cm, mm, px, pt, %)
    const unitUS = evaluateUnitEquation(segment, 'US');
    const unitEU = evaluateUnitEquation(segment, 'EU');

    if (unitUS || unitEU) {
      if ((unitUS && unitUS.skip) || (unitEU && unitEU.skip)) {
        continue;
      }
      const passUS = unitUS && unitUS.ok;
      const passEU = unitEU && unitEU.ok;
      if (passUS || passEU) {
        if (!passUS && passEU) {
          warnings.push(`Ambiguous European number format with periods/commas in line ${i + 1} ('${trimmed}') balanced in EU locale.`);
        }
        continue;
      } else {
        const u = (unitUS || unitEU);
        errors.push(`Arithmetic inconsistency in ${u.unit} budget (line ${i + 1}): calculated sum (${u.calculated.toFixed(2)} ${u.unit}) does not match declared (${u.declared.toFixed(2)} ${u.unit}) in '${trimmed}'.`);
        continue;
      }
    }

    // Check B: Multi-operand general arithmetic equations
    const genUS = evaluateGeneralEquation(segment, 'US');
    const genEU = evaluateGeneralEquation(segment, 'EU');

    if (genUS || genEU) {
      if ((genUS && genUS.skip) || (genEU && genEU.skip)) {
        continue;
      }
      const passUS = genUS && genUS.ok;
      const passEU = genEU && genEU.ok;
      if (passUS || passEU) {
        if (!passUS && passEU) {
          warnings.push(`Ambiguous European number format in line ${i + 1} ('${trimmed}') balanced in EU locale.`);
        }
      } else {
        const g = (genUS || genEU);
        errors.push(`Equation error (line ${i + 1}): calculated ${g.calculated} != declared ${g.declared} (LHS: ${g.leftSide}) in '${trimmed}'.`);
      }
    }
  }

  if (!planContent.includes('##') || planContent.length < 50) {
    warnings.push('Plan content appears exceptionally brief or missing standard section headings.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}

export function parseVerdict(stdout, status = 0, timedOut = false) {
  if (timedOut || status === 124) {
    return { verdict: 'TIMEOUT', code: 124 };
  }
  if (typeof stdout !== 'string') {
    return { verdict: null, code: 5, status };
  }
  if (status !== 0) {
    return { verdict: 'ERROR', code: 5, status };
  }
  // Accept bold markdown framing: e.g. **VERDICT: REVISE** or standard VERDICT: APPROVED
  const matches = [...stdout.matchAll(/^\s*\*?\*?\s*VERDICT:\s*(APPROVED|REVISE)\s*\*?\*?\s*$/gim)];
  if (matches.length === 0) {
    return { verdict: null, code: 5, status: 0 };
  }
  const lastMatch = matches[matches.length - 1][1].toUpperCase();
  if (lastMatch === 'APPROVED') {
    return { verdict: 'APPROVED', code: 0 };
  }
  if (lastMatch === 'REVISE') {
    return { verdict: 'REVISE', code: 2 };
  }
  return { verdict: null, code: 5 };
}

export function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // Process already exited
  }
}

export async function executeReviewerAsync({ bin, args = [], prompt, env = process.env, stdin = true, timeout = 600000 }) {
  let spawnBin = bin;
  let spawnArgs = args;

  // On Windows, resolve shims via Node without cmd.exe shell wrapper
  if (process.platform === 'win32' && isWindowsShim(bin)) {
    const resolved = resolveNpmShim(bin);
    if (resolved) {
      spawnBin = resolved.bin;
      spawnArgs = [resolved.entry, ...args];
    } else {
      const errMessage = `[SECURITY ERROR] Windows batch shims (.cmd/.bat) could not be safely resolved via node. Install native binary (.exe) or ensure package is under node_modules.`;
      console.error(`\n❌ ${errMessage}`);
      return {
        status: 5,
        stdout: '',
        stderr: errMessage,
        timedOut: false,
      };
    }
  }

  return new Promise((resolve) => {
    let stdoutData = '';
    let stderrData = '';
    let timedOut = false;
    let timer = null;
    let graceTimer = null;
    let settled = false;

    const child = spawn(spawnBin, spawnArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
    });

    const cleanupSignals = () => {
      process.removeListener('SIGINT', onSigInt);
      process.removeListener('SIGTERM', onSigTerm);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      cleanupSignals();
      try { child.stdout?.destroy(); } catch (_) {}
      try { child.stderr?.destroy(); } catch (_) {}
      try { child.stdin?.destroy(); } catch (_) {}
      resolve(result);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk;
    });

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
        graceTimer = setTimeout(() => {
          finish({
            status: 124,
            signal: null,
            stdout: stdoutData,
            stderr: stderrData + '\n[runner] Execution timed out; stdio streams closed after grace period.',
            timedOut: true,
          });
        }, 1500);
      }, timeout);
    }

    const onSigInt = () => {
      killProcessTree(child.pid);
      process.exit(130);
    };

    const onSigTerm = () => {
      killProcessTree(child.pid);
      process.exit(143);
    };

    process.once('SIGINT', onSigInt);
    process.once('SIGTERM', onSigTerm);

    child.on('error', (err) => {
      finish({
        status: 1,
        stdout: stdoutData,
        stderr: stderrData + '\n' + err.message,
        timedOut,
      });
    });

    child.on('close', (code, signal) => {
      const isAgyPrintTimeout = /print timeout after/i.test(stderrData);
      const effectiveTimedOut = timedOut || isAgyPrintTimeout;
      const exitCode = effectiveTimedOut ? 124 : (code !== null ? code : (signal ? 128 : 1));
      finish({
        status: exitCode,
        signal: signal || null,
        stdout: stdoutData,
        stderr: stderrData,
        timedOut: effectiveTimedOut,
      });
    });

    // Handle early child exit gracefully without uncaught EPIPE / write EOF
    child.stdin.on('error', () => {
      // Ignore write errors if child terminated early
    });

    if (stdin) {
      try {
        if (!child.stdin.destroyed) {
          child.stdin.end(Buffer.from(prompt, 'utf-8'));
        }
      } catch (_) {}
    } else {
      try {
        if (!child.stdin.destroyed) {
          child.stdin.end();
        }
      } catch (_) {}
    }
  });
}

export function printUsage() {
  console.log(`
🌀 Claudegravity Loop Runner v${PKG_VERSION}

Usage:
  node scripts/runner.mjs review [options]
  node scripts/runner.mjs preflight [options]

Options:
  --plan <path>            Path to implementation plan (default: PLAN.md)
  --log <path>             Path to review log (default: PLAN-REVIEW-LOG.md)
  --host <provider>        Current host runtime: 'claude' or 'antigravity' (default: claude)
  --model <name>           Model override for the reviewer (e.g., 'sonnet', 'opus')
  --fallback-model <name>  Custom fallback model if primary fails with rate/policy limits
  --auto-fallback          Automatically fallback upon policy/rate limits
  --fallback-on-timeout    Allow execution timeout to trigger model fallback
  --insecure-tls           Opt-in TLS bypass for corporate/local proxies (Warning logged)
  --track <type>           Phase 3 track: 'code', 'artifact', or 'auto' (default: auto)
  --timeout <ms>           Execution timeout per round in ms (default: 600000)
  --no-stdin               Pass prompt as argv instead of streaming via stdin pipe
  --skip-lint              Proceed with review even if pre-flight linter detects inconsistencies
  --help, -h               Show this usage guide
  --version, -v            Show runner version
`);
}

export function runPreflight(options = {}) {
  console.log('🔍 Running Claudegravity preflight diagnostics...\n');
  const agy = getExecutable('agy');
  const claude = getExecutable('claude');

  const agyOk = existsSync(agy) || spawnSync(agy, ['--version'], { encoding: 'utf-8' }).status === 0;
  const claudeOk = existsSync(claude) || spawnSync(claude, ['--version'], { encoding: 'utf-8' }).status === 0;

  const agyIsShim = isWindowsShim(agy);
  const claudeIsShim = isWindowsShim(claude);

  const formatShimStatus = (binPath, isShim, isOk) => {
    if (!isOk) return '⚠️ Not found';
    if (!isShim) return '✅ Available';
    const resolved = resolveNpmShim(binPath);
    if (resolved) {
      return `⚠️ npm shim (resolved via node: ${resolved.entry})`;
    }
    return '❌ unsupported shim';
  };

  const agyStatus = formatShimStatus(agy, agyIsShim, agyOk);
  const claudeStatus = formatShimStatus(claude, claudeIsShim, claudeOk);

  console.log(`  Antigravity CLI (agy):  ${agyStatus} (${agy})`);
  console.log(`  Claude Code CLI:        ${claudeStatus} (${claude})`);
  console.log(`  Node.js Platform:       ${process.platform} (${process.arch})`);
  console.log(`  Default TLS Invariant:  Strictly Active (Secure by Default)`);

  const planPath = resolve(process.cwd(), options.plan || 'PLAN.md');
  if (existsSync(planPath)) {
    console.log(`  Validating plan file:   ${options.plan || 'PLAN.md'}`);
    const linter = runPreflightLinter(readFileSync(planPath, 'utf-8'));
    console.log(`  Pre-flight Linter:      ${linter.ok ? '✅ Passed (0 errors)' : `⚠️ Found ${linter.errors.length} issue(s)`}`);
  } else {
    console.log(`  Pre-flight Linter:      ✅ Operational`);
  }
  console.log('');

  if (!agyOk && !claudeOk) {
    console.error('❌ Neither CLI is installed on PATH. Install at least one CLI to proceed.');
    process.exit(1);
  }
  console.log('✅ Preflight check complete.');
}

export async function runReview(options) {
  const planPath = resolve(process.cwd(), options.plan);
  if (!existsSync(planPath)) {
    console.error(`❌ Plan file not found at: ${planPath}`);
    process.exit(1);
  }

  const planContent = readFileSync(planPath, 'utf-8');

  // Step 1: Pre-flight Linter
  console.log('🔍 Running Pre-flight Consistency Linter on plan...');
  const lintResult = runPreflightLinter(planContent);
  if (!lintResult.ok) {
    if (options.skipLint) {
      console.warn('⚠️ [SKIP-LINT] Pre-flight Linter detected inconsistencies but proceeding via --skip-lint:');
      lintResult.errors.forEach((err) => console.warn(`  ⚠️ ${err}`));
    } else {
      console.error('❌ Pre-flight Linter detected inconsistencies before invoking reviewer:');
      lintResult.errors.forEach((err) => console.error(`  - ${err}`));
      console.error('\nPlease fix these mathematical/structural issues in PLAN.md before requesting rival review (or use --skip-lint).');
      process.exit(4);
    }
  }
  if (lintResult.warnings.length > 0) {
    lintResult.warnings.forEach((warn) => console.warn(`  ⚠️ Warning: ${warn}`));
  }
  if (!lintResult.ok && options.skipLint) {
    console.log('⚠️ Pre-flight Linter bypassed via --skip-lint.');
  } else {
    console.log('✅ Pre-flight Linter passed successfully.');
  }

  // Step 2: Track Detection
  const track = detectTrack(planContent, options.track);
  console.log(`📋 Phase 3 Target Track: ${track.toUpperCase()} (${track === 'code' ? 'Git Worktrees + PROOF_CMD' : 'Structured Extraction + Visual Render'})`);

  const reviewer = options.host === 'claude' ? 'antigravity' : 'claude';
  const reviewerBin = getExecutable(reviewer === 'antigravity' ? 'agy' : 'claude');
  let currentModel = options.model;

  console.log(`\n🌀 Claudegravity Loop: Initiating adversarial review round`);
  console.log(`  Host (Planner):    ${options.host}`);
  console.log(`  Reviewer (Rival):  ${reviewer} (${reviewerBin})`);
  console.log(`  Model:             ${currentModel || '(Default CLI model)'}`);
  console.log(`  Plan target:       ${options.plan}`);
  console.log(`  Transport mode:    ${options.stdin ? 'Async stdin stream' : 'argv parameter'}\n`);

  // Step 3: Configure Child Environment via buildChildEnv
  const childEnv = buildChildEnv(options);

  // Adversarial prompt with Anti-Sycophancy & Pressure Framing
  const prompt = `You are an adversarial reviewer for an implementation plan under the Claudegravity Loop protocol.
You act as a Lead Architect & Security Auditor operating under production incident pressure.
Your job is to find concrete technical flaws, vulnerabilities, race conditions, edge cases, schema conflicts, missing error handling, or hidden assumptions.
Adopt a rigorous, critical stance (Anti-Sycophancy). Do not validate, praise, flatter, or restate the plan.
For each flaw, identify the exact component and provide a concrete, specific technical fix.

Read the frozen PLAN.md below. End your response with EXACTLY one of:
VERDICT: APPROVED
or
VERDICT: REVISE

=== PLAN.md ===
${planContent}
`;

  function buildArgs(forModel) {
    const args = [];
    if (reviewer === 'antigravity') {
      args.push('--mode', 'plan');
      if (forModel) {
        args.push('--model', forModel);
      }
      const agyTimeoutSec = Math.max(30, Math.floor(options.timeout / 1000) - 15);
      args.push('--print-timeout', `${agyTimeoutSec}s`);
      if (!options.stdin) {
        args.push('-p', prompt);
      }
    } else {
      // Reviewer is claude
      args.push('-p');
      if (!options.stdin) {
        args.push(prompt);
      }
      if (forModel) {
        args.push('--model', forModel);
      }
      args.push('--tools', '');
    }
    return args;
  }

  console.log(`⏳ Invoking ${reviewer} in read-only adversarial mode...`);
  let res = await executeReviewerAsync({
    bin: reviewerBin,
    args: buildArgs(currentModel),
    prompt,
    env: childEnv,
    stdin: options.stdin,
    timeout: options.timeout,
  });

  const output = (res.stdout || '') + (res.stderr || '');

  // Step 4: Provider-aware Fallback evaluation via decideFallback
  const fallbackDecision = decideFallback({
    currentModel,
    reviewer,
    status: res.status,
    output,
    autoFallback: options.autoFallback,
    timedOut: res.timedOut,
    fallbackModel: options.fallbackModel,
    fallbackOnTimeout: options.fallbackOnTimeout,
  });

  let usedModel = currentModel || '(Default CLI model)';
  let priorAttemptOutput = null;

  if (fallbackDecision.shouldFallback && fallbackDecision.nextModel !== currentModel) {
    const fallbackModel = fallbackDecision.nextModel;
    console.warn(`\n⚠️ Primary model invocation failed matching a verified fallback signal (timeout or policy/rate limit).`);
    console.warn(`🔄 Executing bounded 1-hop fallback to model: '${fallbackModel}'...`);

    priorAttemptOutput = `[Primary attempt with ${usedModel} failed (status ${res.status}, timedOut: ${res.timedOut})]\n${output}`;
    usedModel = fallbackModel;

    res = await executeReviewerAsync({
      bin: reviewerBin,
      args: buildArgs(fallbackModel),
      prompt,
      env: childEnv,
      stdin: options.stdin,
      timeout: options.timeout,
    });
  }

  const finalOutput = (res.stdout || '') + (res.stderr || '');
  console.log('\n--- [Reviewer Response] ---');
  console.log(finalOutput.trim());
  console.log('----------------------------\n');

  // Step 5: Execution Log recording
  if (options.log) {
    const logPath = resolve(process.cwd(), options.log);
    let logEntry = `\n--- [${new Date().toISOString()}] Review Round (Host: ${options.host}, Reviewer: ${reviewer}, Model: ${usedModel}) ---\n`;
    if (options.skipLint && !lintResult.ok) {
      logEntry += `--- Pre-flight Linter Bypassed via --skip-lint ---\nSuppressed Errors:\n${lintResult.errors.map((e) => `  - ${e}`).join('\n')}\n\n`;
    }
    if (priorAttemptOutput) {
      logEntry += `--- Prior Failed Attempt ---\n${priorAttemptOutput}\n--- Fallback Response ---\n`;
    }
    logEntry += `${res.stdout || ''}\n${res.stderr || ''}\n`;
    try {
      writeFileSync(logPath, logEntry, { flag: 'a', encoding: 'utf-8' });
    } catch (e) {
      console.warn(`⚠️ Failed to write log to ${logPath}: ${e.message}`);
    }
  }

  // Step 6: Strict Verdict Parsing (fails closed, requires status === 0, parses last match on stdout)
  const parsed = parseVerdict(res.stdout || '', res.status, res.timedOut);
  if (parsed.verdict === 'APPROVED') {
    console.log('🎉 VERDICT: APPROVED — Plan passed cross-model hardening!');
    process.exit(0);
  } else if (parsed.verdict === 'REVISE') {
    console.log(`⚠️ VERDICT: REVISE — Findings identified. Arbitrate in ${options.log}.`);
    process.exit(2);
  } else if (parsed.verdict === 'TIMEOUT') {
    console.error('⏱️ EXECUTION TIMEOUT — Reviewer exceeded time limit.');
    process.exit(124);
  } else {
    console.warn(`⚠️ Reviewer invocation failed or emitted no valid VERDICT tag (bridge code ${parsed.code}).`);
    process.exit(parsed.code || 5);
  }
}

// CLI Execution Entry Point (supports junctions and symlinks via realpathSync)
const isDirectExecution = process.argv[1] && (() => {
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  }
})();

if (isDirectExecution) {
  const opts = parseArgs(process.argv.slice(2));
  switch (opts.command) {
    case 'preflight':
      runPreflight(opts);
      break;
    case 'review':
      await runReview(opts);
      break;
    case 'help':
      printUsage();
      process.exit(0);
      break;
    default:
      console.error(`❌ Error: Unknown command '${opts.command}'.`);
      printUsage();
      process.exit(1);
      break;
  }
}

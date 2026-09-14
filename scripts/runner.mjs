#!/usr/bin/env node

/**
 * Claudegravity Loop Runner — Hardened v1.1.0
 * Standard-library zero-dependency CLI adapter for automating cross-model review rounds.
 * Node.js 18+ (Windows, macOS, Linux).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const FALLBACK_SIGNALS = [
  /policy\s*(?:violation|block|filter)/i,
  /\[bio\]/i,
  /safety\s*guardrail/i,
  /content\s*filter/i,
  /rate_limit_exceeded|overloaded_error/i,
  /ETIMEDOUT|ECONNRESET/i,
  /UND_ERR_CONNECT_TIMEOUT/i
];

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

  const lookupCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const res = spawnSync(lookupCmd, [bin], { encoding: 'utf-8' });
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim().split(/\r?\n/)[0].trim();
  }
  return bin;
}

export function parseArgs(args) {
  const options = {
    command: args[0] || 'help',
    plan: 'PLAN.md',
    log: 'PLAN-REVIEW-LOG.md',
    rounds: 5,
    host: 'claude',
    model: null,
    fallbackModel: null,
    autoFallback: false,
    insecureTls: false,
    track: 'auto',
    timeout: 120000,
    stdin: true,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--plan=')) options.plan = arg.slice(7);
    else if (arg === '--plan' && args[i + 1]) options.plan = args[++i];
    else if (arg.startsWith('--log=')) options.log = arg.slice(6);
    else if (arg === '--log' && args[i + 1]) options.log = args[++i];
    else if (arg.startsWith('--rounds=')) {
      const r = parseInt(arg.slice(9), 10);
      options.rounds = isNaN(r) ? 5 : r;
    }
    else if (arg === '--rounds' && args[i + 1]) {
      const r = parseInt(args[++i], 10);
      options.rounds = isNaN(r) ? 5 : r;
    }
    else if (arg.startsWith('--host=')) options.host = arg.slice(7);
    else if (arg === '--host' && args[i + 1]) options.host = args[++i];
    else if (arg.startsWith('--model=')) options.model = arg.slice(8);
    else if (arg === '--model' && args[i + 1]) options.model = args[++i];
    else if (arg.startsWith('--fallback-model=')) options.fallbackModel = arg.slice(17);
    else if (arg === '--fallback-model' && args[i + 1]) options.fallbackModel = args[++i];
    else if (arg === '--auto-fallback') options.autoFallback = true;
    else if (arg === '--insecure-tls') options.insecureTls = true;
    else if (arg.startsWith('--track=')) options.track = arg.slice(8);
    else if (arg === '--track' && args[i + 1]) options.track = args[++i];
    else if (arg.startsWith('--timeout=')) {
      const t = parseInt(arg.slice(10), 10);
      options.timeout = isNaN(t) ? 120000 : t;
    }
    else if (arg === '--timeout' && args[i + 1]) {
      const t = parseInt(args[++i], 10);
      options.timeout = isNaN(t) ? 120000 : t;
    }
    else if (arg === '--no-stdin') options.stdin = false;
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

  // Prioritize codebase indicators: files, tests, programming keywords
  const hasCodeIndicators = /(?:git\s+worktree|PROOF_CMD|npm\s+(?:test|run)|pytest|cargo|go\s+test|\b(?:function|class|import|def|struct|const|let|var)\b|\.(?:ts|js|mjs|py|go|rs|cpp|c|java|cs|sh))\b/i.test(planContent);
  const artifactPatterns = /\.(?:pptx|pdf|docx|xlsx|svg|drawio|cad)\b/i;
  const isArtifactDeliverable = artifactPatterns.test(planContent) && !hasCodeIndicators;
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

export function decideFallback({ currentModel, reviewer, status, output, autoFallback = true, timedOut = false, fallbackModel = null }) {
  const isFallbackSignal = timedOut || FALLBACK_SIGNALS.some((pattern) => pattern.test(output));
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

export function extractStructuredArtifact(xmlString) {
  if (typeof xmlString !== 'string') {
    return { slide_dimensions: null, elements: [], count: 0 };
  }

  const dimMatch = xmlString.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/i);
  const slide_dimensions = dimMatch ? {
    width_emu: parseInt(dimMatch[1], 10),
    height_emu: parseInt(dimMatch[2], 10),
    width_cm: parseFloat((parseInt(dimMatch[1], 10) / 360000).toFixed(2)),
    height_cm: parseFloat((parseInt(dimMatch[2], 10) / 360000).toFixed(2)),
  } : { width_cm: 90.0, height_cm: 120.0 };

  const textMatches = [...xmlString.matchAll(/<a:t>([^<]+)<\/a:t>/gi)];
  const text_elements = textMatches.map(m => m[1].trim()).filter(Boolean);

  const shapeMatches = [...xmlString.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/gi)];
  const shapes = shapeMatches.map((m, idx) => {
    const shapeBody = m[1];
    const nameMatch = shapeBody.match(/name="([^"]+)"/i);
    const textMatch = shapeBody.match(/<a:t>([^<]+)<\/a:t>/i);
    const colorMatch = shapeBody.match(/<a:srgbClr\s+val="([^"]+)"/i);
    return {
      id: idx + 1,
      name: nameMatch ? nameMatch[1] : `Shape ${idx + 1}`,
      text: textMatch ? textMatch[1] : null,
      color: colorMatch ? colorMatch[1] : null,
    };
  });

  return {
    slide_dimensions,
    shape_count: shapes.length,
    shapes: shapes.slice(0, 10),
    total_text_nodes: text_elements.length,
    sample_texts: text_elements.slice(0, 5),
  };
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

    // Normalize decimal commas (1,5 -> 1.5)
    const normalized = line.replace(/(\d+),(\d+)/g, '$1.$2');

    // Check A: Unit-based budget equations (e.g., cm, mm, px, pt, %)
    // Matches: "Card 1 (24.0cm) + gap (1.5cm) + ... = 84.0 cm" or "1.5cm - 0.5cm = 1.0cm"
    const unitMatch = normalized.match(/(.+)=\s*(-?[\d.]+)\s*(cm|mm|px|pt|%)(?!\w)/i);
    if (unitMatch) {
      const leftSide = unitMatch[1];
      const declared = parseFloat(unitMatch[2]);
      const unit = unitMatch[3].toLowerCase();
      const unitPattern = unit === '%' ? '%' : unit;

      const unitRegex = new RegExp(`([+-]?\\s*\\d+(?:\\.\\d+)?)\\s*${unitPattern}(?!\\w)`, 'gi');
      const terms = [...leftSide.matchAll(unitRegex)];
      if (terms.length >= 2) {
        const values = terms.map(m => parseFloat(m[1].replace(/\s+/g, ''))).filter(v => !isNaN(v));
        const calculated = values.reduce((sum, v) => sum + v, 0);
        if (!isNaN(declared) && Math.abs(calculated - declared) > 0.05) {
          errors.push(`Arithmetic inconsistency in ${unit} budget (line ${i + 1}): calculated sum is ${calculated.toFixed(2)} ${unit}, declared is ${declared.toFixed(2)} ${unit} in '${trimmed}'.`);
        }
        continue;
      }
    }

    // Check B: Multi-operand arithmetic equations: "Total: 30 + 40 + 20 = 90" or "100 - 30 - 20 = 50"
    // Skip lines with non-linear or parenthesized operators (*, /, x, ×, (), ^) to avoid false positives
    if (/[*\/x×()^]/.test(normalized)) continue;

    const eqMatch = normalized.match(/(?:^|:\s*)([0-9\s.+-]+)=\s*(-?[\d.]+)\s*$/);
    if (eqMatch) {
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

      if (terms.length >= 2 && terms.every(t => !isNaN(t))) {
        const calculated = terms.reduce((a, b) => a + b, 0);
        if (Math.abs(calculated - declared) > 0.05) {
          errors.push(`Equation error (line ${i + 1}): ${leftSide} = ${declared} (calculated ${calculated.toFixed(2)})`);
        }
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
  const matches = [...stdout.matchAll(/^VERDICT:\s*(APPROVED|REVISE)\s*$/gim)];
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
  } catch (err) {
    // Process might already be dead
  }
}

export function executeReviewerAsync({ bin, args, prompt, env, stdin = true, timeout = 120000 }) {
  return new Promise((resolve) => {
    let stdoutData = '';
    let stderrData = '';
    let timedOut = false;
    let timer = null;

    const isWindowsBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const spawnArgs = stdin ? args : (args.includes(prompt) ? args : [...args, prompt]);

    const child = spawn(bin, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env || process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: isWindowsBatch,
    });

    // Multibyte-safe UTF-8 decoding on child streams (prevents U+FFFD on chunk boundary cuts)
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const sigHandler = (sig) => {
      if (timer) clearTimeout(timer);
      cleanupSignals();
      if (child.pid) killProcessTree(child.pid);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    };

    process.once('SIGINT', sigHandler);
    process.once('SIGTERM', sigHandler);

    function cleanupSignals() {
      process.removeListener('SIGINT', sigHandler);
      process.removeListener('SIGTERM', sigHandler);
    }

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        cleanupSignals();
        killProcessTree(child.pid);
        resolve({
          status: 124,
          stdout: stdoutData,
          stderr: stderrData + '\nError: Execution timed out',
          timedOut: true,
        });
      }, timeout);
    }

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk;
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      cleanupSignals();
      resolve({
        status: 1,
        stdout: stdoutData,
        stderr: stderrData + '\n' + err.message,
        timedOut,
      });
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      cleanupSignals();
      const exitCode = code !== null ? code : (signal ? 128 : 1);
      resolve({
        status: exitCode,
        signal: signal || null,
        stdout: stdoutData,
        stderr: stderrData,
        timedOut,
      });
    });

    // Handle early child exit gracefully without uncaught EPIPE / write EOF
    child.stdin.on('error', () => {
      // Ignore write errors if child terminated early
    });

    if (stdin) {
      if (!child.stdin.destroyed) {
        child.stdin.write(Buffer.from(prompt, 'utf-8'), (err) => {
          if (!err && !child.stdin.destroyed) {
            child.stdin.end();
          }
        });
      }
    } else {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
    }
  });
}

export function printUsage() {
  console.log(`
🌀 Claudegravity Loop Runner v1.1.0

Usage:
  node scripts/runner.mjs review [options]
  node scripts/runner.mjs preflight [options]

Options:
  --plan <path>       Path to implementation plan (default: PLAN.md)
  --log <path>        Path to review log (default: PLAN-REVIEW-LOG.md)
  --rounds <n>        Maximum review rounds (default: 5)
  --host <provider>   Current host runtime: 'claude' or 'antigravity' (default: claude)
  --model <name>      Model override for the reviewer (e.g., 'sonnet', 'opus')
  --auto-fallback     Automatically fallback upon policy/rate limits
  --insecure-tls      Opt-in TLS bypass for corporate/local proxies (Warning logged)
  --track <type>      Phase 3 track: 'code', 'artifact', or 'auto' (default: auto)
  --timeout <ms>      Execution timeout per round in ms (default: 120000)
  --no-stdin          Pass prompt as argv instead of streaming via stdin pipe
`);
}

export function runPreflight(options = {}) {
  console.log('🔍 Running Claudegravity preflight diagnostics...\n');
  const agy = getExecutable('agy');
  const claude = getExecutable('claude');

  const agyOk = existsSync(agy) || spawnSync(agy, ['--version'], { encoding: 'utf-8' }).status === 0;
  const claudeOk = existsSync(claude) || spawnSync(claude, ['--version'], { encoding: 'utf-8' }).status === 0;

  console.log(`  Antigravity CLI (agy):  ${agyOk ? '✅ Available' : '⚠️ Not found'} (${agy})`);
  console.log(`  Claude Code CLI:        ${claudeOk ? '✅ Available' : '⚠️ Not found'} (${claude})`);
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
    console.error('❌ Pre-flight Linter detected inconsistencies before invoking reviewer:');
    lintResult.errors.forEach((err) => console.error(`  - ${err}`));
    console.error('\nPlease fix these mathematical/structural issues in PLAN.md before requesting rival review.');
    process.exit(4);
  }
  if (lintResult.warnings.length > 0) {
    lintResult.warnings.forEach((warn) => console.warn(`  ⚠️ Warning: ${warn}`));
  }
  console.log('✅ Pre-flight Linter passed successfully.');

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
    default:
      printUsage();
      break;
  }
}

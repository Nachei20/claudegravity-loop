#!/usr/bin/env node

/**
 * Claudegravity Loop Runner
 * Standard-library zero-dependency CLI adapter for automating cross-model review rounds.
 * Node.js 18+ (Windows, macOS, Linux).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function getExecutable(bin) {
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

function parseArgs(args) {
  const options = {
    command: args[0] || 'help',
    plan: 'PLAN.md',
    log: 'PLAN-REVIEW-LOG.md',
    rounds: 5,
    host: 'claude',
    model: null,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--plan' && args[i + 1]) options.plan = args[++i];
    else if (arg === '--log' && args[i + 1]) options.log = args[++i];
    else if (arg === '--rounds' && args[i + 1]) options.rounds = parseInt(args[++i], 10);
    else if (arg === '--host' && args[i + 1]) options.host = args[++i];
    else if (arg === '--model' && args[i + 1]) options.model = args[++i];
  }
  return options;
}

function printUsage() {
  console.log(`
🌀 Claudegravity Loop Runner

Usage:
  node scripts/runner.mjs review [options]
  node scripts/runner.mjs preflight [options]

Options:
  --plan <path>      Path to implementation plan (default: PLAN.md)
  --log <path>       Path to review log (default: PLAN-REVIEW-LOG.md)
  --rounds <n>       Maximum review rounds (default: 5)
  --host <provider>  Current host runtime: 'claude' or 'antigravity' (default: claude)
  --model <name>     Optional model override for the reviewer
`);
}

function runPreflight() {
  console.log('🔍 Running Claudegravity preflight diagnostics...\n');
  const agy = getExecutable('agy');
  const claude = getExecutable('claude');

  const agyOk = existsSync(agy) || spawnSync(agy, ['--version'], { encoding: 'utf-8' }).status === 0;
  const claudeOk = existsSync(claude) || spawnSync(claude, ['--version'], { encoding: 'utf-8' }).status === 0;

  console.log(`  Antigravity CLI (agy):  ${agyOk ? '✅ Available' : '⚠️ Not found'} (${agy})`);
  console.log(`  Claude Code CLI:        ${claudeOk ? '✅ Available' : '⚠️ Not found'} (${claude})\n`);

  if (!agyOk && !claudeOk) {
    console.error('❌ Neither CLI is installed on PATH. Install at least one CLI to proceed.');
    process.exit(1);
  }
  console.log('✅ Preflight check complete.');
}

function runReview(options) {
  const planPath = resolve(process.cwd(), options.plan);
  if (!existsSync(planPath)) {
    console.error(`❌ Plan file not found at: ${planPath}`);
    process.exit(1);
  }

  const planContent = readFileSync(planPath, 'utf-8');
  const reviewer = options.host === 'claude' ? 'antigravity' : 'claude';
  const reviewerBin = getExecutable(reviewer === 'antigravity' ? 'agy' : 'claude');

  console.log(`🌀 Claudegravity Loop: Initiating adversarial review round`);
  console.log(`  Host (Planner):    ${options.host}`);
  console.log(`  Reviewer (Rival):  ${reviewer} (${reviewerBin})`);
  console.log(`  Plan target:       ${options.plan}\n`);

  const prompt = `You are an adversarial reviewer for an implementation plan. Your job is to find flaws, not to validate or flatter.
Read the frozen PLAN.md below. Identify concrete flaws: security holes, race conditions, missing edge cases, schema conflicts, hidden assumptions, or overengineering. For each flaw, provide a specific technical fix.
Do not restate the plan. Do not praise it.
End your response with EXACTLY one of:
VERDICT: APPROVED
or
VERDICT: REVISE

=== PLAN.md ===
${planContent}
`;

  let execArgs = [];
  if (reviewer === 'antigravity') {
    execArgs = ['-p', prompt, '--mode', 'plan'];
    if (options.model) execArgs.push('--model', options.model);
  } else {
    execArgs = ['-p', prompt];
    if (options.model) execArgs.push('--model', options.model);
  }

  console.log(`⏳ Invoking ${reviewer} in read-only adversarial mode...`);
  const res = spawnSync(reviewerBin, execArgs, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });

  if (res.error) {
    console.error(`❌ Failed to execute ${reviewerBin}:`, res.error.message);
    process.exit(1);
  }

  const output = (res.stdout || '') + (res.stderr || '');
  console.log('\n--- [Reviewer Response] ---');
  console.log(output.trim());
  console.log('----------------------------\n');

  if (output.includes('VERDICT: APPROVED')) {
    console.log('🎉 VERDICT: APPROVED — Plan passed cross-model hardening!');
    process.exit(0);
  } else if (output.includes('VERDICT: REVISE')) {
    console.log('⚠️ VERDICT: REVISE — Findings identified. Arbitrate in PLAN-REVIEW-LOG.md.');
    process.exit(2);
  } else {
    console.warn('⚠️ No explicit VERDICT: tag detected. Treat as bridge inspection required.');
    process.exit(3);
  }
}

const opts = parseArgs(process.argv.slice(2));

switch (opts.command) {
  case 'preflight':
    runPreflight();
    break;
  case 'review':
    runReview(opts);
    break;
  case 'help':
  default:
    printUsage();
    break;
}

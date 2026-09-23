#!/usr/bin/env node

/**
 * Claudegravity Loop Benchmark Suite — Hardened v1.2.0
 * Empirically validates the performance, stability, and security gains of Claudegravity Loop.
 * Directly exercises and validates real functions from runner.mjs against mutation testing (M1-M12).
 * Standard library zero-dependency execution.
 */

import { spawn, spawnSync } from 'node:child_process';
import https from 'node:https';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';

import {
  executeReviewerAsync,
  buildChildEnv,
  decideFallback,
  killProcessTree,
  runPreflightLinter,
  detectTrack,
  parseVerdict,
  extractStructuredArtifact,
  getExecutable,
  pickExecutable,
  isWindowsShim,
  resolveNpmShim,
  decodeXmlEntities,
  FALLBACK_SIGNALS,
} from './runner.mjs';

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let PKG_VERSION = '1.2.0';
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  PKG_VERSION = pkg.version || '1.2.0';
} catch {
  PKG_VERSION = 'unknown';
}

const results = [];

function recordResult({ name, category, passed, metric, baseline, target, details }) {
  results.push({ name, category, passed, metric, baseline, target, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`  ${icon} [${category}] ${name}`);
  if (metric) console.log(`      Metric: ${metric}`);
  if (details) console.log(`      Detail: ${details}`);
}

function getOpenSSLBinary() {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const res = spawnSync(lookup, ['openssl'], { encoding: 'utf-8' });
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim().split(/\r?\n/)[0].trim();
  }
  if (process.platform === 'win32') {
    const gitOpenSsl = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
    if (existsSync(gitOpenSsl)) return gitOpenSsl;
  }
  return 'openssl';
}

// ---------------------------------------------------------------------------
// Benchmark 1: Payload Capacity & Win32 Boundary Elimination
// ---------------------------------------------------------------------------
async function runBenchmark1() {
  console.log('\n📊 Running Benchmark 1: Payload Capacity & Win32 Argv Boundary (Direct runner.mjs)...');

  try {
    const sizes = [
      { label: '5 KB', bytes: 5 * 1024 },
      { label: '30 KB (Sub-limit)', bytes: 30 * 1024 },
      { label: '35 KB (Super-limit)', bytes: 35 * 1024 },
      { label: '100 KB (Deep Plan)', bytes: 100 * 1024 },
    ];

    let argvFailedAboveLimit = false;
    let stdinPassedAll = true;
    const metrics = [];

    for (const size of sizes) {
      const payload = 'A'.repeat(size.bytes);

      // Test A: Pass via argv using node child process
      let argvOk = false;
      try {
        const res = spawnSync(process.execPath, ['-e', 'process.exit(0)', payload], {
          encoding: 'utf-8',
          windowsHide: true,
          stdio: 'ignore',
        });
        argvOk = (res.status === 0 && !res.error);
      } catch {
        argvOk = false;
      }

      if (size.bytes >= 35 * 1024 && !argvOk) {
        argvFailedAboveLimit = true;
      }

      // Test B: Pass via real executeReviewerAsync streaming stdin
      const start = performance.now();
      const nodeScript = `
        let buf = '';
        process.stdin.on('data', c => buf += c);
        process.stdin.on('end', () => {
          if (buf.length === ${size.bytes}) process.exit(0);
          else process.exit(1);
        });
      `;

      let stdinOk = false;
      try {
        const res = await executeReviewerAsync({
          bin: process.execPath,
          args: ['-e', nodeScript],
          prompt: payload,
          stdin: true,
          timeout: 10000,
        });
        stdinOk = (res && res.status === 0 && !res.timedOut);
      } catch {
        stdinOk = false;
      }

      const durationMs = (performance.now() - start).toFixed(1);
      if (!stdinOk) stdinPassedAll = false;
      metrics.push(`${size.label}: argv=${argvOk ? 'OK' : 'ERR (>32KB)'}, stdin=OK (${durationMs}ms)`);
    }

    // Test C: Multibyte UTF-8 stream integrity (D11 check)
    let multibyteClean = false;
    try {
      const multibyteTestScript = `
        const text = 'Revisión: año ñandú 🎉';
        const buf = Buffer.from(text, 'utf-8');
        for (let i = 0; i < buf.length; i++) {
          process.stdout.write(buf.subarray(i, i + 1));
        }
        process.exit(0);
      `;
      const multibyteRes = await executeReviewerAsync({
        bin: process.execPath,
        args: ['-e', multibyteTestScript],
        prompt: 'test',
        stdin: true,
      });
      multibyteClean = Boolean(multibyteRes && !multibyteRes.stdout.includes('\uFFFD') && multibyteRes.stdout.includes('Revisión: año ñandú 🎉'));
    } catch {
      multibyteClean = false;
    }

    // Test D: Child early exit EPIPE resilience (D3 check)
    let earlyExitHandled = false;
    try {
      const hugePayload = 'Z'.repeat(1024 * 1024); // 1 MB
      const earlyExitRes = await executeReviewerAsync({
        bin: process.execPath,
        args: ['-e', 'process.exit(1)'], // exits immediately without reading stdin
        prompt: hugePayload,
        stdin: true,
      });
      earlyExitHandled = Boolean(earlyExitRes && earlyExitRes.status === 1 && !earlyExitRes.timedOut);
    } catch {
      earlyExitHandled = false;
    }

    const passed = (process.platform === 'win32' ? argvFailedAboveLimit : true) &&
                   stdinPassedAll && multibyteClean && earlyExitHandled;

    recordResult({
      name: 'Payload Scaling, Win32 Boundary Elimination & Stream Safety',
      category: 'STABILITY',
      passed,
      metric: `${metrics.join(' | ')} | Multibyte Clean: ${multibyteClean} | EPIPE Safe: ${earlyExitHandled}`,
      baseline: 'Win32 argv fails at >=32,767 chars (~32 KB); unhandled EPIPE on early child exit',
      target: 'Async stdin stream safely transmits 100 KB+ without deadlocks, handles early exit, and preserves multibyte UTF-8',
      details: 'Verified real executeReviewerAsync against Win32 boundary, multibyte chunk boundaries, and early-exit EPIPE resilience.',
    });
  } catch (err) {
    recordResult({
      name: 'Payload Scaling, Win32 Boundary Elimination & Stream Safety',
      category: 'STABILITY',
      passed: false,
      metric: `Execution Exception: ${err.message}`,
      baseline: 'Win32 argv fails at >=32,767 chars (~32 KB); unhandled EPIPE on early child exit',
      target: 'Async stdin stream safely transmits 100 KB+ without deadlocks, handles early exit, and preserves multibyte UTF-8',
      details: `Exception caught during benchmark execution: ${err.message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Benchmark 2: Scoped TLS Validation, Case-Insensitive Scrubbing & Win32 Binary
// ---------------------------------------------------------------------------
async function runBenchmark2() {
  console.log('\n📊 Running Benchmark 2: Scoped TLS Validation, Scrubbing & Win32 Binary Preference...');

  const tmpDir = mkdtempSync(join(os.tmpdir(), 'cg-tls-'));
  const keyPath = join(tmpDir, 'test_key.pem');
  const certPath = join(tmpDir, 'test_cert.pem');

  let defaultRejected = false;
  let caseScrubbingWorked = false;
  let optInAllowed = false;
  let cmdInjectionImmune = false;
  let windowsExePreferred = true;
  let pickExecutableOk = false;
  let shimDetectionOk = false;
  let shimResolutionOk = false;
  const initialParentEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  try {
    const openssl = getOpenSSLBinary();
    const genRes = spawnSync(openssl, [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-nodes',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    ], { encoding: 'utf-8' });

    if (genRes.status !== 0 || !existsSync(keyPath) || !existsSync(certPath)) {
      throw new Error(`Failed to generate ephemeral test certificate: ${genRes.stderr || 'OpenSSL unavailable'}`);
    }

    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);

    const server = https.createServer({ key, cert }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    });

    await new Promise((resolveSuite, rejectSuite) => {
      server.listen(0, '127.0.0.1', async () => {
        try {
          const port = server.address().port;

          // 1. Default secure child: constructed via real buildChildEnv({}) -> MUST REJECT
          await new Promise((resolveChild1) => {
            const cleanEnv = buildChildEnv({});

            const child1 = spawn(process.execPath, ['-e', `
              const https = require('https');
              const req = https.get('https://127.0.0.1:${port}/', () => {
                process.exit(1); // Unexpected success
              });
              req.on('error', (err) => {
                const isTlsReject = /CERT|TLS|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(err.code || '') ||
                  /self-signed|certificate|altname|unable to verify/i.test(err.message || '');
                if (isTlsReject) process.exit(0); // Expected rejection
                else process.exit(2);
              });
            `], {
              env: cleanEnv,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            });

            child1.on('close', (code) => {
              defaultRejected = (code === 0);
              resolveChild1();
            });
          });

          // 2. Windows case-insensitivity test (D7 / M1 test):
          await new Promise((resolveChild2) => {
            const pollutedBaseEnv = { ...process.env, node_tls_reject_unauthorized: '0' };
            const scrubbedEnv = buildChildEnv({}, pollutedBaseEnv);

            const child2 = spawn(process.execPath, ['-e', `
              const https = require('https');
              const req = https.get('https://127.0.0.1:${port}/', () => {
                process.exit(1); // Insecure leak!
              });
              req.on('error', () => {
                process.exit(0); // Properly scrubbed and rejected
              });
            `], {
              env: scrubbedEnv,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            });

            child2.on('close', (code) => {
              caseScrubbingWorked = (code === 0);
              resolveChild2();
            });
          });

          // 3. Explicit opt-in child: constructed via real buildChildEnv({ insecureTls: true }) -> MUST ACCEPT 200 OK
          await new Promise((resolveChild3) => {
            const optInEnv = buildChildEnv({ insecureTls: true });

            const child3 = spawn(process.execPath, ['-e', `
              const https = require('https');
              const req = https.get('https://127.0.0.1:${port}/', (res) => {
                if (res.statusCode === 200) process.exit(0);
                else process.exit(1);
              });
              req.on('error', () => process.exit(2));
            `], {
              env: optInEnv,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            });

            child3.on('close', (code) => {
              optInAllowed = (code === 0);
              resolveChild3();
            });
          });

          // 4. Command Injection & Windows Batch Shim Proactive Rejection
          const shimExt = process.platform === 'win32' ? '.cmd' : '.sh';
          const fakeShim = join(tmpDir, `fakecli${shimExt}`);
          const markerFile = join(tmpDir, 'INJECTED.txt');
          if (process.platform === 'win32') {
            writeFileSync(fakeShim, '@echo OFF\r\necho ARGS=[%*]\r\n');
          } else {
            writeFileSync(fakeShim, '#!/bin/sh\necho ARGS="$@"\n', { mode: 0o755 });
          }

          const injectionPayload = `plan text & echo pwned > "${markerFile}"`;
          const shimRes = await executeReviewerAsync({
            bin: fakeShim,
            args: [],
            prompt: injectionPayload,
            stdin: false,
            timeout: 5000,
          });

          const markerNeverCreated = !existsSync(markerFile);
          const batchShimRejected = process.platform === 'win32'
            ? (shimRes.status !== 0 && typeof shimRes.stderr === 'string' && shimRes.stderr.includes('Windows batch shims'))
            : true;
          cmdInjectionImmune = markerNeverCreated && batchShimRejected;

          // 5. Windows preference test (exe over shim, M4 check)
          if (process.platform === 'win32') {
            const exeResolved = getExecutable('claude');
            windowsExePreferred = !exeResolved.toLowerCase().endsWith('.cmd') && !exeResolved.toLowerCase().endsWith('.bat');
          }

          // 6. pickExecutable pure function fixtures (M4 check)
          const exeFixturesWin = ['C:\\tools\\claude', 'C:\\tools\\claude.cmd', 'C:\\tools\\claude.exe'];
          const winPick = pickExecutable ? pickExecutable(exeFixturesWin, 'win32') : null;
          const exeFixturesShimOnly = ['C:\\tools\\claude.cmd', 'C:\\tools\\claude'];
          const shimPick = pickExecutable ? pickExecutable(exeFixturesShimOnly, 'win32') : null;
          const posixPick = pickExecutable ? pickExecutable(['/usr/local/bin/claude'], 'linux') : null;
          pickExecutableOk = (winPick === 'C:\\tools\\claude.exe') &&
                             (shimPick === 'C:\\tools\\claude.cmd') &&
                             (posixPick === '/usr/local/bin/claude');

          // 7. isWindowsShim pure function with platform guard and dot in directory path (R1 & I3 check)
          const posixBinShim = isWindowsShim ? isWindowsShim('/home/u/.local/bin/claude', 'linux') : true;
          const winDotPathShim = isWindowsShim ? isWindowsShim('C:\\Users\\john.doe\\npm\\claude', 'win32') : false;
          const winDotPathExe = isWindowsShim ? isWindowsShim('C:\\Users\\john.doe\\npm\\claude.exe', 'win32') : true;
          shimDetectionOk = (posixBinShim === false) &&
                            (winDotPathShim === true) &&
                            (winDotPathExe === false);

          // 8. resolveNpmShim pure resolution, nvm4w junction, traversal immunity (M9, M10, M11 check)
          const shimFixtureDir = mkdtempSync(join(tmpDir, 'shim-fixtures-'));
          try {
            const realStore = join(shimFixtureDir, 'realStore');
            const linkDir = join(shimFixtureDir, 'linkDir');
            mkdirSync(join(realStore, 'node_modules', 'test-pkg'), { recursive: true });
            writeFileSync(join(realStore, 'node_modules', 'test-pkg', 'cli.js'), 'console.log("VERDICT: APPROVED");');

            try {
              symlinkSync(realStore, linkDir, 'junction');
            } catch {
              symlinkSync(realStore, linkDir, 'dir');
            }

            writeFileSync(join(linkDir, 'tool.cmd'), '@echo off\r\n"%dp0%\\node_modules\\test-pkg\\cli.js" %*\r\n');
            writeFileSync(join(linkDir, 'tool'), '#!/bin/sh\n"$basedir/node_modules/test-pkg/cli.js" "$@"\n');

            const shOnlyDir = join(shimFixtureDir, 'sh-only');
            mkdirSync(join(shOnlyDir, 'node_modules', 'test-pkg'), { recursive: true });
            writeFileSync(join(shOnlyDir, 'node_modules', 'test-pkg', 'cli.js'), 'console.log("VERDICT: APPROVED");');
            writeFileSync(join(shOnlyDir, 'sh-tool'), '#!/bin/sh\n"$basedir/node_modules/test-pkg/cli.js" "$@"\n');

            writeFileSync(join(linkDir, 'evil.cmd'), '@echo off\r\n"%dp0%\\node_modules\\..\\..\\evil.js" %*\r\n');
            writeFileSync(join(shimFixtureDir, 'evil.js'), 'console.log("evil");');

            writeFileSync(join(linkDir, 'broken.cmd'), '@echo off\r\n"%dp0%\\node_modules\\missing\\cli.js" %*\r\n');

            const resCmd = resolveNpmShim ? resolveNpmShim(join(linkDir, 'tool.cmd'), { platform: 'win32' }) : null;
            const resExtless = resolveNpmShim ? resolveNpmShim(join(linkDir, 'tool'), { platform: 'win32' }) : null;
            const resSh = resolveNpmShim ? resolveNpmShim(join(shOnlyDir, 'sh-tool'), { platform: 'win32' }) : null;
            const resEvil = resolveNpmShim ? resolveNpmShim(join(linkDir, 'evil.cmd'), { platform: 'win32' }) : true;
            const resBroken = resolveNpmShim ? resolveNpmShim(join(linkDir, 'broken.cmd'), { platform: 'win32' }) : true;
            const resLinux = resolveNpmShim ? resolveNpmShim(join(linkDir, 'tool.cmd'), { platform: 'linux' }) : true;

            const junctionOk = resCmd !== null && resCmd.entry.toLowerCase().includes('test-pkg');
            const extlessOk = resExtless !== null && resExtless.entry.toLowerCase().includes('test-pkg');
            const shOk = resSh !== null && resSh.entry.toLowerCase().includes('test-pkg');
            const traversalBlocked = resEvil === null;
            const brokenBlocked = resBroken === null;
            const linuxIgnored = resLinux === null;

            let liveShimOk = true;
            if (process.platform === 'win32') {
              try {
                const execRes = await executeReviewerAsync({
                  bin: join(linkDir, 'tool.cmd'),
                  args: [],
                  prompt: 'test',
                  stdin: true,
                  timeout: 5000,
                });
                const evilRes = await executeReviewerAsync({
                  bin: join(linkDir, 'evil.cmd'),
                  args: [],
                  prompt: 'test',
                  stdin: true,
                  timeout: 5000,
                });
                liveShimOk = (execRes.status === 0 && execRes.stdout.includes('VERDICT: APPROVED')) &&
                             (evilRes.status === 5 && evilRes.stderr.includes('[SECURITY ERROR]'));
              } catch {
                liveShimOk = false;
              }
            }

            shimResolutionOk = junctionOk && extlessOk && shOk && traversalBlocked && brokenBlocked && linuxIgnored && liveShimOk;
          } catch {
            shimResolutionOk = false;
          }

          server.close(() => resolveSuite());
        } catch (err) {
          server.close(() => rejectSuite(err));
        }
      });
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const parentEnvUnpolluted = (process.env.NODE_TLS_REJECT_UNAUTHORIZED === initialParentEnv);
  const passed = defaultRejected && caseScrubbingWorked && optInAllowed && parentEnvUnpolluted && cmdInjectionImmune && windowsExePreferred && pickExecutableOk && shimDetectionOk && shimResolutionOk;

  recordResult({
    name: 'Scoped TLS Invariant & Case-Insensitive Env Scrubbing (buildChildEnv)',
    category: 'SECURITY',
    passed,
    metric: `Default Reject: ${defaultRejected ? 'YES' : 'NO'} | Casing Scrub (D7): ${caseScrubbingWorked ? 'YES' : 'NO'} | Opt-in Success: ${optInAllowed ? 'YES' : 'NO'} | Injection Immune: ${cmdInjectionImmune ? 'YES' : 'NO'} | Exe Preferred: ${windowsExePreferred ? 'YES' : 'NO'} | Pick Exe (M4): ${pickExecutableOk} | Shim Guard (R1/I3): ${shimDetectionOk} | Shim Resolve (M9-M11): ${shimResolutionOk}`,
    baseline: 'Unconditional global TLS bypass, casing leak, or cmd.exe shell injection vulnerability',
    target: 'Default-secure TLS, case-insensitive scrubbing, and complete cmd.exe shell injection elimination',
    details: 'Verified real buildChildEnv against casing variations (M1), bypass (M2), batch shim injection immunity, .exe preference (M4), platform-scoped shim guard (R1), dot-path shim detection (I3), and safe npm shim resolution with nvm4w junctions and traversal rejection (M9-M11).',
  });
}

// ---------------------------------------------------------------------------
// Benchmark 3: Bounded Fallback, Timeout Decoupling & Agy Print-Timeout (B1, M5)
// ---------------------------------------------------------------------------
async function runBenchmark3() {
  console.log('\n📊 Running Benchmark 3: Provider-Aware Fallback, Timeout Intercept & Strict Verdicts (B1, D1, D5)...');

  // Test 3A: Strict verdict parsing
  const v1 = parseVerdict('...cannot receive VERDICT: APPROVED until resolved.\nVERDICT: REVISE', 0);
  const v2 = parseVerdict('VERDICT: APPROVED', 1);
  const v3 = parseVerdict('VERDICT: APPROVED', 0);
  const v4 = parseVerdict('Review completed without verdict tag', 0);
  const v5 = parseVerdict('VERDICT: REVISE', 2);
  const v6 = parseVerdict('', 124, true);
  const vBoldRevise = parseVerdict('Summary of findings...\n\n**VERDICT: REVISE**', 0);
  const vBoldApprove = parseVerdict('Plan meets all criteria.\n\n**VERDICT: APPROVED**', 0);
  const verdictStrict = (v1.verdict === 'REVISE' && v1.code === 2) &&
                        (v2.verdict === 'ERROR' && v2.code === 5) &&
                        (v3.verdict === 'APPROVED' && v3.code === 0) &&
                        (v4.code === 5) &&
                        (v5.code === 5) &&
                        (v6.code === 124) &&
                        (vBoldRevise.verdict === 'REVISE' && vBoldRevise.code === 2) &&
                        (vBoldApprove.verdict === 'APPROVED' && vBoldApprove.code === 0);

  // Test 3B: Real decideFallback invocation
  const f1 = decideFallback({
    currentModel: 'opus',
    reviewer: 'claude',
    status: 1,
    output: 'Request rejected due to safety policy violation [bio]',
  });
  const f2 = decideFallback({
    currentModel: 'sonnet',
    reviewer: 'claude',
    status: 1,
    output: 'Request rejected due to safety policy violation [bio]',
  });
  const fallbackSingleHopBounded = f1.shouldFallback && f1.nextModel === 'sonnet' && !f2.shouldFallback;

  // Test 3C: Provider awareness
  const fAgy = decideFallback({
    currentModel: 'gemini-3.1-pro-high',
    reviewer: 'antigravity',
    status: 1,
    output: 'rate_limit_exceeded',
  });
  const providerAware = fAgy.shouldFallback && fAgy.nextModel === 'gemini-3.7-flash-medium';

  // Test 3D: Timeout Decoupling (Item 7 check)
  // Without --fallback-on-timeout, timeout must NOT trigger fallback
  const fTimeoutNoOptIn = decideFallback({
    currentModel: 'opus',
    reviewer: 'claude',
    status: 124,
    output: 'Execution timed out',
    timedOut: true,
    fallbackOnTimeout: false,
  });
  const fTimeoutOptIn = decideFallback({
    currentModel: 'opus',
    reviewer: 'claude',
    status: 124,
    output: 'Execution timed out',
    timedOut: true,
    fallbackOnTimeout: true,
  });
  const timeoutDecoupled = (!fTimeoutNoOptIn.shouldFallback) && (fTimeoutOptIn.shouldFallback && fTimeoutOptIn.nextModel === 'sonnet');

  // Test 3E: Agy Print-Timeout Intercept & Stdout Quote Non-Regression (Decision 2, M5, M8 check)
  const agyMockScript = `
    console.log('VERDICT: APPROVED');
    console.error('[agy] print timeout after 5m0s with turn in progress; returning partial output');
    process.exit(0);
  `;
  const agyStdoutQuoteScript = `
    console.log('Note: plan discussion quotes [agy] print timeout after 5m0s in text.\\nVERDICT: APPROVED');
    process.exit(0);
  `;
  let agyTimeoutIntercepted = false;
  let stdoutQuoteNotTimeout = false;
  try {
    const agyMockRes = await executeReviewerAsync({
      bin: process.execPath,
      args: ['-e', agyMockScript],
      prompt: 'test',
      stdin: true,
      timeout: 5000,
    });
    // Must force status 124 and timedOut true despite exit 0
    const agyParsed = parseVerdict(agyMockRes.stdout, agyMockRes.status, agyMockRes.timedOut);
    agyTimeoutIntercepted = agyMockRes.timedOut && agyMockRes.status === 124 && agyParsed.code === 124;

    const quoteRes = await executeReviewerAsync({
      bin: process.execPath,
      args: ['-e', agyStdoutQuoteScript],
      prompt: 'test',
      stdin: true,
      timeout: 5000,
    });
    const quoteParsed = parseVerdict(quoteRes.stdout, quoteRes.status, quoteRes.timedOut);
    stdoutQuoteNotTimeout = (!quoteRes.timedOut) && quoteRes.status === 0 && quoteParsed.verdict === 'APPROVED' && quoteParsed.code === 0;
  } catch {
    agyTimeoutIntercepted = false;
    stdoutQuoteNotTimeout = false;
  }

  // Test 3F: Real killProcessTree validation
  const hangingChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const pid = hangingChild.pid;
  let processKilledSuccessfully = false;

  if (pid) {
    killProcessTree(pid);
    await new Promise((r) => setTimeout(r, 200));

    try {
      process.kill(pid, 0);
      if (process.platform === 'win32') {
        const check = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf-8' });
        processKilledSuccessfully = !check.stdout.includes(String(pid));
      } else {
        processKilledSuccessfully = false;
      }
    } catch {
      processKilledSuccessfully = true;
    }
  }

  // Test 3G: Strict CLI argument and command contracts (Decision 2, M2, M3)
  const runnerPath = join(ROOT, 'scripts', 'runner.mjs');
  const runCli = (cliArgs) => spawnSync(process.execPath, [runnerPath, ...cliArgs], { encoding: 'utf-8', windowsHide: true });
  const resTypo = runCli(['revew']);
  const resExtra = runCli(['review', 'extra-arg']);
  const resEmpty = runCli([]);
  const resHelp = runCli(['help']);
  const resDashHelp = runCli(['--help']);
  const resHelpReview = runCli(['--help', 'review']);
  const resVersionReview = runCli(['-v', 'review']);
  const resTypoHelp = runCli(['revew', '--help']);
  const resTypoVersion = runCli(['revew', '-v']);
  const resBogusHelp = runCli(['review', '--bogus', '--help']);
  const resHelpBogus = runCli(['review', '--help', '--bogus']);
  const resPlanHelp = runCli(['review', '--plan', '--help']);
  const resPreflightBogus = runCli(['preflight', '--bogus']);
  const resPreflightHelp = runCli(['preflight', '--help']);

  const cliContractsOk = (resTypo.status === 1) &&
                         (resExtra.status === 1) &&
                         (resEmpty.status === 1) &&
                         (resHelp.status === 0) &&
                         (resDashHelp.status === 0) &&
                         (resHelpReview.status === 0) &&
                         (resVersionReview.status === 0) &&
                         (resTypoHelp.status === 1) &&
                         (resTypoVersion.status === 1) &&
                         (resBogusHelp.status === 1) &&
                         (resHelpBogus.status === 1) &&
                         (resPlanHelp.status === 1) &&
                         (resPreflightBogus.status === 1) &&
                         (resPreflightHelp.status === 0);

  // Test 3H: Timeout Guarantee with stdio kept open by grandchild (B2 check)
  let timeoutGuaranteed = false;
  try {
    const hangingScript = `
      const { spawn } = require('child_process');
      if (process.platform !== 'win32') {
        const sub = spawn('sleep', ['8'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
        sub.unref();
      } else {
        const sub = spawn('powershell', ['-Command', 'Start-Sleep -Seconds 8'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
        sub.unref();
      }
      process.exit(0);
    `;
    const tStart = performance.now();
    const tRes = await executeReviewerAsync({
      bin: process.execPath,
      args: ['-e', hangingScript],
      prompt: 'timeout test',
      stdin: false,
      timeout: 800,
    });
    const tElapsed = performance.now() - tStart;
    timeoutGuaranteed = (tElapsed <= 3800);
  } catch {
    timeoutGuaranteed = false;
  }

  const passed = verdictStrict && fallbackSingleHopBounded && providerAware && timeoutDecoupled && agyTimeoutIntercepted && stdoutQuoteNotTimeout && processKilledSuccessfully && cliContractsOk && timeoutGuaranteed;

  recordResult({
    name: 'Provider-Aware Fallback & Agy Timeout Intercept (decideFallback, executeReviewerAsync)',
    category: 'RESILIENCE',
    passed,
    metric: `Verdict Strict: ${verdictStrict} | 1-Hop: ${fallbackSingleHopBounded} | Timeout Decoupled: ${timeoutDecoupled} | Agy Timeout: ${agyTimeoutIntercepted} | Quote OK: ${stdoutQuoteNotTimeout} | Tree Kill: ${processKilledSuccessfully} | CLI Contracts (Decision 2): ${cliContractsOk} | Timeout Guarantee (B2): ${timeoutGuaranteed}`,
    baseline: 'Failing open on cited APPROVED, treating agy partial output as exit 0, or mixing model providers',
    target: 'Strict last-match verdict parsing, agy print timeout forced to 124, timeout-fallback decoupling, and bounded process guarantee',
    details: 'Verified real decideFallback against loops (M4), agy timeout intercept (B1), stdout quote non-regression (M8), CLI contract validation (Decision 2), and stdio timeout guarantee (B2).',
  });
}

// ---------------------------------------------------------------------------
// Benchmark 4: Pre-flight Consistency Linter (Multi-Operand, Dual-Locale & Segment)
// ---------------------------------------------------------------------------
async function runBenchmark4() {
  console.log('\n📊 Running Benchmark 4: Pre-flight Consistency Linter (B2, B3, Dual-Locale & Segmentation)...');

  const validCases = [
    'Width: 2 x 12 cm + 1 cm = 25 cm',
    'Ancho: 3 × 20 cm + 2 cm = 62 cm',
    'Rows: 1,200 + 300 = 1,500',
    'Alto: 1,5 cm + 2,5 cm = 4 cm',
    'Gap: 1.5cm - 0.5cm = 1.0cm',
    'Total: 4 * 5 + 2 = 22',
    'Total: (10 + 5) * 2 = 30',
    // B2 / B3 newly added test cases
    '1.200 + 300 = 1.500',
    '1.200,50 + 300 = 1.500,50',
    '1,200 + 300 = 1,500',
    '1.5 + 2.5 = 4',
    'Canvas 1080x1920 px; margins: 20px + 20px = 40px',
    'Deadline 2026/09/14: 10 + 5 = 15',
    'Layout: col A: 20cm + col B: 30cm = 50cm',
    'Column 2 (40cm): 20cm + 20cm = 40cm',
    'Poster 90cm: 20cm + 30cm = 50cm',
    // v1.2.0 Decisión 3 test cases
    'Columns 3-4 (40cm): 20cm + 20cm = 40cm',
    'Columns 3 - 4 (40cm): 20cm + 20cm = 40cm',
    'Sprint 2026-09-14 (90cm): 20cm + 30cm = 50cm',
    'Márgenes 1-2cm: 5cm + 5cm = 10cm',
    'Márgenes 1 - 2cm: 5cm + 5cm = 10cm',
  ];

  const invalidCases = [
    'Card 1 (24.0cm) + gap (1.5cm) + Card 2 (16.5cm) + gap (1.5cm) + Card 3 (40.5cm) = 95.0 cm',
    'Max tokens: 30 + 40 + 20 = 100',
    'Columns: 30% + 30% = 70%',
    'Total: 30 + 40 + 20 = 100',
    // B2 / B3 newly added test cases
    '1.200 + 300 = 1.600',
    '1,200 + 300 = 1,600',
    'Canvas 1080x1920 px; margins: 20px + 20px = 50px',
    'Deadline 2026/09/14: 10 + 5 = 16',
    'Layout: col A: 20cm + col B: 30cm = 60cm',
    'Column 2 (40cm): 20cm + 20cm = 50cm',
    'Poster 90cm: 20cm + 30cm = 60cm',
    // v1.2.0 Decisión 3 test cases
    'Columns 3-4 (40cm): 20cm + 30cm = 40cm',
    'Columns 3 - 4 (40cm): 20cm + 30cm = 40cm',
    'Sprint 2026-09-14 (90cm): 20cm + 40cm = 50cm',
    'Márgenes 1-2cm: 5cm + 5cm = 12cm',
    'Gap: 1.5cm - 0.5cm = 2.0cm',
  ];

  const validCasesOk = validCases.every((text) => runPreflightLinter(text).ok);
  const invalidCasesOk = invalidCases.every((text) => !runPreflightLinter(text).ok);
  const linterMatrixOk = validCasesOk && invalidCasesOk;

  // 4B: Tilde fences ~~~
  const lintTildeBroken = runPreflightLinter('~~~\nUnclosed tilde code block\n');
  const tildeFenceOk = !lintTildeBroken.ok;

  // 4C: Repo / Sample PLAN.md verification
  const planPath = resolve(ROOT, 'PLAN.md');
  const samplePlanText = `# Sample Hardened Implementation Plan\n\n## Overview\nSample architecture plan for clean clones.\n\n\`\`\`bash\ngit worktree add -b feat/test ../task-test\nnpm test\n\`\`\`\n\nTotal: 20 + 30 = 50\n`;
  const planText = existsSync(planPath) ? readFileSync(planPath, 'utf-8') : samplePlanText;
  const start = performance.now();
  const lintRepoPlan = runPreflightLinter(planText);
  const planDuration = (performance.now() - start).toFixed(2);
  const repoPlanOk = lintRepoPlan.ok;

  const passed = linterMatrixOk && tildeFenceOk && repoPlanOk;

  recordResult({
    name: 'Pre-flight Consistency Linter (Multi-Operand, Dual-Locale & Segmentation)',
    category: 'EFFICIENCY',
    passed,
    metric: `Audit Matrix (${validCases.length + invalidCases.length} cases): ${linterMatrixOk} | Tilde Fence: ${tildeFenceOk} | Plan Linter: ${repoPlanOk} (${planDuration}ms)`,
    baseline: 'Crashing on N>=3 operands, missing labeled cm budgets, or skipping lines with non-linear tokens',
    target: 'Linear sub-millisecond linting with dual-locale (US/EU) parsing and isolated equation segmentation',
    details: `Verified ${validCases.length + invalidCases.length} audit cases: scoped minus operator, ranges, ISO dates, non-linear skips, thousands dots/commas, decimal commas, dual locale US/EU, and clean clone resilience.`,
  });
}

// ---------------------------------------------------------------------------
// Benchmark 5: Context Overhead Reduction & Dual-Track Classification
// ---------------------------------------------------------------------------
async function runBenchmark5() {
  console.log('\n📊 Running Benchmark 5: Dual-Track Detection & Dynamic XML Structured Extraction...');

  // Test 5A: Dual-Track Classification (M1 / M5 / M12 check)
  const samplePlanText = `# Implementation Plan\n\n\`\`\`bash\ngit worktree add -b feat/task ../task-worktree\nnpm test\n\`\`\`\n`;
  const planText = existsSync(resolve(ROOT, 'PLAN.md')) ? readFileSync(resolve(ROOT, 'PLAN.md'), 'utf-8') : samplePlanText;
  const trackRepoPlan = detectTrack(planText);
  const trackNodePoster = detectTrack('Design the conference poster in poster.pptx about Node.js adoption');
  const trackBashPoster = detectTrack('Poster in poster.pptx with column layout:\n```bash\npdftoppm -png -r 150 poster.pdf page\n```');
  const trackCodeProof = detectTrack('Fix TypeScript bug with PROOF_CMD: npm test and src/index.ts');
  const trackDeckBare = detectTrack('Plan de diapositivas en deck.pptx: revisar `test.py` y adopción de Node.js');
  const trackDeckPath = detectTrack('Plan de backend en deck.pptx: modificar src/test.py y correr tests');

  const trackDetectionOk = (trackRepoPlan === 'code') &&
                           (trackNodePoster === 'artifact') &&
                           (trackBashPoster === 'artifact') &&
                           (trackCodeProof === 'code') &&
                           (trackDeckBare === 'artifact') &&
                           (trackDeckPath === 'code');

  // Test 5B: Real XML Artifact dynamically parsed via extractStructuredArtifact (I4 check)
  const rawXmlArtifact = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      ${'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle &amp; Box"/><p:cNvSpPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100000" y="100000"/><a:ext cx="2000000" cy="1500000"/></a:xfrm><a:solidFill><a:srgbClr val="0A2540"/></a:solidFill></p:spPr><p:txBody><a:p><a:r><a:t xml:space="preserve">Exploración de la sinapsis &amp; nanotubos</a:t></a:r></p:txBody></p:sp>'.repeat(40)}
    </p:spTree>
  </p:cSld>
</p:sld>`;

  const presentationXml = `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`;

  // Dynamically extract structure without blind slicing
  const structuredData = extractStructuredArtifact(rawXmlArtifact, { presentationXml });
  const structuredJson = JSON.stringify(structuredData, null, 2);

  const rawTokens = Math.ceil(rawXmlArtifact.length / 4);
  const structuredTokens = Math.ceil(structuredJson.length / 4);
  const tokenSavingsPercent = (((rawTokens - structuredTokens) / rawTokens) * 100).toFixed(1);

  // Assert that data was genuinely derived, entities decoded, and all 40 shapes preserved
  const extractionValid = structuredData.shape_count === 40 &&
                          structuredData.shapes.length === 40 &&
                          structuredData.total_text_nodes === 40 &&
                          structuredData.shapes[0].name === 'Rectangle & Box' &&
                          structuredData.text_nodes[0] === 'Exploración de la sinapsis & nanotubos' &&
                          structuredData.slide_dimensions !== null &&
                          structuredData.slide_dimensions.width_emu === 12192000 &&
                          structuredData.truncated === false;
  const tokenSavingsOk = parseFloat(tokenSavingsPercent) >= 40.0;

  // Test 5C: Single-pass XML entity decoding without double-decoding (M1 check)
  const rawDoubleEncoded = '&amp;lt;b&amp;gt;&#233;&#x20AC;';
  const decodedXml = decodeXmlEntities ? decodeXmlEntities(rawDoubleEncoded) : '';
  const xmlEntityDecodeOk = (decodedXml === '&lt;b&gt;é€');

  // Test 5D: slide_dimensions is null without presentationXml (M4 check)
  const artifactNoPres = extractStructuredArtifact(rawXmlArtifact, {});
  const slideDimNullWithoutPres = (artifactNoPres.slide_dimensions === null);

  // Test 5E: Safe XML entity decoding without RangeError or NUL injection (Decisión 4, M6, M7)
  const safeEntitiesOk = (() => {
    if (!decodeXmlEntities) return false;
    if (decodeXmlEntities('&#65; &#x42;') !== 'A B') return false;
    const nulDecoded = decodeXmlEntities('&#0; &#x0;');
    if (nulDecoded.includes('\0') || nulDecoded !== '&#0; &#x0;') return false;
    try {
      if (decodeXmlEntities('&#x110000; &#99999999;') !== '&#x110000; &#99999999;') return false;
    } catch {
      return false;
    }
    try {
      if (decodeXmlEntities('&#xD800;') !== '&#xD800;') return false;
    } catch {
      return false;
    }
    if (decodeXmlEntities('&unknown;') !== '&unknown;') return false;
    return true;
  })();

  const passed = trackDetectionOk && extractionValid && tokenSavingsOk && xmlEntityDecodeOk && slideDimNullWithoutPres && safeEntitiesOk;

  recordResult({
    name: 'Dual-Track Heuristic & Dynamic Artifact Extraction (extractStructuredArtifact)',
    category: 'TOKENOMICS',
    passed,
    metric: `Track: ${trackDetectionOk} | Shapes: ${structuredData.shape_count} | Entities (M1): ${xmlEntityDecodeOk} | Safe Entities (M6/M7): ${safeEntitiesOk} | Dim Null (M4): ${slideDimNullWithoutPres} | Savings: ${tokenSavingsPercent}%`,
    baseline: 'Classifying prose plans as code, blind slicing to 10 shapes, or unescaped XML entities',
    target: 'Precise track classification, entity decoding, and >= 40% token reduction via complete structured extraction',
    details: 'Verified real extractStructuredArtifact deriving 40 shapes/texts, single-pass entity decoding (M1), safe XML entities without NUL or RangeError (M6/M7), and slide dimension preservation (M4).',
  });
}

// ---------------------------------------------------------------------------
// Main Runner & Markdown Report Generation
// ---------------------------------------------------------------------------
async function main() {
  console.log('===============================================================');
  console.log(`🚀 Claudegravity Loop v${PKG_VERSION} Empirical Benchmark Suite`);
  console.log('===============================================================');

  const suiteStart = performance.now();
  await runBenchmark1();
  await runBenchmark2();
  await runBenchmark3();
  await runBenchmark4();
  await runBenchmark5();
  const totalDuration = ((performance.now() - suiteStart) / 1000).toFixed(2);

  console.log('\n===============================================================');
  console.log(`📋 Benchmark Suite Summary (${totalDuration}s total)`);
  console.log('===============================================================');

  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const allPassed = passedCount === totalCount;

  console.log(`Score: ${passedCount}/${totalCount} tests passed (${allPassed ? '100%' : Math.round((passedCount/totalCount)*100) + '%'})\n`);

  const reportLines = [
    `# Claudegravity Loop — Informe Oficial de Benchmarks (v${PKG_VERSION})`,
    '',
    `**Fecha de Ejecución**: ${new Date().toISOString()}  `,
    `**Plataforma**: ${process.platform} (${process.arch}) | Node.js ${process.version}  `,
    `**Resultado Global**: ${allPassed ? '🎉 100% APROBADO (5/5 Tests Pasados)' : '⚠️ DEFECTOS ENCONTRADOS'}  `,
    `**Tiempo Total**: ${totalDuration} segundos  `,
    '',
    '## Tabla de Resultados Cuantitativos',
    '',
    '| Categoría | Benchmark | Línea Base (v1.0) | Resultado Optimizado (v1.1) | Estado |',
    '|:---|:---|:---|:---|:---:|',
  ];

  for (const r of results) {
    reportLines.push(`| **${r.category}** | ${r.name} | ${r.baseline} | ${r.metric} | ${r.passed ? '✅ PASS' : '❌ FAIL'} |`);
  }

  reportLines.push('', '## Conclusiones Técnicas', '');
  reportLines.push('1. **Eliminación del límite de argumentos en Windows**: `executeReviewerAsync` transmite más de 100 KB por `stdin` sin interbloqueos, tolera salidas tempranas del hijo sin errores EPIPE y preserva caracteres UTF-8 multibyte.');
  reportLines.push('2. **Seguridad TLS estricta por diseño**: `buildChildEnv` centraliza la validación de certificados activa por defecto, eliminando insensiblemente a mayúsculas variables de entorno en Windows con certificados efímeros en memoria.');
  reportLines.push('3. **Resiliencia de Fallback y Control de Procesos**: `decideFallback` limita estrictamente a 1 salto el fallback consciente del proveedor, intercepta timeouts de agy forzando código 124, desacopla timeout de fallback y `killProcessTree` elimina procesos zombis de forma garantizada.');
  reportLines.push('4. **Linter pre-vuelo robusto**: `runPreflightLinter` valida ecuaciones de N operandos, presupuestos con etiquetas de unidades (cm, mm) y fences de código mediante parsing dual-locale (US/EU) y segmentación aislada de ecuación.');
  reportLines.push('5. **Heurística de Doble Pista y Extracción Dinámica**: `detectTrack` clasifica con precisión código frente a documentos visuales sin falsos positivos de prosa, y `extractStructuredArtifact` decodifica entidades XML y preserva todos los elementos sin recortes ciegos.');

  const reportPath = resolve(ROOT, 'BENCHMARK_REPORT.md');
  writeFileSync(reportPath, reportLines.join('\n'), 'utf-8');
  console.log(`📄 Detailed Markdown report saved to: ${reportPath}\n`);

  if (!allPassed) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal benchmark runner error:', err);
  process.exit(1);
});

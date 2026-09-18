#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

console.log('Validating Claudegravity Loop manifests and skills...\n');

let errors = 0;

export function parseDescription(fm) {
  let descText = '';
  const inlineMatch = fm.match(/^description:\s*([^\r\n>|]+)/m);
  if (inlineMatch && inlineMatch[1].trim()) {
    descText = inlineMatch[1].trim();
  } else {
    const blockMatch = fm.match(/^description:\s*(?:[>|]-?)\s*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)+)/m);
    if (blockMatch && blockMatch[1].trim()) {
      descText = blockMatch[1].trim();
    }
  }
  return descText;
}

export function validateSkillFrontmatter(content, expectedName) {
  const validationErrors = [];
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    validationErrors.push("Missing valid '---' frontmatter");
    return { valid: false, errors: validationErrors };
  }
  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*([^\r\n]+)/m);
  const descText = parseDescription(fm);
  if (!nameMatch || nameMatch[1].trim() !== expectedName) {
    validationErrors.push(`Name mismatch: expected '${expectedName}', got '${nameMatch ? nameMatch[1].trim() : 'none'}'`);
  }

  // AX1 guard: skills must not contain unresolved CLAUDE_PLUGIN_ROOT
  if (content.includes('CLAUDE_PLUGIN_ROOT')) {
    validationErrors.push("Skill content must not contain 'CLAUDE_PLUGIN_ROOT'");
  }

  // AX3 guard: inline unquoted description containing ': ' breaks strict YAML in agy
  const inlineHeaderMatch = fm.match(/^description:\s*(?![-|>])(.*)$/m);
  if (inlineHeaderMatch) {
    const inlineRaw = inlineHeaderMatch[1].trim();
    const isQuoted = (inlineRaw.startsWith('"') && inlineRaw.endsWith('"')) ||
                     (inlineRaw.startsWith("'") && inlineRaw.endsWith("'"));
    if (!isQuoted && /:\s+/.test(inlineRaw)) {
      validationErrors.push("Inline unquoted description must not contain ': ' (causes YAML parsing failure in agy)");
    }
  }

  if (!descText) {
    validationErrors.push("Missing non-empty description");
  } else if (descText.length > 1024) {
    validationErrors.push(`Description exceeds 1024 characters (${descText.length})`);
  }
  return { valid: validationErrors.length === 0, errors: validationErrors };
}

export function validateCiWorkflow(ciContent) {
  const validationErrors = [];

  function getJobLines(content, jobId) {
    const lines = content.split(/\r?\n/);
    let inJob = false;
    let jobIndent = -1;
    const jobLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^(\s*)([a-zA-Z0-9_-]+):\s*$/);
      if (match) {
        const indent = match[1].length;
        const id = match[2];
        if (inJob) {
          if (indent <= jobIndent) {
            break;
          }
        } else if (id === jobId && indent > 0) {
          inJob = true;
          jobIndent = indent;
          continue;
        }
      }
      if (inJob) {
        jobLines.push(line);
      }
    }
    return inJob ? jobLines : null;
  }

  const testLines = getJobLines(ciContent, 'test');
  const nodeLines = getJobLines(ciContent, 'test-on-node');

  if (!testLines) {
    validationErrors.push("Missing 'test' job");
  } else {
    const testText = testLines.join('\n');
    if (/continue-on-error\s*:/i.test(testText)) {
      validationErrors.push("Job 'test' must not contain 'continue-on-error'");
    }

    const stepsIdx = testLines.findIndex((l) => /^\s*steps:\s*$/.test(l));
    if (stepsIdx === -1) {
      validationErrors.push("Job 'test' missing 'steps:'");
    } else {
      const stepLines = testLines.slice(stepsIdx + 1);
      if (stepLines.some((l) => /^\s*if:\s*/.test(l))) {
        validationErrors.push("Job 'test' must not contain step-level 'if:' conditions");
      }
      const hasNpmTest = stepLines.some((l) => /^\s*run:\s*npm test\s*$/.test(l));
      const hasBenchmark = stepLines.some((l) => /^\s*run:\s*npm run benchmark\s*$/.test(l));
      if (!hasNpmTest) validationErrors.push("Job 'test' must contain exact step 'run: npm test'");
      if (!hasBenchmark) validationErrors.push("Job 'test' must contain exact step 'run: npm run benchmark'");
    }

    if (/\b(?:exclude|include)\s*:/i.test(testText)) {
      validationErrors.push("Matrix in 'test' must not contain 'exclude:' or 'include:'");
    }
    const hasUbuntu = /ubuntu-latest/.test(testText);
    const hasWindows = /windows-latest/.test(testText);
    const hasMacos = /macos-latest/.test(testText);
    if (!hasUbuntu || !hasWindows || !hasMacos) {
      validationErrors.push("Matrix in 'test' must include ubuntu-latest, windows-latest, and macos-latest");
    }
    const hasNode18 = /18\.x/.test(testText);
    const hasNode20 = /20\.x/.test(testText);
    const hasNode22 = /22\.x/.test(testText);
    if (!hasNode18 || !hasNode20 || !hasNode22) {
      validationErrors.push("Matrix in 'test' must include node-version 18.x, 20.x, and 22.x");
    }
  }

  if (!nodeLines) {
    validationErrors.push("Missing 'test-on-node' job");
  } else {
    const nodeText = nodeLines.join('\n');
    if (!nodeLines.some((l) => /^\s*name:\s*Test on Node\s*$/.test(l))) {
      validationErrors.push("Job 'test-on-node' must have 'name: Test on Node'");
    }
    if (!nodeLines.some((l) => /^\s*needs:\s*test\s*$/.test(l))) {
      validationErrors.push("Job 'test-on-node' must have 'needs: test'");
    }
    if (!nodeLines.some((l) => /^\s*if:\s*always\(\)\s*$/.test(l))) {
      validationErrors.push("Job 'test-on-node' must have exact condition 'if: always()'");
    }
    if (/continue-on-error\s*:/i.test(nodeText)) {
      validationErrors.push("Job 'test-on-node' must not contain 'continue-on-error'");
    }

    const stepsIdx = nodeLines.findIndex((l) => /^\s*steps:\s*$/.test(l));
    if (stepsIdx === -1) {
      validationErrors.push("Job 'test-on-node' missing 'steps:'");
    } else {
      const stepLines = nodeLines.slice(stepsIdx + 1);
      if (stepLines.some((l) => /^\s*if:\s*/.test(l))) {
        validationErrors.push("Job 'test-on-node' must not contain step-level 'if:' conditions");
      }

      const runIdx = stepLines.findIndex((l) => /^\s*run:\s*/.test(l));
      if (runIdx === -1) {
        validationErrors.push("Job 'test-on-node' missing 'run:' command");
      } else {
        const runHeader = stepLines[runIdx];
        const runIndent = runHeader.match(/^(\s*)/)[1].length;
        const commands = [];
        const isBlockRun = /^\s*run:\s*[|>]\s*$/.test(runHeader);
        if (!isBlockRun) {
          commands.push(runHeader.replace(/^\s*run:\s*/, '').trim());
        } else {
          for (let i = runIdx + 1; i < stepLines.length; i++) {
            const line = stepLines[i];
            if (!line.trim()) continue;
            const lineIndent = line.match(/^(\s*)/)[1].length;
            if (lineIndent <= runIndent) break;
            commands.push(line.trim());
          }
        }

        const filtered = commands.filter((cmd) => {
          if (!cmd || cmd.startsWith('#')) return false;
          // Strict literal echo without shell control operators
          if (/^echo\s+["'][^;&|`$><]*["']\s*$/.test(cmd)) return false;
          return true;
        });

        const expectedCmd = '[ "${{ needs.test.result }}" = "success" ] || exit 1';
        if (filtered.length !== 1 || filtered[0] !== expectedCmd) {
          validationErrors.push(`Job 'test-on-node' run command must be strictly '${expectedCmd}', got: ${filtered.join('; ')}`);
        }
      }
    }
  }

  return { valid: validationErrors.length === 0, errors: validationErrors };
}

// 1. Validate package.json
const pkgPath = join(ROOT, 'package.json');
let pkgVersion = null;
if (!existsSync(pkgPath)) {
  console.error('❌ package.json missing!');
  errors++;
} else {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkgVersion = pkg.version;
  console.log(`✅ package.json valid (${pkg.name} v${pkg.version})`);
}

// 2. Validate .claude-plugin/plugin.json and skills
const pluginPath = join(ROOT, '.claude-plugin', 'plugin.json');
let pluginVersion = null;
if (!existsSync(pluginPath)) {
  console.error('❌ .claude-plugin/plugin.json missing!');
  errors++;
} else {
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
  pluginVersion = plugin.version;
  console.log(`✅ plugin.json valid (${plugin.name} v${plugin.version})`);

  if (Array.isArray(plugin.skills)) {
    for (const skillRelPath of plugin.skills) {
      const fullPath = join(ROOT, skillRelPath);
      const skillFile = existsSync(join(fullPath, 'SKILL.md')) ? join(fullPath, 'SKILL.md') : fullPath;
      if (!existsSync(fullPath) && !existsSync(skillFile)) {
        console.error(`❌ Declared skill directory not found at: ${skillRelPath}`);
        errors++;
      } else {
        if (existsSync(skillFile)) {
          const content = readFileSync(skillFile, 'utf-8');
          const expectedName = skillRelPath.split(/[/\\]/).filter(Boolean).pop();
          const res = validateSkillFrontmatter(content, expectedName);
          if (!res.valid) {
            res.errors.forEach((e) => console.error(`❌ ${e} in ${skillRelPath}`));
            errors++;
          }
        }
        console.log(`  - Skill verified -> ${skillRelPath}`);
      }
    }
  }
}

// 3. Validate .claude-plugin/marketplace.json
const mktPath = join(ROOT, '.claude-plugin', 'marketplace.json');
if (!existsSync(mktPath)) {
  console.error('❌ .claude-plugin/marketplace.json missing!');
  errors++;
} else {
  const mkt = JSON.parse(readFileSync(mktPath, 'utf-8'));
  const mktPlugin = mkt.plugins && mkt.plugins[0];
  const mktVersion = mktPlugin?.version;
  console.log(`✅ marketplace.json valid (${mkt.name} v${mktVersion})`);

  // Version synchronization check
  if (pkgVersion && pluginVersion && mktVersion) {
    if (pkgVersion !== pluginVersion || pkgVersion !== mktVersion) {
      console.error(`❌ Version mismatch across manifests! package.json=${pkgVersion}, plugin.json=${pluginVersion}, marketplace.json=${mktVersion}`);
      errors++;
    } else {
      console.log(`✅ All manifests synchronized at version ${pkgVersion}`);
    }
  }
}

// 4. Validate .github/workflows/ci.yml aggregator job (B4 M5)
const ciPath = join(ROOT, '.github', 'workflows', 'ci.yml');
if (!existsSync(ciPath)) {
  console.error('❌ .github/workflows/ci.yml missing!');
  errors++;
} else {
  const ciContent = readFileSync(ciPath, 'utf-8');
  const ciRes = validateCiWorkflow(ciContent);
  if (!ciRes.valid) {
    ciRes.errors.forEach((e) => console.error(`❌ CI aggregator: ${e}`));
    errors++;
  } else {
    console.log('✅ CI aggregator verified in .github/workflows/ci.yml (Test on Node requires success)');
  }
}

// 5. Negative Fixtures Verification (I1 & B4 M5 check)
const emptyDescBlock = `---\nname: test-skill\ndescription: >-\n---`;
const emptyDescInline = `---\nname: test-skill\ndescription:\n---`;
const realCiContent = existsSync(ciPath) ? readFileSync(ciPath, 'utf-8') : '';

const negativeCiFixtures = [
  { name: 'skipped bypass in aggregator', content: realCiContent.replace('[ "${{ needs.test.result }}" = "success" ] || exit 1', '[ "${{ needs.test.result }}" = "skipped" ] && exit 0') },
  { name: 'compound echo with exit 0', content: realCiContent.replace('echo "All matrix test jobs succeeded."', 'echo ok && exit 0') },
  { name: 'step-level if in aggregator', content: realCiContent.replace('run: |', 'if: false\n        run: |') },
  { name: 'step-level if in matrix', content: realCiContent.replace('run: npm test', 'if: false\n        run: npm test') },
  { name: 'job if conditioned in aggregator', content: realCiContent.replace('if: always()', 'if: always() && false') },
  { name: 'npm test with || true', content: realCiContent.replace('run: npm test', 'run: npm test || true') },
  { name: 'continue-on-error in job', content: realCiContent.replace('runs-on: ${{ matrix.os }}', 'runs-on: ${{ matrix.os }}\n    continue-on-error: true') },
  { name: 'continue-on-error in step', content: realCiContent.replace('run: npm test', 'continue-on-error: true\n        run: npm test') },
  { name: 'continue-on-error in aggregator job', content: realCiContent.replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-latest\n    continue-on-error: true') },
  { name: 'continue-on-error in aggregator step', content: realCiContent.replace('run: |', 'continue-on-error: true\n        run: |') },
  { name: 'matrix with exclude', content: realCiContent.replace('fail-fast: false', 'fail-fast: false\n      matrix:\n        exclude:\n          - os: macos-latest') },
  { name: 'matrix with include modifying os', content: realCiContent.replace('fail-fast: false', 'fail-fast: false\n      matrix:\n        include:\n          - os: custom-os') },
  { name: 'benchmark step removed', content: realCiContent.replace(/- name: Run Empirical Benchmarks[\s\S]*?run: npm run benchmark/m, '') },
];

const tooLongDesc = `---\nname: test-skill\ndescription: ${'a'.repeat(1025)}\n---`;
const unquotedInlineWithColon = `---\nname: test-skill\ndescription: Review implementation: find flaws\n---\nBody here`;
const skillWithPluginRoot = `---\nname: test-skill\ndescription: >-\n  A valid description.\n---\nnode "\${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs"`;

if (validateSkillFrontmatter(emptyDescBlock, 'test-skill').valid) {
  console.error('❌ Negative fixture failed: empty block description was accepted!');
  errors++;
}
if (validateSkillFrontmatter(emptyDescInline, 'test-skill').valid) {
  console.error('❌ Negative fixture failed: empty inline description was accepted!');
  errors++;
}
if (validateSkillFrontmatter(tooLongDesc, 'test-skill').valid) {
  console.error('❌ Negative fixture failed: description exceeding 1024 chars was accepted!');
  errors++;
}
if (validateSkillFrontmatter(unquotedInlineWithColon, 'test-skill').valid) {
  console.error('❌ Negative fixture failed: unquoted inline description with colon was accepted!');
  errors++;
}
if (validateSkillFrontmatter(skillWithPluginRoot, 'test-skill').valid) {
  console.error('❌ Negative fixture failed: skill containing CLAUDE_PLUGIN_ROOT was accepted!');
  errors++;
}
for (const fix of negativeCiFixtures) {
  const res = validateCiWorkflow(fix.content);
  if (res.valid) {
    console.error(`❌ Negative fixture failed: ${fix.name} was accepted!`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n❌ Validation failed with ${errors} error(s).\n`);
  process.exit(1);
} else {
  console.log('\n🎉 All validations passed successfully!\n');
  process.exit(0);
}

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
  if (!descText) {
    validationErrors.push("Missing non-empty description");
  }
  return { valid: validationErrors.length === 0, errors: validationErrors };
}

export function validateCiWorkflow(ciContent) {
  const validationErrors = [];
  const hasAggregatorJob = ciContent.includes('test-on-node:');
  const hasAggregatorName = /name:\s*Test on Node\b/.test(ciContent);
  const hasNeedsTest = /needs:\s*test\b/.test(ciContent);
  const hasIfAlways = /if:\s*always\(\)/.test(ciContent);
  const hasSuccessOnly = ciContent.includes('[ "${{ needs.test.result }}" = "success" ] || exit 1');
  const acceptsSkipped = /needs\.test\.result\s*["']?\s*==?\s*["']?skipped/i.test(ciContent) ||
                         /["']?skipped["']?\s*==?\s*needs\.test\.result/i.test(ciContent);

  if (!hasAggregatorJob) validationErrors.push("Missing 'test-on-node' job");
  if (!hasAggregatorName) validationErrors.push("Job 'test-on-node' must be named 'Test on Node'");
  if (!hasNeedsTest) validationErrors.push("Job 'test-on-node' must have 'needs: test'");
  if (!hasIfAlways) validationErrors.push("Job 'test-on-node' must have 'if: always()'");
  if (!hasSuccessOnly || acceptsSkipped) validationErrors.push("Aggregator condition must strictly require success without accepting skipped");

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
const skippedCiWorkflow = `
jobs:
  test-on-node:
    name: Test on Node
    needs: test
    if: always()
    steps:
      - run: [ "\${{ needs.test.result }}" = "skipped" ] || exit 1
`;
if (validateSkillFrontmatter(emptyDescBlock, 'test-skill').valid) {
  console.error('❌ Negative fixture failed: empty block description was accepted!');
  errors++;
}
if (validateSkillFrontmatter(emptyDescInline, 'test-skill').valid) {
  console.error('❌ Negative fixture failed: empty inline description was accepted!');
  errors++;
}
if (validateCiWorkflow(skippedCiWorkflow).valid) {
  console.error('❌ Negative fixture failed: CI workflow accepting skipped was accepted!');
  errors++;
}

if (errors > 0) {
  console.error(`\n❌ Validation failed with ${errors} error(s).\n`);
  process.exit(1);
} else {
  console.log('\n🎉 All validations passed successfully!\n');
  process.exit(0);
}

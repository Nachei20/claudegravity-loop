#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

console.log('Validating Claudegravity Loop manifests and skills...\n');

let errors = 0;

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

// 2. Validate .claude-plugin/plugin.json
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
      const skillFile = join(fullPath, 'SKILL.md');
      if (!existsSync(fullPath) && !existsSync(skillFile)) {
        console.error(`❌ Declared skill directory not found at: ${skillRelPath}`);
        errors++;
      } else {
        console.log(`  - Skill verified -> ${skillRelPath}`);
      }
    }
  } else if (plugin.skills && typeof plugin.skills === 'object') {
    for (const [skillName, skillRelPath] of Object.entries(plugin.skills)) {
      const fullPath = join(ROOT, skillRelPath);
      if (!existsSync(fullPath)) {
        console.error(`❌ Declared skill '${skillName}' not found at: ${skillRelPath}`);
        errors++;
      } else {
        console.log(`  - Skill '${skillName}' verified -> ${skillRelPath}`);
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

if (errors > 0) {
  console.error(`\n❌ Validation failed with ${errors} error(s).\n`);
  process.exit(1);
} else {
  console.log('\n🎉 All validations passed successfully!\n');
  process.exit(0);
}

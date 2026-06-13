import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Ignore list
const ignoreDirs = new Set(['node_modules', '.git', 'logs', 'starlight-security@1.1.1']);
const ignoreFiles = new Set(['package-lock.json', 'scripts/deep-scan.js']);

// Replacement rules
const replacements = [
  [/\bTitanBotError\b/g, 'StarlightError'],
  [/'TitanBotError'/g, "'StarlightError'"],
  [/"TitanBotError"/g, '"StarlightError"'],
  [/'TitanBot Shop'/g, "'NH_starlightsecurity Shop'"],
  [/"TitanBot Shop"/g, '"NH_starlightsecurity Shop"'],
  [/\bTitanBot\b/g, 'NH_starlightsecurity'],
  [/\bTITANBOT\b/g, 'NH_STARLIGHTSECURITY'],
  [/\btitanbot\b/g, 'nh_starlightsecurity'],
];

// Track bare catch blocks in events
const bareCatchFindings = [];

function shouldIgnore(filePath) {
  const parts = filePath.replace(root, '').split(path.sep).filter(Boolean);
  for (const part of parts) {
    if (ignoreDirs.has(part)) return true;
  }
  return ignoreFiles.has(path.basename(filePath));
}

// Directories to scan
const targets = [
  'src/events',
  'src/utils',
  'src/services',
  'src/config',
  'src/handlers',
  'src/interactions',
  'src',
  '.'
];

function collectFiles() {
  const files = [];
  for (const target of targets) {
    const fullPath = path.join(root, target);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(fullPath);
      for (const entry of entries) {
        const fp = path.join(fullPath, entry);
        if (shouldIgnore(fp)) continue;
        const s = fs.statSync(fp);
        if (s.isFile() && !fp.endsWith('.lock')) {
          files.push(fp);
        }
      }
    } else if (stat.isFile()) {
      if (!shouldIgnore(fullPath)) files.push(fullPath);
    }
  }
  return files;
}

const files = collectFiles();
let filesChanged = 0;

for (const filePath of files) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    continue;
  }

  // Check for TitanBot matches first
  const lower = content.toLowerCase();
  if (lower.includes('titanbot')) {
    console.log(`  ⚡ TitanBot FOUND → ${path.relative(root, filePath)}`);
  }

  // Check for bare catch blocks in events
  if (filePath.includes('/events/') && filePath.endsWith('.js')) {
    const catchMatch = content.match(/catch\s*\((\w+)\)\s*\{([^}]*)\}/g);
    if (catchMatch) {
      for (const block of catchMatch) {
        const body = block.replace(/catch\s*\(\w+\)\s*\{\s*/, '').replace(/\s*\}$/, '');
        const trimmed = body.trim();
        if (!trimmed || trimmed === '') {
          bareCatchFindings.push(path.relative(root, filePath));
        } else if (
          !trimmed.includes('logger') &&
          !trimmed.includes('handleInteractionError') &&
          trimmed.startsWith('console.')
        ) {
          bareCatchFindings.push(`${path.relative(root, filePath)} (bare: ${trimmed.split('\n')[0].trim()})`);
        }
      }
    }
  }

  // Apply replacements
  let original = content;
  for (const [regex, replacement] of replacements) {
    content = content.replace(regex, replacement);
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf-8');
    filesChanged++;
    if (original !== content && !content.toLowerCase().includes('titanbot') && !original.toLowerCase().includes('titanbot')) {
      // Edge case caught by regex but no titanbot - skip
    }
  }
}

console.log(`\n✅ Files updated in this sweep: ${filesChanged}`);
console.log(`\n📋 Checked directories: src/events/, src/utils/, src/services/, src/config/, src/handlers/, src/interactions/, root files`);

// Check for any residual TitanBot mentions via git
console.log('\n🔍 Checking for any residual TitanBot mentions (git grep)...');
try {
  const result = require('child_process').execSync('git grep -in "titanbot" -- ":!node_modules" ":!starlight-security@1.1.1" 2>/dev/null || true', { encoding: 'utf-8', cwd: root });
  const lines = result.trim().split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    console.log(`  ⚠️  Residual TitanBot references found:\n${lines.map(l => '    ' + l).join('\n')}`);
  } else {
    console.log('  ✅ No residual TitanBot references found anywhere.');
  }
} catch {
  console.log('  ⚠️  Could not run git grep (not a git repo or git unavailable). Manual check recommended.');
}

if (bareCatchFindings.length > 0) {
  console.log(`\n⚠️  Bare catch blocks in events/ (${bareCatchFindings.length}):`);
  for (const f of bareCatchFindings) {
    console.log(`  - ${f}`);
  }
} else {
  console.log('\n✅ No bare catch blocks found in src/events/.');
}

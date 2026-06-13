#!/usr/bin/env node
/**
 * refactor-commands.js — One-shot production polish for all src/commands/ files.
 *
 * 1. Injects InteractionHelper / handleInteractionError imports     (if missing)
 * 2. Wraps bare deferReply → safeDefer / reply → safeReply / editReply → safeEditReply
 * 3. Standardises every catch-block logger.error with structured context
 * 4. Injects safeDefer at the top of DB-heavy execute() functions   (if missing)
 * 5. Adds handleInteractionError fallback to bare catch blocks
 *
 * Run:   node refactor-commands.js
 * Then:  npm start
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, 'src/commands');
const STATS = { total: 0, changed: 0, errors: 0, skipped: 0 };

// ---------------------------------------------------------------------------
//  Guard helpers
// ---------------------------------------------------------------------------
const hasInteractionHelperImport = (c) =>
  /from\s+['"]\.\.\/utils\/interactionHelper\.js['"]/.test(c) ||
  /from\s+['"]\.\.\/\.\.\/utils\/interactionHelper\.js['"]/.test(c) ||
  /\bInteractionHelper\b/.test(c);

const hasHandleErrorImport = (c) =>
  /from\s+['"]\.\.\/utils\/errorHandler\.js['"]/.test(c) ||
  /from\s+['"]\.\.\/\.\.\/utils\/errorHandler\.js['"]/.test(c) ||
  /handleInteractionError/.test(c);

const getCmdName = (c) => {
  const m = c.match(/\.setName\(\s*['"]([^'"]+)['"]\s*\)/);
  return m ? m[1] : 'unknown';
};

const getImportPath = (file, util) => {
  const rel = path.relative(ROOT, file);
  const depth = path.dirname(rel).split(path.sep).filter(Boolean).length + 1;
  return '../'.repeat(depth) + `utils/${util}`;
};

// Simple heuristic for DB-heavy or async-heavy commands
const DB_HEAVY = [
  'await db', 'await guildConfig', 'await sql', '.pool.query',
  'await moderationService', 'await leveling', 'await ticket',
  'await loggingService', 'await verificationService', 'await welcomeService',
  'await voiceService', 'await giveawayService', 'await antinukeService',
  'await birthdayService', 'await getServerCounters', 'await guild.members.fetch',
  'await guild.channels.fetch', 'await guild.roles.fetch',
  'await interaction.guild.fetch', '.findOne', '.findMany',
  '.insertOne', '.updateOne', '.deleteOne', '.aggregate',
];

const isDbHeavy = (c) => DB_HEAVY.some((kw) => c.includes(kw));

// ---------------------------------------------------------------------------
//  Inline transforms (pure string operations)
// ---------------------------------------------------------------------------
function transform(content, filePath) {
  let c = content;
  let log = [];

  const cmdName = getCmdName(c);
  const ihPath = getImportPath(filePath, 'interactionHelper.js');
  const ehPath = getImportPath(filePath, 'errorHandler.js');
  const heavy = isDbHeavy(c);

  // ---- 1. Inject InteractionHelper import (after last existing import) ----
  if (!hasInteractionHelperImport(c)) {
    const imports = [...c.matchAll(/^import .+?;$/gm)];
    if (imports.length) {
      const last = imports[imports.length - 1];
      c = c.replace(last[0], last[0] + `\nimport { InteractionHelper } from '${ihPath}';`);
      log.push('+ InteractionHelper import');
    }
  }

  // ---- 2. Inject handleInteractionError import if needed ----------------
  if (!hasHandleErrorImport(c) && (c.includes('catch (error)') || c.includes('catch(err)') || c.includes('catch (err)'))) {
    const imports = [...c.matchAll(/^import .+?;$/gm)];
    if (imports.length && !c.includes('errorHandler')) {
      const last = imports[imports.length - 1];
      c = c.replace(last[0], last[0] + `\nimport { handleInteractionError } from '${ehPath}';`);
      log.push('+ handleInteractionError import');
    }
  }

  // ---- 3. deferReply → safeDefer -----------------------------------------
  c = c.replace(
    /(await\s+)?interaction\.deferReply\(([^)]*)\)/g,
    (_m, _a, args) => {
      log.push('deferReply → safeDefer');
      const a = args.trim();
      return a
        ? `await InteractionHelper.safeDefer(interaction, { ${a.replace(/^{|}$/g, '').trim()} })`
        : 'await InteractionHelper.safeDefer(interaction)';
    },
  );

  // ---- 4. reply → safeReply  (not inside template strings) --------------
  c = c.replace(
    /(return\s+)?(await\s+)?interaction\.reply\(([\s\S]*?)\)\s*(;|\n|})/g,
    (_m, r, a, args, term) => {
      log.push('reply → safeReply');
      return (r || '') + `await InteractionHelper.safeReply(interaction, ${args.trim()})${term}`;
    },
  );

  // ---- 5. editReply → safeEditReply ------------------------------------
  c = c.replace(
    /(return\s+)?(await\s+)?interaction\.editReply\(([\s\S]*?)\)\s*(;|\n|})/g,
    (_m, r, a, args, term) => {
      log.push('editReply → safeEditReply');
      return (r || '') + `await InteractionHelper.safeEditReply(interaction, ${args.trim()})${term}`;
    },
  );

  // ---- 6. followUp → safeReply (since safeReply handles all states) ------
  c = c.replace(
    /(return\s+)?(await\s+)?interaction\.followUp\(([\s\S]*?)\)\s*(;|\n|})/g,
    (_m, r, a, args, term) => {
      log.push('followUp → safeReply');
      return (r || '') + `await InteractionHelper.safeReply(interaction, ${args.trim()})${term}`;
    },
  );

  // ---- 7. Standardise logger.error inside catch blocks ------------------
  // Bare logger.error('…', error)  → structured template
  c = c.replace(
    /logger\.error\((['"`])([^'"`]+)\1,\s*error\);/g,
    (_m, _q, msg) => {
      log.push('logger.error → structured');
      return `logger.error(\`[Command Error] /${cmdName} failed in Guild \${interaction.guildId} by User \${interaction.user.id}: \${error.message}\`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });`;
    },
  );

  // Also handle err variable variant
  c = c.replace(
    /logger\.error\((['"`])([^'"`]+)\1,\s*err\);/g,
    (_m, _q, msg) => {
      log.push('logger.error(err) → structured');
      return `logger.error(\`[Command Error] /${cmdName} failed in Guild \${interaction.guildId} by User \${interaction.user.id}: \${err.message}\`, { stack: err.stack, errorCode: err.code || 'UNKNOWN' });`;
    },
  );

  // ---- 8. Add handleInteractionError fallback to bare catch blocks -------
  // Detect catch blocks that do NOT already contain handleInteractionError
  // and have NO logger.error call either → they are 'bare' and unsafe.
  c = c.replace(
    /catch\s*\(\s*(error|err)\s*\)\s*\{([^}]*?)\}(?=\s*(?:catch|finally|\}|\n\s*(?:async|export|\/\/|import)))/g,
    (match, varName, body) => {
      if (body.includes('handleInteractionError') || body.includes('logger.error')) {
        return match;
      }
      // Only act if the body is empty or only has whitespace/comments
      const stripped = body.replace(/\/\/.*/g, '').trim();
      if (!stripped) {
        log.push(`+ handleInteractionError fallback (bare catch)`);
        return `catch (${varName}) {\n      logger.error(\`[Command Error] /${cmdName} failed in Guild \${interaction.guildId} by User \${interaction.user.id}: \${${varName}.message}\`, { stack: ${varName}.stack, errorCode: ${varName}.code || 'UNKNOWN' });\n      await handleInteractionError(interaction, ${varName}, { source: '${cmdName}' });\n    }`;
      }
      // If body has just a reply/editReply with no logging, also wrap
      if (body.includes('.reply') || body.includes('.editReply')) {
        log.push(`+ structured logging + handleInteractionError (reply-only catch)`);
        return `catch (${varName}) {\n      logger.error(\`[Command Error] /${cmdName} failed in Guild \${interaction.guildId} by User \${interaction.user.id}: \${${varName}.message}\`, { stack: ${varName}.stack, errorCode: ${varName}.code || 'UNKNOWN' });\n      await handleInteractionError(interaction, ${varName}, { source: '${cmdName}' });${body}\n    }`;
      }
      return match;
    },
  );

  // ---- 9. Inject safeDefer at top of execute() for DB-heavy commands -----
  if (heavy) {
    const execMatch = c.match(/async\s+execute\s*\([^)]*\)\s*\{/);
    if (execMatch) {
      const idx = execMatch.index + execMatch[0].length;
      const after = c.slice(idx);
      // Only inject if no defer/safeDefer call already exists
      if (!/safeDefer|deferReply/.test(after.slice(0, 500))) {
        log.push('+ safeDefer (DB-heavy)');
        c = c.slice(0, idx) + '\n    await InteractionHelper.safeDefer(interaction);' + after;
      }
    }
  }

  // ---- 10. Cleanup double-await artifacts --------------------------------
  c = c.replace(/await await /g, 'await ');

  return { content: c, log };
}

// ---------------------------------------------------------------------------
//  Recursive file walking
// ---------------------------------------------------------------------------
function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------
function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   🚀  refactor-commands.js  —  Production Polish Engine  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const files = walk(ROOT);
  STATS.total = files.length;
  console.log(`📁  Found ${files.length} command files\n`);

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const raw = fs.readFileSync(file, 'utf-8');
    const { content, log } = transform(raw, file);

    if (content !== raw) {
      fs.writeFileSync(file, content, 'utf-8');
      STATS.changed++;
      console.log(`  ✅  ${rel}`);
      for (const l of log) console.log(`       └─ ${l}`);
    } else {
      STATS.skipped++;
    }
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   📊  SUMMARY                                           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  📁  Total found      : ${STATS.total}`);
  console.log(`  ✏️   Files changed    : ${STATS.changed}`);
  console.log(`  ⏭️   Skipped (clean)  : ${STATS.skipped}`);
  console.log(`  ❌  Errors           : ${STATS.errors}`);
  console.log('');
  console.log('👉  Run  npm start  to verify the bot loads cleanly.');
}

main();
#!/usr/bin/env node

/**
 * GLOBAL COMMANDS REFACTORING SCRIPT
 * 
 * Walks src/commands/ recursively and standardizes:
 * 1. All bare interaction.deferReply() → InteractionHelper.safeDefer()
 * 2. All bare interaction.reply() → InteractionHelper.safeReply()
 * 3. All bare interaction.editReply() → InteractionHelper.safeEditReply()
 * 4. All catch blocks → structured logging with guildId, userId, commandName + handleInteractionError fallback
 * 5. Injects InteractionHelper import where missing
 * 6. Injects safeDefer() at top of execute() for DB-heavy commands lacking it
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMMANDS_DIR = path.resolve(__dirname, '../src/commands');

// ── Statistics ──
const stats = { filesProcessed: 0, filesModified: 0, errors: 0, skipped: 0 };

// ── Helper: Detect if a command is async/DB heavy ──
const DB_HEAVY_KEYWORDS = [
  'await db.', 'await this.db.', 'await guildConfig', 'await configService',
  'await moderationService', 'await leveling', 'await ticket',
  'await loggingService', 'await verificationService', 'await welcomeService',
  'await voiceService', 'await giveawayService', 'await antinukeService',
  'await birthdayService', 'await getServerCounters', 'await updateCounter',
  'await saveServerCounters', 'database', 'postgres', '.findOne', '.findMany',
  '.insertOne', '.updateOne', '.deleteOne', '.aggregate',
  'await guild.fetch', 'await guild.channels.fetch', 'await guild.roles.fetch',
  'await guild.members.fetch', 'await interaction.guild.fetch',
  'await guild.bans.fetch', 'await interaction.guild.channels.fetch',
];

function isDbHeavy(content) {
  return DB_HEAVY_KEYWORDS.some(kw => content.includes(kw));
}

// ── Helper: Check if already has InteractionHelper import ──
function hasInteractionHelperImport(content) {
  return content.includes("from '../../utils/interactionHelper.js'") ||
         content.includes('from \'../../utils/interactionHelper.js\'') ||
         content.includes("from '../utils/interactionHelper.js'") ||
         content.includes('from \'../utils/interactionHelper.js\'') ||
         content.includes('InteractionHelper');
}

function getRelativeInteractionHelperPath(filePath) {
  const relDir = path.dirname(path.relative(COMMANDS_DIR, filePath));
  const depth = relDir === '.' ? 1 : relDir.split(path.sep).length + 1;
  const prefix = '../'.repeat(depth);
  return `${prefix}utils/interactionHelper.js`;
}

// ── Helper: Get command name from file content ──
function extractCommandName(content) {
  const match = content.match(/\.setName\(['"]([^'"]+)['"]\)/);
  return match ? match[1] : 'unknown';
}

// ── Helper: Get relative depth for errorHandler import ──
function getRelativeErrorHandlerPath(filePath) {
  const relDir = path.dirname(path.relative(COMMANDS_DIR, filePath));
  const depth = relDir === '.' ? 1 : relDir.split(path.sep).length + 1;
  const prefix = '../'.repeat(depth);
  return `${prefix}utils/errorHandler.js`;
}

// ── Main Transformation Engine ──
function transformFile(content, filePath) {
  const original = content;
  const commandName = extractCommandName(content);
  const hasInteractionHelper = hasInteractionHelperImport(content);
  const isHeavy = isDbHeavy(content);
  const hasHandleErrorImport = content.includes("from '../../utils/errorHandler.js'") ||
                                content.includes('from \'../../utils/errorHandler.js\'') ||
                                content.includes('handleInteractionError');
  const ihImportPath = getRelativeInteractionHelperPath(filePath);
  const ehImportPath = getRelativeErrorHandlerPath(filePath);

  let changes = [];

  // ── 1. Inject InteractionHelper import if missing ──
  if (!hasInteractionHelper) {
    // Find the last import line
    const importLines = content.match(/^import .+?;$/gm);
    if (importLines && importLines.length > 0) {
      const lastImport = importLines[importLines.length - 1];
      content = content.replace(
        lastImport,
        `${lastImport}\nimport { InteractionHelper } from '${ihImportPath}';`
      );
      changes.push('Added InteractionHelper import');
    }
  }

  // ── 2. Inject handleInteractionError import if not present but we need it ──
  if (!hasHandleErrorImport) {
    // We'll add it if there are catch blocks we're transforming
    if (content.includes('catch (error)') || content.includes('catch(err)') || content.includes('catch (err)')) {
      const importLines = content.match(/^import .+?;$/gm);
      if (importLines && importLines.length > 0) {
        // Check if errorHandler is already imported via any path
        if (!content.includes('errorHandler')) {
          const lastImport = importLines[importLines.length - 1];
          content = content.replace(
            lastImport,
            `${lastImport}\nimport { handleInteractionError } from '${ehImportPath}';`
          );
          changes.push('Added handleInteractionError import');
        }
      }
    }
  }

  // ── 3. Transform interaction.deferReply() → InteractionHelper.safeDefer(interaction) ──
  // Match: await interaction.deferReply({ ... }) OR interaction.deferReply({ ... })
  content = content.replace(
    /(await\s+)?interaction\.deferReply\(([^)]*)\)/g,
    (match, _await, args) => {
      const trimmedArgs = args.trim();
      const argsStr = trimmedArgs ? `{ ${trimmedArgs.replace(/^{|}$/g, '').trim()} }` : '';
      changes.push('Transformed interaction.deferReply() → safeDefer()');
      return `await InteractionHelper.safeDefer(interaction${argsStr ? `, ${argsStr}` : ''})`;
    }
  );

  // ── 4. Transform interaction.reply() → InteractionHelper.safeReply(interaction, ...) ──
  // We need to be careful to not match inside comments or strings
  // Match bare interaction.reply({...}) that are standalone statements (not inside template strings)
  content = content.replace(
    /(return\s+)?(await\s+)?interaction\.reply\(([\s\S]*?)\)(?=\s*;|\s*\n|\s*})/g,
    (match, _return, _await, args) => {
      changes.push('Transformed interaction.reply() → safeReply()');
      const prefix = _return ? 'return ' : '';
      return `${prefix}await InteractionHelper.safeReply(interaction, ${args.trim()})`;
    }
  );

  // ── 5. Transform interaction.editReply() → InteractionHelper.safeEditReply(interaction, ...) ──
  content = content.replace(
    /(return\s+)?(await\s+)?interaction\.editReply\(([\s\S]*?)\)(?=\s*;|\s*\n|\s*})/g,
    (match, _return, _await, args) => {
      changes.push('Transformed interaction.editReply() → safeEditReply()');
      const prefix = _return ? 'return ' : '';
      return `${prefix}await InteractionHelper.safeEditReply(interaction, ${args.trim()})`;
    }
  );

  // ── 6. Transform interaction.followUp() → InteractionHelper.safeReply for consistency ──
  content = content.replace(
    /(return\s+)?(await\s+)?interaction\.followUp\(([\s\S]*?)\)(?=\s*;|\s*\n|\s*})/g,
    (match, _return, _await, args) => {
      changes.push('Transformed interaction.followUp() → safeReply()');
      return `${_return || ''}await InteractionHelper.safeReply(interaction, ${args.trim()})`;
    }
  );

  // ── 7. Standardize catch blocks with structured logging ──
  // Match catch (error) { ... } or catch (err) { ... } blocks
  // We need to be careful with nested catches - focus on the outer catch of execute()

  // First, try to standardize the catch block pattern
  // Pattern 1: logger.error('...', error); await handleInteractionError(...)
  // Pattern 2: logger.error('...', error); with manual error reply
  // Pattern 3: Bare catch with just a reply
  
  // Standard logger.error catch block replacement
  // Replace bare logger.error('Something error:', error) inside catch blocks with structured version
  content = content.replace(
    /logger\.error\(['"]([^'"]+)['"],\s*error\)(?!\s*;)/g,
    (match, errorMsg) => {
      // Only replace if it's inside a catch block (simple heuristic)
      changes.push('Standardized logger.error() with structured context');
      return `logger.error(\`[Command Error] /${commandName} failed in Guild \${interaction.guildId} by User \${interaction.user.id}: \${error.message}\`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' })`;
    }
  );

  // Also handle the semicolon variant
  content = content.replace(
    /logger\.error\(['"]([^'"]+)['"],\s*error\);/g,
    (match, errorMsg) => {
      changes.push('Standardized logger.error() with structured context (semicolon)');
      return `logger.error(\`[Command Error] /${commandName} failed in Guild \${interaction.guildId} by User \${interaction.user.id}: \${error.message}\`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });`;
    }
  );

  // ── 8. Add handleInteractionError fallback in catch blocks that lack it ──
  // Find catch blocks that don't call handleInteractionError
  const catchBlockRegex = /catch\s*\((?:error|err)\)\s*\{([\s\S]*?)\}(?=\s*(?:catch|finally|\}|$))/g;
  let catchMatch;
  let catchIndex = 0;
  let modifiedContent = content;

  while ((catchMatch = catchBlockRegex.exec(content)) !== null) {
    const fullMatch = catchMatch[0];
    const blockBody = catchMatch[1];
    
    // Skip if already uses handleInteractionError inside this catch
    if (blockBody.includes('handleInteractionError')) {
      continue;
    }

    // Skip if this catch is for a try that's inside a method that isn't the main execute
    // Check if the catch block has any error handling at all
    const hasLoggerError = blockBody.includes('logger.error');
    const hasErrorReply = blockBody.includes('.reply') || blockBody.includes('.editReply');
    
    // If there's NO error handling at all, or only a bare reply, add handleInteractionError
    if (!hasLoggerError && !hasErrorReply) {
      // This catch block is risky - add error handling
      const newBlock = fullMatch.replace(
        /\{([\s\S]*)\}/,
        (m, body) => {
          return `{\n      logger.error(\`[Command Error] /${commandName} failed in Guild \${interaction.guildId} by User \${interaction.user.id}: \${error.message}\`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });\n      await handleInteractionError(interaction, error, { source: '${commandName}' });${body ? `\n      ${body.trim()}` : ''}\n    }`;
        }
      );
      modifiedContent = modifiedContent.replace(fullMatch, newBlock);
      changes.push('Added structured error handling to bare catch block');
    }
  }

  content = modifiedContent;

  // ── 9. Inject safeDefer() at top of execute() for DB-heavy commands lacking it ──
  if (isHeavy) {
    // Check if execute function already has a defer or safeDefer call near the top
    const executeContent = content.match(/async\s+execute\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
    if (executeContent) {
      const executeBody = executeContent[1];
      const hasDefer = executeBody.includes('safeDefer') || executeBody.includes('deferReply');
      
      if (!hasDefer) {
        // Check if there's already error handling (try/catch) in execute
        const hasTry = executeBody.includes('try {');
        
        if (hasTry) {
          // Insert safeDefer after the try {
          content = content.replace(
            /async\s+execute\([^)]*\)\s*\{[\s\S]*?try\s*\{/,
            (match) => {
              changes.push('Added safeDefer() to DB-heavy command');
              return `${match}\n            await InteractionHelper.safeDefer(interaction);`;
            }
          );
        } else {
          // Insert safeDefer at the very top of execute
          content = content.replace(
            /async\s+execute\([^)]*\)\s*\{/,
            (match) => {
              changes.push('Added safeDefer() to DB-heavy command');
              return `${match}\n        await InteractionHelper.safeDefer(interaction);`;
            }
          );
        }
      }
    }
  }

  // ── 10. Fix any double-await patterns we may have created ──
  content = content.replace(/await await /g, 'await ');

  const modified = content !== original;
  return { content, modified, changes };
}

async function getAllCommandFiles(dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getAllCommandFiles(fullPath));
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║    🚀 COMMAND REFACTORING ENGINE                       ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\n📂 Scanning: ${COMMANDS_DIR}\n`);

  const files = await getAllCommandFiles(COMMANDS_DIR);
  console.log(`📁 Found ${files.length} command files\n`);

  for (const filePath of files) {
    stats.filesProcessed++;
    try {
      let content = await fs.readFile(filePath, 'utf-8');
      const { content: newContent, modified, changes } = transformFile(content, filePath);
      
      if (modified) {
        await fs.writeFile(filePath, newContent, 'utf-8');
        stats.filesModified++;
        console.log(`  ✅ ${path.relative(COMMANDS_DIR, filePath)}`);
        changes.forEach(c => console.log(`     └─ ${c}`));
      } else {
        stats.skipped++;
      }
    } catch (error) {
      stats.errors++;
      console.error(`  ❌ ${path.relative(COMMANDS_DIR, filePath)}: ${error.message}`);
    }
  }

  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║    📊 REFACTORING SUMMARY                              ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`  📁 Total files found:     ${stats.filesProcessed}`);
  console.log(`  ✏️  Files modified:        ${stats.filesModified}`);
  console.log(`  ⏭️  Files skipped (clean): ${stats.skipped}`);
  console.log(`  ❌ Errors:                ${stats.errors}`);
  console.log('');
}

main().catch(console.error);
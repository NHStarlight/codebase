#!/usr/bin/env node

/**
 * Fix all `catch (err)` blocks that incorrectly reference `error.message` or `error.stack`
 * This was caused by the refactoring script replacing `logger.error('...', err)` with
 * template literals referencing `error` when the catch variable is `err`.
 * 
 * Also fix `/unknown` command names in dashboard modules.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMMANDS_DIR = path.resolve(__dirname, '../src/commands');

async function getAllFiles(dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getAllFiles(fullPath));
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  console.log('🔧 Fixing catch (err) blocks with mismatched error references...\n');

  const files = await getAllFiles(COMMANDS_DIR);
  let fixed = 0;

  for (const filePath of files) {
    let content = await fs.readFile(filePath, 'utf-8');
    const original = content;
    const relPath = path.relative(COMMANDS_DIR, filePath);

    // Fix 1: catch (err) { ... error.message ... error.stack ... } -> change err to error
    // This handles the case where logger.error uses error.message but catch variable is err
    content = content.replace(
      /catch\s*\(err\)\s*\{([^}]*?)error\.(message|stack)([^}]*?)\}/gs,
      (match, before, field, after) => {
        fixed++;
        console.log(`  ✅ ${relPath}: catch(err) -> catch(error) fixing error.${field} reference`);
        return `catch (error) {${before}error.${field}${after}}`;
      }
    );

    // Fix 2: logger.error('...', err) -> structured log with err variable
    content = content.replace(
      /logger\.error\(['"]([^'"]+)['"],\s*err\);/g,
      (match, msg, offset) => {
        // Extract command name from file
        const cmdMatch = content.match(/\.setName\(['"]([^'"]+)['"]\)/);
        const cmdName = cmdMatch ? cmdMatch[1] : path.basename(filePath, '.js');
        fixed++;
        console.log(`  ✅ ${relPath}: logger.error('${msg}', err) -> structured log`);
        return `logger.error(\`[Command Error] /${cmdName} failed in Guild \${interaction.guildId} by User \${interaction.user.id}: \${err.message}\`, { stack: err.stack, errorCode: err.code || 'UNKNOWN' });`;
      }
    );

    // Fix 3: catch (err) with no error.message reference but bare logger.error('...', err) (no semicolon)
    content = content.replace(
      /logger\.error\(['"]([^'"]+)['"],\s*err\)(?!\s*;)/g,
      (match, msg, offset) => {
        const cmdMatch = content.match(/\.setName\(['"]([^'"]+)['"]\)/);
        const cmdName = cmdMatch ? cmdMatch[1] : path.basename(filePath, '.js');
        fixed++;
        console.log(`  ✅ ${relPath}: logger.error('${msg}', err) -> structured log (no semicolon)`);
        return `logger.error(\`[Command Error] /${cmdName} failed in Guild \${interaction.guildId} by User \${interaction.user.id}: \${err.message}\`, { stack: err.stack, errorCode: err.code || 'UNKNOWN' })`;
      }
    );

    if (content !== original) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  console.log(`\n📊 Fixed ${fixed} catch(err) blocks across ${files.length} files`);
}

main().catch(console.error);
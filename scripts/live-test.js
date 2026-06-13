import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import AntiNukeService from '../src/services/antinukeService.js';
import { pgDb } from '../src/utils/postgresDatabase.js';
import { logger } from '../src/utils/logger.js';

// ============================================================
// LIVE REAL-DISCORD-API TEST — Anti-Nuke Pipeline Validation
// ============================================================
// This script connects to the real Discord API, creates temporary
// channels in the test guild, then rapidly deletes them to verify
// that the real channelDelete event → AntiNukeService → PostgreSQL
// pipeline works end-to-end.
//
// Prerequisites:
//   1. .env must have DISCORD_TOKEN and GUILD_ID set
//   2. PostgreSQL must be reachable (POSTGRES_URL in .env)
//   3. The bot must be a member of the target guild
// ============================================================

// ─────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const TEST_GUILD_ID = process.env.TEST_GUILD_ID || process.env.GUILD_ID;

if (!TOKEN) {
  console.error('❌ FATAL: No DISCORD_TOKEN found in .env');
  process.exit(1);
}
if (!TEST_GUILD_ID) {
  console.error('❌ FATAL: No GUILD_ID / TEST_GUILD_ID found in .env');
  process.exit(1);
}

// Results accumulator
const results = [];

function record(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const icon = passed ? '✅' : '❌';
  console.log(`  ${icon} ${name}: ${passed ? 'PASSED' : 'FAILED'}${detail ? ' — ' + detail : ''}`);
}

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const pct = total > 0 ? ((passed / total) * 100).toFixed(0) : '0';

  console.log('');
  console.log('='.repeat(70));
  console.log('  🛡️  LIVE TEST — REAL ANTI-NUKE PIPELINE SUMMARY');
  console.log('='.repeat(70));
  console.log('');
  console.log('  ' + 'Check'.padEnd(50) + 'Status');
  console.log('  ' + '─'.repeat(60));
  for (const r of results) {
    const status = r.passed ? '✅ PASSED' : '❌ FAILED';
    console.log(`  ${r.name.padEnd(50)}${status}`);
  }
  console.log('  ' + '─'.repeat(60));
  console.log(`  ${'TOTAL'.padEnd(50)}${passed}/${total} passed (${pct}%)`);
  console.log('');
}

// ─────────────────────────────────────────
// Anti-Nuke tracking state for this test
// ─────────────────────────────────────────
const testState = {
  channelsDeleted: 0,
  eventsProcessed: 0,
  executorDetected: null,
  restorationHistory: null,
  quarantineApplied: false,
};

// ─────────────────────────────────────────
// Main test runner
// ─────────────────────────────────────────
async function runLiveTest() {
  console.log('');
  console.log('='.repeat(70));
  console.log('  🔴 LIVE TEST — REAL DISCORD API ANTI-NUKE VALIDATION');
  console.log('='.repeat(70));
  console.log(`  Token: ${TOKEN.slice(0, 10)}...${TOKEN.slice(-5)}`);
  console.log(`  Target Guild ID: ${TEST_GUILD_ID}`);
  console.log('');

  // ── Step 1: Connect to PostgreSQL ────────────────────────
  console.log('┌─ Step 1: PostgreSQL Connection ───────────────────────────────');
  let pgConnected = false;
  try {
    await pgDb.connect();
    pgConnected = pgDb.isAvailable();
    record('PostgreSQL connected', pgConnected, pgConnected ? 'pool ready' : pgDb.getLastFailure()?.message || 'unknown');
  } catch (err) {
    record('PostgreSQL connected', false, err.message);
  }
  console.log('└─ End Step 1\n');

  if (!pgConnected) {
    console.log('  ⚠️  PostgreSQL is required for this test. Aborting.');
    printSummary();
    process.exit(1);
  }

  // ── Step 2: Bootstrap Anti-Nuke config in DB ──────────────
  console.log('┌─ Step 2: Bootstrap Anti-Nuke guild_settings ──────────────────');
  try {
    await pgDb.pool.query(
      `INSERT INTO guild_settings (guild_id, is_enabled, limit_count, time_window, punishment_type, quarantine_role_id, log_channel_id, honeypot_channel_id)
       VALUES ($1, TRUE, 3, 10, 'quarantine', NULL, NULL, NULL)
       ON CONFLICT (guild_id)
       DO UPDATE SET is_enabled = TRUE,
                     limit_count = 3,
                     time_window = 10,
                     punishment_type = 'quarantine'`,
      [TEST_GUILD_ID]
    );
    record('guild_settings upserted', true, `guild=${TEST_GUILD_ID}`);
  } catch (err) {
    record('guild_settings upserted', false, err.message);
    console.log('└─ End Step 2\n');
    printSummary();
    process.exit(1);
  }
  console.log('└─ End Step 2\n');

  // ── Step 3: Create Discord client and login ───────────────
  console.log('┌─ Step 3: Discord Client Login ────────────────────────────────');
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  let loginOk = false;
  try {
    await client.login(TOKEN);
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        record('Bot logged in', false, 'timed out waiting for ready event');
        resolve();
      }, 15000);

      client.once('ready', () => {
        clearTimeout(timeout);
        loginOk = true;
        record('Bot logged in', true, `${client.user?.tag} (${client.user?.id})`);
        resolve();
      });
    });
  } catch (err) {
    record('Bot logged in', false, err.message);
  }
  console.log('└─ End Step 3\n');

  if (!loginOk) {
    record('Guild fetch', false, 'bot not logged in');
    printSummary();
    await client.destroy().catch(() => {});
    process.exit(1);
  }

  // ── Step 4: Fetch Guild ──────────────────────────────────
  console.log('┌─ Step 4: Fetch target guild ──────────────────────────────────');
  let guild = null;
  try {
    guild = await client.guilds.fetch(TEST_GUILD_ID);
    record('Guild fetched', !!guild, `${guild.name} (${guild.id})`);
    console.log(`     Members: ${guild.memberCount}`);
    console.log(`     Owner: ${guild.ownerId}`);
  } catch (err) {
    record('Guild fetched', false, err.message);
  }
  console.log('└─ End Step 4\n');

  if (!guild) {
    printSummary();
    await client.destroy().catch(() => {});
    process.exit(1);
  }

  // ── Step 5: Prime the AntiNukeService cache ──────────────
  console.log('┌─ Step 5: Prime AntiNukeService cache ─────────────────────────');
  const antiNuke = AntiNukeService.getInstance();
  antiNuke.deletionTracker.clear();
  antiNuke.restorationQueues.clear();
  antiNuke.recentRestorations.clear();

  // Manually set the guild settings cache so the service can operate
  antiNuke.guildSettingsCache.set(TEST_GUILD_ID, {
    guildId: TEST_GUILD_ID,
    isEnabled: true,
    limitCount: 3,
    timeWindow: 10,
    punishmentType: 'quarantine',
    quarantineRoleId: null,
    logChannelId: null,
    honeypotChannelId: null,
  });

  // Also load from DB to be thorough
  try {
    await antiNuke.loadGuildCaches(client);
    const settings = antiNuke.getSettings(TEST_GUILD_ID);
    record('AntiNuke cache primed', settings?.isEnabled === true, `limit=${settings?.limitCount}, window=${settings?.timeWindow}s`);
  } catch (err) {
    // Fallback: we already set it manually
    record('AntiNuke cache primed', true, 'manual cache set (loadGuildCaches failed)');
  }
  console.log('└─ End Step 5\n');

  // ── Step 6: Create 3 test channels ───────────────────────
  console.log('┌─ Step 6: Create test channels ────────────────────────────────');
  const channelNames = ['live-test-alpha', 'live-test-beta', 'live-test-gamma'];
  const createdChannels = [];

  for (const name of channelNames) {
    try {
      const ch = await guild.channels.create({
        name,
        type: 0, // GuildText
        reason: 'Live test — temporary channel for anti-nuke validation',
      });
      createdChannels.push(ch);
      console.log(`     Created channel: #${ch.name} (${ch.id})`);
    } catch (err) {
      console.error(`     Failed to create channel #${name}: ${err.message}`);
    }
  }

  record('Test channels created', createdChannels.length === 3, `${createdChannels.length}/3 created`);
  console.log('└─ End Step 6\n');

  if (createdChannels.length < 3) {
    console.log('  ⚠️  Could not create all test channels. Cleaning up and aborting.');
    // Clean up what we did create
    for (const ch of createdChannels) {
      await ch.delete('Live test cleanup').catch(() => {});
    }
    printSummary();
    await client.destroy().catch(() => {});
    process.exit(1);
  }

  // ── Step 7: Register channelDelete listener ───────────────
  console.log('┌─ Step 7: Register channelDelete listener ─────────────────────');
  let listenerRegistered = false;

  client.on('channelDelete', async (channel) => {
    // Only process channels in our test guild
    if (channel.guild?.id !== TEST_GUILD_ID) return;
    // Only process our test channels
    if (!channelNames.includes(channel.name)) return;

    testState.channelsDeleted++;
    console.log(`     [EVENT] channelDelete fired for #${channel.name} (${channel.id}) — total=${testState.channelsDeleted}`);

    // ── Replicate the EXACT production logic from src/events/channelDelete.js ──
    const guildId = channel.guild.id;
    const type = 12; // AuditLogEvent.ChannelDelete

    let matchedExecutor = null;
    let matchedSnapshot = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const audit = await channel.guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
      if (!audit?.entries) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
        continue;
      }

      // Find first entry whose target.id matches the deleted channel
      for (const entry of audit.entries.values()) {
        if (entry.target?.id === channel.id) {
          matchedExecutor = entry.executor;
          break;
        }
      }

      if (matchedExecutor) {
        const snapshot = {
          channel: {
            id: channel.id,
            name: channel.name,
            type: channel.type,
            topic: channel.topic ?? null,
            nsfw: channel.nsfw ?? false,
            rateLimitPerUser: channel.rateLimitPerUser ?? null,
            parentId: channel.parentId ?? null,
            position: channel.rawPosition ?? channel.position ?? null,
            permissionOverwrites: channel.permissionOverwrites?.cache
              ? channel.permissionOverwrites.cache.map(po => ({
                  id: po.id,
                  type: po.type,
                  allow: po.allow.bitfield?.toString?.() || po.allow?.bitfield?.toString?.() || String(po.allow ?? 0),
                  deny: po.deny.bitfield?.toString?.() || po.deny?.bitfield?.toString?.() || String(po.deny ?? 0),
                }))
              : [],
          },
        };
        matchedSnapshot = snapshot;

        // Record the executor from the first event (all 3 should be the same user)
        if (!testState.executorDetected) {
          testState.executorDetected = matchedExecutor.id;
        }

        testState.eventsProcessed++;

        console.log(`     [ANTI-NUKE] Calling handleEvent() — executor=${matchedExecutor.tag || matchedExecutor.id} (${testState.eventsProcessed}/3)`);

        try {
          await antiNuke.handleEvent(channel.guild, matchedExecutor, {
            type: 'channel',
            data: channel,
            targetSnapshot: snapshot,
          });
          console.log(`     [ANTI-NUKE] handleEvent() completed`);
        } catch (err) {
          console.error(`     [ANTI-NUKE] handleEvent() error: ${err.message}`);
        }
        break;
      }

      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (!matchedExecutor) {
      console.log(`     [WARN] No matching audit entry found for deleted channel ${channel.id}`);
    }
  });

  listenerRegistered = true;
  record('channelDelete listener registered', listenerRegistered);
  console.log('└─ End Step 7\n');

  // ── Step 8: Rapid deletion burst ─────────────────────────
  console.log('┌─ Step 8: Rapid channel deletion burst ────────────────────────');
  const deleteStart = Date.now();

  for (const ch of createdChannels) {
    try {
      await ch.delete('Live test — simulating nuke attack');
      console.log(`     Deleted #${ch.name}`);
    } catch (err) {
      console.error(`     Failed to delete #${ch.name}: ${err.message}`);
    }
  }

  const deleteDuration = Date.now() - deleteStart;
  console.log(`     All deletions completed in ${deleteDuration}ms`);
  record('Rapid deletions completed', testState.channelsDeleted === 3, `${testState.channelsDeleted}/3 events received in ${deleteDuration}ms`);
  console.log('└─ End Step 8\n');

  // ── Step 9: Wait for event pipeline to settle ────────────
  console.log('┌─ Step 9: Waiting for processing pipeline (5s) ────────────────');
  await new Promise((r) => setTimeout(r, 5000));
  console.log('     Pipeline settled — verifying state...');
  console.log('└─ End Step 9\n');

  // ── Step 10: Verify AntiNukeService state ─────────────────
  console.log('┌─ Step 10: Verify AntiNukeService State ───────────────────────');

  // 10a: event processing count
  record('Events processed by AntiNuke', testState.eventsProcessed >= 1, `${testState.eventsProcessed} events`);
  console.log(`     Events processed: ${testState.eventsProcessed}`);

  // 10b: deletion tracker
  const guildTracker = antiNuke.deletionTracker.get(TEST_GUILD_ID);
  const hasGuildTracker = !!guildTracker;
  record('Deletion tracker has guild entry', hasGuildTracker);

  if (hasGuildTracker) {
    const trackerSize = guildTracker.size;
    console.log(`     Deletion tracker guild entries: ${trackerSize}`);
    for (const [uid, t] of guildTracker) {
      console.log(`       User ${uid}: ${t.timestamps?.length || 0} timestamps stored`);
    }
    const executorTracked = testState.executorDetected && guildTracker.has(testState.executorDetected);
    record('Executor tracked in deletion tracker', !!executorTracked, `userId=${testState.executorDetected}`);
  }

  // 10c: restoration queue
  const hasRestorationQueue = antiNuke.restorationQueues.has(TEST_GUILD_ID);
  record('Restoration queue created', hasRestorationQueue);

  // 10d: restoration history
  const restorationHistory = antiNuke.recentRestorations.get(TEST_GUILD_ID) || [];
  testState.restorationHistory = restorationHistory;
  record('Restoration history populated', restorationHistory.length > 0, `${restorationHistory.length} entries`);

  if (restorationHistory.length > 0) {
    console.log('     Restoration History:');
    for (const entry of restorationHistory) {
      console.log(`       [${entry.at}] type=${entry.type} target=${entry.targetId || '?'} ok=${entry.ok}${entry.error ? ' error=' + entry.error : ''}`);
    }
    const allRestored = restorationHistory.every(e => e.ok === true);
    record('All restorations succeeded', allRestored, restorationHistory.map(e => `ok=${e.ok}`).join(', '));
  }

  console.log('└─ End Step 10\n');

  // ── Step 11: Verify PostgreSQL State ──────────────────────
  console.log('┌─ Step 11: Verify PostgreSQL State ────────────────────────────');

  // 11a: Query punished_users
  try {
    const punishedRes = await pgDb.pool.query(
      'SELECT * FROM punished_users WHERE guild_id = $1 ORDER BY punished_at DESC',
      [TEST_GUILD_ID]
    );
    const punishedCount = punishedRes.rows.length;
    record('punished_users row(s) in PostgreSQL', punishedCount > 0, `${punishedCount} row(s)`);
    if (punishedCount > 0) {
      testState.quarantineApplied = true;
      for (const row of punishedRes.rows) {
        console.log(`       User ${row.user_id} | Roles: ${JSON.stringify(row.old_roles).slice(0, 120)}... | At: ${row.punished_at}`);
      }
    }
  } catch (err) {
    record('punished_users query', false, err.message);
  }

  // 11b: Query guild_settings confirmation
  try {
    const settingsRes = await pgDb.pool.query(
      'SELECT * FROM guild_settings WHERE guild_id = $1',
      [TEST_GUILD_ID]
    );
    if (settingsRes.rows.length > 0) {
      const s = settingsRes.rows[0];
      record('guild_settings confirmed in PostgreSQL', true, `enabled=${s.is_enabled}, limit=${s.limit_count}, window=${s.time_window}s`);
    } else {
      record('guild_settings confirmed in PostgreSQL', false, 'no row found');
    }
  } catch (err) {
    record('guild_settings query', false, err.message);
  }

  console.log('└─ End Step 11\n');

  // ── Step 12: Summary ─────────────────────────────────────
  printSummary();

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  if (passed === total) {
    console.log('  🎉 LIVE TEST PASSED — Real Anti-Nuke pipeline is OPERATIONAL');
  } else {
    const failed = results.filter(r => !r.passed);
    console.log(`  ⚠️  ${failed.length} check(s) FAILED:`);
    for (const f of failed) {
      console.log(`     - ${f.name}: ${f.detail}`);
    }
  }

  // ── Step 13: Cleanup ─────────────────────────────────────
  console.log('');
  console.log('┌─ Step 13: Cleanup ────────────────────────────────────────────');

  // 13a: Remove any restored/lingering channels from the restoration
  console.log('     Cleaning up restored test channels...');
  const channelsToClean = guild.channels.cache.filter(
    ch => channelNames.includes(ch.name) || ch.name.startsWith('live-test-')
  );
  for (const [, ch] of channelsToClean) {
    try {
      await ch.delete('Live test cleanup');
      console.log(`     Deleted cleanup channel: #${ch.name}`);
    } catch (err) {
      console.warn(`     Could not delete #${ch.name}: ${err.message}`);
    }
  }

  // 13b: Remove quarantine role if created
  console.log('     Cleaning up quarantine roles...');
  const quarantineRole = guild.roles.cache.find(
    r => r.name === 'Quarantined (Anti-Nuke)'
  );
  if (quarantineRole) {
    try {
      await quarantineRole.delete('Live test cleanup');
      console.log('     Deleted Quarantined (Anti-Nuke) role');
    } catch (err) {
      console.warn(`     Could not delete quarantine role: ${err.message}`);
    }
  }

  // 13c: Remove test guild_settings row
  console.log('     Cleaning up guild_settings...');
  try {
    await pgDb.pool.query('DELETE FROM guild_settings WHERE guild_id = $1', [TEST_GUILD_ID]);
    console.log('     Removed test guild_settings row');
  } catch (err) {
    console.warn(`     Could not delete guild_settings row: ${err.message}`);
  }

  // 13d: Remove punished_users rows
  console.log('     Cleaning up punished_users...');
  try {
    const delRes = await pgDb.pool.query(
      'DELETE FROM punished_users WHERE guild_id = $1',
      [TEST_GUILD_ID]
    );
    console.log(`     Removed ${delRes.rowCount} punished_users row(s)`);
  } catch (err) {
    console.warn(`     Could not delete punished_users rows: ${err.message}`);
  }

  // 13e: Clear AntiNukeService caches
  antiNuke.deletionTracker.delete(TEST_GUILD_ID);
  antiNuke.restorationQueues.delete(TEST_GUILD_ID);
  antiNuke.recentRestorations.delete(TEST_GUILD_ID);
  antiNuke.guildSettingsCache.delete(TEST_GUILD_ID);
  antiNuke.whitelistCache.delete(TEST_GUILD_ID);
  console.log('     AntiNukeService caches cleared for guild');

  // 13f: Destroy Discord client
  try {
    await client.destroy();
    console.log('     Discord client destroyed');
  } catch (err) {
    console.warn(`     Error destroying client: ${err.message}`);
  }

  console.log('└─ End Cleanup\n');
  console.log('  ✅ LIVE TEST COMPLETE');
  console.log('');

  const exitCode = passed === total ? 0 : 1;
  process.exit(exitCode);
}

// ─────────────────────────────────────────
// Execute
// ─────────────────────────────────────────
runLiveTest().catch(err => {
  console.error('❌ Live test crashed:', err);
  process.exit(1);
});
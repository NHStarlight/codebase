/**
 * simulateAntiNuke.cjs — Automated local simulation for Anti-Nuke system
 *
 * Mocks discord.js primitives and PostgreSQL so all tests run 100% locally.
 * No Discord API calls are made.
 *
 * Usage:  node tests/simulateAntiNuke.cjs
 */

// ===================================================================
// Logger capture setup.
// We declare collectedLogs first. After modules are loaded we directly
// override the singleton logger instance methods (CJS require of ESM
// yields a live reference to the same winston Logger object).
// ===================================================================
const collectedLogs = { info: [], warn: [], error: [], debug: [] };

// ---------------------------------------------------------------------------
// 1. Mock pgDb BEFORE importing the service
// ---------------------------------------------------------------------------
const mockPool = {
  query: async (...args) => {
    // Silently swallow all DB queries during simulation
    return { rows: [] };
  },
};

// Patch the module-level pgDb export so AntiNukeService uses our mock
const pgModule = require('../src/utils/postgresDatabase.js');
pgModule.pgDb.pool = mockPool;
pgModule.pgDb.isAvailable = () => true;
pgModule.pgDb.isConnected = true;

// ---------------------------------------------------------------------------
// 2. Override the logger singleton instance methods (after ESM module load).
//    This is the ONLY approach that works across CJS/ESM boundaries — direct
//    property assignment on the singleton object IS reflected in the ESM
//    module's reference because it's the same object in memory.
// ---------------------------------------------------------------------------
const loggerModule = require('../src/utils/logger.js');
const logger = loggerModule.logger;

// Wrap each method to silence stdout/stderr AND capture into collectedLogs.
const origInfo = logger.info.bind(logger);
const origWarn = logger.warn.bind(logger);
const origError = logger.error.bind(logger);
const origDebug = logger.debug.bind(logger);

logger.info = function (msg) {
  if (msg && typeof msg === 'string') collectedLogs.info.push(msg);
  return this;
};
logger.warn = function (msg) {
  if (msg && typeof msg === 'string') collectedLogs.warn.push(msg);
  return this;
};
logger.error = function (msg, ...meta) {
  const str = typeof msg === 'string' ? msg : String(msg);
  collectedLogs.error.push(str);
  if (meta.length && meta[0]?.message) {
    collectedLogs.error.push(meta[0].message);
  }
  return this;
};
logger.debug = function (msg) {
  if (msg && typeof msg === 'string') collectedLogs.debug.push(msg);
  return this;
};

// ---------------------------------------------------------------------------
// 3. Import AntiNukeService
// ---------------------------------------------------------------------------
const AntiNukeService = require('../src/services/antinukeService.js').default;

// ---------------------------------------------------------------------------
// 4. Mock helpers — build lightweight discord.js-like objects
// ---------------------------------------------------------------------------

function makeMockRole(id, name, opts = {}) {
  return {
    id,
    name,
    color: opts.color ?? 0,
    hexColor: opts.color ? `#${opts.color.toString(16).padStart(6, '0')}` : '#000000',
    hoist: opts.hoist ?? false,
    mentionable: opts.mentionable ?? false,
    position: opts.position ?? 0,
    permissions: {
      bitfield: opts.permissionsBitfield ?? '0',
    },
    setPosition: async (pos) => { /* best-effort mock */ },
    delete: async () => {},
  };
}

function makeMockRolesCache(allRoles) {
  const map = new Map(allRoles.map((r) => [r.id, r]));
  // Add filter() method — discord.js Collection extends Map and has filter().
  // This is needed because quarantineMember() calls member.roles.cache.filter().
  map.filter = function (fn) {
    const result = [];
    for (const [key, val] of this.entries()) {
      if (fn(val, key, this)) result.push(val);
    }
    return result;
  };
  return map;
}

function makeMockMember(id, username, opts = {}) {
  const roleIds = opts.roles ?? [];
  const roleObjects = roleIds.map((rId, i) => makeMockRole(rId, `role-${rId}`, { position: i + 1 }));
  // Add @everyone at position 0
  const everyoneRole = makeMockRole('123456789012345678', '@everyone', { position: 0 });
  const allRoles = [everyoneRole, ...roleObjects];
  // Highest role is the one with largest position
  const highest = allRoles.reduce((a, b) => (a.position > b.position ? a : b), allRoles[0]);

  return {
    id,
    user: { id, username, bot: opts.isBot ?? false },
    displayName: username,
    roles: {
      cache: makeMockRolesCache(allRoles),
      highest,
      set: async (roleIds) => {
        if (opts.rolesSetShouldThrow) {
          const err = new Error(opts.rolesSetErrorMessage || 'Missing Permissions');
          err.code = 'MISSING_PERMISSIONS';
          throw err;
        }
        // Mock success — no-op
      },
    },
  };
}

function makeMockChannel(id, name, type, opts = {}) {
  return {
    id,
    name,
    type,
    guild: opts.guild ?? null,
    topic: opts.topic ?? null,
    nsfw: opts.nsfw ?? false,
    rateLimitPerUser: opts.rateLimitPerUser ?? null,
    parentId: opts.parentId ?? null,
    rawPosition: opts.position ?? 0,
    position: opts.position ?? 0,
    permissionOverwrites: {
      cache: opts.permissionOverwrites
        ? opts.permissionOverwrites.map((po) => ({
            id: po.id,
            type: po.type,
            allow: { bitfield: { toString: () => String(po.allow ?? 0) } },
            deny: { bitfield: { toString: () => String(po.deny ?? 0) } },
          }))
        : new Map(),
    },
    delete: async () => {},
  };
}

function makeMockGuild(id, name, opts = {}) {
  const ownerId = opts.ownerId ?? '777000000000000001';
  const botMemberId = opts.botMemberId ?? '999000000000000001';

  // Build guild-level role collection
  const guildRoles = new Map();
  // Add @everyone
  guildRoles.set('111111111111111111', makeMockRole('111111111111111111', '@everyone', { position: 0 }));
  // Add any extra roles
  if (opts.roles) {
    for (const r of opts.roles) {
      guildRoles.set(r.id, r);
    }
  }

  // Bot member — roles mirror guildRoles
  const botMember = makeMockMember(botMemberId, 'Bot', {
    isBot: true,
    roles: Array.from(guildRoles.keys()),
  });
  // Override highest to the configured value
  if (opts.botHighestRolePosition !== undefined) {
    botMember.roles.highest.position = opts.botHighestRolePosition;
  }

  return {
    id,
    name,
    ownerId,
    client: {
      user: { id: botMemberId },
    },
    members: {
      me: botMember,
      cache: new Map(),
      fetch: async (userId) => {
        if (userId === botMemberId) return botMember;
        return makeMockMember(userId, `member-${userId}`, { roles: [] });
      },
    },
    roles: {
      cache: guildRoles,
      fetch: async (roleId) => guildRoles.get(roleId) || null,
      create: async (payload) => {
        const newRole = makeMockRole('quarantine-' + id, payload.name || 'Quarantined', {
          color: payload.color,
          permissionsBitfield: (payload.permissions ?? 0n).toString?.() ?? '0',
        });
        guildRoles.set(newRole.id, newRole);
        return newRole;
      },
    },
    channels: {
      cache: new Map(),
      fetch: async (channelId) => null,
      create: async (payload) => {
        return makeMockChannel('restored-' + Date.now(), payload.name, payload.type || 0, { guild: this });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Test helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function resetService(service) {
  service.guildSettingsCache.clear();
  service.whitelistCache.clear();
  service.deletionTracker.clear();
  service.restorationQueues.clear();
  service.recentRestorations.clear();
  collectedLogs.info = [];
  collectedLogs.warn = [];
  collectedLogs.error = [];
  collectedLogs.debug = [];
}

/** Drain the guild's restoration queue by waiting long enough */
async function drainQueue(ms = 4000) {
  await new Promise((r) => setTimeout(r, ms));
}

// Inject guild settings directly into cache (no DB call needed)
function injectSettings(service, guildId, overrides = {}) {
  service.guildSettingsCache.set(guildId, {
    guildId,
    isEnabled: overrides.isEnabled ?? true,
    limitCount: overrides.limitCount ?? 3,
    timeWindow: overrides.timeWindow ?? 10,
    punishmentType: overrides.punishmentType ?? 'quarantine',
    quarantineRoleId: overrides.quarantineRoleId ?? null,
    logChannelId: overrides.logChannelId ?? '555000000000000001',
  });
}

// Inject whitelist entry
function injectWhitelist(service, guildId, userId) {
  if (!service.whitelistCache.has(guildId)) {
    service.whitelistCache.set(guildId, new Map());
  }
  service.whitelistCache.get(guildId).set(userId, true);
}

// ---------------------------------------------------------------------------
// 6. Simulate deletion events
// ---------------------------------------------------------------------------
async function simulateDeletions(service, guild, executorMember, count, type = 'channel', snapshot = null) {
  for (let i = 0; i < count; i++) {
    const dummyData = type === 'channel'
      ? { id: `chan-${i}`, name: `test-channel-${i}`, type: 0 }
      : { id: `role-${i}`, name: `test-role-${i}` };

    const defaultSnapshot = type === 'channel'
      ? { channel: { id: `chan-${i}`, name: `test-channel-${i}`, type: 0, permissionOverwrites: [] } }
      : { role: { id: `role-${i}`, name: `test-role-${i}`, color: 0, position: 1, permissionsBitfield: '0' } };

    await service.handleEvent(guild, executorMember, {
      type,
      data: dummyData,
      targetSnapshot: snapshot || defaultSnapshot,
    });
  }
}

// ---------------------------------------------------------------------------
// 7. Run all tests
// ---------------------------------------------------------------------------
async function runAllTests() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   Anti-Nuke System — Local Simulation Test Suite    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const service = AntiNukeService.getInstance();
  const guildId = '111000000000000001';
  const guild = makeMockGuild(guildId, 'TestGuild', { botHighestRolePosition: 999 });

  // =====================================================================
  // TEST CASE 1: Sliding Window & Whitelist Validation
  // =====================================================================
  console.log('── Test Case 1: Sliding Window & Whitelist Validation ──\n');
  resetService(service);
  injectSettings(service, guildId, { isEnabled: true, limitCount: 3, timeWindow: 10 });

  // 1a: Whitelisted user — do 5 deletions, should all be ignored
  const whitelistedUser = makeMockMember('222000000000000001', 'TrustedAdmin', {
    highestRolePosition: 100,
  });
  injectWhitelist(service, guildId, '222000000000000001');

  await simulateDeletions(service, guild, whitelistedUser, 5, 'channel');
  const tracker1a = service.deletionTracker.get(guildId);
  const whitelistHadTracking = tracker1a && tracker1a.has('222000000000000001');
  assert(!whitelistHadTracking, '1a: Whitelisted user — no deletion tracking recorded');
  assert(
    !service.recentRestorations.get(guildId) ||
      service.recentRestorations.get(guildId).length === 0,
    '1a: Whitelisted user — no restoration triggered'
  );

  // 1b: Non-whitelisted user, 2 deletions when limit=3 — should NOT trigger
  const normalUser = makeMockMember('333000000000000001', 'NormalMod', {
    highestRolePosition: 50,
  });
  resetService(service);
  injectSettings(service, guildId, { isEnabled: true, limitCount: 3, timeWindow: 10 });

  await simulateDeletions(service, guild, normalUser, 2, 'channel');
  const tracker1b = service.deletionTracker.get(guildId);
  const userTrack = tracker1b?.get('333000000000000001');
  assert(userTrack && userTrack.timestamps.length === 2, '1b: Below-threshold user — 2 timestamps recorded');
  assert(
    !service.recentRestorations.get(guildId) ||
      service.recentRestorations.get(guildId).length === 0,
    '1b: Below-threshold user — no restoration triggered'
  );

  // =====================================================================
  // TEST CASE 2: Attack Detection & Quarantine Trigger
  // =====================================================================
  console.log('\n── Test Case 2: Attack Detection & Quarantine Trigger ──\n');
  resetService(service);
  injectSettings(service, guildId, { isEnabled: true, limitCount: 3, timeWindow: 5, quarantineRoleId: null });

  const rogueUser = makeMockMember('444000000000000001', 'RogueUser', {
    highestRolePosition: 10,
    roles: ['role-admin', 'role-mod'],
  });

  await simulateDeletions(service, guild, rogueUser, 4, 'channel');

  // After 4 deletions with limit=3:
  //   i=2 → trigger punishment → timestamps = [] → enqueueRestoration (1500ms delay)
  //   i=3 → timestamps = [t3] → length=1, no trigger
  const tracker2 = service.deletionTracker.get(guildId);
  const rogueTrack = tracker2?.get('444000000000000001');
  assert(rogueTrack && rogueTrack.timestamps.length === 1, '2a: Rogue user — timestamps = 1 (reset on trigger + 4th pushed)');

  // Wait for restoration queue to drain (1500ms delay + buffer)
  await drainQueue(3000);
  assert(
    service.recentRestorations.get(guildId)?.length >= 1,
    '2b: Rogue user — restoration recorded after queue drain'
  );

  // =====================================================================
  // TEST CASE 3: Sequential Restoration Queue & Spacing
  // =====================================================================
  console.log('\n── Test Case 3: Sequential Restoration Queue & Spacing ──\n');
  // Drain any leftovers from test 2 before resetting
  await drainQueue(2000);
  resetService(service);
  injectSettings(service, guildId, { isEnabled: true, limitCount: 1, timeWindow: 60 });

  const spamUser = makeMockMember('555000000000000001', 'Spammer', {
    highestRolePosition: 10,
    roles: ['role-staff'],
  });

  // Push 5 channel deletions simultaneously — each triggers punishment immediately (limit=1)
  for (let i = 0; i < 5; i++) {
    const dummyChan = makeMockChannel(`chan-batch-${i}`, `batch-chan-${i}`, 0, { guild });
    const snap = {
      channel: {
        id: `chan-batch-${i}`,
        name: `batch-chan-${i}`,
        type: 0,
        permissionOverwrites: [],
      },
    };
    await service.handleEvent(guild, spamUser, { type: 'channel', data: dummyChan, targetSnapshot: snap });
  }

  // Wait for the queue to finish (5 items * 1500ms spacing + buffer)
  console.log('  Waiting for restoration queue to complete...');
  await drainQueue(9000);

  const restorations3 = service.recentRestorations.get(guildId) || [];
  assert(restorations3.length === 5, `3a: Queue processed exactly 5 restorations (got ${restorations3.length})`);

  // Check spacing: each restoration timestamp should differ by at least 1400ms
  if (restorations3.length >= 2) {
    const timestamps = restorations3.map((e) => new Date(e.at).getTime()).sort((a, b) => a - b);
    let gapsOk = true;
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      if (gap < 1400) {
        gapsOk = false;
        console.log(`    Gap ${i}: ${gap}ms (< 1400ms)`);
      }
    }
    assert(gapsOk, '3b: All restoration timestamps spaced ≥1400ms apart');
  }

  // =====================================================================
  // TEST CASE 4: Hierarchy Failure Handling
  // =====================================================================
  console.log('\n── Test Case 4: Hierarchy Failure Handling ─────────────\n');
  // Drain leftovers before reset
  await drainQueue(2000);
  resetService(service);

  // Create a SEPARATE guild where the bot has a LOW position (@everyone only = 0)
  // and the target user has a role at position 100 → hierarchyOk = false
  const hierarchyGuildId = '222000000000000002';
  const hierarchyGuild = makeMockGuild(hierarchyGuildId, 'HierarchyGuild', { botHighestRolePosition: 0 });
  injectSettings(service, hierarchyGuildId, { isEnabled: true, limitCount: 1, timeWindow: 30, logChannelId: '555000000000000001' });

  // User with role at position 100 → targetHighest = 100, botHighest = 0
  const highRankUser = makeMockMember('666000000000000001', 'HighRankUser', {
    roles: ['role-owner'],  // position = 1, but bot only has @everyone at 0
  });

  // Also force roles.set to throw (simulating Discord API hierarchy error)
  highRankUser.roles.set = async () => {
    throw new Error('Missing Permissions — hierarchy failure');
  };

  let crashed = false;
  try {
    await simulateDeletions(service, hierarchyGuild, highRankUser, 2, 'channel');
  } catch (e) {
    crashed = true;
    console.log(`  ✗ Test 4 CRASHED: ${e.message}`);
  }
  assert(!crashed, '4a: triggerPunishment does NOT crash on hierarchy failure');

  // Check that restoration still proceeded despite quarantine failure
  await drainQueue(3000);
  const restorations4 = service.recentRestorations.get(hierarchyGuildId) || [];
  assert(restorations4.length >= 1, '4b: Restoration still executed despite quarantine failure');

  // Check that a warning was logged about hierarchy
  const hasHierarchyWarn = collectedLogs.warn.some(
    (w) => w && (typeof w === 'string' && (w.includes('hierarchy') || w.includes('Hierarchy') || w.includes('cannot quarantine')))
  );
  assert(hasHierarchyWarn, '4c: Hierarchy warning logged in collectedLogs.warn');

  // Also verify that the old ReferenceError bug is gone
  assert(
    !collectedLogs.error.some((m) => m && m.includes('eventType is not defined')),
    '4d: No ReferenceError about eventType (bug #5 fixed)'
  );

  // =====================================================================
  // SUMMARY
  // =====================================================================
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  RESULTS:  ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('══════════════════════════════════════════════════════════\n');

  if (failed === 0) {
    console.log('🎉 All tests passed! The Anti-Nuke system is functioning correctly.');
  } else {
    console.log('⚠️  Some tests failed. Review the output above for details.');
  }

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch((err) => {
  console.error('FATAL: Test suite crashed:', err);
  process.exit(1);
});
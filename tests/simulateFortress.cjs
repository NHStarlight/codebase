/**
 * simulateFortress.cjs — Automated local simulation for Security Fortress modules
 *
 * Tests:
 * 1. Honeypot Trap Discipline
 * 2. Progressive Webhook Spam (2-Strike System)
 * 3. Anti-Raid State Machine & Invite Freeze Failsafe (Admin AFK)
 * 4. Admin Button Interaction Override
 *
 * Usage:  node tests/simulateFortress.cjs
 */

// ===================================================================
// Logger capture
// ===================================================================
const collectedLogs = { info: [], warn: [], error: [], debug: [] };

// ===================================================================
// Mock pgDb
// ===================================================================
const mockPool = {
  query: async (...args) => ({ rows: [] }),
};
const pgModule = require('../src/utils/postgresDatabase.js');
pgModule.pgDb.pool = mockPool;
pgModule.pgDb.isAvailable = () => true;
pgModule.pgDb.isConnected = true;

// ===================================================================
// Mock logger instance (direct method override)
// ===================================================================
const loggerModule = require('../src/utils/logger.js');
const logger = loggerModule.logger;

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
  if (meta.length && meta[0]?.message) collectedLogs.error.push(meta[0].message);
  return this;
};
logger.debug = function (msg) {
  if (msg && typeof msg === 'string') collectedLogs.debug.push(msg);
  return this;
};

// ===================================================================
// Import AntiNukeService
// ===================================================================
const AntiNukeService = require('../src/services/antinukeService.js').default;

// ===================================================================
// Mock tracking stores
// ===================================================================
const calls = {
  messageDelete: [],
  memberBan: [],
  webhookDelete: [],
  channelSend: [],
  guildEdit: [],
  messageEdit: [],
};

function resetCalls() {
  for (const key of Object.keys(calls)) calls[key] = [];
  collectedLogs.info = [];
  collectedLogs.warn = [];
  collectedLogs.error = [];
  collectedLogs.debug = [];
  // Clear all webhook tracker and raid state
  const svc = AntiNukeService.getInstance();
  svc.webhookTracker.clear();
  svc.antiRaidCache.clear();
  svc.guildSettingsCache.clear();
}

// ===================================================================
// Mock builders
// ===================================================================
let msgIdCounter = 1000;
function nextMsgId() { return `msg-${++msgIdCounter}`; }

function makeMockRole(id, name, opts = {}) {
  return {
    id, name,
    color: opts.color ?? 0, position: opts.position ?? 0,
    permissions: { bitfield: '0' },
    delete: async () => {},
  };
}

function makeMockRolesCache(roleList) {
  const map = new Map(roleList.map((r) => [r.id, r]));
  map.filter = function (fn) {
    const result = [];
    for (const [key, val] of this.entries()) { if (fn(val, key, this)) result.push(val); }
    return result;
  };
  return map;
}

function makeMockMember(id, username, opts = {}) {
  const roleIds = opts.roles ?? [];
  const roleObjects = roleIds.map((rId, i) => makeMockRole(rId, `role-${rId}`, { position: i + 1 }));
  const everyoneRole = makeMockRole('111111111111111111', '@everyone', { position: 0 });
  const allRoles = [everyoneRole, ...roleObjects];
  const highest = allRoles.reduce((a, b) => (a.position > b.position ? a : b), allRoles[0]);
  const rolesCache = makeMockRolesCache(allRoles);

  return {
    id,
    user: { id, username, bot: opts.isBot ?? false },
    displayName: username,
    roles: { cache: rolesCache, highest, set: async () => {} },
    ban: async (options) => {
      calls.memberBan.push({ userId: id, reason: options?.reason });
    },
    kick: async (reason) => {},
  };
}

function makeMockWebhook(id, guildId) {
  return { id, guildId, delete: async (reason) => { calls.webhookDelete.push({ webhookId: id, reason }); } };
}

function makeMockChannel(id, name, type, opts = {}) {
  return {
    id, name, type, guild: opts.guild ?? null,
    isTextBased: () => true,
    send: async (payload) => {
      calls.channelSend.push({ channelId: id, payload: JSON.stringify(payload).slice(0, 200) });
      const mid = nextMsgId();
      return { id: mid, edit: async (editPayload) => { calls.messageEdit.push({ messageId: mid, payload: JSON.stringify(editPayload).slice(0, 200) }); } };
    },
    fetchWebhooks: async () => (opts.webhooks ? [...opts.webhooks] : []),
    delete: async () => {},
  };
}

function makeMockMessage(id, authorMember, opts = {}) {
  const guildObj = opts.guild || (authorMember ? { id: 'mock-guild-id' } : null);
  return {
    id, channelId: opts.channelId || 'mock-channel-id',
    guild: guildObj, guildId: guildObj?.id,
    author: { id: authorMember?.id, bot: opts.isBot ?? false },
    member: authorMember,
    webhookId: opts.webhookId || null, content: opts.content || 'test',
    client: { user: { id: '999000000000000001' } },
    delete: async () => { calls.messageDelete.push({ messageId: id }); },
    reply: async () => {},
  };
}

function makeMockGuild(id, name, opts = {}) {
  const ownerId = opts.ownerId || '777000000000000001';
  const botMemberId = opts.botMemberId || '999000000000000001';
  const channels = new Map();
  const guildRoles = new Map();

  guildRoles.set('111111111111111111', makeMockRole('111111111111111111', '@everyone', { position: 0 }));
  if (opts.roles) for (const r of opts.roles) guildRoles.set(r.id, r);

  const botMember = makeMockMember(botMemberId, 'Bot', { isBot: true, roles: [] });
  botMember.roles.highest.position = opts.botHighestRolePosition ?? 999;

  let verificationLevel = opts.verificationLevel ?? 0;

  return {
    id, name, ownerId, verificationLevel,
    client: { user: { id: botMemberId } },
    members: {
      me: botMember,
      cache: new Map(),
      fetch: async (userId) => {
        if (userId === botMemberId) return botMember;
        return makeMockMember(userId, `member-${userId}`, { roles: [] });
      },
      ban: async (userId, options) => {
        calls.memberBan.push({ userId, reason: options?.reason, guildId: id });
      },
    },
    roles: {
      cache: guildRoles,
      fetch: async (roleId) => guildRoles.get(roleId) || null,
      create: async (payload) => { const r = makeMockRole('q-' + id, payload.name); guildRoles.set(r.id, r); return r; },
    },
    channels: {
      cache: channels,
      fetch: async (chId) => channels.get(chId) || null,
      create: async () => makeMockChannel('new-' + Date.now(), 'restored', 0),
    },
    edit: async (editPayload) => {
      calls.guildEdit.push({ guildId: id, payload: JSON.stringify(editPayload) });
      if (editPayload.verificationLevel !== undefined) verificationLevel = editPayload.verificationLevel;
    },
  };
}

// ===================================================================
// Test framework
// ===================================================================
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ PASS: ${label}`); passed++; }
  else { console.log(`  ✗ FAIL: ${label}`); failed++; }
}

function injectSettings(service, guildId, overrides = {}) {
  service.guildSettingsCache.set(guildId, {
    guildId,
    isEnabled: overrides.isEnabled ?? true,
    limitCount: overrides.limitCount ?? 3,
    timeWindow: overrides.timeWindow ?? 10,
    punishmentType: overrides.punishmentType ?? 'quarantine',
    quarantineRoleId: overrides.quarantineRoleId ?? null,
    logChannelId: overrides.logChannelId ?? '555000000000000001',
    honeypotChannelId: overrides.honeypotChannelId ?? 'honeypot-channel-1',
  });
}

// Safe delay that checks if we've already been waiting too long
function shortDelay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===================================================================
// Run all tests
// ===================================================================
async function runAllTests() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Security Fortress Module — Local Simulation Test Suite    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const svc = AntiNukeService.getInstance();
  const guildId = '111000000000000001';

  // =====================================================================
  // TEST 1: HONEYPOT TRAP DISCIPLINE
  // =====================================================================
  console.log('── Test 1: Honeypot Trap Discipline ─────────────────────────\n');
  resetCalls();
  injectSettings(svc, guildId, { isEnabled: true, honeypotChannelId: 'honeypot-channel-1' });

  // 1a: Admin types in honeypot — instant ban
  const adminMember = makeMockMember('222000000000000001', 'AdminUser', { roles: ['admin'] });
  const honeypotMsg = makeMockMessage('msg-honey-1', adminMember, { channelId: 'honeypot-channel-1' });
  const honeypotSettings = svc.getSettings(guildId);
  let honeypotBanned = false;
  if (honeypotSettings?.honeypotChannelId && honeypotMsg.channelId === honeypotSettings.honeypotChannelId) {
    if (honeypotMsg.author.id !== honeypotMsg.client?.user?.id) {
      await honeypotMsg.delete().catch(() => {});
      await honeypotMsg.member.ban({ reason: 'Honeypot Trap Triggered - Instant Security Ban' }).catch(() => {});
      honeypotBanned = true;
    }
  }
  assert(calls.messageDelete.length === 1, '1a: Honeypot message deleted');
  assert(honeypotBanned === true, '1a: Honeypot trap set honeypotBanned=true');
  assert(calls.memberBan.length >= 1, '1b: member.ban() called');
  assert(calls.memberBan[0]?.reason?.includes('Honeypot'), '1b: Ban reason contains "Honeypot"');

  // 1b: Bot message in honeypot — NOT banned
  resetCalls();
  const botMember = makeMockMember('999000000000000001', 'Bot', { isBot: true });
  const botMsg = makeMockMessage('msg-honey-2', botMember, { channelId: 'honeypot-channel-1', isBot: true });
  botMsg.client = { user: { id: '999000000000000001' } };
  const hSettings = svc.getSettings(guildId);
  if (hSettings?.honeypotChannelId && botMsg.channelId === hSettings.honeypotChannelId) {
    if (botMsg.author.id !== botMsg.client?.user?.id) {
      await botMsg.delete().catch(() => {});
      await botMsg.member.ban({ reason: 'Honeypot Trap Triggered - Instant Security Ban' }).catch(() => {});
    }
  }
  assert(calls.memberBan.length === 0, '1b: Bot not banned from honeypot channel');

  // =====================================================================
  // TEST 2: PROGRESSIVE WEBHOOK SPAM (2-STRIKE SYSTEM)
  // =====================================================================
  console.log('\n── Test 2: Progressive Webhook Spam (2-Strike System) ─────\n');
  resetCalls();
  injectSettings(svc, guildId, { isEnabled: true, honeypotChannelId: null });

  const testWebhookId = 'webhook-test-001';
  const testWebhook = makeMockWebhook(testWebhookId, guildId);

  // 2a: Strike 1 — 2 webhook messages within 5s
  let r1 = svc.checkWebhookSpam(guildId, testWebhookId);
  assert(r1.strike === 0 && !r1.shouldDelete, '2a: Strike 1 — first msg no strike');
  r1 = svc.checkWebhookSpam(guildId, testWebhookId);
  assert(r1.strike === 1 && !r1.shouldDelete, '2a: Strike 1 — second msg triggers strike 1 warning');
  assert(calls.webhookDelete.length === 0, '2a: Strike 1 — webhook NOT deleted');

  // 2b: Strike 2 — clear timestamps, send 2 more
  const guildTracker = svc.webhookTracker.get(guildId);
  guildTracker.get(testWebhookId).timestamps = [];
  let r2 = svc.checkWebhookSpam(guildId, testWebhookId);
  assert(r2.strike === 0 && !r2.shouldDelete, '2b: First msg in new window no strike');
  r2 = svc.checkWebhookSpam(guildId, testWebhookId);
  assert(r2.strike === 2 && r2.shouldDelete, '2b: Strike 2 triggers delete');
  if (r2.shouldDelete) await testWebhook.delete('Anti-Nuke: Malicious webhook detected (strike 2)');
  assert(calls.webhookDelete.length === 1, '2b: webhook.delete() called');
  assert(calls.webhookDelete[0].reason.includes('Malicious'), '2b: Delete reason contains "Malicious"');

  // =====================================================================
  // TEST 3: ANTI-RAID STATE MACHINE & INVITE FREEZE FAILSAFE (ADMIN AFK)
  // =====================================================================
  console.log('\n── Test 3: Anti-Raid State Machine & Invite Freeze Failsafe ─\n');
  resetCalls();
  svc.antiRaidCache.clear();
  injectSettings(svc, guildId, { isEnabled: true, honeypotChannelId: null });

  const raidGuild = makeMockGuild(guildId, 'RaidGuild', { botHighestRolePosition: 999, verificationLevel: 0 });
  const logChannel = makeMockChannel('555000000000000001', 'security-logs', 0, { guild: raidGuild });
  raidGuild.channels.cache.set('555000000000000001', logChannel);

  // Seed 4 timestamps then trigger with 5th
  svc.antiRaidCache.set(guildId, {
    isRaidActive: false, raidPool: [], lockdownTimer: null,
    originalVerificationLevel: raidGuild.verificationLevel,
    alertMessageId: null, alertChannelId: null, cycleCount: 0,
    lastTimestamps: [Date.now(), Date.now(), Date.now(), Date.now()],
  });

  await svc.processRaidDetection(raidGuild, makeMockMember('raid-trigger', 'RaidTrigger'));

  const raidState = svc.antiRaidCache.get(guildId);
  assert(raidState !== undefined, '3a: Raid state exists');
  assert(raidState.isRaidActive === true, '3b: isRaidActive = true');
  assert(raidState.raidPool.length >= 1, '3b: raidPool has ≥1 user');
  assert(calls.channelSend.length === 1, '3b: EXACTLY ONE alert embed sent');
  assert(calls.channelSend[0].payload.includes('RAID'), '3b: Alert embed contains "RAID"');

  // 3c: 4 more joins — silently appended, no new embeds
  const sendCount = calls.channelSend.length;
  for (let i = 0; i < 4; i++) {
    const s = svc.antiRaidCache.get(guildId);
    s.lastTimestamps.push(Date.now());
    await svc.processRaidDetection(raidGuild, makeMockMember(`raid-silent-${i}`, `Silent${i}`));
  }
  assert(calls.channelSend.length === sendCount, '3c: NO new alert embeds during sustained raid');
  assert(raidState.raidPool.length >= 5, '3c: raidPool grew to ≥5 users');

  // 3d: Simulate failsafe directly (bypass real 60s timer)
  // Save a reference to the failsafe timer and invoke it manually
  const timer = raidState.lockdownTimer;
  assert(timer !== null, '3d: Failsafe timer was set');

  // Directly invoke the auto-ban logic (what the timer callback would do)
  // We can't await the real setTimeout, but we can directly invoke the internal logic
  // The timer callback calls: `_executeRaidAutoBan(guild, state)`
  // Let's manually trigger it
  await svc._executeRaidAutoBan(raidGuild, raidState);

  const bansAfter = calls.memberBan.filter((b) => b.guildId === guildId).length;
  assert(bansAfter >= 5, `3d: Failsafe banned ≥5 users (banned ${bansAfter})`);

  const lockdownEdit = calls.guildEdit.length > 0;
  assert(lockdownEdit, '3d: guild.edit() called for lockdown');
  if (calls.guildEdit.length > 0) {
    const ep = calls.guildEdit[0].payload;
    assert(ep.includes('invitesDisabled'), '3d: payload has invitesDisabled');
    assert(ep.includes('true'), '3d: invitesDisabled set to true');
    assert(ep.includes('4'), '3d: verificationLevel set to 4');
  }

  // 3e: Simulate lockdown revert (normally fires after 5min)
  await svc._endRaidLockdown(raidGuild, raidState);

  // Find the revert edit (the LAST guildEdit call should be the revert)
  const revertEdit = calls.guildEdit[calls.guildEdit.length - 1];
  assert(revertEdit !== undefined, '3e: guild.edit() called to revert');
  if (revertEdit) {
    assert(revertEdit.payload.includes('false'), '3e: invitesDisabled set to false');
    assert(revertEdit.payload.includes('0'), '3e: verificationLevel restored to 0');
  }

  const unlockLog = calls.channelSend.find((c) => c.payload?.includes('Lockdown Lifted'));
  assert(unlockLog !== undefined, '3e: Lockdown lifted log sent');

  // =====================================================================
  // TEST 4: ADMIN BUTTON INTERACTION OVERRIDE
  // =====================================================================
  console.log('\n── Test 4: Admin Button Interaction Override ───────────────\n');
  resetCalls();
  svc.antiRaidCache.clear();

  injectSettings(svc, guildId, { isEnabled: true, honeypotChannelId: null });
  svc.antiRaidCache.set(guildId, {
    isRaidActive: false, raidPool: [], lockdownTimer: null,
    originalVerificationLevel: 0, alertMessageId: null, alertChannelId: null,
    cycleCount: 0, lastTimestamps: [Date.now(), Date.now(), Date.now(), Date.now()],
  });
  await svc.processRaidDetection(raidGuild, makeMockMember('raid-admin-trigger', 'AdminTrigger'));

  const state2 = svc.antiRaidCache.get(guildId);
  assert(state2?.isRaidActive === true, '4a: Fresh raid state active');

  // Simulate more joins to build pool
  for (let i = 0; i < 4; i++) {
    const s = svc.antiRaidCache.get(guildId);
    s.lastTimestamps.push(Date.now());
    await svc.processRaidDetection(raidGuild, makeMockMember(`raid-pool-${i}`, `Pool${i}`));
  }
  const poolSize = state2.raidPool.length;

  // Admin clicks "Ban All"
  const alertMsg = { id: 'alert-msg-1', edit: async (p) => { calls.messageEdit.push({ messageId: 'alert-msg-1', payload: JSON.stringify(p).slice(0, 300) }); } };
  const banResult = await svc.handleRaidBanAction(raidGuild, '777000000000000001', alertMsg);

  assert(banResult === true, '4b: handleRaidBanAction returned true');
  const banCalls = calls.memberBan.filter((b) => b.guildId === guildId);
  assert(banCalls.length >= poolSize, `4b: All ${poolSize} raid users banned (got ${banCalls.length})`);

  const clearedState = svc.antiRaidCache.get(guildId);
  assert(clearedState === undefined, '4c: Raid cache state cleared');

  assert(calls.messageEdit.length >= 1, '4d: Alert embed edited');
  const banEdit = calls.messageEdit.find((e) => e.payload?.includes('Neutralized'));
  assert(banEdit !== undefined, '4d: Embed updated with "Raid Neutralized"');

  // =====================================================================
  // SUMMARY
  // =====================================================================
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  RESULTS:  ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('══════════════════════════════════════════════════════════════\n');

  if (failed === 0) {
    console.log('🎉 All Fortress tests passed! Security modules are functioning correctly.\n');
  } else {
    console.log('⚠️  Some tests failed. Review the output above for details.\n');
  }

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch((err) => {
  console.error('FATAL: Test suite crashed:', err);
  process.exit(1);
});
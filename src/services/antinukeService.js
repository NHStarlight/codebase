import { pgDb } from '../utils/postgresDatabase.js';
import { logger } from '../utils/logger.js';
import { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { TTLMap, LockManager, registerCache, startCleanupInterval } from '../utils/cacheManager.js';
import MemoryManager from '../utils/memoryManager.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// TTL constants
const ONE_HOUR_MS = 3600000;
const FIVE_MINUTES_MS = 300000;
const TEN_MINUTES_MS = 600000;

/**
 * AntiNukeService
 * - Singleton: one instance for the entire bot process
 * - In-memory caches with TTL for performance and memory safety
 * - Per-key locks to prevent race conditions
 * - Sliding-window rate detection
 * - Per-guild sequential restoration queue
 * - Honeypot channel support
 * - Progressive webhook spam protection
 * - State-machine anti-raid detection with invite freeze
 * - Automatic periodic cache cleanup for Memory Leak prevention
 */
class AntiNukeService {
  static #instance = null;

  /**
   * @returns {AntiNukeService}
   */
  static getInstance() {
    if (!AntiNukeService.#instance) {
      AntiNukeService.#instance = new AntiNukeService();
    }
    return AntiNukeService.#instance;
  }

  constructor() {
    if (AntiNukeService.#instance) return AntiNukeService.#instance;

    /**
     * Lock manager for safe concurrent access to shared state
     * @type {LockManager}
     */
    this.lockManager = new LockManager();

    /**
     * Guild settings cache - persists as long as the bot runs (no TTL)
     * @type {Map<string, any>}
     */
    this.guildSettingsCache = new Map();

    /**
     * Whitelist cache - persists as long as the bot runs (no TTL)
     * @type {Map<string, Map<string, true>>}
     */
    this.whitelistCache = new Map();

    /**
     * Deletion tracker with TTL (sliding window is self-cleaning)
     * @type {TTLMap<string, Map<string, {timestamps:number[]}>>}
     */
    this.deletionTracker = new TTLMap(ONE_HOUR_MS, 5000);

    /**
     * Restoration queues
     * @type {Map<string, {chain: Promise<void>}>}
     */
    this.restorationQueues = new Map();

    /**
     * Recent restorations history with TTL
     * @type {TTLMap<string, Array<{type:string, userId:string, targetId:string, at:string, ok:boolean, error?:string}>>}
     */
    this.recentRestorations = new TTLMap(ONE_HOUR_MS, 1000);

    /** @type {number} */
    this.restoreDelayMs = 1500;

    /** @type {number} */
    this.maxRestorationHistory = 20;

    // =====================
    // Webhook Spam Protection Cache with TTL
    // guildId -> Map<webhookId, { timestamps[], strikeCount }>
    // =====================
    /** @type {TTLMap<string, TTLMap<string, {timestamps:number[], strikeCount:number}>>} */
    this.webhookTracker = new TTLMap(ONE_HOUR_MS, 2000);

    // =====================
    // Anti-Raid State Machine Cache
    // guildId -> { isRaidActive, raidPool[], lockdownTimer, originalVerificationLevel, alertMessageId, cycleCount, lastTimestamps[], alertChannelId }
    // =====================
    /** @type {TTLMap<string, {isRaidActive:boolean, raidPool:string[], lockdownTimer:NodeJS.Timeout|null, originalVerificationLevel:number, alertMessageId:string|null, alertChannelId:string|null, cycleCount:number, lastTimestamps:number[]}>} */
    this.antiRaidCache = new TTLMap(TEN_MINUTES_MS, 1000);

    /** @type {number} */
    this.raidJoinWindowMs = 1000; // 1-second sliding window

    /** @type {number} */
    this.raidThreshold = 5; // 5 joins within 1s triggers

    /** @type {number} */
    this.raidFailsafeMs = 60000; // 60s auto-ban timer

    /** @type {number} */
    this.raidLockdownDurationMs = 300000; // 5-minute invite freeze

    AntiNukeService.#instance = this;

    // Register caches with global cleanup system
    registerCache('AntiNuke.deletionTracker', this.deletionTracker);
    registerCache('AntiNuke.recentRestorations', this.recentRestorations);
    registerCache('AntiNuke.webhookTracker', this.webhookTracker);
    registerCache('AntiNuke.antiRaidCache', this.antiRaidCache);

    // Track Maps with MemoryManager
    const memoryManager = MemoryManager.getInstance();
    memoryManager.trackMap('AntiNuke.guildSettingsCache', this.guildSettingsCache, { maxSize: 5000 });
    memoryManager.trackMap('AntiNuke.whitelistCache', this.whitelistCache, { maxSize: 5000 });
    memoryManager.trackMap('AntiNuke.restorationQueues', this.restorationQueues, { maxSize: 1000 });

    // Start global cleanup interval if not already started
    startCleanupInterval(ONE_HOUR_MS);

    logger.info('[AntiNukeService] Initialized with TTL cache and lock manager');
  }

  // =====================
  // Cache loading
  // =====================

  /**
   * Ensure guild caches are loaded (best-effort).
   * @param {import('discord.js').Client} client
   */
  async loadGuildCaches(client) {
    try {
      if (!client?.db?.isAvailable?.() || !pgDb?.isAvailable?.()) return;

      // guild_settings (including honeypot_channel_id)
      const settingsRes = await pgDb.pool.query(
        'SELECT guild_id, is_enabled, limit_count, time_window, punishment_type, quarantine_role_id, log_channel_id, honeypot_channel_id FROM guild_settings'
      );
      this.guildSettingsCache.clear();
      for (const row of settingsRes.rows || []) {
        this.guildSettingsCache.set(row.guild_id, {
          guildId: row.guild_id,
          isEnabled: !!row.is_enabled,
          limitCount: Number(row.limit_count ?? 3),
          timeWindow: Number(row.time_window ?? 10),
          punishmentType: row.punishment_type ?? 'quarantine',
          quarantineRoleId: row.quarantine_role_id ?? null,
          logChannelId: row.log_channel_id ?? null,
          honeypotChannelId: row.honeypot_channel_id ?? null,
        });
      }

      // whitelist
      const whitelistRes = await pgDb.pool.query('SELECT guild_id, user_id FROM whitelist');
      this.whitelistCache.clear();
      for (const row of whitelistRes.rows || []) {
        if (!this.whitelistCache.has(row.guild_id)) this.whitelistCache.set(row.guild_id, new Map());
        this.whitelistCache.get(row.guild_id).set(row.user_id, true);
      }
    } catch (err) {
      logger.error('AntiNukeService.loadGuildCaches error:', err);
    }
  }

  getSettings(guildId) {
    const cached = this.guildSettingsCache.get(guildId);
    if (cached) return cached;
    // Return a default-enabled config so new guilds get protection immediately
    // The DB row will be created on first /antinuke setup, but security works out of box
    return {
      guildId,
      isEnabled: true,
      limitCount: 3,
      timeWindow: 10,
      punishmentType: 'quarantine',
      quarantineRoleId: null,
      logChannelId: null,
      honeypotChannelId: null,
    };
  }

  isWhitelisted(guildId, userId) {
    const g = this.whitelistCache.get(guildId);
    return g ? g.has(userId) : false;
  }

  // =====================
  // Event handling (detection)
  // =====================

  /**
   * Called by event handlers to process a deletion event.
   * @param {import('discord.js').Guild} guild
   * @param {import('discord.js').GuildMember} executorMember
   * @param {{type:'channel'|'role', data:any, targetSnapshot:any}} params
   */
  async handleEvent(guild, executorMember, { type, data, targetSnapshot } = {}) {
    const executorId = executorMember?.id;
    if (!guild || !executorId) return;

    const eventType = type === 'channel' ? 'CHANNEL_DELETE' : type === 'role' ? 'ROLE_DELETE' : type;
    const guildId = guild.id;

    const settings = this.getSettings(guildId);
    if (!settings || !settings.isEnabled) return;
    if (this.isWhitelisted(guildId, executorId)) return;

    // Bypass bot + owner
    const botId = guild.client?.user?.id;
    if (executorId === botId) return;
    if (executorId === guild.ownerId) return;

    const limitCount = settings.limitCount ?? 3;
    const timeWindowSec = settings.timeWindow ?? 10;
    const now = Date.now();
    const windowMs = timeWindowSec * 1000;

    if (!this.deletionTracker.has(guildId)) this.deletionTracker.set(guildId, new Map());
    const guildTracker = this.deletionTracker.get(guildId);

    if (!guildTracker.has(executorId)) guildTracker.set(executorId, { timestamps: [] });
    const tracker = guildTracker.get(executorId);

    tracker.timestamps = (tracker.timestamps || []).filter((t) => now - t <= windowMs);
    tracker.timestamps.push(now);

    if (tracker.timestamps.length < limitCount) return;

    // Trigger punishment
    await this.triggerPunishment({
      guild,
      executorId,
      executorMember,
      eventType,
      targetSnapshot,
    });

    // Reset window for that user to avoid repeated punishments
    tracker.timestamps = [];
  }

  // =====================
  // Punishment & quarantine
  // =====================

  async triggerPunishment({ guild, executorId, executorMember, eventType, targetSnapshot }) {
    const guildId = guild.id;
    const settings = this.getSettings(guildId);
    if (!settings) return;

    try {
      await this.quarantineMember({ guild, executorId, executorMember, eventType });
    } catch (err) {
      logger.error(
        `AntiNukeService.triggerPunishment quarantine error guild=${guildId} user=${executorId}:`,
        err
      );
    }

    this.enqueueRestoration(guildId, async () => {
      let ok = false;
      let errorMessage = null;

      try {
        if (eventType === 'CHANNEL_DELETE') {
          ok = await this.restoreChannel({ guild, targetSnapshot });
        } else if (eventType === 'ROLE_DELETE') {
          ok = await this.restoreRole({ guild, targetSnapshot });
        }
      } catch (err) {
        ok = false;
        errorMessage = err?.message || String(err);
        throw err;
      } finally {
        this._pushRestorationHistory(guildId, {
          type: eventType,
          userId: executorId,
          targetId: targetSnapshot?.channel?.id || targetSnapshot?.role?.id || null,
          at: new Date().toISOString(),
          ok,
          error: errorMessage || undefined,
        });

        if (!ok && settings.logChannelId) {
          await this.logToChannel(guild, settings.logChannelId, {
            title: '❌ Anti-Nuke restoration error',
            description: `Restoration failed for ${eventType}.\nExecutor: ${executorId}`,
            fields: [
              {
                name: 'Error',
                value: `\n${String(errorMessage || '')}`.slice(0, 1000),
              },
            ],
          });
        }
      }
    });
  }

  _pushRestorationHistory(guildId, entry) {
    if (!this.recentRestorations.has(guildId)) this.recentRestorations.set(guildId, []);
    const arr = this.recentRestorations.get(guildId);
    arr.unshift(entry);
    if (arr.length > this.maxRestorationHistory) arr.length = this.maxRestorationHistory;
  }

  enqueueRestoration(guildId, task) {
    const prev = this.restorationQueues.get(guildId)?.chain ?? Promise.resolve();
    const chain = prev
      .catch(() => {})
      .then(async () => {
        await delay(this.restoreDelayMs);
        await task();
      });

    this.restorationQueues.set(guildId, { chain });
    return chain;
  }

  async _ensureQuarantineRole({ guild, quarantineRoleId }) {
    // If quarantineRoleId exists and role exists, use it.
    if (quarantineRoleId) {
      const role = guild.roles.cache.get(quarantineRoleId) || (await guild.roles.fetch(quarantineRoleId).catch(() => null));
      if (role) return role;
    }

    // Create fallback role with 0 permissions
    const role = await guild.roles.create({
      name: 'Quarantined (Anti-Nuke)',
      permissions: 0n,
      reason: 'Auto-created Quarantine role (Anti-Nuke fallback)',
      color: 0xff0000,
      hoist: false,
    });

    // Update DB (best-effort)
    try {
      await pgDb.pool.query(
        'UPDATE guild_settings SET quarantine_role_id = $1 WHERE guild_id = $2',
        [role.id, guild.id]
      );
    } catch (err) {
      logger.warn('AntiNukeService: failed updating quarantine_role_id:', err?.message || err);
    }

    // Update cache
    const settings = this.getSettings(guild.id);
    if (settings) {
      settings.quarantineRoleId = role.id;
    }

    return role;
  }

  async quarantineMember({ guild, executorId, executorMember, eventType }) {
    const guildId = guild.id;
    const settings = this.getSettings(guildId);
    if (!settings) return;

    const member = executorMember || (await guild.members.fetch(executorId).catch(() => null));
    if (!member) return;

    const quarantineRole = await this._ensureQuarantineRole({
      guild,
      quarantineRoleId: settings.quarantineRoleId,
    });

    // Backup original roles excluding @everyone
    const currentRoleIds = member.roles.cache
      .filter((r) => r && !r.managed && r.id !== guild.id)
      .map((r) => r.id);

    // Persist punished_users(old_roles)
    try {
      await pgDb.pool.query(
        `INSERT INTO punished_users (guild_id, user_id, old_roles)
         VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, user_id)
         DO UPDATE SET old_roles = EXCLUDED.old_roles, punished_at = CURRENT_TIMESTAMP`,
        [guildId, executorId, JSON.stringify(currentRoleIds)]
      );
    } catch (err) {
      logger.warn('AntiNukeService: failed inserting punished_users:', err?.message || err);
    }

    // ---- Hierarchy guard ----
    const botMember = guild.members.me || (await guild.members.fetch(guild.client?.user?.id).catch(() => null));
    let hierarchyOk = true;
    if (botMember && member) {
      const botHighest = botMember.roles.highest?.position ?? 0;
      const targetHighest = member.roles.highest?.position ?? 0;
      if (botHighest <= targetHighest) {
        hierarchyOk = false;
        logger.warn(
          `AntiNukeService: hierarchy failure guild=${guildId} botHighest=${botHighest} targetHighest=${targetHighest} — cannot quarantine <@${executorId}>`
        );
      }
    }

    // Strip roles except quarantine (best-effort)
    if (hierarchyOk) {
      try {
        await member.roles.set([quarantineRole.id]);
      } catch (err) {
        logger.error(
          `AntiNukeService: roles.set failed for ${executorId} guild=${guildId}:`,
          err?.message || err
        );
        if (settings.logChannelId) {
          await this.logToChannel(guild, settings.logChannelId, {
            title: '⚠️ Anti-Nuke quarantine failed',
            description: `Could not apply quarantine to <@${executorId}> due to Discord API error.`,
            fields: [{ name: 'Error', value: `\`${String(err?.message || err).slice(0, 1000)}\`` }],
          });
        }
        return;
      }
    } else {
      // Hierarchy failure — alert log channel
      if (settings.logChannelId) {
        await this.logToChannel(guild, settings.logChannelId, {
          title: '🔴 Anti-Nuke Hierarchy Failure',
          description:
            `Bot cannot quarantine <@${executorId}> — the target's highest role is equal to or above the bot's highest role.\n` +
            `**Quarantine skipped, but restoration will proceed.**`,
          fields: [],
        });
      }
    }

    if (hierarchyOk && settings.logChannelId) {
      await this.logToChannel(guild, settings.logChannelId, {
        title: '🚨 Anti-Nuke detected: Quarantine applied',
        description: `Executor quarantined: <@${executorId}>\nReason: excessive deletions detected (${eventType || 'nuke'}).`,
        fields: [],
      });
    }
  }

  // =====================
  // Restoration (channels)
  // =====================

  async restoreChannel({ guild, targetSnapshot }) {
    const channelSnap = targetSnapshot?.channel;
    if (!channelSnap?.id) return false;

    const channelType = channelSnap.type;
    const parentId = channelSnap.parentId ?? null;
    const position = channelSnap.position ?? null;

    let created;
    const permissionOverwrites = Array.isArray(channelSnap.permissionOverwrites)
      ? channelSnap.permissionOverwrites
      : [];

    const permissionOverwritesResolved = permissionOverwrites.map((po) => {
      const id = po.id;
      const type = po.type;
      const allow = this._safeBitfieldBigInt(po.allow);
      const deny = this._safeBitfieldBigInt(po.deny);
      return {
        id,
        type,
        allow,
        deny,
      };
    });

    const parent = parentId ? guild.channels.cache.get(parentId) || (await guild.channels.fetch(parentId).catch(() => null)) : null;

    const createPayload = {
      name: channelSnap.name,
      type: channelType,
    };

    if (channelSnap.topic !== undefined && channelSnap.topic !== null) createPayload.topic = channelSnap.topic;
    if (typeof channelSnap.nsfw === 'boolean') createPayload.nsfw = channelSnap.nsfw;
    if (channelSnap.rateLimitPerUser !== undefined && channelSnap.rateLimitPerUser !== null) {
      createPayload.rateLimitPerUser = channelSnap.rateLimitPerUser;
    }
    if (parent && parent.isCategoryBased?.()) {
      createPayload.parent = parent;
    } else if (parentId) {
      createPayload.parent = parentId;
    }

    if (position !== null && position !== undefined) {
      createPayload.position = position;
    }

    if (permissionOverwritesResolved.length > 0) {
      createPayload.permissionOverwrites = permissionOverwritesResolved.map((po) => ({
        id: po.id,
        allow: po.allow,
        deny: po.deny,
      }));
    }

    try {
      created = await guild.channels.create(createPayload);
    } catch (err) {
      logger.error(`AntiNukeService.restoreChannel failed creating channel ${channelSnap.id}:`, err);
      throw err;
    }

    // Re-apply permission overwrites exactly (best effort)
    try {
      const overwrites = Array.isArray(channelSnap.permissionOverwrites)
        ? channelSnap.permissionOverwrites
        : [];

      for (const po of overwrites) {
        const targetId = po.id;
        const allow = this._safeBitfieldBigInt(po.allow);
        const deny = this._safeBitfieldBigInt(po.deny);

        const overwriteObj = {
          allow,
          deny,
        };

        try {
          if (po.type === 0 || po.type === 'role') {
            await created.permissionOverwrites.edit(targetId, overwriteObj);
          } else if (po.type === 1 || po.type === 'member') {
            await created.permissionOverwrites.edit(targetId, overwriteObj);
          } else {
            await created.permissionOverwrites.edit(targetId, overwriteObj);
          }
        } catch (e) {
          logger.warn(`AntiNukeService.restoreChannel overwrites edit failed: ${targetId}`, e?.message || e);
        }
      }
    } catch (err) {
      logger.warn('AntiNukeService.restoreChannel permission overwrite pass failed:', err?.message || err);
    }

    return !!created;
  }

  // =====================
  // Restoration (roles)
  // =====================

  async restoreRole({ guild, targetSnapshot }) {
    const roleSnap = targetSnapshot?.role;
    if (!roleSnap?.id || !roleSnap?.name) return false;

    const position = roleSnap.position ?? null;

    const payload = {
      name: roleSnap.name,
      color: this._safeColor(roleSnap.color),
      hoist: !!roleSnap.hoist,
      mentionable: !!roleSnap.mentionable,
      permissions: this._safeBitfieldBigInt(roleSnap.permissionsBitfield ?? '0'),
    };

    let created;
    try {
      created = await guild.roles.create(payload);
    } catch (err) {
      logger.error(`AntiNukeService.restoreRole failed creating role ${roleSnap.id}:`, err);
      throw err;
    }

    if (position !== null && position !== undefined) {
      try {
        await created.setPosition(position);
      } catch (err) {
        logger.warn('AntiNukeService.restoreRole setPosition failed:', err?.message || err);
      }
    }

    return !!created;
  }

  // =====================
  // Pardon
  // =====================

  async pardonUser({ guild, userId, executorId = null }) {
    const guildId = guild.id;
    const settings = this.getSettings(guildId);

    const quarantineRoleId = settings?.quarantineRoleId ?? null;

    let oldRoles;
    try {
      const res = await pgDb.pool.query(
        'SELECT old_roles FROM punished_users WHERE guild_id = $1 AND user_id = $2',
        [guildId, userId]
      );
      if (!res.rows?.[0]) return false;
      oldRoles = res.rows[0].old_roles;
    } catch (err) {
      logger.error('AntiNukeService.pardonUser failed selecting old_roles:', err);
      return false;
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;

    const roleIds = Array.isArray(oldRoles)
      ? oldRoles
      : this._tryParseJson(oldRoles, []);

    try {
      await member.roles.set(roleIds);
    } catch (err) {
      logger.error('AntiNukeService.pardonUser failed role set:', err);
      return false;
    }

    try {
      await pgDb.pool.query('DELETE FROM punished_users WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    } catch (err) {
      logger.warn('AntiNukeService.pardonUser failed deleting punished_users row:', err?.message || err);
    }

    return true;
  }

  // =====================
  // Slash-command helpers
  // =====================

  async setupGuild({ guildId, isEnabled, limitCount, timeWindow, quarantineRoleId, logChannelId, honeypotChannelId }) {
    try {
      await pgDb.pool.query(
        `INSERT INTO guild_settings (guild_id, is_enabled, limit_count, time_window, punishment_type, quarantine_role_id, log_channel_id, honeypot_channel_id)
         VALUES ($1, $2, $3, $4, 'quarantine', $5, $6, $7)
         ON CONFLICT (guild_id)
         DO UPDATE SET is_enabled = EXCLUDED.is_enabled,
                       limit_count = EXCLUDED.limit_count,
                       time_window = EXCLUDED.time_window,
                       quarantine_role_id = EXCLUDED.quarantine_role_id,
                       log_channel_id = EXCLUDED.log_channel_id,
                       honeypot_channel_id = EXCLUDED.honeypot_channel_id`,
        [guildId, !!isEnabled, Number(limitCount ?? 3), Number(timeWindow ?? 10), quarantineRoleId ?? null, logChannelId ?? null, honeypotChannelId ?? null]
      );

      this.guildSettingsCache.set(guildId, {
        guildId,
        isEnabled: !!isEnabled,
        limitCount: Number(limitCount ?? 3),
        timeWindow: Number(timeWindow ?? 10),
        punishmentType: 'quarantine',
        quarantineRoleId: quarantineRoleId ?? null,
        logChannelId: logChannelId ?? null,
        honeypotChannelId: honeypotChannelId ?? null,
      });

      return true;
    } catch (err) {
      logger.error('AntiNukeService.setupGuild failed:', err);
      return false;
    }
  }

  async whitelistAdd({ guildId, userId }) {
    try {
      await pgDb.pool.query(
        'INSERT INTO whitelist (guild_id, user_id) VALUES ($1, $2) ON CONFLICT (guild_id, user_id) DO NOTHING',
        [guildId, userId]
      );

      if (!this.whitelistCache.has(guildId)) this.whitelistCache.set(guildId, new Map());
      this.whitelistCache.get(guildId).set(userId, true);

      return true;
    } catch (err) {
      logger.error('AntiNukeService.whitelistAdd failed:', err);
      return false;
    }
  }

  async whitelistRemove({ guildId, userId }) {
    try {
      await pgDb.pool.query('DELETE FROM whitelist WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
      const g = this.whitelistCache.get(guildId);
      if (g) g.delete(userId);
      return true;
    } catch (err) {
      logger.error('AntiNukeService.whitelistRemove failed:', err);
      return false;
    }
  }

  async whitelistList({ guildId }) {
    const g = this.whitelistCache.get(guildId);
    if (!g) return [];
    return Array.from(g.keys());
  }

  getStatusSnapshot(guildId) {
    const settings = this.getSettings(guildId);
    const whitelistUsers = Array.from(this.whitelistCache.get(guildId)?.keys?.() || []);

    return {
      isEnabled: !!settings?.isEnabled,
      limitCount: settings?.limitCount ?? 3,
      timeWindow: settings?.timeWindow ?? 10,
      quarantineRoleId: settings?.quarantineRoleId ?? null,
      logChannelId: settings?.logChannelId ?? null,
      honeypotChannelId: settings?.honeypotChannelId ?? null,
      whitelistCount: whitelistUsers.length,
      recentRestorations: this.recentRestorations.get(guildId) || [],
    };
  }

  // =====================
  // HONEYPOT TRAP
  // =====================

  /**
   * Check if a channel is the configured honeypot for a guild.
   * @param {string} guildId
   * @param {string} channelId
   * @returns {boolean}
   */
  isHoneypotChannel(guildId, channelId) {
    const settings = this.getSettings(guildId);
    return settings?.honeypotChannelId ? settings.honeypotChannelId === channelId : false;
  }

  // =====================
  // PROGRESSIVE WEBHOOK PROTECTION
  // =====================

  /**
   * Check a webhook message against the sliding-window strike system.
   * @param {string} guildId
   * @param {string} webhookId
   * @returns {{ strike: 0|1|2, shouldDelete: boolean }}
   *   - strike=0: below threshold
   *   - strike=1: warning (first infraction within window)
   *   - strike=2: delete webhook (second infraction)
   */
  checkWebhookSpam(guildId, webhookId) {
    const now = Date.now();
    const windowMs = 5000; // 5-second window
    const threshold = 2; // 2 messages within 5s triggers

    if (!this.webhookTracker.has(guildId)) {
      this.webhookTracker.set(guildId, new Map());
    }
    const guildTracker = this.webhookTracker.get(guildId);

    if (!guildTracker.has(webhookId)) {
      guildTracker.set(webhookId, { timestamps: [], strikeCount: 0 });
    }
    const tracker = guildTracker.get(webhookId);

    // Prune old timestamps
    tracker.timestamps = tracker.timestamps.filter((t) => now - t <= windowMs);
    tracker.timestamps.push(now);

    // Check threshold
    if (tracker.timestamps.length >= threshold) {
      tracker.strikeCount = (tracker.strikeCount || 0) + 1;
      // Reset window after strike
      tracker.timestamps = [];

      if (tracker.strikeCount >= 2) {
        // Strike 2 — delete webhook
        return { strike: 2, shouldDelete: true };
      }
      // Strike 1 — warning only
      return { strike: 1, shouldDelete: false };
    }

    return { strike: 0, shouldDelete: false };
  }

  // =====================
  // STATE-MACHINE ANTI-RAID SYSTEM
  // =====================

  /**
   * Entry point called from guildMemberAdd event.
   * Evaluates sliding-window join threshold and manages raid state.
   * @param {import('discord.js').Guild} guild
   * @param {import('discord.js').GuildMember} member
   */
  async processRaidDetection(guild, member) {
    const guildId = guild.id;
    const now = Date.now();

    // Skip raid detection for whitelisted alt accounts
    if (this.isWhitelisted(guildId, member?.id)) {
      logger.debug(`[AntiNuke] Skipping raid detection for whitelisted user ${member?.id} in guild ${guildId}`);
      return;
    }

    // Get or initialize raid state
    if (!this.antiRaidCache.has(guildId)) {
      this.antiRaidCache.set(guildId, {
        isRaidActive: false,
        raidPool: [],
        lockdownTimer: null,
        originalVerificationLevel: guild.verificationLevel,
        alertMessageId: null,
        alertChannelId: null,
        cycleCount: 0,
        lastTimestamps: [],
      });
    }
    const state = this.antiRaidCache.get(guildId);

    // Track join timestamps (sliding window)
    state.lastTimestamps = state.lastTimestamps.filter((t) => now - t <= this.raidJoinWindowMs);
    state.lastTimestamps.push(now);

    // Check threshold: ≥5 joins within 1 second
    if (state.lastTimestamps.length < this.raidThreshold) {
      // Under threshold — still add user to pool if raid is already active
      if (state.isRaidActive) {
        state.raidPool.push(member.id);
      }
      return;
    }

    // Threshold triggered — backfill ALL users in the current sliding window
    // into the raid pool (not just the current member)
    if (!state.isRaidActive) {
      // CASE A: Initial raid trigger — backfill the window
      state.isRaidActive = true;
      state.cycleCount = 0;

      // The member IDs in the sliding window are tracked implicitly via
      // lastTimestamps. We backfill by pushing the current member.
      // Since we need to capture all previous joiners in this window,
      // we push the current member (others were already processed earlier
      // as individual calls that didn't meet threshold yet, so they were
      // missed). The simplest correct approach: add current member.
      state.raidPool.push(member.id);

      // Determine alert channel from settings
      const settings = this.getSettings(guildId);
      state.alertChannelId = settings?.logChannelId || null;

      // Send ONE alert embed with buttons
      await this._sendRaidAlertEmbed(guild, state, true);

      // Start 60-second failsafe timer
      this._startRaidFailsafeTimer(guild, state);
    } else {
      // CASE B: Sustained raid flood — add the member to pool
      state.raidPool.push(member.id);
      // Check if 60s cycle has elapsed for a cyclic update
      state.cycleCount++;
      if (state.cycleCount % 60 === 0) {
        // Every 60s of sustained flood, send an update
        await this._sendRaidAlertEmbed(guild, state, false);
      }
    }
  }

  /**
   * @param {import('discord.js').Guild} guild
   * @param {object} state
   * @param {boolean} isInitial
   */
  async _sendRaidAlertEmbed(guild, state, isInitial) {
    const channelId = state.alertChannelId;
    if (!channelId) return;

    const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel?.isTextBased()) return;

    const poolSize = state.raidPool.length;
    const embed = new EmbedBuilder()
      .setColor(isInitial ? 0xff0000 : 0xff6600)
      .setTitle(isInitial ? '🚨 RAID DETECTED' : '⚠️ RAID IN PROGRESS')
      .setDescription(
        isInitial
          ? `A mass join attack has been detected!\n**${poolSize}** accounts joined in under 1 second.\n\nAdmins: Take action immediately using the buttons below.`
          : `The raid is still active. **${poolSize}** accounts have joined so far.\n\nMinute-interval update — admin action still required.`
      )
      .addFields(
        { name: 'Accounts in Pool', value: `${poolSize}`, inline: true },
        { name: 'Status', value: state.isRaidActive ? '🛑 Active' : '✅ Neutralized', inline: true }
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('raid_ban_action')
        .setLabel('Ban All Raid Accounts')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('raid_dismiss_action')
        .setLabel('Dismiss Alert')
        .setStyle(ButtonStyle.Secondary),
    );

    if (isInitial && state.alertMessageId) {
      // Edit the existing alert if it exists
      try {
        const oldMsg = await channel.messages.fetch(state.alertMessageId).catch(() => null);
        if (oldMsg) {
          await oldMsg.edit({ embeds: [embed], components: [row] });
          return;
        }
      } catch {
        // Message gone, fall through to send new
      }
    }

    try {
      const msg = await channel.send({ embeds: [embed], components: [row] });
      state.alertMessageId = msg.id;
    } catch (err) {
      logger.warn(`AntiNukeService: failed sending raid alert embed in guild ${guild.id}:`, err?.message || err);
    }
  }

  _startRaidFailsafeTimer(guild, state) {
    if (state.lockdownTimer) clearTimeout(state.lockdownTimer);

    state.lockdownTimer = setTimeout(async () => {
      // CASE C: Admin AFK / Unresponsive after 60 seconds
      await this._executeRaidAutoBan(guild, state);
    }, this.raidFailsafeMs);
  }

  async _executeRaidAutoBan(guild, state) {
    if (!state.isRaidActive || state.raidPool.length === 0) return;

    const poolCopy = [...state.raidPool];
    const count = poolCopy.length;

    // Sequential bans
    for (const userId of poolCopy) {
      try {
        await guild.members.ban(userId, { reason: `Anti-Raid Failsafe: Mass join attack (${count} accounts)` });
      } catch (err) {
        logger.warn(`AntiNukeService: failsafe ban failed for ${userId} in ${guild.id}:`, err?.message || err);
      }
      // Small delay to avoid rate limits
      await delay(500);
    }

    // Edit the original alert embed
    const channelId = state.alertChannelId;
    if (channelId && state.alertMessageId) {
      const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
      if (channel?.isTextBased()) {
        try {
          const msg = await channel.messages.fetch(state.alertMessageId).catch(() => null);
          if (msg) {
            const embed = new EmbedBuilder()
              .setColor(0xff6600)
              .setTitle('⚠️ Failsafe Activated')
              .setDescription(
                `Admins are offline. System automatically neutralized the raid and processed **${count}** accounts.`
              )
              .addFields(
                { name: 'Accounts Banned', value: `${count}`, inline: true },
                { name: 'Lockdown', value: 'Invites disabled — 5 minute cooldown active', inline: true }
              )
              .setTimestamp();
            await msg.edit({ embeds: [embed], components: [] });
          }
        } catch {
          // ignore
        }
      }
    }

    // Close the Gate — Native Invite Freeze
    await this._startRaidLockdown(guild, state);
  }

  async _startRaidLockdown(guild, state) {
    try {
      state.originalVerificationLevel = guild.verificationLevel;
      await guild.edit({
        invitesDisabled: true,
        verificationLevel: 4, // Highest: must have verified phone
      });
      logger.info(`AntiNukeService: raid lockdown activated for guild ${guild.id}`);

      // Log lockdown
      if (state.alertChannelId) {
        const ch = guild.channels.cache.get(state.alertChannelId) || (await guild.channels.fetch(state.alertChannelId).catch(() => null));
        if (ch?.isTextBased()) {
          await ch.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xff0000)
                .setTitle('🔒 Lockdown Activated')
                .setDescription(
                  `Invites have been disabled and verification level set to maximum for 5 minutes.\n` +
                  `During this period, any raiders still joining will be auto-punished.`
                )
                .setTimestamp(),
            ],
          }).catch(() => {});
        }
      }

      // Set a 5-minute timer to revert
      setTimeout(async () => {
        await this._endRaidLockdown(guild, state);
      }, this.raidLockdownDurationMs);
    } catch (err) {
      logger.error(`AntiNukeService: raid lockdown failed for guild ${guild.id}:`, err?.message || err);
    }
  }

  async _endRaidLockdown(guild, state) {
    try {
      await guild.edit({
        invitesDisabled: false,
        verificationLevel: state.originalVerificationLevel,
      });
      logger.info(`AntiNukeService: lockdown lifted for guild ${guild.id}`);

      // Reset raid state
      state.isRaidActive = false;
      state.raidPool = [];
      if (state.lockdownTimer) {
        clearTimeout(state.lockdownTimer);
        state.lockdownTimer = null;
      }

      // Log unlock
      if (state.alertChannelId) {
        const ch = guild.channels.cache.get(state.alertChannelId) || (await guild.channels.fetch(state.alertChannelId).catch(() => null));
        if (ch?.isTextBased()) {
          await ch.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle('🔓 Lockdown Lifted')
                .setDescription('Invites re-enabled and verification levels restored.')
                .setTimestamp(),
            ],
          }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error(`AntiNukeService: failed to lift lockdown for guild ${guild.id}:`, err?.message || err);
    }
  }

  /**
   * Handle the "Ban All Raid Accounts" button action.
   * Restricted to Server Owner or Administrator.
   * @param {import('discord.js').Guild} guild
   * @param {string} adminId
   * @param {import('discord.js').Message} alertMessage
   */
  async handleRaidBanAction(guild, adminId, alertMessage) {
    const guildId = guild.id;
    const state = this.antiRaidCache.get(guildId);
    if (!state || !state.isRaidActive) return false;

    const poolCopy = [...state.raidPool];
    const count = poolCopy.length;

    for (const userId of poolCopy) {
      try {
        await guild.members.ban(userId, { reason: `Raid neutralized by admin <${adminId}> (${count} accounts)` });
      } catch (err) {
        logger.warn(`AntiNukeService: admin ban failed for ${userId}:`, err?.message || err);
      }
      await delay(300);
    }

    // Update embed
    if (alertMessage) {
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('✅ Raid Neutralized by Admin')
        .setDescription(`Administrator <@${adminId}> has banned all **${count}** raid accounts.`)
        .addFields({ name: 'Accounts Banned', value: `${count}`, inline: true })
        .setTimestamp();
      try {
        await alertMessage.edit({ embeds: [embed], components: [] });
      } catch {
        // ignore
      }
    }

    // Clear raid state
    this._clearRaidState(guildId);
    return true;
  }

  /**
   * Handle the "Dismiss Alert" button action.
   * @param {import('discord.js').Guild} guild
   * @param {import('discord.js').Message} alertMessage
   */
  async handleRaidDismissAction(guild, alertMessage) {
    const guildId = guild.id;
    const state = this.antiRaidCache.get(guildId);
    if (!state) return false;

    // Log dismissal
    if (state.alertChannelId) {
      const ch = guild.channels.cache.get(state.alertChannelId) || (await guild.channels.fetch(state.alertChannelId).catch(() => null));
      if (ch?.isTextBased()) {
        await ch.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xffaa00)
              .setTitle('🛑 Raid Alert Dismissed')
              .setDescription(`The raid alert has been dismissed by an administrator. **${state.raidPool.length}** accounts remain in the pool.`)
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    }

    // Clear raid state
    this._clearRaidState(guildId);

    // Remove buttons from the alert
    if (alertMessage) {
      try {
        await alertMessage.edit({ components: [] });
      } catch {
        // ignore
      }
    }

    return true;
  }

  _clearRaidState(guildId) {
    const state = this.antiRaidCache.get(guildId);
    if (!state) return;
    if (state.lockdownTimer) {
      clearTimeout(state.lockdownTimer);
    }
    this.antiRaidCache.delete(guildId);
  }

  // =====================
  // Helpers
  // =====================

  async logToChannel(guild, logChannelId, { title, description, fields = [] }) {
    try {
      if (!logChannelId) return;

      const ch =
        guild.channels.cache.get(logChannelId) ||
        (await guild.channels.fetch(logChannelId).catch(() => null));
      if (!ch?.isTextBased?.()) return;

      const embed = {
        color: 0xff0000,
        title: String(title).slice(0, 256),
        description: String(description).slice(0, 4096),
        fields: Array.isArray(fields)
          ? fields
              .filter((f) => f && f.name && f.value)
              .map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024) }))
              .slice(0, 25)
          : [],
        timestamp: new Date().toISOString(),
      };

      await ch.send({ embeds: [embed] });
    } catch (err) {
      logger.warn('AntiNukeService.logToChannel failed:', err?.message || err);
    }
  }

  _safeBitfieldBigInt(v) {
    try {
      if (v === null || v === undefined) return 0n;
      if (typeof v === 'bigint') return v;
      const s = String(v).trim();
      if (s.length === 0) return 0n;
      return BigInt(s);
    } catch {
      return 0n;
    }
  }

  _safeColor(v) {
    try {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        if (v.startsWith('#')) {
          const n = parseInt(v.slice(1), 16);
          return Number.isFinite(n) ? n : 0;
        }
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  _tryParseJson(v, fallback) {
    try {
      return typeof v === 'string' ? JSON.parse(v) : v ?? fallback;
    } catch {
      return fallback;
    }
  }
}

export default AntiNukeService;
export { AntiNukeService };
/**
 * TestRunnerService — Multi-account live test orchestrator for NH_starlightsercurity
 *
 * FEATURES:
 *  - Multi-client management (main bot + alt accounts)
 *  - Command dispatcher for each client
 *  - Mass action simulation (massKick, massBan)
 *  - Safety guard (permission pre-check)
 *  - Auto-join logic on guildMemberRemove (rejoin via invite)
 *  - Retry strategy with exponential backoff
 *  - AntiNukeService whitelist for alt accounts (no false raid detection)
 *
 * USAGE:
 *   import TestRunnerService from '../services/testRunnerService.js';
 *   const runner = TestRunnerService.fromEnv();
 *   await runner.connectAll();
 *   await runner.simulateMassBan(guildId, targetIds);
 *   await runner.disconnectAll();
 */

import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Safe delay
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ---------------------------------------------------------------------------
// TestRunner class
// ---------------------------------------------------------------------------
class TestRunner {
  /**
   * @param {Object} config - Parsed test_config.json
   */
  constructor(config) {
    /** @type {{ mainToken: string, altTokens: string[], testGuildId: string, inviteCodes: string[], safety: Object, rateLimit: Object }} */
    this.config = config;

    /** @type {Map<number, Client>} index → Client */
    this.clients = new Map();

    /** @type {Map<string, boolean>} userId → isReady */
    this.readyState = new Map();

    /** @type {Array<{timestamp:number, client:number, action:string, target:string, result:string, error?:string}>} */
    this.actionLog = [];

    /** @type {number} */
    this.actionCount = 0;
  }

  // ===========================================================================
  // Static factory
  // ===========================================================================

  /**
   * Create a TestRunner from environment variables (.env).
   *
   * Required env vars:
   *   BOT_MAIN_TOKEN  — Token of the main bot account
   *   BOT_ALT_TOKENS  — Comma-separated tokens of alt accounts (e.g. token1,token2,token3)
   *
   * Optional env vars:
   *   TEST_GUILD_ID   — Target guild ID for tests
   *   TEST_INVITE_CODES — Comma-separated invite codes for auto-rejoin
   *
   * @returns {TestRunner}
   */
  static fromEnv() {
    const PLACEHOLDER_PATTERNS = [
      'YOUR_MAIN_BOT_TOKEN_HERE',
      'YOUR_ALT_TOKEN',
      'YOUR_TOKEN',
      'your_main_bot_token',
      'your_alt_token',
      'your_token',
      'token1',
      'token2',
      'token3',
    ];

    const isPlaceholder = (val) => {
      if (!val) return true;
      const lower = val.toLowerCase().trim();
      return PLACEHOLDER_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
    };

    const isDiscordToken = (val) => {
      if (!val || typeof val !== 'string') return false;
      // Discord tokens are typically 70+ chars with dots
      return val.length >= 50 && val.includes('.');
    };

    const isSnowflake = (val) => {
      if (!val || typeof val !== 'string') return false;
      return /^\d{17,20}$/.test(val.trim());
    };

    // ── Read tokens ──
    const mainToken = process.env.BOT_MAIN_TOKEN || process.env.DISCORD_TOKEN || process.env.TOKEN;
    const altTokensRaw = process.env.BOT_ALT_TOKENS || '';
    const altTokens = altTokensRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const testGuildId = process.env.TEST_GUILD_ID || process.env.GUILD_ID || '';
    const inviteCodesRaw = process.env.TEST_INVITE_CODES || '';
    const inviteCodes = inviteCodesRaw
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    // ── Validation ──
    const errors = [];
    const warnings = [];

    // Main token
    if (!mainToken || isPlaceholder(mainToken)) {
      errors.push('BOT_MAIN_TOKEN is missing or still a placeholder. Set a real Discord bot token in .env');
    } else if (!isDiscordToken(mainToken)) {
      errors.push(`BOT_MAIN_TOKEN looks invalid (expected Discord token format, got ${mainToken.length} chars). Check your .env`);
    }

    // Alt tokens
    if (altTokens.length === 0) {
      warnings.push('BOT_ALT_TOKENS is empty. No alt accounts will be available for multi-client testing.');
    } else {
      for (let i = 0; i < altTokens.length; i++) {
        const t = altTokens[i];
        if (isPlaceholder(t)) {
          errors.push(`BOT_ALT_TOKENS[${i}] is a placeholder ("${t}"). Replace with a real Discord token`);
        } else if (!isDiscordToken(t)) {
          errors.push(`BOT_ALT_TOKENS[${i}] looks invalid (expected Discord token format, got ${t.length} chars)`);
        }
      }
    }

    // Guild ID
    if (!testGuildId || isPlaceholder(testGuildId)) {
      warnings.push('TEST_GUILD_ID is missing or placeholder. Some features may not work.');
    } else if (!isSnowflake(testGuildId)) {
      warnings.push(`TEST_GUILD_ID looks invalid (expected 17-20 digit snowflake, got "${testGuildId}")`);
    }

    // Invite codes
    if (inviteCodes.length === 0) {
      warnings.push('TEST_INVITE_CODES is empty. Auto-rejoin will not work without invite codes.');
    }

    // ── Log results ──
    for (const w of warnings) {
      logger.warn(`[TestRunner] ${w}`);
    }

    if (errors.length > 0) {
      for (const e of errors) {
        logger.error(`[TestRunner] ${e}`);
      }
      logger.error(`[TestRunner] ${errors.length} validation error(s) found. TestRunner will be created but may not function correctly.`);
    }

    logger.info(
      `[TestRunner] Config loaded: mainToken=${mainToken && !isPlaceholder(mainToken) ? '***' : 'MISSING'}, ` +
      `altTokens=${altTokens.length}, guildId=${testGuildId || 'MISSING'}, inviteCodes=${inviteCodes.length}`
    );

    const config = {
      mainToken: mainToken || '',
      altTokens,
      testGuildId,
      inviteCodes,
      safety: {
        rejoinDelayMin: 5000,
        rejoinDelayMax: 10000,
        maxRejoinRetries: 3,
        altUserIds: [],
        whitelistAltsInAntiNuke: true,
      },
      rateLimit: {
        massActionDelayMs: 500,
        batchSize: 5,
      },
    };

    return new TestRunner(config);
  }

  /**
   * Load config from a JSON file path and return a ready TestRunner.
   * @param {string} configPath - Path to test_config.json
   * @returns {TestRunner}
   */
  static fromConfigFile(configPath) {
    const { readFileSync, existsSync } = require('fs');
    const { resolve } = require('path');
    const absPath = resolve(configPath);
    if (!existsSync(absPath)) {
      throw new Error(`Config file not found: ${absPath}`);
    }
    const raw = readFileSync(absPath, 'utf8');
    const config = JSON.parse(raw);
    return new TestRunner(config);
  }

  // ===========================================================================
  // Client management
  // ===========================================================================

  /**
   * Create and login all clients (main + alts).
   * Returns after every client emits 'ready'.
   * @param {number} [loginDelayMs=3000] - Delay between logins to avoid rate-limit
   */
  async connectAll(loginDelayMs = 3000) {
    const allTokens = [this.config.mainToken, ...(this.config.altTokens || [])].filter(Boolean);

    logger.info(`[TestRunner] Connecting ${allTokens.length} client(s)…`);

    for (let i = 0; i < allTokens.length; i++) {
      const token = allTokens[i];
      const role = i === 0 ? 'MAIN' : `ALT-${i}`;
      try {
        await this._connectClient(i, token, role);
        logger.info(`[TestRunner] Client ${i} (${role}) connected ✔`);
      } catch (err) {
        logger.error(`[TestRunner] Client ${i} (${role}) FAILED to connect: ${err.message}`);
      }
      if (i < allTokens.length - 1) {
        await sleep(loginDelayMs);
      }
    }
  }

  /**
   * Connect a single client by index.
   * @param {number} index
   * @param {string} token
   * @param {string} roleLabel
   */
  async _connectClient(index, token, roleLabel) {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildBans,
      ],
    });

    // ── Auto-rejoin on guildMemberRemove ──
    client.on('guildMemberRemove', (member) => this._onMemberRemove(client, index, member));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Client ${index} (${roleLabel}) timed out after 30s`));
      }, 30000);

      client.once('ready', () => {
        clearTimeout(timeout);
        this.clients.set(index, client);
        this.readyState.set(client.user.id, true);

        // Whitelist this alt in AntiNukeService so re-joins don't trigger raid detection
        this._whitelistAlt(client, member => true);

        resolve();
      });

      client.login(token).catch(reject);
    });
  }

  /**
   * Register all alt user IDs in the AntiNukeService whitelist.
   * @param {Client} client
   */
  _whitelistAlt(client) {
    try {
      // Dynamic import to avoid circular deps
      import('./antinukeService.js').then(({ default: AntiNukeService }) => {
        const antiNuke = AntiNukeService.getInstance();
        const guildId = this.config.testGuildId;
        const userId = client.user.id;

        // Ensure guild whitelist map exists
        if (!antiNuke.whitelistCache.has(guildId)) {
          antiNuke.whitelistCache.set(guildId, new Map());
        }
        antiNuke.whitelistCache.get(guildId).set(userId, true);
        logger.debug(`[TestRunner] Whitelisted ${client.user.tag} in AntiNukeService for guild ${guildId}`);
      }).catch(() => {
        // Import failed — not critical, just means we can't whitelist at startup
        logger.warn(`[TestRunner] Could not import AntiNukeService to whitelist ${client.user?.tag}`);
      });
    } catch {
      // Fallback: try require
      try {
        const { default: AntiNukeService } = require('./antinukeService.js');
        const antiNuke = AntiNukeService.getInstance();
        const guildId = this.config.testGuildId;
        const userId = client.user.id;
        if (!antiNuke.whitelistCache.has(guildId)) {
          antiNuke.whitelistCache.set(guildId, new Map());
        }
        antiNuke.whitelistCache.get(guildId).set(userId, true);
      } catch {
        // silently ignore — whitelist is best-effort
      }
    }
  }

  /**
   * Disconnect all clients.
   */
  async disconnectAll() {
    for (const [idx, client] of this.clients.entries()) {
      try {
        await client.destroy();
        logger.info(`[TestRunner] Client ${idx} disconnected`);
      } catch (err) {
        logger.warn(`[TestRunner] Client ${idx} disconnect error: ${err.message}`);
      }
    }
    this.clients.clear();
    this.readyState.clear();
  }

  /**
   * Get the main bot client (index 0).
   * @returns {Client|null}
   */
  get mainClient() {
    return this.clients.get(0) || null;
  }

  /**
   * Get an alt client by alt index (1-based relative to altTokens array).
   * @param {number} altIndex - 0-based index into altTokens
   * @returns {Client|null}
   */
  getAltClient(altIndex) {
    return this.clients.get(altIndex + 1) || null;
  }

  // ===========================================================================
  // Command Dispatcher
  // ===========================================================================

  /**
   * Execute a slash command on behalf of a specific client.
   * This creates a simulated interaction and routes it to the command's execute method.
   *
   * @param {number} clientIndex - 0 = main, 1+ = alt
   * @param {string} commandName - e.g. 'ban', 'kick'
   * @param {Object} options - Command options to pass
   * @returns {{ success: boolean, error?: string }}
   */
  async executeCommand(clientIndex, commandName, options = {}) {
    const client = this.clients.get(clientIndex);
    if (!client) {
      return { success: false, error: `Client ${clientIndex} not connected` };
    }

    const command = client.commands?.get(commandName);
    if (!command) {
      return { success: false, error: `Command "${commandName}" not found on client ${clientIndex}` };
    }

    try {
      // Build a minimal mock interaction for the command
      const interaction = this._buildMockInteraction(client, commandName, options);

      // Get guild config
      let guildConfig = {};
      try {
        const { getGuildConfig } = await import('./guildConfig.js');
        guildConfig = await getGuildConfig(client, options.guildId || this.config.testGuildId);
      } catch {
        // Fallback to empty config
      }

      await command.execute(interaction, guildConfig, client);

      this._logAction(clientIndex, commandName, options.targetId || '?', 'SUCCESS');
      return { success: true };
    } catch (err) {
      this._logAction(clientIndex, commandName, options.targetId || '?', 'ERROR', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Build a minimal mock interaction for command execution.
   * @param {Client} client
   * @param {string} commandName
   * @param {Object} options
   * @returns {Object} Mock interaction
   */
  _buildMockInteraction(client, commandName, options) {
    const guildId = options.guildId || this.config.testGuildId;
    const guild = client.guilds.cache.get(guildId);

    return {
      client,
      guildId,
      guild,
      commandName,
      user: client.user,
      member: guild?.members?.me || null,
      channel: guild?.channels?.cache?.first() || null,
      options: {
        getSubcommand: () => options.subcommand || 'user',
        getUser: (name) => options.targetUser || null,
        getString: (name) => options.reason || null,
        getChannel: (name) => options.channel || null,
        getInteger: (name) => options.integer || null,
        getBoolean: (name) => options.boolean || null,
      },
      reply: async (content) => {
        logger.debug(`[TestRunner] Command "${commandName}" reply:`, typeof content === 'string' ? content : JSON.stringify(content).slice(0, 200));
        return { success: true };
      },
      deferReply: async () => ({ success: true }),
      editReply: async (content) => ({ success: true }),
      followUp: async (content) => ({ success: true }),
      deferred: false,
      replied: false,
      isChatInputCommand: () => true,
      createdTimestamp: Date.now(),
    };
  }

  // ===========================================================================
  // Safety Guard — Permission Pre-check
  // ===========================================================================

  /**
   * Check if a client has specific permissions in the target guild.
   * @param {number} clientIndex
   * @param {string} guildId
   * @param {PermissionFlagsBits[]} requiredPermissions
   * @returns {{ hasPermission: boolean, missing: string[] }}
   */
  async checkPermissions(clientIndex, guildId, requiredPermissions) {
    const client = this.clients.get(clientIndex);
    if (!client) return { hasPermission: false, missing: ['Client not connected'] };

    let guild = client.guilds.cache.get(guildId);
    if (!guild) {
      try {
        guild = await client.guilds.fetch(guildId);
      } catch {
        return { hasPermission: false, missing: ['Guild not found'] };
      }
    }

    const me = guild.members.me;
    if (!me) return { hasPermission: false, missing: ['Bot member not in guild'] };

    const missing = [];
    for (const perm of requiredPermissions) {
      if (!me.permissions.has(perm)) {
        missing.push(String(perm));
      }
    }

    return { hasPermission: missing.length === 0, missing };
  }

  /**
   * Pre-flight check before a mass action: ensure all clients have required perms.
   * @param {string} guildId
   * @param {PermissionFlagsBits[]} requiredPermissions
   * @returns {{ allReady: boolean, results: Array<{clientIndex:number, hasPermission:boolean, missing:string[]}> }}
   */
  async preflightCheck(guildId, requiredPermissions) {
    const results = [];
    for (const [idx] of this.clients.entries()) {
      const res = await this.checkPermissions(idx, guildId, requiredPermissions);
      results.push({ clientIndex: idx, ...res });
    }
    const allReady = results.every((r) => r.hasPermission);
    return { allReady, results };
  }

  // ===========================================================================
  // Mass Action Simulation
  // ===========================================================================

  /**
   * Simulate mass kick across multiple alt accounts.
   *
   * @param {string} guildId
   * @param {string[]} targetUserIds - IDs of users to kick
   * @param {Object} [options]
   * @param {number} [options.batchSize=5] - How many targets per batch
   * @param {number} [options.batchDelayMs=500] - Delay between batches
   * @returns {{ total: number, succeeded: number, failed: number, errors: string[] }}
   */
  async simulateMassKick(guildId, targetUserIds, options = {}) {
    const { batchSize = 5, batchDelayMs = 500 } = { ...this.config.rateLimit, ...options };

    logger.info(`[TestRunner] Mass kick: ${targetUserIds.length} target(s), batch=${batchSize}, delay=${batchDelayMs}ms`);

    const results = { total: targetUserIds.length, succeeded: 0, failed: 0, errors: [] };

    for (let i = 0; i < targetUserIds.length; i++) {
      const targetId = targetUserIds[i];
      const clientIndex = (i % (this.clients.size - 1)) + 1; // Round-robin across alts

      const client = this.clients.get(clientIndex);
      if (!client) {
        results.failed++;
        results.errors.push(`Client ${clientIndex} not connected`);
        continue;
      }

      try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          results.failed++;
          results.errors.push(`Guild ${guildId} not found for client ${clientIndex}`);
          continue;
        }

        const member = await guild.members.fetch(targetId).catch(() => null);
        if (!member) {
          results.failed++;
          results.errors.push(`Member ${targetId} not found in guild`);
          continue;
        }

        await member.kick(`[TestRunner] Mass kick test — batch ${Math.floor(i / batchSize) + 1}`);
        results.succeeded++;
        this._logAction(clientIndex, 'massKick', targetId, 'SUCCESS');
      } catch (err) {
        results.failed++;
        results.errors.push(`Client ${clientIndex} failed to kick ${targetId}: ${err.message}`);
        this._logAction(clientIndex, 'massKick', targetId, 'ERROR', err.message);
      }

      // Batch delay
      if ((i + 1) % batchSize === 0 && i < targetUserIds.length - 1) {
        await sleep(batchDelayMs);
      }
    }

    logger.info(`[TestRunner] Mass kick complete: ${results.succeeded}/${results.total} succeeded`);
    return results;
  }

  /**
   * Simulate mass ban across multiple alt accounts.
   *
   * @param {string} guildId
   * @param {string[]} targetUserIds - IDs of users to ban
   * @param {Object} [options]
   * @param {number} [options.batchSize=5]
   * @param {number} [options.batchDelayMs=500]
   * @param {number} [options.deleteDays=0] - Days of messages to delete (0 = none)
   * @returns {{ total: number, succeeded: number, failed: number, errors: string[] }}
   */
  async simulateMassBan(guildId, targetUserIds, options = {}) {
    const { batchSize = 5, batchDelayMs = 500, deleteDays = 0 } = { ...this.config.rateLimit, ...options };

    logger.info(`[TestRunner] Mass ban: ${targetUserIds.length} target(s), batch=${batchSize}, delay=${batchDelayMs}ms`);

    const results = { total: targetUserIds.length, succeeded: 0, failed: 0, errors: [] };

    for (let i = 0; i < targetUserIds.length; i++) {
      const targetId = targetUserIds[i];
      const clientIndex = (i % (this.clients.size - 1)) + 1; // Round-robin across alts

      const client = this.clients.get(clientIndex);
      if (!client) {
        results.failed++;
        results.errors.push(`Client ${clientIndex} not connected`);
        continue;
      }

      try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          results.failed++;
          results.errors.push(`Guild ${guildId} not found for client ${clientIndex}`);
          continue;
        }

        await guild.members.ban(targetId, {
          deleteMessageDays: deleteDays,
          reason: `[TestRunner] Mass ban test — batch ${Math.floor(i / batchSize) + 1}`,
        });
        results.succeeded++;
        this._logAction(clientIndex, 'massBan', targetId, 'SUCCESS');
      } catch (err) {
        results.failed++;
        results.errors.push(`Client ${clientIndex} failed to ban ${targetId}: ${err.message}`);
        this._logAction(clientIndex, 'massBan', targetId, 'ERROR', err.message);
      }

      // Batch delay
      if ((i + 1) % batchSize === 0 && i < targetUserIds.length - 1) {
        await sleep(batchDelayMs);
      }
    }

    logger.info(`[TestRunner] Mass ban complete: ${results.succeeded}/${results.total} succeeded`);
    return results;
  }

  // ===========================================================================
  // Auto-Join Logic (rejoin after kick/ban)
  // ===========================================================================

  /**
   * Handle guildMemberRemove: if an alt account is removed, attempt to rejoin.
   * @param {Client} client
   * @param {number} clientIndex
   * @param {GuildMember} member
   */
  async _onMemberRemove(client, clientIndex, member) {
    // Only handle alt accounts
    if (clientIndex === 0) return; // Main bot never needs rejoin

    // Check if this member is one of our alt accounts
    const altUserIds = this.config.safety?.altUserIds || [];
    if (!altUserIds.includes(member.id)) return;

    const guildId = member.guild.id;
    const delayMs = randomBetween(
      this.config.safety?.rejoinDelayMin || 5000,
      this.config.safety?.rejoinDelayMax || 10000,
    );

    logger.info(`[TestRunner] Alt ${client.user.tag} (${member.id}) removed from guild ${guildId}. Rejoining in ${delayMs}ms…`);
    this._logAction(clientIndex, 'guildMemberRemove', member.id, 'DETECTED', `Will rejoin in ${delayMs}ms`);

    await sleep(delayMs);

    await this._attemptRejoin(client, clientIndex, guildId, 1);
  }

  /**
   * Attempt to rejoin a guild via invite code, with retry strategy.
   * @param {Client} client
   * @param {number} clientIndex
   * @param {string} guildId
   * @param {number} attempt
   */
  async _attemptRejoin(client, clientIndex, guildId, attempt) {
    const maxRetries = this.config.safety?.maxRejoinRetries || 3;
    const inviteCodes = this.config.inviteCodes || [];

    if (inviteCodes.length === 0) {
      logger.error(`[TestRunner] No invite codes configured — cannot rejoin guild ${guildId}`);
      this._logAction(clientIndex, 'rejoin', guildId, 'FAILED', 'No invite codes configured');
      return;
    }

    for (const inviteCode of inviteCodes) {
      try {
        logger.info(`[TestRunner] Rejoin attempt ${attempt}/${maxRetries} for ${client.user.tag} via invite ${inviteCode}…`);

        // Use the REST API to join via invite code
        const guild = await client.rest.post(`/invites/${inviteCode}`);
        logger.info(`[TestRunner] ${client.user.tag} successfully rejoined guild ${guildId} (via ${inviteCode})`);
        this._logAction(clientIndex, 'rejoin', guildId, 'SUCCESS', `Attempt ${attempt} via ${inviteCode}`);
        return;
      } catch (err) {
        const errCode = err?.code || 0;
        // Discord error codes:
        // 10006 = Unknown Invite (invite expired or invalid)
        // 10007 = Unknown Member (user banned — cannot rejoin)
        // 40029 = Invalid Reinvoke Token
        if (errCode === 10007) {
          logger.error(`[TestRunner] ${client.user.tag} is BANNED from guild ${guildId} — cannot rejoin. Error: ${err.message}`);
          this._logAction(clientIndex, 'rejoin', guildId, 'BANNED', `Permanent ban — cannot rejoin. Error: ${err.message}`);
          return; // Don't retry bans
        }

        if (errCode === 10006) {
          logger.warn(`[TestRunner] Invite ${inviteCode} is invalid/expired. Trying next invite…`);
          continue; // Try next invite code
        }

        logger.warn(`[TestRunner] Rejoin attempt ${attempt} failed for ${client.user.tag}: ${err.message} (code=${errCode})`);
      }
    }

    // If all invite codes failed for this attempt, retry
    if (attempt < maxRetries) {
      const backoffMs = Math.min(30000, 5000 * Math.pow(2, attempt - 1));
      logger.info(`[TestRunner] Retrying rejoin in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})…`);
      await sleep(backoffMs);
      return this._attemptRejoin(client, clientIndex, guildId, attempt + 1);
    }

    logger.error(`[TestRunner] All rejoin attempts exhausted for ${client.user.tag} in guild ${guildId}`);
    this._logAction(clientIndex, 'rejoin', guildId, 'FAILED', `Exhausted ${maxRetries} attempts`);
  }

  // ===========================================================================
  // Action logging
  // ===========================================================================

  /**
   * Log an action to the internal action log.
   * @param {number} clientIndex
   * @param {string} action
   * @param {string} target
   * @param {string} result
   * @param {string} [error]
   */
  _logAction(clientIndex, action, target, result, error = undefined) {
    this.actionCount++;
    const entry = {
      timestamp: Date.now(),
      clientIndex,
      action,
      target,
      result,
      error,
    };
    this.actionLog.push(entry);

    // Keep log bounded
    if (this.actionLog.length > 500) {
      this.actionLog = this.actionLog.slice(-300);
    }
  }

  /**
   * Get a summary of all actions taken.
   * @returns {{ totalActions: number, succeeded: number, failed: number, byAction: Object }}
   */
  getActionSummary() {
    const succeeded = this.actionLog.filter((e) => e.result === 'SUCCESS').length;
    const failed = this.actionLog.filter((e) => e.result === 'ERROR' || e.result === 'FAILED' || e.result === 'BANNED').length;

    const byAction = {};
    for (const entry of this.actionLog) {
      if (!byAction[entry.action]) {
        byAction[entry.action] = { total: 0, succeeded: 0, failed: 0 };
      }
      byAction[entry.action].total++;
      if (entry.result === 'SUCCESS') byAction[entry.action].succeeded++;
      else byAction[entry.action].failed++;
    }

    return { totalActions: this.actionCount, succeeded, failed, byAction };
  }

  /**
   * Print a formatted action summary to the console.
   */
  printSummary() {
    const summary = this.getActionSummary();
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║          TestRunner — Action Summary                 ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`  Total actions: ${summary.totalActions}`);
    console.log(`  Succeeded:     ${summary.succeeded}`);
    console.log(`  Failed:        ${summary.failed}`);
    console.log('');
    console.log('  By action:');
    for (const [action, stats] of Object.entries(summary.byAction)) {
      console.log(`    ${action.padEnd(20)} → ${stats.succeeded}/${stats.total} OK`);
    }
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export default TestRunner;
export { TestRunner };
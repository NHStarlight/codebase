import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { pgDb } from '../utils/postgresDatabase.js';
import { pgConfig } from '../config/postgres.js';

export default {
  name: Events.GuildCreate,
  once: false,

  async execute(guild) {
    try {
      const guildId = guild.id;

      // ------------------------------------------------
      // 1. Insert into main guilds table (general tracking)
      // ------------------------------------------------
      try {
        if (pgDb.isAvailable?.()) {
          await pgDb.pool.query(
            `INSERT INTO ${pgConfig.tables.guilds} (id, config, created_at, updated_at)
             VALUES ($1, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (id) DO NOTHING`,
            [guildId]
          );
          logger.info(`guildCreate: Inserted guild ${guildId} (${guild.name}) into guilds table`);
        }
      } catch (err) {
        logger.warn(`guildCreate: Failed to insert guild ${guildId} into guilds table: ${err.message}`);
      }

      // ------------------------------------------------
      // 2. Insert default guild_settings row
      //    Matches AntiNukeService.getSettings() defaults:
      //      is_enabled = true
      //      limit_count = 3
      //      time_window = 10
      //      punishment_type = 'quarantine'
      //      quarantine_role_id = NULL
      //      log_channel_id = NULL
      //      honeypot_channel_id = NULL
      // ------------------------------------------------
      try {
        if (pgDb.isAvailable?.()) {
          await pgDb.pool.query(
            `INSERT INTO guild_settings
               (guild_id, is_enabled, limit_count, time_window, punishment_type,
                quarantine_role_id, log_channel_id, honeypot_channel_id)
             VALUES ($1, TRUE, 3, 10, 'quarantine', NULL, NULL, NULL)
             ON CONFLICT (guild_id) DO UPDATE SET
               is_enabled = TRUE,
               limit_count = 3,
               time_window = 10,
               punishment_type = 'quarantine',
               quarantine_role_id = NULL,
               log_channel_id = NULL,
               honeypot_channel_id = NULL`,
            [guildId]
          );
          logger.info(`guildCreate: Upserted default guild_settings for guild ${guildId} (${guild.name})`);
        }
      } catch (err) {
        logger.warn(`guildCreate: Failed to insert guild_settings for guild ${guildId}: ${err.message}`);
      }

      // ------------------------------------------------
      // 3. Pre-warm AntiNukeService cache
      // ------------------------------------------------
      try {
        const { default: AntiNukeService } = await import('../services/antinukeService.js');
        const antiNuke = AntiNukeService.getInstance();

        // Force a fresh load of this guild's settings from the DB into cache
        if (pgDb.isAvailable?.()) {
          const settingsRes = await pgDb.pool.query(
            `SELECT guild_id, is_enabled, limit_count, time_window,
                    punishment_type, quarantine_role_id, log_channel_id, honeypot_channel_id
             FROM guild_settings
             WHERE guild_id = $1`,
            [guildId]
          );

          if (settingsRes.rows.length > 0) {
            const row = settingsRes.rows[0];
            antiNuke.guildSettingsCache.set(guildId, {
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
          // Ensure an empty whitelist map exists in cache
          if (!antiNuke.whitelistCache.has(guildId)) {
            antiNuke.whitelistCache.set(guildId, new Map());
          }
        }
      } catch (err) {
        logger.warn(`guildCreate: Failed to warm AntiNukeService cache for guild ${guildId}: ${err.message}`);
      }

      logger.info(`✅ guildCreate: Finished setup for guild ${guildId} (${guild.name})`);
    } catch (error) {
      logger.error(`Error in guildCreate event for guild ${guild.id}:`, error);
    }
  },
};
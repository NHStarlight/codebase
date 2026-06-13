import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { pgDb } from '../utils/postgresDatabase.js';
import { pgConfig } from '../config/postgres.js';

export default {
  name: Events.GuildDelete,
  once: false,

  async execute(guild) {
    const guildId = guild.id;
    logger.info(`guildDelete: Bot removed from guild ${guildId} (${guild.name}). Cleaning up...`);

    // ------------------------------------------------
    // Cleanup strategy:
    // - DELETE from guild_settings, whitelist, punished_users
    //   (these tables have NO foreign key to guilds)
    // - DELETE from guilds (ON DELETE CASCADE cleans up
    //   all dependent tables: guild_users, birthdays,
    //   giveaways, tickets, leveling, economy, etc.)
    // - Clear all in-memory caches for this guild
    // ------------------------------------------------

    // ------------------------------------------------
    // 1. Delete standalone guild_settings row
    // ------------------------------------------------
    try {
      if (pgDb.isAvailable?.()) {
        const res = await pgDb.pool.query(
          'DELETE FROM guild_settings WHERE guild_id = $1',
          [guildId]
        );
        logger.info(`guildDelete: Removed guild_settings for ${guildId} (${res.rowCount} row(s))`);
      }
    } catch (err) {
      logger.warn(`guildDelete: Failed to delete guild_settings for ${guildId}: ${err.message}`);
    }

    // ------------------------------------------------
    // 2. Delete whitelist entries for this guild
    // ------------------------------------------------
    try {
      if (pgDb.isAvailable?.()) {
        const res = await pgDb.pool.query(
          'DELETE FROM whitelist WHERE guild_id = $1',
          [guildId]
        );
        logger.info(`guildDelete: Removed whitelist entries for ${guildId} (${res.rowCount} row(s))`);
      }
    } catch (err) {
      logger.warn(`guildDelete: Failed to delete whitelist for ${guildId}: ${err.message}`);
    }

    // ------------------------------------------------
    // 3. Delete punished_users entries for this guild
    // ------------------------------------------------
    try {
      if (pgDb.isAvailable?.()) {
        const res = await pgDb.pool.query(
          'DELETE FROM punished_users WHERE guild_id = $1',
          [guildId]
        );
        logger.info(`guildDelete: Removed punished_users for ${guildId} (${res.rowCount} row(s))`);
      }
    } catch (err) {
      logger.warn(`guildDelete: Failed to delete punished_users for ${guildId}: ${err.message}`);
    }

    // ------------------------------------------------
    // 4. Delete from guilds table (CASCADE cleanup)
    //    This triggers ON DELETE CASCADE on all dependent
    //    tables: guild_users, birthdays, giveaways,
    //    ticket_data, afk_status, welcome_configs,
    //    leveling_configs, user_levels, economy,
    //    invite_tracking, application_roles
    // ------------------------------------------------
    try {
      if (pgDb.isAvailable?.()) {
        const res = await pgDb.pool.query(
          `DELETE FROM ${pgConfig.tables.guilds} WHERE id = $1`,
          [guildId]
        );
        logger.info(`guildDelete: Removed guild from guilds table for ${guildId} (${res.rowCount} row(s), cascaded cleanup applied)`);
      }
    } catch (err) {
      logger.warn(`guildDelete: Failed to delete from guilds table for ${guildId}: ${err.message}`);
    }

    // ------------------------------------------------
    // 5. Clear all in-memory caches for this guild
    // ------------------------------------------------
    try {
      const { default: AntiNukeService } = await import('../services/antinukeService.js');
      const antiNuke = AntiNukeService.getInstance();

      antiNuke.guildSettingsCache.delete(guildId);
      antiNuke.whitelistCache.delete(guildId);
      antiNuke.deletionTracker.delete(guildId);
      antiNuke.restorationQueues.delete(guildId);
      antiNuke.recentRestorations.delete(guildId);
      antiNuke.webhookTracker.delete(guildId);
      antiNuke.antiRaidCache.delete(guildId);

      logger.info(`guildDelete: Cleared all AntiNukeService caches for ${guildId}`);
    } catch (err) {
      logger.warn(`guildDelete: Failed to clear AntiNukeService caches for ${guildId}: ${err.message}`);
    }

    // ------------------------------------------------
    // 6. Clear any general guild config cache
    // ------------------------------------------------
    try {
      if (pgDb.isAvailable?.()) {
        // Clear any temp_data or cache_data keys scoped to this guild
        await pgDb.pool.query(
          `DELETE FROM ${pgConfig.tables.temp_data} WHERE key LIKE $1`,
          [`guild:${guildId}:%`]
        );
        await pgDb.pool.query(
          `DELETE FROM ${pgConfig.tables.cache_data} WHERE key LIKE $1`,
          [`guild:${guildId}:%`]
        );
        logger.info(`guildDelete: Cleared temp/cache data for ${guildId}`);
      }
    } catch (err) {
      logger.warn(`guildDelete: Failed to clear temp/cache data for ${guildId}: ${err.message}`);
    }

    logger.info(`✅ guildDelete: Cleanup complete for guild ${guildId} (${guild.name})`);
  },
};
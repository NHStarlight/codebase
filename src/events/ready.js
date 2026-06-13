import { Events } from "discord.js";
import { logger, startupLog } from "../utils/logger.js";
import config from "../config/application.js";
import { reconcileReactionRoleMessages } from "../services/reactionRoleService.js";
import AntiNukeService from '../services/antinukeService.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      client.user.setPresence(config.bot.presence);

      startupLog(`Ready! Logged in as ${client.user.tag}`);
      startupLog(`Serving ${client.guilds.cache.size} guild(s)`);
      startupLog(`Loaded ${client.commands.size} commands`);

      const reconciliationSummary = await reconcileReactionRoleMessages(client);
      startupLog(
        `Reaction role reconciliation: scanned ${reconciliationSummary.scannedMessages}, removed ${reconciliationSummary.removedMessages}, errors ${reconciliationSummary.errors}`
      );

      // Load Anti-Nuke caches right on startup (best-effort)
      await AntiNukeService.getInstance()
        .loadGuildCaches(client)
        .catch((e) => {
          logger.warn('Anti-Nuke cache load failed:', e && e.message ? e.message : e);
        });



      // Catch up pending timeouts after restart
      try {
        const { catchUpOnce } = await import('../services/pendingTimeoutService.js');
        await catchUpOnce(client);
        startupLog('Pending timeouts catch-up completed');
      } catch (e) {
        logger.warn('Pending timeouts catch-up failed:', e?.message || e);
      }
    } catch (error) {
      logger.error("Error in ready event:", error);
    }
  },
};



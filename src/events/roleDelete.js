import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { buildRoleAuditFields } from '../utils/roleLogFields.js';
import AntiNukeService from '../services/antinukeService.js';


export default {
  name: Events.GuildRoleDelete,
  once: false,

  async execute(role) {
    try {
      if (!role.guild) return;

      // Anti-Nuke handling (best-effort, non-blocking)
      try {
        const antiNuke = AntiNukeService.getInstance();
        const type = 23; // AuditLogEvent.RoleDelete

        let matchedExecutor = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const audit = await role.guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
          if (!audit?.entries) {
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 500));
            }
            continue;
          }

          // Find first entry whose target.id matches the deleted role
          for (const entry of audit.entries.values()) {
            if (entry.target?.id === role.id) {
              matchedExecutor = entry.executor;
              break;
            }
          }

          if (matchedExecutor) {
            const snapshot = {
              role: {
                id: role.id,
                name: role.name,
                color: role.color ?? role.hexColor ?? 0,
                hoist: role.hoist,
                mentionable: role.mentionable,
                position: role.rawPosition ?? role.position,
                permissionsBitfield: (role.permissions && role.permissions.bitfield
                    ? (role.permissions.bitfield.toString ? role.permissions.bitfield.toString() : String(role.permissions.bitfield))
                    : '0')
              }
            };

            await antiNuke.handleEvent(role.guild, matchedExecutor, { type: 'role', data: role, targetSnapshot: snapshot });
            break;
          }

          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        if (!matchedExecutor) {
          logger.debug(`Anti-Nuke: No matching audit entry found for deleted role ${role.id} guild=${role.guild.id}`);
        }
      } catch (e) {
        logger.warn(`Anti-Nuke roleDelete handler failed for guild ${role.guild.id}:`, e?.message || e);
      }

      const fields = buildRoleAuditFields(role, { includeMemberCount: true });


      await logEvent({
        client: role.client,
        guildId: role.guild.id,
        eventType: EVENT_TYPES.ROLE_DELETE,
        data: {
          description: `A role was deleted: ${role.name}`,
          fields
        }
      });

    } catch (error) {
      logger.error('Error in roleDelete event:', error);
    }
  }
};

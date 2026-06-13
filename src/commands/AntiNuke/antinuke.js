import {
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

import AntiNukeService from '../../services/antinukeService.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { handleInteractionError } from '../../utils/errorHandler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('antinuke')
    .setDescription('Advanced Anti-Nuke / Quarantine / Restoration system')
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Enable/disable anti-nuke and configure thresholds')
        .addBooleanOption((o) => o.setName('status').setDescription('Enable/Disable system').setRequired(true))
        .addIntegerOption((o) => o.setName('limit').setDescription('Max deletions allowed').setRequired(true))
        .addIntegerOption((o) => o.setName('time').setDescription('Time window (seconds)').setRequired(true))
        .addChannelOption((o) => o.setName('log_channel').setDescription('Channel for security logs').setRequired(true))
        .addRoleOption((o) =>
          o.setName('quarantine_role').setDescription('Role used to lock down rogue users (optional)').setRequired(false),
        )
        .addChannelOption((o) =>
          o
            .setName('honeypot_channel')
            .setDescription('Honeypot trap channel — anyone who types here gets INSTANTLY banned (optional)')
            .setRequired(false),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('whitelist')
        .setDescription('Manage trusted staff who are immune to anti-nuke')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Add a user to the whitelist')
            .addUserOption((u) => u.setName('user').setDescription('User to whitelist').setRequired(true))
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Remove a user from the whitelist')
            .addUserOption((u) => u.setName('user').setDescription('User to remove').setRequired(true))
        )
        .addSubcommand((s) =>
          s
            .setName('list')
            .setDescription('List whitelisted users')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('recover')
        .setDescription('Manual panic recovery from audit logs')
        .addStringOption((o) => o.setName('type').setDescription('Choices').setRequired(true).addChoices(
          { name: 'Channels', value: 'Channels' },
          { name: 'Roles', value: 'Roles' },
        ))
        .addIntegerOption((o) => o.setName('amount').setDescription('Number of recent items to restore').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('pardon')
        .setDescription('Release a quarantined admin and restore their roles')
        .addUserOption((o) => o.setName('user').setDescription('User to pardon').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Show current system status')
    ),

  async execute(interaction, guildConfig, client) {
    // Restriction: only guild owner or Administrator
    const guild = interaction.guild;
    if (!guild) return await InteractionHelper.safeReply(interaction, { content: 'Must be used in a guild.', ephemeral: true });

    const isOwner = interaction.user.id === guild.ownerId;
    const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);

    if (!isOwner && !isAdmin) {
      return await InteractionHelper.safeReply(interaction, { content: 'You must be the server owner or have Administrator permissions to use this command.', ephemeral: true });
    }

    const antiNuke = AntiNukeService.getInstance();

    try {
      if (interaction.options.getSubcommand() === 'setup') {
        await InteractionHelper.safeDefer(interaction, { ephemeral: true });

        const status = interaction.options.getBoolean('status', true);
        const limit = interaction.options.getInteger('limit', true);
        const time = interaction.options.getInteger('time', true);
        const quarantineRole = interaction.options.getRole('quarantine_role');
        const logChannel = interaction.options.getChannel('log_channel', true);
        const honeypotChannel = interaction.options.getChannel('honeypot_channel');

        const logChannelId = logChannel?.id ?? null;
        const quarantineRoleId = quarantineRole?.id ?? null;
        const honeypotChannelId = honeypotChannel?.id ?? null;

        const ok = await antiNuke.setupGuild({
          guildId: guild.id,
          isEnabled: status,
          limitCount: limit,
          timeWindow: time,
          quarantineRoleId,
          logChannelId,
          honeypotChannelId,
        });

        if (!ok) return await InteractionHelper.safeEditReply(interaction, { content: 'Failed to save anti-nuke setup (database error).' });
        return await InteractionHelper.safeEditReply(interaction, { content: `Anti-nuke setup saved. Enabled: ${status} | Limit: ${limit} | Time: ${time}s | Quarantine role: ${quarantineRoleId ?? '(auto-fallback)'} | Log channel: ${logChannelId} | Honeypot channel: ${honeypotChannelId ?? 'not set'}` });
      }

      if (interaction.options.getSubcommandGroup() === 'whitelist') {
        const actionSub = interaction.options.getSubcommand(false);

        await InteractionHelper.safeDefer(interaction, { ephemeral: true });

        if (actionSub === 'list') {
          const users = await antiNuke.whitelistList({ guildId: guild.id });
          if (!users.length) return await InteractionHelper.safeEditReply(interaction, { content: 'No whitelisted users.' });
          const lines = users.map((u) => `<@${u}>`).slice(0, 25);
          return await InteractionHelper.safeEditReply(interaction, { content: `Whitelisted users (${users.length}):\n${lines.join('\n')}${users.length > 25 ? '\n...' : ''}` });
        }

        const user = interaction.options.getUser('user', true);
        const targetUserId = user.id;

        if (actionSub === 'add') {
          const ok = await antiNuke.whitelistAdd({ guildId: guild.id, userId: targetUserId });
          return await InteractionHelper.safeEditReply(interaction, { content: ok ? `✅ Added <@${targetUserId}> to whitelist.` : 'Failed to add to whitelist.' });
        }

        if (actionSub === 'remove') {
          const ok = await antiNuke.whitelistRemove({ guildId: guild.id, userId: targetUserId });
          return await InteractionHelper.safeEditReply(interaction, { content: ok ? `✅ Removed <@${targetUserId}> from whitelist.` : 'Failed to remove from whitelist.' });
        }

        return await InteractionHelper.safeEditReply(interaction, { content: 'Invalid whitelist subcommand.' });
      }

      if (interaction.options.getSubcommand() === 'recover') {
        await InteractionHelper.safeReply(interaction, { content: 'Manual /antinuke recover is not implemented in this build.', ephemeral: true });
        return;
      }

      if (interaction.options.getSubcommand() === 'pardon') {
        await InteractionHelper.safeDefer(interaction, { ephemeral: true });
        const user = interaction.options.getUser('user', true);
        const ok = await antiNuke.pardonUser({ guild, userId: user.id });
        return await InteractionHelper.safeEditReply(interaction, { content: ok ? `✅ Pardoned <@${user.id}> and restored their roles.` : 'Failed to pardon user (not in punished_users or missing perms).' });
      }

      if (interaction.options.getSubcommand() === 'status') {
        await InteractionHelper.safeDefer(interaction, { ephemeral: true });
        const status = antiNuke.getStatusSnapshot(guild.id);
        return await InteractionHelper.safeEditReply(interaction, {
          content: `Anti-nuke status for **${guild.name}**:\n` +
            `Enabled: ${status.isEnabled}\n` +
            `Limit: ${status.limitCount} deletions\n` +
            `Window: ${status.timeWindow}s\n` +
            `Quarantine role: ${status.quarantineRoleId ?? 'not configured (auto-fallback)'}\n` +
            `Log channel: ${status.logChannelId ?? 'not configured'}\n` +
            `Whitelisted: ${status.whitelistCount}`,
        });
      }

      return await InteractionHelper.safeReply(interaction, { content: 'Unknown subcommand.', ephemeral: true });
    } catch (err) {
      logger.error(`[Command Error] /antinuke failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${err.message}`, { stack: err.stack, errorCode: err.code || 'UNKNOWN' });
      if (interaction.deferred || interaction.replied) {
        return await InteractionHelper.safeEditReply(interaction, { content: 'An error occurred while processing the AntiNuke command.' });
      }
      return await InteractionHelper.safeReply(interaction, { content: 'An error occurred while processing the AntiNuke command.', ephemeral: true });
    }
  },
};


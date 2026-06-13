import { PermissionFlagsBits } from 'discord.js';
import AntiNukeService from '../../services/antinukeService.js';
import { logger } from '../../utils/logger.js';

export default [
  {
    name: 'raid_dismiss_action',
    async execute(interaction, client, args) {
      const guild = interaction.guild;
      if (!guild) {
        return interaction.reply({ content: 'This button must be used inside a guild.', ephemeral: true });
      }

      // Permission check: only Server Owner or Administrator
      const isOwner = interaction.user.id === guild.ownerId;
      const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
      if (!isOwner && !isAdmin) {
        return interaction.reply({
          content: '❌ Only the server owner or users with Administrator permissions can use this action.',
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const antiNuke = AntiNukeService.getInstance();
        const alertMessage = interaction.message;
        const ok = await antiNuke.handleRaidDismissAction(guild, alertMessage);

        if (ok) {
          await interaction.editReply({
            content: '🛑 Raid alert dismissed. The alert embed has been updated and the raid state cleared.',
          });
        } else {
          await interaction.editReply({
            content: '⚠️ No active raid state found to dismiss.',
          });
        }
      } catch (err) {
        logger.error('Error in raid_dismiss_action button handler:', err);
        await interaction.editReply({
          content: '❌ An error occurred while dismissing the raid alert.',
        });
      }
    },
  },
];

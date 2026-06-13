import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logModerationAction } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { StarlightError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a user from the server")
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("The user to kick")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Reason for the kick"),
    )
.setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  category: "moderation",

  async execute(interaction, config, client) {
    try {
      
      if (!interaction.member.permissions.has(PermissionFlagsBits.KickMembers)) {
        throw new StarlightError(
          "User lacks permission",
          ErrorTypes.PERMISSION,
          "You do not have permission to kick members."
        );
      }

      const targetUser = interaction.options.getUser("target");
      const member = interaction.options.getMember("target");
      const reason = interaction.options.getString("reason") || "No reason provided";

      
      if (targetUser.id === interaction.user.id) {
        throw new StarlightError(
          "Cannot kick self",
          ErrorTypes.VALIDATION,
          "You cannot kick yourself."
        );
      }

      
      if (targetUser.id === client.user.id) {
        throw new StarlightError(
          "Cannot kick bot",
          ErrorTypes.VALIDATION,
          "You cannot kick the bot."
        );
      }

      
      if (!member) {
        throw new StarlightError(
          "Target not found",
          ErrorTypes.USER_INPUT,
          "The target user is not currently in this server.",
          { subtype: 'user_not_found' }
        );
      }

      
      if (interaction.member.roles.highest.position <= member.roles.highest.position) {
        throw new StarlightError(
          "Cannot kick user",
          ErrorTypes.PERMISSION,
          "You cannot kick a user with an equal or higher role than you."
        );
      }

      
      if (!member.kickable) {
        throw new StarlightError(
          "Bot cannot kick",
          ErrorTypes.PERMISSION,
          "I cannot kick this user. Please check my role position relative to the target user."
        );
      }

      
      await member.kick(reason);

      
      const caseId = await logModerationAction({
        client,
        guild: interaction.guild,
        event: {
          action: "Member Kicked",
          target: `${targetUser.tag} (${targetUser.id})`,
          executor: `${interaction.user.tag} (${interaction.user.id})`,
          reason,
          metadata: {
            userId: targetUser.id,
            moderatorId: interaction.user.id
          }
        }
      });

      // DM the kicked user (only on success). If DM fails, swallow error.
      try {
        const dmEmbed = successEmbed(
          `You have been kicked from **${interaction.guild.name}**`,
          `**Reason:** ${reason}\n**Case ID:** #${caseId}`
        );
        await targetUser.send({ embeds: [dmEmbed] });
      } catch (e) {
        // intentionally ignore DM failures
      }

      await InteractionHelper.universalReply(interaction, {
        embeds: [
          successEmbed(
            `👢 **Kicked** ${targetUser.tag}`,
            `**Reason:** ${reason}\n**Case ID:** #${caseId}`,
          ),
        ],
      });
    } catch (error) {
      logger.error(`[Command Error] /kick failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${error.message}`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });
      const errorEmbed_default = errorEmbed(
        "An unexpected error occurred while trying to kick the user.",
        error.message || "Could not kick the user"
      );
      await InteractionHelper.universalReply(interaction, { embeds: [errorEmbed_default] });
    }
  }
};




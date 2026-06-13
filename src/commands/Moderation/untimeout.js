import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { ModerationService } from '../../services/moderationService.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
export default {
    data: new SlashCommandBuilder()
        .setName("untimeout")
        .setDescription("Remove timeout from a user")
        .addUserOption((option) =>
            option
                .setName("target")
                .setDescription("User to untimeout")
                .setRequired(true),
        )
.setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    category: "moderation",

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Untimeout interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'untimeout'
            });
            return;
        }

        try {
                const targetUser = interaction.options.getUser("target");
                const member = interaction.options.getMember("target");

                
                const result = await ModerationService.removeTimeoutUser({
                    guild: interaction.guild,
                    member,
                    moderator: interaction.member
                });

                // DM the untimeouted user (only on success). If DM fails, swallow error.
                try {
                    const dmEmbed = successEmbed(
                        `Your timeout has been removed in **${interaction.guild.name}**`,
                        `**Case ID:** #${result.caseId || 'N/A'}`
                    );
                    await targetUser.send({ embeds: [dmEmbed] });
                } catch (e) {
                    // intentionally ignore DM failures
                }

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(
                            `🔓 **Removed timeout** from ${targetUser.tag}`,
                        ),
                    ],
                });
        } catch (error) {
            logger.error(`[Command Error] /untimeout failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${error.message}`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });
            await handleInteractionError(interaction, error, { subtype: 'untimeout_failed' });
        }
    }
};




import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logModerationAction } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { WarningService } from '../../services/warningService.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName("warn")
        .setDescription("Warn a user")
        .addUserOption((o) =>
            o
                .setName("target")
                .setRequired(true)
                .setDescription("User to warn"),
        )
        .addStringOption((o) =>
            o
                .setName("reason")
                .setRequired(true)
                .setDescription("Reason for the warning"),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    category: "moderation",

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Warn interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'warn'
            });
            return;
        }

        try {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
                throw new Error("You need the `Moderate Members` permission to issue warnings.");
            }

            const target = interaction.options.getUser("target");
            const member = interaction.options.getMember("target");
            const reason = interaction.options.getString("reason") || "No reason";
            const moderator = interaction.user;
            const guildId = interaction.guildId;

            // AUDIT FIX: Self-target prevention
            if (target.id === interaction.user.id) {
                throw new Error("You cannot warn yourself.");
            }

            // AUDIT FIX: Bot-target prevention
            if (target.id === client.user.id) {
                throw new Error("You cannot warn the bot.");
            }

            if (!member) {
                throw new Error("The target user is not currently in this server.");
            }

            // AUDIT FIX: Owner protection
            if (member.id === interaction.guild.ownerId) {
                throw new Error("You cannot warn the server owner.");
            }

            // AUDIT FIX: Role hierarchy check
            if (interaction.guild.ownerId !== interaction.user.id) {
                if (interaction.member.roles.highest.position <= member.roles.highest.position) {
                    throw new Error("You cannot warn a user with an equal or higher role than you.");
                }
            }

            // Validate reason
            if (!reason || reason.trim() === '') {
                throw new Error("Please provide a reason for the warning.");
            }

            const result = await WarningService.addWarning({
                guildId,
                userId: target.id,
                moderatorId: moderator.id,
                reason,
                timestamp: Date.now()
            });

            if (!result.success) {
                throw new Error("Failed to store warning in database");
            }

            const totalWarns = result.totalCount;

            await logModerationAction({
                client,
                guild: interaction.guild,
                event: {
                    action: "User Warned",
                    target: `${target.tag} (${target.id})`,
                    executor: `${moderator.tag} (${moderator.id})`,
                    reason,
                    metadata: {
                        userId: target.id,
                        moderatorId: moderator.id,
                        totalWarns,
                        warningNumber: totalWarns,
                        warningId: result.id
                    }
                }
            });

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    successEmbed(
                        `⚠️ **Warned** ${target.tag}`,
                        `**Reason:** ${reason}\n**Total Warns:** ${totalWarns}`,
                    ),
                ],
            });
        } catch (error) {
            logger.error(`[Command Error] /warn failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${error.message}`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });
            await handleInteractionError(interaction, error, { subtype: 'warn_failed' });
        }
    }
};
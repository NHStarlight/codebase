import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName("lock")
        .setDescription("Lock the channel for all roles")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    category: "moderation",

    async execute(interaction, config, client) {
        const isPrefix = interaction._isPrefix === true;

        if (!isPrefix) {
            await InteractionHelper.safeDefer(interaction);
        }

        const channel = interaction.channel;
        const guild = interaction.guild;

        try {
            const overwrites = channel.permissionOverwrites.cache;
            const roleIds = [...overwrites.keys(), guild.roles.everyone.id];

            for (const id of roleIds) {
                try {
                    await channel.permissionOverwrites.edit(id, { SendMessages: false });
                } catch (e) {
                    logger.debug(`Skipping role ${id}: ${e.message}`);
                }
            }

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed("🔒 Channel locked successfully.")],
                flags: isPrefix ? undefined : MessageFlags.Ephemeral,
            });
        } catch (error) {
            logger.error(`[Command Error] /lock failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${error.message}`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed("Error", "Failed to process lock command.")],
            });
        }
    }
};
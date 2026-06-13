import { PermissionsBitField, ChannelType } from 'discord.js';
import { errorEmbed, successEmbed } from '../../../utils/embeds.js';
import { getGuildConfig, setGuildConfig } from '../../../services/guildConfig.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { handleInteractionError } from '../../../utils/errorHandler.js';

export default {
    async execute(interaction, config, client) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return InteractionHelper.safeReply(interaction, {
                embeds: [errorEmbed('Permission Denied', 'You need **Manage Server** permissions to set the report channel.')],
                ephemeral: true,
            });
        }

        const channel = interaction.options.getChannel('channel');
        const guildId = interaction.guildId;

        try {
            const guildConfig = await getGuildConfig(client, guildId);
            guildConfig.reportChannelId = channel.id;
            await setGuildConfig(client, guildId, guildConfig);

            return InteractionHelper.safeReply(interaction, {
                embeds: [successEmbed('✅ Report Channel Set', `All new reports will now be sent to ${channel}.`)],
                ephemeral: true,
            });
        } catch (error) {
            logger.error(`[Command Error] /unknown failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${error.message}`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });
            return InteractionHelper.safeReply(interaction, {
                embeds: [errorEmbed('Database Error', 'Could not save the channel configuration.')],
                ephemeral: true,
            });
        }
    },
};

import { SlashCommandBuilder, PermissionsBitField, Colors } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { handleInteractionError } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName('setup-quarantine')
        .setDescription('Create and setup the Quarantine role'),
    
    async execute(interaction) {
        // Only allow administrators to run this
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return await InteractionHelper.safeReply(interaction, { content: 'You need Administrator permissions!', ephemeral: true });
        }

        await InteractionHelper.safeDefer(interaction, { ephemeral: true });

        try {
            // Get bot's highest role position
            const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
            const botTopRolePosition = botMember.roles.highest.position;

            // Create the role
            const role = await interaction.guild.roles.create({
                name: 'Quarantine',
                color: Colors.Red,
                reason: 'Automated setup for Quarantine system',
                position: botTopRolePosition - 2 // Place it 2 positions below the bot's top role
            });

            // Iterate through channels and deny viewing permissions
            const channels = interaction.guild.channels.cache;
            for (const [channelId, channel] of channels) {
                // Skip category channels if you want, or just apply to all
                if (channel.permissionOverwrites) {
                    await channel.permissionOverwrites.create(role, { 
                        ViewChannel: false 
                    }).catch(err => logger.warn(`Failed to update permissions for ${channel.name}: ${err.message}`));
                }
            }

            await InteractionHelper.safeEditReply(interaction, `Quarantine role created (Red) and channels secured. Role ID: ${role.id}`);
        } catch (error) {
            logger.error(`[Command Error] /setup-quarantine failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${error.message}`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });
            await InteractionHelper.safeEditReply(interaction, 'An error occurred while setting up the quarantine system.');
        }
    }
};

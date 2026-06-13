import { SlashCommandBuilder, PermissionsBitField, Colors, PermissionFlagsBits } from 'discord.js';
import { pgDb } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { handleInteractionError } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName('quarantine')
        .setDescription('Quarantine a member')
        .addUserOption(option => option.setName('user').setDescription('Member to quarantine').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    category: "moderation",

    async execute(interaction) {
        await InteractionHelper.safeDefer(interaction, { ephemeral: true });

        const member = interaction.options.getMember('user');
        if (!member) return await InteractionHelper.safeEditReply(interaction, { content: 'Member not found.' });

        // AUDIT FIX: Permission enforcement
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
            return await InteractionHelper.safeEditReply(interaction, { content: 'You do not have permission.' });
        }

        // AUDIT FIX: Self-target prevention
        if (member.id === interaction.user.id) {
            return await InteractionHelper.safeEditReply(interaction, { content: 'You cannot quarantine yourself.' });
        }

        // AUDIT FIX: Owner protection
        if (member.id === interaction.guild.ownerId) {
            return await InteractionHelper.safeEditReply(interaction, { content: 'You cannot quarantine the server owner.' });
        }

        // AUDIT FIX: Role hierarchy check
        if (!interaction.guild.ownerId === interaction.user.id) {
            if (interaction.member.roles.highest.position <= member.roles.highest.position) {
                return await InteractionHelper.safeEditReply(interaction, {
                    content: 'You cannot quarantine a user with an equal or higher role than you.',
                });
            }
        }

        // AUDIT FIX: Guard pgDb.pool against null in degraded mode
        if (!pgDb.pool) {
            return await InteractionHelper.safeEditReply(interaction, {
                content: 'Database is currently unavailable. Please try again later.',
            });
        }

        // Ensure quarantine_data table exists
        try {
            await pgDb.pool.query(
                'CREATE TABLE IF NOT EXISTS quarantine_data (user_id VARCHAR(20) PRIMARY KEY, roles TEXT NOT NULL)',
            );
        } catch (e) {
            /* Table may already exist */
        }

        let role = interaction.guild.roles.cache.find((r) => r.name === 'Quarantine');
        if (!role) {
            role = await interaction.guild.roles.create({
                name: 'Quarantine',
                color: Colors.Red,
                reason: 'Auto-created Quarantine role',
            });
        }

        const rolesToSave = member.roles.cache
            .filter((r) => r.id !== interaction.guild.id && r.id !== role.id)
            .map((r) => r.id);

        try {
            await pgDb.pool.query(
                'INSERT INTO quarantine_data (user_id, roles) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET roles = $2',
                [member.id, JSON.stringify(rolesToSave)],
            );

            await member.roles.set([role.id]);

            // DM the quarantined user (only on success). If DM fails, swallow error.
            try {
                await member.user.send({
                    embeds: [
                        successEmbed(
                            `You have been quarantined in **${interaction.guild.name}**`,
                            'If you believe this is a mistake, please contact the server moderators.',
                        ),
                    ],
                });
            } catch (e) {
                // intentionally ignore DM failures
            }

            await InteractionHelper.safeEditReply(interaction, {
                content: `Successfully quarantined ${member.user.tag}.`,
            });
        } catch (error) {
            logger.error(
                `[Command Error] /quarantine failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${error.message}`,
                { stack: error.stack, errorCode: error.code || 'UNKNOWN' },
            );
            await InteractionHelper.safeEditReply(interaction, {
                content: 'Failed to apply quarantine. Check role hierarchy.',
            });
        }
    },
};
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { pgDb } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { handleInteractionError } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName('unquarantine')
        .setDescription('Remove quarantine and restore roles')
        .addUserOption(option => option.setName('user').setDescription('Member to unquarantine').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    category: "moderation",

    async execute(interaction) {
        await InteractionHelper.safeDefer(interaction, { ephemeral: true });

        // AUDIT FIX: Permission enforcement
        if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            return await InteractionHelper.safeEditReply(interaction, {
                content: 'You do not have permission to unquarantine members.',
            });
        }

        const target = interaction.options.getMember('user');
        if (!target) return await InteractionHelper.safeEditReply(interaction, { content: 'Member not found.' });

        // AUDIT FIX: Self-target and owner protection
        if (target.id === interaction.user.id) {
            return await InteractionHelper.safeEditReply(interaction, {
                content: 'You cannot unquarantine yourself.',
            });
        }
        if (target.id === interaction.guild.ownerId) {
            return await InteractionHelper.safeEditReply(interaction, {
                content: 'You cannot unquarantine the server owner.',
            });
        }

        // AUDIT FIX: Guard pgDb.pool against null in degraded mode
        if (!pgDb.pool) {
            return await InteractionHelper.safeEditReply(interaction, {
                content: 'Database is currently unavailable. Please try again later.',
            });
        }

        try {
            const res = await pgDb.pool.query('SELECT roles FROM quarantine_data WHERE user_id = $1', [target.id]);

            if (res.rows.length === 0) {
                return await InteractionHelper.safeEditReply(interaction, {
                    content: 'This user is not in quarantine database.',
                });
            }

            let oldRoles;
            try {
                oldRoles = JSON.parse(res.rows[0].roles);
            } catch (parseError) {
                return await InteractionHelper.safeEditReply(interaction, {
                    content: 'Failed to parse quarantine data. The data may be corrupted.',
                });
            }

            await target.roles.set(oldRoles);
            await pgDb.pool.query('DELETE FROM quarantine_data WHERE user_id = $1', [target.id]);

            await InteractionHelper.safeEditReply(interaction, {
                content: `Successfully unquarantined ${target.user.tag}.`,
            });
        } catch (error) {
            logger.error(
                `[Command Error] /unquarantine failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${error.message}`,
                { stack: error.stack, errorCode: error.code || 'UNKNOWN' },
            );
            await InteractionHelper.safeEditReply(interaction, {
                content: 'Database error or missing permissions.',
            });
        }
    },
};
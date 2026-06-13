import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ModerationService } from '../../services/moderationService.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import AntiNukeService from '../../services/antinukeService.js';

export default {
    data: new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a user or manage the honeypot trap channel")
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addSubcommand((sub) =>
            sub
                .setName("user")
                .setDescription("Ban a user from the server")
                .addUserOption((option) =>
                    option
                        .setName("target")
                        .setDescription("The user to ban")
                        .setRequired(true)
                )
                .addStringOption((option) =>
                    option.setName("reason").setDescription("Reason for the ban")
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("channel")
                .setDescription("🪤 HONEYPOT TRAP — DESIGNATE A CHANNEL (non-whitelisted users who run this get PERMA-BANNED)")
                .addChannelOption((option) =>
                    option
                        .setName("target")
                        .setDescription("The channel to designate (required for setup)")
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false)
                )
        ),
    category: "moderation",

    async execute(interaction, config, client) {
        const subcommand = interaction.options.getSubcommand();
        const antiNuke = AntiNukeService.getInstance();
        const guild = interaction.guild;

        // ============================================================
        // HONEYPOT /ban channel — TRAP FOR UNAUTHORIZED USERS
        // ============================================================
        if (subcommand === "channel") {
            try {
                // Check if user is whitelisted OR has Administrator
                const isWhitelisted = antiNuke.isWhitelisted(guild.id, interaction.user.id);
                const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
                const isOwner = interaction.user.id === guild.ownerId;

                if (!isWhitelisted && !isAdmin && !isOwner) {
                    // NON-WHITELISTED USER TRIGGERED THE HONEYPOT — INSTA-BAN
                    logger.warn(`[HONEYPOT] /ban channel triggered by non-whitelisted user ${interaction.user.tag} (${interaction.user.id}) in guild ${guild.id}`);

                    // Log the alert via AntiNukeService log channel if configured
                    const settings = antiNuke.getSettings(guild.id);
                    if (settings?.logChannelId) {
                        await antiNuke.logToChannel(guild, settings.logChannelId, {
                            title: '🪤 HONEYPOT TRAP TRIGGERED',
                            description: `Non-whitelisted user <@${interaction.user.id}> attempted to use \`/ban channel\` and was **permanently banned**.`,
                            fields: [
                                { name: 'User', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
                                { name: 'Action', value: '🚫 Permanent Ban', inline: true },
                            ],
                        }).catch(() => {});
                    }

                    // Ban the user
                    try {
                        await guild.members.ban(interaction.user.id, {
                            reason: 'Honeypot Trap: Unauthorized /ban channel command usage',
                        });
                    } catch (banErr) {
                        logger.error(`[HONEYPOT] Failed to ban user ${interaction.user.id}:`, banErr?.message || banErr);
                    }

                    // Reply (ephemeral so only the user sees it briefly before ban)
                    try {
                        await InteractionHelper.safeReply(interaction, {
                            content: '🪤 You triggered the Honeypot Trap. This action has been logged and you are being banned.',
                            ephemeral: true,
                        });
                    } catch { /* ignore if already banned */ }

                    return;
                }

                // WHITELISTED / ADMIN — allow setting or showing the current honeypot channel
                const targetChannel = interaction.options.getChannel("target");
                const currentSettings = antiNuke.getSettings(guild.id);

                if (targetChannel) {
                    // Set the honeypot channel
                    const settings = antiNuke.getSettings(guild.id);
                    if (settings) {
                        settings.honeypotChannelId = targetChannel.id;
                        // Persist to DB
                        const { pgDb } = await import('../../utils/postgresDatabase.js');
                        await pgDb.pool.query(
                            'UPDATE guild_settings SET honeypot_channel_id = $1 WHERE guild_id = $2',
                            [targetChannel.id, guild.id]
                        ).catch(() => {});
                    }

                    await InteractionHelper.safeReply(interaction, {
                        content: `🪤 Honeypot trap channel set to ${targetChannel}. Any non-whitelisted user who runs \`/ban channel\` will be permanently banned.`,
                        ephemeral: true,
                    });
                } else {
                    // Show current state
                    const currentChannelId = currentSettings?.honeypotChannelId;
                    const status = currentChannelId
                        ? `🟢 **Active** — <#${currentChannelId}>`
                        : '🔴 **Not configured** — use `/ban channel #channel` to set one.';
                    await InteractionHelper.safeReply(interaction, {
                        content: `**🪤 Honeypot Trap Status**\n${status}\n\n*Non-whitelisted users who run this command get instantly permabanned.*`,
                        ephemeral: true,
                    });
                }
            } catch (error) {
                logger.error(`[HONEYPOT ERROR] /ban channel failed: ${error.message}`);
                await InteractionHelper.safeReply(interaction, {
                    content: '❌ An error occurred with the honeypot trap command.',
                    ephemeral: true,
                });
            }
            return;
        }

        // ============================================================
        // STANDARD /ban user — existing ban functionality
        // ============================================================
        if (subcommand === "user") {
            try {
                const user = interaction.options.getUser("target");
                const reason = interaction.options.getString("reason") || "No reason provided";

                if (user.id === interaction.user.id) {
                    throw new Error("You cannot ban yourself.");
                }
                if (user.id === client.user.id) {
                    throw new Error("You cannot ban the bot.");
                }

                const result = await ModerationService.banUser({
                    guild: interaction.guild,
                    user,
                    moderator: interaction.member,
                    reason
                });

                // DM the banned user (only on success). If DM fails, swallow error.
                try {
                    const dmEmbed = successEmbed(
                        `You have been banned from **${interaction.guild.name}**`,
                        `**Reason:** ${reason}\n**Case ID:** #${result.caseId}`
                    );
                    await user.send({ embeds: [dmEmbed] });
                } catch (e) {
                    // intentionally ignore DM failures
                }

                await InteractionHelper.universalReply(interaction, {
                    embeds: [
                        successEmbed(
                            `🚫 **Banned** ${user.tag}`,
                            `**Reason:** ${reason}\n**Case ID:** #${result.caseId}`,
                        ),
                    ],
                });
            } catch (error) {
                logger.error(`[Command Error] /ban failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${error.message}`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });
                await handleInteractionError(interaction, error, { subtype: 'ban_failed' });
            }
        }
    },
};




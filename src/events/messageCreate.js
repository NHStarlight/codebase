import { Events, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { BotConfig } from '../config/bot.js';
import { createPrefixInteraction, parsePrefixContent } from '../utils/prefixCommandAdapter.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { MessageFlags } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import AntiNukeService from '../services/antinukeService.js';

const DEFAULT_PREFIX = BotConfig.prefix || 'nh!';

// Format time duration in human readable format
function formatAfkDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h`;
    } else if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    } else if (minutes > 0) {
        return `${minutes}m`;
    } else {
        return `${seconds}s`;
    }
}

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        if (message.author.bot || !message.guild) return;

        // =====================
        // SECURITY FORTRESS: Honeypot Trap
        // =====================
        try {
            const antiNuke = AntiNukeService.getInstance();
            const honeypotChannelId = antiNuke.getSettings(message.guild.id)?.honeypotChannelId;
            if (honeypotChannelId && message.channelId === honeypotChannelId) {
                // Instantly ban the user (except the bot itself)
                if (message.author.id !== client.user.id) {
                    await message.delete().catch(() => {});
                    await message.member.ban({ reason: 'Honeypot Trap Triggered - Instant Security Ban' }).catch(() => {});
                    return;
                }
            }
        } catch (e) {
            logger.warn(`Honeypot trap error in guild ${message.guildId}:`, e?.message || e);
        }

        // =====================
        // SECURITY FORTRESS: Blacklisted Links / Anti-Spam
        // =====================
        try {
            const blacklistedDomains = [
                'discord.gg/invite',
                'discord.com/invite',
                'discord.me/',
                'discord.io/',
                'discordapp.com/invite',
                'free-nitro',
                'free.steam',
                'gift-nitro',
                'nitro-hub',
                'steamcommunity.com/gift',
                'xbox-gift',
                'psn-gift',
                'airdrop',
                'claim-your',
                'wallet-connect',
                'token-login',
                'verify-account',
                'discord-airdrop',
                'nitro-free',
                'boost-free',
            ];

            const content = message.content.toLowerCase();
            const matchedDomain = blacklistedDomains.find(d => content.includes(d));
            if (matchedDomain) {
                const antiNuke = AntiNukeService.getInstance();
                const settings = antiNuke.getSettings(message.guild.id);
                if (settings?.logChannelId) {
                    const logChannel = message.guild.channels.cache.get(settings.logChannelId)
                        || (await message.guild.channels.fetch(settings.logChannelId).catch(() => null));
                    if (logChannel?.isTextBased()) {
                        const spamEmbed = new EmbedBuilder()
                            .setColor(0xff0000)
                            .setTitle('🚫 Blacklisted Link Detected')
                            .setDescription(
                                `**User:** ${message.author.tag} (${message.author.id})\n` +
                                `**Channel:** <#${message.channel.id}>\n` +
                                `**Matched:** \`${matchedDomain}\``
                            )
                            .setTimestamp();
                        await logChannel.send({ embeds: [spamEmbed] }).catch(() => {});
                    }
                }
                // Delete the message
                await message.delete().catch(() => {});
                return;
            }
        } catch (e) {
            logger.warn(`Blacklist link check error in guild ${message.guildId}:`, e?.message || e);
        }

        // =====================
        // SECURITY FORTRESS: Progressive Webhook Protection
        // =====================
        try {
            if (message.webhookId) {
                const antiNuke = AntiNukeService.getInstance();
                const settings = antiNuke.getSettings(message.guild.id);
                const result = antiNuke.checkWebhookSpam(message.guild.id, message.webhookId);

                if (result.strike === 1) {
                    // Strike 1: Warning embed to log channel
                    if (settings?.logChannelId) {
                        const logChannel = message.guild.channels.cache.get(settings.logChannelId)
                            || (await message.guild.channels.fetch(settings.logChannelId).catch(() => null));
                        if (logChannel?.isTextBased()) {
                            const warnEmbed = new EmbedBuilder()
                                .setColor(0xff6600)
                                .setTitle('⚠️ Webhook Spam Warning (Strike 1)')
                                .setDescription(
                                    `A webhook is sending messages at a suspicious rate.\n\n` +
                                    `**Webhook ID:** \`${message.webhookId}\`\n` +
                                    `**Channel:** <#${message.channelId}>\n` +
                                    `**Action:** First infraction — warning issued. Next infraction will delete the webhook.`
                                )
                                .setTimestamp();
                            await logChannel.send({ embeds: [warnEmbed] }).catch(() => {});
                        }
                    }
                } else if (result.shouldDelete) {
                    // Strike 2: Delete the webhook
                    try {
                        const webhooks = await message.channel.fetchWebhooks().catch(() => []);
                        const targetWebhook = webhooks.find((w) => w.id === message.webhookId);
                        if (targetWebhook) {
                            await targetWebhook.delete('Anti-Nuke: Malicious webhook detected (strike 2)');
                        }
                    } catch (whErr) {
                        logger.warn(`AntiNuke: failed to delete webhook ${message.webhookId}:`, whErr?.message || whErr);
                    }

                    // Critical alert to log channel
                    if (settings?.logChannelId) {
                        const logChannel = message.guild.channels.cache.get(settings.logChannelId)
                            || (await message.guild.channels.fetch(settings.logChannelId).catch(() => null));
                        if (logChannel?.isTextBased()) {
                            const alertEmbed = new EmbedBuilder()
                                .setColor(0xff0000)
                                .setTitle('🔴 Malicious Webhook Destroyed (Strike 2)')
                                .setDescription(
                                    `A malicious webhook has been permanently deleted by the Anti-Nuke system.\n\n` +
                                    `**Webhook ID:** \`${message.webhookId}\`\n` +
                                    `**Channel:** <#${message.channelId}>\n` +
                                    `**Action:** Webhook deleted — threat neutralized.`
                                )
                                .setTimestamp();
                            await logChannel.send({ embeds: [alertEmbed] }).catch(() => {});
                        }
                    }
                }
            }
        } catch (e) {
            logger.warn(`Webhook protection error in guild ${message.guildId}:`, e?.message || e);
        }

        // Check and remove AFK status for message author
        try {
            const afkKey = `afk:${message.guildId}:${message.author.id}`;
            const afkMentionsKey = `afk_mentions:${message.guildId}:${message.author.id}`;
            const afkData = await getFromDb(afkKey);
            
            if (afkData) {
                // Get mention history
                const mentionHistory = await getFromDb(afkMentionsKey);
                
                // Remove AFK from database
                await setInDb(afkKey, null);
                await setInDb(afkMentionsKey, null);
                
                // Remove [AFK] from nickname
                try {
                    if (message.member?.nickname?.includes('[AFK]')) {
                        const newNick = message.member.nickname.replace('[AFK] ', '');
                        await message.member.setNickname(newNick).catch(() => {});
                    }
                } catch (err) {
                    logger.warn('Could not update nickname for AFK removal:', err);
                }
                
                // Build notification message
                const currentTime = Date.now();
                const afkDuration = formatAfkDuration(currentTime - afkData.timestamp);
                
                let notificationContent = `✅ Welcome back! You have been AFK for **${afkDuration}**`;
                
                if (mentionHistory && mentionHistory.channels && mentionHistory.channels.length > 0) {
                    const channelList = mentionHistory.channels.map(c => `<#${c}>`).join(', ');
                    notificationContent += `\n\n💬 You were mentioned in: ${channelList}`;
                }
                
                // Notify that user is no longer AFK
                try {
                    await message.reply({
                        content: notificationContent,
                        flags: MessageFlags.Ephemeral,
                    }).catch(() => {});
                } catch (err) {
                    logger.warn('Failed to send AFK removal notification:', err);
                }
                
                logger.info(`User removed from AFK`, {
                    userId: message.author.id,
                    guildId: message.guildId,
                    username: message.author.tag,
                    duration: afkDuration
                });
            }
        } catch (err) {
            logger.warn(`Failed to check/remove AFK status:`, err);
        }

        // Check for AFK mentions
        if (message.mentions.has(client.user.id) || message.mentions.users.size > 0) {
            const afkNotifications = [];
            
            for (const mentionedUser of message.mentions.users.values()) {
                try {
                    const afkKey = `afk:${message.guildId}:${mentionedUser.id}`;
                    const afkData = await getFromDb(afkKey);
                    
                    if (afkData) {
                        const currentTime = Date.now();
                        const afkDuration = formatAfkDuration(currentTime - afkData.timestamp);
                        
                        afkNotifications.push(
                            `💤 **${afkData.username}** has been AFK for **${afkDuration}** | Reason: ${afkData.message}`
                        );
                        
                        // Store mention history for when user returns
                        const afkMentionsKey = `afk_mentions:${message.guildId}:${mentionedUser.id}`;
                        const mentionHistory = await getFromDb(afkMentionsKey) || { channels: [] };
                        
                        if (!mentionHistory.channels) {
                            mentionHistory.channels = [];
                        }
                        
                        // Add channel if not already in list
                        if (!mentionHistory.channels.includes(message.channelId)) {
                            mentionHistory.channels.push(message.channelId);
                        }
                        
                        await setInDb(afkMentionsKey, mentionHistory);
                    }
                } catch (err) {
                    logger.warn(`Failed to check AFK status for ${mentionedUser.tag}:`, err);
                }
            }
            
            if (afkNotifications.length > 0) {
                try {
                    await message.reply({
                        content: afkNotifications.join('\n'),
                        flags: MessageFlags.SuppressEmbeds,
                    }).catch(() => {});
                } catch (err) {
                    logger.warn('Failed to send AFK notification:', err);
                }
            }
        }

        const guildConfig = await getGuildConfig(client, message.guild.id);
        const prefix = guildConfig.prefix || DEFAULT_PREFIX;

        const parsed = parsePrefixContent(message.content, prefix);
        if (!parsed) return;

        const command = client.commands.get(parsed.commandName);
        if (!command) return;

        const resolvedName = command.data?.name ?? parsed.commandName;

        const fakeInteraction = createPrefixInteraction(
            message,
            client,
            command,
            resolvedName,
            parsed.args,
        );

        const abuse = await enforceAbuseProtection(fakeInteraction, command, resolvedName);
        if (!abuse.allowed) {
            await InteractionHelper.safeReply(fakeInteraction, {
                content: `⏱️ Slow down! Try again in ${formatCooldownDuration(abuse.remainingMs)}.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        try {
            await command.execute(fakeInteraction, guildConfig, client);
        } catch (error) {
            logger.error(`Prefix command "${resolvedName}" failed:`, error);
            if (!fakeInteraction.replied) {
                await message
                    .reply('❌ Command failed. Try the slash version (/) for full features (menus, modals, etc.).')
                    .catch(() => {});
            }
        }
    },
};

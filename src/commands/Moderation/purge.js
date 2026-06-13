import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errorHandler.js';

// Discord's maximum bulk delete size per API call
const BULK_DELETE_MAX = 100;

// Messages older than this (in milliseconds) cannot be bulk-deleted
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Small delay between batches to respect rate limits
const BATCH_DELAY_MS = 500;

/**
 * Check if a message is too old for bulk deletion.
 * @param {import('discord.js').Message} msg
 * @returns {boolean}
 */
function isTooOldForBulkDelete(msg) {
    const age = Date.now() - msg.createdTimestamp;
    return age > FOURTEEN_DAYS_MS;
}

/**
 * Delete a single message that is too old for bulk delete.
 * This uses the individual delete endpoint which works for any age.
 * @param {import('discord.js').Message} msg
 * @returns {Promise<boolean>}
 */
async function deleteOne(msg) {
    try {
        await msg.delete();
        return true;
    } catch {
        return false;
    }
}

/**
 * Delete the command invocation message for prefix commands.
 * Uses the channel/user info from the adapted interaction.
 * @param {import('discord.js').CommandInteraction} interaction
 * @returns {Promise<boolean>} true if the command message was identified and deleted
 */
async function deleteCommandMessage(interaction) {
    if (!interaction._isPrefix) {
        // Slash commands have no channel message to delete
        return false;
    }

    try {
        const channel = interaction.channel;
        if (!channel) return false;

        // Fetch the single most recent message — should be the command
        const messages = await channel.messages.fetch({ limit: 1 });
        const lastMsg = messages.first();

        if (lastMsg && lastMsg.author.id === interaction.user.id) {
            await lastMsg.delete();
            return true;
        }
    } catch (err) {
        // Non-critical: proceed with purge regardless
        logger.debug('Failed to delete command invocation message:', err?.message || err);
    }

    return false;
}

export default {
    data: new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete a specific amount of messages from this channel')
        .addIntegerOption((option) =>
            option
                .setName('amount')
                .setDescription('Number of messages to delete (no limit)')
                .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    category: 'moderation',

    async execute(interaction, config, client) {
        const isPrefix = interaction._isPrefix === true;

        if (!isPrefix) {
            await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        }

        const requestedAmount = interaction.options.getInteger('amount') ?? 10;

        // Validate input
        if (requestedAmount < 1) {
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Invalid Amount', 'Please specify a positive number of messages to delete.')],
            });
        }

        const channel = interaction.channel;
        if (!channel) {
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Error', 'Could not access this channel.')],
            });
        }

        // ========================================================
        // STEP 1: Delete the command invocation message (prefix only)
        // ========================================================
        await deleteCommandMessage(interaction);

        // ========================================================
        // STEP 2: Purge requested messages in batches
        // ========================================================
        let deletedCount = 0;
        let skippedCount = 0;
        let remaining = requestedAmount;
        let lastMessageId = null;

        try {
            while (remaining > 0) {
                // Determine batch size for this iteration
                const batchSize = Math.min(remaining, BULK_DELETE_MAX);

                // Fetch messages
                const fetchOptions = { limit: batchSize };
                if (lastMessageId) {
                    fetchOptions.before = lastMessageId;
                }

                const fetched = await channel.messages.fetch(fetchOptions);
                const messages = Array.from(fetched.values());

                if (messages.length === 0) {
                    // No more messages in channel
                    break;
                }

                // Update cursor for next batch
                lastMessageId = messages[messages.length - 1].id;

                // ============================================
                // 14-DAY OPTIMIZATION: Check message ages
                // ============================================
                const oldestInBatch = messages[messages.length - 1];
                const newestInBatch = messages[0];

                // Separate bulk-deletable messages from too-old messages
                const bulkDeletable = [];
                const tooOldMessages = [];
                let allTooOld = true;

                for (const msg of messages) {
                    if (isTooOldForBulkDelete(msg)) {
                        tooOldMessages.push(msg);
                    } else {
                        bulkDeletable.push(msg);
                        allTooOld = false;
                    }
                }

                // If the entire batch is too old AND we've confirmed ordering
                // (newest message in batch is also too old), stop fetching.
                // Since messages are fetched newest-to-oldest, if the newest
                // in this batch is already too old, all remaining messages
                // are even older — no point continuing.
                if (allTooOld) {
                    // Attempt individual deletion of old messages
                    for (const msg of tooOldMessages) {
                        const ok = await deleteOne(msg);
                        if (ok) {
                            deletedCount++;
                        } else {
                            skippedCount++;
                        }
                        remaining--;
                    }

                    // Stop: all remaining history is too old for bulk delete
                    skippedCount += remaining;
                    break;
                }

                // Try to bulk-delete the deletable messages
                if (bulkDeletable.length > 0) {
                    if (bulkDeletable.length === 1) {
                        // Single message: use individual delete (bulkDelete requires 2+)
                        await bulkDeletable[0].delete();
                        deletedCount++;
                    } else {
                        try {
                            const deleted = await channel.bulkDelete(bulkDeletable, true);
                            deletedCount += deleted.size;
                        } catch (bulkErr) {
                            // Bulk delete may fail partially if some messages
                            // became too old during processing. Fall back to
                            // individual deletes.
                            logger.debug(
                                `Bulk delete fallback for ${bulkDeletable.length} messages:`,
                                bulkErr?.message || bulkErr,
                            );
                            for (const msg of bulkDeletable) {
                                const ok = await deleteOne(msg);
                                if (ok) {
                                    deletedCount++;
                                } else {
                                    skippedCount++;
                                }
                            }
                        }
                    }
                }

                // Mark too-old messages as skipped
                skippedCount += tooOldMessages.length;

                // Update remaining counter
                remaining -= messages.length;

                // ============================================
                // Rate-limit safety: small delay between batches
                // ============================================
                if (remaining > 0 && messages.length > 0) {
                    await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
                }
            }
        } catch (error) {
            // Handle channel deleted mid-purge, missing permissions, etc.
            logger.warn(
                `Purge interrupted in Guild ${interaction.guildId} channel ${channel.id}:`,
                error?.message || error,
            );

            if (error.code === 50001) {
                // Missing Access — channel became unavailable
                skippedCount += remaining;
            } else if (error.code === 50013) {
                // Missing Permissions
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        errorEmbed(
                            'Missing Permissions',
                            'I do not have permission to delete messages in this channel.',
                        ),
                    ],
                });
            } else {
                // Unknown error — stop purging
                skippedCount += remaining;
            }
        }

        // ============================================
        // STEP 3: Report results
        // ============================================
        const resultEmbed = successEmbed(
            '🗑️ Purge Complete',
            [
                `**Requested:** ${requestedAmount}`,
                `**Deleted:** ${deletedCount}`,
                `**Skipped:** ${skippedCount}${skippedCount > 0 ? ' (older than 14 days or system messages)' : ''}`,
            ].join('\n'),
        );

        // Add a hint if many were skipped
        if (skippedCount > 0 && skippedCount === deletedCount + skippedCount) {
            resultEmbed.setDescription(
                resultEmbed.data?.description +
                    '\n\n⚠️ All remaining messages are too old for bulk deletion (>14 days).',
            );
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [resultEmbed],
            flags: isPrefix ? undefined : MessageFlags.Ephemeral,
        });

        // Auto-cleanup the reply after a few seconds
        if (!isPrefix) {
            setTimeout(() => interaction.deleteReply().catch(() => {}), 4000);
        }
    },
};
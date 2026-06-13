import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import AntiNukeService from '../../services/antinukeService.js';
import { pgDb } from '../../utils/postgresDatabase.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { handleInteractionError } from '../../utils/errorHandler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('security')
    .setDescription('External Defense Dashboard for Security Fortress modules')
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Displays the real-time status and configuration of the Security Fortress modules')
    )
    .addSubcommand((sub) =>
      sub
        .setName('setup-honeypot')
        .setDescription('Set the Ban Channel (Honeypot) — any user who types here is instantly banned')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('The channel to designate as the Honeypot Ban Channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    ),

  async execute(interaction, guildConfig, client) {
    await InteractionHelper.safeDefer(interaction);
    // Restrict to Server Owner or Administrator
    const guild = interaction.guild;
    if (!guild) {
      return await InteractionHelper.safeReply(interaction, { content: 'This command must be used inside a guild.', ephemeral: true });
    }

    const isOwner = interaction.user.id === guild.ownerId;
    const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
    if (!isOwner && !isAdmin) {
      return await InteractionHelper.safeReply(interaction, {
        content: '❌ You must be the server owner or have Administrator permissions to use this command.',
        ephemeral: true,
      });
    }

    await InteractionHelper.safeDefer(interaction, { ephemeral: false });

    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === 'setup-honeypot') {
        return await this._handleSetupHoneypot(interaction, guild);
      }
      // Default: status subcommand
      return await this._handleStatus(interaction, guild);
    } catch (err) {
      logger.error(`[Command Error] /security failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${err.message}`, { stack: err.stack, errorCode: err.code || 'UNKNOWN' });
      const reply = { content: '❌ An error occurred while executing the command. Please try again.' };
      if (interaction.deferred || interaction.replied) {
        return await InteractionHelper.safeEditReply(interaction, reply);
      }
      return await InteractionHelper.safeReply(interaction, { ...reply, ephemeral: true });
    }
  },

  async _handleStatus(interaction, guild) {
    const antiNuke = AntiNukeService.getInstance();
    const settings = antiNuke.getSettings(guild.id);
    const raidState = antiNuke.antiRaidCache?.get(guild.id) || null;

    // Determine dynamic embed color
    let embedColor = 0x3498db; // Blue (nominal)
    let statusEmoji = '🟢';
    let statusTitle = 'NOMINAL';

    if (raidState?.isRaidActive === true) {
      // Check if lockdown is active
      if (raidState.lockdownTimer === null && raidState.isRaidActive) {
        embedColor = 0xff0000; // Red (lockdown)
        statusEmoji = '🔒';
        statusTitle = 'LOCKDOWN ACTIVE';
      } else {
        embedColor = 0xff6600; // Orange (warning)
        statusEmoji = '⚠️';
        statusTitle = 'RAID WARNING ACTIVE';
      }
    }

    // Build honeypot field
    let honeypotStatus;
    if (settings?.honeypotChannelId) {
      honeypotStatus = `🟢 ACTIVE -> <#${settings.honeypotChannelId}>`;
    } else {
      honeypotStatus = '🔴 NOT CONFIGURED';
    }

    // Build webhook protection field
    const webhookStatus = '🟢 ACTIVE (2 messages / 5 seconds -> Strike 1: Warn, Strike 2: Auto-Delete Webhook)';

    // Build anti-raid field
    const thresholdDisplay = 'Trigger: ≥5 joins within 1 second';

    let raidStatus;
    if (raidState?.isRaidActive === true) {
      if (embedColor === 0xff0000) {
        raidStatus = '🔒 **LOCKDOWN ACTIVE** (All Server Invites Frozen, Verification Level Maxed)';
      } else {
        raidStatus = `⚠️ **RAID WARNING ACTIVE** (Accumulating accounts: **${raidState.raidPool.length}** in pool, awaiting Admin response / Failsafe)`;
      }
    } else {
      raidStatus = '🟢 NOMINAL (Monitoring borders)';
    }

    // Build general antinuke status
    let antinukeEnabled;
    if (settings?.isEnabled) {
      antinukeEnabled = `🟢 ENABLED (Limit: ${settings.limitCount} deletions / ${settings.timeWindow}s)`;
    } else {
      antinukeEnabled = '🔴 DISABLED';
    }

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('🛡️ SECURITY FORTRESS — DEFENSE DASHBOARD')
      .setDescription(
        `**System Status:** ${statusEmoji} ${statusTitle}\n` +
        `**Guild:** ${guild.name} \`${guild.id}\``
      )
      .addFields(
        {
          name: '🪤 Honeypot Trap System',
          value: honeypotStatus,
          inline: false,
        },
        {
          name: '⚡ Progressive Webhook Protection',
          value: webhookStatus,
          inline: false,
        },
        {
          name: '🚨 Anti-Raid State Machine',
          value: `${thresholdDisplay}\n${raidStatus}`,
          inline: false,
        },
        {
          name: '🛡️ Anti-Nuke Core',
          value: antinukeEnabled,
          inline: false,
        }
      )
      .setTimestamp()
      .setFooter({ text: `Requested by ${interaction.user.tag}` });

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
  },

  async _handleSetupHoneypot(interaction, guild) {
    const channel = interaction.options.getChannel('channel', true);
    const honeypotChannelId = channel.id;

    // Persist to database
    const antiNuke = AntiNukeService.getInstance();
    const settings = antiNuke.getSettings(guild.id);

    try {
      if (settings) {
        // Update existing settings
        await pgDb.pool.query(
          'UPDATE guild_settings SET honeypot_channel_id = $1 WHERE guild_id = $2',
          [honeypotChannelId, guild.id]
        );
        // Update cache
        settings.honeypotChannelId = honeypotChannelId;
      } else {
        // Create new settings row with honeypot_channel_id
        await pgDb.pool.query(
          `INSERT INTO guild_settings (guild_id, is_enabled, honeypot_channel_id)
           VALUES ($1, FALSE, $2)
           ON CONFLICT (guild_id) DO UPDATE SET honeypot_channel_id = $2`,
          [guild.id, honeypotChannelId]
        );
        // Reload cache
        await antiNuke.loadGuildCaches(guild.client);
      }

      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('🪤 Honeypot Trap Configured')
        .setDescription(
          `The Honeypot Trap has been successfully set to ${channel}.\n\n` +
          `⚠️ **Warning:** Any user who sends a message in ${channel} will be **instantly banned**.\n` +
          `The bot itself is immune. Be careful not to type in this channel yourself!`
        )
        .addFields(
          { name: 'Channel', value: `${channel} (${channel.id})`, inline: true },
          { name: 'Status', value: '🟢 Active', inline: true }
        )
        .setTimestamp();

      await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });

      // Log the setup to the log channel if configured
      if (settings?.logChannelId) {
        const logChannel = guild.channels.cache.get(settings.logChannelId)
          || (await guild.channels.fetch(settings.logChannelId).catch(() => null));
        if (logChannel?.isTextBased()) {
          await logChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle('🪤 Honeypot Trap Configured')
                .setDescription(`Honeypot trap set to ${channel} by ${interaction.user.tag}.`)
                .setTimestamp(),
            ],
          }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error(`[Command Error] /security failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${err.message}`, { stack: err.stack, errorCode: err.code || 'UNKNOWN' });
      await InteractionHelper.safeEditReply(interaction, {
        content: '❌ Failed to save the honeypot channel configuration. Please try again.',
      });
    }
  },
};
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { logModerationAction } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { StarlightError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const durationChoices = [
  { name: '10 seconds (10s)', value: '10s' },
  { name: '30 seconds (30s)', value: '30s' },
  { name: '1 minute (1m)', value: '1m' },
  { name: '5 minutes (5m)', value: '5m' },
  { name: '10 minutes (10m)', value: '10m' },
  { name: '30 minutes (30m)', value: '30m' },
  { name: '1 hour (1h)', value: '1h' },
  { name: '3 hours (3h)', value: '3h' },
  { name: '6 hours (6h)', value: '6h' },
  { name: '12 hours (12h)', value: '12h' },
  { name: '1 day (1d)', value: '1d' },
  { name: '3 days (3d)', value: '3d' },
  { name: '1 week (1w)', value: '1w' },
  { name: '2 weeks (2w)', value: '2w' },
  { name: '1 month (1M)', value: '1M' },
  { name: '1 year (1y)', value: '1y' },
];

function parseDurationToMsFromText(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (!s) return null;

  const durationMap = {
    s: 1000,
    second: 1000,
    seconds: 1000,

    m: 60 * 1000,
    minute: 60 * 1000,
    minutes: 60 * 1000,

    h: 60 * 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,

    d: 24 * 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,

    w: 7 * 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,

    M: 30 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,

    y: 365 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
    years: 365 * 24 * 60 * 60 * 1000,
  };

  // Accept patterns like: 10s, 1 second, 2 seconds, 5m, 1M, etc.
  const match = s.toLowerCase().match(/(\d+)\s*([a-z]+)/i);
  if (!match) return null;

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];

  const multiplier = durationMap[unit];
  if (!multiplier) return null;

  const ms = amount * multiplier;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function formatDurationDM(secondsTotal) {
  const total = Math.max(0, Math.floor(secondsTotal));

  const days = Math.floor(total / (60 * 60 * 24));
  const hours = Math.floor((total % (60 * 60 * 24)) / (60 * 60));
  const minutes = Math.floor((total % (60 * 60)) / 60);
  const seconds = total % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);

  return parts.join(' ');
}

export default {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout a user for a specific duration.')
    .addUserOption((option) =>
      option
        .setName('target')
        .setDescription('User to timeout')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('Timeout duration (e.g., 10s, 5m, 1h, 2d, 1w, 1M, 1y)')
        .setRequired(true)
        .addChoices(...durationChoices),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Reason for the timeout'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  category: 'moderation',

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`Timeout interaction defer failed`, {
        userId: interaction.user?.id,
        guildId: interaction.guildId,
        commandName: 'timeout',
      });
      return;
    }

    try {
      if (!interaction.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
        throw new StarlightError(
          'User lacks permission',
          ErrorTypes.PERMISSION,
          'You need the `Moderate Members` permission to set a timeout.',
        );
      }

      const targetUser = interaction.options.getUser('target');
      const member = interaction.options.getMember('target');

      let durationMs = null;
      const durationText = interaction.options.getString('duration');
      let reason = interaction.options.getString('reason') || 'No reason';

      // Prefix: both getString('duration') and getString('reason') return the same
      // concatenated text args from the adapter. Parse duration from the text and
      // strip it from the reason so reason never contains the duration token.
      if (interaction._isPrefix) {
        const rawText = String(reason).trim();
        const tokens = rawText.split(/\s+/);
        const firstToken = tokens[0];
        const parsedMs = parseDurationToMsFromText(firstToken);
        if (parsedMs) {
          durationMs = parsedMs;
          reason = tokens.slice(1).join(' ') || 'No reason';
        }
        // If first token is NOT a duration, leave reason as-is (it's just the reason)
      } else if (durationText) {
        // Slash: duration is a string choice
        durationMs = parseDurationToMsFromText(durationText);
      }

      if (!durationMs) {
        throw new StarlightError(
          'Missing/invalid duration',
          ErrorTypes.VALIDATION,
          'Please specify duration like 10s, 5m, 1h, 2d, 1w, 1M, 1y (and optional reason).',
        );
      }

      if (targetUser.id === interaction.user.id) {
        throw new StarlightError('Cannot timeout self', ErrorTypes.VALIDATION, 'You cannot timeout yourself.');
      }
      if (targetUser.id === client.user.id) {
        throw new StarlightError('Cannot timeout bot', ErrorTypes.VALIDATION, 'You cannot timeout the bot.');
      }
      if (!member) {
        throw new StarlightError(
          'Target not found',
          ErrorTypes.USER_INPUT,
          'The target user is not currently in this server.',
        );
      }
      if (!member.moderatable) {
        throw new StarlightError(
          'Cannot timeout member',
          ErrorTypes.PERMISSION,
          'I cannot timeout this user. They might have a higher role than me or you.',
        );
      }

      const MAX_DISCORD_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
      if (durationMs > MAX_DISCORD_TIMEOUT_MS) {
        const firstChunkMs = MAX_DISCORD_TIMEOUT_MS;
        const remainingMs = durationMs - firstChunkMs;

        await member.timeout(firstChunkMs, reason);

        // Persist pending remainder for resume
        if (!client.db || typeof client.db.isAvailable !== 'function' || !client.db.isAvailable()) {
          throw new StarlightError(
            'Database unavailable',
            ErrorTypes.DATABASE,
            'Cannot schedule long timeout because PostgreSQL is unavailable.',
          );
        }

        const resumeAt = new Date(Date.now() + firstChunkMs);

        const { pgDb } = await import('../../utils/postgresDatabase.js');
        const conn = await pgDb.pool.connect();
        try {
          await conn.query(
            `INSERT INTO pending_timeouts (guild_id, user_id, remaining_duration_ms, resume_at, reason, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [interaction.guild.id, targetUser.id, BigInt(remainingMs), resumeAt.toISOString(), reason],
          );
        } finally {
          conn.release();
        }
      } else {
        await member.timeout(durationMs, reason);
      }

      const durationSeconds = Math.floor(durationMs / 1000);
      const durationDisplay = formatDurationDM(durationSeconds);

      const caseId = await logModerationAction({
        client,
        guild: interaction.guild,
        event: {
          action: 'Member Timed Out',
          target: `${targetUser.tag} (${targetUser.id})`,
          executor: `${interaction.user.tag} (${interaction.user.id})`,
          reason: reason,
          duration: durationDisplay,
          metadata: {
            userId: targetUser.id,
            moderatorId: interaction.user.id,
            durationMs,
            durationSeconds,
            timeoutEnds: new Date(Date.now() + durationMs).toISOString(),
          },
        },
      });

      // Requirement: if prefix uses mute, show 'Muted', otherwise 'Timed out'.
      // Since /mute was removed from slash commands, we infer by `interaction.commandName === 'mute'` when running prefix.
      const isMutePrefix = interaction._isPrefix && interaction.commandName === 'mute';

      // DM the punished user (only on success). If DM fails, swallow error.
      try {
        const dmEmbed = successEmbed(
          isMutePrefix
            ? `You have been muted in **${interaction.guild.name}**`
            : `You have been timed out in **${interaction.guild.name}**`,
          `**Duration:** ${durationDisplay}\n**Reason:** ${reason}\n**Case ID:** #${caseId}`,
        );
        await targetUser.send({ embeds: [dmEmbed] });
      } catch {
        // intentionally ignore DM failures
      }

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            `⏳ **${isMutePrefix ? 'Muted' : 'Timed out'}** ${targetUser.tag} for ${durationDisplay}.`,
            `**Reason:** ${reason}\n**Case ID:** #${caseId}`,
          ),
        ],
      });
    } catch (error) {
      logger.error(`[Command Error] /timeout failed in Guild ${interaction.guildId} by User ${interaction.user.id}: ${error.message}`, { stack: error.stack, errorCode: error.code || 'UNKNOWN' });
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [errorEmbed(error.userMessage || 'An unexpected error occurred during the timeout action.')],
      });
    }
  },
};


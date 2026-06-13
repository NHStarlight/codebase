import { getTimeoutChunkMs, getTimeoutEndsISO } from '../utils/timeouts.js';
import { logger } from '../utils/logger.js';

import { pgDb } from '../utils/postgresDatabase.js';


const CHUNK_DUE_LIMIT = 50;

function toMsFromBigInt(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
}

async function claimDue(client, now) {
  // Claim: move pending->running for due jobs to avoid double-processing
  // Note: without SKIP LOCKED (depending on postgres/driver), we still rely on status update.
  const result = await client.query(
    `SELECT id, guild_id, user_id, remaining_duration_ms, resume_at, reason, status
     FROM pending_timeouts
     WHERE status = 'pending' AND resume_at <= $1
     ORDER BY resume_at ASC
     LIMIT ${CHUNK_DUE_LIMIT}
    `,
    [now]
  );

  const rows = result.rows || [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  // Mark claimed rows as running
  await client.query(
    `UPDATE pending_timeouts
     SET status = 'running', updated_at = NOW()
     WHERE id = ANY($1::bigint[]) AND status = 'pending'`,
    [ids]
  );

  return rows;
}

async function fetchMember(client, guildId, userId) {
  const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;

  const member = await guild.members.fetch(userId).catch(() => null);
  return member;
}

async function processOne(client, discordClient, job) {
  const {
    id,
    guild_id: guildId,
    user_id: userId,
    remaining_duration_ms: remainingMsRaw,
    reason,
  } = job;

  const remainingMs = toMsFromBigInt(remainingMsRaw);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    await client.query(`DELETE FROM pending_timeouts WHERE id = $1`, [id]);
    logger.warn('pendingTimeoutService: deleted invalid remaining ms job', { id, remainingMs });
    return;
  }

  const chunkMs = getTimeoutChunkMs(remainingMs);
  const member = await fetchMember(discordClient, guildId, userId);
  if (!member) {
    await client.query(`DELETE FROM pending_timeouts WHERE id = $1`, [id]);
    logger.warn('pendingTimeoutService: member not found, deleting job', { id, guildId, userId });
    return;
  }

  if (!member.moderatable) {
    await client.query(
      `UPDATE pending_timeouts SET status='failed', processed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [id]
    );
    logger.warn('pendingTimeoutService: member not moderatable, marking failed', { id, guildId, userId });
    return;
  }

  const endsISO = getTimeoutEndsISO(chunkMs);

  await member.timeout(chunkMs, reason);

  const newRemainingMs = remainingMs - chunkMs;

  if (newRemainingMs <= 0) {
    await client.query(`DELETE FROM pending_timeouts WHERE id = $1`, [id]);
    logger.info('pendingTimeoutService: completed pending timeout', {
      id,
      guildId,
      userId,
      chunkMs,
      endsISO,
    });
  } else {
    const nextResumeAt = new Date(Date.now() + chunkMs);
    await client.query(
      `UPDATE pending_timeouts
       SET remaining_duration_ms = $1, resume_at = $2, status = 'pending', processed_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [BigInt(newRemainingMs), nextResumeAt.toISOString(), id]
    );

    logger.info('pendingTimeoutService: rescheduled remaining pending timeout', {
      id,
      guildId,
      userId,
      chunkMs,
      newRemainingMs,
      nextResumeAt: nextResumeAt.toISOString(),
      endsISO,
    });
  }
}

export async function catchUpOnce(discordClient) {
  if (!pgDb?.pool) {
    logger.warn('pendingTimeoutService: pgDb.pool not available. Skipping catch-up.');
    return;
  }

  const client = await pgDb.pool.connect();
  try {
    const now = new Date().toISOString();

    let jobs = [];
    try {
      jobs = await claimDue(client, now);
    } catch (err) {
      // If migrations haven't been applied yet, pending_timeouts table won't exist.
      if (err?.code === '42P01') {
        logger.warn('pendingTimeoutService: pending_timeouts table not found; skipping catch-up until migrations are applied', {
          error: err?.message,
        });
        return;
      }
      throw err;
    }

    for (const job of jobs) {
      try {
        await processOne(client, discordClient, job);
      } catch (e) {
        logger.error('pendingTimeoutService: failed to process pending timeout job', { jobId: job.id, error: e });
        // Do not throw; continue others
        try {
          await client.query(
            `UPDATE pending_timeouts SET status='failed', processed_at=NOW(), updated_at=NOW() WHERE id=$1`,
            [job.id]
          );
        } catch {}
      }
    }
  } finally {
    client.release();
  }
}


export async function resumeDuePendingTimeouts(discordClient) {
  await catchUpOnce(discordClient);
}


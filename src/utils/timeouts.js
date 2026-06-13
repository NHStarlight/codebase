export const MAX_DISCORD_TIMEOUT_DAYS = 28;
export const MAX_DISCORD_TIMEOUT_MS = MAX_DISCORD_TIMEOUT_DAYS * 24 * 60 * 60 * 1000;

export function getTimeoutChunkMs(remainingMs) {
  const ms = Number(remainingMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_DISCORD_TIMEOUT_MS);
}

export function getTimeoutEndsISO(durationMs) {
  const endsAt = new Date(Date.now() + durationMs);
  return endsAt.toISOString();
}


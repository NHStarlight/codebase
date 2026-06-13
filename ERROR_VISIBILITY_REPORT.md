# 🔍 ERROR VISIBILITY REPORT

**Date:** 2026-06-13

---

## PROCESS-LEVEL HANDLERS (app.js lines 379-387)

| Handler | Status | Notes |
|---|---|---|
| `uncaughtException` | ✅ | Logs via `logger.error`, calls `bot.shutdown('UNCAUGHT_EXCEPTION')` |
| `unhandledRejection` | ✅ | Logs via `logger.error`, calls `bot.shutdown('UNHANDLED_REJECTION')` |
| `SIGTERM/SIGINT` | ✅ | Calls `bot.shutdown('SIGTERM')` / `bot.shutdown('SIGINT')` |

---

## COMMAND ERROR LOGGING

| Location | Pattern | Status |
|---|---|---|
| `interactionCreate.js` line 88 | `handleInteractionError(interaction, error, ...)` | ✅ All slash commands |
| `messageCreate.js` line 313 | `logger.error("Prefix command failed:...")` | ✅ All prefix commands |
| `ban.js` line 178 | `logger.error(...)` + `handleInteractionError(...)` | ✅ |
| `kick.js` line 124 | `logger.error(...)` then custom embed | ✅ |
| `timeout.js` line 272 | `logger.error(...)` + custom embed | ✅ |
| `warn.js` line 100 | `logger.error(...)` + `handleInteractionError(...)` | ✅ |
| `massban.js` line 218 | `logger.error(...)` + generic embed | ⚠️ Does NOT call `handleInteractionError` |
| `masskick.js` line 201 | `logger.error(...)` + generic embed | ⚠️ Does NOT call `handleInteractionError` |
| `quarantine.js` line 64 | `logger.error(...)` + generic reply | ✅ |
| `unquarantine.js` line 38 | `logger.error(...)` + generic reply | ✅ |
| `purge.js` (refactored) | `logger.warn(...)` with channel ID, error code handling | ✅ |

---

## DATABASE ERROR LOGGING

| Location | Status | Notes |
|---|---|---|
| `postgresDatabase.js` `_establishConnection()` | ✅ | Logs retry attempts, final failure |
| `database.js` `initializeDatabase()` | ✅ | Logs degraded mode warning |
| `database.js` `getFromDb()`/`setInDb()` | ✅ | Catch blocks log errors |
| `warningService.js` | ✅ | Each method has try/catch with logger.error |

---

## SECURITY ERROR LOGGING

| Location | Status | Notes |
|---|---|---|
| `antinukeService.js` `triggerPunishment()` | ✅ | Logs quarantine/restoration errors |
| `antinukeService.js` `_executeRaidAutoBan()` | ✅ | Logs per-user ban failures |
| `antinukeService.js` `logToChannel()` | ✅ | Logs to configured log channel |
| `messageCreate.js` honeypot | ✅ | `logger.warn` on trap errors |
| `messageCreate.js` blacklist links | ✅ | `logger.warn` on check errors |
| `messageCreate.js` webhook protection | ✅ | `logger.warn` on protection errors |
| `channelDelete.js` anti-nuke | ✅ | `logger.warn` on handler failure |
| `roleDelete.js` anti-nuke | ✅ | `logger.warn` on handler failure |

---

## SILENT FAILURES DETECTED

| Location | What is Silent | Severity |
|---|---|---|
| `ban.js` line 165 | DM send failure — `.catch(() => {})` | LOW — intentional |
| `kick.js` line 111 | DM send failure — `.catch(() => {})` | LOW |
| `timeout.js` line 259 | DM send failure — swallowed | LOW |
| `quarantine.js` line 59 | DM send failure — swallowed | LOW |
| `untimeout.js` line 50 | DM send failure — swallowed | LOW |
| `antinukeService.js` line 169 | Bot/owner executor bypass — no log | **HIGH** — security-relevant |
| `antinukeService.js` `logToChannel()` | Channel send failure `.catch(() => {})` | LOW |
| `commandLoader.js` line 63-64 | Invalid command — `logger.warn` but continues | ✅ adequate |
| `events/ready.js` line 27-28 | Anti-nuke cache load failure — `logger.warn` | ✅ adequate |

---

## HIDDEN EXCEPTIONS (wrapped catch blocks)

| Location | Pattern | Status |
|---|---|---|
| `app.js` `updateAllCounters()` | Try/catch per guild, `logger.error` | ✅ |
| `app.js` `registerCommands()` | Try/catch, `logger.error` | ✅ |
| `channelDelete.js` anti-nuke section | Try/catch, `logger.warn` | ✅ |
| `roleDelete.js` anti-nuke section | Try/catch, `logger.warn` | ✅ |
| `messageCreate.js` honeypot/blacklist/webhook | Try/catch, `logger.warn` | ✅ |

---

## SUMMARY

| Severity | Count | Details |
|---|---|---|
| HIGH | 1 | Anti-nuke bot/owner bypass has no logging |
| LOW | 5 | DM failures silently swallowed (acceptable UX choice) |
| Missing error handling | 2 | massban.js, masskick.js don't use centralized `handleInteractionError` |

**Overall: Good error visibility. One high-priority gap (anti-nuke silent bypass logging).**
# ⚡ PERFORMANCE HOTSPOT ANALYSIS

**Date:** 2026-06-13  
**Methodology:** Code review — identify repeated queries, large loops, excessive fetches, unbounded memory structures

---

## HOTSPOT RANKING

### 🔴 HIGH PRIORITY (Production Impact)

#### H1: Guild Config Read on EVERY Command
| Detail | Value |
|---|---|
| Location | `interactionCreate.js` line 63 → `guildConfig.js` → `database.js` |
| Frequency | Every slash command + every prefix command |
| Impact | 1 DB read per command invocation |
| Mitigation | Add LRU cache with 60s TTL → reduces by 99% |
| Priority Score | 8/10 |

#### H2: `updateAllCounters()` Iterates ALL Guilds
| Detail | Value |
|---|---|
| Location | `app.js` lines 250-283 |
| Frequency | Every 15 minutes (cron) |
| Impact | N guilds × N counter channels × fetch/update |
| 100-guild bot | ~100 DB reads every 15 min |
| 1000-guild bot | ~1000 DB reads every 15 min |
| Mitigation | Batch guild processing, skip guilds with no counters |
| Priority Score | 7/10 |

### 🟡 MEDIUM PRIORITY (Growth Impact)

#### M1: `generateCaseId()` — Read-Modify-Write Per Action
| Detail | Value |
|---|---|
| Location | `utils/moderation.js` lines 111-122 |
| Frequency | Every ban/kick/timeout/warn |
| Impact | 2 DB operations (get + set) per action |
| Risk | Race condition on duplicate IDs |
| Mitigation | Use `db.increment()` (atomic single operation) |
| Priority Score | 6/10 |

#### M2: Unbounded In-Memory Maps
| Detail | Value |
|---|---|
| `deletionTracker` | Per-user-per-guild entries, pruned only on access |
| `webhookTracker` | Per-webhook-per-guild entries |
| `rateLimitStore` | Per-key entries, no periodic cleanup |
| `blockedAttemptStore` | Per-key entries, no periodic cleanup |
| `antiRaidCache` | One entry per active raid |
| Risk | Memory growth over weeks if not pruned |
| Mitigation | Add `setInterval` cleanup every 10 min for stale entries |
| Priority Score | 6/10 |

#### M3: Case System Double Storage
| Detail | Value |
|---|---|
| Location | `utils/moderation.js` `storeModerationCase()` |
| Pattern | Writes to individual key + appends to list key |
| Impact | 2 DB writes per case → grows without bound on individual keys |
| Mitigation | Only store in list; cap at 1000 (already done) |
| Priority Score | 5/10 |

### 🟢 LOW PRIORITY (Optimization)

#### L1: `getGuildConfig()` Called in `logEvent()` Too
| Detail | Value |
|---|---|
| Location | `utils/moderation.js` line 16 |
| Impact | Already covered by H1 caching fix |
| Priority Score | 3/10 |

#### L2: Prefix Command Creates FakeInteraction Object Per Invocation
| Detail | Value |
|---|---|
| Location | `utils/prefixCommandAdapter.js` |
| Impact | ~100 object allocations per prefix command (negligible) |
| Priority Score | 2/10 |

#### L3: Help Menu Reads Filesystem Every Time
| Detail | Value |
|---|---|
| Location | `utils/helpMenuHelper.js` `getCategoryFolders()` |
| Pattern | `fs.readdir()` on every help invocation |
| Impact | 1 fs call per `/help` — negligible for low-traffic |
| Mitigation | Cache category list in memory (only changes on deploy) |
| Priority Score | 2/10 |

---

## COMMAND PERFORMANCE PROFILES

| Command | DB Reads | DB Writes | Fetch Calls | Complexity |
|---|---|---|---|---|
| `/ban` | 2 (config + case counter) | 2 (case + list) | 0-1 (member fetch) | O(1) |
| `/kick` | 2 | 2 | 0 | O(1) |
| `/timeout` | 2 | 2 (+1 if >28d) | 0 | O(1) |
| `/warn` | 2 | 2 (warnings + moderation) | 0 | O(1) |
| `/massban` | 2 + N per user | 2 + N per user | N | O(N) |
| `/purge` | 0 | 0 | N/100 batches | O(N) |
| `/cases` | 1 | 0 | 0 | O(N) |
| `/help` | 1 | 0 | 1 (fs) | O(C) |
| `/antinuke status` | 1 | 0 | 0 | O(1) |

---

## ESTIMATED IMPACT

| Hotspot | Before Fix | After Fix | Savings |
|---|---|---|---|
| H1 (config cache) | 1 DB read/cmd | 0 DB read (cache hit) | ~99% DB reads |
| H2 (counter loop) | N guilds × C counters × 15min | Skip idle guilds | ~50-80% work |
| M1 (case ID) | 2 DB ops | 1 DB op | 50% DB ops |
| M2 (memory maps) | Unbounded | Bounded + periodic cleanup | Prevents OOM |

---

## VERDICT

**No performance blockers found.** The codebase is efficient for small-to-medium bot deployments (<500 guilds). For larger scale, the guild config caching (H1) and counter loop optimization (H2) should be addressed first. Memory pruning (M2) should be added before long-running production deployment.
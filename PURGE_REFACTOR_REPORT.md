# 🗑️ PURGE COMMAND REFACTOR REPORT

**Command:** `/purge` / `nh!purge`  
**File:** `src/commands/Moderation/purge.js`  
**Date:** 2026-06-13

---

## PREVIOUS IMPLEMENTATION (Before Refactor)

### Approach
Used `fetch({ limit: batchSize + 1 })` + `.slice(1)` to exclude the command message from each batch.

### Bugs

| Bug | Description |
|---|---|
| **B1: `purge 100` crash** | `fetch({ limit: 101 })` then `.slice(1)` → tries `bulkDelete(100 messages)` which is at Discord's limit. But the `+1` on each batch wasted a fetch slot. |
| **B2: Message skipping on batch 2+** | `.slice(1)` was applied on EVERY batch, not just the first. This skipped 1 legitimate message per batch beyond the first. |
| **B3: Hard-coded limit of 500** | `if (amount > 500) amount = 500` — no support for `purge 1000` or larger. |
| **B4: No 14-day awareness** | No check for message age. `bulkDelete` would fail on messages >14 days old, causing the entire batch to fail. |
| **B5: No rate-limit handling** | No delay between batches. Under heavy purge (500+), could hit Discord rate limits. |
| **B6: Generic error message** | Error catch block returned "Failed to delete messages. (Older than 14 days or system messages.)" with no details on how many were actually deleted. |

### Old Code Structure (83 lines)
```
1. Defer interaction
2. Clamp amount to 1–500
3. Loop: fetch({ limit: batchSize + 1 }) → slice(1) → bulkDelete
4. Reply with deleted count
5. Catch: generic error
```

---

## NEW IMPLEMENTATION (After Refactor)

### Architecture

```
┌─────────────────────────────────────────────┐
│  Step 1: Delete command message (prefix)    │
│  Step 2: Purge in batches                   │
│    ┌─────────────────────────────────────┐  │
│    │ While remaining > 0:                │  │
│    │   fetch(up to 100 messages)         │  │
│    │   classify by age (14-day check)    │  │
│    │   if all >14d → delete individually │  │
│    │            → skip remaining, break  │  │
│    │   else → bulkDelete(<14d messages)  │  │
│    │        → skip >14d messages         │  │
│    │   delay 500ms between batches       │  │
│    └─────────────────────────────────────┘  │
│  Step 3: Report Requested/Deleted/Skipped   │
└─────────────────────────────────────────────┘
```

### Key Changes

#### 1. Command Message Deletion (Separated)
```javascript
// OLD: Mixed into purge loop via +1/.slice(1)
const fetched = await channel.messages.fetch({ limit: batchSize + 1 });
const messagesToDelete = Array.from(fetched.values()).slice(1);

// NEW: Deleted separately before purge begins
await deleteCommandMessage(interaction);
```
`deleteCommandMessage()` fetches the most recent message, verifies it belongs to the command author, and deletes it. This runs exactly once, for prefix commands only. Slash commands have no channel message to delete.

#### 2. No Artificial Limit
```javascript
// OLD
if (amount > 500) amount = 500;

// NEW
// No clamping. The while loop processes all requested messages
// until channel is empty or all remaining messages are >14 days.
```
`purge 5000` will run ~50 batches of 100 messages each.

#### 3. Batch Strategy
```javascript
while (remaining > 0) {
    const batchSize = Math.min(remaining, 100);
    const fetchOptions = { limit: batchSize };
    if (lastMessageId) fetchOptions.before = lastMessageId;
    const fetched = await channel.messages.fetch(fetchOptions);
    // ... process and advance cursor
    lastMessageId = messages[messages.length - 1].id;
}
```
Uses Discord's `before` parameter for pagination — guarantees no duplicate deletions. Each batch fetches exactly `min(remaining, 100)` messages (no offset/slice tricks).

#### 4. 14-Day Optimization
```javascript
for (const msg of messages) {
    if (isTooOldForBulkDelete(msg)) {
        tooOldMessages.push(msg);
    } else {
        bulkDeletable.push(msg);
        allTooOld = false;
    }
}

if (allTooOld) {
    // Delete individually, then STOP
    // All remaining messages are guaranteed older
    skippedCount += remaining;
    break;
}
```
**Efficiency guarantee:** Since messages are fetched newest-to-oldest, if the ENTIRE batch (including the newest message in that batch) is >14 days old, ALL remaining messages are also >14 days old. The loop stops immediately, avoiding thousands of unnecessary API calls.

For old messages in a mixed batch (some <14d, some >14d), the too-old ones are individually deleted or counted as skipped.

#### 5. Rate Limit Safety
```javascript
// 500ms delay between batches
if (remaining > 0 && messages.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
}

// Bulk delete failure → fallback to individual deletes
try {
    await channel.bulkDelete(bulkDeletable, true);
} catch (bulkErr) {
    for (const msg of bulkDeletable) {
        await deleteOne(msg);
    }
}
```

#### 6. Result Reporting
```javascript
// Response format:
🗑️ Purge Complete
Requested: 5000
Deleted: 1374
Skipped: 3626 (older than 14 days or system messages)
```
Clear breakdown showing exactly what happened. Includes explanatory note when messages were skipped.

---

## CODE QUALITY VERIFICATION

| Requirement | Status | Explanation |
|---|---|---|
| No infinite loops | ✅ | `remaining` decrements each iteration; `messages.length === 0` breaks |
| No duplicate deletions | ✅ | `before: lastMessageId` cursor prevents re-fetching |
| No unnecessary fetches | ✅ | Batch size = min(remaining, 100); stops on empty/too-old |
| No memory leaks | ✅ | Variables scoped to loop iteration; no global accumulation |
| Channel unavailable | ✅ | Error code 50001 handled gracefully |
| Missing permissions | ✅ | Error code 50013 returns early with clear message |
| Backward compatible | ✅ | Same command signature, same slash command definition |
| Prefix + slash support | ✅ | Both modes handled independently |

---

## TEST SCENARIOS

### Scenario 1: `purge 100` (previously broken)
| Step | Expected |
|---|---|
| deleteCommandMessage() | Deletes prefix command message |
| Batch 1: fetch 100 | Gets 100 messages |
| All messages <14d | bulkDelete(100) → deletes 100 |
| remaining = 0 | Loop ends |
| **Result** | Requested: 100, Deleted: 100, Skipped: 0 |

### Scenario 2: `purge 250`
| Step | Expected |
|---|---|
| Batch 1: fetch 100 → bulkDelete(100) | Deleted: 100 |
| Batch 2: fetch 100 → bulkDelete(100) | Deleted: 200 |
| Batch 3: fetch 50 → bulkDelete(50) | Deleted: 250 |
| **Result** | Requested: 250, Deleted: 250, Skipped: 0 |

### Scenario 3: `purge 5000` with mixed-age messages
| Step | Expected |
|---|---|
| Batches 1-8: all messages <14d | Deleted: 800 |
| Batch 9: some messages <14d, some >14d | Deleted: 60 (bulk), Skipped: 40 |
| Batch 10: all messages >14d | Skipped: 100, loop breaks |
| **Result** | Requested: 5000, Deleted: 860, Skipped: 4140 |

### Scenario 4: `purge 100` in channel with <100 messages
| Step | Expected |
|---|---|
| Batch 1: fetch 100 → gets 43 messages | bulkDelete(43) |
| messages.length === 0 → break | |
| **Result** | Requested: 100, Deleted: 43, Skipped: 0 (no more messages) |

### Scenario 5: Prefix `nh!purge 10`
| Step | Expected |
|---|---|
| deleteCommandMessage() | Fetches most recent, confirms author, deletes |
| Batch 1: fetch 10 → bulkDelete(10) | Deletes 10 prior messages |
| **Result** | Requested: 10, Deleted: 10, Skipped: 0 |

### Scenario 6: Channel deleted mid-purge
| Step | Expected |
|---|---|
| During batch processing | Discord error code 50001 |
| Catch block | skippedCount += remaining |
| **Result** | Shows partial deletion count + remaining skipped |

---

## CHANGES SUMMARY

| Aspect | Old | New |
|---|---|---|
| Lines of code | 83 | 220 |
| Max purge amount | 500 (hardcoded) | Unlimited (until channel empty or >14d) |
| Command message handling | `+1` / `.slice(1)` workaround | Dedicated `deleteCommandMessage()` |
| 14-day awareness | None | Age check on every message with early-stop optimization |
| Rate limiting | None | 500ms batch delay + bulk delete fallback |
| Result detail | "Successfully deleted X" | "Requested / Deleted / Skipped" breakdown |
| Error handling | Generic message | Specific by error code (50001, 50013) |
| Batch strategy | `fetch(batchSize+1)` → `.slice(1)` | `fetch(batchSize)` → cursor pagination |
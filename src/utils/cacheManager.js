/**
 * Cache Manager with TTL support and Lock mechanism
 * 
 * Provides:
 * - TTLMap: Auto-expiring Map with configurable TTL
 * - LockManager: Per-key mutex to prevent race conditions
 * - cleanupInterval: Global cleanup running every 3600s
 */

import { logger } from './logger.js';

// =====================
// TTLMap - Time-To-Live Map
// =====================
export class TTLMap {
  /**
   * @param {number} defaultTTLMs - Default TTL in milliseconds (default: 1 hour)
   * @param {number} maxSize - Maximum number of entries (default: 10000)
   */
  constructor(defaultTTLMs = 3600000, maxSize = 10000) {
    /** @type {Map<string, {value: any, expiresAt: number}>} */
    this._map = new Map();
    this._defaultTTLMs = defaultTTLMs;
    this._maxSize = maxSize;
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /**
   * Set a key with optional custom TTL
   * @param {string} key
   * @param {*} value
   * @param {number} [ttlMs] - Custom TTL in ms, uses default if omitted
   */
  set(key, value, ttlMs = null) {
    const ttl = ttlMs !== null ? ttlMs : this._defaultTTLMs;
    const expiresAt = Date.now() + ttl;

    // If full, evict oldest expired entry or oldest entry
    if (this._map.size >= this._maxSize) {
      this._evictOne();
    }

    this._map.set(key, { value, expiresAt });
    return this;
  }

  /**
   * Get a value. Returns undefined if expired or not found.
   * @param {string} key
   * @returns {*|undefined}
   */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this._map.delete(key);
      this._misses++;
      this._evictions++;
      return undefined;
    }

    this._hits++;
    return entry.value;
  }

  /**
   * Check if key exists and is not expired
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    const entry = this._map.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this._map.delete(key);
      this._evictions++;
      return false;
    }
    return true;
  }

  /**
   * Delete a key
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    return this._map.delete(key);
  }

  /**
   * Clear all entries
   */
  clear() {
    this._map.clear();
  }

  /**
   * Get the number of non-expired entries
   * @returns {number}
   */
  get size() {
    this._purgeExpired();
    return this._map.size;
  }

  /**
   * Get all keys (excluding expired)
   * @returns {Iterator<string>}
   */
  keys() {
    this._purgeExpired();
    return this._map.keys();
  }

  /**
   * Get all entries (excluding expired)
   * @returns {Iterator<[string, *]>}
   */
  entries() {
    this._purgeExpired();
    const entries = [];
    for (const [key, entry] of this._map.entries()) {
      if (Date.now() <= entry.expiresAt) {
        entries.push([key, entry.value]);
      }
    }
    return entries[Symbol.iterator]();
  }

  /**
   * Iterate over non-expired entries
   * @param {Function} callback
   */
  forEach(callback) {
    this._purgeExpired();
    for (const [key, entry] of this._map.entries()) {
      if (Date.now() <= entry.expiresAt) {
        callback(entry.value, key, this);
      }
    }
  }

  /**
   * Get stats for monitoring
   * @returns {Object}
   */
  getStats() {
    this._purgeExpired();
    return {
      size: this._map.size,
      maxSize: this._maxSize,
      defaultTTLMs: this._defaultTTLMs,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      hitRate: this._hits + this._misses > 0
        ? (this._hits / (this._hits + this._misses)).toFixed(4)
        : 0,
    };
  }

  /**
   * Remove expired entries
   */
  _purgeExpired() {
    const now = Date.now();
    for (const [key, entry] of this._map.entries()) {
      if (now > entry.expiresAt) {
        this._map.delete(key);
        this._evictions++;
      }
    }
  }

  /**
   * Evict a single entry when full
   */
  _evictOne() {
    // Try to find an expired entry first
    const now = Date.now();
    for (const [key, entry] of this._map.entries()) {
      if (now > entry.expiresAt) {
        this._map.delete(key);
        this._evictions++;
        return;
      }
    }
    // Otherwise evict the oldest entry
    const firstKey = this._map.keys().next().value;
    if (firstKey) {
      this._map.delete(firstKey);
      this._evictions++;
    }
  }

  /**
   * Cleanup all expired entries and return count removed
   * @returns {number}
   */
  cleanup() {
    const before = this._map.size;
    this._purgeExpired();
    return before - this._map.size;
  }
}

// =====================
// LockManager - Per-key mutex
// =====================
export class LockManager {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this._locks = new Map();
  }

  /**
   * Acquire a lock for a key.
   * Returns a promise that resolves when the lock is acquired.
   * The caller must await the returned release function.
   *
   * @param {string} key
   * @param {number} [timeoutMs=30000] - Max wait time before throwing
   * @returns {Promise<Function>} Release function
   */
  async acquire(key, timeoutMs = 30000) {
    while (this._locks.has(key)) {
      const existingLock = this._locks.get(key);
      if (!existingLock) break;

      const acquired = await Promise.race([
        existingLock,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Lock timeout for key: ${key}`)), timeoutMs)
        ),
      ]).catch(() => null);

      if (acquired === null) {
        // Timeout - force release old lock
        this._locks.delete(key);
        break;
      }
    }

    let release;
    const lockPromise = new Promise((resolve) => {
      release = resolve;
    });

    this._locks.set(key, lockPromise);

    return () => {
      if (this._locks.get(key) === lockPromise) {
        this._locks.delete(key);
      }
      release();
    };
  }

  /**
   * Execute a function with a lock held.
   * Automatically releases the lock after the function completes.
   *
   * @param {string} key
   * @param {Function} fn - Async function to execute
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<*>} Result of fn
   */
  async runExclusive(key, fn, timeoutMs = 30000) {
    const release = await this.acquire(key, timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Check if a key is currently locked
   * @param {string} key
   * @returns {boolean}
   */
  isLocked(key) {
    return this._locks.has(key);
  }

  /**
   * Get number of active locks
   * @returns {number}
   */
  get lockCount() {
    return this._locks.size;
  }
}

// =====================
// Global Cleanup Interval
// =====================

/** @type {Map<string, {map: TTLMap|Map, name: string, cleanupFn: Function}>} */
const registeredCaches = new Map();

/** @type {Map<string, {map: Map, name: string, ttlMs: number}>} */
const registeredMemoryMaps = new Map();

/** @type {NodeJS.Timeout|null} */
let cleanupTimer = null;

/**
 * Register a TTLMap or regular Map for periodic cleanup
 * @param {string} name - Identifier for logging
 * @param {TTLMap|Map} map - The map to clean
 * @param {Function} [cleanupFn] - Custom cleanup function (for regular Maps)
 */
export function registerCache(name, map, cleanupFn = null) {
  if (map instanceof TTLMap) {
    registeredCaches.set(name, { map, name, cleanupFn: () => map.cleanup() });
  } else if (cleanupFn) {
    registeredCaches.set(name, { map, name, cleanupFn });
  }
  logger.debug(`[CacheManager] Registered cache: ${name}`);
}

/**
 * Unregister a cache
 * @param {string} name
 */
export function unregisterCache(name) {
  registeredCaches.delete(name);
}

/**
 * Start the global cleanup interval
 * @param {number} intervalMs - Interval in ms (default: 3600000 = 1 hour)
 */
export function startCleanupInterval(intervalMs = 3600000) {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }

  cleanupTimer = setInterval(() => {
    let totalCleaned = 0;
    const now = Date.now();

    for (const [name, cache] of registeredCaches.entries()) {
      try {
        const cleaned = cache.cleanupFn();
        totalCleaned += typeof cleaned === 'number' ? cleaned : 0;
        logger.debug(`[CacheManager] Cleaned ${name}: removed ${cleaned} entries`);
      } catch (err) {
        logger.error(`[CacheManager] Error cleaning cache ${name}:`, err);
      }
    }

    // Also clean registered memory maps (timed entries)
    for (const [name, entry] of registeredMemoryMaps.entries()) {
      try {
        let removed = 0;
        for (const [key, value] of entry.map.entries()) {
          if (value && typeof value === 'object' && value._timestamp) {
            if (now - value._timestamp > entry.ttlMs) {
              entry.map.delete(key);
              removed++;
            }
          }
        }
        totalCleaned += removed;
        if (removed > 0) {
          logger.debug(`[CacheManager] Memory cleanup ${name}: removed ${removed} entries`);
        }
      } catch (err) {
        logger.error(`[CacheManager] Error cleaning memory map ${name}:`, err);
      }
    }

    if (totalCleaned > 0) {
      logger.info(`[CacheManager] Global cleanup: removed ${totalCleaned} total entries`);
    }
  }, intervalMs);

  logger.info(`[CacheManager] Cleanup interval started: every ${intervalMs / 1000}s`);
}

/**
 * Stop the global cleanup interval
 */
export function stopCleanupInterval() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    logger.info('[CacheManager] Cleanup interval stopped');
  }
}

/**
 * Register a regular Map with timestamp-based entries for cleanup
 * @param {string} name
 * @param {Map} map
 * @param {number} ttlMs
 */
export function registerMemoryMap(name, map, ttlMs = 3600000) {
  registeredMemoryMaps.set(name, { map, name, ttlMs });
  logger.debug(`[CacheManager] Registered memory map: ${name} (TTL: ${ttlMs}ms)`);
}

/**
 * Get cleanup statistics
 * @returns {Object}
 */
export function getCacheStats() {
  const stats = {};
  for (const [name, cache] of registeredCaches.entries()) {
    if (cache.map instanceof TTLMap) {
      stats[name] = cache.map.getStats();
    } else {
      stats[name] = { size: cache.map.size };
    }
  }
  for (const [name, entry] of registeredMemoryMaps.entries()) {
    stats[name] = { size: entry.map.size, ttlMs: entry.ttlMs };
  }
  return stats;
}

/**
 * Get current memory usage estimate
 * @returns {Object}
 */
export function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100,
    rssMB: Math.round(usage.rss / 1024 / 1024 * 100) / 100,
    externalMB: Math.round(usage.external / 1024 / 1024 * 100) / 100,
    registeredCaches: registeredCaches.size,
    registeredMemoryMaps: registeredMemoryMaps.size,
  };
}

export default {
  TTLMap,
  LockManager,
  registerCache,
  unregisterCache,
  startCleanupInterval,
  stopCleanupInterval,
  registerMemoryMap,
  getCacheStats,
  getMemoryUsage,
};
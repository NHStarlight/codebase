/**
 * Memory Manager - Global Memory Cleanup Utility
 * 
 * Central registry for managing in-memory caches across all services.
 * Provides:
 * - Map tracking and automatic cleanup
 * - Memory usage monitoring
 * - Global garbage collection triggers
 * - Integration with cacheManager's TTLMap
 */

import { logger } from './logger.js';
import { registerCache, registerMemoryMap } from './cacheManager.js';

class MemoryManager {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;

    /** @type {Map<string, {map: Map, name: string, maxSize: number}>} */
    this._trackedMaps = new Map();

    /** @type {Map<string, {client: Object, name: string, cleanupFn: Function}>} */
    this._registeredServices = new Map();

    /** @type {NodeJS.Timeout|null} */
    this._memoryCheckTimer = null;

    /** @type {number} */
    this._checkIntervalMs = 300000; // 5 minutes
  }

  /**
   * Get the singleton instance
   * @returns {MemoryManager}
   */
  static getInstance() {
    if (!MemoryManager._instance) {
      MemoryManager._instance = new MemoryManager();
    }
    return MemoryManager._instance;
  }

  /**
   * Initialize the memory manager
   * @param {Object} options
   * @param {number} [options.cleanupIntervalMs=3600000] - Global cleanup interval (default: 1 hour)
   * @param {number} [options.memoryThresholdMB=500] - Memory threshold in MB before forced cleanup
   * @param {number} [options.maxMapSize=50000] - Default max size for tracked maps
   */
  initialize(options = {}) {
    if (this._initialized) return;

    const {
      cleanupIntervalMs = 3600000,
      memoryThresholdMB = 500,
      maxMapSize = 50000,
    } = options;

    this._maxMapSize = maxMapSize;
    this._memoryThresholdMB = memoryThresholdMB;

    // Start periodic memory monitoring
    this._startMemoryMonitoring();

    this._initialized = true;
    logger.info('[MemoryManager] Initialized. Threshold: ' + memoryThresholdMB + 'MB, Cleanup interval: ' + (cleanupIntervalMs / 1000) + 's');
  }

  /**
   * Track a Map for memory management
   * @param {string} name - Identifier for the map
   * @param {Map} map - The Map instance to track
   * @param {Object} [options]
   * @param {number} [options.maxSize] - Max entries before warning
   * @param {number} [options.ttlMs] - TTL in ms (uses registerMemoryMap if provided)
   */
  trackMap(name, map, options = {}) {
    const { maxSize = this._maxMapSize, ttlMs = null } = options;

    if (this._trackedMaps.has(name)) {
      logger.warn(`[MemoryManager] Map "${name}" already tracked, skipping`);
      return;
    }

    this._trackedMaps.set(name, { map, name, maxSize });

    // Register with global cleanup if TTL provided
    if (ttlMs) {
      registerMemoryMap(name, map, ttlMs);
    }

    logger.debug(`[MemoryManager] Tracking map: ${name} (maxSize: ${maxSize}${ttlMs ? ', TTL: ' + ttlMs + 'ms' : ''})`);
  }

  /**
   * Untrack a Map
   * @param {string} name
   */
  untrackMap(name) {
    this._trackedMaps.delete(name);
  }

  /**
   * Register a service for periodic cleanup
   * @param {string} name
   * @param {Object} service
   * @param {Function} cleanupFn
   */
  registerService(name, service, cleanupFn) {
    if (this._registeredServices.has(name)) {
      logger.warn(`[MemoryManager] Service "${name}" already registered, skipping`);
      return;
    }

    this._registeredServices.set(name, { service, name, cleanupFn });
    logger.debug(`[MemoryManager] Registered service for cleanup: ${name}`);
  }

  /**
   * Unregister a service
   * @param {string} name
   */
  unregisterService(name) {
    this._registeredServices.delete(name);
  }

  /**
   * Force cleanup on all tracked maps and registered services
   * @returns {Object} Cleanup stats
   */
  forceCleanup() {
    const stats = { mapsCleaned: 0, servicesCalled: 0, entriesRemoved: 0 };

    // Clean tracked maps that exceed maxSize
    for (const [name, entry] of this._trackedMaps.entries()) {
      try {
        const size = entry.map.size;
        if (size > entry.maxSize) {
          const excess = size - entry.maxSize;
          // Remove oldest entries (first insertion order)
          const keysToDelete = [];
          for (const key of entry.map.keys()) {
            if (keysToDelete.length >= excess) break;
            keysToDelete.push(key);
          }
          for (const key of keysToDelete) {
            entry.map.delete(key);
          }
          stats.entriesRemoved += keysToDelete.length;
          logger.warn(`[MemoryManager] Forced cleanup on "${name}": removed ${keysToDelete.length} entries (size: ${size} -> ${entry.map.size})`);
        }
        stats.mapsCleaned++;
      } catch (err) {
        logger.error(`[MemoryManager] Error cleaning map "${name}":`, err);
      }
    }

    // Call registered service cleanup functions
    for (const [name, entry] of this._registeredServices.entries()) {
      try {
        entry.cleanupFn();
        stats.servicesCalled++;
      } catch (err) {
        logger.error(`[MemoryManager] Error calling service cleanup "${name}":`, err);
      }
    }

    if (stats.entriesRemoved > 0 || stats.servicesCalled > 0) {
      logger.info(`[MemoryManager] Force cleanup complete: ${stats.entriesRemoved} entries removed, ${stats.servicesCalled} services called`);
    }

    return stats;
  }

  /**
   * Get memory usage statistics
   * @returns {Object}
   */
  getMemoryStats() {
    const usage = process.memoryUsage();
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100;
    const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100;
    const rssMB = Math.round(usage.rss / 1024 / 1024 * 100) / 100;

    const mapStats = {};
    for (const [name, entry] of this._trackedMaps.entries()) {
      mapStats[name] = {
        size: entry.map.size,
        maxSize: entry.maxSize,
        utilization: entry.maxSize > 0 ? Math.round((entry.map.size / entry.maxSize) * 10000) / 100 + '%' : 'N/A',
      };
    }

    const serviceStats = {};
    for (const [name] of this._registeredServices.entries()) {
      serviceStats[name] = { registered: true };
    }

    return {
      heapUsedMB,
      heapTotalMB,
      rssMB,
      usagePercent: heapTotalMB > 0 ? Math.round((heapUsedMB / heapTotalMB) * 10000) / 100 : 0,
      trackedMaps: mapStats,
      registeredServices: serviceStats,
      thresholdMB: this._memoryThresholdMB,
      isOverThreshold: heapUsedMB > this._memoryThresholdMB,
    };
  }

  /**
   * Start periodic memory monitoring
   */
  _startMemoryMonitoring() {
    if (this._memoryCheckTimer) {
      clearInterval(this._memoryCheckTimer);
    }

    this._memoryCheckTimer = setInterval(() => {
      try {
        const stats = this.getMemoryStats();

        // Log memory stats periodically
        logger.debug(`[MemoryManager] Memory: ${stats.heapUsedMB}MB / ${stats.heapTotalMB}MB (${stats.usagePercent}%)`);

        // Force cleanup if over threshold
        if (stats.isOverThreshold) {
          logger.warn(`[MemoryManager] Memory threshold exceeded (${stats.heapUsedMB}MB > ${this._memoryThresholdMB}MB). Running forced cleanup...`);
          const cleanupStats = this.forceCleanup();

          // Suggest GC if available
          if (global.gc) {
            logger.info('[MemoryManager] Running global.gc()...');
            try {
              global.gc();
              const afterGC = process.memoryUsage();
              logger.info(`[MemoryManager] GC complete. Heap: ${Math.round(afterGC.heapUsed / 1024 / 1024 * 100) / 100}MB`);
            } catch (gcErr) {
              logger.warn('[MemoryManager] GC failed:', gcErr.message);
            }
          } else {
            logger.info('[MemoryManager] global.gc() not available. Run with --expose-gc flag for better cleanup.');
          }
        }
      } catch (err) {
        logger.error('[MemoryManager] Error in memory monitoring:', err);
      }
    }, this._checkIntervalMs);

    if (this._memoryCheckTimer && typeof this._memoryCheckTimer.unref === 'function') {
      this._memoryCheckTimer.unref();
    }

    logger.info(`[MemoryManager] Memory monitoring started (every ${this._checkIntervalMs / 1000}s)`);
  }

  /**
   * Stop memory monitoring
   */
  stop() {
    if (this._memoryCheckTimer) {
      clearInterval(this._memoryCheckTimer);
      this._memoryCheckTimer = null;
    }
    this._initialized = false;
    logger.info('[MemoryManager] Stopped');
  }
}

/** @type {MemoryManager} */
MemoryManager._instance = null;

export default MemoryManager;
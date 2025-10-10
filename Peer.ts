import { join as joinPosix } from "@std/path/posix";
import type { FileInfo } from "./lib/src/API/DirectFileManipulatorV2.ts";

import { FilePathWithPrefix, LOG_LEVEL, LOG_LEVEL_DEBUG, LOG_LEVEL_INFO } from "./lib/src/common/types.ts";
import { PeerConf, FileData } from "./types.ts";
import { Logger } from "octagonal-wheels/common/logger.js";
import { LRUCache } from "octagonal-wheels/memory/LRUCache.js"
import { computeHash } from "./util.ts";

export type DispatchFun = (source: Peer, path: string, data: FileData | false) => Promise<void>;

export abstract class Peer {
    config: PeerConf;
    // hub: Hub;
    dispatchToHub: DispatchFun;
    constructor(conf: PeerConf, dispatcher: DispatchFun) {
        this.config = conf;
        this.dispatchToHub = dispatcher;
    }
    toLocalPath(path: string) {
        const relativeJoined = joinPosix(this.config.baseDir, path);
        const relative = relativeJoined == "." ? "" : relativeJoined;
        const ret = (relative.startsWith("_")) ? ("/" + relative) : relative;
        // this.debugLog(`**TOLOCAL: ${path} => ${ret}`);
        return ret;
    }
    toGlobalPath(pathSrc: string) {
        const path = pathSrc.startsWith("_") ? pathSrc.substring(1) : pathSrc;
        
        // Normalize the baseDir to handle different path formats
        let normalizedBaseDir = this.config.baseDir.replace(/\\/g, '/');
        // Remove leading ./ if present
        if (normalizedBaseDir.startsWith('./')) {
            normalizedBaseDir = normalizedBaseDir.substring(2);
        }
        // Ensure trailing slash for proper prefix matching
        if (normalizedBaseDir && !normalizedBaseDir.endsWith('/')) {
            normalizedBaseDir += '/';
        }
        
        // Normalize the input path
        let normalizedPath = path.replace(/\\/g, '/');
        // Remove leading ./ if present
        if (normalizedPath.startsWith('./')) {
            normalizedPath = normalizedPath.substring(2);
        }
        
        // Remove baseDir prefix if present
        if (normalizedBaseDir && normalizedPath.startsWith(normalizedBaseDir)) {
            normalizedPath = normalizedPath.substring(normalizedBaseDir.length);
        }
        
        // this.debugLog(`**TOGLOBAL: ${pathSrc} => ${normalizedPath} (baseDir: ${normalizedBaseDir})`);
        return normalizedPath;
    }
    abstract delete(path: string): Promise<boolean>;
    abstract put(path: string, data: FileData): Promise<boolean>;
    abstract get(path: FilePathWithPrefix): Promise<false | FileData>;
    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;
    cache = new LRUCache<string, string>(300, 10000000, true);
    
    /**
     * Normalizes a file path for use as a cache key.
     * This ensures consistent cache lookups regardless of whether the path
     * comes from put(), dispatch(), or other sources.
     * 
     * The normalization:
     * 1. Converts the path to a global path format (removes baseDir prefix)
     * 2. Converts all backslashes to forward slashes (Windows compatibility)
     * 3. Ensures consistent representation across different code paths
     * 
     * This avoids cache misses caused by different path representations:
     * - "./vault/file.md" vs "file.md"
     * - "file/path.md" vs "file\path.md" (Windows)
     * 
     * @param path - The file path to normalize
     * @returns Normalized path suitable for cache key (always uses forward slashes)
     */
    normalizeCacheKey(path: string): string {
        // If feature is disabled, return path as-is for backward compatibility
        if (this.config.useNormalizedCachePaths === false) {
            return path;
        }
        
        // Convert to global path format to ensure consistency
        // This removes baseDir prefix and handles underscore prefixes
        let normalized = this.toGlobalPath(path);
        
        // Ensure forward slashes for cross-platform consistency
        // This is critical on Windows where paths can have backslashes
        normalized = normalized.replace(/\\/g, '/');
        
        return normalized;
    }
    
    /**
     * Checks if a file operation is a repeat (same content as last processed).
     * 
     * This prevents infinite loops in the following scenario:
     * 1. Peer A detects file change and dispatches to Hub
     * 2. Hub dispatches to Peer B (and back to Peer A)
     * 3. Peer A's put() writes the file (same content)
     * 4. Peer A's file watcher detects the write as a "change"
     * 5. Without this check, step 1 would repeat infinitely
     * 
     * The function:
     * - Computes a hash of the file data
     * - Checks if this hash was recently seen for this file path
     * - Updates the cache with the new hash
     * - Returns true if the operation should be skipped (repeat detected)
     * 
     * @param path - File path (will be normalized for cache lookup)
     * @param data - File data to check, or false for deletion
     * @returns true if this is a repeat operation (should skip), false if new
     */
    async isRepeating(path: string, data: FileData | false) {
        // Compute hash of the file content (or special marker for deletions)
        const d = await computeHash(data === false ? ["\u0001Deleted"] : data.data);

        // Normalize the path for consistent cache lookups
        const normalizedPath = this.normalizeCacheKey(path);
        
        // Check if we've recently processed this exact file content
        const cachedValue = this.cache.get(normalizedPath);
        if (this.cache.has(normalizedPath) && cachedValue == d) {
            this.normalLog(` Skipped (Repeat) ${path}: ${d?.substring(0, 6)} (cached: ${cachedValue?.substring(0, 6)}, normalized: ${normalizedPath})`);
            return true;
        }

        this.normalLog(`Cache miss for ${path}: ${d?.substring(0, 6)} (previous: ${cachedValue?.substring(0, 6)}, normalized: ${normalizedPath})`);

        // Update cache with new hash for this file
        this.cache.set(normalizedPath, d);
        return false;
    }
    receiveLog(message: string, level?: LOG_LEVEL) {
        Logger(`[${this.config.name}] <-- ${message}`, level ?? LOG_LEVEL_INFO);
    }
    sendLog(message: string, level?: LOG_LEVEL) {
        Logger(`[${this.config.name}] --> ${message}`, level ?? LOG_LEVEL_INFO);
    }
    normalLog(message: string, level?: LOG_LEVEL) {
        Logger(`[${this.config.name}] ${message}`, level ?? LOG_LEVEL_INFO);
    }
    debugLog(message: string, level?: LOG_LEVEL) {
        Logger(`[${this.config.name}] ${message}`, level ?? LOG_LEVEL_DEBUG);
    }
    _getKey(key: string) {
        return `${this.config.name}-${this.config.type}-${this.config.baseDir}-${key}`;
    }
    setSetting(key: string, value: string) {
        return localStorage.setItem(this._getKey(key), value);
    }
    getSetting(key: string) {
        return localStorage.getItem(this._getKey(key));
    }
    compareDate(a: FileInfo, b: FileInfo) {
        const aMTime = ~~(a?.mtime ?? 0 / 1000);
        const bMTime = ~~(b?.mtime ?? 0 / 1000);
        return aMTime - bMTime;
    }
}

import { join as joinPosix } from "jsr:@std/path/posix";
import type { FileInfo } from "./lib/src/API/DirectFileManipulatorV2.ts";

import { FilePathWithPrefix, LOG_LEVEL, LOG_LEVEL_DEBUG, LOG_LEVEL_INFO } from "./lib/src/common/types.ts";
import { PeerConf, FileData } from "./types.ts";
import { Logger } from "octagonal-wheels/common/logger.js";
import { LRUCache } from "octagonal-wheels/memory/LRUCache.js"
import { computeHash } from "./util.ts";

export type DispatchFun = (source: Peer, path: string, data: FileData | false) => Promise<void>;

export interface PeerHealth {
    name: string;
    type: string;
    ok: boolean;
    detail?: string;
    // Whether this peer's backend is reachable right now. Used to tell "not
    // syncing because the backend is down" (wait, don't restart) apart from "not
    // syncing while the backend is up" (the bridge is at fault, restart can help).
    // Peers with no remote backend (e.g. storage) report true.
    backendUp: boolean;
    // The bridge is at fault and a restart could plausibly help: the peer was
    // healthy at some point, has since stayed unhealthy past a grace window, and
    // its backend is reachable. Decided by probeHealth(), not the sync snapshot.
    restartWorthy: boolean;
}

export abstract class Peer {
    config: PeerConf;
    // hub: Hub;
    dispatchToHub: DispatchFun;
    constructor(conf: PeerConf, dispatcher: DispatchFun) {
        this.config = conf;
        this.dispatchToHub = dispatcher;
    }
    // How long a once-healthy peer must stay unhealthy (with its backend reachable)
    // before a restart is worthwhile — long enough to ride out the self-healing
    // watch reconnect and other brief dips, so they don't trigger a kill.
    private static readonly RESTART_GRACE_MS = 60_000;
    private _everOk = false;
    private _notOkSince: number | undefined;
    // Quick, non-blocking health snapshot. restartWorthy here is always false; the
    // real (time- and backend-aware) verdict is decided by probeHealth().
    health(): PeerHealth {
        return { name: this.config.name, type: this.config.type, ok: true, backendUp: true, restartWorthy: false };
    }
    // Backend reachability check, possibly I/O-bound. Default: no remote backend, so
    // always "up". PeerCouchDB overrides it to probe CouchDB.
    checkBackendUp(): Promise<boolean> {
        return Promise.resolve(true);
    }
    // Health with the backend-aware restart verdict. A peer is restart-worthy only
    // once it has been healthy AND then stayed unhealthy past the grace window with
    // its backend reachable. So a peer still doing its initial scan/connect (never
    // healthy yet) and a peer that's idle only because its backend is down are
    // never restart-worthy — neither is the bridge's fault, and restarting either
    // would just churn. The backend probe is skipped until a peer has been healthy,
    // so startup does no extra I/O.
    async probeHealth(): Promise<PeerHealth> {
        const base = this.health();
        if (base.ok) {
            this._everOk = true;
            this._notOkSince = undefined;
            return base;
        }
        if (!this._everOk) return base; // still starting up — not the bridge's fault
        if (this._notOkSince === undefined) this._notOkSince = Date.now();
        const backendUp = await this.checkBackendUp();
        const restartWorthy = backendUp && (Date.now() - this._notOkSince > Peer.RESTART_GRACE_MS);
        return { ...base, backendUp, restartWorthy };
    }
    toLocalPath(path: string) {
        const relativeJoined = joinPosix(this.config.baseDir, path);
        const relative = relativeJoined == "." ? "" : relativeJoined;
        // NOTE: do NOT special-case leading "_" here. The commonlib path2id_base/id2path_base
        // already handle "_"-prefixed paths correctly. Adding "/" here double-mangled them
        // (e.g. _attachments -> attachments on round-trip).
        // this.debugLog(`**TOLOCAL: ${path} => ${relative}`);
        return relative;
    }
    toGlobalPath(pathSrc: string) {
        // NOTE: do NOT strip a leading "_" here (was corrupting _attachments -> attachments).
        let path = pathSrc;
        if (path.startsWith(this.config.baseDir)) {
            path = path.substring(this.config.baseDir.length);
        }
        // this.debugLog(`**TOLOCAL: ${pathSrc} => ${path}`);
        return path;
    }
    abstract delete(path: string): Promise<boolean>;
    abstract put(path: string, data: FileData): Promise<boolean>;
    abstract get(path: FilePathWithPrefix): Promise<false | FileData>;
    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;
    cache = new LRUCache<string, string>(300, 10000000, true);
    async isRepeating(path: string, data: FileData | false) {
        const d = await computeHash(data === false ? ["\u0001Deleted"] : data.data);

        if (this.cache.has(path) && this.cache.get(path) == d) {
            return true;
        }
        this.cache.set(path, d);
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

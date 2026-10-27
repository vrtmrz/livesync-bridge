import { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import {
    type FilePathWithPrefix,
    MILESTONE_DOCID,
    type TweakValues,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import { PeerCouchDBConf, FileData } from "./types.ts";
import { decodeBinary } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/convert";
import { isPlainText } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/path";
import { DispatchFun, Peer, PeerHealth } from "./Peer.ts";
import { normaliseIdDerivationKey } from "./util.ts";
import {
    createBinaryBlob,
    createTextBlob,
    getDocData,
    isDocContentSame,
    unique,
} from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { minimatch } from "minimatch";
import { serialized } from "octagonal-wheels/concurrency/lock";
import { promiseWithResolver } from "octagonal-wheels/promises";
import { LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";

type ManipulatorMetaEntry = Parameters<DirectFileManipulator["getByMeta"]>[0];
type ManipulatorReadyEntry = Awaited<ReturnType<DirectFileManipulator["getByMeta"]>>;
type ResolvedCouchDBPath = {
    sharedPath: string;
    databasePath: FilePathWithPrefix;
    internal: boolean;
};

// export class PeerInstance()

export class PeerCouchDB extends Peer {
    man!: DirectFileManipulator;
    declare config: PeerCouchDBConf;
    private _started = promiseWithResolver<void>();
    private _connected = false;
    private _remoteEmpty = false;
    constructor(conf: PeerCouchDBConf, dispatcher: DispatchFun) {
        super(conf, dispatcher);
        const idDerivationKey = normaliseIdDerivationKey(this.config.idDerivationKey);
        this.config.idDerivationKey = idDerivationKey;
        if (idDerivationKey) {
            // The manipulator checks remote document IDs before remote tweaks are applied, so a configured key must select version 1 up front
            this.config.idDerivationVersion ??= 1;
        }
        // The manipulator is built lazily in start(), only after a probe confirms
        // CouchDB is reachable. Building it here would start its one-shot init
        // against a possibly-down CouchDB, then discard and rebuild it on the
        // first successful connection.
    }
    override _getKey(key: string): string {
        if (key !== "since" && key !== "remote-created") return super._getKey(key);
        const url = new URL(this.config.url);
        // Include reverse-proxy paths, but keep credentials out of persisted keys.
        const endpoint = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
        return `couchdb-checkpoint:${JSON.stringify([this.config.name, this.config.baseDir, endpoint, this.config.database, key])}`;
    }
    // (Re)create the underlying DirectFileManipulator. Its constructor starts a
    // one-shot async database initialisation. Recovering from a failed attempt
    // requires a fresh manipulator because its `ready` promise remains settled.
    private _buildManipulator(): void {
        this.config.syncInternalFiles = (this.config.includeInternal?.length ?? 0) > 0;
        // Release the previous instance if we're rebuilding. Each retry that gets
        // past the probe but fails to connect (CouchDB reachable but e.g. a config
        // error) rebuilds; without this the old manipulator's local DB handle would
        // leak. Best-effort and fire-and-forget — it may be mid-init, and we don't
        // want to block the connect path (or fail it) on teardown.
        const prev = this.man as DirectFileManipulator | undefined;
        this.man = new DirectFileManipulator(this.config, {
            // Bypass node:http compatibility shims for Deno, Traefik, and long-polling connections.
            fetch: (request, init) => globalThis.fetch(request, init),
        });
        // Unbound legacy checkpoints are not reused; read this remote from the beginning.
        this.man.since = this.getSetting("since") ?? "";
        if (prev) void prev.close().catch(() => {});
    }
    private _isCanonicalFilePath(path: string): boolean {
        return path.length > 0 && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
    }
    private _resolveSharedPath(path: string): ResolvedCouchDBPath | false {
        if (!this._isCanonicalFilePath(path) ||
            ["i:", "ix:", "ps:", "h:", "f:"].some(prefix => path.startsWith(prefix))) return false;
        if (path.startsWith(".")) {
            if (!this.config.includeInternal?.some(pattern => minimatch(path, pattern, { dot: true }))) return false;
            return { sharedPath: path, databasePath: `i:${path}` as FilePathWithPrefix, internal: true };
        }
        const databasePath = this.toLocalPath(path);
        if (!this._isCanonicalFilePath(databasePath) || databasePath.startsWith(".")) return false;
        return { sharedPath: path, databasePath: databasePath as FilePathWithPrefix, internal: false };
    }
    private _resolveMetadataPath(path: string): ResolvedCouchDBPath | false {
        if (path.startsWith("i:")) {
            const resolved = this._resolveSharedPath(path.substring(2));
            return resolved && resolved.internal ? resolved : false;
        }
        if (!this._isCanonicalFilePath(path) || path.startsWith(".") || path.includes(":")) return false;
        const baseDir = this.toLocalPath("").replace(/\/+$/, "");
        if (baseDir && !path.startsWith(`${baseDir}/`)) return false;
        const sharedPath = baseDir ? path.substring(baseDir.length + 1) : path;
        const resolved = this._resolveSharedPath(sharedPath);
        return resolved && !resolved.internal && resolved.databasePath === path ? resolved : false;
    }
    private async _canAccessPath(resolved: ResolvedCouchDBPath): Promise<boolean> {
        if (!resolved.internal) return true;
        const alias = this.toLocalPath(resolved.sharedPath) as FilePathWithPrefix;
        try {
            const aliasId = await this.man.path2id(alias);
            const existing = await this.man.rawGet<{ deleted?: boolean; _deleted?: boolean }>(aliasId);
            if (!existing || existing.deleted || existing._deleted) return true;
            this.normalLog(
                `Internal file blocked: ${resolved.databasePath} (ordinary document ${alias} shares ${resolved.sharedPath})`,
                LOG_LEVEL_NOTICE,
            );
        } catch {
            this.normalLog(
                `Internal file blocked: ${resolved.databasePath} (could not inspect ordinary document ${alias})`,
                LOG_LEVEL_NOTICE,
            );
        }
        return false;
    }
    private async _prepareOutgoingPath(path: string): Promise<ResolvedCouchDBPath | false> {
        const resolved = this._resolveSharedPath(path);
        if (!resolved) return false;
        await this._started.promise;
        return await this._canAccessPath(resolved) ? resolved : false;
    }
    private async withDocumentLocks<T>(paths: FilePathWithPrefix[], action: () => Promise<T>): Promise<T> {
        const ids = [...new Set(await Promise.all(paths.map(path => this.man.path2id(path))))].sort();
        const lock = (index: number): Promise<T> => index === ids.length ? action()
            : serialized(`${this.operationKey}:document:${ids[index]}`, () => lock(index + 1));
        return await lock(0);
    }
    private async deleteResolved(resolved: ResolvedCouchDBPath): Promise<boolean> {
        return await this.applyChange(resolved.sharedPath, false, async () => {
            const existing = await this.man.get(resolved.databasePath, true);
            if (!existing || existing.deleted) return false;
            if (!await this.man.delete(resolved.databasePath)) {
                throw new Error(`Delete failed: ${resolved.databasePath}`);
            }
            this.receiveLog(` ${resolved.databasePath} deleted`);
            return true;
        });
    }
    async delete(pathSrc: string): Promise<boolean> {
        const resolved = await this._prepareOutgoingPath(pathSrc);
        if (!resolved) return false;
        return await this.withDocumentLocks([resolved.databasePath], () => this.deleteResolved(resolved));
    }
    override async deleteFrom(path: string, source: Peer): Promise<boolean> {
        const resolved = await this._prepareOutgoingPath(path);
        if (!resolved) return false;
        return await this.withDocumentLocks([resolved.databasePath], async () => {
            const id = await this.man.path2id(resolved.databasePath);
            const matching: ResolvedCouchDBPath[] = [];
            // Recheck the source under the destination document lock. Separate watcher
            // events are not evidence of a rename, but a live identity forbids deletion.
            for (const current of await source.currentPaths(path)) {
                const candidate = this._resolveSharedPath(current);
                if (candidate && await this.man.path2id(candidate.databasePath) === id) matching.push(candidate);
            }
            if (matching.length > 1) throw new Error(`Deletion blocked by ambiguous current paths: ${path}`);
            if (matching.length === 1) {
                const candidate = matching[0];
                if (!await this._canAccessPath(candidate)) throw new Error(`Deletion verification blocked: ${path}`);
                const data = await source.get(candidate.sharedPath as FilePathWithPrefix);
                if (!data) throw new Error(`Current file could not be read: ${candidate.sharedPath}`);
                await this.putResolved(candidate, data);
                return false;
            }
            return await this.deleteResolved(resolved);
        });
    }
    override async rename(previousPath: string, path: string, data: FileData): Promise<boolean> {
        const previous = this._resolveSharedPath(previousPath);
        const target = this._resolveSharedPath(path);
        await this._started.promise;
        for (const resolved of [previous, target]) {
            if (resolved && !await this._canAccessPath(resolved)) {
                throw new Error(`Rename path inspection blocked: ${resolved.sharedPath}`);
            }
        }
        const paths = [previous, target].filter((value): value is ResolvedCouchDBPath => !!value);
        return await this.withDocumentLocks(paths.map(value => value.databasePath), async () => {
            if (!target) return previous ? await this.deleteResolved(previous) : false;
            if (!previous) return await this.putResolved(target, data);
            const oldId = await this.man.path2id(previous.databasePath);
            const newId = await this.man.path2id(target.databasePath);
            if (oldId === newId) return await this.putResolved(target, data);
            const collision = await this.man.get(target.databasePath, true);
            if (collision && !collision.deleted) {
                const old = await this.man.get(previous.databasePath, true);
                const current = await this.man.getById(newId, true) as false | ManipulatorMetaEntry;
                // Another destination may have failed after this one completed. A
                // verified completed rename must not block that destination's retry.
                if ((!old || old.deleted) && current && current.path === target.databasePath) {
                    const ready = await this.man.getByMeta(current);
                    if (ready && "data" in ready) {
                        const existing = ready.type === "plain" ? createTextBlob(ready.data)
                            : createBinaryBlob(new Uint8Array(decodeBinary(ready.data)));
                        const incoming = data.data instanceof Uint8Array ? createBinaryBlob(data.data) : createTextBlob(data.data);
                        if (await isDocContentSame(existing, incoming)) return false;
                    }
                }
                throw new Error(`Rename target already exists: ${target.databasePath}`);
            }
            const saved = await this.putResolved(target, data);
            await this.deleteResolved(previous);
            return saved;
        });
    }
    async put(pathSrc: string, data: FileData): Promise<boolean> {
        const resolved = await this._prepareOutgoingPath(pathSrc);
        if (!resolved) return false;
        return await this.withDocumentLocks([resolved.databasePath], () => this.putResolved(resolved, data));
    }
    private async putResolved(resolved: ResolvedCouchDBPath, data: FileData): Promise<boolean> {
        const path = resolved.databasePath;
        let old: false | ManipulatorMetaEntry;
        try {
            old = await this.man.getById(await this.man.path2id(path), true) as false | ManipulatorMetaEntry;
        } catch (ex) {
            if ((ex as { status?: number })?.status !== 404) throw ex;
            old = false;
        }
        return await this.applyChange(resolved.sharedPath, data, async () => {
            const type = isPlainText(path) ? "plain" : "newnote";
            const info = { ctime: data.ctime, mtime: data.mtime, size: data.size };
            const saveData = data.data instanceof Uint8Array ? createBinaryBlob(data.data) : createTextBlob(data.data);
            if (old && !old.deleted && old.path === path && Math.abs(this.compareDate(info, old)) < 3600) {
                const oldDoc = await this.man.getByMeta(old);
                if (oldDoc && "data" in oldDoc) {
                    const body = oldDoc.type === "plain" ? createTextBlob(oldDoc.data)
                        : createBinaryBlob(new Uint8Array(decodeBinary(oldDoc.data)));
                    if (await isDocContentSame(body, saveData)) return false;
                }
            }
            if (!await this.man.put(path, saveData, info, type)) throw new Error(`Save failed: ${path}`);
            this.receiveLog(` ${path} saved`);
            return true;
        }, { force: !old || !!old.deleted || old.path !== path });
    }
    async get(pathSrc: FilePathWithPrefix): Promise<false | FileData> {
        const resolved = await this._prepareOutgoingPath(pathSrc);
        if (!resolved) return false;
        const path = resolved.databasePath;
        const ret = await this.man.get(path) as false | ManipulatorReadyEntry;
        if (ret === false) {
            return false;
        }
        return {
            ctime: ret.ctime,
            mtime: ret.mtime,
            data: ret.type == "newnote" ? new Uint8Array(decodeBinary(ret.data)) : ret.data,
            size: ret.size,
            deleted: ret.deleted
        };
    }
    async getMeta(pathSrc: FilePathWithPrefix): Promise<false | FileData> {
        const resolved = await this._prepareOutgoingPath(pathSrc);
        if (!resolved) return false;
        const path = resolved.databasePath;
        const ret = await this.man.get(path, true) as false | ManipulatorMetaEntry;
        if (ret === false) {
            return false;
        }
        return {
            ctime: ret.ctime,
            mtime: ret.mtime,
            data: [],
            size: ret.size,
            deleted: ret.deleted
        };
    }
    // Probe CouchDB the same way PouchDB will: a request whose body must parse as
    // JSON. A half-ready CouchDB (or a proxy error page) returns a non-JSON body —
    // exactly the case that used to crash the bridge — so we treat it as "not
    // ready yet" and let the caller retry, fast, instead of waiting on a hung init.
    private async _probeCouch(timeoutMs = 10000): Promise<void> {
        // Read straight from config (the manipulator may not be built yet, and these
        // are the same credentials it will use).
        const url = `${this.config.url}/${this.config.database}`;
        const headers: Record<string, string> = {};
        if (this.config.username) {
            // UTF-8-safe Basic auth: btoa() throws on code points > 0xFF, so a
            // non-ASCII password would otherwise make every probe fail forever even
            // though CouchDB would accept it.
            const creds = `${this.config.username}:${this.config.password ?? ""}`;
            const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(creds)));
            headers["Authorization"] = `Basic ${b64}`;
        }
        // Bounded so a hung connection can't stall either the connect loop or the
        // heartbeat's reachability check (which would look like a wedged process).
        const res = await globalThis.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
            await res.body?.cancel();
            throw new Error(`CouchDB not ready: HTTP ${res.status}`);
        }
        await res.json();
    }

    // Is CouchDB up and serving right now? Uses the same success threshold as the
    // connect probe (200 + parseable JSON), so a still-warming-up CouchDB (refused,
    // or 503) reads as down — we don't want a restart while it boots.
    private async _couchReachable(): Promise<boolean> {
        try {
            await this._probeCouch(5000);
            return true;
        } catch {
            return false;
        }
    }

    // Bound the manipulator's one-shot initialisation so a transport which accepts
    // the request but never answers becomes a retriable failure.
    private _waitReady(timeoutMs: number): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("CouchDB init timed out")), timeoutMs);
        });
        return Promise.race([this.man.ready.promise as Promise<void>, timeout]).finally(() => {
            if (timer !== undefined) clearTimeout(timer);
        });
    }

    async start(): Promise<void> {
        let attempt = 0;
        // Supervised connect loop. CouchDB may be unreachable or still warming up
        // (classically right after a host reboot, when CouchDB and the bridge start
        // together). Rather than letting a failed connect surface as a fatal
        // unhandled rejection — which crash-looped the bridge into systemd's start
        // limit and left it down for days — retry with capped backoff until CouchDB
        // answers, then begin watching.
        for (;;) {
            try {
                await this._probeCouch();
                // CouchDB answered cleanly; rebuild against it so init starts fresh.
                this._buildManipulator();
                await this._connectAndWatch();
                if (attempt > 0) {
                    this.normalLog(`Connected to CouchDB after ${attempt} retr${attempt === 1 ? "y" : "ies"}.`, LOG_LEVEL_NOTICE);
                }
                this._connected = true;
                this._started.resolve();
                return;
            } catch (e) {
                attempt++;
                const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5));
                this.normalLog(`CouchDB connect attempt ${attempt} failed; retrying in ${delay / 1000}s.`, LOG_LEVEL_NOTICE);
                this.debugLog(`${e instanceof Error ? (e.stack ?? e.message) : e}`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    private async _connectAndWatch(): Promise<void> {
        {
            await this._waitReady(15000);
            const w = await this.man.rawGet<Record<string, any>>(MILESTONE_DOCID);
            if (w && "tweak_values" in w) {
                if (this.config.useRemoteTweaks) {
                    const tweaks = Object.values(w["tweak_values"])[0] as TweakValues;
                    // console.log(tweaks)
                    const orgConf = { ...this.config } as Record<string, any>;
                    this.config.customChunkSize = tweaks.customChunkSize ?? this.config.customChunkSize;
                    this.config.minimumChunkSize = tweaks.minimumChunkSize ?? this.config.minimumChunkSize;
                    if (tweaks.encrypt && !this.config.passphrase) {
                        throw new Error("Remote database is encrypted but no passphrase provided.");
                    }
                    if (tweaks.usePathObfuscation && !this.config.obfuscatePassphrase) {
                        throw new Error("Remote database is obfuscated but no obfuscate passphrase provided.");
                    }
                    this.config.hashAlg = tweaks.hashAlg ?? this.config.hashAlg;
                    this.config.maxAgeInEden = tweaks.maxAgeInEden ?? this.config.maxAgeInEden;
                    this.config.maxTotalLengthInEden = tweaks.maxTotalLengthInEden ?? this.config.maxTotalLengthInEden;
                    this.config.maxChunksInEden = tweaks.maxChunksInEden ?? this.config.maxChunksInEden;
                    this.config.useEden = tweaks.useEden ?? this.config.useEden;
                    if (!this.config.enableCompression != !tweaks.enableCompression) {
                        throw new Error("Compression setting mismatched.");
                    }
                    this.config.useDynamicIterationCount = tweaks.useDynamicIterationCount ?? this.config.useDynamicIterationCount;
                    this.config.enableChunkSplitterV2 = tweaks.enableChunkSplitterV2 ?? this.config.enableChunkSplitterV2;
                    this.config.chunkSplitterVersion = tweaks.chunkSplitterVersion ?? this.config.chunkSplitterVersion;
                    this.config.E2EEAlgorithm = tweaks.E2EEAlgorithm ?? this.config.E2EEAlgorithm;
                    this.config.minimumChunkSize = tweaks.minimumChunkSize ?? this.config.minimumChunkSize;
                    this.config.customChunkSize = tweaks.customChunkSize ?? this.config.customChunkSize;
                    this.config.doNotUseFixedRevisionForChunks = tweaks.doNotUseFixedRevisionForChunks ?? this.config.doNotUseFixedRevisionForChunks;
                    this.config.handleFilenameCaseSensitive = tweaks.handleFilenameCaseSensitive ?? this.config.handleFilenameCaseSensitive;
                    this.config.idDerivationVersion = tweaks.idDerivationVersion ?? this.config.idDerivationVersion;
                    this.config.encryptInternalMetadata = tweaks.encryptInternalMetadata ?? this.config.encryptInternalMetadata;
                    const newConf = { ...this.config } as Record<string, any>;
                    this.man.options = this.config;
                    await this.man.liveSyncLocalDB.initializeDatabase()
                    // await this.man.managers.initManagers();
                    const diff = unique([...Object.keys(orgConf), ...Object.keys(tweaks)]).filter(k => orgConf[k] != newConf[k]);
                    if (diff.length > 0) {
                        this.normalLog(`Remote tweaks changed --->`);
                        for (const diffKey of diff) {
                            this.normalLog(`${diffKey}\t: ${orgConf[diffKey]} \t : ${newConf[diffKey]}`);
                        }
                        this.normalLog(`<--- Remote tweaks changed`);
                    }
                }
            }
            if (!w) {
                this.normalLog(`Remote database looks like empty. fetch from the first.`);
                this.man.since = "";
                this.setSetting("since", "");
                this.setSetting("remote-created", "0");
                // Connected fine; there's just nothing to watch yet. Mark it so health
                // counts this as syncing rather than a stuck "not watching" state.
                this._remoteEmpty = true;
                return;
            }
            const created = w.created;
            if (this.getSetting("remote-created") !== `${created}`) {
                this.man.since = "";
                this.setSetting("since", "");
                this.normalLog(`Remote database looks like rebuilt. fetch from the first again.`);
                this.setSetting("remote-created", `${created}`);
            } else {
                this.normalLog(`Watch starting from ${this.man.since}`);
            }
            this.man.beginWatch(async (entry, seq) => {
                const resolved = this._resolveMetadataPath(entry.path);
                if (resolved && await this._canAccessPath(resolved)) {
                    const path = resolved.sharedPath;
                    if (entry.deleted || entry._deleted) {
                        this.sendLog(`${path} delete detected`);
                        await this.dispatchDeleted(path);
                    } else {
                        const d = entry.type == "plain" ? entry.data : new Uint8Array(decodeBinary(entry.data));
                        const docData = { ctime: entry.ctime, mtime: entry.mtime, size: entry.size, deleted: entry.deleted || entry._deleted, data: d };
                        this.sendLog(`${path} change detected`);
                        await this.dispatch(path, docData);
                    }
                }
                // Save this callback's position after dispatch or an explicit rejection.
                this.advanceSince(seq);
            }, (entry) => this._resolveMetadataPath(entry.path) !== false);
        }
    }
    // Commonlib passes seq to the callback without updating man.since. Keep both
    // the reconnect position and the peer's saved position after dispatch.
    // Concurrent callbacks can still finish out of order, and earlier pending or
    // failed changes are not guaranteed to be replayed by this checkpoint alone.
    advanceSince(seq?: string | number): void {
        if (seq === undefined || seq === null || `${seq}` === "") return;
        this.man.since = `${seq}`;
        this.setSetting("since", `${seq}`);
    }
    async dispatch(path: string, data: FileData | false) {
        if (data === false) return;
        // Reject inconsistent empty data before recording repeats or delivering it to peers.
        // A later valid empty update must still be dispatched.
        if (data.size > 0 && (data.data instanceof Uint8Array
            ? data.data.byteLength === 0
            : getDocData(data.data).length === 0)) {
            this.normalLog(
                `Empty update blocked: ${path} (${data.size} bytes reported, 0 bytes received)`,
                LOG_LEVEL_NOTICE,
            );
            return;
        }
        await this.applyChange(path, data, async () => {
            await this.dispatchToHub(this, path, data);
            return true;
        }, { suppressPendingEcho: true });
        // else {
        //     this.receiveLog(`${path} dispatch repeating`);
        // }
    }
    async dispatchDeleted(path: string) {
        await this.applyChange(path, false, async () => {
            await this.dispatchToHub(this, path, false);
            return true;
        }, { suppressPendingEcho: true });
    }
    async stop(): Promise<void> {
        // `man` may not exist yet if stop() races a still-connecting start().
        this.man?.endWatch();
        return await Promise.resolve();
    }
    // Synchronous snapshot. `ok` means actually syncing — connected AND either
    // watching or a known-empty remote. A brief `watching` dip during the 10s
    // self-healing reconnect makes ok=false, but the Quadlet healthcheck's retry
    // window (3 × 30s) absorbs that, so it doesn't cause a restart. backendUp is
    // only asserted here when we're syncing; probeHealth() refines it otherwise.
    override health(): PeerHealth {
        const watching = this.man?.watching === true;
        const syncing = this._connected && (watching || this._remoteEmpty);
        return {
            name: this.config.name,
            type: "couchdb",
            ok: syncing,
            detail: !this._connected ? "connecting" : (watching ? "watching" : (this._remoteEmpty ? "connected (empty remote)" : "reconnecting")),
            backendUp: syncing,
            restartWorthy: false,
        };
    }
    // Backend reachability for the base restart logic — probe CouchDB (bounded). The
    // base only calls this once a peer has been healthy and is now failing, so a
    // CouchDB outage (probe fails → backendUp false) keeps the peer non-restart-worthy.
    override checkBackendUp(): Promise<boolean> {
        return this._couchReachable();
    }
}

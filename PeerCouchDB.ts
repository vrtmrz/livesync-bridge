import { DirectFileManipulator, FileInfo, MetaEntry, ReadyEntry } from "./lib/src/API/DirectFileManipulatorV2.ts";
import { FilePathWithPrefix, LOG_LEVEL_NOTICE, MILESTONE_DOCID, TweakValues } from "./lib/src/common/types.ts";
import { PeerCouchDBConf, FileData } from "./types.ts";
import { decodeBinary } from "./lib/src/string_and_binary/convert.ts";
import { isPlainText } from "./lib/src/string_and_binary/path.ts";
import { DispatchFun, Peer, PeerHealth } from "./Peer.ts";
import { createBinaryBlob, createTextBlob, isDocContentSame, unique } from "./lib/src/common/utils.ts";
import { minimatch } from "minimatch";
import { PouchDB } from "./lib/src/pouchdb/pouchdb-http.ts";
import { promiseWithResolver } from "octagonal-wheels/promises";

// export class PeerInstance()

export class PeerCouchDB extends Peer {
    man!: DirectFileManipulator;
    declare config: PeerCouchDBConf;
    private _started = promiseWithResolver<void>();
    private _connected = false;
    private _remoteEmpty = false;
    constructor(conf: PeerCouchDBConf, dispatcher: DispatchFun) {
        super(conf, dispatcher);
        // The manipulator is built lazily in start(), only after a probe confirms
        // CouchDB is reachable. Building it here would fire its one-shot init
        // against a possibly-down CouchDB (an unhandled rejection) and then be
        // discarded and rebuilt on the first successful connect.
    }
    // (Re)create the underlying DirectFileManipulator. Its constructor kicks off a
    // one-shot async DB init whose `ready` promise never resolves (and whose
    // rejection is unhandled) when CouchDB is unreachable, so recovering from a
    // failed connect requires a *fresh* manipulator, not re-awaiting the old,
    // permanently-pending one.
    private _buildManipulator(): void {
        // Release the previous instance if we're rebuilding. Each retry that gets
        // past the probe but fails to connect (CouchDB reachable but e.g. a config
        // error) rebuilds; without this the old manipulator's local DB handle would
        // leak. Best-effort and fire-and-forget — it may be mid-init, and we don't
        // want to block the connect path (or fail it) on teardown.
        const prev = this.man as DirectFileManipulator | undefined;
        this.man = new DirectFileManipulator(this.config);
        // Use Deno's native fetch to bypass node:http shim issues with Traefik/long-polling
        this.man.$$createPouchDBInstance = <T extends object>(): PouchDB.Database<T> => {
            return new PouchDB(this.man.options.url + "/" + this.man.options.database, {
                auth: { username: this.man.options.username, password: this.man.options.password },
                fetch: (url: string | Request, opts?: RequestInit) => globalThis.fetch(url, opts),
            }) as PouchDB.Database<T>;
        };
        // Fetch remote since.
        this.man.since = this.getSetting("since") || "now";
        if (prev) void prev.close().catch(() => {});
    }
    async delete(pathSrc: string): Promise<boolean> {
        await this._started.promise;
        const path = this.toLocalPath(pathSrc);
        if (await this.isRepeating(pathSrc, false)) {
            return false;
        }
        const r = await this.man.delete(path);
        if (r) {
            this.receiveLog(` ${path} deleted`);
        } else {
            this.receiveLog(` ${path} delete failed`, LOG_LEVEL_NOTICE);
        }
        return r;
    }
    async put(pathSrc: string, data: FileData): Promise<boolean> {
        await this._started.promise;
        const path = this.toLocalPath(pathSrc);
        if (await this.isRepeating(pathSrc, data)) {
            return false;
        }
        const type = isPlainText(path) ? "plain" : "newnote";
        const info: FileInfo = {
            ctime: data.ctime,
            mtime: data.mtime,
            size: data.size
        };
        const saveData = (data.data instanceof Uint8Array) ? createBinaryBlob(data.data) : createTextBlob(data.data);
        const old = await this.man.get(path as FilePathWithPrefix, true) as false | MetaEntry;
        // const old = await this.getMeta(path as FilePathWithPrefix);
        if (old && Math.abs(this.compareDate(info, old)) < 3600) {
            const oldDoc = await this.man.getByMeta(old);
            if (oldDoc && ("data" in oldDoc)) {
                const d = oldDoc.type == "plain" ? createTextBlob(oldDoc.data) : createBinaryBlob(new Uint8Array(decodeBinary(oldDoc.data)));
                if (await isDocContentSame(d, saveData)) {
                    this.normalLog(` Skipped (Same) ${path} `);
                    return false;
                }
            }
        }
        const r = await this.man.put(path, saveData, info, type);
        if (r) {
            this.receiveLog(` ${path} saved`);
        } else {
            this.receiveLog(` ${path} ignored`);
        }
        return r;
    }
    async get(pathSrc: FilePathWithPrefix): Promise<false | FileData> {
        await this._started.promise;
        const path = this.toLocalPath(pathSrc) as FilePathWithPrefix;
        const ret = await this.man.get(path) as false | ReadyEntry;
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
        await this._started.promise;
        const path = this.toLocalPath(pathSrc) as FilePathWithPrefix;
        const ret = await this.man.get(path, true) as false | MetaEntry;
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

    // Wait for the manipulator's one-shot init, but bounded: its `ready` promise
    // hangs forever if init failed, so race it against a timeout to turn a hang
    // into a retriable failure.
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
            const baseDir = this.toLocalPath("");
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
                this.setSetting("remote-created", "0");
                // Connected fine; there's just nothing to watch yet. Mark it so health
                // counts this as syncing rather than a stuck "not watching" state.
                this._remoteEmpty = true;
                return;
            }
            const created = w.created;
            if (this.getSetting("remote-created") !== `${created}`) {
                this.man.since = "";
                this.normalLog(`Remote database looks like rebuilt. fetch from the first again.`);
                this.setSetting("remote-created", `${created}`);
            } else {
                this.normalLog(`Watch starting from ${this.man.since}`);
            }
            this.man.beginWatch(async (entry) => {
                const d = entry.type == "plain" ? entry.data : new Uint8Array(decodeBinary(entry.data));
                let path = entry.path.substring(baseDir.length);
                if (path.startsWith("/")) {
                    path = path.substring(1);
                }
                if (path.startsWith("i:")) {
                    path = path.substring(2);
                }
                if (entry.deleted || entry._deleted) {
                    this.sendLog(`${path} delete detected`);
                    await this.dispatchDeleted(path);
                } else {
                    const docData = { ctime: entry.ctime, mtime: entry.mtime, size: entry.size, deleted: entry.deleted || entry._deleted, data: d };
                    this.sendLog(`${path} change detected`);
                    await this.dispatch(path, docData);
                }
            }, (entry) => {
                this.setSetting("since", this.man.since);
                if (entry.path.indexOf(":") !== -1) {
                    if (this.config.includeInternal && entry.path.startsWith("i:")) {
                        const stripped = entry.path.substring(2);
                        return this.config.includeInternal.some(pattern => minimatch(stripped, pattern, { dot: true }));
                    }
                    return false;
                }
                return entry.path.startsWith(baseDir);
            });
        }
    }
    async dispatch(path: string, data: FileData | false) {
        if (data === false) return;
        if (!await this.isRepeating(path, data)) {
            await this.dispatchToHub(this, this.toGlobalPath(path), data);
        }
        // else {
        //     this.receiveLog(`${path} dispatch repeating`);
        // }
    }
    async dispatchDeleted(path: string) {
        if (!await this.isRepeating(path, false)) {
            await this.dispatchToHub(this, this.toGlobalPath(path), false);
        }
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

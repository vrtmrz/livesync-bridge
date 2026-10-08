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
import {
    createBinaryBlob,
    createTextBlob,
    getDocData,
    isDocContentSame,
    unique,
} from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { minimatch } from "minimatch";
import { promiseWithResolver } from "octagonal-wheels/promises";
import { LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";

type ManipulatorMetaEntry = Parameters<DirectFileManipulator["getByMeta"]>[0];
type ManipulatorReadyEntry = Awaited<ReturnType<DirectFileManipulator["getByMeta"]>>;

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
        // CouchDB is reachable. Building it here would start its one-shot init
        // against a possibly-down CouchDB, then discard and rebuild it on the
        // first successful connection.
    }
    // (Re)create the underlying DirectFileManipulator. Its constructor starts a
    // one-shot async database initialisation. Recovering from a failed attempt
    // requires a fresh manipulator because its `ready` promise remains settled.
    private _buildManipulator(): void {
        // Release the previous instance if we're rebuilding. Each retry that gets
        // past the probe but fails to connect (CouchDB reachable but e.g. a config
        // error) rebuilds; without this the old manipulator's local DB handle would
        // leak. Best-effort and fire-and-forget — it may be mid-init, and we don't
        // want to block the connect path (or fail it) on teardown.
        const prev = this.man as DirectFileManipulator | undefined;
        this.man = new DirectFileManipulator(this.config, {
            // Bypass node:http compatibility shims for Deno, Traefik, and long-polling connections.
            // _changes requests additionally get an idle-timeout: a silently dead TCP
            // connection (suspend/VPN flap) otherwise stalls the live feed forever with
            // `watching` still true — invisible to health checks. Aborting on idle turns
            // that into a normal feed error, which the watch's own 10s reconnect handles.
            fetch: (request, init) => this._fetchWithIdleTimeout(request, init),
        });
        // Resume from the persisted checkpoint. If there is none, leave "now" as a
        // marker; _connectAndWatch resolves it to the current update_seq (and persists
        // it) before the watch starts, so later restarts never skip missed changes.
        this.man.since = this.getSetting("since") || "now";
        if (prev) void prev.close().catch(() => {});
    }

    // How long the _changes feed may go without a single byte before we consider the
    // connection dead. PouchDB requests heartbeat newlines every ~10s, so a healthy
    // but idle feed still produces traffic well within this window.
    private static readonly CHANGES_IDLE_TIMEOUT_MS = 90_000;
    private _fetchWithIdleTimeout(request: Request | URL | string, init?: RequestInit): Promise<Response> {
        const url = typeof request === "string" ? request : (request instanceof URL ? request.href : request.url);
        if (!url.includes("/_changes")) return globalThis.fetch(request, init);
        const ctrl = new AbortController();
        const outerSignal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
        if (outerSignal) {
            if (outerSignal.aborted) ctrl.abort(outerSignal.reason);
            else outerSignal.addEventListener("abort", () => ctrl.abort(outerSignal.reason), { once: true });
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                this.normalLog(`_changes feed idle for ${PeerCouchDB.CHANGES_IDLE_TIMEOUT_MS / 1000}s — aborting dead connection.`, LOG_LEVEL_NOTICE);
                ctrl.abort(new Error("changes feed idle timeout"));
            }, PeerCouchDB.CHANGES_IDLE_TIMEOUT_MS);
        };
        arm();
        return globalThis.fetch(request, { ...init, signal: ctrl.signal }).then((res) => {
            if (!res.body) {
                clearTimeout(timer);
                return res;
            }
            arm();
            const monitored = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    arm();
                    controller.enqueue(chunk);
                },
                flush() {
                    clearTimeout(timer);
                },
            }));
            return new Response(monitored, { status: res.status, statusText: res.statusText, headers: res.headers });
        }, (e) => {
            clearTimeout(timer);
            throw e;
        });
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
        const info = {
            ctime: data.ctime,
            mtime: data.mtime,
            size: data.size
        };
        const saveData = (data.data instanceof Uint8Array) ? createBinaryBlob(data.data) : createTextBlob(data.data);
        const old = await this.man.get(path as FilePathWithPrefix, true) as false | ManipulatorMetaEntry;
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
        await this._started.promise;
        const path = this.toLocalPath(pathSrc) as FilePathWithPrefix;
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
    private async _probeCouch(timeoutMs = 10000): Promise<Record<string, unknown>> {
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
        // The db info doc — callers use update_seq to seed the watch checkpoint.
        return await res.json() as Record<string, unknown>;
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
            }
            // No persisted checkpoint ("now" is only the placeholder from
            // _buildManipulator): pin the watch to the current update_seq and persist
            // it. From here on the checkpoint advances with every processed change, so
            // a restart resumes exactly where the previous run stopped instead of
            // silently skipping everything that arrived in between.
            if (this.man.since === "now") {
                const info = await this._probeCouch();
                this.man.since = `${info["update_seq"] ?? ""}`;
                this.setSetting("since", this.man.since);
            }
            this.normalLog(`Watch starting from ${this.man.since || "the first"}`);
            this.man.beginWatch(async (entry, seq) => {
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
                // Advance the checkpoint only after the change has been dispatched —
                // at-least-once: a crash in between replays this seq, and the content
                // dedup (isRepeating / Skipped-Same) absorbs the repeat. This also keeps
                // the watch's own reconnect (which re-reads man.since) gap-free.
                if (seq !== undefined) {
                    this.man.since = seq as string;
                    this.setSetting("since", `${seq}`);
                }
            }, (entry) => {
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

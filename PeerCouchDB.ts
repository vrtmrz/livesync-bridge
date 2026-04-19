import { DirectFileManipulator, FileInfo, MetaEntry, ReadyEntry } from "./lib/src/API/DirectFileManipulatorV2.ts";
import { FilePathWithPrefix, LOG_LEVEL_NOTICE, MILESTONE_DOCID, TweakValues } from "./lib/src/common/types.ts";
import { PeerCouchDBConf, FileData } from "./types.ts";
import { decodeBinary } from "./lib/src/string_and_binary/convert.ts";
import { isPlainText } from "./lib/src/string_and_binary/path.ts";
import { DispatchFun, Peer } from "./Peer.ts";
import { createBinaryBlob, createTextBlob, isDocContentSame, unique } from "./lib/src/common/utils.ts";

// export class PeerInstance()

export class PeerCouchDB extends Peer {
    man: DirectFileManipulator;
    declare config: PeerCouchDBConf;
    private _pollTimer: ReturnType<typeof setTimeout> | undefined;
    private _polling = false;
    private _pollIntervalMs: number;
    private _pollTimeoutMs: number;
    private _useShortPolling: boolean;

    constructor(conf: PeerCouchDBConf, dispatcher: DispatchFun) {
        super(conf, dispatcher);
        this.man = new DirectFileManipulator(conf);
        // Fetch remote since.
        this.man.since = this.getSetting("since") || "now";
        // Short-polling config (opt-in for Cloudflare Tunnel / reverse proxy environments)
        this._useShortPolling = conf.useShortPolling ?? false;
        this._pollIntervalMs = conf.pollIntervalMs ?? 5000;
        this._pollTimeoutMs = conf.pollTimeoutMs ?? 50000;
    }
    async delete(pathSrc: string): Promise<boolean> {
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
    async start(): Promise<void> {
        const baseDir = this.toLocalPath("");
        await this.man.ready.promise;
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

        if (this._useShortPolling) {
            this.normalLog(`Starting short-poll mode (interval=${this._pollIntervalMs}ms, timeout=${this._pollTimeoutMs}ms)`);
            this._startPolling(baseDir);
        } else {
            this.man.beginWatch(async (entry) => {
                const d = entry.type == "plain" ? entry.data : new Uint8Array(decodeBinary(entry.data));
                let path = entry.path.substring(baseDir.length);
                if (path.startsWith("/")) {
                    path = path.substring(1);
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
                if (entry.path.indexOf(":") !== -1) return false;
                return entry.path.startsWith(baseDir);
            });
        }
    }

    private _startPolling(baseDir: string) {
        this._polling = true;
        const changesUrl = `${this.config.url}/${this.config.database}/_changes`;
        const authHeader = "Basic " + btoa(`${this.config.username}:${this.config.password}`);

        const poll = async () => {
            if (!this._polling) return;
            try {
                const since = this.man.since || "0";
                const params = new URLSearchParams({
                    since: since,
                    feed: "normal",
                    include_docs: "true",
                    filter: "_selector",
                });
                const body = JSON.stringify({ selector: { type: { "$ne": "leaf" } } });

                const controller = new AbortController();
                const fetchTimeout = setTimeout(() => controller.abort(), this._pollTimeoutMs + 10000);

                const resp = await fetch(`${changesUrl}?${params}`, {
                    method: "POST",
                    headers: {
                        "Authorization": authHeader,
                        "Content-Type": "application/json",
                    },
                    body: body,
                    signal: controller.signal,
                });
                clearTimeout(fetchTimeout);

                if (!resp.ok) {
                    const errBody = await resp.text().catch(() => "");
                    this.normalLog(`Poll HTTP ${resp.status}: ${errBody.substring(0, 200)}`);
                    if (this._polling) {
                        this._pollTimer = setTimeout(poll, this._pollIntervalMs);
                    }
                    return;
                }

                const data = await resp.json();
                const results = data.results || [];

                for (const change of results) {
                    if (!this._polling) break;
                    const doc = change.doc;
                    if (!doc) continue;
                    // Skip leaf chunks
                    if (doc.type === "leaf") continue;
                    // Skip non-note entries (no path field)
                    if (!doc.path) continue;
                    // Check if path is in our base dir
                    if (doc.path.indexOf(":") !== -1) continue;
                    const fullPath = doc.path as string;
                    if (baseDir && !fullPath.startsWith(baseDir)) continue;

                    let path = fullPath.substring(baseDir.length);
                    if (path.startsWith("/")) {
                        path = path.substring(1);
                    }

                    if (doc.deleted || doc._deleted || change.deleted) {
                        this.sendLog(`${path} delete detected`);
                        await this.dispatchDeleted(path);
                    } else {
                        // Fetch full doc content via DirectFileManipulator
                        try {
                            // Retry with delay — chunks may arrive after the doc metadata
                            let entry: ReadyEntry | false = false;
                            for (let attempt = 0; attempt < 3; attempt++) {
                                entry = await this.man.getByMeta(doc) as ReadyEntry;
                                if (entry && entry.size > 0) break;
                                if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
                            }
                            if (entry) {
                                const d = entry.type == "plain" ? entry.data : new Uint8Array(decodeBinary(entry.data));
                                const docData = { ctime: entry.ctime, mtime: entry.mtime, size: entry.size, deleted: entry.deleted || entry._deleted, data: d };
                                this.sendLog(`${path} change detected`);
                                await this.dispatch(path, docData);
                            }
                        } catch (ex) {
                            this.normalLog(`Poll: failed to process ${path}: ${ex}`);
                        }
                    }
                }

                // Update since checkpoint
                if (data.last_seq) {
                    this.man.since = data.last_seq;
                    this.setSetting("since", this.man.since);
                }

            } catch (err) {
                if (err instanceof DOMException && err.name === "AbortError") {
                    this.normalLog(`Poll: request aborted (timeout) — will retry`);
                } else {
                    this.normalLog(`Poll error: ${err}`);
                }
            }

            // Schedule next poll
            if (this._polling) {
                this._pollTimer = setTimeout(poll, this._pollIntervalMs);
            }
        };

        poll();
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
        this._polling = false;
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = undefined;
        }
        this.man.endWatch();
        return await Promise.resolve();
    }
}

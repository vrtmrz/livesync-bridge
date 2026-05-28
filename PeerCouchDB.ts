import { dirname } from "@std/path";
import { DirectFileManipulator, FileInfo, MetaEntry, ReadyEntry } from "./lib/src/API/DirectFileManipulatorV2.ts";
import { FilePathWithPrefix, IDPrefixes, LOG_LEVEL_NOTICE, MILESTONE_DOCID, TweakValues } from "./lib/src/common/types.ts";
import { PeerCouchDBConf, FileData } from "./types.ts";
import { decodeBinary } from "./lib/src/string_and_binary/convert.ts";
import { isPlainText } from "./lib/src/string_and_binary/path.ts";
import { DispatchFun, Peer } from "./Peer.ts";
import { createBinaryBlob, createTextBlob, isDocContentSame, unique } from "./lib/src/common/utils.ts";

// export class PeerInstance()

export class PeerCouchDB extends Peer {
    man: DirectFileManipulator;
    declare config: PeerCouchDBConf;
    // File-based mirror of the bridge's per-peer state. localStorage is the
    // legacy backing store but it lives under /deno-dir/ in the container and
    // doesn't survive Docker restarts; the user's compose file mounts /app/dat
    // (where config.json lives) as a named volume but not /deno-dir. So we
    // shadow the two checkpoints that matter for resume-correctness — `since`
    // (where to pick up the changes feed) and `remote-created` (the DB
    // generation marker that gates the "fetch from the first again" reset) —
    // into a small JSON file next to config.json. Other state (file-stat-*
    // for storage; transient caches) is fine to lose on restart.
    private persistedState: { since?: string; "remote-created"?: string } = {};

    constructor(conf: PeerCouchDBConf, dispatcher: DispatchFun) {
        super(conf, dispatcher);
        this.man = new DirectFileManipulator(conf);
        this.persistedState = this.readStateSync();
        // Resolution order for `since`:
        //   1. file (survives Docker restarts)
        //   2. localStorage (legacy, in-container)
        //   3. "now"
        this.man.since = this.persistedState.since ?? this.tryGetSetting("since") ?? "now";
    }

    private get stateFile(): string {
        const configFile = Deno.env.get("LSB_CONFIG") || "./dat/config.json";
        const safeName = this.config.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        return `${dirname(configFile)}/state-${safeName}.json`;
    }

    private readStateSync(): { since?: string; "remote-created"?: string } {
        try {
            return JSON.parse(Deno.readTextFileSync(this.stateFile));
        } catch (ex) {
            if (!(ex instanceof Deno.errors.NotFound)) {
                console.error(`[${this.config.name}] failed to read ${this.stateFile}:`, ex);
            }
            return {};
        }
    }

    // Wraps localStorage access so a broken/wiped backing store can't crash
    // start() before we even reach beginWatch.
    private tryGetSetting(key: string): string | undefined {
        try {
            return this.getSetting(key) ?? undefined;
        } catch (ex) {
            console.error(`[${this.config.name}] localStorage read failed for ${key}:`, ex);
            return undefined;
        }
    }
    private trySetSetting(key: string, value: string): void {
        try {
            this.setSetting(key, value);
        } catch (ex) {
            console.error(`[${this.config.name}] localStorage write failed for ${key}:`, ex);
        }
    }

    // Trailing-edge debounce so a burst of changes doesn't translate to a burst
    // of writes to the volume-mounted state file. Last value within the window
    // wins, which is what we want for a monotonically advancing checkpoint.
    private pendingStateWrite?: ReturnType<typeof setTimeout>;
    private persistStateDebounced(): void {
        if (this.pendingStateWrite !== undefined) return;
        this.pendingStateWrite = setTimeout(async () => {
            this.pendingStateWrite = undefined;
            const snapshot = JSON.stringify(this.persistedState);
            try {
                await Deno.writeTextFile(this.stateFile, snapshot);
            } catch (ex) {
                console.error(`[${this.config.name}] failed to write ${this.stateFile}:`, ex);
            }
        }, 500);
    }
    private persistState<K extends keyof typeof this.persistedState>(key: K, value: string): void {
        this.persistedState[key] = value;
        this.persistStateDebounced();
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
            this.trySetSetting("remote-created", "0");
            this.persistState("remote-created", "0");
            return;
        }
        const created = w.created;
        // Check the persisted-state mirror FIRST. localStorage may have been
        // wiped by a container restart even when the remote DB hasn't actually
        // been rebuilt — relying on it alone would force a "fetch from the
        // first again" reset on every container restart and undo the since
        // checkpoint we just loaded from the state file.
        const knownCreated = this.persistedState["remote-created"] ?? this.tryGetSetting("remote-created");
        if (knownCreated !== `${created}`) {
            this.man.since = "";
            this.normalLog(`Remote database looks like rebuilt. fetch from the first again.`);
            this.trySetSetting("remote-created", `${created}`);
            this.persistState("remote-created", `${created}`);
        } else {
            this.normalLog(`Watch starting from ${this.man.since}`);
        }
        this.man.beginWatch(async (entry, seq) => {
            // Defensive: catch chunk/_id decoupling before it lands on disk or
            // gets pushed elsewhere. Symptom we're guarding against: doc A's
            // change event arrives, but the chunk responses fetched to
            // materialize its body were cross-wired (e.g. by the node-fetch
            // AsyncWrap bug under burst) and contain doc B's content. The
            // bridge would then write B's bytes into /vault/A and, on the
            // round-trip, push A's metadata pointing at chunks whose hash no
            // longer matches their ID. Recomputing the chunk hashes catches
            // this — non-matching means "drop and let the next change retry."
            if (!entry.deleted && !entry._deleted) {
                if (!await this.verifyChunkIntegrity(entry)) {
                    this.normalLog(
                        ` Dropping change for ${entry.path} (_id=${entry._id.substring(0, 8)}): chunk integrity check failed. Will resume on next change.`,
                        LOG_LEVEL_NOTICE,
                    );
                    return;
                }
            }
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
            // Advance the resume point AFTER successful processing. If the watch
            // disconnects and reconnects (the .on("error") path retries via
            // setTimeout), beginWatch reads this.since again — without this
            // update it would replay from the initial value forever. We also
            // persist to a file in dat/ because localStorage lives under
            // /deno-dir/ in the container and is wiped on Docker restart.
            if (seq !== undefined) {
                this.man.since = `${seq}`;
                this.trySetSetting("since", this.man.since);
                this.persistState("since", this.man.since);
            }
        }, (entry) => {
            if (entry.path.indexOf(":") !== -1) return false;
            return entry.path.startsWith(baseDir);
        });
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
        this.man.endWatch();
        return await Promise.resolve();
    }

    /**
     * Recompute each chunk's hash and confirm it matches the ID in `entry.children`.
     * Chunk IDs are `${IDPrefixes.Chunk}${hashManager.computeHash(piece)}`, and
     * hashManager.computeHash already prefixes the encryption marker when
     * encryption is enabled — so the same equation works for both modes.
     *
     * Returns true if integrity is OK (or unverifiable for a benign reason).
     * Returns false ONLY when a concrete mismatch is detected.
     */
    private async verifyChunkIntegrity(entry: ReadyEntry): Promise<boolean> {
        const hashManager = this.man.liveSyncLocalDB?.managers?.hashManager;
        if (!hashManager) return true;
        const children = entry.children ?? [];
        const data = entry.data ?? [];
        // Inline notes (legacy) have empty children and a single concatenated
        // body; nothing to verify against per-chunk.
        if (children.length === 0) return true;
        if (children.length !== data.length) {
            this.normalLog(
                ` Chunk integrity: children/data length mismatch (${children.length} vs ${data.length}) for ${entry.path}`,
                LOG_LEVEL_NOTICE,
            );
            return false;
        }
        for (let i = 0; i < children.length; i++) {
            const expected = children[i];
            const piece = data[i];
            if (typeof piece !== "string") continue;
            const hash = await hashManager.computeHash(piece);
            const actual = `${IDPrefixes.Chunk}${hash}`;
            if (actual !== expected) {
                this.normalLog(
                    ` Chunk integrity: hash mismatch at index ${i} for ${entry.path}: expected ${expected}, computed ${actual}`,
                    LOG_LEVEL_NOTICE,
                );
                return false;
            }
        }
        return true;
    }
}

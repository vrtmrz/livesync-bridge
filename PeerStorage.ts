import { PeerStorageConf, FileData } from "./types.ts";
import { delay, getDocData } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { isPlainText } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/path";
import { parse, format, relative, dirname, resolve, SEPARATOR, isAbsolute } from "@std/path";
import { format as posixFormat, parse as posixParse } from "@std/path/posix";
import { scheduleOnceIfDuplicated } from "octagonal-wheels/concurrency/lock";
import { DispatchFun, Peer, PeerHealth } from "./Peer.ts";
import chokidar from "chokidar";
import { minimatch } from "minimatch";

import { scheduleTask } from "octagonal-wheels/concurrency/task";
import {
    Logger,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
} from "octagonal-wheels/common/logger";

// Ignore patterns are matched with minimatch, the same matcher the CouchDB peer uses
// for `includeInternal`. `dot` is needed because the directories which are worth
// ignoring at all are usually dot-directories, such as `.git`.
const IGNORE_MATCH_OPTIONS = { dot: true } as const;

export class PeerStorage extends Peer {
    declare config: PeerStorageConf;
    // The platform's path separator; a field so tests can simulate Windows on any OS.
    pathSeparator: string = SEPARATOR;
    // Obsidian's Vault supplies per-file delete events when a folder is removed, and
    // Self-hosted LiveSync ignores folder events. Deno.watchFs may report only the
    // removed parent, so retain file paths to emulate the missing child events.
    // The children cannot be enumerated from disk after their folder has gone.
    private knownFiles = new Set<string>();
    private readyDenoWatcher?: Deno.FsWatcher;


    constructor(conf: PeerStorageConf, dispatcher: DispatchFun) {
        super(conf, dispatcher);
    }

    private ignorePatterns?: string[];

    // The configured patterns, plus the bare directory form of every `dir/**` pattern.
    // `**/.git/**` matches everything inside `.git` but not `.git` itself, and the
    // directory itself is exactly what has to be recognised to stay out of the tree.
    // As a consequence a trailing `/**` also covers the entry with that name.
    private getIgnorePatterns(): string[] {
        if (!this.ignorePatterns) {
            const configured = this.config.ignore ?? [];
            const directories = configured
                .filter((pattern) => pattern.endsWith("/**"))
                .map((pattern) => pattern.slice(0, -"/**".length));
            this.ignorePatterns = [...configured, ...directories];
        }
        return this.ignorePatterns;
    }

    // Whether a peer-relative POSIX path is excluded from synchronisation.
    // A path is also excluded when any of its ancestor directories is: the scans
    // prune an ignored directory, so live events for its descendants have to be
    // dropped as well, even when a pattern such as `private` or `*.tmp` only
    // matches the directory itself.
    isIgnored(path: string): boolean {
        if (!path) return false;
        const patterns = this.getIgnorePatterns();
        if (patterns.length === 0) return false;
        const segments = path.split("/");
        for (let depth = 1; depth <= segments.length; depth++) {
            const candidate = segments.slice(0, depth).join("/");
            if (patterns.some((pattern) => minimatch(candidate, pattern, IGNORE_MATCH_OPTIONS))) {
                return true;
            }
        }
        return false;
    }

    // Peer-relative POSIX path of an absolute path as the watchers report it.
    toRelativePath(pathSrc: string) {
        return this.toPosixPath(relative(this.toStoragePath(this.toLocalPath(".")), pathSrc));
    }

    async delete(pathSrc: string): Promise<boolean> {
        if (this.isUnsafeVaultPath(pathSrc)) {
            this.normalLog(`Delete skipped: ${pathSrc} (the path contains the local path separator)`, LOG_LEVEL_NOTICE);
            return false;
        }
        const lp = this.toLocalPath(pathSrc);
        const path = this.toStoragePath(lp);
        // Keyed by the vault path, like dispatchDeleted(), so the resulting watcher event is a repeat.
        if (await this.isRepeating(pathSrc, false)) {
            return false;
        }
        try {
            await Deno.remove(path);
            this.receiveLog(` ${path} deleted`);
        } catch (ex) {
            this.receiveLog(` ${path} delete failed`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
        this.knownFiles.delete(path);
        this.runScript(path, true);
        return true;
    }
    async put(pathSrc: string, data: FileData): Promise<boolean> {
        if (this.isUnsafeVaultPath(pathSrc)) {
            this.normalLog(`Write skipped: ${pathSrc} (the path contains the local path separator)`, LOG_LEVEL_NOTICE);
            return false;
        }
        const lp = this.toLocalPath(pathSrc);
        const path = this.toStoragePath(lp);
        try {
            const incoming = data.data instanceof Uint8Array
                ? data.data
                : new TextEncoder().encode(getDocData(data.data));
            // Preserve existing content when an empty payload conflicts with its reported size.
            // Check before recording repeats so a later valid empty update can still be saved.
            if (incoming.byteLength === 0 && data.size > 0) {
                let existingSize = -1;
                try {
                    existingSize = (await Deno.stat(path)).size;
                } catch (_e) {
                    existingSize = -1;
                }
                if (existingSize > 0) {
                    this.normalLog(
                        `Empty write blocked: ${lp} (${existingSize} bytes on disk, ${data.size} bytes reported, 0 bytes received)`,
                        LOG_LEVEL_NOTICE,
                    );
                    return false;
                }
            }
            // Keyed by the vault path, like dispatch(), so the resulting watcher event is a repeat.
            if (await this.isRepeating(pathSrc, data)) {
                this.receiveLog(`${lp} save repeating`);
                return false;
            }
            const dirName = dirname(path);
            try {
                await Deno.mkdir(dirName, { recursive: true });
            } catch (ex) {
                // While recursive is true, mkdir will not raise the `AlreadyExist`.
                console.log(ex);
            }
            const fp = await Deno.open(path, { read: true, write: true, create: true });
            const writtensize = await fp.write(incoming);
            await fp.truncate(writtensize);
            await fp.utime(new Date(data.mtime), new Date(data.mtime));
            fp.close();
            this.receiveLog(`${lp} saved`);
            await this.writeFileStat(pathSrc);
            this.runScript(path, false);
            return true;
        } catch (ex) {
            Logger(ex, LOG_LEVEL_INFO);
            this.receiveLog(`${lp} save failed`);
            return false;
        }
    }

    async runScript(filename: string, isDeleted: boolean): Promise<boolean> {
        if (!this.config.processor) return false;
        if (!this.config.processor.cmd) return false;

        // const result = [];
        try {
            // const startDate = new Date();
            const cmd = this.config.processor.cmd;
            const mode = isDeleted ? "deleted" : "modified";
            const args = this.config.processor.args.map(e => {
                if (e == "$filename") return filename;
                if (e == "$mode") return mode;
                return e
            });
            // const dateStr = startDate.toLocaleString();
            const scriptLineMessage = `Script: called ${cmd} with args ${JSON.stringify(args)}`;
            this.normalLog(`Processor : ${scriptLineMessage}`)
            const command = new Deno.Command(
                cmd, {
                args: args,
                cwd: ".",
                env: {
                    filename: filename,
                    mode: mode
                }
            });
            // const start = performance.now();
            const { code, stdout, stderr } = await command.output();
            // const end = performance.now();
            const stdoutText = new TextDecoder().decode(stdout);
            const stderrText = new TextDecoder().decode(stderr);
            // result.push(`# Processor called: ${dateStr}\n`);
            // result.push(`command: \`${scriptLineMessage}\``);
            if (code === 0) {
                this.normalLog("Processor called: Performed successfully.")
                // result.push("Processor called: Performed successfully.")
                this.normalLog(stdoutText);
            } else {
                this.normalLog("Processor called: Performed but with some errors.")
                // result.push("Processor called: Performed but with some errors.")
                this.normalLog(stderrText, LOG_LEVEL_NOTICE);
            }
            // result.push(`\n- Spent ${Math.ceil(end - start) / 1000} ms`);
            // result.push("## --STDOUT--\n")
            // result.push("```\n" + stdoutText + "\n```");
            // result.push("## --STDERR--n")
            // result.push("```\n" + stderrText + "\n```");
            // const strResult = result.join("\n");
            return true;
        } catch (ex) {
            this.normalLog("Processor: Error on processing");;
            // this.normalLog(ex);
            this.normalLog(JSON.stringify(ex, null, 2));
            return false;
        }

    }

    async get(pathSrc: string): Promise<false | FileData> {
        const lp = this.toLocalPath(pathSrc);
        const path = this.toStoragePath(lp);
        const stat = await Deno.stat(path);
        if (!stat.isFile) {
            return false;
        }
        const ret: FileData = {
            ctime: stat.mtime?.getTime() ?? 0,
            mtime: stat.mtime?.getTime() ?? 0,
            size: stat.size,
            data: [],
        };
        if (isPlainText(path)) {
            ret.data = [await Deno.readTextFile(path)];
        } else {
            ret.data = await Deno.readFile(path);
        }
        return ret;
    }
    watcher?: chokidar.FSWatcher;

    private async closeChokidarWatcher(watcher?: chokidar.FSWatcher): Promise<void> {
        if (!watcher) return;
        try {
            await watcher.close();
        } catch (ex) {
            // Chokidar may already have closed the watcher after an error.
            Logger(ex, LOG_LEVEL_VERBOSE);
        }
    }

    dispatch(pathSrc: string): Promise<void> {
        const lP = this.toStoragePath(this.toLocalPath("."));
        const path = this.toPosixPath(relative(lP, pathSrc));
        if (this.isOutsideBaseDir(path)) return Promise.resolve();

        if (this.isIgnored(path)) {
            this.debugLog(`${path} ignored`);
            return Promise.resolve();
        }

        scheduleOnceIfDuplicated(pathSrc, async () => {
            let data: FileData | false;
            try {
                await delay(250);
                // Read after waiting so a completed incoming update or deletion
                // supersedes the earlier watcher event's content.
                data = await this.get(path);
                if (data !== false) await this.writeFileStat(path);
            } catch (ex) {
                if (!(ex instanceof Deno.errors.NotFound)) {
                    this.normalLog(`File read failed: ${path}`, LOG_LEVEL_NOTICE);
                    Logger(ex, LOG_LEVEL_VERBOSE);
                }
                return;
            }
            if (data === false) return;
            if (!await this.isRepeating(path, data)) {
                this.sendLog(`${path} change detected`);
                await this.dispatchToHub(this, this.toGlobalPath(path), data);
            }
        });
        return Promise.resolve();
    }
    async dispatchDeleted(pathSrc: string) {
        const lP = this.toStoragePath(this.toLocalPath("."));
        const path = this.toPosixPath(relative(lP, pathSrc));
        if (this.isOutsideBaseDir(path)) return;
        if (this.isIgnored(path)) {
            this.debugLog(`${path} ignored`);
            return;
        }
        await scheduleOnceIfDuplicated(pathSrc, async () => {
            await delay(250);
            // A real or emulated deletion can become stale while it waits behind a write.
            if (!await this.isMissing(pathSrc)) return;
            if (!await this.isRepeating(path, false)) {
                this.sendLog(`${path} delete detected`);
                await this.dispatchToHub(this, this.toGlobalPath(path), false);
            }
            this.knownFiles.delete(resolve(pathSrc));
        });

    }

    // A change outside this peer's baseDir must never reach the hub: "../Other/note.md" would be
    // joined onto the other peers' baseDir and change a note outside their folder. Deno 2.6.9's
    // watchFs delivers remove events of one watcher to every other watcher in the process.
    isOutsideBaseDir(path: string) {
        // Backslashes are filename characters on POSIX and separators on Windows.
        const hasParentPrefix = path === ".." || path.startsWith("../") ||
            (SEPARATOR === "\\" && path.startsWith("..\\"));
        if (hasParentPrefix || isAbsolute(path)) {
            this.debugLog(`Ignored a change outside the base directory: ${path}`);
            return true;
        }
        return false;
    }
    // Vault paths always use "/". On Windows, posixFormat(parse()) only converts the separator
    // before the file name ("a\b\c.md" -> "a\b/c.md"), so convert every separator instead.
    toPosixPath(path: string) {
        const ret = this.pathSeparator === "/" ? posixFormat(parse(path)) : path.replaceAll(this.pathSeparator, "/");
        // this.debugLog(`**TOPOSIX ${path} -> ${ret}`)
        return ret;
    }
    // On Windows, a vault path containing "\" (a file name with a backslash, or "a\b/c.md"
    // as written by earlier versions) resolves to a different file: never write or delete it.
    isUnsafeVaultPath(path: string) {
        return this.pathSeparator !== "/" && path.includes(this.pathSeparator);
    }
    toStoragePath(path: string) {
        const ret = resolve(format(posixParse(path)));
        // this.debugLog(`**TOSTORAGE ${path} -> ${ret}`)
        return ret;
    }

    async writeFileStat(pathSrc: string, statSrc?: Deno.FileInfo) {
        const lp = this.toLocalPath(pathSrc);
        const key = `file-stat-${lp}`;
        const path = this.toStoragePath(lp);
        const stat = statSrc ?? await Deno.stat(path);
        if (!stat.isFile) {
            return false;
        }
        if (!this.config.useChokidar) this.knownFiles.add(path);
        const fileStat = `${stat.mtime?.getTime() ?? 0}-${stat.size}`;
        this.setSetting(key, fileStat);
    }

    async isChanged(pathSrc: string) {
        const lp = this.toLocalPath(pathSrc);
        const key = `file-stat-${lp}`;
        const last = this.getSetting(key);
        // console.log(`R:${key}`);
        // console.log(`RV:${last}`);

        const path = this.toStoragePath(lp);
        const stat = await Deno.stat(path);
        if (!stat.isFile) {
            return false;
        }
        if (!last) return true;
        const fileStat = `${stat.mtime?.getTime() ?? 0}-${stat.size}`;
        // console.log(`RVX:${fileStat}`);
        if (last !== fileStat) return true;
        return false;
    }
    watcherDeno?: Deno.FsWatcher;

    private async isMissing(path: string): Promise<boolean> {
        try {
            await Deno.stat(path);
            return false;
        } catch (ex) {
            if (ex instanceof Deno.errors.NotFound) return true;
            // Permission and I/O errors do not establish that the file has gone.
            this.normalLog(`Deletion verification failed: ${path}`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    processFile(event: Deno.FsEvent) {
        for (const eventPath of event.paths) {
            const path = resolve(eventPath);
            const relativePath = this.toRelativePath(path);
            if (this.isOutsideBaseDir(relativePath)) continue;
            // Filter before scheduling the task, which stats the path.
            if (this.isIgnored(relativePath)) {
                this.debugLog(`${relativePath} ignored`);
                continue;
            }
            const key = `${event.kind}-${path}`;
            scheduleTask(key, 100, async () => {
                let existence: Deno.FileInfo | undefined;
                try {
                    existence = await Deno.stat(path);
                } catch (ex) {
                    if (!(ex instanceof Deno.errors.NotFound)) {
                        this.normalLog(`Deletion verification failed: ${path}`, LOG_LEVEL_NOTICE);
                        Logger(ex, LOG_LEVEL_VERBOSE);
                        return;
                    }
                }
                if (existence?.isFile) {
                    await this.dispatch(path);
                } else if (!existence || (existence.isDirectory && event.kind === "remove")) {
                    // Emulate only file deletions: the parent path is a watcher hint, not
                    // a document to delete. A recreated parent can still have missing children.
                    const prefix = path.endsWith(SEPARATOR) ? path : `${path}${SEPARATOR}`;
                    const candidates = [...this.knownFiles].filter((file) => file === path || file.startsWith(prefix));
                    await Promise.all(candidates.map((file) => this.dispatchDeleted(file)));
                }
            });
        }
    }

    // Prune ignored trees before inventorying or inspecting their contents, even
    // when offline uploads are disabled and only the deletion inventory is needed.
    private async *listFiles(directory: string, prefix = ""): AsyncGenerator<string> {
        try {
            for await (const entry of Deno.readDir(directory)) {
                const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (this.isIgnored(relativePath)) {
                    this.debugLog(`${relativePath} ignored`);
                    continue;
                }
                const path = resolve(directory, entry.name);
                if (entry.isFile) yield path;
                else if (entry.isDirectory) yield* this.listFiles(path, relativePath);
            }
        } catch (ex) {
            // A directory can disappear while the inventory is being read. Continue
            // with its siblings; queued watcher events reconcile any known children.
            if (!(ex instanceof Deno.errors.NotFound)) throw ex;
        }
    }

    async startDenoFsWatch(): Promise<void> {
        if (this.watcherDeno) {
            const watcher = this.watcherDeno;
            this.watcherDeno = undefined;
            try {
                watcher.close();
            } catch (ex) {
                // Closing a watcher more than once is harmless for its lifecycle.
                Logger(ex, LOG_LEVEL_VERBOSE);
            }
        }
        const lP = this.toStoragePath(this.toLocalPath("."));
        const watcher = Deno.watchFs(lP, { recursive: true });
        this.watcherDeno = watcher;

        try {
            this.normalLog(`Scan offline changes: ${this.config.scanOfflineChanges ? "Enabled, now starting..." : "Disabled"}`);
            // Watch before taking the inventory so removals during the scan are queued.
            // Even with offline syncing disabled, remember existing files without sending
            // their contents. Unchanged files must also be known for later parent removals.
            for await (const path of this.listFiles(lP)) {
                if (this.watcherDeno !== watcher) return;
                this.knownFiles.add(path);
                if (this.config.scanOfflineChanges) {
                    const ePath = this.toPosixPath(relative(lP, path));
                    try {
                        if (await this.isChanged(ePath)) {
                            this.debugLog(`Offline changes detected: ${ePath}`);
                            await this.dispatch(path);
                        }
                    } catch (ex) {
                        if (!(ex instanceof Deno.errors.NotFound)) throw ex;
                    }
                }
            }
            if (this.watcherDeno !== watcher) return;
            this.readyDenoWatcher = watcher;
            for await (const event of watcher) {
                this.processFile(event);
            }
        } finally {
            if (this.readyDenoWatcher === watcher) this.readyDenoWatcher = undefined;
            if (this.watcherDeno === watcher) {
                this.watcherDeno = undefined;
            }
            try {
                watcher.close();
            } catch (ex) {
                // The watcher can already be closed by stop() or a concurrent start().
                Logger(ex, LOG_LEVEL_VERBOSE);
            }
        }

    }
    async start() {
        // For addressing Deno's and chokidar's compatibility issues (especially on Windows), we use Deno's fs watcher as the primary watcher.
        if (!this.config.useChokidar) {
            await this.startDenoFsWatch();
            return;
        }

        if (this.watcher) {
            const watcher = this.watcher;
            this.watcher = undefined;
            await this.closeChokidarWatcher(watcher);
        }
        const lP = this.toStoragePath(this.toLocalPath("."));
        this.normalLog(`Scan offline changes: ${this.config.scanOfflineChanges ? "Enabled, now starting..." : "Disabled"}`);
        const watcher = chokidar.watch(lP,
            {
                ignoreInitial: !this.config.scanOfflineChanges,
                // Prunes ignored directories from the watch itself, so their contents
                // are never stat()ed or watched. dispatch() filters as well, for the
                // events which chokidar reports before this can apply.
                ignored: (path: string) => this.isIgnored(this.toRelativePath(path)),
                awaitWriteFinish: {
                    stabilityThreshold: 500,
                },
            });
        this.watcher = watcher;

        watcher.on("error", (ex) => {
            if (this.watcher !== watcher) return;
            this.watcher = undefined;
            Logger(ex, LOG_LEVEL_NOTICE);
            void this.closeChokidarWatcher(watcher);
        });
        watcher.on("change", async (path) => {
            const ePath = this.toPosixPath(relative(this.toLocalPath("."), path));
            if (this.isIgnored(ePath)) {
                this.debugLog(`${ePath} ignored`);
                return;
            }
            if (!await this.isChanged(ePath)) {
                // this.debugLog(`Not changed: ${ePath}`);
            } else {
                this.debugLog(`Changes detected: ${ePath}`);
                await this.dispatch(path);
            }
        })
        watcher.on("add", async (path) => {
            const ePath = this.toPosixPath(relative(this.toLocalPath("."), path));
            if (this.isIgnored(ePath)) {
                this.debugLog(`${ePath} ignored`);
                return;
            }
            if (!await this.isChanged(ePath)) {
                // this.debugLog(`Not changed: ${ePath}`);
            } else {
                this.debugLog(`New detected: ${ePath}`);
                await this.dispatch(path);
            }
        })
        watcher.on("unlink", async (path) => {
            const ePath = this.toPosixPath(relative(this.toLocalPath("."), path));
            if (this.isIgnored(ePath)) {
                this.debugLog(`${ePath} ignored`);
                return;
            }
            // Confirm that the path is absent before propagating a deletion.
            // Permission and I/O errors do not establish that the file is gone.
            try {
                await Deno.stat(path);
                this.debugLog(`Unlink ignored, file still exists: ${ePath}`);
                return;
            } catch (ex) {
                if (!(ex instanceof Deno.errors.NotFound)) {
                    this.normalLog(`Unlink verification failed: ${ePath}`, LOG_LEVEL_NOTICE);
                    Logger(ex, LOG_LEVEL_VERBOSE);
                    return;
                }
            }
            this.debugLog(`Unlink detected: ${ePath}`);
            await this.dispatchDeleted(path)
        })
    }
    async stop() {
        const watcher = this.watcher;
        this.watcher = undefined;
        const watcherDeno = this.watcherDeno;
        this.watcherDeno = undefined;
        this.readyDenoWatcher = undefined;
        if (watcherDeno) {
            try {
                watcherDeno.close();
            } catch (ex) {
                // The Deno iterator cleanup can close the watcher a second time.
                Logger(ex, LOG_LEVEL_VERBOSE);
            }
        }
        await this.closeChokidarWatcher(watcher);
    }
    override health(): PeerHealth {
        const ok = !!(this.watcher || (this.watcherDeno && this.readyDenoWatcher === this.watcherDeno));
        // No remote backend (backendUp always true). A storage peer still doing its
        // initial offline scan is "starting", not yet healthy, so the base restart
        // logic won't flag it — only a watcher that dies after being healthy counts.
        return { name: this.config.name, type: "storage", ok, detail: ok ? "watching" : "starting", backendUp: true, restartWorthy: false };
    }
}

import { PeerStorageConf, FileData } from "./types.ts";
import { delay, getDocData } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { isPlainText } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/path";
import { parse, format, relative, dirname, resolve, SEPARATOR, isAbsolute } from "@std/path";
import { format as posixFormat, parse as posixParse } from "@std/path/posix";
import { serialized } from "octagonal-wheels/concurrency/lock";
import { DispatchFun, FileChangeContext, Peer, PeerHealth } from "./Peer.ts";
import chokidar from "chokidar";
import { minimatch } from "minimatch";

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
    private stopped = false;
    private generation = 0;
    private closing?: Promise<void>;
    private pendingEvents = new Map<string, Deno.FsEvent>();
    private pendingTasks = new Map<string, { next?: () => Promise<void>; promise: Promise<void> }>();

    private queueTask(key: string, lock: string, action: () => Promise<void>): Promise<void> {
        const previous = this.pendingTasks.get(key);
        if (previous) {
            previous.next = action;
            return previous.promise;
        }
        const pending = { next: action as (() => Promise<void>) | undefined, promise: Promise.resolve() };
        this.pendingTasks.set(key, pending);
        pending.promise = serialized(lock, async () => {
            const failures: unknown[] = [];
            while (pending.next) {
                const next = pending.next;
                pending.next = undefined;
                try {
                    await next();
                } catch (ex) {
                    failures.push(ex);
                }
            }
            if (failures.length) throw new AggregateError(failures, `File change failed: ${key}`);
        }).finally(() => { this.pendingTasks.delete(key); });
        // Watcher callbacks have no caller to receive rejection. Keep failures visible
        // without acknowledging their contents or losing the drainable promise.
        void pending.promise.catch(ex => {
            this.normalLog(`File change failed: ${key}`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
        });
        return pending.promise;
    }

    private async drain(): Promise<void> {
        while (this.pendingTasks.size) {
            await Promise.allSettled([...this.pendingTasks.values()].map(task => task.promise));
        }
    }


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
        return await this.applyChange(pathSrc, false, async () => {
            try {
                await Deno.remove(path);
            } catch (ex) {
                if (ex instanceof Deno.errors.NotFound) return false;
                this.receiveLog(` ${path} delete failed`, LOG_LEVEL_NOTICE);
                throw ex;
            }
            this.receiveLog(` ${path} deleted`);
            this.knownFiles.delete(path);
            void this.runScript(path, true);
            return true;
        });
    }
    override async rename(previousPath: string, path: string, data: FileData): Promise<boolean> {
        if (this.isUnsafeVaultPath(previousPath) || this.isUnsafeVaultPath(path)) return false;
        const saved = await this.put(path, data);
        if (!saved) return false;
        try {
            const previous = await Deno.realPath(this.toStoragePath(this.toLocalPath(previousPath)));
            const current = await Deno.realPath(this.toStoragePath(this.toLocalPath(path)));
            if (previous === current) return saved;
        } catch (ex) {
            if (!(ex instanceof Deno.errors.NotFound)) throw ex;
        }
        if (previousPath !== path) await this.delete(previousPath);
        return saved;
    }
    override async deleteFrom(path: string, source: Peer): Promise<boolean> {
        const current = await source.currentPaths(path);
        if (current.includes(path)) return false;
        for (const candidate of current) {
            try {
                const oldPath = await Deno.realPath(this.toStoragePath(this.toLocalPath(path)));
                const newPath = await Deno.realPath(this.toStoragePath(this.toLocalPath(candidate)));
                if (oldPath === newPath) return false;
            } catch (ex) {
                if (!(ex instanceof Deno.errors.NotFound)) throw ex;
            }
        }
        return await this.delete(path);
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
            return await this.applyChange(pathSrc, data, async () => {
                await Deno.mkdir(dirname(path), { recursive: true });
                const fp = await Deno.open(path, { read: true, write: true, create: true });
                try {
                    let offset = 0;
                    while (offset < incoming.byteLength) offset += await fp.write(incoming.subarray(offset));
                    await fp.truncate(offset);
                    await fp.utime(new Date(data.mtime), new Date(data.mtime));
                } finally {
                    fp.close();
                }
                this.receiveLog(`${lp} saved`);
                await this.writeFileStat(pathSrc);
                void this.runScript(path, false);
                return true;
            });
        } catch (ex) {
            Logger(ex, LOG_LEVEL_INFO);
            this.receiveLog(`${lp} save failed`);
            throw ex;
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
        if (!this.stopped) void this.queueDispatch(pathSrc);
        return Promise.resolve();
    }
    private queueDispatch(pathSrc: string, context?: FileChangeContext): Promise<void> {
        const path = this.toRelativePath(pathSrc);
        if (this.isOutsideBaseDir(path) || this.isIgnored(path)) return Promise.resolve();
        return this.queueTask(pathSrc, pathSrc, async () => {
            await delay(250);
            let data: FileData | false;
            try {
                data = await this.get(path);
            } catch (ex) {
                if (!(ex instanceof Deno.errors.NotFound)) {
                    this.normalLog(`File read failed: ${path}`, LOG_LEVEL_NOTICE);
                    Logger(ex, LOG_LEVEL_VERBOSE);
                }
                if (context?.previousPath !== undefined) throw ex;
                return;
            }
            if (!data) {
                if (context?.previousPath !== undefined) throw new Error(`Rename target is no longer a file: ${path}`);
                return;
            }
            this.knownFiles.add(resolve(pathSrc));
            await this.applyChange(path, data, async () => {
                this.sendLog(`${path} change detected`);
                await this.dispatchToHub(this, path, data, context);
                this.setSetting(`file-stat-${this.toLocalPath(path)}`, `${data.mtime}-${data.size}`);
                return true;
            }, { force: context?.previousPath !== undefined, suppressPendingEcho: true });
        });
    }
    async dispatchDeleted(pathSrc: string) {
        if (this.stopped) return;
        await this.queueDeletion(pathSrc);
    }
    private queueDeletion(pathSrc: string): Promise<void> {
        const path = this.toRelativePath(pathSrc);
        if (this.isOutsideBaseDir(path) || this.isIgnored(path)) return Promise.resolve();
        return this.queueTask(pathSrc, pathSrc, async () => {
            await delay(250);
            if (!await this.isMissing(pathSrc)) return;
            await this.applyChange(path, false, async () => {
                this.sendLog(`${path} delete detected`);
                await this.dispatchToHub(this, path, false);
                return true;
            }, { suppressPendingEcho: true });
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
            return !(await this.currentPaths(this.toRelativePath(path))).includes(this.toRelativePath(path));
        } catch (ex) {
            if (ex instanceof Deno.errors.NotFound) return true;
            // Permission and I/O errors do not establish that the file has gone.
            this.normalLog(`Deletion verification failed: ${path}`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    // Match directory entries to recover their actual spelling on case-insensitive
    // filesystems. Folding discovers candidates; the destination decides document identity.
    private async currentEntries(path: string, includeAliases = false): Promise<string[]> {
        if (this.isOutsideBaseDir(path) || this.isUnsafeVaultPath(path)) return [];
        let parents = [this.toStoragePath(this.toLocalPath("."))];
        for (const segment of path.split("/").filter(Boolean)) {
            const next: string[] = [];
            for (const parent of parents) {
                try {
                    const matches: string[] = [];
                    for await (const entry of Deno.readDir(parent)) {
                        if (!entry.isSymlink && entry.name.toLowerCase() === segment.toLowerCase()) matches.push(entry.name);
                    }
                    const selected = !includeAliases && matches.includes(segment) ? [segment] : matches;
                    for (const name of selected) {
                        const candidate = resolve(parent, name);
                        if (this.isIgnored(this.toRelativePath(candidate))) {
                            throw new Error(`Path inspection blocked by an ignored directory: ${candidate}`);
                        }
                        next.push(candidate);
                    }
                } catch (ex) {
                    if (!(ex instanceof Deno.errors.NotFound) && !(ex instanceof Deno.errors.NotADirectory)) throw ex;
                }
            }
            parents = next;
        }
        return parents;
    }
    override async currentPaths(path: string): Promise<string[]> {
        const files: string[] = [];
        for (const candidate of await this.currentEntries(path, true)) {
            try {
                if ((await Deno.lstat(candidate)).isFile) {
                    const current = this.toRelativePath(candidate);
                    if (this.isIgnored(current)) throw new Error(`Deletion verification blocked by an ignored path: ${current}`);
                    files.push(current);
                }
            } catch (ex) {
                if (!(ex instanceof Deno.errors.NotFound)) throw ex;
            }
        }
        return files;
    }
    processFile(event: Deno.FsEvent) {
        if (this.stopped) return;
        const paths = [...new Set(event.paths.map(path => resolve(path)))].filter(path => {
            const relative = this.toRelativePath(path);
            return !this.isOutsideBaseDir(relative) && !this.isIgnored(relative);
        });
        if (!paths.length) return;
        const key = `${event.kind}:${paths.join("\0")}`;
        this.pendingEvents.set(key, { ...event, paths });
        void this.queueTask("watcher-events", `${this.operationKey}:scan`, async () => {
            await delay(100);
            const events = [...this.pendingEvents.values()];
            this.pendingEvents.clear();
            // A paired event establishes a relation. Process it before accompanying
            // remove hints, without inferring a relation between separate events.
            const paired = (event: Deno.FsEvent) => event.kind === "rename" && event.paths.length === 2;
            events.sort((a, b) => Number(paired(b)) - Number(paired(a)));
            const failures: unknown[] = [];
            const blocked: string[] = [];
            const contains = (parent: string, path: string) => path === parent || path.startsWith(`${parent}${SEPARATOR}`);
            for (const accepted of events) {
                if (accepted.paths.some(path => blocked.some(parent => contains(parent, path) || contains(path, parent)))) continue;
                try {
                    await this.reconcileEvent(accepted);
                } catch (ex) {
                    this.normalLog(`Watcher reconciliation failed: ${accepted.paths.join(", ")}`, LOG_LEVEL_NOTICE);
                    failures.push(ex);
                    // Preserve a failed rename's source while continuing unrelated work.
                    if (paired(accepted)) blocked.push(...accepted.paths);
                }
            }
            if (failures.length) throw new AggregateError(failures, "Watcher reconciliation failed");
        });
    }
    private async reconcileEvent(event: Deno.FsEvent): Promise<void> {
        const entries = new Map<string, string[]>();
        for (const path of event.paths) {
            try {
                await Deno.stat(path);
            } catch (ex) {
                if (!(ex instanceof Deno.errors.NotFound)) throw ex;
            }
            entries.set(path, await this.currentEntries(this.toRelativePath(path)));
        }
        const oldPath = event.kind === "rename" && event.paths.length === 2
            ? event.paths.find(path => !entries.get(path)!.includes(path)) : undefined;
        const newPath = oldPath ? event.paths.find(path => path !== oldPath && entries.get(path)!.includes(path)) : undefined;
        if (oldPath && newPath) {
            await this.reconcilePath(newPath, oldPath);
            await this.reconcilePath(oldPath, undefined, false);
        } else {
            for (const path of event.paths) await this.reconcilePath(path, undefined, event.kind !== "remove");
        }
    }
    private async reconcilePath(path: string, previousPath?: string, emitChanges = true): Promise<void> {
        const currentFiles = new Set<string>();
        for (const current of emitChanges ? await this.currentEntries(this.toRelativePath(path)) : []) {
            const relativePath = this.toRelativePath(current);
            if (this.isIgnored(relativePath)) continue;
            let stat: Deno.FileInfo;
            try {
                stat = await Deno.lstat(current);
            } catch (ex) {
                if (ex instanceof Deno.errors.NotFound) continue;
                throw ex;
            }
            const files = stat.isFile ? [current] : stat.isDirectory ? this.listFiles(current, relativePath) : [];
            const saves: Promise<void>[] = [];
            for await (const file of files) {
                currentFiles.add(file);
                this.knownFiles.add(file);
                const oldFile = previousPath ? resolve(previousPath, relative(current, file)) : undefined;
                const context = oldFile && this.knownFiles.has(oldFile)
                    ? { previousPath: this.toRelativePath(oldFile) } : undefined;
                saves.push(this.queueDispatch(file, context));
            }
            await Promise.all(saves);
        }
        const prefix = path.endsWith(SEPARATOR) ? path : `${path}${SEPARATOR}`;
        const removed = [...this.knownFiles].filter(file =>
            (file === path || file.startsWith(prefix)) && !currentFiles.has(file));
        await Promise.all(removed.map(file => this.queueDeletion(file)));
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
        const generation = ++this.generation;
        if (this.watcherDeno || this.watcher || this.pendingTasks.size || this.closing) await this.closeAndDrain();
        if (this.generation !== generation) return;
        this.stopped = false;
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
                if (this.watcherDeno !== watcher) break;
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

        const generation = ++this.generation;
        if (this.watcher || this.watcherDeno || this.pendingTasks.size || this.closing) await this.closeAndDrain();
        if (this.generation !== generation) return;
        this.stopped = false;
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
        this.generation++;
        await this.closeAndDrain();
    }
    private closeAndDrain(): Promise<void> {
        if (!this.closing) {
            this.closing = this.closeWatchers().finally(() => { this.closing = undefined; });
        }
        return this.closing;
    }
    private async closeWatchers(): Promise<void> {
        this.stopped = true;
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
        await this.drain();
    }
    override health(): PeerHealth {
        const ok = !!(this.watcher || (this.watcherDeno && this.readyDenoWatcher === this.watcherDeno));
        // No remote backend (backendUp always true). A storage peer still doing its
        // initial offline scan is "starting", not yet healthy, so the base restart
        // logic won't flag it — only a watcher that dies after being healthy counts.
        return { name: this.config.name, type: "storage", ok, detail: ok ? "watching" : "starting", backendUp: true, restartWorthy: false };
    }
}

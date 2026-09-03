import { PeerStorageConf, FileData } from "./types.ts";
import { delay, getDocData } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { isPlainText } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/path";
import { parse, format, relative, dirname, resolve, join } from "@std/path";
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
    isIgnored(path: string): boolean {
        if (!path) return false;
        return this.getIgnorePatterns().some((pattern) => minimatch(path, pattern, IGNORE_MATCH_OPTIONS));
    }

    // Peer-relative POSIX path of an absolute path as the watchers report it.
    toRelativePath(pathSrc: string) {
        return this.toPosixPath(relative(this.toStoragePath(this.toLocalPath(".")), pathSrc));
    }

    async delete(pathSrc: string): Promise<boolean> {
        const lp = this.toLocalPath(pathSrc);
        const path = this.toStoragePath(lp);
        if (await this.isRepeating(lp, false)) {
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
        this.runScript(path, true);
        return true;
    }
    async put(pathSrc: string, data: FileData): Promise<boolean> {
        const lp = this.toLocalPath(pathSrc);
        const path = this.toStoragePath(lp);
        if (await this.isRepeating(lp, data)) {
            this.receiveLog(`${lp} save repeating`);
            return false;
        }
        try {
            const dirName = dirname(path);
            try {
                await Deno.mkdir(dirName, { recursive: true });
            } catch (ex) {
                // While recursive is true, mkdir will not raise the `AlreadyExist`.
                console.log(ex);
            }
            const fp = await Deno.open(path, { read: true, write: true, create: true });
            if (data.data instanceof Uint8Array) {
                const writtensize = await fp.write(data.data);
                await fp.truncate(writtensize);
            } else {
                const writtensize = await fp.write(new TextEncoder().encode(getDocData(data.data)));
                await fp.truncate(writtensize);
            }
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

    async dispatch(pathSrc: string) {
        const lP = this.toStoragePath(this.toLocalPath("."));
        const path = this.toPosixPath(relative(lP, pathSrc));

        if (this.isIgnored(path)) {
            this.debugLog(`${path} ignored`);
            return;
        }

        const data = await this.get(path);

        if (data === false) return;

        scheduleOnceIfDuplicated(pathSrc, async () => {
            // console.log(data);
            await this.writeFileStat(path);
            await delay(250);
            if (!await this.isRepeating(path, data)) {
                this.sendLog(`${path} change detected`);
                await this.dispatchToHub(this, this.toGlobalPath(path), data);
            }
            // else {
            //     this.sendLog(`${path} change repeating detected`);
            // }
        });
    }
    async dispatchDeleted(pathSrc: string) {
        const lP = this.toStoragePath(this.toLocalPath("."));
        const path = this.toPosixPath(relative(lP, pathSrc));
        if (this.isIgnored(path)) {
            this.debugLog(`${path} ignored`);
            return;
        }
        await scheduleOnceIfDuplicated(pathSrc, async () => {
            await delay(250);
            if (!await this.isRepeating(path, false)) {
                this.sendLog(`${path} delete detected`);
                await this.dispatchToHub(this, this.toGlobalPath(path), false);
            }
        });

    }

    toPosixPath(path: string) {
        const ret = posixFormat(parse(path));
        // this.debugLog(`**TOPOSIX ${path} -> ${ret}`)
        return ret;
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

    processFile(event: Deno.FsEvent) {
        for (const path of event.paths) {
            // Filtered before the task is scheduled: the task stats the path, and an
            // ignored path should not be stat()ed at all.
            const relativePath = this.toRelativePath(path);
            if (this.isIgnored(relativePath)) {
                this.debugLog(`${relativePath} ignored`);
                continue;
            }
            const key = `${event.kind}-${path}`;
            // const key = path;
            scheduleTask(key, 100, async () => {
                const existence = await Deno.stat(path).catch(() => null);
                if (existence) {
                    if (existence.isFile) {
                        await this.dispatch(path);
                    }
                } else {
                    await this.dispatchDeleted(path);
                }
            });
        }
    }



    // Yields the files below `root` which are not ignored, without ever entering an
    // ignored directory. The pruning has to happen here rather than at dispatch time:
    // stat(), isChanged() and the file reads which follow are what makes scanning a
    // large ignored tree such as `.git` slow, so such a tree is never descended into.
    private async *walkFiles(root: string, prefix = ""): AsyncGenerator<{ path: string, relativePath: string }> {
        for await (const entry of Deno.readDir(root)) {
            const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
            const path = join(root, entry.name);
            if (this.isIgnored(relativePath)) {
                this.debugLog(`${relativePath} ignored`);
                continue;
            }
            if (entry.isDirectory) {
                yield* this.walkFiles(path, relativePath);
            } else if (entry.isFile) {
                yield { path, relativePath };
            }
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
        this.normalLog(`Scan offline changes: ${this.config.scanOfflineChanges ? "Enabled, now starting..." : "Disabled"}`);
        if (this.config.scanOfflineChanges) {
            for await (const entry of this.walkFiles(lP)) {
                if (await this.isChanged(entry.relativePath)) {
                    this.debugLog(`Offline changes detected: ${entry.relativePath}`);
                    await this.dispatch(entry.path);
                }
            }
        }
        const watcher = Deno.watchFs(lP,
            {
                recursive: true,
            });
        this.watcherDeno = watcher;

        try {
            for await (const event of watcher) {
                this.processFile(event);
            }
        } finally {
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
            this.debugLog(`Unlink detected: ${ePath}`);
            await this.dispatchDeleted(path)
        })
    }
    async stop() {
        const watcher = this.watcher;
        this.watcher = undefined;
        const watcherDeno = this.watcherDeno;
        this.watcherDeno = undefined;
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
        const ok = !!(this.watcherDeno || this.watcher);
        // No remote backend (backendUp always true). A storage peer still doing its
        // initial offline scan is "starting", not yet healthy, so the base restart
        // logic won't flag it — only a watcher that dies after being healthy counts.
        return { name: this.config.name, type: "storage", ok, detail: ok ? "watching" : "starting", backendUp: true, restartWorthy: false };
    }
}

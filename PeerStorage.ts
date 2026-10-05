import { PeerStorageConf, FileData } from "./types.ts";
import { delay, getDocData } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { isPlainText } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/path";
import { parse, format, relative, dirname, resolve, isAbsolute, SEPARATOR } from "@std/path";
import { format as posixFormat, parse as posixParse } from "@std/path/posix";
import { scheduleOnceIfDuplicated } from "octagonal-wheels/concurrency/lock";
import { DispatchFun, Peer, PeerHealth } from "./Peer.ts";
import chokidar from "chokidar";
import { walk } from "fs/walk";

import { scheduleTask } from "octagonal-wheels/concurrency/task";
import {
    Logger,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
} from "octagonal-wheels/common/logger";

export class PeerStorage extends Peer {
    declare config: PeerStorageConf;


    constructor(conf: PeerStorageConf, dispatcher: DispatchFun) {
        super(conf, dispatcher);
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
            if (await this.isRepeating(lp, data)) {
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

    async dispatch(pathSrc: string) {
        const lP = this.toStoragePath(this.toLocalPath("."));
        const path = this.toPosixPath(relative(lP, pathSrc));
        if (this.isOutsideBaseDir(path)) return;

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
        if (this.isOutsideBaseDir(path)) return;
        await scheduleOnceIfDuplicated(pathSrc, async () => {
            await delay(250);
            if (!await this.isRepeating(path, false)) {
                this.sendLog(`${path} delete detected`);
                await this.dispatchToHub(this, this.toGlobalPath(path), false);
            }
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
            for await (const entry of walk(lP)) {
                if (entry.isFile) {
                    const ePath = this.toPosixPath(relative(this.toLocalPath("."), entry.path));
                    if (await this.isChanged(ePath)) {
                        this.debugLog(`Offline changes detected: ${ePath}`);
                        await this.dispatch(entry.path);
                    }
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
            if (!await this.isChanged(ePath)) {
                // this.debugLog(`Not changed: ${ePath}`);
            } else {
                this.debugLog(`Changes detected: ${ePath}`);
                await this.dispatch(path);
            }
        })
        watcher.on("add", async (path) => {
            const ePath = this.toPosixPath(relative(this.toLocalPath("."), path));
            if (!await this.isChanged(ePath)) {
                // this.debugLog(`Not changed: ${ePath}`);
            } else {
                this.debugLog(`New detected: ${ePath}`);
                await this.dispatch(path);
            }
        })
        watcher.on("unlink", async (path) => {
            const ePath = this.toPosixPath(relative(this.toLocalPath("."), path));
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

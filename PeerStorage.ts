import { dirname, resolve } from "https://deno.land/std@0.203.0/path/mod.ts";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "./lib/src/common/types.ts";
import { PeerStorageConf, FileData } from "./types.ts";
import { Logger } from "./lib/src/common/logger.ts";
import { delay, getDocData } from "./lib/src/common/utils.ts";
import { isPlainText } from "./lib/src/string_and_binary/path.ts";
import { posixParse } from "https://deno.land/std@0.203.0/path/_parse.ts";
import { relative } from "https://deno.land/std@0.203.0/path/relative.ts";
import { format } from "https://deno.land/std@0.203.0/path/format.ts";
import { parse } from "https://deno.land/std@0.203.0/path/parse.ts";
import { posixFormat } from "https://deno.land/std@0.203.0/path/_format.ts";
import { scheduleOnceIfDuplicated } from "./lib/src/concurrency/lock.ts";
import { DispatchFun, Peer } from "./Peer.ts";
import chokidar from "chokidar";
import { walk } from 'fs/walk.ts';

import { scheduleTask } from "./lib/src/concurrency/task.ts";

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
            this.normalLog(ex);
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

    async dispatch(pathSrc: string) {
        const lP = this.toStoragePath(this.toLocalPath("."));
        const path = this.toPosixPath(relative(lP, pathSrc));

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
        scheduleOnceIfDuplicated(pathSrc, async () => {
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
            this.watcherDeno.close();
            this.watcherDeno = undefined;
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
        this.watcherDeno = Deno.watchFs(lP,
            {
                recursive: true,
            });

        for await (const event of this.watcherDeno) {
            this.processFile(event);
        }

    }
    async start() {
        // For addressing Deno's and chokidar's compatibility issues (especially on Windows), we use Deno's fs watcher as the primary watcher.
        if (!this.config.useChokidar) {
            await this.startDenoFsWatch();
            return;
        }

        if (this.watcher) {
            this.watcher.close();
            this.watcher = undefined;
        }
        const lP = this.toStoragePath(this.toLocalPath("."));
        this.normalLog(`Scan offline changes: ${this.config.scanOfflineChanges ? "Enabled, now starting..." : "Disabled"}`);
        this.watcher = chokidar.watch(lP,
            {
                ignoreInitial: !this.config.scanOfflineChanges,
                awaitWriteFinish: {
                    stabilityThreshold: 500,
                },
            });

        this.watcher.on("change", async (path) => {
            const ePath = this.toPosixPath(relative(this.toLocalPath("."), path));
            if (!await this.isChanged(ePath)) {
                // this.debugLog(`Not changed: ${ePath}`);
            } else {
                this.debugLog(`Changes detected: ${ePath}`);
                await this.dispatch(path);
            }
        })
        this.watcher.on("add", async (path) => {
            const ePath = this.toPosixPath(relative(this.toLocalPath("."), path));
            if (!await this.isChanged(ePath)) {
                // this.debugLog(`Not changed: ${ePath}`);
            } else {
                this.debugLog(`New detected: ${ePath}`);
                await this.dispatch(path);
            }
        })
        this.watcher.on("unlink", async (path) => {
            const ePath = this.toPosixPath(relative(this.toLocalPath("."), path));
            this.debugLog(`Unlink detected: ${ePath}`);
            this.dispatchDeleted(path)
        })
    }
    async stop() {
        this.watcher?.close();
        this.watcherDeno?.close();
        this.watcherDeno = undefined;
    }
}

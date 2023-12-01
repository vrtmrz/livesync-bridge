import { resolve } from "https://deno.land/std@0.203.0/path/mod.ts";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "./lib/src/types.ts";
import { PeerStorageConf, FileData } from "./types.ts";
import { Logger } from "./lib/src/logger.ts";
import { delay, getDocData } from "./lib/src/utils.ts";
import { isPlainText } from "./lib/src/path.ts";
import { posixParse } from "https://deno.land/std@0.203.0/path/_parse.ts";
import { relative } from "https://deno.land/std@0.203.0/path/relative.ts";
import { format } from "https://deno.land/std@0.203.0/path/format.ts";
import { parse } from "https://deno.land/std@0.203.0/path/parse.ts";
import { posixFormat } from "https://deno.land/std@0.203.0/path/_format.ts";
import { scheduleOnceIfDuplicated } from "./lib/src/lock.ts";
import { DispatchFun, Peer } from "./Peer.ts";



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
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
        this.receiveLog(` ${path} delete failed`, LOG_LEVEL_NOTICE);
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
            const fp = await Deno.open(path, { read: true, write: true, create: true });
            if (data.data instanceof Uint8Array) {
                await fp.write(data.data);
            } else {
                await fp.write(new TextEncoder().encode(getDocData(data.data)));
            }
            await Deno.futime(fp.rid, new Date(data.mtime), new Date(data.mtime));
            fp.close();
            this.receiveLog(`${lp} saved`);
            return true;
        } catch (ex) {
            Logger(ex, LOG_LEVEL_INFO);
            this.receiveLog(`${lp} save failed`);
            return false;
        }
    }
    async get(pathSrc: string): Promise<false | FileData> {
        const lp = this.toLocalPath(pathSrc);
        const path = this.toStoragePath(lp);
        const stat = await Deno.stat(path);
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
    watcher: Deno.FsWatcher | undefined;
    async dispatch(pathSrc: string) {
        const lP = this.toStoragePath(this.toLocalPath("."));
        const path = this.toPosixPath(relative(lP, pathSrc));

        const data = await this.get(path);

        if (data === false) return;

        scheduleOnceIfDuplicated(pathSrc, async () => {
            // console.log(data);
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

    async start(): Promise<void> {
        if (this.watcher) {
            this.watcher.close();
        }
        const lP = this.toStoragePath(this.toLocalPath("."));
        this.watcher = Deno.watchFs(lP, { recursive: true });
        for await (const event of this.watcher) {
            // Logger(`${event.kind} ${event.paths.join(",")}`);
            switch (event.kind) {
                case "create":
                    event.paths.forEach(e => this.dispatch(e));
                    break;
                case "modify":
                    event.paths.forEach(e => this.dispatch(e));
                    break;
                case "remove":
                    event.paths.forEach(e => this.dispatchDeleted(e));
                    break;

                case "any":
                case "access":
                case "other":
                default:

            }
        }
    }
    async stop() {
        this.watcher?.close();
    }
}

import { Config, FileData } from "./types.ts";
import { Peer, PeerHealth } from "./Peer.ts";
import { PeerStorage } from "./PeerStorage.ts";
import { PeerCouchDB } from "./PeerCouchDB.ts";


export class Hub {
    conf: Config;
    peers = [] as Peer[];
    constructor(conf: Config) {
        this.conf = conf;
    }
    // Aggregate peer health for the heartbeat. `ok` = every peer syncing (also
    // false if no peers were constructed). `restartWorthy` = any peer judges itself
    // restart-worthy (was healthy, now persistently failing while its backend is
    // up) — see Peer.probeHealth.
    async healthProbe(): Promise<{ ok: boolean; restartWorthy: boolean; peers: PeerHealth[] }> {
        const peers = await Promise.all(this.peers.map((p) => p.probeHealth()));
        const ok = peers.length > 0 && peers.every((p) => p.ok);
        const restartWorthy = peers.some((p) => p.restartWorthy);
        return { ok, restartWorthy, peers };
    }
    start() {
        for (const p of this.peers) {
            p.stop();
        }
        this.peers = [];
        for (const peer of this.conf.peers) {
            if (peer.type == "couchdb") {
                const p = new PeerCouchDB(peer, this.dispatch.bind(this));
                this.peers.push(p);
            } else if (peer.type == "storage") {
                const p = new PeerStorage(peer, this.dispatch.bind(this));
                this.peers.push(p);
            } else {
                throw new Error(`Unexpected Peer type: ${(peer as any)?.name} - ${(peer as any)?.type}`);
            }
        }
        // Initialize couchdb peers FIRST and await them, then start storage peers.
        // Otherwise a storage peer's offline scan can push to a couchdb peer before its
        // DB managers are initialized (initializeDatabase), causing
        // "Cannot read properties of undefined (reading 'getDBEntryMeta')".
        (async () => {
            for (const p of this.peers) {
                if (p.config.type === "couchdb") {
                    await p.start().catch((e) => {
                        console.error(`[Hub] peer "${p.config.name}" start() failed:`, e);
                    });
                }
            }
            for (const p of this.peers) {
                if (p.config.type !== "couchdb") {
                    p.start().catch((e) => {
                        console.error(`[Hub] peer "${p.config.name}" start() failed:`, e);
                    });
                }
            }
        })();
    }

    async dispatch(source: Peer, path: string, data: FileData | false) {
        for (const peer of this.peers) {
            if (peer !== source && (source.config.group ?? "") === (peer.config.group ?? "")) {
                let ret = false;
                if (data === false) {
                    ret = await peer.delete(path);
                } else {
                    ret = await peer.put(path, data);
                }
                if (ret) {
                    // Logger(`  ${data === false ? "-x->" : "--->"} ${peer.config.name} ${path} `)
                } else {
                    // Logger(`        ${peer.config.name} ignored ${path} `)
                }
            }
        }
    }
}

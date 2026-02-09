import { Config, FileData } from "./types.ts";
import { Peer } from "./Peer.ts";
import { PeerStorage } from "./PeerStorage.ts";
import { PeerCouchDB } from "./PeerCouchDB.ts";


export class Hub {
    conf: Config;
    peers = [] as Peer[];
    constructor(conf: Config) {
        this.conf = conf;
    }
    async start() {
        for (const p of this.peers) {
            p.stop();
        }
        this.peers = [];
        const couchdbPeers: Peer[] = [];
        const storagePeers: Peer[] = [];
        for (const peer of this.conf.peers) {
            if (peer.type == "couchdb") {
                const p = new PeerCouchDB(peer, this.dispatch.bind(this));
                this.peers.push(p);
                couchdbPeers.push(p);
            } else if (peer.type == "storage") {
                const p = new PeerStorage(peer, this.dispatch.bind(this));
                this.peers.push(p);
                storagePeers.push(p);
            } else {
                throw new Error(`Unexpected Peer type: ${(peer as any)?.name} - ${(peer as any)?.type}`);
            }
        }
        // Start CouchDB peers first and wait for them to be ready
        await Promise.all(couchdbPeers.map(p => p.start()));
        // Then start storage peers
        for (const p of storagePeers) {
            p.start();
        }
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


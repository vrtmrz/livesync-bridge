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
        for (const p of this.peers) {
            p.start();
        }
    }

    /**
     * Dispatches file changes from one peer to all other peers in the same group.
     * 
     * This is the central coordination point for synchronization.
     * 
     * Flow:
     * 1. A peer detects a change (via file watcher or database watcher)
     * 2. The peer calls this dispatch method via dispatchToHub
     * 3. Hub iterates through all peers in the same group
     * 4. For each peer (except the source):
     *    - If data is false (deletion), calls peer.delete()
     *    - Otherwise, calls peer.put() to write the file/document
     * 5. Each peer's put()/delete() method will:
     *    - Check isRepeating() to avoid redundant writes
     *    - Write to its storage if needed
     *    - Its own watcher will detect the write but skip re-dispatching (due to cache)
     * 
     * This design prevents infinite loops:
     * - Source peer is excluded from the dispatch
     * - Each peer's cache prevents re-dispatching its own writes
     * 
     * @param source - The peer that detected the change
     * @param path - File path (global format)
     * @param data - File data or false for deletion
     */
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


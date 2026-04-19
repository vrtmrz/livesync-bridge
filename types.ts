import type { DirectFileManipulatorOptions } from "./lib/src/API/DirectFileManipulator.ts";

export interface Config {
    peers: PeerConf[];
}
export type PeerConf = PeerStorageConf | PeerCouchDBConf;

export interface PeerStorageConf {
    scanOfflineChanges?: boolean;
    type: "storage";
    group?: string;
    name: string;
    baseDir: string;
    processor?: {
        cmd: string,
        args: string[]
    }
    useChokidar?: boolean;
}
export interface PeerCouchDBConf extends DirectFileManipulatorOptions {
    type: "couchdb";
    useRemoteTweaks?: true;
    group?: string;
    name: string;
    database: string;
    username: string;
    password: string;
    url: string;
    customChunkSize?: number;
    minimumChunkSize?: number;
    passphrase: string;
    obfuscatePassphrase: string;
    baseDir: string;
    /** Use short-polling instead of PouchDB's live changes feed.
     *  Enable this when CouchDB is accessed through Cloudflare Tunnel
     *  or a reverse proxy that kills long-lived HTTP connections. */
    useShortPolling?: boolean;
    /** Interval between poll requests in milliseconds (default: 5000). */
    pollIntervalMs?: number;
    /** HTTP timeout per poll request in milliseconds (default: 50000). */
    pollTimeoutMs?: number;
}



export function isCouchDBPeer(peer: PeerConf): peer is PeerCouchDBConf {
    return peer.type == "couchdb";
}

export function isStoragePeer(peer: PeerConf): peer is PeerStorageConf {
    return peer.type == "storage";
}

export type FileData = {
    ctime: number;
    mtime: number;
    size: number;
    data: string[] | Uint8Array<ArrayBuffer>;
    deleted?: boolean;
}
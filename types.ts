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
    };
    useChokidar?: boolean;
    /**
     * When enabled, normalizes file paths before cache lookups to prevent infinite loops
     * where a peer's own file write triggers another dispatch cycle.
     * Default: true (recommended)
     */
    useNormalizedCachePaths?: boolean;
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
    /**
     * When enabled, normalizes file paths before cache lookups to prevent infinite loops
     * where a peer's own document update triggers another dispatch cycle.
     * Default: true (recommended)
     */
    useNormalizedCachePaths?: boolean;
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
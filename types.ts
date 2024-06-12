import { DirectFileManipulatorOptions } from "./lib/src/DirectFileManipulator.ts";

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
    usePolling?: boolean;
    processor?: {
        cmd: string,
        args: string[]
    }
}
export interface PeerCouchDBConf extends DirectFileManipulatorOptions {
    type: "couchdb";
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
    data: string[] | Uint8Array
    deleted?: boolean;
}
